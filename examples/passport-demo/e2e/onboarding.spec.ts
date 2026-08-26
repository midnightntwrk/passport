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

import crypto from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { installNetworkBoundary, type NetworkBoundary } from './mocks.js';
import { installVirtualAuthenticator } from './passkey.js';

test.describe.configure({ mode: 'serial' });

let page: Page;
let network: NetworkBoundary;

/** A label that is free in the recorded registry snapshot. */
const NAME = 'passportwalk';

/** A real stagenet unshielded address, so the recipient field genuinely passes. */
const RECIPIENT =
  'mn_addr_stagenet127xnp9uuxwhh7a8an77mxv02ypt6u09xkk63c9zvdkjsrj4mj68qg7c5ad';

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
  test.setTimeout(200_000);
  /* A sponsor that takes its time, and stands down. Both halves matter: the
     delay is what makes the second stage long enough to read, and the refusal
     is what proves the gate still stops the claim before any ceremony. */
  await page.route('**/funder.midnightpassport.com/**/status', async (route) => {
    /* Slower than the registry below, deliberately. The two probes now run
       CONCURRENTLY — removing that serialisation is half of the fix — so the
       second stage is only long enough to observe when the sponsor is the
       slower of the two. Comfortably inside `sponsoredAlias.ts`'s own 4 s
       ceiling, so what is being watched is a slow answer and not a timeout. */
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    return route.fulfill({ json: { network: 'stagenet', aliasSponsorship: 'paused' } });
  });
  await page.reload();
  await expect(page.getByText(/Choose your .night name/i)).toBeVisible({ timeout: 60_000 });
  await page.getByLabel('Your Midnight name').fill(NAME);
  await expect(page.getByText(`${NAME}.night is available`)).toBeVisible({ timeout: 30_000 });

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

test('a slow registry is narrated in stages, and never as an unexplained spinner', async () => {
  /* THE DEFECT THIS IS ABOUT.
     A reviewer clicked claim on the live site and reported the passkey prompt
     arriving long afterwards with nothing on screen but a spinner. Measured on
     2026/08/26 the gap was 2.19 s under a throttled link (0.56 s on a fast
     one) — not the minutes it felt like, and the reason it felt like minutes
     was that the button said "Deploying your name's resolver…" throughout: one
     unchanging sentence, about a step that had not started, over a wait the
     user could not distinguish from a hang.

     Two things are held to here. The stages are NARRATED — each says what is
     actually happening — and the REFUSAL still lands before the ceremony, which
     is the constraint the whole ordering exists for. A slow registry is the
     honest way to make the wait long enough to read: `setRegistryDelay` holds
     the indexer's answer back exactly as a poor link does. */
  test.setTimeout(200_000);
  /* A sponsor that takes its time, and stands down. Both halves matter: the
     delay is what makes the second stage long enough to read, and the refusal
     is what proves the gate still stops the claim before any ceremony. */
  await page.route('**/funder.midnightpassport.com/**/status', async (route) => {
    /* Slower than the registry below, deliberately. The two probes now run
       CONCURRENTLY — removing that serialisation is half of the fix — so the
       second stage is only long enough to observe when the sponsor is the
       slower of the two. Comfortably inside `sponsoredAlias.ts`'s own 4 s
       ceiling, so what is being watched is a slow answer and not a timeout. */
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    return route.fulfill({ json: { network: 'stagenet', aliasSponsorship: 'paused' } });
  });
  await page.reload();
  await expect(page.getByText(/Choose your .night name/i)).toBeVisible({ timeout: 60_000 });
  await page.getByLabel('Your Midnight name').fill(NAME);
  await expect(page.getByText(`${NAME}.night is available`)).toBeVisible({ timeout: 30_000 });

  /* Nothing may reach the authenticator on this walk. Counting the calls is
     the only assertion that proves it: a claim refused for want of a sponsor
     must cost the user no ceremony at all, and "the button showed an error" is
     not the same fact. */
  await page.evaluate(() => {
    const original = navigator.credentials.get.bind(navigator.credentials);
    (window as unknown as { __prompts: number }).__prompts = 0;
    navigator.credentials.get = (...args: Parameters<typeof original>) => {
      (window as unknown as { __prompts: number }).__prompts += 1;
      return original(...args);
    };
  });

  /* EVERY label the button shows, recorded rather than raced.
     A `toBeVisible` on each stage in turn can only ever assert that a stage
     was on screen at the moment Playwright happened to look, which makes the
     test's own scheduling part of what it measures — and the stages are short
     precisely because the fix made them short. A MutationObserver installed
     before the click sees all of them, in order, however briefly each lasts. */
  await page.evaluate(() => {
    const claim = document.querySelector('.mnid-primary');
    if (!claim) throw new Error('The claim button was not on screen.');
    const seen: string[] = [(claim.textContent ?? '').trim()];
    (window as unknown as { __labels: string[] }).__labels = seen;
    new MutationObserver(() => {
      const text = (claim.textContent ?? '').trim();
      if (text && text !== seen[seen.length - 1]) seen.push(text);
    }).observe(claim, { childList: true, subtree: true, characterData: true });
  });

  /* Every warmed answer is deliberately allowed to age out, so the claim
     re-probes BOTH for itself — which is the path this test is about, and the
     one the ten-second TTL in `identity/claimWarmup.ts` guarantees. The wait
     also has to clear `sponsoredAlias.ts`'s own 30 s probe cache, without which
     the sponsor's answer comes from memory and there is no second stage to
     watch — hence forty seconds rather than eleven. It is measured from the
     mount-time probe, which settled a second or two before the name was typed,
     so the margin is comfortable either way. */
  network.setRegistryDelay(2_000);
  await page.waitForTimeout(40_000);

  await page.getByRole('button', { name: new RegExp(`Claim ${NAME}\\.night`) }).click();

  /* STAGE ONE, on screen while the registry takes its two seconds — and beside
     it the sentence a spinner cannot carry: what is happening, and that this
     part is short. The reviewer asked for exactly this ("you have to let the
     user know this will take time"). */
  await expect(
    page.getByRole('button', { name: new RegExp(`Checking ${NAME}\\.night is still free`) }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByText(/checking the name is still free and that the service can register it/i),
  ).toBeVisible();

  /* Then the refusal, with the sponsor's own sentence — before any ceremony,
     exactly as it was before the warming existed. */
  await expect(page.getByText(/The claim did not complete/i)).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByText(/The Passport service that registers names is not available right now/i),
  ).toBeVisible();

  /* THE STAGES, in the order they happened. Two distinct sentences before the
     refusal, each naming its own step: this is the whole of the defect, which
     was ONE unchanging label — "Deploying your name's resolver…" — held over
     the entire wait. Nothing here is ever an unexplained spinner. */
  const labels = await page.evaluate(
    () => (window as unknown as { __labels: string[] }).__labels,
  );
  expect(labels.some((label) => new RegExp(`Checking ${NAME}\\.night is still free`).test(label))).toBe(
    true,
  );
  expect(labels.some((label) => /Preparing your Passport/.test(label))).toBe(true);
  // And not one of them claims a step that had not started.
  expect(labels.some((label) => /Deploying your name's resolver/.test(label))).toBe(false);

  // NOT ONE passkey prompt for a claim that was always going to be refused.
  expect(await page.evaluate(() => (window as unknown as { __prompts: number }).__prompts)).toBe(0);
  // And nothing was asked of the registration endpoint either.
  expect(network.calls.filter((call) => call.includes('register-alias'))).toHaveLength(0);

  network.setRegistryDelay(0);
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

test('a busy fee sponsor disables the Send control rather than removing it', async () => {
  /* THE DEAD MODAL, and the fix for it.
     `available: 0` is not an error — it is the state the deployed sponsor is in
     for a minute or two after every activation grant, because it reserves its
     DUST against the transaction it is balancing. The sheet used to answer that
     by REMOVING its primary control, leaving a modal with a grey paragraph, an
     X, and no action of any kind, in a state that clears itself. Three things
     are held to here: the control stays, it says what it is waiting for, and
     the sheet finds out on its own when the wait is over. */

  // The sheet is still open from the test above; give it something to send.
  await page.getByPlaceholder(/^mn_addr_stagenet1/).fill(RECIPIENT);
  // The amount field: its label carries the "Max" button too, so the
  // placeholder is what names it unambiguously.
  await page.getByPlaceholder('0.0').fill('0.1');

  /* The control, in the state a working sponsor leaves it: present, and asking
     to move on. It is disabled here for a reason that is not the sponsor — this
     tier has no indexer answer for the account's balance, so there is no ceiling
     to check an amount against and the sheet says so — and what this test is
     about is the LABEL, which is the sheet's account of what it is waiting for.
     A genuinely enabled Send is `stagenet.live.spec.ts`'s, against a real
     account with a real balance. */
  const primary = page.locator('.mnhome-send-primary');
  await expect(primary).toHaveCount(1);
  await expect(primary).toHaveText(/Review/);

  // The sponsor's DUST goes out of circulation, mid-sheet.
  network.setSponsorAvailable(0);

  /* Noticed by the sheet's own watcher — nothing was closed, reopened, or
     retyped. The control is still there, and it says what it waits for. */
  await expect(primary).toHaveText(/Waiting for the fee sponsor/, { timeout: 20_000 });
  await expect(primary).toBeDisabled();
  await expect(
    page.getByText('The fee sponsor is busy — this usually clears within a minute.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Check again/ })).toBeVisible();

  /* And NOT ONE FIGURE of the sponsor's own diagnostic reached the screen. It
     names a wallet index and a DUST balance belonging to a wallet the user does
     not own, about a token they are never asked to hold; it belongs in
     `console.info`, which is where it now goes. */
  const text = await visibleText();
  expect(text).not.toContain('4993664979775282371');
  expect(text).not.toMatch(/wallets available/i);
  expect(text).not.toMatch(/\bdust\b/i);
  expect(text).not.toMatch(/#\d/);

  // The sponsor's DUST comes back, as it does.
  network.setSponsorAvailable(1);

  /* The sheet lifts the block itself, in place: the same sheet, the same
     recipient, the same amount, and no user action in between. The control is
     back to asking to move on, which is the state where nothing about the fee
     stands in the user's way. */
  await expect(primary).toHaveText(/Review/, { timeout: 20_000 });
  await expect(page.getByText(/The fee sponsor is busy/)).toHaveCount(0);
  await expect(
    page.getByText(/Network fee expected to be covered by the fee sponsor/i),
  ).toBeVisible();
});

test('a passkey that answers without PRF offers a way out, and the way out works', async ({
  browser,
}) => {
  /* THE FALSE REMEDY, AND THE REAL ONE.
     `discoverOrEnroll` reports `unusable-credential` when a resident credential
     for this origin ANSWERS and returns no PRF output: it cannot open a
     Passport, and creating under the same deterministic user handle might
     replace it, so Passport stops. Until 2026/08/26 it stopped with a message
     telling the user to choose "Use a different passkey" — which runs one
     discoverable assertion and can NEVER enrol. The same PRF-less credential
     answered the picker again, and again, with no escape but dismissing the OS
     dialog until the `cancelled` path happened to fall through to enrolment.

     Adversarial verification found that message rendering correctly and nobody
     having ever followed its advice. So this test does not stop at the words:
     it presses the control and requires a working Passport at the end of it.

     THE FIXTURE, and why it is a fair model. `WebAuthn.addCredential` plants a
     resident credential the virtual authenticator did not create, and such a
     credential answers with `{ prf: {} }` — no `results.first` — on an
     authenticator that is itself PRF-capable. That is exactly the real case
     this state exists for: an older credential enrolled without the extension,
     on a device that supports it. Enrolling a NEW credential on the same
     authenticator then yields PRF, which is what makes the recovery reachable
     rather than merely offered.

     Its own context: this walk needs a browser whose only credential for the
     origin is the planted one, and the shared page above has a real Passport. */
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const fresh = await context.newPage();
  await installNetworkBoundary(fresh);

  const client = await context.newCDPSession(fresh);
  await client.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      /* PRF-capable, deliberately: the authenticator is not the problem, the
         credential planted on it is. A `hasPrf: false` authenticator would
         model a device that can never onboard at all, which is a different
         (and genuinely unrecoverable) state. */
      hasPrf: true,
      hasLargeBlob: true,
      automaticPresenceSimulation: true,
    },
  });

  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  await client.send('WebAuthn.addCredential', {
    authenticatorId,
    credential: {
      credentialId: crypto.randomBytes(32).toString('base64'),
      isResidentCredential: true,
      rpId: 'localhost',
      privateKey: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' })).toString('base64'),
      userHandle: Buffer.from('legacy-passkey').toString('base64'),
      signCount: 0,
    },
  });

  try {
    await fresh.goto('/');
    await fresh.getByRole('button', { name: /Continue with Passport/i }).click();

    /* The state, said plainly — and NOT pointing at a control that cannot
       help. The old sentence named "Use a different passkey"; that advice is
       gone, because that flow only ever asserts. */
    await expect(
      fresh.getByText(/does not support the extension Passport needs/i).first(),
    ).toBeVisible({ timeout: 60_000 });
    const explained = await fresh.locator('body').innerText();
    expect(explained).not.toMatch(/Choose "Use a different passkey" to create one/i);
    /* The thrown explanation, which only the `unusable-credential` branch
       produces — so this pins the test to that state rather than to any screen
       that happens to mention the extension. It now names the control that is
       actually beside it. */
    await expect(
      fresh.getByText(/Choose "Create a new passkey" to make one that can/i),
    ).toBeVisible();

    /* THE WAY OUT — a real control, and it says what it does. */
    const createNew = fresh.getByRole('button', { name: /Create a new passkey/i });
    await expect(createNew).toBeVisible();
    await expect(
      fresh.getByText(/Any passkey this browser already holds a Passport for is left untouched/i),
    ).toBeVisible();

    await createNew.click();

    /* And it lands on a WORKING Passport: the name step, which is only reached
       once a passkey was enrolled, its PRF derived the wallet seed, and the
       wallet actually opened. Nothing short of that proves the escape. */
    await expect(fresh.getByText(/Choose your .night name/i)).toBeVisible({ timeout: 90_000 });
    await expect(fresh.getByText(/^LAST STEP$/i)).toBeVisible();
    // The dead end is gone rather than merely covered up.
    await expect(
      fresh.getByText(/does not support the extension Passport needs/i),
    ).toHaveCount(0);
  } finally {
    await context.close();
  }
});
