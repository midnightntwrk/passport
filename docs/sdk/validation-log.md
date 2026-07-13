# Validation Log

This log records observed results. A checked box in source code or a successful
build is not reported as a live wallet result.

| Date | Environment | Check | Result | Evidence / next action |
|---|---|---|---|---|
| 2026-07-13 | Local browser, supplied Dynamic Sandbox environment | Passport encrypted state unit suite | Passed | Six tests cover CRUD, scope isolation, wrong keys, malformed versioned envelopes, passkey API absence/cancellation, and no plaintext persistence/logging. |
| 2026-07-13 | `http://127.0.0.1:5180`, supplied Dynamic Sandbox environment | Dynamic SDK environment initialization | Externally blocked | Dynamic reported `Failed to fetch` because this origin is not authorized by the environment. |
| 2026-07-13 | `http://localhost:5175`, supplied Dynamic Sandbox environment | Dynamic SDK environment initialization and auth modal | Passed | Environment settings loaded without console errors; the Dynamic modal presented Discord, email, and passkey authentication. No account credentials were submitted in this validation. |
| 2026-07-13 | `http://localhost:5175`, supplied Dynamic Sandbox environment | Embedded wallet and three address surfaces | Passed | An authenticated embedded Midnight wallet returned unshielded, shielded, and DUST addresses through the official wallet/connector methods. All three are rendered with copy actions. |
| 2026-07-13 | Same | Balance and DUST sync | Passed | `getFormattedBalances()` returned public NIGHT `0` and shielded token count `0`. Dynamic initially reported `dustSyncing: true`; the demo retried the live query and the DUST surface settled to `0` without any fabricated balance. |
| 2026-07-13 | Same | Message signing, DUST registration, shielded/unshielded transfer, pending recovery | Not run | Requires the previous check plus a funded wallet and DUST. |
| 2026-07-13 | Local deterministic contract build | Passport C1 testnet deployment draft | Passed | `compact compile` produced the C1 artifact and verifier assets. `npm run test:c1 --workspace passport-demo` constructs a real unsigned deployment transaction from wallet public-key material and verifies that it serializes. No network request, wallet signature, or submission occurs in this check. |
| 2026-07-13 | `http://localhost:5175`, supplied Dynamic Sandbox environment | Dynamic C1 sign, prove, submit, and finality | Not run | Requires an explicit user-authorized Dynamic testnet action. A transaction hash and independent on-chain confirmation are required before this can be marked passed. |
| 2026-07-13 | Localnet prototype | C1 custody / Night ID | Prototype only | Not part of the client-ready Dynamic validation path. No claim of Dynamic custody-circuit signing is made. |

The next live run must append the actual account-safe result, transaction hash
where one exists, error text where it fails, and the tested Dynamic environment.
