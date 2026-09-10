# One-transaction Passport → Passport transfer on stagenet — the drill, and what it settles

**Date:** 2026/09/10
**Network:** Midnight stagenet (node 2.0.0, chain tip ~402,350 blocks)
**Harness:** `examples/passport-demo/.live-drill/one-tx-transfer-drill.ts` (disposable, gitignored)
**Result:** the one-transaction transfer **works, once**. One transaction, two
contract calls, the recipient's ledger credited and the sender's change
recorded — reproduced on two independent pairs of accounts. But **neither coin
the transaction produces can be spent afterwards**: the sender's change and the
recipient's credit are both refused by the node with `1010: Invalid Transaction:
Custom error: 217` on the next `transfer_shielded_to_account`, whole or in part,
with the sponsor idle. Value goes across the boundary and does not come back
out. That is the finding, and it blocks adoption until it is understood.

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
