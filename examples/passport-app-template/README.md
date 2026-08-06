# Midnight Passport — app template

A starter for a third-party app that connects to **Midnight Passport**.

Clone it, delete the parts you do not need, and you have a working app that
asks a Passport user for a profile, renders exactly what they approved, and —
optionally — asks Passport to pay for something. It is deliberately small:
around 500 lines of commented `src/main.tsx` and two vendored protocol modules.

```bash
npm install
npm run dev        # http://localhost:5178
```

This folder is **self-contained**. Copy it anywhere — out of this repository,
into your own — and it builds. Nothing in it links back to a monorepo.

> Deliberately **not** an npm workspace of the repository it ships in. It has
> its own `node_modules`, so `npm install` here is the same command you would
> run after copying it out — which means the copy-out path is the path that is
> exercised every day, rather than a claim nobody tests.

---

## Contents

1. [What Passport is to your app](#what-passport-is-to-your-app)
2. [The three acts](#the-three-acts)
3. [Running it inside Passport, locally](#running-it-inside-passport-locally)
4. [The two protocols](#the-two-protocols)
5. [The security model, in plain words](#the-security-model-in-plain-words)
6. [Configuration](#configuration)
7. [Where to start editing](#where-to-start-editing)
8. [Listing your app in the registry](#listing-your-app-in-the-registry)
9. [Honest caveats](#honest-caveats)

---

## What Passport is to your app

Midnight Passport is a user's identity and wallet on the Midnight network: a
human-readable name, a passkey instead of a seed phrase, and a wallet that can
sign and submit transactions. It also has an in-app browser, and that is where
your app runs.

From your app's point of view Passport is **a counterparty on another origin
that you may ask for two things**:

| You want | You ask for | Passport does |
| --- | --- | --- |
| Who is this user? | a **profile** — a display name, an address, the Passport contract | shows its own consent sheet; returns only the fields the user ticked |
| A payment | a **transaction intent** — recipient, amount, purpose | shows its own approval sheet; signs, submits, and returns the node's transaction id |

Note the shape of both rows. Your app **asks**. Passport **decides, with the
user, on its own surface**. There is no API that lets you skip that step, and
that asymmetry is the product, not a limitation of the current version.

What your app never gets, in any mode, by any means:

- a private key, a seed phrase, or a passkey;
- the ability to sign anything;
- any profile field the user did not tick;
- anything at all before the user has answered.

Two mounting modes are supported by the same build:

- **Embedded** — Passport frames your app in its in-app browser. This is the
  normal case, and the only one where the transaction bridge exists.
- **Standalone** — your app is open in an ordinary tab and opens Passport in a
  popup for the profile handshake. Useful for development and for a web app
  that wants a "sign in with Passport" button.

`window.parent !== window` is the whole detection.

---

## The three acts

`src/main.tsx` is one page split into three labelled sections, in the order you
would build them.

### Act 1 — Connect

Establishes a channel and pins Passport's origin.

*Embedded:* Passport posts `passport.profile.ready` down to your frame as soon
as it loads, carrying a `requestId` and a `nonce` that **it** minted. You must
echo that exact pair in your request. Passport re-broadcasts `ready` every
800 ms until your frame says something back, so:

- treat `ready` as idempotent — it can arrive several times, and it can arrive
  late, mid-flow. Never let a repeat reset a payment already in flight;
- **acknowledge it.** Any message from your frame counts as "the app is alive",
  which stops the re-broadcast and clears Passport's "this app is not
  responding" hint. This template posts a one-line `passport.profile.hello`.
  Passport's parsers drop unknown message types harmlessly, so the ack costs
  nothing and is not itself part of the protocol.

*Standalone:* your app mints the pair itself and hands it to Passport as the
`passportRequestId` and `passportNonce` query parameters on the popup URL.
Passport echoes it back in `ready`, which is your signal that the window is
listening.

### Act 2 — Profile

Posts `passport.profile.request` with the fields you want, then renders the
response.

Two rules the template follows and you should too:

1. **Ask for the least you can use.** This template asks for `displayName` and
   `midnightAddresses`, and not `passportContract`, because it has nothing to
   do with it. Every extra field is a reason for the user to say no to all of
   them.
2. **Render what arrived and nothing else.** Consent is per-field: a user may
   approve the name and withhold the address. The template shows the withheld
   field as *not shared* rather than quietly leaving a gap, and shows a refusal
   as an ordinary outcome — not an error screen.

### Act 3 — Payment (optional, off by default)

Posts `passport.tx.request` with an intent, then handles the three possible
outcomes: `submitted`, `declined`, `failed`.

It is **off** unless `VITE_DEMO_PAYMENT=1` *and* `VITE_DEMO_PAYMENT_ADDRESS` is
set *and* the app is embedded. Read `requestPayment()` even if you never turn
it on — it is the whole transaction protocol in about thirty lines.

### The bridge transcript

The fourth panel is a live log of every message sent and accepted, with the
JSON one tap away. It is a teaching device: watch the `requestId`/`nonce` pair
be minted, echoed, and matched, and the protocol stops being abstract. Delete
`src/BridgeLog.tsx` when you no longer need it.

---

## Running it inside Passport, locally

You need two servers on two different origins.

**1. Start this app.**

```bash
npm install
npm run dev        # http://localhost:5178, strict port
```

**2. Start Passport**, from the Passport repository, on `http://localhost:5175`.

> **`5175` is not a suggestion.** Passport's dev build accepts exactly
> `http://localhost:5175` and silently redirects anything else there — its
> `src/main.tsx` replaces the location on any other origin when
> `import.meta.env.DEV` is set, and its Vite server pins port `5175` with
> `strictPort`. So: if your browser lands on 5175 after you started Passport
> somewhere else, you did not mistype and nothing is broken; and a second dev
> server already holding 5175 will collide with Passport rather than politely
> move aside. Start Passport first, and leave 5175 to it.

**3. Point Passport's app grid at this app.** Passport's in-app browser reads a
public registry and prepends a local development entry whose URL comes from an
environment variable. Start Passport with it set to this app:

```bash
VITE_LOCAL_APP_URL=http://localhost:5178 npm run demo
```

Add `VITE_LOCAL_APP_NAME="My App"` to label it; without one the grid calls it
*Local app*. The entry is prepended to the fetched registry, not swapped in for
it, so everything else in the grid is still there.

> `VITE_RAFFLE_URL` is the legacy name for this slot — it belongs to the raffle
> demo that occupied it before the generic one existed, and it still works
> exactly as it did. Prefer `VITE_LOCAL_APP_URL` for your own app. Setting both
> gives you two local entries, which is the point: you can keep the raffle
> around as a reference implementation while you develop against your own.

**4. In Passport:** create a passkey, open the apps grid, and tap the entry.
Your app loads in the in-app browser, the handshake completes on load, and
"Connect Midnight Passport" brings up Passport's consent sheet.

**Standalone mode** needs nothing but `npm run dev` and a Passport running on
`VITE_PASSPORT_ORIGIN`. Open `http://localhost:5178` directly; connecting opens
Passport in a popup. Allow popups for `localhost`.

> The port is fixed at **5178** with `strictPort`, on purpose. Passport frames
> your app by URL, and a dev server that quietly moves to the next free port is
> a handshake that quietly stops working.

---

## The two protocols

Both are plain `postMessage` protocols over a pinned origin. Both are defined
in `src/bridge/`, which is a verbatim copy of Passport's own definitions — the
parsers are strict: unknown shapes are rejected rather than coerced, and every
string is length-capped, so a hostile counterparty cannot push megabytes of
text into the other side's interface.

### Profile — `org.midnight.passport.profile/v1`

| Message | Direction | Body |
| --- | --- | --- |
| `passport.profile.ready` | Passport → app *(embedded only)* | `{ protocol, type, requestId, nonce }` |
| `passport.profile.request` | app → Passport | `{ protocol, type, requestId, nonce, fields }` |
| `passport.profile.response` | Passport → app | `{ protocol, type, requestId, nonce, approved, profile?, error? }` |

`fields` is a non-empty subset of:

| Field | Shape when approved |
| --- | --- |
| `displayName` | `string` |
| `passportContract` | `{ address: string, network: string }` |
| `midnightAddresses` | `{ unshielded: string, shielded?: string, dust?: string }` |

`approved: true` carries a `profile` object holding **only** the approved
fields. `approved: false` carries an `error`:

| Code | Meaning |
| --- | --- |
| `denied` | The user refused on Passport's consent sheet. |
| `profile_unavailable` | Passport has no profile to share yet. |
| `invalid_request` | The request did not parse, or a sheet was already open. |

### Transactions — `org.midnight.passport.tx/v1`

| Message | Direction | Body |
| --- | --- | --- |
| `passport.tx.request` | app → Passport | `{ protocol, type, requestId, nonce, intent }` |
| `passport.tx.response` | Passport → app | `{ protocol, type, requestId, nonce, status, txId?, error?, detail?, sponsored?, feeNote? }` |
| `passport.incentive.report` | app → Passport | `{ protocol, type, requestId, nonce, incentive }` |

`intent` is `{ kind: 'unshielded-transfer', recipientAddress, amount, purpose }`.

| Field | Rule |
| --- | --- |
| `kind` | `'unshielded-transfer'` — the only kind today |
| `recipientAddress` | `mn_addr…`, ≤ 200 chars. Passport validates it against its **own** live network; this package carries no Midnight SDK and does not pretend to check |
| `amount` | **atomic NIGHT** as a base-10 string, 1–20 digits, greater than zero. 1 NIGHT = 1 000 000. A string because a JSON number cannot carry atomic units without precision loss |
| `purpose` | ≤ 140 chars, shown to the user on the approval sheet |

`status` is one of:

| Status | Guarantee |
| --- | --- |
| `submitted` | Always carries a real `txId` from the node. |
| `declined` | The user said no. Nothing was signed. |
| `failed` | Carries an `error` code naming what stopped it. |

| Error code | Meaning |
| --- | --- |
| `declined` | Refused on the approval sheet. |
| `insufficient-funds` | The wallet cannot cover the amount. |
| `wallet-unavailable` | No Passport wallet session is open. |
| `invalid-request` | Did not parse, or a sheet was already open, or the recipient is not a valid unshielded address. |
| `network-mismatch` | The recipient belongs to another network. |
| `submit-failed` | Signed, but the node rejected it or was unreachable. |

`sponsored: true` may appear **only** on a `submitted` reply, and only when the
transaction genuinely came back from a fee sponsor. Render "network fee
covered" for `true` and for nothing else — absent means *not stated*, which you
must read as an ordinary, user-paid transaction.

`passport.incentive.report` is the one message that flows app → Passport with
no reply: it tells Passport what your app granted the user (`{ id, label,
txId? }`), so Passport can show it. Passport records exactly what you report
and never invents one on your behalf. This template does not use it; the raffle
demo does.

### Explorer links

The transaction route is `/transactions/{hash}`. `/tx/{hash}` **404s**. A link
that looks right and goes nowhere is worse than showing the bare identifier, so
the template renders plain text when `VITE_EXPLORER_URL` is empty.

---

## The security model, in plain words

**Origin pinning.** Every message is posted to one exact origin, never `'*'`,
and every inbound message whose `event.origin` is not that origin is dropped
before it is parsed. Posting to `'*'` hands your request — and, worse,
Passport's reply to it — to whatever document happens to be in that window. In
embedded mode the template also checks `event.source === window.parent`; in
standalone mode, `event.source === popup`. Origin alone is not enough: another
frame on the same origin is still another frame.

Getting this wrong fails *closed*, which is a small mercy: if
`VITE_PASSPORT_ORIGIN` is misconfigured the bridge transcript stays empty
rather than filling with someone else's traffic. A trailing slash counts —
`event.origin` never has one, so the template strips it.

**Request binding.** Every reply echoes the `requestId` and `nonce` of the
request it answers, and the app discards anything that does not match a pair it
is *currently* waiting on. That is what stops one exchange's answer being
replayed as another's — a declined payment from a minute ago must not be able
to arrive as the answer to the profile question, and vice versa. The nonce is
unguessable random, not a counter and not a timestamp. Each of the three
exchanges in this template has its own pair.

**Opt-in consent.** Passport's consent sheet starts with every box unticked,
every time, and it names your app's origin above them. There is no "remember
this app", no scope you can pre-request, and no way to ask again more
insistently. If a user approves one field of two, you get one field.

**Why you never see keys.** Passport does not inject a provider object into
your frame. It cannot: the same-origin policy makes it impossible to reach into
a cross-origin iframe, and Passport does not weaken that boundary to make it
possible. The only channel is `postMessage`, and the only things that cross it
are the messages tabled above. Signing happens on Passport's origin, with the
user's passkey, after the user has agreed on Passport's own surface. Your app
cannot be tricked into leaking a key it never had.

**What your app is still responsible for.** Everything after the reply arrives:
do not log addresses into third-party analytics, do not treat a `displayName`
as an authenticated identity (it is a name the user chose, not a proof), and do
not treat a `submitted` transaction as *confirmed* — it is at the node, not yet
final.

---

## Configuration

Copy `.env.example` to `.env.local`. Every variable is optional.

| Variable | Default | Effect |
| --- | --- | --- |
| `VITE_PASSPORT_ORIGIN` | `http://localhost:5175` | The one origin messages are sent to and accepted from. Must differ from this app's own origin. |
| `VITE_DEMO_PAYMENT` | unset | Exactly `1` arms act three. Anything else leaves it off. |
| `VITE_DEMO_PAYMENT_ADDRESS` | unset | The unshielded recipient (`mn_addr…`). Act three stays off without it. |
| `VITE_DEMO_PAYMENT_AMOUNT` | `100000` | Atomic NIGHT (`100000` = 0.1 NIGHT). |
| `VITE_EXPLORER_URL` | `https://explorer.preview.midnight.network` | Base for the `/transactions/{hash}` link. Empty renders the bare id. |

Vite inlines `VITE_*` variables into the bundle at build time. They are public.
Never put a secret in one.

---

## Where to start editing

```
src/
  main.tsx            ← the three acts. This is the file. ~500 commented lines.
  bridge/
    profileProtocol.ts  vendored, do not edit
    txProtocol.ts       vendored, do not edit
    index.ts            the barrel — the app-side half of both protocols
  BridgeLog.tsx       ← teaching device. Delete when you are done learning.
  PassportToast.tsx   ← delete if your app already has notifications.
  tokens.css          ← vendored Passport design tokens. Replace with your own.
  styles.css          ← layout. Declares no colours; only uses tokens.
```

A realistic first session:

1. Change `REQUESTED_FIELDS` to the fields your app actually needs.
2. Replace the act-two panel with your own interface. The state you care about
   is `profile?.profile`, and it is only populated on approval.
3. Delete `BridgeLog.tsx` and its import.
4. Keep `send()`. It is the single place that targets the origin and logs, and
   funnelling every outbound message through one function is the cheapest way
   to never accidentally write `'*'`.
5. If you need payments, un-gate act three and change `PAYMENT_PURPOSE` — the
   user reads it on Passport's approval sheet.

**Do not edit `src/bridge/*Protocol.ts`.** They are byte-copies of Passport's
own definitions. A protocol that has quietly drifted on one side is worse than
no protocol at all. If you need something they do not express, that is a
protocol change, and it belongs upstream.

---

## Listing your app in the registry

Passport's in-app browser reads a public registry, so the way users find your
app is a pull request against it:

**<https://github.com/webisoftSoftware/1AM-app-registery>** — see
[`CONTRIBUTING.md`](https://github.com/webisoftSoftware/1AM-app-registery/blob/main/CONTRIBUTING.md).

The flow: fork, add an entry to the `apps` array in `registry.json`, open a PR.

```json
{
  "id": "my-app",
  "name": "My App",
  "description": "What it does, in 120 characters or fewer",
  "icon": "https://my-app.example/icon-128.png",
  "url": "https://my-app.example",
  "category": "other",
  "networks": ["preview"],
  "new": true
}
```

Worth knowing before you submit:

- **`url` must be HTTPS and publicly reachable.** Passport refuses `http:`,
  `data:`, and `javascript:` entries outright, and an `http:` entry would put
  the profile handshake on the network in the clear. `localhost` works only via
  the local development entry described above, never via the registry.
- **`networks` must include the network your app is actually on.** Passport's
  grid filters by the connected wallet's network, and an entry declaring only
  `preview` simply vanishes for a user on preprod.
- **Do not set `featured`** — that is the maintainers' field.
- Ship an icon at 128×128, PNG or SVG, under 50 KB.

---

## Honest caveats

- **This is a template, not a product.** It is not audited and has no tests. It
  exists to show the shape of the integration.
- **The transaction bridge is embedded-only.** There is no popup equivalent
  today. Standalone mode gets the profile handshake and nothing else, and the
  template says so instead of offering a button that cannot work.
- **`unshielded-transfer` is the only intent kind.** No contract calls, no
  shielded transfers, no batching. Ask upstream before designing around one.
- **`submitted` means *at the node*, not *final*.** No confirmation depth is
  reported. If your app needs finality, watch the chain yourself.
- **Fee sponsorship, where it exists, is best-effort.** If the sponsor is
  unreachable the transaction falls back to real, user-paid fees, and the reply
  simply omits `sponsored`. Never label something free on that basis.
- **Act three needs a Passport that can actually pay.** Arming
  `VITE_DEMO_PAYMENT` on your side is the easy half. The other half is on the
  Passport you point at: a full local Passport, with a passkey created in that
  browser profile, whose on-device wallet genuinely holds NIGHT — from the
  public network's faucet, or from the Passport repository's
  `fund-localnet.mjs` if you are running against a localnet — **and** has DUST
  generation registered, via the wallet's *Register DUST* control. DUST is what
  pays the fee; NIGHT on its own does not generate it. Short of all three, the
  approval sheet refuses with the wallet's own error — your app gets a `failed`
  reply carrying `insufficient-funds` (no NIGHT, or no DUST) or
  `wallet-unavailable` (no wallet session at all). That is the designed
  behaviour, not a bug: Passport reports what its wallet actually said rather
  than simulating a success, and nothing on this side can make an unfunded
  wallet pay.
- **The registry entries that point at `localhost` are a development
  convenience**, and they are the only reason plain `http:` is accepted
  anywhere in this system.

---

## Vendored code

`src/bridge/` and `src/tokens.css` are copies from the Passport repository,
each with a provenance header naming its source. They are vendored rather than
linked so this folder builds after a plain copy out of the monorepo — which is
the point: you get a project that runs, not one that needs a monorepo you do
not have.

## Licence

Apache-2.0 — see [`LICENCE`](./LICENCE). Copyright 2026 Input Output Global, Inc.
