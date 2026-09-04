/**
 * Tier 1 — Android, and the Passport a reviewer could not get out of.
 *
 * WHAT WAS REPORTED (2026/09/04)
 * -----------------------------
 * "There is no way I can recreate an account or create a new one. I'm stuck
 * with the orphan key that does not contain the contract attached. If I sign up
 * with a new passkey from a different account, the PWA always brings me the
 * same failed profile (the same alias is brought over and over). Even deleting
 * and recreating the passkeys under different accounts doesn't do the job."
 * Alongside it, on the same device: "The passkey prompt did not finish…"
 *
 * BOTH WERE REPRODUCED IN A BROWSER BEFORE EITHER WAS FIXED, and both came from
 * assumptions this file now pins down.
 *
 *   - THE ORPHAN. The alias store was keyed by NETWORK ALONE — the last store
 *     in the app that was — while the contract store has been keyed by
 *     credential and network since multi-passkey support landed. A brand-new
 *     passkey therefore read the previous one's name, the name step saw a
 *     record and skipped itself, and Home printed that name over an account the
 *     new credential did not have. Every control on the landing screen was a
 *     way of getting BACK INTO what the browser held, so there was no way out
 *     at all.
 *   - THE PROMPT. Google Password Manager's passkeys implement PRF and do NOT
 *     implement largeBlob, and Chrome on Android narrows its account sheet to
 *     credentials that can satisfy the extensions a request asks for. The
 *     ride-along blob write on the sign-in after a claim therefore raised a
 *     sheet with nothing selectable in it, and it did not settle.
 *
 * WHY THE AUTHENTICATOR HERE IS DIFFERENT FROM `passkey.ts`'s
 * ----------------------------------------------------------
 * `installVirtualAuthenticator` creates one with `hasLargeBlob: true`, which is
 * a macOS or a desktop-Chrome passkey and is what every other spec in this
 * directory wants. It is also why none of them ever saw this: on that
 * authenticator the blob path works, so the whole class of failure is invisible.
 * The one below keeps PRF and resident keys and turns largeBlob OFF, which is
 * what an Android platform passkey actually is.
 *
 * EVERY CEREMONY IS COUNTED IN AND OUT. A prompt that does not finish is not an
 * exception and does not fail an assertion — it is a test that hangs until its
 * own timeout with nothing to say about why. So `navigator.credentials.get` is
 * wrapped, and the counts are asserted equal at the end of each test: started
 * but not done IS the reported bug, named.
 */

import { expect, test, type BrowserContext, type CDPSession, type Page } from '@playwright/test';

import { installNetworkBoundary, RESOLVABLE_NAME } from './mocks.js';

/** Chrome on a Pixel, which is what the report came from. */
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36';

/** A label that is free in the recorded registry snapshot. */
const NAME = 'passportwalk';
const ADDRESS = 'ab'.repeat(32);

interface Harness {
  context: BrowserContext;
  page: Page;
  client: CDPSession;
  authenticatorId: string;
}

/**
 * An ANDROID platform authenticator: PRF and resident keys, and no largeBlob.
 *
 * `hasLargeBlob: false` is the whole point of this file and is not a detail:
 * it is the difference between the authenticator every other spec here uses
 * and the one the reviewers were actually holding.
 */
async function harness(browser: import('@playwright/test').Browser): Promise<Harness> {
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 },
    userAgent: ANDROID_UA,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await installNetworkBoundary(page);
  await page.addInitScript(() => {
    const marker = window as unknown as { __ceremonies: { started: number; done: number } };
    marker.__ceremonies = { started: 0, done: 0 };
    /* BOTH halves. A first-time enrolment on a platform that evaluates the PRF
       at creation raises `create` and never `get` at all, and `create` narrows
       its authenticator selection on the requested extensions exactly as `get`
       narrows its picker — so a wrapper that watched only assertions would
       have watched the wrong ceremony on the one journey every user takes
       first. */
    const get = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = async (options?: CredentialRequestOptions) => {
      marker.__ceremonies.started += 1;
      try {
        return await get(options);
      } finally {
        marker.__ceremonies.done += 1;
      }
    };
    const create = navigator.credentials.create.bind(navigator.credentials);
    navigator.credentials.create = async (options?: CredentialCreationOptions) => {
      marker.__ceremonies.started += 1;
      try {
        return await create(options);
      } finally {
        marker.__ceremonies.done += 1;
      }
    };
  });
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
      hasLargeBlob: false,
      automaticPresenceSimulation: true,
    },
  });
  return { context, page, client, authenticatorId };
}

/**
 * Asserts that every passkey prompt this journey raised also FINISHED.
 *
 * The named form of "the passkey prompt did not finish": a ceremony counted in
 * and never counted out is a sheet still sitting on the user's screen.
 */
async function ceremonies(h: Harness): Promise<{ started: number; done: number }> {
  /* Counted since the last NAVIGATION: the init script re-runs on every one,
     which is right — a prompt that outlived a reload is a different bug from
     the one this file is about, and the browser has torn it down anyway. */
  return h.page.evaluate<{ started: number; done: number }>(
    () => (window as unknown as { __ceremonies: { started: number; done: number } }).__ceremonies,
  );
}

async function noCeremonyHung(h: Harness): Promise<void> {
  const counted = await ceremonies(h);
  expect(counted.done).toBe(counted.started);
}

/** Every alias and contract record this browser holds, by store key. */
interface HeldRecords {
  alias: Record<string, { alias?: string; credentialId?: string } | undefined>;
  contract: Record<string, unknown>;
}

async function records(h: Harness): Promise<HeldRecords> {
  return h.page.evaluate<HeldRecords>(() => ({
    alias: JSON.parse(localStorage.getItem('passport-alias:v1') ?? '{}') as HeldRecords['alias'],
    contract: JSON.parse(
      localStorage.getItem('passport-contract:v1') ?? '{}',
    ) as HeldRecords['contract'],
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
  const credentialId = await h.page.evaluate(() => localStorage.getItem('passport-last-passkey'));
  if (!credentialId) throw new Error('the enrolment recorded no credential');
  return credentialId;
}

/**
 * The records a finished claim leaves behind — both of them keyed by
 * CREDENTIAL and network, which is what the claim path now writes.
 */
async function seedClaim(h: Harness, credentialId: string): Promise<void> {
  await h.page.evaluate(
    ({ credentialId, address, alias }) => {
      const now = new Date().toISOString();
      localStorage.setItem(
        'passport-alias:v1',
        JSON.stringify({
          [`${credentialId}::stagenet`]: {
            credentialId,
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
    },
    { credentialId, address: ADDRESS, alias: NAME },
  );
}

/**
 * Reloads and leaves whatever session the app restored on its own.
 *
 * The app reopens a persisted session before any button is pressed, so a spec
 * that goes straight to the landing screen's controls races that restore — and
 * on a browser whose passkey has just been removed, the session it restores is
 * exactly the orphan under test.
 */
async function backToLanding(h: Harness): Promise<void> {
  await h.page.goto('/');
  const signOut = h.page.getByRole('button', { name: /Sign out of this Passport/i });
  const landing = h.page.getByRole('button', { name: /Continue with Passport/i });
  /* PRESSED UNTIL IT TAKES, and the loop is not politeness. The silent restore
     is several awaits long and used to put back the state a sign-out had just
     torn down, so the button did nothing and the user stayed on Home — found
     here on 2026/09/04, on exactly the journey somebody escaping an orphaned
     Passport takes. `signOutPassport` now cancels the restore first, and this
     stays a loop so a regression shows up as a slow test rather than as a
     flake nobody can reproduce. */
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (await landing.isVisible().catch(() => false)) return;
    if (await signOut.isVisible().catch(() => false)) {
      await signOut.click().catch(() => undefined);
    }
    if (Date.now() > deadline) break;
    await h.page.waitForTimeout(500);
  }
  await expect(landing).toBeVisible({ timeout: 30_000 });
}

test('an Android passkey enrols, and the platform\'s "no largeBlob" is written down', async ({
  browser,
}) => {
  const h = await harness(browser);
  await enrol(h);

  /* THE CHEAP HALF OF THE FIX. Enrolment asks with `support: 'preferred'`,
     which never fails creation, and this authenticator answers `false`. The
     profile records it, so no later assertion ever asks this credential for a
     blob — which is the assertion that raised a sheet that would not settle. */
  const supported = await h.page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('midnight-passport', 2);
      open.onerror = () => reject(new Error('no profile store'));
      open.onsuccess = () => resolve(open.result);
    });
    const profiles = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const read = database
        .transaction('public-profile', 'readonly')
        .objectStore('public-profile')
        .getAll();
      read.onsuccess = () => resolve(read.result as Record<string, unknown>[]);
      read.onerror = () => reject(new Error('no profiles'));
    });
    database.close();
    return profiles.map((profile) => profile.largeBlobSupported);
  });
  expect(supported).toEqual([false]);

  await noCeremonyHung(h);
  await h.context.close();
});

test('a NEW passkey starts clean, and does not inherit the old name', async ({ browser }) => {
  const h = await harness(browser);
  const first = await enrol(h);
  await seedClaim(h, first);

  /* The reviewer's move: the passkey goes — deleted, or a different Google
     account signs in on the same phone — and the site's own data stays exactly
     where it was, because deleting a passkey does not clear site data. */
  await h.client.send('WebAuthn.removeCredential', {
    authenticatorId: h.authenticatorId,
    credentialId: first,
  });

  await backToLanding(h);
  await h.page.getByRole('button', { name: /Continue with Passport/i }).click();

  /* The targeted assertion cannot produce the credential, so the keyless panel
     comes up. It carries the control that makes a new passkey. */
  const create = h.page.getByRole('button', { name: /Create a new passkey/i });
  await expect(create).toBeVisible({ timeout: 120_000 });
  await create.click();

  await expect(h.page.getByRole('heading', { name: /Welcome to Passport/i })).toBeVisible({
    timeout: 120_000,
  });
  await h.page.getByRole('button', { name: 'Choose my name' }).click();

  /* THE FIX, ASSERTED. This is where the reviewer landed on a finished Home
     screen wearing `passportwalk` with no account behind it. A Passport that
     has claimed nothing is asked to choose a name, like the new Passport it
     is. */
  await expect(h.page.getByText(/Choose your .night name/i)).toBeVisible({ timeout: 60_000 });
  const body = await h.page.locator('body').innerText();
  expect(body).not.toContain(NAME);

  const second = await h.page.evaluate(() => localStorage.getItem('passport-last-passkey'));
  expect(second).not.toBe(first);

  /* And the FIRST Passport's name is still there, under its own key. A fix
     that made the second passkey clean by destroying the first one's record
     would be a worse bug than the one it replaced. */
  const held = await records(h);
  expect(held.alias[`${first}::stagenet`]?.alias).toBe(NAME);
  expect(held.alias[`${second}::stagenet`]).toBeUndefined();

  await noCeremonyHung(h);
  await h.context.close();
});

test('"Set up a new Passport on this device" forgets this device\'s records and creates', async ({
  browser,
}) => {
  const h = await harness(browser);
  const first = await enrol(h);
  await seedClaim(h, first);
  await h.client.send('WebAuthn.removeCredential', {
    authenticatorId: h.authenticatorId,
    credentialId: first,
  });

  await backToLanding(h);
  await h.page.getByRole('button', { name: /Continue with Passport/i }).click();

  /* THE CONTROL THAT DID NOT EXIST. Every other control on this screen reopens
     what the browser already holds; when what it holds is wrong, all of them
     lead back to the same wrong place. */
  const startFresh = h.page.getByRole('button', {
    name: /Set up a new Passport on this device/i,
  });
  await expect(startFresh).toBeVisible({ timeout: 120_000 });
  /* Exactly one. The keyless panel carries it and the stage beneath does not
     repeat it: two buttons with the same words, on the screen where the reader
     is already stuck, reads as two different offers. */
  expect(await startFresh.count()).toBe(1);
  await startFresh.click();

  await expect(h.page.getByRole('heading', { name: /Welcome to Passport/i })).toBeVisible({
    timeout: 120_000,
  });
  await h.page.getByRole('button', { name: 'Choose my name' }).click();
  await expect(h.page.getByText(/Choose your .night name/i)).toBeVisible({ timeout: 60_000 });

  /* Everything this device held for the old credential is gone, and it is only
     ever this device's memory: the passkey was never ours to delete and the
     account and the name are on Midnight. */
  const held = await records(h);
  expect(held.alias[`${first}::stagenet`]).toBeUndefined();
  expect(held.contract[`${first}::stagenet`]).toBeUndefined();
  expect(Object.keys(held.alias)).toHaveLength(0);

  const second = await h.page.evaluate(() => localStorage.getItem('passport-last-passkey'));
  expect(second).not.toBe(first);

  await noCeremonyHung(h);
  await h.context.close();
});

test('the name step offers the other door, and a name alone never opens it', async ({
  browser,
}) => {
  const h = await harness(browser);
  await enrol(h);

  /* WHY THIS PATH IS COMPULSORY ON ANDROID. Recovery went entirely through the
     passkey's largeBlob, and an Android passkey has none — so a browser with
     cleared site data could recover NOTHING and was put here, on a naming
     ceremony, over a Passport that already had a name. */
  const findExisting = h.page.getByRole('button', { name: /find my Passport/i });
  await expect(findExisting).toBeVisible();
  await findExisting.click();
  await expect(h.page.getByRole('heading', { name: /Find it/i })).toBeVisible();

  const field = h.page.getByLabel('Your name');
  const submit = h.page.getByRole('button', { name: /Find my Passport/i });

  /* A name the registry does not hold. Said plainly, and with the two things
     to do about it. */
  await field.fill('nosuchnameanywhere');
  await submit.click();
  await expect(h.page.getByText(/No Passport is registered under that name/i)).toBeVisible({
    timeout: 60_000,
  });

  /* AND THE ONE THAT MATTERS. `iamtester` resolves, in the recorded stagenet
     registry, to a real account-custody contract — and this passkey is not one
     of that account's devices. Knowing a name gets an attacker exactly this
     far: a name is public, so it can only ever say WHICH account to look at,
     and the contract's own device set is what answers. */
  await field.fill(RESOLVABLE_NAME);
  await submit.click();
  await expect(h.page.getByText(/this passkey is not part of/i)).toBeVisible({ timeout: 60_000 });

  /* Nothing was restored on the strength of a name. */
  const held = await records(h);
  expect(Object.keys(held.alias)).toHaveLength(0);
  expect(Object.keys(held.contract)).toHaveLength(0);

  /* The ownership proof is ONE assertion, asked for by somebody who typed a
     name and pressed a button — and it finished. */
  await noCeremonyHung(h);
  await h.context.close();
});

test('a name claimed before records named their passkey is given back to its owner', async ({
  browser,
}) => {
  const h = await harness(browser);
  const credentialId = await enrol(h);

  /* EVERY INSTALLED PASSPORT IS IN THIS STATE. Records written before
     2026/09/04 sit under a bare network key and name nobody, so on this build
     no reader can reach them. Handing one to whoever signs in next is the
     defect; refusing to hand it over at all loses a real person their real
     name. The rule is that a claim must be SHOWN — here, by being the only
     Passport in the browser. */
  await h.page.evaluate(
    ({ alias, address }) => {
      localStorage.setItem(
        'passport-alias:v1',
        JSON.stringify({
          stagenet: {
            alias,
            domain: `${alias}.night`,
            network: 'stagenet',
            status: 'registered',
            resolverDeployTxId: 'aa'.repeat(32),
            registerTxId: 'bb'.repeat(32),
            registryConfirmed: true,
            resolverTargetHex: address,
            updatedAt: new Date().toISOString(),
          },
        }),
      );
    },
    { alias: NAME, address: ADDRESS },
  );

  /* A RELOAD, WHICH IS WHAT A RETURNING USER ACTUALLY DOES. The session is
     restored silently, with no ceremony, and the adoption has to land before
     the name-step gate reads the store — otherwise the name is handed back a
     tick after somebody has been asked to choose one. Reaching Home rather
     than the name step is that assertion. */
  await h.page.goto('/');
  await expect(h.page.getByRole('button', { name: /Sign out of this Passport/i })).toBeVisible({
    timeout: 120_000,
  });
  /* The greeting, which is the name being READ BACK by the credential that
     just adopted it — not merely a record in storage. */
  await expect(
    h.page.getByRole('heading', { name: new RegExp(`${NAME}$`) }),
  ).toBeVisible({ timeout: 30_000 });
  /* AND IT COST NOTHING. The restore is silent by design, so handing a name
     back on it must not be the thing that raises a passkey prompt — least of
     all on a reload the user did not think of as a sign-in. */
  expect(await ceremonies(h)).toEqual({ started: 0, done: 0 });

  const held = await records(h);
  expect(held.alias[`${credentialId}::stagenet`]?.alias).toBe(NAME);
  expect(held.alias[`${credentialId}::stagenet`]?.credentialId).toBe(credentialId);
  /* Re-keyed, not copied: a bare key that survived would be adopted a second
     time by the next credential to sign in. */
  expect(held.alias.stagenet).toBeUndefined();

  await noCeremonyHung(h);
  await h.context.close();
});
