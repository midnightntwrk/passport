# Tokens: Shielded and Unshielded

## Rule ID
`tokens-shielded-unshielded`

## Priority
HIGH

## Description
Midnight supports both shielded (private) and unshielded (public) tokens. Understanding when and how to use each is critical for building privacy-preserving applications.

## Source
Based on [midnight-ledger PR #142](https://github.com/midnightntwrk/midnight-ledger/pull/142) - Token Vault contract with shielded/unshielded token support.

## Token Types

### Unshielded Tokens
- Balances are **publicly visible** on the ledger
- Similar to traditional ERC-20 tokens
- Useful for public treasuries, governance tokens
- Lower proof generation cost

### Shielded Tokens
- Balances are **private** (encrypted)
- Only owner can see their balance
- Uses zero-knowledge proofs for transfers
- Higher privacy, higher proof cost

## Token Vault Pattern

A token vault contract that supports both shielded and unshielded tokens:

```compact
pragma language_version >= 0.19;

import CompactStandardLibrary;

// ============================================
// TOKEN VAULT CONTRACT
// ============================================

// Unshielded (public) balances
export ledger unshieldedBalances: Map<Bytes<32>, Uint<64>>;
export ledger totalUnshieldedSupply: Counter;

// Shielded token state is managed separately
// (actual balances stored in private state)
export ledger shieldedCommitments: Map<Bytes<32>, Bytes<32>>;
export ledger totalShieldedSupply: Counter;

// Token metadata
export ledger tokenName: Bytes<32>;
export ledger tokenSymbol: Bytes<8>;
export ledger decimals: Uint<8>;

// ============================================
// UNSHIELDED OPERATIONS (Public)
// ============================================

// Mint unshielded tokens (public balance)
export circuit mintUnshielded(
  recipient: Bytes<32>,
  amount: Uint<64>
): [] {
  unshieldedBalances[recipient] = unshieldedBalances[recipient] + amount;
  totalUnshieldedSupply.increment(amount);
}

// Transfer unshielded tokens (public)
export circuit transferUnshielded(
  from: Bytes<32>,
  to: Bytes<32>,
  amount: Uint<64>
): [] {
  assert(unshieldedBalances[from] >= amount, "Insufficient balance");

  unshieldedBalances[from] = unshieldedBalances[from] - amount;
  unshieldedBalances[to] = unshieldedBalances[to] + amount;
}

// Burn unshielded tokens
export circuit burnUnshielded(
  from: Bytes<32>,
  amount: Uint<64>
): [] {
  assert(unshieldedBalances[from] >= amount, "Insufficient balance");
  unshieldedBalances[from] = unshieldedBalances[from] - amount;
  // Note: Counter doesn't support decrement, track burns separately
}

// ============================================
// SHIELDED OPERATIONS (Private)
// ============================================

// Mint shielded tokens (balance hidden)
export circuit mintShielded(
  recipientCommitment: Bytes<32>,
  amount: Uint<64>
): [] {
  // Store commitment (hash of recipient + amount + randomness)
  // Actual balance stored in recipient's private state
  shieldedCommitments[recipientCommitment] = recipientCommitment;
  totalShieldedSupply.increment(amount);
}

export ledger nullifierUsed: Map<Bytes<32>, Boolean>;

// Transfer shielded tokens (private)
// Uses nullifiers to prevent double-spending
export circuit transferShielded(
  nullifier: Bytes<32>,           // Proves ownership without revealing identity
  newCommitment: Bytes<32>,       // New commitment for recipient
  proof: Bytes<32>                // ZK proof of valid transfer
): [] {
  // Verify nullifier hasn't been used
  assert(!nullifierUsed[nullifier], "Nullifier already spent");

  // Mark nullifier as used
  nullifierUsed[nullifier] = true;

  // Store new commitment
  shieldedCommitments[newCommitment] = newCommitment;
}

// ============================================
// SHIELD/UNSHIELD OPERATIONS
// ============================================

// Convert unshielded to shielded (public -> private)
export circuit shield(
  from: Bytes<32>,
  amount: Uint<64>,
  commitment: Bytes<32>
): [] {
  assert(unshieldedBalances[from] >= amount, "Insufficient balance");

  // Deduct from public balance
  unshieldedBalances[from] = unshieldedBalances[from] - amount;

  // Add to shielded pool
  shieldedCommitments[commitment] = commitment;
  totalShieldedSupply.increment(amount);
}

// Convert shielded to unshielded (private -> public)
export circuit unshield(
  nullifier: Bytes<32>,
  amount: Uint<64>,
  recipient: Bytes<32>,
  proof: Bytes<32>                // Proves ownership of shielded amount
): [] {
  assert(!nullifierUsed[nullifier], "Already unshielded");

  // Mark nullifier used
  nullifierUsed[nullifier] = true;

  // Add to public balance
  unshieldedBalances[recipient] = unshieldedBalances[recipient] + amount;
}
```

## TypeScript Integration

```typescript
// witnesses.ts for token vault
export type TokenPrivateState = {
  // Shielded balance (only owner knows)
  shieldedBalance: bigint;

  // Randomness for commitments
  balanceRandomness: string;

  // Transaction history (private)
  transactions: ShieldedTransaction[];
};

export type ShieldedTransaction = {
  type: 'mint' | 'transfer_in' | 'transfer_out' | 'shield' | 'unshield';
  amount: bigint;
  timestamp: number;
  commitment: string;
  nullifier?: string;
};

export const createPrivateState = (): TokenPrivateState => ({
  shieldedBalance: 0n,
  balanceRandomness: crypto.randomUUID(),
  transactions: [],
});
```

## When to Use Each Type

### Use Unshielded When:
- Public transparency is required (governance, treasuries)
- Lower transaction costs are needed
- Auditing/compliance requires visible balances
- Building public DEX/AMM pools

### Use Shielded When:
- User privacy is paramount
- Hiding transaction amounts
- Private payments
- Salary/compensation systems
- Healthcare/sensitive data tokens

### Use Shield/Unshield When:
- Users want to "exit" privacy for specific transactions
- Integrating with public DeFi protocols
- Tax reporting (unshield to show proof)
- On-ramping/off-ramping

## Best Practices

1. **Default to shielded** - Privacy by default, public by choice
2. **Use proper commitment schemes** - Don't use simple hashes in production
3. **Secure nullifier generation** - Must be deterministic but unpredictable
4. **Test edge cases** - Zero amounts, max values, double-spend attempts
5. **Consider gas costs** - Shielded operations cost more due to ZK proofs

## References

- [midnight-ledger/pull/142](https://github.com/midnightntwrk/midnight-ledger/pull/142) - Token vault implementation
- [Midnight Token Documentation](https://docs.midnight.network/tokens)
- [ZK Commitment Schemes](https://docs.midnight.network/concepts/commitments)
