# Experiment Brief — Stateless Shielded Custody (C4 alternative A″)

**Date scoped:** 2026/07/03
**Owner:** _to be assigned_
**Target location:** `experiments/stateless-shielded-custody/`

---

## Goal

Empirically determine, on the latest stable Midnight stack, whether a Compact
contract can custody shielded coins **without publishing their
`QualifiedShieldedCoinInfo` (QSCI) in public ledger state**, and therefore
without the "QSCI publicity" privacy leak that the `insertCoin` pattern
carries. The design under test keeps the QSCI in wallet-local private state
(witness-supplied at spend time) and uses an encrypted on-ledger inbox as the
discovery and recovery channel.

The deliverable is a strict, reproducible statement of what works, what fails,
and what an observer actually sees — every finding backed by a transaction
hash, a captured compiler diagnostic, or a byte-level scan of observer
surfaces.

## Why this matters

The C4 (asset custody model) decision is currently framed as a binary: accept
publicly visible contract holdings (alternative A), or stay non-custodial for
shielded assets (alternative B/D) and give up "recovered account ⇒ recovered
assets". That framing rests on two claims from
`contract-custody-feasibility` that a subsequent re-assessment retracted:

1. **"Witness/off-ledger spend is structurally impossible"** — the S5 failure
   was a JS↔WASM glue crash during *off-chain* proving; the transaction never
   reached the node. Not a protocol verdict.
2. **"`Map.insertCoin` is the only spend path"** — OpenZeppelin's
   `compact-contracts` v0.2.0 ships `ShieldedTreasuryStateless.compact` and
   `ForwarderPrivate.compact` (caller-supplied QSCI, no coin in ledger), and
   `ledger-v8` exposes `ZswapInput.newContractOwned`. Both are
   simulator-only so far — unproven against a real node.

Ledger-source analysis (`midnightntwrk/midnight-ledger`) further shows the
chain publishes **no cleartext value or colour** for contract-owned coins:
`Input = {nullifier, Pedersen value commitment, contract address, root}`,
`Output = {commitment, Pedersen value commitment, contract address}`; the
commitment and nullifier are hashes over the coin's **random nonce**, hiding
to anyone who does not hold the coin info; circuit call arguments travel in
the communication commitment, not in cleartext. If witness-supplied spends
are accepted by the node, contract custody with near-user-coin privacy is
real, and the C4 decision changes shape.

## The design under test

- **Deposit** (`deposit_stateless`): the depositor claims the coin into the
  contract (`receiveShielded`) and stores ONLY an opaque blob — the coin
  info encrypted to the account's encryption key, which the contract
  advertises in public state (`enc_key`). No `insertCoin`.
  (The ledger forbids ciphertexts on contract-owned Zswap outputs —
  `MalformedOffer::ContractSentCiphertext` — so the standard encrypted
  coin-info channel is unavailable; the inbox is the replacement.)
- **Capture**: the client recovers the coin's `mt_index` from the indexer
  (`transactions(offset:{identifier}).startIndex`, the S5 technique) and
  stores the QSCI in wallet-local private state (C16 stand-in).
- **Spend** (`spend_stateless`): the QSCI enters the circuit as a witness;
  commitment/nullifier are computed in-circuit; change is re-owned to the
  contract in-transaction and returned to the caller through the private
  call result, then re-captured and backed up to the inbox
  (`append_backup`).
- **Control**: the same contract carries the S6/OZ `insertCoin` pattern
  (`deposit_public` / `spend_public`) as the leak-audit baseline.

## In scope — probes

Each probe produces a verdict backed by an evidence file.

- **W1 — compile-time disclosure.** Compile three variants that omit
  `disclose()` on coin data; capture the compiler's diagnostics verbatim.
  PASS = every forced disclosure is a hiding hash (commitment/nullifier
  link) or the 1-bit change branch — nothing forces raw nonce/colour/value
  publication — and the main contract compiles with declarations in place.
- **W2 — stateless deposit.** Deposit lands; `public_coins` stays empty;
  the inbox blob decrypts back to the exact coin; mt_index capture works.
- **W3 — witness spend (the settle-it).** Phase 1: full-amount spend with
  witness-supplied QSCI — node accept/reject is THE datapoint that settles
  the retracted S5 claim. Phase 2: partial spend; re-capture the change
  through the private call result plus candidate-mt_index retry; spend the
  change. Failures are classified: node rejection = protocol wall (design
  closed); glue crash = escalate to W4.
- **W4 — manual offer assembly (fallback).** Only meaningful if W3 reports
  a glue crash: bind the QSCI with `ZswapInput.newContractOwned` and
  assemble/submit the offer below midnight-js, to separate SDK gaps from
  protocol walls. Exploratory by design; records exactly where it stops.
- **W5 — third-party deposit + discovery.** A second wallet deposits using
  only public chain data (advertised `enc_key`); the owner discovers the
  coin purely from chain data (inbox decrypt + indexer lookup) and spends
  it. A missing contract-address→tx indexer surface is a real C17 finding.
- **W6 — observer leak audit.** Run the same lifecycle through the control
  and stateless paths; byte-scan every observer surface (raw tx, contract
  state) for nonce/colour/value. PASS = control leaks where predicted
  (positive control), stateless shows zero artefacts.

## Out of scope

- Device/grant authentication (proven in `account-custody-prototype`; adds
  variables here).
- The residual metadata leaks that are structural to ANY contract custody:
  the contract address in cleartext on deposits and spends, and
  depositor-side first-hop traceability (the depositor knows the coin info
  and the coin has no owner secret). These are documented as findings, not
  probed — they need no experiment.
- Production key management for the inbox encryption (the probe uses a
  stand-in X25519+AES-GCM construction; a real design specifies HPKE).
- Dust, Night, cross-chain, and fees (covered by sibling experiments).

## Setup

- **Stack (pinned):** `midnightntwrk/midnight-node:1.0.0`,
  `indexer-standalone:4.3.3`, `proof-server:8.1.0` — the latest stable line
  as of 2026/07/03 (2.0.0 exists only as release candidates; re-run this
  experiment when it stabilises). Compact toolchain **0.31.1** (latest),
  language 0.23. npm pins in `package.json` (`ledger-v8` ^8.1.0,
  `midnight-js` ^4.1.1 — latest published).
- **Harness:** copied from `account-custody-prototype` (wallet bring-up,
  providers, faucet contract) with the compose project renamed to avoid the
  infra name collision.
- **Reproducibility:** `./run-all.sh` compiles, brings up the devnet, runs
  every probe, writes `evidence/*.json`, and regenerates the FINDINGS
  results table.

## Deliverables

1. This directory: contracts (main + probes), TS runners, infra, evidence.
2. `FINDINGS.md`: pinned versions header; per-probe results table
   (generated); prose sections per probe; a verdict (one of):
   - *Stateless custody viable — witness spends accepted, no observer leak;
     C4 gains alternative A″.*
   - *Stateless custody blocked in SDK glue only — protocol accepts (W4);
     upstream fix needed; A″ remains the v1.0 target shape.*
   - *Protocol wall — the node rejects witness-QSCI spends; the C4 binary
     stands.*
3. Feedback into `docs/plans/components/C4-asset-custody-model.md` (new
   alternative A″ or its refutation), the asset-custody MPS open questions,
   and `contract-custody-feasibility/FINDINGS.md` (the S5 retraction).

## Acceptance criteria

- Every probe has a definitive verdict backed by an evidence file.
- W3's verdict is grounded in a node accept/reject, not an SDK error
  (glue crashes escalate to W4 rather than concluding).
- W6's scanner is validated by the positive control before the stateless
  claim is read.
- `./run-all.sh` runs end-to-end on a clean checkout; versions pinned in
  FINDINGS.

## References

- `experiments/contract-custody-feasibility/` — S1–S6, the S5 crash, the S6
  insertCoin pattern this design removes.
- `experiments/account-custody-prototype/` — the harness origin and the
  OZ-pattern circuits reused as the control group.
- OpenZeppelin `compact-contracts` v0.2.0 — `ShieldedTreasuryStateless.compact`,
  `ForwarderPrivate.compact`, `ShieldedMultiSigV3` discovery-flow docs.
- `midnightntwrk/midnight-ledger` — `zswap/src/structure.rs` (Input/Output),
  `coin-structure/src/coin.rs` (commitment/nullifier/nonce),
  `zswap/src/verify.rs` (`ContractSentCiphertext`),
  `ledger/src/structure.rs` (`ContractCall.communication_commitment`).
- `docs/plans/components/C4-asset-custody-model.md` — the decision this
  experiment feeds.
