// Sequential test orchestrator — alternative entry-point to ./run-all.sh.
//
// Useful when the devnet is already up and you just want to re-run every
// test in TypeScript without re-bringing-up Docker. After every test,
// regenerates FINDINGS.md.

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const TESTS = [
  'tests/u1-receive-unshielded.ts',
  'tests/u2-send-to-contract.ts',
  'tests/u3-send-to-user.ts',
  'tests/u4-roundtrip.ts',
  'tests/s1-mint-to-self.ts',
  'tests/s2-mint-and-send.ts',
  'tests/s3-cross-tx-custody.ts',
  'tests/s4-receive-shielded.ts',
  'tests/d1-self-payment.ts',
  'tests/d2-paymaster.ts',
];

const HERE = path.dirname(new URL(import.meta.url).pathname);

let passed = 0,
  failed = 0,
  pending = 0;

for (const t of TESTS) {
  console.log('\n' + '─'.repeat(70));
  console.log(`▶ ${t}`);
  console.log('─'.repeat(70));
  const r = spawnSync('npx', ['tsx', path.join(HERE, t)], {
    stdio: 'inherit',
    cwd: path.resolve(HERE, '..'),
  });
  if (r.status === 0) passed++;
  else failed++;
}

console.log('\nRegenerating FINDINGS.md…');
const r = spawnSync('npx', ['tsx', path.join(HERE, 'compose-findings.ts')], {
  stdio: 'inherit',
  cwd: path.resolve(HERE, '..'),
});

console.log('\n' + '═'.repeat(70));
console.log(` Summary: ${passed} passed, ${failed} failed, ${pending} pending`);
console.log('═'.repeat(70));
process.exit(failed > 0 ? 1 : 0);
