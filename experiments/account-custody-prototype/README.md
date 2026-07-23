# Account-custody prototype

A Passport wallet prototype against the **account-custody contract** (C1),
with an experimental Dynamic embedded-wallet adapter on Midnight Preview and
an explicit disposable localnet mode. It includes a per-account Compact
contract, hash-preimage device authentication, contract-custodied Night and
shielded assets (C4), scoped grants (C10/C11), and total-loss recovery from
on-chain 2-of-3 shares (C14, PVSS placeholder).

Decisions made (and deliberately deferred) by this iteration are recorded
in [DECISIONS.md](./DECISIONS.md).

## Layout

| Path | What |
|---|---|
| `contracts/account.compact` | The per-account custody contract (11 circuits). |
| `contracts/identity_registry.compact` | Shared demo registry binding a Night ID handle to the deployed Passport account contract. |
| `contracts/faucet.compact` | Test scaffolding: shielded-token origin for localnet. |
| `src/integrations/midnames/` | Adapter for the pinned Midnames Preview contract. |
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
npm run demo:midnames     # clean chain + issue #100 acceptance flow
```

## Step by step

```sh
npm install
npm run compile                  # account, identity registry, and faucet → contracts/managed/

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
npm run test:midnames            # requires running localnet; alias → external shielded deposit
```

## Midnames integration

The issue #100 path uses the real Midnames Preview contract rather than the
prototype `identity_registry.compact` contract. It deploys `.night`, claims
`alice.night` for a newly deployed Passport AAC, resolves the alias from a
second wallet, and calls the AAC `deposit_shielded` circuit with a shielded
token owned by that second wallet.

The complete clean-chain demo is:

```sh
npm run demo:midnames
```

The runner prints every landed transaction ID and writes a local,
git-ignored `midnames-deployment.json` evidence record. See
[MIDNAMES-INTEGRATION.md](./MIDNAMES-INTEGRATION.md) for the architecture,
version pin, and validation details.

## Demo app

```sh
cd app && npm install && npm run dev
```

Open `http://localhost:5173`, authenticate with Dynamic, and use the embedded
Midnight wallet on Preview. The app serves the Compact proving artifacts; the
Preview indexer and proof service are reached directly.

The disposable localnet remains available as an explicit test mode:

```sh
npm run demo                     # localnet + faucet + Vite
npm run deploy                   # deploys faucet + identity registry, saves local addresses
# then open http://localhost:5173/?demoMode=local
```

- **Create your passport** — initializes the prototype device state, deploys
  the account contract, and splits a fresh recovery secret 2-of-3 into on-chain
  shares. It then registers the selected Night ID on the Passport identity
  registry contract and stores the registry transaction in the local session.
- **Assets** — deposit and withdraw Night; mint shielded tokens from the
  faucet, deposit the note, withdraw with change.
- **Devices** — register additional passkeys, remove devices (the contract
  refuses to remove the last one).
- **Grants** — issue a colour-scoped, value-capped grant; act as the dApp
  by pasting the grant secret; revoke and watch the spend path die.
- **Recovery** — simulate total loss: reconstruct the recovery secret from
  the on-chain shares, register a brand-new passkey, and observe the old
  device and all grants invalidated.

The local mode embeds the localnet genesis wallet purely to pay fees and fund
deposits. The default Dynamic mode does not load or fall back to that wallet.

Headless checks (drive the installed Chrome; passkeys excluded):
`node scripts/smoke.mjs` boots the app and reports console errors;
`node scripts/e2e-devmode.mjs` onboards in dev mode (deploys an account
from the browser), registers the Night ID on the identity registry, and proves
one `deposit_night` through the configured demo prover. The reliable local-call
default is the Docker proof server; add `?prover=browser` to the URL to
exercise the experimental in-tab prover.

## Dynamic Midnight demo path

The default browser path uses the embedded `MidnightWallet` returned after
Dynamic social or email authentication. The package-level setup is:

```ts
import { MidnightWalletConnectors } from "@dynamic-labs/midnight";
```

The UI surfaces the three wallet address surfaces and keeps unshielded,
shielded, and DUST balances separate.

Compact transactions follow one explicit, capability-gated authority path:

1. The demo requires Dynamic's versioned Compact proof capability before C1
   witness handling or proving starts.
2. Passport builds the C1 call proof and sends the serialized
   `UnboundTransaction` to the typed Dynamic proof provider.
3. Dynamic returns a balanced `FinalizedTransaction` without returning wallet
   secret material.
4. A readable Dynamic `signMessage` approval is bound to the SHA-256 digests
   of both the unbound C1 transaction and the exact finalized result.
5. Only those approved finalized bytes are passed to the broadcaster.
6. The returned transaction hash and approval fingerprint are shown in the
   transaction receipt.

The approval signature is never treated as the transaction signature, and
there is no hidden fallback to the disposable local wallet. Dynamic rejection
fails the operation visibly. Use `?demoMode=local` only when intentionally
running the isolated localnet flow.

This adapter is intentionally experimental and currently **externally
blocked**. Midnight.js hands the wallet an already call-proved
`UnboundTransaction`, while Dynamic 4.93.1 documents embedded
`signTransaction` for the transfer builder's unsigned `UnprovenTransaction`.
The demo will not send a C1 transaction into that incompatible API. It requires
the explicit `getMidnightProofCapabilities` and `proveMidnightTransaction`
contract described in
[DYNAMIC-COMPACT-PROOF-UNBLOCK.md](./DYNAMIC-COMPACT-PROOF-UNBLOCK.md).
A passing contract test proves the adapter behavior, not availability in
Dynamic's hosted backend.

## Caveats (prototype, not production)

- Recovery shares are plaintext public ledger state — TODO(PVSS), see
  DECISIONS.md (C14).
- transientHash commitments do not survive Compact version upgrades (C8).
- Device commitments are disclosed per call (linkability; C12-adjacent).
- Dynamic wallet authorization and the C1 device witness remain distinct
  authorities: Dynamic finalizes and submits the transaction, while
  `require_device()` enforces Passport custody permissions.
- The prototype still persists its demo device secret in browser storage. The
  production SDK must replace that path with PRF-unlocked encrypted private
  state before this code can leave the prototype boundary.
