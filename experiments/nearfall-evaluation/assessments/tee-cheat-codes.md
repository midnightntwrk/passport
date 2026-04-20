# 🤖 TEE as a Privacy Fast Path: NEAR's Pattern and Applicability to Midnight

**Scope:** This document examines how Trusted Execution Environments (TEEs) are used by NEAR Protocol as a practical privacy mechanism, contrasts the TEE trust model with Midnight's ZK-based privacy model, and evaluates where TEE integration could serve as a near-term "cheat code" (Charles Hoskinson's framing, Background 6) for Midnight features that are not yet practical to prove in zero knowledge. The assessment is motivated by Charles's explicit interest in TEE as a fast privacy path and is a first-pass survey; no independent TEE security analysis has been undertaken this increment.

> [!NOTE]
>
> ❓🤖 **SCRUTINY — this is a first-pass survey, not a deep technical analysis.** TEE hardware specifics, attack surface details, and regulatory acceptability are assessed qualitatively rather than from primary sources. A dedicated TEE security study is identified as a next-increment priority.

---

## 1. What Is a TEE?

A Trusted Execution Environment is a hardware-isolated region of a processor where code and data are protected from the host operating system, hypervisor, and other processes. Two properties are central to its use in blockchain contexts:

- **Confidentiality:** data inside the enclave is encrypted in memory; the host OS cannot read it even with root access.
- **Remote attestation:** the enclave can produce a cryptographic certificate — signed by the hardware manufacturer's root key — proving to a remote verifier that specific, unmodified code is running on genuine certified hardware.

The main production platforms are Intel SGX, AMD SEV-SNP, AWS Nitro Enclaves, and ARM TrustZone. They differ in attack surface, attestation mechanism, and cloud availability, but all provide the same core guarantee.

**Trust model:** TEE privacy rests on trusting the hardware manufacturer, the firmware supply chain, and the audited enclave code. Known attack classes include side-channel vulnerabilities (Spectre/Meltdown class, cache-timing), supply chain compromise of the hardware itself, and firmware bugs that allow enclave memory extraction. These attacks are real but require significant resources or physical access; TEE is substantially stronger than software-only isolation while being substantially weaker than a mathematical proof.

---

## 2. How NEAR Uses TEEs

### 2.1 Chain Signatures MPC Network

NEAR's Chain Signatures service (`v1.signer`, launched August 2024) enables a NEAR account to control addresses on any external blockchain via an 8-node threshold MPC network. TEE attestation plays a specific role in the trust model:

- Each MPC node runs the signing protocol inside a secure enclave.
- The enclave produces a remote attestation certificate: a signed proof that this specific version of the signing code, unmodified, is running on genuine certified hardware.
- The threshold scheme (FROST / `cait-sith`) distributes key shares so no single node can sign unilaterally; the TEE adds the guarantee that nodes cannot be running modified code that exfiltrates shares or censors requests.
- Together: **TEE handles execution integrity; MPC handles key custody**. Neither alone is sufficient — a non-TEE MPC node could run modified code; a TEE node without MPC would be a single point of key compromise.

This TEE + MPC hybrid is NEAR's most architecturally significant privacy mechanism and the one most directly relevant to Midnight.

### 2.2 NEAR AI Agents

NEAR's AI agent infrastructure allows agents to run inside TEE enclaves, producing attestations that a specific AI model was executed unmodified on specific inputs. This enables *provable AI inference* — a client can verify the computation without being able to inspect the inputs or model weights. This is a different domain from blockchain privacy but uses the same attestation primitive.

### 2.3 The Common Pattern

Both uses share the same structure: *run sensitive computation in an enclave; present a remote attestation certificate as proof of correct execution*. The certificate replaces a ZK proof in contexts where the ZK circuit either does not exist or would be prohibitively expensive. Charles's "cheat codes" label describes exactly this substitution.

---

## 3. Midnight's Current Privacy Model

Midnight uses ZK proofs (Plonk/KZG on BLS12-381) as its sole privacy mechanism. The trust model is purely mathematical:

- Private state (witnesses, spending keys, contract private state) never leaves the client device.
- The local proof server generates proofs client-side; the server itself is not attested.
- Validators verify proofs but never see private witnesses.
- Privacy holds as long as the KZG polynomial binding assumption holds — no trust in hardware, software, or any party is required.

Midnight **does not currently use TEEs** at any layer of the stack.

---

## 4. Privacy Model Comparison

| Dimension | Midnight ZK | TEE |
|-----------|-------------|-----|
| **Trust assumption** | Hardness of discrete log / KZG polynomial binding | Hardware manufacturer + firmware supply chain + audited enclave code |
| **Privacy guarantee** | Unconditional for any verifier with the proof | Conditional on enclave not being compromised |
| **Attack surface** | Cryptanalytic advances; ZK implementation bugs | Side-channel attacks (Spectre/Meltdown class); supply chain compromise; firmware bugs |
| **Regulatory posture** | Verifiable by any party independently | Requires trusting the attestation certificate chain and hardware vendor |
| **Time to deploy a new private feature** | Months — circuit design, implementation, audit | Weeks — TEE SDK integration, enclave deployment |
| **Failure mode** | Proof system broken → all past privacy compromised | One enclave compromised → that node's secrets exposed |
| **Composability with ZK** | Native | Requires an interface layer between enclave outputs and ZK circuits |
| **Decentralisation** | Full — any verifier independently checks the proof | Partial — verifier must trust the hardware vendor's attestation root key |

### 4.1 "Privacy Without Trust" vs. "Privacy With Bounded Trust"

Midnight's stated positioning is *privacy without trust* — a ZK proof is valid for any verifier who accepts the underlying mathematics, regardless of who produced it or on what hardware. TEE offers *privacy with bounded trust*: the privacy claim is as strong as the weakest link in the chain of hardware manufacturer → firmware → enclave code → attestation certificate.

For enterprise customers who already operate within a trust model that includes hardware vendors (HSMs, secure enclaves are standard in finance and government), TEE-backed privacy may be fully acceptable and is far faster to certify internally than a novel ZK proof system. For Midnight's "privacy for the real world" positioning, both models can coexist: TEE for features that need to ship quickly, ZK for features that require the strongest guarantees.

---

## 5. Where TEE Fits in Midnight

### 5.1 Remote Proof Server (Near-Term, High Value)

**Problem:** The local proof server generates ZK proofs client-side. Mobile devices and browser-based dApps may lack the compute or memory to run the prover locally at acceptable latency.

**TEE path:** A TEE-attested remote proof server would:
- Accept private witnesses from the client inside an encrypted channel.
- Generate the ZK proof inside the enclave.
- Produce a remote attestation certificate proving the server ran the correct proof-generation code and did not log or exfiltrate private inputs.
- Return the proof and the attestation to the client.

The client's privacy claim then has two independent layers: the ZK proof guarantees computational correctness; the TEE attestation gives confidence that private inputs were not retained by the remote server.

This pattern is **architecturally clean** because TEE protects the proving side while ZK still protects the on-chain side. The on-chain privacy guarantee is unchanged; only the client-server trust relationship improves.

🧪 **HYPOTHESIS:** A TEE-attested remote proof server is the highest-priority TEE integration for Midnight, enabling mobile and browser dApp use cases without requiring users to trust a proving service based solely on its privacy policy. The incremental engineering over a non-attested remote prover is modest — the cryptographic work is standard TEE SDK integration.

### 5.2 MPC / Chain Signatures Analogue (Medium-Term)

**Problem:** Midnight's current Cardano bridge (cNIGHT ↔ mNIGHT) is bilateral and purpose-built. A general cross-chain signing capability (analogous to Chain Signatures) would require an MPC network whose nodes can be trusted not to exfiltrate key shares.

**TEE path:** A TEE + MPC hybrid, where:
- FROST threshold signing is used for key share distribution (no single node holds the full key).
- Each MPC node runs inside a TEE enclave and provides a remote attestation.
- Clients can verify both that the signing ceremony is threshold-secure and that each participating node is running the correct unmodified code.

This is directly the NEAR Chain Signatures pattern. The NearFall Technical Specification v4.2 §2.1.5 confirms that BN254 appears only in **Sirius** — the proposed IVC proof aggregation layer — and not in the production signing path. The `near/mpc` Cargo.toml has no BN254 dependency; the production stack uses secp256k1 (cait-sith), Ed25519 (FROST), and BLS12-381 (CKD). The BN254/BLS12-381 incompatibility therefore does **not** block adoption of the MPC signing service itself.

🧪 **HYPOTHESIS 3:** The curve incompatibility between NEAR Chain Signatures and Midnight is confined to the Sirius proof aggregation layer, not the signing path. NEAR's threshold signing code (`cait-sith` + FROST) can be adopted for Midnight's MPC network without resolving the BN254/BLS12-381 mismatch, provided the Sirius IVC layer is not required. *Testable by: auditing `near/mpc` Cargo.toml for BN254 dependencies and confirming the NearFall spec §2.1.5 claim against the production repository.*

⚠️ **RISK (committee size):** An 8-node MPC committee (NEAR's current size) is small by BFT standards. A threshold of 5/8 means a 4-node coalition can prevent signing (liveness failure) and a 5-node coalition can sign arbitrarily (safety failure). Midnight would need to specify a minimum committee size and fault tolerance that matches its security model.

⚠️ **RISK (signing-path incompatibility):** A separate blocker exists independent of the curve question: NEAR Chain Signatures provides threshold **ECDSA** over secp256k1 (NearFall spec §1.2.3); Midnight's transaction signing model requires **BIP-340 Schnorr**. These are distinct signature schemes — the ECDSA MPC protocol cannot be reused for Schnorr signing. Midnight would need to either (a) implement a threshold Schnorr MPC protocol from scratch, (b) adapt FROST (currently targeting Ed25519/Ristretto) to secp256k1 Schnorr, or (c) accept ECDSA for cross-chain signing while retaining Schnorr internally. This is an independent blocker for Option 2 (direct code adoption).

### 5.3 TEE-Attested Solvers and Sequencers (Longer-Term)

The modularity comparison catalogue identifies "Private solver networks — TEE-executed solvers with ZK-verified bids; prevents solver front-running" as an Option 3 item. This pattern:

- A solver network competes to fill intents (from Midnight's emerging intents model).
- Each solver runs inside a TEE, preventing it from observing competitors' bids or front-running user transactions.
- TEE attestation provides a verifiable guarantee of execution integrity.
- This is complementary to — not a replacement for — ZK-based privacy; the ZK layer proves the transaction is valid, while the TEE layer proves the matching/solver process was fair.

Similarly, a TEE-attested L2 sequencer would prevent the sequencer operator from reordering or censoring transactions without detection. This is the same pattern used by several optimistic rollup systems (e.g., Scroll's proof of sequencer integrity).

### 5.4 Key Storage / Secure Enclave for Wallets

Standard HSM/TEE-based key storage for validator keys and wallet keys is well-established infrastructure. Midnight validators currently manage consensus keys (AURA, GRANDPA) in software; moving these to TEE enclaves reduces the risk of key exfiltration from compromised validator nodes. This is an operational security improvement, not a new capability.

---

## 6. The "Cheat Codes" Framing in Context

Charles's use of "cheat codes" accurately captures the tradeoff:

| Aspect | ZK ("principled path") | TEE ("cheat code") |
|--------|------------------------|-------------------|
| Privacy guarantee | Mathematical; holds against any adversary who accepts the proof system | Conditional; requires trusting the hardware and supply chain |
| Development time | Months to years per new circuit | Weeks for new enclave deployment |
| Auditability | Proof is publicly verifiable by anyone | Attestation chain is verifiable but requires trusting Intel/AMD/ARM |
| Failure consequence | Cryptanalytic break compromises all past privacy globally | Targeted enclave compromise exposes only that node's secrets |
| Appropriate for | Core privacy primitives (ZSwap, contract state hiding) | Fast-path features, MPC node integrity, remote proving |

"Cheat codes" in game terminology means: achieves the goal through a privileged shortcut not available in normal play. The goal is shipped privacy features; the shortcut is trusting hardware rather than proving security mathematically. Charles's framing treats this as a legitimate tactic for moving fast, not a permanent replacement for ZK.

The practical synthesis for Midnight is a **layered approach**:
1. Deploy TEE for capabilities where ZK circuits do not yet exist or are too expensive (remote prover, MPC network, solver integrity).
2. Continue developing ZK paths for the same capabilities in parallel.
3. As ZK paths mature, upgrade from TEE-backed to ZK-backed guarantees and document the transition.

This is consistent with how several major privacy systems have evolved (e.g., Zcash moved from zk-SNARKs with trusted setup → Sapling → Orchard as the proof system matured).

---

## 7. Outstanding Questions for Next Increment

The following questions are unanswered by this survey and should be addressed in a dedicated TEE assessment:

1. **Which TEE platforms are operationally acceptable?** Intel SGX has a problematic supply chain history (discontinued on consumer chips; SGX attestation infrastructure has known outages). AMD SEV-SNP and AWS Nitro Enclaves have better operational track records for server-side deployment.
2. **Threshold Schnorr for Midnight.** NEAR's `cait-sith` implements threshold ECDSA; Midnight's transaction model requires BIP-340 Schnorr (NearFall spec §1.2.3). Can FROST be adapted to secp256k1 Schnorr for Midnight's use case, or is a new threshold Schnorr protocol required? This is the primary remaining blocker for Option 2 code reuse.
3. **What is the attestation verification cost for validators?** If Midnight validators must verify TEE attestation certificates on-chain, the certificate chain verification cost must be accounted for in the weight model.
4. **Regulatory acceptability.** Would Midnight's target enterprise customers accept a TEE-backed privacy claim for regulated use cases (financial data, healthcare, KYC)?
5. **Interaction with DUST and the fee model.** A TEE-attested remote prover changes who bears the proving cost; DUST metering may need to account for remote proving fees.

---

## Sources

1. **Background 6** — [journal/project-increment-1.md](../journal/project-increment-1.md#background-6). Charles Hoskinson's statement: *"Heavy use of TEE's as 'cheat codes' to add privacy quickly."* Internal.
2. **Scope course correction (2026-03-20)** — [journal/project-increment-1.md](../journal/project-increment-1.md). Analysis: *"Charles's specific NEAR interests now read as concentrated in three areas: key management / chain abstraction, TEE integration as a fast privacy path, and (more weakly) TPS from networking."* Internal.
3. **[`near-key-management.md`](near-key-management.md)** — §8 (Chain Signatures architecture), §10.12 (MPC assessment), §11.8 (Midnight applicability, including BN254/BLS12-381 blocker). Internal.
4. **[`modularity-comparison.md`](modularity-comparison.md)** — Feature catalogue: "TEE + MPC hybrid attestation pattern" and "Private solver networks — TEE-executed solvers with ZK-verified bids." Internal.
5. **NEAR Chain Signatures documentation** — [docs.near.org/concepts/abstraction/chain-signatures](https://docs.near.org/concepts/abstraction/chain-signatures). Public.
6. **Intel SGX overview** — [intel.com/content/www/us/en/developer/tools/software-guard-extensions/overview.html](https://www.intel.com/content/www/us/en/developer/tools/software-guard-extensions/overview.html). Public.
7. **AMD SEV-SNP** — [amd.com/en/developer/sev.html](https://www.amd.com/en/developer/sev.html). Public.
8. **AWS Nitro Enclaves** — [aws.amazon.com/ec2/nitro/nitro-enclaves/](https://aws.amazon.com/ec2/nitro/nitro-enclaves/). Public.
9. **FROST threshold signing** — Komlo, C. & Goldberg, I. "FROST: Flexible Round-Optimized Schnorr Threshold Signatures." SAC 2020. [eprint.iacr.org/2020/852](https://eprint.iacr.org/2020/852). The threshold signing scheme used in NEAR Chain Signatures.
10. **`cait-sith` library** — [github.com/cronokirby/cait-sith](https://github.com/cronokirby/cait-sith). NEAR's production ECDSA threshold signing implementation. Public.
11. **NearFall Technical Specification v4.2, §2.1.5** — *"The Curve Reality (Why Sirius Doesn't Work)."* Confirms BN254 appears only in Sirius (the proposed IVC proof aggregation layer), not in the production Chain Signatures signing path. Internal.
12. **NearFall Technical Specification v4.2, §1.2.3** — Identifies the signing-path incompatibility: NEAR Chain Signatures provides threshold ECDSA; Midnight requires BIP-340 Schnorr. Internal.
