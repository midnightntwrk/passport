# Protocol flows

Sequence diagrams that explain the Midnight Passport protocol one
interaction at a time. Each flow names the participants, the messages
between them, and the security properties the exchange establishes. The
diagrams are written in Mermaid so they render directly on GitHub.

These are explanatory: they describe the protocol as the standards
(MIP-0012, contract custody, and MIP-0013, account authorisation)
specify it, grounded in the reference implementation (`contract/`).
Where the earlier account-custody prototype simplified the eventual
protocol, the flow notes it.

## Flows

1. [First-time account creation](./01-first-account-creation.md) — a new
   bearer turns a passkey into an on-chain Passport account.

More to follow (adding a device, issuing a grant, lost-device and
total-loss recovery, spending under custody).
