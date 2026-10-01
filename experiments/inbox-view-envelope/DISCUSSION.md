# Discussion with Angel and the Lace team

## The journey we want to support

> A creates a Passport account. Independent passkey B is enrolled while A
> is available. Later, B opens the wallet on a fresh client. With A offline
> and no old wallet storage, B can recover viewing access and use its own
> signing authority on the same account.

Signing enrolment alone leaves a gap: B can approve operations but cannot
discover the account's encrypted coins. The experiment fills that gap with
a separately encrypted copy of the account viewing secret for each reader.

## Proposed division of work

```text
Passkey B                         Passport account inbox
  ├─ P-256 signing key              └─ 192-byte encrypted copy for B
  │    └─ approves operations                      │
  └─ PRF output → X25519 reader key ───────────────┘
                         │
                         └─ unlocks shared account viewing secret
                                      └─ discovers encrypted coin descriptions
```

The wallet owns reader-key derivation, authenticated enrolment, envelope
creation/opening, coin discovery and key lifecycle. Passport provides
existing account authorisation, an opaque inbox and the current viewing
public key against which a restored secret is checked.

One PRF-capable passkey can provide both functions. The signing private key
stays in the authenticator; the wallet derives a **different encryption key**
from PRF output. Independent A and B have different PRF outputs and reader
keys, but their envelopes unlock the same account viewing secret.

The payload is **192 bytes per reader per key generation**. Each envelope
currently needs one authorised append transaction. Full transactions are
larger; see [measured results](../../contract/evidence/inbox-view-envelope/RESULTS.md)
and the [experiment guide](README.md) for the proof/storage breakdown.

## Decisions to make together

| Topic | Question for the integration |
|---|---|
| Wallet key model | Can Lace load the account viewing secret independently of the currently selected passkey, and retain authenticated reader public keys? |
| Existing accounts | Can an authorised existing client wrap its current viewing secret for B? The experiment begins with a random account secret; it does not demonstrate migration from Lace's current derivation/storage model. |
| Enrolment | How does A authenticate the association between B's signing credential and reader public key? What is the user-visible confirmation, and when is B considered fully enrolled? |
| Fresh-client bootstrap | Where do account address, network, RP/origin, profile and credential-selection metadata come from when local storage is empty? The prototype supplies these public inputs explicitly. |
| PRF support | Which browser/authenticator combinations support repeatable PRF for existing credentials, newly created credentials and synced credentials? Where does the RP ceremony run in the Lace UX? |
| Rotation | Who retains the trusted reader roster and publishes new envelopes while other readers are offline? How are interrupted staging/activation steps resumed? |
| Existing live coins | Should the wallet retain historical keys, re-encrypt live coin descriptions, or both? The experiment backfills one live coin under the new secret. |
| Recovery | What viewing keys must guardian recovery restore, and how are recovery-wrap updates coordinated with every key rotation? |
| Cost and UX | Are N append transactions acceptable for N readers? Who proves and pays, and how does enrolment report partial completion? |

### Boundaries worth agreeing explicitly

- **Signing access and reading access are distinct.** The experiment enrols
  B for both. Read-only sharing can use reader envelopes without enrolling a
  spending device, but that product journey is not exercised here.
- **An inbox record is not a trusted roster advertisement.** Permissionless
  deposits can also carry arbitrary bytes. The restored secret is checked
  against current `enc_key`; recipient-roster additions need their own
  authenticated provenance. This prototype retains a trusted local roster.
- **Exclusion is prospective.** A new viewing generation can exclude B,
  but B keeps previously learned information. Signing revocation is a
  separate account operation.
- **Current-key restoration is not complete historical recovery.** A wallet
  still needs live-coin tracking, old-epoch policy, and recovery-wrap freshness.
- **RP/origin choice matters.** This codec binds both into reader derivation
  and encryption. Changing them needs an explicit migration plan. The
  current P-256 profile also uses a separate extension-free signing ceremony.

### Are recovery viewing keys also stored in these inbox envelopes?

**Not in this experiment.** Both paths concern the same account viewing
secret, but they currently use different containers and unlock conditions:

| Path | Encrypted container | Unlocking material | This experiment |
|---|---|---|---|
| Enrolled passkey reader | 192-byte inbox envelope | That reader's PRF-derived X25519 key | Exercised by the automated suite |
| Guardian recovery | Existing 64-byte `recovery_wrap` ledger field | Wrap key derived from the reconstructed recovery secret | No usable recovery wrap configured; untested here |

Encryption happens in the wallet in both cases; the contract stores opaque
bytes. Changing the account viewing secret requires keeping both intended
access paths current. The existing recovery-wrap refresh is part of a fresh
guardian session; publishing reader envelopes does not update it.

If we later evaluate inbox transport for recovery, the design must preserve
the guardian threshold: giving each guardian an ordinary reader envelope
would instead grant each guardian individual viewing access. That is a
different sharing policy from the current recovery mechanism.

### Proposed next experiment: one recovery recipient in the same inbox

Using the inbox for recovery is a natural extension. Treat the **recovery
group as one recipient**, with a separate public encryption key whose
private key is derived, under a recovery-specific domain, from the secret
the guardian quorum reconstructs:

1. At guardian-session setup, derive that reader key and authenticate its
   public key as belonging to the active account/recovery session. Retain
   the public key for future re-sealing; the setup client follows the
   recovery protocol's secret-erasure rules.
2. When an authorised owner rotates the account viewing secret, append a
   new copy encrypted to the retained recovery reader public key. This
   step needs neither the recovery secret nor online guardians.
3. On recovery, reconstruct the secret using the existing guardian quorum,
   derive the recovery reader private key, and open the envelope whose
   viewing secret matches the trusted current `enc_key`.

This would use **one additional 192-byte inbox slot per viewing-key
generation for the active recovery policy**, rather than one per guardian.
The existing guardian threshold and account-recovery authorisation/veto
flow remain separate from this proposed viewing-key delivery path.

The useful change is **public-key wrapping**, not storage relocation alone:
the current symmetric `recovery_wrap` needs the recovery secret to create
a replacement. Merely copying that 64-byte ciphertext into an inbox slot
does not allow offline-guardian refresh.

This proposal is not implemented or validated by the present suite. A
follow-up must exercise authenticated recovery-recipient enrolment,
account/network/session binding, current-key selection, an actual quorum
restore after offline rotation, and recovery-session replacement. In
particular, finalisation consumes the old recovery authority and changes
the on-chain recovery public key, so envelope selection and successor
provisioning need an explicit before/after-finalisation rule. Wallets also
need a migration policy for the existing `recovery_wrap` field. An old quorum
retains access to already published ciphertext from its era.

## Suggested joint next step

Run the journey with **two real independent credentials and a genuinely
fresh Lace client**, declaring its public bootstrap inputs up front:

1. A enrols B's signing key and authenticates B's reader public key.
2. A publishes B's envelope for the account's actual viewing secret.
3. B starts with empty wallet state; A is unavailable.
4. B selects its credential, evaluates PRF, retrieves its envelope and
   discovers a real held coin from chain data.
5. B signs a spend, and the node accepts it on the original account.
6. Repeat after rotation while B is offline; document how live coins and
   the recovery wrap remain usable.

The automated localnet suite is a reproducible starting point: software
ES256 credentials, synthetic PRF outputs, real contract proofs and an
empty private-state provider. The included browser probe separately checks
same-credential PRF unlock and ES256 signing. Real PRF, cross-machine sync,
and Lace integration need their own observed results.
