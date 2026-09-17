# C23 · dApp connection protocol

**Serves:** P7 · P8 · P10.

## Outcome

The protocol surface that lets third-party dApps request scoped grants
— including the Sign-In-with-Passport (DecentralisedAuth) authentication
half of the same surface. **Open Wallet Standard (OWS)** is the chosen
direction for the Cardano + Midnight workflow (approved 2026/05/13);
underlying transport / discovery layers (CAIP-25, EIP-6963,
WalletConnect v2) sit beneath it. Maps to MIP-5 / MIP-7, and the
issuance half to the scoped-grants MIP (MIP-10).

**Status 2026/09 — issuance half specified.** The scoped-grants and
dApp-connection MIP (see C10), co-authored with the Midnight
Foundation, fixes the connection ceremony: the dApp navigates the user
to an authoriser page with a canonical `GrantRequest` and a detached
possession proof in the URL fragment, signed as the transmitted bytes
(no canonicalisation; a JWS container was considered and rejected);
the proof is a WebAuthn assertion made on the dApp origin, so the
consent screen names an origin the browser attested rather than one
the page typed; the user approves with the account passkey; the
authoriser submits one device-gated `issue_grant`; the dApp verifies
its grant by reading chain state and thereafter signs in with the
passkey registered for its origin. Read access is the MIP-0012 viewing
capability sealed to a dApp-supplied key. Account-linked sign-in is in
scope; unlinkable sign-in stays with the DecentralisedAuth MIP
(MIP-7). The MIP carries a scope mapping table to Open Wallet Standard
connection scope strings and declares the OWS handshake flag and
CAIP-10 for Midnight as upstream dependencies.

Two findings about wallets as counterparties: a regular Midnight
wallet key already signs an account challenge (BIP-340) on every
shipped surface and verifies in-circuit at k=15 to k=16, so a plain
wallet can operate a Passport account once the seam grows that arm
(blocked in Compact on secp256k1 point operations); and keys behind
the dApp-connector `signData` ECDSA scheme are admitted today through
the k256 signing envelope, though as read-only grantees, since spend
through the connector needs an upstream structured-display surface.

## Dependencies

- **C10** — grants requested through this protocol.
- **C22** — intent surface determines what flows through the protocol's
  request / response shape.
- **C20** — selective-disclosure proofs travel through the protocol for
  compliance / sign-in.
- **External · primary** — Open Wallet Standard (OWS); integration with
  the Cardano + Midnight workflow approved 2026/05/13, **in progress**
  upstream.
- **External · underlying** — CAIP-25 spec, EIP-6963 multi-injected
  provider, WalletConnect v2 transport.

## Open questions

**OWS spec maturity and shape.** OWS is in-progress upstream; what is
locked in the current draft, what is still moving, and what is our
extension surface inside it?

**OWS ↔ CAIP-25 / EIP-6963 relationship.** Does OWS subsume them, layer
on top, or coexist? The mockup currently treats OWS as the umbrella —
this needs upstream confirmation.

**Transport choice.** For issuance, resolved: an https redirect with
the request and proof in the URL fragment, `redirect_uri` same-origin
with the proven origin. Provider injection and WalletConnect remain
questions for the OWS session layer.

**Privacy scopes.** The MIP defines the Passport scope vocabulary and
a mapping table to OWS connection scope strings; OWS acceptance of the
table and of the handshake flag is the open item.

**Cross-chain dApp integration.** A dApp with cross-chain UX (per P10) —
does the connection protocol expose chain agnosticism, or does the dApp
specify chains explicitly?

**MIP co-author.** Resolved for the issuance half: the Midnight
Foundation co-authors the scoped-grants MIP. The OWS mapping (MIP-5)
and sign-in (MIP-7) still want a wallet-provider or OWS upstream
co-author.

## Failure modes

**OWS draft churns.** Spec shifts after we integrate; rework cost.
*Detection:* upstream OWS change-log monitored; integration tests pinned
to a specific draft version.

**dApp cannot integrate.** Protocol shape too Passport-specific for
ecosystem dApps. *Detection:* third-party dApp integration partner
cannot construct conforming requests.

**Permission scope confusion.** A dApp asks for one scope but the
wallet enforces a different one. *Detection:* differential test of scope
translation.

**Transport unavailable.** WalletConnect relay down; dApp cannot reach
wallet. *Detection:* fallback transport not configured.

## Alternatives

**A — Open Wallet Standard (OWS)** *(chosen 2026/05/13, in progress
upstream)*. Cardano + Midnight workflow target; common wallet-handshake
surface across both ecosystems. The grant-issuance ceremony is
specified independently of the OWS session layer and maps into it
through the scope table.

**B — CAIP-25 + EIP-6963 + WalletConnect v2** (original design doc
default; now framed as the underlying-transport layer beneath OWS
rather than the top-level protocol).

**C — Passport-native protocol** (more control, less ecosystem fit).

**D — Hybrid (OWS wire format with Passport-specific scope
vocabulary).**
