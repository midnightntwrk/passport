# Experiment Brief: MN Wallet Key as Account Authoriser (BIP-340 Gate)

**Date opened:** 2026/09/05
**Component:** C5 signing primitive / C9 device-bound authentication (a third seam arm for the account contract; feeds the signature-schemes MIP registry and the OWS v2 spec R2 scheme list).
**Base:** desk findings recorded below; vector harness reuses the pinned client set of `experiments/account-custody-prototype/`; in-circuit leg follows the house pattern of `experiments/p256-in-circuit/`.

## Question

Can a regular Midnight wallet sign an account-contract authorisation
challenge with the key it already holds, and can the account contract
verify that signature at its seam? Concretely: is "any MN wallet can
operate a passport account" true end to end, with no wallet-side change?

## Why now

The question was raised directly by the Midnight Foundation (2026/09/04)
and decides an onboarding path: if the answer is yes, an existing wallet
user controls a passport account without enrolling a passkey or a new
key, and the OWS v2 contract-execution spec can list the wallet's own
scheme in its R2 registry. The desk half is already answered (below);
what remains is the envelope question and the in-circuit cost, which is
exactly the shape the P-256 experiment resolved for passkeys.

## Desk findings (2026/09/05, settled)

These are verified against installed packages and published sources, not
speculation:

- **The signing surface exists at every level.**
  - Ledger WASM: `signData(key, data)` and
    `verifySignature(vk, data, sig)` (`@midnight-ntwrk/ledger-v8`,
    `ledger-v8.d.ts:425`).
  - Wallet SDK: `UnshieldedKeystore.signData(data): Signature` is a
    first-class keystore method
    (`@midnight-ntwrk/wallet-sdk-unshielded-wallet`, `KeyStore.d.ts`).
  - dApp connector: `ConnectedAPI.signData(data, options)` with
    `options.keyType: 'unshielded'` and hex/base64/text encodings
    (`@midnight-ntwrk/dapp-connector-api` 4.0.1). A browser wallet can
    therefore be asked by a dApp to sign an arbitrary payload.
- **The scheme is BIP-340 Schnorr over secp256k1.** The ledger signature
  type is implemented with `k256::schnorr`, stated verbatim in
  `midnight-base-crypto` 1.0.0 `src/signatures.rs` ("Schnorr over
  secp256k1, conforming to BIP340"). This matches NEITHER live seam arm
  (JubJub Schnorr, ECDSA-secp256k1), so a third verification arm is
  required at the account contract.
- **The connector prepends a prefix.** The `signData` doc comment states
  "data to sign will be prepended with right prefix". The signed message
  on the connector path is therefore `prefix || challenge`, not the raw
  challenge: an envelope the circuit must reconstruct, exactly as the
  WebAuthn envelope was for the P-256 arm. The prefix bytes are not
  documented in the connector types and must be pinned down (P3).
- **Compact 0.34.0 has native secp256k1 types.** The artefact-only
  leftover `experiments/secp256k1-in-compact/` holds a keyed 0.34.0
  compile of `verify_and_record(msg_hash: Bytes<32>,
  sig: Secp256k1EcdsaSignature, pk: Secp256k1Point)`, proving
  `Secp256k1Scalar` / `Secp256k1Point` and an ECDSA verify exist as
  language-level constructs. Whether the exposed surface suffices for
  BIP-340 (lift_x, tagged SHA-256 hash, R = s·G − e·P) is P4.
- **Adjacent observation.** Because the wallet key is a secp256k1
  scalar, the same secret could in principle produce an ECDSA signature
  verifiable by the existing k256 arm, but no stock wallet surface
  exposes ECDSA signing; the connector signs BIP-340 only. (For
  Ethereum-style wallets the situation is reversed: `personal_sign` is
  ECDSA-secp256k1 with the Ethereum message prefix, which the existing
  k1 arm could verify modulo that envelope. That is the "MetaMask can
  operate a passport" case, and it needs no new curve work.)

## Probes

- **P1 · Vector generation (SDK path). PASS 2026/09/05.** Harness:
  `p1-vector.mjs` on the account-custody-prototype pin set (fixed
  32-byte secret via `createKeystore`; the HD/MIP-0003 derivation leg is
  a follow-up, immaterial to scheme characterisation). Results
  (`evidence/p1-vector.json`): `SignatureVerifyingKey` is a 32-byte
  x-only key, `Signature` is 64 bytes, ledger `verifySignature` accepts.
- **P2 · Bit-exact cross-check. PASS 2026/09/05 (independent JS
  implementation; Rust leg optional).** The P1 vector verifies under
  noble-curves BIP-340 with **message = SHA-256(data)** and fails for
  the raw message and a double hash: `signData` is a standard BIP-340
  signature over the untagged SHA-256 pre-hash of the payload. Source
  chain confirms it: `midnight-base-crypto` 1.0.0 calls k256's
  `sign_with_rng`, and k256 0.13.4 `try_sign_with_rng` signs
  `Sha256::new_with_prefix(msg)` via `sign_raw`
  (`k256-0.13.4/src/schnorr/signing.rs:207`). No ledger-side wrapping,
  no tag. Signatures are randomised (`aux_rand`); repeated runs differ
  and all verify, so nothing may assume determinism.
- **P3 · Connector envelope discovery. SETTLED (normative).** The
  connector specification mandates the prefix
  `midnight_signed_message:<data_size>:` ("Signing" section,
  midnightntwrk/midnight-dapp-connector-api SPECIFICATION.md), and also
  defines the scheme discriminator (`schnorr_bip340` default,
  `ecdsa_secp256k1_sha256` optional). Reproduced through the keystore
  (`evidence/p1-vector-connector.json`) and cross-verified.
- **P4 · In-circuit verify, Compact-native attempt. FAIL, gap
  recorded.** Probes under `compact-probes/`: the ECDSA verify builtin
  and the point accessors compile (behind `--feature-zkir-v3`); `sha256`
  and any point addition or scalar multiplication are unbound at
  language level, so BIP-340 is not expressible in Compact 0.34.0. The
  gap is the upstream ask (see FINDINGS.md).
- **P5 · In-circuit verify, midnight-zk relation. PASS, measured.**
  `crates/bip340-gate-circuit` verifies the real wallet vectors:
  SDK path k = 15 (~470 ms), connector path k = 16 (~800 ms), 4064-byte
  proofs, 2 ms verification, negative controls rejected
  (`evidence/cost.json`, `evidence/timings-*.json`).
- **P6 · Seam statement. WRITTEN.** See FINDINGS.md: a third
  entry-based `schnorr_bip340` arm, challenge unchanged, connector
  envelope as the default variant; registry names should follow the
  connector specification; the existing k1 arm covers
  `ecdsa_secp256k1_sha256` modulo the same envelope.

## Success criteria

The question is answered YES if P1, P2, and P5 pass: a signature
produced by the stock wallet SDK over the account challenge verifies
inside a midnight-zk circuit at acceptable cost, with the message bytes
fully characterised on both the SDK and connector paths. P4 passing as
well upgrades the answer from "viable via custom relation" to
"expressible in Compact today". P3 failing to identify a stable prefix
downgrades the connector path (SDK and programmatic wallets unaffected).

## Version pins

- `@midnight-ntwrk/dapp-connector-api` 4.0.1 (types fetched 2026/09/05).
- Client set: the `experiments/account-custody-prototype/` lockfile
  (`ledger-v8`, `wallet-sdk-*`).
- `midnight-base-crypto` 1.0.0 (crates.io) for the Rust cross-check.
- Compact toolchain 0.34.0 for P4; midnight-zk at the p256-in-circuit
  pin for P5.
