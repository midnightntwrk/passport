/**
 * Tier 1 — the SHAPES an Android Passport actually comes in, and the four
 * moments a phone has that a desktop does not.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `e2e/android-recovery.spec.ts` closed the orphan-passkey loop on 2026/09/04
 * and, in doing so, established the one thing the rest of this directory had
 * been assuming away: `passkey.ts`'s virtual authenticator has
 * `hasLargeBlob: true`, which is a macOS or desktop-Chrome passkey. Every other
 * spec here is graded on that authenticator, so an entire class of Android
 * failure is invisible to all of them — the blob path works, so nothing that
 * depends on it can be seen to break.
 *
 * That file fixed the shape it found. This one PARAMETRISES the shape, and
 * then walks the four other things an Android browser does that a desktop one
 * does not: it runs the app as an installed window with no address bar, it
 * takes the tab away mid-proof and brings it back, it has a back gesture as
 * the primary way of dismissing anything, and it signs with a passkey held on
 * another device through a sheet that can take a minute to answer.
 *
 * THE THREE AUTHENTICATOR SHAPES, AND WHAT EACH ONE IS
 * ----------------------------------------------------
 *   `{ largeBlob: true,  prf: true  }`  A desktop platform passkey. What every
 *                                       other spec in this directory runs on,
 *                                       kept here so the parametrised walk has
 *                                       a control to be read against.
 *   `{ largeBlob: false, prf: true  }`  A Google Password Manager passkey, the
 *                                       common Android platform credential.
 *                                       PRF, no blob.
 *   `{ largeBlob: false, prf: false }`  An older Android or GPM combination
 *                                       that implements neither. Passport
 *                                       cannot derive a key from it, so the
 *                                       only thing to hold to a standard is
 *                                       what it SAYS and what it offers.
 *
 * WHAT THIS FILE FOUND, AND WHERE THE FIXES ARE
 * ---------------------------------------------
 *   1. THE NO-PRF DEAD END. A passkey with no PRF at all enrolled, came back
 *      unable to derive anything, and the landing screen said "Passport
 *      passkeys require a valid HTTPS origin or localhost relying-party
 *      domain." — on `localhost`, about a thing that was not wrong, with no
 *      control under it. The sentence was reached by accident:
 *      `enrollWithPrf` threw one ending "…or PRF-capable security key", and
 *      `errorMessage`'s substring sniff matched the word "security". Fixed in
 *      `demo-backend/src/passkey.ts` (typed failure, and the sniff replaced by
 *      the error's NAME), `src/lib/passkeyRecovery.ts` (an `enrolment` stage
 *      whose answer is never another enrolment), and the panel that carries it.
 *   2. THE BACK GESTURE. Passport's sheets were React state and nothing else,
 *      so a back swipe over an open Send sheet left the document instead of
 *      closing the sheet — and installed to a home screen, with nothing behind
 *      Passport to go back to, it closed the app. Fixed in
 *      `src/lib/sheetHistory.ts` and its hook.
 *
 * HOW EVERY TEST HERE IS GUARDED
 * ------------------------------
 * On `android-recovery.spec.ts`'s rule, and for its reason: every passkey
 * ceremony is counted IN and OUT, and the counts are asserted equal. A prompt
 * that starts and never finishes is not an exception and fails no assertion —
 * it is a test that hangs until its own timeout with nothing to say about why,
 * and "the passkey prompt did not finish" is a thing users have reported twice.
 */

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from '@playwright/test';

import { installNetworkBoundary, PASSPORT_ACCOUNT_ADDRESS } from './mocks.js';

/** Chrome on a Pixel, which is what both Android reports came from. */
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36';

/** A Pixel 8's viewport, in CSS pixels. */
const ANDROID_VIEWPORT = { width: 412, height: 915 } as const;

/** The desktop shape's viewport — the one every other spec here uses. */
const DESKTOP_VIEWPORT = { width: 420, height: 900 } as const;

/** What a Passport account this walk seeds looks like, in one place. */
const ADDRESS = PASSPORT_ACCOUNT_ADDRESS;

interface AuthenticatorShape {
  /** Whether the authenticator implements the largeBlob extension. */
  largeBlob: boolean;
  /** Whether it implements PRF — the extension every Passport key derives from. */
  prf: boolean;
}

interface HarnessOptions extends AuthenticatorShape {
  /** Android user agent, touch, and a phone viewport. Defaults to true. */
  android?: boolean;
  /**
   * Answer `matchMedia('(display-mode: standalone)')` with true, which is the
   * only thing that distinguishes an installed Passport from a tab.
   */
  standalone?: boolean;
  /** Block the service worker, so `page.route` sees `/zk/**` — see below. */
  blockServiceWorker?: boolean;
  /**
   * Hold every `navigator.credentials.get` open for this long before letting
   * it run. Simulates the cross-device (hybrid) sheet: a QR scanned on a phone
   * in the next room, which the platform answers when the human does.
   */
  slowGetMs?: number;
}

interface Harness {
  context: BrowserContext;
  page: Page;
  client: CDPSession;
  authenticatorId: string;
}

interface CeremonyCount {
  started: number;
  done: number;
}

/**
 * A browser holding one authenticator of the given shape, with every ceremony
 * counted.
 *
 * The shape is the only thing that varies. Everything else — resident keys,
 * user verification, CTAP 2.1, automatic presence — is what `passkey.ts`
 * documents as required by something this app does, and turning any of it off
 * would be testing a different app rather than a different phone.
 */
async function harness(browser: Browser, options: HarnessOptions): Promise<Harness> {
  const android = options.android !== false;
  const context = await browser.newContext({
    viewport: android ? ANDROID_VIEWPORT : DESKTOP_VIEWPORT,
    ...(android ? { userAgent: ANDROID_UA, isMobile: true, hasTouch: true } : {}),
    ...(options.blockServiceWorker ? { serviceWorkers: 'block' as const } : {}),
  });
  const page = await context.newPage();
  await installNetworkBoundary(page);

  /* THE CEREMONY COUNTER, and both halves of it. A first-time enrolment on a
     platform that evaluates the PRF at creation raises `create` and never
     `get`, and `create` narrows its authenticator selection on the requested
     extensions exactly as `get` narrows its picker — so a wrapper watching
     only assertions would watch the wrong ceremony on the journey every user
     takes first. */
  await page.addInitScript((slowGetMs: number) => {
    const marker = window as unknown as { __ceremonies: { started: number; done: number } };
    marker.__ceremonies = { started: 0, done: 0 };
    const get = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = async (request?: CredentialRequestOptions) => {
      marker.__ceremonies.started += 1;
      try {
        /* The hybrid wait, before the ceremony rather than after it: what the
           app is holding is one unresolved promise, which is exactly what it
           holds while somebody walks to fetch their phone. */
        if (slowGetMs > 0) await new Promise((settle) => setTimeout(settle, slowGetMs));
        return await get(request);
      } finally {
        marker.__ceremonies.done += 1;
      }
    };
    const create = navigator.credentials.create.bind(navigator.credentials);
    navigator.credentials.create = async (request?: CredentialCreationOptions) => {
      marker.__ceremonies.started += 1;
      try {
        return await create(request);
      } finally {
        marker.__ceremonies.done += 1;
      }
    };
  }, options.slowGetMs ?? 0);

  if (options.standalone) {
    /* THE ONE THING PLAYWRIGHT CANNOT EMULATE. `page.emulateMedia` covers
       colour scheme, reduced motion, and forced colours; `display-mode` is not
       among them, and it is the only signal an installed Passport has that it
       is installed — `lib/installPrompt.ts` reads it, `pwa.tsx` reads it, and
       `InstallPassport.tsx` subscribes to its changes. So the query is
       answered here, and only that query: every other `matchMedia` call is
       delegated to the real implementation, because a stub that answered them
       all would be a stub the layout was rendered against. */
    await page.addInitScript(() => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = (query: string): MediaQueryList => {
        const list = real(query);
        if (!/display-mode:\s*standalone/.test(query)) return list;
        return {
          media: query,
          matches: true,
          onchange: null,
          addEventListener: list.addEventListener.bind(list),
          removeEventListener: list.removeEventListener.bind(list),
          addListener: list.addListener?.bind(list),
          removeListener: list.removeListener?.bind(list),
          dispatchEvent: list.dispatchEvent.bind(list),
        };
      };
    });
  }

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
      hasPrf: options.prf,
      hasLargeBlob: options.largeBlob,
      automaticPresenceSimulation: true,
    },
  });
  return { context, page, client, authenticatorId };
}

/** Every passkey prompt this journey raised, and how many of them finished. */
async function ceremonies(page: Page): Promise<CeremonyCount> {
  return page.evaluate<CeremonyCount>(
    () => (window as unknown as { __ceremonies: CeremonyCount }).__ceremonies,
  );
}

/** Zeroes the counter, so the next leg of a walk is counted on its own. */
async function resetCeremonies(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __ceremonies: CeremonyCount }).__ceremonies = { started: 0, done: 0 };
  });
}

/** The named form of "the passkey prompt did not finish". */
async function noCeremonyHung(page: Page): Promise<void> {
  const counted = await ceremonies(page);
  expect(counted.done).toBe(counted.started);
}

/** First-time enrolment through the landing button, as far as the name step. */
async function enrol(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: /Continue with Passport/i }).click();
  await expect(page.getByRole('heading', { name: /Welcome to Passport/i })).toBeVisible({
    timeout: 120_000,
  });
}

/**
 * The records a finished claim leaves behind, keyed by credential and network.
 *
 * The same seeding `home-bar.spec.ts` and `android-recovery.spec.ts` use, and
 * for the same reason: the claim itself is two proved transactions and is
 * `stagenet.live.spec.ts`'s job, while what these tests are about is the
 * screen a Passport that HAS one lands on. The address is the recorded
 * stagenet account, so Home renders a real ledger rather than "Unavailable".
 */
async function seedClaimedPassport(page: Page, alias: string): Promise<string> {
  const credentialId = await page.evaluate(
    ({ alias, address }) => {
      const credentialId = localStorage.getItem('passport-last-passkey');
      if (!credentialId) return null;
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
      return credentialId;
    },
    { alias, address: ADDRESS },
  );
  expect(credentialId).not.toBeNull();
  return credentialId as string;
}

/**
 * Signs out and waits for the landing screen, pressing until it takes.
 *
 * The loop is `android-recovery.spec.ts`'s and is not politeness: the silent
 * session restore is several awaits long and has, before now, put back the
 * state a sign-out had just torn down — so the button appeared to do nothing.
 * A regression there shows up here as a slow test rather than as a flake
 * nobody can reproduce.
 */
async function signOutToLanding(page: Page): Promise<void> {
  const signOut = page.getByRole('button', { name: /Sign out of this Passport/i });
  const landing = page.getByRole('button', { name: /Continue with Passport/i });
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (await landing.isVisible().catch(() => false)) return;
    if (await signOut.isVisible().catch(() => false)) {
      await signOut.click().catch(() => undefined);
    }
    if (Date.now() > deadline) break;
    await page.waitForTimeout(500);
  }
  await expect(landing).toBeVisible({ timeout: 30_000 });
}

/** Waits for Home — the Send control is the thing only Home has. */
async function onHome(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: /^Send$/ }).first()).toBeVisible({
    timeout: 120_000,
  });
}

/** What the profile store recorded about this credential's blob support. */
async function recordedLargeBlobSupport(page: Page): Promise<unknown[]> {
  return page.evaluate(async () => {
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
}

/* ------------------------------------------------------------------------ *
 * 1. THE WALK, OVER EVERY SHAPE OF AUTHENTICATOR                            *
 * ------------------------------------------------------------------------ */

const WALKABLE_SHAPES: readonly { label: string; shape: HarnessOptions; alias: string }[] = [
  {
    label: 'a desktop platform passkey (largeBlob and PRF)',
    shape: { largeBlob: true, prf: true, android: false },
    alias: 'shapedesktop',
  },
  {
    label: 'a Google Password Manager passkey (PRF, no largeBlob)',
    shape: { largeBlob: false, prf: true },
    alias: 'shapegpm',
  },
];

for (const { label, shape, alias } of WALKABLE_SHAPES) {
  test(`${label} onboards once and signs in with one assertion`, async ({ browser }) => {
    test.setTimeout(180_000);
    const h = await harness(browser, shape);

    /* ONBOARDING, AND THE CEILING ON WHAT IT MAY COST. Enrolment is one
       create; where the platform declines to evaluate the PRF at creation it
       is followed by exactly one assertion, and that is the whole budget. A
       third prompt on the way in is the three-ceremony onboarding this app
       deliberately left behind. */
    await enrol(h.page);
    const onboarding = await ceremonies(h.page);
    expect(onboarding.started).toBeGreaterThanOrEqual(1);
    expect(onboarding.started).toBeLessThanOrEqual(2);
    expect(onboarding.done).toBe(onboarding.started);

    /* And the platform's answer about the blob is WRITTEN DOWN, whatever it
       was. It is the cheap half of the Android fix: a profile that knows the
       answer never asks this credential for a blob later, which is the request
       that raised a sheet with nothing selectable in it. */
    expect(await recordedLargeBlobSupport(h.page)).toEqual([shape.largeBlob]);

    /* The name step is where a new Passport lands, on every shape. */
    await h.page.getByRole('button', { name: 'Choose my name' }).click();
    await expect(h.page.getByText(/Choose your .night name/i)).toBeVisible({ timeout: 60_000 });

    await seedClaimedPassport(h.page, alias);
    await h.page.goto('/');
    await onHome(h.page);

    /* THE RETURNING VISIT, WHICH COSTS NOTHING. The session is restored
       silently; a reload is not a sign-in and must not be charged as one. */
    expect(await ceremonies(h.page)).toEqual({ started: 0, done: 0 });
    await expect(h.page.getByRole('heading', { name: new RegExp(`${alias}$`) })).toBeVisible({
      timeout: 30_000,
    });

    /* AND THE SIGN-IN ITSELF: ONE ASSERTION. Signed out deliberately, then
       back in through the one button on the landing screen. */
    await signOutToLanding(h.page);
    await resetCeremonies(h.page);
    await h.page.getByRole('button', { name: /Continue with Passport/i }).click();
    await onHome(h.page);
    expect(await ceremonies(h.page)).toEqual({ started: 1, done: 1 });

    await noCeremonyHung(h.page);
    await h.context.close();
  });
}

test('a passkey that cannot derive a key says so in plain words, and never loops', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  /* THE SHAPE WITH NEITHER EXTENSION. The platform makes the credential
     Passport asked for and returns it without the PRF the wallet seed comes
     from, so there is no Passport to open and nothing to recover — the only
     things that can be held to a standard are what the screen SAYS and what it
     offers to do about it. */
  const h = await harness(browser, { largeBlob: false, prf: false });
  await h.page.goto('/');
  await h.page.getByRole('button', { name: /Continue with Passport/i }).click();

  /* WHAT IT USED TO SAY, AND THE POINT OF THE FIX. "Passport passkeys require
     a valid HTTPS origin or localhost relying-party domain." — on localhost,
     about an origin that was fine, as a bare banner with nothing under it. The
     sentence was an accident of a substring match on the word "security" in
     `errorMessage`; see this file's header. */
  const panel = h.page.locator('.mnob-unusable');
  await expect(panel).toBeVisible({ timeout: 120_000 });
  await expect(panel).toContainText(
    'This passkey cannot be used for Passport on this device — try a different passkey or device.',
  );

  const body = await h.page.locator('body').innerText();
  /* Nothing a reader cannot act on, and nothing that is not true. */
  expect(body).not.toMatch(/HTTPS origin/i);
  expect(body).not.toMatch(/relying[- ]party/i);
  expect(body).not.toMatch(/\bPRF\b/);
  expect(body).not.toMatch(/WebAuthn/i);

  /* AND NO BUTTON THAT WOULD COME BACK HERE. "Create a new passkey" is the
     right offer when somebody ELSE'S passkey answered a picker; it is a loop
     when the passkey this device makes is the thing that failed, because the
     next one is the same passkey. */
  await expect(h.page.getByRole('button', { name: /Create a new passkey/i })).toHaveCount(0);

  /* What IS offered is the door that leads off this platform: the platform's
     own picker, which reaches a passkey held on another device. */
  await expect(h.page.getByRole('button', { name: /Use a different passkey/i })).toBeVisible();

  /* PRESSED AGAIN, because a person in a dead end presses the main button
     again. It must land in the same explained state rather than degrading into
     a raw platform message or a second, contradictory panel. */
  await h.page.getByRole('button', { name: /Continue with Passport/i }).click();
  await expect(panel).toBeVisible({ timeout: 120_000 });
  await expect(panel).toHaveCount(1);
  expect(await h.page.locator('body').innerText()).not.toMatch(/HTTPS origin/i);

  await noCeremonyHung(h.page);
  await h.context.close();
});

/* ------------------------------------------------------------------------ *
 * 2. INSTALLED TO THE HOME SCREEN                                           *
 * ------------------------------------------------------------------------ */

test('installed, Passport offers no install and has no way to leave itself', async ({ browser }) => {
  test.setTimeout(180_000);
  const h = await harness(browser, { largeBlob: false, prf: true, standalone: true });
  await enrol(h.page);
  await seedClaimedPassport(h.page, 'shapestandalone');
  await h.page.goto('/');
  await onHome(h.page);

  /* NO INSTALL OFFER. The control is synthesised the way `home-bar.spec.ts`
     synthesises it — Chromium's own installability heuristics are not a thing
     a test can arrange — and the point is that a browser OFFERING one changes
     nothing here: an installed Passport has nothing to install. */
  await h.page.evaluate(() => {
    const event = new Event('beforeinstallprompt') as Event & {
      prompt?: () => Promise<void>;
      userChoice?: Promise<{ outcome: string; platform: string }>;
    };
    event.prompt = () => Promise.resolve();
    event.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });
    window.dispatchEvent(event);
  });
  await expect(h.page.getByRole('button', { name: 'Install Passport' })).toHaveCount(0);
  /* And the mobile install sheet `pwa.tsx` raises is not there either. */
  await expect(h.page.getByText(/Add Passport to your home screen/i)).toHaveCount(0);

  /* NO DEAD ENDS OUT OF THE WINDOW. An installed PWA has no address bar and no
     back button of its own, so a link that navigated the document away would
     strand the reader inside a Passport showing somebody else's page. Every
     link out is therefore a new tab; the Companion, which has no address yet,
     opens its own note instead of a chat that does not exist. */
  const companion = h.page.getByRole('button', { name: /Chat with your Midnight Companion/i });
  await expect(companion).toBeVisible();
  await companion.click();
  await expect(h.page.getByRole('dialog', { name: /Midnight Companion/i })).toBeVisible();
  await expect(h.page.getByText(/Your Midnight Companion is on its way/i)).toBeVisible();
  await h.page.getByRole('button', { name: 'Got it' }).click();
  await expect(h.page.getByRole('dialog', { name: /Midnight Companion/i })).toHaveCount(0);

  const leaves = await h.page.evaluate(() =>
    [...document.querySelectorAll('a[href]')]
      .filter((anchor) => {
        const href = anchor.getAttribute('href') ?? '';
        if (href.startsWith('#') || href.startsWith('/') || href === '') return false;
        try {
          return new URL(href, location.href).origin !== location.origin;
        } catch {
          return false;
        }
      })
      .filter((anchor) => anchor.getAttribute('target') !== '_blank')
      .map((anchor) => anchor.getAttribute('href')),
  );
  expect(leaves).toEqual([]);

  /* A RELOAD ASKS FOR NOTHING. An installed app is closed and reopened far
     more often than a tab is, and a passkey prompt on every reopening would be
     the app asking to be let in to itself. */
  await resetCeremonies(h.page);
  await h.page.reload();
  await onHome(h.page);
  expect(await ceremonies(h.page)).toEqual({ started: 0, done: 0 });

  await noCeremonyHung(h.page);
  await h.context.close();
});

/* ------------------------------------------------------------------------ *
 * 3. THE TAB GOING AWAY, AND COMING BACK                                    *
 * ------------------------------------------------------------------------ */

/** Tells the document it is hidden, or visible, the way a phone does. */
async function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((state: string) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => state === 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

/** `m:ss` off the screen, as a number of seconds. */
function seconds(line: string): number {
  const match = /(\d+):(\d{2})/.exec(line);
  if (!match) throw new Error(`No clock in ${JSON.stringify(line)}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

test('a claim in its long step survives the tab going away and coming back', async ({ browser }) => {
  test.setTimeout(240_000);
  /* NO SERVICE WORKER, for `claim-progress.spec.ts`'s reason: `public/sw.js`
     serves `/zk/**` cache-first, and a worker's fetches are not the page's, so
     `page.route` would never see the request this test holds open. */
  const h = await harness(browser, { largeBlob: false, prf: true, blockServiceWorker: true });

  /* The account deploy's circuit keys, held in flight for ever. That is what a
     prover taking its minutes looks like from the app's side, and it costs the
     test no CPU at all. Nothing is stubbed to arrange it. */
  await h.page.route('**/zk/**', () => {
    /* Deliberately empty. */
  });

  await enrol(h.page);
  await h.page.getByRole('button', { name: 'Choose my name' }).click();
  await expect(h.page.getByText(/Choose your .night name/i)).toBeVisible({ timeout: 60_000 });
  await h.page.getByLabel('Your Midnight name').fill('shapebackground');
  await expect(h.page.getByText('shapebackground.night is available')).toBeVisible({
    timeout: 30_000,
  });
  await h.page.getByRole('button', { name: /Claim shapebackground\.night/ }).click();

  const account = h.page.locator('.mnid-stepper-item').nth(2);
  await expect(account).toHaveAttribute('data-state', 'active', { timeout: 120_000 });
  const timing = account.locator('.mnid-stepper-timing');
  await expect(timing).toHaveText(/\d+:\d{2} so far/);

  /* Every ceremony this claim owed has been performed by now — the claim's one
     assertion, and the enrolment before it. Backgrounding must not add to it:
     a second prompt raised because the app decided it had lost its place is
     the "the passkey prompt did not finish" report, arriving from a direction
     nobody was watching. */
  const before = await ceremonies(h.page);
  const clockBefore = seconds(await timing.innerText());

  await setVisibility(h.page, 'hidden');
  await h.page.waitForTimeout(6_000);
  await setVisibility(h.page, 'visible');
  await h.page.waitForTimeout(4_000);

  /* THE STEPPER IS WHERE IT WAS, AND STILL RUNNING. Not restarted, not
     collapsed to a spinner, and not silently finished — the same step, still
     active, with the four sub-states it had. */
  await expect(account).toHaveAttribute('data-state', 'active');
  await expect(account.locator('.mnid-substage')).toHaveCount(4);
  await expect(account.locator('.mnid-substage').nth(0)).toHaveAttribute('data-state', 'active');

  /* AND THE CLOCK COUNTED THE TIME THE TAB WAS AWAY. A timer that reset on the
     way back would tell a reader who waited two minutes that they had waited
     four seconds, which is the same lie as a hang. */
  const clockAfter = seconds(await timing.innerText());
  expect(clockAfter).toBeGreaterThan(clockBefore);

  expect(await ceremonies(h.page)).toEqual(before);
  await noCeremonyHung(h.page);
  await h.context.close();
});

test('the balance watch stops asking while the tab is away, and reads once on the way back', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const h = await harness(browser, { largeBlob: false, prf: true });

  /* Counted in front of the boundary and handed straight back to it, so the
     mocked answers are unchanged and only the arithmetic is new. The account's
     own address is what separates a balance read from the registry reads that
     go to the same endpoint. */
  let accountReads = 0;
  await h.page.route('**/indexer.stagenet.shielded.tools/**', async (route) => {
    if ((route.request().postData() ?? '').includes(ADDRESS)) accountReads += 1;
    await route.fallback();
  });

  await enrol(h.page);
  await seedClaimedPassport(h.page, 'shapewatch');
  await h.page.goto('/');
  await onHome(h.page);

  /* Past the chase's first read, so the watch is running and the count below
     is a count of a STEADY watch rather than of the screen arriving. */
  await h.page.waitForTimeout(8_000);
  const settled = accountReads;
  expect(settled).toBeGreaterThan(0);

  /* HIDDEN. A backgrounded tab's timers are throttled to something between
     useless and dishonest, and a Passport on a phone spends most of its life
     here — so the watch stops, rather than piling up reads a phone will
     deliver late and out of order. */
  await setVisibility(h.page, 'hidden');
  await h.page.waitForTimeout(14_000);
  expect(accountReads).toBe(settled);

  /* AND BACK. The first thing a returning reader is owed is a fresh figure:
     they have been looking at one that stopped being watched. */
  await setVisibility(h.page, 'visible');
  await expect
    .poll(() => accountReads, { timeout: 15_000 })
    .toBeGreaterThan(settled);

  await noCeremonyHung(h.page);
  await h.context.close();
});

/* ------------------------------------------------------------------------ *
 * 4. THE BACK GESTURE                                                       *
 * ------------------------------------------------------------------------ */

test('the back gesture closes the sheet on top, and never leaves Passport', async ({ browser }) => {
  test.setTimeout(180_000);
  const h = await harness(browser, { largeBlob: false, prf: true });
  await enrol(h.page);
  await seedClaimedPassport(h.page, 'shapeback');

  /* TWO ENTRIES, so `back()` has somewhere to go. Without this the test would
     pass on a browser that did nothing at all: a history with one entry cannot
     navigate, and the defect would be invisible for the same reason it is
     worst in practice — an installed Passport launched at `/` has nothing
     behind it, and the gesture that finds no entry to pop closes the app. */
  await h.page.goto('/');
  await h.page.goto('/');
  await onHome(h.page);

  /* A witness that does not survive a navigation. Any document-level
     navigation — a reload, a step back to the entry before — takes it with it,
     which is what makes it the assertion rather than the URL: the URL is the
     same on both entries. */
  await h.page.evaluate(() => {
    (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
  });
  const sameDocument = async (): Promise<boolean> =>
    h.page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument === true);

  for (const sheet of ['Send', 'Receive'] as const) {
    await h.page.getByRole('button', { name: new RegExp(`^${sheet}$`) }).first().click();
    await expect(h.page.getByRole('dialog').first()).toBeVisible({ timeout: 30_000 });

    await h.page.evaluate(() => history.back());

    /* THE SHEET CLOSES, AND NOTHING ELSE HAPPENS. No dialog, no scrim left
       behind over a screen nobody can touch, and the document the reader was
       on is the document they are still on. */
    await expect(h.page.getByRole('dialog')).toHaveCount(0, { timeout: 15_000 });
    await expect(h.page.locator('.mnhome-addr-scrim')).toHaveCount(0);
    expect(await sameDocument()).toBe(true);
    await onHome(h.page);
  }

  /* AND A SHEET CLOSED ITS OWN WAY LEAVES NO ENTRY BEHIND. Otherwise the
     entries pile up and the reader's next back press does nothing they can
     see, which is its own kind of broken. */
  const depth = await h.page.evaluate(() => history.length);
  await h.page.getByRole('button', { name: /^Receive$/ }).first().click();
  const receive = h.page.getByRole('dialog').first();
  await expect(receive).toBeVisible({ timeout: 30_000 });
  await receive.getByRole('button', { name: 'Close' }).click();
  await expect(h.page.getByRole('dialog')).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => h.page.evaluate(() => history.length), { timeout: 10_000 }).toBe(depth);
  expect(await sameDocument()).toBe(true);

  await noCeremonyHung(h.page);
  await h.context.close();
});

/* ------------------------------------------------------------------------ *
 * 5. A PHONE'S MEMORY, AND A 19.5 MB CIRCUIT KEY                            *
 * ------------------------------------------------------------------------ */

test('a slow circuit key is waited for once, with the wait on the screen', async ({ browser }) => {
  test.setTimeout(240_000);
  /* WHY THIS IS THE ACCOUNT DEPLOY AND NOT A SHIELDED SEND. The 19.5 MB keys
     (`withdraw_shielded.prover`, `deposit_shielded.prover`) belong to a
     shielded transfer, and tier 1 cannot complete one: there is no prover and
     no chain to take the transaction, which is `stagenet.live.spec.ts`'s job
     and what `send-assets.spec.ts` records as its own boundary. What tier 1
     CAN do is the fetch — the account deploy really reads this contract's
     circuit artefacts over HTTP before it can build anything — so the wait, the
     progress, and the count of requests are all real here. The memoisation
     itself is drilled per branch in `src/lib/zkArtefactCache.test.ts`; what a
     browser adds is that the SHIPPED bundle wraps the provider at all.

     Slow, not blocked. A blocked artefact is `claim-progress.spec.ts`'s dial
     and tests a hang; this one has to arrive, because a fetch that never
     completes can never be asked for a second time and would make the count
     below true for the wrong reason. */
  const h = await harness(browser, { largeBlob: false, prf: true, blockServiceWorker: true });

  const asked: string[] = [];
  await h.page.route('**/zk/**', async (route) => {
    asked.push(new URL(route.request().url()).pathname);
    /* Four seconds an artefact. Slow enough that the read is a wait somebody
       would sit through on a mobile link, and far enough inside
       `ZK_ARTEFACT_IDLE_MS` (90 s) that a second ask for the same artefact
       would be a real second fetch rather than a cache that had merely
       expired. */
    await new Promise((settle) => setTimeout(settle, 4_000));
    await route.continue();
  });

  await enrol(h.page);
  await h.page.getByRole('button', { name: 'Choose my name' }).click();
  await expect(h.page.getByText(/Choose your .night name/i)).toBeVisible({ timeout: 60_000 });
  await h.page.getByLabel('Your Midnight name').fill('shapememory');
  await expect(h.page.getByText('shapememory.night is available')).toBeVisible({ timeout: 30_000 });
  await h.page.getByRole('button', { name: /Claim shapememory\.night/ }).click();

  /* THE WAIT IS EXPLAINED WHILE IT HAPPENS. A reader on a phone watching a
     19.5 MB read over a mobile link is the exact person for whom a screen that
     says nothing is indistinguishable from a screen that has died. */
  const account = h.page.locator('.mnid-stepper-item').nth(2);
  await expect(account).toHaveAttribute('data-state', 'active', { timeout: 120_000 });
  const timing = account.locator('.mnid-stepper-timing');
  await expect(timing).toHaveText(/Usually about \d+ minutes? — \d+:\d{2} so far/);
  const first = seconds(await timing.innerText());
  await h.page.waitForTimeout(5_000);
  const later = seconds(await timing.innerText());
  expect(later).toBeGreaterThan(first);

  /* Counted once the reads have gone quiet, so the census covers all of them
     rather than whichever happened to have been issued at an arbitrary moment.
     Quiet, not "finished": what follows the reads is a proof this tier has no
     prover for, and waiting on that would be waiting on nothing. */
  let settledAt = -1;
  let quiet = 0;
  for (let window = 0; window < 12 && quiet < 2; window += 1) {
    await h.page.waitForTimeout(5_000);
    quiet = asked.length === settledAt ? quiet + 1 : 0;
    settledAt = asked.length;
  }
  /* A census of nothing proves nothing. The account contract publishes eleven
     circuits and a manifest, and all of them are read before a deploy can be
     built, so anything much short of that means the run stopped somewhere
     earlier than this test believes it did. */
  expect(asked.length).toBeGreaterThanOrEqual(11);

  /* ONE FETCH EACH. Measured on stagenet on 2026/09/03, a single mUSD send
     downloaded 117 MB of circuit keys for a transaction that needed 39 MB of
     them, because midnight-js reaches its ZK config provider three times per
     circuit and no layer holds the bytes between. On a phone that is the
     largest allocation Passport ever makes, asked for three times over. */
  const twice = [...new Set(asked.filter((path, index) => asked.indexOf(path) !== index))];
  expect(twice).toEqual([]);

  await noCeremonyHung(h.page);
  await h.context.close();
});

/* ------------------------------------------------------------------------ *
 * 6. A PASSKEY ON ANOTHER DEVICE                                            *
 * ------------------------------------------------------------------------ */

test('a passkey answered from another device is waited for, and asked for once', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  /* THE HYBRID PATH, WHICH IS A HUMAN WALKING TO ANOTHER ROOM. Chrome shows a
     QR code, the passkey is on a phone, and the ceremony resolves when the
     person has finished with it. Forty seconds is a modest version of that and
     is comfortably inside Passport's own watchdog, which is 180 seconds
     (`App.tsx#PASSKEY_CEREMONY_TIMEOUT_MS`) precisely so that this journey is
     not cut off underneath somebody who is doing exactly what they were asked.
     Reported on 2026/08/31 as "the passkey prompt did not finish", underneath
     a cross-device sheet that had very much been shown. */
  const h = await harness(browser, { largeBlob: false, prf: true, slowGetMs: 40_000 });
  await enrol(h.page);
  await seedClaimedPassport(h.page, 'shapehybrid');
  await h.page.goto('/');
  await onHome(h.page);

  await signOutToLanding(h.page);
  await resetCeremonies(h.page);
  await h.page.getByRole('button', { name: /Continue with Passport/i }).click();

  /* WHILE IT WAITS: the working stage, with the instruction that matches what
     the platform is showing, and no second ceremony raised on top of the sheet
     the reader is looking at. */
  await expect(h.page.getByText(/Follow the prompt from your device to continue/i)).toBeVisible({
    timeout: 30_000,
  });
  await h.page.waitForTimeout(20_000);
  expect(await ceremonies(h.page)).toEqual({ started: 1, done: 0 });

  /* AND PASSPORT HAS NOT GIVEN UP. The watchdog's own sentence appearing here
     would mean the wait was cut off at well under its 180 seconds, and the
     copy would be telling somebody mid-way through a QR sign-in that their
     prompt did not finish while it was still on their screen. */
  await expect(h.page.getByText(/The passkey prompt did not finish/i)).toHaveCount(0);
  await expect(h.page.getByText(/Could not load your passkey/i)).toHaveCount(0);

  /* THE RESOLUTION COMPLETES THE SIGN-IN, on the one assertion it started
     with. */
  await onHome(h.page);
  expect(await ceremonies(h.page)).toEqual({ started: 1, done: 1 });

  await noCeremonyHung(h.page);
  await h.context.close();
});
