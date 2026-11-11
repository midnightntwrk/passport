// Real encrypted file storage and subprocess reopening. This does not establish
// distributed locking or durability of arbitrary third-party store adapters.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdtemp, open, readFile, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createFileViewingKeyStore } from '../node/viewing-key-store.js';
import { generateEncKeyPair } from '../wallet/inbox.js';

const networkId = '11'.repeat(32), address = '22'.repeat(32);
const scope = { networkId, address };
function record() {
  const keys = generateEncKeyPair();
  return { version: 1 as const, ...scope, encSecretKeyHex: Buffer.from(keys.secretKey).toString('hex'),
    encPublicKeyHex: Buffer.from(keys.publicKey).toString('hex') };
}
async function fixture(run: (directory: string, key: Uint8Array) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'passport-viewing-store-'));
  try { await run(join(root, 'vault'), randomBytes(32)); }
  finally { await rm(root, { recursive: true, force: true }); }
}
async function onlyFile(directory: string): Promise<string> {
  const names = await readdir(directory);
  assert.equal(names.length, 1);
  return join(directory, names[0]);
}

test('viewing vault encrypts private material and reopens it in a fresh process', async () => fixture(async (directory, key) => {
  const store = await createFileViewingKeyStore({ directory, encryptionKey: key });
  const saved = record();
  assert.equal(await store.get(scope), null);
  await store.set(saved);
  const file = await onlyFile(directory);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const raw = await readFile(file, 'utf8');
  assert.equal(raw.includes(saved.encSecretKeyHex), false);
  assert.equal(raw.includes('encSecretKeyHex'), false);
  assert.equal(raw.includes(address), false);
  const source = `
    import assert from 'node:assert/strict';
    import { createFileViewingKeyStore } from './src/node/viewing-key-store.ts';
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    const data = JSON.parse(input);
    const store = await createFileViewingKeyStore({ directory: data.directory,
      encryptionKey: Buffer.from(data.key, 'hex') });
    assert.deepEqual(await store.get(data.scope), data.record);
    process.stdout.write('private viewing key reopened');
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = new Promise<number>((resolve, reject) => {
    child.on('error', reject); child.on('close', code => resolve(code ?? -1));
  });
  child.stdin.end(JSON.stringify({ directory, key: Buffer.from(key).toString('hex'), scope, record: saved }));
  assert.equal(await exit, 0, stderr);
  assert.equal(stdout, 'private viewing key reopened');
  assert.deepEqual(await store.get(scope), saved);
}));

test('wrong encryption key and cross-network or cross-account ciphertext transplants are refused', async () => fixture(async (directory, key) => {
  const store = await createFileViewingKeyStore({ directory, encryptionKey: key });
  const saved = record(); await store.set(saved);
  const first = await onlyFile(directory);
  const wrong = await createFileViewingKeyStore({ directory, encryptionKey: randomBytes(32) });
  await assert.rejects(wrong.get(scope));
  for (const other of [{ networkId: '33'.repeat(32), address }, { networkId, address: '44'.repeat(32) }]) {
    const before = new Set(await readdir(directory));
    await store.set({ ...saved, ...other });
    const target = (await readdir(directory)).find(name => !before.has(name)); assert.ok(target);
    await copyFile(first, join(directory, target));
    await assert.rejects(store.get(other));
  }
  assert.deepEqual(await store.get(scope), saved);
}));

test('malformed and modified encrypted envelopes fail closed', async () => fixture(async (directory, key) => {
  const store = await createFileViewingKeyStore({ directory, encryptionKey: key });
  const saved = record(); await store.set(saved);
  const file = await onlyFile(directory), original = await readFile(file);
  await writeFile(file, original.subarray(0, original.length - 8));
  await assert.rejects(store.get(scope));
  await writeFile(file, 'null'); await assert.rejects(store.get(scope));
  await writeFile(file, '{}'); await assert.rejects(store.get(scope));
  const envelope = JSON.parse(original.toString('utf8'));
  for (const tag of ['', envelope.tag.slice(0, 24), `${envelope.tag}00`]) {
    await writeFile(file, JSON.stringify({ ...envelope, tag }));
    await assert.rejects(store.get(scope));
  }
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64'); ciphertext[0] ^= 1;
  await writeFile(file, JSON.stringify({ ...envelope, ciphertext: ciphertext.toString('base64') }));
  await assert.rejects(store.get(scope));
  await writeFile(file, original);
  assert.deepEqual(await store.get(scope), saved);
}));

test('private permissions and no-follow file handling protect stored viewing material', async () => fixture(async (directory, key) => {
  const store = await createFileViewingKeyStore({ directory, encryptionKey: key });
  const saved = record(); await store.set(saved);
  const file = await onlyFile(directory);
  await chmod(directory, 0o755);
  await assert.rejects(createFileViewingKeyStore({ directory, encryptionKey: key }));
  await chmod(directory, 0o700);
  await chmod(file, 0o644); await assert.rejects(store.get(scope));
  await chmod(file, 0o600);
  const other = { networkId, address: '55'.repeat(32) };
  await store.set({ ...saved, ...other });
  const target = (await readdir(directory)).map(name => join(directory, name)).find(name => name !== file)!;
  await unlink(target); await symlink(file, target);
  await assert.rejects(store.get(other));
  assert.deepEqual(await store.get(scope), saved);
}));

test('invalid private-key records cannot replace the last acknowledged value', async () => fixture(async (directory, key) => {
  const store = await createFileViewingKeyStore({ directory, encryptionKey: key });
  const saved = record(); await store.set(saved);
  const invalid = [
    { ...saved, version: 2 },
    { ...saved, encSecretKeyHex: '00' },
    { ...saved, encPublicKeyHex: '00'.repeat(32) },
    { ...saved, encSecretKeyHex: 'gg'.repeat(32) },
    { ...saved, address: '' },
    { ...saved, networkId: '' },
  ];
  for (const value of invalid) {
    await assert.rejects(store.set(value as typeof saved));
    assert.deepEqual(await store.get(scope), saved);
  }
}));

test('scope separation and canonical directory instances preserve independently acknowledged records', async () => fixture(async (directory, key) => {
  const first = await createFileViewingKeyStore({ directory, encryptionKey: key });
  const second = await createFileViewingKeyStore({ directory: join(directory, '..', 'vault'), encryptionKey: key });
  const a = record(), b = record();
  await first.set(a);
  await second.set(b);
  assert.deepEqual(await first.get(scope), b);
  const other = { ...a, address: '66'.repeat(32) };
  await first.set(other);
  assert.deepEqual(await second.get({ networkId, address: other.address }), other);
  assert.deepEqual(await second.get(scope), b);
}));

test('viewing vault requires an explicit private directory and a 32-byte encryption key', async () => {
  await assert.rejects(createFileViewingKeyStore({ directory: '', encryptionKey: randomBytes(32) }));
  await assert.rejects(createFileViewingKeyStore({ directory: '/unused', encryptionKey: randomBytes(31) }));
});


test('a failed file flush before replacement preserves the previous acknowledged vault record', async t => fixture(async (directory, key) => {
  const store = await createFileViewingKeyStore({ directory, encryptionKey: key });
  const previous = record(), next = record(); await store.set(previous);
  const file = await onlyFile(directory), handle = await open(file, 'r');
  const prototype = Object.getPrototypeOf(handle), realSync = handle.sync;
  await handle.close();
  let injected = false;
  t.mock.method(prototype, 'sync', async function () {
    if (!injected && (await this.stat()).isFile()) {
      injected = true; throw new Error('injected file flush failure');
    }
    return realSync.call(this);
  });
  await assert.rejects(store.set(next), /injected file flush failure/);
  assert.equal(injected, true);
  assert.deepEqual(await store.get(scope), previous);
  assert.equal((await readdir(directory)).length, 1, 'failed temporary write is removed');
  await store.set(next);
  assert.deepEqual(await store.get(scope), next);
}));

test('a failed directory flush after replacement is unacknowledged but remains recoverable', async t => fixture(async (directory, key) => {
  const store = await createFileViewingKeyStore({ directory, encryptionKey: key });
  const previous = record(), next = record(); await store.set(previous);
  const file = await onlyFile(directory), handle = await open(file, 'r');
  const prototype = Object.getPrototypeOf(handle), realSync = handle.sync;
  await handle.close();
  let injected = false;
  t.mock.method(prototype, 'sync', async function () {
    if (!injected && (await this.stat()).isDirectory()) {
      injected = true; throw new Error('injected directory flush failure');
    }
    return realSync.call(this);
  });
  await assert.rejects(store.set(next), /injected directory flush failure/);
  assert.equal(injected, true);
  const reopened = await createFileViewingKeyStore({ directory, encryptionKey: key });
  assert.deepEqual(await reopened.get(scope), next, 'rename reached disk before the acknowledgement failed');
  assert.equal((await readdir(directory)).length, 1);
  await reopened.set(next);
  assert.deepEqual(await store.get(scope), next);
}));
