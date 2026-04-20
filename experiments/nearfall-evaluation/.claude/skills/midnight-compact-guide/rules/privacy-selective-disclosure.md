# Privacy: Selective Disclosure

## Rule ID
`privacy-selective-disclosure`

## Priority
CRITICAL

## Description
Selective disclosure allows proving claims about private data without revealing the underlying values. This is the core privacy feature of Midnight and should be used whenever sensitive data needs to be verified.

## Why It Matters
- Users can prove eligibility without exposing personal data
- Financial verification without revealing exact balances
- Age verification without exposing birth dates
- Compliance proofs without full data disclosure

## Incorrect Pattern

```compact
// BAD: Exposes exact balance on-chain
export ledger userBalance: Uint<64>;

export circuit checkBalance(userId: Bytes<32>): [] {
  // Balance is PUBLIC - everyone can see it!
  assert(userBalance >= 10000, "Insufficient balance");
}
```

## Correct Pattern

```compact
// GOOD: Balance stays private, only threshold check is proven
export ledger thresholdMet: Map<Bytes<32>, Boolean>;

export circuit proveBalanceAboveThreshold(
  userId: Bytes<32>,
  threshold: Uint<64>,
  actualBalance: Uint<64>  // Private witness - NOT stored on chain
): [] {
  // ZK proof verifies this assertion without revealing actualBalance
  assert(actualBalance >= threshold, "Balance below threshold");

  // Only store that threshold was met, not the actual balance
  thresholdMet[userId] = true;
}
```

## Advanced Example: Range Proof

```compact
// Prove balance is within a range without revealing exact value
export circuit proveBalanceInRange(
  userId: Bytes<32>,
  minBalance: Uint<64>,
  maxBalance: Uint<64>,
  actualBalance: Uint<64>  // Private witness
): [] {
  assert(actualBalance >= minBalance, "Below minimum");
  assert(actualBalance <= maxBalance, "Above maximum");
  // Verifier learns: minBalance <= balance <= maxBalance
  // Verifier does NOT learn: exact balance
}
```

## TypeScript Integration

```typescript
// witnesses.ts
export type BalanceWitness = {
  actualBalance: bigint;
};

export const witnesses = {
  getBalance: (state: PrivateState): bigint => {
    return state.accountBalance;
  },
};
```

## Common Use Cases

1. **Financial Thresholds**: Prove sufficient funds without revealing wealth
2. **Age Verification**: Prove age >= 18 without revealing birth date
3. **Accreditation**: Prove investor status without revealing net worth
4. **Credit Scoring**: Prove creditworthiness without exposing history
5. **KYC Compliance**: Prove identity verified without sharing documents

## Testing

```typescript
it("proves balance above threshold without revealing balance", () => {
  const simulator = createSimulator();

  // Set private balance to 50,000
  simulator.setPrivateBalance(50000n);

  // Prove balance > 10,000 - should succeed
  expect(() => {
    simulator.proveBalanceAboveThreshold(10000n);
  }).not.toThrow();

  // Verify ledger doesn't contain actual balance
  const ledger = simulator.getLedger();
  expect(ledger.actualBalance).toBeUndefined();
});
```

## References
- [Midnight Selective Disclosure](https://docs.midnight.network/guides/selective-disclosure)
- [Zero-Knowledge Proofs Explained](https://docs.midnight.network/concepts/zk-proofs)
