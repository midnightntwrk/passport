# First-time account creation

A new bearer creates their Passport for the first time: a passkey becomes
the first device of a fresh on-chain account contract. This is the entry
point to every other flow.

**Preconditions.** The bearer has a device with a platform authenticator
(Touch ID, Windows Hello, Android) or a PRF-capable security key. They
hold no funds and no existing account.

**Postcondition.** An account-custody contract exists on the ledger,
holding no assets yet, whose sole active device is the passkey just
created and whose recovery commitment is set. The bearer can now
receive funds, add devices, issue grants, and enrol guardians.

Account creation is a two-step ceremony by construction: the deploy
plants a salted commitment to the first device, and a follow-up
activation call installs the device entry. The split is not an
implementation convenience — a contract's address is derived from the
content of its deploy transaction, so no deploy-time code can compute
a value bound to its own address. MIP-0013 section 3 makes this
bootstrap normative.

## Participants

- **Bearer** — the person creating the account.
- **Passkey authenticator** — the platform authenticator that holds the
  passkey and gates it behind a biometric or PIN. It exposes a WebAuthn
  PRF that returns a stable per-credential secret.
- **Passport client** — the wallet application (browser or native) that
  drives the ceremony and builds transactions.
- **ZK prover** — generates the zero-knowledge proof the deploy requires;
  in-browser (WASM) or a remote prover.
- **Midnight ledger** — the node and chain that instantiate the contract.

## Diagram

```mermaid
sequenceDiagram
    autonumber
    actor Bearer
    participant Auth as Passkey authenticator
    participant Client as Passport client
    participant Prover as ZK prover
    participant Ledger as Midnight ledger

    Bearer->>Client: Create a passport
    Client->>Auth: WebAuthn create credential (PRF extension)
    Auth-->>Bearer: Biometric / PIN prompt
    Bearer-->>Auth: Approve
    Auth-->>Client: Credential (public key, credential id)

    Client->>Auth: WebAuthn assertion, evaluate PRF(salt)
    Auth-->>Bearer: Biometric / PIN prompt
    Bearer-->>Auth: Approve
    Auth-->>Client: PRF output (32 bytes)

    Note over Client: device key ← derived from the PRF output<br/>(the device public key pk registers on-chain;<br/>the private half is re-derived from the passkey on each use, never stored)
    Note over Client: recovery_secret ← fresh random<br/>recovery_commitment = commit(recovery_secret)<br/>No guardians yet. Enrolment is a later flow.
    Note over Client: salt ← fresh random<br/>boot_commitment = persistentHash([DST_BOOT, salt, pk])

    Client->>Prover: Build deploy tx from constructor(boot_commitment, recovery_commitment), then prove
    Prover-->>Client: Deploy proof

    Note over Client,Ledger: A brand-new account holds no Dust.<br/>Both transactions are submitted through a fee sponsor (C24).
    Client->>Ledger: Submit contract deploy
    Ledger->>Ledger: Instantiate account contract<br/>round = 0, device_epoch = 0,<br/>devices = {} (empty), boot = boot_commitment,<br/>recovery = recovery_commitment
    Ledger-->>Client: Contract address

    Client->>Prover: Build activate_initial_device(pk, salt), then prove
    Prover-->>Client: Activation proof
    Client->>Ledger: Submit activation call
    Ledger->>Ledger: Check persistentHash([DST_BOOT, salt, pk]) == boot<br/>Insert device entry for pk at epoch 0, use counter 0<br/>Burn the boot commitment

    Note over Client: Persist: contract address + credential id.<br/>The device private key and the recovery secret never reach the ledger.
    Client-->>Bearer: Passport ready (account address)
```

## Narrative

1. The bearer asks the client to create a passport.
2-5. The client creates a WebAuthn credential with the PRF extension. The
   authenticator gates it behind a biometric or PIN, and returns the
   credential (its public key and credential id).
6-9. The client evaluates the credential's PRF at a fixed salt, again
   behind a biometric or PIN, and receives a 32-byte PRF output. (Some
   platforms return the PRF output at creation time, folding these steps
   into the previous ones.)
10. The client derives the **device key** from the PRF output. The
    private half is never written to disk: it is re-derived from the
    passkey whenever a later flow needs to authorise a call.
11. The client generates a fresh **recovery secret** and its commitment.
    No guardians are enrolled at this point; guardian enrolment is a
    separate ceremony. Setting the commitment now means recovery is
    anchored from the account's birth.
12. The client draws a fresh **salt** and computes the **boot
    commitment**, a domain-separated hash binding the salt and the
    device public key. The salt keeps pre-activation ledger state free
    of values that would be stable for the same key across accounts.
13-14. The client builds the deploy transaction, whose constructor
    takes the boot commitment and the recovery commitment, and asks the
    prover to produce the deploy proof.
15. Because a brand-new account holds no Dust, the deploy is submitted
    through a fee sponsor rather than paid by the bearer (the sponsored
    zero-token onboarding of C24, confirmed to cover contract
    deployment).
16-17. The ledger instantiates the account contract at a fresh address:
    round and device epoch at zero, an **empty** device set, the boot
    commitment, and the recovery commitment. The constructor cannot
    register the device entry itself — the entry is bound to the
    contract's own address, which no deploy-time code can know.
18-21. The client calls the permissionless **`activate_initial_device`**
    circuit with the device public key and the salt. The contract checks
    the pair against the boot commitment, inserts the device entry at
    epoch zero and use counter zero, and burns the commitment. The call
    is deterministic in the committed key, so it cannot be front-run to
    a different device.
22. The client persists the contract address and the credential id. The
    device private key and the recovery secret stay on the bearer's
    device.
23. The passport is ready; the client reports the account address.

## Properties this flow establishes

- **The ledger only ever sees commitments.** The device private key is a
  witness to future proofs, never a ledger value. An observer of the
  deploy learns a salted boot commitment and a recovery commitment;
  after activation, a device entry that is itself a domain-separated
  hash. None of them reveals the underlying key material, and the salt
  keeps pre-activation state unlinkable across accounts using the same
  key.
- **The authenticator holds the root of authority.** Control of the
  account reduces to the ability to evaluate the passkey PRF, which the
  authenticator gates behind user verification. Nothing the client stores
  is sufficient to authorise on its own.
- **Recovery is anchored at birth.** The recovery commitment is set in the
  constructor, so an account is never in a state where it cannot later be
  recovered; only the guardian set is added later.
- **The authentication scheme is a seam.** The contract checks device
  authority through one internal seam. The standard instantiates it with
  in-circuit JubJub Schnorr (C5, MIP-0013); the earlier prototype's
  hash-preimage check satisfied the same seam, which is why the
  replacement changed no other circuit and does not change this flow.
- **Onboarding needs no pre-funding.** Fee sponsorship removes the
  bootstrap paradox of needing funds to create the account that will hold
  funds.

## Prototype and reference-implementation note

The reference implementation (`contract/`) realises this flow exactly
as drawn: the MIP-0013 section 3 bootstrap (boot commitment in the
constructor, `activate_initial_device` installing the epoch-0 entry) is
exercised by its conformance suite, and device authority is the
in-circuit JubJub Schnorr seam of MIP-0013 rather than a preimage
check.

The earlier account-custody prototype predates the bootstrap: its
constructor registered a device commitment directly
(`constructor(initial_device_commitment, recovery_commitment)`) and its
seam checked hash-preimage knowledge — both expressly shaped for the
standard to replace, as it since has. The prototype also used
`transientHash` (Poseidon) for commitments where the standard uses
domain-separated `persistentHash` (a recorded prototype caveat). In the
prototype's demo onboarding script a random 32-byte device secret saved
to `owner-identity.json` stands in for the passkey PRF derivation,
whereas the demo app performs the real WebAuthn PRF ceremony shown
above.

## References

- Standards: MIP-0012 (contract custody), MIP-0013 (account
  authorisation; section 3 fixes the bootstrap this flow draws).
- Components: C1 (account-custody contract), C5 (signing primitive / the
  authentication seam), C9 (device-bound authentication), C14 (total-loss
  recovery), C24 (fee sponsorship / zero-token onboarding).
- Reference implementation: `contract/` (`contracts/account.compact`,
  `src/tests/auth-conformance.ts` for the bootstrap test).
- Prototype: `experiments/account-custody-prototype/` (historical
  evidence base).
