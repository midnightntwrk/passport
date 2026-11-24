import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

test('conformance receipts share contract-relative paths from any working directory', async () => {
  const sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), 'passport-bootstrap-receipts-')));
  const contractRoot = path.join(sandbox, 'checkout/contract'), elsewhere = path.join(sandbox, 'elsewhere');
  const previousCwd = process.cwd(), previousDirectory = process.env.EVIDENCE_DIR;
  const oldDefault = path.join(sandbox, 'generic-default');
  try {
    mkdirSync(path.join(contractRoot, 'src/tests'), { recursive: true });
    mkdirSync(elsewhere);
    writeFileSync(path.join(contractRoot, 'package.json'), '{"type":"module"}');
    const modulePath = path.join(contractRoot, 'src/tests/evidence.ts');
    copyFileSync(new URL('./evidence.ts', import.meta.url), modulePath);
    // The copied real module resolves its own contract root; every destination
    // remains in the sandbox, even if the resolver is broken.
    process.env.EVIDENCE_DIR = oldDefault;
    const { evidenceDirectory, signedBootstrapEvidenceDirectory, writeEvidence } = await import(pathToFileURL(modulePath).href);
    const receipt = { testId: 'signed-bootstrap', name: 'conformance',
      fileName: 'signed-bootstrap-conformance.json', description: 'directory regression', note: 'test receipt' };
    for (const cwd of [contractRoot, path.dirname(contractRoot), elsewhere]) {
      process.chdir(cwd);
      for (const override of [undefined, '', 'custom-evidence', path.join(sandbox, 'absolute-evidence')]) {
        if (override === undefined) delete process.env.EVIDENCE_DIR;
        else process.env.EVIDENCE_DIR = override;
        const directory = signedBootstrapEvidenceDirectory();
        assert.equal(directory, path.resolve(contractRoot, override ?? 'evidence/signed-bootstrap'));
        for (const verdict of ['PASS', 'FAIL'] as const) {
          writeEvidence({ ...receipt, verdict }, directory);
          assert.equal(JSON.parse(readFileSync(path.join(directory, receipt.fileName), 'utf8')).verdict, verdict);
          assert.equal(existsSync(oldDefault), false, 'explicit destination must override generic writer default');
        }
      }
      process.env.EVIDENCE_DIR = 'generic-relative';
      assert.equal(evidenceDirectory(), path.resolve(cwd, 'generic-relative'), 'other suites keep their working-directory convention');
    }
    writeEvidence({ ...receipt, verdict: 'PASS' });
    assert.equal(JSON.parse(readFileSync(path.join(oldDefault, receipt.fileName), 'utf8')).verdict, 'PASS');
  } finally {
    process.chdir(previousCwd);
    if (previousDirectory === undefined) delete process.env.EVIDENCE_DIR;
    else process.env.EVIDENCE_DIR = previousDirectory;
    rmSync(sandbox, { recursive: true, force: true });
  }
});
