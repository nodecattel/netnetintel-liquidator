// The local page: on the owner's machine only (Docker publishes it to 127.0.0.1). A password chosen on first visit
// protects it, and also encrypts the bot's key. Requests from other sites are refused (Host and Origin checks, a
// SameSite=Strict session cookie), so a web page open in the same browser can't drive it; nothing it serves comes from
// the internet (strict CSP). Funds only ever go to the payout address saved here, and changing that address or
// withdrawing needs the password again.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FILES = { '/': ['ui/index.html', 'text/html'], '/favicon.svg': ['ui/favicon.svg', 'image/svg+xml'], '/ui.js': ['ui/ui.js', 'text/javascript'], '/ui.css': ['ui/ui.css', 'text/css'] };
const FS = '../node_modules/@fontsource/';
const FONTS = {
  '/fonts/serif.woff2': FS + 'instrument-serif/files/instrument-serif-latin-400-normal.woff2',
  '/fonts/serif-italic.woff2': FS + 'instrument-serif/files/instrument-serif-latin-400-italic.woff2',
  '/fonts/inter-400.woff2': FS + 'inter/files/inter-latin-400-normal.woff2',
  '/fonts/inter-500.woff2': FS + 'inter/files/inter-latin-500-normal.woff2',
  '/fonts/inter-600.woff2': FS + 'inter/files/inter-latin-600-normal.woff2',
};
const HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin', 'cross-origin-resource-policy': 'same-origin', 'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};
const SESSION_MS = 12 * 3600e3, COOKIE = 'nnlq';

export function startServer({ runner, port = 8788, host = '0.0.0.0', allowedHosts = [], log = { info() {}, warn() {} } }) {
  const api = runner.api;
  const sessions = new Map();
  const fails = [];
  const okHost = (h) => {
    const name = String(h || '').replace(/:\d+$/, '').toLowerCase();
    return ['localhost', '127.0.0.1', '[::1]'].includes(name) || allowedHosts.includes(name);
  };
  const session = (req) => {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`).exec(req.headers.cookie || '');
    const exp = m && sessions.get(m[1]);
    if (!exp) return null;
    if (exp < Date.now()) { sessions.delete(m[1]); return null; }
    return m[1];
  };
  // Every attempt is counted before the slow check, so parallel requests can't slip past the limit; a right password
  // takes its own attempt back. Five wrong ones a minute.
  const limit = () => {
    const now = Date.now();
    while (fails.length && now - fails[0].t > 60e3) fails.shift();
    if (fails.length >= 5) throw httpErr(429, 'too many tries: wait a minute');
    const a = { t: now }; fails.push(a);
    return () => { const i = fails.indexOf(a); if (i >= 0) fails.splice(i, 1); };
  };
  const needPw = async (p) => { const ok = limit(); if (!(await api.checkPassword(p))) throw httpErr(401, 'wrong password'); ok(); };

  const routes = {
    'GET /api/state': async (_r, _b, authed) => {
      if (!api.hasPassword()) return { auth: 'setup', exists: api.state().wallet.exists };
      if (!authed) return { auth: 'login' };
      return { auth: 'ok', ...api.state() };
    },
    'POST /api/password': async (_r, b) => { const ok = limit(); await api.setupPassword(b.password); ok(); return { ok: true, login: true }; },
    'POST /api/login': async (_r, b) => {
      const ok = limit();
      if (!(await api.login(b.password))) throw httpErr(401, 'wrong password');
      ok();
      return { ok: true, login: true };
    },
    'POST /api/logout': async (req) => { const t = session(req); if (t) sessions.delete(t); api.logout(); return { ok: true, logout: true }; },
    'POST /api/wallet/create': async () => api.createWallet(),
    'POST /api/wallet/confirm': async (_r, b) => api.confirmWallet(b.words),
    'POST /api/wallet/cancel': async () => { api.cancelWallet(); return { ok: true }; },
    'POST /api/wallet/import': async (_r, b) => api.importWallet(b.secret),
    'POST /api/settings': async (_r, b) => {
      const { password, ...rest } = b || {};
      if ('payoutAddress' in rest || 'rpcUrl' in rest || 'logsRpcUrl' in rest) await needPw(password);
      return api.saveSettings(rest, password);   // (runner.saveSettings checks the password again for the payout address)
    },
    'POST /api/live': async (_r, b) => api.setLive(!!b.on, b.confirm),
    'POST /api/pause': async (_r, b) => api.setPaused(!!b.paused),
    'POST /api/stay-unlocked': async (_r, b) => { await needPw(b.password); return api.setStayUnlocked(!!b.on, b.password); },
    'POST /api/pair': async (_r, b) => api.pair(b.code),
    'POST /api/unpair': async () => api.unpair(),
    'POST /api/withdraw': async (_r, b) => { await needPw(b.password); return api.withdraw(b.what, b.password); },
  };
  const OPEN = new Set(['GET /api/state', 'POST /api/password', 'POST /api/login']);

  const server = createServer(async (req, res) => {
    const send = (status, body, type = 'application/json', extra = {}) => {
      res.writeHead(status, { ...HEADERS, 'content-type': type + '; charset=utf-8', ...extra });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    try {
      if (!okHost(req.headers.host)) return send(403, { error: `open this page at http://localhost:${port}` });
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && FONTS[url.pathname]) {
        res.writeHead(200, { ...HEADERS, 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable' });
        return res.end(readFileSync(join(here, FONTS[url.pathname])));
      }
      if (req.method === 'GET' && FILES[url.pathname]) {
        const [f, type] = FILES[url.pathname];
        return send(200, readFileSync(join(here, f), 'utf8'), type);
      }
      const key = `${req.method} ${url.pathname}`;
      const fn = routes[key];
      if (!fn) return send(404, { error: 'not found' });
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        let oh = null; try { oh = new URL(origin).host; } catch { oh = null; }
        if (!oh || !okHost(oh) || oh !== req.headers.host) return send(403, { error: 'requests from other sites are refused' });
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(415, { error: 'JSON only' });
      }
      const authed = !!session(req);
      if (!OPEN.has(key) && !authed) return send(401, { error: 'log in first' });
      let body = {};
      if (req.method === 'POST') {
        let raw = '';
        for await (const c of req) { raw += c; if (raw.length > 16384) return send(413, { error: 'too large' }); }
        try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { error: 'bad JSON' }); }
      }
      const out = await fn(req, body, authed);
      const extra = {};
      if (out?.login) {
        const t = randomBytes(32).toString('hex'); sessions.set(t, Date.now() + SESSION_MS);
        extra['set-cookie'] = `${COOKIE}=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`;
        delete out.login;
      }
      if (out?.logout) { extra['set-cookie'] = `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`; delete out.logout; }
      return send(200, out ?? { ok: true }, 'application/json', extra);
    } catch (e) {
      if (!e.status) log.warn(`page: ${e.shortMessage || e.message}`);
      return send(e.status || 500, { error: e.status ? e.message : `failed: ${String(e.shortMessage || e.message || e).slice(0, 200)}` });
    }
  });
  server.listen(port, host);
  return server;
}
function httpErr(status, message) { return Object.assign(new Error(message), { status }); }
