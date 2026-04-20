---
name: midnight-new-project
description: Starting point for writing any new Midnight script, tool, or application. Use when asked to create, scaffold, or write code that uses the Midnight SDK, wallet, contracts, or node. Triggers on "write a Midnight script", "create a Midnight app", "new Midnight tool", "build a Midnight", "scaffold Midnight", or "Midnight CLI".
allowed-tools: Read Glob
---

# Starting a New Midnight Script or App

**Before writing any new Midnight code**, consult two sources in order:

1. **`experiments/mn-tui/`** — the reference implementation; use it as the foundation.
2. **`midnight-lessons-learned` skill** — known bugs, workarounds, and sharp edges.

---

## Step 1 — Read the relevant mn-tui source files first

`experiments/mn-tui/` is a working, battle-tested Midnight application. Do not
start from scratch — start from here.

### Architecture overview

```
experiments/mn-tui/src/
├── hooks/
│   ├── useWalletSync.ts   ← wallet init, sync loop, signTransactionIntents patch,
│   │                         ZswapChainState::tryApply patch — START HERE
│   ├── useWallet.ts       ← wallet state management, balance queries
│   ├── useDust.ts         ← DUST balance, accrual rate, cross-wallet detection
│   └── useMidnightNode.ts ← node RPC polling, block height, sync status
├── config.ts              ← persistent config (~/.mn-tui-config.json)
├── walletCache.ts         ← wallet sync-state serialisation / restore
├── keys.ts                ← BIP-39 key generation, OpenPGP mnemonic encryption
├── types.ts               ← shared TypeScript types
├── logger.ts              ← application logging
└── night-tps.ts           ← standalone TPS measurement script (good CLI example)
```

The **hooks layer** (`src/hooks/`) contains all SDK interaction with zero UI
dependencies — it is directly portable to CLI tools, web apps, or test scripts.

### What to read for common tasks

| Task | Read first |
|------|-----------|
| Connect to a node and wallet | `hooks/useWalletSync.ts` |
| Query balances | `hooks/useWallet.ts`, `hooks/useDust.ts` |
| Send / mint / deploy a contract | `hooks/useWalletSync.ts` (providers setup) |
| Read node status (block height, peers) | `hooks/useMidnightNode.ts` |
| Write a standalone CLI script | `night-tps.ts` (minimal, no Ink) |
| Persist config or cache wallet sync state | `config.ts`, `walletCache.ts` |

---

## Step 2 — Copy the known-good dependency versions

Do not use `^` ranges for `@midnight-ntwrk/*` packages (see lessons-learned 1a).
Use these exact versions from mn-tui's `package.json`:

```json
"@midnight-ntwrk/compact-js":                            "2.4.0",
"@midnight-ntwrk/ledger-v7":                             "7.0.0",
"@midnight-ntwrk/midnight-js-contracts":                 "3.0.0",
"@midnight-ntwrk/midnight-js-http-client-proof-provider": "3.0.0",
"@midnight-ntwrk/midnight-js-indexer-public-data-provider": "3.0.0",
"@midnight-ntwrk/midnight-js-level-private-state-provider": "3.0.0",
"@midnight-ntwrk/midnight-js-network-id":                "3.0.0",
"@midnight-ntwrk/midnight-js-node-zk-config-provider":   "3.0.0",
"@midnight-ntwrk/wallet-sdk-address-format":             "3.0.0",
"@midnight-ntwrk/wallet-sdk-dust-wallet":                "1.0.0",
"@midnight-ntwrk/wallet-sdk-facade":                     "1.0.0",
"@midnight-ntwrk/wallet-sdk-hd":                         "3.0.0",
"@midnight-ntwrk/wallet-sdk-runtime":                    "1.0.0",
"@midnight-ntwrk/wallet-sdk-shielded":                   "1.0.0",
"@midnight-ntwrk/wallet-sdk-unshielded-wallet":          "1.0.0"
```

---

## Step 3 — Apply the mandatory patches from useWalletSync.ts

Two patches from `useWalletSync.ts` are required for correct operation.
Copy them verbatim — do not rewrite them.

### Patch A: ZswapChainState::tryApply (ledger-v7 7.0.0/7.0.1 bug)

```typescript
// Apply before initialising any wallet. Remove when upgrading to ledger-v7 7.0.2+
const _origTryApply = ledger.ZswapChainState.prototype.tryApply;
ledger.ZswapChainState.prototype.tryApply = function (...args: unknown[]) {
  try {
    return _origTryApply.apply(this, args as any);
  } catch {
    return [this, new Map()];
  }
};
```

### Patch B: globalThis.WebSocket (Node.js environments)

```typescript
import { WebSocket } from 'ws';
(globalThis as any).WebSocket = WebSocket;
```

### Patch C: signTransactionIntents (required for deployment)

Copy `signTransactionIntents` directly from `useWalletSync.ts` — it handles
`fallibleUnshieldedOffer` and `guaranteedUnshieldedOffer` and must be called
inside the `balanceTx` callback when deploying contracts.

---

## Step 4 — Check lessons-learned before writing new SDK code

Before implementing anything involving:
- Contract deployment → see lessons-learned §2 (deployment)
- Reading ledger state → see lessons-learned §3
- Wallet construction → see lessons-learned §5b
- Token transfers → see lessons-learned §6a (batch limit)
- Rapid sequential transactions → see lessons-learned §7a (UTXO staleness)
- Node sync → see lessons-learned §8a (genesis timestamp bug)

---

## Step 5 — Choose a target shape

The mn-tui README documents three migration paths; pick the right one:

### CLI script (quickest path for automation/scripting)

- Replace `src/index.tsx` with a `commander`/`yargs` entry point.
- Each subcommand calls the relevant hook logic directly and exits.
- Remove all `ink` dependencies; keep `ws`, `rxjs`, `level`, and the SDK.
- Use `night-tps.ts` as the template — it is already a minimal standalone script.
- Surface ZK proof progress via `stderr`, result via `stdout`.

### Web app

- Replace Ink primitives (`<Box>`, `<Text>`) with `<div style={{display:'flex',...}}>`.
- Swap `config.ts`/`walletCache.ts` file I/O for `localStorage`/`IndexedDB`.
- Replace `levelPrivateStateProvider` with `browser-level` backend.
- Remove the `globalThis.WebSocket` patch (native in browsers).
- Hooks layer is unchanged.

### Another terminal UI

- Keep the entire hooks layer unchanged.
- Swap Ink for your preferred TUI library.

---

## Quick-start checklist

- [ ] Read `experiments/mn-tui/src/hooks/useWalletSync.ts`
- [ ] Copy dependency versions from `experiments/mn-tui/package.json` (no `^` ranges)
- [ ] Apply Patch A (tryApply), Patch B (WebSocket), Patch C (signTransactionIntents)
- [ ] Checked `midnight-lessons-learned` skill for any relevant section
- [ ] Chosen target shape (CLI / web / TUI) and removed unneeded layers
