# Private device registry: selective revocation prototype

An isolated Compact experiment for removing a credential completely while
keeping device public keys and stable per-device identifiers off the public
ledger. The proposed specification is in the
[MIP-0013 amendment draft](../../docs/mps-mip/amendments/mip-0013-private-device-registry.md).

**Research prototype, JubJub only, capacity eight.** This does not modify the
ACC, close its existing selective-revocation defect, implement a complete
recovery protocol, or constitute an audited privacy construction. The capacity
and concrete encoding are experimental choices.

## Why this experiment exists

The current ACC removes a rolling entry. An authorised device can install
another entry for the same key and survive removal of the first. The
[recorded finding](https://github.com/midnightntwrk/passport/blob/fc19e471536febb2133f20e817847251622dcdf5/contract/README.md#spec-errata-found-while-implementing)
and [probe](https://github.com/midnightntwrk/passport/blob/fc19e471536febb2133f20e817847251622dcdf5/contract/src/tests/probe-revocation.ts)
describe this independently of the experiment.

A public stable key hash would support uniqueness but expose a persistent
pseudonym and allow matching known candidate keys. This experiment instead
keeps the uniqueness identity inside a blinded, private roster.

## Construction exercised

The private roster is a vector of eight rows:

```text
row = { active, identity, policy }
identity = persistentHash(identity_domain, actual_account_address, JubJub_public_key)
root = persistentCommit((root_domain, actual_account_address, epoch, rows), blind)
```

The exact typed recipes and domain bytes are in
[`contracts/registry.compact`](contracts/registry.compact). The curve-specific
identity domain is experimental. Policy, slot, counter, epoch and blinding do
not create a second identity for the same account/key. `policy` is an opaque
32-byte tag whose equality is checked; no WebAuthn, envelope-selection or
role-policy engine is implemented here.

All active identities must be distinct. Inactive slots must contain zeroed
metadata. The number of active rows must equal the public count. These checks
execute in the circuit, including when a malicious caller supplies the roster.
Count is authenticated through the complete committed vector rather than an
independently supplied private counter.

| Operation | Relation constrained by the compiled circuit |
|---|---|
| `activate` | Open the salted bootstrap commitment, apply the small-order key guard to the initial and recovery keys, derive the initial credential at the actual account address, install exactly one row, burn bootstrap. |
| `authorise` | Open the current roster; verify the acting key's identity and policy and its Schnorr signature; increment the account nonce. The registry root stays unchanged. |
| `add_device` | Check the new identity is absent, apply the small-order key guard, add exactly one row in an empty slot, and preserve every other row. The approval binds the new key/policy and resulting root. |
| `remove_device` | Prove the target present, delete exactly its row and preserve every other row, including the authorising credential. The approval binds the target and resulting root. |
| `recover` | A separate public recovery key signs installation of a singleton successor at the next epoch. It requires no old roster opening. This is a diagnostic replacement gate only. |

The bootstrap commitment binds the initial key, policy and initial root blind.
It is opened only after the real account address exists. Its payload is first
hashed with `persistentHash` and the digest is then blinded with
`persistentCommit<Bytes<32>>`. A direct point-containing `persistentCommit`
tuple passed the Compact compiler but failed native mock compilation during
development; the current encoding passes both layers.

Every ordinary approval binds the actual account, operation domain, acting key
and policy, current root, epoch and `auth_nonce`. Add/remove approvals also
bind their exact target and next root. The commitments authenticate the roster
and its blind; mutation constraints authenticate the transition. Signatures
use the existing SHA-256 challenge grinding and JubJub verification equation.
The signing secret and nonce scalar stay in the test client; neither is an
input to a state-changing circuit. Pure exported helpers are off-chain
derivation functions, not additional provable entry points.

## Public and private boundaries

Public ledger fields are `root`, `count`, `epoch`, `auth_nonce`, `booted`, `boot`
and the intentionally public `recovery_pk`. The account, operation name,
registry changes and any public transaction metadata remain observable.

The device public keys, canonical identities, policy tags, roster slots,
roster opening, bootstrap opening and device signatures remain private circuit
inputs. A delegated prover receiving those inputs can see them. This design
does not promise privacy from an authorised device, its prover, or someone who
has obtained the private opening.

The client must generate secret high-entropy blinds. The circuit cannot prove
that supplied randomness was sampled unpredictably. The tests use fresh
32-byte CSPRNG values for every registry change and independent bootstrap
randomness. Freely choosing a new blind does not bypass identity uniqueness.

Ordinary authorization by either of two enrolled devices, from the same
public state, produces **identical public VM transcripts and resulting public
state** in the recorded test. This is useful disclosure regression evidence;
it is not a proof of zero-knowledge or of indistinguishability of entire
network transactions, proving performance, wallet traffic or different arms.

## Validation recorded on 2 November 2026

[`evidence/offline.json`](evidence/offline.json) records **32 passing scenario
checks**, executed against the generated Compact circuits. The harness tests:

- bootstrap substitution and replay, dormant accounts and last-device removal;
- duplicate-key attempts after device use with different policy, blind and slot;
- invalid signatures, unauthorised keys, incorrect openings, malformed rows,
  account binding, stale roots and signature replay;
- hidden extra insertions, collateral updates, self-removal, unknown targets
  and substitution of the signed successor root;
- removal after repeated use, continued authorization by the surviving device,
  explicit authorised re-enrolment and bounded capacity;
- diagnostic recovery without the old opening, rejection of the old devices,
  epoch/nonce advancement, successor authorization and recovery replay;
- equal public authorization transcripts for two devices; fixture absence on
  all five operations' public surfaces; positive controls for the fixture
  detector; local public-VM transcript replay.

The disclosure inspection includes public query operations, resulting ledger
state, effects and events. It deliberately excludes proof preimages and
`trace.input`, which contain private proving inputs. Both tested signers have
different private input encodings. The detector handles aligned encodings
with trailing zero bytes removed. Fixture absence does not establish that no
other encoding or side channel can leak data.

[`evidence/measurements.json`](evidence/measurements.json) records native
`zkir-v3 mock-compile` results, with source, dependency-lock, generated-IR and
compiler hashes:

| Circuit | Native rows | k |
|---|---:|---:|
| activate | 36,766 | 16 |
| authorise | 43,631 | 16 |
| add_device | 75,587 | 17 |
| remove_device | 72,751 | 17 |
| recover | 44,329 | 16 |

These are circuit-shape measurements, not proof times or sizes. TypeScript
checking, simulator execution, public-VM replay and native constraint
construction passed. **Keys/proofs were not generated, malicious witness
assignments were not checked in a native prover, and no transaction was
submitted to a node.** The small-order key guard mirrors the current ACC;
this is not additional evidence of full subgroup or canonical-point
soundness at every proof/backend boundary.

## Reproduce

Use Node.js >=22.12 and Compact toolchain **0.35.0**, language **0.27.0**, with
runtime **0.20.0** pinned by the lockfile. From this directory:

```sh
npm ci
npm run compile
npm run check
# Preserve the committed receipts when reproducing.
EVIDENCE_DIR=/tmp/private-device-registry-review npm test
EVIDENCE_DIR=/tmp/private-device-registry-review npm run measure
```

`compile` uses `--feature-zkir-v3 --skip-zk`. Generated artefacts are ignored.
`measure` discovers the native `zkir-v3` from the pinned Compact installation;
`COMPACT_DIRECTORY`, `ZKIR_BIN`, or `--zkir-bin` can override that discovery.
Mock-compile timings in the receipt describe only that command's execution.

## Decisions and work still required

**Private-state availability is unresolved.** A root cannot reconstruct its
roster or blind. After enrolment/removal, remaining devices need authenticated
private updates. Tests demonstrate that an old opening fails after a change;
they do not implement delivery. A malicious authorised device can commit an
otherwise valid update and withhold its new opening, making normal access
unavailable. Choosing peer replication, encrypted on-chain updates or another
delivery protocol requires explicit availability guarantees and an analysis of
malicious withholding, lost local state and revoked readers.

**Recovery is intentionally partial.** The diagnostic gate has a fixed public
recovery key, no BUSS/guardian flow, no publication, veto/cancel window, and no
successor co-signature. It validates only the feasibility of replacing the
registry without an old opening. A production recovery path must preserve
MIP-0022's guarantees and supply the successor with the new private state.

**Mixed arms and migration need separate work.** Only JubJub is implemented.
Canonical encoding and uniqueness across adapters sharing a curve/key, actual
ECDSA/WebAuthn policies, policy updates, delegated proving, independent vectors,
full ACC integration, deployment costs and migration remain unimplemented.
Capacity scaling has not been measured beyond eight slots. The schema and
signature domains differ from the ACC; this is not a verifier-only repair.

**Credential revocation has a precise scope.** Removing one key cannot undo
past transfers or identify unrelated keys a compromised device enrolled.
It also does not implicitly revoke independently issued grants. Enrolment
permissions and review of the active roster remain separate policy questions.
