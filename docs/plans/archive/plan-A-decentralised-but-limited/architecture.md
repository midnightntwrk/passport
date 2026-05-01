# Plan A — Architecture

> **Date:** 2026/04/21
> **Status:** Draft — primary MVP architecture following the 2026/04/21 pivot
> **Supersedes (for MVP 1):** `../plan-B-slow-but-universal/architecture.md`

---

## 1. Problem statement

Midnight's zero-knowledge technology offers strong privacy guarantees,
but the user experience for key management remains a barrier. The
original MVP (Plan B) proposed to solve the UX problem by running a
FROST threshold-signing committee on the user's behalf. That path is
still open (see Plan B) but it depends on infrastructure — an MPC
federation operated by a single trust party at MVP and expanded
later — that does not exist yet and is expensive to build.

Plan A takes a different route. It uses the user's **WebAuthn
passkey as the signing root**, derives Midnight wallet keys in the
browser, and signs Midnight transaction intents in the browser with
the user's NightExternal key. The Midnight node verifies the intent
signature against the signing pubkey; Compact contracts (including
the name registry) bind ownership to that pubkey and trust the
node's intent-signature check. The account provider becomes a thin
service that does not hold keys. Midnight Passport is decentralised
from Day 1, at the cost of a limited browser / OS matrix, no
recovery at MVP, and MVP 1 being strictly one-device-one-account.
Genuine multi-device support is a near-term priority after MVP 1
because it gates recovery.

## 2. Architecture overview

```
┌────────────────────────────────────────────┐
│               User's Browser               │
│                                            │
│  ┌──────────────┐                          │
│  │   Passkey    │  WebAuthn credential     │
│  │ (WebAuthn /  │  — the signing root      │
│  │  platform    │                          │
│  │  authenti-   │                          │
│  │  cator)      │                          │
│  └──────┬───────┘                          │
│         │ derives                          │
│         ▼                                  │
│  ┌──────────────┐                          │
│  │  Derivation  │  passkey-bound secret →  │
│  │     seed     │  hierarchical derivation │
│  └──────┬───────┘                          │
│         │                                  │
│   ┌─────┴─────┬─────────┐                  │
│   ▼           ▼         ▼                  │
│ ┌────┐     ┌────┐    ┌────┐                │
│ │Sh- │     │Ni- │    │Du- │                │
│ │iel-│     │ght │    │st  │                │
│ │ded │     │key │    │key │                │
│ │key │     │    │    │    │                │
│ └──┬─┘     └──┬─┘    └──┬─┘                │
│    └──────────┴─────────┘                  │
│         │ intent signing                   │
│         ▼  (Schnorr on JubJub)             │
│  ┌──────────────┐                          │
│  │  Signature   │                          │
│  │  + ZK proof  │  proof server (local or  │
│  │  generation  │  browser)                │
│  └──────┬───────┘                          │
│         │ proof + tx                       │
└─────────┼──────────────────────────────────┘
          │
          │     ┌──────────────────────────┐
          │     │     Account Provider     │
          │     │                          │
          ├─────┤  • Name resolution (MVP-04 read) │
          │     │  • JWT issuance          │
          │     │  • Rate limiting         │
          │     │  • Sponsorship paymaster │
          │     │                          │
          │     │  NO custody authority    │
          │     │  NO key material         │
          │     └──────────────────────────┘
          │
          ▼
    ┌───────────────────────┐
    │   Midnight Network    │
    │                       │
    │  Node-level intent-   │
    │  signature check      │
    │  Name registry        │
    │  (Compact contract)   │
    │  binds ownership to   │
    │  the signing pubkey   │
    └───────────────────────┘
```

## 3. Key derivation in the browser

The browser derives a deterministic root secret from the user's
passkey and then feeds the CIP-1852-aligned derivation tree that
Plan B already uses. This keeps the wallet-side data model stable
across the two plans.

### 3.1 From passkey to derivation seed

The passkey credential itself is not an HD-derivable secret. WebAuthn
platform authenticators expose only `assertion` signing operations;
they do not export the underlying private key. Two browser-side
primitives can bridge the gap:

- **PRF extension (preferred where supported).** The WebAuthn Level 3
  `prf` extension allows the authenticator to evaluate a
  deterministic pseudo-random function keyed by the passkey for a
  caller-supplied input. The PRF output is a high-entropy seed that
  is stable across sessions on the same authenticator. This is the
  target primitive for Plan A.
- **Assertion-based derivation (fallback).** Where PRF is not
  available, we can instead derive a seed by prompting the
  authenticator to sign a canonical constant and feeding the
  signature into HKDF. This pattern works today on most platforms
  but has two failure modes: the signature is non-deterministic on
  some authenticators, and any change to the platform's signing
  algorithm breaks derivation. PRF is strongly preferred; the
  fallback is a stopgap only.

Both primitives produce a 256-bit seed that is then run through
HKDF with an STD-03 domain prefix to produce the BIP39-equivalent
root secret. The root secret is never written to disk; it is held
in a transient WebCrypto `CryptoKey` object for the life of the
signing operation.

### 3.2 From root secret to wallet keys

Once we have a root secret, the hierarchical derivation is identical
to Plan B: CIP-1852 path `m/44'/2400'/0'/{role}/0` for the Shielded,
Night, and Dust roles. The `jubjub`-based Schnorr signing primitive
in `experiments/redjubjub-wallet-rs/` consumes the derived scalar
directly; the TypeScript reference client at
`experiments/redjubjub-wallet/` does the same on the TS side.

The derivation map below is unchanged from Plan B; what changes is
where the seed lives (browser, passkey-derived) and who holds it
(the user alone).

| Role index | Wallet | Purpose |
|---|---|---|
| 0 | NightExternal | Public unshielded address |
| 1 | NightInternal | Internal change keys |
| 2 | Dust | DUST fee registration |
| 3 | Zswap (Shielded) | Shielded transactions |
| 4 | Metadata | Encrypted private contract state |

## 4. Signing flow

Plan A signs Midnight transaction intents with the user's
NightExternal key. There is no threshold step, no DKG, no
coordinator. There is no separate on-device Schnorr key, no
per-operation challenge-response with a distinct device key, and no
in-circuit signature verification in MVP 1 — the signature is
checked at the node level.

1. The browser constructs the Midnight transaction intent (token,
   amount, recipient, nonce).
2. The user's passkey is invoked to unlock the derivation seed (for
   assertion-based derivation, this is a WebAuthn `get()` with a
   user-verification flag; for the PRF path, it is a `get()` with
   the PRF extension).
3. The browser signs the intent with the NightExternal key derived
   from the unlocked seed.
4. The ZK proof is emitted by a local or browser-side proof server
   and submitted to Midnight with the intent signature attached.
5. The Midnight node verifies the intent signature against the
   signing pubkey before accepting the transaction. Compact
   contracts — including the name registry — bind ownership to the
   pubkey and trust the node's intent-signature check; they do
   **not** re-verify the signature in-circuit.

The account provider only ever sees a request body bound to a JWT
`cnf` claim, never key material.

### Future: 1-of-N multi-device

The in-circuit Schnorr verification primitive validated in
`experiments/redjubjub-wallet/` and
`experiments/redjubjub-wallet-rs/` is preserved but not used in
MVP 1. It becomes relevant post-MVP under MVP-09, where multiple
devices register against a single identity: each device holds its
own `sk_device`, operations are authorised by any one of the N
signatures, and verification runs in-circuit against a membership
proof over the set of registered device pubkeys. This is framed
explicitly as a **1-of-N** pattern — not k-of-N threshold — because
each device acts independently.

## 5. Transaction construction and balancing

Intent signing uses the NightExternal key derived in the browser.
Balancing (fee attachment) is delegated to the account provider's
paymaster per the fee-sponsorship design:

- The user's wallet calls `transferTransaction(outputs,
  secretKeys, { ttl, payFees: false })` in the Midnight SDK,
  producing an unbalanced `UnprovenTransactionRecipe`.
- The recipe and a JWT (with a `cnf` claim binding the recipe
  digest) are posted to the account provider.
- The provider's paymaster calls `balanceUnprovenTransaction` with
  its own DUST inputs, signs its own fee branch with its own key,
  and returns the balanced recipe.
- The user's wallet signs its own branch, generates the proof, and
  submits.

See `.planning/design/FEE-SPONSORSHIP-MODEL.md` for the full
sponsorship design. The custody story between the user and the
provider is already orthogonal in that design — Plan A does not
change it.

## 6. Account provider boundary

The provider does four things and nothing else:

1. **Name resolution.** Resolve `alice.midnight` to public keys and
   address records. This is a read of the MVP-04 Compact contract,
   cached for read-heavy paths.
2. **JWT issuance.** After a WebAuthn challenge, mint a short-lived
   JWT with a `cnf` claim binding the body of the request it
   authorises.
3. **Rate limiting.** Per-device-key and per-IP quotas on name
   registration, sponsored transactions, and other provider-mediated
   operations.
4. **Paymaster balancing.** Optional. Attach DUST fee inputs per the
   sponsorship design; sign the paymaster's own branch; return the
   balanced recipe.

### Authority-boundary invariant

> The account provider cannot produce a Schnorr signature under any
> user's key. It holds no key material and no key share. Every user
> signature is produced in the browser, bound to the user's passkey,
> and verified by the Compact circuit as a private witness.

This invariant is the security cornerstone of Plan A. It must be
preserved end-to-end and should be explicitly tested in integration
tests (the provider cannot be tricked into signing; the provider
has no code path that would let it sign).

## 7. Name registry (MVP-04)

Unchanged from Plan B. An on-chain Compact contract provides
commit-reveal registration, multi-address resolution, per-device
rate limits, ENSIP-15 normalisation enforced in-circuit, and
dormancy reclaim. The Plan A account provider is a *reader* of this
contract; writes are user-initiated and are bound by the
NightExternal intent signature that the Midnight node verifies at
submission time.

## 8. Derivation-seed storage and threat model

### 8.1 Where the seed lives

The root secret is reconstructed on demand from the passkey every
time a signing operation is needed. It is not persisted. Between
operations, only the passkey credential (controlled by the platform
authenticator) is at rest on the device.

Between derivations the browser holds small helper state:

- A cache of derived public keys for the session.
- The `ZswapChainState` sync offsets (if the Passport maintains a
  light wallet view).
- The user's locally encrypted private contract state, wrapped by a
  key derived alongside the wallet keys from the same root secret.

Helper state is held in IndexedDB under the Passport origin and
wiped with normal browser data clearance.

### 8.2 Threat model

- **Device theft with passkey sync.** An attacker with the device
  cannot derive the seed without the passkey gesture (user
  verification). Platform authenticators enforce this.
- **Device theft without platform lock.** An attacker who gains a
  live, unlocked session could issue signing requests. Mitigation:
  keep passkey user-verification mandatory; tie sensitive
  operations to a re-prompt.
- **Browser compromise.** A malicious extension or supply-chain
  attack on the Passport origin could exfiltrate the derivation
  seed during a signing operation. Mitigation: subresource
  integrity, tight CSP, strict dependency auditing, and (design
  space) moving signing into a WebAssembly module whose surface is
  deliberately minimal.
- **Browser data clear.** Wipes helper state. If the passkey is
  platform-synced, the account survives; otherwise the account is
  lost. This is R2 in the Plan A README.

## 9. Recovery story (MVP: none)

MVP 1 ships **no recovery**. If the passkey is lost, the account is
gone. This is stated to the user at onboarding.

**Mitigation sequence.** Recovery cannot be built until genuine
multi-device exists: the order is **multi-device first, recovery
second**. MVP-09 (multi-device) is a prerequisite for any future
recovery workstream.

Design space for the post-MVP recovery work (sketched; not a
commitment; details to be refined in the next planning pass):

- **Social recovery via DeRec** — share a recovery secret across a
  threshold of trusted helpers; a future client rebuilds the
  derivation seed from the shares. Has the advantage of being
  compatible with the rest of the stack (the reference design uses
  DeRec) and does not require reintroducing FROST.
- **Encrypted blob backup** — the user downloads an encrypted
  backup that contains the derivation seed, protected by a
  passphrase. Accepts a seed-phrase-equivalent failure mode in
  exchange for a clean recovery path. Compromises principle P6
  (seedless UX) only for the recovery sub-flow.

None of these is in MVP 1; all depend on multi-device existing
first.

## 10. Multi-device story

### 10.1 MVP 1: strictly one-device-one-account

One device = one physical device. A MacBook is one device; an
iPhone is another; two physical devices are two devices. MVP 1
binds one account to one physical device.

Where a user has enabled Apple iCloud Keychain or Google Password
Manager, the platform may replicate the passkey across that user's
own devices. This is convenient for the user who has opted in, but
it is **not** Passport multi-device: it is key replication on behalf
of a single user across devices they own, and it does not cover the
scenarios Passport multi-device is designed for (adding a partner's
device, recovering from a lost device, rotating device keys). The
product design does not rely on platform sync.

### 10.2 Near-term: genuine multi-device (ahead of original Milestone 2 slot)

Genuine multi-device — two or more physical devices under a single
account, with a device-add ceremony and per-device keys — is a
near-term priority after MVP 1. It is brought forward ahead of the
original Milestone 2 slot because it gates recovery (see §9). The
MVP-09 label "research programme" still applies for MVP 1; exact
delivery timing is to be decided in the next planning pass.

Likely shape: a per-device key registered under the user's on-chain
account, with a device-add ceremony between the existing and new
browser. Converges toward Plan B's MIP-4 (multi-key account
contract), which can be adopted wholesale once it exists.

## 11. Formal-methods hand-off candidates (in priority order)

1. **Name-registry commit-reveal with in-circuit ENSIP-15
   normalisation.** The circuit work that actually remains for MVP
   1. Needs a spec covering the commit-reveal ceremony, the
   homoglyph and normalisation enforcement in-circuit, and the
   per-device rate-limit logic.
2. **Passkey-to-seed derivation.** A novel Plan A surface. Needs
   a spec covering PRF-path and assertion-path both, the HKDF
   construction, and the nonce-discipline requirements for the
   assertion fallback.
3. **Account-provider authority boundary.** The invariant in §6
   must be expressible and machine-checkable. This is a
   reformulation of Plan B's original authority-boundary work at a
   smaller scope.
4. **1-of-N in-circuit Schnorr verification for multi-device.**
   Preserved from the experiments but no longer on the MVP 1
   critical path. Returns as the MVP-09 multi-device foundation.

## 12. Deviations from Plan B

| Area | Plan B architecture | Plan A architecture |
|---|---|---|
| Signing scheme | FROST threshold Schnorr (n=5, t=4) | NightExternal key signs Midnight intents; node verifies |
| Key custody | Distributed across committee via DKG | Derived in browser from passkey |
| Account provider | OAuth-like with recovery hand-off to committee | Thin: name + JWT + rate-limit + paymaster |
| Recovery at MVP | Federation-mediated | None |
| Multi-device at MVP | OAuth-layer multiplicity against one committee-held key | None — one device one account; genuine multi-device is a near-term post-MVP priority (gates recovery) |
| In-circuit verifier | FROST aggregate verification | **None in MVP 1.** The node-level intent-signature check is sufficient authorisation for Compact contract calls, including name registration. The in-circuit Schnorr primitive returns under MVP-09 as the 1-of-N multi-device foundation |
| Formal-methods priority 1 | FROST3 identifiable abort + nonce / domain discipline | Name-registry commit-reveal with ENSIP-15 normalisation enforced in-circuit |
| MPC infrastructure | Required — single-operator committee at MVP | None |
| Decentralised at MVP | No (centralised operator) | Yes |

## 13. Validated assumptions carried over from the experiments

1. **Schnorr verification in Compact.** `s·G == R + c·PK` executes in
   a Compact circuit on JubJub via `ecMulGenerator`, `ecMul`, and
   `ecAdd`. The `withdraw` circuit (k=14, 11,436 rows) compiles and
   verifies on-chain. Reference: `experiments/redjubjub-wallet/`.
2. **Contract-held tokens with signature-gated withdrawal.** A
   Compact contract receives unshielded tokens via
   `receiveUnshielded` and releases them via `sendUnshielded`, gated
   by Schnorr signature authorisation. Replay protection via a
   monotonic `tx_count` bound into the challenge. Reference:
   `experiments/redjubjub-wallet-rs/`.
3. **Rust / TypeScript signing interoperability.** The `jubjub` Rust
   crate and TypeScript bigint arithmetic produce identical Schnorr
   signatures for identical inputs. The signing boundary is clean:
   scalar arithmetic on either side, Poseidon challenge via the
   contract's `pureCircuits`.

## 14. Known issues

1. **JubjubPoint equality bug in compact-runtime 0.15.0.** Compact's
   `==` on `JubjubPoint` compiles to JavaScript `===` (reference
   equality), which always returns `false`. Workaround: post-compile
   patch the generated JS. Bug report submitted to the Midnight
   team. See `docs/KNOWLEDGE_BASE.md`. Unchanged from Plan B.

---

*ARC — Input Output Global, 2026/04/21*
