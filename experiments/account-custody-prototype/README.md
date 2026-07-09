# Account-custody prototype

A working Passport wallet against the **account-custody contract** (C1) on a
Midnight localnet: per-account Compact contract, hash-preimage device
authentication derived from a passkey (WebAuthn PRF), contract-custodied
Night and shielded assets (C4), scoped grants (C10/C11), and total-loss
recovery via **BUSS** (ANARKey, [EPRINT 2025/551](https://eprint.iacr.org/2025/551))
with stateless guardians and paper keys (C14) — the on-chain footprint is a
commitment plus a short public vector that provably leaks nothing.

Decisions made (and deliberately deferred) by this iteration are recorded
in [DECISIONS.md](./DECISIONS.md).

## Layout

| Path | What |
|---|---|
| `contracts/account.compact` | The per-account custody contract (12 circuits). |
| `contracts/faucet.compact` | Test scaffolding: shielded-token origin for localnet. |
| `buss-wasm/` | BUSS bridge: wasm-bindgen crate over [Pleiades](https://github.com/input-output-hk/arc-pleiades) (`arc-pleiades`, git dependency), built to `pkg-node/`. |
| `src/wallet/` | Platform-neutral client core: contract bindings, witnesses (C7), BUSS recovery (`buss.ts`), `PassportAccount` API. |
| `src/node/` | Node-side wiring: funding wallet, providers, deploy helpers. |
| `src/tests/` | Localnet integration scenarios (see below). |
| `src/demo/` | CLI recovery demo: onboard, guardian responder, backup ceremony, recover. |
| `test/` | Simulator unit tests (no network needed). |
| `app/` | Vite + React demo: passkey onboarding, wallet, devices, grants, BUSS recovery (guardian enrolment, guardian mode, paper keys). |
| `infra/` | Localnet docker compose (node 0.22.5, indexer 4.2.1, proof server 8.0.3). |

## Prerequisites

- Docker, Node.js >= 22, `compact` 0.30.0 on PATH, openssl.
- For `buss-wasm`: Rust >= 1.87 with the `wasm32-unknown-unknown` target,
  `wasm-pack`, and on macOS Homebrew LLVM (`brew install llvm` — Apple's
  clang cannot target wasm, which the `blst` dependency needs).

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
npm run build:buss               # arc-pleiades → buss-wasm/pkg-node/ (once)

# unit tests — contract logic + full BUSS ceremony in-process, no network
npm test

# localnet
cp .env.example infra/.env       # then fill APP__INFRA__SECRET (openssl rand -hex 32)
cd infra && docker compose -f docker-compose.yml -f docker-compose.macos.yml up -d --wait && cd ..

# integration scenarios (each deploys its own account; minutes each — real proofs)
set -a; source infra/.env; set +a; export MIDNIGHT_NETWORK=local
npm run test:lifecycle           # Night: deposit/withdraw, rogue-device reject, multi-device
npm run test:grants              # grant issue/spend/cap/revoke
npm run test:shielded            # faucet mint → deposit → partial withdraw (change path)
npm run test:recovery            # BUSS: guardian + paper quorum → recover → old device locked out
```

## Recovery demo (CLI, two terminals)

The scripted version of the two flows — asking another passport to be a
guardian (copy/paste values), and paper-key recovery. Localnet up and
`infra/.env` present; the scripts load it themselves.

```sh
# terminal A (key-owner)
npm run demo:onboard             # deploy an account, save owner-identity.json
npm run demo:backup              # 1 passport guardian + 2 paper keys, any 2 recover
```

`demo:backup` prints a `buss-req.v0.…` request string. In terminal B (the
guardian passport — its only state is its own key, created on first run):

```sh
npm run demo:guardian -- <buss-req.v0.…>    # prints the buss-sig.v0.… reply
```

Paste the reply back into terminal A, write down the two printed paper
slips, and the backup lands on-chain: a rotated commitment, a session
nonce, and two public φ points. Then simulate total loss:

```sh
# terminal A — needs only the address, the guardian count, and a quorum
npm run demo:recover             # or: -- --address <contract> --guardians 3
```

`demo:recover` rebuilds the guardian request from on-chain state (hand it
to terminal B again — the guardian recomputes the same σ from nothing),
accepts a typed-in paper slip as the second quorum member, reconstructs
the recovery secret, checks it against the on-chain commitment, and takes
the account over with a brand-new device. Guardian-set changes are a fresh
`demo:backup` run: fresh secret, fresh session nonce, one message per
guardian, no guardian-side state to migrate.

## Demo app

```sh
npm run deploy                   # deploys the faucet, saves faucet-deployment.json
cd app && npm install && npm run dev
```

Open `http://localhost:5173` (the dev server proxies the indexer, node, and
proof server, and serves the zk artefacts — no CORS in the way).

- **Create your passport** — creates a passkey, derives the device secret
  from the WebAuthn PRF output, and deploys your account contract with a
  recovery commitment (no shares anywhere — guardians come later).
- **Assets** — deposit and withdraw Night; mint shielded tokens from the
  faucet, deposit the note, withdraw with change.
- **Devices** — register additional passkeys, remove devices (the contract
  refuses to remove the last one).
- **Grants** — issue a colour-scoped, value-capped grant; act as the dApp
  by pasting the grant secret; revoke and watch the spend path die.
- **Recovery (BUSS)** — enrol guardians in a ceremony: passport guardians
  answer a copy/paste request (from a second browser profile via "Act as a
  guardian", or from the CLI `demo:guardian` — the wire formats are
  identical), paper keys are printed as slips to write down; publishing
  stores the rotated commitment plus a few public points. Then simulate
  total loss: paste a quorum of replies and slips, reconstruct, and re-key
  the account with a brand-new passkey — old devices, grants, and the spent
  backup all die with the epoch bump.

Passkey PRF needs a recent platform authenticator (Touch ID, Windows
Hello, Android) or a PRF-capable security key, on `localhost` or HTTPS.
A dev-mode toggle (passphrase-derived secret) covers everything else.

The app embeds the localnet genesis wallet purely to pay fees and fund
deposits — the fee model is C24's problem, not this prototype's.

Headless checks (drive the installed Chrome; passkeys excluded):
`node scripts/smoke.mjs` boots the app and reports console errors;
`node scripts/e2e-devmode.mjs` onboards in dev mode (deploys an account
from the browser) and proves one `deposit_night` through the full
browser stack; `node scripts/e2e-recovery.mjs` runs the BUSS recovery UX
end-to-end in dev mode (paper-only ceremony: publish the backup, then
reconstruct from the typed-in slips and re-key the account).

## Troubleshooting

- **Every transaction fails with `1010: Invalid Transaction: Custom error: 138`.**
  The chain state is stale: on an aged localnet the genesis wallet's Dust
  accounting drifts from the node's, and the node rejects everything with
  `Malformed(BalanceCheckOverspend)` (visible in `docker logs
  account-custody-prototype-node-1`). Not a code bug — reset the chain:
  `./run-all.sh --fresh` (then `npm run deploy` if the demo app needs the
  faucet again). `run-all.sh` detects this and tells you.
- **Indexer exits right after a fresh start** ("block number 1 not found"):
  a startup race against the node on an empty chain. `run-all.sh` now
  restarts it automatically; manually it is
  `docker start account-custody-prototype-indexer-1`.
- **The app says "not on this chain".** The browser remembers an account
  from a previous chain; the contract no longer exists after a reset.
  Forget the account and onboard again.

## Caveats (prototype, not production)

- BUSS session discipline (fresh secret + fresh session nonce per backup,
  full re-ceremony on guardian-set changes) is client-enforced — the
  contract cannot check it. See DECISIONS.md (C14).
- transientHash commitments do not survive Compact version upgrades (C8).
- Device commitments are disclosed per call (linkability; C12-adjacent).
- Hash-preimage auth does not compose with MPC custody; the JubJub Schnorr
  upgrade path is the `require_device()` seam (C5).
