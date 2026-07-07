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

## In draft

MPS-0018 recommends a multi-key account contract MIP as "the keystone
the others hang from". We author that keystone as small building blocks,
each independently reviewable, each usable without the others:

1. **Asset custody** (`mips/mip-xxxx-native-asset-custody.md`): how a
   contract holds and releases unshielded values (Night and any other
   unshielded color) and shielded values; authorisation abstracted to a
   single seam; validated by the stateless-custody and account-custody
   experiments.
2. **Account and authorisation** (not yet drafted): credential schemes,
   device lifecycle, revocation epochs, and scoped grants; instantiates
   the seam.
3. **Recovery paths** (not yet drafted): total-loss recovery behind the
   seam; the prototype realises this with BUSS, and the standard stays
   scheme-agnostic at the contract surface.

## Process

Submissions follow the upstream MIP-0001 lifecycle: Draft status on
entry, editor-assigned numbers, and a separate submission issue. A MIP
addressing an MPS is listed in that MPS header's Proposed Solutions
field rather than in the MIP's `Requires` line, which is reserved for
MIP-on-MIP dependencies. Upstream draft PRs use the literal filename
`mip-xxxx.md`; the descriptive filenames in this folder are local
conveniences and are renamed on submission.
