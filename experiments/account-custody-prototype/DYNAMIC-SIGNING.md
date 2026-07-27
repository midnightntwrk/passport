# Dynamic signing in the Passport demo — what was wrong and what it does now

Date: 2026/07/27 · Package under test: `@dynamic-labs/midnight` 4.91.6

## The defect

Three call sites awaited `wallet.signMessage(...)` and discarded the result,
so the signature proved nothing and gated nothing:

- `app/src/views/FoundationsFlow.tsx` — the custody deposit signed a free-text
  message, dropped it, and then called `account.depositNight(...)` regardless.
- `app/src/views/FoundationsFlow.tsx` — deploying capital did the same before
  writing the position.
- `app/src/views/Onboard.tsx` — the unlock path requested a signature and then
  threw unconditionally, so the user was prompted for nothing.

`signMessage` was also the wrong primitive for the intent it was standing in
for. It is the sign-in-style off-chain authorisation call; it never produces
or broadcasts a transaction.

## What the Dynamic APIs actually do

| API | What it does | Usable for a C1 custody call? |
|---|---|---|
| `wallet.signMessage(message)` | Off-chain authorisation over arbitrary text. Broadcasts nothing. | Only as an approval receipt. |
| `wallet.createTransferTransaction({ transfers })` | Builds an unsigned transfer draft. No MPC, no proof, no broadcast. | No — transfers only. |
| `wallet.signTransaction(serialized)` | MPC signing plus Midnight proof generation, returning a finalised transaction. Consumes the draft the line above produced. | No. |
| `wallet.submitTransaction(finalized)` | Broadcasts and returns `{ txHash }`. | Yes, if something else finalised the bytes. |
| `wallet.sendBalance({ toAddress, amount })` | The three steps above in one call. | No — transfers only. |
| balance-and-prove for a call-proved Compact transaction | Not exposed. | **Blocked.** |

Executing a Compact circuit is not signing a transaction: the client runs the
Compact runtime, the proof server produces the call proof, and the resulting
transaction still has to be balanced and finalised against DUST before it can
be broadcast. That last step is the missing Dynamic endpoint.

## What the code does now

**`src/wallet/dynamic-approval.ts` (new, platform-neutral).** Builds a
canonical approval message naming the network, wallet, contract, circuit,
every argument sorted deterministically, the approval time, an expiry, and a
nonce. Requests the signature, refuses to return without one, and fingerprints
it with SHA-256.

**`app/src/lib/dynamicTransactions.ts` (new, browser glue).**

- `approveWithDynamicWallet` — the approval above, bound to the connected
  wallet and its real network (read from the wallet's own address).
- `transferWithDynamicWallet` — Dynamic's supported
  `createTransferTransaction` → `signTransaction` → `submitTransaction` flow,
  requiring a transaction hash back. A failure before broadcast reverts the
  draft to release its reserved UTXOs; a failure during broadcast does not,
  because a timeout can land after the transaction is already on chain.
- `probeDynamicCompactSupport` — checks the connector for
  `getMidnightProofCapabilities` and `proveMidnightTransaction` and reports
  what is missing, in the UI and in the log.

**`app/src/views/FoundationsFlow.tsx`.** The deposit now requires a live
approval bound to `deposit_night`, the custody contract address, the amount,
and the token type before anything is broadcast, and the approval fingerprint
and expiry appear in the transaction panel and the activity log. The route
panel states which wallet signed and which wallet broadcast. Deploying capital
keeps its approval fingerprint on the position.

**`app/src/views/Onboard.tsx`.** Account creation keeps its approval
fingerprint alongside the stored device-secret record. The signature is not
used as key material — Dynamic signs through MPC and does not promise a
deterministic signature over the same message. The unlock path no longer asks
for a signature it cannot use.

## Still externally blocked

Dynamic cannot balance and finalise an arbitrary call-proved Compact
transaction, so the custody circuit call is broadcast by the Passport devnet
wallet, with the Dynamic approval bound to it. Unblocking needs a Dynamic
release that accepts a call-proved transaction, returns it balanced and
finalised, and leaves the broadcast to the caller. `probeDynamicCompactSupport`
already looks for exactly that contract, so the demo will report the day it
lands.

The private-state secret still comes from the passkey, not from Dynamic. Both
are needed regardless: the approval authorises the call, the passkey-derived
secret witnesses it.

## Verification

- `npx vitest run` — 30 tests pass, including 7 new approval tests covering
  message binding, deterministic argument ordering, empty and rejected
  signatures, and expiry.
- `npx tsc --noEmit` in both the prototype and `app/` — clean.
- `npx vite build` — clean.

Live-network behaviour against Dynamic's preview environment is not covered by
these checks.
