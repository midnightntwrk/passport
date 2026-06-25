// Visual capture of the MN Passport demo journey (dev-mode, headless Chrome).
//
//   node scripts/screenshot.mjs onboard   — boot + onboarding hero only (fast)
//   node scripts/screenshot.mjs foundations   — onboard + MN Passport earn screen
//   node scripts/screenshot.mjs full      — onboard, pool, source, bridge,
//                                           Night ID, deploy, dashboard
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
const demoHandle = `bubbles-${Date.now().toString(36).slice(-6)}`;

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
    (t) => document.body.innerText.toLowerCase().includes(t.toLowerCase()),
    { timeout, polling: 1000 },
    text,
  );
  console.log(`✓ saw: ${text}`);
};

const waitForButton = async (matcher, value, timeout = 60_000) => {
  await page.waitForFunction(
    ({ kind, value: v }) => {
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        return el.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      return [...document.querySelectorAll('button')].some((b) => {
        const text = b.textContent.trim();
        const matches = kind === 'exact' ? text === v : text.includes(v);
        return matches && visible(b) && !b.disabled;
      });
    },
    { timeout, polling: 500 },
    { kind: matcher, value },
  );
};

const clickButton = async (label) => {
  await waitForButton('exact', label);
  await page.evaluate((l) => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      return el.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const btn = [...document.querySelectorAll('button')].find(
      (b) => visible(b) && !b.disabled && b.textContent.trim() === l,
    );
    if (!btn) throw new Error(`no button: ${l}`);
    btn.click();
  }, label);
};

const clickButtonContaining = async (text, timeout) => {
  await waitForButton('contains', text, timeout);
  await page.evaluate((t) => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      return el.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const btn = [...document.querySelectorAll('button')].find(
      (b) => visible(b) && !b.disabled && b.textContent.trim().includes(t),
    );
    if (!btn) throw new Error(`no button containing: ${t}`);
    btn.click();
  }, text);
};

const setFirstTextInput = async (value) => {
  const input = await page.$('.onboard-card .field input:not([type="password"])');
  if (!input) throw new Error('no onboarding name input');
  await page.$eval(
    '.onboard-card .field input:not([type="password"])',
    (el, nextValue) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(el, nextValue);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    value,
  );
};

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForText('CREATE YOUR MN PASSPORT', 180_000);
  await sleep(1000);
  await shot('01-onboard');

  if (mode === 'onboard') {
    console.log('DONE (onboard mode)');
    await browser.close();
    process.exit(0);
  }

  // ——— local-demo onboarding ———
  await setFirstTextInput(demoHandle);
  await clickButton('Deploy MN Passport account');
  console.log('… deploying account and registering identity from the browser');
  await sleep(20_000); // mid-deploy: proving dock live
  await shot('02-deploying');
  await waitForText('Earn yield, privately.', 300_000);
  await sleep(1200);
  await shot('03-foundations-earn');

  if (mode === 'token' || mode === 'foundations') {
    console.log('DONE (foundations mode)');
    await browser.close();
    process.exit(0);
  }

  // ——— MN Passport pool + amount ———
  await clickButtonContaining('Deposit into pool');
  await waitForText('Deposit amount', 60_000);
  await sleep(700);
  await shot('04-amount');

  // ——— source funds ———
  await clickButton('Continue - choose source');
  await waitForText('Dynamic 1am connector', 60_000);
  await waitForText('getUnshieldedAddress()', 60_000);
  await waitForText('getShieldedAddresses()', 60_000);
  await waitForText('getDustAddress()', 60_000);
  await sleep(700);
  await shot('05-source');

  // ——— real custody deposit ———
  await clickButtonContaining('Continue with 1am connector');
  console.log('… proving deposit_night');
  await sleep(8_000);
  await shot('06-bridge-proving');
  await waitForText('Deposited into your MN Passport custody account', 300_000);
  console.log('✓ deposit landed');
  await sleep(1200);
  await shot('07-bridge-confirmed');

  // ——— registry-backed Night ID ———
  await clickButton('Continue - verify Night ID');
  await waitForText('Verify your Night ID.', 60_000);
  await sleep(700);
  await shot('08-night-id');
  await clickButton('Continue with registry identity');

  // ——— staged capital deployment ———
  await waitForText('Deploy into pool.', 60_000);
  await sleep(700);
  await shot('09-deploy');
  await clickButton('Sign deposit');
  await waitForText('Position opened', 60_000);
  await sleep(700);
  await shot('10-position-opened');
  await clickButtonContaining('View dashboard');
  await waitForText('Retail Yield Pool', 60_000);
  await sleep(1200);
  await shot('11-dashboard');

  // Keep one technical custody shot for engineering review.
  await clickButton('Custody details');
  await waitForText('MN PASSPORT CUSTODY ACCOUNT', 60_000);
  await sleep(1200);
  await shot('12-custody-funded');

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
