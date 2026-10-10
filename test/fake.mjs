// A fake Robinhood Chain for tests: the Loopback market with two borrowers (one past the line: the real 10 Oct 2026
// liquidation's state), the oracle, the IRM, USDG/wsNET balances; and a fake relay.
import { AbiCoder, Interface, getAddress } from 'ethers';
import { MORPHO_IFACE, ERC20 } from '../src/chain.mjs';
import { MORPHO, MARKET_ID, USDG, WSNET, LLTV, TOPIC_BORROW } from '../src/constants.mjs';

export const enc = (types, vals) => AbiCoder.defaultAbiCoder().encode(types, vals);
export const ORACLE = '0xCDE9599059f8Ae6D6B9F33A0aF7877827ec75F16', IRM = '0x2bd3d5965b26b51814ac95127b2b80dd6ccc0fa1';
export const BAD = getAddress('0x847fa60a65be94e90daff670d69588bf9f2d42f3'), GOOD = getAddress('0x2222222222222222222222222222222222222222');
export const PRICE = 0x25e2545d2a4cb759f62f5c0n, TS = 0x6ac99061;
export const MARKET = [0xf5fd8bc4efn, 0x0def89a96c5155e3n, 0xc18987993en, 0x0aed7c70b24aa8ffn, 0x6ac99060n, 0n];
export const POS = { [BAD]: [0n, 0xaf7e4472bb2an, 0x062c14a2a08dc62en], [GOOD]: [0n, 0xaf7e4472bb2an, 0x062c14a2a08dc62en * 3n] };
const ERRORS = new Interface(['function Error(string)']);

export function fakeAnswer({ usdg = 1000n * 10n ** 6n, allowance = 0n, priceReverts = false, liquidateReason = null } = {}) {
  const seen = [];
  const answer = (c) => {
    if (c.method === 'eth_blockNumber') return { result: '0x50b0000' };
    if (c.method === 'eth_getBlockByNumber') return { result: { number: '0x50b0000', timestamp: '0x' + TS.toString(16) } };
    if (c.method === 'eth_getBalance') return { result: '0x' + (10n ** 16n).toString(16) };
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
    if (t === USDG.toLowerCase() && sel === ERC20.getFunction('balanceOf').selector) return { result: enc(['uint256'], [usdg]) };
    if (t === USDG.toLowerCase() && sel === ERC20.getFunction('allowance').selector) return allowance === 'unreadable' ? { error: { code: -32005, message: 'rate limited' } } : { result: enc(['uint256'], [allowance]) };
    if (t === WSNET.toLowerCase()) return { result: enc(['uint256'], [0n]) };
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
  const fn = async (url, init) => {
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
  fn.relayCalls = relayCalls;
  return fn;
}
export function fakeSender(address) {
  const sent = [];
  return {
    sent, address,
    estimateGas: async () => 300_000n,
    send: async (tx) => { sent.push(tx); return { hash: '0x' + String(sent.length).padStart(64, '0'), wait: async () => ({ status: 1, logs: [] }) }; },
  };
}
export const quiet = { info() {}, warn() {}, error() {}, recent: () => [] };
