// Constraint-level negatives — a test-only helper, usable by any suite.
//
// The generated JavaScript of a contract repeats every `assert` of its
// circuits, so a bad call normally aborts during local execution, before
// anything reaches the proof server. A negative that stops there shows that
// the JavaScript checks the rule; it does not show that the PROOF enforces it.
// This helper closes that gap:
//
//   1. loadBypassedContract copies a compiled contract module and replaces its
//      runtime `assert` with one that RECORDS, instead of throwing, the
//      failures of the named assert messages (every other assert still
//      throws). Optionally it also replaces named runtime functions
//      (`overrides`), for example a point validator, so that a degenerate
//      value can reach the transcript. The copy runs only on the client: it
//      builds the witness and the transcript of the bad call, nothing else.
//   2. The call is built with that copy as usual (midnight-js, or the
//      runtime directly), so local execution completes.
//   3. recordingProofProvider sends it to the proof server through a proving
//      provider that records every /check and /prove request with its status
//      and body, without retries, each over its own connection (a reused
//      keep-alive connection can break a large prover-key upload).
//   4. expectRefusal classifies the layer that refused the call:
//        client    a strict client decoder (messages "descriptor: ...",
//                  "blind: ...") before any contract code runs;
//        runtime   the generated JavaScript (a failed assert, a type or range
//                  check) during local execution;
//        decoding  the proof server refused to DECODE the call's inputs or
//                  transcript values (a recognised decoding payload, such as
//                  "... is not in canonical form"). This is the honest proof
//                  server's input check; a malicious prover never runs it, so
//                  it is NOT a constraint of the proof;
//        prover    a constraint of the circuit failed at the proof server (a
//                  recognised constraint payload, such as "Failed direct
//                  assertion");
//        node      the node or ledger refused the submitted transaction.
//
// A proof-server refusal counts as `decoding` or `prover` only when the
// recording provider below recorded the request (HTTP 400) AND its body is a
// recognised proof-server rejection payload (PROOF_SERVER_REJECTIONS, each
// with its source). Any other HTTP status (401, 404, 429, 5xx), an
// unrecognised body, a refusal that no recorded request matches, or a
// transport failure is an ERROR, never a verdict.
//
// Fail-closed: a negative passes only when the expected layer refused it AND
// every bypassed assert fired (otherwise the tampering missed its target); a
// call that goes through is a FAIL; an unreachable or failing proof server,
// indexer, or node (connection errors, timeouts, HTTP errors) is an ERROR,
// never a pass. Run a positive control through the same path first, so that a
// refusal is attributable to the tampering and not to the path: expectRefusal
// can prove the honest call through the same patched module itself
// (`positiveControl`), and it requires such a control for a copy that
// replaces runtime functions (`overrides`), whose honest behaviour is not the
// original's by construction.

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CostModel,
  createCheckPayload,
  createProvingPayload,
  parseCheckResult,
  type ProvingProvider,
} from '@midnightntwrk/ledger-v9';
import { createProofProviderFromHandlers, type ProofProvider } from '@midnight-ntwrk/midnight-js-types';
import { httpClientProvingProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';

// ── 1. A contract module with chosen asserts bypassed ───────────────────────

const RUNTIME_IMPORT = "import * as __compactRuntime from '@midnight-ntwrk/compact-runtime';";
const REGISTRY = Symbol.for('midnight-passport.constraint-negative');

interface BypassState { messages: Set<string>; fired: Map<string, number>; uses: number }
const registry: Map<string, BypassState> = ((globalThis as any)[REGISTRY] ??= new Map());

export interface FiredAssert { message: string; count: number }

/** A positive control that the proof server proved through a patched copy. */
export interface PositiveControlRecord { name: string; startedAt: string; proveRequests: number }

export interface BypassedContractModule {
  /** The patched module's exports (Contract, ledger, pureCircuits, ...). */
  readonly module: any;
  readonly Contract: any;
  readonly ledger: any;
  readonly pureCircuits: any;
  /** The assert messages this copy records instead of throwing. */
  readonly bypassed: readonly string[];
  /** The runtime members this copy replaces (JavaScript source); '' if none. */
  readonly overrides: string;
  /** The bypassed asserts that failed since the last reset. */
  fired(): FiredAssert[];
  resetFired(): void;
  /** How often the copy's code has read its runtime object since it was
   *  loaded: a call executed through this copy raises it, a call executed
   *  through any other module does not. */
  uses(): number;
  /** The positive controls proved through this copy (expectSuccess with
   *  `through`, or expectRefusal with `positiveControl`). */
  positiveControls(): PositiveControlRecord[];
  recordPositiveControl(record: PositiveControlRecord): void;
  /** The patched copy on disk (outside the repository). */
  readonly file: string;
}

export interface LoadBypassedOptions {
  /**
   * Members of the copy's runtime object, as JavaScript source (for example
   * `isValidSecp256k1Point(p) { ... },`), that replace the runtime exports of
   * the same names. They may call the original runtime as
   * `__compactRuntimeOriginal`. They cannot replace `assert` (the bypass is
   * written after them and wins). A copy with overrides does not behave like
   * the original even on honest inputs, so expectRefusal requires a positive
   * control proved through it.
   */
  overrides?: string;
}

/**
 * Loads a copy of the compiled contract module at `contractJs` whose runtime
 * `assert` records, instead of throwing, a failure of any message in
 * `bypass`, and whose runtime members named in `options.overrides` are
 * replaced. Refuses a message that is not an assert message of the module,
 * so a typo cannot silently bypass nothing.
 */
export async function loadBypassedContract(
  contractJs: string, bypass: readonly string[], options: LoadBypassedOptions = {},
): Promise<BypassedContractModule> {
  const source = await readFile(contractJs, 'utf8');
  if (source.split(RUNTIME_IMPORT).length !== 2) {
    throw new Error(`constraint-negative: ${contractJs} does not import the runtime exactly once as expected`);
  }
  for (const m of bypass) {
    if (!source.includes(`'${m}'`) && !source.includes(JSON.stringify(m))) {
      throw new Error(`constraint-negative: no assert message ${JSON.stringify(m)} in ${contractJs}`);
    }
  }
  const overrides = options.overrides ?? '';
  const id = randomUUID();
  const state: BypassState = { messages: new Set(bypass), fired: new Map(), uses: 0 };
  const controls: PositiveControlRecord[] = [];
  registry.set(id, state);
  // The same runtime module instance the original resolves to (one copy is
  // installed), so values cross between the copy and midnight-js unchanged.
  // The proxy counts the copy's reads of its runtime object (uses()).
  const runtimeUrl = import.meta.resolve('@midnight-ntwrk/compact-runtime');
  const prelude = [
    `import * as __compactRuntimeOriginal from ${JSON.stringify(runtimeUrl)};`,
    `const __bypass = globalThis[Symbol.for('midnight-passport.constraint-negative')].get(${JSON.stringify(id)});`,
    'const __compactRuntime = new Proxy(Object.freeze({',
    '  ...__compactRuntimeOriginal,',
    overrides,
    '  assert(condition, message) {',
    '    if (!condition && __bypass.messages.has(message)) {',
    '      __bypass.fired.set(message, (__bypass.fired.get(message) ?? 0) + 1);',
    '      return;',
    '    }',
    '    return __compactRuntimeOriginal.assert(condition, message);',
    '  },',
    '}), { get(target, key) { __bypass.uses++; return target[key]; } });',
  ].join('\n');
  const patched = source.replace(RUNTIME_IMPORT, prelude).replace(/^\/\/# sourceMappingURL=.*$/m, '');
  // .mjs: outside any package.json, a .js file would go through Node's
  // CommonJS detection and load a second runtime instance.
  const dir = await mkdtemp(path.join(tmpdir(), 'constraint-negative-'));
  const file = path.join(dir, 'index.mjs');
  await writeFile(file, patched);
  const module = await import(pathToFileURL(file).href);
  return {
    module,
    Contract: module.Contract,
    ledger: module.ledger,
    pureCircuits: module.pureCircuits,
    bypassed: [...bypass],
    overrides,
    fired: () => [...state.fired].map(([message, count]) => ({ message, count })),
    resetFired: () => state.fired.clear(),
    uses: () => state.uses,
    positiveControls: () => [...controls],
    recordPositiveControl: (record) => { controls.push({ ...record }); },
    file,
  };
}

// ── 3. A proving provider that records every request ────────────────────────

export interface ProofServerRequest {
  endpoint: '/check' | '/prove';
  keyLocation: string;
  startedAt: string;
  ms: number;
  status: number | null;
  ok: boolean;
  /** The response body of a refused request (text, at most 16 kB). */
  body?: string;
  /** The body was longer than 16 kB and was cut: it is never recognised. */
  bodyTruncated?: boolean;
  /** A transport failure (no HTTP status). */
  error?: string;
}

const BODY_LIMIT = 16_384;

/** The proof server answered with an HTTP error status. */
export class ProofServerRefusal extends Error {
  constructor(readonly endpoint: string, readonly keyLocation: string, readonly status: number, readonly body: string) {
    super(`proof server ${endpoint} refused (${status}): ${body.slice(0, 300)}`);
    this.name = 'ProofServerRefusal';
  }
}

/** fetch's own global dispatcher (Node's bundled undici) lives here. */
const FETCH_DISPATCHER = Symbol.for('undici.globalDispatcher.1');

/**
 * A dispatcher for ONE proof-server request: a new connection, never one from
 * fetch's shared pool. fetch keeps idle keep-alive connections, and the proof
 * server (or a forwarder in front of it) may already have closed the one it
 * picks; an upload of a large prover key (hundreds of MB) on such a
 * connection then fails with EPIPE before the proof server sees the request,
 * a transport error with nothing to classify. The dispatcher is an instance
 * of the class of fetch's own dispatcher, so no dependency is added, with
 * keep-alive off; the caller destroys it once the answer has been read. It
 * decides only which connection carries a request.
 */
async function freshConnection(): Promise<{ destroy(): Promise<void> }> {
  // Node creates fetch's dispatcher on first use; a data: URL needs no network.
  if (!(globalThis as any)[FETCH_DISPATCHER]) await fetch('data:,');
  const Dispatcher = (globalThis as any)[FETCH_DISPATCHER]?.constructor;
  if (typeof Dispatcher !== 'function') {
    throw new Error('constraint-negative: cannot reach the class of fetch\'s dispatcher for a fresh connection (not a verdict)');
  }
  return new Dispatcher({ keepAliveTimeout: 1, keepAliveMaxTimeout: 1 });
}

/** A ledger ProvingProvider over a proof server: no retries; every request
 *  goes over its own connection (freshConnection), and every request and its
 *  answer are appended to `log`. */
export function recordingProvingProvider(
  url: string, zkConfigProvider: any, log: ProofServerRequest[], timeoutMs = 600_000,
): ProvingProvider {
  const { lookupKey } = httpClientProvingProvider(url, zkConfigProvider);
  const endpointUrl = (endpoint: string) => {
    const u = new URL(url);
    u.pathname = u.pathname.replace(/\/$/, '') + endpoint;
    return u;
  };
  const post = async (endpoint: '/check' | '/prove', keyLocation: string, payload: Uint8Array): Promise<Uint8Array> => {
    const rec: ProofServerRequest = { endpoint, keyLocation, startedAt: new Date().toISOString(), ms: 0, status: null, ok: false };
    const t0 = Date.now();
    const connection = await freshConnection();
    try {
      let res: Response;
      try {
        res = await fetch(endpointUrl(endpoint), {
          method: 'POST', body: new Uint8Array(payload), headers: { 'Content-Type': 'application/octet-stream' },
          signal: AbortSignal.timeout(timeoutMs), dispatcher: connection,
        } as RequestInit);
      } catch (e: any) {
        rec.ms = Date.now() - t0;
        rec.error = String(e?.cause?.code ?? e?.message ?? e);
        log.push(rec);
        throw e;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      rec.ms = Date.now() - t0;
      rec.status = res.status;
      rec.ok = res.ok;
      if (!res.ok) {
        const text = new TextDecoder().decode(bytes);
        rec.body = text.slice(0, BODY_LIMIT);
        if (text.length > BODY_LIMIT) rec.bodyTruncated = true;
        log.push(rec);
        throw new ProofServerRefusal(endpoint, keyLocation, res.status, rec.body);
      }
      log.push(rec);
      return bytes;
    } finally {
      await connection.destroy().catch(() => undefined);
    }
  };
  return {
    async check(serializedPreimage, keyLocation) {
      const km = await lookupKey(keyLocation);
      return parseCheckResult(await post('/check', keyLocation, createCheckPayload(serializedPreimage, km?.ir)));
    },
    async prove(serializedPreimage, keyLocation, overwriteBindingInput) {
      const km = await lookupKey(keyLocation);
      return post('/prove', keyLocation, createProvingPayload(serializedPreimage, overwriteBindingInput, km));
    },
    lookupKey,
  };
}

/** A midnight-js ProofProvider (current era) over recordingProvingProvider:
 *  substitute it for `providers.proofProvider` to record a call's proving. */
export function recordingProofProvider(url: string, zkConfigProvider: any, log: ProofServerRequest[]): ProofProvider {
  const proving = recordingProvingProvider(url, zkConfigProvider, log);
  return createProofProviderFromHandlers({
    currentEra: (tx) => tx.prove(proving, CostModel.initialCostModel()),
  });
}

// ── 4. Classification ────────────────────────────────────────────────────────

export type RefusalLayer = 'client' | 'runtime' | 'decoding' | 'prover' | 'node';

/** A proof-server rejection payload this helper recognises. The proof
 *  server (9.0.0-rc.8, `WorkError::BadInput`) answers HTTP 400 with the body
 *  "bad input: `<message>`"; `pattern` matches the message. */
export interface RejectionRule {
  name: string;
  /** constraint: a circuit constraint failed (layer `prover`); decoding: the
   *  proof server could not decode an input or transcript value (layer
   *  `decoding`, not a constraint). */
  kind: 'constraint' | 'decoding';
  pattern: RegExp;
  /** Where the message comes from. */
  source: string;
  /** The cases that produce it. */
  seenIn: string;
}

/**
 * The recognised payloads, each with its source in the proof server and the
 * cases that produce it; every rule matches a disjoint set of bodies.
 * Anything else is not a verdict. A new payload is added here only with its
 * source and a case that shows it.
 */
export const PROOF_SERVER_REJECTIONS: readonly RejectionRule[] = Object.freeze([
  {
    name: 'direct-assertion', kind: 'constraint', pattern: /^Failed direct assertion$/,
    source: 'midnight-zkir 3.1.0-rc.1 zkir/src/ir_vm.rs:413-416 (the ZKIR Assert instruction)',
    seenIn: 'every module assert bypassed at runtime (constraint-negative-prover); the arms\' seam asserts',
  },
  {
    name: 'weierstrass-identity-coordinates', kind: 'constraint',
    pattern: /^Cannot extract coordinates of the Secp256k1 identity$/,
    source: 'midnight-zkir 3.1.0-rc.1 zkir/src/ir_instructions/into_coordinates.rs:49-53; in the circuit, '
      + 'into_coordinates_incircuit asserts that the point is not the identity (:109-111)',
    seenIn: 'a secp256k1 key given as the point at infinity (flagged as the identity)',
  },
  {
    name: 'public-transcript-binding', kind: 'constraint',
    pattern: /^Public transcript input mismatch for input \d+; expected: (?:Some\([0-9a-fA-Fx]+\)|None), computed: (?:Some\([0-9a-fA-Fx]+\)|None)$/,
    source: 'midnight-zkir 3.1.0-rc.1 zkir/src/ir_vm.rs:589-622 (Impact: the public inputs the circuit computes '
      + 'differ from the declared public transcript, so no proof binds that transcript)',
    seenIn: 'a transcript that declares an Ethereum address other than the one the circuit computes',
  },
  {
    name: 'input-decoding', kind: 'decoding',
    pattern: /^Failed to decode \[[^\]]*\] as [A-Za-z0-9]+$/,
    source: 'midnight-zkir 3.1.0-rc.1 zkir/src/ir_instructions/encode.rs:237 (decode_offcircuit, on the '
      + 'circuit inputs, ir_vm.rs:246, the public transcript outputs, :438, and the private inputs, :458)',
    seenIn: 'a secp256k1 point (0, 0) not flagged as the identity; a small-order or mixed-order Curve25519Point',
  },
  {
    name: 'non-canonical-encoding', kind: 'decoding',
    pattern: /^The encoded value of type [A-Za-z0-9]+ is not in canonical form: \[[^\]]*\]$/,
    source: 'midnight-zkir 3.1.0-rc.1 zkir/src/ir_instructions/encode.rs:244-251 (the re-encoding check of decode_offcircuit)',
    seenIn: 'an unreduced secp256k1 coordinate (Secp256k1Point); an unreduced Curve25519Point or Curve25519Scalar',
  },
  {
    name: 'bit-bound', kind: 'constraint', pattern: /^Bit bound failed: (?:0x)?[0-9a-fA-F]+ is not \d+-bit$/,
    source: 'midnight-zkir 3.1.0-rc.1 zkir/src/ir_vm.rs:468-470 and :333-335 (the ZKIR ConstrainBits instruction: '
      + 'a value wider than its declared bits; in the circuit, assigned_to_le_bits over that many bits, :1074-1081)',
    seenIn: 'a Uint<8> byte input of 256 or more (the carry attack on a vector of byte inputs)',
  },
]);

/** A refused request whose body is a recognised payload. */
export interface ProofServerRejection {
  endpoint: '/check' | '/prove';
  status: number;
  keyLocation: string;
  kind: RejectionRule['kind'];
  rule: string;
  /** The message inside "bad input: `...`". */
  payload: string;
}

const BAD_INPUT = /^bad input: `([\s\S]*)`$/;

/** The recognised rejection a recorded request carries, or null: HTTP 400,
 *  an untruncated body "bad input: `<message>`", and a message that matches
 *  one of PROOF_SERVER_REJECTIONS. */
export function recogniseRejection(
  req: Pick<ProofServerRequest, 'status' | 'body' | 'bodyTruncated'>,
): { kind: RejectionRule['kind']; rule: string; payload: string } | null {
  if (req.status !== 400 || typeof req.body !== 'string' || req.bodyTruncated) return null;
  const m = BAD_INPUT.exec(req.body);
  if (!m) return null;
  const rule = PROOF_SERVER_REJECTIONS.find((r) => r.pattern.test(m[1]));
  return rule ? { kind: rule.kind, rule: rule.name, payload: m[1] } : null;
}

export interface Classification {
  /** The refusing layer, or `infrastructure` (an ERROR) or `unknown`. */
  layer: RefusalLayer | 'infrastructure' | 'unknown';
  detail: string;
  /** The error's cause chain, outermost first. */
  chain: { name: string; message: string }[];
  /** For `prover` and `decoding`: the recorded request and its payload. */
  rejection?: ProofServerRejection;
}

const errorChain = (e: unknown): any[] => {
  const out: any[] = [];
  let cur: any = e;
  for (let i = 0; cur && i < 10; i++) { out.push(cur); cur = cur.cause ?? cur.error; }
  return out;
};

/** How an error refers to a proof-server response. */
type ProofServerReference =
  | { form: 'object'; endpoint: string; status: number; body: string }
  | { form: 'relayed'; endpoint: string; status: number; snippet: string }
  | { form: 'unrecorded'; status: number; text: string };

function proofServerReference(chain: any[]): ProofServerReference | undefined {
  // The error object itself (also when another copy of this file threw it).
  const direct = chain.find((c) => c instanceof ProofServerRefusal
    || (c?.name === 'ProofServerRefusal' && typeof c?.status === 'number' && typeof c?.body === 'string'));
  if (direct) return { form: 'object', endpoint: String(direct.endpoint), status: direct.status, body: direct.body };
  for (const c of chain) {
    const message = String(c?.message ?? c);
    // The ledger's proving loop crosses a WASM boundary that keeps only the
    // message of the provider's error ("'check' returned an error:
    // ProofServerRefusal: proof server /check refused (400): <body, 300
    // characters at most>").
    const relayed = /proof server (\/check|\/prove) refused \((\d{3})\): ?([\s\S]*)$/i.exec(message);
    if (relayed) return { form: 'relayed', endpoint: relayed[1].toLowerCase(), status: Number(relayed[2]), snippet: relayed[3] };
    // midnight-js's own HTTP provider: it records nothing and keeps no body.
    const standard = /failed proof server response:.*code="(\d+)"/i.exec(message);
    if (standard) return { form: 'unrecorded', status: Number(standard[1]), text: message };
  }
  return undefined;
}

/**
 * The layer an error comes from (see the header). `requests` are the
 * proof-server requests the recording provider logged during the attempt
 * that threw: a proof-server refusal is classified as `prover` or `decoding`
 * only when the last of them is that refusal and carries a recognised
 * payload. Without them, every proof-server refusal is `infrastructure`.
 */
export function classifyRefusal(err: unknown, requests?: readonly ProofServerRequest[]): Classification {
  const chain = errorChain(err);
  const shown = chain.map((c) => ({ name: String(c?.name ?? typeof c), message: String(c?.message ?? c).slice(0, 2000) }));
  const text = shown.map((c) => c.message).join(' | ');
  const lower = text.toLowerCase();
  const infra = (detail: string): Classification => ({ layer: 'infrastructure', detail: detail.slice(0, 1000), chain: shown });

  const ref = proofServerReference(chain);
  if (ref) {
    if (ref.form === 'unrecorded') {
      return infra(`proof-server response ${ref.status} through a provider that records nothing (use recordingProofProvider and pass its log): ${ref.text.slice(0, 300)}`);
    }
    const where = `${ref.endpoint} ${ref.status}`;
    if (!requests) return infra(`proof server ${where}, but no request log was given: not a verdict`);
    const last = requests.at(-1);
    if (!last || last.ok || last.status !== ref.status || last.endpoint !== ref.endpoint) {
      return infra(`proof server ${where}, but the last recorded request is ${last ? `${last.endpoint} ${last.status ?? last.error}` : 'none'}: not a verdict`);
    }
    const body = last.body ?? '';
    const agrees = ref.form === 'object'
      ? ref.body === body
      : ref.snippet.startsWith(body.slice(0, 300)) || body.slice(0, 300).startsWith(ref.snippet);
    if (!agrees) return infra(`proof server ${where}: the recorded body differs from the error's: not a verdict`);
    const rec = recogniseRejection(last);
    if (!rec) {
      return infra(`proof server ${where}: ${body.slice(0, 500)}${last.bodyTruncated ? ' [truncated]' : ''} (not a recognised proof-server rejection: an HTTP or infrastructure failure, never a verdict)`);
    }
    return {
      layer: rec.kind === 'constraint' ? 'prover' : 'decoding',
      detail: `${where}: ${body.slice(0, 500)}`,
      chain: shown,
      rejection: { endpoint: last.endpoint, status: 400, keyLocation: last.keyLocation, ...rec },
    };
  }
  if (/econnrefused|econnreset|enotfound|etimedout|fetch failed|socket hang up|aborterror|timed? ?out|network error/.test(lower)) {
    return infra(text);
  }
  let layer: Classification['layer'] = 'unknown';
  if (chain.some((c) => /^(descriptor|blind): /.test(String(c?.message ?? '')))) layer = 'client';
  else if (chain.some((c) => c?.isCompactError) || /failed assert: |type error: |cast from field or uint value/.test(lower)) layer = 'runtime';
  else if (/custom error:\s*\d+|invalid transaction|submissionerror|malformederror|transaction failed|failentirely|failfallible/.test(lower)) layer = 'node';
  const last = requests?.at(-1);
  if (layer !== 'unknown' && last && !last.ok) {
    return { layer: 'unknown', detail: `a refused proof-server request (${last.endpoint} ${last.status ?? last.error}) was recorded, but the error does not refer to it: ${text.slice(0, 400)}`, chain: shown };
  }
  return { layer, detail: text.slice(0, 500), chain: shown };
}

// ── 2 and 4. Running a negative and its positive control ────────────────────

export type Verdict = 'PASS' | 'FAIL' | 'ERROR';

/** Why a patched copy cannot be used (it was not made by loadBypassedContract
 *  of this version: no use counter, no positive-control record), or null. */
const foreignCopy = (m: BypassedContractModule | undefined): string | null =>
  m && (typeof m.uses !== 'function' || typeof m.positiveControls !== 'function' || typeof m.recordPositiveControl !== 'function')
    ? 'not a verdict: the patched copy was not made by loadBypassedContract (load it there, with { overrides } if it replaces runtime functions)'
    : null;

export interface NegativeResult {
  name: string;
  expectedLayer: RefusalLayer;
  layer: Classification['layer'] | 'none';
  verdict: Verdict;
  reason: string;
  bypassed: readonly string[];
  /** The patched copy carries runtime overrides. */
  overridden: boolean;
  fired: FiredAssert[];
  /** The requests of the negative itself (not of its positive control). */
  proofServer: ProofServerRequest[];
  /** For `prover` and `decoding`: the recognised payload. */
  rejection?: ProofServerRejection;
  /** The positive control proved through the same patched copy, when this
   *  negative ran one (`positiveControl`). */
  positiveControl?: PositiveResult;
  detail?: string;
  chain?: Classification['chain'];
  startedAt: string;
  ms: number;
}

/**
 * Runs `attempt`, which must be refused at `expectedLayer`. PASS only when it
 * is, every assert bypassed by `bypassed` fired, and (with `bypassed`) the
 * call ran through that copy; FAIL when it is refused elsewhere, goes
 * through, misses the copy, or a bypassed assert never fired; ERROR when the
 * infrastructure failed, the refusal cannot be classified, or a required
 * positive control is missing or did not prove.
 *
 * `positiveControl` is the honest call, built with `bypassed` (the same
 * patched copy): it is proved first, and the negative runs only if the proof
 * server proved it (a `/prove` request answered 200) through that copy
 * without any bypassed assert firing. A positive control proved through the
 * copy is required when `requirePositiveControl` is true, which is the
 * default for a copy with runtime overrides; an earlier expectSuccess with
 * `through: bypassed` also counts.
 */
export async function expectRefusal(opts: {
  name: string;
  expectedLayer: RefusalLayer;
  attempt: () => Promise<unknown>;
  bypassed?: BypassedContractModule;
  proofLog?: ProofServerRequest[];
  positiveControl?: () => Promise<unknown>;
  requirePositiveControl?: boolean;
}): Promise<NegativeResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const base = {
    name: opts.name, expectedLayer: opts.expectedLayer, bypassed: opts.bypassed?.bypassed ?? [],
    overridden: Boolean(opts.bypassed?.overrides), startedAt,
  };
  let positiveControl: PositiveResult | undefined;
  let logStart = opts.proofLog?.length ?? 0;
  const finish = (r: Omit<NegativeResult, keyof typeof base | 'fired' | 'proofServer' | 'ms' | 'positiveControl'>): NegativeResult => ({
    ...base, ...r,
    fired: opts.bypassed?.fired() ?? [],
    proofServer: opts.proofLog?.slice(logStart) ?? [],
    ...(positiveControl ? { positiveControl } : {}),
    ms: Date.now() - t0,
  });

  const foreign = foreignCopy(opts.bypassed);
  if (foreign) return finish({ layer: 'none', verdict: 'ERROR', reason: foreign });
  if (opts.positiveControl) {
    if (!opts.bypassed || !opts.proofLog) {
      return finish({ layer: 'none', verdict: 'ERROR', reason: 'not a verdict: a positive control needs the patched copy (bypassed) and the proof log' });
    }
    positiveControl = await expectSuccess({ name: `${opts.name}: positive control`, attempt: opts.positiveControl, proofLog: opts.proofLog, through: opts.bypassed });
    positiveControl = { ...positiveControl, result: undefined };
    if (positiveControl.verdict !== 'PASS' || !positiveControl.through?.proved) {
      logStart = opts.proofLog.length;
      return finish({ layer: 'none', verdict: 'ERROR', reason: `not a verdict: the positive control through this patched copy did not prove (${positiveControl.verdict}: ${positiveControl.reason})` });
    }
  }
  const required = opts.requirePositiveControl ?? Boolean(opts.bypassed?.overrides);
  if (required && !(opts.bypassed?.positiveControls().length)) {
    return finish({ layer: 'none', verdict: 'ERROR', reason: 'not a verdict: no positive control proved through this patched copy' });
  }

  logStart = opts.proofLog?.length ?? 0;
  opts.bypassed?.resetFired();
  const usesBefore = opts.bypassed?.uses() ?? 0;
  try {
    await opts.attempt();
    return finish({ layer: 'none', verdict: 'FAIL', reason: 'the call was NOT refused' });
  } catch (e) {
    const c = classifyRefusal(e, opts.proofLog?.slice(logStart));
    const more = { detail: c.detail, chain: c.chain, ...(c.rejection ? { rejection: c.rejection } : {}) };
    const fired = opts.bypassed?.fired() ?? [];
    const missed = (opts.bypassed?.bypassed ?? []).filter((m) => !fired.some((f) => f.message === m));
    if (c.layer === 'infrastructure' || c.layer === 'unknown') {
      return finish({ layer: c.layer, verdict: 'ERROR', reason: `not a verdict: ${c.layer} failure`, ...more });
    }
    if (c.layer !== opts.expectedLayer) {
      return finish({ layer: c.layer, verdict: 'FAIL', reason: `refused at ${c.layer}, expected ${opts.expectedLayer}`, ...more });
    }
    if (opts.bypassed && opts.bypassed.uses() === usesBefore) {
      return finish({ layer: c.layer, verdict: 'FAIL', reason: 'the call did not run through the patched copy', ...more });
    }
    if (missed.length) {
      return finish({ layer: c.layer, verdict: 'FAIL', reason: `bypassed assert(s) never fired: ${missed.join('; ')}`, ...more });
    }
    return finish({ layer: c.layer, verdict: 'PASS', reason: `refused at ${c.layer}`, ...more });
  }
}

export interface PositiveResult {
  name: string;
  verdict: Verdict;
  reason: string;
  result?: unknown;
  proofServer: ProofServerRequest[];
  /** With `through`: the patched copy, whether the call ran through it, and
   *  whether the proof server proved it (a `/prove` request answered 200). */
  through?: { file: string; usesDelta: number; proved: boolean };
  detail?: string;
  chain?: Classification['chain'];
  startedAt: string;
  ms: number;
}

/**
 * Runs a call that must go through (the positive control of a path). An
 * infrastructure failure is an ERROR; any other refusal a FAIL.
 *
 * With `through` (a patched copy), it is that copy's positive control: the
 * call must run through the copy (else ERROR) without firing any bypassed
 * assert (else FAIL: the call is not honest); when the proof server proved it,
 * the copy records it (positiveControls()).
 */
export async function expectSuccess(opts: {
  name: string;
  attempt: () => Promise<unknown>;
  proofLog?: ProofServerRequest[];
  through?: BypassedContractModule;
}): Promise<PositiveResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const logStart = opts.proofLog?.length ?? 0;
  const foreign = foreignCopy(opts.through);
  if (foreign) return { name: opts.name, verdict: 'ERROR', reason: foreign, proofServer: [], startedAt, ms: 0 };
  opts.through?.resetFired();
  const usesBefore = opts.through?.uses() ?? 0;
  const done = (r: Omit<PositiveResult, 'name' | 'proofServer' | 'startedAt' | 'ms'>): PositiveResult => ({
    name: opts.name, ...r, proofServer: opts.proofLog?.slice(logStart) ?? [], startedAt, ms: Date.now() - t0,
  });
  let result: unknown;
  try {
    result = await opts.attempt();
  } catch (e) {
    const c = classifyRefusal(e, opts.proofLog?.slice(logStart));
    return done({
      verdict: c.layer === 'infrastructure' || c.layer === 'unknown' ? 'ERROR' : 'FAIL',
      reason: `refused at ${c.layer}`, detail: c.detail, chain: c.chain,
    });
  }
  if (!opts.through) return done({ verdict: 'PASS', reason: 'went through', result });
  const requests = opts.proofLog?.slice(logStart) ?? [];
  const proveRequests = requests.filter((r) => r.endpoint === '/prove' && r.ok).length;
  const through = { file: opts.through.file, usesDelta: opts.through.uses() - usesBefore, proved: proveRequests > 0 };
  const fired = opts.through.fired();
  if (fired.length) {
    return done({ verdict: 'FAIL', reason: `a bypassed assert fired (${fired.map((f) => f.message).join('; ')}): the call is not honest, so it is no positive control`, through });
  }
  if (through.usesDelta === 0) {
    return done({ verdict: 'ERROR', reason: 'not a verdict: the call did not run through the patched copy', through });
  }
  if (through.proved) opts.through.recordPositiveControl({ name: opts.name, startedAt, proveRequests });
  return done({ verdict: 'PASS', reason: through.proved ? 'went through; proved through the patched copy' : 'went through the patched copy (not proved)', result, through });
}
