// What the local page saves, in the data volume, owner-only (0600):
//   settings.json  the owner's choices: limits, payout address, RPC, live, pause, Telegram pairing, backup confirmed
//   auth.json      the page password's scrypt hash (the password itself is never stored)
//   .unlock        only when the owner turns on "stay unlocked after restarts": the keystore password, so the bot can
//                  start on its own after a reboot. Off by default.
// Environment variables still work and win over the page (the page shows those settings as fixed).
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(_scrypt);
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }
function writePrivate(file, text) {
  mkdirSync(file.replace(/\/[^/]+$/, ''), { recursive: true });
  writeFileSync(file + '.tmp', text, { mode: 0o600 });
  renameSync(file + '.tmp', file);
  try { chmodSync(file, 0o600); } catch { /* fine */ }
}

// the setting names as the environment spells them: settings.json uses the same keys
export const SETTING_KEYS = ['LIVE', 'MAX_REPAY_USDG', 'RESERVE_USDG', 'MIN_PROFIT_USDG', 'ALLOW_PARTIAL', 'PAYOUT_ADDRESS', 'RPC_URL', 'LOGS_RPC_URL', 'TICK_SECONDS'];

export function makeSettings(dir) {
  const file = `${dir}/settings.json`, authFile = `${dir}/auth.json`, unlockFile = `${dir}/.unlock`;
  let s = readJson(file) || {};
  const save = () => writePrivate(file, JSON.stringify(s, null, 2));
  return {
    get: () => ({ ...s }),
    set(patch) { s = { ...s, ...patch }; for (const k of Object.keys(s)) if (s[k] === undefined) delete s[k]; save(); return { ...s }; },
    // the page password
    hasPassword: () => !!readJson(authFile)?.hash,
    async setPassword(pw) {
      const salt = randomBytes(16);
      const hash = await scrypt(pw, salt, 64, SCRYPT);
      writePrivate(authFile, JSON.stringify({ salt: salt.toString('hex'), hash: hash.toString('hex'), n: SCRYPT.N }));
    },
    async checkPassword(pw) {
      const a = readJson(authFile);
      if (!a?.hash || typeof pw !== 'string') return false;
      const h = await scrypt(pw, Buffer.from(a.salt, 'hex'), 64, { ...SCRYPT, N: a.n || SCRYPT.N });
      return timingSafeEqual(h, Buffer.from(a.hash, 'hex'));
    },
    // stay unlocked after restarts (opt-in)
    unlockSaved: () => existsSync(unlockFile),
    readUnlock: () => { try { return readFileSync(unlockFile, 'utf8'); } catch { return null; } },
    saveUnlock: (pw) => writePrivate(unlockFile, pw),
    clearUnlock: () => { try { rmSync(unlockFile); } catch { /* none */ } },
  };
}

/** The environment as configFrom reads it: the page's settings, with any non-empty environment variable on top. */
export function effectiveEnv(env, saved) {
  const out = { ...env };
  const fixed = [];
  for (const k of SETTING_KEYS) {
    const e = env[k];
    if (e != null && e !== '') { fixed.push(k); continue; }
    if (saved[k] != null && saved[k] !== '') out[k] = String(saved[k]);
  }
  return { env: out, fixed };
}
