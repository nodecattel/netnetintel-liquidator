// Morpho Blue's own arithmetic, in BigInt, so the bot sees a loan exactly as liquidate() will: interest accrued to now
// (MathLib.wTaylorCompounded), virtual shares (SharesMathLib), the health check (_isHealthy) and the liquidation
// itself (seized / repaid, LIQUIDATION_CURSOR 0.3, MAX_LIQUIDATION_INCENTIVE_FACTOR 1.15).
export const WAD = 10n ** 18n;
export const ORACLE_PRICE_SCALE = 10n ** 36n;
const VIRTUAL_SHARES = 10n ** 6n, VIRTUAL_ASSETS = 1n;
const CURSOR = 3n * 10n ** 17n, MAX_INCENTIVE = 115n * 10n ** 16n;

export const mulDivDown = (x, y, d) => (x * y) / d;
export const mulDivUp = (x, y, d) => (x * y + (d - 1n)) / d;
const wMulDown = (x, y) => mulDivDown(x, y, WAD);
const wDivDown = (x, y) => mulDivDown(x, WAD, y);
const wDivUp = (x, y) => mulDivUp(x, WAD, y);

export const toSharesDown = (a, ta, ts) => mulDivDown(a, ts + VIRTUAL_SHARES, ta + VIRTUAL_ASSETS);
export const toSharesUp = (a, ta, ts) => mulDivUp(a, ts + VIRTUAL_SHARES, ta + VIRTUAL_ASSETS);
export const toAssetsDown = (s, ta, ts) => mulDivDown(s, ta + VIRTUAL_ASSETS, ts + VIRTUAL_SHARES);
export const toAssetsUp = (s, ta, ts) => mulDivUp(s, ta + VIRTUAL_ASSETS, ts + VIRTUAL_SHARES);

/** e^(x·n) − 1, third-order Taylor, as MathLib.wTaylorCompounded */
export function wTaylorCompounded(x, n) {
  const first = x * n;
  const second = mulDivDown(first, first, 2n * WAD);
  const third = mulDivDown(second, first, 3n * WAD);
  return first + second + third;
}

/** The market's borrow totals with interest accrued to `nowSec` at `ratePerSec` (the IRM's borrowRateView). */
export function accrue(market, ratePerSec, nowSec) {
  const elapsed = BigInt(Math.max(0, Math.floor(nowSec))) - market.lastUpdate;
  if (elapsed <= 0n || market.totalBorrowAssets === 0n || !(ratePerSec > 0n)) return { ...market };
  const interest = wMulDown(market.totalBorrowAssets, wTaylorCompounded(ratePerSec, elapsed));
  return { ...market, totalBorrowAssets: market.totalBorrowAssets + interest, totalSupplyAssets: market.totalSupplyAssets + interest };
}

export const incentiveOf = (lltv) => {
  const f = wDivDown(WAD, WAD - wMulDown(CURSOR, WAD - lltv));
  return f < MAX_INCENTIVE ? f : MAX_INCENTIVE;
};

/** A position as Morpho sees it: debt (USDG units, rounded up), the most it may borrow, health (×, 1 = the line). */
export function positionView(pos, m, price, lltv) {
  const debt = toAssetsUp(pos.borrowShares, m.totalBorrowAssets, m.totalBorrowShares);
  const maxBorrow = wMulDown(mulDivDown(pos.collateral, price, ORACLE_PRICE_SCALE), lltv);
  const health = debt === 0n ? Infinity : Number(maxBorrow) / Number(debt);
  return { debt, maxBorrow, health, liquidatable: debt > 0n && maxBorrow < debt };
}

/** What liquidate() does with one of its two amounts set. Returns { seized, repaidShares, repaid } or null when the
 *  collateral can't cover it (Morpho would revert on the underflow). */
export function settle({ seizedAssets = 0n, repaidShares = 0n }, pos, m, price, lltv) {
  const inc = incentiveOf(lltv);
  const ta = m.totalBorrowAssets, ts = m.totalBorrowShares;
  let seized = seizedAssets, shares = repaidShares;
  if (seized > 0n) shares = toSharesUp(wDivUp(mulDivUp(seized, price, ORACLE_PRICE_SCALE), inc), ta, ts);
  else seized = mulDivDown(wMulDown(toAssetsDown(shares, ta, ts), inc), ORACLE_PRICE_SCALE, price);
  if (seized > pos.collateral || shares > pos.borrowShares || shares === 0n) return null;
  return { seized, repaidShares: shares, repaid: toAssetsUp(shares, ta, ts) };
}

/** The bid for one liquidatable position given what the wallet may spend (USDG units).
 *  1. repay the whole loan (repaidShares = all its shares) when the collateral covers it and the wallet can pay;
 *  2. a loan whose collateral is worth less than its debt × incentive (bad debt): seize all the collateral;
 *  3. otherwise, if partial bids are allowed, repay as many shares as the budget buys.
 *  -> { mode, args: { seizedAssets, repaidShares }, seized, repaid, valueAtOracle, profit } or { skip: reason } */
export function planBid(pos, m, price, lltv, budget, { allowPartial = true } = {}) {
  if (!(budget > 0n)) return { skip: 'no USDG to bid with' };
  const full = settle({ repaidShares: pos.borrowShares }, pos, m, price, lltv);
  let mode, args, out;
  if (full) { mode = 'full'; args = { seizedAssets: 0n, repaidShares: pos.borrowShares }; out = full; }
  else { // the collateral runs out first: take all of it
    const all = settle({ seizedAssets: pos.collateral }, pos, m, price, lltv);
    if (!all) return { skip: 'the position cannot be settled' };
    mode = 'seize-all'; args = { seizedAssets: pos.collateral, repaidShares: 0n }; out = all;
  }
  if (out.repaid > budget) {
    if (!allowPartial) return { skip: `needs ${fmtUsdg(out.repaid)} USDG, the wallet may spend ${fmtUsdg(budget)}` };
    let shares = toSharesDown(budget, m.totalBorrowAssets, m.totalBorrowShares);
    let part = null;
    for (let i = 0; i < 4 && shares > 0n; i++) {          // toAssetsUp can land a unit over the budget: step down
      part = settle({ repaidShares: shares }, pos, m, price, lltv);
      if (part && part.repaid <= budget) break;
      shares -= (m.totalBorrowShares + VIRTUAL_SHARES) / (m.totalBorrowAssets + VIRTUAL_ASSETS) + 1n;
      part = null;
    }
    if (!part) return { skip: 'the budget is too small for a bid' };
    mode = 'partial'; args = { seizedAssets: 0n, repaidShares: part.repaidShares }; out = part;
  }
  const valueAtOracle = mulDivDown(out.seized, price, ORACLE_PRICE_SCALE);
  return { mode, args, seized: out.seized, repaid: out.repaid, valueAtOracle, profit: valueAtOracle - out.repaid };
}

export const fmtUsdg = (v) => (Number(v) / 1e6).toFixed(2);
export const fmtWs = (v) => (Number(v) / 1e18).toFixed(4);
export const usdgUnits = (x) => (x == null || x === '' ? null : BigInt(Math.round(Number(x) * 1e6)));
