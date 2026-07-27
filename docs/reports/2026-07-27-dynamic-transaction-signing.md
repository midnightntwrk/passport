# Passport — Dynamic transaction signing: completion report

**Date:** 2026/07/27
**Branch:** `demo/mn-passport-dynamic-flow`
**Scope:** `experiments/account-custody-prototype`
**Package under test:** `@dynamic-labs/midnight` 4.91.6

---

## Summary

- The Dynamic signature in the Passport deposit flow was requested, awaited,
  and then dropped. It has been replaced by an approval receipt that is bound
  to one exact transaction, retained, and enforced: no approval, no broadcast.
- Dynamic's supported value-transfer path
  (`createTransferTransaction` → `signTransaction` → `submitTransaction`) is
  now wired end to end and demonstrable from the Holdings view.
- Executing a Compact circuit through Dynamic remains blocked upstream. The
  demo now says so on screen instead of implying otherwise, and probes for the
  missing API so it will report the day Dynamic ships it.

---

## Context

Two questions prompted this work, and they have different answers.

**Hector, on the planning call:** "I'm a little bit curious what happened with
the Dynamic signing, because that signature never was used for anything."
Correct — see the defect below.

**Alvaro, on Slack:** Dynamic's transfer flow is
`createTransferTransaction` → `signTransaction` → `submitTransaction`, or
`sendBalance` for the simple case. Also correct — for a *transfer*. It is not
a path for a contract call, which is what the Passport deposit is. Both facts
are now reflected in the code.

---

## The defect

Three call sites awaited `wallet.signMessage(...)` and discarded the result,
so the prompt the user saw gated nothing:

| Location | What happened |
|---|---|
| `FoundationsFlow.tsx` — custody deposit | Signed a free-text message, dropped it, then called `account.depositNight(...)` regardless. |
| `FoundationsFlow.tsx` — deploy capital | Same, before writing the position. |
| `Onboard.tsx` — account unlock | Requested a signature, then threw unconditionally. The user was prompted for nothing. |

`signMessage` was also the wrong primitive for the intent it stood in for: it
is the sign-in-style off-chain authorisation call, and it neither produces nor
broadcasts a transaction.

---

## What each Dynamic API actually does

Verified by reading the shipped connector, not the marketing surface.

| API | What it does | Usable for a C1 custody call? |
|---|---|---|
| `wallet.signMessage(message)` | Off-chain authorisation over arbitrary text. Broadcasts nothing. | Only as an approval receipt. |
| `wallet.createTransferTransaction({ transfers })` | Builds an unsigned transfer draft. No MPC, no proof, no broadcast. | No — transfers only. |
| `wallet.signTransaction(serialized)` | MPC signing plus Midnight proof generation, returning a finalised transaction. Consumes the draft above. | No. |
| `wallet.submitTransaction(finalized)` | Broadcasts, returns `{ txHash }`. | Yes, if something else finalised the bytes. |
| `wallet.sendBalance({ toAddress, amount })` | The three steps above in one call. | No — transfers only. |
| Balance-and-prove for a call-proved Compact transaction | Not exposed. | **Blocked upstream.** |

Executing a Compact circuit is not signing a transaction. The client runs the
Compact runtime, the proof server produces the call proof, and the resulting
transaction still has to be balanced and finalised against DUST before it can
be broadcast. That final step is the missing Dynamic endpoint — the same gap
described on the call as the BCW integration.

---

## What the code does now

### 1. Approvals are receipts, and they are enforced

A new platform-neutral module (`src/wallet/dynamic-approval.ts`) builds one
canonical message per intent:

```
MN Passport transaction approval
Version: 1
Network: preview
Wallet: <embedded wallet address>
Contract: <custody contract address>
Circuit: deposit_night
Summary: Deposit 1000 NIGHT into the MN Passport custody account
amount: 1000
tokenType: 0000…
Approved at: 2026-07-27T12:00:00.000Z
Expires at: 2026-07-27T12:05:00.000Z
Nonce: <uuid>
```

Arguments are sorted deterministically, so the same intent always produces the
same bytes and a different amount always produces a different message. The
signature is required (an empty, missing, or rejected signature aborts the
action), fingerprinted with SHA-256, logged, displayed in the transaction
panel with its expiry, and persisted alongside whatever it authorised. A
stale approval fails before broadcast.

### 2. Transfers use Dynamic's supported flow

`app/src/lib/dynamicTransactions.ts` implements the three-step path and
requires a real transaction hash back. A failure before broadcast reverts the
draft so its reserved UTXOs are released; a failure *during* broadcast
deliberately does not, because a timeout can land after the transaction is
already on chain and releasing the reservation would desynchronise the wallet.

This is wired to a "Dynamic embedded wallet — NIGHT transfer" panel in
Holdings, on the embedded wallet's own network. It is unmocked and moves real
NIGHT; it is deliberately not presented as a custody deposit.

### 3. Onboarding keeps what it asks for

Account creation retains the approval fingerprint alongside the device-secret
record. The signature is **not** used as key material: Dynamic signs through
MPC and makes no determinism guarantee over the same message. The unlock path
no longer requests a signature it cannot use.

### 4. The demo states the route

The deposit modal names, on screen, which wallet signs (Dynamic, via
`signMessage`) and which wallet broadcasts (the Passport devnet wallet, via
`account.depositNight`), together with the reason.

---

## What signs what today

To be unambiguous, because "signing" means three different things in this
flow and only one of them is a transaction signature:

| Layer | Who does it | On chain? |
|---|---|---|
| Approval of the intent | Dynamic `signMessage` | No. Client-side receipt; the chain never sees it. |
| In-circuit device authorisation | Passkey-derived secret, as a witness (hash preimage) | As a proof, not a signature. |
| **Transaction signature, balancing, and fees** | **The localnet demo wallet** (`app/src/lib/providers.ts` — `unshieldedKeystore.signData` applied to the balancing recipe) | Yes. |

**No Dynamic signature appears on chain for a custody call.** The one place
Dynamic genuinely signs and broadcasts is the NIGHT transfer panel, which is a
value transfer on Dynamic's own network, not a contract call.

---

## What Dynamic needs to ship

Dynamic cannot balance and finalise a call-proved Compact transaction, so the
custody circuit call is broadcast by the Passport devnet wallet with the
Dynamic approval bound to it. This section is the request, in enough detail to
hand to Dynamic directly.

### Where the handoff sits

| Step | Who owns it | Why |
|---|---|---|
| 1. Run the Compact runtime, produce the transcript | Passport client | Needs the circuit and the private-state witnesses. |
| 2. Generate the call proof | Passport proof server | Needs the circuit's proving key. |
| 3. **Balance and finalise against DUST, and sign** | **Dynamic — missing** | Needs the wallet's UTXOs, DUST, and keys, which only Dynamic holds. |
| 4. Broadcast | Either; we prefer the caller | Lets us bind the user's approval to the exact broadcast bytes. |

Steps 1 and 2 cannot move to Dynamic and do not need to: Dynamic never sees
the circuit, the witnesses, or the private state. Step 3 cannot stay with us,
because the wallet's keys, UTXOs, and DUST live inside Dynamic's MPC
infrastructure. That single step is the whole blocker.

### The API contract we are asking for

```ts
// Advertises the capability, so a client can detect it rather than guess.
getMidnightProofCapabilities(): Promise<{
  protocol: 'dynamic-midnight-compact-proof-v1'
  operations: ['balance-and-finalize']
  inputTransaction: 'unbound'      // a call-proved Compact transaction
  outputTransaction: 'finalized'   // ready to broadcast
  callerBroadcasts: true
  networks: string[]               // e.g. ['preview']
}>

// Balances and finalises a transaction Dynamic did not build.
proveMidnightTransaction(request: {
  protocol: 'dynamic-midnight-compact-proof-v1'
  operation: 'balance-and-finalize'
  network: string
  walletAddress: string
  serializedTransaction: string    // base64 call-proved UnboundTransaction
  inputTransactionDigest: string   // SHA-256, so the response ties back to it
  intent: {                        // for Dynamic's own approval UI
    contractAddress: string
    circuit: string
    summary: string
    arguments: Record<string, string>
  }
}): Promise<{
  protocol: 'dynamic-midnight-compact-proof-v1'
  operation: 'balance-and-finalize'
  inputTransactionDigest: string   // echoed, must match the request
  finalizedTransaction: string     // base64, caller broadcasts
}>
```

### Behavioural requirements

1. **No wallet secrets leave Dynamic.** The client sends a transaction and
   receives a transaction. Nothing else.
2. **The call proof must survive untouched** — the finalised transaction still
   has to verify against our circuit's verifier key.
3. **Echo the input digest**, so the user's approval can be bound to the exact
   bytes that get broadcast. Passport already signs an approval covering both
   the input and the finalised digest.
4. **Reserved inputs must be revertable.** A finalised-but-never-broadcast
   transaction must not strand UTXOs; `revertTransaction` already exists and
   should accept this output.
5. **Network-scoped, and mismatches rejected** rather than silently resolved.
   Today `signTransaction` resolves `chainId` by name internally, which is
   invisible to the caller.
6. **DUST failures must be distinguishable.** Insufficient DUST should be its
   own error, never an unbalanced transaction returned as success.
7. **Respect the transaction's TTL**, or state the TTL Dynamic applies.
8. **Distinguishable error codes** for at least: unsupported operation,
   insufficient DUST, network mismatch, expired TTL, and user rejection.

`callerBroadcasts: false` with a returned `txHash` would also be workable if
Dynamic would rather own the broadcast, but caller-broadcast is preferable —
it lets us bind the approval and reconcile indexer confirmation ourselves.

### The open question worth testing first

`connector.signTransaction(serializedTransaction)` forwards an arbitrary
base64 string to Dynamic's iframe wallet client; the SDK layer does not
structurally restrict it to drafts produced by `createTransferTransaction`.
Whether Dynamic's backend will balance and finalise a *call-proved* transaction
or reject it is untested. Feeding one Passport deposit transaction into it on
preview, with a DUST-funded wallet, either unblocks this immediately or
produces a concrete error to put in front of Dynamic. That test needs a
Dynamic wallet with DUST on preview and takes minutes.

### Detection is already wired

`probeDynamicCompactSupport` looks for exactly `getMidnightProofCapabilities`
and `proveMidnightTransaction`, reports what is missing in the UI and the log,
and will flag the release that adds them. The transfer-only `signTransaction`
is deliberately **not** treated as a fallback: it consumes the draft that
`createTransferTransaction` builds, not a contract call.

### Passkeys are still needed regardless

Even once Dynamic can execute a contract call, the passkey remains in the
flow: the approval authorises the call, and the passkey-derived secret
witnesses the private state. The two are not substitutes. Removing the passkey
would need the private-state secret to come from somewhere Dynamic can expose
to the client, which is a separate conversation.

---

## Verification

| Check | Result |
|---|---|
| `npx vitest run` (prototype) | 30 tests pass, including 7 new approval tests: message binding, deterministic argument ordering, empty signature, rejected signature, and expiry. |
| `npx tsc --noEmit` (prototype and `app/`) | Clean. |
| `npx vite build` | Clean. |

**Not covered:** live behaviour against Dynamic's preview environment. The
headless demo script (`app/scripts/e2e-devmode.mjs`) cannot drive this flow
because the app now requires a Dynamic session, and it was already stale
against the current UI copy before this change.

---

## Files

| Path | Change |
|---|---|
| `src/wallet/dynamic-approval.ts` | New. Platform-neutral approval receipt: canonical message, required signature, fingerprint, expiry. |
| `app/src/lib/dynamicTransactions.ts` | New. Dynamic boundary: `approveWithDynamicWallet`, `transferWithDynamicWallet`, `probeDynamicCompactSupport`. |
| `test/dynamic-approval.test.ts` | New. Seven unit tests over the approval contract. |
| `app/src/views/FoundationsFlow.tsx` | Deposit and deploy bound to live approvals; route and approval surfaced in the UI. |
| `app/src/views/Onboard.tsx` | Creation retains its approval; unlock no longer prompts pointlessly. |
| `app/src/views/WalletPanel.tsx` | Dynamic NIGHT transfer panel (the supported three-step flow). |
| `DYNAMIC-SIGNING.md`, `DECISIONS.md`, `README.md` | Engineering note and decision record for the signing boundary. |

The in-repo engineering note is
[`experiments/account-custody-prototype/DYNAMIC-SIGNING.md`](../../experiments/account-custody-prototype/DYNAMIC-SIGNING.md);
the design rationale sits in that experiment's `DECISIONS.md`.

---

## Asks

1. **Dynamic:** confirmation of the API contract in "What Dynamic needs to
   ship" above, and a timeline for the BCW integration. Passport is ready to
   consume it the day it exists — detection is already in the code.
2. **One experiment, before any of that:** push a call-proved Passport
   transaction through the existing `signTransaction` on preview and record
   what comes back. It either unblocks this now or gives Dynamic a concrete
   failure to work from.
3. **Stagenet access** for the team's GitHub handles, so this can be exercised
   somewhere other than the localnet.
4. **Review of the approval message format** before it hardens — it is
   versioned (`Version: 1`), so changing it later is a deliberate bump rather
   than a silent break.
