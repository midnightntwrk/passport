// Capture the files used by a run, not whichever files exist when a report
// happens to be rendered. Paths are relative to contract/.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const provenancePaths = [
  'src/tests/inbox-view-envelope/codec.ts', 'src/tests/inbox-view-envelope/offline.ts',
  'src/tests/inbox-view-envelope/localnet.ts', 'src/tests/inbox-view-envelope/private-state.ts',
  'src/tests/inbox-view-envelope/provenance.ts', 'src/tests/inbox-view-envelope/report.ts',
  'src/tests/instrumentation.ts', 'src/wallet/webauthn.ts', 'package-lock.json',
  'contracts/account.compact', 'contracts/account-p256.compact',
  'contracts/managed/account/contract/index.js',
  ...['append_inbox_with_p256', 'withdraw_shielded_with_p256', 'rotate_enc_key_with_p256'].flatMap(n => [
    `contracts/managed/account/keys/${n}.verifier`, `contracts/managed/account/zkir/${n}.bzkir`,
  ]),
];

export function captureProvenance() {
  return {
    capturedAt: new Date().toISOString(),
    note: 'Captured before the localnet scenario; checked again at completion and report generation.',
    files: Object.fromEntries(provenancePaths.map(path => {
      const bytes = readFileSync(path);
      return [path, { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }];
    })),
  };
}

export function verifyProvenance(recorded: ReturnType<typeof captureProvenance> | undefined) {
  assert.ok(recorded?.files, 'run has no start-of-run provenance; rerun before publishing current-source evidence');
  assert.deepEqual(recorded.files, captureProvenance().files,
    'sources or generated artifacts changed since the run started; rerun before publishing');
}
