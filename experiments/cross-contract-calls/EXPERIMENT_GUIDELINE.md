# Experiment Brief: Compact Cross-Contract Calls

**Date opened:** 2026/09/03
**Component:** contract composability for the account contract (consequences for MIP-0012 section 6.6, MIP-0013 privacy claims, and, in the opposite direction, the MIP-0007 delegated-owner amendment, which needs the registry as callee to recognise the account as its caller).
**Base:** harness copied from the account-custody reference implementation (worktree `arc-passport-k1-arm/contract/`, branch `nicolasdp/ecdsa-k1-arm`, commit `2b0b55d`); house format from `experiments/contract-to-contract-transfer/`.

## Question

How do Compact cross-contract calls work end to end on the current toolchain,
and can the passport account contract participate?

## Why now

Upstream shipped cross-contract calls in toolchain 0.33.0 (rc line) and 0.34.0
(stable, 2026/08/25), targeting ledger 9, which the running chain forks to.
Every artefact we hold so far stops short of the network boundary: the compile
probes used `--skip-zk` (vacuous verifier-key fingerprints), and the runtime
smoke test, although it executed the call tree on this experiment's exact
published pin set (artefacts compiled on 0.34.0, compact-runtime 0.19.0),
bypassed the indexer with a local state provider. Upstream's own end-to-end
demonstrations of atomicity and read-your-writes run on branch stacks, not on
any released pin set. The client-composed transfer experiment of 2026/07/16
proved the two-contract transaction by client-side grafting; this experiment
probes the in-circuit call, which supersedes that graft if it works, and it
decides whether the account contract becomes a callable public ABI.

## Design under test

Two minimal contracts exercise the mechanism, then the real account contract
replaces the toy callee:

- `tally.compact` (callee): `set(x)`, `get()`, `set_guarded(expected, x)`
  over one `total` ledger cell, plus whatever bookkeeping each probe needs.
- `caller.compact` (caller): declares `contract Tally`, holds the reference
  in its ledger from a constructor argument, and exposes
  `write_then_read(x)` (calls `set` then `get`, asserts read-your-writes
  in-circuit) and `compose_guarded(expected, x)` for the atomicity probe.
- `account.compact` (P5 callee): vendored verbatim from the k1-arm worktree.
- `account-gate.compact` (P5 caller): declares `contract Account` with one
  seam-gated, coinless, witness-free circuit, forwards the owner's signature
  bundle through the call boundary, and increments its own counter in the
  same circuit.
- `till.compact` (P6/P7 callee, added by the 2026/09/03 value directive):
  `take_unshielded` and `take_shielded` claim incoming value, with receipt
  mirrors and counters; witness-free by necessity, so the claimed shielded
  coin is retained in a public ledger cell.
- `payer.compact` (P6/P7 root caller): declares `contract Till`, holds the
  callable reference and the raw `ContractAddress` separately (there is no
  cast between a contract type and `ContractAddress`), funds itself by
  in-circuit mint of its own color, and exposes `pay_unshielded` plus
  `pay_shielded`, the latter consuming the `payer_coin` coin-store witness
  in a root circuit that contains a call site.
- `lender.compact` (P9, added by the 2026/09/14 provenance directive): a
  leaf contract exporting `lend(addr, ep_hash, comm)`, which emits
  `kernel.claimContractCall` on wholly client-supplied arguments for a
  callee call its own circuit never made, plus a `lends` counter so the
  transaction changes public state.
- `rust/caller-context/` (P8, P9): a Rust tool that runs the ledger's own
  `ContractCall::context(...).caller` derivation, built from
  `midnight-ledger` at git tag `ledger-9.1.0.0-rc.3`, over serialised
  transaction bytes off-node and prints the per-call caller graph. It never
  runs `well_formed`, so it resolves callers for bytes a node would refuse;
  the probes pair it with the node's verdict.

### Toolchain decision

Pinned to the latest stable toolchain (directive of 2026/09/03) and the
newest published client set, validated in a pre-flight on this workspace
(the toy pair compiles on 0.34.0 with `pragma language_version 0.26`, and
the runtime-level cross-contract execution smoke passes on the published
client set):

| Layer | Pin |
|-------|-----|
| Compiler | compactc 0.34.0 stable (language 0.26.0, ZKIR v3 capable), invoked as `compact compile +0.34.0` |
| Runtime | @midnight-ntwrk/compact-runtime 0.19.0, forced everywhere via npm `overrides` |
| Client | @midnight-ntwrk/compact-js 2.5.5-rc.8, midnight-js 5.0.0-beta.7 |
| Ledger | @midnightntwrk/ledger-v9 1.0.0-rc.3 |
| Wallet SDK | facade and dust-wallet 5.0.0-beta.2, shielded and unshielded 4.0.0-beta.2, hd 3.1.0-beta.1 |
| Localnet | midnight-node 2.1.0-2e92c4ae642c, indexer-standalone 4.4.0-rc.2, proof-server 9.0.0-rc.6 |

midnight-js 5.0.0-beta.7 carries the whole cross-contract client surface
(always-on `crossContract` config, lazy callee-state resolver,
`nodeZkConfigRegistry`, and the registry overload of
`httpClientProofProvider`). compact-js 2.5.5-rc.8 dep-pins compact-runtime
0.19.0-rc.0, so `package.json` carries an `overrides` block forcing 0.19.0:
the tree dedupes to a single runtime instance (two instances break WASM
class identity, upstream issue #611) and the generated code's
`checkRuntimeVersion('0.19.0')` passes. The wallet SDK pins are carried
over unchanged from the account-custody reference harness; only canaries
are newer on npm.

### Out of scope, by decision

- **Value movement in the mechanism probes (P0 to P5).** Those probes stay
  coinless: node 2.1.0's fee model mempool-rejects small call+offer
  transactions (`OutsideTimeToDismiss`) and would confound the
  cross-contract question. A directive of 2026/09/03, issued once P0 to P5
  had passed, reinstated the value question as P6 and P7 with the confound
  handled by design: both value probes fund by in-circuit mint of the
  payer's own color to `kernel.self()`, so no wallet offer appears anywhere
  and the fee wall stays out of the question. Issue #658, which blanked the
  callee's Zswap local state on the 0.33 line, is claimed fixed in 0.34.0;
  P7 is the on-chain verdict on that fix.
- **The 0.33.0-rc line.** Superseded by the stable 0.34.0 pin; an earlier
  draft of this experiment targeted it and was reconciled.
- **`kernel.caller()`.** No released compactc exposes it, so no probe keys
  authority on it and no circuit here reads VM context slot 6. The ledger
  below does derive the calling contract's address per call frame and place
  it at that slot (MPS-0029; `spec/contracts.md`, section Context;
  `ledger/src/structure.rs`, `ContractCall::context`, at tag
  `ledger-9.1.0.0-rc.3`), so the gap a probe would hit is the missing
  Compact surface, plus, for the calling circuit's identity, a record no
  layer keeps. What is in scope, by the 2026/09/14 provenance directive, is
  the derivation itself and the claim discipline behind it: P8 runs the
  ledger's own derivation code over our transaction bytes, and P9 exercises
  a chosen-argument `kernel.claimContractCall` on the node. Neither observes
  a node evaluating a slot-6 read.
- **Dynamic implementation binding.** Draft CoIP-3 (PR #628); one
  implementation per contract type, resolved statically, is the shipped
  model.

## Probes

| ID | Question | Success criterion |
|----|----------|-------------------|
| P0 | Do Tally and Caller compile with real proving keys (no `--skip-zk`), and what do keys cost? | Both bundles carry real verifier keys and populated `expectedVk` fingerprints; compile wall time, key sizes, and ZKIR version recorded. |
| P1 | Does the published compact-runtime execute the call tree offline (local state provider)? | One `callProofDataTrace` entry per source-level call (so `write_then_read` yields three: `set`, `get`, and the root last); `commCommData` present on every callee entry, absent on the root; callee ledger advanced; read-your-writes observed in-circuit. |
| P2 | Do deploy-with-contract-reference and the indexer's block-pinned callee-state query work? | Tally and Caller deployed (`{ bytes: encodeContractAddress(tallyAddress) }` as constructor argument); the GraphQL contract-state query the callee-state resolver issues answers at a pinned block; the result recorded either way. |
| P3 | Does a real multi-call transaction clear the localnet end to end? **The headline.** | `caller.callTx.write_then_read(42n)` accepted by the node; the whole call tree proven (one proof per source-level call, three in total); `tally.total == 42` and `caller.last_observed == 42` via indexer reads; tx structure dumped as observer evidence; call-tree proving time and tx size recorded. |
| P4 | Is failure atomic on-node for a stale composed call? | A composed `compose_guarded` built against pre-interleave state, invalidated by a direct `tally.set`, is rejected (node-side or fallible); neither contract's state changes from the stale transaction. |
| P5 | Can the account contract be a callee behind its authorisation seam? Best-effort. | The composed gated call lands: the account applies the owner-authorised operation and the gate's counter increments in one transaction; the corrupted-signature negative fails, with the failure stage (construction or node) recorded. A published-stack gap yields verdict BLOCKED with the exact failure as evidence. |
| P6 | Does unshielded value move contract to contract across an in-circuit call? | `payer.fund_unshielded` mints the payer's own color to itself (mirror credited); `payer.pay_unshielded` debits the mirror, sends to the Till's address, and drives `till.take_unshielded` in the same circuit; one landed transaction with the payer mirror debited and the till mirror credited, then a later `assert_unshielded_balance` on each contract makes the node attest settled custody. If the in-circuit mint path is impossible, fall back to a user-funded deposit; if that hits the fee wall, record the exact numbers and verdict honestly (BLOCKED or PARTIAL with the mempool error is real evidence). |
| P7 | Does shielded value move across the boundary, with a callee executing `receiveShielded` on the published 0.19.0 runtime (the issue #658 verdict)? | `payer.fund_shielded` mints a shielded coin to the contract itself and the client captures its `mt_index`; `pay_shielded` consumes the `payer_coin` witness (a witness-consuming root circuit containing a call site, closing that open question), sends to the Till's address, and drives `till.take_shielded(result.sent)` in the same transaction; verify the till-held coin's nonce equals `result.sent`'s (deterministic nonce evolution across the boundary), the claim counter advanced, and the change follows the surviving-coin rule. |
| P8 | What does the ledger's own `CallContext.caller` derivation resolve to, per call frame, on the real bytes of our composed transaction? | Run `rust/caller-context` (the ledger's `ContractCall::context` at `ledger-9.1.0.0-rc.3`, built from the git tag) over the `write_then_read` transaction captured at every stage (offline-unproven, unproven, proven, balanced) and submitted; the Tally `set` and `get` frames resolve to `Contract(<Caller address>)` and the root frame to `None` on every capture, the Rust and TypeScript views agree on every address, entry-point hash, commitment, and claim, and the composition lands; record whatever actually resolves. |
| P9 | Can a contract lend itself as the caller of a call its circuit never made, by emitting `kernel.claimContractCall` on client-supplied arguments? | Compose, in one intent, a direct root `Tally.set(v)` and `Lender.lend(tally, ep_hash(set), comm-of-that-set-call)`, claimant first; prove, submit, and record the stage at which it is accepted or refused with the exact error; run the P8 tool over the composed bytes and record what `set`'s caller resolves to. Controls: the same with a wrong commitment (subset check), a `set` that is both a genuine sub-call of `Caller` and claimed by `Lender` (uniqueness check), and the claimant placed after the claimed call (sequencing check), each with its refusal stage and the node's own error. A refusal at any stage with the exact error is the finding as much as an acceptance is. |

Probe files are `src/tests/p0-keyed-compile.ts` through
`src/tests/p9-lending.ts` (the names `run-all.sh` dispatches on; P9's
composition helpers live in `src/tests/p9-compose.ts`); each writes
`evidence/<id>-<name>.json` through `src/tests/evidence.ts`, and P8 and P9
also write every transaction capture they analyse as `evidence/<id>-tx-*.hex`
(the balanced captures of the accepted transactions are byte-identical to
the indexer's copies). P0 and P1 need no chain; P2 to P9 run against the
composed localnet. P8 and P9 additionally need
`rust/caller-context/target/release/caller-context` built beforehand
(`cargo build --release` in `rust/caller-context/`; `run-all.sh` does not
build it) and write `BLOCKED` with the build instruction when it is absent.
Probes are sequential and `run-all.sh` gates each on the previous verdict
in a full run.

## Interpretation grid

- **P3 PASS** means in-circuit cross-contract calls work on the released
  pinned stack today: the client-composed graft of 2026/07/16 has a
  contractual successor, and the custody MIP's one-hop rules need a call-mode
  amendment (the linkage cost is measured in P3's observer dump).
- **P2 fails on the indexer state query** means the released indexer cannot
  resolve callee state (the upstream branch-only `state-as-of` gap); the
  finding is the exact missing query, the upstream ask is precise, and the
  local execution results (P0, P1) still stand.
- **P3 blocked at the proof server** means the 0.34.0 keys and the
  claimContractCall kernel ops do not prove on proof-server 9.0.0-rc.6;
  record the request and response verbatim as the upstream report.
- **P4 shows a state change from the stale transaction** would contradict
  the documented atomicity model and outranks every other finding; anything
  else (rejection at node or in the fallible section, with no state change)
  confirms atomicity on a released stack for the first time.
- **P5 PASS** means the account contract can compose with counterparty
  contracts today, and the account's circuit signatures become a public ABI
  with third-party dependents (raising the cost of the pending erratum
  fixes). **P5 BLOCKED** with a recorded gap is itself the answer for the
  MIP timeline: composition waits on the stack, not on our design.
- **P6 PASS** means unshielded value genuinely moves contract to contract
  across the call boundary, send paired with a same-transaction claim, and
  the fee wall is a funding constraint rather than a mechanism constraint.
- **P7 PASS** is the issue #658 verdict on the released runtime: shielded
  operations work in callees, a witness-consuming root circuit may hold a
  call site, and the deterministic nonce evolution is boundary-stable.
  Either value probe BLOCKED on the fee wall records the exact mempool
  numbers as the finding.
- **P8 PASS** means the ledger's `Contract` arm has been watched firing on
  real transaction bytes, which converts the source reading behind the
  call-provenance MPS into an observation of the derivation; it says
  nothing about a callee reading the value, which no released Compact can
  do.
- **P9 accepted** means voluntary lending is real: a caller-side claim is
  consent to be named, not proof of having called, and a specification of
  the slot-6 reader must say so. **P9 refused** at any stage, with the
  exact error, is the finding that the arm is bound to the runtime's own
  call trace. The controls locate the claim discipline (construction,
  proving, or node admission).

## Constraints

- Local devnet only, fresh volumes, unique compose project name
  (`cross-contract-calls`); ledger 9 has no 8-to-9 state migration.
- The mechanism probes (P0 to P5) stay coinless: node 2.1.0 mempool-rejects
  small call+offer transactions (`OutsideTimeToDismiss`), which would
  confound the cross-contract question with a known fee-model limit. The
  value probes (P6, P7) carry value but fund by in-circuit mint, so no
  wallet offer meets that wall.
- Every probe circuit changes public state: a zero-effect call can hang the
  wallet SDK finalisation watch.
- Exact npm pins only (no `^` on Midnight packages): two copies of
  compact-runtime break WASM class identity (upstream issue #611).
- Artefact directory names are ABI: compiled bundles live at
  `contracts/managed/<DeclaredContractTypeName>` side by side, because the
  caller's generated JS imports its callee by relative path; the callee
  compiles before the caller (`--compact-path contracts/managed`).
- The vendored `account.compact` is provenance-recorded (worktree branch and
  commit in the README) and never edited here beyond replacing the floating
  pragma with the pinned language version and a provenance header; the
  contract body stays byte-identical to upstream.
- Reproducibility: `./run-all.sh` end-to-end on a clean checkout; every
  probe writes `evidence/*.json`; `FINDINGS.md` regenerates from evidence.
