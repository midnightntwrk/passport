/**
 * ONE virtual Passport, in its own process.
 *
 * WHY A PROCESS AND NOT A PROMISE
 * -------------------------------
 * This is the fidelity decision the whole bench rests on, so it is worth being
 * explicit. A real Passport is one browser tab, and two things the app keeps
 * are MODULE-LEVEL and therefore shared by every user that shares a process:
 *
 *   * `sponsor.ts` caches the `/wallet-status` probe for
 *     `SPONSOR_READINESS_TTL_MS` (30 s) in a module variable, and de-duplicates
 *     concurrent probes onto one in-flight promise. Ten virtual users in one
 *     process would take ONE reading of the sponsor between them and all pass
 *     or all fail the gate together — which is not what ten browsers do, and it
 *     is precisely the gate whose behaviour under load is the question.
 *   * `wallet.network.provingServerUrls` is read once when a wallet opens, and
 *     `setNetworkId` writes a process-wide network id that the address codecs
 *     read back.
 *
 * A fork per user gets all of that for free, and it costs only memory. It also
 * means the fetch traffic of one user is unambiguously one user's, which is
 * what lets the proxy attribute a `/prove` under concurrency.
 *
 * WHAT IT DOES, AND WHAT IT REFUSES TO DO
 * ---------------------------------------
 * One fresh, unfunded wallet; one account-custody contract deployed; one
 * `add_grant` circuit called on it. That is the safe unit of real work proven
 * by the 2026/08/31 gateway-failover drill: a real ZK proof and a real
 * sponsored DUST fee with NOT ONE UNIT OF VALUE MOVED — `add_grant` registers a
 * spending allowance against an account that holds nothing.
 *
 * It never claims a `.night` name: one sponsored name per Passport, the slots
 * are finite, and they are Midnames registry state. It never asks for an
 * activation grant, so `/fund-account` is untouched. And it never spends from
 * the balancer's own wallet — it cannot, because it holds only its own fresh
 * seed and the balancer's NIGHT UTxOs are what back its DUST generation.
 *
 * The seed is 32 random bytes, used to open the wallet, and zeroed immediately
 * afterwards. It is never logged, never sent to the orchestrator, and never
 * written down. The wallet it opens is empty and is abandoned at the end of the
 * run.
 */

import { randomBytes } from 'node:crypto';

import WebSocket from 'ws';

import type { OutcomeEvent, PhaseEvent, SpanEvent, WorkerEvent } from './events.js';

(globalThis as { WebSocket?: unknown }).WebSocket ??= WebSocket;

export interface WorkerConfig {
  user: string;
  /** Proxy URLs, comma-separated, in the operator's order. */
  sponsorList: string;
  proverList: string;
  zkOrigin: string;
  indexerUrl: string;
  nodeUrl: string;
  networkId: string;
  /** How long to wait before opening the wallet, for a staggered arrival. */
  startAfterMs: number;
  /** Upper bound on the indexer-visibility poll, after the app's own gave up. */
  indexerTimeoutMs: number;
}

const config = JSON.parse(process.argv[2] ?? '{}') as WorkerConfig;

/**
 * The app reads every one of these through `import.meta.env`, which esbuild has
 * rewritten to this global. Set BEFORE the app modules are imported — which is
 * why they are imported dynamically further down rather than at the top.
 */
(globalThis as { __BENCH_ENV__?: Record<string, string | undefined> }).__BENCH_ENV__ = {
  VITE_MIDNIGHT_NETWORK_ID: config.networkId,
  VITE_INDEXER_URL: config.indexerUrl,
  VITE_MIDNIGHT_NODE_URL: config.nodeUrl,
  VITE_SPONSOR_URL: config.sponsorList,
  VITE_MIDNIGHT_PROVING_URL: config.proverList,
};
process.env.PASSPORT_ZK_ORIGIN = config.zkOrigin;

/* -------------------------------------------------------------------------- */
/* Talking to the orchestrator                                                */
/* -------------------------------------------------------------------------- */

function emit(event: WorkerEvent): void {
  process.send?.(event);
}

function log(line: string): void {
  emit({ kind: 'log', user: config.user, at: Date.now(), line: line.slice(0, 2_000) });
}

/**
 * The app writes real diagnostics to the console — which sponsor paid, which
 * prover served, what a fall-through fell through. Under ten concurrent workers
 * those would interleave into an unreadable terminal, so they are forwarded to
 * the orchestrator as this user's log lines and written to the run's log file
 * instead. Nothing is discarded.
 */
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]): void => {
    void original;
    log(
      args
        .map((argument) =>
          argument instanceof Error
            ? `${argument.name}: ${argument.message}`
            : typeof argument === 'string'
              ? argument
              : safeJson(argument),
        )
        .join(' '),
    );
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, inner) =>
      typeof inner === 'bigint' ? `${inner}n` : inner,
    ) ?? String(value);
  } catch {
    return String(value);
  }
}

function span(name: string, startedAt: number, ok: boolean, detail?: string): void {
  const event: SpanEvent = {
    kind: 'span',
    user: config.user,
    name,
    startedAt,
    ms: Date.now() - startedAt,
    ok,
    ...(detail ? { detail: detail.slice(0, 500) } : {}),
  };
  emit(event);
}

function phase(operation: string, name: string): void {
  const event: PhaseEvent = {
    kind: 'phase',
    user: config.user,
    operation,
    phase: name,
    at: Date.now(),
  };
  emit(event);
}

/* -------------------------------------------------------------------------- */
/* Chain evidence                                                             */
/* -------------------------------------------------------------------------- */

interface Sighting {
  ms: number;
  seen: boolean;
  height?: number;
  detail?: string;
}

/**
 * The two visibility polls in flight, held on an object rather than in two
 * `let`s. They are started from inside a progress callback, and TypeScript's
 * control-flow analysis cannot see an assignment made there — a plain `let`
 * narrows to `never` at the point it is read back. A property survives the
 * function call, which is the honest reading anyway.
 */
const pollers: { deploy?: Promise<Sighting>; grant?: Promise<Sighting> } = {};

/**
 * When the indexer first admits that a contract has `wanted` actions on it.
 *
 * Started the moment the app enters its `confirming` phase — that is, the
 * moment the transaction has been submitted — and NOT awaited by the thing it
 * is timing. The app does its own confirmation poll with a ten-second ceiling
 * (`TX_HASH_ATTEMPTS` × `TX_HASH_INTERVAL_MS`), after which it reports the
 * transaction as submitted but unresolved. Measuring visibility off the app's
 * return would therefore saturate at ten seconds and quietly under-report
 * exactly the lag this bench was asked to confirm under load.
 *
 * One second between polls, so a reading is accurate to about a second — a
 * stagenet block is six.
 */
async function firstSeenInIndexer(
  contractAddress: string,
  wanted: number,
  from: number,
  timeoutMs: number,
): Promise<Sighting> {
  const query = `{ contract(address:"${contractAddress}") { actions { __typename ... on ContractCall { entryPoint } transaction { hash block { height } } } } }`;
  const deadline = from + timeoutMs;
  let last = 'the indexer was never asked';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(config.indexerUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await response.json()) as {
        data?: {
          contract?: {
            actions?: Array<{ transaction: { hash: string; block: { height: number } } }>;
          } | null;
        } | null;
      };
      const actions = body.data?.contract?.actions ?? [];
      if (actions.length >= wanted) {
        const height = actions[actions.length - 1]?.transaction.block.height;
        return { ms: Date.now() - from, seen: true, ...(height ? { height } : {}) };
      }
      last = `${actions.length} of ${wanted} action(s)`;
    } catch (cause) {
      last = cause instanceof Error ? cause.message : String(cause);
    }
    await new Promise((done) => setTimeout(done, 1_000));
  }
  return { ms: Date.now() - from, seen: false, detail: last };
}

/* -------------------------------------------------------------------------- */
/* The run                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The sponsor's own refusal sentences, which are the classification.
 *
 * `sponsorRefusal` produces exactly three, and they are stable API — they are
 * what a user reads on a screen. Matching on them is how a run that was TOLD
 * NO is separated from a run that broke, and that separation is the finding: a
 * refused Passport submits nothing at all, which is the ceiling behaving as
 * designed rather than a fault to be counted as an error.
 */
/**
 * Everything an app error is carrying, not just the sentence.
 *
 * `PassportContractError` and `AccountCustodyError` both split what happened in
 * two: a `message` a user can read — "Your Passport account could not be set
 * up." — and a `code` plus a `detail` holding what actually went wrong. Reading
 * only `message` is how the bench's first N=2 run recorded a real concurrency
 * failure as an unattributable sentence. The user-facing half is deliberately
 * uninformative; a bench that keeps only that half has thrown away its finding.
 */
function describeError(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const parts = [cause.message];
  const extra = cause as { code?: unknown; detail?: unknown; cause?: unknown };
  if (typeof extra.code === 'string') parts.push(`[${extra.code}]`);
  if (typeof extra.detail === 'string' && extra.detail.length > 0) parts.push(extra.detail);
  const nested = extra.cause;
  if (nested instanceof Error && nested.message !== cause.message) {
    parts.push(`← ${nested.message}`);
  }
  return parts.join(' ');
}

function classifyRefusal(message: string): OutcomeEvent['refusalCause'] | undefined {
  if (/cannot cover this one right now/i.test(message)) return 'busy';
  if (/cannot be reached right now/i.test(message)) return 'unreachable';
  if (/no sponsor configured/i.test(message)) return 'disabled';
  return undefined;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  if (config.startAfterMs > 0) {
    await new Promise((done) => setTimeout(done, config.startAfterMs));
  }

  const [
    { addGrantByCommitment, nightColourHex },
    { derivePassportContractSecrets, submitPassportContract },
    { createLocalMidnightWallet },
  ] = await Promise.all([
    import('../../passport-demo/src/identity/accountCustody.js'),
    import('../../passport-demo/src/identity/passportContract.js'),
    import('../../passport-demo/src/lib/localWallet.js'),
  ]);

  const finish = (
    status: OutcomeEvent['status'],
    stage: string,
    extra: Partial<OutcomeEvent> = {},
  ): never => {
    emit({
      kind: 'outcome',
      user: config.user,
      status,
      stage,
      totalMs: Date.now() - startedAt,
      ...extra,
    });
    process.exit(0);
  };

  /* -- the wallet ---------------------------------------------------------- */

  const openedAt = Date.now();
  const seed = randomBytes(32);
  const rootSecret = randomBytes(32);
  let wallet: Awaited<ReturnType<typeof createLocalMidnightWallet>>;
  try {
    wallet = await createLocalMidnightWallet(seed, { resume: 'never' });
  } catch (cause) {
    const detail = describeError(cause);
    span('wallet-open', openedAt, false, detail);
    return finish('failed', 'wallet-open', { detail });
  } finally {
    /* The seed's only job was to open the wallet, and the `finally` is what
       makes that true on the failure path as well. It is never logged, never
       sent to the orchestrator, and never written down. */
    seed.fill(0);
  }
  span('wallet-open', openedAt, true);

  const syncedAt = Date.now();
  try {
    const deadline = syncedAt + 20 * 60_000;
    for (;;) {
      const balances = await wallet.getBalances();
      if (balances.balanceStatus === 'ready' || balances.balanceStatus === 'unavailable') break;
      if (Date.now() > deadline) throw new Error('the wallet never finished syncing');
      await new Promise((done) => setTimeout(done, 2_000));
    }
  } catch (cause) {
    const detail = describeError(cause);
    span('wallet-sync', syncedAt, false, detail);
    await wallet.close().catch(() => undefined);
    return finish('failed', 'wallet-sync', { detail });
  }
  span('wallet-sync', syncedAt, true);

  /* -- the deploy ---------------------------------------------------------- */

  let contractAddress: string | undefined;
  let deployTxId: string | undefined;

  const deployedAt = Date.now();
  try {
    const submission = await submitPassportContract(wallet, rootSecret, (progress) => {
      phase('deploy', progress.phase);
      if (progress.phase === 'confirming' && contractAddress && !pollers.deploy) {
        pollers.deploy = firstSeenInIndexer(
          contractAddress,
          1,
          Date.now(),
          config.indexerTimeoutMs,
        );
      }
    });
    contractAddress = submission.address;
    /* The `confirming` callback fires from inside `settled`, and on a fast
       chain it can arrive before `submitPassportContract` has returned the
       address it needs. Starting the poll here as well covers that ordering;
       whichever starts first wins and the other is never created. */
    pollers.deploy ??= firstSeenInIndexer(
      submission.address,
      1,
      Date.now(),
      config.indexerTimeoutMs,
    );
    const deployment = await submission.settled;
    deployTxId = deployment.deployTxId;
    span('deploy', deployedAt, true);
  } catch (cause) {
    const detail = describeError(cause);
    span('deploy', deployedAt, false, detail);
    await wallet.close().catch(() => undefined);
    const refusalCause = classifyRefusal(detail);
    return finish(refusalCause ? 'refused' : 'failed', 'deploy', {
      detail,
      ...(refusalCause ? { refusalCause } : {}),
      ...(contractAddress ? { contractAddress } : {}),
    });
  }

  if (pollers.deploy) {
    const seen = await pollers.deploy;
    span(
      'deploy-indexer-visible',
      Date.now() - seen.ms,
      seen.seen,
      seen.seen ? undefined : 'never seen',
    );
  }

  /* -- add_grant ----------------------------------------------------------- */

  const { deviceSecret } = await derivePassportContractSecrets(rootSecret);
  const colour = nightColourHex();

  const grantedAt = Date.now();
  let grantTxId: string | undefined;
  try {
    const result = await addGrantByCommitment(
      wallet,
      deviceSecret,
      {
        contractAddress,
        grantCommitment: 1n,
        colourHex: colour,
        cap: 1n,
      },
      (progress) => {
        phase('grant', progress.phase);
        if (progress.phase === 'confirming' && !pollers.grant) {
          pollers.grant = firstSeenInIndexer(
            contractAddress as string,
            2,
            Date.now(),
            config.indexerTimeoutMs,
          );
        }
      },
    );
    grantTxId = result.txId;
    span('grant', grantedAt, true);
  } catch (cause) {
    const detail = describeError(cause);
    span('grant', grantedAt, false, detail);
    await wallet.close().catch(() => undefined);
    const refusalCause = classifyRefusal(detail);
    return finish(refusalCause ? 'refused' : 'failed', 'grant', {
      detail,
      ...(refusalCause ? { refusalCause } : {}),
      contractAddress,
      ...(deployTxId ? { deployTxId } : {}),
    });
  }

  if (pollers.grant) {
    const seen = await pollers.grant;
    span(
      'grant-indexer-visible',
      Date.now() - seen.ms,
      seen.seen,
      seen.seen ? undefined : 'never seen',
    );
  }

  await wallet.close().catch(() => undefined);
  return finish('completed', 'grant', {
    contractAddress,
    ...(deployTxId ? { deployTxId } : {}),
    ...(grantTxId ? { grantTxId } : {}),
  });
}

main().catch((cause) => {
  const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  emit({
    kind: 'outcome',
    user: config.user,
    status: 'failed',
    stage: 'unknown',
    detail,
    totalMs: 0,
  });
  process.exit(1);
});
