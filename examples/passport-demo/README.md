# Midnight Passport demo

This Passport client combines the supported Dynamic embedded Midnight-wallet
flow with a narrow Passport C1 account-management contract and Passport's
encrypted private-state boundary. It has a real disposable-localnet mode for
the complete contract flow and a fail-closed Dynamic Preview capability probe.

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
- In `demoMode=local`, **Deploy Passport** submits the real C1 contract through
  the isolated fixture fee wallet, registers its Night ID, and enables
  unshielded NIGHT custody, shielded test-note custody, and scoped permission
  transactions. Each completed action exposes its returned localnet hash.
- On Dynamic Preview, **Deploy Passport** builds the real Compact draft but
  submits only if the connector exposes an explicit arbitrary-Compact proof
  capability. Dynamic 4.93.1 currently fails this capability check before
  proving; transfer-only `signTransaction` and detached message signatures are
  never used as fallbacks.
- The local C1 fixture wallet cannot be selected outside `?demoMode=local`.
  Sig.Network remains behind the typed five-stage readiness boundary until its
  runtime and deployment dependencies are compatible.

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
- Sig.Network requires its deployed vault, MPC endpoint, and Sepolia setup.
  The demo does not simulate that route.
