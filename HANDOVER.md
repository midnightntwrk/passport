# Passport SDK work stream — handover branch

Extracted on 2026/07/29 from PR #105 (`demo/passport-full-flow`, commit `257f2d6`), per the
check-in agreement that the SDK and the demo are separate work streams. This branch carries the
library work stream so it can be taken forward in its own repository, with its own guidelines.

## Contents

- `sdk/` — the `@midnight-ntwrk/passport-sdk` workspace, verbatim: `encoding`, `types`, `store`
  (encrypted private state over IndexedDB with a WebAuthn PRF key), `passkey`, `injection`,
  `profile` (the cross-origin profile protocol), and `signet` (the Sig.Network protocol adapter),
  plus the four test suites.
- `docs/sdk/` — the library-stream documents: `architecture.md`, `roadmap.md`,
  `signet-integration.md`, and `README.md`.
- `handover/` — two demo-repo artefacts whose content belongs to this stream if wanted:
  `SdkPage.tsx` (the SDK architecture explainer page removed from the demo) and
  `passport-sdk-architecture.png`.

## What stays behind in the demo

The demo keeps private copies of the six modules it is load-bearing on (`encoding`, `types`,
`store`, `passkey`, `injection`, `profile`) inside a private `demo-backend/` workspace — framed
as the demo backend, not as a library, per the check-in. Divergence from this branch is expected
and fine: this branch is the product-surface lineage, the demo copy is disposable.

`signet.ts`, its tests, and `signet-integration.md` exist only here — the demo does not use them.
