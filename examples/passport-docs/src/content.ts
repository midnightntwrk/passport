/**
 * Midnight Passport documentation — the single structured source.
 *
 * Every section is authored as plain markdown here, and everything downstream
 * is generated from this module: the rendered pages (via `markdown.tsx`), the
 * "Copy for AI" clipboard dump, and the `/llms.txt` file emitted at build time
 * (see `vite.config.ts`). One source, three outputs — the button can therefore
 * dump the ENTIRE documentation, tables included, as clean markdown.
 *
 * SOURCING DISCIPLINE
 * -------------------
 * Every technical claim below is derived from the actual code and docs in this
 * repository. Each section constant carries a comment naming the files it was
 * derived from. Nothing here is invented; where a behaviour is a measurement,
 * the date of the measurement is kept (format YYYY/MM/DD).
 */

export interface DocSection {
  /** Stable id — doubles as the URL hash. */
  id: string;
  /** Nav and page title. */
  title: string;
  /** Short nav strapline. */
  lede: string;
  /** The section body, as markdown. `##` is the top in-page heading level. */
  markdown: string;
}

export const DOCS_TITLE = 'Midnight Passport Docs';

/* -------------------------------------------------------------------------- */
/* 1. Welcome                                                                 */
/*                                                                            */
/* Sources: examples/passport-demo/src/screens/Onboarding.tsx (product copy,  */
/* one-button onboarding); examples/passport-app-hub/src/App.tsx (hub URLs,   */
/* registry status); examples/passport-app-template/CLAUDE.md (template and   */
/* registry roles); demo-backend/src/passkey.ts (passkey-derived wallet).     */
/* -------------------------------------------------------------------------- */

const WELCOME: DocSection = {
  id: 'welcome',
  title: 'Welcome',
  lede: 'What Midnight Passport is, and the pieces that make it up.',
  markdown: `
Midnight Passport is a **passkey-first wallet and identity layer** for the
[Midnight network](https://midnight.network). One passkey holds your names,
addresses, and credentials — held on your device, proven in private. There is
**one button and no seed phrase**: the first tap creates a passkey and signs
you straight in; every later tap unlocks the same Passport with the same
passkey.

The wallet's seed is *derived from the passkey itself* (via the WebAuthn PRF
extension), so there is nothing to write down and nothing to paste anywhere.
Consent stays on Passport's own surface: applications never see keys, and every
transaction is approved with your device's own verification — Touch ID,
fingerprint, or device PIN.

## The pieces

| Piece | What it is | Where it lives |
| --- | --- | --- |
| **Passport app** | The wallet and identity client itself — onboarding, balances, Send and Receive, the DUST battery, \`.night\` names, and the in-app browser for connected apps. | [midnightpassport.com](https://midnightpassport.com) |
| **App Hub** | The hackathon showcase for apps built on the Passport bridge — listing is a pull request against the registry. The full app catalogue renders inside Passport's own Apps tab. | [hub.midnightpassport.com](https://hub.midnightpassport.com) |
| **App template** | A starter kit for building your own Passport-connected app — the bridge modules, a reference client, and full protocol docs. | [template.midnightpassport.com](https://template.midnightpassport.com) |
| **App registry** | The \`registry.json\` file that both Passport's app grid and the App Hub fetch. One schema-checked JSON entry per listed app. | Public repository URL to be published — the Hub's "Raise a PR" button lights up when it is. |

These deployments will move to \`midnightpassport.com\` subdomains; the Vercel
URLs above remain the live ones today.

## Where to go next

- **New to Passport?** Start with [Onboarding](#onboarding) — creating a
  Passport is one tap.
- **Wallet empty?** [Funding and DUST](#funding) explains NIGHT, DUST, the
  faucet, and sponsored fees.
- **Building an app?** [For developers](#developers) condenses the bridge
  protocols, the quickstart, and how to get listed on the App Hub.
`,
};

/* -------------------------------------------------------------------------- */
/* 2. Onboarding                                                              */
/*                                                                            */
/* Sources: examples/passport-demo/src/screens/Onboarding.tsx (one primary    */
/* action, discoverable-credential path, copy); demo-backend/src/passkey.ts   */
/* (PRF ceremony, one-prompt enrolment, HKDF salt separation);                */
/* examples/passport-demo/src/App.tsx lines 428–470 (session persistence);    */
/* examples/passport-demo/src/screens/Home.tsx (sync strip and ring states);  */
/* examples/passport-demo/src/lib/localWallet.ts (saveSnapshot,               */
/* resumedFromSnapshot); examples/passport-demo/.env.example (first-sync      */
/* measurements, 2026/08/06).                                                 */
/* -------------------------------------------------------------------------- */

const ONBOARDING: DocSection = {
  id: 'onboarding',
  title: 'Onboarding',
  lede: 'One tap to create a Passport; the same tap to come back.',
  markdown: `
## Creating a Passport with one tap

The onboarding screen has **one primary action**: *Continue with Passport*.
If no Passport exists in this browser yet, that tap runs the passkey creation
ceremony — your device shows its own prompt (Face ID, Touch ID, fingerprint, or
PIN), and a passkey is enrolled for this site. If a Passport already exists
here, the same button unlocks it instead. You never choose between "sign up"
and "sign in"; Passport resolves that for you.

There is **no seed phrase**. The wallet seed is derived from the passkey's
WebAuthn **PRF output**, run through HKDF with a dedicated salt. The same PRF
output also derives the key that encrypts Passport's private state — but
through a *different* salt and info prefix, so the two secrets are
cryptographically separated: recovering one tells an attacker nothing about the
other.

Where the platform evaluates the PRF during creation, enrolment alone yields
every secret the profile needs and you see **exactly one prompt**. Most
platforms report only that PRF is enabled at creation, in which case one
assertion follows immediately — still a single, uninterrupted flow with no
password, no download, and nothing to copy anywhere.

## Signing back in

Returning to Passport is the same button. A quiet secondary path — *Use a
different passkey* — runs a **discoverable** WebAuthn assertion with no
allow-list, so your platform shows its own picker of resident passkeys.
Whichever credential you pick signs in to its own profile, or has one created
and bound to it if none exists here yet.

## Session persistence

A signed-in Passport survives a page reload without re-prompting for the
passkey. After sign-in, the wallet seed is wrapped with AES-GCM under a
**non-extractable** \`CryptoKey\` and stored in IndexedDB, scoped per profile;
on load the session is silently unwrapped and the wallet rebuilt. Signing out
clears it.

Passport is honest about what this is: the non-extractable flag prevents
exporting the raw key bytes, but any script running on the same origin could
use the stored key at runtime. It is a demo-grade convenience pending the
private-storage decision — the PRF-derived private-state encryption path
remains gated on a live passkey assertion and is not weakened by it.

## Multi-device reality

Passkeys are **bound to the domain** they were created on (the WebAuthn
relying-party id). A passkey created for one Passport origin does not exist on
another origin, and a Passport wallet is therefore *a wallet on that domain*.
Two consequences:

- If your platform syncs passkeys between your devices (iCloud Keychain,
  Google Password Manager, and similar), the *Use a different passkey* path
  signs you in to the same Passport on another device — discoverable
  credentials are what make that work.
- If the passkey is lost and no other device holds a synced copy, the wallet
  on that domain is lost with it. There is no seed phrase to fall back on —
  that is the trade the passkey model makes. See the
  [FAQ](#reference) for the full statement.

## What the sync percentage means

After sign-in the wallet **walks the chain** to find its funds — that is what
the hairline progress strip under the top bar ("Syncing · N%") shows. The
percentage is the share of the chain walked so far, reported live by the
on-device wallet. While the DUST state is still unknown, the battery ring
doubles as the same gauge in grey; once a real DUST figure exists, the ring
switches to the blue charge display.

Sync state is also **snapshotted**: the wallet persists its progress on first
sync, once a minute while synced, and on close, so the next session resumes
mid-chain instead of starting over.

## Why a brand-new wallet syncs fast on Preview

A cold wallet walks the chain from genesis. On the Preview network that is
short: measured on 2026/08/06, a fresh wallet went from 4% to fully synced in
about **75 seconds**, with the browser tab's memory steady at roughly 90 MB —
Preview's chain was about 296,000 blocks deep at the time. The same walk on
Pre-production (about 1.98 million blocks) is not survivable in a browser tab
today, which is why Passport defaults to Preview — the measured detail is in
[Reference → Networks](#reference).
`,
};

/* -------------------------------------------------------------------------- */
/* 3. Funding and DUST                                                        */
/*                                                                            */
/* Sources: examples/passport-demo/src/lib/networks.ts (faucet URLs, captcha  */
/* rationale, mainnet absence); examples/passport-demo/src/screens/Home.tsx   */
/* (Receive sheet, faucet link, battery states); examples/passport-demo/src/  */
/* lib/localWallet.ts (DUST accrual, subscribeBalances streaming,             */
/* FeeReadiness, NO_DUST_SENTENCE); examples/passport-demo/src/lib/sponsor.ts */
/* (default gateways, on-by-default decision 2026/08/07, available > 0 gate); */
/* examples/passport-funder/src/wallet.ts (registerDustIfNeeded — the service */
/* side); examples/passport-demo/src/screens/SendSheet.tsx (fee line copy).   */
/* -------------------------------------------------------------------------- */

const FUNDING: DocSection = {
  id: 'funding',
  title: 'Funding and DUST',
  lede: 'NIGHT, DUST, the faucet, and who pays the fees.',
  markdown: `
## NIGHT and DUST

**NIGHT** is Midnight's token — the thing you hold and send. Amounts divide
into six decimal places (1 NIGHT = 1,000,000 atomic units).

**DUST** is what pays network fees. It is not bought or transferred in the
ordinary way: DUST **accrues gradually while registered NIGHT is held**. NIGHT
on its own does not generate it — a wallet's NIGHT holdings must be
*registered* for DUST generation first, which is itself one on-chain
transaction.

In Passport that registration is **not something you do**. Fees on the public
networks are sponsored, so a Passport wallet never needs DUST of its own to
transact. Registration is how the *services* pay their own way — see *Who
registers NIGHT, and why* below.

## Getting test NIGHT from the faucet

The flow is deliberately manual, and honest about why:

1. Open **Receive** (or the address pill in the top bar) — this is the address
   sheet, with a copy button per address and the faucet link beside them.
2. Copy your **unshielded** address.
3. Tap **Get test NIGHT** — it opens the network's public faucet
   (\`faucet.preview.midnight.network\` or
   \`faucet.preprod.midnight.network\`) in a new tab.
4. Complete the captcha there and request funds.
5. Come back to Passport. **The balance arrives live, without a refresh** —
   the wallet streams its balances, so incoming funds appear on their own.

There is no in-app "get funds" button on purpose: the faucet's drip endpoint
requires a captcha token from a Cloudflare Turnstile challenge, so no in-app
code can honestly obtain one. Mainnet has no faucet and never will — on
mainnet the button simply is not there.

## The DUST battery

The **DUST battery** card on Home reports what this wallet holds. It is a
readout, not a control — there is nothing on it to press:

- The ring is a **battery gauge**: blue when it shows a real DUST charge, grey
  while it is still a sync gauge, with word states — *Syncing*, *Unknown*,
  *No charge* — when there is no figure to draw.
- *"No DUST yet — DUST pays transaction fees"* means the wallet has no DUST
  coins. On a sponsored network that is not a problem to solve: the sponsor
  pays, and nothing about the wallet needs changing.
- *"Empty — DUST accrues while NIGHT is held"* means DUST generation is under
  way and the charge is building. The cap line ("Cap … · charging") shows the
  maximum the battery can hold.

## Who registers NIGHT, and why

DUST generation against registered NIGHT is real, and it is how the **services
behind the demo pay their own way** — an operational concern, not a user step:

- The **fee sponsor** holds DUST and attaches it to transactions users sign.
- The **funder service** registers its own NIGHT for DUST generation on start
  (\`examples/passport-funder/src/wallet.ts\`, \`registerDustIfNeeded\`) so its
  service wallet can pay for the transfers it makes. That is the reference
  implementation of the registration transaction, measured end-to-end against
  a localnet on 2026/08/06: registering two NIGHT UTxOs yielded a spendable
  DUST balance about nine seconds later, and the transfer that followed paid
  its own fee.

Passport's own passkey wallet had a *Register DUST* control until the
wallet-core review removed it: with fees sponsored, it asked the user to spend
a transaction on something that bought them nothing.

## Sponsored fees

A fresh passkey wallet holds no DUST, so without help its first transaction
would be impossible. Passport therefore ships with **sponsored fees on by
default** (decided 2026/08/07): each public network has a default ProofStation
gateway — \`api-preview.1am.xyz\` for Preview, \`api-preprod.1am.xyz\` for
Pre-production — and \`VITE_SPONSOR_URL=off\` disables sponsorship outright.

How it works, and what it never touches:

- The sponsor owns DUST and nothing else. You build, prove, and **sign** the
  transaction yourself; the sponsor adds its own DUST fee input to the signed
  transaction and hands it back for *your* wallet to submit. **The user still
  signs everything** — sponsorship removes the cost, not the approval.
- The client gates on the sponsor service's own report of a wallet with
  \`available > 0\`, never on a hopeful assumption.
- The Send sheet's fee line quotes the prediction as a prediction: *"Network
  fee **expected to be covered** by the fee sponsor."* — because a sponsor can
  drain between the quote and the submit, the quote is re-read immediately
  before submitting, and a changed answer stops the send until you confirm
  against the new sentence.
- If the sponsor is unreachable or cannot pay, the transaction **falls back to
  your own DUST**, and the fee line says so. Nothing in Passport promises a
  free transaction; a fee is only ever reported as covered when the sponsor
  genuinely covered it.
`,
};

/* -------------------------------------------------------------------------- */
/* 4. Using Passport                                                          */
/*                                                                            */
/* Sources: examples/passport-demo/src/screens/SendSheet.tsx (recipient       */
/* validation, amount arithmetic, fee states, re-read before submit);         */
/* examples/passport-demo/src/screens/AliasClaim.tsx and                      */
/* src/identity/midnames.ts usage (two transactions, phases, queueing);       */
/* examples/passport-demo/src/lib/passkeyPresence.ts and src/App.tsx          */
/* (~line 3815) (per-transaction WebAuthn approval);                          */
/* examples/passport-app-template/docs/PROTOCOL.md (approval sheet contents, */
/* submitted-not-final); examples/passport-demo/src/lib/networks.ts           */
/* (explorer URL shape, hash-not-identifier).                                 */
/* -------------------------------------------------------------------------- */

const USING: DocSection = {
  id: 'using',
  title: 'Using Passport',
  lede: 'Send and receive, .night names, connected apps, and the explorer.',
  markdown: `
## Sending NIGHT

The Send sheet describes only things that will actually happen:

- **Recipient validation** uses the Midnight wallet SDK's own address codec,
  so refusals are the wallet's own taxonomy — including the network the
  address belongs to — rather than a regular expression's guess.
- **Amounts** are converted to atomic units by string arithmetic, never
  through a float: 0.000001 NIGHT is exactly one atomic unit.
- **The fee line is honest about who pays.** Three states:
  *"Network fee expected to be covered by the fee sponsor."* (a sponsor
  answered and can pay), *"Network fee paid from your DUST (… DUST
  available)."* (no sponsor, but the wallet can pay its own fee), or the
  wallet's own refusal sentence when there is no DUST to pay with — in which
  case the send is blocked rather than allowed to fail. When a configured
  sponsor is unavailable, the reason is appended instead of being hidden.
- The fee quote is **re-read immediately before submitting**; a changed answer
  stops the send until you confirm against the new sentence.
- Success is only reported once the node has returned a transaction id.

## Receiving

Receive opens the address sheet: your unshielded, shielded, and DUST addresses
with copy buttons, and the faucet link beside them on networks that have one.
These are public receiving addresses — never the keys behind them.

## Claiming a .night name

A Passport alias *is* a Midnames \`.night\` name, so everything on the claim
screen is a statement about the real registry:

- **Availability** is probed live against the deployed \`.night\` registry as
  you type (debounced).
- **The cost shown** is the deployed contract's own price for the length you
  typed (its \`COST_SHORT\` / \`COST_MED\` / \`COST_LONG\` constants).
- **Claiming is two real transactions**: Passport first deploys your name's
  resolver, then calls the registry's \`register_domain_for\` — the two
  transaction ids that come back are real and shown.
- The progress copy tracks those phases: *"Deploying your name's resolver…"*,
  *"Registering …"*, then *"Waiting for the registry to confirm…"* —
  **"awaiting the registry"** means both transactions are submitted and
  Passport is waiting for the registry to reflect the registration before
  calling the name yours.
- When the registry cannot be reached, the wallet cannot pay, or the selected
  network does not support registration, the screen says exactly that and
  offers to **queue** the name. A queued name is never shown as registered.

## The Apps page and the in-app browser

The Apps grid lists applications from the public registry — the same
\`registry.json\` the App Hub renders. Opening one loads it in Passport's
**in-app browser**, framed on Passport's own surface. Apps talk to Passport
over a strict message bridge (see [For developers](#developers)); they never
touch the wallet.

Two consent surfaces protect you:

- **The profile consent sheet** shows the app's origin and the fields it
  asked for, each with its own toggle, every one unticked by default. You can
  share one field of two; the app is told plainly what was not shared.
- **The transaction approval sheet** shows the recipient, the amount, and the
  app's stated purpose, plus the fee line. Approving it triggers the
  **fingerprint approval**: a user-verified WebAuthn assertion — Touch ID,
  fingerprint, or device PIN — runs **before anything signs**, every time.
  The assertion's result is discarded; its only outcome is "the user
  verified" or a typed refusal, and a refusal aborts before anything is
  signed or sent. Exactly one ceremony per approved action.

## Explorer links

Transaction links point at the **1AM explorer**
(\`explorer.1am.xyz/tx/{hash}?network=preview\`), which serves every network
from one origin. The link needs the 32-byte ledger transaction **hash** — the
33-byte transaction *identifier* some APIs answer with resolves nowhere, so
Passport reports the hash. Where a network has no explorer entry, Passport
renders no link rather than a link that goes nowhere.

One honesty note: a success toast can appear **before the transaction is
final**. "Submitted" means the node accepted it — at the node, not final. The
explorer is where inclusion becomes visible.
`,
};

/* -------------------------------------------------------------------------- */
/* 5. For developers                                                          */
/*                                                                            */
/* Sources (condensed, numbers and codes kept exact):                         */
/* examples/passport-app-template/docs/PROTOCOL.md,                           */
/* examples/passport-app-template/docs/QUICKSTART.md,                         */
/* examples/passport-app-template/docs/TROUBLESHOOTING.md, and                */
/* examples/passport-app-template/CLAUDE.md.                                  */
/* -------------------------------------------------------------------------- */

const DEVELOPERS: DocSection = {
  id: 'developers',
  title: 'For developers',
  lede: 'The bridge protocols, the template quickstart, and getting listed.',
  markdown: `
## The bridge, in one paragraph

Third-party apps talk to Passport over **plain \`postMessage\` to one pinned
origin** — no injected provider, no SDK import, no REST endpoints. No keys,
seeds, passkeys, or signatures ever cross the bridge, in either direction, in
any mode. Two protocols make up the whole surface:

| Protocol | Identifier | Purpose |
| --- | --- | --- |
| Profile | \`org.midnight.passport.profile/v1\` | Ask the user for profile fields, with per-field consent. |
| Transactions | \`org.midnight.passport.tx/v1\` | Ask Passport to make an unshielded NIGHT transfer. |

## Transport rules (both protocols)

1. **Origin pinning.** Every message is posted to one exact origin — never
   \`'*'\` — and every inbound message from any other origin is dropped
   before it is parsed.
2. **Request binding.** Every reply echoes the \`requestId\` and \`nonce\` of
   the request it answers. Nonces are unguessable random bytes.
3. **Strict parsing.** Parsers return \`null\` for anything that is not
   exactly well formed; every string on the wire is length-capped. A request
   that does not parse gets **no reply at all** — what you observe is your own
   timeout.
4. **Unknown message types are dropped harmlessly.**

## The six messages

| Message | Direction | Purpose |
| --- | --- | --- |
| \`passport.profile.ready\` | Passport → app | Handshake: carries/echoes \`{requestId, nonce}\`. |
| \`passport.profile.request\` | app → Passport | \`fields\`: non-empty, duplicate-free subset of \`displayName\`, \`passportContract\`, \`midnightAddresses\`. |
| \`passport.profile.response\` | Passport → app | \`approved: true\` + \`profile\` (only approved fields), or \`approved: false\` + \`error\`. |
| \`passport.tx.request\` | app → Passport | \`intent\`: \`{ kind: 'unshielded-transfer', recipientAddress (≤200), amount (base-10 string, 1–20 digits, > 0), purpose (≤140) }\`. Both channels — posted to the Passport frame when embedded, or to a Passport popup opened on \`passportTxRequestId\`/\`passportTxNonce\` when standalone. |
| \`passport.tx.response\` | Passport → app | \`status\`: \`submitted\` (always with \`txId\`) \\| \`declined\` \\| \`failed\` (with \`error\`); optional \`detail\` (≤400), \`sponsored\`, \`feeNote\` (≤140). |
| \`passport.incentive.report\` | app → Passport | Fire-and-forget: \`{ id (≤256), label (≤80), txId? }\`. No reply. |

Caps worth memorising: ids and nonces ≤ 256; profile strings ≤ 256, profile
addresses ≤ 512; \`amount\` is a **string** of atomic NIGHT
(1 NIGHT = 1,000,000), never a JSON number.

## Embedded versus standalone

Mode detection is one comparison: \`window.parent !== window\`.

| | Embedded (normal case) | Standalone |
| --- | --- | --- |
| Topology | Passport frames the app in its in-app browser; Passport is \`window.parent\`. | App opens Passport as a popup. |
| Handshake pair | **Passport mints it**, posts \`ready\` down, re-broadcasts every 800 ms (capped at 40 attempts, ~32 s) until the frame speaks. The app must echo that exact pair. | **The app mints it** and hands it over as URL query parameters; Passport echoes it back in \`ready\`. |
| Ack | Answer \`ready\` with any message (the template posts \`passport.profile.hello\`) to stop the re-broadcast and clear Passport's "not responding" hint. | Not applicable. |
| Profile consent | **Per-field**: a toggle per requested field, each unticked by default. Any subset may come back. | **All-or-nothing**: the requested set is approved or declined as a whole. |
| Transaction bridge | Available, posted to \`window.parent\`. | Available, over a Passport popup. Same messages, same replies, same approval sheet. |
| Popup launch contract | Not applicable. | One surface per window load, chosen by the query parameters: \`passportRequestId\`/\`passportNonce\` for the profile exchange, \`passportTxRequestId\`/\`passportTxNonce\` for the payment. Both surfaces announce with \`ready\`, so the **pair** is what says which exchange is being answered. |
| Popup management | Not applicable. | Poll \`popup.closed\` every 500 ms; 180 s overall timeout. One window name for both exchanges, so the payment reuses the window the user connected with. |

The payment exchange budgets **180 s** — Passport proves, signs, and submits
before it answers, so the wait is long by web standards, and a timeout does
not guarantee the transaction failed.

## Error vocabularies

Profile (\`passport.profile.response\`):

| Code | Meaning |
| --- | --- |
| \`denied\` | The user refused on Passport's consent sheet. |
| \`profile_unavailable\` | Passport has no profile to share yet. |
| \`invalid_request\` | A consent sheet was already open for this app. |

Transactions (\`passport.tx.response\`):

| Code | Meaning |
| --- | --- |
| \`declined\` | Refused on the approval sheet. Nothing was signed. |
| \`insufficient-funds\` | The wallet cannot cover it — short of NIGHT, or of the DUST that pays the network fee. |
| \`wallet-unavailable\` | No Passport wallet that can sign is open. |
| \`invalid-request\` | A sheet was already open, or the recipient is not a valid unshielded address. |
| \`network-mismatch\` | The recipient address belongs to a different network from the Passport wallet. |
| \`submit-failed\` | Signed, but the node rejected it or was unreachable. |

Map every code to a plain sentence; never show a bare code. Show Passport's
\`detail\` sentence (≤ 400 chars) verbatim alongside your own copy.

## Quickstart with the template

1. Copy the [app template](https://template.midnightpassport.com),
   then \`npm install && npm run dev\` — it runs on
   **http://localhost:5178**, pinned with \`strictPort\`. Passport frames your
   app by URL, and a dev server that quietly moves ports is a handshake that
   quietly stops working.
2. Run Passport (from its own repository) on **http://localhost:5175**.
   **5175 is not a suggestion**: Passport's dev build redirects any other
   local origin there and pins the port with \`strictPort\`. Start Passport
   first, and leave 5175 to it.
3. Point Passport's app grid at your app by starting Passport with
   \`VITE_LOCAL_APP_URL=http://localhost:5178 npm run demo\`. Add
   \`VITE_LOCAL_APP_NAME="My App"\` to label it; the entry is prepended to
   the fetched registry, not swapped in for it.
4. In Passport: create a passkey, open the apps grid, and tap your entry. The
   handshake arrives on its own; tap Connect and approve fields on Passport's
   consent sheet.

Standalone mode needs only \`VITE_PASSPORT_ORIGIN\` (default
\`http://localhost:5175\`) — but remember its limits: all-or-nothing consent,
and no transaction bridge.

## The payment truth

State it exactly this way: the amount is paid **in NIGHT, by the user's own
Passport wallet**, after the user approves on Passport's sheet. The network
fee is **either covered by a sponsor** (\`sponsored: true\` on the reply, and
only then) **or paid from the user's DUST**. A wallet with NIGHT that reaches
neither — no sponsor, and no DUST of its own — still gets
\`insufficient-funds\` — that is designed behaviour. \`submitted\` means *at
the node*, not *final*. Nothing here is free, and no copy may say it is.

## Getting listed on the App Hub

The App Hub renders the app registry's \`registry.json\` — the same file
Passport's own app grid fetches — so listing is **one pull request** against
the registry repository:

1. Fork the registry repository, add **one entry** to the \`apps\` array in
   \`registry.json\`, and open a pull request. Hackathon apps set
   \`"section": "hackathon"\`; entries without a section belong to the
   standard list.
2. CI schema-checks the entry with the registry's dependency-free
   \`validate.js\` (run it locally first: \`node validate.js\`, no install).
3. A maintainer reviews by hand and merges; the Hub and Passport's grid pick
   the entry up on their next fetch.

Required fields: \`id\` (unique, \`^[a-z0-9-]{1,32}$\`), \`name\` (≤ 40
chars), \`description\` (≤ 120 chars, honest), \`icon\` (absolute \`https\`
URL, 128×128 PNG or SVG, ≤ 50KB), \`url\` (absolute \`https\`, live),
\`category\` (one of \`defi\`, \`gaming\`, \`tools\`, \`identity\`,
\`other\`), and \`networks\` (non-empty subset of \`preview\`, \`preprod\`,
\`mainnet\`). Optional: \`new\` and \`immersive\`; **never set \`featured\`**
— it is maintainers-only. The registry refuses \`http:\` entries outright — a
listing is not an audit, and listed applications remain their authors'
property.
`,
};

/* -------------------------------------------------------------------------- */
/* 6. Reference                                                               */
/*                                                                            */
/* Sources: examples/passport-demo/src/lib/networks.ts (networks, faucets,    */
/* explorer, CLAIMABLE_NETWORKS); examples/passport-demo/.env.example         */
/* (endpoints, preprod first-sync measurements 2026/08/06, depth guard);      */
/* examples/passport-demo/src/lib/sponsor.ts (gateways);                      */
/* examples/passport-demo/src/lib/localWallet.ts (SendNightErrorCode);       */
/* examples/passport-app-template/docs/PROTOCOL.md                            */
/* (bridge error codes); examples/passport-demo/src/lib/passkeyPresence.ts    */
/* (approval failure codes); examples/passport-app-template/docs/             */
/* TROUBLESHOOTING.md (explorer hash note).                                   */
/* -------------------------------------------------------------------------- */

const REFERENCE: DocSection = {
  id: 'reference',
  title: 'Reference',
  lede: 'Networks, endpoints, error vocabularies, and the FAQ.',
  markdown: `
## Networks

| Network | Status in Passport |
| --- | --- |
| **Preview** | The default. Wallet signs here, names register here, faucet and explorer both live. A fresh wallet's first sync completes in about 75 s (measured 2026/08/06, chain ~296k blocks). |
| **Pre-production** | Exists and is selectable, and every endpoint is healthy — but a fresh browser wallet **cannot complete a first sync** there. A cold wallet walks the chain from genesis, and preprod is ~1.98M blocks deep: measured 2026/08/06, the walk reached 3% after 150 s with the tab's memory climbing ~25 MB/s until the tab crashed at ~4.2 GB. Starting a new wallet at the chain tip was ruled out the same day — the ledger's commitment trees must be filled from genesis in index order, and the public indexer serves nothing that can fast-forward them. Passport now refuses a from-genesis walk above 500,000 blocks with an honest error instead of starting one and killing the tab. |
| **Mainnet** | Name registration is deliberately not supported: a registration is a paid transaction, and a demo wallet whose seed comes from a browser passkey has no business spending real NIGHT. A name chosen for mainnet is queued, with that reason shown. Mainnet has no faucet, and no explorer link is emitted for it. |

## Endpoints

| Service | Preview | Pre-production |
| --- | --- | --- |
| Indexer (GraphQL) | \`https://indexer.preview.midnight.network/api/v4/graphql\` | \`https://indexer.preprod.midnight.network/api/v4/graphql\` |
| Node RPC | \`https://rpc.preview.midnight.network\` | \`https://rpc.preprod.midnight.network\` |
| Proof server | \`https://proof-server.preview.midnight.network\` | \`https://proof-server.preprod.midnight.network\` |
| Faucet | \`https://faucet.preview.midnight.network\` | \`https://faucet.preprod.midnight.network\` |
| Explorer | \`https://explorer.1am.xyz\` (\`/tx/{hash}?network=preview\`) | \`https://explorer.1am.xyz\` (\`/tx/{hash}?network=preprod\`) |
| Fee sponsor gateway | \`https://api-preview.1am.xyz\` | \`https://api-preprod.1am.xyz\` |

Mainnet has no faucet; its explorer entry is omitted until a link to it has
been seen to resolve. The explorer's \`/tx/{hash}\` route takes the 32-byte
ledger transaction **hash**, never the 33-byte identifier the node's submit
call answers with.

## Error vocabularies

**Sending NIGHT** (\`SendNightError\`, thrown by the wallet's own send path):

| Code | Meaning |
| --- | --- |
| \`invalid-recipient\` | The recipient does not decode as an unshielded address. |
| \`wrong-network\` | The recipient belongs to a different network from this wallet. |
| \`insufficient-night\` | The wallet cannot cover the amount. |
| \`insufficient-dust\` | Nothing can pay the network fee. |
| \`proving-failed\` | The proof could not be computed. |
| \`submit-rejected\` | The node rejected the transaction or was unreachable. |
| \`wallet-closed\` | The wallet session closed before it could sign. |

**Bridge transactions** (\`passport.tx.response\`, what a connected app sees):

| Code | Meaning |
| --- | --- |
| \`declined\` | Refused on the approval sheet. Nothing was signed. |
| \`insufficient-funds\` | Short of NIGHT, or of the DUST that pays the fee. |
| \`wallet-unavailable\` | No Passport wallet that can sign is open. |
| \`invalid-request\` | A sheet was already open, or the recipient is invalid. |
| \`network-mismatch\` | Recipient on a different network from the wallet. |
| \`submit-failed\` | Signed, but the node rejected it or was unreachable. |

**Transaction approval** (the fingerprint ceremony):

| Code | Meaning |
| --- | --- |
| \`approval-cancelled\` | The verification sheet was declined — nothing was signed or sent. |
| \`presence-unavailable\` | The session's passkey cannot be asserted at all — sign in again, then retry. |

## FAQ

**What happens if I lose my passkey?**
The wallet's seed is derived from the passkey, and passkeys are bound to the
domain they were created on. If the passkey is gone and no other device holds
a platform-synced copy of it, the wallet on that domain is lost — there is no
seed phrase to recover from. If your platform does sync passkeys, signing in
on another device via *Use a different passkey* reaches the same Passport.

**Why did a success toast appear before the explorer shows my transaction?**
"Submitted" means the node returned a transaction id — *at the node, not
final*. The toast reports submission honestly; inclusion becomes visible on
the explorer shortly after.

**Why does the explorer link 404?**
It should not, from Passport — Passport links the 32-byte ledger transaction
hash. If you are building a link yourself, note that the 33-byte transaction
*identifier* some APIs answer with resolves nowhere on the explorer.

**Why can I not switch my wallet to Pre-production?**
The network switcher changes the network *context* (which apps are shown,
which faucet is linked); the wallet itself signs on the network the build was
configured for. A fresh browser wallet also cannot complete a first sync on
preprod today — see [Networks](#reference) above for the measurements.

**I have NIGHT but my transaction says it cannot pay the fee. Why?**
Fees are paid in DUST, not NIGHT, and they are normally covered by the fee
sponsor. That message means no sponsor is covering this one — it is off,
unreachable, or out of DUST — and your wallet holds no DUST of its own to fall
back on. The fee line names the sponsor's own reason where it gave one.

**Is a sponsored transaction free?**
The *network fee* is covered when — and only when — the sponsor genuinely
attached its fee input to your signed transaction. Any NIGHT the transaction
itself moves still comes from your wallet, and you still sign and approve
everything yourself.

**Does Passport work offline?**
The installable shell loads offline, but authentication, wallet
synchronisation, proof generation, and transaction submission are never
cached, queued, or presented as available offline.
`,
};

export const SECTIONS: readonly DocSection[] = [
  WELCOME,
  ONBOARDING,
  FUNDING,
  USING,
  DEVELOPERS,
  REFERENCE,
];

/**
 * The whole documentation as one clean markdown document — the "Copy for AI"
 * payload and the `/llms.txt` body. Title first, then every section under a
 * `#` heading, separated by rules.
 */
export function docsAsMarkdown(): string {
  const header = `# ${DOCS_TITLE}\n\n> Midnight Passport is a passkey-first wallet and identity layer for the Midnight network. This document is the full documentation, generated from the same source as the site at docs.midnightpassport.com.`;
  const body = SECTIONS.map(
    (section) => `# ${section.title}\n${section.markdown.trim()}`,
  ).join('\n\n---\n\n');
  return `${header}\n\n---\n\n${body}\n`;
}
