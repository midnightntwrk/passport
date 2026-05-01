# Midnight Passport — Features

The technical items that make up Midnight Passport, expressed as demo-mappable
features. Each item is something the user (or a third party) can exercise
end-to-end, and each must have a visible demo surface — if the user cannot
observe the effect, the feature is not done.

The MVP target is the end of June 2026. Items below are listed in the order
they unlock each other; items 8 and 9 are post-MVP demo extensions.

Last updated: 2026/04/27.

---

## At a glance

| # | Feature | When | Maps to |
|---|---------|------|---------|
| 1 | Client-side passkey retrieval | MVP 1 | Phase 3' · MVP-08 |
| 2 | Key derivation in-wallet | MVP 1 | STD-01 (MIP-1) |
| 3 | Signing arbitrary data and transactions | MVP 1 | Phase 3' · evidence E1 + E3 |
| 4 | Wallet sync — view key plus indexer | MVP 1 | New — needs spec note |
| 5 | Account name service | MVP 1 | Phase 5 · MVP-04 |
| 6 | Proving client-side | MVP 1 | MVP architecture |
| 7 | Authorisation key management | MVP 1 | STD-04 (MIP-3) + Phase 3' |
| 8 | DeRec and multi-device account | Post-MVP | STD-04 (MIP-3) + STD-05 (MIP-4) |
| 9 | API for third-party app authorisation access | Post-MVP | ECO-01 (MIP-5) · ECO-03 (MIP-7) |

Items 1 through 7 must be demonstrable end-to-end by end of June 2026.
Items 8 and 9 extend the demo surface across Milestones 2 and 3.

---

## 1. Client-side passkey retrieval

**What it covers.** Register, retrieve, and gate a WebAuthn platform passkey
in the browser. Two paths are specified: the WebAuthn PRF extension (Path A)
and the assertion fallback (Path B), with a product-owner-signed browser × OS
support matrix.

**Demo surface.** "Sign in with Passport" — the user creates a passkey on
first visit and re-authenticates on subsequent visits. The UI surfaces the
authenticator brand and whether PRF is available on the current device.

**Maps to.** Phase 3' · MVP-08.

---

## 2. Key derivation in-wallet

**What it covers.** Passkey-bound root → CIP-1852 derivation for the three
Midnight wallet roles: Shielded (Zswap), Night (unshielded), and Dust
(fee-registration).

**Demo surface.** The three derived public addresses appear the moment the
passkey is unlocked. No seed phrase is generated, displayed, or stored
anywhere.

**Maps to.** MVP architecture · STD-01 (MIP-1).

---

## 3. Signing arbitrary data and transactions

**What it covers.** Schnorr-on-JubJub signing of arbitrary messages *and* of
NightExternal intent transactions. Signatures are byte-identical across the
TypeScript and Rust client implementations.

**Demo surface.** Sign a string ("hello"); sign a Night transfer. Both
verify green at the node-level intent check. The Rust verifier accepts a
signature produced by the TypeScript signer and vice versa.

**Maps to.** Phase 3' · evidence E1 + E3.

---

## 4. Wallet sync — view key plus indexer

**What it covers.** The read half of the wallet. A view key (per role) is
handed to an indexer — third-party or self-hosted — that reconstructs the
user's on-chain state: notes, balances, name-registry ownership, the
authorisation key set on item 7's contract, the device list from item 8,
and any other observable state. Without this, every other item produces
state the user cannot see.

The indexer is a second sideband alongside the account provider: it can read
on the user's behalf, but it cannot sign.

**Demo surface.** After item 7 rotates the authorisation key, the wallet UI
reflects the new key set. After item 5 registers `alice.midnight`, the
wallet shows ownership. Balances update without the user holding the spend
key.

**Open spec questions.**
- Which view key per role (Shielded · Night · Dust).
- Indexer protocol shape (gRPC, JSON-RPC, GraphQL).
- Privacy properties: what the indexer learns, and what it must not learn.
- MVP ships with a hosted indexer, a client-only path, or both.

**Maps to.** New deliverable — not yet a numbered MVP item; needs a spec
note before MVP scope-lock is final.

---

## 5. Account name service

**What it covers.** The `alice.midnight` registry: commit-reveal
registration, multi-address resolution across the three wallet roles,
ENSIP-15 normalisation enforced in-circuit, per-device-key rate limits, and
dormancy reclaim.

**Demo surface.** Register `alice.midnight`; resolve the name to all three
role addresses; attempt a squat → rejected; let a name lapse → reclaim
flows.

**Maps to.** Phase 5 · MVP-04.

---

## 6. Proving client-side

**What it covers.** ZK-proof generation in the browser, or in a local
proving sidecar — the user is the prover, the node is the verifier. No
hosted prover holds user data.

**Demo surface.** The browser produces a proof for a Compact circuit call;
a timing and resource panel shows where the proof was produced and how long
it took.

**Maps to.** MVP architecture (browser-side ZK).

---

## 7. Authorisation key management

**What it covers.** Two halves bound together:

- **Smart-contract side.** A Compact contract that binds account ownership
  to a pubkey or pubkey set, and enforces signature verification on every
  authority-changing call.
- **Client side.** The ceremony to add, rotate, and revoke authorisation
  keys from the browser, including UX for confirmation and recovery.

**Demo surface.** The contract refuses a call signed by the wrong key. The
user rotates the authorisation key from the browser; the new key works, the
old key is now rejected. Item 4 reflects the new key set.

**Maps to.** STD-04 (MIP-3) for the contract; Phase 3' for the client-side
ceremony.

---

## 8. DeRec and multi-device account

**What it covers.** Genuine Passport-engineered multi-device — two or more
physical devices, a device-add ceremony, per-device keys — and social
recovery via the DeRec protocol.

This is post-MVP near-term. It gates recovery; until it ships, account loss
is possible and must be stated to the user (R4).

**Demo surface.** Add a second device via a QR-code device-add ceremony;
"lose" device 1; recover the account via DeRec helpers. Item 4 reflects the
device list throughout.

**Maps to.** STD-04 (MIP-3) + STD-05 (MIP-4).

---

## 9. API for third-party app authorisation access

**What it covers.** The dApp ↔ wallet connection protocol. A third-party
application requests scoped permissions; the user reviews and approves; the
dApp receives an async proof of the authorisation. CAIP-25-shaped, with
privacy scopes.

**Demo surface.** An external demo dApp pops a Passport prompt; the user
approves a scoped permission; the dApp receives the proof and acts on it.

**Maps to.** ECO-01 (MIP-5); related to ECO-03 (MIP-7) for
DecentralisedAuth.
