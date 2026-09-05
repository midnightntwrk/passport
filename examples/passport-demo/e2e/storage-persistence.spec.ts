/**
 * Onboarding, when the browser does not answer about persistent storage.
 *
 * WHAT THE CROSS-BROWSER SUITE FOUND (2026/09/05). The first Firefox run of
 * the mocked tier never reached Home. It stopped at "Encrypting your Passport
 * state on this device" and stayed there: the passkey was made, the PRF was
 * evaluated, the state was written, and then nothing, for ever.
 *
 * The passkey was not the problem. Instrumenting the platform APIs put the
 * stall on one line:
 *
 *     src/pwa.tsx:147   return navigator.storage.persist();
 *
 * awaited on the enrolment path at `src/App.tsx:2681` (and again on the
 * discovery path at `src/App.tsx:2456`), both as of 9970e2e. Firefox answers `persist()` by asking
 * the user for the persistent-storage permission, and until somebody answers
 * that doorhanger the promise is simply pending. In a headless browser there
 * is no doorhanger, so it is pending for ever; in a REAL Firefox there is one,
 * and a user who ignores it — or dismisses it — is left with a Passport frozen
 * mid-sentence with no error, no retry, and no way forward.
 *
 * Persisted storage is a NICETY. It asks the browser not to evict this origin
 * under storage pressure; nothing about the passkey, the account, or the state
 * that has just been written depends on the answer. It has no business on the
 * critical path of onboarding at all, let alone unbounded.
 *
 * THE HARNESS DOES NOT PROVE THIS. `playwright.config.ts` grants the
 * permission to the `firefox` project through `dom.storageManager.prompt.
 * testing`, which is what a user pressing "Allow" does and what lets the other
 * 80 walks run at all. This test is the one that removes the grant, and it is
 * `fixme` rather than failing because the fix belongs in `src/pwa.tsx`, which
 * is being worked on elsewhere. Take the `fixme` off when
 * `requestPassportStoragePersistence` stops being something onboarding can
 * wait on for ever.
 */

import { expect, test } from '@playwright/test';

import { installNetworkBoundary } from './mocks.js';
import { installVirtualAuthenticator } from './passkey.js';
import { walkContextOptions } from './walkContext.js';

test.fixme(
  true,
  'Passport hangs at "Encrypting your Passport state on this device" when navigator.storage.persist() does not settle — src/pwa.tsx:147, awaited at src/App.tsx:2681 and :2456. Not a file this suite owns; the firefox project grants the permission so the rest of the walks can run.',
);

test('onboarding finishes even when the browser never answers about persistent storage', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const context = await browser.newContext(
    walkContextOptions({ viewport: { width: 420, height: 900 } }),
  );
  const page = await context.newPage();
  await installNetworkBoundary(page);
  await installVirtualAuthenticator(context, page);

  /* A permission request nobody answers — the doorhanger left on screen, which
     is a state every browser that prompts for this can be in. */
  await page.addInitScript(() => {
    if (!navigator.storage) return;
    Object.defineProperty(navigator.storage, 'persist', {
      configurable: true,
      value: () => new Promise<boolean>(() => {}),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Continue with Passport/i }).click();

  /* The Passport is made either way. What must not happen is the walk stopping
     on a busy label with a nicety it does not need. */
  await expect(page.getByRole('heading', { name: /Welcome to Passport/i })).toBeVisible({
    timeout: 90_000,
  });
  await context.close();
});
