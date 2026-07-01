# MN Passport Foundations Demo

Client-facing MN Passport demo for a fresh user onboarding into a contract-custodied
Midnight account.

This folder is intentionally self-contained. It includes the demo React app,
Compact contracts, wallet client wrapper, localnet scripts, and tests needed to
run the end-to-end flow without reaching back into `experiments/`.

The lower-level research/prototype work remains in:

```sh
experiments/account-custody-prototype/
```

## What It Proves

- Browser passkey onboarding for a Night ID.
- Passkey-derived device secret used to deploy the MN Passport custody account.
- Identity registry binding from `<handle>.night` to the custody contract.
- Direct localnet `deposit_night` into the custody account.
- Position creation after custody deposit.
- Logout/login restore of account, positions, and wallet state.
- Custody workspace views for holdings, account overview, connections, devices,
  and recovery.

## Layout

| Path | Purpose |
|---|---|
| `app/` | Vite + React demo UI. |
| `contracts/` | Compact contracts for account custody, faucet, and identity registry. |
| `src/wallet/` | Platform-neutral wallet/account-custody client API. |
| `src/node/` | Localnet wallet/provider/deployment helpers. |
| `src/tests/` | Localnet lifecycle tests. |
| `scripts/demo-local.mjs` | One-command localnet + deploy + Vite runner. |
| `infra/` | Midnight localnet Docker compose files. |

## Run The Demo

Prerequisites:

- Docker
- Node.js >= 22
- `compact` 0.30.0 on PATH
- Chrome for the headless E2E script

```sh
cd demo/mn-passport-foundations
npm install
cd app && npm install && cd ..
npm run demo
```

Open:

```sh
http://localhost:5173/
```

The demo script:

1. Creates `infra/.env` if missing.
2. Compiles Compact contracts if needed.
3. Starts Midnight localnet and proof server.
4. Deploys the faucet and identity registry.
5. Starts the Vite demo app.

## End-To-End Check

With the demo server running:

```sh
npm run demo:e2e
```

The E2E flow runs in automation mode, so it does not open a browser passkey
prompt. It still exercises the meaningful localnet path:

1. Deploys a custody account.
2. Registers a Night ID.
3. Runs the real `deposit_night` circuit.
4. Opens a position.
5. Confirms custody holdings and workspace screens render.

For a client/manual pass, use the normal browser flow and create the passkey
when prompted.

## Notes

- Runtime state such as `contracts/managed/`, `midnight-level-db/`,
  `infra/.env`, and deployment JSON files is ignored.
- Partner integration work belongs on a separate branch, not in this demo
  folder.
- This is a demo, not production custody. Recovery shares are still prototype
  placeholders and the localnet genesis wallet funds demo deposits.
