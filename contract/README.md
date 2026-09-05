# Midnight Account Custody — Reference Implementation

The standardised account custody contract: the reference implementation of

- **MIP-0012 — Contract Custody of Midnight-Native Assets** (the asset
  surface: unshielded mirror, stateless shielded custody, encrypted inbox,
  the change rule, payment modes), and
- **MIP-0013 — Multi-key Account Authorisation for Custody Contracts** (the
  seam instantiations: rolling single-use device entries (AUTH-9),
  per-circuit challenge binding with witness-value pinning (AUTH-10),
  device lifecycle, `auth_nonce` freshness),

in one deployment, with the conformance suites both Testing sections
require. This directory is the standard to build against going forward;
the `experiments/` directories remain the historical evidence base.

## Co-resident authorisation arms

The MIP-0012 §4 seam is credential-scheme-agnostic, and this contract
carries it as **co-resident arms**: every gated operation is exported
once per registered scheme, as `<operation>_with_<arm>`. Each arm's
entry circuit computes its own challenge, passes its own internal seam
chip (device-entry roll + in-circuit verification), and calls the same
internal custody chip — the MIP-0012 custody semantics exist exactly
once, below every arm.

- **Arm `jubjub`** — Schnorr over JubJub, the **normative MIP-0013
  scheme**, unchanged in substance from the trunk: §5.1 challenge
  preimage with signature announcement and grinding nonce, DST families
  `midnight:account:{device,boot}:v1` and `midnight:account:auth:v1:*`.
  Gated ABIs are `(…args, pk, use_counter, sig_r, sig_s, grind_nonce)`.
- **Arm `k256`** — in-circuit **ECDSA over secp256k1**
  (`secp256k1EcdsaVerify`, ZKIR v3), an **interim engineering arm**, not
  a scheme proposal: MIP-0013 R2 rejects secp256k1 ECDSA for account
  authorisation. It stands in for the intended **secp256r1 (P-256)
  passkey arm** until that curve has a Compact language surface; the two
  curves share the short-Weierstrass ECDSA shape, so the k1 → r1 swap is
  a type and constant substitution (built-in names, `:k1:` → `:r1:` DST
  markers). Its challenges carry no signature announcement (an ECDSA
  message must not depend on its own signature) and no grinding nonce
  (the verify reduces the digest mod n natively); keys bind as
  little-endian affine coordinate bytes; both S forms are accepted (real
  P-256 authenticators emit high-S; single-use entries make a malleated
  twin non-replayable). Gated ABIs are
  `(…args, pk, use_counter, sig, connector)`.
  Its signer is software only (`@noble/curves` in TypeScript, `k256` in
  Rust): WebAuthn passkeys are hardware-locked to P-256, which is
  precisely what the r1 landing enables.

  The arm carries one per-device **connector mode**: a device enrolled
  with `connector = true` is a key held behind the dApp-connector
  `signData` surface (the connector specification's
  `ecdsa_secp256k1_sha256` scheme — MPC and HSM signers, and wallets
  exposing ECDSA). Its signatures cover the mandatory envelope digest
  `SHA-256("midnight_signed_message:32:" || challenge)` — recomputable
  in-circuit because `persistentHash` IS SHA-256 and a tuple of `Bytes`
  hashes as the raw concatenation (exported as
  `connector_envelope_digest`) — instead of the challenge itself. The
  mode is bound into the device's entry derivation (DST families
  `midnight:account:device:k1c:v1`, `midnight:account:boot:k1c:v1`), so
  a key enrolled for one mode can never authorise under the other;
  raw-mode entries keep the `k1:v1` family unchanged. The mode is a
  digest convention inside the arm, not a scheme, which is why it is a
  flag rather than a third set of exports.

Per-arm circuits instead of one circuit with an in-circuit scheme
conditional: Compact compiles every exported circuit to its own proof, so
a proof through a `_with_jubjub` circuit pays only the Schnorr
constraints and a `_with_k256` proof only the ECDSA constraints (the
withdraw prover keys measure 49 MB and 117 MB respectively — the split
keeps the ECDSA premium off the normative arm). Later arms
(`_with_p256`, possibly `_with_ed25519`) are added the same way: one
seam chip, one challenge family, one thin export per operation; the
custody chips do not change.

The arms share one device set (arm-marked entry DSTs keep them
disjoint), one `device_count`, and one last-device rule. **Cross-arm
enrolment is first-class**: `add_device_with_<arm>` binds the NEW device
as its derived ENTRY (computed client-side with the new device's arm's
exported derivation circuit), so a JubJub device enrols a k256 device
and vice versa — the migration path between arms.

The contract cannot inspect an entry argument's preimage, and two seam
rules follow from that (both exercised on-node by `auth-coinless`):

- **AUTH-5 rests on the caller, not the count.** Since entries arrive
  already derived, `device_count` counts entries rather than demonstrably
  usable keys, so it cannot by itself guarantee that a removal leaves a
  usable device behind. `do_remove_device` therefore refuses to remove the
  entry the caller authorised with: every removal is authorised by a device
  that has just proved itself and that survives, so a usable device always
  remains. The count check is kept as a redundant floor. **S13.**
- **Both seams refuse weak device keys.** Each arm's verification collapses
  at the curve identity, so an identity "key" authorises with no secret at
  all. On k256 the verify computes `P = u1·G + u2·pk` and tests `x(P) == r`,
  so `pk = O` erases the key-dependent term and any `s` yields a passing
  `r = x((z·s⁻¹)·G)`. On JubJub the seam asserts `s·G == R + c·pk`, so
  `pk = O` reduces it to `s·G == R`, which anyone satisfies by choosing `s`
  and setting `R = s·G` — the challenge never enters. Neither identity is
  marked by its type: k256's carries an `identity` flag whose coordinates
  are conventionally zero, and JubJub's is the ordinary affine point
  `(0, 1)`. Both places that admit a key on each arm — the seam and the
  bootstrap — reject them: k256 by `pk != default<Secp256k1Point>`, JubJub
  by cofactor clearing (`[8]pk != O`, which also rules out the rest of the
  8-torsion). The k256 rejection is also why that arm's entry derivation
  binds only the affine coordinates: every admissible point is uniquely
  determined by them. **Anyone lifting either derivation must carry the
  rejection with it.** **S12.**

Clients MUST still derive enrolment entries at the current `device_epoch`
and use counter 0. A wrong-address or **past**-epoch entry is dead weight; one
at the current epoch but a non-zero counter is live at that counter; and one
at a **future** epoch is dormant rather than dead, going live when the epoch
advances. That last case constrains the recovery seam that will own the only
epoch bump: it MUST clear the device set as part of the bump, because
otherwise a device can pre-plant an entry that survives its own revocation
(erratum 7). All of them count toward `device_count` until removed, and none
can strand the account.

Read that rule as an honest-client obligation only. It is **not** a security
boundary, and the standard currently has no way to make it one: a device that
enrols a second entry for its own key holds two live entries, and a removal
retires one element, so the device survives its own revocation. This is
measured, it is live on both arms, and deriving the entry in-circuit does not
prevent it. See erratum 8, which is the substantive open defect in this
implementation and in MIP-0013 §3 and §6.

Toolchain: the k256 arm requires the ZKIR v3 pre-release stack, so the
whole contract compiles with it. The one coherent all-published set
today — the set this package pins — is compactc 0.33.0-rc.2 (generates
for compact-runtime 0.18.0-rc.1), compact-js 2.5.5-rc.6, and midnight-js
5.0.0-beta.4, on the node 2.1.0 / ledger 9.1 localnet images with fresh
volumes (see `infra/docker-compose.yml`). midnight-js 5.0.0-beta.6
requires an unpublished compact-js interface (per-call Zswap local
state), and the newer compactc 0.34.0-rc.0 / compact-runtime 0.19.0-rc.0
line has no published midnight-js consumer; mixing the lines fails at
deploy or call time on runtime-instance checks. The full experiment
behind this verdict (`experiments/secp256k1-in-compact/`) is not yet on
the main branch; until it lands, the summary above is the citable form.

## Layout

| Path | Content |
|---|---|
| `contracts/account.compact` | The standard contract (both MIPs, one deployment). |
| `contracts/control.compact` | Public-map control for the observer leak audit (test scaffolding, **not** part of the standard). |
| `contracts/faucet.compact` | Token origins on localnet (test scaffolding). |
| `src/wallet/` | Client library: two-arm signers, InboxEntry v1 codec, coin store witness, discovery walk, capture, account wrapper, wave deployment. |
| `src/tests/` | Conformance suites (see the map below). |
| `signer-rs/` | Independent Rust signer (conformance test 7): ledger crates only, no TypeScript/WASM/npm. |
| `infra/` | Localnet compose files (node, indexer, proof server). |

## Running

The compile script pins the RC toolchain (`compact compile +0.33.0-rc.2
--feature-zkir-v3`); install it once by unzipping the release asset from
LFDT-Minokawa/compact into
`~/.compact/versions/0.33.0-rc.2/aarch64-darwin/` (the `compact update`
manager only sees the stable line).

```sh
npm install
npm run compile                      # compact compile → contracts/managed/
(cd signer-rs && cargo build)        # the independent Rust signer
(cd infra && docker compose -f docker-compose.yml -f docker-compose.macos.yml up -d)

export WALLET_SEED=0000000000000000000000000000000000000000000000000000000000000001
export WALLET_SEED_SECONDARY=0000000000000000000000000000000000000000000000000000000000000002

# Offline (no localnet needed; both suites run BOTH arms)
npm run test:unit                    # signer pipelines, codec, domain separation
npx tsx src/tests/crossimpl-offline.ts  # Rust challenge bit-exactness per arm

# On-node, running on the v9 localnet (shielded flows and coinless calls)
npm run test:auth-coinless           # BOTH seams on-node + cross-arm enrolment + tamper aborts
npm run test:custody-shielded        # MIP-0012 tests 1, 2, 3
npm run test:custody-discovery      # MIP-0012 test 4
npm run test:custody-payments        # MIP-0012 tests 7, 8
npm run test:leak-audit              # MIP-0012 test 5

# On-node, currently BLOCKED by the localnet fee limit (see below):
# every flow that carries an unshielded offer in a contract call.
npm run test:auth                    # MIP-0013 tests 1, 2, 5 (funds via deposit_unshielded)
npm run test:auth-lifecycle          # MIP-0013 tests 6, 9
npm run test:auth-replay             # MIP-0013 tests 3, 4
npx tsx src/tests/auth-crossimpl.ts  # MIP-0013 test 7 (signs withdraw_unshielded)
npm run test:custody-unshielded      # MIP-0012 test 6
```

Each node suite writes a JSON evidence file under `evidence/`.

## Known ledger-9 limitation: the full deploy exceeds per-block limits

A deploy carrying all 18 verifier keys prices at bytes_written 53,076
against the ledger-9 rc parameters' per-block budget of 50,000, and at
compute_time 2.011 s against 2.000 s — it can never fit a block, and the
fee computation refuses it up front (`exceeded block limit in transaction
fee computation`, thrown client-side by `feesWithMargin` before
submission). This is a parameter-tuning finding to raise upstream, not a
localnet artefact: the limits come from the chain's ledger parameters
(readable via the indexer's `{ block { ledgerParameters } }`), so any
network on these parameters refuses the same deploy, and any contract
with roughly 17 or more typical entry points is undeployable in one
transaction.

The reference client therefore deploys in waves
(`src/wallet/wave-deploy.ts`): wave 1 carries the deposits and the
initial device's arm (10 operations, ~34 KB written — a functional
single-arm account); wave 2 adds the other arm's 8 verifier keys in one
batched `MaintenanceUpdate`, hand-built against the ledger API and signed
with the maintenance authority key the deploy stored locally.

Not through midnight-js's published circuit maintenance interface, for two
reasons. It cannot produce a current key: compact-js 2.5.5-rc.6 hardcodes
`ContractOperationVersion 'v3'`, whose raw keys carry the
`midnight:verifier-key[v6]:` header, while compactc 0.33.0-rc.2 emits
v7-headed keys (tag `'v4'`), so `insertVerifierKey` throws before a
transaction exists. And it is per-circuit, so it would cost 8 transactions
where the ledger API takes all 8 inserts in one. **This is the third
upstream finding on this branch** (recorded under "Ecosystem dependencies
observed"), alongside the block limit above and the fee-model rejection
below.

Wave 2 also demonstrates the arm-migration mechanism: adding an arm's
circuits to a LIVE account by maintenance update is how a secp256r1 arm
would reach accounts deployed before it exists. That mechanism carries a
custody cost the reference refuses to pay silently, so wave 2 ends by
retiring the authority — see below.

### The maintenance authority sits above the seam, so wave 2 retires it

Deploying a contract mints a contract maintenance authority and stores its
signing key locally. This is inherited from the standard deploy path
(midnight-js's `deployContract` does the same), not introduced here, but the
co-resident design makes it load-bearing and therefore worth stating
plainly: **a `VerifierKeyInsert` replaces an operation's verifier key, and a
`ContractOperation` carries nothing else**, so whoever holds that key can
substitute their own relation for `withdraw_shielded_with_k256` and release
the account's assets with no device signature and no `auth_nonce` advance.
That is a path around the seam this contract calls the gate on every
asset-releasing circuit, and a single key holding it contradicts the 1-of-n
device model MIP-0013 specifies.

This is measured, not argued. `auth-coinless` (S14) builds the update that
removes the verifier key of `withdraw_shielded_with_k256` and inserts the
permissionless `deposit_unshielded` key in its place, at the authority
counter read from chain. Against an account deployed with
`retireAuthority: false` that update returns `SucceedEntirely`: the gate on
a shielded withdrawal is replaced by a relation that verifies no signature
at all, with no device key involved. Replacement needs the remove and the
insert in one update; a bare insert over an existing key is refused.

Wave 2 is the last operation that needs the authority, so the same update
retires it: the batch ends with a `ReplaceAuthority` installing an empty
committee at threshold 1, which no signature set can satisfy. The identical
swap then fails against a default-deployed account, whose on-chain state
shows `committee = 0, threshold = 1`. After deploy, the seam is the only way
to move the account's assets.

The cost is explicit and is the trade-off a deployer must make: a retired
account can never receive a future arm's circuits, so the secp256r1 arm
reaches it only by migrating to a new account. `retireAuthority: false`
keeps that door open for a deployer who has weighed the custody risk.

## Known localnet limitation: small coin-carrying calls are mempool-rejected

The v9 node's genesis parameters cap a transaction's dismissal cost at
`max(2 us x size_bytes, 15 ms)`. A contract call paired with an
**unshielded** offer prices at 16.313 ms against a 16.26 ms budget for its
~8.1 KB size, so the node rejects it
(`Malformed(FeeCalculation(OutsideTimeToDismiss))`): a 0.3 % miss,
invariant under TTL, identical on node 2.1.0 and 2.0.0-rc.4. Proof-only
calls pass (the coinless suite), plain wallet transfers pass, and shielded
flows pass (zswap proofs make the transaction large enough to buy budget);
the failing class is exactly call + unshielded offer in one small
transaction. Since `deposit_unshielded` is how the funded suites seed the
account, they are blocked end-to-end. The limitation is independent of the
signature scheme (the JubJub trunk's transactions have the same shape); it
is a toolchain-tuning issue to raise upstream, not an arm defect. The
wallet SDK cannot predict the rejection: it prices fees against hard-coded
default parameters with enforcement off, while the chain's actual
parameters arrive per block from the indexer (`{ block { ledgerParameters } }`).

Two client-side consequences are already handled in `src/node/wallet.ts`:
the balancing TTL defaults to 60 s (`TX_TTL_MS` to override) because
longer windows push even deploy transactions over the limit, and an intent
TTL within ~10 s of build time is rejected as
`Malformed(TransactionApplication(IntentTtlExpired))`.

## Conformance map

| Suite | MIP-0012 Testing | MIP-0013 Testing | Invariants exercised |
|---|---|---|---|
| `unit-offline` | — (client halves of §5.2–5.3, §6.4) | — | AUTH-3, AUTH-9, AUTH-10 at the hash level; S10 non-vacuity — **both arms** |
| `auth-coinless` | — | coinless halves of 1, 2(a), 6, 10 | AUTH-1, AUTH-2, AUTH-5 (via S13), AUTH-9 (entry roll under a second key), S12, S13, §3 bootstrap, wave deploy — **both seams on-node, cross-arm enrolment in both directions, per-arm tamper aborts, both seam guards through their real attacks** |
| `auth-conformance` | — | 1, 2, 5, 10 | AUTH-1, AUTH-2, AUTH-3, AUTH-8, AUTH-9 (wrong-counter fault), INV-7, §3 bootstrap |
| `auth-lifecycle` | — | 6, 9 | AUTH-4, AUTH-5, AUTH-7, AUTH-9 (entry roll observed) |
| `auth-replay` | — | 3, 4 | AUTH-3 (address and circuit binding) |
| `auth-crossimpl` + `crossimpl-offline` | — | 7 | AUTH-4 (approval/proving separation) |
| `custody-shielded` | 1, 2, 3 | — | INV-1, INV-2, INV-3, INV-4, INV-5 |
| `custody-discovery` | 4 | — | INV-4, INV-5 |
| `leak-audit` | 5 | — | INV-2 (with positive control) |
| `custody-unshielded` | 6 | — | INV-8 |
| `custody-payments` | 7, 8 | — | INV-6 (one-hop); direct-transfer mode |

Arm coverage: `unit-offline`, `crossimpl-offline`, and `auth-coinless`
exercise BOTH arms; the remaining on-node suites drive the k256 arm (the
account they set up is k256-born), with the custody suites scheme-agnostic
below the seam by construction. The jubjub arm's full funded conformance
matrix predates the co-residency restructure on the trunk's history; its
seam is re-proven on-node by `auth-coinless`.

Not covered here, by design:

- **FROST threshold signature** (MIP-0013 test 8): committee-side; the
  ciphersuite specification is an acceptance criterion under Path to
  Active, and the contract is unchanged under the threshold profile.
- **Epoch bump / stale-epoch rejection** (parts of MIP-0013 tests 2 and
  6, AUTH-6): the only epoch-bump site is the §8 recovery seam, which
  awaits the recovery-paths MIP. The epoch state and per-entry epoch
  checks are implemented and exercised at epoch 0.
- **Complete revocation** (MIP-0013 §6): removal retires one set element,
  and a device that enrolled a second entry for its own key survives it.
  That is a defect in the standard's device-set shape rather than a gap in
  the suites, so there is no conformance test to pass;
  `src/tests/probe-revocation.ts` (`npm run probe:revocation`) demonstrates
  it on-node against both enrolment shapes. See erratum 8. The probe is
  deliberately outside the suite list: it reports a verdict rather than
  gating, and it will be inverted into a conformance test once §3 gains a
  contract-maintained device identity.

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
6. **MIP-0013 §4 does not require the seam to reject weak device keys.**
   The seam is specified as a signature verification against the device's
   public key, with no admissibility condition on that key. Both schemes
   degenerate at their curve identity: ECDSA's verification equation loses
   its key-dependent term entirely, and Schnorr's reduces to `s·G == R`, so
   an identity "key" authorises with no secret. Neither identity is
   excluded by its type — secp256k1's is a flagged `Secp256k1Point` and
   JubJub's is the ordinary affine point `(0, 1)` — and MIP-0013's entry
   construction commits to the key without constraining it, so an entry for
   an identity key is well-formed. Verified against the runtime's own curve
   arithmetic on both curves, and exercised on-node by `auth-coinless`
   (S12): with the entry planted, a forged signature is accepted by the
   bare verification equation and refused only by the added guard. **§4
   should require that an implementation reject keys of small order on
   every arm** (for a cofactor-8 curve such as JubJub, `[8]pk != O`; for a
   prime-order curve such as secp256k1, `pk != O`). Note that this is a
   defect in the specification, not only in an implementation of it: the
   MIP as written admits a conforming implementation with this hole.
7. **MIP-0013 AUTH-6 epoch revocation is defeatable by pre-planting.** AUTH-6
   revokes a device set by advancing `device_epoch`, so that every entry bound
   to the old epoch stops matching — revocation without enumerating the set.
   That reasoning only covers entries derived at *past* epochs. Where devices
   are enrolled as an already-derived entry (MIP-0013 §6, which the cross-arm
   case forces), nothing binds the epoch at enrolment, so any authorised
   device can enrol an entry derived at `device_epoch + 1`. It matches nothing
   until the bump and authorises immediately after it, which means a
   compromised device survives the very revocation intended to evict it. **§8
   should require that an epoch bump clear the device set**, or that entries
   be stored stamped with the epoch the contract observed at enrolment rather
   than one carried in a preimage it cannot inspect. Latent here (no circuit
   bumps the epoch yet) and recorded so the recovery-paths MIP inherits the
   constraint rather than rediscovering it.
8. **MIP-0013 §6 removal removes an entry, not a device, so revocation does
   not revoke.** The device set holds single-use entries and carries no
   per-device identity, so nothing constrains a device to exactly one live
   entry. An enrolled device can enrol a second entry for its *own* key: the
   seam consumes its current entry and inserts the successor, and the
   enrolment then inserts the planted one, leaving the device live at two
   counters with `device_count` inflated by one. A §6 removal takes a single
   set element, and resolving "which element is this device's" returns the
   first live counter found, so a revocation removes one of the two and the
   device keeps authorising on the other. Measured on-node
   (`src/tests/probe-revocation.ts`, jubjub arm): after the owner revoked it,
   the device signed a gated call that advanced `auth_nonce` and enrolled a
   further device of its own choosing.

   **This is not an artefact of entry-based enrolment.** The same bypass runs
   against the shape §6 describes, where the contract derives the entry
   in-circuit at the current epoch and use counter 0: once a device has acted,
   its counter-0 entry is vacant again, so enrolling its own key plants
   exactly that element. The probe exercises both shapes and both bypass, so
   deriving the entry in-circuit is not a fix for this.

   The contract cannot close the gap by inspection: it holds an opaque entry,
   or a key whose other entries it cannot search for, so "this key is already
   enrolled" is not decidable over the current ledger shape. Stating it as a
   client obligation, as the §6 note and S11 do, does not hold either, because
   the party such a rule binds is the adversary in this threat model. **§3
   needs a per-device identity that the contract maintains**: a stable
   arm-marked commitment to the address and key, kept in its own set, with the
   rolling entry derived in-circuit from that commitment, the current epoch,
   and the counter. Enrolment can then reject a key that is already live, and
   removal retires the device rather than one of its entries, while cross-arm
   enrolment survives because the commitment stays opaque to the contract.
   That is a ledger-schema change, so a redeploy rather than a maintenance
   update.

   Two further consequences follow from the same root, and both sharpen the
   case for fixing it in §3 rather than papering over it in §6. First, the
   planted entries are **not enumerable by the owner**: an entry sits at a
   use counter of the planter's choosing, and recovering it means guessing
   that counter, so anything beyond the client's rescan window (4096 from the
   last known counter) cannot be found and therefore cannot be removed.
   Second, every plant increments `device_count`, which is a `Uint<8>`: the
   generated increment carries a range check that aborts the call once the
   value would exceed 255 (`cast from Field or Uint value to smaller Uint
   value failed`). A device that plants repeatedly can therefore push the
   account to a state where **no further device can ever be enrolled**, and
   the removals that would relieve it target entries the owner cannot
   enumerate. The range check is read from the generated code rather than
   driven to 255 on-node.

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
- **The published circuit-maintenance interface cannot insert a current
  verifier key**: compact-js 2.5.5-rc.6 hardcodes
  `ContractOperationVersion 'v3'` (v6-headed keys) while compactc
  0.33.0-rc.2 emits v7-headed keys (tag `'v4'`), so
  `CircuitMaintenanceTxInterface.insertVerifierKey` throws a header-tag
  mismatch before a transaction exists. A version-matrix gap between two
  published packages, not a misuse: nothing in the interface takes a
  version. Wave 2 hand-builds its `MaintenanceUpdate` against the ledger
  API instead (`src/wallet/wave-deploy.ts`), which also lets all 8 inserts
  ride one transaction rather than 8. **Upstream-report candidate.**
- **`addOrReplaceContractOperation` cannot replace**: a bare
  `VerifierKeyInsert` aimed at an operation that already holds a key is
  refused by the ledger, measured as `FailFallible` at every authority
  counter and for both a re-inserted identical key and a foreign one.
  Replacing a key requires a `VerifierKeyRemove` and a `VerifierKeyInsert`
  in **one** update (measured `SucceedEntirely`), and a lone
  `VerifierKeyRemove` is refused as well. compact-js's
  `addOrReplaceContractOperation` emits the bare insert, so despite its name
  it can add an operation but never replace one. **Upstream-report
  candidate**, and a second defect in the same helper as the version
  hardcode above.
- **`ContractOperation` does not expose its verifier key's version**: only
  `verifierKey: Uint8Array`, with the ledger documenting that "only the
  latest available version is exposed to this API". A caller building a
  `VerifierKeyInsert` therefore has no way to read the version back from
  the state it is amending and must pass a literal, which is why the
  wave-2 tag is pinned in source beside the toolchain pin.

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
