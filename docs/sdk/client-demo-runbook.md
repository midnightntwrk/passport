# Client Demo Runbook

## Start

```sh
cp examples/passport-demo/.env.example examples/passport-demo/.env.local
# Add VITE_DYNAMIC_ENVIRONMENT_ID
npm install
npm run demo
```

Open `http://localhost:5175`. Configure this exact origin in Dynamic before
testing Discord or email authentication.

## Recording checklist

1. Sign in with Discord. Record the Dynamic environment and account used.
2. Confirm the preflight row reaches authenticated, wallet provisioned, and
   DUST-sync-ready states.
3. Show the Passport deployment action before the Passport-key action. On
   Dynamic Midnight testnet, it creates a primary Passport PRF passkey when one
   is not present, unlocks encrypted C1 state, builds the Compact C1 deployment
   from the wallet's shielded public keys, then calls Dynamic
   `signTransaction` and `submitTransaction`. Record the returned transaction
   hash and verify it on-chain before calling the Passport active.
4. Show all three address surfaces and copy each without exposing private key
   material.
5. Enroll the Passport passkey only through its separate, explicit action and
   confirm the encrypted state record is created. Reload, unlock with the
   passkey, and confirm the state remains accessible.
6. Sign a Dynamic message. Record the user approval and result.
7. With a funded test wallet, register DUST and send one unshielded and one
   shielded transfer. For each, record the distinct build, Dynamic signing and
   proof, and submission entries, then open the transaction detail row and show
   the returned hash. Use the recovery icon only to release an abandoned pending
   transaction.
8. Confirm the C1 pilot remains clearly scoped: no asset custody, recovery,
   alias registry, Sig.Network handoff, or mainnet route. A Dynamic message
   signature is never represented as a C1 transaction.

## Result language

- **Passed:** an actual API call completed and a wallet result/transaction hash
  was observed.
- **Blocked:** the dependency is absent (for example, Dynamic private-key
  exports, a funded wallet, a custom-circuit bridge, or Sig deployment data).
- **Failed:** the API call ran and returned an error. Preserve the error text
  and environment; do not replace it with a generic success screen.

## C1 guardrails

- The testnet C1 draft builder is deterministic and covered by
  `npm run test:c1 --workspace passport-demo`.
- The browser only stores public deployment metadata after Dynamic returns a
  transaction hash. Device and maintenance state remain inside the encrypted
  Passport private-state envelope.
- Mainnet is rejected before a C1 transaction is created. Do not remove that
  check as part of a demo recording.
