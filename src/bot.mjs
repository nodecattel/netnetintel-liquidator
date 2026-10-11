// The liquidation loop. Every tick: read the market, its oracle and the loans close to the line in one batch, accrue
// interest to now, and if a loan is past the 62.5% line, size a bid with Morpho's own math, simulate it, and (when
// LIVE) send liquidate() from the owner's wallet. The only transactions this bot ever builds:
//   Morpho.liquidate on the Loopback market · USDG.approve(Morpho) · wsNET/USDG transfer to the owner's PAYOUT_ADDRESS
//   (or, from the withdraw command, the address the owner types).
import { getAddress, MaxUint256, AbiCoder, keccak256 } from 'ethers';
import { MORPHO, MARKET_ID, MARKET_FROM_BLOCK, MARKET_PARAMS, USDG, WSNET, EXPLORER_TX } from './constants.mjs';
import { MORPHO_IFACE, ERC20, readParams, paramsTuple, readTick, readWallet, scanBorrowers, simulate } from './chain.mjs';
import { accrue, positionView, planBid, crossingAt, pricePath, fmtUsdg, fmtWs } from './math.mjs';

// Interest keeps accruing between the read and the block the bid lands in: bids are sized (and approvals set) on the
// debt as it will be HEADROOM_SEC from now, so the USDG Morpho pulls never exceeds what was planned or approved.
const HEADROOM_SEC = 60;
// Borrowers are scanned up to a few blocks behind the head, so a logs node that is a block or two behind can't make
// the cursor skip a Borrow it hasn't indexed yet.
const LOG_LAG = 5;
const DISCOVER_MS = 15_000, EVERYONE_MS = 10 * 60_000;
// What gas costs here: a liquidation uses about LIQ_GAS (Morpho's liquidate plus two token transfers; the 30% gas limit
// margin is never charged), and the wallet's ETH covers this many of them at today's price.
export const LIQ_GAS = 250_000n;
// Dust: loans owing under a cent (a few borrow shares, often with no collateral left). Morpho counts them past the line
// forever, but a bid on one earns nothing: they are left out of the watch list, the closest loans and the counts.
export const DUST_DEBT = 10_000n;
export function gasView(gasPrice, eth) {
  if (!(gasPrice > 0n)) return null;
  const per = gasPrice * LIQ_GAS;
  return { gwei: Number(gasPrice) / 1e9, ethPerLiquidation: Number(per) / 1e18, covers: eth == null ? null : Number(eth / per) };
}
export const marketIdOf = (p) => keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'address', 'address', 'address', 'uint256'], [p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv]));
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
// a contract said no (revert, custom error), as opposed to the RPC failing to answer
export const isRevert = (e) => e?.code === 'CALL_EXCEPTION' || e?.code === 3 || /revert|execution reverted|healthy/i.test(String(e?.shortMessage || e?.reason || e?.message || ''));
const LIQ_TOPIC = MORPHO_IFACE.getEvent('Liquidate').topicHash;
// Timed bids. A loan that interest alone tips past the line crosses at a second that can be worked out in advance, and
// other liquidators fire at that second: a bid sent after the next 2 s check (and a gas estimate) arrives a block late.
// So a loan due to cross within SHOT_WINDOW_SEC gets its bid built ahead (nonce, fees, a fixed gas limit) and sent the
// moment the chain's clock reaches that second. A bid that loses the race reverts and costs only its gas; after
// LOST_MAX lost in a row on one borrower it is left alone for LOST_PAUSE_MS. Lost races go to Telegram once an hour.
export const SHOT_WINDOW_SEC = 90, SHOT_GAS = 600_000n, LOST_MAX = 3, LOST_PAUSE_MS = 10 * 60_000, RACES_EVERY_MS = 60 * 60_000;
const SHOT_LAG_MS = 120;            // after the chain clock reaches the second: lands in its first block, not the one before
const CLOCK_SAMPLES = 30;
// with a loan this close to the line (or a timed bid waiting), each check also reads the oracle's price AHEAD_SEC out
export const AHEAD_HEALTH = 1.03, AHEAD_SEC = [30, 60, 90];

// Wallet balances: units per token, the smallest change worth a word, and how a change is shown
export const TOKENS = { eth: { dec: 18, dust: 10n ** 12n, sym: 'ETH' }, usdg: { dec: 6, dust: 10_000n, sym: 'USDG' }, wsnet: { dec: 18, dust: 10n ** 12n, sym: 'wsNET' },
  net: { dec: 9, dust: 1_000n, sym: 'NET' }, snet: { dec: 9, dust: 1_000n, sym: 'sNET' } };
export const toNum = (v, k) => (v == null ? null : Number(v) / 10 ** TOKENS[k].dec);
export const fmtTok = (v, k) => { const n = toNum(v, k); return n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: k === 'usdg' ? 2 : k === 'eth' ? 6 : 4, minimumFractionDigits: k === 'usdg' ? 2 : 0 }); };
// The bot's own transactions explain a drop in the wallet (and the wsNET a liquidation seizes) until a read at or after
// the block they landed in; one that never confirmed is given at most OWN_MAX_MS.
const OWN_MAX_MS = 30 * 60_000;

// onEvent(ev): what happened, for Telegram and the local page — { kind: 'liquidated' | 'deposit' | 'outflow' | 'tx' | … }
// seed(): optional, the open loans from NetNet Intel's API ({ accounts, block }): a head start, never trusted for amounts.
export function makeBot({ rpc, logsRpc = rpc, sender: initialSender = null, cfg, store, log, notify = async () => {}, onEvent = () => {}, nowMs = () => Date.now(), seed = null }) {
  let sender = initialSender, me = sender?.address ?? null;
  let paused = false;               // the owner's pause (local page or Telegram): keep watching, send nothing
  let params = null;
  const debts = new Map();          // borrower → debt (USDG units) at the last read
  let lastView = null, lastTickAt = null, lastError = null, lastReady = 0, started = false, phase = 'connecting';
  const emit = (ev) => { try { onEvent({ at: nowMs(), ...ev }); } catch { /* a reporter never stops the loop */ } };
  const dbg = (m) => { if (log.debug) log.debug(m); };
  const liveNow = () => !!(cfg.live && sender && !paused);
  const needLive = () => { if (!liveNow()) throw new Error('paused or switched to dry run before it was sent'); };
  const known = new Set(store.borrowers().map((a) => getAddress(a)));
  const health = new Map();          // borrower → last health (debt > 0 only)
  const cooldown = new Map();        // borrower → ms until which it is skipped
  const said = new Map();            // message key → last time, to keep the log quiet
  const fresh = new Set();           // borrowers found since the last full read: read on the next tick
  // the chain scan: `scanned` is the last block every Borrow up to is known (saved); `cursor` is where new blocks are read
  // from each tick. At start the scan from `scanned` to the head runs in the background (`backfill`), so the bot
  // watches the loans it already knows (and NetNet Intel's list) from the first second.
  let scanned = store.cursor ?? MARKET_FROM_BLOCK - 1, cursor = scanned, backfill = null, backfillDone = false, backfillRetryAt = 0;
  let lastDiscover = 0, lastEveryone = 0;
  let rate = null, lastFull = 0, lastHead = null, pausedSince = null, lastSummary = 0, busy = false, ticks = 0;
  let wallet = null, walletAt = null, walletBlock = 0, seen = null, walletLogged = false, backfillPromise = null;
  const own = { pending: 0, open: false, settleBlock: null, until: 0 };
  let sending = Promise.resolve();   // one transaction at a time: two at once could take the same nonce
  // a restart between a send and the next read: the saved balances predate the transaction, so its effect is not news
  // (only a transaction newer than the saved balances, or one whose outcome is unknown, opens that window)
  { const ws = store.walletSeen?.(); if (ws?.at && (store.txs?.() || []).some((t) => t.status === 'unknown' || Date.parse(t.at) >= ws.at)) Object.assign(own, { open: true, until: nowMs() + OWN_MAX_MS }); }
  // addresses only NetNet Intel listed: watched, but saved only once the chain shows a loan (a wrong list can't grow the file)
  const seededOnly = new Set();
  // timed bids: borrower → { at (chain second), timer, plan }; lost races in a row per borrower, and since the last report
  const shots = new Map(), lostRow = new Map();
  let lostSince = [], lastRaces = nowMs();
  // chain clock − local clock, in seconds: the largest recent (latest block's timestamp − local time) (a block's
  // timestamp is floored to the second and the read takes time, so the largest sample is the closest)
  const clock = [];
  const chainOffset = () => (clock.length ? Math.max(...clock) : 0);

  const once = (key, everyMs, f) => { if (said.size > 2000) said.clear(); const t = said.get(key); if (t && nowMs() - t < everyMs) return; said.set(key, nowMs()); f(); };
  const saveScan = () => store.setScan(backfillDone ? cursor : scanned, [...known].filter((a) => !seededOnly.has(a) || health.has(a)));
  const loadSeen = () => { const w = store.walletSeen?.(); seen = w && me && w.address === me ? Object.fromEntries(Object.entries(w.bal).map(([k, v]) => [k, v == null ? null : BigInt(v)])) : null; };
  loadSeen();

  async function start() {
    phase = 'connecting';
    if (marketIdOf(MARKET_PARAMS) !== MARKET_ID) throw new Error('the pinned market parameters do not hash to the Loopback market id');
    const onChain = await readParams(rpc);
    const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
    if (!same(onChain.loanToken, MARKET_PARAMS.loanToken) || !same(onChain.collateralToken, MARKET_PARAMS.collateralToken) || !same(onChain.oracle, MARKET_PARAMS.oracle)
      || !same(onChain.irm, MARKET_PARAMS.irm) || onChain.lltv !== MARKET_PARAMS.lltv)
      throw new Error('this RPC does not return the Loopback market as it is on Robinhood Chain: check RPC_URL');
    params = MARKET_PARAMS;   // from here on only the pinned parameters are used
    phase = 'loading';
    const head = parseInt(await logsRpc.one('eth_blockNumber', []), 16) - LOG_LAG;
    if (seed) {
      const t0 = nowMs();
      try {
        const s = await seed();
        let added = 0;
        for (const a of s?.accounts || []) { if (!known.has(a)) { known.add(a); seededOnly.add(a); added++; } fresh.add(a); }
        log.info(`NetNet Intel: ${s?.accounts?.length ?? 0} open loans loaded in ${nowMs() - t0} ms${added ? ` (${added} new here)` : ''}`);
        if (added) saveScan();
      } catch (e) { log.warn(`NetNet Intel API not reachable (${e.message}): finding the loans on chain instead`); }
    }
    cursor = Math.max(cursor, head);
    if (scanned < head) startBackfill(scanned + 1, head);
    else { backfillDone = true; saveScan(); }
    log.info(`watching ${known.size} borrower wallets${backfillDone ? '' : ` · scanning the chain since block ${(scanned + 1).toLocaleString('en-US')} in the background`}`);
    started = true; phase = 'watching';
    return params;
  }

  // every Borrow since the market opened (or since the last run), in the background; new borrowers join at once
  function startBackfill(from, to) {
    if (backfill?.running) return;
    const t0 = nowMs(), before = known.size;
    backfill = { from: backfill?.from ?? from, to, at: from - 1, running: true, error: null };
    dbg(`chain scan: blocks ${from} → ${to}`);
    backfillPromise = scanBorrowers(logsRpc, from, to, { range: cfg.logRange, minRange: cfg.minLogRange, onProgress: (b, n, added) => {
      backfill.at = b;
      for (const a of added) { seededOnly.delete(a); if (!known.has(a)) { known.add(a); fresh.add(a); } }
      once('scanprog', 5_000, () => dbg(`chain scan: block ${b.toLocaleString('en-US')} (${Math.floor(((b - backfill.from) / Math.max(1, to - backfill.from)) * 100)}%), ${known.size} borrowers`));
    } }).then(() => {
      backfill = { ...backfill, at: to, running: false }; backfillDone = true; scanned = to; saveScan();
      log.info(`chain scan done in ${((nowMs() - t0) / 1000).toFixed(1)} s: ${known.size} wallets have borrowed on Loopback${known.size > before ? ` (${known.size - before} more than NetNet Intel's open list)` : ''}`);
    }, (e) => {
      backfill = { ...backfill, running: false, error: e.message }; backfillRetryAt = nowMs() + 60_000;
      if (backfill.at >= from) { scanned = backfill.at; saveScan(); }
      once('backfill', 600_000, () => log.warn(`chain scan paused at block ${backfill.at.toLocaleString('en-US')} (${e.message}); retrying in a minute`));
    });
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
      for (const a of found) { seededOnly.delete(a); if (!known.has(a)) { known.add(a); added++; } fresh.add(a); }
      cursor = head;
      if (added) { saveScan(); log.info(`${added} new borrower${added > 1 ? 's' : ''}`); }
      else if (backfillDone && head - (store.cursor ?? 0) > 50_000) saveScan();   // keep the saved cursor near the head
    } catch (e) { once('discover', 60_000, () => log.warn(`could not read new borrowers: ${e.message}`)); }
  }

  // ---- the wallet: balances for the page (a value that didn't read keeps the last good one), deposits, and funds that
  // left without the bot sending them. Bids never use these merged values: they use the tick's own read.
  function trackWallet(w, blk = null) {
    if (!me || !w) return wallet;
    if (blk != null && blk < walletBlock) { dbg(`wallet read from block ${blk}, behind ${walletBlock}: ignored`); return wallet; }   // a node behind the last one
    if (blk != null) walletBlock = blk;
    const merged = { ...(wallet || {}) };
    for (const [k, v] of Object.entries(w)) if (v != null) merged[k] = v;
    wallet = merged; walletAt = nowMs();
    if (!walletLogged && wallet.eth != null) {
      walletLogged = true;
      log.info(`bot wallet ${short(me)}: ${['eth', 'usdg', 'wsnet', 'net', 'snet'].filter((k) => k === 'eth' || k === 'usdg' || wallet[k] > 0n).map((k) => `${fmtTok(wallet[k], k)} ${TOKENS[k].sym}`).join(' · ')}`);
    }
    if (own.open && nowMs() >= own.until && !own.pending) own.open = false;
    const mine = own.pending > 0 || own.open;                                 // the bot's own transactions are still settling
    const cur = Object.fromEntries(Object.keys(TOKENS).map((k) => [k, wallet[k] ?? null]));
    if (seen) for (const k of Object.keys(TOKENS)) {
      const a = seen[k], b = cur[k];
      if (a == null || b == null || w[k] == null) continue;                    // only what this read actually saw
      const d = b - a;
      if (d > TOKENS[k].dust) {
        if (k === 'wsnet' && mine) continue;                                   // seized by the bot's own liquidation
        if (k === 'snet' && a > 0n && d * 50n < a) { dbg(`sNET rebase: +${fmtTok(d, k)}`); continue; }   // under 2%: the staking rebase
        log.info(`received ${fmtTok(d, k)} ${TOKENS[k].sym} · balance ${fmtTok(b, k)}`);
        emit({ kind: 'deposit', token: TOKENS[k].sym, amount: toNum(d, k), balance: toNum(b, k), address: me });
      } else if (-d > TOKENS[k].dust) {
        if (mine) { dbg(`${TOKENS[k].sym} −${fmtTok(-d, k)}: the bot's own transaction`); continue; }
        log.warn(`${fmtTok(-d, k)} ${TOKENS[k].sym} left the bot wallet, not sent by this bot · balance ${fmtTok(b, k)}`);
        emit({ kind: 'outflow', token: TOKENS[k].sym, amount: toNum(-d, k), balance: toNum(b, k), address: me });
      }
    }
    // a read at or after the block the bot's last transaction landed in: its effect is now in the balances
    if (own.open && !own.pending && own.settleBlock != null && blk != null && blk >= own.settleBlock) own.open = false;
    const changed = !seen || Object.keys(TOKENS).some((k) => cur[k] !== seen[k]);
    seen = cur;
    if (changed) store.setWalletSeen?.(me, Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, v == null ? null : String(v)])));
    return wallet;
  }
  /** The wallet alone: while the bot is starting (or can't), the page still shows balances and deposits. */
  async function refreshWallet() {
    if (!me) return null;
    const r = await readWallet(rpc, me);
    if (r.gasPrice != null) lastView = { ...(lastView || {}), gasPrice: r.gasPrice };
    return trackWallet(r.wallet, r.block);
  }

  // ---- every transaction the bot sends goes through here: the terminal, the page's Transactions and Telegram see it ----
  function sendTx(kind, tx, note, { check = null } = {}) {
    const run = sending.then(() => sendOne(kind, tx, note, check));
    sending = run.catch(() => null);
    return run;
  }
  async function sendOne(kind, tx, note, check) {
    if (!sender) throw new Error('the wallet is locked');
    if (check) check();                                  // re-checked when its turn comes: paused or dry run since → not sent
    own.pending++; own.open = true; own.until = nowMs() + OWN_MAX_MS; own.settleBlock = null;   // settled by this one's block, not an earlier one's
    const rec = { at: new Date(nowMs()).toISOString(), kind, note, status: 'pending', hash: null };
    try {
      let sent;
      try { sent = await sender.send(tx); }
      catch (e) { rec.status = 'failed'; rec.error = String(e.shortMessage || e.message).slice(0, 200); store.recordTx?.(rec); log.warn(`tx ${kind} not sent: ${note} (${rec.error})`); emit({ kind: 'tx', tx: { ...rec } }); throw e; }
      rec.hash = sent.hash; store.recordTx?.(rec);
      log.info(`tx ${kind} sent: ${note} · ${EXPLORER_TX}${sent.hash}`);
      let receipt = null;
      try { receipt = await sent.wait(); } catch (e) { rec.error = String(e.shortMessage || e.message).slice(0, 200); }
      rec.status = receipt ? (receipt.status === 1 ? 'ok' : 'reverted') : 'unconfirmed';
      if (receipt?.blockNumber != null) { rec.block = Number(receipt.blockNumber); own.settleBlock = Math.max(own.settleBlock ?? 0, rec.block); }
      const gp = receipt?.gasPrice ?? receipt?.effectiveGasPrice;
      if (receipt?.gasUsed != null) { rec.gasUsed = Number(receipt.gasUsed); if (gp != null) rec.feeEth = Number(BigInt(receipt.gasUsed) * BigInt(gp)) / 1e18; }
      store.recordTx?.(rec);
      const how = rec.status === 'ok' ? `confirmed${rec.block ? ` in block ${rec.block.toLocaleString('en-US')}` : ''}${rec.feeEth != null ? ` · fee ${rec.feeEth.toFixed(8)} ETH` : ''}` : rec.status;
      (rec.status === 'ok' ? log.info : log.warn)(`tx ${kind} ${how}`);
      emit({ kind: 'tx', tx: { ...rec } });
      return { hash: sent.hash, receipt };
    } finally { own.pending--; }
  }

  async function tick() {
    if (busy) return null;
    busy = true;
    try { const r = await tickInner(); lastError = null; return r; }
    catch (e) { lastError = e.message; throw e; }
    finally { busy = false; lastTickAt = nowMs(); store.heartbeat(); }
  }

  async function tickInner() {
    const now = nowMs(), t0 = Date.now();
    ticks++;
    if (!backfillDone && !backfill?.running && now >= backfillRetryAt && backfill) startBackfill(Math.max(scanned, backfill.at) + 1, cursor);
    // new borrowers: every 15 s, not every tick (a fresh loan sits at the LTV it was opened at, not past the line)
    if (now - lastDiscover >= DISCOVER_MS) { lastDiscover = now; await discover(lastHead); }
    // every 30 s: each open loan; every 10 minutes: every wallet that ever borrowed (one may have borrowed again).
    // Reading all ~800 every 30 s used up providers' per-second limits for nothing: most have no loan now.
    const full = now - lastFull >= cfg.fullEverySeconds * 1000;
    const everyone = now - lastEveryone >= EVERYONE_MS;
    const list = everyone ? [...known]
      : full ? [...known].filter((a) => fresh.has(a) || health.has(a))
      : [...known].filter((a) => fresh.has(a) || (health.get(a) ?? Infinity) < cfg.hotHealth);
    if (everyone) lastEveryone = now;
    // the rate moves slowly: re-read with every full pass (and until a read succeeds)
    const near = shots.size > 0 || [...health.values()].some((h) => h < AHEAD_HEALTH);
    const chainNow = Date.now() / 1000 + chainOffset();
    const ahead = near && clock.length ? AHEAD_SEC.map((d) => chainNow + d) : [];
    const view = await readTick(rpc, params, me, list, { rate: full || rate == null ? null : rate, ahead });
    if (ahead.length && !view.priceAhead) once('ahead', 3_600_000, () => log.info('this RPC does not read the oracle ahead (block-time overrides): timed bids follow interest only'));
    if (full || rate == null) rate = view.rate;
    if (view.rate == null) once('rate', 600_000, () => log.warn('the interest rate did not read: debts are figured without the interest since the market last moved'));
    if (full) lastFull = now;
    fresh.clear();
    lastHead = view.block?.number ?? lastHead;
    const spend = view.wallet;                                // this tick's read: what bids and approvals use (unread → none)
    const wallet = trackWallet(view.wallet, view.block?.number ?? null);
    lastView = { block: view.block, price: view.price, gasPrice: view.gasPrice };
    const st = rpc.stats?.();
    dbg(`tick ${ticks} · block ${view.block?.number?.toLocaleString('en-US') ?? '?'} · read ${list.length}${full ? ' (all)' : ''} loans in ${Date.now() - t0} ms${st ? ` · rpc ${st.host} ~${st.ms} ms${st.fallback ? ' (fallback)' : ''}` : ''}${view.price == null ? ' · oracle paused' : ''}`);

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
      if (v.debt < DUST_DEBT) { health.delete(b); debts.delete(b); continue; }
      health.set(b, v.health); debts.set(b, v.debt);
      if (v.liquidatable) ready.push({ borrower: b, pos, view: v });
    }
    if (everyone) for (const b of known) if (!view.positions.has(b)) { health.delete(b); debts.delete(b); }
    if (view.block?.timestamp != null) { clock.push(view.block.timestamp - t0 / 1000); if (clock.length > CLOCK_SAMPLES) clock.shift(); }
    await armShots(view, spend, nowSec, now);
    racesReport(now);
    lastReady = ready.length;
    if (ready.length) dbg(`liquidatable: ${ready.map((r) => `${short(r.borrower)} ${(Math.floor(r.view.health * 1e4) / 1e4).toFixed(4)}`).join(', ')}`);

    if (cfg.live && me && wallet?.eth != null && wallet.eth < cfg.gasFloorWei) once('gas', 3_600_000, () => { log.warn(`the wallet has ${(Number(wallet.eth) / 1e18).toFixed(6)} ETH for gas: top it up`); notify(`Liquidator wallet ${short(me)} is low on ETH for gas.`); emit({ kind: 'gas', eth: Number(wallet.eth) / 1e18 }); });
    summary(now, wallet, ready.length);
    const idle = async () => {
      if (liveNow()) try { await keepApproved(spend); } catch (e) {
        once('approve', 600_000, () => log.warn(`could not set the USDG approval: ${e.shortMessage || e.message}`));
        once('approve-tg', 3_600_000, () => emit({ kind: 'approve_failed', error: String(e.shortMessage || e.message).slice(0, 140) }));   // live but unable to bid
      }
    };
    if (!ready.length) { await idle(); return { ready: 0 }; }

    const budgetOf = () => {
      if (!me) return cfg.maxRepay ?? 10n ** 15n;           // no wallet (scan mode): size bids as if funds were plenty
      if (spend?.usdg == null) return 0n;                    // unread this tick: no bid on a guess
      let b = spend.usdg - cfg.reserve;
      if (cfg.maxRepay != null && b > cfg.maxRepay) b = cfg.maxRepay;
      return b > 0n ? b : 0n;
    };
    const plans = ready.map((r) => ({ ...r, plan: planBid(r.pos, mPlan, view.price, params.lltv, budgetOf(), { allowPartial: cfg.allowPartial }) }))
      .sort((a, b) => Number((b.plan.profit ?? -1n) - (a.plan.profit ?? -1n)));

    const results = [];
    for (const t of plans) {
      if ((cooldown.get(t.borrower) ?? 0) > now || shots.has(t.borrower)) continue;   // a timed bid is already on its way
      if (t.plan.skip) {
        once(`skip:${t.borrower}`, 600_000, () => log.info(`${short(t.borrower)} is liquidatable (health ${t.view.health.toFixed(4)}, debt ${fmtUsdg(t.view.debt)} USDG) but skipped: ${t.plan.skip}`));
        // a chance missed for want of USDG: worth telling the owner, at most hourly
        if (liveNow()) once('nofunds', 3_600_000, () => emit({ kind: 'nofunds', borrower: t.borrower, debt: fmtUsdg(t.view.debt), usdg: spend?.usdg != null ? fmtUsdg(spend.usdg) : null }));
        continue;
      }
      if (t.plan.profit < cfg.minProfit) { once(`small:${t.borrower}`, 600_000, () => log.info(`${short(t.borrower)}: a bid earns ${fmtUsdg(t.plan.profit)} USDG at the oracle, under MIN_PROFIT_USDG`)); continue; }
      results.push(await act(t, spend));
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
        if (!isRevert(e)) {                                // the RPC failed, not Morpho: a failure to report, not a miss
          log.warn(`${short(borrower)}: not sent, the gas estimate failed (${reason})`);
          cooldown.set(borrower, now + 5_000);
          once(`failed:${borrower}`, 600_000, () => emit({ kind: 'failed', borrower, error: `RPC: ${String(reason).slice(0, 140)}` }));
          return { sent: false, borrower, reason };
        }
        log.info(`${short(borrower)}: not sent, Morpho would refuse it now (${reason}); someone may have got there first`);
        cooldown.set(borrower, now + 10_000);
        once(`missed:${borrower}`, 600_000, () => emit({ kind: 'missed', borrower, reason: String(reason).slice(0, 120) }));
        return { sent: false, borrower, reason };
      }
      let sent, rec;
      ({ hash: sent, receipt: rec } = await sendTx('liquidate', { ...tx, gasLimit: (gas * 13n) / 10n }, what, { check: needLive }));
      sent = { hash: sent };
      if (!rec || rec.status !== 1) throw new Error(`the transaction ${rec ? 'reverted' : 'was not confirmed in 2 minutes'} (${EXPLORER_TX}${sent.hash})`);
      return await landed(t, sent, rec, now);
    } catch (e) {
      log.error(`${short(borrower)}: ${e.shortMessage || e.message}`);
      notify(`Liquidation attempt on ${short(borrower)} failed: ${e.shortMessage || e.message}`, { key: `fail:${borrower}`, everyMs: 600_000 });
      once(`failed:${borrower}`, 600_000, () => emit({ kind: 'failed', borrower, error: String(e.shortMessage || e.message).slice(0, 160) }));
      cooldown.set(borrower, now + 30_000);
      return { sent: false, borrower, error: e.message };
    }
  }

  // a liquidation that landed: record it, tell the owner, pay the wsNET out
  async function landed(t, sent, rec, now) {
    const { borrower, plan } = t;
    {
      const ev = rec.logs.find((l) => l.address?.toLowerCase() === MORPHO.toLowerCase() && l.topics?.[0] === LIQ_TOPIC);
      const d = ev ? MORPHO_IFACE.decodeEventLog('Liquidate', ev.data, ev.topics) : null;
      const repaid = d ? d.repaidAssets : plan.repaid, seized = d ? d.seizedAssets : plan.seized;
      const entry = { at: new Date().toISOString(), tx: sent.hash, borrower, repaid: fmtUsdg(repaid), seized: fmtWs(seized), badDebt: d ? fmtUsdg(d.badDebtAssets) : null, profitAtOracle: fmtUsdg((seized * t.plan.valueAtOracle) / (t.plan.seized || 1n) - repaid) };
      store.record(entry);
      emit({ kind: 'liquidated', ...entry, at: nowMs() });
      log.info(`liquidated ${short(borrower)}: repaid ${entry.repaid} USDG, seized ${entry.seized} wsNET (≈ +${entry.profitAtOracle} USDG at the oracle)`);
      await notify(`Liquidated ${short(borrower)} on Loopback: repaid ${entry.repaid} USDG, seized ${entry.seized} wsNET (≈ +${entry.profitAtOracle} USDG at the oracle).\n${EXPLORER_TX}${sent.hash}`);
      if (cfg.payout) await payout(seized);
      cooldown.set(borrower, now + 5_000);
      lostRow.delete(borrower);
      return { sent: true, borrower, tx: sent.hash, entry };
    }
  }

  // ---- timed bids ----
  async function armShots(view, spend, nowSec, now) {
    const live = liveNow() && me && rate != null && rate > 0n;
    const keep = new Set();
    // interest, and the oracle's drift: between swaps the TWAP moves toward the pool's price second by second
    const priceAt = view.priceAhead ? pricePath([{ t: nowSec, price: view.price }, ...view.priceAhead]) : null;
    if (live) {
      let budget = spend?.usdg == null ? 0n : spend.usdg - cfg.reserve;
      if (cfg.maxRepay != null && budget > cfg.maxRepay) budget = cfg.maxRepay;
      for (const [b, pos] of view.positions) {
        if (!(pos.borrowShares > 0n) || (debts.get(b) ?? 0n) < DUST_DEBT || (cooldown.get(b) ?? 0) > now) continue;
        const at = crossingAt(pos, view.market, rate, view.price, params.lltv, nowSec, SHOT_WINDOW_SEC, priceAt);
        if (at == null) continue;
        const plan = planBid(pos, accrue(view.market, rate, at + 30), priceAt ? priceAt(at) : view.price, params.lltv, budget > 0n ? budget : 0n, { allowPartial: cfg.allowPartial });
        if (plan.skip || plan.profit < cfg.minProfit) continue;
        keep.add(b);
        const have = shots.get(b);
        if (have && have.at === at && have.plan.args.repaidShares === plan.args.repaidShares && have.plan.args.seizedAssets === plan.args.seizedAssets) continue;
        if (have) clearTimeout(have.timer);
        await arm(b, at, plan, view, spend);
      }
    }
    for (const [b, s] of shots) if (!keep.has(b)) { clearTimeout(s.timer); shots.delete(b); }   // healed, repaid, or no longer due
  }
  async function arm(borrower, at, plan, view, spend) {
    try {
      if (spend?.allowance == null || spend.allowance < plan.repaid) await keepApproved(spend, plan.repaid);
      const nonce = await sender.nonce();
      const gp = view.gasPrice ?? 0n;
      const tx = { to: MORPHO, data: MORPHO_IFACE.encodeFunctionData('liquidate', [paramsTuple(params), borrower, plan.args.seizedAssets, plan.args.repaidShares, '0x']),
        gasLimit: SHOT_GAS, nonce, type: 2, maxFeePerGas: gp > 0n ? gp * 2n : undefined, maxPriorityFeePerGas: 0n };
      const wait = Math.max(0, (at - chainOffset()) * 1000 + SHOT_LAG_MS - nowMs());
      const shot = { at, plan, nonce, timer: null };
      shot.timer = setTimeout(() => { fire(borrower, shot, tx).catch(() => null); }, wait);
      shots.set(borrower, shot);
      once(`armed:${borrower}:${at}`, 600_000, () => log.info(`${short(borrower)} crosses the line in ${Math.round(wait / 1000)} s (interest${view.priceAhead ? ' and the oracle\'s drift' : ''}): a ${plan.mode} bid (repay ${fmtUsdg(plan.repaid)} USDG, +${fmtUsdg(plan.profit)}) goes out at that second`));
    } catch (e) {
      once(`arm:${borrower}`, 600_000, () => log.warn(`${short(borrower)}: could not prepare a timed bid (${e.shortMessage || e.message})`));
    }
  }
  async function fire(borrower, shot, tx) {
    if (shots.get(borrower) !== shot) return;
    shots.delete(borrower);
    if (!liveNow()) return;
    const now = nowMs();
    cooldown.set(borrower, now + 15_000);                          // the 2 s check leaves it to this bid
    const what = `timed ${shot.plan.mode} bid on ${short(borrower)}: repay ${fmtUsdg(shot.plan.repaid)} USDG, seize ${fmtWs(shot.plan.seized)} wsNET (+${fmtUsdg(shot.plan.profit)})`;
    let r;
    try { r = await sendTx('liquidate', tx, what, { check: needLive }); }
    catch (e) {
      // usually the nonce moved (another transaction went first): the next check bids the normal way
      cooldown.delete(borrower);
      log.warn(`${short(borrower)}: the timed bid was not sent (${e.shortMessage || e.message})`);
      return;
    }
    if (r.receipt?.status === 1) return landed({ borrower, plan: shot.plan }, { hash: r.hash }, r.receipt, now);
    if (!r.receipt) return;                                        // unconfirmed: the transaction list shows it
    const n = (lostRow.get(borrower) ?? 0) + 1;
    lostRow.set(borrower, n);
    lostSince.push({ borrower, at: now, block: r.receipt.blockNumber != null ? Number(r.receipt.blockNumber) : null });
    log.info(`${short(borrower)}: lost the race (the bid reverted: someone was first, or the price moved)${n >= LOST_MAX ? ` · ${n} in a row: leaving it for ${LOST_PAUSE_MS / 60_000} min` : ''}`);
    if (n >= LOST_MAX) { cooldown.set(borrower, now + LOST_PAUSE_MS); lostRow.delete(borrower); }
  }
  function racesReport(now) {
    if (now - lastRaces < RACES_EVERY_MS) return;
    lastRaces = now;
    if (!lostSince.length) return;
    const by = {};
    for (const l of lostSince) by[l.borrower] = (by[l.borrower] || 0) + 1;
    const n = lostSince.length;
    lostSince = [];
    const list = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([b, k]) => ({ borrower: b, n: k }));
    emit({ kind: 'races', lost: n, borrowers: list });
    notify(`Lost ${n} liquidation race${n === 1 ? '' : 's'} in the last hour: ${list.map((x) => `${short(x.borrower)} ×${x.n}`).join(', ')}. Another bot landed first; each lost bid only cost its gas.`);
  }

  // Morpho pulls the repaid USDG, so it needs an allowance: the wallet's spendable USDG (capped at MAX_REPAY_USDG), set
  // while idle so a bid doesn't wait on it. That much, never unlimited. An allowance that didn't read is left alone
  // while idle (no approval resent on a flaky read); before a bid it is set.
  async function keepApproved(wallet, need = null) {
    if (!wallet || wallet.usdg == null || (need == null && wallet.allowance == null)) return;
    let want = wallet.usdg - cfg.reserve;
    if (cfg.maxRepay != null && want > cfg.maxRepay) want = cfg.maxRepay;
    if (need != null && need > want) want = need;
    if (want <= 0n || (wallet.allowance != null && wallet.allowance >= want)) return;
    await approve(want, wallet);
  }
  async function approve(amount, wallet) {
    if (amount > MaxUint256) amount = MaxUint256;
    if (!liveNow()) throw new Error('paused or in dry run');
    const { hash, receipt } = await sendTx('approve', { to: USDG, data: ERC20.encodeFunctionData('approve', [MORPHO, amount]) }, `let Morpho take up to ${fmtUsdg(amount)} USDG for liquidations`, { check: needLive });
    if (!receipt || receipt.status !== 1) throw new Error('the USDG approval failed');
    if (wallet) wallet.allowance = amount;
    emit({ kind: 'approved', usdg: fmtUsdg(amount), tx: hash });
  }
  async function payout(amount) {
    try {
      await sendTx('payout', { to: WSNET, data: ERC20.encodeFunctionData('transfer', [cfg.payout, amount]) }, `${fmtWs(amount)} wsNET to your main wallet ${short(cfg.payout)}`, { check: needLive });
    } catch (e) {
      log.warn(`the seized wsNET stays in the bot wallet: sending it to PAYOUT_ADDRESS failed (${e.shortMessage || e.message})`);
      emit({ kind: 'payout_failed', wsnet: fmtWs(amount), error: String(e.shortMessage || e.message).slice(0, 140) });
    }
  }

  function summary(now, wallet, ready) {
    if (now - lastSummary < 300_000) return;
    lastSummary = now;
    const close = [...health.entries()].sort((a, b) => a[1] - b[1]);
    const near = close[0] ? `closest ${short(close[0][0])} at ${close[0][1].toFixed(3)}× health` : 'no open loans';
    const w = wallet ? ` · wallet ${fmtTok(wallet.usdg, 'usdg')} USDG, ${fmtTok(wallet.wsnet, 'wsnet')} wsNET, ${fmtTok(wallet.eth, 'eth')} ETH` : '';
    log.info(`watching ${health.size} open loans, ${close.filter(([, h]) => h < cfg.hotHealth).length} under ${cfg.hotHealth}× · ${near}${ready ? ` · ${ready} liquidatable` : ''}${w}`);
  }

  // what the local page and the Telegram status line show
  function status() {
    const w = wallet;
    const closest = [...health.entries()].sort((a, b) => a[1] - b[1]).slice(0, 8)
      .map(([b, h]) => ({ borrower: b, health: h < 1 ? Math.floor(h * 1e4) / 1e4 : Math.round(h * 1e4) / 1e4, debt: Number(fmtUsdg(debts.get(b) ?? 0n)) }));   // floored: past the line never shows as 1.0000
    const bf = backfill && !backfillDone ? { pct: Math.min(99, Math.max(0, Math.floor(((backfill.at - backfill.from + 1) / Math.max(1, backfill.to - backfill.from + 1)) * 100))), error: backfill.error } : null;
    const st = rpc.stats?.() || null;
    return {
      started, phase, live: !!cfg.live, liveNow: liveNow(), paused, hasWallet: !!sender, address: me,
      scan: bf, gas: gasView(lastView?.gasPrice, w?.eth ?? null),
      block: lastView?.block?.number ?? null, lastTickAt, lastError, oraclePaused: !!pausedSince,
      rpc: st ? { host: st.host, ms: st.ms, fallback: st.fallback, error: st.lastError } : null,
      known: known.size, open: health.size, hot: [...health.values()].filter((h) => h < cfg.hotHealth).length, ready: lastReady, closest,
      wallet: w ? { ...Object.fromEntries(Object.keys(TOKENS).map((k) => [k, toNum(w[k], k)])), allowance: w.allowance == null ? null : Number(fmtUsdg(w.allowance)), at: walletAt } : null,
    };
  }
  function setSender(s) {
    const changed = (s?.address ?? null) !== me;
    sender = s; me = s?.address ?? null;
    if (changed) { wallet = null; walletAt = null; walletLogged = false; loadSeen(); }
  }
  function setPaused(p) { paused = !!p; }
  // going live (or resuming) acts on a loan at once, not after the dry run's wait on it
  function freshStart() { cooldown.clear(); }

  // the command line's scan and status wait for the whole chain scan
  const scanDone = async () => { while (!backfillDone) { if (backfillPromise) await backfillPromise.catch(() => null); if (!backfillDone && backfill?.error) throw new Error(backfill.error); } };

  return { start, tick, refreshWallet, scanDone, sendTx, keepApproved, status, setSender, setPaused, freshStart, get busy() { return busy; }, get paused() { return paused; }, get started() { return started; }, get known() { return known; }, get health() { return health; }, get params() { return params; } };
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
