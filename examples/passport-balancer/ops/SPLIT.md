# Splitting the balancer's NIGHT into more DUST coins

**Status on 2026/09/02: `approved = false`. Nothing in this directory has been
run against the live wallet, and `split-night.ts --execute` refuses to run at
all until somebody sets `SPLIT_APPROVED=yes` deliberately.** This document is
the analysis and the procedure, written so that the decision can be taken on
figures rather than on the day.

## Why a split is on the table

The balancer holds 4,998.916 NIGHT as **two** unshielded UTxOs (4,998 and
0.916), so the ledger generates its DUST into **two** coins — caps 2.499e19 and
4.58e15 Specks.

Fee balancing picks DUST coins *smallest first* and keeps taking them until the
fee is covered (`wallet-sdk-capabilities` `Balancer.doBalance`, via
`V1Builder.withCoinSelectionDefaults`), so every sponsored transaction sweeps
the tiny coin **and** the big one — indexer-decoded fee legs show 2–4 dust
spends per transaction. And a spent DUST entry is not removed by the ledger: it
gets `pending_until = ctime + 10,800 s` (`midnight-ledger` `ledger/src/dust.rs`
`DustLocalState::spend`), and `utxos()` / `wallet_balance()` skip pending
entries. So from the moment a transaction is balanced until its change lands
(50–95 s observed) the wallet has **no** spendable DUST at all.

Two coins therefore mean one lane. An activation is five sequential sponsored
transactions, which is the 2-minutes-to-a-name / 5-minutes-to-assets we measure,
and a second Passport's registration queues behind the first's whole activation
(280 s observed on 2026/09/02).

`N` coins mean up to `N` lanes — **but only once each coin holds a whole fee by
itself.** That proviso is the entire sizing question, and `splitPlan.ts` answers
it.

## The plan for N = 8

Run it yourself — it moves nothing and needs no seed:

```sh
cd examples/passport-balancer
npx esbuild ops/split-night.ts --bundle --format=esm --platform=node \
  --packages=external --outfile=dist/ops/split-night.mjs
node dist/ops/split-night.mjs --plan --outputs 8 --total 4998916000
```

| Figure | N = 8 |
| --- | --- |
| Per coin | 624.864500 NIGHT (624,864,500 atomic; 7 explicit outputs + change, remainder 0) |
| Cap per coin | 3.1243225e18 Specks |
| Generation per coin | 5,165,754,821,500 Specks/s |
| **One max fee (1.37e16) per coin after** | **2,653 s ≈ 44 min** |
| Two max fees per coin after | 5,305 s ≈ 88 min |
| Any fee at all, all coins swept together | 332 s ≈ 6 min |
| Wallet cap, wallet generation | 2.499458e19 Specks, 41,326,038,572,000 Specks/s — **unchanged by the split** |
| Sustained capacity | 10.859 max fees/h ≈ 3.611 activations/h (2.828 counting a first send) |
| Time to cap from zero | 604,815 s ≈ 7 days |
| Spent-coin grace | 10,800 s = 3 h |
| Old DUST coin left behind | 24,946,432,797,282,076,896 Specks, decaying to nothing over 603,650 s ≈ 7 days |

Ledger parameters: `nightDustRatio` 5e9 Specks of cap per atomic NIGHT,
`generationDecayRate` 8,267 Specks per atomic NIGHT per second, both read from
`LedgerParameters.initialParameters().dust` and confirmed against `updatedValue`
on the live state. Fees are the indexer's `paidFees` for the 13:31–13:34
activation of 2026/09/02: resolver deploy 1.37e16 (the maximum), register
0.85e16, `deposit_night` 0.69e16, mint 0.50e16, `deposit_shielded` 0.71e16, plus
a balance-only send leg at 1.14e16.

### What the split does and does not buy

- It buys **concurrency**: up to 8 sponsored transactions in flight instead of
  1, once the coins are grown.
- It buys **nothing at all** in throughput. Cap and generation rate belong to
  the NIGHT, not to how many coins it sits in — 10.859 max fees an hour either
  way. If sponsorship is ever *rate* limited rather than *lane* limited, the
  answer is more NIGHT, not more coins.
- It **costs** a window. Every new coin starts at zero DUST.

### The two windows to plan around

1. **Worst-case blackout ≈ 6 min (332 s).** If the pre-split DUST does not
   survive the NIGHT rotation, the wallet cannot pay *any* fee until the new
   coins together hold 1.37e16 Specks. Whether it survives is the open question
   below; assume it does not.
2. **Single-lane gap ≈ 45 min, and ≈ 90 min for two fees per lane.** Until each
   coin holds a whole fee, smallest-first selection keeps sweeping *every* coin
   for one transaction, exactly as it does today. **The split buys nothing for
   the first 45 minutes and only reaches two-deep lanes at 90.** Do not schedule
   a split inside two hours of a demo.

### The old coin

Spending the NIGHT that backs the 2.499e19 coin does not destroy that coin: it
keeps its value and enters linear decay at the same 8,267 Specks/atomic-NIGHT/s,
reaching zero in ≈ 603,650 s ≈ 7 days. **It stays spendable the whole way down.**
If it survives the rotation in the wallet's own view, it covers roughly 1,800
maximum fees on its own while the new coins grow, and window 1 above disappears.
That is the single largest uncertainty in this plan and the reason `--execute`
prints the plan again from the *live* balance before it builds anything.

## The safe procedure

Nobody runs this without a written approval. Assuming one exists:

1. **Pick the window.** No demo within two hours. Not while any activation is in
   flight.
2. **Check the sponsor is idle**, and keep checking until it is:
   ```sh
   curl -s https://67-205-177-162.sslip.io/balancer/status | jq '{busy, spendQueueDepth, balancesWatched}'
   curl -s https://67-205-177-162.sslip.io/balancer/wallet-status
   ```
   `busy: false`, `spendQueueDepth: 0`, `balancesWatched: 0`. A watched balance
   is somebody's transaction that has not landed; splitting under it would spend
   the change it is waiting for.
3. **Stop the unit and its watchdog.** The watchdog restarts the service and
   must never act mid-split:
   ```sh
   systemctl stop passport-balancer-watchdog.timer
   systemctl stop passport-balancer
   systemctl is-active passport-balancer   # must not say "active"
   ```
4. **Back up the state.** `cp -a /var/lib/passport-balancer /root/pre-split-$(date +%s)`.
   `aliases-stagenet.json` is never edited by anything, the split included.
5. **Dry-run the sizing against the live balance** — `--plan` needs no wallet, so
   run it first and confirm the total matches what `/wallet-status` reported.
6. **Execute.** Bundle it *locally* — the droplet is deployed by rsyncing
   `src/`, `dist/`, and `package.json`, so `dist/ops/` travels the same way and
   nothing has to be built on the box:
   ```sh
   # locally, in examples/passport-balancer
   npx esbuild ops/split-night.ts --bundle --format=esm --platform=node \
     --packages=external --outfile=dist/ops/split-night.mjs
   rsync -a dist/ops/ root@67.205.177.162:/opt/passport-balancer/dist/ops/

   # on the droplet — the unit takes its environment from systemd's
   # EnvironmentFile, so hand the script the same file explicitly
   cd /opt/passport-balancer
   SPLIT_APPROVED=yes BALANCER_ENV_FILE=/etc/passport-balancer.env \
     node dist/ops/split-night.mjs --execute --outputs 8
   ```
   It refuses unless the approval is set, `systemctl is-active passport-balancer`
   is not `active`, and there is no `sync-snapshot-stagenet.json.tmp` in the
   state dir. It opens the wallet from the same state dir and the same
   environment as the unit, waits for `isSynced`, prints the plan from the live
   balance, builds one unshielded self-transfer of 7 × 624,864,500 atomic plus
   change back to the balancer's own address, balances it from its own DUST,
   proves it through `BALANCER_PROVER_URL`, submits it, waits until the wallet
   itself reports 8 NIGHT UTxOs and at least 8 DUST entries — 9 if the old coin
   survives the rotation, which is the open question above, so the wait does
   not insist on it — saves the snapshot, and exits 0. Add `--cold` to ignore the existing
   snapshot and walk from chain — use it if the snapshot is at all suspect.
7. **Do not start the service for 45 minutes** if the point of the split was
   concurrency. Starting sooner is safe but buys nothing.
8. **Start the service, then the watchdog:**
   ```sh
   systemctl start passport-balancer
   systemctl start passport-balancer-watchdog.timer
   ```

## Guards to watch after the split

### The DUST registration must NOT re-register

`registerDustIfNeeded` (`src/wallet.ts`) registers every *unregistered* NIGHT
UTxO at start-up. After the split the wallet's NIGHT sits in eight brand-new
UTxOs, and the question is whether the ledger still counts them as registered
for DUST generation.

**The service's first `[dust]` log line after the split must read
`already-generating`.** If it logs `registered … NIGHT UTxO(s) for DUST
generation`, then the split rotated the NIGHT into UTxOs the ledger considers
fresh, their DUST generation was re-based, and **every new coin restarted from
zero at the moment of registration rather than at the moment of the split** —
the 45-minute window began later than you think, and a second registration will
have cost a fee as well. **Stop, do not split further, and report it.** The
whole plan's timings assume generation follows the NIGHT.

```sh
journalctl -u passport-balancer --since "10 min ago" | grep '\[dust\]'
```

### Zero DUST right after the split is expected, not a wedge

For a few minutes after the split — and again for 50–95 s after every
sponsorship — `/wallet-status` will report `dustSpecks: 0`. That is *settling*:
the coins are in flight as pending change and the wallet's own spend explains
them. It is only *lost* when nothing is pending, nothing is booked, and the
balance is still zero well past the change window. The health ladder already
draws that line — `settling` while the wallet's own spend explains the zero,
`wedged` only once nothing explains it; do not read a settling zero as the wedge
and do not cold-resync over it. (The known wedge — a node-rejected
balanced transaction leaving the spent coins `pending_until` for three hours,
which only a cold resync clears — is a different failure, and unrelated to the
split.)

### Coin selection stays smallest-first

For the first ≈ 45 minutes each new coin is worth less than one fee, so
balancing still sweeps all eight for a single transaction and the wallet is
still single-lane. This is not a bug and there is nothing to tune: the coins
have to grow. After that the smallest coin covers a fee on its own and
transactions stop colliding.

## Verification

After the service is back up:

```sh
curl -s https://67-205-177-162.sslip.io/balancer/wallet-status   # utxoCount 8, dust growing
curl -s https://67-205-177-162.sslip.io/balancer/status | jq '{busy, spendQueueDepth}'
journalctl -u passport-balancer --since "15 min ago" | grep -E '\[dust\]|spendable now'
```

The proof that the split worked is not the UTxO count: it is **two sponsored
transactions overlapping** without the second waiting on the first's change.
Watch `spendQueueDepth` during two concurrent activations an hour after the
split; today it never falls below 1 while a spend is settling.

## Gates for this directory

`ops/` is deliberately outside `tsconfig.json`'s `include` (which is `src` and
`test`) so that the operator script is never part of the service build. Type-check
it explicitly:

```sh
cd examples/passport-balancer
npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 \
  --strict --skipLibCheck --esModuleInterop --resolveJsonModule --types node ops/*.ts
npx esbuild ops/splitPlan.test.ts --bundle --format=esm --platform=node \
  --packages=external --outfile=dist/ops/splitPlan.test.mjs
node --test dist/ops/splitPlan.test.mjs
node dist/ops/split-night.mjs --plan --outputs 8 --total 4998916000
```

The refusals are testable without a wallet: put a `systemctl` on `PATH` that
prints `active`, and `--execute` refuses; unset `SPLIT_APPROVED`, and it refuses
before it looks at anything else.

## Mirrors to keep honest

`split-night.ts` builds its own facade rather than calling
`openBalancerWallet`, because the service's wallet interface deliberately
exposes no way to move its own NIGHT. It mirrors `src/wallet.ts` for the
keystore, the facade configuration, and — critically — the sync-snapshot format
(`version: 1`, `networkId`, `unshieldedAddress`, `savedAt`, and the three
serialised states, written to `.tmp` and renamed). **If `src/wallet.ts` changes
how the snapshot is written, this file must follow**, or a split would leave
behind a snapshot the service refuses and cold-walk for 90 s at the next start.
