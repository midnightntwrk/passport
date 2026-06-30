# Account-custody prototype

A working Passport wallet against the **account-custody contract** (C1) on a
Midnight localnet: per-account Compact contract, hash-preimage device
authentication derived from a passkey (WebAuthn PRF), contract-custodied
Night and shielded assets (C4), scoped grants (C10/C11), and total-loss
recovery from on-chain 2-of-3 shares (C14, PVSS placeholder).

Decisions made (and deliberately deferred) by this iteration are recorded
in [DECISIONS.md](./DECISIONS.md).

## Layout

| Path | What |
|---|---|
| `contracts/account.compact` | The per-account custody contract (11 circuits). |
| `contracts/faucet.compact` | Test scaffolding: shielded-token origin for localnet. |
| `src/wallet/` | Platform-neutral client core: contract bindings, witnesses (C7), Shamir 2-of-3, `PassportAccount` API. |
| `src/node/` | Node-side wiring: funding wallet, providers, deploy helpers. |
| `src/tests/` | Localnet integration scenarios (see below). |
| `test/` | Simulator unit tests (no network needed). |
| `app/` | Vite + React demo: passkey onboarding, wallet, devices, grants, recovery. |
| `infra/` | Localnet docker compose (node 0.22.5, indexer 4.2.1, proof server 8.0.3). |

## Prerequisites

- Docker, Node.js >= 22, `compact` 0.30.0 on PATH, openssl.

## Everything at once

```sh
./run-all.sh            # localnet up + compile + unit tests + all scenarios
./run-all.sh --fresh    # reset chain state first
./run-all.sh --tests night,grants
```

## Step by step

```sh
npm install
npm run compile                  # both contracts → contracts/managed/

# unit tests — contract logic in-process, no network
npm test

# localnet
cp .env.example infra/.env       # then fill APP__INFRA__SECRET (openssl rand -hex 32)
cd infra && docker compose -f docker-compose.yml -f docker-compose.macos.yml up -d --wait && cd ..

# integration scenarios (each deploys its own account; minutes each — real proofs)
set -a; source infra/.env; set +a; export MIDNIGHT_NETWORK=local
npm run test:lifecycle           # Night: deposit/withdraw, rogue-device reject, multi-device
npm run test:grants              # grant issue/spend/cap/revoke
npm run test:shielded            # faucet mint → deposit → partial withdraw (change path)
npm run test:recovery            # share reconstruction → recover → old device locked out
```

## Demo app

```sh
npm run deploy                   # deploys the faucet, saves faucet-deployment.json
cd app && npm install && npm run dev
```

Open `http://localhost:5173` (the dev server proxies the indexer, node, and
proof server, and serves the zk artefacts — no CORS in the way).

- **Create your passport** — creates a passkey, derives the device secret
  from the WebAuthn PRF output, deploys your account contract, and splits a
  fresh recovery secret 2-of-3 into on-chain shares.
- **Assets** — deposit and withdraw Night; mint shielded tokens from the
  faucet, deposit the note, withdraw with change.
- **Devices** — register additional passkeys, remove devices (the contract
  refuses to remove the last one).
- **Grants** — issue a colour-scoped, value-capped grant; act as the dApp
  by pasting the grant secret; revoke and watch the spend path die.
- **Recovery** — simulate total loss: reconstruct the recovery secret from
  the on-chain shares, register a brand-new passkey, and observe the old
  device and all grants invalidated.

Passkey PRF needs a recent platform authenticator (Touch ID, Windows
Hello, Android) or a PRF-capable security key, on `localhost` or HTTPS.
A dev-mode toggle (passphrase-derived secret) covers everything else.

The app embeds the localnet genesis wallet purely to pay fees and fund
deposits — the fee model is C24's problem, not this prototype's.

Headless checks (drive the installed Chrome; passkeys excluded):
`node scripts/smoke.mjs` boots the app and reports console errors;
`node scripts/e2e-devmode.mjs` onboards in dev mode (deploys an account
from the browser) and proves one `deposit_night` through the full
browser stack.

## Caveats (prototype, not production)

- Recovery shares are plaintext public ledger state — TODO(PVSS), see
  DECISIONS.md (C14).
- transientHash commitments do not survive Compact version upgrades (C8).
- Device commitments are disclosed per call (linkability; C12-adjacent).
- Hash-preimage auth does not compose with MPC custody; the JubJub Schnorr
  upgrade path is the `require_device()` seam (C5).
