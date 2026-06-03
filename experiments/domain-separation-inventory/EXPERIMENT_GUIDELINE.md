# Experiment Brief — Domain-Separation Inventory

**Date scoped:** 2026/06/02
**Owner:** _to be assigned_
**Target location:** `experiments/domain-separation-inventory/`

---

## Goal

Produce a complete, reproducible inventory of every hash
domain-separation use site across Midnight's Compact standard library
and the `midnight-ledger` Rust source. For each site, record the
primitive, the domain tag (or its absence), and how the tag is formed.

The deliverable is a strict, evidence-backed statement of the *current
state* of domain separation in Midnight: how many use sites exist, how
many carry a tag, how many schemes coexist, how many are untagged, and
which (if any) are declared in a specification. Every entry is backed by
a `file:line` reference into pinned source — no inferred or hypothetical
tags.

This is **static analysis only** — it characterises the source as it
ships. It proves nothing about runtime behaviour, and it does not
propose a convention: the inventory documents what *is*, and the
MPS/MIP recommend what *should be*.

## Why this matters

C8 makes domain-separation discipline explicit. A prior recon
established the discipline exists in practice but is undocumented,
unregistered, and inconsistent. An MPS arguing that gap needs hard
numbers, not a spot-check — and the registry that alternative A ships
*is* an enumeration of these very tags. So the inventory is dual-purpose:

- **MPS evidence** — the Problem and Use-Cases sections of the C8 MPS
  cite the counts and the concrete inconsistencies.
- **Registry seed** — `INVENTORY.md` is the first draft of the
  alternative-A registry; finalising A is largely curating this table.

It also re-runs the MIP-0003 reflex once more: if the scan finds the
practice is in fact consistent, complete, single-scheme, and centrally
sourced, the MPS premise is weaker than believed — better learnt before
publishing than after.

## Prior signal (hypothesis)

From the recon spot-check, expected before scanning — to be confirmed or
refuted, every `~` and "at least one" replaced with an exact figure and
a `file:line`:

- The primitives are raw — `persistent_hash` (SHA-256) and
  `transient_hash` (Poseidon) take no domain argument; separation is a
  caller discipline.
- Tags are applied by hand as literals: stdlib `"mdn:lh"`, `"mdn:cc"`,
  `"mdn:cn"`; ledger `b"midnight:zswap-cc[v1]"`, `b"mdn:dust:nul"`,
  `b"midnight:csk"`, with ~21 distinct ledger tags in total.
- Two prefix schemes coexist (`midnight:` and `mdn:`); some tags carry a
  `[vN]` suffix, some are NUL-padded to a fixed width, some neither;
  only ~4 of the ledger tags are hoisted to a module-level `const`.
- At least one untagged site exists (`UserAddress`,
  `coin-structure/src/coin.rs`).
- No architecture doc, spec, MIP, or MPS declares the tags; the kernel
  specification asserts notes and nullifiers are "domain-separated"
  without a construction, and proposal 0014 separates the two hash
  functions without a tagging convention.

## Scan passes — in scope

Each pass appends to `INVENTORY.md` and is reproducible from the scanner.

### S1 — Enumerate Compact stdlib hash sites
Every `persistent_hash` / `transient_hash` / `persistent_commit` /
`transient_commit` call and every `domain_sep` struct field in the
`.compact` standard library. Record `file:line`, primitive, and the
enclosing construction (Merkle leaf, coin commitment, nullifier, …).

### S2 — Enumerate ledger hash sites
The same across the `midnight-ledger` Rust `src` — the `base-crypto`,
`transient-crypto`, `coin-structure`, `zswap`, and `ledger` crates.
Cover commitments, nullifiers, coin/note commitments, addresses,
Merkle-node hashes, key derivations, and challenge hashes.

### S3 — Extract the domain tag
For each site, capture the tag: the byte literal prepended to the
SHA-256 preimage, the Poseidon `opening` field element, or the
`domain_sep` struct field. Where no tag is mixed in, record **UNTAGGED**.

### S4 — Classify each tag
Scheme prefix (`midnight:` / `mdn:` / other / none), fixed-width or
NUL-padding, version suffix (`[vN]`), and whether the tag is an inline
literal or hoisted to a named `const`.

### S5 — Cross-reference the specs
For each distinct tag, record whether any document in
`midnightntwrk/midnight-architecture` (ADRs, specification, proposals,
components) or `midnightntwrk/midnight-improvement-proposals` (mips, mps)
*declares* it. Expected result: only the key-derivation tags appear in
the WalletEngine specification; the rest are declared nowhere.

## Out of scope

- Designing the registry format or the canonical convention — that is
  the recommended MIP's job, not the inventory's.
- Recommending which scheme wins (`midnight:` vs `mdn:`) — the inventory
  documents what exists; the MPS/MIP recommend.
- Runtime, devnet, or proof behaviour — this is a static source scan.
- Serialization tagging (`serialize::Tagged`, ADR-0022) — that is
  wire-versioning, explicitly not hash domain separation.
- Editing or refactoring upstream source — read-only.

## Setup

- **Sources (pinned).**
  - Compact standard library — `midnightntwrk/compactc`, commit
    `0e76dafa` (local checkout `~/work/midnight/compactc`), cross-checked
    against installed `0.10.6`. Note the absence of a shipped `.compact`
    stdlib in toolchain `0.30.0`.
  - `midnightntwrk/midnight-ledger` Rust workspace `v8.0.2`, commit
    `dfb450d`, base-crypto `1.0.0` (local checkout under
    `~/.cargo/git/checkouts/midnight-ledger-*`).
  - Spec corpus — `midnightntwrk/midnight-architecture` and
    `midnightntwrk/midnight-improvement-proposals` (public repos; local
    clones in `tmp/`). Pin commits in `FINDINGS.md` at run time.
- **Language.** A small scanner — TypeScript (to match the neighbouring
  experiments' tooling) or a shell + `ripgrep` script — that walks the
  source trees, extracts the tag per site, and emits `INVENTORY.md`.
  Robust regexes plus manual verification of edge cases: the scanner is
  an aid, the `file:line` references are the evidence.
- **No devnet, node, wallet, or SDK** is required.

## Deliverables

1. **`INVENTORY.md`** — the canonical table, one row per hash use site:
   `use site (file:line) | source (stdlib / ledger) | primitive | domain tag | scheme | versioned | hoisted | declared in spec?`.
2. **`FINDINGS.md`** with:
   - **Header** — source versions/commits scanned, date run.
   - **Summary statistics** — total sites; tagged vs UNTAGGED; distinct
     tags; scheme breakdown; versioned / padded / hoisted counts;
     declared vs undeclared.
   - **Verdict** — exactly one of:
     - *Domain separation is consistent, complete, single-scheme, and
       centrally sourced* — the C8 MPS premise does not hold; reassess
       scope.
     - *Domain separation is applied but unregistered and/or
       inconsistent* — the C8 MPS premise holds; the table is the
       evidence and the registry seed (with the numbers).
   - **Implications for C8 / the MPS** — one paragraph feeding the
     Problem, Use-Cases, and Recommended-MIPs sections of the C8 MPS.
3. **`src/` + `run-all.sh`** — the scanner and a single command that
   regenerates `INVENTORY.md` from the pinned sources on a clean
   checkout.

## Acceptance criteria

- Every hash / commit / nullifier use site in both sources appears in
  `INVENTORY.md` with its tag (or UNTAGGED) and full classification, each
  backed by a `file:line`.
- Summary statistics and a single-line verdict are recorded in
  `FINDINGS.md`, justified by the table.
- The scan re-runs end-to-end against the pinned sources and reproduces
  `INVENTORY.md`.
- `INVENTORY.md` is directly usable as the first draft of the
  alternative-A registry.

## References

- **Component canvas:**
  [`docs/plans/components/C8-domain-separation-registry.md`](../../docs/plans/components/C8-domain-separation-registry.md)
  — outcome, alternatives A/B/C, and the registry-as-oracle failure mode.
- **Upstream source (to be scanned):** `midnightntwrk/midnight-ledger`
  (`base-crypto`, `transient-crypto`, `coin-structure`, `zswap`,
  `ledger`); the Compact standard library in `midnightntwrk/compactc`.
- **Spec corpus (S5):** `midnightntwrk/midnight-architecture` —
  proposal 0014 (separates `persistent_hash` / `transient_hash`), the
  kernel specification (asserts notes/nullifiers are "domain-separated"
  without a construction), ADR-0020 (key sampling, a placeholder
  `domainSeparator` parameter); `midnightntwrk/midnight-improvement-proposals`
  — mps-0008 (keccak), mps-0011 (native crypto primitives), neither
  defining domain separation.
- **Related experiment:**
  [`../contract-custody-feasibility/`](../contract-custody-feasibility/)
  — house style for experiment briefs, findings, and reproducibility.
