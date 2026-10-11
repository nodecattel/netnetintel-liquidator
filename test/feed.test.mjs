// The live feed (watch.mjs) and the oracle read ahead: the WebSocket subscribes to what moves the price and wakes the
// bot, reconnects when it drops; the oracle's price a few seconds out bends the timed bid's second.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWatch, wssFrom, WATCH } from '../src/watch.mjs';
import { configFrom } from '../src/config.mjs';
import { readTick } from '../src/chain.mjs';
import { accrue, positionView, crossingAt, pricePath, toAssetsUp, ORACLE_PRICE_SCALE, WAD } from '../src/math.mjs';
import { PAIR, MORPHO, MARKET_ID, LLTV, MARKET_PARAMS } from '../src/constants.mjs';
import { fakeRpc, POS, BAD, PRICE, TS, MARKET } from './fake.mjs';

class FakeWS {
  static all = [];
  constructor(url) { this.url = url; this.sent = []; FakeWS.all.push(this); setTimeout(() => this.onopen?.(), 0); }
  send(s) { const j = JSON.parse(s); this.sent.push(j); if (j.method === 'eth_subscribe') setTimeout(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id: j.id, result: '0xsub' + j.id }) }), 0); }
  close() { setTimeout(() => this.onclose?.(), 0); }
  log(address) { this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', method: 'eth_subscription', params: { subscription: '0xsub1', result: { address, topics: [], data: '0x' } } }) }); }
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('live feed: subscribes to the pair, oracle, Treasury, staking and the market; each log wakes the bot; reconnects', async () => {
  FakeWS.all = [];
  const woke = [];
  const w = makeWatch({ url: 'wss://x.quiknode.pro/k/', onWake: (k) => woke.push(k), WebSocketImpl: FakeWS });
  w.start();
  await tick(20);
  const ws = FakeWS.all[0];
  const subs = ws.sent.filter((m) => m.method === 'eth_subscribe').map((m) => m.params[1]);
  assert.equal(subs.length, 2);
  assert.ok(subs[0].address.includes(PAIR));
  assert.equal(subs[1].address, MORPHO); assert.deepEqual(subs[1].topics, [null, MARKET_ID]);
  assert.equal(w.status().connected, true);
  ws.log(PAIR); ws.log(MORPHO);
  assert.deepEqual(woke, ['swap', 'market']);
  assert.equal(w.status().events, 2);
  ws.close(); await tick(20);
  assert.equal(w.status().connected, false);
  await tick(1100);                                      // backoff 1 s, then a new socket
  assert.equal(FakeWS.all.length, 2);
  await tick(20);
  assert.equal(w.status().connected, true);
  w.stop();
  assert.equal(WATCH[PAIR.toLowerCase()], 'swap');
});

test('wss address: QuickNode\'s comes from its https one; RPC_WSS_URL wins, "off" turns it off; only wss://', () => {
  assert.equal(wssFrom('https://abc.robinhood-mainnet.quiknode.pro/key123/'), 'wss://abc.robinhood-mainnet.quiknode.pro/key123/');
  assert.equal(wssFrom('https://rpc.mainnet.chain.robinhood.com'), null);
  assert.equal(configFrom({ RPC_URL: 'https://abc.quiknode.pro/k/' }).wssUrl, 'wss://abc.quiknode.pro/k/');
  assert.equal(configFrom({ RPC_URL: 'https://abc.quiknode.pro/k/', RPC_WSS_URL: 'off' }).wssUrl, null);
  assert.equal(configFrom({ RPC_WSS_URL: 'wss://other/x' }).wssUrl, 'wss://other/x');
  assert.equal(configFrom({}).wssUrl, null);
  assert.throws(() => configFrom({ RPC_WSS_URL: 'https://nope' }), /wss:\/\//);
});

test('the oracle read ahead: block-time overrides in the same batch; a node without them leaves timed bids on interest', async () => {
  const { rpc } = fakeRpc();
  const calls = [];
  const spy = async (c) => { calls.push(...c); const out = await rpc(c); return out.map((r, i) => (c[i].params?.[3]?.time ? { result: '0x' + (PRICE - BigInt(i)).toString(16) } : r)); };
  spy.one = rpc.one;
  const v = await readTick(spy, MARKET_PARAMS, null, [BAD], { ahead: [TS + 30, TS + 60] });
  assert.equal(calls.filter((c) => c.params?.[3]?.time).length, 2);
  assert.equal(v.priceAhead.length, 2); assert.equal(v.priceAhead[0].t, TS + 30);
  const plain = await readTick(rpc, MARKET_PARAMS, null, [BAD], { ahead: [TS + 30] });   // the fake ignores overrides: same answer as now
  assert.ok(plain.priceAhead === null || plain.priceAhead[0].price === PRICE);
});

test('a falling oracle price brings the crossing forward', () => {
  const RATE = 0x2d95795f6n;
  const market = { totalSupplyAssets: MARKET[0], totalSupplyShares: MARKET[1], totalBorrowAssets: MARKET[2], totalBorrowShares: MARKET[3], lastUpdate: MARKET[4], fee: MARKET[5] };
  const shares = POS[BAD][1];
  const debt80 = toAssetsUp(shares, accrue(market, RATE, TS + 80).totalBorrowAssets, market.totalBorrowShares);
  const pos = { borrowShares: shares, collateral: (debt80 * WAD * ORACLE_PRICE_SCALE) / (PRICE * LLTV) + 1n };   // interest alone: ~80 s
  const byInterest = crossingAt(pos, market, RATE, PRICE, LLTV, TS, 90);
  assert.ok(byInterest > TS + 70, `interest alone: +${byInterest - TS}s`);
  const path = pricePath([{ t: TS, price: PRICE }, { t: TS + 90, price: (PRICE * 9990n) / 10000n }]);   // −0.1% over 90 s
  const withDrift = crossingAt(pos, market, RATE, PRICE, LLTV, TS, 90, path);
  assert.ok(withDrift < byInterest - 20, `with the drift: +${withDrift - TS}s`);
  assert.equal(positionView(pos, accrue(market, RATE, withDrift), path(withDrift), LLTV).liquidatable, true);
  assert.equal(positionView(pos, accrue(market, RATE, withDrift - 1), path(withDrift - 1), LLTV).liquidatable, false);
  assert.equal(path(TS - 5), PRICE); assert.equal(path(TS + 500), (PRICE * 9990n) / 10000n);
});
