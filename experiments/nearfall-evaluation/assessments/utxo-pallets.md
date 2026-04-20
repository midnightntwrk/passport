# 🤖 UTXO Pallets for Substrate

**Date:** 2026-04-07
**Context:** NEARFall feasibility study — assessing whether a UTXO runtime on Substrate is a viable path.

---

## Summary

No production-grade, general-purpose UTXO pallet exists for FRAME-based Substrate chains. The ecosystem is thin and architecturally immature relative to Cardano's EUTXO model. If UTXO semantics are a requirement, the Substrate path carries high risk.

---

## What Exists

### 1. `substrate-developer-hub/utxo-workshop` (educational)

- Bitcoin-like UTXO implemented as a single FRAME pallet.
- Originally authored by Dmitriy Kashitsyn (Parity Technologies).
- Key design: UTXO hashes become tx pool tags (`requires`/`provides`), enabling dependency ordering in the account-model pool. Priority = `sum(inputs) − sum(outputs)` (the fee).
- **Status:** Unmaintained since ~2020–21. Multiple forks exist; none are production-grade.
- **Throughput:** No benchmarks. Not suitable for measurement.

### 2. Tuxedo (Off-Narrative-Labs) — most technically serious

- W3F-grant-funded project. Replaces FRAME entirely with a UTXO runtime framework.
- **Not a pallet on top of FRAME** — a parallel runtime paradigm using the same Substrate node machinery (P2P, consensus, RPC, tx pool) but with UTXO execution logic.
- Core abstractions mirror Cardano:
  - **Constraint Checkers** ≈ Cardano validators (verify state transition constraints).
  - **Verifiers** — determine whether a specific input UTXO can be consumed.
  - **Dynamic typing system** — type-safe storage of arbitrary data in the UTXO set.
- Includes a proof-of-concept CLI wallet and template node.
- MLabs implemented CryptoKitties on Tuxedo for comparative analysis.
- **Status:** Active R&D; not production-ready.

**Documented gaps (MLabs, 2024):**

| Gap | Impact |
|---|---|
| No smart contracts | Requires external backend; eliminates on-chain composability |
| No light client | Full-chain sync (minutes); impractical for browser/mobile |
| Wallet incompatibility | Talisman (dominant Substrate wallet) cannot sign UTXO txs |
| No tx status tracking | Apps cannot confirm inclusion |
| No UTXO metadata standard | No equivalent to Cardano CIP-68 (NFT/datum patterns harder) |
| No Cumulus/parachain support | Cannot be deployed as a Polkadot parachain |
| FRAME ecosystem incompatible | Loses staking, governance, XCM, ink! smart contracts |

- **Throughput:** No published benchmarks.

### 3. Midnight Network (IOG) — only known production deployment

- Built on the Polkadot SDK (Substrate). Mainnet genesis: March 30, 2026 (federated: 9 validators).
- **Hybrid UTXO + account model:**
  - Public/unshielded state → account model.
  - Private/shielded state → UTXO with nullifier set (nullifier = Hash(UTXO\_id, ownerSecret); appended to global set, never deleted).
- Private state transitions processed entirely off-chain via ZK proofs (Kachina Protocol); only the ZK proof is submitted to the public ledger.
- **Throughput:** 1,000+ TPS claimed. Achieved via BLS12-381 curve migration (verification time: 12 ms → 6 ms; tx size reduced).
- **Caveat:** This is a ZK-privacy chain with a specialized architecture — not a general-purpose UTXO runtime. The TPS figure reflects ZK proof optimization, not general UTXO throughput.

---

## Throughput Summary

| System | TPS | Notes |
|---|---|---|
| `utxo-workshop` pallet | No benchmarks | Educational; unmaintained |
| Tuxedo | **No benchmarks published** | R&D only |
| Midnight (hybrid UTXO + ZK, Substrate) | **1,000+ TPS claimed** | ZK-privacy chain; highly specialized |
| Substrate account-model parachain (async backing) | **~623K sTPS** (balance transfers, Kusama "Spammening" 2024) | Account model only; not UTXO |

The 623K sTPS figure is for standard balance transfers on an account-based parachain — no equivalent figure exists for any UTXO Substrate runtime.

---

## Fundamental Architectural Tension

FRAME is designed for the account model. Developer documentation explicitly states: *"If you are designing a UTXO-based system, FRAME may not be of much use."*

This forces a binary choice:

| Approach | Trade-off |
|---|---|
| UTXO pallet on top of FRAME (utxo-workshop pattern) | Architectural compromise; limited, no smart contracts, no ecosystem fit |
| Replace FRAME entirely (Tuxedo pattern) | Loses the entire FRAME/Polkadot SDK ecosystem (staking, governance, XCM, Cumulus, ink!) |

UTXO's theoretical throughput advantage — natural parallelism across disjoint UTXO sets — has not been empirically validated on any Substrate runtime at scale. Contention on shared UTXOs (e.g., liquidity pools) serializes, negating the advantage in DeFi-like workloads.

---

## Assessment for NEARFall

- **No UTXO-on-Substrate system has demonstrated 500+ TPS** in a general-purpose, non-ZK-specialized configuration.
- Tuxedo is the most serious option but lacks parachain support and smart contract capability — both likely requirements.
- The ecosystem gap vs. Cardano's EUTXO model (Plutus, CIP-68, mature tooling, Aiken) is substantial.
- Midnight is the only production precedent, but its architecture is purpose-built for privacy and is not reusable as a general UTXO runtime without significant rework.
- **Risk rating:** High. A UTXO runtime on Substrate would require either accepting Tuxedo's maturity gaps or building a novel FRAME-alternative from scratch.

---

## Sources

- [substrate-developer-hub/utxo-workshop](https://github.com/substrate-developer-hub/utxo-workshop)
- [UTXO on Substrate — Parity Technologies blog](https://medium.com/paritytech/utxo-on-substrate-7f0e0576768e)
- [Off-Narrative-Labs/Tuxedo](https://github.com/Off-Narrative-Labs/Tuxedo)
- [Tuxedo core Rust docs](https://off-narrative-labs.github.io/Tuxedo/tuxedo_core/index.html)
- [mlabs-haskell/TuxedoDapp](https://github.com/mlabs-haskell/TuxedoDapp)
- [MLabs: CryptoKitties comparative analysis (Ethereum, Cardano, Tuxedo/Polkadot)](https://www.mlabs.city/blog/cryptokitties-on-utxo)
- [JoshOrndorff/extended-utxo (conceptual precursor to Tuxedo)](https://github.com/JoshOrndorff/extended-utxo)
- [Midnight UTXO model docs](https://docs.midnight.network/concepts/utxo)
- [Midnight Mainnet Is Live — DEV Community](https://dev.to/midnight-aliit/midnight-mainnet-is-live-the-privacy-stack-just-got-real-4d65)
- [Midnight: State of the Network — February 2026](https://midnight.network/blog/state-of-the-network-february-2026)
- [paritytech/polkadot-stps (sTPS benchmark repo)](https://github.com/paritytech/polkadot-stps)
- [Async Backing: 10x throughput lift on parachains — Polkadot blog](https://polkadot.com/blog/the-way-to-a-10x-throughput-lift-on-parachains/)
- [input-output-hk/partner-chains](https://github.com/input-output-hk/partner-chains)
