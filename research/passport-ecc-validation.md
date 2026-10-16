# Passport elliptic-curve and public-key validation review

Reviewed **15 October 2026**, Passport revision `2b60da77a00de69d04456c291fd213f827966cde`.
This report applies the platform findings in
[ecc-validation.md](ecc-validation.md) to Passport's reference contracts, wallet
clients, foundations demo, and specifications. Confidence: high for the cited
source paths and reproduced backend/native/SDK behavior; limited for browser-wallet
and live-node acceptance. [Follow-up tests](#4-evidence-and-remaining-checks) now
exercise the compiled account and its native ZKIR preprocessing.

**Assessment:** no successful signature bypass or proof forgery was demonstrated.
The reference account rejects weak signer keys at use, but key enrolment and
encryption-key updates have validation gaps. Documentation also conflates
historical runtime behavior with current guarantees.

## 1. Protections present

| Boundary | Observed protection and remaining dependency |
|---|---|
| Jubjub device and grant authorisation | `[8]pk != O` rejects identity and small-order keys before signature acceptance. Full subgroup membership and coordinate consistency rely on the backend, not this cofactor check alone. Source: `require_authorised_with_jubjub` and `authenticate_grant_with_jubjub` in [contract/contracts/account.compact](../contract/contracts/account.compact). |
| Jubjub recovery | `require_live_jubjub_point` guards session publication and recovery submission, including successor keys. `recover_submit` also requires a successor co-signature. The initial recovery key is checked at use rather than construction. Source: [contract/contracts/account.compact](../contract/contracts/account.compact). |
| secp256k1 authorisation | `require_live_k256_key` rejects zero coordinates; coordinate getters reject flagged identity points. Compact 0.35.0's generated argument validation checks nonidentity foreign points against the curve equation; the backend supplies the proof constraints. Sources: `require_live_k256_key` in [contract/contracts/account.compact](../contract/contracts/account.compact) and the compiler/runtime source references in §4. |
| P-256/WebAuthn | `validateP256Key` rejects identity/off-curve client keys. The account arm extracts coordinates when deriving entries and challenges, rejecting flagged identity; the verifier rejects zero ECDSA scalars. Foreign-point validation remains a toolchain dependency. Sources: `validateP256Key` in [contract/src/wallet/webauthn.ts](../contract/src/wallet/webauthn.ts), `require_authorised_with_p256` in [contract/contracts/account-p256.compact](../contract/contracts/account-p256.compact), and `webauthn_verify` in [contract/contracts/webauthn.compact](../contract/contracts/webauthn.compact). |
| X25519 inbox | Agreement is delegated to Node/OpenSSL. The tested low-order recipient inputs fail agreement; malformed ephemeral-key/decryption failures are caught and skipped by `openInboxEntry`. Sources: `x25519`, `sealInboxEntry` and `openInboxEntry` in [contract/src/wallet/inbox.ts](../contract/src/wallet/inbox.ts). |

For coordinate decoding versus proof constraints, mixed-torsion rejection, and
foreign-curve identity encodings, see [ecc-validation.md, §3](ecc-validation.md#3-elliptic-curve-point-declaration-deserialization-and-encoding).
In particular, `[8]P != O` does **not** establish prime-order membership: a point
with both prime-order and torsion components can pass that check.

## 2. Passport findings

### A. Enrolment can install unusable credentials — medium, availability

`CustodyAccount.issueGrant` (source: [contract/src/wallet/account.ts](../contract/src/wallet/account.ts)) receives only a
`grantId`, so neither it nor the issuance circuit can validate the committed
grantee key. Existing [grants-e2-keys-grants-conformance-keys.json evidence](../contract/evidence/grants-e2-keys-grants-conformance-keys.json)
records successful issuance to weak/invalid keys, with rejection deferred to use.
This misses the issuance obligation in [mip-xxxx-scoped-grants.md, §3.3](../docs/mps-mip/mips/mip-xxxx-scoped-grants.md#33-key-validation).

Device enrolment similarly accepts an opaque derived entry. The
`JubjubDevice` and `JubjubGrantee` constructors (source: [contract/src/wallet/signer.ts](../contract/src/wallet/signer.ts))
do not reject secret scalar zero, although their normal generators exclude it.
The constructor in [contract/contracts/account.compact](../contract/contracts/account.compact) also accepts
an identity birth recovery key; the recovery gate subsequently refuses it.
Tests also reuse the same valid key as owner and grantee successfully: key-role
separation (scoped-grants GR-2) is an authoriser obligation that this opaque-ID
API cannot enforce. This does not increase an owner's existing authority.

**Impact:** unusable grants/devices or disabled recovery, rather than a demonstrated
authorisation bypass. The last-device rule preserves the authorising device,
so adding a dead entry alone does not establish account lockout. These cases
require an authorised enrolment or deployment input, not a permissionless call.

**Action:** validate keys before deriving and approving enrolment commitments;
reject zero imported signing secrets and invalid birth recovery keys. If validity
at issuance must be enforced on-chain, accept the key or a proof about its
committed preimage. An opaque hash alone cannot establish key validity.

### B. X25519 key installation is unchecked — medium, availability/recoverability

The constructor and `do_rotate_enc_key` in [contract/contracts/account.compact](../contract/contracts/account.compact)
store arbitrary `Bytes<32>`. The client methods `deployDormant` and `rotateEncKey` in [contract/src/wallet/account.ts](../contract/src/wallet/account.ts)
do not validate the recipient key or check that a supplied deployment keypair
matches. With a low-order key installed, normal inbox sealing can fail until
rotation; a mismatched keypair prevents the supplied secret from reading entries.
Deployment or an authorised rotation is required.
Expanded tests cover constructor storage and rotation of 14 low-order encodings,
including noncanonical/high-bit aliases: all are installed, all fail inbox
sealing. An unrelated-secret control cannot decrypt a valid entry.
Recovery-session publication also accepts a wrap containing an encryption secret
unrelated to the installed inbox key: the wrap opens successfully, but its secret
cannot decrypt inbox entries. This is an authorised inconsistent setup, not a
signature bypass. A valid rotation from key A to key B also leaves an existing
wrap for A unchanged: recovery retains access to old entries but cannot decrypt
new B entries without B's secret. Sources: `do_rotate_enc_key` and
`do_publish_recovery_session` in [contract/contracts/account.compact](../contract/contracts/account.compact),
and `rotateEncKey` / `publishRecoverySession` in [contract/src/wallet/account.ts](../contract/src/wallet/account.ts).
The [six recovery scenarios in recovery.json](../contract/evidence/ecc-validation/recovery.json)
reproduce both cases.

Coordinate the wrap, key rotation and inbox churn across the intended lifecycle.
An intermediate mismatch can be intentional: the [session variants and ordering in mip-xxxx-account-recovery.md, §5](../docs/mps-mip/mips/mip-xxxx-account-recovery.md#5-the-session-operation)
allow preparing a session before dependent churn. Do not reject every mismatch
with the currently installed key unconditionally. Preserve the secrets or coin
openings needed for historical entries; restoring future inbox operation does
not recover already-lost historical data.

**Action:** validate keypairs on import and reject recipient keys yielding an
all-zero X25519 shared secret. Preserve this check in every encryption backend.
Do not require generic Edwards-point validation for X25519's Montgomery inputs.

This is distinct from the upstream Jubjub encryption leak: the tested Node path
fails agreement instead of deriving a publicly known masking key.

### C. Rust Jubjub signing permits zero secrets/nonces — negligible sampling probability, serious consequence

The Rust functions `jubjub_scalar_from_hex` and `sign_jubjub` (source: [contract/signer-rs/src/main.rs](../contract/signer-rs/src/main.rs)) accept
secret zero, including empty/`0x` input, and sample nonce scalars without retrying zero; the
grant signer's `fresh_nonce` (source: [contract/signer-rs/src/grants.rs](../contract/signer-rs/src/grants.rs)) does the same.
Passport's custom Schnorr equations contain no explicit identity-announcement
rejection, including `require_authorised_with_jubjub`, `authenticate_grant_with_jubjub`
and `recover_submit` (source: [contract/contracts/account.compact](../contract/contracts/account.compact)).

If nonce zero is emitted, `R = O` and `s = c·sk`; for nonzero `c`, the signature
reveals `sk = s/c mod r` to anyone who receives the response and challenge,
including a delegated prover. Passport keeps signatures private in proofs, so
this does not establish public-chain key leakage. With a healthy uniform RNG,
the zero-nonce probability is approximately `1/r` per sample. Runtime tests now
accept identity `R` at device, grant, and recovery gates, including either or
both recovery announcements. A damaged-response recovery control is rejected.
All these announcement variants pass compiled-circuit constraints. Device
signatures with normal and identity announcements also produce verifying full
proofs using local test-only KZG parameters; damaged proofs fail verification.
Rejection would not undo disclosure of an emitted signature.

**Action:** retry zero in Rust key/nonce generation, reject zero secret imports,
and make the verifier's announcement policy explicit. Passport uses its own
SHA-256/grinding challenge; the platform's Poseidon/native signature comparison
in [ecc-validation.md, §4.2](ecc-validation.md#42-schnorr-with-poseidon-challenge-on-jubjub)
does not itself test Passport signature interoperability.

### D. Security documentation is stale or too broad

- [contract/README.md](../contract/README.md) describes secp256k1 rejection as
  `pk != default<Secp256k1Point>`; the implementation checks extracted coordinates.
- [mip-xxxx-scoped-grants.md, §3.3](../docs/mps-mip/mips/mip-xxxx-scoped-grants.md#33-key-validation)
  says P-256 does not ship, although the repository includes its account arm and
  [browser-flow.md transaction evidence](../contract/evidence/p256-webauthn/browser-flow.md).
  It also describes off-curve secp256k1 rejection as signature arithmetic alone;
  Compact 0.35.0 generates explicit runtime curve validation.
- [mip-xxxx-scoped-grants.md, §3.3](../docs/mps-mip/mips/mip-xxxx-scoped-grants.md#33-key-validation)
  claims that runtime arithmetic rejects malformed Jubjub pairs. This needs
  qualification: the platform's altered-`x` decoder discrepancy is reproduced,
  even though the corresponding coordinate proof is rejected.

**Action:** distinguish historical observations, client checks, application
assertions, and proof constraints. Record the toolchain version for each claim.

## 3. Upstream exposure and demo boundary

**Confirmed upstream confidentiality hazard:** Ledger's coin-encryption API accepts
the identity recipient derived from a zero secret, allowing plaintext recovery
from public data. The native reproduction passed. Passport's X25519 inbox does
not use that construction. Follow-up tests also exercise the installed Ledger
WASM API: zero-secret import succeeds, `ZswapOutput.new` accepts the identity
recipient, and the publicly known zero secret recognises the resulting output.
A normal-recipient control is not recognised; an invalid compressed point is
rejected. The installed wallet SDK also accepts this recipient through address
encoding/decoding and its **default shielded transfer builder**, producing a
balanced shielded offer whose ciphertext the known zero secret recognises even
after transaction serialization. Normal-recipient controls are not recognised.
This exposes senders who accept an attacker-supplied identity-recipient address;
it does not show that normal wallet seed derivation generates zero keys.
The SDK's secret-key codec also imports zero. See
[ecc-validation.md, §5.1](ecc-validation.md#51-jubjub-diffiehellman-and-transient-hash-masking).

The [26-case evidence in wallet.json](../contract/evidence/ecc-validation/wallet.json), produced by
[contract/src/tests/ecc-wallet.ts](../contract/src/tests/ecc-wallet.ts),
uses shielded-wallet/address-format **4.0.0-rc.0** and Ledger **1.0.0-rc.5**.
The address codec accepts identity, order-two, mixed-torsion, invalid and even
wrong-length encryption keys. The transfer builder rejects the tested malformed
and non-prime-subgroup keys, **but accepts identity**. Wrong-network and checksum
controls reject correctly. Both normal and identity transfers apply to a local
Ledger state with **native/contract proof checks and fee balancing disabled**;
native-proof verification rejects both mock-proof controls. These are synthetic
funding tests, not live-node or browser-wallet acceptance. Reject identity
encryption recipients before presenting or approving payment addresses.

**Live submission blocked by environment:** [localnet.json](../contract/evidence/ecc-validation/localnet.json), produced by
[contract/scripts/check-ecc-localnet.py](../contract/scripts/check-ecc-localnet.py),
found connection refusal at node `9944`, indexer `8088`, and proof server `6300`,
including outside the sandbox. Neither Docker/Podman nor their sockets, nor a
built native node, were available. No transaction was submitted. A live test
still needs a compatible Ledger 9 node, indexer and proving setup, such as
[contract/infra/docker-compose.yml](../contract/infra/docker-compose.yml), a funded
test wallet, genuine transaction proofs and fees, and confirmation of inclusion;
the local Ledger result cannot establish those outcomes.

**Public test networks are not a drop-in substitute:** the official
[Midnight compatibility matrix](https://docs.midnight.network/relnotes/support-matrix)
currently lists Ledger 8 public networks and explicitly excludes Compact 0.35 /
runtime 0.20 Ledger 9 contracts. The [network endpoint reference](https://docs.midnight.network/relnotes/network)
lists public Preview access and token-protected Preprod access; changing URLs
alone would not validate this repo's pinned implementation. Docker is not an
absolute requirement: the [node-2.1.0-rc.4 release](https://github.com/midnightntwrk/midnight-node/releases/tag/node-2.1.0-rc.4)
provides native node/toolkit binaries as a possible local-network route. Their
complete proving/indexing setup has not been exercised in this review.

**Critical if used for real custody, already documented:** the
foundations demo (source: [demo/mn-passport-foundations/contracts/account.compact](../demo/mn-passport-foundations/contracts/account.compact))
publishes plaintext recovery shares. Anyone can reconstruct the recovery secret
and invoke recovery to install their own device. Its authentication uses secret
hash preimages rather than on-chain ECC signature verification; point validation
would not fix this recovery disclosure. Keep this prototype separate from the
reference contract's security claims.

## 4. Evidence and remaining checks

Re-run during this review: all **13 existing reproductions passed**—five backend
tests with proofs 0.8.3, five with 0.8.2, and three native Ledger tests against
the pinned rc.5 source. Both backend runs rejected the altered-coordinate proof.
The native test recovered plaintext for an identity encryption recipient.
See [ecc-validation-checks/README.md for the harness and commands](ecc-validation-checks/README.md) and
[ecc-validation.md, §7](ecc-validation.md#7-validation-results-and-remaining-work).

The initial Node/OpenSSL check of X25519 inputs `0` and `1` was expanded to 14
low-order encodings derived from the Edwards torsion fixtures, the twist's
`p−1`, noncanonical `p,p+1`, and their high-bit aliases. This tests the installed
backend, not every implementation. Compact 0.35.0 source was inspected in the local upstream
repository; its generated point checks in [compiler/typescript-passes/print-typescript.ss](https://github.com/LFDT-Minokawa/compact/blob/debb05f9414b9d1e176741c2be289bb32233f0fc/compiler/typescript-passes/print-typescript.ss#L1114-L1129)
and runtime validators in [runtime/src/utils.ts](https://github.com/LFDT-Minokawa/compact/blob/debb05f9414b9d1e176741c2be289bb32233f0fc/runtime/src/utils.ts#L68-L89)
match Passport's declared compiler/runtime versions.

**Follow-up validation, 15 October 2026:** the missing compiler/dependencies were
installed and the unchanged account was compiled with Compact 0.35.0. The
[test commands and evidence in contract/evidence/ecc-validation/README.md](../contract/evidence/ecc-validation/README.md)
now cover **197 asserted cases**, **63 native preprocessing checks**, **26 raw
input checks bypassing JavaScript validation**, nine MockProver checks, and
two full local proofs plus two damaged-proof controls. This supersedes the
initial 106-case run. Valid controls accompany the negative cases:

- Identity, small-order, mixed-torsion, off-curve and wrong-curve signer keys
  were rejected at use. Foreign-curve malformed keys were rejected before
  signature verification. Commitment-only enrolment still accepted invalid keys.
- Eight altered-coordinate cases passed JavaScript execution, but **all eight
  failed the actual compiled circuit's native input decoding as noncanonical**.
  This confirms an execution/proving discrepancy, not a proof bypass.
- Raw bootstrap input mutations rejected 23 malformed encodings, with three
  valid controls accepted. These are native decoding/execution checks; they do
  not replace constraint testing of maliciously manufactured internal witnesses.
- Identity `R` passed device/grant/recovery constraints and device full-proof
  verification. An executable check recovered the test signing key from its
  zero-nonce signature. Both ECDSA arms accepted high/low-`s` forms and rejected
  the tested zero/out-of-range `r,s` variants.
- Invalid X25519 installation, Ledger WASM identity-recipient output
  construction, and wallet SDK transfer acceptance were reproduced as described above.

Additional suites passed: grant offline **127/127**, Rust signer **38/38**
(including empty/zero-secret import), P-256/WebAuthn offline, recovery offline,
and recovery simulation. Two simulator harnesses needed `.data` extraction from
the current SDK's constructor result; no production contract logic was changed.
The Rust signer locks curves **0.2.1**, separately from the circuit backend's
**0.3.1**. See [auxiliary.json for supplementary runs](../contract/evidence/ecc-validation/auxiliary.json).

Existing conformance JSON and browser transcripts remain historical evidence.
No production proof or deployed-wallet submission was made in the follow-up;
only the explicitly marked cases received constraint checks/full local proofs.
The review was independently checked by three agents covering contract/client
logic, cryptographic evidence, and integration scope. Their follow-up added
the valid-rotation/stale-wrap scenario and hashes of compiled IR and imported
client sources; no additional authorisation bypass was demonstrated.
Remaining work is broader malicious internal-witness coverage beyond §5's
targeted Jubjub tests, browser-wallet import/transaction approval, and
production-parameter proving/node submission. The remaining integration limits
must not be confused with a failed test or a demonstrated exploit. This is a
targeted review, not an audit of all experiments or cryptographic APIs.

## 5. Additional follow-up checks

These are new checks of the current implementation, not claims that all five
remaining areas are exhaustively covered. See [commands and detailed evidence](../contract/evidence/ecc-validation/README.md#additional-follow-up-checks).
Sources: [contract/src/tests/ecc-malicious-witnesses.rs](../contract/src/tests/ecc-malicious-witnesses.rs)
and [contract/src/tests/ecc-followups.ts](../contract/src/tests/ecc-followups.ts);
recorded results are linked from [contract/evidence/ecc-validation/README.md](../contract/evidence/ecc-validation/README.md).

| Area | Result |
|---|---|
| Malicious witnesses | **12 matched expectations**, injecting unchecked Jubjub inputs after preprocessing. Coordinate-binding constraints reject original order-two/mixed-torsion coordinates and altered `x`; `(0,0)` hits host arithmetic panics, not a demonstrated constraint rejection. In the actual bootstrap, mixed torsion is converted to the original valid prime-order key and satisfies its unchanged commitments. This is witness normalisation, not acceptance of the original torsion coordinates or a signature bypass. Arbitrary advice-cell injection and other curves remain untested. |
| Nonces and signing domains | **7 checks pass**: 256 TypeScript announcements have no duplicates; 12 challenge families and tested argument/role bindings are distinct. Rust **38/38** tests pass, including 64 fresh device announcements. Forced RNG reuse reproduces key disclosure across device/grant signatures and between recovery co-signers. These are fault-injection demonstrations, not observed normal reuse or proof of RNG quality. |
| Encoding and commitments | **5 checks pass**. Altered `x` maps to the same JavaScript arithmetic point but different boot/device/grant commitments; existing native checks reject it. Tested account/epoch/counter/origin/slot/role/envelope changes produce distinct IDs. No revocation bypass established. |
| Recovery transitions | **6 checks pass**. Invalid submissions preserve state; dead enrolments cannot enable self-removal; veto, epoch retirement and successor operation work. A successor can restore future inbox operation. Both initial wrap/key inconsistency and a previously correct wrap becoming stale after valid rotation are reproduced; the intended session/rotation/churn lifecycle matters. Source: [contract/src/tests/ecc-followups.ts](../contract/src/tests/ecc-followups.ts), recovery stage. |
| Browser wallet and live node | **Still untested end to end.** Chrome/Firefox exist, but no isolated wallet-approval test was performed. A fresh outside-sandbox probe again found no node/indexer/prover, so genuine proving, submission and inclusion remain blocked. |
