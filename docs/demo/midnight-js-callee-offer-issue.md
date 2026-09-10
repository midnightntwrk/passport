# A cross-contract callee's shielded spends never reach the transaction's offer

**Filed against:** `@midnight-ntwrk/midnight-js-contracts` 5.0.0-beta.7, with a
companion defect in `@midnight-ntwrk/compact-js` 2.5.5-rc.8.
**Related:** midnight-js #967 (the cross-contract call path), #1025 (the callee
state resolver).
**Date:** 2026/09/10.
**Network the reproduction ran on:** Midnight stagenet, node 2.0.0.

This is the issue text, written to be filed as it stands.

## Summary

`createUnprovenLedgerCallTx` assembles a transaction's shielded offers from the
**root** call's Zswap local state alone. Any coin operation performed by a
cross-contract **callee** is therefore missing from the transaction: the
callee's spends produce no `ZswapInput`, and the coins it mints produce no
`ZswapOutput`. The calls' transcripts still claim them, so the ledger's
`EffectsCheck` finds the segment's claimed nullifiers unequal to the offer's and
refuses the transaction with `NullifiersNeqClaimedNullifiers`, surfaced by the
node as `1010: Invalid Transaction: Custom error: 217`.

The same file already fixes this bug class for **unshielded** outputs, eleven
lines above, and says why:

> A user-addressed unshielded output can be produced by any call in the tree, not
> just the root, and every call's transcript is attached to the intent above. The
> transaction has a single guaranteed and a single fallible unshielded offer, so
> each must aggregate the user-addressed outputs across all calls, per segment.
> Assembling them from the root call alone would drop a callee's payout and leave
> the transaction unbalanced (rejected on submission).

The shielded path never got the same treatment.

The failure is silent at build time and at proving time. The transaction builds,
proves, and balances; only the node refuses it, and only with a number.

## Why it is not seen more often

A callee only spends when its circuit takes a branch that spends. The common
case — a callee that receives into an empty slot — takes an insert-only branch,
claims no nullifier, and the one-input offer matches. The defect appears the
moment the callee **merges**, which is the ordinary case as soon as a recipient
already holds a coin of the colour being sent.

## Minimal reproduction

Two deployed contracts, `A` and `B`, of the same Compact source. Each holds a
map of shielded coins by colour and exposes:

```compact
export circuit transfer_shielded_to_account(
  peer: ContractAddress, peer_ref: ContractAddress, c: Bytes<32>, amount: Uint<64>
): [] {
  const held = coins.lookup(c);
  const sent = sendShielded(held, right<ZswapCoinPublicKey, ContractAddress>(peer), amount);
  // change follows MIP-0012 §6.3: the live self-owned output is persisted as it stands
  ...
  peer_ref.deposit_shielded(c, sent);      // the cross-contract call
}

export circuit deposit_shielded(c: Bytes<32>, coin: ShieldedCoinInfo): [] {
  receiveShielded(coin);
  if (coins.member(c)) {
    // THE BRANCH THAT BREAKS: mergeCoinImmediate spends the held coin AND the
    // arriving one to mint the merged coin, claiming a nullifier for each.
    coins.insert(c, mergeCoinImmediate(coins.lookup(c), coin));
  } else {
    coins.insert(c, coin);
  }
}
```

1. Fund `A` with 60 of colour `c` and `B` with 40 of the same colour.
2. Call `A.transfer_shielded_to_account(B, B, c, 25)` through
   `createUnprovenCallTx` / `createCircuitCallTxInterface` — no cross-contract
   option is needed, the resolver is wired by default.
3. Submit.

**Expected:** one transaction, two contract calls, `B` credited 65 (merged) and
`A` left with 35.

**Actual:** `1010: Invalid Transaction: Custom error: 217`
(`NullifiersNeqClaimedNullifiers`).

Step 3 is not required to see it. Building the transaction and reading it back
is enough:

| | segment-0 claimed nullifiers | segment-0 offer inputs |
|---|---|---|
| `A.transfer_shielded_to_account` | `46f14475…b9e3` | `46f14475…b9e3` |
| `B.deposit_shielded` | `9a3e7692…fc43`, `26d2581f…1519` | — |

Three claimed, one carried. The offer's commitments are short in the same way:
`B`'s merged output (`a5ed6e33…81c5`) is claimed by `B`'s transcript and appears
in no offer.

If `B` holds nothing of colour `c`, the same call succeeds — the `else` branch
claims no nullifier — which is why a first transfer into an empty recipient
always works and every later one fails.

## Where it happens

`node_modules/@midnight-ntwrk/midnight-js-contracts/dist/index.js`, the tail of
`createUnprovenLedgerCallTx`:

```js
const segmentedOffers = zswapStateToSegmentedOffer(
  nextZswapLocalState, encryptionPublicKey,
  { contractAddress: rootCall.contractAddress, zswapChainState },
  rootCall.public.partitionedTranscript);        // ← ROOT call only
```

`nextZswapLocalState`, `rootCall.contractAddress`, `zswapChainState`, and
`rootCall.public.partitionedTranscript` are all the root's. No callee's state is
consulted.

There is a second, enabling defect. The runtime keeps one Zswap local state per
contract in the tree and stamps it onto every `callProofDataTrace` entry
(`@midnight-ntwrk/compact-runtime` 0.19.0, `circuit-context.js`,
`finalizeCallProofData`). `compact-js`'s `ContractExecutable.circuit` maps that
trace into the `ContractCall` entries midnight-js consumes and **drops the
field**, so as things stand midnight-js could not build the correct offer even
if it tried.

## The fix

Two changes, both additive.

**`compact-js` — surface what the runtime already keeps.** In
`ContractExecutable.circuit`'s trace-to-`ContractCall` mapping, carry the entry's
own state through:

```js
zswapLocalState: decodeZswapLocalState(entry.zswapLocalState),
```

and declare it on `ContractExecutable.ContractCall`.

**`midnight-js-contracts` — make the offer the union over the call tree.**
Generalise the offer builder from one Zswap local state to a list of per-call
states. Each entry carries four things, and all four have to be the call's own:

- its **Zswap local state** — the coins that call consumed and produced;
- its **contract address** — a contract-owned input is owned by the contract that
  spends it, not by the root;
- its **Zswap chain state** — `ZswapInput.newContractOwned` derives the nullifier
  against the commitment tree of the owning contract, so the root's will not do;
- its **partitioned transcript** — segment routing must consult the transcript
  that claims the item.

Order matters: collect **every** call's outputs first, then pair **every** call's
inputs against that whole set. The root's `sendShielded` output to the callee is
spent by the callee's merge in the same transaction, so it must become one
`ZswapTransient.newFromContractOwnedOutput` (with the callee as owner) rather
than an unmatched output and an unmatched input. What is left after pairing
becomes `ZswapInput.newContractOwned(coin, segment, calleeAddress,
calleeChainState)` and `ZswapOutput.newContractOwned(coin, segment, ownerAddress)`.

The callee's chain state has to be fetched. `makeCalleeStateResolver` currently
calls `queryContractState`; `queryZSwapAndContractState(address, { type:
'blockHash', blockHash })` returns both halves in one request, pinned to the same
block the root's states were read at, so the whole tree still comes from one
coherent snapshot and the resolver's laziness and memoization are unchanged.
(Item 1 of #1025 concerns that query's coherence guard; the guard is what makes
this safe, since the query returns `null` rather than a partial answer when the
contract does not exist as of the block.)

Keep the single-call path exactly as it is. Making `zswapStateToSegmentedOffer`
delegate to the new function with a one-element list does that by construction.

## What was measured after the fix

Patched locally with `patch-package` and re-run against the same two stagenet
accounts, one leg after another, all sponsored, all `SUCCESS`:

| Leg | Transaction | Block | Result |
|---|---|---|---|
| `A → B` 25, into a recipient holding 40 | `a4002bcc3011d1ea06de9ee74023fe3f186e8a558575030bf0145fe577add48d` | 406994 | `B` = 65 (merged), `A` = 35 |
| `B → A` 20, both coins from a two-call transaction | `3ea0061e048ea7c7c66c28880d092cbfa060de4e5b4d854992efd855f764b1fb` | 407000 | `A` = 55, `B` = 45 |
| `A.withdraw_shielded` whole 55 (control) | `34237d710d41708710a3637b6fdc1ea6e55f58e2152d3b4925ead07f2d5b78e6` | 407006 | `A` empty, value in the wallet |

The rebuilt `A → B` offer carries all three nullifiers: `A`'s coin, `B`'s held
coin, and — as a transient — the arriving coin.

The single-call path is unchanged. Rebuilding `A.withdraw_shielded` from a
pinned wallet seed on the patched and unpatched builds produces the same
nullifier, the same output commitment, and the same claimed sets.
