# Midnight Account Custody — Reference Implementation

The standardised account custody contract: the reference implementation of

- **MIP-0012 — Contract Custody of Midnight-Native Assets** (the asset
  surface: unshielded mirror, stateless shielded custody, encrypted inbox,
  the change rule, payment modes), and
- **MIP-0013 — Multi-key Account Authorisation for Custody Contracts** (the
  seam instantiation: in-circuit JubJub Schnorr, per-circuit challenge
  binding, device lifecycle, `auth_nonce` freshness),

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
| `unit-offline` | — (client halves of §5.2–5.3, §6.4) | — | AUTH-3 at the hash level; S10 non-vacuity |
| `auth-conformance` | — | 1, 2, 5 | AUTH-1, AUTH-2, AUTH-3, AUTH-8, INV-7 |
| `auth-lifecycle` | — | 6, 9 | AUTH-4, AUTH-5, AUTH-7 |
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

1. **MIP-0013 §3 device-map key type.** The text declares
   `devices: Map<Field, Uint<32>>` while defining the commitment as a
   `persistentHash` output (`Bytes<32>`). A `Bytes<32>` cannot be safely
   cast to `Field` (no grinding on that path; the range check fails for
   roughly half of all keys). This implementation keys the map by
   `Bytes<32>`.
2. **MIP-0013 §5.1 tag length.** Every per-circuit tag
   `midnight:account:auth:v1:<circuit-name>` exceeds 32 bytes, so the
   "zero-padded" arm of §5.1 is unreachable; this implementation uniformly
   hashes (DST = `persistentHash` of the tag zero-padded to 64 bytes). The
   spec should state one normative construction.
3. **MIP-0012 §6.3 direct-transfer return.** The contract-recipient
   circuit must return the **sent** coin as well as the change: the
   composing client needs its description (the deterministic nonce
   evolution) to build the payee's claim in the same transaction. The
   validated signature is `[ShieldedCoinInfo, Maybe<ShieldedCoinInfo>]`.
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
  `contractAction(address)` returns a single (latest) action; there is no
  surface enumerating a contract's transactions. Third-party-deposit
  discovery works end to end only with the depositor-known transaction
  id; the conformance suite records this as a PARTIAL verdict.
- **Multi-output position windows**: on a busy wallet, deposits and spends
  carry additional commitments (funding change), so single-output
  `mt_index` inference does not hold; clients must implement candidate
  retry (§6.5), which INV-5 makes safe. The client library and suites do.

## Client-library notes

- `UserAddress` circuit arguments are the bech32-decoded **address** bytes
  (the hash the ledger indexes UTXOs by), not the raw signing public key.
  Sending to public-key bytes strands tokens at an unowned address
  (`src/node/wallet.ts#userAddressBytes`).
- The signer needs only the contract's exported pure circuits (or an
  independent `persistentHash` implementation — see `signer-rs/`); proof
  generation consumes the signature and never the device key (AUTH-4).
- `signer-rs` depends on the ledger workspace clone at
  `../../tmp/midnight-ledger` for the field-aligned encoding crates.
