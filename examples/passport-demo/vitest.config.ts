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
 * `src/lib/accountOnPasskey.ts` went IN on 2026/08/31, the day it was written,
 * and it is in the denominator because it decides whether somebody is asked to
 * touch an authenticator. It is the rule that replaced a blob write fired at
 * the end of a name claim — a whole user-verified assertion, which arrived as
 * a passkey prompt sitting on top of a finished Home screen that the reader
 * had pressed nothing to summon. Every branch in it is either a way of asking
 * for a ceremony nobody wanted or a way of silently never writing at all, and
 * both have been met. It holds no DOM, no React, no storage, and no WebAuthn:
 * a profile in, a decision out, drilled directly in
 * `src/lib/accountOnPasskey.test.ts`.
 *
 * `src/lib/appBusy.ts` went IN on 2026/08/26, the day it was written. It is the
 * counter that answers "is Passport in the middle of something?" for the
 * service-worker update path in `src/pwa.tsx`, and getting that answer wrong in
 * either direction is a user-visible failure: too eager and a reload lands
 * inside a proving run, too cautious and an installed client never picks up a
 * deployment. It holds no DOM, no React, and no timers — it is a counter, a
 * listener set, and the rule that a release only counts once — so every one of
 * those branches is drilled directly in `src/lib/appBusy.test.ts`.
 *
 * `src/identity/claimWarmup.ts` went IN on 2026/08/26, the day it was written,
 * and it belongs in the denominator more than most: it is the module that
 * decides whether a claim may REUSE an answer to "is this name still free" and
 * "will the service register it" instead of asking again. Getting that wrong is
 * not a slow screen, it is a claim that proceeds to a passkey prompt and an
 * account deploy on a stale "available" — the exact refusal the pre-checks
 * exist to make before the ceremony. Every rule that makes reuse safe is a
 * branch in this file: the key is the name AND the network, the TTL expiry
 * forces a re-probe, a non-answer is never cached, a rejection is never cached,
 * and a refusal is handed back as the refusal it was. It holds no DOM, no
 * React, no `fetch` and no clock of its own — the probes and the clock are
 * injected — so all of it is drilled directly on a fake clock in
 * `src/identity/claimWarmup.test.ts`.
 *
 * `src/lib/claimSteps.ts` went IN on 2026/08/30, the day it was written, and it
 * is in the denominator for the same reason `claimWarmup.ts` is: it is a RULE,
 * not a rendering. It decides which of the three steps a person is told they
 * are on for each of the claim's seven phases, and the ways it can be wrong are
 * all ways of lying to somebody who is waiting — ticking a step that has not
 * happened, leaving one un-ticked behind the running one, or skipping the
 * passkey prompt's own step so the one moment that needs the user's hand goes
 * unannounced. It holds no DOM, no React, no clock, and no I/O: a phase in,
 * three labelled states out, so every phase and every ordering invariant is
 * drilled directly in `src/lib/claimSteps.test.ts`. The JSX that paints circles
 * and lines from its answer stays out with the rest of the `.tsx`.
 *
 * It grew a second job on 2026/08/31 and it belongs in the denominator for the
 * same reason: the words a waiting person is told about TIME. It holds each
 * step's expected duration, the four sub-states the long step is made of, and
 * the three sentences a timing line can be — inside the estimate, past it, or
 * waiting on the reader. Every one of those is a way of lying to somebody who
 * is waiting: an estimate said as a promise, a counter that resets when a
 * phase changes, a stage that freezes at its estimate rather than admitting it
 * has run over. The clock ITSELF — the interval, the start times, the cleanup —
 * stays in the screen, because it is a timer and not a rule; what is drilled
 * here is what the screen is allowed to say with it.
 *
 * `src/lib/endpoints.ts` went IN on 2026/08/31, the day it was written, and it
 * belongs in the denominator because it is the rule that decides WHERE a
 * transaction gets proved and who pays for it. Until that day proving, fee
 * sponsorship, sponsored name registration, and activation grants all rode one
 * droplet; two of those four now take an ordered list of providers, and this is
 * the part of that which is a decision rather than a network call. Every way it
 * can be wrong is a way of making the demo LESS reliable than the single URL it
 * replaced: an order silently reshuffled would make "gateway first" untestable,
 * an endpoint dropped from the list would be a single point of failure nobody
 * knows they have, a refusal swallowed rather than carried would strip the
 * error a caller needs to tell a busy sponsor from a dead one, and — the worst
 * of them — a fallback that reported success when nothing served would claim a
 * covered fee that was never covered. It holds no `fetch`, no clock, and no
 * environment: an array in, a decision out, with the asking injected. So the
 * ordering, the skip-unready case, the fall-through-on-failure case, the
 * all-refused case, and the single-endpoint compatibility case are all drilled
 * directly in `src/lib/endpoints.test.ts`. The HTTP either side of it — the
 * `/wallet-status` probe, the `/balance-only` POST, and the proof server's
 * `/prove` — stays out with the rest of the network calls, and is drilled
 * against the real 1AM stagenet gateway and our own balancer instead.
 *
 * `src/lib/activityFeed.ts` went IN on 2026/08/30, the day it was written, and
 * it is in the denominator because it is the only place a person can go back and
 * check what happened to their own money. Every function in it is a way of
 * misleading them if it is wrong: a relative time that rounds up claims more
 * elapsed time than has elapsed; a day heading taken off the elapsed
 * milliseconds rather than the reader's own calendar files this morning's
 * transfer under "Yesterday"; a dot that flattened `blocked` into `complete`
 * would say something happened that did not; and a stored-row reader that
 * accepted a row with no label would paint an empty line with a dot beside it.
 * It holds no DOM, no React, no storage, and no clock of its own — the clock is
 * injected everywhere but the two cases that exercise the default — so all of it
 * is drilled directly in `src/lib/activityFeed.test.ts`. The `window.localStorage`
 * call between its parse and its writer is two lines in `App.tsx` and stays out
 * with the rest of the app shell.
 *
 * `src/lib/recipientName.ts` went IN on 2026/08/30, the day it was written. It
 * decides which of two completely different things happens to what somebody
 * typed into the recipient field — a `.night` registry read, or a bech32m
 * decode — and every way it can pick wrong is a way of showing a person the
 * wrong refusal about the wrong thing: "that is not a Midnight address" about a
 * name they typed correctly, or "no Passport has this name" about a mistyped
 * address. Its cache decides how often the registry is asked, and getting that
 * wrong is either a network read per keystroke or an answer that has gone stale
 * inside one sheet. It is regular expressions, a Map, and a string tail — no
 * DOM, no React, no network, and deliberately no import of
 * `identity/midnames.ts`, whose every import pulls the ledger in behind it — so
 * all of it is drilled directly in `src/lib/recipientName.test.ts`. The
 * debounce, the resolving state, and the confirmation chip stay out with the
 * rest of the `.tsx`.
 *
 * `src/lib/qrPayload.ts` went IN on 2026/08/31, the day Receive learned to draw
 * a code rather than only read one. It is the ONE place both directions of the
 * QR format are written down, and an encoder and a decoder that drift apart
 * produce a square Passport draws and Passport cannot read — a failure that
 * looks like a broken camera and is not. The rules it holds are all rules about
 * trust: which query parameter is honoured and which is ignored, that an
 * embedded account is kept only when it is exactly 32 bytes of hex, that an
 * all-upper scan is the same payload as a lower-case one, and that a URL or a
 * Wi-Fi config is nothing at all rather than something to act on. It is regular
 * expressions, a `URLSearchParams`, and one call into `recipientName.ts` so
 * there is a single definition of what a Passport name may be — no DOM, no
 * React, no camera, and no canvas — so every branch is drilled directly in
 * `src/lib/qrPayload.test.ts`. The camera, the image decode, and the SVG that
 * paints the answer stay out with the rest of the `.tsx`.
 *
 * `src/lib/sendAssets.ts` went IN on 2026/08/31, the day the Send sheet stopped
 * inferring what was being sent from the address it was going to. It is the
 * module that answers two questions about somebody's money: what this account
 * can send, and where each of those things is allowed to go. Both ways of
 * getting the first wrong are visible on the picker — an asset missing from a
 * list of what is held, or two options carrying the same ticker over different
 * colours, which is the wrong-send the naming work exists to prevent. Getting
 * the second wrong is worse and quieter: a refusal that does not name the asset
 * leaves somebody re-reading an address that was never the problem, and a rule
 * that accepted a mismatch would offer a send the ledger cannot make. It holds
 * no DOM, no React, no network, and no wallet SDK — the address taxonomy stays
 * in the sheet with the codec that owns it, and this only checks that answer
 * against a choice — so every entry, every ordering rule, and every sentence is
 * drilled directly in `src/lib/sendAssets.test.ts`. The picker itself, the
 * amount field it drives, and the review rows stay out with the rest of the
 * `.tsx`.
 *
 * `src/lib/shieldedNote.ts` went IN on 2026/08/31, the day it was written, and
 * it is in the denominator because getting it wrong loses somebody money
 * quietly. It decides WHICH shielded note the second leg of a Passport-to-
 * Passport transfer deposits, and the deposit takes a note WHOLE — so a wallet
 * that already held a note of the same colour and the same size offers two
 * candidates the moment the first leg lands, and picking the older one pays the
 * recipient out of money the sender had put aside and strands the note the
 * transfer produced. Every branch in it is either a way of matching on
 * resemblance instead of identity or a way of acting on a note that cannot be
 * read at all, and both are met. It holds no DOM, no React, no network, and no
 * wallet SDK — the notes are read in `identity/accountCustody.ts` and handed
 * in — so all of it is drilled directly in `src/lib/shieldedNote.test.ts`. The
 * poll that calls it, its deadline, and the transfer's two submissions stay out
 * in `App.tsx` with the rest of the app shell.
 *
 * `src/lib/passkeyRecovery.ts` went IN on 2026/08/30, the day it was written,
 * and it is in the denominator because it is the rule that decides whether a
 * person who cannot sign in is offered a way forward or only an explanation.
 * Both ways of getting it wrong are user-visible and neither is loud: too
 * cautious and the reported dead end comes straight back — records here, no
 * credential the keystore will produce, and a screen that can only describe
 * that; too eager and Passport suggests enrolling a second passkey to somebody
 * whose first one worked perfectly and whose actual failure was a decryption or
 * a chain read. It holds no DOM, no React, no WebAuthn, and deliberately no
 * import of `backend.ts` — the authenticator's reason is passed in as a string
 * — so every branch is drilled directly in `src/lib/passkeyRecovery.test.ts`.
 * The two `catch` blocks in `App.tsx` that consult it, and the panel in
 * `Onboarding.tsx` that renders its answer, stay out with the rest of the app
 * shell and the `.tsx`.
 *
 * `src/lib/feeReadinessPoll.ts` went IN on 2026/08/25 rather than out with the
 * screens it serves: it is the sponsor watcher, it holds no DOM and no React,
 * and its whole contract — probe now, probe again every five seconds, publish
 * every change, and send the sponsor's diagnostic to a log rather than towards
 * a screen — is drivable on a fake clock. The React that consumes it is three
 * lines of `useEffect` in `SendSheet.tsx`, which stays out with the rest of the
 * `.tsx`.
 *
 * `src/lib/sendLegs.ts` and `src/lib/walletProver.ts` went IN on 2026/09/02.
 * Both were written on 2026/09/02 WITH their drills — `sendLegs.test.ts` and
 * `walletProver.test.ts` — and both were left out of this list, which is worse
 * than an exclusion with a reason: their coverage was being measured and then
 * thrown away, so the 100% bar was a percentage of a denominator that quietly
 * did not include the two newest rules in `src/lib`.
 *
 * `sendLegs.ts` is the record a two-leg payment survives a reload in, and every
 * function in it decides what happens to value that has already left somebody's
 * account: which stored rows may be resumed, whether a failed leg is worth
 * retrying, how long to wait, and what the person is told about where their
 * money is. Dropping a row is losing a payment; retrying an unretryable one is
 * spending twice. It holds no React, no DOM, no `fetch`, no storage, and no
 * clock — the orchestrator in `App.tsx` does all of that and hands it what came
 * back — so all of it is drilled directly.
 *
 * Admitting it cost one test. `walletProver.ts` was already whole, but
 * `sendLegs.ts` came in at 98.54% of branches: `serialisePendingSends` writes
 * its optional keys as conditional spreads, and the run that omits BOTH
 * `withdrawTxHash` and `expectedNote` — a `withdraw` record written before the
 * first leg is submitted, the one moment in a payment where nothing has been
 * spent yet — was the only shape no drill had. That is not an accident of
 * counting: it is the record that decides whether a person who reloads mid-pay
 * is offered their money back, so `sendLegsRecord.test.ts` — a file this
 * change writes, beside the module's existing suite rather than inside it —
 * closes it. The other three optional keys were already covered by the drills
 * around it, and the existing suite is left exactly as its author wrote it.
 *
 * `walletProver.ts` is the wallet's own proving path: it is the module that
 * keeps the proof server's URL PATH, which is the whole of the shielded-send
 * failure it was written to fix, and it carries the failover between proof
 * servers for the wallet's circuits. Its network is injected as a
 * `ProvingProviderLike`, so the rules — the path, the order servers are tried
 * in, the provider being built once, and the refusal that tells midnight-js the
 * server resolves the protocol builtins itself — are drilled against a local
 * HTTP server rather than a real prover.
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
 *   midnames.ts         MIXED, on the same rule. The naming rules it used to
 *                       hold are now `./midnamesText.ts`, which IS in the
 *                       denominator above. The read-side helpers —
 *                       `normalizePassportAlias`, `aliasCostAtomicNight`,
 *                       `decodeDomainTarget`, `formatNight`,
 *                       `deriveMidnamesOwnerKey`, `suggestAliasAlternatives` —
 *                       are drilled in `src/identity/midnames.test.ts`. The
 *                       rest is registry reads against a network's own indexer.
 * `src/identity/midnamesText.ts` went IN on 2026/09/01, the day it was split
 * out of `midnames.ts`, and it is in the denominator because it is now the ONLY
 * definition of what a Passport name may be: the label grammar, the reserved
 * list, the `.night` suffix, and the alternatives offered when a name is taken.
 * Every way it can be wrong is permanent — a label that normalises to something
 * other than what the registry will store is a name registered, publicly and
 * irreversibly, to a string the user did not type, and a reserved name that
 * slips through is `midnight.night` reading as an official account. It exists
 * as a separate file precisely so it can be imported without a ledger, so it
 * holds no DOM, no React, no network, no clock, and — by construction — no
 * imports at all. The drills did not move either: `midnames.test.ts` exercises
 * every one of these through `midnames.ts`'s re-export, which is where the rest
 * of the app still reads them from.
 *
 * `src/identity/timestamps.ts` went IN on 2026/08/26 with the module itself: it
 * is the ISO-8601 reader `backup.ts` and `incentiveStore.ts` now share, it is
 * four lines of pure decision, and both of its answers are drilled by
 * `backup.test.ts`.
 *
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
          'src/lib/accountOnPasskey.ts',
          'src/lib/activation.ts',
          'src/lib/activityFeed.ts',
          'src/lib/address.ts',
          'src/lib/appBusy.ts',
          'src/lib/claimSteps.ts',
          'src/lib/colour.ts',
          'src/lib/endpoints.ts',
          'src/lib/feeReadinessPoll.ts',
          'src/lib/networks.ts',
          'src/lib/notifications.ts',
          'src/lib/passkeyRecovery.ts',
          'src/lib/qrPayload.ts',
          'src/lib/qrScan.ts',
          'src/lib/recipientName.ts',
          'src/lib/sendAssets.ts',
          'src/lib/sendLegs.ts',
          'src/lib/shieldedNote.ts',
          'src/lib/sponsor.ts',
          'src/lib/walletProver.ts',
          'src/identity/backup.ts',
          'src/identity/claimWarmup.ts',
          'src/identity/midnamesText.ts',
          'src/identity/sponsoredAlias.ts',
          'src/identity/timestamps.ts',
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
