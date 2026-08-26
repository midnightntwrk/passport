# Grand Prix Raffle — a Midnight Passport example dApp

An open-source example of a dApp that talks to **Midnight Passport**: it asks
for a profile, gets an address back only if the user approves, and then asks
Passport to pay for a raffle entry with a real transaction on the Midnight
**preview** network.

It is deliberately small. Everything interesting is in `src/main.tsx` and the
two vendored protocol modules under `src/bridge/`.

---

## What it demonstrates

1. **A profile handshake across an origin boundary.** The raffle never sees a
   key, a seed, or a wallet. It posts a request; Passport shows its own consent
   sheet; and only on approval does an address come back.
2. **A payment the app does not perform.** The raffle cannot spend anything. It
   posts a transaction *intent* — recipient, amount, purpose — and Passport
   signs and submits it, returning the node's own transaction identifier.
3. **Both mounting modes from one build.** The same page runs standalone (it
   opens Passport in a popup and mints the request id and nonce itself) and
   embedded inside Passport's in-app browser (Passport is the parent frame,
   mints the pair, and posts a `ready` message down, which the app must echo
   back exactly).
4. **Honest failure.** Every refusal is a named code, every unconfirmed entry
   says so, and nothing is ever shown as on-chain without a transaction id.

---

## The bridge protocols

Both are plain `postMessage` protocols over a targeted origin. The vendored
parsers in `src/bridge/` are strict: unknown shapes are rejected rather than
coerced, and every string is length-capped so a hostile counterparty cannot
push megabytes of text into the other side's interface.

### Profile — `org.midnight.passport.profile/v1`

| Message | Direction | Shape |
| --- | --- | --- |
| `passport.profile.ready` | Passport → app (embedded only) | `{ protocol, type, requestId, nonce }` |
| `passport.profile.request` | app → Passport | `{ protocol, type, requestId, nonce, fields }` |
| `passport.profile.response` | Passport → app | `{ protocol, type, requestId, nonce, approved, profile?, error? }` |

`fields` is any subset of `displayName`, `passportContract`, and
`midnightAddresses`. A denied request answers `approved: false` with `error`
being one of `denied`, `profile_unavailable`, or `invalid_request`.

### Transactions — `org.midnight.passport.tx/v1`

| Message | Direction | Shape |
| --- | --- | --- |
| `passport.tx.request` | app → Passport | `{ protocol, type, requestId, nonce, intent }` |
| `passport.tx.response` | Passport → app | `{ protocol, type, requestId, nonce, status, txId?, error?, detail?, sponsored?, feeNote? }` |
| `passport.incentive.report` | app → Passport | `{ protocol, type, requestId, nonce, incentive }` |

`intent` is `{ kind: 'unshielded-transfer', recipientAddress, amount, purpose }`,
where `amount` is **atomic NIGHT** as a base-10 string (1 NIGHT = 1 000 000).

`status` is `submitted`, `declined`, or `failed`. A `submitted` reply always
carries a real `txId`; the error codes are:

| Code | Meaning |
| --- | --- |
| `declined` | The user refused on Passport's own approval sheet. Nothing was signed. |
| `insufficient-funds` | The wallet cannot cover the amount. |
| `wallet-unavailable` | No Passport wallet session is open. |
| `invalid-request` | The request did not parse, or the intent is not supported. |
| `network-mismatch` | The recipient does not belong to the wallet's network. |
| `submit-failed` | Signed, but the node rejected it or could not be reached. |

`sponsored: true` may appear **only** on a `submitted` reply, and only when the
transaction really came back from a fee sponsor with its fee input attached. An
app may render "network fee covered" for `true` and for nothing else. Absent
means *not stated*, which must be read as an ordinary, user-paid transaction.

### requestId / nonce binding

Every reply must echo the exact `requestId` **and** `nonce` of the request it
answers, and the app must discard anything that does not match a pair it is
currently waiting on. This is what stops a reply for one request being replayed
as the answer to another.

Who mints the pair depends on the mounting mode:

- **standalone** — the app mints both, passes them to Passport as the
  `passportRequestId` and `passportNonce` query parameters on the popup URL,
  and checks them on the way back;
- **embedded** — Passport mints both and sends them in `passport.profile.ready`;
  the app must echo those exact values, not generate its own.

Messages are always posted to a specific origin (`VITE_PASSPORT_ORIGIN`), never
`*`, and inbound messages whose `event.origin` does not match are dropped.

---

## Environment

All variables are optional; every one has a working default or a documented
"off" behaviour. Copy `.env.example` to `.env.local` to set them.

| Variable | Default | Effect |
| --- | --- | --- |
| `VITE_PASSPORT_ORIGIN` | `http://localhost:5175` | The Passport origin this app talks to. Must be a **different** origin from the raffle, or the handshake proves nothing. |
| `VITE_RAFFLE_COLLECTION_ADDRESS` | unset | A preview unshielded address (`mn_addr…`) the operator controls. **Unset** keeps the raffle profile-only: no transaction is ever requested, and the footer says nothing is on-chain. **Set** makes "Enter the raffle" ask Passport for a real NIGHT transfer. |
| `VITE_RAFFLE_ENTRY_AMOUNT` | `100000` | Entry price in atomic NIGHT (`100000` = 0.1 NIGHT). |
| `VITE_TELEGRAM_URL` | unset | Support link on the ticket. No link is rendered when unset. |

The explorer is fixed to `https://explorer.preview.midnight.network`, and a
transaction link is only ever rendered on preview — the route is
`/transactions/{hash}`.

---

## Running it

```bash
npm install
npm run dev        # http://localhost:5177
```

```bash
npm run build      # tsc --noEmit, then a production bundle into dist/
npm run preview    # serve the built bundle
```

The port is fixed at **5177** with `strictPort`, because Passport's app registry
points at `http://localhost:5177` for the local entry. Change both if you move
it.

To see the whole flow you also need Passport itself running on
`VITE_PASSPORT_ORIGIN` (the demo app defaults to `http://localhost:5175`), with
a passkey Passport created and its wallet open.

---

## Honest caveats

- **Preview network only.** Passport signs and submits on Midnight preview and
  nowhere else. On any other network the raffle stays profile-only.
- **A demo sponsor may not be there.** Where fee sponsorship is configured, it
  is best-effort: if the sponsor service is unreachable or has not authorised
  the request, the transaction falls back to real, user-paid fees, and the
  interface says so. Nothing here is ever labelled "free" unless the reply
  genuinely reported `sponsored: true`.
- **No prizes.** There is no draw, no prize, and no operator obligation. The
  perks on the ticket are illustration.
- **Entries are stored in `localStorage`,** keyed by address. Clearing site data
  clears the ticket. In on-chain mode an entry with no transaction id is not
  honoured as a ticket, and the raffle asks for payment again.
- **Not audited, not production.** This is example code published to show the
  shape of the integration.

---

## Vendored code

`src/bridge/` and `src/tokens.css` are copies from the Passport repository, each
with a provenance header naming its source. They are vendored rather than
linked so this folder builds after a plain copy out of the monorepo. Keep them
in step with their sources; a protocol that has drifted on one side is worse
than no protocol at all.

## Licence

Apache-2.0 — see [`LICENCE`](./LICENCE). Copyright 2026 Input Output Global, Inc.
