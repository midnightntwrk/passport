# Live passkey approval of a Passport account operation

**Experiment result: PASS — 1 October 2026.** A real Safari passkey signed
an account-specific action, which the Compact account verified and the local
Midnight node accepted. Nicolas performed the browser's system prompts.

## Question

Does the native P-256/WebAuthn account arm work with an actual browser
credential from registration through an accepted account-state change?

The earlier [P-256 proof-system experiment](../p256-in-circuit/README.md)
and [automated account measurements](../../contract/P256-MEASUREMENTS.md)
established circuit feasibility and profiled conformance. This experiment
exercises the live browser integration with a fresh operation challenge.

## Flow and result

1. Create a passkey in Safari 27.0.1 on macOS, then approve the adapter's
   trial assertion against profile `wa-json134`.
2. Deploy a new passkey-first account, bind the credential's RP/origin,
   install all 52 circuits in ten budgeted waves and retire the maintenance
   authority. The local test wallet pays transaction fees.
3. Read the account's current nonce and request a browser assertion over
   the challenge for `rotate_enc_key_with_p256`.
4. Verify/prove that assertion and submit the account-key rotation.
5. Confirm indexed `SUCCESS`, the new encryption key and nonce/device
   counter **0 → 1**. Check changed arguments, replay and cancellation.

The rotation was accepted at **block 165**. Its transaction ID is
`00e9925d444914750d55a04b4f34aaa33da31709a8da854372ae397e7773df9cde`.
The signed challenge was independently reconstructed, the signature checked
with Node/OpenSSL, and the indexed block hash checked against the node.
Hash-correlated node logs confirm validation and application.

Changed-argument and replay attempts aborted during **local circuit
execution**, before proving/submission. Browser cancellation/denial returned
`NotAllowedError`, with state unchanged. Two approvals made during the
cancellation check were discarded without creating additional transactions.

One-run observations: **6.126 s** for the browser assertion ceremony,
**27.181 s** for proving, and **50.192 s** from signed-response receipt to
indexed acceptance, including the changed-argument control. These are not
repeat means, cold-cache measurements or a production latency commitment.

## Reproduce

Use Node >=22.12, Compact 0.35.0 and the local stack described in
[the contract README](../../contract/README.md#running). The successful run
used the existing generated P-256 artifacts and a proof server in an 8-CPU,
24-GiB Docker VM.

From `contract/`:

```sh
npm ci
# For a fresh checkout, generate artifacts once:
npm run compile

# Set WALLET_SEED for the local funding wallet as documented in README.md.
npm run test:p256-browser
```

Open **http://localhost:8973**, click **Create passkey**, and complete both
registration/profile-check prompts. Wait for account deployment, then click
**Approve account change** and approve the fresh assertion. Finally click
**Test cancellation** and cancel the system prompt. The page reports PASS
after all checks. The original capture harness uses the same port, so run
only one of them at a time.

For another run, **Use saved test passkey** reuses public credential metadata
from browser local storage. `PASSKEY_CREDENTIAL_FILE` can also point to a
local raw run to resume its public metadata after a stack failure; approval
of the new account operation still requires the authenticator.

The executable harness is kept with the contract tooling so it uses the
same generated account, dependencies and production browser adapters:

- [Node/localnet runner](../../contract/src/tests/p256-browser.ts)
- [Browser client](../../contract/src/tests/p256-browser/client.ts)
- [Browser page](../../contract/src/tests/p256-browser/index.html)
- [WebAuthn adapter](../../contract/src/wallet/webauthn.ts)

## Evidence

- [Run report](../../contract/evidence/p256-webauthn/browser-flow.md)
- [Published machine-readable run](../../contract/evidence/p256-webauthn/browser-flow.json)
- [Node log excerpts](../../contract/evidence/p256-webauthn/browser-flow-node.txt)
- [Offline evidence verifier](../../contract/src/tests/p256-browser-evidence.ts)

```sh
# From contract/, after dependencies and generated account are available:
npm run verify:p256-browser

# Publish a projection of another local run, retaining signed assertion bytes:
npm run verify:p256-browser -- --export evidence/p256-webauthn/run-browser-<uuid>.json
```

The offline command independently checks signatures with Node/OpenSSL,
reconstructs the approved account challenge, and validates recorded
outcome/state consistency. It does not re-run user interaction or establish
node acceptance independently of the recorded live evidence. The published
projection omits credential lookup IDs and local stack traces; original raw
runs remain local and Git-ignored.

## Findings and limits

- Safari's real assertion matched `wa-json134`: exact 134-byte client JSON,
  21-byte origin, 37-byte authenticator data, flags 29 and sign count zero.
- The first deployment attempt exposed a **local-stack mismatch**: a new
  dev-node chain and an indexer retaining the previous chain. The DUST fee
  proof was rejected with error 170 before account activation. Rebuilding
  the indexer in a fresh volume resolved it; the runner now compares an
  indexed block hash against the node before wallet setup.
- This is one Safari/profile/account-control flow. Wider browser/device
  coverage, variable-length WebAuthn, live spending/grant UX and product
  integration remain follow-up work.
- No virtual authenticator or software-signing fallback was used.
  `attestation: none` does not attest hardware model or biometric-versus-PIN
  verification. The contract verifies the signed UP/UV flags and operation
  binding; account state supplies freshness.
