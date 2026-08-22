# Midnight Passport demo

The installable Passport client. Onboarding is a passkey ceremony in this tab:
the WebAuthn PRF output becomes a 32-byte Midnight seed, the wallet is built in
the browser, and claiming a `.night` name deploys the account-custody contract
that name resolves to. There is no third-party wallet vendor in the flow and no
account to create anywhere else.

Read [`WHAT-THIS-IS.md`](../../WHAT-THIS-IS.md) for what this demo is, and is
not, and [`docs/demo/runbook.md`](../../docs/demo/runbook.md) for how to run
it end to end with its companion services.

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
- Claiming a name is ONE user action, and two things on chain, in that order: a
  single user-verified assertion derives both secrets, the account-custody
  contract is deployed first because the name has to resolve to something, and
  the Midnames record is then written pointing at it. The contract is not a
  separate step the user has to know to press — there is no deploy button, only
  a retry on a deploy that failed. A Passport has one contract per network, so
  an existing deployed record is reused rather than deployed again.
- Network fees are sponsored (`VITE_SPONSOR_URL`, on by default for public
  networks). Nothing in the flow asks the user to hold DUST, register NIGHT for
  DUST, or fund an account before they can start. The client gates on the
  sponsor's own `available > 0`, never on an assumption.
- The `.night` registration is paid for by the funder
  (`examples/passport-funder`, `VITE_FUNDER_URL`) when one is configured and
  sponsoring: it registers the name under the user's own owner key, pointing at
  the user's contract, from its own NIGHT and its own DUST. **The user's wallet
  signs nothing and spends nothing, and a wallet holding zero NIGHT completes
  onboarding.** With no funder the claim falls back to the self-paid path,
  which re-runs its own funds gate and honestly queues the name when the wallet
  cannot pay. A queued name is never shown as registered.
- The `.night` name is the identity on the primary surface. The three wallet
  addresses are deliberately not on the everyday screens.
- The account-custody contract source stays in
  `experiments/account-custody-prototype/`; it is not a production API.

## Connected apps

Passport is a counterparty other origins may ask for a profile or a payment,
over the `postMessage` bridge or, on phones, a signed URL-callback redirect.
The examples in this repository are
[`examples/raffle-demo`](../raffle-demo/) (in the Apps grid by default),
[`examples/passport-app-template`](../passport-app-template/) (the starter to
copy — point Passport at it with `VITE_LOCAL_APP_URL`), and
[`examples/clubcoin-mock`](../clubcoin-mock/) (the URL-callback connector).

The next partner flow, **Otrix** — a totem showing a QR code with a shielded
deposit address, paid from Passport — is not built. Nothing in this client
implements it yet.

## Validation boundary

- Mainnet is hard-blocked in code. This pilot stays on Preview until the
  artifact, fee model, recovery design, and operational review are approved.
- Preprod is reachable and configured but not usable: a cold wallet cannot walk
  its ~1.98M blocks in a browser tab. A depth guard in `src/lib/localWallet.ts`
  refuses a from-genesis walk above 500k blocks with an honest error instead of
  starting one and killing the tab. The measurements are in `.env.example`.
- Nothing on screen is simulated. A balance, a transaction hash, or a resolved
  name is either read from the chain or absent — never substituted.
