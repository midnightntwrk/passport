# Common Midnight Errors & Solutions

Verified error messages from official Midnight documentation.

## Version Mismatch Errors

**Source:** [Fix version mismatch errors guide](https://docs.midnight.network/how-to/fix-version-mismatches)

Version mismatches occur when Midnight components are out of sync:
- Compact compiler
- Runtime libraries (@midnight-ntwrk/compact-runtime, @midnight-ntwrk/ledger)
- Proof server
- Indexer

### "Version mismatch" / CompactError

```javascript
// The runtime checks version compatibility on startup
throw new __compactRuntime.CompactError(`Version mismatch...`);
```

**Fix:** Check versions and update all components together:
```bash
# Check your versions
compact --version
npm list @midnight-ntwrk/compact-runtime
npm list @midnight-ntwrk/ledger

# Consult the compatibility matrix
# https://docs.midnight.network/relnotes/support-matrix
```

---

## Compact Compiler Errors

### "invalid context for a ledger ADT type"
**Source:** Compact 0.15/0.23 release notes

Ledger ADT types (Counter, Map, etc.) cannot be used as Compact types in casts.

```compact
// ❌ Wrong - casting to ledger ADT type
const x = value as Counter;  // Error!

// ✅ Correct - use the ledger field directly
ledger.counter.increment(1);
```

### "static type error" - argument count/type mismatch
**Source:** Compact runtime type checks

```javascript
// Runtime validates argument counts
if (args_1.length !== 2)
  throw new __compactRuntime.CompactError(
    `post: expected 2 arguments, received ${args_1.length}`
  );
```

**Fix:** Ensure TypeScript calls match circuit signatures exactly.

### assert() failures
**Source:** [Compact language reference](https://docs.midnight.network/develop/reference/compact/lang-ref)

```compact
// Assert syntax (Compact 0.16+)
assert(condition, "error message");

// Example from bboard tutorial
assert(ledger.state == State.VACANT, "Attempted to post to an occupied board");
```

**Note:** If assertion fails, the transaction fails without reaching the chain.

### "found "{" looking for an identifier"

Using deprecated `ledger {}` block syntax:

```compact
// ❌ Wrong - deprecated block syntax
ledger {
  counter: Counter;
}

// ✅ Correct - individual declarations
export ledger counter: Counter;
```

### "Void is not defined" / "Unknown type Void"

Using non-existent `Void` type:

```compact
// ❌ Wrong
export circuit myFn(): Void { }

// ✅ Correct - use empty tuple
export circuit myFn(): [] { }
```

### "unbound identifier 'function'"

Using non-existent `function` keyword:

```compact
// ❌ Wrong
pure function helper(): Field { }

// ✅ Correct - use "pure circuit"
pure circuit helper(): Field { }
```

---

## TypeScript SDK Errors

### ContractTypeError
**Source:** @midnight-ntwrk/midnight-js-contracts

Thrown when there's a contract type mismatch between the given contract type
and the initial state deployed at a contract address.

```typescript
// Typically thrown by findDeployedContract()
try {
  const contract = await findDeployedContract(provider, address, MyContract);
} catch (e) {
  if (e instanceof ContractTypeError) {
    // The contract at this address is a different type
    console.error('Contract type mismatch:', e.circuitIds);
  }
}
```

### type_error() - Runtime type errors
**Source:** @midnight-ntwrk/compact-runtime

Internal function for type errors with parameters: who, what, where, type, value.

---

## DApp Connector Errors

**Source:** @midnight-ntwrk/dapp-connector-api ErrorCodes

```typescript
import { ErrorCodes } from '@midnight-ntwrk/dapp-connector-api';

// ErrorCodes.Rejected - User rejected the request
// ErrorCodes.InvalidRequest - Malformed transaction or request
// ErrorCodes.InternalError - DApp connector couldn't process request

try {
  const api = await window.midnight.mnLace.enable();
} catch (error) {
  if (error.code === ErrorCodes.Rejected) {
    console.log('User rejected wallet connection');
  }
}
```

---

## Node.js Environment Errors

### ERR_UNSUPPORTED_DIR_IMPORT
**Source:** [BBoard tutorial troubleshooting](https://docs.midnight.network/develop/tutorial/3-creating/bboard-dapp)

Occurs due to environment caching after modifying shell config or changing Node versions.

**Fix:**
```bash
# 1. Open a NEW terminal window (don't just source ~/.zshrc)
# 2. Verify Node version
nvm use 18

# 3. Clear cached modules
rm -rf node_modules/.cache
```

---

## Transaction Errors

### INSUFFICIENT_FUNDS / Not enough tDUST
**Source:** Midnight documentation examples

```typescript
try {
  const result = await sdk.sendTransaction(options);
} catch (error) {
  if (error.code === 'INSUFFICIENT_FUNDS') {
    console.error('Not enough tDUST in wallet');
    // Direct user to testnet faucet
  }
}
```

---

## Debugging Checklist

1. **Check Compatibility Matrix:** [/relnotes/support-matrix](https://docs.midnight.network/relnotes/support-matrix)
2. **Recompile after updates:**
   ```bash
   rm -rf contract/*.cjs contract/*.prover contract/*.verifier
   compact compile src/contract.compact contract/
   ```
3. **Verify versions match:**
   - Compact compiler
   - @midnight-ntwrk/compact-runtime
   - @midnight-ntwrk/ledger
   - Proof server
4. **Check Discord** #developer-support channel

---

## P0 Static Analysis Errors

These are critical errors caught by static analysis:

| Check | Error | Fix |
|-------|-------|-----|
| `deprecated_ledger_block` | `ledger { }` block syntax | Use `export ledger field: Type;` |
| `invalid_void_type` | `Void` return type | Use `[]` (empty tuple) |
| `invalid_pragma_format` | Old pragma format | Use `>= 0.16 && <= 0.18` |
| `module_level_const` | Module-level constants | Use `pure circuit` instead |
| `unexported_enum` | Enum not exported | Add `export` keyword |
