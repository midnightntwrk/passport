# Midnight Passport SDK Roadmap

**Status:** Proposed implementation sequence

## Outcome

Deliver a provider-independent Passport SDK that a wallet or dApp can embed
without importing the reference UI or prototype code. Each phase is small
enough to review independently and has an observable exit criterion.

## Current foundation

The repository already contains the first vertical slice:

- a standalone `@midnight-ntwrk/passport-sdk` workspace;
- typed app/account state scopes;
- encrypted private-state CRUD;
- in-memory and IndexedDB encrypted-record adapters;
- WebAuthn PRF enrollment and unlock;
- typed state injection at a Midnight join/deploy boundary;
- unit coverage for encryption, isolation, wrong keys, malformed versions,
  cancellation, and operation-scoped key reuse;
- a capability boundary that refuses to present an unconfigured external
  settlement route as complete.

This is a useful foundation, not a production release. Browser integration,
contract integration, migrations, error typing, and security review remain.

## Delivery sequence

### 1. Stabilize the storage core

**Deliverables**

- Freeze `PassportStateScope`, store, key-provider, and injection interfaces.
- Add structured `PassportError` codes and preserve underlying causes.
- Add envelope metadata required for migrations without exposing scope data.
- Define atomic write and corruption-recovery behavior for IndexedDB.
- Add a conformance suite that any browser or native storage adapter can run.
- Write the private-state threat model and an ADR for WebAuthn PRF + AES-GCM.

**Exit criteria**

- Unit and browser tests pass on the supported browser matrix.
- Persisted records and captured logs contain no plaintext test markers.
- Wrong origin, wrong account, wrong passkey, and old envelope versions fail
  closed with distinct errors.

### 2. Add the C1 account module

**Deliverables**

- Define `PassportAccountAdapter` for deploy, find, read version, and submit.
- Load private state before constructing the Compact contract providers.
- Return a transaction lifecycle: prepared, awaiting approval, submitted,
  confirmed, failed.
- Confirm deployment by reading the expected C1 state from Midnight.
- Define behavior for missing or lost local private state.

**Exit criteria**

- A fresh browser session deploys a C1 account on localnet through the SDK.
- Reloading joins the same contract after one explicit device unlock.
- Deleting private state produces a recoverable, accurate error rather than a
  new account or simulated success.

### 3. Normalize Midnight wallet capabilities

**Deliverables**

- Define a provider-neutral `MidnightWalletAdapter`.
- Expose unshielded, shielded, and DUST address surfaces independently.
- Expose synchronization state and separate balance pools.
- Model message signing and supported transfers as explicit capabilities.
- Implement one provider adapter without importing it into SDK core.

**Exit criteria**

- Adapter conformance tests return all three address surfaces.
- Signing and each supported transfer path show user approval and a real
  transaction result.
- Missing provider features return `blocked` or `unsupported`, never empty
  success objects.

### 4. Move the reference demo onto SDK-only APIs

**Deliverables**

- Remove direct imports from `experiments/account-custody-prototype/`.
- Use the account, wallet, and private-state modules for onboarding and return.
- Display chain-confirmed state separately from local pending state.
- Keep developer diagnostics behind a deliberate debug surface.

**Exit criteria**

- The demo can be replaced by a second minimal client without changing SDK
  internals.
- Browser E2E covers create, reload, unlock, address copy, signing, transfer,
  and transaction detail.

### 5. Add permissions and dApp connection

**Deliverables**

- Define request, consent, grant, denial, revocation, and expiry types.
- Map dApp requests to C10/C11 grant scopes.
- Add transport as an adapter so injected and relayed connections share the
  same domain model.
- Verify effective permission state from chain data.

**Exit criteria**

- A sample dApp requests a narrow permission, the user approves it, and an
  out-of-scope operation is rejected by contract enforcement.
- Revocation is visible to both wallet and dApp after chain confirmation.

### 6. Add identity and device lifecycle

**Deliverables**

- Add authoritative name resolution and account-binding interfaces.
- Add device enrollment, listing, and revocation.
- Add recovery interfaces only after the contract and cryptographic mechanism
  are approved.
- Keep authentication recovery and cryptographic account recovery distinct.

**Exit criteria**

- Name uniqueness, account binding, device revocation, and recovery behavior
  pass localnet integration tests and threat-model review.

### 7. Add external integrations through adapters

**Deliverables**

- Publish adapter requirements and capability negotiation.
- Integrate only deployed, versioned endpoints and contracts.
- Bind settlement requests and confirmations to the originating Passport
  operation.
- Document timeout, retry, partial-settlement, and recovery semantics.

**Exit criteria**

- End-to-end tests use real configured infrastructure.
- Every completion state is backed by a verifiable transaction or contract
  state transition.
- Removing one external adapter does not prevent core Passport operation.

## Recommended pull-request boundaries

| PR | Scope | Review focus |
|---|---|---|
| 1 | Architecture, public API inventory, error taxonomy | Ownership and dependency direction |
| 2 | Storage migrations and adapter conformance tests | Encryption and data-loss behavior |
| 3 | Browser passkey + IndexedDB E2E | Origin, cancellation, reload, account switching |
| 4 | C1 account adapter and localnet integration | Witness boundary and chain finality |
| 5 | Wallet adapter and first provider implementation | Three surfaces and capability accuracy |
| 6 | Demo migration | SDK/UI separation and honest status presentation |
| 7 | Permission protocol | Scope enforcement and revocation |

## Work that should remain separate

- UI redesign and visual assets belong to the example application.
- Contract experiments remain under `experiments/` until their APIs and threat
  models are approved.
- Cloud synchronization waits for key rotation, recovery, and portability
  design.
- Cross-chain settlement waits behind its adapter until deployed dependencies
  and failure semantics are stable.
- Native platform adapters follow the browser conformance suite rather than
  introducing a second domain model.

## Immediate next actions

1. Review and accept the architecture boundaries.
2. Add the error taxonomy and storage-adapter conformance suite.
3. Write the WebAuthn PRF private-state ADR and threat model.
4. Run real-browser persistence tests on the supported browser matrix.
5. Specify `PassportAccountAdapter` from the existing C1 localnet behavior.
6. Migrate one deploy-and-rejoin path from the prototype into an SDK
   integration test.

These actions complete the storage foundation before broadening the SDK into
wallet, permission, identity, or external-settlement features.
