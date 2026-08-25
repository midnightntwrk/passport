/**
 * Tier 1 — the account model, asserted in a real browser with no chain.
 *
 * WHAT THIS TIER IS FOR
 * ---------------------
 * The unit tests hold each module to its own contract. This holds the SHIPPED
 * BUNDLE to the standard the whole demo exists to demonstrate, which is a
 * statement about what a user can see and do rather than about any one module:
 *
 *   - the passkey wallet originates exactly ONE transaction, the
 *     account-custody contract deploy, and every other value flow is an ACC
 *     circuit;
 *   - the `.night` name resolves to the ACC, and the ACC is what Home offers as
 *     "your account";
 *   - DUST and wallet addresses never appear to the user;
 *   - a claim with no sponsor QUEUES and never spends from the wallet;
 *   - and the name step is not something a user can walk past — a Home with no
 *     account is not a state onboarding may end in.
 *
 * WHAT IT CANNOT DO, STATED RATHER THAN GLOSSED
 * ---------------------------------------------
 * It cannot run a real claim. Claiming deploys the account contract, and that
 * is a proved transaction: ~32 MB of circuit keys, a prover, and a chain to
 * submit to. There is no honest way to fake it — a mocked "claim succeeded"
 * would assert that the mock returned, and the two things worth knowing (that
 * the name resolves to the contract, and that the contract holds the balances)
 * would both be assumed. So the ceremony and everything downstream of it are
 * `stagenet.live.spec.ts`'s job, against the deployed site and a real stagenet.
 *
 * What this tier does instead, where a real claim would be needed:
 *
 *   - the NO-SPONSOR state is driven for real, because a stood-down sponsor is
 *     something the service genuinely answers over HTTP. That is the branch
 *     where the account model is easiest to break — a client that fell back to
 *     the wallet would spend the user's NIGHT — and the screen is held to
 *     promising a queue and never a payment.
 *   - AVAILABILITY is decoded for real. `fixtures/stagenet-night-registry.json`
 *     is the stagenet `.night` TLD's own contract state, recorded from the
 *     indexer, so `domains.member(paddedKey)` runs through the real Midnames
 *     contract module over real ledger bytes. Nothing about the registry is
 *     invented.
 *   - the HOME screen is rendered from the records a completed claim writes,
 *     seeded into this browser's own stores. That is not a shortcut around the
 *     ceremony: it is the returning-Passport path, which is how a user reaches
 *     Home on every visit after the first, and it renders through exactly the
 *     same components with exactly the same props.
 *
 * The whole file drives ONE Passport through its life in order, so it is
 * serial and shares a page: a fresh context per test would mean a fresh passkey
 * and a fresh wallet bring-up each time, which is both slower and a worse model
 * of what a user does.
 */

import { expect, test, type Page } from '@playwright/test';

import { installNetworkBoundary, type RequestLog } from './mocks.js';
import { installVirtualAuthenticator } from './passkey.js';

test.describe.configure({ mode: 'serial' });

let page: Page;
let network: RequestLog;

/** A label that is free in the recorded registry snapshot. */
const NAME = 'passportwalk';

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  page = await context.newPage();
  network = await installNetworkBoundary(page);
  await installVirtualAuthenticator(context, page);
});

test.afterAll(async () => {
  await page.context().close();
});

/** Everything the user can read on the screen right now. */
async function visibleText(): Promise<string> {
  return page.locator('body').innerText();
}

test('the landing screen offers one way in, and says what network this is', async () => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: /Midnight\s*Passport/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Continue with Passport/i })).toBeVisible();
  await expect(page.getByText(/Test network demo — not production/)).toBeVisible();

  /* One primary action. There is no hosted route to offer and no vendor
     sign-in to wait on, so a second primary button would be a promise this
     demo cannot keep. */
  const primaries = await page.getByRole('button', { name: /Continue|Create|Sign in/i }).count();
  expect(primaries).toBe(1);

  // Nothing about a wallet, a seed phrase, or a fee before anything has happened.
  const text = await visibleText();
  expect(text).not.toMatch(/seed phrase|recovery phrase|DUST/i);
});

test('a passkey lands on the name step — the last step, with no way past it', async () => {
  await page.getByRole('button', { name: /Continue with Passport/i }).click();

  // The ceremony, then the wallet opening. Both are the real code paths.
  await expect(page.getByText(/Choose your .night name/i)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/^LAST STEP$/i)).toBeVisible();

  /* NO SKIP. The name step IS the account ceremony — the custody contract
     deploys and the name binds to it inside one action — and Home without an
     account is not a state onboarding may end in (ruled 2026/08/24 after
     exactly that was seen live). Asserted as an absence of any control that
     would leave, not merely of the word "Skip". */
  await expect(page.getByRole('button', { name: /skip|later|not now|maybe/i })).toHaveCount(0);
  const buttons = await page.getByRole('button').allInnerTexts();
  expect(buttons.filter((label) => label.trim().length > 0)).toEqual(['Claim your name']);

  // And the wallet has not been asked for a transaction: only reads so far.
  expect(network.calls.filter((call) => call.includes('register-alias'))).toHaveLength(0);
});

test('the availability line quotes no price, no balance, and no faucet', async () => {
  await page.getByLabel('Your Midnight name').fill(NAME);

  /* Decoded from the stagenet registry's own recorded state by the real
     Midnames contract module — `member(paddedKey)` on real ledger bytes. */
  await expect(page.getByText(`${NAME}.night is available`)).toBeVisible({ timeout: 20_000 });

  const text = await visibleText();
  /* The registry HAS a price — 600 / 140 / 10 atomic NIGHT by label length —
     and the user never sees it, because the service pays it. A price on this
     screen would imply a wallet that has to cover it. */
  expect(text).not.toMatch(/\bNIGHT\b/);
  expect(text).not.toMatch(/balance|you have|insufficient|top up|faucet|fund your wallet/i);
  expect(text).not.toMatch(/\bfee\b/i);
  // What it says instead: who pays, and that the user holds nothing.
  await expect(page.getByText(/the service pays for it, and you hold nothing/i)).toBeVisible();
  await expect(page.getByText(/you hold nothing and spend nothing/i)).toBeVisible();

  // No wallet address is offered to fund, because nothing is ever sent to one.
  expect(text).not.toContain('mn_addr');
  expect(text).not.toMatch(/\bDUST\b/);
});

test('with no sponsor, the screen promises a queue and never a payment', async () => {
  /* The sponsor is the only thing that registers a name. When it stands down,
     the honest answer is a QUEUE — and the sentence under the field changes to
     say so. What must not change is who pays: there is no self-paid claim
     behind this screen and has not been since 2026/08/25, so nothing here may
     offer the wallet as an alternative. */
  await page.route('**/funder.midnightpassport.com/**/status', (route) =>
    route.fulfill({ json: { network: 'stagenet', aliasSponsorship: 'paused' } }),
  );
  await page.reload();
  await expect(page.getByText(/Choose your .night name/i)).toBeVisible({ timeout: 60_000 });
  await page.getByLabel('Your Midnight name').fill(NAME);
  await expect(page.getByText(`${NAME}.night is available`)).toBeVisible({ timeout: 20_000 });

  // The "we will register this for you" promise is withdrawn…
  await expect(page.getByText(/Press claim and Passport registers/i)).toHaveCount(0);
  // …and replaced by the one that is still true.
  await expect(
    page.getByText(/the name is kept for you and registered when the service is back/i),
  ).toBeVisible();
  await expect(
    page.getByText(/nothing is ever spent from your Passport for it/i),
  ).toBeVisible();

  const text = await visibleText();
  // No price, no balance, no faucet, and no wallet to top up — in this state
  // above all, because this is the state where a lesser demo would ask.
  expect(text).not.toMatch(/\bNIGHT\b/);
  expect(text).not.toMatch(/balance|insufficient|top up|faucet|pay for it yourself/i);
  expect(text).not.toContain('mn_addr');
  expect(text).not.toMatch(/\bDUST\b/);

  // The action is still the claim, and it still names the domain it will claim.
  await expect(page.getByRole('button', { name: new RegExp(`Claim ${NAME}\\.night`) })).toBeEnabled();
  // And nothing has been asked of the sponsor's registration endpoint yet.
  expect(network.calls.filter((call) => call.includes('register-alias'))).toHaveLength(0);

  /* Put the sponsoring answer back, so the rest of the walk runs against the
     service as it really behaves. */
  await page.route('**/funder.midnightpassport.com/**/status', (route) =>
    route.fulfill({
      json: { network: 'stagenet', aliasSponsorship: 'available', assetSymbol: 'mUSD' },
    }),
  );
});

test('a reload mid-onboarding returns to the name step, never to Home', async () => {
  await page.reload();

  /* The session is restored from this device, and the step is re-armed. A
     Passport that reloaded here used to land on Home with no name and no
     account — seen live 2026/08/24 — and a stored skip now means "ask again". */
  await expect(page.getByText(/Choose your .night name/i)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: /^Send$/ })).toHaveCount(0);
});

test('Home names the account contract, and never the wallet', async () => {
  /* The records a completed claim writes, seeded into this browser's own
     stores through the same keys those stores use. This is the
     returning-Passport path: the ceremony itself is proved on stagenet by
     `stagenet.live.spec.ts`, and what is proved HERE is what Home does with
     its result. */
  const account = '7c2f4a19e6d0b83c5194fe2a77bb0c61d8a3e94f20cb5d7e8f16a0b3c4d5e6f7';
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
    { alias: NAME, address: account },
  );
  expect(seeded).not.toBeNull();

  await page.reload();

  /* The identity card: the name, its registry status, and — the whole point of
     the account model — the sentence that says what the name RESOLVES to. */
  await expect(page.getByText(`${NAME}.night`).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Registered on Stagenet/i)).toBeVisible();
  await expect(
    page.getByText(/Resolves to your Passport account contract \(7c2f4a19e6…d5e6f7\)\./),
  ).toBeVisible();
  // And the contract card beside it, active on the network the name is on.
  await expect(page.getByText(/Active on Stagenet/i)).toBeVisible();

  /* The receiving surface. ONE address, and it is the account contract the
     name resolves to — under the account model nothing is ever sent to the
     wallet, so nothing here invites it. The shielded and DUST rows that used
     to sit beside this went with the account ruling on 2026/08/24. */
  await page.getByRole('button', { name: /^Receive$/ }).click();
  const accountRow = page.locator('.mnhome-address');
  await expect(accountRow).toHaveCount(1);
  await expect(accountRow).toContainText('Your account');
  await expect(accountRow.locator('code')).toContainText('7c2f4a19');

  const text = await visibleText();
  expect(text).not.toContain('mn_addr');
  expect(text).not.toContain('mn_shield-addr');
  expect(text).not.toMatch(/\bDUST\b/);
  expect(text).not.toMatch(/wallet address|your wallet/i);
  // A public receiving address — never the keys behind it.
  await expect(page.getByText(/never the keys behind it/i)).toBeVisible();
  await page.keyboard.press('Escape');
});

test('the Send sheet is a withdrawal from the account, and never mentions DUST', async () => {
  const send = page.getByRole('button', { name: /^Send$/ }).first();
  await expect(send).toBeVisible({ timeout: 30_000 });
  await send.click();

  /* Every sentence the sheet can show. `feeNote` is the one that used to name
     the fee's own token; since 2026/08/24 the fee's token and the sponsor's
     internal reason are the wallet's business and do not appear here. */
  const sheet = await visibleText();
  expect(sheet).not.toMatch(/dust/i);
  // What it DOES say about the fee: who is expected to pay it, and nothing
  // about which token that costs them.
  await expect(page.getByText(/Network fee expected to be covered by the fee sponsor/i)).toBeVisible();

  /* `mn_addr…` appears once, as the shape of the RECIPIENT's address — that is
     someone else's, and naming its format is how a paste is validated. What
     must not appear is a real address belonging to this Passport: the sheet
     spends from the account contract, and this Passport's own wallet address
     is not something any surface offers. */
  await expect(page.getByText(/An unshielded \(mn_addr…\) or shielded/)).toBeVisible();
  expect(sheet).not.toMatch(/mn_addr_stagenet1[a-z0-9]{10,}/);
  expect(sheet).not.toMatch(/mn_shield-addr_stagenet1[a-z0-9]{10,}/);
});
