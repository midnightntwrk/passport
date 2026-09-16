# Compact Cross-Contract Calls

How do Compact cross-contract calls work end to end on the current stable
toolchain (compactc 0.34.0, ledger 9, midnight-js 5.0.0-beta.7), and can the
passport account contract participate as a callee?

Upstream shipped in-circuit contract-to-contract calls in 0.34.0, but every
end-to-end demonstration of theirs runs on branch stacks. This experiment
takes a minimal caller/callee pair through compile, deploy, prove, submit,
and atomic failure on the released pin set, then replaces the toy callee
with the real account contract behind its authorisation seam, and finally
moves real value, unshielded and shielded, across the call boundary with a
payer/till pair funded by in-circuit mints so the known node 2.1.0 fee wall
stays out of the question. Two provenance probes then ask what the ledger
itself derives as each call's caller, by running the ledger's own code on
the transaction bytes, and whether a contract can lend that identity to a
call it never made. It differs
from [`experiments/contract-to-contract-transfer/`](../contract-to-contract-transfer/)
in one sentence: that experiment grafted two contracts into one transaction
client-side on ledger 8, whereas here the composition is expressed in the
circuit itself and proven as a call tree on ledger 9. See
[`EXPERIMENT_GUIDELINE.md`](EXPERIMENT_GUIDELINE.md) for the brief and
[`FINDINGS.md`](FINDINGS.md) for results.

## Probes

All ten probes pass: P0 to P5 on a clean `./run-all.sh --fresh`
reproduction and the value probes P6 and P7 first attempt against the same
localnet (2026/09/03), then the provenance probes P8 and P9 on a fresh
ledger-9 localnet (2026/09/14); see [`FINDINGS.md`](FINDINGS.md) for the
evidence-backed table.

| ID | Question | Verdict |
|----|----------|---------|
| P0 | Do the caller/callee pair compile with real proving keys, and what do keys cost? | PASS |
| P1 | Does the published compact-runtime execute the call tree offline (trace shape, communication commitments, read-your-writes)? | PASS |
| P2 | Do deploy-with-contract-reference and the indexer's block-pinned callee-state query work? | PASS |
| P3 | Does a real multi-call transaction clear the localnet end to end? (headline) | PASS |
| P4 | Is failure atomic on-node for a composed call made stale between proving and submission? | PASS |
| P5 | Can the account contract be a callee behind its authorisation seam? (best-effort) | PASS |
| P6 | Does unshielded value move contract to contract across an in-circuit call (send plus same-transaction claim, mint-funded)? | PASS |
| P7 | Does shielded value move across the boundary: a callee executing `receiveShielded` on the published runtime (the issue #658 verdict), driven by a witness-consuming root? | PASS |
| P8 | What does the ledger's own `CallContext.caller` derivation resolve to on the real bytes of our composed transaction (sub-calls to `Contract(<Caller>)`, the root to `None`)? | PASS |
| P9 | Can a contract lend itself as the caller of a root call its circuit never made, by emitting `kernel.claimContractCall` on client-supplied arguments, and where does the node refuse the subset, uniqueness, and sequencing controls? | PASS (lending admitted; all three controls refused at node admission by name) |

## Run

```sh
./run-all.sh                 # compile (real keys), devnet up, P0 → P9, gated
./run-all.sh --fresh         # reset chain state first
./run-all.sh --tests p2,p3   # a subset, ungated
```

Prerequisites: Docker (daemon running), Node.js >= 22, `compact` on PATH with
the 0.34.0 toolchain installed (`compact update`), openssl, and, for P8 and
P9, a Rust toolchain (1.98 stable was used) with the caller-derivation tool
built beforehand: `cd rust/caller-context && cargo build --release`
(`run-all.sh` does not build it, and both probes write `BLOCKED` with that
instruction when the binary is absent). Probes are sequential: P0 and P1
are chainless; P2 deploys and writes `deployment.json`; P3, P4, P8, and P9
reconnect from it (P9 also deploys the Lender, recorded under `lender`);
P5 to P7 are self-contained, each deploying its own pair (P6 and P7 record
theirs in `deployment.json` under `till-p6`, `payer-p6`, `till-p7`, and
`payer-p7`). In a full run each probe gates on the previous verdict.

## Layout

- `contracts/tally.compact`: the toy callee (`set`, `get`, `set_guarded`
  over one `total` cell).
- `contracts/caller.compact`: declares `contract Tally`, holds the reference
  from a constructor argument, exposes `write_then_read` and
  `compose_guarded`.
- `contracts/account.compact`: the P5 callee.
- `contracts/account-gate.compact`: the P5 caller, one seam-gated, coinless,
  witness-free circuit (`compose_gated`) forwarding the owner's signature
  bundle to `rotate_enc_key_with_jubjub` and incrementing its own counter.
- `contracts/till.compact`: the P6/P7 value-receiving callee
  (`take_unshielded`, `take_shielded`, receipt mirrors and counters);
  witness-free by necessity, so the claimed shielded coin is retained in a
  public ledger cell.
- `contracts/payer.compact`: the P6/P7 value-sending root; declares
  `contract Till`, carries the callable reference and the raw
  `ContractAddress` separately, funds itself by in-circuit mint of its own
  color, and pays across the call boundary (`pay_unshielded`, and
  `pay_shielded` consuming the `payer_coin` coin-store witness).
- `contracts/lender.compact`: the P9 claimant; `lend(addr, ep_hash, comm)`
  emits `kernel.claimContractCall` on client-supplied arguments for a call
  its own circuit never made, and bumps a `lends` counter.
- `src/tests/p0..p9`: the probes (P9's composition helpers in
  `src/tests/p9-compose.ts`); every probe writes `evidence/*.json`, P8 and
  P9 also write the transaction captures they analyse as
  `evidence/p8-tx-*.hex` and `evidence/p9-tx-*.hex` (with the node's own
  refusal lines for the P9 controls in `evidence/p9-node-rejections.txt`),
  and `src/compose-findings.ts` regenerates the results table in
  `FINDINGS.md`.
- `rust/caller-context/`: the Rust tool P8 and P9 call. It runs the ledger's
  own `ContractCall::context(...).caller` derivation, from `midnight-ledger`
  at git tag `ledger-9.1.0.0-rc.3` (no path dependency; `Cargo.lock`
  tracked), over serialised transaction bytes off-node and prints the
  per-call caller graph; see its `README.md` for what it is not.
- `src/node/`: wallet and provider plumbing (leaf `NodeZkConfigProvider`
  per contract, `nodeZkConfigRegistry` into the proof provider so call trees
  prove).
- `src/tests/account-client/`: the trimmed JubJub signer and wave-deploy
  slice P5 needs.
- `src/tests/value-client/`: the vendored coin-store witness, `mt_index`
  capture, and circuit-result slices P7 needs.

## Provenance

- `contracts/account.compact` is vendored verbatim from the account-custody
  reference implementation worktree (`arc-passport-k1-arm/contract/`, branch
  `nicolasdp/ecdsa-k1-arm`, commit `2b0b55d`); the only local edit replaces
  the floating `pragma language_version >= 0.17.0` with the pinned
  `pragma language_version 0.26` plus a provenance header, and the contract
  body is byte-identical to upstream.
- `src/tests/account-client/{contract,signer,deploy}.ts` are trimmed
  adaptations of that worktree's `src/wallet/{contract,signer,wave-deploy}.ts`
  (JubJub arm only), each carrying a provenance header.
- `src/tests/value-client/{witnesses,capture,result}.ts` are trimmed
  adaptations of the same worktree's `src/wallet/{witnesses,capture,account}.ts`
  (the MIP-0012 section 6.5 coin store, the commitment-tree window capture,
  and the circuit-result extraction), each carrying a provenance header.
- `src/node/wallet.ts` and the harness shape are copied from the same
  worktree and adapted to midnight-js 5.0.0-beta.7; house format from
  `experiments/contract-to-contract-transfer/`.
