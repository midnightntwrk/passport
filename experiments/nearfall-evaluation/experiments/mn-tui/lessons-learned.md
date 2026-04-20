# mn-tui — Lessons Learned

Obstacles encountered during development that required workarounds or non-obvious
solutions. Recorded here so they don't need to be rediscovered.

---

## 1. `ledger-v7` 7.0.0/7.0.1 — `ZswapChainState::tryApply` panic

**Problem:** `@midnight-ntwrk/ledger-v7` 7.0.0 and 7.0.1 contain a bug in the
Rust WASM layer where `MerkleTree::collapse` panics on any non-empty tree when
the code tries to produce shielded outputs (e.g. during minting, shielded
transfers, or contract deployment). This manifests as an uncaught exception thrown
from deep inside the WASM bundle with no useful stack trace.

**Impact:** Shielded minting and any transaction that creates a shielded output
will crash unless the workaround is in place. There is no way to mint unshielded
tokens via the built-in fungible-token contract because the contract always mints
to a ZSwap (shielded) address — so unshielded minting is not supported by the
contract design, not just by this bug. The bug primarily blocked shielded minting
and deployment transactions.

**Workaround (in `src/hooks/useWalletSync.ts`):**

```typescript
const _origTryApply = ledger.ZswapChainState.prototype.tryApply;
ledger.ZswapChainState.prototype.tryApply = function (...args: unknown[]) {
  try {
    return _origTryApply.apply(this, args as any);
  } catch {
    return [this, new Map()];
  }
};
```

Returning `[this, new Map()]` on error means the failed application is treated as
a no-op; the wallet continues syncing but the offending operation is silently
skipped. This is not semantically correct in general but is safe for the TUI use
case where the wallet is read-only with respect to this path.

**Status:** Fix expected in `ledger-v7` 7.0.2+. When upgrading, verify that the
monkey-patch can be removed by confirming shielded minting works without it.

**Reference:** https://github.com/geofflittle/tryapply-crash-repro

---

## 2. `signTransactionIntents` required for deployment (not documented)

**Problem:** `deployContract` from `@midnight-ntwrk/midnight-js-contracts` calls
`walletProvider.balanceTx` with a transaction that contains unshielded transaction
intents (segments of a balanced recipe that need to be signed with the
NightExternal key). The SDK does not document that the `balanceTx` callback must
explicitly sign these intents before returning. If it doesn't, the deployment
transaction is submitted with unsigned intents and rejected by the node.

**Workaround:** Ported `signTransactionIntents` from the `shielding-contracts`
reference implementation (see `src/hooks/useWalletSync.ts`). This function
iterates over `tx.intents`, deserializes each intent with the correct proof
marker, signs it with the NightExternal key, and reattaches the signed intent.
Both `fallibleUnshieldedOffer` and `guaranteedUnshieldedOffer` paths must be
handled.

**Note:** This is fragile because it depends on internal ledger serialization
details (`Intent.deserialize`, `addSignatures`). If the ledger format changes in
a future SDK version, this code will need to be updated.

---

## 3. DUST balance frozen between chain events

**Problem:** `dustWalletState.walletBalance(now: Date)` is a time-dependent
computation (DUST accrues continuously by rate × elapsed time), but the wallet
facade's RxJS state observable only emits when the chain advances or the coin set
changes. In a fully-synced steady state the observable can be silent for minutes,
causing the displayed DUST balance on the Dashboard to appear frozen even though
it is actually increasing.

**Workaround:** Expose a `refreshDustBalance()` callback from `useWalletSync`.
This re-calls `walletBalance(new Date())` without waiting for a state emission and
updates the React state if the value changed. The Dashboard calls this callback
inside a `useEffect([node])` — i.e. on every chain-section poll (~6 s) — so the
DUST display updates on the same clock as the chain section without requiring a
separate independent timer (which caused flickering).

---

## 4. Stale DUST generation data after cross-wallet registration

**Problem:** After registering NIGHT UTXOs to direct DUST to a *different* wallet,
the SDK's `availableCoinsWithFullInfo(now)` on the dust wallet still returns the
registered coins from this wallet with their rate and fill time. The dust wallet
has no API to determine whether it is actually the *receiver* of the DUST. As a
result, the DUST Generation box shows a positive accrual rate and fill time even
though no DUST is arriving — identical to what Lace shows (it also gets confused).

**Workaround:** Maintain a rolling 60-second window of `walletBalance(now)` samples.
If UTXOs are registered (registered UTXO count > 0) but no sample in the window
shows an increase relative to the first sample, set `dustAccruing = false`. The
DustMonitor hides the rate/fill-time columns and shows a red warning instead when
this condition is detected. The heuristic resets when the wallet is reloaded.

**Limitation:** The 60-second window means it takes up to a minute after app
launch to confirm cross-registration. During that window `dustAccruing` is `null`
and the potentially-misleading stats are shown. This is acceptable given the
absence of any SDK API for cross-registration detection.

---

## 5. `UnshieldedWallet` has a different constructor from `ShieldedWallet`/`DustWallet`

**Problem:** All three wallet types look similar on the surface but `UnshieldedWallet`
requires a distinct config object and key-import API:

- `ShieldedWallet(cfg)` and `DustWallet(cfg)` accept `provingServerUrl` and
  `relayURL` in their config; `UnshieldedWallet` does not.
- `UnshieldedWallet` requires an explicit `txHistoryStorage` (we use
  `InMemoryTransactionHistoryStorage`, so history is lost on restart).
- Keys are imported via `startWithPublicKey(PublicKey.fromKeyStore(keystore))`
  rather than `startWithSecretKeys(…)`.
- The restore path is `UnshieldedWallet({...reducedCfg}).restore(saved)` with the
  same reduced config (no `provingServerUrl` / `relayURL`).

Mixing up the configs causes silent failures or cryptic TypeScript errors.

---

## 6. Bech32 addresses are network-specific

**Problem:** Midnight addresses encode the network name in the Bech32
human-readable part (`mn_addr_preprod1…`, `mn_addr_preview1…`, `mn_addr_mainnet1…`).
An address derived for preprod is syntactically invalid on preview and vice versa.
Early config designs stored a single flat set of addresses per wallet, which
showed the wrong addresses after switching networks.

**Resolution:** Store addresses in a `Partial<Record<NetworkName, WalletAddresses>>`
map inside each `PersistedWallet`. When the user switches networks, if the wallet's
mnemonic is cached in session memory, the missing addresses for the new network are
derived automatically and persisted. If the mnemonic is not cached (wallet locked),
the Keys screen shows a prompt to unlock so the addresses can be derived.

---

## 7. `globalThis.WebSocket` must be set manually in Node.js

**Problem:** The wallet SDK internals use `globalThis.WebSocket` for GraphQL
subscriptions. Node.js 20 ships with a native `WebSocket` but it is not exposed on
`globalThis` by default. The wallet silently fails to subscribe to the indexer
unless the global is set.

**Fix (one line, near the top of `useWalletSync.ts`):**

```typescript
import { WebSocket } from 'ws';
(globalThis as any).WebSocket = WebSocket;
```

---

## 8. Wallet sync state caching: all three wallets must be serialized separately

**Problem:** `WalletFacade` wraps three distinct wallet instances (shielded,
unshielded, dust). Each exposes `serializeState()` / `.restore()` but they have
different constructor signatures and restore paths (see item 5 above). There is no
single facade-level `serializeState()`.

**Approach:** Serialize/restore each wallet independently in
`src/walletCache.ts` + `src/hooks/useWalletSync.ts`. Cache files are stored at:

```
~/.cache/mn-tui/sync-state/{networkName}/{unshieldedAddress}-{shielded|unshielded|dust}.state
```

The unshielded address (deterministic from the public key) is used as the cache key
so no extra persistent identifier is needed. Stale/incompatible cache entries are
detected by a try/catch around the restore call; on any error the cache file is
deleted and a fresh sync starts.

---

## 10. Shielded batch transfers of multiple token types fail with `Wallet.InsufficientFunds`

**Problem:** Calling `facade.transferTransaction` with multiple entries (each with a
different shielded token ID) fails with `Wallet.InsufficientFunds` thrown inside
`wallet-sdk-shielded/dist/v1/Transacting.js`. The same call succeeds when only one
token type is included. All SDK reference examples use a single token type per call.

**Likely cause:** The shielded ZK circuit has a fixed number of coin-input slots.
Batching N different token types requires N independent coin selections; once the
total exceeds the circuit capacity the coin selector throws `InsufficientFunds`.

**Status:** Confirmed on preprod. Batches of 1 or 2 shielded token types succeed;
5 fail. Lace does not support multi-token transfers so cross-app comparison was not
possible. DUST balance is not the cause (wallet had ample DUST). The threshold
between 2 (works) and 5 (fails) is unknown; 3 distinct shielded token types in one
batch is the untested boundary.

**Workaround:** Keep batches to at most two distinct shielded token types. The TUI
shows a warning when a draft batch exceeds this limit.

---

## 11. Compact `assert` syntax: parentheses and comma are required

**Problem:** Compact's `assert` statement requires parentheses around the condition
and a comma before the message string:

```compact
assert(condition, "message");
```

Writing `assert condition "message"` (no parens, no comma) is a parse error.
Additionally, Compact does not have a `!` unary boolean negation operator — use
`== false` instead:

```compact
// Wrong — two separate errors:
assert !device_registered "device already registered";

// Correct:
assert(device_registered == false, "device already registered");
```

---

## 9. `deployContract` requires a `levelPrivateStateProvider` even for simple contracts

**Problem:** The `deployContract` helper from `@midnight-ntwrk/midnight-js-contracts`
expects a full `walletProvider` including a `privateStateProvider` backed by a
LevelDB store. Passing `undefined` or an in-memory stub causes a runtime failure
when the contract deployment tries to write its initial private state.

**Fix:** Use `levelPrivateStateProvider` with a directory path scoped to the
contract address or a temp dir. In `useWalletSync.ts` we use
`os.tmpdir() + '/mn-tui-private-state'` as a throw-away store since we don't need
to query private contract state after deployment.

**Note (newer SDK versions):** Later releases of this package added two further
required options that throw if absent:

- `privateStoragePasswordProvider: () => string` — returns a password (≥ 16 chars)
  for encrypting the LevelDB store.
- `accountId: string` — a wallet identifier to scope storage and prevent
  cross-account data access.

The wallet's unshielded Bech32 address satisfies both: it is deterministic, always
≥ 16 characters, and wallet-specific. Call `.toString()` explicitly —
`getBech32Address()` returns an address object, not a plain string, and the SDK
calls `.trim()` on these values which will throw if they are not primitives.
