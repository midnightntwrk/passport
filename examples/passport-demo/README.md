# Midnight Passport demo

This is a testnet-only Passport client pilot. It combines the supported Dynamic
embedded Midnight-wallet flow with a narrow Passport C1 account-management
contract and Passport's encrypted private-state boundary.

```sh
npm install
npm run demo
```

Open `http://localhost:5175`. The configured Sandbox environment authorizes
this exact local origin; do not substitute `127.0.0.1` during live testing.

Set `VITE_DYNAMIC_ENVIRONMENT_ID` in `examples/passport-demo/.env.local` before
starting the demo. The file is local-only and ignored by Git.

Validate the C1 draft builder without a network submission:

```sh
npm run test:c1 --workspace passport-demo
```

Validate the installable production build, manifest, icon set, service-worker
registration source, and offline network boundary:

```sh
npm run test:pwa
```

The service worker is registered in production builds. To exercise it during a
development-only browser session, set `VITE_ENABLE_PWA_DEV=true`; otherwise use
`npm run build --workspace passport-demo` followed by
`npm run preview --workspace passport-demo`.

The cached offline surface is deliberately limited to the static Passport
shell. Dynamic authentication, wallet synchronization, proof generation, and
transaction submission are never cached, queued, or presented as available
offline.

The demo pins `@dynamic-labs/midnight` and `@dynamic-labs/sdk-react-core` to
the audited stable `4.93.1` release. See the PWA feasibility report for the
current upstream dependency-audit and Compact-proof blockers.

## Dynamic dashboard prerequisites

1. Enable Midnight under **Chains & Networks**.
2. Enable Midnight embedded wallets and create wallets on sign-up.
3. Under **Embedded Wallets > Security**, enable **Private Key Exports**.
   The current Midnight embedded-wallet connector needs it for balance reads,
   signing, DUST registration, and transfers.
4. Enable Discord and/or email authentication and add the local origin.

## Client implementation

- Dynamic authentication, wallet provisioning, all three Midnight address
  surfaces, balances, message signing, DUST registration, and transfer calls
  are invoked directly through `@dynamic-labs/midnight`. See the validation log
  for the result of each live check.
- Passport private state is encrypted in IndexedDB using an AES-GCM key derived
  from a WebAuthn PRF output. The decrypted state exists only during the
  explicit unlock operation.
- **Deploy Passport** builds a real Compact C1 deployment from the connected
  wallet's shielded public keys, asks Dynamic to sign and prove the unsigned
  transaction, then submits it through Dynamic. A Passport profile is recorded
  only when Dynamic returns a real transaction hash.
- The C1 pilot is intentionally narrow: initial device membership and
  permission records only. It has no asset custody, recovery shares, wallet
  seed, fixture wallet, alias claim, or Sig.Network route.

## Validation boundary

- The C1 draft is compiled and tested locally. The remote Dynamic sign/prove/
  submit step is only marked passed after a user-authorized testnet deployment
  returns a transaction hash and is independently confirmed on-chain.
- Mainnet deployment is hard-blocked in code. This pilot must remain on the
  Dynamic Midnight testnet until the artifact, fee model, recovery design, and
  operational review are approved.
- A Dynamic message signature is not presented as a Compact C1 transaction.
- The account-custody and Night-ID registry remain in
  `experiments/account-custody-prototype/`; they are not production APIs.
- Sig.Network requires its deployed vault, MPC endpoint, and Sepolia setup.
  The demo does not simulate that route.
