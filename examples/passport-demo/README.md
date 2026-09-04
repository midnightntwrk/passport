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

## MetaMask as a second device — experiment, flag-gated

**Off by default.** Built only with `VITE_METAMASK_DEVICE=1`, which production
does not set. Read the caveat below before reading anything else here.

Off means nothing runs and nothing renders — the Devices card is not built, the
sign-in control is `undefined`, and the EIP-1193 module is never fetched. It does
not mean the code is absent from the bundle: a flag-off build was grepped on
2026/09/04 and the strings are still in it, because the flag is a runtime
comparison rather than a literal the minifier can fold.

### What it does

A Passport's account is an `account.compact` instance, and it already admits a
second device: `add_device(new_device: Field)` takes a commitment, and where
that commitment came from is the client's business. So this is a second way to
*hold* a device, not a change to the contract — nothing under `contracts/` was
touched.

MetaMask signs one fixed three-line message with `personal_sign`:

```
Midnight Passport device key v1
network: stagenet
account: <the account contract's address>
```

RFC 6979 makes ECDSA deterministic, so the same MetaMask account signing the
same text returns the same 65 bytes on every machine, forever. Those bytes are
then the input-keying material of the **same HKDF ladder the passkey's PRF
output goes through** (`demo-backend/src/passkey.ts`), under a distinct salt and
a `metamask` label so the two devices can never collide. Out of that one
signature come both halves a device needs:

- under `PASSPORT_CONTRACT_SCOPE`, the root that `derivePassportContractSecrets`
  splits into the device secret whose `derive_device_commitment` the contract
  stores; and
- under a MetaMask-specific wallet scope, the seed `createLocalMidnightWallet`
  turns into a Midnight HD wallet — Zswap viewing and spending keys, a Dust key,
  an unshielded address.

The wallet half is not decoration. A send to a `.night` name is two legs, and
between them the value lands on the *signing device's own* address; a shielded
note there can only be read by that wallet's viewing key. A MetaMask device with
a device secret and no wallet could authorise a withdrawal it could then not
see. Like the passkey's wallet, it holds **only in-flight change between legs**
— the account is where the money lives.

The account contract is unchanged, and the account address is the same one the
passkey opens. MetaMask never originates the deploy: a Passport is still created
by a passkey, and the MetaMask device is added to the account that already
exists.

### The two flows

- **Pair.** Home → Devices → *Connect MetaMask*. MetaMask signs (that signature
  *is* the new device, and its holder has to agree to it), then the passkey
  authorises `add_device` (an account admits its own next device and nobody
  else). Two prompts, two real consents, neither able to stand in for the other.
  The paired row shows the shortened `0x…` address and a *Remove*, which calls
  `remove_device`.
- **Open.** The sign-in screen offers *Sign in with MetaMask* below the passkey
  controls. This browser looks the account up from the pairing it stored; a
  browser that has not seen this MetaMask before asks for the name and resolves
  it. Before anything claims to be signed in, the account is asked on chain
  whether it actually holds this device.

Nothing is promptless. Every spend re-signs — that is MetaMask's own
confirmation sheet, and therefore the approval — and no secret is retained
between actions.

### The caveat, said plainly

**Whoever can get MetaMask to sign that message holds the device.**
`personal_sign` binds no origin: an EIP-191 signature says nothing about who
asked for it. Any page that persuades the same MetaMask account to sign the same
string derives the same device secret and can spend from the account. A hardware
wallet behind MetaMask does not help — it signs the same text just as
deterministically.

The message is long, specific, and readable in the confirmation sheet so that a
person asked to sign it somewhere unexpected has a chance of noticing. That is a
warning label, not a defence, and it is why this is an experiment rather than a
feature. A shipping version would bind the derivation to something an attacker's
page cannot reproduce: a passkey assertion alongside it, or a SIWE-style message
carrying the verified origin and a server nonce.

Two smaller limits worth knowing:

- A MetaMask session is **not persisted**. The stored session record carries a
  seed but no record of which device derived it, so a silent restore would
  rebuild the MetaMask wallet and then reach for the passkey to authorise it.
  Signing in with MetaMask is therefore explicit every time — which it has to be
  anyway, since the signature is the device and is never kept.
- Signing in on a browser that holds neither the pairing nor the passkey
  Passport works from the name alone, but that session has no local name record
  or activity trail to show: it is the account address and the device, which is
  all any circuit needs.

### Where it lives

| File | What it is |
| --- | --- |
| `src/lib/metamaskDevice.ts` | The rules — message, derivation, pairing record. No browser, no storage; 100% covered by `src/lib/metamaskDevice.test.ts` against a fixed signature vector. |
| `src/lib/metamaskConnect.ts` | The EIP-1193 conversation and nothing else. |
| `src/identity/accountCustody.ts` | `addDevice` / `removeDevice`, beside the existing circuits. |
| `e2e/metamask.live.spec.ts` | The stagenet walk: create, pair, sign out, sign in with MetaMask, send to a name. `RUN_LIVE=1 METAMASK_LIVE_URL=…`. |
| `e2e/support/metamaskStub.ts` | An injected EIP-1193 provider backed by a fixed secp256k1 key, producing real EIP-191 signatures. |

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
