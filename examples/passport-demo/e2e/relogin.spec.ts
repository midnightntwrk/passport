/**
 * Tier 1 — coming back to a Passport, on a browser that has forgotten it.
 *
 * WHAT WENT WRONG, AND WHY IT NEEDED ITS OWN FILE (2026/09/03)
 * -----------------------------------------------------------
 * Site data does not survive. iOS evicts it after seven days away from a site
 * that is not installed, and a person clearing "browsing data" takes it with
 * everything else. The passkey survives all of that — it is in the keychain,
 * not in the page — and it carries, in its largeBlob, the account this Passport
 * was set up for and the name registered against it. That pair is the entire
 * mechanism by which a returning Passport is still a Passport.
 *
 * Both halves of it were broken, and both were reproduced in a browser before
 * either was fixed:
 *
 *   - the passkey was DESTROYED by the very button offered to the person
 *     holding it. With no local records the create path skipped discovery and
 *     called `credentials.create` with the same relying party and the same
 *     deterministic user handle as the surviving credential; with
 *     `residentKey: 'required'` that is a replacement, not a refusal. The
 *     credential id changed, the blob went with it, and the account and name
 *     the passkey held were unreachable for ever.
 *   - and when the passkey WAS found, its blob was read, the indexer was asked
 *     once, and anything short of a straight yes threw the lot away — so the
 *     user met "Choose your .night name" over a Passport that already had one,
 *     where claiming again would set up a second account.
 *
 * These are the assertions those two fixes have to keep passing. They are here
 * rather than in `onboarding.spec.ts` because each one needs its own browser
 * context: that file drives ONE Passport through its life on one page, and
 * every test below is about what a SECOND, forgetful browser does with a
 * passkey the first one made.
 *
 * The claim itself is seeded rather than run, for the reason the header of
 * `onboarding.spec.ts` gives: a real claim is a proved transaction. What is not
 * seeded is anything this file asserts on — the blob is written by the app, on
 * a real assertion, through a real authenticator, and read back off that
 * authenticator through CDP.
 */

import { expect, test, type BrowserContext, type CDPSession, type Page } from '@playwright/test';

import { installNetworkBoundary, PASSPORT_ACCOUNT_ADDRESS } from './mocks.js';

/** A label that is free in the recorded registry snapshot. */
const NAME = 'passportwalk';

/** 32 bytes of `ff` — a well-formed address the mocked indexer answers `null` for. */
const UNFINDABLE_ADDRESS = 'f'.repeat(64);

interface Harness {
  context: BrowserContext;
  page: Page;
  client: CDPSession;
  authenticatorId: string;
}

async function harness(browser: import('@playwright/test').Browser): Promise<Harness> {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await context.newPage();
  await installNetworkBoundary(page);
  const client = await context.newCDPSession(page);
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
  return { context, page, client, authenticatorId };
}

/** Every credential the authenticator holds, with whatever blob is on it. */
async function credentials(
  h: Harness,
): Promise<{ id: string; blob: string | null }[]> {
  const { credentials: held } = await h.client.send('WebAuthn.getCredentials', {
    authenticatorId: h.authenticatorId,
  });
  return held.map((credential) => ({
    id: credential.credentialId,
    blob: credential.largeBlob
      ? Buffer.from(credential.largeBlob, 'base64').toString('utf8')
      : null,
  }));
}

/** First-time enrolment through the landing button, as far as the name step. */
async function enrol(h: Harness): Promise<string> {
  await h.page.goto('/');
  await h.page.getByRole('button', { name: /Continue with Passport/i }).click();
  await expect(h.page.getByRole('heading', { name: /Welcome to Passport/i })).toBeVisible({
    timeout: 120_000,
  });
  await h.page.getByRole('button', { name: 'Choose my name' }).click();
  await expect(h.page.getByText(/Choose your .night name/i)).toBeVisible({ timeout: 60_000 });
  const credentialId = await h.page.evaluate(() =>
    localStorage.getItem('passport-last-passkey'),
  );
  if (!credentialId) throw new Error('the enrolment recorded no credential');
  return credentialId;
}

/**
 * The records a finished claim leaves behind, plus the profile note that says
 * the account has NOT reached the passkey yet — which is what makes the next
 * sign-in carry the write, exactly as a real claim does.
 */
async function seedClaim(h: Harness, credentialId: string, address: string): Promise<void> {
  await h.page.evaluate(
    async ({ credentialId, address, alias }) => {
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
      localStorage.setItem(`mn-passport:name-step:${credentialId}`, 'done');
      const scoped = credentialId.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open('midnight-passport', 2);
        open.onerror = () => reject(new Error('the profile store would not open'));
        open.onsuccess = () => resolve(open.result);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('public-profile', 'readwrite');
        const store = transaction.objectStore('public-profile');
        const read = store.get(`passkey:${scoped}`);
        read.onsuccess = () => {
          const profile = read.result as Record<string, unknown>;
          profile.accountOnPasskey = { address, network: 'stagenet', alias, written: false };
          store.put(profile, `passkey:${scoped}`);
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(new Error('the profile note would not save'));
      });
      database.close();
    },
    { credentialId, address, alias: NAME },
  );
}

/** Ends the session the reload stopgap keeps, without touching the Passport. */
async function dropSession(h: Harness): Promise<void> {
  await h.page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase('midnight-passport-session');
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
        request.onblocked = () => resolve();
      }),
  );
}

/** What the browser does after seven days on iOS, or one "clear browsing data". */
async function clearSiteData(h: Harness): Promise<void> {
  await h.page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
    const names = ((await indexedDB.databases?.()) ?? [])
      .map((database) => database.name)
      .filter((name): name is string => Boolean(name));
    for (const name of names) {
      await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
        request.onblocked = () => resolve();
      });
    }
  });
}

/** Signs in, writing the pending blob on the assertion — a real claim's next visit. */
async function signInAndWriteBlob(h: Harness): Promise<void> {
  await dropSession(h);
  await h.page.reload();
  await h.page.getByRole('button', { name: /Continue with Passport/i }).click();
  await expect(h.page.getByText(/Your account is ready/)).toBeVisible({ timeout: 60_000 });
}

test('a passkey that survives a cleared browser is never created over', async ({ browser }) => {
  /* THE DESTRUCTION, AND THE ONE FACT THAT RULES IT OUT. The credential that
     held the account must still be on the authenticator, with its blob, after
     the create path has run on a browser that remembers nothing. Before
     2026/09/03 it was not: there was exactly one credential afterwards, it had
     a different id, and it carried no blob — the old Passport, its name, and
     its account were gone with the PRF secret they derived from. */
  test.setTimeout(240_000);
  const h = await harness(browser);
  try {
    const credentialId = await enrol(h);
    await seedClaim(h, credentialId, PASSPORT_ACCOUNT_ADDRESS);
    await signInAndWriteBlob(h);

    const before = await credentials(h);
    expect(before).toHaveLength(1);
    expect(before[0]?.id).toBe(credentialId);
    // The account rode onto the credential on the sign-in's own assertion.
    expect(before[0]?.blob).toContain(PASSPORT_ACCOUNT_ADDRESS);

    await clearSiteData(h);
    await h.page.reload();
    await h.page.getByRole('button', { name: /Continue with Passport/i }).click();
    await expect(h.page.getByRole('heading', { name: /Welcome to Passport/i })).toBeVisible({
      timeout: 120_000,
    });

    const after = await credentials(h);
    const survivor = after.find((credential) => credential.id === credentialId);
    expect(survivor, 'the passkey holding the account was replaced').toBeDefined();
    expect(survivor?.blob).toContain(PASSPORT_ACCOUNT_ADDRESS);
    expect(survivor?.blob).toContain(NAME);
  } finally {
    await h.context.close();
  }
});

test('a Passport found on its passkey lands on Home with its name, not on the name step', async ({
  browser,
}) => {
  /* THE RECOVERY. The picker finds the credential, its blob names the account
     and the name, and both are kept — so the person arrives at the Passport
     they already had. Before the fix the account record was written and the
     NAME was not, and the name-step gate then sent them to "Choose your .night
     name" over a Passport called `passportwalk.night`. */
  test.setTimeout(240_000);
  const h = await harness(browser);
  try {
    const credentialId = await enrol(h);
    await seedClaim(h, credentialId, PASSPORT_ACCOUNT_ADDRESS);
    await signInAndWriteBlob(h);
    await clearSiteData(h);
    await h.page.reload();

    await h.page.getByRole('button', { name: /Use a different passkey/i }).click();

    await expect(h.page.getByText(`${NAME}.night`)).toBeVisible({ timeout: 120_000 });
    await expect(h.page.getByText(/Choose your .night name/i)).toHaveCount(0);
    // The name came off the passkey, so nothing here may show a transaction.
    const screen = await h.page.locator('body').innerText();
    expect(screen).not.toContain('bb'.repeat(32));
  } finally {
    await h.context.close();
  }
});

test('an account the chain will not answer for ends in a way out, never in the name step', async ({
  browser,
}) => {
  /* THE OTHER HALF. The blob names an address the indexer answers `null` for —
     a node behind, a wrong network, or an account that is genuinely not there.
     One read used to decide it, keep nothing, and drop the person on the name
     step with a claim in front of them that would set up a SECOND account. Now
     the search is bounded and it ENDS somewhere: the account card says it is
     working while the chain is asked again, and when the attempts are spent the
     screen offers looking again or setting up a new account. */
  test.setTimeout(300_000);
  const h = await harness(browser);
  try {
    const credentialId = await enrol(h);
    await seedClaim(h, credentialId, UNFINDABLE_ADDRESS);
    await signInAndWriteBlob(h);
    await clearSiteData(h);
    await h.page.reload();

    await h.page.getByRole('button', { name: /Use a different passkey/i }).click();

    // Looking, and saying so, rather than silently finishing with nothing.
    await expect(h.page.getByText(/Setting up your account/i)).toBeVisible({ timeout: 120_000 });
    await expect(h.page.getByText(/Choose your .night name/i)).toHaveCount(0);

    // The end of the search: a screen with both controls on it.
    await expect(h.page.getByText(/We could not.*find your account/is)).toBeVisible({
      timeout: 180_000,
    });
    await expect(h.page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(h.page.getByRole('button', { name: 'Set up a new account' })).toBeVisible();
    await expect(h.page.getByText(/Choose your .night name/i)).toHaveCount(0);

    /* And the way on is a CHOICE. Nothing is set up until it is pressed, and
       pressing it leads to the name step rather than to an account nobody
       asked for. */
    await h.page.getByRole('button', { name: 'Set up a new account' }).click();
    await expect(h.page.getByText(/Choose your .night name/i)).toBeVisible({ timeout: 60_000 });
  } finally {
    await h.context.close();
  }
});
