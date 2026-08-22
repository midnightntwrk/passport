# The Passport demo

Read [`WHAT-THIS-IS.md`](../../WHAT-THIS-IS.md) first — it states what the demo
is, and is not, in the agreed wording.

The Passport demo shows a user creating a passkey, receiving a Midnight wallet
built in that same browser tab, getting an account-custody contract and a
`.night` name in one action, and then transacting and connecting to example
dApps — all against real infrastructure on the Preview network. Nothing in the
wallet flow is mocked. There is no third-party wallet vendor: the Dynamic SDK
was removed on 2026/08/20, and the passkey is the whole of the sign-in.

Two properties are worth stating plainly, because they are what makes the flow
demonstrable at all:

- **The user's wallet never needs to hold anything.** Network fees are
  sponsored, and the `.night` registration is paid for by the funder service,
  which registers the name under the user's own owner key. A wallet holding
  zero NIGHT completes onboarding.
- **The contract comes before the name.** Claiming a name is one user action,
  but on chain it is sequential: the account-custody contract deploys first,
  and the name is then registered pointing at it.

## The pieces and their boundaries

- **The PWA** — [`examples/passport-demo/`](../../examples/passport-demo/) —
  the installable Passport client. Every backend import goes through one seam
  file, `examples/passport-demo/src/backend.ts`, so the engine behind the PWA
  can be replaced behind a single boundary.
- **The demo backend with connectors** — [`demo-backend/`](../../demo-backend/)
  — a private, file-linked workspace holding the encrypted private-state
  store, the WebAuthn PRF key provider, state injection, and the profile and
  transaction wire protocols. It is a prototype for testing integrations,
  expected to change; it is not a product surface.
- **The funder** —
  [`examples/passport-funder/`](../../examples/passport-funder/) — a
  self-hosted service that registers `.night` names for new Passports, paying
  the registry price from its own NIGHT and the fees from its own DUST. It
  stands in for Midnames-side sponsorship until the Midnames team runs their
  own.
- **The example dApps** — [`examples/raffle-demo/`](../../examples/raffle-demo/)
  (profile handshake plus a Passport-signed payment),
  [`examples/passport-app-template/`](../../examples/passport-app-template/)
  (the starter a third-party developer copies), and
  [`examples/clubcoin-mock/`](../../examples/clubcoin-mock/) (the URL-callback
  redirect connector, for the phone case the popup cannot serve). Each runs on
  its own origin, because a handshake with yourself proves nothing.
- **The profile client** —
  [`examples/passport-profile-client/`](../../examples/passport-profile-client/)
  — the original separate-origin consent client ("Atlas"). The raffle replaced
  it in the Apps grid on 2026/08/05; it still runs, and still exercises the
  profile protocol.

The next partner flow, **Otrix** — a totem showing a QR code with a shielded
deposit address, paid from Passport — is not built. ClubCoin is no longer the
partner dApp.

## Documents in this directory

| Document | What it records |
|---|---|
| [`runbook.md`](runbook.md) | How to run the demo end to end, what to walk through, and the result language. |
| [`validation-log.md`](validation-log.md) | Observed results only — no claimed ones. |
| [`pwa-feasibility-report.md`](pwa-feasibility-report.md) | The #102 feasibility deliverable for the installable PWA, dated 2026/07/23 and partly superseded by the removal of Dynamic. |
