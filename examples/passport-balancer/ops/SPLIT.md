# Splitting chosen NIGHT UTxOs into more DUST coins

**Status on 2026/09/03: the sizing and the tool are ready; nothing has moved.**
`ops/split-night.ts --execute` refuses to run unless an operator sets
`SPLIT_APPROVED=yes` by hand, stops the unit, and names the UTxOs to spend. This
document is the one procedure to follow, so that whoever runs the split is not
reconstructing it from memory.

## Why anyone wants this

Fees are paid in DUST. The SDK's fee balancing selects DUST coins
smallest-first, and a coin only pays for a contract call if it carries the whole
fee **on its own** — which is why `feeCapableCoinCount` in `src/wallet.ts:329`
counts coins and not Specks, and why `spendLaneCount` (`src/wallet.ts:345`) is
`min(BALANCER_SPEND_LANES, fee-capable free coins)`.

So the number of DUST coins that individually clear a fee **is** the number of
sponsored transactions the balancer can have in flight. `N` coins, each large
enough to cover a fee alone, mean up to `N` lanes. That is the entire case for
the split.

Spending a DUST coin does not remove it. `DustLocalState.spend()`
(`midnight-ledger` `ledger/src/dust.rs:1735`) sets
`pending_until = ctime + dust_grace_period` (10,800 s) on the entry, and
`utxos()`/`wallet_balance()` skip every entry with `pending_until` set
(`dust.rs:1438-1456`). From the moment a transaction is balanced until its
change lands — 50–95 s observed — that coin is invisible. A lane is therefore
a coin that is free, not merely a coin that exists.

## What the split does not buy

DUST generation is a property of the **NIGHT**, not of the coin it lands in.
Splitting `T` atomic NIGHT into `N` UTxOs leaves the aggregate rate
(`T × generationDecayRate`) and the aggregate cap (`T × nightDustRatio`)
completely unchanged. `ops/splitPlan.test.ts` pins this:

> sustained capacity is a property of the NIGHT, not of how it is cut up

The split buys **concurrency**, and pays for it in **per-coin latency**: each
1,000-NIGHT coin takes 1,815 s to become a lane, where a 5,000-NIGHT coin takes
363 s.

It also does not buy prover capacity. The prover is a separate ceiling — 2 vCPU
/ 8 GB, one `proof-server:9.0.0-rc.6` shared by the balancer and every client;
a 61 s gap between `check` and `prove` was measured under contention on
2026/09/02 — and three concurrent balancer proofs will largely serialise on that
box. **The split removes the DUST lane limit; it does not remove the prover
limit.** See the note on `BALANCER_SPEND_LANES` below before raising it to the
plan's arithmetic maximum.

## The ruling, and why `--inputs` had to be built

The ruling of 2026/09/02: split the two **newest** 5,000 NIGHT UTxOs into ten
coins of 1,000, and leave the older coins alone so their accrued DUST keeps
paying fees throughout the ramp.

Leaving specific coins alone is not something the wallet SDK will do for you.
`WalletFacade.transferTransaction` takes `{ type, outputs }` and
`{ ttl, payFees }` — there is **no** `inputs` field in the type or in the
runtime (`wallet-sdk-facade/dist/index.d.ts:427-433`, `index.js:686-710`). The
selector it uses is `chooseCoin`
(`wallet-sdk-capabilities/dist/balancer/Balancer.js:63-68`):

```js
coins.filter((c) => c.type === tokenType).sort((a, b) => Number(a.value - b.value)).at(0)
```

**Smallest-first**, called repeatedly by `doBalance` until the outputs are
covered (`Balancer.js:28-62`). The tempting shortcut — "ask for a self-send of
exactly 5,000 and let the selector satisfy it out of one 5,000 coin" — therefore
**does not work**: the smallest NIGHT UTxO in this wallet is the original
4,998 NIGHT coin, so it would be consumed **first**, and a 5,000 would be broken
anyway to make up the shortfall. `ops/splitInputs.test.ts` reproduces that
outcome from the SDK's own algorithm, so the danger is stated rather than
remembered.

What does work is `V1Builder.withCoinSelection`
(`wallet-sdk-unshielded-wallet/dist/v1/V1Builder.d.ts:45`), which replaces that
selector wholesale — and the selector is the **only** way a UTxO becomes an
unshielded input: `makeTransfer` passes it to `#balanceSegment`, which passes it
to `getBalanceRecipe`, whose `doBalance` adds inputs from nowhere else
(`v1/Transacting.js:100,114,243-255`). A selector that only ever returns UTxOs
from an allow-list makes a protected coin **unreachable**, not merely unlikely;
the worst it can do is fail to cover the outputs, which surfaces as
`InsufficientFundsError` before anything is signed.

The tool wires that selector up through `CustomUnshieldedWallet`, and then
**checks the built transaction anyway**: `assertOnlyChosenInputs` walks
`recipe.transaction.intents`, reads both the guaranteed and the fallible
unshielded offers, and refuses to sign if any input is a UTxO the operator did
not name. Two independent checks of the same property, because the cost of being
wrong is the balancer's fee-paying DUST.

Two alternatives were considered and rejected. `facade.unshielded.rotateUtxos`
does pin inputs exactly, but its output is hard-coded to a single UTxO of the
total — it consolidates, it cannot split. Hand-building an `UnshieldedOffer` and
passing it to `balanceUnprovenTransaction` bypasses `CoreWallet.spendUtxos`, so
the inputs are never booked into `pendingUtxos` and a concurrent build could
double-spend them.

### `--inputs` takes an `intentHash`, not a transaction hash

The ledger keys a UTxO by `intentHash` and `outputNo`
(`ledger-v9.d.ts:1856-1876`), and those are **not** the transaction hashes an
inbound transfer is announced under. On 2026/09/03 the wallet's UTxOs carried
`intentHash` values (`45718833…`, `a92f977e…`, `c601d7f5…`) with no relation to
the funding transaction hashes the ruling named (`667b6124…`, `8bab7b5e…`,
`7577ca12…`).

So: **never type a reference from anywhere but the tool's own listing.**
`--plan --live` prints one line per NIGHT UTxO with its reference, its value,
its age, and its registration flag. Copy from there. A hash prefix is enough as
long as it is unambiguous; an ambiguous prefix is a refusal, not a coin toss.

## The numbers — 1,000 NIGHT per coin

Pinned in `ops/splitPlan.test.ts`, so a change to any of them is a failing test
rather than a quietly different plan.

| | |
|---|---|
| per coin | 1,000.000000 NIGHT (1,000,000,000 atomic) |
| cap per coin | 5,000,000,000,000,000,000 Specks (5e18) |
| generation per coin | 8,267,000,000,000 Specks/s (8.267e12) |
| DUST-registration fee (8.5e14) after | **103 s (≈2 min)** |
| one max fee (1.37e16) after | **1,658 s (≈28 min)** |
| **a LANE (1.5e16) after** | **1,815 s (≈30 min)** |
| two max fees after | 3,315 s (≈55 min) |
| blackout | **none** — the untouched coins never stop paying |

**Plan the ramp on 1,815 s, not on 1,658 s.** `FEE_CAPABLE_SPECKS` in
`src/resolverPool.ts:60` is 1.5e16, carrying margin over the largest measured
fee, and it is the floor the service actually counts lanes against. A coin that
can just barely pay a fee is not yet a lane.

Ledger parameters: `nightDustRatio` 5e9 Specks per atomic NIGHT,
`generationDecayRate` 8,267 Specks per atomic NIGHT per second, time to cap
604,815 s (7 days), spent-coin grace 10,800 s (3 h).

Fees, from the indexer's `paidFees` on the 13:31–13:34 activation of
2026/09/02: resolver deploy 1.37e16 (the maximum — the figure a coin must cover
alone), midname register 0.85e16, `deposit_night` 0.69e16, `deposit_shielded`
0.71e16, mint 0.50e16, balance-only send leg 1.14e16. One activation ≈ 4.12e16
Specks, or ≈5.26e16 with a first send.

### One correction to the ruling's arithmetic

The ruling quoted "≈6 min to a registration fee 8.5e14". At 8,267 Specks per
atomic NIGHT per second a 1,000 NIGHT coin makes 8.267e12 Specks/s, so 8.5e14
arrives in **103 s**, not six minutes. Six minutes is the figure for a *different*
quantity — 332 s, the time five brand-new 1,000-NIGHT coins take to cover one
maximum fee **between them** — and 17 min (1,029 s) is the time one of them takes
to cover the 8.5e15 midname-registration leg. All three are pinned in
`ops/splitPlan.test.ts` so the discrepancy is on the record rather than in
somebody's head. None of them is on the critical path: the untouched coins pay
every fee during the ramp.

The ruling's "≈28 min to a resolver-deploy fee 1.37e16" is exactly right: 1,658 s.

## The live wallet has moved on — re-read it before you run anything

The ruling described four material UTxOs holding 19,998.87 NIGHT. On 2026/09/03
at 02:05Z the sponsor held **34,998.868 NIGHT across eight UTxOs**: the original
4,998 NIGHT coin, **six** inbound 5,000 NIGHT coins, and a 0.868 NIGHT
fragment — all eight registered for DUST generation, in six DUST coins totalling
≈2.6e19 Specks.

That does not change the shape of the operation, but it does change every
reference and every count. **Run `--plan --live` and work from what it prints.**
The `--outputs`/`--amount` arithmetic below is stable; the hashes are not.

## The DUST auto-registration path after the split

`src/wallet.ts:1665-1702` (`registerDustIfNeeded`) selects NIGHT UTxOs whose
`meta.registeredForDustGeneration` is `false` and registers them. The service
calls it on a one-minute loop that stands off while the wallet is busy or
reserved, and **logs only transitions** (`src/server.ts:739-763`) — so a steady
state is silent. A restart resets that, which is why the first line after
`systemctl start` is always printed.

Three outcomes, and what each means for ten fresh UTxOs:

- **`[dust] every NIGHT UTxO is registered for DUST generation`** — the expected
  one. The new UTxOs carried their registration through the split. `[dust]
  spendable now: N Specks` follows on the same transition.
- **`[dust] registered 10 NIGHT UTxO(s) for DUST generation (tx …)`**, preceded
  by `[dust] registration submitted — DUST accrues from here` — the new UTxOs
  did **not** carry a registration through, and the wallet has paid a
  registration fee. Not fatal here (the untouched coins have the DUST for it),
  but **read the next line carefully**: if each registration itself rotates the
  UTxOs it registers, the cycle never lets a coin accumulate. Stop and
  investigate before letting the service sponsor anything.
- **`[dust] the registration fee is X Specks and the registered NIGHT has not
  generated that much yet — will retry`** — `waiting-for-dust`. Expected only if
  the wallet has nothing else; here it should not appear at all.

**Expect the first.** Three lines of evidence, none of them speculative:

1. `src/server.ts:719-728` records a stagenet measurement of 2026/08/24: a 2
   NIGHT operator transfer out of a registered 5,000 NIGHT UTxO emitted
   `DustSpendProcessed`, `DustGenerationDtimeUpdate`, and `DustInitialUtxo` in
   one transaction, and the 4,998 NIGHT change came back **already generating**,
   with a HIGHER DUST balance than before the spend.
2. Every one of the eight UTxOs on the live wallet reads `registered` in the
   `--plan --live` listing, including the six that arrived from outside this
   service.
3. `journalctl -u passport-balancer --since 2026-08-25` contains **zero**
   `registered N NIGHT UTxO(s)` lines against 49 `already-generating`
   transitions.

Point 1 is a one-input, one-change rotation, though, and this is a one-input,
ten-output one. The first split is still the first observation of that. Watch
the line; do not assume it.

### A zero DUST reading after the split is *settling*, not *lost*

For the first minutes after a split — and again for 50–95 s after every
sponsorship for as long as coins are small enough to be swept together —
`/wallet-status` may report `dustSpecks: 0`. That is the coins being in flight
as pending change, with the wallet's own spend to explain them, and it clears
itself. It is only *lost* when nothing is pending, nothing is booked, and the
balance is still zero well past the change window; that is the `dust-lost`
verdict the health ladder already draws, and the wedge a cold resync clears.
**Do not read a settling zero as a wedge, and do not cold-resync over one.**

## Procedure

### 1. Confirm the window is idle

All of these, before anything else:

```
curl -s https://67-205-177-162.sslip.io/balancer/status \
  | jq '{busy, jobsRunning, spendQueueDepth, lanes, lanesConfigured, balancesWatched}'
```

- `busy: false` and `jobsRunning: 0` — no spend job running, nothing queued.
- `balancesWatched: 0` — no balanced transaction outstanding with somebody
  else's submit still to come.
- No activation in flight and nobody demoing.
- **The hang-fix build is deployed.** On 2026/09/03 at 02:04Z the service's
  HTTP loop was blocked — the listener's accept queue was backing up and
  `/status` answered nothing at all while the resolver shelf filled. Do not
  start a split against a service you cannot ask a question of. If `/status`
  does not answer, that is the precondition failing, not a networking blip.

The plan can be rehearsed regardless: `--plan --live` never writes, so it is
safe against a running unit. It is `--execute` that needs the unit stopped.

### 2. Print the plan against the live wallet

Read-only. Run it while the service is still up.

```
# locally, in examples/passport-balancer
npx esbuild ops/split-night.ts --bundle --format=esm --platform=node \
  --packages=external --outfile=dist/ops/split-night.mjs
rsync -a dist/ops/ root@67.205.177.162:/opt/passport-balancer/dist/ops/

# on the droplet
cd /opt/passport-balancer
BALANCER_ENV_FILE=/etc/passport-balancer.env \
BALANCER_NETWORK=stagenet \
BALANCER_STATE_DIR=/var/lib/passport-balancer \
BALANCER_PROVER_URL=http://127.0.0.1:6300 \
  node dist/ops/split-night.mjs --plan --live
```

Read the listing. Pick the **two newest 5,000 NIGHT UTxOs** — the listing is
sorted oldest first, so they are at the bottom — and copy their references. Then
print the plan for the first of them and check `SPEND` and `PROTECTED` are on
the lines you expect:

```
  node dist/ops/split-night.mjs --plan --live \
    --inputs <newest>:0 --outputs 5 --amount 1000
```

The environment prefix is elided from here on; every droplet command below takes
the same four variables.

### 3. Stop the watchdog, then the service, then take a copy of the state

The watchdog timer fires every ~10 min and would restart the unit under the
split.

```
systemctl stop passport-balancer-watchdog.timer
systemctl stop passport-balancer
systemctl is-active passport-balancer          # must not say "active"
cp -a /var/lib/passport-balancer /root/pre-split-$(date +%s)
```

`aliases-stagenet.json` is never edited, here or anywhere.

### 4. The two commands

One coin per transaction, five outputs each, run twice. Sequenced rather than
combined so that the second run can simply not happen if the first misbehaves —
and so the second run's `--plan --live` sees the first run's result.

```
SPLIT_APPROVED=yes node dist/ops/split-night.mjs \
  --execute --inputs <newest>:0 --outputs 5 --amount 1000
```

Wait for it to print `settled`. Re-run `--plan --live` — the newly created coins
should appear as five 1,000 NIGHT UTxOs — then:

```
SPLIT_APPROVED=yes node dist/ops/split-night.mjs \
  --execute --inputs <second-newest>:0 --outputs 5 --amount 1000
```

> The references are examples to be replaced, not values to be pasted. As of
> 2026/09/03 02:05Z they were `45718833…:0` (21 min old) and `a92f977e…:0`
> (26 min old), but the wallet gains UTxOs through the day and those are stale
> the moment a new transfer lands.

Each run, in order: refuses unless `SPLIT_APPROVED=yes` is set, unless
`systemctl is-active passport-balancer` does not say `active` (a `systemctl`
that cannot be run at all is a refusal too — "the question cannot be answered"
is not "probably fine"), unless `--inputs` names UTxOs, and unless no
`sync-snapshot-*.tmp` is sitting beside the snapshot. Then it waits for
`isSynced`, resolves the references, prints every UTxO as `SPEND` or
`PROTECTED`, builds ONE unshielded self-transfer of four outputs plus change out
of the named coin alone, **verifies the built transaction's own offer inputs
against `--inputs` before signing**, balances the DUST leg from the wallet's own
coins, proves via `BALANCER_PROVER_URL`, submits, waits until the wallet sees the
expected UTxO count, saves the snapshot, and exits 0.

Add `--cold` to ignore the existing snapshot and walk from chain — use it if
there is any doubt about the snapshot's DUST state.

### 5. Start the service and check the first `[dust]` line

```
systemctl start passport-balancer
journalctl -u passport-balancer -f | grep -E '\[dust\]|spendable|lanes'
```

Expect `[dust] every NIGHT UTxO is registered for DUST generation`, followed by
`[dust] spendable now: N Specks`. See the section above for what the other two
outcomes mean. Then re-arm the watchdog:

```
systemctl start passport-balancer-watchdog.timer
```

### 6. Raise `BALANCER_SPEND_LANES`, once the coins have ramped

The lane count is `min(BALANCER_SPEND_LANES, fee-capable free coins)`, and it is
**3** today. Until it is raised the split buys nothing at all.

Wait ~30 min (1,815 s) from the second run, so the new coins clear the
fee-capable floor, then:

```
systemctl edit passport-balancer        # add Environment=BALANCER_SPEND_LANES=8
systemctl daemon-reload
systemctl restart passport-balancer
curl -s https://67-205-177-162.sslip.io/balancer/status | jq '{lanes, lanesConfigured}'
```

**Eight, not the plan's arithmetic maximum.** The plan reports what the coins
would support (15 on the 2026/09/03 holding); the prover is the next ceiling and
lanes above about 8 buy concurrency it cannot serve. Raise it again later if the
prover is given more room, and watch `lanes` climb towards `lanesConfigured` as
each coin crosses 1.5e16.

### 7. Verify, without spending the DUST-backing NIGHT

```
curl -s https://67-205-177-162.sslip.io/balancer/status \
  | jq '{busy, lanes, lanesConfigured, spendQueueDepth}'
curl -s https://67-205-177-162.sslip.io/balancer/wallet-status | jq
```

Four things to confirm, in order of how much they prove:

1. **`utxoCount` is up by four per run.** Note what it counts: `utxoCount` on
   `/wallet-status` is `dustUtxoCount` — **DUST** UTxOs, not NIGHT ones, and the
   two do not match one-for-one (2026/09/03: eight NIGHT UTxOs, six DUST coins).
   `nightAtomic` is unchanged by a split, as it must be. For the NIGHT UTxO
   count itself, read the `--plan --live` listing.
2. **The first `[dust]` line said `already-generating`** (§5).
3. **`lanes` reaches `lanesConfigured`** once the new coins pass 1,815 s. This
   is the number the whole operation exists to move.
4. **A fee is paid by a new coin.** Watch the DUST list in `--plan --live`: a
   1,000-NIGHT-backed coin whose `generatedNow` drops is a coin that paid. Until
   one has, the split is unproven no matter what the counts say.

The real proof is not any count — it is **two sponsored transactions
overlapping**. An hour after the second run, watch `spendQueueDepth` through two
concurrent activations; before the split it never fell below 1 while a spend was
settling.

One thing to expect and not to be alarmed by: the fee for the split itself is
balanced smallest-DUST-first, so it comes out of whichever coin is currently
smallest — which may well be the DUST backed by a UTxO the split is spending.
That is the right order: that DUST starts decaying the moment its backing NIGHT
is spent, so using it first is free. It does mean the fee-paying coin can drop
back under the fee-capable floor and cost a lane for a few minutes.

## Rollback

There is none, and none is needed: **the NIGHT never leaves the balancer's
address.** Every output of the split, change included, is paid to the same
address the inputs came from, so a failure costs a fee and nothing else.

The pre-split copy from step 3 (`/root/pre-split-<epoch>`) is kept regardless.
It is not a way to undo the split — the chain has the transaction either way —
but it is the state to restore if the snapshot the tool writes turns out to be
one the service will not resume from.

Undoing a split in the ledger sense means merging the UTxOs back with another
self-transfer, which resets those coins' DUST again. So the recovery from "the
split was a mistake" is to wait 7 days for the coins to reach cap, not to spend
more NIGHT.

## The mirror to keep honest

`split-night.ts` builds its own facade instead of calling `openBalancerWallet`,
because the service's wallet interface deliberately exposes no way to move its
own NIGHT — a routine spend path for the balancer's holding is precisely what
should not exist. It therefore mirrors `src/wallet.ts` for the keystore, the
facade configuration, and the sync-snapshot format (`version: 1`, `networkId`,
`unshieldedAddress`, `savedAt`, the three serialised states, written to `.tmp`
and renamed). **If `src/wallet.ts` changes how the snapshot is written, this
script must follow**, or a split would leave behind a snapshot the service
rejects and cold-walk at the next start.

It diverges in exactly one place, and deliberately: the unshielded wallet is
built through `CustomUnshieldedWallet` with the pinned selector. `--plan` passes
no selector and gets the stock wallet, because a plan that read the world
through a modified selector would not be describing what `--execute` does.

## Gates

```
cd examples/passport-balancer

# types (ops/ is deliberately not in tsconfig.json's include — that file
# belongs to the service, and this script is not part of the service)
npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 \
  --lib es2022 --strict --skipLibCheck --esModuleInterop --types node ops/*.ts

# the pinned sizing, and the input pin
npx esbuild ops/splitPlan.test.ts --bundle --format=esm --platform=node \
  --packages=external --outfile=dist/ops/splitPlan.test.mjs
npx esbuild ops/splitInputs.test.ts --bundle --format=esm --platform=node \
  --packages=external --outfile=dist/ops/splitInputs.test.mjs
node --test dist/ops/splitPlan.test.mjs dist/ops/splitInputs.test.mjs

# the plan prints, and moves nothing
npx esbuild ops/split-night.ts --bundle --format=esm --platform=node \
  --packages=external --outfile=dist/ops/split-night.mjs
node dist/ops/split-night.mjs --plan --outputs 5 --amount 1000 --spend 5000
```

`ops/*.ts` reaches `src/config.ts` and `src/wallet.ts` through its imports, so
the type gate fails while those are mid-edit. That is a service problem to
settle, not an `ops/` one; re-run it once `src/` compiles.

No test and no gate in this unit builds or submits a transaction.
