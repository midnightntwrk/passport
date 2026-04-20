# Minting, distributing, and transfering shielded custom tokens


## Transcript of running the example


### Enter development environment

```console
$ nix develop
```


### Install dependencies

```console
$ npm install
```


### Compile the contract

```console
$ npm run compile

> fungible-token@1.0.0 compile
> compact compile contracts/hello-world.compact contracts/managed/hello-world

Compiling 1 circuits:
  circuit "mint" (k=14, rows=10865)
Overall progress [====================] 1/1
```


### Deploy the contract

```console
$ npm run deploy

> fungible-token@1.0.0 deploy
> tsx src/deploy.ts

╔══════════════════════════════════════════════════════════════╗
║        Deploy Contract to Midnight Preprod                   ║
╚══════════════════════════════════════════════════════════════╝

─── Wallet Setup ───────────────────────────────────────────────

Enter your mnemonic: ******

--- Account Addresses ---

Unshielded : mn_addr_preprod1u325ecjwg5aqnhg4lkqd7j9avn9mwwm4yl5w5fleet06za6dnamqry3hv3
Shielded   : mn_shield-addr_preprod1t4yp0q7e75p2kkpdznvce80ucr3mmw5cx4sxq5dfl7dcuc7959p73vcpxkhfscksve789k0qnkz3fqaretumx8fwl45jvrnr768j0vqq4kuwv
Dust       : mn_dust_preprod1w0gm06hnrcuwg4t0sa6l39kwdyc7cc6wadf8lw55jsvsxuenurvx2h78w8l

Creating wallet...
Syncing wallet to network . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .
Wallet Synced!

Wallet Address: mn_addr_preprod1u325ecjwg5aqnhg4lkqd7j9avn9mwwm4yl5w5fleet06za6dnamqry3hv3

--- Wallet Balances ---

Shielded:

Unshielded:
0000000000000000000000000000000000000000000000000000000000000000: 6015625000

Dust: 31512849131562499985

─── Deploy Contract ────────────────────────────────────────────

Deploying contract (this may take 30-60 seconds)...

✅ Contract deployed successfully!

Contract Address: 055f3c5f14fb96c7a7b778a0abac08509b38f896ceb5c02f978199f4b3dad5de

Saved to deployment.json

─── Deployment Complete! ───────────────────────────────────────
```

View the contract: [055f3c5f14fb96c7a7b778a0abac08509b38f896ceb5c02f978199f4b3dad5de](https://www.midnightexplorer.com/contracts/12526)


### Mint the shielded custom tokens and transfer them from one address to another

```console
$ npm run shielded-mint-and-transfer

> fungible-token@1.0.0 shielded-mint-and-transfer
> tsx src/shielded-mint-and-transfer.ts

╔══════════════════════════════════════════════════════════════╗
║   Shielded Mint and Transfer — Midnight Preprod              ║
╚══════════════════════════════════════════════════════════════╝

Enter Wallet A mnemonic: ******
Enter deployed Contract Address: 055f3c5f14fb96c7a7b778a0abac08509b38f896ceb5c02f978199f4b3dad5de

--- Account Addresses ---

Unshielded : mn_addr_preprod1u325ecjwg5aqnhg4lkqd7j9avn9mwwm4yl5w5fleet06za6dnamqry3hv3
Shielded   : mn_shield-addr_preprod1t4yp0q7e75p2kkpdznvce80ucr3mmw5cx4sxq5dfl7dcuc7959p73vcpxkhfscksve789k0qnkz3fqaretumx8fwl45jvrnr768j0vqq4kuwv
Dust       : mn_dust_preprod1w0gm06hnrcuwg4t0sa6l39kwdyc7cc6wadf8lw55jsvsxuenurvx2h78w8l

─── Wallet Setup ───────────────────────────────────────────────

Initializing Wallet A...
Syncing Wallet A to network . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .
Wallet Synced!

--- Wallet Balances ---

Shielded:

Unshielded:
0000000000000000000000000000000000000000000000000000000000000000: 6015625000

Dust: 31512864181765624984

─── Mint ───────────────────────────────────────────────────────

Connecting to contract at 055f3c5f14fb96c7a7b778a0abac08509b38f896ceb5c02f978199f4b3dad5de...

Generating local ZK proof and submitting mint transaction...

✅ Mint transaction successful!
Hash:     6cf5aa8768655e8f3bcdfb164948c9d500d233df69d05393c0772794525ee3cb
Token ID: 9c01c4b9ab5e723cc8388502ef93d2f265514f70afd7d2c530fda1a0ecd3b4b1

Waiting for wallet to detect newly minted custom tokens...
Current Custom Token Balance: 1000
✅ New tokens detected in Wallet A!

─── Transfer ───────────────────────────────────────────────────

Destination: mn_shield-addr_preprod15xtxvtv4svrtslf9zgqexp9errqyq9ktxfpdftnutw4tkwzg029tekpzlgw3s0788cpzn5drad5n3k3whfqly8h05cn9mjuyukztjfqxkdmzn

Building transfer transaction...
Signing transfer transaction...
Finalizing transfer transaction...
Submitting transfer to network...

✅ Transfer successful!
Transaction ID: 00a4fa531d7369fc243f9df471bbf52768b07efa56d2d1ce250b0890ebfe11d69a

Waiting for wallet to settle (expected balance: 700)...
Current balance: 700
Final Wallet A Custom Token Balance: 700
```

View the transactions:

- Minting: [6cf5aa8768655e8f3bcdfb164948c9d500d233df69d05393c0772794525ee3cb](https://www.midnightexplorer.com/tx/6cf5aa8768655e8f3bcdfb164948c9d500d233df69d05393c0772794525ee3cb)
- Transfer: [00a4fa531d7369fc243f9df471bbf52768b07efa56d2d1ce250b0890ebfe11d69a](https://www.midnightexplorer.com/tx/00a4fa531d7369fc243f9df471bbf52768b07efa56d2d1ce250b0890ebfe11d69a)


### Check the wallet's balance

```console
$ npm run balance

> fungible-token@1.0.0 balance
> tsx src/balance.ts

╔══════════════════════════════════════════════════════════════╗
║        Wallet Balance — Midnight Preprod                     ║
╚══════════════════════════════════════════════════════════════╝

Enter wallet mnemonic: ******

--- Account Addresses ---

Unshielded : mn_addr_preprod1u325ecjwg5aqnhg4lkqd7j9avn9mwwm4yl5w5fleet06za6dnamqry3hv3
Shielded   : mn_shield-addr_preprod1t4yp0q7e75p2kkpdznvce80ucr3mmw5cx4sxq5dfl7dcuc7959p73vcpxkhfscksve789k0qnkz3fqaretumx8fwl45jvrnr768j0vqq4kuwv
Dust       : mn_dust_preprod1w0gm06hnrcuwg4t0sa6l39kwdyc7cc6wadf8lw55jsvsxuenurvx2h78w8l

─── Wallet Setup ───────────────────────────────────────────────

Initializing wallet...
Syncing wallet to network . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .
Wallet Synced!

--- Wallet Balances ---

Shielded:
9c01c4b9ab5e723cc8388502ef93d2f265514f70afd7d2c530fda1a0ecd3b4b1: 700

Unshielded:
0000000000000000000000000000000000000000000000000000000000000000: 6015625000

Dust: 31512864055953124982
```


### Check the contract's public state

```console
$ npm run contract-state

> fungible-token@1.0.0 contract-state
> tsx src/contract-state.ts

╔══════════════════════════════════════════════════════════════╗
║        Contract State — Midnight Preprod                     ║
╚══════════════════════════════════════════════════════════════╝

Enter contract address: 055f3c5f14fb96c7a7b778a0abac08509b38f896ceb5c02f978199f4b3dad5de

─── Public State ───────────────────────────────────────────────

total_supply : 1000
mint_nonce   : 1
```


### Check the balance of the account that received the transfer

```console
$ npm run balance

> fungible-token@1.0.0 balance
> tsx src/balance.ts

╔══════════════════════════════════════════════════════════════╗
║        Wallet Balance — Midnight Preprod                     ║
╚══════════════════════════════════════════════════════════════╝

Enter wallet mnemonic: ******

--- Account Addresses ---

Unshielded : mn_addr_preprod1tqcl5yytaawn4chdwaqp35synp3w2xpclcv9r4uvst4rlg2kul5qft769v
Shielded   : mn_shield-addr_preprod15xtxvtv4svrtslf9zgqexp9errqyq9ktxfpdftnutw4tkwzg029tekpzlgw3s0788cpzn5drad5n3k3whfqly8h05cn9mjuyukztjfqxkdmzn
Dust       : mn_dust_preprod1wwwgnz45r007ecg7x85tpewqpnr0kr85l0zf40zaxpmtx92e7wdxxe6qjfn


─── Wallet Setup ───────────────────────────────────────────────

Initializing wallet...
Syncing wallet to network . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .
Wallet Synced!

--- Wallet Balances ---

Shielded:
9c01c4b9ab5e723cc8388502ef93d2f265514f70afd7d2c530fda1a0ecd3b4b1: 300

Unshielded:
0000000000000000000000000000000000000000000000000000000000000000: 9734375000

Dust: 42126380896234374999
```


## 🤖 Experience Report

This section documents the non-obvious problems encountered while developing this example, as a reference for future SDK users.

### 1. Error object swallowed in catch handler

Using a template literal `${error}` in `console.error` serializes the error to a string, silently dropping the nested `.cause` chain that carries the real underlying message. Always use comma syntax — `console.error('message:', error)` — to preserve the full error object.

### 2. Stale LevelDB store causes AES-GCM decryption failure

`levelPrivateStateProvider` encrypts its local state using AES-GCM with a PBKDF2 key derived from the wallet's encryption public key. If the script is run with a different wallet from the one that originally created the store, decryption fails with "Unsupported state or unable to authenticate data". The fix is to delete the `midnight-level-db/` directory entirely when switching wallets.

### 3. `findDeployedContract` requires `initialPrivateState`

After deleting the LevelDB store the script failed with "No private state found at private state ID 'fungibleTokenState'". The `findDeployedContract` call must include `initialPrivateState: {}` (the same as `deployContract`) so that the provider can seed the empty store on first access.

### 4. Compact witnesses must return a tuple

The `get_user_shielded_address` witness was returning only the value `{ bytes: ... }`, but the Compact runtime requires a `[updatedPrivateState, value]` tuple. The correct signature is:

```typescript
get_user_shielded_address: (context: any) => [context.privateState, { bytes: hexToBytes32(...) }]
```

This convention is easy to miss because the type error manifests as a generic "object is not iterable" at runtime rather than a compile-time failure.

### 5. WASM panic in `ZswapChainState.tryApply` (ledger-v7 7.0.0/7.0.1 bug)

Minting shielded outputs into a non-empty Merkle tree causes `MerkleTree::collapse` to panic inside the WASM module, surfacing as `RuntimeError: unreachable`. This is a known bug tracked at [geofflittle/tryapply-crash-repro](https://github.com/geofflittle/tryapply-crash-repro). The workaround is to monkey-patch the method to catch the panic and return `[this, new Map()]`, effectively treating the failed apply as a no-op on the chain state.

### 6. Transaction hash lives at `mintTx.public.txHash`

The `FinalizedCallTxData` type separates public and private fields: `mintTx.txHash` is `undefined`; the hash is at `mintTx.public.txHash`.

### 7. Wallet polling needs an explicit timeout

`rx.firstValueFrom(wallet.state().pipe(rx.filter(...)))` will hang indefinitely if the expected condition never arrives. Always add `rx.timeout({ first: ..., with: () => rx.throwError(...) })`.

### 8. Wallet-visible token ID is not the contract address

The wallet stores shielded token balances under a derived `RawTokenType` key, not the raw contract address. Looking up balances by contract address always returns zero. The correct key is available directly on the mint result: `mintTx.private.newCoins[0].type`.

### 9. Wallet state snapshot is stale immediately after `submitTransaction`

Reading `wallet.state()` with `firstValueFrom` right after submitting the transfer returns a pre-settlement snapshot. The reliable pattern is to poll until the balance reaches the expected value:

```typescript
rx.filter((state) => state.shielded.balances[tokenId] === expectedBalance)
```
