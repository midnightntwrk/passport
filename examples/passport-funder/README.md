# passport-funder

A small self-hosted onboarding service for Midnight Passport. It holds a wallet
of faucet NIGHT and pays, on a new Passport's behalf, for the things that would
otherwise require the user to hold NIGHT before they hold anything:

- **`POST /fund-account`** deposits an **activation grant** — by default 2 000
  atomic NIGHT (0.002 NIGHT) — **inside** the user's account-custody contract,
  by calling that contract's own permissionless `deposit_night` circuit.
- **`POST /activate`** drips an activation-sized grant — by default 1 000 atomic
  NIGHT (0.001 NIGHT) — to a wallet **address**, for the paths that still need a
  wallet to hold NIGHT.
- **`POST /register-alias`** removes a payment entirely: the funder registers
  the `.night` name **for** the user, paying the registry price from its own
  NIGHT and the transaction fees from its own DUST. The user's wallet signs
  nothing, spends nothing, and needs to hold nothing.

The Midnames registration price is contract-mandatory but tiny: 10 atomic
NIGHT for names of five bytes or more, 140 for four, 600 for three or fewer.
The bottleneck was never the price — it was that a fresh passkey wallet holds
zero NIGHT and the public faucets are captcha-gated.

## The activation grant, and why it lands inside the contract

A Passport's value is supposed to live in its **account-custody contract** (the
ACC), not in the passkey wallet that happened to deploy it. `/activate` pays a
wallet address, which puts the user back in the position the whole design exists
to avoid — holding, watching, and spending from a wallet — and then needs a
second, user-paid transaction to move the grant where it was always meant to go.

`/fund-account` skips both steps. The ACC's entrypoint is

```
deposit_night(color, amount)
```

and it is **permissionless**: no `require_device()`, no witness, no caller check.
It calls `receiveUnshielded(color, amount)`, which makes the transaction owe the
contract that many coins, and then mirrors the credit into the contract's
`night_balances` map. Anyone may fund an account; the funder is simply the first
anyone. It calls the circuit itself, paying the coins from its own NIGHT and the
fee from its own DUST.

**So the grant is inside the contract from the moment it exists, and the user's
wallet never holds it.** Nothing has to be moved afterwards, and there is no
window in which a Passport's balance sits somewhere a dApp cannot reach and a
lost device could drain.

The funder cannot take it back out. Every ACC circuit that moves value —
`withdraw_night`, `grant_withdraw_night`, `recover` — demands a `device_secret`,
`grant_secret`, or `recovery_secret` witness, and this service's witness set is
three refusals that throw. `deposit_night` asks for none of them. That is a
property of the code, not a promise about it.

The grant is deliberately larger than the wallet drip: it is an opening balance
rather than a one-transaction allowance, so 2 000 atomic covers a `.night`
registration at any label length (600 atomic at worst) and leaves the user
something to move.

## Sponsored registration, and why it works

The deployed `.night` top-level domain's registration entrypoint is

```
register_domain_for(owner, domain, len, resolver)
```

and `owner` is an **argument, not the caller**. The compiled circuit derives the
caller's public key from its `secretKey` witness, compares it with the TLD's own
`DOMAIN_OWNER`, and — when they differ, which for the funder they always do —
asserts `BUY_ENABLED` and takes `COST` in unshielded NIGHT from the caller. It
then writes `domains[domain] = { owner, resolver }`.

So a third party can pay for a name the registry records as belonging to
somebody else. `/register-alias` makes the funder that third party: it deploys
the resolver leaf with `DOMAIN_TARGET` set to the user's account-custody
contract and `DOMAIN_OWNER` set to the owner key the caller supplied, then calls
`register_domain_for` with that same key.

**This service stands in for Midnames-side sponsorship until the Midnames team
runs their own.** It is exactly the service they would run: nothing in it is
privileged, nothing in it is a Passport-specific hack, and the registry cannot
tell a Passport-sponsored name from one the Midnames team sponsored. When they
ship it, Passport points at theirs and deletes this endpoint.

### The cost maths

| Label length | Price          |
| ------------ | -------------- |
| 5+ bytes     | 10 atomic NIGHT |
| 4 bytes      | 140 atomic NIGHT |
| 1–3 bytes    | 600 atomic NIGHT |

One faucet NIGHT is 1 000 000 atomic, so **one faucet NIGHT sponsors roughly
100 000 long names** — or about 7 100 four-byte names, or 1 660 three-byte ones.
The funder's real cost is not the price; it is the DUST for two transactions per
name, which accrues freely against NIGHT it already holds. Measured on preview
2026/08/20: a 17-byte name cost the funder exactly 10 atomic NIGHT
(4 999 984 000 → 4 999 983 990) and took 63 seconds end to end.

## API

### `POST /activate`

Body: `{"address": "mn_addr…"}` — the recipient's unshielded address, which
must be well formed **on the funder's own network**.

Success: `200 {"txHash": "…", "amount": 1000}` — the ledger transaction hash
and the atomic NIGHT sent. The funds typically arrive within a few blocks;
the Passport client watches its own balance stream for them.

Refusals are clear JSON, `{"error": code, "message": sentence}`:

| Status | `error`             | Meaning                                                        |
| ------ | ------------------- | -------------------------------------------------------------- |
| 400    | `invalid-address`   | Not a well-formed unshielded address.                          |
| 400    | `wrong-network`     | The address belongs to a different network.                    |
| 409    | `already-activated` | This address was already dripped to (once per address, ever).  |
| 409    | `already-funded`    | The address already holds at least one drip's worth of NIGHT.  |
| 429    | `rate-limited`      | The global `FUNDER_MAX_PER_HOUR` ceiling was reached.          |
| 503    | `funder-empty`      | The funder's own NIGHT is below one drip — top it up.          |
| 503    | `funder-no-dust`    | The funder's DUST is still accruing; try again in a minute.    |
| 500    | `drip-failed`       | The transfer itself failed; the address may retry.             |

### `POST /fund-account`

Body:

```json
{
  "contractAddress": "<64 hex — the user's account-custody contract>",
  "network": "preview"
}
```

`network` is optional; when present it must name this funder's own network.

Success is `200`:

```json
{
  "contractAddress": "f03f728517c039fd253bde299b9dd9de4042e27e7904e05848421081186a4970",
  "txHash": "<64 hex ledger hash>",
  "amountAtomic": "2000",
  "balanceAfterAtomic": "2000",
  "fundedAt": "2026-08-24T09:12:41.108Z"
}
```

`txHash` is a 64-hex **ledger hash**, resolved from the identifier midnight-js
returns so an explorer link actually works. `balanceAfterAtomic` is the
contract's own `night_balances` mirror for the native colour, read back from the
indexer. A `200` is only returned once that mirror really shows the credit — a
deposit that never lands is a failure, not a slow success.

Policy, in the order it is enforced. Nothing is spent until every gate passes:

1. **Shape** — `contractAddress` is a 64-hex Midnight contract address, and any
   `network` names this funder's network.
2. **In flight** — no other funding for the same contract is running. Claimed
   before any chain read, because those reads cannot see a deposit still in the
   air. One key, not two: an account funding is about exactly one thing.
3. **It really is an account** — one indexer read that must both find contract
   state and **decode it as an account-custody contract**. The fingerprint is
   structural rather than "the decoder did not throw": Compact decodes
   positionally, so a foreign contract can occasionally produce a
   plausible-looking object. Every real account has at least one device (the
   constructor inserts one and `remove_device` asserts it cannot remove the
   last) and exactly three recovery shares. A contract that fails either test is
   refused as `not-an-account` rather than fed coins — it has no `deposit_night`,
   and the grant would be spent into something the user cannot reach.
4. **Once per Passport, ever** — keyed on the contract address in a persisted
   ledger (`accounts-<network>.json`), which is what survives a restart.
5. **Not already funded** — from the `night_balances` mirror read at gate 3. An
   account already holding a grant's worth does not need an opening balance,
   whoever put it there.
6. **Hourly ceiling** — `FUNDER_ACCOUNT_MAX_PER_HOUR`, counted separately from
   drips and from alias registrations. A slot is consumed only when a deposit is
   actually attempted.
7. **The funder can pay** — the grant plus a fee, waiting out any change still
   in flight rather than refusing during a settle window.

The deposit then runs under the wallet's spend lock, so it cannot contend with a
drip or an alias registration for the same UTxO.

Refusals are clear JSON, `{"error": code, "message": sentence}`:

| Status | `error`                   | Meaning                                                                 |
| ------ | ------------------------- | ----------------------------------------------------------------------- |
| 400    | `invalid-contract-address`| Not a 64-hex Midnight contract address.                                 |
| 400    | `wrong-network`           | The request names a different network.                                  |
| 400    | `not-an-account`          | No state at that address, or state that does not decode as an ACC.      |
| 409    | `funding-in-flight`       | A funding for this Passport is already running.                         |
| 409    | `already-activated`       | This Passport was already funded (once per contract, ever).             |
| 409    | `already-funded`          | The account already holds at least one grant's worth of NIGHT.          |
| 429    | `rate-limited`            | The `FUNDER_ACCOUNT_MAX_PER_HOUR` ceiling was reached.                  |
| 502    | `deposit-failed`          | The deposit was refused or failed; nothing was credited. (`500` when the failure was not one the deposit path recognises.) |
| 502    | `confirmation-failed`     | The deposit landed but the mirrored balance never showed the credit.    |
| 503    | `funding-unsupported`     | The compiled account build could not be loaded.                         |
| 503    | `indexer-unreachable`     | The indexer could not be read, so nothing may be asserted.              |
| 503    | `funder-empty` / `funder-no-dust` | The funder cannot pay right now.                                |

### `POST /register-alias`

Body:

```json
{
  "alias": "alice",
  "ownerKey": "<64 hex — the user's Midnames owner key>",
  "contractAddress": "<64 hex — the user's account-custody contract>",
  "ownerAddress": "mn_addr…",
  "network": "preview"
}
```

`ownerAddress` and `network` are optional. `ownerKey` is
`sha256('midnight.domains' padded to 32 bytes || secret)` — the same derivation
the Passport client uses; the service never sees the secret behind it.
`ownerAddress`, when given, becomes the leaf's payment address; when omitted the
leaf carries 32 zero bytes, because the funder must not substitute its own
address for the user's. Neither is the registry's authority — `ownerKey` is.

Success is `200` and looks like this (real hashes from the preview drill on
2026/08/20):

```json
{
  "alias": "drillmt1imm012459",
  "domain": "drillmt1imm012459.night",
  "network": "preview",
  "tldAddress": "e2655a6d554d5d3ceb03dfbee517ad4186d6c287c5e638a29258320dde3e0ba7",
  "resolverAddress": "7af44a3e59c8e064b4d1f3265d72c38c441834de03857086d06f990303c3f8ab",
  "resolverDeployTx": "b863942527e47a3561d9830ae3d5d1cf0a821c96ff4abd00eb16ee0865c1461c",
  "registerTx": "95eb0f1d0588ced707dbe8123176aaf439b68728a09a3bd9fe6e401f9d22b4a2",
  "target": { "kind": "contract", "address": "f03f728517c039fd253bde299b9dd9de4042e27e7904e05848421081186a4970" },
  "ownerKey": "f3f451e68e295543f08bd54663d7184fe2dcbf66d45a06c375947a189ccd5f41",
  "costAtomic": "10",
  "registeredAt": "2026-08-20T12:48:34.935Z"
}
```

Both transaction fields are 64-hex **ledger hashes**, resolved from the
identifiers midnight-js returns so an explorer link actually works. A `200` is
only returned once the registry has been read back and seen resolving the name
to the requested contract — a name that landed pointing somewhere else is a
failure, not a slow success.

Policy, in the order it is enforced. Nothing is spent until every gate passes:

1. **Shape** — the label normalises (1–32 lowercase letters, digits, interior
   hyphens) and is not reserved; the owner key is 64 hex; the contract address
   is 64 hex; any `network` and `ownerAddress` name this funder's network.
   These rules are byte-identical to the browser client's.
2. **In flight** — no other registration for the same alias *or* the same
   contract is running. Claimed before any chain read, because those reads
   cannot see a registration still in the air. (This sits ahead of the ledger
   checks for the same reason `/activate`'s does.)
3. **Availability** — the label is free, read from the deployed registry. A
   registry that cannot be read is reported as unreachable, never as free.
4. **The target exists** — one indexer contract-state read. A name bound to
   nothing is worse than no name, and this is also the anti-spam gate: an
   account-custody contract costs a real transaction to deploy, so an abuser
   cannot mint free targets faster than the chain allows.
5. **Once per Passport, ever** — keyed on the contract address in a persisted
   ledger (`aliases-<network>.json`), which is what survives a restart.
6. **Hourly ceiling** — `FUNDER_ALIAS_MAX_PER_HOUR`, counted separately from
   drips. A slot is consumed only when a registration is actually attempted.
7. **The funder can pay** — the registry price plus a fee, waiting out any
   change still in flight rather than refusing during a settle window.

Refusals are clear JSON, `{"error": code, "message": sentence}`:

| Status | `error`                   | Meaning                                                                 |
| ------ | ------------------------- | ----------------------------------------------------------------------- |
| 400    | `invalid-alias`           | Malformed or reserved label.                                            |
| 400    | `invalid-owner-key`       | Not a 64-hex Midnames owner key.                                        |
| 400    | `invalid-contract-address`| Not a 64-hex Midnight contract address.                                 |
| 400    | `invalid-owner-address`   | `ownerAddress` was given but is not an `mn_addr…` address.              |
| 400    | `wrong-network`           | The request names a different network.                                  |
| 400    | `target-missing`          | No contract state is served at `contractAddress`.                       |
| 409    | `registration-in-flight`  | The same alias or the same Passport already has one running.            |
| 409    | `name-taken`              | The label is already in the registry.                                   |
| 409    | `already-sponsored`       | This Passport already had a name sponsored (once per contract, ever).   |
| 429    | `rate-limited`            | The `FUNDER_ALIAS_MAX_PER_HOUR` ceiling was reached.                    |
| 502    | `deploy-failed`           | The resolver leaf could not be deployed; nothing was registered.        |
| 502    | `register-rejected`       | The TLD refused the registration.                                       |
| 502    | `confirmation-failed`     | Both transactions landed but the registry never showed the binding.     |
| 503    | `alias-unsupported`       | This network has no `.night` registry, or the contract build is missing.|
| 503    | `registry-unreachable`    | The registry or the indexer could not be read.                          |
| 503    | `funder-empty` / `funder-no-dust` | The funder cannot pay right now.                                |

### `GET /status`

`{"network": "preview", "address": "mn_addr…", "balanceAtomic": "…",
"dripsServed": 3, "accountsFunded": 2, "accountsFundedTotal": 2,
"accountFunding": "available", "aliasesSponsored": 1, "aliasesSponsoredTotal": 1,
"aliasSponsorship": "available", "ready": true, "settling": false}` — never the
seed, and never any key material. `ready` means synced, holding at least one
drip's worth of NIGHT, and able to pay its own fee. `accountsFunded` and
`aliasesSponsored` count this process's work; the two `…Total` figures are the
persisted once-only ledgers, which survive restarts.

`settling` tells the two indistinguishable-on-chain reasons for `ready: false`
apart. A spend consumes its whole UTxO and the change returns in a new one, so
for a block or two after a drip the funder genuinely holds nothing spendable —
`settling: true` says the funds are in flight, not gone. `/status` answers
instantly either way; `/activate` waits out that window rather than refusing
the next person, and only reports `funder-empty` for a shortfall that outlives
it. Measured on preview 2026/08/07: change landed 20 s after a drip, and two
back-to-back activations both succeeded (21 s, 24 s).

## Running it

```sh
# 1. Create a seed. Prints the seed and the address it derives.
cd examples/passport-funder
npm run generate-seed

# 2. Fund that address ONCE from the network's captcha faucet
#    (https://faucet.preview.midnight.network for preview). The seed only
#    ever holds faucet NIGHT.

# 3. Start the service.
FUNDER_SEED=<the seed> npm start

# Or keep the seed in a mode-600 dotenv file instead of the shell:
FUNDER_ENV_FILE=~/.midnight-passport-funder.env npm start
```

On first run with a funded address the service registers its NIGHT for DUST
generation automatically (fees are paid in DUST, which only accrues against
registered NIGHT); `ready` in `/status` flips to `true` once a fee is payable
— usually within a minute.

Point the Passport demo at it with `VITE_FUNDER_URL` (see
`examples/passport-demo/.env.example`).

### Environment

| Variable                | Default                                          | Meaning                                     |
| ----------------------- | ------------------------------------------------ | ------------------------------------------- |
| `FUNDER_SEED`           | — (required)                                     | 64-hex wallet seed. Never logged.           |
| `FUNDER_ENV_FILE`       | —                                                | Path to a dotenv-style file merged into the environment (the real environment wins). Keep the seed in a mode-600 file this way. |
| `FUNDER_NETWORK`        | `preview`                                        | `preview`, `preprod`, or `undeployed`.      |
| `FUNDER_STATE_DIR`      | `./state`                                        | Sync snapshot + the three once-only ledgers (`drips-`, `accounts-`, `aliases-`). |
| `FUNDER_DRIP_ATOMIC`    | `1000`                                           | Atomic NIGHT per activation.                |
| `FUNDER_MAX_PER_HOUR`   | `60`                                             | Global drip ceiling per rolling hour.       |
| `FUNDER_ALIAS_MAX_PER_HOUR` | `20`                                         | Global ceiling on sponsored registrations per rolling hour. Modest by design: each one costs two proofs and two transactions, so the limit that matters is throughput, not spend. |
| `FUNDER_ACCOUNT_GRANT_ATOMIC` | `2000`                                     | Atomic NIGHT deposited into each account-custody contract. An opening balance, not a one-transaction allowance. |
| `FUNDER_ACCOUNT_MAX_PER_HOUR` | `30`                                       | Global ceiling on funded accounts per rolling hour, counted separately from drips and registrations. One proof and one transaction each, so throughput sits between the two. |
| `FUNDER_ACCOUNT_ASSETS` | auto-discovered                                  | Path to the compiled account build (`experiments/account-custody-prototype/contracts/managed/account`, produced by `npm run compile` there). |
| `FUNDER_MIDNAMES_TLD_ADDRESS` | the deployed `.night` TLD for the network  | Override to sponsor against a locally deployed registry. Unset on `undeployed`, where `/register-alias` is disabled. |
| `FUNDER_MIDNAMES_ASSETS`| auto-discovered                                  | Path to the pinned Midnames build (`experiments/account-custody-prototype/contracts/managed/midnames`). |
| `FUNDER_ALLOWED_ORIGINS`| `https://midnightpassport.com`                   | Comma list of browser origins for CORS.     |
| `FUNDER_PORT`           | `8799`                                           | HTTP port.                                  |
| `FUNDER_HOST`           | `0.0.0.0`                                        | Bind address.                               |
| `FUNDER_INDEXER_URL`    | per network                                      | Indexer GraphQL HTTP endpoint override.     |
| `FUNDER_NODE_URL`       | per network                                      | Node RPC endpoint override.                 |
| `FUNDER_PROVER_URL`     | per network                                      | Proof server override.                      |

`undeployed` defaults to the disposable localnet used across this repository
(indexer `localhost:8088`, node `localhost:19944`, prover `127.0.0.1:6300`);
fund the funder there with `node fund-localnet.mjs <address>` from the
repository root.

## Deployment

Any always-on Node host: a VPS, Fly.io, Railway, a spare machine. **Not
serverless** — the wallet keeps a live indexer subscription and must stay
synced between drips; a cold-started function would re-walk the chain on
every request. Persist `FUNDER_STATE_DIR` across restarts.

With Docker:

```sh
docker build -t passport-funder .
docker run -d -p 8799:8799 -v funder-state:/data \
  -e FUNDER_SEED=<the seed> \
  -e FUNDER_ALLOWED_ORIGINS=https://midnightpassport.com \
  passport-funder
```

## Security posture

- Drips are **activation-sized**: the default grant is 0.001 NIGHT of test
  tokens. The worst an abuser can extract per address is that.
- Account grants are **activation-sized too** — 0.002 NIGHT — and every one of
  them costs the abuser a deployed account-custody contract first, which is a
  real transaction the chain rate-limits for us.
- Sponsored registrations are **cheaper still** — 10 atomic NIGHT for a normal
  name — and every one of them likewise costs the abuser a deployed contract.
- The seed only ever holds faucet NIGHT. Do not reuse it for anything, and do
  not send it anything you would mind losing.
- One drip per address ever, one grant per account-custody contract ever, one
  sponsored name per account-custody contract ever, all in persisted ledgers;
  three separate hourly ceilings; a refusal for addresses and accounts that
  already hold a grant's worth; a refusal for names bound to a contract that
  does not exist; a refusal to deposit into anything that does not decode as an
  account-custody contract; and CORS pinned to the Passport origin. None of this
  makes the service unabusable — it makes abuse slower than it is worth for
  tokens with no market value.
- The funder can put value **into** an account and has no way to take it out.
  Its witness set for the account contract is three refusals, so every
  withdrawal circuit is unreachable from this process by construction.
- The funder pays its own fees from its own DUST. It does **not** use the
  ProofStation fee sponsor: a service that pays for other people has no business
  asking a third party to pay for it, and the extra dependency would only add a
  failure mode.
- `/status` reports the address, the balance, and two counters — never the seed
  and never any key material.
- Sponsorship is a **payment**, not an authority. The registry records the
  user's own owner key, so only the holder of the secret behind it can later
  call `set_resolver` or `transfer_domain`. The funder cannot take the name
  back, redirect it, or transfer it.
