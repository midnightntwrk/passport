/**
 * The Assets shelf, in a real browser.
 *
 * "I want to access that so I can see all the assets my passport holds. Those
 * assets can be NFTs and tokens" (2026/08/31). What that ask turns into is two
 * shelves and a third tab, and this file drills the parts of it that only a
 * browser can answer: that the bar really has three tabs, that they really
 * switch, that both shelves are on screen with their headings, that the empty
 * shelf says what it is rather than hiding, and — the standing rule for every
 * surface that shows a colour — that not one of the 64 characters reaches a
 * card.
 *
 * WHY THIS FILE, AND NOT A COMPONENT TEST
 * ---------------------------------------
 * There is no jsdom in this workspace, on purpose: `vitest.config.ts` says so
 * and gives the reason — a fake DOM proves what a fake DOM does. The RULES
 * behind this screen are pure and are drilled where they live, in
 * `src/lib/colour.test.ts`: which shelf a holding lands on, what happens to a
 * named colour held exactly once, and that splitting never re-orders. What is
 * left over is rendering, and rendering is drilled here, against a production
 * build, driven by a real passkey.
 *
 * WHAT IS NOT PROVED HERE, AND WHY
 * --------------------------------
 * An item card with an item on it. The mocked tier's account is a REAL stagenet
 * account replayed from a recording (`e2e/mocks.ts`), and it holds NIGHT and
 * the sponsor's stablecoin — no colour held in single supply. Putting one there
 * would mean minting a contract state, which this workspace's Node graph cannot
 * do; the same limitation is already recorded against the five-token cap in
 * `onboarding.spec.ts`. So the shelf is proved EMPTY here, honestly, and the
 * rule that fills it is proved in the unit drills.
 */

import { expect, test, type Page } from '@playwright/test';

import { installNetworkBoundary, PASSPORT_ACCOUNT_ADDRESS } from './mocks.js';
import { installVirtualAuthenticator } from './passkey.js';

test.describe.configure({ mode: 'serial' });

let page: Page;

/** A label that is free in the recorded registry snapshot. */
const NAME = 'assetswalk';

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  page = await context.newPage();
  await installNetworkBoundary(page);
  await installVirtualAuthenticator(context, page);

  /* A Passport that already exists, which is the state this screen is read in:
     the ceremony is drilled by `onboarding.spec.ts` and, for real, by
     `stagenet.live.spec.ts`. Enrol once, then seed the records a completed
     claim writes — the returning-Passport path, through the same components
     with the same props. */
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

/** The bottom bar's tabs, in the order they are drawn. */
function tabs() {
  return page.locator('.mnnav .mnnav-tab');
}

test('the bar offers three tabs, and the middle one is Assets', async () => {
  await expect(tabs()).toHaveCount(3);
  await expect(tabs()).toHaveText([/Home/i, /Assets/i, /Apps/i]);

  /* Three tabs in a bar sized for two is how a label wraps inside a
     fixed-height pill. Each one gets a real share of the bar and none of them
     overflows it. */
  const bar = await page.locator('.mnnav').boundingBox();
  expect(bar).not.toBeNull();
  for (let index = 0; index < 3; index += 1) {
    const box = await tabs().nth(index).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(80);
    expect(box!.x).toBeGreaterThanOrEqual(bar!.x - 1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(bar!.x + bar!.width + 1);
  }
});

test('Assets shows both shelves, and the empty one says so', async () => {
  await tabs().nth(1).click();
  await expect(tabs().nth(1)).toHaveAttribute('aria-current', 'page');

  await expect(page.getByRole('heading', { name: 'Assets', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Tokens', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'NFTs', level: 2 })).toBeVisible();

  /* THREE token cards, and the third one is the point.
     The account this tier replays holds 2000 atomic NIGHT and 100 units of a
     stablecoin colour recorded from stagenet, while the mocked sponsor names a
     DIFFERENT colour as its own over `/status`. So the shelf carries NIGHT, the
     sponsor's colour at a real zero, and the recorded one at 100 — two rows
     that would both have read "mUSD" and held different money, which is exactly
     the collision `describeColours` qualifies. Asserted here because it is the
     configuration this tier is really in. */
  const tokenShelf = page.locator('.mnassets-shelf').first();
  /* THREE LINE ITEMS, not three cards, since 2026/09/01 — "we show them like
     line items, so it's a table". Waited for with a RETRYING assertion rather
     than snapshotted: the account's ledger is read after the screen is on, so
     a snapshot taken the instant the tab opens can catch a table that is still
     one row of "Syncing". */
  await expect(tokenShelf.locator('.mnassets-row')).toHaveCount(3);
  const shelfText = (await tokenShelf.locator('.mnassets-row').allInnerTexts()).join(' ');
  expect(shelfText).toMatch(/NIGHT/i);
  expect(shelfText).toContain('0.002');
  expect(shelfText).toContain('100');
  // Neither mUSD row is bare: each carries four characters of its own colour.
  expect(shelfText.match(/MUSD · [0-9A-F]{4}…/gi) ?? []).toHaveLength(2);

  /* THE EMPTY SHELF IS A SHELF. Hiding it would mean a section that appears
     out of nowhere the day something arrives, and a person told their Passport
     can hold items with nowhere to look meanwhile. */
  await expect(
    page.getByText('No NFTs yet. When your Passport holds one, it appears here.'),
  ).toBeVisible();
  await expect(page.locator('.mnassets-card-item')).toHaveCount(0);
});

test('nothing on the shelf is a colour, an address, or a fee token', async () => {
  const text = await page.locator('.mnassets-screen').innerText();

  /* The one thing that must never reach a card. A colour is 64 characters, it
     identifies nothing to a reader, and a list of them is what made the
     balance strip unreadable in the first place (2026/08/26). */
  expect(text).not.toMatch(/\b[0-9a-f]{32,}\b/);
  // Constraint (b): the engine is invisible. None of its vocabulary, and none
  // of its addresses.
  expect(text).not.toContain('mn_addr');
  expect(text).not.toContain('mn_shield-addr');
  expect(text).not.toContain(PASSPORT_ACCOUNT_ADDRESS);
  expect(text).not.toMatch(/\bDUST\b/);
  expect(text).not.toMatch(/wallet|contract|registry|indexer|resolver/i);
});

test('the three tabs really switch, and Assets is not a dead end', async () => {
  await tabs().nth(2).click();
  await expect(page.getByRole('heading', { name: 'Apps', level: 1 })).toBeVisible();
  await expect(page.locator('.mnassets-screen')).toHaveCount(0);

  await tabs().nth(0).click();
  await expect(page.getByRole('button', { name: /^Send$/ }).first()).toBeVisible();

  /* Back to Assets, and the shelf is rendered again rather than left behind by
     whichever tab was drawn first. */
  await tabs().nth(1).click();
  await expect(page.getByRole('heading', { name: 'Tokens', level: 2 })).toBeVisible();
});

test('an item is not left among the balances on Home', async () => {
  /* The other half of the split, seen from Home: the strip carries the same
     three balances the token shelf does and nothing filed as an item. With no
     item in the recorded account the count is the whole assertion — it is what
     would change the day a single-supply colour arrives and the strip failed
     to hand it over. */
  await tabs().nth(0).click();
  const strip = page.locator('.mnhome-assets');
  await expect(strip).toBeVisible();
  await expect(strip.locator('.mnhome-token-row')).toHaveCount(3);

  const shelf = await page.evaluate(
    () => document.querySelectorAll('.mnassets-row, .mnassets-card').length,
  );
  expect(shelf).toBe(0);
});
