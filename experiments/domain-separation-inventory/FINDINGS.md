# Findings — Domain-Separation Inventory

**Date run:** 2026/06/02
**Sources (pinned):** `midnightntwrk/midnight-ledger` workspace `8.0.2`,
commit `dfb450d`, base-crypto `1.0.0`; `midnightntwrk/compactc` commit
`0e76dafa` (`compiler/standard-library.compact`); spec corpus
`midnight-architecture` + `midnight-improvement-proposals` (local clones in
`tmp/`).
**Reproduce:** `./run-all.sh` (raw enumeration); `INVENTORY.md` is the
curated, verified table.

## Summary statistics

- **~28 domain-tagged hash use sites** across the two codebases (§1 of
  `INVENTORY.md`).
- **25 distinct domain tags** in shipped code — **19 `midnight:`**, **6
  `mdn:`** — plus a third scheme (`ni` / `ni-pk[v1]`) in the canonical
  WalletEngine Specification, whose *rendered* diagram (`zswap-keys.svg`,
  `mdn:pk`) is itself stale against its `.puml` source (`ni`).
- **2 prefix schemes coexist inside the ledger** (`midnight:` and `mdn:`);
  **3** once the spec's `ni*` is counted; Dust mixes both code schemes.
- **Only 4 of 25** tags are hoisted to a named `const`; the remaining 21 are
  inline string literals.
- **Form is unsystematic:** 4 `[v1]`-versioned, 4 trailing-`:`, ≥3 NUL-padded
  to 32 bytes, 2 exact-fit `[u8; 12]`, the rest plain. No consistent length,
  casing, or versioning rule.
- **≥2 untagged sites** where a tag would be expected (`UserAddress`; Merkle
  internal nodes by undocumented convention), plus several opening-based
  commitments a caller cannot distinguish from "tag forgotten" (§3).
- **0 tags declared** in any architecture document, specification, or MIP.
  The one place that *does* specify key-derivation separators — the
  WalletEngine Specification — uses a disjoint scheme (`ni` / `ni-pk[v1]`), and
  its own rendered diagram is stale against its source (`zswap-keys.svg` shows
  `mdn:pk`, `zswap-keys.puml` shows `ni`).

## Verdict

**Domain separation is applied but unregistered and inconsistent.**

The discipline exists — nearly every commitment, nullifier, and identifier
mixes in a domain tag — but it is a scattered, hand-applied caller convention
with no canonical source: two prefix schemes in the code, a third in the spec,
no shared registry, only four tags hoisted even to a `const`, no consistent
form, at least one missing prefix, and **zero** tags documented anywhere. The
canonical specification, its own diagram, and the shipping ledger disagree on
the separators for the coin public key and the wallet key derivations (§4).

It is also **load-bearing, not cosmetic.** For a contract-owned coin,
`coin_commitment` and `coin_nullifier` hash the same `CoinPreimage`
(`standard-library.compact:220–244`; ledger `coin-structure/src/coin.rs:626–648`),
differing only by domain tag (`mdn:cc` / `mdn:cn`). A contract has no secret key
to separate them, so the tag alone keeps a coin's commitment from equalling its
nullifier — the first-party code applies this correctly; the gap is that the
discipline is undocumented and unregistered, not that it is currently broken.

This is the inverse of the MIP-0003 situation: the *technique* is in use, but
the *standard* — a convention, a registry, and enforcement — does not exist.
The MPS premise holds, and `INVENTORY.md` is both the evidence and the first
draft of the registry.

## Implications for C8 / the MPS

- **Problem & Use Cases.** The numbers above are the Problem section. The
  sharpest use case is the §4 divergence: three domain-separator values for
  the coin public key across the spec text, the spec diagram, and the code is
  a concrete governance failure — exactly what a registry plus a single source
  of truth would have caught. A third-party Compact author today has no
  convention to follow and no way to avoid colliding with a ledger or stdlib
  tag.
- **Goals.** A single canonical scheme; every `persistentHash`/`transientHash`
  use site carries a registered tag; the registry is the source of truth that
  spec, diagram, and code are checked against.
- **Recommended MIPs.** One MIP defining the domain-separation convention and
  the tag registry (alternative A); the registry can be seeded directly from
  `INVENTORY.md`. A later, optional MIP (or a phase of the first) adds
  compile-time / build-time enforcement (alternative C).
- **Open questions to carry up.** (1) Are Compact `mdn:cc`/`mdn:cn` and ledger
  `midnight:zswap-cc[v1]`/`-cn[v1]` the same object? (2) Which scheme wins —
  `midnight:`, `mdn:`, or `ni`? (3) Is a tag frozen at network deployment
  (like the address separators in MIP-0003), making reconciliation a
  migration, not a refactor?

## Caveats

- Static analysis only — this characterises the source as it ships, not
  runtime behaviour. Whether a §4 divergence is a live mismatch or two
  distinct objects requires reading the construction, and is flagged as an
  open question rather than asserted.
- Tag ↔ site association and the untagged classification were verified by
  hand; the scanner locates candidates, the `file:line` references in
  `INVENTORY.md` are the evidence.
- Test fixtures are excluded; a handful of tags (e.g. `kernel:nonce_evolve`)
  appear in ledger tests but originate in the Compact stdlib or as
  caller-supplied parameters, and are inventoried from their production
  source.
