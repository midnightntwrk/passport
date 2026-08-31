/**
 * A claim you can follow: the estimate, the clock, and the four states of the
 * long wait.
 *
 * "Instead of three steps, I want to see that you're deploying the contract and
 * other things, with a timer — this is how much it is supposed to take, and
 * it's almost done — so I'm more in touch with the progress" (2026/08/31). The
 * three steps said WHERE a claim was and nothing about how long, and a wait
 * with no measure against it is indistinguishable from a hang after about
 * twenty seconds — which is the same complaint, one screen further on, as the
 * 2026/08/26 one that produced the stepper in the first place.
 *
 * WHAT IS DRILLED WHERE
 * ---------------------
 * The rule and the copy are pure and are drilled in `src/lib/claimSteps.test.ts`
 * — which phase is which step, which four sub-states the long step is made of,
 * how a duration is written, and the three sentences the timing line can be.
 * None of that needs a browser.
 *
 * What needs a browser is that the SHIPPED SCREEN counts. A timer is the one
 * thing a static assertion cannot establish: a number rendered once from
 * `Date.now()` passes every test about its format and is exactly the hang it
 * was built to disprove. So every assertion here is made TWICE, seconds apart,
 * on a claim that is genuinely stuck — and what is asserted is that the number
 * moved while the phase did not.
 *
 * HOW A TIER-1 RUN REACHES THE LONG STEP
 * --------------------------------------
 * It cannot complete a claim: the account step is two proved transactions,
 * ~32 MB of circuit keys and a prover, and `stagenet.live.spec.ts` is where a
 * real one runs. But it can genuinely ENTER it. The claim's own gates — the
 * registry re-check, the sponsor's answer, the passkey ceremony — all pass
 * against the recorded boundary and a virtual authenticator, and the deploy
 * behind the third step then asks for its circuit keys over HTTP. Holding that
 * one request open leaves the app in exactly the state a slow prover leaves it
 * in: the third step running, its first sub-state live, and nothing else moving
 * but the clock. Nothing is stubbed to arrange it.
 */

import { expect, test, type Page } from '@playwright/test';

import { installNetworkBoundary, type NetworkBoundary } from './mocks.js';
import { installVirtualAuthenticator } from './passkey.js';

test.describe.configure({ mode: 'serial' });

let page: Page;
let network: NetworkBoundary;

/** A label that is free in the recorded registry snapshot. */
const NAME = 'claimclock';

/** `m:ss` off the screen, as a number of seconds. */
function seconds(line: string): number {
  const match = /(\d+):(\d{2})/.exec(line);
  if (!match) throw new Error(`No clock in ${JSON.stringify(line)}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  page = await context.newPage();
  network = await installNetworkBoundary(page);

  /* THE PROVER, HELD OPEN. The account deploy fetches its circuit keys from
     `/zk/<contract>` before it can build a transaction. This route is never
     fulfilled and never aborted, so the request simply stays in flight — which
     is what a prover taking its minutes looks like from the app's side, and it
     costs the test no CPU at all. */
  await page.route('**/zk/**', () => {
    /* Deliberately empty: the request hangs for the life of the context. */
  });

  await installVirtualAuthenticator(context, page);
});

test.afterAll(async () => {
  await page.context().close();
});

test('the first step says what it usually costs, and counts the seconds it really costs', async () => {
  await page.goto('/');
  await page.getByRole('button', { name: /Continue with Passport/i }).click();
  await expect(page.getByRole('heading', { name: /Welcome to Passport/i })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole('button', { name: 'Choose my name' }).click();
  await expect(page.getByText(/Choose your .night name/i)).toBeVisible({ timeout: 60_000 });

  await page.getByLabel('Your Midnight name').fill(NAME);
  await expect(page.getByText(`${NAME}.night is available`)).toBeVisible({ timeout: 30_000 });

  /* Past `identity/claimWarmup.ts`'s ten-second window, so the claim asks the
     registry for itself and the first step has a real wait behind it rather
     than an answer already in hand. Twelve seconds of that wait is the
     registry's, which is long enough to watch a clock cross two seconds. */
  await page.waitForTimeout(11_000);
  network.setRegistryDelay(12_000);
  await page.getByRole('button', { name: new RegExp(`Claim ${NAME}\\.night`) }).click();

  const steps = page.locator('.mnid-stepper-item');
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).toHaveAttribute('data-state', 'active');

  /* THE ESTIMATE, HEDGED. "Usually about" is the whole honesty mechanism: the
     ten seconds is a measurement of a healthy network, not a promise, and the
     line says so in the same breath as it gives the number. */
  const timing = steps.nth(0).locator('.mnid-stepper-timing');
  await expect(timing).toHaveText(/Usually about 10 seconds — \d+:\d{2} so far/);

  // AND IT MOVES. Read twice, four seconds apart, on an unchanged step.
  const first = seconds(await timing.innerText());
  await page.waitForTimeout(4_000);
  await expect(steps.nth(0)).toHaveAttribute('data-state', 'active');
  const later = seconds(await timing.innerText());
  expect(later).toBeGreaterThan(first);
  expect(later - first).toBeGreaterThanOrEqual(3);

  /* No percentage, anywhere. There is no quantity to take a percentage OF — a
     proof either lands or it does not — so a bar filling to 60% would be a
     number nobody measured, and inventing one is how a progress view starts
     lying. */
  await expect(page.locator('.mnid-panel').first()).not.toContainText('%');

  network.setRegistryDelay(0);
});

test('the four states of the long wait are on screen before the wait, all still ahead', async () => {
  /* THE SHAPE RULE, INSIDE THE STEP. The stepper's three circles fill in and
     never appear; so do the four rows beneath the third one. A row that arrived
     mid-wait would reflow the panel under somebody who is already reading it,
     and the whole point of this view is that the reader can trust it to sit
     still while the network does not. */
  const account = page.locator('.mnid-stepper-item').nth(2);
  await expect(account).toHaveAttribute('data-state', 'todo');

  const stages = account.locator('.mnid-substage');
  await expect(stages).toHaveCount(4);
  await expect(stages.nth(0)).toContainText('Creating your account');
  await expect(stages.nth(1)).toContainText('Setting your name up');
  await expect(stages.nth(2)).toContainText(`Registering ${NAME}.night`);
  await expect(stages.nth(3)).toContainText('Confirming your name');
  for (const index of [0, 1, 2, 3]) {
    await expect(stages.nth(index)).toHaveAttribute('data-state', 'todo');
  }

  /* And the warning about the minutes is still up FRONT, on the step that
     costs them, rather than arriving once the reader is already inside the
     wait — which is what was asked for on 2026/08/26 and is not replaced by
     the estimate, only joined by it. */
  await expect(account).toContainText('Your Passport is on its way. This part takes a few minutes.');
});

test('the long step runs, names the state it is in, and goes on counting while nothing moves', async () => {
  /* The claim from the first test is still running: the registry has answered,
     the sponsor has answered, the passkey ceremony has been performed by the
     virtual authenticator, and the account deploy is now waiting on circuit
     keys that will never arrive. That is a genuinely stuck claim, and it is the
     state this whole ask is about. */
  const account = page.locator('.mnid-stepper-item').nth(2);
  await expect(account).toHaveAttribute('data-state', 'active', { timeout: 90_000 });

  // The two steps behind it are ticked, and each says what it actually took.
  const steps = page.locator('.mnid-stepper-item');
  await expect(steps.nth(0)).toHaveAttribute('data-state', 'done');
  await expect(steps.nth(1)).toHaveAttribute('data-state', 'done');
  await expect(steps.nth(0).locator('.mnid-stepper-timing')).toHaveText(/Took \d+:\d{2}/);

  /* THE ONE THAT IS RUNNING, NAMED. Two minutes of a single unchanging
     sentence under a step already labelled "Setting up your account" was the
     whole of what the third step used to tell you. */
  const stages = account.locator('.mnid-substage');
  await expect(stages.nth(0)).toHaveAttribute('data-state', 'active');
  await expect(stages.nth(0)).toContainText('Creating your account');
  for (const index of [1, 2, 3]) {
    await expect(stages.nth(index)).toHaveAttribute('data-state', 'todo');
  }

  /* AND THE CLOCK KEEPS COUNTING ON AN UNCHANGED PHASE. This is the exact
     defect the ask revisits: a sponsor queue or a slow prover holds one phase
     for minutes, and a view that only redraws on a phase change looks hung.
     Nothing here changes between the two reads except the number. */
  const timing = account.locator('.mnid-stepper-timing');
  await expect(timing).toHaveText(/Usually about 2 minutes — \d+:\d{2} so far/);
  const first = seconds(await timing.innerText());
  await page.waitForTimeout(5_000);
  await expect(stages.nth(0)).toHaveAttribute('data-state', 'active');
  const later = seconds(await timing.innerText());
  expect(later - first).toBeGreaterThanOrEqual(4);

  /* THE BUTTON NAMES THE STEP, and says it once. It is not a second progress
     indicator over a view whose whole job is to be one. */
  await expect(page.getByRole('button', { name: 'Setting up your account' })).toBeDisabled();
});

test('nothing the ceremony says names the machinery behind it', async () => {
  /* Constraint (b), on the screen where it is hardest to keep: everything the
     third step is really doing is a contract, a resolver leaf, and a registry
     write, and the reader is owed the thing those are FOR. Swept over the whole
     screen while the claim is mid-ceremony, so the stepper, the sub-states, the
     timing lines, and the button are all in it. */
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/\bcontract\b/i);
  expect(text).not.toMatch(/\bresolver\b/i);
  expect(text).not.toMatch(/\bregistry\b/i);
  expect(text).not.toMatch(/\bindexer\b/i);
  expect(text).not.toMatch(/\bwallet\b/i);
  expect(text).not.toMatch(/\bDUST\b/);
  // Nor any address: the one address a sender needs lives in Receive, alone.
  expect(text).not.toMatch(/mn_addr|mn_shield/);
  expect(text).not.toMatch(/[0-9a-f]{64}/i);

  /* And the panel still reads as a claim in progress rather than as a failure,
     so the sweep above was made over the state this file exists to describe. */
  await expect(page.locator('.mnid-stepper-item').nth(2)).toHaveAttribute('data-state', 'active');
});
