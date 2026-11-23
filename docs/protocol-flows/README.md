# Protocol flows

Sequence diagrams that explain the Midnight Passport protocol one
interaction at a time. Each flow names the participants, the messages
between them, and the security properties the exchange establishes. The
diagrams are written in Mermaid so they render directly on GitHub.

These are explanatory and must name the implementation they describe.
The [first-account flow](01-first-account-creation.md) describes the reference
bootstrap and labels the separate passkey UX dependency. Published standards
may be ahead of this checkout: use the [standards register](../plans/MIPS.md)
and [architecture reference](../arc42.md) to distinguish the two.

## Flows

1. [First-time account creation](./01-first-account-creation.md) — a new
   bearer turns a passkey into an on-chain Passport account.
2. [Temporary Jubjub bootstrap](./02-temporary-jubjub-bootstrap.md) — proposed
   address-before-passkey flow for #212 (MIP-0013 working copy, section 3.2);
   awaits reference implementation and validation in #213, then upstream
   submission in #214.

More to follow (adding a device, issuing a grant, lost-device and
total-loss recovery, spending under custody).
