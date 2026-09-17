# C10 · Scoped grant primitive

**Serves:** P7 · P10.

## Outcome

The authorisation primitive — operation type × object × quantitative
bounds. Used for both intra-user (device-to-device) and dApp grants. Per
P7.

The substrate is fixed: MIP-0013 deliberately leaves scoped grants out
of the account-authorisation building block and reserves them as a
successor extension behind the same authorisation seam — a grant is a
new way to satisfy `require_authorised()`, not a parallel mechanism.
What this canvas owns is the grant schema and semantics that extension
will carry.

**Status 2026/09 — specified.** The scoped-grants and dApp-connection
MIP is drafted (`docs/mps-mip/mips/mip-xxxx-scoped-grants.md`),
co-authored with the Midnight Foundation. A grant is a
contract-maintained record admitting one grantee key of a registered
signature scheme (C5) to a bounded subset of the asset-facing
circuits: three spend operations, one token color, a per-call and a
cumulative cap, a bound on the value of any coin touched, an optional
recipient pin, and an explicit expiry. The record is keyed by a
contract-recomputable identity over the account, the grantee key, its
origin, and a slot; color, recipient, coin bound, relying-party host,
and the running spent total are salted commitments opened in-circuit,
so the MIP-0012 custody invariants hold unchanged and observers learn
neither which dApps an account uses nor what it spends. Implemented on
the reference contract at `spec_version = 2` and exercised on node
(`contract/GRANTS-E1.md`, `GRANTS-E2.md`); the byte recipes agree
three ways (TypeScript, Rust, and the circuit). Outstanding: editors'
rulings collected at the head of the draft, and the companion
MIP-0013 erratum.

## Dependencies

- **C1** — grants live in account-custody contract state.
- **C11** — issue / modify / revoke / expire operate on grants.
- **C12** — verifier circuits enforce grant scope.
- **C23** — dApp connection requests grants.
- **C25** — cross-chain grants flow through this boundary if P10's
  chain-agnostic grants are adopted.

## Open questions

**Grant scope schema.** Resolved by the MIP: a Passport-specific
schema (operations, one color, caps, coin bound, recipient pin,
expiry), NEAR-shaped in spirit. Window-bounded rate limits have their
schema reserved and their semantics deferred to a circuit revision.

**Compose with chain abstraction.** Chain-scoped by construction in
this MIP; chain-agnostic grants (P10's I-10.3) wait on the cross-chain
interface (C25).

**Composition with selective disclosure.** When a dApp grant requires a
credential proof (P9), is the proof attached to the grant or supplied
per-request?

## Failure modes

**Schema unsuitable for ecosystem.** Third-party dApps cannot express
their needs. *Detection:* dApp integration partners request schema
extensions.

**Implicit scope widening.** A grant modification operation silently
broadens scope without re-authorisation. *Detection:* code review or
scope-narrowing assertion test.

**Scope under-enforcement.** Verifier accepts an operation outside the
granted scope. *Detection:* differential test on out-of-scope
operations.

## Alternatives

**A — NEAR function-call key model.** **Chosen as the shape:** a
contract-maintained record with a Passport-specific scope schema. The
NEAR access-key login flow is the closest deployed analogue of the
connection ceremony, and the MIP closes its known defects one by one.

**B — Capability-token model.** Not adopted: a signed capability
cannot be revoked from chain state, which I-7.6 requires; the record
model gives that for free.

**C — ZK-attested grants.** Partially adopted: the record is on chain,
but its scope fields are salted commitments opened in-circuit, so an
observer learns neither the dApp nor the spend.
