# Plan A — Decentralised but limited

> **Date:** 2026/04/21
> **Status:** Primary MVP path, adopted 2026/04/21
> **Target:** MVP 1 by end of June 2026
> **Audience:** Partners, collaborators, and stakeholders

---

## TL;DR

Plan A makes the user's **passkey the signing root**. All cryptographic
operations — key derivation, Schnorr signing over JubJub, and proof
construction — run client-side in the user's browser. There is no
MPC committee to operate, no FROST ceremony, and no custody authority
outside the user's own device. Midnight Passport is decentralised
from Day 1.

The cost of that simplification is scope: MVP 1 supports only a
limited browser / OS matrix, does not ship account recovery, and is
strictly one-device-one-account. The trade-off is deliberate — we
trade breadth and recoverability for immediate, demonstrable
self-sovereignty. Genuine multi-device support (two or more physical
devices under one account) is a near-term priority after MVP 1
because it gates any future recovery work; exact timing is to be
refined in the next planning pass.

## What ships in MVP 1

A working browser-based Midnight Passport in which a user onboards
with a passkey, receives a deterministic set of wallet keys
(Shielded, Night, Dust), registers a name, and transacts on devnet.
The account provider exists, but only as a name resolver, JWT issuer,
and rate limiter. A Midnight transaction is signed in the browser
with the user's NightExternal key (derived from the passkey-unlocked
seed); the Midnight node verifies the intent signature against the
signing pubkey. Compact contracts — including the name registry —
trust node-level verification of the signing pubkey; no additional
in-circuit signature check is performed in MVP 1.

## Architecture in brief

Browser holds passkey → derives signing key → signs transaction intent
→ calls account provider for name resolution and (optionally) a JWT
for sponsorship → submits transaction to Midnight. The account
provider never sees key material and cannot produce a signature.
Full depth is in [`architecture.md`](./architecture.md).

## Why this plan — upsides

1. **No novel FROST crypto.** The signing primitive is the same
   single-signer Schnorr-on-JubJub already validated end-to-end in
   `experiments/redjubjub-wallet/` and `experiments/redjubjub-wallet-rs/`.
   No distributed key generation, no partial-signature aggregation,
   no identifiable-abort protocol to specify.
2. **No MPC infrastructure.** There is no n-of-t committee to
   provision, no coordinator to build, no re-sharing cadence to
   operate, no Byzantine test harness to stand up. This removes an
   entire delivery risk surface from MVP 1.
3. **Decentralised from Day 1.** No single-operator trust
   dependency. The user's account is controlled by the user's
   passkey. The account provider is a convenience service for names
   and sponsorship, not a custodian.
4. **Formal-methods hand-off is closer to ready.** The priority-1
   target under Plan A is the name-registry commit-reveal scheme
   with ENSIP-15 normalisation enforced in-circuit — the circuit
   work that actually remains for MVP 1. The in-circuit
   single-signer Schnorr primitive from
   `experiments/redjubjub-wallet*` is preserved and returns as the
   foundation for multi-device under MVP-09 (see below); it is no
   longer on the MVP 1 critical path.

## Downsides — stated honestly

1. **Limited support matrix at MVP.** Passkey behaviour, key-material
   persistence, and WebCrypto availability vary across browsers and
   operating systems. MVP 1 commits only to Browser A × OS-1 and
   Browser A × OS-2 (exact browsers and OSes TBD — see open
   question Q1 below).
2. **No account recovery at MVP.** If the user loses the passkey and
   has no platform sync, the account is gone. This must be stated
   clearly to the user at onboarding.
3. **No multi-device at MVP.** MVP 1 is strictly one-device-one-account
   — one physical device (a single MacBook, a single iPhone) backs one
   account. Platform passkey sync (Apple iCloud Keychain, Google
   Password Manager) may replicate the passkey across the user's own
   devices where they have enabled it; this is convenient but is
   **not** Passport multi-device. Genuine Passport-engineered
   multi-device (two or more physical devices, device-add ceremonies,
   per-device keys) is a near-term priority after MVP 1 — earlier
   than the original Milestone 2 slot — because it gates recovery
   (see R1). Exact timing is to be decided in the next planning pass.
4. **Platform passkey sync is outside our control.** Where a user has
   enabled iCloud Keychain or Google Password Manager, passkey sync
   is a convenience the user has opted into. If the platform rotates
   or replaces passkey material silently, the user can lose access
   without warning (see risk R1). The product design does not rely
   on platform sync.

## Mapping to the six design principles

The reference design principles live in
`docs/reference/machine-investigation/key-flows/secure-onboarding-design.md`.

### Survive unchanged

- **P2 — single seed, three wallets.** Unchanged. A passkey-derived
  root still feeds hierarchical derivation for Shielded, Night, and
  Dust.
- **P5 — privacy-by-design identity.** Unchanged. Credentials layer
  remains independent of the key-custody model.
- **P6 — seedless UX.** Fully met. The user never sees a mnemonic.
  Plan A is arguably stronger than Plan B here because no seed is
  ever generated or held by a third party; the passkey *is* the
  root.

### Shift meaning

- **P1 — keys never leave TEEs.** The "TEE" becomes the browser's
  passkey-backed credential store (WebAuthn / platform authenticator).
  Authorisation via ZK witnesses is preserved: the Schnorr signature
  is consumed as a private witness, exactly as in Plan B.
- **P4 — one key per device.** Redefined as "one key per browser
  instance" at MVP. MVP 1 is strictly one-device-one-account.
  Genuine Passport-engineered multi-device (two or more physical
  devices) is a near-term priority after MVP 1. Platform passkey
  sync (iCloud Keychain, Google Password Manager) may, where the
  user has enabled it, replicate the passkey across the user's own
  devices — this is convenient for that user but is not a substitute
  for Passport multi-device.

### Explicitly deferred to Milestone 2+

- **P3 — chain abstraction via intent model.** Same deferral as in
  Plan B. Chain abstraction is a post-MVP feature in both plans; in
  Plan A it is even more clearly out of scope because there is no
  MPC layer to reuse for cross-chain signing. Cross-chain is a
  Milestone 2+ workstream.

## How the MVP scope changes versus Plan B

| Requirement | Plan B | Plan A |
|---|---|---|
| **MVP-01** — FROST threshold spec | Phase 3 primary deliverable | **Parked** — retained as Milestone 2 input |
| **MVP-02** — in-circuit threshold verification | FROST aggregate signature verified in-circuit | **Removed** — folded into MVP-09 as the 1-of-N in-circuit verification pattern for multi-device. MVP 1 relies on the node-level intent-signature check; no in-circuit signature verification is performed |
| **MVP-03** — account provider API | OAuth-like, handles JWT and recovery hand-off to signing service | **Simplified** — JWT issuer + name resolver + rate limiter; no co-signing |
| **MVP-04** — name registry | Unchanged | Unchanged — ownership is bound by the NightExternal intent signature that the node already verifies |
| **MVP-07** — single-node operational model | Required — we run a signing service | **Removed** — no MPC service to operate |
| **MVP-08** *(new)* — browser support matrix | n/a | Required — names the supported browser / OS pairs. **Status: product-owner-deferred decision** — working recommendation exists, final matrix not locked |
| **MVP-09** *(new)* — multi-device research programme | n/a | Required — research begins Step 1. Label "research programme" still stands for MVP 1, but delivery is expected sooner than originally scoped because multi-device gates recovery. MVP-09 also absorbs the 1-of-N in-circuit Schnorr verification pattern (a natural foundation for multi-device) that was originally MVP-02 |

See `.planning/REQUIREMENTS.md` for the authoritative versions of
these requirements and their success criteria.

## What the account provider does in Plan A

The account provider is a thin service. It has four jobs:

1. **Name resolution.** Given a name (`alice.midnight`), return the
   account's public keys and address records. Most of this is just a
   read of the on-chain name registry (MVP-04); the provider can
   cache and rate-limit.
2. **JWT issuance.** After a passkey challenge, issue a short-lived
   JWT with a `cnf` claim binding the signing-request body. This
   token is consumed by the sponsorship paymaster and by rate
   limiters. See `.planning/design/FEE-SPONSORSHIP-MODEL.md` §5 for
   the issuance policy.
3. **Rate limiting.** Enforce per-device-key and per-IP quotas on
   name registration, sponsored transactions, and any other
   provider-mediated operation.
4. **Optional sponsorship relaying.** The paymaster role defined by
   the fee-sponsorship design still applies in full — the provider
   pays DUST for provider-mediated operations. Custody of the
   paymaster's own DUST is the provider's responsibility; it is
   orthogonal to the user's custody.

The provider has **no custody authority**. It cannot produce a
Schnorr signature under any user's key, because it holds no key
material and no key share. This is the authority-boundary invariant
of Plan A and must be preserved end-to-end.

## Authorisation primitive for MVP 1

The NightExternal intent signature is the MVP 1 authorisation
primitive for every on-chain action, including name registration.
The user's NightExternal key (derived from the passkey-unlocked seed)
signs Midnight transaction intents; the node verifies the signature
against the signing pubkey. Compact contracts — including the name
registry (MVP-04) — bind ownership to that pubkey and trust the
node's intent-signature check. There is no separate on-device
Schnorr key, no per-operation challenge-response with a distinct
device key, and no in-circuit signature verification in MVP 1.

## Open risks

### R1 — Passkey material stability across browser updates *(accepted known risk)*

If the underlying WebAuthn provider rotates the key material bound
to a credential between major browser versions, the user's account
is lost silently. **Accepted as a known risk.** The product owner's
working belief is that Apple iCloud Keychain and Google Password
Manager hold the signing key stable; empirical verification is still
required.

- Primary reference platforms: Apple Passkeys (iCloud Keychain) and
  Google Password Manager.
- Both platforms advertise persistent passkeys, but the security
  story depends on *not* rotating the underlying signing key. This
  must be confirmed against platform documentation AND empirically
  tested as part of Step 1 research.
- **Mitigation sequence.** Account recovery is **not** an independent
  workstream: it can only be built after genuine multi-device support
  exists. The order is therefore **multi-device first, recovery
  second** — MVP-09 (multi-device) is a prerequisite for any future
  recovery work.

### R2 — Browser data clearing *(high)*

If the user clears browser data (site data, indexedDB, or the whole
browser profile), the local state the Passport needs — the
derivation seed, cached name records, any browser-held secrets — is
gone. If the user's passkey is platform-synced, the identity itself
survives; if not, it is lost.

Required UX mitigation: a warning at onboarding, a re-prompt at
sensitive moments, and clear language about what is at risk. R2 is
the primary driver for starting the multi-device research programme
(MVP-09) in Step 1.

### R3 — Incognito / private mode *(explicitly unsupported)*

Incognito and private browsing modes are explicitly out of scope for
MVP 1. We have thought about them, found them incompatible with
persistent passkey-backed key derivation, and left the behaviour
undefined. The MVP surface should refuse onboarding in private mode
rather than create an account that silently disappears at the end of
the session.

### R4 — No account recovery at MVP *(accepted constraint)*

If the passkey is lost, the account is gone. This is the central
cost of Plan A and must be stated to the user at onboarding in plain
language. Recovery **cannot be built until multi-device exists**:
the sequence is multi-device first, recovery second. Recovery design
work feeds MVP-09; delivery depends on multi-device landing first
(see `.planning/design/PLAN-A-architecture.md` for the design space).

## Dependencies and downstream impact

- **Fee sponsorship (`.planning/design/FEE-SPONSORSHIP-MODEL.md`).**
  Applies in full. Sponsorship is orthogonal to the custody pivot —
  the paymaster still holds its own wallet and still signs its own
  fee-bearing branches independently of user custody.
- **DUST funding research (`.planning/research/DUST-funding-and-tx-sponsorship-RESEARCH.md`).**
  Applies in full. Plan A does not change Midnight's DUST model.
- **Formal-methods priority queue.** Priority 1 under Plan A is the
  **name-registry commit-reveal scheme with ENSIP-15 normalisation
  enforced in-circuit** — the circuit work that actually remains
  for MVP 1. The in-circuit single-signer Schnorr primitive
  preserved in `experiments/redjubjub-wallet-rs/` is not on the
  MVP 1 critical path; it returns under MVP-09 as the 1-of-N
  multi-device foundation.
- **Domain-separation registry (STD-03).** Still required, but now
  gates fewer artefacts (no FROST challenge to cover). Revisit
  priority — it may drop from Phase 2 cross-cutting into a lighter
  artefact.

## Open questions

1. **Q1 — browser / OS support matrix.** Which Browser A × OS pair
   should the support matrix name first? Working recommendation
   (adopted as a working assumption, not locked): a Chromium-based
   browser (Chrome or Edge) on macOS and Windows as OS-1 and OS-2,
   with iOS Safari as a stretch candidate. **Status:
   product-owner-deferred decision** — the product owner reserves
   the right to change the matrix; MVP-08 cannot be closed until the
   final matrix is signed off.
2. **Q2 — resolved.** Platform passkey sync is **not** multi-device
   in Passport's definition. One device = one physical device;
   passkey sync across a single user's own Apple or Google devices
   is key replication on behalf of that user and does not support
   the scenarios Passport multi-device is designed for (adding a
   partner's device, recovering from a lost device, rotating device
   keys). Platform sync may still be mentioned in user-facing copy
   as a convenience where the user has enabled it; it is not a
   substitute for Passport multi-device and is not relied on in the
   product design.
3. **Q3 — account-loss UX contract.** What is the UX at the moments
   when an account can be lost (passkey gone, data cleared, private
   mode detected)? Needs a concrete design — Plan A is not
   self-sovereign in spirit if users can lose their account without
   understanding why.
4. **Q4 — name-registry contract shape.** Does the name-registry
   Compact contract need any adjustment to reflect the lighter
   provider role? Most likely no (the registry was already
   user-controlled on-chain), but worth a one-line check against
   MVP-04.
5. **Q5 — STD-03 priority.** The domain-separation registry was
   gating MVP-01 in Plan B; in Plan A it gates fewer artefacts.
   Revisit the Phase 2 priority — it may be smaller work than
   planned.

## Next steps

- Sign off on Q1 (browser / OS matrix) so MVP-08 can be written.
- Start MVP-09 research: verify R1 (passkey material stability) on
  Apple and Google platforms.
- Produce the concrete Plan A architecture document (see
  [`architecture.md`](./architecture.md) adjacent).
- Draft the design-layer spec at
  `.planning/design/PLAN-A-architecture.md` for the next
  `/gsd-plan-phase` run.
- Schedule a legal review of the account-provider boundary under the
  simpler Plan A posture; the regulatory surface shrinks relative to
  Plan B (no custody), but the review item remains.

---

*ARC — Input Output Global, 2026/04/21*
