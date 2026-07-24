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
| 2026-07-24 | Local SDK workspace | SDK private-state, profile protocol, passkey, and Sig adapter suites | Passed | 13/13 tests passed across four files. |
| 2026-07-24 | Disposable Midnight localnet | C1 scoped-grant lifecycle | Passed | Deployed and funded C1; issued a 300-unit grant; spent 100; rejected over-cap and privilege-escalation calls; revoked; rejected post-revocation use. |
| 2026-07-24 | Disposable Midnight localnet + Midnames Preview `83f8422` | Night ID resolution and shielded deposit | Passed | `alice.night` resolved externally to C1 `8a9bc2f4…3467e`; deposit transaction `00000286…e2dd5` placed 500 shielded units in the resolved C1 and the ledger read confirmed custody. |
| 2026-07-24 | Disposable Midnight localnet, complete rerun | All five C1 lifecycle scenarios | Passed | NIGHT custody, scoped grants, shielded custody, total-loss recovery, and Midnames all passed in one run. The checks rejected an unknown device, over-cap and revoked grants, a lost device, and a stale recovery secret. |
| 2026-07-24 | Disposable Midnight localnet + Midnames Preview `83f8422`, complete rerun | Alias-routed shielded custody | Passed | `alice.night` resolved externally to C1 `e978b1c2…efa66`; resolver deployment `009cb71a…07e15`, registration `0048dc1d…6c0b1`, and deposit `003a932e…40fdee` completed. The indexed C1 ledger confirmed 500 shielded units. |
| 2026-07-24 | `http://localhost:5175` | Dynamic initialization and auth surfaces | Passed | Portal loaded without console errors; Dynamic showed email, Discord, and passkey options. No credentials were submitted during this run. |
| 2026-07-24 | `http://localhost:5176` -> Passport popup | Separate-origin public-profile handshake | Passed to consent boundary | Origin/source/request ID/nonce handshake reached “waiting for approval.” Final field return requires an authenticated user decision and was not automated. |
| 2026-07-24 | Production build | SDK, Passport UI, Atlas client, and PWA structure | Passed | 13 SDK tests, 37 contract simulator tests, C1 draft check, both Vite builds, and 40/40 PWA checks passed. |
| 2026-07-24 | Passport production bundle | Localnet proving assets | Passed | The build contains the Passport C1, account-custody, faucet, and identity-registry prover assets. Production/preview no longer depends on Vite serving source-only `/zk` directories. |
| 2026-07-24 | Passport UI, `?demoMode=local` | C1 unshielded/shielded custody controls | Ready for user-gesture run | The polished client now calls the same real `deposit_night`, `withdraw_night`, `deposit_shielded`, and `withdraw_shielded` paths covered by the localnet lifecycle suite, waits for indexed ledger state, and records returned hashes. Browser execution still requires the tester's Passport passkey approval. |
| 2026-07-24 | Dynamic 4.93.1 | Arbitrary C1 proof/finalization | Externally blocked | Required capability methods are absent. The adapter now fails before proof generation and never substitutes transfer-only signing or a discarded message signature. |
| 2026-07-24 | Sig.Network 0.10.0 | Direct Passport C1 settlement composition | Externally blocked | Public Sig release targets Ledger v9/ZKIR v3; Passport C1 prototype targets Ledger v8/ZKIR v2. A coordinated contract/provider port is required. |

The next live run must append the actual account-safe result, transaction hash
where one exists, error text where it fails, and the tested Dynamic environment.
