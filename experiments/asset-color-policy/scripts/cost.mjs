import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
// Can be overridden for a different local installation, never silently use another version.
const zkir = process.env.ZKIR_V3 ?? path.join(os.homedir(), '.compact/versions/0.35.0', `${os.arch()}-${os.platform()}`.replace('arm64', 'aarch64'), 'zkir-v3');
const circuits = ['withdraw_shielded', 'withdraw_shielded_to_contract', 'withdraw_unshielded']
  .flatMap(op => ['with_jubjub', 'with_k256', 'with_grant_jubjub', 'with_grant_k256'].map(arm => `${op}_${arm}`));
const variants = ['Baseline', 'Inline', 'ExternalRaw', 'ExternalTagged'];
const targets = { Policy: ['check', 'set_frozen'], PolicyAlternate: ['check'],
  Registry: ['resolve', 'rebind'], Dispatch: ['check'],
  ...Object.fromEntries(variants.map(v => [v, circuits])) };
const rows = [];
for (const [variant, measuredCircuits] of Object.entries(targets)) {
  for (const circuit of measuredCircuits) {
    const file = `contracts/managed/${variant}/zkir/${circuit}.zkir`;
    const run = spawnSync(zkir, ['mock-compile', '-v', file], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (run.error) throw run.error;
    const raw = run.stdout + run.stderr;
    if (run.status !== 0) throw new Error(`zkir failed: ${raw}`);
    const match = raw.match(/k=(\d+), rows=(\d+)/);
    if (!match) throw new Error(`no measured k/rows in zkir output for ${file}: ${raw}`);
    const model = /table_rows: (\d+)/.exec(raw);
    const record = { variant, circuit, k: Number(match[1]), rows: Number(match[2]),
      tableRows: model ? Number(model[1]) : null,
      zkirSha256: (await import('node:crypto')).createHash('sha256').update(readFileSync(file)).digest('hex') };
    rows.push(record);
    console.log(`${variant}.${circuit}: k=${record.k}, rows=${record.rows}`);
  }
}
const check = rows.find(x => x.variant === 'Policy' && x.circuit === 'check');
for (const r of rows.filter(x => variants.includes(x.variant))) {
  const base = rows.find(x => x.variant === 'Baseline' && x.circuit === r.circuit);
  r.deltaRows = r.rows - base.rows;
  r.deltaK = r.k - base.k;
  r.externalCheck = r.variant.startsWith('External') ? { k: check.k, rows: check.rows, conditional: true } : null;
}
writeFileSync('evidence/cost.json', JSON.stringify({ compiler: '0.35.0',
  measurement: 'zkir-v3 mock-compile circuit model; no proof timing, DUST fee, or transaction benchmark',
  note: 'k is per circuit, logarithmic, and not additive. External required-policy paths add a separate Policy.check proof. Branches do not produce cheaper specialized root circuits.', rows }, null, 2) + '\n');
