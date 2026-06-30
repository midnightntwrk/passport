// Visual capture of the demo journey (dev-mode, headless Chrome).
//
//   node scripts/screenshot.mjs onboard   — boot + onboarding hero only (fast)
//   node scripts/screenshot.mjs full      — dev-mode onboard, fund, grant,
//                                           spend, revoke + per-view shots
//
// Shots land in <outDir> (default ../../../../tmp/passport-ui relative to
// this script, i.e. repo-root tmp/).

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const mode = process.argv[2] ?? 'onboard';
const url = process.argv[3] ?? 'http://localhost:5173/';
const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[4] ?? resolve(here, '../../../../tmp/passport-ui');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new' });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
page.on('pageerror', (err) => console.log(`[pageerror] ${err.message}`));
page.on('console', (msg) => {
  const t = msg.text();
  if (t.includes('[passport]')) console.log(t);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const shot = async (name) => {
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log(`📸 ${name}`);
};

const waitForText = async (text, timeout) => {
  await page.waitForFunction(
    (t) => document.body.innerText.includes(t),
    { timeout, polling: 1000 },
    text,
  );
  console.log(`✓ saw: ${text}`);
};

const clickButton = async (label) => {
  await page.evaluate((l) => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === l);
    if (!btn) throw new Error(`no button: ${l}`);
    btn.click();
  }, label);
};

// Sidebar navigation by step title.
const clickStep = async (title) => {
  await page.evaluate((t) => {
    const el = [...document.querySelectorAll('.step-title')].find((s) => s.textContent === t);
    if (!el) throw new Error(`no nav step: ${t}`);
    el.closest('button').click();
  }, title);
  await sleep(700); // let the reveal animation settle
};

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForText('CREATE YOUR PASSPORT', 180_000);
  await sleep(1000);
  await shot('01-onboard');

  if (mode === 'onboard') {
    console.log('DONE (onboard mode)');
    await browser.close();
    process.exit(0);
  }

  // ——— dev-mode onboarding ———
  await page.click('input[type="checkbox"]');
  await page.type('input[type="password"]', 'screenshot-run-passphrase');
  await clickButton('Create account (dev mode)');
  console.log('… deploying account from the browser');
  await sleep(20_000); // mid-deploy: proving dock live
  await shot('02-deploying');
  await waitForText('PASSPORT ACCOUNT', 300_000);
  await sleep(1200);
  await shot('03-overview');

  // ——— fund ———
  await clickStep('Holdings');
  await clickButton('Deposit Night');
  console.log('… proving deposit_night');
  await sleep(15_000);
  await shot('04-deposit-proving');
  await page.waitForFunction(
    () => [...document.querySelectorAll('td')].some((td) => td.textContent.trim() === '1000'),
    { timeout: 300_000, polling: 2000 },
  );
  console.log('✓ deposit landed');
  await sleep(1200);
  await shot('05-assets-funded');

  // ——— grant: issue, hand over, spend ———
  await clickStep('Connections');
  await clickButton('Issue grant (Night, capped)');
  console.log('… proving add_grant');
  await waitForText('GRANT SECRET — SHOWN ONCE', 300_000);
  await sleep(1200);
  await shot('06-grant-issued');

  const secret = await page.evaluate(
    () => document.querySelector('.secret-callout .mono').title.split(' ')[0],
  );
  console.log(`grant secret captured (${secret.length} hex chars)`);
  await page.evaluate(() => {
    document.querySelector('.panel-dapp input').focus();
  });
  await page.keyboard.type(secret);
  await clickButton('Spend via grant');
  console.log('… proving grant_withdraw_night');
  await waitForText('grant_withdraw_night 50 → tx', 300_000);
  await sleep(1500);
  await shot('07-grant-spent');

  // ——— revoke ———
  // revoke happens in place on the Connections view
  await sleep(700);
  await clickButton('revoke');
  console.log('… proving revoke_grant');
  await waitForText('revoke_grant → tx', 300_000);
  await sleep(1500);
  await shot('08-grant-revoked');

  // ——— browse views ———
  await clickStep('Devices');
  await shot('09-devices');
  await clickStep('Recovery');
  await shot('10-recovery');

  console.log('SCREENSHOTS DONE');
} catch (e) {
  console.error(`SCREENSHOT RUN FAILED: ${e.message}`);
  await shot('99-failure');
  const text = await page.evaluate(() => document.body.innerText.slice(0, 1500));
  console.log('--- body text at failure ---');
  console.log(text);
  process.exitCode = 1;
} finally {
  await browser.close();
}
