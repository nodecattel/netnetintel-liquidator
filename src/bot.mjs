// The liquidation loop. Every tick: read the market, its oracle and the loans close to the line in one batch, accrue
// interest to now, and if a loan is past the 62.5% line, size a bid with Morpho's own math, simulate it, and (when
// LIVE) send liquidate() from the owner's wallet. The only transactions this bot ever builds:
//   Morpho.liquidate on the Loopback market · USDG.approve(Morpho) · wsNET/USDG transfer to the owner's PAYOUT_ADDRESS
//   (or, from the withdraw command, the address the owner types).
import { getAddress, MaxUint256, AbiCoder, keccak256 } from 'ethers';
import { MORPHO, MARKET_ID, MARKET_FROM_BLOCK, MARKET_PARAMS, USDG, EXPLORER_TX } from './constants.mjs';
import { MORPHO_IFACE, ERC20, readParams, paramsTuple, readTick, scanBorrowers, simulate } from './chain.mjs';
import { accrue, positionView, planBid, fmtUsdg, fmtWs } from './math.mjs';

// Interest keeps accruing between the read and the block the bid lands in: bids are sized (and approvals set) on the
// debt as it will be HEADROOM_SEC from now, so the USDG Morpho pulls never exceeds what was planned or approved.
const HEADROOM_SEC = 60;
// Borrowers are scanned up to a few blocks behind the head, so a logs node that is a block or two behind can't make
// the cursor skip a Borrow it hasn't indexed yet.
const LOG_LAG = 5;
export const marketIdOf = (p) => keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'address', 'address', 'address', 'uint256'], [p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv]));
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const LIQ_TOPIC = MORPHO_IFACE.getEvent('Liquidate').topicHash;

// onEvent(ev): what happened, for Telegram and the local page — { kind: 'liquidated' | 'failed' | 'gas' | 'oracle' | 'approved', … }
export function makeBot({ rpc, logsRpc = rpc, sender: initialSender = null, cfg, store, log, notify = async () => {}, onEvent = () => {}, nowMs = () => Date.now() }) {
  let sender = initialSender, me = sender?.address ?? null;
  let paused = false;               // the owner's pause (local page or Telegram): keep watching, send nothing
  let params = null;
  const debts = new Map();          // borrower → debt (USDG units) at the last read
  let lastView = null, lastTickAt = null, lastError = null, lastReady = 0, started = false;
  const emit = (ev) => { try { onEvent({ at: nowMs(), ...ev }); } catch { /* a reporter never stops the loop */ } };
  const liveNow = () => !!(cfg.live && sender && !paused);
  const known = new Set(store.borrowers().map((a) => getAddress(a)));
  const health = new Map();          // borrower → last health (debt > 0 only)
  const cooldown = new Map();        // borrower → ms until which it is skipped
  const said = new Map();            // message key → last time, to keep the log quiet
  const fresh = new Set();           // borrowers found since the last full read: read on the next tick
  let cursor = store.cursor ?? MARKET_FROM_BLOCK - 1, rate = null, lastFull = 0, lastHead = null, pausedSince = null, lastSummary = 0, busy = false;

  const once = (key, everyMs, f) => { if (said.size > 2000) said.clear(); const t = said.get(key); if (t && nowMs() - t < everyMs) return; said.set(key, nowMs()); f(); };

  async function start() {
    if (marketIdOf(MARKET_PARAMS) !== MARKET_ID) throw new Error('the pinned market parameters do not hash to the Loopback market id');
    const onChain = await readParams(rpc);
    const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
    if (!same(onChain.loanToken, MARKET_PARAMS.loanToken) || !same(onChain.collateralToken, MARKET_PARAMS.collateralToken) || !same(onChain.oracle, MARKET_PARAMS.oracle)
      || !same(onChain.irm, MARKET_PARAMS.irm) || onChain.lltv !== MARKET_PARAMS.lltv)
      throw new Error('this RPC does not return the Loopback market as it is on Robinhood Chain: check RPC_URL');
    params = MARKET_PARAMS;   // from here on only the pinned parameters are used
    const head = parseInt(await logsRpc.one('eth_blockNumber', []), 16) - LOG_LAG;
    if (cursor < head) {
      const from = cursor + 1;
      log.info(`finding borrowers: blocks ${from.toLocaleString()} → ${head.toLocaleString()}${known.size ? ` (${known.size} known)` : ' (first run, a minute or two)'}`);
      const found = await scanBorrowers(logsRpc, from, head, { range: cfg.logRange, minRange: cfg.minLogRange });
      for (const a of found) known.add(a);
      cursor = head; store.setScan(cursor, known);
    }
    log.info(`${known.size} wallets have borrowed on Loopback`);
    started = true;
    return params;
  }

  // new borrowers since the last look: one eth_getLogs over the blocks since
  async function discover(readHead) {
    if (readHead == null) return;
    try {
      let head = readHead;
      if (logsRpc !== rpc) head = Math.min(head, parseInt(await logsRpc.one('eth_blockNumber', []), 16));
      head -= LOG_LAG;
      if (head <= cursor) return;
      const found = await scanBorrowers(logsRpc, cursor + 1, head, { range: Math.max(cfg.logRange, head - cursor), minRange: cfg.minLogRange });
      let added = 0;
      for (const a of found) { if (!known.has(a)) { known.add(a); added++; } fresh.add(a); }
      cursor = head;
      if (added) { store.setScan(cursor, known); log.info(`${added} new borrower${added > 1 ? 's' : ''}`); }
    } catch (e) { once('discover', 60_000, () => log.warn(`could not read new borrowers: ${e.message}`)); }
  }

  async function tick() {
    if (busy) return null;
    busy = true;
    try { const r = await tickInner(); lastError = null; return r; }
    catch (e) { lastError = e.message; throw e; }
    finally { busy = false; lastTickAt = nowMs(); store.heartbeat(); }
  }

  async function tickInner() {
    const now = nowMs();
    await discover(lastHead);
    const full = now - lastFull >= cfg.fullEverySeconds * 1000;
    const list = full ? [...known] : [...known].filter((a) => fresh.has(a) || (health.get(a) ?? Infinity) < cfg.hotHealth);
    // the rate moves slowly: re-read with every full pass (and until a read succeeds)
    const view = await readTick(rpc, params, me, list, { rate: full || rate == null ? null : rate });
    if (full || rate == null) rate = view.rate;
    if (view.rate == null) once('rate', 600_000, () => log.warn('the interest rate did not read: debts are figured without the interest since the market last moved'));
    if (full) lastFull = now;
    fresh.clear();
    lastHead = view.block?.number ?? lastHead;
    lastView = { block: view.block, wallet: view.wallet, price: view.price };

    if (view.price == null) {
      if (!pausedSince) { pausedSince = now; log.warn('the oracle is not giving a price (its guard holds while the pool sits more than 15% under the TWAP): no liquidations until it does'); notify('Loopback oracle paused: no liquidations until it gives a price again.'); emit({ kind: 'oracle', paused: true }); }
      return { paused: true };
    }
    if (pausedSince) { log.info('the oracle is giving a price again'); pausedSince = null; emit({ kind: 'oracle', paused: false }); }

    const nowSec = view.block?.timestamp ?? Math.floor(now / 1000);
    const m = accrue(view.market, view.rate ?? 0n, nowSec);                    // as Morpho sees it now: who is past the line
    const mPlan = accrue(view.market, view.rate ?? 0n, nowSec + HEADROOM_SEC); // as it may be when the bid lands: how much to repay
    const ready = [];
    for (const [b, pos] of view.positions) {
      if (pos.borrowShares === 0n) { health.delete(b); debts.delete(b); continue; }
      const v = positionView(pos, m, view.price, params.lltv);
      health.set(b, v.health); debts.set(b, v.debt);
      if (v.liquidatable) ready.push({ borrower: b, pos, view: v });
    }
    if (full) for (const b of known) if (!view.positions.has(b)) { health.delete(b); debts.delete(b); }
    lastReady = ready.length;

    const wallet = view.wallet;
    if (me && wallet && wallet.eth < cfg.gasFloorWei) once('gas', 3_600_000, () => { log.warn(`the wallet has ${(Number(wallet.eth) / 1e18).toFixed(6)} ETH for gas: top it up`); notify(`Liquidator wallet ${short(me)} is low on ETH for gas.`); emit({ kind: 'gas', eth: Number(wallet.eth) / 1e18 }); });
    summary(now, wallet, ready.length);
    const idle = async () => {
      if (liveNow()) try { await keepApproved(wallet); } catch (e) { once('approve', 600_000, () => log.warn(`could not set the USDG approval: ${e.shortMessage || e.message}`)); }
    };
    if (!ready.length) { await idle(); return { ready: 0 }; }

    const budgetOf = () => {
      if (!wallet) return cfg.maxRepay ?? 10n ** 15n;       // no wallet (scan mode): size bids as if funds were plenty
      let b = wallet.usdg - cfg.reserve;
      if (cfg.maxRepay != null && b > cfg.maxRepay) b = cfg.maxRepay;
      return b > 0n ? b : 0n;
    };
    const plans = ready.map((r) => ({ ...r, plan: planBid(r.pos, mPlan, view.price, params.lltv, budgetOf(), { allowPartial: cfg.allowPartial }) }))
      .sort((a, b) => Number((b.plan.profit ?? -1n) - (a.plan.profit ?? -1n)));

    const results = [];
    for (const t of plans) {
      if ((cooldown.get(t.borrower) ?? 0) > now) continue;
      if (t.plan.skip) { once(`skip:${t.borrower}`, 600_000, () => log.info(`${short(t.borrower)} is liquidatable (health ${t.view.health.toFixed(4)}, debt ${fmtUsdg(t.view.debt)} USDG) but skipped: ${t.plan.skip}`)); continue; }
      if (t.plan.profit < cfg.minProfit) { once(`small:${t.borrower}`, 600_000, () => log.info(`${short(t.borrower)}: a bid earns ${fmtUsdg(t.plan.profit)} USDG at the oracle, under MIN_PROFIT_USDG`)); continue; }
      results.push(await act(t, wallet));
      break;                                            // one liquidation per tick: balances change after it
    }
    if (!results.length) await idle();                  // nothing to bid on (or all skipped): keep the approval ready
    return { ready: ready.length, results };
  }

  async function act(t, wallet) {
    const { borrower, plan } = t;
    const data = MORPHO_IFACE.encodeFunctionData('liquidate', [paramsTuple(params), borrower, plan.args.seizedAssets, plan.args.repaidShares, '0x']);
    const what = `${plan.mode} bid on ${short(borrower)}: repay ${fmtUsdg(plan.repaid)} USDG, seize ${fmtWs(plan.seized)} wsNET (${fmtUsdg(plan.valueAtOracle)} USDG at the oracle, +${fmtUsdg(plan.profit)})`;
    const now = nowMs();

    if (!liveNow()) {
      const reason = await simulate(rpc, me ?? borrower, MORPHO, data);
      const verdict = reason == null ? 'the simulation passes'
        : /healthy/i.test(reason) ? `Morpho says the position is healthy (${reason})`
        : `Morpho accepts the bid; it then needs ${me ? 'USDG and the approval' : 'a funded wallet'} (${reason})`;
      once(`dry:${borrower}`, 300_000, () => { log.info(`[${paused ? 'paused' : 'dry run'}] ${what}: ${verdict}`); emit({ kind: 'dry', borrower, repaid: fmtUsdg(plan.repaid), profit: fmtUsdg(plan.profit), paused }); notify(`[dry run] Would liquidate: ${what}.`, { key: `dry:${borrower}`, everyMs: 3_600_000 }); });
      cooldown.set(borrower, now + 15_000);
      return { dry: true, borrower, plan, reason };
    }

    try {
      if (wallet.allowance == null || wallet.allowance < plan.repaid) await keepApproved(wallet, plan.repaid);
      const tx = { to: MORPHO, data };
      let gas;
      try { gas = await sender.estimateGas(tx); }
      catch (e) {
        const reason = e.shortMessage || e.reason || e.message;
        log.info(`${short(borrower)}: not sent, Morpho would refuse it now (${reason}); someone may have got there first`);
        cooldown.set(borrower, now + 10_000);
        once(`missed:${borrower}`, 600_000, () => emit({ kind: 'missed', borrower, reason: String(reason).slice(0, 120) }));
        return { sent: false, borrower, reason };
      }
      log.info(`sending ${what}`);
      const sent = await sender.send({ ...tx, gasLimit: (gas * 13n) / 10n });
      const rec = await sent.wait();
      if (!rec || rec.status !== 1) throw new Error(`the transaction reverted (${EXPLORER_TX}${sent.hash})`);
      const ev = rec.logs.find((l) => l.address?.toLowerCase() === MORPHO.toLowerCase() && l.topics?.[0] === LIQ_TOPIC);
      const d = ev ? MORPHO_IFACE.decodeEventLog('Liquidate', ev.data, ev.topics) : null;
      const repaid = d ? d.repaidAssets : plan.repaid, seized = d ? d.seizedAssets : plan.seized;
      const entry = { at: new Date().toISOString(), tx: sent.hash, borrower, repaid: fmtUsdg(repaid), seized: fmtWs(seized), badDebt: d ? fmtUsdg(d.badDebtAssets) : null, profitAtOracle: fmtUsdg((seized * t.plan.valueAtOracle) / (t.plan.seized || 1n) - repaid) };
      store.record(entry);
      emit({ kind: 'liquidated', ...entry });
      log.info(`liquidated ${short(borrower)}: repaid ${entry.repaid} USDG, seized ${entry.seized} wsNET · ${EXPLORER_TX}${sent.hash}`);
      await notify(`Liquidated ${short(borrower)} on Loopback: repaid ${entry.repaid} USDG, seized ${entry.seized} wsNET (≈ +${entry.profitAtOracle} USDG at the oracle).\n${EXPLORER_TX}${sent.hash}`);
      if (cfg.payout) await payout(seized);
      cooldown.set(borrower, now + 5_000);
      return { sent: true, borrower, tx: sent.hash, entry };
    } catch (e) {
      log.error(`${short(borrower)}: ${e.shortMessage || e.message}`);
      notify(`Liquidation attempt on ${short(borrower)} failed: ${e.shortMessage || e.message}`, { key: `fail:${borrower}`, everyMs: 600_000 });
      once(`failed:${borrower}`, 600_000, () => emit({ kind: 'failed', borrower, error: String(e.shortMessage || e.message).slice(0, 160) }));
      cooldown.set(borrower, now + 30_000);
      return { sent: false, borrower, error: e.message };
    }
  }

  // Morpho pulls the repaid USDG, so it needs an allowance: the wallet's spendable USDG (capped at MAX_REPAY_USDG), set
  // while idle so a bid doesn't wait on it. That much, never unlimited. An allowance that didn't read is left alone
  // while idle (no approval resent on a flaky read); before a bid it is set.
  async function keepApproved(wallet, need = null) {
    if (!wallet || (need == null && wallet.allowance == null)) return;
    let want = wallet.usdg - cfg.reserve;
    if (cfg.maxRepay != null && want > cfg.maxRepay) want = cfg.maxRepay;
    if (need != null && need > want) want = need;
    if (want <= 0n || (wallet.allowance != null && wallet.allowance >= want)) return;
    await approve(want, wallet);
  }
  async function approve(amount, wallet) {
    if (amount > MaxUint256) amount = MaxUint256;
    log.info(`approving Morpho to take up to ${fmtUsdg(amount)} USDG from the bot wallet`);
    const sent = await sender.send({ to: USDG, data: ERC20.encodeFunctionData('approve', [MORPHO, amount]) });
    const rec = await sent.wait();
    if (!rec || rec.status !== 1) throw new Error('the USDG approval failed');
    if (wallet) wallet.allowance = amount;
    emit({ kind: 'approved', usdg: fmtUsdg(amount), tx: sent.hash });
  }
  async function payout(amount) {
    try {
      const sent = await sender.send({ to: WSNET, data: ERC20.encodeFunctionData('transfer', [cfg.payout, amount]) });
      await sent.wait();
      log.info(`sent ${fmtWs(amount)} wsNET to ${cfg.payout}`);
    } catch (e) { log.warn(`the seized wsNET stays in the bot wallet: sending it to PAYOUT_ADDRESS failed (${e.shortMessage || e.message})`); }
  }

  function summary(now, wallet, ready) {
    if (now - lastSummary < 300_000) return;
    lastSummary = now;
    const close = [...health.entries()].sort((a, b) => a[1] - b[1]);
    const near = close[0] ? `closest ${short(close[0][0])} at ${close[0][1].toFixed(3)}× health` : 'no open loans';
    const w = wallet ? ` · wallet ${fmtUsdg(wallet.usdg)} USDG, ${fmtWs(wallet.wsnet)} wsNET, ${(Number(wallet.eth) / 1e18).toFixed(5)} ETH` : '';
    log.info(`watching ${health.size} open loans, ${close.filter(([, h]) => h < cfg.hotHealth).length} under ${cfg.hotHealth}× · ${near}${ready ? ` · ${ready} liquidatable` : ''}${w}`);
  }

  // what the local page and the Telegram status line show
  function status() {
    const w = lastView?.wallet;
    const closest = [...health.entries()].sort((a, b) => a[1] - b[1]).slice(0, 8)
      .map(([b, h]) => ({ borrower: b, health: Math.floor(h * 1e4) / 1e4, debt: Number(fmtUsdg(debts.get(b) ?? 0n)) }));   // floored: past the line never shows as 1.0000
    return {
      started, live: !!cfg.live, liveNow: liveNow(), paused, hasWallet: !!sender, address: me,
      block: lastView?.block?.number ?? null, lastTickAt, lastError, oraclePaused: !!pausedSince,
      known: known.size, open: health.size, hot: [...health.values()].filter((h) => h < cfg.hotHealth).length, ready: lastReady, closest,
      wallet: w ? { usdg: Number(fmtUsdg(w.usdg)), wsnet: Number(fmtWs(w.wsnet)), eth: Number(w.eth) / 1e18, allowance: w.allowance == null ? null : Number(fmtUsdg(w.allowance)) } : null,
    };
  }
  function setSender(s) { sender = s; me = s?.address ?? null; }
  function setPaused(p) { paused = !!p; }

  return { start, tick, keepApproved, status, setSender, setPaused, get busy() { return busy; }, get paused() { return paused; }, get known() { return known; }, get health() { return health; }, get params() { return params; } };
}

export async function runLoop(bot, cfg, log, { signal } = {}) {
  let errors = 0;
  while (!signal?.aborted) {
    const t0 = Date.now();
    try { await bot.tick(); errors = 0; }
    catch (e) { errors++; if (errors === 1 || errors % 30 === 0) log.warn(`tick failed (${errors} in a row): ${e.message}`); }
    const wait = Math.max(200, cfg.tickSeconds * 1000 * (errors > 3 ? 3 : 1) - (Date.now() - t0));
    await new Promise((r) => setTimeout(r, wait));
  }
}

export { MARKET_ID };
