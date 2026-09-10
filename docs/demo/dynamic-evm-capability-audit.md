# Dynamic EVM signing for the Passport account — capability audit

**Date:** 2026/09/10
**Scope:** passport-demo issue #20 (stage 1: sign every account-contract call with a Dynamic EVM embedded wallet; social login), read against the signature seam Nicolas merged on 2026/09/09 (passport PR #152, the k256 arm with per-device envelopes).
**Method:** the shipped packages (`@dynamic-labs/sdk-react-core` 5.8.0, `@dynamic-labs/ethereum` 5.8.0, `@dynamic-labs/embedded-wallet-evm` 5.8.0, `@dynamic-labs/wallet-connector-core` 5.8.0, `@dynamic-labs/sdk-api-core` 0.37.0) were unpacked and their type surface read; the two documentation pages the issue links were fetched. Nothing below was run against a live Dynamic environment yet.

## What the contract verifies

The k256 arm (`contract/contracts/account.compact` on `main`) verifies an ECDSA-secp256k1 signature over `SHA-256(prefix(envelope) || challenge)`. The envelope is an id fixed at enrolment:

| id | prefix | intended signer |
|---|---|---|
| 0 | (empty) | software, HSM, and MPC signers driven directly |
| 1 | `midnight_signed_message:32:` | keys behind the dApp-connector `signData` surface |

There is no keccak-256 in Compact, so an EIP-191 `personal_sign` signature (keccak-256 over `"\x19Ethereum Signed Message:\n" + length + message`) cannot be verified by any envelope. This is the crux.

## What Dynamic ships

| Capability | Status | Evidence |
|---|---|---|
| Social login: Discord, Google, Microsoft, X | **Present** | `ProviderEnum` in `@dynamic-labs/sdk-api-core` 0.37.0 carries `discord`, `google`, `microsoft`, `twitter`. Enabled per provider in the dashboard. |
| Embedded EVM wallet created on login | **Present** | `@dynamic-labs/embedded-wallet-evm` 5.8.0; the MPC setup page: enable Embedded Wallets, choose chains, choose automatic creation on sign-up. |
| `primaryWallet.signMessage(text)` | **Present, but EIP-191** | Documented on the linked page; this is `personal_sign`, keccak-256 based. **Not verifiable by the k256 arm.** |
| Typed-data signing | Present, keccak-256 | `SignMessageEvmTypedData` in the API model. Same problem. |
| Raw signing with a chosen hash | **Present at the interface level, unverified end to end** | `IDynamicWaasConnector.signRawMessage({ accountAddress, context, message, password })` in `@dynamic-labs/wallet-connector-core` 5.8.0; the API model `SignMessageRawSign` takes `payload` (hex pre-image) and `hashFunction` in `{ sha512Half, keccak256, sha256, blake2b }`, with a note that `sha256` is "guarded against 32-byte pre-hashed payloads". No implementation of `signRawMessage` was found in the four client packages unpacked; it may live in a package not yet inspected, or be server-gated. |
| Recovery on another device | Present | MPC key shares with password or cloud-provider recovery (`createOfflineRecoveryShares`, `getWalletRecoveryState`). This is the "restore on another device" message stage 2 asks for. |

## The named gap

For a Dynamic EVM embedded wallet to authorise account-contract calls, one of these must hold:

1. **Dynamic exposes raw ECDSA signing with `hashFunction: sha256`** for EVM embedded wallets, taking a pre-image longer than 32 bytes. Then envelope 1 fits as-is: pre-image = `midnight_signed_message:32:` || challenge (59 bytes, so the 32-byte pre-hash guard does not apply), digest = SHA-256 of it, exactly what the circuit recomputes. Nothing changes on the contract.
2. Otherwise a **new envelope** would be needed whose digest the circuit can recompute, and keccak-256 is not available in-circuit, so `personal_sign` cannot be admitted. This path is closed unless Compact gains keccak.

So the question to put to Dynamic before any client code is written: **is `signRawMessage` (raw sign, `sha256`, arbitrary-length pre-image) available to EVM embedded (MPC) wallets from the React SDK, and does it return a plain 64-byte r‖s (or r‖s‖v) secp256k1 signature?** If yes, stage 1 is a client integration only. If no, the integration cannot use the k256 arm, and that has to be said before an estimate is given (working agreement on passport #106).

## Second dependency: the demo runs the prototype contract

The demo's deployed account contract is the prototype (hash-preimage device witness, one qualified coin per colour in public ledger state), not the k1-arm reference. Signing account calls with a Dynamic key therefore also needs the demo to move to the k1-arm contract, which is a new contract address for every Passport and a migration (drain, deploy, re-point the name, re-fund). The one-transaction transfer work (#13) already carries a migration of the same shape; doing the two together would spare users a second upgrade. That is a sequencing decision for the next call, not a unilateral one.
