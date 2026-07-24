# Passport Integration Blockers

| Area | Current boundary | Owner / required input | Passport behavior |
|---|---|---|---|
| Dynamic C1 proof/finalization | Dynamic 4.93.1 supports wallet-native transfers but does not expose a documented `UnboundTransaction -> FinalizedTransaction` proof capability for arbitrary Compact circuits. | Dynamic: versioned capability, proof API, approval UI, structured errors, and regression coverage. | Probe and fail before proving. Never fall back to transfer-only `signTransaction` or a detached message signature. |
| C1 name authorization | Prototype registry writes `handle -> account`, but does not prove control of the nominated C1 account. | Foundation: C1-authorized composition, anti-squatting, recovery/rebinding policy. | Label registry as localnet prototype only. |
| C1 contract-to-contract NIGHT | SDK utility and wallet work remain pending. | Midnight SDK / wallet teams. | Route only supported user-to-contract flows. |
| Dust sponsorship | Wallet-level split balancing is not live-validated on node yet. | Passport fee-model experiment. | Use a funded local/demo wallet; do not promise zero-balance onboarding. |
| Sig.Network | Sig uses Ledger v9, Compact 0.25+, runtime 0.18 RC, Midnight.js 5 beta, and ZKIR v3; Passport C1 currently uses Ledger v8/runtime 0.16/Midnight.js 4/ZKIR v2. No production MPC endpoint is supplied. | Passport: coordinated C1/provider port. Sig.Network: deployed vault, Signet singleton, MPC key/endpoint, and chain configuration. | Keep the five-stage typed adapter fail-closed; use the documented two-transaction route only after the runtime migration. |
| Private-state cloud sync | Witness state currently contains secret material. | Foundation security/recovery design. | Local encrypted storage only; no Drive/Apple blob sync. |
| C23 grant-secret handoff | C1 grants are real and their secrets are encrypted in Passport, but the external-app consent protocol currently shares profile fields only. | Passport: a Foundation-reviewed capability handoff envelope, recipient binding, expiry, and revocation semantics. | Never claim that a labelled external app can spend until it has received and acknowledged the matching grant secret. |
| Recovery enrollment | The disposable-localnet prototype can initialize C1 recovery commitments, but it does not yet provide a production recovery ceremony or durable multi-device share custody. | Foundation: recovery-factor policy, share custody, rotation, loss, and audit design. | Treat current recovery witnesses as prototype state protected by the Passport key, not a production recovery product. |

The demo becomes client-ready only when its core Dynamic checks pass live. Sig,
asset custody, aliasing, and arbitrary contract composition are additive
integrations, not hidden fallbacks.
