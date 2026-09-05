# Findings: MN Wallet Key as Account Authoriser (BIP-340 Gate)

**Verdict: YES, with one contract-side gap.** A regular Midnight wallet can
sign an account-contract authorisation challenge with the key it already
holds, on every signing surface the wallet stack exposes, and that
signature verifies inside a midnight-zk circuit at the same cost class as
the P-256 passkey arm. No wallet-side change is needed. The missing piece
is entirely contract-side: a third verification arm at the account seam,
which today requires a custom midnight-zk relation because the BIP-340
equation is not expressible in Compact 0.34.0 (the exact gaps are
enumerated below and constitute the upstream ask).

## Probe results

| Probe | Question | Result |
|-------|----------|--------|
| P0 | Does a signing surface exist at ledger, SDK, and connector level? | PASS (desk): all three exist |
| P1 | Does the wallet SDK sign a 32-byte challenge, and in what format? | PASS: x-only 32-byte key, 64-byte signature, ledger verifies |
| P2 | Is the signature independently verifiable, and over which message? | PASS: RustCrypto k256 accepts over `SHA-256(signed bytes)` and rejects the unhashed message, on both paths |
| P3 | What exactly does the connector path sign? | SETTLED (normative): `midnight_signed_message:<data_size>:` prefix, mandated by the connector specification; reproduced through the keystore and cross-verified |
| P4 | Is BIP-340 expressible in Compact 0.34.0's native secp256k1 surface? | FAIL (gap): no SHA-256, no point addition, no scalar multiplication at language level |
| P5 | Does the wallet signature verify in a midnight-zk circuit, at what cost? | PASS: k = 15 (SDK path) and k = 16 (connector path), sub-second proving, real wallet vectors, negative controls rejected |
| P6 | What seam shape does this imply for the account contract? | Statement below |

## The signing surface (P0)

Three levels, all shipping today:

- **Ledger WASM**: `signData(key, data)` and `verifySignature(vk, data,
  sig)` (`@midnight-ntwrk/ledger-v8`).
- **Wallet SDK**: `UnshieldedKeystore.signData(data): Signature` is a
  first-class keystore method
  (`@midnight-ntwrk/wallet-sdk-unshielded-wallet`).
- **dApp connector**: `ConnectedAPI.signData(data, options)` with
  `options.keyType: 'unshielded'`
  (`@midnight-ntwrk/dapp-connector-api` 4.0.1), so a browser-extension
  wallet can be asked by a dApp to sign an arbitrary payload.

The connector specification additionally defines a scheme discriminator on
the returned signature: `schnorr_bip340` (the default, 32-byte x-only
verifying key) and `ecdsa_secp256k1_sha256` (33-byte SEC1 compressed key,
motivated by MPC and HSM signer availability). Both return 64-byte `r || s`
signatures.

## The exact message shape (P1, P2, P3)

The signature is **BIP-340 Schnorr over secp256k1**, and the 32-byte
BIP-340 message is the **untagged SHA-256 pre-hash of the signed bytes**:

- SDK/keystore path: message = `SHA-256(payload)`.
- Connector path: message = `SHA-256("midnight_signed_message:<size>:" ||
  payload)`; the prefix is mandatory for wallets implementing the
  connector ("In order to make it impossible to sign transactions by
  accident"), so for a 32-byte challenge the signed bytes are the 27-byte
  ASCII prefix `midnight_signed_message:32:` followed by the challenge.

The source chain fixing this: the ledger signature type is
`midnight-base-crypto`'s wrapper over `k256::schnorr`, whose
`RandomizedSigner` signs `SHA-256(msg)` via `sign_raw`. Two consequences
worth keeping:

- **Signatures are randomised** (BIP-340 auxiliary randomness). Repeated
  signing of the same payload yields different signatures, all valid.
  Nothing may assume signature determinism; replay control stays with the
  contract's `auth_nonce`, unchanged.
- **The prefix is a feature, not an obstacle.** It domain-separates
  connector-obtained signatures from transaction signatures by
  construction. A seam arm that expects exactly `prefix || challenge`
  inherits that separation.

Evidence: `evidence/p1-vector.json` and `evidence/p1-vector-connector.json`
(wallet-SDK-produced vectors, fixture secret key), cross-verified by two
independent implementations (noble-curves in the Node harness,
RustCrypto k256 in `evidence/rust-verify.json`, which also checks that the
unhashed message and a corrupted payload are rejected).

## In-circuit verification (P5)

`crates/bip340-gate-circuit` implements one relation, parameterised by the
fixed prefix (empty for the SDK path, the connector prefix otherwise),
ported from the ECDSA relation pattern of `experiments/p256-in-circuit`:

- **Public interface = what the contract knows**: the 32-byte x-only
  verifying key and the 32-byte challenge. Nothing else.
- **lift_x in-circuit**: the prover witnesses the full key point; the
  circuit constrains it on-curve, binds its x-coordinate bytes to the
  public key bytes, and asserts the y-coordinate is even.
- **Both SHA-256 layers in-circuit**: the pre-hash
  `m = SHA-256(prefix || payload)` and the tagged challenge
  `e = int(SHA-256(tagH || tagH || r || pk_x || m)) mod n`.
- **The group equation** `R = s * G - e * P` via the bit-based MSM, then
  the BIP-340 acceptance checks: `R` not the identity, `R.y` even, and
  the canonical bytes of `R.x` equal to `r` (which also enforces
  `r < p`); scalar assignment enforces `s < n`.

Measured on the real wallet vectors (Apple Silicon, release build,
Filecoin SRS):

| Quantity | SDK path | Connector path |
|----------|----------|----------------|
| optimal k | 15 | 16 |
| rows | 31046 | 32900 |
| proving time (3 runs) | ~470 ms | ~800 ms |
| proof size | 4064 B | 4064 B |
| verification | 2 ms | 2 ms |

The connector path crosses the 2^15 row boundary by 132 rows (one extra
SHA-256 block from the 27-byte prefix), which doubles k; a row-level
optimisation pass would likely pull it back under. Either way this is the
same cost class as the P-256 passkey arm, and comfortably inside the
browser-provable envelope established by the proof-benchmarks corpus.

A negative control ran per proving session: the proof is rejected under a
corrupted public payload.

## Compact-native status (P4)

Probes under `compact-probes/`, compiled with `compact compile +0.34.0
--feature-zkir-v3 --skip-zk` (the secp256k1 surface is gated behind the
ZKIR v3 feature flag; without it even the types are unbound):

| Probe | Exercises | Outcome |
|-------|-----------|---------|
| A | `secp256k1EcdsaVerify(hash, sig, pk)` | compiles |
| D | `secp256k1PointX` / `secp256k1PointY` accessors | compiles |
| B | `sha256` in-circuit | unbound identifier |
| E | infix `+` on `Secp256k1Point` | invalid operand type |
| F | `secp256k1ScalarMul(s, p)` | unbound identifier |

So the language-level surface is: field arithmetic on `Secp256k1Base` and
`Secp256k1Scalar`, point accessors, comparisons and identity, and the
ECDSA verify builtin. BIP-340 needs SHA-256 and the group operation, and
neither is exposed, so **BIP-340 is not expressible in Compact 0.34.0**.
Notably, the compiled output of the ECDSA builtin lowers to runtime
primitives that include point addition and scalar multiplication
(`secp256k1Add`, `secp256k1Mul`, `secp256k1MulGenerator`), so the machinery
exists below the language; the upstream ask is exposure, not new
cryptography. Two shapes, smallest first:

1. A `secp256k1SchnorrVerify(msg, sig, pk_x)` builtin implementing
   BIP-340, mirroring how ECDSA landed (with the message-construction
   convention documented, since the wallet pre-hash and the connector
   prefix are part of the verified statement).
2. Generic exposure: in-circuit SHA-256 plus point addition and scalar
   multiplication, from which BIP-340 (and other constructions) can be
   built in user code.

## Seam statement (P6)

- **Third arm, entry-based.** The account contract gains a
  `schnorr_bip340` arm alongside the JubJub Schnorr and ECDSA-k256 arms,
  as an entry-based device scheme tag; the challenge construction is
  unchanged. The arm verifies over `SHA-256(challenge)` (SDK signers) or
  over the connector envelope (browser wallets); both variants are
  measured above and the envelope variant should be the default for
  wallet-held keys, since the connector is how real wallets will sign.
- **Scheme naming should follow the connector specification.** The
  connector already names `schnorr_bip340` and `ecdsa_secp256k1_sha256`;
  the signature-schemes registry should adopt these identifiers rather
  than invent parallel names.
- **The existing ECDSA-k256 arm already covers the connector's second
  scheme, modulo the same envelope.** A wallet (or MPC/HSM signer)
  returning `ecdsa_secp256k1_sha256` verifies against the shipped k1 arm
  once that arm computes its digest over `prefix || challenge` instead of
  the raw challenge. The Ethereum-wallet analogue (`personal_sign`,
  ECDSA-k256 with the Ethereum message prefix) is the same envelope
  pattern on the same curve.
- **The x-only arm is structurally immune to the identity-point
  forgery** found on the other two arms: the identity has no x-only
  encoding, lift_x admits only valid curve x-coordinates, and secp256k1
  has cofactor 1, so on-curve plus the x binding suffices with no extra
  weak-key checks.

## What this does not show

- **No on-chain third arm.** The relation is a midnight-zk circuit, not a
  Compact circuit; wiring it into the deployed account contract needs
  either the upstream Compact exposure (P4 ask) or the proof-wrap
  route, and a redeploy wave in either case.
- **No capture from a shipping extension wallet.** The connector-path
  vector applies the normative prefix through the SDK keystore, which is
  what a conforming wallet does internally; a capture from a real
  extension wallet remains to be taken when one lands, and would also
  pin the `scheme` field behaviour.
- **No HD derivation.** The vectors use a fixture-secret keystore; the
  MIP-0003 derivation path does not affect the scheme but was not
  exercised.
- **No statement about "BLS of NIGHT".** That question is separate and
  untouched by this experiment.

## Version pins

- Wallet stack: the `experiments/account-custody-prototype/` lockfile
  (`@midnight-ntwrk/ledger-v8`, `wallet-sdk-*`); noble-curves 1.9.7 as
  the independent JS verifier.
- Connector: `@midnight-ntwrk/dapp-connector-api` 4.0.1 and its
  SPECIFICATION.md (midnightntwrk/midnight-dapp-connector-api).
- Scheme source chain: `midnight-base-crypto` 1.0.0, `k256` 0.13.4.
- Proof system: midnight-zk at
  `cd2c27b2659de157409a9b96dba0dbaf1218f00b` (the p256-in-circuit pin),
  Filecoin SRS, rustc 1.90.0.
- Compact toolchain 0.34.0 with `--feature-zkir-v3` for the P4 probes.
