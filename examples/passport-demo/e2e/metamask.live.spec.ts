/**
 * Tier 2 — MetaMask as a second device, against a real stagenet.
 *
 * WHAT THIS PROVES THAT NOTHING ELSE CAN
 * --------------------------------------
 * `src/lib/metamaskDevice.test.ts` proves the derivation is deterministic and
 * separated. It cannot prove the only claim that matters to a reader:
 *
 *   a MetaMask account, added to a Passport account as a device, can then OPEN
 *   that account and SPEND from it, with the passkey nowhere in the room.
 *
 * The witness to that is the chain. So this walk creates a real Passport,
 * claims a real name, pairs a real (deterministically signed) MetaMask account
 * through a real `add_device`, signs OUT, signs back in with MetaMask alone,
 * and sends real stagenet NIGHT to a real `.night` name. Four transactions, and
 * the last of them is authorised by a device the passkey never touched.
 *
 * WHY IT IS SKIPPED BY DEFAULT
 * ----------------------------
 * Every run claims a name and spends NIGHT on stagenet, so it runs deliberately
 * (`RUN_LIVE=1`) and against a build made with `VITE_METAMASK_DEVICE=1` — which
 * production is not, and must not be. Point it at one with
 * `METAMASK_LIVE_URL`; there is no default, because a walk that silently ran
 * against the deployed site would find the flag off and fail for the wrong
 * reason.
 *
 *   RUN_LIVE=1 METAMASK_LIVE_URL=https://…vercel.app \
 *     npx playwright test --project=chromium e2e/metamask.live.spec.ts
 *
 * TIMING. Four proved transactions and three indexer waits. The timeouts below
 * are generous on purpose: a short one here does not find a bug, it finds a
 * prover.
 */

import { expect, test, type Page } from '@playwright/test';

import { installVirtualAuthenticator, uniqueAlias } from './passkey.js';
import {
  METAMASK_TEST_ADDRESS,
  METAMASK_TEST_SHORT,
  installMetamaskStub,
  personalSign,
} from './support/metamaskStub.js';

const live = process.env.RUN_LIVE === '1';
const baseUrl = process.env.METAMASK_LIVE_URL ?? '';

test.describe('@live MetaMask as a device on stagenet', () => {
  test.skip(
    !live || baseUrl === '',
    'Set RUN_LIVE=1 and METAMASK_LIVE_URL=<a build made with VITE_METAMASK_DEVICE=1>.',
  );
  test.describe.configure({ mode: 'serial' });

  /**
   * A `.night` name that already exists on stagenet and points at a Passport
   * account (recorded in `e2e/mocks.ts` on 2026/08/25 and used by the mocked
   * tier for the same reason). The send has to go to a NAME rather than an
   * address, because the two-leg name path is what makes the MetaMask device's
   * OWN wallet load-bearing: leg one lands on the signing device's address, and
   * a device that could not see it could not finish the payment.
   */
  const RECIPIENT_NAME = 'iamtester.night';
  /** Small, and small on purpose: the point is that it moves, not how much. */
  const SEND_NIGHT = '0.0005';

  let page: Page;
  const alias = uniqueAlias('mm');
  /** Filled as the walk goes, and printed at the end as the run's evidence. */
  const hashes: string[] = [];

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
    page = await context.newPage();
    await installVirtualAuthenticator(context, page);
    await installMetamaskStub(page);
    page.on('console', (message) => {
      if (message.type() === 'error') console.log(`[page] ${message.text().slice(0, 200)}`);
    });
  });

  test.afterAll(async () => {
    console.log(`[metamask walk] name: ${alias}.night`);
    console.log(`[metamask walk] device: ${METAMASK_TEST_ADDRESS}`);
    for (const hash of hashes) console.log(`[metamask walk] tx: ${hash}`);
    await page.context().close();
  });

  /**
   * Every explorer link the activity trail is currently showing.
   *
   * Read off the DOM rather than intercepted off the wire, because a hash the
   * USER can see is the only kind this walk is entitled to report.
   */
  async function activityHashes(): Promise<string[]> {
    return page.locator('.mnhome-activity-view').evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLAnchorElement).href),
    );
  }

  async function recordNewHashes(): Promise<string[]> {
    const seen = new Set(hashes);
    const fresh = (await activityHashes()).filter((href) => !seen.has(href));
    hashes.push(...fresh);
    return fresh;
  }

  test('the stub signs exactly what the unit vector asserts', () => {
    /* The one assertion that joins this file to `metamaskDevice.test.ts`: if
       these ever disagree, the browser is proving a different derivation from
       the one the unit suite is green on, and both are worthless. */
    const message = [
      'Midnight Passport device key v1',
      'network: stagenet',
      'account: 0200aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899',
    ].join('\n');
    expect(METAMASK_TEST_ADDRESS).toBe('0xae3dffee97f92db0201d11cb8877c89738353bce');
    expect(personalSign(message)).toBe(
      '0x3100457c20459a04732503ea36a252ba5bc96a00d64554c6e1e97de5f2e9674b7c907e64a1cdaa578bdb4cf2af59cca780746eb04c910cefd59dde6bf5ff3ec61b',
    );
  });

  test('a passkey creates a Passport and claims a name', async () => {
    await page.goto(baseUrl);
    await page.getByRole('button', { name: /Continue with Passport/i }).click();
    await expect(page.getByRole('heading', { name: /Welcome to Passport/i })).toBeVisible({
      timeout: 120_000,
    });
    await page.getByRole('button', { name: 'Choose my name' }).click();
    await expect(page.getByText(/Choose your .night name/i)).toBeVisible({ timeout: 120_000 });

    await page.getByLabel('Your Midnight name').fill(alias);
    await expect(page.getByText(`${alias}.night is available`)).toBeVisible({ timeout: 120_000 });
    await page.getByRole('button', { name: new RegExp(`Claim ${alias}\\.night`) }).click();

    /* Landing on Home is the account being deployed, the resolver deployed, and
       the name registered — three proved transactions. */
    await expect(page.getByRole('button', { name: /^Send$/ })).toBeVisible({ timeout: 900_000 });
    await recordNewHashes();
  });

  test('the Devices card adds MetaMask to the account', async () => {
    const connect = page.getByRole('button', { name: 'Connect MetaMask' });
    await expect(connect).toBeVisible({ timeout: 60_000 });
    await connect.click();

    /* MetaMask signs (the stub, deterministically), then the passkey authorises
       `add_device` (the virtual authenticator, automatically). The row is the
       transaction having been accepted. */
    await expect(page.getByText(`MetaMask ${METAMASK_TEST_SHORT}`)).toBeVisible({
      timeout: 600_000,
    });
    await expect(page.getByText('Device added')).toBeVisible({ timeout: 600_000 });

    const fresh = await recordNewHashes();
    expect(fresh.length).toBeGreaterThan(0);
  });

  test('signing out and back in with MetaMask alone opens the same account', async () => {
    await page.getByRole('button', { name: /Sign out/i }).click();
    await expect(page.getByRole('button', { name: /Continue with Passport/i })).toBeVisible({
      timeout: 60_000,
    });

    await page.getByRole('button', { name: /Sign in with MetaMask/i }).click();
    await page.getByRole('button', { name: /Open with MetaMask/i }).click();

    /* Home again — with no passkey ceremony anywhere in this test. The name is
       the account's, so seeing it is the account having been opened rather than
       a new one having been made. */
    await expect(page.getByRole('button', { name: /^Send$/ })).toBeVisible({ timeout: 600_000 });
    await expect(page.getByText(`${alias}.night`).first()).toBeVisible({ timeout: 120_000 });
  });

  test('the MetaMask device sends NIGHT to a name', async () => {
    await page.getByRole('button', { name: /^Send$/ }).click();
    await page.getByLabel(/Send to/i).fill(RECIPIENT_NAME);
    await expect(page.getByText(RECIPIENT_NAME).first()).toBeVisible({ timeout: 120_000 });
    await page.getByLabel(/Amount/i).fill(SEND_NIGHT);

    await page.getByRole('button', { name: /^Send$/ }).last().click();

    /* Two legs, both authorised by a `personal_sign` and nothing else. */
    await expect(page.getByText(/Sent NIGHT|arrived|complete/i).first()).toBeVisible({
      timeout: 900_000,
    });
    const fresh = await recordNewHashes();
    expect(fresh.length).toBeGreaterThan(0);
  });
});
