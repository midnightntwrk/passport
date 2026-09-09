# MPS and MIP working drafts

This folder holds Midnight Problem Statements (MPS) and Midnight
Improvement Proposals (MIP) authored by this workspace, in the state they
are in before or after submission to the canonical repository,
[midnightntwrk/midnight-improvement-proposals](https://github.com/midnightntwrk/midnight-improvement-proposals).
Editor numbers are assigned upstream at merge; files here use `xxxx`
until then. Once a document is merged upstream, the upstream copy is
canonical and the copy here is retired to a pointer.

## Submitted (upstream copy is canonical)

- `mps/mps-asset-custody-model.md` → upstream **MPS-0018**,
  Multi-key Account Custody for Midnight-Native Assets.
- `mps/mps-domain-separation.md` → upstream **MPS-0027**,
  Domain Separation for Midnight Hash Constructions.
- `mips/mip-xxxx-native-asset-custody.md` → upstream **MIP-0012**,
  Contract Custody of Midnight-Native Assets (Proposed). Building
  block one of the MPS-0018 keystone: how a contract holds and
  releases unshielded values (Night and any other unshielded color)
  and shielded values; authorisation abstracted to a single seam. The
  return-signature erratum and the two-payment-mode restatement are
  merged upstream.
- `mips/mip-xxxx-account-authorisation.md` → upstream **MIP-0013**,
  Multi-key Account Authorisation for Custody Contracts (Proposed).
  Building block two: rolling single-use device entries, lifecycle,
  and revocation epochs, with the seam instantiated by in-circuit
  Schnorr verification over JubJub (FROST-compatible, separating
  approval from proving). The DST-derivation and bootstrap errata are
  merged upstream. Scoped grants are deferred to a successor
  extension.

The two MIP files here are retained as working mirrors while the
reference implementation (`contract/`) and the upstream texts evolve
together; the upstream copies are canonical.

## In draft

- `mips/mip-xxxx-signature-schemes.md` — **Signature Schemes for
  Custody-Account Authorisation (C5 signing primitive)**: the scheme
  registry MIP-0013's Versioning section anticipates (schemes as
  arm-marked DST tag families: v1 JubJub Schnorr, k1 interim, r1
  WebAuthn ECDSA over secp256r1), the per-scheme dedicated-circuit
  pattern with the scheme-generic challenge core and its ECDSA
  deltas, the r1 envelope binding, and the SIG invariant family.
  Filled from the evidence base (the P-256 in-circuit experiment and
  the k1 arm). Remaining tags: [DEP] Compact r1 surface, [CIRCUIT]
  length-agnostic client-data hashing, [CRYPTO] envelope-binding and
  malleability-inertness review, [RULING] the k1 Interim-status
  registration. Tracked by passport issue #51 and PR #146.
- `mips/mip-xxxx-scoped-grants.md` — **Scoped Grants and dApp Connection
  for Custody Accounts (C10, C11, C12, C23)**: the successor extension
  MIP-0013 reserves behind `require_authorised()`. A grant is a
  contract-maintained record admitting one grantee key of a registered
  scheme to a bounded subset of the asset-facing circuits (operations,
  one color, per-call and cumulative caps, recipient pin, expiry),
  enforced in-circuit and revocable from chain state; the connection
  ceremony is a redirect to an authoriser carrying a canonical
  `GrantRequest`, passkey consent, one device-gated `issue_grant`, and a
  return leg the dApp verifies against chain state. Read access is the
  MIP-0012 viewing capability sealed to a dApp key and recorded
  declaratively. Requires a `spec_version = 2` redeploy. Reviewed
  through four lenses; the open items for editors and the Foundation
  (co-author, companion erratum wording, salt and commitment rulings)
  are collected in an editors' note at the head of the file, and the
  external co-author is not yet named.
- **Recovery paths (building block three; not yet drafted)**:
  total-loss recovery behind the seam; the prototype realises this
  with BUSS, and the standard stays scheme-agnostic at the contract
  surface. The upstream recovery slot remains unclaimed.

## Process

Submissions follow the upstream MIP-0001 lifecycle: Draft status on
entry, editor-assigned numbers, and a separate submission issue. A MIP
addressing an MPS is listed in that MPS header's Proposed Solutions
field rather than in the MIP's `Requires` line, which is reserved for
MIP-on-MIP dependencies. Upstream draft PRs use the literal filename
`mip-xxxx.md`; the descriptive filenames in this folder are local
conveniences and are renamed on submission.
