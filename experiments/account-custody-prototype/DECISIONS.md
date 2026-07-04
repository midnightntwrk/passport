# Account-custody prototype — decision record

This experiment turns the open questions of the component canvases into
working code. Each decision below is a prototype decision: it binds this
iteration, gives the canvases evidence, and is explicitly revisitable. Where
a decision deliberately diverges from the expected v1.0 answer, the
divergence and the migration seam are named.

Originally evaluated against `midnight-node:0.22.5`, `compact` 0.30.0,
`midnight-js` 4.0.4 (the stack proven by
`experiments/contract-custody-feasibility/`); since revalidated in full
(unit, lifecycle, and end-to-end suites) on `midnight-node:1.0.0`,
`indexer-standalone:4.3.3`, `proof-server:8.1.0`, `compact` 0.31.0
(language 0.23, runtime 0.16.0), and `midnight-js` 4.1.1.

## C1 — Account-custody contract

**Topology: one Compact contract per account (alternative A).**
NEAR-style isolation. The ledger schema stays flat (no nesting by account),
deployment happens at onboarding (the demo app deploys on passkey creation),
and the ledger-schema-fixed-at-deploy constraint is per-user rather than
ecosystem-wide. Registry-based discovery is deferred to C2 (names).

**Authentication: hash-preimage witness (authentication alternative A).**
A device holds a 32-byte secret; the ledger stores
`transientHash(tag, secret)`; every gated circuit proves preimage knowledge
via the `require_device()` helper. This was a directed decision for the
prototype: JubJub Schnorr (alternative B, the C5 target) is deferred. The
auth check is one non-exported circuit, so the Schnorr verifier replaces a
single seam later. Known consequence (from the C1 canvas): sk-as-witness
does not compose with MPC or threshold custody; acceptable for a prototype,
must be revisited at C5 ratification.

**Replay defence.** Every authorised circuit bumps the `round` counter, so
every authorised call changes contract state and a captured transaction
cannot be re-applied. The proof itself binds the witness to the specific
circuit and arguments.

**`ownPublicKey()` is not used anywhere.** Caller identity is never read
from the wallet-supplied coin public key (see the C5 canvas on the
impersonation failure mode).

## C4 — Asset custody model

**Contract-custody for Night and shielded assets (alternative A).** Night
flows through `receiveUnshielded` / `sendUnshielded` (U1/U3-proven);
shielded coins use the OpenZeppelin `Map<colour, QualifiedShieldedCoinInfo>`
plus `insertCoin` pattern (S4/S6-proven), including the change path
(`sendShielded` returning change, re-registered via `sendImmediateShielded`
plus `insertCoin`).

**QSCI publicity accepted.** Contract-held shielded coin values and colours
are public ledger state. This is the documented C4 trade-off, accepted for
the prototype without mitigations.

**Night balance mirror.** The contract maintains
`night_balances: Map<colour, amount>` updated by its own deposit and
withdraw circuits. Contract Night balances are not otherwise part of
contract ledger state, so the mirror is what makes balances readable from
the indexer (app) and the simulator (unit tests). Blind spot: Night sent to
the contract address outside `deposit_night` is held but not mirrored.

**Dust: out of scope.** Fees are paid by the funding wallet (genesis-seeded
on the localnet, embedded in the demo app). C24 owns the fee model.

## C5 — Signing primitive

**Deferred.** No JubJub Schnorr in this iteration (directed decision). What
the prototype fixes regardless of scheme: the authorisation seam
(`require_device`), the replay rule (`round`), and the commitment
derivations through exported pure circuits so client and circuit can never
disagree. `experiments/redjubjub-wallet/` remains the verified Schnorr
implementation to slot in.

## C7 — Witness handling

**Witness functions over wallet private state.** The three witnesses
(`device_secret`, `grant_secret`, `recovery_secret`) read from the
midnight-js private state, stored as hex strings so any provider serialises
them safely. A witness throws when its secret is absent: a connection
holding only a grant secret structurally cannot produce device-authorised
proofs.

**In-process evaluation; local proving.** Witness evaluation happens
in-process; proofs go to the local proof server. Nothing in the pipeline
serialises a secret into a transaction.

**Zeroisation and `mlock`: not implemented.** JavaScript runtimes offer no
such guarantees. Recorded as a platform limitation for the C7 canvas, not
solved here.

## C8 — Domain separation

**transientHash (Poseidon) everywhere (directed decision);
persistentHash is not used.** Caveat accepted: transientHash output is not
guaranteed stable across Compact language versions, so ledger-stored
commitments would not survive a toolchain upgrade. A redeploy-and-migrate
would be needed; fine for a prototype, to be revisited when the C8 registry
ratifies hash usage.

**Ad-hoc v0 tags**, pending the registry:
`midnight:passport:device:v0`, `midnight:passport:grant:v0`,
`midnight:passport:recovery:v0`.

## C10 / C11 — Scoped grants

**Schema v0: operation × object × quantitative bound.** Operation is fixed
to "withdraw"; object scope is one token colour; the bound is a cumulative
value cap (`spent` accumulates across calls and is enforced in-circuit).
This is the minimal NEAR-function-call-key shape (C10 alternative A).

**No expiry in v0.** No in-circuit time assertion is used; revocation is
the only termination. Expiry joins the schema when the time-primitive
question is settled.

**Lifecycle (C11): issue and revoke.** Revocation tombstones the grant
(`active = false`) rather than deleting it; modification is
revoke-and-reissue, which keeps scope-widening explicit.

**Grants are epoch-scoped.** A grant records the device epoch at issue
time; recovery bumps the epoch and thereby invalidates every grant issued
before the loss event.

## C14 — Total-loss recovery

**BUSS (ANARKey, EPRINT 2025/551) replaces the plaintext-Shamir
placeholder.** The ledger stores the recovery commitment plus the BUSS
public vector φ (up to four 32-byte points), a session nonce, and nothing
else. Guardians store nothing: each derives its share on demand as
σ = H(session_id ‖ own_sk) from a key it already holds, and any t+1
guardians plus the on-chain φ reconstruct the recovery secret off-chain.
φ is provably simulatable, so no secret material sits in public state; the
previous TODO(PVSS) weakness is removed rather than patched. Recovery then
proves preimage knowledge exactly as before: the recover circuit lost its
share arguments and gained a φ-clearing step, and a device-authorised
publish_recovery_backup circuit was added. The BUSS mathematics runs in
the client through `buss-wasm` (a wasm-bindgen crate over the Pleiades
library, consumed as a git dependency; the `nodejs` build serves the tests
and CLI, the `bundler` build serves the demo app, and both bind the same
platform-neutral core in `src/wallet/buss-core.ts`); see
`research/anarkey-buss-recovery-assessment.md` for the full analysis.

**One wire format everywhere.** The copy/paste strings (`buss-req.v0.…`,
`buss-sig.v0.…`, `buss-paper.v0.…`) and the guardian-key derivation are
identical across the CLI demo and the app, so an app user can guard a CLI
account and vice versa. The app's guardian mode answers requests with a key
derived from the passkey device secret behind a biometric prompt.

**Mixed quorums unify social and cold recovery.** A guardian is anything
holding a field element: another passport (its guardian key is derived
from its own device secret; a real design would use a dedicated recovery
role of the key hierarchy so it survives device rotation), or a paper key
(a random field element written down). The lifecycle test and the CLI demo
use one passport guardian plus two paper keys with threshold two.

**Two client-side rules are load-bearing.** Every published backup MUST
use a fresh session nonce AND a fresh recovery secret: correlated φ
vectors across sessions degrade the threshold (with enough guardians a
passive observer recovers the secret from two correlated publications).
Guardian-set changes are therefore a full re-ceremony, which BUSS makes
cheap: one message per guardian, no guardian state. Removal is only
effective because the secret and commitment rotate with the re-publication;
the superseded φ then protects a worthless secret. The contract cannot
enforce either rule; they belong to the client and to the future
recovery-paths MIP.

**Known BUSS-specific gaps.** No identifiable abort (a lying guardian is
only detected by the commitment check failing; retry with a different
quorum). Recovery bootstrap metadata (guardian identities, indices, and
count) lives off-chain with the owner: the φ length is on-chain but the
guardian count is not, which is deliberate graph-privacy minimisation.
The session identifier and guardian-share hash tags are ad-hoc v0 tags
pending the C8 registry.

**Continuity (I-5.3) holds by construction.** Under contract-custody the
assets live in the account contract; recovery changes who may authorise,
not where assets sit. The recovery lifecycle test asserts this on-chain.

**Epoch trick instead of map iteration.** Compact ledger maps cannot be
cleared in-circuit; `device_epoch` makes device-set reset O(1) and leaves
stale entries inert.

## C9-facing — passkey derivation (demo app)

**WebAuthn PRF with a fixed, domain-separated salt
(`midnight:passport:prf:device:v0`).** Onboarding performs `create()` (with
the PRF extension requested) followed by one `get()` whose PRF output is
the 32-byte device secret. The secret is re-derived on every visit and
never persisted (the demo deliberately leaves C16 wallet-local-storage
unexercised). A dev-mode passphrase fallback (SHA-256) exists for
environments without PRF-capable authenticators.

## Known gaps and privacy notes

- **Device-commitment linkability.** Each authorised call discloses the
  calling device's commitment (it is the ledger-map key), linking calls by
  device. A Merkle membership proof would hide it; deferred (C12-adjacent).
- **Grant linkability.** Same shape: grant commitments are disclosed per
  spend, which is arguably desirable for auditability and revocation.
- **BUSS session discipline is client-enforced** (see C14: fresh session
  nonce and secret rotation per backup; the contract cannot check it).
- **transientHash version instability** (see C8).
- **Witness zeroisation** (see C7).
