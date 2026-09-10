# Experiment Brief — Contract-to-Wallet Shielded Transfer with an Executor-Attached Ciphertext

**Date opened:** 2026/09/01
**Component:** C4 (asset custody model); consequences for MIP-0012 sections 6.2 to 6.5.
**Base:** `experiments/contract-to-contract-transfer` (harness, infra, contract shape).

## Question

A contract sends shielded value to an ordinary wallet. Can the recipient
find it?

A shielded output carries two independent things:

- **Ownership** — the commitment to the recipient's `CoinPublicKey`. It
  decides who can spend the note.
- **Discoverability** — a ciphertext of the coin's opening (nonce, colour,
  value), sealed to the recipient's **separate** `EncryptionPublicKey`,
  which a scanning wallet trial-decrypts.

A Compact circuit holds only the `CoinPublicKey`. It has no access to the
recipient's encryption key, so **the contract cannot seal that ciphertext**.
The apparent consequence is that a coin sent by a contract is owned but
undiscoverable, and that recipients need an application-layer channel to be
told about it.

The question this experiment settles: is the missing key missing from the
**executor**? The circuit runs on the caller's machine. The caller's runtime
therefore holds the full opening of every coin the circuit created, and
midnight-js builds the Zswap outputs client-side from that runtime state. If
the executor supplies the recipient's encryption key, does the output it
builds carry a working ciphertext, and does an unmodified wallet find the
coin, in the same transaction as the send?

## Why now

MIP-0012 carries an application-layer discovery channel — an advertised
`enc_key` on the custody contract and an append-only encrypted `inbox` — and
the account-custody reference implementation depends on it. That channel is
sound, but it only serves counterparties who implement the standard. It does
not help a contract paying a plain wallet, which is the ordinary case a
custody account must support.

Upstream discussion holds that the fix is in-circuit coin encryption, which
does not exist today. Before accepting an application-layer workaround as
permanent, we should establish precisely what the current platform already
allows, and where the residual gap actually is.

The ledger states the escape hatch as a rule rather than an accident:
`ZswapOutput.new` documents the ciphertext as omissible "*only* if the
`ShieldedCoinInfo` is transferred to the recipient another way", and
`ZswapLocalState.watchFor` exists for recipients told out of band. Whether
"another way" can be "the executor seals it in the same transaction" is an
empirical question.

## Design under test

A deliberately minimal vault contract. It holds shielded value and spends it
to a user's Zswap key. **No authentication** — device auth is proven in the
account-custody reference implementation and would only add variables here.
**No encrypted inbox** — the inbox is the application-layer workaround this
experiment is testing an alternative to, so including it would beg the
question.

Two send circuits differ in exactly one respect, what the contract tells the
caller about the coin it just sent:

| Circuit | Returns | Shape |
|---|---|---|
| `send_to_user` | `[sent, change]` | the contract cooperates |
| `send_to_user_opaque` | `Maybe<change>` | MIP-0012 section 6.3's withdrawal: the recipient's coin is never disclosed |

The executor supplies the recipient's encryption key through the midnight-js
call option `additionalCoinEncPublicKeyMappings`, a documented mapping of
`CoinPublicKey` to `EncPublicKey` "for coins created during circuit
execution". The SDK's resolver then hands that key to `ZswapOutput.new`.

The judge is **wallet B**: a separate seed, a separate wallet process, told
nothing out of band. No `watchFor`, no inbox, no hint. It is asked only what
its own scan found.

## Probes

| ID | Question | Success criterion |
|----|----------|-------------------|
| P1 | Is the mechanism sanctioned API or a trick? | The four surfaces (`ZswapOutput.new` and its omission rule, `newContractOwned`, `watchFor`, `additionalCoinEncPublicKeyMappings`) are inventoried verbatim from the installed toolchain, plus the resolver's refusal path. |
| P2 | Does a contract-sent coin reach a stock wallet in ONE transaction? | Using the **opaque** circuit: with the recipient's key the recipient's own scan finds the coin; with the wrong key it does not; with no key the SDK refuses to build the output. **The headline.** |
| P3 | Is the discovered coin real, and still secret? | The recipient spends it onward; no output carries the nonce or colour in the clear; the cooperative circuit's disclosed coin matches the executor's runtime read. |

## Interpretation grid

- **P2 arm C discovers, arm B does not** ⇒ ownership and discoverability are
  separable, and discoverability is the **executor's** to provide. A custody
  contract can pay a plain wallet today, with no protocol change and no
  application-layer inbox on the recipient side. MIP-0012's discovery
  machinery becomes an option for standard-implementing counterparties
  rather than a necessity for every payee, and the upstream ask narrows from
  "in-circuit encryption" to "make the attachment mandatory or verifiable".
- **P2 arm C fails to discover** ⇒ the client-built output does not carry a
  usable ciphertext for a third party; record the exact shape of the built
  output, and the application-layer channel stands as the only route.
- **P2 arm B also discovers** ⇒ discovery is not ciphertext-driven on this
  stack; the whole model here is wrong and the result must be re-derived.
- **P3 spend fails** ⇒ the coin is visible but not usable; report as a
  wallet-accounting defect, since ownership is a ledger property the
  ciphertext cannot affect.

Whatever P2 returns, one limitation is structural and should be stated in
the findings: the executor **chooses** whether to attach the ciphertext. The
circuit proves the commitment, never the ciphertext, so a lazy or hostile
caller can still produce an undiscoverable coin. That is the residual gap,
and it is narrower than "contracts cannot pay wallets".

## Constraints

- Local devnet only, same pins as the base experiment
  (`midnight-node:1.0.0`, `indexer-standalone:4.3.3`, `proof-server:8.1.0`).
- Two genesis-funded seeds: `WALLET_SEED` (the executor) and
  `WALLET_SEED_SECONDARY` (the recipient). The recipient must be a genuinely
  separate wallet, or the result proves nothing: the SDK resolves the
  caller's **own** encryption key automatically, so a self-send would pass
  trivially.
- Reproducibility: `./run-all.sh` end-to-end on a clean checkout; every probe
  writes `evidence/*.json`; `FINDINGS.md` regenerates from evidence.
