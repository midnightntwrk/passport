# MIP-0013 local amendment: temporary Jubjub bootstrap authority

**Status:** proposed local amendment, 2026/11/23. This is the specification
deliverable for [Passport #212](https://github.com/midnightntwrk/passport/issues/212),
under [#211](https://github.com/midnightntwrk/passport/issues/211). It is not
canonical, implemented, deployed, or a claim of cryptographic review.
[Implementation and validation #213](https://github.com/midnightntwrk/passport/issues/213)
follows this amendment; [upstream consolidation #214](https://github.com/midnightntwrk/passport/issues/214)
follows that evidence. Production SDK integration remains
[midnight-passport-sdk #140](https://github.com/midnightntwrk/midnight-passport-sdk/issues/140).

**Pinned baseline:** [canonical MIP-0013 at `eb626647`](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/eb626647515e1b66916869052fc8e5d23744004c/mips/mip-0013-account-authorisation.md),
especially §§2–5, §9, R1 and bootstrap conformance test 10. Companion
[MIP-0030](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/eb626647515e1b66916869052fc8e5d23744004c/mips/mip-0030-ecdsa-account-authorisation.md),
[MIP-0021](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/eb626647515e1b66916869052fc8e5d23744004c/mips/mip-0021-domain-separation.md),
and [MIP-0008](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/eb626647515e1b66916869052fc8e5d23744004c/mips/mip-0008-caip-2-network-identifiers.md)
are read at that same revision. Implementation observations refer to
[Passport `449de16d`](https://github.com/midnightntwrk/passport/tree/449de16d33679db8646408d5e4e804591d77228b),
Compact 0.35.0, not an implementation of this amendment.

## 1. Problem and decisions

Current §3 commits to the final device key before deployment. This is safe
without an activation signature: opening the commitment can install only
that key. Its salt prevents linking accounts using the same device. However,
a passkey registered with the eventual contract address as WebAuthn `user.id`
cannot supply its public key before the address exists.

This amendment adds a **signed-bootstrap mode**. A fresh temporary Jubjub
key authorises installation of a later-created P-256 passkey. The temporary
key is not a device, recovery key, viewing key, or maintenance key; it never
enters the device set. Its private scalar MUST remain outside proving.

The initial profile MUST also verify a WebAuthn assertion from the new
passkey **in-circuit**. The temporary signature grants installation authority;
the assertion proves possession under the selected RP/origin policy. Neither
signature alone is sufficient. This deliberate strengthening of current
activation adds P-256 verification cost; the old activation's `k=14` does not
measure it. Other target schemes or possession policies require a new profile.

There is no bootstrap signature in the constructor. The client computes the
commitment and initial state locally; the activation call proves the checks
below. Deployment may separately involve wallet fee proofs.

## 2. State, constructor and compatibility

For the Passport reference, reserve schema `spec_version = 4` for this local
proposal, subject to reconciliation with concurrent schema work before #213
merges. The cryptographic bootstrap format below is version **1**; it is not
an alias for the old `midnight:account:boot:*` recipes.

Extend the existing five constructor arguments, in order, with
`bootstrap_mode: Uint<8>` and `bootstrap_network: Bytes<32>`. Store both as
sealed ledger fields. `bootstrap_mode = 0` selects legacy fixed-key bootstrap;
`bootstrap_mode = 1` selects this signed profile. Reject other values.
For mode 0, require a zero `bootstrap_network` and retain the old commitment
recipes. For mode 1, require a nonzero network domain `N` and nonzero `boot`.
The initial device set MUST be empty, with `booted = false`, `device_count = 0`,
`device_epoch = 0`, and `auth_nonce = 0` in either mode.

Every old activation entry point in the new artifact MUST require mode 0;
the new `activate_initial_passkey` entry point MUST require mode 1. A mode-1
commitment MUST NOT be accepted as a legacy commitment. There is no mode
switch, replacement of `boot`, or bootstrap reset after deployment.

Existing schema-3 deployments and their keys/addresses remain unchanged.
Clients MUST select the artifact and constructor ABI explicitly. A deployment
whose maintenance authority has been retired cannot acquire the new verifier
through a documentation or SDK update. In-place migration of existing accounts
is outside this amendment; #213 targets new deployments and tests mode isolation.

The constructor dependency audit at the pinned reference is:

| Input | Required source before passkey registration |
|---|---|
| `initial_device_boot` | Commitment to the independent temporary public key and predetermined RP/origin profile, defined below. |
| `encryption_key` | Independently generated viewing/encryption keypair; retain its private half securely. |
| `initial_recovery_pk` | Independent retained birth recovery configuration, not derived from the future passkey. |
| `initial_recovery_wrap` | The existing 64-byte recovery wrap prepared from that configuration and viewing material. |
| `veto_window_seconds` | Explicit recovery policy. |
| `bootstrap_mode`, `bootstrap_network` | Profile selection and verified network configuration. |

A later passkey PRF may protect a copy of viewing material, but MUST NOT be
needed to derive these constructor inputs. The current client default that
generates and discards a birth recovery secret does not provide usable recovery.
Neither the stored wrap nor this amendment proves its decryptability; clients
MUST describe actual recovery readiness, not merely the presence of fields.

## 3. Exact context and hash recipes

`H<T>(v)` means Compact `persistentHash<T>(v)`, including its typed encoding;
it is not JSON hashing or string concatenation. Integer widths, tuple order,
point coordinate encoding and casts are consensus-relevant. Independent
signers MUST reproduce the pinned compiler's bytes, with cross-implementation
vectors supplied by #213. Hash outputs are `Bytes<32>`. P-256 coordinates
`x,y` below are the canonical little-endian `Bytes<32>` values returned by
the existing `secp256r1PointX/Y(pk) as Bytes<32>` recipe.

New tags follow MIP-0021: exact ASCII, no NUL padding, no hash of a padded
tag, and no length prefix before the tag. These are proposed additions under
the existing MIP-0013 namespace; upstream adoption remains #214. No old tag
or device-entry encoding is silently rewritten.

| Symbol | Exact tag | Compact type |
|---|---|---|
| `D_NET` | `mip-0013:boot:net[v1]` | `Bytes<21>` |
| `D_KEY` | `mip-0013:boot:key[v1]` | `Bytes<21>` |
| `D_ACT` | `mip-0013:boot:activate[v1]` | `Bytes<26>` |
| `D_SIG` | `mip-0013:boot:sig[v1]` | `Bytes<21>` |
| `D_POP` | `mip-0013:boot:pop[v1]` | `Bytes<21>` |

### 3.1 Network context

Prepare a deployment configuration with canonical lowercase CAIP-2 Midnight
identifier `id`, its ASCII length `L: Uint<8>`, `id41: Bytes<41>` containing
those bytes followed by zeros, and genesis block hash `genesis: Bytes<32>`.
`id` MUST match MIP-0008's namespace/reference rules, have length 10–41, and
contain no NUL; unused bytes MUST be zero. Include a pinned chain-instance
anchor `anchor_height: Uint<64>, anchor_hash: Bytes<32>`: normally height 0
and the genesis hash, or a published distinguishing checkpoint where genesis
alone is insufficient (including the Preview relaunch noted in pinned MIP-0008).
The checkpoint MUST be fixed configuration, not a moving latest block.
Both block hashes are the raw 32 bytes decoded from their RPC hexadecimal
representation, without byte-order reversal.

```text
N = H<[Bytes<21>, Uint<8>, Bytes<41>, Bytes<32>, Uint<64>, Bytes<32>]>(
  [D_NET, L, id41, genesis, anchor_height, anchor_hash])
```

Clients MUST verify this configuration against their intended chain before
deployment and before signing, then compare `N` to sealed `bootstrap_network`.
Activation reads `N` from ledger state, never an unchecked witness override.
The bootstrap commitment and both signatures bind it.

**Boundary:** the pinned Compact account has no authenticated network-ID
primitive. This mechanism rejects replay between differently configured
network contexts; it does not prove the physical chain hosting an identical
clone with the same configured `N`. Client chain-instance verification and
outer transaction network checks remain necessary. Tests and upstream claims
MUST preserve this distinction rather than claim unconditional clone/fork
replay protection.

### 3.2 Target profile and boot commitment

Bootstrap format `v: Uint<16> = 1` supports only target scheme
`scheme: Uint<8> = 2` (P-256/r1) and profile `profile: Uint<16> = 1`.
These identifiers are scoped to this bootstrap format, not a general scheme
registry. Unknown values MUST reject; they are not prover-selectable fallbacks.

Profile 1 fixes the reference `wa-json134-or-chrome243` policy:
`policy = { rp_id_hash: Bytes<32>, origin: Bytes<21> }`, in that field order.
The exact origin is not padded. The verifier accepts only the two complete
JSON shapes in [the pinned profile](https://github.com/midnightntwrk/passport/blob/449de16d33679db8646408d5e4e804591d77228b/contract/WEBAUTHN.md),
`type=webauthn.get`, `crossOrigin=false`, 37-byte authenticator data,
RP-hash equality, and flags 5, 13 or 29 (UP+UV, with the specified backup-bit
rules). No extensions or alternate origins are accepted. `chrome_grease`
selects a verified serialization of the same policy, not another identity.
The client MUST validate the RP ID/origin relationship and origin syntax
before deployment; the circuit MUST enforce the profile's byte constraints.

Sample independent nonzero `b < r_J` and derive `Q = bG`. `Q` MUST be fresh
per deployment and MUST NOT be derived from or reused as another authority.
No salt is needed for this new commitment: fresh independent `Q` prevents a
stable cross-account key commitment. The final passkey key is absent:

```text
B = H<[Bytes<21>, Uint<16>, Bytes<32>, JubjubPoint,
       Uint<8>, Uint<16>, WebAuthnPolicy]>(
  [D_KEY, v, N, Q, scheme, profile, policy])
```

Store `B` as `boot`. `Q` and the policy remain undisclosed activation inputs;
the prover can see them but they are not signing secrets. Knowledge of this
opening alone MUST NOT authorise installation.

### 3.3 Activation intent and two signatures

After deployment, obtain the passkey public key `pk`. For registration,
`user.id` is the contract address's **raw 32 bytes**, not its display string.
This fits WebAuthn's 64-byte user-handle limit. The SDK MUST persist the
credential ID, key, policy and account mapping. `userHandle` is a locator,
not a substitute for signature verification or proof that the registration
used that handle; the circuit does not attest registration metadata.

Let `A = kernel.self()` and `B = boot` read from the account. The circuit
checks `device_epoch = 0`, `auth_nonce = 0` and uses those actual values as
`epoch: Uint<32>` and `nonce: Uint<64>` below:

```text
I = H<[Bytes<26>, Uint<16>, Bytes<32>, ContractAddress, Bytes<32>,
       Uint<8>, Uint<16>, Bytes<32>, Bytes<32>, WebAuthnPolicy,
       Uint<32>, Uint<64>]>(
  [D_ACT, v, N, A, B, scheme, profile, x, y, policy, epoch, nonce])

passkey_challenge = H<[Bytes<21>, Bytes<32>]>([D_POP, I])

h = H<[Bytes<21>, JubjubPoint, JubjubPoint, Bytes<32>, Uint<64>]>(
  [D_SIG, R, Q, I, grind_nonce])
```

The passkey produces a WebAuthn assertion over `passkey_challenge`; the
circuit recomputes and verifies the entire accepted envelope with `pk` and
the committed policy. A caller-supplied digest or client-only assertion
check is insufficient. This is proof of possession, not hardware attestation.

For the temporary signature, sample a fresh nonzero nonce `r < r_J`, set
`R = rG`, and grind `grind_nonce: Uint<64>` until `c = LE(h) < r_J`.
Compute `s = (r + c*b) mod r_J`. The circuit MUST enforce `LE(h) < r_J` and
`0 <= s < r_J` before scalar casts and check `sG = R + cQ`.
Compact scalar casts may reduce modulo `r_J`; a cast alone is not the range
check. Use MIP-0013's subgroup order and generator. Nonces MUST NOT repeat
across distinct signed messages. Exhausting the grinding counter fails;
it MUST NOT wrap silently. Neither signature depends on the other signature's
bytes, so the ceremony introduces no new circular dependency.

Both `Q` and `R` MUST be valid nonidentity prime-subgroup Jubjub points;
the exact coordinates hashed MUST be bound to the curve operands. Native
subgroup assignment may discharge membership if established for the pinned
backend. `[8]P != O` alone excludes small-order points but does not establish
full subgroup membership. P-256 keys MUST be canonical, on-curve and
nonidentity; signature scalars follow the profile's canonical nonzero range.
High-S ECDSA remains accepted as in the reference; state consumption, not
signature-byte uniqueness, prevents replay.

`round` is deliberately absent: permissionless deposits or inbox updates
MUST NOT invalidate this authorisation. Every value affecting the installed
device is in `I`, or fixed and checked by format 1. No additional unsigned
effects or witness-derived installation parameters are permitted.

## 4. Activation and recovery state transitions

Proposed logical ABI (names map to the types above):

```text
activate_initial_passkey(Q, pk, policy, R, s: Field, grind_nonce: Uint<64>,
                        authenticator_data: Bytes<37>,
                        passkey_sig: Secp256r1EcdsaSignature,
                        chrome_grease: Boolean) -> []
```

Format, scheme and profile are fixed constants for this entry point. It MUST:

1. Require mode 1, `!booted`, nonzero `boot`, empty `devices`,
   `device_count = 0`, `device_epoch = 0`, and `auth_nonce = 0`.
2. Validate points/scalars/policy; recompute `B` using sealed `N` and
   require equality to stored `boot`; recompute `I` from the actual inputs
   and ledger state; verify both signatures as in §3.
3. Recompute the existing r1:v2 device entry in-circuit from
   `(A, pk, policy, epoch=0, use_counter=0)`. Do not accept an opaque entry.
4. Atomically insert that one entry, set `device_count = 1`, set
   `booted = true`, clear `boot` to 32 zero bytes, and increment `round`
   exactly once. Leave `auth_nonce = 0`, `device_epoch = 0`, viewing,
   recovery, balances, grants and sealed configuration unchanged.

Failure MUST leave state unchanged. The entry permits only the same enforced
WebAuthn profile on all reachable accepting verifiers; future optional profile
choices require authenticated routing/entry binding and a versioned amendment.
Two competing valid activations may be prepared, but at most one may commit.
Relaying the same proof can only install the authorised target; re-signing
another target requires the temporary private key.

Preserve the reference's **recovery-before-activation** behaviour:

- Activation is permitted while recovery is pending. It leaves that pending
  record and its deadline untouched, allowing the installed device to use
  the existing veto path. Activation itself does not cancel recovery.
- If recovery finalisation commits first, it MUST set `booted = true` and
  clear `boot`; every cached activation then rejects.
- If activation commits first, the pending recovery remains able to finalise
  after its window unless vetoed, retiring the installed device under the
  existing recovery rules. Bootstrap can never reintroduce it afterward.

This does not grant the temporary key any recovery, withdrawal or device
operation. Recovery remains a separate authority and threat assumption.

## 5. Client lifecycle and security boundary

The [proposed protocol flow](../../protocol-flows/02-temporary-jubjub-bootstrap.md)
defines the messages and durable checkpoints. Before either signing approval,
the client MUST check the intended account, network configuration, stored
commitment, profile, and deployed verifier roster against trusted artifacts.
Incomplete verifier-wave deployment is not a ready account. A retained
maintenance authority can replace verifiers; disclose that separate trust
assumption or retire it according to the deployment policy before approval.

Keep a protected onboarding record with `b`, public key `Q`, its commitment,
committed policy/network configuration, deployment identity, and subsequently
the credential metadata and approved
target. Do not log `b` or send it to an indexer, relayer, prover, or sponsor.
Only signatures and required nonsecret witnesses cross the proving boundary.
Durably retain the approved intent and temporary signature, followed by the
passkey assertion/proof when available, with the protected onboarding record.
After an uncertain submission, inspect confirmed state before retrying;
reuse the same target and reconstruct the same intent only while dormant.
Do not create replacement credentials or approve a different key implicitly.
After confirmed intended activation (or recovery retirement), erase the
temporary key and stop retries. Retain ordinary device/viewing/recovery data.
If the installed state is unexpected, surface the mismatch; do not report
successful onboarding merely because `booted` is true.

If `b` is lost, a retained valid temporary signature may still complete
activation of its exact approved target, provided the account remains dormant
and a valid passkey assertion is available or can be obtained. If neither `b`
nor a usable retained activation authorisation remains, knowing `Q`, the
passkey, or the commitment cannot recreate authority. Existing usable recovery
may regain control; otherwise the client must abandon the dormant deployment
and start a new account.
There is no permissionless reset or timeout takeover. Clients SHOULD avoid
funding dormant accounts and MUST warn accurately if a funded account cannot
be activated or recovered.

This design follows MIP-0013 R1's signature/prover separation. In the old
bootstrap the key was fixed before proving; in a salt-only alternative the
prover would receive a credential allowing target selection. Here the prover
can withhold or relay the approved activation, but cannot choose another
target without forging the temporary signature. A compromised temporary
signer can still authorise an attacker's own passkey and assertion. Local
key protection, correct signing review, trustworthy verifier deployment,
hash/signature security, and the declared proving-backend constraints remain
assumptions. A short-lived key is not automatically a safe key.

## 6. Required conformance evidence for #213

Extend MIP-0013 bootstrap test 10 with the following matrix. This is an
implementation/review plan, not a claim that these tests have run.

| ID | Required observation |
|---|---|
| B01 | Deploy without a final passkey; register it with raw address bytes as `user.id`; verify both signatures and install exactly its epoch-0/counter-0 entry. |
| B02 | Wrong temporary key/signature, changed `R` or grinding nonce, and identity/off-curve/torsion/noncanonical inputs fail at the documented enforcing layer. Include `s + r_J` and an out-of-range challenge, rather than testing only honest grinding. Exercise raw invalid witnesses at the proof/constraint boundary where host validation can be bypassed; host-only refusal is not evidence against a malicious prover. Record untested backend boundaries. |
| B03 | Substituting the target key, RP hash, origin, profile/scheme or any intent field rejects; a prover-supplied opaque entry/digest cannot bypass recomputation. |
| B04 | Missing/invalid passkey assertion, wrong challenge/RP/origin, absent UP/UV, invalid flags/lengths/JSON and wrong GREASE selection reject. Both allowed shapes and high/low-S forms are covered. |
| B05 | Different accounts, configured network domains, instance anchors, and operation domains reject replay. Client tests reject chain/configuration mismatch; document identical-context clone limitations separately. |
| B06 | Mode-0/mode-1 crossover and unknown constructor modes reject. Commitments/challenges encoded with unsupported versions/profiles do not match the fixed entry-point constants; clients reject unsupported artifacts. Do not add a runtime profile selector just for this test. Legacy vectors stay unchanged in the supported artifact. |
| B07 | Repeated activation and two competing valid activations cannot install a second device. Rejected calls preserve state. Success has exactly §4's effects. |
| B08 | Deposits/inbox updates between approval and submission do not invalidate the intent or lose their state changes. |
| B09 | Recovery finalises before activation: old bootstrap rejects. Activation during pending recovery preserves the deadline/record and permits ordinary veto; without veto finalisation retires the device and bootstrap permanently. |
| B10 | Both signer private keys are absent from proof preimages/logs. A modified proof request cannot install a different target under the original approvals. |
| B11 | Interrupted deployment/registration/submission resumes the same account and credential safely; duplicate credential creation is not an automatic retry. Retained approval allows the same target to complete after loss of the temporary key; loss of both key and approval, and unusable-recovery outcomes, are explicit. |
| B12 | Independent signature/encoding vectors cover every typed hash, canonical scalar checks and the installed entry. Every published vector pins its compiler/runtime and source revision. |
| B13 | Real proofs verify and the complete flow executes on-node; record fresh artifact provenance, `k`, rows, proving timings and relevant custody/device/recovery regressions. Distinguish host-side rejection from proof/ledger enforcement. |

Before upstream consolidation, map each MUST to code and evidence, document
review findings and remaining assumptions, and reconcile this draft with the
validated implementation. Passing tests is not a formal cryptographic
soundness proof. #214 must update canonical §3, affected invariants/rationale,
challenge/domain recipes, compatibility and conformance text only after #213.

## 7. Local review record

The 2026/11/23 local design review checked the hash/signature bindings,
constructor dependencies, mode isolation, activation/recovery ordering and
retry lifecycle against the pinned sources. It resulted in explicit scalar
range checks, a qualified network-replay guarantee, retention of signed
approvals for interrupted onboarding, and separate host/proof enforcement
requirements. This is an implementable proposed baseline for #213, not an
independent cryptographic audit or completed conformance assessment. Any
encoding or state-machine change discovered during implementation must update
this amendment and its vectors before #214 consolidates it upstream.
