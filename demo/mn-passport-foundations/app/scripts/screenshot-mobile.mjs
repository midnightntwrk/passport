// Mobile-viewport capture (iPhone-sized emulation): onboarding, MN Passport earn,
// bridge proof, Night ID, deploy, and dashboard.
//
// Usage: node scripts/screenshot-mobile.mjs [url] [outDir]

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://localhost:5173/';
const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[3] ?? resolve(here, '../../../../tmp/passport-ui');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const demoHandle = `bubbles-${Date.now().toString(36).slice(-6)}`;

mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new' });
const page = await browser.newPage();
page.setDefaultTimeout(300_000);
page.setDefaultNavigationTimeout(120_000);
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
page.on('pageerror', (err) => console.log(`[pageerror] ${err.message}`));
page.on('console', (msg) => {
  const t = msg.text();
  if (t.includes('[passport]')) console.log(t);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => {
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log(`📱 ${name}`);
};
const waitForText = async (text, timeout) => {
  await page.waitForFunction(
    (t) => document.body.innerText.toLowerCase().includes(t.toLowerCase()),
    { timeout, polling: 1000 },
    text,
  );
  console.log(`✓ saw: ${text}`);
};
const clickButton = async (label) => {
  await page.waitForFunction(
    (l) => {
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        return el.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      return [...document.querySelectorAll('button')].some(
        (b) => visible(b) && !b.disabled && b.textContent.trim() === l,
      );
    },
    { timeout: 60_000, polling: 500 },
    label,
  );
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
const clickButtonContaining = async (text, timeout = 60_000) => {
  await page.waitForFunction(
    (t) => {
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        return el.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      return [...document.querySelectorAll('button')].some(
        (b) => visible(b) && !b.disabled && b.textContent.trim().includes(t),
      );
    },
    { timeout, polling: 500 },
    text,
  );
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
  await sleep(800);
  await shot('m01-onboard');

  await setFirstTextInput(demoHandle);
  await clickButton('Deploy MN Passport account');
  console.log('… deploying account and registering identity');
  await waitForText('Earn yield, privately.', 300_000);
  await sleep(1000);
  await shot('m02-foundations-earn');

  await clickButtonContaining('Deposit into pool');
  await waitForText('Deposit amount', 60_000);
  await sleep(700);
  await shot('m03-amount');

  await clickButton('Continue - choose source');
  await waitForText('Localnet fee wallet', 60_000);
  await waitForText('deposit_night', 60_000);
  await sleep(700);
  await shot('m04-source');

  await clickButtonContaining('Deposit Night into custody');
  await sleep(6_000); // mid-prove: dock live with the on-device chip
  await shot('m05-bridge-proving');
  await waitForText('Night deposited into your MN Passport custody account', 300_000);
  await sleep(1000);
  await shot('m06-bridge-confirmed');

  await clickButton('Continue - verify Night ID');
  await waitForText('Verify your Night ID.', 60_000);
  await sleep(700);
  await shot('m07-night-id');
  await clickButton('Continue with registry identity');

  await waitForText('Deploy into pool.', 60_000);
  await sleep(700);
  await shot('m08-deploy');
  await clickButton('Sign deposit');
  await waitForText('Position opened', 60_000);
  await clickButtonContaining('View dashboard');
  await waitForText('Retail Yield Pool', 60_000);
  await sleep(1000);
  await shot('m09-dashboard');

  console.log('MOBILE SHOTS DONE');
} catch (e) {
  console.error(`MOBILE SHOTS FAILED: ${e.message}`);
  await shot('m99-failure');
  process.exitCode = 1;
} finally {
  await browser.close();
}
