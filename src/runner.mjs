// The running bot: the liquidation loop, its wallet (locked until the owner logs in to the local page, unless they
// chose otherwise), the owner's settings, and the Telegram link. server.mjs calls the methods below; nothing here is
// reachable from outside the owner's machine except the relay's own outbound calls.
import { readFileSync } from 'node:fs';
import { JsonRpcProvider, FetchRequest, Wallet, getAddress, keccak256 } from 'ethers';
import { randomInt } from 'node:crypto';
import { CHAIN_ID, USDG, WSNET, NET, SNET, EXPLORER_TX, PUBLIC_RPC, PUBLIC_SEQUENCER, PUBLIC_FEED, PUBLIC_FEED_DELAYED, RPC_PROVIDERS, INTEL_API } from './constants.mjs';
import { configFrom } from './config.mjs';
import { makeRpc, ERC20 } from './chain.mjs';
import { loadWallet, keySource, writeKeystore, openKeystore, walletFromSecret } from './wallet.mjs';
import { makeStore, makeNotify } from './io.mjs';
import { makeBot, TOKENS, fmtTok, isRevert } from './bot.mjs';
import { makeIntel, intelBase, walletValue } from './intel.mjs';
import { makeSettings, effectiveEnv } from './settings.mjs';
import { makeRelay, TOKEN_RE } from './relay.mjs';
import { fmtUsdg, fmtWs } from './math.mjs';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const httpErr = (status, message) => Object.assign(new Error(message), { status });

// Signs on this machine; the signed transaction goes to the RPC and, at the same time, straight to the sequencer (the
// node that orders Robinhood Chain's transactions). Whichever takes it first wins; it is the same transaction, so it
// can only land once. The sequencer takes nothing but signed transactions, so it never sees the key or the balances.
// rpcUrl may be a list (your RPC, then the public one): a node that fails to answer (not one that answers "no") is
// skipped for that call, so sending keeps working while your RPC is down, as reading does.
// a node that didn't answer, as opposed to the chain answering "no" (a revert is never retried on another node: a node
// a few blocks behind could say yes to a bid that then reverts on chain). Only the short message is read: ethers puts
// the calldata in the long one, and hex can contain anything.
export const isNetErr = (e) => {
  if (isRevert(e) || e?.code === 'CALL_EXCEPTION' || e?.code === 'INSUFFICIENT_FUNDS' || e?.code === 'NONCE_EXPIRED') return false;
  if (['NETWORK_ERROR', 'TIMEOUT', 'SERVER_ERROR'].includes(e?.code)) return true;
  return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|timeout|\b(429|502|503|504)\b/i.test(String(e?.shortMessage || e?.code || ''));
};
const NODE_TIMEOUT_MS = 12_000, NODE_SKIP_MS = 30_000;
export function senderOf(wallet, rpcUrl, { sequencerUrl = null, fetchImpl = fetch, log = null } = {}) {
  const urls = [...new Set((Array.isArray(rpcUrl) ? rpcUrl : [rpcUrl]).filter(Boolean))];
  const providers = urls.map((u) => { const req = new FetchRequest(u); req.timeout = NODE_TIMEOUT_MS; return new JsonRpcProvider(req, { chainId: CHAIN_ID, name: 'robinhood' }, { staticNetwork: true, batchMaxCount: 1 }); });
  const signers = providers.map((p) => wallet.connect(p));
  const down = urls.map(() => 0);                    // a node that failed to answer is tried last for NODE_SKIP_MS
  const each = async (f) => {
    const order = [...signers.keys()].sort((a, b) => (down[a] > Date.now()) - (down[b] > Date.now()));
    let last;
    for (const [n, i] of order.entries()) {
      try { return await f(signers[i], providers[i]); }
      catch (e) {
        if (!isNetErr(e) || n === order.length - 1) throw e;
        last = e; down[i] = Date.now() + NODE_SKIP_MS;
        log?.debug?.(`sender: ${new URL(urls[i]).host} didn't answer (${e.shortMessage || e.code}), trying the next`);
      }
    }
    throw last;
  };
  const toSequencer = async (raw) => {
    const res = await fetchImpl(sequencerUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }), signal: AbortSignal.timeout(10_000) });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j || j.error) throw new Error(`sequencer: ${j?.error?.message || 'HTTP ' + res.status}`);
    return j.result;
  };
  // the receipt from whichever node has it, polled every second for up to two minutes (null if it never shows)
  const waitFor = async (hash, ms = 120_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      for (const p of providers) { try { const r = await p.getTransactionReceipt(hash); if (r) return r; } catch { /* the next node */ } }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
  };
  return {
    address: wallet.address, provider: providers[0],
    estimateGas: (tx) => each((x) => x.estimateGas({ ...tx, from: wallet.address })),
    balance: () => each((x, p) => p.getBalance(wallet.address)),
    feeData: () => each((x, p) => p.getFeeData()),
    nonce: () => each((x, p) => p.getTransactionCount(wallet.address, 'pending')),
    send: async (tx) => {
      const pop = await each((x) => x.populateTransaction({ ...tx, chainId: CHAIN_ID }));
      const raw = await signers[0].signTransaction(pop), hash = keccak256(raw);
      const tries = providers.map((p) => p.broadcastTransaction(raw).then(() => 'rpc'));
      if (sequencerUrl) tries.push(toSequencer(raw).then(() => 'sequencer'));
      try {
        const first = await Promise.any(tries);
        log?.debug?.(`tx ${hash.slice(0, 10)}… accepted first by the ${first}`);
      } catch (e) { throw e.errors?.[0] ?? e; }   // all refused: the RPC's reason (nonce, funds) is the clearest
      for (const t of tries) t.catch(() => null);
      return { hash, wait: () => waitFor(hash) };
    },
  };
}

export async function makeRunner({ env, log, fetchImpl = fetch, makeSender = senderOf }) {
  const dataDir = env.DATA_DIR || '/data';
  const settings = makeSettings(dataDir);
  const derived = () => effectiveEnv(env, settings.get());
  const cfg = configFrom(derived().env);
  const urls = (u) => () => (cfg.rpcFallback ? [u(), PUBLIC_RPC] : [u()]);
  const onFallback = (name) => (on, primary, now, why) => {
    if (on) log.warn(`${name}: ${primary} is not answering${why ? ` (${why})` : ''}: using the public RPC until it is back`);
    else log.info(`${name}: back on ${now}`);
  };
  const rpc = makeRpc(urls(() => cfg.rpcUrl), { batchSize: cfg.rpcBatch, fetchImpl, onFallback: onFallback('RPC') });
  const logsRpc = makeRpc(urls(() => cfg.logsRpcUrl), { batchSize: cfg.rpcBatch, fetchImpl, onFallback: onFallback('RPC for finding borrowers') });
  const intel = makeIntel({ base: intelBase(env), version: VERSION, fetchImpl });
  const store = makeStore(dataDir);
  const notify = makeNotify(env, log, fetchImpl);
  const relay = makeRelay({ getToken: () => settings.get().relayToken || null, version: VERSION, fetchImpl, log: (m) => log.warn(m) });
  const events = [];   // the last events, for the local page
  const onEvent = (e) => {
    const ev = { ...e, at: typeof e.at === 'number' ? e.at : Date.now() };   // a liquidation's record carries its ISO time: the event keeps a number
    events.push(ev); if (events.length > 100) events.shift();
    if (ev.kind !== 'tx') relay.report(ev);                         // Telegram hears about outcomes; the page lists every transaction
    if (ev.kind === 'deposit') notify(`Liquidator wallet received ${ev.amount} ${ev.token} (balance ${ev.balance}).`);
    if (ev.kind === 'outflow') notify(`${ev.amount} ${ev.token} left the liquidator wallet, not sent by the bot. If that wasn't you, move what's left.`);
  };
  const bot = makeBot({ rpc, logsRpc, cfg, store, log, notify, onEvent, seed: intel.enabled ? () => intel.loans() : null });

  let wallet = null, walletSource = null, pw = null, pending = null, sender = null, withdrawing = false;
  const keyEnv = { ...env, DATA_DIR: dataDir };
  // one sender for the wallet, shared by the loop and withdrawals (a second signer could reuse a nonce)
  const newSender = (w) => makeSender(w, cfg.rpcFallback ? [cfg.rpcUrl, PUBLIC_RPC] : cfg.rpcUrl, { sequencerUrl: cfg.sequencerUrl, fetchImpl, log });
  const useWallet = (w, source) => { wallet = w; walletSource = source; sender = w ? newSender(w) : null; bot.setSender(sender); };

  // unlocked at start when the environment gives the key or the password, or the owner chose to stay unlocked
  const fromEnv = ['PRIVATE_KEY', 'PRIVATE_KEY_FILE', 'KEYSTORE_PASSWORD', 'KEYSTORE_PASSWORD_FILE'].some((k) => env[k]);
  if (fromEnv) try {
    const w = await loadWallet(keyEnv);
    if (w) useWallet(w, keySource(keyEnv).kind === 'keystore' ? 'keystore' : 'env');
  } catch (e) { log.warn(`the wallet did not unlock from the settings: ${e.message}`); }
  if (!wallet && settings.unlockSaved() && keySource(keyEnv).kind === 'keystore') {
    try { useWallet(await openKeystore(keyEnv, settings.readUnlock()), 'keystore'); }
    catch { log.warn('the saved unlock no longer opens the keystore: log in on the page'); settings.clearUnlock(); }
  }
  const locked = () => !wallet && keySource(keyEnv).kind === 'keystore';
  if (locked()) { log.warn('the bot wallet is locked: open the page and log in to start liquidating'); onEvent({ kind: 'locked' }); }

  function applySettings() {
    const before = cfg.rpcUrl;
    Object.assign(cfg, configFrom(derived().env));
    if (wallet && cfg.rpcUrl !== before) { sender = newSender(wallet); bot.setSender(sender); log.info(`RPC changed to ${cfg.rpcUrl}`); }
  }
  const localPaused = () => !!settings.get().paused;
  const syncPause = () => bot.setPaused(localPaused() || relay.paused || withdrawing);
  syncPause();

  // ---- the loop: start (retrying while the RPC is down), then tick; the Telegram link rides along ----
  // NetNet Intel's market context: every minute, in the background (a slow API never holds up a tick)
  let intelBusy = false, intelAt = 0;
  const refreshIntel = () => {
    if (!intel.enabled || intelBusy || Date.now() - intelAt < 60_000) return;
    intelBusy = true; intelAt = Date.now();
    intel.refresh(wallet?.address).then((c) => { if (c && !refreshIntel.ok) { refreshIntel.ok = true; log.info(`NetNet Intel: Loop context loaded (${c.loop?.loans ?? '?'} loans, ${c.liquidations?.day?.n ?? '?'} liquidations in 24h)`); } })
      .catch(() => null).finally(() => { intelBusy = false; });
  };

  // Nothing fails silently: two minutes of failed checks (or of failing to start) is told to Telegram once, and so is
  // the recovery. A bot that stops altogether is noticed on the other side (no check-in for 15 minutes).
  const STALL_MS = 120_000;
  let failingSince = null, stallTold = false;
  const failed = (e) => {
    failingSince ??= Date.now();
    if (!stallTold && Date.now() - failingSince >= STALL_MS) { stallTold = true; onEvent({ kind: 'stalled', error: String(e?.message || e).slice(0, 160), sinceMin: Math.round((Date.now() - failingSince) / 60e3) }); }
  };
  const worked = () => { if (stallTold) onEvent({ kind: 'running', downMin: Math.round((Date.now() - failingSince) / 60e3) }); failingSince = null; stallTold = false; };

  async function loop(signal) {
    let wait = 5_000;
    log.info(`connecting to ${redactRpc(cfg.rpcUrl)}${cfg.rpcUrl === PUBLIC_RPC ? ' (the public RPC)' : ''}${intel.enabled ? ' · loans from NetNet Intel' : ''}`);
    onEvent({ kind: 'started', v: VERSION, live: cfg.live, locked: locked() });   // a restart (reboot, update, crash) is never silent
    while (!signal?.aborted) {
      refreshIntel();
      await bot.refreshWallet().catch((e) => log.debug?.(`wallet read failed: ${e.message}`));   // balances show while it starts
      try { await bot.start(); worked(); break; }
      catch (e) {
        log.warn(`could not start (${e.message}); retrying in ${Math.round(wait / 1000)}s`); failed(e);
        await relay.poll(statusLine()).catch(() => null); await relay.flush().catch(() => null);   // Telegram hears it while it retries
        await sleep(wait, signal); wait = Math.min(60_000, wait * 2);
      }
    }
    let errors = 0;
    while (!signal?.aborted) {
      const t0 = Date.now();
      refreshIntel();
      await relay.poll(statusLine()).catch(() => null);
      syncPause();
      try { await bot.tick(); errors = 0; worked(); }
      catch (e) { errors++; failed(e); if (errors === 1 || errors % 30 === 0) log.warn(`tick failed (${errors} in a row): ${e.message}`); }
      await relay.flush().catch(() => null);
      await sleep(Math.max(200, cfg.tickSeconds * 1000 * (errors > 3 ? 3 : 1) - (Date.now() - t0)), signal);
    }
  }

  // the line Telegram's /liquidator shows
  function statusLine() {
    const st = bot.status(), dayAgo = Date.now() - 86400e3;
    const day = store.history().filter((h) => Date.parse(h.at) > dayAgo);
    return {
      v: VERSION, live: st.live, liveNow: st.liveNow, paused: st.paused, locked: locked(), oraclePaused: st.oraclePaused,
      usdg: st.wallet?.usdg ?? null, eth: st.wallet?.eth ?? null, wsnet: st.wallet?.wsnet ?? null, net: st.wallet?.net ?? null, snet: st.wallet?.snet ?? null,
      open: st.open, hot: st.hot, ready: st.ready, closest: st.closest[0]?.health ?? null,
      liq24h: day.length, repaid24h: Number(day.reduce((a, h) => a + Number(h.repaid || 0), 0).toFixed(2)), error: st.lastError,
    };
  }

  // NetNet Intel's view of the market, and what the bot wallet's tokens are worth at its marks
  function marketView() {
    const c = intel.context;
    if (!intel.enabled) return { enabled: false };
    return { enabled: true, error: intel.lastError, at: c?.at ?? null, loop: c?.loop ?? null, liquidations: c?.liquidations ?? null, value: walletValue(bot.status().wallet, c?.loop) };
  }

  // ---- what the page can do ----
  const api = {
    hasPassword: () => settings.hasPassword(),
    /** First visit: choose the page password. With a keystore already here (made on the command line), its password. */
    async setupPassword(p) {
      if (settings.hasPassword()) throw httpErr(409, 'a password is already set');
      if (typeof p !== 'string' || p.length < 10) throw httpErr(400, 'use at least 10 characters');
      if (keySource(keyEnv).kind === 'keystore' && !wallet) {
        try { useWallet(await openKeystore(keyEnv, p), 'keystore'); } catch { throw httpErr(400, 'a wallet is already here: enter the password it was made with'); }
        settings.set({ backedUp: true });   // made with new-wallet / import-key, which showed the phrase or used the owner's own key
      }
      await settings.setPassword(p); pw = p;
      if (wallet) onEvent({ kind: 'unlocked' });
    },
    async login(p) {
      if (!(await settings.checkPassword(p))) return false;
      pw = p;
      if (locked()) {
        try { useWallet(await openKeystore(keyEnv, p), 'keystore'); log.info('wallet unlocked from the page'); onEvent({ kind: 'unlocked' }); }
        catch { throw httpErr(409, 'the page password no longer opens the keystore (was it replaced?)'); }
      }
      return true;
    },
    logout() { pw = null; },
    checkPassword: (p) => settings.checkPassword(p),

    state() {
      const saved = settings.get(), { fixed } = derived();
      return {
        version: VERSION,
        wallet: { address: wallet?.address ?? pending?.address ?? null, source: walletSource, locked: locked(), backedUp: walletSource === 'env' || !!saved.backedUp,
          pendingBackup: !!pending, exists: keySource(keyEnv).kind !== 'none' },
        settings: {
          gasFloorEth: Number(cfg.gasFloorWei) / 1e18,
        maxRepayUsdg: cfg.maxRepay == null ? null : Number(fmtUsdg(cfg.maxRepay)), reserveUsdg: Number(fmtUsdg(cfg.reserve)), minProfitUsdg: Number(fmtUsdg(cfg.minProfit)),
          allowPartial: cfg.allowPartial, payoutAddress: cfg.payout, rpcUrl: cfg.rpcUrl === undefined ? null : redactRpc(cfg.rpcUrl), customRpc: !!(saved.RPC_URL || env.RPC_URL),
          endpoints: { rpc: PUBLIC_RPC, sequencer: PUBLIC_SEQUENCER, feed: PUBLIC_FEED, feedDelayed: PUBLIC_FEED_DELAYED }, providers: RPC_PROVIDERS, sequencer: !!cfg.sequencerUrl, rpcFallback: cfg.rpcFallback, intel: intel.enabled ? INTEL_API.replace(/^https:\/\//, '') : null,
          logsRpc: !!(saved.LOGS_RPC_URL || env.LOGS_RPC_URL), tickSeconds: cfg.tickSeconds, live: cfg.live, paused: localPaused(), stayUnlocked: settings.unlockSaved(), fixed,
        },
        status: bot.status(),
        market: marketView(),
        telegram: { linked: relay.linked, paused: relay.paused, error: relay.lastError, revoked: relay.revoked, direct: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) },
        history: store.history().slice(-50).reverse(), txs: store.txs().slice(-40).reverse(), events: events.filter((e) => e.kind !== 'tx').slice(-30).reverse(), log: log.recent ? log.recent(60) : [],
      };
    },

    // a new wallet: shown once, saved (encrypted with the page password) only after the owner proves they wrote it down
    createWallet() {
      if (!pw) throw httpErr(401, 'log in again');
      if (keySource(keyEnv).kind !== 'none') throw httpErr(409, 'this bot already has a wallet');
      const w = Wallet.createRandom();
      const check = pickThree(12);
      pending = { wallet: w, check };
      return { address: w.address, phrase: w.mnemonic.phrase, check };
    },
    async confirmWallet(words) {
      if (!pending || !pw) throw httpErr(400, 'make the wallet again');
      const list = pending.wallet.mnemonic.phrase.split(' ');
      const ok = pending.check.every((i) => String(words?.[i] ?? '').trim().toLowerCase() === list[i]);
      if (!ok) throw httpErr(400, 'those words don\'t match: check your copy and try again');
      await writeKeystore(keyEnv, pending.wallet, pw);
      useWallet(pending.wallet, 'keystore'); pending = null;
      settings.set({ backedUp: true });
      log.info(`bot wallet created: ${wallet.address}`);
      return { address: wallet.address };
    },
    cancelWallet() { pending = null; },
    async importWallet(secret) {
      if (!pw) throw httpErr(401, 'log in again');
      if (keySource(keyEnv).kind !== 'none') throw httpErr(409, 'this bot already has a wallet');
      let w;
      try { w = walletFromSecret(secret); } catch (e) { throw httpErr(400, e.message); }
      await writeKeystore(keyEnv, w, pw);
      useWallet(w, 'keystore'); settings.set({ backedUp: true });
      log.info(`bot wallet imported: ${w.address}`);
      return { address: w.address };
    },

    /** Limits, payout and RPC. Changing where funds go needs the password again. */
    async saveSettings(b, password) {
      const patch = {};
      const fixed = derived().fixed;
      const FIELD = { maxRepayUsdg: 'MAX_REPAY_USDG', reserveUsdg: 'RESERVE_USDG', minProfitUsdg: 'MIN_PROFIT_USDG', allowPartial: 'ALLOW_PARTIAL', tickSeconds: 'TICK_SECONDS', rpcUrl: 'RPC_URL', logsRpcUrl: 'LOGS_RPC_URL', payoutAddress: 'PAYOUT_ADDRESS' };
      for (const [k, key] of Object.entries(FIELD)) if (k in b && fixed.includes(key)) delete b[k];   // the environment wins: shown as fixed on the page
      const num = (v, name, min = 0, max = 1e7) => {
        if (v === '' || v == null) return undefined;
        const n = Number(v); if (!(n >= min && n <= max)) throw httpErr(400, `${name} must be between ${min} and ${max}`); return String(n);
      };
      if ('maxRepayUsdg' in b) patch.MAX_REPAY_USDG = num(b.maxRepayUsdg, 'the most one liquidation repays', 1);
      if ('reserveUsdg' in b) patch.RESERVE_USDG = num(b.reserveUsdg, 'the reserve');
      if ('minProfitUsdg' in b) patch.MIN_PROFIT_USDG = num(b.minProfitUsdg, 'the minimum profit', 0, 1e5);
      if ('allowPartial' in b) patch.ALLOW_PARTIAL = b.allowPartial ? '1' : '0';
      if ('tickSeconds' in b) patch.TICK_SECONDS = num(b.tickSeconds, 'the check interval', 1, 60);
      for (const [k, key] of [['rpcUrl', 'RPC_URL'], ['logsRpcUrl', 'LOGS_RPC_URL']]) {
        if (!(k in b)) continue;
        const u = String(b[k] || '').trim();
        if (u && !/^https:\/\/[^\s]+$/.test(u)) throw httpErr(400, 'an RPC address starts with https://');
        patch[key] = u || undefined;
      }
      if ('payoutAddress' in b) {
        if (!(await settings.checkPassword(password))) throw httpErr(401, 'enter the page password to change where funds go');
        const a = String(b.payoutAddress || '').trim();
        if (a) {
          let g; try { g = getAddress(a); } catch { throw httpErr(400, 'that is not a wallet address (0x + 40 characters)'); }
          if (wallet && g.toLowerCase() === wallet.address.toLowerCase()) throw httpErr(400, 'use your main wallet, not the bot\'s own address');
          patch.PAYOUT_ADDRESS = g;
        } else patch.PAYOUT_ADDRESS = undefined;
      }
      // check the result is a valid configuration before saving it
      try { configFrom(effectiveEnv(env, { ...settings.get(), ...patch }).env); } catch (e) { throw httpErr(400, e.message); }
      settings.set(patch); applySettings();
      return api.state().settings;
    },

    /** Live needs a wallet that is backed up and unlocked, and a spending limit; it is confirmed by typing LIVE. */
    setLive(on, confirm) {
      if (derived().fixed.includes('LIVE')) throw httpErr(409, `LIVE=${env.LIVE} is set in the bot's environment, which wins over this page: change it there`);
      if (on) {
        if (confirm !== 'LIVE') throw httpErr(400, 'type LIVE to confirm');
        if (!wallet) throw httpErr(400, 'set up and unlock the bot wallet first');
        if (walletSource !== 'env' && !settings.get().backedUp) throw httpErr(400, 'confirm the recovery phrase first');
        if (cfg.maxRepay == null) throw httpErr(400, 'set the most one liquidation may repay first');
        const w = bot.status().wallet;
        if (!w) throw httpErr(409, 'the bot hasn\'t read the wallet yet: try again in a few seconds');
        const floor = Number(cfg.gasFloorWei) / 1e18;
        if (!(w.eth >= floor)) throw httpErr(400, `the bot wallet needs ETH for gas first: every liquidation pays a little (at least ${floor} ETH; 0.0005 ETH covers about 100)`);
        if (!(w.usdg > Number(fmtUsdg(cfg.reserve)))) throw httpErr(400, 'the bot wallet needs USDG to liquidate with first' + (cfg.reserve > 0n ? ' (more than the reserve you keep)' : ''));
      }
      settings.set({ LIVE: on ? '1' : '0' }); applySettings();
      if (on) bot.freshStart();
      log.info(on ? 'LIVE: liquidations will be sent' : 'dry run: nothing will be sent');
      onEvent({ kind: 'mode', live: on });
      return { live: cfg.live };
    },
    setPaused(p) { settings.set({ paused: !!p }); syncPause(); if (!p) bot.freshStart(); onEvent({ kind: 'pause', paused: !!p, by: 'page' }); return { paused: bot.paused }; },
    async setStayUnlocked(on, password) {
      if (!(await settings.checkPassword(password))) throw httpErr(401, 'wrong password');
      if (on) settings.saveUnlock(password); else settings.clearUnlock();
      return { stayUnlocked: settings.unlockSaved() };
    },

    async pair(code) {
      code = String(code || '').trim();
      if (!TOKEN_RE.test(code)) throw httpErr(400, 'that is not a pairing code from /liquidator in @netnetintel_bot');
      const prev = settings.get().relayToken;
      settings.set({ relayToken: code }); relay.forget();
      const j = await relay.poll(statusLine(), Date.now(), true);
      if (!j) { settings.set({ relayToken: prev }); throw httpErr(400, relay.lastError || 'Telegram did not answer; try again'); }
      relay.report({ kind: 'paired', address: wallet?.address ?? null, live: cfg.live });
      await relay.flush();
      return { linked: true };
    },
    unpair() { settings.set({ relayToken: undefined }); relay.forget(); syncPause(); return { linked: false }; },

    /** Send the bot wallet's funds to the saved payout address — never anywhere else. */
    async withdraw(what, password) {
      if (!(await settings.checkPassword(password))) throw httpErr(401, 'wrong password');
      if (!wallet) throw httpErr(400, 'the wallet is locked');
      const to = cfg.payout;
      if (!to) throw httpErr(400, 'save your main wallet address (where funds go) first');
      if (!['usdg', 'wsnet', 'net', 'snet', 'eth', 'all'].includes(what)) throw httpErr(400, 'choose USDG, wsNET, NET, sNET, ETH or all');
      if (withdrawing) throw httpErr(409, 'a withdrawal is already running');
      withdrawing = true; syncPause();
      try {
        for (let i = 0; i < 300 && bot.busy; i++) await new Promise((r) => setTimeout(r, 100));   // let a liquidation in flight finish
        return await doWithdraw(what, to);
      } finally { withdrawing = false; syncPause(); }
    },
  };
  async function doWithdraw(what, to) {
    const s = sender;
    const out = {};
    const bal = async (token) => BigInt(await rpc.one('eth_call', [{ to: token, data: ERC20.encodeFunctionData('balanceOf', [wallet.address]) }, 'latest']));
    for (const [name, token] of [['usdg', USDG], ['wsnet', WSNET], ['net', NET], ['snet', SNET]]) {
      if (what !== 'all' && what !== name) continue;
      const amount = await bal(token);
      if (amount === 0n) continue;
      const { hash, receipt } = await bot.sendTx('withdraw', { to: token, data: ERC20.encodeFunctionData('transfer', [to, amount]) }, `${fmtTok(amount, name)} ${TOKENS[name].sym} to your main wallet ${short(to)}`);
      if (!receipt || receipt.status !== 1) throw httpErr(502, `the ${TOKENS[name].sym} transfer did not confirm (${EXPLORER_TX}${hash})`);
      out[name] = { amount: fmtTok(amount, name), tx: hash };
    }
    if (what === 'eth' || what === 'all') {
      const balance = await s.balance();
      const fee = await s.feeData();
      const per = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
      const gas = ((await s.estimateGas({ to, value: 1n })) * 3n) / 2n;   // the chain's own figure (L1 costs, a contract wallet), with room
      const value = balance - per * gas * 2n;                               // and twice its cost left behind
      if (value > 0n) {
        const { hash } = await bot.sendTx('withdraw', { to, value, gasLimit: gas }, `${fmtTok(value, 'eth')} ETH to your main wallet ${short(to)}`);
        out.eth = { amount: (Number(value) / 1e18).toFixed(6), tx: hash };
      }
    }
    log.info(`withdrawn to ${to}: ${Object.keys(out).join(', ') || 'nothing to send'}`);
    onEvent({ kind: 'withdraw', to, parts: Object.keys(out) });
    return { to, ...out };
  }

  return { api, loop, bot, cfg, relay, intel, statusLine, get wallet() { return wallet; } };
}

function redactRpc(u) {
  // the page never echoes a provider key back: host only
  try { const x = new URL(u); return `${x.protocol}//${x.host}${x.pathname.length > 1 ? '/…' : ''}`; } catch { return null; }
}
function pickThree(n) {
  const s = new Set();
  while (s.size < 3) s.add(randomInt(0, n));
  return [...s].sort((a, b) => a - b);
}
const sleep = (ms, signal) => new Promise((r) => { const t = setTimeout(r, ms); signal?.addEventListener?.('abort', () => { clearTimeout(t); r(); }, { once: true }); });
export { short, EXPLORER_TX };
