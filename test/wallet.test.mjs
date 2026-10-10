// The keystore: made, loaded with its password, never overwritten; a raw key as the fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newWallet, importKey, loadWallet, keySource } from '../src/wallet.mjs';
import { configFrom } from '../src/config.mjs';

const KEY = '0x' + '11'.repeat(32);

test('new-wallet saves an encrypted keystore (owner-only file) that loads with its password and is never replaced', async () => {
  const DATA_DIR = mkdtempSync(join(tmpdir(), 'liq-'));
  const env = { DATA_DIR, KEYSTORE_PASSWORD: 'correct horse' };
  const w = await newWallet(env);
  assert.match(w.address, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(statSync(w.file).mode & 0o777, 0o600);
  assert.ok(!readFileSync(w.file, 'utf8').includes(w.phrase?.split(' ')[0] + ' '));
  assert.equal((await loadWallet(env)).address, w.address);
  await assert.rejects(loadWallet({ DATA_DIR, KEYSTORE_PASSWORD: 'wrong password' }), /password is wrong/);
  await assert.rejects(newWallet(env), /already exists/);
  await assert.rejects(loadWallet({ DATA_DIR }), /no password/);
  // Compose passes an empty KEYSTORE_PASSWORD= as "": it counts as unset, so the password file is used
  const pwFile = join(DATA_DIR, 'pw.txt'); writeFileSync(pwFile, 'correct horse\n');
  assert.equal((await loadWallet({ DATA_DIR, KEYSTORE_PASSWORD: '', KEYSTORE_PASSWORD_FILE: pwFile })).address, w.address);
  await assert.rejects(newWallet({ DATA_DIR: mkdtempSync(join(tmpdir(), 'liq-')), KEYSTORE_PASSWORD: '' }), /run with a terminal/);
});

test('import-key encrypts an existing key; the raw key alone also works', async () => {
  const DATA_DIR = mkdtempSync(join(tmpdir(), 'liq-'));
  const w = await importKey({ DATA_DIR, PRIVATE_KEY: KEY, KEYSTORE_PASSWORD: 'long enough' });
  assert.ok(!readFileSync(w.file, 'utf8').includes('11'.repeat(32)));
  assert.equal(keySource({ DATA_DIR }).kind, 'keystore');
  assert.equal((await loadWallet({ DATA_DIR: mkdtempSync(join(tmpdir(), 'liq-')), PRIVATE_KEY: KEY })).address, w.address);
  await assert.rejects(loadWallet({ DATA_DIR: mkdtempSync(join(tmpdir(), 'liq-')), PRIVATE_KEY: '0x1234' }), /32-byte/);
  await assert.rejects(importKey({ DATA_DIR: mkdtempSync(join(tmpdir(), 'liq-')), PRIVATE_KEY: KEY, KEYSTORE_PASSWORD: 'short' }), /8 characters/);
});

test('settings: dry run by default, bad numbers refused', () => {
  const c = configFrom({});
  assert.equal(c.live, false);
  assert.equal(c.maxRepay, null);
  assert.equal(configFrom({ LIVE: '1', MAX_REPAY_USDG: '250.5' }).maxRepay, 250_500_000n);
  assert.throws(() => configFrom({ MIN_PROFIT_USDG: 'lots' }), /MIN_PROFIT_USDG/);
  assert.throws(() => configFrom({ PAYOUT_ADDRESS: '0x123' }), /PAYOUT_ADDRESS/);
});
