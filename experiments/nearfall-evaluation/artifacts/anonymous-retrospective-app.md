# 🤖👱 Anonymous Retrospective App: Preprod Design

A Midnight smart contract for team retrospectives in which participants privately submit observations, all observations are revealed simultaneously, and no observation is attributed to its author.

## Privacy Requirements

| Requirement | Strength needed |
|---|---|
| Observation content hidden before reveal | Strong — no participant sees others' content early |
| Observation content hidden from non-participants permanently | Strong — view-key encryption |
| Participation hidden | Weak — everyone knows who is in the retro |
| Authorship of each observation hidden | Strong — the core anonymity requirement |

The key insight is that **participation is public but authorship is not**. This is a narrower requirement than full anonymity, and it enables a substantially simpler design.

## Protocol Overview

The protocol has four phases:

```
Setup ──► Commit (main addresses) ──► Reveal (fresh addresses) ──► View (local decrypt)
```

### Phase 0: Setup

Before the contract is deployed:

1. **View key**: The organiser generates (or participants collectively derive) a symmetric view key `K`. `K` is shared with all authorised participants out-of-band (e.g., in the kickoff meeting).
2. **Contract deployment**: The organiser deploys the contract, recording the list of authorised participant addresses and a submission deadline.

### Phase 1: Commit (from main addresses)

Each participant locally encrypts their observation and submits a commitment:

```
nonce      = random()
ciphertext = AES-GCM(K, observation, nonce)
blinding   = random()
commitment = hash(ciphertext ‖ blinding)
```

The participant submits `commitment` from their **main address**. The contract records `main_address → commitment`.

This phase is public in the sense that observers can see who has committed, but the ciphertext and plaintext are never on-chain at this point.

### Phase 2: Reveal (from fresh disposable addresses)

When all N participants have committed, or the deadline passes, the contract transitions to the reveal phase.

Each participant:

1. **Generates a fresh keypair** with no prior on-chain history.
2. **Funds it from the preprod faucet** — this avoids any on-chain link between the fresh address and the participant's main address.
3. **Submits the reveal** from the fresh address:

```
submit from fresh_address: (ciphertext, blinding)
```

The contract verifies:

```
hash(ciphertext ‖ blinding) ∈ unrevealed_commitments
```

It marks the matched commitment as revealed and appends `ciphertext` to the public observation list.

Because there is no on-chain link between `main_address` and `fresh_address`, the mapping from participant to observation is hidden.

### Phase 3: View (local decryption)

After all commitments are revealed, or a second deadline passes, the contract enters the complete phase. The full list of ciphertexts is publicly accessible.

Any holder of `K` decrypts each entry locally:

```
observation = AES-GCM-Decrypt(K, ciphertext, nonce)
```

Participants without `K` see only opaque ciphertexts.

## Contract Sketch (Compact pseudocode)

```compact
ledger phase: Cell<Phase>;              // Collecting | Revealing | Complete
ledger authorized: Set<Address>;        // main addresses of participants
ledger commitments: Map<Bytes32, Bool>; // commitment → revealed flag
ledger observations: Vector<Bytes>;     // ciphertexts in reveal order
ledger expected_count: Cell<Uint32>;
ledger deadline_commit: Cell<BlockHeight>;
ledger deadline_reveal: Cell<BlockHeight>;

// Phase 1: submit commitment (from main address)
circuit commit(commitment: Bytes32) {
  assert phase.read() == Collecting;
  assert authorized.member(caller());
  assert !commitments.contains_key(commitment);
  commitments.insert(commitment, false);
  if commitments.size() == expected_count.read() {
    phase.write(Revealing);
  }
}

// Phase 2: reveal ciphertext (from any address — typically fresh)
circuit reveal(ciphertext: Bytes, blinding: Bytes32) {
  assert phase.read() == Revealing;
  const com = hash(ciphertext ++ blinding);
  assert commitments.get(com) == Some(false);   // exists, not yet revealed
  commitments.set(com, true);
  observations.push(ciphertext);
  if all_revealed(commitments) {
    phase.write(Complete);
  }
}

// Organiser can advance phase after deadline
circuit advance_phase() {
  match phase.read() {
    Collecting if block_height() > deadline_commit.read() =>
      phase.write(Revealing),
    Revealing if block_height() > deadline_reveal.read() =>
      phase.write(Complete),
    _ => assert false,
  }
}
```

## Simplifications vs. the Full ZK Design

A fully adversarial design would require ZK proofs of anonymous group membership (nullifier-based), shielded transactions, and ZK-friendly encryption circuits. None of these are needed here because:

| Dropped mechanism | Reason safe to drop |
|---|---|
| ZK membership proofs | Participation is public; commits from main addresses are fine |
| Nullifiers | Main address already enforces one commit per participant |
| Shielded transactions | Fresh address + faucet funding achieves equivalent unlinkability |
| ZK proof of correct encryption | Encrypt-then-commit means contract verifies commitment to ciphertext, not plaintext — no circuit needed |

## Residual Risks

| Risk | Likelihood for a cooperative retro | Mitigation |
|---|---|---|
| Timing correlation (fresh address funded/used immediately before reveal) | Low | Use faucet well before the reveal window; don't fund and reveal in the same block |
| Writing style or content deanonymisation | Social | Acknowledge this limitation to participants |
| Commitment ordering reveals submission sequence | Low | Reveal order is determined by who acts first in Phase 2, not Phase 1; can be ignored or randomised off-chain |
| View key compromise | Low for a retro | Rotate K per session; distribute only to current team |
| Partial reveal (one participant withholds) | Possible | Second deadline in `advance_phase` closes the session; unrevealed observations are lost |

## Deployment Notes (Preprod)

- **Faucet**: Use the Midnight preprod faucet to fund fresh addresses; this is the key operational step that makes the fresh-address approach practical.
- **Fresh keypair generation**: Standard Midnight wallet tooling; treat the keypair as ephemeral and discard after the reveal transaction confirms.
- **View key `K`**: A 256-bit random key is sufficient. AES-256-GCM is recommended. The nonce must be unique per observation; prepend it to the ciphertext for storage.
- **Network**: Midnight preprod (`preprod`).

## Sources

*This document is an original design synthesised from a design conversation; no external sources are cited. For Midnight contract language reference, see the [Compact language documentation](https://docs.midnight.network) and the Midnight preprod developer resources.*
