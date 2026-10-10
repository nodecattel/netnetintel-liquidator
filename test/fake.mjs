// A fake Robinhood Chain for tests: the Loopback market with two borrowers (one past the line: the real 10 Oct 2026
// liquidation's state), the oracle, the IRM, USDG/wsNET balances; and a fake relay.
import { AbiCoder, Interface, getAddress } from 'ethers';
import { MORPHO_IFACE, ERC20 } from '../src/chain.mjs';
import { MORPHO, MARKET_ID, USDG, WSNET, NET, SNET, LLTV, TOPIC_BORROW } from '../src/constants.mjs';

export const enc = (types, vals) => AbiCoder.defaultAbiCoder().encode(types, vals);
export const ORACLE = '0xCDE9599059f8Ae6D6B9F33A0aF7877827ec75F16', IRM = '0x2bd3d5965b26b51814ac95127b2b80dd6ccc0fa1';
export const BAD = getAddress('0x847fa60a65be94e90daff670d69588bf9f2d42f3'), GOOD = getAddress('0x2222222222222222222222222222222222222222');
export const PRICE = 0x25e2545d2a4cb759f62f5c0n, TS = 0x6ac99061;
export const MARKET = [0xf5fd8bc4efn, 0x0def89a96c5155e3n, 0xc18987993en, 0x0aed7c70b24aa8ffn, 0x6ac99060n, 0n];
export const POS = { [BAD]: [0n, 0xaf7e4472bb2an, 0x062c14a2a08dc62en], [GOOD]: [0n, 0xaf7e4472bb2an, 0x062c14a2a08dc62en * 3n] };
const ERRORS = new Interface(['function Error(string)']);

// Balances are read from `o` on every call, so a test can change them between reads (a deposit, funds moved).
export function fakeAnswer(o = {}) {
  const seen = [];
  const answer = (c) => {
    const { usdg = 1000n * 10n ** 6n, eth = 10n ** 16n, allowance = 0n, priceReverts = false, liquidateReason = null, wsnet = 0n, net = 0n, snet = 0n } = o;
    if (c.method === 'eth_blockNumber') return { result: '0x' + (o.nodeHead ?? 0x50b0000).toString(16) };
    if (c.method === 'eth_getBlockByNumber') return { result: { number: '0x50b0000', timestamp: '0x' + TS.toString(16) } };
    if (c.method === 'eth_getBalance') return { result: '0x' + eth.toString(16) };
    if (c.method === 'eth_gasPrice') return { result: '0x131a230' };
    if (c.method === 'eth_getLogs') return { result: [BAD, GOOD].map((a) => ({ topics: [TOPIC_BORROW, MARKET_ID, '0x' + a.slice(2).toLowerCase().padStart(64, '0'), '0x' + '0'.repeat(64)] })) };
    if (c.method !== 'eth_call') return { error: { message: 'unexpected ' + c.method } };
    const { to, data, from } = c.params[0], sel = data.slice(0, 10), t = to.toLowerCase();
    seen.push({ to: t, sel, from, data });
    if (t === MORPHO.toLowerCase()) {
      if (sel === MORPHO_IFACE.getFunction('idToMarketParams').selector) return { result: enc(['address', 'address', 'address', 'address', 'uint256'], [USDG, WSNET, ORACLE, IRM, LLTV]) };
      if (sel === MORPHO_IFACE.getFunction('market').selector) return { result: enc(Array(6).fill('uint128'), MARKET) };
      if (sel === MORPHO_IFACE.getFunction('position').selector) return { result: enc(['uint256', 'uint128', 'uint128'], POS[getAddress('0x' + data.slice(-40))] ?? [0n, 0n, 0n]) };
      if (sel === MORPHO_IFACE.getFunction('liquidate').selector)
        return liquidateReason ? { error: { code: 3, message: 'execution reverted', data: ERRORS.encodeFunctionData('Error', [liquidateReason]) } } : { result: enc(['uint256', 'uint256'], [1n, 1n]) };
    }
    if (t === ORACLE.toLowerCase()) return priceReverts ? { error: { code: 3, message: 'execution reverted' } } : { result: enc(['uint256'], [PRICE]) };
    if (t === IRM.toLowerCase()) return { result: enc(['uint256'], [0x2d95795f6n]) };
    if (t === USDG.toLowerCase() && sel === ERC20.getFunction('balanceOf').selector) return o.usdgError ? { error: { code: -32005, message: 'rate limited' } } : { result: enc(['uint256'], [usdg]) };
    if (t === USDG.toLowerCase() && sel === ERC20.getFunction('allowance').selector) return allowance === 'unreadable' ? { error: { code: -32005, message: 'rate limited' } } : { result: enc(['uint256'], [allowance]) };
    if (t === WSNET.toLowerCase()) return { result: enc(['uint256'], [wsnet]) };
    if (t === NET.toLowerCase()) return { result: enc(['uint256'], [net]) };
    if (t === SNET.toLowerCase()) return { result: enc(['uint256'], [snet]) };
    return { error: { message: 'unknown call' } };
  };
  return { answer, seen };
}
export function fakeRpc(opts) {
  const { answer, seen } = fakeAnswer(opts);
  const rpc = async (calls) => calls.map(answer);
  rpc.one = async (method, params) => { const r = answer({ method, params }); if (r.error) throw Object.assign(new Error(r.error.message), r.error); return r.result; };
  return { rpc, seen };
}
/** fetch for the runner: JSON-RPC to any https host, the relay, and Telegram. */
export function fakeFetch(opts = {}) {
  const { answer } = fakeAnswer(opts);
  const relayCalls = [];
  const intelCalls = [];
  const fn = async (url, init = {}) => {
    if (String(url).includes('/api/v1/')) {      // NetNet Intel's API: the open loans and the market around them
      intelCalls.push(String(url));
      if (opts.intel === false) return new Response(JSON.stringify({ error: 'down' }), { status: 503 });
      if (String(url).includes('/loop/liquidations')) return new Response(JSON.stringify(INTEL_LIQS));
      return new Response(JSON.stringify(intelLoop(opts.intelLoans ?? [BAD, GOOD])));
    }
    const body = JSON.parse(init.body);
    if (String(url).includes('liquidatorRelay')) {
      relayCalls.push(body);
      if (body.token !== opts.relayToken) return new Response(JSON.stringify({ error: 'unknown pairing code' }), { status: 401 });
      return new Response(JSON.stringify({ ok: true, pause: !!opts.relayPause, pollSec: 60 }));
    }
    const arr = Array.isArray(body) ? body : [body];
    const out = arr.map((c) => ({ jsonrpc: '2.0', id: c.id, ...answer(c) }));
    return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]));
  };
  fn.relayCalls = relayCalls; fn.intelCalls = intelCalls;
  return fn;
}
// what netnetintel.com/api/v1/loop and /loop/liquidations answer (trimmed to the fields the bot reads)
export const intelLoop = (accounts) => ({ block: 0x50b0000, asOf: '2026-10-10T03:40:51.961Z', matched: accounts.length,
  summary: { positions: accounts.length, liquidatableNow: 1, byStatus: { 'AT RISK': { loans: 1 }, 'WIND DOWN': { loans: 0 } }, totalDebtUsdg: 855000, borrowApy: 0.12 },
  mark: { twap: 182.73, spot: 199.83, stakingIndex: 3.43, oraclePerWsNet: 616.9, marketPerWsNet: 685.4, floorTwap: 200.13, paused: false },
  loans: accounts.map((a, i) => ({ account: a.toLowerCase(), debtUsdg: 100 + i, health: 0.97 + i })) });
export const INTEL_LIQS = { windows: { h24: { n: 12, repaid: 7969.65, profitOracle: 1010.24, liquidators: 4 } },
  leaders: { total: 58000, liquidators: 7, rows: [{ liquidator: '0x72512e63c0c70797b96902228fa8acc1211b7cee', n: 17, repaid: 43536.36, share: 0.75 }] },
  recent: [{ ts: 1791595505, repaid: 2492.19, liquidator: '0x3586aa1db9523bb223916b8ec0405261c8a625e1', tx: '0xb285e901ccb3fdf8f8194a24514cda12aeafb1e77d3c86c096851737c941ff7d' }] };
export function fakeSender(address) {
  const sent = [];
  return {
    sent, address,
    estimateGas: async () => 300_000n,
    send: async (tx) => { sent.push(tx); return { hash: '0x' + String(sent.length).padStart(64, '0'), wait: async () => ({ status: 1, logs: [] }) }; },
  };
}
export const quiet = { info() {}, warn() {}, error() {}, debug: null, recent: () => [] };
