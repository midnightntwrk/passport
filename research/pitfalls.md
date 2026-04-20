# Pitfalls Research — Midnight Passport

**Domain:** Threshold-signing seedless wallets + on-chain naming + privacy-preserving credentials
**Researched:** 2026/04/16
**Confidence:** HIGH (cryptographic and protocol pitfalls backed by disclosed CVEs / eprint papers); MEDIUM (regulatory interpretation, which is evolving); HIGH (operational and UX patterns extracted from this codebase and adjacent ecosystems).

This file is simultaneously (a) a roadmap input — tells `/gsd-roadmap` which phases need deeper research flags — and (b) a partner-facing risk register that justifies our design choices to Midnight Foundation, Lace, and the formal-methods team. Every pitfall is specific to the Passport problem domain; generic "do code review" advice is excluded.

References to requirement IDs come from the project requirements.

---

## Critical Pitfalls

### Pitfall C1: FROST signing-set equivocation (FROST1 / FROST2-CKM unidentifiable abort)

**What goes wrong:**
The original FROST1 protocol (Komlo-Goldberg 2020) allows a malicious coordinator or signer to present different "signing sets" to different honest participants in round 1, producing a signature that looks valid but whose partial-signature contributions cannot be attributed to specific participants. A malicious signer can equivocate on their presignature commitment; honest signers abort, but cannot identify who cheated ("non-identifiable abort"). An attacker controlling n-t honest-looking nodes can grief the network indefinitely without being slashed.

**Why it happens:**
FROST1 fixed the signing set implicitly by coordinator message; no mechanism bound the set into the Schnorr challenge or the partial-signature check. FROST2, FROST2-BTZ, and FROST3 were introduced to tighten this. FROST3 provides **identifiable abort** — any deviating signer is provably guilty. RFC 9591 (September 2024) standardises FROST2 but not FROST3; the ZF-FROST implementation and `bip-frost-dkg` are tracking FROST3 / ROAST for Bitcoin.

**How to avoid:**
- Specify **FROST3 with identifiable abort** in MVP-01; do not ship FROST1. If the reference (NEAR `threshold-signatures`) only implements FROST1 / FROST2 semantics, document that as a known delta and file the protocol patch with the cryptographer.
- Bind the full signing-set commitment (the sorted list of participant indices) into the challenge hash `c = H(R, pk, message, signing_set)`. This is the one-line change that lifts FROST2 toward FROST2-BTZ robustness.
- Consider ROAST as the robustness wrapper — it tolerates asynchronous disruptors at the cost of extra signing rounds. Trade-off: ROAST has higher latency; for the MVP (end-of-June demo over a reliable test committee) FROST3 is sufficient, ROAST is optional for a post-MVP production posture.

**Warning signs:**
- A Byzantine-sim test where one node sends inconsistent commitments and the protocol completes *with a valid signature* (should abort) or aborts but cannot name the cheater (non-identifiable).
- Any FROST spec draft that omits the signing set from the challenge input.
- Reliance on "coordinator is honest" as an assumption without making the coordinator role trust-minimised.

**Phase to address:** MVP-01 (threshold-signing spec) — this is the protocol the formal-methods team should see first. Also informs MVP-07 (Byzantine test plan).

**Formal methods priority:** **YES, high** — identifiability is a proof obligation, not an implementation detail.

**Production incident:** CertiK "Unidentifiability in Decentralized FROST Implementation" (2023); see sources.

---

### Pitfall C2: Pedersen-DKG threshold elevation (Trail of Bits 2024)

**What goes wrong:**
A malicious DKG participant submits a coefficient-commitment vector of length ≠ `t+1`. Ten deployed implementations — including several FROST libraries — did not check the vector length. The attacker can silently raise the threshold of the generated key, rendering future signing attempts invalid and locking out all honest users. Disclosed by Trail of Bits on 2024/01/03.

**Why it happens:**
Pedersen DKG defines the round-1 broadcast as a polynomial commitment of degree `t`. Implementations trusted the length implicitly. The attack is a one-line omission: no `assert len(commitments) == t+1` on receipt.

**How to avoid:**
- Add an explicit "coefficient-vector length check" in MVP-01 protocol text and in the reference implementation. Write a negative test where a participant sends a `t+2` vector.
- Choose a post-disclosure version of any imported DKG library (NEAR `threshold-signatures`, `frost-dkg`, ZF-FROST). Pin and audit.

**Warning signs:**
- Reviewing DKG code and finding no length assertion on `commitments` arrays.
- Reliance on "honest dealer" assumption (Feldman VSS) vs. the stronger "no honest dealer needed" Pedersen DKG — we want Pedersen, so the check is mandatory.

**Phase to address:** MVP-01 (spec text) + MVP-07 (committee-hardness test).

**Formal methods priority:** **Later** — this is a trivial implementation check; formal methods time is better spent on identifiable-abort and re-sharing soundness.

**Production incident:** Trail of Bits disclosure 2024/02/20 ("Breaking the shared key in threshold signature schemes").

---

### Pitfall C3: Schnorr nonce biasing / reuse leaks the secret

**What goes wrong:**
`s = r + c · sk mod q`. If the attacker obtains two signatures under the same nonce `r` with different challenges, `sk` is recoverable by one subtraction. If the attacker merely obtains many signatures where `r` has a few biased bits (as little as 1–2 bits), a lattice attack (Hidden Number Problem) recovers `sk`. LadderLeak (2020) broke ECDSA with less than one bit of leakage. PuTTY's CVE-2024-31497 recovered a P-521 key from 58 biased-nonce signatures. EUCLEAK (CVE-2024-45678) recovered YubiKey ECDSA keys via electromagnetic-side-channel nonce leakage.

**Why it happens (specific to us):**
`experiments/redjubjub-wallet-rs/src/schnorr.rs` uses `EmbeddedFr::random(&mut OsRng)` for the nonce. `OsRng` is acceptable for nonces *in a normal single-signer context*, but:
- In a threshold setting, `r` is a sum of shares; if any share generator is biased, the sum is biased.
- The nonce is re-used accidentally any time a developer adds a replay fallback that doesn't re-randomise.
- The schnorr.rs `sign_with_nonce` helper (intended for deterministic testing) is an easy foot-gun if it leaks into production code paths.
- We are bound to BLS12-381 Fr (not Ed25519's prime field). *(Source-tree review of `midnight-curves` 0.2.0 on 2026/04/16 confirmed the standard `subtle`-based constant-time primitives are in use — see C4 status note below.)*

**How to avoid:**
- Specify **deterministic nonce derivation** (RFC 6979 / synthetic-nonce a.k.a. "hedged deterministic" — `r = H(sk, message, entropy)`) in MVP-01. Do **not** rely on OsRng alone.
- For threshold signing, follow FROST3 nonce commitment rules exactly; the `d, e` nonce pair structure is there to prevent cross-signing-session nonce reuse.
- Delete `sign_with_nonce` from any library crate; keep it only behind `#[cfg(test)]`.
- ~~Commission an audit of `midnight-curves`' scalar sampling.~~ *(Withdrawn 2026/04/16: source-tree review confirmed `subtle`-based CT primitives are in use throughout `Fr`. See C4 status note.)*

**Warning signs:**
- Any code path that accepts a nonce as parameter in a non-test build.
- `random` on an unaudited field implementation.
- Test vectors that don't include "two signatures, same nonce, different messages → key recovery in one step."

**Phase to address:** MVP-01 (mandate deterministic nonces), MVP-02 (circuit cannot help here — the bias is off-circuit), and pre-MVP remediation of `redjubjub-wallet-rs/src/schnorr.rs`.

**Formal methods priority:** **YES, high** — nonce discipline is the single biggest source of real-world key loss in Schnorr-family schemes. Worth a formal proof that `r` is sampled uniformly and independently per signing session.

**Production incidents:**
- PuTTY CVE-2024-31497 (deterministic nonce with P-521 bias, 58 signatures → full key).
- EUCLEAK CVE-2024-45678 (YubiKey / Infineon side-channel on ECDSA nonce).
- "Biased Nonce Sense" (eprint 2019/023) catalogues cryptocurrency key losses.

---

### ~~Pitfall C4: Non-constant-time scalar arithmetic in `midnight-curves`~~ — VERIFIED NOT AN ISSUE (2026/04/16)

**Status: WITHDRAWN.** Source-tree review of `midnightntwrk/midnight-zk` at the `midnight-curves-v0.2.0` tag found that the JubJub scalar field implementation explicitly uses the standard Rust constant-time primitives:

```rust
// curves/src/jubjub/fr.rs
use subtle::{Choice, ConditionallySelectable, ConstantTimeEq, CtOption};
impl ConditionallySelectable for Fr { ... }
pub fn from_bytes(bytes: &[u8; 32]) -> CtOption<Fr> { ... }
pub fn invert(&self) -> CtOption<Self> { ... }   // marked: "this operation is effectively constant time"
pub fn sqrt(&self) -> CtOption<Self> { ... }
```

The `subtle`-based CT idioms are present throughout the scalar field. The original "not audited / posture unknown" framing was based on the absence of an external audit certificate — not on a source-tree finding. **No mitigation, no scoped review, no Phase impact.**

- **URL (v0.2.0 tag):** <https://github.com/midnightntwrk/midnight-zk/tree/midnight-curves-v0.2.0/curves/src/jubjub>
- **Verified by:** Direct source-tree review on 2026/04/16 in response to a request to point at the GitHub source.
- **Action taken:** This pitfall removed from the `for-vincent.html` deck (24 pitfalls remain, all mitigated). C4 ID retired — do not reuse for a new pitfall (preserves traceability).

> *Historical note: the original C4 framing assumed lack-of-audit ⇒ unknown CT posture. Source review showed the standard `subtle` primitives in use. The lesson recorded in evidence: source-check claims about external dependencies before adding them to a risk register.*

---

### Pitfall C5: Domain-separator reuse / Poseidon collision in challenge hash

**What goes wrong:**
If two protocols hash through the same Poseidon state without distinguishing domain tags, an attacker can extract a valid signature from one context (say, analytics-counter increment) and replay it as a transaction authorisation. `docs/KNOWLEDGE_BASE.md` notes that "persistentHash (Poseidon) security assumptions differ from SHA-256". Poseidon is a permutation, not a hash function; the domain-separation discipline is on the user. Finding C-08 in the onboarding design calls out "Domain separation strings are short and could collide."

**Why it happens:**
- Schnorr challenge hashes, nullifier hashes, name-commit hashes, and analytics nullifiers all use `persistentHash`.
- The Compact circuit in `experiments/redjubjub-wallet/` computes `c = persistentHash(R, pk, color, amount, recipient, tx_count, nonce)`. No explicit domain tag.
- If someone later reuses `persistentHash(pk, action)` for credential nullifiers without a protocol-distinct prefix, a cross-protocol collision becomes plausible.

**How to avoid:**
- Publish a **domain-separation registry** as part of STD-02 or as a sub-section of MVP-01. Every distinct hash usage gets a fixed 6+ byte prefix (`"mn/sign"`, `"mn/null"`, `"mn/name"`, `"mn/attn"`, etc.).
- The registry is version-tagged. Version changes require explicit migration logic.
- The Compact circuit must bind the domain tag *first* in the input vector; field-element prefixes are fine.

**Warning signs:**
- Any `persistentHash(...)` call in a spec or circuit without a leading domain prefix.
- Two protocols that both hash `(pk, counter)` — even if "counter" semantics differ, the hash input is the same.
- A registry that exists as "documentation" but isn't enforced by a linter or a Compact macro.

**Phase to address:** STD-02 (address format — adjacent) and MVP-01, MVP-04 (name registry), ECO-02 (credentials). Add a cross-cutting STD-A (domain-separation registry) to META-01 scope lock.

**Formal methods priority:** **YES, later** — once the registry is stable, a formal separation argument is worth ~1 week of formal-methods time.

---

### Pitfall C6: Fiat-Shamir "Frozen Heart" in signatures-inside-circuits

**What goes wrong:**
The Fiat-Shamir transform turns an interactive proof into a non-interactive one by hashing the public transcript. If the hash input omits any public value from the statement, a malicious prover can forge proofs for random statements. Trail of Bits disclosed this class of vulnerability in April 2022 affecting Bulletproofs (ING, SECBIT, Adjoint), PlonK (Dusk, Iden3, ConsenSys), Spartan, and 30+ other implementations.

**Why this matters to us:**
MVP-02 is "in-circuit threshold-signature verification." The Compact circuit hashes `(R, pk, params)` to derive `c`. The verification `s·G == R + c·pk` only binds what `c` bound. If `c` is derived from a subset of the public inputs (say, the circuit forgets to include the signing-set or the contract address), an attacker can reuse a signature across contexts. Midnight's Halo2 / ZKIR stack uses Fiat-Shamir internally too; drift between "what the circuit hashes" and "what the verifier assumes the circuit hashed" is the exact Frozen Heart pattern.

**How to avoid:**
- For every signature-verification circuit, write a "what's in the challenge" table in the MVP-02 spec. Include: `R`, public key, contract address, tx counter, signing-set digest, domain tag, *every* public parameter the signature must bind.
- Differential test: try replaying a signature with one public input altered — it must fail.
- Commission a Fiat-Shamir review of Midnight's Halo2 fork (`experiments/midnight-ledger/`) as a pre-production step.

**Warning signs:**
- A spec section that lists "public inputs" separately from "challenge-hash inputs" — they must match.
- Any "optional" Fiat-Shamir binding.
- Use of outdated academic references that predate the 2022 disclosure (e.g. Bulletproofs 2017 paper without the errata).

**Phase to address:** MVP-02 (in-circuit verification), ECO-02 (credential proofs).

**Formal methods priority:** **YES, high** — Fiat-Shamir soundness is the textbook proof-assistant use case. The formal-methods team should verify that the circuit hash input is exactly the verifier's expected statement.

**Production incident:** Trail of Bits "Frozen Heart" disclosure series (2022/04/13–2022/04/18), 36 open-source implementations affected.

---

### Pitfall C7: Nullifier collisions & de-anonymisation in privacy-preserving credentials

**What goes wrong:**
In a nullifier-based credential system, a nullifier `n = H(sk, context)` proves "this credential has not been used for *context*" without revealing identity. Three failure modes:
1. **Collision**: two users happen to produce the same `n`. Even a 1-in-2⁸⁰ collision makes a successful double-spend look legitimate (because it validates against the nullifier set) and breaks unlinkability ("why are both users presenting the same nullifier?").
2. **Context confusion**: if `context` is chosen by the verifier and the registry doesn't pin it, a malicious verifier can use the *same* context across sessions to link a user across interactions — the nullifier becomes a persistent tracking id.
3. **Revocation-leaked linkability**: the AnonCreds tails-file pattern — the holder fetches the tails file from the issuer to prove non-revocation, and the fetch itself is trackable. Similarly, merkle-root-update schemes where the user must prove membership in the current root leak "which user" by timing correlation against root updates.

**Why it happens:**
- Designers reuse short domain tags; Birthday bound on 80-bit truncated nullifiers is ~1M users.
- `context` semantics are left to application layer; without a spec, each dApp picks its own.
- The revocation mechanism is specified as "just update the root" without examining *when* and *how* the user observes the update.

**How to avoid:**
- Specify 256-bit nullifiers with full-width domain tags in ECO-02. No truncation.
- Define `context` construction centrally: `context = persistentHash("ctx/", rp_id, action_id, session_id)` — this is the World ID pattern.
- Design revocation for privacy from the start. Options: (a) universal accumulators with ZK non-membership proofs (no tails file), (b) Merkle-root versioning with ZK proof of membership in *a valid recent root* (pre-quantified staleness window), (c) batched root updates so no one user "triggers" an update.
- Model issuer-inference attacks in the spec: what can an issuer learn if it records who fetches tails files / revocation proofs?

**Warning signs:**
- Draft spec uses 64- or 128-bit nullifiers.
- `context` left to implementor choice.
- Revocation mechanism described as "like AnonCreds" without addressing the tails-file privacy issue (eprint 2025/694 flags this explicitly).

**Phase to address:** ECO-02 (credential standard). Deferred to Milestone 2 per PROJECT.md, but the spec outline must already bake these in.

**Formal methods priority:** **YES, when ECO-02 is drafted** — unlinkability is a formal privacy property (indistinguishability game). Priority-2 behind the signing-protocol obligations.

**Production incident:**
- Worldcoin nullifier design explicitly addresses context-isolation (see their whitepaper); earlier Semaphore iterations had cross-app linkability bugs.
- Hyperledger AnonCreds: "Formal Security Analysis of Hyperledger AnonCreds" (eprint 2025/694) documents issuer-level linkability through tails files.

---

### Pitfall C8: DKG bad-actor detection — silent share corruption

**What goes wrong:**
During DKG round 2, each participant `i` sends encrypted shares `f_i(j)` to each participant `j`. If `i` sends a bad share (not consistent with their published polynomial commitment), `j` can detect and raise a complaint. If the complaint protocol is missing or if `j` silently aborts without publishing the complaint, the DKG completes with shares that don't reconstruct to the public key — and nobody knows who cheated.

**Why it happens:**
Educational DKG papers focus on the "happy path." Production implementations sometimes ship with detection but without *attribution* — honest nodes know something is wrong, cannot identify the culprit, and the whole DKG round is re-run with no slashing.

**How to avoid:**
- Specify explicit complaint messages and a complaint-verification step in MVP-01.
- Require Pedersen-VSS (verifiable secret sharing) where each share-recipient can publicly prove a received share is inconsistent with the committed polynomial.
- In the test network, script a malicious node that sends bad shares; verify the committee correctly identifies and excludes it, not just detects and aborts.

**Warning signs:**
- "DKG failed, please retry" error paths that don't name the bad participant.
- Share-consistency check only on the final combined key, not per-dealer.

**Phase to address:** MVP-01, MVP-07.

**Formal methods priority:** **Later** — the soundness of complaint-attribution is worth formal treatment once MVP-01 is stable.

---

### Pitfall C9: Re-sharing exposure window — attacker-controlled nodes and stale shares

**What goes wrong:**
the known-issues log notes: "Monthly re-sharing leaves a month-long exposure window." Concrete scenario: attacker compromises 1 of 5 nodes today, 1 more next week, 1 more the week after. With monthly re-sharing, the attacker accumulates shares from the *same epoch* and reaches threshold before the shares rotate. Re-sharing cadence must be shorter than attacker compromise timeline.

**Why it happens:**
Re-sharing is expensive (bandwidth, coordination, liveness requirements), so operators default to "weekly" or "monthly" for convenience. Silence Laboratories' "Offline Proactive Refresh" targets 30-second refresh as the bar; our MVP-07 has unspecified cadence.

**How to avoid:**
- Specify a re-sharing cadence in MVP-01 that is shorter than any plausible compromise timeline. For the demo committee, **daily** is cheap; for any production posture, 30 s – 5 min.
- Proactive secret sharing (PSS) papers from 2022+ (eprint 2022/1586, 2022/619) provide protocols with tolerable overhead.
- Shares from the previous epoch must be provably unusable after the new epoch completes (otherwise an attacker that collected old shares can still reconstruct).
- Monitor epoch boundaries; a missed refresh should trigger automatic committee rotation.

**Warning signs:**
- Spec language: "shares are refreshed periodically" with no cadence.
- Re-sharing protocol that doesn't include explicit zeroisation of old shares.
- Refresh protocol not run end-to-end in tests.

**Phase to address:** MVP-01, MVP-07.

**Formal methods priority:** **YES, later** — proactive-security proofs are a known target. Priority-3, after identifiable abort and Fiat-Shamir soundness.

---

### Pitfall C10: Passkey / BLS12-381 curve mismatch (S-02 revisited)

**What goes wrong:**
iOS Secure Enclave only supports P-256. Midnight keys are on JubJub (embedded in BLS12-381). Naive designs try to "store the Midnight key in the Secure Enclave" and hit a hard wall. The onboarding design (`secure-onboarding-design.md` S-02) mitigates this by using the Secure Enclave as an **AES-256-GCM wrapper only** — but for the MVP, the Secure Enclave *never holds* the Midnight key at all (the signing network does). The passkey is a WebAuthn credential that authenticates *to the account provider*, not a Midnight-signing credential.

**Why it fails in practice:**
- Product / UX pressure: "Why can't we just put the key on the device?" The cost of a clean "no, the device never holds Midnight key material; the signing network does" narrative is ongoing explanation.
- Android StrongBox has uneven curve support; some OEMs' StrongBox doesn't guarantee even P-256. Fallback paths silently switch to software-only keystore, invisibly weakening the security posture.

**How to avoid:**
- MVP-06 must explicitly frame passkeys as "device authentication credentials" — not Midnight keys. UX copy, documentation, and partner pitch deck must be consistent.
- DEC-01 (on-device crypto refresh) is where BLS12-381 on mobile is revisited; keep it out of the MVP critical path.
- Android: require StrongBox-backed key *and* detect its absence; treat absence as a downgrade and warn the user / admin.

**Warning signs:**
- Engineering proposals framing passkey as "signing the transaction."
- Silent fallback to software keystore when StrongBox unavailable.
- No AAGUID validation on passkey registration (can't prove the passkey came from hardware).

**Phase to address:** MVP-03 (account provider API), MVP-06 (UX spec), DEC-01 (post-MVP).

**Formal methods priority:** **No** — this is a product-framing pitfall, not a protocol pitfall.

**Sources:** Proofpoint passkey downgrade research (2025); FIDO Alliance AAGUID discussions.

---

### Pitfall C11: Account provider becoming implicitly custodial under MiCA / BitLicense

**What goes wrong:**
Even though the account provider never holds a full key (FROST threshold signing), regulators may interpret its combination of (a) authenticating the user, (b) JWT-gating access to the signing committee, and (c) managing recovery via re-binding as *custody*. Under MiCA's CASP framework, "custody and administration of crypto-assets" is a regulated activity. AMF precedent (quoted in our search results): a technology provider that "cannot move assets, even if it manages key orchestration or storage, does not meet the custody test" — but the key word is "cannot." If the provider *can* unilaterally authorise signing (e.g. by issuing a JWT to a signing committee that doesn't validate beyond JWT), it *effectively can move assets*.

**Why it happens:**
- The MVP architecture routes authorisation through the account provider because FROST nodes trust the JWT. This is a pragmatic design choice. But if the FROST nodes *only* check the JWT and don't independently verify user intent (say, by requiring a signed transaction digest from the device), the account provider is load-bearing — compromise of the provider = total custody of every user.
- MiCA Article 75 requires segregation of client assets and either insurance or capital proportional to assets under custody. A "we're just authenticating" narrative may not hold.
- Fireblocks' BitForge disclosure (CVE-2023-33241) showed MPC wallets categorised as non-custodial can still drain funds via implementation flaws — regulators have noticed.

**How to avoid:**
- Legal review before any public MVP demo. Route through IOG legal; tag as META-03 research flag.
- Design the FROST protocol so the signing committee *independently* verifies the user's signed transaction digest (e.g. passkey-signed challenge bound into the Schnorr-challenge hash). This bounds the account provider's power to "I can *deny* a signature but not *forge* one." That property is the difference between custodial and non-custodial in AMF interpretation.
- Document this separation of authority explicitly in MVP-01 and MVP-03 — it's a design feature, not an accident.
- Plan for jurisdiction-specific restrictions: US (BitLicense) may refuse the design even with separation; EU (MiCA) may accept it; UK FCA interpretation pending.

**Warning signs:**
- A whiteboard session where "the account provider signs on behalf of the user" is treated as equivalent to "the user signs via the account provider." They are not.
- Any FROST-node logic that accepts JWT alone (no device-signed transaction digest).
- Legal review deferred to post-MVP.

**Phase to address:** MVP-03 (API contract must be legally reviewed), MVP-07 (ops posture), META-03 (stakeholder narrative must address this).

**Formal methods priority:** **No** — legal classification is not a formal-methods problem. But the protocol's "authority boundary" property *is* amenable to formal treatment, and should be stated as a theorem: "the account provider cannot produce a Schnorr signature without the user's passkey-signed transaction digest."

**Sources:** MiCA custody interpretation (CMS Law 2024); Dfns "Custodial or Non-Custodial Under MICAR"; AMF sub-custody precedent.

---

### Pitfall C12: QR-code onboarding attacks (relay, swap, shoulder-surf, MitM)

**What goes wrong:**
QR onboarding is the seam where Web2 meets Web3. Four documented attack classes:
1. **Relay**: attacker's proxy receives the QR from the user, forwards to a remote accomplice in real time; accomplice completes onboarding and captures the account.
2. **Replay**: attacker captures an old QR (shoulder-surf, photo), reuses it.
3. **QR swap**: the displayed QR is replaced (malicious browser extension, compromised digital signage).
4. **Server-key compromise**: onboarding server key is stolen; attacker forges QR codes that bind to the attacker's keys.

**Why it happens:**
QR content is often "bearer capability" — whoever holds it authenticates. Without channel binding (ECDH tied to the specific device) and timestamp enforcement, any of the four attacks succeed.

**How to avoid (specified in the onboarding design S-03 / P-01 – P-03):**
- Server-authenticated ECDH (QR payload signed with pinned server key).
- 60-second timestamp window; server-side session invalidation on first use.
- 4-digit visual confirmation code displayed on both devices — out-of-band channel for MitM detection. Cannot be relayed without the user noticing.
- Binary-encoded QR (P-14) with deep-link / NFC fallback.

**Additional pitfalls specific to our design:**
- The wishlist's "QR → ECDH → DKG" flow is a multi-round protocol; ECDH downgrade (attacker forces legacy curve) is a real risk. Pin the ECDH curve (X25519 preferred) and reject anything else.
- Visual confirmation code must be presented **after** ECDH, **before** the user commits — otherwise a racing MitM can substitute.

**Warning signs:**
- QR payload without a timestamp.
- No visual confirmation step.
- Server key not pinned (cert pinning + fallback to CT-log monitoring).
- Testing that only covers the happy path — no red-team exercise.

**Phase to address:** MVP-05 (onboarding flow), MVP-06 (UX).

**Formal methods priority:** **YES, later** — channel-binding soundness is a formal property. After MVP-01, this is the second protocol to queue for formal review. Priority-2.

---

### Pitfall C13: Commit-reveal name-registration griefing & homoglyph squatting

**What goes wrong (griefing):**
Commit-reveal is designed against frontrunning: the attacker can see the commit but not the name. But the attacker can *flood* the commit queue, crowding out legitimate commits; or register a commit and never reveal, locking the name for the reveal window; or trigger a fee war by chaining commits at the priority-fee ceiling.

**What goes wrong (homoglyph):**
`аlice.midnight` (Cyrillic) vs `alice.midnight` (Latin) — the user visually cannot tell. ENS hit this for years before adopting ENSIP-15 normalisation. NEAR accounts had the same issue. MetaMask's `ens-homoglyph-warning` issue (#9129) tracks this for the wallet UI.

**Why it happens:**
- Designers focus on the crypto (commit-reveal works!) and miss the queue economics.
- Unicode has ~1000 confusable character pairs; naive ASCII normalisation misses non-ASCII scripts entirely; strict ASCII-only is a UX non-starter for international users.

**How to avoid:**
- MVP-04 (name registry spec) must include: ENSIP-15 normalisation (Unicode NFC + confusable list + mixed-script rejection); per-device-key rate limits (3 commits / 24h) and per-onboarding voucher limits (1 registration); commit expiry with stake forfeit (discourage commit-flooding); dormant-name reclamation (12-month unused reclaim auction as per §4.13).
- Visual similarity warning in the wallet UI (not at the protocol level) — UI catches what normalisation cannot.
- Premium names (< 5 chars) gated by MeID SBT (from ECO-02 credentials) — bot farms can't pass biometric.

**Warning signs:**
- Registry spec that says "implement commit-reveal" without the rate-limiting / dormancy / normalisation subsystems.
- No test for "attacker floods 10,000 commits with bogus reveals" scenario.
- Normalisation done in the app, not enforced by the circuit. The circuit must verify that the revealed name matches its normalised form.

**Phase to address:** MVP-04.

**Formal methods priority:** **No** — ENSIP-15 is a reference specification; implementation correctness is a linting / testing problem.

**Production incident:** Years of ENS homoglyph issues pre-ENSIP-15; MetaMask issue #9129.

---

### Pitfall C14: Credential revocation leaks linkability (AnonCreds tails-file pattern)

**What goes wrong:**
In AnonCreds, holders fetch a tails file from the issuer's server to prove non-revocation in zero knowledge. The fetch itself reveals that *this holder* is interacting with *this issuer* right now — the privacy of the ZK proof is undone by the network-level metadata. Multiple academic analyses confirm this (eprint 2025/694). Any Merkle-root-based revocation scheme has a similar problem: the holder must observe root updates to keep their proofs current, and observation patterns are trackable.

**Why it happens:**
- Revocation is harder than issuance; designers bolt it on after the issuance design is frozen.
- The "obvious" designs (revocation lists, tails files, Merkle-root updates) all have network-layer linkability.

**How to avoid (ECO-02):**
- Prefer universal-accumulator designs with ZK non-membership proofs (no per-holder fetch).
- If tails-like fetches are needed, route through a privacy-preserving fetch mechanism (Tor / anonymous pubsub / batched-fetch) — specified, not left to implementors.
- Batch root updates — no holder "triggers" an update; updates happen on a schedule.
- Explicitly model the issuer-inference attack in the spec's threat model.

**Warning signs:**
- Revocation design specified without a network-layer threat model.
- "Holders fetch the latest revocation state" as a design primitive, without anonymisation.
- No discussion of how frequently holders must re-fetch.

**Phase to address:** ECO-02 (Milestone 2).

**Formal methods priority:** **YES, when ECO-02 is drafted** — unlinkability under revocation is a formal privacy property. Priority-4.

---

### Pitfall C15: GDPR "right to be forgotten" vs. immutable on-chain state (ENS precedent)

**What goes wrong:**
A user registers `alice.midnight` containing their real name. Later they exercise GDPR Article 17 right to erasure. The name, the hash of any off-chain data committed on-chain, the transaction history — none of it can be deleted. GDPR penalties are up to €20M or 4% of global revenue. ENS has wrestled with this for years.

**Why it happens:**
Designers treat "privacy-preserving" (ZK) as equivalent to "GDPR-compliant." They are not. ZK hides content from verifiers; it doesn't let you delete on-chain records.

**How to avoid:**
- **Minimise on-chain PII**: the name registry should map names → public keys, no other metadata. Profile records (avatars, bios) are **off-chain** (CCIP-Read style), so they can be deleted.
- Commit-reveal: the commit is a Poseidon hash of the name + salt; the salt can be destroyed post-reveal, limiting on-chain linkability to "the name in the registry" (which the user chose).
- Framework: where the user has **actively and transparently** placed data on-chain (a name they chose), recital 26 / "public by design" arguments hold; where we infer / collect / link data without consent, they do not.
- Explicit documentation that `alice.midnight` is a public pseudonymous identifier; users should not use real names unless they understand the implication.

**Warning signs:**
- Registry profile records stored on-chain.
- Any design that places user PII on-chain that the user did not explicitly author.
- No privacy notice at registration explaining permanence.

**Phase to address:** MVP-04 (name registry), MVP-06 (UX must surface permanence warning), ECO-02 (credentials must be off-chain / deletable metadata).

**Formal methods priority:** **No** — legal / policy concern.

**Sources:** EU Parliament STOA study "Blockchain and the General Data Protection Regulation" (2019); Cravath & Seattle U analyses (2023).

---

### Pitfall C16: MPC-node availability (t+1 of n offline → signing failure, not security failure)

**What goes wrong:**
With a 3-of-5 FROST committee, if 3 nodes are simultaneously offline (common: cloud provider outage, network partition, coordinated DDoS), users cannot sign *anything*. This is a **liveness** failure, not a **security** failure — no keys are compromised. But to users, "I can't send my money" is indistinguishable from "my money is gone."

**Why it happens:**
- Designers optimise for the security parameter `t` without considering the availability parameter `n - t + 1` nodes worth of simultaneous failure.
- Test committees run on one cloud region / one AZ.
- No graceful degradation (queue signing requests? notify the user? switch to an emergency escape hatch?).

**How to avoid:**
- MVP-07 specifies the availability target and SLA posture for the demo committee. Not production-grade, but explicit.
- Geographic and provider diversity from day one of the demo committee, even with 5 nodes.
- A user-facing status page: "signing network operational / degraded / offline" — the user at least knows why their transaction isn't completing.
- Document the clear distinction between "signing failure" (no key loss) and "security failure" (key compromised) in partner pitch.

**Warning signs:**
- Committee runs on one cloud provider.
- No incident-response runbook.
- User UX shows the same "error" for all failures.

**Phase to address:** MVP-07.

**Formal methods priority:** **No** — ops concern.

---

### Pitfall C17: Proof-server outages block all user transactions

**What goes wrong:**
Scenario 3 of the onboarding design: proof server is down, user cannot generate ZK proofs, cannot submit any transaction. This is a *different* single point of failure than the signing network. Both must be up for a transaction to complete.

**Why it happens:**
- Proof generation is expensive (~18–21s per tx per the onboarding design); a centralised proof server is a cost-saving default.
- Midnight's proof pipeline is currently one-proof-server-per-wallet, but shared infrastructure in practice.

**How to avoid:**
- MVP-07 specifies proof-server redundancy. Multi-region deployment.
- Medium-term: push proof generation to the user device (Stream B of the 3-step plan).
- Short-term: local proof server on the user's desktop/laptop as a demo alternative, so at least the dev team isn't blocked.

**Warning signs:**
- Dev team all hitting one shared proof server during demos.
- No proof-server fallback in SDK retry logic.

**Phase to address:** MVP-07, DEC-01 (long term).

**Formal methods priority:** **No**.

---

### Pitfall C18: Recovery happy-path works, sad-path doesn't

**What goes wrong:**
The demo: user loses device, gets new device, authenticates with passkey (synced via iCloud / Google), signing network re-binds new device to the same distributed key, user is back. Works.

The reality: user loses device, passkey was stored only on that device (not synced; iOS "this device only" default), user has no backup. Or: user has a new device with a fresh iCloud account (common after migration). Or: the account provider is down during recovery. Or: the user types their email wrong at recovery time and can't get the verification message.

**Why it happens:**
- Recovery is hard; teams test the happy path and ship.
- The sad-path often requires human intervention (customer support), and there isn't any.

**How to avoid:**
- MVP-06 defines *at least three* recovery scenarios: synced passkey, fresh device/fresh sync account, lost access to email. Each has a flow end-to-end.
- DeRec social recovery (DEC-02) becomes the *structural* answer — but the MVP needs *some* recovery that isn't DeRec, or it has no recovery at all.
- Explicit "you are locked out" state in the UX — telling the user honestly is better than pretending.
- Recovery tests as a first-class test suite in the prototype repo, not an afterthought.

**Warning signs:**
- No test for "what happens if the user cannot authenticate their passkey?"
- Recovery docs exist only in the happy path.
- Recovery mentioned in partner pitch but not demoed.

**Phase to address:** MVP-03 (account provider recovery API), MVP-06 (UX), DEC-02 (DeRec).

**Formal methods priority:** **No** — UX concern, but the recovery *protocol* (account provider re-binding a new device to the same FROST key) has a security implication worth flagging: whoever controls the recovery can take over the account. C11 (custodial) applies.

---

### Pitfall C19: Device-add flow confusion — user approves attacker's device

**What goes wrong:**
"Add a new device" ceremony: existing device scans QR from new device (or vice versa). If the attacker gets the user to scan the attacker's QR *thinking it's the user's new device*, the attacker is now an authorised device.

**Why it happens:**
- The QR codes are indistinguishable to the user.
- Users often do this step in a hurry ("just set up my new phone").
- Notification fatigue: if the existing device shows "Approve new device?", users click through.

**How to avoid:**
- MVP-05 device-add ceremony includes: (a) display device name / model on both sides, (b) display a visual confirmation code to cross-check before commit (same pattern as C12), (c) rate-limit device additions per account (e.g. max 2 per 24h), (d) require 2FA / biometric on the existing device for the approval itself (not just to unlock the app).
- Security notification after device-add: "A new device was added: iPhone 16 on 2026/04/16 14:23. If this was not you, revoke now."
- Cooldown / grace period: new device cannot sign transactions > X DUST for 24 hours.

**Warning signs:**
- Device-add UX that's just "scan and tap yes."
- No post-add notification.
- No device-add rate limiting.

**Phase to address:** MVP-05, MVP-06.

**Formal methods priority:** **No** — UX + protocol policy.

---

### Pitfall C20: Demo-drive development — the prototype looks better than it is

**What goes wrong:**
The prototype works flawlessly in the weekly demo because:
- It runs on one laptop with no network partition.
- It uses a single-signer FROST substitute (not real threshold).
- Byzantine scenarios are never exercised.
- The signing committee "test nodes" are three processes on the same machine.
- Recovery is the happy path.
- No credential revocation is tested.
- The proof server has pre-warmed circuits.

This looks great week after week. Then, three weeks before end-of-June, it turns out none of the hard cases work and the team has to de-scope in public.

**Why it happens:**
- Weekly-demo cadence rewards surface polish.
- Byzantine tests are 10x the engineering cost of happy-path tests.
- Nobody asks "what would fail?" during demos.

**How to avoid:**
- META-03 explicitly includes a "what we deliberately did not test this week" line in each weekly demo.
- Byzantine-sim harness is a MVP-07 deliverable, not an afterthought. Start week 1.
- Rotate "adversarial demo" weeks: every 4th demo, one member plays attacker and shows what breaks.
- Metrics dashboard distinguishes "prototype works in happy case" from "prototype works under N Byzantine nodes."

**Warning signs:**
- Every weekly demo is a clean pass.
- No slide labelled "what we know doesn't work yet."
- Team phrasing: "that edge case is out of scope for the demo."
- Formal-methods team has nothing to look at because "the protocol is still changing" (re-prioritise the formal-methods plan; see Pitfall M2).

**Phase to address:** META-03 (weekly-demo contract), MVP-07 (operational testing).

**Formal methods priority:** **No** — process concern. But the formal-methods team *is* the antidote to demo-drive development if engaged correctly (see M2).

---

## Meta Pitfalls (standards, adoption, formal methods)

### Pitfall M1: Unilateral MIP design — shelfware

**What goes wrong:**
We draft MIP-5 (connection protocol) in isolation, publish it with our MVP. Lace's wallet team never adopted it because their architecture differs; third-party wallets never adopted it because Lace didn't. The MIP becomes documentation for our prototype — shelfware.

**Why it happens:**
- Standards are most compelling when drafted from a working implementation; but adoption happens through co-authorship.
- Lace contact is uncommitted per PROJECT.md constraints.
- Midnight Foundation timeline / priorities are external.

**How to avoid:**
- META-04 (stakeholder onboarding narrative) is a deliverable, not an afterthought.
- Every MIP draft has a named co-author at a partner org by the time it ships.
- Drafts are reviewed pre-publication by Lace / Midnight Foundation — even if they don't implement, they sign off.
- The Passport prototype itself uses the draft as its own spec; "we use it, do you?" is the adoption pitch.

**Warning signs:**
- MIP draft with no named external co-author.
- Partners see the MIP for the first time at publication.
- No "who builds this" section in the MIP.

**Phase to address:** ECO-01 – ECO-04; META-01 (scope lock) must include partner co-author plan.

**Formal methods priority:** **No** — coordination concern.

---

### Pitfall M2: Formal methods invoked too early — wasted 10× slowdown

**What goes wrong:**
We hand the formal-methods team FROST1 in April; they spend 6 weeks verifying it; in May we switch to FROST3; their 6 weeks of verification is invalid.

**Why it happens:**
Formal methods are 10× slower than normal development. Any protocol change after formal review re-starts the clock. PROJECT.md already calls this out as a constraint.

**How to avoid:**
- META-06 engagement plan has explicit "hand-off criteria": protocol is stable (no changes for 2 weeks), reference implementation compiles, test vectors exist.
- Formal methods work in **layers of stability**: (1) Schnorr verification in-circuit (C6) is stable today — hand off now. (2) FROST3 protocol (C1) after the NEAR library port is validated. (3) Nullifier unlinkability (C7) when ECO-02 outline is frozen. (4) Re-sharing soundness (C9) last.
- Never hand off a protocol that hasn't been red-teamed on paper first.

**Warning signs:**
- Formal-methods team idle while critical-path protocols change weekly.
- Hand-off without written stability criteria.
- Re-doing formal work because a protocol parameter changed.

**Phase to address:** META-06 (formal-methods engagement plan).

**Formal methods priority:** **This is the pitfall *about* formal methods.**

---

### Pitfall M3: Writing standards that describe, rather than constrain, the prototype

**What goes wrong:**
The MIP becomes "whatever the prototype happens to do this week." Other implementors cannot build against it because it changes with every commit, and key invariants (e.g. "the account provider cannot forge signatures") are never stated as theorems.

**Why it happens:**
- Prototype-first is healthy, but the prototype will always be more detailed than the spec.
- Spec authors copy-paste from the prototype without abstracting.

**How to avoid:**
- Every MIP includes a "Protocol Invariants" section stating properties (not code).
- Reference-implementation language is extracted into the spec; prototype-specific choices (library, language, framing) stay out.
- Spec sections are written *by* the prototype team, but *reviewed* by someone who does not have the code in front of them.

**Warning signs:**
- Spec text references "the Rust crate `...`" as the authority.
- No "Invariants" section.
- Spec updates lag the prototype by more than 2 weeks.

**Phase to address:** STD-01, STD-02, all ECO-* MIPs.

**Formal methods priority:** **No** — but the "Protocol Invariants" section is where formal-methods hand-off happens.

---

### Pitfall M4: CAIP namespace drift — defining chain IDs before Midnight is registered

**What goes wrong:**
We define `midnight:testnet-02` as the CAIP-2 chain identifier for the MVP, ship it in MIP-5. Meanwhile the Midnight Foundation registers `midnight` namespace officially in ChainAgnostic/namespaces — possibly with different reference format — and our CAIP identifiers are stale. dApps built against our draft have to change.

**Why it happens:**
- CAIP namespace registration is a PR to ChainAgnostic/namespaces; it's not automatic.
- No single person is tracking it.
- Our standards work moves faster than external registration.

**How to avoid:**
- META-01 (scope lock) includes a line item: "Midnight CAIP namespace — who registers it, when."
- Draft MIP-5 uses a *placeholder* like `{midnight-namespace}:{reference}` until the registration lands, then a search-and-replace.
- If the Foundation doesn't register it in time, we register it (via the CAIP process) with an explicit "authoritative once Foundation confirms."

**Warning signs:**
- MIP-5 uses a specific CAIP string without Foundation sign-off.
- ChainAgnostic/namespaces has no `midnight/` directory.

**Phase to address:** ECO-01 (dApp-wallet connection — this is where CAIP gets used).

**Formal methods priority:** **No**.

---

### Pitfall M5: CIP-process envy — lifting mechanics without governance

**What goes wrong:**
We model MIPs on CIPs (per passport-plan.md). We adopt CIP numbering, CIP sections, CIP discussion format — but we don't have CIP's editors, community-approved authors, or the CIP meetings that resolve disputes. Result: documents look CIP-shaped, but no forum exists to accept / amend / reject them.

**Why it happens:**
CIP mechanics are visible and copyable; CIP governance isn't.

**How to avoid:**
- The standards process for MIPs is an explicit deliverable (open question #1 in passport-plan.md).
- Before any MIP is "accepted," the MIP-0 / MIP-process document defines who accepts it, how.
- Either: (a) adopt CIP governance literally (Midnight becomes a CIP category), (b) design a minimal Midnight-specific process with explicit editors, or (c) fork CIP mechanics into a Midnight Foundation process.
- Engage Midnight Foundation on the choice *before* shipping MIP-1.

**Warning signs:**
- MIP drafts labeled "accepted" without a clear accepting body.
- No MIP-0 document.
- CIP-shaped headers on MIPs with no governance.

**Phase to address:** Prerequisite for STD-01 (so MIP-1 has a process behind it). Update META-01.

**Formal methods priority:** **No**.

---

## Operational / Infrastructure Pitfalls

### Pitfall O1: Upstream SDK version churn (v8.0.2 vs v8.1.0-rc.1)

**What goes wrong:**
`midnight-ledger` is at v8.0.2 in some crates, v8.1.0-rc.1 in `experiments/redjubjub-wallet-rs/`. Transaction deserialisation fails because the proof server expects v8.0.2 format. This is an active known bug (`experiments/redjubjub-wallet-rs/.claude/findings.md`).

**Why it happens:**
Midnight ledger is a research-grade dependency with no API stability. Path dependencies pin to whatever happened to be on disk. Developers update one and not the other.

**How to avoid:**
- Version-lock policy: `Cargo.toml` entries pin to exact versions, no ranges.
- Compatibility matrix documented in the prototype repo root.
- Weekly CI check: proof server version == ledger version.
- Discussion with Midnight team (MVP-07 dependency): obtain a "v8.x API frozen for MVP" commitment.

**Warning signs:**
- Mismatched versions in `Cargo.toml`s.
- Transaction submission errors with "Custom error" numeric codes.

**Phase to address:** Prototype-repo infrastructure (META-07). Immediate: resolve the v8.0.2/v8.1.0-rc.1 deserialisation issue before MVP-02.

**Formal methods priority:** **No**.

---

### Pitfall O2: Monitoring gap — detecting Byzantine nodes without false-positive spam

**What goes wrong:**
A signing node is slow (50% of signing requests time out). Is it Byzantine? Or just poorly provisioned? Or a network issue? If we alert on every timeout, ops is buried in false positives. If we don't alert, a real Byzantine node goes undetected.

**Why it happens:**
"Byzantine" isn't a clean signal; it's a pattern over time. Distinguishing malicious from degraded requires correlation across multiple signals.

**How to avoid:**
- MVP-07 specifies "node health" metrics: availability, signing-share correctness rate, complaint rate (times other nodes accused this node), protocol-abort rate.
- Byzantine-detection is a batch process: a node whose complaint rate is >3σ above committee median for N consecutive epochs is excluded and re-seated.
- Dashboards separate "operational degradation" from "potential Byzantine behaviour" with different SLA response times.

**Warning signs:**
- Single-metric alerting.
- No distinction between "slow" and "wrong."
- No complaint-aggregation mechanism.

**Phase to address:** MVP-07.

**Formal methods priority:** **No**.

---

### Pitfall O3: "Forever key-ceremony" pattern

**What goes wrong:**
Some threshold-crypto networks spend so much operational effort on DKG / re-sharing / committee rotation that feature work stalls. Ops becomes a full-time crypto engineering team just to keep the keys fresh.

**Why it happens:**
- Proactive secret sharing at fast cadence requires reliable network + coordination + incident response.
- Re-sharing failures (even transient) leave the network in ambiguous states.
- Each node software update requires a coordinated rotation.

**How to avoid:**
- MVP-07 explicitly scopes re-sharing for the demo committee (monthly acceptable for a test network; document the production gap).
- Automate DKG / re-sharing end-to-end; if it requires a human in the loop, it will fail.
- Design node software updates to be share-preserving where possible (binary upgrade without DKG).

**Warning signs:**
- Manual runbooks for DKG / re-sharing.
- Team pulled into "crypto ops" rotation on-call.
- More time on key ceremonies than on protocol features.

**Phase to address:** MVP-07 (scoped); full ops is Out of Scope per PROJECT.md.

**Formal methods priority:** **No**.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|---|---|---|---|
| Single-signer "FROST" (stub a single signer as if it were 1-of-1 threshold) for weekly demos | Unblocks in-circuit verification demos | Hides Byzantine behaviour; creates demo-drive blindspot (C20); formal-methods team can't proceed | Only in weeks 1–4 of MVP-01, explicitly labelled in every demo. Hard stop: week 5 must have real 3-of-5. |
| `sign_with_nonce` exposed in library API | Makes deterministic tests trivial | Foot-gun for nonce reuse (C3) | Never — move behind `#[cfg(test)]` immediately |
| Skip ENSIP-15 normalisation in MVP-04 | Ships the name registry faster | Homoglyph phishing from day 1 (C13) | Never |
| Poseidon without domain tags | Fewer field elements per hash | Cross-protocol collisions (C5) | Never — even draft specs should include the prefix |
| v8.0.2 / v8.1.0-rc.1 version mismatch | Lets developers work independently | Transaction deserialisation failure; unreproducible state (O1) | Never — block any PR that introduces a new mismatch |
| 60-byte / 64-bit truncated nullifiers | Smaller on-chain state | Birthday collision at ~1M users; linkability (C7) | Never in specs; only in 1-off analytics counters where collisions are tolerated |
| Account provider as plain-OAuth service with JWT authority | Familiar auth pattern | Custodial liability (C11) | Never without device-signed-digest verification in FROST nodes |
| Pre-warmed proof server (caches circuits to look fast in demo) | Demo looks snappy | Hides the 18–21s proof-gen cost (S-05); users in prod will see full latency | Only in week-1 investor demos; never in UX testing |
| Skip signal-per-participant DKG complaints | Faster DKG path | Can detect but not attribute bad actors (C8) | Never in MVP-01 spec |
| One cloud region for signing committee | Cheap | All 5 nodes simultaneously offline during AWS outage (C16) | Week-1 demos only; week 4 must have geographic diversity |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|---|---|---|
| WebAuthn / passkeys | Treating passkey as "the Midnight key" | Passkey = device-auth credential; Midnight key lives in signing network (MVP); Secure Enclave = AES wrapper only (post-MVP via Stream B) |
| Apple Secure Enclave | Trying to store BLS12-381 key directly | Use for AES-256-GCM wrapping only; BLS material is encrypted |
| Android StrongBox | Assuming all certified devices have it | Detect StrongBox availability; treat absence as downgrade; warn or refuse |
| NEAR `threshold-signatures` | Adopting it without checking FROST variant | Confirm FROST3 / identifiable abort; check Pedersen-DKG length assertion |
| Midnight `persistentHash` (Poseidon) | Using it as a drop-in SHA-256 | Poseidon is a permutation; requires explicit domain separation; use the registry |
| ~~`midnight-curves 0.2.0`~~ | ~~Treating it as audited~~ | ~~Marked "not audited" by authors; commission scoped review~~ — *Withdrawn 2026/04/16: source-tree review confirmed `subtle`-based CT primitives in use. See C4 status note.* |
| Compact compiler | Trusting `JubjubPoint` equality (`==`) | Known bug in compact-runtime 0.15.0 — post-compile patch required |
| CAIP chain IDs | Inventing one before the namespace is registered | Coordinate with Midnight Foundation; use placeholders until official |
| WalletConnect migration lessons | Reusing v1 patterns (symmetric key in QR, single session) | v2 uses X25519 asymmetric + E2EE; use this as the reference for MIP-5 (ECO-01) |
| AnonCreds-style revocation | Copying tails-file pattern | Use universal accumulators OR anonymise the fetch; model issuer-inference in the spec |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|---|---|---|---|
| Circuit proving time blows up with threshold-signature constraints | Compilation succeeds; prover OOMs; rows >> k=14 | Profile early (MVP-02); use lookup tables; explore proof delegation | At committee size > 5 or credential proofs added |
| Merkle-path size in name registry | Proofs become 20+ hashes; dApp UX degrades | Use cryptographic accumulator (RSA / universal accumulator); off-chain indexing | At ~1M registered names |
| Proof-server serialisation | Transactions fail with deserialisation errors | Version-lock ledger + proof server; compatibility matrix | Already broken (v8.0.2 / v8.1.0-rc.1) |
| ~18–21s proof generation latency | Users abandon slow transactions | Parallel proof generation; progress indicators; server-side pre-computation for subsidised transactions | Already happening; document and mitigate, don't hide |
| Android StrongBox key generation (~9s) | Onboarding UX stalls | Background generation; progress indicator; one-time cost | Week-1 demo on low-end Android |
| Poseidon iteration count inside circuits | Circuit rows grow super-linearly with nested hashes | Minimise nested hashes; batch commitments; use sponge construction correctly | At nullifier + signature + merkle-membership proofs combined |
| Committee re-sharing bandwidth | Network saturation during epoch rotation | Asynchronous proactive secret sharing (eprint 2022/1586); stagger rotations | At committee size > 10 with daily re-sharing |

---

## Security Mistakes (Domain-specific, Beyond OWASP)

| Mistake | Risk | Prevention |
|---|---|---|
| Skipping Pedersen DKG length check | Silent threshold elevation (CVE-2023-33241-adjacent) | Assert `len(commitments) == t+1` per dealer (C2) |
| ~~Variable-time scalar multiplication~~ | ~~Co-tenant timing attack on signing nodes~~ | ~~Audit `midnight-curves`; `subtle` crate; dedicated hardware (C4)~~ — *Withdrawn 2026/04/16: source-tree review of `midnight-curves` 0.2.0 confirms `subtle`-based CT primitives. No additional mitigation required.* |
| Reusing Schnorr nonce | Key recovery in one signature-pair subtraction | Deterministic nonces (RFC 6979 or FROST3 structure); forbid `sign_with_nonce` in non-test builds (C3) |
| Fiat-Shamir hash missing public input | Forged proofs (Frozen Heart class) | Spec "what's in the challenge" table; differential tests (C6) |
| Domain-tag collision in Poseidon | Cross-protocol signature replay | STD-A domain-separation registry with 6+ byte prefixes (C5) |
| Short nullifiers | Birthday collision; unlinkability loss | 256-bit nullifiers with full-width context (C7) |
| Revocation mechanism leaking linkability | Issuer-level tracking defeats ZK privacy | Universal accumulators OR anonymised fetches (C14) |
| QR without channel binding | Relay / MitM onboarding (C12) | Server-authenticated ECDH; visual confirmation code; 60s timestamp |
| Device-add without rate limit | Attacker adds hostile device silently | Max 2 adds / 24h; biometric required for approval; post-add notification (C19) |
| Account-provider JWT is sole authorisation | Compromise = implicit custody (C11) | FROST nodes require device-signed transaction digest independent of JWT |
| No `context`-isolation in nullifier design | Cross-app tracking | World-ID-style `context = H("ctx", rp_id, action, session)` (C7) |
| PII on-chain in name registry | GDPR Article 17 non-compliance (C15) | Names → public keys only; profile records off-chain (CCIP-Read) |
| Treating Compact `JubjubPoint ==` as working | Silent comparison failures | Apply the post-compile patch (documented); file upstream |
| `OsRng` for nonce in a threshold-unaware way | Biased shares aggregate to biased nonce (C3) | FROST3 nonce-pair discipline; hedged deterministic nonces |

---

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---|---|---|
| Recovery sad path undefined (C18) | User locked out permanently | Specify ≥ 3 recovery scenarios in MVP-06; explicit "locked out" UX state |
| Device-add QR looks the same as onboarding QR (C19) | User approves attacker device | Visual confirmation code on both sides; display device model/name |
| Same error message for signing-network down and user-error (C16) | User thinks funds are lost | Status page; distinct error taxonomy; "your funds are safe" explicit messaging |
| No warning on homoglyph name (C13) | User sends to phisher | Wallet UI renders suspicious pairs with warning banner |
| "Weekly demo works" narrative (C20) | Stakeholders think prototype is further along than it is | "What doesn't work yet" slide in every demo |
| Passkey marketed as "your key" (C10) | User assumes device = self-custody | Explicit: "your passkey authenticates you; the signing network holds the key" (phase out with Stream B) |
| 18–21s proof generation with no feedback | User thinks app is frozen | Progressive progress indicator; backgrounded proof generation; DUST estimate shown upfront |
| Name permanence not surfaced at registration (C15) | User registers real name; regrets it; no erasure | "This name is public and permanent" consent screen; pseudonym recommendation |
| No "revoke device" obvious UX | Lost devices retain signing access | One-tap revoke from any other authorised device; default cooldown on new devices |
| Credential disclosure without clear "what you reveal" UX | User over-discloses | Scope preview: "You will prove: age ≥ 18. You will NOT reveal: date of birth, country, etc." |

---

## "Looks Done But Isn't" Checklist

For the end-of-June MVP, a weekly demo can pass while any of these is still broken. Verify before claiming MVP.

- [ ] **FROST3 / identifiable abort** (C1): malicious-coordinator test reproduces FROST1 vulnerability on a control run and passes on the MVP run.
- [ ] **Pedersen DKG length check** (C2): negative test with `t+2`-length commitment vector is rejected with a named culprit.
- [ ] **Nonce discipline** (C3): no path in production code uses `sign_with_nonce`; `OsRng` use audited; deterministic-nonce option documented.
- [ ] **Signing-set bound into challenge hash** (C1): differential test — same message, same key, different signing sets → different challenges, not-interchangeable signatures.
- [ ] **Domain separation registry** (C5): every `persistentHash` call in `experiments/` has a prefix; registry document exists.
- [ ] **Fiat-Shamir binding** (C6): circuit hashes every public input in verifier's expected statement; test with altered public input must fail.
- [ ] **Byzantine test harness** (C20): at least 3 Byzantine scenarios (malicious dealer, slow node, equivocating signer) run in CI.
- [ ] **Recovery sad path** (C18): test for "lost device AND lost passkey sync account" runs; outcome documented.
- [ ] **Device-add ceremony** (C19): rate limit enforced; visual confirmation code present; post-add notification fires.
- [ ] **Homoglyph rejection** (C13): ENSIP-15 normalisation enforced in the Compact circuit, not only client-side.
- [ ] **Proof-server redundancy** (C17): at least 2 proof servers running; one can be killed mid-demo without breaking the flow.
- [ ] **Signing-network geography** (C16): committee spans ≥ 2 cloud providers or ≥ 2 geographic regions.
- [ ] **Account provider scope boundary** (C11): FROST nodes reject signing requests without a device-signed transaction digest; JWT alone insufficient.
- [ ] **Ledger version matrix** (O1): v8.0.2 vs v8.1.0-rc.1 deserialisation resolved; CI enforces same version across proof server + ledger + wallet.
- [ ] **Formal-methods hand-off** (M2): at least Schnorr-in-circuit verification handed off with stable spec + reference implementation + test vectors.
- [ ] **MIP stakeholder review** (M1): each draft MIP has a named Lace / Midnight Foundation reviewer.
- [ ] **"What doesn't work yet" slide** (C20): present in every weekly demo deck.

---

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---|---|---|
| C1 (equivocation attack detected) | MEDIUM | Exclude the misbehaving node; redo the signing round; review DKG log for the epoch; consider forced re-sharing |
| C2 (threshold elevation discovered) | HIGH | All signing operations blocked until fresh DKG; audit all recent signatures (re-compute via rebuild); rotate committee |
| C3 (nonce leakage / key recovery) | CRITICAL | Full account migration: new DKG, new public key, registry contract updates `alice.midnight → new_pk`; user-visible; full disclosure |
| C5 (domain-collision signature replay discovered) | HIGH | Patch the hash input; rotate the affected domain (new prefix); revoke credentials issued under old prefix |
| C6 (Frozen Heart-class proof forgery) | CRITICAL | Emergency circuit upgrade; invalidate all proofs generated under old circuit; protocol-level pause |
| C7 (nullifier collision observed in wild) | HIGH | Hard-fork the nullifier scheme; reissue credentials; anonymity-set rebuild |
| C11 (regulator classifies us as custodian) | HIGH (legal) | Accelerate Stream A or Stream B; consider geo-restricting MVP; engage IOG legal |
| C13 (homoglyph phishing incident) | MEDIUM | Blacklist the offending name; push ENSIP-15 updates; user-facing warning banner; PR |
| C15 (GDPR complaint) | HIGH (legal) | Demonstrate minimal on-chain PII; route erasure through off-chain metadata deletion; defend on "user explicitly published" grounds |
| C17 (proof-server outage during demo) | LOW | Switch to local proof server; have a "canned" pre-generated demo as a backup fallback |
| C18 (user permanently locked out) | MEDIUM | Customer support path with identity attestation (DEC-02 DeRec accelerated); post-mortem the recovery gap |
| C19 (attacker-authorised device discovered) | MEDIUM | Immediate device revocation from another authorised device; transaction rollback not possible — but signing pre-attack can be invalidated by fresh DKG |
| O1 (version-mismatch deserialisation failure) | LOW | Already-documented workaround (capture TS SDK bytes); long-term fix is version-lock CI |
| M2 (formal methods invalidated by protocol change) | MEDIUM | Clearly scope the re-verification delta; if protocol change is major, cost is close to full re-verification |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---|---|---|
| C1 FROST equivocation | MVP-01, MVP-07 | Byzantine sim with non-identifiable-abort control run |
| C2 Pedersen DKG elevation | MVP-01 | Negative test with `t+2` commitment vector |
| C3 Nonce bias / reuse | MVP-01, pre-MVP schnorr.rs remediation | Audit report + negative tests |
| ~~C4 Non-constant-time curves~~ | ~~MVP-01 (dependency audit)~~ | ~~Scoped `midnight-curves` side-channel review~~ — *Withdrawn 2026/04/16: source-tree review confirmed `subtle`-based CT primitives.* |
| C5 Domain separator reuse | STD-A (new; in META-01 scope lock), applies to STD-02, MVP-01, MVP-04, ECO-02 | Registry document + CI lint |
| C6 Fiat-Shamir / Frozen Heart | MVP-02, ECO-02 | Differential Fiat-Shamir tests |
| C7 Nullifier collisions / context | ECO-02 | Unlinkability formal argument + 256-bit spec |
| C8 DKG bad-actor detection | MVP-01, MVP-07 | Byzantine test with malicious dealer |
| C9 Re-sharing exposure | MVP-01, MVP-07 | Scheduled epoch-rotation test; zeroisation verification |
| C10 Passkey / curve mismatch | MVP-03, MVP-06 | UX copy review; AAGUID enforcement |
| C11 Custodial classification | MVP-01, MVP-03, MVP-07, META-03 | Legal review pre-demo; protocol invariant "provider cannot forge" |
| C12 QR onboarding attacks | MVP-05, MVP-06 | Red-team exercise covering relay/replay/swap |
| C13 Name squatting / homoglyph | MVP-04 | Homoglyph rejection test; rate-limit test |
| C14 Revocation linkability | ECO-02 | Network-layer threat model in spec |
| C15 GDPR immutability | MVP-04, MVP-06, ECO-02 | Privacy counsel review; on-chain PII audit |
| C16 Committee availability | MVP-07 | Chaos test: simultaneously fail `n - t + 1` nodes |
| C17 Proof-server outage | MVP-07 | Redundancy test |
| C18 Recovery sad path | MVP-03, MVP-06, DEC-02 | Scripted sad-path demos |
| C19 Device-add confusion | MVP-05, MVP-06 | UX test; rate-limit enforcement |
| C20 Demo-drive development | META-03 | "What doesn't work yet" slide every week |
| M1 Unilateral MIP | META-01, META-04 | Named co-author per MIP |
| M2 Formal methods premature | META-06 | Written stability criteria before hand-off |
| M3 Describe-not-constrain specs | All STD-*, ECO-* | "Protocol Invariants" section in every MIP |
| M4 CAIP drift | META-01, ECO-01 | Coordinated registration with Midnight Foundation |
| M5 CIP-process envy | META-01 (pre-STD-01) | MIP-0 / governance document before MIP-1 |
| O1 Version churn | META-07 (prototype-repo contract) | CI matrix of ledger / proof-server / wallet versions |
| O2 Byzantine monitoring | MVP-07 | Per-node complaint rate dashboards |
| O3 Forever key-ceremony | MVP-07 | Automated DKG / re-sharing end-to-end |

---

## Formal-Methods Priority List

Given the formal-methods team is 10× slower than normal development, we can realistically queue 3–5 pieces of formal work during the MVP window. Priority-ordered list of hand-offs:

| Order | Target | Rationale | Hand-off criteria |
|---|---|---|---|
| 1 | **Schnorr-in-circuit verification** (MVP-02) | Already stable (validated in `experiments/redjubjub-wallet*`); low drift risk; Fiat-Shamir soundness (C6) is textbook formal methods. | Spec text + reference circuit + 10+ test vectors stable for 2 weeks |
| 2 | **FROST3 signing protocol with identifiable abort** (C1, MVP-01) | Cornerstone of MVP; equivocation is the highest-impact soundness property; identifiable abort is a formal property. | NEAR library port validated; protocol doc frozen |
| 3 | **Nonce discipline & domain separation** (C3, C5) | Low-effort high-value; these are local properties of the signing algorithm. | Domain-separation registry published |
| 4 | **Account-provider authority boundary** (C11) | "The account provider cannot produce a Schnorr signature without the user's device-signed digest" is a concrete theorem with regulatory value. | MVP-03 API contract stable |
| 5 | **QR channel binding** (C12) | Session-establishment soundness; well-studied in literature (Noise, Signal). | MVP-05 spec text stable |
| 6 (post-MVP) | **Re-sharing soundness** (C9) | Proactive security proofs are known targets but only valuable once re-sharing cadence is chosen. | MVP-07 re-sharing protocol stable |
| 7 (Milestone 2) | **Credential unlinkability under revocation** (C7, C14) | Privacy theorem for ECO-02; complex; queue for Milestone 2. | ECO-02 draft stable |

**Deferred (no formal methods):**
- Homoglyph rejection (C13) — reference-standard compliance testing, not formal.
- GDPR / custodial classification (C11 legal, C15) — legal not formal.
- Demo-drive development (C20) — process not formal.
- Operational monitoring (O2, O3) — ops not formal.
- Version churn (O1) — infrastructure not formal.

---

## Sources

### Production Incidents (primary references)

- Trail of Bits, "Breaking the shared key in threshold signature schemes" — Pedersen DKG threshold-elevation, 2024/02/20. <https://blog.trailofbits.com/2024/02/20/breaking-the-shared-key-in-threshold-signature-schemes/>
- Zcash Foundation, "Pedersen DKG Denial of Service Vulnerability in FROST Distributed Key Generation Successfully Remediated" — 2024. <https://zfnd.org/pedersen-dkg-vulnerability-in-frost-distributed-key-generation-successfully-remediated/>
- Fireblocks, "BitForge: Fireblocks researchers uncover vulnerabilities in over 15 major wallet providers" (CVE-2023-33241) — GG18 / GG20 / Lindell17 threshold signing exploits, 2023/08/09. <https://www.fireblocks.com/blog/bitforge-fireblocks-researchers-uncover-vulnerabilities-in-over-15-major-wallet-providers>
- Trail of Bits, "Coordinated disclosure of vulnerabilities affecting Girault, Bulletproofs, and PlonK" (Frozen Heart) — 2022/04/13. <https://blog.trailofbits.com/2022/04/13/part-1-coordinated-disclosure-of-vulnerabilities-affecting-girault-bulletproofs-and-plonk/>
- PuTTY CVE-2024-31497 — deterministic-nonce biased-nonce attack on ECDSA P-521. <https://eprint.iacr.org/2019/023.pdf> (background) and PuTTY changelog.
- Proofpoint passkey downgrade research — "How Attackers Bypass Synced Passkeys" (2025). <https://thehackernews.com/2025/10/how-attackers-bypass-synced-passkeys.html>
- "Biased Nonce Sense: Lattice Attacks against Weak ECDSA Signatures in Cryptocurrencies" — Breitner & Heninger, 2019 (eprint 2019/023). <https://eprint.iacr.org/2019/023.pdf>
- LadderLeak — "Breaking ECDSA With Less Than One Bit Of Nonce Leakage." <https://eprint.iacr.org/2020/615.pdf>
- CertiK, "Threshold Cryptography II: Unidentifiability in Decentralized FROST Implementation" (2023). <https://www.certik.com/resources/blog/threshold-cryptography-ii-unidentifiability-in-decentralized-frost>

### Specifications and Standards

- RFC 9591 — "The Flexible Round-Optimized Schnorr Threshold (FROST) Protocol for Two-Round Schnorr Signatures," September 2024. <https://www.rfc-editor.org/rfc/rfc9591.html>
- ROAST — Ruffing et al., "Robust Asynchronous Schnorr Threshold Signatures," eprint 2022/550. <https://eprint.iacr.org/2022/550.pdf>
- FROST — Komlo & Goldberg, eprint 2020/852. <https://eprint.iacr.org/2020/852.pdf>
- ENSIP-15 — "Ethereum Name Service Name Normalization." <https://docs.ens.domains/ensip/15> (referenced in onboarding design §4.13)
- CAIP-2 — "Blockchain ID Specification." <https://standards.chainagnostic.org/CAIPs/caip-2>
- RFC 9380 — "Hashing to Elliptic Curves" (hash-to-curve). <https://datatracker.ietf.org/doc/rfc9380/>
- RFC 6979 — "Deterministic Usage of the Digital Signature Algorithm (DSA) and Elliptic Curve Digital Signature Algorithm (ECDSA)."
- W3C WebAuthn Level 3 specification.
- EIP-5192 — Minimal Soulbound NFTs.

### Academic and Industry Analyses

- "Practical Asynchronous Proactive Secret Sharing and Key Refresh," eprint 2022/1586. <https://eprint.iacr.org/2022/1586>
- "Breaking the t<n/3 Consensus Bound: Asynchronous Dynamic Proactive Secret Sharing under Honest Majority," eprint 2022/619.
- "A Formal Security Analysis of Hyperledger AnonCreds," eprint 2025/694 — documents tails-file linkability. <https://eprint.iacr.org/2025/694.pdf>
- "Fast Two-party Threshold ECDSA with Proactive Security," eprint 2024/1831.
- Silence Laboratories, "Offline Proactive Refresh: Strengthening Threshold Signature Wallets." <https://silencelaboratories.com/blog-posts/offline-proactive-refresh-strengthening-threshold-signature-wallets>
- SlashID Blog, "The good, the bad and the ugly of Apple Passkeys." <https://www.slashid.dev/blog/passkeys-deepdive/>
- Worldcoin / World ID Protocol v4 specs. <https://github.com/worldcoin/world-id-protocol/blob/main/docs/world-id-4-specs/README.md>
- CMS Law, "Safeguarding the digital vault: custody and administration of crypto-assets under the new MiCA regulation." <https://cms.law/en/int/publication/legal-experts-on-markets-in-crypto-assets-mica-regulation/safeguarding-the-digital-vault-custody-and-administration-of-crypto-assets-under-the-new-mica-regulation>
- Dfns, "Custodial or Non-Custodial Under MICAR." <https://www.dfns.co/article/custodial-or-non-custodial-under-micar>
- European Parliament STOA, "Blockchain and the General Data Protection Regulation" (2019). <https://www.europarl.europa.eu/RegData/etudes/STUD/2019/634445/EPRS_STU(2019)634445_EN.pdf>
- MetaMask GitHub issue #9129 — ENS homoglyph warning. <https://github.com/MetaMask/metamask-extension/issues/9129>
- WalletConnect v1 → v2 migration reference (symmetric → X25519 asymmetric, session model, E2EE). <https://docs.multiversx.com/developers/tutorials/wallet-connect-v2-migration/>

### Internal References

- the project requirements — project requirements referenced throughout.
- `docs/passport-plan.md` — three-step decentralisation path.
- `docs/mvp-architecture.md` — FROST-on-JubJub MVP architecture; open questions on FROST integration, regulatory posture, federation.
- `docs/KNOWLEDGE_BASE.md` — verified curve / TEE / threshold-crypto facts.
- `docs/reference/machine-investigation/key-flows/secure-onboarding-design.md` — §11 Security Model (S-01 to S-10), §13 Appendix A (C-01 to C-10 crypto findings, P-01 to P-23 protocol findings), §4.13 Name Anti-Abuse.
- the known-issues log — existing concerns catalogue including `experiments/redjubjub-wallet-rs/src/schnorr.rs` cryptographic review gap, v8.0.2 / v8.1.0-rc.1 mismatch, monthly re-sharing concern.
- `experiments/redjubjub-wallet-rs/src/schnorr.rs` — the custom Schnorr signer the project currently uses; `OsRng` nonces, `sign_with_nonce` helper visible in the public API.

---

*Pitfalls research for: Midnight Passport (threshold-signing seedless wallet + on-chain naming + privacy-preserving credentials)*
*Researched: 2026/04/16*
