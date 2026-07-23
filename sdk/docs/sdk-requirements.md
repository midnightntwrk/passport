# Midnight Passport SDK — High-Level Requirements (Draft)

> **Scope of this document.** High-level requirements and design
> principles — the *what* and *why* of the SDK. Detailed component specs,
> architecture, and diagrams are separate documents under `sdk/docs/`.

> **Status:** draft · 2026/07/17
> **Audience:** Passport prototype team, Midnight Foundation, partner wallet
> and dApp developers.
> **Traceability:** each requirement is anchored to a component canvas
> (`[C…]`, [components](../../docs/plans/components/README.md)) or promise (`[P…]`,
> [PROMISES.md](../../docs/plans/PROMISES.md)) so this document inherits
> decisions already recorded there.

## 1. Purpose

The Passport SDK is the primary programmatic surface for Midnight Passport.
It is the **main connector to the Account Custody Contract (ACC, [C1])**:
every capability below is ultimately a mediated interaction with a user's
account object on-chain.

The SDK is an **orchestrator, not a monolith**. It owns the flows and the
interfaces; heavy or trust-sensitive machinery lives behind substitutable
providers.

### 1.1 The Account Custody Contract (ACC)

The **Account Custody Contract** is the centre of the Passport
architecture — the on-chain object that *is* the user's account. Identity
in Passport is the ACC, not any key: keys are revocable authorisers *of*
the account, while the ACC is the durable identity that outlives them.
This inversion is what makes seedless onboarding, multi-device, revocation,
and recovery possible at all ([C1], and the custody model in [C4]).

A single per-user ACC holds:

- the **device set** — the authoriser keys that may act for the account
  ([C5], [C9]);
- the **name binding** — the account's `passport.night` sub-domain ([C2]);
- **grants** — scoped, revocable capabilities issued to dApps and to the
  user's own sessions ([C10], [C11], [C12]);
- the user's **Midnight-native assets**, held statelessly in the contract
  per the resolved custody model ([C4]).

**The SDK interacts primarily with the ACC.** Almost every functional
surface in §3 resolves to a read of, or an authorised state transition on,
the user's ACC — onboarding deploys it, device and grant management mutate
it, recovery re-authorises against it, and dApp connections write grants
into it. Providers (§2.4) sit *beside* this relationship, supplying
authorisers, storage, or settlement; they never replace the ACC as the
seat of the account. Everything downstream in this document should be read
against that centre.

## 2. Design principles

### 2.1 Multiple custody paths, progressive decentralisation

The SDK does not bind to a single custody or authentication path. It
presents multiple options behind stable interfaces and orchestrates
whichever a deployment (or user) selects:

- **Managed path (launch)** — wallet management is delegated to a
  **wallet-infrastructure provider**, which for
  **Midnight** offers an embedded Midnight wallet (WaaS) or connects an
  extension (1am) and supplies auth (social / email / passkey), unified
  balances, external-wallet connectors, on-ramps, and fee abstraction. In
  the prototype's managed flow the provider is the **auth / presence layer
  over the ACC**: it gates the ACC device secret, and ACC contract calls run
  through midnight-js. Detailed surface by surface in §2.6. ([C9] managed
  branch.)
- **Decentralised path (target)** — the passkey-derived on-device key
  (WebAuthn + PRF) is verified directly in-circuit by the ACC ([C1], [C5],
  [C9]). No external provider sits in the trust path.

**Progressive decentralisation is a first-class requirement.** Users start
on the centralised solution and migrate toward decentralised components as
they mature. Because identity lives in the ACC — not in any key — migration
is an *authoriser swap*: add the decentralised device key to the account's
device set, then retire the provider-held authoriser. Account identity,
name, grants, and assets are untouched. The SDK MUST expose this migration
as a supported flow, per path, per process (custody, recovery, signing).

Providers are an option, never a dependency ([P8]'s substitutability:
indexer [C17], helper [C15], sponsor [C24]). The provider-free path MUST
remain viable at every release.

### 2.2 User-presence ceremony on every transaction

**Every transaction confirmation requires a passkey or password ceremony.**
This is not (only) UX policy — it is how the witness-security model works:

- Each connected dApp's private state / witness material is stored
  **encrypted at rest** in wallet local storage ([C16], [C7]).
- The decryption key is derived from the user ceremony — passkey (PRF
  evaluation, preferred) or password (KDF fallback where PRF is
  unavailable).
- Witness decryption therefore *cannot happen* without user presence: no
  silent signing, no ambient authority. A compromised app process without
  the user cannot produce a proof.
- Decrypted witness material is held in memory only for the duration of
  proof generation ([C6], [C7]) and zeroised after.

This holds on **both** custody paths: on the managed path the provider's
enclave enforces the same passkey gate before its key shares participate;
on the decentralised path the ceremony gates local witness decryption
directly.

### 2.3 Signing and external-identity binding

**Account operations verify Schnorr-on-Jubjub in-circuit ([C5],
unchanged for now).** Today Jubjub is the only curve with native Compact
built-ins (`ecMulGenerator`, `ecMul`, `ecAdd`); P-256 / secp256k1 ECDSA
inside a Compact circuit would require foreign-field arithmetic the
language does not *currently* express, at ~15K–25K constraints per
verification against a few hundred native (see
[`p256-passkey-nightstream-prototype.md`](../../docs/reference/machine-investigation/p256-passkey-nightstream-prototype.md)).

> **Landing soon.** ECDSA support is on the roadmap for both Compact and
> the ledger. Once in-circuit ECDSA verification is available at
> acceptable cost, the binding pattern below stops being a workaround and
> becomes a *choice* — external ECDSA identities could then be verified
> directly, or the account primitive itself could move to ECDSA. The
> binding pattern is the correct design **until that lands**, and remains
> valid after it as the cheap-routine-signing option regardless.

The broader ECDSA ecosystem — WebAuthn passkeys (hardware-locked to P-256),
the wallet-infrastructure provider's enclave-held ECDSA key, secp256k1
wallets, secure enclaves, and HSMs — attaches through a **one-time signed
binding** rather than a curve switch:

- **ECDSA is the identity gate, Jubjub is the signing mechanism.** At
  enrolment, the external ECDSA identity signs a binding message
  authorising a Jubjub account key; the binding is committed against the
  ACC as a typed device entry. Routine transactions verify cheap native
  Schnorr — ECDSA never enters the routine proof path.
- **Decentralised path** — the passkey's P-256 credential binds the
  PRF-derived Jubjub device key.
- **Managed path** — the v1 target is that the managed wallet's key
  cryptographically anchors an ACC authoriser (portable, recoverable). In
  the prototype the provider instead *gates* a browser-local device secret
  via a `signMessage` presence gesture (§2.2), and that device secret
  authorises ACC operations in-circuit. See §2.6 for the managed path in
  full and the demo-grade gap to the true binding.
- **External wallets** — an external wallet on any foreign scheme
  (secp256k1, Ed25519) attaches as an authoriser through the same binding;
  this is the mechanism behind external wallet connections (§3.10).

This preserves the account-authorisation MIP draft, the validated
`redjubjub-wallet` / `redjubjub-wallet-rs` experiments, the FROST threshold
profile, and the `midnight-did-jubjub-schnorr` alignment (§3.7), while
giving every ECDSA-native integration a first-class attachment point.

### 2.4 Provider model

Processes the SDK delegates behind provider interfaces:

| Process | Launch provider | Decentralised counterpart | Anchors |
|---|---|---|---|
| Wallet management / signing | Wallet-infrastructure provider — embedded WaaS or extension wallet; auth / presence gate over the ACC device secret (§2.6) | On-device passkey-PRF Jubjub key, in-circuit verification | [C5], [C9] |
| Account recovery | Provider recovery flows | Stateless guardians + paper keys | [C13], [C14], [C15] |
| External wallet connectivity | Wallet-infrastructure provider (wallet connectors, on-ramps) | dApp-connection surface, cross-chain intents | [C23], [C25] |
| Cross-chain (MCS) | Upstream MCS threshold-Schnorr | — (owned upstream) | [C25] |
| Private storage / device-sync | Vendor keystore (native) or shared provider (#58) | Local-only (no cross-device sync) | [C16] · §3.6 |
| Sync / indexing | Hosted indexer | Self-hosted indexer | [C17] |
| Proving | Provider-routed (provider → its proving vendor, proof returned) · direct attested-TEE proof server (prove + broadcast) | In-tab WASM prover (low k) | [C6] · §2.5 |
| Fees / DUST | Capacity Exchange LP marketplace (§3.11) | User-held DUST | [C24] |

**Custody setup — waves.** At launch the wallet-infrastructure provider
holds the anchor key in a **TEE / secure enclave** (single enclave-held
key, passkey-gated). The provider's **MPC / threshold-signature (TSS)
setup — distributed key shares, no single point of assembly — is a
second-wave feature**; it hardens the managed anchor without changing the
§2.3 binding to the on-chain Jubjub key, so it is transparent to the ACC
and to consumers. *On **Midnight** the provider's embedded custody is its
**WaaS wallet** (its embedded-WaaS Midnight connector), which the prototype
uses;
an extension (1am) is the alternative. Either way, in the prototype the
provider is the auth / presence gate over a browser-local device secret, not
yet the cryptographic ACC anchor — see §2.6.*

### 2.5 Proving paths

Proof generation ([C6]) is a **Prover seam** the SDK routes. What crosses
the boundary is the proving *preimage*, which embeds the **witness** — the
secret / key material decrypted under the §2.2 ceremony. Path choice is
therefore a privacy decision first and a performance decision second. The
seam itself is the ledger's two-method `ProvingProvider` (`check`,
`prove`), so every path is drop-in behind one interface; the SDK's
contribution is the routing policy and the attestation check.

**Routing is a k-threshold decision tree**, not a flat menu:

1. **k low enough → in-tab WASM prover.** The `zkir-v2` prover runs in a
   Web Worker on the user's device; the witness **never leaves the device**
   — the strongest privacy posture, and the literal expression of [P8].
   Suited to the small-k circuits (the Night, grant, device, and recovery
   paths — sub-MB keys, seconds); requires one-time per-origin staging of
   SRS slices and keys. Validated end-to-end in the account-custody
   prototype. The k-threshold is a **measured, configurable** value per
   device class, not a constant baked into the SDK.
2. **k too high → remote proving**, two variants:
   - **2a. Provider-routed.** The wallet-infrastructure provider
     routes the proving payload to its remote proof-server vendor and
     returns the **proof**; Passport balances (fees, [C24]) and
     **broadcasts from Passport** (the §2.6 target flow).
   - **2b. Direct remote proof server (prove + broadcast).** Passport calls
     the remote proof server itself; the server proves **and broadcasts the
     transaction**, and Passport **waits for on-chain confirmation** rather
     than receiving the proof back. Passport must hand over everything the
     broadcast needs — which makes fee-balancing order and the fee-payer
     explicit prerequisites ([C24]: who balances and signs fees before the
     server submits — Passport pre-balancing, or a sponsor at the server).

**Attestation (both remote variants).** The witness leaves the device in 2a
and 2b — and in 2b the server additionally sees the full transaction. The
remote prover MUST run in a TEE and the SDK MUST verify remote attestation
(enclave measurement + freshness, against a pinned known-good value)
**before** any preimage is sent. An unattested "TEE prover" is just a
plaintext hosted prover and is not an acceptable path. For 2a the same
requirement applies transitively to the provider's vendor — pin down what
that vendor attests to (§2.6).

Routing inputs remain (a) custody path, (b) circuit k, (c) device
capability, and (d) privacy posture, with a fallback ladder (in-tab →
remote on capability failure). The prover actually used MUST be surfaced
truthfully to the user ("proved in this browser" / "proved in an attested
enclave" / "proved by the provider") — and in 2b, that the transaction was
**submitted by the proof server** — proof provenance is a user-facing
guarantee, not a diagnostic.

### 2.6 The managed path in detail

The decentralised path is specified surface by surface below; this is its
managed counterpart, grounded in the launch provider's actual Midnight
integration.

**Finding — the managed flow executes real ACC contract calls, with the
provider as the auth / presence layer over the ACC (not the contract-call
signer).** Grounded in the prototype's managed flow (branch
`demo/mn-passport-dynamic-flow`, `experiments/account-custody-prototype`).
The provider offers Midnight through *both* extension connectors (e.g.
1am) and an **embedded WaaS wallet**; the prototype uses the embedded WaaS
path. In it, the provider supplies social-login auth, the embedded Midnight
wallet (addresses / balances / keys), and a `signMessage` **presence
gesture**. The ACC **device secret** (the hash-preimage witness) is gated by
that provider login, and ACC contract calls — deploy, deposit, grants,
recover — then run through **midnight-js exactly as on the decentralised
path**, balanced and submitted by the demo's genesis fee wallet (a C24
shortcut) — **the provider is not in the contract-call path at all**. So the
managed path needs only `signMessage` to *authorise* the ACC (the device
secret does the in-circuit auth); it never asks the provider to sign the
contract call. What it leaves unproven is who **balances and submits** the
contract transaction in production — see the reconciliation gap below.

| Surface | Managed path (launch provider) |
|---|---|
| Onboarding | Provider auth (social / email / passkey) via its app context; embedded Midnight wallet via its embedded-WaaS connector (or an extension via its wallet connectors). |
| Custody / signing | ACC device secret gated by the provider login (a `signMessage` gesture); ACC contract calls run via midnight-js. The provider authenticates and holds the embedded wallet; it does **not** sign the contract calls. |
| Addresses | Unshielded `wallet.address`; shielded / DUST via `additionalAddresses`; `getShieldedAddresses()` → coin + encryption public keys. |
| Assets | `getBalances()` / `getShieldedBalance()` / …; `sendBalance({toAddress, amount})`, pool-routed (no cross-pool transfers). |
| Proving | Provider routes to its remote proving vendor (§2.5 path 2a). |
| Ceremony | The provider's `signMessage` / passkey gate (§2.2). |
| External wallets / on-ramps | Provider connectors (§3.10 managed variant). |

**Reconciliation with the ACC — ACC-centric and demonstrated, with one
caveat.** The managed flow produces a real ACC with device-secret auth and
the full contract-call set, so the managed path *is* ACC-centric — one
account model, progressive decentralisation preserved. *Authorisation* is
settled: it is the device secret, not a provider signature, so the provider
never signs the contract call. **But fee-payment and submission are a
separate question the demo dodges:** the contract transaction is balanced
and submitted by the **genesis wallet** (C24 out of scope), *not* by the
provider. So whether the managed (provider-held) wallet can itself
**balance and submit an arbitrary ACC contract transaction** — beyond
`sendBalance` transfers — is **not proven** and is a verify item ([C24]: in
production the managed wallet or a sponsor must pay DUST and submit).

*Remaining gap (the prototype is demo-grade here).* Its device secret is a
**random, browser-local** value merely *gated* by the provider login — not
cryptographically derived from or bound to the provider's key, and not
portable
(cross-browser reconnect deliberately fails). The v1 target is the true §2.3
binding: the managed key cryptographically anchors the ACC authoriser so it
is portable and recoverable, not just an auth gate over a local secret.

**Target managed proving + submit flow (provider remote proof server,
forthcoming).** The provider is working towards incorporating a remote
proof server. Once it lands, the managed path splits cleanly along the
existing seams — no redesign:

1. **Build** — Passport builds the unproven ACC contract call and holds the
   witness (device secret + private inputs).
2. **Prove** — offloaded to the provider's remote proof server
   (`adapter-prover-remote`, §2.5 path 2a) → returns the proof.
3. **Balance / fees** — the provider's embedded wallet (or a sponsor) adds
   DUST fee inputs and signs ([C24]).
4. **Broadcast** — Passport submits the assembled, proven, balanced
   transaction to the node (a trivial submit provider).

The managed path then reduces to **Passport = build + orchestrate +
broadcast; provider = prove (+ fee-pay)**. Two caveats travel with it:

- **Privacy / attestation.** The proving payload embeds the witness, so
  remote proving sends the witness to the provider's prover. This preserves
  privacy only if that prover is an **attested TEE** (§2.5); a plain hosted
  prover is provider-trust. Pin down which the provider's remote proof
  server is.
- **Fees are not proving.** A proof server proves; it does not pay DUST.
  "Just broadcast" holds only once the provider's wallet (or a sponsor) has
  balanced and fee-paid the transaction ([C24]).

## 3. Functional surfaces

### 3.1 Onboarding orchestrator

End-to-end account creation from a single ceremony:

1. **Map the credential** — WebAuthn registration plus PRF evaluation to
   derive key material ([C9]); on the managed path, provider onboarding
   (email / social) followed by passkey creation.
2. **Deploy the ACC** for the new account ([C1]).
3. **Claim the name** — a free, first-come-first-served sub-domain of
   `passport.night` (e.g. `alice.passport.night`) via the upstream name
   service ([C2]).
4. **Anchor the DID** — create the account's `did:midnight` identifier
   (§3.7).

### 3.2 dApp authentication and authorisation

The SDK is the client half of the dApp connection surface:

- Authenticate to third-party Midnight dApps — Sign-In-with-Passport over
  the CAIP-25-shaped, EIP-6963-discoverable connection protocol ([C23]).
- Manage a distinct, **encrypted** private state per dApp ([C16], §2.2).
- OAuth-style access: grant, scope, and revoke capabilities to dApps as
  scoped grants, enforced chain-side ([C10], [C11], [C12]).
- Every dApp-initiated transaction is confirmed by the user ceremony
  (§2.2); the ceremony decrypts only *that dApp's* witness state.

### 3.3 Cross-chain orchestration (MCS)

- Bridge tokens in and out from external networks by producing user-signed
  trade intents and consuming settlement confirmations across the upstream
  Multi-Chain Signature boundary ([C25]).
- The cross-chain machinery is owned upstream; the SDK integrates against
  it. Passport-side integration is sequenced post-v1.0 initial release.

### 3.4 Account recovery

- Drive both recovery paths: lost-device revocation ([C13]) and total-loss
  recovery via stateless guardians and paper keys, over the helper protocol
  ([C14], [C15]).
- On the managed path, recovery is delegated to the provider's flows; on
  the decentralised path it runs against the ACC and on-device key material
  directly. Migration between the two follows §2.1.

### 3.5 Multi-device management

- Add, list, and remove credentials against the account's device set —
  including the 1-of-n / last-device guard ([C1], [C9], [C13]).
- On the decentralised path, device authorisations are verified in-circuit
  by the ACC; on the managed path they are delegated to the provider.

### 3.6 Private local-storage management

- Persist and manage the wallet's encrypted private state on-device:
  wrapped key material, sync state, name ownership, and per-dApp witness
  state ([C16]), plus the view-key / indexer read path ([C17]).
- The encryption envelope is keyed from the user ceremony (§2.2).
- **In scope:** the shared private-storage provider —
  midnightntwrk/passport#58.

**Cross-device sync (backup and recovery).** Local private state must sync
across a user's devices so a replacement device can be provisioned and so
state survives device loss — answering the [C16] open question ("does
wallet state sync, or does each device keep independent storage over a
shared chain-derived view"). Four normative rules:

- **Minimise what syncs.** Only *non-reconstructable* secrets sync —
  chiefly per-dApp witness inputs and recovery material. Anything
  re-derivable is never synced: the device authoriser key is re-derived
  from the passkey PRF (§2.1) and chain-visible state is rebuilt from the
  view-key / indexer ([C17]). This is what keeps the blob at a few KB.
- **Encrypt before sync, under a key the sync channel does not hold.** The
  blob is sealed under the ceremony envelope (§2.2) before it leaves the
  device; the transport sees ciphertext only. Critically, the envelope key
  MUST be independent of any secret that channel already holds — if the
  passkey both derives the envelope key *and* syncs through the same vendor
  account, the vendor holds lock and key together and the end-to-end
  property collapses.
- **Vendor keystore is one adapter, not the mechanism.** Device-vendor sync
  (Apple Keychain synchronizable items / iCloud Keychain; Android Block
  Store or Keystore-backed backup) is attractive — no Passport-operated
  infrastructure, platform E2E encryption, KB-scale items — but it is a
  **native-platform capability**: a browser / PWA cannot write sync blobs
  to it, and it does **not** cross ecosystems (Apple ↔ Android, or either ↔
  web). It is therefore the native adapter behind a **Storage / sync seam**
  whose portable counterpart is the shared private-storage provider (#58);
  the web path uses the latter or accepts no sync. Cross-ecosystem
  multi-device ([P3]) is satisfied only by the portable adapter.
- **Sync is not recovery.** Vendor-synced backup is a convenience and a
  fast-provisioning path; it is not a substitute for total-loss recovery
  ([C14]/[C15]), which must work even when the vendor account is lost. Keep
  C14 as the floor and treat vendor sync as an optimisation layered above
  it — never an undesigned recovery authority.

### 3.7 DID integration

The SDK integrates with the
[`midnight-did`](https://github.com/midnightntwrk/midnight-did) project —
the reference implementation of the **`did:midnight`** method ([C3]):

- **Create / update** — the SDK drives DID operations through
  `@midnight-ntwrk/midnight-did-api`, anchored to the same account the ACC
  represents. DID creation is part of onboarding (§3.1).
- **Resolution** — DID documents resolve via the `midnight-did-resolver`
  services against the indexer; responses follow DID Core
  (`didDocument`, `didResolutionMetadata`, `didDocumentMetadata`).
- **Signature alignment** — `midnight-did` ships
  `@midnight-ntwrk/midnight-did-jubjub-schnorr`; this is the same
  Schnorr-on-Jubjub primitive as [C5]. The requirement is **one signing
  primitive** across ACC authorisation and DID operations — the SDK MUST
  NOT introduce a second key hierarchy for DIDs.
- **Credentials** — verifiable credentials over DIDs are delivered by
  `midnight-verifiable-credentials` and connect to the attestation /
  selective-disclosure components ([C18]–[C21]); the SDK exposes them
  through the same surface.

Open (tracked in [C3]): the exact relationship between
`alice.passport.night`, the ACC address, and the `did:midnight` identifier
— alias vs distinct-layer.

### 3.9 dApp connector (developer-facing)

Passport is **two-sided**. §3.2 is the *wallet* half — the SDK answering
connection requests on behalf of the account. This surface is the **dApp
half**: a lightweight connector a third-party developer imports so their
dApp can rely on Passport — the other end of the same [C23] protocol
(CAIP-25-shaped, EIP-6963-discoverable). The connector lets a dApp:

- **Log in with Passport** — Sign-In-with-Passport / DecentralisedAuth
  ([C23]); the dApp obtains an authenticated `alice.passport.night` session
  and never handles keys.
- **Request scoped grants** — operation × object × bound ([C10]/[C11]),
  approved by the user under the ceremony (§2.2) and enforced on-chain by
  the ACC ([C12]).
- **Have its contract witnesses provisioned from Passport storage** —
  instead of the dApp configuring its own `privateStateProvider`, the
  user's Passport profile supplies witness values when the dApp's
  `witness.ts` runs for a contract execution (the shared private-storage
  provider, midnightntwrk/passport#58, over [C16]).
- **Transfer assets to a Passport account** — pay a Passport user via the
  §3.12 deposit mechanism (resolve the recipient → connect to their ACC →
  call the deposit circuit). The one connector function that is a direct
  chain interaction rather than a C23 message.

**Security framing of witness provisioning (normative).** Passport-supplied
private state MUST be **scoped, consented, and ceremony-gated**: a dApp
reads only the private-state entries the user has granted it, released
under a §2.2 ceremony, never blanket access to the profile. The shared
provider is a Passport-mediated, per-dApp, consented read surface — not a
data handout; otherwise it is a privacy hole.

**Authorisation through-line.** Devices, agents (§3.8), and dApps are all
principals holding scoped grants on the ACC ([C10]/[C11]/[C12]); they
differ only in how the grant is issued and gated — device by passkey
ceremony (§2.2), agent by OWS policy engine (§3.8), dApp by user consent
plus ceremony. One primitive, three issuance paths.

**Packaging.** The connector is a **separate, thin package**
(`@midnight-ntwrk/mn-passport-connect`-shaped) with a minimal dependency footprint and its
own threat model. A dApp MUST NOT pull in the wallet / custody / kernel
core to integrate; the connector speaks the C23 protocol *to* the wallet
across a trust boundary and never links against it.

### 3.10 External wallet connections

Passport connects to a user's **existing wallets**. The initial targets
span three ecosystems and are **not** one integration — they attach by
different mechanisms:

| Wallet | Ecosystem / curve | Connection standard |
|---|---|---|
| Lace | Midnight + Cardano / Ed25519 | Midnight connector · CIP-30 |
| 1am | Midnight | Midnight connector |
| Gero | Midnight + Cardano / Ed25519 | Midnight connector · CIP-30 |
| MetaMask | EVM / secp256k1 | EIP-6963 / EIP-1193 |
| Rabby | EVM / secp256k1 | EIP-6963 / EIP-1193 |
| Phantom | Solana / Ed25519 (+ EVM) | Solana Wallet Standard · EIP-6963 |

This introduces a **wallet-connector client** — Passport connecting *out*
to other wallets — distinct from the dApp connector (§3.9), where Passport
is the wallet connected *to*. One adapter per standard. The connector may be
**provider-supplied** (the wallet-infra provider's connectors, §2.4) or
**direct** — the same managed-vs-decentralised split as custody (§2.1).

**All three integration modes are in scope**; a given wallet may serve more
than one:

- **Bind as identity / authoriser** — a foreign-curve wallet signs a §2.3
  binding and becomes a linked identity (and, via a grant authoriser, an
  authoriser) of the ACC. Enables "connect your existing wallet" onboarding
  and login. Primary for the foreign-curve wallets (MetaMask, Rabby,
  Phantom) and the Cardano identities in Lace / Gero. Generalises §2.3
  beyond ECDSA to any foreign scheme (secp256k1, Ed25519).
- **Fund / bridge** — use the connected wallet to fund the account or move
  assets across chains ([C25] / MCS). Applies to the foreign-chain wallets
  (MetaMask, Phantom, and the Cardano side of Lace / Gero). Midnight-side
  funding lands through the §3.12 deposit mechanism.
- **Coexist / discover** — the Midnight-native wallets (Lace, 1am, Gero) are
  peer wallets; Passport is discoverable alongside them through the same
  connector standard (the §3.9 wallet side) and may import from or hand off
  to them.

The modes are not exclusive per wallet — e.g. Lace can coexist as a Midnight
peer, fund / bridge from its Cardano side, and bind its Cardano identity.
The `adapter-wallet-connect` client (architecture §4.2) feeds all three:
binding → signer / §2.3, funding → [C25], coexistence → the §3.9 surface.
Which mode(s) ship first is a v1 delivery-scope question.

### 3.11 DUST sponsorship — Capacity Exchange

Fees on Midnight are paid in DUST, which is non-transferable — the
zero-DUST user is the [C24] problem. **Capacity Exchange** is the
ecosystem's answer: a DUST-sponsorship marketplace in which liquidity
providers (LPs), running open-source servers, sell DUST capacity so a user
holding zero DUST can still transact. The SDK MUST support it as the
sponsored fill of the **Fee seam** (`adapter-fee-capacity-exchange`), with
user-held DUST as the provider-free default.

**Flow (current upstream design — explicitly pre-launch, not the final
launch workflow):**

1. A dApp action requires DUST the user does not hold.
2. The SDK requests quotes from LPs — **pure API, no on-chain transaction**
   (upstream flags this as critical for launch usability).
3. LPs return quotes: "I'll sponsor X DUST if you pay Y in token Z."
4. The user selects a quote.
5. The LP returns a **partial Midnight transaction**: an intent supplying
   the DUST, plus an intent encoding the payment the LP expects (e.g. a
   zSwap offer / payment leg).
6. The SDK attaches the user's own dApp intent, supplies the input funds so
   the transaction balances, and submits — ceremony-gated (§2.2), since the
   composed transaction spends the user's token Z.

This is intent composition on the ledger's `Intent` primitive — [C24]
already names `dust_actions` as the protocol primitive, and the abstraction
Passport presents over intents is the [C22] workstream. Steps 2–4 are
off-chain; nothing touches the chain until the user commits.

**Adapter requirements** (tracking the upstream "Sponsor" spec, in
progress):

- **One-method surface** — a dApp (or Passport flow) calls one method and
  reliably gets a sponsored transaction back.
- **Quote lifecycle** — expiry, replay protection, and handling for users
  who abandon after selecting a quote.
- **Token filtering** — only offer payment tokens the user actually holds
  (needs the balance surface).
- **LP preferences / whitelists** — which LPs to solicit and trust;
  substitutable per [P8]. Upstream's fast-follow is a wallet-native API
  where preferences make the UX mostly invisible — that wallet-native
  surface is Passport's natural home.
- **Quote-request privacy** — a quote request discloses spend-intent
  metadata (amount class, payment token) to every solicited LP before any
  commitment; solicit the minimum set per the whitelist.
- **Packaging** — upstream ships a JS SDK plus an optional React
  quote-selection component; the adapter wraps the upstream SDK, and the
  official UI may consume or re-brand the selection component (upstream's
  success criterion is that integrators can brand and customise copy).

**Limits and phases:**

- Capacity Exchange solves zero-DUST for a user who holds *some* payable
  token. The fully-empty user at onboarding (ACC deploy + name claim,
  §3.1) still needs a sponsor / faucet answer — [C24] remains open for that
  case.
- **Bridge-assisted payment** (multisig-operated bridge; in principle any
  bridge) is upstream work-in-progress and composes with §3.10's
  fund / bridge mode.
- **Phase 2 (upstream roadmap):** wallet-native sponsor transactions and
  preference management, and **passive LP leasing via auction** — a user
  deposits "DUST rights" into a contract, active LPs bid, and the user
  earns the bid proceeds. For Passport that is a future *earn* surface over
  the user's DUST rights; out of v1 scope, noted so the Fee seam does not
  preclude it.
- Interplay with §2.5 path 2b: a sponsored partial transaction is one
  candidate answer to "who balances and fee-pays before a prove+broadcast
  server submits".

### 3.12 Asset transfers into a Passport account (deposit mechanism)

Because of how the ACC is structured ([C1]/[C4] contract custody), **a
Passport account is not payable by a plain transfer to an address** —
funding it is a **contract call**. The SDK MUST expose, and ecosystem
wallets and dApps MUST support, the following mechanism to send assets to
a Passport user:

1. **Resolve the recipient** — `alice.passport.night` → the user's ACC
   contract address, via the name service ([C2]).
2. **Connect to the user's ACC contract** — using the versioned contract
   bindings and ZK assets (§8.2 artefact; the sender needs the deposit
   circuit's assets to prove the call).
3. **Call the deposit circuit** — `deposit_night` for unshielded assets,
   `deposit_shielded` for shielded coins; the function routes by asset
   type. Deposits are **permissionless by ACC design** — anyone may fund
   an account; no grant, no recipient ceremony, no recipient interaction.

Properties and consequences:

- **The sender pays.** The deposit is the *sender's* transaction: their
  wallet proves, balances, fee-pays (their own DUST or §3.11 sponsorship),
  and submits. The recipient does nothing and need not be online.
- **Heavier than a plain transfer.** A deposit is a proven contract call —
  the sending wallet must fetch the ACC deposit-circuit assets and generate
  a proof. This is standard contract-call support, but wallets that only
  implement address-to-address transfers cannot pay a Passport account —
  which is exactly why this mechanism is normative in the custody MIP and
  an ecosystem-adoption requirement, not an SDK-internal detail.
- **Never present the raw ACC address as a payment address.** Assets sent
  to the contract address *outside* the deposit circuit are held but
  unaccounted (they bypass the ACC's balance bookkeeping — a known
  prototype blind spot). UIs and integrations MUST surface the Passport
  name / deposit flow, not a copyable contract address.
- **Who must implement it:** the dApp connector (§3.9) exposes it as a
  one-call function for dApps (checkout, payouts, refunds); external
  wallets (§3.10) support it natively so their users can pay
  `alice.passport.night`; Passport itself uses the same mechanism for
  Passport→Passport transfers.

Packaging note: the deposit function is a direct chain interaction, not a
C23 wallet message — it rides the typed contract bindings
(`mn-passport-contract`), not the kernel. Surfacing it through the dApp
connector does not breach the "connector never links the core" rule (§3.9):
the contract package is a foundation dependency, not the custody core.

## 4. Reference implementations (UI / App)

The first consumers of the SDK, validating its surface. Tracked as
expectations on the SDK, not as SDK deliverables:

1. **Official UI implementation** built on the Passport SDK (Midnight
   Foundation).
2. **A reference Midnight dApp** integrating via the Passport dApp
   connector (§3.9), exercising Sign-In-with-Passport, scoped-grant
   requests, and Passport-provisioned contract witnesses.

## 5. References

- Components: [components/README.md](../../docs/plans/components/README.md) ·
  Promises: [PROMISES.md](../../docs/plans/PROMISES.md)
- Shared private-storage provider: midnightntwrk/passport#58
- `did:midnight`: <https://github.com/midnightntwrk/midnight-did>
- Wallet-infrastructure provider — enclave / passkey-gated custody at
  launch, MPC / TSS threshold custody in the second wave. Specific provider
  intentionally unnamed here.
