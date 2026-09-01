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

Copy `.env.example` to `.env.local` to point the build at a different indexer,
proof server, or sponsor. Every entry is optional — the defaults run against
**stagenet**. The file is local-only and ignored by Git.

The contracts' ZK artefacts are staged by `npm run prepare:zk`, which `dev` and
`build` both run: it copies `compiler/`, `keys/`, and `zkir/` into `public/zk`
from the stagenet contract build in
`examples/passport-balancer/contracts-stagenet`, and the compiled contract
modules into `contracts/stagenet/`. Nothing is compiled here — the artefacts
this app ships are byte-identical to the ones the harness deployed with, which
is what lets `findDeployedContract` accept them.

Stagenet publishes no proof server, so by default every circuit — the wallet's
own balancing legs and the contracts' — is proved in this tab by the zkir-v2
worker, which needs `node scripts/fetch-zk-params.mjs` run once. Set
`VITE_MIDNIGHT_PROVING_URL` to use a server instead; the matching image is
`midnightntwrk/proof-server:9.0.0-rc.6`.

`VITE_MIDNIGHT_PROVING_URL` and `VITE_SPONSOR_URL` each take a comma-separated,
ORDERED list of endpoints, tried left to right per request and fallen through on
a failure or a timeout. A single URL is a list of one and behaves exactly as it
did before. `VITE_FUNDER_URL` does not: `/register-alias` and `/fund-account`
exist nowhere but our own balancer. See `.env.example` for the syntax and for
what the 1AM stagenet gateway can and cannot serve today.

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

- **Stagenet is the only network this build can transact on**, and that is a
  fact about the binary rather than a policy. Since 2026/08/24 the app is built
  on `@midnightntwrk/ledger-v9` and midnight-js 5, because the ledger-8 stack
  cannot sync stagenet at all. Preview and Pre-production run the ledger-8
  protocol; a ledger-9 module cannot decode their transactions. They remain
  READABLE — an already-claimed name still resolves, its transactions still
  link — and `src/lib/networks.ts` says exactly that through
  `networkUnavailableReason()` rather than offering a switch that would not
  work.
- Mainnet is hard-blocked in code, and was before the move: a registration is a
  paid transaction, and a wallet whose seed comes from a browser passkey has no
  business spending real NIGHT.
- A cold wallet still walks the chain from genesis. Stagenet was ~158k blocks
  deep on 2026/08/24 and a fresh wallet synced in well under a minute, so the
  depth guard in `src/lib/localWallet.ts` — which refuses a from-genesis walk
  above 1M blocks rather than starting one that kills the tab — does not fire
  there. The measurements that motivated it are in `.env.example`.
- Sponsorship covers FEES, never the registration COST. `register_domain_for`
  runs `receiveUnshielded(COIN_COLOR, COST)`, so a `.night` claim needs the
  user's own NIGHT (600/140/10 atomic, by label length) from the stagenet
  faucet, which is captcha-gated by design.
- Nothing on screen is simulated. A balance, a transaction hash, or a resolved
  name is either read from the chain or absent — never substituted.
