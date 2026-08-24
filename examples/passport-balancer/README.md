# passport-balancer

A small self-hosted service that pays other people's Midnight transaction fees
on **stagenet**.

It is the stagenet counterpart of the fee sponsorship the Passport demo already
consumes on preview and preprod. The demo's client
(`examples/passport-demo/src/lib/sponsor.ts`) builds a transaction with
`payFees: false`, balances every token kind **except** DUST locally, signs it,
proves it, and then asks a sponsor to attach the fee. On preview that sponsor is
the 1AM gateway. On stagenet there is none — so this is it.

The balancer holds NIGHT, registers that NIGHT for DUST generation, and spends
the resulting DUST on fee legs for transactions it did not build and will not
submit. The user's NIGHT never moves to pay a fee and the user's own wallet
still does the submitting, so sponsorship removes the cost without touching
custody or the approval moment.

---

## The decisive fact: ledger-9 sync works

The v8 wallet SDK cannot read stagenet — it fails on the indexer's schema with a
`ParseError`. The ledger-9 beta (`@midnight-ntwrk/wallet-sdk@2.0.0-beta.2`) can:

| Measurement | Result |
| --- | --- |
| Cold start from genesis to `isSynced` | **11.2 s** |
| Warm restart from the on-disk snapshot | **0.6 s** |
| Chain height at the time of the run | 156,519 blocks (protocol version 2000000) |
| Applied at sync | shielded index 3,963 / dust index 3,982, both strictly complete, indexer WebSocket connected |

Reproduce it at any time — nothing is submitted and no funds are needed:

```sh
BALANCER_ENV_FILE=~/.midnight-passport-balancer-stagenet.env npm run sync-check
```

`isSynced` is the SDK's own verdict: `isConnected && applied === highestRelevant`
for all three wallets, where *relevant* means relevant to this wallet rather than
the chain tip. The stagenet indexer (4.4.0-pre-alpha.16) reports its
`highestIndex` as `0`, so that field is printed beside the verdict and never as
it — see `progress` in `GET /status`.

## No proof server is required

Stagenet publishes no proof server, and the DUST fee leg this service adds has
to be proved by somebody. The beta SDK proves it **in this process**: the WASM
prover (`makeWasmProvingService`) fetches the four ledger-9 circuits —
`midnight/dust/spend`, `midnight/zswap/{spend,output,sign}` — and their BLS
parameters over HTTPS and keeps them in memory.

Measured on a cold start: **31.2 MiB in 8.1 s**. The fetch runs at start-up, in
parallel with the chain walk, so it is not in any caller's critical path, and
its outcome is reported by `GET /status` as `provingReadiness`. If the key
material cannot be loaded, `/balance-only` refuses with `PROVER_UNAVAILABLE` and
`/wallet-status` reports `available: 0` — the service never claims a capability
it does not have.

Set `BALANCER_PROVER_URL` to use an external proof server instead (a
`9.0.0-rc.5_experimental` image exists and will be hosted). A server proves
faster than a Node worker, so prefer it once it is up; nothing else changes.

---

## API

Three endpoints. The first two are read-only and safe to poll.

### `GET /wallet-status`

The readiness probe, in **exactly** the shape
`parseSponsorWalletStatus` in `sponsor.ts` reads — verified by running that
parser against this service's live response.

```json
{
  "total": 1,
  "available": 0,
  "wallets": [
    {
      "index": 0,
      "ready": true,
      "syncState": "ready",
      "address": "mn_addr_stagenet1…",
      "dust": { "balance": "0", "utxoCount": 0, "isSynced": true },
      "unavailableCause": "INSUFFICIENT_DUST"
    }
  ]
}
```

`ready` is the weak upstream notion — merely synced. **`available` is the one
that matters**, and the client gates on `available > 0` alone. It is `1` only
when this wallet can pay a fee *this instant*: synced, holding DUST, able to
prove, and not already holding the spend queue. A synced wallet with no DUST
reports `ready: true, available: 0`, which is exactly right and exactly why the
client does not trust `ready`.

`unavailableCause` is not read by `sponsor.ts` (it ignores unknown fields); it
is there so an operator reading a raw probe is not left guessing between
`WALLET_SYNCING`, `INSUFFICIENT_DUST`, `PENDING_TRANSACTION`, `PROVER_WARMING`,
and `PROVER_UNAVAILABLE`.

### `POST /balance-only`

The work. Send a serialised **finalized** (signed and proved) transaction; get
the same transaction back with a DUST fee leg attached and proved.

```sh
curl -X POST http://127.0.0.1:8807/balance-only \
  -H 'content-type: application/octet-stream' \
  --data-binary @transaction.bin
```

`application/octet-stream` is what the demo sends. Bare hex and
`{"txBytes": "<hex>"}` are also accepted so a failure can be reproduced with
`curl` without hand-writing a binary body.

Success — the shape `validateSponsorBalanceResult` requires:

```json
{ "txHash": "…", "txBytes": "<lower-case hex, no 0x>", "expiresAt": "<ISO 8601>" }
```

`expiresAt` is the TTL the balancing leg was actually built with, so the moment
the client refuses a stale transaction is the moment the ledger would.

**Nothing is submitted here.** The balanced transaction goes back to the caller
and the caller's own wallet submits it.

Refusals are typed, and carry the HTTP status `sponsor.ts` branches on:

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `INVALID_TRANSACTION` | The body is not a serialised finalized transaction. |
| 429 | `PENDING_TRANSACTION` | A balancing is already in flight; carries `retryAfterMs`. The client retries this inside a bounded window. |
| 503 | `WALLET_SYNCING` | Not synced yet. |
| 503 | `INSUFFICIENT_DUST` | No spendable DUST. |
| 503 | `PROVER_UNAVAILABLE` | Proving key material could not be loaded. |
| 502 | `BALANCE_FAILED` | Balancing or proving failed; `cause` carries the detail. |

Only DUST is balanced (`tokenKindsToBalance: ['dust']`). The caller balanced its
own shielded and unshielded legs before asking — adding to those here would
spend the balancer's NIGHT on somebody else's transfer.

### `GET /status`

The human answer, in the funder's idiom: network, address, NIGHT and DUST
balances, `synced` and the raw `progress`, how it proves and whether that is
ready, what the DUST registration did, how many transactions it has balanced.

---

## Configuration

Everything comes from the environment. Only `BALANCER_SEED` is required.

| Variable | Default | Meaning |
| --- | --- | --- |
| `BALANCER_SEED` | — | **Required.** 64 hex characters. Never logged, never leaves the process. |
| `BALANCER_NETWORK` | `stagenet` | Midnight network id. |
| `BALANCER_PORT` | `8807` | TCP port. |
| `BALANCER_HOST` | `0.0.0.0` | Bind address. Set `127.0.0.1` behind a TLS proxy. |
| `BALANCER_ALLOWED_ORIGINS` | `https://midnightpassport.com` | Comma-separated browser origin allow-list. |
| `BALANCER_STATE_DIR` | `./state` | Holds the sync snapshot. |
| `BALANCER_ENV_FILE` | — | A `KEY=VALUE` file to merge in. The real environment always wins. |
| `BALANCER_PROVER_URL` | — | External proof server. Unset means prove in-process. |
| `BALANCER_INDEXER_URL` | stagenet indexer | Overrides the network default. |
| `BALANCER_INDEXER_WS_URL` | derived | Defaults to the HTTP URL with `/ws` appended. |
| `BALANCER_NODE_URL` | `wss://rpc.stagenet.shielded.tools` | Submission relay source. |
| `BALANCER_FEE_BLOCKS_MARGIN` | `5` | Fee-estimate margin. A wallet with only a few blocks of DUST refuses its own transactions under a larger one. |
| `BALANCER_BALANCE_TTL_MS` | `1800000` | TTL on every balanced transaction, and the `expiresAt` handed back. |

Stagenet endpoints (ledger-9 release-candidate stack: node 2.0.0-rc.4, indexer
4.4.0-pre-alpha.16):

```
indexer  https://indexer.stagenet.shielded.tools/api/v4/graphql
         wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws
node     wss://rpc.stagenet.shielded.tools
```

---

## Getting it funded

The service is useless until it holds NIGHT, and it says so plainly rather than
pretending otherwise.

1. **Make a seed.** `npm run generate-seed` prints a fresh seed and the stagenet
   address it derives, using the same beta SDK the service runs, so the address
   is exactly the one the wallet will open.

2. **Keep the seed out of shell history.** Put it in a mode-600 file:

   ```sh
   install -m 600 /dev/null ~/.midnight-passport-balancer-stagenet.env
   printf 'BALANCER_SEED=%s\n' "$SEED" >> ~/.midnight-passport-balancer-stagenet.env
   ```

3. **Faucet the address once**, on stagenet.

4. **Start the service.** It does not wait to be funded: it listens
   immediately and answers `available: 0` honestly while it has nothing. When
   NIGHT arrives the running wallet picks it up live.

5. **DUST registration happens by itself.** Fees are paid in DUST, and DUST only
   accrues against *registered* NIGHT. The service retries the registration
   every minute until it succeeds, so an address fauceted after start-up is
   picked up without a restart.

   On ledger-9 a registration pays its own fee out of the DUST the registered
   NIGHT is *already projected* to have generated — there is no other DUST on a
   fresh wallet to pay it with. So the service estimates that fee
   (`estimateRegistration`) and waits for the projection to cover it
   (`waitForGeneratedDust`) before building the transaction. On a freshly
   fauceted wallet that is a wait of minutes, reported as
   `dustRegistration: "waiting-for-dust"`, not a failure.

Watch it come up:

```sh
curl -s http://127.0.0.1:8807/status | jq '{synced, balanceNight, dustSpecks, dustRegistration, provingReadiness, ready}'
```

---

## Running it

```sh
npm install
npm run typecheck                     # tsc --noEmit
npm run build                         # esbuild → dist/*.mjs
npm start                             # build, then run

npm run generate-seed                 # a fresh seed and its address
npm run sync-check                    # the ledger-9 sync proof, no funds needed
```

`state/`, `dist/`, and `node_modules/` are not committed.

### On the droplet, beside the funder

`passport-funder` already runs on the droplet on port 8799 behind
`https://funder.midnightpassport.com`. The balancer sits next to it on **8807**
with the same layout, so an operator learns one service:

| | funder | balancer |
| --- | --- | --- |
| unit | `passport-funder.service` | `passport-balancer.service` |
| working dir | `/opt/passport-funder` | `/opt/passport-balancer` |
| state | `/var/lib/passport-funder` | `/var/lib/passport-balancer` |
| env file | `/etc/passport-funder.env` | `/etc/passport-balancer.env` |
| port | 8799 | 8807 |

```ini
# /etc/systemd/system/passport-balancer.service
[Unit]
Description=Midnight Passport stagenet fee balancer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/passport-balancer
EnvironmentFile=/etc/passport-balancer.env
Environment=BALANCER_NETWORK=stagenet
Environment=BALANCER_HOST=127.0.0.1
Environment=BALANCER_PORT=8807
Environment=BALANCER_STATE_DIR=/var/lib/passport-balancer
Environment=BALANCER_ALLOWED_ORIGINS=https://midnightpassport.com
ExecStart=/usr/bin/node /opt/passport-balancer/dist/server.mjs
Restart=always
RestartSec=5
# The wallet saves its sync snapshot on the way out; give it room to.
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

`/etc/passport-balancer.env` holds only the seed, mode 600, root-owned:

```
BALANCER_SEED=<64 hex characters>
```

Deploy the way the funder deploys: rsync `src/`, `package.json`, and the locally
built `dist/`, then `npm install` on the droplet and
`systemctl restart passport-balancer`. Bind to `127.0.0.1` and publish through
the same TLS proxy the funder uses; `sponsor.ts` refuses a non-HTTPS sponsor URL
for anything but localhost, because a signed transaction crosses that wire.

The service handles `SIGTERM` by saving its sync snapshot before exiting, so a
restart resumes in under a second instead of walking the chain again.

---

## Notes on the ledger-9 beta SDK

The API has moved since v1. These are the differences that cost time here, and
they apply equally to the PWA's own upgrade.

- **The ledger is the hyphenless scope.** `@midnight-ntwrk/wallet-sdk@2.0.0-beta.2`
  binds to `@midnightntwrk/ledger-v9`, **not** `@midnight-ntwrk/ledger-v9`. They
  are two different WASM modules. Importing the hyphenated one hands the facade
  objects from a foreign instance.
- **`wallet-sdk-utilities` is mis-pinned in the published beta.** Every beta.2
  package pins it to exactly `1.2.0`, but the facade's compiled code imports
  `Clock` from it and `1.2.0` does not export `Clock` — a bare
  `SyntaxError: … does not provide an export named 'Clock'` at first import.
  `1.2.1` adds it, hence the `overrides` block in `package.json`. Do not remove
  it without checking whether the pin has been fixed upstream.
- **There is no global network id.** `setNetworkId`/`getNetworkId` from
  `@midnight-ntwrk/midnight-js-network-id` are gone. The network is a field on
  the wallet configuration and an argument to `createKeystore`. `stagenet` is a
  well-known id in `NetworkId`.
- **The keystore takes a tagged secret**: `createKeystore({ kind: 'schnorr',
  secret }, networkId)`. The HD wallet gained an `EcdsaUnshielded` role for the
  other scheme, but role *numbers* are unchanged, so a seed derives the same
  address it always did.
- **Cost parameters are required**, not optional, on the dust wallet:
  `costParameters: { feeBlocksMargin }`.
- **Transaction history is an interface, not a stub.** The old
  `{ upsert, getAll, get, serialize }` shape is now
  `gotPending`/`gotFinalized`/`gotRejected`; the SDK ships
  `NoOpTransactionHistoryStorage` for services that keep none.
- **Proving can happen in-process** — see above. `provingServerUrl` is now
  optional on the configuration, and `WalletFacade.init` takes a
  `provingService` factory instead.
- **`validateTransaction` is new**, with per-call-site strictness flags. Worth
  using on anything arriving from a third party, which is every transaction this
  service sees.
- **A DUST registration pays for itself** out of projected generation, so it has
  to wait: `estimateRegistration` then `waitForGeneratedDust`. On ledger-8 the
  registration was submitted immediately.
- The facade's balancing surface is otherwise familiar:
  `balanceFinalizedTransaction` / `balanceUnboundTransaction` /
  `balanceUnprovenTransaction` → `signRecipe` → `finalizeRecipe`.

## Proven end to end on stagenet

Run against live stagenet on 2026/08/24 with the service funded with 5,000
NIGHT. Every hash below is on chain.

**DUST registration** — `estimateRegistration` → `waitForGeneratedDust` →
`registerNightUtxosForDustGeneration`:

| | |
| --- | --- |
| Transaction | `fce32fbf51552560633c8ca9fd0fd7e132a5be0927440f6b18c7a44e862a5b78` |
| Block | 156,664 |
| Effect | `DustInitialUtxo`; the 5,000 NIGHT UTxO rotated to itself |
| DUST 2 minutes later | 9.71 × 10¹⁵ Specks, 1 UTxO |

**The full sponsored round trip**, from a throwaway wallet holding 2 NIGHT and
**zero DUST** — it could not have paid a fee itself:

| Leg | Wall clock | |
| --- | --- | --- |
| Throwaway opens and syncs (cold) | 11.7 s | |
| `transferTransaction(payFees:false)` → balance without DUST → sign → prove locally | 0.0 s | 630 bytes; a plain unshielded transfer needs no zk proof |
| `POST /balance-only` | **10.3 s** | 630 → 3,816 bytes; the balancer proved the DUST spend circuit in-process |
| Throwaway submits the balanced transaction | 18.0 s | |
| End to end | **28.4 s** | |

| | |
| --- | --- |
| Pre-sponsorship hash | `02d223fdf7b7aa6ce6d05e1e40c09ece2a161664d374bc1e2237486142b0d68d` |
| Submitted hash | `584c89a858fbb6e4962ede289b57115a153bca4dc8ad07a55e3c6b64cc3ef745` |
| Block | 156,821 |
| Outputs | 1 NIGHT to the recipient, 1 NIGHT change to the throwaway |
| Fee | `DustSpendProcessed` — paid by the balancer, from a wallet that held none |

The balancer's own NIGHT went 4,998 → 4,999 (it was the recipient) and
`balancesServed` went to 1. **No proof server was involved at any point.**

`sponsorReadiness` from the demo's own client reported
`{"state":"ready","url":"…","available":1}` against the funded service, and
`describeSponsorWalletStatus` rendered `sponsor reports 1/1 wallets available`.

### Two things that behaved differently from the unfunded predictions

**A spend does *not* strand the DUST registration.** The worry was that
consuming a registered NIGHT UTxO would leave the change unregistered and
silently stop DUST generation. It does not: a 2 NIGHT operator transfer
(`600af82c9e5e191452adaff4fe728dea50b993fc4234f8ebf0746fbed25f6134`, block
156,701) emitted `DustSpendProcessed`, `DustGenerationDtimeUpdate`, and
`DustInitialUtxo` in one transaction, and the 4,998 NIGHT change came back
already generating, with a *higher* DUST balance than before the spend.
Immediately after submitting, the wallet does briefly read `NIGHT 0, DUST 0` —
that is the change settling, not a lost registration.

**The first submission after start-up can lose a WebSocket race.** The very
first registration attempt failed with `SubmissionError: Transaction submission
failed … disconnected from wss://rpc.stagenet.shielded.tools/: 1000:: Normal
Closure`. The endpoint is healthy — probed directly, it holds a connection open
for 45 s and answers `system_chain: "Midnight Stagenet"`, `system_version:
"2.0.0-d9729c13"` — so this is the Polkadot provider reconnecting after the
`subscribeRuntimeVersion` closure seen at every start-up, and a submission
racing that reconnect. The retry a minute later went through. **A one-shot
registration would have turned that transient into a permanent failure**, which
is the main reason the registration loop never ends.

### A window an operator should expect

After the balancer *receives* a transaction — a top-up, or being the recipient
as in the drill above — it reports `available: 0` with
`unavailableCause: "WALLET_SYNCING"` for up to about two minutes, then recovers
on its own.

The cause is in the SDK: `isStrictlyComplete()` is
`isConnected && Math.abs(highestRelevantWalletIndex - appliedIndex) <= 0`. When
a transaction lands, the wallet applies it before the indexer finishes streaming
it, so `applied` runs *ahead* of `highestRelevant` — measured at `applied 815,
highestRelevant 814` — and the `Math.abs` scores being ahead exactly as it
scores being behind. Being ahead is not being behind, and is harmless.

This service deliberately does **not** paper over it with a tolerance: the SDK's
verdict stays the source of truth, and a caller turned away for two minutes
falls back to the unsponsored path, which is safe. It matters only that an
operator topping the balancer up knows to expect it rather than reading it as a
fault.
