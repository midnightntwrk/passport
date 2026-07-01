// Headless end-to-end check of the local MN Passport demo stack using a local
// demo device secret: onboard, choose a pool, deposit Night through the MN Passport custody
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
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
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

const clickNav = async (label) => {
  await page.waitForFunction(
    (l) => [...document.querySelectorAll('.sidenav .step')].some((b) => b.textContent.includes(l)),
    { timeout: 60_000, polling: 500 },
    label,
  );
  await page.evaluate((l) => {
    const btn = [...document.querySelectorAll('.sidenav .step')].find((b) =>
      b.textContent.includes(l),
    );
    if (!btn) throw new Error(`no nav item: ${l}`);
    btn.click();
  }, label);
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
  await waitForText('CREATE YOUR MN PASSPORT', 120_000);

  // Local-demo onboarding: no browser passkey or credential storage.
  await setFirstTextInput(demoHandle);
  await clickButton('Deploy MN Passport account');
  console.log('… deploying account and registering identity from the browser (this takes a while)');
  await waitForText('Launch a dApp from Passport', 300_000);
  await waitForText('Account custody inspection', 60_000);
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

  await clickButtonContaining('Open');
  await waitForText('Sign in with MN Passport', 60_000);
  await waitForText('Passport account ID', 60_000);
  await clickButtonContaining('Sign in with MN Passport');
  await waitForText('Earn yield, privately.', 60_000);
  await waitForText('Custody balance', 60_000);

  // One real circuit call: deposit 1000 Night through the account-custody contract.
  await clickButtonContaining('Deposit into pool');
  await waitForText('Deposit amount', 60_000);
  await clickButton('Continue - choose source');
  await waitForText('Passport funding rail', 60_000);
  await waitForText('deposit_night', 60_000);
  await clickButtonContaining('Deposit Night into custody');
  console.log('… proving deposit_night through the localnet custody path');
  await waitForText('Night deposited into your MN Passport custody account', 300_000);
  await clickButton('Continue - verify Night ID');

  await waitForText('Verify your Night ID.', 60_000);
  await clickButton('Continue with registry identity');
  await waitForText('Deploy into pool.', 60_000);
  await clickButton('Sign deposit');
  await waitForText('Position opened', 60_000);
  await clickButtonContaining('View dashboard');
  await waitForText('Retail Yield Pool', 60_000);
  await waitForText('Active', 60_000);
  console.log('✓ MN Passport flow completed — dashboard shows an active Retail Yield Pool position');

  // The second demo flow: the MN Passport custody/account-management workspace.
  // It should expose the live contract wallet state created above.
  await clickButton('Custody details');
  await waitForText('MN Passport holdings', 60_000);
  await waitForText('Night — unshielded', 60_000);
  await waitForText('Shielded — MN Passport custody', 60_000);
  const custodyHasDeposit = await page.evaluate(() =>
    [...document.querySelectorAll('tbody tr')].some((row) => row.textContent?.includes('1000')),
  );
  if (!custodyHasDeposit) {
    throw new Error('custody holdings did not show the deposited 1000 Night balance');
  }
  console.log('✓ custody holdings show the deposited Night balance');

  await clickNav('Passport Home');
  await waitForText('Your MN Passport wallet is a contract', 60_000);
  await waitForText('MN Passport ID registry', 60_000);
  await waitForText('Identity tx', 60_000);
  await waitForText('Recovery shares', 60_000);
  await waitForText('Account custody inspection', 60_000);
  await waitForText('Transaction inspector', 60_000);
  await waitForText('NightFi custody deposit', 60_000);
  await waitForText('deposit_night', 60_000);
  console.log('✓ wallet overview exposes contract, identity, device, grant, and recovery state');

  await clickNav('Connections');
  await waitForText('Grants on-chain', 60_000);
  await waitForText("The dApp's console", 60_000);

  await clickNav('Devices');
  await waitForText('Registered devices', 60_000);
  await waitForText('this device', 60_000);

  await clickNav('Recovery');
  await waitForText('Recovery shares', 60_000);
  await waitForText('Simulate the disaster', 60_000);

  await clickNav('Passport Home');
  await clickButtonContaining('Open');
  await waitForText('Sign in with MN Passport', 60_000);
  await clickButtonContaining('Sign in with MN Passport');
  await waitForText('Earn yield, privately.', 60_000);
  console.log('✓ custody workspace completed — overview, holdings, connections, devices, recovery, and return flow render');

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
