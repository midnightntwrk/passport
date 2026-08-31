/**
 * Tier 1 — HOW MANY TIMES A PASSPORT ASKS YOU TO TOUCH YOUR AUTHENTICATOR.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * `onboarding.spec.ts` holds the shipped bundle to what a user can SEE. This
 * one holds it to what a user is ASKED FOR, which no screen assertion can
 * reach: a WebAuthn prompt is drawn by the operating system, outside the page,
 * and a spec that only reads the DOM cannot tell a Passport that asked once
 * from one that asked three times.
 *
 * THE RULE
 * --------
 * Arriving on Home costs ZERO ceremonies. A prompt is legitimate only where
 * the user asked for something that spends or signs; everything else — a
 * balance, a record, a piece of metadata Passport would like to save — must
 * ride an assertion that was already happening or wait for one that is.
 *
 * THE INCIDENT IT WAS WRITTEN FOR (2026/08/31)
 * -------------------------------------------
 * Reported repeatedly, and live in production: the ceremony finishes, the name
 * is registered, the account is deployed, Home renders whole — greeting,
 * Send/Receive, balances, "Your account is ready" — and then macOS raises
 * "Sign in to midnightpassport.com with your passkey", unbidden, with nothing
 * pressed. The stack behind it, captured by the recorder below against the
 * production build `main-DEYoucTm.js`, named it exactly:
 *
 *     Error: webauthn
 *         at CredentialsContainer.value (<anonymous>:20:34)
 *         at En.writeAccountBlob (…/assets/main-DEYoucTm.js:46:68009)
 *         at …/assets/main-DEYoucTm.js:326:47199      (rememberAccountOnPasskey)
 *         at …/assets/main-DEYoucTm.js:326:63562      (claimAliasBoundToAccount)
 *
 * A largeBlob write may not be paired with a read, so writing the account onto
 * the passkey at the end of a claim was a second, whole, user-verified
 * assertion — three seconds after the claim's own, arriving as the screen
 * settled. See `src/lib/accountOnPasskey.ts` for what replaced it.
 *
 * HOW IT COUNTS
 * -------------
 * An init script wraps `navigator.credentials.get` and `.create` before the
 * app loads and records every call with the stack that made it and the mark
 * the walk was on at the time. Nothing is stubbed: the real call still runs,
 * answered by the same CDP virtual authenticator every other spec uses. The
 * recorder is per page load, which is why each leg below states its own count.
 *
 * WHAT IT MOCKS THAT THE TIER USUALLY WILL NOT, AND WHY THAT IS HONEST
 * -------------------------------------------------------------------
 * `mocks.ts` refuses `/register-alias` by design, because a mocked "claim
 * succeeded" would assert that the mock returned. This file fulfils it, and a
 * deployed contract record is seeded so the claim REUSES an account rather
 * than proving one. Neither is used to claim anything about the chain: what is
 * asserted here is how many times the user was asked to touch a sensor on the
 * way to Home, and that is a property of the client alone. Everything the
 * claim really does on a chain remains `stagenet.live.spec.ts`'s job.
 */

import { expect, test, type Page } from '@playwright/test';

import { installNetworkBoundary, PASSPORT_ACCOUNT_ADDRESS } from './mocks.js';
import { installVirtualAuthenticator } from './passkey.js';

test.describe.configure({ mode: 'serial' });

let page: Page;

/** A label that is free in the recorded registry snapshot. */
const NAME = 'passportceremony';

/** One WebAuthn call, as the page recorded it. */
interface CeremonyRecord {
  /** `get` (an assertion) or `create` (an enrolment). */
  kind: 'get' | 'create';
  /** The walk's mark when the call was MADE — see `mark()`. */
  mark: string | null;
  /** The stack that made it. Minified, and still names the method. */
  stack: string;
}

/**
 * Installed before any app code runs, and re-installed on every navigation.
 *
 * It wraps rather than replaces: the underlying call still reaches the virtual
 * authenticator, so the walk below is the real ceremony throughout and the
 * recorder cannot be the reason something passes.
 */
const RECORD_CEREMONIES = () => {
  const store = window as unknown as { __ceremonies: unknown[]; __mark: string | null };
  store.__ceremonies = [];
  store.__mark = null;
  const container = navigator.credentials;
  for (const name of ['get', 'create'] as const) {
    const original = container[name].bind(container);
    Object.defineProperty(container, name, {
      configurable: true,
      writable: true,
      value: (...args: unknown[]) => {
        store.__ceremonies.push({
          kind: name,
          mark: store.__mark,
          stack: new Error('webauthn').stack ?? '(no stack)',
        });
        return (original as (...rest: unknown[]) => unknown)(...args);
      },
    });
  }
};

/** Everything the page has been asked for on THIS page load. */
async function ceremonies(): Promise<CeremonyRecord[]> {
  return page.evaluate(
    () => (window as unknown as { __ceremonies: CeremonyRecord[] }).__ceremonies ?? [],
  );
}

/** Labels every ceremony from here on, so "after Home" is a fact and not a race. */
async function mark(label: string): Promise<void> {
  await page.evaluate((value) => {
    (window as unknown as { __mark: string | null }).__mark = value;
  }, label);
}

/** The stored profile records, read out of the app's own IndexedDB. */
async function storedProfiles(): Promise<{ accountOnPasskey?: { written?: boolean } }[]> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('midnight-passport');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const all = request.result
            .transaction('public-profile', 'readonly')
            .objectStore('public-profile')
            .getAll();
          all.onerror = () => reject(all.error);
          all.onsuccess = () => resolve(all.result);
        };
      }),
  );
}

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  page = await context.newPage();
  await page.addInitScript(RECORD_CEREMONIES);
  await installNetworkBoundary(page);
  await installVirtualAuthenticator(context, page);
});

test.afterAll(async () => {
  await page.context().close();
});

test('a finished claim lands on Home without asking for anything', async () => {
  test.setTimeout(300_000);

  /* ---- The enrolment leg. One create, and then nothing. ---- */
  await page.goto('/');
  await page.getByRole('button', { name: /Continue with Passport/i }).click();
  await expect(page.getByRole('heading', { name: /Welcome to Passport/i })).toBeVisible({
    timeout: 60_000,
  });
  await mark('welcome');
  await page.getByRole('button', { name: 'Choose my name' }).click();
  await expect(page.getByText(/Choose your .night name/i)).toBeVisible({ timeout: 60_000 });

  /* Reading the welcome and walking to the name step is not an act that signs
     anything, so it costs nothing. */
  expect((await ceremonies()).filter((entry) => entry.mark === 'welcome')).toEqual([]);

  /* ---- The claim leg, set up so the account is reused rather than proved ----
     A deployed record for this credential and network, written through the
     same key the app's own store uses. `claimAliasBoundToAccount` reuses a
     deployed account — a Passport has one contract per network — so the claim
     runs its real code path without a prover or a chain. */
  const credentialId = await page.evaluate(
    ({ address }) => {
      const id = localStorage.getItem('passport-last-passkey');
      if (!id) return null;
      localStorage.setItem(
        'passport-contract:v1',
        JSON.stringify({
          [`${id}::stagenet`]: {
            credentialId: id,
            network: 'stagenet',
            status: 'deployed',
            address,
            deployTxId: 'cc'.repeat(32),
            txIdResolved: true,
            ledgerConfirmed: true,
            feePaidBy: 'sponsored',
            updatedAt: new Date().toISOString(),
          },
        }),
      );
      return id;
    },
    { address: PASSPORT_ACCOUNT_ADDRESS },
  );
  expect(credentialId).not.toBeNull();

  /* The sponsor registers the name, naming this Passport's own account as the
     target — which is the one thing `sponsoredAlias.ts` refuses to take on
     faith from a 200 with anything else in it. */
  await page.route('**/funder.midnightpassport.com/**/register-alias', (route) =>
    route.fulfill({
      json: {
        alias: NAME,
        domain: `${NAME}.night`,
        network: 'stagenet',
        tldAddress: '29be1e64846cff4600c5297fa54b27d4c9296b3ccc2cdba190eaba1d64c5f116',
        resolverAddress: 'dd'.repeat(32),
        resolverDeployTx: 'aa'.repeat(32),
        registerTx: 'bb'.repeat(32),
        target: { kind: 'contract', address: PASSPORT_ACCOUNT_ADDRESS },
        registeredAt: new Date().toISOString(),
      },
    }),
  );

  await page.reload();
  await expect(page.getByText(/Choose your .night name/i)).toBeVisible({ timeout: 60_000 });
  await mark('claim');

  await page.getByLabel('Your Midnight name').fill(NAME);
  await expect(page.getByText(`${NAME}.night is available`)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: new RegExp(`Claim ${NAME}\\.night`) }).click();

  /* Home, whole: the account card and the controls that act on it. */
  await expect(page.getByRole('button', { name: /^Send$/ })).toBeVisible({ timeout: 200_000 });
  await expect(page.getByText(/Your account is ready/)).toBeVisible();
  await mark('home');

  /* THE ASSERTION. One ceremony for one user action — the claim's own single
     assertion, from which both the Midnames owner key and the contract root
     secret derive. Anything else on this page load is a prompt nobody asked
     for, and the second entry that used to be here was exactly that. */
  const claimLeg = await ceremonies();
  expect(claimLeg).toHaveLength(1);
  expect(claimLeg[0]?.kind).toBe('get');

  /* Said again against the culprit by name, so a failure reads as the bug it
     is rather than as a number. Method names survive minification; if they
     ever stop doing, the count above is still the assertion that holds. */
  expect(claimLeg.map((entry) => entry.stack).join('\n')).not.toContain('writeAccountBlob');

  /* And nothing arrives LATE. The write that caused the incident was fired
     unawaited as the claim returned, so its prompt surfaced while Home was
     already painting; a window is what catches that class of fault at all. */
  await page.waitForTimeout(20_000);
  expect((await ceremonies()).filter((entry) => entry.mark === 'home')).toEqual([]);
});

test('the account reaches the passkey on the next sign-in, for no extra prompt', async () => {
  /* The other half of the fix, and the reason the claim may drop the write
     without dropping the capability. The account note goes onto the credential
     in the largeBlob slice of the sign-in assertion — which was going to
     happen anyway — so the whole of what a second device needs to find this
     Passport is written, and the count for that sign-in is still ONE. */
  test.setTimeout(200_000);

  /* A signed-out browser, made the way the app makes one: the persisted
     session record is what a reload restores WITHOUT a ceremony, and it is
     exactly what stands between this walk and a real sign-in. */
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('midnight-passport-session');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const remove = request.result
            .transaction('wallet-sessions', 'readwrite')
            .objectStore('wallet-sessions')
            .clear();
          remove.onerror = () => reject(remove.error);
          remove.onsuccess = () => resolve();
        };
      }),
  );

  await page.reload();
  const signIn = page.getByRole('button', { name: /Continue with Passport/i });
  await expect(signIn).toBeVisible({ timeout: 60_000 });
  await mark('signin');
  await signIn.click();

  /* Home again — the name step is settled, so a returning Passport lands
     straight on it. */
  await expect(page.getByRole('button', { name: /^Send$/ })).toBeVisible({ timeout: 200_000 });
  await mark('home');

  const signInLeg = await ceremonies();
  expect(signInLeg).toHaveLength(1);
  expect(signInLeg[0]?.kind).toBe('get');

  /* The blob landed, and the profile says so — which is what stops the next
     sign-in spending its largeBlob slice on a write it no longer owes. */
  await expect
    .poll(async () => (await storedProfiles()).some((one) => one.accountOnPasskey?.written === true), {
      timeout: 20_000,
    })
    .toBe(true);

  // Still nothing after Home, on this leg either.
  await page.waitForTimeout(10_000);
  expect((await ceremonies()).filter((entry) => entry.mark === 'home')).toEqual([]);
});
