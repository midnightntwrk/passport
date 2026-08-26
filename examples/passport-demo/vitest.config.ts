/**
 * The unit-test configuration, and — more importantly — the written record of
 * WHICH of this app's own logic is held to a coverage bar and which is not.
 *
 * It merges `vite.config.ts` rather than replacing it. That is not tidiness:
 * the `resolve.dedupe` list there is what collapses `@midnight-ntwrk/
 * compact-runtime` onto ONE copy, and two copies are two `ChargedState`
 * classes and a decode that fails `instanceof` on correct objects. A vitest
 * config that dropped it would make `accountCustody.test.ts` fail in a way
 * that looks like a decoder bug.
 *
 * THE COVERAGE DENOMINATOR
 * ------------------------
 * `coverage.include` is an explicit allow-list, and the threshold on it is
 * 100% of statements, branches, functions, and lines. A percentage is only
 * worth reading if the thing it is a percentage OF is stated, so every module
 * that is NOT in it is named below with the reason. There are no silent
 * exclusions and no wildcards standing in for a decision.
 *
 * WHAT IS OUT, AND WHY — `src/lib`
 * --------------------------------
 * `src/lib/feeReadinessPoll.ts` went IN on 2026/08/25 rather than out with the
 * screens it serves: it is the sponsor watcher, it holds no DOM and no React,
 * and its whole contract — probe now, probe again every five seconds, publish
 * every change, and send the sponsor's diagnostic to a log rather than towards
 * a screen — is drivable on a fake clock. The React that consumes it is three
 * lines of `useEffect` in `SendSheet.tsx`, which stays out with the rest of the
 * `.tsx`.
 *
 *   assert-shim.ts      A three-line stand-in for Node's `assert`, aliased in
 *                       by `vite.config.ts` for @subsquid/scale-codec. It has
 *                       no behaviour of ours in it.
 *   bufferPolyfill.ts   Assigns `globalThis.Buffer`. A test that imported it
 *                       would change the process it runs in.
 *   indexerTx.ts        Every function is an indexer query or a WebSocket
 *                       subscription. A mocked indexer proves nothing about an
 *                       indexer; `e2e/stagenet.live.spec.ts` reads the real one.
 *   localWallet.ts      The wallet facade: WASM ledger, proof server, chain
 *                       sync. It cannot open without a live indexer.
 *   passkeyPresence.ts  WebAuthn. Drilled through a CDP virtual authenticator
 *                       in `e2e/`, which is the only place it can be.
 *   proofWorker.ts      A `Worker` bootstrap.
 *   wasmProver.ts       Instantiates the proving WASM module.
 *   registry.ts         Reads contract state through the indexer provider.
 *   theme.ts            Reads and writes the document element and
 *                       `matchMedia`.
 *   txApproval.ts       Builds and proves transactions through the wallet.
 *   walletSnapshot.ts   Serialises the SDK's own sync state.
 *
 * WHAT IS OUT, AND WHY — `src/identity`
 * -------------------------------------
 *   accountCustody.ts   MIXED, and out for that reason. Its pure half — the
 *                       byte helpers and `decodeAccountState` — IS drilled, in
 *                       `src/identity/accountCustody.test.ts`, against a ledger
 *                       produced by executing the real contract's constructor
 *                       and circuits. Its other half moves money: `deploy`,
 *                       `withdraw_night`, `withdraw_shielded`, `deposit_*`,
 *                       each needing a wallet, a proof server, and a chain.
 *                       Putting the whole file in a 100% denominator would
 *                       either make the gate unmeetable or make it meaningless.
 *                       The moving half is drilled against stagenet by
 *                       `e2e/stagenet.live.spec.ts`.
 *   midnames.ts         MIXED, on the same rule. The read-side helpers —
 *                       `normalizePassportAlias`, `aliasCostAtomicNight`,
 *                       `decodeDomainTarget`, `formatNight`,
 *                       `deriveMidnamesOwnerKey`, `suggestAliasAlternatives` —
 *                       are drilled in `src/identity/midnames.test.ts`. The
 *                       rest is registry reads against a network's own indexer.
 *   aliasStore.ts,      Thin `window.localStorage` records. They are exercised
 *   incentiveStore.ts,  for real (not mocked) by `backup.test.ts`, which
 *   passportContract-   restores through their own save functions so their
 *   Store.ts            invariants are the ones enforced.
 *   callbackLaunch.ts,  The dApp callback protocol: `window.opener`,
 *   callbackProtocol.ts `postMessage`, and cross-origin handshakes.
 *   contractRuntime.ts  Loads the compiled contract modules and the ledger
 *                       WASM, and builds midnight-js providers.
 *   passportContract.ts Deploys and calls the pilot contract.
 *
 * WHAT IS OUT, AND WHY — everything else
 * --------------------------------------
 *   `src/verify/**`     The step verifier: a separate, read-only operator page
 *                       served at `/verify/`. Every function in it is either an
 *                       indexer query, a contract-state decode behind one, or
 *                       DOM construction — the same three reasons `indexerTx.ts`
 *                       and the `.tsx` files are out. It is exercised against
 *                       the real stagenet indexer in a headless browser, which
 *                       is the only place its answers mean anything.
 *   `*.tsx`, `main.tsx`, `pwa.tsx`, `backend.ts`, `publicProfile.ts`
 *                       React components and the browser bring-up around them.
 *                       There is no jsdom in this workspace and adding one
 *                       would only let a test assert against a fake DOM; the
 *                       screens are drilled in a real browser, against a real
 *                       passkey, by `e2e/onboarding.spec.ts`. The pure helpers
 *                       that used to live in `App.tsx` were moved OUT of it
 *                       for this reason — see `src/lib/activation.ts` and
 *                       `src/lib/colour.ts`, both of which are in the
 *                       denominator at 100%.
 */

import { defineConfig, mergeConfig } from 'vitest/config';

import viteConfig from './vite.config.js';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['src/**/*.test.ts'],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json-summary'],
        reportsDirectory: 'coverage',
        /* The denominator. See the module header for every module that is not
           in it and the reason it is not. */
        include: [
          'src/lib/activation.ts',
          'src/lib/address.ts',
          'src/lib/colour.ts',
          'src/lib/feeReadinessPoll.ts',
          'src/lib/networks.ts',
          'src/lib/notifications.ts',
          'src/lib/qrScan.ts',
          'src/lib/sponsor.ts',
          'src/identity/backup.ts',
          'src/identity/sponsoredAlias.ts',
        ],
        /* A file in the list with nothing exercising it must show as 0% rather
           than vanish from the report. */
        all: true,
        thresholds: {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
  }),
);
