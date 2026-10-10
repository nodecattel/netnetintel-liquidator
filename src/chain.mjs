// Chain reads over plain JSON-RPC, batched: the market, its oracle and rate, the wallet's balances, positions, and the
// borrowers (every onBehalf of a Borrow on the market). Writes go through ethers in bot.mjs.
import { Interface, AbiCoder, getAddress } from 'ethers';
import { MORPHO, MARKET_ID, TOPIC_BORROW, USDG, WSNET, NET, SNET } from './constants.mjs';

export const MORPHO_IFACE = new Interface([
  'function idToMarketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)',
  'function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
  'function position(bytes32, address) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
  'function liquidate((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, address borrower, uint256 seizedAssets, uint256 repaidShares, bytes data) returns (uint256, uint256)',
  'event Liquidate(bytes32 indexed id, address indexed caller, address indexed borrower, uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets, uint256 badDebtAssets, uint256 badDebtShares)',
]);
const IRM = new Interface(['function borrowRateView((address,address,address,address,uint256), (uint128,uint128,uint128,uint128,uint128,uint128)) view returns (uint256)']);
const ORACLE = new Interface(['function price() view returns (uint256)']);
export const ERC20 = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
  'function transfer(address, uint256) returns (bool)',
]);

// url: a string, a list (the first that answers wins: your own RPC, then the public one), or a function returning either
// (the local page can change the RPC while the bot runs). A node that fails at the transport level (down, HTTP error,
// timeout) is skipped for SKIP_MS and the next one answers; JSON-RPC errors are answers and pass through.
const SKIP_MS = 30_000;
export function makeRpc(url, { fetchImpl = fetch, batchSize = 40, timeoutMs = 15000, onFallback = () => {} } = {}) {
  let id = 0;
  const down = new Map();                                    // url → until when it is skipped
  const stats = { ms: null, host: null, fallback: false, calls: 0, errors: 0, lastError: null };
  const hostOf = (u) => { try { return new URL(u).host; } catch { return '?'; } };
  const urls = () => { const v = typeof url === 'function' ? url() : url; return [...new Set((Array.isArray(v) ? v : [v]).filter(Boolean))]; };
  async function post(u, body) {
    const t0 = Date.now();
    const res = await fetchImpl(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    // a JSON-RPC answer is an answer whatever its HTTP status (QuickNode says "eth_getLogs is limited to a 10,000
    // range" with a 413): the caller sees the error and adapts. Only a node that doesn't answer in JSON-RPC is "down".
    let arr = null;
    try { arr = await res.json(); } catch { arr = null; }
    const rpcShaped = arr && (Array.isArray(arr) || typeof arr === 'object') && (Array.isArray(arr) ? arr.every((x) => x && x.jsonrpc) : !!arr.jsonrpc);
    if (!rpcShaped || res.status === 429 || res.status >= 500 && !(arr && arr.error))
      throw new Error(res.status === 429 || res.status === 403 ? `${hostOf(u)} is rate-limiting (HTTP ${res.status})` : `HTTP ${res.status} from ${hostOf(u)}`);
    // one object for a batch: a refusal of the whole batch (QuickNode answers a batch it won't run with one error)
    if (!Array.isArray(arr)) arr = body.length === 1 && !arr.error ? [arr] : body.map((b) => ({ jsonrpc: '2.0', id: b.id, ...(body.length === 1 ? arr : { error: arr.error || { message: 'error' } }), }));
    const ms = Date.now() - t0;
    stats.ms = stats.ms == null ? ms : Math.round(stats.ms * 0.8 + ms * 0.2);
    return arr;
  }
  async function batch(calls) {
    const body = calls.map((c) => ({ jsonrpc: '2.0', id: ++id, method: c.method, params: c.params }));
    const list = urls(), now = Date.now();
    const order = [...list.filter((u) => !(down.get(u) > now)), ...list.filter((u) => down.get(u) > now)];   // skipped nodes last, never none
    let lastErr = null;
    for (const [i, u] of order.entries()) {
      try {
        const arr = await post(u, body);
        stats.calls++; stats.host = hostOf(u);
        const fb = u !== list[0];
        if (fb !== stats.fallback) { stats.fallback = fb; onFallback(fb, hostOf(list[0]), stats.host, lastErr?.message); }
        if (!fb) down.delete(u);
        const byId = new Map((Array.isArray(arr) ? arr : [arr]).map((r) => [r.id, r]));
        return body.map((b) => byId.get(b.id) || { error: { message: 'no answer' } });
      } catch (e) {
        lastErr = e; stats.errors++; stats.lastError = `${hostOf(u)}: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`;
        down.set(u, Date.now() + SKIP_MS);
        if (i === order.length - 1) throw new Error(`RPC ${stats.lastError}`);
      }
    }
    throw lastErr || new Error('no RPC set');
  }
  // together: one batch whatever the batch size, so one node answers every call (a head and the logs up to it)
  async function rpc(calls, { together = false } = {}) {
    if (together) return batch(calls);
    const out = [];
    for (let i = 0; i < calls.length; i += batchSize) out.push(...(await batch(calls.slice(i, i + batchSize))));
    return out;
  }
  rpc.one = async (method, params) => { const [r] = await batch([{ method, params }]); if (r.error) throw rpcError(r.error); return r.result; };
  rpc.stats = () => ({ ...stats });
  return rpc;
}
export function rpcError(e) {
  const err = new Error(e?.message || 'RPC error');
  err.data = e?.data; err.code = e?.code;
  return err;
}

const call = (to, data, from) => ({ method: 'eth_call', params: [{ to, data, ...(from ? { from } : {}) }, 'latest'] });
const ok = (r) => r && !r.error && r.result && r.result !== '0x';

export async function readParams(rpc) {
  const r = await rpc.one('eth_call', [{ to: MORPHO, data: MORPHO_IFACE.encodeFunctionData('idToMarketParams', [MARKET_ID]) }, 'latest']);
  const [loanToken, collateralToken, oracle, irm, lltv] = MORPHO_IFACE.decodeFunctionResult('idToMarketParams', r);
  return { loanToken, collateralToken, oracle, irm, lltv };
}
export const paramsTuple = (p) => [p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv];

// The bot wallet: ETH for gas, USDG to bid with and Morpho's allowance, the wsNET it seized, and any NET or sNET
// sent to it. A value that didn't read is null, never 0: the page shows it as unread and the bot doesn't bid on it.
const WALLET_TOKENS = [['usdg', USDG], ['wsnet', WSNET], ['net', NET], ['snet', SNET]];
export function walletCalls(me) {
  return [
    { method: 'eth_getBalance', params: [me, 'latest'] },
    call(USDG, ERC20.encodeFunctionData('allowance', [me, MORPHO])),
    ...WALLET_TOKENS.map(([, t]) => call(t, ERC20.encodeFunctionData('balanceOf', [me]))),
  ];
}
const big = (x) => (x && !x.error && typeof x.result === 'string' && /^0x[0-9a-f]*$/i.test(x.result) ? BigInt(x.result === '0x' ? 0 : x.result) : null);
export function parseWallet(r) {
  const w = { eth: big(r[0]), allowance: big(r[1]) };
  WALLET_TOKENS.forEach(([k], i) => { w[k] = big(r[2 + i]); });
  return w;
}
/** The wallet alone (before the market is loaded, and while the bot is starting): one round trip. */
export async function readWallet(rpc, me) {
  const calls = [{ method: 'eth_blockNumber', params: [] }, { method: 'eth_gasPrice', params: [] }, ...walletCalls(me)];
  const r = await rpc(calls);
  return { block: r[0]?.result ? parseInt(r[0].result, 16) : null, gasPrice: big(r[1]), wallet: parseWallet(r.slice(2)) };
}

/** One tick's reads in one round trip: block, market, oracle price, wallet balances, and the positions asked for.
 *  The IRM's rate needs the market tuple, so it is a second, single call. */
export async function readTick(rpc, params, me, borrowers, { rate: knownRate = null } = {}) {
  const calls = [
    { method: 'eth_getBlockByNumber', params: ['latest', false] },
    call(MORPHO, MORPHO_IFACE.encodeFunctionData('market', [MARKET_ID])),
    call(params.oracle, ORACLE.encodeFunctionData('price', [])),
    { method: 'eth_gasPrice', params: [] },
  ];
  const wbase = calls.length;
  if (me) calls.push(...walletCalls(me));
  const base = calls.length;
  for (const b of borrowers) calls.push(call(MORPHO, MORPHO_IFACE.encodeFunctionData('position', [MARKET_ID, b])));
  const r = await rpc(calls);
  const block = r[0]?.result ? { number: parseInt(r[0].result.number, 16), timestamp: parseInt(r[0].result.timestamp, 16) } : null;
  if (!ok(r[1])) throw new Error('Morpho did not answer market()');
  const mk = MORPHO_IFACE.decodeFunctionResult('market', r[1].result);
  const market = { totalSupplyAssets: mk[0], totalSupplyShares: mk[1], totalBorrowAssets: mk[2], totalBorrowShares: mk[3], lastUpdate: mk[4], fee: mk[5] };
  // the oracle reverts while its guard holds (pool far under the TWAP): no price, no liquidations
  const price = ok(r[2]) ? BigInt(r[2].result) : null;
  const gasPrice = r[3]?.result ? BigInt(r[3].result) : null;
  const wallet = me ? parseWallet(r.slice(wbase, base)) : null;
  const positions = new Map();
  borrowers.forEach((b, i) => {
    const x = r[base + i];
    if (!ok(x)) return;
    const p = MORPHO_IFACE.decodeFunctionResult('position', x.result);
    positions.set(b, { borrowShares: p[1], collateral: p[2] });
  });
  let rate = knownRate;
  if (knownRate == null) try {
    const data = IRM.encodeFunctionData('borrowRateView', [paramsTuple(params), [market.totalSupplyAssets, market.totalSupplyShares, market.totalBorrowAssets, market.totalBorrowShares, market.lastUpdate, market.fee]]);
    rate = BigInt(await rpc.one('eth_call', [{ to: params.irm, data }, 'latest']));
  } catch { rate = null; /* unread: the bot re-reads it next tick */ }
  return { block, market, price, rate, gasPrice, wallet, positions };
}

/** Borrowers from Borrow events on the market, from `from` to `to`, in ranges that halve when the RPC refuses. */
export async function scanBorrowers(rpc, from, to, { range = 2_000_000, minRange = 5_000, onProgress } = {}) {
  const found = new Set();
  let a = from, step = range;
  while (a <= to) {
    const b = Math.min(to, a + step - 1);
    // the node's head in the same batch: one node answers both, and a node that hasn't reached the range's end yet
    // (it would return a short list, not an error) is refused, so no Borrow is ever skipped
    const [h, r] = await rpc([{ method: 'eth_blockNumber', params: [] }, { method: 'eth_getLogs', params: [{ address: MORPHO, topics: [TOPIC_BORROW, MARKET_ID], fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16) }] }], { together: true });
    const nodeHead = h?.result ? parseInt(h.result, 16) : null;
    if (nodeHead == null || nodeHead < b) throw new Error(`the RPC node is behind (its block ${nodeHead ?? '?'}, asked up to ${b})`);
    if (r.error || !Array.isArray(r.result)) {
      if (step <= minRange) throw new Error(`eth_getLogs refused ${a}-${b}: ${r.error?.message || 'no result'}`);
      step = Math.max(minRange, Math.floor(step / 2));
      continue;
    }
    const added = [];
    for (const log of r.result) if (log.topics?.[2]) { const x = getAddress('0x' + log.topics[2].slice(26)); if (!found.has(x)) { found.add(x); added.push(x); } }
    onProgress?.(b, found.size, added);
    a = b + 1;
  }
  return found;
}

/** Simulate a call from `from`; null on success, else the revert reason. */
export async function simulate(rpc, from, to, data) {
  const [r] = await rpc([{ method: 'eth_call', params: [{ from, to, data }, 'latest'] }]);
  if (!r.error) return null;
  return revertReason(r.error);
}
export function revertReason(e) {
  const data = typeof e?.data === 'string' ? e.data : e?.data?.data;
  if (typeof data === 'string' && data.startsWith('0x08c379a0')) {
    try { return AbiCoder.defaultAbiCoder().decode(['string'], '0x' + data.slice(10))[0]; } catch { /* fall through */ }
  }
  return e?.message || 'reverted';
}
