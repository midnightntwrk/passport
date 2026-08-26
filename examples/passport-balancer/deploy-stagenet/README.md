# deploy-stagenet

Puts the Midnight Passport contracts onto **stagenet** — the ledger-9
release-candidate network — and proves the registry works by registering a name
on it and reading the name back.

It sits beside `passport-balancer` because it spends from the same wallet: the
balancer's stagenet seed pays every fee and every registration cost here.

---

## The stack

Stagenet runs ledger 9, and nothing in the ledger-8 toolchain can speak to it.
Every version below is the one the Q2 stagenet compatibility matrix names, and
they are pinned exactly — no carets.

| Component | Version | Where it comes from |
| --- | --- | --- |
| Compact compiler | `0.33.0-rc.2` | GitHub release `compactc-v0.33.0-rc.2` on **`LFDT-Minokawa/compact`** |
| Compact runtime | `0.18.0-rc.1` | npm `@midnight-ntwrk/compact-runtime` |
| Compact.js | `2.5.5-rc.7` | npm `@midnight-ntwrk/compact-js` |
| Midnight.js | `5.0.0-beta.6` | npm `@midnight-ntwrk/midnight-js-*` |
| Wallet SDK | `2.0.0-beta.2` | npm `@midnight-ntwrk/wallet-sdk` |
| Ledger | `1.0.0-rc.3` | npm `@midnightntwrk/ledger-v9` — **hyphenless scope** |
| Proof server | `9.0.0-rc.6` | `midnightntwrk/proof-server:9.0.0-rc.6` |
| Node / indexer | `2.0.0-rc.4` / `4.4.0-rc.1` | stagenet |

The compiler is **not** on the `midnightntwrk/compact` releases the `compact`
CLI reads: that repository stops at 0.31.1, and `compact update 0.33.0-rc.2`
fails with `Couldn't find specified version`. The rc lives on
`LFDT-Minokawa/compact`, so it is installed by hand into the CLI's own layout,
which leaves the default compiler for every other project untouched:

```sh
V=0.33.0-rc.2
D=~/.compact/versions/$V/aarch64-darwin
mkdir -p "$D" && cd "$D"
curl -sL -o artifact.zip \
  "https://github.com/LFDT-Minokawa/compact/releases/download/compactc-v$V/compactc_v${V}_aarch64-darwin.zip"
shasum -a 256 artifact.zip   # 35a28009c9a57d20902e4fcfd12f0ca9ea94338208954cf8bcd335652e24f382
unzip -oq artifact.zip
compact list -i               # 0.33.0-rc.2 appears; the → default is unchanged
```

`compactc --version` reports `0.33.0` (the rc suffix is not in the binary), and
`--language-version` / `--ledger-version` / `--runtime-version` report
`0.25.0` / `ledger-9.1.0.0-rc.3` / `0.18.0-rc.1`.

---

## The contracts

Sources and builds live in `../contracts-stagenet/`. They are **copies** — the
originals in `experiments/` belong to the upstream team and are not touched.

| Build | Source | Copied from |
| --- | --- | --- |
| `midnames` | `src/midnames.compact` | `experiments/account-custody-prototype/.cache/midnames-sdk-preview/packages/contract/src/leaf.compact` (Midnames rev 83f8422) |
| `account` | `src/account.compact` | `experiments/account-custody-prototype/contracts/account.compact` |
| `faucet` | `src/faucet.compact` | `experiments/account-custody-prototype/contracts/faucet.compact` |

### Every source change, in full

Compact went from language 0.23 to **0.25** between compiler 0.31.1 and
0.33.0-rc.2, and the compiler rejects an exact-version pragma it does not match
(`language version 0.25.0 mismatch`). That is the entire diff:

```diff
--- account.compact
-pragma language_version 0.23;
+pragma language_version 0.25;

--- faucet.compact
-pragma language_version 0.23;
+pragma language_version 0.25;
```

`midnames.compact` is **byte-identical** to `leaf.compact`: its pragma is
`>= 0.20`, which 0.25 satisfies. No stdlib renames, no type changes, no circuit
changes — three contracts written for ledger-8 compile for ledger-9 untouched
apart from two version numbers.

### Rebuilding

```sh
C=~/.compact/versions/0.33.0-rc.2/aarch64-darwin/compactc
cd ../contracts-stagenet
for name in faucet account midnames; do "$C" "src/$name.compact" "managed/$name"; done
```

Measured on this machine: faucet 15 s (1 circuit), account 149 s (14), midnames
132 s (11). `--skip-zk` turns each into a second or two when only the TypeScript
output matters.

`../contracts-stagenet/node_modules/` holds two symlinks into this package's
`node_modules`, and they are load-bearing rather than tidy: a generated module's
first statement is `checkRuntimeVersion('0.18.0-rc.1')`, and without the links
Node resolves `@midnight-ntwrk/compact-runtime` upward to the repository root's
ledger-8 copy. Two copies of the runtime is also how you get
`expected instance of ChargedState` when decoding contract state, so both the
harness and the contract module must resolve the *same* one.

---

## Running it

```sh
npm install
npm run smoke                                   # do the builds load against 0.18.0-rc.1?

docker run -d --name passport-proof-server-stagenet -p 6300:6300 \
  midnightntwrk/proof-server:9.0.0-rc.6         # no --network flag any more

BALANCER_ENV_FILE=~/.midnight-passport-balancer-stagenet.env \
  node src/deploy.mjs                           # all legs
BALANCER_ENV_FILE=… node src/deploy.mjs tld     # or one at a time
```

Legs are `faucet`, `account`, `tld`, `register`; with no argument all four run.
Each one appends to `state/deployments-stagenet.json` **as it lands**, so a
failure half way through never loses an address that has already been paid for,
and a re-run picks up from the state file.

| Variable | Default | Meaning |
| --- | --- | --- |
| `BALANCER_SEED` | — | Required, 64 hex. Read from `BALANCER_ENV_FILE`; never printed. |
| `DEPLOY_PROOF_SERVER_URL` | `http://127.0.0.1:6300` | Proves contract circuits. |
| `BALANCER_PROVER_URL` | unset | Proves the wallet's own fee legs. Unset means in-process WASM. |
| `DEPLOY_LABEL` | `passport-<random>` | The name the `register` leg claims. |
| `DEPLOY_STATE_DIR` | `./state` | Sync snapshot and the deployment record. |

---

## What each leg does

**`faucet`** — deploys `faucet.compact`, the shielded-mint contract the demo
uses as its mUSD stablecoin pattern. One circuit, `mint_shielded`, no witnesses,
no constructor arguments.

**`account`** — deploys one account-custody contract with **throwaway** device,
grant, and recovery secrets generated in-process and kept nowhere. It is a proof
that ACC deploys work on ledger-9, not a user account.

**`tld`** — deploys `midnames.compact` as our own `.night` TLD registry
instance. The parameters are the deployed **preview** registry's own, read off
chain on 2026/08/24 rather than guessed:

| Field | Preview registry | Ours |
| --- | --- | --- |
| `PARENT_DOMAIN` | none | none |
| `PARENT_RESOLVER` | 32 zero bytes | 32 zero bytes |
| `DOMAIN` | `night` | `night` |
| `COST_SHORT` / `MED` / `LONG` | 600 / 140 / 10 | 600 / 140 / 10 |
| `BUY_ENABLED` | `true` | `true` |
| `DEFAULT_FIELD` | none | none |
| `DOMAIN_OWNER` | the Midnames team's key | derived from the balancer seed |
| `COIN_COLOR` | native NIGHT | native NIGHT |

The two that differ are the two that must: the owner key is ours, and the
address `COST` is paid to is the balancer's, so a sponsored registration pays us
rather than a stranger.

**`register`** — deploys a resolver leaf whose `DOMAIN_TARGET` is the
account-custody contract from the `account` leg, calls `register_domain_for` on
our TLD, and then reads the name back **through the registry** to the contract
it points at. The caller's witness secret is deliberately *not* the TLD owner's,
so the circuit takes `COST` in unshielded NIGHT exactly as it does when the
funder sponsors a name on preview.

---

## On chain, 2026/08/24

Every address and hash below is live on stagenet. The hashes are 64-hex **ledger**
hashes, resolved from the identifiers midnight.js returns through the indexer's
`transactions(offset: { identifier: … })`.

| What | Contract address | Transaction | Block | Leg |
| --- | --- | --- | --- | --- |
| mUSD faucet / mint | `4fc92e152e8d854ef9337275504244e18bd6e3d7d41fd81ed2dabf62be78e92f` | `89ea659f44bacb4b7ef18361f660aa5e141ddd2e138ba29fc7a8ec4606dfd1c1` | 157,776 | 44.0 s |
| Account custody (smoke test) | `d7491e60acedee0b32dffca89b067fb7fb236348e787817d415b7e964004abbc` | `cc609c91185883b8f769e7104c8544c192d19d6b7b02a4b5aaf9b2dcc9465031` | 157,790 | 43.5 s |
| **`.night` TLD registry** | `29be1e64846cff4600c5297fa54b27d4c9296b3ccc2cdba190eaba1d64c5f116` | `49e4c2398a92760a15afbc7d6a89945160c472d85263e339a543bdd81a66e710` | 157,797 | 42.6 s |
| Resolver leaf for `passport-771a3f.night` | `805f806389275dc12b9ec5ead248aeef0ae2aa8909670c59091166bbfa4ee06a` | `fa1d50b713aca16fe21d1fd58db39d6fc4cbbded86bd0ce0974b88fdc446fb86` | 157,853 | 68.5 s |
| `register_domain_for` on the TLD | (a call, not a deploy) | `6fd842da3319c0b445f7527ecfc37e59684a2db5bf68b7f3d4525723870494d0` | 157,865 | 71.7 s |

One further leaf, `40dc8ee363caa38bd0dbcf62677252cef03b0ea3485c556edd24ac9284fbfb99`
(tx `30bfd8409ceba90abdc7f1220d0b201b615f488df9ed0cd23ba2290dfe02237b`, block
157,807), is on chain and orphaned: it was deployed for a first registration
attempt that then died inside `validateTransaction`, and nothing points at it.

The wallet: cold start to a stable synced state **34.8 s**, warm restart from the
on-disk snapshot **26–27 s** (the throttle window is most of that). Contract
proving on the local 9.0.0-rc.6 server: `/check` 0.02 s, `/prove` **10.6 s** for
`register_domain_for`. Every fee leg was proved **in-process** by the wallet
SDK's WASM prover — no proof server involved in balancing at any point.

### The registry read-back

Read back through the deployed registry, not from anything this harness
remembered:

```json
{
  "domain": "passport-771a3f.night",
  "ownerKeyOnChain": "09c84d2ad1e744248fa2112a8cd5d1d2cc4fe221c99472c9ef90fd1528bc477b",
  "resolverAddress": "805f806389275dc12b9ec5ead248aeef0ae2aa8909670c59091166bbfa4ee06a",
  "target": { "kind": "contract", "hex": "d7491e60acedee0b32dffca89b067fb7fb236348e787817d415b7e964004abbc" },
  "registrySize": "1",
  "registryCosts": "600/140/10",
  "buyEnabled": true
}
```

`domains.lookup(labelKey)` on the TLD gives the resolver; the resolver's
`DOMAIN_TARGET`, decoded the way `decodeDomainTarget` decodes it, gives the
account-custody contract from the `account` leg. The name resolves to the
contract it was pointed at.

**The paid path really was paid.** The indexer's view of the registration
transaction is a `ContractCall` on the TLD with `status: SUCCESS`, spending
1,000,000 atomic NIGHT and creating two outputs: **10** — `COST_LONG`, taken by
`receiveUnshielded` and sent on to `DOMAIN_OWNER[1]` — and 999,990 change. The
caller's witness secret is not the TLD owner's, so the circuit took the money,
which is exactly the sponsorship shape the funder uses on preview. Because
`DOMAIN_OWNER[1]` is the balancer's own address, the 10 came straight back and
the wallet's NIGHT is unchanged at 4,999; only DUST was really consumed
(2.32 × 10¹⁷ → 2.20 × 10¹⁷ Specks across the last leg).

---

## The ledger-8 → ledger-9 differences that cost time

These are the ones that produced a real failure here, and they apply to the
PWA's own migration.

- **`compact update` cannot install the rc.** The compiler is published on a
  different GitHub organisation from the one the CLI reads. Install it by hand.
- **`constructorContext` is `createConstructorContext`** in compact-runtime
  0.18, and `Contract.initialState` is now **async**. `convertFieldToBytes` is
  gone; `keccak256`, the secp256k1 family, `crossContractCall`, and
  `createCallContext` are new.
- **midnight.js 5 takes a `compiledContract`, not a `contract`.** The contract
  instance is wrapped by `CompiledContract.make(tag, Contract).pipe(...)` from
  compact.js, with `withWitnesses` or `withVacantWitnesses` and
  `withCompiledFileAssets(dir)`.
- **`WalletProvider` changed shape.** `coinPublicKey`/`encryptionPublicKey`
  properties became `getCoinPublicKey()`/`getEncryptionPublicKey()` methods, and
  `balanceTx(tx, newCoins)` became
  `balanceTx(tx: UnboundTransaction, ttl?: Date): Promise<FinalizedTransaction>`
  — which maps exactly onto the wallet SDK's
  `balanceUnboundTransaction` → `signRecipe` → `finalizeRecipe`.
- **`setNetworkId` still exists and is now mandatory.** `getNetworkId()` throws
  when unset, and `midnight-js-contracts` calls it inside
  `Transaction.fromParts`. `NetworkId` is a plain string now, not an enum.
- **Providers take option objects.** `indexerPublicDataProvider({ queryURL,
  subscriptionURL })` and `httpClientProofProvider({ url, zkConfigProvider,
  timeout })`; the positional forms are deprecated.
- **ZK artefact integrity is fail-closed.** `NodeZkConfigProvider(dir)` verifies
  every key against `<dir>/compiler/contract-manifest.json` and throws when it is
  missing. Ship the whole `compiler/` directory, not just `keys/` and `zkir/`.
- **The proof server dropped `--network`.** 9.0.0-rc.6 takes only `--port`,
  `--verbose true|false`, `--num-workers`, `--job-capacity`, `--job-timeout`,
  `--no-fetch-params`. `-e MIDNIGHT_PROOF_SERVER_VERBOSE=1` is rejected: the
  value must be `true` or `false`.
- **`isSynced` flaps.** Taking the first `true` off `facade.state()` catches a
  transient and the next balancing fails with "could not balance dust";
  `throttleTime(5_000)` before the filter is the fix.
- **Keep-alive breaks `watchForTxData`.** The indexer closes pooled sockets and
  midnight.js reports `Premature close` on a transaction that has in fact
  landed. `http.globalAgent = new http.Agent({ keepAlive: false })`.
- **`facade.validateTransaction` cannot be used on a contract call.** This one
  cost a paid-for deploy. The beta SDK's validation service builds a *blank*
  ledger state — `LedgerState.blank(networkId)` with only the real parameters —
  and runs `wellFormed` against it, so a transaction calling any deployed
  contract fails with
  `call to non-existant contract ContractAddress(29be1e64…)` even when that
  contract demonstrably exists (ours had been on chain since block 157,797).
  The check is sound for a self-contained transfer, which is why the balancer
  service uses it, and structurally impossible for a contract call. Leave it out
  of the call path; `submitTransaction` does not run it.
