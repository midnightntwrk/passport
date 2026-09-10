# E1 stage one: scoped grants on the reference contract, `spec_version = 2`

Worktree `arc-passport-k1-arm`, branch `nicolasdp/grants-seam-e1`. Scope of this
stage: cells and structs, the pure derivations, the k256 grantee seam and two
of its twins (unshielded, shielded), the three lifecycle circuits on the
k256 device arm, the client half of Testing item 5 (byte-recipe vectors), and
the Rust side of the cross-implementation check. Toolchain: `compact compile
+0.33.0-rc.2 --feature-zkir-v3` (compactc 0.33.0, language 0.25.0,
compact-runtime 0.18.0-rc.1).

Files changed, all under `contract/`:

- `contracts/account.compact` (+655 lines, one line changed:
  `spec_version = 2`); `contracts/managed/account/` regenerated (gitignored);
- `src/tests/unit-offline.ts` (+573 lines: the `[grant]` section, six
  steps, and the recipe helpers written from the MIP text alone);
- `src/tests/vectors/grants-e1.json` (new, written by `test:unit`: 27
  vectors with full preimages plus two pinned signatures);
- `src/tests/crossimpl-offline.ts` (+135 lines: the `[k256/grant]` case);
- `signer-rs/src/grants.rs` (new, 2,207 lines including tests),
  `signer-rs/src/main.rs` (two request variants and the protocol comment),
  `signer-rs/Cargo.toml` (description only, no new dependency).

Nothing under `docs/`, the MIP, or outside the worktree was touched; no git
state changed; no docker or localnet was started. Scratch material lives
beside this file: `vectors.ts` (the original byte-recipe check, since moved
into `unit-offline.ts`), `local-exec.ts` (off-node execution probe),
`measurements.txt` (k, rows, key sizes for all 23 circuits),
`compile-full.log`, `skipzk-module/`, `grant-vectors.py` and
`compare-ts-vectors.py` (the Rust verifier's independent generators),
`verify-ts.md` and `verify-rs.md` (the two verifier reports).

## 1. What compiled first time, and every compile error met

Everything compiled on the first pass, both the `--skip-zk` type-check run
and the full key-generating run (`Compiling 23 circuits`, exit 0). No compile
error was met at any point. Constructs the MIP marked unevidenced that the
compiler accepted without change:

- `export struct GrantRecord { ...; scope: GrantScope; }` as the value type
  of `export ledger grants: Map<Bytes<32>, GrantRecord>` (nested struct as a
  Map value), including the generated TypeScript `Ledger` type with
  `lookup(key): GrantRecord` and an iterator over `[Uint8Array, GrantRecord]`;
- `Boolean` elements inside a `persistentHash` tuple type;
- tuple arities of 13 (`challenge_withdraw_shielded_with_grant_k256`) and
  17 (`derive_grant_scope_digest`);
- `kernel.blockTimeLessThan(g.scope.expires_at)` as the right operand of
  `||` inside an `assert`;
- `if (grants.member(id)) { const old = grants.lookup(id); assert(...); }`
  (statement-level guarded lookup with a block-scoped `const`);
- `grants.resetToDefault()` on a `Map`;
- a circuit returning `[Bytes<32>, GrantRecord]` and the caller
  destructuring it with `const [id, g] = ...`;
- `spent_prev + amount` (two `Uint<128>`, widened result) compared with
  `<=` against a `Uint<128>` and then narrowed with `as Uint<128>`;
- struct literals with nested struct literals and no trailing comma
  (`GrantRecord { ..., scope: GrantScope { ... } }`), fields disclosed
  individually;
- `if (disclose(result.is_some)) { do_append_inbox(change_entry); }` after the
  custody chip, in the same circuit. Written with the `disclose`; whether the
  compiler would accept the bare `result.is_some` was not tested.

The only iteration needed was in the off-node harness (fixtures: a scope with
`max_coin_value = 0` tripping issue rule 4 before the rule under test, a cap
that did not exceed, a use counter advanced on aborted calls, a bare
`lookup` on an absent record inside the harness). The contract fired the
intended assert in every one of those runs.

## 2. Suites

Final state, all offline, no node:

| Suite | Result | What it now covers for grants |
|---|---|---|
| `npm run -s test:unit` | PASS (123 checks) | the `[grant]` section: every new pure circuit bit-exact against a hand-built SHA-256 preimage; GR-3, GR-5, GR-6, GR-16, AUTH-3, SIG-4, S10 properties; writes `src/tests/vectors/grants-e1.json` |
| `npm run -s test:crossimpl-offline` | PASS | the existing two device arms plus `[k256/grant]`: a Rust-signed `withdraw_unshielded_with_grant_k256` call whose `origin_hash`, `grant_id`, challenge, and envelope digest are recomputed through the compiled pure circuits, the signature verified on `@noble/curves`, and shown not to verify under the next slot's `grant_id` |
| `cargo test` (signer-rs) | 30 passed, 0 failed | 6 pre-existing, 24 grant tests, including one that reads `grants-e1.json` and reproduces all 27 vectors and both pinned signatures from their own arguments |
| `cargo build`, `cargo clippy --all-targets` | clean, no warnings | |
| `npx tsc --noEmit` | clean | |

No existing exported circuit changed ABI or behaviour; the existing k256 and
jubjub prover and verifier key sizes are byte-for-byte the same as before
(section 5). No existing check, wallet file, or suite was altered beyond the
additions above.

## 3. Off-node execution (compact-runtime local simulator, no node, no proof)

`local-exec.ts` runs the k256 device arm and the k256 grantee arm through
`createCircuitContext` with the simulator's `time` parameter as block time.
51 of 51 checks pass. What it establishes:

Lifecycle (issue rules 1 to 7 in order, each refused before any write; issue
over an absent id writes the whole record with `epoch = 0`, `gen = 0`,
`issued_at = auth_nonce` as advanced by the device seam (1 for the first
issue), `nonce = 0`, `spent_commit = commit(salt, 0)`, `object_commit` and
`rp_commit` as derived, clear fields written; re-issue over a live id refused
with "grant already active"; revoke of an absent id refused with "unknown
grant"; a read-only grant under another slot issued with all object fields
zero; revoke writes a tombstone keeping every other field; revoke of a
tombstone refused with "grant not live"; re-issue over a tombstone yields a
fresh incarnation with `nonce = 0` and a larger `issued_at`; a
prior-incarnation opening against the re-issue fails at the object
commitment; `revoke_all_grants` bumps `grant_generation` and
`resetToDefault` clears the map (3 records cleared); re-issue under the new
generation records `gen = 1`.

Unshielded grant twin (the simulator executes `receiveUnshielded` and
`sendUnshielded`, so the whole twin ran): the mirror funded by
`deposit_unshielded`; a within-scope call advances the record `nonce` to 1,
re-commits `spent_commit` to 200, debits the mirror, advances `round` by
exactly one, and leaves `auth_nonce` and `device_count` unchanged (GR-5,
GR-12, GR-13). Rejection items, each with no state change: identical
resubmission (stale nonce, fails at the signature); over `per_call_cap`;
over `cap` (200 + 300 > 450, fails at the cap assert, not at the narrowing
cast); wrong `spent_prev` opening; wrong recipient under a pin;
recipient-kind mismatch and wrong `scope_salt` (both at the object
commitment); wrong envelope and a foreign key (both at "unknown grant",
because `grant_id` changes); out-of-scope operation (a shielded-only grant
through the unshielded twin); the grantee key against a device-gated circuit
("unknown device entry"); a call before `expires_at` executes and one after
it aborts with "grant expired" (`time` moved by 200 s); `expires_at = 0`
never expires; a call against a tombstone aborts with "grant revoked"; a
call after `revoke_all_grants` aborts with "unknown grant" (record absent
after the reset, so the generation check is never reached).

Not executed off-node: the shielded grant twin (needs Zswap coins and the
`held_coin` witness; a node run), and anything involving proving.

## 4. MIP section 13 `[CIRCUIT]` items settled

| Item | Verdict | Evidence |
|---|---|---|
| Struct embedding a struct as a `Map` value | compiles and executes; no flattened fallback, no extra `spec_version` | section 1; lookup and insert of `GrantRecord` with nested `GrantScope` off-node |
| `Boolean` in a hash tuple | compiles; encodes as one byte, `0x01` true, `0x00` false, exactly `flag(b)` | `unit-offline.ts` `[grant]`: `derive_grant_scope_digest` bit-exact for four flag patterns, all sixteen distinct |
| Tuple arity above ten | 13 and 17 compile; hash is the raw concatenation; no `args_digest` or two-stage fallback, so no new trailing tag version | 13-element (16 atoms) and 17-element preimages bit-exact on both sides |
| `kernel.blockTimeLessThan` | compiles inside `expires_at == 0 \|\| blockTimeLessThan(expires_at)`; executes off-node in both directions; the local simulator's unit is seconds; the node's unit remains unpinned (E3) | `local-exec.ts` expiry items |
| `if`-guarded lifecycle bodies | compile and execute: absent id, tombstone, inert record all issue; live id refused | `local-exec.ts` |
| Reset primitive | `Map.resetToDefault()` exists, compiles, executes (map empty afterwards) | `local-exec.ts` revoke_all items |
| Precomputable change description (6.5) | not evidenced here (shielded path needs a node) | stage two |
| On-curve membership of witness points | not evidenced (unchanged from the device arms) | stage two or cryptographer review |
| Cost figures | measured, section 5 | `measurements.txt` |

## 5. Final measurements

`zkir-v3 mock-compile` for k and rows; `ls -l contracts/managed/account/keys`
for key bytes. No Compact changed after the measurement sweep (section 7
confirms every mismatch resolved against the MIP, not the circuit), so this
is the final table for stage one. The five grant circuits are marked new;
every other row is unchanged from the pre-grant contract byte for byte.

| Circuit | k | rows | prover key bytes | verifier key bytes |
|---|---|---|---|---|
| `deposit_unshielded` | 9 | 311 | 446,654 | 1,353 |
| `deposit_shielded` | 13 | 6,484 | 11,278,047 | 2,121 |
| `activate_initial_device_with_jubjub` | 14 | 13,412 | 24,648,020 | 2,313 |
| `add_device_with_jubjub` | 15 | 26,771 | 49,291,288 | 2,313 |
| `remove_device_with_jubjub` | 15 | 32,730 | 49,291,960 | 2,313 |
| `rotate_enc_key_with_jubjub` | 15 | 26,725 | 49,290,830 | 2,313 |
| `append_inbox_with_jubjub` | 16 | 32,790 | 98,574,479 | 2,313 |
| `withdraw_unshielded_with_jubjub` | 15 | 28,877 | 49,292,320 | 2,313 |
| `withdraw_shielded_with_jubjub` | 16 | 50,055 | 98,576,060 | 2,313 |
| `withdraw_shielded_to_contract_with_jubjub` | 16 | 55,758 | 98,576,566 | 2,313 |
| `activate_initial_device_with_k256` | 14 | 14,094 | 29,368,023 | 2,745 |
| `add_device_with_k256` | 16 | 58,897 | 117,452,563 | 2,745 |
| `remove_device_with_k256` | 16 | 65,404 | 117,453,420 | 2,745 |
| `rotate_enc_key_with_k256` | 16 | 58,851 | 117,452,092 | 2,745 |
| `append_inbox_with_k256` | 16 | 64,924 | 117,452,693 | 2,745 |
| `withdraw_unshielded_with_k256` | 16 | 61,003 | 117,453,604 | 2,745 |
| `withdraw_shielded_with_k256` | 17 | 74,587 | 234,894,869 | 2,745 |
| `withdraw_shielded_to_contract_with_k256` | 17 | 80,290 | 234,895,388 | 2,745 |
| `withdraw_unshielded_with_grant_k256` (new) | 17 | 64,352 | 234,896,013 | 2,745 |
| `withdraw_shielded_with_grant_k256` (new) | 17 | 91,862 | 234,898,282 | 2,745 |
| `issue_grant_with_k256` (new) | 17 | 78,604 | 234,898,194 | 2,745 |
| `revoke_grant_with_k256` (new) | 16 | 58,997 | 117,453,434 | 2,745 |
| `revoke_all_grants_with_k256` (new) | 16 | 58,771 | 117,452,209 | 2,745 |

Observations:

- The unshielded grant twin costs 3,349 rows more than its device twin
  (64,352 against 61,003) and lands at k=17, doubling the prover key
  (235 MB against 117 MB). The shielded grant twin costs 17,275 rows more
  than its device twin (91,862 against 74,587) and stays at the device
  twin's k=17. `issue_grant` costs 78,604 rows (the 17-element scope digest,
  seven issue rules, the three commitments, and the whole record write) at
  k=17; `revoke_grant` and `revoke_all_grants` cost about the same as
  `rotate_enc_key` (about 59,000 rows, k=16).
- k is not a pure function of the reported rows: `append_inbox_with_k256`
  (64,924 rows) and `remove_device_with_k256` (65,404 rows) fit k=16 while
  the unshielded grant twin (64,352 rows) needs k=17. Some other resource
  (a fixed or lookup column, or the public-input count) drives the k
  choice; the MIP should quote k and rows as measured and not predict one
  from the other.
- Verifier key size depends on the circuit's shape, not on k: every k256
  circuit is 2,745 bytes at k=14, 16, or 17; every jubjub circuit 2,313;
  `deposit_shielded` 2,121; `deposit_unshielded` 1,353.
- The five new prover keys add about 940 MB on disk.

### Deploy budget (MIP 6.7, Testing 6)

Verifier bytes of the 23 impure circuits: 57,663 (18 existing: 43,938; the
5 grant circuits: 13,725). The README records the 18-key deploy pricing at
53,076 `bytes_written` against the 50,000 per-block limit, so the deploy
overhead beyond verifier bytes is about 9,138 bytes. Consequences:

- One-transaction deploy of the 23-circuit `spec_version = 2` account:
  about 66,800 bytes written, refused as before. Waves are mandatory.
- Wave plan for this stage's roster: wave 1 as today (2 deposits + 8 k256
  circuits, 25,434 verifier bytes, about 34.5 KB written); wave 2 as one
  hand-built `MaintenanceUpdate` carrying the 8 jubjub keys (18,504) and the
  5 grant keys (13,725): 32,229 verifier bytes plus the update's overhead,
  under 50,000. **Two waves**, the same count as today. Putting the grant
  keys into wave 1 instead would price at about 48,300 bytes written, under
  the byte limit but close to it, and the 18-key deploy already priced at
  2.011 s against the 2.000 s compute limit, so wave 1 should stay as it is.
- Full stage-two roster (30 circuits: + 3 jubjub grant twins and 3 jubjub
  lifecycle circuits at 2,313 each, + `withdraw_shielded_to_contract_with_grant_k256`
  at 2,745): 74,286 verifier bytes. Wave 1 unchanged (25,434); the remaining
  48,852 verifier bytes plus overhead do not fit one update under 50,000, so
  **three waves** (two maintenance updates). Authority retirement moves to
  the end of the last grant wave, as the MIP requires.
- The MIP's "about 2,950 bytes of verifier key each" is an over-estimate;
  measured 2,745 (k256) and 2,313 (jubjub).

## 6. Cross-implementation agreement (Testing item 5, offline half)

Three implementations of the byte recipes now agree on every stage-one
derivation, and the agreement is asserted by suites rather than by hand:

1. **The compiled pure circuits** (the reference), exercised by
   `unit-offline.ts` `[grant]`.
2. **The TypeScript by-hand recipe** (plain SHA-256 over padded elements,
   written from the MIP text and borrowing nothing from `src/wallet/` or the
   contract module), asserted equal to (1) for all 27 vectors and pinned
   into `src/tests/vectors/grants-e1.json` with the full preimage, its
   length, and the digest.
3. **The Rust recipe** (`signer-rs/src/grants.rs`, the ledger `fab`
   encoding, no contract module and no TypeScript), whose tests assert each
   derivation three ways (field-aligned path, by-hand plain SHA-256, and a
   vector computed by `grant-vectors.py` outside the crate), and whose
   `typescript_vectors_reproduce_from_their_own_arguments` test reads the
   JSON and reproduces **27 of 27 vectors** and **both pinned signatures**
   from their arguments. The two RFC 6979 signatures under `sk = 1` are
   byte-identical across `@noble/curves` and the RustCrypto `k256` crate
   (both derive the nonce deterministically and normalise to low-S).

Before the Rust side read the JSON, the Rust verifier's independent
`compare-ts-vectors.py` had already reproduced 24 of 27 (the three
lifecycle challenges were then out of its scope); the Rust crate now
implements those three (`challenge_issue_grant_k256`,
`challenge_revoke_grant_k256`, `challenge_revoke_all_grants_k256`, 200, 168,
and 136 bytes in the existing `midnight:account:auth:k1:v1:*` family) and
emits them from `derive_grant` when a device key and `auth_nonce` are given,
so the authoriser-side wire path covers issuance end to end.

Rust and TypeScript pinned values that use the same fixtures agree exactly:
`origin_hash("https://bank.example")` `5847018b…c780`; the four k1
`grant_id`s (`78a01a6c…`, `e055abd2…`, `51081f6e…`, `2e5d554a…`);
`rp_id_hash = SHA-256("bank.example")` `05be55af…`. The remaining Rust pinned
values use the Rust verifier's own fixtures and are recorded in
`verify-rs.md` section 3.

`crossimpl-offline.ts` gains the `[k256/grant]` case: the Rust signer,
given a fresh grantee key, `client_id`, slot, and the record's `issued_at`
and `nonce`, derives `origin_hash` and `grant_id` and signs
`envelope_digest(0, h)`; the suite recomputes `origin_hash` by hand,
`grant_id` and `h` through the compiled pure circuits, verifies the
signature on `@noble/curves`, and confirms the signature does not verify
under the next slot's `grant_id` (GR-3).

One stack fact recorded for implementers (not a recipe issue): the
RustCrypto `k256` verifier enforces low-S and refuses the high-S twin as
presented, while the circuit accepts both S forms (SIG-4). A Rust verifier
of grant signatures MUST normalise S before verifying; the Rust test asserts
the twin is refused raw and accepted once normalised.

## 7. Mismatch decisions: compiled encoding or recipe reading

For every mismatch the two verifiers raised, the question was whether the
Compact should change to match the MIP or the MIP's recipe cannot be what
the compiler produces. **No Compact change was warranted**; the contract
stays as compiled and measured, and each item becomes a MIP correction
(section 8).

| # | Mismatch | Fault | Decision |
|---|---|---|---|
| 1 | v1 key element: MIP 32 bytes / 129-byte preimage; compiled 64 bytes (two `Field` atoms, x then y, each 32 LE bytes) / 161 | recipe | `JubjubPoint` is an opaque Compact type with no compression or serialisation builtin, so the circuit cannot hash a 32-byte form; the device family already binds `pk` and `sig_r` at 64 bytes. Measured: circuit digest equals SHA-256 of the 161-byte `x \|\| y` preimage; neither 32-byte reading (x only, y only) reproduces it. Keep the Compact; correct 3.4 and 4.3 |
| 2 | `Field` atom reduction: the fab writer reduces modulo the BLS12-381 scalar prime before writing 32 LE bytes, so a by-hand SHA-256 over a raw coordinate matches only below the modulus | encoding fact | Coordinates of an on-curve point are always canonical, so no conforming input diverges. The Rust wire-form path (`grant_id_jubjub_coords`) refuses a non-canonical coordinate rather than reducing it; the MIP gains the same rule |
| 3 | `origin_hash`: `client_id` bytes appended raw and unpadded, unlike every other recipe | recipe ambiguity | Off-chain only, no circuit. Both sides read it raw and agree; the MIP states it explicitly |
| 4 | `flag(b)` undefined | recipe omission | Compiled `Boolean` is a one-byte atom (`0x01`, `0x00`); the MIP defines `flag(b)` so |
| 5 | "thirteen elements" on the shielded ECDSA challenge counts the coin as one member; the encoding is sixteen atoms, 568 bytes | recipe wording | Both counts are right at different levels; the MIP says which it counts |
| 6 | Envelope bound twice (in `grant_id` and in the signed message), consequence not drawn | recipe wording | Stated in 3.1 |
| 7 | The v1 identity recipe does not reject the JubJub identity `(0, 1)` | as designed | Key validation is 3.3's, "exactly the following and no more"; 4.3 gains one sentence so a lifted derivation is not mistaken for a guard |
| 8 | DST marker derived from the arm, not the wire scheme name | recipe wording | Registry table keyed by arm |

## 8. MIP corrections

Numbered for the MIP editor; each names the section and the exact change.

1. **Section 3.4, `pk` table, `v1` row.** Replace "64 hex: the 32-byte
   `JubjubPoint` encoding in the layout this MIP publishes with its vectors
   (the type is opaque in Compact; the layout is the one the reference
   signer reproduces for the device family)" with: "128 hex: affine
   `x || y`, each a 32-byte little-endian canonical element of the BLS12-381
   scalar field (the JubJub base field)". Preimage element column: "`x`,
   `y` as given (64 bytes)", the same shape as the `k1` and `r1` rows. Add
   the rule: a wire coordinate at or above the field modulus is not the
   encoding of any point and MUST be rejected, never reduced; the compiled
   encoding writes the canonical residue, so only canonical coordinates
   reproduce the circuit by plain SHA-256.
2. **Section 3.4, off-chain signature table, `v1` row (knock-on).** `R` is
   the same 64-byte `x || y` form, so the encoding is 192 hex
   (`R.x || R.y || s`), not 128. Any other preimage in the MIP that carries a
   `v1` `pk` or `R` element (sections 8 to 10 were not evidenced here)
   carries the same 64-byte width.
3. **Section 4.3, identity table, `v1` row.** Width 161, not 129 (the `pk`
   element is `x || y`). Add: "The recipe does not reject the JubJub identity
   `(0, 1)`, which has coordinates and yields a well-formed `grant_id`; the
   rejection is section 3.3's `[8]pk != O` guard, which any implementation
   lifting the derivation on its own MUST also apply."
4. **Section 4.4.** After the formula add: "`client_id_bytes` are appended
   raw, with no length prefix and no padding, immediately after the 32-byte
   tag pad." Note that `midnight:account:grant:origin:v1` fills the 32-byte
   pad exactly, so the tag is not extensible without a new version.
5. **Section 2 (notation) or section 4.5, first use of `flag(b)`.** Define
   `flag(b)` as one byte, `0x01` for `true` and `0x00` for `false`, which is
   the compiled encoding of a `Boolean` tuple element. Delete the
   seventeen-element two-stage-hash clause: the arity compiles and hashes as
   the raw concatenation.
6. **Section 6.3, arity sentence.** Replace "The shielded ECDSA preimage has
   thirteen elements and the JubJub one fourteen against an evidenced arity
   of ten; if the operation arguments must be pre-hashed into one
   `args_digest` element, the revised recipe takes a new trailing tag
   version before Proposed" with: "The shielded ECDSA challenge has thirteen
   declared tuple members (the `QualifiedShieldedCoinInfo` is one member),
   sixteen encoded elements, and 568 preimage bytes; the JubJub one fourteen
   members and seventeen encoded elements. Both arities compile and hash as
   the raw concatenation." Drop the `args_digest` fallback for the ECDSA arms
   (the JubJub fourteen-element preimage is stage two but compiles for the
   same reason).
7. **Section 6.3, DST paragraph, and section 3.4 wire-name table.** State
   that `<marker>` is the registry arm's (`k1:`, empty, `r1:`) and is not
   derived from the wire `scheme` name. A registry table keyed by arm with
   both the wire name and the marker removes the inference.
8. **Section 3.1.** Add one sentence after the `envelope_digest` definition:
   "Because `envelope` also enters `grant_id` (section 4.3), an envelope-1
   grantee has a different `grant_id` and therefore a different challenge
   from an envelope-0 grantee with the same key, origin, and slot; the two
   envelopes are not two wrappings of one challenge `h`."
9. **Section 4.1.** Struct-as-Map-value is evidenced; delete the flattened
   layout clause and its separate `spec_version`.
10. **Section 6.7, anchors.** Replace the table with measured values: the
    device twin `withdraw_unshielded_with_k256` k=16, 61,003 rows; the grant
    twins `withdraw_unshielded_with_grant_k256` k=17, 64,352 rows and
    `withdraw_shielded_with_grant_k256` k=17, 91,862 rows; `issue_grant`
    k=17, 78,604; `revoke_grant` k=16, 58,997; `revoke_all_grants` k=16,
    58,771. The envelope is not a circuit-shape parameter (both digests are
    computed on every call), so k does not vary by envelope. Verifier keys
    are 2,745 bytes (k256) and 2,313 (jubjub), not "about 2,950". Two waves
    for the stage-one roster, three for the full 30-circuit roster.
11. **Section 6.2, step 5.** Either state the predicate set as normative and
    the order informative (keeping "widened sum, then cap, then narrow" as
    the one normative order), or list the reference order: object
    commitment, per-call cap, spent commitment, widened sum then narrow,
    recipient pin, then the shielded-only `coin.value <= max_coin_value` and
    `enc_pk == enc_key`. All are asserted before any custody chip executes
    (GR-7); only the abort precedence differs.
12. **Section 7.1 and 7.2, `revoke_all_grants`.** `resetToDefault` is
    evidenced. With the reset, records are absent and a grant twin fails at
    the membership assert ("unknown grant") rather than at the generation
    check; the generation check remains the safety for an implementation that
    omits the reset.
13. **Section 3.4 (or Testing item 5), SIG-4 implementation note.** Some
    verifier stacks enforce low-S (RustCrypto `k256` among them) and refuse
    the high-S twin as presented; a verifier MUST normalise `s` to the low
    form before verifying to meet "both `s` forms MUST verify".
14. **Section 5.1, unit of `expires_at`.** Still unpinned on the node (E3);
    the local simulator takes seconds. Not a correction yet, a flag.

Everything else in sections 3.4, 4.3 to 4.5, 6.1, and 6.3 reproduces from
the recipe text alone: `k1` `grant_id` 162 bytes with `envelope` and `slot`
as single bytes; `object_commit` 145, `spent_commit` 80, `rp_commit` 96;
`scope_digest` 277 with the flags as single bytes; the unshielded grant
challenge 256 and the shielded 568 (the qualified coin flattened as nonce,
color, `u128(value)`, `u64(mt_index)`); the three lifecycle challenges 200,
168, 136; `envelope_digest` 32 and 59 including the 27-byte connector
prefix; and the unconditional per-twin DST rule (SHA-256 of the tag
zero-padded to 64 bytes).

15. 3.2 and 6.2 step 1: the k1 grant seam enforces the envelope-1 read-only restriction in-circuit (`envelope == 0` asserted first in `authenticate_grant_with_k256`, message "envelope not admitted for a spend grant"), rather than delegating it to the authoriser; Testing item 2 gains the "envelope-1 withdraw refused" row. Review finding F1, applied after the measured build (recompiled; the assert does not change k).

## 9. Recipe deviations in the implementation (recorded, not corrections)

- Chip naming and step grouping: `authenticate_grant_with_k256` (steps 1
  to 3, returns `[id, g]`), `check_spend_scope` (steps 4 and 5, arm-agnostic
  and shared by every future arm), `check_shielded_grant_bounds` (the two
  shielded-only step-5 predicates, a fourth helper chip), and
  `settle_grant_with_k256` (steps 6 and 7: verification then write-back).
  Verification sits in the settle chip because the challenge needs
  `g.nonce` and `g.issued_at` from the lookup and is computed by the twin
  between the chips.
- `revoke_all_grants` performs the optional `grants.resetToDefault()`.
- Issue rule 7 (read-only grants carry all-zero object fields) is asserted;
  the design brief's sketch omitted it.
- The k256 twins take the grant authorising material in the MIP's 6.1
  order; there is no nonce argument.
- `signer-rs` `derive_grant` on the jubjub arm computes the identity over
  the point and over its wire form and refuses to answer if they disagree.

## 10. What stage two must still do

Contract:
- jubjub grantee arm: `authenticate_grant_with_jubjub` (cofactor-clearing
  guard), `settle_grant_with_jubjub` (Schnorr with the grinding rule), the
  three `challenge_*_with_grant_jubjub` pure circuits (with `sig_r` and
  `grind_nonce`, fourteen members on the shielded ones; `sig_r` and `pk`
  each 64 bytes), and the three twins;
- the remaining k256 twin `withdraw_shielded_to_contract_with_grant_k256`
  and its challenge (recipient kind 3, over `do_withdraw_shielded_to_contract`,
  with the same change-entry append);
- lifecycle on the jubjub device arm: `issue_grant_with_jubjub`,
  `revoke_grant_with_jubjub`, `revoke_all_grants_with_jubjub` and their
  three challenges in `midnight:account:auth:v1:*`;
- decide whether the shielded-only checks move into the shared chip to match
  the MIP's step-5 order exactly (or amend the MIP per section 8 item 11).

Client and suites:
- `src/wallet/signer.ts`: grant challenge builders and a `Grantee` signer
  for both arms; `src/wallet/account.ts`: issue, revoke, revoke-all, and the
  grant-twin call paths; `wave-deploy.ts`: the `spec_version = 2` roster
  (wave 2 carries the jubjub arm plus the grant circuits; three waves at
  30 circuits); README cost table and the grant rows of the conformance
  map (README is untouched in this stage);
- move `local-exec.ts` into a suite (the local simulator covers the
  unshielded rejection matrix without a node, which is new for this
  repository's suites);
- `signer-rs`: the jubjub grantee signing half (`sign_grant` with
  `arm = "jubjub"`, grinding included) and the shielded twin's on-node
  cross-implementation case;
- Testing item 5's off-chain constructions (`request_digest`,
  `signin_digest`, the `read_pk` derivation, `GrantViewSeal`) once sections
  8 to 10 settle; they have no compiled circuit in this contract.

Node runs: Testing items 1, 2 (shielded items, `max_coin_value`, stale
`enc_pk`), 3, 6 (the wave deploy with the grant keys and authority
retirement after the last wave), 9, 10 (the same-transaction change append,
which only a node can exercise), 11; E3 to pin the block-time unit of
`kernel.blockTimeLessThan` on the ledger-9 localnet, which this stage did
not start or touch.
