# Midnight Account Custody — Reference Implementation

The Account Custody Contract (ACC) combines native-asset custody, multi-key
account authorisation, scoped grants, and recovery in one deployed account.
This README describes the implementation, its validation, and known limitations.
The canonical MIPs define the standards; this repository supplies a reference
implementation, tests, and dated evidence, including known deviations.

**Reconciled 2026/11/02 against Passport
[`eb7c51f6aabdf40376085d477f15eb3575eee6ef`](https://github.com/midnightntwrk/passport/tree/eb7c51f6aabdf40376085d477f15eb3575eee6ef).**
The recorded evidence does not establish production readiness or complete
conformance. In particular, **individual-device removal can leave another
entry for the same key live** (erratum 8 below). Validation results retain
their recorded source revision, toolchain, and execution date.

## Contract structure and scope

[`contracts/account.compact`](contracts/account.compact) is the compilation
root. It imports `CompactStandardLibrary`, includes
[`webauthn.compact`](contracts/webauthn.compact), imports `WebAuthn<21>`, and
includes [`account-p256.compact`](contracts/account-p256.compact).
JubJub and secp256k1 authorisation remain inline in `account.compact`;
P-256's arm is in the included file. The arms share one ledger and internal
custody/lifecycle functions. They are not separately deployed contracts.

The constructor sets **`spec_version = 3`**. The source exports **52 non-pure
circuits**: four shared circuits (two deposits, `recover_submit`, and
`recover_finalise`) and sixteen per arm. Each gated device operation has a
`_with_<arm>` entry point; each of the three withdrawal operations also has
`_with_grant_<arm>` entry points. Exported pure derivation functions do not
add on-chain operations. The deployment roster is in
[`src/wallet/wave-deploy.ts`](src/wallet/wave-deploy.ts).

| Arm | Signature and binding | Implementation boundary |
|---|---|---|
| `jubjub` | Schnorr over JubJub; per-operation SHA-256 challenge with grinding; rolling single-use device entries | Normative MIP-0013 profile. Approval supplies a signature, not the device secret, to proving. |
| `k256` | ECDSA over secp256k1; enrolled envelope selects `SHA-256(challenge)` or `SHA-256("midnight_signed_message:32:" \|\| challenge)` | Envelope 0 is direct software/HSM/MPC-style signing; envelope 1 models the connector prefix. Reference signers are TypeScript and Rust software implementations. |
| `p256` | P-256 ECDSA over the WebAuthn envelope; RP hash and exact origin bound to the credential | Only the fixed `wa-json134` profile: 134-byte client-data JSON, 21-byte origin, 37-byte authenticator data, UP+UV required. |

[WEBAUTHN.md](WEBAUTHN.md) specifies the exact P-256 profile and exclusions.
One real Safari account encryption-key rotation is recorded in the
[passkey experiment](../experiments/passkey-account-flow/README.md); that
is not general browser, authenticator-extension, variable-JSON, or PRF
coverage. Per-arm circuits avoid paying the other arms' signature constraints
in each proof. The [1 October measurements](P256-MEASUREMENTS.md) retain their
original source/key attribution and are not fresh measurements of later fixes.

**State and authority.** Device arms share the rolling-entry set,
`device_count`, `device_epoch`, and `auth_nonce`. Cross-arm enrolment accepts
an already-derived entry. A removal must leave its authorising entry intact;
this protects the surviving caller, but does not make an opaque entry a
unique device identity. Recovery finalisation clears the complete device set
before installing the successor; finalisation also advances the epoch.
The client default without `opts.recovery` discards the generated birth
secret. Installed recovery circuits therefore do not by themselves mean an
account has a usable recovery setup; deployers must supply their recovery
configuration or publish a usable session while a device remains available.

Grantees live in a separate `grants` map. Withdrawal checks bind the grantee,
operation, object, scope openings, nonce, expiry, and quantitative bounds.
Grant calls settle their own record without rolling the owner's entries or
advancing `auth_nonce`; `revoke_all_grants` advances `grant_generation` and
clears the map. An optional immediate-contract-caller pin is checked through
`kernel.caller()`, not a caller-supplied address. It does not authenticate a
browser origin or the calling circuit. See [GRANTS-CALLER.md](GRANTS-CALLER.md).

**Security review boundary.** The three Compact files above depend on
witness, signing/challenge, inbox, recovery, and deployment code. A review
scope should identify which client paths it includes. The only declared
contract witness is `held_coin`, implemented in
[`src/wallet/witnesses.ts`](src/wallet/witnesses.ts). The encrypted inbox and
recovery wrapping are client-side cryptography, not inspected by the contract.
Shielded-spend signatures bind the exact qualified `held_coin`, including `mt_index`;
trying a different coin-position candidate therefore requires a new signature.
For unshielded recipients, `UserAddress` takes decoded address bytes, not the
signing public key. Use the conversion in
[`src/node/wallet.ts`](src/node/wallet.ts); substituting public-key bytes can
strand funds at an address the intended recipient does not control.

| Material | Location |
|---|---|
| Account wrapper, scope construction, discovery, coin capture | [`src/wallet/`](src/wallet/) |
| Device/grant signing and WebAuthn adapter | [`signer.ts`](src/wallet/signer.ts), [`signer-p256.ts`](src/wallet/signer-p256.ts), [`webauthn.ts`](src/wallet/webauthn.ts) |
| Inbox encryption and recovery | [`inbox.ts`](src/wallet/inbox.ts), [`recovery.ts`](src/wallet/recovery.ts), [`recovery-gate.ts`](src/wallet/recovery-gate.ts) |
| Independent Rust signer and recovery vectors | [`signer-rs/`](signer-rs/), [`buss-rs/`](buss-rs/) (BUSS profile over a pinned upstream `arc-pleiades` revision) |
| Tests and raw receipts | [`src/tests/`](src/tests/), [`evidence/`](evidence/) |
| Compiler/dependency and localnet pins | [`package.json`](package.json), [`package-lock.json`](package-lock.json), [`infra/`](infra/) |
| Test scaffolding, excluded from the deployed ACC | `control.compact`, `faucet.compact`, and `probe-*.compact` in [`contracts/`](contracts/) |

As of 2 November 2026, [EVM/EIP-712 #188](https://github.com/midnightntwrk/passport/pull/188)
and [Solana/Ed25519 #189](https://github.com/midnightntwrk/passport/pull/189)
are separate open PRs. They are not in this 52-circuit baseline. Neither are
the isolated BIP-340 and asset-policy experiments. Adding these arms requires validation of the combined revision and its
complete circuit roster.

## Standards and grant submission

| Standard | Relationship to this implementation |
|---|---|
| [MIP-0012 — Contract Custody](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0012-native-asset-custody.md) | Native unshielded/shielded custody, encrypted inbox, discovery and payment modes. |
| [MIP-0013 — Account Authorisation](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0013-account-authorisation.md) | JubJub device authorisation, rolling entries, lifecycle and revocation. See the unresolved device-identity issue below. |
| [MIP-0022 — Account Recovery](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0022-account-recovery.md) | Recovery publication, submission, veto/cancel and finalisation. Atomic entry retirement is implemented. |
| [MIP-0030 — ECDSA Authorisation](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0030-ecdsa-account-authorisation.md) | Draft extension for ECDSA/WebAuthn; the fixed implementation profile is not a general WebAuthn baseline. |
| [Scoped Grants and dApp Connection](../docs/mps-mip/mips/mip-xxxx-scoped-grants.md) | Local Draft covering bounded grants plus the wider connection ceremony. Section 12 specifies combined conformance with MIP-0013. |

The grants Draft completed Passport review in
[PR #195](https://github.com/midnightntwrk/passport/pull/195), merged on
23 October 2026.
It is ready for canonical **Draft submission**: copy it as
`mips/mip-xxxx.md`, retaining `MIP: xxxx` and `Status: Draft`. Its 26 formerly
local evidence links (19 distinct targets) now use full Passport URLs pinned
to `eb7c51f6aabdf40376085d477f15eb3575eee6ef`; existing historical pins are
preserved. Each target path and section anchor was checked against Git.
No scoped-grants MIP or submission PR was found in the canonical repository
on 2 November 2026. The
[MIP-0001 process](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0001-mip-process.md#draft-phase-clarifications)
permits incomplete Drafts; the formal Draft-to-Proposed acceptance request
is a later step. Cryptographic review, MIP-0021 domain compatibility,
conformance and ceremony work remain explicit in Path to Active. Initial
publication does not close them. Editor numbering and the MPS-0018 linkage
belong to upstream submission/numbering, not a locally invented number.

The [draft register](../docs/mps-mip/README.md) tracks canonical links.
Implementation and evidence are distinct from publication, independent review,
and Path to Active acceptance. Grant issuance requires schema v3: the client
rejects a missing or older version before requesting a device signature or
submitting through its low-level issuance method. V3 adds `caller_commit`
even to unrestricted scopes; a v2 account needs a fresh deployment, not just
new verifier keys.

## Validation and provenance

Read [GRANTS-COMPLETION.md](GRANTS-COMPLETION.md) first for the **23 October
2026** validation. Its base is `3fa1b32585032305f3dbef15476dd5fe7fca8a4b`.
The three Compact source files in that run match this README's baseline.
The saved account source SHA-256 is
`ef1e3d6eb873e91e205c12e07f33cda744d228470dd43a4794cb3784447fd6ae`.

That run freshly generated 52 textual ZKIR files with `--skip-zk`, compared
them byte for byte with existing artefacts, and used matching cached binary
ZKIR and proving/verifier keys with integrity checks enabled. **It was not
a clean regeneration of all keys.** Generated code and keys are ignored by
Git. All 25 committed input-hash references in the three 23 October records
match the baseline revision above. The other 45 references concern generated
artefacts absent from a clean checkout; checking those hashes requires the
corresponding build outputs.

| Evidence | What passed | Limit of the claim |
|---|---|---|
| [23 October build/offline record](GRANTS-COMPLETION.md#reproduction-and-provenance) | TypeScript build, unit, toolchain, grants (127 checks), capability, caller, P-256, recovery simulator and independent Rust cross-implementation checks; ten-wave plans for all three initial arms | Simulator/client checks and saved run results; not an independent audit. |
| [P-256 grants](evidence/grants-completion-20261023/p256-grants-conformance.json) | Full 52-circuit account; eleven successful funding/lifecycle transactions including three unshielded grant spends; balance 100 → 85; sixteen negative controls | OpenSSL software authenticator. Negatives abort during building against indexed state, with no proving/submission and unchanged serialised state. Successful shielded or forwarded P-256 grant calls are not covered. |
| [P-256 refusal fixture](evidence/grants-completion-20261023/p256-grant-refusals.json) | Identity-key and fixed-profile authenticator-extension refusals; valid assertion reaches the unfunded custody guard | Restricted three-operation diagnostic deployment, not a full account. Refusals are native argument/profile/build checks. |
| [Recovery and grant lifecycle](evidence/grants-completion-20261023/rec-1-9-recovery-conformance.json) | Full account; reconstruction/wrap opening, veto, cancel/resubmit, two recoveries; exactly the authorised successor retained each epoch; old grants stay unusable, reissued JubJub/k256 grants spend | Post-reset-fix proof/node evidence. Negative cases compare specified state fields, not a full state/UTXO snapshot. The explicit future-epoch, differing-counter, pending-device and all-scheme retirement matrix remains broader. |
| [Caller-bound grants](GRANTS-CALLER.md) | Recorded forwarding and fabricated-caller proof admission checks for the earlier JubJub/k256 tranche | Earlier source/roster; not successful P-256 forwarding on the final combined account. |
| [ECC adversarial tests](evidence/ecc-validation/README.md) and [review](../research/passport-ecc-validation.md) | 197 runtime cases (accepted and rejected expectations), native preprocessing/mutations, nine MockProver checks and two verifying local full proofs | The runtime record hashes account source `c6888fe` (before the reset); the P-256/WebAuthn and recorded client sources match the pinned baseline above. Client input checks have since changed as described below. The native runner later gained archive prevalidation. Local proofs use test parameters. Not a fresh full-account run or a complete malicious-witness or ECDSA proof audit. |

The 23 October recovery evidence supersedes the older statement that #183
had only compilation/simulator validation. Earlier receipts retain their
original compiler, circuit roster and stack attribution; do not combine
all passing counts into a claim that every current circuit was proved.

### Client input checks

TypeScript JubJub and secp256k1 device and grantee signers require a `bigint`
secret strictly between zero and the curve order. Rust secret imports reject
empty, malformed, zero and out-of-range values; JubJub key generation and
signing retry a zero random sample. The JubJub signature response parser
still permits zero.
Hexadecimal byte decoding rejects malformed characters. Inbox sealing
requires exactly 32-byte X25519 keys and coin identifiers, and an unsigned
128-bit coin value, preventing silent truncation or wrapping. Invalid inbox
records still return `null` when opened.

`npm run test:input-validation` covers rejection cases, valid boundary
signatures and inbox round trips;
`cargo test --locked --manifest-path signer-rs/Cargo.toml` covers Rust imports
and zero-sample retry. These checks change the reference clients, not the
Compact circuits or schema. Historical
ECC receipts retain their original observations; they are not rerun results
for these input checks.

## Known issues and remaining validation

1. **Individual-device revocation is incomplete.** `remove_device` removes
   one rolling entry. A device can enrol another entry for the same key and
   survive removal; the JubJub probe demonstrates this on-node for both
   enrolment shapes. The shared lifecycle design affects the account across
   arms. A contract-maintained device identity is the proposed remedy and
   changes the ledger schema. The defect remains unresolved in this
   baseline. See erratum 8 and
   [`probe-revocation.ts`](src/tests/probe-revocation.ts).
2. **Key validity at enrolment differs from validity at use.** Opaque device
   entries/grant IDs can commit unusable keys. The constructor can store an
   invalid birth recovery key that is refused later. Weak signer-key guards,
   runtime decoding, and native proof constraints are different layers;
   the [ECC review](../research/passport-ecc-validation.md) maps them.
   JubJub's `[8]pk != O` rejects small-order keys but does not itself prove
   prime-order subgroup membership. K256 checks extracted coordinates,
   not `pk != default<Secp256k1Point>`; the pinned runtime also validates
   foreign points. Accepted runtime inputs are not proof-acceptance evidence.
3. **Encryption/recovery consistency needs review.** Authorised setup or
   rotation can install unusable X25519 bytes; a recovery wrap may contain
   a different secret or become stale after rotation. Invalid setup can
   impair availability or recovery without bypassing authorisation. The
   client input checks above do not validate installed encryption keys or
   prove recovery-wrap consistency. Broader signer-randomness and
   cryptographic review remain open.
4. **Recovery coverage is not exhaustive.** The reset is implemented and
   exercised on-node. Explicit adversarial retirement combinations,
   guardian transport/interoperability, multi-session review, and the
   viewing-wrap lifecycle remain review/validation work.
5. **Grant and browser conformance remain partial.** Full authoriser/dApp
   ceremony, browser attack matrix, read-capability handover/re-sealing,
   non-browser carriage, independent implementation/review, the wider
   rejection matrix, and the real legacy-account installation control
   remain in the Draft's Path to Active. A profile-specific P-256 run
   does not close these items.
6. **Deployment authority is a custody boundary.** Pin the roster and
   maintenance policy with the reviewed revision. A live authority can change
   verification logic; retirement prevents later repairs or arm additions
   through maintenance. See the deployment section below.

A reproducible review baseline needs the commit and included arms,
known-issue dispositions, compiler/dependency pins, clean build/key-generation
results, and scoped regression receipts.

## Pinned toolchain and deployment

The checked-in configuration uses Compact **0.35.0**, language **0.27.0**,
`--feature-zkir-v3` (ZKIR 3.1), compact-runtime **0.20.0**, compact-js
**3.0.0-rc.3**, midnight-js **5.0.0-rc.2**, ledger-v9 **1.0.0-rc.5**, and
wallet-sdk facade **5.0.0-rc.0**. Exact npm resolution is in the lockfile;
Rust crates have their own lockfiles. These are reproduction pins, not a
claim that they are the latest upstream releases.

[`infra/docker-compose.yml`](infra/docker-compose.yml) pins node
**2.1.0-rc.4**, indexer **4.4.0-rc.6-b5e6c809**, and proof server
**9.0.0-rc.8**. [TOOLCHAIN-0.35.md](TOOLCHAIN-0.35.md) records the 1 October
image digests and pre-P-256 upgrade run. That report's 36-circuit roster
predates this 52-circuit account.

### Wave deployment and maintenance authority

The [planner](src/wallet/wave-deploy.ts) reads actual verifier-key sizes.
Its default `VERIFIER_BYTE_BUDGET` is **15,000 bytes** per deploy or maintenance
wave. The recorded full-account plan is **ten waves** for every initial arm;
recompute it when keys or the roster change. Activation follows key
installation. This working budget is not a measurement of an exact node
limit or of complete transaction size.

### The maintenance authority sits above the seam, so the last wave retires it

By default the last maintenance update retires the authority by setting an
empty committee with threshold one. With `retireAuthority: false`, its
holder can replace an existing operation's verifier using a
**`VerifierKeyRemove` plus `VerifierKeyInsert` in one update**. A bare insert
over an existing key is refused. The live/retired controls in
[`auth-coinless`](src/tests/auth-coinless.ts) demonstrate this distinction;
a live authority must therefore be included in the custody threat model.
A retired account needs migration to adopt changed verifier logic or new
arms. Ledger-schema changes require a fresh deployment regardless.

The planner builds maintenance updates through the ledger API. On these
pins the SDK maintenance helper hardcodes an incompatible operation/key
version, and its bare-insert replacement path does not perform the required
remove-plus-insert. See the source and historical controls rather than
substituting that helper during reproduction.

### Historical deployment and funding observations

- The original 18-key deployment exceeded the measured ledger-9 block
  budgets (53,076 bytes written versus 50,000; 2.011 s versus 2.000 s).
  The later 30-circuit v2 roster deployed in three waves on its older stack.
  [GRANTS-E2.md](GRANTS-E2.md) and [wave-ceiling.json](evidence/wave-ceiling.json)
  preserve the measurements. Their 25,000-byte planner budget and measured
  maintenance-key boundary do not describe the current ten-wave plan.
- [dismiss-cost.json](evidence/dismiss-cost.json) prices a small NIGHT-funded
  deposit at 16.504 ms against a 16.266 ms dismissal budget. The recorded
  limitation concerns the funding leg with NIGHT change, not all unshielded
  calls. Non-native unshielded grants were subsequently included on-node.
  NIGHT-funded suites have no replacement full-run evidence here; reproduce
  the funding probe on the selected stack before claiming that gap closed.
- The client handles observed Dust-state lag with bounded submission retries.
  Stale localnet state and TTL expiry can still fail a run; capture the actual
  failure instead of counting it as a contract rejection. Localnet setup and
  provider behaviour are in [`src/node/`](src/node/).

## Running

Run from `contract/`, using Node.js **>=22.12**, the pinned Compact compiler,
Rust for the cross-implementation checks, and Docker for node-backed suites.
Generated code and keys under `contracts/managed/` are not committed.
`npm run compile` builds the account, control, faucet, block-time, P-256 and
caller probes; the caller probe uses the flag selection in `package.json`.
`--skip-zk` alone is not a keyed build and is insufficient for proving.

```sh
compact update 0.35.0
npm ci
npm run compile
npm run build
cargo build --locked --manifest-path signer-rs/Cargo.toml
cargo test --locked --manifest-path signer-rs/Cargo.toml

npm run test:unit
npm run test:input-validation
npm run test:toolchain-offline
npm run test:grants-offline
npm run test:grants-capability-offline
npm run test:grants-caller-offline
npm run test:p256-offline
npm run test:recovery-offline
npm run test:recovery-sim
npm run test:crossimpl-offline
```

For ECC checks, use the separate
[reproduction instructions](evidence/ecc-validation/README.md), including
the pinned native backend and test-parameter limitations. The standalone
Rust BUSS vectors are documented in [`buss-rs/README.md`](buss-rs/README.md).
A recorded P-256 full-account proof exhausted an approximately 8 GiB Docker
VM; the successful [measurement run](P256-MEASUREMENTS.md) used 24 GiB.
That is an observation, not an exact minimum-memory requirement.

To start the development localnet (omit the macOS override on Linux):

```sh
printf 'APP__INFRA__SECRET=%s\n' "$(openssl rand -hex 32)" > infra/.env
docker compose -f infra/docker-compose.yml -f infra/docker-compose.macos.yml up -d

# Public development funding seeds, for this localnet only.
export WALLET_SEED=0000000000000000000000000000000000000000000000000000000000000001
export WALLET_SEED_SECONDARY=0000000000000000000000000000000000000000000000000000000000000002
# Use a fresh output directory so historical receipts are preserved.
export EVIDENCE_DIR=/tmp/passport-acc-review-evidence

npm run test:p256-grants
npm run test:p256-grant-refusals
npm run test:recovery
```

Wait for node/indexer readiness before testing. Run node suites sequentially:
they share funding-wallet state and proving resources. If changing Compose
project names, set the container overrides used by the suites, such as
`MIDNIGHT_PROOF_CONTAINER`. The evidence writer records configured stack
tags, with defaults matching Compose; set `MIDNIGHT_NODE_TAG`,
`MIDNIGHT_INDEXER_TAG`, and `MIDNIGHT_PROOF_TAG` when using different images,
and capture actual service identities as part of the run.

## Conformance map

This maps executable suites to review areas, not a blanket PASS certificate.
The dated evidence above determines which source, stack, arm and proof layer
was actually exercised. In older reports, “both arms” means JubJub and k256.

| Commands (`npm run …`) | Review area and evidence |
|---|---|
| `test:unit`, `test:crossimpl-offline` | Client encodings, challenges and independent Rust signer agreement; AUTH-9/10 binding checks. |
| `test:input-validation` | Client secret-scalar, hexadecimal, X25519 key-length and inbox coin-encoding boundaries; valid signatures and inbox round trips. |
| `test:auth-coinless` | JubJub/k256 authorisation, cross-arm enrolment, self-removal and maintenance controls; [0.35 receipts](evidence/compact-0.35/auth-coinless-arms-auth-coinless.json). |
| `test:auth`, `test:auth-lifecycle`, `test:auth-replay`, `test:auth-crossimpl` | Funded MIP-0013 suites; historical NIGHT-funding limitation applies. |
| `test:custody-shielded`, `test:custody-discovery`, `test:custody-payments`, `test:leak-audit` | MIP-0012 Testing 1–5, 7–8; historical receipts in `evidence/cust-*.json`. |
| `test:custody-unshielded` | MIP-0012 Testing 6; distinguish its NIGHT funding from non-native grant tests. |
| `test:grants-offline`, `test:grants-conformance`, `test:grants-unshielded` | [E1](GRANTS-E1.md), [E2](GRANTS-E2.md), [E3](GRANTS-E3.md), and `evidence/grants-e4-*.json`; later additions are in [GRANTS-COMPLETION.md](GRANTS-COMPLETION.md). `GRANTS_E2_GROUPS` and `GRANTS_E4_GROUPS` truncate their own scenario sequences; they do not select recovery scenarios. |
| `test:grants-capability-offline`, `test:grants-caller-offline`, `test:grants-caller` | Schema-v3 client gating and immediate caller checks. Capability fixtures do not replace deploying a real legacy account. |
| `test:p256-offline`, `test:p256`, `test:p256-browser`, `verify:p256-browser` | Fixed WebAuthn profile, proving samples, interactive real-browser experiment and recorded-assertion verification; [profile and evidence](WEBAUTHN.md). |
| `test:p256-grants`, `test:p256-grant-refusals` | Full-account spending and separate restricted refusal fixture from 23 October. |
| `test:recovery-offline`, `test:recovery-sim`, `test:recovery` | Client scheme/codec, simulator and localnet recovery layers respectively; latest node evidence includes two finalisations and grant invalidation/reissue. |
| `probe:revocation`, `probe:wave-ceiling`, `probe:block-time`, `probe:dismiss-cost` | Diagnostic probes; revocation reports the known defect, not a passing security guarantee. |

FROST committee signing is outside these account suites. General browser
connection, private-state service integration and independent cryptographic
review remain separate deliverables. Preserve the difference between a
client/build refusal, native preprocessing rejection, unsatisfied proof
constraints, and node rejection of a submitted transaction.

## Spec errata found while implementing

Implementation findings and their dispositions. Items 1–3 describe the
original specification corrections; follow their upstream links for canonical
text. Item 7 is corrected in this source; item 8 remains an open design defect.

1. **MIP-0013 §5.1 DST derivation.** The original “zero-padded or hashed
   to 32 bytes” wording left the construction ambiguous. The reference
   derives operation DSTs with `persistentHash<[Bytes<64>]>` over the tag
   padded to 64 bytes. The correction is recorded in
   [upstream #249](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/249).
   Compatibility with MIP-0021's naming convention remains explicit review
   work; this documentation does not change deployed challenge bytes.
2. **MIP-0013 §3 initial-device bootstrap.** An address-bound entry cannot
   be computed using the eventual contract address in the constructor.
   The constructor stores a salted boot commitment; the arm-specific
   `activate_initial_device_with_<arm>` checks its opening, inserts the
   address-bound entry, and burns the commitment. See
   [upstream #250](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/250)
   and the source's per-arm commitment recipes, which include additional
   envelope/policy fields where required.
3. **MIP-0012 §6.3 direct-transfer return.** The contract-recipient spend
   returns `[ShieldedCoinInfo, Maybe<ShieldedCoinInfo>]`: the sent coin as
   well as change, so the composing client can construct the payee's claim
   in the same transaction. See
   [upstream #248](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/248).
4. **Challenge mismatch rejection.** A tampered JubJub call can fail the
   ground challenge's `as Field` range check before signature verification.
   Both that failure and a failed signature equation reject the call; an
   expected negative is not defined by one error string alone.
5. **Unmirrored transfers.** The historical unshielded probe observed
   unsolicited outputs to a contract refused with custom error 186 rather
   than admitted as unmirrored holdings. That is a ledger observation from
   the recorded stack, not a claim about every possible funding route or
   future ledger version. See [`custody-unshielded.ts`](src/tests/custody-unshielded.ts).
6. **Weak-key rejection and validation layers.** Bare signature equations
   can degenerate for identity keys. The reference adds key guards, and
   the pinned runtime/backend impose further point constraints. In the
   Compact-0.35 `auth-coinless` run, tampered and weak-key negative controls
   abort during local building; they are not invalid proofs submitted to
   the node. K256 identity/off-curve cases can be refused during coordinate
   extraction or runtime validation, rather than only by an explicit
   contract assertion. The [ECC evidence](evidence/ecc-validation/README.md)
   separates runtime, native preprocessing, constraint and local-proof
   checks. A JubJub cofactor guard is not by itself a full subgroup proof,
   and opaque-key enrolment can still store an unusable commitment.
7. **MIP-0013 AUTH-6 epoch revocation is defeatable by pre-planting.** AUTH-6
   revokes a device set by advancing `device_epoch`, so that every entry bound
   to the old epoch stops matching — revocation without enumerating the set.
   That reasoning only covers entries derived at *past* epochs. Where devices
   are enrolled as an already-derived entry (MIP-0013 §6, which the cross-arm
   case forces), nothing binds the epoch at enrolment, so any authorised
   device can enrol an entry derived at `device_epoch + 1`. It matches nothing
   until the bump and authorises immediately after it, which means a
   compromised device survives the very revocation intended to evict it. **Resolved normatively by [upstream #385](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/385), merged 15 October
   2026:** MIP-0013 §8/AUTH-6 and MIP-0022 finalisation/REC-8 require atomic
   retirement, by clearing unchecked opaque entries or enforcing equivalent
   contract-assigned registration epochs. This includes pending-phase entries
   and prohibits reactivation after later epoch changes. The reference now calls
   `devices.resetToDefault()` during finalisation, before inserting the
   authorised successor. This also removes entries added while recovery was
   pending. The recovery simulator checks that the actual set contains only
   that successor, independently of `device_count`. Older deployments retain
   their installed verifier: adopting this correction requires a verifier
   update where maintenance remains available, or migration to a corrected
   deployment where it has been retired. [Passport #183](https://github.com/midnightntwrk/passport/pull/183)
   initially passed compilation with keygen skipped and simulation. The
   [23 October run](GRANTS-COMPLETION.md#recovery-and-grant-lifecycle-on-node)
   subsequently proved and exercised the corrected finalisation twice on a
   fresh full account, retaining exactly the authorised successor each time.
   This used matching cached keys after textual ZKIR comparison, not a new
   clean key-generation run. The explicit future-epoch, differing-counter,
   pending-device-enrolment and all-scheme retirement matrix remains broader
   than that run. Individual device removal remains separate (erratum 8).
8. **MIP-0013 §6 removal removes an entry, not a device, so revocation does
   not revoke.** The device set holds single-use entries and carries no
   per-device identity, so nothing constrains a device to exactly one live
   entry. An enrolled device can enrol a second entry for its *own* key: the
   seam consumes its current entry and inserts the successor, and the
   enrolment then inserts the planted one, leaving the device live at two
   counters with `device_count` inflated by one. A §6 removal takes a single
   set element, and resolving "which element is this device's" returns the
   first live counter found, so a revocation removes one of the two and the
   device keeps authorising on the other. Measured on-node
   (`src/tests/probe-revocation.ts`, jubjub arm): after the owner revoked it,
   the device signed a gated call that advanced `auth_nonce` and enrolled a
   further device of its own choosing.

   **This is not an artefact of entry-based enrolment.** The same bypass runs
   against the shape §6 describes, where the contract derives the entry
   in-circuit at the current epoch and use counter 0: once a device has acted,
   its counter-0 entry is vacant again, so enrolling its own key plants
   exactly that element. The probe exercises both shapes and both bypass, so
   deriving the entry in-circuit is not a fix for this.

   The contract cannot close the gap by inspection: it holds an opaque entry,
   or a key whose other entries it cannot search for, so "this key is already
   enrolled" is not decidable over the current ledger shape. Stating it as a
   client obligation, as the §6 note and S11 do, does not hold either, because
   the party such a rule binds is the adversary in this threat model. **§3
   needs a per-device identity that the contract maintains**: a stable
   arm-marked commitment to the address and key, kept in its own set, with the
   rolling entry derived in-circuit from that commitment, the current epoch,
   and the counter. Enrolment can then reject a key that is already live, and
   removal retires the device rather than one of its entries, while cross-arm
   enrolment survives because the commitment stays opaque to the contract.
   That is a ledger-schema change, so a redeploy rather than a maintenance
   update.

   Two further consequences follow from the same root. First, the ledger
   set is enumerable as opaque entries, but the client cannot reliably
   attribute all entries to a particular device/key. A planted entry can use
   an arbitrary counter beyond the client's 4096-counter lookup window.
   An owner can remove a known entry other than the authorising entry;
   finding every entry for one compromised key remains the problem.
   Second, every plant increments `device_count`, a `Uint<8>`: the generated
   increment's range check aborts above 255. Repeated planting can make
   further enrolment fail until entries are removed or recovery resets the
   set. The range check was inspected in generated code; saturation was
   not driven to 255 on-node in the recorded probe.
