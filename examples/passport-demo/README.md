# Midnight Passport demo

The installable Passport client. Onboarding is a passkey ceremony in this tab:
the WebAuthn PRF output becomes a 32-byte Midnight seed, the wallet is built in
the browser, and claiming a `.night` name deploys the account-custody contract
that name resolves to. There is no third-party wallet vendor in the flow and no
account to create anywhere else.

Read [`WHAT-THIS-IS.md`](../../WHAT-THIS-IS.md) for what this demo is, and is
not.

```sh
npm install
npm run demo
```

Open `http://localhost:5175`. The port is pinned in the source, not in
configuration: Passport frames apps by URL, and a handshake against a moving
origin fails silently. Do not substitute `127.0.0.1`.

Copy `.env.example` to `.env.local` to point the build at a different network,
indexer, proof server, or sponsor. Every entry is optional — the defaults run
against Preview. The file is local-only and ignored by Git.

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
shell. Wallet synchronization, proof generation, and transaction submission are
never cached, queued, or presented as available offline.

## Client implementation

- Passport private state is encrypted in IndexedDB using an AES-GCM key derived
  from a WebAuthn PRF output. The decrypted state exists only during the
  explicit unlock operation.
- The wallet is derived from the same passkey, in this tab. Its addresses,
  balances, and transfers all come from `src/lib/localWallet.ts` against the
  configured network's indexer, node, and proof server.
- Claiming a name is ONE user action: a single user-verified assertion derives
  the seed, the account-custody contract is deployed, and the Midnames record
  is written to point at it. The contract is not a separate step the user has
  to know to press.
- Network fees are sponsored. Nothing in the flow asks the user to hold DUST
  or to fund an account before they can start.
- The account-custody contract source stays in
  `experiments/account-custody-prototype/`; it is not a production API.

## Validation boundary

- Mainnet is hard-blocked in code. This pilot stays on Preview until the
  artifact, fee model, recovery design, and operational review are approved.
- Nothing on screen is simulated. A balance, a transaction hash, or a resolved
  name is either read from the chain or absent — never substituted.
