# Current-contract ECC adversarial tests

Run on **15 October 2026**, against the unchanged account contract compiled with
**Compact 0.35.0** (`debb05f94`), runtime **0.20.0**, Node **22.23.3**.
These tests characterize current acceptance, including known gaps; a passing
suite does not mean every input was rejected.

## Reproduce

Use Node >=22.12, the pinned Compact compiler, Rust 1.95, and a Git checkout of
[midnight-zkir](https://github.com/midnightntwrk/midnight-zkir) containing commit
`e82d81d25aabcc5f5092e2bd559083487f577914`:

```sh
cd contract
npm ci
npm run compile:ecc
npm run test:ecc
npm run test:ecc-wallet
python3 scripts/check-ecc-localnet.py
python3 scripts/run-ecc-constraints.py /path/to/midnight-zkir --full-proofs
```

`compile:ecc` compiles the current source with ZKIR v3 and `--skip-zk`; proving
keys are unnecessary. If only the release `compactc` binary is installed, use
`compactc --feature-zkir-v3 --skip-zk contracts/account.compact contracts/managed/account`.
The Rust runner archives the pinned upstream revision into a temporary directory
and adds a test module; it changes no library logic or caller checkout. The module
can access upstream's private preprocessing method because it is inside that
crate. Two stale workspace version labels in the upstream lockfile are corrected;
all dependency versions remain pinned. `--offline` is available after caching
dependencies. Compilation may take several minutes. `--full-proofs` additionally
generates/verifies proofs with local test-only KZG parameters; omit it to run
only native decoding and MockProver checks.

The Rust dependency set is the compiler consumer's: circuits **7.2.4**, curves
**0.3.1**, proofs **0.8.2**, stdlib **2.3.5**, with Ledger helper crates at upstream's
locked `9a8777c4…` revision. It is distinct from the rc.5 native encryption harness
in the [platform report](../../../research/ecc-validation.md).

## Results

[runtime.json](runtime.json) records **197 asserted cases**: 89 accepted and 108
rejected. It includes compiler metadata, source/generated-code/lockfile hashes,
and exact rejection messages. Rejections leave the simulator's full committed
state unchanged. Raw malformed objects bypass signer adapters. Valid controls
exercise each tested authorisation arm.

[constraints.json](constraints.json) records **63 native preprocessing checks**
on successful local calls: 55 accepted, eight rejected. It also records **26 raw
input mutations** bypassing JavaScript validation (three valid controls accepted,
23 malformed cases rejected), **nine MockProver checks**, and **two verifying
full local proofs** with two rejected damaged-proof controls. No production
parameters or node submission were used.

| Input/boundary | Generated JavaScript execution | Native/proof-boundary evidence |
|---|---|---|
| Jubjub identity, order-two, mixed-torsion, off-curve and P-256 points used as signer keys | Rejected at bootstrap/device/grant/recovery gates and session publication | Direct bootstrap-input mutations also rejected by native preprocessing; not direct constraint checks of malformed internal witnesses |
| secp256k1/P-256 identity (including nonzero unused coordinates), off-curve, wrong-curve and out-of-range keys | Rejected at bootstrap, device and grant authorisation | Native raw bootstrap checks also reject malformed flags, shifted coordinates and oversized limbs |
| Jubjub `x+2,y`, used as key or signature announcement | Accepted in eight paths | All eight rejected by the actual compiled circuit's input decoding in ZKIR preprocessing: `not in canonical form` |
| Weak/invalid Jubjub device and grant commitments | Enrolment/issuance accepted; weak-key use rejected | Successful commitment-only calls pass preprocessing: the raw key is absent from their inputs |
| Invalid birth recovery key | Stored, including identity/off-curve pairs; later recovery use rejected, except the altered-coordinate evaluator case | Constructor storage was not separately proved; altered-coordinate recovery use fails native preprocessing |
| Identity announcement `R=O` with a deliberately valid zero-nonce response | Accepted at device, grant and recovery gates, including either/both recovery announcements; damaged response rejected | All tested variants pass constraints; normal/identity device announcements also verify full local proofs; damaged proofs rejected |
| 14 low-order X25519 encodings | Constructor and rotation accept; inbox sealing rejects; generated-key sealing/decryption works | Rotations pass native preprocessing; unrelated-secret and malformed-ephemeral reader controls fail cleanly |
| ECDSA high/low `s`, zero/out-of-range scalars | Both arms accept high/low `s`; tested invalid scalar variants rejected | Accepted variants pass native preprocessing; no full ECDSA proof run claimed |
| Ledger WASM identity encryption recipient | Zero-secret import and `ZswapOutput.new` succeed; publicly known zero key recognises output | Normal-recipient detection control fails; invalid compressed point is rejected; no wallet UI or transaction submission |

The eight altered-coordinate paths are bootstrap, device authorisation, grant
spending, stored-key recovery submission, signature announcement, successor-device
recovery submission, successor-recovery-key submission, and session publication.

Raw native input packing is checked against a valid runtime preimage first.
Foreign fields encode `(x−1) mod p`, then split into 192/64-bit limbs. These
tests exercise native input rejection, not a malicious prover's handcrafted
internal circuit witness. Full local proofs use synthetic test parameters.

[auxiliary.json](auxiliary.json) records additional passing grant (127), Rust
signer (38), WebAuthn, recovery, and original backend/native suites. Two existing
simulator harnesses were corrected to pass constructor-result `.data` to the
current runtime; production contracts were unchanged.

The suite uses fixed signing scalars/nonces as test fixtures. Identity `R` does
not let an attacker sign for an unknown live key; if a real signer emits nonce
zero, someone receiving its response and challenge can recover the secret.
See [Passport review](../../../research/passport-ecc-validation.md).

## Wallet and local-node follow-up

[wallet.json](wallet.json) records **26 matched expectations** against installed
shielded-wallet/address-format **4.0.0-rc.0** and Ledger **1.0.0-rc.5**. The
[wallet test](../../src/tests/ecc-wallet.ts) needs no Compact artifacts or services.
All nine encryption-key vectors round-trip through the Bech32m address codec,
including identity, torsion/mixed-torsion, invalid encodings and wrong lengths.
The default SDK `makeTransfer` builds balanced shielded offers for normal and
identity recipients; seven other vectors fail in output processing. Zero-secret
import succeeds, and the known zero secret recognises the identity output after
unproven and proof-erased transaction serialization. Network/checksum controls
reject. This tests SDK components used by the wallet, not a browser wallet UI
or the full funded facade/proving workflow.

Normal and identity transactions also pass local Ledger well-formedness and
state application, using synthetic funding and **proof verification/fee
balancing disabled**. Limits and signature checks are enabled; both mock-proof
controls are rejected specifically as invalid Zswap proofs when native-proof
verification is enabled. No production-proof or node acceptance is implied.

[localnet.json](localnet.json) records the separate environment probe: node
`9944`, indexer `8088` and proof server `6300` refused connections outside the
sandbox; Docker/Podman commands and sockets were absent. No built native node
was found either. **Live submission was not attempted.** The probe only checks
TCP availability, not service health. Re-run it after starting the pinned
`infra/docker-compose.yml` stack; a funded, genuinely proved transaction and
confirmed inclusion are still required to close live-node acceptance.

## Additional follow-up checks

Run the suites one at a time:

```sh
python3 scripts/run-ecc-constraints.py /path/to/midnight-zkir --offline --witness-only
npm run test:ecc-nonces
(cd signer-rs && cargo +1.95 test --offline --locked)
npm run test:ecc-encodings
npm run test:ecc-recovery
python3 scripts/check-ecc-localnet.py
```

- [malicious-witnesses.json](malicious-witnesses.json): **12 expectations**,
  bypassing preprocessing through unchecked subgroup wrappers. A coordinate-bound
  assignment projection rejects order-two, mixed-torsion and altered-`x`
  coordinates with unsatisfied constraints. Identity passes this generic
  primitive. `(0,0)` panics in host arithmetic, explicitly distinguished from
  constraint rejection. The compiled bootstrap uses fixed valid commitments:
  valid and mixed-torsion wrapper witnesses pass because assignment maps the
  latter to the valid prime-order point. Other compiled cases reject during
  synthesis or host arithmetic. Cached computed values are removed, but public
  input consistency guards remain. This is not arbitrary advice-cell injection
  or a full malicious-witness proof, and does not establish a bypass.
- [nonces.json](nonces.json): **7 checks**, including 256 distinct nonidentity
  device/grant/recovery announcements, 12 distinct challenge families, argument
  bindings, and two explicit RNG-fault demonstrations. Fault injection temporarily
  replaces Node's randomness for the tested signers and restores it in `finally`.
  Reused nonces across distinct challenges reveal a shared signing key; equal
  recovery co-signer nonces let the successor derive the recovery key. No reuse
  appeared under normal sampling; this is not an entropy audit.
- [encodings.json](encodings.json): **5 checks** of altered-coordinate commitment
  divergence and account/epoch/counter/origin/slot/role/envelope separation. The
  altered-coordinate observation is JavaScript behavior; native rejection is
  covered by the original suite.
- [recovery.json](recovery.json): **6 combined scenarios**, including atomic
  invalid-key rejection, dead-entry/self-removal protection, pending rotation and
  veto, finalisation and successor repair, and successful publication of an
  inconsistent wrap/key pair that subsequently cannot decrypt inbox entries,
  and a previously matching wrap becoming stale after a valid key rotation.
  Old entries remain readable with the recovered old secret; new entries require
  the rotated secret. Coordinate session/rotation/churn according to the
  specification; an intermediate mismatch can be intentional.
  These scenarios execute generated JavaScript, without new proof claims.
- [followup-rust.json](followup-rust.json): the signer **38/38** run, now including
  64 repeated calls with identical inputs and distinct announcements.

The native assignment projection uses the compiled bootstrap's exact input type
and the unchanged pinned backend. Its extra coordinate equalities distinguish
normalisation from accepting the originally supplied malformed coordinates.

Evidence now hashes imported client sources and the actual compiled `.zkir`
files, in addition to generated JavaScript, contract sources and the lockfile.
Both native suites record their test/runner hashes and the runtime-evidence
hash. The runner refuses stale recorded circuit or client-source inputs.

Serialized preimages under `preimages/` are generated locally and ignored by Git.
Re-run the JavaScript suite before the Rust suite. The Rust results identify the
generated-code hash and runtime row count they checked.
