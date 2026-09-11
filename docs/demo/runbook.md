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

## Upgrading a Passport

### What it is, and who sees it

The account-custody contract gained a circuit on 2026/09/10 —
`transfer_shielded_to_account`, the one
[`one-tx-transfer-drill.md`](one-tx-transfer-drill.md) §3d settles on chain — so
paying another Passport is one transaction rather than two. A circuit is part of
a deployed contract's code and there is no upgrade path for one, so this splits
Passports in half for good:

- a Passport **set up on or after 2026/09/10** carries the circuit and sends in
  one transaction;
- a Passport **set up before it** does not, and never will.

**Receiving is unaffected either way.** The recipient's `deposit_shielded` key
is byte-identical across the two builds, which is why the peer is named through
a contract declaration of it — so an older Passport can be PAID in one
transaction today, with nothing done to it. Only sending is at stake.

So an older Passport is migrated, once: drain it, deploy a new account with the
same commitments derived from the same passkey, move the name across, put the
value back. About four to six sponsored transactions, nothing the holder pays
for, no new passkey and no new name. Hector accepted this shape on 2026/09/08.

The screen is `src/screens/Upgrade.tsx` — the claim's three-step view, titled
"Your Passport is being upgraded". Nothing spendable is on it: for the minutes
an upgrade takes, some of what the Passport holds is out of the old account and
not yet in the new one, and any balance shown would be true of neither.

**Before a recording**, either upgrade the demo Passports off camera or set them
up fresh — a Passport created today needs none of this. An upgrade mid-demo is
minutes of progress bars.

### Where a stuck upgrade is

Every step is written down the moment it lands, in `localStorage` under
`passport-contract:v1`, on the record for the account being upgraded away from.
In the browser console:

```js
Object.values(JSON.parse(localStorage.getItem('passport-contract:v1'))).map(r => r.upgrade)
```

An `upgrade` block that is present is an upgrade that has not finished. Read it
in this order:

| Field | Meaning when set |
|---|---|
| `fromAddress` | the account being left — always present |
| `drainedNight`, `drainedShielded` | what the old account held before anything moved, by colour. Written once, on the first attempt |
| `drained` | the old account has been READ BACK holding nothing |
| `toAddress` | the new account's address, written the moment its deploy was SUBMITTED — before the chain answered |
| `deployed` | the indexer has been seen serving state at `toAddress` |
| `repointed` | the name has been READ BACK resolving to `toAddress` |
| `refundedNight`, `refundedShielded` | the colours already paid back in |
| `refunded` | every drained colour is back inside the new account |
| `failureReason` | why the last attempt stopped, in the words the screen showed |

The first of those that is **absent** is the step it stopped on. A block with
`toAddress` and no `deployed` is the one worth knowing: the account may well
exist — paste `toAddress` into the explorer — and the next attempt asks the
chain rather than deploying again.

The Passport stays on `address` (the old account) for the whole of this. It
moves to `toAddress` only at the last step, and the `upgrade` block is deleted
in the same write.

### Resuming one

Press **Try again** on the screen. There is nothing else to do and nothing to
clean up first.

Every step checks the chain before it acts — the account already empty, the new
account already served, the name already resolving to it, the colour already
back inside — so a resume after a landed step costs one read and never a second
sponsored fee. A retry is safe from any state, including one where the tab died
mid-proof.

Two failures need a person rather than a retry:

- **"Your name could not be moved…"**, repeatedly. The name's resolver is moved
  either by the holder's own Passport or by the balancer's
  `POST /repoint-alias`, depending on who owns the resolver leaf — a sponsored
  registration hands it over afterwards, in the background, and that hand-over
  is allowed to fail. Ask the balancer directly to see which it thinks it is:

  ```
  curl -s -X POST "$FUNDER_URL/repoint-alias" \
    -H 'content-type: application/json' \
    -d '{"name":"alice","newAccount":"<64 hex>","oldAccount":"<64 hex>"}'
  ```

  `owner-is-user` means the leaf is the holder's and their Passport should be
  doing this — check that the client had a passkey assertion to derive the owner
  key from. `not-your-passport` means the two accounts share no live device, so
  they are not the same Passport. `repoint-unsupported` means the balancer has
  no registry or no account build loaded; its start-up log says which.

- **A drain that will not empty.** Read the old account's balances in the
  explorer. A colour that is genuinely still there after a successful withdrawal
  is a chain problem, not a client one; capture the figures and the transaction
  before retrying.

### What has not been run

This flow has never been exercised against a live pre-upgrade Passport. Doing so
needs a funded one **and** the passkey secret that controls it, which only a real
device has. What is checked is every decision it makes — resume after each step,
skip what is already done, and who may ask the balancer to move a name — in
`src/identity/accountUpgrade.test.ts` and
`examples/passport-balancer/test/repoint.test.ts`. Record the first live run in
[`validation-log.md`](validation-log.md), by the rules below.

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
