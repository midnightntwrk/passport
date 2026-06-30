// Headless boot smoke test: loads the app, captures console output and page
// errors, and reports what rendered. Does not exercise passkeys (WebAuthn
// needs a user gesture) — it verifies the WASM/wallet boot path only.
//
// Usage: node scripts/smoke.mjs [url] [waitMs]

import puppeteer from 'puppeteer-core';

const url = process.argv[2] ?? 'http://localhost:5173/';
const waitMs = Number(process.argv[3] ?? '45000');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
});
const page = await browser.newPage();

page.on('console', (msg) => console.log(`[console:${msg.type()}] ${msg.text()}`));
page.on('pageerror', (err) =>
  console.log(`[pageerror] ${err.message}\n${(err.stack ?? '').split('\n').slice(0, 6).join('\n')}`),
);
page.on('requestfailed', (req) =>
  console.log(`[requestfailed] ${req.url()} — ${req.failure()?.errorText}`),
);

await page.goto(url, { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, waitMs));

const text = await page.evaluate(() => document.body.innerText.slice(0, 1200));
console.log('--- body text ---');
console.log(text || '(empty)');

await browser.close();
