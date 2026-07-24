# Client Demo Runbook

## Start

```sh
cp examples/passport-demo/.env.example examples/passport-demo/.env.local
# Add VITE_DYNAMIC_ENVIRONMENT_ID
npm install
npm run demo
```

For the complete isolated localnet contract flow:

```sh
cd experiments/account-custody-prototype
./run-all.sh
cd ../..
npm run demo
npm run demo:profile-client
```

Open `http://localhost:5175/?demoMode=local` for Passport and
`http://localhost:5176` for the separate Atlas application. Configure
`http://localhost:5175` in Dynamic before testing Discord or email
authentication. The local contract flow also requires the disposable Midnight
node, indexer, proof server, and fixture fee wallet from
`experiments/account-custody-prototype`.

## Recording checklist

1. Sign in with Discord. Record the Dynamic environment and account used.
2. Confirm the preflight row reaches authenticated, wallet provisioned, and
   DUST-sync-ready states.
3. Use **Deploy Passport** as the primary action. Its first user gesture creates
   or unlocks the Passport PRF passkey because the C1 contract requires a
   private witness authority. In `demoMode=local`, it then deploys the real C1
   custody contract with the isolated fixture fee wallet and registers the
   Night ID. Record both contract addresses and transaction hashes. On Dynamic
   preview, stop at the explicit capability error unless Dynamic has shipped
   and validated arbitrary Compact proof finalization.
4. Show all three address surfaces and copy each without exposing private key
   material.
5. Use the separate Passport-key action to unlock the existing encrypted state
   after reload. Confirm that C1 metadata and permissions restore only after
   the passkey succeeds.
6. Sign a Dynamic message. Record the user approval and result.
7. With a funded test wallet, register DUST and send one unshielded and one
   shielded transfer. For each, record the distinct build, Dynamic signing and
   proof, and submission entries, then open the transaction detail row and show
   the returned hash. Use the recovery icon only to release an abandoned pending
   transaction.
8. In local mode, read C1 custody, deposit and withdraw unshielded NIGHT, then
   mint a disposable shielded test note, deposit it into C1, and withdraw part
   of it. Open each returned chain hash from Activity.
9. Open Permissions, read the local C1 ledger, issue a scoped NIGHT grant,
   then revoke it. Each write must ask for the Passport passkey and return a
   real localnet transaction hash.
10. Open Connections, launch Atlas on port `5176`, request selected public
   profile fields, approve them in Passport, and verify that no passkey
   reference or private state crosses the origin boundary.
11. Show the Sig.Network five-stage boundary. Do not call it executable until
    Passport C1 is on the Ledger-v9/ZKIR-v3 runtime and real Sig deployment
    configuration is supplied.

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
- The local adapter is enabled only by `?demoMode=local` and uses a known
  fixture fee wallet only against the disposable local network.
- Dynamic message signatures are wallet verification only. They are never
  used as or described as C1 witness proofs.
