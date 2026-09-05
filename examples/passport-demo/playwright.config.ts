/**
 * Browser-level configuration for the two end-to-end tiers.
 *
 * TIER 1 — `e2e/onboarding.spec.ts`, the default project.
 * Runs against a production BUILD of this app served by `vite preview`, with
 * every outbound HTTP call intercepted. It is offline, deterministic, and safe
 * to run in CI. The build is part of starting the server rather than a
 * precondition a reader has to remember, because the sponsor and indexer URLs
 * are baked in at build time — `import.meta.env` is a compile-time
 * substitution, so a spec that mocked one URL against a bundle built for
 * another would mock nothing and pass.
 *
 * TIER 2 — `e2e/stagenet.live.spec.ts`, tagged `@live`.
 * Runs against the deployed https://midnightpassport.com and a real stagenet.
 * It creates a real passkey, claims a real name, and spends real (test) NIGHT,
 * so it is skipped unless `RUN_LIVE=1`, and it does not want a local server.
 *
 * WEBAUTHN, AND WHY THE ENGINE LIST IS NO LONGER ONE.
 * Both tiers need a passkey ceremony that no human attends. Chromium gives one
 * through CDP's `WebAuthn` domain (`WebAuthn.addVirtualAuthenticator`), and
 * until 2026/09/05 that fixed the whole suite to Chromium, because a Passport
 * with no passkey has no wallet, no account contract, and nothing to test.
 *
 * What that reasoning missed is that the ceremony is a small part of Passport.
 * Everything after it — the PRF derivation, the wallet, the WASM prover, the
 * storage, the layout — is the part users actually spend their time in, and
 * none of it was ever run in Safari's engine. `e2e/webauthnStub.ts` supplies
 * the ceremony on the engines that cannot be given a virtual authenticator, so
 * the rest can be asked the question. Chromium still uses the real thing;
 * `e2e/passkey.ts` picks between them off the browser type.
 *
 * THE PROJECTS.
 *   `chromium`        the reference run, unchanged, on a phone-shaped viewport.
 *   `chromium-pixel`  the same engine as a real Android handset reports itself:
 *                     device pixel ratio, touch, and an Android user agent.
 *   `webkit`          Safari's engine on a desktop Mac.
 *   `webkit-iphone`   Safari's engine as an iPhone — the platform most of
 *                     Passport's reviewers hold, and the one no automated run
 *                     had ever touched.
 *   `firefox`         a third engine, as a check that nothing has quietly come
 *                     to depend on a Blink or a WebKit detail.
 *
 * Specs that drive the AUTHENTICATOR rather than the app — planting a resident
 * credential, reading a largeBlob back off it, removing one mid-run — are CDP
 * by nature and skip themselves on the other projects with a stated reason.
 */

import os from 'node:os';

import { defineConfig, devices } from '@playwright/test';

/** True when this run is pointed at the deployed site and a real chain. */
const live = process.env.RUN_LIVE === '1';

/**
 * WEBKIT CANNOT BE LAUNCHED ON macOS 26, and this is where that is admitted.
 *
 * Playwright's bundled WebKit segfaults the instant it opens a page on this
 * OS — headless and headed alike, in `-[WKWebView(WKImplementationMac)
 * _viewDidChangeEffectiveCornerRadii]`, a KVO callback against the corner
 * geometry AppKit gained in macOS 26. Measured on 2026/09/05 against
 * `webkit-2336` (Playwright 1.62.1), `webkit-2359` (1.63.0) and `webkit-2360`
 * (the 1.64 alpha): all three, same frame. It is upstream and it is not
 * something this repository can fix.
 *
 * Leaving the projects in regardless would make `npm run test:e2e` red for
 * everybody on this OS, on a browser that never started — a failure that says
 * nothing about Passport and buries the ones that do. Dropping them silently
 * would be worse: a suite that quietly tests four engines while its README
 * claims five. So they are dropped WITH A LINE ON THE CONSOLE saying which
 * projects went and why, and `PW_WEBKIT=1` forces them back in for anyone who
 * wants to check whether a newer WebKit has fixed it.
 *
 * Darwin 25 is macOS 26. On CI — Linux, or a Mac on an earlier OS — this is
 * false and both WebKit projects run.
 */
const darwinMajor =
  process.platform === 'darwin' ? Number.parseInt(os.release().split('.')[0] ?? '0', 10) : 0;
const webkitRuns = process.env.PW_WEBKIT === '1' || darwinMajor < 25;
if (!webkitRuns) {
  console.warn(
    '[playwright] Skipping the `webkit` and `webkit-iphone` projects: Playwright\'s bundled ' +
      'WebKit crashes on launch on macOS 26 (see playwright.config.ts). Set PW_WEBKIT=1 to run them anyway.',
  );
}

/**
 * The build tier 1 serves. These are the same values the deployment builds
 * with (.github/workflows/deploy-demo.yml, and `deploy:passport:manual` for the
 * break-glass path), minus the raffle origin, so the mocked walk exercises the same
 * code paths the deployment does.
 *
 * The host is `67-205-177-162.sslip.io`. It is not the retired funder name
 * this file carried until 2026/09/02: the 1 GB droplet behind that name was
 * deleted on 2026/08/27 and its address has since been recycled to somebody
 * else, so a build compiled against it points sponsorship and funding at a
 * stranger's machine. The deployment stopped using it that day; this file was
 * the last one still compiling the mocked tier against it, which made tier 1
 * exercise a code path production no longer has.
 * `e2e/mocks.ts` derives every route glob from the same host, so the two cannot
 * drift apart again without the mocked run failing.
 */
const previewEnv = {
  VITE_MIDNIGHT_NETWORK_ID: 'stagenet',
  VITE_SPONSOR_URL: 'https://67-205-177-162.sslip.io/balancer,https://api-stagenet.1am.xyz',
  VITE_FUNDER_URL: 'https://67-205-177-162.sslip.io/balancer',
  VITE_MIDNIGHT_PROVING_URL: 'https://67-205-177-162.sslip.io/prover,https://api-stagenet.1am.xyz',
  VITE_INDEXER_URL: 'https://indexer.stagenet.shielded.tools/api/v4/graphql',
};

export default defineConfig({
  testDir: './e2e',
  /* One worker. Both tiers install a virtual authenticator and drive a single
     Passport through a stateful ceremony; parallel copies would race each
     other's localStorage on the same origin. */
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  /* Proving is minutes, not seconds, on the live tier. The mocked tier never
     goes near a prover and finishes in a fraction of this. */
  timeout: live ? 25 * 60 * 1000 : 90 * 1000,
  expect: { timeout: live ? 5 * 60 * 1000 : 15 * 1000 },
  use: {
    baseURL: live ? 'https://midnightpassport.com' : 'http://localhost:4173',
    /* No action may wait for ever. Without this a click on a control that has
       gone — inside a poll, say — blocks the worker rather than the test, and
       the run hangs past its own test timeout with nothing to show for it.
       Measured here on 2026/08/25, on the live tier's balance poll. */
    actionTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        /* A phone-shaped viewport: the demo ships `is-mobile` layout and the
           Home screen's tab bar only exists there. */
        viewport: { width: 420, height: 900 },
      },
    },
    {
      /* An Android handset as Chrome reports one, device scale factor and all.
         Same engine as `chromium`, so a difference between the two is a
         difference the VIEWPORT and the touch input made — which is the class
         of bug a desktop-shaped run cannot see. */
      name: 'chromium-pixel',
      use: { ...devices['Pixel 7'] },
    },
    ...(webkitRuns
      ? [
          {
            name: 'webkit',
            use: {
              ...devices['Desktop Safari'],
              /* Deliberately the same 420×900 as `chromium`, so a failure here
                 is about the ENGINE and not about a layout the reference run
                 never rendered at either. */
              viewport: { width: 420, height: 900 },
            },
          },
          {
            /* The one that matters most: Safari's engine at an iPhone's width,
               with touch and a mobile user agent. The safe-area insets a real
               handset reports are not emulated by Playwright, so a spec that
               cares about them has to assert on the CSS rather than on the
               rendered inset. */
            name: 'webkit-iphone',
            use: { ...devices['iPhone 14'] },
          },
        ]
      : []),
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        viewport: { width: 420, height: 900 },
        /* THE PERSISTENT-STORAGE PERMISSION, GRANTED — and a note about what
           that is hiding. Firefox answers `navigator.storage.persist()` by
           raising a doorhanger, and a headless Firefox has nowhere to raise
           one, so the promise never settles. Passport AWAITS it on the
           enrolment path, which meant the very first Firefox run stopped dead
           at "Encrypting your Passport state on this device" and every one of
           the 80 walks failed on the same line.
           That is a real defect, not a harness problem: a user who ignores the
           doorhanger meets the same frozen screen. It is recorded and asserted
           on by `e2e/storage-persistence.spec.ts`, currently `fixme` because
           the fix belongs in `src/pwa.tsx:147`. These two prefs are what a person
           pressing "Allow" does, and granting them here is what lets the rest
           of the suite say anything about Firefox at all. */
        launchOptions: {
          firefoxUserPrefs: {
            'dom.storageManager.prompt.testing': true,
            'dom.storageManager.prompt.testing.allow': true,
          },
        },
      },
    },
  ],
  /* No local server for the live tier — the site under test is deployed. */
  ...(live
    ? {}
    : {
        webServer: {
          command: 'npm run build && npm run preview -- --port 4173 --strictPort',
          url: 'http://localhost:4173',
          reuseExistingServer: !process.env.CI,
          timeout: 6 * 60 * 1000,
          env: previewEnv,
          stdout: 'ignore' as const,
          stderr: 'pipe' as const,
        },
      }),
});
