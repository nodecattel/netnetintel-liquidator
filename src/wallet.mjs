// The bot's wallet, on the owner's machine only. Two ways in, keystore first:
//   1. an encrypted keystore (KEYSTORE_FILE, default /data/keystore.json) with its password from KEYSTORE_PASSWORD,
//      KEYSTORE_PASSWORD_FILE (a Docker secret), or typed at the prompt when run with a terminal;
//   2. a raw key from PRIVATE_KEY or PRIVATE_KEY_FILE.
// `new-wallet` makes a fresh keystore; `import-key` encrypts an existing key into one. The key is never logged, never
// sent anywhere, and never written to disk unencrypted.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Wallet } from 'ethers';

const read = (f) => readFileSync(f, 'utf8').trim();
// an empty setting (Compose passes `KEYSTORE_PASSWORD=` through as "") counts as not set
const val = (x) => (x == null || x === '' ? null : x);
const passwordOf = (env) => val(env.KEYSTORE_PASSWORD) ?? (val(env.KEYSTORE_PASSWORD_FILE) ? read(env.KEYSTORE_PASSWORD_FILE) : null);

export function keySource(env) {
  const ks = env.KEYSTORE_FILE || `${env.DATA_DIR || '/data'}/keystore.json`;
  if (existsSync(ks)) return { kind: 'keystore', file: ks };
  if (env.PRIVATE_KEY || env.PRIVATE_KEY_FILE) return { kind: 'key', file: ks };
  return { kind: 'none', file: ks };
}

export async function loadWallet(env, { prompt } = {}) {
  const src = keySource(env);
  if (src.kind === 'keystore') {
    let pw = passwordOf(env);
    if (pw == null && prompt) pw = await prompt('Keystore password: ', { hidden: true });
    if (pw == null) throw new Error(`a keystore is at ${src.file} but no password was given (KEYSTORE_PASSWORD or KEYSTORE_PASSWORD_FILE)`);
    try { return await Wallet.fromEncryptedJson(read(src.file), pw); }
    catch { throw new Error('the keystore password is wrong, or the keystore file is damaged'); }
  }
  if (src.kind === 'key') {
    const pk = (env.PRIVATE_KEY || read(env.PRIVATE_KEY_FILE)).trim();
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(pk)) throw new Error('PRIVATE_KEY is not a 32-byte hex key');
    return new Wallet(pk.startsWith('0x') ? pk : '0x' + pk);
  }
  return null;
}

async function newPassword(env, prompt) {
  const given = passwordOf(env);
  if (given != null) { if (given.length < 8) throw new Error('use a password of at least 8 characters'); return given; }
  if (!prompt) throw new Error('set KEYSTORE_PASSWORD, or run with a terminal (docker run -it) to type one');
  const a = await prompt('Choose a keystore password (8+ characters): ', { hidden: true });
  if (a.length < 8) throw new Error('use a password of at least 8 characters');
  const b = await prompt('Type it again: ', { hidden: true });
  if (a !== b) throw new Error('the two passwords differ');
  return a;
}

function save(file, json) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, json, { mode: 0o600, flag: 'wx' });   // never overwrite an existing keystore
}

export async function newWallet(env, prompt) {
  const src = keySource(env);
  if (src.kind === 'keystore') throw new Error(`a keystore already exists at ${src.file}; the bot won't replace it`);
  const pw = await newPassword(env, prompt);
  const w = Wallet.createRandom();
  save(src.file, await w.encrypt(pw));
  return { address: w.address, phrase: w.mnemonic?.phrase ?? null, file: src.file };
}

export async function importKey(env, prompt) {
  const src = keySource(env);
  if (src.kind === 'keystore') throw new Error(`a keystore already exists at ${src.file}; the bot won't replace it`);
  let pk = val(env.PRIVATE_KEY) || (val(env.PRIVATE_KEY_FILE) ? read(env.PRIVATE_KEY_FILE) : null);
  if (!pk && prompt) pk = await prompt('Private key (hidden): ', { hidden: true });
  pk = String(pk || '').trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(pk)) throw new Error('that is not a 32-byte hex private key');
  const w = new Wallet(pk.startsWith('0x') ? pk : '0x' + pk);
  const pw = await newPassword(env, prompt);
  save(src.file, await w.encrypt(pw));
  return { address: w.address, file: src.file };
}

/** A terminal prompt that can hide what is typed (for keys and passwords). null when there is no terminal. */
export function terminalPrompt() {
  if (!process.stdin.isTTY) return null;
  return (question, { hidden = false } = {}) => new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    let buf = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stdout.write('\n'); return resolve(buf); }
        if (c === '\u0003') { stdout.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') { if (buf.length) { buf = buf.slice(0, -1); if (!hidden) stdout.write('\b \b'); } continue; }
        buf += c; if (!hidden) stdout.write(c);
      }
    };
    stdin.on('data', onData);
  });
}
