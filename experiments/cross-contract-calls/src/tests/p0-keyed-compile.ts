// P0 — keyed compile of the toy pair (no --skip-zk).
//
// Every prior cross-contract artefact in this workspace was compiled with
// --skip-zk, whose expectedVk export is {} — vacuous for the two guards the
// live legs depend on: the runtime's implementation-binding check compares
// sha256(deployed verifier key) against the callee module's expectedVk
// fingerprint, and transaction assembly asserts every invoked operation
// carries its deployed verifier key. P0 therefore compiles Tally and Caller
// WITH real proving keys and records what that costs and produces:
//
//   - compile wall time per contract;
//   - per-circuit prover/verifier key sizes;
//   - ZKIR version and the do_communications_commitment flag (the default
//     compile must emit the commitment, or the contract cannot be a callee);
//   - the expectedVk fingerprint map (must be non-empty for both);
//   - the caller artefact's recorded dependency on the Tally contract type.
//
// Chainless: no devnet needed. Recompiling is idempotent, so P0 always
// compiles from scratch for an honest wall-time measurement.

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { runScenario, step } from './runner.js';
import { writeEvidence, serialiseError } from './evidence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const MANAGED = path.join(ROOT, 'contracts', 'managed');

const TOOLCHAIN = '+0.34.0';

interface CompileRun {
  command: string;
  wallMs: number;
  output: string;
}

function compile(command: string): CompileRun {
  const t0 = performance.now();
  const output = execSync(command, { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { command, wallMs: Math.round(performance.now() - t0), output: output.trim() };
}

/** The expectedVk map the compiler emitted into the generated module. */
function expectedVkOf(artefactDir: string): Record<string, string> {
  const source = fs.readFileSync(path.join(artefactDir, 'contract', 'index.js'), 'utf-8');
  const match = source.match(/export const expectedVk = \{([^}]*)\}/);
  if (!match) throw new Error(`no expectedVk export in ${artefactDir}`);
  const map: Record<string, string> = {};
  for (const entry of match[1].matchAll(/'([^']+)':\s*'([0-9a-f]+)'/g)) {
    map[entry[1]] = entry[2];
  }
  return map;
}

interface CircuitArtefact {
  proverKeyBytes: number;
  verifierKeyBytes: number;
  zkirVersion: string;
  communicationsCommitment: boolean;
}

function circuitArtefacts(artefactDir: string, circuits: string[]): Record<string, CircuitArtefact> {
  const out: Record<string, CircuitArtefact> = {};
  for (const c of circuits) {
    const zkir = JSON.parse(fs.readFileSync(path.join(artefactDir, 'zkir', `${c}.zkir`), 'utf-8'));
    out[c] = {
      proverKeyBytes: fs.statSync(path.join(artefactDir, 'keys', `${c}.prover`)).size,
      verifierKeyBytes: fs.statSync(path.join(artefactDir, 'keys', `${c}.verifier`)).size,
      zkirVersion: `${zkir.version?.major}.${zkir.version?.minor}`,
      communicationsCommitment: zkir.do_communications_commitment === true,
    };
  }
  return out;
}

function contractInfo(artefactDir: string): any {
  return JSON.parse(fs.readFileSync(path.join(artefactDir, 'compiler', 'contract-info.json'), 'utf-8'));
}

await runScenario('p0-keyed-compile', async () => {
  const details: Record<string, unknown> = {};

  step('toolchain identity');
  const version = execSync(`compact compile ${TOOLCHAIN} --version`, { encoding: 'utf-8' }).trim();
  details.toolchain = version;
  console.log(`  ${version}`);

  step('keyed compile: Tally (the callee — compiled first, by name, to contracts/managed/Tally)');
  let tallyRun: CompileRun;
  let callerRun: CompileRun;
  try {
    tallyRun = compile(`compact compile ${TOOLCHAIN} contracts/tally.compact contracts/managed/Tally`);
    console.log(`  ${tallyRun.wallMs} ms`);

    step('keyed compile: Caller (resolves the Tally artefact on --compact-path)');
    callerRun = compile(
      `compact compile ${TOOLCHAIN} --compact-path contracts/managed contracts/caller.compact contracts/managed/Caller`,
    );
    console.log(`  ${callerRun.wallMs} ms`);
  } catch (e: any) {
    details.error = serialiseError(e);
    details.compilerOutput = String(e?.stdout ?? '') + String(e?.stderr ?? '');
    writeEvidence({
      testId: 'P0',
      name: 'keyed-compile',
      description: 'Keyed (no --skip-zk) compile of the Tally/Caller cross-contract pair on compactc 0.34.0',
      verdict: 'FAIL',
      errorCode: 'compile-failed',
      note: 'The keyed compile itself failed — see details.compilerOutput.',
      details,
    });
    throw e;
  }
  details.compiles = {
    tally: { command: tallyRun.command, wallMs: tallyRun.wallMs },
    caller: { command: callerRun.command, wallMs: callerRun.wallMs },
  };

  step('artefact audit: keys, ZKIR version, communications commitment, expectedVk');
  const tallyDir = path.join(MANAGED, 'Tally');
  const callerDir = path.join(MANAGED, 'Caller');

  const tallyCircuits = circuitArtefacts(tallyDir, ['set', 'get', 'set_guarded']);
  const callerCircuits = circuitArtefacts(callerDir, ['write_then_read', 'compose_guarded']);
  details.tallyCircuits = tallyCircuits;
  details.callerCircuits = callerCircuits;

  const tallyVk = expectedVkOf(tallyDir);
  const callerVk = expectedVkOf(callerDir);
  details.expectedVk = { tally: tallyVk, caller: callerVk };

  const tallyInfo = contractInfo(tallyDir);
  const callerInfo = contractInfo(callerDir);
  details.versions = {
    compiler: callerInfo['compiler-version'],
    language: callerInfo['language-version'],
    runtime: callerInfo['runtime-version'],
  };
  // The caller artefact records its contract-type dependencies — the
  // compile-time half of the binding (the runtime half is expectedVk).
  details.callerContractDependencies = (callerInfo.contracts ?? []).map((c: any) => c.name ?? c);
  details.tallyLedger = (tallyInfo.ledger ?? []).map((f: any) => f.name ?? f);

  for (const [name, map, want] of [
    ['Tally', tallyVk, 3],
    ['Caller', callerVk, 2],
  ] as const) {
    if (Object.keys(map).length !== want) {
      throw new Error(`${name} expectedVk has ${Object.keys(map).length} entries, expected ${want} — a --skip-zk artefact?`);
    }
  }
  const allCommitted = [...Object.values(tallyCircuits), ...Object.values(callerCircuits)].every(
    (c) => c.communicationsCommitment,
  );
  if (!allCommitted) {
    throw new Error('a circuit was compiled without the communications commitment — it cannot participate in calls');
  }
  console.log(
    `  Tally: ${Object.keys(tallyVk).length} keyed circuits · Caller: ${Object.keys(callerVk).length} keyed circuits · ` +
    `commitments on · zkir ${callerCircuits.write_then_read.zkirVersion}`,
  );

  writeEvidence({
    testId: 'P0',
    name: 'keyed-compile',
    description: 'Keyed (no --skip-zk) compile of the Tally/Caller cross-contract pair on compactc 0.34.0',
    verdict: 'PASS',
    note:
      `Both contracts compiled with real proving keys (Tally ${tallyRun.wallMs} ms, Caller ${callerRun.wallMs} ms); ` +
      `expectedVk fingerprints present for all 5 circuits, communications commitment on by default, ` +
      `zkir v${callerCircuits.write_then_read.zkirVersion}. The implementation-binding guard and tx assembly have real keys to check.`,
    details,
  });
});
