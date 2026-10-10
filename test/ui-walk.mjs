// Not a unit test: walks the local page in Chromium against the fake chain and saves screenshots (node test/ui-walk.mjs <out-dir>).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRunner } from '../src/runner.mjs';
import { startServer } from '../src/server.mjs';
import { fakeFetch, fakeSender, quiet } from './fake.mjs';
const out = process.argv[2];
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');   // npm i -D playwright, or point PLAYWRIGHT_MODULE at an install
const code = 'nnlq_' + 'A'.repeat(43);
const errors = [];
for (const [name, vp] of Object.entries({ phone: { width: 390, height: 844 }, desktop: { width: 1280, height: 900 } })) {
  const DATA_DIR = mkdtempSync(join(tmpdir(), 'liqui-'));
  const runner = await makeRunner({ env: { DATA_DIR }, log: { ...quiet, recent: () => [{ t: Date.now(), level: 'info', msg: '758 wallets have borrowed on Loopback' }, { t: Date.now(), level: 'info', msg: '[dry run] full bid on 0x847f…42f3: repay 203.69 USDG, seize 0.3132 wsNET (229.51 USDG at the oracle, +25.82): Morpho accepts the bid' }] }, fetchImpl: fakeFetch({ relayToken: code, eth: 0n, usdg: 0n }), makeSender: (w) => fakeSender(w.address) });
  const server = startServer({ runner, port: 0, host: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  const base = `http://localhost:${server.address().port}`;
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const page = await (await browser.newContext({ viewport: vp, colorScheme: 'dark', isMobile: name === 'phone' })).newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
  const shot = async (n) => { await page.waitForTimeout(250); await page.screenshot({ path: join(out, `${name}-${n}.png`), fullPage: true }); const o = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth); if (o > 0) errors.push(`${name} ${n}: overflow ${o}px`); };
  await page.goto(base); await page.waitForSelector('#pw');
  await shot('1-welcome');
  await page.fill('#pw', 'correct horse battery'); await page.fill('#pw2', 'correct horse battery'); await page.click('#go');
  await page.waitForSelector('#mk'); await shot('2-wallet');
  await page.click('#mk'); await page.waitForSelector('.phrase'); await shot('3-phrase');
  const words = await page.$$eval('.phrase div', (d) => d.map((x) => x.textContent.replace(/^\d+/, '')));
  await page.check('#ok'); await page.click('#go'); await page.waitForSelector('.words3');
  for (const id of await page.$$eval('.words3 input', (xs) => xs.map((x) => x.id))) await page.fill('#' + id, words[Number(id.slice(1))]);
  await shot('4-check');
  await page.click('#go'); await page.waitForSelector('.bridges'); await runner.bot.start(); await runner.bot.tick(); await page.waitForTimeout(5500); await shot('5-fund');
  await page.click('#go'); await page.waitForSelector('#max'); await shot('6-limits');
  await page.fill('#max', '300'); await page.click('#save'); await page.waitForSelector('#code'); await shot('7-telegram');
  await page.fill('#code', code); await page.click('#pair');
  await runner.bot.start(); await runner.bot.tick();
  await page.waitForSelector('#settings'); await page.reload(); await page.waitForSelector('#settings'); await shot('8-dashboard');
  if (!(await page.isDisabled('#live'))) errors.push(name + ': Go live is enabled without ETH or USDG');
  await page.click('#settings'); await page.waitForSelector('#back'); await shot('10-settings');
  await browser.close(); server.close();
}
console.log(errors.length ? 'ERRORS\n' + errors.join('\n') : 'no errors');
