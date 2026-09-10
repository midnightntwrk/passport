// Byte-exactness check backing probe G: persistentHash is SHA-256 over the
// value's binary representation, and that representation is the raw byte
// string for Bytes<N> and for tuples of Bytes (no alignment or length
// framing). Runs against the published Compact runtime.
//
// Point COMPACT_RUNTIME_DIR at an installed @midnight-ntwrk/compact-runtime
// package (defaults to the copy under tmp/compact-end-2-end).
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const runtimeDir =
  process.env.COMPACT_RUNTIME_DIR ??
  new URL(
    '../../../tmp/compact-end-2-end/node_modules/@midnight-ntwrk/compact-runtime',
    import.meta.url,
  ).pathname;
const { persistentHash, CompactTypeBytes } = await import(`${runtimeDir}/dist/index.js`);

const sha256 = (b) => createHash('sha256').update(b).digest();
const results = {};

for (const n of [32, 59, 64, 160]) {
  const data = Buffer.alloc(n, 0xab);
  const ph = Buffer.from(persistentHash(new CompactTypeBytes(n), data));
  results[`bytes_${n}`] = ph.equals(sha256(data));
}

// A Compact tuple of Bytes: alignment and value are the member
// concatenations, mirroring the compiled contracts' descriptors.
const b27 = new CompactTypeBytes(27);
const b32 = new CompactTypeBytes(32);
const pair = {
  alignment: () => b27.alignment().concat(b32.alignment()),
  toValue: (v) => b27.toValue(v[0]).concat(b32.toValue(v[1])),
  fromValue: () => {
    throw new Error('unused');
  },
};
const prefix = Buffer.from('midnight_signed_message:32:');
const challenge = Buffer.alloc(32, 0xc7);
const ph = Buffer.from(persistentHash(pair, [prefix, challenge]));
results.tuple_bytes27_bytes32 = ph.equals(sha256(Buffer.concat([prefix, challenge])));

// The BIP-340 tagged-hash input shape: 160 raw bytes.
const tagH = sha256(Buffer.from('BIP0340/challenge'));
const tagged = Buffer.concat([tagH, tagH, Buffer.alloc(32, 1), Buffer.alloc(32, 2), Buffer.alloc(32, 3)]);
results.bip340_tagged_shape_160 = Buffer.from(
  persistentHash(new CompactTypeBytes(160), tagged),
).equals(sha256(tagged));

console.log(results);
if (Object.values(results).some((v) => v !== true)) {
  throw new Error('persistentHash is not byte-exact SHA-256 for a tested shape');
}
writeFileSync(
  new URL('../evidence/persistent-hash-sha256.json', import.meta.url),
  `${JSON.stringify({ generated: new Date().toISOString(), results }, null, 2)}\n`,
);
console.log('evidence written: evidence/persistent-hash-sha256.json');
