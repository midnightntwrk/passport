# Splitting the balancer's NIGHT into more DUST coins

**Status on 2026/09/02: NOT APPROVED. `approved=false`.** Nothing in this
directory has moved any NIGHT, and `ops/split-night.ts --execute` refuses to run
unless an operator sets `SPLIT_APPROVED=yes` by hand. This document exists so
that the decision can be taken on numbers rather than on intuition, and so that
whoever eventually runs the split has one procedure to follow rather than a
reconstruction from memory.

## Why anyone wants this

The balancer holds 4,998.916 NIGHT as **two** unshielded UTxOs (4,998 and
0.916), so the ledger generates its DUST into **two** coins, capped at 2.499e19
and 4.58e15 Specks.

Fee balancing picks DUST coins smallest-first — `Balancer.doBalance` in
`wallet-sdk-capabilities`, via `V1Builder.withCoinSelectionDefaults` — and keeps
taking coins until the fee is covered. With a 4.58e15 coin and a 1.37e16 fee,
the small coin never covers a fee alone, so **every** sponsored transaction
sweeps both coins. Indexer-decoded fee legs show 2–4 dust spends per
transaction.

Spending a DUST coin does not remove it. `DustLocalState.spend()`
(`midnight-ledger` `ledger/src/dust.rs:1735`) sets
`pending_until = ctime + dust_grace_period` (10,800 s) on the entry, and
`utxos()`/`wallet_balance()` skip every entry with `pending_until` set
(`dust.rs:1438-1456`). So from the moment a transaction is balanced until its
change lands and the indexer reports it — 50–95 s observed — the wallet reports
**zero** spendable DUST.

Two coins that are always spent together therefore mean **one lane**. An
activation is five sequential sponsored transactions, which is the 2-minutes-to-
a-name / 5-minutes-to-assets the demo shows today, and it is why a second
Passport's registration queued 280 s behind the first's activation on
2026/09/02.

`N` coins, each large enough to cover a fee on its own, would mean up to `N`
lanes. That is the entire case for the split.

## What the split does not buy

DUST generation is a property of the **NIGHT**, not of the coin it lands in.
Splitting `T` atomic NIGHT into `N` UTxOs leaves the aggregate rate
(`T × generationDecayRate`) and the aggregate cap (`T × nightDustRatio`)
completely unchanged. `ops/splitPlan.test.ts` pins this:

> sustained capacity does not depend on how many coins the NIGHT sits in

The split buys **concurrency**, and pays for it in **per-coin latency**: each
coin is `1/N` of the size, so each takes `N` times as long to hold a whole fee.

## The numbers — N = 8 on 4,998.916 NIGHT

Run `node dist/ops/split-night.mjs --plan --outputs 8 --total 4998916000` for
these; they are pinned in `ops/splitPlan.test.ts` so that a change to any of
them is a failing test rather than a quietly different plan.

| | |
|---|---|
| per coin | 624.864500 NIGHT (624,864,500 atomic — 8 divides exactly) |
| cap per coin | 3,124,322,500,000,000,000 Specks (3.12e18) |
| generation per coin | 5,165,754,821,500 Specks/s (5.166e12) |
| generation in total | 41,326,038,572,000 Specks/s — **unchanged by the split** |
| one max fee (1.37e16) per coin after | **2,653 s (≈44 min)** |
| two max fees per coin after | **5,305 s (≈88 min)** |
| any fee at all, sweeping every coin | **332 s (≈6 min)** |
| sustained | **10.859 max fees/hour** |
| sustained | **3.611 activations/hour** (2.828 counting a first send) |
| time to cap | 604,815 s (**7 days**) |
| spent-coin grace | 10,800 s (3 h) |

Ledger parameters: `nightDustRatio` 5e9 Specks per atomic NIGHT,
`generationDecayRate` 8,267 Specks per atomic NIGHT per second,
`timeToCapSeconds` 604,815, grace 10,800. Both rates were confirmed against
`updatedValue` on the live state: the 0.916 NIGHT coin generates 7.57e9
Specks/s, the 4,998 NIGHT coin 4.13e13/s.

Fees, from the indexer's `paidFees` on the 13:31–13:34 activation of
2026/09/02: balance-only send leg 1.14e16, resolver deploy 1.37e16 (the maximum
— the figure a coin must cover alone), register 0.85e16, `deposit_night`
0.69e16, mint 0.50e16, `deposit_shielded` 0.71e16. One activation ≈ 4.12e16
Specks, or ≈5.26e16 with a first send.

### Reading the capacity figures honestly

10.859 fees/hour and 3.611 activations/hour are what the NIGHT **generates**,
so they bound the balancer whether or not the split happens. They are not a
promise of throughput: the prover is a separate ceiling (2 vCPU / 8 GB, one
`proof-server:9.0.0-rc.6` shared by the balancer and every client — a 61 s gap
between `check` and `prove` was measured under contention on 2026/09/02), and
three concurrent balancer proofs will largely serialise on that box. **The split
removes the DUST lane limit; it does not remove the prover limit.** Sizing N
above about 8 buys lanes the prover cannot use.

## The gap after the split — and the one open question

A split spends the wallet's NIGHT. The new NIGHT UTxOs start with **no DUST at
all**, and accrue linearly.

- For the first **≈332 s** the wallet cannot pay a maximum fee even by sweeping
  every new coin together. Plan the maintenance window around this.
- For the first **≈2,653 s (≈45 min)** no single coin holds a whole fee, so
  smallest-first selection still sweeps all of them and the wallet is still
  effectively **single-lane** — exactly as it is today. The split has not helped
  yet.
- Only after **≈5,305 s (≈88 min)** does each coin hold two fees, which is when
  the lanes are comfortably independent.

**The open question, and the reason to be conservative.** The prior reading of
the ledger was that spending a NIGHT UTxO leaves its old DUST coin in linear
decay — 2.5e19 Specks over ≈7 days, spendable throughout — which would have
covered the whole gap above. Live evidence from 2026/09/02 16:47Z contradicts
that: a cold resync **from genesis**, replaying the 16:36:18 registration's
NIGHT rotation, ended with `dustSpecks 0` and `utxoCount 0` while the wallet
held all 4,998.916 NIGHT. If a NIGHT rotation genuinely leaves no spendable
DUST, then the ≈332 s figure is a **hard blackout with no fallback**, and there
is no old coin to lean on. `splitPlan` reports the old coin's decay horizon
(603,650 s ≈ 7 days) as analysis, and reports `worstCaseBlackoutSeconds` on the
conservative assumption that it does not survive. **Size the maintenance window
against the worst case; do not approve the split on the assumption that the old
coin remains spendable until that contradiction is resolved.**

## The registration-loop guard — read this before running anything

`src/wallet.ts:983-1020` (`registerDustIfNeeded`) registers every NIGHT UTxO
that is not yet registered for DUST generation. **The split creates eight
unregistered NIGHT UTxOs.** When the service comes back up it will therefore
register them, and that registration is itself a transaction that pays a fee
out of the DUST those very UTxOs are projected to generate.

This is exactly the path the 16:36:18 rotation went through. So, on the first
start after a split:

- If the log says **`already-generating`**, the new UTxOs carried their
  registration through the split. Good.
- If the log says **`registered`**, the split rotated the UTxOs, their DUST was
  reset, and the wallet is now paying a registration fee out of freshly zeroed
  coins. **Stop and investigate before letting the service sponsor anything.**
  Repeating the cycle — spend NIGHT, re-register, reset DUST — is a loop that
  never lets the balancer accumulate a fee.
- If it says **`waiting-for-dust`**, that is the ≈332 s blackout above, and it
  is expected. It becomes a problem only if it persists past ≈10 min.

## Procedure — only when `approved` becomes true

1. **Get the approval in writing.** `approved=false` today. Do not set
   `SPLIT_APPROVED=yes` on your own judgement.
2. **Pick the window.** No activation in flight; `/status` shows the sponsor
   idle (no spend job, nothing queued); nobody demoing. Budget 15 min of service
   downtime plus the ≈45–90 min during which the balancer is back up but still
   single-lane, and assume a hard ≈6 min blackout at the start of it.
3. **Print the plan and check it against the live holding.**
   ```
   cd examples/passport-balancer
   npx esbuild ops/split-night.ts --bundle --format=esm --platform=node \
     --packages=external --outfile=dist/ops/split-night.mjs
   node dist/ops/split-night.mjs --plan --outputs 8 --total 4998916000
   ```
4. **Stop the service and take a snapshot copy.**
   ```
   systemctl stop passport-balancer
   cp -a /var/lib/passport-balancer /root/pre-split-$(date +%s)
   ```
   `aliases-stagenet.json` is never edited, here or anywhere.
5. **Run it.**
   ```
   cd /opt/passport-balancer   # wherever the unit's working tree lives
   SPLIT_APPROVED=yes node dist/ops/split-night.mjs --execute --outputs 8
   ```
   It refuses unless the unit is stopped and unless no `sync-snapshot-*.tmp` is
   sitting beside the snapshot. It waits for `isSynced`, builds ONE unshielded
   self-transfer of seven outputs plus change — every atomic unit returns to the
   balancer's own address, so a failure costs a fee and nothing else — balances
   the DUST leg from the wallet's own coins, proves via `BALANCER_PROVER_URL`,
   submits, waits until the wallet SEES eight NIGHT UTxOs and nine DUST entries,
   saves the snapshot, and exits 0.
   Add `--cold` to ignore the existing snapshot and walk from chain — use it if
   there is any doubt about the snapshot's DUST state.
6. **Start the service and watch the first registration.** See the guard above.
   ```
   systemctl start passport-balancer
   journalctl -u passport-balancer -f | grep -E '\[dust\]|spendable'
   ```
7. **Verify, without spending the DUST-backing NIGHT.**
   ```
   curl -s https://67-205-177-162.sslip.io/balancer/status | jq '{dustSpecks, dustUtxoCount, nightAtomic}'
   curl -s https://67-205-177-162.sslip.io/balancer/wallet-status | jq
   ```
   Expect eight NIGHT UTxOs, nine DUST coins, and `dustSpecks` climbing at
   ≈4.13e13/s towards the same 2.499e19 cap as before. Do not run an activation
   until at least one coin holds a fee (≈45 min), or the first one will simply
   sweep all eight coins and prove nothing.

## Rollback

There is none, and none is needed: the NIGHT never left the balancer's address.
Undoing a split means merging the UTxOs back with another self-transfer, which
resets the DUST again — so the recovery from "the split was a mistake" is to
wait 7 days for the coins to reach cap, not to spend more NIGHT.

## Gates

```
cd examples/passport-balancer

# types (ops/ is deliberately not in tsconfig.json's include — that file
# belongs to the service, and this script is not part of the service)
npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 \
  --lib es2022 --strict --skipLibCheck --esModuleInterop --types node ops/*.ts

# the pinned sizing
npx esbuild ops/splitPlan.test.ts --bundle --format=esm --platform=node \
  --packages=external --outfile=dist/ops/splitPlan.test.mjs
node --test dist/ops/splitPlan.test.mjs

# the plan prints, and moves nothing
npx esbuild ops/split-night.ts --bundle --format=esm --platform=node \
  --packages=external --outfile=dist/ops/split-night.mjs
node dist/ops/split-night.mjs --plan --outputs 8 --total 4998916000
```

No test and no gate in this unit builds or submits a transaction.
