# Passkey viewing-key envelope: sizing experiment

**Draft for initial internal review:**
[internal review notes and authority boundaries](DISCUSSION.md).
Review and iteration come before deciding on any wider discussion.
This experiment builds on the P-256/WebAuthn circuits in
[Passport PR #175](https://github.com/midnightntwrk/passport/pull/175).

**Automated localnet result: PASS, 2026/10/01.** B restored from an
empty private store and completed shielded spends before and after viewing-key
rotation, on the same account. This run uses software ES256 credentials and
synthetic PRF outputs; live-browser PRF remains unverified. That run
predates the current codec; see [Evidence and scope](#evidence-and-scope).

**Payload result: 192 bytes per reader per viewing-key generation.** Two
independent readers need 384 bytes; ten need 1,920 bytes. This is the inbox
payload, before ledger serialisation and transaction/proof overhead.

This experiment uses Passport's existing opaque `Bytes<192>` inbox and
`append_inbox_with_p256`. It adds a client-side experimental record format.
The account's existing coin reader skips that format.

## What is being tested?

A creates an account and enrols independent signing credential B. A also
encrypts the random account viewing secret to B's separate reader public
key. Later, a fresh B client retrieves its envelope from the account inbox,
decrypts coin descriptions, reconstructs a commitment position from public
transaction history, and spends with B's enrolled P-256 credential.

An account owner can publish another envelope using B's retained **public**
reader key while B is offline. Signing authority and viewing access are
separate: enrolling a signing key does not deliver the viewing secret.

### Device, dApp, and reader roles

A and B are **ACC devices in this test harness**. Their signing credentials
carry account-control authority. **A connected dApp, such as a wallet
provider, has a different role**: its key represents the dApp/grantee under
a scoped grant authorised by the account, not a device key supplied for the
user's ACC. Connecting that dApp must not implicitly enrol it as an
account-control device.

Viewing-secret delivery is a separate capability. A reader envelope grants
neither device authority nor permission to spend; a dApp's spending must
remain within its grant. The current run tests device restoration and
device-authorised spends, not the dApp connection or grant handover. Its
wire format includes public P-256 **device** registration metadata; a dApp
reader profile and grant-based journey still need design and validation.

### Same passkey? Same account?

Yes, **if that passkey/provider supports WebAuthn PRF**:

1. A PRF evaluation supplies a repeatable secret to the wallet.
2. HKDF derives an account-bound X25519 reader key from that output.
3. X25519 + HKDF + AES-GCM decrypt the account's viewing-secret envelope.
4. The same credential's separate P-256 key signs account operations.

The P-256 private key never becomes a decryption key. Existing ES256
credentials must be tested for PRF support; ES256 support alone is
insufficient. A PRF-capable credential can use the same Passport account.
The experiment deploys one test account and keeps its address and B's
signing key across both restores and viewing-key rotations.

## Evidence and scope

**The published localnet results predate the current codec.** They were
produced with the earlier codec, which used a constant per-reader recipient
tag and accepted the first decryptable envelope. The localnet suite must be
re-run before its figures are quoted. Files changed since that run:
`codec.ts` (per-record recipient tag, newest-first validated selection),
`localnet.ts` (validator-driven selection, candidate-retry classification,
and new `environment`, `deployment`, and `final` evidence fields),
`report.ts`, `browser.ts`, `browser-client.ts`, `offline.ts`, the shared
`src/tests/instrumentation.ts`, and `src/wallet/webauthn.ts`. The offline
results were regenerated with the current codec. Envelope sizes and offsets
are unchanged.

- [Measurement report](../../contract/evidence/inbox-view-envelope/RESULTS.md):
  observed payload, serialised inbox growth, transaction/proof sizes, and
  proving times, with restoration outcomes and measurement boundaries.
- [Offline results](../../contract/evidence/inbox-view-envelope/offline.json):
  independent OpenSSL decryption, every-byte tamper rejection, wrong reader
  and context, poisoned/stale/staged secrets, substituted signing metadata
  (including validator-driven skipping), per-record recipient tags,
  legacy-reader skipping, and compiled P-256 append/rotation calls.
- [Localnet measurements](../../contract/evidence/inbox-view-envelope/published-localnet.json):
  machine-readable verdict, sizes, timings, transaction IDs, and restore
  outcomes. Check its verdict before treating the flow as successful.
- Browser capability probe at **http://localhost:8984**: use the earlier
  Safari credential, reload the page, and then decrypt and sign. Its raw local
  evidence is Git-ignored. This is an off-chain capability probe.
  **No successful real-browser PRF run is included in this experiment yet.**

The localnet suite uses Node/OpenSSL ES256 credentials and independent,
random **synthetic PRF outputs**. These exercise the crypto and actual
on-node proofs but do not establish browser PRF or passkey-sync support.
Fresh clients use empty in-memory private-state providers in the same test
process. A's signing provider is disabled during each B restore; the public
network, prover, and local fee-paying wallet are shared test infrastructure.
This is not yet a separate-machine/browser-to-node integration test.

## Exact experimental layout

Record type `0xe1`, suite `0x01`; neither is an allocated standard identifier.

| Offset | Bytes | Field |
|---:|---:|---|
| 0 | 1 | Experimental version/type |
| 1 | 1 | Suite |
| 2 | 32 | Per-record recipient tag (context, reader, and ephemeral key) |
| 34 | 32 | Ephemeral X25519 public key |
| 66 | 12 | AES-256-GCM nonce |
| 78 | 16 | GCM authentication tag |
| 94 | 32 | Encrypted account viewing secret |
| 126 | 64 | Encrypted **public** ES256 x/y coordinates |
| 190 | 2 | Required zero padding |
| **Total** | **192** | One existing inbox slot |

The public signing coordinates let a fresh client recover registration
metadata, which WebAuthn assertions do not themselves return. They add no
extra inbox slot. The prototype validates the recovered key using a fresh
assertion and the contract's enrolled device entry before spending.

Unlike the earlier research sketch, this layout has no explicit generation
counter or viewing public key: the trusted current on-chain `enc_key`
selects the active secret after decryption. The generation numbers in the
test are labels. Each rotation uses fresh random encryption material;
reusing an old `enc_key` would also make old envelopes eligible again.

### Derivation and binding

See [the executable codec](../../contract/src/tests/inbox-view-envelope/codec.ts).
Its context is UTF-8 JSON of
`["passport:experimental:view-envelope:v1", network, accountHex, rpId, origin]`.
All hex is lowercase, and the account address is 32 bytes.

- PRF input: SHA-256 of the reader-PRF domain string followed by context.
  Supply this to the WebAuthn PRF extension; let the browser perform its
  standard internal domain processing.
- Reader secret: HKDF-SHA-256 of the 32-byte PRF output, context hash as
  salt, reader-key domain string as info, 32-byte output.
- Recipient tag: SHA-256 of recipient-ID domain string, context, reader
  public key, and the record's ephemeral X25519 public key (bytes
  `[34,66)`). The tag therefore differs per record: a chain observer
  cannot link two envelopes for the same reader by tag, while the reader
  recomputes it from its own public key before any X25519 work.
- Wrapping key: HKDF-SHA-256 of the ephemeral-static X25519 shared secret,
  context hash as salt, view-wrap domain string as info, 32-byte output.
- AES-GCM plaintext: 32-byte viewing secret followed by 32-byte big-endian
  public signing x and y coordinates. AAD is context, bytes `[0,78)`, and
  the two trailing padding bytes.

The PRF output and private reader key are never published. Account,
network, RP, and origin mismatches fail decryption. The restored viewing
secret must derive the trusted current `enc_key`; AEAD success alone is
insufficient because anyone can encrypt to a public reader key.

Selection walks the inbox newest-first. A caller-supplied validator (in
the localnet suite, a fresh B assertion verified under the candidate's
signing key) can reject a decryptable envelope that carries the current
viewing secret with substituted signing metadata; that candidate's secret
is zeroed and the walk continues to older records.

## Required bootstrap inputs

A fresh client must have:

- The public account address and network/indexer endpoint.
- The RP ID, enrolled signing origin, and experimental profile.
- A way to select B's credential (the probe supplies its public credential
  ID from earlier registration metadata; discoverable selection is not
  implemented here).
- Access to B's signing authenticator and repeatable PRF evaluation.
- Transaction fee funding; the localnet uses a separate development wallet.

It does not receive A's PRF, A's viewing secret, a saved coin store, a saved
ciphertext copy, or deposit transaction IDs as restore inputs. The localnet
retrieves envelopes and transaction history from the account address.
Account discovery from a passkey alone is outside this experiment.
Fresh signing-client attachment also uses the existing SDK's bounded
device-use-counter rescan (4,096 candidates). These low-counter restores
do not establish recovery of an arbitrarily long-used device's counter.

## Storage, calls, and lifecycle

- `N` readers cost **192 × N** payload bytes per key generation. With the
  existing append API they also require **N authorised append calls**.
- Adding independent B costs one device-enrolment call plus one envelope
  append, assuming A already has its envelope.
- A key rotation costs the new reader envelopes plus one key-rotation call.
  Making old live coins discoverable under the new secret additionally
  requires one 192-byte coin-description backfill per such coin. The
  localnet explicitly tests this with a pre-rotation live coin.
- Old records remain in the append-only inbox. A new current envelope does
  not grant access to all earlier viewing epochs. Historical-key retention
  and a multi-epoch wallet are separate work.
- Excluding B from a fresh viewing generation prevents B from opening that
  new secret. B retains old learned information, and its signing authority
  is unchanged until separately revoked.
- Reader public keys are retained in an explicitly trusted enrolment roster.
  Arbitrary inbox advertisements are not accepted as authenticated roster
  additions. Chain-only reconstruction of the roster is not implemented.
- This test account has no usable recovery wrap. Recovery continuity is not
  established; the existing recovery-wrap refresh requires a guardian
  session and must be coordinated with key rotation.

Serialised ledger growth, full submitted transaction bytes, proof bytes,
proving time, and modelled fees are recorded separately. Ledger state sizes
are serialisation sizes, not physical node database usage. The experiment
also isolates the inbox map in a constant blank `ContractState` frame:
both isolated-inbox and whole-account snapshot sizes can decrease in these
observations despite an appended record. They therefore do not establish a
stable per-record storage-allocation cost. Whole-account snapshots additionally
include changing device entries and storage-usage annotations.
Transaction sizes include DUST funding overhead. Fees use indexed ledger parameters in SPECKs;
they are not a separately measured amount burnt or a currency quotation.

## Reproduce

Use the Compact 0.35 / ledger-v9 toolchain and running local stack in
[the contract guide](../../contract/README.md#running). The generated
52-circuit P-256 account is required for offline simulation and localnet.
Deployment retains the **15,000 verifier-byte per-wave budget**.

From `contract/`:

```sh
npx tsc --noEmit
npm run test:view-envelope-offline

# Set WALLET_SEED for the local development fee payer per contract/README.md.
npm run test:view-envelope
npm run report:view-envelope

# Optional public registration metadata from the earlier browser experiment:
PASSKEY_CREDENTIAL_FILE=evidence/p256-webauthn/run-browser-<uuid>.json \
  npm run test:view-envelope-browser
```

Open `http://localhost:8984` in Safari. Choose **Test existing passkey PRF**,
approve, reload, then **Restore and sign with the same passkey**. The restore
requests separate PRF and ordinary ES256 ceremonies, since the on-chain
`wa-json134` profile requires 37-byte authenticator data without extensions.
The page also allows an explicitly chosen new test credential when checking
provider capabilities. Neither browser route creates a Passport account.

The browser server independently verifies the final ES256 assertion. The
PRF/decryption result is browser-reported; secret output stays in the page.
Reload discards page memory; this tests repeated evaluation on one machine,
not synchronisation or recovery on another machine.

On macOS, `caffeinate -i npm run test:view-envelope` prevents idle sleep
during the run. Earlier development runs exposed two instrumentation API
mismatches (version-tagged transactions and unserialisable `ChargedState`),
a missing private-state scoping method, and a proof request timeout after
long execution pauses. Raw failed runs are retained locally under ignored
`run-localnet-*.json` names. The fresh provider now implements the full SDK
interface; an independent attach against the deployed test account verified
its empty state and the isolated-inbox serialisation before rerunning.

The runner writes ignored `localnet.json`; the report command freezes its
current contents in `published-localnet.json` alongside the rendered report.
An unfinished run is explicitly labelled **PARTIAL**. Only a fully successful
scenario is labelled **PASS**.
