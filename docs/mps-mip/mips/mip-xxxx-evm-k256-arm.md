<!--
Licensed under the Apache License, Version 2.0 (the "License"); you may
not use this file except in compliance with the License. You may obtain
a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
-->

# Readable EIP-712 arm (`evm_k256`)

This document records a third ECDSA construction, specified as a
delta to [MIP-0030](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0030-ecdsa-account-authorisation.md)
(ECDSA Authorisation for Custody Accounts): an Ethereum
externally owned account (any EIP-712 wallet) as a device or a
grantee. Its curve is secp256k1, as for k1; its signing bytes and
key binding depart from MIP-0030 section 2 as stated here. Byte contract,
frozen vectors and acceptance policy:
[EVM-K256](../../../contract/EVM-K256.md); costs:
[EVM-K256-MEASUREMENTS](../../../contract/EVM-K256-MEASUREMENTS.md).

**Conformance delta.** Device routes keep the state invariants of
MIP-0030 section 1 (active-epoch membership, single-use entry rolling,
account-nonce advancement, last-device protection, atomic abort) in
the r1 order: membership, verification, roll, nonce. Grantee routes
follow the [scoped-grants companion](mip-xxxx-scoped-grants.md): the
grant record's `issued_at` and nonce, never the device `auth_nonce`.

**Signing bytes: no challenge hash.** MIP-0030 section 2's challenge `c` is
replaced by EIP-712 typed data, one primary type per operation and
role (13 device, 3 grantee). Its members are every operand and every
consumed witness value, in full; the circuit recomputes the struct
hash and verifies ECDSA over
`keccak256(0x19 || 0x01 || domainSeparator || hashStruct(message))`.
The domain is the fixed V1 domain `EIP712Domain(string name,string
version,address verifyingContract)` with name `Midnight Passport`,
version `1`, and `verifyingContract` P, the low 20 bytes of
`keccak256("midnight:passport:evm:v1")`
(`0x596e089eF2D7308208B9e8f7e1A147942a84104F`, at which no contract
is deployed); it has no `chainId` and no salt (see Network below). One
domain serves every account and network, so the domain separator is a
circuit constant (`c199a56c83cc5d0377e7f261c33491d1ee5fa301de75f83dfb8bc32a21e08ad8`;
type hash `91ab3d17e3a50a9d89e63fd30b92be7f5336b03b287bb946787a83a9d62a2766`),
and the account is bound by every type's first member, `bytes32
account`, which the circuit takes from the contract's own address.
Clients MUST refuse to ask a wallet for typed data under any other
domain. Consumed private values that ledger state already pins (the
signer's blind and use counter, the spent opening, a grantee's pinned
recipient and coin bound) are verified against state rather than
shown. A grant's `scope_salt` is not shown either: `issue_grant`
derives it (Commitments and tags below) and takes no salt argument,
and a grantee call opens the record's commitments under it. The other key of `add_device`,
`remove_device`, `issue_grant` and `revoke_grant` is shown as a
readable descriptor (scheme tag text and key payload) from which the
circuit derives that scheme's entry or grant ID with the scheme's own
recipe; an unregistered tag is refused. A Solana key is taken as its
point with its 32-byte encoding, which the circuit checks against the
point (refusing the identity) and shows as its base58 text, the form
Solana wallets show.

**The four labelled values.** Exactly four hash-like values may
appear, each under a fixed member name, none granting authority: a
k1/jubjub grantee's `origin_hash` (`siteLabelHash`; the client shows
the client ID beside it); a passkey's `rpIdHash` (`passkeyRpHash`;
the RP ID may be a registrable parent of the origin host); a target
device's blind (`privacySalt`); and the literal entry of a
revocation-only `remove_device` (`RemoveUnknownDevice.entry`, under
"Removes a device this wallet cannot identify"). Authority-granting
types carry circuit-fixed effect lines, and enumerated members (the
recipient kind, the k1 envelope) are shown as circuit-fixed text
labels selected by the value. A grant shows its expiry as text:
"never" for 0, the UTC date and time (`yyyy-mm-dd hh:mm:ss UTC`)
checked in-circuit against `expiresAt`, or fixed words beyond the year
9999. It also shows two exact words, each one of two circuit-fixed
texts selected by exact equality: its rate-limit window ("no window"
when the window length and cap are both 0, else a pointer to the two
numbers) and its passkey RP ("not applicable" for an all-zero hash,
else a pointer to `passkeyRpHash`). Every amount a call moves is
followed by the site's label for it (`amountLabel`): fixed words
marking it as the site's claim, then the amount with the decimal point
and symbol the site chose, its digits checked in-circuit against the
amount. A passkey's RP hash is never zero where it is
checked (a passkey device target; a passkey grant that can spend) and
zero on every other grant, so "not applicable" means exactly "no RP
pin is checked"; recipient kind 0 ("any
recipient") carries no recipient, so no shown value is without
effect.

**Commitments and tags.** With `H` SHA-256, `A` the account and
`blind` per Blinding below:

```text
evm_boot   = H(pad(32, "midnight:account:boot:evm:v1") || salt || address || blind)
evm_device = H(pad(32, "midnight:account:device:evm:v1") || A || address || blind || epoch || counter)
evm_grant  = H(pad(32, "midnight:account:grant:id:evm:v1") || A || address || blind || origin_hash || slot)
blind      = H(pad(32, "midnight:account:blind:evm:v1") || r || s)
evm_salt   = H(pad(32, "midnight:account:salt:evm:v1") || blind || A || auth_nonce)
```

`address` is the 20-byte Ethereum address of `pk` (the value
`secp256k1EthereumAddress(pk)` gives; the circuit derives it from the
point's checked coordinate bytes); `epoch` is
LE4, `counter` LE8, `slot` one byte. `evm_salt` is a grant's
`scope_salt`, under which the record's spent, object, RP and caller
commitments are salted: `issue_grant` derives it from the issuing
device's blind (the one the seam checks against that device's entry),
the account, and `auth_nonce` (LE8) as the device signed it, before
the seam advances it. No proof builder chooses it, and each issuance
gets its own. The issuing client computes the same value and hands it
to the grantee; the record's `issued_at` is that `auth_nonce` plus one. These tags follow the existing zero-padded colon-version convention and so
share the MIP-0021 conflict noted in MIP-0030's Backwards Compatibility
Assessment.

**Key and scalar admissibility.** Every path derives the address from
the presented point, never from the caller. The point at infinity is
refused in both encodings; `r != 0` and `s != 0` are asserted; both
S forms are accepted, and single-use entries make the twin inert.
Non-canonical coordinate representations are refused by the honest
toolchain's input decoding, and the cast of a coordinate to bytes is
constrained canonical by the circuit library (midnight-circuits 7.2.4,
the base field chip's byte decomposition with `enforce_canonical`), so
a coordinate has one byte encoding even for a malicious prover.
Byte encodings the circuit needs (big-endian words, coordinate and
hash bytes, display texts) are supplied as call arguments and checked:
each byte is range-checked to 8 bits and the value it encodes is
rebuilt and compared, so a supplied encoding adds no trusted input.

**Wallet-key grantees.** A grantee key is a wallet key reused across
sites, not a key bound to one origin. Its `siteLabel` is a label the
issuer chose and the grantee's wallet shows, not an authenticated
origin. The compensation is readable per-call consent: every grantee
call shows its amount, recipient, coin and grant frame.

**Network.** The contract binds no network, and circuits cannot read
the network ID. Because the ledger derives a contract address from
its deploy alone, a replayed deploy on another network yields an
account at the same address, and an approval verifies there whenever
that clone reaches the state it was signed against. No in-contract
value can tell the clone apart. Clients MUST use random deploy
nonces; binding the network ID belongs to the ledger, where it is
proposed.

**Blinding.** Device entries, boot commitments and grant IDs are
blinded with a per-account secret: the blind above, taken over the
low-S `r || s` of a deterministic `personal_sign` signature on a
readable request naming Midnight Passport, the network, the wallet
address and an account index, and warning that it reveals the
account's privacy key. The request's EIP-191 preimage (`0x19 0x45`)
is disjoint from every authorisation's (`0x19 0x01`). Clients MUST
sign it twice and refuse a wallet whose two signatures differ. The
ledger then holds no value a known address can be tested against;
whoever obtains the signature learns the blind (a privacy loss, not
an authority). A grantee's blind, which the issuer must know, comes
from a separate request naming the role and the issuing account (no
account index), so an issuer never learns a device blind and each
issuer gets its own.

**Signing format and the format-bound device.** The arm has one
signing format, `eip712-v1`: approvals are the EIP-712 V1 typed data
above, signed with `eth_signTypedData_v4`; blind requests are signed
with `personal_sign`. Clients MUST NOT ask a wallet for anything else.
A device is bound to the format it was enrolled in: its blind is the
signature over the blind request in that format, so only a wallet
that signs that format with the same key and the same deterministic
nonce rule as the enrolling wallet (RFC 6979, as specified) derives it
again; a deterministic wallet with another nonce rule derives another
blind. Clients store per device its arm, its format, its network and
its account index (none of them secret), and per grant a wallet holds
the issuing account; they MAY cache the blind with that record in
local storage, protected as the wallet's session data, and MUST NOT
send it anywhere. A grantee's read seed MUST NOT be stored: it is kept
in memory for the session and derived again from one signature of the
grantee request, which must give the cached blind again. On restore a client MUST
use the cached blind if present, else derive the blind in the stored
format from a signature by the stored address and use it only if it
finds the account's entry (or the grant ID), else (no record)
derive it in every format the wallet can sign and test it against the
account's entries or the grant ID; it MUST NOT derive a blind in any
other format, and without a match it reports that no account (or
grant) was found in the formats the wallet can sign and that the
device can be enrolled anew from another device or through the
account's recovery (a grantee: a new grant from the issuing account).

**The signer check.** A wallet may answer with another account than
the one asked for (two extensions in one browser, a switched account),
and a wallet-reported address is not a verified signer. Clients MUST
check every signature a wallet returns (approvals and both signatures
of a blind request) before any proof: the address recovered from the
exact digest the wallet was asked to sign must be the expected one,
otherwise the signature is refused. A refusal MAY name another address
only when the signature recovers to it (for example the address
another connected wallet reports); otherwise it says the signer is
unknown.

**Wallet limitations.** With its default settings, the Ledger
Ethereum app (1.22.5) refuses this typed data with status `0x6a80`
and asks for blind signing; clear signing needs Ledger-signed
clear-signing metadata for this domain. A wallet setting that
approves signing requests unseen (an auto-approve period) would sign
approvals unseen; clients cannot detect it, and users MUST keep such
settings off for a wallet used as a device or grantee.

**Ed25519 enrolment text (E3).** Each Ed25519 enrolment kind selects
`base58` (44 space-padded bytes), `prefixed_base58` (the named `ed25519:`
prefix plus those 44 bytes) or `hex` (64 lowercase characters, no `0x`).
This presentation choice is separate from the `ed25519` payload's checked
identity and descriptor derivation. Contract `key_text` is explicit;
client `keyText` defaults to `base58`. Existing `sol_ed25519` approvals keep
their bytes, and no additional kind is registered. All three forms are
included in the descriptor hash path; base58 hints remain checked for
every selection. The payload name changes from `ed25519_base58` to
`ed25519`; the four EVM enrolment circuits need new keys. See the contract's
migration notes and measurements for the API and cost details.

**Extensibility.** A further arm or enrolment kind is added in source
by registry entries (the readable registry's tags and class, the
client's arm registry, one entry of the arm's kinds list), but it
changes the ZKIR, and so the verifier keys, of the existing readable
arms' enrolment and grant circuits. An account that has retired its
maintenance authority cannot take new keys, so such an upgrade is new
code, new keys and a new account version.

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

**Changes from earlier drafts.** The arm was named `evm_eip712`. Its
domain was `{name "Midnight Passport Account", version "1",
verifyingContract the low 20 bytes of keccak256(A)}`, one separator per
account; it is now the fixed V1 domain above, one separator for every
account, so every digest changed, while the types, the members, the
blind requests and the entries did not. Every name containing
`evm_eip712` became `evm_k256`, or a name of the new core, identity
and format modules (circuits, helpers, structs, files);
the 16 entry circuits have new verifier keys, and the account's other
circuits keep theirs. The full list of renamed and removed names and
the changed keys is in [EVM-K256](../../../contract/EVM-K256.md),
section 16.

**Privacy.** A call publishes its entry point (the arm and the role);
blinded device entries, boot commitments and grant IDs; a grant's
spent, object, RP and caller commitments, salted per issuance
(`evm_salt` above); the change bit of the
shielded grantee calls; unshielded amounts, recipients and balances;
inbox ciphertexts and the encryption key; the grant scope fields the
shared chip stores in the clear; `read_pk_hash`; recovery material;
and the counters. Keys, addresses, blinds, signatures and checked
encodings stay private inputs. Exposures inherited from upstream and
the standard library: any permissionless deposit changes the shared
`round` counter, so a pending proved call must be proved again (its
signature stays valid); `sendShielded` derives output nonces publicly
from the spent coin's nonce, so whoever knows a spent coin can trace
its spend; a hosted or delegated proof server sees keys, blinds and
signatures and so links wallets to accounts (clients should prove
locally); `read_pk_hash` is unsalted, so a reused read key links
grants (clients MUST derive a fresh read key per account and grant;
this arm's client takes it from a seed over the grantee request's
signature, tag `midnight:account:read:evm:v1`, with the account,
site label and slot); a device's consumed and successor entries form
a public chain of its calls within the account; `jubjub`, `k1` and
passkey devices and grantees use upstream's unblinded recipes, so a
known key can be tested; and a to-contract spend may name the account
itself (no coin stranded, no inbox entry, a grantee's cap consumed).

**Provenance residual.** Showing a key in full does not prove whose
it is. Approving an attacker-supplied key or recovery material grants
what the effect line states. Mitigations: circuit-fixed effect lines,
the new device's client rendering the identical descriptor for
comparison (MIP-0013 S7), and recovery material from the client's own
guardian ceremony. The EVM address, a passkey origin and a Solana key
(in base58) can be compared by eye; k1, jubjub and passkey public
keys are shown only.

## Copyright Waiver

This document is licensed under the Apache License, Version 2.0, and
its authors have signed the Midnight Foundation Contributor License
Agreement. Portions of this document were drafted with the assistance
of a large language model; the named authors reviewed and are
accountable for its entire content.
