/**
 * Passport at a phone's width, in whichever engine and on whichever device the
 * project asked for.
 *
 * WHY IT IS A FILE OF ITS OWN (2026/09/05). Every other spec here asks whether
 * something WORKS. None of them asks whether it FITS, and until the suite grew
 * past one project nothing could: a single 420×900 Chromium is a viewport
 * chosen to be comfortable, so a layout that only survives at 420 CSS pixels
 * with a device pixel ratio of 1 and a desktop font stack looked perfect. The
 * projects added on 2026/09/05 render the same screens at an iPhone 14's 390,
 * at a Pixel 7's 412 with a device pixel ratio of 3, and in two more engines,
 * where a metric that was fine is a scroll bar or a control under the home
 * indicator.
 *
 * The three questions, and why each is worth a test rather than an eye:
 *
 *   NO HORIZONTAL SCROLL. A phone screen that scrolls sideways is broken in a
 *   way readers do not report — they scroll, find nothing, and assume the
 *   layout is what it is. One long word, one un-wrapped address, one grid
 *   whose minimum column is wider than the screen does it, and every one of
 *   those is a thing Passport puts on a screen.
 *
 *   THE BAR CLEARS THE HOME INDICATOR. The bottom tab bar is the app's only
 *   navigation, and on a handset the bottom of the viewport is where the
 *   system's own gesture area is. `nav.css` reserves it with
 *   `max(8px, env(safe-area-inset-bottom))`. Playwright emulates no insets, so
 *   what CAN be established here is the reservation's floor — that the bar
 *   pads its own bottom and its tabs sit above that padding rather than
 *   against the edge — which is the half that a refactor silently removes.
 *
 *   SHEETS ARE REACHABLE. A sheet whose primary action is below the fold on a
 *   short screen, with the sheet itself not scrolling, is a dead end: the
 *   reader can see the sheet and cannot finish. Send and Receive are the two
 *   that matter, because they are the two that spend.
 *
 * The Passport is enrolled and then SEEDED, exactly as `assets.spec.ts` does
 * it and for the reason given there: a real claim is a proved transaction, and
 * nothing this file asserts is about the claim.
 */

import { expect, test, type Page } from '@playwright/test';

import { installNetworkBoundary, PASSPORT_ACCOUNT_ADDRESS } from './mocks.js';
import { installVirtualAuthenticator } from './passkey.js';
import { walkContextOptions } from './walkContext.js';

test.describe.configure({ mode: 'serial' });

let page: Page;

/** A label that is free in the recorded registry snapshot. */
const NAME = 'fitswalk';

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext(
    walkContextOptions({ viewport: { width: 420, height: 900 } }),
  );
  page = await context.newPage();
  await installNetworkBoundary(page);
  await installVirtualAuthenticator(context, page);

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

/**
 * How far past the right edge the document runs.
 *
 * `scrollWidth` against `clientWidth` on BOTH the document element and the
 * body, because either can be the scrolling box depending on how the app's
 * root is laid out, and a one-pixel tolerance because a fractional layout
 * width rounds up and a rounding error is not a broken screen.
 */
async function overflow(): Promise<number> {
  return page.evaluate(() => {
    const root = document.documentElement;
    return Math.max(
      root.scrollWidth - root.clientWidth,
      document.body.scrollWidth - root.clientWidth,
    );
  });
}

/** Moves to one of the three tabs and waits for it to be the current one. */
async function openTab(name: RegExp): Promise<void> {
  const tab = page.locator('.mnnav .mnnav-tab', { hasText: name });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-current', 'page');
}

for (const tab of [
  { label: 'Home', pattern: /Home/i },
  { label: 'Assets', pattern: /Assets/i },
  { label: 'Apps', pattern: /Apps/i },
]) {
  test(`${tab.label} fits the screen sideways`, async () => {
    await openTab(tab.pattern);
    expect(await overflow()).toBeLessThanOrEqual(1);
  });
}

test('the tab bar sits inside the viewport, and reserves the home indicator', async () => {
  await openTab(/Home/i);
  const bar = page.locator('.mnnav');
  await expect(bar).toBeVisible();

  const measured = await bar.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const tabs = [...node.querySelectorAll('.mnnav-tab')].map((tab) =>
      tab.getBoundingClientRect(),
    );
    return {
      barBottom: box.bottom,
      barTop: box.top,
      lowestTab: Math.max(...tabs.map((tab) => tab.bottom)),
      viewport: window.innerHeight,
      count: tabs.length,
    };
  });

  expect(measured.count).toBe(3);
  /* WHOLLY ON SCREEN, top and bottom. A bar whose own box runs past the
     viewport has already put its tabs where a thumb cannot reach them. */
  expect(measured.barTop).toBeGreaterThanOrEqual(0);
  expect(measured.barBottom).toBeLessThanOrEqual(measured.viewport + 1);

  /* THE CLEARANCE. The bar is a floating pill, so the reservation is its
     OFFSET from the viewport bottom rather than padding inside it —
     `bottom: max(8px, env(safe-area-inset-bottom))` in `nav.css`. Playwright
     emulates no inset, so 8 is the floor this can be held to; on a handset the
     same expression grows to the home indicator's own height. A refactor that
     welds the bar to the edge fails here. */
  expect(measured.viewport - measured.barBottom).toBeGreaterThanOrEqual(8 - 1);

  /* And every tab is inside the bar, so the clearance is really clearance. */
  expect(measured.lowestTab).toBeLessThanOrEqual(measured.barBottom + 1);
});

for (const sheet of [
  { label: 'Send', action: /^Send$/, heading: /Send/i },
  { label: 'Receive', action: /^Receive$/, heading: /Receive/i },
]) {
  test(`the ${sheet.label} sheet fits, and its content is reachable`, async () => {
    await openTab(/Home/i);
    await page.getByRole('button', { name: sheet.action }).first().click();

    /* Both sheets are the same component shell — `.mnhome-addr-modal`, with
       `role="dialog"` on it — so one locator reads either. */
    const panel = page.locator('.mnhome-addr-modal');
    await expect(panel).toBeVisible();

    expect(await overflow()).toBeLessThanOrEqual(1);

    /* REACHABLE, not merely present. Every control in the sheet must be
       scrollable into the viewport — a sheet taller than a short screen that
       does not scroll is one whose last control cannot be pressed. */
    const bottomMost = panel.locator('button, input, a').last();
    await bottomMost.scrollIntoViewIfNeeded();
    await expect(bottomMost).toBeInViewport();

    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
  });
}
