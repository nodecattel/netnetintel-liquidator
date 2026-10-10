// The liquidator's page: a password, the bot's own wallet, funding, limits, Telegram, then dry run or live, and a
// dashboard. No libraries and nothing loaded from the internet; it only talks to the bot on this computer.
const $app = document.getElementById('app'), $pills = document.getElementById('pills');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n2 = (v) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const n4 = (v) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }));
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');
const ago = (t) => { if (typeof t === 'string') t = Date.parse(t); if (!t || !isFinite(t)) return '—'; const s = Math.round((Date.now() - t) / 1000); return s < 90 ? s + 's ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago'; };
const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const usd = (v) => (v == null || !isFinite(v) ? '—' : '$' + Number(v).toLocaleString('en-US', { maximumFractionDigits: v >= 1000 ? 0 : 2, minimumFractionDigits: v >= 1000 ? 0 : 2 }));
const amt = (v, k) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-US', k === 'usdg' ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : k === 'eth' ? { maximumFractionDigits: 6 } : { maximumFractionDigits: 4 }));
const TOK = [['eth', 'ETH', 'gas'], ['usdg', 'USDG', 'to liquidate with'], ['wsnet', 'wsNET', 'seized collateral'], ['net', 'NET', ''], ['snet', 'sNET', 'staked NET']];
const EXPLORER = 'https://robin.etherscan.io';
const BOT = 'https://t.me/netnetintel_bot?start=liquidator';
let S = null, view = 'auto', phrase = null, flash = '', timer = null;
const head = (title, sub = '') => `<div class="section"><h1>${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}</div>`;
const $ = (id) => document.getElementById(id);
const store = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* fine */ } } };

// light / dark, as on netnetintel.com (dark by default)
const $theme = $('theme');
const setTheme = (t) => { document.documentElement.classList.toggle('light', t === 'light'); $theme.querySelector('.tlabel').textContent = t === 'light' ? 'Dark' : 'Light'; store.set('netnet-theme', t); };
setTheme(store.get('netnet-theme') === 'light' ? 'light' : 'dark');
$theme.onclick = () => setTheme(document.documentElement.classList.contains('light') ? 'dark' : 'light');

async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login' && /log in/.test(j.error || '')) { S = { auth: 'login' }; render(); throw new Error('log in again'); }
  if (!r.ok) throw new Error(j.error || 'failed (' + r.status + ')');
  return j;
}
async function load() { S = await api('/api/state'); render(); }
function err(id, e) { const el = $(id); if (el) el.textContent = e.message || e; }
const busy = (btn, on, text) => { if (!btn) return; if (on) { btn.dataset.t = btn.textContent; btn.textContent = text || 'Working…'; btn.disabled = true; } else { btn.textContent = btn.dataset.t || btn.textContent; btn.disabled = false; } };
function copyBtn(id, text) { const b = $(id); if (b) b.onclick = async () => { try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1400); } catch (e) { b.textContent = 'Select it'; } }; }

function render() {
  clearTimeout(timer);
  $pills.innerHTML = '';
  if (!S) return;
  if (S.auth === 'setup') return passwordScreen(true);
  if (S.auth === 'login') return passwordScreen(false);
  footer();
  pills();
  if (view === 'settings') return settingsScreen();
  const w = S.wallet, st = S.settings;
  if (!w.exists || w.pendingBackup || phrase) return walletStep();
  // the fund step stays up when the deposits arrive, so the owner sees them land, until they press Continue
  if (view === 'fund' || (view === 'auto' && !store.get('liq-funded') && (!funded() || fundStep.shown))) return fundStep();
  if (st.maxRepayUsdg == null) return limitsStep(true);
  if (!S.telegram.linked && !store.get('liq-skip-tg')) return telegramStep(true);
  return dashboard();
}
// ---- what the bot needs before it can liquidate ----
const REC_ETH = 0.0005;   // about 100 liquidations at Robinhood Chain's usual gas price
const BRIDGES = [
  ['Across', 'https://across.to/robinhood-bridge', 'USDC from 13 chains arrives as USDG; ETH too'],
  ['Relay', 'https://relay.link/bridge/robinhood', 'ETH and USDG from most chains, in seconds'],
  ['Jumper', 'https://jumper.xyz/', 'compares bridges across 50+ chains'],
];
function needs() {
  const b = S.status.wallet, floor = S.settings.gasFloorEth || 0.00005;
  return {
    eth: b && b.eth != null ? b.eth >= floor : null, ethLow: b && b.eth != null ? b.eth < REC_ETH : null,
    usdg: b && b.usdg != null ? b.usdg > (S.settings.reserveUsdg || 0) : null,
    limit: S.settings.maxRepayUsdg != null,
  };
}
const funded = () => { const n = needs(); return n.eth && n.usdg; };
const mark = (ok) => (ok == null ? '<b>…</b>' : ok ? '<b>✓</b>' : '<b>○</b>');
function coversText(g, eth) {
  if (!g || !(eth > 0)) return '';
  return g.covers >= 1000 ? 'enough for 1,000+ liquidations' : `enough for about ${g.covers.toLocaleString('en-US')} liquidation${g.covers === 1 ? '' : 's'}`;
}
// why there are no balances yet: starting, or the RPC isn't answering (with its own words)
function readingText() {
  const st = S.status, r = st.rpc;
  if (r?.error && !st.wallet) return `Can't read the wallet: ${r.error}. The bot retries on its own; if it keeps failing, check the internet connection or set your own RPC in Settings → Speed.`;
  return 'Reading the balances…';
}
const recent = (kind, ms = 120_000) => (S.events || []).filter((e) => e.kind === kind && Date.now() - e.at < ms);

function footer() {
  const st = S.status, fd = $('fdot'), fs = $('fstatus');
  $('fver').textContent = S.version ? 'v' + S.version : '';
  const bad = st.lastError, warn = st.paused || st.oraclePaused || S.wallet.locked;
  fd.className = 'dot ' + (bad ? 'bad' : warn ? 'warn' : st.block ? 'ok' : '');
  fs.textContent = bad ? 'RPC problem' : S.wallet.locked ? 'Locked' : st.block ? 'Block ' + Number(st.block).toLocaleString('en-US') : st.phase === 'loading' ? 'Loading loans' : 'Connecting';
}
function pills() {
  const st = S.status, s = S.settings;
  const mode = s.live ? '<span class="pill live">Live</span>' : '<span class="pill">Dry run</span>';
  const run = st.paused ? '<span class="pill stop">Paused</span>' : st.oraclePaused ? '<span class="pill stop">Oracle paused</span>' : '<span class="pill run">Watching</span>';
  $pills.innerHTML = mode + run;
}
function steps(n) {
  const names = ['Wallet', 'Fund', 'Limits', 'Telegram', 'Go'];
  return `<div class="steps">${names.map((x, i) => `<span class="${i + 1 === n ? 'on' : i + 1 < n ? 'done' : ''}">${i + 1}. ${x}</span>`).join('')}</div>`;
}

// ---- password ----
function passwordScreen(first) {
  const existing = first && S.exists;
  $app.innerHTML = `<div class="card narrow">
    <h1>${first ? 'Welcome' : 'Log in'}</h1>
    <p>${first ? (existing ? 'A wallet is already set up here (from the command line). Enter the password it was made with: it becomes this page\'s password.'
      : 'Choose a password for this page. It protects the page <b>and encrypts the bot\'s key</b> on this computer. There is no reset: keep it in your password manager.')
      : 'Enter this page\'s password. It also unlocks the bot\'s wallet after a restart.'}</p>
    <label for="pw">Password</label><input id="pw" type="password" autocomplete="${first && !existing ? 'new-password' : 'current-password'}" minlength="10">
    ${first && !existing ? '<label for="pw2">Again</label><input id="pw2" type="password" autocomplete="new-password"><p class="hint">At least 10 characters.</p>' : ''}
    <div class="row"><button class="primary" id="go">${first ? 'Continue' : 'Log in'}</button></div><div class="err" id="e" role="alert"></div></div>`;
  const go = async () => {
    const pw = $('pw').value, b = $('go');
    if (first && !existing && pw !== $('pw2').value) return err('e', 'The two passwords differ');
    busy(b, true, 'Checking…');
    try { await api(first ? '/api/password' : '/api/login', { password: pw }); await load(); } catch (e) { busy(b, false); err('e', e); }
  };
  $('go').onclick = go;
  for (const id of ['pw', 'pw2']) { const el = $(id); if (el) el.onkeydown = (e) => { if (e.key === 'Enter') go(); }; }
  $('pw').focus();
}

// ---- 1. wallet ----
function walletStep() {
  if (phrase) return phraseScreen();
  $app.innerHTML = `${head('The bot\'s wallet', 'The wallet the bot liquidates from. Its key is encrypted with your page password and never leaves this computer.')}${steps(1)}
    <div class="choice">
      <div class="card"><h2>Recommended</h2><h1 class="h-sm">Make a new wallet</h1>
        <p>A fresh wallet just for the bot. You fund it with only what it may use, and keep your main wallet apart.</p>
        <div class="row"><button class="primary" id="mk">Make the wallet</button></div><div class="err" id="e1" role="alert"></div></div>
      <div class="card"><h2>Advanced</h2><h1 class="h-sm">Use a wallet I have</h1>
        <p>Paste its private key or recovery phrase. <b>Use a wallet made for the bot</b>, not your main one.</p>
        <label for="sec">Private key or recovery phrase</label><textarea id="sec" autocomplete="off" spellcheck="false" placeholder="0x… or twelve words"></textarea>
        <div class="row"><button id="imp">Import</button></div><div class="err" id="e2" role="alert"></div></div>
    </div>`;
  $('mk').onclick = async () => { busy($('mk'), true); try { phrase = await api('/api/wallet/create', {}); render(); } catch (e) { busy($('mk'), false); err('e1', e); } };
  $('imp').onclick = async () => {
    const v = $('sec').value; busy($('imp'), true, 'Encrypting…');
    try { await api('/api/wallet/import', { secret: v }); $('sec').value = ''; flash = 'Wallet imported and encrypted.'; await load(); } catch (e) { busy($('imp'), false); err('e2', e); }
  };
}
function phraseScreen() {
  const words = phrase.phrase.split(' ');
  if (!phrase.shown) {
    $app.innerHTML = `${head(`Write down these ${words.length} words`, 'The only backup of the bot\'s wallet')}${steps(1)}<div class="card">
      <p>Anyone with these words can take the bot wallet's funds. Without them, a lost computer means lost funds.</p>
      <div class="note warn">Write them on paper, in order. Don't screenshot them, email them, paste them into a chat or give them to an AI assistant. NetNet Intel and @netnetintel_bot will never ask for them.</div>
      <div class="phrase">${words.map((x, i) => `<div><b>${i + 1}</b>${esc(x)}</div>`).join('')}</div>
      <p class="small">Address <code>${esc(phrase.address)}</code></p>
      <label><input type="checkbox" id="ok"> I wrote the words down, in order</label>
      <div class="row"><button class="primary" id="go" disabled>Next: check them</button><button id="cancel">Start over</button></div></div>`;
    $('ok').onchange = (e) => { $('go').disabled = !e.target.checked; };
    $('go').onclick = () => { phrase.shown = true; render(); };
    $('cancel').onclick = async () => { await api('/api/wallet/cancel', {}).catch(() => null); phrase = null; render(); };
    return;
  }
  $app.innerHTML = `${head('Check your copy', 'Type three of the words from your paper. The wallet is saved only once they match.')}${steps(1)}<div class="card">
    <div class="words3">${phrase.check.map((i) => `<div><label for="w${i}">Word #${i + 1}</label><input id="w${i}" type="text" autocomplete="off" spellcheck="false" autocapitalize="off"></div>`).join('')}</div>
    <div class="row"><button class="primary" id="go">Save the wallet</button><button id="back">Show the words again</button></div><div class="err" id="e" role="alert"></div></div>`;
  $(`w${phrase.check[0]}`).focus();
  $('back').onclick = () => { phrase.shown = false; render(); };
  $('go').onclick = async () => {
    const words = Object.fromEntries(phrase.check.map((i) => [i, $(`w${i}`).value]));
    busy($('go'), true, 'Encrypting…');
    try { await api('/api/wallet/confirm', { words }); phrase = null; flash = 'Wallet saved, encrypted with your page password.'; await load(); }
    catch (e) { busy($('go'), false); err('e', e); }
  };
}

// ---- 2. fund ----
function fundStep() {
  const w = S.wallet, b = S.status.wallet, g = S.status.gas, n = needs(), floor = S.settings.gasFloorEth || 0.00005;
  const got = recent('deposit');
  if (view === 'auto') fundStep.shown = true;
  if (view === 'fund') setTimeout(() => { if ($('go')) $('go').textContent = 'Back to the dashboard'; }, 0);
  $app.innerHTML = `${head('Fund the bot', 'Two things, on Robinhood Chain: USDG to liquidate with, and a little ETH to pay gas.')}${steps(2)}
    ${flash ? `<div class="note ok">${esc(flash)}</div>` : got.length ? `<div class="note ok">Received ${esc(got.map((e) => `${amt(e.amount)} ${e.token}`).join(', '))}.</div>` : ''}
    <div class="grid">
      <div class="card"><h2>Send to the bot wallet</h2>
        <div class="fundaddr"><img class="qr" src="/qr.svg?a=${esc(w.address)}" alt="QR code of the bot wallet's address" width="132" height="132">
          <div><div class="addr"><code>${esc(w.address)}</code></div>
          <div class="row mt6"><button class="copy" id="cp">Copy address</button><a class="small" href="${EXPLORER}/address/${esc(w.address)}" target="_blank" rel="noopener">Explorer ↗</a></div>
          <p class="hint">On <b>Robinhood Chain</b> only (chain id 4663). Sent on another network, it won't arrive here.</p></div></div>
      </div>
      <div class="card"><h2>What it needs</h2>
        <div class="need ${n.eth ? 'ok' : ''}">${mark(n.eth)}<div><b>ETH for gas</b> · ${amt(b?.eth, 'eth')} ETH
          <p class="hint">Every transaction pays gas in ETH: the one-time USDG approval and each liquidation. ${REC_ETH} ETH is plenty to start${g ? ` (${g.ethPerLiquidation.toFixed(7)} ETH a liquidation at today's gas)` : ''}${b && b.eth > 0 && coversText(g, b.eth) ? `: what it holds is ${coversText(g, b.eth)}` : ''}.${n.eth && n.ethLow ? ' Topping up to ' + REC_ETH + ' ETH is a good idea.' : ''}</p></div></div>
        <div class="need ${n.usdg ? 'ok' : ''}">${mark(n.usdg)}<div><b>USDG to liquidate with</b> · ${n2(b?.usdg)} USDG
          <p class="hint">It repays loans with this and gets back about 12.7% more in wsNET. Recent loans range from a few USDG to a few hundred; with less, it liquidates part of a loan.</p></div></div>
        ${b && ['wsnet', 'net', 'snet'].some((k) => b[k] > 0) ? `<p class="hint">Also in the wallet: ${esc(['wsnet', 'net', 'snet'].filter((k) => b[k] > 0).map((k) => `${amt(b[k])} ${TOK.find((t) => t[0] === k)[1]}`).join(', '))}.</p>` : ''}
        <p class="hint">${b ? `Balances refresh every few seconds (read ${ago(b.at)}).` : esc(readingText())}</p>
      </div>
    </div>
    <div class="card"><h2>Getting ETH and USDG onto Robinhood Chain</h2>
      <p><b>Already on Robinhood Chain</b> (Robinhood Wallet, or another wallet there)? Send both to the address above.</p>
      <p><b>From another chain</b>, use a bridge and set the recipient to the bot's address (or bridge to your own wallet first, then send):</p>
      <div class="bridges">${BRIDGES.map(([name, url, what]) => `<a class="bridge" href="${url}" target="_blank" rel="noopener"><b>${name} ↗</b><span>${what}</span></a>`).join('')}</div>
      <p class="hint">Bridges are third-party services; check the destination chain is Robinhood Chain before you confirm.</p>
    </div>
    <div class="row">${funded() ? '<button class="primary" id="go">Continue</button>' : `<button class="primary" id="go">Continue in dry run</button><span class="hint">You can fund it later: it watches and simulates without funds${n.eth === false ? ', and going live waits for ETH' : ''}${n.usdg === false ? ' and USDG' : ''}.</span>`}</div>`;
  flash = '';
  copyBtn('cp', w.address);
  $('go').onclick = () => { store.set('liq-funded', '1'); view = 'auto'; render(); };
  timer = setTimeout(() => load().catch(() => null), 5000);
}

// ---- 3. limits (and the settings screen) ----
function limitsFields(s) {
  const fx = (k) => (s.fixed.includes(k) ? ' <span class="fixed">set by the environment</span>' : '');
  return `<label for="max">Most one liquidation may repay (USDG)${fx('MAX_REPAY_USDG')}</label><input id="max" type="number" min="1" step="1" value="${s.maxRepayUsdg ?? ''}" placeholder="e.g. 300">
    <p class="hint">Required before going live. The bot also never spends more than the wallet holds.</p>
    <label for="res">Keep in reserve (USDG)${fx('RESERVE_USDG')}</label><input id="res" type="number" min="0" step="1" value="${s.reserveUsdg ?? 0}">
    <label for="minp">Skip liquidations earning less than (USDG)${fx('MIN_PROFIT_USDG')}</label><input id="minp" type="number" min="0" step="0.05" value="${s.minProfitUsdg ?? 0.25}">
    <label><input type="checkbox" id="part" ${s.allowPartial ? 'checked' : ''}> Liquidate part of a loan when the wallet can't cover all of it${fx('ALLOW_PARTIAL')}</label>
    <label for="tick">Check every (seconds)${fx('TICK_SECONDS')}</label><input id="tick" type="number" min="1" max="60" step="1" value="${s.tickSeconds}">`;
}
function readLimits() {
  return { maxRepayUsdg: $('max').value, reserveUsdg: $('res').value, minProfitUsdg: $('minp').value, allowPartial: $('part').checked, tickSeconds: $('tick').value };
}
// ---- speed: the RPC (public by default; your own is faster) ----
function speedCard(s) {
  const r = S.status.rpc, fx = (k) => (s.fixed.includes(k) ? ' <span class="fixed">set by the environment</span>' : '');
  const now = r?.host ? `<b>${esc(r.host)}</b>${r.ms != null ? ` · about ${r.ms} ms a read` : ''}` : 'not connected yet';
  const e = s.endpoints || {};
  return `<div class="card" id="speed"><h2>Speed: RPC</h2>
    <p>Reading from ${now}${r?.fallback ? ' <span class="warn-t">(your RPC isn\'t answering: on the public one until it is back)</span>' : ''}.</p>
    ${s.customRpc ? '' : '<div class="note">The public RPC is shared by everyone and rate-limited. Liquidations are a race, so your own RPC from a provider is faster and steadier. Most have a free tier.</div>'}
    <p class="hint">Providers with Robinhood Chain RPC:</p><div class="providers">${(s.providers || []).map(([name, url]) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(name)} ↗</a>`).join('')}</div>
    <label for="rpc">Your RPC address${fx('RPC_URL')} <span class="muted">(empty: the public RPC)</span></label><input id="rpc" type="text" autocomplete="off" spellcheck="false" placeholder="${s.customRpc ? esc(s.rpcUrl || 'saved') + ' (saved: type a new one to replace)' : 'https://…'}">
    <p class="hint">${s.rpcFallback ? 'If it stops answering, the bot uses the public RPC until it is back. ' : ''}If it caps eth_getLogs (QuickNode: 10,000 blocks), leave the next field empty and the bot finds borrowers on the public RPC.</p>
    <label for="lrpc">RPC for finding borrowers${fx('LOGS_RPC_URL')} <span class="muted">(empty: same as above)</span></label><input id="lrpc" type="text" autocomplete="off" spellcheck="false" placeholder="${s.logsRpc ? 'saved (type a new one to replace)' : esc(e.rpc || '')}">
    <label for="rpw">Page password <span class="muted">(an RPC decides what the bot believes, so changing one needs it)</span></label><input id="rpw" type="password" autocomplete="current-password">
    <div class="row"><button class="primary" id="saverpc">Save RPC</button>${s.customRpc ? '<button id="clrrpc">Back to the public RPC</button>' : ''}</div><div class="err" id="er" role="alert"></div>
    <details><summary>Robinhood Chain's public endpoints</summary><table class="eps"><tbody>
      <tr><td>RPC</td><td><code>${esc(e.rpc)}</code></td></tr>
      <tr><td>Sequencer</td><td><code>${esc(e.sequencer)}</code><p class="hint">${s.sequencer ? 'On: every signed transaction also goes straight here, the shortest path into a block.' : 'Off (SEQUENCER_URL=off).'}</p></td></tr>
      <tr><td>Sequencer feed</td><td><code>${esc(e.feed)}</code></td></tr>
      <tr><td>Delayed feed</td><td><code>${esc(e.feedDelayed)}</code><p class="hint">About 500 ms behind; the feed's fallback.</p></td></tr>
    </tbody></table><p class="hint">Public endpoints are rate-limited and not meant for production.</p></details></div>`;
}
function wireSpeed() {
  const save = async (body) => { busy($('saverpc'), true); try { await api('/api/settings', body); flash = 'RPC saved.'; $('rpw').value = ''; await load(); } catch (e) { busy($('saverpc'), false); err('er', e); } };
  $('saverpc').onclick = () => {
    const b = { password: $('rpw').value };
    if ($('rpc').value.trim()) b.rpcUrl = $('rpc').value.trim();
    if ($('lrpc').value.trim()) b.logsRpcUrl = $('lrpc').value.trim();
    if (!b.rpcUrl && !b.logsRpcUrl) return err('er', 'Paste an RPC address first');
    save(b);
  };
  if ($('clrrpc')) $('clrrpc').onclick = () => save({ rpcUrl: '', logsRpcUrl: '', password: $('rpw').value });
}
function payoutFields(s) {
  return `<label for="pay">Your main wallet${s.fixed.includes('PAYOUT_ADDRESS') ? ' <span class="fixed">set by the environment</span>' : ''} <span class="muted">(optional)</span></label>
    <input id="pay" type="text" autocomplete="off" spellcheck="false" value="${esc(s.payoutAddress || '')}" placeholder="0x…">
    <p class="hint">Each liquidation's wsNET goes here right away, and withdrawals can only go here. Changing it needs your password.</p>
    <label for="ppw">Page password</label><input id="ppw" type="password" autocomplete="current-password">`;
}
function limitsStep(first) {
  const s = S.settings;
  $app.innerHTML = `${head('Limits', 'What the bot may do with the wallet. You can change these any time.')}${steps(3)}
    ${flash ? `<div class="note ok">${esc(flash)}</div>` : ''}
    <div class="card">${limitsFields(s)}
      <div class="row"><button class="primary" id="save">Save limits</button></div><div class="err" id="e" role="alert"></div>
      <p class="hint">It reads the chain through the public RPC to start with. Your own RPC is faster when racing other liquidators: Settings → Speed, any time.</p></div>
    <div class="card"><h2>Where seized wsNET goes</h2>${payoutFields(s)}
      <div class="row"><button id="savep">Save address</button></div><div class="err" id="e2" role="alert"></div></div>`;
  flash = '';
  $('save').onclick = async () => { busy($('save'), true); try { await api('/api/settings', readLimits()); flash = 'Limits saved.'; await load(); } catch (e) { busy($('save'), false); err('e', e); } };
  $('savep').onclick = async () => { busy($('savep'), true); try { await api('/api/settings', { payoutAddress: $('pay').value, password: $('ppw').value }); $('ppw').value = ''; flash = 'Address saved.'; await load(); } catch (e) { busy($('savep'), false); err('e2', e); } };
}

// ---- 4. Telegram ----
function telegramBlock(t) {
  if (t.linked) return `<div class="note ok">Linked to @netnetintel_bot${t.paused ? ' · paused from Telegram' : ''}.</div>${t.error ? `<div class="note warn">${esc(t.error)}</div>` : ''}
    <p>You get deposits, liquidations, misses, low gas and restarts in Telegram, and can pause or resume from /liquidator. Telegram can't change limits, switch live on or move funds.</p>
    <div class="row"><button class="danger" id="unpair">Unlink</button></div><div class="err" id="et" role="alert"></div>`;
  return `<ol><li>Open <a href="${BOT}" target="_blank" rel="noopener">@netnetintel_bot</a> and send <code>/liquidator</code>.</li><li>Tap <b>Make a pairing code</b> and copy it.</li><li>Paste it here.</li></ol>
    <label for="code">Pairing code</label><input id="code" type="text" autocomplete="off" spellcheck="false" placeholder="nnlq_…">
    <p class="hint">The code only links reports and pause/resume. Never paste your recovery phrase or key into Telegram.</p>
    <div class="row"><button class="primary" id="pair">Link Telegram</button></div><div class="err" id="et" role="alert"></div>`;
}
function wireTelegram() {
  if ($('pair')) $('pair').onclick = async () => { busy($('pair'), true, 'Linking…'); try { await api('/api/pair', { code: $('code').value }); flash = 'Telegram linked.'; await load(); } catch (e) { busy($('pair'), false); err('et', e); } };
  if ($('unpair')) $('unpair').onclick = async () => { await api('/api/unpair', {}).catch((e) => err('et', e)); await load(); };
}
function telegramStep() {
  $app.innerHTML = `${head('Telegram', 'Optional: hear about deposits and every liquidation, and pause the bot from your phone.')}${steps(4)}
    <div class="card">${telegramBlock(S.telegram)}<div class="row"><button id="skip">Skip for now</button></div></div>`;
  wireTelegram();
  $('skip').onclick = () => { store.set('liq-skip-tg', '1'); render(); };
}

// ---- dashboard ----
// what happened, in a line: the feed shows these; the full log is one click away
const TX_KIND = { approve: 'USDG approval', liquidate: 'Liquidation', payout: 'wsNET to you', withdraw: 'Withdrawal' };
const TX_STATUS = { ok: ['ok', 'Confirmed'], pending: ['wait', 'Pending'], unconfirmed: ['warn', 'Unconfirmed'], reverted: ['bad', 'Reverted'], failed: ['bad', 'Not sent'], unknown: ['warn', 'See explorer'] };
function feedLine(e) {
  const b = (a) => short(a);
  switch (e.kind) {
    case 'deposit': return ['ok', `Received ${amt(e.amount)} ${e.token}`];
    case 'outflow': return ['bad', `${amt(e.amount)} ${e.token} left the wallet, not sent by the bot`];
    case 'liquidated': return ['ok', `Liquidated ${b(e.borrower)}: repaid ${e.repaid} USDG, seized ${e.seized} wsNET (+${e.profitAtOracle})`];
    case 'missed': return ['', `Missed ${b(e.borrower)}: another liquidator got there first`];
    case 'failed': return ['bad', `Attempt on ${b(e.borrower)} failed: ${e.error}`];
    case 'dry': return ['', `${e.paused ? 'Paused' : 'Dry run'}: would liquidate ${b(e.borrower)} (repay ${e.repaid} USDG, +${e.profit})`];
    case 'nofunds': return ['warn', `A loan with ${e.debt} USDG of debt was open to liquidate; the wallet had ${e.usdg ?? '?'} USDG`];
    case 'gas': return ['warn', `Low on ETH for gas (${amt(e.eth, 'eth')} ETH)`];
    case 'oracle': return e.paused ? ['warn', 'The oracle is holding liquidations'] : ['', 'The oracle gives a price again'];
    case 'approved': return ['', `Morpho may take up to ${e.usdg} USDG`];
    case 'mode': return [e.live ? 'ok' : '', e.live ? 'Switched to live' : 'Back to dry run'];
    case 'pause': return ['', e.paused ? `Paused from the ${e.by === 'page' ? 'page' : 'phone'}` : 'Resumed'];
    case 'withdraw': return ['', `Withdrawn to ${b(e.to)}: ${(e.parts || []).join(', ').toUpperCase() || 'nothing to send'}`];
    case 'unlocked': return ['', 'Wallet unlocked'];
    case 'locked': return ['warn', 'Wallet locked after a restart'];
    case 'paired': return ['ok', 'Telegram linked'];
    case 'started': return ['', `Started${e.v ? ' v' + e.v : ''}${e.locked ? ' (locked)' : ''}`];
    case 'stalled': return ['bad', `Stuck: checks failing for ${e.sinceMin || 2}+ min (${e.error})`];
    case 'running': return ['ok', 'Checking again'];
    case 'payout_failed': return ['bad', `Sending ${e.wsnet} wsNET to your main wallet failed: ${e.error}`];
    case 'approve_failed': return ['bad', `Couldn't set the USDG approval: ${e.error}`];
    default: return null;
  }
}
function walletCard(w, st) {
  const v = S.market?.value, fresh = recent('deposit', 90_000);
  const rows = TOK.map(([k, sym, what]) => {
    const got = fresh.find((e) => e.token === sym);
    const val = k !== 'eth' && v?.[k] != null && w?.[k] > 0 ? usd(v[k]) : '';
    return `<tr class="${got ? 'new' : ''} ${w?.[k] > 0 || k === 'eth' || k === 'usdg' ? '' : 'zero'}"><td>${sym}${what ? ` <span class="muted">${what}</span>` : ''}</td><td class="num">${amt(w?.[k], k)}${got ? ` <span class="plus">+${amt(got.amount, k)}</span>` : ''}</td><td class="num">${val}</td></tr>`;
  }).join('');
  return `<div class="card"><h2>Bot wallet</h2>
    <div class="addr"><code>${esc(short(S.wallet.address))}</code><button class="copy" id="cp">Copy</button><button class="copy" id="tofund4">Fund</button><a class="small" href="${EXPLORER}/address/${esc(S.wallet.address || '')}" target="_blank" rel="noopener">Explorer ↗</a></div>
    ${w ? `<table class="bal"><tbody>${rows}</tbody></table>
      <p class="hint">${w.eth > 0 && st.gas ? `The ETH is ${esc(coversText(st.gas, w.eth))}. ` : ''}${v?.total != null && v.total > 0 ? `Tokens worth about ${usd(v.total)} at NetNet Intel's marks. ` : ''}Read ${ago(w.at)}${w.allowance != null && w.allowance > 0 ? ` · Morpho may take ${n2(w.allowance)} USDG` : ''}.</p>`
      : `<p class="muted">${esc(readingText())}</p>`}</div>`;
}
function marketCard(st) {
  const closest = st.closest || [], m = S.market || {}, L = m.loop, Q = m.liquidations;
  const intel = m.enabled && (L || Q) ? `<div class="irows">
      ${Q?.day ? `<div><span>Liquidations, 24h</span><b>${Q.day.n ?? '—'} · ${usd(Q.day.repaid)} repaid</b></div>` : ''}
      ${L ? `<div><span>NET: TWAP · pool</span><b>${usd(L.twap)} · ${usd(L.spot)}</b></div><div><span>wsNET: oracle · pool</span><b>${usd(L.wsnetOracle)} · ${usd(L.wsnetMarket)}</b></div>` : ''}
      ${Q?.leaders?.[0] ? `<div><span>Top liquidator, 7d</span><b><a href="${EXPLORER}/address/${esc(Q.leaders[0].liquidator)}" target="_blank" rel="noopener"><code>${esc(short(Q.leaders[0].liquidator))}</code></a> · ${Math.round((Q.leaders[0].share || 0) * 100)}%</b></div>` : ''}
      ${Q?.mine ? `<div><span>You, 7d</span><b>#${Q.mine.rank} · ${Q.mine.n} liquidations</b></div>` : ''}
    </div>` : '';
  return `<div class="card"><h2>Loop market</h2><div class="kv">
    <div><span>Open loans</span><b>${st.open || (st.started ? 0 : '—')}</b></div><div><span>Near the line</span><b>${st.hot ?? '—'}</b></div>
    <div><span>Closest</span><b>${closest[0] ? closest[0].health.toFixed(4) + '×' : '—'}</b></div><div><span>Liquidatable</span><b class="${st.ready ? 'pos' : ''}">${st.ready ?? 0}</b></div></div>
    ${intel}
    <p class="hint">Health 1.000 is the 62.5% line. Checked ${ago(st.lastTickAt)}${m.enabled ? ` · market data from <a href="https://netnetintel.com/loop" target="_blank" rel="noopener">NetNet Intel</a>${m.error && !L ? ' (not reachable right now)' : ''}` : ''}.</p></div>`;
}
function txTable() {
  const txs = S.txs || [];
  if (!txs.length) return `<p class="muted">${S.settings.live ? 'None yet: approvals, liquidations and withdrawals show here as they are sent.' : 'None: the dry run sends nothing. Once live, every approval, liquidation and withdrawal shows here.'}</p>`;
  const row = (x) => { const [cls, label] = TX_STATUS[x.status] || ['', x.status]; return `<tr><td>${esc(when(Date.parse(x.at)))}</td><td>${esc(TX_KIND[x.kind] || x.kind)}<div class="hint">${esc(x.note || '')}${x.error ? ` · ${esc(x.error)}` : ''}</div></td><td><span class="st ${cls}">${label}</span></td><td class="num">${x.feeEth != null ? x.feeEth.toFixed(7) : '—'}</td><td>${x.hash ? `<a href="${EXPLORER}/tx/${esc(x.hash)}" target="_blank" rel="noopener">tx ↗</a>` : ''}</td></tr>`; };
  const head = '<thead><tr><th>When</th><th>What</th><th>Status</th><th class="num">Fee (ETH)</th><th></th></tr></thead>';
  return `<div class="tablewrap"><table class="txs">${head}<tbody>${txs.slice(0, 8).map(row).join('')}</tbody></table></div>
    ${txs.length > 8 ? `<details><summary>${txs.length - 8} older</summary><div class="tablewrap"><table class="txs"><tbody>${txs.slice(8).map(row).join('')}</tbody></table></div></details>` : ''}`;
}
function activity() {
  const lines = (S.events || []).map((e) => [e, feedLine(e)]).filter(([, f]) => f).slice(0, 8);
  const feed = lines.length ? `<ul class="feed">${lines.map(([e, [cls, text]]) => `<li class="${cls}"><time>${esc(ago(e.at))}</time>${esc(text)}</li>`).join('')}</ul>` : '<p class="muted">Nothing yet: deposits, liquidations and changes show here.</p>';
  return `${feed}<details id="fulllog"${showLog ? ' open' : ''}><summary>Full log (the last ${(S.log || []).length} lines; <code>docker logs -f netnet-liq</code> for everything)</summary>
    <div class="log">${(S.log || []).slice().reverse().map((l) => `<div class="${esc(l.level)}">${esc(new Date(l.t).toLocaleTimeString())} ${esc(l.msg)}</div>`).join('') || 'Nothing yet.'}</div></details>`;
}
let showLog = false;
function dashboard() {
  const st = S.status, s = S.settings, w = S.status.wallet, t = S.telegram, n = needs();
  const lowGas = w && n.eth === false, noUsdg = w && n.usdg === false;
  const missing = [n.eth === false && 'ETH for gas', n.usdg === false && 'USDG', !n.limit && 'a spending limit'].filter(Boolean);
  const out = recent('outflow', 3_600_000)[0];
  const notes = [
    S.wallet.locked ? '<div class="note bad">The wallet is locked: log out and in again to unlock it.</div>' : '',
    out ? `<div class="note bad">${esc(amt(out.amount))} ${esc(out.token)} left the bot wallet ${esc(ago(out.at))}, and the bot didn't send it. If that wasn't you, move what's left (Settings → Withdraw).</div>` : '',
    st.lastError ? `<div class="note bad">The last check failed: ${esc(st.lastError)}. It retries on its own; if it keeps failing, check the RPC in Settings → Speed.</div>` : '',
    !st.started && !st.lastError ? `<div class="note">${st.phase === 'loading' ? 'Loading the open loans…' : 'Connecting to Robinhood Chain…'}</div>` : '',
    st.scan?.error ? `<div class="note warn">The full chain scan paused (${esc(st.scan.error)}); the bot keeps watching the loans it knows and resumes the scan on its own.</div>` : '',
    st.oraclePaused ? '<div class="note warn">The Loopback oracle is holding liquidations (the pool sits more than 15% under the TWAP). The bot waits and resumes on its own.</div>' : '',
    s.live && lowGas ? '<div class="note bad">Live, but out of ETH for gas: it can\'t send anything until you top it up. <a href="#" id="tofund">How to fund it</a></div>' : '',
    s.live && noUsdg ? '<div class="note warn">Live, but the wallet has no USDG to liquidate with. <a href="#" id="tofund2">How to fund it</a></div>' : '',
    t.paused ? '<div class="note warn">Paused from Telegram: resume it from /liquidator.</div>' : '',
    flash ? `<div class="note ok">${esc(flash)}</div>` : '',
  ].join('');
  flash = '';
  const closest = st.closest || [];
  const r = st.rpc;
  $app.innerHTML = `${head('Liquidator', s.live ? (st.paused ? 'Live, paused: watching, sending nothing.' : 'Live: liquidating from your wallet when a loan crosses the line.') : 'Dry run: it finds and simulates liquidations, and sends nothing.')}
    ${notes}
    <div class="grid">${walletCard(w, st)}${marketCard(st)}</div>
    ${s.live ? '' : `<div class="card"><h2>Ready to go live?</h2>
      <div class="checks">
        <div class="need ok"><b>✓</b><div>Bot wallet saved</div></div>
        <div class="need ${n.eth ? 'ok' : ''}">${mark(n.eth)}<div>ETH for gas · ${amt(w?.eth, 'eth')} ETH${w && w.eth > 0 ? ` <span class="muted">(${esc(coversText(st.gas, w.eth))})</span>` : ''}</div></div>
        <div class="need ${n.usdg ? 'ok' : ''}">${mark(n.usdg)}<div>USDG to liquidate with · ${n2(w?.usdg)}</div></div>
        <div class="need ${n.limit ? 'ok' : ''}">${mark(n.limit)}<div>Spending limit · ${s.maxRepayUsdg != null ? 'up to ' + n2(s.maxRepayUsdg) + ' USDG a liquidation' : 'not set'}</div></div>
        <div class="need ${s.payoutAddress ? 'ok' : 'opt'}">${s.payoutAddress ? '<b>✓</b>' : '<b>–</b>'}<div>Your main wallet <span class="muted">(optional: seized wsNET goes there)</span></div></div>
        <div class="need ${t.linked ? 'ok' : 'opt'}">${t.linked ? '<b>✓</b>' : '<b>–</b>'}<div>Telegram <span class="muted">(optional: deposits, liquidations and pause from your phone)</span></div></div>
        <div class="need ${s.customRpc ? 'ok' : 'opt'}">${s.customRpc ? '<b>✓</b>' : '<b>–</b>'}<div>Your own RPC <span class="muted">(optional: faster than the public one) · <a href="#" id="tospeed">Settings → Speed</a></span></div></div>
      </div>
      ${missing.length ? `<p class="hint">Before going live: ${esc(missing.join(', '))}. ${n.eth === false || n.usdg === false ? '<a href="#" id="tofund3">Fund the bot</a>' : ''}</p>` : '<p class="hint">All set. Watch the dry run for a while, then go live.</p>'}
    </div>`}
    <div class="card"><h2>Controls</h2>
      <div class="row mt0">
        ${s.live ? '<button id="dry">Back to dry run</button>' : `<button class="primary" id="live" ${missing.length ? 'disabled' : ''}>Go live…</button>`}
        ${st.paused && !t.paused ? '<button id="resume">Resume</button>' : !st.paused ? '<button id="pause">Pause</button>' : ''}
        <button id="settings">Settings</button><button id="logout">Log out</button>
      </div>
      <div id="liveform"></div><div class="err" id="e" role="alert"></div>
      <p class="hint">Limit: up to ${s.maxRepayUsdg != null ? n2(s.maxRepayUsdg) + ' USDG' : '—'} per liquidation, ${n2(s.reserveUsdg)} USDG kept, min profit ${n2(s.minProfitUsdg)} USDG${s.payoutAddress ? `, wsNET to ${esc(short(s.payoutAddress))}` : ''}. Telegram: ${t.linked ? 'linked' : 'not linked'}.</p>
      <p class="hint">RPC: ${r?.host ? `${esc(r.host)}${r.ms != null ? ` · ~${r.ms} ms` : ''}${r.fallback ? ' (fallback: yours isn\'t answering)' : ''}` : '—'}${s.customRpc ? '' : ' · the public RPC is shared and rate-limited: <a href="#" id="tospeed2">use your own</a>'}</p>
    </div>
    <div class="card"><h2>Closest to the line</h2>${closest.length ? `<div class="tablewrap"><table><thead><tr><th>Loan</th><th class="num">Health</th><th class="num">Debt (USDG)</th></tr></thead><tbody>
      ${closest.map((c) => `<tr><td><a href="${EXPLORER}/address/${esc(c.borrower)}" target="_blank" rel="noopener"><code>${esc(short(c.borrower))}</code></a></td><td class="num ${c.health < 1 ? 'neg' : ''}">${c.health.toFixed(4)}</td><td class="num">${n2(c.debt)}</td></tr>`).join('')}</tbody></table></div>` : `<p class="muted">${st.started ? 'No open loans read yet.' : 'Loading the open loans…'}</p>`}
      ${st.scan ? `<p class="hint">Also scanning the chain for every borrower since the market opened: ${st.scan.pct}%.</p>` : ''}</div>
    <div class="card"><h2>Transactions</h2>${txTable()}</div>
    ${S.history.length ? `<div class="card"><h2>Liquidations</h2><div class="tablewrap"><table><thead><tr><th>When</th><th>Loan</th><th class="num">Repaid</th><th class="num">Seized wsNET</th><th class="num">Profit*</th><th></th></tr></thead><tbody>
      ${S.history.map((h) => `<tr><td>${esc(when(h.at))}</td><td><code>${esc(short(h.borrower))}</code></td><td class="num">${esc(h.repaid)}</td><td class="num">${esc(h.seized)}</td><td class="num pos">+${esc(h.profitAtOracle)}</td><td><a href="${EXPLORER}/tx/${esc(h.tx)}" target="_blank" rel="noopener">tx ↗</a></td></tr>`).join('')}</tbody></table></div><p class="hint">* At the oracle price, in USDG.</p></div>` : ''}
    <div class="card"><h2>Activity</h2>${activity()}</div>`;
  copyBtn('cp', S.wallet.address || '');
  for (const id of ['tofund', 'tofund2', 'tofund3', 'tofund4']) if ($(id)) $(id).onclick = (e) => { e.preventDefault(); view = 'fund'; render(); };
  for (const id of ['tospeed', 'tospeed2']) if ($(id)) $(id).onclick = (e) => { e.preventDefault(); view = 'settings'; render(); setTimeout(() => $('speed')?.scrollIntoView({ block: 'start' }), 0); };
  $('fulllog').ontoggle = (e) => { showLog = e.target.open; };
  const act = async (path, body) => { try { await api(path, body); await load(); } catch (e) { err('e', e); } };
  if ($('pause')) $('pause').onclick = () => act('/api/pause', { paused: true });
  if ($('resume')) $('resume').onclick = () => act('/api/pause', { paused: false });
  if ($('dry')) $('dry').onclick = () => act('/api/live', { on: false });
  if ($('live')) $('live').onclick = () => {
    clearTimeout(timer);
    $('liveform').innerHTML = `<div class="note warn">Live sends real transactions from the bot wallet: up to ${s.maxRepayUsdg != null ? n2(s.maxRepayUsdg) : '—'} USDG per liquidation. The seized wsNET's value follows NET's price. Type <b>LIVE</b> to confirm.</div>
      <input id="conf" type="text" autocomplete="off" placeholder="LIVE"><div class="row"><button class="primary" id="golive">Go live</button><button id="nolive">Cancel</button></div>`;
    $('conf').focus();
    $('golive').onclick = () => act('/api/live', { on: true, confirm: $('conf').value.trim() });
    $('nolive').onclick = () => render();
  };
  $('settings').onclick = () => { view = 'settings'; render(); };
  $('logout').onclick = async () => { await api('/api/logout', {}).catch(() => null); S = { auth: 'login' }; render(); };
  // refresh every 3 seconds, keeping the reader's place (not while they type, or have text selected)
  timer = setTimeout(function again() {
    const typing = document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
    const selecting = String(window.getSelection?.() || '').length > 0;
    if (typing || selecting) { timer = setTimeout(again, 3000); return; }
    const y = window.scrollY, logY = document.querySelector('#fulllog .log')?.scrollTop;
    load().then(() => { window.scrollTo(0, y); const l = document.querySelector('#fulllog .log'); if (l && logY != null) l.scrollTop = logY; }).catch(() => null);
  }, 3000);
}

// ---- settings: limits, payout, Telegram, unlock after restarts, withdraw ----
function settingsScreen() {
  const s = S.settings;
  $app.innerHTML = `${head('Settings')}<div class="row mb16"><button id="back">« Dashboard</button></div>
    ${flash ? `<div class="note ok">${esc(flash)}</div>` : ''}
    <div class="card"><h2>Limits</h2>${limitsFields(s)}<div class="row"><button class="primary" id="save">Save limits</button></div><div class="err" id="e" role="alert"></div></div>
    ${speedCard(s)}
    <div class="card"><h2>Your main wallet</h2>${payoutFields(s)}<div class="row"><button id="savep">Save address</button></div><div class="err" id="e2" role="alert"></div></div>
    <div class="card"><h2>Telegram</h2>${telegramBlock(S.telegram)}</div>
    <div class="card"><h2>After a restart</h2>
      <p>${s.stayUnlocked ? '<b>On</b>: the bot unlocks its wallet by itself after a restart (the password is kept in the data volume).' : '<b>Off</b>: after a restart (a reboot, an update) the wallet stays locked until you log in here, and Telegram tells you.'}</p>
      <p class="hint">On keeps it running unattended on a server you trust. Off is safer if someone else could copy the data volume.</p>
      <label for="upw">Page password</label><input id="upw" type="password" autocomplete="current-password">
      <div class="row"><button id="unl">${s.stayUnlocked ? 'Turn off' : 'Turn on'}</button></div><div class="err" id="e3" role="alert"></div></div>
    <div class="card"><h2>Withdraw</h2>
      ${s.payoutAddress ? `<p>Sends the bot wallet's funds to <code>${esc(s.payoutAddress)}</code>, your saved main wallet, and nowhere else.</p>
        <div class="row mt6"><label class="inline"><select id="what"><option value="all">Everything</option><option value="usdg">USDG</option><option value="wsnet">wsNET</option><option value="net">NET</option><option value="snet">sNET</option><option value="eth">ETH</option></select></label></div>
        <label for="wpw">Page password</label><input id="wpw" type="password" autocomplete="current-password">
        <div class="row"><button class="danger" id="wd">Withdraw</button></div><div class="err" id="e4" role="alert"></div>` : '<p class="muted">Save your main wallet above first: withdrawals only go there.</p>'}</div>`;
  flash = '';
  $('back').onclick = () => { view = 'auto'; render(); };
  $('save').onclick = async () => { busy($('save'), true); try { await api('/api/settings', readLimits()); flash = 'Limits saved.'; await load(); } catch (e) { busy($('save'), false); err('e', e); } };
  $('savep').onclick = async () => { busy($('savep'), true); try { await api('/api/settings', { payoutAddress: $('pay').value, password: $('ppw').value }); flash = 'Address saved.'; await load(); } catch (e) { busy($('savep'), false); err('e2', e); } };
  wireTelegram(); wireSpeed();
  $('unl').onclick = async () => { busy($('unl'), true); try { await api('/api/stay-unlocked', { on: !s.stayUnlocked, password: $('upw').value }); flash = 'Saved.'; await load(); } catch (e) { busy($('unl'), false); err('e3', e); } };
  if ($('wd')) $('wd').onclick = async () => {
    busy($('wd'), true, 'Sending…');
    try {
      const r = await api('/api/withdraw', { what: $('what').value, password: $('wpw').value });
      const parts = TOK.map(([k, sym]) => r[k] && `${r[k].amount} ${sym}`).filter(Boolean);
      flash = parts.length ? `Sent ${parts.join(', ')} to your main wallet.` : 'Nothing to send.';
      await load();
    } catch (e) { busy($('wd'), false); err('e4', e); }
  };
}

load().catch((e) => { $app.innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p><div class="row"><button id="rt">Retry</button></div></div>`; $('rt').onclick = () => load(); });
