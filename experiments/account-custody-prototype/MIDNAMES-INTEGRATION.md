# Passport + Midnames Preview integration

This integration covers the complete localnet acceptance path for Passport
issue #100. It uses the Midnames `preview` implementation pinned to commit
`83f8422b0b39113d5c14aa8adc3d42804edaf492`.

## Run it

Prerequisites are Docker, Node.js 22 or newer, Bun, OpenSSL, and the Compact
toolchain.

```sh
npm run demo:midnames
```

That command resets the disposable local chain, compiles the Passport
contracts, prepares the pinned Midnames contract, runs unit tests, and executes
the live lifecycle.

## Acceptance flow

1. Start a fresh Midnight node, indexer, and proof server.
2. Synchronize two distinct localnet wallets.
3. Fund the external wallet and make DUST available.
4. Deploy the user's Passport account-custody contract (AAC).
5. Deploy the Midnames `.night` TLD.
6. Deploy the `alice.night` resolver with the AAC as its contract target.
7. Register the resolver in the `.night` namespace.
8. Resolve `alice.night` from the external wallet and verify the target.
9. Mint a local test shielded token to the external wallet.
10. Resolve the alias again, connect to the resolved AAC, and call
    `deposit_shielded`.
11. Read the AAC ledger and assert that it holds the deposited shielded value.

The depositor never receives or uses the raw AAC address as its destination
input. The adapter resolves the alias first and constructs the AAC connection
from the returned contract target.

## Code map

- `scripts/prepare-midnames-preview.mjs` fetches and builds the exact Preview
  revision. The checkout and generated contract files stay git-ignored.
- `src/integrations/midnames/preview.ts` deploys, claims, resolves, and routes
  shielded deposits through a resolved alias.
- `src/tests/lifecycle-midnames.ts` runs the two-wallet localnet lifecycle and
  verifies the resulting AAC ledger state.
- `test/midnames.test.ts` covers alias and address normalization plus the
  Midnames ownership-key derivation.

## Local evidence

Successful runs write `midnames-deployment.json` with the contract addresses,
transaction IDs, token color, amount, network, Preview revision, and timestamp.
The file is intentionally ignored because it describes one disposable local
chain and is not source code.

## Scope

This proves the localnet contract integration and the external shielded-deposit
use case. Preview/preprod deployment configuration, production namespace
policy, pricing, renewal, recovery, and anti-squatting rules remain Midnames
and Passport product decisions outside this local acceptance path.
