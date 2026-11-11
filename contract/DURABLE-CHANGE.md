# Durable change capture and recovery backfill

The reference client can journal a shielded spend before submission, recover its
outcome after a restart, qualify its change, and publish the owner's recovery
entry. This is opt-in client behaviour for the pinned ledger-v9 stack. Existing
callers keep their existing behaviour. No Compact circuits or verifier keys
change.

## Configure durable operation

Keep the journal encryption key in the application's secret storage, separately
from its journal files. Reuse the same key and directory after restart. The
following example assumes an existing account and provider configuration:

```ts
import {
  CustodyAccount, createFileChangeJournalStore, createSdkChangeAdapter,
  emptyCoinStore,
} from './src/index.js';

const journalStore = await createFileChangeJournalStore({
  directory: privateJournalDirectory,
  encryptionKey: await secretStorage.loadJournalKey(), // 32 random bytes
});
const durableChanges = {
  networkId: configuredNetworkGenesisHash,
  journalStore,
  adapter: context => createSdkChangeAdapter({
    ...context,
    indexerUrl: configuredIndexerUrl,
    proofServerUrl: configuredTrustedProofServerUrl,
  }),
};
const account = await CustodyAccount.connect(
  providers, compiledContract, savedAddress, emptyCoinStore(),
  { privateStateId: savedPrivateStateId, durableChanges },
);

// Reconcile before choosing another input. This never resends the original spend.
const entries = await account.reconcileChanges(device);
const outcome = await account.withdrawShielded(
  device, recipient, colour, amount, selectedCoinId,
);
console.log(outcome.capture?.stage, outcome.capture?.recovery.status);
```

`connect` uses existing private state when the supplied stable identifier exists;
its initial state is used only when that identifier has no state. Durable mode
requires the identifier. New deployments accept `{ durableChanges }` in their
deployment options. Save the resulting address and `account.privateStateId` in
the wallet profile before using the account for durable spends. Scope also
includes the explicitly configured network identity. The caller must use
providers and endpoints for that same network.

The Node file store encrypts each snapshot with AES-256-GCM, authenticates its
scope, restricts directory/file permissions to the current user, writes a fresh
temporary file, flushes it, atomically renames it, and flushes the directory
before acknowledging success. A failed write can still have committed. Stop
the operation and reconcile from disk, rather than assuming rollback. These
guarantees rely on a local filesystem honouring flush and rename semantics.
There is no remote-filesystem or rollback-detection guarantee.
Journal replay and exact inbox lookup are linear in retained history. The file
store limits snapshots to 64 MiB and does not prune them automatically.

The journal contains private coin descriptions and recovery ciphertexts. Never
log or publish `changeJournal()` output. Back up the encryption key and journal
according to the wallet's recovery policy. The demonstration provider's fixed
private-state password is not suitable for production confidentiality; this
store deliberately has no default encryption key.

## What happens around submission

1. The client reserves the exact qualified input and saves the operation intent.
2. The adapter builds, proves, and balances without sending or committing the
   SDK's speculative private-state snapshot.
3. The journal saves the circuit's exact change and every identifier of the
   final balanced transaction, then saves a submission checkpoint.
4. Only then may that prepared transaction be submitted, once.
5. A finite indexer query checks an intersecting transaction identifier, the
   supported ledger era, and complete execution. Inclusion alone is insufficient.
6. The client checks each bounded candidate position against the actual change
   commitment using the prover's spend constraints at the receipt's block.
   Merely constructing an input at an occupied position is insufficient.
7. Confirmed input tombstones and qualified change merge into the current coin
   store, retaining siblings and newer spent markers.
8. Owner change receives a separately authorised recovery append. Its exact
   ciphertext and final transaction identifiers are journalled before sending.

The default adapter polls for up to 60 seconds after the submission provider
acknowledges the send, with HTTP requests bounded by that deadline. The submission
provider's own transport timeout is configured separately. Tune the adapter's
timeout and polling options for the supported environment. Expiry, transport failure, missing data, or a lost
acknowledgement means **unknown**, never proof of rejection. Qualification sends
private witnesses to the configured prover, so use a trusted local or controlled
service, as with ordinary proving.

## Outcome and restart behaviour

| Observed state | Behaviour |
|---|---|
| Preparation or prepared checkpoint only | No submission was authorised; reconciliation cancels the local attempt. |
| Submission checkpoint, no authoritative outcome | Keep the input reserved; observe again without rebuilding or resending. |
| Complete success | Qualify and adopt change, then complete or resume recovery publication. |
| Partial execution | Quarantine the attempt. Do not infer whether its input remains live. |
| Authoritative full rejection | Release this attempt; a later operation requires fresh preparation and authorisation. |
| Backfill acknowledgement lost | Search for the exact ciphertext first, then observe its recorded identifiers. Do not append again while its outcome is unresolved. |

If submission, qualification, storage, or backfill throws, inspect the saved
journal and call `reconcileChanges(device)` on the restored account. An error
does not imply that nothing happened on-chain. `DurableChangePendingError`
identifies a blocking journal entry. Ordinary transport and storage errors also
leave the durable checkpoints available for reconciliation.

High-level owner methods use their device to backfill after the spend. Methods
accepting a prebuilt authorisation cannot authorise a new append; use
`reconcileChanges(device)` subsequently. Repeated reconciliation replays
confirmed local adoption idempotently, including completed journal history,
because the journal can outlive a lost private-state write.

Grant circuits already append the caller-supplied change entry atomically when
change exists. Durable reconciliation adopts that exact entry and never adds a
second one. An owner viewing key can verify its plaintext against the actual
circuit result. Without that key, inclusion is recorded but decryptable recovery
remains explicitly unverified. A grantee must construct the correct change
entry; the circuit does not prove that opaque ciphertext contains its change.

## Supported concurrency and remaining boundaries

Use one writer process per wallet profile, a single durable journal for that
profile, and a dedicated SDK provider instance for the account. Same-process
account operations and journal scopes are guarded. Separate processes, direct
SDK calls, different profile identifiers, and third-party provider mutations do
not participate in those guards. There is no distributed lock or compare-and-swap.

An unresolved spend blocks further shielded spending through that durable
account. Do not bypass the journal through raw SDK calls or another client.
Private-state history is replayed chronologically, but the journal is not an
authoritative index of coins spent by other clients. Live/spent reconstruction
and partial-execution repair remain `CUST-03`.

Owner backfill is a second transaction. Losing both local stores and the journal
before it is recorded can still lose knowledge of change. Retaining the journal
allows that gap to be repaired; it does not make the gap atomic. Viewing-key
rotation must be coordinated with outstanding recovery publication, and an entry
that no longer matches the current recovery key must not be declared recoverable.

Direct contract-recipient payment composition remains subject to `DIRECT-01` in
the pinned SDK. The durable adapter does not bypass that assembly restriction or
claim that journalling fixes direct payment support. No contract migration is
required for these client changes.

## Validation

On 2026/11/11, all 93 dedicated offline tests, both live-prover controls, and all
four localnet phases below passed. Existing wallet and grant regressions and
the TypeScript build also passed. The localnet reused the unchanged full keyed
artefacts from 2026/11/10. No fresh key generation is claimed for this client change.

`npm run test:durable-change` exercises interruption boundaries, lost
acknowledgements, outcome distinctions, identity binding, idempotency, encrypted
storage reopening, exact-input retention, and generated-runtime account recovery.
Transport fixtures are separate from actual proof and node admission evidence.

`src/tests/change-qualification.ts` supplies live-prover positive and wrong
occupied-position controls. `src/tests/durable-change-localnet.ts` runs three
separate processes: `spend`, `backfill`, and `finish`, with the same private
fixture directory. It injects acknowledgement loss after actual submission,
reopens the journal, avoids duplicate append, preserves a same-colour sibling,
and spends the recovered change later. It is restricted to loopback services
and the documented public development wallet.

```sh
node --import tsx src/tests/durable-change-localnet.ts spend /private/test-directory
node --import tsx src/tests/durable-change-localnet.ts backfill /private/test-directory
node --import tsx src/tests/durable-change-localnet.ts finish /private/test-directory
node --import tsx src/tests/durable-change-localnet.ts grant /private/test-directory
```

The optional fourth phase checks grant change publication in the same spend
transaction, with no additional append on reconciliation. Run the separate
prover controls with
`PROOF_SERVER_URL=http://127.0.0.1:6300 npm run test:change-qualification`.

The fixture directory contains test secrets and must remain private. These
scenarios are bounded regression evidence, not complete MIP conformance or an
independent security audit.
