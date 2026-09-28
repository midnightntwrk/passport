---
MPS: xxxx
Title: Identity, Provenance, and Reproducibility of Compact Circuit Artefacts
Authors: Nicolas Di Prima (NicolasDP)
Status: Proposed
Category: Standards
Created: 28-Sep-2026
Requires: none
Replaces: none
MIP: none
---

<!--
 Copyright 2026 Midnight Foundation

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

     https://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
-->

## Abstract

Whoever builds a transaction calling a Compact circuit needs its prover key,
and prover keys dominate compiled contracts: 3.5 GB for one 30-circuit account
contract and 10.4 GB for one ecosystem deployment, against kilobytes of
verifier key on chain. MPS-0039 frames that footprint and asks how heavy
artefacts can be resolved or delegated. This MPS states the gap beneath that
question: Midnight specifies nothing about what determines a circuit's key
material, promises no reproducibility, records no producer, and offers no
client or proof-server surface that reproduces keys. On the current toolchain
the keys are deterministic: all 30 prover keys of the account contract were
rebuilt byte for byte from their ZKIR (the per-circuit zero-knowledge
intermediate representation that the Compact compiler emits and the ledger
defines) and the on-chain verifier keys, without the structured reference
string (SRS), in at most 1.35 s each. Yet a build carrying the same version
string produced different keys and an incompatible key encoding.
Reproducibility is an observed property of exact code revisions that no
artefact records, so gigabytes are shipped and hosted where kilobytes and a
producer identifier would carry the same information. This MPS is
solution-agnostic.

## Vision

A circuit's key material has a specified identity. Given the ZKIR of a
deployed circuit and the identity of the code that keyed it, any client, proof
server, or auditor reproduces the exact keys the contract verifies against,
and the verifier key on chain authenticates the result. Calling a deployed
contract needs kilobytes per circuit, maintenance updates publish what callers
need to follow them, and a toolchain change that re-keys unchanged ZKIR is a
declared, versioned event, not a surprise surfaced by rejected proofs.

## Problem

**What MPS-0039 leaves open.** MPS-0039 establishes that calling a contract
requires its full compiled bundle, dominated by prover keys that the stock
proof-server client uploads with every proving request and that a
maintenance upgrade silently invalidates. It recommends resolving heavy
artefacts by reference or delegating the work. Both paths can operate on
opaque bytes, and neither states what a circuit's key material is a function
of or which code produced it. Answering that changes what must be resolved or
held: kilobytes of ZKIR plus a producer identity instead of gigabytes of
prover keys. MPS-0039 concerns footprint and the interaction path; this MPS
concerns the identity, provenance, and reproducibility of the artefacts
themselves.

**How the keys are made.** On the ledger-9 line (midnight-zk-stdlib and the
`zkir-v3` crate of midnight-ledger), keys are generated from a circuit's ZKIR,
its intermediate representation, in two steps: `setup_vk` takes the SRS and
the circuit relation, then `setup_pk` takes the relation and the verifier
key, without the SRS. The verifier key records the circuit size parameter k
(a circuit has at most 2<sup>k</sup> rows), which the toolchain chooses from
the ZKIR row count; the prover key embeds the verifier key. Proving still
needs the SRS (25 MB at k=17, one file per k); the chain stores verifier keys
only. Sizes are decimal (1 MB is 1 000 000 bytes); peak memory is resident
set size in GiB. The Midnight Passport account contract, compiled with
compactc 0.33.0-rc.2 and ZKIR v3:

| Circuit | k | Prover key | Verifier key | ZKIR, JSON / binary |
|---|---|---|---|---|
| `deposit_unshielded` | 9 | 447 KB | 1.4 KB | 4.7 KB / 1.5 KB |
| `deposit_shielded` | 13 | 11.3 MB | 2.1 KB | 5.5 KB / 1.5 KB |
| `withdraw_shielded_with_grant_k256` | 17 | 234.9 MB | 2.7 KB | 39.6 KB / 11.6 KB |
| All 30 circuits | 9 to 17 | 3.5 GB | 74 KB | 634 KB / 185 KB |

**Measured: the keys are reproducible today.** The `zkir-v3 compile` CLI of
compactc 0.33.0-rc.2 reproduced all 30 prover and verifier keys from the ZKIR
and the SRS, byte for byte (the full path below). Verifier keys read back from
a localnet deployment equal the compiler's files, and a `setup_pk` binary over
midnight-ledger `e5da670`, given the ZKIR and those on-chain bytes, reproduced
all 30 prover keys with no SRS. Ranges over the circuits at each k, Apple
M-series laptop:

| k | Prover key | Full path (SRS read, both steps, write) | Peak memory, full path (GiB) | `setup_pk` alone |
|---|---|---|---|---|
| 9 | 0.45 MB | 0.03 s | 0.02 | 0.01 s |
| 13 | 11.3 MB | 0.38 s | 0.11 | 0.04 s |
| 14 | 24.6 to 29.4 MB | 1.09 s | 0.22 to 0.26 | 0.09 to 0.10 s |
| 15 | 49.3 MB | 2.3 to 2.5 s | 0.45 to 0.50 | 0.18 to 0.20 s |
| 16 | 98.6 to 117.5 MB | 3.2 to 6.3 s | 0.89 to 1.29 | 0.33 to 0.47 s |
| 17 | 197.1 to 234.9 MB | 5.8 to 9.7 s | 2.03 to 2.41 | 0.72 to 1.35 s |

Repeated runs and four distinct `zkir-v3` builds produced identical keys at
k=13 and k=17.

**A mismatch fails safe, by construction.** A prover key built from a
mismatched ZKIR yields proofs that a network node rejects, because the node
verifies against the on-chain verifier key; regenerating the verifier key from
the SRS detects the mismatch before proving. Neither behaviour was exercised
here.

**1. No specified identity for key material.** In practice a circuit's keys
are determined by the ZKIR, the SRS at the chosen k, and the exact revision of
the key-generation code, but nothing specifies this, and the toolchain
documents no reproducibility guarantee or stability policy. A consumer cannot
tell a property it may rely on from an accident of one toolchain line.

**2. The version string does not identify the producer.** This is the crux of
the provenance gap:

| Producer | Version | midnight-zk-stdlib / midnight-proofs / midnight-circuits | Against the compactc keys |
|---|---|---|---|
| `zkir-v3` shipped with compactc 0.33.0-rc.2, 0.34.0-rc.0, and 0.34.0 (three distinct binaries by SHA-256 digest) | 3.0.0-rc.2 | not recorded | identical |
| midnight-ledger `e5da670` (`ledger-9` head) | 3.0.0 | 2.3.5 / 0.8.2 / 7.2.4 | identical |
| midnight-ledger `57b0d0a`, last revision versioned 3.0.0-rc.2, own lock file | 3.0.0-rc.2 | 2.3.3 / 0.8.1 / 7.2.2 | prover keys differ in 6 to 624 bytes; different verifier key at k=17; the compactc prover key fails to deserialise |

The binary that compactc ships as 3.0.0-rc.2 is newer than the revision
carrying that version, and the key encoding changed within one version
string. Key identity is a property of exact crate revisions that no version
string identifies.

**3. No record of the producer.** `compiler/contract-manifest.json` records
the compiler, language, and runtime versions, plus a SHA-256 digest and a size
for every file under `compiler/`, `contract/`, `zkir/`, and `keys/`. It
records no `zkir` or midnight-zk revision. Like `contract-info.json`, it gives
the compiler version as 0.33.0 for the 0.33.0-rc.2 toolchain. The deployed
contract records verifier keys only. A client cannot know which code
reproduces its keys, nor which build to trust when a contract is re-keyed.

**4. No client or proof-server surface reproduces keys.** Only the Rust
crates and the compiler's bundled `zkir-v3` CLI generate keys. The
`@midnight-ntwrk/zkir-v2` WASM package used by midnight-js links the
key-generation code and requests the SRS per k through its
`KeyMaterialProvider` interface (`getParams(k)`); its JavaScript API
(`prove`, `check`, `provingProvider`, `jsonIrToBinary`, and a `Zkir` class
with `getK`) has no key-generation entry point, and no `zkir-v3` npm package
exists. The stock proof server receives prover keys in each request body, the
open midnight-ledger PR #770 (which lets it load registered bundles) reads
them from disk, and neither generates them; MPS-0004 places key generation
outside its scope. The compiler can emit ZKIR alone (`--skip-zk`), but no SDK
or browser surface turns it into keys, so a client that can run neither the
CLI nor the crates can only receive a prover key as bytes.

**5. Integrity is anchored to the bundle, not the chain.** In midnight-js
5.0.0, `NodeZkConfigProvider` and `FetchZkConfigProvider` check every loaded
artefact against the co-shipped manifest, fail-closed by default
(`ZkArtifactIntegrityError`, with an optional `expectedManifestHash` pin). In
the default mode, a prover key derived correctly from the on-chain verifier
key is refused unless it is byte-identical to the shipped file or the
co-shipped manifest is regenerated to list it, which keeps the anchor in the
bundle; the only other way past a digest mismatch is to switch the check
`off`. `verifyContractState` compares verifier keys with deployed state, yet
the on-chain key, which would authenticate any reproduced prover key, plays
no part in accepting one.

**6. No home for the ZKIR of a deployed contract.** A maintenance update
publishes new verifier keys but not the ZKIR behind them or the producer
revision, so a third party observing an address cannot obtain the kilobytes
it would need.

**Consequence: gigabytes move where kilobytes would do.** An ecosystem team on
Stagenet (midnightntwrk/servicedesk#203, same toolchain) reports
10 419 478 184 bytes of prover keys over 60 circuits, up to 570.5 MB for one.
Its wire capture shows the pinned midnight-js HTTP proof provider carrying
prover key, verifier key, and ZKIR in every `POST /prove` body: 235 s of
upload per proof at 16 Mbit/s for a 469.8 MB key. The team publishes
verifier keys and ZKIR only, which forces every user onto a hosted prover.
PR #770 answers the transport half (`--artifact-dir`), but its operator must
still hold every `.prover` file.

| Deployment | Prover keys | Needed beyond chain state, given reproducibility |
|---|---|---|
| Account contract, 30 circuits | 3.5 GB | 185 KB of binary ZKIR, plus a producer identifier |
| servicedesk#203, 60 circuits | 10.4 GB | at most its published verifier keys and ZKIR (reported as 151 KB), plus a producer identifier |

**Review feedback.** A reviewer proposed that the maintenance committee sign
prover keys and that clients store hashes of recomputed keys, but the
on-chain verifier key already authenticates a reproduced key: the gap is
identification, not authentication. Key-lifecycle concerns that reviewers
raised from other systems (revoking old keys, authenticating new ones) reduce
here to discovering the new ZKIR and its producer, since the deployed
verifier key is current by construction and a stale prover key yields only
rejected proofs.

**Scope and boundaries.** Reducing key size (native secp256k1 verification, a
SHA-256 gadget, and cheaper foreign-field arithmetic, all requested in
servicedesk#203) is complementary and out of scope: reproduction moves the
cost, it does not remove it. From k=13 upwards each step in k roughly doubled
key size and full-path peak memory. The 234.9 MB keys at k=17 here are half
the 469.8 MB class of servicedesk#203, so its 470 to 570 MB circuits would
need several gigabytes wherever they are reproduced.

- **MPS-0022** frames the lack of a standard off-chain Compact IR and leaves
  ZKIR and the proving keys explicitly outside its scope. This MPS concerns
  those keys.
- **MPS-0036** binds review statements to the verifier-key set at an address;
  this MPS concerns the mechanical identity of the artefacts reviewed.
- **MPS-0042** is the analogous serialisation problem: stability resting on
  a version label that did not change when the encoding did, as happened to
  the prover-key encoding under one `zkir-v3` crate version.
- **MPS-0004** and **MPS-0041** address trust in delegated proving; this MPS
  concerns how a prover obtains a correct key, not what it learns.

## Use Cases

- **A wallet provider's SDK across many custody contracts.** The SDK pays into
  the custody contracts of strangers through a public deposit circuit (11.3 MB
  prover key) and acts for owners through withdraw circuits (234.9 MB). Each
  contract adds hundreds of megabytes to ship or fetch, or keys to reproduce
  with code the SDK cannot identify.
- **A dApp or agent CLI given only a contract address** (the MPS-0039 case).
  Nothing tells it which ZKIR the address runs or which producer keyed it, so
  it needs a full bundle from a trusted party.
- **An ecosystem team with 10.4 GB of keys** (servicedesk#203), whose users
  cannot install them and so all prove through a hosted prover that sees
  their witnesses.
- **A proof-server operator.** Under PR #770 it holds every `.prover` file of
  every supported contract, refreshed after each maintenance update, although
  kilobytes of ZKIR and the on-chain verifier key determine them.
- **An auditor or light verifier.** It wants to confirm from the deployed
  verifier key that a published ZKIR is what a contract runs, binding
  MPS-0036 review evidence to the running circuit; that requires the exact,
  unrecorded producer.
- **A contract upgraded through its maintenance authority.** Clients need the
  new ZKIR and producer identity, yet receive a re-shipped bundle or a failed
  verifier-key comparison.

## Goals

In priority order:

1. **Specified identity.** A normative statement of what determines a
   circuit's keys, precise enough for two parties to agree that they hold the
   same key material without exchanging it.
2. **Stated reproducibility.** The identified inputs reproduce the keys byte
   for byte, under a published policy for when and how a toolchain change may
   alter them.
3. **A readable producer identifier,** recorded where consumers of compiled
   artefacts and deployed contracts can read it, distinguishing builds that
   share a version string.
4. **Chain-anchored acceptance.** Integrity checks accept any prover key that
   the deployed verifier key authenticates, whatever its source, and refuse
   every other.
5. **Reproduction for every client class.** Reproducing a prover key takes
   seconds for the circuits in circulation (`setup_pk` took at most 1.35 s on
   the measured account-contract circuits, k up to 17; larger circuits are
   unmeasured) and is available to browser, Node.js, and native clients, or
   delegable to a component holding only the identified inputs.
6. **Kilobytes per circuit.** What a third party needs beyond chain state to
   call a deployed contract, including after maintenance, is measured in
   kilobytes per circuit.

## Expected Outcomes

Wallet providers, agent tooling, and services support a new contract for
kilobytes of data and, at the measured circuit sizes, seconds of computation,
not gigabytes of download. Where a client can afford reproduction, a hosted
prover becomes a choice, not an obligation that exposes witnesses. Auditors
confirm against chain state that a published ZKIR is what a contract runs.
Re-keying toolchain changes become visible and planned. The MIPs recommended
by MPS-0039 carry a small, precisely named payload.

## Open Questions

- **Normative per ledger version?** Should reproducibility be normative per
  ledger version, making a re-key on toolchain change a protocol event? Is the
  per-k SRS part of the identity, or a network constant?
- **Where does the producer identifier live, and what is it?** The manifest,
  deployment metadata, a registry, or the chain; a source revision, a crate
  lock, or a binary digest.
- **ZKIR on chain?** Binary ZKIR is 1.5 to 12.1 KB per circuit here, yet
  deploying 30 verifier keys took three transactions under a client budget of
  25 KB of verifier-key bytes per update; the ledger limit was not measured.
- **Canonical ZKIR form.** The manifest hashes both JSON and binary; which
  does an identity cover?
- **Memory ceilings.** The full path peaked at 2.41 GiB at k=17; `setup_pk`
  memory alone was not measured. What do browsers and phones allow?
- **Client or proof server?** Which one derives keys? A cryptography reviewer
  preferred local reproduction and caching, holding that key generation costs
  about as much as proving and often less than the download.
- **One identifier with MPS-0039.** How do its "Verifiable artifact
  resolution" MIP and a MIP answering this MPS share one identifier?
- **Incentives.** Reviewers judged a registry a large undertaking in security,
  storage, maintenance, and incentives; who operates it, and why, remains
  open. This is MPS-0039's hosting question with a smaller payload: kilobytes
  plus provenance.

## Recommended MIPs

- **Circuit Artefact Identity and Reproducibility** (the keystone). The inputs
  that determine key material, the producer identifier and its granularity,
  the reproducibility guarantee and change policy, and conformance vectors.
  Problems 1 to 3; goals 1 to 3.
- **Key Regeneration Surfaces.** A key-generation entry point in the client
  WASM and npm packages, and a proof-server mode that derives and caches
  prover keys from ZKIR and the on-chain verifier key. Narrows the
  "Proof-server key store (keys by reference)" MIP of MPS-0039, since a server
  can derive rather than store, and lets the bundles PR #770 registers omit
  their `.prover` files. Problem 4; goal 5.
- **Chain-Anchored Artefact Integrity in the SDKs.** An integrity mode that
  accepts a prover key because the deployed verifier key authenticates it,
  not because a co-shipped manifest lists it; a mechanical anchor for
  MPS-0036 deployment checks. Problem 5; goal 4.
- **ZKIR Discovery for Deployed Contracts.** How a client holding only a
  contract address obtains the ZKIR and producer identifier of each circuit,
  including after maintenance. The narrowed payload of the "Verifiable
  artifact resolution" MIP of MPS-0039: ZKIR plus a producer identifier,
  keyed by the on-chain verifier-key identity, not full bundles. Problem 6;
  goal 6.

## References

- **Companion MPS:** [MPS-0039: Calling a Contract Requires Its Full Compiled
  Artifacts](./mps-0039-lightweight-contract-interaction.md).
- **Adjacent MPSs:** [MPS-0022: A Standard, Language-Agnostic Representation
  of Compiled Compact Contracts](./mps-0022-standard-contract-representation.md),
  [MPS-0036: Security-Review Evidence for Compact Contract
  Releases](./mps-0036-security-evidence-for-compact.md), [MPS-0042: Stable,
  Versioned and Well-Specified Serialization
  Format](./mps-0042-serialization-format.md), [MPS-0004: Trustworthy
  Delegated Proof Generation for Privacy-Preserving
  Transactions](./mps-0004-trusted-proof-serving.md), and [MPS-0041:
  Custodian-Compatible Compact Contract Proof
  Generation](./mps-0041-custodian-proof-server-contracts.md).
- **Upstream report and response:**
  [midnightntwrk/servicedesk#203](https://github.com/midnightntwrk/servicedesk/issues/203)
  and [midnightntwrk/midnight-ledger PR #770](https://github.com/midnightntwrk/midnight-ledger/pull/770),
  "resolve configured contract artifacts", open at the time of writing.
- **SDK integrity:** midnight-js 5.0.0 release notes, "ZK artifact integrity
  verification (#1015)"; `node-zk-config-provider`,
  `fetch-zk-config-provider`, and `utils/src/zk-artifact-manifest.ts`.
- **Key generation:** midnight-zk `zk_stdlib` (`setup_vk`, `setup_pk`) and
  midnight-ledger `zkir-v3` key generation.
- **Evidence:** `experiments/proving-key-regeneration/` in
  `midnightntwrk/passport` (PR #170): reproducible scripts and results for
  every Midnight Passport measurement above.

## Acknowledgements

The IOG ARC department and its reviewers, the Midnight Foundation ledger and
tooling teams, and the ecosystem team that reported
midnightntwrk/servicedesk#203.

## Copyright

This MPS is licensed under CC-BY-4.0.
