# The `evm_eip712` authorisation arm

**Byte contract AUTH-EIP712-PASSPORT-EVM-V1.** All 16 circuits are in place and registered in `ARMS`; the measurement report is [EVM-EIP712-MEASUREMENTS.md](EVM-EIP712-MEASUREMENTS.md), the evidence is under [evidence/evm-eip712/](evidence/evm-eip712/).

An ordinary Ethereum account, for example MetaMask, acts as a Passport device or as a grantee. It authorises every operation by signing EIP-712 typed data. In that typed data, every operand and every consumed witness value is a member, shown by the wallet in full and recomputed by the circuit from exactly the values it executes. Nothing opaque is signed: there is no challenge hash and no fingerprint. Four labelled values are the only exception (section 6). The wallet needs no ETH and sends no Ethereum transaction.

| | |
|---|---|
| Circuits | `contracts/account-evm-eip712.compact` (the arm), `contracts/modules/EvmEip712.compact` (the codec) |
| Client | `src/wallet/signer-evm-eip712.ts` (wallet, device, blind, roster), `src/wallet/evm-eip712-codec.ts` (typed data) |
| Frozen vectors | `src/tests/vectors/evm-eip712-v1.json`: 64 positive and 25 negative vectors, hashes computed by viem 2.45.1 |
| Tests | `src/tests/evm-eip712-offline.ts`, `src/tests/evm-eip712-grants-offline.ts`, `src/tests/evm-eip712-recovery-sim.ts`, `src/tests/evm-eip712-seam-offline.ts` and `src/tests/evm-eip712-hints-offline.ts` (all: `npm run test:evm_eip712-offline`), `src/tests/evm-eip712-viem.ts` (needs viem, see section 8), `src/tests/evm-eip712-prover.ts` (constraint-level negatives: `npm run test:evm_eip712`) |

## 1. Identity

The device is its 20-byte Ethereum address, `keccak256(x_be ‖ y_be)[12..32]` of its key (`evm_eip712_address`, section 9), **blinded**. Every recipe below is SHA-256 (`persistentHash`) over the plain concatenation. `A` is the account's 32-byte contract address, and `le4`/`le8` are little-endian `Uint<32>`/`Uint<64>`:

```
entry    = H(pad32("midnight:account:device:evm:v1")   ‖ A    ‖ address(20) ‖ blind(32) ‖ le4(epoch) ‖ le8(counter))
boot     = H(pad32("midnight:account:boot:evm:v1")     ‖ salt ‖ address(20) ‖ blind(32))
grant id = H(pad32("midnight:account:grant:id:evm:v1") ‖ A    ‖ address(20) ‖ blind(32) ‖ origin_hash(32) ‖ slot(1))
```

These are width class 52 of the shared descriptor module (`modules/WalletArmDescriptors.compact`). Every readable arm derives an `evm_eip712` target's entry with the same recipe.

A grant this arm issues hides its commitments under a **scope salt** that `issue_grant_with_evm_eip712` derives itself, with the shared module's `derive_grant_scope_salt`. Its inputs are the issuing device's blind (the one its entry binds), the account, and the `auth_nonce` the device signs, read before the seam advances it:

```
scope salt = H(pad32("midnight:account:salt:evm:v1") ‖ blind(32) ‖ A ‖ le8(auth_nonce))
```

The call takes no salt argument, so no one who builds the proof chooses it, and each issuance gets its own. The client computes the same value (`evmEip712GrantScopeSalt`), and `issueGrantWithEvmEip712` returns it for the grantee, whose calls open the commitments under it. The grant record keeps `issued_at`, the `auth_nonce` after the seam advanced it, so the issuing device can recompute the salt of each grant it issued from the record (`issued_at − 1`); no one without that device's blind can.

Every path that admits a key takes the secp256k1 **point** and derives the address itself. Before that, it refuses the point at infinity by its coordinates, which catches both encodings. A caller can never present an address without a key.

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

- The client asks for the signature **twice** and refuses the wallet if the two canonical forms differ. Such a wallet is non-deterministic (MPC, hedged nonces), so its blind could never be derived again.
- The client recovers the device's public point from the same signature and checks that it hashes to the wallet's address.
- The `personal_sign` hash preimage begins `0x19 0x45` (`0x19` and `'E'` of `"Ethereum Signed Message:\n"`), and every authorisation's hash preimage begins `0x19 0x01`. The preimages are disjoint, so the two digests coincide only on a keccak256 collision: a blind signature is never an authorisation, and an authorisation is never a blind signature. No circuit consumes a `personal_sign` digest.
- A restored client derives `blind_0 … blind_k` and finds its accounts by testing entries (`restoreEvmDevices`).
- As a **grantee**, the wallet signs a different request: `granteeBlindMessage` names the role ("grantee"), the network, the wallet and the issuing account's 32-byte address, and has no account index. Its first two lines differ from the device request's, so a grantee blind is never a device blind, and it is different for every issuing account (`enrolEvmGranteeBlind`, `EvmEip712Grantee.enrol`).

## 3. Domain

```
EIP712Domain(string name,string version,address verifyingContract)
name               "Midnight Passport Account"
version            "1"
verifyingContract  the low 20 bytes of keccak256(A)
```

There is no `chainId` and no `salt`. The contract holds no network value, and the cross-network clone argument is in section 10. The circuit recomputes the domain separator on every call: it is constant per account, but a cache would need a ledger or constructor field, and the arm adds no state.

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
| `withdraw_unshielded_with_evm_eip712` | `WithdrawUnshielded(bytes32 account,address device,uint64 authNonce,bytes32 color,uint128 amount,string amountLabel,bytes32 recipient)` |
| `withdraw_shielded_with_evm_eip712` | `WithdrawShielded(…frame…,bytes32 color,uint128 amount,string amountLabel,bytes32 recipient,bytes32 coinNonce,uint128 coinValue,uint64 coinMerkleIndex,uint128 change)` |
| `withdraw_shielded_to_contract_with_evm_eip712` | `WithdrawShieldedToContract(…frame…,bytes32 color,uint128 amount,string amountLabel,bytes32 recipientContract,bytes32 coinNonce,uint128 coinValue,uint64 coinMerkleIndex,uint128 change)` |
| `append_inbox_with_evm_eip712` | `AppendInbox(…frame…,bytes entry)` |
| `rotate_enc_key_with_evm_eip712` | `RotateEncKey(…frame…,string effect,bytes32 newKey)` |
| `add_device_with_evm_eip712` | `AddDevice(…frame…,string effect,<Scheme>Device newDevice)` |
| `remove_device_with_evm_eip712` (descriptor) | `RemoveDevice(…frame…,<Scheme>Device target,uint32 targetEpoch,uint64 targetCounter)` |
| `remove_device_with_evm_eip712` (literal entry) | `RemoveUnknownDevice(…frame…,string effect,bytes32 entry)` |
| `issue_grant_with_evm_eip712` | `IssueGrant(…frame…,string effect,<Scheme>Grantee grantee,bool withdrawUnshielded,bool withdrawShielded,bool withdrawShieldedToContract,bool read,bytes32 color,string recipientKind,bytes32 recipient,uint128 maxCoinValue,uint128 perCallCap,uint128 cap,uint64 expiresAt,string expiry,bytes32 passkeyRpHash,string passkeyRp,bytes32 readKey,uint64 windowLength,uint128 windowCap,string window,bool callerPinned,bytes32 caller)` |
| `revoke_grant_with_evm_eip712` | `RevokeGrant(…frame…,<Scheme>Grantee grantee)` |
| `revoke_all_grants_with_evm_eip712` | `RevokeAllGrants(…frame…)` |
| `publish_recovery_session_with_evm_eip712` | `PublishRecoverySession(…frame…,string effect,bytes32 recoveryKeyX,bytes32 recoveryKeyY,bytes32 sessionNonce,bytes32 phi1,bytes32 phi2,bytes32 phi3,bytes32 phi4,uint8 phiLength,bytes wrap)` |
| `recover_cancel_with_evm_eip712` | `CancelRecovery(…frame…)` |
| `withdraw_unshielded_with_grant_evm_eip712` | `WithdrawUnshieldedAsGrantee(…grantee frame…,bytes32 color,uint128 amount,string amountLabel,bytes32 recipient)` |
| `withdraw_shielded_with_grant_evm_eip712` | `WithdrawShieldedAsGrantee(…grantee frame…,bytes32 color,uint128 amount,string amountLabel,bytes32 recipient,bytes changeEntry,bytes32 encryptionKey,bytes32 coinNonce,uint128 coinValue,uint64 coinMerkleIndex,uint128 change)` |
| `withdraw_shielded_to_contract_with_grant_evm_eip712` | `WithdrawShieldedToContractAsGrantee(…grantee frame…,bytes32 color,uint128 amount,string amountLabel,bytes32 recipientContract,bytes changeEntry,bytes32 encryptionKey,bytes32 coinNonce,uint128 coinValue,uint64 coinMerkleIndex,uint128 change)` |

Both tables are generated from the codec's type definitions (`EVM_EIP712_PRIMARY_TYPES`, `EVM_EIP712_DESCRIPTOR_TYPES` in `src/wallet/evm-eip712-codec.ts`). The exact `encodeType` strings, 32 of them counting each descriptor scheme, are in the vector file under `typeStrings`, and they equal the codec's.

There is one nested descriptor type per target scheme. The parent's type string names the nested type, so the parent type hash follows the scheme:

| Scheme (tag) | Device type | Grantee type |
|---|---|---|
| `evm_eip712` | `EvmDevice(string scheme,address wallet,bytes32 privacySalt)` | `EvmGrantee(string scheme,address wallet,bytes32 privacySalt,string siteLabel,uint8 slot)` |
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

Ledger-pinned private openings are not shown: the signer's own blind and use counter, `spent_prev`, and the grantee's pinned recipient and maximum coin value. They are checked against state, not chosen. A grant's `scope_salt` is not shown either, and at issuance it is not an input at all: `issue_grant_with_evm_eip712` derives it from the issuing device's blind, the account and the signed `auth_nonce` (section 1). A grantee call takes it as an opening, which the record's commitments check. A shielded spend shows its coin by nonce, value and Merkle index. Its colour is `color`, because the circuit asserts `coin.color == color`. The change is `coinValue − amount`.

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

`src/wallet/evm-eip712-codec.ts` has two parts:

- a general EIP-712 encoder written from the EIP;
- one builder per operation, producing `eth_signTypedData_v4` JSON. The `types` object holds only the primary type, its nested type and `EIP712Domain`, because viem and ethers refuse unused types.

The builders are strict. They range-check every integer, check labels and origins against the circuit's text rules, and refuse an unregistered tag. These are client-layer refusals, before any wallet sees the message. The grant facades also re-check a grantee input built elsewhere with the strict client decoders (`checkEvmEip712GranteeInput`: a registered grant-id tag, points on their curves, a valid Ed25519 encoding), before the account or the wallet is touched. A passkey grantee's site origin, its own field apart from any policy on the key, passes the base's origin rule (21 bytes, visible ASCII, no quote or backslash) in the same places.

## 8. Frozen vectors

`src/tests/vectors/evm-eip712-v1.json` holds:

- **64 positive vectors.** Every primary type is covered, and every descriptor-taking type with all five schemes. The vectors include edge values (`2^128 − 1`, `2^64 − 1`, zeros), expiries at the edges of the date range and of the calendar (1, `2^31 − 1`, `2^31`, 2000-02-29, 2100-03-01, the last second shown as a date and the first shown as the words), Solana keys whose encoding starts with one and two zero bytes, amount labels with 0, 2, 6 and 18 decimals and symbols of 1 to 8 characters (the widest fills the 49 bytes), dynamic members with leading zero bytes and all-zero bytes, and the passkey parent-domain shape. Each vector holds its inputs, its typed data, the `encodeType` string, the domain separator, the struct hash and the digest. **viem's `hashTypedData` computed every hash.**
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

"Runtime" is the generated JavaScript of the contract's pure circuits. In the impure circuits the same asserts are constraints of the proof. Each rule above that an impure circuit reaches has a valid-signature negative refused at the proof server, one representative input per rule, with the admissible call proved through the same patched copy first (`evm-eip712-prover.ts`; the descriptor and label rules are tabled in section 9): the device and grant-id tags, a passkey origin with a space, a site label with two spaces, recipient kind 4, a k256 envelope of 2, the zero RP hash of a passkey, an RP hash where none is checked, and a recipient under "any recipient". An unregistered tag also fails the base's width assert for the class it selects, and those cases name both asserts. An amount above the spent coin is refused at runtime on all four shielded spends; its prover level cannot be reached from a JavaScript-built call (the negative change cannot be encoded), and each case records that reason. The rows of 2^128, 2^64 and a 191-byte entry are refused by the runtime's own type checks before any circuit runs.

Agreement, from `npm run test:evm_eip712-offline`: the contract's pure circuits, the client codec and the frozen values agree on all 64 vectors. To reproduce the frozen values with viem, which is not a dependency:

```sh
VIEM_DIR=<a viem 2.x package root> npx tsx src/tests/evm-eip712-viem.ts
```

That script also checks that `signTypedData` is byte-identical to viem's, and the addresses, points and blind requests.

## 9. The seam and the acceptance policy

`require_authorised_with_evm_eip712<T>(auth, type_hash, tail)` follows upstream `p256`'s order (MIP-0013 §4):

1. the device's address derived from the presented point, `evm_eip712_address(auth.pk, auth.hint.key)` (the point at infinity refused in both encodings);
2. membership of the single-use entry at the active epoch;
3. `r ≠ 0` and `s ≠ 0`;
4. ECDSA verification of `digest(account, struct_hash)` (`evm_eip712_ecdsa_verify`), where the seam builds `struct_hash` itself from the frame and the export's tail;
5. the entry rolled to its successor;
6. `auth_nonce` advanced and `round` bumped.

Any failure aborts the whole call. The authorising argument `EvmEip712Auth { pk, use_counter, blind, sig, hint }` is internal.

**The address and the verification.** `evm_eip712_address` extracts the key's coordinates once: the extraction refuses the flagged point at infinity, and the coordinate guard refuses the unflagged `(0, 0)`, so no comparison with the default point is needed. It hashes the coordinates' big-endian bytes and takes the low 20 bytes of the hash, as Ethereum defines the address. `evm_eip712_ecdsa_verify` is the standard library's `secp256k1EcdsaVerify` with the same arithmetic and semantics (both S forms accepted, the digest read big-endian and reduced mod n, `x(R)` reduced mod n), without its comparison with the default point (the address step has already extracted the same key's coordinates in the same circuit).

**Checked byte hints.** Taking bytes out of a value costs a full field decomposition per byte, so the circuits take a value's bytes as an extra argument instead: a vector of `Uint<8>` that must be exactly the value's bytes in the order Compact stores them (a `Bytes<n>` in order, a number little-endian). Each check rebuilds the value from the vector and compares. Every element is range-checked to 8 bits as a circuit argument, each field element rebuilt holds at most 31 bytes (no wrap-around), and base-256 digits are unique, so only the value's own bytes pass, and the checked vector is the one used. The hints are the key's coordinates and the key hash (the address), the account hash (the domain's `verifyingContract`), the digest (the verification's big-endian scalar), `authNonce` (the device frame), the site label, `issuedAt` and `grantNonce` (the grantee frame), all in `EvmEip712Auth.hint` / `EvmEip712GrantAuth.hint`, and each operation's own (the amounts, the spent coin's value and Merkle index, the change, a descriptor's key, second key, origin and site label, the scope's numbers, a removal's epoch and counter, and the display inputs of the readable texts: the site's amount label, a Solana key's base58 digits and read-back hints, the expiry's date text and year split) as the circuit's trailing `hint` argument; activation takes the key's. A Solana key's encoding and x-coordinate are byte inputs of the same kind, checked by the shared encoder (see "A Solana target" above). The exported pure oracles take the same hints as arguments. The client builds every hint from the values it signs (`src/wallet/evm-eip712-hints.ts`); a wrong hint only fails the call and never changes what is signed or executed. `evm-eip712-hints-offline.ts` refuses a changed byte of every hint and of the Solana key inputs at each place it is checked, and section `hints` of the prover suite refuses one at the proof server, including the carry attack (one byte + 256, the next − 1, which rebuilds the same number): the circuit's 8-bit range check of the byte refuses it. Most of those cases name the digest check beside the hint's, because the forged byte also changes the digest the circuit computes. Section `isolate` refuses each hint check alone: the forged hint is signed as the circuit renders it, so only that check refuses, after the honest call proved through the same patched copy. It covers the digest (a device's and a grantee's signature over an unrelated value passed as the digest hint), `be4` (a removal's `targetEpoch`), `be8` (a device approval and a grantee approval replayed after their nonce advanced, each with the nonce hint of the signed nonce; a removal's `targetCounter`, which compares an argument), `be16` (an amount, a change, a scope cap) and `evm_eip712_bytes_of` (a k256 target's x, a site label, the device key's coordinates under a boot commitment to the address they hash to); `low20` and `visible_21` have such cases in `hints` (a key hash or account hash byte outside the 20 bytes used; a passkey origin byte). Each check's deletion mutant lets its forgeries through ([evidence](evidence/evm-eip712/seam-mutants.json)). The two replays compare the nonce hint with a value the circuit reads from the ledger (`auth_nonce`, the grant record's nonce), so they are recorded as refused through a declared read: an honest prover declares the real nonce and the check fails at the proof server, while against a malicious prover, who declares the old nonce, the node's replay of the transcript against the real state refuses the call (see "Predicates over ledger reads" below).

There are three entry shapes, each one self-contained body: `require_authorised_with_evm_eip712<T>` (one message type), `require_authorised_with_evm_eip712_either<T, U>` (`remove_device`'s two forms: it builds both struct hashes from its own frame and verifies the one the call selects) and `require_authorised_with_evm_eip712_bare` (a type with no members of its own, `RevokeAllGrants` and `CancelRecovery`). Each body derives the address from the presented point, builds the frame from `kernel.self()`, that address and `auth_nonce`, builds the struct hash, checks the entry, verifies the signature and rolls the entry; no circuit that checks or rolls a device entry takes an address, an account, a nonce or a struct hash from its caller, and an export passes only its operation's type hash and fields. The pure builders the bodies share with the exported oracles (the struct hash, the digest, the entry recipe) only compute values. Each body returns the caller's post-roll entry, which `remove_device`'s S13 guard needs. This shape is held by functional tests, not by reading the source: the mutants that would break it (an export skipping the seam; a body framing another account, address or nonce; a grantee twin handing its seam, or rendering, another amount, recipient or colour; the grant frame with a constant nonce) each fail the offline suites (`evidence/evm-eip712/seam-mutants.json`). The offline layer alone (`npm run test:evm_eip712-offline`) also holds every authorisation property (`evm-eip712-seam-offline.ts`): each of the 15 gated exports refuses an approval over another account's frame, another key's signature with the signer's own opening, and zero scalars, and then lands with the honest approval; each shielded spend refuses a held coin of another colour; each grantee twin refuses a recipient other than the pinned one; both shielded grantee twins refuse a coin above the grant's max coin value and a change entry sealed to a key that is not the live one; `remove_device` refuses the device's own entry in both forms; and a grant of the old epoch is refused after a recovery finalisation (`evm-eip712-recovery-sim.ts`). 29 property mutants (every seam call deleted, each zero-scalar assert deleted, the colour asserts deleted, a shielded twin handing its scope the pinned recipient, the grant seam without its epoch check, either shielded twin without `check_shielded_grant_bounds`, `remove_device` handing its self-removal guard a zero entry) are all caught offline (`evidence/evm-eip712/seam-mutants.json`). Without its zero-scalar assert a body still refuses a zero scalar: in the circuit, `s = 0` has no inverse in the ECDSA relation and `r = 0` needs the x-coordinate of `u1·G` to be 0 mod n, which no one can find. So that assert is the explicit, attributable refusal and defence in depth; the generated JavaScript refuses a zero scalar with another message, which is how the offline suites catch its removal.

**The grant seam** (`require_grant_with_evm_eip712<T>`, grantee role) applies the same rule to the grantee frame (`account`, `grantee`, `siteLabel`, `slot`, `issuedAt`, `grantNonce`). It derives the grantee's address from the presented point, then the grant id from that address, the blind, H(origin tag ‖ label) and the slot. It reads `issuedAt` and the nonce from the record, never `auth_nonce`, and touches no device entry. The MIP's steps run in order: the record by id; liveness (active, epoch, generation, expiry); upstream's shared `check_spend_scope` (operation, caller pin, object, per-call cap, spent opening, cumulative cap, recipient pin); `r ≠ 0`, `s ≠ 0`; the signature; the record written back with its nonce advanced and the new spent commitment; `round` bumped. The shielded twins assert `coin.color == color` and run upstream's `check_shielded_grant_bounds` (coin value, live `enc_key`) first.

**The arm's own rules on top of upstream's chips.**

- Every shielded spend asserts `coin.color == color` and `amount ≤ coin.value`.
- `add_device` derives the new entry at the current `device_epoch` and counter 0, so the arm cannot plant a future-epoch entry.
- `remove_device` takes the target's epoch and counter (removal only reduces authority, so a planted `device_epoch + 1` entry can be evicted), or a literal entry under the fixed line "Removes a device this wallet cannot identify". The Maybe that selects the form must be canonical when absent.
- `issue_grant` hashes the read key as zero, and requires it to be zero, when `read` is off, so that nothing is stored that the wallet did not show. It requires a non-zero key when `read` is on. It admits an RP hash only for a passkey grantee whose scope can spend (the rule below), so that no hash-like value that nothing checks ever appears in an approval. It stores SHA-256 of the shown read key as `read_pk_hash`, as the grants MIP defines it.
- A passkey's own RP pin is never zero where it is checked: `add_device` and `remove_device` by descriptor refuse a passkey target with an all-zero RP hash; `issue_grant` requires the RP hash to be non-zero exactly when the grantee is a passkey and the scope can spend (upstream reads the pin only on the passkey spend path, `account-p256.compact`), and zero otherwise. So "not applicable" means exactly "no RP pin is checked". A zero-RP passkey entry planted by an upstream arm's raw `add_device` is removed with the literal-entry form (`RemoveUnknownDevice`), the only form that does not describe the target.
- `issue_grant` refuses a recipient under recipient kind 0, "any recipient": upstream's chip commits the recipient but enforces it only for a pin, so a value shown without effect would otherwise be possible.
- These issue rules sit in `evm_eip712_parts_issue_grant`, the circuit that builds the shown values, so the struct oracle refuses them as well; the client codec refuses every issue rule the circuit reaches before any wallet signs, in the circuit's order and with the circuit's messages: the read key without `read` and `read` without a key, the grantee (a registered tag, a Solana key that is not the identity, the site label, the passkey origin, the k256 envelope), the RP rules, a recipient under "any recipient", the recipient kind, then the shared chip's issue rules. For a passkey device, the origin is checked before the RP hash.

**The seam owns the frame.** An export passes only its operation's type hash and tail, from the module's `evm_eip712_parts_<operation>` circuit. The seam supplies every frame value itself: `account` is `kernel.self()`, `device` is the address of the presented point, and `authNonce` is the ledger's (read before this call advances it). No export can name an account, a device or a nonce, so an entry is matched and a signature verified only for the address of the key that signed. The exported struct-hash oracles `evm_eip712_struct_<operation>` are built from the same frame builders (`evm_eip712_device_struct<T>`, `evm_eip712_grantee_struct<T>`) and the same parts, so an oracle and its export cannot diverge. `keccak256` over a tuple whose last member is a generic tuple hashes that member flat (the contract, the client and the independent implementation agree on every frozen vector). A malicious-prover mutant that forges the derived address in the generated JavaScript (so that the victim's entry matches while the attacker's key signs) is refused at the proof server (`evm-eip712-prover.ts`, section `frame`).

The table below gives the acceptance policy. Each rule's refusing layer was measured with the JavaScript checks bypassed, after a proved positive control (`npm run test:evm_eip712`, `evm-eip712-prover.ts`). The suite runs 366 cases across all 16 circuits: 230 refused at layer `constraint`, 79 at `constraint on a declared read`, 3 decoding refusals, 7 runtime-only (the reason recorded), 38 positives proved, 8 state-only positives and 1 case not applicable (reason recorded). Every patched copy proves the honest call of its circuit through itself: 246 negatives prove it before their own attempt, and 66 share the control proved through the same copy in their section, which the record names for each. A patched copy bypasses only the asserts its case names, so a case that names one assert isolates it. Most cases that name more than one cannot be separated: the tag pairs, a zero scalar with the signature check, the point at infinity, a replayed approval, the last device, the identity as the recovery key, and a second activation (the first activation clears the boot commitment, so a second one fails the boot check as well). Three cases are kept end to end although their asserts can be separated: "caller-pinned grant, no contract caller" on each grantee twin names the caller's presence and the caller match, which the zero-pinned cases and "called by another contract" isolate; the two `remove_device` binding cases ("targetCounter signed 0, executed 1", "the literal entry changed after signing") name the signature check, which the form-swap and fixed-line cases isolate, and the target's membership in upstream's removal chip (`unknown device entry`, the seam's message too), an unchanged upstream assert with no case of its own ([evidence](evidence/evm-eip712/prover-suite.json)). `EVM_EIP712_DRY=1` runs every section at the JavaScript layer alone, with no proof server, so a client change that breaks a section shows before any proof is made.

| Rule | Enforced by | Refused at (simulator / prover) |
|---|---|---|
| The signature covers exactly the executed values (binding: `newKey`, `account`, `device`, `authNonce`, `effect`, the domain's name, version and verifyingContract, the type name, a member name) | the in-circuit digest + `evm_eip712_ecdsa_verify` (the standard library's algorithm over the digest's checked bytes, both S forms) | "invalid signature" / `/check` 400 "Failed direct assertion" |
| The key, blind and counter open a live entry (an unenrolled key, another blind, a wrong counter) | the entry membership assert | "unknown device entry" / `/check` 400 |
| `r ≠ 0`, `s ≠ 0`, and `(r, s) = (0, 0)` | the arm's zero-scalar assert, with the ECDSA relation behind it | the arm's assert / `/check` 400. With `r = 0` or `s = 0` alone, the signature check fails too, and no input separates the two (in the circuit `s = 0` has no inverse, and `r = 0` cannot satisfy the relation), so those cases name both. `(0, 0)` verifies in the generated JavaScript once inverses of 0 are taken as 0, so only the arm's assert fires in the copy; the case is run on each of the three bodies and the grant seam, and at the proof server the relation's inverse refuses `s = 0` as well |
| Both S forms accepted | `evm_eip712_ecdsa_verify` (FIPS 186-5, as the standard library's) | the high-S twin proves and lands. The low-S original is then refused: "unknown device entry" (simulator), `/check` 400 (prover), and node `1010: Invalid Transaction: Custom error 104` for its proof made before the twin landed (three submissions; a fresh call from the same wallet landed in between) |
| The point at infinity (flagged) | ZKIR coordinate extraction; the arm's coordinate guard (defence in depth) | "cannot extract the x-coordinate" / "Cannot extract coordinates of the Secp256k1 identity" |
| The unflagged `(0, 0)` | the runtime validator; the honest proof server's input decoding; in-circuit, the `Secp256k1Point` on-curve assignment (`(0, 0)` is not on the curve) | type error / proof-server input decoding "Failed to decode" (a decoding refusal of an honest prover, not a constraint failure; see the note below) |
| A coordinate not reduced below `p` | the runtime's foreign-field encoder; the honest proof server's input decoding; for soundness, the circuit library's canonical byte cast (below) | type error / proof-server input decoding "The encoded value of type Secp256k1Point is not in canonical form" (not a constraint failure) |
| Replay across accounts, arms (`k256` ↔ `evm_eip712` with the same key), operations (`CancelRecovery`, `RevokeAllGrants`), roles (a grantee type) and nonces | the domain and type hash in the digest; the arm-specific digest rule | "invalid signature" (or "unknown device entry" for a consumed entry) / `/check` 400 |

**Decoding refusals are not constraint refusals.** The last two rows above are refused by the honest toolchain: the runtime's encoder and the proof server's input decoder. A malicious prover builds its own witness and never runs that decoder, so these rows do not show that a constraint refuses the value. Two facts close it. A secp256k1 coordinate `c` has a second 32-byte representation `c + p` only when `c < 2^256 − p ≈ 2^32`, so for any real key the cast to `Bytes<32>` has no alternative output, and forging an address through it would also need a keccak256 preimage; the same bound applies to the `secp256k1PointX` inside the verification. The `(0, 0)` point is refused in-circuit by the on-curve assignment. And the cast itself, the question upstream #182 left open, is constrained canonical in the pinned circuit library: ZKIR 3.1.0-rc.1 lowers a `Secp256k1Base` value to bytes with the base field chip's `assigned_to_le_bytes` (`zkir/src/ir_instructions/to_bytes.rs`), which decomposes it with `assigned_to_le_bits(…, enforce_canonical = true)` and, at the full 256 bits, asserts `is_canonical` on the bits (midnight-circuits 7.2.4, the version ZKIR 3.1.0-rc.1 locks, `src/field/foreign/field_chip.rs`, `assigned_to_le_bits` and `assigned_to_le_bytes`); so even a malicious prover has one byte encoding per coordinate, and the decoding refusals above are the honest toolchain's first line, not the only one.

**Predicates over ledger reads hold through the constraint and the node's replay together.** Many asserts test a value the circuit reads from the ledger or the call context: the entry's membership in `devices`, the grant record (its liveness, caps, commitments and nonce), `enc_key`, `auth_nonce`, the mirror balance, the block time, the caller. Such a read enters the proof as a public transcript value that the prover declares. An honest prover declares the real value, and the assert fails at the proof server. A malicious prover can declare the value the assert needs and prove the call; the node then refuses the transaction, because it re-runs the transcript against the real state. The evidence labels these refusals `constraint on a declared read` (as distinct from `constraint`, a relation over the call's own inputs and witnesses, such as every signature-binding case). The node-side half is shown by the stale-proof run of section 9's table: a proof made against an earlier state was refused by the node (`1010` / 104), and replaying its transcript with the ledger's own `QueryContext.runTranscript` reports `mismatch between expected … and actual … read` for the `auth_nonce` read.

**The grantee path** (`require_grant_with_evm_eip712` and the three twins), measured the same way (`evm-eip712-prover.ts` sections `grants`, `grant-matrix`, `frame-lifecycle`; every case under a valid grantee approval, with the honest call proved through the same patched copy first):

| Rule | Enforced by | Refused at (simulator / prover) |
|---|---|---|
| The approval covers exactly the executed values (amount, recipient, colour; for the shielded twins the change entry, the encryption key and the spent coin's nonce, value and Merkle index) | the in-circuit digest + `evm_eip712_ecdsa_verify` | "invalid grant signature" / `/check` 400, constraint |
| The record is live: active, of the current device epoch and grant generation, not expired | the grant seam's four asserts | "grant revoked", "grant epoch stale" (after a recovery finalisation, which keeps `grants`), "grant expired" / `/check` 400, a declared read. "grant generation stale" is **unreachable** in this contract: `revoke_all_grants` bumps the generation and clears the map, and no chip writes a record of another generation; it is defence in depth for a ledger that keeps records, exercised on a state built by copying the generation cell |
| The operation is in the grant's scope (a grant with the same object fields admitting another operation only) | upstream's shared `check_spend_scope` | "operation not in scope" / `/check` 400, a declared read |
| The caller pin's presence and type asserts, apart from the commitment: a grant pinned to the zero contract address (which equals the default `caller.value.left`) called with no caller, or by a user | upstream's shared `check_spend_scope` (`caller.is_some` and `caller.value.is_left` share one message) | "grant requires a contract caller" / `/check` 400, a declared read (the zero contract presenting itself proves through the same copy). No caller fails both asserts (an absent caller is never left); a user caller fails the type assert alone |
| The scope: per-call cap, cumulative cap, recipient pin, caller pin (no contract caller; another contract), the object opening (one opening member, the max coin value, other than the record's), the spent opening (a spend the record does not hold) | upstream's shared `check_spend_scope` | the chip's messages / `/check` 400, a declared read (the record and the caller are reads), on all three twins |
| A coin above the grant's max coin value; a change sealed to a key other than the live `enc_key` | upstream's shared `check_shielded_grant_bounds` | "coin above max_coin_value", "stale encryption key" / `/check` 400, a declared read |
| The spent coin's colour is the approved colour | the twin's own assert | "held coin colour does not match the withdrawn colour" / `/check` 400, constraint |
| `r ≠ 0`, `s ≠ 0` | the grant seam | the arm's assert / `/check` 400, constraint; `r = 0` or `s = 0` alone with the signature check (as for the device seam), `(0, 0)` alone in the copy, on all three twins |
| The frame's site label follows the label grammar (a grant planted for the grantee under a label with two spaces) | the grant seam's frame (`evm_eip712_site_label_hash`) | "evm_eip712: not a site label" / `/check` 400, constraint, on all three twins |
| The grantee address is derived from the presented point (a forged derivation) | the grant seam | "unknown grant" / `/check` 400 "Public transcript input mismatch" |

**The descriptor and label rules** keep what the wallet shows one-to-one with what the circuit executes. Each is refused at the proof server under a valid signature over what the circuit shows for the executed value (where the codec refuses the value, its message for the admissible value is patched before signing), with the admissible call proved through the same patched copy first (`evm-eip712-prover.ts` sections `devices` and `grants`). On `remove_device` and `revoke_grant` the refused descriptor names an entry or a grant that an upstream k256 device planted raw, so only the descriptor rule refuses.

| Rule | Circuits | Refused at (simulator / prover) |
|---|---|---|
| A registered device tag (an unregistered tag; another recipe's tag) | `add_device` | "evm_eip712: not a registered device tag", with the base's 117-byte class assert, which refuses the same tag / `/check` 400, constraint |
| A registered grant-id tag (an unregistered tag; another recipe's tag) | `issue_grant`, `revoke_grant` | "evm_eip712: not a registered grant-id tag", with the base's 64-byte grant-id assert, which refuses the same tag / `/check` 400, constraint |
| A passkey origin of visible ASCII (one byte a space) | `add_device`, `remove_device`, `issue_grant`, `revoke_grant` | "evm_eip712: the passkey origin is not visible ASCII" / `/check` 400, constraint |
| A site label that follows the grammar (two spaces in a row) | `issue_grant`, `revoke_grant` (the grantee); the three grantee twins (the frame, above) | "evm_eip712: not a site label" / `/check` 400, constraint |
| A k256 envelope with a label (2, shown with the envelope-1 label the circuit selects) | `add_device`, `remove_device`, `issue_grant`, `revoke_grant` | "evm_eip712: not a k256 envelope" / `/check` 400, constraint |
| A recipient kind with a label (4, shown with the kind-3 label the circuit selects) | `issue_grant` | "evm_eip712: not a recipient kind" / `/check` 400, constraint |
| `read` on requires a non-zero read key, and off a zero one | `issue_grant` | "evm_eip712: read without a read key", "evm_eip712: a read key without read" / `/check` 400, constraint |
| A passkey's RP hash is non-zero exactly where its pin is checked; no recipient under "any recipient" | `add_device`, `remove_device`, `issue_grant` | the arm's messages / `/check` 400, constraint |
| A Solana key that is not the identity (`A ≠ O`, the descriptor module's ed25519 class, which `add_device`, `remove_device`, `issue_grant` and `revoke_grant` reach) | `add_device` at the proof server; `issue_grant` at runtime (`evm-eip712-grants-offline.ts`) | "descriptor: the Ed25519 key is the identity" / `/check` 400, constraint (the approval shows the base58 text of the identity's encoding `01 00…00`, the key the circuit derives) |

**The shared display and descriptor checks, through this arm's circuits.** Each assert below belongs to the shared rendering or descriptor module and is refused at the proof server through the circuit named, after the honest call proved through the same patched copy (`evm-eip712-prover.ts`; this table is generated from the record and the site coverage below). Each case breaks only that rule with every other check holding, under a valid signature over what the circuit renders from its display inputs:

| Shared check (module message) | Site | Refused through | Section | A case names it alone |
|---|---|---|---|---|
| "display: not a UTC date and time" | `WalletArmRendering.compact:224` | `issue_grant` | `texts` | yes |
| "display: month out of range" | `WalletArmRendering.compact:225` | `issue_grant` | `texts` | yes |
| "display: day out of range" | `WalletArmRendering.compact:226` | `issue_grant` | `texts` | yes |
| "display: time of day out of range" | `WalletArmRendering.compact:227` | `issue_grant` | `texts` | yes |
| "display: the year split is not canonical" | `WalletArmRendering.compact:228` | `issue_grant` | `places`, `texts` | yes |
| "display: the date and time do not match the value" | `WalletArmRendering.compact:229` | `issue_grant` | `hints`, `texts` | yes |
| "display: not the words for a time after 9999-12-31 23:59:59 UTC" | `WalletArmRendering.compact:230` | `issue_grant` | `texts` | yes |
| "display: not a left-aligned base58 text" | `WalletArmRendering.compact:403` | `add_device` | `texts` | yes |
| "display: the leading base58 ones do not match the leading zero bytes" | `WalletArmRendering.compact:404` | `add_device` | `texts` | yes |
| "display: the base58 carry hints do not split the leading digits" | `WalletArmRendering.compact:405` | `add_device` | `hints`, `texts` | yes |
| "display: the base58 digits do not match the value's low bytes" | `WalletArmRendering.compact:407` | `add_device` | `texts` | yes |
| "display: the base58 digits do not match the value's high bytes" | `WalletArmRendering.compact:409` | `add_device` | `texts` | yes |
| "display: not a site amount label" | `WalletArmRendering.compact:537` | `withdraw_unshielded` | `texts` | yes |
| "display: the symbol does not start with a letter" | `WalletArmRendering.compact:538` | `withdraw_unshielded` | `texts` | yes |
| "display: more than 18 decimals" | `WalletArmRendering.compact:539` | `withdraw_unshielded` | `texts` | yes |
| "display: symbol longer than 8" | `WalletArmRendering.compact:540` | `withdraw_unshielded` | `texts` | yes |
| "display: leading zero in the site amount label" | `WalletArmRendering.compact:541` | `withdraw_unshielded` | `texts` | yes |
| "display: the site amount label does not match the value" | `WalletArmRendering.compact:542` | `withdraw_unshielded` | `hints`, `texts` | yes |
| "descriptor: the Ed25519 key bytes do not match the point's y" | `WalletArmDescriptors.compact:360` | `add_device`, `issue_grant`, `remove_device`, `revoke_grant` | `hints`, `places` | yes |
| "descriptor: the Ed25519 x bytes do not match the point's x" | `WalletArmDescriptors.compact:366` | `add_device`, `issue_grant`, `remove_device`, `revoke_grant` | `hints`, `places` | yes |
| "descriptor: the Ed25519 sign bit is not x's parity" | `WalletArmDescriptors.compact:367` | `add_device`, `issue_grant`, `remove_device`, `revoke_grant` | `places`, `texts` | yes |
| "descriptor: the Ed25519 key is the identity" | `WalletArmDescriptors.compact:389` | `add_device` | `devices` | yes |

**What the constraint-level negatives cover** ([evidence/evm-eip712/assert-coverage.json](evidence/evm-eip712/assert-coverage.json), generated from the run of record). Each assert is a site: its file, its line and the circuit it is written in. A site counts when one of the arm's exported circuits (its own and the pure circuits it re-exports) reaches that circuit by the call graph. A case refuses a site when the site's message is the case's expected refusal, it is refused at layer `constraint` after the honest call proved through the same patched copy, and the circuit under test reaches no other site with that message; where it reaches several (the three word hints `be4`, `be8` and `be16` share one message, the byte hints of `evm_eip712_bytes_of` and the origin's `visible_21` another), the site is the one whose deletion mutant alone lets the case's forgery through. Of the arm's 50 asserts (31 messages, in `contracts/account-evm-eip712.compact` and `contracts/modules/EvmEip712.compact`, all reached), 45 are each refused that way by a case of their own, under a valid signature over what the circuit renders. The seven checked-hint sites among them each have a case where the forged hint is signed as the circuit renders it, so only that check refuses (section `isolate`; for `low20` and `visible_21`, section `hints`): the digest (`account-evm-eip712.compact:218`), `be4` (a removal's `targetEpoch`), `be8` (a replayed device or grantee approval with the nonce hint of its signed nonce; a removal's `targetCounter`), `be16` (an amount, a change, a scope cap), `bytes_of` (a k256 target's shown x, a site label, the device key's coordinates), `low20` and `visible_21`; each check's deletion mutant accepts that forgery. The other 5: "evm_eip712: device key is the point at infinity", named only beside other asserts because no input isolates it (the flagged identity also fails the coordinate extraction, and on a gated call the entry and the signature), and "amount above the spent coin's value" (4 sites, the four shielded circuits), which the runtime's type encoder refuses before any proof request (the change would be negative; in the circuit the assert, the subtraction's range check and the signature over the shown value refuse it); each case records that reason. The base modules (`contracts/modules/WalletArmDescriptors.compact`, `contracts/modules/WalletArmRendering.compact`) have 35 asserts in circuits the arm reaches; 22 are refused the same way (the table above). The three checks of the shared Ed25519 encoder (y, x and x's parity) are each refused alone at every place a Solana key enters: `add_device` and `remove_device` (a target), `issue_grant` and `revoke_grant` (a grantee); a forged y or sign bit is shown in base58 and signed as shown, and where it names another entry or grant, an upstream k256 device planted that entry or grant raw. The year split is refused both when it breaks its equation and when it keeps the equation and breaks a bound (one leap day fewer, so the date one day later reads back to the same seconds, signed as shown). The other 13 are the recipes' tag checks, which cannot fire through the arm: it selects each recipe by its class, which is the tag's equality test, and passes constant tags in its seams and activation, so an unregistered tag is refused by the arm's registered-tag check first (the 117-byte device and 64-byte grant-id classes it falls through to are refused together with it); 2 of them are reached only by a pure export, computed in JavaScript and never proved. The modules' other asserts are in circuits no arm circuit reaches (`decimal_text`, `k256_envelope_text`, `label_text`, `recipient_kind_text`, `visible_text`). The shared modules' own probe suite refuses each tag check at the proof server. The shared chips the arm calls unchanged from upstream are covered by upstream's own tests and by the regression batch, which runs upstream's suites on this account; the arm's wiring into them is covered by the mutant tables (`evidence/evm-eip712/seam-mutants.json`) and by the arm-supplied prover cases (the grant seam's scope, liveness and shielded bounds; the removal of the authorising or the last device; the recovery chips). These chip asserts therefore have no constraint-level case of their own:

- `do_issue_grant`: "grant already active", "empty scope", "read-only grant cannot restrict caller", "shielded spend requires read", "per-call cap above cap", "spend without cap", "coin bound below per-call cap", "window bounds reserved" and "read-only grant carries object fields", each with a runtime negative through `issue_grant_with_evm_eip712` (`evm-eip712-grants-offline.ts`, under an approval that honestly shows the refused call); "read without delegate key" cannot be reached through the arm, which stores SHA-256 of a non-zero read key;
- `do_revoke_grant`: "unknown grant" and "grant not live", each with a runtime negative through `revoke_grant_with_evm_eip712` (`evm-eip712-grants-offline.ts`);
- the device insert (`do_add_device`): "device entry already present";
- the device removal (`do_remove_device`): "unknown device entry" for the target, which fires together with the signature check in the two removal binding cases.

The grant call never reads or advances `auth_nonce` or a device entry. That rests on the source (the grant seam reads `issued_at` and the nonce from the record and writes back only that record and `round`) and on state checks in the simulator and on node; unchanged state alone cannot show that a value was not read, so it is not counted as a constraint-level result.

**Field values are rendered canonically.** `PublishRecoverySession` shows the JubJub recovery key's coordinates and the phi values as 32-byte little-endian words, cast in-circuit from `Field` to `Bytes<32>`. ZKIR 3.1 lowers the cast to `div_mod_power_of_two(val, 248)`, which decomposes the value with `assigned_to_le_bits(val, None, enforce_canonical = true)` over all 255 bits (midnight-circuits 7.2.4: the low bit is tied to `sgn0(val)`, which leaves exactly one bit vector). A value `f` therefore has one rendering, never `f + r`. The prover suite (section `qa-s3`) signs each of the four members over its non-canonical rendering `f + r` and executes `f`: each is refused at the proof server (`/check` 400, layer `constraint`), after the canonical rendering proved through the same patched copy. That includes an unused phi slot, whose value is 0 and whose non-canonical rendering is `r` itself: 0 is the one value whose sign bit admits two witnesses, and the gadget still forces `sgn0(0) = 0`, so both dishonest witnesses are unsatisfiable.

## 10. Network

The domain carries no network value, as upstream's arms carry none: the contract has no network field, and a circuit cannot read the network id (Compact's `Kernel` offers no such read). What binds an approval is the account: the domain's `verifyingContract` is derived from the account's address, the frame names the account, and the device entry is derived from the account address and the blind.

**The clone argument.** The ledger derives a contract's address from its deploy (initial state and nonce) alone, without the network id, and signs maintenance updates over `(address, updates, counter)`. Someone who replays an account's public deploy on another network therefore gets an account at the same address, with the same initial state. Whenever that clone is in the state an approval was signed against (the same device entry and `auth_nonce`), the approval verifies there as well, because nothing in it names the network. No in-contract value can tell the clone apart: a salt sealed into the state at deploy time is copied with the deploy, and the network id cannot be read. So the arm does not claim network separation, and the MIP's "SHOULD bind a network" is replaced by this argument.

**Mitigations.**
- The reference client deploys with a fresh random deploy nonce and a fresh 32-byte boot salt, so an honest account has no twin unless someone deliberately replays its deploy and its history on another network.
- The blind request names the network (section 2), so the same wallet has different blinds, and therefore different entries, on different networks.
- The upstream ledger issue proposing that the network id be bound to the contract address, to the maintenance-update envelope, or be exposed to circuits is drafted (filing pending).

## 11. Measurements

The per-circuit report (k, rows, prover-key size, proving time, verifier-key bytes) is [EVM-EIP712-MEASUREMENTS.md](EVM-EIP712-MEASUREMENTS.md), with its evidence in [evidence/evm-eip712/circuit-sizes.json](evidence/evm-eip712/circuit-sizes.json). Every circuit is at k ≤ 18; the widest is `issue_grant_with_evm_eip712`.

Where the rows go (mock-compile measurements):

- keccak256 costs about 4.2k rows per 136-byte block. A tuple of `Bytes<32>` words hashes at that cost; building one flat `Bytes<N>` from slices costs about 18k rows more per 128 bytes, so every preimage here is a tuple.
- The domain separator costs two keccak256 calls per call: the account's hash (its low 20 bytes, the `verifyingContract`, from a checked hint) and the five-word separator. It cannot be cached: a cache would need a ledger or constructor field, and the arm adds no state.
- The address costs one keccak256 block over the coordinates' bytes plus its checked hints; the standard library's `secp256k1EthereumAddress` costs about 22k rows more in each device circuit (its comparison with the default point, about 12k; its byte reversals and the hash's slice, about 15k). The arm's verification costs about 12.5k rows less than `secp256k1EcdsaVerify` in each circuit (its comparison with the default point, and the digest's byte reversal).
- A checked hint costs about 14 rows per byte as an argument of an impure circuit (its range check and its share of the communications commitment) plus about 8 rows per byte to rebuild the value; extracting the same byte from a value costs about 147.
- A big-endian `uint128` word costs about 0.5k rows and a `uint64` about 0.25k from a checked hint (extracted byte by byte: 4.7k and 2.3k); addresses, booleans and `uint8` words are free as tuple elements.
- Reversing a `Bytes<32>` costs about 0.8k rows from a checked hint of its bytes (the k256 and P-256 descriptor coordinates) and about 4k rows when it comes from a cast inside the circuit. JubJub coordinates and `Field` values are therefore shown little-endian: showing the recovery lines big-endian would add 24,407 rows and move `publish_recovery_session_with_evm_eip712` from k 17 to k 18.
- The blind costs one SHA-256 block (about 1.9k rows) per derived entry or grant id.
- The grant's scope salt costs 3,707 rows in `issue_grant_with_evm_eip712` (the SHA-256 of its 104-byte preimage, two blocks), which stays at k 18 with 189,595 rows.
- The enumerated-member labels cost at most 28 rows.
- The readable texts are checked in-circuit, and each costs rows: a site's amount label about 11.6k in each amount-moving circuit (the shared label check, about 6.1k; its 49 input bytes; the hash of the 70-byte text); a Solana key's base58 text about 6.7k in each descriptor circuit (the shared base58 check, its 47 input bytes, the hash of the 44-byte text); the expiry's UTC date and the window word together about 11.4k in `issue_grant_with_evm_eip712`. They move `add_device_with_evm_eip712`, `revoke_grant_with_evm_eip712` and the two shielded grantee circuits from k 17 to k 18.

## 12. Recovery

Two device-gated circuits use upstream's shared recovery chips through the seam:

- `publish_recovery_session_with_evm_eip712(new_recovery_pk, session_nonce, phi_1, phi_2, phi_3, phi_4, phi_len, wrap, auth)` runs `do_publish_recovery_session`;
- `recover_cancel_with_evm_eip712(auth)` runs `do_recover_cancel`.

The recovery gate (`recover_submit`) and finalisation (`recover_finalise`) have no arm. The gate is opened by the recovery secret and the successor's co-signature, and finalisation is permissionless after the veto window.

**What the session approval shows.** `PublishRecoverySession` carries the fixed line "Sets this account's recovery key". It also carries every operand in full:

- the new recovery key's JubJub coordinates (`recoveryKeyX`, `recoveryKeyY`);
- the four phi values (`phi1`…`phi4`; unused slots are shown as zero);
- the session identifier, `phiLength`, and the 64-byte `wrap` as `bytes`.

Coordinates and phi values are 32 bytes little-endian each, as the contract encodes them. The circuit recomputes the digest from exactly the values it then stores. The test `evm-eip712-recovery-sim.ts` checks that the stored recovery key, session identifier, phi values and wrap equal the shown ones. `CancelRecovery` is the bare frame (`account`, `device`, `authNonce`). Its type hash keeps it apart from `RevokeAllGrants`, which has the same members.

**The shared chip's rules apply as on every arm**, under a valid signature:

- no session while a recovery is pending;
- a phi length of 1 to 4, with unused slots zero;
- a non-zero, fresh session identifier;
- a fresh recovery commitment that is not the identity and not of small order;
- nothing to cancel is refused.

Before the wallet is asked to sign, the client facade (`evmEip712RecoverySession`) refuses a phi count outside 1 to 4, a session identifier that is not 32 non-zero bytes and a wrap that is not 64 bytes. The other rules above (a pending recovery, a reused identifier or commitment, the identity or a small-order recovery key, nothing to cancel) are the circuit's: the shared chip refuses them under a valid signature.

**Finalisation retires every `evm_eip712` device** (upstream #183). `recover_finalise` clears the device set before it installs the successor's entry. Every old entry is gone afterwards, including an `evm_eip712` entry that an upstream arm's raw `add_device` planted at `device_epoch + 1` before the recovery (README erratum 7). That plant equals the planted device's entry at the new epoch and counter 0, so the bump alone would have left it live. After finalisation it is refused together with every other old device: in the simulator, at the proof server (with the generated JavaScript's checks bypassed), and on the shared stack against the finalised account's state (refused before submission by the generated JavaScript). This arm's own `add_device` cannot plant such an entry (section 9).

## 13. Direct transfers

`withdraw_shielded_to_contract_with_evm_eip712` and its grantee twin send a shielded coin to another contract, which must claim it in the same transaction with its own `deposit_shielded` (MIP-0012 §6.6). Two client-side facts govern how such a transaction is built today:

- midnight-js 5.0.0-rc.2 (upstream's pin) refuses to build the sender's call alone: `assertReceivesMatchClaims` requires every contract-addressed output to be claimed inside the same call tree. The arm's tests build it with a test-only copy of the builder that drops that pre-check (`relaxedContractsModule` in `src/tests/evm-eip712-negative.ts`); the node still checks the claim.
- The ledger matches a claimed output to its receive by segment, commitment and recipient. A claim grafted on as another intent is refused (`Custom error: 218`). What lands is both calls in one intent, with the recipient's call moved into the fallible segment when the sender's claim is partitioned fallible (the partitioner splits each call's transcript into guaranteed and fallible halves on its own).

**The effect of a failed fallible half.** The seam's state change (the device entry rolled, `auth_nonce` advanced) and the transfer can sit in different segments. If the transfer's fallible segment fails, the guaranteed segment still applies: the approval is consumed, the fees are paid, and no coin moves. The device must sign a fresh approval (over the new `auth_nonce`) to try again. A client should present a failed direct transfer as "not sent; approve again", never as pending.

## 14. Privacy and provenance

**What the blinding gives.** The ledger holds, for each `evm_eip712` device, only SHA-256 outputs over its address and its blind: the boot commitment, the entries and the grant ids. Without the blind, a known Ethereum address cannot be tested against them. The point, the address, the blind and the signature are private inputs of every proof; the disclosure review of the arm's ten `disclose` sites (the consumed and successor entries of the three device bodies, the grant id, the spent commitment and the two grantee twins' change bits; none in the codec or the base modules) finds no other path, and a needle scan of every transaction and contract state of the arm's localnet runs on the final build (blocks 4,300 to 53,095) found none of them in the clear while finding every control ([evidence/evm-eip712/privacy-review.json](evidence/evm-eip712/privacy-review.json)).

**What every circuit makes public.** The privacy review of the arm's sources ([evidence](evidence/evm-eip712/privacy-review.json)) and of the shared chips they call lists what a call publishes:

- the entry point: the circuit called names the arm and the role (a device call, or a grantee call of an `evm_eip712` grantee);
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
- **Read-key reuse.** `read_pk_hash` is published unsalted, so one read key used for two grants links them, across accounts too, and undoes the grantee blind. This arm's client derives a fresh read key for every account and grant (`EvmEip712Grantee.readKey`): the secret is SHA-256 of a read seed, the account, the site label and the slot, clamped per RFC 7748, and the read seed is SHA-256(pad32("midnight:account:read:evm:v1") ‖ r ‖ s) over the grantee blind request's canonical signature, which the issuer never sees.
- **One device's chain of entries.** A call discloses the entry it consumes and its successor, and the next call of the same device consumes that successor, so one device's calls form a public chain within the account (upstream's rolling entries). The chain shows activity, not the wallet.
- **Unblinded upstream recipes.** `jubjub`, `k256` and passkey devices and grantees enrolled through this arm use upstream's recipes, which have no blind: whoever knows such a key can test whether an account holds it.
- **A to-contract spend to the account itself.** `withdraw_shielded_to_contract` may name the account as its recipient contract. No coin is stranded, but no inbox entry is written, and a grantee's cap is consumed by the call.

**What it does not give.**
- The blind is derived from a signature, so whoever obtains that `personal_sign` signature (for example a phishing page that shows the request) learns the blind and can recognise the account's entries. That is a loss of privacy, not of control: the blind authorises nothing.
- A grantee's blind is shown to the issuer (`EvmGrantee.privacySalt`), who needs it to derive the grant id. The client therefore derives a grantee's blind from its own request (`granteeBlindMessage`: "Midnight Passport grantee privacy key", the role, the network, the wallet and the issuing account's address, no account index), so the issuer never learns a device blind, and every issuer gets a different blind. The issuer can still recognise the grantee's calls on the issuer's own account, which is what a grant is for.
- A non-deterministic signer (MPC, hedged nonces) cannot re-derive its blind; enrolment signs twice and refuses it.

**Provenance.** The wallet shows every key and every piece of recovery material in full, but showing a key does not prove whose it is. A user who approves `AddDevice`, `IssueGrant` or `PublishRecoverySession` with a key or recovery material supplied by an attacker gives the attacker what the circuit-fixed effect line says. The mitigations:
- the effect lines are circuit constants ("Gives this key FULL control of this account", "Lets this key use this account within the limits below", "Sets this account's recovery key", "Sets the key that can read this account's private coin records"), so a page cannot soften them;
- the new device's own client renders the identical descriptor, so the user can compare the two screens (MIP-0013 S7); for an EVM device the address, and for a Solana device its 32-byte key, are forms the user can check against the other wallet by eye (section 6);
- recovery material comes from the client's own guardian ceremony, never from a page (a client obligation).

What remains is documented, not closed: a key the user cannot check by eye (`k256`, `jubjub`, a passkey's public key) is trusted on the strength of the client that shows it.
