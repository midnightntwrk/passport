/**
 * Asset-first Send, in a real browser.
 *
 * "I want to be able to select the assets I want to send. Right now I can only
 * send NIGHT. I want to be able to send mUSD, and any other asset I have going
 * forward" (2026/08/31). Until that day the sheet inferred what was being sent
 * from the address it was going to: `mn_addr…` meant NIGHT, `mn_shield-addr…`
 * meant whatever shielded colour happened to sort first, and the person sending
 * never chose. The asset is now the FIRST field, and it is what decides which
 * recipients the field below will take.
 *
 * WHAT IS DRILLED WHERE
 * ---------------------
 * The RULES are pure and live in `src/lib/sendAssets.ts`: which assets the
 * picker offers, the order they come in, that an item arrives capped at one,
 * and the exact sentence each mismatch earns. Those are drilled directly, on
 * every branch, in `src/lib/sendAssets.test.ts`.
 *
 * What is left is the INVERSION itself, and only a browser can answer it: that
 * the asset really is the first control on the sheet, that choosing one really
 * re-quotes the amount and re-writes the hint under the recipient, and — the
 * defect this whole unit exists to prevent — that pasting an address for the
 * wrong ledger REFUSES in the asset's own name instead of silently switching
 * the asset to suit the address. A silent switch is a wrong send: the field
 * that changed is not the field that was touched.
 *
 * WHAT IS NOT PROVED HERE, AND WHY
 * --------------------------------
 * A shielded send that completes. The mocked tier has no prover and no chain to
 * take a transaction; a real one is `stagenet.live.spec.ts`'s job. This file
 * goes as far as the browser honestly can — the asset chosen, the recipient
 * accepted, and Review reached — and stops at the button.
 *
 * An item in the picker, for the same reason `assets.spec.ts` records: the
 * account this tier replays is a REAL stagenet account and holds no colour in
 * single supply, and minting one would mean minting a contract state this
 * workspace's Node graph cannot mint.
 */

import { expect, test, type Page } from '@playwright/test';

import {
  installNetworkBoundary,
  PASSPORT_ACCOUNT_ADDRESS,
  RECIPIENT_ACCOUNT_ADDRESS,
  RESOLVABLE_NAME,
} from './mocks.js';
import { installVirtualAuthenticator } from './passkey.js';

test.describe.configure({ mode: 'serial' });

let page: Page;

/** A label that is free in the recorded registry snapshot. */
const NAME = 'sendwalk';

/**
 * An unshielded stagenet address — the shape a NIGHT send takes, and the wrong
 * shape for a shielded asset. The same one `onboarding.spec.ts` pastes.
 */
const UNSHIELDED =
  'mn_addr_stagenet127xnp9uuxwhh7a8an77mxv02ypt6u09xkk63c9zvdkjsrj4mj68qg7c5ad';

/**
 * A shielded stagenet address, built with the wallet SDK's own codec from a
 * coin key of `11…` and an encryption key of `22…` — so it is a real bech32m
 * string that the sheet's own validator decodes, rather than a hand-typed
 * approximation of one. Nothing is ever sent to it.
 */
const SHIELDED =
  'mn_shield-addr_stagenet1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygjyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs74ltnl';

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  page = await context.newPage();
  await installNetworkBoundary(page);
  await installVirtualAuthenticator(context, page);

  /* A Passport that already exists — the state this sheet is used in. The
     ceremony itself is drilled by `onboarding.spec.ts`. */
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
  /* The account's ledger is read after the screen is on. Waited for here rather
     than in each test: every assertion below is about a picker built from it. */
  await expect(page.locator('.mnhome-assets')).toContainText(/mUSD/i, { timeout: 60_000 });

  await page.getByRole('button', { name: /^Send$/ }).first().click();
  await expect(page.locator('.mnhome-send')).toBeVisible();
});

test.afterAll(async () => {
  await page.context().close();
});

/** The asset picker. A `select`, so it is the sheet's only combobox. */
function picker() {
  return page.locator('.mnhome-send-asset');
}

/** The recipient field, which is the sheet's first textbox. */
function recipient() {
  return page.getByRole('textbox').first();
}

/**
 * Chooses the one shielded asset this account holds.
 *
 * By INDEX rather than by label, and that is the honest way round: the option's
 * text carries the balance beside the ticker, so matching on a label would be
 * matching on a figure that moves. The list's order is `sortTokenHoldings`', and
 * it is drilled where it is decided, in `src/lib/sendAssets.test.ts`.
 */
async function chooseShielded(): Promise<void> {
  await picker().selectOption({ index: 1 });
}

/** The refusal under the recipient field, when there is one. */
function refusal() {
  return page.locator('#mnhome-send-recipient-error');
}

test('the asset is the first field, and the sheet opens on NIGHT', async () => {
  /* FIRST. Not "present somewhere" — the order is the whole point of the
     inversion: what is being sent is decided before where it is going. */
  const firstLabel = await page.locator('.mnhome-send-form > * >> nth=0').innerText();
  expect(firstLabel).toMatch(/^ASSET/i);

  await expect(page.getByText('Send NIGHT', { exact: true })).toBeVisible();
  await expect(picker()).toHaveValue('night');

  /* Two options, from what this account really holds: 0.002 NIGHT and 100 of a
     stablecoin colour, both recorded from stagenet. The sponsor's own colour
     sits at a real zero on Home and is NOT offered — an asset with none of it
     in the account is not a thing to send. */
  const options = await picker().locator('option').allInnerTexts();
  expect(options).toHaveLength(2);
  expect(options[0]).toMatch(/^NIGHT — 0\.002 available/);
  expect(options[1]).toMatch(/^mUSD — 100 available/);

  // NIGHT's own units and ceiling, before anything is chosen.
  await expect(page.locator('.mnhome-send-unit')).toHaveText('NIGHT');
  await expect(page.getByPlaceholder('0.0')).toBeVisible();
});

test('choosing an asset re-quotes the amount and re-writes the recipient hint', async () => {
  await chooseShielded();

  await expect(page.getByText('Send mUSD', { exact: true })).toBeVisible();
  /* The unit is the chosen asset's own ticker. It used to read the fixed word
     "units", which named nothing on a sheet that could send several things. */
  await expect(page.locator('.mnhome-send-unit')).toHaveText('mUSD');
  await expect(page.getByPlaceholder('0', { exact: true })).toBeVisible();
  await expect(page.getByText(/100 mUSD available/)).toBeVisible();
  /* A name leads for a shielded asset too, since the shielded name route
     landed: it is the recipient Passport exists for, and an address is the
     fallback. Before that route this read `mn_shield-addr_stagenet1…`, because
     a name was the one thing mUSD could not be paid to. */
  await expect(page.getByPlaceholder('alice.night')).toBeVisible();
  /* The hint names what this asset can go to, rather than listing everything
     and leaving the refusal to do the teaching. */
  await expect(
    page.getByText(
      /A Midnight name, or a shielded \(mn_shield-addr…\) stagenet address — the two things mUSD can go to/,
    ),
  ).toBeVisible();

  /* Max means this asset's whole balance, in this asset's own units — and the
     control says which asset it would fill in, rather than reading the whole
     field back at a screen reader. */
  await page.getByRole('button', { name: 'Send the whole mUSD balance' }).click();
  await expect(page.getByPlaceholder('0', { exact: true })).toHaveValue('100');

  /* And back. THE AMOUNT DOES NOT COME WITH IT: "100" meant a hundred mUSD,
     and carrying it across is how that quietly becomes a hundred NIGHT on an
     account that can afford both. */
  await picker().selectOption('night');
  await expect(page.locator('.mnhome-send-unit')).toHaveText('NIGHT');
  await expect(page.getByPlaceholder('0.0')).toHaveValue('');
  await expect(page.getByText(/0\.002 NIGHT available in your account/)).toBeVisible();
});

test('an address for the wrong ledger is refused by name, never silently obeyed', async () => {
  /* THE DEFECT THIS UNIT EXISTS TO PREVENT. Pasting a shielded address used to
     switch the sheet to a shielded send without a word — the field that changed
     was not the field that was touched, which is the shape of a wrong send. */
  await recipient().fill('');
  await recipient().fill(SHIELDED);

  await expect(refusal()).toBeVisible();
  await expect(refusal()).toHaveText(
    'NIGHT goes to an unshielded (mn_addr…) address — this is a shielded one.',
  );
  await expect(page.getByRole('button', { name: /^Review$/ })).toBeDisabled();
  // The asset did NOT move under the paste.
  await expect(picker()).toHaveValue('night');
  await expect(page.getByText('Send NIGHT', { exact: true })).toBeVisible();

  // The mirror image, in the other asset's own name.
  await chooseShielded();
  await recipient().fill('');
  await recipient().fill(UNSHIELDED);
  await expect(refusal()).toHaveText(
    'mUSD goes to a shielded (mn_shield-addr…) address — this is an unshielded one.',
  );
  await expect(page.getByRole('button', { name: /^Review$/ })).toBeDisabled();

  /* And the refusal is a refusal, not a dead end: the address that DOES suit
     the chosen asset is accepted immediately, with nothing left over from the
     one before it. */
  await recipient().fill('');
  await recipient().fill(SHIELDED);
  await expect(refusal()).toHaveCount(0);
});

test('a name takes a shielded asset too, and is reviewed as the two steps it is', async () => {
  /* THE DEAD END THIS UNIT REMOVED. Until 2026/08/31 this pair earned "a name
     is always paid in NIGHT, so mUSD cannot go to one" — a fact about what had
     been built, said as a fact about the ledger. Both halves of that were then
     structural as well as textual: the sheet's dispatch tested the resolved
     name first, so a shielded asset paid to a name was unreachable whatever the
     rules said. It is now a route of its own. */
  // Still on mUSD from the test above.
  await expect(picker()).toHaveValue(/^[0-9a-f]{64}$/);
  await recipient().fill('');
  await recipient().fill(`${RESOLVABLE_NAME}.night`);

  const chip = page.locator('.mnhome-send-resolved');
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(chip).toContainText(`${RESOLVABLE_NAME}.night`);
  await expect(refusal()).toHaveCount(0);

  /* And it can be reviewed — the pair is a real send, not merely an accepted
     recipient. The amount is a whole count: a shielded colour publishes no
     decimal scale on the ledger. */
  await page.getByPlaceholder('0', { exact: true }).fill('1');
  await page.getByRole('button', { name: /^Review$/ }).click();
  const review = await page.locator('.mnhome-send-rows').innerText();
  expect(review).toContain('1 mUSD');
  expect(review).toContain(`${RESOLVABLE_NAME}.night`);
  /* SAID BEFORE THE CONFIRM. Paying a name in a shielded asset is two
     transactions exactly as paying one in NIGHT is, and somebody about to wait
     through both should know that is what they are waiting for. */
  expect(review).toContain('Two steps');
  // Still no colour and still no account address on the step that confirms.
  expect(review).not.toMatch(/\b[0-9a-f]{16,}\b/);
  expect(review).not.toContain(PASSPORT_ACCOUNT_ADDRESS);

  await page.getByRole('button', { name: /^Back$/ }).click();
  /* Choosing NIGHT keeps the same name, resolved exactly as it always was —
     through the real recorded registry. */
  await picker().selectOption('night');
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(chip).toContainText(`${RESOLVABLE_NAME}.night`);
});

test('the review step names the asset that was chosen', async () => {
  await page.getByPlaceholder('0.0').fill('0.000001');
  await page.getByRole('button', { name: /^Review$/ }).click();
  await expect(page.getByText('Review this transfer')).toBeVisible();

  const review = await page.locator('.mnhome-send-rows').innerText();
  /* THE ASSET LEADS. This row used to exist only for a shielded send, which
     left the one thing the user picked off the summary of what they picked
     whenever they picked NIGHT. */
  // Case-insensitive: the row's own heading is upper-cased in CSS.
  expect(review).toMatch(/^ASSET\nNIGHT\nnative token$/im);
  expect(review).toContain('0.000001 NIGHT');
  expect(review).toContain(`${RESOLVABLE_NAME}.night`);
  // Still no colour, and still no account address, on the step that confirms.
  expect(review).not.toMatch(/\b[0-9a-f]{16,}\b/);
  expect(review).not.toContain(PASSPORT_ACCOUNT_ADDRESS);

  await page.getByRole('button', { name: /^Back$/ }).click();
});

test('nothing on the sheet is a colour, an address of ours, or a piece of machinery', async () => {
  await chooseShielded();
  const sheet = await page.locator('.mnhome-send').innerText();

  /* A colour is 64 characters and identifies nothing to a reader. The picker
     names colours; it must never print one — not in an option, not in a hint,
     not in the unit chip. */
  expect(sheet).not.toMatch(/\b[0-9a-f]{32,}\b/);
  // Constraint (b): the engine is invisible, and a refusal is where it leaks.
  expect(sheet).not.toMatch(/\bDUST\b/i);
  expect(sheet).not.toMatch(/wallet|registry|indexer|resolver/i);
  expect(sheet).not.toContain(PASSPORT_ACCOUNT_ADDRESS);
});

test('a Passport account can be paid by its address, in either asset', async () => {
  /* ADDED 2026/09/02. A Passport whose owner has not claimed a name yet is
     still a Passport that can be paid — Receive shows the account address — and
     until this date the sheet turned those 32 bytes away as a malformed name.
     It is the same two-step send a name gets, because a name resolves to one of
     these and nothing else. */
  await picker().selectOption('night');
  await recipient().fill('');
  await recipient().fill(RECIPIENT_ACCOUNT_ADDRESS);

  const chip = page.locator('.mnhome-send-resolved');
  await expect(chip).toBeVisible();
  /* NOTHING WAS LOOKED UP, so nothing claims it was: the chip confirms that
     Passport read an account, and the tail says which. */
  await expect(chip).toContainText('A Passport account, ending');
  await expect(chip).not.toContainText('.night');
  await expect(refusal()).toHaveCount(0);

  await page.getByPlaceholder('0.0').fill('0.000001');
  await page.getByRole('button', { name: /^Review$/ }).click();
  let review = await page.locator('.mnhome-send-rows').innerText();
  expect(review).toContain('0.000001 NIGHT');
  /* Still the two steps a Passport payment is, and still no address on the
     step that confirms — the tail on the chip above is all that is shown. */
  expect(review).toContain('Two steps');
  expect(review).not.toContain(RECIPIENT_ACCOUNT_ADDRESS);
  await page.getByRole('button', { name: /^Back$/ }).click();

  // And the same address in the other asset, which routes the same way.
  await chooseShielded();
  await expect(refusal()).toHaveCount(0);
  await page.getByPlaceholder('0', { exact: true }).fill('1');
  await page.getByRole('button', { name: /^Review$/ }).click();
  review = await page.locator('.mnhome-send-rows').innerText();
  expect(review).toContain('1 mUSD');
  expect(review).toContain('Two steps');
  expect(review).not.toContain(RECIPIENT_ACCOUNT_ADDRESS);
  await page.getByRole('button', { name: /^Back$/ }).click();

  /* Left as it was found, so the serial file after this one is not reading a
     recipient this test typed. */
  await recipient().fill('');
  await recipient().fill(`${RESOLVABLE_NAME}.night`);
  await expect(chip).toBeVisible({ timeout: 30_000 });
});

test('an almost-account is refused as the name it is not, never sent', async () => {
  /* A truncated address accepted as an account would be money paid at 32 bytes
     nobody holds. One character short is not an account, and it earns the
     name rule's own sentence rather than a Review button. */
  await recipient().fill('');
  await recipient().fill(RECIPIENT_ACCOUNT_ADDRESS.slice(0, 63));
  await expect(refusal()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Review$/ })).toBeDisabled();
  expect(await refusal().innerText()).not.toContain(PASSPORT_ACCOUNT_ADDRESS);
});
