// Exercise the real capture-producing tests from a source archive without .git.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('offline tests preserve evidence by default and capture only on explicit opt-in without Git metadata', () => {
  const archive = mkdtempSync(join(tmpdir(), 'passport-bootstrap-archive-'));
  try {
    cpSync(join(root, 'src'), join(archive, 'src'), { recursive: true });
    cpSync(join(root, 'package.json'), join(archive, 'package.json'));
    mkdirSync(join(archive, 'contracts/managed/account'), { recursive: true });
    cpSync(join(root, 'contracts/managed/account/contract'), join(archive, 'contracts/managed/account/contract'), { recursive: true });
    for (const file of ['account.compact', 'account-bootstrap.compact', 'account-p256.compact']) {
      cpSync(join(root, 'contracts', file), join(archive, 'contracts', file));
    }
    symlinkSync(join(root, 'node_modules'), join(archive, 'node_modules'), 'dir');
    const original = join(archive, 'evidence/signed-bootstrap');
    mkdirSync(join(original, 'preimages'), { recursive: true });
    const captures = ['independent-vectors.json', 'runtime-preimage.json', 'preimages/activate_initial_passkey.bin'];
    for (const file of captures) writeFileSync(join(original, file), 'preserved historic capture');
    const env = { ...process.env, EVIDENCE_DIR: 'evidence/signed-bootstrap' };
    delete env.WRITE_EVIDENCE;
    // Do not inherit a caller's Git context into this source-archive check.
    for (const name of Object.keys(env)) if (name.startsWith('GIT_') || name.startsWith('NODE_TEST_')) delete env[name];
    const run = environment => {
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-name-pattern=B12:|B10:',
        'src/tests/signed-bootstrap-offline.ts'], { cwd: archive, env: environment, encoding: 'utf8', timeout: 60_000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    };
    assert.equal(existsSync(join(archive, '.git')), false);
    run(env);
    for (const file of captures) assert.equal(readFileSync(join(original, file), 'utf8'), 'preserved historic capture');
    const output = join(archive, 'fresh-evidence');
    run({ ...env, WRITE_EVIDENCE: '1', EVIDENCE_DIR: output });
    for (const file of captures) {
      assert.ok(readFileSync(join(output, file)).length > 0);
      assert.equal(readFileSync(join(original, file), 'utf8'), 'preserved historic capture');
    }
    assert.equal(JSON.parse(readFileSync(join(output, 'independent-vectors.json'), 'utf8')).sourceRevision, null);
    assert.equal(JSON.parse(readFileSync(join(output, 'runtime-preimage.json'), 'utf8')).preimageSha256,
      createHash('sha256').update(readFileSync(join(output, 'preimages/activate_initial_passkey.bin'))).digest('hex'));
  } finally { rmSync(archive, { recursive: true, force: true }); }
});
