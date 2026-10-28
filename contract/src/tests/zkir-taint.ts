// Forward taint analysis of a compiled ZKIR v3 circuit: does a private input
// reach anything public?
//
// This is an analysis of the compiler's output, not a functional test. It
// complements the functional tests (which show by behaviour that a private
// input changes no public transcript): it reads the circuit the proof server
// proves and follows the input through every instruction, so it also covers
// paths no test case happens to take.
//
// In ZKIR v3 with `do_communications_commitment`, a circuit's inputs and
// outputs enter the proof only through the communications commitment, which
// hides them. What a verifier and the chain see is the public transcript:
// every `impact` instruction (its guard and its inputs: the ledger operations
// and their operands) and every `public_input` (a value read back from the
// ledger, under its guard). Starting from the named inputs, every instruction
// that reads a tainted variable taints the variables it writes. A tainted
// `impact` guard or input, `public_input` guard, or circuit output (the
// `output` instruction, or the top-level outputs) is a disclosure of the
// input. Assertions and selections that only constrain private values are
// reported, never counted as disclosures.
//
//   npx tsx src/tests/zkir-taint.ts <file.zkir> --prefix <input name prefix> [--out file.json]
//   npx tsx src/tests/zkir-taint.ts <file.zkir> --field <param.field...> --info <contract-info.json> [--out file.json]
//
// --field locates a named argument field (for example `auth.offchain`) among
// the circuit's ZKIR inputs from the compiler's contract-info.json, checking
// the argument's whole layout against the ZKIR input list (see fieldInputs).
// Exit code 1 when the input is disclosed, 2 on a usage or layout error.

import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ZkirInstruction { op: string; [k: string]: unknown }
export interface Zkir {
  version?: unknown;
  do_communications_commitment?: boolean;
  inputs: { name: string; type: string }[];
  outputs?: unknown[];
  instructions: ZkirInstruction[];
}

export interface TaintReport {
  inputs: string[];
  communicationsCommitment: boolean | undefined;
  instructions: number;
  taintedVariables: number;
  taintedInstructionsByOp: Record<string, number>;
  impacts: { total: number; tainted: number };
  publicInputs: number;
  sinks: { impactGuard: number; impactInput: number; publicInputGuard: number; output: number };
  /** Asserts whose condition the input reaches (constraints on private
   *  values, not disclosures). */
  asserts: number;
  disclosed: boolean;
}

const OUT_KEYS = new Set(['output', 'outputs']);
const vars = (v: unknown): string[] =>
  typeof v === 'string' && v.startsWith('%') ? [v] : Array.isArray(v) ? v.flatMap(vars) : [];

/** Forward taint from `sources` (ZKIR input names, e.g. `%auth.70`). */
export function taint(z: Zkir, sources: string[]): TaintReport {
  if (sources.length === 0) throw new Error('zkir-taint: no source inputs');
  for (const s of sources) if (!z.inputs.some((i) => i.name === s)) throw new Error(`zkir-taint: ${s} is not an input of this circuit`);
  const tainted = new Set(sources);
  const byOp: Record<string, number> = {};
  const sinks = { impactGuard: 0, impactInput: 0, publicInputGuard: 0, output: 0 };
  const impacts = { total: 0, tainted: 0 };
  let asserts = 0, publicInputs = 0;
  for (const ins of z.instructions) {
    const reads = Object.entries(ins).filter(([k]) => !OUT_KEYS.has(k) && k !== 'op').flatMap(([, v]) => vars(v));
    const hit = reads.some((v) => tainted.has(v));
    if (ins.op === 'impact') {
      impacts.total++;
      if (vars(ins.guard).some((v) => tainted.has(v))) sinks.impactGuard++;
      if (vars(ins.inputs).some((v) => tainted.has(v))) { sinks.impactInput++; impacts.tainted++; }
    }
    if (ins.op === 'public_input') { publicInputs++; if (vars(ins.guard).some((v) => tainted.has(v))) sinks.publicInputGuard++; }
    if (!hit) continue;
    byOp[ins.op] = (byOp[ins.op] ?? 0) + 1;
    if (ins.op === 'assert') asserts++;
    if (ins.op === 'output') sinks.output++;
    for (const [k, v] of Object.entries(ins)) if (OUT_KEYS.has(k)) for (const o of vars(v)) tainted.add(o);
  }
  for (const o of z.outputs ?? []) if (vars(o).concat(vars((o as any)?.name)).some((v) => tainted.has(v))) sinks.output++;
  const disclosed = sinks.impactGuard + sinks.impactInput + sinks.publicInputGuard + sinks.output > 0;
  return {
    inputs: sources, communicationsCommitment: z.do_communications_commitment, instructions: z.instructions.length,
    taintedVariables: tainted.size, taintedInstructionsByOp: byOp, impacts, publicInputs, sinks, asserts, disclosed,
  };
}

// ── Locating an argument field among the ZKIR inputs ────────────────────────
//
// ZKIR names a circuit's inputs `%<argument>.<n>`, one per field element of the
// argument's flattened value, in declaration order. The compiler's
// contract-info.json gives each argument's type, from which the flattened
// layout follows: a Boolean, Uint or Field is one BLS12-381 scalar; Bytes<n>
// is ceil(n / 31) scalars; a Curve25519Point one `Point<Curve25519>` and a
// Curve25519Scalar one `Scalar<Curve25519>`; a Vector repeats its element; a
// Struct concatenates its fields. fieldInputs computes the layout of the named
// argument, requires it to match the argument's ZKIR inputs element by element
// (count and type), and returns the inputs of the named field. Any type it
// does not know, or any mismatch, is an error: it never guesses.

export interface CompactType { 'type-name': string; length?: number; type?: CompactType; elements?: { name: string; type: CompactType }[]; name?: string }
export interface ContractInfo { circuits: { name: string; arguments: { name: string; type: CompactType }[] }[] }

const SCALAR = 'Scalar<BLS12-381>';
function layout(t: CompactType, at: string): { path: string; zkirType: string }[] {
  switch (t['type-name']) {
    case 'Boolean': case 'Uint': case 'Field': return [{ path: at, zkirType: SCALAR }];
    case 'Bytes': return Array.from({ length: Math.ceil((t.length ?? 0) / 31) }, () => ({ path: at, zkirType: SCALAR }));
    case 'Curve25519Point': return [{ path: at, zkirType: 'Point<Curve25519>' }];
    case 'Curve25519Scalar': return [{ path: at, zkirType: 'Scalar<Curve25519>' }];
    case 'Vector': return Array.from({ length: t.length ?? 0 }, (_, i) => layout(t.type!, `${at}[${i}]`)).flat();
    case 'Struct': return (t.elements ?? []).flatMap((e) => layout(e.type, `${at}.${e.name}`));
    default: throw new Error(`zkir-taint: no layout for type ${t['type-name']} at ${at}`);
  }
}

/** The ZKIR inputs of `fieldPath` (`<argument>.<field>[.<field>…]`) of
 *  `circuit`, after checking the argument's layout against the ZKIR. */
export function fieldInputs(info: ContractInfo, z: Zkir, circuit: string, fieldPath: string): string[] {
  const [arg] = fieldPath.split('.');
  const c = info.circuits.find((x) => x.name === circuit);
  if (!c) throw new Error(`zkir-taint: no circuit ${circuit} in the contract info`);
  const a = c.arguments.find((x) => x.name === arg);
  if (!a) throw new Error(`zkir-taint: ${circuit} has no argument ${arg}`);
  const lay = layout(a.type, arg);
  const prefix = `%${arg}.`;
  const group = z.inputs.filter((i) => i.name.startsWith(prefix) && /^\d+$/.test(i.name.slice(prefix.length)));
  if (group.length !== lay.length) throw new Error(`zkir-taint: ${circuit}.${arg} has ${group.length} ZKIR inputs, its type gives ${lay.length}`);
  lay.forEach((l, i) => { if (group[i].type !== l.zkirType) throw new Error(`zkir-taint: ${circuit} ${l.path} is ${group[i].type} in the ZKIR, ${l.zkirType} by its type`); });
  const hits = group.filter((_, i) => lay[i].path === fieldPath || lay[i].path.startsWith(`${fieldPath}.`) || lay[i].path.startsWith(`${fieldPath}[`));
  if (hits.length === 0) throw new Error(`zkir-taint: ${circuit} has no field ${fieldPath}`);
  return hits.map((h) => h.name);
}

// ── Command line ────────────────────────────────────────────────────────────

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [file, ...rest] = process.argv.slice(2);
  const opt = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  try {
    if (!file) throw new Error('usage: zkir-taint.ts <file.zkir> (--prefix <p> | --field <arg.field> --info <contract-info.json>) [--out file.json]');
    const z = JSON.parse(readFileSync(file, 'utf8')) as Zkir;
    let sources: string[];
    if (opt('--field')) {
      const info = JSON.parse(readFileSync(opt('--info') ?? '', 'utf8')) as ContractInfo;
      sources = fieldInputs(info, z, path.basename(file, '.zkir'), opt('--field')!);
    } else {
      const prefix = opt('--prefix') ?? '';
      sources = z.inputs.filter((i) => prefix && i.name.startsWith(prefix)).map((i) => i.name);
    }
    const report = { file, ...taint(z, sources) };
    console.log(JSON.stringify(report));
    if (opt('--out')) writeFileSync(opt('--out')!, JSON.stringify(report, null, 2) + '\n');
    process.exit(report.disclosed ? 1 : 0);
  } catch (e: any) {
    console.error(String(e?.message ?? e));
    process.exit(2);
  }
}
