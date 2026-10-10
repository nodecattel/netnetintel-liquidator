// The running bot: the liquidation loop, its wallet (locked until the owner logs in to the local page, unless they
// chose otherwise), the owner's settings, and the Telegram link. server.mjs calls the methods below; nothing here is
// reachable from outside the owner's machine except the relay's own outbound calls.
import { readFileSync } from 'node:fs';
import { JsonRpcProvider, Wallet, getAddress } from 'ethers';
import { randomInt } from 'node:crypto';
import { CHAIN_ID, USDG, WSNET, EXPLORER_TX } from './constants.mjs';
import { configFrom } from './config.mjs';
import { makeRpc, ERC20 } from './chain.mjs';
import { loadWallet, keySource, writeKeystore, openKeystore, walletFromSecret } from './wallet.mjs';
import { makeStore, makeNotify } from './io.mjs';
import { makeBot } from './bot.mjs';
import { makeSettings, effectiveEnv } from './settings.mjs';
import { makeRelay, TOKEN_RE } from './relay.mjs';
import { fmtUsdg, fmtWs } from './math.mjs';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const httpErr = (status, message) => Object.assign(new Error(message), { status });

export function senderOf(wallet, rpcUrl) {
  const provider = new JsonRpcProvider(rpcUrl, { chainId: CHAIN_ID, name: 'robinhood' }, { staticNetwork: true, batchMaxCount: 1 });
  const signer = wallet.connect(provider);
  return {
    address: wallet.address, provider,
    estimateGas: (tx) => signer.estimateGas({ ...tx, from: wallet.address }),
    send: async (tx) => { const r = await signer.sendTransaction({ ...tx, chainId: CHAIN_ID }); return { hash: r.hash, wait: () => r.wait(1, 120_000) }; },
  };
}

export async function makeRunner({ env, log, fetchImpl = fetch, makeSender = senderOf }) {
  const dataDir = env.DATA_DIR || '/data';
  const settings = makeSettings(dataDir);
  const derived = () => effectiveEnv(env, settings.get());
  const cfg = configFrom(derived().env);
  const rpc = makeRpc(() => cfg.rpcUrl, { batchSize: cfg.rpcBatch, fetchImpl });
  const logsRpc = makeRpc(() => cfg.logsRpcUrl, { batchSize: cfg.rpcBatch, fetchImpl });
  const store = makeStore(dataDir);
  const notify = makeNotify(env, log, fetchImpl);
  const relay = makeRelay({ getToken: () => settings.get().relayToken || null, version: VERSION, fetchImpl, log: (m) => log.warn(m) });
  const events = [];   // the last events, for the local page
  const onEvent = (ev) => { events.push(ev); if (events.length > 100) events.shift(); relay.report(ev); };
  const bot = makeBot({ rpc, logsRpc, cfg, store, log, notify, onEvent });

  let wallet = null, walletSource = null, pw = null, pending = null, sender = null, withdrawing = false;
  const keyEnv = { ...env, DATA_DIR: dataDir };
  // one sender for the wallet, shared by the loop and withdrawals (a second signer could reuse a nonce)
  const useWallet = (w, source) => { wallet = w; walletSource = source; sender = w ? makeSender(w, cfg.rpcUrl) : null; bot.setSender(sender); };

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
    if (wallet && cfg.rpcUrl !== before) { sender = makeSender(wallet, cfg.rpcUrl); bot.setSender(sender); }
  }
  const localPaused = () => !!settings.get().paused;
  const syncPause = () => bot.setPaused(localPaused() || relay.paused || withdrawing);
  syncPause();

  // ---- the loop: start (retrying while the RPC is down), then tick; the Telegram link rides along ----
  async function loop(signal) {
    let wait = 5_000;
    while (!signal?.aborted) {
      try { await bot.start(); break; }
      catch (e) { log.warn(`could not start (${e.message}); retrying in ${Math.round(wait / 1000)}s`); await sleep(wait, signal); wait = Math.min(60_000, wait * 2); }
    }
    let errors = 0;
    while (!signal?.aborted) {
      const t0 = Date.now();
      await relay.poll(statusLine()).catch(() => null);
      syncPause();
      try { await bot.tick(); errors = 0; }
      catch (e) { errors++; if (errors === 1 || errors % 30 === 0) log.warn(`tick failed (${errors} in a row): ${e.message}`); }
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
      usdg: st.wallet?.usdg ?? null, eth: st.wallet?.eth ?? null, wsnet: st.wallet?.wsnet ?? null,
      open: st.open, hot: st.hot, ready: st.ready, closest: st.closest[0]?.health ?? null,
      liq24h: day.length, repaid24h: Number(day.reduce((a, h) => a + Number(h.repaid || 0), 0).toFixed(2)), error: st.lastError,
    };
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
          maxRepayUsdg: cfg.maxRepay == null ? null : Number(fmtUsdg(cfg.maxRepay)), reserveUsdg: Number(fmtUsdg(cfg.reserve)), minProfitUsdg: Number(fmtUsdg(cfg.minProfit)),
          allowPartial: cfg.allowPartial, payoutAddress: cfg.payout, rpcUrl: cfg.rpcUrl === undefined ? null : redactRpc(cfg.rpcUrl), customRpc: !!(saved.RPC_URL || env.RPC_URL),
          logsRpc: !!(saved.LOGS_RPC_URL || env.LOGS_RPC_URL), tickSeconds: cfg.tickSeconds, live: cfg.live, paused: localPaused(), stayUnlocked: settings.unlockSaved(), fixed,
        },
        status: bot.status(),
        telegram: { linked: relay.linked, paused: relay.paused, error: relay.lastError, revoked: relay.revoked },
        history: store.history().slice(-50).reverse(), events: events.slice(-30).reverse(), log: log.recent ? log.recent(80) : [],
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
      }
      settings.set({ LIVE: on ? '1' : '0' }); applySettings();
      log.info(on ? 'LIVE: liquidations will be sent' : 'dry run: nothing will be sent');
      onEvent({ kind: 'mode', live: on });
      return { live: cfg.live };
    },
    setPaused(p) { settings.set({ paused: !!p }); syncPause(); onEvent({ kind: 'pause', paused: !!p, by: 'page' }); return { paused: bot.paused }; },
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
      if (!['usdg', 'wsnet', 'eth', 'all'].includes(what)) throw httpErr(400, 'choose USDG, wsNET, ETH or all');
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
      for (const [name, token, fmt] of [['usdg', USDG, fmtUsdg], ['wsnet', WSNET, fmtWs]]) {
        if (what !== 'all' && what !== name) continue;
        const amount = await bal(token);
        if (amount === 0n) continue;
        const tx = await s.send({ to: token, data: ERC20.encodeFunctionData('transfer', [to, amount]) });
        await tx.wait(); out[name] = { amount: fmt(amount), tx: tx.hash };
      }
      if (what === 'eth' || what === 'all') {
        const balance = await s.provider.getBalance(wallet.address);
        const fee = await s.provider.getFeeData();
        const per = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
        const gas = ((await s.estimateGas({ to, value: 1n })) * 3n) / 2n;   // the chain's own figure (L1 costs, a contract wallet), with room
        const value = balance - per * gas * 2n;                               // and twice its cost left behind
        if (value > 0n) { const tx = await s.send({ to, value, gasLimit: gas }); await tx.wait(); out.eth = { amount: (Number(value) / 1e18).toFixed(6), tx: tx.hash }; }
      }
      log.info(`withdrawn to ${to}: ${Object.keys(out).join(', ') || 'nothing to send'}`);
      onEvent({ kind: 'withdraw', to, parts: Object.keys(out) });
      return { to, ...out };
  }

  return { api, loop, bot, cfg, relay, statusLine, get wallet() { return wallet; } };
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
