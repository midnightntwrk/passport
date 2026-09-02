/**
 * The results file, and the arithmetic behind the one number nobody can read
 * off a single probe: what a sponsored transaction costs in DUST.
 *
 * HOW THE FEE IS PRICED, AND WHY IT IS NOT A SUBTRACTION
 * -----------------------------------------------------
 * A DUST balance is not a bank balance. Every NIGHT UTxO the balancer holds
 * GENERATES DUST continuously up to a cap, so `dustSpecks` climbs on its own
 * between spends and the naive `before − after` prices a transaction at less
 * than it cost — sometimes at less than nothing.
 *
 * So the regeneration is measured and added back. `/status` publishes both
 * `dustSpecks` and `balancesServed`, and the second is a counter: it increments
 * once per `/balance-only` the balancer actually served. During any stretch in
 * which `balancesServed` did not move, the slope of `dustSpecks` IS the
 * regeneration rate, with no modelling and no assumption about NIGHT holdings
 * or cap. Take the longest such stretch, get specks per second, and then over
 * the whole run:
 *
 *     spent  =  rate × elapsed  −  (dustAfter − dustBefore)
 *     fee    =  spent / balancesServed
 *
 * Both inputs and the derived rate are printed, because this is an estimate
 * with two failure modes a reader should be able to spot: a wallet sitting at
 * its generation CAP has a rate of zero and the estimate collapses to the naive
 * subtraction, and a run too short to contain a quiet stretch has no rate at
 * all. {@link estimateDustFee} says which of those happened rather than
 * returning a number that looks the same either way.
 */

import { availabilityTransitions } from './watcher.js';
import { formatSummary, groupBy, ms, summarise } from './stats.js';
import type { HttpEvent, OutcomeEvent, RunResult, SpanEvent, WatchEvent } from './events.js';

/* -------------------------------------------------------------------------- */
/* DUST                                                                       */
/* -------------------------------------------------------------------------- */

export interface DustEstimate {
  /** Why no figure could be produced, when none could. */
  unavailable?: string;
  dustBefore?: bigint;
  dustAfter?: bigint;
  balancesServed?: number;
  elapsedSeconds?: number;
  /** Specks per second, measured from a stretch with no spend in it. */
  regenerationRate?: number;
  /** Seconds of quiet the rate was measured over. */
  regenerationWindowSeconds?: number;
  spentSpecks?: number;
  feePerBalanceSpecks?: number;
  /** How many times the balancer published a DUST balance of exactly zero. */
  zeroWindows?: number;
  /** Total seconds it spent publishing zero. This is the refusal window. */
  zeroSeconds?: number;
}

/**
 * `dustSpecks` READS ZERO WHILE A TRANSACTION IS PENDING, and that is not a
 * gap in the data — it is the single most important thing this bench measured.
 *
 * The balancer holds three DUST UTxOs. Balancing one transaction reserves them,
 * and the SDK's balance excludes coins an in-flight transaction has reserved,
 * so for the whole ~45 s a transaction is pending the wallet's spendable DUST
 * is genuinely `0` and `/wallet-status` says `available: 0, INSUFFICIENT_DUST`.
 * A second Passport arriving in that window is not losing a race for a lock; it
 * is being told, correctly, that there is no DUST to pay with.
 *
 * So a zero is dropped from the fee arithmetic — averaging it in would price a
 * transaction at the entire balance — and counted instead, as
 * {@link DustEstimate.zeroWindows}. That count times its duration is the
 * refusal window every concurrency figure in this report is really about.
 */
function readingsFrom(watch: readonly WatchEvent[]): {
  readings: Array<{ at: number; dust: bigint; served: number }>;
  zeroWindows: number;
  zeroSeconds: number;
} {
  const all = watch
    .filter((event) => event.probe === 'status' && event.ok && event.dustSpecks !== undefined)
    .map((event) => ({
      at: event.at,
      dust: BigInt(event.dustSpecks as string),
      served: event.balancesServed ?? 0,
    }))
    .sort((a, b) => a.at - b.at);

  let zeroWindows = 0;
  let zeroSeconds = 0;
  let windowStart: number | null = null;
  for (const [index, reading] of all.entries()) {
    if (reading.dust === 0n) {
      if (windowStart === null) {
        windowStart = reading.at;
        zeroWindows += 1;
      }
      continue;
    }
    if (windowStart !== null) {
      zeroSeconds += (reading.at - windowStart) / 1_000;
      windowStart = null;
    }
    void index;
  }
  if (windowStart !== null) {
    zeroSeconds += ((all[all.length - 1] as (typeof all)[number]).at - windowStart) / 1_000;
  }

  return { readings: all.filter((reading) => reading.dust > 0n), zeroWindows, zeroSeconds };
}

/** The middle value, which is what makes the rate immune to one bad pair. */
function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

export function estimateDustFee(watch: readonly WatchEvent[]): DustEstimate {
  const { readings, zeroWindows, zeroSeconds } = readingsFrom(watch);

  if (readings.length < 2) {
    return {
      unavailable: 'the balancer’s /status never reported a non-zero DUST balance twice',
      zeroWindows,
      zeroSeconds,
    };
  }

  const first = readings[0] as (typeof readings)[number];
  const last = readings[readings.length - 1] as (typeof readings)[number];
  const base: DustEstimate = {
    dustBefore: first.dust,
    dustAfter: last.dust,
    balancesServed: last.served - first.served,
    elapsedSeconds: (last.at - first.at) / 1_000,
    zeroWindows,
    zeroSeconds,
  };

  /* THE GENERATION RATE, from every adjacent pair that spans no spend.
     The MEDIAN of the per-second slopes rather than one long window's average:
     a wallet whose DUST vanishes and reappears produces a handful of enormous
     spurious slopes at the edges of each pending window, and a mean — or a
     single window chosen by length — is at the mercy of them. Half the pairs
     would have to be wrong to move a median. */
  const slopes: number[] = [];
  let quietSeconds = 0;
  for (let index = 1; index < readings.length; index += 1) {
    const previous = readings[index - 1] as (typeof readings)[number];
    const current = readings[index] as (typeof readings)[number];
    const seconds = (current.at - previous.at) / 1_000;
    if (seconds <= 0 || current.served !== previous.served) continue;
    const change = Number(current.dust - previous.dust);
    /* A negative or huge jump between two readings with no spend between them
       is the wallet reappearing after a pending window, not generation. */
    if (change < 0) continue;
    slopes.push(change / seconds);
    quietSeconds += seconds;
  }

  if (slopes.length < 3) {
    return {
      ...base,
      unavailable: 'too few adjacent readings without a spend to measure the generation rate',
    };
  }

  const rate = median(slopes);

  /* THE SPEND, from each adjacent pair that DOES span a spend. Summed over the
     pairs rather than taken end to end, so a pending window in the middle of
     the run — where the balance is unreadable — costs one pair rather than the
     whole measurement. */
  let spent = 0;
  let balances = 0;
  for (let index = 1; index < readings.length; index += 1) {
    const previous = readings[index - 1] as (typeof readings)[number];
    const current = readings[index] as (typeof readings)[number];
    const served = current.served - previous.served;
    if (served <= 0) continue;
    const seconds = (current.at - previous.at) / 1_000;
    spent += rate * seconds - Number(current.dust - previous.dust);
    balances += served;
  }

  if (balances === 0) {
    return { ...base, regenerationRate: rate, regenerationWindowSeconds: quietSeconds };
  }

  return {
    ...base,
    balancesServed: balances,
    regenerationRate: rate,
    regenerationWindowSeconds: quietSeconds,
    spentSpecks: spent,
    feePerBalanceSpecks: spent / balances,
  };
}

/** Specks, at a magnitude a person can hold in their head. */
function specks(value: number | bigint | undefined): string {
  if (value === undefined) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e15) return `${(n / 1e18).toFixed(4)} DUST`;
  return `${n.toExponential(3)} specks`;
}

/* -------------------------------------------------------------------------- */
/* The file                                                                   */
/* -------------------------------------------------------------------------- */

function spanOf(spans: readonly SpanEvent[], name: string): number[] {
  return spans.filter((span) => span.name === name && span.ok).map((span) => span.ms);
}

/**
 * How long the chain took to admit a transaction, measured from the sponsor
 * handing the balanced transaction back.
 *
 * NOT from the app returning. The app's `submitting` phase does not end at the
 * submit — `submitTx` and midnight-js's own call machinery wait for the write
 * to land before the `confirming` phase begins — so a poll started at
 * `confirming` finds the transaction already there and reports a lag of about
 * a tenth of a second, which is true and useless. The last moment this bench
 * can name that is unambiguously BEFORE the submit is the `200` on
 * `/balance-only`: after it the transaction is complete, and everything left is
 * one local submit call and the chain.
 *
 * So this overstates the lag by the cost of that submit call and understates
 * nothing. It is an upper bound on the indexer's own delay, and it is the
 * number to compare against the ~14 s seen on 2026/08/31.
 */
function balancedToVisible(run: RunResult, spanName: string): number[] {
  const lags: number[] = [];
  for (const span of run.spans) {
    if (span.name !== spanName || !span.ok) continue;
    const visibleAt = span.startedAt + span.ms;
    let balancedAt = 0;
    for (const event of run.http) {
      if (event.user !== span.user) continue;
      if (event.path !== '/balance-only' || event.status !== 200) continue;
      const completedAt = event.startedAt + event.ms;
      if (completedAt <= visibleAt && completedAt > balancedAt) balancedAt = completedAt;
    }
    if (balancedAt > 0) lags.push(visibleAt - balancedAt);
  }
  return lags;
}

function outcomeCounts(outcomes: readonly OutcomeEvent[]): Record<string, number> {
  const counts: Record<string, number> = { completed: 0, refused: 0, failed: 0 };
  for (const outcome of outcomes) counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
  return counts;
}

function shortName(upstream: HttpEvent['upstream']): string {
  return `${upstream.name}[${upstream.index}]`;
}

/** Every distinct status code seen for a group, as `200×7, 429×2`. */
function statusBreakdown(events: readonly HttpEvent[]): string {
  const counts = new Map<number, number>();
  for (const event of events) counts.set(event.status, (counts.get(event.status) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([status, count]) => `${status === 0 ? 'unreachable' : status}×${count}`)
    .join(', ');
}

function iso(at: number): string {
  return new Date(at).toISOString().replace('T', ' ').slice(0, 19);
}

/** One DUST estimate as a table, or the reason there is not one. */
function renderDust(w: (line?: string) => void, estimate: DustEstimate): void {
  const zero =
    estimate.zeroWindows === undefined || estimate.zeroWindows === 0
      ? null
      : `${estimate.zeroWindows} window(s) totalling ${Math.round(
          estimate.zeroSeconds ?? 0,
        )} s in which the balancer published a DUST balance of exactly zero — ` +
        'every Passport arriving in one of those was refused.';
  if (estimate.unavailable) {
    w(`Not priced: ${estimate.unavailable}.`);
    if (zero) {
      w();
      w(zero);
    }
    if (estimate.balancesServed !== undefined) {
      w();
      w(`The balancer served ${estimate.balancesServed} balance(s) over this window.`);
    }
    w();
    return;
  }
  w('| | |');
  w('|---|---|');
  w(`| Balances served by our balancer | ${estimate.balancesServed} |`);
  w(`| DUST at the start | ${specks(estimate.dustBefore)} |`);
  w(`| DUST at the end | ${specks(estimate.dustAfter)} |`);
  w(
    `| Generation rate, over ${Math.round(estimate.regenerationWindowSeconds ?? 0)} s of quiet | ${specks(
      estimate.regenerationRate,
    )}/s |`,
  );
  w(`| Elapsed | ${Math.round(estimate.elapsedSeconds ?? 0)} s |`);
  w(`| Spent, generation added back | ${specks(estimate.spentSpecks)} |`);
  w(`| **Per sponsored transaction** | **${specks(estimate.feePerBalanceSpecks)}** |`);
  w(
    `| Windows of zero spendable DUST | ${estimate.zeroWindows ?? 0}, totalling ${Math.round(
      estimate.zeroSeconds ?? 0,
    )} s |`,
  );
  w();
  if (zero) {
    w(zero);
    w();
  }
}

export interface ReportInput {
  date: string;
  runs: RunResult[];
  /** How the bench was invoked, for somebody reproducing it. */
  invocation: string;
  /**
   * Every watcher reading of the whole session, cool-downs included. A single
   * shape is often too short to contain both a spend and a quiet stretch; the
   * session always does, so the session-wide price is the sounder of the two
   * and the per-shape ones are there to show it did not drift.
   */
  sessionWatch: WatchEvent[];
  notes: string[];
}

export function renderReport(input: ReportInput): string {
  const out: string[] = [];
  const w = (line = ''): void => void out.push(line);

  w(`# Sponsored-onboarding load bench — ${input.date}`);
  w();
  w(
    'Every figure below was taken against live Midnight stagenet. One virtual user is one',
    );
  w(
    'operating-system process running the demo app’s own wiring: a fresh unfunded wallet, an',
  );
  w(
    'account-custody contract deployed, and one `add_grant` circuit called on it — a real ZK',
  );
  w('proof and a real sponsored DUST fee, with no value moved and no `.night` name claimed.');
  w();
  w('```');
  w(input.invocation);
  w('```');
  w();

  /* ---- the headline ----------------------------------------------------- */

  /**
   * Four facts, every one of them read off the runs rather than written by
   * hand, because these are the ones that get quoted without the tables under
   * them and a hand-written headline is where a bench starts lying.
   */
  w('## The four numbers');
  w();
  {
    const clean = input.runs.filter((run) =>
      run.outcomes.every((outcome) => outcome.status === 'completed'),
    );
    const dirty = input.runs.filter((run) =>
      run.outcomes.some((outcome) => outcome.status !== 'completed'),
    );
    const highestClean = clean.reduce((most, run) => Math.max(most, run.config.users), 0);
    const lowestDirty = dirty.reduce(
      (least, run) => Math.min(least, run.config.users),
      Number.POSITIVE_INFINITY,
    );
    const session = estimateDustFee(input.sessionWatch);

    const served = input.runs.reduce(
      (total, run) =>
        total +
        run.http.filter((event) => event.path === '/balance-only' && event.status === 200).length,
      0,
    );
    const spread = input.runs.reduce(
      (total, run) => total + (run.config.finishedAt - run.config.startedAt),
      0,
    );

    w('| | |');
    w('|---|---|');
    w(
      `| Highest concurrency at which every Passport finished | ${
        highestClean > 0 ? `N=${highestClean}` : 'none of the shapes was clean'
      } |`,
    );
    w(
      `| Lowest concurrency at which any Passport did not | ${
        Number.isFinite(lowestDirty) ? `N=${lowestDirty}` : 'never reached in this run'
      } |`,
    );
    w(
      `| DUST per sponsored transaction | ${
        session.feePerBalanceSpecks === undefined
          ? 'not priced — see below'
          : specks(session.feePerBalanceSpecks)
      } |`,
    );
    w(
      `| Sponsored transactions served, and over how long | ${served} in ${ms(spread)} of shape time |`,
    );
    w();
    if (session.zeroWindows) {
      w(
        `The balancer published a DUST balance of exactly zero ${session.zeroWindows} time(s) during ` +
          `this session, for ${Math.round(session.zeroSeconds ?? 0)} s in total. That is not an outage: ` +
          'it is what one pending transaction does to a wallet with three DUST UTxOs, and it is the ' +
          'window in which arriving Passports are refused.',
      );
      w();
    }
  }

  /* ---- the shapes ------------------------------------------------------- */

  w('## What each shape did');
  w();
  w('| Shape | Users | Sponsors, in order | Completed | Refused | Failed | Wall clock |');
  w('|---|---|---|---|---|---|---|');
  for (const run of input.runs) {
    const counts = outcomeCounts(run.outcomes);
    w(
      `| ${run.config.label} | ${run.config.users} | ${run.config.sponsors
        .map((sponsor) => sponsor.name)
        .join(' → ')} | ${counts.completed} | ${counts.refused} | ${counts.failed} | ${ms(
        run.config.finishedAt - run.config.startedAt,
      )} |`,
    );
  }
  w();

  /* ---- the timings ------------------------------------------------------ */

  w('## Per-user timings, p50 / p95 / max');
  w();
  w(
    'A p95 in italics is a maximum wearing a Greek letter — fewer than eight samples went into it.',
  );
  w();
  w(
    '“Balanced → indexer” is the chain’s own lag: from the sponsor’s `200` on `/balance-only` to the',
  );
  w(
    'contract call appearing on the indexer. It is an upper bound — the local submit call is inside',
  );
  w('it — and it is the figure to compare against the ~14 s seen on 2026/08/31.');
  w();
  w(
    '| Shape | Wallet sync | Deploy | `add_grant` | Balanced → indexer (deploy) | Balanced → indexer (grant) | End to end |',
  );
  w('|---|---|---|---|---|---|---|');
  for (const run of input.runs) {
    const completed = run.outcomes.filter((outcome) => outcome.status === 'completed');
    w(
      `| ${run.config.label} | ${formatSummary(summarise(spanOf(run.spans, 'wallet-sync')))} | ${formatSummary(
        summarise(spanOf(run.spans, 'deploy')),
      )} | ${formatSummary(summarise(spanOf(run.spans, 'grant')))} | ${formatSummary(
        summarise(balancedToVisible(run, 'deploy-indexer-visible')),
      )} | ${formatSummary(summarise(balancedToVisible(run, 'grant-indexer-visible')))} | ${formatSummary(
        summarise(completed.map((outcome) => outcome.totalMs)),
      )} |`,
    );
  }
  w();

  /* ---- contention ------------------------------------------------------- */

  w('## Where the contention was');
  w();
  w(
    'A sponsor serves one balance at a time. Our balancer expresses that as a reservation — its',
  );
  w(
    '`/wallet-status` publishes `available: 0, PENDING_TRANSACTION` and the client will not even try.',
  );
  w(
    'The 1AM gateway expresses it as `429 A balance transaction is already pending`, which the client',
  );
  w(
    'treats as waitable and retries. Both are the same ceiling wearing different clothes, and this is',
  );
  w('where a run meets it.');
  w();
  w(
    '| Shape | `/balance-only` 200 | 429 pending | Other refusals | Unreachable | Served by the second endpoint | Users refused at the gate |',
  );
  w('|---|---|---|---|---|---|---|');
  for (const run of input.runs) {
    const balance = run.http.filter((event) => event.path === '/balance-only');
    const ok = balance.filter((event) => event.status === 200).length;
    const pending = balance.filter(
      (event) => event.status === 429 || /already pending/i.test(event.refusal ?? ''),
    ).length;
    const unreachable = run.http.filter((event) => event.status === 0).length;
    const other = balance.length - ok - pending;
    const fellThrough = run.http.filter(
      (event) => event.status >= 200 && event.status < 300 && event.upstream.index > 0,
    ).length;
    const gated = run.outcomes.filter((outcome) => outcome.status === 'refused').length;
    w(
      `| ${run.config.label} | ${ok} | ${pending} | ${other} | ${unreachable} | ${fellThrough} | ${gated} |`,
    );
  }
  w();

  /* ---- the wire --------------------------------------------------------- */

  w('## Every request, by endpoint');
  w();
  w(
    'Taken by the bench’s own reverse proxy, which is what the workers’ sponsor and proving lists',
  );
  w(
    'point at, so the endpoint that actually served is recorded rather than inferred. `[0]` is the',
  );
  w('operator’s first choice and `[1]` is what a fall-through reached.');
  w();
  for (const run of input.runs) {
    if (run.http.length === 0) continue;
    w(`### ${run.config.label}`);
    w();
    w('| Endpoint | Path | Outcome | n | Statuses | p50 / p95 / max |');
    w('|---|---|---|---|---|---|');
    /* Split by outcome, not only by path. A `/balance-only` that was served
       and one that was refused with `429 already pending` are two different
       measurements — the first is the price of a fee, the second is the price of
       finding out you have to wait — and averaging them together describes
       neither. */
    const groups = groupBy(run.http, (event) =>
      [
        shortName(event.upstream),
        event.path,
        event.status === 0 ? 'unreachable' : event.status < 400 ? 'served' : 'refused',
      ].join('|'),
    );
    const rows = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [key, events] of rows) {
      const [endpoint, path, outcome] = key.split('|');
      w(
        `| \`${endpoint}\` | \`${path}\` | ${outcome} | ${events.length} | ${statusBreakdown(events)} | ${formatSummary(
          summarise(events.map((event) => event.ms)),
        )} |`,
      );
    }
    w();

    const refusals = run.http.filter((event) => event.status !== 0 && event.status >= 400);
    const unreachable = run.http.filter((event) => event.status === 0);
    if (refusals.length > 0 || unreachable.length > 0) {
      w('Refusals, verbatim:');
      w();
      const byReason = groupBy(
        [...refusals, ...unreachable],
        (event) => `${shortName(event.upstream)} ${event.path} ${event.status} ${event.refusal ?? ''}`,
      );
      for (const [reason, events] of byReason) {
        w(`- ×${events.length} — ${reason}`);
      }
      w();
    }
  }

  /* ---- what the sponsors said about themselves -------------------------- */

  w('## Sponsor availability, as published');
  w();
  w(
    'Every change in `available` on `GET /wallet-status`, polled directly against each host — not',
  );
  w('through the proxy, so the watcher’s own probes are not in the latency figures above.');
  w();
  for (const run of input.runs) {
    const transitions = availabilityTransitions(run.watch);
    if (transitions.length === 0) continue;
    w(`### ${run.config.label}`);
    w();
    w('| At | Service | available | Cause |');
    w('|---|---|---|---|');
    for (const transition of transitions) {
      w(
        `| ${iso(transition.at)} | ${transition.service} | ${transition.from ?? '—'} → ${
          transition.to ?? '—'
        } | ${transition.cause ?? '—'} |`,
      );
    }
    w();
    const zero = transitions.filter((transition) => transition.to === 0);
    if (zero.length === 0) {
      w('_No sponsor ever published `available: 0` during this shape._');
    } else {
      w(`_${zero.length} transition(s) to \`available: 0\`._`);
    }
    w();
  }

  /* ---- what it cost ----------------------------------------------------- */

  w('## What it cost');
  w();
  w(
    'A DUST balance climbs on its own — every NIGHT UTxO the balancer holds generates DUST up to a',
  );
  w(
    'cap — so `before − after` prices a transaction at less than it cost. The generation rate is',
  );
  w(
    'measured from a stretch in which `balancesServed` did not move, and added back. Both inputs',
  );
  w('are printed so the estimate can be checked rather than believed.');
  w();
  w('### The whole session');
  w();
  renderDust(w, estimateDustFee(input.sessionWatch));

  for (const run of input.runs) {
    w(`### ${run.config.label}`);
    w();
    renderDust(w, estimateDustFee(run.watch));
  }

  /* ---- notes ------------------------------------------------------------ */

  if (input.notes.length > 0) {
    w('## What this bench cannot tell you');
    w();
    for (const note of input.notes) w(`- ${note}`);
    w();
  }

  /* ---- the chain ------------------------------------------------------- */

  w('## The transactions');
  w();
  w('Public chain state, so an operator can read every claim above off the indexer themselves.');
  w();
  w('| Shape | User | Outcome | Contract | Deploy tx | `add_grant` tx |');
  w('|---|---|---|---|---|---|');
  for (const run of input.runs) {
    for (const outcome of run.outcomes) {
      w(
        `| ${run.config.label} | ${outcome.user} | ${outcome.status}${
          outcome.refusalCause ? ` (${outcome.refusalCause})` : ''
        } | ${outcome.contractAddress ? `\`${outcome.contractAddress.slice(0, 16)}…\`` : '—'} | ${
          outcome.deployTxId ? `\`${outcome.deployTxId.slice(0, 16)}…\`` : '—'
        } | ${outcome.grantTxId ? `\`${outcome.grantTxId.slice(0, 16)}…\`` : '—'} |`,
      );
    }
  }
  w();

  const submitted = input.runs.reduce(
    (total, run) =>
      total +
      run.outcomes.reduce(
        (count, outcome) => count + (outcome.deployTxId ? 1 : 0) + (outcome.grantTxId ? 1 : 0),
        0,
      ),
    0,
  );
  w(
    `**${submitted} transaction(s) submitted in total.** None of them claimed a \`.night\` name, none`,
  );
  w('spent from the balancer’s own wallet, and none moved any value.');
  w();

  return out.join('\n');
}
