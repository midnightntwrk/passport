# Passport Integration Blockers

| Area | Current boundary | Owner / required input | Passport behavior |
|---|---|---|---|
| Dynamic C1 final validation | The C1 pilot now constructs a real Compact testnet deployment and calls Dynamic's public serialized-transaction signing/submission path. It has not yet produced a user-authorized transaction hash and on-chain confirmation in the target Dynamic environment. | Dynamic: confirmation/regression coverage for generic signing; Foundation: artifact, fee model, and network review. | Permit testnet-only user-authorized validation. Record the actual result; never claim active status before finality. |
| C1 name authorization | Prototype registry writes `handle -> account`, but does not prove control of the nominated C1 account. | Foundation: C1-authorized composition, anti-squatting, recovery/rebinding policy. | Label registry as localnet prototype only. |
| C1 contract-to-contract NIGHT | SDK utility and wallet work remain pending. | Midnight SDK / wallet teams. | Route only supported user-to-contract flows. |
| Dust sponsorship | Wallet-level split balancing is not live-validated on node yet. | Passport fee-model experiment. | Use a funded local/demo wallet; do not promise zero-balance onboarding. |
| Sig.Network | No deployed vault, MPC endpoint, Sepolia configuration, or stable Passport handoff contract is available. | Sig.Network: deployment configuration and integration contract. | Show blocked readiness; never simulate a completed bridge. |
| Private-state cloud sync | Witness state currently contains secret material. | Foundation security/recovery design. | Local encrypted storage only; no Drive/Apple blob sync. |

The demo becomes client-ready only when its core Dynamic checks pass live. Sig,
asset custody, aliasing, and arbitrary contract composition are additive
integrations, not hidden fallbacks.
