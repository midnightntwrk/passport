---
name: midnight-test-runner
description: Run and debug Midnight contract tests using Vitest simulators. Use this skill when testing contracts, debugging test failures, or writing new tests. Triggers on "run tests", "test contract", "debug test", "test fails", or "vitest".
license: MIT
metadata:
  author: webisoft
  version: "1.0.0"
  midnight-version: "0.27.0"
---

# Midnight Test Runner

Run, debug, and write tests for Midnight smart contracts using Vitest and contract simulators.

## When to Use

Use this skill when:
- Running contract test suites
- Debugging failing tests
- Writing new test cases
- Testing privacy features (selective disclosure)
- Validating ZK circuit behavior

## How It Works

1. Compiles Compact contract
2. Creates contract simulator from compiled artifacts
3. Runs Vitest test suite
4. Reports results with coverage

## Quick Start

```bash
# Navigate to contract directory
cd counter-contract

# Run all tests
npm run test

# Run with watch mode
npm run test:watch

# Run with coverage
npm run test -- --coverage
```

## Test Structure

### Directory Layout

```
counter-contract/
├── src/
│   ├── counter.compact          # Contract source
│   ├── witnesses.ts             # Private state types
│   ├── managed/                 # Compiled artifacts
│   └── test/
│       ├── counter.test.ts      # Test file
│       └── simulators/
│           └── simulator.ts     # Contract simulator
```

### Basic Test File

```typescript
// counter.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { CounterSimulator } from './simulators/simulator';

describe('Counter Contract', () => {
  let simulator: CounterSimulator;

  beforeEach(() => {
    simulator = CounterSimulator.deployContract(0);
  });

  it('initializes with correct values', () => {
    const ledger = simulator.getLedger();
    expect(ledger.round).toBe(0n);
  });

  it('increments the counter', () => {
    simulator.as('player1').increment();
    const ledger = simulator.getLedger();
    expect(ledger.round).toBe(1n);
  });
});
```

## Contract Simulator Pattern

### Creating a Simulator

```typescript
// simulators/simulator.ts
import { Contract } from '../managed/contract';

type LedgerState = {
  round: bigint;
};

type PrivateState = {
  privateCounter: number;
};

export class CounterSimulator {
  private ledger: LedgerState;
  private privateStates: Map<string, PrivateState>;
  private currentPlayer: string = 'default';

  private constructor(initialValue: number) {
    this.ledger = { round: BigInt(initialValue) };
    this.privateStates = new Map();
    this.privateStates.set('default', { privateCounter: initialValue });
  }

  static deployContract(initialValue: number): CounterSimulator {
    return new CounterSimulator(initialValue);
  }

  as(playerId: string): CounterSimulator {
    this.currentPlayer = playerId;
    if (!this.privateStates.has(playerId)) {
      this.privateStates.set(playerId, { privateCounter: 0 });
    }
    return this;
  }

  getLedger(): LedgerState {
    return { ...this.ledger };
  }

  getPrivateState(): PrivateState {
    return { ...this.privateStates.get(this.currentPlayer)! };
  }

  increment(): LedgerState {
    this.ledger.round += 1n;
    return this.getLedger();
  }
}
```

## Testing Patterns

### Testing State Changes

```typescript
it('updates ledger state correctly', () => {
  const before = simulator.getLedger();
  simulator.increment();
  const after = simulator.getLedger();

  expect(after.round).toBe(before.round + 1n);
});
```

### Testing Assertions

```typescript
it('rejects invalid operations', () => {
  expect(() => {
    simulator.withdraw(1000n); // More than balance
  }).toThrow('Insufficient balance');
});
```

### Testing Private State

```typescript
it('maintains separate private state per player', () => {
  simulator.as('player1').setPrivateValue(100);
  simulator.as('player2').setPrivateValue(200);

  expect(simulator.as('player1').getPrivateState().value).toBe(100);
  expect(simulator.as('player2').getPrivateState().value).toBe(200);
});
```

### Testing Selective Disclosure

```typescript
it('proves balance threshold without revealing balance', () => {
  // Set private balance
  simulator.setPrivateBalance(50000n);

  // Prove balance > 10000 (should succeed)
  expect(() => {
    simulator.proveBalanceAboveThreshold(10000n);
  }).not.toThrow();

  // Prove balance > 100000 (should fail)
  expect(() => {
    simulator.proveBalanceAboveThreshold(100000n);
  }).toThrow('Balance below threshold');

  // Verify ledger doesn't expose actual balance
  const ledger = simulator.getLedger();
  expect(ledger.actualBalance).toBeUndefined();
});
```

### Testing Multi-Player Scenarios

```typescript
it('handles turn-based gameplay', () => {
  // Player 1 commits move
  simulator.as('player1').commitMove(hashMove(1, 'salt1'));
  expect(simulator.getLedger().gameState).toBe(1);

  // Player 2 commits move
  simulator.as('player2').commitMove(hashMove(2, 'salt2'));
  expect(simulator.getLedger().gameState).toBe(2);

  // Reveal phase
  simulator.revealMoves(1, 'salt1', 2, 'salt2');
  expect(simulator.getLedger().winner).toBe(2);
});
```

## Running Tests

### All Tests

```bash
npm run test
```

### Specific File

```bash
npm run test -- counter.test.ts
```

### With Pattern

```bash
npm run test -- --grep "increment"
```

### Watch Mode

```bash
npm run test:watch
```

### Coverage Report

```bash
npm run test -- --coverage
```

## Debugging Tests

### Enable Verbose Output

```bash
npm run test -- --reporter=verbose
```

### Debug Single Test

```typescript
it.only('focuses on this test', () => {
  // Only this test runs
});
```

### Skip Failing Tests

```typescript
it.skip('skip this test temporarily', () => {
  // Skipped
});
```

### Console Debugging

```typescript
it('debug with console', () => {
  const ledger = simulator.getLedger();
  console.log('Ledger state:', JSON.stringify(ledger, null, 2));

  simulator.increment();

  const after = simulator.getLedger();
  console.log('After increment:', JSON.stringify(after, null, 2));
});
```

## Test Script

```bash
bash /path/to/skills/midnight-test-runner/scripts/test.sh [contract-path] [options]
```

**Arguments:**
- `contract-path` - Path to contract directory (default: current)
- `options` - Additional vitest options

**Examples:**

```bash
# Run all tests
bash scripts/test.sh ./counter-contract

# Run with coverage
bash scripts/test.sh ./counter-contract --coverage

# Run specific test file
bash scripts/test.sh ./counter-contract counter.test.ts
```

## Troubleshooting

### Tests Not Finding Simulator

```
Error: Cannot find module './simulators/simulator'
```
**Solution**: Create simulator file or check import path

### Type Errors in Tests

```
Error: Type 'number' is not assignable to type 'bigint'
```
**Solution**: Use `BigInt()` or `n` suffix: `100n`

### Async Test Timeout

```
Error: Test timeout exceeded
```
**Solution**: Increase timeout or check for unresolved promises:
```typescript
it('async test', async () => {
  await simulator.asyncOperation();
}, 10000); // 10 second timeout
```

### Contract Not Compiled

```
Error: Cannot find compiled artifacts
```
**Solution**: Run `npm run build` before tests

## Best Practices

1. **Test edge cases** - Empty arrays, zero values, max values
2. **Test assertions** - Verify error messages match
3. **Test privacy** - Ensure private data stays private
4. **Isolate tests** - Use `beforeEach` for fresh state
5. **Name clearly** - Test names should describe expected behavior

## References

- [Vitest Documentation](https://vitest.dev/)
- [Midnight Testing Guide](https://docs.midnight.network/guides/testing)
- [Starter Template Tests](https://github.com/MeshJS/midnight-starter-template)
