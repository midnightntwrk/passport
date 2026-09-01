/**
 * Paging the activity trail, in a real browser.
 *
 * "You should put a pagination on the activity" (2026/09/01). Passport has
 * stored fifty rows per Passport since the trail was written and rendered ten
 * of them, so forty were an answer to "what happened to my money" that nobody
 * could reach.
 *
 * WHAT A BROWSER PROVES THAT A UNIT TEST CANNOT
 * ---------------------------------------------
 * The arithmetic is pure and is drilled where it lives, in
 * `src/lib/activityFeed.test.ts`: which rows a page holds, how the remainder is
 * counted, that the pool is capped at what a reload would give back, and that
 * the control is `null` rather than disabled once the trail is whole. What
 * cannot be asserted there is that pressing the thing on screen actually
 * reveals the next ten IN PLACE, that the day headings survive the fold rather
 * than printing "Today" twice, and that the control really goes.
 *
 * THE TRAIL IS SEEDED, AND SAYS SO
 * --------------------------------
 * A mocked tier cannot produce twenty-six real transfers — its sponsor refuses
 * every registration and it never reaches a prover — so the rows here are
 * written into the same per-credential store `App.tsx` reads on start-up,
 * through the same versioned key. What is exercised is the reading, the
 * grouping, and the disclosure over them; that the rows Passport WRITES are
 * real is `onboarding.spec.ts`'s assertion, against rows that run genuinely
 * produced.
 */

import { expect, test, type Page } from '@playwright/test';

import { installNetworkBoundary, PASSPORT_ACCOUNT_ADDRESS } from './mocks.js';
import { installVirtualAuthenticator } from './passkey.js';

test.describe.configure({ mode: 'serial' });

let page: Page;

/** A label that is free in the recorded registry snapshot. */
const NAME = 'pagingwalk';

/** How many rows are seeded. Two pages and a stub, so every state is met. */
const SEEDED = 26;

/**
 * How many of the seeded rows are stamped TODAY.
 *
 * Fifteen, so the day boundary falls between the first page and the second:
 * page one is all today, page two carries the last of today AND the first of
 * yesterday. That is the arrangement a per-page grouping gets wrong, and it is
 * the reason this number is not simply half of them.
 */
const TODAY_ROWS = 15;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  page = await context.newPage();
  await installNetworkBoundary(page);
  await installVirtualAuthenticator(context, page);

  await page.goto('/');
  await page.getByRole('button', { name: /Continue with Passport/i }).click();
  await expect(page.getByRole('heading', { name: /Welcome to Passport/i })).toBeVisible({
    timeout: 90_000,
  });

  const seeded = await page.evaluate(
    ({ alias, address, rows, today }) => {
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

      /* The trail, newest first, a minute apart. The first `today` of them are
         stamped today and the rest a day earlier, which puts a day boundary
         INSIDE the second page rather than at the fold. */
      const minute = 60_000;
      const day = 24 * 60 * minute;
      const base = Date.now();
      const trail = Array.from({ length: rows }, (_, index) => ({
        id: `seeded-${index}`,
        label: `Seeded row ${index}`,
        detail: 'A row written for this walk.',
        status: 'complete',
        createdAt: new Date(
          base - index * minute - (index >= today ? day : 0),
        ).toISOString(),
        network: 'stagenet',
      }));
      localStorage.setItem(
        `midnight.passport.activity.v1:${credentialId}`,
        JSON.stringify(trail),
      );
      return credentialId;
    },
    { alias: NAME, address: PASSPORT_ACCOUNT_ADDRESS, rows: SEEDED, today: TODAY_ROWS },
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

function trail() {
  return page.locator('.mnhome-activity');
}

function rows() {
  return trail().locator('.mnhome-activity-row');
}

function more() {
  return trail().locator('.mnhome-activity-more');
}

test('the trail opens on ten rows and offers the rest', async () => {
  await expect(trail()).toBeVisible({ timeout: 60_000 });
  /* Retrying, because the stored trail is merged into whatever onboarding
     wrote a moment earlier and the merge lands after the first paint. */
  await expect(rows()).toHaveCount(10);

  /* THE CONTROL SAYS BOTH NUMBERS: what a press reveals, and how many are
     behind it. Sixteen of the seeded twenty-six, plus whatever this run's own
     onboarding wrote, are still hidden. */
  await expect(more()).toBeVisible();
  await expect(more()).toContainText('Show 10 more');
  await expect(more()).toContainText(/\d+ older/);
});

test('a press reveals the next ten in place, and the newest stay put', async () => {
  const first = await rows().first().innerText();
  await more().click();
  await expect(rows()).toHaveCount(20);

  /* IN PLACE. The rows already read are still the rows already read, at the
     top, in the same order — a disclosure that re-sorted under the reader
     would lose their place in the one list that answers "what happened". */
  expect(await rows().first().innerText()).toBe(first);
  await expect(more()).toBeVisible();
});

test('a day that straddles the fold keeps ONE heading', async () => {
  /* Twenty rows are on screen and the day changes at the fifteenth, so today
     runs from the first page into the second. A page that grouped only its own
     ten would print "Today" twice with a fold between the halves of it. */
  const headings = await trail().locator('.mnhome-activity-heading').allInnerTexts();
  expect(headings).toEqual([...new Set(headings)]);
  expect(headings[0]).toBe('Today');
  expect(headings).toContain('Yesterday');
});

test('the control goes once the whole trail is on screen', async () => {
  /* Pressed until there is nothing left. The last press is the assertion: the
     control DISAPPEARS rather than staying behind disabled or reading
     "Show 0 more", which would be furniture claiming there is more to see. */
  for (let press = 0; press < 6 && (await more().count()) > 0; press += 1) {
    await more().click();
    await page.waitForTimeout(150);
  }
  await expect(more()).toHaveCount(0);
  const shown = await rows().count();
  expect(shown).toBeGreaterThanOrEqual(SEEDED);

  /* And a reload puts the trail back where it opened. The depth a reader
     scrolled to is not a preference — it is an answer to a question they have
     now had. */
  await page.reload();
  await expect(page.getByRole('button', { name: /^Send$/ }).first()).toBeVisible({
    timeout: 90_000,
  });
  await expect(rows()).toHaveCount(10);
  await expect(more()).toBeVisible();
});
