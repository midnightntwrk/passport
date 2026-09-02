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

import {
  installNetworkBoundary,
  PASSPORT_ACCOUNT_ADDRESS,
  RESOLVABLE_NAME,
  sponsorRoute,
  type NetworkBoundary,
} from './mocks.js';
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

test('a passkey is welcomed, and the welcome leads to the name step', async () => {
  /* THE FIRST IMPRESSION, and what it replaced.
     A passkey ceremony used to end by dropping the user straight onto "Choose
     your .night name" — a screen that assumes the reader already knows what a
     Passport is and who is paying. Two reviewers asked for the missing half on
     2026/08/26 ("an intro page… what is this, what am I getting"). One screen,
     four promises the build actually keeps, one primary action. */
  await page.getByRole('button', { name: /Continue with Passport/i }).click();

  // The ceremony, then the wallet opening. Both are the real code paths.
  await expect(page.getByRole('heading', { name: /Welcome to Passport/i })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText('An identity you hold')).toBeVisible();
  await expect(page.getByText('A name, not an address')).toBeVisible();
  await expect(page.getByText('Fees are covered for you')).toBeVisible();
  await expect(page.getByText('Prove things privately')).toBeVisible();

  /* ONE control and no more, and it says where it goes.
     A "Skip" sat under it until 2026/08/30 and led to the same place — the
     name step, which nothing on it can walk past. A control labelled for an
     escape the app does not offer costs a tap and teaches the reader that this
     app's words are approximate, so it is asserted GONE, and as an absence of
     anything that would read as a way out rather than of one word. */
  const welcomeButtons = await page.getByRole('button').allInnerTexts();
  expect(welcomeButtons.filter((label) => label.trim().length > 0)).toEqual(['Choose my name']);
  await expect(page.getByRole('button', { name: /skip|later|not now|maybe/i })).toHaveCount(0);

  /* And nothing on it claims anything the build does not do — no wallet, no
     token, no fee the reader has to find. */
  const welcomeText = await visibleText();
  expect(welcomeText).not.toMatch(/\bwallet\b/i);
  expect(welcomeText).not.toMatch(/\bDUST\b/);
  expect(welcomeText).not.toMatch(/\bNIGHT\b/);

  await page.getByRole('button', { name: 'Choose my name' }).click();

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

test('the welcome is read once — not on a reload, and never on a session it did not create', async () => {
  /* Being welcomed to something you already hold reads as an app that has
     forgotten you, so the introduction is shown to a Passport this session
     CREATED and to no other — and once. */
  await page.reload();
  await expect(page.getByText(/Choose your .night name/i)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('heading', { name: /Welcome to Passport/i })).toHaveCount(0);

  /* And the gate is the creation, not merely the stored dismissal. With the
     dismissal deleted, a restored session STILL goes straight to the name
     step: a sign-in on a second device is not a first impression, and a flag
     that had gone missing would otherwise re-introduce Passport to somebody
     who has been using it for a week. */
  const cleared = await page.evaluate(() => {
    const keys = Object.keys(localStorage).filter((key) =>
      key.startsWith('mn-passport:welcome:'),
    );
    keys.forEach((key) => localStorage.removeItem(key));
    return keys.length;
  });
  expect(cleared).toBe(1);

  await page.reload();
  await expect(page.getByText(/Choose your .night name/i)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('heading', { name: /Welcome to Passport/i })).toHaveCount(0);
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

test('every sponsor call this build makes is answered here, and none leaves the box', async () => {
  /* THE ONE THING A MOCKED TIER CANNOT ASSERT BY PASSING.
     `import.meta.env` is a compile-time substitution, so the sponsor origin is
     baked into the bundle `previewEnv` builds. If that origin and the route
     globs in `mocks.ts` ever name different hosts, every interception here
     misses, the app talks to a real machine on the internet, and the specs go
     on passing — quietly graded against whatever that machine happened to say.
     That is exactly what this tier had been doing against a host deleted on
     2026/08/27 whose address is now somebody else's.

     Interception and the network are mutually exclusive in Playwright: a
     fulfilled route opens no socket. So the two counters agreeing is the proof
     that nothing reached the network, and the count being above zero is the
     proof that the walk so far — the sponsorship probe and the fee-sponsor
     readiness read behind the availability line — asked the sponsor anything
     at all. Both halves are needed: zero and zero also "agree". */
  const traffic = network.sponsorTraffic();
  expect(traffic.intercepted).toBeGreaterThan(0);
  expect(traffic.requests).toBe(traffic.intercepted);
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
  await page.route(sponsorRoute('/status'), async (route) => {
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
  await page.route(sponsorRoute('/status'), (route) =>
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
  await page.route(sponsorRoute('/status'), async (route) => {
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

  /* EVERY sentence the running step shows, recorded rather than raced.
     A `toBeVisible` on each stage in turn can only ever assert that a stage
     was on screen at the moment Playwright happened to look, which makes the
     test's own scheduling part of what it measures — and the stages are short
     precisely because the fix made them short. A MutationObserver installed
     before the click sees all of them, in order, however briefly each lasts.

     It watches the STEP'S OWN detail line rather than the button. Until
     2026/08/30 the button repeated that sentence with a spinner beside it —
     one fact said twice, over a view whose whole job is to show where the
     claim has got to — and the button now names only the running step. */
  await page.evaluate(() => {
    const screen = document.querySelector('.mnid-screen');
    if (!screen) throw new Error('The claim screen was not on screen.');
    const seen: string[] = [];
    (window as unknown as { __labels: string[] }).__labels = seen;
    const record = () => {
      const text = (document.querySelector('.mnid-stepper-detail')?.textContent ?? '').trim();
      if (text && text !== seen[seen.length - 1]) seen.push(text);
    };
    record();
    new MutationObserver(record).observe(screen, {
      childList: true,
      subtree: true,
      characterData: true,
    });
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

  /* STAGE ONE, on screen while the registry takes its two seconds — and with
     it the sentence a spinner cannot carry: what is happening, and that this
     part is short. The reviewer asked for exactly this ("you have to let the
     user know this will take time").

     It is the running STEP that says it. Until 2026/08/30 the button said it
     too, with a spinner beside it, which was one fact said twice over a view
     built to show exactly that fact — so the button now names the step it is
     waiting on, and the sentence has one home. */
  await expect(page.locator('.mnid-stepper-detail')).toHaveText(
    new RegExp(`Checking ${NAME}\\.night is still free`),
    { timeout: 10_000 },
  );
  await expect(page.getByRole('button', { name: 'Checking your name' })).toBeVisible();
  /* And around it, the thing a spinner cannot be: a view of where in the claim
     this is. Drilled properly in the test below; here it is enough that the
     panel is a stepper at all. */
  await expect(page.locator('.mnid-stepper-item')).toHaveCount(3);

  /* Then the refusal, with the sponsor's own sentence — before any ceremony,
     exactly as it was before the warming existed. */
  await expect(page.getByText(/The claim did not complete/i)).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByText(/The Passport service that registers names is not available right now/i),
  ).toBeVisible();

  /* THE STAGES, in the order they happened. Two distinct sentences before the
     refusal, each naming what the running step is doing: this is the whole of
     the defect, which was ONE unchanging label — "Deploying your name's
     resolver…" — held over the entire wait. Nothing here is ever an
     unexplained spinner. */
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
  await page.route(sponsorRoute('/status'), (route) =>
    route.fulfill({
      json: { network: 'stagenet', aliasSponsorship: 'available', assetSymbol: 'mUSD' },
    }),
  );
});

test('a claim that failed keeps the name, and the reload lands on Home with a retry', async () => {
  /* WHAT CHANGED, AND WHY THE OLD ASSERTION WAS WORSE.
     Until 6ad9bbc a claim that died part-way persisted nothing: the name the
     user had chosen vanished, and a Passport that had already stored its name
     step as done reloaded into a dashboard with no name and no way back to
     one — bricked, for that Passport, for ever. The catch now writes the same
     QUEUED record the requeue in `registerQueuedAlias` writes, carrying the
     failure as its reason, so the reload below is no longer a return to the
     naming screen. It is a return to a Passport that still knows what its
     owner picked and offers to try again, which is the better answer.

     The claim it is reading is the sponsorless one refused in the test above:
     nothing extra is arranged for this. */
  await page.reload();

  // Home, not the naming screen — the name step is resolved, it just is not
  // on chain.
  await expect(page.getByRole('heading', { name: new RegExp(NAME, 'i') })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText(/Choose your .night name/i)).toHaveCount(0);

  /* THE NAME IS STILL THERE, said as queued rather than as registered, with
     the reason the claim gave for it. A queued name that read as registered
     would be the more damaging bug of the two. */
  const identity = page.locator('.mnid-card').first();
  await expect(identity).toContainText(`${NAME}.night`);
  await expect(identity).toContainText(/Queued — not registered yet/i);
  await expect(identity).toContainText(
    /The Passport service that registers names is not available right now/i,
  );

  /* AND A WAY TO TRY AGAIN, on the row the queued name is on. It is not
     clicked here: "Register now" is the REAL claim re-run — the deploy, the
     prover, and the registry write — which this tier cannot complete and
     `claim-progress.spec.ts` and `stagenet.live.spec.ts` drive between them.
     What is owed here is that the control exists and is offered, because
     without it the queued record is a dead end wearing a name. */
  const retry = identity.getByRole('button', { name: 'Register now' });
  await expect(retry).toBeVisible();
  await expect(retry).toBeEnabled();

  /* The walk goes on from a Passport with no name at all, which is the state
     the tests below are written against. Dropping the record is a fixture
     reset — the same store, through the same key — and not a claim about the
     app: what the app does with the record is everything asserted above. */
  await page.evaluate(() => localStorage.removeItem('passport-alias:v1'));
});

test('the claim shows three steps, and the long wait is one of them — not three more', async () => {
  /* WHAT WAS PROMISED, AND TO WHOM.
     Hector, 2026/08/26 11:35: no infinite spinner, and tell the user this will
     take time. The answer given the same afternoon was a three-step view —
     circle, line, circle — and this holds the shipped bundle to it.

     THE RULE BEING TESTED is `src/lib/claimSteps.ts`: seven claim phases fold
     into three steps a person can act on, and the ones inside the long wait
     ("Registering…", "Confirming…") are SUB-STATES of the third step rather
     than four more circles. Every phase of that fold is drilled directly, on
     the pure rule, in `src/lib/claimSteps.test.ts`; what is held to HERE is
     that the shipped screen draws the three steps, in order, with the live
     phase beneath the one that is running — the part a unit test cannot see.

     A slow registry is what makes the first step long enough to read;
     `setRegistryDelay` holds the indexer's answer back exactly as a poor link
     does. The sponsor is stood down, so the walk still costs no ceremony. */
  test.setTimeout(200_000);
  await page.route(sponsorRoute('/status'), (route) =>
    route.fulfill({ json: { network: 'stagenet', aliasSponsorship: 'paused' } }),
  );
  await page.reload();
  await expect(page.getByText(/Choose your .night name/i)).toBeVisible({ timeout: 60_000 });

  /* A name this walk has not asked about, so the warm answer from the test
     above cannot be reused: `identity/claimWarmup.ts` keys on the name and the
     network. */
  const stepperName = 'passportstepper';
  await page.getByLabel('Your Midnight name').fill(stepperName);
  await expect(page.getByText(`${stepperName}.night is available`)).toBeVisible({ timeout: 30_000 });

  /* Past `identity/claimWarmup.ts`'s ten-second window, so the claim re-asks
     the registry for itself and the first step has a real wait behind it
     rather than an answer already in hand. */
  await page.waitForTimeout(11_000);
  network.setRegistryDelay(6_000);
  await page.getByRole('button', { name: new RegExp(`Claim ${stepperName}\\.night`) }).click();

  const steps = page.locator('.mnid-stepper-item');
  await expect(steps).toHaveCount(3);

  // THREE STEPS, IN ORDER, in the words the user was promised.
  await expect(steps.nth(0)).toContainText('Checking your name');
  await expect(steps.nth(1)).toContainText('Confirm with your passkey');
  await expect(steps.nth(2)).toContainText('Setting up your account');

  // The first is running; the two ahead of it are not claimed as anything.
  await expect(steps.nth(0)).toHaveAttribute('data-state', 'active');
  await expect(steps.nth(1)).toHaveAttribute('data-state', 'todo');
  await expect(steps.nth(2)).toHaveAttribute('data-state', 'todo');

  /* The warning about the minutes, on the step that costs them, and on screen
     before the wait rather than once the user is already inside it. */
  await expect(
    page.getByText(/Your Passport is on its way\. This part takes a few minutes\./),
  ).toBeVisible();

  /* The live phase, beneath the step it belongs to and nowhere else. This is
     the sub-state rule made visible: "Checking passportstepper.night is still
     free…" is what the first step is DOING, not a fourth circle. */
  await expect(steps.nth(0).locator('.mnid-stepper-detail')).toHaveText(
    new RegExp(`Checking ${stepperName}\\.night is still free`),
  );
  await expect(steps.nth(1).locator('.mnid-stepper-detail')).toHaveCount(0);
  await expect(steps.nth(2).locator('.mnid-stepper-detail')).toHaveCount(0);

  // The claim is refused for want of a sponsor, before any ceremony.
  await expect(page.getByText(/The claim did not complete/i)).toBeVisible({ timeout: 30_000 });

  network.setRegistryDelay(0);
  await page.route(sponsorRoute('/status'), (route) =>
    route.fulfill({
      json: { network: 'stagenet', aliasSponsorship: 'available', assetSymbol: 'mUSD' },
    }),
  );
});

test('a reload mid-onboarding returns to the name step, never to Home', async () => {
  /* The claim above was refused too, so it left its own queued record — and a
     queued name is a resolved name step, which the test above is what holds.
     The state THIS test is about is the other one: a Passport with no name at
     all, which is what the 2026/08/24 sighting was, so the record goes first. */
  await page.evaluate(() => localStorage.removeItem('passport-alias:v1'));
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
  /* A REAL stagenet Passport account, and the one `iamtester.night` resolves
     to. Seeding a real address rather than an invented one is what lets the
     mocked tier show real balances: the boundary replays that account's own
     recorded ledger for it. */
  const account = PASSPORT_ACCOUNT_ADDRESS;
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
     the account model — the sentence that says where the name leads. */
  await expect(page.getByText(`${NAME}.night`).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Registered on Stagenet/i)).toBeVisible();
  await expect(page.getByText(/People sending to this name reach your account\./)).toBeVisible();
  // And the account beside it, in one line, with nothing else on it.
  await expect(page.getByText(/Your account is ready/)).toBeVisible();

  /* NOT ONE HEXADECIMAL STRING on the identity surface (ruled 2026/08/26).
     The resolver's address, the resolver deploy, the registration, and the
     account's own deployment were all printed here as truncated hashes; a
     reviewer shown his own name was shown those instead. The transactions are
     real and still linked from the activity trail — this surface is not where
     a hash belongs. Asserted against the seeded values themselves, truncated
     exactly as the card used to truncate them. */
  const identityText = await visibleText();
  for (const seededHex of ['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc', 'dddddddddd', '8054fcaccc']) {
    expect(identityText).not.toContain(seededHex);
  }
  expect(identityText).not.toMatch(/Resolver deploy|Registration|Deployment/);
  // Nor the machinery the card used to narrate around them.
  expect(identityText).not.toMatch(/deploy|indexer|ledger hash|fee sponsor/i);

  /* The receiving surface. ONE address, and it is the account contract the
     name resolves to — under the account model nothing is ever sent to the
     wallet, so nothing here invites it. The shielded and DUST rows that used
     to sit beside this went with the account ruling on 2026/08/24. */
  await page.getByRole('button', { name: /^Receive$/ }).click();
  const accountRow = page.locator('.mnhome-address');
  await expect(accountRow).toHaveCount(1);
  await expect(accountRow).toContainText('Your account');
  await expect(accountRow.locator('code')).toContainText('8054fcac');

  const text = await visibleText();
  expect(text).not.toContain('mn_addr');
  expect(text).not.toContain('mn_shield-addr');
  expect(text).not.toMatch(/\bDUST\b/);
  expect(text).not.toMatch(/wallet address|your wallet/i);
  // A public receiving address — never the keys behind it.
  await expect(page.getByText(/never the keys behind it/i)).toBeVisible();
  await page.keyboard.press('Escape');
});

test('the activity trail shows what really happened, and survives a reload', async () => {
  /* THE TRAIL NOBODY COULD SEE.
     `addActivity` has written a row on every transfer, registration, and
     failure since Passport had anything to record. Until 2026/08/30 nothing
     rendered them: seven write paths feeding React state that no component
     read. What is asserted here is that the rows on screen are rows THIS RUN
     really wrote — the refused claims above, which are the only outcome a
     sponsorless mocked tier can genuinely produce — rather than anything
     seeded for the test. */
  const trail = page.locator('.mnhome-activity');
  await expect(trail).toBeVisible({ timeout: 60_000 });
  const failedClaim = trail.getByText('Your name could not be registered').first();
  await expect(failedClaim).toBeVisible();

  /* Every row carries how long ago, in words. The claims above happened within
     this run, so the only honest answers are seconds or single minutes. */
  await expect(trail.locator('.mnhome-activity-when').first()).toHaveText(
    /just now|\d+ min ago/,
  );
  // And a day heading, because a trail with no dates is a list of orphans.
  await expect(trail.locator('.mnhome-activity-heading').first()).toHaveText('Today');

  /* NO MACHINERY on the surface. The rows that used to say "resolves to this
     Passport's account contract (7c2f4a19…)" were swept with the identity card
     on 2026/08/26; a transaction is still reachable, as a LINK rather than as a
     hash to read. */
  const trailText = await trail.innerText();
  expect(trailText).not.toMatch(/\b[0-9a-f]{32,}\b/);
  expect(trailText).not.toMatch(/contract|registry|indexer|resolver/i);

  /* PERSISTED. The rows lived in React state and went with the tab; they are
     now stored per credential, which is what makes the trail an answer to
     "what happened yesterday" rather than only to "what happened just now". */
  const before = await trail.locator('.mnhome-activity-row').count();
  expect(before).toBeGreaterThan(0);
  await page.reload();
  await expect(page.locator('.mnhome-activity')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.mnhome-activity-row')).toHaveCount(before);
  await expect(
    page.locator('.mnhome-activity').getByText('Your name could not be registered').first(),
  ).toBeVisible();
});

test('every token on the balance list is named, and none of them is 64 characters', async () => {
  /* TOKENS THAT COULD NOT BE TOLD APART.
     The balance list labelled every unnamed colour "Shielded" and put the raw
     64-character colour underneath as its unit — so an account holding several
     showed several identical-looking rows, which is "unusable, and it will
     cause wrong sends" (2026/08/26). Colours Passport can name are now named,
     and one it cannot reads `Token · a1b2…` with the shortened colour beneath.

     Asserted against the REAL account this tier seeds: it holds 2000 atomic
     NIGHT and 100 units of the sponsor's mUSD colour, recorded from stagenet. */
  /* Home from a cold start, rather than from whatever the test above left on
     screen. The balances are read when the account opens, and this is the one
     assertion in the file that depends on that read having happened. */
  await page.goto('/');
  await expect(page.getByRole('button', { name: /^Send$/ }).first()).toBeVisible({
    timeout: 60_000,
  });
  const assets = page.locator('.mnhome-assets');
  await expect(assets).toBeVisible({ timeout: 60_000 });
  /* THE READ LANDS AFTER THE SCREEN DOES, so the strip is briefly one card of
     "Syncing" and everything below is a SNAPSHOT of whatever was on it at the
     instant it was taken. Waited for with a retrying assertion first — without
     this the file passed alone and failed whenever another spec ran ahead of
     it and the account read came back a moment later (seen 2026/08/31). */
  await expect(assets).toContainText(/mUSD/i, { timeout: 60_000 });
  const cards = await assets.innerText();

  /* Matched case-insensitively: the card's own label is upper-cased in CSS, so
     `innerText` reports "MUSD" for a symbol the code spells "mUSD". */
  expect(cards).toMatch(/NIGHT/i);
  expect(cards).toMatch(/mUSD/i);
  // The one thing that must never be on a card again.
  expect(cards).not.toMatch(/\b[0-9a-f]{32,}\b/);
  // And the balances are the account's own, not zeros against a real account.
  expect(cards).toContain('0.002');
  expect(cards).toContain('100');

  /* THE CAP does not fire below its threshold. Two tokens is not a list that
     needs hiding, and a disclosure over two cards would be furniture. The rule
     itself — five, then the rest on request, NIGHT first and the unnamed by
     balance — is drilled in `src/lib/colour.test.ts`, where it lives: a browser
     cannot be given a seven-colour account without a contract state minted for
     it, and this workspace's Node graph cannot mint one (see the report). */
  await expect(page.getByRole('button', { name: /^Show all \(\d+\)$/ })).toHaveCount(0);
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
  /* Since 2026/08/30 the field takes a NAME as well, and the hint leads with
     it — the name is the thing Passport is for; the address formats are the
     fallback. Since 2026/08/31 it names only the ONE address form the CHOSEN
     asset can go to, rather than listing both and leaving the refusal to do
     the teaching: the sheet opens on NIGHT, so this is NIGHT's. */
  await expect(
    page.getByText(/A Midnight name, or an unshielded \(mn_addr…\) stagenet address/),
  ).toBeVisible();
  expect(sheet).not.toMatch(/mn_addr_stagenet1[a-z0-9]{10,}/);
  expect(sheet).not.toMatch(/mn_shield-addr_stagenet1[a-z0-9]{10,}/);
});

test('a `.night` name is a recipient, and the review step shows the name', async () => {
  /* THE HEADLINE MOMENT.
     "A name, not an address" is the second promise on the welcome screen, and
     until 2026/08/30 the Send sheet could not keep it: everything typed went to
     the bech32m codec and anything that was not an address was refused.

     Both reads in this test are REAL. `iamtester` is a name genuinely
     registered on stagenet, the `.night` TLD's own recorded state says which
     leaf holds it, and that leaf's own recorded state says which account it
     points at — decoded by the real Midnames contract module from real ledger
     bytes. Nothing about the resolution is stubbed; only the transport is. */
  const field = page.getByRole('textbox').first();
  await field.fill('');
  await field.fill(`${RESOLVABLE_NAME}.night`);

  const chip = page.locator('.mnhome-send-resolved');
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(chip).toContainText(`${RESOLVABLE_NAME}.night`);
  /* FOUR CHARACTERS of the account, and no more. The chip's job is to let
     somebody agree the lookup found something; an address is not a thing a
     Passport user is shown. */
  await expect(chip).toContainText(`…${PASSPORT_ACCOUNT_ADDRESS.slice(-4)}`);
  expect(await chip.innerText()).not.toContain(PASSPORT_ACCOUNT_ADDRESS.slice(0, 10));

  // A bare label is the same name. Answered from the sheet's own memory: the
  // registry is not asked twice for one name.
  const readsBefore = network.calls.filter((call) =>
    call.includes('CONTRACT_STATE_QUERY'),
  ).length;
  await field.fill('');
  await field.fill(RESOLVABLE_NAME);
  await expect(chip).toContainText(`${RESOLVABLE_NAME}.night`);
  expect(
    network.calls.filter((call) => call.includes('CONTRACT_STATE_QUERY')).length,
  ).toBe(readsBefore);

  /* The review step. The account's balance is a REAL account's — 0.002 NIGHT,
     recorded from stagenet — so the amount below is genuinely affordable. */
  await page.getByRole('textbox').nth(1).fill('0.000001');
  await page.getByRole('button', { name: /^Review$/ }).click();

  await expect(page.getByText('Review this transfer')).toBeVisible();
  const review = await page.locator('.mnhome-send-rows').innerText();
  expect(review).toContain(`${RESOLVABLE_NAME}.night`);
  /* NO HEX. Not the account, not any part of it beyond the four characters the
     "ending" line carries — and no "Show full address" control, because there
     is no address on this row to show. */
  expect(review).not.toContain(PASSPORT_ACCOUNT_ADDRESS);
  expect(review).not.toMatch(/\b[0-9a-f]{16,}\b/);
  await expect(page.getByRole('button', { name: /Show full address/i })).toHaveCount(0);
  // And the honest warning that a name costs two transactions rather than one.
  expect(review).toMatch(/Two steps/);

  await page.getByRole('button', { name: /^Back$/ }).click();
});

test('a name nobody holds is said plainly, and the field stays editable', async () => {
  const field = page.getByRole('textbox').first();
  await field.fill('');
  await field.fill('nobodyhasthisnameatall.night');

  const refusal = page.locator('#mnhome-send-recipient-error');
  await expect(refusal).toBeVisible({ timeout: 30_000 });
  await expect(refusal).toContainText('No Passport has the name');
  // The refusal is about the NAME, not about a Midnight address it never was.
  expect(await refusal.innerText()).not.toContain('not a Midnight address');
  await expect(page.getByRole('button', { name: /^Review$/ })).toBeDisabled();

  // Still editable — a refusal that clears the field would be its own defect.
  await expect(field).toBeEditable();
  await field.fill('');
  await field.fill(`${RESOLVABLE_NAME}.night`);
  await expect(page.locator('.mnhome-send-resolved')).toBeVisible({ timeout: 30_000 });

  /* And a pasted address still works, unchanged. The name path is an addition,
     not a replacement. */
  await field.fill('');
  await field.fill(RECIPIENT);
  await expect(page.locator('.mnhome-send-resolved')).toHaveCount(0);
  await expect(page.locator('#mnhome-send-recipient-error')).toHaveCount(0);
  await field.fill('');
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
  /* The placeholder is a NAME since 2026/08/30 — that is what the field is
     for — and an address is still what it takes. */
  await page.getByPlaceholder('alice.night').fill(RECIPIENT);
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

test('a send whose passkey will not answer offers a retry and a way out, in the sheet', async () => {
  /* THE SAME DEAD END, ON THE OTHER SURFACE THAT RAISES A CEREMONY.
     The Send sheet's confirm IS a passkey assertion — it is what yields the
     device secret `withdraw_night` is gated on — so a passkey the platform
     will not use lands here exactly as it lands on the name step. Before
     2026/08/31 the sheet reported it and stopped: "Approval cancelled —
     nothing was signed or sent", with the sheet's Send button a Back click
     away and no account of what to do if the passkey is on another device.

     THE FIXTURE is the platform decision no test can make: ONE assertion
     refused with the real `NotAllowedError` a dismissed or unanswerable sheet
     produces, armed a call at a time at the `navigator.credentials` boundary.
     Everything else is the shipped bundle — the sheet, the account seam, and
     the rule in `src/lib/passkeyRecovery.ts` that decides what is offered. */
  await page.evaluate(() => {
    const api = navigator.credentials;
    const get = api.get.bind(api);
    const state = window as unknown as { __prompts: number; __refuseNextAssertion?: boolean };
    state.__prompts = 0;
    api.get = (options?: CredentialRequestOptions) => {
      state.__prompts += 1;
      if (state.__refuseNextAssertion) {
        state.__refuseNextAssertion = false;
        return Promise.reject(
          new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'),
        );
      }
      return get(options);
    };
  });

  /* The sheet is still open from the test above, with the recipient in it.
     An amount the account can genuinely cover, so nothing but the ceremony is
     in the way. */
  await page.getByPlaceholder('0.0').fill('0.000001');
  await page.getByRole('button', { name: /^Review$/ }).click();
  await expect(page.getByText('Review this transfer')).toBeVisible();

  await page.evaluate(() => {
    (window as unknown as { __refuseNextAssertion?: boolean }).__refuseNextAssertion = true;
  });
  /* The sheet's own primary, not Home's Send behind it — both say "Send". */
  await page.locator('.mnhome-send-primary').click();

  /* The fact that matters most STILL LEADS — somebody who cancelled on purpose
     needs to read that nothing moved before anything else. */
  await expect(page.getByText(/Nothing was sent/)).toBeVisible({ timeout: 60_000 });
  /* Then the explanation, which does not claim to know which of the two things
     happened, and names the phone case first because that is the case in which
     the platform's own sheet was right. */
  await expect(page.getByText(/Your passkey could not be used on this device/)).toBeVisible();
  await expect(page.getByText(/follow the QR option/)).toBeVisible();
  await expect(page.getByText(/stay on chain/)).toBeVisible();

  /* Scoped to the SHEET. Home is still mounted behind the scrim with a sign-out
     of its own, and the controls this failure owes the user are the ones inside
     the surface they are reading — a way out they cannot reach without closing
     the sheet first is not a way out of the sheet. */
  const sheet = page.locator('.mnhome-send');
  const retry = sheet.getByRole('button', { name: 'Try again' });
  const signOut = sheet.getByRole('button', { name: 'Sign out' });
  await expect(retry).toBeVisible();
  await expect(signOut).toBeVisible();

  // Nothing raw from the platform. `NotAllowedError` is true of four different
  // things and useful for none of them.
  await expect(page.getByText(/NotAllowedError|not allowed/i)).toHaveCount(0);

  /* TRY AGAIN RUNS THE SAME ACTION, which is the whole of what it promises —
     and the only honest way to see that is the ceremony being raised a second
     time. One prompt for the send, one for the retry. */
  expect(await page.evaluate(() => (window as unknown as { __prompts: number }).__prompts)).toBe(1);
  await page.evaluate(() => {
    (window as unknown as { __refuseNextAssertion?: boolean }).__refuseNextAssertion = true;
  });
  await retry.click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __prompts: number }).__prompts), {
      timeout: 60_000,
    })
    .toBe(2);
  await expect(page.getByText(/Your passkey could not be used on this device/)).toBeVisible();

  /* And the other control genuinely leaves. This is the half a user cannot
     reach any other way when the failure happens on the name step, and it is
     the same control here. */
  await signOut.click();
  await expect(page.getByRole('button', { name: /Continue with Passport/i })).toBeVisible({
    timeout: 60_000,
  });
});

test('a passkey this browser does not know about never blocks the way in', async ({
  browser,
}) => {
  /* WHAT THIS REPLACED, AND WHY.
     Until 2026/08/27 pressing "Continue with Passport" raised a discoverable
     assertion first — the platform's "Use a saved passkey for this site"
     dialog. On a Chrome profile with nothing saved that dialog offers only
     "Use a phone or tablet" and "USB security key": no Touch ID, no Windows
     Hello, and no way at all to make a passkey. Two reviewers stopped dead
     there; one got through only by signing with his phone, which was the sole
     door left open. A newcomer is now taken straight to enrolment, where the
     platform asks the question they actually came to answer.

     THE FIXTURE. `WebAuthn.addCredential` plants a resident credential the
     virtual authenticator did not create — a credential that answers with
     `{ prf: {} }` and no `results.first`, modelling an older passkey enrolled
     without the extension. This browser has no record of it, so it must not
     be consulted, must not be replaced, and must not stand in anybody's way.

     Its own context: the shared page above already holds a real Passport. */
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
      hasPrf: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  /* Every ceremony the page raises, so the test can prove which came first. */
  const calls: { kind: string; excluded?: number }[] = [];
  await fresh.exposeFunction('__recordCeremony', (entry: { kind: string; excluded?: number }) => {
    calls.push(entry);
  });
  await fresh.addInitScript(() => {
    const api = navigator.credentials;
    const create = api.create.bind(api);
    const get = api.get.bind(api);
    api.create = (options?: CredentialCreationOptions) => {
      const publicKey = options?.publicKey as { excludeCredentials?: unknown[] } | undefined;
      void (window as unknown as Record<string, (entry: unknown) => void>).__recordCeremony({
        kind: 'create',
        excluded: publicKey?.excludeCredentials?.length ?? 0,
      });
      return create(options);
    };
    api.get = (options?: CredentialRequestOptions) => {
      void (window as unknown as Record<string, (entry: unknown) => void>).__recordCeremony({
        kind: 'get',
      });
      return get(options);
    };
  });

  try {
    await fresh.goto('/');
    await fresh.getByRole('button', { name: /Continue with Passport/i }).click();

    /* A brand-new Passport, so it is welcomed — and the one control on that
       screen is a real way onward, not a decoration. */
    await expect(fresh.getByRole('heading', { name: /Welcome to Passport/i })).toBeVisible({
      timeout: 90_000,
    });
    await fresh.getByRole('button', { name: 'Choose my name' }).click();

    /* The name step is only reachable once PRF derived a seed and the wallet
       opened, so arriving here is proof the enrolment genuinely worked rather
       than merely that a dialog was dismissed. */
    await expect(fresh.getByText(/Choose your .night name/i)).toBeVisible({ timeout: 90_000 });

    /* No sign-in dialog was raised on the way, which is the whole point: the
       planted credential was never consulted. */
    expect(calls.map((entry) => entry.kind)).toEqual(['create']);

    /* And nothing told the user their own passkey was a problem. */
    await expect(
      fresh.getByText(/does not support the extension Passport needs/i),
    ).toHaveCount(0);
  } finally {
    await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }).catch(() => {});
    await context.close();
  }
});

/* -------------------------------------------------------------------------- */
/* The keyless dead end (2026/08/30)                                          */
/*                                                                            */
/* A browser can hold Passport records whose credential the platform keystore  */
/* will no longer produce — the passkey deleted, a different OS profile, a     */
/* keychain that never synced. Sign-in then raises the platform's "use a saved */
/* passkey" sheet with nothing loadable in it, and WebAuthn reports the same   */
/* `NotAllowedError` it reports for a sheet the user dismissed. Every control  */
/* on the screen was a way of LOADING a passkey, which is exactly what had     */
/* just failed, so the state was terminal. The user's own words: "If there is  */
/* no key, can you not just create it? Why does it always have to load it?"    */
/*                                                                            */
/* THE FIXTURE. The profile record is seeded straight into this browser's own  */
/* IndexedDB, naming a credential no authenticator has ever held. That IS the  */
/* reported state — records here, no credential there — and it is the honest   */
/* way to reach it: a virtual authenticator cannot be made to forget a         */
/* credential while keeping the records that name it, and removing the         */
/* authenticator removes the ability to enrol the replacement the test is      */
/* about. Nothing else is stubbed; the ceremonies below are real.              */
/* -------------------------------------------------------------------------- */

/** A credential id no authenticator in this run will ever hold. */
const STRANDED_CREDENTIAL_ID = Buffer.alloc(32, 0x5a).toString('base64');

/** The storage key `publicProfile.ts` derives from a credential id. */
function localProfileKey(credentialId: string): string {
  return `passkey:${credentialId.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

/**
 * Writes a local Passport profile bound to `credentialId` into the page's own
 * IndexedDB — the returning-Passport record, exactly as `saveDemoProfile`
 * writes it, for a passkey this device cannot produce.
 */
async function seedStrandedProfile(target: Page, credentialId: string): Promise<void> {
  await target.evaluate(async (id: string) => {
    const scoped = id.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('midnight-passport', 2);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains('public-profile')) {
          open.result.createObjectStore('public-profile');
        }
        if (!open.result.objectStoreNames.contains('private-state')) {
          open.result.createObjectStore('private-state');
        }
      };
      open.onerror = () => reject(open.error);
      open.onsuccess = () => resolve(open.result);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('public-profile', 'readwrite');
      transaction.objectStore('public-profile').put(
        {
          subjectId: `passkey:${scoped}`,
          passkey: { credentialId: id, label: 'Midnight Passport', rpId: location.hostname },
          accountId: `passport-local:${scoped}`,
          createdAt: new Date().toISOString(),
        },
        `passkey:${scoped}`,
      );
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }, credentialId);
}

/** Every local profile key this browser holds, newest write included. */
async function storedProfileKeys(target: Page): Promise<string[]> {
  return target.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('midnight-passport', 2);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => resolve(open.result);
    });
    const keys = await new Promise<string[]>((resolve, reject) => {
      const request = db.transaction('public-profile', 'readonly').objectStore('public-profile').getAllKeys();
      request.onsuccess = () => resolve(request.result.map(String));
      request.onerror = () => reject(request.error);
    });
    db.close();
    return keys;
  });
}

test('a Passport whose passkey this device cannot produce is offered a new one', async ({
  browser,
}) => {
  /* The reported dead end, and the whole of its way out: "Continue with
     Passport" targets the stored credential, the keystore has nothing to
     answer with, and the screen that comes back offers to make one. */
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const stranded = await context.newPage();
  await installNetworkBoundary(stranded);
  const authenticator = await installVirtualAuthenticator(context, stranded);

  try {
    await stranded.goto('/');
    await seedStrandedProfile(stranded, STRANDED_CREDENTIAL_ID);
    await stranded.reload();

    await stranded.getByRole('button', { name: /Continue with Passport/i }).click();

    /* Not a sentence about what went wrong. A sentence about what can be done
       about it, and the control that does it. */
    await expect(stranded.getByText(/Could not load your passkey/i)).toBeVisible({
      timeout: 60_000,
    });
    await expect(stranded.getByText(/stays untouched/i)).toBeVisible();
    const create = stranded.getByRole('button', { name: /Create a new passkey/i });
    await expect(create).toBeVisible();

    /* And the retry is still there beside it: this state offers both readings
       of what happened — the passkey is gone, or it is merely not here now. */
    await expect(stranded.getByRole('button', { name: /Continue with Passport/i })).toBeVisible();

    /* Nothing raw from the platform. `NotAllowedError`'s own message says the
       operation "either timed out or was not allowed", which is true of four
       different things and useful for none of them. */
    await expect(stranded.getByText(/NotAllowedError|not allowed/i)).toHaveCount(0);

    await create.click();

    /* A working Passport, not a second error: the welcome screen is only ever
       reached once PRF has derived a seed and the wallet has opened. */
    await expect(stranded.getByRole('heading', { name: /Welcome to Passport/i })).toBeVisible({
      timeout: 120_000,
    });
    await stranded.getByRole('button', { name: 'Choose my name' }).click();
    await expect(stranded.getByText(/Choose your .night name/i)).toBeVisible({ timeout: 60_000 });

    /* THE OLD RECORDS ARE STILL THERE. The new Passport keys its profile and
       its private-state scope by ITS credential id, so it cannot have landed
       on the stranded one — which is what makes the panel's promise that a
       Passport this browser holds "stays untouched" a fact rather than a
       hope. If the missing passkey turns up, it reopens its own Passport. */
    const keys = await storedProfileKeys(stranded);
    expect(keys).toContain(localProfileKey(STRANDED_CREDENTIAL_ID));
    expect(keys.length).toBe(2);
  } finally {
    await authenticator.remove().catch(() => {});
    await context.close();
  }
});

test('a picker with nothing in it offers a new passkey too, not just an apology', async ({
  browser,
}) => {
  /* The other half. "Use a different passkey" runs a DISCOVERABLE assertion,
     so the platform shows its own picker — and for this user it is empty, or
     they close it, which WebAuthn reports identically. This path used to end
     in a sentence, which was the worse failure of the two: it is where the
     create path's advice sent people, so the advice led from one dead end to
     another. */
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const stranded = await context.newPage();
  await installNetworkBoundary(stranded);
  const authenticator = await installVirtualAuthenticator(context, stranded);

  try {
    await stranded.goto('/');
    await seedStrandedProfile(stranded, STRANDED_CREDENTIAL_ID);
    await stranded.reload();

    await stranded.getByRole('button', { name: /Use a different passkey/i }).click();

    await expect(stranded.getByText(/Could not load your passkey/i)).toBeVisible({
      timeout: 60_000,
    });
    const create = stranded.getByRole('button', { name: /Create a new passkey/i });
    await expect(create).toBeVisible();

    await create.click();
    await expect(stranded.getByRole('heading', { name: /Welcome to Passport/i })).toBeVisible({
      timeout: 120_000,
    });
    await stranded.getByRole('button', { name: 'Choose my name' }).click();
    await expect(stranded.getByText(/Choose your .night name/i)).toBeVisible({ timeout: 60_000 });
  } finally {
    await authenticator.remove().catch(() => {});
    await context.close();
  }
});

test('a passkey that is still there is signed in to, never created over', async ({ browser }) => {
  /* THE GUARD, DRIVEN THROUGH THE NEW BUTTON. The way out above enrols
     deliberately — so the question it raises is what happens when the user
     presses it and the passkey was there all along. The answer must be that
     the authenticator refuses (the enrolment excludes every credential this
     browser holds a Passport record for), that the refusal is not shown as a
     failure, and that the user ends up signed in to the Passport they still
     have. A create that succeeded here would take the PRF secret every coin in
     that wallet derives from, unrecoverably.

     Getting to the panel with a live credential: ONE assertion is refused with
     the real `NotAllowedError` a dismissed sheet produces, at the
     `navigator.credentials` boundary and armed a call at a time. That is the
     same class of fixture as the virtual authenticator itself — both stand in
     for a platform decision no test can make — and it is the only one that
     works here. `WebAuthn.setUserVerified` turns verification off and, as of
     Chrome 140, does not turn it back on, so an authenticator crippled that
     way could not perform the enrolment this test is about. */
  test.setTimeout(240_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const held = await context.newPage();
  await installNetworkBoundary(held);

  const client = await context.newCDPSession(held);
  await client.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      hasLargeBlob: true,
      automaticPresenceSimulation: true,
    },
  });

  /* Every ceremony the page raises, so the test can prove the create was made
     WITH the exclusion and that a sign-in followed it. */
  const calls: { kind: string; excluded?: number }[] = [];
  await held.exposeFunction('__recordCeremony', (entry: { kind: string; excluded?: number }) => {
    calls.push(entry);
  });
  await held.addInitScript(() => {
    const api = navigator.credentials;
    const create = api.create.bind(api);
    const get = api.get.bind(api);
    api.create = (options?: CredentialCreationOptions) => {
      const publicKey = options?.publicKey as { excludeCredentials?: unknown[] } | undefined;
      void (window as unknown as Record<string, (entry: unknown) => void>).__recordCeremony({
        kind: 'create',
        excluded: publicKey?.excludeCredentials?.length ?? 0,
      });
      return create(options);
    };
    api.get = (options?: CredentialRequestOptions) => {
      void (window as unknown as Record<string, (entry: unknown) => void>).__recordCeremony({
        kind: 'get',
      });
      /* One refusal, armed by the test immediately before the click it belongs
         to — the sheet the user closed, or the sheet that had nothing in it.
         WebAuthn reports both as this exact error and will not say which. */
      const armed = window as unknown as { __refuseNextAssertion?: boolean };
      if (armed.__refuseNextAssertion) {
        armed.__refuseNextAssertion = false;
        return Promise.reject(
          new DOMException(
            'The operation either timed out or was not allowed.',
            'NotAllowedError',
          ),
        );
      }
      return get(options);
    };
  });

  try {
    await held.goto('/');
    await held.getByRole('button', { name: /Continue with Passport/i }).click();
    await expect(held.getByRole('heading', { name: /Welcome to Passport/i })).toBeVisible({
      timeout: 120_000,
    });

    /* Back to the landing screen with the profile and the credential both
       intact. The session record is the reload stopgap, and clearing it is
       what signing out does; the Passport itself is untouched. */
    await held.evaluate(
      async () =>
        new Promise<void>((resolve) => {
          const request = indexedDB.deleteDatabase('midnight-passport-session');
          request.onsuccess = () => resolve();
          request.onerror = () => resolve();
          request.onblocked = () => resolve();
        }),
    );
    await held.reload();

    calls.length = 0;
    await held.evaluate(() => {
      (window as unknown as { __refuseNextAssertion?: boolean }).__refuseNextAssertion = true;
    });
    await held.getByRole('button', { name: /Continue with Passport/i }).click();
    await expect(held.getByText(/Could not load your passkey/i)).toBeVisible({ timeout: 60_000 });

    await held.getByRole('button', { name: /Create a new passkey/i }).click();

    /* The name step, reached WITHOUT the welcome screen in front of it: the
       welcome is shown only to a Passport that was just created, so arriving
       straight here is the observable difference between "created a second
       passkey" and "signed in to the one that was already there". */
    await expect(held.getByText(/Choose your .night name/i)).toBeVisible({ timeout: 120_000 });
    await expect(held.getByRole('heading', { name: /Welcome to Passport/i })).toHaveCount(0);

    /* The enrolment was attempted, it named the credential this browser holds
       a Passport for, and a discoverable assertion followed it. That sequence
       IS the guard: refused by exclusion, routed into sign-in. */
    expect(calls.map((entry) => entry.kind)).toEqual(['get', 'create', 'get']);
    expect(calls.find((entry) => entry.kind === 'create')?.excluded).toBe(1);

    /* And exactly one Passport in this browser, which is the point. */
    expect((await storedProfileKeys(held)).length).toBe(1);
  } finally {
    await client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }).catch(() => {});
    await context.close();
  }
});

/* -------------------------------------------------------------------------- */
/* THE MID-SESSION DEAD END (reported with a screenshot, 2026/08/31).          */
/*                                                                            */
/* A session restored a stored profile whose credential is not in this        */
/* browser's keychain. On the NAME STEP the user pressed Claim, the targeted  */
/* ceremony went up, and macOS showed its cross-device sheet — "Sign In: Scan */
/* QR Code / Use Security key" — because the passkey lives on their phone.    */
/* When it did not complete, the claim's failure card carried one line of     */
/* text and NO CONTROL AT ALL, on a screen whose header is the wordmark,      */
/* "Last step", and the theme toggle: there is no sign-out on it, so that     */
/* card was the whole of what they had.                                       */
/*                                                                            */
/* Two failures are covered by one offer because WebAuthn refuses to tell     */
/* them apart: the passkey is on a phone and the QR path works — try again —  */
/* or it is gone, and the way on is to leave this session and make a new      */
/* Passport from the landing screen, where that offer already exists and      */
/* already explains itself.                                                   */
/*                                                                            */
/* THE FIXTURE, and why it is not a removed authenticator. Removing it would  */
/* model the failure and then make the recovery untestable: the enrolment at  */
/* the end of the walk needs an authenticator to enrol INTO. So the platform  */
/* decision is made where the platform makes it — one assertion refused with  */
/* the real `NotAllowedError`, armed a call at a time — and everything else,  */
/* including both ceremonies that follow, is real.                            */
/* -------------------------------------------------------------------------- */

test('a claim whose passkey will not answer offers a retry, a way out, and a way back', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const stalled = await context.newPage();
  await installNetworkBoundary(stalled);
  const authenticator = await installVirtualAuthenticator(context, stalled);

  /* Installed before the first navigation, because this walk reloads: the
     sign-out lands on the landing screen through the app's own teardown. */
  await stalled.addInitScript(() => {
    const api = navigator.credentials;
    const get = api.get.bind(api);
    const state = window as unknown as { __prompts: number; __refuseNextAssertion?: boolean };
    state.__prompts = 0;
    api.get = (options?: CredentialRequestOptions) => {
      state.__prompts += 1;
      if (state.__refuseNextAssertion) {
        state.__refuseNextAssertion = false;
        return Promise.reject(
          new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'),
        );
      }
      return get(options);
    };
  });

  const arm = () =>
    stalled.evaluate(() => {
      (window as unknown as { __refuseNextAssertion?: boolean }).__refuseNextAssertion = true;
    });

  try {
    await stalled.goto('/');
    await stalled.getByRole('button', { name: /Continue with Passport/i }).click();
    await expect(stalled.getByRole('heading', { name: /Welcome to Passport/i })).toBeVisible({
      timeout: 120_000,
    });
    await stalled.getByRole('button', { name: 'Choose my name' }).click();
    await expect(stalled.getByText(/Choose your .night name/i)).toBeVisible({ timeout: 60_000 });

    /* A name this run has not asked about, so the claim's own pre-checks run
       and the refusal below is genuinely the ceremony's rather than a gate's. */
    const claimName = 'passportmidsession';
    await stalled.getByLabel('Your Midnight name').fill(claimName);
    await expect(stalled.getByText(`${claimName}.night is available`)).toBeVisible({
      timeout: 30_000,
    });

    await arm();
    await stalled.getByRole('button', { name: new RegExp(`Claim ${claimName}\\.night`) }).click();

    /* The card the screenshot showed — now with something on it. */
    await expect(stalled.getByText(/The claim did not complete/i)).toBeVisible({ timeout: 90_000 });
    await expect(stalled.getByText(/Your passkey could not be used on this device/)).toBeVisible();
    await expect(stalled.getByText(/follow the QR option/)).toBeVisible();
    /* The sentence that answers the fear the second control raises: signing out
       does not take the name or the account with it. */
    await expect(stalled.getByText(/stay on chain/)).toBeVisible();
    await expect(stalled.getByText(/backup file/)).toBeVisible();

    const retry = stalled.getByRole('button', { name: 'Try again' });
    const signOut = stalled.getByRole('button', { name: 'Sign out' });
    await expect(retry).toBeVisible();
    await expect(signOut).toBeVisible();

    /* NOT the onboarding offer. Creating a passkey mid-session derives a new
       seed and therefore a new Passport, which would abandon the name on the
       screen rather than recover it — so this surface must not offer it. */
    await expect(stalled.getByRole('button', { name: /Create a new passkey/i })).toHaveCount(0);
    // And nothing raw from the platform.
    await expect(stalled.getByText(/NotAllowedError|not allowed/i)).toHaveCount(0);

    /* TRY AGAIN RUNS THE CLAIM AGAIN, ceremony included — the case where the
       passkey really is on a phone and the second attempt is the one the user
       completes. One prompt for the claim, one for the retry. */
    expect(await stalled.evaluate(() => (window as unknown as { __prompts: number }).__prompts)).toBe(
      1,
    );
    await arm();
    await retry.click();
    await expect
      .poll(
        () => stalled.evaluate(() => (window as unknown as { __prompts: number }).__prompts),
        { timeout: 90_000 },
      )
      .toBe(2);
    await expect(stalled.getByText(/Your passkey could not be used on this device/)).toBeVisible();

    /* THE WAY OUT, WALKED THE WHOLE WAY. Sign out is the only exit this screen
       has, and it has to lead somewhere: the landing screen, whose keyless
       panel makes the offer this one deliberately does not. */
    await stalled.getByRole('button', { name: 'Sign out' }).click();
    await expect(stalled.getByRole('button', { name: /Continue with Passport/i })).toBeVisible({
      timeout: 60_000,
    });

    await arm();
    await stalled.getByRole('button', { name: /Continue with Passport/i }).click();
    await expect(stalled.getByText(/Could not load your passkey/i)).toBeVisible({ timeout: 90_000 });
    await stalled.getByRole('button', { name: /Create a new passkey/i }).click();

    /* And a working Passport at the end of it. The authenticator still holds
       the credential this browser has a record for, so the enrolment is refused
       by exclusion and the user is signed back into the Passport they had —
       never a fresh one, which is what the absent welcome says.

       That the same Passport comes back is now VISIBLE rather than merely
       implied: since 6ad9bbc the claim abandoned above left the name queued
       rather than dropping it, so what returns is the Passport WITH the name
       its owner picked, offered for another attempt. Before that record
       existed this landed on an empty naming screen, which was the same
       Passport but could not be told apart from a new one. */
    await expect(stalled.getByRole('heading', { name: new RegExp(claimName, 'i') })).toBeVisible({
      timeout: 180_000,
    });
    await expect(stalled.getByRole('heading', { name: /Welcome to Passport/i })).toHaveCount(0);
    const recovered = stalled.locator('.mnid-card').first();
    await expect(recovered).toContainText(`${claimName}.night`);
    await expect(recovered).toContainText(/Queued — not registered yet/i);
    await expect(recovered.getByRole('button', { name: 'Register now' })).toBeVisible();
  } finally {
    await authenticator.remove().catch(() => {});
    await context.close();
  }
});
