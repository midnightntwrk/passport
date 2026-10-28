// Arm `sol_ed25519`: the private format flag reaches no public instruction of
// any of the arm's circuits, by a taint analysis of the compiled ZKIR
// (src/tests/zkir-taint.ts).
//
// An analysis of the compiler's output that complements the functional
// tests: those show by behaviour that both formats verify and leave equal
// public transcripts from one state (sol-ed25519-seam-offline.ts group 6, and
// the prover suite's `formats` section at the proof server); this follows the
// flag through every instruction of every circuit the proof server proves,
// including paths no test case takes.
//
// For each circuit of the built account whose name carries the arm
// (contracts/managed/account/zkir/*sol_ed25519*.zkir):
//   - a circuit with an `auth.offchain` argument field: its ZKIR inputs are
//     located from contract-info.json (the authorisation's whole layout
//     checked against the ZKIR inputs, element by element), and the flag
//     taints no `impact` guard or input, no `public_input` guard and no
//     circuit output; the analysis is not vacuous: the flag reaches the
//     head selection (`cond_select`) and the one `sha512`;
//   - the other circuits must have no such field, and the verifying circuits
//     are exactly those with it.
// The analysis itself is checked on synthetic circuits: a flag written to the
// ledger (an impact input), one that guards a ledger operation, one that
// guards a ledger read, one returned as an output: each reported disclosed;
// one that only selects a hashed value under an assert: not disclosed. The
// compiler's own refusal of undisclosed leaks, and the analysis on compiled
// leaks, are `npm run check:sol-ed25519-taint-controls` (needs the compiler).
//
// Writes $EVIDENCE_DIR/sol-ed25519-taint-offline.json when EVIDENCE_DIR is set.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fieldInputs, taint, type ContractInfo, type TaintReport, type Zkir } from './zkir-taint.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNT = path.resolve(HERE, '../../contracts/managed/account');
const FLAG = 'auth.offchain';
// The arm's 15 circuits that verify an Ed25519 signature (12 device-gated,
// 3 grantee twins); activation signs nothing.
const VERIFYING = ['rotate_enc_key', 'append_inbox', 'withdraw_unshielded', 'withdraw_shielded', 'withdraw_shielded_to_contract', 'add_device', 'remove_device',
  'issue_grant', 'revoke_grant', 'revoke_all_grants', 'publish_recovery_session', 'recover_cancel'].map((c) => `${c}_with_sol_ed25519`)
  .concat(['withdraw_unshielded', 'withdraw_shielded', 'withdraw_shielded_to_contract'].map((c) => `${c}_with_grant_sol_ed25519`));

interface Case { group: string; name: string; verdict: 'PASS' | 'FAIL'; detail?: string }
const cases: Case[] = [];
const ok = (group: string, name: string, cond: boolean, detail?: string) => {
  cases.push({ group, name, verdict: cond ? 'PASS' : 'FAIL', ...(detail ? { detail } : {}) });
  if (!cond) console.log(`  ✗ ${group}: ${name}${detail ? ` — ${detail}` : ''}`);
};

// ── 1. The arm's circuits ───────────────────────────────────────────────────
const G1 = '1 the format flag in the compiled circuits';
const reports: Record<string, (TaintReport & { flagInputs: string[] }) | { flag: 'none' }> = {};
{
  const info = JSON.parse(fs.readFileSync(path.join(ACCOUNT, 'compiler', 'contract-info.json'), 'utf8')) as ContractInfo;
  const files = fs.readdirSync(path.join(ACCOUNT, 'zkir')).filter((f) => f.endsWith('.zkir') && f.includes('sol_ed25519')).sort();
  ok(G1, `the build has the arm's 16 circuits (${files.length})`, files.length === 16);
  const withFlag: string[] = [];
  for (const f of files) {
    const circuit = f.replace(/\.zkir$/, '');
    const z = JSON.parse(fs.readFileSync(path.join(ACCOUNT, 'zkir', f), 'utf8')) as Zkir;
    const args = info.circuits.find((c) => c.name === circuit)?.arguments ?? [];
    const auth = args.find((a) => a.name === 'auth');
    const hasFlag = Boolean(auth?.type.elements?.some((e) => e.name === 'offchain'));
    if (!hasFlag) { reports[circuit] = { flag: 'none' }; continue; }
    withFlag.push(circuit);
    try {
      const src = fieldInputs(info, z, circuit, FLAG);
      const r = taint(z, src);
      reports[circuit] = { ...r, flagInputs: src };
      ok(G1, `${circuit}: the flag (${src.join(', ')}) reaches no impact (of ${r.impacts.total}), no public input guard (of ${r.publicInputs}) and no output`,
        src.length === 1 && !r.disclosed && r.sinks.impactGuard === 0 && r.sinks.impactInput === 0 && r.sinks.publicInputGuard === 0 && r.sinks.output === 0
          && r.communicationsCommitment === true, JSON.stringify(r.sinks));
      ok(G1, `${circuit}: not vacuous: the flag selects the head and enters the one SHA-512`,
        (r.taintedInstructionsByOp.cond_select ?? 0) >= 2 && r.taintedInstructionsByOp.sha512 === 1, JSON.stringify(r.taintedInstructionsByOp));
    } catch (e: any) {
      ok(G1, `${circuit}: the flag located and analysed`, false, String(e?.message ?? e).slice(0, 300));
    }
  }
  ok(G1, 'the circuits with the flag are exactly the 15 verifying circuits', JSON.stringify(withFlag) === JSON.stringify([...VERIFYING].sort()), withFlag.join(', '));
}

// ── 2. The analysis sees a disclosure ───────────────────────────────────────
// Minimal ZKIR v3 circuits with one Boolean input `%flag.0` and one other
// input, in the shapes the compiler emits.
const G2 = '2 the analysis on synthetic circuits';
{
  const base = (instructions: Zkir['instructions']): Zkir => ({
    version: { major: 3, minor: 1 }, do_communications_commitment: true,
    inputs: [{ name: '%flag.0', type: 'Scalar<BLS12-381>' }, { name: '%key.1', type: 'Scalar<BLS12-381>' }], outputs: [], instructions,
  });
  const sel = { op: 'cond_select', bit: '%flag.0', a: '%key.1', b: '0x00', output: '%t.2' };
  const shapes: [string, Zkir, boolean][] = [
    ['the flag written to the ledger (an impact input)', base([{ op: 'constrain_to_boolean', val: '%flag.0' }, { op: 'impact', guard: '0x01', inputs: ['0x11', '%flag.0'] }]), true],
    ['a value selected by the flag written to the ledger', base([sel, { op: 'impact', guard: '0x01', inputs: ['0x11', '%t.2'] }]), true],
    ['a ledger operation guarded by the flag', base([{ op: 'impact', guard: '%flag.0', inputs: ['0x11', '0x01'] }]), true],
    ['a ledger read guarded by the flag', base([{ op: 'public_input', type: 'Scalar<BLS12-381>', guard: '%flag.0', output: '%r.3' }]), true],
    ['the flag returned as a circuit output', base([sel, { op: 'output', vals: ['%t.2'] }]), true],
    ['the flag only selects a hashed value under an assert', base([sel, { op: 'sha512', alignment: [], inputs: ['%t.2'], output: '%h.3' },
      { op: 'test_eq', a: '%h.3', b: '0x00', output: '%e.4' }, { op: 'assert', cond: '%e.4' }, { op: 'impact', guard: '0x01', inputs: ['0x11', '%key.1'] }]), false],
  ];
  for (const [name, z, disclosed] of shapes) {
    const r = taint(z, ['%flag.0']);
    ok(G2, `${name}: ${disclosed ? 'reported disclosed' : 'not disclosed'}`, r.disclosed === disclosed, JSON.stringify(r.sinks));
  }
  let threw = '';
  try { taint(base([]), ['%nope.9']); } catch (e: any) { threw = String(e?.message ?? e); }
  ok(G2, 'an input the circuit does not have is an error, never an empty pass', /not an input/.test(threw), threw);
}

const failed = cases.filter((c) => c.verdict !== 'PASS');
for (const g of [...new Set(cases.map((c) => c.group))]) {
  const cs = cases.filter((c) => c.group === g);
  console.log(`  ${cs.every((c) => c.verdict === 'PASS') ? '✓' : '✗'} ${g}: ${cs.filter((c) => c.verdict === 'PASS').length}/${cs.length}`);
}
const verdict = failed.length ? 'FAIL' : 'PASS';
if (process.env.EVIDENCE_DIR) {
  fs.mkdirSync(process.env.EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.EVIDENCE_DIR, 'sol-ed25519-taint-offline.json'),
    JSON.stringify({ suite: 'sol-ed25519-taint-offline', ranAt: new Date().toISOString(), cases, reports, verdict }, null, 2) + '\n');
}
console.log(`\n◆ sol-ed25519-taint-offline: ${verdict} (${cases.length} cases, ${failed.length} failed)`);
process.exit(verdict === 'PASS' ? 0 : 1);
