# C9 · Device-bound authentication

**Serves:** P1 · P3 · P6.

## Outcome

How a device proves it is the user's authorised device. Passkey
(WebAuthn) bound to the device's secure boundary. Provides P1
(seedless), P3 (peer-device), P6 (key-bound).

**Status 2026/07 — decided.** The passkey is the device boundary in
both custody models, with two distinct roles:

- **Decentralised path (v1.0 standards target).** A WebAuthn passkey
  with the **PRF extension**: the PRF evaluation deterministically
  derives the device's JubJub keypair on-device. The passkey gates the
  key — no plaintext key material needs to persist in storage (C16
  holds at most wrapped state), and the derived public key registers
  in the account's device set as a MIP-0013 device.
- **Managed path (MVP).** The same passkey authenticates the user to
  the MPC service (OAuth2-shaped flow, WebAuthn assertion — no PRF
  required); the service's committee holds the JubJub threshold-DSA
  (FROST) capability and registers in the account as a single
  threshold device (MIP-0013 section 7). The account contract cannot
  tell the two paths apart — same verification equation.

What remains is support-matrix and fallback policy, not the model.

## Dependencies

- **C5** — the signing key produced (decentralised) or fronted
  (managed) by device-bound auth; the MIP-0013 device set is where both
  register.
- **C8** — the PRF → JubJub scalar derivation needs a registered
  domain-separation tag.
- **C16** — wallet storage holds wrapped state; with PRF derivation no
  plaintext device key needs storing.
- **C1** — device public key registered in the account-custody
  contract.
- **External** — WebAuthn spec (PRF extension), platform TEE /
  StrongBox / Secure Enclave APIs, MPC service provider (managed
  path).

## Open questions

**PRF support matrix and fallback policy.** Which browser × OS ×
authenticator combinations provide PRF, and what is the decentralised
path's behaviour where it is absent — managed path as fallback,
platform-native derivation, or unsupported? Product-owner-signed
matrix still needed. The fallback space is widening upstream: the
proof system's next ZKIR revision adds native secp256r1, which would
make a passkey's ordinary ECDSA-P256 assertion verifiable in-circuit —
a PRF-free candidate fallback worth assessing once the toolchain
exposes it.

**Synced passkeys.** A synced passkey (iCloud Keychain, Google
Password Manager) reproduces the PRF seed on several physical devices,
blurring the device boundary: does one synced passkey constitute one
logical device in the account, or does policy require per-device
credentials? Interacts with P3's peer-device model and MIP-0013's
one-commitment-per-device set.

**Derivation specification.** The PRF → JubJub scalar derivation needs
a specified, domain-separated construction (C8 tag, e.g. under
`midnight:account:*`), and possibly its own MIP — the site's standards
pipeline already notes the passkey-derivation concern as the one
derivation topic not covered upstream by MIP-0003.

**Native app vs browser.** If we ship a mobile native app, does it use
platform WebAuthn or the platform secure enclave directly?

**Hardware-backed external authenticators.** WebAuthn permits external
authenticators (FIDO2 / YubiKey / Ledger) alongside platform passkeys.
First-class device, fallback path, or unsupported? Stakeholders likely
to ask. Note PRF support on external authenticators (hmac-secret) is
its own matrix column.

## Failure modes

**Passkey not recoverable on device loss.** If passkey is not synced,
losing the device loses that device's key — by design recoverable via
`remove_device` from a surviving device or the recovery seam, but a
single-device account falls to total-loss recovery. *Detection:* user
reports of recovery failure tied to passkey absence.

**PRF unavailable.** User's browser / OS does not support PRF; the
decentralised path cannot derive a device key. *Detection:* telemetry
shows PRF failure rate above threshold. *Mitigation:* fallback policy
(open question above).

**PRF output mishandling.** The PRF evaluation (the key seed) leaks
through JS memory, logs, or an exception path before derivation and
zeroisation — the C7 discipline applies to the derivation pipeline.
*Detection:* code review of the derivation path.

**Cross-origin attack.** Passkey scoped wrongly; another origin can
exercise it. *Detection:* security review of WebAuthn `rpId` binding.

**Hardware token gap.** Partners or users who expect FIDO2 / YubiKey /
Ledger cannot onboard with their preferred device. *Detection:*
stakeholder request with no provisioned answer in the spec.

## Alternatives

**A — WebAuthn PRF + assertion fallback.** **Chosen.** PRF evaluation
derives the on-device JubJub keypair (decentralised path); plain
assertion is sufficient where the key lives elsewhere (managed path's
authentication to the MPC service).

**B — WebAuthn assertion only.** Subsumed: it is exactly the managed
path's requirement, but insufficient alone for on-device key
derivation.

**C — Platform-native** (Secure Enclave on iOS, StrongBox on Android,
no WebAuthn). Candidate fallback where PRF is unavailable in native
apps; not the primary model.
