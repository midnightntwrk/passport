# Shielded send on preview — the drill, and what it settles

**Date:** 2026/08/22
**Network:** Midnight preview (chain tip ~534,000 blocks)
**Harness:** `examples/passport-demo/.live-drill/shielded-send-drill.ts` (disposable, gitignored)
**Result:** all checks passed — a shielded transfer from one Passport wallet's
shielded account to another wallet's `mn_shield-addr…` address works end to end
with the wallet SDK as shipped.

This note exists because the Otrix totem flow turns on a question nobody in the
repository had answered with a transaction hash: can Passport pay a shielded
deposit address? It can. It cannot, however, pay one with NIGHT, and that second
half is the part that shapes the user interface.

## 1. NIGHT cannot be shielded

`@midnight-ntwrk/ledger-v8` 8.0.3 types a token as
`{ tag: 'unshielded' | 'shielded' | 'dust', raw }`, and `nativeToken()` returns

```
{"tag":"unshielded","raw":"0000…0000"}
```

while `shieldedToken()` returns the same `raw` under `tag: "shielded"`. The tag
is not decoration: `Transaction.imbalances(segment, fees)` is keyed by the full
`TokenType`, so an unshielded NIGHT input paired with a shielded NIGHT output
leaves *two* non-zero imbalances rather than cancelling, and the node's balance
check refuses it.

Nothing in the wallet SDK crosses that boundary either. The surface was searched
in full:

- `WalletFacade.transferTransaction(outputs, keys, options)` takes
  `CombinedTokenTransfer[]`, whose members are a `shielded` group of
  `TokenTransfer<ShieldedAddress>` and an `unshielded` group of
  `TokenTransfer<UnshieldedAddress>`. Each group is handed to its own component
  wallet — `this.shielded.transferTransaction` and
  `this.unshielded.transferTransaction` — and the two results are merged. Each
  side must balance from its own funds; neither converts.
- `WalletFacade.initSwap(desiredInputs, desiredOutputs, …)` looks like a
  candidate and is not one. It dispatches the shielded and unshielded halves to
  `this.shielded.initSwap` and `this.unshielded.initSwap` separately, so it
  composes an *atomic swap between two parties*, not a conversion for one.
- There is no `shield`, `unshield`, `deshield`, or equivalent anywhere in
  `wallet-sdk-facade`, `wallet-sdk-shielded`, `wallet-sdk-unshielded-wallet`,
  `wallet-sdk-dust-wallet`, or `wallet-sdk-capabilities`.

The prototype already knew this and wrote it down:
`experiments/account-custody-prototype/contracts/faucet.compact` opens with
"Shielded tokens on a fresh localnet can only originate from a contract mint
(`mintShieldedToken`)". The drill takes that at its word and mints its own.

**Consequence for the demo.** A Passport that holds only NIGHT has nothing to
pay a shielded address with. That is not a defect to be papered over; it is what
the Send sheet now says.

## 2. What the drill did

Two brand-new raw-seed wallets, neither ever funded, synced from genesis against
preview in parallel (1,330 s — both, on one machine). Every fee below was
covered by the ProofStation sponsor at `https://api-preview.1am.xyz`, so neither
wallet ever held NIGHT or DUST.

1. **Faucet deployed from the payer**, fee sponsored.
   Contract `a66620c03d89847bf0f36d221100a65c989bf4190eb88543e47132a8f7f3f81f`.
2. **500 shielded units minted** to the payer's own coin public key, fee
   sponsored. Transaction
   `8968eaef7eb96feae1f8bccb729a812eb9eeeff7fee05bab97b52f533ddc62df`, served by
   the preview indexer. The on-chain colour is
   `rawTokenType(0x06…, faucetAddress)` =
   `cd4cedbb15ebb18aa2d2ced56f4b40af8fba9d295b738a86c1bfb9df30d2bc8b`; the payer's
   `state.shielded.balances` carried 500 of it.
3. **Shielded transfer, payer → recipient's shielded address**, built exactly the
   way `localWallet.ts` builds the sponsored NIGHT transfer, with the sole
   difference being the `type: 'shielded'` output group:

   ```
   transferTransaction([{ type: 'shielded', outputs: [...] }], keys, { ttl, payFees: false })
     → balanceUnprovenTransaction(tokenKindsToBalance: ['shielded', 'unshielded'])
     → signRecipe → finalizeRecipe
     → POST /balance-only        ← the sponsor attaches the DUST leg
     → submitTransaction
   ```

   Transaction `fe73195bf59636db180581a9c682123ec4c1a508807b030284b873ca1ca34b25`,
   **included in block 534314** per the preview indexer.
4. **Verified from the recipient, not the sender.** The recipient wallet — a
   separate facade with separate keys, which had held zero of the colour
   beforehand — indexed the note and reported 500. The payer's balance went to
   zero.

Recipient address paid:
`mn_shield-addr_preview1phjj3py5erngted99vwnpz98m7cn06lgqx3jstc05d5tes5vscxafmqgap0r8gefw9evsqmcd5yks4rr7cdxjqq3t4ln60m29yvelwsjspuc8`

## 3. What this licenses, and what it does not

Proven:

- the SDK's shielded output path works on preview against a real recipient;
- fee sponsorship covers it unchanged — `BALANCE_WITHOUT_DUST` already lists
  `shielded`, so the wallet balances the shielded leg locally and the sponsor
  adds only the fee;
- a shielded colour is discoverable from `state.shielded.balances` and spendable
  by its raw type.

Not proven, and deliberately not claimed anywhere in the demo:

- that a Passport user has any shielded token to send. On preview nothing mints
  one to them, so the Send sheet's shielded mode will honestly report an empty
  holdings list until Otrix (or another contract) mints one.
- anything about shielded NIGHT, which does not exist — see §1.
- browser proving of a shielded transfer. The drill proved on the preview proof
  server; the in-tab zkir-v2 path was not exercised for this shape.

## 4. Reproducing it

```
cd examples/passport-demo
npx esbuild .live-drill/shielded-send-drill.ts --bundle --format=esm \
  --platform=node --packages=external --outfile=.live-drill/shielded-send-drill.mjs
node .live-drill/shielded-send-drill.mjs
```

Budget around 25 minutes, almost all of it the two from-genesis syncs. The
faucet's ZK artefacts are read straight off disk from
`experiments/account-custody-prototype/contracts/managed/faucet`; the compiled
contract module is imported by a literal relative specifier so esbuild inlines
it and exactly one `@midnight-ntwrk/compact-runtime` is in play — the same trap
`examples/passport-funder/src/midnames.ts` documents.
