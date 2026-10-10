// NetNet Intel's public API (netnetintel.com/api/v1), read-only. The bot uses it for two things:
//   1. a head start: the open Loop loans, so it watches them within seconds instead of after a scan of the whole chain
//      (the scan still runs, in the background, and finds anything the API missed);
//   2. context for the page: the Loop market (NET price, the wsNET mark, loans at risk), the last day's liquidations and
//      who took them, and what the bot wallet's tokens are worth.
// Nothing here decides a transaction: health, amounts and balances are read from the chain before anything is sent.
// Turn it off with INTEL_API=off; nothing about the bot is sent to the API.
import { getAddress } from 'ethers';
import { INTEL_API } from './constants.mjs';

const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

export function intelBase(env) {
  const v = String(env.INTEL_API ?? '').trim();
  if (/^(off|0|false|no)$/i.test(v)) return null;
  if (!v) return INTEL_API;
  if (!/^https:\/\/[^\s]+$/.test(v)) throw new Error('INTEL_API must be an https:// address, or off');
  return v.replace(/\/+$/, '');
}

export function makeIntel({ base = INTEL_API, version = '?', fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let ctx = null, lastError = null, lastAt = 0;
  async function get(path) {
    const res = await fetchImpl(base + path, { headers: { accept: 'application/json', 'user-agent': `netnet-liquidator/${version}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`NetNet Intel API: HTTP ${res.status} on ${path.split('?')[0]}`);
    return res.json();
  }
  /** The open loans, riskiest first (up to 200: every open loan today). Addresses only; the chain gives the rest. */
  async function loans() {
    const j = await get('/loop?sort=health&limit=200');
    const accounts = [];
    for (const l of j?.loans || []) if (isAddr(l?.account) && (l.debtUsdg ?? 0) > 0) accounts.push(getAddress(l.account.toLowerCase()));
    return { block: num(j?.block), matched: num(j?.matched), accounts };
  }
  /** The market around the bot, for the page and the status line. Never throws: the last good read stands. */
  async function refresh(me = null) {
    if (!base) return null;
    const [loop, liqs] = await Promise.allSettled([get('/loop?sort=health&limit=5'), get('/loop/liquidations?window=h24&leaders=d7')]);
    if (loop.status === 'rejected' && liqs.status === 'rejected') { lastError = loop.reason?.message || 'unreachable'; return ctx; }
    lastError = loop.status === 'rejected' ? loop.reason?.message : liqs.status === 'rejected' ? liqs.reason?.message : null;
    const L = loop.status === 'fulfilled' ? loop.value : null, Q = liqs.status === 'fulfilled' ? liqs.value : null;
    const next = { ...(ctx || {}), at: Date.now() };
    if (L) {
      const mk = L.mark || {}, sm = L.summary || {}, by = sm.byStatus || {};
      next.loop = {
        block: num(L.block), asOf: L.asOf ?? null,
        loans: num(sm.positions), liquidatableNow: num(sm.liquidatableNow), atRisk: num(by['AT RISK']?.loans), windDown: num(by['WIND DOWN']?.loans),
        debtUsdg: num(sm.totalDebtUsdg), borrowApy: num(sm.borrowApy),
        twap: num(mk.twap), spot: num(mk.spot), index: num(mk.stakingIndex), wsnetOracle: num(mk.oraclePerWsNet), wsnetMarket: num(mk.marketPerWsNet),
        floorTwap: num(mk.floorTwap), oraclePaused: !!mk.paused,
      };
    }
    if (Q) {
      const d = Q.windows?.h24 || {}, rows = Q.leaders?.rows || [];
      const mine = me ? rows.findIndex((r) => String(r.liquidator).toLowerCase() === me.toLowerCase()) : -1;
      const last = Q.recent?.[0];
      next.liquidations = {
        day: { n: num(d.n), repaid: num(d.repaid), profitOracle: num(d.profitOracle), liquidators: num(d.liquidators) },
        leaders: rows.slice(0, 3).map((r) => ({ liquidator: isAddr(r.liquidator) ? r.liquidator : null, n: num(r.n), repaid: num(r.repaid), share: num(r.share) })),
        week: { total: num(Q.leaders?.total), liquidators: num(Q.leaders?.liquidators) },
        mine: mine >= 0 ? { rank: mine + 1, n: num(rows[mine].n), repaid: num(rows[mine].repaid), share: num(rows[mine].share) } : null,
        last: last ? { ts: num(last.ts), repaid: num(last.repaid), liquidator: isAddr(last.liquidator) ? last.liquidator : null, tx: /^0x[0-9a-f]{64}$/i.test(last.tx || '') ? last.tx : null } : null,
      };
    }
    ctx = next; lastAt = Date.now();
    return ctx;
  }
  return {
    get enabled() { return !!base; },
    get context() { return ctx; },
    get lastError() { return lastError; },
    get lastAt() { return lastAt; },
    loans, refresh,
  };
}

/** What the wallet's tokens are worth at NetNet Intel's marks (USD; ETH is left out: no ETH price here). */
export function walletValue(w, loop) {
  if (!w) return null;
  const parts = { usdg: w.usdg, wsnet: w.wsnet != null && loop?.wsnetMarket ? w.wsnet * loop.wsnetMarket : null,
    net: w.net != null && loop?.spot ? w.net * loop.spot : null, snet: w.snet != null && loop?.spot ? w.snet * loop.spot : null };
  const vals = Object.values(parts).filter((v) => v != null);
  return { ...parts, total: vals.length ? vals.reduce((a, b) => a + b, 0) : null };
}
