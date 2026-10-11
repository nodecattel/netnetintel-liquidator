// The pace and the RPC budget: each loan is read once, then only when a market event names it (or on the slow sweep);
// the wallet and gas price every 30 s; checks every 15 s while every loan is clear, faster as one nears the line. The
// RPC layer cuts batches to a per-host budget that halves on a 429, retries the same node, and never "falls back" for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'ethers';
import { makeBot, PACE } from '../src/bot.mjs';
import { makeRpc, resetBudgets, RPC_BUDGET_START } from '../src/chain.mjs';
import { MORPHO_IFACE } from '../src/chain.mjs';
import { MARKET_ID } from '../src/constants.mjs';
import { fakeRpc, POS, BAD, GOOD } from './fake.mjs';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const memStore = (cursor = 0x50b0000 - 5) => { let s = { cursor, borrowers: [BAD, GOOD], history: [], txs: [] }; return { get cursor() { return s.cursor; }, borrowers: () => s.borrowers, history: () => s.history, setScan(c, b) { s.cursor = c; s.borrowers = [...b]; }, record(e) { s.history.push(e); }, recordTx(t) { s.txs.push(t); }, txs: () => s.txs, heartbeat() {} }; };
const cfg = { live: true, tickSeconds: 2, fullEverySeconds: 30, hotHealth: 1.1, minProfit: 250_000n, reserve: 0n, maxRepay: null, allowPartial: true, payout: null, gasFloorWei: 0n, logRange: 1_000_000, minLogRange: 1000 };
const COLL = 0x062c14a2a08dc62en;
const pad = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');

// a chain whose head moves when the test says, with the market events the test puts in
function chain() {
  const { rpc: base } = fakeRpc({ usdg: 500n * 10n ** 6n, allowance: 500n * 10n ** 6n });
  const st = { head: 0x50b0000, logs: [], calls: [] };
  const rpc = async (calls, opts) => {
    st.calls.push(...calls);
    const out = await base(calls, opts);
    return calls.map((c, i) => {
      if (c.method === 'eth_blockNumber') return { result: '0x' + st.head.toString(16) };
      if (c.method === 'eth_getBlockByNumber') return { result: { number: '0x' + st.head.toString(16), timestamp: '0x6ac99061' } };
      if (c.method === 'eth_getLogs' && c.params[0].topics?.[0] === null) { const l = st.logs; st.logs = []; return { result: l }; }
      return out[i];
    });
  };
  rpc.one = base.one;
  const count = (sel) => st.calls.filter((c) => c.method === 'eth_call' && c.params[0].data.startsWith(sel)).length;
  return { rpc, st, positions: () => count(MORPHO_IFACE.getFunction('position').selector), balances: () => count('0x70a08231') };
}

test('calm: loans read once, then only when an event names them; the wallet every 30 s; a check every 15 s', async () => {
  POS[BAD] = [0n, POS[GOOD]?.[1] ?? 0xaf7e4472bb2an, COLL * 3n];   // both well clear of the line
  POS[GOOD] = [0n, 0xaf7e4472bb2an, COLL * 3n];
  const c = chain();
  let t = 1_800_000_000_000;
  const sender = { address: getAddress('0x1111111111111111111111111111111111111111'), nonce: async () => 1, estimateGas: async () => 1n, send: async () => { throw new Error('nothing to send'); } };
  const bot = makeBot({ rpc: c.rpc, sender, cfg, store: memStore(), log: quiet, nowMs: () => t });
  await bot.start();
  await bot.tick();
  assert.equal(c.positions(), 2, 'every known wallet read once at the start');
  assert.equal(bot.status().pace.mode, 'calm'); assert.equal(bot.nextDelayMs(), PACE.calmMs);
  assert.match(bot.status().pace.why, /closest loan at/);

  c.st.calls.length = 0; t += 16_000; c.st.head += 64;
  await bot.tick();
  assert.equal(c.positions(), 0, 'no event, no sweep due: no loan read again');
  assert.equal(c.balances(), 0, 'the wallet is not read again within 30 s');
  assert.ok(c.st.calls.length <= 6, `a calm check is a handful of calls: ${c.st.calls.map((x) => x.method).join(', ')}`);

  // a repay names GOOD: only GOOD is read again
  c.st.calls.length = 0; t += 4_000; c.st.head += 16;
  c.st.logs = [{ topics: ['0x52acb05cebbd3cd39715469f22afbf5a17496295ef3bc9bb5944056c63ccaa09', MARKET_ID, pad('0x9999999999999999999999999999999999999999'), pad(GOOD)] }];
  await bot.tick();
  assert.equal(c.positions(), 1, 'the wallet the event named, and no other');
  const read = c.st.calls.filter((x) => x.method === 'eth_call' && x.params[0].data.startsWith(MORPHO_IFACE.getFunction('position').selector));
  assert.equal(getAddress('0x' + read[0].params[0].data.slice(-40)), GOOD);
});

test('near the line: every TICK_SECONDS and that loan read on each check; under HOT_HEALTH: every 6 s', async () => {
  POS[BAD] = [0n, 0xaf7e4472bb2an, (COLL * 1015n) / 1000n];          // just over the line
  POS[GOOD] = [0n, 0xaf7e4472bb2an, COLL * 3n];
  const c = chain();
  let t = 1_800_000_000_000;
  const bot = makeBot({ rpc: c.rpc, sender: null, cfg, store: memStore(), log: quiet, nowMs: () => t });
  await bot.start();
  await bot.tick();
  assert.ok(bot.status().closest[0].health < 1.03);
  assert.equal(bot.status().pace.mode, 'fast'); assert.equal(bot.nextDelayMs(), 2000);
  // a loan reads again on every check while it is this close
  c.st.calls.length = 0; t += 2_000;
  await bot.tick();
  assert.equal(c.positions(), 1, 'the loan about to cross, and only it');
  // under HOT_HEALTH but not that close: every 6 s
  POS[BAD] = [0n, 0xaf7e4472bb2an, (COLL * 1050n) / 1000n];
  t += 2_000; await bot.tick();
  assert.equal(bot.status().pace.mode, 'watch'); assert.equal(bot.nextDelayMs(), PACE.watchMs);
});

test('RPC budget: batches no bigger than a second\'s budget; a 429 halves it and retries the same node, quietly', async () => {
  resetBudgets();
  let clock = 0;
  const now = () => clock, wait = async (ms) => { clock += ms; };
  const sizes = [], hosts = [];
  let refuse = 1;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    hosts.push(new URL(url).host); sizes.push(body.length);
    if (url.startsWith('https://mine.example') && refuse > 0) { refuse--; return new Response('{"jsonrpc":"2.0","error":{"code":429,"message":"rate limited"}}', { status: 429 }); }
    return new Response(JSON.stringify(body.map((c) => ({ jsonrpc: '2.0', id: c.id, result: '0x1' }))));
  };
  const flips = [];
  const rpc = makeRpc(() => ['https://mine.example/key', 'https://rpc.mainnet.chain.robinhood.com'], { fetchImpl, now, wait, onFallback: (on) => flips.push(on) });
  const calls = Array.from({ length: 30 }, () => ({ method: 'eth_chainId', params: [] }));
  await rpc(calls);
  assert.ok(Math.max(...sizes) <= RPC_BUDGET_START, `batches cut to the budget: ${sizes}`);
  assert.equal(hosts[0], 'mine.example'); assert.equal(hosts[1], 'mine.example', 'the 429 is retried on the same node');
  assert.ok(hosts.every((h) => h === 'mine.example'), 'never sent to the public node for a single 429');
  assert.deepEqual(flips, [], 'no "using the public RPC" for being paced');
  const st = rpc.stats();
  assert.equal(st.limited, 1); assert.ok(st.budget < RPC_BUDGET_START, `budget halved: ${st.budget}`); assert.equal(st.slowed, true);
  assert.ok(st.perMin >= 30);
  // a node that keeps refusing: that one batch goes to the next node, the one after comes back
  refuse = 3; hosts.length = 0;
  await rpc.one('eth_chainId', []);
  assert.deepEqual(hosts, ['mine.example', 'mine.example', 'mine.example', 'rpc.mainnet.chain.robinhood.com']);
  hosts.length = 0; await rpc.one('eth_chainId', []);
  assert.deepEqual(hosts, ['mine.example']);
  assert.deepEqual(flips, []);
  resetBudgets();
});

test('a loan past the line that would earn under MIN_PROFIT_USDG (cents left after a partial liquidation) sets no pace', async () => {
  POS[BAD] = [0n, 0xaf7e4472bb2an / 5_000n, (COLL / 5_000n) * 99n / 100n];   // a few cents owed, just past the line
  POS[GOOD] = [0n, 0xaf7e4472bb2an, COLL * 3n];
  const c = chain();
  let t = 1_800_000_000_000;
  const bot = makeBot({ rpc: c.rpc, sender: null, cfg, store: memStore(), log: quiet, nowMs: () => t });
  await bot.start();
  await bot.tick();
  t += 2_000; await bot.tick();
  const st = bot.status();
  assert.ok(st.closest.some((x) => x.health < 1), 'it is past the line');
  assert.equal(st.pace.mode, 'calm', `not worth a bid, so no fast checks: ${st.pace.why}`);
});
