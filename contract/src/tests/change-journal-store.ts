import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createFileChangeJournalStore } from '../node/change-journal-store.js';
import type { ChangeJournal } from '../wallet/change-journal.js';

const scope = 'localnet:account:private-state';
const snapshot = (): ChangeJournal => ({ version: 1, scope, entries: [] });
const pathFor = (directory: string, name = scope) => join(directory,
  `${createHash('sha256').update(name).digest('hex')}.json.enc`);

async function fixture(run: (directory: string, key: Uint8Array) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'passport-change-store-'));
  try { await run(join(root, 'journal'), randomBytes(32)); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('encrypted journal persists privately and reopens in a fresh process', async () => fixture(async (directory, key) => {
  const store = await createFileChangeJournalStore({ directory, encryptionKey: key });
  assert.equal(await store.get(scope), null);
  await store.set(scope, snapshot());
  const path = pathFor(directory);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const bytes = await readFile(path, 'utf8');
  assert(!bytes.includes(scope));
  assert(!bytes.includes('entries'));
  const source = `
    import { createFileChangeJournalStore } from './src/node/change-journal-store.ts';
    let data = ''; for await (const chunk of process.stdin) data += chunk;
    const input = JSON.parse(data);
    const store = await createFileChangeJournalStore({ directory: input.directory,
      encryptionKey: Buffer.from(input.key, 'hex') });
    const restored = await store.get(input.scope);
    process.stdout.write(JSON.stringify(restored));
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve(code ?? -1));
  });
  child.stdin.end(JSON.stringify({ directory, key: Buffer.from(key).toString('hex'), scope }));
  assert.equal(await exit, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), snapshot());
  assert.deepEqual(await readdir(directory), [path.split('/').at(-1)]);
}));

test('wrong key, altered ciphertext, and cross-scope transplant are refused', async () => fixture(async (directory, key) => {
  const store = await createFileChangeJournalStore({ directory, encryptionKey: key });
  await store.set(scope, snapshot());
  const wrongKey = await createFileChangeJournalStore({ directory, encryptionKey: randomBytes(32) });
  await assert.rejects(wrongKey.get(scope));
  await copyFile(pathFor(directory), pathFor(directory, 'different-account'));
  await assert.rejects(store.get('different-account'));
  const envelope = JSON.parse(await readFile(pathFor(directory), 'utf8'));
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  ciphertext[0] ^= 1;
  envelope.ciphertext = ciphertext.toString('base64');
  await writeFile(pathFor(directory), JSON.stringify(envelope));
  await assert.rejects(store.get(scope));
}));

test('private directory and file permissions are required, and symlink reads fail closed', async () => fixture(async (directory, key) => {
  const store = await createFileChangeJournalStore({ directory, encryptionKey: key });
  await store.set(scope, snapshot());
  await chmod(directory, 0o755);
  await assert.rejects(createFileChangeJournalStore({ directory, encryptionKey: key }), /no group or other access/);
  await chmod(directory, 0o700);
  await chmod(pathFor(directory), 0o644);
  await assert.rejects(store.get(scope), /no group or other access/);
  await chmod(pathFor(directory), 0o600);
  const other = pathFor(directory, 'symlink-scope');
  await symlink(pathFor(directory), other);
  await assert.rejects(store.get('symlink-scope'));
}));

test('invalid snapshots preserve committed state and canonical path instances serialise replacement', async () => fixture(async (directory, key) => {
  const first = await createFileChangeJournalStore({ directory, encryptionKey: key });
  const second = await createFileChangeJournalStore({ directory: join(directory, '..', 'journal'), encryptionKey: key });
  await first.set(scope, snapshot());
  await assert.rejects(first.set(scope, { ...snapshot(), scope: 'wrong' }), /scope/);
  assert.deepEqual(await second.get(scope), snapshot());
  const amended = { ...snapshot(), marker: 'second' };
  await Promise.all([first.set(scope, snapshot()), second.set(scope, amended)]);
  assert.deepEqual(await first.get(scope), amended);
  assert.equal((await readdir(directory)).length, 1);
}));

test('caller must supply a key of the required size and an explicit directory', async () => {
  await assert.rejects(createFileChangeJournalStore({ directory: '', encryptionKey: randomBytes(32) }), /explicit/);
  await assert.rejects(createFileChangeJournalStore({ directory: '/unused', encryptionKey: randomBytes(31) }), /32-byte/);
});
