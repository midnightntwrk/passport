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
