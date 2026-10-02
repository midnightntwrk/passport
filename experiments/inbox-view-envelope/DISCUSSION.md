# Viewing-key envelopes: internal review notes

**Draft for initial internal review.** Review the work and iterate before
deciding on wider discussion. The items below are internal design and
evidence-review points.

**The published localnet results predate the current codec.** They were
produced with a constant per-reader recipient tag and first-match envelope
selection, and must be re-run before the figures are quoted. The
[experiment guide](README.md#evidence-and-scope) lists the files changed
since that run.

## Authority boundaries

| Role | Authority |
|---|---|
| ACC device | Account-control signing authority held by an enrolled device; A and B have this role in the test harness. |
| Connected dApp / grantee | Uses its own signing key under an account-authorised scoped grant. **A wallet provider connecting to the account has this role**, not the role of an ACC device-key provider. |
| Viewing reader | Receives separately authorised access to the account viewing secret. This grants neither account control nor spending authority. |

A connected dApp, such as a wallet provider, must not be modelled as
supplying the user's device secret or being enrolled as an account-control
device. A dApp key
and an ACC device key have different authority even if both use a signature
scheme the contract supports. Any dApp spending is bounded by its grant.

The experiment below uses two devices to exercise the envelope mechanism.
It does not implement a connected-dApp connection, grant issuance, or
grant-based restoration/spending. Its 192-byte profile also carries public
P-256 device registration metadata; adapting it to a dApp reader is
separate work.

## The device journey exercised by this experiment

> A creates a Passport account. Independent passkey B is enrolled while A
> is available. Later, B opens the wallet on a fresh client. With A offline
> and no old wallet storage, B can recover viewing access and use its own
> signing authority on the same account.

Signing enrolment alone leaves a gap: B can approve operations but cannot
discover the account's encrypted coins. The experiment fills that gap with
a separately encrypted copy of the account viewing secret for each reader.

## Experimental device flow

```text
Passkey B                         Passport account inbox
  ├─ P-256 signing key              └─ 192-byte encrypted copy for B
  │    └─ approves operations                      │
  └─ PRF output → X25519 reader key ───────────────┘
                         │
                         └─ unlocks shared account viewing secret
                                      └─ discovers encrypted coin descriptions
```

The experiment client implements reader-key derivation, trusted enrolment,
envelope creation/opening, coin discovery, and key lifecycle. The ACC supplies
existing authorisation, an opaque inbox, and the current viewing public key
against which a restored secret is checked. This describes the test harness,
not an assignment of account-device responsibilities to a connected dApp.

One PRF-capable passkey can provide both functions. The signing private key
stays in the authenticator; the wallet derives a **different encryption key**
from PRF output. Independent A and B have different PRF outputs and reader
keys, but their envelopes unlock the same account viewing secret.

The payload is **192 bytes per reader per key generation**. Each envelope
currently needs one authorised append transaction. Full transactions are
larger; see [measured results](../../contract/evidence/inbox-view-envelope/RESULTS.md)
and the [experiment guide](README.md) for the proof/storage breakdown.

## Internal design review

| Topic | Review point |
|---|---|
| Authority model | Keep device enrolment, dApp grant issuance, and viewing-reader authorisation separate. The passing device journey is not a dApp integration result. |
| Existing accounts | The experiment begins with a random account viewing secret; migration from an existing derivation/storage model remains to be demonstrated. |
| Enrolment | Review the authenticated association between a recipient and its reader public key, retained roster trust, and partial completion. Device and dApp onboarding have different authority requirements. |
| Fresh-client bootstrap | Account address, network, RP/origin, profile, and credential-selection metadata are explicit inputs; their discovery is not implemented. |
| PRF support | Establish repeatable PRF for the intended browser/authenticator and RP/origin profile. Existing, new, and synced credentials need separate evidence. |
| Rotation | Review roster retention, offline re-sealing, and interrupted staging/activation. |
| Existing live coins | Review historical-key retention versus coin-description backfill. The experiment backfills one live coin under the new secret. |
| Recovery | Specify the viewing generations recovery must restore and the wrap/session lifecycle across rotation. |
| Cost and UX | Review N append transactions for N readers, proving/funding, and reporting of partial completion. |

### Evidence boundaries

- **Signing access and reading access are distinct.** The experiment enrols
  B for both. Read-only sharing can use reader envelopes without enrolling a
  spending device, but that product journey is not exercised here.
- **An inbox record is not a trusted roster advertisement.** Permissionless
  deposits can also carry arbitrary bytes. The restored secret is checked
  against current `enc_key`; recipient-roster additions need their own
  authenticated provenance. This prototype retains a trusted local roster.
- **Per-record recipient tags keep a reader's envelopes unlinkable.** The
  tag binds the record's ephemeral key, so a chain observer cannot group
  envelopes by reader or see when one reader stops receiving them. The
  residual leak is the count of `0xe1` records per account, which is public.
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

## Review sequence

The reviewer assesses the implementation, evidence, and authority model first.
The draft can then be revised and follow-up experiments selected.

Candidate follow-ups include real-credential device restoration, a separate
dApp/grant reader profile and journey, and the recovery-group recipient
above. A dApp journey must show account-approved grant issuance and separate
viewing-key delivery, then grant-bounded operations rather than device
enrolment. None of those follow-ups is demonstrated by the current suite.
