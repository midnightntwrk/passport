# Midnight Passport — Standards register

This is the single local register of standards Passport authors, adopts, or
depends on. Upstream owns normative text and lifecycle; [arc42](../arc42.md)
owns the architectural overview. [Local file roles](../mps-mip/README.md)
distinguish pointers, historical copies, and working drafts.

**Verified 2026/11/06:** canonical headers were read from a fresh checkout of
[midnight-improvement-proposals at `02fce36`](https://github.com/midnightntwrk/midnight-improvement-proposals/tree/02fce36cfa44541305310dc25fd38f399dbe8d92).
The links below follow upstream `main`; the pinned revision records this
observation. Passport implementation statements refer to fetched `origin/main`
[`fc19e47`](https://github.com/midnightntwrk/passport/tree/fc19e471536febb2133f20e817847251622dcdf5).
Publication, acceptance, implementation, and deployment are distinct.

## Published standards and problem statements

| Canonical document | Status at reviewed revision | Passport role |
|---|---|---|
| [MPS-0018 — Multi-key Account Custody](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mps/mps-0018-asset-custody-model.md) | Proposed | C1, C4, C14; custody problem addressed by MIP-0012/0013/0022. |
| [MPS-0027 — Domain Separation](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mps/mps-0027-domain-separation.md) | Proposed | C8; problem statement for MIP-0021. |
| [MPS-0039 — Calling a Contract Requires Its Full Compiled Artifacts](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mps/mps-0039-lightweight-contract-interaction.md) | Proposed | C6; heavy artefact distribution, including the prover-key problem addressed by MIP-0020. |
| [MPS-0040 — Cross-Contract Call Provenance](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mps/mps-0040-cross-contract-call-provenance.md) | Proposed | C1, C2, C12; callee-side authority and immediate caller identity. |
| [MIP-0012 — Contract Custody of Midnight-Native Assets](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0012-native-asset-custody.md) | Proposed | C4, C1; custody and abstract authorisation seam. |
| [MIP-0013 — Multi-key Account Authorisation](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0013-account-authorisation.md) | Proposed | C1, C5; bootstrap, device authority and lifecycle, mandatory recovery gate. |
| [MIP-0020 — On-Demand Prover Keys from Bundled ZKIR](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0020-prover-key-regeneration.md) | Proposed | C6; deterministic regeneration and toolchain compatibility. |
| [MIP-0021 — Domain-Separation Convention](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0021-domain-separation.md) | Proposed | C8; decentralised convention, explicitly not a central registry. |
| [MIP-0022 — Recovery Paths for Custody Accounts](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0022-account-recovery.md) | Proposed | C13, C14, C15; recovery authorisation, control and viewing capability. |
| [MIP-0030 — ECDSA Authorisation for Custody Accounts](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0030-ecdsa-account-authorisation.md) | Draft | C5, C9; k1 signing envelopes and r1 bounded WebAuthn verification. Replaces the former local general scheme-registry draft; no k1 sunset policy. |

## Adopted standards and adjacent dependencies

| Canonical document | Status at reviewed revision | Boundary |
|---|---|---|
| [MIP-0003 — ECDSA signature support](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0003-ecdsa-support.md) | Accepted | Ledger-level secp256k1 support, distinct from in-circuit authorisation and wallet derivation. |
| [MIP-0007 — Name Service Registry and Resolver](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0007-name-service-registry-and-resolver.md) | Proposed | Passport adopts this naming direction; `passport.night` issuance and contract-owned-name integration remain dependencies. |
| [MIP-0008 — CAIP-2 Network Identifiers](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0008-caip-2-network-identifiers.md) | Draft | Network identifier framing; examples are not a ratified registry. |
| [MIP-0025 — Capsule Runtime](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0025-capsule-runtime.md) | Draft | Adjacent managed-state/client architecture proposal; not an implemented Passport runtime or an adoption decision. |

## Implementation and conformance boundary

The [reference contract](../../contract/README.md) at the reviewed Passport
revision has **schema v3, 52 non-pure circuits, and JubJub, k256 and p256 arms**.
It includes signature-gated two-phase recovery and caller-bound grants.
P-256 uses the bounded `wa-json134` profile; Compact 0.35 already supplies
native P-256. Browser coverage, general WebAuthn interoperability and a
complete product remain separate claims.

- **Bootstrap:** the boot commitment plus post-deploy activation addresses
  authorisation erratum 2. Upstream #250 incorporated that design into
  MIP-0013 §3; it is no longer an outstanding deviation at the reviewed
  standards revision.
- **Recovery:** the old branch's absent entry point was a gap against
  MIP-0013 §8's MUST. Main implements the entry points and #183's atomic
  device-set reset. [23 October evidence](../../contract/GRANTS-COMPLETION.md)
  covers two on-node recoveries with source matching this baseline. Matching
  cached keys were used after textual ZKIR comparison; this is not clean
  key regeneration or the expanded adversarial retirement matrix. Erratum 7
  and I-5.4 require retirement even for pre-planted future-epoch entries or
  entries added while recovery is pending.
- **Individual removal:** erratum 8 remains open. A device can have enrolled
  more than one entry; removing an entry is not identity-wide revocation.
  The device-identity remedy belongs to MIP-0013's design/review work, not a
  delivered scoped-grants feature. Neither the v2 grant schema nor v3
  caller binding implements that remedy. Removing a device also leaves its
  grants valid; the grant draft §7.3 requires the client to call
  `revoke_all_grants` in the same transaction or immediately afterwards when
  compromise is suspected.
- **Scheme naming:** code `k256` maps to MIP-0030 `k1`, and `p256` to `r1`.
  Canonical boot/device tags are `k1:v2` / `r1:v2`; operation tags use v1.
  The former local v1 boot/device registry is superseded, not an alternative
  interoperable encoding.
- **Domain separation:** MIP-0021 is verified Proposed. Its `midnight:`
  convention, version syntax and no-trailing-zero rule require explicit
  compatibility work for existing Passport domain bytes. The old central
  registry design in C8 is not adopted upstream. See
  [ADR-0001](../adrs/0001-domain-separation-registry.md); do not silently
  change cryptographic constants to make prose appear conformant.
- **Provenance:** the current account reads immediate caller identity through
  the Compact kernel. A successful call does not establish the calling
  circuit, and a caller contract can lend its identity through permissive
  entry points. Naming integration still needs its own validation.

The [contract README](../../contract/README.md) owns detailed limitations;
publication and a passing reference test do not establish full conformance,
cryptographic review, or safety of an existing deployment.

## Local drafts and evidence

### Scoped grants and dApp connection

The [grant draft](../mps-mip/mips/mip-xxxx-scoped-grants.md) covers C10–C12 and
C23: bounded spend authority, lifecycle, redirect consent, sign-in and viewing
capability hand-off. Read scope is not ledger-enforced. Request proofs sign
transmitted bytes, without JSON canonicalisation. Sections 11.1 and 11.2
already define CAIP-25 `scopedProperties` and Open Wallet Standard policy
mapping; these are not undrafted scopes. Transport/discovery integration,
interoperability and acceptance remain work. Passport review completed in
#195; this review did not re-audit unmerged upstream submissions.

[E1](../../contract/GRANTS-E1.md), [E2/E4](../../contract/GRANTS-E2.md),
[E3](../../contract/GRANTS-E3.md), and the
[combined-account record](../../contract/GRANTS-COMPLETION.md) retain their
run-specific coverage. The E4 addendum records funded unshielded grant spends
on node for JubJub/k256; the 23 October run adds P-256 unshielded grants.
Successful P-256 forwarded/shielded grant spends are outside that combined run.
The E2 missing pre-grants deployment control remains a limitation of that
specific evidence group; later runs must not silently erase it.

### Circuit artefact identity, provenance, and reproducibility

The broader [circuit-artefact MPS draft (PR #172)](https://github.com/midnightntwrk/passport/pull/172)
is reviewed separately. This documentation change links to that review and
does not include or absorb the draft. Its unnumbered Proposed header does not
establish upstream submission.
MPS-0039 and MIP-0020 cover the published footprint/regeneration work; producer
identity and broader provenance questions remain distinct. The
[proving-key experiment](../../experiments/proving-key-regeneration/README.md)
is present on main. Its historical 30-circuit measurements are not measurements
of today's 52-circuit account.

## Remaining proposal and review scopes

- Connection transport/discovery and privacy-preserving sign-in integration
  (C23), extending the grant draft's existing carriage/mapping work.
- Credentials (C18–C21): attestation trees, selective disclosure and nullifiers.
- PRF-to-device-key portability (C9), separate from direct P-256 WebAuthn.
- MIP-0030 typed recipes/vectors, UV policy across accepting verifiers,
  key/scalar enforcement mapping and cryptographic review.
- Recovery multi-session cryptography, guardian transport/liveness,
  interoperability and viewing-wrap freshness/rotation.
- Supported SDK/WASM key-regeneration APIs, compatible profiles and vectors.

Recovery, domain separation, ECDSA authorisation, provenance and on-demand
prover keys are no longer unclaimed publication slots. Acceptance and
integration gates remain even after a proposal receives a number.

## Process and maintenance

Follow [MIP-0001](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0001-mip-process.md)
and the upstream templates. Keep lifecycle observations here with a date and
pinned source. Historical snapshots retain their body and section anchors;
canonical pointers should point directly upstream. New normative changes
belong upstream, with local differences recorded in arc42 and the contract
reference. Local `xxxx` filenames do not assign numbers.

Earlier internal labels map as follows: MIP-3A → MIP-0012; MIP-3B → MIP-0013;
MIP-4 → MIP-0022; STD-03 → MPS-0027 / MIP-0021; MIP-8 / STD-06 → MIP-0007
adoption; MIP-9 → MIP-0030. MIP-5, MIP-6, MIP-7 and MIP-10 are old internal
connection, credentials, sign-in and grants labels, not those upstream numbers.
