/**
 * HOME'S TOP BAR, IN A REAL BROWSER.
 *
 * The bar is the one piece of chrome a Passport user sees on every screen, and
 * two things about it came back from the 2026/09/02 review:
 *
 *   "There is no way to download the app." There was one — a corner button
 *   that appeared only on a desktop-width viewport, only once Chromium had
 *   offered a prompt, and nowhere near where anybody looks. The offer is in the
 *   bar now, and the rules behind it are drilled in
 *   `src/lib/installPrompt.test.ts`. What only a browser can answer is whether
 *   the control actually appears when the browser offers a prompt, whether
 *   pressing it replays that prompt, and whether it stays away when there is
 *   nothing to press — which is what this file is for.
 *
 * The install prompt itself is synthesised. Chromium fires
 * `beforeinstallprompt` against its own installability heuristics, which are
 * not a thing a test can arrange and are not what is being held to a standard
 * here: what is, is that a page handed one shows the control and replays it on
 * a press.
 */

import { expect, test, type Page } from '@playwright/test';

import { installNetworkBoundary, PASSPORT_ACCOUNT_ADDRESS } from './mocks.js';
import { installVirtualAuthenticator } from './passkey.js';

test.describe.configure({ mode: 'serial' });

let page: Page;

/** A label that is free in the recorded registry snapshot. */
const NAME = 'homebarwalk';

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  page = await context.newPage();
  await installNetworkBoundary(page);
  await installVirtualAuthenticator(context, page);

  /* The returning Passport, seeded exactly as `assets.spec.ts` seeds it: the
     ceremony is drilled elsewhere, and what is read here is the bar. */
  await page.goto('/');
  await page.getByRole('button', { name: /Continue with Passport/i }).click();
  await expect(page.getByRole('heading', { name: /Welcome to Passport/i })).toBeVisible({
    timeout: 90_000,
  });

  const seeded = await page.evaluate(
    ({ alias, address }) => {
      const credentialId = localStorage.getItem('passport-last-passkey');
      if (!credentialId) return null;
      const now = new Date().toISOString();
      localStorage.setItem(
        'passport-alias:v1',
        JSON.stringify({
          stagenet: {
            alias,
            domain: `${alias}.night`,
            network: 'stagenet',
            status: 'registered',
            resolverAddress: 'dd'.repeat(32),
            resolverDeployTxId: 'aa'.repeat(32),
            registerTxId: 'bb'.repeat(32),
            registryConfirmed: true,
            resolverTarget: 'contract',
            resolverTargetHex: address,
            updatedAt: now,
          },
        }),
      );
      localStorage.setItem(
        'passport-contract:v1',
        JSON.stringify({
          [`${credentialId}::stagenet`]: {
            credentialId,
            network: 'stagenet',
            status: 'deployed',
            address,
            deployTxId: 'cc'.repeat(32),
            txIdResolved: true,
            ledgerConfirmed: true,
            feePaidBy: 'sponsored',
            updatedAt: now,
          },
        }),
      );
      return credentialId;
    },
    { alias: NAME, address: PASSPORT_ACCOUNT_ADDRESS },
  );
  expect(seeded).not.toBeNull();

  await page.reload();
  await expect(page.getByRole('button', { name: /^Send$/ }).first()).toBeVisible({
    timeout: 90_000,
  });
});

test.afterAll(async () => {
  await page.context().close();
});

const installControl = () => page.getByRole('button', { name: 'Install Passport' });

test('no install control until the browser offers one', async () => {
  /* A button that cannot install anything is a dead end dressed as a feature.
     Headless Chromium fires no `beforeinstallprompt`, so there is nothing to
     press and nothing is shown. */
  await expect(installControl()).toHaveCount(0);
});

test('the offer appears in the bar the moment the browser makes one', async () => {
  await page.evaluate(() => {
    const win = window as unknown as {
      __installPrompted?: boolean;
      dispatchEvent(event: Event): boolean;
    };
    win.__installPrompted = false;
    const event = new Event('beforeinstallprompt') as Event & {
      prompt?: () => Promise<void>;
      userChoice?: Promise<{ outcome: string; platform: string }>;
    };
    event.prompt = () => {
      win.__installPrompted = true;
      return Promise.resolve();
    };
    event.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });
    window.dispatchEvent(event);
  });

  await expect(installControl()).toBeVisible();

  /* And it is IN the bar, beside the other controls — not in a corner of the
     viewport, which is where the version nobody found used to live. */
  const bar = await page.locator('.mnhome-bar-actions').boundingBox();
  const control = await installControl().boundingBox();
  expect(bar).not.toBeNull();
  expect(control).not.toBeNull();
  expect(control!.x).toBeGreaterThanOrEqual(bar!.x - 1);
  expect(control!.x + control!.width).toBeLessThanOrEqual(bar!.x + bar!.width + 1);
});

test('pressing it replays the browser’s own prompt, and nothing else', async () => {
  await installControl().click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __installPrompted?: boolean }).__installPrompted))
    .toBe(true);

  /* An accepted prompt cannot be replayed, so the control goes: there is
     nothing left to press. */
  await expect(installControl()).toHaveCount(0);
});
