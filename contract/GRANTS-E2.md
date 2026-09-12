# GRANTS-E2: the scoped-grants conformance run on node

Evidence for the scoped-grants MIP's Testing section, items 1, 2, 3, 6, 9, 10,
and 11, against a live ledger-9 localnet rather than the circuit simulator. The
question: does the grant seam of `spec_version = 2` behave on node as the
specification and the off-node suites say it does, what does a grant call cost
to prove, and which of the Testing items can be closed.

The first run of this experiment closed items 1, 3, 6, 10, and 11 in part and
left four things open: the key rows of item 2, the expiry rows of item 1 on the
grant twins, composition (item 9), and the concurrency legs of item 10. Those
are sections S11 to S14 below. It also left one number as prose rather than as
a measurement, the per-update verifier-byte ceiling, which a bisection probe
now closes to one key. Those five are what this revision adds.

**Verdict in one paragraph.** The roster deploys, the seam works on both
grantee arms, and eleven of the twelve evidence groups are PASS; the twelfth,
the deploy, is PARTIAL for one reason only, that Testing item 6's
`spec_version = 1` control needs a pre-grants build this tree does not carry. A
grant call advances the record `nonce` and `spent_commit`, advances `round` by
one, leaves `auth_nonce`, the device set, and `enc_key` untouched, and appends
the change entry inside the same transaction. Twelve rejection rows abort at
build time with the message the specification names, no transaction, and a
byte-identical ledger snapshot either side. Nine grantee-key rows, on both
arms, are refused with no transaction, and the tenth, a device key issued as a
grantee, is not refused at all, which is GR-2 measured rather than assumed.
The expiry rows are green on the grant twins themselves, with the transaction
transcripts read back to show that a `expires_at = 0` record records no block
time read and a forward-dated one records exactly one. Revoke plus issue over
one id, batch issuance, and two grant calls under one grant now each ride ONE
transaction, and the reordered pair is refused at admission. The owner and a
grantee racing one coin end with one spend and no mis-spend, and Testing item
3's leg (b) now lands with the signature made BEFORE the intervening deposit,
which the first run could not show. The change coin is precomputable before
proving: ten of ten predictions matched the coin the circuit returned. The
per-update verifier-byte ceiling is measured rather than reported, bracketed to
one key at (29,484, 32,229], and the budget the client ships is set from it, at
which the roster deploys in three waves. Five
defects were found and fixed along the way: two in this package's client, two
in the suite's own bookkeeping, and one in how a composing client must use the
SDK.

## Setup

| Item | Value |
|---|---|
| Suite | `src/tests/grants-conformance.ts`, `npm run test:grants-conformance`; `GRANTS_E2_GROUPS=<group>` truncates the scenario after a group (it is one sequence, so a subset is a prefix) |
| Evidence | `evidence/grants-e2-deploy-*.json`, `-issue-`, `-spend-`, `-rejections-`, `-liveness-`, `-direct-`, `-kill-`, `-keys-`, `-expiry-`, `-composition-`, `-concurrency-`, `-proving-` (twelve files) |
| Stack | midnight-node 2.1.0-2e92c4ae642c, indexer-standalone 4.4.0-rc.2, proof-server 9.0.0-rc.6, on the chain that was already running (the suite deploys fresh accounts, not a fresh chain) |
| Client | the same pinned line as the rest of this package: compactc 0.33.0-rc.2 with `--feature-zkir-v3`, compact-js 2.5.5-rc.6, midnight-js 5.0.0-beta.4 |
| Contract | `contracts/account.compact` at `spec_version = 2`, 30 non-pure circuits, both device arms and both grantee arms |
| Account A | `f2c6e86a60e6f7e59858f567da2a644fbe4d5d71814c13b5e759663feb85a982`, k256-born, a jubjub device enrolled cross-arm |
| Account B | `7ae121ead24b1b4ca4a257c5eeaa235bd77807752cd50e62900d75d04ffbf9f5`, the payee of the composed direct transfer |
| Wave budget | `VERIFIER_BYTE_BUDGET = 25000`, the measured default (see the wave table and the ceiling measurement below) |
| Run | one run of the whole scenario, 2026/09/11, every group from one account and one chain; all twelve evidence files are from it |
| Run totals | 2,652,536 ms of wall clock; 81 successful proofs totalling 633,868 ms, 24 per cent of it; 12 failed proof attempts adding a further 184,175 ms, so all proving is 818,043 ms, 31 per cent |

The localnet carries the limitation this package records: a contract call
paired with an **unshielded** offer prices above the node's
`OutsideTimeToDismiss` budget and is mempool-rejected, so `deposit_unshielded`
and every unshielded funded flow are impossible here. The consequence for the
matrix is that every spend in this run is a shielded one. The unshielded grant
twins (`withdraw_unshielded_with_grant_k256` and
`withdraw_unshielded_with_grant_jubjub`) are exercised only off-node, where the
local simulator executes `receiveUnshielded` and `sendUnshielded` in full:
`src/tests/grants-offline.ts`, 121 checks over both arms, carries their whole
rejection matrix. The two coverage halves are complementary rather than
overlapping, and neither arm's unshielded twin has been proved or submitted to
a node by any run.

## The scenarios

| # | Scenario | What it established | Exercised |
|---|---|---|---|
| S0 | Wave deploy of a k256-born account, then the cross-arm enrolment of a jubjub device | The thirty-circuit roster lands in three waves at the measured 25,000-byte budget, each maintenance update at the authority counter read from chain, and the last update retires the authority; a k256 device enrols a jubjub device (`auth_nonce` 0 to 1, `device_count` 1 to 2) | Testing 6 less the `spec_version = 1` control; AUTH-5, AUTH-9 |
| S1 | The cross-arm enrolment itself | Both device arms live on one account, which is what lets S2 issue from either arm | AUTH-9 |
| S2 | Issue grants A to E, L, and G across both device arms and both grantee arms | Every record carries `epoch = device_epoch`, `gen = grant_generation`, `nonce = 0`, `active`, and `issued_at` equal to `auth_nonce` **after** the device seam advanced it (A 2, B 3, C 4, D 5, E 6, L 7, G 8; later F 12 and the re-issued A 14); each issue advanced `auth_nonce` by exactly one and `round` by one | Testing 1 (first half); GR-8, GR-12, GR-13 |
| S3 | Mint 1,000 of the working color and deposit it under a sealed inbox entry | The account holds shielded value a grantee can spend, sealed to `enc_key` | INV-4 |
| S4 | Grant A, the jubjub grantee spends 200 | Record `nonce` 1, `spent_commit == derive_grant_spent_commit(salt, 200)`, `round` plus one, `auth_nonce` and `device_count` untouched, `inbox_count` plus one in the SAME transaction, and the appended entry decrypts to the change coin the circuit returned | Testing 1's spend leg on the jubjub grantee arm and Testing 10's same-transaction change append, not either item entire; GR-1, GR-5, GR-12, GR-13, INV-4 |
| S5 | Grant A spends 100 again, then grant B spends 100 on the k256 grantee arm | Consecutive nonces 1 and 2 under one grant, cumulative 300; the k256 grantee arm settles on node | Testing 1's spend leg on the k256 grantee arm, and the consecutive-nonce precondition of Testing 9 rather than Testing 9 itself, which S13 carries; GR-5 |
| S6 | The rejection matrix, twelve rows | Each is a build-time abort with the exact message, no transaction, and no state change | Testing 2; GR-2, GR-3, GR-4, GR-5, GR-6, GR-7, GR-9, GR-12, GR-14 |
| S7 | Owner liveness, two legs | (a) an owner signature pending across a grant call still verifies and lands, because a grant call writes neither `auth_nonce` nor the device set; (b) a permissionless deposit landing between the grantee signing and submitting does not invalidate the grant record, and the call that lands carries the signature made BEFORE the deposit, because the qualified coin's index was resolved by prove-only trials before the grantee signed (`preSignedCallLandedAsSigned`) | Testing 3; GR-5, AUTH-8 |
| S8 | The contract-recipient twin composed with the payee claim | `withdraw_shielded_to_contract_with_grant_k256` on account A and `deposit_shielded` on account B ride one client-composed transaction, on the second candidate index; B's inbox 0 to 1, A's 9 to 10 for the change entry, grant F `nonce` 1, and both the sent and the change coin nonce match the prediction | Testing 10; INV-6 (one hop) |
| S9 | Kill totality | `revoke_all_grants_with_jubjub` bumped `grant_generation` 0 to 1 and cleared the register; grant A's next spend then failed with `unknown grant` and no state change; A re-issued under generation 1 carries `gen 1, nonce 0` and its spend landed | Testing 11's `revoke_all_grants` half only, not the recovery epoch bump; GR-9 |
| S11 | Grantee-key validation on both arms, ten rows | The identity in both encodings the `k256` type admits, an off-curve pair, an invalid-curve twin, each arm's key against the other arm's twin, the JubJub identity, a small-order point, an off-curve JubJub pair, nine rows refused with no transaction and an unmoved ledger, and a device key issued as a grantee, which is not refused at all | Testing 2's key rows; GR-14, GR-4, GR-2; section 3.3 |
| S12 | The expiry rows on the grant twins | `expires_at = 0` and `expires_at = head + 3600` both spend on node with `round` and the record advancing; the transcripts read back through the indexer show the zero record recording NO block-time read and the forward-dated one exactly one; a record expiring inside the admission margin builds on the client and is refused by the node with `Custom error: 104` and no state change | Testing 1's expiry half; GR-7; E3 |
| S13 | Composition, four rows | Revoke plus issue over one grant id, batch issuance of two grants, and two grant calls under one grant with consecutive nonces, each in ONE transaction; the same pair grafted in the opposite segment order refused at admission on a transcript read mismatch | Testing 9; GR-5, GR-11, GR-13 |
| S14 | Concurrency, two legs | The owner and a grantee select the same coin and both build: the owner's lands, the grantee's is refused by the node as a double spend with the grant record untouched, and the same call rebuilt against the post-spend state still PROVES, so the refusal is the ledger's and not the prover's; Testing item 3's leg (b) re-run with the qualified-coin index resolved BEFORE signing, so the call that lands carries the signature made before the intervening deposit | Testing 10; INV-5; Testing 3, AUTH-8 |
| S10 | Proving times | Every proof of the run measured at the proof provider, attributed to the circuit of the call it served; runs last so the table covers S11 to S14 too | MIP 6.7 |

Per-group verdicts: deploy PARTIAL, issue PASS, spend PASS, rejections PASS,
liveness PASS, direct PASS, kill PASS, keys PASS, expiry PASS, composition
PASS, concurrency PASS, proving PASS.

## The wave table as observed

Roster 30 circuits, 74,286 verifier bytes.

**This run, at the measured default of 25,000 verifier bytes per maintenance
update.**

| Wave | Kind | Circuits | Verifier bytes | Authority counter before | Transaction | Result |
|---|---|---|---|---|---|---|
| 1 | deploy | 10 | 25,434 | (deploy) | `419df08d6271332b533ab774f2803b7d317c42dc0aed7ad42b991d05126fc12a` | SUCCESS at block 5,888 |
| 2 | maintenance | 10 | 23,994 | 0 | `7fa79e2eb04ff072a19c8806d1f68e3dd65824cf0d7fa01a82ae6e28167d4383` | SUCCESS at block 5,891 |
| 3 | maintenance | 10 | 24,858 | 1 | `a9c51fe6daf300b44ab66737628c8f45eec5898f94786af8d885b3d295853bd7` | SUCCESS at block 5,894, retires the authority |

The first run of this experiment needed FOUR waves, at an interim budget of
18,504 verifier bytes that predated the measurement below. The roster is
unchanged; only the budget moved. Three waves is also the count MIP section 6.7
predicts, so the measurement restores the section's figure, but by a packing of
10 and 10 rather than the 16 and 4 the section's own arithmetic implies, whose
16-key update the node refuses.

Wave 1 carries the two deposits and the eight k256 device circuits. The
counters were read from chain before each update, so the increment-by-one
assumption holds exactly. After the last wave the account reads
`committee = 0, threshold = 1` at counter 2, with 30 operations and
`spec_version = 2`.

### The per-update ceiling, measured

The first run recorded, as prose and without a transcript, that a 16-key update
of 39,600 verifier bytes is refused. That claim has now been tested by
bisection: `npm run probe:wave-ceiling`, evidence `evidence/wave-ceiling.json`.
Each probe deploys a throwaway wave-1 account, submits ONE maintenance update
of N keys drawn from the twenty wave 1 does not carry, and records the price,
the outcome, and the verbatim refusal. A refused update leaves the authority
counter untouched, so a refusal is retried on the same account; an acceptance
installs keys, so the next probe deploys a fresh one.

| Keys | Verifier bytes | Serialised tx bytes | `blockUsage` | `bytesWritten` | Client fee computation | Node |
|---|---|---|---|---|---|---|
| 16 | 39,600 | 40,208 | 40,135 | 40,312 | priced, no complaint | REFUSED |
| 14 | 34,974 | 35,540 | 35,467 | 35,598 | priced, no complaint | REFUSED |
| 13 | 32,229 | 32,783 | 32,710 | 32,818 | priced, no complaint | REFUSED |
| 12 | 29,484 | 30,031 | 29,958 | 30,043 | priced, no complaint | ACCEPTED, `SucceedEntirely` |

Every refusal is the same verbatim line:

```
1010: Invalid Transaction: Transaction would exhaust the block limits
```

carried by the RPC layer, since the wallet SDK collapses it to
`SubmissionError: Transaction submission error` and the node writes no
rejection line of its own (the probe's `docker logs` capture ran and matched
nothing, recorded as `nodeLogCapture: "empty"` rather than as silence). All
four attempts priced at `readTime` 2,040,000,000 ps and `computeTime`
2,290,658,388 ps, identically, so neither time dimension is anywhere near a
limit and the dimension that moves is `blockUsage` and `bytesWritten` alone.

**The ceiling sits in (29,484, 32,229] verifier bytes per maintenance update,
closed to one key.** That is a far tighter statement than the (18,504, 39,600]
the first run left open.

**Which mechanism bounds an update.** Only the node. The client fee computation
priced every refused payload without complaint: `Transaction.cost` returned,
`LedgerParameters.normalizeFullness` did not throw, and `Transaction.fees`
returned a figure, for payloads the node then refused. The client-side
`exceeded block limit in transaction fee computation` bounds the ALL-OPERATIONS
DEPLOY instead, before a transaction exists. The two refusals are different
mechanisms at different points, and a standard that says "the update must fit a
block" should say which one it means: for a maintenance update, nothing
client-side will tell an implementer it is too big.

**The default is now measured.** `VERIFIER_BYTE_BUDGET` defaults to 25,000
verifier bytes: the largest accepted payload (29,484) less a safety margin of
4,484 bytes, about 15 per cent, rounded down. The margin covers what the
measurement cannot: the Dust spend the wallet adds when it balances the update
(the figures above price the update alone), block fullness at submission, and
the per-block fee-price adjustment. At that default the roster's largest batch
is 24,858 verifier bytes, some two jubjub keys below the ceiling, and the
roster plans as three waves: the deploy, then 10 keys and 10 keys. The
environment override stays.

**A budget under the ceiling does not by itself fix the wave count.** The
planner packs greedily over one key order, so the count moves in steps
(`details.waveCountAtCandidateBudgets`):

| Budget | Waves | Maintenance batches |
|---|---|---|
| 18,504 (the first run's interim figure) | 4 | 8 / 18,504, 6 / 16,470, 6 / 13,878 |
| 20,000 | 4 | 8 / 18,504, 7 / 18,783, 5 / 11,565 |
| 24,000 | 4 | 10 / 23,994, 9 / 22,545, 1 / 2,313 |
| **25,000 (shipped)** | **3** | **10 / 23,994, 10 / 24,858** |
| 26,000 | 3 | 10 / 23,994, 10 / 24,858 |
| 30,000 | 3 | 12 / 29,484, 8 / 19,368 |
| 40,000 (the old default) | 3 | 16 / 39,600, 4 / 9,252 |

The last two rows are listed for completeness and neither is a safe budget: the
30,000 row's first batch is the largest accepted payload with no margin at all,
and the 40,000 row's first batch is one the node refuses.

## Proving times

Measured at `providers.proofProvider.proveTx`, so the figures are proving alone
and exclude building, balancing, and submission; per-call wall clock is recorded
separately in `details.calls`. The `k` column is the compiled k of the circuit
from the stage-two measurement table.

| Circuit | k | Proofs | Min ms | Median ms | Max ms |
|---|---|---|---|---|---|
| `withdraw_shielded_with_grant_jubjub` x2 (composed pair) | 17 and 17 | 2 | 19,947 | 25,369 | 30,791 |
| `withdraw_shielded_with_k256` | 17 | 1 | 16,181 | 16,181 | 16,181 |
| `withdraw_shielded_with_grant_k256` | 17 | 2 | 13,592 | 15,507 | 17,422 |
| `withdraw_shielded_to_contract_with_grant_k256` plus `deposit_shielded` (composed) | 17 and 13 | 1 | 15,116 | 15,116 | 15,116 |
| `issue_grant_with_k256` | 17 | 7 | 12,853 | 13,941 | 17,253 |
| `withdraw_shielded_with_grant_jubjub` | 17 | 11 | 11,157 | 12,309 | 15,126 |
| `withdraw_shielded_with_grant_jubjub` (prove-only index trials) | 17 | 8 | 11,246 | 12,047 | 12,774 |
| `withdraw_shielded_with_grant_jubjub` (prove-only, over a spent coin) | 17 | 1 | 11,779 | 11,779 | 11,779 |
| `issue_grant_with_jubjub` x2 (composed pair) | 16 and 16 | 1 | 9,270 | 9,270 | 9,270 |
| `rotate_enc_key_with_k256` | 16 | 1 | 7,962 | 7,962 | 7,962 |
| `append_inbox_with_k256` | 16 | 1 | 7,946 | 7,946 | 7,946 |
| `add_device_with_k256` | 16 | 1 | 7,706 | 7,706 | 7,706 |
| `revoke_grant_with_jubjub` plus `issue_grant_with_jubjub` (composed) | 15 and 16 | 1 | 7,388 | 7,388 | 7,388 |
| `issue_grant_with_jubjub` | 16 | 17 | 5,575 | 5,683 | 6,647 |
| `revoke_all_grants_with_jubjub` | 15 | 1 | 3,446 | 3,446 | 3,446 |
| `revoke_grant_with_jubjub` | 15 | 1 | 3,416 | 3,416 | 3,416 |
| `faucet.mint_shielded` | not measured | 8 | 1,352 | 1,467 | 1,753 |
| `deposit_shielded` | 13 | 8 | 973 | 1,023 | 1,142 |
| deploy and activation submissions | 14 for the activation | 8 | 0 | 1 | 2,246 |

Readings. Proving time tracks k closely on this hardware: about 3.4 s at k=15,
5.6 to 8.0 s at k=16, and 11.2 to 17.4 s at k=17, with a composed pair of k=17
proofs at 20 to 31 s and the cross-contract pair (k=17 with k=13) at 15.1 s. A
grant spend and an issuance cost the same order on the same arm, and the jubjub
arm is the cheaper one at every k it shares with k256. Twelve proof attempts
failed, in three groups: six are candidate trials on a call that had already
been signed and that the prover refused (`A #2`, `B #1`, `A #3`, `L #1`, `Z0`,
and the composed direct transfer, one failed candidate each); three are
prove-only index trials, which exist precisely to produce that answer before
anything is signed; and three are proof-server outages the suite recovers from
and runs again (`B #1`, the `grant F` issuance, and the raw submit of the
reordered pair).
A wrong `mt_index` candidate costs a full proof and, because the qualified coin
is in the challenge, a fresh signature as well, which is why the sections added
in this run resolve the index by prove-only trials BEFORE anything is signed.

**The proof server is the run's bottleneck and its least stable component.** It
was restarted five times across this run: three times because it had died at a
k=17 proof (`FetchError ... ECONNREFUSED 127.0.0.1:6300`), and twice
deliberately, before the two heaviest calls. (`details.proofServerRestarts`
carries seven entries, because a recovery from an outage is recorded twice,
once by the retry loop and once by the restart it then calls.) The suite
treats an outage as a non-verdict: it restores the container and runs the same
call again, because proving precedes balancing and submission, so nothing can
have reached the chain. Without that rule a single outage during a candidate
retry is indistinguishable from a wrong index, and it cost two earlier runs.

## The rejection matrix

Twelve rows, every one an abort during circuit execution with no transaction
proved or submitted, and a ledger snapshot (`round`, `auth_nonce`,
`inbox_count`, `device_count`, `grant_generation`, register size) identical
before and after. Every observed message arrives in the same shape,
`Unexpected error executing scoped transaction '<unnamed>': Error: failed
assert: <needle>`, so the table gives the needle. Eleven of the twelve rows
admit exactly one needle and matched it; the replay row admits any of four and
matched `cumulative cap exceeded`, which is the row's point rather than a
looser check.

| # | Row | Expected | Observed | Transaction submitted |
|---|---|---|---|---|
| 1 | over `per_call_cap` (grant A, 250 against a 200 cap) | `amount above per-call cap` | `amount above per-call cap` | no |
| 2 | over `cap` (grant A at 500 of 500, asks 100) | `cumulative cap exceeded` | `cumulative cap exceeded` | no |
| 3 | wrong `spent_prev` opening (off by one) | `spent opening mismatch` | `spent opening mismatch` | no |
| 4 | wrong recipient under a pin (grant G) | `recipient not admitted by pin` | `recipient not admitted by pin` | no |
| 5 | coin above `max_coin_value` (grant D, bound 50) | `coin above max_coin_value` | `coin above max_coin_value` | no |
| 6 | revoked grant (grant B after `revoke_grant_with_jubjub`) | `grant revoked` | `grant revoked` | no |
| 7 | expired grant (grant E, `expires_at` 100 s in the past) | `grant expired` | `grant expired` | no |
| 8 | envelope-1 grantee through `withdraw_shielded_with_grant_k256` (grant C) | `envelope not admitted for a spend grant` | `envelope not admitted for a spend grant` | no |
| 9 | a grantee key against a device-gated circuit (`rotate_enc_key_with_jubjub`) | `unknown device entry` | `unknown device entry` | no |
| 10 | cross-arm: the jubjub grantee's key at grant B's origin and slot | `unknown grant` | `unknown grant` | no |
| 11 | replayed grant A authorisation, byte-identical resubmission | any of `cumulative cap exceeded`, `spent opening mismatch`, `invalid grant signature`, `range error` | `cumulative cap exceeded` | no |
| 12 | stale `enc_pk` (grant L signed against the pre-rotation key) | `stale encryption key` | `stale encryption key` | no |

Row 11 is the one worth reading closely. A byte-identical replay is refused at
the **scope predicates**, not at the signature: step 5 runs before step 6, so
the cap or the spent-commitment opening always dominates and the signature check
is never reached. Exercising the signature on a replay would need an opening
that still matches, which the seam makes impossible once `nonce` has moved. The
row was set up by first spending an admitted 200 to bring grant A to 500 of 500
(transaction `007650cf3bfebe13…`), because at 300 of 500 with a 200 per-call cap no
admissible amount can breach the cumulative cap; that spend also extended the
consecutive-nonce chain to 1, 2, 3.

Row 12 also demonstrates the retained-secret property: five inbox entries sealed
before the rotation stayed readable with the retained old secret.

### The refusals the run measured outside those twelve rows

The twelve rows above are all build-time aborts. The sections added in this run
produce refusals at three other points, and a conformance suite that matches
only on `failed assert:` will miss every one of them.

| Rows | Where | What is seen | Transaction |
|---|---|---|---|
| Six grantee-key rows (S11) | build, in-circuit, at a named assert | `failed assert: device key is the point at infinity`, `… invalid grant signature`, `… grantee key has small order` | none |
| Two grantee-key rows (S11), the JubJub order-2 point and the JubJub off-curve pair | build, inside the curve built-in | `ContractRuntimeError: Error executing circuit '…'`, no named assert | none |
| One grantee-key row (S11), the `k1` key against the jubjub twin | before a transaction exists, in the client encoder | `out of bounds for prime field` | none |
| A record expiring inside the admission margin (S12) | node, at admission | `1010: Invalid Transaction: Custom error: 104`, node `Transcript(Execution(ReadMismatch …))` | built, proved, submitted, not included |
| The composed pair grafted in the opposite segment order (S13) | node, at admission | the same `Custom error: 104` over the grant record | built, proved, submitted, not included |
| The grantee losing the one-coin race (S14) | node, at admission | `1010: Invalid Transaction: Custom error: 239`, node `Zswap(NullifierAlreadyPresent(…))` | built, proved, submitted, not included |
| A maintenance update above the per-update ceiling (the ceiling probe) | node, at admission | `1010: Invalid Transaction: Transaction would exhaust the block limits` | built, priced, submitted, not included |

Every row leaves the state it targets unmoved: the account's ledger snapshot
for the grant rows, which is the same property the twelve build-time rows
carry, and the maintenance authority counter for the ceiling probe, which is
why a refused probe could be retried on the same throwaway account.

## The change prediction

The standard library derives both output nonces from the input nonce, read off
the compiled contract's inlined `sendShielded`: the sent coin under
`midnight:kernel:nonce_evolve` (28 bytes) and the change coin under
`midnight:kernel:nonce_evolve/2` (30 bytes), each
`upgradeFromTransient(transientHash(Vector<2,Field>, [convertBytesToUint(tag),
degradeToTransient(nonce)]))`. The suite predicts the change coin before
signing, seals it as `change_entry`, and compares it with the coin the circuit
returns.

**Ten of ten matched**, on nonce and value both: every spend driven through
the suite's grant-spend helper, on both grantee arms and across every section
that uses it. (The composed spends of S13 and the race spends of S14 resolve
their coin a different way and carry no prediction of their own, so they are
outside this ten.) The composed direct transfer additionally matched the
**sent** coin nonce as well as its change, which is the pair a composing client
needs to build the payee's claim in the same transaction. Section 6.5's "not yet
evidenced" caveat is discharged and its fallback standalone append twin is
unnecessary.

Two qualifications, and the second is why the first matters. First, the
load-bearing comparison is the prediction against the coin the circuit
returned. Only one of the ten, the first grant spend of S4, was additionally
checked by decrypting the appended inbox entry and comparing it with that coin
(`changeEntryDecrypts`), which is what shows the seal round-trips; the other
nine are the prediction against the circuit's own result and not against
anything read back off chain. Second, the contract treats `change_entry` as an
opaque `Bytes<192>` and appends it verbatim: the entry is bound into the
signature challenge, but its contents are never checked in-circuit against the
coin the send produced, so a grantee that seals the wrong description strands
its own change and nothing in the seam refuses it. The seal is therefore the
grantee's obligation alone, which is what makes a prediction rule that is right
on every spend of the run the thing that discharges it.

**A caveat worth a MIP line.** The change output is not reliably the last
commitment of the spend transaction's window, and a deposit's contract-owned
commitment is not reliably the first of its own. Eleven spends of this run
resolved their index the expensive way, by signing and submitting a candidate:
the ten driven through the grant-spend helper and the composed direct transfer.
Six of the eleven needed a second candidate, each exactly once (`A #2`, `B #1`,
`A #3`, `L #1`, `Z0`, and the composed direct transfer); the other five landed
on the first. Eight further indices were resolved the cheap way, by prove-only
trials that submit nothing, and four of those eight needed a second trial. A
grantee must therefore still resolve `mt_index` by retry, and every retry of a
SIGNED call costs a fresh signature as well, because the qualified coin is in
the challenge.

What a wrong candidate produces is a failure before submission, and the record
should be read as that and no more. Nine of the ten failed candidates carry
`'prove' returned an error: ... Failed Proof Server response` from the prover
(four of the nine show `code="400"`; the other five are truncated in the record
before the code), and the tenth, a control coin of S13, aborts at circuit
execution with a bare `unreachable`. The suite does not read any of those texts
as a diagnosis: its only classifier separates a proof-server OUTAGE from
everything else, and everything else is taken as "not this candidate". So the
observable is that the candidate did not prove, not that the prover said why.
Either way nothing reaches the node, which is what makes the prove-only
resolution used by S7, S12, S13, and S14 safe: a trial that fails costs a proof
and nothing else, and a trial that succeeds is the index the grantee can then
sign over.

## Grantee-key validation (S11)

Section 3.3 states key validation as "performed by the authoriser at issuance
and by the seam at every use". The issuance half **cannot exist in-circuit**:
`issue_grant_with_<arm>` takes `grant_id`, a 32-byte commitment the client
computed, and never the grantee key, so every weak, off-curve, and foreign key
below was given a live, well-formed record without complaint, and the only
thing that refuses is the seam at use. This package's client does not apply the
section 3.3 checks at issuance either, which is a gap in the implementation
rather than in the specification, and an argument for 3.3 to state the
authoriser's checks as an obligation with a name rather than as a description.

Each row issues a record at the key's own `grant_id`, so a refusal can never be
read as "unknown grant", and then attempts one shielded spend of 10 under it,
recording the ledger snapshot either side. No row produced a transaction and no
row moved the ledger.

| # | Row | Refused at | Verbatim |
|---|---|---|---|
| 1 | `k1` identity, flagged encoding `{0, 0, identity: true}` | build | `failed assert: device key is the point at infinity` |
| 2 | `k1` identity, unflagged twin `{0, 0, identity: false}` | build | `failed assert: device key is the point at infinity` |
| 3 | `k1` off-curve coordinate pair `(1, 1)` | build | `failed assert: invalid grant signature` |
| 4 | `k1` invalid-curve twin, a point of `y^2 = x^3 + 2` at `x = 3` | build | `failed assert: invalid grant signature` |
| 5 | the `v1` grantee key presented against the `k256` twin | build | `failed assert: invalid grant signature` |
| 6 | `v1` identity `(0, 1)` | build | `failed assert: grantee key has small order` |
| 7 | `v1` order-2 point `(0, q - 1)` | build | `ContractRuntimeError: Error executing circuit …` |
| 8 | `v1` off-curve coordinate pair `(1, 1)` | build | `ContractRuntimeError: Error executing circuit …` |
| 9 | the `k1` grantee key presented against the jubjub twin | before a transaction exists | `out of bounds for prime field` |
| 10 | a DEVICE key issued as a grantee | not refused | the spend landed: `00c133008820531e8e…`, record `nonce 1` |

Readings.

1. **The two `k1` identity encodings share one `grant_id`** (measured), because
   the identity derivation binds `x` and `y` and not the identity flag, and the
   guard compares coordinates for the same reason. One record, both encodings
   refused by the same assert. This is the on-node confirmation of the
   contract's own note and of the authorisation MIP's erratum on weak device
   keys.
2. **There is no on-curve check on the `k1` arm, and the seam does not pretend
   to have one.** An off-curve pair, a genuine point of a different curve of the
   same shape, and a JubJub key's coordinates carried as a `Secp256k1Point` all
   pass the key guard (none is the point at infinity), pass the scope
   predicates, reach step 6, and are refused only as `invalid grant signature`.
   Section 3.3's "not yet evidenced in-circuit" column is therefore evidenced in
   the negative: nothing stands between an invalid-curve key and the seam except
   the arithmetic of the signature check itself.
3. **On the `v1` arm the identity is caught by the guard and the rest by the
   runtime.** `(0, 1)` fails the cofactor-clearing assert with `grantee key has
   small order`. The order-2 point `(0, q - 1)` and the off-curve pair `(1, 1)`
   never reach that assert: circuit execution traps inside the curve built-in
   first, so the rejection is the runtime's. Both leave the ledger untouched and
   neither produces a transaction, but a specification that says "the seam
   rejects" should record that on this arm the runtime rejects first, and that
   the operator sees `ContractRuntimeError` rather than a named assert.
4. **A coordinate at or above the field modulus is refused before a transaction
   exists.** The `k1` grantee key carried as a `JubjubPoint` is rejected by the
   client's own encoder with `out of bounds for prime field`. That is section
   3.4's canonical-coordinate rule enforced by the compiled encoding rather than
   by an assert, and it is why the cross-arm row in that direction never reaches
   the seam at all.
5. **GR-2 is an authoriser obligation only, confirmed on node.** A key enrolled
   as a device of the account was issued a grant and spent under the grant seam
   in the same run, with the record advancing to `nonce 1`. The seam looks a
   grantee key up in `grants` under the grant tag family and finds a live
   record; nothing in the contract can see that the same key also holds a device
   entry, because device entries are salted rolling commitments rather than
   stored keys. The two authorities stay disjoint in the sense GR-2 states, in
   that no one credential satisfies both seams in one call, but the refusal to
   issue is enforceable only off-chain, and this package's client does not
   enforce it.

## The expiry rows on the grant twins (S12)

E3 pinned the unit and the enforcement point of `kernel.blockTimeLessThan` on a
purpose-built probe contract. This section pins the same rows on the grant twins
themselves, and adds the one thing E3 did not show: what the transaction
records.

| Row | `expires_at` | Client | Node | Ledger |
|---|---|---|---|---|
| Z0 | `0` | builds | included at block 6,176, `SUCCESS` | `round` 40 → 41, record `nonce` 1 |
| Z1 | head + 3,600 s (`1789148172`) | builds | included at block 6,183, `SUCCESS` | `round` 41 → 42, record `nonce` 1 |
| Z2 | wall clock + 10 s (`1789144903`) | builds | REFUSED at admission | unchanged |

**The transcripts.** Both accepted transactions were read back through the
indexer (`transactions(offset: { identifier }) { raw }`), deserialised with
`Transaction.deserialize`, and every contract-call transcript walked operation
by operation, guaranteed and fallible sections alike. The never-expiring
record's call carries 77 operations and **no `lt`**; the forward-dated one
carries 81 and **exactly one**, whose following `popeq` records the Boolean
`[{"0":1}]`. That is section 5.1's "a record with `expires_at == 0` records no
time read at all" and section 6.2 step 3's parenthetical, measured on the chain
rather than read off the generated code.

Note in passing that the two calls partitioned differently: the zero record's
call sat in the GUARANTEED transcript and the forward-dated one in the FALLIBLE
transcript, on the same circuit, the same account, and consecutive
transactions. Where a call's operations land is the SDK's decision and it is
not stable, which matters for composition (S13) and means any tool that reads
transcripts must read both sections.

**The admission row and the margin that matters.** The short-dated record was
issued with `expires_at` 180 s ahead, the suite then waited until the wall clock
sat 10 s before it, and the call was built (130 ms), proved, balanced, and
submitted. The client raised nothing: its comparison is against its own wall
clock at build, and 10 s of headroom satisfied it. The node refused the
transaction at admission, `1010: Invalid Transaction: Custom error: 104`, with

```
🚫 Rejected transaction 762492d060d98721fec4c0dd01985bd6d73449db78252b81fb1e4cff04ab5759 from mempool: guaranteed execution would fail: Transcript(Execution(ReadMismatch { expected: <[01]: b1>, actual: <[-]: b1> }))
```

and the ledger snapshot was identical either side. Build to outcome took
14,515 ms, nearly all of it the k = 17 proof.

E3 measured the node's admission-time block time 8.2 to 10.2 s ahead of the wall
clock with a trivial probe circuit and a 1.5 s build-to-submit latency. A grant
call is a k = 17 proof, so the gap between the client's clock reading and the
node's evaluation is that margin **plus the call's own prove-and-balance time**.
The rule for the MIP is therefore not "`expires_at` stops being usable about one
block interval before it" but "about one block interval plus tolerance plus the
grantee's own proving time", which on this stack is of the order of 20 s for a
shielded twin. A wallet that offers a five-second grant is offering one that
cannot be used.

## Composition (S13)

Section 7.4 says a grant call MAY be composed with other calls of the same or
other contracts, including a device call of the same account, and that
reordering composed calls invalidates the signatures. S8 had already shown two
calls on **two** contracts in one transaction. This section is the harder case,
two calls on **one** contract, and it took three distinct discoveries to reach
it. All three are properties of the ledger and the SDK rather than of the grant
seam, and all three belong in the MIP as implementation notes, because a
composing client will meet every one of them.

**1. The second call must be built against the state the first produces.** Two
independently built calls read the same pre-state, so both record the same
`auth_nonce` (or the same grant `nonce`) in their transcripts and the node
refuses the pair. `createUnprovenCallTxFromInitialStates` takes an explicit
`ContractState`, and `nextContractState` on the first call's result is exactly
the successor: clone the chain state, set `data` to `new ChargedState(next)`,
and build the second call on that.

**2. The second call's Zswap offer must travel with its intent.** An `Intent`
carries the contract actions and the UNSHIELDED offers only; a contract call's
shielded inputs and outputs live on the transaction. `addIntent` alone therefore
produces a transaction whose transcript claims nullifiers no offer carries, and
the node refuses it before execution with
`Malformed(EffectsCheck(NullifiersNeqClaimedNullifiers))` (`Custom error: 217`,
measured).

**3. Where those coins live is not stable, and a fallible offer cannot be
moved.** The same circuit put its input and its two outputs in the
transaction-global GUARANTEED offer on one run and in the FALLIBLE offer, keyed
by the call's own segment, on the next. A guaranteed offer merges
(`ZswapOffer.merge`) and leaves the intent free to be placed at any segment; a
fallible offer's proofs are bound to their segment, and re-keying it to another
segment is refused with `Malformed(Zswap(InvalidProof))` (`Custom error: 235`,
measured). So when the second call's coins are fallible, its intent must stay at
its own segment, and the relative order of the two calls is whatever the SDK's
random segment draw gave: the suite rebuilds, which costs no proof, until the
draw admits the order it wants.

Two further mechanics, cheap to state and expensive to discover: every
wasm-backed accessor (`guaranteedOffer`, `fallibleOffer`, `intents`) must be
read ONCE into a local, because reading one twice silently yields a transaction
missing a call's inputs; and `addIntent` and `addZswapOffer` return a new
transaction rather than mutating in place.

| Row | Composed | Outcome |
|---|---|---|
| revoke plus issue over ONE grant id | `revoke_grant_with_jubjub` at `auth_nonce` 26 and `issue_grant_with_jubjub` at 27, segments 55,658 and 55,659 | ACCEPTED, `005e74a2b8289c83…`; `auth_nonce` 26 → 28, `round` 44 → 46; the record ends a fresh incarnation: `active`, `nonce 0`, `issued_at` 26 → 28, a new `spent_commit` and a narrower scope (`cap` 40 → 30) |
| batch issuance of two grants | two `issue_grant_with_jubjub`, segments 28,169 and 28,170 | ACCEPTED, `00482117f8ac3419…`; `auth_nonce` 28 → 30, `round` 46 → 48, both records present with `issued_at` 29 and 30 |
| two grant calls under ONE grant | two `withdraw_shielded_with_grant_jubjub` on two different coins, grant nonces 0 and 1, segments 3,762 and 3,763 | ACCEPTED, `007bfe4fd7ea93f0…`; record `nonce` 0 → 2, `spent_commit` matches the cumulative 20, `round` 49 → 51, `inbox_count` 18 → 20 (both change entries appended in the same transaction), `auth_nonce` untouched |
| the same pair, REORDERED | the nonce n + 1 call grafted into the LOWER segment | REFUSED at admission, `Custom error: 104`, `Transcript(Execution(ReadMismatch …))` over the grant record, ledger unchanged |

Readings.

- **A grant call composes with a device call of the same account, and the
  record ends a fresh incarnation.** That is section 7.2's "modification is
  revoke then issue, composable in one transaction" shown on node, and it is
  what a client needs to re-scope a live grant without a window in which the
  dApp holds nothing.
- **The reordering claim of 7.4 holds, but the refusal is not what the text
  implies.** The signatures are not what fails: each is still a valid signature
  over its own challenge. What fails is the transcript: the out-of-order call
  records reads of a record state that does not hold when it executes, and the
  node refuses on a `ReadMismatch` at admission. Section 7.4 should say so,
  because the two produce different operator-visible behaviour.
- One run of this suite saw the ordering control **included** rather than
  refused, with the record advancing by one instead of two, because both calls
  had partitioned into the fallible section: the out-of-order call failed there
  and the ledger tolerated it. The suite therefore treats "refused at admission"
  and "included, but only one of the two calls applied" as the same verdict, and
  only a record advancing by two under the reordered graft would be a
  counter-example.

## Concurrency (S14)

**One coin, two claimants.** A grant with `cap` 60 was issued to the jubjub
grantee, the held coin's index was resolved by a prove-only trial, and then the
owner's `withdraw_shielded_with_k256` and the grantee's
`withdraw_shielded_with_grant_jubjub` were BOTH built over that one qualified
coin before either was proved. The owner's landed
(`00f30d9f0573c17227…`, `auth_nonce` 32 → 33, `round` 52 → 53). The grantee's
was then proved and submitted and the node refused it,
`1010: Invalid Transaction: Custom error: 239`:

```
🚫 Rejected transaction df060b7bb6b70c4aedb0642671259ec38a731fd7ca35120bf9fa7d9cd1c2c6f5 from mempool: guaranteed execution would fail: Zswap(NullifierAlreadyPresent(Nullifier(d820a7661f5e4ae3a822b92544b02b8b7f5bbff66486d1da3afc74bedfe184c0)))
```

The ledger snapshot was identical either side, the grant record stayed at
`nonce 0`, and no coin was spent twice.

**Where the refusal is, and where it is not.** Testing item 10 describes this
row as a "proving failure". It is not one. To separate the stale transcript
from the spent coin, the same grant call was rebuilt against the state AFTER
the owner's spend, so no read in it is stale, and proved: **it proved
successfully**, in 11.8 s, and was never submitted. Proving a spend does not
consult the nullifier set; it consults the commitment tree, where the coin is
still present. A wrong `mt_index` fails at the prover; a SPENT coin at the right
index does not. The item's parenthetical should read "the loser is refused by
the node as a double spend, with no mis-spend" rather than "proving failure".

**Testing item 3, leg (b), with the ORIGINAL signature.** The first run could
only land a call RE-SIGNED after the intervening deposit: the candidate
`mt_index` the grantee had signed over did not prove, and the next candidate
needed a fresh signature, which is exactly the thing the leg must not do. What
the record shows there is a candidate that failed before submission, and not a
diagnosis of why. Here the index was resolved first, by proving a throwaway
call per candidate and submitting none of them, and only then did the grantee
sign, over grant nonce 0. A permissionless `deposit_shielded` then landed
(`inbox_count` 21 → 22, `round` to 56), and the call was built, proved, and
submitted **with that same signature**, unchanged:
`00894781610df53a45…`, `round` 56 → 57, the record advancing to `nonce 1`.
A permissionless deposit does not invalidate a pending grantee call, shown with
the signature it started with.

## The one PARTIAL item, with the exact reason

**Deploy, `grants-e2-deploy`.** The waves, the retirement, the counters, and the
cross-arm enrolment are all green. Testing item 6 also asks that a
`spec_version = 1` account be shown unable to gain grants, and that control was
NOT run: it needs a compiled pre-grants build of the contract, which this tree
does not carry, since `contracts/account.compact` is the version-2 source and
the managed artefacts are its thirty-circuit roster. The deploy leg of item 6 is
therefore reported without its control, and the group is PARTIAL for that reason
alone. Every other group is PASS.

Two legs that were PARTIAL in the first run are now closed. Owner liveness leg
(b) lands with the signature made before the intervening deposit, because the
qualified-coin index is resolved by prove-only trials before the grantee signs:
S7 records `preSignedCallLandedAsSigned`, and S14 repeats the leg on a fresh
coin and a fresh grant. The composed direct transfer of S8 lands, and both its
sent and its change coin nonce match the prediction; it still needed a second
candidate (437 refused at the prover, 436 accepted), so what closed is the leg,
not the retry.

## Defects found, and what was done about them

1. **The shipped wave budget does not fit a block.** Fixed twice: first by
   making `VERIFIER_BYTE_BUDGET` overridable, then by measuring the ceiling and
   setting the default from the measurement (25,000 verifier bytes, the largest
   accepted payload less a stated margin).
2. **The client could not activate a k256-born account at all.**
   `CustodyAccount` called `activate_initial_device_with_<arm>` with
   `(pk, salt)` on both arms, but the k256 activation takes the device's
   envelope as a third argument, because the boot commitment and the entry it
   derives both bind it. The call failed before a transaction existed with
   `activate_initial_device_with_k256: expected 4 arguments (as invoked from
   Typescript), received 3`. Fixed in `src/wallet/account.ts` with an
   arm-dependent argument list; no contract change, and the ABI is what the MIP
   specifies.
3. **The composed direct transfer left the private-state provider pointed at
   the payee.** S8 points the provider at account B to build the payee's claim
   and, on a candidate retry, wrote and read account A's coin store while it was
   still pointed there. The witness the circuit consumed was then not the coin
   the grantee had signed over, and the seam refused with
   `invalid grant signature`, a confusing message for a bookkeeping error.
   Fixed in the suite by pointing the provider back at A at the top of every
   retry.
4. **A proof-server outage was read as a wrong `mt_index`.** The proof server
   dies at k = 17 under memory pressure on this host. A candidate retry that
   fails with `FetchError ... ECONNREFUSED 127.0.0.1:6300` has not tested the
   candidate at all, and treating it as a rejection silently burned the right
   index and failed two runs. The suite now classifies a proof-server outage
   (both an outage signature AND a proof-server endpoint in the message, so a
   400 from a live prover is never misread) as a non-verdict, restores the
   container, and runs the same call again, everywhere except a deploy.
5. **Two calls on one contract need more than `addIntent`.** Recorded in full in
   the composition section: the successor state, the Zswap offer, the
   partitioning, the read-once rule for wasm accessors, and the return values of
   `addIntent` and `addZswapOffer`. Each of these was found as a distinct
   node-side refusal with its own verbatim message, and all five are properties
   a composing client must know.

## Corrections and observations for the MIP

1. **Section 6.7, the wave count.** The sentence "The thirty-circuit roster
   (33 with p256) carries 74,286 verifier bytes and needs **three waves**, two
   of them maintenance updates" reaches the right count for the wrong reason,
   and the count stands: no correction to the figure is owed, only to the
   packing behind it. Three waves do land, but only at a budget the measurement
   supports: the deploy (25,434 verifier bytes) plus two maintenance updates of
   23,994 and 24,858.
   The section's own arithmetic implies a 16-key update of 39,600 verifier
   bytes, which the node refuses. State the per-update ceiling as
   network-defined and bounded by measurement to (29,484, 32,229] verifier
   bytes on node 2.1.0 (`evidence/wave-ceiling.json`), say that an
   implementation should pack well below it, and note that the two refusals are
   different mechanisms: the deploy is refused client-side by the fee
   computation, an over-large maintenance update by the node at admission, with
   nothing client-side objecting first.
2. **Section 6.5, the change description.** Delete "not yet evidenced" and the
   fallback append twin. Add the measured rule (both output nonces evolve from
   the input nonce under the two kernel tags) and the qualification that the
   change output is not reliably the last commitment of the window, so a
   grantee resolves `mt_index` by candidate retry and re-signs per candidate.
   Give the measured rate rather than "sometimes": of the eleven spends in this
   run that resolved their index by signing and submitting a candidate, six
   needed a second one, each exactly once; of the eight resolved by prove-only
   trials, four needed a second trial. Say also what a wrong candidate looks
   like, since it is not self-describing: the call fails at the prover before
   submission, and the text it carries is a prover error rather than a
   statement about the index.
3. **Section 6.7, proving times.** The section says proving times are not yet
   measured. The table above supplies them for every circuit this run exercised,
   on the reference localnet: about 3.4 s at k=15, 5.6 to 8.0 s at k=16, and
   11.2 to 17.4 s at k=17, 15.1 s for the cross-contract pair, and 20 to 31 s
   for a composed pair of two k=17 proofs.
4. **Section 6.2 step 5, and Testing item 2's replay row.** Record that an
   identical resubmission is refused at the scope predicates rather than at the
   signature, because step 5 precedes step 6 and the spent-commitment opening
   (or the cap) has already moved. A conformance suite MUST accept any of the
   step-5 needles on that row, and the MIP should say so rather than naming one.
5. **Section 6.2 step 5, the change entry.** Note that the contract cannot
   check `change_entry` against the coin the send produces: it is an opaque
   192-byte argument bound into the challenge and appended verbatim. The
   consequence is a grantee-side obligation, not a seam check.
6. **Section 6.4, refusal texts.** No refusal text new to the specification
   appeared on node: every rejection row produced exactly the message the
   in-circuit assert carries, and the whole class arrives wrapped as
   `Unexpected error executing scoped transaction '<unnamed>': Error: failed
   assert: <needle>` at build time. The wrapper text is worth quoting once in
   6.4 so an implementer can match on it, and so that a build-time abort is not
   confused with the submission-phase wrapper (`Unexpected error submitting
   …`), which is what a proving failure or a mempool refusal produces.
7. **Testing item statuses, item by item.** Green means every clause of the
   item ran on node in this experiment; partial means some clauses ran and the
   rest are named below; open means none of the item's clauses ran here.
   - **Item 1, grant happy path: GREEN.** Issuance from both device arms, a
     within-scope spend on both grantee arms with `nonce`, `spent_commit`, and
     `round` advancing and `auth_nonce` unchanged, and both expiry rows on the
     grant twins themselves, with the transcript check that a `0` record
     records no time read and a forward-dated one records exactly one. The
     item's own "pending" status line can be deleted. One coverage note that is
     not a gap in the item: the unshielded twins are exercised off-node only,
     because this localnet refuses a contract call carrying an unshielded
     offer.
   - **Item 2, rejection matrix: PARTIAL.** Ran on node and green: over
     `per_call_cap`; over `cap`; a witness coin above `max_coin_value`; wrong
     recipient under a pin; a stale `enc_pk`; revoked; `expires_at` in the
     past; `expires_at` inside the admission margin (built by the client,
     refused by the node on `Custom error: 104`, state unchanged); identical
     resubmission after success; a cross-scheme key, in both directions; an
     envelope-1 grantee against a withdraw twin; a grantee calling a
     device-gated circuit; the identity on both deployed arms, an off-curve
     pair and an invalid-curve twin on the `k1` arm, and an order-2 point and
     an off-curve pair on the `v1` arm (secp256k1 has prime order, so the
     identity is its only small-order point); and `device_count` untouched
     across every one. Not run, and therefore still owed by this item: an
     out-of-scope operation flag; a cumulative wrap attempt; a witness coin of
     another color; recipient-kind mismatch; the two clock-skew rows on a grant
     twin (E3 has them on a probe contract); stale epoch (no circuit bumps
     `device_epoch` yet); stale generation (structurally unreachable while
     `revoke_all_grants` clears the register); a prior-incarnation signature
     against a re-issue; a wrong envelope in the trailer; the four issue-rule
     rows (re-issue of a live id refused, re-issue of an expired but unrevoked
     id refused, issue over an absent id succeeding, revoke of an absent id
     aborting); the reused-`scope_salt` harness flag; the two-slot revocation
     row; and the vacuous-verifier control. The clause that rides with the
     issue rules, revoke plus issue over one id in one transaction accepted, IS
     green, but S13 ran it over a LIVE id and the item asks it of an expired
     but unrevoked one. **The Path to Active checkbox for E2 therefore cannot
     close.** It reads "Testing item 2 green on a node, each case ending with
     the invariants it exercises", and the cases above have not run. Add one row
     the item does not yet name: a device key issued as a grantee is NOT
     refused by the seam (GR-2 is an authoriser obligation only), which S11
     measured.
   - **Item 3, owner liveness: GREEN.** Both legs, with leg (b) carrying the
     signature made before the intervening deposit rather than a re-signed
     call.
   - **Item 6, deploy budget: PARTIAL.** Green for the wave deploy of the
     thirty-circuit roster within the per-block parameters and for the
     authority retirement after the last wave. Missing: the `spec_version = 1`
     control, that a version-1 account cannot gain grants, which needs a
     compiled pre-grants build of the contract that this tree does not carry.
   - **Item 9, composition: GREEN.** Revoke plus issue over one id, batch
     issuance, and two grant calls under one grant with consecutive nonces each
     ride one transaction, and the reordered pair is refused. The item's
     "reordering invalidates" should say what invalidates: the transcript, at
     admission, not the signatures.
   - **Item 10, change and concurrency: PARTIAL.** Green for the change entry
     appended in the same transaction under one hop, a coin above
     `max_coin_value` aborting, and owner and grantee selecting the same coin.
     The same-transaction reading rests on the contract source, where the
     append is inside the circuit, and on the indexer showing no other contract
     action between the call and the appended entry; the suite's own assertion
     is only the `inbox_count` delta across the call, which is weaker.
     Missing: a `rotate_enc_key` between signing and submission shown to abort
     the call with NO orphaned change. The stale-`enc_pk` row proves the abort
     and says nothing about orphaned change, which is the half the item asks
     for. Correct the parenthetical on the same-coin row too: the loser is
     refused by the NODE as a double spend, and the same call rebuilt against
     the post-spend state still proves, so "proving failure" names the wrong
     component.
   - **Item 11, kill totality: PARTIAL.** Green for `revoke_all_grants`: the
     generation bumped 0 to 1, the register cleared, a pre-kill grant refused
     as `unknown grant`, and a re-issue under the new generation spending.
     Missing: the recovery epoch bump, the item's other half. `device_epoch` is
     0 on chain throughout this run and no circuit in the roster bumps it, so
     that half waits on the recovery seam and cannot be run here at all.

8. **Section 14, contract schema.** The versioning clause says twins, lifecycle
   circuits, pure derivations, and tag families are maintenance updates under
   the wave rule of 6.7. That is confirmed: the twelve grant circuits reached a
   live account entirely through maintenance updates, in two batches, at the
   counter read from chain, with the authority retired in the same update as
   the last batch.
9. **Section 3.3, key validation.** State the authoriser's checks as an
   obligation on the issuing client, and say plainly that the contract cannot
   perform them: `issue_grant` takes `grant_id` and never the key, so every
   weak, off-curve, or foreign key issues cleanly and is refused, if at all, at
   the twin. Record what the seam actually does on each arm: `k1` rejects the
   point at infinity in both encodings and nothing else, so an off-curve or
   invalid-curve key reaches the signature check; `v1` rejects the identity at
   the guard, and the runtime traps on any other point outside the prime-order
   subgroup before the guard runs.
10. **Section 7.4, composition.** Add the three mechanics a composing client
    needs: the second call must be built against the state the first produces;
    its Zswap offer must travel with its intent (a guaranteed offer merges, a
    fallible one is pinned to its segment); and which section a call's coins
    land in is not stable between runs. Give the three refusals by name:
    `Transcript(Execution(ReadMismatch …))`,
    `Malformed(EffectsCheck(NullifiersNeqClaimedNullifiers))`, and
    `Malformed(Zswap(InvalidProof))`.
11. **Section 5.1 and 6.4, the expiry margin.** The usable horizon is one block
    interval plus the network tolerance PLUS the grantee's own proving time,
    measured here at 14.5 s from build to refusal for a k = 17 twin. Say it in
    those terms, because a client that reads only E3's 8.2 to 10.2 s will offer
    grants that cannot be exercised.
12. **Section 6.7, the row counts of the two k256 grant twins.** The section
    carries 64,352 rows for `withdraw_unshielded_with_grant_k256` and 91,862
    for `withdraw_shielded_with_grant_k256`, which are the figures measured
    before the envelope assert landed. The compiled roster this run deployed
    measures 64,355 and 91,865 (`.planning/grants-e2/measurements.md`), a
    difference of three rows on each, which is the assert itself. Use the
    measured pair.
13. **Testing item 2 and the Path to Active checkbox.** The checkbox reads "E2:
    Testing item 2 green on a node, each case ending with the invariants it
    exercises". Twelve rejection rows, nine grantee-key rows, and the
    within-the-margin expiry row are green on node; the faults listed under
    correction 7 are not, so the checkbox cannot close on this run. Either the
    remaining faults run, or the item is split so that the seam half can close
    while the issue-rule and clock-skew halves stay open, but the checkbox
    should not be ticked against a partial matrix.

## Caveats

- Single-authority localnet with 6 s blocks and an uncontended mempool. The
  proving times are one machine's, and the proof server was restarted five
  times across the run (three recoveries from an out-of-memory death at k = 17,
  two deliberate recycles before the heaviest calls), so figures either
  side of a restart are not from an identical server state.
- Every grant spend in this run is shielded, because the node refuses a contract
  call carrying an unshielded offer. The unshielded twins' on-node behaviour is
  therefore unmeasured, including their proving cost, and the k=17 figure for
  `withdraw_unshielded_with_grant_k256` has no timing beside it. Their whole
  rejection matrix is covered off-node by `src/tests/grants-offline.ts`.
- The suite asserts the same-transaction inbox append as a counter delta across
  the call. The stronger reading, that the append cannot be a later transaction,
  follows from the contract source (the append is inside the same circuit) and
  from the chain showing no other contract action in between, rather than from
  the assertion itself.
- The key rows of S11 present a dummy signature, because no signature can be
  produced for a key nobody holds. Where a row is refused as
  `invalid grant signature` the reading is therefore "the seam had no
  curve-membership objection", not "the seam verified something".
- The ordering control of S13 depends on the SDK's random segment draw and on
  which transcript section the calls partition into; both were observed to vary
  between runs, and the suite rebuilds until the draw admits the order it wants.
  A run in which the control is included rather than refused, with the record
  advancing by one, is the same verdict by a different route (see the section).
- The scenario assumes an account that starts at `round` 1 and `auth_nonce` 0,
  so every run deploys a fresh account A and a fresh account B. The chain itself
  is reused; nothing in the suite requires a fresh localnet.
