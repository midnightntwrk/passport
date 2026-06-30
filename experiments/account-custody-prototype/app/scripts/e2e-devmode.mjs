// Headless end-to-end check of the browser stack using dev mode (no
// passkey): onboard (deploy from the browser) and deposit Night (a real
// circuit call proved through the /proof proxy). WebAuthn flows still need
// a human.
//
// Usage: node scripts/e2e-devmode.mjs [url]

import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://localhost:5173/';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new' });
const page = await browser.newPage();
page.on('pageerror', (err) => console.log(`[pageerror] ${err.message}`));
page.on('console', (msg) => {
  const t = msg.text();
  if (t.includes('[passport]')) console.log(t);
});

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
  await waitForText('CREATE YOUR PASSPORT', 120_000);

  // Dev-mode onboarding.
  await page.click('input[type="checkbox"]');
  await page.type('input[type="password"]', 'e2e-test-passphrase');
  await clickButton('Create account (dev mode)');
  console.log('… deploying account from the browser (this takes a while)');
  await waitForText('PASSPORT ACCOUNT', 300_000);

  // One real circuit call: deposit 1000 Night.
  await clickButton('Deposit Night');
  console.log('… proving deposit_night in the browser stack');
  await page.waitForFunction(
    () => /night|01000/.test(document.body.innerText) &&
      [...document.querySelectorAll('td')].some((td) => td.textContent.trim() === '1000'),
    { timeout: 300_000, polling: 2000 },
  );
  console.log('✓ deposit_night landed — night balance 1000 visible in the ledger table');

  console.log('E2E PASS');
} catch (e) {
  console.error(`E2E FAIL: ${e.message}`);
  const text = await page.evaluate(() => document.body.innerText.slice(0, 1500));
  console.log('--- body text at failure ---');
  console.log(text);
  process.exitCode = 1;
} finally {
  await browser.close();
}
