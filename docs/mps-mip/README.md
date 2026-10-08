# MPS and MIP working drafts

This folder holds Midnight Problem Statements (MPS) and Midnight
Improvement Proposals (MIP) authored by this workspace, in the state they
are in before or after submission to the canonical repository,
[midnightntwrk/midnight-improvement-proposals](https://github.com/midnightntwrk/midnight-improvement-proposals).
Editor numbers are assigned upstream at merge; files here use `xxxx`
until then. Once a document is merged upstream, the upstream copy is
canonical and the copy here is retired to a pointer.

Last reconciled: **1 October 2026**. See [development status](../plans/STATUS.md).

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
  is prepared for Hector's review in Passport before an upstream PR.
  Scoped grants are a separate successor extension.
- `mps/mps-call-provenance.md` → upstream **MPS-0040**, Cross-Contract
  Call Provenance in Compact Circuits (Proposed). Compact 0.35 now exposes
  immediate caller identity; open Passport #176 validates a consumer.
- **MPS-0039**, Calling a Contract Requires Its Full Compiled Artifacts, is published
  upstream (Proposed); the regeneration proposal below addresses it.

The two MIP files here are retained as working mirrors while the
reference implementation (`contract/`) and the upstream texts evolve
together; the upstream copies are canonical.

## Submitted upstream, still open

- [#338](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/338):
  `mips/mip-xxxx-prover-key-regeneration.md`, submitted by Hector after
  Passport #173 merged. Authors: **Nicolas Di Prima and Vincent Hanquez**.
- [#339](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/339):
  `mips/mip-xxxx-account-recovery.md`, submitted by Hector after Passport
  #165 merged.

Both contain Draft-status documents. Neither is accepted/merged upstream;
retain the local working drafts while review continues.

## Working draft and evidence notes

- `mips/mip-xxxx-signature-schemes.md` — **ECDSA Authorisation for Custody
  Accounts (C5 signing primitive)**: a narrow MIP-0013 successor-extension
  working draft aligning wallet signing bytes with k1/r1 verification.
  Records current envelope and commitment recipes, permits named bounded
  WebAuthn profiles, and requires policy enforcement across every reachable
  verifier accepting a credential. `wa-json134` and one live Safari account
  operation provide bounded evidence. Remaining specification work covers
  exact recipe references, the common UV requirement and evidence mapping. Tracking:
  https://github.com/midnightntwrk/passport/issues/51.
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
- Caller-bound grants are implemented in open #176 using `kernel.caller()`
  on Compact 0.35, with a fabricated-caller proof refused at node admission.
  The extension uses schema v3 and needs reconciliation with P-256 #175;
  earlier grant evidence and the unshielded follow-up #163 are merged.
  Calling-circuit identity remains distinct from immediate caller identity.
- `mips/mip-xxxx-account-recovery.md` — **Recovery Paths for Custody
  Accounts (building block three)**: total-loss recovery behind the
  MIP-0013 seam, anchored on bottom-up secret sharing (ANARKey/BUSS).
  Guardians are authenticator credentials, cold signers, or paper
  keys that persist no per-account state; the account publishes one
  artefact set per session (public shares, a recovery public key, and
  a wrap of the viewing key), so recovery restores both control and
  visibility. Covers the guardian model and its three profiles, share
  derivation, the single session operation, the two-phase recovery
  gate with its pending record and veto window, the off-ledger
  transport and roster record, and the REC invariant family. The
  gate is a signature gate: the recovering party presents a Schnorr
  signature under the stored recovery key and the successor co-signs
  the same challenge, so neither secret enters the proof and the proof
  may be delegated (REC-11). Remaining tag: [CRYPTO-MEMO] the
  commissioned multi-session review (sent, response pending; the
  published scheme's model is single-session, so the freshness rules
  are our own normative addition). The contract tranche, in the
  signature-gate form, is implemented on the reference implementation
  (`contract/`) on both authorisation arms and evidenced in the
  runtime simulator (the full behaviour matrix) and on a local
  network (the lifecycle end to end).
- `mips/mip-xxxx-prover-key-regeneration.md` — **On-Demand Prover Keys
  from Bundled ZKIR**: a solution MIP under MPS-0039. Applications package
  small ZKIR assets and regenerate/cache prover keys using verifier keys
  read from the deployed contract, without requiring a registry. Defines
  a versioned recipe, compatible keygen profile, independent ZKIR/VK
  validation and upgrade handling. Native feasibility evidence is merged
  in `experiments/proving-key-regeneration/`; supported SDK/WASM APIs,
  conformance vectors and integration evidence remain to be delivered.
  This is the chosen direction instead of the additional MPS in PR #172.

## Process

Submissions follow the upstream MIP-0001 lifecycle: Draft status on
entry, editor-assigned numbers, and a separate submission issue. A MIP
addressing an MPS is listed in that MPS's header `MIP` field rather
than in the MIP's `Requires` line, which is reserved for MIP-on-MIP
dependencies. Upstream draft PRs use the literal filename
`mip-xxxx.md`; the descriptive filenames in this folder are local
conveniences and are renamed on submission.
