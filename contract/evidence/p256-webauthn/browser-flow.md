# Live browser passkey → account transaction — PASS

Observed **1 October 2026**, using Safari **27.0.1** on macOS, the production
browser adapters, and the compiled P-256 account from PR #175. Nicolas
performed the real system passkey ceremonies. The interactive harness used
no software signer or virtual authenticator.

## Accepted account operation

- Account: `e0a33cfae237a8772eeb02db2b05377715ffb57257b7a0ca2b3c91d85e85786d`
- Operation: `rotate_enc_key_with_p256`
- Transaction ID: `00e9925d444914750d55a04b4f34aaa33da31709a8da854372ae397e7773df9cde`
- Transaction hash: `e220b64041f21fe7d9fd8ac5d950f2b6ba02aee0e23d75151b3309ba089b77fb`
- Included at block **165**, indexed result **SUCCESS**.
- Block hash: `e6aa1103441dd23edea8abe0d00391e511e21c1c23e9dad1923d3e9949ced6d3`
- Account nonce **0 → 1**; enrolled device use counter **0 → 1**.
- Encryption key changed from
  `17a41ca2d6a8aa9bb0caf5d16949b9553a7db03aaae8174f807ee63e9350781d` to
  `7e91e6e67ce4bdf8ebe2d035f43506050ddb23b383c380e01ea682fb351a1d2d`.

The credential was created in the first browser attempt and its profile
check succeeded. After fixing the local stack, the successful run reused
that credential's public metadata, deployed/activated a fresh passkey-first
account, and requested a **new operation-bound assertion**. Its challenge
was reconstructed from the account address, public key, new encryption key
and current nonce. After completion, Node/OpenSSL independently verified
the captured signature. The indexed block hash was independently matched
against the node's `chain_getBlockHash` response.

Hash-correlated node logs record mempool validation at **14:40:08 UTC**,
application at **14:40:12**, and finalisation through block 165 by
**14:40:28**. Activation was also accepted, at block **138**. Account
deployment used **ten waves**, each within the 15,000-verifier-byte budget,
and retired its maintenance authority.

## Negative controls

| Control | Observed result |
|---|---|
| Change the approved new-key argument | Local circuit abort: `invalid WebAuthn signature`; no proving/submission; state unchanged |
| Replay the consumed authorisation | Local circuit abort: `unknown device entry`; no proving/submission; state unchanged |
| Cancel/deny a fresh browser request | Safari `NotAllowedError`; no assertion, proving or submission; state unchanged |

During the cancellation check, two requests were approved before the final
request was cancelled. Those two assertions were validated and discarded;
they caused **no additional transaction**. The runner only records the
browser error, which does not distinguish cancellation from denial or
timeout on its own. Nicolas reported the completed interactive flow.

## One-run timings

| Interval | Observation |
|---|---:|
| Browser assertion ceremony, including user interaction | 6.126 s |
| Account-operation proving | 27.181 s |
| Signed response received → indexed acceptance, including changed-argument control | 50.192 s |

Proving includes key lookup/load and HTTP, but excludes the passkey prompt,
balancing and inclusion. These are single observations, not repeat means or
cold-cache claims. They are separate from the earlier software-authenticator
benchmark suite. Prover image:
`sha256:2c9b9917d3dd81b6f47ccdab333064eb6bad0fa0f7b5a0c9087fc7cd1d26cade`
(`midnightntwrk/proof-server:9.0.0-rc.8`, aarch64 Docker, 8 CPUs, 24 GiB VM).

## Profile and limits

RP `localhost`, origin `http://localhost:8973`, profile `wa-json134`.
The signed assertion had 134-byte client data and 37-byte authenticator
data, flags **29** (UP + UV + BE + BS), and sign count zero. Replay
protection came from account state. `attestation: none` means no claim is
made about the hardware model or whether verification used a biometric or
PIN. This validates one live Safari account-control journey; wider
browser/device coverage, spending flows and production UX remain separate.

## Initial infrastructure failure and correction

The first deployment was refused with RPC **170 / InvalidDustSpendProof**:
the recreated dev node had a new chain, while its indexer still served the
previous chain through block 2564. No passkey-gated account operation had
yet been submitted. A fresh indexer volume was used, retaining the previous
volume, and the harness now verifies the indexer's block hash against the
node before wallet setup. The successful run began with both agreeing at
block 97.

## Reproduction and published evidence

See the [experiment](../../../experiments/passkey-account-flow/README.md)
and run `npm run test:p256-browser` as described in
[WEBAUTHN.md](../../WEBAUTHN.md). The [machine-readable evidence](browser-flow.json)
retains public keys, signed assertion bytes, state transitions, timings and
all recorded outcomes; credential lookup IDs and local stack traces are
omitted. [Node log excerpts](browser-flow-node.txt) preserve the relevant
rejection and accepted-operation entries. `npm run verify:p256-browser`
checks the published signatures and operation binding with Node/OpenSSL,
plus recorded result consistency; this offline command does not replay
browser interaction or prove historical node acceptance.

Original raw runs remain local and ignored by Git:

- Successful run: `run-browser-83c60e55-2be1-4360-85b5-7ae75b22e3f8.json`
- SHA-256: `b9ebb1fe9efa7eaefa3b5ee922a7f44b0138fe8b1fa72654ba1a8928fcbfc697`
- First attempt: `run-browser-1f340022-3c24-4882-b510-f0da3684dac3.json`

Execution base: `d6df6b854f3dfaf2444396f1a0bb36d3110e1a10`, plus the
interactive harness included in this follow-up. Executed source/artifact
SHA-256 values:

| File | SHA-256 |
|---|---|
| `src/tests/p256-browser.ts` | `203f7ea9cc484f16444ea447c97bd2f0fb1bb5d6a8ba7a67a68be65e2c56b8cd` |
| `src/tests/p256-browser/client.ts` | `155a16d828698618cafe0dde05bb8872b3c5dcaec2d273abe60346a5765e11fb` |
| `src/wallet/webauthn.ts` | `7470841b5899239c5f2ade0da0bf6008012549a47620371a0902f37b03a4363c` |
| `contracts/managed/account/zkir/rotate_enc_key_with_p256.zkir` | `2b056dde43dc3e75a651b3f19f48abf8d0fe48c6a167a561b58c5a8ee714ea5f` |
