# mn-tui — Midnight Terminal UI

A terminal-based wallet and contract tool for the Midnight network. A [video demonstration](https://drive.google.com/file/d/1xBTYuUffC7A7F4qkdsLansyHVAMuP7wp/view?usp=sharing) is availble.

> **Warning:** Only minimal quality assurance has been performed on this application.

## Starting the Application

**Via Nix** (recommended — no local Node.js install required):

```
nix run github:input-output-hk/arc-nearfall-eval#mn-tui
```

or, from a local checkout of the repository:

```
nix run .#mn-tui
```

**Via npm:**

```
npm start
```

or directly:

```
npx tsx src/index.tsx
```

Node.js 20+ is required. The first launch will create `~/.mn-tui-config.json` for
configuration persistence and `~/.cache/mn-tui/` for wallet sync state caching.
On first launch (no config file present) the app opens directly on the Network
Configuration screen so you can select a network before anything else.

## Global Shortcuts

| Key     | Action                  |
| ------- | ----------------------- |
| `M-m`   | Toggle navigation menu  |
| `M-p`   | Pause / resume sync     |
| `M-q`   | Quit                    |

`M-` means Meta (Alt on most terminals) held with the letter key.

Navigation between screens is done via the menu (`M-m` then arrow keys + Enter)
or by pressing the screen's number shown in the menu bar.

---

## Screens

### 1 · Dashboard

Live overview of the connected node and active wallet.

- **Chain section** — block height, slot, epoch index, time until next epoch,
  peer count, sync status, and latest block hash. Polls every 6 seconds.
- **Wallet section** — name and all three address types (unshielded, shielded,
  dust) for the active wallet on the current network.
- **Balances section** — unshielded and shielded token balances for all tokens,
  including NIGHT and any custom contract tokens; updates as the wallet syncs.
- **DUST Generation section** — current DUST balance, number of registered NIGHT
  UTXOs, daily accrual rate, max cap, and estimated fill time. Shows a warning
  if UTXOs are registered but DUST is not accruing (indicating cross-wallet
  registration or a stale SDK state).

### 2 · Send Tokens

Send NIGHT or any custom shielded/unshielded token to another wallet.

- Select a token (NIGHT unshielded, NIGHT shielded, or any contract token with a
  non-zero balance) and enter a recipient address and amount.
- Multiple transfers can be batched into one transaction before submitting.
- DUST is not directly transferable and does not appear in the token list.
- Live transaction status is shown through the build → prove → submit → pending
  stages. The ZK proof step typically takes 30–60 seconds.

### 3 · Mint Tokens

Mint shielded fungible tokens to the active wallet's shielded address.

- Provide the address of an existing fungible-token contract, or leave it blank
  to deploy a new contract automatically.
- Enter the mint amount (raw integer units) and confirm.
- The resulting token type identifier (hex) is shown after a successful mint.
- ZK proof generation takes 30–60 seconds.

### 4 · Deploy Contract

Deploy an arbitrary compiled Compact contract to the network.

- Provide the path to the contract's compiled `managed/` directory (e.g.
  `contracts/managed/my-contract`).
- Optionally provide the path to a JS file that exports
  `default function makeWitnesses(walletProvider)` for contracts that require
  witnesses at deployment.
- The deployed contract address is displayed on success.

### 5 · Keys

Manage the wallet list and control which wallet is active.

- **New** (`n`) — generate a fresh wallet: the app produces a random 24-word BIP-39
  mnemonic (256-bit entropy) and displays it for the user to write down before
  proceeding to set a name and encryption passphrase.
- **Import** (`a`) — import an existing wallet by entering its 24-word BIP-39 mnemonic,
  a name, and an encryption passphrase. The mnemonic is stored encrypted with OpenPGP
  symmetric encryption; the passphrase is never persisted.
- **Navigate** (↑ / ↓) — move the cursor through the wallet list.
- **Activate / unlock** (Enter) — if the wallet is already unlocked, activate it
  immediately; otherwise prompt for the passphrase to decrypt and activate.
- **Delete** (`x`) — remove the currently selected wallet from the list.
- **Clear sync cache** (`c`) — evict the cached wallet sync state for the selected
  wallet on the current network, forcing a full resync on next unlock.
- Addresses are network-specific (encoded in Bech32 with the network ID) and are
  derived lazily — switching networks causes any cached mnemonic to derive the
  correct addresses for the new network automatically.
- The detail box at the bottom shows all three addresses for the active wallet.

### 6 · Designate NIGHT for DUST

Register or deregister NIGHT UTXOs for automated DUST generation.

- Shows the current DUST balance, generation rate, max cap, and fill time via the
  same DUST Monitor as the Dashboard.
- **Register** — designate all unregistered NIGHT UTXOs for DUST generation.
  The DUST receiver address can be changed from the default (own wallet) to any
  valid dust address, enabling DUST to be directed to a different wallet.
- **Deregister** — remove all registered UTXOs from DUST generation.
- A red warning is shown if UTXOs are registered but DUST is not actually accruing
  (e.g. after cross-wallet registration with the receiver being a different wallet).

### 7 · Network Configuration

Select and configure the Midnight network to connect to.

- Choose from **mainnet**, **preprod**, **preview**, or **undeployed** (local).
- Each network has editable default URLs for the node RPC endpoint, the indexer
  GraphQL endpoint, and the proof server.
- Per-network URL overrides and the last active network are remembered in
  `~/.mn-tui-config.json` across sessions.
- For security, the proof server defaults to `http://localhost:6300` for all
  networks — run the proof server locally.

### 8 · Contract State

Inspect the public ledger state of any deployed contract.

- Enter a contract address (hex, with or without `0x` prefix).
- Optionally provide the path to the contract's compiled `managed/` directory
  (e.g. `contracts/managed/my-contract`). The directory's `contract/index.js`
  is loaded and its `ledger()` function is called to decode the on-chain state,
  which is then displayed as pretty-printed JSON.
- If no `managed/` path is given, the raw state bytes are shown as a hex string.
- Press `r` to refresh, `n` or Esc to query a different address.

### 9 · Logs

View and manage the application debug log.

- Displays the last 40 log entries (INFO, WARN, ERROR) with timestamps.
  New entries appear every 2 seconds; the nav bar shows a badge when new
  entries have arrived since you last visited this screen.
- Press `r` to rename / change the log file path.
- Press `c` to clear the in-memory log.

---

## Configuration Files

| Path | Contents |
| ---- | -------- |
| `~/.mn-tui-config.json` | Wallet list (mnemonics encrypted), per-network URL overrides, last active network and wallet |
| `~/.cache/mn-tui/sync-state/{network}/{address}-{type}.state` | Serialized wallet sync state cache (shielded / unshielded / dust) |
| `~/.cache/mn-tui/level-db/{network}/{key-prefix}/` | LevelDB private-state store used by contract operations (deploy, mint) |
| `~/.mn-tui.log` | Default application log file (path configurable on the Logs screen) |

---

See [lessons-learned.md](lessons-learned.md) for a record of non-trivial obstacles
encountered during development and their workarounds.

---

## Portability

The application is architecturally well-suited for migration to other UIs or consumption
as a library because the business logic is cleanly separated from the terminal rendering layer.

**Layer separation:**

- **Hooks (`src/hooks/`)** — contain all SDK interaction and RxJS observable handling;
  zero Ink imports. `useWalletSync.ts` is the only file that touches RxJS
  (`auditTime`, `distinctUntilChanged` on `facade.state()`). These hooks are portable
  to any React environment unchanged.
- **Screen and component files (`src/screens/`, `src/components/`)** — pure Ink
  rendering; never import the Midnight SDK or RxJS directly. They receive state and
  callbacks through hook return values only.

**CLI tool** — the highest-leverage path for scripting and automation. Because the hooks
layer already encapsulates every Midnight SDK operation as a standalone async function or
observable, each screen's logic can be extracted into a command with minimal effort:

- A thin `commander` or `yargs` entry point replaces `src/index.tsx`; each subcommand
  (`send`, `mint`, `deploy`, `designate`, `balance`, …) calls the relevant hook logic
  directly and exits.
- Wallet unlock already handles passphrase input; in a CLI context the passphrase can be
  supplied via `--passphrase`, an environment variable, or a pinentry prompt, removing
  the Ink UI dependency entirely.
- The config and cache modules (`config.ts`, `walletCache.ts`) are plain filesystem
  abstractions and need no changes.
- ZK proof generation is a blocking async call today; for CLI batch use it is idiomatic
  to surface progress via stderr and the result via stdout, which requires only wrapping
  the existing promise.
- The main constraint is that proof generation requires the proof server to be reachable;
  this is no different from the TUI requirement and is already configurable via the
  network config.

A CLI build would be useful for test automation, CI pipelines, and scripted load testing
against preprod — all current gaps in the Midnight developer tooling ecosystem.

**Web app migration** — realistic with modest effort:

1. Replace Ink primitives (`<Box>`, `<Text>`) with HTML/CSS equivalents. Ink uses CSS
   flexbox internally, so the layout model maps directly to `<div style={{display:'flex',…}}>`.
2. Swap the two Node.js storage modules (`config.ts`, `walletCache.ts`) for browser
   storage (`localStorage` or `IndexedDB`). Both are already clean abstractions with
   narrow read/write interfaces.
3. `globalThis.WebSocket` — native in browsers; the explicit assignment in
   `useWalletSync.ts` becomes a no-op.
4. LevelDB (`levelPrivateStateProvider`) — the `level` package has a
   browser-compatible backend (`browser-level`) so this is a dependency swap, not a
   rewrite.

**Mobile (React Native)** — the hooks layer is still portable, but the Midnight SDK's
use of Wasm modules for ZK proof generation and native crypto bindings may not run
under React Native's Hermes engine. That risk lives at the SDK level, not the
application level.
