// Settings from the environment (README → Settings). Bad values stop the bot at start rather than being guessed.
import { getAddress } from 'ethers';
import { DEFAULTS, PUBLIC_RPC, PUBLIC_SEQUENCER } from './constants.mjs';
import { usdgUnits } from './math.mjs';

const num = (v, name, min = 0) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!isFinite(n) || n < min) throw new Error(`${name} must be a number ≥ ${min} (got "${v}")`);
  return n;
};
const flag = (v, dflt) => (v == null || v === '' ? dflt : /^(1|true|yes|on)$/i.test(String(v)));

export function configFrom(env) {
  const payout = env.PAYOUT_ADDRESS ? (() => { try { return getAddress(env.PAYOUT_ADDRESS.trim()); } catch { throw new Error('PAYOUT_ADDRESS is not a valid address'); } })() : null;
  const cfg = {
    live: flag(env.LIVE, false),
    rpcUrl: env.RPC_URL || PUBLIC_RPC,
    // finding borrowers scans history in big ranges: the public RPC takes 2M blocks a request, most providers cap it
    // (QuickNode: 10,000), and it isn't time-critical. So it stays on the public RPC unless LOGS_RPC_URL says otherwise.
    logsRpcUrl: env.LOGS_RPC_URL || PUBLIC_RPC,
    dataDir: env.DATA_DIR || '/data',
    tickSeconds: num(env.TICK_SECONDS, 'TICK_SECONDS', 0.5) ?? DEFAULTS.tickSeconds,
    fullEverySeconds: num(env.FULL_EVERY_SECONDS, 'FULL_EVERY_SECONDS', 5) ?? DEFAULTS.fullEverySeconds,
    hotHealth: num(env.HOT_HEALTH, 'HOT_HEALTH', 1) ?? DEFAULTS.hotHealth,
    minProfit: usdgUnits(num(env.MIN_PROFIT_USDG, 'MIN_PROFIT_USDG') ?? DEFAULTS.minProfitUsdg),
    reserve: usdgUnits(num(env.RESERVE_USDG, 'RESERVE_USDG') ?? DEFAULTS.reserveUsdg),
    maxRepay: usdgUnits(num(env.MAX_REPAY_USDG, 'MAX_REPAY_USDG', 0.01)),
    allowPartial: flag(env.ALLOW_PARTIAL, DEFAULTS.allowPartial),
    payout,
    gasFloorWei: BigInt(Math.round((num(env.GAS_FLOOR_ETH, 'GAS_FLOOR_ETH') ?? DEFAULTS.gasFloorEth) * 1e18)),
    logRange: num(env.LOG_RANGE, 'LOG_RANGE', 100) ?? DEFAULTS.logRange,
    minLogRange: DEFAULTS.minLogRange,
    jsonLogs: flag(env.LOG_JSON, false),
    rpcBatch: num(env.RPC_BATCH, 'RPC_BATCH', 1) ?? 40,      // calls per JSON-RPC batch (the public RPC takes up to about 50)
    // when your own RPC fails, the public one answers until it is back (RPC_FALLBACK=0 to stop on errors instead)
    rpcFallback: flag(env.RPC_FALLBACK, true),
    // signed transactions also go straight to the sequencer, the node that orders them: the shortest path to a block
    sequencerUrl: /^(off|0|false|no)$/i.test(String(env.SEQUENCER_URL || '')) ? null : (env.SEQUENCER_URL || PUBLIC_SEQUENCER),
    debug: /^debug$/i.test(String(env.LOG_LEVEL || '')),
  };
  if (cfg.sequencerUrl && !/^https:\/\/[^\s]+$/.test(cfg.sequencerUrl)) throw new Error('SEQUENCER_URL must be an https:// address, or off');
  cfg.minLogRange = Math.min(cfg.minLogRange, cfg.logRange);
  return cfg;
}

export function describe(cfg) {
  const u = (v) => (v == null ? 'all it holds' : `${(Number(v) / 1e6).toFixed(2)} USDG`);
  return [
    cfg.live ? 'LIVE: liquidations are sent' : 'DRY RUN: nothing is sent (set LIVE=1 to send)',
    `bid size: up to ${u(cfg.maxRepay)}, keep ${u(cfg.reserve)} in reserve, partial bids ${cfg.allowPartial ? 'on' : 'off'}`,
    `minimum profit at the oracle price: ${(Number(cfg.minProfit) / 1e6).toFixed(2)} USDG`,
    `seized wsNET: ${cfg.payout ? 'sent to ' + cfg.payout : 'kept in the bot wallet'}`,
    `checks: loans under ${cfg.hotHealth}× health every ${cfg.tickSeconds}s, every loan every ${cfg.fullEverySeconds}s`,
    `RPC: ${cfg.rpcUrl === PUBLIC_RPC ? 'the public Robinhood Chain RPC (rate-limited: your own is faster, see Settings → Speed)' : 'your own' + (cfg.rpcFallback ? ', the public one as fallback' : '')}${cfg.sequencerUrl ? ' · transactions also sent to the sequencer' : ''}`,
  ];
}
