---
name: midnight-lessons-learned
description: Hard-won lessons from Midnight SDK and node experiments in this repository. Consult when hitting SDK errors, deployment failures, Compact compiler issues, wallet quirks, or node sync failures. Triggers on Midnight SDK errors, "tryApply", "signTransactionIntents", "levelPrivateStateProvider", "version mismatch", "compact-js", "disclose", "ecMulGenerator", "DUST balance", "UTXO", "ZswapChainState", "sidechain-mc-hash", "stability window", or "genesis block".
---

# Midnight SDK & Node — Lessons Learned

Synthesised from experiments in this repository:
- `experiments/mn-tui/lessons-learned.md` — wallet TUI (SDK ~3.0.0, ledger-v7)
- `experiments/local-tee-poc/lessons-learned.md` — TEE PoC (SDK 3.0.0, compact-js 2.4.0 / runtime 0.14.0)
- `experiments/pubnet-node/README.md` — mainnet/preprod node (midnight-node v0.22.2, partner-chains v1.8.1)

---

## 1. SDK Version Management

### 1a. Pin every `@midnight-ntwrk/*` package — no `^` ranges

**Applies to:** All SDK versions

Semver ranges resolve to newer releases that introduce breaking API changes and
duplicate nested copies of shared packages (e.g. `midnight-js-network-id`) with
independent module state, producing errors like:

```
Network ID has not been configured
```

**Fix:** Copy exact versions from a known-working install and pin without `^`:

```json
"@midnight-ntwrk/midnight-js-contracts":                    "3.0.0",
"@midnight-ntwrk/midnight-js-http-client-proof-provider":   "3.0.0",
"@midnight-ntwrk/midnight-js-indexer-public-data-provider": "3.0.0",
"@midnight-ntwrk/midnight-js-level-private-state-provider": "3.0.0",
"@midnight-ntwrk/midnight-js-network-id":                   "3.0.0"
```

Delete `node_modules/` and run `npm install` for a clean install.

---

### 1b. `compact-js` runtime/compiler version must match exactly

**Applies to:** compact-js 2.4.0 / compiler runtime 0.14.0 (local-tee-poc)

`npm install` with `^2.4.0` resolves to a newer `compact-js` that provides runtime
0.15.0, while the compiler binary on PATH targets 0.14.0:

```
Version mismatch: compiled code expects 0.14.0, runtime is 0.15.0
```

**Fix:** Pin to the exact `compact-js` version the compiler was built for:

```json
"@midnight-ntwrk/compact-js": "2.4.0"
```

Never use a `^` range for `compact-js` unless updating the compiler binary at the
same time.

---

### 1c. `ledger-v7` 7.0.0 / 7.0.1 — `ZswapChainState::tryApply` panic

**Applies to:** `@midnight-ntwrk/ledger-v7` 7.0.0 and 7.0.1 only. Fixed in 7.0.2+.

`MerkleTree::collapse` panics on any non-empty tree when producing shielded outputs
(minting, shielded transfers, contract deployment). No useful stack trace — the
exception surfaces from deep inside the WASM bundle.

The built-in fungible-token contract always mints to a ZSwap (shielded) address,
so unshielded minting is not possible via the contract design regardless of this bug.

**Workaround** (remove once upgraded to 7.0.2+):

```typescript
const _origTryApply = ledger.ZswapChainState.prototype.tryApply;
ledger.ZswapChainState.prototype.tryApply = function (...args: unknown[]) {
  try {
    return _origTryApply.apply(this, args as any);
  } catch {
    return [this, new Map()]; // no-op: failed application silently skipped
  }
};
```

This is safe for read-only wallet paths but not semantically correct in general.
Verify shielded minting works without the patch after upgrading.

Reference: https://github.com/geofflittle/tryapply-crash-repro

---

## 2. Contract Deployment

### 2a. `signTransactionIntents` is required but undocumented

**Applies to:** `@midnight-ntwrk/midnight-js-contracts` (observed at 3.0.0)

`deployContract` calls `walletProvider.balanceTx` with a transaction containing
unshielded transaction intents that must be signed with the NightExternal key before
returning. The SDK does not document this. Submitting without signing causes the
node to reject the transaction.

**Fix:** Port `signTransactionIntents` from the `shielding-contracts` reference
implementation. It must iterate `tx.intents`, deserialize each with the correct
proof marker, sign with the NightExternal key, and reattach. Both
`fallibleUnshieldedOffer` and `guaranteedUnshieldedOffer` paths must be handled.

⚠️ This depends on internal ledger serialization (`Intent.deserialize`,
`addSignatures`) and will need updating if the ledger format changes.

---

### 2b. `deployContract` requires `levelPrivateStateProvider`

**Applies to:** `@midnight-ntwrk/midnight-js-contracts` 3.0.0 (base); later versions
added two additional required options.

Passing `undefined` or an in-memory stub for `privateStateProvider` causes a runtime
failure when deployment writes initial private state.

**Fix:** Use `levelPrivateStateProvider` with a scoped directory:

```typescript
// Minimal (SDK 3.0.0 base)
levelPrivateStateProvider({ dataDir: os.tmpdir() + '/mn-tui-private-state' })
```

**Later SDK versions** added two further required options that throw if absent:

```typescript
// Additional options required in later releases:
privateStoragePasswordProvider: () => walletAddress.toString(),  // ≥ 16 chars
accountId: walletAddress.toString(),
```

Use the wallet's unshielded Bech32 address for both: it is deterministic, always
≥ 16 chars, and wallet-specific. Call `.toString()` explicitly — the SDK calls
`.trim()` on these values, which throws if they are not primitives.

---

### 2c. `CompiledContract.withVacantWitnesses` required for contracts without a witnesses file

**Applies to:** `@midnight-ntwrk/midnight-js-contracts` 3.0.0

Omitting `withVacantWitnesses` leaves the witnesses argument `undefined`:

```
CompactError: first (witnesses) argument to Contract constructor is not an object
```

**Fix:** Always pipe `withVacantWitnesses` before `withCompiledFileAssets`:

```typescript
const compiled = CompiledContract.make('compliance', contractMod.Contract).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(MANAGED_PATH),
);
```

Use the same `compiled` object for both `deployContract` and `findDeployedContract`,
passing `compiledContract` (not `contract`) and `initialPrivateState: {}`:

```typescript
await (deployContract as any)(providers, {
  compiledContract:    compiled,
  privateStateId:      'my-state',
  initialPrivateState: {},
});
```

---

## 3. Reading On-Chain State

### 3a. `FoundContract` has no `.state` — use `getPublicStates` + `ledger()`

**Applies to:** `@midnight-ntwrk/midnight-js-contracts` 3.0.0

`FoundContract` (returned by `findDeployedContract`) has no `.state` property.
`Rx.firstValueFrom(deployed.state)` throws:

```
Cannot read properties of undefined (reading 'subscribe')
```

**Fix:** Use `getPublicStates` with the `publicDataProvider`, then decode with the
compiled contract's `ledger()` helper:

```typescript
import { getPublicStates } from '@midnight-ntwrk/midnight-js-contracts';

const pubStates = await getPublicStates(providers.publicDataProvider, contractAddress);
const pub = contractMod.ledger(pubStates.contractState.data);
// pub has named fields matching the `export ledger` declarations in the Compact source
// Non-exported ledger fields are absent from the returned object
```

---

## 4. Compact Language

### 4a. `assert` requires parentheses and a comma

**Applies to:** All Compact versions

```compact
// Wrong — parse error (no parens, no comma):
assert condition "message";

// Correct:
assert(condition, "message");
```

Compact has no `!` unary boolean negation operator. Use `== false`:

```compact
// Wrong:
assert(!device_registered, "already registered");

// Correct:
assert(device_registered == false, "already registered");
```

---

### 4b. `disclose()` required for ALL witness-to-ledger assignments

**Applies to:** All Compact versions

Every assignment of a circuit-parameter (witness) value to a ledger field — including
non-`export` fields — requires `disclose()`. Omitting it is a compile error:

```
potential witness-value disclosure must be declared but is not
```

```compact
// Wrong:
identity_commitment = new_identity_commitment;

// Correct:
identity_commitment = disclose(new_identity_commitment);
```

**Note:** The `export` keyword controls ABI visibility only. It does not guarantee
the value is absent from the on-chain state commitment — non-exported fields may
still appear in the state tree.

---

### 4c. `ecMulGenerator` / `ecMul` require a Jubjub scalar, not a BLS12-381 field element

**Applies to:** Compact 0.4.0 / runtime 0.14.0 (local-tee-poc)

`Field` is the BLS12-381 scalar field (~255 bits). `ecMulGenerator` additionally
requires the runtime value to be a valid Jubjub scalar (EmbeddedFr, ~252 bits,
bounded by `JUBJUB_R`). A value in `[JUBJUB_R, FIELD_MODULUS)` passes Compact's
type check but panics at runtime:

```
ContractRuntimeError: Error executing circuit
  cause: EmbeddedFr decode failure
```

~94% of random 32-byte samples exceed `JUBJUB_R`.

**Fix:** Reduce device keys to Jubjub scalar range before passing to the circuit:

```typescript
const JUBJUB_R =
  6554484396890773809930967563523245729705921265872317281365359162392183254199n;

function generateJubjubScalar(): string {
  const bytes = crypto.randomBytes(32);
  bytes[0] &= 0x0f;  // clear top 4 bits → value < 2^252 ≈ JUBJUB_R
  const value = BigInt('0x' + Buffer.from(bytes).toString('hex')) % JUBJUB_R;
  return value.toString(16).padStart(64, '0');
}
```

The same constraint applies to any `Field` witness passed to `ecMul`.

---

### 4d. `Bytes<32>` casts are range checks, not truncations

**Applies to:** Compact 0.4.0 / runtime 0.14.0 (local-tee-poc)

`Bytes<32> as Uint<248>` does NOT drop the top 8 bits — it is a **runtime range
check** that FAILS if the integer value exceeds 2^248 − 1.
Since bit 248+ is set in ~99.6% of 256-bit hashes, this cast fails almost always.
`Bytes<32> as Field` fails for ~50% of hashes (those ≥ FIELD_MODULUS).

**Pattern for safe field conversion (nonce-retry):** Export a `pure circuit` that
returns `Bytes<32>`, then retry with an incrementing nonce in TypeScript until the
result is < JUBJUB_R (~5.7% per try → ~17 expected iterations):

```compact
export pure circuit compute_schnorr_challenge(
  ..., nonce: Uint<64>
): Bytes<32> {
  return persistentHash<[..., Uint<64>]>([sig_r, pk, ..., nonce]);
}
```

```typescript
// little-endian bytes → bigint
function bytesToBigIntLE(bytes: Uint8Array): bigint {
  let r = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) r = (r << 8n) | BigInt(bytes[i]);
  return r;
}

let nonce = 0n;
for (;;) {
  const hBytes = circuits.compute_schnorr_challenge(..., nonce);
  if (bytesToBigIntLE(hBytes) < JUBJUB_R) break;
  nonce++;
}
```

Exported `pure circuit`s appear in `contractMod.pureCircuits` and are callable
synchronously from TypeScript without generating a ZK proof.

---

### 4e. Schnorr verification inside a circuit

**Applies to:** Compact 0.4.0 / runtime 0.14.0 (local-tee-poc)

`ecMul(a: NativePoint, b: Field): NativePoint` is available from Compact 0.4.0.
Full Schnorr verification avoids passing a persistent credential (`sk_device`) to
the proof server on every transaction — only the one-time signature `(R, s)` is
needed after registration:

```compact
// Verify: ecMulGenerator(s) == R + c·PK
assert(
  ecMulGenerator(sig_s) == ecAdd(sig_r, ecMul(device_pk, c)),
  "invalid device signature"
);
```

where `c` is the Schnorr challenge hash, reduced to Jubjub scalar range via the
nonce-retry pattern above.

---

## 5. Wallet & Environment Quirks

### 5a. `globalThis.WebSocket` must be set manually in Node.js

**Applies to:** All SDK versions in Node.js environments

The wallet SDK uses `globalThis.WebSocket` for GraphQL subscriptions. Node.js 20
ships with `WebSocket` but does not expose it on `globalThis` by default. The wallet
silently fails to subscribe to the indexer.

**Fix** (one line, early in entry point):

```typescript
import { WebSocket } from 'ws';
(globalThis as any).WebSocket = WebSocket;
```

---

### 5b. `UnshieldedWallet` has a different constructor from `ShieldedWallet`/`DustWallet`

**Applies to:** All SDK versions (mn-tui)

| | `ShieldedWallet` / `DustWallet` | `UnshieldedWallet` |
|---|---|---|
| Config | includes `provingServerUrl`, `relayURL` | does NOT accept these |
| Extra config | — | requires `txHistoryStorage` |
| Key import | `startWithSecretKeys(…)` | `startWithPublicKey(PublicKey.fromKeyStore(ks))` |
| Restore | `.restore(saved)` with full config | `.restore(saved)` with reduced config (no prover/relay) |

Mixing configs causes silent failures or cryptic TypeScript errors.

---

### 5c. Bech32 addresses are network-specific

**Applies to:** All SDK versions

Addresses encode the network in the human-readable prefix:
`mn_addr_preprod1…`, `mn_addr_preview1…`, `mn_addr_mainnet1…`.
An address for preprod is syntactically invalid on preview and vice versa.

**Fix:** Store addresses as `Partial<Record<NetworkName, WalletAddresses>>`.
Derive missing addresses for the current network when the mnemonic is in session
memory; prompt unlock if not.

---

### 5d. All three wallet instances must be serialised and restored independently

**Applies to:** All SDK versions (mn-tui)

`WalletFacade` wraps three wallet instances (shielded, unshielded, dust), each with
a different constructor and restore path (see 5b). There is no facade-level
`serializeState()`.

**Cache key pattern:**

```
~/.cache/mn-tui/sync-state/{networkName}/{unshieldedAddress}-{shielded|unshielded|dust}.state
```

Detect stale/incompatible cache entries via try/catch around the restore call;
delete and start fresh on any error.

---

## 6. Token & Balance Quirks

### 6a. Shielded batch transfers of multiple token types fail with `InsufficientFunds`

**Applies to:** SDK 3.0.0 / preprod (mn-tui)

`facade.transferTransaction` with multiple entries of **different shielded token IDs**
throws `Wallet.InsufficientFunds` inside `wallet-sdk-shielded`. The same call succeeds
with a single token type. The likely cause is a fixed number of ZK coin-input slots
per circuit — multiple token types exhaust the slot budget.

**Known limits:** 1–2 distinct shielded token types per batch succeed; 5 fail.
The threshold between 2 (works) and 3 (untested) is unknown.

**Workaround:** Limit batches to at most 2 distinct shielded token types; warn the
user when a batch exceeds this limit.

---

### 6b. DUST balance appears frozen between chain events

**Applies to:** All SDK versions (mn-tui)

`dustWalletState.walletBalance(now: Date)` is time-dependent (DUST accrues
continuously), but the wallet observable only emits when the chain advances.
In steady state the display can be silent for minutes.

**Fix:** Expose a `refreshDustBalance()` callback that re-calls
`walletBalance(new Date())` without waiting for an emission. Call it on every
chain-section poll interval (~6 s) to match the chain-advance cadence.

---

### 6c. Stale DUST generation display after cross-wallet registration

**Applies to:** All SDK versions (mn-tui)

After registering NIGHT UTXOs to redirect DUST to a *different* wallet,
`availableCoinsWithFullInfo(now)` on the source wallet still reports a positive
accrual rate — identical to Lace's behaviour.

**Workaround:** Maintain a 60-second rolling window of `walletBalance(now)` samples.
If registered UTXOs are present but no sample shows an increase over the window,
set `dustAccruing = false` and show a warning instead of the rate/fill-time stats.
The heuristic resets on wallet reload.

Note: up to 60 seconds after launch, `dustAccruing` is `null` and misleading stats
may be displayed.

---

## 7. Transaction Reliability

### 7a. Transient UTXO staleness after rapid sequential transactions

**Applies to:** SDK 3.0.0 / preprod (local-tee-poc)

Submitting two transactions in quick succession can fail with:

```
RpcError: 1010: Invalid Transaction: Custom error: 170
```

**Root cause:** `isSynced: true` means the wallet has caught up to the current block
header, but the internal UTXO set may not yet include outputs from the just-confirmed
preceding transaction. The wallet selects an already-spent UTXO, and the node rejects it.

**Workaround:** Retry on submission error. A single immediate retry always succeeds
in the PoC. Production implementations should add an automatic retry loop with brief
back-off around `callTx.*` calls.

---

## 8. Midnight Node Infrastructure

### 8a. Genesis-era Cardano anchor timestamp causes immediate sync failure

**Applies to:** midnight-node v0.22.2 against preprod or mainnet; partner-chains v1.8.1

Running a Midnight node against Cardano preprod or mainnet fails immediately at
genesis with:

```
💔 Verification failed for block …: "Main chain state <hash> referenced in imported
block at slot <slot> with timestamp <ts> not found"
```

**Root cause:** `sidechain-mc-hash` (`get_mc_state_reference`) validates each
Midnight block's Cardano anchor against a stability window
`[reference − 3k/f, reference − k/f]` (with k=432, f=0.05 → window ≈ 7.2 h).
Genesis-era Midnight blocks reference Cardano anchors that are older than this
window — on preprod the offset is ~15.6 h. This is baked into committed chain
history and cannot be fixed by environment variables or chain-spec changes.

**Fix:** Patch `partner-chains` v1.8.1 to fall back from timestamp-filtered lookup
to pure hash lookup when the timestamp check returns `None`. The fallback is only
reached when the block hash is valid but its timestamp is outside the window.

```bash
# 1. Clone and patch partner-chains
git clone --branch v1.8.1 https://github.com/input-output-hk/partner-chains
cd partner-chains
git apply /path/to/partner-chains.patch   # see experiments/pubnet-node/

# 2. Clone and patch midnight-node
git clone --branch v0.22.2 <midnight-node-repo>
cd midnight-node
git apply /path/to/midnight-node.patch    # redirects Cargo deps to patched SDK

# 3. Build
cargo build --release -p midnight-node
```

Patch files are in `experiments/pubnet-node/`. The midnight-node patch assumes
`partner-chains/` is a sibling directory of `midnight-node/`.

**Suppress diagnostic warnings** once past genesis:
```
--log sidechain_mc_hash=error,partner_chains_db_sync_data_sources::block=error
```

---

### 8b. Nix-built binary requires dynamic linker patching for Docker/Ubuntu

**Applies to:** midnight-node v0.22.2 built with Nix, run outside the Nix environment

The `cargo build` output from a Nix shell embeds a Nix store path as its dynamic
linker. Running the binary on a standard Ubuntu host or inside a Docker image fails
with "No such file or directory" on the interpreter path.

**Fix:** Run `patchelf` before packaging:

```bash
patchelf \
  --set-interpreter /lib64/ld-linux-x86-64.so.2 \
  --set-rpath /usr/lib/x86_64-linux-gnu \
  target/release/midnight-node
```

Then the binary can be `COPY`'d into a standard `ubuntu:24.04` image with only
`libssl3`, `libgcc-s1`, and `ca-certificates` as runtime deps.

---

### 8c. Node data directory must be world-writable when running under Podman

**Applies to:** pubnet-node Podman Kubernetes YAML deployment

The midnight-node process writes chain state and SQLite index databases to `/data`
inside the container without a fixed UID. Mounting a host directory with restricted
permissions causes silent write failures.

**Fix:**
```bash
mkdir -p mainnet && chmod 777 mainnet
mkdir -p preprod && chmod 777 preprod
```

---

### 8d. Required environment variable: `CARDANO_SECURITY_PARAMETER=432`

**Applies to:** midnight-node v0.22.2 on mainnet and preprod

The Cardano security parameter `k` must be set explicitly. The correct value for
both Cardano mainnet and preprod is `432`. This affects the stability window
calculation (3k/f = 3×432/0.05 = 25,920 slots ≈ 7.2 h).

---

## 9. Paima Engine

### 9a. macOS esbuild installation workaround

**Applies to:** Paima Engine game templates on Apple Silicon / macOS

`npm install` may fail on macOS due to an esbuild platform mismatch. Fix:

```bash
npm install --save-dev esbuild@latest --target=esbuild-darwin-arm64
```

---

## Sources

- `experiments/mn-tui/lessons-learned.md` (internal)
- `experiments/local-tee-poc/lessons-learned.md` (internal)
- `experiments/pubnet-node/README.md` (internal)
- `experiments/paima-game-templates/generic/README.md` (internal)
