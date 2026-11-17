# P-256 / profiled WebAuthn

Earlier fixed-profile circuit sizes and proving timings:
[P256-MEASUREMENTS.md](P256-MEASUREMENTS.md). These predate the Ledger profile
extension and must not be presented as measurements of its regenerated keys.

The `p256` account arm verifies ES256 assertions in Compact 0.35.0,
runtime 0.20.0, ZKIR 3.1. It shares the custody, grant-scope and recovery
mutation chips with the JubJub and secp256k1 arms. The account roster is
**52 circuits**: four shared and sixteen per credential arm.
The earlier fixed-profile run used ten waves with the 15,000-verifier-byte
planner. Deployment computes its waves from the actual regenerated keys.

## Supported profile: `wa-json134-or-chrome243`

The Ledger pilot extends the original bounded profile to two exact signed
byte shapes. The first `clientDataJSON` shape is 134 bytes:

```json
{"type":"webauthn.get","challenge":"<43 unpadded base64url characters>","origin":"<21 ASCII bytes>","crossOrigin":false}
```

Order, punctuation, spelling and whitespace are significant. The origin
has exactly 21 bytes (for example `http://localhost:8973`); it is **not
zero-padded**. The browser adapter requires a canonical HTTPS origin, or
HTTP localhost. It rejects unsupported shapes before proving. Different
origin lengths, omitted `crossOrigin`, arbitrary extra JSON members,
cross-origin iframes, authenticator extensions and attested credential data
are outside this profile.

The second shape is 243 bytes: the same required fields followed by exactly
Chromium's `other_keys_can_be_added_here` string member with value
`do not compare clientDataJSON against a template. See https://goo.gl/yabPex`.
Chromium randomly adds this member to expose rigid-template assumptions.
The `chrome_grease` Boolean in `P256Auth`/`P256GrantAuth` selects which exact
byte sequence the circuit reconstructs and hashes before the single native
ECDSA check. A wrong selector fails signature verification; it cannot supply
an unchecked hash. Both shapes share the same verifier key for an operation.
The TypeScript adapter compares against these two allowed shapes but verifies
the received bytes verbatim. Nothing is stripped or reserialised for signing.

This pilot deliberately does not implement general variable-length WebAuthn
JSON. A browser change outside these two shapes fails with an unsupported
profile error; it is not silently retried or normalised. Supporting arbitrary
additional fields remains a separate integration task. This ABI change needs
regenerated keys and a fresh test account; it is not an upgrade of a live
account whose maintenance authority has been retired.

This is an implementation-specific profile. The
[ECDSA Authorisation for Custody Accounts draft](../docs/mps-mip/mips/mip-xxxx-signature-schemes.md)
records the signing boundary and permits named bounded profiles; complete
recipe references, the common UV requirement and evidence mapping remain
specification work. Neither profile name is an adopted
W3C/FIDO or MIP baseline. This implementation keeps key/RP/origin private,
binds policy per device and requires UP+UV on every call. The draft requires
every reachable verifier accepting a credential to enforce its authorised
policy, without mandating a stored profile ID. Boot/device recipes use
**r1:v2**; operation challenges retain **r1:v1**.

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
npm run test:ledger-flex-offline
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

### Ledger Flex grant experiment

**Observed result: PASS, 17 November 2026.** The interactive Ledger credential
authorised a five-unit grant withdrawal, confirmed as `SUCCESS` at localnet
block 396. A second fresh signature was refused after the owner revoked the
grant at block 407. The account finished with 95 units and an inactive grant.
Per-call cap, recipient, changed-amount and replay controls also refused
locally, with unchanged state and no proving or submission calls.

The [experiment guide](../experiments/ledger-flex-account/README.md) links
the published [`grant-flow.json`](evidence/ledger-flex-account/grant-flow.json)
evidence and reproduction instructions. The full raw run remains local;
the published projection retains original signed bytes and omits credential
lookup IDs and local stack traces. `npm run verify:ledger-flex` independently
verifies the published signatures with Node/OpenSSL and checks grant bindings
and recorded outcome consistency. Historical node acceptance remains
supported by the recorded receipts.
The verifier also uses the immutable grant issuance value from a
[supplementary read-only account query](evidence/ledger-flex-account/post-run-state.json)
collected after the run at 13:09 UTC. That later snapshot is separate from
the original capture and does not independently prove historical chain state.
The accepted grant transaction is
`0021a7483505d3b6529eabb91b2e0e7782e0a5fec66071ab527813c0d8993bf289`.
The grant proof took 44.334 seconds through the timed proving provider and
was 6,364 bytes. This is one observation, not a cold-cache benchmark.
Both fresh hardware assertions in this run had the 134-byte shape; the
243-byte capture was separately verified by the native offline tests.
The live run demonstrates a grant key; fresh hardware device-key operations
remain a separate experiment.

The Ledger integration was built from upstream `origin/main` at
`99062671d939641cb9ed9274d3d18fce764d539a`. The initial and reconnect
captures in `src/tests/ledger-flex/fixtures` use the same USB credential
and exercise both supported client-data shapes. `test:ledger-flex-offline`
verifies their original hardware signatures with the compiled native
Compact verifier. It separately exercises fresh device and grant operations
with software-generated signatures. Those offline operations do not prove
that the Ledger has authorised an account transaction.

The interactive runner closes that gap using a fresh localnet account and
fresh challenges. After compiling all account keys and starting the pinned
stack described in README, run from `contract`:

```sh
# WALLET_SEED is the disposable localnet funding wallet from README.
LEDGER_CREDENTIAL_FILE='/path/to/ledger-flex-vector (1).json' \
EVIDENCE_DIR=evidence/ledger-flex-account/live \
npm run test:ledger-flex-grant
# Open http://localhost:8973 in Chrome.
```

Stop any earlier probe listening on port 8973 first. The optional file
imports only the public credential metadata; its previous signature is
never reused to authorise a new operation. Without that file, the page can
import it or register an external USB ES256 credential. Use the same browser
origin and Ledger Security Key credential as the capture.

The runner deploys a disposable account with a software JubJub owner,
deposits 100 non-native localnet test units, and issues the Ledger a grant
with a total cap of 12, a per-call cap of 10, and a pinned recipient/token/RP.
It then needs two user ceremonies:

1. **Sign with Ledger** approves a fresh five-unit grant spend. After local
   scope and changed-amount refusal checks, the runner proves and submits
   that spend and confirms its indexed transaction against the node. The
   account must retain 95 units and the grant nonce must advance to one.
2. **Sign with Ledger** signs a one-unit request for the revocation test.
   The owner revokes the grant before the runner attempts the signed request.
   It must be refused, leaving the account at 95 units.

The browser displays the account operation; WebAuthn on the Ledger confirms
the relying party and does not clear-sign these spend details on its screen.
User cancellation records an unchanged-state check and leaves the next
ceremony waiting for another explicit click. No software signer substitutes
for either grant signature.

Evidence is written incrementally to `EVIDENCE_DIR/run-<uuid>.json`.
`PASS` requires the accepted hardware-authorised spend plus scope, replay
and revoked-grant refusal checks. Negative controls execute compiled account
circuits locally and must perform zero proving or submission calls; they
are not invalid proofs rejected by the node. Public signatures, source/key
hashes and transaction IDs are recorded. Hardware model and UV method are
user-observed because this flow does not verify hardware attestation.
