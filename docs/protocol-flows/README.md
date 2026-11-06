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

More to follow (adding a device, issuing a grant, lost-device and
total-loss recovery, spending under custody).
