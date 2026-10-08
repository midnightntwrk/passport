# Midnight Passport — MIPs Pipeline

The Midnight Improvement Proposals (MIPs) that Midnight Passport
produces or adopts. Midnight's improvement-proposal process is live:
problem statements (MPS) and proposals (MIP) move through the
MIP-0001 lifecycle in the
[midnightntwrk/midnight-improvement-proposals](https://github.com/midnightntwrk/midnight-improvement-proposals)
repository, with editor-assigned numbers and weekly review sessions.
Passport works through that process: problems are framed as MPSs,
standards land as MIPs, and every normative claim is backed by
evidence in this workspace (an experiment, a reference
implementation, or a cryptographer review).

The MIPs are the central body of v1.0 deliverables. The October MVP
consumes them as they firm up — the account keystone is already
published upstream and implemented; the remaining MIPs continue toward
feature-complete v1.0.

Each MIP names an external co-author or committed external reviewer —
unilateral drafts become shelfware. The adoption narrative tracks who
that counterpart is for each MIP.

Last updated: 2026/10/08. See the [development-status reconciliation](STATUS.md)
for implementation, ticket and release evidence.

---

## Published upstream (Passport-authored; upstream copy is canonical)

| Upstream ID | Title | Status | Component |
|---|---|---|---|
| **MPS-0018** | Multi-key Account Custody for Midnight-Native Assets | Proposed | C1 · C4 |
| **MPS-0027** | Domain Separation for Midnight Hash Constructions | Proposed | C8 |
| **MIP-0012** | Contract Custody of Midnight-Native Assets | Proposed | C4 · C1 |
| **MIP-0013** | Multi-key Account Authorisation for Custody Contracts | Proposed | C1 · C5 |
| **[MIP-0020](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0020-prover-key-regeneration.md)** | On-Demand Prover Keys from Bundled ZKIR | Proposed | C6 |
| **[MIP-0022](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0022-account-recovery.md)** | Recovery Paths for Custody Accounts | Proposed | C13 · C14 · C15 |
| **MPS-0039** | Calling a Contract Requires Its Full Compiled Artifacts | Proposed | C6 |
| **MPS-0040** | Cross-Contract Call Provenance in Compact Circuits | Proposed | C1 · C12 |

MIP-0012 and MIP-0013 are the two building blocks of the multi-key
account keystone MPS-0018 recommends. Implementing them surfaced three
errata — the direct-transfer return signature, the unconditional DST
derivation, and the post-deploy bootstrap — all proposed and merged
upstream, so the published texts match what the reference
implementation (`contract/`) exercises. The direct
contract-to-contract validation also restated the payment-mode section
upstream: one-hop counterparty-private routing and linking-accepted
direct transfer are both normative.

Earlier implementation runs measured two gaps in MIP-0013 that the errata
did not cover, both live on the JubJub arm as published and reproduced
on the interim secp256k1 arm. First, the curve identity passes as a
device key: each arm's verification equation collapses at the identity,
so an identity "key" authorises with no secret at all. The reference
contract rejects it at the seam and the bootstrap (cofactor clearing on
JubJub, a non-default check on secp256k1); §4 does not yet require the
rejection. Second, removal retires one set element rather than a
device: a device that enrols a second entry for its own key survives
`remove_device`, and deriving the entry in-circuit does not prevent it
(erratum 8, demonstrated on node against both enrolment shapes). Only
the epoch bump is a complete revocation today. The remedy is a
contract-maintained device identity in §3, a state-schema change and so
a redeploy; the scoped-grants draft proposes carrying it in its
`spec_version = 2` redeploy. The ruling is pending upstream. Two
further facts bear on the pair: the account composes as a callee of
other contracts with the seam verifying through the call boundary, so
its circuit signatures and verifier keys are now a public ABI and the
gap fixes should land before dependents accumulate; and the seam is
carried as co-resident arms in the reference contract, which is the
shape the signature-schemes draft standardises.

**8 October qualification:** Compact 0.35 adds compiler/runtime checks;
the older weak-key observations above are not a current accepted-proof
admissibility map. That mapping and the normative correction remain open.
Caller-bound grants in merged #176 use schema v3; coordinate the outstanding
device-identity remedy with grants/recovery migration rather than assuming
the earlier proposed schema-v2 remedy has shipped.

**Path to Active for the keystone pair.** Cryptographer review of the
signature scheme (an explicit acceptance criterion), the FROST
ciphersuite specification with a t-of-n committee demonstration, a
second independent implementation, ecosystem review in the upstream
discussion venues, and the two gap remedies above.

## Adopted upstream (not Passport-authored)

### Key derivation & address format — MIP-0003 (Accepted)

The HD derivation tree (`m / 44' / 2400' / account' / role / index`,
the role table, and coin type **2400**) and the `mn_addr` Bech32m
address format are specified in Midnight's WalletEngine Specification,
extended by **MIP-0003 (ECDSA support)**, now Accepted upstream.
Passport **adopts** these rather than drafting parallel standards; the
ARC review that strengthened MIP-0003 concluded when the proposal was
accepted. The one derivation concern *not* covered upstream — deriving
the device key from a WebAuthn passkey (PRF → JubJub scalar) — lives
in [C9](components/C9-device-bound-authentication.md) and is a
candidate MIP of its own (below).

### Name service — MIP-0007 (Proposed; adopted, with our amendment merged)

Passport adopts the deployed upstream name service (MIP-0007,
addressing the Accepted MPS-0012 on human-readable aliasing) rather
than authoring a parallel standard. The fit assessment's number-one
condition is satisfied: MIP-0007 now carries normative
**forward-looking authorisation arms** — contract-owned names via
cross-contract authorisation (the arm a multi-key account contract
needs) and ECDSA owners, both availability-gated. The contract-owned
arm's mechanism is no longer hypothetical:
`experiments/cross-contract-calls` validated seam-gated account
circuits driven through the call boundary and atomic value transfer
across it on the ledger-9 toolchain (2026/09/03); the remaining gate
is a public network on that ledger. What remains
Passport-side is the `passport.night` sub-domain layer: issuance
mechanics, squat resistance, and Foundation policy. See
[C2](components/C2-name-service.md).

### Chain identifiers — MIP-0008 (Draft)

CAIP-2 network identifiers of the `midnight:mainnet` style. Passport
surfaces that need a chain identifier follow it.

---

## Newly published upstream — follow-through

### MIP-0020 — On-demand prover keys from bundled ZKIR (Proposed)

Native regeneration evidence [#170](https://github.com/midnightntwrk/passport/pull/170)
and solution draft [#173](https://github.com/midnightntwrk/passport/pull/173)
are merged in Passport. Hector's submission under MPS-0039,
[upstream #338](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/338),
merged on 4 October as **MIP-0020, Proposed**. MPS-0039's header now links it.
It retains **Nicolas Di Prima and Vincent Hanquez** as authors. Package
small ZKIR assets and regenerate/cache prover keys using on-chain verifier
keys, without requiring a registry. Supported SDK/WASM APIs, compatible
keygen profiles, validation vectors and integration remain. Publication is
not completion of the Path to Active. Discussion:
https://github.com/midnightntwrk/midnight-improvement-proposals/discussions/345.

### MIP-0022 — Recovery paths (Proposed; building block three)

**Scope.** Total-loss recovery behind the account standard's recovery
seam, whose interface MIP-0013 fixes (epoch bump, single fresh
device). Mechanism decided: BUSS / ANARKey stateless guardians plus
paper keys (ePrint 2025/551), implemented in the account-custody
prototype (shared guardian wire formats across CLI and app). The MIP
specifies the construction, the guardian protocol and wire formats,
the paper-key format, and parameters, with DeRec and encrypted-blob
backup as substitutable profiles behind the same seam. Draft and reference
tranche [#165](https://github.com/midnightntwrk/passport/pull/165) are merged;
Hector submitted [upstream #339](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/339),
merged on 4 October as **MIP-0022, Proposed**, authored by Nicolas Di Prima
and Raphael Toledo. MPS-0018's header now includes it. The reference gate consumes
recovery/successor signatures, not reconstructed secrets, in a two-phase
flow with a veto window. Multi-session crypto review, wallet transport,
interoperability and viewing-wrap lifecycle remain. Discussion:
https://github.com/midnightntwrk/midnight-improvement-proposals/discussions/349.

**Maps to components.** [C14](components/C14-total-loss-recovery-flow.md) ·
[C15](components/C15-helper-protocol.md) ·
[C13](components/C13-lost-device-flow.md).

## Local drafts awaiting upstream submission

### MIP-0013 signing-boundary extension (C5)

**8 October update.** The [local extension](../mps-mip/mips/mip-xxxx-signature-schemes.md)
is a concise account of ECDSA signing bytes and verification requirements:
k1 envelope hashes and v2 device commitments, r1 WebAuthn policy binding,
named bounded profiles, and device versus grant replay state. It preserves
existing hash encodings and uses the implementation and evidence already available.

The reference `wa-json134` profile and its live Safari account-key rotation
are evidenced by merged https://github.com/midnightntwrk/passport/pull/175.
The draft distinguishes those results from general browser interoperability
and the negative variable-length experiment. Remaining specification choices
and evidence gaps are listed in the extension.

**Review route:** Hector approved https://github.com/midnightntwrk/passport/pull/180
on 8 October; local merge and the upstream PR remain. This task ends with the
specification update. No universal profile or k1 sunset is adopted. The separate
https://github.com/midnightntwrk/passport/pull/179 experiment saves zero proof/VK
bytes and substantially worsens proving cost; it is not an account replacement.

**Maps to components.** [C5](components/C5-signing-primitive.md) ·
[C9](components/C9-device-bound-authentication.md).

### Scoped grants and dApp connection (successor extension)

**Scope.** Drafted, co-authored with the Midnight Foundation. The
extension MIP-0013 reserves behind `require_authorised()`: a grant is a
contract-maintained record admitting one grantee key of a registered
scheme to a bounded subset of the asset-facing circuits (three spend
operations, one token color, a per-call and a cumulative cap, a bound
on any coin touched, an optional recipient pin, and an explicit
expiry), enforced in-circuit on every call through per-arm grant twins
over the unchanged custody chips, revocable instantly from chain state
by any active device, with an O(1) revoke-all. Color, recipient, coin
bound, relying-party host, and the running spent total are salted
commitments, so the MIP-0012 custody invariants hold and observers
learn neither which dApps an account uses nor what it spends. The
connection ceremony is a redirect to an authoriser carrying a
`GrantRequest` and a detached possession proof signed as transmitted,
the proof being a WebAuthn assertion made on the dApp origin so the
consent screen names a browser-attested origin, passkey consent, one
device-gated `issue_grant`, and a return leg the dApp verifies against
chain state. Read access is the MIP-0012 viewing capability sealed to
a dApp key; the text says plainly that the ledger enforces spend scope
and not read scope. Requires a `spec_version = 2` redeploy, proposed to
carry the erratum 8 remedy as well. Evidence on `main`: the reference
contract carries grant twins on both grantee arms; the earlier evidence
at `spec_version = 2` records eleven of twelve groups passing,
twelve rejection rows abort at build time with the named message, and
the unit of `kernel.blockTimeLessThan` is measured as whole seconds
enforced at client build and node admission (`contract/GRANTS-E1.md`
to `GRANTS-E3.md`). Outstanding: editors' rulings collected at the head
of the draft, and the companion erratum to MIP-0013 AUTH-1, AUTH-2, and
AUTH-9. Local copy: `docs/mps-mip/mips/mip-xxxx-scoped-grants.md`.

The unshielded evidence follow-up #163 is merged. Merged
[#176](https://github.com/midnightntwrk/passport/pull/176) adds optional
immediate-contract pins through `kernel.caller()`, with accepted forwarding
calls and a fabricated-caller proof refused at node admission. It uses
schema v3 and includes the P-256 issuance caller-argument fix. Combined-build,
client-ABI and P-256 caller validation remain separate from the earlier
caller evidence. The device-wide revocation remedy is still unfinished work.

**Maps to components.** [C10](components/C10-scoped-grant-primitive.md) ·
[C11](components/C11-grant-lifecycle.md) ·
[C12](components/C12-chain-side-enforcement.md) ·
[C23](components/C23-dapp-connection-protocol.md) (issuance half).

## Related upstream proposals — compatibility review

### MIP-0021 — Domain-Separation Convention (Proposed)

Jay Albert's [MIP-0021](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0021-domain-separation.md)
merged through #331 on 4 October under MPS-0027. It specifies a convention
and rejects a central tag registry, unlike Passport's earlier ADR-0001
direction. Passport's mandatory fixed-width zero-padding, canonical encoding,
tag/data boundary and existing-tag compatibility feedback remains open in
https://github.com/midnightntwrk/midnight-improvement-proposals/discussions/347.
Existing cryptographic bytes must not be silently migrated. C8 remains open;
publication has not settled those questions or the lightweight catalogue proposal.

**Maps to component.** [C8](components/C8-domain-separation-registry.md).

### MIP-0025 — Managed Private State and Capsule Runtime (Draft)

[MIP-0025](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0025-capsule-runtime.md)
is published through #334 with **Draft** status. Track its proposed private-state
boundary in C16 and the SDK review; it is not a shipped storage or backup service.
Discussion: https://github.com/midnightntwrk/midnight-improvement-proposals/discussions/355.
Custom spend logic remains open as
https://github.com/midnightntwrk/midnight-improvement-proposals/pull/335;
**MIP-0028 is reserved, not published**.

## Further local proposal outlines

### dApp ↔ Wallet Connection Protocol

**Scope.** The connection surface third-party dApps build against —
Open Wallet Standard is the chosen direction, with CAIP-25, EIP-6963,
and WalletConnect v2 as underlying transport and discovery layers, and
privacy scopes plus an asynchronous proof lifecycle on top. The
grant-issuance ceremony is now specified in the scoped-grants draft
above; what this proposal still owns is the OWS handshake flag, the
scope mapping table, and the discovery and transport layering. A
related finding: every Midnight wallet key already signs an account
challenge (BIP-340) on every shipped surface, so a plain wallet can
operate a Passport account once the seam grows that arm.

**Maps to component.** [C23](components/C23-dapp-connection-protocol.md).

### DecentralisedAuth (sign-in)

**Scope.** Privacy-preserving dApp sign-in — the "sign-in-with-Passport"
primitive that does not leak the user's address or identity to the dApp
by default. Sister protocol to the connection MIP: connection covers
capability grants, this covers authentication.

**Maps to component.** [C23](components/C23-dapp-connection-protocol.md).

### Privacy-preserving credentials

**Scope.** Attestation-tree domain separators, nullifier construction,
and multi-issuer support for privacy-preserving verifiable
credentials.

**Maps to component.** [C20](components/C20-selective-disclosure-proof.md)
(with C18 · C19 · C21).

### Candidate MIPs

- **Passkey-derived device keys** — the PRF → JubJub scalar
  derivation, domain-separated under the registry; graduates from C9
  if it needs to become a standard for cross-wallet portability.
- **Viewing-key sharing** — draft [#177](https://github.com/midnightntwrk/passport/pull/177)
  demonstrates 192-byte inbox reader envelopes and fresh-client restoration
  with software credentials and synthetic PRF. Protocol, bootstrap, roster
  trust and recovery decisions remain before proposing a standard.

**Dependencies now available:** Compact 0.35 exposes P-256 verification and
immediate caller identity. Call provenance is already published as
MPS-0040; #176 covers immediate-contract pins, not calling-circuit identity
or all broader provenance requirements. BIP-340 still needs secp256k1
point operations.

---

## Process notes

- Problems are filed as MPSs, standards as MIPs, per the upstream
  MIP-0001 lifecycle: Draft status on entry, editor-assigned numbers,
  and the MPS header's Proposed Solutions field linking the MIPs that
  address it.
- Local working copies live in [`docs/mps-mip/`](../mps-mip/); once a
  document merges upstream, the upstream copy is canonical.
- Each MIP names its external co-author or committed reviewer at
  draft time. If none can be named, the MIP is not yet ready to
  start.
- Earlier internal pipeline labels map to the upstream register as
  follows: MIP-3A → MIP-0012, MIP-3B → MIP-0013, MIP-KEYGEN → MIP-0020,
  STD-03 → MIP-0021 compatibility work (MPS-0027 lineage), MIP-4 → MIP-0022
  recovery paths, MIP-5 / MIP-7 → connection and sign-in, MIP-6 → credentials,
  MIP-8 / STD-06 → superseded by the MIP-0007 adoption, MIP-9 →
  signature schemes, MIP-10 → scoped grants and dApp connection.
