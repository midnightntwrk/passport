# Midnight Passport PWA Feasibility

Date: 2026-07-23
Scope: issue [#102](https://github.com/midnightntwrk/passport/issues/102), using
`examples/passport-demo`

## Recommendation

**Conditional GO for a testnet prototype and supervised mobile pilot. NO-GO for
using the PWA as the only production Passport client today.**

The web platform can install and run the Passport UI, protect a small encrypted
private-state envelope in IndexedDB, and invoke foreground WebAuthn and Dynamic
wallet operations. The production blockers are recovery from browser storage
loss, real-device PRF/authenticator coverage, installed-mode Dynamic OAuth
validation, and reliable foreground-only handling of long proof operations.

## Prototype Evidence

| Area | Result | Evidence |
| --- | --- | --- |
| Installability | Implemented | Manifest has stable `id`, `/` scope/start URL, standalone display, 192px/512px icons, maskable icon, and Apple touch icon. |
| Mobile shell | Implemented | Safe-area metadata, standalone metadata, responsive existing Passport UI, and current official Midnight symbol assets. |
| Service worker | Implemented | Root-scoped worker caches same-origin shell/static assets only. Cross-origin and `/api/` requests bypass it. |
| Offline behavior | Implemented | Navigation falls back to a dedicated offline screen. Auth, wallet sync, proofs, and transactions are explicitly network-only and are never queued. |
| Install/update UX | Implemented | Chromium install prompt is exposed when available; a waiting worker requires an explicit update action. iOS relies on system Add to Home Screen. |
| Private state | Existing and tested | AES-GCM envelope in IndexedDB; PRF-derived non-exportable key and plaintext exist in memory only. |
| Storage durability | Partially implemented | Passport key setup requests `navigator.storage.persist()`. Browser approval is not guaranteed and explicit site-data deletion still wins. |
| Dynamic C1 deployment | Externally blocked | Dynamic's public Midnight API supports wallet transfers, but does not currently expose the arbitrary Compact `UnboundTransaction` proof/finalization boundary required by Passport C1. See issue #101. |
| Dependency audit | Externally blocked | `npm audit --omit=dev` on Dynamic 4.93.1 reports 20 transitive production-tree advisories (14 moderate, 6 high). npm only offers forced Dynamic downgrades that predate the required WaaS integration. |
| Automated checks | Passed locally | SDK unit tests, C1 draft test, production build, and `check:pwa` manifest/service-worker boundary checks. |
| Mobile payload | Needs optimization | Current build emits a 5.86 MB JavaScript chunk (954 KB gzip), 10.42 MB ledger WASM (4.68 MB gzip), and 1.40 MB runtime WASM (411 KB gzip). |
| Physical devices | Not yet executed | iPhone/iPad, Android, and desktop Safari/Firefox matrices remain release-gate tests. |

The installability requirements used here follow the current
[PWA installability guidance](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable):
a manifest, 192px and 512px icons for Chromium, a start URL, display mode, and
HTTPS or localhost.

## Platform Assessment

| Platform | Assessment | Required validation |
| --- | --- | --- |
| Android Chrome/Edge/Samsung Internet | Best initial PWA target. Manifest installation and `beforeinstallprompt` are supported. | Install, Dynamic Discord/email login, embedded wallet return, platform passkey PRF, app restart, storage pressure, and interrupted proof. |
| iOS/iPadOS | Viable pilot with higher risk. Installation is through the Share menu; `beforeinstallprompt` is not available. Home Screen apps run standalone. Safari 18 added WebAuthn PRF support. | Safari and installed-mode OAuth return, Face ID passkey PRF, hardware-key behavior, process termination, device reboot, eviction, and app removal/reinstall. |
| Desktop Chromium | Suitable for development and fallback access. Manifest install and service workers are supported. | Install/update lifecycle, platform passkey, external security key, multi-tab update, and offline fallback. |
| macOS Safari | Add to Dock is available on Safari 17+; Safari 18 added PRF. | Touch ID PRF, Dynamic popup/redirect, update lifecycle, and cross-browser credential use. |
| Desktop Firefox | The web client remains usable, but Firefox does not provide manifest-based desktop PWA installation. | WebAuthn PRF and normal browser-mode operation; do not promise installability. |

Sources:
[installation support](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable),
[iOS Home Screen web apps](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/),
and [Safari 18 WebAuthn PRF](https://webkit.org/blog/15865/webkit-features-in-safari-18-0/).

## Passport Process Fit

### IndexedDB and encrypted state

The SDK stores only a versioned AES-GCM envelope. Authenticated encryption is
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

### WebAuthn, PRF, and passkeys

WebAuthn requires HTTPS and binds credentials to the relying-party domain. The
SDK requests the Level 3 `prf` extension and fails closed when registration does
not return `prf.enabled` or unlock does not return a PRF result. The PRF is
appropriate for deriving an encryption key, which is an explicit use case in
the [WebAuthn PRF definition](https://www.w3.org/TR/webauthn-3/#sctn-prf-extension).

Support depends on the browser, OS, authenticator, and credential-sync path.
Platform passkeys and external security keys must be tested separately.
Changing the production RP domain can make existing credentials unusable.

**Production gate:** publish a supported browser/authenticator matrix and a
recovery path for a missing, deleted, or unsupported credential.

### Dynamic OAuth and social login

Dynamic supports social login and both `popup` and `redirect` strategies through
`DynamicContextProvider`. The prototype currently uses `popup`. See
[Dynamic social providers](https://www.dynamic.xyz/docs/overview/social-providers/overview)
and [`DynamicContextProvider` settings](https://www.dynamic.xyz/docs/react/reference/providers/dynamiccontextprovider).

Installed mobile PWAs can move OAuth into a browser-controlled window. Popup
closing, return-to-standalone behavior, cookies, and preserved in-progress state
must be validated with the actual Dynamic environment. If popup proves
unreliable, use Dynamic's documented redirect strategy with an allowlisted
production return URL and restore the pending foreground intent after return.

Dynamic's supported transfer builder does not establish compatibility with an
arbitrary Passport Compact contract call. The PWA cannot call C1 deployment
complete until Dynamic publishes and validates the proof/finalization
capability tracked by issue #101.

**Production gate:** pass Discord and email authentication in browser and
installed mode on iOS and Android without losing the selected Passport account.

### Proof generation and backgrounding

Compact proving, Dynamic approval, and transaction submission are foreground,
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

**Production gate:** split the SDK/portal route from contract/proving modules,
lazy-load proving WASM at the operation boundary, and measure cold/warm startup
and peak memory on representative low- and mid-range phones.

### Service-worker boundary

The worker may:

- cache the static Passport shell, fonts, images, JavaScript, and WASM;
- provide the explicit offline screen;
- activate a reviewed update after user confirmation.

The worker may not:

- cache or synthesize Dynamic/Midnight API responses;
- read Passport IndexedDB private-state records;
- handle passkey prompts or PRF outputs;
- queue proofs, signatures, contract deployments, or transfers;
- show a network operation as successful without a real response.

## Security Risks

1. **XSS remains the highest web-client risk.** Encrypted-at-rest state is
   decrypted in the page for authorized operations. Production needs a strict
   CSP, dependency review, no inline third-party scripts, and sensitive-log
   inspection.
2. **Origin stability is security-critical.** HTTPS origin, Dynamic allowlist,
   WebAuthn RP ID, service-worker scope, and IndexedDB storage must use the final
   production domain.
3. **Storage persistence is not backup.** Explicit clear/uninstall can destroy
   the envelope. The UI must communicate recovery status before value is placed
   under Passport control.
4. **Cached code is privileged code.** Updates should remain prompt-based, old
   Passport caches must be scoped by prefix, and deployment must prevent stale
   HTML from loading incompatible state migrations.
5. **No offline transaction queue.** Replaying a stale proof or finalized
   transaction after reconnect requires protocol-level expiry/idempotency, not a
   generic service-worker retry.
6. **Dynamic's transitive dependency audit is not clean.** The current stable
   Midnight integration pulls vulnerable Axios, UUID, and Solana dependency
   ranges. Do not use `npm audit fix --force`: its proposed downgrade removes
   the current embedded-wallet surface. Dynamic must publish a compatible
   patched dependency graph, followed by a new integration and bundle audit.

## Release Gates

- [ ] Real-device install and relaunch on current iOS/iPadOS and Android.
- [ ] Dynamic Discord and email OAuth in browser and standalone modes.
- [ ] PRF enrollment/unlock with platform passkeys and supported security keys.
- [ ] IndexedDB persistence granted, denied, cleared, and storage-pressure cases.
- [ ] Documented encrypted backup/recovery and account-rebinding flow.
- [ ] C1 proof/deploy interruption and explicit resume across backgrounding.
- [ ] Dynamic arbitrary Compact proof/finalization capability required by issue #101.
- [ ] Dynamic release with a clean or formally accepted production dependency audit.
- [ ] Route-level code splitting and mobile cold-start/memory budgets.
- [ ] Wallet sync, DUST, shielded/unshielded transfer, and chain confirmation.
- [ ] Production HTTPS origin, CSP, Dynamic allowlist, and WebAuthn RP review.
- [ ] Mobile accessibility, safe-area, keyboard, and responsive visual pass.

Until these gates pass, the PWA should be labelled a **testnet prototype**, not
the sole production custody or recovery surface.
