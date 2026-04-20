# 🤖 Contract-to-Contract Calls in Midnight

Investigated whether Midnight v1 supports contract-to-contract calls, prompted by the NEAR ideas catalog entry for "receipt-based asynchronous execution" which implied this might be a gap. Evidence from the [ledger spec](https://github.com/midnightntwrk/midnight-ledger/tree/main/spec) shows it is not a gap — but the two models are architecturally distinct.

**Midnight does support contract-to-contract calls**, with the following characteristics (from `contracts.md` and `intents-transactions.md`):

- The `Effects` structure includes `claimed_contract_calls: Set<(u64, ContractAddress, Hash<Bytes>, Fr)>` — a contract declares which other contract invocations must be present in the same transaction.
- The `CallContext.caller` field is set to the calling contract's address when applicable.
- Sequencing is enforced: *"If `a` calls `b`, then `a` must causally precede `b`"* within a single intent. A's guaranteed section executes before B's guaranteed section; A's fallible section before B's fallible section.

**Key architectural difference from NEAR:** Midnight's model is **synchronous and intra-transaction** — all participating contracts are sequenced within a single intent, with causal ordering enforced at validation time. NEAR's model is **asynchronous and inter-block** — cross-contract calls are dispatched as receipts processed in a subsequent block, by deliberate design to remove colocation incentives.

This distinction has several implications for the NEARFall evaluation:

- The NEAR ideas catalog entry for receipt-based async execution is not filling a gap in Midnight; it represents a genuinely different composability model with different tradeoffs.
- Midnight's synchronous model avoids the callback gas limit problem and the partial-atomicity risks noted in the journal entry for 2026-03-17, at the cost of being unable to span multiple blocks.
- NEAR's async model enables the cross-shard parallelism that underlies its throughput advantages, but introduces liveness and ordering risks also noted on 2026-03-17.
- Adopting NEAR's async receipt model in Midnight (Option 3) would be a deliberate design regression in atomicity guarantees, not a straightforward enhancement.

## Sources

- [Midnight ledger spec](https://github.com/midnightntwrk/midnight-ledger/tree/main/spec)
- [contracts.md — Effects structure, claimed_contract_calls, CallContext.caller](https://github.com/midnightntwrk/midnight-ledger/blob/main/spec/contracts.md)
- [intents-transactions.md — segment ordering and sequencing within an intent](https://github.com/midnightntwrk/midnight-ledger/blob/main/spec/intents-transactions.md)
- [NEAR data flow — async receipt-based execution model](https://docs.near.org/concepts/data-flow/near-data-flow)
- Journal entry 2026-03-17 — internal project notes on Midnight/NEAR composability tradeoffs

---

## Afterword: Quality Scrutiny

### 1. Source Retrievability

- The [ledger spec](https://github.com/midnightntwrk/midnight-ledger/tree/main/spec) URL is publicly accessible. Both `contracts.md` and `intents-transactions.md` exist in that directory and were retrieved successfully.
- No deep-links to specific sections or line numbers are provided; readers must search both documents manually to locate the cited structures.
- The NEAR async-receipt model claims carry no source citation. The characterisation is broadly consistent with NEAR's public documentation and whitepapers, but a reader cannot verify it from this document alone.
- The reference to "journal entry for 2026-03-17" is an internal project cross-reference, not independently retrievable.

### 2. Internal Consistency

- The document is internally consistent. The contrast between synchronous intra-transaction (Midnight) and asynchronous inter-block (NEAR) is drawn once and then applied consistently across all four implication bullets.
- The framing of "not a gap" versus "a different model" is maintained throughout without contradiction.

### 3. Accuracy Against Sources

- **`claimed_contract_calls: Set<(u64, ContractAddress, Hash<Bytes>, Fr)>`** — Verified verbatim in `contracts.md`. The four tuple components are: sequence number (ordering), contract address, hash of the entry point, and communication commitment.
- **`CallContext.caller`** — Verified in `contracts.md`. The document is accurate but omits that `caller` is resolved via a priority hierarchy: (1) calling contract's address, (2) common owner of all UTXO inputs, (3) absent otherwise. The simplified statement ("set to the calling contract's address") is correct for the inter-contract case but not a complete description.
- **Causal-ordering rule** — The italicised sentence *"If `a` calls `b`, then `a` must causally precede `b`"* is presented with formatting that implies it is a direct quotation from the spec. It is not. The spec formalises the constraint at segment level: *"If two segments `a < b` call the same contract, then one of the following must be true: `a` does not have a fallible transcript for this call; `b` does not have a guaranteed transcript."* The paraphrase correctly captures the intent, but the quotation marks are misleading.
- **Synchronous intra-transaction execution** — Verified. `intents-transactions.md` confirms that all contract actions are sequenced within a single intent via segment-ID ordering, with guaranteed sections executing before fallible ones.
- **NEAR "by deliberate design to remove colocation incentives"** — This specific framing of NEAR's design motivation is not sourced. NEAR's receipt model is primarily documented as enabling cross-shard parallelism; the "colocation incentive removal" framing is a secondary derived property that appears in some NEAR ecosystem discussions but is not the primary stated rationale in NEAR's core documentation.

### 4. Areas of Greatest Uncertainty

- **Segment-level nuance.** The document describes sequencing as if it applies to contracts directly, whereas the spec's unit of sequencing is the *segment* (a `u16`-identified atomic grouping within a transaction). It is unclear whether the simplified contract-level description holds in all edge cases, e.g. multiple segments invoking the same contract pair.
- **Guaranteed vs. fallible transcript interplay.** The two-phase execution model (guaranteed transcript always applied; fallible transcript reverts to post-guaranteed state on failure) is not mentioned. This distinction matters for understanding partial-failure semantics in inter-contract calls.
- **NEAR design intent.** The claim that NEAR's async model was designed to remove colocation incentives is plausible but unsourced. It would be strengthened by a citation to the NEAR sharding design document or a Rainbow Bridge / runtime architectural decision record.
- **Completeness of the `Effects` structure.** Only `claimed_contract_calls` is discussed; whether other `Effects` fields constrain inter-contract semantics in ways relevant to the NEARFall evaluation is not examined.

### 5. Robustness of Primary Conclusions

The two primary conclusions are:

1. *Midnight supports contract-to-contract calls synchronously within a single intent.*
2. *This is architecturally distinct from NEAR's asynchronous inter-block receipt model, not a gap to be filled.*

Both conclusions are **robust**. The spec evidence for Midnight's synchronous model is direct and specific; even granting the segment-level nuance and the paraphrased quotation, the intra-transaction, causal-ordering character of Midnight's C2C calls is unambiguous. The NEAR contrast, though unsourced on the colocation-incentive point, rests on the well-established fact that NEAR receipts cross block boundaries — this is uncontroversial in NEAR's technical literature and does not depend on the specific design-motivation framing. The implication that adopting NEAR's async model in Midnight would regress atomicity guarantees follows logically from the architectural comparison and is sound.

The one place where over-confidence is possible: the document does not examine whether Midnight's synchronous C2C model has *practical* limitations (e.g., proof-size blowup for deeply nested inter-contract calls, or gas/cost-model constraints) that might make the comparison less favourable in high-throughput scenarios. That is a scoping choice, not an error, but should be noted when using this assessment to inform Option 3 trade-offs.
