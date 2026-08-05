# Midnight Passport demo

This Passport client combines the supported Dynamic embedded Midnight-wallet
flow with a narrow Passport C1 account-management contract and Passport's
encrypted private-state boundary. It has a real disposable-localnet mode for
the complete contract flow, and a Dynamic Preview deploy path that settles
through the embedded wallet's `getWalletProvider()` boundary (Dynamic 4.96.0),
falling back to a fail-closed capability probe on older SDKs.
Read [`WHAT-THIS-IS.md`](../../WHAT-THIS-IS.md) for what this demo is, and is
not.

```sh
npm install
npm run demo
```

Open `http://localhost:5175/?demoMode=local` for the complete local contract
flow, or `http://localhost:5175` for Dynamic Preview validation. The configured
Sandbox environment authorizes this exact local origin; do not substitute
`127.0.0.1` during live testing.

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
`4.96.0`, the first 4.x release that documents embedded-wallet contract
settlement (`getWalletProvider`). See the blockers document for what remains
unverified live on this path.

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
- In `demoMode=local`, **Deploy Passport** submits the real C1 contract through
  the isolated fixture fee wallet, registers its Night ID, and enables
  unshielded NIGHT custody, shielded test-note custody, and scoped permission
  transactions. Each completed action exposes its returned localnet hash.
- On Dynamic Preview, **Deploy Passport** settles the real C1 deployment
  through `wallet.getWalletProvider()` (Dynamic 4.96.0): the embedded wallet
  balances, pays the DUST fee, MPC-signs, and submits, with a `signMessage`
  approval receipt bound to the exact transaction digests. `submitTx` returns
  a submission identifier — not the explorer hash — so the demo confirms
  inclusion by polling the indexer's `transactions(offset: { identifier })`
  lookup before claiming the contract is live. On SDKs without
  `getWalletProvider` the old capability probe still fails closed;
  transfer-only `signTransaction` and detached message signatures are never
  used as fallbacks.
- The local C1 fixture wallet cannot be selected outside `?demoMode=local`.

## Validation boundary

- The C1 draft is compiled and tested locally. The remote Dynamic
  prove/approve/submit step is only marked passed after a user-authorized
  testnet deployment returns a transaction hash and is independently confirmed
  on-chain.
- Mainnet deployment is hard-blocked in code. This pilot must remain on the
  Dynamic Midnight testnet until the artifact, fee model, recovery design, and
  operational review are approved.
- A Dynamic message signature is not presented as a Compact C1 transaction.
- The account-custody and Night-ID registry remain in
  `experiments/account-custody-prototype/`; they are not production APIs.
