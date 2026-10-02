# P-256 / profiled WebAuthn

Current circuit sizes and proving timings: [P256-MEASUREMENTS.md](P256-MEASUREMENTS.md).

The `p256` account arm verifies ES256 assertions in Compact 0.35.0,
runtime 0.20.0, ZKIR 3.1. It shares the custody, grant-scope and recovery
mutation chips with the JubJub and secp256k1 arms. The account roster is
**52 circuits**: four shared and sixteen per credential arm.
The 15,000-verifier-byte planner packs it into ten waves for any initial
arm. All 36 pre-existing circuits retain byte-identical ZKIR and verifier
keys relative to the merged Compact-0.35 build.

## Supported profile: `wa-json134`

This tranche implements the explicitly selected **fixed-profile** scope.
The accepted `clientDataJSON` is exactly 134 bytes:

```json
{"type":"webauthn.get","challenge":"<43 unpadded base64url characters>","origin":"<21 ASCII bytes>","crossOrigin":false}
```

Order, punctuation, spelling and whitespace are significant. The origin
has exactly 21 bytes (for example `http://localhost:8973`); it is **not
zero-padded**. The browser adapter requires a canonical HTTPS origin, or
HTTP localhost. It rejects unsupported shapes before proving. Different
origin lengths, omitted `crossOrigin`, extra JSON members, cross-origin
iframes, authenticator extensions and attested credential data are outside
this profile. Supporting another length requires compiling another
profile and measuring its keys; this implementation does not claim
general variable-length WebAuthn support.

This is a profile-specific reference implementation, not full conformance
to the signature-schemes draft's length-agnostic section 3.5. It also keeps
key/RP/origin private and binds policy per device, rather than using the
standalone experiment's public key/RP inputs. Those specification deltas
remain subject to review. Policy-bearing boot/device recipes use **r1:v2**
tags to distinguish them from the draft's policy-free r1:v1 recipes.

`authenticatorData` is exactly 37 bytes. The circuit checks:

- `rpIdHash` equals the enrolled/committed policy;
- UP and UV are both set;
- reserved/AT/ED bits are clear and BS implies BE (flags 5, 13 or 29);
- ECDSA over `SHA-256(authenticatorData || SHA-256(clientDataJSON))`.

The circuit reconstructs **every client-data byte**, including base64url
of the account's computed challenge. Neither a prover-supplied hash nor
client-side parsing substitutes for the circuit checks. Origin bytes
cannot contain quotes, backslashes, whitespace or non-ASCII characters.
The signed `signCount` is preserved but not used for replay protection:
synced passkeys commonly return zero. The account/grant nonce and rolling
device entry supply transaction freshness. High-S signatures are valid;
the client strictly decodes DER to canonical nonzero `r,s` scalars, and
the native P-256 verifier checks the signature relation.

## Credential and operation binding

`P256Device` accepts a public key, RP ID, exact origin and asynchronous
assertion provider. `browserAssertionProvider` calls
`navigator.credentials.get` with the operation challenge, credential ID,
RP ID and `userVerification: 'required'`. `createBrowserCredential`
creates a local ES256 credential with `attestation: 'none'`, extracts its
public key through the WebAuthn SPKI accessor and checks a trial
assertion against this profile before returning it. Applications may also
supply a public key/credential ID from their RP registration service.
This is not an attestation-verification service.

```ts
const credential = await createBrowserCredential(
  location.hostname, location.origin, 'My account',
);
const device = new P256Device(
  credential.pk, credential.rpId, credential.origin,
  browserAssertionProvider(credential.credentialId, credential.rpId),
);
await account.addDevice(existingDevice, device);
await account.rotateEncKey(device, newEncryptionKey);
```

Persist the credential ID, public key, RP ID and origin as credential
metadata; the assertion provider can also bridge a browser to a separate
prover process. `softwarePasskey` lives only in the test fixtures and uses
OpenSSL to provide an independent signing oracle.

The device boot commitment (`midnight:account:boot:r1:v2`) and rolling entry
(`midnight:account:device:r1:v2`) bind the **public key, RP hash and exact
origin**, in that declaration order. The policy cannot be changed by the prover.
Operation challenges use the `midnight:account:auth:r1:v1:<operation>`
domain and bind account address, key coordinates, arguments, consumed
witness coin (where applicable) and `auth_nonce`. Coordinates use the
same 32-byte little-endian recipe as the k256 arm. Signature bytes are
private proof inputs.

P-256 grant identity binds the account, key, origin hash and slot. The
grant gate recomputes the origin hash from the signed origin and opens
the scope's salted RP commitment. Its challenges bind grant identity,
issuance generation, operation arguments and grant nonce. The shared
scope checks still bound recipients, amounts, cumulative spending,
coin size, expiry and change encryption key.

P-256 devices can publish recovery sessions and veto pending recovery.
Recovery submission/finalisation retains the shared JubJub recovery gate
and JubJub successor; the recovered device can enrol a new passkey.

## Build and reproduce

```sh
npm ci
npm run compile
npm run test:p256-offline
npm run measure:p256
# With the standalone stack and WALLET_SEED configured per README:
EVIDENCE_DIR=evidence/p256-webauthn npm run test:p256
npm run report:p256
```

The first full-account proof OOM-killed the proof server in the roughly
8 GiB Docker VM. The completed follow-up run passed with **24 GiB allocated
to Docker** (8 CPUs), recording 21 accepted calls and 22 circuit proofs
(including activation). See the [recorded failure](evidence/p256-webauthn/prover-8gib-oom.json)
and [successful run](evidence/p256-webauthn/conformance-and-proving.json).
The large P-256 account gates are k=18; peak memory was unavailable, so
this allocation is not a measured minimum-memory requirement.

`p256-offline.ts` checks the captured real, high-S WebAuthn assertion and
independent OpenSSL signatures, base64url/endian recipes, malformed DER,
weak keys, re-signed envelope violations, argument/account/replay/policy
binding and device/grant/recovery state transitions. On-node evidence
separately identifies software-authenticator account calls, the captured
real-assertion probes, and build-stage negatives.

### Interactive browser-to-account test

**Observed result:** [live Safari passkey flow — PASS, 1 October 2026](evidence/p256-webauthn/browser-flow.md).
The [experiment guide](../experiments/passkey-account-flow/README.md) links
the published assertion/outcome evidence and its offline verification command.
This separate run used an interactive browser assertion for the account
operation itself; the earlier automated benchmark suite still uses the
software-authenticator fixtures described above.

With the compiled artifacts, local stack and `WALLET_SEED` configured:

```sh
npm run test:p256-browser
# Open http://localhost:8973 in Safari or Chrome.
```

This uses the production `createBrowserCredential` and
`browserAssertionProvider` adapters. It installs no virtual authenticator
and has no software-signing fallback. The user performs the system passkey
ceremonies:

1. **Create passkey**, then approve the adapter's profile-check assertion.
   Public credential metadata is retained in this origin's local storage;
   **Use saved test passkey** can reuse it on another run.
2. Wait for a new passkey-first account to deploy and activate. The local
   funding wallet pays fees; the account deployment uses ten waves.
3. **Approve account change**. The browser signs the challenge for this
   account's encryption-key rotation, bound to its new key and fresh nonce.
   The runner checks changed-argument rejection, proves/submits the intended
   operation, requires indexed `SUCCESS`, checks the new key/nonce/device
   counter, and checks that the consumed authorisation cannot be replayed.
4. **Test cancellation**, then cancel the system prompt. No further account
   mutation should occur. Browsers report cancellation, denial and timeout
   as `NotAllowedError` in many cases; evidence records the returned error
   rather than inferring the user's exact action from it.

The server binds only loopback, requires the exact localhost Host and
same-origin JSON POSTs, and serves the browser bundle locally. It records
per-run evidence as `evidence/p256-webauthn/run-browser-<uuid>.json` (ignored
by Git), including public credential data, signed assertions, accepted
transaction IDs, state checks and timings. Review that local evidence before
publishing it. Private signing keys and biometrics are never requested by
the server. `attestation: none` means the run does not independently attest
the hardware model or whether the user chose a biometric versus a PIN.

`PARTIAL` denotes an unfinished run; `PASS` requires the complete sequence.
Changed-argument and replay negatives must abort before any proving or node
submission, with the expected circuit error and unchanged account state.
Proof timing and browser-ceremony timing are recorded separately. Keep the
terminal running while interacting; stop it with Ctrl-C after completion.

If a run stops after credential creation, reuse **Use saved test passkey**,
or restart the server with `PASSKEY_CREDENTIAL_FILE` pointing at that run's
JSON evidence. This resumes only the credential's public metadata; the new
account operation still requires a fresh browser approval.

The runner compares the indexer's latest block hash with the node before
initialising the wallet. Recreating a dev node can reset its chain while the
indexer retains old data; `isSynced` alone cannot detect that mismatch. If
the check fails, rebuild the indexer for the current chain (retain the old
volume separately if needed). Otherwise a stale DUST state can produce node
error 170, `InvalidDustSpendProof`, before passkey account activation.

`circuit-sizes.json` records `k`, used rows, exact uncompressed prover/VK/
ZKIR byte counts and SHA-256 hashes. `conformance-and-proving.json` records
sequential per-circuit `ProvingProvider.prove` timings, proof bytes and
accepted transaction identifiers. This interval includes key lookup/load
and local HTTP transfer, and excludes signing, circuit execution/check,
wallet balancing and inclusion. Three observations distinguish the first
sample and two repeats; they do **not** establish OS/server cold-cache
performance. Key generation time is not proving time.

Compact 0.35's TypeScript exported-struct unifier omits
`curve-secp256r1` (`compiler/typescript-passes/print-typescript.ss:3168`).
The account's P-256 authorisation structs are therefore internal, with
the same fields emitted inline in the generated ABI. No compiler patch
or generated-code edit is required.
