# passport-funder

A small self-hosted activation service for Midnight Passport. It holds a
wallet of faucet NIGHT and drips an **activation-sized grant** — by default
1 000 atomic NIGHT (0.001 NIGHT, enough for roughly one hundred long-name
Midnames registrations) — to brand-new Passport wallets, so a user's first
`.night` claim executes in seconds instead of queueing until they visit a
captcha faucet.

The Midnames registration price is contract-mandatory but tiny: 10 atomic
NIGHT for names of five bytes or more, 140 for four, 600 for three or fewer.
The bottleneck was never the price — it was that a fresh passkey wallet holds
zero NIGHT and the public faucets are captcha-gated. This service closes that
gap, and nothing else.

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

### `GET /status`

`{"network": "preview", "address": "mn_addr…", "balanceAtomic": "…",
"dripsServed": 3, "ready": true}` — never the seed. `ready` means synced,
holding at least one drip's worth of NIGHT, and able to pay its own fee.

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
| `FUNDER_STATE_DIR`      | `./state`                                        | Sync snapshot + once-only drip ledger.      |
| `FUNDER_DRIP_ATOMIC`    | `1000`                                           | Atomic NIGHT per activation.                |
| `FUNDER_MAX_PER_HOUR`   | `60`                                             | Global drip ceiling per rolling hour.       |
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
- The seed only ever holds faucet NIGHT. Do not reuse it for anything, and do
  not send it anything you would mind losing.
- One drip per address ever (persisted ledger), a global hourly ceiling, a
  refusal for addresses that already hold a grant's worth, and CORS pinned to
  the Passport origin. None of this makes the service unabusable — it makes
  abuse slower than it is worth for tokens with no market value.
- `/status` reports the address and balance, never the seed.
