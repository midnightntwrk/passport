# ❓🤖 Named Account Registry in Compact: Design Notes

Design notes exploring the feasibility of a Midnight smart contract that mimics
NEAR's named account capability, including a deeper analysis of privacy
implications and stealth-address-based shielded transaction patterns.

---

## Part 1 — Initial Feasibility Assessment

### What §11.1 of `assessments/near-key-management.md` Says

The assessment rates this as **off-chain: low complexity, smart-contract:
moderate, ledger change: high**, and then immediately recommends *against*
protocol-level adoption on privacy grounds. The actionable conclusion is: an
ENS-style opt-in resolver contract is the appropriate integration point if
human-readable addressing is needed at all.

---

### PoC Feasibility

**What NEAR does that we need to replicate:**

1. A canonical map from name → address
2. Uniqueness enforcement (first-come-first-served or auctioned)
3. Hierarchical ownership — only the holder of `alice` can register `sub.alice`
4. Parent-controlled delegation, not a global registrar

**Layer 1 — Flat registry (straightforward)**

A Compact contract with a public ledger map `name → MidnightAddress` is
directly expressible. The contract enforces uniqueness on write.
First-come-first-served registration is trivial. This is essentially the
Cardano ADA Handle model implemented in Compact — there is no fundamental
obstacle.

**Layer 2 — Hierarchy enforcement (non-trivial but feasible)**

In NEAR the hierarchy is free — the transaction is signed by `alice.near`'s
key, so the runtime can check parenthood trivially. In Midnight, caller identity
is not exposed to the contract. To enforce that only the registrant of `alice`
can create `sub.alice`, the registrant would need to supply a ZK proof of key
ownership for the parent name's registered address. This is the right design in
a ZK-native system, but it requires:

- The contract to store a commitment to the owner's key (not the plaintext
  address, if privacy is a goal)
- The registration transaction to include a proof of knowledge of the private
  key behind that commitment
- Compact's proof system to support this kind of predicate (ownership proof
  inside a contract call)

This is non-trivial but architecturally sound. Whether it is currently
expressible in Compact depends on the current state of the language's constraint
system — that is the open question I cannot answer without either consulting
Midnight documentation or running an experiment.

**The central tension**

A name registry is only useful if names are publicly resolvable. That requires
the `name → address` map to be in public Compact state. The moment that map is
public, any observer can link every transaction from `alice.midnight` back to
the human identity "alice". This is not a PoC problem — it is a fundamental
conflict with Midnight's purpose. The assessment flag ("high degradation") is
correct.

**What a PoC would actually be good for**

A PoC is valuable not as a production design but as a stress test of two
specific Compact capabilities:

1. **Can Compact maintain a string-keyed public map with uniqueness
   enforcement?** — Tests the ledger state data model.
2. **Can a Compact contract verify a proof of key ownership as an authorization
   predicate?** — If yes, the hierarchy problem is solved; if no, hierarchy
   requires an off-chain step and the contract degrades to a simple registry
   with no parent-enforced hierarchy.

If both are yes, you have proved the substrate for ZK-native access-controlled
name registries — which is the more interesting result. The named-account
surface is just the motivating use case.

**Recommendation**

A PoC is feasible and worth building as an experiment, scoped to the two
capability questions above rather than full NEAR feature parity. The flat
registry is an afternoon's work; the ownership-proof predicate is the real
experiment. I would log it as a 🧪 HYPOTHESIS: *Compact's constraint system is
expressive enough to verify a ZK proof of key ownership inside a contract
registration call*, with the PoC as the falsifier.

---

## Part 2 — Privacy Issues and Shielded Transaction Patterns

### The Baseline Problem

A naive `name → address` map in public Compact state destroys Midnight's
privacy guarantee before any ZK proof is constructed. Every observer can:

- resolve `alice.midnight` → her address
- scan the chain for all transactions touching that address
- reconstruct her complete transaction history

This is strictly worse than Midnight without names, where addresses are opaque
32-byte strings with no name-linked aggregation point. The assessment's "high
degradation" rating is understated: it is a categorical defeat.

---

### Can the Mapped Address Be Hidden?

Yes — and there are two distinct approaches with very different trade-offs.

**Approach A: Commitment-only registry**

Store `name → Commit(address, randomness)` instead of the plaintext address.
The commitment reveals nothing about the underlying address. Ownership is proved
by supplying a ZK proof of knowledge of a `(address, randomness)` pair that
opens the commitment.

The problem: a sender wanting to pay `alice.midnight` cannot derive her address
from the commitment. Resolution collapses to an authenticated off-chain channel
— alice must tell senders her address through some other means. The on-chain
registry then serves only to prove *that* a name is claimed and *who* owns it;
it does not serve as a payment directory. This is useful for identity
attestation but not for payment routing.

**Approach B: Stealth meta-address registry (the productive design)**

Instead of storing alice's payment address, the registry stores her **stealth
meta-address**: a pair of public keys `(K_scan, K_spend)` that are specifically
designed to be published. The mechanism, modelled on EIP-5564 adapted to
Midnight's elliptic curve:

1. Alice registers `alice.midnight → (K_scan, K_spend)` in the public registry.
   These keys are permanently public — that is intentional.
2. Bob looks up `(K_scan, K_spend)`.
3. Bob generates a fresh ephemeral key pair `(r, R = r·G)`.
4. Bob derives a one-time payment key: `P = K_spend + H(r·K_scan)·G`.
5. Bob creates a ZSwap output targeted at `P` and publishes `R` (the ephemeral
   public key) in the transaction.
6. Alice scans all transactions: for each `R` she computes `H(k_scan · R)·G`
   and checks whether `P − K_spend` matches. If so, she can spend using
   `k_spend + H(k_scan · R)`.

**What this achieves:**

| Observation | Revealed? |
|---|---|
| That `alice.midnight` is a registered name | Yes |
| Alice's stealth meta-address `(K_scan, K_spend)` | Yes — intentionally |
| Which on-chain outputs belong to alice | **No** — each payment lands on a fresh one-time address |
| That any two payments share the same recipient | **No** — outputs are unlinkable |
| The amount of any payment | **No** — ZSwap hides values |
| The sender of any payment | **No** — ZSwap hides senders |

The critical insight: `(K_scan, K_spend)` is an **index into a one-time address
space**, not itself a payment address. Publishing it reveals nothing spendable.
Every actual ZSwap output goes to a fresh `P` that no one — including other
recipients — can link to alice without her scan key.

This is categorically different from NEAR's named accounts, where `alice.near`
is the payment address and every transaction touching it is permanently
attributed to alice.

---

### Integration with ZSwap

ZSwap outputs are commitments of the form `cm = Commit(value, asset_type,
sk_out, ρ)` where `sk_out` is the output's spending key and `ρ` is a randomness
field used for nullifier generation. The stealth address scheme maps cleanly to
this:

- The one-time key `P = K_spend + H(r·K_scan)·G` serves as the public
  component from which `sk_out` is derived.
- The sender constructs the ZSwap output commitment using `P` in place of a raw
  address.
- Alice, having recovered `P` through scanning, derives `sk_out` to produce the
  nullifier when she spends.

There is a curve-compatibility question here: the ECDH step `r·K_scan` requires
both parties to be operating on the same curve, and ZSwap's commitment scheme
uses BLS12-381. So `K_scan` and `K_spend` must be BLS12-381 points, which is
consistent with Midnight's existing cryptographic stack. No new curve is
introduced.

The result is a **send-to-name workflow** that produces a standard,
indistinguishable ZSwap output. An observer watching the chain sees: a ZSwap
spend, a new ZSwap commitment, an ephemeral public key `R`. Nothing links the
output to `alice.midnight` — not even the ephemeral key, because `R` is a fresh
random group element.

---

### Shielded Transactions via the Registry

Three usage patterns emerge:

**Pattern 1 — Anonymous payment to a named recipient**

Bob knows alice's name but not her address. He resolves, derives a one-time
address, sends. Alice receives funds with no on-chain linkage between the
payment and her name. This is the core use case: it makes Midnight *more*
usable for ordinary users without degrading privacy.

**Pattern 2 — Hierarchical address spaces**

Alice can register both `alice.midnight` and `work.alice.midnight`, each with a
different stealth meta-address. Payments to each name land in completely
separate one-time address spaces. Even an observer who knows alice controls both
names cannot link payments across the two spaces — the spending keys are derived
independently. This is stronger than NEAR's hierarchy, which aggregates all
sub-account activity under a common on-chain identity.

**Pattern 3 — Private ownership with public resolution**

To update her registered meta-address, alice submits a Compact transaction
containing a ZK proof of knowledge of `k_spend` (i.e., the private key
corresponding to `K_spend`). She does not sign with a transaction key — she
proves ownership in zero knowledge inside the contract. This means:

- Ownership proof does not reveal alice's spend key
- Updating the registry does not link to any previous transactions
- The registration update transaction is itself a standard Compact transaction
  with no identifying information beyond the name being updated

For the hierarchy case, registering `app.alice.midnight` requires a ZK proof of
knowledge of `k_spend` for the `alice.midnight` meta-address. The parent
controls the namespace without any on-chain action from a named account —
purely through proof-of-knowledge inside the contract call.

---

### What Remains Exposed

Even with stealth addresses, some information leaks:

- **Name existence**: anyone can see that `alice.midnight` is registered, when
  it was registered, and when it was last updated. If "alice" corresponds to a
  real-world identity, the act of registering the name is itself a linkage
  point.
- **Liveness**: alice must scan the full transaction history to find incoming
  payments. This scanning requirement is operationally significant and typically
  done client-side — it does not require any on-chain action that reveals
  alice's identity.
- **Fee payment**: registration and update transactions must pay fees from some
  wallet. If alice's fee-paying wallet can be linked to her, the registration
  transaction leaks. This is the same problem ENS on Ethereum faces.
- **Social graph at registration**: if alice registers `work.alice.midnight`
  from a wallet that previously registered `alice.midnight`, a chain-analysis
  heuristic could link the two registration events even though the meta-addresses
  are independent.

---

### Revised Feasibility Assessment

A stealth meta-address registry is not just feasible — it is a design where
Midnight can offer *better* privacy than NEAR while providing equivalent UX. The
key PoC experiments remain:

1. **Can Compact maintain a public `string → (G1_point, G1_point)` map?**
   (Ledger data model question)
2. **Can a Compact contract verify a ZK proof of `k_spend` as an authorization
   predicate for registration and update?** (Proof system expressiveness
   question)
3. **Does ZSwap's output construction accept a stealth-derived one-time key as
   a valid spending key?** (Protocol integration question — requires consulting
   the ZSwap specification directly)

Question 3 is the binding constraint. If ZSwap's key derivation is compatible
with the ECDH step in stealth address generation, the full scheme follows. If
not, the send-to-name step requires a protocol extension rather than being
achievable purely at the contract layer.

---

## Part 3 — Privacy Properties of the Two Send Paths

The PoC implements two transfer paths. Their privacy properties differ
fundamentally because of *where the amount is recorded*.

### Terminology: Payment Graph and Graph Privacy

The **payment graph** is the directed graph G = (V, E) in which:

- Each node in V is a participant — a wallet address, a named account, or any
  other on-chain identity.
- Each directed edge (u → v, t) in E represents an observed payment: participant
  u sent something to participant v at block t.
- Edges may carry additional attributes: amount, token type, contract involved.

**Graph privacy** means that a chain observer cannot infer the existence of any
edge — i.e., cannot determine that any specific sender paid any specific
recipient at any time.  This is a strictly stronger property than amount privacy
(which hides the value on a known edge) or address privacy (which hides which
real-world identity corresponds to a node).

A **graph leak** occurs whenever on-chain evidence allows an observer to infer
the existence of an edge, even partially.  In this PoC the leak is
**one-sided**: the ledger reveals the destination node (`alice.midnight`) and an
approximate timestamp, but not the source node (sender) or edge weight (amount).
The ZSwap transaction that carries the shielded coin is cryptographically
unlinkable to the `publish_ephemeral` call — the two events share only
approximate block proximity, which is a weak signal in a busy network.

Concretely, what an observer can construct from ledger events alone is not a
payment graph but a **timestamped degree sequence**: for each registered name, a
list of block numbers at which inbound payment events occurred.  Reconstructing
actual directed edges — (sender → recipient, amount) — would additionally
require off-chain private data:

- Knowledge of a sender's real-world identity and its mapping to a ZSwap
  spending key, **and**
- The ability to correlate that spending key with a specific ZSwap note
  commitment in the shielded pool, which requires either the sender's private
  key or a side channel (e.g., a leaked memo or an observed IP address at
  submission time).

Even a one-sided, sourceless leak is significant because it:

1. Confirms that `alice.midnight` is actively receiving payments — revealing
   liveness and demand.
2. Establishes payment-event timing that can be correlated with off-chain
   information (e.g., a known invoice date or a business relationship).
3. Enables traffic analysis over time: an observer counting inbound events per
   name per period can infer usage patterns even without knowing senders or
   amounts.

### tDUST and Public Ledger State

tDUST is shielded at the protocol level — normal wallet-to-wallet tDUST
transfers use zero-knowledge proofs and do not expose amounts. The privacy leak
in the unshielded escrow path is not a property of tDUST itself; it is a
consequence of how the contract stores the amount:

```compact
export ledger pending_amount: Uint<64>;   // public — visible to all
```

`export ledger` fields live in the contract's public state, which is indexed
and readable by anyone. Any value written with `disclose(...)` into a public
ledger field appears in plain text on-chain, regardless of the token type.

### Unshielded Escrow Path

The contract holds tDUST directly. For the circuit to enforce correct
accounting (accept the right amount on `send`, release it on `claim`) the
amount must appear in public ledger state. There is no way to hide it while
the contract holds the coins — doing so would require a full Pedersen
commitment scheme, which is essentially reimplementing ZSwap inside the
contract.

Privacy properties of this path:

| Property | Status |
|---|---|
| Amount | **Exposed** — stored in `pending_amount` |
| Recipient identity | Partial — stealth address hides which on-chain key belongs to Alice, but `pending_P` is visible |
| Sender identity | Exposed via the transaction that calls `send` |
| Graph | **Exposed** — `pending_R`, `pending_P`, `pending_amount` together link sender, receiver slot, and value; with a single pending slot each send/claim pair is trivially correlated |

The stealth address scheme provides *address-space unlinkability* (Alice's real
identity is not on-chain) but offers no amount or graph privacy.

### Shielded ZSwap Path

The wallet SDK creates a ZSwap output directly to the derived stealth address
`P` off-chain. The contract stores only the ephemeral key `R` as a bulletin
board entry via `publish_ephemeral`. The actual coin value is committed in a
Pedersen commitment inside the ZSwap shielded pool — it never appears in
contract state.

Privacy properties of this path:

| Property | Status |
|---|---|
| Amount | **Hidden** — in ZSwap Pedersen commitment; not in contract state |
| Recipient identity | **Hidden** — ZSwap output is encrypted; note contents visible only to holder of one-time private key |
| Sender identity | Hidden within ZSwap transaction graph |
| Graph | **Partial leak** — `publish_ephemeral` writes `shielded_R` to public ledger state, revealing that *someone* directed a payment at this contract at a specific block |

### The `publish_ephemeral` Graph Leak

The bulletin-board pattern trades graph privacy for scan efficiency.  When Bob
calls `publish_ephemeral`, the public ledger field `shielded_R` changes at
block X.  Any chain observer can see:

1. A write to `shielded_R` on Alice's named-account contract at block X —
   confirming that *someone* directed a payment at this named recipient.
2. A ZSwap transaction in the same or adjacent block — a likely candidate for
   the associated shielded transfer.

This is a graph leak in the sense defined above: the observer learns a partial
edge (? → `alice.midnight`, ~block X).  The sender and amount remain hidden, but
the recipient and approximate timing are public.  If Bob repeats the payment
periodically, the observer sees a time-series of payment events and can infer
a payment relationship between some unknown sender and `alice.midnight`.

### Closing the Graph Leak: Full Note-Pool Scanning

True graph privacy eliminates the bulletin board entirely. Bob creates the
ZSwap output to `P` and submits nothing else that points to Alice. Alice
recovers the payment by scanning the entire ZSwap note commitment tree —
attempting to decrypt every new note using keys derived from her stealth
scalars. This is exactly how Zcash shielded wallets operate.

The trade-off:

| Approach | Graph privacy | Scan cost |
|---|---|---|
| Bulletin board (`publish_ephemeral`) | Partial — payment event visible on-chain | O(payments to Alice) |
| Full note-pool scan | Complete | O(all ZSwap notes in the pool) |

For a production named-account service, full note-pool scanning is the
appropriate target. The bulletin board is retained in the PoC solely as a
mechanism to demonstrate the off-chain scanning logic without requiring
wallet-SDK integration for note discovery.

### Summary Comparison

| Property | Unshielded escrow | Shielded + bulletin board | Shielded + full scan |
|---|---|---|---|
| Amount privacy | ✗ | ✓ | ✓ |
| Address privacy | Partial (stealth addr) | ✓ | ✓ |
| Graph privacy | ✗ | Partial (`publish_ephemeral` visible) | ✓ |
| Scan cost | Trivial | O(payments to Alice) | O(all ZSwap notes) |

---

## Part 4 — Compact API Impediments and Workarounds

Building the stealth address circuits exposed several constraints in the
current Compact language and runtime.  Each is documented here together with
the workaround adopted.

---

### Impediment 1: Renamed Standard-Library Functions

**Symptom.** Compilation errors of the form:

```
apparent use of an old standard-library / ledger operator name persistent_hash:
  the new name is persistentHash
```

Several built-in functions were renamed as the language evolved
(`hash_to_curve` → `hashToCurve`, `persistent_hash` → `persistentHash`,
etc.).  The compiler emits a diagnostic but does not automatically migrate the
source.

**Workaround.** Mechanical rename to the camelCase form.  No semantic change.

---

### Impediment 2: Missing Functionality — No Hash-to-Scalar Primitive

**What is needed.** Stealth address derivation requires a function
`hash_to_scalar(input) → s` where `s` is a valid Jubjub scalar (i.e.,
`0 < s < JUBJUB_R`).  This is a standard cryptographic primitive used
wherever a hash output must serve as a curve scalar: nullifier derivation,
key derivation in Sapling/Orchard, and stealth address schemes such as
EIP-5564.

**What Compact provides.** Two hash functions are available:

| Function | Output type | Suitable for state derivation? |
|---|---|---|
| `transientHash<T>(v)` | `Bytes<32>` | No — not guaranteed to persist across contract upgrades |
| `persistentHash<T>(v)` | `Bytes<32>` | Yes — stable across upgrades |

Neither function produces output in the Jubjub scalar field.  Both return a
fixed 32-byte (256-bit) array.  `hashToCurve<T>(v)` maps to a curve *point*
rather than a scalar, so it also does not address this need.

**What is missing.** A `hashToScalar<T>(v) → Field` primitive — equivalent
to `hash_to_field` in hash-to-curve standards (RFC 9380) — that maps
arbitrary input to a uniformly distributed element of `EmbeddedFr` (the
Jubjub scalar field).  Without it, any hash-derived scalar must be produced
outside the circuit and passed in as a witness.

---

### Impediment 3: Missing Functionality — No Modular Arithmetic on `Bytes`

**What is needed.** Given a `Bytes<32>` hash output, the natural in-circuit
fix for Impediment 2 is modular reduction:

```compact
const h = (persistentHash<NativePoint>(S) as Uint<256>) % JUBJUB_R;
```

This would give a value uniformly distributed in `[0, JUBJUB_R)` and
directly usable as a Jubjub scalar.

**What Compact provides.** Integer arithmetic on `Uint<N>` for fixed-width
unsigned integers, and field arithmetic on `Field` (BLS12-381 Fr), but:

- There is no `Uint<256>` type; the largest unsigned integer type is
  `Uint<64>`.
- There is no operation to reduce a `Bytes<N>` or a `Field` value modulo an
  arbitrary constant — only modulo the implicit field order.
- There are no bitwise shift or mask operations on `Bytes<N>` that would
  allow clearing the top bits to bring a value below `JUBJUB_R`.

**What is missing.** Either (a) a `Uint<256>` or `Uint<N>` type with modular
reduction by a circuit constant, or (b) byte-slice / bit-mask operations on
`Bytes<N>`.  Either would allow safe hash-to-scalar conversion in-circuit.

---

### Impediment 4: No Byte-Array Narrowing Casts

**Symptom.** The fallback approach — take only the first 31 bytes of the
32-byte hash, which is guaranteed to be below the 252-bit `JUBJUB_R` —
requires:

```compact
const h = persistentHash<NativePoint>(S) as Bytes<31> as Field;
```

This fails with:

```
cannot cast from type Bytes<32> to type Bytes<31>
```

Compact does not permit narrowing casts on `Bytes<N>`, so there is no way to
extract a sub-range of bytes inside a circuit.

**What is missing.** A slice or index operation on `Bytes<N>` — e.g.,
`bytes[0..31]` — or a narrowing cast `Bytes<M> as Bytes<N>` for `N < M`
(taking the leading N bytes).  This is a common operation in byte-oriented
cryptographic code.

**Attempted workaround.** Use `as Bytes<32> as Field` instead, relying on
implicit modular reduction.  This compiles but fails at runtime (see
Impediment 5).

---

### Impediment 5: Field vs. EmbeddedFr Type Mismatch in Scalar Operations

**Symptom.** After switching to `Bytes<32> as Field`, `npm run send` fails
consistently with:

```
Error: failed to decode for built-in type EmbeddedFr after successful typecheck
```

**Root cause.** Compact's `Field` type is the BLS12-381 scalar field Fr
(≈ 255 bits).  The curve operations `ecMulGenerator` and `ecMul` internally
require a *Jubjub* scalar — an element of the Jubjub group order `JUBJUB_R`
(≈ 252 bits, called `EmbeddedFr` in the WASM runtime).  These are
*different* finite fields:

```
BLS12-381 Fr  ≈  2^255   (Compact Field)
JUBJUB_R      ≈  2^252   (EmbeddedFr, required by ecMulGenerator)
```

`Bytes<32> as Field` interprets 32 bytes as a BLS12-381 Fr element and
succeeds typechecking, but the resulting value exceeds `JUBJUB_R`
approximately 94% of the time.  When the value is subsequently passed to
`ecMulGenerator`, the WASM runtime rejects it with the `EmbeddedFr` decode
error.  This explains why the failure is consistent across multiple runs on
different random inputs.

This is the compound consequence of Impediments 2, 3, and 4: there is no
hash-to-scalar function, no modular reduction to `JUBJUB_R`, and no byte
truncation — so every candidate approach to producing a valid Jubjub scalar
inside the circuit is blocked.

**Workaround.** Move the hash-to-scalar computation entirely out of the
circuit.  Compute `h = persistentHash(S) mod JUBJUB_R` in TypeScript — where
the `%` operator performs the reduction trivially — and pass `h` as a private
witness to the circuit.  The circuit then receives a value that is already a
valid `EmbeddedFr` element and can use it safely in `ecMulGenerator(h)`.

This requires restructuring the circuit interfaces:

| Circuit | Old signature | New signature |
|---------|--------------|---------------|
| `send`  | `(r, amount)` — derived P in-circuit | `(r, P, amount)` — P passed as witness |
| `claim` | `(k_scan_scalar, k_spend_scalar)` — derived h in-circuit | `(k_scan_scalar, k_spend_scalar, h)` — h passed as witness |

**Security argument.** Removing the in-circuit hash verification does not
weaken the claim security.  An adversary who wants to steal Alice's escrowed
funds would need to supply a valid claim proof, which requires:

1. `k_spend_scalar` such that `k_spend_scalar · G = K_spend` (knowledge of
   Alice's spend private key), and
2. `h` such that `K_spend + h · G = pending_P` (i.e., knowledge of the
   discrete logarithm of `pending_P − K_spend`).

Condition 2 is equivalent to solving DLP on the Jubjub curve.  The hash
derivation `h = H(k_scan_scalar · R) mod JUBJUB_R` is used only by Alice in
TypeScript to *find* the correct `h`; the circuit simply verifies the
arithmetic relationship holds.

For the `send` circuit, Bob passes P directly without in-circuit verification.
Bob has no incentive to store an incorrect P — doing so would lock his own
escrowed funds in an unclaim-able state.

---

### Impediment 6: Incorrect CompactType Export Name

**Symptom.** Runtime import error:

```
SyntaxError: The requested module '@midnight-ntwrk/compact-runtime'
  does not provide an export named 'CompactTypeCurvePoint'
```

The documentation at one point described the export as
`CompactTypeCurvePoint`; the actual export name in the installed package is
`CompactTypeNativePoint`.

**Workaround.** Rename the import and all call sites to
`CompactTypeNativePoint`.  No semantic change.

---

### Summary of Impediments

| # | Impediment | Category | Severity | Workaround |
|---|---|---|---|---|
| 1 | Renamed stdlib functions (`persistent_hash` → `persistentHash`) | API churn | Low — compiler diagnoses | Mechanical rename |
| 2 | No `hashToScalar` primitive | **Missing functionality** | **High** — fundamental gap for any hash-derived scalar | Pass scalar as witness |
| 3 | No modular arithmetic on `Bytes<N>` or large integers | **Missing functionality** | **High** — blocks in-circuit hash-to-scalar reduction | Pass scalar as witness |
| 4 | No `Bytes<N>` narrowing cast or slice operation | **Missing functionality** | Medium — blocks byte truncation approach | Pass scalar as witness |
| 5 | `Field` (BLS12-381 Fr) ≠ `EmbeddedFr` (JUBJUB_R); type system does not enforce the distinction | Type system gap | **High** — causes silent 94%-failure-rate runtime error | Pass scalar as witness, reduce mod JUBJUB_R in TypeScript |
| 6 | Incorrect export name in documentation (`CompactTypeCurvePoint`) | Documentation error | Low — immediate import error | Rename to `CompactTypeNativePoint` |

Impediments 2–5 are all facets of the same underlying gap: Compact lacks the
primitives needed to derive a Jubjub scalar from a hash inside a circuit.
The workaround — witness injection with off-circuit reduction — is sound but
shifts security-critical computation out of the verifiable circuit boundary,
which is undesirable in production code.  A `hashToScalar` standard-library
function would close all four impediments simultaneously.

---

### Note: `sendShielded` Circuit vs. Wallet SDK `transferTransaction`

The CompactStandardLibrary documents a `sendShielded` circuit function with
this caveat:

> does not currently create coin ciphertexts, so sending to a user public key
> except for the current user will not lead to this user being informed of the
> coin they've been sent.

This limitation applies only to the **circuit-level** `sendShielded` call,
i.e., when a Compact contract itself holds shielded coins and tries to release
them.  It does **not** affect the wallet SDK's `wallet.transferTransaction`
API, which builds a standard ZSwap transaction with full note ciphertexts and
works correctly for arbitrary recipients (confirmed experimentally in
`experiments/shielding-contracts`).

For the stealth address design, the shielded send path uses
`wallet.transferTransaction` targeting the derived stealth address `P`.  The
Compact contract is never the custodian of shielded coins — it is only a
bulletin board for `R`.  Therefore the `sendShielded` circuit limitation is
irrelevant to this design.

The limitation would become relevant only in a hypothetical design where the
contract holds shielded coins in escrow and releases them to a recipient via
a circuit call — an on-chain shielded escrow.  That pattern is not required
here and should be deferred until the ciphertext limitation is resolved.

---

## Part 5 — Token Transfer Readiness

### tDUST Is Not a Transferable Token

`tDUST` (the Midnight fee token) is not accessible via `receiveUnshielded` /
`sendUnshielded`.  It has its own sub-system in the wallet SDK
(`DustWallet`, `DustSecretKey`) and regenerates over time against a schedule.
The wallet balance output confirms the split:

```
Unshielded:
0000000000000000000000000000000000000000000000000000000000000000: 6015625000

Dust: 31512849131562499985
```

The unshielded token at color `0x0000…0000` is **tNIGHT** (the Night/NIGHT
governance token).  tDUST lives entirely in the `state.dust` sub-wallet and
has no circuit-accessible color.  Attempting to escrow tDUST via the contract
would require a different mechanism not currently exposed by the
CompactStandardLibrary.

### tNIGHT Unshielded Escrow Is Completable

`receiveUnshielded` and `sendUnshielded` operate on the unshielded token layer
where tNIGHT lives.  `nativeToken()` returns its color (`0x0000…0000`).  The
escrow contract can be updated to actually move tNIGHT with three changes:

1. **`pending_amount: Uint<64>` → `Uint<128>`** — the API uses `Uint<128>`.
2. **`send` calls `receiveUnshielded`** — pulls tNIGHT from Bob into the
   contract at call time.
3. **`claim` calls `sendUnshielded`** — releases tNIGHT to Alice's
   `UserAddress`, passed as a witness parameter.

Alice's `UserAddress` is derived from her unshielded keystore:
`PublicKey.fromKeyStore(unshieldedKeystore)` serialised to 32 bytes.

After these changes and a redeploy, the end-to-end tNIGHT escrow flow would be
complete.  Privacy properties remain as described in Part 3: amount and graph
are public.

### Shielded Path — Transfer Readiness (implemented, end-to-end confirmed)

Fully implemented in `shielded-send.ts` and `shielded-scan.ts`.  All steps
confirmed working including the sweep.

**Final stealthSeed construction (two-ECDH, preserves view/spend separation):**

```
S_scan  = r · K_scan    (Alice: k_scan_scalar · R)
S_spend = r · K_spend   (Alice: k_spend_scalar · R)
stealthSeed = sha256(persistentHash(S_scan) || persistentHash(S_spend))
```

Using both ECDH shared secrets means that `k_scan` alone is insufficient to
derive `stealthSeed` — spending requires knowledge of both private scalars.
This was a deliberate upgrade over the single-ECDH experiment (which used only
`persistentHash(S_scan)`) to preserve the view/spend key separation.

| Step | Status |
|---|---|
| Bob derives `stealthSeed` from both ECDH shared secrets | ✓ |
| Bob constructs receiver address via `ZswapSecretKeys.fromSeed(stealthSeed)` + `MidnightBech32m` | ✓ |
| Bob sends shielded tokens via `wallet.transferTransaction(receiverAddress)` | ✓ Confirmed |
| Bob publishes R via `publish_ephemeral` | ✓ |
| Alice derives same `stealthSeed` using `k_scan_scalar` and `k_spend_scalar` | ✓ |
| Alice's stealth wallet (`fromSeed(stealthSeed)`) detects the note | ✓ Confirmed |
| Alice sweeps coin to her real wallet via `transferTransaction` | ✓ Confirmed |

### Experiment: Stealth Wallet via `ZswapSecretKeys.fromSeed` (Results)

Two hypotheses were tested and a live end-to-end transfer confirmed.

**Hypothesis A: FALSE.**  `fromSeed(sk_bytes)` applies a domain-separated KDF
(`hash("midnight:csk" || seed_bytes)`) before producing the spending scalar, so
`coinPublicKey ≠ sk·G = P`.  The one-time private key cannot be used as a seed
that recovers P.

**Hypothesis B: TRUE (confirmed).** Live run against `mesonuktion.midnight`:

```
stealthSeed (hex): 015b8238fe4293310f3ee4596156b8bc1c306927ac21179010b7c0c2dd4c22a5
coinPublicKey    : 7af2b0ed46a23cf0a8ba22efb77dd052565e2085fce8a85896708e118cb85c63
Stealth address  : mn_shield-addr_preprod10tetpm2x5g70p296ythmwlws2ft9ugy9…

Shielded balances in stealth wallet:
  5260e3017099ddeeb59062569f0bd6c26a6df9b4d3b69909ceadf1303191be8c: 2

✅ Hypothesis B CONFIRMED: wallet-native stealth detection works!
```

**Protocol (replaces P = K_spend + h·G for shielded path):**

- Both Alice and Bob compute `stealthSeed = persistentHash(ECDH_shared_secret)`:
  - Bob:   `persistentHash(r · K_scan)`   (private ephemeral scalar `r`)
  - Alice: `persistentHash(k_scan_scalar · R)` (private scan scalar)
  - Equal by ECDH: `r·k_scan·G = k_scan·r·G`
- Bob constructs the ZSwap receiver address from `ZswapSecretKeys.fromSeed(stealthSeed)` encoded via `MidnightBech32m`.
- Bob sends to that address via `wallet.transferTransaction`, then calls `publish_ephemeral(r)`.
- Alice reads `shielded_R`, derives the same `stealthSeed`, builds a temporary `WalletFacade` with `ZswapSecretKeys.fromSeed(stealthSeed)` driving the shielded component, syncs it, and detects the note.
- Alice sweeps the balance to her real wallet via another `transferTransaction`.

**Advantages over K_spend + h·G approach:**
- No scalar addition outside the wallet SDK
- No circuit witness injection needed (`h` parameter in `claim` not required)
- `k_spend` not required on Alice's scan side — only `k_scan` is needed
- Address derivation is entirely wallet-SDK-native (the `mn_shield-addr_…` format)

**Remaining limitation:** `shielded_R` stores only the most recent ephemeral key.
A Map-based design (as noted for the unshielded path) would be needed for
concurrent shielded sends in production.

---

## Part 6 — Platform Improvements That Would Help This Use Case

The PoC exposed a set of gaps in the Compact language, wallet SDK, and underlying
protocol that forced the implementation into awkward workarounds and hard-coded
limits on scalability.  The items below describe the missing features, grouped
by layer, together with a summary table.

---

### Compact Language

- **`hashToScalar` standard-library primitive.**  The single most impactful
  missing feature.  A built-in that maps arbitrary input to a valid JubJub
  scalar (`EmbeddedFr`) would close Impediments 2–5 simultaneously: no more
  witness injection, no off-circuit modular reduction, no `Field`/`EmbeddedFr`
  type confusion.  Equivalent to `hash_to_field` in RFC 9380.

- **`Bytes<N>` slice / narrowing cast.**  `bytes[0..31]` or `Bytes<32> as
  Bytes<31>` would allow byte-level manipulation of hash outputs in-circuit.
  Needed for truncation-based hash-to-scalar fallbacks and for extracting
  sub-fields from composite byte arrays.

- **`Uint<N>` for N > 64, with modular reduction.**  Large-integer arithmetic
  modulo an arbitrary circuit constant (e.g., `JUBJUB_R`) would provide a
  second path to safe hash-to-scalar conversion and enable range proofs over
  values wider than 64 bits.

- **Enforced type distinction between `Field` (BLS12-381 Fr) and `EmbeddedFr`
  (JubJub scalar field).**  The current type system allows a `Field` value to be
  silently passed where `EmbeddedFr` is required, producing a consistent ~94%
  runtime failure rate.  Making the two types incompatible at compile time would
  surface the error immediately rather than at proof-generation time.

- **`Map<K, V>` in public ledger state with efficient membership proofs.**  The
  PoC's single-slot design (`ledger shielded_R: NativePoint`) cannot support
  concurrent payments.  A ledger `Map` with O(log n) proof cost would allow the
  payment queue per name to grow arbitrarily without redesigning the contract.
  This is the primary scalability bottleneck.

- **Private ledger events visible only to designated recipients.**  Currently
  `publish_ephemeral` writes `R` to a *public* ledger field, revealing the
  existence and timing of every payment to any chain observer.  A
  *private-to-recipient* event mechanism — analogous to Ethereum logs but
  encrypted to a recipient key — would allow `R` to be delivered without leaking
  payment existence.  (In the interim, full note-pool scanning eliminates the
  bulletin board at the cost of O(all ZSwap notes) scan work.)

---

### Wallet SDK

- **Ephemeral / seed-only wallet construction.**  Building a `WalletFacade` to
  scan a single stealth address currently requires constructing three sub-wallets
  (`ShieldedWallet`, `UnshieldedWallet`, `DustWallet`), with dummy dust and
  unshielded keys fabricated from the stealth seed to satisfy the API.  A
  lighter-weight "shielded-only scan wallet" that accepts `ZswapSecretKeys`
  directly — no dust or unshielded components — would remove the scaffolding
  and avoid syncing irrelevant sub-wallets.

- **Viewing-key API for shielded note detection.**  A holder of
  `(k_scan, K_spend)` (the view key) should be able to detect incoming shielded
  payments without holding `k_spend_scalar` and without any spending authority.
  Currently there is no SDK path for this: `ZswapSecretKeys.fromSeed` requires
  the full seed (both private scalars), so view-only access to shielded notes
  is not supported.  A `ZswapViewKey` type that drives `ShieldedWallet` in
  read-only mode would directly enable auditor delegation.

- **Note-pool scanning API.**  For true graph privacy, `R` should not be
  published on-chain at all.  Instead the recipient would scan the full ZSwap
  note commitment tree, attempting decryption with each candidate stealth seed.
  An SDK-level `scanNotePool(viewKey, fromBlock)` API — analogous to Zcash's
  `z_importviewingkey` rescan — would make this feasible without building a
  custom indexer.  Without it, the only practical option is the bulletin-board
  pattern, which leaks payment existence.

- **`sendShielded` with full ciphertext generation.**  The documentation notes
  that the circuit-level `sendShielded` function does not currently create coin
  ciphertexts.  For designs where the *contract itself* holds and releases
  shielded coins (an on-chain shielded escrow), this limitation forces the
  custodian role back to the wallet.  Resolving it would allow Compact contracts
  to act as proper shielded custodians, enabling more expressive DeFi patterns.

- **Stable, versioned SDK documentation.**  The `CompactTypeCurvePoint` /
  `CompactTypeNativePoint` mismatch (Impediment 6) and the renamed stdlib
  functions (Impediment 1) required trial-and-error debugging against installed
  package exports rather than documentation.  Keeping API reference docs in
  sync with the published packages would substantially reduce integration
  friction.

---

### Protocol / Ledger

- **Protocol-native stealth address support.**  If the ZSwap protocol accepted a
  stealth meta-address `(K_scan, K_spend)` directly as a `receiverAddress`, the
  ephemeral key `R` could be encrypted to `K_scan` inside the note ciphertext
  rather than published publicly.  This would eliminate the bulletin-board
  `publish_ephemeral` step, remove the graph leak, and reduce the sender's
  on-chain footprint to a single ZSwap transaction — no contract interaction
  required.

- **Efficient on-chain Maps for registry scalability.**  The ledger's current
  state model is well-suited to fixed-schema records.  A registry of thousands
  of names with thousands of pending payments per name requires
  merkle-tree-backed maps with constant-size inclusion proofs.  Without this, the
  proof size and verification cost grow with the number of entries, making a
  shared registry impractical at scale.  (This is a known area of active
  development in Midnight.)

- **Nullifier-keyed payment queues.**  For each registered name, pending
  ephemeral keys should be stored as a set keyed by a one-time nullifier derived
  from `R`, so that once Alice claims a payment the slot is reclaimed.  This
  keeps the on-chain state bounded even for frequently-paid names.  Currently
  there is only one slot per name, and it is overwritten by each new payment.

---

### Summary Table

| Feature | Layer | Eliminates / Enables | Primary Impact |
|---|---|---|---|
| `hashToScalar` primitive | Compact | Impediments 2–5; witness injection; off-circuit scalar reduction | Developer ergonomics, security |
| `Bytes<N>` slice / narrowing cast | Compact | Byte-manipulation workarounds | Developer ergonomics |
| `Uint<N>` for N > 64 + modular reduction | Compact | Alternative hash-to-scalar path; wide range proofs | Developer ergonomics |
| Enforced `Field` / `EmbeddedFr` type separation | Compact | Silent 94%-rate runtime failure | Correctness, developer ergonomics |
| `Map<K, V>` in ledger state | Compact / Ledger | Single-slot overwrite; concurrent payment limit | **Scalability** |
| Private-to-recipient ledger events | Compact / Protocol | `publish_ephemeral` graph leak; payment-existence disclosure | **Privacy** |
| Shielded-only scan wallet | Wallet SDK | Dummy dust/unshielded scaffolding; unnecessary sub-wallet syncs | Developer ergonomics, performance |
| Viewing-key API (`ZswapViewKey`) | Wallet SDK | Auditor delegation; view-only note detection | Privacy, usability |
| Note-pool scanning API | Wallet SDK | Bulletin-board pattern; full graph leak | **Privacy**, scalability |
| `sendShielded` with ciphertexts | Wallet SDK | Contract-custodied shielded escrow limitation | Expressiveness |
| Stable versioned SDK documentation | Tooling | Import-name trial-and-error; API-churn debugging | Developer ergonomics |
| Protocol-native stealth address | Protocol | `publish_ephemeral` contract call; graph leak; sender on-chain footprint | **Privacy**, performance |
| Merkle-backed on-chain Maps | Protocol / Ledger | Proof-size growth with registry size; scalability ceiling | **Scalability** |
| Nullifier-keyed payment queue | Protocol / Ledger | Unbounded per-name state growth | **Scalability** |
