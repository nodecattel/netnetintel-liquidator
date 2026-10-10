// The liquidator's page: a password, the bot's own wallet, funding, limits, Telegram, then dry run or live, and a
// dashboard. No libraries and nothing loaded from the internet; it only talks to the bot on this computer.
const $app = document.getElementById('app'), $pills = document.getElementById('pills');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n2 = (v) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const n4 = (v) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 }));
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');
const ago = (t) => { if (!t) return '—'; const s = Math.round((Date.now() - t) / 1000); return s < 90 ? s + 's ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago'; };
const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
  if (view === 'auto' && !store.get('liq-funded') && !S.status.wallet?.usdg) return fundStep();
  if (st.maxRepayUsdg == null) return limitsStep(true);
  if (!S.telegram.linked && !store.get('liq-skip-tg')) return telegramStep(true);
  return dashboard();
}
function footer() {
  const st = S.status, fd = $('fdot'), fs = $('fstatus');
  $('fver').textContent = S.version ? 'v' + S.version : '';
  const bad = st.lastError, warn = st.paused || st.oraclePaused || S.wallet.locked;
  fd.className = 'dot ' + (bad ? 'bad' : warn ? 'warn' : st.block ? 'ok' : '');
  fs.textContent = bad ? 'RPC problem' : S.wallet.locked ? 'Locked' : st.block ? 'Block ' + Number(st.block).toLocaleString('en-US') : st.started ? 'Starting' : 'Finding borrowers';
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
  const w = S.wallet, b = S.status.wallet;
  $app.innerHTML = `${head('Fund the bot', 'On Robinhood Chain. The bot repays loans with USDG and pays gas in ETH.')}${steps(2)}
    ${flash ? `<div class="note ok">${esc(flash)}</div>` : ''}
    <div class="card"><h2>Bot wallet</h2>
      <div class="addr"><code>${esc(w.address)}</code><button class="copy" id="cp">Copy</button><a class="small" href="${EXPLORER}/address/${esc(w.address)}" target="_blank" rel="noopener">Explorer ↗</a></div>
      <ul><li><b>USDG</b>: what it may liquidate with. Loans range from a few USDG to a few hundred; with less, it liquidates part of a loan.</li>
      <li><b>A little ETH</b> for gas: about 0.001 ETH covers hundreds of liquidations.</li></ul>
      <div class="kv"><div><span>USDG</span><b>${n2(b?.usdg)}</b></div><div><span>ETH</span><b>${b ? b.eth.toFixed(5) : '—'}</b></div></div>
      <p class="hint">Balances refresh every few seconds. You can also continue unfunded and watch in dry run.</p>
      <div class="row"><button class="primary" id="go">Continue</button></div></div>`;
  flash = '';
  copyBtn('cp', w.address);
  $('go').onclick = () => { store.set('liq-funded', '1'); view = 'auto'; render(); };
  timer = setTimeout(() => load().catch(() => null), 6000);
}

// ---- 3. limits (and the settings screen) ----
function limitsFields(s) {
  const fx = (k) => (s.fixed.includes(k) ? ' <span class="fixed">set by the environment</span>' : '');
  return `<label for="max">Most one liquidation may repay (USDG)${fx('MAX_REPAY_USDG')}</label><input id="max" type="number" min="1" step="1" value="${s.maxRepayUsdg ?? ''}" placeholder="e.g. 300">
    <p class="hint">Required before going live. The bot also never spends more than the wallet holds.</p>
    <label for="res">Keep in reserve (USDG)${fx('RESERVE_USDG')}</label><input id="res" type="number" min="0" step="1" value="${s.reserveUsdg ?? 0}">
    <label for="minp">Skip liquidations earning less than (USDG)${fx('MIN_PROFIT_USDG')}</label><input id="minp" type="number" min="0" step="0.05" value="${s.minProfitUsdg ?? 0.25}">
    <label><input type="checkbox" id="part" ${s.allowPartial ? 'checked' : ''}> Liquidate part of a loan when the wallet can't cover all of it${fx('ALLOW_PARTIAL')}</label>
    <details><summary>Speed: your own RPC</summary>
      <label for="rpc">RPC address${fx('RPC_URL')} <span class="muted">(empty: the public Robinhood Chain RPC)</span></label><input id="rpc" type="text" autocomplete="off" spellcheck="false" placeholder="${s.customRpc ? esc(s.rpcUrl || 'saved') + ' (saved: type a new one to replace)' : 'https://…'}">
      <p class="hint">A private RPC is faster. If it caps eth_getLogs (QuickNode: 10,000 blocks), keep the next field on the public RPC.</p>
      <label for="lrpc">RPC for finding borrowers${fx('LOGS_RPC_URL')} <span class="muted">(empty: same as above)</span></label><input id="lrpc" type="text" autocomplete="off" spellcheck="false" placeholder="${s.logsRpc ? 'saved (type a new one to replace)' : 'https://rpc.mainnet.chain.robinhood.com'}">
      <label for="rpw">Page password <span class="muted">(only to change an RPC: it decides what the bot believes)</span></label><input id="rpw" type="password" autocomplete="current-password">
      <label for="tick">Check every (seconds)${fx('TICK_SECONDS')}</label><input id="tick" type="number" min="1" max="60" step="1" value="${s.tickSeconds}">
    </details>`;
}
function readLimits() {
  const out = { maxRepayUsdg: $('max').value, reserveUsdg: $('res').value, minProfitUsdg: $('minp').value, allowPartial: $('part').checked, tickSeconds: $('tick').value };
  if ($('rpc').value.trim()) out.rpcUrl = $('rpc').value.trim();
  if ($('lrpc').value.trim()) out.logsRpcUrl = $('lrpc').value.trim();
  if (out.rpcUrl || out.logsRpcUrl) out.password = $('rpw').value;
  return out;
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
      <div class="row"><button class="primary" id="save">Save limits</button></div><div class="err" id="e" role="alert"></div></div>
    <div class="card"><h2>Where seized wsNET goes</h2>${payoutFields(s)}
      <div class="row"><button id="savep">Save address</button></div><div class="err" id="e2" role="alert"></div></div>`;
  flash = '';
  $('save').onclick = async () => { busy($('save'), true); try { await api('/api/settings', readLimits()); flash = 'Limits saved.'; await load(); } catch (e) { busy($('save'), false); err('e', e); } };
  $('savep').onclick = async () => { busy($('savep'), true); try { await api('/api/settings', { payoutAddress: $('pay').value, password: $('ppw').value }); $('ppw').value = ''; flash = 'Address saved.'; await load(); } catch (e) { busy($('savep'), false); err('e2', e); } };
}

// ---- 4. Telegram ----
function telegramBlock(t) {
  if (t.linked) return `<div class="note ok">Linked to @netnetintel_bot${t.paused ? ' · paused from Telegram' : ''}.</div>${t.error ? `<div class="note warn">${esc(t.error)}</div>` : ''}
    <p>You get liquidations, misses, low gas and restarts in Telegram, and can pause or resume from /liquidator. Telegram can't change limits, switch live on or move funds.</p>
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
  $app.innerHTML = `${head('Telegram', 'Optional: hear about every liquidation, and pause the bot from your phone.')}${steps(4)}
    <div class="card">${telegramBlock(S.telegram)}<div class="row"><button id="skip">Skip for now</button></div></div>`;
  wireTelegram();
  $('skip').onclick = () => { store.set('liq-skip-tg', '1'); render(); };
}

// ---- dashboard ----
function dashboard() {
  const st = S.status, s = S.settings, w = S.status.wallet, t = S.telegram;
  const lowGas = w && w.eth < 0.00005, noUsdg = w && w.usdg <= 0.01;
  const notes = [
    S.wallet.locked ? '<div class="note bad">The wallet is locked: log out and in again to unlock it.</div>' : '',
    st.lastError ? `<div class="note bad">The last check failed: ${esc(st.lastError)}. Check the RPC in Settings.</div>` : '',
    st.oraclePaused ? '<div class="note warn">The Loopback oracle is holding liquidations (the pool sits more than 15% under the TWAP). The bot waits and resumes on its own.</div>' : '',
    lowGas ? '<div class="note warn">Low on ETH for gas: send the bot wallet a little ETH.</div>' : '',
    s.live && noUsdg ? '<div class="note warn">Live, but the wallet has no USDG to liquidate with.</div>' : '',
    t.paused ? '<div class="note warn">Paused from Telegram: resume it from /liquidator.</div>' : '',
    flash ? `<div class="note ok">${esc(flash)}</div>` : '',
  ].join('');
  flash = '';
  const closest = st.closest || [];
  $app.innerHTML = `${head('Liquidator', s.live ? (st.paused ? 'Live, paused: watching, sending nothing.' : 'Live: liquidating from your wallet when a loan crosses the line.') : 'Dry run: it finds and simulates liquidations, and sends nothing.')}
    ${notes}
    <div class="grid">
      <div class="card"><h2>Market</h2><div class="kv">
        <div><span>Open loans</span><b>${st.open ?? '—'}</b></div><div><span>Near the line</span><b>${st.hot ?? '—'}</b></div>
        <div><span>Closest</span><b>${closest[0] ? closest[0].health.toFixed(4) + '×' : '—'}</b></div><div><span>Liquidatable</span><b>${st.ready ?? 0}</b></div></div>
        <p class="hint">Health 1.000 is the 62.5% line. Checked ${ago(st.lastTickAt)}.</p></div>
      <div class="card"><h2>Bot wallet</h2>
        <div class="addr"><code>${esc(short(S.wallet.address))}</code><button class="copy" id="cp">Copy</button><a class="small" href="${EXPLORER}/address/${esc(S.wallet.address || '')}" target="_blank" rel="noopener">Explorer ↗</a></div>
        <div class="kv"><div><span>USDG</span><b>${n2(w?.usdg)}</b></div><div><span>wsNET</span><b>${n4(w?.wsnet)}</b></div><div><span>ETH</span><b>${w ? w.eth.toFixed(5) : '—'}</b></div></div></div>
    </div>
    <div class="card"><h2>Controls</h2>
      <div class="row mt0">
        ${s.live ? '<button id="dry">Back to dry run</button>' : '<button class="primary" id="live">Go live…</button>'}
        ${st.paused && !t.paused ? '<button id="resume">Resume</button>' : !st.paused ? '<button id="pause">Pause</button>' : ''}
        <button id="settings">Settings</button><button id="logout">Log out</button>
      </div>
      <div id="liveform"></div><div class="err" id="e" role="alert"></div>
      <p class="hint">Limit: up to ${s.maxRepayUsdg != null ? n2(s.maxRepayUsdg) + ' USDG' : '—'} per liquidation, ${n2(s.reserveUsdg)} USDG kept, min profit ${n2(s.minProfitUsdg)} USDG${s.payoutAddress ? `, wsNET to ${esc(short(s.payoutAddress))}` : ''}. Telegram: ${t.linked ? 'linked' : 'not linked'}.</p>
    </div>
    <div class="card"><h2>Closest to the line</h2>${closest.length ? `<div class="tablewrap"><table><thead><tr><th>Loan</th><th class="num">Health</th><th class="num">Debt (USDG)</th></tr></thead><tbody>
      ${closest.map((c) => `<tr><td><a href="${EXPLORER}/address/${esc(c.borrower)}" target="_blank" rel="noopener"><code>${esc(short(c.borrower))}</code></a></td><td class="num ${c.health < 1 ? 'neg' : ''}">${c.health.toFixed(4)}</td><td class="num">${n2(c.debt)}</td></tr>`).join('')}</tbody></table></div>` : `<p class="muted">${st.started ? 'No open loans read yet.' : 'Finding every borrower since the market opened (a minute or two)…'}</p>`}</div>
    <div class="card"><h2>Liquidations</h2>${S.history.length ? `<div class="tablewrap"><table><thead><tr><th>When</th><th>Loan</th><th class="num">Repaid</th><th class="num">Seized wsNET</th><th class="num">Profit*</th><th></th></tr></thead><tbody>
      ${S.history.map((h) => `<tr><td>${esc(when(h.at))}</td><td><code>${esc(short(h.borrower))}</code></td><td class="num">${esc(h.repaid)}</td><td class="num">${esc(h.seized)}</td><td class="num pos">+${esc(h.profitAtOracle)}</td><td><a href="${EXPLORER}/tx/${esc(h.tx)}" target="_blank" rel="noopener">tx ↗</a></td></tr>`).join('')}</tbody></table></div><p class="hint">* At the oracle price, in USDG.</p>` : '<p class="muted">None yet.</p>'}</div>
    <div class="card"><h2>Activity</h2><div class="log">${(S.log || []).slice().reverse().map((l) => `<div class="${esc(l.level)}">${esc(new Date(l.t).toLocaleTimeString())} ${esc(l.msg)}</div>`).join('') || 'Nothing yet.'}</div></div>`;
  copyBtn('cp', S.wallet.address || '');
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
  timer = setTimeout(() => { if (!document.activeElement || !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) load().catch(() => null); else timer = setTimeout(() => load().catch(() => null), 5000); }, 5000);
}

// ---- settings: limits, payout, Telegram, unlock after restarts, withdraw ----
function settingsScreen() {
  const s = S.settings;
  $app.innerHTML = `${head('Settings')}<div class="row mb16"><button id="back">« Dashboard</button></div>
    ${flash ? `<div class="note ok">${esc(flash)}</div>` : ''}
    <div class="card"><h2>Limits</h2>${limitsFields(s)}<div class="row"><button class="primary" id="save">Save limits</button></div><div class="err" id="e" role="alert"></div></div>
    <div class="card"><h2>Your main wallet</h2>${payoutFields(s)}<div class="row"><button id="savep">Save address</button></div><div class="err" id="e2" role="alert"></div></div>
    <div class="card"><h2>Telegram</h2>${telegramBlock(S.telegram)}</div>
    <div class="card"><h2>After a restart</h2>
      <p>${s.stayUnlocked ? '<b>On</b>: the bot unlocks its wallet by itself after a restart (the password is kept in the data volume).' : '<b>Off</b>: after a restart (a reboot, an update) the wallet stays locked until you log in here, and Telegram tells you.'}</p>
      <p class="hint">On keeps it running unattended on a server you trust. Off is safer if someone else could copy the data volume.</p>
      <label for="upw">Page password</label><input id="upw" type="password" autocomplete="current-password">
      <div class="row"><button id="unl">${s.stayUnlocked ? 'Turn off' : 'Turn on'}</button></div><div class="err" id="e3" role="alert"></div></div>
    <div class="card"><h2>Withdraw</h2>
      ${s.payoutAddress ? `<p>Sends the bot wallet's funds to <code>${esc(s.payoutAddress)}</code>, your saved main wallet, and nowhere else.</p>
        <div class="row mt6"><label class="inline"><select id="what"><option value="all">Everything</option><option value="usdg">USDG</option><option value="wsnet">wsNET</option><option value="eth">ETH</option></select></label></div>
        <label for="wpw">Page password</label><input id="wpw" type="password" autocomplete="current-password">
        <div class="row"><button class="danger" id="wd">Withdraw</button></div><div class="err" id="e4" role="alert"></div>` : '<p class="muted">Save your main wallet above first: withdrawals only go there.</p>'}</div>`;
  flash = '';
  $('back').onclick = () => { view = 'auto'; render(); };
  $('save').onclick = async () => { busy($('save'), true); try { await api('/api/settings', readLimits()); flash = 'Limits saved.'; await load(); } catch (e) { busy($('save'), false); err('e', e); } };
  $('savep').onclick = async () => { busy($('savep'), true); try { await api('/api/settings', { payoutAddress: $('pay').value, password: $('ppw').value }); flash = 'Address saved.'; await load(); } catch (e) { busy($('savep'), false); err('e2', e); } };
  wireTelegram();
  $('unl').onclick = async () => { busy($('unl'), true); try { await api('/api/stay-unlocked', { on: !s.stayUnlocked, password: $('upw').value }); flash = 'Saved.'; await load(); } catch (e) { busy($('unl'), false); err('e3', e); } };
  if ($('wd')) $('wd').onclick = async () => {
    busy($('wd'), true, 'Sending…');
    try {
      const r = await api('/api/withdraw', { what: $('what').value, password: $('wpw').value });
      const parts = ['usdg', 'wsnet', 'eth'].filter((k) => r[k]).map((k) => `${r[k].amount} ${k === 'usdg' ? 'USDG' : k === 'wsnet' ? 'wsNET' : 'ETH'}`);
      flash = parts.length ? `Sent ${parts.join(', ')} to your main wallet.` : 'Nothing to send.';
      await load();
    } catch (e) { busy($('wd'), false); err('e4', e); }
  };
}

load().catch((e) => { $app.innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p><div class="row"><button id="rt">Retry</button></div></div>`; $('rt').onclick = () => load(); });
