// Mobile-viewport capture (iPhone-sized emulation): onboarding, drawer nav,
// proving dock, funded state — using the browser prover end to end.
//
// Usage: node scripts/screenshot-mobile.mjs [url] [outDir]

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://localhost:5173/?prover=browser';
const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[3] ?? resolve(here, '../../../../tmp/passport-ui');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new' });
const page = await browser.newPage();
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

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForText('CREATE YOUR PASSPORT', 180_000);
  await sleep(800);
  await shot('m01-onboard');

  await page.click('input[type="checkbox"]');
  await page.type('input[type="password"]', 'mobile-shot-passphrase');
  await clickButton('Create account (dev mode)');
  console.log('… deploying (browser prover)');
  await waitForText('PASSPORT ACCOUNT', 300_000);
  await sleep(1000);
  await shot('m02-overview');

  await page.click('.menu-btn');
  await sleep(500);
  await shot('m03-drawer');
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.step-title')].find(
      (s) => s.textContent === 'Fund the account',
    );
    el.closest('button').click();
  });
  await sleep(700);

  await clickButton('Deposit Night');
  await sleep(6_000); // mid-prove: dock live with the on-device chip
  await shot('m04-proving');
  await page.waitForFunction(
    () => [...document.querySelectorAll('td')].some((td) => td.textContent.trim() === '1000'),
    { timeout: 300_000, polling: 2000 },
  );
  await sleep(1000);
  await shot('m05-funded');

  console.log('MOBILE SHOTS DONE');
} catch (e) {
  console.error(`MOBILE SHOTS FAILED: ${e.message}`);
  await shot('m99-failure');
  process.exitCode = 1;
} finally {
  await browser.close();
}
