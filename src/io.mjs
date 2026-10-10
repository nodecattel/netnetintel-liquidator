// The bot's small state file (borrowers found so far, the scan cursor, what it has done), the log, and optional
// Telegram alerts. Nothing here leaves the owner's machine except the Telegram messages the owner turned on.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';

export function makeStore(dir) {
  const file = `${dir}/state.json`;
  let s;
  try { s = JSON.parse(readFileSync(file, 'utf8')); } catch { s = null; }
  if (!s || s.v !== 1) s = { v: 1, cursor: null, borrowers: [], history: [] };
  s.txs ||= []; s.wallet ||= null;
  // a transaction still waiting when the bot stopped: its outcome is on the explorer, not here
  for (const t of s.txs) if (t.status === 'pending') t.status = 'unknown';
  const save = () => {
    try { mkdirSync(dir, { recursive: true }); writeFileSync(file + '.tmp', JSON.stringify(s)); renameSync(file + '.tmp', file); } catch { /* a read-only disk: keep going in memory */ }
  };
  return {
    get cursor() { return s.cursor; },
    borrowers: () => s.borrowers,
    history: () => s.history,
    setScan(cursor, borrowers) { s.cursor = cursor; s.borrowers = [...borrowers]; save(); },
    record(entry) { s.history.push(entry); if (s.history.length > 500) s.history = s.history.slice(-500); save(); },
    // every transaction the bot sent (approvals, liquidations, payouts, withdrawals): a record is saved again as it settles
    txs: () => s.txs,
    recordTx(rec) { if (!s.txs.includes(rec)) { s.txs.push(rec); if (s.txs.length > 300) s.txs = s.txs.slice(-300); } save(); },
    // the bot wallet's balances at the last read: a deposit made while the bot was off is still reported once it is back
    walletSeen: () => s.wallet,
    setWalletSeen(address, bal) { s.wallet = { address, bal, at: Date.now() }; save(); },
    heartbeat() { try { writeFileSync(`${dir}/heartbeat`, String(Date.now())); } catch { /* ignore */ } },
  };
}

// An RPC address can carry an API key in its path or query: anything logged shows the host only (explorer links stay).
export const redactUrls = (m) => String(m).replace(/https?:\/\/([^\/\s"'?#]+)[^\s"']*/g, (u, host) => (/^(robin\.etherscan\.io|localhost(:\d+)?|127\.0\.0\.1(:\d+)?|github\.com|netnetintel\.com|t\.me)$/i.test(host) ? u : `https://${host}/…`));
// The terminal log (docker logs netnet-liq). LOG_LEVEL=debug adds a line per tick (block, loans read, timings, the RPC
// that answered) and the chain scan's progress; those stay in the terminal and never fill the page.
export function makeLog({ json = false, keep = 300, debug = false } = {}) {
  const ring = [];   // the last lines (info and up), for the local page
  const MARK = { debug: '·', info: ' ', warn: '!', error: '✗' };
  const line = (level, msg, extra) => {
    msg = redactUrls(msg);
    if (level !== 'debug') { ring.push({ t: Date.now(), level, msg }); if (ring.length > keep) ring.shift(); }
    if (json) return console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.log(`${ts} ${MARK[level]} ${msg}`);
  };
  return { info: (m, x) => line('info', m, x), warn: (m, x) => line('warn', m, x), error: (m, x) => line('error', m, x),
    debug: debug ? (m, x) => line('debug', m, x) : null, recent: (n = 100) => ring.slice(-n) };
}

export function makeNotify(env, log, fetchImpl = fetch) {
  const token = env.TELEGRAM_BOT_TOKEN, chat = env.TELEGRAM_CHAT_ID;
  const recent = new Map();
  return async function notify(text, { key, everyMs = 0 } = {}) {
    if (key && everyMs) { const at = recent.get(key); if (at && Date.now() - at < everyMs) return; recent.set(key, Date.now()); }
    if (!token || !chat) return;
    try {
      await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(10000),
      });
    } catch (e) { log.warn(`Telegram alert not sent: ${e.message}`); }
  };
}
