# local-tee-poc — TEE Device Key Registration Proof of Concept

Demonstrates the **TEE device key registration pattern** on Midnight:
a Compact contract whose state can only be updated by a holder of a specific
TEE device key, with no validator changes and no new MPC infrastructure.

The full design rationale is in
[`artifacts/tee-device-key-registration.md`](../../artifacts/tee-device-key-registration.md).

---

## Use Case

Regulated services operating on Midnight need to verify that a participant meets
a compliance threshold (KYC tier) without acquiring or storing personally
identifiable information.  The participant's TEE device acts as a hardware-bound
identity anchor: it holds a private key that was never transmitted over a network,
and the on-chain contract records only the corresponding public key and the
compliance tier.  Compliance tier updates are authorised by proof of the same key,
establishing continuity of control without re-identifying the participant.

### User stories

**As an individual who wants to access a regulated service on Midnight,**
I want to register my TEE device key on a Midnight smart contract once,
so that my device becomes the sole authority that can attest to my compliance
status, and no third party can forge or revoke that attestation without
physical access to my device.

**As an individual whose identity has been verified by a KYC provider,**
I want my TEE device to submit my compliance tier to the contract on my behalf,
so that on-chain services can confirm my verification status without my personal
data — name, date of birth, jurisdiction — ever appearing on the public ledger
or being held by the service itself.

**As a regulated DeFi protocol or on-chain service,**
I want to read a participant's compliance tier from a Midnight contract,
so that I can enforce access controls based on verifiable, privacy-preserving
credentials rather than a centralised whitelist, an off-chain identity check,
or a copy of the participant's documents.

---

## What This Demonstrates

| Component | Production (Tier 3) | This PoC (Tier 1) |
|---|---|---|
| TEE enclave | SGX enclave (e.g. Azure DCsv3 + Gramine) | In-process stub (RAM only) |
| `sk_device` at registration | Encrypted to TEE-attested proof server | In plaintext process memory |
| `sk_device` at update | Never leaves enclave (Schnorr signature only) | Never leaves stub TEE (same) |
| KYC evaluation | Verified documents inside enclave | User-entered form fields |
| Identity commitment | Poseidon hash (ZK-friendly) | SHA-256 truncated to 31 bytes |
| Schnorr signing | Same Jubjub curve, in-enclave | Via contract's own pure circuits |
| ZK circuit | Same (no changes needed) | Same |
| On-chain contract | Same | Same |

See the [TEE Hardware Survey](#tee-hardware-survey-and-implementation-progression) section
for intermediate tiers (TPM-backed, Android StrongBox) available on existing hardware.

**The ZK circuit itself is identical to what a production deployment would use.**
At registration, `sk_device` is passed to the proof server (which in production
would be TEE-attested).  For all subsequent updates, `sk_device` never leaves
the stub TEE — only a Schnorr signature `(R, s)` is passed to the proof server.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  TUI (Ink / React)                                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │Dashboard │ │ Setup    │ │ Register │ │  Update  │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
│              calls useCompliance hook                    │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│  useCompliance hook (src/hooks/useCompliance.ts)         │
│  - Wallet setup (bip39 → HD keys → WalletFacade)        │
│  - deploy / connect / register / update / reset          │
│  - Polls on-chain state every 10 s                       │
└─────────┬────────────────────────┬───────────────────────┘
          │                        │
┌─────────▼─────────┐  ┌──────────▼──────────────────────┐
│  Stub TEE         │  │  Midnight SDK                    │
│  (stub-tee.ts)    │  │  deployContract / callTx         │
│  - HKDF sk_dev    │  │  ZK proof: register_device()     │
│  - KYC eval       │  │            update_compliance()   │
│  - Schnorr sign   │  │  pureCircuits: nonce_point,      │
│    via pureCircts │  │    schnorr_challenge             │
│  - identity hash  │  │  LevelDB private state           │
└───────────────────┘  └─────────────────────────────────┘
```

---

## Contract: `contracts/compliance.compact`

### Public ledger state (on-chain, visible to all)

| Field | Type | Description |
|---|---|---|
| `compliance_tier` | `Uint<8>` | 0 = unverified, 1 = basic KYC, 2 = enhanced, 3 = institutional |
| `device_registered` | `Boolean` | Whether a TEE device key has been registered |
| `device_pk` | `NativePoint` | TEE device public key: pk = sk_device · G (Jubjub) |
| `update_count` | `Uint<64>` | Monotonically increasing; replay-protection ready |

### Non-exported ledger state (not accessible via public ABI)

| Field | Type | Description |
|---|---|---|
| `identity_commitment` | `Field` | Hash of (name ‖ dob ‖ jurisdiction) |

> **Note on privacy:** Compact requires `disclose()` even for non-exported ledger fields
> when the value is a circuit witness parameter.  The `export` keyword controls ABI visibility
> (whether the field appears in the `ledger()` call read by the indexer), but the precise
> on-chain footprint of non-exported fields — whether the committed value is recoverable
> by an observer with access to the full state tree — warrants further investigation before
> making strong privacy claims about `identity_commitment`.

### Circuits

**`register_device(sk_device: Field)`** — one-time device registration.
- Computes `pk = ecMulGenerator(sk_device)` inside the ZK circuit.
- `sk_device` is a private ZK witness — never in any public output.
- Stores `pk` in `device_pk` (public).
- `sk_device` is the only time the device's private scalar is passed to the proof server.

**`update_compliance(sig_r, sig_s, new_tier, new_identity_commitment, nonce)`** — TEE-authorised update via Schnorr signature.
- Verifies a Schnorr signature `(sig_r, sig_s)` produced by the stub TEE:
  `assert ecMulGenerator(sig_s) == ecAdd(sig_r, ecMul(device_pk, c))`
  where `c = persistentHash(sig_r ‖ device_pk ‖ new_tier ‖ new_identity_commitment ‖ update_count ‖ nonce) as Field`.
- `sk_device` is **not** a circuit parameter — it stays inside the stub TEE.
- The `nonce: Uint<64>` is a retry counter chosen by the TEE so that the hash
  value (as a little-endian integer) falls below JUBJUB_R (~5.7% chance per try;
  ~17 expected iterations). This is needed because `Bytes<32> as Field` is a
  range-checked cast that fails for values ≥ FIELD_MODULUS, and `ecMul` requires
  its scalar argument to be < JUBJUB_R. See `lessons-learned.md §10`.
- Writes `new_tier` to public state and `new_identity_commitment` privately.

**`reset_device()`** — emergency permissionless reset (PoC only).

### Schnorr signature verification via `ecMul`

`ecMul(a: NativePoint, b: Field): NativePoint` is available in Compact 0.4.0
(runtime 0.14.0 — the version used in this PoC). This enables full Schnorr
verification in-circuit using only `ecMulGenerator`, `ecAdd`, and `ecMul`.

Two exported pure circuits allow the stub TEE to produce valid signatures
without any external Jubjub library:

```
export pure circuit compute_nonce_point(r: Field): NativePoint  → R = r·G
export pure circuit compute_schnorr_challenge(..., nonce): Bytes<32>  → raw hash bytes
```

The TypeScript caller inspects the `Bytes<32>` value as a little-endian bigint
and retries with `nonce++` until the value is below JUBJUB_R, then passes that
nonce to the circuit. The circuit recomputes the same hash and casts it to `Field`
(which always succeeds because the TypeScript already confirmed it is in range).

**Security consequence:** `sk_device` is passed to the proof server only once
(registration). Every subsequent update sends only a Schnorr signature `(R, s)` —
a single-use, message-bound, replay-protected token. An adversarial proof server
for update calls learns nothing useful.

---

## Prerequisites

- Node.js 20+
- [Compact compiler](https://docs.midnight.network) — to compile the contract
- Midnight proof server running locally on `http://localhost:6300`
  (or configured via the Network screen)
- A Midnight wallet mnemonic (24 BIP-39 words) with some DUST for fees

---

## Getting Started

**1. Install dependencies**

```
npm install
```

**2. Compile the contract**

```
npm run compile
```

This produces `contracts/managed/compliance/`.

**3. Start the TUI**

```
npm start
```

Or via Nix from the repo root:

```
nix run .#local-tee-poc
```

---

## Screens

### 1 · Dashboard

Overview of network, wallet, and contract state:
- Network and node/indexer URLs
- Wallet sync status and address
- Current compliance tier (colour-coded)
- Device registration status and update count

### 2 · Setup

Deploy a new compliance contract or connect to an existing one:
- **Deploy new** — generates a ZK proof (30–60 s), deploys contract, saves address
- **Connect** — enter an existing contract address to reconnect

### 3 · Register

Register the stub TEE device key on the contract.

The circuit receives `sk_device` as a private ZK witness, computes
`pk = sk_device · G`, and stores `pk` on-chain.
This is the only time `sk_device` is passed to the proof server.

### 4 · Update

Submit KYC data for evaluation by the stub TEE:
- Full name, date of birth, jurisdiction code
- The stub TEE derives a tier (0–3) from data completeness
- The stub TEE computes `identity_commitment = SHA-256(name|dob|jurisdiction)`
- The stub TEE produces a Schnorr signature `(R, s)` over the new state using
  `compute_nonce_point` and `compute_schnorr_challenge` from the contract's own
  pure circuits — `sk_device` does not leave the stub TEE
- The circuit verifies the Schnorr signature, writes tier publicly, writes
  commitment privately (LevelDB only)

### 5 · Network

Configure the Midnight network, node/indexer/proof-server URLs, and the wallet
mnemonic.

### 6 · Logs

View the application debug log (`~/.local-tee-poc.log`).

---

## Key Files

| Path | Purpose |
|---|---|
| `contracts/compliance.compact` | Compact contract source |
| `src/tee/stub-tee.ts` | Stub TEE (HKDF-derived device key, simulated KYC) |
| `src/hooks/useCompliance.ts` | Main hook: wallet setup, contract calls, state polling |
| `src/screens/Dashboard.tsx` | Live contract state overview |
| `src/screens/Update.tsx` | KYC form and TEE-authorised update |

---

## Limitations and Production Path

| Limitation | Production solution |
|---|---|
| `sk_device` in RAM at registration | Generate inside SGX/TrustZone; never extract; use TEE-attested proof server for the one-time registration |
| Updates: `sk_device` never leaves stub TEE (same as production) | — already correct |
| KYC is a form | Verified documents inside enclave from KYC provider |
| Identity commitment is SHA-256 | Poseidon hash (ZK-friendly, circuit-compatible) |
| Proof server is untrusted (registration only) | TEE-attested remote proof server; encrypt `sk_device` to server attestation key |
| `reset_device` is permissionless | Add ZK recovery path using pre-committed recovery secret |

See [`artifacts/tee-device-key-registration.md`](../../artifacts/tee-device-key-registration.md)
for the full production design including the dual-path (TEE + ZK recovery) architecture,
a circuit complexity analysis (what stays in ZK vs. moves to the TEE), a security analysis
of the tier/commitment binding, and a correction to the DUST fee model (tDUST = testnet
DUST; DUST uses the same commitment/nullifier Merkle paradigm as ZSwap, so a remote proof
server is required even for dApps with no private NIGHT movements).

---

## Implementation Progression

This PoC is Tier 1 in a five-tier progression toward a fully hardware-isolated device
key.  The ZK contract and circuit are unchanged across all tiers.

| Tier | Platform | `sk_device` protection | Works on phone | Status |
|---|---|---|---|---|
| **1 — Stub** | Any (in-process) | HKDF-derived from wallet seed; plaintext RAM during proving | n/a | ✓ Done (this PoC) |
| **2 — TPM-backed** | x86_64 laptop with TPM 2.0 | Sealed by TPM; in RAM only during proving | No | Not implemented |
| **2b — Android StrongBox** | Pixel + GrapheneOS | Root in Titan M2; in RAM during proving | Yes | Not implemented |
| **2c — Ledger Nano** | USB dongle | Hardware-bound; released only on button press | Yes (OTG/BLE) | Not implemented |
| **3 — SGX enclave** | Azure DCsv3 | Never leaves enclave; Jubjub in-enclave | No | Not implemented |

For the full platform survey, hardware detection commands, Ledger app design, NixOS
toolchain notes, and cloud SGX options, see
[`artifacts/tee-device-key-registration.md §Hardware Platform Survey`](../../artifacts/tee-device-key-registration.md).
