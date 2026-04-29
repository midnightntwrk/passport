# Contract Custody Feasibility — Findings

> **Status: executed 2026/04/28, S5 + S6 added 2026/04/29, against
> devnet `midnight-node:0.22.5` / the latest published
> `@midnight-ntwrk/*` family.** Six tests PASS with on-chain tx
> hashes; six FAIL — two with the same SDK-side multi-contract-call
> bug, two with missing Dust paymaster APIs, and two (S3 / S5) whose
> "blocked" framing is **invalidated by S6**: the OpenZeppelin
> `Map<color, QualifiedShieldedCoinInfo>` + `Map.insertCoin` pattern
> enables contract-held shielded spending on Midnight v1 today,
> end-to-end on devnet (deposit `00f582dd…f5fe6` and spend
> `00cdaf64…fc2d5b1`). All the primitives are documented — the
> top-level circuits at `/compact/standard-library/exports`, and
> `Map.insertCoin` / `Set.insertCoin` at `/compact/data-types/
> ledger-adt`. The experiment's earlier "missing API" framing was
> simply us not having found the data-types page; the contract-side
> recipe was already discoverable. Verdict and Passport-account-
> model implications below.

## Headline findings

1. **Shielded user→contract custody works on Midnight v1 today.**
   Recipe: derive the on-chain colour with `rawTokenType` from
   `@midnight-ntwrk/ledger-v8`, then call `receive_shielded({nonce,
   color, value})` with the derived colour. The earlier framing of
   this as an "SDK gap" was operator error — `rawTokenType` is a
   public function exported by the latest `ledger-v8`, and the wallet
   exposes its qualified note set via `state.shielded.availableCoins`.
   See the working tutorial at
   [`../../midnight-receive-shielded-sdk-gap-repro/`](../../midnight-receive-shielded-sdk-gap-repro/)
   (despite the legacy directory name, the repo now demonstrates the
   working recipe in three demos).

2. **U2 and U4 fail by SDK gap, not by a node bug.** We now know that
   `sendUnshielded → ContractAddress` is rejected
   (`1010: Invalid Transaction: Custom error: 186`,
   `MalformedError::EffectsCheckFailure`) because the protocol
   requires every `sendUnshielded` to be paired with a matching
   `receiveUnshielded` by the recipient contract **in the same
   transaction** — intentional behaviour, to prevent tokens being sent
   out that can never be received. Two SDK-side gaps prevent
   exercising that shape from a dApp today: (a) `midnight-js` does not
   yet expose a utility to combine calls from two different contracts
   into a single transaction; (b) a wallet fee-balancing bug blocks
   the resulting transaction even if it could be constructed. Fix PRs
   for both are pending upstream — the wallet fix had been proposed
   previously in
   [`midnight-wallet#293`](https://github.com/midnightntwrk/midnight-wallet/pull/293)
   but never merged. The symptom remains tracked as
   [`midnight-ledger#233`](https://github.com/midnightntwrk/midnight-ledger/issues/233);
   the focused minimal reproducer is at
   [`../../midnight-error-186-repro/`](../../midnight-error-186-repro/).

3. **Contract-held shielded spending works on Midnight v1 today —
   via the OpenZeppelin `Map<color, QSCI>` + `insertCoin` pattern.**
   S3 and S5 jointly suggested the path was "blocked at two layers"
   (a missing client-discovery API plus an SDK / runtime gap). S6
   invalidates that framing. OpenZeppelin's `add-multisig` branch
   (`contracts/src/multisig/ShieldedTreasury.compact`) showed a
   different contract-side recipe: track each held coin in a ledger
   `Map<Bytes<32>, QualifiedShieldedCoinInfo>`, register it via
   `Map.insertCoin(color, coin, selfAsRecipient())` immediately
   after `receiveShielded`, and at spend time pull the QSCI back via
   `Map.lookup(color)` before passing it to `sendShielded`.
   `Map.insertCoin` is a specialised Map method: it takes a
   `ShieldedCoinInfo` (no `mt_index`) and the runtime lifts it to a
   `QualifiedShieldedCoinInfo` by binding the Merkle tree position
   that `receiveShielded` allocated *in the same transaction*. The
   docs put it precisely: *"This index must have been allocated
   within the current transaction or this insertion fails."* Change
   is re-deposited via `sendImmediateShielded` + another
   `insertCoin` (or `Map.remove` if the spend consumed the full
   coin). All four primitives — `mergeCoinImmediate`,
   `Map.insertCoin`, `sendImmediateShielded`, and the
   `ShieldedSendResult.{change, sent}` shape — compile against
   `compact 0.30.0`. S6 ports the recipe verbatim (as `oz_deposit` /
   `oz_send_to_user` in `custody.compact`) and lands a full
   user→contract deposit followed by a cross-block contract→user
   spend on `midnight-node:0.22.5`: deposit
   `00f582ddffc51368…f5fe6`, spend
   `00cdaf640bb97d72…fc2d5b1` (`evidence/s6-…json`). What S5
   *actually* showed is that taking a `QualifiedShieldedCoinInfo`
   as a witness parameter (instead of reading it from contract
   ledger state) is the wrong contract pattern — the runtime needs
   the QSCI bound to the contract's local Zswap state via
   `insertCoin`, which is what `Map.lookup` returns. S3's
   "missing client API" framing is also wrong: discovery lives in
   the contract's ledger map, not in the SDK. The pattern is real
   today, and every primitive it uses is documented:
   `receiveShielded`, `sendShielded`, `sendImmediateShielded`,
   `mergeCoinImmediate`, and `mintShieldedToken` at
   `/compact/standard-library/exports`; `Map.insertCoin`,
   `Set.insertCoin`, and `List.pushFrontCoin` at
   `/compact/data-types/ledger-adt`. The earlier "missing API"
   framing in this experiment came from looking on the
   `standard-library/exports` page only and not navigating to the
   data-types page where the ledger ADT methods live — a research
   miss on our side, not a docs gap.

4. **Dust paymaster has no public API.** The wallet always pays.
   D1 (contract pays own tx fee) and D2 (contract pays user's tx
   fee) both surface as documented absence rather than runtime
   failure. The "user without Dust" version of the Passport
   onboarding flow is not implementable on v1 today.

## Header

| Field                          | Value                                              |
| ------------------------------ | -------------------------------------------------- |
| Date run                       | 2026/04/28                                         |
| Devnet image (node)            | `midnightntwrk/midnight-node:0.22.5`               |
| Devnet image (indexer)         | `midnightntwrk/indexer-standalone:4.2.1`           |
| Devnet image (proof srv)       | `midnightntwrk/proof-server:8.0.3`                 |
| Compact toolchain manager      | `compact 0.5.1` (active compiler `0.30.0`)         |
| Contract `language_version`    | `0.22`                                             |
| `@midnight-ntwrk/compact-runtime` | `^0.15.0` (latest published)                    |
| `@midnight-ntwrk/ledger-v8`    | `^8.0.3` (latest published; 8.1.0-rc.1 exists)     |
| `@midnight-ntwrk/midnight-js-*`| `^4.0.4` (latest published)                        |
| `@midnight-ntwrk/wallet-api`   | `^5.0.0`                                           |
| `@midnight-ntwrk/wallet-sdk-shielded` | `^3.0.0` (latest)                           |
| `@midnight-ntwrk/wallet-sdk-dust-wallet` | `^4.0.0` (latest)                        |
| `@midnight-ntwrk/wallet-sdk-unshielded-wallet` | `^3.0.0` (latest)                  |
| `@midnight-ntwrk/wallet-sdk-facade` | `^4.0.0` (latest)                             |
| `@midnight-ntwrk/wallet-sdk-hd` | `^3.0.2` (latest)                                 |
| `@midnight-ntwrk/wallet-sdk-address-format` | `^3.1.1` (latest)                     |
| `@midnight-ntwrk/zswap`        | `^4.0.0` (latest)                                  |
| `feeBlocksMargin`              | `100` (raised from default `5`; see Deploy-stage)  |
| Operator                       | _PENDING_                                          |
| Repo commit at run             | _PENDING_                                          |

## Compile-stage findings (2026/04/27)

Established before any test ran — by iterating on `compact compile`
until the contract built cleanly. Every bullet is backed by a specific
compiler error captured in this session's transcript.

- **`receiveShielded` exists in the Compact stdlib.** Signature:
  `receiveShielded(coin: ShieldedCoinInfo {nonce, color, value})` —
  note no `mt_index`, since the consumed note is created in this
  transaction and has no on-chain Merkle position yet.
- **`mintShieldedToken` is the atomic mint+send primitive.** There is
  no separate `sendImmediateShielded`; "atomic mint+send" is just
  `mintShieldedToken` with a non-self recipient. Signature:
  `mintShieldedToken(color: Bytes<32>, amount: Uint<64>, nonce: Bytes<32>, recipient: Either<ZswapCoinPublicKey, ContractAddress>)`.
- **Shielded amounts are `Uint<64>`.** Unshielded uses `Uint<128>`.
- **Per-note nonce is caller-supplied** for `mintShieldedToken`. Each
  call requires a `Bytes<32>` nonce that determines the resulting
  commitment uniqueness; reusing a nonce across mints with the same
  color/value would collide.
- **`sendShielded` requires `QualifiedShieldedCoinInfo`** — the
  "Qualified" variant adds `mt_index` to the basic `ShieldedCoinInfo`.
  This is what S3 trips over: with no SDK surface for contract-owned
  notes, the dApp cannot recover the held note's Merkle-tree index.
- **All 14 circuits compile** (S5 added the structurally-identical
  `send_held_shielded_manual`; S6 added `oz_deposit` and
  `oz_send_to_user`, the latter exercising
  `Map.insertCoin`, `Map.lookup`, `sendImmediateShielded`, and
  `mergeCoinImmediate` — all real Compact stdlib surfaces, verified
  by isolated compilation against the same `compact 0.30.0`
  toolchain). Largest is `send_held_shielded` (k=15, 19,636 rows);
  `send_held_shielded_manual` matches it. Other notable sizes:
  `mint_*_shielded` (k=14, ~10.7k rows), `receive_shielded` (k=13,
  6,602 rows). The k=15 circuit is at the upper bound for which
  `compact` ships precomputed public parameters.

## Deploy-stage findings (2026/04/27)

- **Initial deploy on `midnight-node:0.22.0` rejected** with
  `MalformedError::BalanceCheckOverspend` (Substrate `Custom(138)`)
  using `feeBlocksMargin: 5` — the default inherited from
  `experiments/redjubjub-wallet/`, whose largest circuit was k=11.
- **Resolved by raising `feeBlocksMargin` to `100`** (env-overridable
  via `FEE_BLOCKS_MARGIN`). Both contract instances then deployed
  cleanly on `midnight-node:0.22.5`.
- **Practical guidance for follow-on work:** custody-style contracts
  with a k≥14 circuit need substantially more fee headroom than the
  redjubjub-wallet experiment's defaults suggested. `5` was enough for
  k≤11; this contract with one k=15 circuit needs ~100. The exact
  relationship between `feeBlocksMargin` and circuit complexity is
  worth measuring if it becomes a frequent friction point.

## Per-test results

> Populated mechanically from `evidence/<id>-<name>.json` by
> `src/compose-findings.ts`. Do not hand-edit between the markers.

<!-- BEGIN-RESULTS-TABLE -->

| Test | Status  | Tx hash / error code | Note                                         |
| ---- | ------- | -------------------- | -------------------------------------------- |
| U1   | PASS    | 00b9cbc1...5be7c13   | receiveUnshielded landed on devnet.          |
| U2   | FAIL    | js-error             | Threw: Unexpected error submitting scoped tr |
| U3   | PASS    | 0079c163...7023da7   | sendUnshielded → UserAddress accepted (regre |
| U4   | FAIL    | js-error             | Threw: Unexpected error submitting scoped tr |
| S1   | PASS    | 00b5c14f...28e2480   | mintShieldedToken → kernel.self() landed.    |
| S2   | PASS    | 000996bc...71518dc   | sendImmediateShielded landed (atomic mint+se |
| S3   | FAIL    | no-mt-index-surface  | No contract-held-note lookup surface found i |
| S4   | PASS    | 00c70bf8...a4da773   | receive_shielded user → contract confirmed o |
| S5   | FAIL    | contract-runtime-error | Off-chain compact-runtime crashed during pro |
| S6   | PASS    | 00cdaf64...fc2d5b1   | OZ pattern works on Midnight v1 today: contr |
| D1   | FAIL    | 0099ad66...465ee31   | No public SDK surface for contract-paid Dust |
| D2   | FAIL    | 009d526e...22bb6ae   | No public SDK surface for contract paymaster |

<!-- END-RESULTS-TABLE -->

> Underlying error classifications behind the `js-error` /
> `contract-runtime-error` rows:
> - **U2, U4 hop-2:** `RpcError: 1010: Invalid Transaction: Custom error: 186` — node-side rejection. Tracked upstream as `midnight-ledger#233`.
> - **S3:** the runner gracefully reports `no-mt-index-surface` after probing every candidate API for contract-held coin enumeration; see `evidence/s3-cross-tx-custody.json` `details.probes` for the trace.
> - **S5:** with the manual witness reconstructed from indexer state (`mt_index = startIndex` of the deposit tx), `send_held_shielded_manual` fails inside off-chain proof construction (`ContractRuntimeError → TypeError: Cannot read properties of undefined (reading 'buffer')`). The transaction never reaches the node; full causeChain in `evidence/s5-manual-witness-shielded-spend.json`. Re-interpreted by S6 as a wrong-contract-pattern artefact: `sendShielded` requires the QSCI to come from `Map.lookup` against the contract's ledger map (where `insertCoin` bound it to the local Zswap state), not from a witness parameter.
> - **S6:** `oz_deposit` lands (deposit `00f582dd…f5fe6`), and a *cross-block* `oz_send_to_user` lands (spend `00cdaf64…fc2d5b1`). Contract-held shielded spending works on `midnight-node:0.22.5` today, via the OpenZeppelin `Map<color, QSCI>` + `insertCoin` pattern. Pattern lifted from [`OpenZeppelin/compact-contracts@add-multisig:.../ShieldedTreasury.compact`](https://github.com/OpenZeppelin/compact-contracts/blob/add-multisig/contracts/src/multisig/ShieldedTreasury.compact).

## Per-asset-type summary

### Unshielded (Night) — PARTIAL

User↔contract Night transfers work on `midnight-node:0.22.5` /
`midnight-js 4.0.4`:

- **U1 PASS** (tx `00e096b4...a8ca101`): `receiveUnshielded` lands.
  The historical error 168 is **not present** on this build.
- **U3 PASS** (tx `00d687c6...bf863e4`): `sendUnshielded` →
  `UserAddress` lands. Regression check confirmed.

Contract↔contract Night transfers do not on this stack — but the
reason is not a node bug:

- **U2 FAIL** with `1010: Invalid Transaction: Custom error: 186`.
  Direct contract→contract send rejected because no matching
  `receiveUnshielded` is paired into the same transaction.
- **U4 FAIL** at hop-2 with the same error and the same root cause.

We now know the protocol requires `sendUnshielded` and
`receiveUnshielded` to land together in a single transaction, by
design. Two SDK-side blockers prevent constructing that shape from a
dApp today:

- `midnight-js` has no public utility to combine calls from two
  different contracts into one transaction.
- The wallet's fee-balancing path has a pre-existing bug whose fix
  was proposed in
  [`midnight-wallet#293`](https://github.com/midnightntwrk/midnight-wallet/pull/293)
  but never merged.

Fix PRs for both are pending upstream. Until those land, the symptom
remains the same `1010: Custom error: 186` we observed; the upstream
symptom-tracker is `midnightntwrk/midnight-ledger#233`, and the
focused minimal reproducer is at `midnight-error-186-repro/`.

### Shielded (Zswap) — FEASIBLE end-to-end (S6 PASS)

Inbound paths and contract-issued tokens work end-to-end:

- **S1 PASS** (tx `00cdee17...d8052b4`): `mintShieldedToken` to
  `kernel.self()` lands. The contract holds the resulting shielded
  note (visible as a derived colour in subsequent wallet state views).
- **S2 PASS** (tx `006eebc7...623714f`): atomic mint+send shielded
  → user lands. Contract issues a new note directly to a user.
- **S4 PASS** (tx `0011af46...77e8d05`): `receive_shielded` user →
  contract lands. **The user can deposit shielded tokens into a
  contract.** Recipe:
  ```ts
  import { rawTokenType, encodeRawTokenType } from '@midnight-ntwrk/ledger-v8';
  const onChainColor = encodeRawTokenType(
    rawTokenType(contractScopedColor, contractAddress),
  );
  await contract.callTx.receive_shielded({ nonce, color: onChainColor, value });
  ```
  We now know why the off-chain derivation is needed: when a contract
  circuit calls `mintShieldedToken(X, …)`, the runtime implicitly
  applies `rawTokenType(X, kernel.self())`, so the resulting note's
  on-chain colour is the contract-scoped derivation of `X` — never
  `X` itself. Two different contracts that both mint with the same
  local `X` therefore produce *distinct* on-chain colours; the
  derivation is intentional, specifically to prevent two contracts
  from minting the same on-chain token type. The off-chain
  `receive_shielded` call must apply the same derivation so the
  `ShieldedCoinInfo.color` matches the on-chain note.

Outbound from contract-held notes does not — and the cause is *two*
gaps, one stacked on the other:

- **S3 FAIL** with `no-mt-index-surface`. After the contract minted to
  itself in hop 1 (tx landed cleanly under derived colour
  `5d314dca...`), hop 2 (`send_held_shielded`) needs a
  `QualifiedShieldedCoinInfo` carrying the contract-held note's
  `mt_index`. The runner probed:
    - `wallet.state.shielded.availableCoins` — user-owned notes only,
      none under the contract-derived colour (correct: user wallet
      doesn't sync contract-owned notes).
    - `contract.{shieldedCoins, getShieldedCoins, currentShieldedCoinState, queryShieldedNotes}` — none present.
    - `publicDataProvider.{queryContractShieldedNotes, getContractShieldedCoins, contractShieldedCoins, shieldedCoinsForContract}` — none present.

  The full probe trace is in `evidence/s3-cross-tx-custody.json`. So
  the *client-side discovery API* for contract-owned notes is
  missing.

- **S5 FAIL** with `contract-runtime-error` (`outcome: "gap2"`).
  S5 bypasses the missing client API: it captures the deposit's
  (nonce, color, value) at mint time and reads `mt_index` directly
  from the indexer's
  `transactions(offset:{identifier:depositTxId}).startIndex` field.
  For a `mint_shielded_to_self` transaction the contract emits
  exactly one shielded commitment — verified per-run by asserting
  `endIndex - startIndex === 1` — so its position in the Zswap
  commitment tree equals `startIndex`. With that manually-constructed
  `QualifiedShieldedCoinInfo`, the runner calls
  `send_held_shielded_manual(coin, recipient, amount)`. The off-chain
  compact-runtime crashes during proof construction:

  ```
  ContractRuntimeError: Error executing circuit 'send_held_shielded_manual'
    → TypeError: Cannot read properties of undefined (reading 'buffer')
  ```

  Full causeChain in `evidence/s5-manual-witness-shielded-spend.json`.
  The transaction never reaches the node.

**S6 then invalidates the apparent gap.** OpenZeppelin's
`add-multisig` branch on
[`compact-contracts`](https://github.com/OpenZeppelin/compact-contracts/blob/add-multisig/contracts/src/multisig/ShieldedTreasury.compact)
shows a contract-side pattern that bypasses both layers: store the
held coin in a ledger `Map<Bytes<32>, QualifiedShieldedCoinInfo>`,
register it via `Map.insertCoin` after `receiveShielded`, look it
up via `Map.lookup` before `sendShielded`, and re-deposit change
via `sendImmediateShielded` + another `insertCoin`. Ported into
our contract as `oz_deposit` / `oz_send_to_user`, the full
user→contract→user lifecycle lands across blocks:

- **S6 PASS** (deposit `00f582ddffc51368…f5fe6`, spend
  `00cdaf640bb97d72…fc2d5b1`): the contract holds shielded notes
  across blocks and spends them later. End-to-end on devnet,
  `midnight-node:0.22.5`. **No client-side `getContractShieldedCoins`
  API is needed** — the QSCI is read from contract ledger state, not
  the SDK.

What S5 actually demonstrated, in light of S6 and the
`/data-types/ledger-adt` docs, is that the manual-witness approach
is *structurally impossible*, not just discouraged. `mt_index` is
not a value a dApp can compute or supply: it's a Merkle tree
position the runtime allocates the moment a same-transaction
primitive (`receiveShielded`, `mintShieldedToken`) inserts the
coin commitment into the chain's tree. `Map.insertCoin` is the
only API that captures that allocation into a persistable
`QualifiedShieldedCoinInfo`. Feeding a hand-crafted QSCI into
`sendShielded` therefore can never work — there's no surface for
the runtime to bind the spend against. S5 isn't a runtime gap;
it's the wrong contract pattern, and the `data-types/ledger-adt`
page documents the right one.

A side note from this realisation: our `mint_shielded_to_self`
circuit (S1) does **not** call `insertCoin`, so the contract's
self-minted note isn't recoverable for a later cross-block spend
either — the same root cause as S5, just hidden behind a "PASS"
because S1 only verifies the mint lands. To make a self-mint
spendable later, the mint circuit would need to call
`oz_coins.insertCoin(color, ShieldedCoinInfo{nonce, color, value},
selfAsRecipient())` in the same transaction. Worth a follow-up
test if the Passport account model ever needs contract-to-self
shielded mints that are spent in later transactions.

No documentation gap on our side of the line: every primitive in
the recipe is on `docs.midnight.network`. Top-level circuits
(`sendShielded`, `sendImmediateShielded`, `receiveShielded`,
`mergeCoin`, `mergeCoinImmediate`, `mintShieldedToken`) at
[`/compact/standard-library/exports`](https://docs.midnight.network/compact/standard-library/exports);
the ledger ADT coin-aware methods (`Map.insertCoin`,
`Set.insertCoin`, `List.pushFrontCoin`) at
[`/compact/data-types/ledger-adt`](https://docs.midnight.network/compact/data-types/ledger-adt#insertcoin-1).
The doc page even spells out the runtime semantics:
*"Inserts a ShieldedCoinInfo into this Map at a given key, where
the ShieldedCoinInfo is transformed into a QualifiedShieldedCoinInfo
at runtime by looking up the relevant Merkle tree index."* This
experiment's earlier "missing API" framing was a research miss on
our side — we worked from the `standard-library/exports` page only
and never navigated to the data-types page where the ledger ADT
methods live. There is no upstream ask remaining for shielded
contract custody: the recipe is fully discoverable today.

### Dust — NOT FEASIBLE TODAY

- **D1 FAIL** with errorCode `no-paymaster-api`. The SDK does not
  expose a public surface for routing a transaction's fee branch
  through a contract-held Dust balance. The wallet always pays.
- **D2 FAIL** with errorCode `no-paymaster-tx-shape`. None of the
  speculative paymaster API names (`balanceWithSponsor`,
  `attachContractFeeBranch`, etc.) are present on the WalletFacade
  or contract handle.

The Compact contract did register a `bump_counter` tx successfully in
both D1 (`00b8a438...426c666`) and D2 (`00e51b2e...dce429a`) — i.e.
the user wallet *can* pay a contract-call fee, just not via a
contract-paid fee branch. Dust as a balance on a contract is not yet
addressable by this SDK version.

## Verdict

**Feasible for {U1, U3, S1, S2, S4, S6 — full shielded contract
custody lifecycle including cross-block contract-held spend};
not feasible today for {U2, U4 — blocked by two pending SDK fixes
(midnight-js multi-contract-call utility, wallet fee-balancing);
D1, D2 — no v1 surface}. S3 and S5 record FAILs but are
re-interpreted by S6 as wrong-contract-pattern artefacts, not
actual platform gaps.**

In words: contract custody on Midnight v1
(`midnight-node:0.22.5` + the latest published SDK family) supports
**user↔contract Night** in both directions, **contract self-mint
and atomic mint+send shielded**, **user→contract shielded
deposit** via the `rawTokenType` recipe, and — via OpenZeppelin's
`Map<color, QualifiedShieldedCoinInfo>` + `Map.insertCoin` pattern
— **cross-block contract-held shielded spend** end-to-end. It
does **not** support contract↔contract Night today (the protocol's
intentional pairing requirement is fine; the dApp-side path is
blocked by two pending SDK fixes), and **does not support
contract-paid Dust fees** in any form (no public API).

## Implications for the Passport account model

Feeds back into [`RESEARCH.md`](../../RESEARCH.md).

The principle-perfect contract-custody account model from
[`secure-onboarding-design.md` § 7](../../docs/reference/machine-investigation/key-flows/secure-onboarding-design.md#7-account-model)
is **substantially more viable on v1 than the previous run suggested**.
The experiment's clarified shape:

1. **Night user↔contract works in both directions.** A contract can
   act as a user's Night wallet today.
2. **Inter-contract Night routing works at the protocol level, but not
   yet from a dApp.** The protocol requires `sendUnshielded` and
   `receiveUnshielded` to be paired in a single transaction, by
   design. Two SDK-side gaps block constructing that shape from a
   dApp today: a missing `midnight-js` utility to combine calls from
   two different contracts into one transaction, and an unmerged
   wallet fee-balancing fix (`midnight-wallet#293`). Fix PRs for both
   are pending upstream. Once they land, this path should work
   without any protocol-level change. Workaround in the meantime:
   route through user→user transfers.
3. **Shielded deposit-side custody works today.** A contract can
   self-mint, atomically issue shielded tokens to a user, **and
   accept shielded notes from a user** via `receive_shielded` using
   the `rawTokenType` recipe. The end-to-end recipe is documented and
   verified at `experiments/midnight-receive-shielded-sdk-gap-repro/`.
4. **Shielded withdraw-side custody is feasible on v1 today via the
   OZ `Map<color, QSCI>` + `insertCoin` pattern.** S3 / S5 had the
   experiment looking for a missing API, but S6 demonstrates the
   complete cycle works without any new SDK surface: the contract
   stores each held coin in a ledger map; `Map.insertCoin`
   registers it after `receiveShielded` (the input is a
   `ShieldedCoinInfo` with no `mt_index`, the stored value is a
   `QualifiedShieldedCoinInfo` with `mt_index` lifted from the
   in-transaction Merkle allocation that `receiveShielded` just
   produced); and `sendShielded` against `Map.lookup(color)`
   succeeds at spend time. Change is re-deposited via
   `sendImmediateShielded` + another `insertCoin`, or `Map.remove`
   for full spends. Contract-as-vault designs are now in scope for
   the Passport account model. There is no upstream ask remaining
   for this primitive — every piece of the recipe is documented
   today: top-level circuits at `/compact/standard-library/exports`
   and the ledger ADT coin-aware methods (including
   `Map.insertCoin`) at `/compact/data-types/ledger-adt`. Our
   earlier framing of a "missing API" was a research miss; the path
   was discoverable from the docs all along.
5. **Dust paymaster does not exist.** The "user without Dust" version
   of the Passport onboarding flow — where the contract pays the user's
   Dust fee out of its own balance — is **not implementable on v1
   today**. The user must hold Dust to pay their own fees.

The concrete recommendation for the post-MVP multi-device milestone:

- **Treat Night and shielded-deposit custody as production-viable
  paths on v1.** A Passport contract can custody Night fully and
  receive Zswap; both deposit flows (Night and shielded) are verified
  end-to-end with on-chain transactions.
- **Shielded withdraw is feasible today, no upstream ask remaining.**
  Every primitive the recipe relies on is documented:
  [`/compact/standard-library/exports`](https://docs.midnight.network/compact/standard-library/exports)
  for the top-level circuits and
  [`/compact/data-types/ledger-adt`](https://docs.midnight.network/compact/data-types/ledger-adt#insertcoin-1)
  for `Map.insertCoin` / `Set.insertCoin` / `List.pushFrontCoin`.
  S6 confirms the OpenZeppelin
  [`ShieldedTreasury.compact`](https://github.com/OpenZeppelin/compact-contracts/blob/add-multisig/contracts/src/multisig/ShieldedTreasury.compact)
  pattern works end-to-end on `midnight-node:0.22.5` (deposit
  `00f582dd…f5fe6`, spend `00cdaf64…fc2d5b1`). The earlier framing
  in this report of a docs gap was a research mistake on our side.
- **Adopt the OZ `Map<color, QSCI>` + `insertCoin` pattern in any
  Passport contract that custodies shielded notes.** The Passport
  account-model contract should mirror OZ's
  `ShieldedTreasury.compact` shape: ledger
  `Map<Bytes<32>, QualifiedShieldedCoinInfo>` keyed by on-chain
  colour, deposit via `receiveShielded` + `Map.insertCoin`, spend
  via `Map.lookup` + `sendShielded`, change handling via
  `sendImmediateShielded` + `insertCoin`/`Map.remove`. No
  redesign-as-fallback is needed — the contract-vault design is
  back on the table.
- **Contract↔contract Night routing should be re-validated** on each
  new `midnight-js` and `midnight-wallet` release until the
  multi-contract-call utility and the wallet fee-balancing fix have
  shipped.
- **For Dust, commit to a cryptographic alternative for the fee path**
  in the post-MVP multi-device milestone (most likely user-side
  device-key signed Dust spends, possibly with a FROST t≥2 + PIN
  factor, decoupled from the asset-custody contract). The
  contract-paymaster vision does not have a path on v1 today.
