// Headless end-to-end check of the local NightFi demo stack using dev mode (no
// passkey): onboard, choose a pool, deposit Night through the Passport account
// contract, claim a local Night ID, deploy a staged position, and reach the
// dashboard. WebAuthn flows still need a human.
//
// Usage: node scripts/e2e-devmode.mjs [url]

import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://localhost:5173/';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const demoHandle = `bubbles-${Date.now().toString(36).slice(-6)}`;

const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new' });
const page = await browser.newPage();
page.on('pageerror', (err) => console.log(`[pageerror] ${err.message}`));
page.on('console', (msg) => {
  const t = msg.text();
  if (t.includes('[passport]')) console.log(t);
});

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
  await waitForText('CREATE YOUR PASSPORT', 120_000);

  // Dev-mode onboarding.
  await setFirstTextInput(demoHandle);
  await page.click('input[type="checkbox"]');
  await page.type('input[type="password"]', 'e2e-test-passphrase');
  await clickButton('Create account (dev mode)');
  console.log('… deploying account and registering identity from the browser (this takes a while)');
  await waitForText('Earn yield, privately.', 300_000);
  await waitForText('Passport account', 60_000);
  const identitySession = await page.evaluate(() => {
    const raw = localStorage.getItem('passport-demo-session');
    return raw ? JSON.parse(raw) : null;
  });
  if (!identitySession?.identityRegistryAddress || !identitySession?.identityRegistrationTxId) {
    throw new Error('identity registry fields missing from saved session');
  }
  console.log(
    `✓ identity registry ${identitySession.identityRegistryAddress} tx ${identitySession.identityRegistrationTxId}`,
  );

  // One real circuit call: deposit 1000 Night through the account-custody contract.
  await clickButtonContaining('Deposit into pool');
  await waitForText('Deposit amount', 60_000);
  await clickButton('Continue - choose source');
  await waitForText('Dynamic 1am connector', 60_000);
  await waitForText('getUnshieldedAddress()', 60_000);
  await waitForText('getShieldedAddresses()', 60_000);
  await waitForText('getDustAddress()', 60_000);
  await clickButtonContaining('Continue with 1am connector');
  console.log('… proving deposit_night through the demo prover');
  await waitForText('Deposited into your Passport account contract', 300_000);
  await clickButton('Continue - verify Night ID');

  await waitForText('Verify your Night ID.', 60_000);
  await clickButton('Continue with registry identity');
  await waitForText('Deploy into pool.', 60_000);
  await clickButton('Sign deposit');
  await waitForText('Position opened', 60_000);
  await clickButtonContaining('View dashboard');
  await waitForText('Retail Yield Pool', 60_000);
  await waitForText('Active', 60_000);
  console.log('✓ NightFi flow completed — dashboard shows an active Retail Yield Pool position');

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
