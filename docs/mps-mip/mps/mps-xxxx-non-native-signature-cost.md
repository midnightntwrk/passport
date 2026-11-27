---
MPS: xxxx # assigned by editors
Title: Proving Cost of Non-Native Signature Verification
Authors: Hector Bulgarini <hector.bulgarini@midnight.foundation> (hbulgarini), Nicolas Di Prima <nicolas.diprima@iohk.io> (NicolasDP), Facundo Lerena <facu@midnames.com> (faculerena)
Status: Proposed
Category: Core
Created: 26-NOV-2026
Requires: none
Replaces: none
MIP: none
---

<!--
 Copyright 2026 Midnight Foundation

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

     https://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
-->

## Abstract

A signature scheme is *non-native* to Midnight circuits when its arithmetic runs modulo a different prime from the proof system's scalar field, over which Jubjub is defined. Every field operation must then be emulated with multi-limb arithmetic over many constraints. This is also called foreign-field or emulated arithmetic, and Midnight's circuit library uses the term "foreign". The cost is compounded when the scheme's message encoding requires SNARK-unfriendly, byte-oriented hashes such as SHA-256 or Keccak-256. Midnight verifies Jubjub Schnorr natively and cheaply. Almost every signer that users and institutions already trust uses a non-native scheme instead. Passkeys (WebAuthn), Apple Secure Enclave and Android StrongBox keys, cloud KMS and HSM keys, and EVM wallets such as MetaMask all sign with ECDSA over P-256 (`r1`) or secp256k1 (`k1`). Compact 0.35 can verify `k1` and `r1` signatures in-circuit, so the gap is no longer expressiveness but cost. This MPS measures those two schemes as the most widely deployed cases of the problem. In a benchmark of the 52-circuit Passport account contract, the same account operation needed 1.5–2.3× the circuit rows when authorised with `k1` and 2.8–6.1× with `r1`, compared with Jubjub Schnorr. Every signature-authorised operation moved to a proving domain of 2<sup>17</sup> (`k1`) or 2<sup>18</sup> (`r1`). On an Apple M4 Max, a typical operation that proved in about 2–4 s with Jubjub took about 10 s with `k1` and about 20 s with `r1`. In the P-256 circuit that rotates the account's encryption key, 83% of the circuit is signature authorisation: 52.9% prepares the WebAuthn digest and 30.2% checks the ECDSA signature. This MPS describes the gap. Products that must accept non-native signatures pay a proving cost that degrades interactive use. The cost will be higher on consumer and mobile hardware, which this benchmark did not measure. This MPS does not propose a solution.

## Vision

A user can authorise a Midnight action with the key they already have, whether a passkey, a device secure enclave, an institutional HSM or KMS key, or an EVM wallet, without a material proving penalty compared with Midnight's native curve. Developers no longer have to choose between good latency and support for the signers their users already hold. An operation authorised by a `k1` or `r1` signature stays in the same proving-cost class as its native-curve equivalent. Message preparation is included in that cost, such as SHA-256 over WebAuthn client data or Keccak-256 for EIP-191 and EIP-712. The cost is predictable, published per reference workload, and acceptable on the hardware where proofs are actually generated: laptops, phones, and browsers. Users who keep their witness local should not have to hand it to a third-party prover to get usable latency.

## Problem

**Scope.** The problem is the proving cost of verifying any non-native signature scheme in-circuit, including the SNARK-unfriendly hashing its message encoding requires. The evidence below covers `k1` and `r1`, because almost every deployed hardware, platform, and wallet signer uses them. Other non-native schemes share the problem class but have not been measured here: Ed25519, RSA ([MPS-0009](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mps/mps-0009-sig-rsa.md)), and post-quantum schemes such as ML-DSA (upstream PR [#434](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/434)).

### 1. The native scheme is the one no deployed signer supports

Midnight circuits verify Schnorr over Jubjub with native field arithmetic. Hardware and platform signers do not offer that scheme:

| Signer class | Curves typically available | Notes |
|---|---|---|
| Passkeys / WebAuthn authenticators | P-256 (`ES256`) | `ES256` is the algorithm relying parties can rely on across platform authenticators. The signed message is `authenticatorData ‖ SHA-256(clientDataJSON)`, not a caller-chosen digest. |
| Apple Secure Enclave | P-256 | CryptoKit exposes only P-256 keys in the Secure Enclave. |
| Android Keystore / StrongBox | P-256 | Hardware-backed EC keys use NIST curves. |
| Cloud KMS / HSM (AWS, Google Cloud, Azure) | P-256 and secp256k1 | Both are offered as key specifications; Jubjub is not. |
| EVM wallets (MetaMask and others) | secp256k1 | Messages are wrapped as EIP-191 or EIP-712 and hashed with Keccak-256 before signing. |

A product can either hold a software Jubjub key itself, which gives up the key-custody guarantees these signers provide, or verify `k1` or `r1` in-circuit and pay for it. Passport's [temporary Jubjub bootstrap amendment](../mips/mip-0013-temporary-jubjub-bootstrap-amendment.md) uses an app-held Jubjub key only until the user installs a passkey. It does not remove the need for in-circuit P-256.

### 2. Measured cost

The evidence comes from the Passport account benchmark ([`experiments/acc-profile`](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/experiments/acc-profile/README.md), Passport PR #217). The setup was Compact 0.35.0 (ZKIR v3) with proof server 9.0.0-rc.8, running locally on an Apple M4 Max with an 8-vCPU, 23 GiB ARM64 Docker VM. One request covers artefact upload over loopback and proof generation. Signing, wallet balancing, and chain inclusion fall outside the timer.

**How the measured circuits are built.** Every signature-authorised export of the Passport account contract has the same three parts:

1. It builds a challenge that binds the contract address, the operation arguments, and a replay nonce.
2. It calls the authorisation helper for its signature arm.
3. It runs an operation body that all three arms share.

Because the body is identical across arms, the difference between the columns of the account table below is the cost of authorisation alone. The links below point to the measured revision. The benchmark ran at `df04567`, whose `contract/` tree is identical to `105ee3f`.

| Arm | Authorisation helper | What it proves in-circuit |
|---|---|---|
| Jubjub Schnorr | [`require_authorised_with_jubjub`](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/account.compact#L847) | Rejects small-order keys, checks that the device entry is enrolled and rolls its use counter, then checks `s·G == R + c·pk` using Jubjub arithmetic native to the proof system. |
| secp256k1 (`k1`) | [`require_authorised_with_k256`](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/account.compact#L881) | Rejects the point at infinity and does the same device-entry check and roll. It then recomputes the signed digest with SHA-256 for both supported envelopes ([`envelope_digest`](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/account.compact#L541)), because a circuit conditional is a select that evaluates both sides. Finally it runs `secp256k1EcdsaVerify`. |
| P-256 WebAuthn (`r1`) | [`require_authorised_with_p256`](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/account-p256.compact#L62) | Does the same device-entry check and roll, then calls [`webauthn_verify_profiled`](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/webauthn.compact#L115). That helper checks the relying-party ID hash and the UP and UV flags. It then rebuilds `clientDataJSON` from the challenge (base64url-encoded in-circuit) and the origin (byte-validated). It does this for both supported browser layouts, the [134-byte](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/webauthn.compact#L72) and the [243-byte](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/webauthn.compact#L86) one, and hashes each with SHA-256. Finally it hashes `authenticatorData ‖ clientDataHash` and runs `secp256r1EcdsaVerify`. |

| Circuit | What it does | Shared body | Source |
|---|---|---|---|
| `verify_k1` | Standalone probe. Verifies one secp256k1 ECDSA signature over a 32-byte prehashed digest and writes the digest to a public ledger field, so the compiler keeps the circuit. | — | [`verify-k1.compact`](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/experiments/acc-profile/primitives/verify-k1.compact#L7) |
| `verify_ecdsa` | The same probe for P-256, plus checks that `r` and `s` are nonzero. | — | [`probe-p256.compact`](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/probe-p256.compact#L13) |
| `verify_webauthn` | A complete P-256 WebAuthn assertion check for the fixed 134-byte `clientDataJSON` layout. | — | [`probe-p256.compact`](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/probe-p256.compact#L20) |
| `verify_webauthn_profiled` | The WebAuthn check the account actually uses, covering both browser layouts. | — | [`probe-p256.compact`](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/probe-p256.compact#L31) |
| `revoke_grant_with_*` | Marks a spending grant previously issued to a dApp as inactive. The body is one map lookup and one map write. | [`do_revoke_grant`](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/account.compact#L2351) | [Jubjub](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/account.compact#L2495) · [k1](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/account.compact#L2420) · [r1](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/account-p256.compact#L249) |
| `remove_device_with_*` | Removes an enrolled device entry. It refuses to remove the last device or the device that authorised the call. | [`do_remove_device`](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/account.compact#L1032) | [Jubjub](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/account.compact#L1359) · [k1](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/account.compact#L1378) · [r1](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/account-p256.compact#L223) |
| `withdraw_shielded_with_*` | Spends a shielded coin held by the account to a user's Zswap public key and returns any change to the account. | [`do_withdraw_shielded`](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/account.compact#L969) | [Jubjub](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/account.compact#L1139) · [k1](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/account.compact#L1157) · [r1](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/account-p256.compact#L190) |
| `withdraw_unshielded_with_*` | Debits the account's unshielded balance mirror and sends the tokens to a user address. | [`do_withdraw_unshielded`](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/account.compact#L945) | [Jubjub](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/account.compact#L1054) · [k1](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/account.compact#L1071) · [r1](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/account-p256.compact#L182) |
| `publish_recovery_session_with_*` | Opens a new recovery session. It replaces the recovery public key and publishes a session nonce, up to four recovery parameters (`phi`), and a 64-byte wrap. It is refused while a recovery is pending. | [`do_publish_recovery_session`](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/account.compact#L2689) | [Jubjub](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/account.compact#L2731) · [k1](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/account.compact#L2754) · [r1](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/account-p256.compact#L259) |
| `rotate_enc_key_with_*` | Replaces the account's inbox encryption key (`enc_key`), which encrypts the descriptions of shielded coins the account holds. The body is a single ledger write. | [`do_rotate_enc_key`](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/account.compact#L1004) | [Jubjub](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/account.compact#L1229) · [k1](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/account.compact#L1244) · [r1](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/contracts/account-p256.compact#L213) |

**Standalone verifiers (prehashed digest, three paired requests per curve):**

| Verifier | Rows | Domain | Mean proof request |
|---|---:|---:|---:|
| secp256k1 ECDSA | 40,409 | `k=16` | 3.78 s |
| P-256 ECDSA | 59,063 | `k=17` | 7.47 s |
| P-256 bounded WebAuthn (134-byte `clientDataJSON`) | 112,156 | `k=17` | not paired |

A secp256k1 check alone uses more rows than entire Jubjub-authorised account operations, such as `revoke_grant` at 26,922 rows.

**The same account operation under three signature arms:**

| Operation | Jubjub Schnorr | secp256k1 (`k1`) | P-256 WebAuthn (`r1`) |
|---|---:|---:|---:|
| `revoke_grant` | 26,922 rows, `k=15`, 2.24 s | 61,912 rows, `k=17`, 9.44 s | 163,482 rows, `k=18`, 19.52 s |
| `remove_device` | 32,776 rows, `k=16`, 4.10 s | 68,314 rows, `k=17`, 9.53 s | 171,758 rows, `k=18`, 19.88 s |
| `withdraw_shielded` | 50,089 rows, `k=16`, 4.23 s | 83,236 rows, `k=17`, 9.77 s | 184,787 rows, `k=18`, 20.03 s |
| `publish_recovery_session` | 36,491 rows, `k=16`, 4.25 s | 72,217 rows, `k=17`, 10.00 s | 173,788 rows, `k=18`, 20.64 s |
| All 15 signature-authorised operations | `k=15`–`17` | `k=17`, rows ×1.5–2.3 | `k=18`, rows ×2.8–6.1 |

In a separate paired run, `rotate_enc_key` averaged 11.07 s with `k1` and 25.13 s with `r1`. Its operation body is a single ledger write, so nearly all of that time is spent on authorisation.

### 3. Where the rows go

- **The signer's message format dominates `r1`.** In `rotate_enc_key_with_p256`, which has 163,324 rows, preparing the WebAuthn digest adds 86,363 rows (52.9%). That step base64url-encodes the challenge, validates the origin bytes, and rebuilds and SHA-256-hashes `clientDataJSON` for both browser layouts. It then hashes the 69-byte signed message. Checking the ECDSA signature adds 49,275 rows (30.2%), leaving about 17% for challenge construction, the device-entry roll, and the single-write operation body. The equivalent Jubjub circuit has 26,764 rows in total, fewer than the P-256 signature check alone. Supporting a second browser layout costs real rows, because a circuit pays for both sides of every conditional. ([Stage boundaries](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/experiments/acc-profile/primitives/profile.py#L65).)
- **`k1` also pays for envelope hashing.** The `k1` arm recomputes two SHA-256 envelope digests on every call before the curve check, for the same select-not-branch reason.
- **Part of the cost is in the library, not the curve.** Computing `0 × G` for the public-key identity check adds 11,651 of 40,409 rows (28.8%) in the standalone secp256k1 verifier and 21,855 of 59,063 (37.0%) in P-256. This step sits inside the lowering of the standard-library `secp256k1EcdsaVerify` and `secp256r1EcdsaVerify`, not in Passport code ([stage labels](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/experiments/acc-profile/primitives/profile.py#L22)). A cheaper representation of the same check would help both curves.
- **Keccak is not yet in the measured path.** The measured `k1` arm signs a SHA-256 envelope. A MetaMask `personal_sign` or EIP-712 signature would also need Keccak-256 in-circuit. That cost is not measured here.

### 4. Proving cost is quantised by domain size

Proving time roughly doubles with each step in `k`. In the sweep, Jubjub operations at `k=15`, `16`, and `17` took about 2.2 s, 4.2 s, and 8 s, while every `k1` operation sat at `k=17` (about 10 s) and every `r1` operation at `k=18` (about 20 s). Optimisations pay off only when they cross a power-of-two boundary. An [experimental variant](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/experiments/acc-profile/profile-sharing/share-encoding.patch) computes the challenge encoding and origin validation once and shares them between the two browser layouts. It cut `verify_webauthn_profiled` from 136,195 to 119,703 rows. That moved it from `k=18` to `k=17` and halved its time (18.82 s → 9.37 s). The same change cut `rotate_enc_key_with_p256` from 163,324 to 137,399 rows, but the circuit stayed at `k=18`, and its time did not change (17.37 s → 17.24 s). A WebAuthn check for a single fixed `clientDataJSON` layout fits at `k=17`, but it is still large: `verify_webauthn` uses 112,156 rows. Supporting the layouts that real browsers produce pushes the check to `k=18`. Every `r1` account operation measured here also sits at `k=18`, including an earlier single-layout account rotation of 129,832 rows ([October measurements](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/P256-MEASUREMENTS.md)).

### 5. Compounding factors

- **Hardware.** These figures come from a high-end desktop. Consumer laptops, phones, and in-browser provers were not measured. They are expected to be slower and more memory-constrained. Passkey and secure-enclave products are mostly used on those devices.
- **Delegated proving moves the problem.** A remote proof server can hide latency, but it receives the witness. That brings in the trust problem of [MPS-0004](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mps/mps-0004-trusted-proof-serving.md) and runs against the reason for using a local hardware signer.
- **Artefact size and key upload.** Prover keys grow with the proving domain. In the [October measurements](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/P256-MEASUREMENTS.md), the prover key for `rotate_enc_key` was 47 MiB with Jubjub (`k=15`), 224 MiB with `k1` (`k=17`), and 448 MiB with `r1` (`k=18`). The 52 account circuits' keys occupy about 12 GiB in total. The measured request times include uploading the prover key, verifier key, and ZKIR to the proof server, so larger keys inflate every request. That makes the latency problem worse, and it adds to the distribution burden described in [MPS-0039](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mps/mps-0039-lightweight-contract-interaction.md) and addressed in part by [MIP-0020](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0020-prover-key-regeneration.md).
- **Memory.** Proving at `k=18` needs several gigabytes. The first full-account P-256 proof was killed for running out of memory in a proof server with about 8 GiB ([failure evidence](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/evidence/p256-webauthn/prover-8gib-oom.json)). The authors also observed one `k=18` proof using about 9–10 GB in the proof server. That figure is not yet recorded in a published run. Memory at this scale is a hard limit for phones and in-browser provers.
- **Signature encoding from real signers.** In the authors' tests, Chromium WebCrypto produced high-`s` P-256 signatures in about half of 600 cases. That result is not yet recorded in a published run, but the Passport verifier probes already prove a [captured real high-`s` WebAuthn assertion](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/contract/P256-MEASUREMENTS.md). A verifier that requires low-`s` would reject a large share of genuine signatures. Any cheaper verification path must either accept high-`s` signatures or normalise `s` in-circuit, and normalising adds cost.
- **Linear scaling.** Every authorised operation pays the cost again. Batches, multi-step flows, and custodial back-ends that sign on behalf of many accounts multiply it.

### 6. Relationship to existing problem statements

[MPS-0010](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mps/mps-0010-sig-verify-ecdsa.md), [MPS-0008](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mps/mps-0008-keccak-hashing.md), and [MPS-0011](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mps/mps-0011-native-crypto-prims.md) addressed whether these primitives *exist* in Compact, and the "poor performance" risk is only a failure scenario in MPS-0010. Compact 0.35 now exposes `secp256k1EcdsaVerify` and `secp256r1EcdsaVerify`. This MPS addresses the next gap: the primitives exist, but their cost makes them impractical for interactive products. [MIP-0003](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0003-ecdsa-support.md) covers ledger-level secp256k1, which is distinct from in-circuit authorisation. [MIP-0030](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0030-ecdsa-account-authorisation.md) specifies the `k1` and `r1` account envelopes measured here.

### Evidence limits

The results come from one machine and one shared local proof server, with two or three samples per circuit. Timings vary with host load: two identical P-256 unshielded withdrawals took 73.21 s and 19.87 s. Row counts and `k` are deterministic and are the primary evidence. Wall-clock figures indicate scale. Per-stage elapsed time and peak memory were not instrumented in this benchmark. Request times include artefact upload to the proof server.

## Use Cases

**Passkey-secured self-custody account.** A user creates a Midnight account protected by the passkey on their phone. Every withdrawal, grant, device change, and recovery step needs a WebAuthn-authorised proof. On a high-end desktop, each takes about 20 s, compared with 2–4 s for the same action with a Jubjub key. On the phone where the passkey lives, the wait is longer and unmeasured. A user facing that wait often gives up, and a product team often falls back to an app-held software key, giving up the security the passkey was meant to provide.

**Mobile app with a hardware-bound key.** A banking or identity app keeps its signing key in the Secure Enclave or StrongBox so the key cannot be exported. Those keys are P-256 only, so every in-circuit authorisation sits in the 2<sup>18</sup> domain and is proved on mobile hardware.

**Institutional custody through an HSM or cloud KMS.** A custodian's policy requires keys to stay in an HSM or KMS that offers P-256 and secp256k1 but not Jubjub. Each customer operation pays the non-native verification cost, and operations across many accounts scale linearly. The custodian must either provision far more proving capacity or accept higher latency on every operation.

**EVM user authorising a Midnight action with MetaMask.** A user who already holds an EVM wallet wants to control a Midnight account or approve a Midnight transaction without installing a new key. MetaMask signs EIP-191 or EIP-712 messages over secp256k1, so the circuit must recompute Keccak-256 and verify `k1`. It pays at least the measured `k1` cost of about 10 s per operation, plus the unmeasured Keccak cost. This is the cross-ecosystem onboarding path that MPS-0010 and MPS-0011 were meant to open.

**Agents and services with managed keys.** An automated agent or back-end holds its authority in a cloud KMS. High-frequency, low-value actions are dominated by signature verification, not business logic, which makes Midnight uncompetitive for these workloads.

## Goals

In priority order:

1. **Same cost class as the native path.** A circuit that authorises an operation with one `k1` or `r1` signature should stay in the same proving domain (`k`) as its Jubjub-authorised equivalent, or within an agreed bounded factor. This is measured on the Passport account operations above or an equivalent public reference workload.
2. **Full signer formats are covered.** The cost bound includes each signer's real message preparation: the WebAuthn `authenticatorData ‖ SHA-256(clientDataJSON)` construction, and EIP-191 and EIP-712 Keccak-256 digests. It is not limited to a prehashed curve check.
3. **Measured on the devices where proofs are made.** Published, reproducible results cover at least one consumer laptop, one mobile device, and one in-browser prover. They report rows, `k`, proof time, peak memory, and prover-key size.
4. **No privacy or custody regression.** Usable latency should not require users to disclose the signer's public key or signature publicly. It should not require them to hand their witness to a third-party prover, unless they choose to. The signer key should stay in its hardware.
5. **Correct and auditable.** Behaviour on edge cases, such as identity and invalid points, zero `r` or `s`, and malformed client data, is defined, and public test vectors cover it. High-`s` signatures from real signers verify, whether accepted directly or normalised.

## Expected Outcomes

- Products can offer passkey sign-in, hardware-bound mobile keys, HSM- and KMS-backed custody, and EVM-wallet authorisation without a proving penalty that rules out interactive use.
- Developers can choose a signer for security and usability rather than proving cost, and they stop shipping app-held software keys as a workaround.
- Institutional integrators can size their proving capacity predictably, with costs comparable to native-curve operations.
- EVM users have a low-friction path into Midnight applications, which supports the interoperability goals of MPS-0010 and MPS-0011.
- Smaller proving domains reduce prover-key size and distribution cost, which complements MPS-0039.
- The ecosystem gains a standard signature-cost benchmark that can catch regressions, in line with [MPS-0020](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mps/mps-0020-performance-benchmarking-improvements.md).

## Open Questions

1. What latency budget counts as acceptable for interactive authorisation, and on which hardware classes? Who sets it: the Foundation, wallet partners, or a working group?
2. How much of the measured cost comes from non-native field arithmetic in the current proof system, and how much comes from library implementation choices, such as the `0 × G` identity check or byte-oriented hashing?
3. What do proof time and peak memory look like on mid-range phones and in-browser proving? Is in-browser proving of a 2<sup>18</sup> circuit feasible at all on common devices?
4. Is verifying the non-native signature outside the user's proof acceptable for some use cases, for example at ledger level and bound to the contract call? What linkability or disclosure would that introduce?
5. Should EIP-191 and EIP-712 Keccak envelopes be first-class targets alongside WebAuthn, and what does Keccak-256 currently cost in-circuit?
6. How do the other non-native schemes compare under the same benchmark: Ed25519 (used by some HSMs and wallets), RSA (MPS-0009), and post-quantum schemes such as ML-DSA (upstream PR #434)? Can one set of solutions serve all of them, or does each scheme need its own?
7. Should verifiers accept high-`s` P-256 signatures directly or normalise `s` in-circuit? What does each option cost, and what are the malleability implications?
8. How should improvements be validated across Compact and proof-server versions so that results stay comparable over time?

## Recommended MIPs

- **Efficient in-circuit ECDSA verification over secp256k1 and P-256.** This MIP should define how Compact and ZKIR verify `k1` and `r1` signatures at a cost compatible with Goal 1, and specify the identity-check semantics and test vectors. It addresses §2, the curve-check share of §3, and Goal 5, and it extends the performance criterion that MPS-0010 left open.
- **Efficient in-circuit hashing for signer envelopes.** This MIP should cover SHA-256 over variable-length byte strings, such as WebAuthn client data, and Keccak-256 for EIP-191 and EIP-712, including the parsing and validation that WebAuthn requires. It addresses the 52.9% digest-preparation share in §3 and Goal 2, and relates to MPS-0008 and MPS-0011.
- **Signature-verification cost benchmark and reporting profile.** This MIP should define reference workloads (standalone verifiers and representative account operations), hardware classes (desktop, laptop, mobile, and browser), required metrics, and a reproducible harness, with the Passport `acc-profile` experiment as one input. It addresses Goal 3 and the evidence limits above, and would sit under MPS-0020's benchmarking work.
- **Evaluation of non-native signature verification outside the user proof.** This MIP should analyse whether, and under what privacy trade-offs, a `k1` or `r1` signature can be checked outside the user's proof while remaining bound to a contract call, possibly building on MIP-0003. It addresses Open Question 4 and must respect Goal 4.

## References (Optional)

- Passport account benchmark: [`experiments/acc-profile`](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/experiments/acc-profile/README.md) and [recorded samples](https://github.com/midnightntwrk/passport/blob/105ee3f217411234956b1fde687c447fed126306/experiments/acc-profile/results.csv), Passport PR #217, measured 2026/11/24.
- [MIP-0030 — ECDSA Authorisation for Custody Accounts](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0030-ecdsa-account-authorisation.md)
- [MIP-0013 — Multi-key Account Authorisation](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0013-account-authorisation.md)
- [MIP-0003 — ECDSA signature support](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0003-ecdsa-support.md)
- MPS-0004, MPS-0008, MPS-0009, MPS-0010, MPS-0011, MPS-0020, MPS-0039 (linked above).
- [Upstream PR #434 — MPS for post-quantum signature verification in Compact](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/434)
- [W3C Web Authentication Level 3](https://www.w3.org/TR/webauthn-3/)
- [EIP-191](https://eips.ethereum.org/EIPS/eip-191) and [EIP-712](https://eips.ethereum.org/EIPS/eip-712)
- [Apple CryptoKit `SecureEnclave`](https://developer.apple.com/documentation/cryptokit/secureenclave)
- [Android Keystore system](https://developer.android.com/privacy-and-security/keystore)
- [AWS KMS asymmetric key specifications](https://docs.aws.amazon.com/kms/latest/developerguide/asymmetric-key-specs.html)

## Acknowledgements

The Midnight Foundation and Input Output Group (IOG).

## Copyright

This MPS is licensed under CC-BY-4.0.
