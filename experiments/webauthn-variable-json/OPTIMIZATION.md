# Internal reductions within a negative experiment

**These reductions are only relative to the first variable-length prototype.**
Against the previous fixed-profile `wa-json134` verifier, the best measured
variant still uses **8.9× the rows and 8.1× the prover-key bytes**. Proofs remain
6,364 bytes and verifier keys remain 2,745 bytes: **0 bytes saved in either**.
The recorded outcome is negative for size/byte savings and proving cost; this
document preserves the attempted optimizations, not a replacement recommendation.

The original build and full generated assets were preserved before the follow-up:

- `contract/contracts/probe-webauthn-variable-baseline.compact`
- `contract/contracts/managed/probe-webauthn-variable-baseline/` (local, ignored)
- `contract/evidence/webauthn-variable-json/baseline/` (receipts and source snapshots)

## Measured alternatives

Compact 0.35.0, ZKIR v3; same 256-byte capacity and JSON/policy checks.

| Construction | Raw hash rows | Full verifier rows | Full k |
|---|---:|---:|---:|
| Initial Boolean/Uint implementation | 972,563 | 1,118,544 | 21 |
| Field-valued word arithmetic | 972,766 | 1,118,747 | 21 |
| Field-valued Boolean polynomials | 1,144,417 | 1,290,398 | 21 |
| **Conditional bits + deferred reduction** | **852,999** | **998,980** | **20** |

The last construction was selected for full key generation and proof testing.
Its full verifier prover key is **1,893,363,935 bytes**, down from
**3,774,377,857 bytes** (49.8% smaller). Its verifier key is still **2,745 bytes**.
Both experiment entry-point keys total **4,098 verifier bytes**, below the
**15,000-verifier-byte deployment-wave budget**; account integration must be
budgeted separately. The new full circuit has 10.7% fewer rows, crossing a
power-of-two proving-domain boundary.

The retained generated assets and their SHA-256 digests are the evidence. The
unsuccessful scouts used `--skip-zk` plus `zkir-v3 mock-compile`, not full key
generation; they have no proof or prover-key-size claims.

## Selected changes and bounds

1. Express bit XOR and majority using Boolean conditionals, avoiding generic
   equality gadgets where possible.
2. Keep SHA's round intermediates `T1` and `T2` as unreduced sums until the two
   actual next-state words are constructed. They are never used as bitvectors,
   so decomposing them is unnecessary. This eliminates **640 witness calls**
   across five blocks (1,641 → 1,001 calls).
3. Preserve the witness equality `value = word(bits) + carry * 2^32` and its
   Boolean-bit/four-bit-carry constraints. No digest or arithmetic result is
   accepted on witness authority.

Each round output sums at most seven 32-bit terms: less than `7 * 2^32`, safely
inside `Uint<36>`, with carry at most six. Byte assembly and message bit length
are also inside that range. Both sides of the equality are far below the native
field modulus. Deferring reduction is valid because SHA addition is modulo
`2^32`; reduction after the complete sum gives the same word. All five allocated
compression blocks and all length/padding constraints remain present.

## Separate, unmeasured native-gadget route

Upstream already has a native bounded variable-length SHA-256 chip, including at
the revision pinned by the older P-256 Rust experiment:

https://github.com/midnightntwrk/midnight-zk/blob/cd2c27b2659de157409a9b96dba0dbaf1218f00b/circuits/src/hash/sha256/sha256_varlen.rs

Compact 0.35's exposed `persistentHash<T>` hashes the compile-time encoding of
`T`; the inspected ZKIR v3 `persistent_hash` instruction takes a static alignment
and inputs, with no runtime message-length operand. Using that native chip from
Compact needs compiler/runtime/IR support and conformance work. The chip's
existence alone is not deployment or cost evidence for Passport. The current
Compact optimization is smaller but remains expensive relative to the fixed
profile's native hashing.

## Proof transport

The experiment's prover key is about 1.9 GB. The test provider streams it to the
local proof server instead of repeatedly copying it through the JavaScript/WASM
heap. Envelope and optional binding encodings come from ledger-v9. The three
key-material byte vectors use the ledger's SCALE length prefixes. Boundary
fixtures compare the streamed encoding byte-for-byte with `createProvingPayload`.
The server receives normal binary `.bzkir`, verifier key and prover key bytes.

Real-proof receipts belong in `contract/evidence/webauthn-variable-json/proofs.json`.
Both 140-byte strict and 256-byte limited assertions produced **6,364-byte proofs**,
passed ledger-v9 contract-proof verification and were applied in memory. Fee
balancing is disabled for this isolated laboratory; node acceptance and
custody/grant integration require their own evidence. The 201.62 s / 171.02 s
round trips and 24.50 GB server-container memory high-water mark (including cache)
show that the remaining proving cost is substantial. See `FINDINGS.md` for
measurement conditions and the separate raw-transcript assertion checks.
