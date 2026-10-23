// Offline suite for the readable-descriptor module (contracts/modules/
// WalletArmDescriptors.compact), compiled through the base probe contract.
//
//   1. Tags: every registered tag fits its 32-byte pad, is ASCII, and is
//      registered once.
//   2. Legacy recipes: for `jubjub`, `k256` and `p256`, the descriptor
//      derivation by payload width equals upstream's own derivation circuit
//      (device entry and grant id; these schemes have no boot recipe here,
//      they boot through upstream's own circuits) AND an independent SHA-256
//      of the plain concatenation, on seeded vectors with edge values
//      (fixed-width little-endian integers, little-endian coordinates,
//      passkeys whose RP ID is a registrable parent of the origin host).
//   3. Readable recipes (`evm_eip712`, `sol_ed25519`): device entry, boot
//      commitment, grant id, the grantee origin label, the blind and the
//      grant scope salt equal an independent SHA-256 of their specified
//      preimages (the salt also equals the client's grantScopeSalt). A `sol_ed25519` key
//      is passed as its Curve25519Point with its encoding and x-coordinate
//      as checked byte inputs: the derivations equal the recipe over the
//      key's RFC 8032 encoding as Node's OpenSSL exports it, and the shared
//      encoding circuit equals RFC 8032 (its section 7.1 vectors, the base
//      point, and seeded keys of both x parities); each ed25519 derivation
//      returns the key it hashed, and the signer helper equals two single
//      derivations.
//   4. The checked encoding equals the encoding computed from the
//      coordinates' own bytes (the probe's exploded_encoding_ed25519) on
//      seeded keys, keys with a small y or x, keys with y just below p (high
//      bytes at their limits), the identity (the one subgroup point with
//      y < 19 and with x < 19) and both x parities; inputs that are not the
//      point's own bytes (a flipped byte, the other sign bit, y + p, x + p,
//      a byte at 256) are refused.
//   5. Refusals: an unknown tag, a known tag of another class or another
//      recipe, upstream's own boot tags (not registered here), and a
//      non-canonically padded tag are each refused by every derivation; the
//      identity point is refused by the ed25519 class (A != O), and
//      small-order and mixed-order points by the point type;
//      a mismatched passkey RP yields an entry the passkey cannot use.
//   6. Comparator controls: the independent implementation detects a
//      one-byte change, so agreement is not vacuous.
//
// Needs the compiled probe (npm run compile). Writes
// $EVIDENCE_DIR/wallet-arms-descriptors-offline.json when EVIDENCE_DIR is
// set; never writes into the repository.

import { strict as assert } from 'node:assert';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { ed25519, ED25519_TORSION_SUBGROUP } from '@noble/curves/ed25519.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pureCircuits as probe } from '../../contracts/managed/probe-wallet-arms-base/contract/index.js';
import { pureCircuits as upstream } from '../wallet/contract.js';
import { grantScopeSalt, SALT_TAGS } from '../wallet/descriptors.js';

const VECTORS = 24;

// ── Independent encoders (no contract code) ─────────────────────────────────

const sha = (...parts: Uint8Array[]): Uint8Array => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};
const pad = (w: number, s: string): Uint8Array => {
  const b = Buffer.from(s, 'ascii');
  if (b.length > w) throw new Error(`tag exceeds ${w} bytes: ${s}`);
  const o = new Uint8Array(w);
  o.set(b);
  return o;
};
const le = (v: bigint, w: number): Uint8Array => {
  const o = new Uint8Array(w);
  let x = v;
  for (let i = 0; i < w; i++) { o[i] = Number(x & 0xffn); x >>= 8n; }
  if (x !== 0n) throw new Error(`value exceeds ${w} bytes`);
  return o;
};
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const eq = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));
const bigLE = (b: Uint8Array): bigint => { let v = 0n; for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return v; };

// Seeded byte stream (SHA-256 in counter mode), so every run checks the same
// vectors and a failure is reproducible.
let streamCounter = 0n;
const SEED = 'wallet-arms-base/v1/wallet-arms-descriptors-offline';
const rnd = (n: number): Uint8Array => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 32) {
    out.set(sha(Buffer.from(SEED), le(streamCounter++, 8)).subarray(0, Math.min(32, n - i)), i);
  }
  return out;
};

// ── Inputs: edge values first, then seeded values ───────────────────────────

const U32_EDGES = [0n, 1n, 255n, 256n, 65535n, 65536n, 0x7fffffffn, 0xffffffffn];
const U64_EDGES = [0n, 1n, 255n, 256n, 0xffffffffn, 0x100000000n, 0x7fffffffffffffffn, 0xffffffffffffffffn];
const SLOT_EDGES = [0n, 255n];
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256R1_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const JUBJUB_R = 0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7n;
const pick = (edges: bigint[], i: number, bytes: number): bigint => (i < edges.length ? edges[i] : bigLE(rnd(bytes)));
const scalar = (n: bigint, i: number, edges: bigint[]): bigint => (i < edges.length ? edges[i] : (bigLE(rnd(40)) % (n - 1n)) + 1n);
const jubjubPk = (i: number) => upstream.compute_public_point_with_jubjub(scalar(JUBJUB_R, i, [1n, 2n, 5n, JUBJUB_R - 1n]));
const k256Pk = (i: number) => upstream.compute_public_point_with_k256(scalar(SECP256K1_N, i, [1n, 2n, SECP256K1_N - 1n]));
const p256Pk = (i: number) => upstream.compute_public_point_with_p256(scalar(SECP256R1_N, i, [1n, 2n, SECP256R1_N - 1n]));
const xy = (p: { x: bigint; y: bigint }): [Uint8Array, Uint8Array] => [le(p.x, 32), le(p.y, 32)];

// 21-byte origins: an RP ID that is a registrable PARENT of the origin host,
// one equal to the host, and http://localhost.
const ORIGINS = [
  { origin: 'https://a.example.com', rpId: 'example.com', note: 'RP ID is a registrable parent of the origin host' },
  { origin: 'https://a.example.com', rpId: 'a.example.com', note: 'RP ID equals the origin host' },
  { origin: 'https://bank.example1', rpId: 'bank.example1', note: 'RP ID equals the origin host' },
  { origin: 'https://x.y.bank.test', rpId: 'bank.test', note: 'RP ID is a registrable parent, two labels up' },
  { origin: 'http://localhost:5173', rpId: 'localhost', note: 'http://localhost origin' },
];
const policyOf = (i: number) => {
  if (i < ORIGINS.length) {
    const o = ORIGINS[i];
    return { rp_id_hash: sha(Buffer.from(o.rpId, 'ascii')), origin: new Uint8Array(Buffer.from(o.origin, 'ascii')), note: o.note };
  }
  return { rp_id_hash: rnd(32), origin: rnd(21), note: 'random policy bytes' };
};
const addr = () => rnd(32);
const contractAddress = (b: Uint8Array) => ({ bytes: b });

// Ed25519 keys from Node's OpenSSL (independent of the contract and of
// noble): the 32-byte RFC 8032 public key of a seed. noble only decodes those
// bytes into the point the circuits take.
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const opensslPublicKey = (seed: Uint8Array): Uint8Array => {
  const spki = createPublicKey(createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' }))
    .export({ format: 'der', type: 'spki' });
  assert.equal(spki.length, 44);
  return new Uint8Array(spki.subarray(12));
};
const pointOf = (key: Uint8Array) => { const { x, y } = ed25519.Point.fromBytes(key, false).toAffine(); return { x, y }; };
// The ed25519 class's key arguments: the point, its encoding's bytes and its
// x-coordinate's 32 bytes little-endian (Vector<32, Uint<8>> crosses the
// generated JavaScript as an array of bigint).
const u8v = (b: Uint8Array): bigint[] => [...b].map(BigInt);
const kin = (key: Uint8Array): [{ x: bigint; y: bigint }, bigint[], bigint[]] => {
  const p = pointOf(key);
  return [p, u8v(key), u8v(le(p.x, 32))];
};
// The ed25519 class returns [key, value]: the key must be the RFC 8032
// encoding the recipe hashed; the value is compared.
const keyed = (key: Uint8Array, r: [Uint8Array, Uint8Array]): Uint8Array => {
  assert.ok(eq(r[0], key), `the ed25519 class returns the key it hashed (${hex(r[0])} != ${hex(key)})`);
  return r[1];
};
// A seeded key whose x is odd (bit 255 of its encoding set) on odd i, even on
// even i, so every recipe is checked with both values of the sign bit.
const solKey = (i: number): { seed: Uint8Array; key: Uint8Array; point: { x: bigint; y: bigint } } => {
  for (;;) {
    const seed = rnd(32), key = opensslPublicKey(seed);
    if (((key[31] >> 7) & 1) === i % 2) return { seed, key, point: pointOf(key) };
  }
};

// ── Report ──────────────────────────────────────────────────────────────────

interface RecipeResult { vectors: number; agree: number; first: unknown[] }
const report: {
  suite: string; seed: string; ranAt: string; tags: unknown[];
  legacy: Record<string, RecipeResult>; fresh: Record<string, RecipeResult>;
  refusals: Record<string, { cases: number; refused: number }>;
  controls: Record<string, boolean>; verdict: string;
} = {
  suite: 'wallet-arms-descriptors-offline', seed: SEED, ranAt: new Date().toISOString(),
  tags: [], legacy: {}, fresh: {}, refusals: {}, controls: {}, verdict: 'FAIL',
};

function recipe(
  table: Record<string, RecipeResult>, name: string,
  run: (i: number) => { values: Uint8Array[]; vector: Record<string, unknown> },
): void {
  const r: RecipeResult = { vectors: VECTORS, agree: 0, first: [] };
  for (let i = 0; i < VECTORS; i++) {
    const { values, vector } = run(i);
    const all = values.every((v) => eq(v, values[0]));
    assert.ok(all, `${name} #${i}: ${values.map(hex).join(' / ')}`);
    r.agree++;
    if (r.first.length < 3) r.first.push({ i, ...vector, result: hex(values[0]) });
  }
  table[name] = r;
  console.log(`  ✓ ${name}: ${r.agree}/${VECTORS}`);
}

// ── 1. Tags ─────────────────────────────────────────────────────────────────

console.log('\n── tags');
const TAGS: [string, () => Uint8Array, string][] = [
  ['device', probe.device_tag_jubjub, 'midnight:account:device:v1'],
  ['device', probe.device_tag_k256, 'midnight:account:device:k1:v2'],
  ['device', probe.device_tag_p256, 'midnight:account:device:r1:v2'],
  ['device', probe.device_tag_evm_eip712, 'midnight:account:device:evm:v1'],
  ['device', probe.device_tag_sol_ed25519, 'midnight:account:device:sol:v1'],
  ['boot', probe.boot_tag_evm_eip712, 'midnight:account:boot:evm:v1'],
  ['boot', probe.boot_tag_sol_ed25519, 'midnight:account:boot:sol:v1'],
  ['grant-id', probe.grant_id_tag_jubjub, 'midnight:account:grant:id:v1'],
  ['grant-id', probe.grant_id_tag_k256, 'midnight:account:grant:id:k1:v1'],
  ['grant-id', probe.grant_id_tag_p256, 'midnight:account:grant:id:r1:v1'],
  ['grant-id', probe.grant_id_tag_evm_eip712, 'midnight:account:grant:id:evm:v1'],
  ['grant-id', probe.grant_id_tag_sol_ed25519, 'midnight:account:grant:id:sol:v1'],
  ['blind', probe.blind_tag_evm_eip712, 'midnight:account:blind:evm:v1'],
  ['blind', probe.blind_tag_sol_ed25519, 'midnight:account:blind:sol:v1'],
  ['grant-origin', probe.grant_origin_tag, 'midnight:account:grant:origin:v1'],
  ['salt', probe.salt_tag_evm_eip712, 'midnight:account:salt:evm:v1'],
  ['salt', probe.salt_tag_sol_ed25519, 'midnight:account:salt:sol:v1'],
];
const seen = new Set<string>();
for (const [kind, f, text] of TAGS) {
  const t = f();
  assert.equal(t.length, 32, `${text}: pad width`);
  assert.ok(/^[\x21-\x7e]+$/.test(text), `${text}: visible ASCII`);
  assert.ok(text.length <= 32, `${text}: ${text.length} > 32 bytes`);
  assert.ok(eq(t, pad(32, text)), `${text}: circuit constant differs from pad(32, text)`);
  assert.ok(!seen.has(text), `${text}: registered twice`);
  seen.add(text);
  report.tags.push({ kind, text, bytes: text.length, pad: 32, margin: 32 - text.length });
}
// The readable arms' tags: markers `evm` and `sol`, both at v1.
for (const text of seen) {
  if (/:evm:/.test(text)) assert.ok(text.endsWith(':v1'), `${text}: evm tags are at v1`);
  if (/:sol:/.test(text)) assert.ok(text.endsWith(':v1'), `${text}: sol tags are at v1`);
}
console.log(`  ✓ ${TAGS.length} tags fit 32 bytes, distinct, ASCII (widest: ${Math.max(...[...seen].map((s) => s.length))} bytes)`);

// ── 2. Legacy recipes: descriptor == upstream circuit == independent SHA-256

console.log('\n── legacy recipes (descriptor by width == upstream circuit == SHA-256)');
const T = (s: string) => pad(32, s);

recipe(report.legacy, 'device entry jubjub (w64)', (i) => {
  const a = addr(), pk = jubjubPk(i), [x, y] = xy(pk), ep = pick(U32_EDGES, i, 4), ct = pick(U64_EDGES, i, 8);
  return {
    values: [
      probe.derive_descriptor_entry_w64(T('midnight:account:device:v1'), contractAddress(a), x, y, ep, ct),
      upstream.derive_device_entry_with_jubjub(contractAddress(a), pk, ep, ct),
      sha(T('midnight:account:device:v1'), a, x, y, le(ep, 4), le(ct, 8)),
    ],
    vector: { self: hex(a), x: hex(x), y: hex(y), epoch: ep, counter: ct },
  };
});
recipe(report.legacy, 'device entry k256 (w65)', (i) => {
  const a = addr(), pk = k256Pk(i), [x, y] = xy(pk), env = BigInt(i % 2), ep = pick(U32_EDGES, i, 4), ct = pick(U64_EDGES, i, 8);
  return {
    values: [
      probe.derive_descriptor_entry_w65(T('midnight:account:device:k1:v2'), contractAddress(a), x, y, env, ep, ct),
      upstream.derive_device_entry_with_k256(contractAddress(a), pk, env, ep, ct),
      sha(T('midnight:account:device:k1:v2'), a, x, y, le(env, 1), le(ep, 4), le(ct, 8)),
    ],
    vector: { self: hex(a), x: hex(x), y: hex(y), envelope: env, epoch: ep, counter: ct },
  };
});
recipe(report.legacy, 'device entry p256 (w117)', (i) => {
  const a = addr(), pk = p256Pk(i), [x, y] = xy(pk), p = policyOf(i), ep = pick(U32_EDGES, i, 4), ct = pick(U64_EDGES, i, 8);
  return {
    values: [
      probe.derive_descriptor_entry_w117(T('midnight:account:device:r1:v2'), contractAddress(a), x, y, p.rp_id_hash, p.origin, ep, ct),
      upstream.derive_device_entry_with_p256(contractAddress(a), pk, { rp_id_hash: p.rp_id_hash, origin: p.origin }, ep, ct),
      sha(T('midnight:account:device:r1:v2'), a, x, y, p.rp_id_hash, p.origin, le(ep, 4), le(ct, 8)),
    ],
    vector: { self: hex(a), x: hex(x), y: hex(y), rp_id_hash: hex(p.rp_id_hash), origin: hex(p.origin), note: p.note, epoch: ep, counter: ct },
  };
});
recipe(report.legacy, 'grant id jubjub (w64)', (i) => {
  const a = addr(), pk = jubjubPk(i), [x, y] = xy(pk), oh = rnd(32), slot = pick(SLOT_EDGES, i, 1);
  return {
    values: [
      probe.derive_descriptor_grant_id_w64(T('midnight:account:grant:id:v1'), contractAddress(a), x, y, oh, slot),
      upstream.derive_grant_id_with_jubjub(contractAddress(a), pk, oh, slot),
      sha(T('midnight:account:grant:id:v1'), a, x, y, oh, le(slot, 1)),
    ],
    vector: { self: hex(a), x: hex(x), y: hex(y), origin_hash: hex(oh), slot },
  };
});
recipe(report.legacy, 'grant id k256 (w65)', (i) => {
  const a = addr(), pk = k256Pk(i), [x, y] = xy(pk), env = BigInt(i % 2), oh = rnd(32), slot = pick(SLOT_EDGES, i, 1);
  return {
    values: [
      probe.derive_descriptor_grant_id_w65(T('midnight:account:grant:id:k1:v1'), contractAddress(a), x, y, env, oh, slot),
      upstream.derive_grant_id_with_k256(contractAddress(a), pk, env, oh, slot),
      sha(T('midnight:account:grant:id:k1:v1'), a, x, y, le(env, 1), oh, le(slot, 1)),
    ],
    vector: { self: hex(a), x: hex(x), y: hex(y), envelope: env, origin_hash: hex(oh), slot },
  };
});
recipe(report.legacy, 'grant id p256 (w64)', (i) => {
  const a = addr(), pk = p256Pk(i), [x, y] = xy(pk), oh = rnd(32), slot = pick(SLOT_EDGES, i, 1);
  return {
    values: [
      probe.derive_descriptor_grant_id_w64(T('midnight:account:grant:id:r1:v1'), contractAddress(a), x, y, oh, slot),
      upstream.derive_grant_id_with_p256(contractAddress(a), pk, oh, slot),
      sha(T('midnight:account:grant:id:r1:v1'), a, x, y, oh, le(slot, 1)),
    ],
    vector: { self: hex(a), x: hex(x), y: hex(y), origin_hash: hex(oh), slot },
  };
});
// A passkey grantee's origin_hash: the probe recipe, upstream's client
// originHash() over the same 21 bytes, and SHA-256 (authenticate_grant_with_p256
// recomputes the same expression in-circuit).
const { originHash } = await import('../wallet/signer.js');
recipe(report.legacy, 'grant origin_hash of a 21-byte passkey origin', (i) => {
  const o = i < ORIGINS.length ? new Uint8Array(Buffer.from(ORIGINS[i].origin, 'ascii')) : rnd(21).map((b) => 0x21 + (b % 94));
  return {
    values: [
      probe.derive_grant_origin_hash_origin(o),
      originHash(Buffer.from(o).toString('ascii')),
      sha(T('midnight:account:grant:origin:v1'), o),
    ],
    vector: { origin: Buffer.from(o).toString('ascii') },
  };
});

// ── 3. Readable recipes: descriptor == independent SHA-256 of the preimage ──

console.log('\n── readable recipes (descriptor == SHA-256 of the specified preimage)');
recipe(report.fresh, 'device entry evm_eip712 (w52)', (i) => {
  const a = addr(), address = rnd(20), blind = rnd(32), ep = pick(U32_EDGES, i, 4), ct = pick(U64_EDGES, i, 8);
  return {
    values: [
      probe.derive_descriptor_entry_w52(T('midnight:account:device:evm:v1'), contractAddress(a), address, blind, ep, ct),
      sha(T('midnight:account:device:evm:v1'), a, address, blind, le(ep, 4), le(ct, 8)),
    ],
    vector: { self: hex(a), address: hex(address), blind: hex(blind), epoch: ep, counter: ct },
  };
});
recipe(report.fresh, 'device entry sol_ed25519 (ed25519, by point)', (i) => {
  const a = addr(), { key, point } = solKey(i), blind = rnd(32), ep = pick(U32_EDGES, i, 4), ct = pick(U64_EDGES, i, 8);
  return {
    values: [
      keyed(key, probe.derive_descriptor_entry_ed25519(T('midnight:account:device:sol:v1'), contractAddress(a), ...kin(key), blind, ep, ct)),
      sha(T('midnight:account:device:sol:v1'), a, key, blind, le(ep, 4), le(ct, 8)),
    ],
    vector: { self: hex(a), key: hex(key), x: point.x.toString(16), y: point.y.toString(16), blind: hex(blind), epoch: ep, counter: ct },
  };
});
recipe(report.fresh, 'boot evm_eip712 (w52)', () => {
  const s = rnd(32), address = rnd(20), blind = rnd(32);
  return {
    values: [
      probe.derive_descriptor_boot_w52(T('midnight:account:boot:evm:v1'), s, address, blind),
      sha(T('midnight:account:boot:evm:v1'), s, address, blind),
    ],
    vector: { salt: hex(s), address: hex(address), blind: hex(blind) },
  };
});
recipe(report.fresh, 'boot sol_ed25519 (ed25519, by point)', (i) => {
  const s = rnd(32), { key } = solKey(i), blind = rnd(32);
  return {
    values: [
      keyed(key, probe.derive_descriptor_boot_ed25519(T('midnight:account:boot:sol:v1'), s, ...kin(key), blind)),
      sha(T('midnight:account:boot:sol:v1'), s, key, blind),
    ],
    vector: { salt: hex(s), key: hex(key), blind: hex(blind) },
  };
});
recipe(report.fresh, 'grant id evm_eip712 (w52)', (i) => {
  const a = addr(), address = rnd(20), blind = rnd(32), oh = rnd(32), slot = pick(SLOT_EDGES, i, 1);
  return {
    values: [
      probe.derive_descriptor_grant_id_w52(T('midnight:account:grant:id:evm:v1'), contractAddress(a), address, blind, oh, slot),
      sha(T('midnight:account:grant:id:evm:v1'), a, address, blind, oh, le(slot, 1)),
    ],
    vector: { self: hex(a), address: hex(address), blind: hex(blind), origin_hash: hex(oh), slot },
  };
});
recipe(report.fresh, 'grant id sol_ed25519 (ed25519, by point)', (i) => {
  const a = addr(), { key } = solKey(i), blind = rnd(32), oh = rnd(32), slot = pick(SLOT_EDGES, i, 1);
  return {
    values: [
      keyed(key, probe.derive_descriptor_grant_id_ed25519(T('midnight:account:grant:id:sol:v1'), contractAddress(a), ...kin(key), blind, oh, slot)),
      sha(T('midnight:account:grant:id:sol:v1'), a, key, blind, oh, le(slot, 1)),
    ],
    vector: { self: hex(a), key: hex(key), blind: hex(blind), origin_hash: hex(oh), slot },
  };
});
// The shared encoding (encode_public_key_with_sol_ed25519) == RFC 8032:
// Node's OpenSSL public keys of seeded secrets (both x parities), checked
// against the bytes the circuit computes from the decoded point.
recipe(report.fresh, 'Ed25519 key encoding == OpenSSL RFC 8032 public key', (i) => {
  const { seed, key, point } = solKey(i);
  return { values: [probe.encode_public_key_with_sol_ed25519(...kin(key)), key], vector: { seed: hex(seed), key: hex(key), x: point.x.toString(16), xOdd: (key[31] >> 7) & 1 } };
});
// The seam helper: one encoding, the same recipe as two single derivations.
recipe(report.fresh, 'signer entries sol_ed25519 == [key, entry(counter), entry(counter + 1)]', (i) => {
  const a = addr(), { key } = solKey(i), blind = rnd(32), ep = pick(U32_EDGES, i, 4);
  const ct = i === 0 ? 0n : i === 1 ? 0xfffffffffffffffen : bigLE(rnd(8)) % 0xffffffffffffffffn;
  const [k, e0, e1] = probe.derive_signer_entries_ed25519(contractAddress(a), ...kin(key), blind, ep, ct);
  assert.ok(eq(k, key), 'the signer key is the RFC 8032 encoding');
  assert.ok(eq(e0, probe.derive_descriptor_entry_ed25519(T('midnight:account:device:sol:v1'), contractAddress(a), ...kin(key), blind, ep, ct)[1]));
  assert.ok(eq(e1, probe.derive_descriptor_entry_ed25519(T('midnight:account:device:sol:v1'), contractAddress(a), ...kin(key), blind, ep, ct + 1n)[1]));
  return {
    values: [new Uint8Array([...e0, ...e1]),
      new Uint8Array([...sha(T('midnight:account:device:sol:v1'), a, key, blind, le(ep, 4), le(ct, 8)), ...sha(T('midnight:account:device:sol:v1'), a, key, blind, le(ep, 4), le(ct + 1n, 8))])],
    vector: { self: hex(a), key: hex(key), epoch: ep, counter: ct },
  };
});
// RFC 8032 section 7.1 (secret key -> public key) and the base point: OpenSSL
// reproduces each public key, and the circuit encodes its point to it.
{
  const RFC8032: [string, string, string][] = [
    ['TEST 1', '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'],
    ['TEST 2', '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb', '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c'],
    ['TEST 3', 'c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7', 'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025'],
    ['TEST 1024', 'f5e5767cf153319517630f226876b86c8160cc583bc013744c6bf255f5cc0ee5', '278117fc144c72340f67d0f2316e8386ceffbf2b2428c9c51fef7c597f1d426e'],
    ['TEST SHA(abc)', '833fe62409237b9d62ec77587520911e9a759cec1d19755b7da901b96dca3d42', 'ec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf'],
  ];
  const rfc: unknown[] = [];
  for (const [name, sk, pk] of RFC8032) {
    const key = Buffer.from(pk, 'hex');
    assert.ok(eq(opensslPublicKey(Buffer.from(sk, 'hex')), key), `${name}: OpenSSL reproduces the RFC public key`);
    assert.ok(eq(probe.encode_public_key_with_sol_ed25519(...kin(key)), key), `${name}: the circuit encodes the point to the RFC public key`);
    assert.ok(eq(probe.exploded_encoding_ed25519(pointOf(key)), key), `${name}: the exploded encoding gives the RFC public key`);
    rfc.push({ name, publicKey: pk, xOdd: (key[31] >> 7) & 1 });
  }
  const encB = probe.encode_public_key_with_sol_ed25519(...kin(ed25519.Point.BASE.toBytes()));
  assert.equal(hex(encB), '5866666666666666666666666666666666666666666666666666666666666666', 'the base point B (RFC 8032 section 5.1)');
  rfc.push({ name: 'base point B', publicKey: hex(encB), xOdd: 0 });
  report.fresh['RFC 8032 section 7.1 public keys and the base point'] = { vectors: rfc.length, agree: rfc.length, first: rfc };
  assert.ok(rfc.some((v: any) => v.xOdd === 1) && rfc.some((v: any) => v.xOdd === 0), 'both x parities among the RFC vectors');
  console.log(`  ✓ RFC 8032 section 7.1 public keys and the base point: ${rfc.length}/${rfc.length} (both x parities)`);
}
const LABELS = ['Midnight Night Market', 'wallet.example', 'a', 'x'.repeat(32), 'MN Bank - grants v1'];
recipe(report.fresh, 'grant origin_hash of a 32-byte label', (i) => {
  const label = i < LABELS.length ? pad(32, LABELS[i]) : rnd(32);
  return {
    values: [probe.derive_grant_origin_hash_label(label), sha(T('midnight:account:grant:origin:v1'), label)],
    vector: { label: hex(label) },
  };
});
recipe(report.fresh, 'blind evm_eip712', () => {
  const sig = rnd(64);
  return { values: [probe.derive_blind(T('midnight:account:blind:evm:v1'), sig), sha(T('midnight:account:blind:evm:v1'), sig)], vector: { signature: hex(sig) } };
});
recipe(report.fresh, 'blind sol_ed25519', () => {
  const sig = rnd(64);
  return { values: [probe.derive_blind(T('midnight:account:blind:sol:v1'), sig), sha(T('midnight:account:blind:sol:v1'), sig)], vector: { signature: hex(sig) } };
});
// the grant scope salt: the circuit, an independent SHA-256 of the preimage
// (tag, blind, account, auth_nonce as 8 bytes little-endian) and the client
for (const scheme of ['evm_eip712', 'sol_ed25519'] as const) {
  const text = scheme === 'evm_eip712' ? 'midnight:account:salt:evm:v1' : 'midnight:account:salt:sol:v1';
  assert.equal(SALT_TAGS[scheme], text, `the client's ${scheme} salt tag`);
  recipe(report.fresh, `grant scope salt ${scheme}`, (i) => {
    const blind = rnd(32), a = addr(), nonce = pick(U64_EDGES, i, 8);
    return {
      values: [probe.derive_grant_scope_salt(T(text), blind, contractAddress(a), nonce), sha(T(text), blind, a, le(nonce, 8)), grantScopeSalt(scheme, blind, a, nonce)],
      vector: { blind: hex(blind), account: hex(a), authNonce: nonce.toString() },
    };
  });
}
// every input of the salt counts: another blind, account, nonce or arm gives another salt
{
  const blind = rnd(32), a = addr(), nonce = 7n, base = grantScopeSalt('sol_ed25519', blind, a, nonce);
  const others = [grantScopeSalt('sol_ed25519', rnd(32), a, nonce), grantScopeSalt('sol_ed25519', blind, addr(), nonce),
    grantScopeSalt('sol_ed25519', blind, a, nonce + 1n), grantScopeSalt('evm_eip712', blind, a, nonce)];
  assert.ok(others.every((o) => !eq(o, base)), 'the salt depends on the blind, the account, auth_nonce and the arm');
  report.controls.saltDependsOnEveryInput = true;
  for (const [name, f] of [
    ['an unknown scheme', () => grantScopeSalt('jubjub' as any, blind, a, nonce)],
    ['a 31-byte blind', () => grantScopeSalt('sol_ed25519', blind.slice(1), a, nonce)],
    ['a 33-byte account', () => grantScopeSalt('sol_ed25519', blind, new Uint8Array(33), nonce)],
    ['auth_nonce 2^64', () => grantScopeSalt('sol_ed25519', blind, a, 1n << 64n)],
    ['a negative auth_nonce', () => grantScopeSalt('sol_ed25519', blind, a, -1n)],
  ] as [string, () => unknown][]) assert.throws(f, /descriptor:/, `the client refuses ${name}`);
  report.refusals.grantScopeSaltClient = { cases: 5, refused: 5 };
  console.log('  ✓ the grant scope salt depends on the blind, the account, auth_nonce and the arm; the client refuses 5 malformed inputs');
}

// ── 4. The checked encoding against the exploded one ────────────────────────

console.log('\n── the checked Ed25519 encoding against the exploded encoding');
{
  const P_ED = ed25519.Point.Fp.ORDER;
  const Fp = ed25519.Point.Fp;
  const D = ed25519.Point.CURVE().d;
  // Subgroup points with a small y (y = k) or a y just below p (y = p - k),
  // and with a small x: the encodings whose bytes sit at their limits. No
  // subgroup point other than the identity has y or x below 19, so the
  // identity carries the y + p and x + p cases where those still fit 255
  // bits.
  const subgroup = (x: bigint, y: bigint): Uint8Array | undefined => {
    try {
      const pt = ed25519.Point.fromAffine({ x, y });
      pt.assertValidity();
      return pt.isTorsionFree() && !pt.is0() ? pt.toBytes() : undefined;
    } catch { return undefined; }
  };
  const fromY = (y: bigint): Uint8Array[] => {
    const u = Fp.div(Fp.sub(Fp.mul(y, y), 1n), Fp.add(Fp.mul(D, Fp.mul(y, y)), 1n));
    let x: bigint; try { x = Fp.sqrt(u); } catch { return []; }
    return [x, Fp.neg(x)].map((xx) => subgroup(xx, y)).filter((k): k is Uint8Array => k !== undefined);
  };
  const fromX = (x: bigint): Uint8Array[] => {
    const v = Fp.div(Fp.add(1n, Fp.mul(x, x)), Fp.sub(1n, Fp.mul(D, Fp.mul(x, x))));
    let y: bigint; try { y = Fp.sqrt(v); } catch { return []; }
    return [y, Fp.neg(y)].map((yy) => subgroup(x, yy)).filter((k): k is Uint8Array => k !== undefined);
  };
  const smallY: Uint8Array[] = [], highY: Uint8Array[] = [], smallX: Uint8Array[] = [];
  for (let k = 2n; k < 200n; k++) { smallY.push(...fromY(k)); highY.push(...fromY(P_ED - k)); smallX.push(...fromX(k - 1n)); }
  for (let k = 2n; k < 19n; k++) assert.equal(fromY(k).length + fromX(k - 1n).length, 0, `no subgroup point with y = ${k} or x = ${k - 1n}`);
  assert.ok(smallY.length > 0 && highY.length > 0 && smallX.length > 0, 'edge keys exist in the subgroup');
  const IDENTITY = Uint8Array.from([1, ...new Array(31).fill(0)]);
  const seeded = Array.from({ length: 64 }, (_, i) => solKey(i).key);
  const all: [string, Uint8Array][] = [
    ...seeded.map((k, i) => [`seeded ${i}`, k] as [string, Uint8Array]),
    ...smallY.map((k) => [`small y (${hex(k).slice(0, 4)}…)`, k] as [string, Uint8Array]),
    ...highY.map((k) => [`y just below p (…${hex(k).slice(60)})`, k] as [string, Uint8Array]),
    ...smallX.map((k) => [`small x (${hex(k).slice(0, 8)}…)`, k] as [string, Uint8Array]),
    ['the base point', ed25519.Point.BASE.toBytes()],
    ['the identity (y = 1, x = 0)', IDENTITY],
  ];
  let odd = 0;
  for (const [name, key] of all) {
    const [pt] = name.startsWith('the identity') ? [{ x: 0n, y: 1n }] : kin(key);
    const exploded = probe.exploded_encoding_ed25519(pt);
    const checked = probe.encode_public_key_with_sol_ed25519(pt, u8v(key), u8v(le(pt.x, 32)));
    assert.ok(eq(exploded, key), `${name}: the exploded encoding is the key`);
    assert.ok(eq(checked, exploded), `${name}: the checked encoding equals the exploded one`);
    odd += (key[31] >> 7) & 1;
  }
  assert.ok(odd > 0 && odd < all.length, 'both x parities');
  report.fresh['checked encoding == exploded encoding'] = {
    vectors: all.length, agree: all.length,
    first: [{ smallY: smallY.map(hex), highY: highY.map(hex), smallX: smallX.map(hex), identity: hex(IDENTITY), xOdd: odd }],
  };
  // Inputs other than the point's own bytes.
  const forged: [string, () => unknown, RegExp][] = [];
  const keyOf = (k: Uint8Array): [{ x: bigint; y: bigint }, bigint[], bigint[]] =>
    eq(k, IDENTITY) ? [{ x: 0n, y: 1n }, u8v(k), new Array(32).fill(0n)] : kin(k);
  for (const [name, key] of [['seeded', seeded[1]], ['seeded, x odd', seeded.find((k) => k[31] & 0x80)!], ['small y', smallY[0]],
    ['y just below p', highY[0]], ['small x', smallX[0]], ['the identity', IDENTITY]] as [string, Uint8Array][]) {
    const [pt, kb, kx] = keyOf(key);
    for (const i of [0, 15, 30]) {
      const b = [...kb]; b[i] ^= 1n;
      forged.push([`${name}: key byte ${i} flipped`, () => probe.encode_public_key_with_sol_ed25519(pt, b, kx), /key bytes do not match the point's y/]);
      const x = [...kx]; x[i] ^= 1n;
      forged.push([`${name}: x byte ${i} flipped`, () => probe.encode_public_key_with_sol_ed25519(pt, kb, x), /x bytes do not match the point's x/]);
    }
    const s = [...kb]; s[31] ^= 0x80n;
    forged.push([`${name}: the other sign bit`, () => probe.encode_public_key_with_sol_ed25519(pt, s, kx), /sign bit is not x's parity/]);
    const t = [...kb]; t[31] ^= 0x01n;
    forged.push([`${name}: y's top byte changed`, () => probe.encode_public_key_with_sol_ed25519(pt, t, kx), /key bytes do not match the point's y/]);
    const yp = u8v(le(pt.y + P_ED, 32)); yp[31] += kb[31] & 0x80n;
    if (yp[31] <= 255n) forged.push([`${name}: y + p`, () => probe.encode_public_key_with_sol_ed25519(pt, yp, kx), /key bytes do not match the point's y|sign bit/]);
    forged.push([`${name}: x + p`, () => probe.encode_public_key_with_sol_ed25519(pt, kb, u8v(le(pt.x + P_ED, 32))), /x bytes do not match the point's x/]);
    const c = [...kb]; c[3] += 256n; c[4] -= 1n;
    if (c[4] >= 0n) forged.push([`${name}: carry (byte 3 + 256, byte 4 - 1)`, () => probe.encode_public_key_with_sol_ed25519(pt, c, kx), /type error: .*expected value of type Vector<32, Uint<0\.\.256>>/]);
    const cx = [...kx]; cx[3] += 256n; cx[4] -= 1n;
    if (cx[4] >= 0n) forged.push([`${name}: x carry (byte 3 + 256, byte 4 - 1)`, () => probe.encode_public_key_with_sol_ed25519(pt, kb, cx), /type error: .*expected value of type Vector<32, Uint<0\.\.256>>/]);
  }
  for (const [name, f, why] of forged) assert.throws(f, why, `refused: ${name}`);
  report.refusals.ed25519_checked_encoding = { cases: forged.length, refused: forged.length };
  console.log(`  ✓ checked == exploded == the key for ${all.length} keys (${seeded.length} seeded, ${smallY.length} with a small y, ${highY.length} with y just below p, ${smallX.length} with a small x, the base point, the identity; ${odd} with x odd); ${forged.length} forged inputs refused`);
}

// ── 5. Refusals ─────────────────────────────────────────────────────────────

console.log('\n── refusals (tags are not free-form)');
const A = contractAddress(rnd(32)), B32 = rnd(32), B20 = rnd(20), B21 = rnd(21), PTK = kin(solKey(0).key), PT = PTK[0];
const derivations: Record<string, { allowed: string[]; run: (tag: Uint8Array) => unknown }> = {
  entry_w52: { allowed: ['midnight:account:device:evm:v1'], run: (t) => probe.derive_descriptor_entry_w52(t, A, B20, B32, 0n, 0n) },
  entry_w64: { allowed: ['midnight:account:device:v1'], run: (t) => probe.derive_descriptor_entry_w64(t, A, B32, B32, 0n, 0n) },
  entry_ed25519: { allowed: ['midnight:account:device:sol:v1'], run: (t) => probe.derive_descriptor_entry_ed25519(t, A, ...PTK, B32, 0n, 0n) },
  entry_w65: { allowed: ['midnight:account:device:k1:v2'], run: (t) => probe.derive_descriptor_entry_w65(t, A, B32, B32, 0n, 0n, 0n) },
  entry_w117: { allowed: ['midnight:account:device:r1:v2'], run: (t) => probe.derive_descriptor_entry_w117(t, A, B32, B32, B32, B21, 0n, 0n) },
  boot_w52: { allowed: ['midnight:account:boot:evm:v1'], run: (t) => probe.derive_descriptor_boot_w52(t, B32, B20, B32) },
  boot_ed25519: { allowed: ['midnight:account:boot:sol:v1'], run: (t) => probe.derive_descriptor_boot_ed25519(t, B32, ...PTK, B32) },
  grant_id_w52: { allowed: ['midnight:account:grant:id:evm:v1'], run: (t) => probe.derive_descriptor_grant_id_w52(t, A, B20, B32, B32, 0n) },
  grant_id_w64: { allowed: ['midnight:account:grant:id:v1', 'midnight:account:grant:id:r1:v1'], run: (t) => probe.derive_descriptor_grant_id_w64(t, A, B32, B32, B32, 0n) },
  grant_id_ed25519: { allowed: ['midnight:account:grant:id:sol:v1'], run: (t) => probe.derive_descriptor_grant_id_ed25519(t, A, ...PTK, B32, B32, 0n) },
  grant_id_w65: { allowed: ['midnight:account:grant:id:k1:v1'], run: (t) => probe.derive_descriptor_grant_id_w65(t, A, B32, B32, 0n, B32, 0n) },
  blind: { allowed: ['midnight:account:blind:evm:v1', 'midnight:account:blind:sol:v1'], run: (t) => probe.derive_blind(t, rnd(64)) },
  grant_scope_salt: { allowed: ['midnight:account:salt:evm:v1', 'midnight:account:salt:sol:v1'], run: (t) => probe.derive_grant_scope_salt(t, B32, A, 0n) },
};
// Candidate tags: every registered tag, plus upstream's own boot tags (a
// `jubjub`, `k256`, or `p256` first device boots through upstream's circuits,
// so no derivation here takes them), and unknown, unregistered-version,
// space-padded, upper-case and all-zero tags.
const UPSTREAM_BOOT_TAGS = ['midnight:account:boot:v1', 'midnight:account:boot:k1:v2', 'midnight:account:boot:r1:v2'];
const spacePadded = (s: string) => { const o = new Uint8Array(32).fill(0x20); o.set(Buffer.from(s, 'ascii')); return o; };
const candidates: [string, Uint8Array][] = [
  ...[...seen].map((s) => [s, pad(32, s)] as [string, Uint8Array]),
  ...UPSTREAM_BOOT_TAGS.map((s) => [`(upstream's own boot tag) ${s}`, pad(32, s)] as [string, Uint8Array]),
  ['(unknown) midnight:account:device:ed:v1', pad(32, 'midnight:account:device:ed:v1')],
  ['(unknown, the retired evm:v2) midnight:account:device:evm:v2', pad(32, 'midnight:account:device:evm:v2')],
  ['(unknown) midnight:account:device:sol:v2', pad(32, 'midnight:account:device:sol:v2')],
  ['(unknown) MIDNIGHT:ACCOUNT:DEVICE:V1', pad(32, 'MIDNIGHT:ACCOUNT:DEVICE:V1')],
  ['(non-canonical padding) midnight:account:device:v1 + spaces', spacePadded('midnight:account:device:v1')],
  ['(all zero)', new Uint8Array(32)],
  ['(random)', rnd(32)],
];
let refusalCases = 0, refusalsSeen = 0, acceptsSeen = 0, upstreamBootRefused = 0;
for (const [fname, d] of Object.entries(derivations)) {
  let cases = 0, refused = 0;
  for (const [label, tag] of candidates) {
    const allowed = d.allowed.some((s) => eq(pad(32, s), tag));
    if (allowed) {
      assert.doesNotThrow(() => d.run(tag), `${fname} must accept ${label}`);
      acceptsSeen++;
      continue;
    }
    cases++;
    assert.throws(() => d.run(tag), /failed assert: descriptor: not a/, `${fname} must refuse ${label}`);
    refused++;
    if (label.startsWith("(upstream's own boot tag)")) upstreamBootRefused++;
  }
  report.refusals[fname] = { cases, refused };
  refusalCases += cases; refusalsSeen += refused;
}
assert.equal(acceptsSeen, Object.values(derivations).reduce((n, d) => n + d.allowed.length, 0));
// Upstream's boot tags: refused by every derivation, the two boot ones included.
assert.equal(upstreamBootRefused, UPSTREAM_BOOT_TAGS.length * Object.keys(derivations).length);
report.refusals.upstreamBootTags = { cases: upstreamBootRefused, refused: upstreamBootRefused };
console.log(`  ✓ ${refusalsSeen}/${refusalCases} wrong-tag cases refused at the generated JavaScript (each registered tag accepted only by its own recipe and width; upstream's ${UPSTREAM_BOOT_TAGS.length} boot tags refused by all ${Object.keys(derivations).length} derivations, ${upstreamBootRefused} cases)`);

// A passkey whose descriptor carries the wrong RP (a mismatched rp_id_hash)
// derives an entry other than the one the passkey can use: the derivation
// does not "correct" the policy, and the p256 seam would refuse the passkey's
// assertions against it (authenticator data RP mismatch).
{
  const a = addr(), pk = p256Pk(10), [x, y] = xy(pk), origin = new Uint8Array(Buffer.from('https://a.example.com', 'ascii'));
  const right = sha(Buffer.from('example.com', 'ascii'));
  const wrong = sha(Buffer.from('a.example.org', 'ascii'));
  const usable = upstream.derive_device_entry_with_p256(contractAddress(a), pk, { rp_id_hash: right, origin }, 0n, 0n);
  const viaRight = probe.derive_descriptor_entry_w117(T('midnight:account:device:r1:v2'), contractAddress(a), x, y, right, origin, 0n, 0n);
  const viaWrong = probe.derive_descriptor_entry_w117(T('midnight:account:device:r1:v2'), contractAddress(a), x, y, wrong, origin, 0n, 0n);
  assert.ok(eq(viaRight, usable), 'parent-domain RP: the descriptor entry is the passkey\'s usable entry');
  assert.ok(!eq(viaWrong, usable), 'mismatched RP: the descriptor entry is not the passkey\'s usable entry');
  report.controls.parentDomainRpPositive = true;
  report.controls.mismatchedRpNegative = true;
  console.log('  ✓ parent-domain RP (example.com for https://a.example.com) derives the usable entry; a mismatched RP does not');
}

// The ed25519 class takes a point: the identity passes the point type (it is
// in the prime-order subgroup) and is refused by the A != O assert of every
// derivation; small-order and mixed-order points never pass the type. The
// constraint-level refusals are in constraint-negative-prover.ts.
{
  const O = { x: 0n, y: 1n };
  const OK: [{ x: bigint; y: bigint }, bigint[], bigint[]] = [O, [1n, ...new Array(31).fill(0n)], new Array(32).fill(0n)];
  let typed = true;
  try { probe.encode_public_key_with_sol_ed25519(...OK); } catch { typed = false; }
  assert.ok(typed, 'the identity passes the Curve25519Point type');
  assert.equal(hex(probe.encode_public_key_with_sol_ed25519(...OK)), '01' + '00'.repeat(31), 'the identity encodes as RFC 8032 says (y = 1)');
  assert.equal(hex(probe.exploded_encoding_ed25519(O)), '01' + '00'.repeat(31), 'the exploded encoding agrees on the identity');
  const idRefused: [string, () => unknown][] = [
    ['entry', () => probe.derive_descriptor_entry_ed25519(T('midnight:account:device:sol:v1'), A, ...OK, B32, 0n, 0n)],
    ['boot', () => probe.derive_descriptor_boot_ed25519(T('midnight:account:boot:sol:v1'), B32, ...OK, B32)],
    ['grant id', () => probe.derive_descriptor_grant_id_ed25519(T('midnight:account:grant:id:sol:v1'), A, ...OK, B32, B32, 0n)],
    ['signer entries', () => probe.derive_signer_entries_ed25519(A, ...OK, B32, 0n, 0n)],
  ];
  for (const [name, f] of idRefused) assert.throws(f, /failed assert: descriptor: the Ed25519 key is the identity/, `${name}: the identity is refused`);
  const degenerate: [string, { x: bigint; y: bigint }][] = [];
  for (const t of ED25519_TORSION_SUBGROUP.slice(1)) {
    const p = ed25519.Point.fromBytes(Buffer.from(t, 'hex'), true);
    if (!p.is0()) degenerate.push([`small order ${t.slice(0, 8)}…`, p.toAffine()]);
  }
  const T8 = ed25519.Point.fromBytes(Buffer.from(ED25519_TORSION_SUBGROUP[1], 'hex'), true);
  for (let i = 0; i < 4; i++) degenerate.push([`mixed order A + T (${i})`, ed25519.Point.fromBytes(solKey(i).key).add(T8).toAffine()]);
  const P_ED = ed25519.Point.Fp.ORDER;
  degenerate.push(['coordinate y + p (not canonical)', { x: PT.x, y: PT.y + P_ED }]);
  for (const [name, pt] of degenerate) {
    assert.throws(() => probe.derive_descriptor_entry_ed25519(T('midnight:account:device:sol:v1'), A, pt, PTK[1], PTK[2], B32, 0n, 0n), /Curve25519Point/, `${name}: refused by the point type`);
  }
  report.refusals.ed25519_identity = { cases: idRefused.length, refused: idRefused.length };
  report.refusals.ed25519_point_type = { cases: degenerate.length, refused: degenerate.length };
  console.log(`  ✓ the identity point passes the type and is refused by A != O in ${idRefused.length} derivations; ${degenerate.length} small-order, mixed-order and non-canonical points refused by the point type`);
}

// ── 6. Comparator controls ──────────────────────────────────────────────────

{
  const a = addr(), { key, point } = solKey(1), blind = rnd(32);
  const good = probe.derive_descriptor_entry_ed25519(T('midnight:account:device:sol:v1'), contractAddress(a), ...kin(key), blind, 3n, 9n)[1];
  report.controls.splitDifferently = eq(good, sha(T('midnight:account:device:sol:v1'), a, Buffer.concat([key, blind]), le(3n, 4), le(9n, 8)));
  report.controls.counterOffByOne = !eq(good, sha(T('midnight:account:device:sol:v1'), a, key, blind, le(3n, 4), le(10n, 8)));
  report.controls.minimalWidthIntegers = !eq(good, sha(T('midnight:account:device:sol:v1'), a, key, blind, Buffer.from([3]), Buffer.from([9])));
  report.controls.blindOmitted = !eq(good, sha(T('midnight:account:device:sol:v1'), a, key, le(3n, 4), le(9n, 8)));
  report.controls.otherArmTag = !eq(good, sha(T('midnight:account:device:v1'), a, key, blind, le(3n, 4), le(9n, 8)));
  // The encoding's sign bit is bound: the same y without x's parity, and the
  // y coordinate big-endian, give other entries.
  const noSign = Uint8Array.from(key); noSign[31] &= 0x7f;
  report.controls.signBitBound = (key[31] & 0x80) !== 0 && !eq(good, sha(T('midnight:account:device:sol:v1'), a, noSign, blind, le(3n, 4), le(9n, 8)));
  report.controls.encodingNotBigEndianY = !eq(good, sha(T('midnight:account:device:sol:v1'), a, le(point.y, 32).reverse(), blind, le(3n, 4), le(9n, 8)));
  for (const [k, v] of Object.entries(report.controls)) assert.ok(v, `comparator control ${k}`);
  console.log(`  ✓ comparator controls: ${Object.keys(report.controls).join(', ')}`);
}

report.verdict = 'PASS';
if (process.env.EVIDENCE_DIR) {
  const file = path.join(process.env.EVIDENCE_DIR, 'wallet-arms-descriptors-offline.json');
  fs.mkdirSync(process.env.EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
  console.log(`\n■ evidence → ${file}`);
}
console.log('\n◆ wallet-arms-descriptors-offline: PASS');
