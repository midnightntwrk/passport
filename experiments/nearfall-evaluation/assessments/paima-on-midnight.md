# 🤖 Paima on Midnight: Integration Assessment

## What Paima Needs from an L1

Paima's integration surface is well-defined and relatively minimal:

1. **An L2 contract** on-chain that accepts encoded game inputs, orders them, and collects fees.
2. **A chain-specific funnel** — indexing code that reads contract events and feeds them deterministically into the state machine.
3. **An event indexer** — to make contract state and history queryable.
4. **Deterministic transaction ordering** — the L1 provides this guarantee.

The Cardano integration (via the Carp funnel) is the closest architectural analogue to Midnight, since Midnight shares Cardano's UTXO model and already has a GraphQL indexer that plays the same role as Carp.

## Three Possible Approaches

### Approach 1 — Paima on Midnight's public (unshielded) layer only

Write a Compact contract that accepts encoded Paima inputs as public data, pays fees in NIGHT (unshielded), and emits events. Write a Midnight funnel that connects to Midnight's existing GraphQL indexer and maps Midnight's UTXO/intent events to Paima's unified input format.

- *Difficulty:* Moderate. The Carp funnel for Cardano is the template; adapting it for Midnight's GraphQL indexer and UTXO model is tractable in a few weeks of focused work.
- *Limitation:* Midnight's privacy layer is entirely unused. This is Paima running on a privacy-capable chain without using its privacy.

### Approach 2 — Paima with selective ZK attestations

Extend Approach 1 so that some Paima inputs are ZK-attested facts about shielded Midnight state (e.g., "this player owns at least N tokens of type T") rather than raw values. The Paima state machine accepts these attestations as trusted inputs verified by `pallet-kachina`.

- *Difficulty:* Hard. Requires defining an attestation interface between Midnight's ZK layer and Paima's state machine, and extending Paima's input parsing to treat ZK proofs as first-class inputs rather than opaque bytes. No existing Paima funnel does this.
- *Value:* Meaningful — private ownership facts can influence public game state without leaking balances.

### Approach 3 — Midnight as DA only, ZK-proven execution

Use Midnight's unshielded layer purely for input ordering and data availability. Run the Paima state machine off-chain, then submit a ZK proof of correct execution to a Midnight contract for settlement. This is the epoch-snapshot rollup pattern (Option H in [the mapping assessment](./midnight-to-near-mapping.md#-mapping-midnight-state-into-near-accounts)).

- *Difficulty:* Very hard. Requires a ZK circuit that proves correct Paima state machine execution — essentially building Nightstream-level IVC (incrementally verifiable computation) infrastructure. This is a research-engineering project, not a near-term integration task.
- *Value:* Highest — full ZK-compressed throughput with Midnight as settlement layer.

## The Core Tension

Paima's correctness model relies on **open deterministic re-execution**: every node replays all inputs and must reach the same state. Midnight's value proposition is **private state**: inputs and balances are not visible to third parties. These are fundamentally at odds.

The resolution hierarchy is:
- **Approach 1** ignores the tension by staying in the public layer.
- **Approach 2** bridges it via ZK attestations at defined disclosure points.
- **Approach 3** dissolves it via ZK-proven execution, but at much higher implementation cost.

There is also a secondary proof-system tension: Paima's ZK layer uses Mina's Kimchi proof system (Pasta curves), while Midnight uses Plonk/KZG (BLS12-381). These are incompatible and cannot be composed directly. If Paima's ZK features (via Mina) are wanted alongside Midnight's native ZK, the same curve-incompatibility problem that appears in the NearFall Technical Spec (BN254 vs BLS12-381) resurfaces here.

## Recommendation

The practical near-term path is **Approach 1 extended toward Approach 2**: build a Midnight funnel and a Compact Paima L2 contract to establish that Paima can run on Midnight at all, then incrementally add ZK attestation inputs as the interface between the two ZK layers is clarified. Approach 3 should be tracked as a longer-term goal once Nightstream's IVC capabilities mature.

The funnel work is the most concrete and bounded task; the privacy integration is the open research problem.

## Sources

- [Paima Engine documentation](https://docs.paimastudios.com/)
- [Paima ZK layer architecture](https://blog.paimastudios.com/paima-zk-layer/)
- [Paima + Mina Protocol EVM rollapps](https://blog.paimastudios.com/mina-evm/)
- [Kimchi: Mina's proof system update](https://minaprotocol.com/blog/kimchi-the-latest-update-to-minas-proof-system)
- [Kimchi proof system spec](https://o1-labs.github.io/proof-systems/specs/kimchi.html)
- [Carp: Cardano Postgres Indexer (dcSpark)](https://dcspark.github.io/carp/docs/intro/)
- [Paima Engine releases (Carp funnel shipped v2.2.0)](https://github.com/PaimaStudios/paima-engine/releases)
- [Midnight Indexer — dev diaries](https://docs.midnight.network/blog/midnight-indexer)
- [Midnight Indexer API v3](https://docs.midnight.network/api-reference/midnight-indexer)
- [Midnight Indexer GitHub](https://github.com/midnightntwrk/midnight-indexer)
- [Midnight ZK proof system (BLS12-381 migration)](https://docs.midnight.network/blog/zkp)
- [Midnight zero-knowledge proofs concept doc](https://docs.midnight.network/concepts/zero-knowledge-proofs)
- [Midnight node GitHub (pallet list)](https://github.com/midnightntwrk/midnight-node)
- NearFall Technical Specification v4.2 — `background/NearFall_Technical_Specification_v4_2.pdf` (internal)
- Midnight-to-NEAR mapping assessment — `./midnight-to-near-mapping.md` (internal)
- Starstream/Nightstream assessment — `./starstream-nightstream.md` (internal)

---

## Afterword: Quality Scrutiny

### 1. Sources Correspond to Retrievable URLs

This document has no `## Sources` section, violating the AGENTS.md convention. All technical claims are uncited. Two cross-references appear:

- **"Option H in [the mapping assessment]"** — The internal link to `./midnight-to-near-mapping.md` is valid and accessible. The anchor `#-mapping-midnight-state-into-near-accounts` reaches the correct section.
- **"the NearFall Technical Spec (BN254 vs BLS12-381)"** — No file path is provided. The document is resolvable as `background/NearFall_Technical_Specification_v4_2.pdf` in this repository, but readers cannot confirm this from the text alone.

All other specific claims (Carp funnel, GraphQL indexer, `pallet-kachina`, Nightstream, Kimchi/Pasta) are made without citation.

### 2. Internal Consistency

The three-approach hierarchy is coherent: each tier increases privacy integration at a corresponding cost, and the core tension (deterministic re-execution vs. private state) correctly motivates the hierarchy. The resolution hierarchy in the final section maps cleanly onto the approaches.

One topological ambiguity: the document applies Option H from the mapping assessment as the pattern for Approach 3. Option H in that assessment describes a rollup where **NEAR provides settlement and DA** for Midnight state. Here the same epoch-snapshot pattern is reused with **Midnight providing settlement** for Paima state — the topology is inverted. The pattern itself is generic (epoch roots + aggregated validity proof) and the reuse is reasonable, but the inversion is not noted, which could mislead a reader following the cross-reference.

### 3. Accuracy Against Sources

- **"Midnight's existing GraphQL indexer"** — ✅ Confirmed. Midnight maintains an open-source, Rust-based GraphQL indexer (API v3) at `github.com/midnightntwrk/midnight-indexer`, supporting HTTP queries and WebSocket subscriptions.

- **"the Carp funnel for Cardano"** — ✅ Confirmed. Carp is dcSpark's Cardano Postgres indexer (Rust + TypeScript REST API). The Paima Carp funnel was shipped in Paima Engine v2.2.0 (January 2024). The analogy between a Midnight funnel and the Carp funnel is structurally valid.

- **"Midnight uses Plonk/KZG (BLS12-381)"** — ✅ Confirmed. Midnight migrated from Pluto-Eris to BLS12-381 in April 2025; the proving system is Plonk/KZG with ~6 ms verification and ~5 KB proof size.

- **"Paima's ZK layer uses Mina's Kimchi proof system (Pasta curves)"** — ⚠️ Accurate in substance but overstated. Paima does not implement Kimchi or Pasta curves directly; it delegates ZK to Mina Protocol (via a Zeko Labs partnership), which internally uses Kimchi over Pasta (Pallas/Vesta) curves. As of early 2026, this ZK integration is described as in active development ("working with Zeko to enable app-specific ZK rollups") and is not a production-complete core feature of the Paima engine. Framing it as "Paima's ZK layer" implies a first-party, shipped capability.

- **"`pallet-kachina`"** — ⚠️ Disputed pallet name. Inspection of `github.com/midnightntwrk/midnight-node` reveals no Substrate pallet named `pallet-kachina`. ZK proof verification is handled by `pallet-midnight` (which calls into the `midnight-ledger` library). "Kachina" names Midnight's smart contract *model* (from UC/ZK research), not a discrete runtime pallet. The companion `midnight-pallets.md` assessment in this repository uses `pallet-kachina` throughout; that name appears to be an informal label from background documents that does not match the actual pallet identifier in the published codebase.

- **"Nightstream-level IVC (incrementally verifiable computation)"** — ✅ The IVC characterisation is accurate. `assessments/starstream-nightstream.md` describes Nightstream as "a post-quantum ZK proving system based on lattice-based IVC over CCS." However, a critical qualifier is absent: Nightstream's **finalizer** — the component that compresses IVC accumulator state into a compact blockchain-verifiable proof — is not yet complete. Without it, Nightstream "emits *matrix evaluation obligations* that still need an outer SNARK to compress into a statement a blockchain verifier can check." Approach 3 therefore requires not merely "Nightstream-level IVC" but a completed Nightstream stack that does not yet exist.

- **"same curve-incompatibility problem that appears in the NearFall Technical Spec (BN254 vs BLS12-381)"** — ✅ The BN254/BLS12-381 incompatibility is a genuine, recurring concern documented across multiple assessments and journal entries in this repository. However, a companion Afterword (`modularity-comparison.md`) flags the specific BN254/Sirius claim as verified only internally, not against public NEAR sources. The broader incompatibility (NEAR/Sirius vs. Midnight/BLS12-381) is real; its precise technical boundary is uncertain.

### 4. Areas of Greatest Uncertainty

1. **`pallet-kachina` identity.** The pallet name used throughout this document and `midnight-pallets.md` does not match the actual pallet name in the Midnight node codebase. If `pallet-midnight` is the correct name, the description of Approach 2 ("inputs verified by `pallet-kachina`") is inaccurate at the implementation level, though functionally the description of what the pallet does is correct.

2. **Paima's ZK maturity.** The document implies Paima has a functional ZK integration layer. The Paima blog and release notes suggest this is an in-progress R&D partnership (Zeko), not a shipped production feature. The difficulty estimate for Approach 2 may be understated if Paima's own ZK tooling is not yet stable.

3. **Nightstream finalizer completeness.** Approach 3 is described as a "research-engineering project, not a near-term integration task" — which is correct — but the specific blocker (Nightstream's finalizer is incomplete) is not surfaced. Approach 3 is blocked by two open research problems in sequence: (a) the Nightstream finalizer, and (b) the circuit for Paima state machine execution. The difficulty label "Very hard" understates the current dependency on unfinished infrastructure.

4. **Option H topological reuse.** The document reuses the Option H epoch-snapshot pattern without noting the inversion (NEAR-as-settler → Midnight-as-settler). The settlement economics and proof aggregation requirements differ between these two topologies, and the mapping assessment's own Afterword notes that Option H's "~1 KB account size" depends on proof aggregation schemes that are not yet benchmarked or cited.

### 5. Robustness of Primary Conclusions

1. *Approach 1 (public layer only) is tractable in weeks.* **Robust.** The Carp funnel analogy is confirmed, the GraphQL indexer exists, and the Compact contract model supports public inputs. The weeks estimate is plausible.

2. *Approach 2 (ZK attestations) is Hard.* **Robust.** No existing Paima funnel handles ZK proof as a first-class input; the attestation interface requires original design work on both sides. The difficulty rating is well-justified.

3. *Approach 3 (ZK-proven execution) is Very hard.* **Robust, but understated.** The conclusion is correct, but it omits the Nightstream finalizer blocker. "Very hard near-term" should read "blocked pending Nightstream completion and ZK circuit design — not on the near-term roadmap."

4. *Core tension (open re-execution vs. private state) is fundamental.* **Robust.** This is the correct architectural diagnosis, well-reasoned and independent of any specific implementation detail.

5. *Practical recommendation (Approach 1 → 2).* **Robust.** Given the confirmed feasibility of Approach 1 and the research-scale nature of Approach 3, the staged recommendation is the correct risk-adjusted path.
