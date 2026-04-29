# Contract Custody Feasibility — Findings

> **Status: executed 2026/04/28, S5 added 2026/04/29, against devnet
> `midnight-node:0.22.5` / the latest published `@midnight-ntwrk/*`
> family.** Five tests PASS with on-chain tx hashes; six FAIL — two
> with the same SDK-side multi-contract-call bug, two with missing
> Dust paymaster APIs, and two (S3 client-discovery / S5 SDK-runtime)
> that together demarcate contract-held shielded spending as blocked
> at *two* layers, not one. Verdict and Passport-account-model
> implications below.

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

3. **Contract-held shielded *spending* is blocked at two layers, not
   one — a client discovery gap *and* an SDK / runtime gap.** S3
   documented the first half: no public `midnight-js 4.0.4` surface
   enumerates contract-owned shielded notes (the user wallet's
   `availableCoins` correctly excludes them; no analogous
   provider-side or wallet-side API exists; the S3 runner's probe
   trace is in `evidence/s3-cross-tx-custody.json`). S5 then asks the
   follow-on: *if* a client could supply a correctly-formed
   `QualifiedShieldedCoinInfo`, would the runtime accept the spend?
   It does not. With (nonce, color, value) recorded at deposit time
   and `mt_index` recovered manually from the indexer
   (`transactions(offset:{identifier}).startIndex`), the off-chain
   compact-runtime crashes during proof construction with
   `ContractRuntimeError → TypeError: Cannot read properties of
   undefined (reading 'buffer')` (full causeChain in
   `evidence/s5-manual-witness-shielded-spend.json`). The transaction
   never reaches the node. The proposed
   `getContractShieldedCoins(address) → QualifiedShieldedCoinInfo[]`
   client surface would be necessary but **not sufficient**: the
   `compact-runtime ^0.15.0` / `midnight-js 4.0.4` proof-builder
   itself has no working contract-as-shielded-spender code path.
   This is the wall OpenZeppelin's archived `ShieldedToken.compact`
   flagged as a future-work item ("*Enable the Shielded contract
   itself to transfer*"), now confirmed empirically against
   `midnight-node:0.22.5`.

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
- **All 12 circuits compile** (S5 added a structurally-identical
  sister of `send_held_shielded` named `send_held_shielded_manual`,
  to keep the S3 evidence intact while exercising the manual-witness
  spend path). Largest is `send_held_shielded` (k=15, 19,636 rows);
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
| S1   | PASS    | 0032207d...3ed25e6   | mintShieldedToken → kernel.self() landed.    |
| S2   | PASS    | 00a620c6...78b0f21   | sendImmediateShielded landed (atomic mint+se |
| S3   | FAIL    | no-mt-index-surface  | No contract-held-note lookup surface found i |
| S4   | PASS    | 00315481...7bed570   | receive_shielded user → contract confirmed o |
| S5   | FAIL    | contract-runtime-error | Off-chain compact-runtime crashed during pro |
| D1   | FAIL    | 0099ad66...465ee31   | No public SDK surface for contract-paid Dust |
| D2   | FAIL    | 009d526e...22bb6ae   | No public SDK surface for contract paymaster |

<!-- END-RESULTS-TABLE -->

> Underlying error classifications behind the `js-error` /
> `contract-runtime-error` rows:
> - **U2, U4 hop-2:** `RpcError: 1010: Invalid Transaction: Custom error: 186` — node-side rejection. Tracked upstream as `midnight-ledger#233`.
> - **S3:** the runner gracefully reports `no-mt-index-surface` after probing every candidate API for contract-held coin enumeration; see `evidence/s3-cross-tx-custody.json` `details.probes` for the trace.
> - **S5:** with the manual witness reconstructed from indexer state (`mt_index = startIndex` of the deposit tx), `send_held_shielded_manual` fails inside off-chain proof construction (`ContractRuntimeError → TypeError: Cannot read properties of undefined (reading 'buffer')`). The transaction never reaches the node; full causeChain in `evidence/s5-manual-witness-shielded-spend.json`. Disambiguates the S3 finding: the upstream ask is *two* layers (client discovery API + runtime / proof-builder support), not one.

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

### Shielded (Zswap) — PARTIAL (deposit-side fully feasible)

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

The narrow restatement of the gap: **the proposed
`getContractShieldedCoins(address) → QualifiedShieldedCoinInfo[]`
client surface alone does not unblock contract-held shielded
spending.** The off-chain `compact-runtime ^0.15.0` /
`midnight-js 4.0.4` proof-builder also has no working
contract-as-shielded-spender path on `midnight-node:0.22.5`. The
upstream ask is therefore two-layered: client discovery API *and*
runtime / proof-builder support for contract-spend of shielded
notes (the same future-work item OZ flagged in their archived
`ShieldedToken.compact`).

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

**Feasible for {U1, U3, S1, S2, S4}; not feasible today for {S3, S5 —
contract-held shielded spending blocked at *both* the client-side
discovery and the SDK / runtime proof-builder layers}; not feasible
today for {U2, U4 — blocked by two pending SDK fixes (midnight-js
multi-contract-call utility, wallet fee-balancing); D1, D2 — no v1
surface}.**

In words: contract custody on Midnight v1
(`midnight-node:0.22.5` + the latest published SDK family) supports
**user↔contract Night** in both directions, **contract self-mint and
atomic mint+send shielded**, and **user→contract shielded deposit**
via the `rawTokenType` recipe. It does **not** support
contract↔contract Night today (the protocol's intentional pairing
requirement is fine; the dApp-side path is blocked by two pending
SDK fixes), **does not support `sendShielded` from contract-held
notes** (S3 confirmed the client API is missing; S5 confirmed that
even with a manually-reconstructed witness, the off-chain
compact-runtime crashes during proof construction — both layers need
upstream work), and **does not support contract-paid Dust fees** in
any form (no public API).

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
4. **Shielded withdraw-side custody is blocked at two layers, not
   one.** S3 documents that no SDK surface enumerates contract-owned
   notes (the client-discovery layer). S5 then disambiguates: even
   with the `QualifiedShieldedCoinInfo` reconstructed manually from
   indexer data — bypassing the missing client API entirely — the
   off-chain `compact-runtime` proof-builder crashes inside circuit
   execution (`ContractRuntimeError → TypeError: Cannot read
   properties of undefined (reading 'buffer')`). The transaction
   never reaches the node. So the upstream ask is **not** "one new
   public function" — it is **two coordinated changes**: a client
   surface returning a contract's `QualifiedShieldedCoinInfo[]` *and*
   contract-as-shielded-spender support inside the proof-builder /
   compact-runtime. This blocks designs where the contract acts as a
   vault that users can withdraw from. The workaround for some token
   classes is contract-issued tokens that the contract can re-mint
   (S2 pattern). For shielded NIGHT or any other protocol-issued
   token, the gap stands until both layers ship upstream.
5. **Dust paymaster does not exist.** The "user without Dust" version
   of the Passport onboarding flow — where the contract pays the user's
   Dust fee out of its own balance — is **not implementable on v1
   today**. The user must hold Dust to pay their own fees.

The concrete recommendation for the post-MVP multi-device milestone:

- **Treat Night and shielded-deposit custody as production-viable
  paths on v1.** A Passport contract can custody Night fully and
  receive Zswap; both deposit flows (Night and shielded) are verified
  end-to-end with on-chain transactions.
- **Shielded withdraw is a *two-layer* upstream ask.** Filing with
  the Midnight Foundation: (a) *"please add
  `getContractShieldedCoins(address) → QualifiedShieldedCoinInfo[]`
  on `publicDataProvider` (or equivalent on the wallet facade)."*
  AND (b) *"please add a working contract-as-shielded-spender code
  path in `compact-runtime` / `midnight-js` so that
  `sendShielded(coin, recipient, amount)` from a contract circuit
  succeeds when the off-chain caller passes a correctly-formed
  `QualifiedShieldedCoinInfo` for a contract-owned note."* S5
  empirically demonstrated that the protocol primitive cannot be
  reached via the dApp path on `midnight-node:0.22.5` — the
  proof-builder crashes before tx submission. (a) alone is not
  sufficient.
- **Plan for the shielded-withdraw decision two ways.** Either (a)
  wait for both upstream layers and keep the contract-vault design,
  or (b) redesign the Zswap path so tokens stay user-side and the
  contract only authorises actions. (a) is preferable if the
  timeline allows; (b) is the fallback that doesn't require any
  upstream change. Given S5 expanded the upstream ask from one new
  function to two coordinated layers, (b) becomes more attractive
  than the previous run suggested.
- **Contract↔contract Night routing should be re-validated** on each
  new `midnight-js` and `midnight-wallet` release until the
  multi-contract-call utility and the wallet fee-balancing fix have
  shipped.
- **For Dust, commit to a cryptographic alternative for the fee path**
  in the post-MVP multi-device milestone (most likely user-side
  device-key signed Dust spends, possibly with a FROST t≥2 + PIN
  factor, decoupled from the asset-custody contract). The
  contract-paymaster vision does not have a path on v1 today.
