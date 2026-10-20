import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const vectorSource = {
  repository: 'https://github.com/bitcoin/bips',
  revision: '130b8e0fa7f30fa45532f080b87b8db27a79e46e',
  path: 'bip-0340/test-vectors.csv',
  sha256: '34c9d1d9c3a88d524bc80778540dc43f8306ec249a7485293063c376db851c2d',
};

export type Vector = {
  index: number;
  publicKey: Uint8Array;
  message: Uint8Array;
  signature: Uint8Array;
  valid: boolean;
  comment: string;
};

export function fromHex(hex: string): Uint8Array {
  assert.match(hex, /^(?:[0-9a-fA-F]{2})*$/, 'fixture must contain complete hexadecimal bytes');
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

const csv = readFileSync(new URL('./fixtures/test-vectors.csv', import.meta.url));
assert.equal(createHash('sha256').update(csv).digest('hex'), vectorSource.sha256,
  'official fixture bytes changed without updating the pinned provenance');
const rows = csv.toString('utf8').trimEnd().split(/\r?\n/);
assert.equal(rows.shift(), 'index,secret key,public key,aux_rand,message,signature,verification result,comment');

export const vectors: Vector[] = rows.map((row, index) => {
  // The pinned upstream fixture has no quoted fields or commas inside fields.
  const columns = row.split(',');
  assert.equal(columns.length, 8, `unexpected CSV layout in vector ${index}`);
  const [id, , publicKey, , message, signature, result, comment] = columns;
  assert.equal(Number(id), index, 'vectors must remain in their original order');
  assert.ok(result === 'TRUE' || result === 'FALSE', 'invalid vector result');
  const vector = { index, publicKey: fromHex(publicKey), message: fromHex(message),
    signature: fromHex(signature), valid: result === 'TRUE', comment };
  assert.equal(vector.publicKey.length, 32);
  assert.equal(vector.signature.length, 64);
  return vector;
});
assert.equal(vectors.length, 19);
assert.equal(vectors.filter(vector => vector.valid).length, 9);
assert.deepEqual([...new Set(vectors.map(vector => vector.message.length))].sort((a, b) => a - b),
  [0, 1, 17, 32, 100]);
