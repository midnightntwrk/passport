// Offline suite of the `evm_eip712` arm (contracts/account-evm-eip712.compact,
// src/wallet/signer-evm-eip712.ts). No node, no proof server.
//
//   recipes      derive_{device_entry,boot_commitment,grant_id}_with_evm_eip712
//                equal the descriptor module's width-52 circuits and SHA-256 of
//                the specified preimage (Node crypto), on seeded vectors with
//                edge epochs and counters
//   keys         compute_public_point_with_evm_eip712 equals noble and the
//                k256 helper; evm_eip712_address equals keccak256(x || y)[12..]
//                and refuses the point at infinity in both encodings
//   signatures   the wallet form r || s || v: parsing, refusals, the high-S
//                twin, EIP-191 digests, point recovery
//   blind        enrolment: the request signed twice, the sign-twice check (a
//                hedged wallet refused), the blind equal to derive_blind and to
//                SHA-256 of the specified preimage, the recovered point equal
//                to the wallet's key, a wallet that lies about its address
//                refused, per-index and per-network separation
//   roster       record round trip; a record whose address is not its point's
//                refused; restore finds accounts by testing entries
//   codec        the frozen vectors src/tests/vectors/evm-eip712-v1.json,
//                whose hashes viem computed: for every vector the client
//                codec rebuilds the same typed data, and its digest, the
//                contract's struct hash, domain separator and digest all equal
//                the frozen ones; the type strings equal viem's encodeType;
//                every negative vector is refused by each layer it names
//                (client codec, generated JavaScript of the pure circuits);
//                the descriptor derivations equal descriptors.ts; the no-blob
//                classification of every signed member
//
// The independent check against viem lives in evm-eip712-viem.ts (viem is
// not a dependency of this package). Writes
// $EVIDENCE_DIR/evm-eip712-offline.json when EVIDENCE_DIR is set; never writes
// into the repository.

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { p256 as p256Curve } from '@noble/curves/nist.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { pureCircuits } from '../wallet/contract.js';
import { pureCircuits as baseProbe } from '../../contracts/managed/probe-wallet-arms-base/contract/index.js';
import { RECIPIENT_KIND_LABELS, K256_ENVELOPE_LABELS, recipientKindLabel, k256EnvelopeLabel } from '../wallet/labels.js';
import { NEVER_TEXT, NOT_APPLICABLE_TEXT, NO_WINDOW_TEXT, utcDateTimeInputs, base58Inputs, siteAmountLabelBytes } from '../wallet/rendering.js';
import { padTag, evmAddressOf, evmChecksumAddress } from '../wallet/descriptors.js';
import { blindMessageBytes } from '../wallet/blind.js';
import { evmEip712KeyHint, accountHashHint, bytesHint } from '../wallet/evm-eip712-hints.js';
import {
  EVM_EIP712_PRIMARY_TYPES, EVM_EIP712_DESCRIPTOR_TYPES, typedDataDigest, typeString, siteLabelText, toHex,
  expiryText, passkeyRpWord, windowWord, amountLabelText, solanaKeyText, EVM_EIP712_PASSKEY_RP_POINTER, EVM_EIP712_WINDOW_POINTER,
  EVM_EIP712_AMOUNT_LABEL_PREFIX,
} from '../wallet/evm-eip712-codec.js';
import { typedDataOf, contractStructHash, NEGATIVES, descriptorInput, granteeInput, VECTOR_FILE, type VectorInput } from './evm-eip712-vectors.js';
import {
  EvmEip712Device, EvmEip712Grantee, SoftwareEvmWallet, enrolEvmBlind, enrolEvmGranteeBlind, solArgs, highSTwin, parseEvmSignature, personalMessageDigest,
  checkEvmEip712GranteeInput, evmEip712GranteeInput, issueGrantWithEvmEip712, revokeGrantWithEvmEip712,
  recoverEvmPoint, restoreEvmDevices, serialiseEvmSignature, SECP256K1_ORDER,
  type EvmWallet,
} from '../wallet/signer-evm-eip712.js';

const SEED = 'evm-eip712-offline/v1';
let ctr = 0;
const rnd = (n: number): Uint8Array => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 32) out.set(createHash('sha256').update(SEED).update(String(ctr++)).digest().subarray(0, Math.min(32, n - i)), i);
  return out;
};
const sha = (...p: Uint8Array[]) => { const h = createHash('sha256'); for (const x of p) h.update(x); return new Uint8Array(h.digest()); };
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const le = (v: bigint, w: number) => { const o = new Uint8Array(w); let x = v; for (let i = 0; i < w; i++) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const be = (v: bigint, w = 32) => { const o = new Uint8Array(w); let x = v; for (let i = w - 1; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const beInt = (b: Uint8Array) => { let v = 0n; for (const x of b) v = (v << 8n) | BigInt(x); return v; };
const scalar = () => { for (;;) { const k = beInt(rnd(32)); if (k > 0n && k < SECP256K1_ORDER) return k; } };

const tally: Record<string, { pass: number; refused: number }> = {};
const ok = (k: string, n = 1) => { (tally[k] ??= { pass: 0, refused: 0 }).pass += n; };
const refused = (k: string, f: () => unknown, re: RegExp, why: string) => {
  assert.throws(f, re, `${k}: must refuse ${why}`);
  (tally[k] ??= { pass: 0, refused: 0 }).refused++;
};
const refusedAsync = async (k: string, f: () => Promise<unknown>, re: RegExp, why: string) => {
  await assert.rejects(f, re, `${k}: must refuse ${why}`);
  (tally[k] ??= { pass: 0, refused: 0 }).refused++;
};
const pc = pureCircuits as any;
const vectors: Record<string, unknown[]> = {};

// ── Recipes ──────────────────────────────────────────────────────────────────

const DEVICE_TAG = padTag('midnight:account:device:evm:v1');
const BOOT_TAG = padTag('midnight:account:boot:evm:v1');
const GRANT_ID_TAG = padTag('midnight:account:grant:id:evm:v1');
const BLIND_TAG = padTag('midnight:account:blind:evm:v1');
assert.ok(eq(pc.device_tag_evm_eip712(), DEVICE_TAG) && eq(pc.boot_tag_evm_eip712(), BOOT_TAG)
  && eq(pc.grant_id_tag_evm_eip712(), GRANT_ID_TAG) && eq(pc.blind_tag_evm_eip712(), BLIND_TAG), 'the arm hashes the registered evm:v1 tags');
ok('tags', 4);

const EDGE_EPOCHS = [0n, 1n, 0xffffffffn];
const EDGE_COUNTERS = [0n, 1n, 255n, 256n, 0xffffffffffffffffn];
vectors.entry = []; vectors.boot = []; vectors.grantId = [];
for (let i = 0; i < 24; i++) {
  const A = rnd(32), address = rnd(20), blind = rnd(32), salt = rnd(32), originHash = rnd(32);
  const epoch = i < EDGE_EPOCHS.length ? EDGE_EPOCHS[i] : beInt(rnd(4));
  const counter = i < EDGE_COUNTERS.length ? EDGE_COUNTERS[i] : beInt(rnd(8));
  const slot = BigInt(rnd(1)[0]);
  const entry = pc.derive_device_entry_with_evm_eip712({ bytes: A }, address, blind, epoch, counter);
  assert.ok(eq(entry, sha(DEVICE_TAG, A, address, blind, le(epoch, 4), le(counter, 8))), 'entry == SHA-256 of its preimage');
  assert.ok(eq(entry, pc.derive_descriptor_entry_w52(DEVICE_TAG, { bytes: A }, address, blind, epoch, counter)), 'entry == the module');
  const boot = pc.derive_boot_commitment_with_evm_eip712(salt, address, blind);
  assert.ok(eq(boot, sha(BOOT_TAG, salt, address, blind)), 'boot == SHA-256 of its preimage');
  assert.ok(eq(boot, pc.derive_descriptor_boot_w52(BOOT_TAG, salt, address, blind)), 'boot == the module');
  const gid = pc.derive_grant_id_with_evm_eip712({ bytes: A }, address, blind, originHash, slot);
  assert.ok(eq(gid, sha(GRANT_ID_TAG, A, address, blind, originHash, le(slot, 1))), 'grant id == SHA-256 of its preimage');
  assert.ok(eq(gid, pc.derive_descriptor_grant_id_w52(GRANT_ID_TAG, { bytes: A }, address, blind, originHash, slot)), 'grant id == the module');
  if (i < 3) {
    vectors.entry.push({ account: hex(A), address: hex(address), blind: hex(blind), epoch: String(epoch), counter: String(counter), entry: hex(entry) });
    vectors.boot.push({ salt: hex(salt), address: hex(address), blind: hex(blind), boot: hex(boot) });
    vectors.grantId.push({ account: hex(A), address: hex(address), blind: hex(blind), originHash: hex(originHash), slot: String(slot), grantId: hex(gid) });
  }
  ok('recipes', 3);
}
{
  // The blind is load-bearing: the same address under another blind, account,
  // epoch or counter gives another entry.
  const A = rnd(32), address = rnd(20), blind = rnd(32);
  const base = pc.derive_device_entry_with_evm_eip712({ bytes: A }, address, blind, 0n, 0n);
  for (const other of [
    pc.derive_device_entry_with_evm_eip712({ bytes: A }, address, rnd(32), 0n, 0n),
    pc.derive_device_entry_with_evm_eip712({ bytes: rnd(32) }, address, blind, 0n, 0n),
    pc.derive_device_entry_with_evm_eip712({ bytes: A }, address, blind, 1n, 0n),
    pc.derive_device_entry_with_evm_eip712({ bytes: A }, address, blind, 0n, 1n),
    pc.derive_device_entry_with_evm_eip712({ bytes: A }, rnd(20), blind, 0n, 0n),
  ]) assert.ok(!eq(base, other));
  ok('recipes', 5);
}
console.log(`  ✓ recipes: entry, boot and grant id == the module's w52 circuits == SHA-256 of the specified preimage (${tally.recipes.pass} checks)`);

// ── Keys ─────────────────────────────────────────────────────────────────────

const G = secp256k1.Point.BASE;
vectors.keys = [];
for (const k of [1n, 2n, SECP256K1_ORDER - 1n, ...Array.from({ length: 21 }, scalar)]) {
  const pt = pc.compute_public_point_with_evm_eip712(k);
  const ref = G.multiply(k).toAffine();
  assert.equal(pt.x, ref.x); assert.equal(pt.y, ref.y); assert.equal(pt.identity, false);
  const k256 = pc.compute_public_point_with_k256(k);
  assert.equal(k256.x, pt.x); assert.equal(k256.y, pt.y);
  const addr = pc.evm_eip712_address(pt, evmEip712KeyHint(pt));
  const refAddr = keccak_256(new Uint8Array([...be(ref.x), ...be(ref.y)])).subarray(12);
  assert.ok(eq(addr, refAddr), 'evm_eip712_address == keccak256(x || y)[12..]');
  assert.ok(eq(addr, evmAddressOf(ref)));
  if (vectors.keys.length < 4) vectors.keys.push({ scalar: k.toString(16), x: ref.x.toString(16), y: ref.y.toString(16), address: evmChecksumAddress(addr) });
  ok('keys', 4);
}
{ const g1 = pc.compute_public_point_with_evm_eip712(1n); assert.equal(evmChecksumAddress(pc.evm_eip712_address(g1, evmEip712KeyHint(g1))), '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf'); }
{
  // The point at infinity, in both encodings, never yields an address.
  const flagged = pc.compute_public_point_with_evm_eip712(0n);
  assert.equal(flagged.identity, true, 'scalar 0 gives the flagged identity');
  refused('keys', () => pc.evm_eip712_address(flagged, evmEip712KeyHint(flagged)), /point at infinity|identity|failed assert/i, 'the flagged identity {0, 0, identity}');
  refused('keys', () => pc.evm_eip712_address({ x: 0n, y: 0n, identity: false }, evmEip712KeyHint({ x: 0n, y: 0n })), /point at infinity|identity|not a valid|failed assert|curve/i, 'the unflagged identity {0, 0, not identity}');
  refused('keys', () => new EvmEip712Device({ x: 0n, y: 0n, identity: false } as any, rnd(32), 'undeployed', 0n), /point at infinity/, 'a device at infinity (client)');
  refused('keys', () => new EvmEip712Device({ x: 1n, y: 1n, identity: false } as any, rnd(32), 'undeployed', 0n), /not on curve|invalid|bad point/i, 'an off-curve device point (client)');
}
console.log(`  ✓ keys: the arm's scalar-to-point helper == noble == the k256 helper; address == keccak256(x || y)[12..]; ${tally.keys.refused} degenerate keys refused`);

// ── Signatures ───────────────────────────────────────────────────────────────

{
  const w = new SoftwareEvmWallet(scalar());
  const digest = rnd(32);
  const sig = w.signDigest(digest);
  const p = parseEvmSignature(sig);
  assert.ok(p.s <= SECP256K1_ORDER / 2n, 'the software wallet signs low-S');
  assert.ok(eq(serialiseEvmSignature(p), sig));
  const rec = recoverEvmPoint(digest, p);
  assert.equal(rec.x, w.pk.x); assert.equal(rec.y, w.pk.y);
  const twin = highSTwin(p);
  assert.ok(twin.s > SECP256K1_ORDER / 2n);
  const rec2 = recoverEvmPoint(digest, twin);
  assert.equal(rec2.x, w.pk.x); assert.equal(rec2.y, w.pk.y);
  assert.ok(secp256k1.verify(new secp256k1.Signature(twin.r, twin.s).toBytes(), digest, secp256k1.Point.fromAffine(w.pk).toBytes(), { prehash: false, lowS: false }), 'the high-S twin verifies');
  ok('signatures', 5);
  const r = be(p.r), s = be(p.s);
  refused('signatures', () => parseEvmSignature(new Uint8Array([...be(0n), ...s, 27])), /r outside/, 'r = 0');
  refused('signatures', () => parseEvmSignature(new Uint8Array([...r, ...be(0n), 27])), /s outside/, 's = 0');
  refused('signatures', () => parseEvmSignature(new Uint8Array([...be(SECP256K1_ORDER), ...s, 27])), /r outside/, 'r = n');
  refused('signatures', () => parseEvmSignature(new Uint8Array([...r, ...be(SECP256K1_ORDER), 27])), /s outside/, 's = n');
  refused('signatures', () => parseEvmSignature(new Uint8Array([...r, ...s, 29])), /v must be/, 'v = 29');
  refused('signatures', () => parseEvmSignature(sig.subarray(0, 64)), /65 bytes/, 'the 64-byte form');
  // EIP-191: the prefix carries the decimal length of the message.
  const msg = new TextEncoder().encode('Midnight Passport');
  assert.ok(eq(personalMessageDigest(msg), keccak_256(new Uint8Array([...new TextEncoder().encode('\x19Ethereum Signed Message:\n17'), ...msg]))));
  ok('signatures');
}
console.log(`  ✓ signatures: wallet form, low-S signer, high-S twin recovers and verifies, EIP-191 digest; ${tally.signatures.refused} malformed signatures refused`);

// ── Blind enrolment ──────────────────────────────────────────────────────────

vectors.blind = [];
{
  const w = new SoftwareEvmWallet(1n);
  const e = await enrolEvmBlind(w, 'undeployed', 0);
  assert.ok(eq(e.signatures[0], e.signatures[1]), 'RFC 6979: the two signatures are equal');
  assert.ok(eq(e.blind, sha(BLIND_TAG, e.canonical)), 'blind == SHA-256(pad32(blind tag) || low-S r || s)');
  assert.ok(eq(e.blind, pc.derive_blind(BLIND_TAG, e.canonical)), 'blind == derive_blind');
  assert.equal(e.pk.x, w.pk.x); assert.equal(e.pk.y, w.pk.y);
  assert.ok(eq(e.address, w.addressBytes));
  const msg = blindMessageBytes({ scheme: 'evm_eip712', network: 'undeployed', identity: w.addressBytes, accountIndex: 0 });
  assert.ok(eq(e.message, msg));
  vectors.blind.push({ scalar: '1', network: 'undeployed', accountIndex: '0', message: new TextDecoder().decode(msg),
    eip191Digest: hex(personalMessageDigest(msg)), signature: hex(e.signatures[0]), canonical: hex(e.canonical), blind: hex(e.blind) });
  ok('blind', 5);
  const e1 = await enrolEvmBlind(w, 'undeployed', 1);
  const ePreview = await enrolEvmBlind(w, 'preview', 0);
  assert.ok(!eq(e1.blind, e.blind) && !eq(ePreview.blind, e.blind) && !eq(e1.blind, ePreview.blind), 'one blind per (network, index)');
  vectors.blind.push({ scalar: '1', network: 'undeployed', accountIndex: '1', blind: hex(e1.blind) }, { scalar: '1', network: 'preview', accountIndex: '0', blind: hex(ePreview.blind) });
  ok('blind', 1);
  // A high-S signature of the request gives the same blind (canonical form).
  const twin = serialiseEvmSignature(highSTwin(parseEvmSignature(e.signatures[0])));
  const viaTwin: EvmWallet = { address: () => w.address(), personalSign: async () => twin, signTypedData: () => { throw new Error('unused'); } };
  assert.ok(eq((await enrolEvmBlind(viaTwin, 'undeployed', 0)).blind, e.blind), 'the high-S twin gives the same blind');
  ok('blind');
  await refusedAsync('blind', () => enrolEvmBlind(new SoftwareEvmWallet(7n, true), 'undeployed', 0), /not deterministic/, 'a hedged (non-deterministic) wallet');
  const liar: EvmWallet = { address: async () => new SoftwareEvmWallet(2n).addressBytes, personalSign: (m) => w.personalSign(m), signTypedData: () => { throw new Error('unused'); } };
  await refusedAsync('blind', () => enrolEvmBlind(liar, 'undeployed', 0), /does not recover to the wallet address/, 'a wallet whose signature is not its address');
  await refusedAsync('blind', () => enrolEvmBlind(w, 'Undeployed', 0), /network name/, 'an upper-case network name');
  await refusedAsync('blind', () => enrolEvmBlind(w, 'undeployed', -1), /0 to 4294967295/, 'a negative account index');
  // as a grantee the wallet derives its blind from the grantee request
  // for the issuing account: never one of its device blinds, one per issuer
  const deviceBlinds = await Promise.all([0, 1, 2, 3].map(async (i) => hex((await enrolEvmBlind(w, 'undeployed', i)).blind)));
  const issuers = [rnd(32), rnd(32)];
  const granteeBlinds = await Promise.all(issuers.map(async (a) => hex((await enrolEvmGranteeBlind(w, 'undeployed', a)).blind)));
  assert.ok(granteeBlinds.every((b) => !deviceBlinds.includes(b)), 'a grantee blind is never a device blind');
  assert.notEqual(granteeBlinds[0], granteeBlinds[1], 'two issuing accounts give two grantee blinds');
  const g0 = await EvmEip712Grantee.enrol(w, 'undeployed', issuers[0], new Uint8Array(32).fill(0x41), 0n);
  assert.equal(hex(g0.blind), granteeBlinds[0], 'EvmEip712Grantee.enrol uses the grantee request');
  assert.equal(hex((await enrolEvmGranteeBlind(w, 'preview', issuers[0])).blind) === granteeBlinds[0], false, 'and names the network');
  ok('blind', 4);
  await refusedAsync('blind', () => enrolEvmGranteeBlind(w, 'undeployed', new Uint8Array(32)), /issuing account address is not zero/, 'a grantee request for the zero account');
}
console.log(`  ✓ blind: deterministic, == derive_blind == SHA-256, recovered point == the wallet key, per index and network; grantee blinds per issuing account, never a device blind; ${tally.blind.refused} bad enrolments refused`);

// ── Roster and restore ───────────────────────────────────────────────────────

{
  const w = new SoftwareEvmWallet(scalar());
  const d = await EvmEip712Device.enrol(w, 'undeployed', 0);
  const rec = d.toRecord();
  const back = EvmEip712Device.fromRecord(JSON.parse(JSON.stringify(rec)));
  assert.ok(eq(back.address, d.address) && eq(back.blind, d.blind) && back.accountIndex === 0n && back.network === 'undeployed');
  assert.equal(rec.address, evmChecksumAddress(w.addressBytes));
  ok('roster');
  const other = new SoftwareEvmWallet(scalar());
  refused('roster', () => EvmEip712Device.fromRecord({ ...rec, address: evmChecksumAddress(other.addressBytes) }), /not the point's address/, 'a record whose address is not its point\'s');
  refused('roster', () => EvmEip712Device.fromRecord({ ...rec, blind: 'zz' }), /hex/, 'a malformed blind');

  // Restore: index 0 on account A at counter 3, index 2 on account B at
  // counter 0; index 1 and every other account match nothing.
  const A = rnd(32), B = rnd(32), C = rnd(32);
  const d0 = await EvmEip712Device.enrol(w, 'undeployed', 0);
  const d2 = await EvmEip712Device.enrol(w, 'undeployed', 2);
  const setA = new Set([hex(d0.entryAt(A, 0n, 3n)), hex(rnd(32))]);
  const setB = new Set([hex(d2.entryAt(B, 0n, 0n))]);
  const setC = new Set([hex(d0.entryAt(A, 0n, 0n))]); // an entry of A planted in C matches nothing in C
  const found = await restoreEvmDevices(w, 'undeployed', [
    { address: A, epoch: 0n, isMember: (e) => setA.has(hex(e)) },
    { address: B, epoch: 0n, isMember: (e) => setB.has(hex(e)) },
    { address: C, epoch: 0n, isMember: (e) => setC.has(hex(e)) },
  ], { maxIndex: 3, maxCounter: 8n });
  assert.deepEqual(found.map((f) => [f.accountIndex, hex(f.account), f.counter]), [[0n, hex(A), 3n], [2n, hex(B), 0n]]);
  ok('roster', 2);
}
console.log(`  ✓ roster: record round trip; restore finds index 0 (counter 3) and index 2 (counter 0) only; ${tally.roster.refused} bad records refused`);

// ── Codec: the frozen vectors ──────────────────────────────────────────

const FROZEN = JSON.parse(fs.readFileSync(new URL(`./vectors/${VECTOR_FILE}`, import.meta.url), 'utf8'));
{
  assert.match(FROZEN.hashesBy, /^viem 2\./, 'the frozen hashes come from viem');
  const strip = (v: any) => { const { typedData, encodeType, domainSeparator, structHash, digest, ...input } = v; return input as VectorInput; };
  const seen = new Set<string>();
  for (const v of FROZEN.vectors) {
    const input = strip(v);
    const td = typedDataOf(input);
    assert.deepEqual(JSON.parse(JSON.stringify(td)), v.typedData, `${v.name}: the codec rebuilds the frozen typed data`);
    assert.equal(toHex(typedDataDigest(td)), v.digest, `${v.name}: client digest`);
    const sh = contractStructHash(pc, input);
    assert.equal(toHex(sh), v.structHash, `${v.name}: contract struct hash`);
    const acct = Buffer.from(v.frame.account, 'hex');
    assert.equal(toHex(pc.evm_eip712_domain_separator(acct, accountHashHint(acct))), v.domainSeparator, `${v.name}: contract domain separator`);
    assert.equal(toHex(pc.evm_eip712_digest(acct, sh, accountHashHint(acct))), v.digest, `${v.name}: contract digest`);
    assert.equal(v.typedData.domain.verifyingContract.toLowerCase(), '0x' + hex(pc.evm_eip712_verifying_contract(acct, accountHashHint(acct))), `${v.name}: verifyingContract`);
    seen.add(v.typedData.primaryType + (Object.keys(v.typedData.types).find((t) => t in EVM_EIP712_DESCRIPTOR_TYPES) ?? ''));
    ok('codec vectors');
  }
  // every primary type, and every descriptor-taking type with all five schemes
  const expected = Object.keys(EVM_EIP712_PRIMARY_TYPES).flatMap((p) => {
    const nested = EVM_EIP712_PRIMARY_TYPES[p].find(([, t]) => t.startsWith('<'));
    if (!nested) return [p];
    return Object.keys(EVM_EIP712_DESCRIPTOR_TYPES).filter((t) => t.endsWith(nested[1] === '<Device>' ? 'Device' : 'Grantee')).map((t) => p + t);
  });
  assert.deepEqual([...seen].sort(), expected.sort(), 'the vectors cover all 16 primary types and every descriptor scheme');
  for (const [k, str] of Object.entries(FROZEN.typeStrings as Record<string, string>)) {
    const [p, n] = k.split('/');
    assert.equal(typeString(p, n), str, `${k}: type string == viem encodeType`);
    ok('type strings');
  }
  assert.equal(Object.keys(FROZEN.typeStrings).length, 32);
  // dynamic members: entries with leading zero bytes and all-zero bytes
  const dyn = FROZEN.vectors.filter((v: any) => /append_inbox|publish_recovery|as_grantee/.test(v.name));
  assert.ok(dyn.some((v: any) => /^0x00/.test(v.typedData.message.entry ?? v.typedData.message.wrap ?? v.typedData.message.changeEntry ?? '')), 'a dynamic member with leading zero bytes');
  assert.ok(dyn.some((v: any) => /^0x(00)+$/.test(v.typedData.message.entry ?? v.typedData.message.wrap ?? '')), 'an all-zero dynamic member');
  ok('codec vectors', 2);
}
const negativeResults: { name: string; refusedBy: string[]; client?: string; runtime?: string }[] = [];
for (const n of FROZEN.negatives) {
  const r: any = { name: n.name, refusedBy: n.refusedBy };
  if (n.refusedBy.includes('client')) {
    assert.throws(() => typedDataOf(n.input), (e: any) => { r.client = String(e?.message ?? e); return true; }, `${n.name}: the client codec must refuse`);
  }
  if (n.refusedBy.includes('runtime')) {
    assert.throws(() => contractStructHash(pc, n.input), (e: any) => { r.runtime = String(e?.message ?? e); return true; }, `${n.name}: the contract's pure circuit must refuse`);
  }
  negativeResults.push(r);
  (tally['codec negatives'] ??= { pass: 0, refused: 0 }).refused++;
}
assert.equal(negativeResults.length, NEGATIVES.length);
// for the arm's RP and any-recipient rules the client refuses with the
// circuit's own message
for (const name of ['passkey device with a zero RP hash', 'passkey removal target with a zero RP hash', 'spending passkey grant with a zero RP hash',
  'read-only passkey grant with an RP hash', 'an RP hash for a non-passkey grantee', 'any recipient with a recipient']) {
  const r = negativeResults.find((x) => x.name === name);
  assert.ok(r?.client && r.runtime, `${name}: a frozen negative refused at the client and the runtime`);
  assert.equal(`failed assert: ${r!.client}`, r!.runtime, `${name}: the client refuses with the circuit's message`);
  ok('codec negatives: client message == circuit message');
}
// The descriptor derivations of the codec module equal the shared module's
// width-class circuits (S1 checked those against upstream and SHA-256). The
// frozen keys are random bytes, so descriptors.ts's strict decoders are not
// used here; those decoders are covered by wallet-arms-client-offline.
{
  for (const v of FROZEN.vectors.filter((x: any) => /^(add|remove)_device\//.test(x.name))) {
    const d = descriptorInput(v.args.descriptor);
    const A = { bytes: rnd(32) };
    const s = v.args.descriptor.scheme;
    const pt = solArgs(d);
    for (const [e, c] of [[0n, 0n], [3n, 9n]] as [bigint, bigint][]) {
      const [sk, se] = pc.evm_eip712_sol_device_target(A, d, ...pt, e, c);
      const want = s === 'evm_eip712' ? pc.derive_descriptor_entry_w52(d.tag, A, d.address, d.key2, e, c)
        : s === 'k256' ? pc.derive_descriptor_entry_w65(d.tag, A, d.key, d.key2, d.envelope, e, c)
        : s === 'p256' ? pc.derive_descriptor_entry_w117(d.tag, A, d.key, d.key2, d.rp_id_hash, d.origin, e, c)
        : s === 'sol_ed25519' ? pc.derive_descriptor_entry_ed25519(d.tag, A, ...pt, d.key2, e, c)[1]
        : pc.derive_descriptor_entry_w64(d.tag, A, d.key, d.key2, e, c);
      assert.ok(eq(pc.evm_eip712_descriptor_entry(A, d, se, e, c), want), `${v.name}: descriptor entry == the class circuit`);
      // a Solana target's shown key is the key the ed25519 class derived from the point
      if (s === 'sol_ed25519') assert.ok(eq(sk, d.key) && eq(sk, pc.encode_public_key_with_sol_ed25519(...pt)), `${v.name}: the shown Solana key is the point's encoding`);
    }
    if (s === 'evm_eip712') assert.ok(eq(pc.evm_eip712_descriptor_entry(A, d, new Uint8Array(32), 0n, 0n), pc.derive_device_entry_with_evm_eip712(A, d.address, d.key2, 0n, 0n)));
    ok('descriptor derivations');
  }
  for (const v of FROZEN.vectors.filter((x: any) => /^(issue|revoke)_grant\//.test(x.name))) {
    const g = granteeInput(v.args.grantee);
    const A = { bytes: rnd(32) };
    const oh = pc.evm_eip712_grantee_origin_hash(g);
    const s = v.args.grantee.scheme;
    if (s === 'evm_eip712' || s === 'sol_ed25519') assert.ok(eq(oh, pc.derive_grant_origin_hash_label(g.label)));
    else if (s === 'p256') assert.ok(eq(oh, pc.derive_grant_origin_hash_origin(g.origin)));
    else assert.ok(eq(oh, g.origin_hash));
    const gpt = solArgs(g);
    const [gsk, gsi] = pc.evm_eip712_sol_grantee_target(A, g, oh, ...gpt);
    const want = s === 'evm_eip712' ? pc.derive_descriptor_grant_id_w52(g.tag, A, g.address, g.key2, oh, g.slot)
      : s === 'k256' ? pc.derive_descriptor_grant_id_w65(g.tag, A, g.key, g.key2, g.envelope, oh, g.slot)
      : s === 'sol_ed25519' ? pc.derive_descriptor_grant_id_ed25519(g.tag, A, ...gpt, g.key2, oh, g.slot)[1]
      : pc.derive_descriptor_grant_id_w64(g.tag, A, g.key, g.key2, oh, g.slot);
    assert.ok(eq(pc.evm_eip712_grantee_grant_id(A, g, oh, gsi), want), `${v.name}: grantee grant id == the class circuit`);
    if (s === 'sol_ed25519') assert.ok(eq(gsk, g.key), `${v.name}: the shown Solana grantee key is the point's encoding`);
    ok('descriptor derivations');
  }
  // the site label as shown == the contract's rendering
  for (const t of ['Midnight Night Market', 'x', 'A'.repeat(32), 'a b c']) {
    const l = new Uint8Array(32); l.set(new TextEncoder().encode(t));
    assert.ok(eq(pc.evm_eip712_site_label_hash(l, bytesHint(l)), keccak_256(new TextEncoder().encode(siteLabelText(l)))));
    assert.equal(siteLabelText(l).length, 32);
    ok('descriptor derivations');
  }
}
// The no-blob classification: every signed member is a value
// shown in full, and the only hash-like members are the four labelled ones.
const CLASS: Record<string, string> = {
  account: 'identifier', device: 'key', grantee: 'key', wallet: 'key', publicKey: 'key (a Solana key in base58)', x: 'key', y: 'key', recoveryKeyX: 'key', recoveryKeyY: 'key',
  authNonce: 'value', issuedAt: 'value', grantNonce: 'value', slot: 'value', amount: 'value', color: 'identifier', recipient: 'identifier',
  recipientContract: 'identifier', coinNonce: 'witness', coinValue: 'witness', coinMerkleIndex: 'witness', change: 'witness (derived)',
  entry: 'ciphertext (full bytes) / the literal entry of a revocation-only removal', changeEntry: 'ciphertext (full bytes)', newKey: 'value', effect: 'circuit-fixed line',
  newDevice: 'descriptor', target: 'descriptor', targetEpoch: 'value', targetCounter: 'value', scheme: 'circuit-fixed tag text', envelope: 'text label (a circuit constant selected by the value)',
  origin: 'text', siteLabel: 'text', withdrawUnshielded: 'value', withdrawShielded: 'value', withdrawShieldedToContract: 'value', read: 'value',
  recipientKind: 'text label (a circuit constant selected by the value)', maxCoinValue: 'value', perCallCap: 'value', cap: 'value', expiresAt: 'value', readKey: 'key (preimage of read_pk_hash)',
  expiry: 'text (the UTC date and time checked against expiresAt) or exact word', passkeyRp: 'exact word (a circuit constant selected by exact equality)',
  amountLabel: "text (the site's label for the amount, marked as its claim; the digits checked against the amount)",
  window: 'exact word (a circuit constant selected by exact equality)',
  windowLength: 'value', windowCap: 'value', callerPinned: 'value', caller: 'identifier', sessionNonce: 'value', phi1: 'value', phi2: 'value',
  phi3: 'value', phi4: 'value', phiLength: 'value', wrap: 'ciphertext (full bytes)', encryptionKey: 'key',
  privacySalt: 'LABELLED (a target device\'s blind)', passkeyRpHash: 'LABELLED (the passkey RP hash)', siteLabelHash: 'LABELLED (a k256/jubjub grantee\'s origin_hash)',
};
{
  const labelled = new Set<string>();
  for (const [t, fields] of [...Object.entries(EVM_EIP712_PRIMARY_TYPES).map(([k, v]) => [k, v.map(([n]) => n)] as [string, string[]]),
                            ...Object.entries(EVM_EIP712_DESCRIPTOR_TYPES).map(([k, v]) => [k, v.map((x) => x.name)] as [string, string[]])]) {
    for (const n of fields) {
      assert.ok(n in CLASS, `${t}.${n} has no no-blob classification`);
      if (CLASS[n].startsWith('LABELLED')) labelled.add(n);
      if (n === 'entry' && t === 'RemoveUnknownDevice') labelled.add('RemoveUnknownDevice.entry');
    }
  }
  assert.deepEqual([...labelled].sort(), ['RemoveUnknownDevice.entry', 'passkeyRpHash', 'privacySalt', 'siteLabelHash'], 'exactly the four labelled values');
  assert.equal(EVM_EIP712_PRIMARY_TYPES.RemoveUnknownDevice.find(([n]) => n === 'entry')![1], 'bytes32');
  ok('no-blob review');
}
console.log(`  ✓ codec: ${tally['codec vectors'].pass} frozen-vector checks (contract == client == viem-frozen), ${tally['type strings'].pass} type strings == viem; ${tally['codec negatives'].refused} negatives refused by every named layer; descriptor derivations == the width-class circuits (${tally['descriptor derivations'].pass}); no-blob: only the four labelled values`);

// ── The enumerated-member labels ─────────────────────────────────
// The arm selects keccak256 of each label among circuit constants. The
// texts are the base's: for every value, the base circuit's own selection
// (WalletArmRendering `recipient_kind_text` / `k256_envelope_text`, through
// the base probe contract), trimmed, equals the client's label
// (src/wallet/labels.ts) and the text the codec signs; and the contract's
// digest equals the codec's for EVERY value, not only those the frozen
// vectors happen to use. A drift of any of the three copies fails here.
{
  const strip = (v: any) => { const { typedData, encodeType, domainSeparator, structHash, digest, ...input } = v; return JSON.parse(JSON.stringify(input)) as any; };
  const baseText = (v: bigint[]) => Buffer.from(v.map(Number)).toString('latin1').trimEnd();
  const shown = (m: any, key: string): string[] => Object.entries(m ?? {}).flatMap(([k, x]) => (k === key ? [String(x)] : x && typeof x === 'object' ? shown(x, key) : []));
  const agree = (name: string, input: any) => {
    const td = typedDataOf(input);
    const acct = Buffer.from(input.frame.account, 'hex');
    assert.equal(toHex(typedDataDigest(td)), toHex(pc.evm_eip712_digest(acct, contractStructHash(pc, input), accountHashHint(acct))), `${name}: contract digest == codec digest`);
    return td;
  };
  for (let k = 0; k < RECIPIENT_KIND_LABELS.length; k++) {
    const text = baseText(baseProbe.recipient_kind_text(BigInt(k)) as bigint[]);
    assert.equal(text, RECIPIENT_KIND_LABELS[k], `recipient kind ${k}: the base circuit's text == labels.ts`);
    assert.equal(recipientKindLabel(k), text);
    for (const v of FROZEN.vectors.filter((x: any) => x.typedData.primaryType === 'IssueGrant')) {
      const input = strip(v);
      const sc = input.args.scope;
      // a read-only grant carries no object fields (the shared chip's rule, which
      // the codec mirrors): its recipient kind is 0; the spending grants carry every kind
      if (k !== 0 && !(sc.opWithdrawUnshielded || sc.opWithdrawShielded || sc.opWithdrawShieldedToContract)) continue;
      input.args.scope.recipientKind = String(k);
      if (k === 0) input.args.scope.recipient = '00'.repeat(32); // "any recipient" carries no recipient
      const td = agree(`${v.name} recipientKind ${k}`, input);
      assert.equal((td.message as any).recipientKind, text, `${v.name}: the codec signs the base's text for recipient kind ${k}`);
      ok('labels');
    }
  }
  for (let e = 0; e < K256_ENVELOPE_LABELS.length; e++) {
    const text = baseText(baseProbe.k256_envelope_text(BigInt(e)) as bigint[]);
    assert.equal(text, K256_ENVELOPE_LABELS[e], `envelope ${e}: the base circuit's text == labels.ts`);
    assert.equal(k256EnvelopeLabel(e), text);
    for (const v of FROZEN.vectors.filter((x: any) => x.args?.descriptor?.scheme === 'k256' || x.args?.grantee?.scheme === 'k256')) {
      const input = strip(v);
      (input.args.descriptor ?? input.args.grantee).envelope = String(e);
      const td = agree(`${v.name} envelope ${e}`, input);
      assert.deepEqual(shown(td.message, 'envelope'), [text], `${v.name}: the codec signs the base's text for envelope ${e}`);
      ok('labels');
    }
  }
  // The exact words. "never", "not applicable" and "no window" are the
  // base's (its circuits expiry_text, rp_hash_text and window_text, and
  // rendering.ts); each is selected by exact equality; the other text points
  // at the typed members.
  const never = baseText(baseProbe.expiry_text(0n, [...new TextEncoder().encode('0'.padEnd(20, ' '))].map(BigInt)) as bigint[]);
  const na = baseText(baseProbe.rp_hash_text(new Uint8Array(32)) as bigint[]);
  const noWindow = baseText(baseProbe.window_text(0n, [...new TextEncoder().encode('0'.padEnd(20, ' '))].map(BigInt)) as bigint[]);
  assert.equal(never, NEVER_TEXT, 'the base circuit\'s expiry word == rendering.ts');
  assert.equal(na, NOT_APPLICABLE_TEXT, 'the base circuit\'s RP word == rendering.ts');
  assert.equal(noWindow, NO_WINDOW_TEXT, 'the base circuit\'s window word == rendering.ts');
  assert.equal(passkeyRpWord(new Uint8Array(32)), na);
  for (let i = 0; i < 32; i++) { const h = new Uint8Array(32); h[i] = 1; assert.equal(passkeyRpWord(h), EVM_EIP712_PASSKEY_RP_POINTER, 'one non-zero byte anywhere is not zero'); }
  assert.equal(windowWord(0n, 0n), noWindow);
  for (const [l, c] of [[1n, 0n], [0n, 1n], [3600n, 5n], [(1n << 64n) - 1n, (1n << 128n) - 1n]] as [bigint, bigint][]) assert.equal(windowWord(l, c), EVM_EIP712_WINDOW_POINTER);
  // The expiry's text for edge values and a seeded sample: the base circuit's
  // own text (utc_datetime_text through expiry_datetime_text, from the
  // client's inputs), trimmed, equals the codec's.
  const EXPIRIES = [0n, 1n, 59n, 86399n, 86400n, 951782400n, 951868800n, 4107456000n, 4107542400n, 1893456000n, (1n << 31n) - 1n, 1n << 31n,
    253402300799n, 253402300800n, (1n << 64n) - 1n];
  for (let i = 0; i < 64; i++) EXPIRIES.push(BigInt('0x' + createHash('sha256').update(`expiry/${i}`).digest('hex').slice(0, 16)) % (i < 48 ? 253402300800n : 1n << 64n));
  for (const e of EXPIRIES) {
    const inp = utcDateTimeInputs(e);
    const text = baseText(baseProbe.expiry_datetime_text(e, inp.text, inp.yearSplit) as bigint[]);
    assert.equal(expiryText(e), text, `expiry ${e}: the codec's text == the base circuit's`);
    ok('labels');
  }
  // The amount label and the Solana key text: the base circuits' texts
  // (site_amount_label_text, base58_text_32) equal the codec's.
  for (const [amt, site] of [[0n, { decimals: 0, symbol: 'T' }], [1n, { decimals: 6, symbol: 'TOKEN' }], [(1n << 128n) - 1n, { decimals: 18, symbol: 'ABCDEFGH' }],
    [123456789n, { decimals: 9, symbol: 'x' }], [10n ** 18n, { decimals: 18, symbol: 'ETH' }]] as [bigint, { decimals: number; symbol: string }][]) {
    const t = baseText(baseProbe.site_amount_label_text(amt, [...siteAmountLabelBytes(amt, site.decimals, site.symbol)].map(BigInt)) as bigint[]);
    assert.equal(amountLabelText(amt, site).trimEnd(), EVM_EIP712_AMOUNT_LABEL_PREFIX + t, `amount ${amt}: the codec's label == the prefix and the base circuit's`);
    ok('labels');
  }
  for (const key of [new Uint8Array(32), new Uint8Array(32).fill(0xff), Uint8Array.from({ length: 32 }, (_, i) => (i < 2 ? 0 : i)),
    ...Array.from({ length: 16 }, (_, i) => new Uint8Array(createHash('sha256').update(`b58/${i}`).digest()))]) {
    const b = base58Inputs(key);
    const t = baseText(baseProbe.base58_text_32([...key].map(BigInt), b.digits, b.carry, b.low, b.top) as bigint[]);
    assert.equal(solanaKeyText(key).trimEnd(), t, 'the codec\'s base58 == the base circuit\'s');
    assert.equal(solanaKeyText(key).length, 44);
    ok('labels');
  }
  for (const v of FROZEN.vectors.filter((x: any) => x.typedData.primaryType === 'IssueGrant')) {
    for (const e of [0n, 1n, 1893456000n, 253402300799n, 253402300800n, (1n << 64n) - 1n]) {
      const input = strip(v);
      input.args.scope.expiresAt = e.toString();
      const td = agree(`${v.name} expiresAt ${e}`, input);
      assert.equal((td.message as any).expiry, expiryText(e), `${v.name}: the expiry text for ${e}`);
      assert.equal((td.message as any).window, noWindow, `${v.name}: the window word`);
      ok('labels');
    }
    const rpZero = /^0x(00)+$/.test(v.typedData.message.passkeyRpHash);
    assert.equal(v.typedData.message.passkeyRp, rpZero ? na : EVM_EIP712_PASSKEY_RP_POINTER, `${v.name}: the passkeyRp word`);
    const m = v.typedData.message;
    const pinned = /PasskeyGrantee/.test(Object.keys(v.typedData.types).join()) && (m.withdrawUnshielded || m.withdrawShielded || m.withdrawShieldedToContract);
    assert.equal(rpZero, !pinned, `${v.name}: only a passkey grantee that can spend has an RP hash`);
    ok('labels');
  }
  // A window the issue rules refuse still shows the pointer: the contract's
  // digest for a non-zero window equals the codec's message with the window
  // members set (the builder itself refuses such a scope, "window bounds reserved").
  {
    const base = FROZEN.vectors.find((x: any) => x.name === 'issue_grant/evm_eip712');
    for (const [l, c] of [[1n, 0n], [0n, 7n], [3600n, 5n]] as [bigint, bigint][]) {
      const input = strip(base);
      const td = JSON.parse(JSON.stringify(base.typedData));
      td.message.windowLength = l.toString(); td.message.windowCap = c.toString(); td.message.window = EVM_EIP712_WINDOW_POINTER;
      input.args.scope.windowLen = l.toString(); input.args.scope.windowCap = c.toString();
      const acct = Buffer.from(input.frame.account, 'hex');
      assert.equal(toHex(typedDataDigest(td)), toHex(pc.evm_eip712_digest(acct, contractStructHash(pc, input), accountHashHint(acct))), `window ${l}/${c}: contract digest == the pointer message`);
      ok('labels');
    }
  }
  // Every amount label and Solana key the frozen vectors sign is the codec's.
  for (const v of FROZEN.vectors) {
    const a: any = v.args;
    if (a.site) { assert.equal(v.typedData.message.amountLabel, amountLabelText(BigInt(a.amount), a.site), `${v.name}: amountLabel`); ok('labels'); }
    const solTarget = (a.descriptor ?? a.grantee)?.scheme === 'sol_ed25519' ? (a.descriptor ?? a.grantee) : undefined;
    if (solTarget) {
      const shownKey = v.typedData.message.newDevice ?? v.typedData.message.target ?? v.typedData.message.grantee;
      assert.equal(shownKey.publicKey, solanaKeyText(Buffer.from(solTarget.key, 'hex')), `${v.name}: the Solana key in base58`);
      ok('labels');
    }
  }
  console.log(`  ✓ labels: the base circuits' texts == labels.ts / rendering.ts == the signed text for every recipient kind (4), k256 envelope (2), the exact words ("${never}", "${na}", "${noWindow}"), ${EXPIRIES.length} expiry dates, the amount labels and base58 keys; the pointers "${EVM_EIP712_PASSKEY_RP_POINTER}", "${EVM_EIP712_WINDOW_POINTER}"; contract digest == codec digest for every value on every IssueGrant and k256-descriptor vector (${tally.labels.pass} checks)`);
}

// ── Client refusals before any wallet signs ───────────
{
  const iv = FROZEN.vectors.find((x: any) => x.name === 'issue_grant/p256');
  const base = (() => { const { typedData, encodeType, domainSeparator, structHash, digest, ...input } = iv; return JSON.parse(JSON.stringify(input)); })();
  const scopeOf = (o: any) => ({ ...base, args: { ...base.args, scope: { ...base.args.scope, ...o } } });
  refused('client refusals', () => typedDataOf(scopeOf({ rpIdHash: '00'.repeat(32) })), /spending passkey grant's RP hash is zero/, 'a spending passkey grant with a zero RP hash');
  refused('client refusals', () => typedDataOf(scopeOf({ opWithdrawUnshielded: false, opWithdrawShielded: false, opWithdrawShieldedToContract: false })), /RP hash belongs to a spending passkey grant/, 'a read-only passkey grant with an RP hash');
  // a read-only grant: no operation, and no object fields or caller pin (the shared chip's rules)
  const READ_ONLY = { opWithdrawUnshielded: false, opWithdrawShielded: false, opWithdrawShieldedToContract: false, caller: null,
    color: '00'.repeat(32), recipientKind: '0', recipient: '00'.repeat(32), maxCoinValue: '0', perCallCap: '0', cap: '0' };
  assert.ok(typedDataOf(scopeOf({ ...READ_ONLY, rpIdHash: '00'.repeat(32) })), 'a read-only passkey grant carries zero');
  // a passkey grantee's own site origin, checked by the base rule even for a key without a policy
  const p1 = p256Curve.getPublicKey(p256Curve.utils.randomSecretKey(), false);
  const px = beInt(p1.subarray(1, 33)), py = beInt(p1.subarray(33, 65));
  const okOrigin = new TextEncoder().encode('https://a.example.com');
  assert.ok(evmEip712GranteeInput({ scheme: 'p256', x: px, y: py }, { origin: okOrigin }, 0n));
  for (const [what, o] of [['a quote', 'https://a"example.com'], ['a backslash', 'https://a\\example.com'], ['a space', 'https://a example.com'], ['20 bytes', 'https://a.example.co']] as const) {
    refused('client refusals', () => evmEip712GranteeInput({ scheme: 'p256', x: px, y: py }, { origin: new TextEncoder().encode(o) }, 0n), /origin|descriptor:/, `a passkey grantee site origin with ${what}, key without a policy`);
  }
  const goodP = evmEip712GranteeInput({ scheme: 'p256', x: px, y: py }, { origin: okOrigin }, 0n);
  const badP = { ...goodP, origin: new TextEncoder().encode('https://a"example.com') };
  refused('client refusals', () => checkEvmEip712GranteeInput(badP), /origin|descriptor:/, 'a hand-built passkey grantee input with a quote in its origin');
  refused('client refusals', () => typedDataOf(scopeOf({ recipientKind: '0', recipient: '7e'.repeat(32) })), /a recipient for any recipient/, 'any recipient with a recipient');
  const dv = FROZEN.vectors.find((x: any) => x.name === 'add_device/p256');
  const dbase = (() => { const { typedData, encodeType, domainSeparator, structHash, digest, ...input } = dv; return JSON.parse(JSON.stringify(input)); })();
  refused('client refusals', () => typedDataOf({ ...dbase, args: { ...dbase.args, descriptor: { ...dbase.args.descriptor, rp_id_hash: '00'.repeat(32) } } }), /passkey's RP hash is zero/, 'a passkey device with a zero RP hash');
  // The client mirrors the circuit's RP and any-recipient rules in the
  // circuit's order and with its messages, so a wallet is never asked to sign
  // what the circuit refuses. Each case is refused by the client codec with
  // exactly the message the contract's pure circuit refuses it with.
  const sameMessage = (input: any, msg: string, why: string) => {
    let client = '', runtime = '';
    assert.throws(() => typedDataOf(input), (e: any) => { client = String(e?.message ?? e); return true; }, `${why}: the client codec must refuse`);
    assert.throws(() => contractStructHash(pc, input), (e: any) => { runtime = String(e?.message ?? e); return true; }, `${why}: the contract's pure circuit must refuse`);
    assert.equal(client, msg, `${why}: the client's message`);
    assert.equal(runtime, `failed assert: ${msg}`, `${why}: the circuit's message`);
    (tally['client refusals'] ??= { pass: 0, refused: 0 }).refused++;
  };
  const RP_ONLY = 'evm_eip712: an RP hash belongs to a spending passkey grant';
  for (const name of ['issue_grant/evm_eip712', 'issue_grant/sol_ed25519', 'issue_grant/jubjub', 'issue_grant/k256']) {
    const v = FROZEN.vectors.find((x: any) => x.name === name);
    const { typedData, encodeType, domainSeparator, structHash, digest, ...input } = v;
    const b = JSON.parse(JSON.stringify(input));
    const spends = b.args.scope.opWithdrawUnshielded || b.args.scope.opWithdrawShielded || b.args.scope.opWithdrawShieldedToContract;
    sameMessage({ ...b, args: { ...b.args, scope: { ...b.args.scope, rpIdHash: '5a'.repeat(32) } } }, RP_ONLY,
      `an RP hash on a ${spends ? 'spending' : 'read-only'} ${b.args.grantee.scheme} grantee`);
    // the RP rule is asserted before the any-recipient rule: both broken, both layers name the RP rule
    sameMessage({ ...b, args: { ...b.args, scope: { ...b.args.scope, rpIdHash: '5a'.repeat(32), recipientKind: '0', recipient: '7e'.repeat(32) } } }, RP_ONLY,
      `an RP hash and a recipient for any recipient on a ${b.args.grantee.scheme} grantee: the RP rule first`);
  }
  {
    const p = { ...base, args: { ...base.args, scope: { ...base.args.scope } } };
    sameMessage({ ...p, args: { ...p.args, scope: { ...p.args.scope, rpIdHash: '00'.repeat(32) } } }, "evm_eip712: a spending passkey grant's RP hash is zero", 'a spending passkey grant with a zero RP hash');
    sameMessage({ ...p, args: { ...p.args, scope: { ...p.args.scope, opWithdrawUnshielded: false, opWithdrawShielded: false, opWithdrawShieldedToContract: false, read: true } } }, RP_ONLY, 'a read-only passkey grant with an RP hash');
    sameMessage({ ...p, args: { ...p.args, scope: { ...p.args.scope, recipientKind: '0', recipient: '7e'.repeat(32) } } }, 'evm_eip712: a recipient for any recipient', 'any recipient with a recipient');
    sameMessage({ ...dbase, args: { ...dbase.args, descriptor: { ...dbase.args.descriptor, rp_id_hash: '00'.repeat(32) } } }, "evm_eip712: a passkey's RP hash is zero", 'a passkey device with a zero RP hash');
    // the passkey device's origin is checked before its RP hash (the circuit's order)
    const badOrigin = { ...dbase, args: { ...dbase.args, descriptor: { ...dbase.args.descriptor, rp_id_hash: '00'.repeat(32), origin: Buffer.from('https://a example.com').toString('hex') } } };
    let c = '', r = '';
    assert.throws(() => typedDataOf(badOrigin), (e: any) => { c = String(e?.message ?? e); return true; });
    assert.throws(() => contractStructHash(pc, badOrigin), (e: any) => { r = String(e?.message ?? e); return true; });
    assert.ok(/not visible ASCII/.test(c) && !/RP hash/.test(c), `a passkey device with a bad origin and a zero RP hash: the client names the origin first (${c})`);
    assert.ok(/origin is not visible ASCII/.test(r) && !/RP hash/.test(r), `a passkey device with a bad origin and a zero RP hash: the circuit names the origin first (${r})`);
    (tally['client refusals'] ??= { pass: 0, refused: 0 }).refused++;
  }
  // Every issue rule issue_grant_with_evm_eip712 reaches, in the
  // circuit's order and with its message, mirrored by the client codec: the
  // export's read-key rules, the grantee class (tag, Solana identity, site
  // label, passkey origin, k256 envelope), the RP rules, any recipient, the recipient
  // kind, then upstream's shared chip (do_issue_grant). Where the rule lives
  // in the parts circuit, the contract's pure struct oracle refuses with the
  // same message; the export's and the chip's rules are refused at the
  // runtime for the evm_eip712 owner in evm-eip712-grants-offline.ts.
  const ig = (name: string) => (() => { const { typedData, encodeType, domainSeparator, structHash, digest, ...input } = FROZEN.vectors.find((x: any) => x.name === name); return JSON.parse(JSON.stringify(input)); })();
  const variant = (name: string, scope: Record<string, unknown> = {}, grantee: Record<string, unknown> = {}) => {
    const b = ig(name);
    return { ...b, args: { ...b.args, grantee: { ...b.args.grantee, ...grantee }, scope: { ...b.args.scope, ...scope } } };
  };
  const clientRefuses = (input: any, msg: string, why: string, oracle: boolean, runtimeAt = 'the export or the shared chip at runtime: evm-eip712-grants-offline.ts (the evm_eip712 owner, honestly signed)') => {
    let client = '', runtime = '';
    assert.throws(() => typedDataOf(input), (e: any) => { client = String(e?.message ?? e); return true; }, `${why}: the client codec must refuse`);
    assert.equal(client, msg, `${why}: the client's message`);
    if (oracle) {
      assert.throws(() => contractStructHash(pc, input), (e: any) => { runtime = String(e?.message ?? e); return true; }, `${why}: the contract's pure circuit must refuse`);
      assert.equal(runtime, `failed assert: ${msg}`, `${why}: the circuit's message`);
    }
    (tally['client refusals'] ??= { pass: 0, refused: 0 }).refused++;
    issueRules.push({ rule: why, client, runtime: oracle ? runtime : runtimeAt });
  };
  const issueRules: { rule: string; client: string; runtime: string }[] = [];
  const tagHex = (t: string) => Buffer.from(t).toString('hex').padEnd(64, '0');
  const K = 'issue_grant/k256', P = 'issue_grant/p256', E = 'issue_grant/evm_eip712', SOL = 'issue_grant/sol_ed25519', J = 'issue_grant/jubjub';
  // the arm's export
  clientRefuses(variant(K, { readPk: '11'.repeat(32) }), 'evm_eip712: a read key without read', 'a read key without read', false);
  clientRefuses(variant(P, { readPk: '00'.repeat(32) }), 'evm_eip712: read without a read key', 'read without a read key', false);
  // the grantee class
  clientRefuses(variant(K, {}, { tag: tagHex('midnight:account:grant:id:k1:v9') }), 'evm_eip712: not a registered grant-id tag', 'an unregistered grant-id tag', true);
  clientRefuses(variant(SOL, {}, { key: '01' + '00'.repeat(31) }), 'descriptor: the Ed25519 key is the identity', 'a Solana grantee whose key is the identity', false,
    'issue_grant through the descriptor module\'s ed25519 class: evm-eip712-grants-offline.ts (runtime); add_device: evm-eip712-prover.ts (devices, constraint)');
  clientRefuses(variant(E, {}, { label: Buffer.from('bank  example').toString('hex').padEnd(64, '0') }), 'evm_eip712: not a site label', 'a site label with a double space', true);
  clientRefuses(variant(P, {}, { origin: Buffer.from('https://a example.com').toString('hex') }), 'evm_eip712: the passkey origin is not visible ASCII', 'a passkey grantee origin with a space', true);
  clientRefuses(variant(K, {}, { envelope: '2' }), 'evm_eip712: not a k256 envelope', 'a k256 grantee envelope with no label', true);
  // the RP rules, any recipient, the recipient kind
  clientRefuses(variant(K, { rpIdHash: '5a'.repeat(32) }), 'evm_eip712: an RP hash belongs to a spending passkey grant', 'an RP hash on a non-passkey grantee', true);
  clientRefuses(variant(P, { rpIdHash: '00'.repeat(32) }), "evm_eip712: a spending passkey grant's RP hash is zero", "a spending passkey grant's zero RP hash", true);
  clientRefuses(variant(K, { recipientKind: '0' }), 'evm_eip712: a recipient for any recipient', 'a recipient under any recipient', true);
  clientRefuses(variant(K, { recipientKind: '4' }), 'evm_eip712: not a recipient kind', 'recipient kind 4', true);
  // upstream's shared chip, in its order
  clientRefuses(variant(J, { read: false, readPk: '00'.repeat(32) }), 'empty scope', 'no operation and no read', false);
  clientRefuses(variant(J, { caller: '33'.repeat(32) }), 'read-only grant cannot restrict caller', 'a read-only grant with a caller pin', false);
  clientRefuses(variant(K, { opWithdrawShielded: true }), 'shielded spend requires read', 'a shielded spend without read', false);
  clientRefuses(variant(K, { perCallCap: '101' }), 'per-call cap above cap', 'the per-call cap above the cap', false);
  clientRefuses(variant(K, { perCallCap: '0', cap: '0' }), 'spend without cap', 'a spending grant with a zero cap', false);
  clientRefuses(variant(K, { maxCoinValue: '5' }), 'coin bound below per-call cap', 'the max coin value below the per-call cap', false);
  clientRefuses(variant(K, { windowLen: '1' }), 'window bounds reserved', 'a window length', false);
  clientRefuses(variant(J, { color: '44'.repeat(32) }), 'read-only grant carries object fields', 'a read-only grant with a colour', false);
  // the order: several rules broken at once, the circuit's first one named
  clientRefuses(variant(K, { readPk: '11'.repeat(32) }, { tag: tagHex('midnight:account:grant:id:k1:v9') }), 'evm_eip712: a read key without read', 'order: the read key before the grantee class', false, 'the client\'s order (an order case)');
  clientRefuses(variant(K, { rpIdHash: '5a'.repeat(32) }, { tag: tagHex('midnight:account:grant:id:k1:v9') }), 'evm_eip712: not a registered grant-id tag', 'order: the grantee class before the RP rules', true);
  clientRefuses(variant(K, { rpIdHash: '5a'.repeat(32), cap: '0', perCallCap: '0' }), 'evm_eip712: an RP hash belongs to a spending passkey grant', "order: the arm's rules before the shared chip's", true);
  clientRefuses(variant(K, { perCallCap: '10', cap: '0' }), 'per-call cap above cap', "order: the chip's per-call cap before its spend-without-cap", false, 'the client\'s order (an order case)');
  ok('issue rules', issueRules.length);
  (globalThis as any).__issueRules = issueRules;
  // a grantee input built elsewhere is re-checked by the strict decoders
  const k1 = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), false);
  const kx = beInt(k1.subarray(1, 33)), ky = beInt(k1.subarray(33, 65));
  const good = evmEip712GranteeInput({ scheme: 'k256', x: kx, y: ky, envelope: 0 }, { originHash: rnd(32) }, 0n);
  assert.equal(checkEvmEip712GranteeInput(good), good);
  const offCurve = { ...good, key2: new Uint8Array(good.key2) }; offCurve.key2[0] ^= 1;
  refused('client refusals', () => checkEvmEip712GranteeInput(offCurve), /descriptor:|not on|point/i, 'a k256 grantee input whose point is off the curve');
  const surface = new Proxy({}, { get: () => { throw new Error('the account must not be touched'); } }) as any;
  const devStub = new Proxy({}, { get: () => { throw new Error('the device must not be asked to sign'); } }) as any;
  await refusedAsync('client refusals', () => issueGrantWithEvmEip712(surface, devStub, offCurve, {} as any), /descriptor:|not on|point/i, 'the grant facade refuses it before the account or the wallet is touched');
  await refusedAsync('client refusals', () => revokeGrantWithEvmEip712(surface, devStub, offCurve), /descriptor:|not on|point/i, 'the revoke facade refuses it too');
  console.log(`  ✓ client refusals: the RP rules (a passkey device and a spending passkey grant with a zero RP hash; a read-only passkey grant with one), any recipient with a recipient, an off-curve grantee input refused by the grant facades before the account or the wallet is touched, a passkey grantee's site origin checked by the base rule, the circuit's RP and any-recipient rules in its order with its messages (an RP hash on every non-passkey grantee, read-only and spending; the RP rule before the any-recipient rule; a passkey device's origin before its RP hash; the six frozen RP and any-recipient negatives refused by the client with the circuit's message), every issue_grant rule (the export's read key, the grantee class, the RP rules, the any-recipient rule, the recipient kind and the shared chip's, in the circuit's order with its message, and four order cases: ${tally['issue rules']?.pass ?? 0}) (${tally['client refusals'].refused})`);
}

const report = { suite: 'evm-eip712-offline', seed: SEED, ranAt: new Date().toISOString(), tally, vectors, frozen: { file: `src/tests/vectors/${VECTOR_FILE}`, vectors: FROZEN.vectors.length, negatives: negativeResults, hashesBy: FROZEN.hashesBy }, noBlob: CLASS, issueRules: (globalThis as any).__issueRules, verdict: 'PASS' };
if (process.env.EVIDENCE_DIR) {
  const file = path.join(process.env.EVIDENCE_DIR, 'evm-eip712-offline.json');
  fs.mkdirSync(process.env.EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  console.log(`\n■ evidence → ${file}`);
}
console.log('\n◆ evm-eip712-offline: PASS');
