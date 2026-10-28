# The `evm_k256` authorisation arm

**Byte contract AUTH-EIP712-PASSPORT-EVM-V1.** All 16 circuits are in place and registered in the client's arm registry (`ARM_REGISTRY` in `src/wallet/signer.ts`, from which `ARMS` follows); the measurement report is [EVM-K256-MEASUREMENTS.md](EVM-K256-MEASUREMENTS.md), the evidence is under [evidence/evm-k256/](evidence/evm-k256/).

An ordinary Ethereum account, for example MetaMask, acts as a Passport device or as a grantee. It authorises every operation by signing EIP-712 typed data. In that typed data, every operand and every consumed witness value is a member, shown by the wallet in full and recomputed by the circuit from exactly the values it executes. Nothing opaque is signed: there is no challenge hash and no fingerprint. Four labelled values are the only exception (section 6). The wallet needs no ETH and sends no Ethereum transaction.

| | |
|---|---|
| Circuits | `contracts/account-evm-k256.compact` (the arm), `contracts/modules/EvmK256.compact` (the codec), `contracts/modules/K256Core.compact` (ECDSA verification on a digest), `contracts/modules/EvmIdentity.compact` (the address) |
| Client | `src/wallet/signer-evm-k256.ts` (wallet, device, blind, records, restore, the signer check), `src/wallet/evm-k256-codec.ts` (typed data), `src/wallet/blind.ts` (the request texts and the rules shared by the readable arms: the restore and the signer check) |
| Frozen vectors | `src/tests/vectors/evm-k256-v1.json`: 64 positive and 25 negative vectors, hashes computed by viem 2.45.1 |
| Tests | `src/tests/evm-k256-offline.ts`, `src/tests/evm-k256-client-offline.ts` (the format, the signer check, the records, the restore and the use counters), `src/tests/evm-k256-grants-offline.ts`, `src/tests/evm-k256-recovery-sim.ts`, `src/tests/evm-k256-seam-offline.ts`, `src/tests/evm-k256-hints-offline.ts` `src/tests/evm-k256-key-text-offline.ts` (all three key-text forms through the pure `probe-evm-k256-key-text`, frozen digests and malformed hints) and `src/tests/k256-core-probe-offline.ts` (`K256Core` alone, through `contracts/probe-k256-core.compact`) (all: `npm run test:evm_k256-offline`), `src/tests/evm-k256-viem.ts` (needs viem, see section 8), `src/tests/evm-k256-prover.ts` (constraint-level negatives: `npm run test:evm_k256`) |

## 1. Identity

The device is its 20-byte Ethereum address, `keccak256(x_be ‖ y_be)[12..32]` of its key (`evm_address`, section 9), **blinded**. Every recipe below is SHA-256 (`persistentHash`) over the plain concatenation. `A` is the account's 32-byte contract address, and `le4`/`le8` are little-endian `Uint<32>`/`Uint<64>`:

```
entry    = H(pad32("midnight:account:device:evm:v1")   ‖ A    ‖ address(20) ‖ blind(32) ‖ le4(epoch) ‖ le8(counter))
boot     = H(pad32("midnight:account:boot:evm:v1")     ‖ salt ‖ address(20) ‖ blind(32))
grant id = H(pad32("midnight:account:grant:id:evm:v1") ‖ A    ‖ address(20) ‖ blind(32) ‖ origin_hash(32) ‖ slot(1))
```

These are width class 52 of the shared descriptor module (`modules/WalletArmDescriptors.compact`). Every readable arm derives an `evm_k256` target's entry with the same recipe.

A grant this arm issues hides its commitments under a **scope salt** that `issue_grant_with_evm_k256` derives itself, with the shared module's `derive_grant_scope_salt`. Its inputs are the issuing device's blind (the one its entry binds), the account, and the `auth_nonce` the device signs, read before the seam advances it:

```
scope salt = H(pad32("midnight:account:salt:evm:v1") ‖ blind(32) ‖ A ‖ le8(auth_nonce))
```

The call takes no salt argument, so no one who builds the proof chooses it, and each issuance gets its own. The client computes the same value (`evmK256GrantScopeSalt`), and `issueGrantWithEvmK256` returns it for the grantee, whose calls open the commitments under it. The grant record keeps `issued_at`, the `auth_nonce` after the seam advanced it, so the issuing device can recompute the salt of each grant it issued from the record (`issued_at − 1`); no one without that device's blind can.

Every path that admits a key takes the secp256k1 **point** and derives the address itself, and the point passes `K256Core`'s key rule (`k256_require_live_key`), which refuses the point at infinity by its coordinates and so catches both encodings: activation applies the rule itself, the seams through the verification. A caller can never present an address without a key.

## 2. The blind

`blind = H(pad32("midnight:account:blind:evm:v1") ‖ r ‖ s)`, where `r ‖ s` is the low-S canonical form (big-endian, 32 bytes each) of the wallet's `personal_sign` signature (EIP-191 version `0x45`) over this readable request:

```
Midnight Passport account privacy key (v1)
Network: <network name>
Wallet: Ethereum address <EIP-55 address>
Account index: <0 … 4294967295>
Warning: this signature reveals the privacy key of this Passport account.
Anyone who obtains it can link this wallet to that account.
Sign it only in a Midnight Passport client you trust.
It authorises nothing: no transfer, no new device, no grant.
```

The procedure:

- The client asks for the signature **twice** and refuses the wallet if the two canonical forms differ. Such a wallet is non-deterministic (MPC, hedged nonces), so its blind could never be derived again. The check runs before anything is proved or submitted.
- Each of the two signatures must recover, from the exact digest of the request, to the address the request names (the signer check, section 15). The device's public point is recovered from the first.
- The `personal_sign` hash preimage begins `0x19 0x45` (`0x19` and `'E'` of `"Ethereum Signed Message:\n"`), and every authorisation's hash preimage begins `0x19 0x01`. The preimages are disjoint, so the two digests coincide only on a keccak256 collision: a blind signature is never an authorisation, and an authorisation is never a blind signature. No circuit consumes a `personal_sign` digest.
- A client without records derives `blind_0 … blind_k` and finds its accounts by testing entries at every use counter from 0 to each account's `auth_nonce` (`restoreEvmDevices`, `evmK256DeviceFinds`; section 9, "Use counters"); with a record it restores the device it names (below).
- As a **grantee**, the wallet signs a different request: `granteeBlindMessage` names the role ("grantee"), the network, the wallet and the issuing account's 32-byte address, and has no account index. Its first two lines differ from the device request's, so a grantee blind is never a device blind, and it is different for every issuing account (`enrolEvmGranteeBlind`, `EvmK256Grantee.enrol`).

**The format and the record.** The arm has one format, `eip712-v1` (approvals as EIP-712 V1 typed data, blind requests by `personal_sign`; section 15). A device is bound to the format it was enrolled in: its blind is the signature over the blind request in that format, so it can be derived again only by a wallet that signs that format, with the same key, deterministically. For this arm every wallet signs the one format, and the canonical (low-S) signature, and so the blind, is the same in every wallet that holds the key and derives its ECDSA nonces by RFC 6979 as specified (the emulated Trezor and Ledger reproduce it across sessions, as software wallets do). A deterministic wallet with another nonce rule (RFC 6979 with additional input, or a derivation of its own) signs the same request with another valid signature, every time, so it passes the sign-twice check but derives another blind: the restore therefore checks a blind derived again against the account before it uses it (below). The client stores, per device, a record (`EvmK256RosterRecord`): the arm, the format, the network, the account index, the address and the recovered point, none of them secret, and the blind as a **cache**. The blind is a secret (it links the wallet to the account): the cache stays in the client's local storage, protected as the wallet's session data is, and is never sent. Per issuing account, a grantee's record (`EvmK256GranteeRecord`) holds the same and the issuing account's address, and caches the grantee blind. It **never holds the read seed** (from which the grant read keys are derived; section 14), which is kept in memory for the session only: a grantee restored from its cached blind can spend at once, and before it first reads, the client asks the wallet for one signature of the grantee request, which must come from the grantee's address and give its blind again (so it is the signature the blind was derived from), and derives the seed from it (`readKeyFromWallet`); while the seed is in memory, reading asks for no signature. A record of another arm or format, with a malformed field, or a grantee record that carries a read seed, is refused.

**Restore** (`restoreEvmK256Device`, `restoreEvmK256Grantee`, both through the shared rule `restoreBlind` of `src/wallet/blind.ts`):

1. with the cache, the blind is used as it is, and no signature is asked;
2. with a record but no cache, the wallet signs the request the record names (its network, address, and account index or issuing account) twice in the record's format, and each signature must come from the record's address, whatever address the wallet reports; a wallet of another key is refused, and named (section 15). The blind derived again is used only when the caller's test finds the device (or the grant), so such a restore needs that test (`finds`; for a device, `evmK256DeviceFinds(account)`): a wallet of the same key with another nonce rule derives another blind, and the result says so: "No account was found with the privacy key this wallet derives in the EIP-712 V1 format, the format this device was enrolled through. A wallet that signs the request differently from the wallet used then derives another privacy key from the same wallet key. Use that wallet, or add this wallet as a new device from another device of the account, or through the account's recovery." (a grantee: "No grant was found … the format this grant was issued through. … Use that wallet, or ask the issuing account's owner for a new grant to this wallet.");
3. without a record, the wallet signs the request for its own address and the given account index (or issuing account), and the caller tests the blind against the accounts' entries (or the grant id); without a match the result says so and what remains: "No account was found in the formats this wallet can sign (EIP-712 V1). Add this wallet as a new device from another device of the account, or through the account's recovery." (a grantee: "No grant was found in the formats this wallet can sign (EIP-712 V1). Ask the issuing account's owner for a new grant to this wallet.").

A blind is never derived in another format than the stored one, and the wallet is asked for nothing it cannot sign. If the cache is lost and no wallet with the key signs the request as the enrolling wallet did, the device cannot be used: the account remains reachable through another device or its recovery, which can enrol a new device.

## 3. Domain

```
EIP712Domain(string name,string version,address verifyingContract)
name               "Midnight Passport"
version            "1"
verifyingContract  P = the low 20 bytes of keccak256("midnight:passport:evm:v1")
                     = 0x596e089eF2D7308208B9e8f7e1A147942a84104F
```

One domain serves every account and every network (EIP-712 V1). P names the domain; no contract is deployed at it, and anyone can recompute it from its text. There is no `chainId`, no `salt` and no network value: a circuit cannot read the network id, so such a value could not be checked, and wallets refuse to sign a `chainId` other than the chain they have active (the cross-network clone argument is in section 10). The account is bound by the message: every type's first member is `bytes32 account`, which the seam takes from `kernel.self()`.

| Pinned value | |
|---|---|
| domain type hash, keccak256 of the type string above | `91ab3d17e3a50a9d89e63fd30b92be7f5336b03b287bb946787a83a9d62a2766` |
| name hash, keccak256("Midnight Passport") | `e59dd8705118a4649bd1ea3fc817968bbd5d5395a5ea9146d54a9fe0d32c3072` |
| version hash, keccak256("1") | `c89efdaa54c0f20c7adf612882df0950f5a951637e0307cdcb4c672f298b8bc6` |
| domain separator, keccak256(type hash ‖ name hash ‖ version hash ‖ 12 zero bytes ‖ P) | `c199a56c83cc5d0377e7f261c33491d1ee5fa301de75f83dfb8bc32a21e08ad8` |

The domain is fixed, so the separator is a circuit constant of the format module `modules/Eip712V1.compact`, which computes the digest; its type hash, string hashes and P are exported beside it as oracles (`eip712_v1_domain_type_hash`, `eip712_v1_name_hash`, `eip712_v1_version_hash`, `eip712_v1_verifying_contract`, `eip712_v1_domain_separator`, `eip712_v1_digest`). The frozen vectors pin the same values (section 8).

What the wallet signs:

```
digest = keccak256(0x19 ‖ 0x01 ‖ domainSeparator ‖ hashStruct(message))
```

## 4. Encoding

This is EIP-712 `encodeData`, one 32-byte word per member:

| Member type | Word |
|---|---|
| `bytes32` | the 32 bytes |
| `address` | 12 zero bytes ‖ the 20 bytes |
| `uint8`, `uint32`, `uint64`, `uint128` | big-endian, zero-extended |
| `bool` | 0 or 1 as a uint |
| `string`, `bytes` | keccak256 of the content |
| nested struct | its `hashStruct` |

The byte order of points and field elements:

- secp256k1 and P-256 coordinates are big-endian (SEC1).
- JubJub coordinates and other `Field` values are little-endian, as the contract encodes them.

Text members:

- `scheme` is a registered tag's text, without its zero padding.
- `origin` is a passkey's exact 21-byte origin, which must be visible ASCII.
- `siteLabel` is a 32-byte zero-padded site label, shown with its zero bytes as spaces. It is 32 characters long. Its grammar makes the shown text one-to-one with the stored bytes: one or more visible words separated by single spaces, then zero bytes only.
- `effect` is a circuit-fixed line.
- `expiry` is the grant's expiry as a UTC date and time, `yyyy-mm-dd hh:mm:ss UTC`, checked against `expiresAt`; `never` for 0 and `after 9999-12-31 23:59:59 UTC` beyond the year 9999. The exact text, with no padding.
- `amountLabel` is the site's label for the amount: the fixed words `This site labels it: `, then the amount's digits with the site's decimal point and its symbol, space-padded to 49 bytes. The digits are checked against the amount, so the site chooses only the point and the symbol.
- `publicKey` of a Solana target or grantee is the key's base58 text, as Solana wallets show it, left-aligned and space-padded to 44 bytes, checked against the key's 32 bytes.

## 5. Types

There are 16 primary types, one per operation and role. The device role's 13 share the frame `bytes32 account, address device, uint64 authNonce`. The grantee role's 3 share `bytes32 account, address grantee, string siteLabel, uint8 slot, uint64 issuedAt, uint64 grantNonce`. A grantee's frame never carries `auth_nonce`.

| Circuit | Primary type |
|---|---|
| `withdraw_unshielded_with_evm_k256` | `WithdrawUnshielded(bytes32 account,address device,uint64 authNonce,bytes32 color,uint128 amount,string amountLabel,bytes32 recipient)` |
| `withdraw_shielded_with_evm_k256` | `WithdrawShielded(…frame…,bytes32 color,uint128 amount,string amountLabel,bytes32 recipient,bytes32 coinNonce,uint128 coinValue,uint64 coinMerkleIndex,uint128 change)` |
| `withdraw_shielded_to_contract_with_evm_k256` | `WithdrawShieldedToContract(…frame…,bytes32 color,uint128 amount,string amountLabel,bytes32 recipientContract,bytes32 coinNonce,uint128 coinValue,uint64 coinMerkleIndex,uint128 change)` |
| `append_inbox_with_evm_k256` | `AppendInbox(…frame…,bytes entry)` |
| `rotate_enc_key_with_evm_k256` | `RotateEncKey(…frame…,string effect,bytes32 newKey)` |
| `add_device_with_evm_k256` | `AddDevice(…frame…,string effect,<Scheme>Device newDevice)` |
| `remove_device_with_evm_k256` (descriptor) | `RemoveDevice(…frame…,<Scheme>Device target,uint32 targetEpoch,uint64 targetCounter)` |
| `remove_device_with_evm_k256` (literal entry) | `RemoveUnknownDevice(…frame…,string effect,bytes32 entry)` |
| `issue_grant_with_evm_k256` | `IssueGrant(…frame…,string effect,<Scheme>Grantee grantee,bool withdrawUnshielded,bool withdrawShielded,bool withdrawShieldedToContract,bool read,bytes32 color,string recipientKind,bytes32 recipient,uint128 maxCoinValue,uint128 perCallCap,uint128 cap,uint64 expiresAt,string expiry,bytes32 passkeyRpHash,string passkeyRp,bytes32 readKey,uint64 windowLength,uint128 windowCap,string window,bool callerPinned,bytes32 caller)` |
| `revoke_grant_with_evm_k256` | `RevokeGrant(…frame…,<Scheme>Grantee grantee)` |
| `revoke_all_grants_with_evm_k256` | `RevokeAllGrants(…frame…)` |
| `publish_recovery_session_with_evm_k256` | `PublishRecoverySession(…frame…,string effect,bytes32 recoveryKeyX,bytes32 recoveryKeyY,bytes32 sessionNonce,bytes32 phi1,bytes32 phi2,bytes32 phi3,bytes32 phi4,uint8 phiLength,bytes wrap)` |
| `recover_cancel_with_evm_k256` | `CancelRecovery(…frame…)` |
| `withdraw_unshielded_with_grant_evm_k256` | `WithdrawUnshieldedAsGrantee(…grantee frame…,bytes32 color,uint128 amount,string amountLabel,bytes32 recipient)` |
| `withdraw_shielded_with_grant_evm_k256` | `WithdrawShieldedAsGrantee(…grantee frame…,bytes32 color,uint128 amount,string amountLabel,bytes32 recipient,bytes changeEntry,bytes32 encryptionKey,bytes32 coinNonce,uint128 coinValue,uint64 coinMerkleIndex,uint128 change)` |
| `withdraw_shielded_to_contract_with_grant_evm_k256` | `WithdrawShieldedToContractAsGrantee(…grantee frame…,bytes32 color,uint128 amount,string amountLabel,bytes32 recipientContract,bytes changeEntry,bytes32 encryptionKey,bytes32 coinNonce,uint128 coinValue,uint64 coinMerkleIndex,uint128 change)` |

Both tables are generated from the codec's type definitions (`EVM_K256_PRIMARY_TYPES`, `EVM_K256_DESCRIPTOR_TYPES` in `src/wallet/evm-k256-codec.ts`). The exact `encodeType` strings, 32 of them counting each descriptor scheme, are in the vector file under `typeStrings`, and they equal the codec's.

There is one nested descriptor type per target scheme. The parent's type string names the nested type, so the parent type hash follows the scheme:

| Scheme (tag) | Device type | Grantee type |
|---|---|---|
| `evm_k256` | `EvmDevice(string scheme,address wallet,bytes32 privacySalt)` | `EvmGrantee(string scheme,address wallet,bytes32 privacySalt,string siteLabel,uint8 slot)` |
| `sol_ed25519` | `SolanaDevice(string scheme,string publicKey,bytes32 privacySalt)` | `SolanaGrantee(string scheme,string publicKey,bytes32 privacySalt,string siteLabel,uint8 slot)` |
| `jubjub` | `JubjubDevice(string scheme,bytes32 x,bytes32 y)` | `JubjubGrantee(string scheme,bytes32 x,bytes32 y,bytes32 siteLabelHash,uint8 slot)` |
| `k256` | `K256Device(string scheme,bytes32 x,bytes32 y,string envelope)` | `K256Grantee(string scheme,bytes32 x,bytes32 y,string envelope,bytes32 siteLabelHash,uint8 slot)` |
| `p256` | `PasskeyDevice(string scheme,bytes32 x,bytes32 y,string origin,bytes32 passkeyRpHash)` | `PasskeyGrantee(string scheme,bytes32 x,bytes32 y,string origin,uint8 slot)` (its RP is the scope's `passkeyRpHash`) |

The circuit derives the target's entry or grant id from exactly these values, with the target scheme's own recipe. An unregistered tag is refused.

**A Solana target is a point with its checked encoding.** `add_device`, `remove_device`, `issue_grant` and `revoke_grant` take a `Curve25519Point` beside the descriptor (inline: compactc 0.35.0 cannot emit an exported struct that holds one), followed by two byte inputs: the key's 32-byte RFC 8032 encoding and the point's x-coordinate as 32 little-endian bytes (`solanaKeyInputs`). The descriptor module's ed25519 class checks both against the point (for each point exactly one pair passes) and refuses the identity (`A ≠ O`; the point type admits only the prime-order subgroup); the circuit shows the checked encoding as `publicKey` in base58, and the entry or grant id hashes the same key. A circuit computes every descriptor class, so for any other target the client passes a fixed non-identity key (the Ed25519 base point) with its inputs, whose results the circuit discards. The class costs about 8k to 10k rows per circuit (the checked encoding about 3k plus about 0.9k for its 64 input bytes, the rest its own SHA-256 derivation); deriving the encoding from the point inside the circuit would cost 6.0k to 7.7k rows more.

The enumerated members are shown as text labels: EIP-712 `string` members whose text is a circuit constant selected by the value, so the label and the value cannot disagree; a value with no label is refused (client and runtime; a constraint of the proof). The texts are the base's shared labels (`WalletArmRendering.compact` `recipient_kind_text` and `k256_envelope_text`; the client's `src/wallet/labels.ts`), so every readable arm shows the same words. The circuit holds `keccak256(text)` for each, which is how EIP-712 encodes a `string` member, and the offline suite checks, for every value, that the base circuit's own text equals the client's label and the signed text, and that the contract's digest equals the codec's. Labels cost at most 28 rows (`issue_grant`) and change no circuit's k. Calling the base circuit in place of the constants would add a keccak256 of the text per label: 4,463 rows per label when the signed string is the base's 24-byte space-padded text (`issue_grant` 260,484 rows, 1,660 below the k 18 cap), and k 19 for `issue_grant` (289,799 rows) when it is the exact text, because each text length needs its own hash.

| Member | Value | Label | Meaning |
|---|---|---|---|
| `IssueGrant.recipientKind` | 0 | `any recipient` | no recipient pin |
| | 1 | `unshielded user address` | pinned to a user address (unshielded twin) |
| | 2 | `shielded coin public key` | pinned to a Zswap coin public key (shielded twin) |
| | 3 | `contract address` | pinned to a contract (direct-transfer twin) |
| `K256Device.envelope` | 0 | `SHA-256 of the challenge` | the key signs SHA-256 of the challenge |
| | 1 | `dApp-connector signData` | a **full-control device** that signs a 32-byte hash through a connector's `signData` prefix; its own user sees only an opaque hash. A client SHOULD warn before such a device is added |
| `K256Grantee.envelope` | 0 | `SHA-256 of the challenge` | as above |
| | 1 | `dApp-connector signData` | upstream admits it for read-only grants only (a spend under it is refused) |

**Exact words.** `IssueGrant` shows two values whose exact protocol meaning has a word: an all-zero RP hash means that no RP pin is checked (the grantee is not a passkey, or it is a passkey whose scope cannot spend, such as a read-only grant, which is admitted), and a zero rate-limit window means that no per-window bound applies. Each is an EIP-712 `string` member next to the typed numbers, with exactly two texts, circuit constants selected by exact equality with the executed values. The first text of each is the base's word (`src/wallet/rendering.ts` `NOT_APPLICABLE_TEXT`, `NO_WINDOW_TEXT`; the base circuits `rp_hash_text` and `window_text` produce the same words, which the offline suite checks); the other points at the typed members that carry the values. No amount gets a magnitude: the typed numbers are shown as they are.

| Member | Value | Text |
|---|---|---|
| `IssueGrant.passkeyRp` (after `passkeyRpHash`) | all 32 bytes zero (only a grant whose RP pin is never checked: no passkey grantee, or one that cannot spend) | `not applicable` |
| | any other (a spending passkey grant's RP pin) | `see passkeyRpHash` |
| `IssueGrant.window` (after `windowCap`) | `windowLength == 0` and `windowCap == 0` (every grant today: upstream's issue rule requires both to be 0) | `no window` |
| | any other | `see windowLength and windowCap` |

The pointer texts name the members beside them, so the wallet shows the numbers and says where to read them. The two words cost about 30 rows on `issue_grant`.

**Readable texts.** Three members are texts checked against the executed value by the base's rendering module (`WalletArmRendering.compact`), from display inputs the client supplies in the operation's hint; each value has exactly one valid input, and a wrong one fails the call:

| Member | Text | Base circuit | Inputs (client) |
|---|---|---|---|
| `IssueGrant.expiry` (after `expiresAt`) | `never` (0); `yyyy-mm-dd hh:mm:ss UTC` (1 to 253402300799); `after 9999-12-31 23:59:59 UTC` (above) | `utc_datetime_text` (it runs for 0 too, on the date of 0, which is not shown) | `expiry_text`, `year_split` (`utcDateTimeInputs`) |
| `amountLabel` (after `amount`, in the six amount-moving types) | `This site labels it: ` and the 49-byte label | `site_amount_label_text` | `label` (`siteAmountLabelBytes`; the codec and the facade take the site's `{ decimals, symbol }`) |
| `SolanaDevice.publicKey`, `SolanaGrantee.publicKey` | 44-byte base58 | `base58_text_32`, over the encoding the ed25519 class checked | `b58` (`base58Inputs`); for any other target, the filler key's, checked too |

The expiry is signed as its exact text: the circuit selects keccak256 of `never`, of the words, or of the date's 23 bytes, so only the date needs a hash in the circuit. The amount label and the base58 key are signed with their padding, because a variable-length text would need one hash per length. The texts cost about 11.6k rows on each amount-moving circuit (the label check about 6.1k, its hash and its 49 input bytes), about 6.7k on each Solana-target circuit (the base58 check about 4.3k, its hash and its inputs), and about 18.1k on `issue_grant` (the date, the base58 key, the window word). Four circuits move from k 17 to k 18 with them: `add_device`, `revoke_grant` and the two shielded grantee twins; every circuit stays at k ≤ 18.

The effect lines, and the line of the literal-entry removal, are circuit constants:

| Type | `effect` |
|---|---|
| `AddDevice` | Gives this key FULL control of this account |
| `IssueGrant` | Lets this key use this account within the limits below |
| `PublishRecoverySession` | Sets this account's recovery key |
| `RotateEncKey` | Sets the key that can read this account's private coin records |
| `RemoveUnknownDevice` | Removes a device this wallet cannot identify |

## 6. What is shown, and the four labelled values

Every member is a value shown in full: an identifier, a key, an amount, a counter, a witness value, a ciphertext as `bytes`, or circuit-fixed text. The offline suite classifies every member of every type, and fails on a member it cannot classify. Exactly four hash-like values appear, each under a fixed name, and none of them grants authority:

| Member | Value | Why it cannot be a preimage |
|---|---|---|
| `siteLabelHash` (`JubjubGrantee`, `K256Grantee`) | a `jubjub`/`k256` grantee's `origin_hash` | upstream hashes a client id of any length; the client shows the client id beside it |
| `passkeyRpHash` (`PasskeyDevice`, `IssueGrant`) | a passkey's `rp_id_hash` | the RP ID may be a registrable parent of the origin's host; the client shows the RP ID beside it |
| `privacySalt` (`EvmDevice`, `SolanaDevice`, `EvmGrantee`, `SolanaGrantee`) | the target's blind | a secret by design (section 2) |
| `entry` (`RemoveUnknownDevice` only) | a literal device entry, under "Removes a device this wallet cannot identify" | revocation only; the caller's own post-roll entry can never be removed |

Ledger-pinned private openings are not shown: the signer's own blind and use counter, `spent_prev`, and the grantee's pinned recipient and maximum coin value. They are checked against state, not chosen. A grant's `scope_salt` is not shown either, and at issuance it is not an input at all: `issue_grant_with_evm_k256` derives it from the issuing device's blind, the account and the signed `auth_nonce` (section 1). A grantee call takes it as an opening, which the record's commitments check. A shielded spend shows its coin by nonce, value and Merkle index. Its colour is `color`, because the circuit asserts `coin.color == color`. The change is `coinValue − amount`.

**Verifiable by eye**:

- the EVM address (MetaMask shows `address` members in EIP-55 form);
- the passkey origin;
- a Solana key, in base58 as Solana wallets show it: the text of the key's 32-byte encoding, which the circuit checks against the target's point (the shared descriptor module's checked encoder) and passes, the same bytes, to the derivation.

**Shown only**: `k256`, `jubjub` and passkey public keys, and the recovery material of `PublishRecoverySession` (the new recovery key, the session identifier, the phi values and the wrap). The material comes from the client's own guardian ceremony; that it is the intended guardians' is a client obligation, not something the user can check by eye (section 12).

**Length bound per layout**:

- every struct is fixed at its member count;
- the dynamic members are `entry` and `changeEntry` (192 bytes) and `wrap` (64 bytes);
- the longest message is `IssueGrant`: 26 words (its type hash and 25 members) plus the grantee struct, 6 words (7 for `K256Grantee`).

## 7. Client codec

`src/wallet/evm-k256-codec.ts` has two parts:

- a general EIP-712 encoder written from the EIP;
- one builder per operation, producing `eth_signTypedData_v4` JSON. The `types` object holds only the primary type, its nested type and `EIP712Domain`, because viem and ethers refuse unused types.

The builders produce typed data under the fixed V1 domain only, and the client refuses any other typed data before a wallet sees it (`checkEip712V1TypedData`: the domain exactly `{name, version, verifyingContract}` with the V1 values, no chain id or salt, and the V1 `EIP712Domain` type), in the device's and the grantee's approvals and in `authorisationFrom`.

The builders are strict. They range-check every integer, check labels and origins against the circuit's text rules, and refuse an unregistered tag. These are client-layer refusals, before any wallet sees the message. The grant facades also re-check a grantee input built elsewhere with the strict client decoders (`checkEvmK256GranteeInput`: a registered grant-id tag, points on their curves, a valid Ed25519 encoding), before the account or the wallet is touched. A passkey grantee's site origin, its own field apart from any policy on the key, passes the base's origin rule (21 bytes, visible ASCII, no quote or backslash) in the same places.

## 8. Frozen vectors

`src/tests/vectors/evm-k256-v1.json` holds:

- **64 positive vectors.** Every primary type is covered, and every descriptor-taking type with all five schemes. The vectors include edge values (`2^128 − 1`, `2^64 − 1`, zeros), expiries at the edges of the date range and of the calendar (1, `2^31 − 1`, `2^31`, 2000-02-29, 2100-03-01, the last second shown as a date and the first shown as the words), Solana keys whose encoding starts with one and two zero bytes, amount labels with 0, 2, 6 and 18 decimals and symbols of 1 to 8 characters (the widest fills the 49 bytes), dynamic members with leading zero bytes and all-zero bytes, and the passkey parent-domain shape. Each vector holds its inputs, its typed data, the `encodeType` string, the domain separator, the struct hash and the digest. **viem's `hashTypedData` computed every hash.** The inputs are drawn by `vectorInputs()` (`src/tests/evm-k256-vectors.ts`) from its seed `evm-k256-vectors/v1`, recorded in the file.
- **The domain's pinned values** (section 3: the type string and type hash, the name and version hashes, P and its text, the separator) and **the type hash of each of the 32 type strings** (16 primary types, the descriptor-taking ones once per nested type), computed by viem. The offline suite checks them against the contract's oracles, the client codec and their definitions.
- **25 negative vectors.** Each names the layers that must refuse it:

| Negative | Refused by |
|---|---|
| an unregistered device tag; a space-padded registered tag; a grant-id tag as a device tag | client, runtime |
| a passkey origin with a space or a NUL | client, runtime |
| a site label ending in a space, with a double space, or empty | client, runtime |
| an unregistered grant-id tag | client, runtime |
| an amount above the spent coin (device and grantee) | client, runtime |
| an amount of 2^128; an `authNonce` of 2^64; a 191-byte inbox entry | client, runtime |
| a `recipientKind` of 4; a k256 `envelope` of 2 (no label) | client, runtime |
| a passkey device target (`add_device`, `remove_device`) or a spending passkey grant with an all-zero RP hash | client, runtime |
| an RP hash for a non-passkey grantee, or for a passkey grant that cannot spend | client, runtime |
| recipient kind 0, "any recipient", with a non-zero recipient | client, runtime |
| a site amount label with 19 decimals, a symbol starting with a digit, or a symbol of 9 characters | client, runtime |

"Runtime" is the generated JavaScript of the contract's pure circuits. In the impure circuits the same asserts are constraints of the proof. Each rule above that an impure circuit reaches has a valid-signature negative refused at the proof server, one representative input per rule, with the admissible call proved through the same patched copy first (`evm-k256-prover.ts`; the descriptor and label rules are tabled in section 9): the device and grant-id tags, a passkey origin with a space, a site label with two spaces, recipient kind 4, a k256 envelope of 2, the zero RP hash of a passkey, an RP hash where none is checked, and a recipient under "any recipient". An unregistered tag also fails the base's width assert for the class it selects, and those cases name both asserts. An amount above the spent coin is refused at runtime on all four shielded spends; its prover level cannot be reached from a JavaScript-built call (the negative change cannot be encoded), and each case records that reason. The rows of 2^128, 2^64 and a 191-byte entry are refused by the runtime's own type checks before any circuit runs.

Agreement, from `npm run test:evm_k256-offline`: the contract's pure circuits, the client codec and the frozen values agree on all 64 vectors. To reproduce the frozen values with viem, which is not a dependency:

```sh
VIEM_DIR=<a viem 2.x package root> npx tsx src/tests/evm-k256-viem.ts
```

That script also checks that `signTypedData` is byte-identical to viem's, and the addresses, points and blind requests.

## 9. The seam and the acceptance policy

`require_authorised_with_evm_k256<T>(auth, type_hash, tail)` follows upstream `p256`'s order (MIP-0013 §4):

1. the device's address derived from the presented point, `evm_address(auth.pk, auth.hint.key)`;
2. membership of the single-use entry at the active epoch;
3. ECDSA verification of `eip712_v1_digest(struct_hash)` (keccak256 of `0x19 ‖ 0x01 ‖` the fixed V1 domain separator `‖ struct_hash`, section 3) by `K256Core`'s `k256_ecdsa_verify`, where the seam builds `struct_hash` itself from the frame and the export's tail; the verification first refuses the point at infinity as the key, and `r = 0` or `s = 0`;
4. the entry rolled to its successor;
5. `auth_nonce` advanced and `round` bumped.

Any failure aborts the whole call. The authorising argument `EvmK256Auth { pk, use_counter, blind, sig, hint }` is internal.

**The address and the verification.** `evm_address` (`modules/EvmIdentity.compact`) hashes the key's coordinates' big-endian bytes and takes the low 20 bytes of the hash, as Ethereum defines the address; it derives no address for the point at infinity (extracting the coordinates of the flagged encoding fails, and the unflagged `(0, 0)` is not a curve point). `K256Core` holds the acceptance rules, each one assert: the key rule `k256_require_live_key` refuses the point at infinity by its coordinates, in both encodings (a comparison with the default point compares the identity flag too, so the unflagged `(0, 0)` would pass it), and `k256_ecdsa_verify` calls it, refuses `r = 0` and `s = 0` (FIPS 186-5 takes both in [1, n − 1]), and is otherwise the standard library's `secp256k1EcdsaVerify` with the same arithmetic and semantics (both S forms accepted, the digest read big-endian and reduced mod n, `x(R)` reduced mod n). Activation, which admits a key without a signature, calls the key rule itself.

**Checked byte hints.** Taking bytes out of a value costs a full field decomposition per byte, so the circuits take a value's bytes as an extra argument instead: a vector of `Uint<8>` that must be exactly the value's bytes in the order Compact stores them (a `Bytes<n>` in order, a number little-endian). Each check rebuilds the value from the vector and compares. Every element is range-checked to 8 bits as a circuit argument, each field element rebuilt holds at most 31 bytes (no wrap-around), and base-256 digits are unique, so only the value's own bytes pass, and the checked vector is the one used. The hints are the key's coordinates and the key hash (the address), the digest (the verification's big-endian scalar), `authNonce` (the device frame), the site label, `issuedAt` and `grantNonce` (the grantee frame), all in `EvmK256Auth.hint` / `EvmK256GrantAuth.hint`, and each operation's own (the amounts, the spent coin's value and Merkle index, the change, a descriptor's key, second key, origin and site label, the scope's numbers, a removal's epoch and counter, and the display inputs of the readable texts: the site's amount label, a Solana key's base58 digits and read-back hints, the expiry's date text and year split) as the circuit's trailing `hint` argument; activation takes the key's. A Solana key's encoding and x-coordinate are byte inputs of the same kind, checked by the shared encoder (see "A Solana target" above). The exported pure oracles take the same hints as arguments. The client builds every hint from the values it signs (`src/wallet/evm-k256-hints.ts`); a wrong hint only fails the call and never changes what is signed or executed. `evm-k256-hints-offline.ts` refuses a changed byte of every hint and of the Solana key inputs at each place it is checked, and an approval's struct hash signed with `personal_sign` and passed with the digest hint of what that signature signs, at the device seam and at the grant seam (the circuit verifies only the V1 digest); section `hints` of the prover suite refuses one at the proof server, including the carry attack (one byte + 256, the next − 1, which rebuilds the same number): the circuit's 8-bit range check of the byte refuses it. Most of those cases name the digest check beside the hint's, because the forged byte also changes the digest the circuit computes. Section `isolate` refuses each hint check alone: the forged hint is signed as the circuit renders it, so only that check refuses, after the honest call proved through the same patched copy. It covers the digest (a device's and a grantee's signature over an unrelated value passed as the digest hint), `be4` (a removal's `targetEpoch`), `be8` (a device approval and a grantee approval replayed after their nonce advanced, each with the nonce hint of the signed nonce; a removal's `targetCounter`, which compares an argument), `be16` (an amount, a change, a scope cap) and `evm_bytes_of` (a k256 target's x, a site label, the device key's coordinates under a boot commitment to the address they hash to); `low20` and `visible_21` have such cases in `hints` (a key hash or account hash byte outside the 20 bytes used; a passkey origin byte). Each check's deletion mutant lets its forgeries through ([evidence](evidence/evm-k256/seam-mutants.json)). The two replays compare the nonce hint with a value the circuit reads from the ledger (`auth_nonce`, the grant record's nonce), so they are recorded as refused through a declared read: an honest prover declares the real nonce and the check fails at the proof server, while against a malicious prover, who declares the old nonce, the node's replay of the transcript against the real state refuses the call (see "Predicates over ledger reads" below).

There are three entry shapes, each one self-contained body: `require_authorised_with_evm_k256<T>` (one message type), `require_authorised_with_evm_k256_either<T, U>` (`remove_device`'s two forms: it builds both struct hashes from its own frame and verifies the one the call selects) and `require_authorised_with_evm_k256_bare` (a type with no members of its own, `RevokeAllGrants` and `CancelRecovery`). Each body derives the address from the presented point, builds the frame from `kernel.self()`, that address and `auth_nonce`, builds the struct hash, checks the entry, verifies the signature and rolls the entry; no circuit that checks or rolls a device entry takes an address, an account, a nonce or a struct hash from its caller, and an export passes only its operation's type hash and fields. The pure builders the bodies share with the exported oracles (the struct hash, the digest, the entry recipe) only compute values. Each body returns the caller's post-roll entry, which `remove_device`'s S13 guard needs. This shape is held by functional tests, not by reading the source: the mutants that would break it (an export skipping the seam; a body framing another account, address or nonce; a grantee twin handing its seam, or rendering, another amount, recipient or colour; the grant frame with a constant nonce) each fail the offline suites (`evidence/evm-k256/seam-mutants.json`). The offline layer alone (`npm run test:evm_k256-offline`) also holds every authorisation property (`evm-k256-seam-offline.ts`): each of the 15 gated exports refuses an approval over another account's frame, another key's signature with the signer's own opening, and zero scalars, and then lands with the honest approval; each shielded spend refuses a held coin of another colour; each grantee twin refuses a recipient other than the pinned one; both shielded grantee twins refuse a coin above the grant's max coin value and a change entry sealed to a key that is not the live one; `remove_device` refuses the device's own entry in both forms; and a grant of the old epoch is refused after a recovery finalisation (`evm-k256-recovery-sim.ts`). 26 property mutants (every seam call deleted, the zero-scalar assert deleted, the colour asserts deleted, a shielded twin handing its scope the pinned recipient, the grant seam without its epoch check, either shielded twin without `check_shielded_grant_bounds`, `remove_device` handing its self-removal guard a zero entry) are all caught offline, the zero-scalar assert's deletion only at `K256Core` alone (below): through the arm it is not equivalent, but no test can show its forgery (`evidence/evm-k256/seam-mutants.json`). Without `K256Core`'s zero-scalar assert, `s = 0` is still refused (it has no inverse in the ECDSA relation: the circuit has no witness for it, and the generated JavaScript throws), but `r = 0` is refused only by the final comparison: with `r = 0`, `u2 = r/s = 0`, so the signature verifies exactly when the x-coordinate of `u1·G` is 0 mod n. That point exists: `x = n` is below the field prime, and `(n, 0x98f66641cb0ae1776b463ebdee3d77fe2658f021db48e2c8ac7ab4c92f83621e)` is on the curve, so for its discrete logarithm `k`, any non-zero digest scalar `z` and `s = z/k` give a signature with `r = 0` that verifies under every key. Writing that input down needs `k`, a discrete logarithm, so no test can build it, and every `r = 0` forgery a test can build is refused without the assert (the proof server, given that mutant's own keys, refuses each prover-suite case with `r = 0` by a constraint, and each with `s = 0` because the inverse of 0 has no witness). The assert stays: it refuses `r = 0` outright instead of resting on that hardness, and makes both refusals explicit and attributable. At `K256Core` alone (below) its deletion is observable: `r = 0` is no longer refused and the verification returns false. The key rule of `K256Core`, deleted, is equivalent through this arm only: the arm derives the key's address before it verifies, and that already fails for the point at infinity (the coordinate extraction of the flagged encoding; the unflagged `(0, 0)` is not a point a circuit is given). The core alone accepts it without the rule: with `Q = O`, `u1·G + u2·Q = u1·G`, so the digest 1, `s = 1` and `r = x(G)` verify without any private key. `contracts/probe-k256-core.compact` exports the core on its own, and `src/tests/k256-core-probe-offline.ts` (in `test:evm_k256-offline`) refuses there the flagged point at infinity, the only encoding of it a `Secp256k1Point` argument can carry, by the key rule and by the verification with that construction, and `r = 0`, `s = 0`, `(r, s) = (0, 0)` and a wrong digest hint, after honest controls (both S forms accepted, another key or digest false); the key rule's deletion and the verification without its own call of the rule each let the construction through there. The unflagged `(0, 0)` never reaches the core: it is not a point of the curve, and the generated argument check refuses it ("expected value of type Secp256k1Point") at both entries, which the test asserts as that layer, not as a core refusal.

**The grant seam** (`require_grant_with_evm_k256<T>`, grantee role) applies the same rule to the grantee frame (`account`, `grantee`, `siteLabel`, `slot`, `issuedAt`, `grantNonce`). It derives the grantee's address from the presented point, then the grant id from that address, the blind, H(origin tag ‖ label) and the slot. It reads `issuedAt` and the nonce from the record, never `auth_nonce`, and touches no device entry. The MIP's steps run in order: the record by id; liveness (active, epoch, generation, expiry); upstream's shared `check_spend_scope` (operation, caller pin, object, per-call cap, spent opening, cumulative cap, recipient pin); the signature (`k256_ecdsa_verify`, which refuses the point at infinity as the key and `r = 0` or `s = 0`); the record written back with its nonce advanced and the new spent commitment; `round` bumped. The shielded twins assert `coin.color == color` and run upstream's `check_shielded_grant_bounds` (coin value, live `enc_key`) first.

**Use counters.** A call presents the use counter of the device's live entry, and the client finds it on the ledger (`resolveEvmK256Counter`, which every helper of this arm uses). Every circuit that enrols a device of this arm inserts its entry at counter 0 (the activation and `add_device`), and every successful device-gated call removes the caller's entry at counter `c` and inserts it at `c + 1` in the transaction that advances `auth_nonce` by one; `auth_nonce` starts at 0 and never decreases (recovery's finalisation advances it too, and clears the device set). So an entry enrolled at counter 0 is live at a counter no greater than `auth_nonce`, and the client's scan of `0 … auth_nonce` finds it however many calls the device has made: there is no fixed ceiling. The client checks the counter it last confirmed for the account, device and epoch first (or one its caller gives: `resolveEvmK256Counter(account, device, { counter })`, `EvmK256Device.noteCounter`), then scans forward from it through that counter plus `auth_nonce` (a device's counter grows by one per call, and `auth_nonce` counts every call; never past 2^64 − 1, the largest counter), then from 0 up to it; the next call of a device therefore costs two membership probes. A counter a caller gives must be a `Uint<64>`, and is refused before the ledger is read otherwise. A scan runs in chunks of 256 probes and yields to the event loop between two chunks, so a long one does not block the page, and an `AbortSignal` (the `signal` option of the resolver, of every helper, of `evmK256DeviceFinds` and of `restoreEvmDevices`) stops it between chunks with an error naming the probes made and the signal's reason as its cause. Upstream's `add_device_with_jubjub`, `_with_k256` and `_with_p256` take an already-derived entry, whose counter the contract cannot read: an entry derived at a counter `k > 0` is live at `k`, and the scan reaches it only while `k ≤ auth_nonce`. Above that the client refuses with the range it scanned, and the caller gives `k`. Restores test entries the same way (`evmK256DeviceFinds`, `restoreEvmDevices`, which takes each account's `auth_nonce`).

**The arm's own rules on top of upstream's chips.**

- Every shielded spend asserts `coin.color == color` and `amount ≤ coin.value`.
- `add_device` derives the new entry at the current `device_epoch` and counter 0, so the arm cannot plant a future-epoch entry.
- `remove_device` takes the target's epoch and counter (removal only reduces authority, so a planted `device_epoch + 1` entry can be evicted), or a literal entry under the fixed line "Removes a device this wallet cannot identify". The Maybe that selects the form must be canonical when absent.
- `issue_grant` hashes the read key as zero, and requires it to be zero, when `read` is off, so that nothing is stored that the wallet did not show. It requires a non-zero key when `read` is on. It admits an RP hash only for a passkey grantee whose scope can spend (the rule below), so that no hash-like value that nothing checks ever appears in an approval. It stores SHA-256 of the shown read key as `read_pk_hash`, as the grants MIP defines it.
- A passkey's own RP pin is never zero where it is checked: `add_device` and `remove_device` by descriptor refuse a passkey target with an all-zero RP hash; `issue_grant` requires the RP hash to be non-zero exactly when the grantee is a passkey and the scope can spend (upstream reads the pin only on the passkey spend path, `account-p256.compact`), and zero otherwise. So "not applicable" means exactly "no RP pin is checked". A zero-RP passkey entry planted by an upstream arm's raw `add_device` is removed with the literal-entry form (`RemoveUnknownDevice`), the only form that does not describe the target.
- `issue_grant` refuses a recipient under recipient kind 0, "any recipient": upstream's chip commits the recipient but enforces it only for a pin, so a value shown without effect would otherwise be possible.
- These issue rules sit in `evm_k256_parts_issue_grant`, the circuit that builds the shown values, so the struct oracle refuses them as well; the client codec refuses every issue rule the circuit reaches before any wallet signs, in the circuit's order and with the circuit's messages: the read key without `read` and `read` without a key, the grantee (a registered tag, a Solana key that is not the identity, the site label, the passkey origin, the k256 envelope), the RP rules, a recipient under "any recipient", the recipient kind, then the shared chip's issue rules. For a passkey device, the origin is checked before the RP hash.

**The seam owns the frame.** An export passes only its operation's type hash and tail, from the module's `evm_k256_parts_<operation>` circuit. The seam supplies every frame value itself: `account` is `kernel.self()`, `device` is the address of the presented point, and `authNonce` is the ledger's (read before this call advances it). No export can name an account, a device or a nonce, so an entry is matched and a signature verified only for the address of the key that signed. The exported struct-hash oracles `evm_k256_struct_<operation>` are built from the same frame builders (`evm_k256_device_struct<T>`, `evm_k256_grantee_struct<T>`) and the same parts, so an oracle and its export cannot diverge. `keccak256` over a tuple whose last member is a generic tuple hashes that member flat (the contract, the client and the independent implementation agree on every frozen vector). A malicious-prover mutant that forges the derived address in the generated JavaScript (so that the victim's entry matches while the attacker's key signs) is refused at the proof server (`evm-k256-prover.ts`, section `frame`).

The table below gives the acceptance policy. Each rule's refusing layer was measured with the JavaScript checks bypassed, after a proved positive control (`npm run test:evm_k256`, `evm-k256-prover.ts`). The suite runs 442 cases across all 16 circuits: 306 refused at layer `constraint`, 79 at `constraint on a declared read`, 3 decoding refusals, 7 runtime-only (the reason recorded), 38 positives proved, 8 state-only positives and 1 case not applicable (reason recorded). Every patched copy proves the honest call of its circuit through itself: 306 negatives prove it before their own attempt, and 82 share the control proved through the same copy in their section, which the record names for each. A patched copy bypasses only the asserts its case names, so a case that names one assert isolates it. Most cases that name more than one cannot be separated: the tag pairs, a zero scalar with the signature check, the point at infinity, a replayed approval, the last device, the identity as the recovery key, and a second activation (the first activation clears the boot commitment, so a second one fails the boot check as well). Three cases are kept end to end although their asserts can be separated: "caller-pinned grant, no contract caller" on each grantee twin names the caller's presence and the caller match, which the zero-pinned cases and "called by another contract" isolate; the two `remove_device` binding cases ("targetCounter signed 0, executed 1", "the literal entry changed after signing") name the signature check, which the form-swap and fixed-line cases isolate, and the target's membership in upstream's removal chip (`unknown device entry`, the seam's message too), an unchanged upstream assert with no case of its own ([evidence](evidence/evm-k256/prover-suite.json)). `EVM_K256_DRY=1` runs every section at the JavaScript layer alone, with no proof server, so a client change that breaks a section shows before any proof is made.

| Rule | Enforced by | Refused at (simulator / prover) |
|---|---|---|
| The signature covers exactly the executed values (binding: `newKey`, `account`, `device`, `authNonce`, `effect`, the domain's name, version and verifyingContract, the type name, a member name) | the in-circuit digest + `k256_ecdsa_verify` (the standard library's algorithm over the digest's checked bytes, both S forms) | "invalid signature" / `/check` 400 "Failed direct assertion" |
| The key, blind and counter open a live entry (an unenrolled key, another blind, a wrong counter) | the entry membership assert | "unknown device entry" / `/check` 400 |
| `r ≠ 0`, `s ≠ 0`, and `(r, s) = (0, 0)` | `K256Core`'s zero-scalar assert (in `k256_ecdsa_verify`), with the ECDSA relation behind it | the core's assert / `/check` 400. With `r = 0` or `s = 0` alone, the signature check fails too, and no input separates the two (in the circuit `s = 0` has no inverse, and `r = 0` cannot satisfy the relation), so those cases name both. `(0, 0)` verifies in the generated JavaScript once inverses of 0 are taken as 0, so only the core's assert fires in the copy; the case is run through each of the three bodies and the grant seam (section `core` runs `r = 0` and `s = 0` at every one of the 15 gated exports), and at the proof server the relation's inverse refuses `s = 0` as well |
| Both S forms accepted | `k256_ecdsa_verify` (FIPS 186-5, as the standard library's) | the high-S twin proves and lands. The low-S original is then refused: "unknown device entry" (simulator), `/check` 400 (prover), and node `1010: Invalid Transaction: Custom error 104` for its proof made before the twin landed (three submissions; a fresh call from the same wallet landed in between) |
| The point at infinity (flagged) | ZKIR coordinate extraction; `K256Core`'s key rule (defence in depth) | "cannot extract the x-coordinate" / "Cannot extract coordinates of the Secp256k1 identity" |
| The unflagged `(0, 0)` | the runtime validator; the honest proof server's input decoding; in-circuit, the `Secp256k1Point` on-curve assignment (`(0, 0)` is not on the curve) | type error / proof-server input decoding "Failed to decode" (a decoding refusal of an honest prover, not a constraint failure; see the note below) |
| A coordinate not reduced below `p` | the runtime's foreign-field encoder; the honest proof server's input decoding; for soundness, the circuit library's canonical byte cast (below) | type error / proof-server input decoding "The encoded value of type Secp256k1Point is not in canonical form" (not a constraint failure) |
| Replay across accounts, arms (`k256` ↔ `evm_k256` with the same key), operations (`CancelRecovery`, `RevokeAllGrants`), roles (a grantee type) and nonces | the domain and type hash in the digest; the arm-specific digest rule | "invalid signature" (or "unknown device entry" for a consumed entry) / `/check` 400 |

**Decoding refusals are not constraint refusals.** The last two rows above are refused by the honest toolchain: the runtime's encoder and the proof server's input decoder. A malicious prover builds its own witness and never runs that decoder, so these rows do not show that a constraint refuses the value. Two facts close it. A secp256k1 coordinate `c` has a second 32-byte representation `c + p` only when `c < 2^256 − p ≈ 2^32`, so for any real key the cast to `Bytes<32>` has no alternative output, and forging an address through it would also need a keccak256 preimage; the same bound applies to the `secp256k1PointX` inside the verification. The `(0, 0)` point is refused in-circuit by the on-curve assignment. And the cast itself, the question upstream #182 left open, is constrained canonical in the pinned circuit library: ZKIR 3.1.0-rc.1 lowers a `Secp256k1Base` value to bytes with the base field chip's `assigned_to_le_bytes` (`zkir/src/ir_instructions/to_bytes.rs`), which decomposes it with `assigned_to_le_bits(…, enforce_canonical = true)` and, at the full 256 bits, asserts `is_canonical` on the bits (midnight-circuits 7.2.4, the version ZKIR 3.1.0-rc.1 locks, `src/field/foreign/field_chip.rs`, `assigned_to_le_bits` and `assigned_to_le_bytes`); so even a malicious prover has one byte encoding per coordinate, and the decoding refusals above are the honest toolchain's first line, not the only one.

**Predicates over ledger reads hold through the constraint and the node's replay together.** Many asserts test a value the circuit reads from the ledger or the call context: the entry's membership in `devices`, the grant record (its liveness, caps, commitments and nonce), `enc_key`, `auth_nonce`, the mirror balance, the block time, the caller. Such a read enters the proof as a public transcript value that the prover declares. An honest prover declares the real value, and the assert fails at the proof server. A malicious prover can declare the value the assert needs and prove the call; the node then refuses the transaction, because it re-runs the transcript against the real state. The evidence labels these refusals `constraint on a declared read` (as distinct from `constraint`, a relation over the call's own inputs and witnesses, such as every signature-binding case). The node-side half is shown by the stale-proof run of section 9's table: a proof made against an earlier state was refused by the node (`1010` / 104), and replaying its transcript with the ledger's own `QueryContext.runTranscript` reports `mismatch between expected … and actual … read` for the `auth_nonce` read.

**The grantee path** (`require_grant_with_evm_k256` and the three twins), measured the same way (`evm-k256-prover.ts` sections `grants`, `grant-matrix`, `frame-lifecycle`; every case under a valid grantee approval, with the honest call proved through the same patched copy first):

| Rule | Enforced by | Refused at (simulator / prover) |
|---|---|---|
| The approval covers exactly the executed values (amount, recipient, colour; for the shielded twins the change entry, the encryption key and the spent coin's nonce, value and Merkle index) | the in-circuit digest + `k256_ecdsa_verify` | "invalid grant signature" / `/check` 400, constraint |
| The record is live: active, of the current device epoch and grant generation, not expired | the grant seam's four asserts | "grant revoked", "grant epoch stale" (after a recovery finalisation, which keeps `grants`), "grant expired" / `/check` 400, a declared read. "grant generation stale" is **unreachable** in this contract: `revoke_all_grants` bumps the generation and clears the map, and no chip writes a record of another generation; it is defence in depth for a ledger that keeps records, exercised on a state built by copying the generation cell |
| The operation is in the grant's scope (a grant with the same object fields admitting another operation only) | upstream's shared `check_spend_scope` | "operation not in scope" / `/check` 400, a declared read |
| The caller pin's presence and type asserts, apart from the commitment: a grant pinned to the zero contract address (which equals the default `caller.value.left`) called with no caller, or by a user | upstream's shared `check_spend_scope` (`caller.is_some` and `caller.value.is_left` share one message) | "grant requires a contract caller" / `/check` 400, a declared read (the zero contract presenting itself proves through the same copy). No caller fails both asserts (an absent caller is never left); a user caller fails the type assert alone |
| The scope: per-call cap, cumulative cap, recipient pin, caller pin (no contract caller; another contract), the object opening (one opening member, the max coin value, other than the record's), the spent opening (a spend the record does not hold) | upstream's shared `check_spend_scope` | the chip's messages / `/check` 400, a declared read (the record and the caller are reads), on all three twins |
| A coin above the grant's max coin value; a change sealed to a key other than the live `enc_key` | upstream's shared `check_shielded_grant_bounds` | "coin above max_coin_value", "stale encryption key" / `/check` 400, a declared read |
| The spent coin's colour is the approved colour | the twin's own assert | "held coin colour does not match the withdrawn colour" / `/check` 400, constraint |
| `r ≠ 0`, `s ≠ 0` | `K256Core`'s zero-scalar assert, through the grant seam's verification | the core's assert / `/check` 400, constraint; `r = 0` or `s = 0` alone with the signature check (as for the device seam), `(0, 0)` alone in the copy, on all three twins |
| The frame's site label follows the label grammar (a grant planted for the grantee under a label with two spaces) | the grant seam's frame (`evm_k256_site_label_hash`) | "evm_k256: not a site label" / `/check` 400, constraint, on all three twins |
| The grantee address is derived from the presented point (a forged derivation) | the grant seam | "unknown grant" / `/check` 400 "Public transcript input mismatch" |

**The descriptor and label rules** keep what the wallet shows one-to-one with what the circuit executes. Each is refused at the proof server under a valid signature over what the circuit shows for the executed value (where the codec refuses the value, its message for the admissible value is patched before signing), with the admissible call proved through the same patched copy first (`evm-k256-prover.ts` sections `devices` and `grants`). On `remove_device` and `revoke_grant` the refused descriptor names an entry or a grant that an upstream k256 device planted raw, so only the descriptor rule refuses.

| Rule | Circuits | Refused at (simulator / prover) |
|---|---|---|
| A registered device tag (an unregistered tag; another recipe's tag) | `add_device` | "evm_k256: not a registered device tag", with the base's 117-byte class assert, which refuses the same tag / `/check` 400, constraint |
| A registered grant-id tag (an unregistered tag; another recipe's tag) | `issue_grant`, `revoke_grant` | "evm_k256: not a registered grant-id tag", with the base's 64-byte grant-id assert, which refuses the same tag / `/check` 400, constraint |
| A passkey origin of visible ASCII (one byte a space) | `add_device`, `remove_device`, `issue_grant`, `revoke_grant` | "evm_k256: the passkey origin is not visible ASCII" / `/check` 400, constraint |
| A site label that follows the grammar (two spaces in a row) | `issue_grant`, `revoke_grant` (the grantee); the three grantee twins (the frame, above) | "evm_k256: not a site label" / `/check` 400, constraint |
| A k256 envelope with a label (2, shown with the envelope-1 label the circuit selects) | `add_device`, `remove_device`, `issue_grant`, `revoke_grant` | "evm_k256: not a k256 envelope" / `/check` 400, constraint |
| A recipient kind with a label (4, shown with the kind-3 label the circuit selects) | `issue_grant` | "evm_k256: not a recipient kind" / `/check` 400, constraint |
| `read` on requires a non-zero read key, and off a zero one | `issue_grant` | "evm_k256: read without a read key", "evm_k256: a read key without read" / `/check` 400, constraint |
| A passkey's RP hash is non-zero exactly where its pin is checked; no recipient under "any recipient" | `add_device`, `remove_device`, `issue_grant` | the arm's messages / `/check` 400, constraint |
| A Solana key that is not the identity (`A ≠ O`, the descriptor module's ed25519 class, which `add_device`, `remove_device`, `issue_grant` and `revoke_grant` reach) | `add_device` at the proof server; `issue_grant` at runtime (`evm-k256-grants-offline.ts`) | "descriptor: the Ed25519 key is the identity" / `/check` 400, constraint (the approval shows the base58 text of the identity's encoding `01 00…00`, the key the circuit derives) |

**The shared display, descriptor and Ed25519 checks, through this arm's circuits.** Each assert below belongs to the shared rendering module, the descriptor module or the Ed25519 core and is refused at the proof server through the circuit named, after the honest call proved through the same patched copy (`evm-k256-prover.ts`; this table is generated from the record and the site coverage below). Each case breaks only that rule with every other check holding, under a valid signature over what the circuit renders from its display inputs:

| Shared check (module message) | Site | Refused through | Section | A case names it alone |
|---|---|---|---|---|
| "display: not a UTC date and time" | `WalletArmRendering.compact:236` | `issue_grant` | `texts` | yes |
| "display: month out of range" | `WalletArmRendering.compact:237` | `issue_grant` | `texts` | yes |
| "display: day out of range" | `WalletArmRendering.compact:238` | `issue_grant` | `texts` | yes |
| "display: time of day out of range" | `WalletArmRendering.compact:239` | `issue_grant` | `texts` | yes |
| "display: the year split is not canonical" | `WalletArmRendering.compact:240` | `issue_grant` | `places`, `texts` | yes |
| "display: the date and time do not match the value" | `WalletArmRendering.compact:241` | `issue_grant` | `hints`, `texts` | yes |
| "display: not the words for a time after 9999-12-31 23:59:59 UTC" | `WalletArmRendering.compact:242` | `issue_grant` | `texts` | yes |
| "display: not a left-aligned base58 text" | `WalletArmRendering.compact:415` | `add_device` | `texts` | yes |
| "display: the leading base58 ones do not match the leading zero bytes" | `WalletArmRendering.compact:416` | `add_device` | `texts` | yes |
| "display: the base58 carry hints do not split the leading digits" | `WalletArmRendering.compact:417` | `add_device` | `hints`, `texts` | yes |
| "display: the base58 digits do not match the value's low bytes" | `WalletArmRendering.compact:419` | `add_device` | `texts` | yes |
| "display: the base58 digits do not match the value's high bytes" | `WalletArmRendering.compact:421` | `add_device` | `texts` | yes |
| "display: not a site amount label" | `WalletArmRendering.compact:549` | `withdraw_unshielded` | `texts` | yes |
| "display: the symbol does not start with a letter" | `WalletArmRendering.compact:550` | `withdraw_unshielded` | `texts` | yes |
| "display: more than 18 decimals" | `WalletArmRendering.compact:551` | `withdraw_unshielded` | `texts` | yes |
| "display: symbol longer than 8" | `WalletArmRendering.compact:552` | `withdraw_unshielded` | `texts` | yes |
| "display: leading zero in the site amount label" | `WalletArmRendering.compact:553` | `withdraw_unshielded` | `texts` | yes |
| "display: the site amount label does not match the value" | `WalletArmRendering.compact:554` | `withdraw_unshielded` | `hints`, `texts` | yes |
| "ed25519: the encoding does not match the point's y" | `Ed25519Core.compact:57` | `add_device`, `issue_grant`, `remove_device`, `revoke_grant` | `hints`, `places` | yes |
| "ed25519: the x bytes do not match the point's x" | `Ed25519Core.compact:63` | `add_device`, `issue_grant`, `remove_device`, `revoke_grant` | `hints`, `places` | yes |
| "ed25519: the sign bit is not x's parity" | `Ed25519Core.compact:64` | `add_device`, `issue_grant`, `remove_device`, `revoke_grant` | `places`, `texts` | yes |
| "descriptor: the Ed25519 key is the identity" | `WalletArmDescriptors.compact:414` | `add_device` | `devices` | yes |

**What the constraint-level negatives cover** ([evidence/evm-k256/assert-coverage.json](evidence/evm-k256/assert-coverage.json), generated from the run of record). Its sites are given at their lines in this tree, and the cases and counts below are the run's. Each assert is a site: its file, its line and the circuit it is written in. A site counts when one of the arm's exported circuits (its own and the pure circuits it re-exports) reaches that circuit by the call graph. A case refuses a site when the site's message is the case's expected refusal, it is refused at layer `constraint` after the honest call proved through the same patched copy, and the circuit under test reaches no other site with that message; where it reaches several (the three word hints `be4`, `be8` and `be16` share one message, the byte hints of `evm_bytes_of` and the origin's `visible_21` another), the site is the one whose deletion mutant alone lets the case's forgery through. Of the arm's 47 asserts (32 messages, in `contracts/account-evm-k256.compact`, `contracts/modules/EvmK256.compact`, `contracts/modules/K256Core.compact` and `contracts/modules/EvmIdentity.compact`, all reached; `contracts/modules/Eip712V1.compact` has none), 42 are each refused that way by a case of their own, under a valid signature over what the circuit renders. The seven checked-hint sites among them each have a case where the forged hint is signed as the circuit renders it, so only that check refuses (section `isolate`; for `low20` and `visible_21`, section `hints`): the digest (`K256Core.compact:58`), `be4` (a removal's `targetEpoch`), `be8` (a replayed device or grantee approval with the nonce hint of its signed nonce; a removal's `targetCounter`), `be16` (an amount, a change, a scope cap), `bytes_of` (a k256 target's shown x, a site label, the device key's coordinates), `low20` and `visible_21`; each check's deletion mutant accepts that forgery. The other 5: "k256: the key is the point at infinity" (`K256Core`'s key rule), named only beside other asserts because no input isolates it (the flagged identity also fails the coordinate extraction, and on a gated call the entry and the signature), and "amount above the spent coin's value" (4 sites, the four shielded circuits), which the runtime's type encoder refuses before any proof request (the change would be negative; in the circuit the assert, the subtraction's range check and the signature over the shown value refuse it); each case records that reason. The shared modules (`contracts/modules/WalletArmDescriptors.compact`, `contracts/modules/WalletArmRendering.compact`, `contracts/modules/Ed25519Core.compact`) have 35 asserts in circuits the arm reaches; 22 are refused the same way (the table above). The three checks of the shared Ed25519 encoder (y, x and x's parity) are each refused alone at every place a Solana key enters: `add_device` and `remove_device` (a target), `issue_grant` and `revoke_grant` (a grantee); a forged y or sign bit is shown in base58 and signed as shown, and where it names another entry or grant, an upstream k256 device planted that entry or grant raw. The year split is refused both when it breaks its equation and when it keeps the equation and breaks a bound (one leap day fewer, so the date one day later reads back to the same seconds, signed as shown). The other 13 are the recipes' tag checks, which cannot fire through the arm: it selects each recipe by its class, which is the tag's equality test, and passes constant tags in its seams and activation, so an unregistered tag is refused by the arm's registered-tag check first (the 117-byte device and 64-byte grant-id classes it falls through to are refused together with it); 2 of them are reached only by a pure export, computed in JavaScript and never proved. The modules' other asserts are in circuits no arm circuit reaches (`decimal_text`, `derive_signer_entries_ed25519`, `ed25519_verify`, `k256_envelope_text`, `label_text`, `recipient_kind_text`, `visible_text`). The shared modules' own probe suite refuses each tag check at the proof server. The shared chips the arm calls unchanged from upstream are covered by upstream's own tests and by the regression batch, which runs upstream's suites on this account; the arm's wiring into them is covered by the mutant tables (`evidence/evm-k256/seam-mutants.json`) and by the arm-supplied prover cases (the grant seam's scope, liveness and shielded bounds; the removal of the authorising or the last device; the recovery chips). These chip asserts therefore have no constraint-level case of their own:

- `do_issue_grant`: "grant already active", "empty scope", "read-only grant cannot restrict caller", "shielded spend requires read", "per-call cap above cap", "spend without cap", "coin bound below per-call cap", "window bounds reserved" and "read-only grant carries object fields", each with a runtime negative through `issue_grant_with_evm_k256` (`evm-k256-grants-offline.ts`, under an approval that honestly shows the refused call); "read without delegate key" cannot be reached through the arm, which stores SHA-256 of a non-zero read key;
- `do_revoke_grant`: "unknown grant" and "grant not live", each with a runtime negative through `revoke_grant_with_evm_k256` (`evm-k256-grants-offline.ts`);
- the device insert (`do_add_device`): "device entry already present";
- the device removal (`do_remove_device`): "unknown device entry" for the target, which fires together with the signature check in the two removal binding cases.

The grant call never reads or advances `auth_nonce` or a device entry. That rests on the source (the grant seam reads `issued_at` and the nonce from the record and writes back only that record and `round`) and on state checks in the simulator and on node; unchanged state alone cannot show that a value was not read, so it is not counted as a constraint-level result.

**Field values are rendered canonically.** `PublishRecoverySession` shows the JubJub recovery key's coordinates and the phi values as 32-byte little-endian words, cast in-circuit from `Field` to `Bytes<32>`. ZKIR 3.1 lowers the cast to `div_mod_power_of_two(val, 248)`, which decomposes the value with `assigned_to_le_bits(val, None, enforce_canonical = true)` over all 255 bits (midnight-circuits 7.2.4: the low bit is tied to `sgn0(val)`, which leaves exactly one bit vector). A value `f` therefore has one rendering, never `f + r`. The prover suite (section `qa-s3`) signs each of the four members over its non-canonical rendering `f + r` and executes `f`: each is refused at the proof server (`/check` 400, layer `constraint`), after the canonical rendering proved through the same patched copy. That includes an unused phi slot, whose value is 0 and whose non-canonical rendering is `r` itself: 0 is the one value whose sign bit admits two witnesses, and the gadget still forces `sgn0(0) = 0`, so both dishonest witnesses are unsatisfiable.

## 10. Network

The domain carries no network value, as upstream's arms carry none: the contract has no network field, and a circuit cannot read the network id (Compact's `Kernel` offers no such read). What binds an approval is the account: the frame names the account (every type's `bytes32 account`, taken from `kernel.self()`), and the device entry is derived from the account address and the blind. The domain is the same for every account and network.

**The clone argument.** The ledger derives a contract's address from its deploy (initial state and nonce) alone, without the network id, and signs maintenance updates over `(address, updates, counter)`. Someone who replays an account's public deploy on another network therefore gets an account at the same address, with the same initial state. Whenever that clone is in the state an approval was signed against (the same device entry and `auth_nonce`), the approval verifies there as well, because nothing in it names the network. No in-contract value can tell the clone apart: a salt sealed into the state at deploy time is copied with the deploy, and the network id cannot be read. So the arm does not claim network separation, and the MIP's "SHOULD bind a network" is replaced by this argument.

**Mitigations.**
- The reference client deploys with a fresh random deploy nonce and a fresh 32-byte boot salt, so an honest account has no twin unless someone deliberately replays its deploy and its history on another network.
- The blind request names the network (section 2), so the same wallet has different blinds, and therefore different entries, on different networks.
- The upstream ledger issue proposing that the network id be bound to the contract address, to the maintenance-update envelope, or be exposed to circuits is drafted (filing pending).

## 11. Measurements

The per-circuit report (k, rows, prover-key size, proving time, verifier-key bytes) is [EVM-K256-MEASUREMENTS.md](EVM-K256-MEASUREMENTS.md), with its evidence in [evidence/evm-k256/circuit-sizes.json](evidence/evm-k256/circuit-sizes.json). Every circuit is at k ≤ 18; the widest is `issue_grant_with_evm_k256`.

Where the rows go (mock-compile measurements):

- keccak256 costs about 4.2k rows per 136-byte block. A tuple of `Bytes<32>` words hashes at that cost; building one flat `Bytes<N>` from slices costs about 18k rows more per 128 bytes, so every preimage here is a tuple.
- The domain separator is a circuit constant, so the digest is one keccak256 block (`0x19 0x01`, the separator and the struct hash). A domain derived from the account would cost two more keccak256 calls (the account's hash and the separator) and a 32-byte checked hint in every verifying circuit, about 9.2k rows.
- The address costs one keccak256 block over the coordinates' bytes plus its checked hints; the standard library's `secp256k1EthereumAddress` costs about 22k rows more in each device circuit (its comparison with the default point, about 12k; its byte reversals and the hash's slice, about 15k). The arm's verification costs about 12.5k rows less than `secp256k1EcdsaVerify` in each circuit (its comparison with the default point, and the digest's byte reversal).
- A checked hint costs about 14 rows per byte as an argument of an impure circuit (its range check and its share of the communications commitment) plus about 8 rows per byte to rebuild the value; extracting the same byte from a value costs about 147.
- A big-endian `uint128` word costs about 0.5k rows and a `uint64` about 0.25k from a checked hint (extracted byte by byte: 4.7k and 2.3k); addresses, booleans and `uint8` words are free as tuple elements.
- Reversing a `Bytes<32>` costs about 0.8k rows from a checked hint of its bytes (the k256 and P-256 descriptor coordinates) and about 4k rows when it comes from a cast inside the circuit. JubJub coordinates and `Field` values are therefore shown little-endian: showing the recovery lines big-endian would add 24,407 rows and move `publish_recovery_session_with_evm_k256` from k 17 to k 18.
- The blind costs one SHA-256 block (about 1.9k rows) per derived entry or grant id.
- The grant's scope salt costs 3,707 rows in `issue_grant_with_evm_k256` (the SHA-256 of its 104-byte preimage, two blocks), which stays at k 18 with 189,595 rows.
- The enumerated-member labels cost at most 28 rows.
- The readable texts are checked in-circuit, and each costs rows: a site's amount label about 11.6k in each amount-moving circuit (the shared label check, about 6.1k; its 49 input bytes; the hash of the 70-byte text); a Solana key's base58 text about 6.7k in each descriptor circuit (the shared base58 check, its 47 input bytes, the hash of the 44-byte text); the expiry's UTC date and the window word together about 11.4k in `issue_grant_with_evm_k256`. They move `add_device_with_evm_k256`, `revoke_grant_with_evm_k256` and the two shielded grantee circuits from k 17 to k 18.

## 12. Recovery

Two device-gated circuits use upstream's shared recovery chips through the seam:

- `publish_recovery_session_with_evm_k256(new_recovery_pk, session_nonce, phi_1, phi_2, phi_3, phi_4, phi_len, wrap, auth)` runs `do_publish_recovery_session`;
- `recover_cancel_with_evm_k256(auth)` runs `do_recover_cancel`.

The recovery gate (`recover_submit`) and finalisation (`recover_finalise`) have no arm. The gate is opened by the recovery secret and the successor's co-signature, and finalisation is permissionless after the veto window.

**What the session approval shows.** `PublishRecoverySession` carries the fixed line "Sets this account's recovery key". It also carries every operand in full:

- the new recovery key's JubJub coordinates (`recoveryKeyX`, `recoveryKeyY`);
- the four phi values (`phi1`…`phi4`; unused slots are shown as zero);
- the session identifier, `phiLength`, and the 64-byte `wrap` as `bytes`.

Coordinates and phi values are 32 bytes little-endian each, as the contract encodes them. The circuit recomputes the digest from exactly the values it then stores. The test `evm-k256-recovery-sim.ts` checks that the stored recovery key, session identifier, phi values and wrap equal the shown ones. `CancelRecovery` is the bare frame (`account`, `device`, `authNonce`). Its type hash keeps it apart from `RevokeAllGrants`, which has the same members.

**The shared chip's rules apply as on every arm**, under a valid signature:

- no session while a recovery is pending;
- a phi length of 1 to 4, with unused slots zero;
- a non-zero, fresh session identifier;
- a fresh recovery commitment that is not the identity and not of small order;
- nothing to cancel is refused.

Before the wallet is asked to sign, the client facade (`evmK256RecoverySession`) refuses a phi count outside 1 to 4, a session identifier that is not 32 non-zero bytes and a wrap that is not 64 bytes. The other rules above (a pending recovery, a reused identifier or commitment, the identity or a small-order recovery key, nothing to cancel) are the circuit's: the shared chip refuses them under a valid signature.

**Finalisation retires every `evm_k256` device** (upstream #183). `recover_finalise` clears the device set before it installs the successor's entry. Every old entry is gone afterwards, including an `evm_k256` entry that an upstream arm's raw `add_device` planted at `device_epoch + 1` before the recovery (README erratum 7). That plant equals the planted device's entry at the new epoch and counter 0, so the bump alone would have left it live. After finalisation it is refused together with every other old device: in the simulator, at the proof server (with the generated JavaScript's checks bypassed), and on the shared stack against the finalised account's state (refused before submission by the generated JavaScript). This arm's own `add_device` cannot plant such an entry (section 9).

## 13. Direct transfers

`withdraw_shielded_to_contract_with_evm_k256` and its grantee twin send a shielded coin to another contract, which must claim it in the same transaction with its own `deposit_shielded` (MIP-0012 §6.6). Two client-side facts govern how such a transaction is built today:

- midnight-js 5.0.0-rc.2 (upstream's pin) refuses to build the sender's call alone: `assertReceivesMatchClaims` requires every contract-addressed output to be claimed inside the same call tree. The arm's tests build it with a test-only copy of the builder that drops that pre-check (`relaxedContractsModule` in `src/tests/evm-k256-negative.ts`); the node still checks the claim.
- The ledger matches a claimed output to its receive by segment, commitment and recipient. A claim grafted on as another intent is refused (`Custom error: 218`). What lands is both calls in one intent, with the recipient's call moved into the fallible segment when the sender's claim is partitioned fallible (the partitioner splits each call's transcript into guaranteed and fallible halves on its own).

**The effect of a failed fallible half.** The seam's state change (the device entry rolled, `auth_nonce` advanced) and the transfer can sit in different segments. If the transfer's fallible segment fails, the guaranteed segment still applies: the approval is consumed, the fees are paid, and no coin moves. The device must sign a fresh approval (over the new `auth_nonce`) to try again. A client should present a failed direct transfer as "not sent; approve again", never as pending.

## 14. Privacy and provenance

**What the blinding gives.** The ledger holds, for each `evm_k256` device, only SHA-256 outputs over its address and its blind: the boot commitment, the entries and the grant ids. Without the blind, a known Ethereum address cannot be tested against them. The point, the address, the blind and the signature are private inputs of every proof; the disclosure review of the arm's ten `disclose` sites (the consumed and successor entries of the three device bodies, the grant id, the spent commitment and the two grantee twins' change bits; none in the codec or the base modules) finds no other path, and a needle scan of every transaction and contract state of a localnet run of this build's on-node suites (blocks 1 to 2,281) found none of them in the clear while finding every control ([evidence/evm-k256/privacy-review.json](evidence/evm-k256/privacy-review.json)).

**What every circuit makes public.** The privacy review of the arm's sources ([evidence](evidence/evm-k256/privacy-review.json)) and of the shared chips they call lists what a call publishes:

- the entry point: the circuit called names the arm and the role (a device call, or a grantee call of an `evm_k256` grantee);
- blinded values: the consumed device entry and its successor, the boot commitment, and the grant id;
- salted commitments: a grant's spent, object, RP and caller commitments, under the grant's `scope_salt`, which the issuing call derives from the device's blind, the account and `auth_nonce` (section 1), so commitments of two grants or two issuances never share a salt;
- the change bit of the two shielded grantee twins;
- unshielded amounts, recipients and the account's unshielded balances;
- inbox ciphertexts (192 bytes each) and the account's encryption key;
- the grant scope fields upstream's chip stores in the clear: the operation and read flags, the per-call cap, the cap, the expiry, the window length and cap, and the record's issue time, nonce, epoch, generation, window start, window spend and state;
- `read_pk_hash`, an unsalted SHA-256 of the grant's read key;
- recovery material (the recovery key, the session identifier, the phi values and the wrap) and the counters (`auth_nonce`, `round`, the device epoch and count, the grant generation).

**Exposures this arm inherits.** Each comes from upstream's design or the standard library, not from the arm:

- **Pending calls and `round`.** Every gated call reads the shared `round` counter, which any permissionless deposit changes. A call proved before such a deposit fails at the node and must be proved again. Its signature stays valid and no funds are lost, but anyone can delay a pending call this way.
- **Spend tracing.** The standard library's `sendShielded` derives each output's nonce publicly from the spent coin's nonce, so whoever knows a spent coin (for example the depositor of that coin) can find its spend, recover the amounts and test candidate recipients.
- **Proving elsewhere.** A hosted or delegated proof server sees the call's private inputs, the key, the blind and the signature among them, and so learns which wallet controls which account. Clients should prove locally.
- **Read-key reuse.** `read_pk_hash` is published unsalted, so one read key used for two grants links them, across accounts too, and undoes the grantee blind. This arm's client derives a fresh read key for every account and grant (`EvmK256Grantee.readKey`): the secret is SHA-256 of a read seed, the account, the site label and the slot, clamped per RFC 7748, and the read seed is SHA-256(pad32("midnight:account:read:evm:v1") ‖ r ‖ s) over the grantee blind request's canonical signature, which the issuer never sees.
- **One device's chain of entries.** A call discloses the entry it consumes and its successor, and the next call of the same device consumes that successor, so one device's calls form a public chain within the account (upstream's rolling entries). The chain shows activity, not the wallet.
- **Unblinded upstream recipes.** `jubjub`, `k256` and passkey devices and grantees enrolled through this arm use upstream's recipes, which have no blind: whoever knows such a key can test whether an account holds it.
- **A to-contract spend to the account itself.** `withdraw_shielded_to_contract` may name the account as its recipient contract. No coin is stranded, but no inbox entry is written, and a grantee's cap is consumed by the call.

**What it does not give.**
- The blind is derived from a signature, so whoever obtains that `personal_sign` signature (for example a phishing page that shows the request) learns the blind and can recognise the account's entries. That is a loss of privacy, not of control: the blind authorises nothing.
- The client caches the blind in its local storage (section 2), so whoever can read that storage learns it and can link the wallet to the account. It is never sent. A grantee's read seed, which derives the keys that open the records a grant may read, is never stored: it stays in memory for the session.
- A grantee's blind is shown to the issuer (`EvmGrantee.privacySalt`), who needs it to derive the grant id. The client therefore derives a grantee's blind from its own request (`granteeBlindMessage`: "Midnight Passport grantee privacy key", the role, the network, the wallet and the issuing account's address, no account index), so the issuer never learns a device blind, and every issuer gets a different blind. The issuer can still recognise the grantee's calls on the issuer's own account, which is what a grant is for.
- A non-deterministic signer (MPC, hedged nonces) cannot re-derive its blind; enrolment signs twice and refuses it.

**Provenance.** The wallet shows every key and every piece of recovery material in full, but showing a key does not prove whose it is. A user who approves `AddDevice`, `IssueGrant` or `PublishRecoverySession` with a key or recovery material supplied by an attacker gives the attacker what the circuit-fixed effect line says. The mitigations:
- the effect lines are circuit constants ("Gives this key FULL control of this account", "Lets this key use this account within the limits below", "Sets this account's recovery key", "Sets the key that can read this account's private coin records"), so a page cannot soften them;
- the new device's own client renders the identical descriptor, so the user can compare the two screens (MIP-0013 S7); for an EVM device the address, and for a Solana device its 32-byte key, are forms the user can check against the other wallet by eye (section 6);
- recovery material comes from the client's own guardian ceremony, never from a page (a client obligation).

What remains is documented, not closed: a key the user cannot check by eye (`k256`, `jubjub`, a passkey's public key) is trusted on the strength of the client that shows it.

## 15. Wallets: the one format, the signer check and their limits

**One format.** The arm signs in one format, `eip712-v1` (the readable registry's `formats` in `src/wallet/descriptors.ts`): every approval is EIP-712 V1 typed data, signed with `eth_signTypedData_v4`, and every blind request (device or grantee) is signed with `personal_sign`. The client asks a wallet for nothing else (`EvmWallet`: `address`, `personalSign`, `signTypedData`, and optionally the other connected wallets' addresses), so there is nothing to detect: `evmK256WalletFormats()` is the registry's one format. Typed data under any other domain is refused before a wallet is asked (section 7).

**The signer check.** A wallet may answer with another account than the one asked for: two installed extensions can claim the same provider slot, and a user can switch accounts between requests. The address a wallet reports is not evidence of who signed, so every signature a wallet returns is checked before it is used, at every place one comes back: the device's approvals (`EvmK256Device.authorise`, `authorisationFrom`), the grantee's approvals (`EvmK256Grantee.authorise`), and each of the two signatures of a blind request (enrolment and restore). The check recovers the address from the exact digest the wallet was asked to sign (ecrecover with the signature's own recovery byte) and compares it with the address the signature must come from. A mismatch is refused before any proof (`SignerMismatchError`), with one of these messages:

```
signer: refused before proving: the signature is not from the expected Ethereum address <expected>; it verifies under Ethereum address <signer>, another wallet's key
signer: refused before proving: the signature is not from the expected Ethereum address <expected>, and the signer is unknown
```

Another address is named only when the signature recovers to it. The candidates are the addresses the other connected wallets report (`EvmWallet.otherAddresses`, from the browser adapter) and, in a restore from a record, the address the wallet reports; a candidate equal to the expected address, or not an address, is skipped, and a signature over another digest (another domain, a blind request offered as an approval) recovers to no candidate, so its signer is unknown. The check uses the shared rule `checkSigner` of `src/wallet/blind.ts` with this arm's own verification.

**The Ledger Ethereum app refuses EIP-712 V1 typed data by default.** With its default settings, the Ledger Ethereum app (1.22.5, Flex, on Speculos) refuses the arm's typed data with status `0x6a80` ("cannot be clear-signed. Enable blind signing"). The client cannot tell beforehand: an EIP-1193 provider reports only an address. With blind signing enabled in the app's settings, the device warns that assets could be lost and then shows the members (one 192-byte value cut after 187 bytes); its hashed view shows only two hashes. Clear signing on Ledger needs clear-signing metadata that Ledger signs for this domain, which is not available. Until then, a Ledger user of this arm must enable blind signing, or use another wallet; `personal_sign`, and so the blind request, works with the default settings. The Trezor Safe 5 (firmware 2.12.5) shows every member of the typed data with no hashed path.

**Auto-approval.** A wallet setting that approves signing requests without showing them (for example an auto-approve period) would sign Passport approvals unseen. Passport cannot detect it; such settings must stay off for a wallet used as a Passport device or grantee.

**Ed25519 key text (E3).** An enrolment kind chooses its `publicKey` text independently of the Ed25519 identity and derivation. `EvmK256Kind.key_text` in the contract is `base58`, `prefixed_base58` or `hex` (in that enum order); the client member `keyText` is optional and defaults to `base58`. Base58 is left-aligned and space-padded to 44 bytes. Prefixed base58 is the named constant `ed25519:` followed by those same 44 bytes, including padding (52 bytes total). Hex is exactly 64 lowercase characters, with no `0x`. The five existing kinds set `key_text` to `base58` (a filler for non-Ed25519 payloads); `sol_ed25519` keeps its frozen typed-data bytes and digests. The payload is named `ed25519`; the kind selects the presentation. A future kind using either additional form needs only its registry entries, tags and typed-data types. Every form computes the three text hashes in the shared descriptor path, and the base58 hint is checked even for hex and non-Ed25519 fillers. This adds no NEAR or Cardano kind.

**Upgrades.** Adding an arm or an enrolment kind later is additive in source: a new arm brings its own files plus its tags and one entry in the readable registry and one in the client's arm registry, and a new kind of an existing payload form is one entry of `evm_k256_kinds()` and one client line. It is not additive in keys: it changes the ZKIR, and so the verifier keys, of this arm's enrolment and grant circuits (`add_device`, `remove_device`, `issue_grant`, `revoke_grant`). A deployed account retires its maintenance authority, so it cannot take new keys: such an upgrade is new code, new keys and a new account version.

## 16. Migration from the earlier `evm_eip712` arm

**Key-text selector migration.** The `EvmK256Payload` member/client string `ed25519_base58` is renamed to `ed25519`, at the same enum index. `EvmK256Kind` gains `key_text`; its client interface gains optional `keyText`. Callers comparing the old payload string must use `ed25519`. `ed25519Base58Text` remains available and byte-identical; `ed25519DisplayText` accepts all three forms. Existing five-kind approvals, descriptor identities and derivations do not change. The selector does change the ZKIR of `add_device_with_evm_k256`, `remove_device_with_evm_k256`, `issue_grant_with_evm_k256` and `revoke_grant_with_evm_k256`, so those four require new proving/verifier keys for a new account version. The pure key-text probe is only a test export. See `EVM-K256-MEASUREMENTS.md` for mock-compile rows/k; the selector confirmation does not measure keyed sizes or proving times.

This arm replaces the `evm_eip712` arm of earlier builds of this branch. Every change below is breaking, and there are no compatibility aliases.

**The signed bytes.** The EIP-712 domain changed, so every approval's digest changed:

| | `evm_eip712` (earlier) | `evm_k256` (now) |
|---|---|---|
| `name` | `"Midnight Passport Account"` | `"Midnight Passport"` |
| `version` | `"1"` | `"1"` |
| `verifyingContract` | the low 20 bytes of `keccak256(account address)`, one per account | the fixed `P = 0x596e089eF2D7308208B9e8f7e1A147942a84104F` (section 3) |
| domain separator | one per account, computed in each circuit from a checked hint of the account's hash | the constant `c199a56c83cc5d0377e7f261c33491d1ee5fa301de75f83dfb8bc32a21e08ad8` |

The 32 type strings, every struct's members and their encoding are unchanged (the frozen vectors' type strings are equal), and so are the blind requests (`personal_sign`), the blinds, the tags and the device entries. An approval signed for the earlier arm does not verify under this one, and the reverse: a wallet signs again, under the new domain.

**The circuits and the keys.** The 16 entry circuits are renamed `*_with_evm_eip712` → `*_with_evm_k256`, and every one of them has a new ZKIR and new keys: `activate_initial_device`, `add_device`, `append_inbox`, `issue_grant`, `publish_recovery_session`, `recover_cancel`, `remove_device`, `revoke_all_grants`, `revoke_grant`, `rotate_enc_key`, `withdraw_shielded`, `withdraw_shielded_to_contract`, `withdraw_shielded_to_contract_with_grant`, `withdraw_shielded_with_grant`, `withdraw_unshielded` and `withdraw_unshielded_with_grant` (each `…_with_evm_k256`, or `…_with_grant_evm_k256`). The account's other 52 circuits keep their keys. Their device seams no longer take the account-hash hint (`EvmK256SeamHint` and `EvmK256GrantSeamHint` have no `account_hash` member). An account deployed with the earlier circuits keeps their verifier keys, and the wave deploy retires the maintenance authority, so such an account cannot take the new keys: its owner moves to an account deployed with these circuits. The probe contracts (`probe-wallet-arms-base`, the new `probe-k256-core`) are test contracts, never deployed by an account.

**The names.** Every name containing the arm's old name follows one case-preserving rule: `evm_eip712` → `evm_k256`, `EVM_EIP712` → `EVM_K256`, `EvmEip712` → `EvmK256`, `evmEip712` → `evmK256`, `evm-eip712` → `evm-k256`, `EVM-EIP712` → `EVM-K256`. That covers the circuits, the pure helpers, the tag functions (`device_tag_evm_k256`, …; the tag strings are unchanged), the structs, the TypeScript names, the files (`account-evm-k256.compact`, `modules/EvmK256.compact`, `src/wallet/signer-evm-k256.ts`, `evm-k256-codec.ts`, `evm-k256-hints.ts`, the tests, `EVM-K256.md`, `EVM-K256-MEASUREMENTS.md`, `evidence/evm-k256/`), the npm scripts (`test:evm_k256-offline`, `test:evm_k256`) and the environment variables (`EVM_K256_DRY`, `EVM_K256_GRANT_TWINS`). Moved or renamed otherwise:

| Earlier | Now |
|---|---|
| `evm_eip712_address`, `evm_eip712_low20`, `evm_eip712_bytes_of`, `evm_eip712_reversed`, the struct `EvmEip712KeyHint` | `evm_address`, `evm_low20`, `evm_bytes_of`, `evm_reversed`, `EvmAddressHint` (`modules/EvmIdentity.compact`) |
| the arm's ECDSA verification and its key check | `k256_ecdsa_verify` and `k256_require_live_key` (`modules/K256Core.compact`) |
| `evm_eip712_device_scheme`, `evm_eip712_grantee_scheme` (a `Uint<8>`) | `evm_k256_device_kind`, `evm_k256_grantee_kind` (an `EvmK256Kind`), with the table `evm_k256_kinds()` |
| `evm_eip712_sol_device_target`, `evm_eip712_sol_grantee_target` | `evm_k256_ed25519_device_target`, `evm_k256_ed25519_grantee_target` |
| `encode_public_key_with_sol_ed25519` | `encode_public_key_ed25519`, and `compute_public_key_ed25519` (`modules/Ed25519Core.compact`) |
| `solArgs`, `solKeyOf`, `EVM_EIP712_SOL_FILLER_ARGS`, `EvmEip712SolArgs`, `solanaKeyText` | `ed25519Args`, `ed25519KeyOf`, `EVM_K256_ED25519_FILLER_ARGS`, `EvmK256Ed25519Args`, `ed25519Base58Text` |
| `evm_eip712_verifying_contract(account, account_hash)`, `evm_eip712_domain_separator(account, account_hash)`, `evm_eip712_digest(account, struct_hash, account_hash)` | `eip712_v1_verifying_contract()`, `eip712_v1_domain_separator()`, `eip712_v1_digest(struct_hash)` (`modules/Eip712V1.compact`, no account argument) |
| `evmEip712Domain(account)`, `verifyingContract(account)`, `EVM_EIP712_DOMAIN_NAME`, `EVM_EIP712_DOMAIN_VERSION` | `eip712V1Domain()`, the constant `EIP712_V1_VERIFYING_CONTRACT`, `EIP712_V1_DOMAIN_NAME`, `EIP712_V1_DOMAIN_VERSION` |
| `accountHashHint` | removed (a fixed domain needs no account hash) |
| `evmEip712SeamHint(pk, account, digest, authNonce)`, `evmEip712GrantSeamHint(pk, account, digest, label, issuedAt, grantNonce)` | `evmK256SeamHint(pk, digest, authNonce)`, `evmK256GrantSeamHint(pk, digest, label, issuedAt, grantNonce)`: no `account` argument, and the hint structs no `account_hash` member |
| `resolveEvmEip712Counter(account, device, limit)`, `EVM_EIP712_COUNTER_SCAN` | `resolveEvmK256Counter(account, device, { counter, signal })`, with no ceiling (section 9, "Use counters"; the options are `EvmK256CounterOptions`) |
| the call helpers (`rotateEncKeyWithEvmEip712`, …, `recoverCancelWithEvmEip712`) | the same under the new names, each with a trailing `{ counter, signal }`; a `counter` that is not a `Uint<64>` is refused before the ledger is read, and an aborted `signal` stops the scan |
| `restoreEvmDevices(wallet, network, accounts, { maxIndex, maxCounter })`, accounts `{ address, epoch, isMember }` | `restoreEvmDevices(wallet, network, accounts, { maxIndex, signal })`, accounts `{ address, epoch, authNonce, isMember }`; `evmK256DeviceFinds(account, { signal })` is new |
| `new EvmEip712Grantee(pk, blind, label, slot, wallet?, readSeed?)` | `new EvmK256Grantee(pk, blind, label, slot, wallet?, readSeed?, issuer?)`: `issuer` (`{ network, issuingAccount }`) lets a grantee restored from its cache derive its read seed again (section 14) |
| `EvmEip712RosterRecord { scheme, network, accountIndex, address, pk, blind }` | `EvmK256RosterRecord { scheme, format, network, accountIndex, address, pk, blind? }`, and the new `EvmK256GranteeRecord` |
| `EvmWallet { address, personalSign, signTypedData }` | the same, with the optional `otherAddresses()` (the addresses other connected wallets report, for the signer check's refusal) |

**The client's records and calls.** None of the calls above that was synchronous became asynchronous. A roster record now names the format and caches the blind: `{ scheme: 'evm_k256', format: 'eip712-v1', network, accountIndex, address, pk, blind? }`. A stored `evm_eip712` record (no format) is refused; it migrates by setting `scheme` to `evm_k256` and adding `format: 'eip712-v1'` (its blind, address and point are unchanged). Grantee records are new (`EvmK256GranteeRecord`) and never hold a read seed. Calls are dispatched through the client's arm registry (`ARM_REGISTRY`), every returned signature passes the signer check (section 15), a restore follows section 2 (a record without its cached blind needs the caller's test, `finds`), and `restoreEvmDevices` takes each account's `auth_nonce` instead of a counter limit.
