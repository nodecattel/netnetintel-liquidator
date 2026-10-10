// The link to @netnetintel_bot, made with a pairing code from /liquidator. The bot posts short reports here
// (liquidations, misses, low gas, locked after a restart, live/dry) and a status line, and asks for one thing back:
// whether its owner paused it from Telegram. It never sends the key, the recovery phrase or the page password, and the
// relay can't change limits, switch live on, or move funds: those are only on the local page.
export const RELAY_URL = 'https://netnetintel.com/functions/liquidatorRelay';
export const TOKEN_RE = /^nnlq_[A-Za-z0-9_-]{40,60}$/;
const MAX_QUEUE = 30;

export function makeRelay({ getToken, url = RELAY_URL, version, fetchImpl = fetch, log = () => {} }) {
  const queue = [];
  let lastError = null, pause = false, lastPoll = 0, pollSec = 60, revoked = false;
  async function post(body) {
    const token = getToken();
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, v: version, ...body }), signal: AbortSignal.timeout(15000) });
    const j = await res.json().catch(() => null);
    if (res.status === 401) { revoked = true; throw new Error('the Telegram link was removed or is wrong: make a new code with /liquidator'); }
    if (!res.ok || !j?.ok) throw new Error(j?.error || `relay HTTP ${res.status}`);
    revoked = false;
    return j;
  }
  return {
    get paused() { return pause; },
    get lastError() { return lastError; },
    get revoked() { return revoked; },
    get linked() { return !!getToken(); },
    report(ev) { if (!getToken()) return; queue.push(ev); while (queue.length > MAX_QUEUE) queue.shift(); },
    async flush() {
      if (!getToken() || !queue.length) return;
      const batch = queue.splice(0, 10);
      try { await post({ action: 'report', events: batch }); lastError = null; }
      catch (e) { if (!revoked) queue.unshift(...batch); lastError = e.message; log(`Telegram report not sent: ${e.message}`); }
    },
    // the owner's pause from Telegram; on an unreachable relay the last known answer stands
    async poll(status, now = Date.now(), force = false) {
      if (!getToken() || (!force && now - lastPoll < pollSec * 1000)) return null;
      lastPoll = now;
      try {
        const j = await post({ action: 'poll', status });
        pause = !!j.pause; pollSec = Math.min(300, Math.max(20, Number(j.pollSec) || 60)); lastError = null;
        return j;
      } catch (e) { lastError = e.message; return null; }
    },
    forget() { queue.length = 0; pause = false; revoked = false; lastError = null; lastPoll = 0; },
  };
}
