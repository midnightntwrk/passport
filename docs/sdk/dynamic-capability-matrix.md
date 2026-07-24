# Dynamic Capability Matrix

This matrix follows Dynamic's current [embedded Midnight wallet guide](https://www.dynamic.xyz/docs/react/wallets/using-wallets/midnight/midnight-embedded-wallets).
Validation must be performed against the intended Dynamic environment; a code
build alone is not live proof.

| Capability | Demo implementation | Live acceptance evidence | Status |
|---|---|---|---|
| Discord authentication | Dynamic modal, Discord social filter | Successful login on approved origin | Configuration required |
| Email authentication | Enabled by the Dynamic dashboard | Successful OTP login | Configuration required |
| Embedded Midnight wallet | `MidnightWalletConnectors` | `isMidnightWallet(wallet)` true | Configuration required |
| Three address surfaces | `wallet.address`, `getUnshieldedAddress()`, `getShieldedAddresses()`, and `getDustAddress()` | Unshielded, shielded, and DUST addresses rendered | Configuration required |
| Balance/DUST sync | `getFormattedBalances()` | DUST sync settles or reports a visible pending state | Configuration required |
| Message signing | `wallet.signMessage()` | User approval and resolved signature | Configuration required |
| DUST registration | `wallet.registerDust()` | Returned status and transaction hash, where applicable | Funded wallet required |
| Unshielded transfer | Explicit `createTransferTransaction` -> `signTransaction` -> `submitTransaction` with `type: 'unshielded'` | Confirmed transaction hash | Funded wallet/DUST required |
| Shielded transfer | Explicit `createTransferTransaction` -> `signTransaction` -> `submitTransaction` with `type: 'shielded'` | Confirmed transaction hash | Funded wallet/DUST required |
| Pending cleanup | `wallet.revertAllPending()` | Abandoned transfer can be reverted | Funded wallet/DUST required |
| Passport C1 testnet deployment | Passport builds a real Compact deployment draft, then requires `getMidnightProofCapabilities()` and `proveMidnightTransaction()` before exact-byte approval and submission | Compatible capability response, bound approval receipt, returned transaction hash, and on-chain contract verification | Externally blocked in Dynamic 4.93.1 |

## Required dashboard setup

1. Enable Midnight under **Chains & Networks**.
2. Enable embedded wallets and create them at sign-up.
3. Enable **Private Key Exports** under **Embedded Wallets > Security**. Dynamic documents this as required for Midnight balance reads, signing, and transfers.
4. Enable Discord and/or email sign-in and register local and deployed origins.

The application must report the exact failed operation and environment rather
than converting an unavailable wallet or rate-limit response into an empty
wallet state.

The transfer-only `signTransaction` method is never used as a fallback for C1,
and a Dynamic message signature is never treated as a Compact proof. The C1
preview integration is deliberately testnet-only.
