# Logbook for 2nd project increment

*One hundred days:* four project increments between March 12 through June 19, 2026, structured as a design-thinking double diamond.

| Increment | Diamond    | Phase      |  Days  | Dates                                          | Focus                                           |
| :-------: | ---------- | ---------- | :----: | ---------------------------------------------- | ----------------------------------------------- |
|     1     | Foundation | Divergent  |  1–25  | [March 12 – April 5](./project-increment-2.md) | Broad exploration: generate hypotheses          |
|     2     | Foundation | Convergent | 26–50  | **April 6 – April 30**                         | Hypothesis testing: converge on recommendations |
|     3     | Refinement | Divergent  | 51–75  | May 1 – May 25                                 | Refined exploration: regenerate hypotheses      |
|     4     | Refinement | Convergent | 76–100 | May 26 – June 19                               | Hypothesis testing: converge on recommendations |

👉 See [the architectural intelligence guide](../AGENTS.md) for conventions used in this journal.

---

## 2026-04-17

### Weekly Summary

- Steering committee briefing: prepared and delivered a review of feasibility findings to project leadership.
- Hybrid sharding design: produced a speculative architecture document and diagram for running Midnight's ledger on a NEAR-inspired sharded network.
- TEE computing analysis: revised the trusted execution environment comparison and created new diagrams illustrating the spectrum of approaches.
- Local network experimentation: built multi-node test infrastructure including cluster configurations, monitoring scripts, and a transaction-rate measurement tool.
- Analyzed *Midnight Passport* document.

---

## Briefing to steering committee

- Artifacts
	- [Slides](https://docs.google.com/presentation/d/18yLg270Gfgi2E8u0u8-0WJ8LUmuvE6LZLOtOSbi03Yk/edit?usp=sharing)
	- [Notes](https://docs.google.com/document/d/1K_ehQjiI_o78Ga2xnL6MrIPIlwBpW1eugs9jFursyWU/edit?usp=sharing)
	- [Transcript](https://docs.google.com/document/d/1K_ehQjiI_o78Ga2xnL6MrIPIlwBpW1eugs9jFursyWU/edit?usp=sharing)
	- [Recording](https://drive.google.com/file/d/1eflWul2htQADEwWFom6VAy6FAjOoXBTq/view?usp=sharing)
- Relevant action items
- [x] [Brian Bush] Add Users: Add Charles Hoskinson and others who request access to the private research repository using their GitHub usernames.
- [ ] [Bob Blessing-Hartley] Schedule Deep Dive: Arrange a meeting with Brian Bush to conduct a deep dive analysis of uncovered findings regarding performance and networking stack issues.
- [ ] [The group] Gather Documentation: Collect latest copies of all documentation, skills, and related materials.
- [ ] [Bob Blessing-Hartley] Schedule Outreach: Reach out to Brian early next week to get targeted and focused.
- [ ] [The group] Conduct Debrief: Debrief with Brian next week to determine his next steps and utilization.

---

## 2026-04-16

### Executive summary of findings

See *Near & Midnight Findings 2025-04-17*: [Google slides](https://docs.google.com/presentation/d/18yLg270Gfgi2E8u0u8-0WJ8LUmuvE6LZLOtOSbi03Yk/edit?usp=sharing) or [PDF](../artifacts/findings-briefing-20260417.pdf).

### 👱🤖 Speculative design: Midnight ledger kernel on NEAR sharding

Explored how Midnight's transaction model could be mapped onto NEAR's sharded receipt architecture. The central idea is a dedicated shard 0 acting as the ledger kernel — holding all Night UTXO, ZSwap, and DUST state — with contract state sharded across shards 1–N. Analysed rollback semantics, provisional state management, workload asymmetry between shard 0 and contract shards, and ProtoGalaxy compatibility. Compared the abstract ledger state against current Midnight, noting that partial success (`SucceedPartially`) is already first-class in Midnight, and that same-block receipt resolution would preserve identical semantics. See [design document](../artifacts/midnight-near-sharding-design.md).

---

## 2026-04-15

### 🤖👱 Idea for anonymous-feedback app for use in retrospectives

Designed a simple Midnight smart contract for anonymous team retrospectives: participants commit encrypted observations from their main addresses, then reveal from fresh disposable addresses funded via the preprod faucet, breaking the authorship link without requiring ZK proofs. A shared view key restricts readability to participants. See [artifact](../artifacts/anonymous-retrospective-app.md) for the full design.

### Met with Alan

Possible opportunities for involvement
- Consult on multi-chain / cross-chain engineering.
- Investigate TEE design, patterns, limits
	- Focus on solvers, not so much on proof servers
	- Concern about information or intents leaking from TEE and being used for "front running"

---

## 2026-04-14

### 👱🤖 Seven-node local validator network and rudimentary NIGHT transfer TPS script

Built and validated a complete local Midnight environment: a seven-validator
consensus network running inside a single Podman pod, plus a standalone Node.js
script that submits NIGHT token transfers and measures submission throughput.

**Seven-node Podman pod (`midnight-lan.yaml`).** All seven validator nodes run
in a single pod, sharing a localhost network namespace. Each node uses
`CFG_PRESET=dev` (`use_main_chain_follower_mock = true`), so there is no
Cardano dependency. AURA produces blocks and GRANDPA provides finality; BEEFY
bridge finality is also active. A one-shot `beefy-inserter` sidecar container
inserts the ECDSA BEEFY keys into each node's keystore via `author_insertKey`
at startup (BEEFY keys cannot be injected via environment variables and must be
inserted at runtime). The pod also includes an `indexer-standalone` connected
to node-1 and a shared `proof-server`. External port assignments:

| Service | Host port |
|---------|-----------|
| Node-1 RPC | 9945 |
| Indexer GraphQL | 8088 |
| Proof server | 6300 |

**TPS experiment script (`experiments/mn-tui/src/night-tps.ts`).** A
standalone TypeScript script (runnable with `tsx` against the existing
`mn-tui` dependencies) that exercises the full NIGHT transfer pipeline:

1. *Setup phase* — initialises the genesis mint wallet (fixed seed `0x00…01`,
   which holds all genesis NIGHT), funds N test wallets from it, and registers
   each wallet for DUST generation.  Wallets are persisted as 24-word BIP39
   mnemonics in `night-tps-wallets.json`.
2. *Run phase* — loads the funded wallets, initialises them in parallel,
   and sends a configurable burst of 1-NIGHT transfers in a circular pattern
   (wallet-i → wallet-(i+1) mod N), reporting total transfers, wall-clock
   time, and submission TPS.

**Key findings from initial single-wallet single-transaction run:**

- Submission latency is ~15 s per transaction, dominated by ZK proof
  generation at the proof server.  With N wallets running in parallel, total
  wall-clock time scales sub-linearly with wallet count.
- Measured submission TPS (1 wallet × 1 tx): **0.06 tx/s**.  This is a
  proof-generation bound, not a consensus throughput bound.
- DUST registration for a fresh wallet required applying the `ledger-v7`
  7.0.0 `ZswapChainState::tryApply` monkey-patch (see `lessons-learned.md` in
  `mn-tui`); without it, the WASM panic corrupts the proof state, producing a
  `BalanceCheckOverspend` (error 138) rejection from the node.
- The genesis wallet's DUST balance is pre-seeded in genesis state; no
  registration transaction is needed for it.

**Open issue: loss of consensus after ~15 minutes.** The network consistently
loses consensus roughly fifteen minutes after pod startup — block production
stalls and GRANDPA finalization halts.  Root cause is not yet identified; the
symptom is reproducible across restarts.  This limits the practical run window
for TPS experiments and will need to be diagnosed before longer-duration tests
are meaningful.

📊 **EVIDENCE:** Pod spec and README in
[`experiments/node-lan/`](../experiments/node-lan/); script in
[`experiments/mn-tui/src/night-tps.ts`](../experiments/mn-tui/src/night-tps.ts).

---

### 👱🤖 Packaged patched Midnight node as a Docker image; kube files for local operation

Built on the patch work from 2026-04-13 to produce a deployable Docker image and
Podman Kubernetes pod specs for running a complete Midnight stack locally.

**Binary packaging.** The patched `midnight-node` binary was compiled with
`cargo build --release` inside a Nix shell. Because the Nix build environment
hardcodes dynamic-linker paths into the ELF binary, `patchelf` was used to
rewrite the interpreter and rpath to standard system paths before packaging.
The binary and the entire `res/` tree (config, chain-specs, genesis files) were
packaged into a Debian-based Docker image and pushed to Docker Hub as
`bwbush/midnight-node:0.22.2-patched`.

**Key discovery: `res/` must be at `/res/`.** The `res` crate constructs its
config path as `{cwd}/res/cfg/` at runtime, so the resource tree must be
mounted at `/res/` in the container (not at an arbitrary path like
`/midnight/res/`).

**Pod specs.** Two Podman Kubernetes YAML files were created:

| File | Network | RPC host port | Indexer host port |
|------|---------|--------------|-------------------|
| `midnight-mainnet.yaml` | Mainnet | 9945 | 8088 |
| `midnight-preprod.yaml` | Preprod | 19944 | 18088 |

Each pod mounts a local directory (`./mainnet` or `./preprod`) at `/data` for
chain state and SQLite index databases. The host directory requires mode 777
because the container process does not run as a fixed UID.

**TUI connectivity.** The `mn-tui` can be pointed at the local node and indexer
by editing `~/.mn-tui-config.json` (or via its Network Configuration screen) to
set `nodeUrl` and `indexerUrl` for the relevant network to
`http://192.168.1.11:{port}` and `http://192.168.1.11:{port}/api/v4/graphql`
respectively. The proof server continues to run locally on `localhost:6300`.

📊 **EVIDENCE:** Docker image, kube files, and README in
[`experiments/pubnet-node/`](../experiments/pubnet-node/).

---

## 2026-04-13

### 👱🤖 Midnight node sync fix — genesis-era Cardano anchor timestamps

Diagnosed and patched a block-verification failure that prevents a freshly started
Midnight node (v0.22.2) from syncing on either preprod or mainnet.

**Root cause.** Each Midnight block embeds a Cardano anchor hash. During verification
the `sidechain-mc-hash` crate calls `get_stable_block_for`, which accepts a block only
if its Cardano timestamp falls in the window `[reference − 3k/f, reference − k/f]`
(with k = 432, f = 0.05, giving a window of roughly 2.4 h to 7.2 h before the
reference). The reference timestamp is derived from the Midnight slot number and the
6-second Midnight slot duration. The genesis-era Midnight blocks — produced when the
network was first bootstrapped — reference Cardano blocks that were approximately
**15.6 hours** old at the time, exceeding the 7.2 h upper bound. Because this is
committed chain history, neither environment-variable tuning nor chain-spec edits can
repair it.

**Fix.** Patched `get_mc_state_reference` in `partner-chains` (tag v1.8.1) to fall back
from the timestamp-filtered `get_stable_block_for` to a pure `get_block_by_hash` when
the former returns `None`. Added `WARN`-level diagnostic logging that fires on the
fallback path, showing the reference timestamp, stability window, actual block
timestamp, and the offset in days. The fallback is unreachable for any hash that is
genuinely absent from cardano-db-sync, so the error path is preserved.

The Midnight node `Cargo.toml` was patched to redirect all `partner-chains` git
dependencies to a local checkout of the modified SDK.

Verified on both preprod (offset ~15.6 h) and mainnet (same issue; confirmed by SQL
query that the referenced block exists in db-sync). Both networks sync successfully
with the patched binary.

📊 **EVIDENCE:** Patch files and run scripts in
[`experiments/pubnet-node/`](../experiments/pubnet-node/).

### Plan of the week

- [x] Wrap up findings
	- [x] Quality checks
	- [x] Briefing Friday
	- [x] Executive-summary document
	- [ ] Midnight problem statements or improvement proposals, where appropriate
- [x] Revisit the Midnight node LAN experiment, upgrading to the latest released component versions and attempting a TPS study
- [x] Prepare for an LLM-assisted retrospective
- [ ] Collaborate, subject to their availability
	- [x] Alan
	- [ ] Christos
- [ ] Read *Proving Nothing*

---

## 2026-04-10

### Weekly summary

- Mapped and experimented with client/server and mobile/TEE/SE contract patterns and use cases.
	- Ran the Midnight proof server inside a GCP SEV-SNP Confidential VM and verified AMD hardware attestation end-to-end. (An SGX TEE would have been too expensive for my budget.)
	- Demonstrated and quantified running a proof server on a mobile device for a proof-of-concept KYC contract.
- Deep dive into the Midnight ledger specification and codebase.
- Studied NEAR Chain Signatures and UTXO pallet options for Midnight.
- Reached out to Alan and Christos, respectively, regarding MPC/intents/multisig and Middnight networking.
- Developed a concise executive briefing of hypotheses and findings so far.

### 🤖👱 Midnight proof server on GCP SEV-SNP

Provisioned a GCP Confidential VM (`n2d-standard-8`, Ubuntu 22.04, SEV-SNP) and ran the `midnight-proof-server` binary inside it, then verified hardware attestation using `snpguest`. The goal was to test whether the proof server operates correctly in a cloud TEE context and to establish a baseline for the Tier 3 design (Intel SGX + Gramine).

**Platform selection.** Intel SGX is not available on AWS or GCP. AWS Nitro Enclaves provide software-only isolation without a hardware root-of-trust. GCP SEV-SNP was chosen as the most accessible hardware TEE within the project's cloud accounts. Its isolation model is VM-level (protects against the hypervisor/GCP) rather than process-level (does not protect against a compromised guest OS), which is weaker than SGX but sufficient for this experiment.

**Binary extraction.** The proof server is a Nix-built x86_64 binary inside `midnightnetwork/proof-server:latest`. Extracted via `docker cp` from the Nix store path, then patched with `patchelf --set-interpreter` to replace the hardcoded Nix glibc path with the Ubuntu system linker. All shared libraries resolved from standard Ubuntu paths without further changes.

**Attestation.** Hardware attestation was verified end-to-end using `snpguest`:
- Requested an attestation report from `/dev/sev-guest` with a random nonce.
- Fetched the AMD certificate chain (ARK → ASK → VCEK) from AMD's Key Distribution Service, using `milan` as the processor model.
- Verified that the VCEK traces back to the AMD root CA and that all TCB version fields in the certificate match those in the attestation report.
- Confirmed the report was signed by the VCEK of this specific physical chip.

📊 **EVIDENCE:** `update_compliance` proved successfully against the remote proof server. AMD attestation chain verified with no errors. Full command log and output in [`experiments/local-tee-poc/gcp-sev-snp-proof-server.md`](../experiments/local-tee-poc/gcp-sev-snp-proof-server.md).

📌 **FINDING:** The `patchelf` approach for running Nix-built binaries on Ubuntu is fragile across glibc versions. For a production deployment, running the binary via `docker run` with the full container filesystem is cleaner.

📌 **FINDING:** SEV-SNP attestation is straightforward to verify with `snpguest` and gives cryptographic proof of genuine AMD hardware — stronger assurance than `dmesg` or device node presence alone. The missing piece relative to Intel SGX is process-level isolation: any root process inside the VM can read the proof server's memory.

### 🤖👱 Midnight ledger deep dive

Completed a detailed structural study of the `midnight-ledger` codebase. Notes compiled in [`assessments/midnight-ledger-notes.md`](../assessments/midnight-ledger-notes.md). Key findings:

- **Zero Substrate coupling.** The `ledger` crate has no `frame_support` / `sp_runtime` dependencies. It interacts with the host runtime exclusively through the `StateReference<D>` trait, making it fully portable to any runtime that implements that trait and the `DB` backend abstraction.
- **Single user transaction entry point pair.** `Transaction::well_formed()` → `VerifiedTransaction<D>` → `LedgerState::apply()` → `(LedgerState, TransactionResult)`. The type system enforces the ordering; applying an unverified transaction is not expressible.
- **Minimal block coupling.** The ledger has no concept of block headers or block height. The only block-boundary signals it receives are a timestamp (`tblock: Timestamp`) and a fullness metric passed to `post_block_update`. This makes the ledger straightforward to embed in a rollup or streaming context with a different block cadence.
- **Fallible segments.** Transactions can contain multiple segments. Segment 0 is all-or-nothing (guaranteed); segments N > 0 are fallible — they roll back independently without affecting committed segments. Per-segment balance independence is cryptographically enforced via segment IDs in Zswap delta commitment pre-images.
- **Intent/segment structure.** A single `Intent` spans both execution phases: its guaranteed fields run in segment 0 alongside all other intents' guaranteed fields; its fallible fields run in segment N. Zswap offers (`fallible_coins`) are at the transaction level, keyed by the same segment ID.
- **Asymmetric wallet recovery.** Received Zswap coins are fully recoverable from the seed (trial-decryption via the incoming viewing key). Sent coins are permanently lost on wallet restore: Midnight Zswap has no outgoing ciphertext and no outgoing viewing key, unlike ZCash Sapling.
- **Proof time is constant; state growth is unbounded.** Fixed-depth Merkle trees (depth 32) mean ZK proof generation time does not scale with history. Nullifier sets and commitment trees grow without bound and are never pruned — the same structural exposure as ZCash, with wallet scan time O(S_total).

---

## 2026-04-09

### 👱🤖 Mobile proof server experiment

Ran the `midnight-proof-server` binary on a **Samsung Galaxy Tab S7** (Snapdragon 865+, Cortex-A77 @ 3.09 GHz, Android) and submitted a live `update_compliance` transaction to the proof server running on-device. This directly measures the viability of mobile-side ZK proving for the compliance PoC.

**Build and deployment.** Compiled from `midnight-ledger/proof-server/` on an AWS c6g.large (Debian ARM64) as a fully static musl binary:

```bash
rustup target add aarch64-unknown-linux-musl && sudo apt install -y musl-tools
RUSTFLAGS="-C target-feature=+crt-static" \
  cargo build -p midnight-proof-server --release --target aarch64-unknown-linux-musl
```

Pre-downloaded the ZK key material (bls_midnight_2p{10..15}, zswap/{9,dust}/\*.prover) on the EC2 (ADB shell has no internet access), then transferred binary + cache via `adb push`. Ran with `HOME=/data/local/tmp` to avoid the read-only filesystem error. Forwarded port 6300 from tablet to laptop port 6301 via `adb forward tcp:6301 tcp:6300`.

📊 **EVIDENCE:** Both circuits completed successfully on the tablet:

| Circuit             | x86-64 server | AWS c6g.large (Graviton2) | Samsung Tab S7 |
| ------------------- | ------------: | ------------------------: | -------------: |
| `update_compliance` |        1.66 s |                   15.60 s |         6.79 s |
| DUST fee            |        0.62 s |                    5.53 s |         3.62 s |

📌 **FINDING:** The Graviton2 (Neoverse N1) is a poor proxy for mobile performance on single-threaded ZK proving. The S7 Snapdragon 865+ Cortex-A77 @ 3.09 GHz is ~2.3× faster than Graviton2 @ 2.5 GHz for this workload. The Neoverse N1 is optimised for multi-threaded throughput; the A77 has higher clock and competitive IPC for single-threaded integer arithmetic. Earlier estimates of 8–17 s for a Pixel 8a were too pessimistic; based on measured S7 numbers, a Pixel 8a (Tensor G3, Cortex-X3) should complete an `update_compliance` proof in approximately 5–6 s. Total proving time on a current flagship phone is ~8–9 s, which is acceptable for a low-frequency compliance update operation.

📌 **FINDING:** The official `midnightnetwork/proof-server` Docker image lists a `linux/arm64` manifest, but the binary it contains is x86-64 (ELF e_machine = 0x3E). The multi-arch scaffolding (ARM64 symlinks, musl coreutils) is correct, but the proof server binary itself is the wrong architecture. Compilation from source is currently required for ARM64 deployment.

📌 **FINDING (bug fix):** The `useCompliance` hook had `network.proofServerUrl` absent from the wallet `useEffect` dependency array. The wallet was initialised once with `provingServerUrl` baked in; changing the proof server URL in the Network screen updated `buildProviders` (called fresh on each operation) but not the wallet's internal DUST prover. This caused the second `/prove` call (DUST fee) to use the stale URL while the first (application circuit) used the new one. Fixed by adding `network.proofServerUrl` to the dependency array — matching the pattern already used in `experiments/mn-tui`.

Full experimental procedure and pitfall table in [`artifacts/tee-device-key-registration.md §Mobile Proof Server: Experimental Setup`](../artifacts/tee-device-key-registration.md).

### 👱🤖 Local TEE PoC — Schnorr updates, usability hardening, and security review

Completed and reviewed the `experiments/local-tee-poc/` TUI application. Key activities:

**Stub TEE caveat.** The "TEE" in this PoC is a software stub (`src/tee/stub-tee.ts`). `sk_device` is derived deterministically from the wallet seed via HKDF-SHA256, lives in plaintext process memory, and is never written to disk — but it is NOT protected by a hardware enclave. The production path requires `sk_device` to be generated inside SGX/TrustZone and the proof server to be TEE-attested; `sk_device` would be encrypted to the server's attestation key and decrypted only inside the server enclave. All protocol-level properties demonstrated here (registration, Schnorr update, on-chain verification) hold in the stub, but the security boundary is the process, not an enclave.

**Schnorr range fix.** The `Bytes<32> as Uint<248>` cast in `update_compliance` fails for ~99.6% of 256-bit hashes because it is a range-checked (not truncating) operation. Fix: add a `nonce: Uint<64>` retry counter to the hash; the TypeScript stub iterates nonce = 0, 1, 2, … until the little-endian integer value of the hash is < JUBJUB_R (~5.7% success probability; ~17 expected iterations). The pure circuit `compute_schnorr_challenge` returns `Bytes<32>` so the caller can inspect the value before committing to the nonce. See lessons-learned §10.

📊 **EVIDENCE:** The nonce-retry approach compiles and runs correctly on preprod. Registration and four-step tier upgrade (0 → 1 → 2 → 3) completed end-to-end; one transient UTXO staleness error (RpcError 1010, custom error 170) occurred on the fourth step and self-resolved on retry — this is a known wallet SDK behaviour where `isSynced: true` does not guarantee the UTXO set reflects the immediately preceding transaction (lessons-learned §11).

**Usability improvements shipped.**
- *Keys screen:* mnemonic entry separated from network configuration. Mnemonic can be session-only (no passphrase) or encrypted with OpenPGP symmetric AES-256 and persisted to `~/.local-tee-poc-config.json`; only the ciphertext is ever written to disk. The startup flow goes directly to the Keys screen when a saved encrypted mnemonic is detected.
- *Wallet sync state cache:* wallet sync state (shielded, unshielded, dust) serialised to `~/.cache/local-tee-poc/sync-state/{network}/{address}-{type}.state` on first successful sync, following the same pattern as `experiments/mn-tui`. Subsequent startups restore from cache rather than replaying from genesis.

**Security review: tier/commitment binding.**

📌 **FINDING:** The `new_tier` field cannot be silently altered between the stub TEE and the proof server. The Schnorr challenge hash is `persistentHash(sig_r, device_pk, new_tier, new_identity_commitment, update_count, nonce)`; any substitution of `new_tier` changes the hash, which breaks the on-chain assertion `s·G == R + c·device_pk`. The proof cannot be generated for the altered inputs. The `update_count` field additionally prevents replay of any legitimately-signed tuple from an earlier call.

📌 **FINDING:** The tier should NOT be embedded in the identity commitment. The identity commitment (`hash(name | dob | jurisdiction)`) is a stable fingerprint of who a person is; the compliance tier is a policy judgement that can change without the underlying identity changing. Embedding the tier in the commitment would produce a new commitment for every tier change, which is semantically wrong. The required binding — that the TEE simultaneously attested *this tier* for *this commitment* — is already provided by the Schnorr signature covering both fields jointly.

🧪 **HYPOTHESIS:** The remaining production gap is the proof-server trust model, not the Compact contract design. The circuits (`register_device`, `update_compliance`) are complete and correct. The one unsolved step is encrypting `sk_device` to a TEE-attested proof server's attestation key so it never appears in plaintext outside an enclave. Falsifiable by wiring in an SGX-attested proof server (e.g., Gramine-wrapped) and verifying that `sk_device` is absent from any host-visible memory region at time of proof generation.

---

## 2026-04-08

### 👱🤖 Local TEE proof of concept — compliance tier contract

Built a working proof-of-concept TUI application demonstrating the TEE device key registration pattern on a live Midnight contract. See [`experiments/local-tee-poc/`](../experiments/local-tee-poc/) for the full implementation.

📊 **EVIDENCE:** The Compact `ecMulGenerator` + `ecAdd` primitives are sufficient to implement device key registration and ownership proof without `ecMul` (arbitrary point × scalar): supply `sk_device` as a private ZK witness, compute `pk = sk_device · G` inside the circuit, assert against the stored `device_pk`. This is the exact pattern that a production TEE-attested proof server would use, with the only difference being that in production `sk_device` never leaves the enclave before being passed to the proof server.

📊 **EVIDENCE:** The private ledger state feature (`ledger x: Field` without `export`) correctly partitions on-chain and off-chain data: `compliance_tier` and `device_pk` are public on-chain state visible to all observers; `identity_commitment` (the hash of PII) is stored only in LevelDB and never appears in any on-chain output. The two-field design (one public, one private) is a clean minimal demonstration of Midnight's privacy partition.

🧪 **HYPOTHESIS:** The primary engineering risk in the full TEE device key registration design is the `ecMul` gap and the proof-server trust model, not the Compact contract design. The contract circuits (`register_device`, `update_compliance`) can be written today with current Compact language features. Falsifiable by compiling `contracts/compliance.compact` and deploying to preprod.

📌 **FINDING:** The local-tee PoC identifies the exact production path: (1) the Compact circuits are ready; (2) `sk_device` must be generated inside the enclave and passed to a TEE-attested proof server rather than exposed to a local process; (3) the identity commitment should use Poseidon rather than SHA-256 for ZK-circuit compatibility in more advanced designs that verify the commitment inside a circuit; (4) the `reset_device` permissionless reset is acceptable only for PoC — production needs the ZK recovery path from `artifacts/tee-device-key-registration.md` §Component 3.

📌 **FINDING:** Compact's `disclose()` is required for ALL circuit-witness-to-ledger-state assignments, including assignments to non-`export` ledger fields. The correct Compact assert syntax is `assert(condition, "message")` — parentheses with comma, no bare `!` negation operator (use `== false` for boolean negation). The `export` keyword controls ABI visibility only; the precise on-chain footprint of non-exported fields — whether committed values are recoverable from the state tree by an observer — needs verification before strong privacy claims can be made about non-exported ledger state.

### 👱🤖 TEE as an alternative proof path for Midnight features

Analysed where TEE attestation can serve as a fast-path substitute for ZK proofs in Midnight, independently of the MPC/chain-signing use case. See [`assessments/tee-vs-zk.md`](../assessments/tee-vs-zk.md) for the full writeup.

📊 **EVIDENCE:** TEE plays two architecturally distinct roles: (1) a TEE-attested remote proof server, which protects witnesses sent to a remote prover but still generates ZK proofs and does not solve the mobile proving problem; and (2) TEE attestation as a first-class alternative proof mode, which requires a Midnight protocol change but removes circuit size limits, enables mobile participation (the attestation is small; no prover runs on-device), and provides a fast path for ZK-unfriendly operations (SHA-256/AES, arbitrary iteration, regulatory auditor access). Key management via the device's native secure enclave is viable immediately on mobile without any protocol changes.

🧪 **HYPOTHESIS:** Extending Midnight's validator to accept TEE attestations alongside ZK proofs — with a registry of accepted enclave code hashes as the governance mechanism — is the minimal protocol change needed to unlock mobile-native transaction submission and TEE-fast-path contract features. The two proof modes (ZK for core privacy primitives, TEE for circuit-constrained features) are complementary and can coexist on the same chain. Falsifiable by scoping the validator weight model change and identifying the minimum governance surface for enclave code hash registration.

📐 **DESIGN:** A no-validator-change alternative is available via a device key registration pattern: TEE attestation certificate chain verified once off-chain by an oracle at registration; thereafter the Compact contract performs only standard signature verification. A dual-path interface accepts either a ZK proof or a TEE device signature, so device loss never locks out the user — the ZK path carries no hardware trust and is always available from seed material. See [`artifacts/tee-device-key-registration.md`](../artifacts/tee-device-key-registration.md) for the full design.

📌 **FINDING:** A TEE can accept private user input (amount, recipient name), compute a stealth address and amount commitment entirely inside the enclave, and sign an opaque triple `(amount_commitment, P, R)` that authorises a fully private ZSwap transfer — recipient and amount hidden from chain observers — without validator changes; the witness package sent to the proof server is ZSwap-standard regardless of application logic complexity, but `sk_in` (the sender's spending key) is its most sensitive item: `sk_in` alone cannot spend other notes (each note also requires its own `ρ` and `value`), but a logging server progressively gains the ability to spend all notes it subsequently processes for that key; one-time per-note spending keys mitigate this but are architecturally awkward; the ZSwap prover cannot run inside the mobile TEE (TrustZone's 16–64 MB secure world is far too small for a BLS12-381 PLONK prover), making a TEE-attested remote proof server the natural and architecturally correct complement — the mobile TEE encrypts the witness package to the server's attestation key, `sk_in` never appears in plaintext outside an enclave, and the mobile TEE verifies the returned proof (≈6 ms) before signing. See [`artifacts/tee-device-key-registration.md`](../artifacts/tee-device-key-registration.md) and the stealth address technique in [`experiments/compact-named-accounts`](../experiments/compact-named-accounts/contracts/single-named.compact).

---

## 2026-04-07

### 👱🤖 Chain abstraction vs. bridges

Analysed NEAR's Chain Signatures capability and how it compares to traditional bridging, and how the approach could be adapted to Midnight. See [`assessments/chain-abstraction-vs-bridge.md`](../assessments/chain-abstraction-vs-bridge.md) for the full writeup.

📊 **EVIDENCE:** Chain Signatures and bridges are complementary, not equivalent. Chain Signatures is more powerful in scope (arbitrary target-chain actions, native assets, no counterparty contract required) but provides no inbound path — return flows still require a bridge. The key Midnight insight: Midnight's ZK architecture enables *private* signing requests, a strictly stronger privacy guarantee than NEAR's public model. The oracle bridge pattern (reusing NEAR's `v1.signer` as a signing service) is the tractable near-term path — no new MPC infrastructure required.

🧪 **HYPOTHESIS:** The BN254/BLS12-381 curve incompatibility affects only NEAR's internal MPC proof-aggregation layer, not the signing operations (Secp256k1/Ed25519) — meaning the oracle bridge works without resolving the curve conflict. Falsifiable by inspecting the `v1.signer` interface and confirming that returned signatures are curve-independent of the MPC's internal aggregation mechanism.

### UTXO pallets on Substrate

Investigated whether viable UTXO pallets exist for Substrate and what their throughput characteristics are. See [`assessments/utxo-pallets.md`](../assessments/utxo-pallets.md) for the full writeup.

📊 **EVIDENCE:** The ecosystem is thin. Three options exist: (1) the unmaintained `utxo-workshop` FRAME pallet (educational only, no benchmarks), (2) **Tuxedo** — the most serious option, which replaces FRAME entirely but lacks parachain support, smart contracts, wallet compatibility, and published TPS figures, and (3) **Midnight**, the only production Substrate UTXO deployment (mainnet March 2026), which is a ZK-privacy chain and not a general-purpose runtime. No UTXO-on-Substrate system has demonstrated 500+ TPS in a general-purpose configuration.

🛑 **BLOCKER (for UTXO-on-Substrate path):** Tuxedo has no Cumulus/parachain support and no smart contract capability. Adopting it would abandon the entire FRAME/Polkadot SDK ecosystem. There is no middle ground: a UTXO pallet layered on FRAME is an architectural compromise with no production precedent.

### Plan for the week

- [ ] Finish concise executive summary of findings so far.
- [x] Deep dive into Midnight ledger structure and processes.
- [x] Start getting up to speed on Alan's work.
- [x] Connect with Christos regarding networking.

### Continued from previous logbook

See [Logbook for 1st project increment](./project-increment-1.md) for prior journal entries.

---