# passport-bench

How many concurrent Passports the sponsored onboarding path can actually serve, measured
against live Midnight stagenet rather than reasoned about.

The question this exists to answer is the one the project lead asked: **100–200 concurrent
users at Token.** This bench does not answer it by simulating two hundred people. It finds
the concurrency at which requests start being refused, names the thing that refuses them,
and prices a transaction in DUST, so that the extrapolation to two hundred is arithmetic
somebody can check rather than a number somebody felt.

## The safe unit of real work

Every virtual user does exactly what the 2026/08/31 gateway-failover drill did, and for the
same reason: it is the cheapest transaction in the app that is completely honest.

1. Open a **fresh, unfunded wallet** from 32 random bytes and let it sync.
2. Deploy **one account-custody contract**.
3. Call **`add_grant`** on it once.

`add_grant` is a real ZK circuit proved through `POST /prove` and a real DUST fee paid
through `POST /balance-only`, and **not one unit of value moves** — it registers a spending
allowance against an account that holds nothing. Two transactions per user, both of them
things the app really does on the onboarding path.

### What it will never do

These are enforced by what the code does not contain, not by a flag:

- **It never claims a `.night` name.** One sponsored name per Passport, the slots are
  finite, and they are Midnames registry state. Nothing here calls `/register-alias`.
- **It never spends from the sponsor balancer's own wallet.** It cannot: every worker holds
  only its own fresh seed. The balancer's NIGHT UTxOs are what back its DUST generation, and
  a bench able to take those down is a bench able to break the service it is measuring.
- **It never asks for an activation grant.** `/fund-account` is untouched; the account stays
  empty, which is all `add_grant` needs.

### What bounds the spend

- `--confirm-live` is required. Without it the bench runs its preflight — probing each named
  endpoint, checking the ZK artefacts are staged, printing the plan and the transaction
  ceiling — and stops. That is the default, because the other default spends real DUST on a
  typo.
- `--accounts` caps the total virtual users across every shape in one invocation, default
  **10**. Each user submits at most two transactions, so the ceiling is `2 × accounts`. The
  bench prints it before it starts and refuses to run shapes that exceed it.
- A user the sponsor refuses submits **nothing at all**, so the real figure is usually well
  below the ceiling. The results file reports what was actually submitted.

## Running it

The demo's ZK artefacts have to be staged first — they are gitignored build output:

```sh
npm run prepare:zk --workspace passport-demo
```

Then, from `examples/passport-bench`:

```sh
node scripts/build.mjs

# Preflight only. Submits nothing.
node dist/bench.mjs --shape concurrent:5:balancer,gateway

# The real thing.
node dist/bench.mjs --confirm-live --accounts 34 \
  --shape sequential:2:balancer \
  --shape concurrent:2:balancer \
  --shape concurrent:5:balancer \
  --shape concurrent:10:balancer \
  --shape concurrent:5:balancer,gateway \
  --shape concurrent:10:balancer,gateway
```

A shape is `mode:users:endpoints`. `mode` is `sequential` or `concurrent`; `endpoints` is a
comma-separated list of named endpoints **in the operator's own order**, which is exactly
what `VITE_SPONSOR_URL` and `VITE_MIDNIGHT_PROVING_URL` carry in the deployed build. Two
names are defined out of the box and match what `deploy:passport:manual` ships:

| Name | Sponsor | Prover |
|---|---|---|
| `balancer` | `https://67-205-177-162.sslip.io/balancer` | `https://67-205-177-162.sslip.io/prover` |
| `gateway` | `https://api-stagenet.1am.xyz` | `https://api-stagenet.1am.xyz` |

`--define <name>=<sponsor-url>,<prover-url>` redefines one or adds another, so a run against
something else says so on its own command line.

`node dist/bench.mjs --help` lists the rest: `--stagger-ms`, `--cooldown-ms`,
`--wallet-status-ms`, `--status-ms`, `--indexer-timeout`, `--out`.

### Rebuilding a report without re-running anything

The events file is the whole of what a run observed, so a better table or a new
derived figure should never cost another sixty transactions:

```sh
node dist/bench.mjs --render results/2026-09-01.events.ndjson \
  --shape sequential:2:balancer --shape concurrent:2:balancer ...
```

Repeat the same `--shape` flags the run used — a shape's mode and label are the
operator's description of the run, not something the events carry. The mapping
from user to shape *is* carried, in the `s<shape>u<index>` worker tag, so
nothing is guessed. `--accounts` is not enforced in this mode: it is a spend
cap, and re-reading a recorded run spends nothing.

## What comes out

Into `results/` (or `--out`):

- `<date>.md` — the results tables. **This is what gets committed.**
- `<date>.log` — every line the workers and the app wrote, with the user that wrote it.
- `<date>.events.ndjson` — every event, raw, so a report can be rebuilt or re-analysed.

The last two are gitignored: they are evidence for whoever ran it, not a repository artefact.

## How it measures

### One process per virtual user

This is the fidelity decision the whole bench rests on. A real Passport is one browser tab,
and two things the app keeps are **module-level**, so every user sharing a process shares
them:

- `sponsor.ts` caches its `/wallet-status` probe for 30 s in a module variable and
  de-duplicates concurrent probes onto one in-flight promise. Ten virtual users in one
  process would take **one** reading of the sponsor between them and all pass or all fail the
  gate together — which is not what ten browsers do, and it is precisely the gate whose
  behaviour under load is the question.
- `wallet.network.provingServerUrls` is read once when a wallet opens, and `setNetworkId`
  writes a process-wide network id the address codecs read back.

A `fork` per user gets all of that for free, and it also makes one user's traffic
unambiguously one user's — which is what lets a `/prove` be attributed under concurrency.

### A reverse proxy, not a wrapped `fetch`

The two halves of a sponsored transaction do not share an HTTP client. The sponsor client
calls `globalThis.fetch` (undici under Node); midnight-js's proof-server client imports
`cross-fetch`, which under Node is `node-fetch` and never touches the global. Wrapping one
misses the other.

So every worker's sponsor and proving lists point at the bench's own loopback proxy, one
base URL per endpoint per user:

```
http://127.0.0.1:PORT/<user>/s0   → the first sponsor in the operator's order
http://127.0.0.1:PORT/<user>/s1   → the second
http://127.0.0.1:PORT/<user>/p0   → the first prover
```

The proxy reorders nothing — the app's own failover walk is untouched — but a fall-through
becomes *visible*: `s0` answering `429` and `s1` answering `200` are two records with two
named endpoints, and no console line has to be parsed to know which sponsor paid.

`127.0.0.1` is deliberate. `assertSecureSponsorUrl` refuses plaintext for anything that is
not loopback, and a signed transaction goes over that wire; the proxy never leaves the
machine and its upstream leg is HTTPS.

It records sizes, status codes, and durations. **Request bodies are never recorded** — a
`/balance-only` body is a signed transaction. A response body is kept only when the response
was not a 2xx, truncated to 300 characters, because a refusal's own words are the finding:
`A balance transaction is already pending` and `INSUFFICIENT_DUST` are different answers to
the same question and the whole report turns on which came back.

### The watcher

`GET /wallet-status` on every sponsor at 1 Hz and `GET /status` on our balancer at 0.2 Hz,
**directly against the real hosts** — a watcher's own probes must not land in the per-user
latency figures they exist to explain. Every change in `available` is recorded with its
`unavailableCause`, because the app will not attempt a `/balance-only` while `available` is
0, so every transition to 0 is a window in which arriving Passports were refused.

### Submit → indexer visibility

Measured from the sponsor's `200` on `/balance-only`, **not** from the app returning. The
app's `submitting` phase does not end at the submit — `submitTx` and midnight-js's call
machinery wait for the write to land before `confirming` begins — so a poll started at
`confirming` finds the transaction already there and reports about a tenth of a second,
which is true and useless. The last moment this bench can name that is unambiguously before
the submit is the balanced transaction coming back; everything after it is one local call
and the chain. The figure therefore **overstates** the indexer's lag and understates nothing.

### The DUST price of a transaction

A DUST balance is not a bank balance: every NIGHT UTxO the balancer holds generates DUST
continuously up to a cap, so `before − after` prices a transaction at less than it cost —
sometimes at less than nothing.

`/status` publishes both `dustSpecks` and `balancesServed`, and the second is a counter that
increments once per `/balance-only` actually served. During any stretch in which
`balancesServed` did not move, the slope of `dustSpecks` **is** the generation rate, with no
modelling and no assumption about NIGHT holdings or caps. So:

```
spent = rate × elapsed − (dustAfter − dustBefore)
fee   = spent / balancesServed
```

The cool-down between shapes is where that quiet stretch comes from, which is why
`--cooldown-ms` is not optional. Both inputs and the derived rate are printed, because the
estimate has two failure modes a reader should be able to spot: a wallet sitting at its
generation cap has a rate of zero and the estimate collapses to the naive subtraction, and a
run too short to contain a quiet stretch has no rate at all. The report says which happened
rather than printing a number that looks the same either way.

## What it cannot tell you

Stated here as well as in every results file, because these are the ways a bench like this
gets over-read:

- **A shape that never reached a refusal has not found a ceiling.** It has found that the
  ceiling is above where it looked. The report says so instead of extrapolating.
- **A p95 over four samples is the largest of the four wearing a Greek letter.** Every
  summary carries its `n`, and below eight samples the report prints the maximum, labelled.
- **A virtual user is a Node process, not a browser.** It does not prove in-tab, it carries
  no passkey ceremony, and it does not pay a PWA's first load. Real onboarding is this plus
  those.
- **One machine, one network.** This measures what the *services* do under concurrency. It
  does not measure what a conference Wi-Fi network does to two hundred browsers.

## Layout

```
src/events.ts      the record types, and the join between the two processes
src/proxy.ts       the instrumented loopback reverse proxy
src/artefacts.ts   one static server over the demo's staged ZK artefacts
src/watcher.ts     /wallet-status and /status, and the availability transitions
src/worker.ts      one virtual Passport, in its own process
src/bench.ts       preflight, shapes, workers, results
src/report.ts      the results file, and the DUST arithmetic
src/stats.ts       percentiles, and the rule about small n
```

Nothing here writes to `examples/passport-demo/`. It imports the app's own
`localWallet.ts`, `passportContract.ts`, and `accountCustody.ts` unchanged, which is the
point: a bench that measured a copy of the onboarding path would be measuring the copy.
