/**
 * Tier 2 — the whole thing, against the deployed site and a real stagenet.
 *
 * WHY THIS EXISTS WHEN TIER 1 ALREADY PASSES
 * ------------------------------------------
 * Tier 1 proves what the app SAYS. This proves what it DOES, and the two facts
 * that matter most cannot be established any other way:
 *
 *   1. the `.night` name resolves to the account-custody contract — not to a
 *      wallet address, not to a resolver pointing anywhere else. The only
 *      witness to that is the registry itself, read back after a real
 *      registration; and
 *   2. the account HOLDS the value, and spending is an ACC circuit. A
 *      `withdraw_night` that leaves the balance where it was is a transaction
 *      that did not happen, and nothing short of a real one can tell.
 *
 * It creates a REAL passkey, claims a REAL name, receives a REAL activation
 * grant, and spends REAL stagenet NIGHT. That is why it is tagged `@live` and
 * skipped unless `RUN_LIVE=1`: every run leaves a new account contract and a
 * new name on stagenet, which is fine, and is not something CI should do on
 * every push.
 *
 * WHAT IT ASSERTS ABOUT THE GRANT, AND WHY NOT MORE
 * -------------------------------------------------
 * Activation is NIGHT-only on stagenet as of 2026/08/25: the sponsor deposits
 * 0.002 NIGHT and its stablecoin leg is not landing, which the client reads as
 * a retry rather than a result (see `src/lib/activation.ts`). So the NIGHT is
 * asserted exactly — 0.002, the figure the balancer really deposits — and mUSD
 * is asserted as PRESENT OR PENDING, because a fixed 100 would be a number this
 * test invented about a service that is not currently paying it. When the
 * stablecoin leg lands reliably, that assertion tightens; asserting it now
 * would make a red test mean "the sponsor is behaving as documented".
 *
 * TIMING. Proving is minutes. The account deploy, the resolver deploy, and the
 * registration are three proved transactions, and the grant is a fourth from
 * the sponsor's side. The waits below are generous on purpose: a short timeout
 * here does not find a bug, it finds a prover.
 */

import { expect, test, type Page } from '@playwright/test';

import { installVirtualAuthenticator, uniqueAlias } from './passkey.js';

/** Only runs deliberately. Every run spends stagenet NIGHT and claims a name. */
const live = process.env.RUN_LIVE === '1';

test.describe('@live the account model on stagenet', () => {
  test.skip(!live, 'Set RUN_LIVE=1 to run against https://midnightpassport.com and stagenet.');
  test.describe.configure({ mode: 'serial' });

  /**
   * A stagenet address to withdraw to. It is a real, well-formed recipient and
   * nothing else — the point of the send is that the ACCOUNT's balance drops,
   * so where the NIGHT lands is immaterial as long as the ledger accepts it.
   */
  const RECIPIENT =
    'mn_addr_stagenet127xnp9uuxwhh7a8an77mxv02ypt6u09xkk63c9zvdkjsrj4mj68qg7c5ad';
  /** What the balancer's `/fund-account` really deposits, in NIGHT. */
  const GRANT_NIGHT = '0.002';
  /** Small enough to leave a visible remainder after the send. */
  const SEND_NIGHT = '0.001';

  let page: Page;
  const alias = uniqueAlias('walk');

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
    page = await context.newPage();
    await installVirtualAuthenticator(context, page);
    page.on('console', (message) => {
      if (message.type() === 'error') console.log(`[page] ${message.text().slice(0, 200)}`);
    });
  });

  test.afterAll(async () => {
    await page.context().close();
  });

  test('a passkey creates a Passport and lands on the name step', async () => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Continue with Passport/i })).toBeVisible();
    await page.getByRole('button', { name: /Continue with Passport/i }).click();

    /* The wallet has to open against the real indexer before the step is
       armed, so this is the slowest thing before proving starts. */
    await expect(page.getByText(/Choose your .night name/i)).toBeVisible({ timeout: 5 * 60_000 });
    // The name step is the last step, and it has no way past it.
    await expect(page.getByRole('button', { name: /skip|later|not now/i })).toHaveCount(0);
    console.log(`[live] claiming ${alias}.night`);
  });

  test('the name is free, and claiming it deploys the account and registers', async () => {
    await page.getByLabel('Your Midnight name').fill(alias);
    await expect(page.getByText(`${alias}.night is available`)).toBeVisible({ timeout: 60_000 });

    /* Two attempts, and the second is not papering over a flake. The sponsor
       serialises balancing and RESERVES its DUST for a balanced transaction
       the moment it finalises one, so a claim that arrives while another is in
       flight is genuinely refused — and the app's own answer to that is the
       claim button, still there, still armed. Retrying once is what a user
       would do, and it is the difference between this spec reporting on
       Passport and reporting on the sponsor's calendar. */
    const attempts = 2;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await page.getByRole('button', { name: new RegExp(`Claim ${alias}\\.night`) }).click();

      /* Three proved transactions, narrated. The account contract is deployed
         as part of claiming — it is the ONE transaction this passkey wallet
         originates in its life — and the name is bound to it. Any of the four
         phases proves the ceremony started; which one is showing depends on
         how fast the prover got through the one before it. */
      await expect(
        page.getByRole('button', {
          name: /Deploying your Passport account contract|Deploying your name's resolver|Registering |Waiting for the registry/i,
        }),
      ).toBeVisible({ timeout: 2 * 60_000 });

      /* Then whichever comes first: Home, or the card saying the claim did not
         complete. Raced rather than waited on in sequence, because a refusal
         that arrives in ten seconds should not be found nine minutes later by
         a timeout that says nothing about why. */
      const home = page
        .getByRole('button', { name: /^Receive$/ })
        .waitFor({ state: 'visible', timeout: 9 * 60_000 })
        .then(() => 'home' as const)
        .catch(() => 'timeout' as const);
      const refused = page
        .getByText(/The claim did not complete/i)
        .waitFor({ state: 'visible', timeout: 9 * 60_000 })
        .then(() => 'refused' as const)
        .catch(() => 'timeout' as const);
      const outcome = await Promise.race([home, refused]);

      if (outcome === 'home') break;
      const detail =
        outcome === 'refused'
          ? (await page.locator('.mnid-panel[role="alert"]').innerText()).trim()
          : 'the claim neither completed nor reported a failure inside nine minutes';
      /* The name is never left in a false state: a refused claim keeps the
         name and says so. What is asserted is that the app said which. */
      expect(detail.length, 'a claim that did not complete must say why').toBeGreaterThan(0);
      console.log(`[live] attempt ${attempt} did not complete:\n${detail}`);
      expect(attempt, `the claim did not complete twice:\n${detail}`).toBeLessThan(attempts);
      // Long enough for the sponsor's reservation to clear.
      await page.waitForTimeout(90_000);
    }

    await expect(page.getByRole('button', { name: /^Receive$/ })).toBeVisible();
    await expect(page.getByText(`${alias}.night`).first()).toBeVisible();
    console.log(`[live] ${alias}.night registered`);
  });

  test('the name resolves to the account contract, and Home says the same address', async () => {
    /* The identity card names what the registry points at. This is assertion
       (1) from the header: the name resolves to a CONTRACT, and the contract
       is this Passport's account. */
    const resolvesLine = page.getByText(/Resolves to your Passport account contract \(/);
    await expect(resolvesLine).toBeVisible({ timeout: 2 * 60_000 });
    const resolvesText = (await resolvesLine.innerText()).trim();
    const resolvesTo = elidedAddress(resolvesText);
    expect(resolvesTo, `could not read the contract out of: ${resolvesText}`).not.toBeNull();

    /* And the receiving surface offers that same contract, and only it. Under
       the account model nothing is ever sent to the wallet. */
    await page.getByRole('button', { name: /^Receive$/ }).click();
    const addressRow = page.locator('.mnhome-address');
    await expect(addressRow).toHaveCount(1);
    await expect(addressRow).toContainText('Your account');
    const accountShown = elidedAddress((await addressRow.locator('code').innerText()).trim());
    expect(accountShown, 'the receive row showed no address').not.toBeNull();

    /* The two surfaces elide to different widths — the identity card keeps ten
       characters and six, the receive row nine and seven — so they are
       compared on the overlap rather than as strings. Different windows onto
       the same hash agree on both ends; two different hashes do not. */
    expect(sameElidedAddress(resolvesTo!, accountShown!)).toBe(true);
    console.log(
      `[live] ${alias}.night → account contract ${resolvesTo!.head}…${resolvesTo!.tail}`,
    );

    // Nothing about DUST, and no wallet address anywhere on the surface.
    const text = await page.locator('body').innerText();
    expect(text).not.toMatch(/\bDUST\b/);
    expect(text).not.toMatch(/mn_addr_stagenet1[a-z0-9]{10,}/);
    await page.keyboard.press('Escape');
  });

  test('activation deposits the opening balance into the account', async () => {
    /* The grant is a `deposit_night` into the ACC — never a drip to the wallet
       — and the sponsor is asked on a backoff schedule, so this waits rather
       than polls impatiently. NIGHT is asserted EXACTLY, because 0.002 is what
       the balancer really deposits and a looser assertion would pass on a
       balance that arrived from somewhere else. */
    await expect
      .poll(async () => nightCardValue(page), {
        timeout: 9 * 60_000,
        intervals: [5_000],
        message: 'the activation grant never reached the account',
      })
      .toBe(GRANT_NIGHT);

    /* The stablecoin half: PRESENT OR PENDING, never a fixed figure. Its leg
       has been failing on stagenet, which `classifyFundAccountAnswer` reads as
       a retry rather than a result, so the account can honestly show an mUSD
       card at zero. What is asserted is that Passport says which of the two it
       is — and never that 100 mUSD landed when it did not. */
    const stablecoinCard = page.locator('.mnhome-card', { hasText: /stablecoin/i });
    if ((await stablecoinCard.count()) > 0) {
      const shown = (await stablecoinCard.first().locator('.mnhome-card-value').innerText()).trim();
      // A number the ledger gave, or the card's own honest "not read yet".
      expect(shown).toMatch(/^([0-9]+(\.[0-9]+)?|Syncing|Unavailable)$/);
      console.log(`[live] activation: NIGHT ${GRANT_NIGHT}, mUSD card shows ${shown}`);
    } else {
      const text = await page.locator('body').innerText();
      expect(
        /pending|awaiting|opening balance/i.test(text),
        `no stablecoin card and no pending sentence:\n${text.slice(0, 800)}`,
      ).toBe(true);
      console.log(`[live] activation: NIGHT ${GRANT_NIGHT}, mUSD pending`);
    }

    // And still nothing about DUST or a wallet address anywhere on Home.
    const home = await page.locator('body').innerText();
    expect(home).not.toMatch(/\bDUST\b/);
    expect(home).not.toMatch(/mn_addr_stagenet1[a-z0-9]{10,}/);
  });

  test('sending is an account withdrawal, and the account balance drops', async () => {
    const balanceBefore = await readNightBalance(page);
    expect(balanceBefore).toBeGreaterThan(0);

    /* WAIT FOR THE SPONSOR FIRST, and this is not politeness.
       The activation grant in the previous test is a spend by the SAME
       balancer that covers this send's fee, and it reserves its DUST for a
       balanced transaction the moment it finalises one. A send issued straight
       afterwards is refused — "this wallet holds no DUST of its own", which is
       the wallet's honest answer to a sponsor that has stood down. Measured
       twice on 2026/08/25 before this wait existed. The account model is not
       what fails there; the sponsor's calendar is. */
    await waitForSponsor();

    /* Two attempts, for the same reason the claim has two: another client can
       take the sponsor between the probe above and the submit. */
    const attempts = 2;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await page.getByRole('button', { name: /^Send$/ }).first().click();
      // The recipient is a textarea carrying the network's own address prefix.
      await page.getByPlaceholder(/^mn_addr_stagenet1/).fill(RECIPIENT);
      await page.locator('.mnhome-send-amount input').fill(SEND_NIGHT);

      // The fee sentence names who is expected to pay, never which token it costs.
      expect(await page.locator('body').innerText()).not.toMatch(/dust/i);

      await page.getByRole('button', { name: /^Review$/ }).click();
      const sheet = page.locator('[aria-labelledby="mnhome-send-title"]');
      await expect(sheet).toBeVisible();

      /* One passkey ceremony, then `withdraw_night` proved and submitted. The
         virtual authenticator answers the ceremony; the prover takes minutes. */
      await page.locator('.mnhome-send-actions button.mnhome-send-primary').click();

      /* Whichever the sheet does first. It gets out of the way ONLY when a real
         transaction id came back from the node, so a closed sheet is the
         submission having happened; anything else it can do, it says in words,
         and those words are the failure rather than a bare timeout. */
      const closed = sheet
        .waitFor({ state: 'hidden', timeout: 9 * 60_000 })
        .then(() => 'submitted' as const)
        .catch(() => 'timeout' as const);
      const refused = sheet
        .locator('.mnhome-notice[role="alert"]')
        .waitFor({ state: 'visible', timeout: 9 * 60_000 })
        .then(() => 'refused' as const)
        .catch(() => 'timeout' as const);
      const outcome = await Promise.race([closed, refused]);
      if (outcome === 'submitted') break;

      const said =
        outcome === 'refused'
          ? (await sheet.locator('.mnhome-notice[role="alert"]').innerText()).trim()
          : (await sheet.innerText()).trim();
      /* Nothing was sent, and the sheet says so in words — which is the
         behaviour under test as much as a successful send is. */
      expect(said, 'a send that did not happen must say so').toMatch(/Nothing was sent/i);
      console.log(`[live] send attempt ${attempt} did not submit:\n${said}`);
      expect(attempt, `the send did not submit twice:\n${said}`).toBeLessThan(attempts);
      await page.getByRole('button', { name: /^Close$/ }).click({ timeout: 10_000 }).catch(() => undefined);
      await page.keyboard.press('Escape');
      await waitForSponsor();
    }

    /* The only assertion that proves a withdrawal happened: the ACCOUNT holds
       less than it did. The wallet is not consulted, because under the account
       model it never held any of this. */
    await expect
      .poll(
        async () => {
          /* The card is re-read from the contract on demand — the control is
             on Home for exactly this reason, and a balance that only settles
             after a manual refresh is still a balance the user can get to. */
          await page
            .getByRole('button', { name: /Refresh balances/i })
            .click({ timeout: 10_000 })
            .catch(() => undefined);
          await page.waitForTimeout(2_000);
          return readNightBalance(page);
        },
        {
          timeout: 8 * 60_000,
          intervals: [8_000],
          message: 'the account NIGHT balance did not drop after the withdrawal',
        },
      )
      .toBeLessThan(balanceBefore);
    console.log(`[live] balance fell from ${balanceBefore} after sending ${SEND_NIGHT} NIGHT`);
  });
});

/**
 * Blocks until the fee sponsor reports a wallet that can pay, or gives up.
 *
 * `available > 0` is the same gate `src/lib/sponsor.ts` applies, and for the
 * same reason: a wallet that is merely READY, synced, and holding no DUST
 * cannot sponsor anything. Read straight from the service rather than through
 * the page, because the page's own probe is cached for thirty seconds and this
 * needs the current answer.
 */
async function waitForSponsor(timeoutMs = 6 * 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'never answered';
  while (Date.now() < deadline) {
    try {
      const response = await fetch('https://funder.midnightpassport.com/balancer/wallet-status');
      const body = (await response.json()) as { available?: unknown; total?: unknown };
      last = `available ${String(body.available)}/${String(body.total)}`;
      if (typeof body.available === 'number' && body.available > 0) return;
    } catch (cause) {
      last = cause instanceof Error ? cause.message : String(cause);
    }
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  /* Not a failure of its own: the send below will be refused in the sponsor's
     own words, which is a better message than this function could write. */
  console.log(`[live] the fee sponsor never reported a payer (${last}); sending anyway`);
}

/** The two halves of a middle-elided address, however wide the elision. */
interface ElidedAddress {
  head: string;
  tail: string;
}

/** Reads `abcdef1234…567890` or `abcdef123...4567890` out of a rendered line. */
function elidedAddress(text: string): ElidedAddress | null {
  const match = /([0-9a-f]{6,})(?:…|\.\.\.)([0-9a-f]{5,})/i.exec(text);
  return match ? { head: match[1] as string, tail: match[2] as string } : null;
}

/** Whether two elisions are windows onto the same hash. */
function sameElidedAddress(left: ElidedAddress, right: ElidedAddress): boolean {
  const headsAgree = left.head.startsWith(right.head) || right.head.startsWith(left.head);
  const tailsAgree = left.tail.endsWith(right.tail) || right.tail.endsWith(left.tail);
  return headsAgree && tailsAgree;
}

/**
 * The account's NIGHT balance as Home shows it, as a number.
 *
 * Read off the rendered card rather than out of the contract, deliberately: a
 * balance the user cannot see is not a balance this demo has delivered, and
 * reading the ledger directly would let the screen be wrong while the test
 * passed. `NaN` while the card says "Syncing" or "Unavailable", which is what
 * makes `expect.poll` wait rather than conclude.
 */
async function nightCardValue(page: Page): Promise<string> {
  const card = page.locator('.mnhome-card', { hasText: 'native token' }).first();
  if ((await card.count()) === 0) return '';
  return (await card.locator('.mnhome-card-value').innerText()).trim();
}

async function readNightBalance(page: Page): Promise<number> {
  const card = page.locator('.mnhome-card', { hasText: 'native token' }).first();
  if ((await card.count()) === 0) return Number.NaN;
  const shown = (await card.locator('.mnhome-card-value').innerText()).trim();
  return Number.parseFloat(shown);
}
