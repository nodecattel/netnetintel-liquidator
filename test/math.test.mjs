// Morpho Blue's arithmetic, checked against a real liquidation on the Loopback market (block 84,602,814, tx
// 0x805b3a39…2a05): the state one block before, the oracle price and the IRM rate, against the Liquidate event's own
// repaidAssets and seizedAssets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { accrue, positionView, planBid, settle, incentiveOf, toAssetsUp, WAD } from '../src/math.mjs';
import { LLTV } from '../src/constants.mjs';

const words = (hex) => [...Array((hex.length - 2) / 64)].map((_, i) => BigInt('0x' + hex.slice(2 + 64 * i, 66 + 64 * i)));
const [tsa, tss, tba, tbs, lastUpdate, fee] = words('0x000000000000000000000000000000000000000000000000000000f5fd8bc4ef0000000000000000000000000000000000000000000000000def89a96c5155e3000000000000000000000000000000000000000000000000000000c18987993e0000000000000000000000000000000000000000000000000aed7c70b24aa8ff000000000000000000000000000000000000000000000000000000006ac990600000000000000000000000000000000000000000000000000000000000000000');
const MARKET = { totalSupplyAssets: tsa, totalSupplyShares: tss, totalBorrowAssets: tba, totalBorrowShares: tbs, lastUpdate, fee };
const [, borrowShares, collateral] = words('0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000af7e4472bb2a000000000000000000000000000000000000000000000000062c14a2a08dc62e');
const POS = { borrowShares, collateral };
const PRICE = 0x25e2545d2a4cb759f62f5c0n, RATE = 0x2d95795f6n, TS = 0x6ac99061;
const EVENT = { repaidAssets: 0x0c241d25n, repaidShares: 0xaf7e4472bb2an, seizedAssets: 0x0458bc614f92e98fn };

test('incentive at the 62.5% LLTV is 1.1268 (min(1.15, 1/(1 − 0.3 × 0.375)))', () => {
  const f = Number(incentiveOf(LLTV)) / 1e18;
  assert.ok(Math.abs(f - 1 / (1 - 0.3 * 0.375)) < 1e-12);
  assert.equal(incentiveOf(10n ** 17n), 115n * 10n ** 16n);   // a low LLTV hits the 1.15 cap
});

test('the real liquidation: accrued totals, health under 1, and the exact repaid and seized amounts', () => {
  const m = accrue(MARKET, RATE, TS);
  assert.ok(m.totalBorrowAssets > MARKET.totalBorrowAssets);
  const v = positionView(POS, m, PRICE, LLTV);
  assert.equal(v.liquidatable, true);
  assert.ok(v.health < 1 && v.health > 0.9, `health ${v.health}`);
  const s = settle({ repaidShares: POS.borrowShares }, POS, m, PRICE, LLTV);
  assert.equal(s.repaidShares, EVENT.repaidShares);
  assert.equal(s.repaid, EVENT.repaidAssets);
  assert.equal(s.seized, EVENT.seizedAssets);
});

test('planBid: a full bid when the wallet covers the debt; profit is the incentive at the oracle', () => {
  const m = accrue(MARKET, RATE, TS);
  const p = planBid(POS, m, PRICE, LLTV, 10_000n * 10n ** 6n);
  assert.equal(p.mode, 'full');
  assert.equal(p.args.repaidShares, POS.borrowShares);
  assert.equal(p.args.seizedAssets, 0n);
  assert.equal(p.repaid, EVENT.repaidAssets);
  const ratio = Number(p.valueAtOracle) / Number(p.repaid);
  assert.ok(Math.abs(ratio - 1.1268) < 0.001, `value/repaid ${ratio}`);
});

test('planBid: a partial bid sized to the budget never spends more than the budget', () => {
  const m = accrue(MARKET, RATE, TS);
  for (const budget of [1n, 999_999n, 50n * 10n ** 6n, EVENT.repaidAssets - 1n]) {
    const p = planBid(POS, m, PRICE, LLTV, budget);
    assert.equal(p.mode, 'partial');
    assert.ok(p.repaid <= budget, `repaid ${p.repaid} > budget ${budget}`);
    assert.ok(p.seized <= POS.collateral);
    if (budget >= 10n ** 6n) assert.ok(p.profit > 0n);   // dust bids can round to a loss; MIN_PROFIT_USDG filters them
  }
  assert.ok(planBid(POS, m, PRICE, LLTV, 50n * 10n ** 6n, { allowPartial: false }).skip);
  assert.ok(planBid(POS, m, PRICE, LLTV, 0n).skip);
});

test('planBid: bad debt (collateral worth less than debt × incentive) seizes all the collateral', () => {
  const m = accrue(MARKET, RATE, TS);
  const low = PRICE / 3n;                               // the collateral now covers about a third of the debt
  const p = planBid(POS, m, low, LLTV, 10_000n * 10n ** 6n);
  assert.equal(p.mode, 'seize-all');
  assert.equal(p.args.seizedAssets, POS.collateral);
  assert.equal(p.seized, POS.collateral);
  assert.ok(p.repaid < toAssetsUp(POS.borrowShares, m.totalBorrowAssets, m.totalBorrowShares));
  assert.ok(p.profit >= 0n);
});

test('a healthy loan is not liquidatable', () => {
  const m = accrue(MARKET, RATE, TS);
  const v = positionView(POS, m, PRICE * 2n, LLTV);
  assert.equal(v.liquidatable, false);
  assert.ok(v.health > 1.5);
  assert.equal(positionView({ borrowShares: 0n, collateral: 5n * WAD }, m, PRICE, LLTV).liquidatable, false);
});
