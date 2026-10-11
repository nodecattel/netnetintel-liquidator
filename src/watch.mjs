// The live trigger. Over the RPC's WebSocket (wss://) the bot subscribes to the logs of the contracts that move a
// Loopback loan: the NET/USDG pair (every swap moves the TWAP's direction), the pair oracle (its checkpoints), the
// Treasury (NAV, the oracle's floor), staking (the index, at each rebase) and the Loopback market itself (borrows,
// repays, collateral, other liquidators). Each one wakes the bot to check at once, instead of on its next 2 s check.
// It only ever wakes the bot: every figure is still read over https, and the regular checks carry on underneath, so a
// WebSocket that drops (they do, quietly) costs nothing but speed. Reconnects on its own.
import { PAIR, PAIR_ORACLE, TREASURY, STAKING, MORPHO, MARKET_ID } from './constants.mjs';

export const WATCH = { [PAIR.toLowerCase()]: 'swap', [PAIR_ORACLE.toLowerCase()]: 'oracle', [TREASURY.toLowerCase()]: 'treasury', [STAKING.toLowerCase()]: 'staking', [MORPHO.toLowerCase()]: 'market' };
const PING_MS = 20_000, SILENT_MS = 50_000, MAX_BACKOFF_MS = 30_000;

/** A wss:// address from an https:// one, for providers whose two addresses differ only by scheme (QuickNode). */
export function wssFrom(httpsUrl) {
  try { const u = new URL(httpsUrl); if (u.protocol === 'https:' && /(^|\.)quiknode\.pro$/i.test(u.hostname)) { u.protocol = 'wss:'; return u.toString(); } } catch { /* not a URL */ }
  return null;
}

export function makeWatch({ url, onWake, log = { info() {}, warn() {}, debug() {} }, WebSocketImpl = globalThis.WebSocket, now = Date.now }) {
  let ws = null, stopped = false, backoff = 1000, timer = null, ping = null, lastMsg = 0, nextId = 10;
  const st = { connected: false, since: null, events: 0, lastEventAt: null, lastKind: null, error: null, reconnects: 0 };
  const host = (() => { try { return new URL(url).host; } catch { return null; } })();

  function connect() {
    if (stopped) return;
    try { ws = new WebSocketImpl(url); } catch (e) { return retry(e.message); }
    ws.onopen = () => {
      lastMsg = now();
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['logs', { address: [PAIR, PAIR_ORACLE, TREASURY, STAKING] }] }));
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_subscribe', params: ['logs', { address: MORPHO, topics: [null, MARKET_ID] }] }));
      clearInterval(ping);
      ping = setInterval(() => {
        if (now() - lastMsg > SILENT_MS) { try { ws.close(); } catch { /* gone */ } return; }   // no answer to pings: a dead socket
        try { ws.send(JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'eth_chainId', params: [] })); } catch { /* closing */ }
      }, PING_MS);
    };
    ws.onmessage = (m) => {
      lastMsg = now();
      let j; try { j = JSON.parse(typeof m.data === 'string' ? m.data : String(m.data)); } catch { return; }
      if ((j.id === 1 || j.id === 2) && j.result) {
        if (!st.connected) { st.connected = true; st.since = now(); st.error = null; backoff = 1000; log.info(`live feed: subscribed on ${host}: swaps, oracle, Treasury, staking and the market wake the bot at once`); }
        return;
      }
      if ((j.id === 1 || j.id === 2) && j.error) { st.error = String(j.error.message || 'subscription refused').slice(0, 140); log.warn(`live feed: ${host} refused the subscription (${st.error}): checks stay on the timer`); return; }
      if (j.method !== 'eth_subscription') return;
      const l = j.params?.result;
      const kind = WATCH[String(l?.address || '').toLowerCase()] || 'log';
      if (l?.removed) return;                         // a reorg undoing a log: nothing new to check
      st.events++; st.lastEventAt = now(); st.lastKind = kind;
      try { onWake(kind, l); } catch { /* the bot's own errors are its own */ }
    };
    ws.onclose = () => { clearInterval(ping); if (st.connected) log.warn(`live feed: ${host} disconnected: checks stay on the timer while it reconnects`); st.connected = false; retry(); };
    ws.onerror = (e) => { st.error = String(e?.message || 'connection error').slice(0, 140); };
  }
  function retry(why) {
    if (stopped) return;
    if (why) st.error = String(why).slice(0, 140);
    st.reconnects++;
    clearTimeout(timer);
    timer = setTimeout(connect, backoff);
    backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
  }
  return {
    start() { if (!WebSocketImpl) { st.error = 'no WebSocket in this runtime'; return; } connect(); },
    stop() { stopped = true; clearTimeout(timer); clearInterval(ping); try { ws?.close(); } catch { /* gone */ } st.connected = false; },
    status: () => ({ ...st, host }),
  };
}
