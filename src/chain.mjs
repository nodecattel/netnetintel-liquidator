// Chain reads over plain JSON-RPC, batched: the market, its oracle and rate, the wallet's balances, positions, and the
// borrowers (every onBehalf of a Borrow on the market). Writes go through ethers in bot.mjs.
import { Interface, AbiCoder, getAddress } from 'ethers';
import { MORPHO, MARKET_ID, TOPIC_BORROW, USDG, WSNET } from './constants.mjs';

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

// url: a string, or a function returning the current one (the local page can change the RPC while the bot runs)
export function makeRpc(url, { fetchImpl = fetch, batchSize = 40, timeoutMs = 15000 } = {}) {
  let id = 0;
  async function batch(calls) {
    const body = calls.map((c) => ({ jsonrpc: '2.0', id: ++id, method: c.method, params: c.params }));
    const res = await fetchImpl(typeof url === 'function' ? url() : url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const arr = await res.json();
    const byId = new Map((Array.isArray(arr) ? arr : [arr]).map((r) => [r.id, r]));
    return body.map((b) => byId.get(b.id) || { error: { message: 'no answer' } });
  }
  async function rpc(calls) {
    const out = [];
    for (let i = 0; i < calls.length; i += batchSize) out.push(...(await batch(calls.slice(i, i + batchSize))));
    return out;
  }
  rpc.one = async (method, params) => { const [r] = await batch([{ method, params }]); if (r.error) throw rpcError(r.error); return r.result; };
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

/** One tick's reads in one round trip: block, market, oracle price, wallet balances, and the positions asked for.
 *  The IRM's rate needs the market tuple, so it is a second, single call. */
export async function readTick(rpc, params, me, borrowers, { rate: knownRate = null } = {}) {
  const calls = [
    { method: 'eth_getBlockByNumber', params: ['latest', false] },
    call(MORPHO, MORPHO_IFACE.encodeFunctionData('market', [MARKET_ID])),
    call(params.oracle, ORACLE.encodeFunctionData('price', [])),
    { method: 'eth_gasPrice', params: [] },
  ];
  if (me) calls.push(call(USDG, ERC20.encodeFunctionData('balanceOf', [me])), call(USDG, ERC20.encodeFunctionData('allowance', [me, MORPHO])),
    call(WSNET, ERC20.encodeFunctionData('balanceOf', [me])), { method: 'eth_getBalance', params: [me, 'latest'] });
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
  const wallet = me ? {
    usdg: ok(r[4]) ? BigInt(r[4].result) : 0n, allowance: ok(r[5]) ? BigInt(r[5].result) : null,   // null: unread (never treated as 0)
    wsnet: ok(r[6]) ? BigInt(r[6].result) : 0n, eth: r[7]?.result ? BigInt(r[7].result) : 0n,
  } : null;
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
    const [r] = await rpc([{ method: 'eth_getLogs', params: [{ address: MORPHO, topics: [TOPIC_BORROW, MARKET_ID], fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16) }] }]);
    if (r.error || !Array.isArray(r.result)) {
      if (step <= minRange) throw new Error(`eth_getLogs refused ${a}-${b}: ${r.error?.message || 'no result'}`);
      step = Math.max(minRange, Math.floor(step / 2));
      continue;
    }
    for (const log of r.result) if (log.topics?.[2]) found.add(getAddress('0x' + log.topics[2].slice(26)));
    onProgress?.(b, found.size);
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
