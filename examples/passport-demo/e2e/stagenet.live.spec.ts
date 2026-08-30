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
  /**
   * The shielded recipient, and why it is this one.
   *
   * A shielded withdrawal cannot be pointed at a Passport: the receive surface
   * offers the account CONTRACT and nothing else, so a second freshly-onboarded
   * Passport has no `mn_shield-addr…` to publish. Nor does the sponsor publish
   * one — `/balancer/status` and `/balancer/wallet-status` carry its unshielded
   * address alone.
   *
   * So this is the fee sponsor's OWN shielded address, derived on the balancer
   * host from the seed the service already holds — HD account 0, role Zswap,
   * index 0, the same derivation `passport-balancer/src/wallet.ts` uses — by a
   * script that printed the address and nothing else. It is therefore a real
   * third party that genuinely controls what lands: the 10 mUSD goes back to
   * the service that granted the 100, rather than to an address nobody holds
   * the keys to.
   *
   * It is checked here rather than trusted: `decodeShieldedRecipient` in
   * `src/identity/accountCustody.ts` and `classifyRecipient` in
   * `src/screens/SendSheet.tsx` both run it through the wallet SDK's own
   * `ShieldedAddress` codec, and the sheet's title turning into "Send a
   * shielded token" is that codec having accepted it.
   */
  const SHIELDED_RECIPIENT =
    'mn_shield-addr_stagenet1vgzgswr3hh63g4kjgymcupyugl9jy75j9w73kr4dr6m0crkrxgrvmmq4969xqusmk8q3wrlsej3p7ev8r4jl9g4fnxg5dqewc9dw5ns5e03lu';
  /** What the balancer's `/fund-account` really deposits, in NIGHT. */
  const GRANT_NIGHT = '0.002';
  /** Small enough to leave a visible remainder after the send. */
  const SEND_NIGHT = '0.001';
  /**
   * The stablecoin half of the same grant, in the units the LEDGER keeps it in.
   *
   * A shielded colour is minted by a contract and carries no decimal scale on
   * chain, so this is a whole count and not a scaled figure — which is why the
   * card, the Send sheet, and this constant all spell it the same way. `100` is
   * the sponsor's own published `assetGrant`.
   */
  const GRANT_MUSD = '100';
  /** Ten units out, ninety left — a remainder the card can be read against. */
  const SEND_MUSD = '10';
  const REMAINING_MUSD = '90';

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

    /* A brand-new Passport is welcomed before it is asked for a name — the
       screen added on 2026/08/30. One control; the reading is the price. */
    await expect(page.getByRole('heading', { name: /Welcome to Passport/i })).toBeVisible({
      timeout: 5 * 60_000,
    });
    await page.getByRole('button', { name: /Choose my name/i }).click();

    /* The wallet has to open against the real indexer before the step is
       armed, so this is the slowest thing before proving starts. */
    await expect(page.getByText(/Choose your .night name/i)).toBeVisible({ timeout: 5 * 60_000 });
    // The NAME step is the last step, and it has no way past it. (The welcome
    // above has a Skip; the name step must not.)
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
          name: /Checking .* is still free|Preparing your Passport|Confirm with your passkey|Setting up your account|Deploying your Passport account contract|Deploying your name's resolver|Registering |Waiting for the registry/i,
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
    /* Since the 2026/08/30 sweep the identity card deliberately shows no
       address — it says where the name leads in words. So assertion (1) from
       the header is made against the chain itself, through the verifier: the
       registry's decoded answer for this name must be the account whose
       address the Receive sheet offers. */
    await expect(
      page.getByText(/People sending to this name reach your account/i),
    ).toBeVisible({ timeout: 2 * 60_000 });

    /* The receiving surface offers the account, and only it. Under the
       account model nothing is ever sent to the wallet. */
    await page.getByRole('button', { name: /^Receive$/ }).click();
    const addressRow = page.locator('.mnhome-address');
    await expect(addressRow).toHaveCount(1);
    await expect(addressRow).toContainText('Your account');
    const accountShown = elidedAddress((await addressRow.locator('code').innerText()).trim());
    expect(accountShown, 'the receive row showed no address').not.toBeNull();
    await page.keyboard.press('Escape');

    /* The chain's own answer, decoded by the verifier from the registry and
       resolver state. The full account address appears there — an operator
       surface — and must be the address Receive elides. */
    const verifier = await page.context().newPage();
    await verifier.goto(`https://midnightpassport.com/verify/?q=${alias}.night`);
    await expect(verifier.getByText(/register_domain_for/)).toBeVisible({ timeout: 90_000 });
    const verifierText = await verifier.locator('body').innerText();
    const full = verifierText.match(/[0-9a-f]{64}/);
    expect(full, 'the verifier reported no account address').not.toBeNull();
    await verifier.close();
    const resolved = { head: full![0].slice(0, 10), tail: full![0].slice(-6) };
    expect(sameElidedAddress(resolved, accountShown!)).toBe(true);
    console.log(`[live] ${alias}.night → account contract ${resolved.head}…${resolved.tail}`);
    await page.getByRole('button', { name: /^Receive$/ }).click();

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
      await page.getByPlaceholder(/alice\.night|^mn_addr_stagenet1/).fill(RECIPIENT);
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

  /**
   * The shielded leg, and the one assertion the NIGHT send cannot make.
   *
   * `withdraw_night` and `withdraw_shielded` are different circuits over
   * different maps — the contract keeps unshielded NIGHT and shielded colours
   * apart, and midnight-js has to build the recipient's note ciphertext
   * client-side from an encryption key only a full `mn_shield-addr…` carries.
   * None of that is exercised by the NIGHT path, so a green NIGHT send says
   * nothing about whether a shielded one works.
   *
   * It runs LAST rather than straight after activation, and deliberately: the
   * stablecoin leg is a second deposit on the sponsor's own backoff schedule
   * (`FUND_ACCOUNT_RETRY_DELAYS_MS`, ~ten minutes of patience), so it can land
   * minutes after the NIGHT half the activation test already saw. Waiting for
   * it here costs nothing the earlier tests were not already spending.
   *
   * Two witnesses, because either alone would be weak. The CARD says the
   * account holds ten fewer — which is what a user can see — and the INDEXER
   * says a `withdraw_shielded` action now exists on this contract, which is
   * what makes the drop a withdrawal rather than a re-read.
   */
  test('a shielded withdrawal pays mUSD out of the account, and the chain records withdraw_shielded', async () => {
    /* THE ADDRESS THE REST OF THIS TEST IS ABOUT.
       Home only ever shows the account contract elided — nine characters and
       seven — and the indexer query below needs all sixty-four. So the whole
       address is read out of the record the deployment wrote, and then CHECKED
       against what the receive row shows: querying an address the screen never
       named would prove something about a different contract. */
    const account = await storedAccountContract(page);
    await page.getByRole('button', { name: /^Receive$/ }).click();
    const shown = elidedAddress((await page.locator('.mnhome-address code').innerText()).trim());
    expect(shown, 'the receive row showed no address').not.toBeNull();
    expect(
      account.startsWith(shown!.head) && account.endsWith(shown!.tail),
      `the stored account ${account} is not the one the receive row shows`,
    ).toBe(true);
    await page.keyboard.press('Escape');
    const rawAccount = account.trim().toLowerCase().replace(/^0x/, '').replace(/^0200/, '');
    expect(rawAccount, 'the stored account is not a 64-hex contract address').toMatch(
      /^[0-9a-f]{64}$/,
    );
    console.log(`[live] account contract ${rawAccount}`);

    /* THE GRANT HAS TO HAVE LANDED FIRST — 100 mUSD, exactly, because that is
       the figure the sponsor publishes as `assetGrant` and this send is quoted
       against it. Refreshed while it waits: the card is re-read from the
       contract on demand, which is why the control is on Home at all. */
    await expect
      .poll(async () => refreshedStablecoinValue(page), {
        timeout: 12 * 60_000,
        intervals: [10_000],
        message:
          'the mUSD activation grant never reached the account — check GET https://67-205-177-162.sslip.io/balancer/status for assetFunding and assetUnavailableReason',
      })
      .toBe(GRANT_MUSD);
    console.log(`[live] activation stablecoin: ${GRANT_MUSD} mUSD in the account`);

    /* The same wait the NIGHT send makes, for the same reason: one service
       covers both the grant above and this send's fee, and it reserves its DUST
       for a balanced transaction the moment it finalises one. */
    await waitForSponsor();
    /* The colour the sponsor named, so a Passport that happens to hold more
       than one shielded token still sends the stablecoin rather than whichever
       colour sorted first. `null` when the service cannot be read — the sheet
       then keeps its own default and the balance assertions still decide. */
    const colour = await sponsorStablecoinColour();

    const attempts = 2;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await page.getByRole('button', { name: /^Send$/ }).first().click();
      /* Choosing mUSD over NIGHT is not a control on this sheet — it is the
         ADDRESS. The recipient field is the same textarea the NIGHT send uses,
         carrying the network's unshielded prefix as its placeholder, and what
         decides the ledger is the wallet SDK's codec reading what was pasted
         into it. The title changing is that codec having said "shielded". */
      await page.getByPlaceholder(/alice\.night|^mn_addr_stagenet1/).fill(SHIELDED_RECIPIENT);
      await expect(page.locator('#mnhome-send-title')).toHaveText('Send a shielded token');

      /* The account's own colours, read from the contract when a shielded
         recipient first turns up. This line appearing IS that read having
         returned something — an account holding nothing shielded says so
         instead, and takes the Send control with it. */
      await expect(page.getByText(/units of this token available/)).toBeVisible({
        timeout: 3 * 60_000,
      });
      const tokenSelect = page.locator('.mnhome-send-form select');
      if (colour !== null && (await tokenSelect.count()) > 0) {
        await tokenSelect.selectOption(colour);
      }
      await expect(page.getByText(`${GRANT_MUSD} units of this token available`)).toBeVisible();

      await page.locator('.mnhome-send-amount input').fill(SEND_MUSD);
      // Whole units, not NIGHT: the unit beside the field says which ledger.
      await expect(page.locator('.mnhome-send-unit')).toHaveText('units');
      // The fee sentence still names who pays, never which token it costs.
      expect(await page.locator('body').innerText()).not.toMatch(/dust/i);

      await page.getByRole('button', { name: /^Review$/ }).click();
      const sheet = page.locator('[aria-labelledby="mnhome-send-title"]');
      await expect(sheet).toBeVisible();
      await expect(sheet.getByText(`${SEND_MUSD} units`)).toBeVisible();

      /* Armed BEFORE the submit. The success toast lives twelve seconds and is
         pushed on the same tick the sheet closes, so a wait started afterwards
         would be racing its own dismissal. */
      const announced = page
        .locator('.mntoast-success .mntoast-title')
        .filter({ hasText: /Shielded transfer accepted/i })
        .waitFor({ state: 'visible', timeout: 9 * 60_000 })
        .then(() => true)
        .catch(() => false);

      /* One passkey ceremony, then `withdraw_shielded` proved and submitted. */
      await page.locator('.mnhome-send-actions button.mnhome-send-primary').click();

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

      if (outcome === 'submitted') {
        /* The sheet gets out of the way only on a real transaction id, and the
           toast is the host saying the same thing in words. Both, so a sheet
           that closed for any other reason cannot pass for a send. */
        expect(
          await announced,
          'the sheet closed but nothing reported a shielded transfer',
        ).toBe(true);
        break;
      }

      const said =
        outcome === 'refused'
          ? (await sheet.locator('.mnhome-notice[role="alert"]').innerText()).trim()
          : (await sheet.innerText()).trim();
      /* Nothing moved, and the sheet says so in the shielded path's own words. */
      expect(said, 'a shielded send that did not happen must say so').toMatch(
        /Nothing was sent/i,
      );
      console.log(`[live] shielded send attempt ${attempt} did not submit:\n${said}`);
      expect(attempt, `the shielded send did not submit twice:\n${said}`).toBeLessThan(attempts);
      await page
        .getByRole('button', { name: /^Close$/ })
        .click({ timeout: 10_000 })
        .catch(() => undefined);
      await page.keyboard.press('Escape');
      await waitForSponsor();
    }

    /* WITNESS ONE: the account holds ten fewer, on the surface the user reads. */
    await expect
      .poll(async () => refreshedStablecoinValue(page), {
        timeout: 8 * 60_000,
        intervals: [8_000],
        message: 'the account mUSD balance did not fall after the shielded withdrawal',
      })
      .toBe(REMAINING_MUSD);
    console.log(
      `[live] mUSD fell from ${GRANT_MUSD} to ${REMAINING_MUSD} after sending ${SEND_MUSD} units`,
    );

    /* WITNESS TWO: the ledger names the circuit. A balance that fell is a
       withdrawal only if the chain recorded one, and `withdraw_shielded` is the
       entry point that moves a shielded colour out of the account — no other
       call on this contract could have done it. Polled, because the indexer
       trails the node by a block or two. */
    const withdrawal = await waitForContractCall(rawAccount, 'withdraw_shielded');
    expect(
      withdrawal,
      `the account's mUSD fell but the indexer records no withdraw_shielded on ${rawAccount}`,
    ).not.toBeNull();
    console.log(
      `[live] withdraw_shielded on ${rawAccount} — tx ${withdrawal!.transaction.hash} in block ${
        withdrawal!.transaction.block.height
      }`,
    );
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
      const response = await fetch('https://67-205-177-162.sslip.io/balancer/wallet-status');
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

/**
 * The stablecoin card's figure, after asking Home to re-read the contract.
 *
 * Read off the rendered card for the same reason {@link nightCardValue} is: a
 * balance the user cannot see is not a balance this demo has delivered. The
 * refresh is part of the read because the account's balances are pulled on
 * demand, and a click on a control that is momentarily gone is not a failure
 * worth ending a poll over.
 */
async function refreshedStablecoinValue(page: Page): Promise<string> {
  await page
    .getByRole('button', { name: /Refresh balances/i })
    .click({ timeout: 10_000 })
    .catch(() => undefined);
  await page.waitForTimeout(2_000);
  const card = page.locator('.mnhome-card', { hasText: /stablecoin/i }).first();
  if ((await card.count()) === 0) return '';
  return (await card.locator('.mnhome-card-value').innerText()).trim();
}

/**
 * This Passport's account contract, whole, from the record the deployment
 * wrote — `passport-contract:v1`, the same store `App.tsx` reads to decide
 * which contract every send is made against.
 *
 * Home never renders the untruncated address, and the indexer needs all of it.
 * The caller checks this against what the receive row shows rather than
 * trusting the store, so nothing here can quietly point the chain query at a
 * contract the screen never named.
 */
async function storedAccountContract(page: Page): Promise<string> {
  const raw = await page.evaluate(() => window.localStorage.getItem('passport-contract:v1'));
  expect(raw, 'this browser holds no Passport contract record').not.toBeNull();
  const records = JSON.parse(raw as string) as Record<
    string,
    { network?: string; status?: string; address?: string }
  >;
  const deployed = Object.values(records).find(
    (record) =>
      record.status === 'deployed' &&
      record.network === 'stagenet' &&
      typeof record.address === 'string' &&
      record.address.length > 0,
  );
  expect(deployed, 'no deployed stagenet account contract in this browser').toBeDefined();
  return (deployed as { address: string }).address;
}

/**
 * The shielded colour the fee sponsor grants, as it publishes it.
 *
 * Read from the service rather than written down here: the colour is minted by
 * whichever asset contract the balancer is pointed at, and a constant would go
 * stale the day that changes. `null` when the service cannot be read — the
 * sheet then keeps whichever colour it chose, and the balance assertions still
 * decide whether the right one moved.
 */
async function sponsorStablecoinColour(): Promise<string | null> {
  try {
    const response = await fetch('https://funder.midnightpassport.com/balancer/status');
    const body = (await response.json()) as { assetColourHex?: unknown };
    return typeof body.assetColourHex === 'string' && body.assetColourHex ? body.assetColourHex : null;
  } catch {
    return null;
  }
}

/** One action the indexer records against a contract. */
interface ContractCallAction {
  __typename: string;
  entryPoint?: string;
  transaction: { hash: string; block: { height: number } };
}

/** The stagenet indexer the deployed site is built against. */
const INDEXER_URL = 'https://indexer.stagenet.shielded.tools/api/v4/graphql';

/**
 * Waits for the indexer to record a named entry point on a contract.
 *
 * This is the ledger's own account of what happened, and it is the difference
 * between "the card shows less" and "a withdrawal was proved, submitted, and
 * included". Polled rather than asked once: the indexer trails the node, and a
 * single query the moment the sheet closed would routinely find nothing.
 *
 * `null` when the deadline passes, with the last thing the indexer said logged
 * — the caller turns that into the failure, because a bare timeout here would
 * say nothing about whether the contract was reachable at all.
 */
async function waitForContractCall(
  address: string,
  entryPoint: string,
  timeoutMs = 6 * 60_000,
): Promise<ContractCallAction | null> {
  const query = `{ contract(address:"${address}") { actions { __typename ... on ContractCall { entryPoint } transaction { hash block { height } } } } }`;
  const deadline = Date.now() + timeoutMs;
  let last = 'the indexer was never asked';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(INDEXER_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const body = (await response.json()) as {
        data?: { contract?: { actions?: ContractCallAction[] } | null } | null;
        errors?: unknown;
      };
      const actions = body.data?.contract?.actions ?? [];
      const match = actions.find(
        (action) => action.__typename === 'ContractCall' && action.entryPoint === entryPoint,
      );
      if (match) return match;
      const named = actions
        .map((action) => action.entryPoint ?? action.__typename)
        .join(', ');
      last = body.errors
        ? `the indexer answered with errors: ${JSON.stringify(body.errors).slice(0, 300)}`
        : `${actions.length} action(s) on the contract [${named}], none of them ${entryPoint}`;
    } catch (cause) {
      last = cause instanceof Error ? cause.message : String(cause);
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  console.log(`[live] the indexer never reported ${entryPoint}: ${last}`);
  return null;
}

async function readNightBalance(page: Page): Promise<number> {
  const card = page.locator('.mnhome-card', { hasText: 'native token' }).first();
  if ((await card.count()) === 0) return Number.NaN;
  const shown = (await card.locator('.mnhome-card-value').innerText()).trim();
  return Number.parseFloat(shown);
}
