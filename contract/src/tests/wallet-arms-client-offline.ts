// Offline suite for the readable-arm client helpers: src/wallet/descriptors.ts
// (descriptor encoders and strict decoders) and src/wallet/blind.ts (the blind
// request message, the canonical signature forms, the restore over the arm's
// formats and the signer check).
//
//   tags         the client's tag tables equal the module's constants; every
//                readable table (tags, blind and salt tags, classes, widths,
//                boot schemes, blind schemes) is read from the registry of
//                readable arms, and the registry refuses every other value
//   parsers      EIP-55 addresses, base58 Solana keys with RFC 8032 strict
//                decoding (identity, small-order, mixed-order, non-canonical
//                and off-curve points refused) and their Curve25519Point
//                (the ed25519 class argument; the same rules from
//                coordinates), SEC1 secp256k1 and P-256 keys,
//                passkey policies (parent-domain RP accepted, a mismatched RP
//                refused), and JubJub points
//   encoders     every scheme and recipe, run through the probe, equals
//                upstream's own circuit (legacy schemes) or SHA-256 of the
//                specified preimage (readable schemes; a Solana key passed as
//                its point with its encoding and x-coordinate as byte
//                vectors, hashed as its RFC 8032 bytes); the decoder inverts
//                the encoder and refuses unknown tags, other recipes' tags,
//                upstream's own boot tags, wrong widths, a Solana key as
//                bytes, byte vectors that are not the point's, and
//                inadmissible keys
//   boot         a boot commitment is the readable schemes' only: a
//                `jubjub`, `k256`, or `p256` boot is refused by
//                bootCall, payloadParts, and describeDescriptor with
//                upstream's circuit named, before any other check; the two
//                readable schemes still boot (positive control)
//   display      the shown lines, including the two labelled values; every
//                scheme's comparison display equals the bytes the circuit
//                binds in the display byte order (secp256k1 and P-256
//                coordinates big-endian, as SEC1; JubJub little-endian) and
//                the values the frozen evm_k256 approvals show
//   blind        golden request messages, input refusals, low-S EVM and
//                strict Ed25519 canonical forms, the sign-twice check against
//                a deterministic and a hedged signer, and derive_blind
//   grantee      the grantee blind request: golden text, input refusals,
//                first lines unlike the device request's; for one wallet per
//                scheme, no grantee blind equals any of its device blinds,
//                and each issuing account (and network) gives its own grantee
//                blind, under the same blind tag
//   formats      each readable arm's signing formats (the registry's
//                `formats`): codes, names and order; every other value
//                refused
//   restore      restoreBlind: a cached blind is used without a signature;
//                the stored format re-derives the blind, which is used only
//                when it finds the device (a wallet that derives another
//                blind in that format is refused with the remedy), and a
//                wallet that cannot sign it is asked for nothing and told
//                which format is needed; without a record every format the
//                wallet signs is tried and each match listed, and a failure
//                names the formats tried and those the device may have been
//                enrolled through; grantee wording; user story 4, scenario 2
//                with real Ed25519 signatures (a raw blind is never derived
//                from an off-chain-only wallet); the same key and format
//                through a deterministic wallet with another nonce rule
//                (Ed25519 and EIP-191 secp256k1, real signatures) refused,
//                the enrolling wallet restored; malformed requests refused
//                before the wallet is asked
//   signer       checkSigner: the expected signer passes; any other is
//                refused before proving, naming another key only when the
//                signature verifies under it (the key a wallet reports is
//                never named on its word), for Solana (strict RFC 8032) and
//                EVM (address recovery)
//   unknown      an unknown descriptor or blind scheme (unregistered, a
//                typo, another case, an Object.prototype key, a number,
//                none) is refused at client decode by every function that
//                dispatches on the scheme; a non-object descriptor and a
//                missing tag text are refused; every registered scheme
//                still passes (positive control)
//
// Writes $EVIDENCE_DIR/wallet-arms-client-offline.json when EVIDENCE_DIR is
// set; never writes into the repository.

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { p256 } from '@noble/curves/nist.js';
import { ed25519, ED25519_TORSION_SUBGROUP } from '@noble/curves/ed25519.js';
import { jubjub } from '@noble/curves/misc.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { pureCircuits as probe } from '../../contracts/managed/probe-wallet-arms-base/contract/index.js';
import { pureCircuits as upstream } from '../wallet/contract.js';
import {
  DESCRIPTOR_SCHEMES, BOOT_SCHEMES, DESCRIPTOR_TAGS, BLIND_TAGS, GRANT_ORIGIN_TAG, PAYLOAD_WIDTH, DESCRIPTOR_CLASS,
  solanaKeyPoint, solanaKeyFromPoint, solanaKeyInputs,
  padTag, tagOf, evmChecksumAddress, parseEvmAddress, evmAddressOf, base58Encode, base58Decode,
  parseSolanaPublicKey, parseK256Descriptor, parseP256Descriptor, parseJubjubPoint, evmDescriptor,
  solDescriptor, checkDescriptor, payloadParts, entryCall, bootCall, grantIdCall, derive, decodeDescriptor,
  describeDescriptor, privacySaltLabel, grantOriginHash, grantLabel, COORDINATE_DISPLAY_ORDER, coordinateHex,
  READABLE_ARMS, READABLE_SCHEMES, LEGACY_SCHEMES, SALT_TAGS, readableArm, readableDescriptor,
  type Descriptor, type DescriptorRecipe, type DescriptorScheme,
} from '../wallet/descriptors.js';
import {
  blindMessage, blindMessageBytes, canonicalEvmSignature, canonicalEd25519Signature,
  sameCanonicalSignature, deriveBlind, blindCall, granteeBlindMessage, granteeBlindMessageBytes,
  canonicalSignature, BLIND_SCHEMES, type GranteeBlindRequest, type BlindScheme,
  blindFormats, blindFormatName, checkBlindFormat, restoreBlind, checkSigner, SignerMismatchError,
} from '../wallet/blind.js';

const SEED = 'wallet-arms-base/v1/wallet-arms-client-offline';
let ctr = 0;
const rnd = (n: number): Uint8Array => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 32) out.set(createHash('sha256').update(SEED).update(String(ctr++)).digest().subarray(0, Math.min(32, n - i)), i);
  return out;
};
const sha = (...p: Uint8Array[]) => { const h = createHash('sha256'); for (const x of p) h.update(x); return new Uint8Array(h.digest()); };
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (s: string) => new Uint8Array(Buffer.from(s.replace(/^0x/, ''), 'hex'));
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const le = (v: bigint, w: number) => { const o = new Uint8Array(w); let x = v; for (let i = 0; i < w; i++) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const bigLE = (b: Uint8Array) => { let v = 0n; for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return v; };
const ascii = (v: bigint[]) => String.fromCharCode(...v.map(Number));

const tally: Record<string, { pass: number; refused: number }> = {};
const ok = (k: string) => { (tally[k] ??= { pass: 0, refused: 0 }).pass++; };
// `expected` is a pattern tested against String(error), or a validation
// function that returns true for the expected error.
const refused = (k: string, f: () => unknown, expected: RegExp | ((e: unknown) => boolean), why: string) => {
  assert.throws(f, expected, `${k}: must refuse ${why}`);
  (tally[k] ??= { pass: 0, refused: 0 }).refused++;
};

// The recipes each scheme has: a boot commitment for the readable schemes only.
const RECIPES: readonly DescriptorRecipe[] = ['device', 'boot', 'grant-id'];
const boots = (scheme: DescriptorScheme) => (BOOT_SCHEMES as readonly string[]).includes(scheme);
const recipesOf = (scheme: DescriptorScheme): DescriptorRecipe[] => RECIPES.filter((r) => r !== 'boot' || boots(scheme));
const schemesOf = (r: DescriptorRecipe): readonly DescriptorScheme[] => (r === 'boot' ? BOOT_SCHEMES : DESCRIPTOR_SCHEMES);
// The refusal of a legacy boot: an Error whose message ends by naming
// upstream's circuit and the refusing function `where`.
const legacyBoot = (scheme: string, where: string) => (e: unknown) =>
  e instanceof Error && e.message.endsWith(`descriptor: ${scheme} boots through upstream's derive_boot_commitment_with_${scheme}, not through a descriptor (${where})`);

// ── Tags ─────────────────────────────────────────────────────────────────────

const probeTag = (recipe: string, scheme: string): Uint8Array => (probe as any)[`${recipe.replace('-', '_')}_tag_${scheme}`]();
assert.deepEqual(Object.keys(DESCRIPTOR_TAGS), [...RECIPES]);
for (const recipe of Object.keys(DESCRIPTOR_TAGS) as DescriptorRecipe[]) {
  assert.deepEqual(Object.keys(DESCRIPTOR_TAGS[recipe]), [...schemesOf(recipe)], `${recipe}: the tag table has exactly its schemes`);
  for (const scheme of schemesOf(recipe)) {
    assert.ok(eq(padTag(DESCRIPTOR_TAGS[recipe][scheme]), probeTag(recipe, scheme)), `${recipe}/${scheme} tag`);
    const t = tagOf(probeTag(recipe, scheme));
    assert.equal(t.recipe, recipe); assert.equal(t.scheme, scheme);
    ok('tags');
  }
}
assert.ok(eq(padTag(BLIND_TAGS.evm_k256), probe.blind_tag_evm_k256()));
assert.ok(eq(padTag(BLIND_TAGS.sol_ed25519), probe.blind_tag_sol_ed25519()));
assert.ok(eq(padTag(GRANT_ORIGIN_TAG), probe.grant_origin_tag()));
refused('tags', () => tagOf(padTag('midnight:account:device:ed:v1')), /unregistered tag/, 'an unregistered tag');
refused('tags', () => tagOf(new Uint8Array(32).fill(0x20).map((c, i) => 'midnight:account:device:v1'.charCodeAt(i) || c)), /unregistered tag/, 'a space-padded tag');
refused('tags', () => padTag('midnight:account:grant:id:evm:v10'), /exceeds 32 bytes/, 'a 33-byte tag');
// Upstream's own boot tags are not descriptor tags (no derivation here takes them).
for (const t of ['midnight:account:boot:v1', 'midnight:account:boot:k1:v2', 'midnight:account:boot:r1:v2']) {
  refused('tags', () => tagOf(padTag(t)), /unregistered tag/, `upstream's boot tag ${t}`);
}
// The registry of readable arms: every readable table and list follows from
// it, in registry order, and it refuses every other value.
assert.deepEqual([...DESCRIPTOR_SCHEMES], [...LEGACY_SCHEMES, ...READABLE_SCHEMES]);
assert.deepEqual([...BOOT_SCHEMES], [...READABLE_SCHEMES]);
assert.deepEqual([...BLIND_SCHEMES], [...READABLE_SCHEMES]);
for (const scheme of READABLE_SCHEMES) {
  const arm = READABLE_ARMS[scheme];
  assert.equal(readableArm(scheme), arm);
  assert.equal(DESCRIPTOR_TAGS.device[scheme], arm.tags.device);
  assert.equal(DESCRIPTOR_TAGS.boot[scheme], arm.tags.boot);
  assert.equal(DESCRIPTOR_TAGS['grant-id'][scheme], arm.tags['grant-id']);
  assert.equal(BLIND_TAGS[scheme], arm.tags.blind);
  assert.equal(SALT_TAGS[scheme], arm.tags.salt);
  for (const r of RECIPES) {
    assert.equal(DESCRIPTOR_CLASS[r][scheme], arm.payloadClass, `${scheme}/${r} class`);
    assert.equal(PAYLOAD_WIDTH[r][scheme], arm.payloadClass === 'w52' ? 52 : 64, `${scheme}/${r} width`);
  }
  for (const text of Object.values(arm.tags)) assert.ok(text.endsWith(`:${arm.code}:v1`), `${scheme}: ${text} carries the code ${arm.code}`);
  ok('tags');
}
for (const v of [...LEGACY_SCHEMES, 'zz', 'EVM_K256', 'sol_ed25519 ', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 1, undefined, null]) {
  assert.equal(readableArm(v), undefined, `readableArm refuses ${String(v)}`);
  refused('tags', () => readableDescriptor(v as any, new Uint8Array(20).fill(1), new Uint8Array(32).fill(2)), /descriptor: unknown scheme .* in readableDescriptor/, `a readable descriptor of ${String(v)}`);
}
console.log(`  ✓ tags: client tables equal the module's constants (${tally.tags.pass}); ${tally.tags.refused} malformed tags and non-readable schemes refused`);

// ── Parsers ──────────────────────────────────────────────────────────────────

// EIP-55 (the EIP's own examples).
for (const a of ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
  '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB', '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb']) {
  assert.equal(evmChecksumAddress(parseEvmAddress(a)), a);
  assert.equal(evmChecksumAddress(parseEvmAddress(a.toLowerCase())), a);
  assert.equal(evmChecksumAddress(parseEvmAddress('0x' + a.slice(2).toUpperCase())), a);
  ok('evm address');
}
assert.equal(evmChecksumAddress(evmAddressOf(secp256k1.Point.BASE.toAffine())), '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
refused('evm address', () => parseEvmAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD'), /checksum/, 'a wrong checksum');
refused('evm address', () => parseEvmAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAe'), /40 hex/, '39 digits');
refused('evm address', () => parseEvmAddress('5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'), /40 hex/, 'no 0x');
refused('evm address', () => parseEvmAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeg'), /40 hex/, 'a non-hex digit');
refused('evm address', () => parseEvmAddress('0x' + '0'.repeat(40)), /zero address/, 'the zero address');

// Base58.
assert.equal(base58Encode(new Uint8Array(32)), '11111111111111111111111111111111');
assert.ok(eq(base58Decode('So11111111111111111111111111111111111111112', 32), unhex('069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001')));
for (let i = 0; i < 32; i++) { const b = rnd(32); if (i % 4 === 0) b[0] = 0; assert.ok(eq(base58Decode(base58Encode(b), 32), b)); ok('base58'); }
refused('base58', () => base58Decode('0OIl', 32), /not base58/, 'characters outside the alphabet');
refused('base58', () => base58Decode('1' + base58Encode(rnd(32)), 32), /bytes, not 32/, 'a leading zero byte too many');
refused('base58', () => base58Decode('', 32), /not base58/, 'empty text');

// Solana keys: RFC 8032 section 7.1, test 1, and seeded keys.
const RFC8032_PK = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
assert.ok(eq(parseSolanaPublicKey(unhex(RFC8032_PK)), unhex(RFC8032_PK)));
for (let i = 0; i < 16; i++) {
  const pk = ed25519.getPublicKey(rnd(32));
  assert.ok(eq(parseSolanaPublicKey(base58Encode(pk)), pk));
  ok('solana key');
}
for (const t of ED25519_TORSION_SUBGROUP) refused('solana key', () => parseSolanaPublicKey(unhex(t)), /small order|canonical/, `torsion point ${t}`);
{
  const P = ed25519.Point.fromBytes(unhex(RFC8032_PK));
  const T = ed25519.Point.fromHex(ED25519_TORSION_SUBGROUP[1]);
  refused('solana key', () => parseSolanaPublicKey(P.add(T).toBytes()), /mixed order/, 'a mixed-order point');
  const P_ED = ed25519.Point.Fp.ORDER;
  refused('solana key', () => parseSolanaPublicKey(le(P_ED + 1n, 32)), /canonical/, 'y = p + 1 (a non-canonical identity)');
  const negZero = new Uint8Array(32); negZero[0] = 1; negZero[31] = 0x80;
  refused('solana key', () => parseSolanaPublicKey(negZero), /canonical|small order/, 'x = 0 with the sign bit set');
  let off: Uint8Array | undefined;
  for (let i = 0; !off; i++) { const c = rnd(32); c[31] &= 0x7f; try { ed25519.Point.fromBytes(c, false); } catch { off = c; } }
  refused('solana key', () => parseSolanaPublicKey(off!), /canonical Ed25519 point/, 'a y with no curve point');
  refused('solana key', () => parseSolanaPublicKey(unhex(RFC8032_PK).subarray(0, 31)), /32 bytes/, '31 bytes');
  // The point the ed25519 class takes: base58 text -> point, point -> the same 32 bytes.
  for (let i = 0; i < 8; i++) {
    const pk = ed25519.getPublicKey(rnd(32));
    const pt = solanaKeyPoint(base58Encode(pk));
    const ref = ed25519.Point.fromBytes(pk).toAffine();
    assert.deepEqual(pt, { x: ref.x, y: ref.y });
    assert.ok(eq(solanaKeyFromPoint(pt), pk));
    const k = solanaKeyInputs(base58Encode(pk));
    assert.deepEqual(k.point, pt);
    assert.ok(eq(probe.encode_public_key_ed25519(k.point, k.pkBytes, k.pkX), pk), 'the circuit checks the wallet\'s bytes against the point');
    ok('solana key point');
  }
  refused('solana key point', () => solanaKeyPoint(base58Encode(unhex(ED25519_TORSION_SUBGROUP[0]))), /small order|canonical/, 'the identity in base58');
  refused('solana key point', () => solanaKeyPoint('1' + base58Encode(ed25519.getPublicKey(rnd(32)))), /bytes, not 32|base58/, 'non-canonical base58');
  refused('solana key point', () => solanaKeyFromPoint({ x: 0n, y: 1n }), /small order/, 'the identity point');
  refused('solana key point', () => solanaKeyFromPoint(T.toAffine()), /small order/, 'a small-order point');
  refused('solana key point', () => solanaKeyFromPoint(P.add(T).toAffine()), /mixed order/, 'a mixed-order point');
  const B = ed25519.Point.BASE.toAffine();
  refused('solana key point', () => solanaKeyFromPoint({ x: B.x, y: B.y + 1n }), /not an Ed25519 point/, 'a point off the curve');
  refused('solana key point', () => solanaKeyFromPoint({ x: B.x, y: B.y + ed25519.Point.Fp.ORDER }), /not below p/, 'y + p');
  refused('solana key point', () => solanaKeyFromPoint(unhex(RFC8032_PK) as any), /bigint coordinates/, 'the 32 bytes instead of a point');
}

// secp256k1 keys.
{
  const pt = secp256k1.Point.BASE.multiply(0xc0ffeen);
  const { x, y } = pt.toAffine();
  for (const enc of [pt.toBytes(true), pt.toBytes(false)]) {
    const d = parseK256Descriptor(enc, 1);
    assert.equal(d.x, x); assert.equal(d.y, y); assert.equal(d.envelope, 1);
    ok('k256 key');
  }
  refused('k256 key', () => parseK256Descriptor({ x: 0n, y: 0n }, 0), /not a secp256k1 public key|infinity/, 'the point at infinity (coordinates 0, 0)');
  refused('k256 key', () => parseK256Descriptor({ x, y: y + 1n }, 0), /not a secp256k1 public key/, 'a point off the curve');
  refused('k256 key', () => parseK256Descriptor({ x: x + secp256k1.Point.Fp.ORDER, y }, 0), /not below p/, 'a coordinate not below p');
  refused('k256 key', () => parseK256Descriptor({ x, y }, 2), /unknown k256 envelope/, 'envelope 2');
}

// Passkeys: the RP ID may be a registrable parent of the origin's host.
{
  const pt = p256.Point.BASE.multiply(0xbeefn).toAffine();
  const parent = parseP256Descriptor(pt, 'example.com', 'https://a.example.com');
  assert.ok(eq(parent.policy!.rpIdHash, sha(Buffer.from('example.com'))));
  ok('p256 key');
  parseP256Descriptor(pt, 'a.example.com', 'https://a.example.com'); ok('p256 key');
  refused('p256 key', () => parseP256Descriptor(pt, 'a.example.org', 'https://a.example.com'), /^Error: descriptor: .*registrable parent/, 'a mismatched RP');
  refused('p256 key', () => parseP256Descriptor(pt, 'example.com', 'https://ab.example.com'), /^Error: descriptor: .*21-byte/, 'a 22-byte origin');
  refused('p256 key', () => parseP256Descriptor(pt, 'example12.com', 'http://example12.com'), /^Error: descriptor: .*HTTPS/, 'http outside localhost');
  refused('p256 key', () => parseP256Descriptor({ x: 0n, y: 0n }, 'example.com', 'https://a.example.com'), /not a P-256 public key|infinity/, 'the point at infinity');
  refused('p256 key', () => checkDescriptor({ ...parent, policy: { ...parent.policy!, rpId: 'other.example' } }), /registrable parent|SHA-256 of the RP ID/, 'an RP ID that does not hash to the shown value');
}

// JubJub points.
{
  for (const k of [1n, 2n, 0xc0ffeen]) {
    const pk = upstream.compute_public_point_with_jubjub(k);
    assert.deepEqual(parseJubjubPoint(new Uint8Array([...le(pk.x, 32), ...le(pk.y, 32)])), { scheme: 'jubjub', x: pk.x, y: pk.y });
    ok('jubjub key');
  }
  const q = jubjub.Point.Fp.ORDER;
  const G = upstream.compute_public_point_with_jubjub(1n);
  refused('jubjub key', () => parseJubjubPoint({ x: 0n, y: 1n }), /small order/, 'the identity');
  refused('jubjub key', () => parseJubjubPoint({ x: 0n, y: q - 1n }), /small order/, 'the point of order 2');
  const mixed = jubjub.Point.fromAffine(G).add(jubjub.Point.fromAffine({ x: 0n, y: q - 1n })).toAffine();
  refused('jubjub key', () => parseJubjubPoint(mixed), /mixed order/, 'a mixed-order point');
  refused('jubjub key', () => parseJubjubPoint({ x: G.x + q, y: G.y }), /not canonical/, 'x not below q');
  refused('jubjub key', () => parseJubjubPoint({ x: G.x, y: G.y + 1n }), /not a JubJub point/, 'a point off the curve');
}
console.log(`  ✓ parsers: ${['evm address', 'base58', 'solana key', 'solana key point', 'k256 key', 'p256 key', 'jubjub key'].map((k) => `${k} ${tally[k].pass}/${tally[k].refused}`).join(', ')} (accepted/refused)`);

// ── Encoders and the decoder ─────────────────────────────────────────────────

const account = rnd(32);
const sampleDescriptors = (): Descriptor[] => [
  parseJubjubPoint(upstream.compute_public_point_with_jubjub(0x1234n)),
  parseK256Descriptor(secp256k1.Point.BASE.multiply(0x5678n).toBytes(true), 0),
  parseK256Descriptor(secp256k1.Point.BASE.multiply(0x9abcn).toBytes(false), 1),
  parseP256Descriptor(p256.Point.BASE.multiply(0xdef0n).toAffine(), 'example.com', 'https://a.example.com'),
  evmDescriptor(evmAddressOf(secp256k1.Point.BASE.multiply(0x1111n).toAffine()), rnd(32)),
  solDescriptor(base58Encode(ed25519.getPublicKey(rnd(32))), rnd(32)),
];
const TAG = (r: DescriptorRecipe, d: Descriptor) => padTag(DESCRIPTOR_TAGS[r][d.scheme]);
// The preimage's payload bytes, built independently of the circuits: a
// Solana key hashes as its 32-byte RFC 8032 encoding (from noble's strict
// parser), although the circuit takes its point.
const payloadBytes = (d: Descriptor, r: DescriptorRecipe): Uint8Array => d.scheme === 'sol_ed25519'
  ? new Uint8Array([...d.key, ...d.blind])
  : new Uint8Array(payloadParts(d, r).flatMap((p) => (p instanceof Uint8Array ? [...p] : [...le(p as bigint, 1)])));
for (let round = 0; round < 4; round++) {
  for (const d of sampleDescriptors()) {
    const epoch = BigInt(round * 7), counter = BigInt(round * 11), salt = rnd(32), oh = rnd(32), slot = BigInt(round * 60);
    const entry = derive(probe, entryCall(d, account, epoch, counter));
    // A legacy scheme has no boot recipe here (bootCall refuses it, below);
    // its salt is still drawn, so every descriptor consumes the same seeded
    // inputs.
    const boot = boots(d.scheme) ? derive(probe, bootCall(d, salt)) : undefined;
    const grant = derive(probe, grantIdCall(d, account, oh, slot));
    for (const r of recipesOf(d.scheme)) {
      assert.equal(payloadBytes(d, r).length, PAYLOAD_WIDTH[r][d.scheme], `${d.scheme} ${r} width`);
      assert.equal(DESCRIPTOR_CLASS[r][d.scheme], d.scheme === 'sol_ed25519' ? 'ed25519' : `w${PAYLOAD_WIDTH[r][d.scheme]}`, `${d.scheme} ${r} class`);
    }
    if (d.scheme === 'sol_ed25519') {
      // The circuits take the point, with the key's bytes and x-coordinate
      // as checked byte vectors.
      const parts = payloadParts(d, 'device');
      assert.deepEqual(parts[0], solanaKeyPoint(d.key));
      assert.deepEqual(parts[1], [...d.key].map(BigInt));
      assert.deepEqual(parts[2], [...le((parts[0] as any).x, 32)].map(BigInt));
      assert.deepEqual(solanaKeyInputs(d.key), { point: parts[0], pkBytes: parts[1], pkX: parts[2] });
      assert.ok(eq(probe.encode_public_key_ed25519(...(parts.slice(0, 3) as [any, any, any])), d.key));
    }
    // Independent SHA-256 of the preimage, every scheme.
    assert.ok(eq(entry, sha(TAG('device', d), account, payloadBytes(d, 'device'), le(epoch, 4), le(counter, 8))), `${d.scheme} entry`);
    if (boots(d.scheme)) assert.ok(eq(boot, sha(TAG('boot', d), salt, payloadBytes(d, 'boot'))), `${d.scheme} boot`);
    assert.ok(eq(grant, sha(TAG('grant-id', d), account, payloadBytes(d, 'grant-id'), oh, le(slot, 1))), `${d.scheme} grant id`);
    // Upstream's own circuits, legacy schemes.
    const A = { bytes: account };
    if (d.scheme === 'jubjub') {
      const pk = { x: d.x, y: d.y };
      assert.ok(eq(entry, upstream.derive_device_entry_with_jubjub(A, pk, epoch, counter)));
      assert.ok(eq(grant, upstream.derive_grant_id_with_jubjub(A, pk, oh, slot)));
    } else if (d.scheme === 'k256') {
      const pk = { x: d.x, y: d.y, identity: false };
      assert.ok(eq(entry, upstream.derive_device_entry_with_k256(A, pk, BigInt(d.envelope), epoch, counter)));
      assert.ok(eq(grant, upstream.derive_grant_id_with_k256(A, pk, BigInt(d.envelope), oh, slot)));
    } else if (d.scheme === 'p256') {
      const pk = { x: d.x, y: d.y, identity: false };
      const policy = { rp_id_hash: d.policy!.rpIdHash, origin: d.policy!.origin };
      assert.ok(eq(entry, upstream.derive_device_entry_with_p256(A, pk, policy, epoch, counter)));
      assert.ok(eq(grant, upstream.derive_grant_id_with_p256(A, pk, oh, slot)));
    }
    // The decoder inverts the encoder.
    for (const r of recipesOf(d.scheme)) {
      const back = decodeDescriptor(r, TAG(r, d), payloadParts(d, r));
      assert.deepEqual(payloadParts(back, r), payloadParts(d, r), `${d.scheme} ${r} round trip`);
    }
    ok('encoders');
  }
}
{
  const [jj, , k1, , evm, sol] = sampleDescriptors();
  refused('decoder', () => decodeDescriptor('device', padTag('midnight:account:device:ed:v1'), payloadParts(sol, 'device')), /unregistered tag/, 'an unregistered tag');
  refused('decoder', () => decodeDescriptor('device', TAG('boot', sol), payloadParts(sol, 'device')), /boot tag, not a device tag/, 'another recipe\'s tag');
  refused('decoder', () => decodeDescriptor('boot', padTag('midnight:account:boot:v1'), payloadParts(jj, 'device')), /unregistered tag/, 'upstream\'s jubjub boot tag');
  refused('decoder', () => decodeDescriptor('boot', padTag('midnight:account:boot:k1:v2'), payloadParts(k1, 'device')), /unregistered tag/, 'upstream\'s k256 boot tag');
  refused('decoder', () => decodeDescriptor('device', TAG('device', k1), payloadParts(jj, 'device')), /takes 3 payload parts/, 'a k256 tag with a 64-byte payload');
  refused('decoder', () => decodeDescriptor('device', TAG('device', evm), [(sol as any).key, rnd(32)]), /20 bytes/, 'an evm tag with a 32-byte identity');
  const [solPt, solBytes, solX, solBlind] = payloadParts(sol, 'device');
  const Z32V = new Array(32).fill(0n);
  refused('decoder', () => decodeDescriptor('device', TAG('device', sol), [{ x: 0n, y: 1n }, [1n, ...Z32V.slice(1)], Z32V, rnd(32)]), /small order/, 'a Solana identity point');
  refused('decoder', () => decodeDescriptor('device', TAG('device', sol), [(sol as any).key, rnd(32)]), /takes 4 payload parts/, 'a Solana key as bytes and a blind');
  refused('decoder', () => decodeDescriptor('device', TAG('device', sol), [(sol as any).key, solBytes, solX, solBlind]), /bigint coordinates/, 'a Solana key as bytes instead of its point');
  refused('decoder', () => decodeDescriptor('grant-id', TAG('grant-id', sol), [ed25519.Point.fromHex(ED25519_TORSION_SUBGROUP[1]).toAffine(), solBytes, solX, rnd(32)]), /small order/, 'a small-order Solana point');
  refused('decoder', () => decodeDescriptor('boot', TAG('boot', sol), [ed25519.Point.fromBytes((sol as any).key).add(ed25519.Point.fromHex(ED25519_TORSION_SUBGROUP[1])).toAffine(), solBytes, solX, rnd(32)]), /mixed order/, 'a mixed-order Solana point');
  const flip = (v: unknown, i: number, m: bigint) => { const c = [...(v as bigint[])]; c[i] ^= m; return c; };
  refused('decoder', () => decodeDescriptor('device', TAG('device', sol), [solPt, flip(solBytes, 0, 1n), solX, solBlind]), /key bytes are not its point's encoding/, 'a Solana key byte flipped');
  refused('decoder', () => decodeDescriptor('device', TAG('device', sol), [solPt, flip(solBytes, 31, 0x80n), solX, solBlind]), /key bytes are not its point's encoding/, 'the other sign bit');
  refused('decoder', () => decodeDescriptor('device', TAG('device', sol), [solPt, solBytes, flip(solX, 5, 2n), solBlind]), /x bytes are not its point's x-coordinate/, 'an x byte flipped');
  refused('decoder', () => decodeDescriptor('device', TAG('device', sol), [solPt, [...(solBytes as bigint[]).slice(0, 31), 256n], solX, solBlind]), /32 byte values/, 'a key byte of 256');
  refused('decoder', () => decodeDescriptor('device', TAG('device', sol), [solPt, (solBytes as bigint[]).slice(1), solX, solBlind]), /32 byte values/, '31 key bytes');
  refused('decoder', () => decodeDescriptor('device', TAG('device', k1), [...payloadParts(k1, 'device').slice(0, 2), 2n]), /unknown k256 envelope/, 'envelope 2');
  refused('decoder', () => decodeDescriptor('device', TAG('device', evm), [new Uint8Array(20), rnd(32)]), /zero address/, 'the zero address');
  refused('decoder', () => decodeDescriptor('device', TAG('device', jj), [le(0n, 32), le(1n, 32)]), /small order/, 'the JubJub identity');
}
console.log(`  ✓ encoders: ${tally.encoders.pass} descriptors × their recipes (boot: readable schemes only) equal SHA-256 of the preimage and upstream's circuits; decoder round trips; ${tally.decoder.refused} malformed calls refused`);

// ── Display ──────────────────────────────────────────────────────────────────

{
  const [, , , pk, evm, sol] = sampleDescriptors();
  const lines = (r: DescriptorRecipe, d: Descriptor) => Object.fromEntries(describeDescriptor(r, d).map((l) => [l.label, l.value]));
  const e = lines('device', evm);
  assert.equal(e['Ethereum address'], evmChecksumAddress((evm as any).address));
  assert.equal(e['Device privacy salt'], '0x' + hex((evm as any).blind));
  // A grantee's blind is labelled as a grantee's, a device's
  // (entries and boot commitments) as a device's; never both, never neither.
  for (const d of [evm, sol]) {
    for (const r of ['device', 'boot', 'grant-id'] as DescriptorRecipe[]) {
      const shown = lines(r, d), want = r === 'grant-id' ? 'Grantee privacy salt' : 'Device privacy salt';
      const other = r === 'grant-id' ? 'Device privacy salt' : 'Grantee privacy salt';
      assert.equal(privacySaltLabel(r), want);
      assert.equal(shown[want], '0x' + hex((d as any).blind), `${d.scheme} ${r}: the blind under "${want}"`);
      assert.equal(shown[other], undefined, `${d.scheme} ${r}: no "${other}" line`);
    }
  }
  assert.equal(lines('device', sol)['Solana public key'], base58Encode((sol as any).key));
  const p = lines('device', pk);
  assert.equal(p['Passkey origin'], 'https://a.example.com');
  assert.match(p['Passkey RP (hash)'], /^0x[0-9a-f]{64} \(RP ID example\.com, shown by this client\)$/);
  assert.equal(lines('grant-id', pk)['Passkey origin'], undefined, 'a p256 grant id binds the key only');
  assert.equal(lines('device', pk)['Scheme tag'], 'midnight:account:device:r1:v2');
  console.log('  ✓ display: EIP-55 address, base58 key, passkey origin as text, the two labelled values (a grantee\'s blind as "Grantee privacy salt")');
}

// The comparison display equals what the circuit binds and what the
// approvals show.
assert.deepEqual(COORDINATE_DISPLAY_ORDER, { jubjub: 'little-endian', k256: 'big-endian', p256: 'big-endian' });
const ctrBeforeDisplayOrder = ctr; // restored below: later sections keep their seeded inputs
{
  const lines = (r: DescriptorRecipe, d: Descriptor) => Object.fromEntries(describeDescriptor(r, d).map((l) => [l.label, l.value]));
  const h0x = (b: Uint8Array) => '0x' + hex(b);
  const rev = (b: Uint8Array) => Uint8Array.from(b).reverse();
  for (let round = 0; round < 4; round++) {
    for (const d of sampleDescriptors()) {
      for (const r of recipesOf(d.scheme)) {
        const parts = payloadParts(d, r);      // the circuit's arguments
        const shown = lines(r, d);
        assert.equal(shown['Scheme tag'], DESCRIPTOR_TAGS[r][d.scheme]);
        switch (d.scheme) {
          case 'jubjub':
            // Recipe w64 binds x_le ‖ y_le; the display is little-endian:
            // the shown hex IS the bound bytes.
            assert.equal(shown['JubJub key x'], h0x(parts[0] as Uint8Array), `jubjub x ${r}`);
            assert.equal(shown['JubJub key y'], h0x(parts[1] as Uint8Array), `jubjub y ${r}`);
            assert.equal(shown['JubJub key x'], h0x(le(d.x, 32)));
            break;
          case 'k256':
          case 'p256': {
            // Recipes bind x_le ‖ y_le; the display is SEC1 big-endian: the
            // reversed bound bytes, which equal the SEC1 encoding's x and y.
            const curve = d.scheme === 'k256' ? secp256k1 : p256;
            const sec1 = curve.Point.fromAffine({ x: d.x, y: d.y }).toBytes(false);
            const name = d.scheme === 'k256' ? 'secp256k1 key' : 'Passkey key';
            assert.equal(shown[`${name} x`], h0x(rev(parts[0] as Uint8Array)), `${d.scheme} x ${r}`);
            assert.equal(shown[`${name} y`], h0x(rev(parts[1] as Uint8Array)), `${d.scheme} y ${r}`);
            assert.equal(shown[`${name} x`], h0x(sec1.subarray(1, 33)), `${d.scheme} x is SEC1`);
            assert.equal(shown[`${name} y`], h0x(sec1.subarray(33, 65)), `${d.scheme} y is SEC1`);
            if (d.scheme === 'k256') assert.ok(shown['Signing envelope'].startsWith(`${parts[2]} (`), 'envelope');
            if (d.scheme === 'p256' && r !== 'grant-id') {
              assert.equal(shown['Passkey RP (hash)'].slice(0, 66), h0x(parts[2] as Uint8Array), 'rp_id_hash');
              assert.ok(eq(new TextEncoder().encode(shown['Passkey origin']), parts[3] as Uint8Array), 'origin');
            }
            break;
          }
          case 'evm_k256':
            assert.equal(shown['Ethereum address'].toLowerCase(), h0x(parts[0] as Uint8Array), `evm address ${r}`);
            assert.equal(shown[privacySaltLabel(r)], h0x(parts[1] as Uint8Array), `evm blind ${r}`);
            break;
          case 'sol_ed25519': {
            // The circuit takes the point and binds its RFC 8032 encoding.
            const bound = probe.encode_public_key_ed25519(...(parts.slice(0, 3) as [any, any, any]));
            assert.ok(eq(base58Decode(shown['Solana public key'], 32), bound), `sol key ${r}`);
            assert.equal(shown['Solana public key (hex)'], hex(bound), `sol key hex ${r}`);
            assert.equal(shown[privacySaltLabel(r)], h0x(parts[3] as Uint8Array), `sol blind ${r}`);
            break;
          }
        }
        ok('display order');
      }
    }
  }
  // Frozen evm_k256 approval values: the descriptor arguments the circuit
  // takes (key = x_le, key2 = y_le, as stored) and the nested member values
  // the wallet shows.
  // The keys are random bytes, not points: only the rendering is compared.
  const FROZEN: { name: string; recipe: DescriptorRecipe; d: Descriptor; shown: Record<string, string> }[] = [];
  const le32 = (h: string) => bigLE(unhex(h));
  const frozenXY = (name: string, recipe: DescriptorRecipe, scheme: 'jubjub' | 'k256' | 'p256', key: string, key2: string, x: string, y: string, extra: object = {}) =>
    FROZEN.push({ name, recipe, d: { scheme, x: le32(key), y: le32(key2), ...extra } as Descriptor, shown: { x, y } });
  frozenXY('add_device/jubjub', 'device', 'jubjub', '008d9c106ab2f8e6e42b403fd938c78ae05ff2b883a44d547ffc01b38708d3b8', 'e775dbf815339a367d7f1c45083bfb0c55784ff48ee30a5bb7b486fd533e8463',
    '0x008d9c106ab2f8e6e42b403fd938c78ae05ff2b883a44d547ffc01b38708d3b8', '0xe775dbf815339a367d7f1c45083bfb0c55784ff48ee30a5bb7b486fd533e8463');
  frozenXY('issue_grant/jubjub', 'grant-id', 'jubjub', 'd2f45c25780e3d4586366c0a189d603517a55368aac7dbf0a2218e4a45ae4158', '0000e72e4e7155f9b4a2b468c26189fc1fb4754aa5c983a5aff206c1e1de41d5',
    '0xd2f45c25780e3d4586366c0a189d603517a55368aac7dbf0a2218e4a45ae4158', '0x0000e72e4e7155f9b4a2b468c26189fc1fb4754aa5c983a5aff206c1e1de41d5');
  frozenXY('add_device/k256', 'device', 'k256', '96b657cae691101d92423746ef842e62f62a3b7d31b0c13106529471d5221a80', '63500fd4c3578f23fd0dec6345ef84c3222150f55de9ff2b10c0af803ab66665',
    '0x801a22d57194520631c1b0317d3b2af6622e84ef463742921d1091e6ca57b696', '0x6566b63a80afc0102bffe95df5502122c384ef4563ec0dfd238f57c3d40f5063', { envelope: 1 });
  frozenXY('issue_grant/k256', 'grant-id', 'k256', '24509c24cadf8e52f697e3ed5d118bd911862d674dacade8863358bf94d849ee', 'b69d4997abf276bc581bda0ce6678224cd4778dce9a444fba9488bb77d82cf52',
    '0xee49d894bf583386e8adac4d672d8611d98b115dede397f6528edfca249c5024', '0x52cf827db78b48a9fb44a4e9dc7847cd248267e60cda1b58bc76f2ab97499db6', { envelope: 0 });
  frozenXY('add_device/p256', 'device', 'p256', '1f939d5962ae73813107f975307dcb6c66e4dfe4533606a23cc389ce395e28cd', 'c4ebf9dcdf67ddcd64f80a9372db2aad857e5a7e59a1582c40d1656fb29242af',
    '0xcd285e39ce89c33ca2063653e4dfe4666ccb7d3075f907318173ae62599d931f', '0xaf4292b26f65d1402c58a1597e5a7e85ad2adb72930af864cddd67dfdcf9ebc4',
    { policy: { rpIdHash: unhex('6fbc9a902223169eb4763f26ae9d1ce2541dd3bfcd10143069324b6573772220'), origin: new TextEncoder().encode('https://a.example.com') } });
  frozenXY('issue_grant/p256', 'grant-id', 'p256', '524ffadd6134eee82413ffebe1a179a590dec98902943ad49b0f5f9eea544198', 'a5a850d7f706ce3511bb160b2fab501c1b9d36b937f500b0a613d652fd85a248',
    '0x984154ea9e5f0f9bd43a940289c9de90a579a1e1ebff1324e8ee3461ddfa4f52', '0x48a285fd52d613a6b000f537b9369d1b1c50ab2f0b16bb1135ce06f7d750a8a5');
  for (const f of FROZEN) {
    const shown = describeDescriptor(f.recipe, f.d).filter((l) => / key [xy]$/.test(l.label)).map((l) => l.value);
    assert.deepEqual(shown, [f.shown.x, f.shown.y], `${f.name}: the comparison display equals the frozen approval`);
    assert.equal(coordinateHex(f.d.scheme as 'jubjub' | 'k256' | 'p256', (f.d as any).x), f.shown.x);
    ok('frozen approvals');
  }
  {
    const p = lines('device', FROZEN.find((f) => f.name === 'add_device/p256')!.d);
    assert.equal(p['Passkey origin'], 'https://a.example.com');
    assert.equal(p['Passkey RP (hash)'], '0x6fbc9a902223169eb4763f26ae9d1ce2541dd3bfcd10143069324b6573772220');
    assert.ok(lines('device', FROZEN.find((f) => f.name === 'add_device/k256')!.d)['Signing envelope'].startsWith('1 '));
    const evm = lines('device', evmDescriptor('0x44eaa4af74c5a2c0c826381c64ce349f53da908a', unhex('7352b6318696467d60beee1663620e75dd8237a2cc4a2b59acc75f50a9d2c291')));
    assert.equal(evm['Ethereum address'], '0x44EAa4aF74C5A2c0c826381C64cE349f53dA908A');
    assert.equal(evm['Device privacy salt'], '0x7352b6318696467d60beee1663620e75dd8237a2cc4a2b59acc75f50a9d2c291');
    // The frozen sol_ed25519 target (random bytes, not a key: no strict parse).
    const sol = lines('device', { scheme: 'sol_ed25519', key: unhex('418e8e76243534c60cbfa63014f32881ce3c53eb27ed0e9019e96e783f42ceaf'), blind: unhex('5dce20c082b6b733bfa86bfe9c76b5251c1faa32868a08f5e2ab869d89ba7aa2') });
    assert.equal('0x' + sol['Solana public key (hex)'], '0x418e8e76243534c60cbfa63014f32881ce3c53eb27ed0e9019e96e783f42ceaf');
    assert.equal(sol['Device privacy salt'], '0x5dce20c082b6b733bfa86bfe9c76b5251c1faa32868a08f5e2ab869d89ba7aa2');
    ok('frozen approvals');
  }
  // The byte order is not the same for every curve: a big-endian JubJub
  // display would differ from the frozen approval.
  const jj = FROZEN[0];
  assert.notEqual('0x' + hex(Uint8Array.from(le((jj.d as any).x, 32)).reverse()), jj.shown.x, 'a big-endian JubJub display differs from the approval');
  assert.throws(() => coordinateHex('sol_ed25519' as any, 1n), /no coordinates/);
  ctr = ctrBeforeDisplayOrder;
  console.log(`  ✓ display order: ${tally['display order'].pass} descriptor × recipe displays equal the circuit's bound bytes (JubJub little-endian; secp256k1 and P-256 big-endian, equal to SEC1); ${tally['frozen approvals'].pass} frozen evm_k256 approvals shown identically`);
}

// ── Grant origin labels ──────────────────────────────────────────────────────

for (const s of ['Midnight Night Market', 'wallet.example', 'MN Bank - grants v1']) {
  const l = grantLabel(s);
  assert.equal(ascii(probe.label_text_32(l)).trimEnd(), s);
  assert.ok(eq(grantOriginHash(l), probe.derive_grant_origin_hash_label(l)));
  ok('labels');
}
assert.ok(eq(grantOriginHash(new Uint8Array(Buffer.from('https://a.example.com'))), probe.derive_grant_origin_hash_origin(new Uint8Array(Buffer.from('https://a.example.com')))));
for (const [why, s] of [['a leading space', ' a'], ['a trailing space', 'a '], ['a double space', 'a  b'], ['empty', ''], ['33 bytes', 'x'.repeat(33)], ['a newline', 'a\nb']]) {
  refused('labels', () => grantLabel(s), /label is/, why);
}

// ── Blind: request message ───────────────────────────────────────────────────

const evmWallet = evmAddressOf(secp256k1.Point.BASE.toAffine()); // 0x7E5F…5Bdf, the key 1
const solWallet = unhex(RFC8032_PK);
const GOLDEN_EVM = [
  'Midnight Passport account privacy key (v1)',
  'Network: undeployed',
  'Wallet: Ethereum address 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
  'Account index: 0',
  'Warning: this signature reveals the privacy key of this Passport account.',
  'Anyone who obtains it can link this wallet to that account.',
  'Sign it only in a Midnight Passport client you trust.',
  'It authorises nothing: no transfer, no new device, no grant.',
].join('\n');
assert.equal(blindMessage({ scheme: 'evm_k256', network: 'undeployed', identity: evmWallet, accountIndex: 0 }), GOLDEN_EVM);
const solMsg = blindMessage({ scheme: 'sol_ed25519', network: 'preprod', identity: solWallet, accountIndex: 7n });
assert.equal(solMsg.split('\n')[2], `Wallet: Solana public key ${base58Encode(solWallet)}`);
assert.equal(solMsg.split('\n')[3], 'Account index: 7');
assert.ok(/^[\x20-\x7e\n]+$/.test(solMsg) && !solMsg.endsWith('\n'), 'printable ASCII, LF lines, no trailing newline');
assert.ok(eq(blindMessageBytes({ scheme: 'sol_ed25519', network: 'preprod', identity: solWallet, accountIndex: 7 }), new TextEncoder().encode(solMsg)), 'deterministic');
assert.notEqual(blindMessage({ scheme: 'evm_k256', network: 'preview', identity: evmWallet, accountIndex: 0 }), GOLDEN_EVM, 'the network changes the message');
assert.notEqual(blindMessage({ scheme: 'evm_k256', network: 'undeployed', identity: evmWallet, accountIndex: 1 }), GOLDEN_EVM, 'the account index changes the message');
const req = { scheme: 'evm_k256' as const, network: 'undeployed', identity: evmWallet, accountIndex: 0 };
refused('blind message', () => blindMessage({ ...req, network: 'Mainnet' }), /network name/, 'an upper-case network');
refused('blind message', () => blindMessage({ ...req, network: 'pre prod' }), /network name/, 'a space in the network');
refused('blind message', () => blindMessage({ ...req, network: '' }), /network name/, 'an empty network');
refused('blind message', () => blindMessage({ ...req, accountIndex: -1 }), /0 to 4294967295/, 'a negative index');
refused('blind message', () => blindMessage({ ...req, accountIndex: 2n ** 32n }), /0 to 4294967295/, 'an index above 2^32 - 1');
refused('blind message', () => blindMessage({ ...req, accountIndex: 1.5 }), /integer/, 'a fractional index');
refused('blind message', () => blindMessage({ ...req, identity: new Uint8Array(20) }), /not zero/, 'the zero address');
refused('blind message', () => blindMessage({ ...req, identity: rnd(21) }), /20 bytes/, 'a 21-byte address');
refused('blind message', () => blindMessage({ scheme: 'sol_ed25519', network: 'preprod', identity: unhex(ED25519_TORSION_SUBGROUP[0]), accountIndex: 0 }), /small order|canonical/, 'a Solana identity key');
console.log(`  ✓ blind message: golden EVM text, Solana text, deterministic; ${tally['blind message'].refused} bad requests refused`);

// ── Blind: the grantee request ───────────────────────────────────────────────

const ISSUER_1 = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const GOLDEN_EVM_GRANTEE = [
  'Midnight Passport grantee privacy key (v1)',
  'Role: grantee',
  'Network: undeployed',
  'Wallet: Ethereum address 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
  'Issuing account: 0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20',
  'Warning: this signature reveals this wallet\'s privacy key for grants from that account.',
  'The owner of that account learns it when issuing a grant to this wallet.',
  'Anyone who obtains it can link this wallet to its grants from that account.',
  'It is not the privacy key of any Passport account this wallet controls.',
  'Sign it only in a Midnight Passport client you trust.',
  'It authorises nothing: no transfer, no new device, no grant.',
].join('\n');
const greq: GranteeBlindRequest = { scheme: 'evm_k256', network: 'undeployed', identity: evmWallet, issuingAccount: ISSUER_1 };
assert.equal(granteeBlindMessage(greq), GOLDEN_EVM_GRANTEE);
const solGranteeMsg = granteeBlindMessage({ scheme: 'sol_ed25519', network: 'preprod', identity: solWallet, issuingAccount: ISSUER_1 });
{
  const lines = solGranteeMsg.split('\n');
  assert.equal(lines[2], 'Network: preprod');
  assert.equal(lines[3], `Wallet: Solana public key ${base58Encode(solWallet)}`);
  assert.equal(lines[4], `Issuing account: ${hex(ISSUER_1)}`, 'the issuing account in full, 64 hex digits');
  assert.ok(/^[\x20-\x7e\n]+$/.test(solGranteeMsg) && !solGranteeMsg.endsWith('\n'), 'printable ASCII, LF lines, no trailing newline');
  assert.ok(eq(granteeBlindMessageBytes({ scheme: 'sol_ed25519', network: 'preprod', identity: solWallet, issuingAccount: ISSUER_1 }), new TextEncoder().encode(solGranteeMsg)), 'deterministic');
}
// Every required element is named: Midnight Passport, the network, the role, the issuing account, the warning.
for (const m of [GOLDEN_EVM_GRANTEE, solGranteeMsg]) {
  const lines = m.split('\n');
  assert.ok(lines[0].startsWith('Midnight Passport '));
  assert.equal(lines[1], 'Role: grantee');
  assert.ok(lines[2].startsWith('Network: '));
  assert.ok(lines[4].startsWith('Issuing account: ') && /^[0-9a-f]{64}$/.test(lines[4].slice('Issuing account: '.length)));
  assert.ok(lines.some((l) => l.startsWith('Warning: this signature reveals')));
  assert.ok(lines.includes('It authorises nothing: no transfer, no new device, no grant.'));
  assert.ok(!lines.some((l) => l.startsWith('Account index')), 'no account index');
  ok('grantee message');
}
// The first lines differ from the device request's (title and second line), for every index and network.
for (const network of ['undeployed', 'preprod']) {
  for (const accountIndex of [0, 1, 7, 2 ** 31, 2 ** 32 - 1]) {
    for (const [scheme, identity] of [['evm_k256', evmWallet], ['sol_ed25519', solWallet]] as const) {
      const d = blindMessage({ scheme, network, identity, accountIndex }).split('\n');
      const g = granteeBlindMessage({ scheme, network, identity, issuingAccount: ISSUER_1 }).split('\n');
      assert.notEqual(g[0], d[0], 'the first line differs from the device request');
      assert.notEqual(g[1], d[1], 'the second line differs from the device request');
      assert.ok(!d.join('\n').startsWith(g[0]) && !g.join('\n').startsWith(d[0]), 'neither title is a prefix of the other message');
      ok('grantee first lines');
    }
  }
}
assert.notEqual(granteeBlindMessage({ ...greq, network: 'preview' }), GOLDEN_EVM_GRANTEE, 'the network changes the message');
assert.notEqual(granteeBlindMessage({ ...greq, issuingAccount: ISSUER_1.map((b) => b ^ 0x80) }), GOLDEN_EVM_GRANTEE, 'the issuing account changes the message');
refused('grantee message', () => granteeBlindMessage({ ...greq, network: 'Mainnet' }), /network name/, 'an upper-case network');
refused('grantee message', () => granteeBlindMessage({ ...greq, network: '' }), /network name/, 'an empty network');
refused('grantee message', () => granteeBlindMessage({ ...greq, issuingAccount: new Uint8Array(32) }), /not zero/, 'the zero issuing account');
refused('grantee message', () => granteeBlindMessage({ ...greq, issuingAccount: ISSUER_1.subarray(0, 31) }), /32 bytes/, 'a 31-byte issuing account');
refused('grantee message', () => granteeBlindMessage({ ...greq, issuingAccount: new Uint8Array(33).fill(1) }), /32 bytes/, 'a 33-byte issuing account');
refused('grantee message', () => granteeBlindMessage({ ...greq, issuingAccount: hex(ISSUER_1) as unknown as Uint8Array }), /32 bytes/, 'an issuing account given as text');
refused('grantee message', () => granteeBlindMessage({ ...greq, identity: new Uint8Array(20) }), /not zero/, 'the zero address');
refused('grantee message', () => granteeBlindMessage({ ...greq, identity: ISSUER_1.subarray(0, 21) }), /20 bytes/, 'a 21-byte address');
refused('grantee message', () => granteeBlindMessage({ scheme: 'sol_ed25519', network: 'preprod', identity: unhex(ED25519_TORSION_SUBGROUP[0]), issuingAccount: ISSUER_1 }), /small order|canonical/, 'a Solana identity key');
refused('grantee message', () => granteeBlindMessage({ ...greq, scheme: 'k256' as any }), /unknown scheme/, 'another scheme');
console.log(`  ✓ grantee message: golden EVM text, Solana text, deterministic; Midnight Passport, network, role, issuing account in full, warning; first two lines unlike the device request's (${tally['grantee first lines'].pass} index × network × scheme cases); ${tally['grantee message'].refused} bad requests refused`);

// ── Blind: canonical signatures and the sign-twice check ─────────────────────

const N = secp256k1.Point.Fn.ORDER;
const be = (v: bigint) => { const o = new Uint8Array(32); let x = v; for (let i = 31; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
// EIP-191 personal_sign over the request message, as MetaMask returns it: r || s || v.
const personalSign = (sk: Uint8Array, msg: Uint8Array, hedged = false): Uint8Array => {
  const digest = keccak_256(new Uint8Array([...new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`), ...msg]));
  const rec = secp256k1.sign(digest, sk, { prehash: false, format: 'recovered', ...(hedged ? { extraEntropy: true } : {}) });
  // noble's recovered format: recovery byte, then r || s.
  return new Uint8Array([...rec.subarray(1), 27 + rec[0]]);
};
{
  const sk = be(1n);
  const msg = blindMessageBytes(req);
  const a = personalSign(sk, msg), b = personalSign(sk, msg);
  assert.ok(sameCanonicalSignature('evm_k256', a, b), 'RFC 6979: signing twice gives one canonical form');
  const c = canonicalEvmSignature(a);
  const r = BigInt('0x' + hex(c.subarray(0, 32))), s = BigInt('0x' + hex(c.subarray(32)));
  assert.ok(s <= N / 2n, 'low S');
  const highS = new Uint8Array([...be(r), ...be(N - s), a[64] === 27 ? 28 : 27]); // the twin recovers with the other parity
  assert.ok(eq(canonicalEvmSignature(highS), c), 'the high-S twin has the same canonical form');
  assert.ok(eq(canonicalEvmSignature(a.subarray(0, 64)), c), '64-byte form');
  const hedged1 = personalSign(sk, msg, true), hedged2 = personalSign(sk, msg, true);
  assert.equal(sameCanonicalSignature('evm_k256', hedged1, hedged2), false, 'a hedged signer fails the sign-twice check');
  refused('evm canonical', () => canonicalEvmSignature(new Uint8Array([...be(0n), ...be(s), 27])), /outside \[1, n\)/, 'r = 0');
  refused('evm canonical', () => canonicalEvmSignature(new Uint8Array([...be(r), ...be(0n), 27])), /outside \[1, n\)/, 's = 0');
  refused('evm canonical', () => canonicalEvmSignature(new Uint8Array([...be(r), ...be(N), 27])), /outside \[1, n\)/, 's = n');
  refused('evm canonical', () => canonicalEvmSignature(new Uint8Array([...be(N + 1n), ...be(s), 27])), /outside \[1, n\)/, 'r above n');
  refused('evm canonical', () => canonicalEvmSignature(new Uint8Array([...c, 29])), /recovery byte/, 'v = 29');
  refused('evm canonical', () => canonicalEvmSignature(c.subarray(0, 63)), /64 or 65 bytes/, '63 bytes');
  const blind = deriveBlind('evm_k256', c);
  assert.ok(eq(blind, probe.derive_blind(padTag(BLIND_TAGS.evm_k256), c)), 'derive_blind (circuit) == deriveBlind (client)');
  assert.ok(eq(blind, derive(probe, blindCall('evm_k256', c))));
  assert.ok(eq(blind, sha(padTag('midnight:account:blind:evm:v1'), c)));
  console.log(`  ✓ EVM canonical form: low-S r || s; high-S twin and 64/65-byte forms agree; hedged signer refused by the sign-twice check; ${tally['evm canonical'].refused} malformed signatures refused`);
}
{
  const seed = rnd(32);
  const pk = ed25519.getPublicKey(seed);
  const msg = blindMessageBytes({ scheme: 'sol_ed25519', network: 'undeployed', identity: pk, accountIndex: 0 });
  const a = ed25519.sign(msg, seed), b = ed25519.sign(msg, seed);
  assert.ok(ed25519.verify(a, msg, pk, { zip215: false }));
  assert.ok(sameCanonicalSignature('sol_ed25519', a, b), 'RFC 8032: signing twice gives one canonical form');
  const L = ed25519.Point.Fn.ORDER;
  const sPlusL = new Uint8Array([...a.subarray(0, 32), ...le(bigLE(a.subarray(32)) + L, 32)]);
  refused('ed25519 canonical', () => canonicalEd25519Signature(sPlusL), /not below the group order/, 'S + L');
  const badR = new Uint8Array(a); badR.set(le(ed25519.Point.Fp.ORDER + 1n, 32), 0);
  refused('ed25519 canonical', () => canonicalEd25519Signature(badR), /canonical point encoding/, 'a non-canonical R');
  refused('ed25519 canonical', () => canonicalEd25519Signature(a.subarray(0, 63)), /64 bytes/, '63 bytes');
  const c = canonicalEd25519Signature(a);
  assert.ok(eq(deriveBlind('sol_ed25519', c), probe.derive_blind(padTag(BLIND_TAGS.sol_ed25519), c)));
  assert.ok(eq(deriveBlind('sol_ed25519', c), sha(padTag('midnight:account:blind:sol:v1'), c)));
  assert.ok(!eq(deriveBlind('sol_ed25519', c), deriveBlind('evm_k256', c)), 'the blind tags separate the schemes');
  console.log(`  ✓ Ed25519 canonical form: raw R || S; deterministic; ${tally['ed25519 canonical'].refused} malformed signatures refused`);
}

// ── Blind: a grantee blind is never a device blind ───────────────────────────
//
// For each wallet: its device blinds over two networks and 34 account indexes
// (0-31, 2^31, 2^32 - 1), against its grantee blinds over the same networks
// and 10 issuing accounts (incl. 0x00…01 and 0xff…ff). Same blind tag, same
// derive_blind; only the request differs.

const separation: Record<string, unknown>[] = [];
{
  const NETWORKS = ['undeployed', 'preprod'];
  const INDICES = [...Array.from({ length: 32 }, (_, i) => i), 2 ** 31, 2 ** 32 - 1];
  const lowAccount = new Uint8Array(32); lowAccount[31] = 1;
  const ISSUERS = [ISSUER_1, ...Array.from({ length: 7 }, () => rnd(32)), lowAccount, new Uint8Array(32).fill(0xff)];
  const evmSk = rnd(32), solSeed = rnd(32);
  const wallets: { name: string; scheme: BlindScheme; identity: Uint8Array; sign: (m: Uint8Array) => Uint8Array }[] = [
    { name: 'evm key 1', scheme: 'evm_k256', identity: evmWallet, sign: (m) => personalSign(be(1n), m) },
    { name: 'evm seeded key', scheme: 'evm_k256', identity: evmAddressOf(secp256k1.Point.fromBytes(secp256k1.getPublicKey(evmSk, false)).toAffine()), sign: (m) => personalSign(evmSk, m) },
    { name: 'sol seeded key', scheme: 'sol_ed25519', identity: ed25519.getPublicKey(solSeed), sign: (m) => { const s = ed25519.sign(m, solSeed); assert.ok(ed25519.verify(s, m, ed25519.getPublicKey(solSeed), { zip215: false })); return s; } },
  ];
  for (const w of wallets) {
    const device = new Set<string>();
    for (const network of NETWORKS) {
      for (const accountIndex of INDICES) {
        const c = canonicalSignature(w.scheme, w.sign(blindMessageBytes({ scheme: w.scheme, network, identity: w.identity, accountIndex })));
        device.add(hex(deriveBlind(w.scheme, c)));
      }
    }
    assert.equal(device.size, NETWORKS.length * INDICES.length, `${w.name}: device blinds are distinct`);
    const grantee = new Set<string>();
    let first: Uint8Array | undefined;
    for (const network of NETWORKS) {
      for (const issuingAccount of ISSUERS) {
        const msg = granteeBlindMessageBytes({ scheme: w.scheme, network, identity: w.identity, issuingAccount });
        const s1 = w.sign(msg), s2 = w.sign(msg);
        assert.ok(sameCanonicalSignature(w.scheme, s1, s2), `${w.name}: the grantee request passes the sign-twice check (restorable)`);
        const c = canonicalSignature(w.scheme, s1);
        const blind = deriveBlind(w.scheme, c);
        assert.ok(eq(blind, probe.derive_blind(padTag(BLIND_TAGS[w.scheme]), c)), `${w.name}: the same blind tag and derive_blind as a device`);
        assert.ok(eq(blind, sha(padTag(BLIND_TAGS[w.scheme]), c)));
        assert.ok(!device.has(hex(blind)), `${w.name}: a grantee blind is never one of the wallet's device blinds`);
        assert.ok(!grantee.has(hex(blind)), `${w.name}: two issuing accounts (or networks) give two grantee blinds`);
        grantee.add(hex(blind));
        first ??= blind;
        ok('grantee blind');
      }
    }
    // Restore: the same wallet and issuing account give the same grantee blind again.
    const again = deriveBlind(w.scheme, canonicalSignature(w.scheme, w.sign(granteeBlindMessageBytes({ scheme: w.scheme, network: NETWORKS[0], identity: w.identity, issuingAccount: ISSUERS[0] }))));
    assert.ok(first && eq(again, first), `${w.name}: re-derived grantee blind equals the first`);
    separation.push({ wallet: w.name, scheme: w.scheme, deviceBlinds: device.size, granteeBlinds: grantee.size, issuingAccounts: ISSUERS.length, networks: NETWORKS, granteeEqualsDevice: 0, granteeCollisions: 0 });
  }
  console.log(`  ✓ grantee blind: ${wallets.length} wallets; ${tally['grantee blind'].pass} grantee blinds, none equal to any of the wallet's ${NETWORKS.length * INDICES.length} device blinds; ${ISSUERS.length} issuing accounts × ${NETWORKS.length} networks give ${ISSUERS.length * NETWORKS.length} distinct blinds per wallet; same tag and derive_blind; restorable`);
}

// ── Unknown schemes: refused at client decode, never passed silently ─────────
//
// A descriptor whose scheme the client does not handle (from a dApp's request,
// say) must never pass checkDescriptor as `undefined`, and a blind function
// given such a scheme must never fall back to the Ed25519 form or an all-zero
// tag. Every dispatch over a scheme ends in unknownScheme (a `never` check: a
// scheme added to the type without a case fails to compile). Each bad scheme
// rides on a well-formed EVM payload, so only the scheme is wrong.

const unknownSchemeReport: { schemes: string[]; functions: string[]; refusals: number; knownSchemesAccepted: string[] } = { schemes: [], functions: [], refusals: 0, knownSchemesAccepted: [] };
{
  const ctrBefore = ctr;
  const samples = sampleDescriptors();
  // Positive control: every registered scheme still passes every dispatching function.
  for (const d of samples) {
    const again = checkDescriptor(d);
    for (const r of recipesOf(d.scheme)) {
      assert.deepEqual(payloadParts(again, r), payloadParts(d, r), `${d.scheme}: checkDescriptor keeps the descriptor (${r})`);
      assert.ok(describeDescriptor(r, again).length > 0);
    }
    const s = rnd(32);
    entryCall(again, account, 0n, 0n); if (boots(d.scheme)) bootCall(again, s); grantIdCall(again, account, rnd(32), 0n);
    if (!unknownSchemeReport.knownSchemesAccepted.includes(d.scheme)) unknownSchemeReport.knownSchemesAccepted.push(d.scheme);
    ok('known schemes');
  }
  assert.deepEqual([...unknownSchemeReport.knownSchemesAccepted].sort(), [...DESCRIPTOR_SCHEMES].sort(), 'the positive control covers every registered scheme');
  const evm = samples.find((d) => d.scheme === 'evm_k256')!;
  const sig = new Uint8Array(64).fill(1), salt = rnd(32), oh = rnd(32);
  const BAD: [string, unknown][] = [
    ['an unregistered scheme', 'zz'],
    ['a curve name without its arm', 'ed25519'],
    ['another case', 'EVM_K256'],
    ['a trailing space', 'sol_ed25519 '],
    ['an Object.prototype key', 'constructor'],
    ['__proto__', '__proto__'],
    ['a number', 1],
    ['no scheme', undefined],
  ];
  const fns = new Set<string>();
  const refuse = (why: string, where: string, prefix: 'descriptor' | 'blind', shown: string, f: () => unknown) => {
    const text = `${prefix}: unknown scheme ${shown} in ${where} (registered: `;
    refused('unknown scheme', f, (e: unknown) => e instanceof Error && e.message.includes(text), `${why} (${where})`);
    fns.add(where === 'payloadParts' ? 'payloadParts (via payloadParts, entryCall, grantIdCall)' : where);
  };
  for (const [why, scheme] of BAD) {
    const shown = typeof scheme === 'string' ? JSON.stringify(scheme) : String(scheme);
    unknownSchemeReport.schemes.push(shown);
    const d = { ...evm, scheme } as unknown as Descriptor;
    refuse(why, 'checkDescriptor', 'descriptor', shown, () => checkDescriptor(d));
    refuse(why, 'payloadParts', 'descriptor', shown, () => payloadParts(d, 'device'));
    refuse(why, 'payloadParts', 'descriptor', shown, () => entryCall(d, account, 0n, 0n));
    refuse(why, 'bootCall', 'descriptor', shown, () => bootCall(d, salt));
    refuse(why, 'payloadParts', 'descriptor', shown, () => payloadParts(d, 'boot'));
    refuse(why, 'payloadParts', 'descriptor', shown, () => grantIdCall(d, account, oh, 0n));
    for (const r of ['device', 'boot', 'grant-id'] as DescriptorRecipe[]) refuse(why, 'describeDescriptor', 'descriptor', shown, () => describeDescriptor(r, d));
    const s = scheme as BlindScheme;
    refuse(why, 'canonicalSignature', 'blind', shown, () => canonicalSignature(s, sig));
    refuse(why, 'canonicalSignature', 'blind', shown, () => sameCanonicalSignature(s, sig, sig));
    refuse(why, 'deriveBlind', 'blind', shown, () => deriveBlind(s, sig));
    refuse(why, 'blindCall', 'blind', shown, () => blindCall(s, sig));
    refuse(why, 'the blind request', 'blind', shown, () => blindMessage({ scheme: s, network: 'undeployed', identity: evmWallet, accountIndex: 0 }));
    refuse(why, 'the blind request', 'blind', shown, () => granteeBlindMessage({ scheme: s, network: 'undeployed', identity: evmWallet, issuingAccount: ISSUER_1 }));
    refuse(why, 'blindFormats', 'blind', shown, () => blindFormats(s));
    refuse(why, 'checkBlindFormat', 'blind', shown, () => checkBlindFormat(s, 'raw'));
    refuse(why, 'blindFormats', 'blind', shown, () => restoreBlind({ scheme: s, walletFormats: [], derive: async () => new Uint8Array(32), finds: async () => false }));
    refuse(why, 'checkSigner', 'blind', shown, () => checkSigner(s, evmWallet, () => true));
  }
  // The descriptor schemes that have no blind are unknown to every blind function.
  for (const scheme of ['jubjub', 'k256', 'p256']) {
    const s = scheme as BlindScheme, shown = JSON.stringify(scheme);
    refuse(`${scheme} (no blind)`, 'canonicalSignature', 'blind', shown, () => canonicalSignature(s, sig));
    refuse(`${scheme} (no blind)`, 'deriveBlind', 'blind', shown, () => deriveBlind(s, sig));
    refuse(`${scheme} (no blind)`, 'blindCall', 'blind', shown, () => blindCall(s, sig));
    refuse(`${scheme} (no blind)`, 'the blind request', 'blind', shown, () => blindMessage({ scheme: s, network: 'undeployed', identity: evmWallet, accountIndex: 0 }));
    refuse(`${scheme} (no blind)`, 'blindFormats', 'blind', shown, () => blindFormats(s));
    refuse(`${scheme} (no blind)`, 'checkSigner', 'blind', shown, () => checkSigner(s, evmWallet, () => true));
  }
  assert.match((() => { try { canonicalSignature('k256' as BlindScheme, sig); } catch (e: any) { return e.message; } return ''; })(), /\(registered: evm_k256, sol_ed25519\)$/, 'a blind refusal names the readable schemes');
  assert.match((() => { try { checkDescriptor({ ...evm, scheme: 'zz' } as any); } catch (e: any) { return e.message; } return ''; })(), /\(registered: jubjub, k256, p256, evm_k256, sol_ed25519\)$/, 'a descriptor refusal names the registered schemes');
  // A long scheme is cut in the message.
  refused('unknown scheme', () => checkDescriptor({ ...evm, scheme: 'x'.repeat(5000) } as any), /unknown scheme "x{40}\.\.\." in checkDescriptor/, 'a 5000-character scheme (message cut to 40)');
  // Not a descriptor at all, and a missing tag text.
  refused('unknown scheme', () => checkDescriptor(null as any), /descriptor: not a descriptor object \(null\)$/, 'null');
  refused('unknown scheme', () => checkDescriptor('evm_k256' as any), /descriptor: not a descriptor object \(string\)$/, 'a scheme name instead of a descriptor');
  refused('unknown scheme', () => padTag(undefined as any), /descriptor: a tag is text, not undefined$/, 'padTag(undefined): never an all-zero tag');
  refused('unknown scheme', () => padTag((DESCRIPTOR_TAGS.device as any).zz), /descriptor: a tag is text/, 'a device tag looked up with an unknown scheme');
  refused('unknown scheme', () => padTag((BLIND_TAGS as any).k256), /descriptor: a tag is text/, 'a blind tag looked up with a scheme that has none');
  unknownSchemeReport.functions = [...fns];
  unknownSchemeReport.refusals = tally['unknown scheme'].refused;
  ctr = ctrBefore;
  console.log(`  ✓ unknown schemes: ${BAD.length} bad schemes + 3 blind-less schemes refused at client decode by ${fns.size} dispatch points (${tally['unknown scheme'].refused} refusals); non-objects and missing tag texts refused; all ${DESCRIPTOR_SCHEMES.length} registered schemes still accepted`);
}

// ── Boot commitments: the readable schemes only ──────────────────────────────
//
// A boot commitment exists only for an account's first device, and each
// readable arm activates only its own scheme. A `jubjub`, `k256`, or `p256`
// first device boots through upstream's derive_boot_commitment_with_<scheme>,
// so the module has no descriptor boot recipe for them: every client entry
// point refuses one, naming upstream's circuit, before any other check. (The
// module's own refusal of upstream's boot tags, by every derivation including
// the two boot ones, is tested in wallet-arms-descriptors-offline.ts and, at
// the prover, in constraint-negative-prover.ts.)

const bootReport: { refusedSchemes: string[]; bootSchemesAccepted: string[]; refusals: number } = { refusedSchemes: [], bootSchemesAccepted: [], refusals: 0 };
{
  const ctrBefore = ctr;
  const samples = sampleDescriptors();
  const salt = rnd(32);
  assert.deepEqual([...BOOT_SCHEMES], ['evm_k256', 'sol_ed25519']);
  for (const d of samples) {
    if (boots(d.scheme)) {
      // Positive control: the readable schemes boot through the module's own circuits.
      const call = bootCall(d, salt);
      assert.equal(call.circuit, d.scheme === 'evm_k256' ? 'derive_descriptor_boot_w52' : 'derive_descriptor_boot_ed25519');
      const identity = d.scheme === 'evm_k256' ? d.address : (d as any).key as Uint8Array;
      assert.ok(eq(derive(probe, call), sha(TAG('boot', d), salt, identity, (d as any).blind)), `${d.scheme}: boot == SHA-256 of its preimage`);
      assert.equal(describeDescriptor('boot', d)[0].value, DESCRIPTOR_TAGS.boot[d.scheme as 'evm_k256' | 'sol_ed25519']);
      if (!bootReport.bootSchemesAccepted.includes(d.scheme)) bootReport.bootSchemesAccepted.push(d.scheme);
      ok('boot');
      continue;
    }
    refused('boot', () => bootCall(d, salt), legacyBoot(d.scheme, 'bootCall'), `a ${d.scheme} boot commitment (bootCall)`);
    refused('boot', () => payloadParts(d, 'boot'), legacyBoot(d.scheme, 'payloadParts'), `${d.scheme} boot parts (payloadParts)`);
    refused('boot', () => describeDescriptor('boot', d), legacyBoot(d.scheme, 'describeDescriptor'), `a ${d.scheme} boot display (describeDescriptor)`);
    // The same key keeps its device entry and grant id (positive control).
    derive(probe, entryCall(d, account, 0n, 0n)); derive(probe, grantIdCall(d, account, salt, 0n));
    if (!bootReport.refusedSchemes.includes(d.scheme)) bootReport.refusedSchemes.push(d.scheme);
  }
  assert.deepEqual([...bootReport.refusedSchemes].sort(), ['jubjub', 'k256', 'p256']);
  assert.deepEqual([...bootReport.bootSchemesAccepted].sort(), [...BOOT_SCHEMES].sort());
  // The boot refusal comes first: a passkey without its policy, or a bad
  // salt, is refused as a legacy boot, not for the policy or the salt.
  const jj = samples.find((d) => d.scheme === 'jubjub')! as any;
  const pk = samples.find((d) => d.scheme === 'p256')! as any;
  refused('boot', () => bootCall({ scheme: 'p256', x: pk.x, y: pk.y }, salt), legacyBoot('p256', 'bootCall'), 'a passkey boot without its policy');
  refused('boot', () => bootCall(jj, new Uint8Array(3)), legacyBoot('jubjub', 'bootCall'), 'a jubjub boot with a 3-byte salt');
  bootReport.refusals = tally.boot.refused;
  ctr = ctrBefore;
  console.log(`  ✓ boot: ${bootReport.bootSchemesAccepted.join(' and ')} boot (${tally.boot.pass}); ${bootReport.refusedSchemes.join(', ')} refused by bootCall, payloadParts, and describeDescriptor with upstream's circuit named, before the policy or salt checks (${tally.boot.refused} refusals)`);
}

// ── Formats: each readable arm's signing formats ─────────────────────────────

const formatsReport: Record<string, { formats: string[]; names: string[] }> = {};
{
  for (const scheme of BLIND_SCHEMES) {
    const formats = blindFormats(scheme);
    assert.deepEqual([...formats], Object.keys(READABLE_ARMS[scheme].formats), `${scheme}: blindFormats is the entry's formats, in order`);
    assert.ok(formats.length >= 1, `${scheme}: at least one format`);
    assert.equal(new Set(formats).size, formats.length, `${scheme}: no format listed twice`);
    const names = formats.map((f) => blindFormatName(scheme, f));
    for (const [i, f] of formats.entries()) {
      assert.ok(/^[a-z0-9][a-z0-9-]*$/.test(f), `${scheme}: format code ${f} is lower-case letters, digits and hyphens`);
      assert.equal(checkBlindFormat(scheme, f), f);
      assert.ok(names[i].length > 0 && names[i] === names[i].trim());
      ok('formats');
    }
    formatsReport[scheme] = { formats: [...formats], names };
    const others = BLIND_SCHEMES.filter((s) => s !== scheme).flatMap((s) => blindFormats(s)).filter((f) => !formats.includes(f));
    for (const bad of ['', 'RAW', `${formats[0]} `, 'constructor', '__proto__', 'toString', 'hasOwnProperty', ...others]) {
      const noFormat = (e: unknown) => e instanceof Error && e.message.includes(`blind: ${scheme} has no format`);
      refused('formats', () => checkBlindFormat(scheme, bad), noFormat, `the format ${JSON.stringify(bad)}`);
      refused('formats', () => blindFormatName(scheme, bad), noFormat, `the name of the format ${JSON.stringify(bad)}`);
    }
    for (const bad of [1, undefined, null, ['raw']]) refused('formats', () => checkBlindFormat(scheme, bad), /has no format/, `a ${bad === null ? 'null' : typeof bad} format`);
  }
  assert.deepEqual(formatsReport.sol_ed25519.formats, ['raw', 'offchain'], 'the Solana arm signs raw and off-chain');
  assert.deepEqual(formatsReport.evm_k256.formats, ['eip712-v1'], 'the EVM arm has one format');
  console.log(`  ✓ formats: ${BLIND_SCHEMES.map((s) => `${s} ${formatsReport[s].formats.join('/')}`).join(', ')}; ${tally.formats.refused} other values refused`);
}

// ── Restore: the cache, the stored format, else every format the wallet signs ─
//
// A model wallet per case: derive(format) stands for the wallet signing the
// blind request in that format twice (its blind a fixed function of the
// format and of the wallet), and finds(blind) for testing the account's
// entries (enrolled by the same wallet unless `enrolledBy` names another).
// Each case records which formats the wallet was asked for: never one it
// cannot sign, and none when the blind is cached.

interface RestoreCase { case: string; scheme: string; role: string; result: string; asked: string[]; tested: string[]; message?: string }
const restoreCases: RestoreCase[] = [];
{
  const blindOf = (scheme: string, format: string, seed: string) => sha(new TextEncoder().encode(`${scheme}/${format}/${seed}`));
  const run = async (name: string, scheme: BlindScheme, opts: {
    role?: 'device' | 'grantee'; stored?: { format: string; cached?: boolean }; wallet: string[]; enrolled: string[]; enrolledBy?: string;
  }) => {
    const asked: string[] = [], tested: string[] = [];
    const account = new Set(opts.enrolled.map((f) => hex(blindOf(scheme, f, opts.enrolledBy ?? name))));
    const r = await restoreBlind({
      scheme, role: opts.role, walletFormats: opts.wallet,
      stored: opts.stored && { format: opts.stored.format, ...(opts.stored.cached ? { blind: blindOf(scheme, opts.stored.format, name) } : {}) },
      derive: async (f) => { asked.push(f); return blindOf(scheme, f, name); },
      finds: async (b, f) => { tested.push(f); return account.has(hex(b)); },
    });
    for (const f of asked) assert.ok(opts.wallet.includes(f), `${name}: the wallet is never asked for a format it cannot sign (${f})`);
    restoreCases.push({ case: name, scheme, role: opts.role ?? 'device', result: r.ok === true ? r.source : r.reason, asked, tested, ...(r.ok === true ? {} : { message: r.message }) });
    ok('restore');
    return { r, asked, tested };
  };
  const matchesOf = (r: Awaited<ReturnType<typeof restoreBlind>>) => (r.ok === true ? r.matches.map((m) => m.format) : []);

  for (const scheme of BLIND_SCHEMES) {
    const all = [...blindFormats(scheme)];
    for (const f of all) {
      // 1. The cache: no signature asked, nothing tested.
      let x = await run(`${scheme} cache ${f}`, scheme, { stored: { format: f, cached: true }, wallet: [], enrolled: [f] });
      assert.ok(x.r.ok === true && x.r.source === 'cache' && eq(x.r.matches[0].blind, blindOf(scheme, f, `${scheme} cache ${f}`)));
      assert.deepEqual([x.asked, x.tested], [[], []]);
      // 2. The stored format, the cache lost, a wallet that signs it: derived once, in that format, and tested.
      x = await run(`${scheme} stored ${f}`, scheme, { stored: { format: f }, wallet: all, enrolled: [f] });
      assert.ok(x.r.ok === true && x.r.source === 'stored-format' && x.r.matches.length === 1 && x.r.matches[0].format === f);
      assert.ok(eq(x.r.ok === true ? x.r.matches[0].blind : new Uint8Array(), blindOf(scheme, f, `${scheme} stored ${f}`)), 'the stored format re-derives the blind');
      assert.deepEqual([x.asked, x.tested], [[f], [f]]);
      // 2b. The stored format, the cache lost, a wallet that derives another blind in it (the device was
      // enrolled by another wallet of the same key): refused, nothing else derived, the remedy given.
      for (const role of ['device', 'grantee'] as const) {
        x = await run(`${scheme} ${role} stored ${f}, another wallet's blind`, scheme, { role, stored: { format: f }, wallet: all, enrolled: [f], enrolledBy: `${scheme} enrolling wallet` });
        assert.ok(x.r.ok === false && x.r.reason === 'not-found', `${scheme} ${role} stored ${f}: a blind that finds nothing is not a match`);
        assert.deepEqual([x.asked, x.tested], [[f], [f]], 'derived once, in the stored format only, and tested');
        if (x.r.ok === false) {
          assert.deepEqual([x.r.tried, x.r.untried], [[f], []]);
          const what = role === 'device' ? 'device' : 'grant';
          assert.ok(x.r.message.startsWith(`${role === 'device' ? 'No account was found' : 'No grant was found'} with the privacy key this wallet derives in the ${blindFormatName(scheme, f)} format, the format this ${what} was ${role === 'device' ? 'enrolled' : 'issued'} through.`), x.r.message);
          assert.ok(x.r.message.endsWith(role === 'device'
            ? 'Use that wallet, or add this wallet as a new device from another device of the account, or through the account\'s recovery.'
            : 'Use that wallet, or ask the issuing account\'s owner for a new grant to this wallet.'), x.r.message);
        }
      }
      // 3. The stored format, a wallet that cannot sign it: nothing derived, the format named.
      const without = all.filter((g) => g !== f);
      x = await run(`${scheme} stored ${f}, wallet without it`, scheme, { stored: { format: f }, wallet: without, enrolled: [f] });
      assert.ok(x.r.ok === false && x.r.reason === 'format-unavailable');
      assert.deepEqual(x.asked, [], 'never derived in another format');
      if (x.r.ok === false) {
        assert.ok(x.r.message.includes(`derived in the ${blindFormatName(scheme, f)} format, which this wallet cannot sign`), x.r.message);
        assert.ok(x.r.message.endsWith('or add this wallet as a new device from another device of the account, or through the account\'s recovery.'), x.r.message);
      }
      // 4. No record: every format the wallet signs is tried; the enrolled one matches.
      x = await run(`${scheme} search finds ${f}`, scheme, { wallet: all, enrolled: [f] });
      assert.deepEqual(matchesOf(x.r), [f]);
      assert.deepEqual(x.asked, all, 'every format the wallet signs, in the entry order');
      assert.deepEqual(x.tested, all);
      // 5. No record, the device in a format the wallet cannot sign: not found, the other format named.
      if (without.length > 0) {
        x = await run(`${scheme} search, device in ${f}, wallet without it`, scheme, { wallet: without, enrolled: [f] });
        assert.ok(x.r.ok === false && x.r.reason === 'not-found');
        assert.deepEqual(x.asked, without);
        if (x.r.ok === false) {
          assert.deepEqual([x.r.tried, x.r.untried], [without, [f]]);
          assert.ok(x.r.message.startsWith(`No account was found in the formats this wallet can sign (${without.map((g) => blindFormatName(scheme, g)).join(', ')}).`), x.r.message);
          assert.ok(x.r.message.includes(`The device may have been enrolled through another format (${blindFormatName(scheme, f)}).`), x.r.message);
        }
      }
    }
    // 6. No record, devices in every format: one match per format, in order.
    let x = await run(`${scheme} search, a device in every format`, scheme, { wallet: all, enrolled: all });
    assert.deepEqual(matchesOf(x.r), all);
    // 7. No record, no device: not found; with every format tried, no other format is named.
    x = await run(`${scheme} search, no device`, scheme, { wallet: all, enrolled: [] });
    assert.ok(x.r.ok === false && x.r.reason === 'not-found' && x.r.untried.length === 0 && !x.r.message.includes('another format'), 'every format tried: no other format to name');
    // 8. A wallet that signs none of the formats: nothing asked.
    x = await run(`${scheme} a wallet with no format`, scheme, { wallet: [], enrolled: all });
    assert.ok(x.r.ok === false && x.r.reason === 'no-format');
    assert.deepEqual([x.asked, x.tested], [[], []]);
    // 9. A grantee: the same rules, the grant's wording.
    x = await run(`${scheme} grantee search, no grant`, scheme, { role: 'grantee', wallet: [all[0]], enrolled: all.slice(1) });
    assert.ok(x.r.ok === false && x.r.message.startsWith('No grant was found in the formats this wallet can sign') && x.r.message.endsWith('Ask the issuing account\'s owner for a new grant to this wallet.'), x.r.ok === false ? x.r.message : '');
    if (all.length > 1 && x.r.ok === false) assert.ok(x.r.message.includes('The grant may have been issued through another format'), x.r.message);
    x = await run(`${scheme} grantee stored ${all[0]}, wallet without it`, scheme, { role: 'grantee', stored: { format: all[0] }, wallet: all.slice(1), enrolled: [all[0]] });
    assert.ok(x.r.ok === false && x.r.reason === 'format-unavailable' && x.r.message.startsWith('This grant\'s privacy key was derived in the'));
  }

  // User Story 4, scenario 2 with real signatures: a Solana key enrolled
  // through a raw-only wallet, restored with an off-chain-only wallet holding
  // the same seed. The two blind requests are the same text, the off-chain one
  // under the off-chain message v1 head (an independent encoder here), so the
  // two blinds differ; the off-chain-only wallet is never asked for the raw
  // request, so the raw blind is never derived from it.
  {
    const seed = rnd(32), key = ed25519.getPublicKey(seed);
    const text = blindMessageBytes({ scheme: 'sol_ed25519', network: 'undeployed', identity: key, accountIndex: 0 });
    const offchainHead = new Uint8Array([0xff, ...new TextEncoder().encode('solana offchain'), 1, 1, ...key]);
    const bytesIn = (f: string) => (f === 'raw' ? text : new Uint8Array([...offchainHead, ...text]));
    const blindIn = (f: string) => {
      const a = ed25519.sign(bytesIn(f), seed), b = ed25519.sign(bytesIn(f), seed);
      assert.ok(sameCanonicalSignature('sol_ed25519', a, b), 'the sign-twice check');
      return deriveBlind('sol_ed25519', canonicalSignature('sol_ed25519', a));
    };
    const enrolled = blindIn('raw');
    assert.ok(!eq(enrolled, blindIn('offchain')), 'the raw and off-chain blinds of one key differ (a device is bound to its format)');
    const asked: string[] = [];
    const wallet = { walletFormats: ['offchain'], derive: async (f: string) => { asked.push(f); return blindIn(f); }, finds: async (b: Uint8Array) => eq(b, enrolled) };
    const none = await restoreBlind({ scheme: 'sol_ed25519', ...wallet });
    assert.ok(none.ok === false && none.reason === 'not-found');
    assert.equal(none.ok === false && none.message, 'No account was found in the formats this wallet can sign (off-chain). The device may have been enrolled through another format (raw). ' +
      'Add this wallet as a new device from another device of the account, or through the account\'s recovery.');
    const named = await restoreBlind({ scheme: 'sol_ed25519', stored: { format: 'raw' }, ...wallet });
    assert.ok(named.ok === false && named.reason === 'format-unavailable' && named.message.includes('derived in the raw format'));
    assert.deepEqual(asked, ['offchain'], 'the off-chain-only wallet signed the off-chain request only');
    const restored = await restoreBlind({ scheme: 'sol_ed25519', stored: { format: 'raw' }, walletFormats: ['raw', 'offchain'], derive: async (f) => blindIn(f), finds: async (b) => eq(b, enrolled) });
    assert.ok(restored.ok === true && eq(restored.matches[0].blind, enrolled), 'a raw-signing wallet with the stored format re-derives the enrolled blind');
    restoreCases.push({ case: 'sol_ed25519 user story 4 scenario 2 (real signatures)', scheme: 'sol_ed25519', role: 'device', result: 'not-found, then format-unavailable, then stored-format', asked, tested: [], message: none.ok === false ? none.message : '' });
    ok('restore');
  }

  // The same key and format through a deterministic wallet with another nonce
  // rule, with real signatures: both of its signatures verify under the key
  // and equal each other (the sign-twice check passes), but they are not the
  // enrolling wallet's, so the blind it derives differs. With the cache lost,
  // the stored-format restore must refuse that blind with the remedy; the
  // enrolling wallet restores. Ed25519: RFC 8032 against a nonce taken from
  // another hash of the same secret; EIP-191 secp256k1: RFC 6979 against
  // RFC 6979 with a fixed additional input.
  {
    const ED_L = ed25519.Point.Fn.ORDER;
    const leInt = (b: Uint8Array) => { let v = 0n; for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return v; };
    const leBytes = (v: bigint) => { const o = new Uint8Array(32); let x = v; for (let i = 0; i < 32; i++) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
    const sha512 = (...p: Uint8Array[]) => { const h = createHash('sha512'); for (const x of p) h.update(x); return new Uint8Array(h.digest()); };
    const otherNonceSign = (seed: Uint8Array, m: Uint8Array) => {
      const e = ed25519.utils.getExtendedPublicKey(seed);
      const r = leInt(sha512(sha512(new TextEncoder().encode('another nonce rule'), e.prefix).subarray(0, 32), m)) % ED_L;
      const R = ed25519.Point.BASE.multiply(r).toBytes();
      const k = leInt(sha512(R, e.pointBytes, m)) % ED_L;
      return new Uint8Array([...R, ...leBytes((r + k * e.scalar) % ED_L)]);
    };
    const edSeed = rnd(32), edKey = ed25519.getPublicKey(edSeed);
    const edText = blindMessageBytes({ scheme: 'sol_ed25519', network: 'undeployed', identity: edKey, accountIndex: 0 });
    const k1Secret = be(0x1234567n), k1Address = evmAddressOf(secp256k1.Point.fromBytes(secp256k1.getPublicKey(k1Secret, false)).toAffine());
    const k1Text = blindMessageBytes({ scheme: 'evm_k256', network: 'undeployed', identity: k1Address, accountIndex: 0 });
    const k1Digest = keccak_256(new Uint8Array([...new TextEncoder().encode(`\x19Ethereum Signed Message:\n${k1Text.length}`), ...k1Text]));
    const additional = new Uint8Array(32).fill(0x5a);
    const k1Sign = (extra?: Uint8Array) => {
      const rec = secp256k1.sign(k1Digest, k1Secret, { prehash: false, format: 'recovered', ...(extra ? { extraEntropy: extra } : {}) });
      return new Uint8Array([...rec.subarray(1), 27 + rec[0]]);
    };
    const wallets: { scheme: BlindScheme; format: string; enrolling: () => Uint8Array; other: () => Uint8Array; verifies: (sig: Uint8Array) => boolean }[] = [
      { scheme: 'sol_ed25519', format: 'raw', enrolling: () => ed25519.sign(edText, edSeed), other: () => otherNonceSign(edSeed, edText),
        verifies: (sig) => ed25519.verify(sig, edText, edKey) },
      { scheme: 'evm_k256', format: 'eip712-v1', enrolling: () => k1Sign(), other: () => k1Sign(additional),
        verifies: (sig) => eq(evmAddressOf(secp256k1.Signature.fromBytes(sig.subarray(0, 64), 'compact').addRecoveryBit(sig[64] - 27).recoverPublicKey(k1Digest).toAffine()), k1Address) },
    ];
    for (const w of wallets) {
      const blindFrom = (sign: () => Uint8Array) => {
        const a = sign(), b = sign();
        assert.ok(w.verifies(a) && w.verifies(b), `${w.scheme}: both signatures verify under the key`);
        assert.ok(sameCanonicalSignature(w.scheme, a, b), `${w.scheme}: the wallet is deterministic (the sign-twice check passes)`);
        return deriveBlind(w.scheme, canonicalSignature(w.scheme, a));
      };
      const enrolled = blindFrom(w.enrolling);
      assert.ok(!eq(enrolled, blindFrom(w.other)), `${w.scheme}: another nonce rule gives another blind for the same key, format and request`);
      for (const role of ['device', 'grantee'] as const) {
        const tested: Uint8Array[] = [];
        const request = (sign: () => Uint8Array) => ({ scheme: w.scheme, role, stored: { format: w.format }, walletFormats: [w.format],
          derive: async () => blindFrom(sign), finds: async (b: Uint8Array) => { tested.push(b); return eq(b, enrolled); } });
        const other = await restoreBlind(request(w.other));
        assert.ok(other.ok === false && other.reason === 'not-found', `${w.scheme} ${role}: the other wallet's blind is refused`);
        assert.ok(other.ok === false && other.message.endsWith(role === 'device'
          ? 'add this wallet as a new device from another device of the account, or through the account\'s recovery.'
          : 'ask the issuing account\'s owner for a new grant to this wallet.'), other.ok === false ? other.message : '');
        const same = await restoreBlind(request(w.enrolling));
        assert.ok(same.ok === true && same.source === 'stored-format' && eq(same.matches[0].blind, enrolled), `${w.scheme} ${role}: the enrolling wallet restores`);
        assert.equal(tested.length, 2, 'each derived blind is tested once');
        restoreCases.push({ case: `${w.scheme} ${role} stored format, another deterministic nonce rule (real signatures)`, scheme: w.scheme, role,
          result: 'not-found, then stored-format', asked: [w.format, w.format], tested: [w.format, w.format], message: other.ok === false ? other.message : '' });
        ok('restore');
      }
    }
  }

  // Refusals: a malformed request throws before the wallet is asked.
  const never = async (): Promise<Uint8Array> => { throw new Error('the wallet must not be asked'); };
  const base = { scheme: 'sol_ed25519' as BlindScheme, walletFormats: ['raw'], derive: never, finds: async () => false };
  refused('restore', () => restoreBlind({ ...base, walletFormats: ['raw', 'raw'] }), /lists a format twice/, 'a format listed twice');
  refused('restore', () => restoreBlind({ ...base, walletFormats: ['eip712-v1'] }), /sol_ed25519 has no format "eip712-v1"/, 'another arm\'s format');
  refused('restore', () => restoreBlind({ ...base, walletFormats: 'raw' as any }), /walletFormats is a list/, 'a string for the list');
  refused('restore', () => restoreBlind({ ...base, stored: { format: 'RAW' } }), /has no format "RAW"/, 'an unknown stored format');
  refused('restore', () => restoreBlind({ ...base, stored: { format: 'raw', blind: new Uint8Array(31) } }), /the cached blind for sol_ed25519 is not 32 bytes/, 'a 31-byte cached blind');
  refused('restore', () => restoreBlind({ ...base, role: 'owner' as any }), /unknown role/, 'an unknown role');
  await assert.rejects(restoreBlind({ ...base, stored: { format: 'raw' }, derive: async () => new Uint8Array(33) }), /the derived blind for sol_ed25519 is not 32 bytes/);
  (tally.restore ??= { pass: 0, refused: 0 }).refused++;
  await assert.rejects(restoreBlind({ ...base, derive: async () => new Uint8Array(31) }), /the derived blind for sol_ed25519 is not 32 bytes/);
  (tally.restore ??= { pass: 0, refused: 0 }).refused++;
  // finds must answer true to match.
  const truthy = await restoreBlind({ ...base, derive: async () => new Uint8Array(32), finds: async () => 1 as any });
  assert.ok(truthy.ok === false && truthy.reason === 'not-found', 'only `true` is a match');
  const truthyStored = await restoreBlind({ ...base, stored: { format: 'raw' }, derive: async () => new Uint8Array(32), finds: async () => 1 as any });
  assert.ok(truthyStored.ok === false && truthyStored.reason === 'not-found', 'only `true` is a match for a blind derived in the stored format');
  console.log(`  ✓ restore: ${tally.restore.pass} cases (cache, stored format, a stored-format blind that finds nothing refused, format unavailable, search over every format the wallet signs, matches in two formats, no device, no format, grantee wording; user story 4 scenario 2 with real Ed25519 signatures; another deterministic nonce rule refused with real Ed25519 and secp256k1 signatures); the wallet never asked for a format it cannot sign; ${tally.restore.refused} malformed requests refused`);
}

// ── The signer check: refused before proving, another key named only if verified ─

interface SignerCase { case: string; scheme: string; result: string; signer?: string }
const signerCases: SignerCase[] = [];
{
  // `text` is the exact refusal message, or a literal pattern for a message part.
  const expectMismatch = (name: string, scheme: BlindScheme, f: () => void, signer: Uint8Array | undefined, text: string | RegExp) => {
    let err: unknown;
    try { f(); } catch (e) { err = e; }
    assert.ok(err instanceof SignerMismatchError, `${name}: a SignerMismatchError`);
    const e = err as SignerMismatchError;
    assert.equal(e.scheme, scheme);
    assert.ok(signer === undefined ? e.signer === undefined : (e.signer !== undefined && eq(e.signer, signer)), `${name}: the named signer`);
    if (typeof text === 'string') assert.equal(e.message, text, name);
    else assert.match(e.message, text, name);
    signerCases.push({ case: name, scheme, result: signer ? 'another key named' : 'unknown signer', ...(signer ? { signer: hex(signer) } : {}) });
    (tally.signer ??= { pass: 0, refused: 0 }).refused++;
  };
  // Solana: the arm's verification over the exact bytes (strict RFC 8032).
  {
    const phantom = rnd(32), backpack = rnd(32), third = rnd(32);
    const [pk1, pk2, pk3] = [phantom, backpack, third].map((s) => ed25519.getPublicKey(s));
    const msg = new TextEncoder().encode('an approval text');
    const verifiesFor = (sig: Uint8Array) => (identity: Uint8Array) => ed25519.verify(sig, msg, identity, { zip215: false });
    const own = ed25519.sign(msg, phantom), foreign = ed25519.sign(msg, backpack);
    checkSigner('sol_ed25519', pk1, verifiesFor(own), [pk2]);
    ok('signer');
    // The Backpack-for-Phantom case: the wallet reports Phantom's key, Backpack signed.
    expectMismatch('sol: another connected wallet signed', 'sol_ed25519', () => checkSigner('sol_ed25519', pk1, verifiesFor(foreign), [pk1, pk3, pk2]), pk2,
      `signer: refused before proving: the signature is not from the expected Solana public key ${base58Encode(pk1)}; it verifies under Solana public key ${base58Encode(pk2)}, another wallet's key`);
    expectMismatch('sol: the signer is not among the candidates', 'sol_ed25519', () => checkSigner('sol_ed25519', pk1, verifiesFor(foreign), [pk1, pk3]), undefined,
      `signer: refused before proving: the signature is not from the expected Solana public key ${base58Encode(pk1)}, and the signer is unknown`);
    expectMismatch('sol: no candidates', 'sol_ed25519', () => checkSigner('sol_ed25519', pk1, verifiesFor(foreign)), undefined, /the signer is unknown$/);
    // Candidates that are not keys are skipped; the reported key itself is never named.
    expectMismatch('sol: junk candidates', 'sol_ed25519', () => checkSigner('sol_ed25519', pk1, verifiesFor(foreign), [new Uint8Array(31), unhex(ED25519_TORSION_SUBGROUP[0]), pk1]), undefined, /the signer is unknown$/);
    // A signature of other bytes verifies under no key.
    const other = ed25519.sign(new TextEncoder().encode('other bytes'), phantom);
    expectMismatch('sol: other bytes signed', 'sol_ed25519', () => checkSigner('sol_ed25519', pk1, verifiesFor(other), [pk2, pk3]), undefined, /the signer is unknown$/);
    // A throwing verification counts as "does not verify".
    expectMismatch('sol: a throwing verification', 'sol_ed25519', () => checkSigner('sol_ed25519', pk1, () => { throw new Error('bad signature'); }, [pk2]), undefined, /the signer is unknown$/);
    refused('signer', () => checkSigner('sol_ed25519', unhex(ED25519_TORSION_SUBGROUP[0]), verifiesFor(own)), /small order|canonical/, 'an expected key that is not admissible');
  }
  // EVM: the arm's verification is recovery of the address from the digest.
  {
    const sks = [rnd(32), rnd(32), rnd(32)];
    const addrOf = (sk: Uint8Array) => evmAddressOf(secp256k1.Point.fromBytes(secp256k1.getPublicKey(sk, false)).toAffine());
    const [a1, a2, a3] = sks.map(addrOf);
    const msg = new TextEncoder().encode('an approval digest stands in here');
    const digest = keccak_256(new Uint8Array([...new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`), ...msg]));
    const verifiesFor = (sig: Uint8Array) => (identity: Uint8Array) => {
      const s = secp256k1.Signature.fromBytes(sig.subarray(0, 64), 'compact').addRecoveryBit(sig[64] - 27);
      return eq(evmAddressOf(s.recoverPublicKey(digest).toAffine()), identity);
    };
    const own = personalSign(sks[0], msg), foreign = personalSign(sks[1], msg);
    checkSigner('evm_k256', a1, verifiesFor(own), [a2]);
    ok('signer');
    expectMismatch('evm: another connected wallet signed', 'evm_k256', () => checkSigner('evm_k256', a1, verifiesFor(foreign), [a3, a2]), a2,
      `signer: refused before proving: the signature is not from the expected Ethereum address ${evmChecksumAddress(a1)}; it verifies under Ethereum address ${evmChecksumAddress(a2)}, another wallet's key`);
    expectMismatch('evm: the signer is not among the candidates', 'evm_k256', () => checkSigner('evm_k256', a1, verifiesFor(foreign), [a3]), undefined, /and the signer is unknown$/);
    expectMismatch('evm: junk candidates', 'evm_k256', () => checkSigner('evm_k256', a1, verifiesFor(foreign), [new Uint8Array(20), rnd(19), a1]), undefined, /and the signer is unknown$/);
    refused('signer', () => checkSigner('evm_k256', new Uint8Array(20), verifiesFor(own)), /zero address/, 'the zero address expected');
  }
  console.log(`  ✓ signer check: the expected signer passes (${tally.signer.pass}); ${signerCases.length} mismatches refused before proving, another key named only when the signature verifies under it (Solana and EVM; the reported key never named on the wallet's word); ${tally.signer.refused - signerCases.length} bad expected keys refused`);
}

const report = {
  suite: 'wallet-arms-client-offline', seed: SEED, ranAt: new Date().toISOString(), tally,
  goldenEvmMessage: GOLDEN_EVM, solanaMessage: solMsg,
  goldenEvmGranteeMessage: GOLDEN_EVM_GRANTEE, solanaGranteeMessage: solGranteeMsg, granteeBlindSeparation: separation,
  unknownSchemes: unknownSchemeReport, boot: bootReport,
  formats: formatsReport, restore: restoreCases, signer: signerCases,
  verdict: 'PASS',
};
if (process.env.EVIDENCE_DIR) {
  const file = path.join(process.env.EVIDENCE_DIR, 'wallet-arms-client-offline.json');
  fs.mkdirSync(process.env.EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  console.log(`\n■ evidence → ${file}`);
}
console.log('\n◆ wallet-arms-client-offline: PASS');
