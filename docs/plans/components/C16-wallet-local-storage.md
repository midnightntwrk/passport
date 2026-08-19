# C16 · Wallet local storage

**Serves:** P1 · P3 · P6.

## Outcome

Where the wallet persists private state on the user's device —
per-device key material (no seed exists: C4 and MIP-0013 fix
per-device keys with no derivation tree), the **wallet-local coin
store** that stateless custody makes load-bearing (coin descriptions
exist only here and in the encrypted inbox backup on the contract),
the account encryption secret, sync state, name ownership cache,
recently-issued attestations, arbitrary metadata. Includes the
encryption envelope.

## Dependencies

- **C9** — device-bound auth produces the wrapping key.
- **C5 · C7** — signing and witness flows read from this storage.
- **C17** — sync state lives here.
- **C1** — the account's public state in C1 is operable only while the
  corresponding private state in C16 is available; the binding is not
  verified by Kachina / Compact. See Failure modes.
- **External** — platform-specific TEE / Secure Enclave / StrongBox APIs
  for wrapping-key custody.

## Open questions

**Storage substrate per platform.** Browser: IndexedDB + WebAuthn-derived
encryption key? Native: platform secure storage? Hybrid?

**Sync across devices.** When the user adds a second device, does any
wallet state sync between them, or does each device maintain independent
storage with a shared chain-state-derived view? The latter is simpler
and aligns with P3 (peer-device).

**Backup of wallet state (largely answered by the custody design).**
The coin store reconstructs from the encrypted on-contract inbox plus
chain data, so it needs no backup of its own. The one item that must
survive total loss is the account encryption secret (the viewing
capability that decrypts the inbox); whether it travels inside the
BUSS-recovered material or as a separate paper-key item is C14's open
question. Device keys are deliberately unrecoverable (re-derived from
passkeys or replaced through the device ceremonies).

## Failure modes

**Wrapping-key unavailable.** Platform secure storage rejects key access
(e.g., Touch ID failure mode). *Detection:* wallet fails to decrypt own
storage.

**Sync state inconsistency.** Storage state diverges from chain state;
wallet shows stale info. *Detection:* a chain-state read disagrees with
what the wallet displayed.

**Storage migration failure.** OS or browser update changes storage
substrate; old wallet state inaccessible. *Detection:* version-skew test
on shipped builds.

**Zombie public state on private-state loss.** Kachina / Compact does
not automatically verify the link between a contract's public state
and the user's private state. If C16 is wiped or corrupted, the
account's public state in C1 (and other contracts holding per-account
state) remains on-chain but becomes inoperable — no party can produce
the witnesses needed to interact with it. Users often assume private
state is automatically linked to public state; it is not. *Detection:*
simulate a C16 wipe against a deployed account; confirm whether (and
how) the account can be operated from chain state alone.

## Alternatives

**A — Browser: IndexedDB wrapped by WebAuthn-derived key.** Standard web
pattern.

**B — Platform-native secure storage** (iOS Keychain, Android
EncryptedSharedPreferences with StrongBox).

**C — Hybrid (per-platform optimal substrate).**
