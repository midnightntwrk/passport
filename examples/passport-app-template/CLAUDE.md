# CLAUDE.md — agent contract for this template

You are working in a **starter kit for a third-party app that connects to
Midnight Passport**, the identity and wallet layer for the Midnight network.
The developer's intent is to turn this template into their own app. Your job
is to build *their* app on top of the bridge this template already speaks —
not to reinvent, extend, or bypass that bridge.

## Ground truth

Every technical claim you make or code path you write must be checkable
against these files, in this order of authority:

1. `src/bridge/profileProtocol.ts` and `src/bridge/txProtocol.ts` — **vendored
   byte-copies of Passport's own protocol definitions. Never edit them.** If a
   change seems needed there, it is a protocol change and belongs upstream;
   say so instead of editing.
2. `src/bridge/index.ts` — the barrel exporting the app-side half of both
   protocols. This is what application code imports.
3. `src/main.tsx` — the reference client: origin pinning, both mounting
   modes, all three exchanges, timeouts, and honest failure copy.
4. `docs/PROTOCOL.md` — the protocol reference, with per-message JSON examples
   and validation rules, derived from the files above.

There is **no other API**. No REST endpoints, no injected `window` provider,
no SDK import. The bridge is `postMessage` to one pinned origin, and the
message types listed below are the entire surface. Do not invent others.

## The two integration modes

Detection is one comparison: `EMBEDDED = window.parent !== window`
(`src/main.tsx`). The same build must handle both.

| | Embedded (normal case) | Standalone |
| --- | --- | --- |
| Topology | Passport frames the app in its in-app browser; Passport is `window.parent`. | App opens Passport as a popup. |
| Handshake pair | **Passport mints it**, posts `passport.profile.ready` down, re-broadcasts every 800 ms (capped at 40 attempts, ~32 s) until the frame speaks. The app must echo that exact pair. | **The app mints it** (`crypto.randomUUID()` + random nonce) and hands it over as URL query parameters; Passport echoes it back in `ready`. |
| Ack | Required in practice: answer `ready` with any message (the template posts `passport.profile.hello`) to stop the re-broadcast and clear Passport's "not responding" hint. | Not applicable. |
| Profile consent | **Per-field**: a toggle per requested field, each unticked by default. Any subset may come back. | **All-or-nothing**: the requested set is approved or declined as a whole. |
| Transaction bridge | Available, posted to `window.parent`. | Available, over a Passport popup opened on the payment launch parameters. Same messages, same replies. |
| Incentive report | Available. | **Not available** — the popup surface does not record them, and there is no parent to post to. Do not send it. |
| Popup management | Not applicable. | Poll `popup.closed` every 500 ms; 180 s overall timeout. One window name for both exchanges, so the payment reuses the window the user connected with. |

### The popup launch contract (standalone)

Passport arms **exactly one** consent surface per window load, chosen by the
query parameters the launch URL carries:

| Exchange | Query parameters |
| --- | --- |
| Profile | `passportRequestId`, `passportNonce` |
| Payment | `passportTxRequestId`, `passportTxNonce` |

Both surfaces announce themselves with `passport.profile.ready` echoing that
pair, so the **pair**, never the message type, is what says which exchange is
being answered. Passport accepts a request only from `window.opener` and only
when it carries that exact pair; anything else is dropped without a reply. A
re-send of the same pair is the same request, not a second sheet. A payment
launched on the profile parameters will never be answered — that is the
commonest standalone-payment bug (`docs/TROUBLESHOOTING.md`).

## The bridge surface (complete)

Protocols: `org.midnight.passport.profile/v1` (`profileProtocol.ts:17`) and
`org.midnight.passport.tx/v1` (`txProtocol.ts:43`). Full shapes, JSON
examples, and validation rules: `docs/PROTOCOL.md`.

| Message | Direction | Purpose |
| --- | --- | --- |
| `passport.profile.ready` | Passport → app | Handshake: carries/echoes `{requestId, nonce}`. |
| `passport.profile.request` | app → Passport | `fields`: non-empty, duplicate-free subset of `displayName`, `passportContract`, `midnightAddresses`. |
| `passport.profile.response` | Passport → app | `approved: true` + `profile` (only approved fields), or `approved: false` + `error`: `denied` \| `profile_unavailable` \| `invalid_request`. |
| `passport.tx.request` | app → Passport | `intent`: `{ kind: 'unshielded-transfer', recipientAddress (≤200), amount (base-10 string, 1–20 digits, > 0), purpose (≤140) }`. Both channels. |
| `passport.tx.response` | Passport → app | `status`: `submitted` (always with `txId`) \| `declined` \| `failed` (with `error`); optional `detail` (≤400), `sponsored`, `feeNote` (≤140). |
| `passport.incentive.report` | app → Passport | Fire-and-forget: `{ id (≤256), label (≤80), txId? }`. No reply. Embedded only. |

Transaction error vocabulary (`txProtocol.ts:82`): `declined`,
`insufficient-funds`, `wallet-unavailable`, `invalid-request`,
`network-mismatch`, `submit-failed`. Map every one to a plain sentence — the
template's `TX_REFUSALS` map in `src/main.tsx` is the model. Never show a
bare code.

Caps worth remembering while generating code: ids and nonces ≤ 256; profile
strings ≤ 256, profile addresses ≤ 512; `amount` is a **string** of atomic
NIGHT (1 NIGHT = 1 000 000), never a JSON number.

## What you must never do

- **Never handle key material.** No seeds, private keys, passkeys, mnemonics,
  or signatures — not in code, not in storage, not in logs, not "for
  testing". The bridge never carries them and your code must never expect,
  request, or fabricate them.
- **Never bypass or simulate the approval sheet.** Consent happens on
  Passport's surface. Do not auto-retry a `declined`, pre-tick anything,
  fake a `submitted` response, or build UI implying approval already
  happened.
- **Never invent bridge messages or endpoints.** The six message types above
  are the whole surface. No `passport.*` types beyond them, no HTTP calls to
  Passport, no reading Passport state by any side channel.
- **Never post to `'*'`.** Every `postMessage` targets the one pinned origin
  (`PASSPORT_ORIGIN`), and every inbound message is checked for both
  `event.origin` and `event.source` before parsing. Keep every outbound
  message going through the single `send()` helper.
- **Never edit `src/bridge/*Protocol.ts`**, and never loosen a parser. A
  protocol that has quietly drifted on one side is worse than none.
- **Never reuse a request pair.** Each exchange gets a freshly minted
  `requestId` + `nonce` (except the embedded profile request, which must echo
  the pair Passport minted). Match every reply against the pair currently
  awaited; drop everything else. Standalone, that pair also goes on the popup
  launch URL, under the parameter names for *that* exchange.
- **Never treat a blocked or closed popup as a success.** No window means no
  approval sheet, so nothing was signed and nothing was paid. Say that, and
  grant nothing.
- **Never promise a free transaction.** Render "network fee covered" only for
  `sponsored === true` on a `submitted` reply. Absent means user-paid.
- **Never fill consent gaps.** Render only fields that actually arrived;
  label the rest as not shared. A refusal is an ordinary outcome, not an
  error screen.
- **Never put a secret in a `VITE_*` variable** — Vite inlines them into the
  public bundle.
- **Never add dependencies to `src/bridge/`** — it is dependency-free so the
  folder survives a plain copy into any project. Prefer adding no runtime
  dependencies at all; the template ships with react, react-dom, and
  lucide-react only (`package.json`).

## Running and testing

Full numbered steps: `docs/QUICKSTART.md`. The short version:

- This app: `npm run dev` on **http://localhost:5178** — `strictPort`, pinned
  in `vite.config.ts`. If you change the port, change Passport's registry
  entry at the same time.
- Passport (from its own repository) runs on **http://localhost:5175** and
  will not run anywhere else in dev — its build redirects other local origins
  to 5175. Leave 5175 to it.
- To appear in Passport's app grid locally, start Passport with
  `VITE_LOCAL_APP_URL=http://localhost:5178 npm run demo` (optionally
  `VITE_LOCAL_APP_NAME="My App"`).
- Against a **deployed** Passport: standalone works by setting
  `VITE_PASSPORT_ORIGIN` to its exact HTTPS origin; embedded requires the app
  itself deployed to public HTTPS and listed in the registry (`http:` is
  refused there).
- Typecheck with `npm run typecheck`; `npm run build` runs `tsc --noEmit`
  first. There are no tests in this template — do not claim there are.

## The payment flow truth

State it exactly this way in any copy you write: the amount is paid **in
NIGHT, by the user's own Passport wallet**, after the user approves on
Passport's sheet. The network fee is **either covered by a sponsor**
(`sponsored: true`, and only then) **or paid from the user's DUST**. A wallet
with NIGHT that reaches neither — no sponsor, and no DUST of its own — still
gets `insufficient-funds`
— that is designed behaviour (`docs/TROUBLESHOOTING.md`). `submitted` means
*at the node*, not *final*. Nothing here is free, and no copy may say it is.

## Getting listed on the Passport App Hub

The Passport App Hub (`examples/passport-app-hub` in the Passport repository)
is the public list of apps that integrate this bridge. It renders the app
registry's `registry.json` — the same file Passport's own app grid fetches —
so listing is one pull request against the registry repository, not a code
change anywhere:

1. Fork the registry repository, add **one entry** to the `apps` array in
   `registry.json`, and open a pull request.
2. CI schema-checks the entry with the registry's dependency-free
   `validate.js` (run it locally first: `node validate.js`, no install).
3. A maintainer reviews by hand and merges; the hub and Passport's grid pick
   the entry up on their next fetch.

Required fields, per the registry schema: `id` (unique, `^[a-z0-9-]{1,32}$`),
`name` (≤ 40 chars), `description` (≤ 120 chars, honest), `icon` (absolute
`https` URL, 128×128 PNG or SVG, ≤ 50KB), `url` (absolute `https`, live),
`category` (one of `defi`, `gaming`, `tools`, `identity`, `other`), and
`networks` (non-empty subset of `preview`, `preprod`, `mainnet`). Optional:
`new` and `immersive`; **never set `featured`** — it is maintainers-only. No
other keys are permitted; the validator rejects them.

The hub only lists schema-checked entries, and a listing is not an audit —
it records that the app exists, is reachable over `https`, and asked to be
listed.

## Conventions

- British English in user-facing copy ("colour", "authorise"), Oxford comma.
- Honest failure copy: name what actually stopped it, in the user's language,
  and show Passport's `detail` sentence when present.
- Docs are plain markdown; keep the folder copy-out-able — no monorepo links,
  no new build steps.
