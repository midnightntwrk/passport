---
name: midnight-compact-guide
description: Comprehensive guide to writing Compact smart contracts for Midnight Network. Use this skill when writing, reviewing, debugging, or learning Compact code. Triggers on "write a contract", "Compact syntax", "Midnight smart contract", "ledger state", "circuit function", or "ZK proof".
license: MIT
metadata:
  author: webisoft
  version: "2.1.0"
  midnight-version: "0.27.0"
  compact-version: "0.19+"
---

# Midnight Compact Language Reference (v0.19+)

> **CRITICAL**: This reference is derived from **actual compiling contracts** in the Midnight ecosystem (MeshJS starter template). Always verify syntax against this reference before generating contracts.

## Quick Start Template

Use this as a starting point - it compiles successfully:

```compact
pragma language_version >= 0.19;

import CompactStandardLibrary;

// Ledger state (individual declarations, NOT a block)
export ledger counter: Counter;
export ledger owner: Bytes<32>;

// Witness for private/off-chain data (declaration only)
witness local_secret_key(): Bytes<32>;

// Circuit (returns [] not Void)
export circuit increment(): [] {
  counter.increment(1);
}
```

---

## 1. Pragma (Version Declaration)

**CORRECT** - simple minimum version:
```compact
pragma language_version >= 0.19;
```

**WRONG** - these will cause issues:
```compact
pragma language_version >= 0.14.0;           // ❌ outdated version
pragma language_version >= 0.16 && <= 0.18;  // ❌ outdated, use >= 0.19
```

---

## 2. Imports

Always import the standard library:
```compact
import CompactStandardLibrary;
```

For modular code:
```compact
import "path/to/module";
import { SomeType } from "other/module";
```

---

## 3. Ledger Declarations

**CORRECT** - individual declarations with `export ledger`:
```compact
export ledger counter: Counter;
export ledger owner: Bytes<32>;
export ledger balances: Map<Bytes<32>, Uint<64>>;

// Private state (off-chain only)
ledger secretValue: Field;  // no export = private
```

**WRONG** - block syntax is DEPRECATED:
```compact
// ❌ This causes parse error: found "{" looking for an identifier
ledger {
  counter: Counter;
  owner: Bytes<32>;
}
```

### Ledger Modifiers

```compact
export ledger publicData: Field;           // Public, readable by anyone
export sealed ledger immutableData: Field; // Set once in constructor, cannot change
ledger privateData: Field;                 // Private, not exported
```

---

## 4. Data Types

### Primitive Types

| Type | Description | Example |
|------|-------------|---------|
| `Field` | Finite field element (basic numeric) | `amount: Field` |
| `Boolean` | True or false | `isActive: Boolean` |
| `Bytes<N>` | Fixed-size byte array | `hash: Bytes<32>` |
| `Uint<N>` | Unsigned integer (N = 8, 16, 32, 64, 128, 256) | `balance: Uint<64>` |
| `Uint<MIN..MAX>` | Bounded unsigned integer | `score: Uint<0..100>` |

**⚠️ Uint Type Equivalence:** `Uint<N>` and `Uint<0..MAX>` are the **SAME type family**.
- `Uint<8>` = `Uint<0..255>`
- `Uint<16>` = `Uint<0..65535>`
- `Uint<64>` = `Uint<0..18446744073709551615>`

### Collection Types

| Type | Description | Example |
|------|-------------|---------|
| `Counter` | Incrementable/decrementable | `count: Counter` |
| `Map<K, V>` | Key-value mapping | `Map<Bytes<32>, Uint<64>>` |
| `Set<T>` | Unique value collection | `Set<Bytes<32>>` |
| `Vector<N, T>` | Fixed-size array | `Vector<3, Field>` |
| `List<T>` | Dynamic list | `List<Bytes<32>>` |
| `Maybe<T>` | Optional value | `Maybe<Bytes<32>>` |
| `Either<L, R>` | Union type | `Either<Field, Bytes<32>>` |
| `Opaque<"type">` | External type from TypeScript | `Opaque<"string">` |

### Custom Types

**Enums** - must use `export` to access from TypeScript:
```compact
export enum GameState { waiting, playing, finished }
export enum Choice { rock, paper, scissors }
```

**Enum Access** - use DOT notation (not Rust-style ::):
```compact
// ✅ CORRECT - dot notation
if (choice == Choice.rock) { ... }
game_state = GameState.waiting;

// ❌ WRONG - Rust-style double colon
if (choice == Choice::rock) { ... }  // Parse error!
```

**Structs**:
```compact
export struct PlayerConfig {
  name: Opaque<"string">,
  score: Uint<32>,
  isActive: Boolean,
}
```

---

## 5. Circuits

Circuits are on-chain functions that generate ZK proofs.

**CRITICAL**: Return type is `[]` (empty tuple), NOT `Void`:

```compact
// ✅ CORRECT - returns []
export circuit increment(): [] {
  counter.increment(1);
}

// ✅ CORRECT - with parameters
export circuit transfer(to: Bytes<32>, amount: Uint<64>): [] {
  assert(amount > 0, "Amount must be positive");
  // ... logic
}

// ✅ CORRECT - with return value
export circuit getBalance(addr: Bytes<32>): Uint<64> {
  return balances.lookup(addr);
}

// ❌ WRONG - Void does not exist
export circuit broken(): Void {  // Parse error!
  counter.increment(1);
}
```

### Circuit Modifiers

```compact
export circuit publicFn(): []      // Callable externally
circuit internalFn(): []           // Internal only, not exported
export pure circuit hash(x: Field): Bytes<32>  // No state access
```

---

## 6. Witnesses

Witnesses provide off-chain/private data to circuits. They run locally, not on-chain.

**CRITICAL**: Witnesses are declarations only - NO implementation body in Compact!
The implementation goes in your TypeScript prover.

```compact
// ✅ CORRECT - declaration only, semicolon at end
witness local_secret_key(): Bytes<32>;
witness get_merkle_path(leaf: Bytes<32>): MerkleTreePath<10, Bytes<32>>;
witness store_locally(data: Field): [];
witness find_user(id: Bytes<32>): Maybe<UserData>;

// ❌ WRONG - witnesses cannot have bodies
witness get_caller(): Bytes<32> {
  return public_key(local_secret_key());  // ERROR!
}
```

---

## 7. Constructor

Optional - initializes sealed ledger fields at deploy time:

```compact
export sealed ledger owner: Bytes<32>;
export sealed ledger nonce: Bytes<32>;

constructor(initNonce: Bytes<32>) {
  owner = disclose(public_key(local_secret_key()));
  nonce = disclose(initNonce);
}
```

---

## 8. Pure Circuits (Helper Functions)

Use `pure circuit` for helper functions that don't modify ledger state:

```compact
// ✅ CORRECT - use "pure circuit"
pure circuit determine_winner(p1: Choice, p2: Choice): Result {
  if (p1 == p2) {
    return Result.draw;
  }
  // ... logic
}

// ❌ WRONG - "function" keyword doesn't exist
pure function determine_winner(p1: Choice, p2: Choice): Result {
  // ERROR: unbound identifier "function"
}
```

---

## 9. Common Operations

### Counter Operations
```compact
counter.increment(1);           // Increase by amount (Uint<16>)
counter.decrement(1);           // Decrease by amount (Uint<16>)
const val = counter.read();     // Get current value (returns Uint<64>)
const low = counter.lessThan(100); // Compare with threshold (Boolean)
counter.resetToDefault();       // Reset to zero

// ⚠️ WRONG: counter.value() does NOT exist - use counter.read()
```

### Map Operations
```compact
// Insert/update operations
balances.insert(address, 100);           // insert(key, value): []
balances.insertDefault(address);         // insertDefault(key): []

// Query operations (all work in circuits ✅)
const balance = balances.lookup(address);  // lookup(key): value_type
const exists = balances.member(address);   // member(key): Boolean
const empty = balances.isEmpty();          // isEmpty(): Boolean
const count = balances.size();             // size(): Uint<64>

// Remove operations
balances.remove(address);                // remove(key): []
balances.resetToDefault();               // resetToDefault(): []
```

### Set Operations
```compact
// Insert/remove operations
members.insert(address);                    // insert(elem): []
members.remove(address);                    // remove(elem): []
members.resetToDefault();                   // resetToDefault(): []

// Query operations (all work in circuits ✅)
const isMember = members.member(address);   // member(elem): Boolean
const empty = members.isEmpty();            // isEmpty(): Boolean
const count = members.size();               // size(): Uint<64>
```

### Maybe Operations
```compact
const opt: Maybe<Field> = some<Field>(42);
const empty: Maybe<Field> = none<Field>();

if (opt.is_some) {
  const val = opt.value;
}
```

### Type Casting
```compact
const bytes: Bytes<32> = myField as Bytes<32>;  // Field to Bytes
const num: Uint<64> = myField as Uint<64>;      // Field to Uint (bounds not checked!)
const field: Field = myUint as Field;           // Uint to Field (safe)
```

### Hashing
```compact
// Persistent hash (same input = same output across calls)
const hash = persistentHash<Vector<2, Bytes<32>>>([data1, data2]);

// Persistent commit (hiding commitment)
const commit = persistentCommit<Field>(value);
```

---

## 10. Assertions

```compact
assert(condition, "Error message");
assert(amount > 0, "Amount must be positive");
assert(disclose(caller == owner), "Not authorized");
```

---

## 11. Common Patterns

### Authentication Pattern
```compact
witness local_secret_key(): Bytes<32>;

// IMPORTANT: public_key() is NOT a builtin - use this pattern
circuit get_public_key(sk: Bytes<32>): Bytes<32> {
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "myapp:pk:"), sk]);
}

export circuit authenticated_action(): [] {
  const sk = local_secret_key();
  const caller = get_public_key(sk);
  assert(disclose(caller == owner), "Not authorized");
  // ... action
}
```

### Commit-Reveal Pattern
```compact
pragma language_version >= 0.19;

import CompactStandardLibrary;

export ledger commitment: Bytes<32>;
export ledger revealed_value: Field;
export ledger is_revealed: Boolean;

witness local_secret_key(): Bytes<32>;
witness store_secret_value(v: Field): [];
witness get_secret_value(): Field;

// Helper: compute commitment hash
circuit compute_commitment(value: Field, salt: Bytes<32>): Bytes<32> {
  const value_bytes = value as Bytes<32>;
  return persistentHash<Vector<2, Bytes<32>>>([value_bytes, salt]);
}

// Commit phase
export circuit commit(value: Field): [] {
  const salt = local_secret_key();
  store_secret_value(value);
  commitment = disclose(compute_commitment(value, salt));
  is_revealed = false;
}

// Reveal phase
export circuit reveal(): Field {
  const salt = local_secret_key();
  const value = get_secret_value();
  const expected = compute_commitment(value, salt);
  assert(disclose(expected == commitment), "Value doesn't match commitment");
  assert(disclose(!is_revealed), "Already revealed");

  revealed_value = disclose(value);
  is_revealed = true;
  return disclose(value);
}
```

### Disclosure in Conditionals
When branching on witness values, wrap comparisons in `disclose()`:

```compact
// ✅ CORRECT
export circuit check(guess: Field): Boolean {
  const secret = get_secret();  // witness
  if (disclose(guess == secret)) {
    return true;
  }
  return false;
}

// ❌ WRONG - will not compile
export circuit check_broken(guess: Field): Boolean {
  const secret = get_secret();
  if (guess == secret) {  // implicit disclosure error
    return true;
  }
  return false;
}
```

---

## 12. Common Mistakes to Avoid

| Mistake | Correct |
|---------|---------|
| `ledger { field: Type; }` | `export ledger field: Type;` |
| `circuit fn(): Void` | `circuit fn(): []` |
| `pragma >= 0.16.0` | `pragma language_version >= 0.19;` |
| `enum State { ... }` | `export enum State { ... }` |
| `if (witness_val == x)` | `if (disclose(witness_val == x))` |
| `Cell<Field>` | `Field` (Cell is deprecated) |
| `counter.value()` | `counter.read()` |
| `pure function helper()` | `pure circuit helper()` |
| `Choice::rock` | `Choice.rock` (use dot, not ::) |

---

## 13. Exports for TypeScript

To use types/values in TypeScript, they must be exported:

```compact
// These are accessible from TypeScript
export enum GameState { waiting, playing }
export struct Config { value: Field }
export ledger counter: Counter;
export circuit play(): []

// Standard library re-exports (if needed in TS)
export { Maybe, Either, CoinInfo };
```

---

## Reference Contracts

These contracts compile successfully and demonstrate correct patterns:

1. **Counter** (beginner): `midnightntwrk/example-counter`
2. **Bulletin Board** (intermediate): `midnightntwrk/example-bboard`
3. **Naval Battle Game** (advanced): `ErickRomeroDev/naval-battle-game_v2`
4. **Sea Battle** (advanced): `bricktowers/midnight-seabattle`

When in doubt, reference these repos for working syntax.

---

## Rules

See `/rules/` directory for detailed pattern documentation:
- `privacy-selective-disclosure.md` - ZK disclosure patterns
- `tokens-shielded-unshielded.md` - Token vault patterns

## References

- [Midnight Docs](https://docs.midnight.network)
- [Compact Language Guide](https://docs.midnight.network/develop/reference/compact/lang-ref)
- [OpenZeppelin Compact Contracts](https://github.com/OpenZeppelin/compact-contracts)
- [midnight-mcp](https://github.com/Olanetsoft/midnight-mcp)
