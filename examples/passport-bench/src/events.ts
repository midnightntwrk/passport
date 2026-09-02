/**
 * Everything one bench run records, and the wire between the two processes
 * that record it.
 *
 * A virtual user runs in its own child process — see `./worker.ts` for why
 * that is a fidelity requirement and not a convenience — so the facts a run
 * produces arrive from two places and have to be joined afterwards:
 *
 *   * The WORKER knows the shape of the onboarding: when the wallet opened,
 *     when it finished syncing, which phase of a deploy or a grant it is in,
 *     and how it ended. It sends {@link WorkerEvent} over the fork IPC channel.
 *   * The ORCHESTRATOR knows the wire: every HTTP request every worker made,
 *     which endpoint served it, what it answered and how long it took. It sees
 *     those because every worker's sponsor and proving lists point at the
 *     bench's own instrumented proxy (`./proxy.ts`), never at the real hosts.
 *
 * They are joined on `user`, which the proxy reads out of the request path
 * rather than guessing. Under concurrency there is no other honest way to say
 * which of ten Passports a `/prove` belonged to.
 *
 * Nothing in this file carries a seed, a key, a signature, or a transaction
 * body. The proxy records SIZES and STATUS CODES, and — only for a refusal —
 * the first 300 characters of the response, because a refusal's own words are
 * the finding and a sponsor's refusal is not secret. Request bodies are never
 * recorded at all: a `/balance-only` body is a signed transaction.
 */

/** Which endpoint of the ordered list served, by its position and its name. */
export interface UpstreamRef {
  /** `sponsor` or `prover` — which list this endpoint belongs to. */
  role: 'sponsor' | 'prover';
  /** Position in the operator's ordered list. 0 is the first choice. */
  index: number;
  /** A short human name: `balancer`, `gateway`. */
  name: string;
  /** The real URL the proxy forwarded to. */
  url: string;
}

/** One HTTP request, as the bench's proxy saw it. */
export interface HttpEvent {
  kind: 'http';
  /** The virtual user this request belongs to, from the request path. */
  user: string;
  upstream: UpstreamRef;
  method: string;
  /** `/wallet-status`, `/balance-only`, `/prove`, `/check`. */
  path: string;
  /** Milliseconds from the proxy receiving the request to the last body byte. */
  ms: number;
  /** The upstream's status, or `0` when the upstream could not be reached. */
  status: number;
  requestBytes: number;
  responseBytes: number;
  startedAt: number;
  /** A refusal's own words, truncated. Absent for anything that succeeded. */
  refusal?: string;
}

/** A named stretch of a virtual user's run. */
export interface SpanEvent {
  kind: 'span';
  user: string;
  /** `wallet-open`, `wallet-sync`, `deploy`, `grant`, `indexer-visible`, … */
  name: string;
  startedAt: number;
  ms: number;
  ok: boolean;
  /** Free-form, for a failure. Never a key and never a body. */
  detail?: string;
}

/** A phase boundary inside a deploy or a grant, as the app reports it. */
export interface PhaseEvent {
  kind: 'phase';
  user: string;
  /** `deploy` or `grant`. */
  operation: string;
  /** The app's own phase name: `deriving`, `deploying`, `submitting`, … */
  phase: string;
  at: number;
}

/**
 * How one virtual user's onboarding ended.
 *
 * `refused` is deliberately not `failed`. A Passport that is told the sponsor
 * cannot cover it submits NOTHING — no proof, no fee, no transaction — and
 * that is the behaviour at the ceiling rather than a fault. Counting it as an
 * error would hide the one number this bench exists to find.
 */
export interface OutcomeEvent {
  kind: 'outcome';
  user: string;
  status: 'completed' | 'refused' | 'failed';
  /** Which stage it ended at: `wallet-sync`, `deploy`, `grant`. */
  stage: string;
  /** `busy`, `unreachable`, `disabled` — the sponsor's own classification. */
  refusalCause?: string;
  detail?: string;
  /** The account contract, when one was deployed. Public chain state. */
  contractAddress?: string;
  deployTxId?: string;
  grantTxId?: string;
  /** Wall clock for the whole run, from wallet open to the last answer. */
  totalMs: number;
}

/** A worker's own line in the run log, kept out of the terminal. */
export interface LogEvent {
  kind: 'log';
  user: string;
  at: number;
  line: string;
}

export type WorkerEvent = SpanEvent | PhaseEvent | OutcomeEvent | LogEvent;
export type BenchEvent = WorkerEvent | HttpEvent | WatchEvent;

/**
 * One reading of a sponsor's published state, and every transition of it.
 *
 * Taken by the orchestrator DIRECTLY against the real hosts, never through the
 * proxy: a watcher's own probes must not land in the per-user latency figures
 * they exist to explain.
 */
export interface WatchEvent {
  kind: 'watch';
  at: number;
  /** `balancer` or `gateway`. */
  service: string;
  /** `wallet-status` or `status`. */
  probe: string;
  ms: number;
  ok: boolean;
  /** `/wallet-status` only. */
  available?: number;
  unavailableCause?: string | null;
  /** The balancer's `/status` only. */
  dustSpecks?: string;
  balancesServed?: number;
  balancing?: boolean;
  busy?: boolean;
  ready?: boolean;
  healthVerdict?: string;
  healthReason?: string;
  /** The gateway's `/wallet-status` only. */
  pendingTxs?: number;
  detail?: string;
}

/** The configuration one shape of a run was executed with. */
export interface RunConfig {
  label: string;
  shape: 'sequential' | 'concurrent';
  users: number;
  /** The sponsor list, in the operator's order, as real URLs. */
  sponsors: UpstreamRef[];
  /** The proving list, in the operator's order, as real URLs. */
  provers: UpstreamRef[];
  startedAt: number;
  finishedAt: number;
}

/** Everything one shape produced, ready for the report writer. */
export interface RunResult {
  config: RunConfig;
  outcomes: OutcomeEvent[];
  spans: SpanEvent[];
  phases: PhaseEvent[];
  http: HttpEvent[];
  watch: WatchEvent[];
}
