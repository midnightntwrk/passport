import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('success and failure receipts use the chosen conformance directory with default and overridden paths', async () => {
  const sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), 'passport-bootstrap-receipts-')));
  const previousCwd = process.cwd(), previousDirectory = process.env.EVIDENCE_DIR;
  const oldDefault = path.join(sandbox, 'generic-default');
  try {
    process.chdir(sandbox);
    // Capture the generic writer's existing import-time default inside the
    // sandbox too: a broken directory override must not touch real evidence.
    process.env.EVIDENCE_DIR = oldDefault;
    const { evidenceDirectory, writeEvidence } = await import('./evidence.js');
    const receipt = { testId: 'signed-bootstrap', name: 'conformance',
      fileName: 'signed-bootstrap-conformance.json', description: 'directory regression', note: 'test receipt' };
    for (const override of [undefined, 'custom-evidence', path.join(sandbox, 'absolute-evidence')]) {
      if (override === undefined) delete process.env.EVIDENCE_DIR;
      else process.env.EVIDENCE_DIR = override;
      const directory = evidenceDirectory('evidence/signed-bootstrap');
      assert.equal(directory, path.resolve(sandbox, override ?? 'evidence/signed-bootstrap'));
      for (const verdict of ['PASS', 'FAIL'] as const) {
        writeEvidence({ ...receipt, verdict }, directory);
        assert.equal(JSON.parse(readFileSync(path.join(directory, receipt.fileName), 'utf8')).verdict, verdict);
        assert.equal(existsSync(oldDefault), false, 'explicit destination must override generic writer default');
      }
    }
    // Existing callers that omit the override keep their import-time default.
    writeEvidence({ ...receipt, verdict: 'PASS' });
    assert.equal(JSON.parse(readFileSync(path.join(oldDefault, receipt.fileName), 'utf8')).verdict, 'PASS');
  } finally {
    process.chdir(previousCwd);
    if (previousDirectory === undefined) delete process.env.EVIDENCE_DIR;
    else process.env.EVIDENCE_DIR = previousDirectory;
    rmSync(sandbox, { recursive: true, force: true });
  }
});
