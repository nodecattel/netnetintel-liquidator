// The local page end to end, over HTTP against a fake chain: first-visit password, a new wallet saved only after the
// three-word check, limits, the live gate, payout and withdraw needing the password, Telegram pairing, and the
// protections (other sites, other hosts, no session, too many wrong passwords).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { makeRunner } from '../src/runner.mjs';
import { startServer } from '../src/server.mjs';
import { fakeFetch, fakeSender, quiet } from './fake.mjs';
import { ERC20, MORPHO_IFACE } from '../src/chain.mjs';
import { USDG } from '../src/constants.mjs';

const PW = 'correct horse battery';
const MAIN = '0x1234567890123456789012345678901234567890';

async function boot(opts = {}) {
  const DATA_DIR = mkdtempSync(join(tmpdir(), 'liqpage-'));
  const senders = [];
  const runner = await makeRunner({ env: { DATA_DIR, ...(opts.env || {}) }, log: quiet, fetchImpl: fakeFetch(opts.fetch || {}), makeSender: (w) => { const s = fakeSender(w.address); senders.push(s); return s; } });
  const server = startServer({ runner, port: 0, host: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port, base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const call = async (path, body, headers = {}) => {
    const r = await fetch(base + path, body === undefined ? { headers: { cookie, ...headers } }
      : { method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie, ...headers }, body: JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
  };
  return { DATA_DIR, runner, server, call, base, senders, close: () => server.close(), logout: () => { cookie = ''; } };
}

test('first visit → password → new wallet (saved only after the 3-word check) → limits → live gate', async () => {
  const p = await boot();
  try {
    assert.equal((await p.call('/api/state')).body.auth, 'setup');
    assert.equal((await p.call('/api/password', { password: 'short' })).status, 400);
    assert.equal((await p.call('/api/password', { password: PW })).status, 200);
    const st0 = (await p.call('/api/state')).body;
    assert.equal(st0.auth, 'ok'); assert.equal(st0.wallet.exists, false);
    assert.equal(statSync(join(p.DATA_DIR, 'auth.json')).mode & 0o777, 0o600);
    assert.ok(!readFileSync(join(p.DATA_DIR, 'auth.json'), 'utf8').includes(PW));

    const mk = (await p.call('/api/wallet/create', {})).body;
    assert.equal(mk.phrase.split(' ').length, 12); assert.equal(mk.check.length, 3);
    assert.equal(existsSync(join(p.DATA_DIR, 'keystore.json')), false, 'nothing saved before the check');
    const words = mk.phrase.split(' ');
    const wrong = Object.fromEntries(mk.check.map((i) => [i, 'nope']));
    assert.equal((await p.call('/api/wallet/confirm', { words: wrong })).status, 400);
    const right = Object.fromEntries(mk.check.map((i) => [i, words[i].toUpperCase() + ' ']));
    assert.equal((await p.call('/api/wallet/confirm', { words: right })).body.address, mk.address);
    assert.equal(statSync(join(p.DATA_DIR, 'keystore.json')).mode & 0o777, 0o600);
    assert.ok(!readFileSync(join(p.DATA_DIR, 'keystore.json'), 'utf8').includes(words[0] + ' ' + words[1]));
    assert.equal((await p.call('/api/wallet/create', {})).status, 409, 'never a second wallet over the first');

    // live needs a limit first, and LIVE typed
    assert.match((await p.call('/api/live', { on: true, confirm: 'LIVE' })).body.error, /most one liquidation/);
    assert.equal((await p.call('/api/settings', { maxRepayUsdg: 0 })).status, 400);
    const s = (await p.call('/api/settings', { maxRepayUsdg: 250, reserveUsdg: 5, minProfitUsdg: 0.5, allowPartial: false })).body;
    assert.equal(s.maxRepayUsdg, 250); assert.equal(s.allowPartial, false);
    assert.equal((await p.call('/api/live', { on: true, confirm: 'live?' })).status, 400);
    assert.equal((await p.call('/api/live', { on: true, confirm: 'LIVE' })).body.live, true);
    assert.equal(p.runner.cfg.live, true);
    assert.equal(p.runner.cfg.maxRepay, 250_000_000n);

    // an RPC with a key is saved but never echoed back
    assert.equal((await p.call('/api/settings', { rpcUrl: 'https://robinhood.example/abc123secretkey' })).status, 401, 'an RPC change needs the password');
    await p.call('/api/settings', { rpcUrl: 'https://robinhood.example/abc123secretkey', password: PW });
    const shown = (await p.call('/api/state')).body.settings.rpcUrl;
    assert.ok(!shown.includes('abc123secretkey'), shown);
    assert.equal((await p.call('/api/settings', { rpcUrl: 'http://plain.example', password: PW })).status, 400);
  } finally { p.close(); }
});

test('payout and withdraw need the password; withdraw only to the saved address', async () => {
  const p = await boot();
  try {
    await p.call('/api/password', { password: PW });
    await p.call('/api/wallet/import', { secret: '0x' + '11'.repeat(32) });
    assert.equal((await p.call('/api/settings', { payoutAddress: MAIN })).status, 401);
    assert.equal((await p.call('/api/settings', { payoutAddress: MAIN, password: 'wrong one!!' })).status, 401);
    const me = (await p.call('/api/state')).body.wallet.address;
    assert.equal((await p.call('/api/settings', { payoutAddress: me, password: PW })).status, 400, 'not the bot\'s own address');
    assert.equal((await p.call('/api/settings', { payoutAddress: MAIN, password: PW })).body.payoutAddress, MAIN);
    assert.equal((await p.call('/api/withdraw', { what: 'usdg', password: 'nope nope nope' })).status, 401);
    const w = (await p.call('/api/withdraw', { what: 'usdg', password: PW, to: '0x9999999999999999999999999999999999999999' })).body;
    assert.equal(w.to, MAIN);
    const s = p.senders.at(-1);
    const [to, amount] = ERC20.decodeFunctionData('transfer', s.sent[0].data);
    assert.equal(s.sent[0].to, USDG); assert.equal(to, MAIN); assert.equal(amount, 1000n * 10n ** 6n);
  } finally { p.close(); }
});

test('protections: other sites, other hosts, no session, and five wrong passwords a minute', async () => {
  const p = await boot();
  try {
    await p.call('/api/password', { password: PW });
    assert.equal((await p.call('/api/settings', { maxRepayUsdg: 9 }, { origin: 'https://evil.example' })).status, 403);
    // DNS rebinding: a request that reaches the port under another name is refused
    const port = p.server.address().port;
    const status = await new Promise((res) => request({ host: '127.0.0.1', port, path: '/api/state', headers: { host: 'evil.example:' + port } }, (r) => { r.resume(); res(r.statusCode); }).end());
    assert.equal(status, 403);
    const csp = (await p.call('/api/state')).headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/); assert.match(csp, /frame-ancestors 'none'/);
    p.logout();
    assert.equal((await p.call('/api/state')).body.auth, 'login');
    assert.equal((await p.call('/api/wallet/create', {})).status, 401);
    for (let i = 0; i < 5; i++) assert.equal((await p.call('/api/login', { password: 'wrong ' + i })).status, 401);
    assert.equal((await p.call('/api/login', { password: PW })).status, 429);
  } finally { p.close(); }
});

test('after a restart the wallet is locked until login; "stay unlocked" opens it by itself', async () => {
  const p = await boot();
  const dir = p.DATA_DIR;
  await p.call('/api/password', { password: PW });
  await p.call('/api/wallet/import', { secret: '0x' + '22'.repeat(32) });
  p.close();
  const p2 = await boot({ env: { DATA_DIR: dir } });
  try {
    assert.equal(p2.runner.wallet, null);
    assert.equal((await p2.call('/api/login', { password: PW })).status, 200);
    assert.ok(p2.runner.wallet, 'login unlocks it');
    assert.equal((await p2.call('/api/stay-unlocked', { on: true, password: PW })).body.stayUnlocked, true);
    assert.equal(statSync(join(dir, '.unlock')).mode & 0o777, 0o600);
  } finally { p2.close(); }
  const p3 = await boot({ env: { DATA_DIR: dir } });
  try { assert.ok(p3.runner.wallet, 'unlocked at start'); } finally { p3.close(); }
});

test('Telegram: a pairing code links reports and pause; Telegram\'s pause stops sending', async () => {
  const code = 'nnlq_' + 'A'.repeat(43);
  const p = await boot({ fetch: { relayToken: code, relayPause: true } });
  try {
    await p.call('/api/password', { password: PW });
    assert.equal((await p.call('/api/pair', { code: 'not-a-code' })).status, 400);
    assert.equal((await p.call('/api/pair', { code: 'nnlq_' + 'B'.repeat(43) })).status, 400, 'an unknown code is refused');
    assert.equal((await p.call('/api/pair', { code })).body.linked, true);
    const st = (await p.call('/api/state')).body;
    assert.equal(st.telegram.linked, true); assert.equal(st.telegram.paused, true);
    assert.equal(JSON.stringify(st).includes(code), false, 'the code is never sent back to the page');
    assert.equal(p.runner.relay.paused, true);
  } finally { p.close(); }
});

test('the loop through the runner: live and unlocked, it liquidates the loan past the line', async () => {
  const p = await boot();
  try {
    await p.call('/api/password', { password: PW });
    await p.call('/api/wallet/import', { secret: '0x' + '33'.repeat(32) });
    await p.call('/api/settings', { maxRepayUsdg: 500 });
    await p.call('/api/live', { on: true, confirm: 'LIVE' });
    await p.runner.bot.start();
    const r = await p.runner.bot.tick();
    assert.equal(r.results[0].sent, true);
    const s = p.senders.at(-1);
    const liq = s.sent.find((t) => t.data.startsWith(MORPHO_IFACE.getFunction('liquidate').selector));
    assert.ok(liq);
    const st = (await p.call('/api/state')).body;
    assert.equal(st.history.length, 1);
    assert.equal(st.events.some((e) => e.kind === 'liquidated'), true);
    // paused from the page: watching, nothing sent
    await p.call('/api/pause', { paused: true });
    const before = s.sent.length;
    await new Promise((r2) => setTimeout(r2, 20));
    const r2 = await p.runner.bot.tick();
    assert.equal(s.sent.length, before);
    assert.ok(!r2.results?.some((x) => x.sent));
  } finally { p.close(); }
});

test('review fixes: parallel password guesses are capped; LIVE from the environment can\'t be flipped from the page', async () => {
  const p = await boot({ env: { LIVE: '1' } });
  try {
    await p.call('/api/password', { password: PW });
    p.logout();
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => p.call('/api/login', { password: 'guess number ' + i })));
    const tried = rs.filter((r) => r.status !== 429).length;
    assert.ok(tried <= 6, `${tried} guesses got through in parallel`);
    await new Promise((r) => setTimeout(r, 10));
  } finally { p.close(); }
  const q = await boot({ env: { LIVE: '1' } });
  try {
    await q.call('/api/password', { password: PW });
    const r = await q.call('/api/live', { on: false });
    assert.equal(r.status, 409); assert.match(r.body.error, /environment/);
    assert.equal(q.runner.cfg.live, true);
  } finally { q.close(); }
});
