# Feature Research — ARC Passport

**Domain:** Seedless, privacy-preserving Web3 wallet with threshold signing, named accounts, and privacy-preserving credentials
**Researched:** 2026/04/16
**Confidence:** MEDIUM–HIGH (each product anchored to current official documentation; some ecosystem items rely on a single authoritative source and are flagged LOW where relevant)

---

## 0. How To Read This Document

This is an ecosystem landscape for Midnight Passport. It answers the question: *"For each family of features in the wishlist (onboarding UX, named accounts, account model, recovery, credentials, dApp-wallet connection), what exists today, what is table stakes, what is a differentiator, and what is an anti-feature we should not copy?"*

Scope boundary: Passport is a planning-and-standards workspace (see the project requirements). This document is feature *reconnaissance*, not requirements. Requirements decisions that reference these findings live in the project requirements under Active items and in the forthcoming `REQUIREMENTS.md`.

The wishlist we are ruling things in or out against is the 15-section `docs/reference/machine-investigation/key-flows/secure-onboarding-design.md` ("the wishlist" throughout).

---

## 1. Onboarding UX — Comparison Matrix

Products compared: NEAR FastAuth, Privy, Web3Auth, Dynamic, Magic.link, Turnkey, Coinbase Wallet / WaaS / Smart Wallet, Phantom, Rainbow.

| Product | Auth factor(s) at onboarding | Custody model | Multi-device at onboarding? | Gas/fee sponsorship? | Seed phrase shown? | Fallback to QR / deep link / NFC / manual? |
|---------|------------------------------|---------------|-----------------------------|---------------------|-------------------|--------------------------------------------|
| **NEAR FastAuth** | OAuth (Google/Apple) + FastAuth-issued keypair; later superseded by passkey-first signer | Custodial MPC bridge (FastAuth servers) with NEAR multi-key recovery on-chain | No (single device at first; add devices via NEAR multi-key) | Yes (NEAR Meta Tx / relayer) | No | Deep link / web redirect; no NFC |
| **Privy** | Email, SMS, social (Google/Twitter/Apple), passkey, or pre-existing wallet | Non-custodial embedded wallet, TEE-based, distributed key shards; passkeys optional for signing authorisation | Yes — pregenerated wallets + multi-device linking via MFA | Yes (optional; Privy integrates with paymasters, ZeroDev etc.) | No | Email/SMS OTP + passkey + social; no native QR onboarding flow |
| **Web3Auth** (MPC / tKey v2) | OAuth (19+ providers) + device share + backup factor (password, SMS, passkey, authenticator) | Non-custodial 2-of-N MPC (SSS over tKey; partial sigs combined via TSS) | Yes — 2-of-N means any device + backup unlocks | Via partners (Biconomy, ZeroDev) | No | Multiple backup factor types (password, passkey, SMS) |
| **Dynamic** | Email, SMS, social, passkey; wallet is instantly created (no passkey required at first in some flows) | Non-custodial TSS-MPC (Turnkey under the hood for the passkey signer path) | Yes (can authorise new device via existing session + passkey) | Gas sponsorship / paymaster orchestration | No | Email OTP + passkey; mobile deep link |
| **Magic.link** | Email magic link / OAuth / passkey / SSO | Custodial — DKMS: master key inside AWS KMS HSM; scoped credentials after auth-relayer login | Any device that can authenticate | Yes (gas-less patterns via paymasters) | No | Email magic link = primary fallback; no QR |
| **Turnkey** | Passkey-primary (WebAuthn); also email/OAuth | Non-custodial — private keys live in AWS Nitro enclaves, released only with user credential | Yes — sub-organisation per user, passkey per device | Integrations | No | Passkey + OAuth + email |
| **Coinbase Smart Wallet (WaaS)** | Passkey-first (WebAuthn/FIDO2); optional social | Non-custodial MPC (WaaS) OR 4337 Smart Wallet (passkey as WebAuthn signer) | Yes — passkey sync via iCloud/Android Credential Manager; device addition on-chain for Smart Wallet | Yes (Coinbase sponsors gas via Paymaster) | No | Passkey creation in-app; no QR for first-party flow |
| **Phantom** | Seed phrase (import OR generate); shown and required | Non-custodial — keys local to device | Manual import via seed | No (Solana fees paid by user) | **Yes — full 12-word display and "write it down" forcing** | None for onboarding; QR only for dApp connect |
| **Rainbow** | Seed phrase OR hardware wallet; optional iCloud-encrypted backup of seed | Non-custodial — keys local | Manual (import seed on new device) | No | **Yes** | None |

**Sources:**
- [NEAR docs — Access Keys](https://docs.near.org/protocol/access-keys); [NEAR Chain Signatures](https://docs.near.org/chain-abstraction/chain-signatures)
- [Privy docs — passkeys with wallets](https://docs.privy.io/recipes/passkey-server-wallets); [Privy MFA](https://docs.privy.io/guide/react/wallets/embedded/mfa/); [How Privy embedded wallets work](https://privy.io/blog/how-privy-embedded-wallets-work)
- [Web3Auth MPC Architecture](https://web3auth.io/docs/infrastructure/mpc-architecture); [tKey v2 HackMD](https://hackmd.io/@torus/Hyv8HjO8i)
- [Dynamic TSS-MPC blog](https://www.dynamic.xyz/blog/introducing-dynamic-embedded-wallets-with-tss-mpc); [Dynamic mobile passkey embedded wallets](https://www.dynamic.xyz/blog/embedded-wallets-with-passkeys); [Turnkey × Dynamic](https://mirror.xyz/turnkeyhq.eth/r6OrgN6nNbL1NJ3YZXcfpOq1REWl9OatNYYWxKN1-HU)
- [Magic DKMS overview](https://magic.link/docs/wallets/enterprise-features/generalized-dkms); [Magic product security](https://magic.link/docs/home/security/product-security)
- [Turnkey embedded wallets overview](https://docs.turnkey.com/embedded-wallets/overview)
- [Coinbase WaaS MPC paper (Berkeley MPC Deployments)](https://mpc.cs.berkeley.edu/posts/Coinbase-Wallet-as-a-Service/); [Coinbase Smart Wallet announcement](https://www.coindesk.com/tech/2024/02/29/coinbase-adds-smart-wallet-feature-so-lengthy-seed-phrases-arent-needed); [iOS 26 passkey portability](https://www.corbado.com/blog/ios-26-passkeys)

### 1.1 Table Stakes (users / dApp devs leave if these are missing)

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Passkey / WebAuthn onboarding** (no seed shown) | 2025–26 market has standardised on passkey-first; even Coinbase Smart Wallet is passkey-primary. Seed-phrase-first onboarding is the loudest failure mode users reject. | MEDIUM (the crypto is easy; the platform-specific TEE interaction is the work) | Confirms wishlist §2.6 "seedless UX". |
| **OAuth / email as a secondary authenticator** | Every non-Phantom wallet offers this. Recovery and cross-device flows depend on it. | LOW–MEDIUM | Wishlist §6.6 treats social linking as a recovery factor; ecosystem confirms that's the right framing. |
| **Provider-sponsored first transaction** (gas abstraction) | Users arrive with zero fee tokens; every embedded-wallet product sponsors at least the initial tx or offers a paymaster SDK. | MEDIUM | Wishlist §5.6 / §6.5 matches industry norm. |
| **No seed phrase exposure by default** | Phantom and Rainbow are the outliers now, not the norm. | LOW (once passkey + server-side key custody exists) | Wishlist §2.6 is table stakes, not a differentiator. |
| **Progress / latency UX during long operations** | Not a feature per se, but the absence of it drives the #1 abandonment point in every ZK wallet (see wishlist §15.3). | LOW | Must be built into SDK onboarding wrapper (wishlist §5.10 callback contract). |
| **QR as the primary cross-device channel** | Users trained by M-Pesa / WeChat / WhatsApp / iOS handoff expect QR for device-to-device handshakes. | MEDIUM | Wishlist §5.11 already makes QR the default with alternates; ecosystem matches. |

### 1.2 Differentiators (Midnight-specific, not shipped by any comparable product)

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Passkey + threshold signing on a SNARK-friendly native curve (JubJub)** | Unique: every other passkey+MPC wallet signs secp256k1/Ed25519. Nobody today does FROST-on-JubJub with in-circuit signature verification. Enables the "signature consumed inside ZK proof, never on-chain" property. | HIGH | Validated experimentally (`experiments/redjubjub-wallet*`). Wishlist §2.1 + `docs/mvp-architecture.md` cornerstone decision. |
| **QR → passkey → named account → transact in one atomic session with three-wallet (shielded / Night / DUST) derivation** | NEAR, Privy, Coinbase each do one of these; none does all in one atomic ~60-second flow, and none targets a privacy-preserving chain's three address types. | HIGH | Wishlist §6 entire flow. Differentiation comes from *coherence*, not individual parts. |
| **Checkpoint-resume onboarding (§6.5)** | No comparable wallet recovers gracefully from a network drop mid-onboarding. Coinbase / Privy / Web3Auth all force a restart. | MEDIUM | Low cost to implement; high UX win. |
| **Entry point pluralism (QR / deep link / NFC / manual code) funnelling to the same ECDH session** | Coinbase / Magic / Privy only support their primary channel (email, passkey, or injected browser provider). Wishlist §5.11 maps all four to one cryptographic outcome. | MEDIUM | Needed for kiosk, accessibility, and M-Pesa-style "tap to onboard" use cases. |

### 1.3 Anti-Features (do **not** copy from competitors)

| Anti-Feature | Competitor(s) doing it | Why avoid | What to do instead |
|--------------|------------------------|-----------|--------------------|
| **Showing a seed phrase during onboarding** | Phantom, Rainbow, most self-custodial wallets pre-2024 | Single largest source of user loss and phishing; wishlist §2.6 calls it out explicitly. Target demographic (wishlist §15 — M-Pesa user) will drop off. | Seedless UX with TEE-wrapped seed and DeRec recovery. |
| **Custodial-by-default without a self-custody path** | Magic.link (DKMS sits in AWS KMS HSMs the user never controls) | Structural custody in AWS = permanent regulatory/availability tail risk; migration away from it is painful. | MVP is explicitly custodial via the threshold signing network, but with a documented 3-step path to self-custody (see `docs/passport-plan.md`). Publish that path from day one. |
| **Silent scope escalation after initial connect** | CIP-30 `enable()` grants the full API in one step; pre-6963 EIP-1193 flows also escalate silently | On a privacy chain, accidental shielded-address disclosure is unrecoverable. | Progressive authorisation (read → sign → prove), per-scope consent (wishlist §5.9). |
| **Address-type oblivious connection** | WalletConnect v2 default CAIP-10 treats "an address" as one type | Sending shielded tokens to an unshielded address is a protocol error, not a UX mistake. | Extend CAIP-10 with `shielded` / `unshielded` / `dust` qualifier (wishlist §5.9). |
| **"Optional" KYC framing** | Most Web3 onboarding flows with identity components | Wishlist §15.3 reports >70% skip rate in the target demographic, creating a worse second-touch later. | Reframe as "unlock full features" with concrete benefits; make credentials progressive. |
| **Mandating passkey for the first tx** | Phantom-style wallets that block transaction signing behind device unlock every time | Passkey on first transaction is fine; passkey for *every* subsequent one kills the UX. | Function-call keys (NEAR-style) for scoped dApp permissions, within DUST allowance, no per-op prompt (wishlist §7.2). |

---

## 2. Named / Human-Readable Accounts

Products compared: ENS, NEAR named accounts, Lens handles, Farcaster fnames, Unstoppable Domains, SNS (Bonfida, Solana).

| Dimension | ENS | NEAR | Lens | Farcaster fname | Unstoppable | SNS | Wishlist / Midnight |
|-----------|-----|------|------|-----------------|-------------|-----|---------------------|
| **Layer** | App-layer smart contract (EIP-137) | Protocol-level (part of account ID) | Protocol-layer NFT (ERC-721 + namespace separation in V2) | Off-chain registry (`fcast.id` subdomains + on-chain FID registry) | ERC-721 across chains | Solana on-chain program | Compact circuit (app-layer, Poseidon hash) |
| **Hash** | keccak256 recursive namehash | none (names are account IDs) | n/a (NFT token IDs) | n/a | keccak256 | n/a | `persistentHash` (Poseidon) — ZK-friendly |
| **Commit-reveal front-running protection?** | **Yes** (`MIN_COMMITMENT_AGE = 60s`) | No (account creation is atomic) | No (governance-whitelist gate pre-V2; V2 handle NFTs are not commit-reveal) | No (assignment is FID → name server-side) | No | No | **Yes** (same pattern as ENS, adapted for Compact) |
| **Multi-address resolver** | Yes via ENSIP-9 (SLIP-44 coin types) | Chain signatures support cross-chain but name → address is NEAR-only | Not the use case | Not the use case | Yes (multi-chain addresses) | Yes via SNS records | **Native multi-address**: shielded + unshielded + DUST + cross-chain. Only Midnight has privacy-differentiated types by design. |
| **Privacy-aware resolution** | **No** — all resolver records are public | No | No | No | No | No | **Yes** — public / semi-private / private tiers; shielded addr requires ZK auth proof |
| **Reverse resolution** | ENSIP-7 (`addr.reverse`) | Name is the account, so reverse = owner lookup | Profile-level | FID ↔ fname mapping | Yes | Yes via `performReverseLookup` | Design TBD; ENSIP-7-style reverse is the likely path |
| **Subdomains / offchain (wildcard)** | ENSIP-10 + CCIP-Read (EIP-3668) | Sub-accounts (`sub.alice.near`) at protocol level, no wildcard offchain | n/a | fname itself is a wildcard (`*.fcast.id`) resolved via CCIP-Read | Yes | Yes | **Yes** — CCIP-Read wildcard + on-chain registry for top-level (wishlist §4.7) |
| **Renewal / expiry** | Annual, price by length (3-char names premium) | None (one-time NEAR purchase) | V2 handles can be detached and re-attached; no expiry | Reclaimable if unused 60+ days or if name collides with public figure | Annual | Annual for some TLDs | Annual + dormancy-based reclaim (12-month inactivity, 90-day warning, wishlist §4.13) |
| **Anti-squatting** | Length-based premium + auctions | Near-native: first-come-first-served + gas cost | Governance whitelist pre-V2 → open namespace V2 | Human-adjudicated reclaim policy | Length-based premium | Length-based premium | **Combined**: length-based renewal fee + DUST balance requirement + MeID SBT for short names + homoglyph normalisation (wishlist §4.13) |
| **Homoglyph / normalisation** | ENSIP-15 (post-incident retrofit) | Protocol restricts alphabet | Open (per-namespace) | Human review | Varies | Varies | **ENSIP-15 from day one** (Unicode NFC + confusables rejection, normalised client-side AND verified in-circuit) |
| **Soulbound / non-transferable option** | ERC-1155 Name Wrapper + `CANNOT_TRANSFER` fuse | Transferable | V2 separates profile from handle (explicitly transferable) | fname not tradable (off-chain policy) | Transferable NFT | Transferable NFT | **Yes via fuse-style flag** (wishlist §4.9) |
| **Fuses / permission locks** | Yes (Name Wrapper fuses) | n/a | n/a | n/a | n/a | n/a | **Yes** (mirrors ENS fuses) |

**Sources:**
- [ENS CCIP-Read](https://docs.ens.domains/resolvers/ccip-read/); [ENS Name Wrapper fuses](https://docs.ens.domains/wrapper/fuses/); [ENS terminology](https://docs.ens.domains/terminology/); [ENS ETH Registrar](https://docs.ens.domains/registry/eth/)
- [NEAR accounts](https://docs.near.org/concepts/protocol/account-model); [NEAR access keys](https://docs.near.org/protocol/access-keys)
- [Lens Protocol — Handle](https://docs.lens.xyz/docs/handle); [Lens V2 introduction](https://mirror.xyz/lensprotocol.eth/-hJH-2IYSe56rK7IEdwSI17hUWt-paTyAs1r4Zes0uQ)
- [Farcaster ENS Names architecture](https://docs.farcaster.xyz/learn/architecture/ens-names); [FName Registry API](https://docs.farcaster.xyz/reference/fname/api)
- [Solana Name Service Guide](https://sns.guide/faq.html); [SNS subdomains](https://sns.guide/domain-name/subdomains/index.html); [SNS reverse lookup](https://bonfida.github.io/solana-name-service-guide/domain-name/records.html)

### 2.1 Table Stakes

| Feature | Why Expected | Complexity |
|---------|--------------|------------|
| **Commit-reveal registration** | ENS had to retrofit this after years of frontrunning. New-chain name systems without it cede value to flash-bots. | MEDIUM |
| **Multi-address resolution** | Essential for Midnight's three address types; ENS has also normalised this cross-chain. | MEDIUM |
| **Reverse resolution** | Users need "who owns this address?" for address-book UX. | LOW |
| **Renewal / expiry with length-based pricing** | Every mature naming system except NEAR does this. NEAR's one-shot cost gets exploited by speculators. | LOW |
| **Unicode / homoglyph normalisation (ENSIP-15)** | Proven necessary after real-world phishing; wishlist §4.13 already plans for it. | MEDIUM |

### 2.2 Differentiators

| Feature | Value Proposition | Complexity |
|---------|-------------------|------------|
| **Privacy-aware resolution** (public / semi-private / private tiers with ZK auth gate on shielded address) | No existing naming system has this. ENS leaks everything; every other public-chain naming system does too. Midnight can make shielded-address discovery only available to authorised requesters. | HIGH — needs relationship proof primitives the wishlist §4.6 assumes exist |
| **Poseidon namehash for in-circuit verification** | A dApp Compact circuit can verify `persistentHash("alice.midnight") == owner` natively. ENS can't because keccak256 is prohibitively expensive inside a SNARK. | LOW (design decision) |
| **Fuses + soulbound-for-identity opt-in** | ENS has it but optional; Midnight defaults to soulbound for user accounts (prevents identity marketplaces) while keeping transferable names for brands / projects. | MEDIUM |
| **CCIP-Read wildcard for org-issued subnames via the wallet's connection protocol** | Organisations pre-register `newuser.acme.midnight` in their QR onboarding. ENS can do this but needs the dApp to wire up CCIP-Read manually; Midnight's SDK bakes it in. | MEDIUM |

### 2.3 Anti-Features

| Anti-Feature | Competitor(s) | Why avoid | What to do instead |
|--------------|---------------|-----------|--------------------|
| **No frontrunning protection** (Lens V1 pre-whitelist, NEAR, SNS) | Wishlist §4.4 commit-reveal handles this |
| **Public-everywhere resolver** (ENS, SNS, NEAR) | Leaks shielded-address identity metadata, defeats the privacy thesis | Privacy-aware resolution tiers |
| **One-shot flat registration fee** (NEAR: ~1 NEAR forever) | Invites speculation; names become tradeable assets rather than identity artefacts | Annual renewal + length-based multiplier + reclaim auction for dormant names |
| **Human-in-the-loop reclaim policy without cryptographic basis** (Farcaster's "we'll reclaim `@google`") | Unaccountable team authority undermines self-sovereignty claim | Algorithmic reclaim (12 months dormant + 90-day warning, DAO treasury captures proceeds) |
| **Namespace fragmentation** (Lens V2 open namespaces with many `*.lens` variants in use) | Users confused about which handle is canonical | Single top-level `.midnight` (plus `.mn` display alias) until explicit org namespace is added via wildcard |

---

## 3. Multi-Device / Account Model

Products compared: NEAR multi-key accounts, ERC-4337 (Safe, Biconomy, ZeroDev), Ledger device management, Lit Protocol PKP, Privy linked accounts.

| Product | Key model | Scoped / session keys? | Device add flow | Device remove / rotate | Audit trail |
|---------|-----------|------------------------|-----------------|-----------------------|-------------|
| **NEAR multi-key account** | N full-access + M function-call keys per account | **Yes — function-call keys** scoped to (receiver, method list, NEAR allowance) | Signed add-key tx from existing full-access key | Any full-access key can `DeleteKey` any other | On-chain public log of all key adds/removes |
| **ERC-4337 (Safe / Biconomy / ZeroDev)** | Smart account with validator modules; signing key(s) are pluggable (EOA, passkey, MPC) | **Yes — session keys** (validator module with time / contract / function / amount limits, varying by implementation) | On-chain module / validator install | On-chain module revocation | On-chain UserOperation history |
| **Ledger (device-level)** | One seed per device; devices are distinct identities unless seed imported | No (hardware wallet scope) | Seed import or hardware device + app pairing | Manual device disablement | Device-local |
| **Lit Protocol PKP** | Distributed key across Lit nodes; PKP owner NFT grants signing authority; auth methods determine who can call | **Yes — Session Signatures** scoped to resources, expiry, and a specific session keypair; Auth Methods for delegating WebAuthn / OAuth / custom-contract permission | Assign new Auth Method / NFT transfer | Remove Auth Method / transfer NFT | On Lit chain / Ethereum |
| **Privy linked accounts** | One embedded wallet per user + any number of external wallets linked to the same user identity | MFA-gated high-sensitivity ops; some session persistence | Linked accounts (OAuth / wallet connect) tied to the Privy user record | Unlink flow | Privy backend |
| **Wishlist / Midnight** | Multi-key account in Compact circuit (key-set Merkle root); full-access + function-call distinction | **Yes — function-call keys** scoped to (contract, circuit list, DUST allowance) | Existing device signs `add_key` transaction, new device registers its own seed in its own TEE | Any full-access key signs `remove_key` | On-chain, ZK-private keys (only hashes on-chain) |

**Sources:**
- [NEAR access keys](https://docs.near.org/protocol/access-keys); [NEAR function-call keys](https://docs.near.org/blog/benefits-of-multiple-keys)
- [ERC-4337 spec](https://eips.ethereum.org/EIPS/eip-4337); [Safe modular architecture](https://docs.erc4337.io/index.html)
- [Lit Protocol PKPs quick start](https://developer.litprotocol.com/user-wallets/pkps/quick-start); [Lit Session Signatures](https://developer.litprotocol.com/sdk/authentication/session-sigs/intro); [Lit Auth Methods](https://developer.litprotocol.com/user-wallets/pkps/advanced-topics/auth-methods/overview)
- [Privy MFA](https://docs.privy.io/guide/react/wallets/embedded/mfa/)

### 3.1 Table Stakes

| Feature | Why Expected |
|---------|--------------|
| **Multiple keys mapped to one account identity** | NEAR set this bar in 2020; ERC-4337 normalised it on Ethereum in 2023–24. A single-key-per-account wallet is DOA for Web2-style UX. |
| **Scoped session / function-call keys for dApps** | Same: both NEAR and 4337 wallets use this for seamless per-dApp UX. |
| **On-chain add/remove ceremony** | Revocation must survive device loss; off-chain revocation lists defeat self-custody claims. |

### 3.2 Differentiators

| Feature | Value Proposition | Complexity |
|---------|-------------------|------------|
| **Witness-based key authorisation (key never appears on-chain, only its Poseidon hash)** | NEAR stores plaintext public keys; Midnight stores only `persistentHash(domain, key)`. The key itself remains a ZK witness, so on-chain observers cannot link transactions across multiple Midnight Passport accounts that happen to use different hashes of the same underlying seed. | MEDIUM–HIGH |
| **Function-call keys scoped to Compact *circuits*, not just contracts** | 4337 sessions scope to function selectors; NEAR to method names. Midnight can scope to Compact circuit identifiers, which aligns with how privacy-sensitive dApps are structured. | MEDIUM |
| **Device keys never leave their originating TEE; even the seed is re-generated on each new device (no cross-TEE transfer)** | ERC-4337 typically reuses a single signer; NEAR generates fresh keys per device but Ed25519 plaintext. Midnight matches NEAR's ceremony but with TEE-wrapped BLS/JubJub material. | HIGH |

### 3.3 Anti-Features

| Anti-Feature | Example | Why avoid |
|--------------|---------|-----------|
| **Single-key accounts** | Phantom, most Solana wallets, pre-4337 Ethereum EOAs | Losing one device = losing one account |
| **Off-chain session key management** | Some 4337 "paymaster as a service" products keep session key state on their server | Defeats the on-chain recovery story; ambient custodial dependency |
| **Transferring the signing seed between devices** | Seed-phrase-import wallets | Decrypts the seed out of one TEE, crosses the network, re-encrypts in another. Wishlist §6.4 explicitly forbids this. |
| **"MPC" systems where one share is always on a vendor server** | ZenGo 2-of-2 (see §4 below), Dynamic/Turnkey-default | Operational dependency on one vendor = liveness single point of failure |

---

## 4. Recovery

Products compared: seed phrase (baseline), Argent social recovery, Safe recovery modules (Candide), DeRec, Ledger Recover, Torus, ZenGo MPC, iCloud-synced passkeys, NEAR FastAuth MPC recovery, and Web3Auth tKey.

| Product | Recovery primitive | Threshold / factors | Timing controls | PQ transport? | On-chain footprint |
|---------|--------------------|---------------------|-----------------|---------------|--------------------|
| **Seed phrase (baseline)** | 24-word BIP39 | 1-of-1 | None | No | None |
| **Argent (StarkNet)** | Guardian on-chain social recovery | N-of-M guardians (default 1-of-1 then scales; majority for >1) | **48-hour delay**, cancellable | No | On-chain |
| **Safe + Candide Social Recovery Module** | Guardian-initiated recovery | Configurable, e.g. 2-of-3 | Default 14-day delay (configurable) | No | On-chain |
| **DeRec** (protocol, not a product) | Shamir shares of a pre-encrypted blob + Merkle-verifiable shares; helpers can be individuals *or* institutional TEE services | Defaults to (3,5); ≤ M/2 helpers learn nothing | Proactive re-sharing + daily challenge-response + optional time-delays per-helper | **Yes — ML-KEM-768 (FIPS 203)** | Merkle commitment on-chain |
| **Ledger Recover** | Pedersen Verifiable Secret Sharing, 2-of-3 | 2-of-3 custodians (Ledger, Coincover, EscrowTech) + user ID verification to each | KYC gate | No | None (off-chain) |
| **Trezor Shamir Backup (SLIP-0039)** | On-device split | Configurable, e.g. 2-of-3 or 3-of-5 | None | No | None |
| **Torus / Web3Auth tKey** | 2-of-N: device share + network share + backup share | 2 shares required | None | No | None (shares held per helper domain) |
| **ZenGo** | 2-of-2 TSS (device + ZenGo server) + 3FA cloud recovery (biometrics + cloud share + keychain key) | 2-of-2 for signing | 3FA for recovery | No | None |
| **NEAR FastAuth** | MPC service with a "second factor" on-chain key; recovery via OAuth re-auth + MPC network co-operation | MPC quorum + OAuth check | Per-service | No | Key-level recovery on-chain |
| **iCloud-synced passkeys / Apple Credential Manager** | Passkeys sync across Apple devices via end-to-end encrypted iCloud Keychain | 1-of-N Apple devices | None | No (iCloud E2EE only) | None |
| **FIDO Alliance CXP / CXF (2025–26)** | Cross-ecosystem passkey portability (user-initiated move from iCloud to 1Password etc.) | 1-of-1 | User-initiated with biometric | No | None |
| **Wishlist / Midnight** | DeRec (3,5) **plus** multi-key device recovery (any surviving device removes lost one, adds new one on-chain) | DeRec (3,5) with ML-KEM encapsulation + device-level (any N of registered device keys) | Daily verification, 90-day epoch resharing; anomaly detection triggers 24-hour freeze | **Yes — ML-KEM** | Merkle commitment of share set on-chain |

**Sources:**
- [DeRec Alliance — protocol overview](https://derecalliance.org/); [DeRec Protocol spec](https://github.com/derecalliance/protocol/blob/main/protocol.md); [DeRec FAQ](https://derecalliance.org/frequently-asked-questions/)
- [Argent recovery](https://support.argent.xyz/hc/en-us/articles/360007338877-How-to-recover-my-wallet-with-guardians-onchain-complete-guide); [Argent guardians](https://support.argent.xyz/hc/en-us/articles/360008013258-How-to-add-a-guardian-to-your-Argent-Ethereum-wallet); [Safe Social Recovery Module (Candide)](https://safefoundation.org/blog/introducing-candides-social-recovery)
- [Ledger Recover technical overview](https://www.ledger.com/blog/part-1-genesis-of-ledger-recover-self-custody-without-compromise); [Trezor Shamir Backup](https://trezor.io/learn/a/recover-a-wallet-with-shamir-backup)
- [Web3Auth tKey architecture](https://hackmd.io/@torus/Hyv8HjO8i); [ZenGo MPC architecture](https://zengo.com/mpc-wallet/); [ZenGo security model](https://help.zengo.com/en/articles/2603678-how-zengo-security-model-works)
- [Apple passkey security](https://support.apple.com/en-us/102195); [iOS 26 passkey portability analysis](https://www.corbado.com/blog/ios-26-passkeys); [FIDO CXP/CXF analysis](https://www.authsignal.com/blog/articles/passwordless-authentication-in-2025-the-year-passkeys-went-mainstream)

### 4.1 Table Stakes

| Feature | Why Expected |
|---------|--------------|
| **At least one recovery path other than "type your seed"** | 2026 market has moved past paper-seed as the sole recovery; every major consumer wallet offers cloud-sync (passkey), MPC, or social recovery. |
| **Device-level revocation that survives device loss** | Equivalent of "remote wipe". |
| **Clear separation between "one device lost" (common, cheap) and "all devices lost" (rare, expensive)** | Argent, NEAR, 4337 all have this implicitly. Conflating the two produces either too-slow common case or too-weak catastrophic case. |

### 4.2 Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **DeRec specifically** (not just "social recovery") | DeRec is the only social recovery protocol with: Merkle-verifiable shares + ML-KEM post-quantum transport + proactive re-sharing + daily challenge-response + explicit institutional-helper TEE pattern. Argent and Safe only have the "guardians sign" part. | HIGH | The secure-onboarding design explicitly names DeRec as the intended recovery mechanism. |
| **Credential survival across recovery (no re-KYC after loss)** | Every MPC / recovery product either re-issues credentials on recovery or ties them to the device. Midnight's attestation trees are derived from the seed, so recovery restores credentials deterministically without re-verification. See wishlist §10.3. | MEDIUM | Unique. ZenGo, NEAR, Web3Auth all require at least some re-verification. |
| **Two-tier recovery (device-level + seed-level) with DIFFERENT trust assumptions** | Device loss → one key remove + one key add signed on-chain (no DeRec quorum needed). All-devices loss → DeRec 3-of-5. Keeps the common case cheap. | LOW | The separation exists in ERC-4337 but is Midnight-specific in how it maps to witness-based auth. |
| **Anomaly detection on the recovery layer (wishlist §10.6)** | No other recovery system publishes a protocol-level "if 2+ helpers access shares within 1 hour, freeze others for 24 h". Argent's time-delay is the closest. | MEDIUM | Directly addresses the "3-of-5 colluding helpers" attack. |

### 4.3 Anti-Features

| Anti-Feature | Product doing it | Why avoid |
|--------------|------------------|-----------|
| **Seed-phrase export as the *only* recovery** | Phantom, Rainbow, most Solana wallets | See §1.3 |
| **Vendor-only custodial recovery with KYC gate** | Ledger Recover (2-of-3 between Ledger, Coincover, EscrowTech) | Turns self-custody into 2-of-3 managed custody; the trust model it creates is essentially "we'll give your keys back if you re-KYC". Lightning-rod for regulator/auditor objections. |
| **1-of-1 recovery via cloud backup** | Some Web3Auth configurations with only device + network share and weak backup | Single point of compromise; 1-of-1 is fundamentally "password-based recovery". |
| **Re-verify ALL credentials on recovery** | ZenGo (3FA re-captures biometrics); most MPC wallets with session-tied credentials | Creates a "lose phone, lose identity" experience. Wishlist §10.3 avoids this via seed-derived credentials. |
| **Custodial recovery without attestation proof** | NEAR FastAuth's first-version MPC recovery (since improved) | Users cannot verify that the recovering party actually ran the correct code — requires TEE remote attestation for the institutional-helper pattern. |
| **Synchronous recovery with no time delay** | Many early MPC wallets | Compromised factor → instant theft. 48-hour (Argent) / 14-day (Safe) delays give the user time to detect and cancel. |

---

## 5. Privacy-Preserving Credentials & Identity

Products compared: W3C Verifiable Credentials, OpenID4VCI / OpenID4VP, SD-JWT / SD-JWT VC, zkMe (MeID + zkKYC), BrightID, Worldcoin / World ID, Polygon ID / Privado ID / Iden3, Anoncreds (Hyperledger), Midnight attestation trees.

| System | Issuer model | Selective disclosure | Anti-reuse / nullifier | Revocation | On-chain footprint |
|--------|--------------|----------------------|-----------------------|------------|--------------------|
| **W3C VC 2.0** | Any DID-rooted issuer | Format-dependent; with SD-JWT VC or BBS+, yes | None natively (format-dependent) | Status list 2021 / bitstring / other | Off-chain by default; issuer list optionally anchored |
| **OpenID4VCI (RFC Finalised Sep 2025)** | Any credential issuer (OAuth-style authorisation server) | Via underlying format (SD-JWT VC / mdoc / W3C VC) | Via format | Via format | Off-chain |
| **OpenID4VP** | n/a (presentation protocol) | Yes (delegates to format) | n/a | Delegates | Off-chain |
| **SD-JWT / SD-JWT VC (RFC 9901, 2025)** | Any JWT issuer | **Yes — per-claim selective disclosure via hash-and-salt** | Requires key binding JWT + optional nonce; no built-in cross-use nullifier | Status list | Off-chain |
| **zkMe (MeID, zkKYC)** | zkMe is a single (or partnered-network) issuer; SBTs are minted to the user | **Yes — Groth16 ZKP of specific attributes** | ZKP nullifier derived from credential | Merkle root updates | SBT on-chain + FHE biometrics off-chain |
| **BrightID** | Graph-based; anti-Sybil algorithm (SybilRank, Aura) verifies uniqueness | Unique-person bit only | BrightID identifier (per-context, effectively nullifier) | Graph recomputation | Small (per-context ID attestations) |
| **Worldcoin / World ID** | Single issuer (World Foundation, Orb-verified) | Unique-person bit only | **Per (user, app_id, action) nullifier** prevents cross-app linkage | Set membership update | Semaphore anchor on-chain |
| **Polygon ID / Privado ID / Iden3** | Any issuer (Circom-based); Ethereum-rooted DID | **Yes — ZK query language, predicates** | Nullifier via Iden3 claim | Issuer-side; Status Sparse Merkle Tree | Issuer state root on-chain |
| **Anoncreds (Hyperledger)** | Any issuer; uses CL signatures + link secret | **Yes — CL+ZK (native)** + predicate proofs | **Link secret (bound to holder) + per-proof nonce** | Revocation registry | Ledger-anchored |
| **Midnight attestation trees (wishlist)** | Multi-issuer by design (wishlist §8 + §11); domain-separated per credential type | **Yes — ZK proof of Merkle membership + assertion** | **Per-(attribute, secret_key) nullifier** with distinct domain separator from the leaf hash; **unlinkable to leaf** | Merkle root update + epoch counter prevents replay (wishlist §8.7) | Merkle roots + epoch counter + nullifier set on-chain |

**Sources:**
- [OpenID4VCI 1.0 spec](https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html); [OpenID4VP 1.0 spec](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html); [SD-JWT VC draft-15](https://datatracker.ietf.org/doc/draft-ietf-oauth-sd-jwt-vc/)
- [zkMe DID solution](https://www.zk.me/did-solution); [zkMe Omni SBTs on ZetaChain](https://www.zetachain.com/blog/zkme-zkp-soulbound-tokens-omnichain-zetachain); [zkMe zkKYC mechanism explained](https://blog.zk.me/how-zkkyc-works-understanding-the-mechanisms-behind-privacy-preserving-verification/)
- [BrightID whitepaper and overview](https://www.brightid.org/); [DAOrayaki research on BrightID](https://daorayaki.medium.com/daorayaki-reserach-brighid-proof-of-digital-uniqueness-6cf735b2868c)
- [World ID concepts](https://docs.world.org/world-id/concepts); [Worldcoin privacy-preserving PoP protocol](https://world.org/blog/developers/the-worldcoin-protocol); [World privacy deep-dive](https://world.org/blog/developers/privacy-deep-dive)
- [Polygon ID / Iden3 login protocol](https://docs.iden3.io/protocol/zklogin/); [Polygon ID intro](https://polygon.technology/blog/introducing-polygon-id-zero-knowledge-own-your-identity-for-web3)
- [Anoncreds specification](https://hyperledger.github.io/anoncreds-spec/)

### 5.1 Table Stakes

| Feature | Why Expected |
|---------|--------------|
| **Selective disclosure (per-attribute)** | SD-JWT VC is now a finalised RFC (2025) and EUDI Wallet mandates it. Any credential system without selective disclosure is functionally obsolete. |
| **Verifier-side nullifier / reuse prevention** | Necessary for one-per-person airdrops, vote-once gates, anti-Sybil. |
| **Credential revocation** | Required by FATF / eIDAS 2.0 and by any real-world use case (employment credentials, jurisdiction revocations). |
| **Multi-issuer support** | W3C VC, OpenID4VC are explicitly multi-issuer. Single-issuer systems (early zkMe, early Polygon ID) have limited adoption. |

### 5.2 Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Compiler-enforced privacy** (Compact disclosure analysis rejects leaking witnesses at compile time) | No credential system today has this. SD-JWT / OpenID4VP depend on developer discipline; Anoncreds relies on correct CL use. Midnight's Compact compiler makes accidental PII leaks a compile error. | HIGH (but already shipped in Midnight's platform) | Wishlist §8.5 |
| **Nullifier unlinkability to leaf via domain separation** | Most ZK credential systems nullify by hashing the credential itself; observers can correlate the nullifier back to the credential's tree. Midnight's domain-separated nullifier (`"nullf:"` distinct from the leaf domain `"age18:"`) breaks this link. | LOW | Wishlist §8.4 |
| **Credential survival across recovery without re-issuance** | See §4.2 above. Unique. | MEDIUM |
| **Single circuit can prove membership in multiple trees simultaneously** (wishlist §8.2 example) | Batch credentials: "age >= 18 AND EU resident AND accredited" in one proof + one nullifier. SD-JWT requires a separate presentation per credential. | MEDIUM | Platform-level primitive. |

### 5.3 Anti-Features

| Anti-Feature | Example | Why avoid |
|--------------|---------|-----------|
| **Single-issuer lock-in** | Early zkMe (one issuer); early Polygon ID demos (one issuer) | Structural fragility; regulatory capture risk; contradicts wishlist §11 P-10 ("multiple issuer support in attestation tree design"). |
| **Biometric data held by the issuer in plaintext (even transiently)** | Many commodity KYC vendors | Liability magnet. zkMe's FHE biometric pipeline is the right reference. |
| **Credentials that die when the device dies** | MPC wallets with session-tied credentials | Forces re-KYC on every recovery event; wishlist §10.3 avoids this. |
| **PII in SBT metadata** | Some early identity SBT designs | Defeats the privacy guarantee. Wishlist §P-18 keeps SBTs to `{verified: bool, nullifier}`. |
| **On-chain correlation of verifier queries** | ENS-style public resolution combined with credential checks | Every lookup is public state; harvestable. Wishlist §4.6 CCIP-Read for public records avoids this. |
| **Un-revokable credentials** | Some early VC deployments without status lists | Fails regulatory scrutiny; useless for compliance use cases. |
| **Credential formats that cannot verify inside a SNARK** | Raw JWT signatures over RSA/ECDSA on unsuitable curves | Forces out-of-circuit verification = trust boundary. Midnight avoids this by using `persistentHash` (Poseidon) natively. |

---

## 6. dApp-Wallet Connection Protocols

Products compared: WalletConnect v2, EIP-1193 + EIP-6963, CIP-30 (Cardano), SIWE (EIP-4361), SIWF (FIP-11), Sui / Aptos Wallet Standards, Midnight's current dApp connector.

| Feature | WalletConnect v2 | EIP-1193 + 6963 | CIP-30 | Sui / Aptos Wallet Standards | SIWE / SIWF | Wishlist / MCP |
|---------|------------------|-----------------|--------|-----------------------------|-------------|----------------|
| **Discovery** | QR / deep link handshake | `window.ethereum` + EIP-6963 multi-injected announcement events | `window.cardano.{wallet}` namespaced injection | `window` events + Wallet Standard registry | Relay / REST | `midnight:announceProvider` events (EIP-6963 shape) |
| **Multi-wallet resolution** | N/A (direct peer-to-peer via relay) | EIP-6963 events + rdns + uuid | `window.cardano.*` namespace iteration | Wallet Standard registry | n/a | EIP-6963-style |
| **Transports** | WSS relay + QR + deep link | Browser injection only | Browser injection only | Browser injection (plus mobile-specific redirect) | HTTP / relay | **All three**: browser injection + WalletConnect v2 relay + platform deeplink (`midnight://`) |
| **Session / scope model** | CAIP-25 required + optional namespaces | `eth_requestAccounts` all-or-nothing | `enable()` all-or-nothing | `connect()` with features | Message-signing, stateless | **CAIP-25 with Midnight-extended scopes** (`midnight:shielded`, `midnight:unshielded`, `midnight:dust`, `midnight:proof`, `midnight:credential`) |
| **Address types** | Chain-dependent | 1 | 1 primary + reward address | 1 | n/a | **3 (shielded / unshielded / dust) + cross-chain**, with address-type qualifier on CAIP-10 |
| **Async signing coordination** | Relay-native async | No | No | No (sync assumption) | n/a | **First-class `proofId` + `proofProgress` events + `cancelProof`** |
| **Credential disclosure as a first-class method** | No | No | No | No | n/a | **`midnight_proveCredential`** |
| **Privacy scoping / consent gates** | Per-method approve at connect time | All-or-nothing at connect | Same | Same | n/a | **Progressive: read → sign → prove**; per-op consent for sign / prove |
| **Name-based sign-in** | n/a | **SIWE (EIP-4361)** — signs by address | Not by default | Aptos has `signIn` | **SIWE / SIWF** | **SIWM** — resolves `alice.midnight` from registry |
| **Spec formality** | WalletConnect specs | EIP process | CIP process (wide adoption, `CPS-0010` follow-up) | Move community standards | EIP / FIP | Proposed MIP (ECO-01 in project plan) |

**Sources:**
- [WalletConnect v2 namespaces spec](https://specs.walletconnect.com/2.0/specs/clients/sign/namespaces); [CAIP-25](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-25.md); [CAIP-25 migration guidance](https://medium.com/walletconnect/caip-25-implementation-guidance-migrating-to-empty-undefined-required-namespaces-6aa5626a86d9)
- [EIP-6963 spec](https://eips.ethereum.org/EIPS/eip-6963); [EIP-6963 website](https://eip6963.org/)
- [CIP-30 spec](https://cips.cardano.org/cip/CIP-30); [CPS-0010 Wallet Connectors](https://cips.cardano.org/cps/CPS-0010)
- [Sui Wallet Standard](https://docs.sui.io/standards/wallet-standard); [Aptos Wallet Standard](https://aptos.dev/build/sdks/wallet-adapter/wallet-standards)
- [SIWE (EIP-4361)](https://eips.ethereum.org/EIPS/eip-4361); [Sign in with Farcaster / FIP-11](https://github.com/farcasterxyz/protocol/discussions/110)

### 6.1 Table Stakes

| Feature | Why Expected |
|---------|--------------|
| **EIP-6963-style multi-wallet discovery** | Ethereum normalised it; Sui / Aptos copied it; Cardano's `CPS-0010` acknowledges the gap. Single-namespace injection (CIP-30 `window.cardano`) is the old way. |
| **WalletConnect v2 relay + QR as the mobile-dApp bridge** | Any non-browser context needs it. |
| **CAIP-2 chain IDs + CAIP-10 account IDs** | Every new chain that doesn't adopt these ends up writing its own wallet adapter layer. |
| **Sign-in-with-X pattern** | SIWE / SIWF / SIWS established this as the auth primitive; every new chain needs its equivalent. |
| **Per-method approval at sign time** | Post-4337 norm; 4337 wallets moved away from "enable = full api". |

### 6.2 Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Async `proofId` + `proofProgress` + `cancelProof` events** | No existing wallet standard treats the wallet as a long-running proof coordinator. For an 18–21s ZK proof, sync signing is unacceptable. | HIGH | Wishlist §5.9 |
| **`midnight_proveCredential` as a first-class RPC method** | No existing wallet spec has a credential-proof request. `POST /credential_proof` at the app layer is the default today; bringing it into the wallet standard prevents fragmentation. | MEDIUM | Wishlist §5.9 |
| **CAIP-10 extended with `shielded` / `unshielded` / `dust` qualifier** | Genuine extension to CAIP; a Midnight MIP should upstream this as a CAIP-10 addendum. | LOW | Structural necessity on Midnight |
| **Privacy-first defaults** (default address = shielded; deshielding warning; credential minimisation) | Zcash wallets (Zashi, YWallet) have the deshielding warning; no non-Zcash wallet has the full set. | LOW | Wishlist §5.9 |
| **SIWM signs the `.midnight` name, not the address** | SIWE / SIWF sign addresses (plus optional fname for Farcaster). SIWM verifies by querying the registry contract, which is exactly what the naming system gives us for free. | LOW | Wishlist §5.9 |

### 6.3 Anti-Features

| Anti-Feature | Example | Why avoid |
|--------------|---------|-----------|
| **`enable()` grants the entire API at once** | CIP-30, early MetaMask | Privacy-oblivious; defeats the shielded-by-default property. |
| **Single-address connection** | Every non-Midnight connector today | Ambiguous for chains with multiple address types. |
| **Synchronous signing assumption** | All current wallet standards | Blocks the UI thread for 18s of proof generation. |
| **No cancellation primitive** | WalletConnect v2 (at protocol level; implementations improvise) | User abandonment during proof = dead session. |
| **Wallet selection by race condition** | Pre-6963 `window.ethereum` | Multiple browser wallets fight over the injected global. |
| **Out-of-band credential exchange (POST to dApp)** | Every current dApp-credential integration | The wallet can't inspect the disclosure; users can't audit what's being revealed. |

---

## 7. Items on the Wishlist That **NO Existing Product Does Today**

These are the highest differentiation opportunities AND the highest-risk items.

### 7.1 Passkey-authorised threshold signing on a SNARK-friendly embedded curve (FROST-on-JubJub with in-circuit verification)

Combination of: passkey → JWT auth → FROST threshold Schnorr on JubJub → signature consumed inside a Compact circuit → on-chain proof never reveals the signature.

- **Closest precedent**: NEAR FastAuth (MPC + OAuth → ECDSA/EdDSA on non-Midnight curves, signatures visible on target chain). Doesn't consume the signature inside a ZK proof.
- **Why novel**: Every passkey-MPC wallet signs secp256k1 (Bitcoin/EVM) or Ed25519 (Solana). JubJub-FROST is bespoke to Midnight's proof system.
- **Risk**: Formal-methods burden, cryptographer availability (consultative only), NEAR's `threshold-signatures` crate exists but covers the base primitive, not the integration.
- **Evidence status**: JubJub Schnorr single-signer in-circuit verification validated on devnet (`experiments/redjubjub-wallet*`). FROST threshold ceremony not yet tested end-to-end on Midnight (see MVP-07).
- **Confidence**: HIGH that no comparable product exists.

### 7.2 Privacy-aware name resolution with per-record privacy tiers enforced by the resolver

Specifically: a `resolve_shielded(name, auth_proof)` flow where the resolver itself executes a Compact circuit that rejects unauthorised lookups of shielded addresses.

- **Closest precedent**: ENS wildcard/CCIP-Read resolvers (off-chain resolution, but the returned data is still public to the querier). Zcash wallets don't have a naming layer at all.
- **Why novel**: Per-record visibility tiers enforced by circuit (not by social convention or API gating).
- **Risk**: Requires the relationship-proof primitives the wishlist §4.6 assumes — i.e. a way for a requester to prove membership in Alice's "contact tree" without revealing which tree or which entry. This has the shape of an attestation-tree credential but its own lifecycle.
- **Confidence**: HIGH.

### 7.3 Credential system where nullifiers are unlinkable to credential leaves

Most ZK credential systems nullify on the credential hash. Domain separation (`"nullf:"` vs `"age18:"`) breaks the linkage.

- **Closest precedent**: World ID's `(user, app_id, action)` nullifier is unlinkable to the membership merkle tree at the per-action level, but World ID has a single credential (proof of personhood); it doesn't address the multi-credential linkability question.
- **Why novel**: For multi-credential systems (age, residency, accreditation, etc.), no existing implementation has an explicit unlinkable-nullifier construction tied to the platform's native hash function.
- **Risk**: Needs cryptographer review of domain separator scheme.
- **Confidence**: MEDIUM-HIGH (haven't exhaustively surveyed every Anoncreds profile).

### 7.4 Single wallet session coordinating 18–21s async ZK proof generation with progress callbacks and cancellation, integrated into CAIP-25 scope semantics

- **Closest precedent**: WalletConnect v2's relay supports async in principle; no implementation has `proofId`/`proofProgress` as first-class session events.
- **Why novel**: Structural adaptation of CAIP-25 to long-running proof generation. Wishlist §5.9 proposes this as MCP's core contribution.
- **Risk**: Adoption — needs both wallets (Lace, future partners) and dApp-side libraries to implement the event model.
- **Confidence**: HIGH.

### 7.5 Credential survival across seed recovery without re-verification

- **Closest precedent**: None in production. ZenGo, Web3Auth, NEAR FastAuth all require re-verification. Anoncreds' link-secret is conceptually related, but the secret itself must be re-issued if recovered via a new process.
- **Why novel**: The combination of (a) BIP39 seed → HD derivation → credential secret → attestation leaf and (b) DeRec recovery of the seed means a full recovery restores the credential state without interaction with the issuer.
- **Risk**: Depends on (§7.1) and (§7.3) both working.
- **Confidence**: HIGH.

### 7.6 Institutional-TEE DeRec helper with auditable release policy

The wishlist §10.5 pattern: one helper is a server in AMD SEV-SNP running DeRec with a policy engine gating share release. This is described in DeRec Alliance materials as a design pattern but no deployed system implements it.

- **Closest precedent**: DeRec Alliance draft; Ledger Recover's 2-of-3 custodian model approximates it but without TEE attestation.
- **Why novel**: Combining DeRec protocol with TEE remote attestation so the policy engine is cryptographically verifiable.
- **Risk**: Defer — wishlist §10.5 is currently **Out of Scope** in the project requirements. Log as future item.
- **Confidence**: HIGH (on the novelty; explicitly deferred).

---

## 8. Feature Dependencies

```
Passkey onboarding
    └──requires──> WebAuthn platform support (table stakes)
    └──requires──> QR / deep-link / NFC entry points
         └──requires──> ECDH channel authentication (pinned server key)

Threshold signing (FROST-on-JubJub)
    └──requires──> JubJub in-circuit Schnorr verification  [VALIDATED]
    └──requires──> DKG / resharing protocol
    └──requires──> Account provider (OAuth-like, JWT-issuing)
         └──requires──> Passkey credential management

Named accounts (alice.midnight)
    └──requires──> Multi-key account model (otherwise name collapses to one device)
    └──requires──> Address format standard (MIP-2) + key derivation (MIP-1)
    └──requires──> Commit-reveal registrar (anti-frontrun)
    └──requires──> Resolver with multi-address + privacy tiers

Multi-device accounts
    └──requires──> Key-set Merkle root in Compact circuit (MIP-4)
    └──requires──> Device-addition ceremony (QR between existing + new device)
    └──requires──> Function-call keys for dApp scoping

dApp-Wallet connection (MCP)
    └──requires──> CAIP-25 session negotiation
    └──requires──> EIP-6963-shape discovery
    └──requires──> Async proof coordination (proofId / progress / cancel)
    └──requires──> SIWM (depends on naming system)

Privacy-preserving credentials
    └──requires──> Attestation trees + Poseidon domain separators (MIP-6)
    └──requires──> Nullifier construction with domain separation
    └──requires──> Selective disclosure (enforced by Compact compiler) [EXISTS]
    └──enhanced-by──> Multi-issuer support (not blocking but critical for real adoption)
    └──enhanced-by──> Credential lifecycle (expiry, revocation, re-verification)

DeRec social recovery
    └──requires──> Seed exists (i.e. Stream B — on-device crypto)
    └──conflicts──> Signing network holding the seed (MVP) — in the MVP, "recovery" = account provider re-binding; true DeRec recovery only kicks in with on-device crypto
    └──requires──> ML-KEM-768 (FIPS 203) for share transport
    └──requires──> Daily challenge-response infrastructure

Credential survival across recovery
    └──requires──> Seed recovery (DeRec)
    └──requires──> Deterministic credential derivation from seed
    └──requires──> Stable Merkle roots (issuer publishes, user re-derives secret)
```

### 8.1 Dependency Notes

- **Stream 2 (on-device crypto) gates *true* DeRec recovery.** In the MVP, there is no user-held seed to split; the signing network holds the key. "Recovery" in the MVP is account-provider re-binding (a new device, new passkey, same distributed key). DeRec is the Milestone 2+ / Stream B story. This is a subtle dependency that affects how we talk about DeRec in MVP-era comms — we should not promise DeRec in Milestone 1 even though the design accommodates it.
- **Multi-key accounts (MIP-4) are a prerequisite for the dApp-connection protocol's function-call key semantics.** MCP v1 can ship with only full-access key authorisation, but scoped keys require MIP-4.
- **Credential standard (MIP-6) and connection protocol (MIP-5) are independent**, but `midnight_proveCredential` as an RPC method requires MIP-6's circuit interface to be stable.
- **Name registration and multi-key accounts are independent**; the MVP's single-key-per-name approach is sufficient until Stream A.
- **Naming system CAN ship without a privacy-aware resolver** (i.e. Milestone 1 can register names and resolve public records only). Privacy-tiered resolution is additive (Milestone 2+).

---

## 9. MVP Feature Envelope (Pass-Through to REQUIREMENTS.md)

Translates the wishlist + this ecosystem landscape into what the MVP must, should, and should-not ship. Detailed priority calls belong in REQUIREMENTS.md; this is feature-level input.

### 9.1 Launch with (v1 / MVP, end-June 2026)

Table-stakes items the MVP absolutely needs, plus the Midnight differentiators that motivate the project's existence.

- [ ] **Passkey onboarding with QR entry point** (table stakes; maps to wishlist §6)
- [ ] **Threshold signing on JubJub with FROST** (MVP cornerstone; wishlist §2.1 + MVP architecture)
- [ ] **Named account `alice.midnight` via Compact-circuit commit-reveal** (wishlist §4; MIP-3)
- [ ] **Three-wallet derivation (shielded / Night / DUST)** (wishlist §9; MIP-1 + MIP-2)
- [ ] **Provider-sponsored first transaction (NIGHT airdrop → DUST regeneration)** (table stakes for onboarding UX)
- [ ] **Device-addition ceremony via QR between two devices** (wishlist §6.4) — single-key-in-signing-network, multi-device *authentication* only, not multi-key accounts
- [ ] **Account recovery via account-provider re-binding** (new device + passkey + same distributed key) — NOT DeRec yet
- [ ] **Checkpoint-resume onboarding** (wishlist §6.5)
- [ ] **Alternative entry points: deep link, NFC, manual code** (wishlist §5.11 — at least one besides QR)

### 9.2 Add After MVP (Milestone 2)

- [ ] **MCP (dApp-Wallet Connection Protocol)** — full CAIP-25 + EIP-6963 shape + async proof coordination (wishlist §5.9; MIP-5)
- [ ] **Onboarding SDK wrapper** (wishlist §5.10; MIP-8) — encapsulates the MVP flow behind `midnight.onboard()`
- [ ] **Privacy-preserving credential standard** — attestation trees, domain-separated nullifiers, multi-issuer (wishlist §8; MIP-6)
- [ ] **Multi-key account model (MIP-4)** — key-set Merkle root in Compact circuit (Stream A)
- [ ] **Function-call keys with DUST allowance scoping** (wishlist §7.2) — depends on MIP-4
- [ ] **DeRec-based seed recovery** — depends on Stream B (on-device crypto) starting
- [ ] **Social account linking as recovery factor** (wishlist §6.6)

### 9.3 Future Consideration (Milestone 3+)

- [ ] **On-device key custody (Stream B)** — TEE wrapping on iOS / Android / laptop (wishlist §9, §12)
- [ ] **Privacy-aware name resolution (shielded-addr ZK gate)** (wishlist §4.6)
- [ ] **Chain abstraction via MPC chain signatures** (wishlist §2.3)
- [ ] **Full CCIP-Read wildcard subdomain support** for org-issued names (wishlist §4.7)

### 9.4 Explicit Non-Goals for the MVP (Anti-Features)

- [ ] **DO NOT show seed phrases** (anti-feature §1.3)
- [ ] **DO NOT offer production-grade threshold-signing ops** (project plan Out of Scope) — demo-grade committee only for MVP
- [ ] **DO NOT couple credential standard to zkMe specifically** (MIP-6 must be issuer-agnostic; the project requirements Out of Scope)
- [ ] **DO NOT ship institutional recovery pattern** (wishlist §10.5; Out of Scope per project plan)
- [ ] **DO NOT ship privacy-preserving analytics counters** (wishlist §12.5; Out of Scope per project plan)
- [ ] **DO NOT ship cross-chain intents** (wishlist §2.3; deferred per project plan)

---

## 10. Competitor Feature Analysis (Condensed)

| Feature | Closest non-Midnight product | Their approach | Midnight's approach |
|---------|------------------------------|----------------|--------------------|
| Seedless passkey onboarding | **Coinbase Smart Wallet** | Passkey as WebAuthn signer for 4337 smart account | Passkey as authenticator into threshold signing network (MVP) → passkey as witness-gate to on-device TEE (post-Stream B) |
| Named accounts with multi-address | **ENS + ENSIP-9** | keccak256 namehash, SLIP-44 cross-chain records | Poseidon namehash, native shielded/unshielded/DUST + cross-chain |
| Multi-key account | **NEAR** | Full-access + function-call keys; plaintext Ed25519 public keys | Same structure; keys are witness values, only Poseidon hashes on-chain |
| Social recovery | **Argent (48h delay) / DeRec (protocol)** | Guardian signatures with time delay | DeRec (3,5) + multi-device + daily challenge-response + anomaly detection |
| Privacy-preserving credentials | **zkMe / Polygon ID** | Groth16 / Iden3 ZK proofs with nullifiers | Native attestation trees with Poseidon, compiler-enforced disclosure analysis, unlinkable nullifier |
| dApp-Wallet connector | **CIP-30 / WalletConnect v2 / Sui Wallet Standard** | Sync signing, all-or-nothing scopes | Async proof coordination, progressive consent, 3 address types, credential-proof RPC |
| Sign-in primitive | **SIWE (EIP-4361)** | Sign a structured message with the wallet key | **SIWM**: message references the `.midnight` name, verification goes through the registry |
| Identity survival across recovery | **None in production** | Re-KYC | Credential derived from recovered seed, Merkle root unchanged |

---

## 11. Sources (consolidated)

### Documentation (authoritative)
- [DeRec Alliance — Decentralized Recovery](https://derecalliance.org/) / [DeRec Protocol spec](https://github.com/derecalliance/protocol/blob/main/protocol.md)
- [ENS Documentation — CCIP-Read](https://docs.ens.domains/resolvers/ccip-read/), [Fuses](https://docs.ens.domains/wrapper/fuses/), [ETH Registrar](https://docs.ens.domains/registry/eth/)
- [NEAR Documentation — Access Keys](https://docs.near.org/protocol/access-keys), [Account Model](https://docs.near.org/concepts/protocol/account-model), [Chain Signatures](https://docs.near.org/chain-abstraction/chain-signatures)
- [Privy Docs — passkey server wallets](https://docs.privy.io/recipes/passkey-server-wallets), [How Privy embedded wallets work](https://privy.io/blog/how-privy-embedded-wallets-work)
- [Web3Auth — MPC Architecture](https://web3auth.io/docs/infrastructure/mpc-architecture), [tKey v2 HackMD](https://hackmd.io/@torus/Hyv8HjO8i)
- [Dynamic — Introducing Dynamic Embedded Wallets with TSS-MPC](https://www.dynamic.xyz/blog/introducing-dynamic-embedded-wallets-with-tss-mpc), [Passkeys embedded wallets](https://www.dynamic.xyz/blog/embedded-wallets-with-passkeys)
- [Magic — Generalized DKMS](https://magic.link/docs/wallets/enterprise-features/generalized-dkms), [Product Security](https://magic.link/docs/home/security/product-security)
- [Turnkey — Embedded Wallets Overview](https://docs.turnkey.com/embedded-wallets/overview)
- [Coinbase — Wallet as a Service (Berkeley MPC Deployments)](https://mpc.cs.berkeley.edu/posts/Coinbase-Wallet-as-a-Service/)
- [Lit Protocol — PKP Quick Start](https://developer.litprotocol.com/user-wallets/pkps/quick-start), [Session Signatures](https://developer.litprotocol.com/sdk/authentication/session-sigs/intro)
- [Argent — Guardian Recovery](https://support.argent.xyz/hc/en-us/articles/360007338877-How-to-recover-my-wallet-with-guardians-onchain-complete-guide)
- [Safe + Candide Social Recovery Module](https://safefoundation.org/blog/introducing-candides-social-recovery)
- [Ledger Recover — Genesis Post](https://www.ledger.com/blog/part-1-genesis-of-ledger-recover-self-custody-without-compromise)
- [Trezor Shamir Backup](https://trezor.io/learn/a/recover-a-wallet-with-shamir-backup)
- [ZenGo MPC overview](https://zengo.com/mpc-wallet/), [Security Model](https://help.zengo.com/en/articles/2603678-how-zengo-security-model-works)
- [Apple — passkey security](https://support.apple.com/en-us/102195), [iOS 26 Passkey Portability](https://www.corbado.com/blog/ios-26-passkeys)
- [W3C / IETF / OpenID — SD-JWT VC draft-15](https://datatracker.ietf.org/doc/draft-ietf-oauth-sd-jwt-vc/), [OpenID4VCI 1.0](https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html), [OpenID4VP 1.0](https://openid.net/specs/openid-4-verifiable-presentations-1_0.html)
- [zkMe — DID solution](https://www.zk.me/did-solution), [zkKYC mechanism](https://blog.zk.me/how-zkkyc-works-understanding-the-mechanisms-behind-privacy-preserving-verification/)
- [BrightID overview](https://www.brightid.org/)
- [Worldcoin / World ID — Concepts](https://docs.world.org/world-id/concepts), [Privacy deep-dive](https://world.org/blog/developers/privacy-deep-dive)
- [Polygon ID / Iden3 — login protocol](https://docs.iden3.io/protocol/zklogin/), [Polygon ID intro](https://polygon.technology/blog/introducing-polygon-id-zero-knowledge-own-your-identity-for-web3)
- [Anoncreds Specification](https://hyperledger.github.io/anoncreds-spec/)
- [WalletConnect v2 Namespaces](https://specs.walletconnect.com/2.0/specs/clients/sign/namespaces), [CAIP-25](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-25.md)
- [EIP-6963 spec](https://eips.ethereum.org/EIPS/eip-6963)
- [EIP-1193](https://eips.ethereum.org/EIPS/eip-1193)
- [CIP-30 spec](https://cips.cardano.org/cip/CIP-30), [CPS-0010 Wallet Connectors](https://cips.cardano.org/cps/CPS-0010)
- [Sui Wallet Standard](https://docs.sui.io/standards/wallet-standard), [Aptos Wallet Standard](https://aptos.dev/build/sdks/wallet-adapter/wallet-standards)
- [SIWE / EIP-4361](https://eips.ethereum.org/EIPS/eip-4361), [FIP-11 Sign in with Farcaster](https://github.com/farcasterxyz/protocol/discussions/110)
- [Solana Name Service Guide](https://sns.guide/faq.html), [SNS subdomains](https://sns.guide/domain-name/subdomains/index.html)
- [Lens Protocol Handle docs](https://docs.lens.xyz/docs/handle), [Lens V2 introduction](https://mirror.xyz/lensprotocol.eth/-hJH-2IYSe56rK7IEdwSI17hUWt-paTyAs1r4Zes0uQ)
- [Farcaster — ENS Names architecture](https://docs.farcaster.xyz/learn/architecture/ens-names), [FName Registry API](https://docs.farcaster.xyz/reference/fname/api)

### Internal references
- `docs/reference/machine-investigation/key-flows/secure-onboarding-design.md` — the wishlist (all section references)
- `docs/passport-plan.md` — three-step decentralisation path
- `docs/mvp-architecture.md` — FROST-on-JubJub MVP
- the project requirements — scope and constraints

---

*Feature research for: ARC Passport (Midnight-native seedless wallet + privacy-preserving credentials)*
*Researched: 2026/04/16*
