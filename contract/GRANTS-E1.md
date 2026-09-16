# E1: scoped grants on the reference contract, `spec_version = 2`

Worktree `arc-passport-k1-arm`, branch `nicolasdp/grants-seam-e1`. Stage one and
stage two of the contract experiment; the on-node conformance run that consumes
them is reported separately in `GRANTS-E2.md`.

**Stage one.** Scope: cells and structs, the pure derivations, the k256
grantee seam and two of its twins (unshielded, shielded), the three lifecycle
circuits on the
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

**Stage two.** Scope: the jubjub grantee seam and its three twins, the
remaining k256 twin `withdraw_shielded_to_contract_with_grant_k256`, the three
lifecycle circuits on the jubjub device arm, the client surface for both
grantee arms, the jubjub half of the Rust signer, an off-node suite over both
arms, and the full key-generating compile that measures the thirty-circuit
roster. Same toolchain. Files changed, all under `contract/`:

- `contracts/account.compact` (+485 lines against 6 comment lines removed, so
  479 net, 2,405 lines in total: 14 new exports and 2 internal chips),
  `contracts/managed/account/`
  regenerated (gitignored, 30 non-pure circuits);
- `src/wallet/signer.ts` (+482: grant challenge builders, `K256Grantee` and
  `JubjubGrantee`), `src/wallet/account.ts` (+261: issue, revoke, revoke-all,
  and the six grant-twin call paths), `src/wallet/contract.ts` (+4, a type
  re-export), `src/wallet/wave-deploy.ts` (the 30-circuit roster and a wave
  planner driven by a verifier-byte budget);
- `src/tests/grants-offline.ts` (new, 1,026 lines, 121 checks over both arms),
  `src/tests/unit-offline.ts` (+389), `src/tests/crossimpl-offline.ts` (+223),
  `src/tests/vectors/grants-e1.json` (27 vectors to 34, two pinned signatures
  to three, `preimage_widths` added);
- `signer-rs/src/grants.rs` and `signer-rs/src/main.rs` (the jubjub grantee
  and jubjub lifecycle halves; `cargo test` 36 passed, 0 failed; `cargo clippy
  --all-targets` clean).

No existing exported circuit changed ABI or behaviour in stage two either: the
55 pre-existing exported signatures were compared on their full parameter block
and return type, and none changed or was removed. Stage two compiled on the
first pass as stage one did, and the constructs it exercised first are:
destructuring `[ShieldedCoinInfo, Maybe<ShieldedCoinInfo>]` from a custody chip
and returning the pair as a tuple literal; re-disclosing `change.is_some` in a
statement-level `if`; a 14-member `persistentHash` tuple carrying two
`JubjubPoint` members and a `QualifiedShieldedCoinInfo`; and
`(challenge as Field) as JubjubScalar` inside `ecMul` in a chip that is not the
device seam.

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

Stage two adds `npm run -s test:grants-offline` (121 checks over both arms,
stable across five consecutive runs), takes `cargo test` to 36 passed and 0
failed, and grows `test:unit` and `test:crossimpl-offline` as section 6
records. `npx tsc --noEmit` stays clean.

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

Stage two promoted that harness into `src/tests/grants-offline.ts` and ran the
whole scenario twice, once per arm: 121 checks, 50 per arm plus 10 arm-specific
negatives, 4 existence checks on the twins that cannot execute off-node, and 7
client-side issue rules. Two carried-forward expectations changed. The k256
wrong-envelope item now refuses with `envelope not admitted for a spend grant`
rather than `unknown grant`, because the envelope assert moved to the head of
the chip (section 8 item 15). And a jubjub grant authorisation that does not
match its call is refused either by the challenge cast's range check or by
`invalid grant signature`, so those items admit either needle (section 8 item
17). New off-node evidence: the JubJub identity `(0, 1)` is refused by the
cofactor-clearing guard with `grantee key has small order`; the order-2 point
`(0, q - 1)` never reaches the guard, because `ecMul` and `ecAdd` abort with
`unreachable` on it (section 8 item 18); the k256 point at infinity is refused
at the shared device guard; an envelope-1 grantee derives a different
`grant_id`, issues, and is refused at the twin; and a record issued for a
grantee on one arm is invisible to the other arm's twin, which sees
`unknown grant`. The four shielded twins still cannot execute off-node, so the
suite asserts instead that each exists on the compiled module with the argument
count the MIP section 6.1 trailer implies, 15 on the k256 arm and 16 on jubjub,
read from the generated wrapper's own arity error.

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
for key bytes. The table below is the thirty-circuit roster as measured after
stage two, which is the final state of the contract. The seven circuits marked
new are stage two's; the five marked new in stage one are unmarked here and
carry their stage-one figures, except for the two k256 grant twins reconciled
below; every other row is unchanged from the pre-grant contract byte for byte.

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
| `issue_grant_with_jubjub` (new) | 16 | 52,227 | 98,579,365 | 2,313 |
| `revoke_grant_with_jubjub` (new) | 15 | 26,871 | 49,292,097 | 2,313 |
| `revoke_all_grants_with_jubjub` (new) | 15 | 26,645 | 49,290,943 | 2,313 |
| `withdraw_unshielded_with_grant_jubjub` (new) | 16 | 38,514 | 98,577,378 | 2,313 |
| `withdraw_shielded_with_grant_jubjub` (new) | 17 | 66,014 | 197,145,788 | 2,313 |
| `withdraw_shielded_to_contract_with_grant_jubjub` (new) | 17 | 71,717 | 197,146,307 | 2,313 |
| `issue_grant_with_k256` | 17 | 78,604 | 234,898,194 | 2,745 |
| `revoke_grant_with_k256` | 16 | 58,997 | 117,453,434 | 2,745 |
| `revoke_all_grants_with_k256` | 16 | 58,771 | 117,452,209 | 2,745 |
| `withdraw_unshielded_with_grant_k256` | 17 | 64,355 | 234,896,051 | 2,745 |
| `withdraw_shielded_with_grant_k256` | 17 | 91,865 | 234,898,319 | 2,745 |
| `withdraw_shielded_to_contract_with_grant_k256` (new) | 17 | 97,568 | 234,898,837 | 2,745 |

### The two re-measured k256 grant twins

`withdraw_unshielded_with_grant_k256` and `withdraw_shielded_with_grant_k256`
measure three rows higher than in stage one: 64,355 against 64,352 and 91,865
against 91,862, with the prover keys 38 and 37 bytes larger. The cause is the
review finding recorded as section 8 item 15: the `envelope == 0` assert moved
to the head of `authenticate_grant_with_k256` after the stage-one measurement
sweep. Item 15 states that the assert does not change k, and that remains
exactly true: k is 17 before and after on both twins. What it should have said
is that the assert costs three rows on each twin and leaves k untouched. The
three lifecycle circuits on that arm are unchanged, because the assert is in the
grantee chip only.

Observations, stage one's carried forward and stage two's added:

- Verifier key size depends on the circuit's shape, not on k: every k256
  circuit is 2,745 bytes at k=14, 16, or 17; every jubjub circuit 2,313;
  `deposit_shielded` 2,121; `deposit_unshielded` 1,353. Thirty circuits carry
  74,286 verifier bytes.
- k is not a pure function of the reported rows: `append_inbox_with_k256`
  (64,924 rows) and `remove_device_with_k256` (65,404 rows) fit k=16 while the
  k256 unshielded grant twin (64,355 rows) needs k=17. Some other resource
  (a fixed or lookup column, or the public-input count) drives the k choice;
  the MIP should quote k and rows as measured and not predict one from the
  other.
- The prover key is not a function of k alone either: at k=17 a jubjub circuit
  measures 197 MB and a k256 circuit 235 MB, and at k=16 the same split is
  99 MB against 117 MB.
- The grant seam's row cost over the corresponding device twin is constant
  within an arm and shape but differs across them: on the k256 arm the two
  shielded twins each cost 17,278 rows more than their device twins (91,865
  against 74,587, and 97,568 against 80,290) and the unshielded twin 3,352
  more (64,355 against 61,003); on the jubjub arm the two shielded twins each
  cost 15,959 more (66,014 against 50,055, and 71,717 against 55,758) and the
  unshielded twin 9,637 more (38,514 against 28,877). The shielded figures
  carry the inbox insert for the change entry, which no device twin performs.
- The seam pushes four of the six grant twins up one k: the k256 unshielded
  twin to 17, the jubjub unshielded twin to 16, and both jubjub shielded twins
  to 17. The k256 shielded twins stay at their device twins' k=17.
- Lifecycle is much cheaper on the normative arm: `issue_grant_with_jubjub`
  costs 52,227 rows at k=16 against `issue_grant_with_k256` at 78,604 and
  k=17, and the two jubjub revocation circuits cost about 26,800 rows at k=15
  against about 58,900 at k=16 on the k256 arm. Issuance is the most expensive
  lifecycle circuit on both arms (the 17-element scope digest, seven issue
  rules, three commitments, and the whole record write).
- The seven stage-two prover keys add about 925 MB on disk, on top of the
  roughly 940 MB the five stage-one keys added.

### Deploy budget (MIP 6.7, Testing 6)

The thirty impure circuits carry 74,286 verifier bytes:

| Group | Circuits | Verifier bytes |
|---|---|---|
| Deposits | 2 | 3,474 |
| Device arm, jubjub | 8 | 18,504 |
| Device arm, k256 | 8 | 21,960 |
| Grant arm, jubjub | 6 | 13,878 |
| Grant arm, k256 | 6 | 16,470 |
| Total | 30 | 74,286 |

The README records the 18-key deploy pricing at 53,076 `bytes_written` against
the 50,000 per-block limit, so the deploy overhead beyond verifier bytes is
about 9,138 bytes, and a one-transaction deploy of the thirty-circuit roster is
refused up front. Waves are mandatory, and `src/wallet/wave-deploy.ts` packs
them greedily against a per-update verifier-byte budget, with wave 1 the deploy
itself (the two deposits and the initial device's arm, 10 operations) and every
later wave one hand-built `MaintenanceUpdate`.

At the shipped default budget of 40,000 verifier bytes the planner produced
**three waves** whichever arm was deployed first: 25,434 then 39,600 then 9,252
with k256 first, and 21,978 then 38,583 then 13,725 with jubjub first. That is
the count stage one predicted and the count MIP correction 10 records, but the
plan behind it is one the chain refuses: the 16-key second wave does not fit a
block.

**The per-update ceiling is now measured** and is no longer an observation to
reproduce. `npm run probe:wave-ceiling` (`evidence/wave-ceiling.json`, E2)
bisects it by giving a throwaway wave-1 account one hand-built
`MaintenanceUpdate` apiece. An update of 12 verifier keys (29,484 verifier
bytes) is accepted and lands; 13 keys (32,229), 14 keys (34,974), and 16 keys
(39,600) are each refused by node 2.1.0 at submission with the same verbatim
line, `1010: Invalid Transaction: Transaction would exhaust the block limits`.
The ceiling therefore sits in **(29,484, 32,229] verifier bytes per maintenance
update**, closed to one key. The refusal is the node's alone: the client
priced every refused payload without complaint, `normalizeFullness` never
threw, and `fees` returned a figure. The client-side `exceeded block limit in
transaction fee computation` bounds the all-operations DEPLOY instead, before a
transaction exists, so the two refusals are different mechanisms at different
points and nothing client-side warns an implementer about an over-large update.

`VERIFIER_BYTE_BUDGET` therefore defaults to **25,000** verifier bytes, the
largest accepted payload less a margin of 4,484 bytes, about 15 per cent,
rounded down; the margin covers the Dust spend the wallet adds when it balances
the update, block fullness at submission, and the per-block fee-price
adjustment. At that default the roster lands in **three waves**, measured end
to end on the localnet:

| Wave | Kind | Circuits | Verifier bytes | Authority counter before | Result |
|---|---|---|---|---|---|
| 1 | deploy | 10 | 25,434 | (deploy) | SUCCESS at block 5,888 |
| 2 | maintenance | 10 | 23,994 | 0 | SUCCESS at block 5,891 |
| 3 | maintenance | 10 | 24,858 | 1 | SUCCESS at block 5,894, retires the authority |

After the last wave the account reads `committee = 0, threshold = 1,
counter = 2`, with 30 operations and `spec_version = 2`. The counter advances by
exactly one per update, and the retirement lands in the same update as the last
ten inserts. An earlier run at an interim budget of 18,504 verifier bytes,
which predates the measurement, took four waves (25,434, then 18,504, 16,470,
and 13,878) and is recorded in `GRANTS-E2.md`.

Consequences. **MIP 6.7's three-wave figure is restored, and the correction
this section previously carried against it is withdrawn.** Three waves is the
right count; what the section gets wrong is the packing that reaches it, since
its own arithmetic implies a 16-key update of 39,600 verifier bytes that the
node refuses, whereas the measured budget reaches three waves as 10 and 10. A
budget under the ceiling does not by itself fix the count: the planner packs
greedily over one key order, so 18,504, 20,000, and 24,000 all cost four waves
while 25,000 costs three. The MIP's "about 2,950 bytes of verifier key each"
remains an over-estimate; measured 2,745 (k256) and 2,313 (jubjub).

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

### Stage two: the v1 family, 34 vectors, and three pinned signatures

Stage two extends the same three-way agreement to the jubjub grantee arm and to
the remaining k256 twin. The vector file now publishes **34 vectors** and
**three pinned signatures** (the two stage-one k1 signatures under `sk = 1`, at
envelopes 0 and 1, each publishing both S forms, plus one deterministic v1
signature under `sk = 1` with the nonce scalar fixed at 2, whose grinding nonce
lands at 17), together with `fixtures.sig_r_v1` and a
`preimage_widths` table. The Rust crate reads the file and reproduces every
kind it implements from the arguments alone, counting and reporting an
unimplemented kind on stderr rather than panicking, so a later stage can extend
the file before the Rust side catches up.

Measured preimage widths of the compiled encoding, not predicted:

| Recipe | k1 | v1 |
|---|---|---|
| `withdraw_unshielded` grant challenge | 256 | 328 |
| `withdraw_shielded` grant challenge | 568 | 640 |
| `withdraw_shielded_to_contract` grant challenge | 568 | 640 |
| `issue_grant` | 200 | 272 |
| `revoke_grant` | 168 | 240 |
| `revoke_all_grants` | 136 | 208 |

Every v1 recipe is its k1 twin plus 72 bytes: the 64-byte `sig_r` point element
and the 8-byte grinding nonce. A point element counts as one member and two
atoms, and the qualified coin as one member and four atoms, so the jubjub
shielded challenges have 14 members and 19 atoms and the unshielded one 11
members and 13 atoms.

`crossimpl-offline.ts` gains `[jubjub/grant]` and `[k256/grant/to_contract]`,
and `unit-offline.ts` gains the k1 `withdraw_shielded_to_contract` challenge,
the three v1 grant challenges, the three v1 lifecycle challenges, the pinned
width table, a disjointness check over the v1 family, and a `JubjubGrantee`
signature round trip with four negatives.

One protocol consequence of the v1 challenge shape is visible only in the
signer's wire protocol. On the k256 arm an authoriser can hand a device three
bare lifecycle digests, so the Rust `derive_grant` response carries
`lifecycle_challenges`. On the jubjub arm a challenge commits to its own nonce
point and grinding nonce, so it cannot exist before it is signed: the response
carries `lifecycle_signatures` instead, one signed triple per lifecycle circuit,
each with a fresh nonce. Those values are not reproducible fixtures, so a suite
verifies them rather than pinning them, and two `sign_grant` calls with
identical arguments produce different challenges by construction.

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
   members, nineteen encoded elements, and 640 preimage bytes. Both arities
   compile and hash as the raw concatenation." Drop the `args_digest` fallback
   for the ECDSA arms. (The JubJub element count is the stage-two measurement;
   the figure of seventeen this item first carried was read off the recipe
   before the arm compiled, and counted the two point elements as one atom
   each.)
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
    for the stage-one roster, three for the full 30-circuit roster; the
    three-wave figure is confirmed by measurement (correction 19), though not
    by the packing the section's arithmetic implies.
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

15. 3.2 and 6.2 step 1: the k1 grant seam enforces the envelope-1 read-only restriction in-circuit (`envelope == 0` asserted first in `authenticate_grant_with_k256`, message "envelope not admitted for a spend grant"), rather than delegating it to the authoriser; Testing item 2 gains the "envelope-1 withdraw refused" row. Review finding F1, applied after the measured build (recompiled; the assert does not change k, and the stage-two sweep prices it at three rows on each of the two k256 grant twins, section 5).

16. **Section 6.3, preimage widths.** Add the measured width table of
    section 6 above. The 640-byte figure the section predicts for the v1
    shielded challenge is confirmed by the compiled encoding and needs no
    correction; the other five v1 figures are new (unshielded 328, `issue_grant`
    272, `revoke_grant` 240, `revoke_all_grants` 208, and the v1
    `withdraw_shielded_to_contract` challenge 640 as its shielded sibling), as
    is the k1 `withdraw_shielded_to_contract` figure of 568. State the rule that
    makes them predictable: a v1 recipe is its k1 twin plus 72 bytes, the
    64-byte `sig_r` element and the 8-byte grinding nonce.

17. **Section 6.4, and Testing item 2's replay row.** A jubjub grant
    authorisation that does not match the call it is presented with produces one
    of two refusals, and a conforming client must expect both.
    `settle_grant_with_jubjub` casts the challenge with `challenge as Field`
    before evaluating the Schnorr equation, and a challenge the signer did not
    grind is below the field modulus only about 45 per cent of the time, so
    about 55 per cent of such calls abort at the cast's range check and the rest
    at `invalid grant signature`. Which one fires is a property of the challenge
    bytes and not of the seam, so a conformance suite MUST admit either needle
    on this arm. This is the same behaviour the device arm already shows (the
    reference implementation records it as an observation on MIP-0013 section
    5.1), and it does not arise on the ECDSA arms, where the challenge is a
    message and is never cast.

18. **Section 3.3, the off-curve open item.** The open item is not resolved
    off-node and cannot be, through this runtime. The JubJub identity `(0, 1)`
    reaches the seam and is refused by the cofactor-clearing guard with
    `grantee key has small order`, as correction 3 states. A non-identity
    small-order point does not reach the guard at all: the order-2 point
    `(0, q - 1)` is on the curve and hashes to a well-formed `grant_id`, but the
    runtime's own curve built-ins refuse to operate on a point outside the
    prime-order subgroup, and `ecMul` and `ecAdd` both abort with `unreachable`.
    The in-circuit guard is therefore reachable only for the identity, and the
    rejection of every other small-order point is the runtime's rather than the
    contract's. An implementation cannot present such a point through this
    runtime at all, which is worth stating in 3.3 alongside the requirement,
    because a conformance suite can assert the abort but not the message. The
    k256 point at infinity behaves as specified: a record can be issued at it,
    and the twin refuses at the shared guard with `device key is the point at
    infinity`.

19. **Section 6.7, anchors (supersedes correction 10's table).** The whole
    thirty-circuit roster is now measured, both arms and all six grant twins:
    the table of section 5 above, with the k256 grant twins re-measured after
    the envelope assert at 64,355 and 91,865 rows. The jubjub grant twins and
    the remaining k256 twin are no longer expectations. The section's
    row-and-k commentary holds as written for the k256 arm and needs the jubjub
    figures added: the grant seam costs 9,637 rows over the device twin on the
    jubjub unshielded twin and 15,959 on each jubjub shielded twin, against
    3,352 and 17,278 on the k256 arm, so the seam's cost is not a single
    constant across arms. Row counts: the section carries 64,352 and 91,862
    for the two k256 grant twins, which are the figures from before the
    envelope assert; replace them with the measured 64,355 and 91,865, three
    rows more on each, which is the assert itself
    (`.planning/grants-e2/measurements.md`). Deploy budget: **the four-wave
    claim this correction previously made is withdrawn.** The per-update
    ceiling has since been measured at (29,484, 32,229] verifier bytes, and at
    the resulting 25,000-byte default the roster lands in three waves, which is
    the section's own figure. What the section still gets wrong is the packing:
    its arithmetic implies a 16-key update of 39,600 verifier bytes that the
    node refuses, and it should state the per-update ceiling as network-defined
    and bounded by measurement, and note that the deploy is refused
    client-side by the fee computation while an over-large maintenance update
    is refused by the node at admission with nothing client-side objecting
    first.

The three below were produced by the on-node matrix sections of `GRANTS-E2.md`
(S11 to S14) rather than by this experiment, and are numbered here so that the
register stays in one place.

20. **Section 3.3, key validation.** The issuance half of "performed by the
    authoriser at issuance and by the seam at every use" cannot exist
    in-circuit: `issue_grant_with_<arm>` takes `grant_id` and never the key, so
    every weak, off-curve, invalid-curve, and foreign key was given a live,
    well-formed record on node without complaint. State the authoriser's checks
    as an obligation on the issuing client and say plainly that the contract
    cannot perform them. Record what each seam then does: `k1` rejects the
    point at infinity in both encodings and nothing else, so off-curve,
    invalid-curve, and other-curve keys reach the signature check and are
    refused there; `v1` rejects the identity at the cofactor guard, and the
    runtime traps on any other point outside the prime-order subgroup before
    the guard runs, so the operator sees `ContractRuntimeError` rather than a
    named assert. Add the GR-2 row the text leaves to be inferred: a key
    enrolled as a device of the account can be issued a grant and can spend
    under the grant seam, so GR-2 is an authoriser obligation and is not
    enforceable in-circuit.
21. **Section 7.4, composition.** Two calls on one contract in one transaction
    work, and the section should carry the three mechanics a composing client
    meets: the second call must be built against the state the first produces;
    its Zswap offer must travel with its intent, since an `Intent` carries
    contract actions and unshielded offers only, and a guaranteed offer merges
    while a fallible one is pinned to its own segment; and which transcript
    section a call's coins land in is not stable between runs. Name the three
    refusals: `Transcript(Execution(ReadMismatch …))`,
    `Malformed(EffectsCheck(NullifiersNeqClaimedNullifiers))`, and
    `Malformed(Zswap(InvalidProof))`. Correct the reordering claim while there:
    each signature stays valid over its own challenge, and what fails is the
    transcript, refused at admission on a read mismatch.
22. **Section 5.1 and 6.4, the usable expiry horizon, and Testing item 10's
    same-coin parenthetical.** The horizon is one block interval plus the
    network tolerance PLUS the grantee's own proving time, measured at 14.5 s
    from build to refusal for a k = 17 shielded twin, so a client that reads
    only E3's 8.2 to 10.2 s will offer grants that cannot be exercised. In the
    same pass, item 10's "(proving failure, no mis-spend)" on the same-coin row
    names the wrong component: the loser is refused by the NODE as a double
    spend, and the identical call rebuilt against the post-spend state still
    proves, because proving consults the commitment tree and not the nullifier
    set.

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

## 10. What remains

Every contract, client, and suite item stage one listed for stage two landed:
the jubjub grantee seam and its three twins, the remaining k256 twin, the three
jubjub lifecycle circuits, the signer and account surfaces for both grantee
arms, the thirty-circuit wave roster, the jubjub half of the Rust signer, and
the off-node harness promoted into `src/tests/grants-offline.ts`. The step-5
ordering question closed in favour of the MIP amendment of section 8 item 11:
the predicate set is normative, the order informative, the widened sum is tested
before the narrowing cast, and every predicate is asserted before any custody
chip runs. The on-node run is `GRANTS-E2.md`.

What is still owed, by the experiment that owes it:

- **E2 leaves one group PARTIAL.** The deploy group is PARTIAL only for the
  `spec_version = 1` control below; every other group is PASS. The
  owner-liveness leg that was PARTIAL in E2's first run is closed: the
  qualified coin's index is now resolved by prove-only trials before the
  grantee signs, so the call that lands across the permissionless deposit
  carries the signature made before it.
- **The `spec_version = 1` control of E6** (Testing item 6). Showing that a
  version-1 account cannot gain grants needs a compiled pre-grants build of the
  contract, which this tree does not carry: `contracts/account.compact` is the
  version-2 source and the managed artefacts are its thirty-circuit roster.
- ~~**The per-update verifier-byte ceiling.**~~ Measured. The bisection
  (`npm run probe:wave-ceiling`, `evidence/wave-ceiling.json`) closes the limit
  to one key at (29,484, 32,229] verifier bytes on node 2.1.0, and the client's
  default budget is set from it at 25,000. Nothing further is owed here.
- **E4**, the redirect attack suite (Testing item 4). It has no compiled circuit
  in this contract and follows sections 9 and 10 of the MIP.
- **E5**, the off-chain constructions of Testing item 5: `request_digest`,
  `signin_digest`, the `read_pk` derivation, `GrantViewSeal`, the negative key
  vectors, and the r1 vectors. The in-circuit half is green three ways over 34
  vectors and three pinned signatures.
- **E7**, read handover (Testing item 7): the seal, the inbox walk with
  commitment verification, rotate-before-share, re-seal, and the quarantine of
  a forged entry.
- **E8**, agent and self grantees (Testing item 8): a jubjub grant to the
  reference signer in the non-browser binding, and a `self:` grant issued with
  no authoriser page.
- **E11**, the epoch-bump half of kill totality (Testing item 11). The
  `revoke_all_grants` half is green on node; no circuit bumps `device_epoch`
  until the recovery seam lands, so the epoch half waits on the recovery MIP.
- **The r1 arm** (Testing item 12), once the secp256r1 surface ships, and the
  cryptographer review the MIP asks for on the transitive binding of the
  openings through `grant_id`.
