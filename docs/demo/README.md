# The Passport demo

Read [`WHAT-THIS-IS.md`](../../WHAT-THIS-IS.md) first — it states what the demo
is, and is not, in the agreed wording.

The Passport demo shows a user signing in through Dynamic, receiving an
embedded Midnight wallet, deploying a Passport C1 account contract, and
managing custody, permissions, and a consented public profile — all against
real infrastructure on preview/testnet or a disposable localnet. Nothing is
mocked.

## The three components and their boundary

- **The PWA** — [`examples/passport-demo/`](../../examples/passport-demo/) —
  the installable Passport client. Every backend import goes through one seam
  file, `examples/passport-demo/src/backend.ts`, so the engine behind the PWA
  can be replaced behind a single boundary.
- **The demo backend with connectors** — [`demo-backend/`](../../demo-backend/)
  — a private, file-linked workspace holding the encrypted private-state
  store, the WebAuthn PRF key provider, state injection, and the profile
  wire protocol. It is a prototype for testing integrations, expected to
  change; it is not a product surface.
- **The profile client** —
  [`examples/passport-profile-client/`](../../examples/passport-profile-client/)
  — a separate-origin application ("Atlas") that requests public profile
  fields and receives only what the user approves. It shares the profile wire
  protocol with the PWA through the demo backend.

## Documents in this directory

| Document | What it records |
|---|---|
| [`pwa-feasibility-report.md`](pwa-feasibility-report.md) | The #102 feasibility deliverable for the installable PWA. |
| [`runbook.md`](runbook.md) | How to run the demo end to end, and the result language. |
| [`dynamic-capability-matrix.md`](dynamic-capability-matrix.md) | What Dynamic 4.93.1 can and cannot do today. |
| [`blockers.md`](blockers.md) | Current integration boundaries and who owns them. |
| [`validation-log.md`](validation-log.md) | Observed results only — no claimed ones. |
| [`why-passport-needs-a-passkey-with-dynamic.md`](why-passport-needs-a-passkey-with-dynamic.md) | Why the demo derives its private-state key from a passkey. |
