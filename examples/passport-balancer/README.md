# passport-balancer

A small self-hosted service that pays for onboarding a Midnight Passport on
**stagenet** — all three costs of it, none of which reach the user's wallet.

| The cost | The endpoint | Who pays |
| --- | --- | --- |
| The **fee** on the user's own transactions | `POST /balance-only` | the balancer's DUST |
| The **name** — `alice.night` | `POST /register-alias` | the balancer's NIGHT and DUST |
| The **activation grant** inside the user's account contract | `POST /fund-account` | the balancer's NIGHT and DUST |
| The **opening balance** — 100 mUSD, inside the same contract | `POST /fund-account` | the mUSD faucet, and the balancer's DUST |

A new Passport therefore opens holding money, in the contract rather than in a
wallet, with **no user-side transaction of any kind**. `/fund-account` does both
legs: `deposit_night` for the NIGHT that makes the account operable, and a
faucet mint followed by `deposit_shielded` for the 100 mUSD that makes it worth
opening.

The fee leg is the stagenet counterpart of the sponsorship the Passport demo
already consumes on preview and preprod. The demo's client
(`examples/passport-demo/src/lib/sponsor.ts`) builds a transaction with
`payFees: false`, balances every token kind **except** DUST locally, signs it,
proves it, and then asks a sponsor to attach the fee. On preview that sponsor is
the 1AM gateway. On stagenet there is none — so this is it.

The balancer holds NIGHT, registers that NIGHT for DUST generation, and spends
the resulting DUST on fee legs for transactions it did not build and will not
submit. The user's NIGHT never moves to pay a fee and the user's own wallet
still does the submitting, so sponsorship removes the cost without touching
custody or the approval moment.

### Why the other two endpoints are here and not in the funder

`examples/passport-funder` does the name and the grant on **preview**, and this
is a port of it — same policy order, same refusal codes, same response shapes,
so a client written against one works against the other. It had to move rather
than be pointed at stagenet for two reasons:

1. The funder runs the **v8** wallet SDK, which cannot read stagenet at all — it
   fails on the indexer's schema with a `ParseError`. Everything here is the
   ledger-9 beta.
2. Sponsoring a name is exactly the gap a migrated PWA still has.
   `register_domain_for` takes the registry price from its **caller** in
   unshielded NIGHT, a fresh passkey wallet holds none, and stagenet's faucet is
   captcha-gated — so there is no self-service path to that 10 atomic NIGHT. The
   registry's entrypoint takes the owner as an **argument**, so a third party can
   pay while the registry still records the user's key as owner. The balancer,
   already holding NIGHT and DUST for the fee leg, is the third party already
   standing there.

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

### …and that now covers CONTRACT circuits too

`/register-alias` and `/fund-account` prove `register_domain_for` and
`deposit_night`, which are **our** circuits: their prover keys, verifier keys,
and ZKIR are on disk in `contracts-stagenet/managed/`, not published anywhere.
`deploy-stagenet` proved them through a local Docker proof server, and that
would have made Docker a new dependency of the droplet for the one endpoint
whose whole point is removing dependencies.

It is not required. The same WASM prover runs them here, because the join is
only about **key material**:

- `WasmProver` (`@midnight-ntwrk/wallet-sdk`) runs `@midnight-ntwrk/zkir-v2` in a
  worker thread — so a two-minute proof does not block `/wallet-status` — and
  exposes `asProvingProvider()`, a ledger `ProvingProvider`;
- `createProofProvider` (`@midnight-ntwrk/midnight-js-types`) turns that into the
  `ProofProvider` a contract call wants;
- the `KeyMaterialProvider` those consult is the **union** of two sources,
  resolved in the same order `httpClientProofProvider` resolves them: the
  `ZKConfigRegistry`'s verifier-key join against our on-disk build first, the
  flat provider second, the published ledger circuits last. BLS parameters
  always come from the published source — they are a property of circuit size,
  not of the contract.

The registry's verifier-key join is worth having for its own sake: it refuses an
artefact set whose verifier key does not match what the **deployed** contract
carries, which catches a stale build before it produces a proof the node would
reject.

Measured on stagenet, in-process, no proof server: a whole sponsored
registration — resolver-leaf deploy *and* the paid `register_domain_for`, two
transactions with a chain confirmation between them — took **113 s**; an
activation grant took **35 s**. `GET /status` reports which path is in use as
`contractProving: "wasm" | "server"`.

Setting `BALANCER_PROVER_URL` switches contract circuits to that server as well
as the wallet's own legs — one knob, because a deployment that has a proof
server should use it for everything.

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
  ],
  "settling": true,
  "retryAfterMs": 3000
}
```

`ready` is the weak upstream notion — merely synced. **`available` is the one
that matters**, and the client gates on `available > 0` alone. It is `1` only
when this wallet can pay a fee *this instant*: synced, holding DUST, able to
prove, and not already **claiming** its own coins. A synced wallet with no DUST
reports `ready: true, available: 0`, which is exactly right and exactly why the
client does not trust `ready`.

"Claiming its own coins" is narrower than "busy", and the distinction is
load-bearing. A spend has three phases — balancing, proving, submitting — and
only the first and last touch the wallet. The SDK commits its coin selection
atomically before it returns (`SubscriptionRef.modifyEffect` on each of the
shielded, unshielded, and DUST state refs), so by the time a recipe reaches the
prover its inputs are already booked as spent and a second balancing in the same
window picks different ones. Proving therefore claims nothing.

Treating a whole job as one long claim is what took fee sponsorship down on
2026/08/26: an mUSD activation leg proves for roughly two minutes, `available`
read `0` for all of it, and the client — which will not attempt a
`/balance-only` while `available` is `0` — stalled every Send and every
concurrent onboarding behind a grant that was not using the wallet at all.
`available` now reads the claim (`isReserved()`), and `/status` reports the
queue separately as `busy`. See `src/reservation.ts`.

`unavailableCause` is not read by `sponsor.ts` (it ignores unknown fields); it
is there so an operator reading a raw probe is not left guessing between
`WALLET_SYNCING`, `INSUFFICIENT_DUST`, `PENDING_TRANSACTION`, `PROVER_WARMING`,
and `PROVER_UNAVAILABLE`.

`settling` and `retryAfterMs` appear only when the unavailability is a **wait**
rather than a state: this service's own last spend has not had its change back
yet, or a transaction it balanced is still outstanding. They never raise
`available` — an empty wallet cannot pay a fee and saying otherwise would send a
caller straight into a refusal — they say the wait is short and bounded, so a
client mid-send can hold rather than go looking for another sponsor.

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
| 429 | `PENDING_TRANSACTION` | Another caller is claiming this wallet's coins right now — balancing, signing, or submitting, which is seconds. Carries `retryAfterMs`; the client retries inside a bounded window. A job that is merely *proving* is not a reason to refuse. |
| 429 | `PENDING_TRANSACTION` | …or this service has caught its own DUST bookkeeping wedged and is repairing it. `retryAfterMs` is 5,000, and the repair is a snapshot rewrite plus a restart. See [The DUST wedge](#the-dust-wedge). |
| 429 | `PENDING_TRANSACTION` | …or the wallet is unsynced or out of DUST **inside** the settle window: its own last spend's change is still in flight, or a transaction it balanced is still outstanding. `cause` carries which of the two it really was, and `retryAfterMs` is 3,000. |
| 503 | `WALLET_SYNCING` | Not synced, with nothing in flight to explain it. |
| 503 | `INSUFFICIENT_DUST` | No spendable DUST, with nothing in flight to explain it. |
| 503 | `PROVER_UNAVAILABLE` | Proving key material could not be loaded. |
| 502 | `BALANCE_FAILED` | Balancing or proving failed; `cause` carries the detail. |

The 429/503 split on those middle two rows is not cosmetic. `sponsor.ts` waits
out a `PENDING_TRANSACTION` and **falls through to the next sponsor** on a 503 —
and a client that changes sponsor between the two legs of a transfer proves its
second leg against a state its first leg has already moved. On 2026/09/02 that
cost a send: the balancer answered 503 instantly for a shortfall that was two
blocks old, the client went to the upstream gateway, and the `withdraw_night`
never landed. A shortfall the service can explain is now a wait.

Only DUST is balanced (`tokenKindsToBalance: ['dust']`). The caller balanced its
own shielded and unshielded legs before asking — adding to those here would
spend the balancer's NIGHT on somebody else's transfer.

#### Booked DUST, and how it is given back

`/balance-only` books a DUST coin as spent and then lets go: the caller submits,
and this service never learns whether it landed. When it does not — the node
refuses it, the browser closes, a preflight fails — the booking used to stand
for the whole `BALANCER_BALANCE_TTL_MS`. On 2026/09/02 at 14:12:57Z a rejected
transaction (`Custom error: 239`) took this wallet's only DUST coins with it and
onboarding was refused until 14:42:57Z.

So the booking is provisional. Every balanced transaction is watched; a sweeper
runs every six seconds, and once one is `BALANCER_BALANCE_ORPHAN_MS` old it asks
the indexer whether the chain has it:

- **on chain** — dropped, nothing else happens;
- **definitely absent** — `facade.revert(…)` hands the DUST back, logged as
  `[balance] released the DUST booked for <hash>: not on chain <n> s after
  balancing` and counted on `/status` as `balancesOrphaned`;
- **could not be asked** — left alone and asked again next sweep. An unanswered
  question is never evidence of absence: reverting a transaction that *had*
  landed would double-spend.

`/status` also carries `balancesWatched`, the number outstanding right now, and
the health watchdog reads it — a wallet whose DUST is booked against an
outstanding balance is `settling`, never `degraded`, however long ago the last
sponsorship was.

### `POST /balance-only/abandon`

A caller whose own submit failed can say so and not wait out the window:

```sh
curl -X POST http://127.0.0.1:8807/balance-only/abandon \
  -H 'content-type: application/json' \
  -d '{"txHash": "<the txHash /balance-only handed back>"}'
```

`{ "txHash": "…", "released": true }` when the booking was outstanding and its
DUST has been given back, `released: false` when nothing was being watched under
that hash — a second call, or one the sweeper has already ruled on. Rate-limited
on the same bucket as `/balance-only`.

### `POST /register-alias`

Registers a `.night` name **for** a user: the balancer pays the registry price
and both transaction fees, and the registry records the **user's** key as owner.
The user's wallet signs nothing, spends nothing, and needs to hold nothing.

```sh
curl -X POST http://127.0.0.1:8807/register-alias \
  -H 'content-type: application/json' \
  -d '{"alias":"alice","ownerKey":"<64 hex>","contractAddress":"<64 hex>"}'
```

| Field | Required | Meaning |
| --- | --- | --- |
| `alias` | yes | 1–32 lowercase letters, digits, interior hyphens. A trailing `.night` is accepted and stripped. |
| `ownerKey` | yes | The user's 32-byte Midnames owner key, `sha256(pad(32,'midnight.domains') ‖ secret)`, as 64 hex. |
| `contractAddress` | yes | The user's account-custody contract, 64 hex. The name resolves to it. |
| `ownerAddress` | no | An `mn_addr…` unshielded address for the leaf's `owner_address` half. Absent means 32 zero bytes — the balancer will not substitute its own, or a payment meant for the user would land here. |
| `network` | no | Must be `stagenet` when given. |

There are two paths, and which one runs depends only on whether the sponsor has
a pre-deployed leaf on the shelf. See [the resolver-leaf
pool](#the-resolver-leaf-pool).

**Off the shelf.** A leaf deployed earlier is taken and marked consumed, then
`update_domain_target(contractAddress)` on that leaf and
`register_domain_for(owner, domain, len, resolver)` on the TLD run
**concurrently**, on two DUST coins — neither reads the other's result.
`change_owner(ownerKey, ownerAddress)` follows in the background once the name
is confirmed, unwaited and logged: the name already resolves, and nobody is
watching a screen for the hand-over.

**Empty shelf.** Exactly the path this service has always taken, unchanged: a
**resolver leaf** is deployed with `DOMAIN_TARGET = [contractAddress,
ContractAddr]` and `DOMAIN_OWNER` set to the supplied key, then
`register_domain_for` is called on the TLD.

Either way success is returned **only** after the registry has been read back
and seen resolving the name to that contract — not merely after the transactions
land:

```json
{
  "alias": "alice", "domain": "alice.night", "network": "stagenet",
  "tldAddress": "<64 hex>", "resolverAddress": "<64 hex>",
  "resolverDeployTx": "<64-hex ledger hash>", "registerTx": "<64-hex ledger hash>",
  "resolverDeployBlock": 159260, "registerBlock": 159274,
  "target": { "kind": "contract", "address": "<64 hex>" },
  "ownerKey": "<64 hex>", "costAtomic": "10", "registeredAt": "<ISO 8601>",
  "fromPool": true
}
```

The two `…Tx` fields are **ledger hashes**, resolved through the indexer, not
the 33-byte identifiers midnight-js returns — a link built from an identifier
dies with "not found". An identifier that never resolves is returned unchanged
rather than replaced by a plausible-looking lie.

Policy, in the order it is enforced — nothing is spent until every gate passes:

1. well-formed, unreserved label, owner key, and contract address on this network
2. no other registration for the same alias **or** the same contract in flight
3. the name is free — a real read of the deployed registry, never a cache
4. the target contract really exists on chain
5. once-only per contract, from `state/aliases-stagenet.json`
6. the hourly ceiling
7. the balancer can pay the price plus a fee

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `invalid-alias` | Bad shape, or on the reserved list. |
| 400 | `invalid-owner-key` / `invalid-contract-address` / `invalid-owner-address` | Bad field. |
| 400 | `wrong-network` | The request names another network. |
| 400 | `target-missing` | No contract state at `contractAddress`. |
| 409 | `registration-in-flight` | One is already running for this name or this Passport. |
| 409 | `name-taken` | Already in the registry. |
| 409 | `already-sponsored` | This Passport already got one; carries `alias` and `registerTx`. |
| 429 | `rate-limited` | Hourly ceiling reached. |
| 503 | `alias-unsupported` | No registry configured, or the build could not be loaded. |
| 503 | `registry-unreachable` | The registry could not be read, so nothing may be asserted. |
| 503 | `wallet-syncing` / `funder-empty` / `funder-no-dust` | The balancer cannot pay right now. |
| 502 | `deploy-failed` / `register-rejected` / `confirmation-failed` | A transaction failed, or landed without the binding appearing. |

`funder-empty` and `funder-no-dust` keep the funder's own codes so a client
branches on one vocabulary across both services. `wallet-syncing` is new here:
the funder blocks its HTTP server until it is synced, and this one deliberately
does not.

### `POST /fund-account`

Opens an account: an activation grant of NIGHT **and** 100 mUSD, both deposited
**into** the user's account-custody contract rather than to their wallet
address, and neither requiring the user to sign anything.

```sh
curl -X POST http://127.0.0.1:8807/fund-account \
  -H 'content-type: application/json' \
  -d '{"contractAddress":"<64 hex>"}'
```

**The NIGHT leg.** The ACC's `deposit_night(color, amount)` is permissionless —
no `require_device()`, no witness, no caller check. It calls
`receiveUnshielded(color, amount)`, which makes the transaction owe the contract
that many coins, and then mirrors the credit into `night_balances` so the
balance is readable from decoded ledger state. Anyone may fund an account; the
balancer is just the first anyone. The value exists **inside** the contract from
the moment it exists, so the user never holds, watches, or moves it.

**The asset leg**, two transactions, proved on stagenet on 2026/08/24 by
`deploy-stagenet/src/shielded-receipt-drill.mjs`:

1. `mint_shielded(separator, amount, nonce, recipient)` on the mUSD faucet, with
   the **balancer's own** coin public key as the recipient. The faucet is
   permissionless, so the coin lands in the balancer's own shielded wallet.
2. `deposit_shielded(coin)` on the user's account, spending that coin. Like
   `deposit_night` it is permissionless, so `receive(coin)` writes the credit
   into the account's own `coins` map, where the indexer reads it back.

The colour is bound to the minting contract —
`rawTokenType(domain separator, faucet address)` — so "mUSD" is not a label this
service applies but a fact about where the coin came from. It is reported as
`assetColourHex` for exactly that reason, and a client should match on it rather
than on a name:

```
1a2917fbed8b5ce44d12ebc7d337689045f6c96a6bbd39cf3d8691ab310ef6a6
```

The balancer's witness set for the account contract is three refusals, one per
declared witness (`device_secret`, `grant_secret`, `recovery_secret`). Neither
`deposit_night` nor `deposit_shielded` asks for any of them, so both deposits
are unaffected; every circuit that could move value *out* — including
`withdraw_shielded` — is impossible from this process by construction rather
than by discipline.

Success is returned only once **each** credit has been read back off the chain:
`night_balances[native]` for the NIGHT, `coins[mUSD].value` for the asset.

```json
{
  "contractAddress": "<64 hex>",
  "nightTx": "<64-hex ledger hash>",
  "txHash": "<the same value, under its old name>",
  "block": 159286,
  "amountAtomic": "2000",
  "balanceAfterAtomic": "2000",
  "fundedAt": "<ISO 8601>",
  "assetSymbol": "mUSD",
  "assetTx": "<64-hex ledger hash of deposit_shielded>",
  "assetMintTx": "<64-hex ledger hash of mint_shielded>",
  "assetBlock": 159412,
  "assetColourHex": "1a2917fb…",
  "assetAmount": "100",
  "assetBalanceAfter": "100"
}
```

`txHash` and `nightTx` are the same value: the old single-leg name is kept so a
client written before the asset leg existed keeps working unchanged.

**The two legs succeed and fail separately, and the response says so.** If the
asset leg fails after the NIGHT credit has landed, the answer is still **200**,
with `assetTx: null` and an `assetError` string. The NIGHT is on chain and
reporting the whole activation as a failure would tell the caller to retry
something already paid for.

So a client reads the asset side off **two** fields, not one:

| `assetTx` | `assetBalanceAfter` | What it means |
| --- | --- | --- |
| a hash | `"100"` | This request deposited the mUSD. Done. |
| `null`, with `assetError` | `"0"` | The account is open; the mUSD is outstanding. Call `/fund-account` again for this contract — the once-only ledger records the legs apart, so the retry performs only the missing half. |
| `null`, no `assetError` | `"100"` or more | The account already held its mUSD before this request; nothing to do. |

`assetBalanceAfter` is the account's own `coins[mUSD].value` as last read from
the indexer, so it is the field to trust when the two disagree.

Policy, now asked **per leg**: shape → not already in flight → the contract
exists **and** decodes as an account-custody contract → for each leg, this
service has no record of having paid it (`state/accounts-stagenet.json`) **and**
the account does not already hold it → hourly ceiling → the balancer can pay.
An entry written before the asset leg existed carries NIGHT and no `asset`,
which reads correctly as "NIGHT done, mUSD outstanding" — no migration needed.

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `invalid-contract-address` / `wrong-network` | Bad request. |
| 400 | `not-an-account` | No state there, or state that is not an ACC. |
| 409 | `funding-in-flight` / `already-activated` / `already-funded` | Already served, or being served. `already-activated` carries `nightTx` and `assetTx`. |
| 429 | `rate-limited` | Hourly ceiling reached. |
| 503 | `funding-unsupported` | The compiled account build could not be loaded. |
| 503 | `indexer-unreachable` / `wallet-syncing` / `funder-empty` / `funder-no-dust` | Cannot establish or cannot pay. |
| 502 | `deposit-failed` / `confirmation-failed` | The **NIGHT** deposit failed, or its credit never appeared. Nothing was credited. |
| 200 | — with `assetError` | The NIGHT credit is real; the asset leg did not land. Retry to get only the asset leg. |

`assetError` is prefixed with the internal code that caused it —
`asset-unsupported`, `mint-failed`, `mint-not-visible`,
`asset-deposit-failed`, or `asset-confirmation-failed` — so an operator reading
a log can tell a missing faucet build from a coin that never became spendable.

The `not-an-account` gate is deliberately **structural** rather than "the
decoder did not throw": Compact decodes positionally, so a foreign contract can
occasionally produce a plausible-looking object. Every real account has at least
one device and exactly three recovery shares, and a candidate failing either
test is not one. This is what keeps the balancer from paying coins into a
stranger's contract, where the user could never reach them.

Setting `BALANCER_ASSET_GRANT=0` turns the asset leg off entirely; the endpoint
then behaves exactly as it did before, answering with `assetTx: null` and an
`assetError` saying why.

### `GET /status`

The human answer, in the funder's idiom: network, address, NIGHT and DUST
balances, `synced` and the raw `progress`, how it proves and whether that is
ready, what the DUST registration did, how many transactions it has balanced —
plus the sponsorship counters:

```
balancesWatched                            transactions this service balanced and
                                           handed away that the chain has not
                                           been seen carrying yet
balancesOrphaned                           bookings whose DUST the sweeper has
                                           taken back — see "Booked DUST" above
aliasesSponsored / aliasesSponsoredTotal   this process / the persisted ledger
aliasSponsorship                           available | unavailable
aliasTldAddress                            the registry names go to
aliasSlotsRemainingThisHour
accountsFunded / accountsFundedTotal       this process / the persisted ledger
accountFunding                             available | unavailable
accountGrantAtomic
accountSlotsRemainingThisHour
assetSymbol                                mUSD
assetColourHex                             rawTokenType(separator, faucet) — the
                                           colour to look for in the account's
                                           own `coins` map
assetGrant                                 100
assetFaucetAddress                         where the mUSD is minted from
assetsFunded / assetsFundedTotal           this process / ledger entries whose
                                           asset leg has landed. Counted apart
                                           from the NIGHT leg, because the two
                                           succeed and fail apart
assetFunding                               available | unavailable
assetUnavailableReason                     null, or why the asset leg is off
assetSpare                                 ready | minting | none | unsupported
                                           — whether a grant-sized mUSD coin is
                                           already minted and waiting, which is
                                           the difference between an asset leg
                                           of one deposit and one of a mint plus
                                           the three minutes this wallet takes
                                           to see its own coin
contractProving                            wasm | server — how CONTRACT circuits
                                           are proved, which is a different
                                           question from `proving` above
settling                                   not ready, but only because a spend's
                                           change is still in flight
health                                     the watchdog's own account of itself
                                           — see "Keeping itself alive" below
```

`health` is what makes the watchdog observable without an SSH session:

```json
"health": {
  "intervalMs": 600000,
  "checks": 42,
  "lastCheckAt": "2026-08-31T12:41:07.881Z",
  "verdict": "healthy",
  "reason": "synced, connected, 3 DUST UTxO(s), able to prove",
  "consecutiveUnhealthy": 0,
  "lastRemedy": null,
  "restartsRequestedSinceBoot": 0,
  "restartsRequestedTotal": 0,
  "lastRestartRequestAt": null,
  "lastRestartReason": null,
  "awaitingHealthyTick": false
}
```

`assetsFundedTotal` can lag `accountsFundedTotal`: an activation whose asset leg
failed is a real, recorded NIGHT credit with no asset entry, and the gap is
precisely the set of accounts a retried `/fund-account` would top up.

None of these is key material and none of them names a user.

`resolverPool` is the shelf of pre-deployed resolver leaves, or `null` when
there is no `.night` sponsor to deploy through:

```
depth         unconsumed leaves on the shelf
target        RESOLVER_POOL_TARGET
floor         RESOLVER_POOL_FLOOR
state         idle | filling | paused
reason        the one sentence behind that state
lastDeployAt  when this process last put a leaf on the shelf, or null
```

---

## The resolver-leaf pool

Registering a name is two dependent proofs, and the first is the expensive one:
deploying the resolver leaf costs **1.37e16 Specks** against 8.5e14 for the
registration itself, plus a block of waiting, all of it spent while somebody is
watching a screen.

None of that deploy depends on the user. `DOMAIN` is sealed at construction, but
`DOMAIN_TARGET` is settable afterwards by `update_domain_target` and
`DOMAIN_OWNER` by `change_owner`, both gated on the caller's derived key
matching the leaf's current owner — and `register_domain_for` on the TLD writes
only `{ owner, resolver }`, never looking inside the leaf. So a leaf can be
built ahead of time with no domain, a zero target, and the **sponsor's** own key
as owner, and bound to a person later.

The sponsor therefore keeps a shelf of them. `RESOLVER_POOL_TARGET` (default
**100**) is what it fills to; `RESOLVER_POOL_FLOOR` (default **50**) is the
depth below which `/status` calls the shelf low. The shelf lives in
`resolvers-<network>.json`, beside `accounts-<network>.json` and
`aliases-<network>.json`, on the same atomic write-and-rename:

```json
{
  "<leaf contract address>": {
    "address": "<64 hex>", "deployTx": "<64-hex ledger hash>",
    "deployBlock": 164800, "deployedAt": "<ISO 8601>",
    "consumedBy": "<account contract, once taken>", "consumedAt": "<ISO 8601>"
  }
}
```

`deployTx` is the indexer's ledger **hash**, and `deployBlock` the block it
landed in, both resolved by the filler at deploy time — at a moment nobody is
waiting. That is deliberate: `resolveTransactionHash` maps a midnight-js
transaction *identifier* to a hash, and the indexer answers an empty list for a
hash offered as an identifier, so a registration that put a pooled leaf's
`deployTx` back through the lookup would find nothing and spend the full retry
budget — about thirty seconds — at the end of the very request the shelf exists
to shorten. The pooled path therefore reads both fields and asks the indexer
only about the registration transaction.

A leaf is marked consumed **the instant it is taken** — before a single proof is
attempted — because the failure that guards against is two registrations racing
onto one leaf, and a leaf marked only on success would be free for the whole
minute the first binding spends proving. A leaf whose binding then fails stays
spent: it cost one deploy, the filler replaces it, and reusing a half-bound leaf
under somebody else's name is not a trade worth making.

### The filler is the lowest-priority thing this service does

Not a queue priority — a priority still competes. It is a set of preconditions
that make the filler simply not ask. It deploys **one** leaf at a time, **at
most one a minute**, and only when *all* of these hold:

| Precondition | Why |
| --- | --- |
| the health verdict is `healthy` | it pauses on `busy`, `settling`, `degraded`, `wedged`, and `dust-wedged` |
| the reservation shows nothing waiting, running, or booked | a leaf deploy must never join a queue somebody is waiting in |
| at least **two** fee-capable DUST coins (≥ 1.5e16 Specks) exist | it spends the second coin and never the last, so fee sponsorship stays up |
| no proof is in flight at the prover | one proof server, two vCPUs: the proof that would suffer is a person's |
| ≥ 60 s since the last user-facing request | `/status` and `/wallet-status` do not count, or watchdog polling would pause it for ever |
| ≥ 60 s since the last leaf deploy, **failed ones included** | a failed deploy still cost a proof; retrying it at once is how a broken artefact becomes a spend loop |

Any of these failing is a **pause**, not a fault. On the deployed sponsor today
— two DUST coins, one of them fee-capable — the filler sits at:

```json
"resolverPool": { "depth": 0, "target": 100, "floor": 50,
                  "state": "paused", "reason": "one fee-capable coin",
                  "lastDeployAt": null }
```

and that is the system working. The shelf fills when the sponsor's NIGHT is
spread across more coins; until then every registration takes the unchanged
deploy-then-register path and nothing about the service is worse than it was.

`RESOLVER_POOL_TARGET=0` switches the pool off entirely.

---

## Keeping itself alive

Two legs, because one of the four things that go wrong cannot be seen from
inside the process it happens to.

### What actually goes wrong, and why the remedy differs

| | What it looks like | What it is | What to do |
| --- | --- | --- | --- |
| **Settling** | `available: 0`, `utxoCount: 0`, sometimes `synced: false`, for 20–60 s (and up to ~2 min for the sync flap) | The wallet holds **one large NIGHT UTxO**, so every fee-bearing submission nullifies its DUST and the replacement only appears when that transaction lands | **Nothing.** Intervening here is the bug |
| **Busy** | `available: 0` with `balancing` or `busy` true, for up to ~2 min | A grant's shielded proof, or a contract call holding a claim on coin state | **Nothing.** This is the "locked while in use" the service is asked for |
| **Degraded** | `synced: false` with nothing in flight, an indexer subscription dropped (`RPC-CORE: disconnected … Normal Closure`), key material that never loaded, or `available: 0` long after anything could still be settling | A real fault the process can still see | Escalating in-process remedies, then a restart |
| **Wedged** | The process is up and answering nothing | Not visible from inside | The external timer |

### Leg A — the in-process health loop (`src/health.ts`)

A tick every ten minutes (`BALANCER_HEALTH_INTERVAL_MS`), jittered by ±5 % so it
never lands on the same second as the sixty-second snapshot save or the DUST
registration retry. One tick at a time, remedy included.

Each tick gathers the same facts `walletStatus()` gathers — readable, synced,
every sub-wallet's subscription connected, DUST balance, UTxO count,
`isReserved()`, `isBusy()`, proving readiness, time since the last successful
sponsorship, time since the sync indices last moved, and the current unhealthy
streak — and hands them to a **pure** verdict function, `assessHealth`. No clock,
no chain, no wallet: it is `test/health.test.ts`'s to drive, and that is where
every branch is proved.

The order of its branches is the policy, and it is the safe order — the two "do
nothing" verdicts are decided **before** any of the acting ones, so no
combination of facts can reach a remedy while a spend is in flight or while the
DUST is on its way back:

1. `busy` — `isReserved()`, then `isBusy()`. Unconditional.
2. `wedged` / `degraded` — the wallet could not be read at all. Ahead of the
   start-up grace, because a *syncing* wallet answers `currentState()` perfectly
   well and simply reports `isSynced: false`; one that answers nothing is a
   different thing, and being young is no excuse for it.
3. `settling` — still inside the 15-minute start-up grace and not yet synced or
   funded, **or** DUST-less within 5 minutes of a sponsorship. Deliberately not
   gated on `synced`, because the post-spend flap and the nullified DUST are one
   event.
4. `dust-wedged` — the wallet holds NIGHT, reports no spendable DUST, is
   synced, has nothing of its own pending, nothing it balanced outstanding, and
   is past the orphan window since its last sponsorship. Decided **before** the
   settling branches, because it is proved rather than inferred. See
   [The DUST wedge](#the-dust-wedge).
5. `degraded` — unsynced; a dropped subscription; `proving: failed`;
   `proving: warming` long past a cold start; no DUST *and no NIGHT*, so nothing
   to explain it; sync indices that have not moved in half an hour.
6. `healthy`.

Only `healthy` clears the unhealthy streak. `busy` and `settling` **hold** it: a
wallet that was degraded and is now merely mid-spend has not been shown to be
well, and zeroing the count there would let a fault that coincides with traffic
escalate never.

**The remedies, cheapest first, each rate-limited, each logged with a `[health]`
prefix:**

| Rung | Reached at | What it calls | Rate limit |
| --- | --- | --- | --- |
| `refresh` | every acting tick | `wallet.currentState()` then `wallet.progress()` — a fresh read off the facade's state observable, which carries its own 30 s timeout | one per tick |
| `rewarm` | 2 consecutive unhealthy ticks | `wallet.warmProvingKeys()` then `wallet.saveSnapshot()` | once per 5 min |
| `resyncDust` | the **first** tick of a `dust-wedged` verdict | `wallet.saveSnapshot()`, then `rollbackDustSnapshot` on the stored snapshot (falling back to a `dust-cold-start-<network>` marker), then `process.exit(1)` | once per 2 min |
| `restart` | 3 consecutive unhealthy ticks (immediately for `wedged`) | `wallet.saveSnapshot()` then `process.exit(1)`; `Restart=always` brings the unit back | once per 30 min, **persisted** |

`resyncDust` deliberately bypasses `restartAfterTicks`, the restart cooldown,
and `awaitingHealthyTick`. Those limits exist to stop a soft, possibly transient
signal from bouncing a live sponsor, and a wedge is neither soft nor transient —
its conjunction admits one explanation. It does **not** bypass the in-use gate:
the remedy exits the process, and doing that mid-spend would abandon a proof
somebody is waiting on. While a repair is pending, `/balance-only`,
`/register-alias`, and `/fund-account` answer `429 PENDING_TRANSACTION` with
`retryAfterMs: 5000`; `/balance-only/abandon` still passes, because it spends
nothing and telling this service a balancing is dead is exactly what should get
through.

`rewarm` is the rung that repairs something in place rather than merely looking:
`warmProvingKeys()` re-attempts the key-material fetch whenever readiness is
`warming` or `failed` (it short-circuits only on `ready` and `server`), so a
start-up in which the 31 MiB of circuit keys could not be fetched — which
otherwise pins `/balance-only` on `PROVER_UNAVAILABLE` for the life of the
process — heals here. The checkpoint that follows is insurance for the next
rung: a restart that resumes from a recent snapshot is a second, not a chain
walk.

**There is deliberately no "reopen the wallet in place" rung, and that is a
finding rather than an omission.** `WalletFacade` does expose `start()` and
`stop()`, and the seed never leaves the process, so `stop()` then `start()`
looks like exactly the in-place reconnection this wants. It is not one:
`stop()` closes the submission service's Effect scope
(`submissionService.close()` → `Scope.close`) and `start()` does **not** reopen
it — it starts only the shielded, unshielded, and dust wallets and the
pending-transactions service. A facade restarted that way would sync happily and
then fail to submit anything, which is a worse fault than the one being repaired
and a silent one. So the escalation goes straight from `rewarm` to a process
restart, which is the only reopen the SDK actually supports.

**Every restart gate, all of which must hold:**

- `isReserved()` and `isBusy()` are both false — checked in the verdict *and*
  again in the ladder, because this is the gate that must be impossible to reach
  past by adding a branch above.
- The cause is one a restart could plausibly fix. A prover whose key material
  will not download is not fixed by restarting into the same download; a wallet
  whose sync indices have merely gone quiet is too soft a signal to bounce a live
  sponsor on. Both are `degraded`, neither is restart-eligible.
- At most once in any 30 minutes, and **the clock is persisted** to
  `health-<network>.json` in the state directory. An in-memory limit would reset
  on the very event it exists to bound, which is how restart loops get written by
  accident.
- Never twice without an intervening healthy tick — likewise persisted, and
  reported on `/status` as `awaitingHealthyTick`.

### The DUST wedge

**What happens.** Every balancing runs `CoreWallet.spendCoins` →
`DustLocalState.spend()`, which does *not* remove the spent coin: it sets
`pending_until = ctime + dust_grace_period` (3 hours) on the entry, and
`utxos()` and `wallet_balance()` skip entries carrying that flag. So a DUST
balance of zero immediately after a spend is correct and expected.

**Why it can stick.** The SDK also pushes the spent coins onto an in-memory
`pendingDust` array, and `applyEventsWithChanges` filters that array against the
*pending-excluding* `utxos` getter. The first replayed dust event batch after a
spend — every block with dust activity, so within about six seconds — therefore
empties `pendingDust` while the ledger entries keep their flags.
`facade.revert(tx)` un-pends only spends still listed in `pendingDust`, so after
that window it is a no-op. The coins stay hidden for the full three hours.

**Why a restart does not fix it.** The snapshot serialises the ledger state,
`pending_until` included, but not `pendingDust`. A process that resumes from the
snapshot inherits the flags *and* the disabled revert.

Observed twice on 2026/09/02: 4,998 NIGHT held, `dust 0 / utxoCount 0 /
INSUFFICIENT_DUST` for an hour, with `dust.complete` true throughout. The health
ladder — refresh, rewarm, restart-from-snapshot — cleared none of it.

**The repair.** `src/dustRollback.ts` deserialises the stored DUST state and
calls `processTtls(now + 4 h)` — exactly the call `applyFailed` should have made
— which un-pends every entry whose grace period has expired and drops any that
decayed to zero. It refuses (`NothingToRepair`) when the count of spendable
UTxOs does not change, so it can never be mistaken for a repair that did
nothing.

```
node dist/dust-rollback.mjs --check           # say what is wrong, write nothing
node dist/dust-rollback.mjs                   # repair in place, with the service STOPPED
node dist/dust-rollback.mjs --path <snapshot> # against a named file
```

Exit codes are an interface: `0` repaired (or, under `--check`, a repair is
available), `3` nothing to repair, `1` the snapshot could not be read, parsed, or
written. Three is separate from one because the watchdog's fallback — moving the
snapshot aside for a ~90 s cold walk — is the right answer to a snapshot it could
not repair and the wrong answer to one that needed no repair. Every repair keeps
the bytes it was made from at `<snapshot>.pre-rollback-<timestamp>`.

**The narrower fallback.** When the rollback itself fails, the service writes
`dust-cold-start-<network>` in the state directory. The next start restores the
shielded and unshielded wallets from the snapshot — the wedge never touches
those — and walks only the DUST wallet from chain. The marker is consumed and
deleted on the start that honours it, so a cold DUST start can never become
permanent.

### Spend lanes

Spends used to run strictly one at a time, which made an activation five
sequential sponsored transactions: two minutes to a name and five more to
assets, with a second Passport's registration queued 280 s behind the first's.

`BALANCER_SPEND_LANES` (default **3**) is the ceiling on concurrent spend jobs.
The real limit is the number of free DUST coins, and the service takes the
smaller of the two, re-read before every start: every sponsored spend consumes a
whole DUST coin, and the SDK selects the smallest coin with a value above zero
until the fee is covered, so a job started with no free coin does not wait
politely — it fails to balance, or sweeps a coin a running job was about to
spend. Lanes therefore close as coins are taken and reopen as change lands, with
nothing having to notify the queue. `/status` publishes `lanes`,
`lanesConfigured`, `jobsRunning`, and a `jobs` array giving each running job's
label, its last reported step, and how long ago it reported it.

Set it to `1` to restore the strictly-serial behaviour.

### Nothing waits for ever

Lanes made two balancer submissions overlap for the first time, and that
uncovered a fault underneath. The wallet SDK holds **one** node connection for
the whole facade and disconnects it at the end of every submission; polkadot-js
drops `author_*` subscriptions on the reconnect without erroring them. So one
submission ending could kill another's watch in silence — and on 2026/09/02 it
did, twice: a spend job held a lane for 37 minutes and another for 23, with the
proof server idle and not one journal line, until an operator restarted the
service. Both transactions had landed on chain the whole time.

Four things close it, and the fourth is the one that matters most:

1. **Submissions are serialised and bounded** (`BALANCER_SUBMIT_TIMEOUT_MS`), so
   two node watches never coexist. Submissions also ask the node for
   `Submitted` rather than `Finalized` — 15–25 s of stagenet finality per
   transaction that no longer sits on a user's click, since every job confirms
   against the indexer anyway.
2. **Indexer watches are bounded** (`BALANCER_CONFIRM_TIMEOUT_MS`). midnight-js
   waits on `watchForTxData` and `watchForDeployTxData` with no deadline at all.
3. **A stalled job loses its lane** (`BALANCER_JOB_STALL_MS`), but only while
   nothing of ours is at the prover — a proof is minutes of legitimate silence.
4. **A timeout never means "failed".** Every one of these paths asks the indexer
   directly before it gives up on a transaction, because both hangs had already
   landed: treating a deadline as a failure would revert DUST the chain has
   genuinely spent and rebuild transactions that are genuinely on chain. Only an
   answer of *not there* becomes a rebuild.

Every step of a spend job is now one journal line — `queued`, `started`,
`balanced`, `proved`, `submitted`, `seen-on-chain`, `confirmed`, then
`done`/`failed`/`aborted` — prefixed `[job]` and naming the job's label and id.
The droplet watchdog reads the same facts off `/status` and restarts the unit if
a job stays silent with an idle prover for `BALANCER_WATCHDOG_JOB_STALL`
seconds (default 300), which is the backstop for a stall the process cannot end
itself.

An activation's two grants — NIGHT into `night_balances`, mUSD into `coins` —
now run together, since they contend for nothing. Priorities are unchanged: they
order what is *waiting*, and a registration still overtakes a queued grant.

### Rebuilding a transaction the node refused

A transaction balanced one block behind the chain is refused with
`RpcError: 1010: Invalid Transaction: Custom error: 231` (or `239`). Seen at
15:35:43 on 2026/09/02, five seconds after the registration in front of it
landed. `withNodeRejectionRetry` (in `src/account.ts`, used by both
`src/account.ts` and `src/midnames.ts`) waits for `isSynced` **and**
`dust.complete` — the rejection is about the DUST the balancing selected — then
**rebuilds** from a fresh `findDeployedContract`/`callTx`, because the bytes are
what the node refused and resending them would fail identically for ever. Three
attempts, a two-minute wait each. Anything that is not a node rejection is
rethrown untouched on the first attempt.

It wraps `deposit_night`, `deposit_shielded`, the resolver deploy, and
`register_domain_for`.

### Leg B — the external timer, for the wedged case

A process that is alive but no longer answering HTTP cannot notice itself: the
loop that would notice is on the same event loop that is not running.

`deploy/passport-balancer-watchdog.{sh,service,timer}` — install the script at
`/usr/local/lib/passport-balancer-watchdog.sh` and the two units in
`/etc/systemd/system/`. The timer fires every **2 minutes** (`OnBootSec=5min`,
`RandomizedDelaySec=20`) and the script restarts `passport-balancer` only when
all three hold:

1. `/wallet-status` has been unreachable or has answered `ready: false` on **3
   consecutive** checks — six minutes of continuous failure, comfortably longer
   than a ~2-minute shielded proof and the ~2-minute post-spend sync flap, so a
   busy sponsor is never mistaken for a dead one;
2. `/status` does not report `balancing` or `busy`. A spend in flight is a reason
   to **wait**, not to strike, so the strike count is left where it is. A
   `/status` that cannot be read at all does *not* block the restart — that is
   the wedged case this exists for;
3. the last watchdog restart was more than 30 minutes ago. That clock is a file
   in the state directory, so it survives the restart it bounds.

**And it repairs a DUST wedge on the FIRST strike.** A wedged wallet is a synced
one, so `/wallet-status` answers `ready: true` and rule 1 above exits happily
while nothing can be sponsored — which is exactly how the sponsor stayed down
for an hour twice on 2026/09/02 with this timer running throughout. The wedge is
matched on its own signature, taken from both endpoints at once and every term
required:

| Endpoint | Required |
| --- | --- |
| `/wallet-status` | `dust.balance` `"0"` and `dust.utxoCount` `0` |
| `/status` | `synced: true`, `balanceAtomic` non-zero, `pendingTransactions: 0`, `balancesWatched: 0`, `balancing: false`, `busy: false`, `settling: false` |

Each term rules out one innocent explanation — a syncing wallet, an empty one, a
spend of its own in flight, a balancing handed to somebody else, a claim on the
coins, or change still settling. It acts on the first strike because that
conjunction is *proved*, not inferred, and six minutes of a demo is the demo. It
stops the unit first (a running service rewrites the snapshot every minute and
would overwrite the repair), runs `dist/dust-rollback.mjs`, falls back to moving
the snapshot aside for a cold walk, and starts the unit again. Its own cooldown,
`BALANCER_WATCHDOG_DUST_COOLDOWN`, defaults to **300 s**.

It has a second leg, for a spend job that has gone silent while holding a lane.
That failure looks perfectly healthy from outside — through both hangs of
2026/09/02 `/wallet-status` answered `ready: true` — so it is matched on
`/status` alone: `jobsRunning` at least one, `proofInFlight: false`, and a
`jobs[].sinceProgressMs` past `BALANCER_WATCHDOG_JOB_STALL` (default **300 s**,
deliberately twice the in-process window, so the service gets first refusal on
its own stall). `proofInFlight` is not optional there: a proof is minutes of
silence and perfectly healthy, and restarting through one would fail a
registration somebody is watching.

`bash test/watchdog.test.sh` drives the whole script against a stub HTTP server,
with recorders standing in for `systemctl` and `node`, and checks each term of
the signature removed in turn. It needs no droplet and no root.

Everything it decides goes to `journalctl -u passport-balancer-watchdog`.

---

## Who may spend

The alias and account policies above bound what one **Passport** can be given.
Until 2026/09/01 nothing bounded what one **caller** could ask for: the three
spending endpoints ran their handlers for anybody who knew the URL, and
`/balance-only` paid a DUST fee on every call with no ceiling at all. The CORS
allow-list was never a gate — it decides which headers a *browser* is handed
back, long after the handler has run and the fee has been paid.

So each of the three now passes three guards before it reaches a policy gate.
`GET /wallet-status` and `GET /status` pass none of them: they are what every
client and both watchdogs poll, and neither spends a Speck.

1. **A per-client token bucket**, keyed on the caller's address.
   `/balance-only` gets 12/min with a burst of 6 — far more than a person can
   approve, and enough that a client which retries is never punished for it.
   `/register-alias` and `/fund-account` get 3/min: they are once-per-Passport
   calls, gated on top of that by a persisted once-only ledger.
2. **A cap on spend requests in flight** — 8 — so a flood is refused rather
   than stacked behind the wallet's one-at-a-time queue, each waiter holding a
   socket and whatever it read on the way in.
3. **An optional shared secret.** With `BALANCER_CLIENT_KEY` set, the three
   endpoints require it in an `X-Passport-Key` header. Unset — the default —
   admits everybody, which is the behaviour every deployed client is written
   against today.

The existing global `BALANCER_ALIAS_MAX_PER_HOUR` and
`BALANCER_ACCOUNT_MAX_PER_HOUR` ceilings are unchanged and still sit above all
of this: the per-client bucket bounds one caller, the hourly ceiling bounds the
wallet.

Every refusal is the service's ordinary `{ error, message }` shape, logged under
the endpoint's own `[balance]` / `[alias]` / `[account] refused:` prefix so the
watchdog and `journalctl` need to learn nothing new, and counted on `/status`:

```jsonc
"limits": {
  "refusedRateLimited": 27, "refusedQueueFull": 9, "refusedUnauthorised": 2,
  "spendQueueDepth": 0, "spendQueueMax": 8, "clientsTracked": 5,
  "clientKeyRequired": false
}
```

| Status | `error` | When |
| --- | --- | --- |
| 429 | `rate-limited` | This client's bucket is empty. Carries `Retry-After` and `retryAfterMs`. |
| 429 | `queue-full` | `BALANCER_SPEND_QUEUE_MAX` spends are already in flight. |
| 401 | `unauthorised` | `BALANCER_CLIENT_KEY` is set and the request did not carry it. |

### The forwarded-address rule

A per-client limit keyed on a header anybody can set is not a limit: an abuser
sends a fresh `X-Forwarded-For` per request and earns a fresh bucket every time.
So the header is read **only** when the socket's own peer is a trusted proxy —
loopback by default, which is where Caddy is — and never otherwise. A request
arriving at the port directly is keyed on the address it really came from,
whatever its headers claim.

Behind a trusted peer the chain is read **from the right**. Caddy *appends* the
address it observed to whatever the client sent, so `X-Forwarded-For:
10.0.0.1, 203.0.113.9` has exactly one entry the client could not have written —
the last one. Further trusted proxies are skipped, so a two-hop deployment
(add them to `BALANCER_TRUSTED_PROXIES`) still lands on the real caller.

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
| `BALANCER_BALANCE_ORPHAN_MS` | `120000` | How long a balanced transaction may go unseen on chain before the DUST it booked is handed back. See "Booked DUST" below. |
| `BALANCER_HEALTH_INTERVAL_MS` | `600000` | How often the in-process watchdog evaluates the wallet. Minimum `5000`; **`0` turns it off**, and the external timer is unaffected. |
| `BALANCER_MIDNAMES_TLD_ADDRESS` | our stagenet TLD | The `.night` registry names go to. Unset **and** no known default disables `/register-alias`. |
| `BALANCER_ALIAS_MAX_PER_HOUR` | `20` | Sponsored registrations per rolling hour. |
| `RESOLVER_POOL_TARGET` | `100` | Pre-deployed resolver leaves to hold. **`0` turns the pool off**, and every name deploys its own leaf. |
| `RESOLVER_POOL_FLOOR` | `50` | The depth below which `/status` calls the shelf low. Changes nothing about the filler, which is always at the lowest priority. Must not exceed the target. |
| `BALANCER_ACCOUNT_GRANT_ATOMIC` | `2000` | The activation grant, in atomic NIGHT (0.002 NIGHT). |
| `BALANCER_ACCOUNT_MAX_PER_HOUR` | `30` | Funded accounts per rolling hour. Counts activations, not legs. |
| `BALANCER_ASSET_GRANT` | `100` | The opening balance, in whole mUSD. **`0` turns the asset leg off.** |
| `BALANCER_ASSET_FAUCET_ADDRESS` | our stagenet faucet | The mUSD faucet the grant is minted from. Unset **and** no known default disables the asset leg. |
| `BALANCER_BALANCE_MAX_PER_MIN` | `12` | Per-client ceiling on `/balance-only`. **`0` turns the per-client limit off.** |
| `BALANCER_BALANCE_BURST` | `6` | How many `/balance-only` calls one client may make at once. |
| `BALANCER_ALIAS_MAX_PER_MIN` | `3` | Per-client ceiling on `/register-alias`. |
| `BALANCER_ALIAS_BURST` | `3` | Burst allowance on `/register-alias`. |
| `BALANCER_ACCOUNT_MAX_PER_MIN` | `3` | Per-client ceiling on `/fund-account`. |
| `BALANCER_ACCOUNT_BURST` | `3` | Burst allowance on `/fund-account`. |
| `BALANCER_SPEND_QUEUE_MAX` | `8` | Spend requests in flight at once, across every client. **`0` is unbounded.** |
| `BALANCER_SPEND_LANES` | `3` | Ceiling on concurrent spend jobs. The effective limit is `min(this, free DUST coins)`. `1` runs spends strictly one at a time. |
| `BALANCER_SUBMIT_TIMEOUT_MS` | `30000` | How long one node submission may take before the service stops waiting on it and asks the indexer whether it landed. |
| `BALANCER_CONFIRM_TIMEOUT_MS` | `120000` | How long a submitted transaction may go unseen by the indexer before the service queries it directly. Eight stagenet blocks of slack. |
| `BALANCER_JOB_STALL_MS` | `150000` | How long a running spend job may report no step, **with nothing at the prover**, before the queue aborts it and gives its lane back. |
| `BALANCER_SYNC_STALL_MS` | `600000` | How long the background chain walk may stall before it is reported and the health loop's rewarm is left to act. |
| `BALANCER_TRUSTED_PROXIES` | `127.0.0.1,::1` | The peers whose `X-Forwarded-For` is believed. Everything else is keyed on its socket address. |
| `BALANCER_CLIENT_KEY` | — | When set, the three spend endpoints require it in an `X-Passport-Key` header. Unset leaves them open. |
| `BALANCER_MIDNAMES_ASSETS` | `contracts-stagenet/managed/midnames` | Overrides where the compiled Midnames ZK artefacts are read from. |
| `BALANCER_ACCOUNT_ASSETS` | `contracts-stagenet/managed/account` | Overrides where the compiled account ZK artefacts are read from. |
| `BALANCER_ASSET_ASSETS` | `contracts-stagenet/managed/faucet` | Overrides where the compiled faucet ZK artefacts are read from. |

The stagenet mUSD faucet default is the instance `deploy-stagenet/` put on chain
at block 157,776 — the one the shielded-receipt drill minted 500 mUSD out of:

```
4fc92e152e8d854ef9337275504244e18bd6e3d7d41fd81ed2dabf62be78e92f
```

Its `mint_shielded` is permissionless, which is the whole reason the balancer
can mint to its own shielded address and then pay the coin into somebody else's
account. The colour that mint produces is
`rawTokenType(0x06…, 4fc92e15…)` = `1a2917fb…`, and it changes if either the
separator or the faucet does — so pointing `BALANCER_ASSET_FAUCET_ADDRESS`
somewhere else mints a **different currency**, not the same one from elsewhere.

The stagenet `.night` TLD default is **our own instance**, deployed by
`deploy-stagenet/` on 2026/08/24 at block 157797 with the preview registry's own
parameters — COST 600/140/10, `BUY_ENABLED`, the balancer's derived key as
`DOMAIN_OWNER`:

```
29be1e64846cff4600c5297fa54b27d4c9296b3ccc2cdba190eaba1d64c5f116
```

Because that instance's `DOMAIN_OWNER` address is the balancer's own, the COST a
sponsored registration pays comes straight back — the net NIGHT cost of a name
on this registry is zero, and only the DUST fees are really spent. Point
`BALANCER_MIDNAMES_TLD_ADDRESS` at the Midnames team's registry when there is
one on stagenet and the price becomes real; nothing else changes.

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

**What the two sponsorship endpoints add to that deployment** — and it is
deliberately as little as possible:

| | Needed on the droplet |
| --- | --- |
| `contracts-stagenet/managed/{midnames,account,faucet}/` | **Yes — rsync all three**, `faucet/` included. The ZK artefacts are read off disk; `dist/server.mjs` bundles the contract *modules* but not the prover keys, and `managed/*/keys/` and `managed/*/zkir/` are **gitignored**, so a `git pull` on the droplet will not bring them. Its own `node_modules/` is not needed. |
| Extra npm packages | **No.** Already in `package.json` (`compact-js`, `compact-runtime`, `midnight-js-*`); the asset leg adds no dependency. |
| A proof server / Docker | **No.** Contract circuits prove in-process, `deposit_shielded` included. |
| Extra environment | **No.** The faucet address, the mUSD grant, the `.night` TLD, the NIGHT grant, and both ceilings all have working defaults. |
| Disk in `BALANCER_STATE_DIR` | `aliases-stagenet.json` and `accounts-stagenet.json`, a few KB. They are the once-only gates and **must survive restarts** — the same volume the sync snapshot already lives on. |
| Memory | More headroom, and the asset leg is the reason. `deposit_shielded.prover` is **19.5 MB** against `deposit_night.prover`'s 288 KB, and the WASM prover holds it plus the BLS parameters for that circuit size in a worker for the length of the proof. |

So the deploy is: **rsync `src/`, `dist/`, `package.json`, and
`contracts-stagenet/managed/`** (all three builds, with their `keys/` and
`zkir/`), then `npm install` and `systemctl restart passport-balancer`. No
schema migration: the existing `accounts-stagenet.json` entries carry NIGHT and
no `asset`, which the per-leg gate reads as "NIGHT done, mUSD outstanding", so
already-activated Passports can be topped up by calling `/fund-account` again
and everything else is refused exactly as before.

Point `BALANCER_MIDNAMES_ASSETS` / `BALANCER_ACCOUNT_ASSETS` /
`BALANCER_ASSET_ASSETS` at the artefacts if they are staged somewhere other than
beside `dist/`. If they are missing, the service still starts and still balances
fees — `/register-alias` refuses with `alias-unsupported`, `/fund-account`
refuses with `funding-unsupported`, and a missing **faucet** build alone costs
only the asset leg: `GET /status` reports `assetFunding: "unavailable"` with the
reason, and activations still deposit their NIGHT.

### The TLS proxy, and the two root paths it must carry

`deploy/Caddyfile` is the proxy configuration this service is served through,
kept here rather than only on the droplet because one of its blocks is a bug fix
that is invisible from the balancer's own logs.

The wallet SDK's `HttpProverClient` builds its endpoint as
`new URL('/prove', baseUrl)`, which **discards the path on the base**. A client
configured with `https://…/prover` therefore posts its Zswap spend proof to
`https://…/prove`, at the root. Until 2026/09/02 that fell through to the
catch-all, which answered 200 with no `Access-Control-Allow-Origin`: the browser
blocked the preflight, every send needing a wallet-side shielded proof failed —
`deposit_shielded`, and so the second leg of every shielded transfer — and the
app reported it as a sponsor refusal while the note sat stranded in the sender's
wallet. So `/prove` and `/check` are proxied to the proof server as well, with
no path strip, because the proof server wants them exactly as they arrive and
sets its own CORS headers.

Install and reload it alongside a deploy:

```sh
rsync -a deploy/ root@<droplet>:/opt/passport-balancer/deploy/
ssh root@<droplet> '
  install -m 644 /opt/passport-balancer/deploy/Caddyfile /etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy'
```

Check it from the outside rather than from the box — the failure was a missing
header, not a missing route:

```sh
curl -s -X OPTIONS -H 'Origin: https://midnightpassport.com' \
  -H 'Access-Control-Request-Method: POST' -D - \
  https://67-205-177-162.sslip.io/prove | grep -i access-control-allow-origin
```

The service handles `SIGTERM` by saving its sync snapshot before exiting, so a
restart resumes in under a second instead of walking the chain again.

`Restart=always` with `RestartSec=5` on the unit is load-bearing, not
decoration: it is what the health loop's last-resort rung relies on, since the
only way this process can reopen its wallet is to be given a new one. Install
the external watchdog beside it — the second leg of "Keeping itself alive"
above:

```sh
rsync -a deploy/ root@<droplet>:/opt/passport-balancer/deploy/
ssh root@<droplet> '
  install -m 755 /opt/passport-balancer/deploy/passport-balancer-watchdog.sh \
    /usr/local/lib/passport-balancer-watchdog.sh
  install -m 644 /opt/passport-balancer/deploy/passport-balancer-watchdog.service \
    /opt/passport-balancer/deploy/passport-balancer-watchdog.timer \
    /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now passport-balancer-watchdog.timer'
```

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
- **The wallet SDK has no global network id.** The network is a field on the
  wallet configuration and an argument to `createKeystore`; `stagenet` is a
  well-known id in `NetworkId`. **midnight-js 5 is the opposite**, and this bit:
  it still keeps the id in module-level state and `getNetworkId` *throws* when it
  is unset — `Transaction.fromParts` and `parseCoinPublicKeyToHex` both call it,
  so every contract deploy and every circuit call goes through it. So
  `setNetworkId` from `@midnight-ntwrk/midnight-js-network-id` is called once, in
  `openBalancerWallet`, where the network is first known.
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

---

## The sponsorship endpoints, proven end to end on stagenet

Run against live stagenet on 2026/08/24, in-process proving, **no proof
server**. Every hash is on chain and every read-back was done independently of
the service, through the indexer.

**`POST /register-alias`** — a throwaway owner key with no wallet behind it, and
the migration drill's own account-custody contract as the target:

| | |
| --- | --- |
| Name | `pbdrill-2af91b.night` |
| Owner key on chain | `295d3ce1c9f935fc01bcfa221e6ba53b2124446dfb53f1209e6a6164dcdc33b3` |
| Resolver leaf | `ce6a3dde858a19274fd1010c6cf077ab4737d9a853f4fb282c7db759d8f7ff36` |
| Leaf deploy tx | `7ffac4a41a734f08b5a87889d15b534cc47607246500f02c5d454bf7ebeb61fa`, block 159,260 |
| `register_domain_for` tx | `47fbddc256a34edac8e768bce03693daabb3c7826627c95dd2ceeda8a61eeba5`, block 159,274 |
| Resolves to | contract `1b9957e62f98527feb498e860af8204a3440a36ac41aa0516a02e9edde2f7a77` |
| Cost | 10 atomic NIGHT, paid by the balancer |
| Wall clock | 113 s for both transactions and the confirmation between them |

The registry read back independently afterwards: two domains, costs 600/140/10,
`BUY_ENABLED`, and `pbdrill-2af91b.night` owned by that key. **The owner key
never held NIGHT** — it is 32 bytes posted over HTTP, with no wallet, no seed,
and no address derived from it anywhere. The balancer paid the price and both
fees.

**`POST /fund-account`** — into the account-custody contract from the mini-drill:

| | |
| --- | --- |
| Account | `008ede8b58a658a518c901befd7c71389c46cb0d6391c70105e82a467e4b0da4` |
| `deposit_night` tx | `416721d6129dc5d2b0ba0351b45011f00b4fb7b4c1c7c9e5031f1379a0502abf`, block 159,286 |
| Mirror before → after | `night_balances[native]` 0 → **2000** |
| Wall clock | 35 s |

(That run predates the asset leg. The two-leg endpoint is proved below.)

The balancer's NIGHT went 4,999.000000 → 4,998.998000: exactly the 2,000 atomic
grant. The registration cost nothing net, because our own TLD instance pays COST
back to the balancer's own address.

**Every refusal, exercised against the live service** — all of them before or
after the two spends, none of them costing anything:

| Request | Result |
| --- | --- |
| `alias: "midnight"` | 400 `invalid-alias` — reserved |
| `alias: "-nope-"` | 400 `invalid-alias` — bad shape |
| `alias: "passport-771a3f"` (already registered) | 409 `name-taken` |
| `contractAddress: deadbeef…` | 400 `target-missing` |
| `ownerKey: "nothex"` | 400 `invalid-owner-key` |
| `network: "preview"` | 400 `wrong-network` |
| same contract, second name | 409 `already-sponsored`, carrying the first `alias` and `registerTx` |
| the name just taken, different contract | 409 `name-taken` |
| `/fund-account` `contractAddress: "not-an-address"` | 400 `invalid-contract-address` |
| `/fund-account` against the **TLD registry** | 400 `not-an-account` |
| `/fund-account` against `deadbeef…` | 400 `not-an-account` — no state |
| `/fund-account` same account again | 409 `already-activated`, carrying `txHash` |

`GET /wallet-status` still reported `available: 1` throughout, so the demo's
existing sponsorship gate is untouched by the two new endpoints.

### The ACC fingerprint holds on the stagenet build

`/fund-account` refuses anything whose state does not decode with
`device_count >= 1` and `recovery_shares.size() === 3`. Checked against three
live stagenet account-custody contracts — the migration drill's, the
mini-drill's, and `deploy-stagenet`'s smoke-test ACC — all three report
`device_count 1, recovery_shares 3`, and the compiled `index.d.ts` confirms
`initialState` still takes `share_1`, `share_2`, `share_3`. The preview funder's
fingerprint carries over unchanged; no adjustment was needed.

### One trap worth writing down

Reading contract state needs the contract module and the indexer provider to
resolve the **same** `@midnight-ntwrk/compact-runtime`.
`contracts-stagenet/node_modules` carries its own (symlinked to
`deploy-stagenet`'s), so a scratch script that imports the build by relative path
under plain Node gets two `onchain-runtime-v4` instances and dies on
`expected instance of ChargedState` — reproduced here on the first attempt.
`src/midnames.ts` and `src/account.ts` therefore import the build through a
**literal** relative specifier, which esbuild inlines into `dist/server.mjs`, so
the bundled contract and the indexer provider both resolve this package's own
copy. A computed absolute path would not be inlined and would reintroduce the
fault. The faucet module the asset leg loads is imported the same way, for the
same reason.

---

## The asset leg, proven end to end on stagenet

Run against live stagenet on 2026/08/25, **in-process WASM proving, no proof
server** — the droplet's own configuration. The target was
`1b9957e62f98527feb498e860af8204a3440a36ac41aa0516a02e9edde2f7a77`, a real
account-custody contract that had never been funded: `night_balances[native] 0`,
`coins` map **empty**, read off the indexer beforehand.

One `POST /fund-account`, three transactions, no user-side signature anywhere:

| Leg | Transaction | Block | Wall clock |
| --- | --- | --- | --- |
| `deposit_night(native, 2000)` | `14de09060c36c17933a875bd646beadd32a8688bdc33aad1fddf604c3958df4d` | 165,065 | 45 s |
| `mint_shielded(0x06…, 100, nonce, balancer cpk)` | `86591ff4dc9bde87158e40a3a9a80624bfbf233ebf35f4e76b0d4424ed776230` | 165,078 | 64 s |
| `deposit_shielded(coin)` | `e622a8328ee0f7a37ad85eb044a56c87557b61a6ea83903615b5e9ca0093d2a4` | 165,112 | 204 s |
| Confirmation and hash resolution | — | — | 13 s |
| **End to end** | | | **326.6 s** |

Read back from the indexer afterwards, by a script that had no part in the
request:

```
night_balances[native] 2000
coins[mUSD]            100
coins map size         1
mUSD colour            1a2917fbed8b5ce44d12ebc7d337689045f6c96a6bbd39cf3d8691ab310ef6a6
```

`deposit_shielded` is where the time goes, and its prover key says why:
**19.5 MB**, against 288 KB for `deposit_night`. Proving it in-process is
comfortably possible — that is the number above — but it is the single most
expensive thing this service does, and it is worth knowing before an operator
reads a five-minute activation as a hang.

**Every refusal, exercised against the same live instance**, none of them
costing anything:

| Request | Result |
| --- | --- |
| the same contract again | 409 `already-activated`, carrying `nightTx` **and** `assetTx` |
| the `.night` TLD registry | 400 `not-an-account` |
| the mUSD faucet itself | 400 `not-an-account` |
| `deadbeef…` | 400 `not-an-account` — no state |
| `contractAddress: "not-an-address"` | 400 `invalid-contract-address` |
| `network: "preview"` | 400 `wrong-network` |

### The half-done retry

The branch that matters most, because it is the one a partial failure lands in.
The persisted entry was rewritten to the shape entries had **before** the asset
leg existed — NIGHT, no `asset`, byte for byte what the droplet's
`accounts-stagenet.json` holds today — and the service restarted. It reported
`accountsFundedTotal: 1, assetsFundedTotal: 0`, which is exactly the gap an
operator should read as "one account open, one asset leg outstanding".

`POST /fund-account` for that contract then performed **the asset leg and
nothing else** — the grant was raised to 200 mUSD for the run purely so the
"already holds a grant's worth" check would not short-circuit an account that
already held 100:

| | |
| --- | --- |
| `deposit_night` calls in the whole process | **0** (`accountsFunded: 0`, and no `NIGHT →` line in the log) |
| `nightTx` in the 200 body | `14de0906…` — the *recorded* hash, with `block: null` and the original `fundedAt`, because this request did not put it there |
| `mint_shielded` | `7600c5e021b49ec35851257ea15dfcc7cd83f939500e77a9f6f95c86c27102f6` |
| `deposit_shielded` | `629bbae39abfa48bea1130492ea08e50f948e8fa684aba1ca15e1320e3d152c7`, block 165,190 |
| `assetBalanceAfter` | 100 → **300** |
| Wall clock | 329.3 s |
| Ledger afterwards | the NIGHT fields untouched, the `asset` sub-entry added beside them |

Read back independently: `night_balances[native] 2000`, `coins[mUSD] 300`. The
balancer's own NIGHT moved 4998.998 → 4998.996 across both runs — exactly the
2,000 atomic of the one NIGHT leg, and nothing for either asset leg, because the
faucet mints the coin rather than the balancer paying for it.
