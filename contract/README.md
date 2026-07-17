# Midnight Account Custody — Reference Implementation

The standardised account custody contract: the reference implementation of

- **MIP-0012 — Contract Custody of Midnight-Native Assets** (the asset
  surface: unshielded mirror, stateless shielded custody, encrypted inbox,
  the change rule, payment modes), and
- **MIP-0013 — Multi-key Account Authorisation for Custody Contracts** (the
  seam instantiation: in-circuit JubJub Schnorr, rolling single-use device
  entries (AUTH-9), per-circuit challenge binding with witness-value
  pinning (AUTH-10), device lifecycle, `auth_nonce` freshness),

in one deployment, with the conformance suites both Testing sections
require. This directory is the standard to build against going forward;
the `experiments/` directories remain the historical evidence base.

## Layout

| Path | Content |
|---|---|
| `contracts/account.compact` | The standard contract (both MIPs, one deployment). |
| `contracts/control.compact` | Public-map control for the observer leak audit (test scaffolding, **not** part of the standard). |
| `contracts/faucet.compact` | Token origins on localnet (test scaffolding). |
| `src/wallet/` | Client library: signer, InboxEntry v1 codec, coin store witness, discovery walk, capture, account wrapper. |
| `src/tests/` | Conformance suites (see the map below). |
| `signer-rs/` | Independent Rust signer (conformance test 7): ledger crates only, no TypeScript/WASM/npm. |
| `infra/` | Localnet compose files (node, indexer, proof server). |

## Running

```sh
npm install
npm run compile                      # compact compile → contracts/managed/
(cd signer-rs && cargo build)        # the independent Rust signer
(cd infra && docker compose -f docker-compose.yml -f docker-compose.macos.yml up -d)

export WALLET_SEED=0000000000000000000000000000000000000000000000000000000000000001
export WALLET_SEED_SECONDARY=0000000000000000000000000000000000000000000000000000000000000002

npm run test:unit                    # offline: signer pipeline, codec, domain separation
npx tsx src/tests/crossimpl-offline.ts  # offline: Rust challenge bit-exactness
npm run test:auth                    # MIP-0013 tests 1, 2, 5
npm run test:auth-lifecycle          # MIP-0013 tests 6, 9
npm run test:auth-replay             # MIP-0013 tests 3, 4
npx tsx src/tests/auth-crossimpl.ts  # MIP-0013 test 7 (on node)
npm run test:custody-shielded        # MIP-0012 tests 1, 2, 3
npm run test:custody-discovery      # MIP-0012 test 4
npm run test:custody-unshielded      # MIP-0012 test 6
npm run test:custody-payments        # MIP-0012 tests 7, 8
npm run test:leak-audit              # MIP-0012 test 5
```

Each node suite writes a JSON evidence file under `evidence/`.

## Conformance map

| Suite | MIP-0012 Testing | MIP-0013 Testing | Invariants exercised |
|---|---|---|---|
| `unit-offline` | — (client halves of §5.2–5.3, §6.4) | — | AUTH-3, AUTH-9, AUTH-10 at the hash level; S10 non-vacuity |
| `auth-conformance` | — | 1, 2, 5, 10 | AUTH-1, AUTH-2, AUTH-3, AUTH-8, AUTH-9 (wrong-counter fault), INV-7, §3 bootstrap |
| `auth-lifecycle` | — | 6, 9 | AUTH-4, AUTH-5, AUTH-7, AUTH-9 (entry roll observed) |
| `auth-replay` | — | 3, 4 | AUTH-3 (address and circuit binding) |
| `auth-crossimpl` + `crossimpl-offline` | — | 7 | AUTH-4 (approval/proving separation) |
| `custody-shielded` | 1, 2, 3 | — | INV-1, INV-2, INV-3, INV-4, INV-5 |
| `custody-discovery` | 4 | — | INV-4, INV-5 |
| `leak-audit` | 5 | — | INV-2 (with positive control) |
| `custody-unshielded` | 6 | — | INV-8 |
| `custody-payments` | 7, 8 | — | INV-6 (one-hop); direct-transfer mode |

Not covered here, by design:

- **FROST threshold signature** (MIP-0013 test 8): committee-side; the
  ciphersuite specification is an acceptance criterion under Path to
  Active, and the contract is unchanged under the threshold profile.
- **Epoch bump / stale-epoch rejection** (parts of MIP-0013 tests 2 and
  6, AUTH-6): the only epoch-bump site is the §8 recovery seam, which
  awaits the recovery-paths MIP. The epoch state and per-entry epoch
  checks are implemented and exercised at epoch 0.

## Spec errata found while implementing

To be folded back into the MIP texts:

1. **MIP-0013 §5.1 DST derivation.** As first published, §5.1 derived
   the per-circuit DST as the tag "zero-padded or hashed to 32 bytes":
   the arm selection, the hash function, and the pre-hash encoding were
   all unspecified, so two conforming implementations could derive
   different challenges from the same tag. (Every current tag exceeds
   32 bytes, but a short circuit name such as `send` would make the
   ambiguity live.) This implementation derives unconditionally:
   DST = `persistentHash<[Bytes<64>]>` of the tag zero-padded to
   64 bytes, regardless of length. Proposed upstream as
   [midnight-improvement-proposals#249](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/249),
   which codifies exactly this construction.
2. **MIP-0013 §3 deploy-time entry is unimplementable.** The initial
   device entry binds `kernel.self()`, but `kernel.self()` evaluates to
   the zero address inside a constructor on the current toolchain, so the
   constructor cannot compute the address-bound entry (verified
   empirically: the deployed entry matched the zero-address derivation).
   This implementation bootstraps instead: the constructor stores a
   salted commitment `persistentHash([DST_BOOT, salt, pk])` and the
   permissionless `activate_initial_device(pk, salt)` circuit inserts the
   real entry at use counter 0 and burns the commitment. Deterministic in
   the committed key (no front-running); the fresh per-account salt keeps
   pre-activation state free of cross-account-stable device values. The
   deploy-time entry is unimplementable in principle, not merely on the
   current toolchain: the contract address is derived from the deploy
   transaction's content, so no deploy-time code can know it. Proposed
   upstream as
   [midnight-improvement-proposals#250](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/250),
   which makes this bootstrap normative and adds conformance test 10
   (exercised by the auth-conformance suite).
3. **MIP-0012 §6.3 direct-transfer return.** The contract-recipient
   circuit must return the **sent** coin as well as the change: the
   composing client needs its description (the deterministic nonce
   evolution) to build the payee's claim in the same transaction. The
   validated signature is `[ShieldedCoinInfo, Maybe<ShieldedCoinInfo>]`.
   Proposed upstream as
   [midnight-improvement-proposals#248](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/248).
4. **Observation, not erratum — the `as Field` cast as first rejector.**
   When a signature does not match the call (tampered argument, stale
   nonce, replay), the recomputed challenge differs from the ground one
   and the in-circuit `as Field` cast fails its range check for roughly
   half of such mismatches, aborting before the signature equation is
   evaluated. Both abort paths conform; error messages differ
   (`range error` vs `invalid signature`).

5. **Observation on MIP-0012 §5 unmirrored transfers.** The node refuses
   an unsolicited unshielded output addressed to a contract (invalid
   transaction, custom error 186) — the same claim-pairing rule shielded
   outputs have. On the current ledger, unmirrored unshielded holdings
   cannot arise by direct transfer at all, which is stronger than the
   lower-bound semantics §5 assumes; the clause remains correct for any
   future route the ledger may admit.

## Ecosystem dependencies observed

- **Indexer contract-transaction enumeration** (MIP-0012 Path to Active):
  the `contractAction(address, offset)` *query* returns a single action
  (the latest at or before the offset), but the
  `contractActions(address, offset)` *subscription* replays the complete
  per-address action history from any block height (verified against a
  deployed account: deploy through every call, in order, with entry
  points and transaction hashes). Path-to-Active discovery is therefore
  fully supported; a discovering wallet uses the subscription, not the
  point query (`enumerateContractActions` in the client library). The
  discovery suite exercises this end to end: the owner replays the
  history from the contract address alone, matches the depositing
  transaction by its identifiers (the wallet SDK's txId is a transaction
  identifier, not the hash), and takes candidate mt_index values from
  the enumerated transaction's own zswap window. The depositor-known
  txId remains only as a recorded fallback, which downgrades the verdict
  to PARTIAL.
- **Multi-output position windows**: on a busy wallet, deposits and spends
  carry additional commitments (funding change), so single-output
  `mt_index` inference does not hold; clients must implement candidate
  retry (§6.5), which INV-5 makes safe. The client library and suites do.
- **Wallet dust-state lag**: the wallet SDK builds fees from its own dust
  view, which lags the chain by a sync cycle; transactions built in quick
  succession are rejected at submission (`DustDoubleSpend`,
  `NotNormalized`). A rejected submission changes no state, so the client
  retries with the same authorisation (`submitWithDustRetry`). On an aged
  local chain the lag grows unboundedly; reset the localnet when suites
  start failing at submission. A stopped stack ages the same way: dust
  decays against wall-clock time, and on resume the node rejects the
  wallet's transactions with `Malformed(BalanceCheckOverspend)` (custom
  error 138) — same remedy, reset the chain.
- **Zero-effect calls can hang the wallet SDK**: a circuit call that
  changes no public state has been observed to never resolve its
  finalisation watch. Avoid on-chain calls for pure derivations; compute
  them client-side (`rawTokenType` for token colors).

## Client-library notes

- Clients maintain a device roster (public key → use counter) per
  MIP-0013 S11: the rolling entry consumed by each call is
  `persistentHash([DST_DEVICE, self, pk, epoch, use_counter])`, and an
  unknown or stale counter is recovered by probing ledger membership of
  candidate entries (`CustodyAccount.resolveUseCounter`).
- For witness-consuming circuits the approver signs over the exact
  qualified coin the spend will consume (AUTH-10); the client pipeline
  hands the witness values to the signer, and a candidate `mt_index`
  retry therefore re-signs per candidate.

- `UserAddress` circuit arguments are the bech32-decoded **address** bytes
  (the hash the ledger indexes UTXOs by), not the raw signing public key.
  Sending to public-key bytes strands tokens at an unowned address
  (`src/node/wallet.ts#userAddressBytes`).
- The signer needs only the contract's exported pure circuits (or an
  independent `persistentHash` implementation — see `signer-rs/`); proof
  generation consumes the signature and never the device key (AUTH-4).
- `signer-rs` uses the published ledger crates (`midnight-base-crypto`,
  `midnight-transient-crypto`, `midnight-curves`) for the field-aligned
  encoding and curve arithmetic; it is self-contained and builds with a
  plain `cargo build`.
