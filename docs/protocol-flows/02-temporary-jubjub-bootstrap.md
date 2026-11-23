# Proposed account creation with temporary Jubjub authority

**Proposed, not implemented.** This flow accompanies the
[local MIP-0013 amendment](../mps-mip/mips/mip-0013-temporary-jubjub-bootstrap-amendment.md)
for [Passport #212](https://github.com/midnightntwrk/passport/issues/212).
Its pinned specification and reference-code baselines are recorded there.
It does not replace the [historical reference flow](01-first-account-creation.md)
or claim the implementation/evidence required by
[#213](https://github.com/midnightntwrk/passport/issues/213).

The outcome is an account whose **first installed device is the passkey**,
registered with the account address as `user.id`. The temporary Jubjub key
only authorises this installation; it is never enrolled as a device.

## Preconditions and participants

- **Bearer:** approves passkey creation and use.
- **Client / local signer:** verifies network/artifact configuration, holds
  the temporary private key, and manages durable onboarding metadata.
- **Authenticator:** creates the ES256 credential and signs its WebAuthn
  proof of possession. It never receives the temporary Jubjub key.
- **Prover:** proves activation from public-key/policy inputs and signatures,
  without either signing private key. It may be local or delegated under
  the privacy/trust assumptions of the amendment.
- **Ledger:** records deployment and verifies activation/recovery transitions.

The client needs a supported profile-1 RP/origin, a verified chain-instance
configuration, complete target artifacts, independent viewing and retained
recovery material, and a real fee-funding/sponsorship path. The bounded
21-byte-origin profile is not general WebAuthn browser compatibility.

## Sequence

```mermaid
sequenceDiagram
    autonumber
    actor Bearer
    participant Auth as Authenticator
    participant Client as Client / local signer
    participant Prover
    participant Ledger

    Bearer->>Client: Create account
    Client->>Client: Verify network configuration; generate temporary b,Q
    Note over Client: Prepare viewing/recovery inputs independently of passkey<br/>Commit Q, network and predetermined policy into B<br/>Protect onboarding record locally
    Client->>Client: Run constructor locally (no constructor ZK proof)
    Client->>Ledger: Fund and deploy; finish verifier installation waves
    Ledger-->>Client: Confirm address A, initial state and verifier roster
    Client->>Client: Check trusted artifacts, B, network, maintenance posture
    Client->>Auth: Create ES256 passkey with user.id = raw 32 bytes of A
    Auth-->>Bearer: Request approval
    Bearer-->>Auth: Approve
    Auth-->>Client: Public key and credential metadata
    Client->>Client: Persist credential metadata; recompute activation intent I
    Client->>Auth: Get assertion for domain-separated proof-of-possession challenge
    Auth-->>Bearer: Require user verification
    Bearer-->>Auth: Approve
    Auth-->>Client: WebAuthn assertion under the agreed policy
    Client->>Client: Check assertion; sign I locally with temporary Jubjub key
    Client->>Prover: Q, target key/policy, Jubjub signature and WebAuthn assertion
    Note over Client,Prover: Neither temporary scalar b nor passkey private key is sent
    Prover-->>Client: Activation proof
    Client->>Ledger: Fund and submit activate_initial_passkey
    Ledger->>Ledger: Check dormant mode, commitment and both signatures<br/>Install epoch-0/counter-0 passkey entry<br/>Set booted, clear B, increment round once
    Ledger-->>Client: Confirmed state transition
    Client->>Client: Verify intended device installed; erase temporary key
    Client-->>Bearer: Account active; report actual recovery readiness
```

Wallet balancing and fee proofs are separate from constructor execution and
the contract's activation proof. The diagram's deployment step does not
promise that creation, verifier installation and activation fit one transaction.

## What is signed and enforced

The amendment's typed recipes are authoritative. Both signatures bind one
activation intent containing account address, stored bootstrap commitment,
configured network domain, target public key and complete profile/policy,
with the fixed initial epoch/nonce. The circuit recomputes the intent and
device entry; the prover cannot supply unchecked replacements.

The temporary Jubjub signature authorises the target; the WebAuthn assertion
proves target-key possession. The assertion's RP hash, exact origin, challenge,
UP/UV flags and complete accepted JSON shape are verified in-circuit. Neither
hardware attestation nor correctness of the registered `user.id` follows from
that assertion: the SDK sets the user handle during registration and treats
its later return as a locator, not authority.

Network configuration is checked by the client and bound by the circuit.
The current kernel does not authenticate the chain identity to the contract;
an identical-state clone with an identical configured domain remains outside
the circuit's replay guarantee. The client must verify the intended chain
instance and the actual deployed verifier relations before approving.

## Durable checkpoints and interruption

| Checkpoint | Persist / next action |
|---|---|
| Before deployment | Protect temporary keypair (`b` and `Q`), exact commitment and committed policy/network configuration, viewing/recovery material and intended artifact identity. |
| Deployment submitted | Retain transaction identity; discover its confirmed outcome before retrying. Complete verifier waves and verify the returned address/state. |
| Credential created | Immediately persist credential ID, public key, RP/origin, network and account mapping; resume this credential rather than silently registering another. |
| Activation approved/submitted | Protect the exact intent, temporary signature, available assertion/proof and transaction identity. Inspect state before retrying; retain the same dormant account and target. |
| Intended activation confirmed | Verify the installed entry and consumed boot state; erase the temporary key, retain device/viewing/recovery metadata. |
| Recovery consumed bootstrap | Stop activation retries, erase temporary key, and resume the recovery/device flow rather than claiming initial-passkey activation succeeded. |

If the temporary key is lost while the account is dormant, a retained valid
temporary signature may still authorise the exact approved target; the passkey
can supply its assertion without that key. If neither the key nor usable
approval remains, the passkey and public commitment cannot replace them. Use
independent usable recovery, or abandon that deployment and create a new
account. There is no timeout takeover.
If there are funds and neither activation nor recovery is possible, report
the loss of access explicitly. Do not label the current reference's discarded
birth-secret default as a recoverable account.

## Recovery and concurrent activity

Permissionless deposits and inbox changes may advance `round`; they do not
invalidate the signed activation intent. Two competing activations cannot
both commit. A failed activation preserves all state.

Recovery may already be pending. Activation preserves its record and deadline;
the newly installed device may exercise the existing veto. If recovery is not
vetoed, it may still finalise and retire that device. If recovery finalises
first, it sets `booted` and clears the commitment, making all prepared bootstrap
approvals unusable. The temporary key cannot veto recovery or reopen bootstrap.

## Validation hand-off

The amendment's B01–B13 matrix is the acceptance baseline for #213: typed
vectors and independent signing, private-input inspection, adversarial and
recovery/race tests, actual proofs/on-node execution, and new circuit-size and
proving measurements. This diagram supplies no measured `k` or latency.
After those results reconcile with the draft, #214 takes the change upstream.
