// Releases: RELEASE.json (what NetNet Intel's /api/v1/liquidator announces) always names this package's version, and the
// page learns of a newer one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { olderThan, VERSION } from '../src/runner.mjs';
import { makeIntel } from '../src/intel.mjs';

test('RELEASE.json names this version, with a one-line note', () => {
  const r = JSON.parse(readFileSync(new URL('../RELEASE.json', import.meta.url), 'utf8'));
  assert.equal(r.version, VERSION, 'bump RELEASE.json with package.json: it is what tells everyone to update');
  assert.equal(typeof r.urgent, 'boolean');
  assert.ok(typeof r.note === 'string' && r.note.length > 10 && r.note.length <= 300);
  assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
});

test('versions compare by number, not text', () => {
  assert.equal(olderThan('1.4.10', '1.5.0'), true);
  assert.equal(olderThan('1.10.0', '1.9.9'), false);
  assert.equal(olderThan('1.5.1', '1.5.1'), false);
  assert.equal(olderThan('1.5.0', '1.5.1'), true);
});

test('the release check reads NetNet Intel\'s /liquidator and keeps only what it understands', async () => {
  const fetchImpl = async (url) => new Response(JSON.stringify(String(url).endsWith('/liquidator')
    ? { latest: '9.9.9', urgent: true, note: 'x'.repeat(500), update: { macLinux: 'curl … | sh', windows: 'https://example/start.bat' } } : {}));
  const r = await makeIntel({ fetchImpl }).release();
  assert.equal(r.latest, '9.9.9'); assert.equal(r.urgent, true); assert.equal(r.note.length, 300); assert.equal(r.macLinux, 'curl … | sh');
  const bad = await makeIntel({ fetchImpl: async () => new Response(JSON.stringify({ latest: '<script>' })) }).release();
  assert.equal(bad, null);
});
