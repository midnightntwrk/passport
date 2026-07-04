// Headless end-to-end check of the BUSS recovery UX using dev mode: onboard
// (deploy from the browser), run a paper-only guardian ceremony (2 paper
// keys, both needed), publish the backup on-chain, then simulate total loss
// — paste both slips back in, reconstruct, and recover with a fresh
// dev-mode device. Exercises publish_recovery_backup and recover through
// the full browser stack, including the wasm BUSS bridge.
//
// Usage: node scripts/e2e-recovery.mjs [url]

import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://localhost:5173/';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new' });
const page = await browser.newPage();
// Desktop layout — the mobile breakpoint hides the round·epoch statchip.
await page.setViewport({ width: 1400, height: 900 });
page.on('pageerror', (err) => console.log(`[pageerror] ${err.message}`));
page.on('console', (msg) => {
  const t = msg.text();
  if (t.includes('[passport]')) console.log(t);
});

// Case-insensitive: several UI labels are uppercased by CSS text-transform,
// which innerText reflects.
const waitForText = async (text, timeout) => {
  await page.waitForFunction(
    (t) => document.body.innerText.toLowerCase().includes(t.toLowerCase()),
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

// React-compatible <select> setter (native setter + change event).
const setSelect = async (selector, nth, value) => {
  await page.evaluate(
    (sel, n, v) => {
      const el = document.querySelectorAll(sel)[n];
      if (!el) throw new Error(`no select: ${sel}[${n}]`);
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        'value',
      ).set;
      setter.call(el, v);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    selector,
    nth,
    value,
  );
};

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForText('CREATE YOUR PASSPORT', 120_000);

  // ── Dev-mode onboarding ──────────────────────────────────────────────────
  await page.click('input[type="checkbox"]');
  await page.type('input[type="password"]', 'e2e-recovery-passphrase');
  await clickButton('Create account (dev mode)');
  console.log('… deploying account from the browser (this takes a while)');
  await waitForText('PASSPORT ACCOUNT', 300_000);

  // ── Recovery view: paper-only ceremony (2 slips, both needed) ────────────
  await clickButton('Recovery');
  await waitForText('Guardian backup', 30_000);
  await setSelect('.ceremony-cfg select', 0, '0'); // passport guardians: 0
  // papers stays 2; needed-to-recover stays 2 → φ length 1
  await clickButton('Begin enrolment');
  await waitForText('buss-paper.v0.', 30_000);

  const slips = await page.$$eval('.slip .wire', (els) => els.map((e) => e.textContent));
  if (slips.length !== 2 || !slips.every((s) => s.startsWith('buss-paper.v0.'))) {
    throw new Error(`expected 2 paper slips, got: ${JSON.stringify(slips)}`);
  }
  console.log('✓ two paper slips generated');

  // Tick "written down" on both slips.
  await page.$$eval('.gslot .devmode-row input[type="checkbox"]', (els) =>
    els.forEach((el) => el.click()),
  );

  await clickButton('Publish backup on-chain');
  console.log('… proving publish_recovery_backup in the browser stack');
  await waitForText('A backup is live on-chain', 300_000);
  console.log('✓ backup published — φ on-chain, commitment rotated');

  // ── Total loss: paste both slips, reconstruct, recover ───────────────────
  // Selects on the page now: 3 in the backup launcher + 1 in the recover
  // panel ("guardians enrolled") — set the latter to 2.
  await setSelect('select', 3, '2');

  const pasteInput = await page.$('input[placeholder^="buss-sig"]');
  for (const slip of slips) {
    await pasteInput.type(slip);
    await clickButton('add to quorum');
  }
  await waitForText('paper key', 10_000);
  console.log('✓ quorum assembled from the two typed-in slips');

  // Dev-mode recovery device.
  await page.evaluate(() => {
    const label = [...document.querySelectorAll('label.devmode-row')].find((l) =>
      l.textContent.includes('recover with a passphrase'),
    );
    if (!label) throw new Error('no dev-mode toggle in the recover panel');
    label.querySelector('input').click();
  });
  const pass = await page.evaluateHandle(() => {
    const field = [...document.querySelectorAll('label.field')].find((l) =>
      l.textContent.includes('new passphrase'),
    );
    if (!field) throw new Error('no new-passphrase field');
    return field.querySelector('input');
  });
  await pass.asElement().type('e2e-recovered-passphrase');

  await clickButton('Reconstruct & recover');
  console.log('… proving recover in the browser stack');
  await waitForText('No backup published yet', 300_000);
  console.log('✓ spent backup cleared (φ gone) — recover landed');
  await clickButton('Overview');
  await waitForText('reissued · epoch 1', 60_000);
  console.log('✓ passport shows REISSUED at epoch 1 — account re-keyed');

  console.log('E2E-RECOVERY PASS');
} catch (e) {
  console.error(`E2E-RECOVERY FAIL: ${e.message}`);
  const text = await page.evaluate(() => document.body.innerText.slice(0, 1500));
  console.log('--- body text at failure ---');
  console.log(text);
  process.exitCode = 1;
} finally {
  await browser.close();
}
