// The loop against a fake chain: borrowers found from Borrow logs, a liquidatable loan bid on with Morpho's math,
// dry run vs live, the approval, a paused oracle, a healthy loan left alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Interface, getAddress } from 'ethers';
import { makeBot } from '../src/bot.mjs';
import { MORPHO_IFACE, ERC20 } from '../src/chain.mjs';
import { MORPHO, MARKET_ID, USDG, WSNET, LLTV, TOPIC_BORROW } from '../src/constants.mjs';

const enc = (types, vals) => AbiCoder.defaultAbiCoder().encode(types, vals);
const ORACLE = '0xCDE9599059f8Ae6D6B9F33A0aF7877827ec75F16', IRM = '0x2bd3d5965b26b51814ac95127b2b80dd6ccc0fa1';
const ME = getAddress('0x1111111111111111111111111111111111111111');
const BAD = getAddress('0x847fa60a65be94e90daff670d69588bf9f2d42f3'), GOOD = getAddress('0x2222222222222222222222222222222222222222');
const PRICE = 0x25e2545d2a4cb759f62f5c0n, TS = 0x6ac99061;
const MARKET = [0xf5fd8bc4efn, 0x0def89a96c5155e3n, 0xc18987993en, 0x0aed7c70b24aa8ffn, 0x6ac99060n, 0n];
const POS = { [BAD]: [0n, 0xaf7e4472bb2an, 0x062c14a2a08dc62en], [GOOD]: [0n, 0xaf7e4472bb2an, 0x062c14a2a08dc62en * 3n] };
const ERRORS = new Interface(['function Error(string)']);

function fakeChain({ usdg = 1000n * 10n ** 6n, allowance = 0n, priceReverts = false, liquidateReason = null } = {}) {
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
      if (sel === MORPHO_IFACE.getFunction('position').selector) {
        const who = getAddress('0x' + data.slice(-40));
        return { result: enc(['uint256', 'uint128', 'uint128'], POS[who] ?? [0n, 0n, 0n]) };
      }
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
  const rpc = async (calls) => calls.map(answer);
  rpc.one = async (method, params) => { const r = answer({ method, params }); if (r.error) throw Object.assign(new Error(r.error.message), r.error); return r.result; };
  return { rpc, seen };
}
function fakeSender() {
  const sent = [];
  return {
    sent, address: ME,
    estimateGas: async () => 300_000n,
    send: async (tx) => { sent.push(tx); return { hash: '0x' + String(sent.length).padStart(64, '0'), wait: async () => ({ status: 1, logs: [] }) }; },
  };
}
const quiet = { info() {}, warn() {}, error() {} };
const memStore = () => { let s = { cursor: null, borrowers: [], history: [] }; return { get cursor() { return s.cursor; }, borrowers: () => s.borrowers, history: () => s.history, setScan(c, b) { s.cursor = c; s.borrowers = [...b]; }, record(e) { s.history.push(e); }, heartbeat() {} }; };
const cfg = (x = {}) => ({ live: false, tickSeconds: 2, fullEverySeconds: 30, hotHealth: 1.1, minProfit: 250_000n, reserve: 0n, maxRepay: null, allowPartial: true, payout: null, gasFloorWei: 0n, logRange: 1_000_000, minLogRange: 1000, ...x });

test('start: finds borrowers from Borrow logs and checks the market is the expected one', async () => {
  const { rpc } = fakeChain();
  const bot = makeBot({ rpc, cfg: cfg(), store: memStore(), log: quiet });
  await bot.start();
  assert.deepEqual([...bot.known].sort(), [BAD, GOOD].sort());
});

test('dry run: the liquidatable loan is simulated, nothing is sent; the healthy one is left alone', async () => {
  const { rpc, seen } = fakeChain();
  const sender = fakeSender();
  const bot = makeBot({ rpc, sender, cfg: cfg({ live: false }), store: memStore(), log: quiet });
  await bot.start();
  const r = await bot.tick();
  assert.equal(r.ready, 1);
  assert.equal(r.results[0].dry, true);
  assert.equal(r.results[0].borrower, BAD);
  // the real liquidation repaid 0x0c241d25; the plan adds 60 s of interest headroom (a few hundred units at most)
  const over = r.results[0].plan.repaid - 0x0c241d25n;
  assert.ok(over >= 0n && over < 1000n, `headroom ${over}`);
  assert.equal(sender.sent.length, 0);
  const sim = seen.find((c) => c.sel === MORPHO_IFACE.getFunction('liquidate').selector);
  assert.equal(sim.from, ME);
  assert.ok(bot.health.get(GOOD) > 1);
});

test('live: approves the spending limit (never unlimited), then sends liquidate() with the full-repay arguments', async () => {
  const { rpc } = fakeChain({ usdg: 500n * 10n ** 6n, allowance: 0n });
  const sender = fakeSender();
  const store = memStore();
  const bot = makeBot({ rpc, sender, cfg: cfg({ live: true, maxRepay: 300n * 10n ** 6n }), store, log: quiet });
  await bot.start();
  const r = await bot.tick();
  assert.equal(r.results[0].sent, true);
  assert.equal(sender.sent.length, 2);
  const [approve, liq] = sender.sent;
  assert.equal(approve.to, USDG);
  const [spender, amount] = ERC20.decodeFunctionData('approve', approve.data);
  assert.equal(spender, MORPHO); assert.equal(amount, 300n * 10n ** 6n);   // MAX_REPAY_USDG
  assert.equal(liq.to, MORPHO);
  const a = MORPHO_IFACE.decodeFunctionData('liquidate', liq.data);
  assert.equal(a[1], BAD); assert.equal(a[2], 0n); assert.equal(a[3], 0xaf7e4472bb2an); assert.equal(a[4], '0x');
  assert.equal(a[0].lltv, LLTV);
  assert.equal(store.history().length, 1);
});

test('live: the budget caps the bid (partial), and a bid under MIN_PROFIT_USDG is skipped', async () => {
  const { rpc } = fakeChain({ usdg: 50n * 10n ** 6n, allowance: 10n ** 12n });
  const sender = fakeSender();
  const bot = makeBot({ rpc, sender, cfg: cfg({ live: true }), store: memStore(), log: quiet });
  await bot.start();
  const r = await bot.tick();
  assert.equal(r.results[0].sent, true);
  const a = MORPHO_IFACE.decodeFunctionData('liquidate', sender.sent[0].data);
  assert.ok(a[3] > 0n && a[3] < 0xaf7e4472bb2an);
  const rich = makeBot({ rpc, sender: fakeSender(), cfg: cfg({ live: true, minProfit: 10n ** 12n }), store: memStore(), log: quiet });
  await rich.start();
  assert.deepEqual((await rich.tick()).results, []);
});

test('live: when Morpho would refuse (someone got there first), nothing is sent', async () => {
  const { rpc } = fakeChain({ allowance: 10n ** 12n });
  const sender = fakeSender();
  sender.estimateGas = async () => { throw Object.assign(new Error('execution reverted'), { shortMessage: 'execution reverted: position is healthy' }); };
  const bot = makeBot({ rpc, sender, cfg: cfg({ live: true }), store: memStore(), log: quiet });
  await bot.start();
  const r = await bot.tick();
  assert.equal(r.results[0].sent, false);
  assert.equal(sender.sent.length, 0);
});

test('a paused oracle stops all bids', async () => {
  const { rpc } = fakeChain({ priceReverts: true });
  const bot = makeBot({ rpc, sender: fakeSender(), cfg: cfg({ live: true }), store: memStore(), log: quiet });
  await bot.start();
  assert.deepEqual(await bot.tick(), { paused: true });
});

test('dry run reads Morpho\'s reason: "position is healthy" is reported as such', async () => {
  const { rpc } = fakeChain({ liquidateReason: 'position is healthy' });
  const bot = makeBot({ rpc, cfg: cfg(), store: memStore(), log: quiet });
  await bot.start();
  const r = await bot.tick();
  assert.equal(r.results[0].reason, 'position is healthy');
});

test('a partial bid leaves room for the interest that accrues before it lands', async () => {
  const { rpc } = fakeChain({ usdg: 100n * 10n ** 6n, allowance: 100n * 10n ** 6n });
  const sender = fakeSender();
  const bot = makeBot({ rpc, sender, cfg: cfg({ live: true }), store: memStore(), log: quiet });
  await bot.start();
  await bot.tick();
  const a = MORPHO_IFACE.decodeFunctionData('liquidate', sender.sent[0].data);
  // what Morpho will pull if the bid lands 60 s after the read, at the market's real rate
  const { accrue, toAssetsUp } = await import('../src/math.mjs');
  const later = accrue({ totalSupplyAssets: MARKET[0], totalSupplyShares: MARKET[1], totalBorrowAssets: MARKET[2], totalBorrowShares: MARKET[3], lastUpdate: MARKET[4], fee: 0n }, 0x2d95795f6n, TS + 60);
  assert.ok(toAssetsUp(a[3], later.totalBorrowAssets, later.totalBorrowShares) <= 100n * 10n ** 6n);
});

test('idle: the approval is set to the spendable USDG, and not resent when the allowance did not read', async () => {
  // the liquidatable loan is skipped (profit floor), so the tick is idle and sets the approval
  const { rpc } = fakeChain({ usdg: 80n * 10n ** 6n, allowance: 0n });
  const sender = fakeSender();
  const bot = makeBot({ rpc, sender, cfg: cfg({ live: true, reserve: 5n * 10n ** 6n, minProfit: 10n ** 15n }), store: memStore(), log: quiet });
  await bot.start();
  await bot.tick();
  assert.equal(sender.sent.length, 1);
  assert.equal(ERC20.decodeFunctionData('approve', sender.sent[0].data)[1], 75n * 10n ** 6n);   // 80 held − 5 reserve

  const flaky = fakeChain({ usdg: 80n * 10n ** 6n, allowance: 'unreadable' });
  const s2 = fakeSender();
  const b2 = makeBot({ rpc: flaky.rpc, sender: s2, cfg: cfg({ live: true, minProfit: 10n ** 15n }), store: memStore(), log: quiet });
  await b2.start();
  await b2.tick(); await b2.tick();
  assert.equal(s2.sent.length, 0);
});
