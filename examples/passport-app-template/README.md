# Midnight Passport — app template

A starter for a third-party app that connects to **Midnight Passport**: the
profile handshake with per-field consent, and an optional payment request,
over Passport's public `postMessage` bridge.

Clone it, delete the parts you do not need, and you have a working app. It is
deliberately small — one commented `src/main.tsx` and two vendored protocol
modules — and **self-contained**: copy the folder anywhere and it builds.
Nothing in it links back to a monorepo, and `npm install` here is the same
command you would run after copying it out.

It is also **AI-ready**: [`CLAUDE.md`](./CLAUDE.md) is a contract for an AI
coding agent — point Claude Code (or similar) at this folder and say "build me
an app on Midnight Passport".

## 60-second start

```bash
npm install
npm run dev        # http://localhost:5178, strict port
```

That gets you the app standalone. To run it *inside* Passport you also need a
local Passport on `http://localhost:5175` and one environment variable —
follow [docs/QUICKSTART.md](./docs/QUICKSTART.md), it is five numbered steps.

## What Passport is to your app

Passport is the user's identity and wallet on Midnight. From your app's point
of view it is **a counterparty on another origin that you may ask for two
things**:

| You want | You ask for | Passport does |
| --- | --- | --- |
| Who is this user? | a **profile** — display name, addresses, the Passport contract | shows its own consent sheet; returns only the fields the user ticked |
| A payment | a **transaction intent** — recipient, amount, purpose | shows its own approval sheet; signs, submits, and returns the node's transaction id |

Your app **asks**. Passport **decides, with the user, on its own surface**.
There is no API that skips that step. Your app never sees a key, a seed, a
passkey, or a signature — signing happens on Passport's origin, and the
same-origin policy keeps it there.

Two mounting modes, one build, detected by `window.parent !== window`:

- **Embedded** — Passport frames your app in its in-app browser. The normal
  case, with per-field consent, and the only mode with the transaction
  bridge.
- **Standalone** — your app opens Passport in a popup for the profile
  handshake. Consent is all-or-nothing; no transactions.

## Documentation

| Document | What is in it |
| --- | --- |
| [docs/QUICKSTART.md](./docs/QUICKSTART.md) | Zero to running inside Passport, numbered and verified. Also standalone mode, testing against a deployed Passport, and arming the payment. |
| [docs/PROTOCOL.md](./docs/PROTOCOL.md) | Both protocols in full: every message with a JSON example and its validation rules, sequence diagrams, error vocabulary, length caps. |
| [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md) | The real failure modes, each with the exact copy the app shows, the cause, and the fix. |
| [CLAUDE.md](./CLAUDE.md) | The AI-agent contract: the bridge surface, the never-do list, and where the ground truth lives. |

## The shape of the code

```
src/
  main.tsx            ← the whole integration, in three labelled acts:
                        1 Connect, 2 Profile, 3 Payment (optional, off by default)
  bridge/
    profileProtocol.ts  vendored copy of Passport's definition — do not edit
    txProtocol.ts       vendored copy of Passport's definition — do not edit
    index.ts            the barrel — the app-side half of both protocols
  BridgeLog.tsx       ← live transcript of every bridge message. A teaching
                        device; delete it when you are done learning.
  PassportToast.tsx   ← delete if your app already has notifications.
  tokens.css          ← vendored Passport design tokens. Replace with yours.
  styles.css          ← layout only; colours come from tokens.
```

A realistic first session: change `REQUESTED_FIELDS` to what your app actually
needs, replace the Act 2 panel with your own interface, delete `BridgeLog`,
and keep `send()` — funnelling every outbound message through one function is
the cheapest way to never accidentally post to `'*'`.

## Security model, in one paragraph

Every message goes to **one pinned origin** (never `'*'`) and inbound messages
are checked for origin *and* source before parsing — get it wrong and the
bridge fails closed, with an empty transcript rather than someone else's
traffic. Every reply is bound to the `requestId` + `nonce` pair of the request
it answers; unmatched replies are dropped. Consent is opt-in and, embedded,
per-field — render what arrived and say plainly what did not. The strict
parsers, the caps, and the full argument are in
[docs/PROTOCOL.md](./docs/PROTOCOL.md).

## Configuration

Copy `.env.example` to `.env.local`. Every variable is optional.

| Variable | Default | Effect |
| --- | --- | --- |
| `VITE_PASSPORT_ORIGIN` | `http://localhost:5175` | The one origin messages are sent to and accepted from. Must differ from this app's own origin. |
| `VITE_DEMO_PAYMENT` | unset | Exactly `1` arms Act 3. Anything else leaves it off. |
| `VITE_DEMO_PAYMENT_ADDRESS` | unset | The unshielded recipient (`mn_addr…`). Act 3 stays off without it. |
| `VITE_DEMO_PAYMENT_AMOUNT` | `100000` | Atomic NIGHT (`100000` = 0.1 NIGHT). |
| `VITE_EXPLORER_TX_URL` | `https://explorer.1am.xyz/tx/{hash}?network=preview` | Link template; `{hash}` is replaced with the transaction hash. Empty renders the bare hash. |

Vite inlines `VITE_*` variables into the public bundle. Never put a secret in
one.

## Listing your app in the registry

Passport's in-app browser reads a public registry, so shipping to users is a
pull request against
**<https://github.com/webisoftSoftware/1AM-app-registery>** (see its
`CONTRIBUTING.md`): fork, add an entry to the `apps` array in
`registry.json`, open a PR. `url` must be public HTTPS — `localhost` works
only via the local development slot described in the quickstart — and
`networks` must include the network your app is actually on, or Passport's
grid filters it out.

## Honest caveats

- **A template, not a product.** Not audited, no tests. It exists to show the
  shape of the integration.
- **The transaction bridge is embedded-only**, and `unshielded-transfer` is
  the only intent kind. No contract calls, shielded transfers, or batching.
- **`submitted` means *at the node*, not *final*.** No confirmation depth is
  reported; if you need finality, watch the chain yourself.
- **Payments are paid in NIGHT by the user's Passport wallet.** The network
  fee is sponsored only when the reply says `sponsored: true`; otherwise it
  comes from the user's DUST. Nothing here is free, and sponsorship is
  best-effort. The wallet-side requirements (NIGHT, *and* something covering
  the DUST fee)
  are spelled out in [docs/QUICKSTART.md](./docs/QUICKSTART.md#e-arming-the-optional-payment-act-3)
  and [docs/TROUBLESHOOTING.md](./docs/TROUBLESHOOTING.md#insufficient-funds--night-versus-dust).

## Vendored code

`src/bridge/` and `src/tokens.css` are copies from the Passport repository,
each with a provenance header naming its source. Vendored rather than linked
so this folder builds after a plain copy — you get a project that runs, not
one that needs a monorepo you do not have. **Do not edit the protocol
modules**; a protocol that has quietly drifted on one side is worse than none.

## Licence

Apache-2.0 — see [`LICENCE`](./LICENCE). Copyright 2026 Input Output Global, Inc.
