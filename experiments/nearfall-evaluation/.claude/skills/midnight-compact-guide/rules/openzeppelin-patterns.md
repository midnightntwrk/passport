# OpenZeppelin Contracts for Compact

> **Official Documentation**: https://docs.openzeppelin.com/contracts-compact
> **GitHub Repository**: https://github.com/OpenZeppelin/compact-contracts

The official OpenZeppelin library for Midnight smart contracts provides battle-tested, audited implementations of common patterns.

## Installation

```bash
npm install @openzeppelin/compact-contracts
```

---

## Available Modules

### Token Standards
- **FungibleToken** - Privacy-preserving token with shielded balances
- **NFT** - Non-fungible tokens with optional privacy

### Access Control
- **Ownable** - Single-owner access pattern
- **Roles** - Role-based access control
- **AccessControl** - Flexible permission system

### Security
- **Pausable** - Emergency stop mechanism
- **ReentrancyGuard** - Prevent reentrancy attacks

---

## Ownable

Simple single-owner access control.

```compact
pragma language_version >= 0.19;

import CompactStandardLibrary;

export ledger owner: Bytes<32>;

witness local_secret_key(): Bytes<32>;

circuit get_caller(): Bytes<32> {
  const sk = local_secret_key();
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "owner:pk:"), sk]);
}

circuit assertOnlyOwner(): [] {
  const caller = get_caller();
  assert(disclose(caller == owner), "Ownable: caller is not owner");
}

export circuit transferOwnership(newOwner: Bytes<32>): [] {
  assertOnlyOwner();
  owner = disclose(newOwner);
}

export circuit adminFunction(): [] {
  assertOnlyOwner();
  // Only owner can execute this
}
```

---

## Role-Based Access Control

For more complex permission systems.

```compact
pragma language_version >= 0.19;

import CompactStandardLibrary;

// Role definitions (use hashes as role IDs)
export ledger adminRole: Bytes<32>;
export ledger minterRole: Bytes<32>;

// Role membership
export ledger roles: Map<Bytes<32>, Map<Bytes<32>, Boolean>>;

witness local_secret_key(): Bytes<32>;

circuit get_caller(): Bytes<32> {
  const sk = local_secret_key();
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "rbac:pk:"), sk]);
}

circuit hasRole(role: Bytes<32>, account: Bytes<32>): Boolean {
  const roleMembers = roles.lookup(role);
  return roleMembers.member(account);
}

circuit assertHasRole(role: Bytes<32>): [] {
  const caller = get_caller();
  assert(disclose(hasRole(role, caller)), "AccessControl: missing role");
}

export circuit grantRole(role: Bytes<32>, account: Bytes<32>): [] {
  assertHasRole(adminRole);
  roles.lookup(role).insert(account, true);
}

export circuit revokeRole(role: Bytes<32>, account: Bytes<32>): [] {
  assertHasRole(adminRole);
  roles.lookup(role).remove(account);
}

export circuit mint(to: Bytes<32>, amount: Field): [] {
  assertHasRole(minterRole);
  // Mint tokens to 'to'
}
```

---

## Pausable

Emergency stop mechanism for contracts.

```compact
pragma language_version >= 0.19;

import CompactStandardLibrary;

export ledger paused: Boolean;
export ledger owner: Bytes<32>;

witness local_secret_key(): Bytes<32>;

circuit get_caller(): Bytes<32> {
  const sk = local_secret_key();
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "pause:pk:"), sk]);
}

circuit assertNotPaused(): [] {
  assert(disclose(!paused), "Pausable: contract is paused");
}

circuit assertOnlyOwner(): [] {
  const caller = get_caller();
  assert(disclose(caller == owner), "Ownable: caller is not owner");
}

export circuit pause(): [] {
  assertOnlyOwner();
  paused = true;
}

export circuit unpause(): [] {
  assertOnlyOwner();
  paused = false;
}

export circuit transfer(to: Bytes<32>, amount: Uint<64>): [] {
  assertNotPaused();
  // Transfer logic
}
```

### When to Use Pausable

- Token contracts handling real value
- DeFi protocols with liquidity
- Contracts with upgrade mechanisms
- Any contract where bugs could cause fund loss

---

## Combining Patterns

```compact
pragma language_version >= 0.19;

import CompactStandardLibrary;

// State
export ledger owner: Bytes<32>;
export ledger paused: Boolean;
export ledger balances: Map<Bytes<32>, Uint<64>>;

witness local_secret_key(): Bytes<32>;

circuit get_caller(): Bytes<32> {
  const sk = local_secret_key();
  return persistentHash<Vector<2, Bytes<32>>>([pad(32, "combo:pk:"), sk]);
}

circuit assertOnlyOwner(): [] {
  const caller = get_caller();
  assert(disclose(caller == owner), "Not owner");
}

circuit assertNotPaused(): [] {
  assert(disclose(!paused), "Paused");
}

// Combined check
export circuit criticalFunction(): [] {
  assertOnlyOwner();
  assertNotPaused();
  // Execute critical logic
}

export circuit pause(): [] {
  assertOnlyOwner();
  paused = true;
}

export circuit unpause(): [] {
  assertOnlyOwner();
  paused = false;
}
```

---

## Best Practices

1. **Always use audited contracts** - Don't reinvent token standards
2. **Combine patterns** - Ownable + FungibleToken + Pausable
3. **Check for updates** - Security patches are released regularly
4. **Read the docs** - Each module has specific usage patterns
5. **Test pause scenarios** thoroughly
6. **Document pause conditions** for users
7. **Consider timelock** for unpause in high-value contracts

---

## Important Notes

1. **No approval mechanism** - Unlike ERC20, transfers are direct
2. **Balances are commitments** - Not stored as plain values
3. **Privacy by default** - Explicit disclosure required to reveal
