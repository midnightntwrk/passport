# local-tee-poc — Lessons Learned

See also [`../mn-tui/lessons-learned.md`](../mn-tui/lessons-learned.md) for SDK
lessons that apply here too (tryApply patch, signTransactionIntents, WebSocket,
levelPrivateStateProvider, Bech32 addresses).

---

## 1. `compact-js` runtime/compiler version mismatch

**Problem:** `npm install` with `^2.4.0` resolves to a newer `compact-js` release
that provides runtime 0.15.0, while the `compact` compiler binary available on
PATH targets runtime 0.14.0. This causes a runtime error on first contract module
load:

```
Version mismatch: compiled code expects 0.14.0, runtime is 0.15.0
```

**Fix:** Pin to the exact version the compiler was built for:

```json
"@midnight-ntwrk/compact-js": "2.4.0"
```

Then `npm install && npm run compile`. Do not use a `^` range for `compact-js`
unless the compiler binary is explicitly updated at the same time.

---

## 2. Pin all `@midnight-ntwrk/*` versions to match a known-working install

**Problem:** Using `^` ranges for `@midnight-ntwrk/*` packages resolves to newer
versions than those actually tested.  Newer releases introduce breaking API changes
(e.g. `midnight-js-level-private-state-provider` gained mandatory
`privateStoragePasswordProvider` and `accountId` options) and introduce nested
copies of shared packages (e.g. `midnight-js-network-id`) with independent module
state, causing "Network ID has not been configured" errors that are very hard to
debug.

**Fix:** Copy exact installed versions from the reference `mn-tui` project and pin
every `@midnight-ntwrk/*` package without a `^` range:

```json
"@midnight-ntwrk/midnight-js-contracts":                    "3.0.0",
"@midnight-ntwrk/midnight-js-http-client-proof-provider":   "3.0.0",
"@midnight-ntwrk/midnight-js-indexer-public-data-provider": "3.0.0",
"@midnight-ntwrk/midnight-js-level-private-state-provider": "3.0.0",
"@midnight-ntwrk/midnight-js-network-id":                   "3.0.0",
...
```

Then delete `node_modules/` and run `npm install` to get a clean install at the
pinned versions.

---

## 3. `CompiledContract` requires `withVacantWitnesses` for contracts without a witnesses file

**Problem:** `deployContract` and `findDeployedContract` require a fully-built
`CompiledContract` that includes a witnesses object.  Omitting
`CompiledContract.withVacantWitnesses` leaves the witnesses argument `undefined`,
and the contract constructor throws:

```
CompactError: first (witnesses) argument to Contract constructor is not an object
```

**Fix:** Always pipe `withVacantWitnesses` (for contracts with no external
witnesses file) before `withCompiledFileAssets`:

```typescript
const compiled = CompiledContract.make('compliance', contractMod.Contract).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(MANAGED_PATH),
);
```

Use the same `compiled` object for both `deployContract` and
`findDeployedContract`.  Pass `compiledContract` (not `contract`) and include
`initialPrivateState: {}`:

```typescript
await (deployContract as any)(providers, {
  compiledContract:    compiled,
  privateStateId:      'my-state',
  initialPrivateState: {},
});

await (findDeployedContract as any)(providers, {
  contractAddress:     addr,
  compiledContract:    compiled,
  privateStateId:      'my-state',
  initialPrivateState: {},
});
```

---

## 5. Reading on-chain ledger state: `getPublicStates` + compiled `ledger()` function

**Problem:** `FoundContract` (returned by `findDeployedContract`) has no `.state`
property.  Attempting `Rx.firstValueFrom(deployed.state)` throws
`Cannot read properties of undefined (reading 'subscribe')`.

**Fix:** Use `getPublicStates` (from `@midnight-ntwrk/midnight-js-contracts`) with
the `publicDataProvider` and the contract address, then decode the raw
`ContractState` with the compiled contract's `ledger()` helper:

```typescript
import {getPublicStates} from '@midnight-ntwrk/midnight-js-contracts';

const pubStates = await getPublicStates(providers.publicDataProvider, contractAddress);
const pub = contractMod.ledger(pubStates.contractState.data);
// pub now has named fields: pub.compliance_tier, pub.device_registered, etc.
```

The compiled module exports `ledger(state: StateValue | ChargedState): Ledger`
where `Ledger` mirrors the `export ledger` fields in the Compact source.
Non-exported fields are absent from `Ledger`.

---

## 7. `assert` syntax and boolean negation

**Problem:** Compact's `assert` requires parentheses and a comma:
`assert(condition, "message")`. Writing `assert condition "message"` (no parens)
is a parse error. Additionally, Compact does not support `!` as a unary boolean
negation operator — use `== false` instead.

**Fix:**
```compact
// Wrong:
assert !device_registered "device already registered";

// Correct:
assert(device_registered == false, "device already registered");
```

---

## 8. `disclose()` required for all ledger assignments of witness values

**Problem:** Compact's type system requires `disclose()` for every assignment of
a circuit-parameter (witness) value to any ledger field, including non-`export`
fields.  Omitting it causes a compile error:

```
potential witness-value disclosure must be declared but is not
```

**Fix:** Use `disclose()` for all witness-to-ledger assignments regardless of
whether the field is exported:

```compact
identity_commitment = disclose(new_identity_commitment);
```

**Note:** The precise on-chain footprint of non-exported ledger fields (whether
their committed values are recoverable from the state tree) is unverified.  The
`export` keyword controls ABI visibility; it does not by itself guarantee that
the value is absent from the on-chain state commitment.

---

## 9. `ecMulGenerator` requires a Jubjub scalar, not a BLS12-381 field element

**Problem:** Compact's `Field` type is the BLS12-381 scalar field (~255 bits).
`ecMulGenerator` takes a `Field` argument but additionally requires the runtime
value to be a valid **Jubjub scalar** (EmbeddedFr, ~252 bits, bounded by
`JUBJUB_R`). Passing a value in `[JUBJUB_R, FIELD_MODULUS)` passes Compact's
type check but causes a `ContractRuntimeError: Error executing circuit` at
runtime with a nested "EmbeddedFr decode failure" cause.

~94% of random 32-byte samples exceed `JUBJUB_R`, so the reduction is not optional.

**Fix:** Generate device keys using the Jubjub scalar field order:

```typescript
const JUBJUB_R =
  6554484396890773809930967563523245729705921265872317281365359162392183254199n;

function generateJubjubScalar(): string {
  const bytes = crypto.randomBytes(32);
  bytes[0] &= 0x0f;   // clear top 4 bits → value < 2^252 ≈ JUBJUB_R
  const value = BigInt('0x' + Buffer.from(bytes).toString('hex')) % JUBJUB_R;
  return value.toString(16).padStart(64, '0');
}
```

The same constraint applies to any `Field` witness passed to `ecMulGenerator`
or `ecMul`.

---

## 10. Schnorr signature verification via `ecMul` + exported pure circuits

**Context:** The original `update_compliance` circuit took `sk_device` as a
private ZK witness and re-derived `pk = ecMulGenerator(sk_device)` to prove
device ownership. This forced the proof server to receive `sk_device` on every
update — a persistent credential, not a one-time token.

**`ecMul` is available:** Compact 0.4.0 / runtime 0.14.0 provides
`ecMul(a: NativePoint, b: Field): NativePoint`, enabling full Schnorr signature
verification inside the circuit.

**Casts on `Bytes<32>` are range checks, not truncations (critical):**
`Bytes<32> as Uint<248>` does NOT drop the top 8 bits — it is a runtime
range check that FAILS if the integer value (little-endian) exceeds 2^248 − 1.
Since bit 248 or higher is set in ~99.6% of 256-bit hashes, this cast fails
almost always.  Similarly, `Bytes<32> as Field` fails for ~50% of hashes (those
≥ FIELD_MODULUS).  `ecMul` itself does not reduce scalars: passing a value ≥
JUBJUB_R causes an `EmbeddedFr decode failure` at runtime.

**Solution — nonce-retry in TypeScript:** Add a `nonce: Uint<64>` parameter to
the hash, export `compute_schnorr_challenge` returning `Bytes<32>`, and retry
with nonce = 0, 1, 2, … until the hash (as a little-endian bigint) is < JUBJUB_R
(~5.7% probability per try → ~17 expected iterations):

```compact
// In the circuit — cast always succeeds because TypeScript verified h < JUBJUB_R
const h: Bytes<32> = persistentHash<[..., Uint<64>]>([sig_r, device_pk, ..., nonce]);
const c: Field = h as Field;
assert(ecMulGenerator(sig_s) == ecAdd(sig_r, ecMul(device_pk, c)), "invalid device signature");

// Pure helper — returns raw bytes so TypeScript can check the value
export pure circuit compute_schnorr_challenge(..., nonce: Uint<64>): Bytes<32> {
  return persistentHash<[..., Uint<64>]>([sig_r, pk, ..., nonce]);
}
```

```typescript
// In TypeScript (stub TEE) — little-endian bytes → bigint, retry until < JUBJUB_R
function bytesToBigIntLE(bytes: Uint8Array): bigint {
  let r = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) r = (r << 8n) | BigInt(bytes[i]);
  return r;
}

let nonce = 0n;
let c: bigint;
for (;;) {
  const hBytes = circuits.compute_schnorr_challenge(sigR, pk, ..., nonce);
  const hInt = bytesToBigIntLE(hBytes);
  if (hInt < JUBJUB_R) { c = hInt; break; }
  nonce++;
}
const sigS = (rBI + (c * skDeviceBI) % JUBJUB_R) % JUBJUB_R;
```

**Pure circuits for TypeScript signing:** Exported pure circuits appear in
`contractMod.pureCircuits` and are callable synchronously from TypeScript without
generating a ZK proof.  Using them for `compute_nonce_point` and
`compute_schnorr_challenge` ensures the TypeScript uses the same curve parameters
and `persistentHash` implementation as the ZK circuit — no risk of library mismatch.

**Result:** `sk_device` is passed to the proof server only once (registration).
All subsequent `update_compliance` calls send only the Schnorr signature `(R, s)`.
Intercepting a signature gives an attacker a single-use, message-bound token —
worthless for other updates since `update_count` is bound into the challenge.

---

## 11. Transient UTXO staleness after rapid sequential transactions

**Observed behaviour:** Submitting two `update_compliance` transactions in quick
succession (within a few seconds of each other in the same wallet session) can
cause the second to fail with:

```
RpcError: 1010: Invalid Transaction: Custom error: 170
```

A single immediate retry always succeeds.

**Root cause:** The Midnight wallet SDK reports `isSynced: true` once it has caught
up to the current chain tip in terms of block headers. However, the wallet's
internal UTXO set (DUST fee coins) may not yet reflect the outputs created by the
just-confirmed preceding transaction. `buildProviders` waits for `isSynced` but
this is insufficient to guarantee that new unspent outputs from the previous
transaction are available for coin selection. The wallet therefore selects an
already-spent UTXO and the node rejects it.

**Workaround:** Retry on submission error.  For this PoC the failure is transient
and self-resolving — the user can simply try again. A production implementation
should add an automatic retry loop (with brief back-off) around `callTx.*` calls.
