# Multiple shielded coins per asset

**Client correction dated 2026/11/10.** Audit finding `CUST-01`, task
`TODO-CUST-01`. This change concerns the reference wallet's private coin
store and spend selection. It does not change the Compact contract, ledger
layout, or signature recipes.

## Retaining and selecting holdings

The previous store used one entry per token colour. Capturing another coin
of that colour replaced the earlier description. The version 2 store retains
each coin under a stable identity made from its nonce, colour, and value.
`mt_index` qualifies a coin for a particular spend and is excluded from its
identity, so correcting a candidate index updates that coin without adding
a duplicate or replacing another holding.

The JSON-safe representation contains:

| Field | Meaning |
|---|---|
| `version: 2` | Private store format, independent of the contract's `spec_version` |
| `coins[id]` | Live qualified description, with hex bytes and decimal integer strings |
| `coinsByColour[colour]` | Derived lookup of the live identities for that colour |
| `spentCoins[id]` | Locally recorded retirement of that exact coin |
| `encSecretKeyHex` | Existing viewing capability, retained during migration |

The identity and descriptions are private wallet data. Keep them with the
private state rather than publishing them as an asset inventory.

`coinId(coin)` and `coinsForColour(state, color)` are exported from
[`witnesses.ts`](src/wallet/witnesses.ts). `account.heldCoin(color, id)` returns
the selected qualified description. Omitting the identity works only when
exactly one live coin matches. Several matching coins produce an explicit
ambiguity error; the wallet does not silently select one or aggregate inputs.
The selected coin must itself cover the requested amount.

For an owner-authorised spend:

```ts
import { coinId, coinsForColour } from './wallet/witnesses.js';

const holdings = coinsForColour(await account.coinStore(), color);
// Present these holdings and let the caller choose a suitable individual coin.
const chosen = holdings[selectedIndex];
const result = await account.withdrawShielded(
  device, recipient, color, amount, coinId(chosen),
);
```

`withdrawShieldedToContract` accepts the same final identity argument.
The two shielded `withdraw*WithGrant` methods accept `ShieldedGrantOptions`,
with `coinId` in their existing final options object. A deliberately
non-expiring grant may pass `{ coinId }` alone.
Finite grants still require the node-head reader and measured budgets
described in the [grant guide](README.md#grant-preflight-and-explicit-expiry).

## Signature, witness, and local retirement

High-level shielded spending pins the complete qualified description,
including `mt_index`, before signing. The witness checks and uses that
snapshot. A retry cannot silently substitute another coin or index under
the same authorisation. The raw shielded `*WithAuth` and `*WithGrantAuth`
methods accept an optional final `QualifiedCoin` snapshot; callers preparing
authorisation separately should pass the exact snapshot they signed.
Omission requires a unique live coin of the requested colour.

The exposed `account.callTx` surface has no extra selection argument. Use
the typed shielded authorisation methods when the store contains several
matching coins. Custom transaction builders must supply an explicitly
selected private state, for example with `withSelectedCoin(state, signedCoin)`,
and manage their own persistence and concurrency boundaries.
Durable mode rejects raw shielded `account.callTx` calls; use its typed spending
methods so the journal cannot be bypassed accidentally.

The witness's next private state retires only the consumed identity, retains
other holdings, and records a local spent marker. The pinned SDK persists
that next state after a fully successful transaction. A rejected circuit
does not itself persist retirement. An uncertain submission result, a partial
chain outcome, or a failure to persist local state still needs reconciliation
against the chain. Configure the [durable change client](DURABLE-CHANGE.md) to
retain those submission boundaries and reconcile captured change after restart.

`dropCoin(coinOrId)` and `withoutCoin(state, coinOrId)` now require an exact
coin description or identity. Repeating removal of a known spent identity
is harmless. Colour-only removal is no longer supported: after a spend it
could accidentally remove a different surviving coin of that asset. Existing
callers should remove redundant post-spend cleanup or pass the consumed
identity explicitly.

State reads, mutations, and SDK calls share an in-process guard keyed by the
private-state provider object. A selected spend holds that guard
through signing, submission, and cleanup. Overlapping operations using the
same provider fail with a busy error; they do not wait inside a signer
callback. Non-shielded SDK calls also use the guard because they can persist
a whole private-state snapshot. Transient selections are cleared after the
operation, and a later operation discards a selection left by interruption.

This guard is not a database transaction or a cross-process lock. Separate
provider wrappers, direct provider writes, and custom SDK builders need
their own coordination when accessing the same underlying store.

## Migration and recovery limits

`migrateCoinStore` converts the old unversioned, colour-keyed representation
into version 2, retaining every stored description and the viewing key. It
rebuilds the colour index from live records. `coinStore()` returns a migrated
view; mutations and successful witness state updates persist the new shape.
Reading alone does not rewrite storage. Persisted values remain JSON-safe.
Unsupported versions or inconsistent descriptions are rejected rather than
silently discarded.

Migration cannot recreate descriptions that the old overwrite bug already
removed. Recovering those requires a retained record or a trustworthy chain
reconstruction. Likewise, a spent marker records local knowledge; it does
not establish whether a coin was spent elsewhere.

Repeated `putCoin`/`withCoin` imports deduplicate the same identity. Updating
its candidate `mt_index` preserves the other holdings. An identity already
marked spent locally stays spent when rediscovered or re-imported. Preserve
the spent markers when saving and restoring private state.

`inboxWalk` now returns distinct decryptable descriptions in first-seen order,
retaining the first inbox index for an identical repeated description. It
still returns candidates, including potentially spent coins; it does not
verify their chain commitments or nullifier status.

These changes address the retained-store and input-binding parts of the
audit's pinned [MIP-0012 §6.5](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/02fce36cfa44541305310dc25fd38f399dbe8d92/mips/mip-0012-native-asset-custody.md#65-coin-store-index-capture-and-discovery)
and [MIP-0013 AUTH-10](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/02fce36cfa44541305310dc25fd38f399dbe8d92/mips/mip-0013-account-authorisation.md#9-invariants).
They do not establish full custody or recovery conformance. The optional
[durable change client](DURABLE-CHANGE.md) adds journalled capture,
qualification, and recovery backfill (`CUST-02`). Callers without that
configuration still manage returned change themselves. Chain-verified
live/spent discovery (`CUST-03`) and viewing-key restoration remain separate work.

## Validation

On 2026/11/10, `npm run test:multi-coin` passed all **55 tests**, and
`npm run build` passed. The suite covers retained same-colour holdings,
legacy migration and JSON restart, exact removal, spent replay, inbox
deduplication, all owner/grantee signing arms, both shielded recipient twins,
raw authorisations, asynchronous mutation, shared-provider guards, abandoned
selections, dust retries, and finite-grant timing with explicit selection.
A baseline probe reproduced two independent coins becoming one stored entry.

Two positive generated-runtime journeys deposit and spend two same-colour
coin fixtures individually, checking the emitted Zswap input/output,
authorisation nonce, exact retirement, and surviving neighbour. A separate
runtime control rejects a signature bound to another qualified coin.
These contexts use local qualified-index fixtures; they do not validate
chain membership or produce cryptographic proofs. Transport fixtures
exercise the real signers and witness while modelling the SDK's
commit-on-success behaviour.

Existing reconnection, grant-preflight, dormant-recovery, recovery, grant,
caller, capability, P-256, input-validation, unit, and viewing-envelope
checks also passed. The generated account runtime was reused after all
Compact source files and the lockfile matched the merged baseline
`9d909ae23290608bb589d5541fc414d34cf3125b` byte for byte. No Compact source
changed, and no fresh proving keys, proofs, node admission, or live deployment
are claimed. Updated live conformance fixtures require a separate localnet
run; their compatibility edits are not new on-node evidence.
