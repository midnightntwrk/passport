# Demo runbook

How to run the Passport demo, what to walk through, and how to write down what
you saw.

Read [`WHAT-THIS-IS.md`](../../WHAT-THIS-IS.md) first. Then note what this
runbook no longer contains, because earlier versions of it did:

- **No wallet vendor.** The Dynamic SDK was removed on 2026/08/20. There is no
  environment id to configure, no Discord or email sign-in, and no hosted
  wallet to wait on. The only way in is a passkey.
- **No user-paid DUST registration.** Network fees are sponsored. Nothing asks
  the user to register NIGHT for DUST before they can transact.
- **No user-paid name claim.** When a funder is configured and sponsoring, the
  `.night` name is registered *for* the user and their wallet spends nothing.
- **No `?demoMode=local`.** The query parameter is gone from the client. The
  demo runs against a public network — Preview by default.

## Start Passport

```sh
npm install
npm run demo
```

Open `http://localhost:5175`. The port is pinned in the source with
`strictPort`, and the dev build redirects any other origin to it: Passport
frames apps by URL, and a handshake against a moving origin fails silently. Do
not substitute `127.0.0.1`.

Every setting is optional — the defaults run against Preview, with fees
sponsored through the preview gateway. Copy
`examples/passport-demo/.env.example` to `.env.local` to change any of them;
that file documents each variable and why it exists.

## The companion services, and which of them you actually need

| What | Port | Needed for |
|---|---|---|
| `examples/passport-funder` | 8799 | Sponsored `.night` registration. Needed for a clean onboarding walk-through — see below. |
| `examples/raffle-demo` (`npm run demo:raffle`) | 5177 | The example dApp in the Apps grid: profile handshake and a Passport-signed payment. |
| `examples/passport-profile-client` (`npm run demo:profile-client`) | 5176 | The separate-origin profile consent client ("Atlas"). Superseded in the Apps grid by the raffle since 2026/08/05; still runnable. |
| `examples/passport-app-template` | 5178 | The starter a third-party developer copies. Point Passport at it with `VITE_LOCAL_APP_URL`. |
| `examples/clubcoin-mock` | 5181 | The URL-callback (redirect) connector example — the phone-shaped alternative to the popup handshake. |
| `examples/passport-app-hub` (`npm run demo:hub`) | 5179 | The public app-listing site. Not part of the wallet flow. |
| `examples/passport-docs` (`npm run demo:docs`) | 5180 | The documentation site. Not part of the wallet flow. |

Passport alone is enough to demonstrate onboarding, the wallet, and sending.
Everything else is a counterparty for one specific handshake.

## Bring the funder up before you demonstrate onboarding

A fresh passkey wallet holds zero NIGHT, and the public faucets are
captcha-gated. Without a funder the name claim falls back to the self-paid
path, finds no NIGHT, and honestly queues the name instead of registering it —
correct behaviour, but not the flow you want to show.

```sh
cd examples/passport-funder
npm run generate-seed              # prints a seed and its address
# fund that address ONCE from https://faucet.preview.midnight.network
FUNDER_SEED=<the seed> npm start   # port 8799
```

Then set `VITE_FUNDER_URL=http://localhost:8799` in
`examples/passport-demo/.env.local` and restart the dev server.

Before recording anything, check `curl http://localhost:8799/status` and
confirm `"aliasSponsorship": "available"` and `"ready": true`. On first run the
funder registers its own NIGHT for DUST generation and `ready` flips to `true`
within about a minute. The full API, refusal codes, and cost maths are in
[`examples/passport-funder/README.md`](../../examples/passport-funder/README.md).

## The walk-through

1. **One button.** The welcome screen offers a single action. If this browser
   holds a Passport profile it signs in; otherwise it asks the authenticator
   before enrolling anything, so a passkey that survived a site-data clear is
   signed in to rather than replaced. Record the platform and authenticator.
2. **The wallet opens in this tab.** The WebAuthn PRF output becomes a 32-byte
   Midnight seed and the wallet is built in the browser. The first sync walks
   the chain: measured on Preview (~296k blocks), about 75 seconds. Record how
   long it took and on what hardware.
3. **The name screen.** Availability is a live `domains.member()` read against
   the deployed `.night` TLD as you type, and the price shown is the deployed
   contract's own constant for that label length. A registry that cannot be
   reached says so.
4. **Claim — one user action, two things on chain, in order.** A single
   user-verified assertion derives both the Midnames owner secret and the
   contract root secret, and then:
   - the **account-custody contract deploys first**, because the name has to
     resolve to something. A Passport has one contract per network, so an
     existing deployed record is reused rather than deployed again;
   - the **name is registered pointing at that contract**. With the funder
     sponsoring, the funder deploys the resolver leaf and calls
     `register_domain_for` with the user's own owner key: the user's wallet
     signs nothing and spends nothing, and the client confirms the result with
     its own registry read before reporting it registered.

   Record every transaction hash that comes back, and note whether the
   registration was sponsored or self-paid. A funder refusal that self-paying
   could fix falls back to the self-paid claim; some refusals deliberately do
   not fall back, because the sponsored name may already have landed.
5. **The contract card is status, not a choice.** There is no "deploy contract"
   button. The card on Home reports what the claim produced, and offers a retry
   only on a record that says a previous automatic deploy failed.
6. **One identity on the primary surface.** The `.night` name is the identity.
   The three wallet addresses are deliberately not on the everyday screens;
   reach them where the flow needs them.
7. **Send.** Send unshielded NIGHT to an address pasted in, or scanned with the
   QR scanner — the camera fills the field and never bypasses it. Fees are
   sponsored; record the returned transaction hash and open it in the explorer.
8. **Apps.** Open the raffle from the Apps grid. It asks for a profile,
   Passport shows its own consent sheet, and only approved fields cross the
   origin boundary. Then let it request a payment: the app posts an intent,
   Passport approves and signs, and the node's transaction id comes back.
9. **The URL-callback round trip.** On a phone, run the redirect connector
   example on 5181 instead — the tab that opens Passport is frequently
   discarded on mobile, so the reply comes back in the URL fragment, signed.
   See [`examples/clubcoin-mock/README.md`](../../examples/clubcoin-mock/README.md).
10. **Backup.** Back the private state up behind a password and restore it.

### Not yet built: the Otrix totem

The next partner flow is **Otrix**: a totem displays a QR code carrying a
shielded deposit address, and the user pays it from Passport. It does not
exist yet — no code, no route, no fixture. Do not demonstrate it, and do not
describe it as available. ClubCoin, which used to be named here as the partner
dApp, is out of the demo entirely; the `clubcoin-mock` directory survives only
as the generic URL-callback example.

## Result language

- **Passed:** an actual API call completed and a wallet result or transaction
  hash was observed.
- **Blocked:** the dependency is absent — no funded funder, no camera
  permission, no registry on this network.
- **Failed:** the call ran and returned an error. Preserve the error text and
  the environment; do not replace it with a generic success screen.
- **Untested:** nobody has run it. This is not a synonym for "works".

Append observed runs to [`validation-log.md`](validation-log.md), with the
transaction hash where one exists and the error text where it fails.

## Guardrails that must survive a demo recording

- **Mainnet is hard-blocked in code.** Do not remove that check to record
  something.
- **Preview only.** Every preprod endpoint is healthy and the sponsor is funded
  there, but a cold wallet cannot walk ~1.98M blocks in a browser tab — it
  crashes at around 4.2 GB of heap. A depth guard in `src/lib/localWallet.ts`
  refuses a from-genesis walk above 500k blocks with an honest error rather
  than starting one. The measurements and the ruled-out tip-start experiment
  are written up in `examples/passport-demo/.env.example` and in
  `src/lib/walletSnapshot.ts`.
- **Sponsored fees are gated on the sponsor's own answer.** The client checks
  `available > 0` from the gateway's `/wallet-status`, never on a hopeful
  assumption. `VITE_SPONSOR_URL=off` disables sponsorship, at which point a
  fresh wallet cannot pay its first fee — which is the point of the default.
- **Nothing on screen is simulated.** A balance, a transaction hash, or a
  resolved name is either read from the chain or absent. A queued name is never
  shown as registered.
- **Private state stays encrypted.** Only public deployment metadata is stored
  unencrypted; device and maintenance state stay inside the AES-GCM envelope in
  IndexedDB, decrypted only for the duration of an explicit unlock.
