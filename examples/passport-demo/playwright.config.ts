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
 * Both tiers drive WebAuthn through a CDP VIRTUAL AUTHENTICATOR
 * (`WebAuthn.addVirtualAuthenticator`), which is the only way to run a passkey
 * ceremony unattended. That fixes the browser to Chromium: Firefox and WebKit
 * have no equivalent, and a Passport with no passkey has no wallet, no account
 * contract, and nothing to test.
 */

import { defineConfig, devices } from '@playwright/test';

/** True when this run is pointed at the deployed site and a real chain. */
const live = process.env.RUN_LIVE === '1';

/**
 * The build tier 1 serves. These are the same values the deployment builds
 * with (.github/workflows/deploy-demo.yml, and `deploy:passport:manual` for the
 * break-glass path), minus the raffle origin, so the mocked walk exercises the same
 * code paths the deployment does.
 */
const previewEnv = {
  VITE_MIDNIGHT_NETWORK_ID: 'stagenet',
  VITE_SPONSOR_URL: 'https://funder.midnightpassport.com/balancer',
  VITE_FUNDER_URL: 'https://funder.midnightpassport.com/balancer',
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
