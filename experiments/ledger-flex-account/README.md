# Ledger Flex as a Passport grant key

**Experiment result: PASS — 17 November 2026.** A Ledger Flex connected over
USB signed a fresh Passport grant-spend challenge. The full Account Custody
Contract (ACC) verified it through its native P-256/WebAuthn arm, and the
local Midnight node accepted the five-unit withdrawal. Nicolas performed
the Ledger/browser approval ceremonies.

## Question

Can an external Ledger Security Key credential authorise a scoped grant
spend from an ACC, including transaction binding, scope limits, replay
protection and revocation?

This follows the [live Safari account-operation experiment](../passkey-account-flow/README.md).
The Ledger flow uses a software JubJub account owner and a hardware WebAuthn
grantee. It tests the grant-key role; it does not establish a live Ledger
device-key lifecycle or recovery flow.

## Flow and result

1. Reuse the public credential metadata from an earlier Ledger probe. The
   capture's signature is not reused to authorise an account operation.
2. Deploy a fresh schema-v3 ACC with all 52 circuits in ten waves, then
   retire its maintenance authority. The disposable localnet wallet pays
   fees; a software JubJub device controls the account.
3. Mint and deposit **100 non-native localnet test units**. Issue the Ledger
   a grant capped at **12 total**, **10 per call**, with recipient, token
   and relying party pinned.
4. Request a fresh Ledger signature for a five-unit withdrawal. Verify
   scope and changed-amount refusals, then prove and submit the authorised
   request through `withdraw_unshielded_with_grant_p256`.
5. Confirm indexed `SUCCESS` against the node's block hash. Check balance
   **100 → 95**, grant nonce **0 → 1**, and unchanged owner authorisation
   nonce and device entry. Refuse replay of the consumed signature.
6. Request a second fresh Ledger signature for a one-unit withdrawal.
   Revoke the grant before attempting that signed request. It must be
   refused, leaving **95 units** and an inactive grant.

The five-unit spend was accepted at **block 396**, transaction
`0021a7483505d3b6529eabb91b2e0e7782e0a5fec66071ab527813c0d8993bf289`.
The owner revoked the grant at **block 407**, transaction
`0008182ff92602a9c8985c623d26497c0bf3272dd5bad25e903613596d87d64742`.

All five negative controls passed: above per-call cap, recipient outside
the pin, changed signed amount within scope, replay with the current spent
opening, and a revoked grant with a valid pre-revocation signature. Each
failed during **local execution of the compiled account circuit**, with
unchanged serialised state and zero proving/submission calls. These are
not invalid proofs submitted to and rejected by the node.

The accepted grant proof took **44.334 seconds** through the timed proving
provider and was **6,364 bytes**. This interval includes artifact lookup
and local HTTP transfer, and excludes the browser ceremony, wallet
balancing and inclusion. It is one observation, not a repeat mean or a
cold-cache benchmark.

## Profile and build

The captures report Ledger Flex OS **1.7.0**, Ledger Security Key **1.7.8**,
and Chrome **157** on macOS. Hardware identity and firmware versions were
user-observed; this experiment does not verify hardware attestation.
The origin is `http://localhost:8973`, with RP ID `localhost` and required
user verification.

The original capture had 134-byte `clientDataJSON`. A second capture after
disconnect/reconnect/unlock contained Chromium's extra GREASE member and
was 243 bytes. Both original hardware signatures passed the compiled
native verifier; selecting the wrong layout failed. Both fresh hardware
assertions in the live grant flow happened to use the **134-byte** layout.
Fresh simulated device/grant operations exercised both layouts separately.

The account profile is `wa-json134-or-chrome243`: two exact signed byte
shapes, a 21-byte origin, and 37-byte authenticator data. The new
`chrome_grease` Boolean selects an in-circuit reconstruction of the JSON
before native ES256 verification. The browser adapter verifies the raw
received bytes. It neither strips the extra field nor supplies an unchecked
hash to the circuit. Other JSON layouts fail explicitly. See the
[profile specification](../../contract/WEBAUTHN.md) for all exclusions.

The integration was based on upstream `origin/main` at
`99062671d939641cb9ed9274d3d18fce764d539a`, with Compact **0.35.0**, runtime
**0.20.0**, and ZKIR **3.1**. All 52 key pairs were generated afresh. The
pinned compiler then produced the final bindings and integrity manifest
using those keys only after exact regenerated-IR and artifact-hash checks.
The SDK artifact checks passed for all 52 circuits and each ten-wave plan.
The initial unkeyed artifact bundle was refused by the SDK; deployment
occurred only after the complete compiler-native bundle passed its checks.

The selector changes the P-256 authorisation ABI and needs regenerated
keys and a fresh test account. Custody, scope enforcement and credential
policy commitments are unchanged by this experiment.

## Reproduce

Use Node **>=22.12**, Compact **0.35.0**, and the local stack/funding wallet
described in [the contract README](../../contract/README.md#running).
The recorded run used the pinned [CI localnet stack](../../contract/infra/docker-compose.ci.yml)
with a 24-GiB Docker allocation. That allocation is not a measured minimum.

From `contract/`:

```sh
npm ci
npm run compile
npm run build
npm run test:toolchain-offline
npm run test:ledger-flex-offline
npm run test:p256-offline
npm run test:grants-offline

# Start the local stack and set its disposable WALLET_SEED per README.
# Choose a fresh evidence directory to preserve previous receipts.
EVIDENCE_DIR=/tmp/passport-ledger-grant-run npm run test:ledger-flex-grant
```

Connect and unlock the Flex over USB, open **Ledger Security Key**, then
open **http://localhost:8973** in Chrome. Import a capture belonging to
your own credential or create a new external USB credential. After account
setup, click **Sign with Ledger** for the five-unit spend. When the page
requests it, sign the one-unit revocation test. `PASS` requires the complete
sequence above. Run only one probe/browser harness on port 8973 at a time.

To import your own existing probe capture at startup, set
`LEDGER_CREDENTIAL_FILE=/path/to/ledger-flex-vector.json`. This imports
public metadata only. Published signatures cannot replace either fresh
hardware approval. Keep the runner active until the page reports completion.

The executable harness remains beside the account tooling:

- [Node/localnet runner](../../contract/src/tests/ledger-flex-grant.ts)
- [Browser client](../../contract/src/tests/ledger-flex-grant/client.ts)
- [Browser page](../../contract/src/tests/ledger-flex-grant/index.html)
- [Offline native/account tests](../../contract/src/tests/ledger-flex-offline.ts)

## Evidence and limits

- [Published live-run evidence](../../contract/evidence/ledger-flex-account/grant-flow.json): public signed assertions, source/artifact hashes, accepted transaction IDs, node/indexer block correlation, state outcomes and negative controls.
- [Supplementary account snapshot](../../contract/evidence/ledger-flex-account/post-run-state.json): a read-only query after the run, used for grant challenge reconstruction and final-state consistency checks.
- [Offline results](../../contract/evidence/ledger-flex-account/offline.json): nine groups covering both captures and software-generated device/grant operations.
- [Validation record](../../contract/evidence/ledger-flex-account/validation.json): TypeScript, existing P-256 checks, 127 grant checks, SDK artifact checks and live-run digest.
- [Published initial and reconnect captures](../../contract/src/tests/ledger-flex/fixtures/): unchanged signed assertion bytes with credential lookup IDs omitted; provenance records both original-file and published-file SHA-256 hashes.
- [Key-generation record](../../contract/evidence/ledger-flex-account/keygen/keygen.json) and [final artifact verification](../../contract/evidence/ledger-flex-account/keygen/finalized-artifacts.json): source/key hashes and recorded build checks. Generated proving artifacts are not committed.

The full raw run remains local. The published projection retains the
original signed assertion bytes while omitting credential lookup IDs and
local stack traces. The published probe captures similarly preserve signed
bytes without being byte-identical copies of the original JSON files.

The supplementary account query was collected at **13:09:34 UTC**, after
the live run completed at **13:00:26 UTC**. It records `issuedAt = 1`,
grant nonce 1, an inactive grant and balance 95. The verifier uses the
grant's immutable issuance value to reconstruct both original operation
challenges. This later snapshot is explicitly separate from the original
capture; checking its recorded node/indexer hashes is not an independent
proof of historical chain state.

To verify the published evidence from `contract/`:

```sh
npm run verify:ledger-flex
```

This independently verifies signatures with Node/OpenSSL and checks the
recorded grant challenge bindings and outcome consistency. It does not
repeat the human ceremonies or independently re-establish historical node
acceptance. The separate `test:ledger-flex-offline` command validates the
earlier captures and fresh simulated account operations.

Ledger WebAuthn confirms the relying party. The browser displays the spend
details; the Ledger does not clear-sign those transaction details on its
screen. UP/UV flags are verified, but `attestation: none` does not establish
the hardware model or whether the user used a PIN or biometrics. There is
no software-signing fallback for either grant assertion.

This is one localnet unshielded grant flow with test assets. It does not
establish hardware device-key operations, shielded/forwarded Ledger grant
spending, PRF, recovery, production readiness or general variable-length
WebAuthn compatibility.
