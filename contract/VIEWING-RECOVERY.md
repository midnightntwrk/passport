# Restoring current viewing capability

Client implementation dated 2026/11/11, addressing `REC-WRAP-001` and
`REC-WALLET-001`. Recovery of signing authority, possession of the current
viewing key, and a current guardian backup are three separate outcomes. This
client exposes them separately and requires explicit persistent storage before
acknowledging a restored viewing key. No circuit migration is required.

The implementation follows the current
[MIP-0022 recovery lifecycle](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/4a85a87b4e4c5d59ee88a5786a8ecb11f5dc5c6f/mips/mip-0022-account-recovery.md),
particularly the fresh-session rule in §5 and persistence before disposal of the
recovery secret in §6. It composes with
[chain-verified holdings reconstruction](CHAIN-RECOVERY.md) and
[durable change capture](DURABLE-CHANGE.md).

## Read the status before promising recovery

`await account.viewingRecoveryStatus()` returns public diagnostic information:

| Field | Values | Meaning |
|---|---|---|
| `localKey` | `current`, `missing`, `stale` | Whether the private profile contains a secret whose derived X25519 public key matches current `enc_key`. |
| `wrap` | `verified-current` | This client verified the exact current artefact set against the current viewing public key. |
| `wrap` | `known-stale` | A recorded verification no longer matches the viewing public key, or this client conservatively invalidated it before a rotation attempt. |
| `wrap` | `unknown` | No matching local verification history establishes freshness. Opaque ciphertext alone cannot do so. |
| `wrap` | `absent` | No public recovery vector or wrap is present. Finalisation clears the vector even though old ciphertext remains. |
| `pendingRecovery` | `true`, `false` | Whether authority recovery is still pending; a current viewing key does not finish that process. |

Verification history is trusted local profile metadata, bound to the exact
artefact set and viewing public key. It is not a proof against malicious edits
to that profile, an independent audit of guardian delivery, or a guarantee about
future chain changes. A fresh profile may correctly report `unknown` for a
usable wrap until it verifies it.

## Restore from the supported guardian inputs

This client accepts indexed BUSS shares supplied through an external
authenticated channel. The caller provides `n`, `t`, and distinct indices in
`1..n`; reconstruction requires at least `t + 1` shares. The supported reference
profile limits `n` to 32 and requires `n - t` to fit the contract's one to four
public vector slots. Canonical field values, indices, quorum, the public vector,
and the reconstructed recovery public key are checked before opening the wrap.
The localnet fixture uses Profile C paper-key-derived shares. It does not provide
guardian transport, guardian identity authentication, or a browser ceremony.
Reconstruction uses the first `t + 1` supplied shares after validating all input
encodings and indices. It does not search alternate subsets or establish the
consistency of surplus shares. If that quorum fails, the caller can select a
different authenticated quorum and retry.

```ts
import { createFileViewingKeyStore } from './src/index.js';

const store = await createFileViewingKeyStore({
  directory: privateVaultDirectory,
  encryptionKey: vaultEncryptionKey, // caller-managed random 32 bytes
});
const result = await account.restoreViewingKeyFromGuardians(
  { n: 3, t: 1, shares: [firstGuardianShare, thirdGuardianShare] },
  { networkId, store },
);
```

`restoreViewingKey(secretBytes, options)` accepts an already reconstructed
canonical recovery secret. Both forms authenticate the wrap and compare the
recovered X25519 public key with the current ledger key. A correctly decrypted
but obsolete key is rejected as `stale-wrap`. Invalid shares, unavailable quorum,
wrong recovery material, and unsupported or malformed wraps fail explicitly.
The helper never rotates the ledger key back to an obsolete value.

The successful order is:

1. Read the current viewing and recovery context, then verify the recovered key.
2. Recheck that context before writing the caller's persistent vault.
3. Await the vault write and read back the exact scoped key pair.
4. Recheck the chain, merge the key into the latest private profile, and read it back.
5. Recheck the chain again before returning `persisted: true`.

Existing holdings, spent markers, and unrelated private-state fields survive the
merge. No recovery secret or guardian share is saved in either store. Temporary
byte buffers are wiped where practical; JavaScript does not guarantee erasure of
all runtime copies or bigint values. Callers must retain recovery material until
the persistence acknowledgement, then follow their own secret-disposal policy.

`networkId` is a caller-supplied storage namespace. This API does not independently
query node genesis. Configure trusted providers for the intended network and use
a stable verified network identity, preferably its genesis hash. The holdings
adapter separately verifies its configured genesis identity.

## Restart and interrupted persistence

```ts
const reopenedStore = await createFileViewingKeyStore({
  directory: privateVaultDirectory, encryptionKey: vaultEncryptionKey,
});
const viewing = await freshAccount.loadViewingKey({ networkId, store: reopenedStore });
const holdings = await freshAccount.recoverHoldings(chainAdapter, {
  networkId, apply: true,
});
```

The fresh account may start with empty private inventory. Loading the vault
verifies the key against the current chain before installing it. A stale vault
cannot establish current viewing capability. `persistViewingKey(key, options)`
performs the same durable import for a caller who already possesses the current
viewing secret, for example after an authorised rotation; it does not verify the
guardian wrap.

A failed acknowledgement may still have reached disk. The method throws rather
than claiming persistence; retain recovery material, inspect the current context,
and retry or reload. A private-profile write failure leaves the acknowledged
vault copy available for recovery. A rotation or artefact change during the
operation produces `chain-changed`, even if a key was already stored. Rechecking
prevents a false success, but cannot make local storage and chain updates atomic.

The file vault uses caller-keyed AES-256-GCM, scope-bound authenticated data,
private directory/file permissions, exclusive temporary files, atomic replacement,
and acknowledged file and directory flushes. It supports one writer process and
serialises same-directory calls in that process. It does not provide distributed
locking, rollback detection, remote-filesystem guarantees, or recovery of its
encryption key. Keep that key outside the vault directory.

The reference funding-wallet setup still uses its documented development
private-storage password. This change does not turn that setup into a production
keystore. A production integration must configure its private provider and vault
key management appropriately. Custom `ViewingKeyStore` implementations are trusted
to honour their stated durability contract; read-back alone cannot prove it.

## Rotation and a fresh guardian session

Encryption-key rotation does not refresh the on-chain recovery wrap. The account
client invalidates its verification history before attempting a changed-key
rotation, so even a lost acknowledgement leaves a conservative warning. External
rotations are detected when the recorded public key no longer matches the chain.
A failed rotation may leave a warning until the wrap is verified again.

To publish a current backup, call
`publishViewingRecoverySession(device, { recoverySecret, sessionNonce, n, t, shares })`
with a fresh recovery secret, a fresh non-zero session identifier, and all `n`
indexed guardian shares for that session. The helper computes the public vector,
seals the current private viewing key, signs the publication, rechecks the context,
and verifies the resulting ledger artefacts before recording local freshness.
It rejects reuse of the current recovery key or session and refuses publication
while recovery is pending.

Supplying every indexed share does not authenticate the external guardian
exchange. The caller must derive and obtain those shares under the intended
session and account context. The helper checks a current private viewing key;
its publication result is not a claim that a local vault copy exists. Persist
the key explicitly when that assurance is required.

Do not refresh only the ciphertext under the old recovery secret. A fresh
full-roster session is required. If guardians are unavailable after an emergency
viewing-key rotation, report the stale backup and keep the recovery gap visible.
The existing opaque `publishRecoverySession` remains a low-level API; it clears
local verification history and supplies no evidence of wrap freshness.

## Pending recovery and remaining work

The contract permits viewing-key rotation while authority recovery is pending.
A live device can therefore make a previously restored key stale after submission.
Recheck viewing status after finalisation; authority restored with viewing stale
is a valid, incomplete outcome. Another party can finalise on-chain, so this
client cannot prevent that race or promise full recovery from a successful
`recoverFinalise` transaction alone.

Finalisation clears the public recovery vector. The successor must publish a
fresh full-roster session before backup status becomes current again. Existing
`recoverSubmit` and `recoverFinalise` remain authority operations; their transaction
results are not whole-wallet recovery completion reports.

Historical viewing-key retention, re-encrypting live inbox descriptions across
rotation, unavailable guardian transport, and full ceremony UX remain separate
work. `REC-WALLET-001` therefore remains partially open beyond this supported
client profile. The vault retains the current key per scope, not an archive of old keys.
The holdings scan still reports unreadable entries, missing descriptions,
unknown candidates, and incomplete coverage explicitly. A current key does not
remove the pre-backfill total-loss gap or repair uncertain journal operations.

## Validation

Run `npm run test:viewing-recovery` for helper, account, and encrypted-vault tests.
Fresh-process localnet results, source revisions, and remaining evidence limits
are recorded in the [remediation queue](../docs/plans/AUDIT-REMEDIATION.md).
