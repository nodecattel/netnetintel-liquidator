// One copy at a time: the instance lock in /data (newest wins, an older copy resumes when the newer goes quiet), and the
// relay's word that a newer copy with the same Telegram link is running.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeInstanceLock, LOCK_STALE_MS } from '../src/runner.mjs';
import { makeRelay } from '../src/relay.mjs';

test('instance lock: the newest copy takes it, the older stands down, and takes over again when the newer goes quiet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'liq-')), t = { now: 1_000_000 };
  const now = () => t.now;
  const old = makeInstanceLock(dir, { id: 'aaaaaa', startedAt: 1, now });
  assert.equal(old.check(), false, 'alone: it holds the lock');
  const neu = makeInstanceLock(dir, { id: 'bbbbbb', startedAt: 2, now });
  assert.equal(neu.check(), false, 'the newer copy takes the lock');
  assert.equal(old.check(), true, 'the older copy sees a newer one and stands down');
  t.now += 30_000; assert.equal(neu.check(), false); assert.equal(old.check(), true);
  t.now += LOCK_STALE_MS + 1;                       // the newer copy stopped beating
  assert.equal(old.check(), false, 'the older one takes over again');
  assert.equal(neu.check(), false, 'and a newer copy that comes back takes it back (newest wins)');
  assert.equal(old.check(), true);
});

test('relay: the poll carries this copy\'s id and start time; "superseded" from NetNet Intel is followed', async () => {
  const bodies = [];
  let answer = { ok: true, pause: false, superseded: true };
  const fetchImpl = async (_u, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify(answer)); };
  const r = makeRelay({ getToken: () => 'nnlq_' + 'a'.repeat(43), version: '1.4.2', instance: { id: 'abcdef', startedAt: 5 }, fetchImpl });
  await r.poll({ live: true }, 0, true);
  assert.deepEqual(bodies[0].inst, { id: 'abcdef', startedAt: 5 });
  assert.equal(r.superseded, true);
  answer = { ok: true, pause: false };
  await r.poll({ live: true }, 1, true);
  assert.equal(r.superseded, false, 'the newer copy went quiet: this one carries on');
});
