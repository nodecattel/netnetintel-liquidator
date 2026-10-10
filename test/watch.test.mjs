// Starting fast and seeing the wallet: the open loans from NetNet Intel's API (the chain scan runs behind), balances
// read before the market is even loaded, deposits and funds moved elsewhere, the transaction log, the RPC fallback,
// and transactions sent to the RPC and the sequencer together.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, Transaction, getAddress } from 'ethers';
import { makeBot } from '../src/bot.mjs';
import { makeRpc } from '../src/chain.mjs';
import { makeStore, makeLog } from '../src/io.mjs';
import { makeIntel, walletValue } from '../src/intel.mjs';
import { senderOf } from '../src/runner.mjs';
import { PUBLIC_RPC } from '../src/constants.mjs';
import { fakeRpc, fakeFetch, BAD, GOOD } from './fake.mjs';

const ME = getAddress('0x1111111111111111111111111111111111111111');
const cfg = (x = {}) => ({ live: false, tickSeconds: 2, fullEverySeconds: 30, hotHealth: 1.1, minProfit: 250_000n, reserve: 0n, maxRepay: null, allowPartial: true, payout: null, gasFloorWei: 0n, logRange: 1_000_000, minLogRange: 1000, ...x });
const sink = () => { const lines = []; const f = (level) => (m) => lines.push(`${level} ${m}`); return { lines, info: f('info'), warn: f('warn'), error: f('error'), debug: f('debug'), recent: () => [] }; };
const sender = () => { const sent = []; return { sent, address: ME, estimateGas: async () => 300_000n, send: async (tx) => { sent.push(tx); return { hash: '0x' + String(sent.length).padStart(64, 'a'), wait: async () => ({ status: 1, logs: [], blockNumber: 85_000_001, gasUsed: 210_000n, gasPrice: 20_000_000n }) }; } }; };
const store = () => makeStore(mkdtempSync(join(tmpdir(), 'liqwatch-')));

test('start: NetNet Intel\'s open loans are watched at once; the chain scan finishes behind and adds the rest', async () => {
  const { rpc } = fakeRpc();
  const intel = makeIntel({ fetchImpl: fakeFetch({ intelLoans: [BAD] }) });
  const log = sink();
  const bot = makeBot({ rpc, cfg: cfg(), store: store(), log, seed: () => intel.loans() });
  await bot.start();
  assert.ok(bot.known.has(BAD), 'the API\'s loan is known right away');
  assert.equal(bot.status().phase, 'watching');
  await bot.scanDone();
  assert.deepEqual([...bot.known].sort(), [BAD, GOOD].sort(), 'the scan adds the borrower the API list did not have');
  assert.ok(log.lines.some((l) => /NetNet Intel: 1 open loans loaded/.test(l)));
  assert.ok(log.lines.some((l) => /chain scan done .* \(1 more than NetNet Intel's open list\)/.test(l)));
});

test('start: with the API down it finds the loans on chain, and says so', async () => {
  const { rpc } = fakeRpc();
  const intel = makeIntel({ fetchImpl: fakeFetch({ intel: false }) });
  const log = sink();
  const bot = makeBot({ rpc, cfg: cfg(), store: store(), log, seed: () => intel.loans() });
  await bot.start(); await bot.scanDone();
  assert.deepEqual([...bot.known].sort(), [BAD, GOOD].sort());
  assert.ok(log.lines.some((l) => /^warn NetNet Intel API not reachable .*finding the loans on chain/.test(l)));
});

test('wallet: ETH, USDG, wsNET, NET and sNET read before the market is loaded; a deposit is reported, a rebase is not', async () => {
  const bal = { eth: 0n, usdg: 0n, net: 0n, snet: 5n * 10n ** 9n };
  const { rpc } = fakeRpc(bal);
  const events = [];
  const s = store();
  const bot = makeBot({ rpc, cfg: cfg(), store: s, log: sink(), sender: sender(), onEvent: (e) => events.push(e) });
  await bot.refreshWallet();                                     // before start()
  let w = bot.status().wallet;
  assert.deepEqual([w.eth, w.usdg, w.wsnet, w.net, w.snet], [0, 0, 0, 0, 5]);
  bal.eth = 5n * 10n ** 14n; bal.usdg = 250n * 10n ** 6n; bal.net = 2n * 10n ** 9n; bal.snet = 5n * 10n ** 9n + 10n ** 7n;   // + 0.01 sNET: the rebase
  await bot.start(); await bot.tick();
  w = bot.status().wallet;
  assert.equal(w.usdg, 250); assert.equal(w.eth, 0.0005); assert.equal(w.net, 2);
  const dep = events.filter((e) => e.kind === 'deposit').map((e) => `${e.amount} ${e.token}`).sort();
  assert.deepEqual(dep, ['0.0005 ETH', '2 NET', '250 USDG']);
  // the baseline is saved: after a restart, a deposit made while it was off is still reported
  bal.usdg += 50n * 10n ** 6n;
  const events2 = [];
  const again = makeBot({ rpc, cfg: cfg(), store: s, log: sink(), sender: sender(), onEvent: (e) => events2.push(e) });
  await again.refreshWallet();
  assert.deepEqual(events2.filter((e) => e.kind === 'deposit').map((e) => `${e.amount} ${e.token}`), ['50 USDG']);
});

test('wallet: funds that leave without the bot sending them are flagged; its own transactions are not', async () => {
  const bal = { usdg: 300n * 10n ** 6n };
  const { rpc } = fakeRpc(bal);
  const events = [];
  const bot = makeBot({ rpc, cfg: cfg(), store: store(), log: sink(), sender: sender(), onEvent: (e) => events.push(e) });
  await bot.refreshWallet();
  await bot.sendTx('withdraw', { to: ME, data: '0x' }, 'test');   // the bot's own: the drop that follows is explained
  bal.usdg = 200n * 10n ** 6n;
  await bot.refreshWallet();
  assert.equal(events.filter((e) => e.kind === 'outflow').length, 0);
  const t = Date.now();
  const late = makeBot({ rpc, cfg: cfg(), store: store(), log: sink(), sender: sender(), onEvent: (e) => events.push(e), nowMs: () => t + 120_000 });
  await late.refreshWallet();
  bal.usdg = 50n * 10n ** 6n;                                   // nothing sent by this bot
  await late.refreshWallet();
  const out = events.filter((e) => e.kind === 'outflow');
  assert.equal(out.length, 1); assert.equal(out[0].amount, 150); assert.equal(out[0].token, 'USDG');
});

test('transactions: each one is logged (sent, then confirmed with its block and fee) and listed for the page', async () => {
  const { rpc } = fakeRpc({ allowance: 0n });
  const s = store(), log = sink(), events = [];
  const bot = makeBot({ rpc, cfg: cfg({ live: true, maxRepay: 500_000_000n }), store: s, log, sender: sender(), onEvent: (e) => events.push(e) });
  await bot.start(); await bot.scanDone(); await bot.tick();
  const kinds = s.txs().map((x) => `${x.kind}:${x.status}`);
  assert.deepEqual(kinds, ['approve:ok', 'liquidate:ok']);
  const liq = s.txs()[1];
  assert.equal(liq.block, 85_000_001); assert.equal(liq.feeEth, 0.0000042);
  assert.ok(log.lines.some((l) => /^info tx liquidate sent: full bid on 0x847f…42f3/.test(l)));
  assert.ok(log.lines.some((l) => /^info tx liquidate confirmed in block 85,000,001 · fee 0\.00000420 ETH/.test(l)));
  assert.equal(events.filter((e) => e.kind === 'tx').length, 2);
});

test('debug: a line per tick in the terminal (LOG_LEVEL=debug), never on the page', async () => {
  const { rpc } = fakeRpc();
  const log = sink();
  const real = makeLog({ debug: true }), orig = console.log; console.log = () => {};
  try { real.debug('tick 1'); real.info('hello'); } finally { console.log = orig; }
  assert.deepEqual(real.recent().map((l) => l.msg), ['hello']);
  const bot = makeBot({ rpc, cfg: cfg(), store: store(), log, seed: async () => ({ accounts: [BAD, GOOD] }) });
  await bot.start(); await bot.tick();
  assert.ok(log.lines.some((l) => /^debug tick 1 · block 84,606,976 · read 2 \(all\) loans in \d+ ms/.test(l)), log.lines.join('\n'));
});

test('RPC: when your own RPC fails, the public one answers, and your own is used again once it is back', async () => {
  let primaryDown = true;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.startsWith('https://mine.example') && primaryDown) throw new TypeError('fetch failed');
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify(body.map((c) => ({ jsonrpc: '2.0', id: c.id, result: '0x10' }))));
  };
  const flips = [];
  const rpc = makeRpc(() => ['https://mine.example/key', PUBLIC_RPC], { fetchImpl, onFallback: (on) => flips.push(on) });
  assert.equal(await rpc.one('eth_blockNumber', []), '0x10');
  assert.equal(rpc.stats().fallback, true);
  assert.equal(rpc.stats().host, 'rpc.mainnet.chain.robinhood.com');
  // while it is marked down, it isn't tried first (no 15-second wait each tick)
  calls.length = 0; await rpc.one('eth_blockNumber', []);
  assert.deepEqual(calls, [PUBLIC_RPC]);
  assert.deepEqual(flips, [true]);
});

test('intel: the market context and the wallet\'s worth at NetNet Intel\'s marks', async () => {
  const intel = makeIntel({ fetchImpl: fakeFetch() });
  const c = await intel.refresh('0x72512E63c0c70797B96902228fa8acC1211b7CeE');
  assert.equal(c.loop.loans, 2); assert.equal(c.loop.wsnetMarket, 685.4);
  assert.equal(c.liquidations.day.n, 12); assert.equal(c.liquidations.mine.rank, 1);
  const v = walletValue({ usdg: 100, wsnet: 1, net: 1, snet: 2, eth: 1 }, c.loop);
  assert.equal(Math.round(v.total * 100) / 100, Math.round((100 + 685.4 + 199.83 * 3) * 100) / 100);
});

// A tiny JSON-RPC node for ethers' JsonRpcProvider: enough to sign and send a transaction.
async function miniNode(onRaw) {
  const srv = createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
      const one = (c) => {
        const r = { eth_chainId: '0x1237', eth_blockNumber: '0x1', eth_getTransactionCount: '0x7', eth_gasPrice: '0x131a230', eth_maxPriorityFeePerGas: '0x0', eth_estimateGas: '0x5208',
          eth_getBlockByNumber: { number: '0x1', hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), baseFeePerGas: '0x131a230', timestamp: '0x1', nonce: '0x0000000000000000',
            difficulty: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x0', miner: '0x' + '00'.repeat(20), extraData: '0x', transactions: [] } }[c.method];
        if (c.method === 'eth_sendRawTransaction') { onRaw(c.params[0]); return { jsonrpc: '2.0', id: c.id, result: Transaction.from(c.params[0]).hash }; }
        return r === undefined ? { jsonrpc: '2.0', id: c.id, error: { code: -32601, message: c.method } } : { jsonrpc: '2.0', id: c.id, result: r };
      };
      const j = JSON.parse(b); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j)));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}

test('sending: the signed transaction goes to the RPC and to the sequencer together; one accepting is enough', async () => {
  const rawAtRpc = [], rawAtSeq = [];
  const node = await miniNode((raw) => rawAtRpc.push(raw));
  try {
    const w = new Wallet('0x' + '44'.repeat(32));
    const seqFetch = async (url, init) => { const j = JSON.parse(init.body); rawAtSeq.push(j.params[0]); assert.equal(j.method, 'eth_sendRawTransaction'); return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' })); };
    const s = senderOf(w, node.url, { sequencerUrl: 'https://sequencer.example', fetchImpl: seqFetch });
    const r = await s.send({ to: ME, value: 1n });
    for (let i = 0; i < 50 && !rawAtRpc.length; i++) await new Promise((x) => setTimeout(x, 20));   // the slower of the two still arrives
    assert.equal(rawAtSeq.length, 1); assert.equal(rawAtRpc.length, 1);
    assert.equal(rawAtSeq[0], rawAtRpc[0], 'the same signed transaction: it can only land once');
    const tx = Transaction.from(rawAtSeq[0]);
    assert.equal(tx.hash, r.hash); assert.equal(tx.chainId, 4663n); assert.equal(tx.nonce, 7); assert.equal(tx.from, w.address);
    // the sequencer refusing doesn't stop a send the RPC took
    const s2 = senderOf(w, node.url, { sequencerUrl: 'https://sequencer.example', fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'nope' } })) });
    assert.match((await s2.send({ to: ME, value: 1n })).hash, /^0x[0-9a-f]{64}$/);
  } finally { node.close(); }
});

test('review fix: a bid uses this tick\'s USDG read; an unread balance means no bid, not the last good one', async () => {
  const chain = { usdg: 1000n * 10n ** 6n, allowance: 10n ** 12n };
  const { rpc } = fakeRpc(chain);
  const s = sender();
  const bot = makeBot({ rpc, cfg: cfg({ live: true, maxRepay: 500_000_000n, reserve: 500_000_000n }), store: store(), log: sink(), sender: s });
  await bot.start(); await bot.scanDone(); await bot.refreshWallet();
  chain.usdg = 550n * 10n ** 6n; chain.usdgError = true;          // the balance fell, and this read fails
  const r = await bot.tick();
  assert.equal(s.sent.length, 0, 'nothing sent on a stale balance');
  assert.ok(!r.results?.some((x) => x.sent));
  assert.equal(bot.status().wallet.usdg, 1000, 'the page still shows the last good read');
});

test('review fix: a node that has not reached the range end is refused, so the borrower scan never skips a Borrow', async () => {
  const chain = { nodeHead: 0x50b0000 };
  const { rpc } = fakeRpc(chain);
  const { scanBorrowers } = await import('../src/chain.mjs');
  await assert.rejects(scanBorrowers(rpc, 84_000_000, 0x50b0000 + 100, { range: 10_000_000 }), /RPC node is behind/);
  assert.equal((await scanBorrowers(rpc, 84_000_000, 0x50b0000, { range: 10_000_000 })).size, 2);
});

test('review fix: the bot\'s own transaction is not an "outflow" until a read at its block, however long that takes', async () => {
  const chain = { usdg: 300n * 10n ** 6n };
  const { rpc } = fakeRpc(chain);
  const events = [];
  let t = Date.now();
  const s = sender();
  s.send = async (tx) => { s.sent.push(tx); return { hash: '0x' + 'cd'.repeat(32), wait: async () => ({ status: 1, logs: [], blockNumber: 0x50b0000 + 10 }) }; };
  const bot = makeBot({ rpc, cfg: cfg(), store: store(), log: sink(), sender: s, onEvent: (e) => events.push(e), nowMs: () => t });
  await bot.refreshWallet();
  await bot.sendTx('withdraw', { to: ME, data: '0x' }, 'test');
  chain.usdg = 100n * 10n ** 6n;
  t += 10 * 60_000;                                                // minutes later, reads still from before its block
  await bot.refreshWallet();
  assert.equal(events.filter((e) => e.kind === 'outflow').length, 0);
  chain.nodeHead = 0x50b0000 + 10; await bot.refreshWallet();      // the read at its block settles it
  chain.usdg = 40n * 10n ** 6n; chain.nodeHead += 1; await bot.refreshWallet();   // a later drop is news
  assert.deepEqual(events.filter((e) => e.kind === 'outflow').map((e) => e.amount), [60]);
});

test('review fix: a read from a node behind the last one is ignored (no false deposit or outflow)', async () => {
  const chain = { usdg: 300n * 10n ** 6n, nodeHead: 0x50b0000 + 5 };
  const { rpc } = fakeRpc(chain);
  const events = [];
  const bot = makeBot({ rpc, cfg: cfg(), store: store(), log: sink(), sender: sender(), onEvent: (e) => events.push(e) });
  await bot.refreshWallet();
  chain.usdg = 200n * 10n ** 6n; chain.nodeHead = 0x50b0000;         // an older node, before a deposit it hasn't seen
  await bot.refreshWallet();
  assert.equal(events.length, 0);
});

test('review fix: sends go one at a time, and one queued before a pause is not sent', async () => {
  const { rpc } = fakeRpc();
  const s = sender(); let inFlight = 0, most = 0;
  const orig = s.send; s.send = async (tx) => { inFlight++; most = Math.max(most, inFlight); await new Promise((r) => setTimeout(r, 20)); inFlight--; return orig(tx); };
  const bot = makeBot({ rpc, cfg: cfg({ live: true }), store: store(), log: sink(), sender: s });
  let live = true;
  const check = () => { if (!live) throw new Error('paused'); };
  const a = bot.sendTx('approve', { to: ME, data: '0x' }, 'a', { check }), b = bot.sendTx('liquidate', { to: ME, data: '0x' }, 'b', { check });
  await new Promise((r) => setTimeout(r, 5));                       // a is on its way; b waits its turn
  live = false;
  await a.catch(() => null); await assert.rejects(b, /paused/);
  assert.equal(most, 1);
});

test('review fix: with your RPC down, sending goes through the next one', async () => {
  const raws = [];
  const node = await miniNode((raw) => raws.push(raw));
  try {
    const s = senderOf(new Wallet('0x' + '55'.repeat(32)), ['http://127.0.0.1:9', node.url], { sequencerUrl: null });
    const r = await s.send({ to: ME, value: 1n });
    assert.equal(raws.length, 1); assert.equal(Transaction.from(raws[0]).hash, r.hash);
  } finally { node.close(); }
});

test('review fix: a revert is never retried on another node, even when its calldata contains "503"', async () => {
  const { isNetErr } = await import('../src/runner.mjs');
  const revert = Object.assign(new Error('execution reverted (transaction={ "data": "0xabc503def" })'), { code: 'CALL_EXCEPTION', shortMessage: 'execution reverted: "position is healthy"' });
  assert.equal(isNetErr(revert), false);
  assert.equal(isNetErr(Object.assign(new Error('x'), { code: 'UNKNOWN_ERROR', shortMessage: 'could not coalesce error', message: 'calldata 0x503' })), false);
  assert.equal(isNetErr(Object.assign(new Error('x'), { code: 'TIMEOUT', shortMessage: 'request timeout' })), true);
  assert.equal(isNetErr(new TypeError('fetch failed')), false, 'only ethers-shaped errors here; makeRpc handles raw fetch');
  assert.equal(isNetErr(Object.assign(new Error('fetch failed'), { shortMessage: 'fetch failed' })), true);
});

test('review fix: a late-landing transaction of the bot\'s own is not an outflow, even after an earlier one settled', async () => {
  const chain = { usdg: 300n * 10n ** 6n };
  const { rpc } = fakeRpc(chain);
  const events = [];
  const s = sender(); let n = 0;
  s.send = async (tx) => { n++; const blk = n === 1 ? 0x50b0000 : null; return { hash: '0x' + String(n).padStart(64, 'e'), wait: async () => (blk ? { status: 1, logs: [], blockNumber: blk } : null) }; };
  const bot = makeBot({ rpc, cfg: cfg(), store: store(), log: sink(), sender: s, onEvent: (e) => events.push(e) });
  await bot.refreshWallet();
  await bot.sendTx('withdraw', { to: ME, data: '0x' }, 'confirmed');
  await bot.refreshWallet();                                        // settles the first
  await bot.sendTx('withdraw', { to: ME, data: '0x' }, 'unconfirmed');
  await bot.refreshWallet();
  chain.usdg = 100n * 10n ** 6n; chain.nodeHead = 0x50b0000 + 3;     // the second lands later
  await bot.refreshWallet();
  assert.equal(events.filter((e) => e.kind === 'outflow').length, 0);
});

test('review fix: after a restart, an old transaction does not hide a real outflow', async () => {
  const chain = { usdg: 300n * 10n ** 6n };
  const { rpc } = fakeRpc(chain);
  const st = store();
  const first = makeBot({ rpc, cfg: cfg(), store: st, log: sink(), sender: sender() });
  await first.sendTx('withdraw', { to: ME, data: '0x' }, 'a day ago');
  await new Promise((r) => setTimeout(r, 5));
  await first.refreshWallet();                                      // balances saved after it
  const events = [];
  const again = makeBot({ rpc, cfg: cfg(), store: st, log: sink(), sender: sender(), onEvent: (e) => events.push(e) });
  chain.usdg = 100n * 10n ** 6n;
  await again.refreshWallet();
  assert.deepEqual(events.filter((e) => e.kind === 'outflow').map((e) => e.amount), [200]);
});
