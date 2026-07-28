# Passport — review and verification guide for #100, #101, and #102

**Date:** 2026/07/28
**Purpose:** let a reviewer check each acceptance criterion themselves, criterion by criterion, without reading the whole branch or taking any claim on trust.

Every row below names where the work lives, what proves it, and the command that reproduces the proof. Where something is not done, it says so instead of pointing at an adjacent thing that is.

## Branches under review

| Branch | Head | Covers |
|---|---|---|
| `demo/midnames-passport-integration` | `d50c513` | #100 |
| `demo/mn-passport-dynamic-flow` | `0c496b8` | #101 |
| `demo/passport-full-flow` | `257f2d6` | #102 (and carries the #100 node integration as `b7c5b89`) |

Prerequisites for any local run: Docker, Node ≥ 22, `compact` 0.31.1 on PATH, and `bun` (Midnames contracts only).

---

## #100 — Midnames integration

**Branch:** `demo/midnames-passport-integration`, one commit on top of the Dynamic flow: `d50c513 feat: integrate Passport with Midnames preview` (14 files, +1083).

Pinned to `midnames/sdk` revision `83f8422b0b39113d5c14aa8adc3d42804edaf492`, which is the current head of the `preview` branch. `scripts/prepare-midnames-preview.mjs` clones and builds that exact revision into `.cache/`, so a reviewer does not need a manual checkout and cannot accidentally test a different version.

| Acceptance criterion | Implementation | What proves it | Verify it yourself |
|---|---|---|---|
| Midnames deployed on a local network | `src/integrations/midnames/preview.ts` → `deployMidnamesTld` | Scenario deploys the `.night` TLD fresh on every run and prints its address | `npm run test:midnames` |
| The AAC claims an alias using Midnames | `preview.ts` → `claimPassportAlias`, `resolvePassportAlias` | `alice.night` is registered to the deployed AAC, then resolved again **from an unrelated wallet** — a third party can read the binding, not just the owner | Same run, line `external resolution verified` |
| An external account deposits a shielded token using the alias, calling the deposit circuit | `preview.ts` → `depositShieldedByAlias`; scenario in `src/tests/lifecycle-midnames.ts` | A second funded wallet mints a shielded token, resolves the alias, and calls `deposit_shielded` on the **resolved** address. The scenario does not pass on transaction submission — it waits for the AAC ledger to hold the coins | Same run, line `✓ ledger: AAC holds 500 shielded units deposited through alice.night` |

Supporting: `test/midnames.test.ts` (alias normalisation, nested-alias rejection, address normalisation, owner-key domain separation), `MIDNAMES-INTEGRATION.md` (run instructions, acceptance flow, code map), and `midnames-deployment.json`, written on every run with the addresses and transaction IDs.

**Verified run, 2026/07/27:**

| Item | Value |
|---|---|
| `.night` TLD | `0bc43835dd2d8f407703d6ed20dbcec2117ffc31613c56515ec8d7205c14ee7a` |
| AAC | `8a41ec09c6353ae341c7bfe0cc01115eb96fca3acf9586a78d4a0200dec7e6ef` |
| Alias registration tx | `00281d1157ba4303b8be1c5bacb9f3a576fdc99c4a76219859eeb14bee3f070af0` |
| Shielded mint tx | `00521f1f95261d92f3bda7d8ef52eb9c8d4fb1323fa17d697eb51c8de32032d9d9` |
| Deposit-by-alias tx | `00bd1c8436f857a9f3fbd94674d2744143976f68879360f6a9adac8c02e1955726` |
| Result | `lifecycle-midnames: PASS` |

### Not claimed for #100

- **The browser demo does not use Midnames.** The integration is proven at the contract and client-library level through the scenario above; the demo UI still resolves through the local `identity_registry` contract we wrote earlier. Wiring the UI to Midnames is real remaining work, not covered by any commit on either branch.
- **Localnet only.** Nothing has been run against preview — that needs access we do not have.

---

## #101 — Proof generation from Dynamic

**Branch:** `demo/mn-passport-dynamic-flow`. Relevant commits: `43819b7` (approval binding and the transfer path), `7b38225` (the contract Dynamic must ship), `997c662` and `0c496b8` (status reporting).

**Status: externally blocked.** None of the three acceptance criteria can be met with any API Dynamic ships today, and none is ticked.

| Acceptance criterion | Status | Why |
|---|---|---|
| Get the balanced proof from Dynamic instead of the secret keys from the iframe | Blocked | Dynamic exposes no balance-and-finalise endpoint for a call-proved Compact transaction. Note the premise: we have never taken secret keys out of the iframe — the custody transaction is funded and signed by a separate demo wallet. |
| Broadcast the received proof, landing the transaction on Midnight | Blocked | Depends on the row above. |
| Replicable on local network, then preview/preprod | Blocked | Also gated on preview/stagenet access. |

What was delivered against it, and can be reviewed now:

| Work | Where | Proof |
|---|---|---|
| The discarded-signature defect is fixed; an approval is now bound to one exact intent, required, fingerprinted, and expiry-checked before broadcast | `src/wallet/dynamic-approval.ts`, `app/src/views/FoundationsFlow.tsx` | `npx vitest run test/dynamic-approval.test.ts` — 7 tests: message binding, deterministic argument order, empty signature, rejected signature, expiry |
| Dynamic's supported transfer path wired end to end where it genuinely applies | `app/src/lib/dynamicTransactions.ts` → `transferWithDynamicWallet`, surfaced in `app/src/views/WalletPanel.tsx` | `createTransferTransaction` → `signTransaction` → `submitTransaction`, requiring a real tx hash; pre-broadcast failures revert the draft |
| Capability detection, so the adaptation is a small change | `probeDynamicCompactSupport` | Looks for `getMidnightProofCapabilities` and `proveMidnightTransaction`; reports the gap in the UI today |
| The API contract Dynamic must ship | [`2026-07-27-dynamic-transaction-signing.md`](./2026-07-27-dynamic-transaction-signing.md) | Request/response shapes, eight behavioural requirements, and where the handoff sits |

**Stated plainly, because the UI shows a Dynamic prompt:** no Dynamic signature reaches the chain for a custody call. The transaction is signed, balanced, and paid for by the demo wallet's own keystore (`app/src/lib/providers.ts`). We have not used Dynamic to call a contract and cannot yet.

**Next action that does not depend on Dynamic:** push one call-proved Passport transaction through the existing `signTransaction` on preview. The SDK does not structurally restrict that method to transfer drafts, so it either works or produces a concrete error to hand to Dynamic. Blocked on access.

---

## #102 — PWA prototype and feasibility report

**Branch:** `demo/passport-full-flow`, 8 commits ahead of `main`, head `257f2d6`.

| Deliverable | Implementation | Verify it yourself |
|---|---|---|
| Demo turned into a PWA prototype | `examples/passport-demo` — `public/manifest.webmanifest`, `src/pwa.tsx` | `npm run test:pwa` (builds, then `check-pwa.mjs` asserts the manifest fields and the service-worker boundary) |
| Pros/cons and feasibility report | `docs/sdk/pwa-feasibility-report.md` | Read the Recommendation and Prototype Evidence tables; every row states implemented, partial, blocked, or not executed |
| Blockers identified, including fs read/write | Same report: "File-system limits", "Service-worker boundary", "Proof generation and backgrounding", "Payload and cold start"; plus `docs/sdk/blockers.md` | — |
| Separate application reads the passport profile | `examples/passport-profile-client/src/main.tsx` | `npm run demo` and `npm run demo:profile-client`, then request a profile from the second origin |
| Nice to have: share data from the user's storage | Same flow — consent-gated per field set | The client verifies `event.origin` and the popup handle before accepting, and receives only an approved public DTO |

Supporting: `docs/sdk/validation-log.md` records what was run and when; `npm run test:sdk` and `npm run test:c1` cover the SDK and the C1 draft path.

### Open release gates (in the report, not hidden)

- Recovery from browser storage loss — `navigator.storage.persist()` is requested; site-data deletion still wins.
- Physical-device matrices (iPhone/iPad, Android, desktop Safari/Firefox) not executed.
- Installed-mode Dynamic OAuth on real devices not validated.
- Payload: 5.86 MB JS (954 KB gzip), 10.42 MB ledger WASM (4.68 MB gzip).
- 20 transitive production advisories in Dynamic 4.93.1 (14 moderate, 6 high); npm's only remedy is a downgrade that predates the WaaS integration we need.

---

## Suggested reading order for review

1. `MIDNAMES-INTEGRATION.md`, then `src/tests/lifecycle-midnames.ts` — #100 is easiest to judge by reading the scenario, since it asserts on ledger state rather than on transaction receipts.
2. `2026-07-27-dynamic-transaction-signing.md` — #101's blocker and the exact ask for Dynamic.
3. `docs/sdk/pwa-feasibility-report.md` — #102's recommendation and evidence table.

`demo/passport-full-flow` is 8 commits and touches a lot. If a smaller review is preferred, it can be split into the SDK, the PWA shell, and the profile client as separate PRs — say so and it will be broken up rather than landed as one.
