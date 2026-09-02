/**
 * The orchestrator: preflight, shapes, workers, and the results file.
 *
 * WHAT IT WILL AND WILL NOT SPEND
 * -------------------------------
 * Nothing touches stagenet without `--confirm-live`. Without it the bench does
 * its preflight — probing each named endpoint's `/wallet-status`, checking the
 * ZK artefacts are staged, printing the plan and the transaction ceiling it
 * implies — and stops. That is a useful command in its own right and it is the
 * default, because the alternative default spends real DUST on a typo.
 *
 * With it, the spend is still bounded twice over. `--accounts` caps the total
 * number of virtual users across every shape in the invocation, and each user
 * submits AT MOST two transactions — one contract deploy and one `add_grant`.
 * A user that is refused by the sponsor submits neither, so the ceiling is an
 * upper bound and the real figure is usually lower. The bench prints both
 * before it starts and the transaction count it actually reached at the end.
 *
 * THE THREE THINGS THAT NEVER HAPPEN
 * ----------------------------------
 *  1. No `.night` name is claimed. One sponsored name per Passport, the slots
 *     are finite, and they are Midnames registry state. `/register-alias` is
 *     not called by anything here.
 *  2. Nothing spends from the balancer's own wallet. Its NIGHT UTxOs are what
 *     back its DUST generation; a bench that could take one down is a bench
 *     that can break the service it is measuring.
 *  3. No value moves. `add_grant` registers a spending allowance against an
 *     account that holds nothing.
 *
 * WHY THE SHAPES ARE RUN IN ONE PROCESS AND THE USERS ARE NOT
 * ----------------------------------------------------------
 * The watcher has to run continuously across the whole session, because the
 * DUST price of a transaction is only measurable against a stretch with no
 * spend in it — see `./report.ts`. The cool-down between shapes is therefore
 * not politeness towards the balancer, though it is that too; it is where the
 * generation rate is measured.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serveArtefacts } from './artefacts.js';
import { startProxy } from './proxy.js';
import { startWatcher } from './watcher.js';
import { renderReport } from './report.js';
import type {
  BenchEvent,
  HttpEvent,
  OutcomeEvent,
  PhaseEvent,
  RunResult,
  SpanEvent,
  UpstreamRef,
  WatchEvent,
  WorkerEvent,
} from './events.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DEMO = resolve(ROOT, '..', 'passport-demo');

/* -------------------------------------------------------------------------- */
/* The named endpoints                                                        */
/* -------------------------------------------------------------------------- */

interface EndpointDefinition {
  name: string;
  sponsor: string;
  prover: string;
  /** Whether this host serves `GET /status`. Ours does; the 1AM gateway does not. */
  hasStatus: boolean;
}

/**
 * The deployed configuration, as `deploy:passport:manual` writes it. Kept here
 * rather than read from an environment file so that a bench run states what it
 * measured, and overridable with `--define` so a run against something else
 * says so on its own command line.
 */
const DEFAULT_ENDPOINTS: EndpointDefinition[] = [
  {
    name: 'balancer',
    sponsor: 'https://67-205-177-162.sslip.io/balancer',
    prover: 'https://67-205-177-162.sslip.io/prover',
    hasStatus: true,
  },
  {
    name: 'gateway',
    sponsor: 'https://api-stagenet.1am.xyz',
    prover: 'https://api-stagenet.1am.xyz',
    hasStatus: false,
  },
];

const DEFAULT_INDEXER = 'https://indexer.stagenet.shielded.tools/api/v4/graphql';
const DEFAULT_NODE = 'wss://rpc.stagenet.shielded.tools';
const DEFAULT_NETWORK = 'stagenet';

/* -------------------------------------------------------------------------- */
/* Flags                                                                      */
/* -------------------------------------------------------------------------- */

interface ShapeSpec {
  mode: 'sequential' | 'concurrent';
  users: number;
  endpoints: string[];
  label: string;
}

interface Options {
  confirmLive: boolean;
  /**
   * Rebuild a report from a recorded event stream instead of running anything.
   *
   * The events file is the whole of what a run observed, so a better table or a
   * new derived figure should never cost another sixty transactions. The
   * `--shape` flags have to be repeated because a shape's MODE and label are
   * the operator's description of the run, not something the events carry; the
   * mapping from user to shape is carried, in the user tag.
   */
  renderFrom?: string;
  accounts: number;
  shapes: ShapeSpec[];
  endpoints: EndpointDefinition[];
  indexerUrl: string;
  nodeUrl: string;
  networkId: string;
  staggerMs: number;
  cooldownMs: number;
  walletStatusIntervalMs: number;
  statusIntervalMs: number;
  indexerTimeoutMs: number;
  outDirectory: string;
}

const USAGE = `
passport-bench — how many concurrent Passports the sponsored onboarding path can serve.

  node dist/bench.mjs [--confirm-live] [flags]

  --confirm-live          Actually submit to stagenet. Without it, preflight only.
  --accounts <n>          Cap on virtual users across every shape. Default 10.
                          Each user submits at most 2 transactions (deploy, add_grant).
  --shape <m:n:list>      Repeatable. m is "sequential" or "concurrent", n is the
                          number of users, list is a comma-separated endpoint list in
                          the operator's own order. Default:
                            sequential:1:balancer
  --define <name=s,p>     Redefine a named endpoint: sponsor URL, then prover URL.
  --stagger-ms <n>        Delay between concurrent users' starts. Default 0.
  --cooldown-ms <n>       Quiet between shapes. This is where the DUST generation
                          rate is measured, so it is not optional. Default 45000.
  --wallet-status-ms <n>  Watcher rate for GET /wallet-status. Default 1000.
  --status-ms <n>         Watcher rate for GET /status. Default 5000.
  --indexer-timeout <n>   Cap on the submit-to-visibility poll. Default 180000.
  --render <events.ndjson>
                          Rebuild the report from a recorded run instead of running
                          one. Repeat the same --shape flags the run used; the
                          mapping from user to shape comes out of the events.
  --out <dir>             Where the results go. Default ./results.
  --help
`;

function parseOptions(argv: readonly string[]): Options {
  const endpoints = DEFAULT_ENDPOINTS.map((endpoint) => ({ ...endpoint }));
  const shapes: ShapeSpec[] = [];
  const options: Options = {
    confirmLive: false,
    accounts: 10,
    shapes,
    endpoints,
    indexerUrl: DEFAULT_INDEXER,
    nodeUrl: DEFAULT_NODE,
    networkId: DEFAULT_NETWORK,
    staggerMs: 0,
    cooldownMs: 45_000,
    walletStatusIntervalMs: 1_000,
    statusIntervalMs: 5_000,
    indexerTimeoutMs: 180_000,
    outDirectory: resolve(ROOT, 'results'),
  };

  const next = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    switch (flag) {
      case '--help':
      case '-h':
        console.log(USAGE);
        process.exit(0);
        break;
      case '--confirm-live':
        options.confirmLive = true;
        break;
      case '--render':
        options.renderFrom = resolve(process.cwd(), next(index, flag));
        index += 1;
        break;
      case '--accounts':
        options.accounts = Number(next(index, flag));
        index += 1;
        break;
      case '--shape': {
        const [mode, users, list] = next(index, flag).split(':');
        if (mode !== 'sequential' && mode !== 'concurrent') {
          throw new Error(`a shape's mode must be sequential or concurrent, not ${mode}`);
        }
        const count = Number(users);
        if (!Number.isInteger(count) || count < 1) {
          throw new Error(`a shape's user count must be a positive integer, not ${users}`);
        }
        const names = (list ?? 'balancer').split(',').filter(Boolean);
        shapes.push({
          mode,
          users: count,
          endpoints: names,
          label: `${mode} N=${count}, ${names.join('→')}`,
        });
        index += 1;
        break;
      }
      case '--define': {
        const [name, urls] = next(index, flag).split('=');
        const [sponsor, prover] = (urls ?? '').split(',');
        if (!name || !sponsor || !prover) {
          throw new Error('--define takes <name>=<sponsor-url>,<prover-url>');
        }
        const existing = endpoints.find((endpoint) => endpoint.name === name);
        if (existing) {
          existing.sponsor = sponsor;
          existing.prover = prover;
        } else {
          endpoints.push({ name, sponsor, prover, hasStatus: false });
        }
        index += 1;
        break;
      }
      case '--stagger-ms':
        options.staggerMs = Number(next(index, flag));
        index += 1;
        break;
      case '--cooldown-ms':
        options.cooldownMs = Number(next(index, flag));
        index += 1;
        break;
      case '--wallet-status-ms':
        options.walletStatusIntervalMs = Number(next(index, flag));
        index += 1;
        break;
      case '--status-ms':
        options.statusIntervalMs = Number(next(index, flag));
        index += 1;
        break;
      case '--indexer-timeout':
        options.indexerTimeoutMs = Number(next(index, flag));
        index += 1;
        break;
      case '--out':
        options.outDirectory = resolve(process.cwd(), next(index, flag));
        index += 1;
        break;
      default:
        throw new Error(`unknown flag ${flag}`);
    }
  }

  if (shapes.length === 0) {
    shapes.push({
      mode: 'sequential',
      users: 1,
      endpoints: ['balancer'],
      label: 'sequential N=1, balancer',
    });
  }

  for (const shape of shapes) {
    for (const name of shape.endpoints) {
      if (!endpoints.some((endpoint) => endpoint.name === name)) {
        throw new Error(`shape "${shape.label}" names an endpoint that is not defined: ${name}`);
      }
    }
  }

  /* The cap is a SPEND cap, so it does not apply to a re-render: reading a
     recorded run back does not submit anything, and making somebody restate a
     ceiling to redraw a table they already paid for is the kind of friction
     that gets a safety check disabled. */
  const planned = shapes.reduce((total, shape) => total + shape.users, 0);
  if (!options.renderFrom && planned > options.accounts) {
    throw new Error(
      `the shapes ask for ${planned} virtual users but --accounts is ${options.accounts}. ` +
        'Raise the cap deliberately or ask for fewer users.',
    );
  }

  return options;
}

/* -------------------------------------------------------------------------- */
/* Preflight                                                                  */
/* -------------------------------------------------------------------------- */

async function preflight(options: Options): Promise<boolean> {
  let ready = true;

  const zk = resolve(DEMO, 'public', 'zk', 'account');
  if (!existsSync(zk)) {
    console.error(
      `[preflight] the account contract's ZK artefacts are not staged at ${zk}.\n` +
        '            Run `npm run prepare:zk --workspace passport-demo` first.',
    );
    ready = false;
  } else {
    console.log('[preflight] ZK artefacts staged');
  }

  const wanted = new Set(options.shapes.flatMap((shape) => shape.endpoints));
  for (const endpoint of options.endpoints.filter((candidate) => wanted.has(candidate.name))) {
    /* Probed more than once, because `available: 0` is TRANSIENT BY DESIGN. A
       sponsor that is mid-transaction reports `PENDING_TRANSACTION` or
       `INSUFFICIENT_DUST` for the tens of seconds that transaction is settling,
       and refusing to start a run on one unlucky sample would make the bench
       hardest to run at exactly the times it is most worth running. Three
       spaced probes; one `available: 1` among them is enough. */
    let available = false;
    for (let attempt = 0; attempt < 3 && !available; attempt += 1) {
      if (attempt > 0) await new Promise((done) => setTimeout(done, 5_000));
      const started = Date.now();
      try {
        const response = await fetch(`${endpoint.sponsor}/wallet-status`, {
          signal: AbortSignal.timeout(15_000),
        });
        const body = (await response.json()) as {
          available?: number;
          wallets?: Array<{ unavailableCause?: string | null }>;
        };
        const cause = body.wallets?.[0]?.unavailableCause ?? null;
        console.log(
          `[preflight] ${endpoint.name} sponsor: available=${body.available} ` +
            `${cause ? `(${cause}) ` : ''}in ${Date.now() - started} ms`,
        );
        available = body.available === 1;
      } catch (cause) {
        console.error(
          `[preflight] ${endpoint.name} sponsor unreachable: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
      }
    }
    if (!available) {
      console.error(`[preflight] ${endpoint.name} never reported available=1 in three probes`);
      ready = false;
    }
  }

  const planned = options.shapes.reduce((total, shape) => total + shape.users, 0);
  console.log(
    `[preflight] plan: ${options.shapes.length} shape(s), ${planned} virtual user(s), ` +
      `at most ${planned * 2} transaction(s). Cap --accounts ${options.accounts}.`,
  );
  for (const shape of options.shapes) console.log(`[preflight]   ${shape.label}`);
  return ready;
}

/* -------------------------------------------------------------------------- */
/* Running one shape                                                          */
/* -------------------------------------------------------------------------- */

interface Collected {
  spans: SpanEvent[];
  phases: PhaseEvent[];
  outcomes: OutcomeEvent[];
  http: HttpEvent[];
}

function upstreamsFor(
  options: Options,
  names: readonly string[],
): { sponsors: UpstreamRef[]; provers: UpstreamRef[] } {
  const chosen = names.map(
    (name) => options.endpoints.find((endpoint) => endpoint.name === name) as EndpointDefinition,
  );
  return {
    sponsors: chosen.map((endpoint, index) => ({
      role: 'sponsor' as const,
      index,
      name: endpoint.name,
      url: endpoint.sponsor.replace(/\/+$/, ''),
    })),
    provers: chosen.map((endpoint, index) => ({
      role: 'prover' as const,
      index,
      name: endpoint.name,
      url: endpoint.prover.replace(/\/+$/, ''),
    })),
  };
}

async function runOneUser(
  workerPath: string,
  config: Record<string, unknown>,
  onEvent: (event: WorkerEvent) => void,
): Promise<void> {
  return new Promise<void>((done) => {
    const child: ChildProcess = fork(workerPath, [JSON.stringify(config)], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      /* A wallet plus the ledger wasm is not a small heap, and ten of them at
         once on a default limit is where a bench starts measuring its own
         garbage collector. */
      execArgv: ['--max-old-space-size=3072'],
    });

    const user = String(config.user);
    const pipe = (stream: NodeJS.ReadableStream | null, tag: string): void => {
      if (!stream) return;
      let buffer = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim().length > 0) {
            onEvent({ kind: 'log', user, at: Date.now(), line: `${tag} ${line}`.slice(0, 2_000) });
          }
        }
      });
    };
    pipe(child.stdout, '[out]');
    pipe(child.stderr, '[err]');

    child.on('message', (message) => onEvent(message as WorkerEvent));
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        onEvent({ kind: 'log', user, at: Date.now(), line: `[exit] worker exited ${code}` });
      }
      done();
    });
  });
}

/* -------------------------------------------------------------------------- */
/* The session                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Rebuilds the runs of a recorded session from its event stream.
 *
 * The only join it needs is already in the data: a worker is tagged
 * `s<shape>u<index>`, so which shape an event belongs to is read rather than
 * inferred. Watch events carry no user, so they are partitioned by time — with
 * each slice reaching back across the preceding cool-down, exactly as a live
 * run does, because that is where the DUST generation rate is measured.
 */
async function renderRecorded(options: Options): Promise<void> {
  const raw = await readFile(options.renderFrom as string, 'utf8');
  const events: BenchEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line) as BenchEvent);
    } catch {
      console.warn('[render] skipped a line that was not JSON');
    }
  }

  const watch = events.filter((event): event is WatchEvent => event.kind === 'watch');
  const shapeOf = (user: string): number => Number(/^s(\d+)u/.exec(user)?.[1] ?? -1);
  const runs: RunResult[] = [];

  for (const [position, shape] of options.shapes.entries()) {
    const mine = events.filter(
      (event) => event.kind !== 'watch' && shapeOf((event as { user: string }).user) === position,
    );
    if (mine.length === 0) {
      console.warn(`[render] no events for shape ${position} (${shape.label})`);
      continue;
    }
    const times = mine.map((event) =>
      event.kind === 'http'
        ? event.startedAt
        : event.kind === 'span'
          ? event.startedAt
          : event.kind === 'phase' || event.kind === 'log'
            ? event.at
            : 0,
    );
    const startedAt = Math.min(...times.filter((time) => time > 0));
    const finishedAt = Math.max(
      ...mine.map((event) =>
        event.kind === 'http'
          ? event.startedAt + event.ms
          : event.kind === 'span'
            ? event.startedAt + event.ms
            : event.kind === 'phase' || event.kind === 'log'
              ? event.at
              : 0,
      ),
    );
    const { sponsors, provers } = upstreamsFor(options, shape.endpoints);
    runs.push({
      config: {
        label: shape.label,
        shape: shape.mode,
        users: shape.users,
        sponsors,
        provers,
        startedAt,
        finishedAt,
      },
      outcomes: mine.filter((event): event is OutcomeEvent => event.kind === 'outcome'),
      spans: mine.filter((event): event is SpanEvent => event.kind === 'span'),
      phases: mine.filter((event): event is PhaseEvent => event.kind === 'phase'),
      http: mine.filter((event): event is HttpEvent => event.kind === 'http'),
      watch: watch.filter(
        (event) => event.at >= startedAt - options.cooldownMs && event.at <= finishedAt + 5_000,
      ),
    });
  }

  await mkdir(options.outDirectory, { recursive: true });
  const date = new Date(runs[0]?.config.startedAt ?? Date.now()).toISOString().slice(0, 10);
  const reportPath = resolve(options.outDirectory, `${date}.md`);
  await writeFile(
    reportPath,
    renderReport({
      date,
      runs,
      invocation: ['node dist/bench.mjs', ...process.argv.slice(2)].join(' '),
      sessionWatch: watch,
      notes: notesFor(runs),
    }),
    'utf8',
  );
  console.log(`[render] ${reportPath}`);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

  if (options.renderFrom) {
    await renderRecorded(options);
    process.exit(0);
  }

  const ready = await preflight(options);

  if (!options.confirmLive) {
    console.log(
      '\n[bench] preflight only — nothing was submitted. Add --confirm-live to run against stagenet.',
    );
    process.exit(ready ? 0 : 1);
  }
  if (!ready) {
    console.error('\n[bench] preflight failed. Refusing to spend against a sponsor that cannot pay.');
    process.exit(1);
  }

  await mkdir(options.outDirectory, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const logPath = resolve(options.outDirectory, `${date}.log`);
  const eventsPath = resolve(options.outDirectory, `${date}.events.ndjson`);
  const reportPath = resolve(options.outDirectory, `${date}.md`);

  const record = async (event: BenchEvent): Promise<void> => {
    await appendFile(eventsPath, `${JSON.stringify(event)}\n`).catch(() => undefined);
  };

  /* -- the watcher, running for the whole session -------------------------- */

  const watch: WatchEvent[] = [];
  const watcher = startWatcher({
    targets: options.endpoints
      .filter((endpoint) =>
        options.shapes.some((shape) => shape.endpoints.includes(endpoint.name)),
      )
      .map((endpoint) => ({
        name: endpoint.name,
        url: endpoint.sponsor.replace(/\/+$/, ''),
        hasStatus: endpoint.hasStatus,
      })),
    walletStatusIntervalMs: options.walletStatusIntervalMs,
    statusIntervalMs: options.statusIntervalMs,
    onEvent: (event) => {
      watch.push(event);
      void record(event);
    },
  });

  const artefacts = await serveArtefacts(resolve(DEMO, 'public'));
  console.log(`[bench] ZK artefacts on ${artefacts.origin}`);

  const workerPath = resolve(HERE, 'worker.mjs');
  const runs: RunResult[] = [];

  /* A quiet stretch BEFORE the first shape, so the DUST generation rate has
     somewhere to be measured even for the first run. */
  console.log(`[bench] settling for ${Math.round(options.cooldownMs / 1_000)} s before the first shape`);
  await new Promise((done) => setTimeout(done, options.cooldownMs));

  for (const [position, shape] of options.shapes.entries()) {
    const { sponsors, provers } = upstreamsFor(options, shape.endpoints);
    const collected: Collected = { spans: [], phases: [], outcomes: [], http: [] };

    const proxy = await startProxy({
      sponsors,
      provers,
      onRequest: (event) => {
        collected.http.push(event);
        void record(event);
      },
    });

    const onEvent = (event: WorkerEvent): void => {
      void record(event);
      switch (event.kind) {
        case 'span':
          collected.spans.push(event);
          console.log(`[${event.user}] ${event.name} ${event.ok ? '' : 'FAILED '}${event.ms} ms`);
          break;
        case 'phase':
          collected.phases.push(event);
          break;
        case 'outcome':
          collected.outcomes.push(event);
          console.log(
            `[${event.user}] ${event.status.toUpperCase()} at ${event.stage}` +
              `${event.refusalCause ? ` (${event.refusalCause})` : ''} after ${Math.round(
                event.totalMs / 1_000,
              )} s`,
          );
          if (event.detail) console.log(`[${event.user}]   ${event.detail.slice(0, 200)}`);
          break;
        case 'log':
          void appendFile(logPath, `${new Date(event.at).toISOString()} ${event.user} ${event.line}\n`).catch(
            () => undefined,
          );
          break;
      }
    };

    console.log(`\n[bench] ── ${shape.label} ──`);
    const startedAt = Date.now();

    const configFor = (user: string, startAfterMs: number): Record<string, unknown> => ({
      user,
      sponsorList: proxy.listFor(user, 'sponsor'),
      proverList: proxy.listFor(user, 'prover'),
      zkOrigin: artefacts.origin,
      indexerUrl: options.indexerUrl,
      nodeUrl: options.nodeUrl,
      networkId: options.networkId,
      startAfterMs,
      indexerTimeoutMs: options.indexerTimeoutMs,
    });

    const tag = (index: number): string => `s${position}u${String(index).padStart(2, '0')}`;

    if (shape.mode === 'sequential') {
      for (let index = 0; index < shape.users; index += 1) {
        await runOneUser(workerPath, configFor(tag(index), 0), onEvent);
      }
    } else {
      await Promise.all(
        Array.from({ length: shape.users }, (_unused, index) =>
          runOneUser(workerPath, configFor(tag(index), index * options.staggerMs), onEvent),
        ),
      );
    }

    const finishedAt = Date.now();
    await proxy.close();

    /* The watch slice reaches BACK across the preceding cool-down. That is
       where the generation rate is measured, and a slice that began with the
       first user would contain no quiet stretch at all. */
    const from = startedAt - options.cooldownMs;
    runs.push({
      config: {
        label: shape.label,
        shape: shape.mode,
        users: shape.users,
        sponsors,
        provers,
        startedAt,
        finishedAt,
      },
      outcomes: collected.outcomes,
      spans: collected.spans,
      phases: collected.phases,
      http: collected.http,
      watch: watch.filter((event) => event.at >= from && event.at <= finishedAt + 5_000),
    });

    if (position < options.shapes.length - 1) {
      console.log(`[bench] cooling down ${Math.round(options.cooldownMs / 1_000)} s`);
      await new Promise((done) => setTimeout(done, options.cooldownMs));
    }
  }

  /* A quiet tail, so the last shape's generation rate is measurable too. */
  await new Promise((done) => setTimeout(done, options.cooldownMs));
  watcher.stop();
  await artefacts.close();

  const invocation = ['node dist/bench.mjs', ...process.argv.slice(2)].join(' ');
  const report = renderReport({
    date,
    runs,
    invocation,
    sessionWatch: watch,
    notes: notesFor(runs),
  });
  await writeFile(reportPath, report, 'utf8');
  console.log(`\n[bench] ${reportPath}`);
  console.log(`[bench] ${logPath}`);
  console.log(`[bench] ${eventsPath}`);
  process.exit(0);
}

/**
 * What the run could not answer, stated rather than extrapolated.
 *
 * A bench that never reached a refusal has not found a ceiling; it has found
 * that the ceiling is above where it looked. Saying so is the difference
 * between a measurement and a guess, and the guess is the one that gets
 * believed at Token.
 */
function notesFor(runs: readonly RunResult[]): string[] {
  const notes: string[] = [];
  const refused = runs.filter((run) => run.outcomes.some((outcome) => outcome.status === 'refused'));
  const largest = runs.reduce((most, run) => Math.max(most, run.config.users), 0);
  if (refused.length === 0) {
    notes.push(
      `No shape reached a refusal. The largest concurrency tried was N=${largest}, so the ` +
        'ceiling is somewhere above that and this run does not say where.',
    );
  }
  const failed = runs.flatMap((run) =>
    run.outcomes.filter((outcome) => outcome.status === 'failed'),
  );
  if (failed.length > 0) {
    notes.push(
      `${failed.length} user(s) ended in \`failed\` rather than \`refused\` — an error the bench ` +
        'could not attribute to the sponsor’s own refusal vocabulary. Those are in the run log ' +
        'and should be read before any of the timings above are trusted.',
    );
  }
  notes.push(
    'A refused virtual user gives up; a real one can press the button again. Every “refused” here ' +
      'is therefore a first attempt that failed, not a Passport that could never be created — the ' +
      'refusal rate says what a burst feels like, and the service rate says what a queue would ' +
      'drain at. Neither is a count of people who would go home.',
  );
  notes.push(
    'Every virtual user here is a Node process running the app’s wiring, not a browser. It does ' +
      'not prove in-tab, it does not carry a passkey ceremony, and it does not pay the cost of a ' +
      'PWA’s first load. The onboarding a real user sees is this plus those.',
  );
  notes.push(
    'The bench deploys a contract and calls one circuit. A real onboarding also registers a ' +
      '`.night` name and takes an activation grant, and those two run through `/register-alias` ' +
      'and `/fund-account`, which exist on our balancer alone — no second provider, and capped in ' +
      'the balancer’s own configuration at 20 and 30 per rolling hour. Nothing here measured them, ' +
      'and for a day of Token they are the tighter constraint.',
  );
  notes.push(
    'The bench runs from one machine on one network. It measures what the SERVICES do under ' +
      'concurrency; it does not measure what a conference Wi-Fi network does to 200 browsers.',
  );
  return notes;
}

main().catch((cause) => {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(1);
});
