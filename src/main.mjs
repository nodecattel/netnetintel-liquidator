#!/usr/bin/env node
// NetNet Loopback liquidator. Commands:
//   run (default)        watch the Loopback market and liquidate (dry run unless LIVE=1)
//   scan                 list every open loan by health, no wallet needed
//   status               the bot wallet's address and balances, and the loans closest to the line
//   new-wallet           make a fresh wallet, saved as an encrypted keystore in the data folder
//   import-key           encrypt an existing private key into the keystore
//   withdraw <address> [usdg|wsnet|all]   send the bot wallet's USDG and/or wsNET to your own address
import { getAddress } from 'ethers';
import { USDG, WSNET, EXPLORER_TX, EXPLORER_ADDR } from './constants.mjs';
import { configFrom, describe } from './config.mjs';
import { makeRpc, readTick, ERC20 } from './chain.mjs';
import { loadWallet, newWallet, importKey, terminalPrompt, keySource } from './wallet.mjs';
import { makeStore, makeLog, makeNotify } from './io.mjs';
import { makeBot, TOKENS, fmtTok } from './bot.mjs';
import { makeRunner, VERSION, senderOf as makeSender } from './runner.mjs';
import { makeIntel, intelBase } from './intel.mjs';
import { startServer } from './server.mjs';
import { makeSettings, effectiveEnv } from './settings.mjs';
import { accrue, positionView, fmtUsdg, fmtWs } from './math.mjs';

const env = process.env;
const [cmd = 'run', ...args] = process.argv.slice(2);

const senderOf = (wallet, cfg) => makeSender(wallet, cfg.rpcUrl, { sequencerUrl: cfg.sequencerUrl });

async function main() {
  // the local page's saved settings apply to every command; a non-empty environment variable wins
  const saved = makeSettings(env.DATA_DIR || '/data').get();
  const cfg = configFrom(effectiveEnv(env, saved).env);
  const log = makeLog({ json: cfg.jsonLogs, debug: cfg.debug });
  const prompt = terminalPrompt();

  if (cmd === 'new-wallet') {
    const w = await newWallet(env, prompt);
    console.log(`\nNew bot wallet: ${w.address}\nSaved, encrypted, to ${w.file} (inside the data volume).`);
    if (w.phrase) console.log(`\nRecovery phrase — write it down now and keep it offline. It is shown once:\n\n  ${w.phrase}\n`);
    console.log('Next: send this address the USDG it may bid with and a little ETH for gas (0.001 ETH lasts a long time).');
    return;
  }
  if (cmd === 'import-key') {
    const w = await importKey(env, prompt);
    console.log(`\nImported ${w.address}, saved encrypted to ${w.file}. You can remove PRIVATE_KEY from your settings now.`);
    return;
  }

  if (cmd === 'run') return run(cfg, log);
  if (!['scan', 'status', 'withdraw'].includes(cmd)) throw new Error(`unknown command "${cmd}" (run, scan, status, new-wallet, import-key, withdraw)`);
  const rpc = makeRpc(cfg.rpcUrl, { batchSize: cfg.rpcBatch }), logsRpc = cfg.logsRpcUrl === cfg.rpcUrl ? rpc : makeRpc(cfg.logsRpcUrl, { batchSize: cfg.rpcBatch });
  const needsWallet = cmd === 'withdraw' || cmd === 'status';
  const wallet = cmd === 'scan' ? null : await loadWallet(env, { prompt });
  if (needsWallet && !wallet) {
    const src = keySource(env);
    throw new Error(`no wallet: run the new-wallet or import-key command first (it saves ${src.file}), or set PRIVATE_KEY`);
  }

  if (cmd === 'withdraw') return withdraw(wallet, cfg, rpc, args);

  const store = makeStore(cfg.dataDir);
  const notify = makeNotify(env, log);
  const intel = makeIntel({ base: intelBase(env), version: VERSION });
  const bot = makeBot({ rpc, logsRpc, sender: wallet ? senderOf(wallet, cfg) : null, cfg, store, log, notify, seed: intel.enabled ? () => intel.loans() : null });
  const params = await bot.start();
  await bot.scanDone();

  if (cmd === 'scan' || cmd === 'status') {
    const view = await readTick(rpc, params, wallet?.address ?? null, [...bot.known]);
    if (wallet) { const w = view.wallet, t = (k) => `${fmtTok(w[k], k)} ${TOKENS[k].sym}`; console.log(`\nBot wallet ${wallet.address}\n  ${['eth', 'usdg', 'wsnet', 'net', 'snet'].map(t).join(' · ')} · Morpho may take ${w.allowance == null ? '?' : fmtUsdg(w.allowance)} USDG\n  ${EXPLORER_ADDR}${wallet.address}`); }
    if (view.price == null) { console.log('\nThe oracle gives no price right now (its guard holds): no loan can be liquidated.'); return; }
    const m = accrue(view.market, view.rate, view.block.timestamp);
    const rows = [...view.positions].filter(([, p]) => p.borrowShares > 0n).map(([b, p]) => ({ b, p, v: positionView(p, m, view.price, params.lltv) })).sort((a, b) => a.v.health - b.v.health);
    const n = cmd === 'scan' ? rows.length : Math.min(10, rows.length);
    console.log(`\n${rows.length} open loans at block ${view.block.number.toLocaleString()} (health: 1.000 is the 62.5% line; under it, anyone can liquidate)\n`);
    for (const r of rows.slice(0, n)) console.log(`  ${r.v.liquidatable ? 'LIQUIDATABLE' : '            '}  ${r.b}  health ${r.v.health.toFixed(4)}  debt ${fmtUsdg(r.v.debt).padStart(12)} USDG  collateral ${fmtWs(r.p.collateral).padStart(14)} wsNET`);
    return;
  }

}

// run: the loop and the local page (PAGE=0 for the loop only)
async function run(cfg, log) {
  const runner = await makeRunner({ env, log });
  const st = runner.api.state();
  log.info(`NetNet Loopback liquidator v${VERSION} · ${st.wallet.address ? 'wallet ' + st.wallet.address + (st.wallet.locked ? ' (locked: log in on the page)' : '') : 'no wallet yet'}`);
  for (const l of describe(runner.cfg)) log.info(l);
  if (env.PAGE !== '0') {
    const port = Number(env.PAGE_PORT) || 8788;
    const hosts = String(env.PAGE_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
    startServer({ runner, port, host: env.PAGE_HOST || '0.0.0.0', allowedHosts: hosts, log });
    log.info(`page: http://localhost:${port} (on this computer; publish the port to 127.0.0.1 only)`);
  }
  const ac = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log.info('stopping'); ac.abort(); setTimeout(() => process.exit(0), 3000).unref(); });
  await runner.loop(ac.signal);
}

async function withdraw(wallet, cfg, rpc, [to, what = 'all']) {
  let dest;
  try { dest = getAddress(String(to || '').trim()); } catch { throw new Error('usage: withdraw <your address> [usdg|wsnet|all]'); }
  if (!['usdg', 'wsnet', 'all'].includes(what)) throw new Error('withdraw takes usdg, wsnet or all');
  const sender = senderOf(wallet, cfg);
  const bal = async (token) => BigInt(await rpc.one('eth_call', [{ to: token, data: ERC20.encodeFunctionData('balanceOf', [wallet.address]) }, 'latest']));
  for (const [name, token, fmt] of [['USDG', USDG, fmtUsdg], ['wsNET', WSNET, fmtWs]]) {
    if (what !== 'all' && what !== name.toLowerCase()) continue;
    const amount = await bal(token);
    if (amount === 0n) { console.log(`no ${name} to send`); continue; }
    const tx = await sender.send({ to: token, data: ERC20.encodeFunctionData('transfer', [dest, amount]) });
    await tx.wait();
    console.log(`sent ${fmt(amount)} ${name} to ${dest} · ${EXPLORER_TX}${tx.hash}`);
  }
}

main().catch((e) => {
  const msg = /fetch failed|ECONNREFUSED|ENOTFOUND|timeout/i.test(e.message) ? `could not reach the RPC (${e.message}): check RPC_URL and the internet connection` : e.message;
  console.error(`✗ ${msg}`);
  process.exit(1);
});
