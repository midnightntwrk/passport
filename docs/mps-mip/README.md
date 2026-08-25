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
  registry MIP-0013's Versioning section anticipates, plus the first
  successor scheme (v2: WebAuthn ECDSA over secp256r1, verified with
  the signing envelope in a dedicated per-scheme circuit). The interim
  secp256k1 arm is documented with its migration path. Open items are
  tagged in the file: circuit design, cryptographic review of the
  envelope binding and normalisation, and two editorial rulings.
  Tracked by passport issue #51.
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
