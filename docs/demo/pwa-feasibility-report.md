# Midnight Passport PWA Feasibility

Date: 2026/07/23
Scope: issue [#102](https://github.com/midnightntwrk/passport/issues/102), using
`examples/passport-demo`

## Status — partly superseded, updated 2026/08/22

The Dynamic SDK was removed from the demo on 2026/08/20. Passages here that
described the wallet vendor have been rewritten to match the architecture that
ships; the vendor-specific findings are recorded below rather than deleted,
because they are why the architecture changed.

What this report found on 2026/07/23, and what became of it:

- **Dynamic could not deploy the Passport C1 contract.** Its public Midnight
  API supported wallet transfers but exposed no arbitrary Compact
  `UnboundTransaction` proof/finalization boundary (issue
  [#101](https://github.com/midnightntwrk/passport/issues/101)). This is now
  moot: the wallet is derived from the passkey in the browser and deploys the
  contract itself.
- **Dynamic's production dependency audit was not clean** — 20 transitive
  advisories on 4.93.1, with no non-destructive remedy. Moot with the
  dependency gone.
- **Installed-mode OAuth was an open validation item.** There is no OAuth in
  the flow any more, so the item is closed rather than passed.

Everything else in this report — storage durability, PRF and authenticator
coverage, payload size, backgrounding, the service-worker boundary, and the
recovery gate — still stands and is still the reason the recommendation below
is conditional.

## Recommendation

**Conditional GO for a testnet prototype and supervised mobile pilot. NO-GO for
using the PWA as the only production Passport client today.**

The web platform can install and run the Passport UI, protect a small encrypted
private-state envelope in IndexedDB, and invoke foreground WebAuthn and wallet
operations. The production blockers are recovery from browser storage loss,
real-device PRF/authenticator coverage, and reliable foreground-only handling
of long proof operations.

## Prototype Evidence

| Area | Result | Evidence |
| --- | --- | --- |
| Installability | Implemented | Manifest has stable `id`, `/` scope/start URL, standalone display, 192px/512px icons, maskable icon, and Apple touch icon. |
| Mobile shell | Implemented | Safe-area metadata, standalone metadata, responsive existing Passport UI, and current official Midnight symbol assets. |
| Service worker | Implemented | Root-scoped worker caches same-origin shell/static assets only. Cross-origin and `/api/` requests bypass it. |
| Offline behavior | Implemented | Navigation falls back to a dedicated offline screen. Auth, wallet sync, proofs, and transactions are explicitly network-only and are never queued. |
| Install/update UX | Implemented | Chromium install prompt is exposed when available; a waiting worker requires an explicit update action. iOS relies on system Add to Home Screen. |
| Private state | Existing and tested | AES-GCM envelope in IndexedDB; PRF-derived non-exportable key and plaintext exist in memory only. |
| Separate-app profile request | Implemented | A second origin opens Passport, requests an allowlisted field set with a nonce, receives explicit user consent, and gets only the approved public DTO through an exact-origin `postMessage` response. |
| Storage durability | Partially implemented | Passport key setup requests `navigator.storage.persist()`. Browser approval is not guaranteed and explicit site-data deletion still wins. |
| Account-custody contract deployment | Resolved after this report | Blocked on 2026/07/23 because the wallet vendor exposed no arbitrary Compact proof/finalization boundary (issue #101). The passkey-derived in-browser wallet that replaced it deploys the contract itself, as part of the single name-claim action. |
| Dependency audit | Resolved after this report | The 20 transitive production advisories counted here all came in through the removed vendor SDK. Re-run `npm audit --omit=dev` before quoting a current number. |
| Automated checks | Passed locally | Demo-backend unit tests, C1 draft test, production build, and `check:pwa` manifest/service-worker boundary checks. |
| Mobile payload | Needs optimization | Current build emits a 5.86 MB JavaScript chunk (954 KB gzip), 10.42 MB ledger WASM (4.68 MB gzip), and 1.40 MB runtime WASM (411 KB gzip). |
| Physical devices | Not yet executed | iPhone/iPad, Android, and desktop Safari/Firefox matrices remain release-gate tests. |

The installability requirements used here follow the current
[PWA installability guidance](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable):
a manifest, 192px and 512px icons for Chromium, a start URL, display mode, and
HTTPS or localhost.

## Platform Assessment

| Platform | Assessment | Required validation |
| --- | --- | --- |
| Android Chrome/Edge/Samsung Internet | Best initial PWA target. Manifest installation and `beforeinstallprompt` are supported. | Install, platform passkey PRF enrolment and unlock, wallet open and first sync, app restart, storage pressure, and interrupted proof. |
| iOS/iPadOS | Viable pilot with higher risk. Installation is through the Share menu; `beforeinstallprompt` is not available. Home Screen apps run standalone. Safari 18 added WebAuthn PRF support. | Face ID passkey PRF in Safari and in installed mode, hardware-key behavior, process termination, device reboot, eviction, and app removal/reinstall. |
| Desktop Chromium | Suitable for development and fallback access. Manifest install and service workers are supported. | Install/update lifecycle, platform passkey, external security key, multi-tab update, and offline fallback. |
| macOS Safari | Add to Dock is available on Safari 17+; Safari 18 added PRF. | Touch ID PRF, the popup and URL-callback connector round trips, update lifecycle, and cross-browser credential use. |
| Desktop Firefox | The web client remains usable, but Firefox does not provide manifest-based desktop PWA installation. | WebAuthn PRF and normal browser-mode operation; do not promise installability. |

Sources:
[installation support](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable),
[iOS Home Screen web apps](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/),
and [Safari 18 WebAuthn PRF](https://webkit.org/blog/15865/webkit-features-in-safari-18-0/).

## Passport Process Fit

### IndexedDB and encrypted state

The demo backend stores only a versioned AES-GCM envelope. Authenticated encryption is
scoped by Passport `appId` and account identity. The PRF output is immediately
converted to a non-exportable AES key; decrypted witnesses and key material are
not written to `localStorage`, Cache Storage, or the service worker.

IndexedDB is origin storage. It is best-effort by default. The prototype asks
for persistent storage after key creation, but browsers may deny that request.
Low-storage pressure, explicit site-data clearing, private browsing, or
uninstall/reinstall can still remove state. Browser storage is therefore a
cache of encrypted Passport state, not a complete recovery system. See
[storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
and [`StorageManager.persist()`](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist).

**Production gate:** define a recovery and encrypted-backup design before the
PWA can be the only client. Recovery must not depend on plaintext witness export.

### Separate-application profile sharing

Another web origin cannot read Passport IndexedDB or local storage directly.
The prototype therefore uses a user-mediated opener protocol:

1. the external app opens Passport and waits for a ready message;
2. it sends an allowlisted field request with a request ID and nonce;
3. Passport validates the exact `event.source`, records the requesting origin,
   and shows field-level consent;
4. Passport returns only the approved public DTO to that exact origin.

The protocol never shares the passkey credential reference, PRF material, the
encrypted envelope, a decrypted witness, or a grant secret. The reference
consumers are `examples/passport-profile-client` and, since 2026/08/05,
`examples/raffle-demo`; the protocol schemas and parsers live in
`demo-backend/src/profileProtocol.ts`. The redirect-based variant for phones,
where the opening tab is frequently discarded, is specified in
`examples/passport-demo/src/identity/callbackProtocol.ts` and exercised by
`examples/clubcoin-mock`.

This works while both applications are open, including from cached shells. It
does not bypass browser origin isolation and it is not the private-storage
provider feature. Production still requires request expiry, one-time nonce
tracking across reloads, a reviewed relying-party allowlist, and browser E2E
coverage for denial, popup closure, malformed input, replay, and hostile
origins.

### WebAuthn, PRF, and passkeys

WebAuthn requires HTTPS and binds credentials to the relying-party domain. The
demo backend requests the Level 3 `prf` extension and fails closed when registration does
not return `prf.enabled` or unlock does not return a PRF result. The PRF is
appropriate for deriving an encryption key, which is an explicit use case in
the [WebAuthn PRF definition](https://www.w3.org/TR/webauthn-3/#sctn-prf-extension).

Support depends on the browser, OS, authenticator, and credential-sync path.
Platform passkeys and external security keys must be tested separately.
Changing the production RP domain can make existing credentials unusable.

**Production gate:** publish a supported browser/authenticator matrix and a
recovery path for a missing, deleted, or unsupported credential.

### Sign-in — no OAuth, no hosted round trip

**Updated 2026/08/22.** This section originally assessed the wallet vendor's
social login and its `popup` versus `redirect` strategies. That entire surface
is gone. Sign-in is one WebAuthn ceremony in the tab: no third-party window, no
cookies to survive a return to standalone mode, and no in-progress state to
restore across an origin hop. The class of installed-PWA OAuth risk this
section was written about does not apply to the flow that ships.

What replaces it as the risk to validate is the passkey itself, covered in the
section above: enrolment and unlock on each platform, discoverable-credential
sign-in when the browser holds no local profile, and the consequence of a
changed relying-party domain.

One redirect round trip does remain, but it is between Passport and a
third-party app rather than between Passport and an identity provider: the
URL-callback connector, for phones where the opening tab does not survive. It
carries its reply in the URL fragment, signed with the wallet's unshielded key,
and the receiving app verifies it before believing it.

**Production gate:** passkey sign-in in browser and installed mode on iOS and
Android, including the case where site data was cleared but the credential
survives in the keychain, without enrolling a second credential over the first.

### Proof generation and backgrounding

Compact proving, user approval, and transaction submission are foreground,
network-dependent operations. The service worker does not generate proofs,
store signatures, submit transactions, or register Background Sync.
Background Sync itself is not uniformly available across major browsers, and
service workers are event-driven rather than durable compute processes:
[Background Synchronization API](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API).

The existing demo persists an encrypted C1 draft/finalized transaction so an
interrupted foreground operation can be explicitly resumed. It must never infer
completion after suspension; only a returned hash and independent chain check
can advance the transaction state.

**Production gate:** test lock screen, app switch, OS process termination,
network loss, OAuth interruption, proof timeout, and explicit resume on each
target platform.

### File-system limits

A PWA cannot assume native-style arbitrary filesystem read/write. The
Origin-Private File System is origin-scoped, invisible to the user, quota-bound,
and deleted with site data. User-visible file access has separate permissions
and inconsistent platform support. See
[Origin Private File System](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system).

The current Passport envelope does not require filesystem access; IndexedDB is
the narrower storage primitive. OPFS could later hold large proving artifacts,
but it must not become the only copy of recovery-critical data.

### Payload and cold start

The current Compact/Midnight dependency graph produces a large main JavaScript
chunk and large WASM artifacts. The service worker does not precache those
hashed bundles during installation, so an install is not blocked by downloading
the complete proving stack. They are cached only after the page requests them.
Mobile cold start, memory pressure, and update bandwidth are still material
risks.

**Production gate:** split the portal route from contract/proving modules,
lazy-load proving WASM at the operation boundary, and measure cold/warm startup
and peak memory on representative low- and mid-range phones.

### Service-worker boundary

The worker may:

- cache the static Passport shell, fonts, images, JavaScript, and WASM;
- provide the explicit offline screen;
- activate a reviewed update after user confirmation.

The worker may not:

- cache or synthesize Midnight node, indexer, proof-server, sponsor, or funder
  responses;
- read Passport IndexedDB private-state records;
- handle passkey prompts or PRF outputs;
- queue proofs, signatures, contract deployments, or transfers;
- show a network operation as successful without a real response.

## Security Risks

1. **XSS remains the highest web-client risk.** Encrypted-at-rest state is
   decrypted in the page for authorized operations. Production needs a strict
   CSP, dependency review, no inline third-party scripts, and sensitive-log
   inspection.
2. **Origin stability is security-critical.** HTTPS origin, WebAuthn RP ID,
   service-worker scope, IndexedDB storage, the funder's CORS allowlist, and
   every connector's audience binding must use the final production domain.
3. **Storage persistence is not backup.** Explicit clear/uninstall can destroy
   the envelope. The UI must communicate recovery status before value is placed
   under Passport control.
4. **Cached code is privileged code.** Updates should remain prompt-based, old
   Passport caches must be scoped by prefix, and deployment must prevent stale
   HTML from loading incompatible state migrations.
5. **No offline transaction queue.** Replaying a stale proof or finalized
   transaction after reconnect requires protocol-level expiry/idempotency, not a
   generic service-worker retry.
6. **The dependency graph still needs auditing on its own terms.** The 20
   advisories counted on 2026/07/23 arrived through the removed vendor SDK, so
   that specific finding is closed — but the Midnight and proving dependencies
   that remain have not been re-audited since. Re-run `npm audit --omit=dev`
   and record the result before any production claim; do not quote the old
   number in either direction.

## Release Gates

- [ ] Real-device install and relaunch on current iOS/iPadOS and Android.
- [ ] Passkey sign-in in browser and standalone modes, including the cleared-site-data case.
- [ ] PRF enrollment/unlock with platform passkeys and supported security keys.
- [ ] IndexedDB persistence granted, denied, cleared, and storage-pressure cases.
- [ ] Documented encrypted backup/recovery and account-rebinding flow.
- [ ] Contract deploy and name registration interrupted mid-flight, and resumed or honestly refused, across backgrounding.
- [ ] Behaviour when the fee sponsor is unavailable and when the funder refuses, on a wallet holding nothing.
- [ ] A re-run dependency audit on the post-Dynamic graph.
- [ ] Route-level code splitting and mobile cold-start/memory budgets.
- [ ] Wallet sync, shielded/unshielded transfer, and chain confirmation.
- [ ] Production HTTPS origin, CSP, connector origin allowlists, and WebAuthn RP review.
- [ ] Mobile accessibility, safe-area, keyboard, and responsive visual pass.

Until these gates pass, the PWA should be labelled a **testnet prototype**, not
the sole production custody or recovery surface.
