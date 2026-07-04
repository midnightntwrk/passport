# ANARKey (BUSS) for Passport Account Recovery: Assessment

Status: research note, first draft 2026/07/04.
Inputs: the ANARKey paper ([EPRINT 2025/551](https://eprint.iacr.org/2025/551), to appear at EuroS&P 2026) read in full; the Pleiades implementation (`tmp/Pleiades`, IOG, work in progress); the current recovery surface (account-custody prototype, C13/C14/C15 canvases, and the account-custody MIP recovery seam).

## Verdict

Bottom-Up Secret Sharing (BUSS), the primitive formalised by ANARKey, is a strong fit for Passport recovery and strictly dominates the current plaintext-Shamir-on-chain placeholder as well as the DeRec-style helper model of C15 on guardian burden. The defining property: **guardians store nothing and receive nothing at backup time**. Each guardian derives their share on demand from a key they already hold, and the only stored artefact is a short public vector that provably leaks nothing about the secret. The account-contract recovery seam defined in the custody MIP needs no change; the contract keeps verifying knowledge of a recovery secret against a commitment, and BUSS becomes the off-chain answer to "where does the recovery secret come back from".

Two sharp edges, both manageable and both documented below:

1. **Fresh session identifier on every re-share.** Re-publishing a backup vector for the same secret with correlated guardian shares degrades the threshold by at least one and, past a modest guardian count, eliminates it entirely. Every guardian-set or threshold change must use a fresh session identifier and re-contact all guardians.
2. **Old backup vectors are forever.** On an immutable chain a superseded vector remains readable, so removing a guardian is only effective if the recovery secret itself is rotated at the same time. The existing contract seam already rotates the recovery commitment, so this composes cleanly; it must simply be made mandatory on every membership change.

## 1. The scheme in brief

Setting: a community of parties, each already holding a long-lived key pair. A key-owner with secret `s` picks `n−1` guardians. There is no dealing of shares. Instead:

- **Share derivation (guardian side, stateless).** Guardian `j` computes `σ_j = H(id ‖ sk_j)` from their own secret key and the owner's identifier (which must include a unique backup-session identifier), and sends `σ_j` to the owner. The guardian stores nothing and can recompute `σ_j` at any time.
- **Backup (owner side).** The owner interpolates the unique degree-`(n−1)` polynomial `f` with `f(0) = s` and `f(j) = σ_j` for each guardian, then publishes `φ = (f(−1), …, f(−(n−t−1)))`: exactly `n−t−1` field elements. Reliable public storage suffices; a blockchain is the paper's suggested bulletin board.
- **Recovery.** Any `t+1` guardians recompute their `σ_j` and send them to the recovering party, who combines them with the `n−t−1` public points to reconstruct `f` and read `s = f(0)`. The result is checked against the owner's public key (in our case, against a commitment), which is where malicious behaviour is caught.

Security is proven in a simulation framework against malicious, adaptive adversaries corrupting up to `t` parties; the public vector is perfectly simulatable, so it reveals nothing about the secret or the shares. Failure mode is abort without identification of the cheater. The guardian set is never published, which is deliberate: guardians who do not know each other are harder to assemble into a colluding quorum.

The paper's §8 extensions, all implemented in Pleiades:

- **Guardian key rotation.** A guardian who changes their key sends the owner a single delta value; the owner patches `φ` in place. No other guardian is involved, and the secret is unchanged.
- **Cold wallets.** A guardian whose key lives in a hardware signer never exports it; the device signs a canonical message with a deterministic scheme (RFC 6979 ECDSA, BIP-340 Schnorr) and the share is derived from the signature. Randomised signature schemes are excluded.
- **Dedicated guardian keys.** A guardian may use a separate key for guardianship rather than their main signing key. This costs one extra stored key but removes the domino effect (compromising one member's key cascading into recoveries of others) and limits main-key exposure.

Performance is a non-issue: milliseconds even at high guardian counts, and network latency dominates. The Pleiades in-browser WASM demo runs the real field arithmetic; these operations are trivial next to our proving workloads.

## 2. Implementation review: Pleiades

`tmp/Pleiades`, to be consumed as a git dependency from `github.com/input-output-hk/Pleiades`. MIT licensed, single small crate plus a `pleiades-wasm` binding crate. The full test suite passes locally (89 tests). Explicitly not audited and not production-ready per its own README.

What it provides:

| Module | Content | Assessment |
|---|---|---|
| `bottom_up/buss.rs` | `BottomUpSSS` (share, reconstruct), `guardian_share`, `key_update_delta` and `apply_key_update`, `cold_wallet_message` and `guardian_share_from_sig` | Faithful to §5.1 and §8 of the paper. Correctness invariants tested, including stale-key failure after rotation. |
| `bottom_up/nitbuss.rs` | NITBUSS ([EPRINT 2025/2089](https://eprint.iacr.org/2025/2089)): traceable, non-imputable variant | Candidate v2: adds leak tracing and protection against framing guardians, at the cost of a doubled public vector and an owner-held trace key. |
| `secret_sharing/` | Shamir, Feldman VSS, traceable Shamir | Useful baselines; not needed for the BUSS path. |
| `math/` | Lagrange interpolation, FFT, list decoding | Standard, small, correct; duplicate evaluation points are rejected. |
| `pleiades-wasm` | wasm-bindgen bindings | Demo grade only: secrets restricted to `u64`, a hard-coded demo owner identifier, guardian secret keys round-tripped through JavaScript, and no cold-wallet or NITBUSS surface. Production bindings are a work item. |

Field choice matters for us: everything runs over the BLS12-381 scalar field via `midnight-curves`, which is exactly JubJub's base field as used across Midnight. A JubJub secret scalar (roughly 252 bits) embeds injectively into this field (roughly 255 bits), so backing up a JubJub key or a random field-element recovery secret works directly. A uniform 256-bit seed does **not** fit in one element; the backed-up secret must be sampled as a field element (or the derived scalar, not the raw seed).

Gaps to raise upstream before we depend on it in anger:

1. **Session-identifier discipline is left entirely to the caller.** The API takes a raw `owner_id: &[u8]`, and the documentation suggests using the owner's public key alone. That is precisely the unsafe pattern for re-shares (see §3a). The crate should take a typed session identifier, or at minimum document the uniqueness requirement prominently.
2. No serialisation or interchange format for `φ` and parameters (acknowledged in the README).
3. Production WASM bindings: arbitrary 32-byte secrets, caller-supplied identifiers, the cold-wallet signature path, and no secret material crossing the JS boundary unnecessarily.
4. No zeroisation of secret material; `guardian_share` hashes raw secret-key bytes in host memory. The dedicated-guardian-key and cold-wallet patterns mitigate this.
5. Cosmetic: the README states edition 2024 while the manifest says 2021.

Dependency line for a Rust consumer (SSH form while the repository is private):

```toml
[dependencies]
pleiades = { git = "ssh://git@github.com/input-output-hk/Pleiades.git" }
```

## 3. Fit for Passport

### 3a. Social recovery among people

**Can family members act as guardians?** Yes, and this is the scheme's home turf, with one requirement: each guardian needs a long-lived key pair and a client able to compute one hash (or one deterministic signature) on request. Three guardian classes fall out naturally:

- **Passport users.** The natural choice of guardian key is a dedicated recovery-role subkey derived from the account seed (consistent with the MIP-0003 role-derivation surface), not the main account key. This kills the domino effect and keeps the main key out of extra computations.
- **Any external wallet with deterministic signatures.** Via the cold-wallet variant, a family member with an existing hardware or software wallet (RFC 6979 ECDSA or BIP-340 Schnorr) can serve as a guardian without installing Passport and without their key ever leaving the device. This makes guardianship wallet-agnostic, which matters for ecosystem adoption and makes the scheme a credible MIP.
- **Paper keys** (see §3b).

Guardian burden compared with the C15 helper model: no share to store, no encrypted blob to keep available, no daily liveness protocol, nothing to lose or leak between ceremonies. A guardian who is offline for a year is still a valid guardian the moment they come back, provided their key survived. The corresponding loss: nobody notices a guardian losing their key until recovery is attempted. Mitigations: over-provision guardians relative to the threshold, and run optional owner-initiated drills while healthy (the owner can cache share fingerprints to verify responses cheaply).

**Can guardians be added or removed without restarting?** The honest answer: a membership or threshold change is mathematically a fresh backup, but operationally it is one automatic message per guardian and one transaction, with zero guardian-side state changes. What it is **not** is free reuse of the previous shares, for a fundamental reason:

> **The correlated re-share hazard.** Suppose the owner re-publishes a backup for the same secret while continuing guardians contribute the same `σ` values (same session identifier). Both public vectors are linear equations over the same unknowns (the secret and the shares). Counting equations against unknowns: any such correlated pair reduces the number of corruptions needed to recover the secret by at least one, and once the guardian count reaches `2t+2` the two public vectors alone determine the secret. Concretely, with threshold 3 and five guardians, adding a sixth guardian without a fresh session identifier hands the secret to a passive observer of the chain. The simulation proof simply does not apply across correlated sessions; the paper's remark on unique session identifiers is load-bearing, not hygiene.

The re-share procedure must therefore be, atomically: pick a fresh session identifier, collect fresh `σ` values from **all** guardians in the new set, rotate the recovery secret, and publish the new commitment plus the new `φ` in one transaction.

**Is a removed guardian actually removed?** Only with secret rotation. Superseded vectors remain readable on an immutable chain, so the old guardian set can always reconstruct the **old** secret. Rotating the recovery secret on every membership change makes the old secret worthless against the contract, because the seam only accepts the current commitment. This is the same epoch philosophy the custody contract already applies to devices, extended to the recovery secret, and it is why BUSS composes so well with our seam: revocation totality comes from the contract, secrecy comes from the scheme.

Within an unchanged guardian set, a guardian rotating their own key costs a single delta message and a small `φ` update; nobody else is involved, and this is implemented and tested in Pleiades.

**Collusion.** As in any threshold scheme, `t+1` guardians plus the public vector can reconstruct the secret; with the commitment on-chain they can execute a hostile recovery. BUSS's structural mitigation is that the guardian set is never published, so guardians cannot easily find each other. Defence in depth should come from the contract: a challenge window on the recovery seam (prior art: the 48-hour and 14-day delays recorded in `research/features.md`) during which any active device can veto. The prototype currently has no such window; it should be specified in the recovery-paths MIP regardless of scheme.

### 3b. Cold recovery on paper

Yes, and more elegantly than as a separate mechanism: a paper backup is simply a guardian whose "existing key" is a random field element printed on paper. The owner generates it, derives its share exactly as any guardian would, and destroys the in-memory copy. Nothing distinguishes paper guardians from human guardians inside the polynomial, so one scheme and one threshold cover the whole spectrum:

- Mixed quorum, for example five guardians = spouse, parent, friend, paper slip at home, paper slip in a bank deposit box, any three of which recover.
- Paper-only, for example two-of-three slips in three locations.
- The degenerate one-of-one instance (single slip recovers alone) is valid and tested, though at that point it is equivalent to encrypting the secret under the paper key, with `φ` as the public ciphertext; the value of BUSS is the uniform mechanism, not that corner case.

Practicalities: a slip should carry the key, the guardian index, and the session identifier (none of which are secret except the key). Losing the metadata is survivable for realistic sizes: the recovering client can brute-force index assignments locally against the on-chain commitment (a three-of-five setup has sixty assignments to try). Hardware signers work as paper-tier guardians without ever exposing a key, via the deterministic-signature variant.

The one constraint worth repeating: the paper key and the backed-up secret are field elements, not arbitrary 32-byte strings. Encoding conventions (word lists, hex with checksum) are ours to define.

### 3c. On-chain storage: the bare minimum

The chain plays exactly one role: reliable public bulletin board plus the commitment the contract already holds. Nothing about BUSS is verified on-chain, and no circuit changes are needed beyond deleting state.

| Item | Today (prototype) | With BUSS |
|---|---|---|
| Recovery commitment | 32 bytes (`recovery` field) | unchanged, 32 bytes |
| Share material | 3 × 32 bytes **plaintext Shamir shares**, publicly reconstructable (recorded "do not ship") | none |
| Backup vector `φ` | n/a | `n−t−1` × 32 bytes, provably leaks nothing (64 bytes for 2-of-3, 96 bytes for 3-of-5) |
| Guardian identities or ciphertexts | n/a (none implemented; C15 helper model would add encrypted shares per helper) | none, ever |

So the two-of-three configuration is 96 bytes of ledger state total, and the recorded critical weakness of the prototype disappears rather than being patched. The absolute minimum is even smaller: store only a 32-byte hash of `φ` and keep `φ` itself off-chain (the paper suggests exactly this for gas). We should not take that trade: full on-chain `φ` is what makes recovery work when the owner has lost everything and, in the permanent-disappearance case, lets a nominee plus a guardian quorum recover without any surviving owner-side state. Ninety-six bytes is cheap availability insurance.

What the contract sees per lifecycle event:

- **Guardian key rotation:** one small transaction updating `φ` in place.
- **Membership or threshold change:** one transaction replacing `φ` and the recovery commitment (mandatory pairing, per §3a).
- **Recovery:** the existing seam, unchanged: prove knowledge of the recovery secret, bump the device epoch, register one fresh device, rotate the commitment (and now also publish a fresh `φ` for the new secret).

Privacy of the on-chain residue: `φ` is simulatable and carries no guardian information; its length reveals only the redundancy parameter `n−t−1`; update timing reveals that some rotation happened. That is a strictly better privacy profile than any design that puts per-helper ciphertexts or helper public keys on-chain.

One adaptation needs a cryptographer's nod: the paper checks the recovered secret against a public key under a key-generation hardness assumption, whereas we check against a hash commitment. The commitment satisfies the same three requirements (unique opening computationally, efficient verification, hard to invert), and the proof is random-oracle based, so the adaptation looks routine, but it should be confirmed rather than assumed, alongside the existing note that the commitment currently uses `transientHash` with its known cross-version instability.

## 4. Open questions

1. **Session identifier derivation.** Needs to be unique per published `φ` and recoverable without owner state. Natural candidate: contract address plus an on-chain re-share counter (or the device epoch), making it deterministic and publicly reconstructable.
2. **Guardian transport and UX.** The scheme is a star topology of single messages and deliberately provides no transport. C15 shrinks from a share-custody-plus-liveness protocol to a request-response messaging problem (how does the owner's client reach the spouse's client, and how does a guardian authenticate a recovery request as legitimate). Guardian authentication of requests remains the main UX-security question, as already recorded in the C14 canvas.
3. **Recovery bootstrap metadata.** Someone must know the guardian identities, indices, threshold, and session identifier at recovery time. All of it is non-secret but socially sensitive (graph privacy, a recorded open question). Options: owner memory plus local brute force, paper slips, or an encrypted metadata blob; to be decided in the recovery-paths MIP.
4. **Domain separation.** The share-derivation hash, the cold-wallet message tag, and the NITBUSS OWF tag must be registered domain-separated tags in line with the C8 consolidation work.
5. **Formal-methods track.** The community-recovery engagement anchored on ANARKey assumed the computational primitive would be axiomatised in the Agda layer; BUSS is that primitive, and the paper supplies the simulation proof. The correlated-re-share rule and the commitment-instead-of-keypair check are exactly the kind of side conditions the invariant layer should capture.
6. **NITBUSS as v2.** Traceability of leaked shares and non-imputability for guardians, if guardian accountability becomes a requirement; doubles `φ` and adds an owner-held trace key.

## 5. Recommended next steps

1. **Experiment:** port the account-custody prototype's recovery path to BUSS (delete `recovery_shares`, add `φ`, keep the `recover` circuit as is), with membership-change-implies-secret-rotation enforced in the client, and a mixed quorum (people plus a paper key) exercised end-to-end. This is the gating evidence for the standard. **Status: delivered.** The prototype now runs BUSS end-to-end on localnet (guardian passport plus two paper keys, threshold two), with a CLI demo of both ceremonies; see the experiment's DECISIONS.md (C14).
2. **Upstream asks to Pleiades:** typed session identifier (or documented uniqueness contract), `φ` serialisation format, production WASM bindings, zeroisation. File before the git dependency lands anywhere that matters.
3. **Draft the recovery-paths MIP** the custody MIP explicitly awaits, anchored on BUSS for social and cold recovery, with the challenge window, session-identifier scheme, and metadata bootstrap specified, and DeRec-style helper custody demoted to a substitutable alternative.
4. **Cryptographer review:** commitment-based final check, session-identifier scheme, and the correlated-re-share analysis in §3a.

## References

- ANARKey: A New Approach to (Socially) Recover Keys. [EPRINT 2025/551](https://eprint.iacr.org/2025/551), to appear at IEEE EuroS&P 2026.
- Traceable Bottom-Up Secret Sharing and Law & Order on Community Social Key Recovery. [EPRINT 2025/2089](https://eprint.iacr.org/2025/2089).
- Pleiades implementation: `github.com/input-output-hk/Pleiades` (local copy under `tmp/Pleiades`).
- Current surface: `experiments/account-custody-prototype/contracts/account.compact`, `docs/plans/components/C14-total-loss-recovery-flow.md`, `docs/plans/components/C15-helper-protocol.md`, `docs/mps-mip/mips/mip-xxxx-account-custody-contract.md` (recovery seam), `docs/mps-mip/mps/mps-asset-custody-model.md`.
