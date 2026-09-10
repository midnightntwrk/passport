# One-transaction Passport → Passport transfer on stagenet — the drill, and what it settles

**Date:** 2026/09/10
**Network:** Midnight stagenet (node 2.0.0, chain tip ~402,350 blocks)
**Harness:** `examples/passport-demo/.live-drill/one-tx-transfer-drill.ts` (disposable, gitignored)
**Result:** the one-transaction transfer **works, and chains.** One transaction,
two contract calls, the recipient's ledger credited and the sender's change
recorded — and then the same again from the other side, over coins the first
transfer produced. It did not, for most of a day: every second transfer was
refused by the node with `1010: Invalid Transaction: Custom error: 217`, and
§§1–3b are the account of chasing that down. §3c names it — the shielded offer
midnight-js builds carries only the root call's spends, so a callee that merges
claims nullifiers no offer holds — and **§3d is the fix and the four legs that
settle it**. Two `patch-package` patches, no contract change, no redeploy. Read
§3c and §3d; the rest is how they were arrived at, and several of its
conclusions are superseded.

Paying a `.night` name is two transactions today — the sender withdraws to the
in-app wallet, the wallet deposits into the recipient's account — and
passport-demo #13 asks whether one will do. The recompiled account contract's
`transfer_shielded_to_account` hands the amount to the peer's contract address
with `sendShielded` and lets the peer's own `deposit_shielded` run in the same
call tree. This note is what happened when it was pointed at stagenet.

## 1. What passed

Twice, on two independent pairs of freshly deployed accounts, and with identical
results. Run 2's hashes are quoted; run 1's are in §5.

**One transaction, two contract calls.** `f70446dace300bfe312fa17f8c29f9c660c4d7df6a2de7c11afda0ecd67206ca`,
**block 402334**, `SUCCESS`. The indexer serves it with exactly two contract
actions:

```
ContractCall 76232e38e61923e2…  transfer_shielded_to_account   ← A, the sender
ContractCall 26aef743602f1bd5…  deposit_shielded               ← B, the callee
```

That is the whole of the headline. Stagenet's node 2.0.0 accepts a transaction
carrying two contract calls and two proofs, the callee executes
`receiveShielded` across the boundary on the published 0.19.0 runtime, and the
recipient never touches the coin with a wallet.

**The recipient is credited and the sender keeps the change.** Read back from the
indexer through the demo's own `readAccountState`: B's `coins[mUSD]` went from
nothing to **40**, A's from 100 to **60**. Neither figure came from the client's
own arithmetic; both are the contract ledgers as the chain serves them.

**Cross-contract needed no plumbing.** midnight-js 5.0.0-beta.7 wires the
callee-state resolver itself: `createUnprovenCallTx` ends in
`createUnprovenCallTxFromInitialStates(…, { publicDataProvider, blockHash })` on
both of its branches, and `createCircuitCallTxInterface` routes every
`callTx.<circuit>(…)` through it. The drill therefore calls
`callTx.transfer_shielded_to_account(peer, peerAddr, colour, amount)` exactly the
way the app calls `withdraw_night`, with no option and no wrapper, and it works.
The `crossContract` argument in the beta.7 API surface is for callers that build
a transaction from initial states by hand; the demo is not one of them.

**The old-build recipient qualifies on every check that precedes a payment.** The
chosen account, `fdb4c53168532c7e12726a41590d7e8b06486593b88f03ebd1441bb6b7e0ff50`,
is a real pre-upgrade Passport holding 100 mUSD, and its on-chain state carries
no `transfer_shielded_to_account` operation. The peer key the caller commits to
is the `deposit_shielded` key that account already carries, so nothing about the
callee side has moved. The payment itself did not land, but for the reason in
§2 rather than anything to do with the recipient — see §3.

**And one thing the client must stop doing.** `findDeployedContract` re-reads the
deployed contract's verifier keys and refuses a build that carries a circuit the
chain does not, by name:

```
TypeError: Following operations: transfer_shielded_to_account, are undefined
or have mismatched verifier keys for contract state ContractState (…)
```

So a new-build client **cannot connect to a pre-upgrade account at all**. The
demo's send path prepares the recipient's contract today
(`prepareAccountDeposit` → `findDeployedContract`, `identity/accountCustody.ts`),
and on the new build that call fails for every Passport deployed before the
upgrade. The one-transaction path does not need it — the recipient is an
argument, not a connection — and that is now a requirement rather than an
economy.

## 2. What failed: neither coin the transaction leaves can be spent (`Custom error: 217`)

`transfer_shielded_to_account` follows the MIP-0012 §6.3 rule for change: the
output `sendShielded` already routes back to the contract is live and
self-owned, so it is persisted as it stands, with no `sendImmediateShielded`
re-owning step. The re-owning step is what the deployed `withdraw_shielded`
does, and it is what was understood to produce node error 239. The drill was
built to check that the new rule does better. It does not — and the problem is
wider than the change.

Four attempts to move value that a cross-contract transfer had produced, all
refused by the node before inclusion:

| Attempt | Spender | Coin it is spending | Amount | Sponsor | Node |
|---|---|---|---|---|---|
| run 1, second transfer to B | A | its own change | 25 of 60 | one job in flight | `1010: Invalid Transaction: Custom error: 217` |
| run 2, 3a — the same operation again | A | its own change | 25 of 60 | **idle** | `1010: … Custom error: 217` |
| run 2, 3b — the whole remaining coin | A | its own change | 60 of 60 | **idle** | `1010: … Custom error: 217` |
| run 3, leg 4 — pay a pre-upgrade account | **B** | the credit it **received** across the boundary | 10 of 40 | **idle** | `1010: … Custom error: 217` |

That last row is the one that widens the finding. B's 40 mUSD did not come from
a change output at all: it arrived through B's own `deposit_shielded`, executed
as the callee inside the cross-contract transaction. Both sides of the transfer
end up holding a coin the node will not let them spend.

What follows from the rows:

1. **It is not the sponsor.** Run 1's refusal arrived while the balancer was
   carrying another job, which is the shape of the known `231`/`239` family the
   balancer already handles by waiting and rebuilding
   (`examples/passport-balancer/README.md`, "Rebuilding a transaction the node
   refused"). Runs 2 and 3 waited for `busy=false jobs=0` before every attempt
   and got the identical refusal. The fee leg is not what the node objects to.
2. **It is not the split.** Spending the change *whole* fails the same way, so
   this is not a change-of-change problem with an obvious "send whole coins"
   mitigation.
3. **It is not the sender's own bookkeeping.** The recipient's received coin
   fails too, and it was written by a different circuit in a different contract.
4. **It is not the proof.** Every one of these transactions was built, proved,
   and balanced successfully — the sponsor covered the fee and handed back a
   balanced transaction each time (`f13c17d370fdecf9…`, `886f5ce951c6c71e…`,
   `ee09e273f4bf5063…`). The refusal comes from the node's own validity check at
   submission, which is where a Zswap input that does not reconcile against the
   chain's commitment tree is caught.

The reading this points at — and which the next unit must confirm before it
writes any client code — is that the commitment-tree position recorded for a
coin produced inside a **two-call** transaction is not the position the chain
gave it. A cross-contract transfer emits outputs from both calls into one
commitment batch: the root's change and the callee's received coin. A coin
persisted with an index computed as though its own call were alone would prove
locally against the contract's own Zswap state and be refused on chain, which is
exactly the pattern observed. The reference experiment had to capture `mt_index`
from the indexer's commitment-tree window by hand for this very reason
(MIP-0012 §6.5, P7's `value-client/capture.ts`); nothing in the demo's client
does that today, because until now no coin it spent had come out of a multi-call
transaction.

**Nothing was lost.** A refused transaction is not included, so no value moved
and no fee was paid on any of the four attempts. A's 60 mUSD and B's 40 mUSD are
still recorded in their contract ledgers; they simply cannot be moved by this
circuit as it stands.

## 3. What is still open

- **Whether the deployed circuits can move these coins.** Only
  `transfer_shielded_to_account` was tried against them. If `withdraw_shielded`
  — which reads the same `coins` map and is the circuit every Passport already
  carries — can spend a post-cross-contract coin, the defect is in how the new
  circuit persists what `sendShielded` hands back; if it cannot, the coin
  descriptor itself is wrong and the whole transaction shape is implicated.
  This is the first thing to run next, and it needs no new deploy: `RESUME=1`
  reuses the pair already funded.
- **Error 217 has no name here.** The balancer knows `231`
  (`FeeCalculation.OutsideTimeToDismiss`) and `239` by their symptoms rather
  than a published table, and `217` is a third member of the same
  `1010: Invalid Transaction` family. Naming it is upstream's to answer, and
  the answer would settle §2 outright.
- **Paying a pre-upgrade Passport is argued, not shown.** The recipient passed
  every check that precedes the payment, and the transaction was refused for the
  reason above rather than anything about the callee. A payment from a coin that
  did *not* come out of a cross-contract transaction — an account funded by the
  sponsor and spending its activation grant directly — would settle it, and is
  worth running once §2 has an answer.
- **The first run's leg 4 also hit a transient.** The proof server answered
  `503 Service Unavailable` once
  (`https://67-205-177-162.sslip.io/prover/prove`). That is the droplet, not the
  circuit; the retry in run 3 proved and balanced normally.

### 3a. Read-only follow-up, the same day: what 217 is not

A second pass read the chain back without submitting anything
(`.live-drill/mtindex/`, four raw indexer responses and three small parsers).

- **The recorded `mt_index` is right.** For both runs, both coins: the index
  the contract wrote (`coins[mUSD].mt_index`) equals the position the node
  assigned in `zswapLedgerEvents` — run 2: B's credit 2624, A's change 2625;
  run 1: A's change 2619, B's credit 2620 — and the transaction's
  `zswapStartIndex`/`zswapEndIndex` bracket exactly those two. The output order
  even flips between the runs, and the client tracked it both times. The
  commitments recomputed with the contract's own `_coinCommitment_0` match the
  tree leaf for leaf.
- **Segments do not separate the cases.** Every contract-owned commitment in
  all four transactions, the two grants included, sits in segment 1, and the
  grant coins were spent successfully; every contract-owned nullifier sits in
  segment 0.
- **The one structural difference is the nonce.** The four stuck coins carry
  nonces `sendShielded` evolved in-circuit — 31 bytes of `transientHash`
  upgraded to `Bytes<32>`, so each ends in `0x00` — while both spendable
  control coins carry the 32-byte nonce their depositing wallet chose. The
  commitment is provably right either way; the nullifier, which is the half the
  node checks at spend time and which a read-only pass cannot recompute, is
  where the two paths could diverge. The deployed `withdraw_shielded`'s change
  coin is produced the same way, and its next spend is the long-standing
  `Custom error: 239`; 217 and 239 look like one defect seen from two circuits.
- **What has been ruled out, then:** wrong index, wrong segment, a stale
  sponsor, partial versus whole coin, and the callee's key. What is left is
  upstream's: how the node derives the nullifier of a contract-owned coin whose
  nonce was evolved in-circuit, against the one the runtime's
  `_coinNullifier_0` writes into the transcript. The refused transactions
  (`f13c17d370…`, `886f5ce951…` in run 2; `c1fc140d03…` in run 1) never reached
  a block, so the node's reason is only ever the number.

### 3b. The witness probe, the same day: it is not the coin, it is the second cross-contract call

§3a ruled out the index, the segment, the sponsor, and the split, and left the
nonce — with the reading that a coin produced inside a two-call transaction
carries a descriptor the node will not accept. The k1-arm branch of the account
contract (`nicolasdp/ecdsa-k1-arm`, the design MIP-0012 §6.5 normalises) offers
a different route to the same spend: the qualified coin description never comes
out of public ledger state at all. It enters the circuit through a `held_coin`
witness the client fills from what it captured off the chain, so the Merkle
position proved against is the client's, not the contract's. If 217 were a
disagreement about `mt_index`, that would fix it, and the fix would be ours.

It is not, and it does not need to be. **Both stuck coins move.** The defect is
narrower than §2 and §3a supposed, and it is not in the coin.

**The probe build.** `account_custody.compact` gained one witness and one
circuit:

```
witness held_coin(color: Bytes<32>): QualifiedShieldedCoinInfo;

export circuit withdraw_shielded_w(recipient, color, amount): []
```

`withdraw_shielded_w` is `withdraw_shielded` line for line with two changes: the
coin handed to `sendShielded` is `held_coin(c)` rather than `coins.lookup(c)` —
asserted equal to the ledger entry on nonce, colour, and value first, so the only
field the witness can change is the Merkle index — and the change follows the
§6.3 rule with no `sendImmediateShielded` re-owning step. The witness is
implemented client-side the way the demo implements `device_secret`:
`accountWitnesses()` reads a `heldCoins` record out of the account's private
state, and the harness fills it from the chain before the call. Compiled with
`compact compile +0.34.0` in the file's own two passes; **all twelve
pre-existing verifier keys stay `cmp` identical**, `deposit_shielded` included.

**The account contract is at its deployable ceiling.** A build carrying
`withdraw_shielded_w` *and* a matching `transfer_shielded_to_account_w` — 14
circuits, ~23.4 KB of verifier keys — is refused at deploy time:

```
1010: Invalid Transaction: Transaction would exhaust the block limits
```

Thirteen circuits (21,403 bytes of verifier keys, against the deployed build's
19,284) deploys normally. So the account contract has room for roughly one more
circuit and no more, and the probe had to drop
`transfer_shielded_to_account_w` — which is why §2's fourth row has no witness
counterpart here. This is a hard constraint on U4 and on anything that wants to
extend the account surface: **new circuits must displace old ones, and the
displaced ones cannot be circuits the sponsor's own build calls.** A 12-circuit
build that dropped `grant_withdraw_night` and `grant_withdraw_shielded`
deployed, but `/fund-account` then refused it —
`Following operations: grant_withdraw_night, grant_withdraw_shielded, are
undefined or have mismatched verifier keys` — because the balancer connects with
its own build. Any deployable account is a **superset** of the twelve circuits
already on chain, and a superset of twelve is at the ceiling.

**The probe, on a fresh pair.** C
`3790655e9fd9be1bc9ca7d75f62ea22f29597fd452bcba87326a29d8bce3af10` (deploy
`540c5758751504727c54aadfb185add5cc8a5becb5e92fc8e011bee4e269231a`) and D
`fa9d7db16056f28802789ba46c289c4aed9b9b4abf0f78941183516f19fd4ddd` (deploy
`eba096b5341bd5318b32ac9cf8ce0a671fbd30bcfcce7f822040572d7789a17b`), deploys
40.1 s. Activation grant `534122f1e3424091c4663c235bdd6af7f656d3b3c845ba67966c4f6b6f5c36c7`
(block 406686), 37.1 s, leaving C with 100 mUSD. The one-transaction transfer of
40 mUSD, `6d99a15344be200abcecd662139f93d0b8b15050b19b601037ee2bb982a8fdd8`,
**block 406695**, `SUCCESS`, 40.6 s — the third independent reproduction of §1,
and the two stuck coins now exist: D holds 40, C holds 60.

The capture, read straight off the chain (0.9 s), agrees with §3a for a third
pair. The transaction's zswap window is `[2663, 2665)`; its three Zswap events
decode as C's nullifier in segment 0, then two contract-owned commitments in
segment 1 — D's credit at **2663**, C's change at **2664** — and both equal the
`mt_index` the contracts wrote into `coins[mUSD]`.

| Attempt | Spender | Coin | Circuit | Coin from | Node |
|---|---|---|---|---|---|
| 4 | **D** | the credit it **received** across the boundary, 40 whole | `withdraw_shielded_w` | **witness**, index 2663 | `SUCCESS` — `d651888ee485038ccb72fd18b1a7bc38372a4d28744a8ea036ef6fc1551b3edd` (30.2 s) |
| C1 | **C** | its own **change**, 60 whole | `withdraw_shielded` (**deployed**) | **ledger** | `SUCCESS` — `eae2cd86d3289f7b519f24db07f5ce268c586b2ea2169a4c0c6a94db40b82df8` (35.5 s) |

The second row is the control, and it is the row that matters. It answers §3's
first open question outright, and it removes the witness from the explanation:
**the circuit every Passport already carries, reading the coin out of its own
public ledger entry with no witness anywhere, spends a post-cross-contract coin
that `transfer_shielded_to_account` refused.** Both accounts' `coins[mUSD]`
entries are gone afterwards; the value left the contracts and reached the drill
wallet.

What follows:

1. **The coin descriptor is right, and 217 is not about it.** Nonce, colour,
   value, index, segment, and commitment were already shown right in §3a; now the
   coin itself is shown *spendable*. The nonce `sendShielded` evolves in-circuit
   is not the problem, and neither is the change rule.
2. **The witness route is not needed.** It works — row 4 is a genuine §6.5 spend
   with a chain-captured index — but it is not what makes the difference, because
   the ledger-sourced circuit does the same job. Adopting `held_coin` for the
   demo would buy privacy (INV-2: the coin description leaves public state), not
   spendability, and it costs a circuit the contract cannot spare.
3. **What is actually broken is chaining.** Every 217 in §2 was a
   `transfer_shielded_to_account` — a *second* two-call transaction — spending a
   coin a *first* two-call transaction produced. A one-call spend of the same
   coin is accepted. The node's objection is to the second cross-contract call
   over such a coin, not to the coin.
4. **So nothing is trapped, and the finding is a ceiling rather than a wall.** A
   Passport that receives value in one transaction can pay it out through the
   two-transaction path the demo already ships. What cannot be done yet is two
   one-transaction transfers in a row.

**For the client work that follows.** §4's "this circuit must not reach a user"
can be relaxed to a rule with a reason: the one-transaction transfer is safe for
a coin that did **not** come out of a cross-contract transaction, and the sender
must fall back to the two-transaction path for one that did. A client can tell
the two apart from chain state it already reads — a coin whose `mt_index` sits
in the zswap window of a transaction with two contract actions is a chained one.
Whether that rule is worth the branch, or whether the demo should simply keep the
one-transaction send for the first hop and the old path for the rest, is U3's to
decide with §2's table and this one side by side.

**Still upstream's.** Why the node refuses the second cross-contract call. The
refusals never reached a block, so `217` is still only a number, but it is now
attached to a much smaller claim: a two-call transaction spending a coin another
two-call transaction created. That is a reproducible, minimal case worth handing
to the node team as it stands.

**Reproducing it.** The harness is `.live-drill/witness-spend-drill.ts`, built
and run exactly as §6 describes for the other drill. `RESUME=1` reuses C and D;
`CONTROL=1` runs the ledger-sourced control alone against whatever C still
holds. The probe build lives only in the scratch worktree and is not the demo's.

### 3c. 217 named and located: the callee's spends never reach the offer

Upstream decoded the number: `217` is the ledger's `EffectsCheck`
`NullifiersNeqClaimedNullifiers` (`ledger/src/ledger_9/types.rs:503`) — the
nullifiers in a segment's shielded offer do not equal the nullifiers the calls
claim in that segment. (`239` is `NullifierAlreadyPresent`.) With a name, the
defect is one read-only build away, and the run-2 pair still holds its stuck
coins: A `76232e38…0312` (60 mUSD, `mt_index` 2625) and B `26aef743…3a40`
(40 mUSD, `mt_index` 2624), both confirmed unspent on 2026/09/10.

Three transactions were **built and never submitted** (`.live-drill/segment-dump.ts`),
against the restored 12-circuit contract so `findDeployedContract` accepts the
deployed accounts. Every offer input and every call's claimed nullifiers, per
segment:

| Tx | Offer inputs (segment) | Call | Claims in guaranteed (segment 0) |
|---|---|---|---|
| **(a)** A→B 25 | **one**, seg 0: `46f14475…b9e3` (A's coin) | `A.transfer_shielded_to_account` | `46f14475…b9e3` ✓ in offer |
| | | `B.deposit_shielded` | `26d2581f…1519`, `9a3e7692…fc43` — **neither in the offer** |
| **(b)** B→A 25 | **one**, seg 0: `9a3e7692…fc43` (B's coin) | `B.transfer_shielded_to_account` | `9a3e7692…fc43` ✓ in offer |
| | | `A.deposit_shielded` | `46f14475…b9e3`, `7d227d8a…21f8` — **neither in the offer** |
| **(c)** A withdraw 60 | **one**, seg 0: `46f14475…b9e3` | `A.withdraw_shielded` | `46f14475…b9e3` ✓ in offer |

No transaction has a fallible transcript at all — every call is entirely in
segment 0 — so **this is not a segment-routing mismatch. It is a missing
input.** For (a) the segment-0 claimed set has three nullifiers and the
segment-0 offer has one; for (b), likewise; for (c) the two sets are the same
single nullifier, which is why it balances and why every single-call spend in
§3b passed.

**Whose nullifiers are missing.** In (a), `9a3e7692…fc43` is exactly the offer
input of (b) — it is B's own 40 mUSD coin. The second, `26d2581f…1519`, is the
coin A is sending. Both are spent by the callee, because `deposit_shielded`
takes its **merge** branch when the recipient already holds that colour:

```
if (coins.member(c)) { mergeCoinImmediate(coins.lookup(c), coin); … }
```

`mergeCoinImmediate` spends the held coin *and* the arriving one to mint the
merged coin, and each spend claims a nullifier. Neither becomes a `ZswapInput`
in any offer.

**Where midnight-js drops them.** `createUnprovenCallTxFromInitialStates` ends:

```js
const segmentedOffers = zswapStateToSegmentedOffer(
  nextZswapLocalState, encryptionPublicKey,
  { contractAddress: rootCall.contractAddress, zswapChainState },
  rootCall.public.partitionedTranscript);        // ← ROOT call only
```

The shielded offers are assembled from the **root** call's address, chain state,
and transcript. The comment eleven lines above fixes exactly this bug class for
unshielded outputs — *"a user-addressed unshielded output can be produced by any
call in the tree… Assembling them from the root call alone would drop a callee's
payout and leave the transaction unbalanced (rejected on submission)"* — and
does so with `calls.flatMap(…)`. The shielded path never got the same treatment,
so a callee's spends are dropped and the transaction is unbalanced in precisely
the way that comment predicts.

**This explains every 217 on record, and why the first transfer always works.**
When the recipient holds no coin of that colour, `deposit_shielded` takes the
`else` branch — `insertCoin` alone, no merge, **no nullifier claimed** — so the
claimed set matches the one-input offer and the transaction is accepted. That is
§1's every success: B was empty. The moment the recipient already holds that
colour, the merge branch claims two nullifiers the offer does not carry, and the
node refuses with 217. §2's four rows are all of the second kind (B held 40;
the pre-upgrade account held 100), and so is a chained transfer, which is why
§3b saw chaining fail while every single-call spend passed.

**So it is a client-side defect, not a node or contract one.** The contract is
correct, the coin is correct, the index is correct. midnight-js builds an
unbalanced transaction whenever a callee spends anything. The fix is upstream's
one-line shape — aggregate the shielded offer across every call in the tree, as
the unshielded path already does — and until it lands, the demo's rule is:
**a one-transaction transfer is safe only into a recipient that holds no coin of
that colour.** That is a fact the sender can read from the recipient's public
ledger before choosing the path.

### 3d. Fixed, and chained on chain: the offer is now the union over the call tree

§3c named the defect and located it in the client. This is the fix, and the four
legs that settle it. **Everything §2 reported as broken now works**, on the same
two accounts, in one sitting: A `76232e38…0312` and B `26aef743…3a40`, both
still holding the stuck coins from run 2.

**The fix, in one sentence.** The shielded offers are assembled from every call
in the tree rather than from the root call alone — the same treatment the
unshielded path already gives its outputs, for the reason its own comment gives.

It is two patches, both `patch-package`, both at the repository root, and both
dated 2026/09/10. `patches/@midnight-ntwrk+compact-js+2.5.5-rc.8.patch` is 26
added lines and removes nothing: compact-runtime 0.19.0 already stamps each
call's own Zswap local state onto its `callProofDataTrace` entry, and compact-js
was dropping the field on the way out, so midnight-js could not have built the
right offer even had it tried. One field, decoded with the runtime's own
`decodeZswapLocalState`, carries it through.
`patches/@midnight-ntwrk+midnight-js-contracts+5.0.0-beta.7.patch` is 103 added
against 53 removed, in one file, and most of the removals are the original loop
bodies moving one level of indentation inwards. It does three things:

- **The offer builder takes a list of per-call states.** Each entry carries its
  own contract address, its own Zswap local state, its own partitioned transcript
  for segment routing, and its own Zswap chain state. All four have to be the
  call's own: a contract-owned nullifier is derived against the commitment tree of
  the contract that *owns* the coin, so the root's chain state will not do, and
  segment routing must consult the transcript that claims the item.
- **Outputs are collected across the whole tree before any input is paired.**
  That is what turns the root's `sendShielded` to the callee and the callee's
  spend of it into one transient rather than an unmatched output and an unmatched
  input.
- **`makeCalleeStateResolver` fetches the callee's Zswap chain state** alongside
  its contract state, in a single `queryZSwapAndContractState` pinned to the same
  block, so the tree is still read from one coherent snapshot and the resolver's
  laziness and memoization are untouched.

**The single-call path is unchanged, and that is checked rather than argued.**
`zswapStateToSegmentedOffer` now delegates to the new function with a one-element
list, over the original loop bodies. Rebuilding (c) from §3c on the patched and
the unpatched builds from a *pinned* wallet seed produces the same input
nullifier (`46f14475…b9e3`), the same output commitment
(`601e3f3f…d1d7`), and the same claimed sets — an identical projection, line for
line. (Without a pinned seed the two differ in the output commitment alone, and
only because `withdraw_shielded` evolves its nonce from the recipient: a
different drill wallet, not a different build.)

**(1) The rebuilt offer, still unsubmitted.** `.live-drill/segment-dump.ts`,
(a) A→B 25, against the patched build. The segment-0 claimed set had three
nullifiers and the offer one; it now has all three, and the offer's commitments
are complete too:

| | Claimed in segment 0 | In the offer |
|---|---|---|
| `A.transfer_shielded_to_account` | `46f14475…b9e3` | ✓ input, contract A |
| `B.deposit_shielded` | `9a3e7692…fc43` | ✓ input, contract B — B's held 40 |
| | `26d2581f…1519` | ✓ **transient**, contract B — the arriving 25 |

Commitments: `38548ff7…4ad4` (A's change, 35), `a5ed6e33…81c5` (B's merged 65),
and the transient's `8b61f220…974f` (the 25 in flight). Nothing claimed is
missing, and nothing in the offer is unclaimed. The per-call Zswap local states
the dump now prints say the rest plainly: B's `deposit_shielded` has **two**
inputs — its held coin at `mt_index` 2624 and the arriving coin — and it was the
second of those that had nowhere to go.

**(2)–(4) Submitted, and accepted.** Every fee the sponsor's, `/balance-only`,
the balancer idle before each leg. Nothing was deployed and no grant was asked
for.

| Leg | Transaction | Block | Result | Time |
|---|---|---|---|---|
| **2.** A → B **25**, into a recipient that already holds 40 — §2's first row, the shape that produced 217 every time | `a4002bcc3011d1ea06de9ee74023fe3f186e8a558575030bf0145fe577add48d` | **406994** | `SUCCESS`, two contract actions — B `coins[mUSD]` **65** (merged), A **35** | 40.6 s |
| **3.** B → A **20** — *chained*: both coins came out of a two-call transaction | `3ea0061e048ea7c7c66c28880d092cbfa060de4e5b4d854992efd855f764b1fb` | **407000** | `SUCCESS`, two contract actions — A **55**, B **45** | 36.1 s |
| **4.** A `withdraw_shielded` the whole **55** to the drill wallet (the control) | `34237d710d41708710a3637b6fdc1ea6e55f58e2152d3b4925ead07f2d5b78e6` | **407006** | `SUCCESS` — A's `coins[mUSD]` gone, value in the wallet | 35.4 s |

Nine checks, nine passes, first attempt, no retry and no error code to look up.
Both contract actions are named in the indexer for legs 2 and 3, the callee's
`deposit_shielded` included, and the ledgers were read back through the demo's
own `readAccountState` rather than the client's arithmetic. A whole run —
wallet sync, three legs — takes about three minutes.

What follows, and what has to be rewritten:

1. **§2 is closed, and §3b's ceiling with it.** "What cannot be done yet is two
   one-transaction transfers in a row" was leg 3, and it passed. There is no
   chaining rule to implement, no branch on the recipient's ledger, and no
   fallback to the two-transaction path. §4's "this circuit must not reach a
   user" and §3b's "safe only into a recipient that holds no coin of that
   colour" are both superseded by this section.
2. **The contract was never at fault, and neither was the node.** Both were
   already right in §3b's reading; §3c located the defect in the client, and a
   client-side patch is the whole of the fix. Nothing was recompiled and nothing
   was redeployed for any of this.
3. **The demo now carries two patches, and they are load-bearing.**
   `patch-package` runs from a root `postinstall`, so the builder's `npm ci`
   applies them too. Both are filed upstream —
   `docs/demo/midnight-js-callee-offer-issue.md` is the issue text, against
   midnight-js #967 / #1025 — and both should be dropped the moment a published
   beta carries the fix. The version sits in each filename, so a bump makes
   `patch-package` fail loudly rather than skip quietly.
   `examples/passport-funder` is deliberately *not* patched: it nests its own
   ledger-8 copies of both packages, and patch-package only reaches the root.
4. **Still not shown: paying a pre-upgrade Passport.** §3's third open question
   is untouched by this. The defect that refused it in run 3 is fixed — that
   account held 100 mUSD, so it was a merge, the second kind — but the payment
   itself has not been re-run.

**Gates.** `npx tsc --noEmit` clean and `npm test` 1,304 passed across 53 files
in `examples/passport-demo`, both before and after a full `npm install` through
the new `postinstall`. `npm ls @midnight-ntwrk/midnight-js-contracts` at the root
reports one copy of 5.0.0-beta.7, patched, with the funder's 4.0.4 nested beneath
it and untouched.

**Reproducing it.** `.live-drill/one-tx-chain-drill.ts`, built and run exactly as
§6 describes for the other drills. It deploys nothing and asks for no grant; it
reads the pair out of `.live-drill/one-tx-state.json` and needs them funded.
`.live-drill/segment-dump.ts` takes a `DRILL_SEED` now, which is what makes the
single-call comparison above reproducible.

## 4. What this licenses

Proven, on chain, twice:

- a Passport can pay another Passport in **one** transaction, sponsored, with
  the recipient's contract ledger credited in the same block;
- midnight-js beta.7 resolves the callee's state without being asked, so the
  demo's client needs no cross-contract option;
- the recompiled contract's other eleven circuits are untouched — both pairs of
  accounts were deployed, funded through `/fund-account`, and read back through
  the demo's own code paths without a single change to them.

Not proven, and not to be claimed:

- that the transfer is **usable**. One transfer works; the second one from
  either side does not. A send that leaves both parties unable to move what they
  hold is worse than the two-transaction send it replaces, and there is no
  "whole coins only" workaround — that was tried and refused. Until §2 is
  resolved, this circuit must not reach a user.
- that a pre-upgrade Passport can be paid this way. See §3.

**For the client work that follows.** Two things are already settled and can be
built on whatever §2 turns out to be. The recipient must be reached as an
*argument*, never as a connection: `findDeployedContract` refuses a pre-upgrade
account outright under the new build, so the send path's existing
`prepareAccountDeposit` prewarm cannot run against one. And the one-transaction
branch must be chosen from the **sender's** on-chain state — whether its
contract carries a `transfer_shielded_to_account` operation — because that is
the only fact a client can read that says which build it is talking to.

## 5. The runs, in full

Three runs: two complete ones on independent pairs of accounts, and a third
that re-ran the pre-upgrade payment alone against run 2's pair.

Run 1, on its own pair, with the same outcome as run 2. Every fee was the
sponsor's; the wallet was a fresh seed that never held NIGHT or DUST.

| Stage | Evidence | Time |
|---|---|---|
| wallet bring-up and sync | fresh seed, from genesis | 57.7 s |
| deploy A `636690ac7391783790199ca59454a28c4f4b1f69e329c39946e46d3033ca2415` | tx `47f5ea8b5274e251e8e4ca8e8e088e6ab57cfa24ab63af4336e90ad2d9c67594` | 40 s |
| deploy B `35cd057566bd51bc61fa6525abac1bec1947b10e0f7af899ffd6365269bf163e` | tx `92669924cf170a438ce5952159474c5ccbe8f9cb128e591796c3eafb8c835d8a` | (same leg) |
| activation grant into A | NIGHT `4a58fc33d5c73ed1383cab145bf53986cebbd626aa33df09aa13fca482bf6866` (block 402234), mUSD `7f773f7c9ae2882a3fb5f7b616468d43bb66b32c74153b3b890b2986fc734ada` | 42.5 s |
| **transfer 40 mUSD, A → B, one transaction** | tx `585d08871ca668eea07049c9bb16e4a6e646879d03e3181190ee36a3866180d6`, block **402248**, `SUCCESS`, two contract actions | 65.6 s |
| ledgers read back | B `coins[mUSD]` = 40, A `coins[mUSD]` = 60 | — |
| spend the change (25 of 60) | refused: `1010: Invalid Transaction: Custom error: 217` | 22.7 s |

Run 2's pair, for the record: A
`76232e38e61923e22eacd098bac5953e9c42e2599deac8ba14617bc79e920312` (deploy
`a27f0be1728556693b625c3769a0aa570c90e716c38a483a85da18c1031c20ba`) and B
`26aef743602f1bd50bb3c41ac9d106635781e8eaf35b3c7903e3c6f2d4913a40` (deploy
`1ba68bea486db9e11ff1bb7b1b035630a9f8bbc936e77884b432c7b05b0a7a95`), activation
grant `c975ec8b951cffc78c88261ca5c60a4284425212c60254ba246d78f1a179e6a5` (NIGHT,
block 402325) and `f76c866d343d59370cef90830a3f636876a5f994df2a7c75195a1f19c0ba5f26`
(mUSD). Timings: deploys 45.6 s, grant 37.1 s, the transfer 40.9 s. A whole run
— wallet sync, two deploys, an activation grant, the transfer, and the ledger
reads — takes about four minutes.

Run 3 (`RESUME=1 ONLY_LEG4=1`, run 2's pair) paid 10 mUSD from B to the
pre-upgrade account `fdb4c53168532c7e12726a41590d7e8b06486593b88f03ebd1441bb6b7e0ff50`.
Proved and balanced as `ee09e273f4bf5063a1a1156a3a50a0c4114d27d1903517ec7887ab17173ad482`,
refused by the node with `Custom error: 217` — the fourth row of §2's table, and
the one that showed the received coin is no more spendable than the change.

## 6. Reproducing it

```
cd examples/passport-demo
npx esbuild .live-drill/one-tx-transfer-drill.ts --bundle --format=esm \
  --platform=node --target=node22 --outfile=.live-drill/one-tx-transfer-drill.mjs \
  --define:import.meta.env=globalThis.__DRILL_ENV__ \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
node .live-drill/one-tx-transfer-drill.mjs
```

Two things in that command are load-bearing, and both are the passport-bench's
(`examples/passport-bench/scripts/build.mjs`) for the same reasons. `import.meta
.env` is rewritten to a global, because every app module the drill drives —
`localWallet.ts`, `sponsor.ts`, `contractRuntime.ts` — reads its configuration
from it and nothing supplies it under Node. And the bundle is not
`--packages=external`: the ledger and onchain-runtime wasm has to be inlined for
the wallet to open, which is why `.live-drill/` carries symlinks to the two
`.wasm` files beside the bundle.

The ZK artefacts are served over HTTP from a throwaway static server the harness
starts over `public/`, and `PASSPORT_ZK_ORIGIN` names it — `contractAssetBase`'s
Node path. A harness must **not** fake a `window` instead: a partial stub flips
the wasm runtime's environment sniffing into browser paths and circuit execution
dies in an `unreachable` trap.

`RESUME=1` reuses the pair recorded in `.live-drill/one-tx-state.json` rather
than deploying and funding another, and `ONLY_LEG4=1` alongside it re-runs the
pre-upgrade payment alone. Both files are gitignored, and the state file holds
the two root secrets, so it is throwaway stagenet material and nothing else.
