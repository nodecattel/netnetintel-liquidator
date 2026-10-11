// Timed bids: a loan that interest alone tips past the line gets its bid built ahead and sent at that second (no gas
// estimate, the nonce and fees set in advance); a lost race is counted, three in a row leave the borrower alone, and
// lost races are reported once an hour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'ethers';
import { makeBot, SHOT_GAS, LOST_MAX } from '../src/bot.mjs';
import { MORPHO_IFACE } from '../src/chain.mjs';
import { MORPHO, LLTV } from '../src/constants.mjs';
import { accrue, positionView, crossingAt, toAssetsUp, ORACLE_PRICE_SCALE, WAD } from '../src/math.mjs';
import { fakeRpc, POS, BAD, GOOD, PRICE, TS, MARKET } from './fake.mjs';

const RATE = 0x2d95795f6n;   // the fake IRM's rate per second
const market = { totalSupplyAssets: MARKET[0], totalSupplyShares: MARKET[1], totalBorrowAssets: MARKET[2], totalBorrowShares: MARKET[3], lastUpdate: MARKET[4], fee: MARKET[5] };
const shares = POS[BAD][1];
// the collateral that sits exactly at the line `ahead` seconds after TS (so it crosses then, from interest alone)
const collCrossingIn = (ahead) => {
  const debt = toAssetsUp(shares, accrue(market, RATE, TS + ahead).totalBorrowAssets, market.totalBorrowShares);
  return (debt * WAD * ORACLE_PRICE_SCALE) / (PRICE * LLTV) + 1n;
};

test('crossingAt: the first second interest alone puts the loan past the line', () => {
  const pos = { supplyShares: 0n, borrowShares: shares, collateral: collCrossingIn(40) };
  const past = (t) => positionView(pos, accrue(market, RATE, t), PRICE, LLTV).liquidatable;
  const at = crossingAt(pos, market, RATE, PRICE, LLTV, TS, 90);
  assert.ok(at > TS && at <= TS + 41, `crossing at +${at - TS}s`);
  assert.equal(past(at), true); assert.equal(past(at - 1), false);
  assert.equal(crossingAt(pos, market, RATE, PRICE, LLTV, TS, 20), null, 'not within the window');
  assert.equal(crossingAt(pos, market, 0n, PRICE, LLTV, TS, 90), null, 'no interest, no crossing');
  const bad = { supplyShares: 0n, borrowShares: shares, collateral: POS[BAD][2] };
  assert.equal(crossingAt(bad, market, RATE, PRICE, LLTV, TS, 90), null, 'already past: the normal check bids');
});

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const memStore = () => { let s = { cursor: null, borrowers: [], history: [], txs: [] }; return { get cursor() { return s.cursor; }, borrowers: () => s.borrowers, history: () => s.history, setScan(c, b) { s.cursor = c; s.borrowers = [...b]; }, record(e) { s.history.push(e); }, recordTx(t) { s.txs.push(t); }, txs: () => s.txs, heartbeat() {} }; };
const cfg = { live: true, tickSeconds: 2, fullEverySeconds: 30, hotHealth: 1.1, minProfit: 250_000n, reserve: 0n, maxRepay: null, allowPartial: true, payout: null, gasFloorWei: 0n, logRange: 1_000_000, minLogRange: 1000 };

test('a loan due to cross in ~2 s: the bid is built ahead and sent at that second, with no gas estimate', async () => {
  POS[BAD] = [0n, shares, collCrossingIn(2)];
  delete POS[GOOD];
  const { rpc } = fakeRpc({ usdg: 10_000n * 10n ** 6n, allowance: 10_000n * 10n ** 6n });
  const sent = [], events = [];
  let estimates = 0, status = 0, extra = 0;
  const sender = { address: getAddress('0x1111111111111111111111111111111111111111'), nonce: async () => 7, estimateGas: async () => { estimates++; return 300_000n; },
    send: async (tx) => { sent.push({ tx, at: Date.now() }); return { hash: '0x' + String(sent.length).padStart(64, '0'), wait: async () => ({ status, blockNumber: 1, logs: [] }) }; } };
  const notes = [];
  const bot = makeBot({ rpc, sender, cfg, store: memStore(), log: quiet, onEvent: (e) => events.push(e), notify: async (t) => { notes.push(t); }, nowMs: () => Date.now() + extra });
  await bot.start();
  const t0 = Date.now();
  await bot.tick();
  assert.equal(sent.length, 0, 'not yet past the line: nothing sent on the check');
  await new Promise((r) => setTimeout(r, 3200));
  assert.equal(sent.length, 1, 'the timed bid went out');
  const { tx, at } = sent[0];
  assert.equal(tx.to, MORPHO); assert.equal(tx.nonce, 7); assert.equal(tx.gasLimit, SHOT_GAS); assert.equal(tx.maxPriorityFeePerGas, 0n);
  assert.equal(MORPHO_IFACE.decodeFunctionData('liquidate', tx.data)[1], BAD);
  assert.equal(estimates, 0, 'no gas estimate before a timed bid');
  assert.ok(at - t0 >= 1000 && at - t0 <= 3200, `sent ${at - t0} ms after the check`);
  // it reverted: a lost race, reported in the hourly summary (not each time)
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(events.filter((e) => e.kind === 'races').length, 0);
  extra = 61 * 60_000;
  await bot.tick();
  const races = events.find((e) => e.kind === 'races');
  assert.equal(races?.lost, 1); assert.equal(races.borrowers[0].borrower, BAD);
  assert.ok(notes.some((n) => /Lost 1 liquidation race/.test(n)));
  assert.ok(LOST_MAX === 3);
  status = 1;
});

test('dust: a loan owing under a cent (no collateral left) is not liquidatable news, not the closest loan, not a bid', async () => {
  POS[BAD] = [0n, 1000n, 0n];                                   // a few borrow shares, no collateral: health 0, debt 0.00
  POS[GOOD] = [0n, shares, 0x062c14a2a08dc62en * 3n];
  const { rpc } = fakeRpc({ usdg: 200n * 10n ** 6n, allowance: 200n * 10n ** 6n });
  const lines = [], events = [];
  const log = { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m), debug() {} };
  const sender = { address: getAddress('0x1111111111111111111111111111111111111111'), nonce: async () => 1, estimateGas: async () => 1n, send: async () => { throw new Error('nothing should be sent'); } };
  const bot = makeBot({ rpc, sender, cfg, store: memStore(), log, onEvent: (e) => events.push(e) });
  await bot.start();
  const r = await bot.tick();
  assert.equal(r.ready, 0);
  const st = bot.status();
  assert.equal(st.closest.some((c) => c.borrower === BAD), false);
  assert.equal(st.open, 1);
  assert.equal(lines.some((l) => /skipped|liquidatable/.test(l)), false, lines.join('\n'));
  assert.equal(events.some((e) => e.kind === 'nofunds'), false);
});

test('the crossing second comes from the oracle read second by second, not the straight line between reads 30 s apart', async () => {
  // between swaps the TWAP curves toward the pool's price, fastest at first: 3% under over ~10 s (e^-0.3t)
  const priceAtT = (t) => { const x = Math.max(0, t - TS); return (PRICE * BigInt(Math.round((0.97 + 0.03 * Math.exp(-0.3 * x)) * 1e9))) / 1_000_000_000n; };
  // the line sits 1.3% under today's price: the curve crosses it at +2 s, the straight line from +0 to +30 s at ~+13 s
  const debt = toAssetsUp(shares, accrue(market, RATE, TS + 2).totalBorrowAssets, market.totalBorrowShares);
  POS[BAD] = [0n, shares, (debt * WAD * ORACLE_PRICE_SCALE) / ((PRICE * 987n / 1000n) * LLTV) + 1n];
  delete POS[GOOD];
  const { rpc: base } = fakeRpc({ usdg: 10_000n * 10n ** 6n, allowance: 10_000n * 10n ** 6n });
  const reads = [];
  const rpc = async (calls) => {
    const out = await base(calls);
    return calls.map((c, i) => {
      const o = c.params?.[3]?.time;
      if (c.method !== 'eth_call' || o == null) return out[i];
      const t = parseInt(o, 16); reads.push(t);
      return { result: '0x' + priceAtT(t).toString(16).padStart(64, '0') };
    });
  };
  rpc.one = base.one;
  const sent = [];
  let signed = 0;
  const sender = { address: getAddress('0x1111111111111111111111111111111111111111'), nonce: async () => 3, estimateGas: async () => 300_000n,
    sign: async (tx) => { signed++; return '0xraw' + tx.nonce; },
    send: async () => { throw new Error('a timed bid is broadcast as signed, not signed again'); },
    sendRaw: async (raw) => { sent.push({ raw, at: Date.now() }); return { hash: '0x' + 'a'.repeat(64), wait: async () => ({ status: 1, blockNumber: 1, logs: [] }) }; } };
  const bot = makeBot({ rpc, sender, cfg, store: memStore(), log: quiet });
  await bot.start();
  await bot.tick();                                  // the first check sets the chain clock; the next reads ahead
  const t0 = Date.now();
  await bot.tick();
  assert.ok(reads.some((t) => t > TS + 1 && t < TS + 13 && t !== TS + 30), `read second by second near the crossing: ${[...new Set(reads)].sort().map((t) => t - TS)}`);
  await new Promise((r) => setTimeout(r, 3200));
  assert.equal(sent.length, 1, 'the bid went out at the curve\'s crossing (+2 s), not the straight line\'s (+13 s)');
  assert.ok(sent[0].at - t0 >= 1500 && sent[0].at - t0 <= 3000, `sent ${sent[0].at - t0} ms after the check`);
  assert.equal(signed, 1, 'signed once, when it was built'); assert.equal(sent[0].raw, '0xraw3');
});

test('mergePoints: one price per second (the exact read wins), in time order', async () => {
  const { mergePoints } = await import('../src/bot.mjs');
  assert.deepEqual(mergePoints([{ t: 5, price: 1n }, { t: 1, price: 9n }], [{ t: 5, price: 2n }]), [{ t: 1, price: 9n }, { t: 5, price: 2n }]);
});

test('the sender signs a timed bid offline and broadcasts it as signed (to the sequencer too)', async () => {
  const { Wallet, Transaction, keccak256 } = await import('ethers');
  const { senderOf } = await import('../src/runner.mjs');
  const { CHAIN_ID } = await import('../src/constants.mjs');
  const w = Wallet.createRandom();
  const posted = [];
  const fetchImpl = async (url, init) => { posted.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' })); };
  const s = senderOf(w, 'https://127.0.0.1:9/', { sequencerUrl: 'https://sequencer.example/', fetchImpl });
  const raw = await s.sign({ to: MORPHO, data: '0x12', gasLimit: SHOT_GAS, nonce: 5, type: 2, maxFeePerGas: 40_000_000n, maxPriorityFeePerGas: 0n });
  const tx = Transaction.from(raw);
  assert.equal(tx.from, w.address); assert.equal(tx.nonce, 5); assert.equal(tx.chainId, BigInt(CHAIN_ID)); assert.equal(tx.gasLimit, SHOT_GAS);
  const r = await s.sendRaw(raw);
  assert.equal(r.hash, keccak256(raw));
  assert.equal(posted[0].body.method, 'eth_sendRawTransaction'); assert.equal(posted[0].body.params[0], raw);
});
