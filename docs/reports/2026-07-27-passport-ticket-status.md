# Passport — status of issues #100, #101, and #102

**Date:** 2026/07/27
**Author:** Utkarsh Varma

| Issue | Status | Branch |
|---|---|---|
| [#100](https://github.com/midnightntwrk/passport/issues/100) — Midnames integration | **Delivered**, verified on localnet | `demo/midnames-passport-integration` |
| [#101](https://github.com/midnightntwrk/passport/issues/101) — Proof generation from Dynamic | **Externally blocked**; groundwork delivered | `demo/mn-passport-dynamic-flow` |
| [#102](https://github.com/midnightntwrk/passport/issues/102) — PWA prototype and feasibility report | **Delivered**, with release gates open | `demo/passport-full-flow` |

All three branches are now on `origin`.

---

## #100 — Midnames integration

Integrated against `midnames/sdk`, pinned to revision `83f8422b0b39113d5c14aa8adc3d42804edaf492` — the current head of the `preview` branch Hector linked, so this is the version that works on preview.

| Acceptance criterion | Evidence |
|---|---|
| Midnames deployed on a local network | `deployMidnamesTld(...)` deploys the `.night` TLD from the pinned contracts on every run. |
| The AAC claims an alias through Midnames | `alice.night` is registered to the deployed account-custody contract, then resolved again from an unrelated wallet to prove the binding is readable by third parties. |
| An external account deposits a shielded token using the alias, calling the deposit circuit | A second funded wallet mints a shielded token, resolves `alice.night`, and calls `deposit_shielded` on the resolved address. The scenario then waits for the AAC ledger to actually hold the coins before passing. |

Re-run end to end on 2026/07/27 to confirm it still passes: `.night` TLD at `0bc43835dd2d8f40…`, `alice.night` registered to AAC `8a41ec09c6353ae3…` (tx `00281d1157ba4303…`), external resolution verified, shielded deposit by alias in tx `00bd1c8436f857a9…`, and the AAC ledger confirmed holding the 500 units. Result: `lifecycle-midnames: PASS`.

Run it with `npm run test:midnames` (requires the localnet, `bun`, and `compact`). `midnames:prepare` clones and builds the pinned Midnames contracts into `.cache/`, so no manual checkout is needed. Each run writes `midnames-deployment.json` with the addresses and transaction IDs.

**Caveat:** exercised on localnet only. Preview requires network access we do not yet have.

---

## #101 — Proof generation from Dynamic

Blocked upstream, exactly as the ticket anticipated. Executing a Compact circuit needs the call-proved transaction balanced and finalised against DUST, and Dynamic exposes no endpoint for that. No Dynamic signature reaches the chain for a custody call today.

Delivered as groundwork on `demo/mn-passport-dynamic-flow`:

- The discarded-signature defect is fixed. The Dynamic signature is now an approval receipt bound to one exact intent, required, fingerprinted, surfaced, and expiry-checked before any broadcast.
- Dynamic's supported transfer path (`createTransferTransaction` → `signTransaction` → `submitTransaction`) is wired end to end where it genuinely applies.
- `probeDynamicCompactSupport` detects the missing capability and will flag the release that adds it.

The API contract Dynamic needs to ship, with request and response shapes and eight behavioural requirements, is in [`2026-07-27-dynamic-transaction-signing.md`](./2026-07-27-dynamic-transaction-signing.md).

**Next action, before waiting on Dynamic:** push one call-proved Passport transaction through the existing `signTransaction` on preview. The SDK does not structurally restrict that method to transfer drafts, so it either works or yields a concrete error for Dynamic. Blocked on preview/stagenet access.

---

## #102 — PWA prototype and feasibility report

All four deliverables are on `demo/passport-full-flow`: the installable PWA (`examples/passport-demo`), the feasibility report (`docs/sdk/pwa-feasibility-report.md`), the blocker analysis, and the separate-origin profile client (`examples/passport-profile-client`), which receives only a consent-approved public DTO over an exact-origin `postMessage` and cannot read Passport storage.

The report's recommendation is a **conditional GO** for a testnet prototype and supervised mobile pilot, and a **NO-GO** for the PWA as the only production client today.

Open release gates, carried in the report rather than hidden:

- Recovery from browser storage loss — `navigator.storage.persist()` is requested, but site-data deletion still wins.
- Physical-device matrices (iPhone/iPad, Android, desktop Safari/Firefox) not yet executed.
- Installed-mode Dynamic OAuth validation on real devices.
- Payload: 5.86 MB JS (954 KB gzip) and 10.42 MB ledger WASM (4.68 MB gzip) need optimisation before a pilot.
- 20 transitive production advisories in Dynamic 4.93.1 (14 moderate, 6 high), with no non-downgrade remedy available.

---

## What we need from others

1. **Preview/stagenet access** for the team's GitHub handles. It blocks the #101 experiment and any non-localnet verification of #100.
2. **Dynamic:** confirmation of the balance-and-finalise contract in the #101 report, and a timeline.
3. **Review shape:** `demo/passport-full-flow` is large. Happy to split it into smaller PRs before review if that is preferred — say the word and it will be broken up rather than landed as one.
