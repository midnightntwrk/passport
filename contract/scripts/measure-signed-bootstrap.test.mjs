// Exercise the inventory command with a tiny synthetic keyed manifest. These
// fixtures test capture plumbing, not cryptographic keys or circuit costs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scripts = dirname(fileURLToPath(import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');

test('measurement completes without Git and resolves evidence from contract rather than cwd', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'passport-bootstrap-measure-'));
  const root = join(temporary, 'contract'), managed = join(root, 'contracts/managed/account');
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    for (const file of ['measure-signed-bootstrap.mjs', 'git-provenance.mjs'])
      copyFileSync(join(scripts, file), join(root, 'scripts', file));
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(join(root, 'package-lock.json'), '{}');
    const manifest = { 'runtime-version': 'test-fixture' }, expectedVk = {};
    const add = (directory, name, value) => {
      mkdirSync(join(managed, directory), { recursive: true });
      writeFileSync(join(managed, directory, name), value);
      (manifest[directory] ??= { type: 'directory' })[name] = { type: 'file', size: Buffer.byteLength(value), hash: sha(value) };
    };
    for (const name of ['activate_initial_passkey', ...Array.from({ length: 52 }, (_, i) => `fixture_${i}`)]) {
      for (const [directory, extension] of [['zkir', 'zkir'], ['zkir', 'bzkir'], ['keys', 'prover'], ['keys', 'verifier']]) {
        const value = `${name}/${extension}: synthetic fixture\n`;
        add(directory, `${name}.${extension}`, value);
        if (extension === 'verifier') expectedVk[name] = sha(value);
      }
    }
    add('contract', 'index.js', `export const expectedVk = ${JSON.stringify(expectedVk)};\n`);
    mkdirSync(join(managed, 'compiler'));
    writeFileSync(join(managed, 'compiler/contract-info.json'), JSON.stringify({ 'compiler-version': 'test-fixture' }));
    writeFileSync(join(managed, 'compiler/contract-manifest.json'), JSON.stringify(manifest));
    for (const name of ['account.compact', 'account-p256.compact', 'account-bootstrap.compact', 'webauthn.compact'])
      writeFileSync(join(root, 'contracts', name), `// synthetic source fixture: ${name}\n`);
    const zkir = join(temporary, 'fixture-zkir');
    writeFileSync(zkir, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "test-fixture"; else echo "k=1, rows=1"; fi\n');
    chmodSync(zkir, 0o755);
    const env = { ...process.env, ZKIR_BIN: zkir };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    for (const override of [undefined, 'relative-output', join(temporary, 'absolute-output')]) {
      if (override === undefined) delete env.EVIDENCE_DIR;
      else env.EVIDENCE_DIR = override;
      const run = spawnSync(process.execPath, [join(root, 'scripts/measure-signed-bootstrap.mjs')],
        { cwd: temporary, env, encoding: 'utf8', timeout: 30_000 });
      assert.equal(run.error, undefined);
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.match(run.stdout, /PASS keyed schema-4 inventory: 53 circuits, 213 manifest entries/);
      const result = JSON.parse(readFileSync(join(resolve(root, override ?? 'evidence/signed-bootstrap'), 'circuit-sizes.json'), 'utf8'));
      assert.equal(result.gitCommit, null);
      assert.equal(result.gitStatus, null);
      assert.equal(result.circuits.length, 53);
      assert.equal(result.manifest.verifiedFiles, 213);
      assert.equal(result.sources['contracts/webauthn.compact'], sha(readFileSync(join(root, 'contracts/webauthn.compact'))));
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
