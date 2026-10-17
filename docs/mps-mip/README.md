# MPS and MIP working drafts

This folder holds Midnight Problem Statements (MPS) and Midnight
Improvement Proposals (MIP) authored by this workspace, in the state they
are in before or after submission to the canonical repository,
[midnightntwrk/midnight-improvement-proposals](https://github.com/midnightntwrk/midnight-improvement-proposals).
Editor numbers are assigned upstream at merge; files here use `xxxx`
until then. Once a document is merged upstream, the upstream copy is
canonical and the copy here is retired to a pointer.

Last reconciled: **17 October 2026**. See [development status](../plans/STATUS.md).

## Published upstream (upstream copy is canonical)

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
  merged upstream. The local [ECDSA signing-boundary extension](mips/mip-xxxx-signature-schemes.md)
  is published as MIP-0030 (Draft). Recovery retirement is amended by upstream #385.
  Scoped grants are a separate successor extension.
- `mps/mps-call-provenance.md` → upstream **MPS-0040**, Cross-Contract
  Call Provenance in Compact Circuits (Proposed). Compact 0.35 now exposes
  immediate caller identity; merged Passport #176 validates a consumer.
- **MPS-0039**, Calling a Contract Requires Its Full Compiled Artifacts, is published
  upstream (Proposed); the regeneration proposal below addresses it.

- `mips/mip-xxxx-signature-schemes.md` → [**MIP-0030**](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0030-ecdsa-account-authorisation.md),
  ECDSA Authorisation for Custody Accounts (**Draft**), merged via #374.
  Complete recipes, policy/enforcement mapping, cryptographic review and
  MIP-0021 compatibility remain; no k1 sunset policy is adopted.
- `mips/mip-xxxx-account-recovery.md` → [**MIP-0022**](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0022-account-recovery.md),
  Recovery Paths for Custody Accounts (**Proposed**), merged via #339.
  Authors: Nicolas Di Prima and Raphael Toledo. Upstream #385 now requires
  atomic retirement of all prior entries at finalisation, including pending
  enrolments. Passport #183 implements the reset; compilation/simulation
  evidence does not complete proof/node or deployment validation.
- `mips/mip-xxxx-prover-key-regeneration.md` → [**MIP-0020**](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0020-prover-key-regeneration.md),
  On-Demand Prover Keys from Bundled ZKIR (**Proposed**), merged via #338.
  Authors: Nicolas Di Prima and Vincent Hanquez. Supported APIs, conformance
  and integration remain.

The authorisation, ECDSA, recovery and regeneration paths above are retired
to canonical pointers. The older custody mirror is non-canonical.

## Working draft and evidence notes

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
  are collected in an editors' note at the head of the file. Co-authored
  with the Midnight Foundation. Evidence is on `main`: the reference
  contract at `spec_version = 2` (`contract/GRANTS-E1.md` to
  `GRANTS-E3.md`) carries the roster on both grantee arms and the seam
  is exercised on node.
- Caller-bound grants are implemented in merged #176 using `kernel.caller()`
  on Compact 0.35, with a fabricated-caller proof refused at node admission.
  The extension uses schema v3 and retains a separate combined-build/client-ABI/P-256 caller validation obligation;
  earlier grant evidence and the unshielded follow-up #163 are merged.
  Calling-circuit identity remains distinct from immediate caller identity.
## Process

Submissions follow the upstream MIP-0001 lifecycle: Draft status on
entry, editor-assigned numbers, and a separate submission issue. A MIP
addressing an MPS is listed in that MPS's header `MIP` field rather
than in the MIP's `Requires` line, which is reserved for MIP-on-MIP
dependencies. Upstream draft PRs use the literal filename
`mip-xxxx.md`; the descriptive filenames in this folder are local
conveniences and are renamed on submission.
