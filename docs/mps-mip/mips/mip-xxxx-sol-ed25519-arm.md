<!--
Licensed under the Apache License, Version 2.0 (the "License"); you may
not use this file except in compliance with the License. You may obtain
a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
-->

# Readable Ed25519 arm (`sol_ed25519`)

This document records an EdDSA construction, specified as a delta
to [MIP-0030](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0030-ecdsa-account-authorisation.md)
(ECDSA Authorisation for Custody Accounts): a Solana wallet (one that
signs raw bytes with `signMessage`, or the Solana off-chain message v1,
with RFC 8032 PureEdDSA over edwards25519) as a device or a grantee. Its signing bytes and key
binding depart from MIP-0030 section 2 as stated here. Byte contract, frozen
vectors and acceptance policy:
[SOL-ED25519](../../../contract/SOL-ED25519.md); costs:
[SOL-ED25519-MEASUREMENTS](../../../contract/SOL-ED25519-MEASUREMENTS.md).

**Conformance delta.** Device routes keep the state invariants of
MIP-0030 section 1 (active-epoch membership, single-use entry rolling,
account-nonce advancement, last-device protection, atomic abort) in
the r1 order: membership, verification, roll, nonce. Grantee routes
follow the [scoped-grants companion](mip-xxxx-scoped-grants.md): the
grant record's `issued_at` and nonce, never the device `auth_nonce`.

**Signing bytes: no challenge hash.** MIP-0030 section 2's challenge `c` is
replaced by one readable message per operation and role (12 device,
3 grantee; activation signs nothing): printable ASCII with LF line
breaks, a circuit-fixed first line `Midnight Passport approval (sol
v1)`, the operation, the site's label (marked as the site's), the role,
the account, the signer's key, then every operand and every consumed
witness value in full, circuit-fixed consequence lines on
authority-granting operations, and the freshness state (`auth_nonce`,
or the grant's label, slot, issue nonce and use nonce). The circuit
renders the message itself from the executed values (the seam renders
the account, the key and the freshness state) and verifies the
signature over the signing format's 50-byte head followed by it, with
the standard library's Ed25519 algorithm, plus an explicit `R != O`. Bytes are shown as
lowercase hex in full; numbers as left-aligned decimal digits in
full; every Solana key (the signer's, and a Solana target or grantee)
as its base58 text, as Solana wallets show it, padded to 44 bytes; a
grant's expiry in seconds and, on the next line, as a UTC date and
time (`yyyy-mm-dd hh:mm:ss UTC`, years 1970 to 9999, the exact words
`after 9999-12-31 23:59:59 UTC` above them); a grant expiry of 0 as
`never`, a zero rate-limit window as `no window`, and on `issue_grant`
the all-zero RP hash as `not applicable`. Every RP hash shown has an
effect: a passkey target's is never zero, and on `issue_grant` the
hash is non-zero exactly for a grant to a passkey whose scope can
spend (a read-only grant carries zero); a grant to any recipient
carries no recipient (a non-zero one is refused). Digits, hex
nibbles, base58 digits with their read-back hints, a date's text with
its year split, and label characters are display inputs the circuit
checks against the values, so exactly one input is valid for each
value.
Consumed private values that ledger state already pins are verified
against state rather than shown. A grant's scope salt is neither shown
nor chosen: `issue_grant` derives it in-circuit (see Grant scope salt
below). The other key of `add_device`,
`remove_device`, `issue_grant` and `revoke_grant` is a readable
descriptor (scheme tag text and key payload) from which the circuit
derives that scheme's entry or grant ID with the scheme's own recipe;
an unregistered tag is refused; a Solana target is taken as its point
with its 32-byte encoding, which the circuit checks against the point
and shows in base58, refusing the identity.

**Signing formats.** A wallet signs `head || text`, with one of two
50-byte heads: raw, the ASCII line `Midnight Passport, Solana
signMessage format (v1)` and a line feed (what `signMessage` signs);
or the off-chain message v1, `ff || "solana offchain" || 01 (version)
|| 01 (signer count) || key` (what hardware wallets and a wallet's
own off-chain signing sign), whose one signer is the key the seam
checked against the point the signature is verified under. A private
flag selects the head; it is never disclosed (no public instruction
of any circuit depends on it, and both formats leave the same public
transcript), so one circuit and one verifier key serve both formats
and the chain does not learn which kind of wallet signed. A signature
made in one format verifies only in that format. Every raw message
starts with `Midn`, which as a legacy Solana transaction message
claims 110 account keys: every raw message is shorter than the
resulting parse bound (3,557 bytes; the longest is 1,740), none is a
versioned or off-chain message, and none carries the Sign-In With
Solana statement. Every off-chain message is an off-chain message v1
by design, and no transaction or message.

**Formats by wallet.** Clients MUST NOT ask a wallet for a format it
cannot sign: Phantom signs raw only (it refuses an off-chain message);
Ledger and Trezor sign the off-chain message only (their Solana apps
refuse raw bytes); Backpack and Solflare sign raw, and the off-chain
message through their own wallet-standard `solana:signOffchainMessage`
when they advertise it with message version 1, which clients SHOULD
use instead of handing them the envelope's bytes (shown as garbled
characters). A wallet-standard account lists the features it supports
(`WalletAccount.features`, a subset of the wallet's); clients MUST use
only the wallet's features that the connected account lists, and treat
an account without that list as supporting none. Clients MUST verify every signature a wallet returns
against the expected key, over exactly the bytes the wallet was asked
to sign, before proving: a wallet may answer with another key than the
one it reports. A refusal names another key only when the signature
verifies under it. A wallet setting that signs messages unseen
(auto-approve) signs Passport approvals unseen; clients cannot detect
it, and users must keep it off.

**The four labelled values.** Exactly four hash-like values may
appear, each under a fixed label, none granting authority: a
k1/jubjub grantee's `origin_hash` (`Grantee site label (hash)`); a
passkey's RP ID hash (`Passkey RP (hash)`; the RP ID may be a
registrable parent of the origin host); a target's or grantee's blind
(`Device privacy salt`, `Grantee privacy salt`); and the literal entry
of a revocation-only `remove_device` (`Device entry`, under "Removes a
device this wallet cannot identify"). Enumerated values (the recipient
kind, the k1 envelope, the operation flags) are shown as circuit-fixed
words selected by the value.

**Commitments and tags.** With `H` SHA-256, `A` the account, `key`
the 32-byte RFC 8032 encoding of the device's point and `blind` per
Blinding below:

```text
sol_boot   = H(pad(32, "midnight:account:boot:sol:v1") || salt || key || blind)
sol_device = H(pad(32, "midnight:account:device:sol:v1") || A || key || blind || epoch || counter)
sol_grant  = H(pad(32, "midnight:account:grant:id:sol:v1") || A || key || blind || origin_hash || slot)
blind      = H(pad(32, "midnight:account:blind:sol:v1") || R || S)
sol_salt   = H(pad(32, "midnight:account:salt:sol:v1") || blind || A || auth_nonce)
```

`epoch` is LE4, `counter` LE8, `slot` one byte, `auth_nonce` LE8; in
`sol_salt`, `blind` is the issuing device's. These tags follow the
existing zero-padded colon-version convention and so share the
MIP-0021 conflict noted in MIP-0030's Backwards Compatibility
Assessment.

**Key and scalar admissibility.** The key and `R` are taken as
`Curve25519Point` inputs, whose assignment lands every point in the
prime-order subgroup; the identity key is refused (`A != O`) on every
derivation and by the verification, and `R = O` is refused by an
explicit assert, which the library does not make. `s` is a
`Curve25519Scalar`, so an `S + L` twin is the same input. Verification
is cofactorless. The key's 32-byte encoding is an input, accepted only
when it equals the point's canonical coordinate bytes (a canonical
decomposition), so a point has exactly one key; that key is checked
once and is both the bound identity and the key hashed by the
verification. `R`'s encoding in the
hash is the signature's own first 32 bytes, each an 8-bit
range-checked input, compared with `R`'s canonical coordinate bytes
(bit 255 with the parity of x), so it is `R`'s canonical encoding.
Non-canonical limb encodings of a coordinate are refused by the honest
toolchain's input decoding. A `Field` shown as
32 bytes (recovery material) has exactly one rendering: the lowering's
bit decomposition is canonical. Clients decode keys and signatures
strictly (RFC 8032 canonical encodings, torsion-free `A` and `R`) and
pre-check every signature over exactly the bytes of the device's
format, the head and the text the circuit renders.

**Wallet-key grantees.** A grantee key is a wallet key reused across
sites, not a key bound to one origin. Its `Grant label` is a label the
issuer chose and the grantee's wallet shows, not an authenticated
origin. The compensation is readable per-call consent: every grantee
call shows its amount, recipient, coin and grant frame.

**Grant scope salt.** `issue_grant` takes no salt argument: it derives
the grant's scope salt as `sol_salt` above, from the issuing device's
blind (bound by the device entry the seam checks), the account and the
`auth_nonce` the device signed. The shared chip hashes the salt into
the grant's object, spent, RP and caller commitments, so no proof
builder can make them public with a known salt, link two grants with
a reused one, or leave the grantee without the one it needs; each
issuance has its own. The issuing client computes the same value and
hands it to the grantee off chain, which opens the commitments with it
when it spends. This departs from upstream's arms, which bind a
caller-chosen salt in the signed challenge through `scope_digest`: the
readable messages carry no digest, and a salt the wallet showed could
not be judged by eye. The grantee's read key, which the ledger stores
only as `read_pk_hash` in the clear, is derived fresh per account and
grant by the grantee's client, so no two grants share it.

**Network.** The contract binds no network, and circuits cannot read
the network ID; no message names a network. Because the ledger derives
a contract address from its deploy alone, a replayed deploy on another
network yields an account at the same address, and an approval
verifies there whenever that clone reaches the state it was signed
against. No in-contract value can tell the clone apart. Clients MUST
use random deploy nonces; binding the network ID belongs to the
ledger, where it is proposed.

**Blinding.** Device entries, boot commitments and grant IDs are
blinded with a per-account secret: the blind above, taken over the raw
64-byte signature of a deterministic signer on a readable request
naming Midnight Passport, the network, the wallet's key and an account
index, and warning that it reveals the account's privacy key, signed
in a format of the wallet: raw, the request's bytes unchanged; or the
off-chain message v1 head naming the key, then the same bytes. Its
first line differs from every authorisation's, and no circuit accepts
it. Clients MUST sign it twice and refuse a wallet whose two
signatures differ. The ledger then holds no value a known key can be
tested against; whoever obtains the signature learns the blind (a
privacy loss, not an authority). A grantee's blind, which the issuer
must know, comes from a separate request naming the role and the
issuing account (no account index), so an issuer never learns a device
blind and each issuer gets its own.

**A device is bound to its format.** One key gives one blind per
format, so a device is usable only with the blind of the format it was
enrolled in; its identity (the key and the arm's tag) does not depend
on the format. Clients MUST store per device its arm, format and
account index, and SHOULD cache the blind with them in local storage,
never sending it. On restore a client uses the cached blind, else
derives it in the stored format and uses it only if it finds the
account's entry (a wallet whose Ed25519 nonce is not derived as RFC 8032
specifies signs the request differently and derives another blind),
else, with no record, in every format the wallet can sign; it never
derives a blind in another format than the stored one. A device enrolled through a raw-only wallet cannot be
re-derived from an off-chain-only wallet of the same key: the client
says so (naming the format needed, or, without a record, that no
account was found in the wallet's formats and that the device may have
been enrolled through another one), and the remedy is a new device,
added from another device of the account or through its recovery.

**Upgrades.** Adding an enrolment kind or a readable arm is additive
in source (new entries and new files), but it changes the ZKIR and
verifier keys of the readable arms' enrolment and grant circuits. A
deployed account has retired its maintenance authority and cannot take
new keys, so such an upgrade is new code, new keys and a new account
version.

**Use counters.** Every enrolment by a circuit inserts counter 0 and
every successful device-gated call advances the caller's counter and
`auth_nonce` by one each, so a live entry enrolled at counter 0 has a
counter no greater than `auth_nonce`. Clients MUST find a device's
counter without a fixed ceiling: the last counter they confirmed
first, then forward from it (never past 2^64 − 1), then every counter
up to `auth_nonce`; a counter a caller gives must be a `Uint<64>`, and
a long scan should run in bounded chunks that yield and can be
cancelled.
An entry enrolled through an entry-taking `add_device` at a counter
above `auth_nonce` is reached only when its counter is given.

**Changes from earlier drafts.** An approval was the text alone,
signed with `signMessage`; it is now the 50-byte head followed by the
same text, so every raw approval's bytes changed, while the texts and
the raw blind requests (and so the blinds and entries) did not. The
off-chain message v1 format is new. 15 of the arm's 16 circuits have
new verifier keys (the activation keeps its own), and the account's
other circuits keep theirs. The Ed25519 key encoder and seed
derivation moved to the shared Ed25519 core
(`encode_public_key_ed25519`, `compute_public_key_ed25519`). The
client's API changed with them: a device takes a `signer` (no longer a
signing function), every signer lists the `formats` it signs, a device
made from a signer and an enrolled grantee take an optional format, the
grantee blind derivation returns a record (with the format beside the
blind), records name their format, the raw-message check takes the
complete signed message (the raw head, then the text) where it took the
text alone, and the counter resolution takes a known counter and an
abort signal. The full list is in
[SOL-ED25519](../../../contract/SOL-ED25519.md), section 12.

**What is public.** Every call publishes which arm and role it uses
(the circuit name), and the ledger holds only blinded device entries
and grant IDs, salted commitments and upstream's own fields: unshielded
amounts, recipients and balances, the inbox ciphertexts and the
encryption key, the scope fields upstream stores in the clear (the
operation flags, caps, expiry, window and `read`), `read_pk_hash`, the
recovery material, `auth_nonce`, the epoch, the generation and the
round, and a shielded spend's change bit. Inherited from upstream and
the standard library: a permissionless deposit changes the shared
`round`, so a prepared call must be proved again (its approval stays
valid); whoever knows a spent coin can follow a `sendShielded` spend,
because its output nonces derive from the input coin's; a hosted or
delegated proof server sees the key, the blind, the signature and the
signing format, so clients SHOULD prove locally; a read key reused across grants would
link them through `read_pk_hash`; one device's rolling entries form a
public chain of its activity within the account; `jubjub`, `k256` and
passkey targets and grantees use upstream's unblinded recipes, so
whoever knows such a key can test it; and a to-contract spend may name
the account itself (no coin is stranded, but no inbox entry is written
and a grantee's cap is consumed).

**Provenance residual.** Showing a key in full does not prove whose
it is. Approving an attacker-supplied key or recovery material grants
what the consequence line states. Mitigations: circuit-fixed
consequence lines, the new device's client rendering the identical
descriptor for comparison (MIP-0013 S7), and recovery material from
the client's own guardian ceremony. An EVM address, a passkey origin
and a Solana key (shown in base58, as its wallet shows it) can be
compared by eye; k1, jubjub and passkey public keys are shown only.

## Copyright Waiver

This document is licensed under the Apache License, Version 2.0, and
its authors have signed the Midnight Foundation Contributor License
Agreement. Portions of this document were drafted with the assistance
of a large language model; the named authors reviewed and are
accountable for its entire content.
