// Arm `sol_ed25519`, offline (no node, no proof server): the key relation,
// the derivations, the seed helper, the blind protocol, key admissibility
// at the client and runtime layers, activation in the simulator, and the
// account's deploy roster: allCircuits() of wave-deploy.ts, which follows the
// client's arm registry, is exactly the compiled contract's provable circuits,
// the arm's sixteen among them (a circuit left out of the roster is never
// deployed, and an account without it cannot be connected).
//
// Independent oracles: Node's OpenSSL Ed25519
// (node:crypto) and noble with { zip215: false } plus explicit policy checks
// (R != O, A != O, prime-order subgroup), and SHA-256 of the documented preimages
// (node:crypto). The contract side is the account's own pure circuits and,
// for the shared recipes, the base probe's module circuits.
//
// Writes $EVIDENCE_DIR/sol-ed25519-offline.json when EVIDENCE_DIR is set.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign as osslSign, verify as osslVerify } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';
import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';

import { Contract, ledger, pureCircuits } from '../wallet/contract.js';
import * as Probe from '../../contracts/managed/probe-wallet-arms-base/contract/index.js';
import { makeWitnesses, emptyCoinStore } from '../wallet/witnesses.js';
import { JubjubDevice } from '../wallet/signer.js';
import { solKeyHints } from '../wallet/signer-sol-ed25519.js';
/** A point followed by its checked byte inputs, as the circuits take a key. */
const kin = (p: { x: bigint; y: bigint }): [{ x: bigint; y: bigint }, bigint[], bigint[]] => { const h = solKeyHints(p); return [p, h.pk_bytes, h.pk_x]; };
import { entryCall, bootCall, grantIdCall, derive, padTag } from '../wallet/descriptors.js';
import { deriveBlind } from '../wallet/blind.js';
import { allCircuits, ARMS } from '../wallet/wave-deploy.js';
import {
  ED25519_L, SolEd25519Device, decodeSolSignature, deriveSolBlind, parseSolRosterEntry, solBlindMessage,
  solPublicKeyBytes, solPublicKeyFromSeed, solPublicKeyPoint, solRosterEntry, solSoftwareSigner,
  verifySolSignature, type SolSigner,
} from '../wallet/signer-sol-ed25519.js';

// ── tiny harness (fail-closed: every case must PASS) ─────────────────────────

interface Case { group: string; name: string; verdict: 'PASS' | 'FAIL'; layer?: string; detail?: string }
const cases: Case[] = [];
const ok = (group: string, name: string, cond: boolean, detail?: string, layer?: string) => {
  cases.push({ group, name, verdict: cond ? 'PASS' : 'FAIL', ...(layer ? { layer } : {}), ...(detail ? { detail } : {}) });
  if (!cond) console.log(`  ✗ ${group}: ${name}${detail ? ` — ${detail}` : ''}`);
};
/** A refusal case: `fn` must throw, and its message must match `re`. */
const refused = async (group: string, name: string, layer: string, re: RegExp, fn: () => unknown) => {
  try {
    await fn();
    ok(group, name, false, 'accepted (expected a refusal)', layer);
  } catch (e: any) {
    const m = String(e?.message ?? e);
    ok(group, name, re.test(m), m.slice(0, 200), layer);
  }
};

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const sha256 = (...parts: Uint8Array[]) => new Uint8Array(createHash('sha256').update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest());
const le = (v: bigint, n: number) => { const o = new Uint8Array(n); let x = v; for (let i = 0; i < n; i++) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const eq = (a: Uint8Array, b: Uint8Array) => hex(a) === hex(b);
const rnd = (n: number) => new Uint8Array(randomBytes(n));
const P = 2n ** 255n - 19n;

// Node's OpenSSL Ed25519 from a 32-byte seed.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const osslPrivate = (seed: Uint8Array) => createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
const osslPublicBytes = (seed: Uint8Array) => new Uint8Array(createPublicKey(osslPrivate(seed)).export({ format: 'der', type: 'spki' }).subarray(-32));
const osslPublic = (key: Uint8Array) => createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(key)]), format: 'der', type: 'spki' });

// The independent policy oracle: OpenSSL verifies, noble (no ZIP-215)
// verifies, and the explicit checks hold (canonical, prime order, not O).
function oracleAccepts(msg: Uint8Array, sig: Uint8Array, key: Uint8Array): boolean {
  let openssl = false;
  try { openssl = osslVerify(null, Buffer.from(msg), osslPublic(key), Buffer.from(sig)); } catch { openssl = false; }
  let noble = false;
  try { noble = ed25519.verify(sig, msg, key, { zip215: false }); } catch { noble = false; }
  let policy = false;
  try {
    const A = ed25519.Point.fromBytes(key, false);
    const R = ed25519.Point.fromBytes(sig.subarray(0, 32), false);
    const s = BigInt('0x' + hex(sig.subarray(32).slice().reverse()));
    policy = eq(A.toBytes(), key) && eq(R.toBytes(), sig.subarray(0, 32))
      && !A.is0() && !R.is0() && A.isTorsionFree() && R.isTorsionFree() && !A.isSmallOrder() && !R.isSmallOrder() && s < ED25519_L;
  } catch { policy = false; }
  return openssl && noble && policy;
}

const SEEDS: Uint8Array[] = [new Uint8Array(32), new Uint8Array(32).fill(0xff), Uint8Array.from({ length: 32 }, (_, i) => i), ...Array.from({ length: 29 }, () => rnd(32))];

// ── 1. The seed helper and the key relation ─────────────────────────────────
{
  const G = '1 seed helper and key encoding';
  let agree = 0;
  for (const seed of SEEDS) {
    const { pk, key } = solPublicKeyFromSeed(seed);
    const noble = ed25519.getPublicKey(seed);
    const ossl = osslPublicBytes(seed);
    const viaEncode: Uint8Array = pureCircuits.encode_public_key_ed25519(...kin(pk));
    const strict = solPublicKeyPoint(key);
    const same = eq(key, noble) && eq(noble, ossl) && eq(viaEncode, key) && eq(solPublicKeyBytes(pk), key)
      && strict.x === pk.x && strict.y === pk.y;
    if (same) agree++; else ok(G, `seed ${hex(seed)}`, false, `contract ${hex(key)} noble ${hex(noble)} openssl ${hex(ossl)}`);
  }
  ok(G, `compute_public_key_ed25519 == noble == OpenSSL, encode(point) == key, strict decode(key) == point (${SEEDS.length} seeds incl. zero, 0xff.., 00..1f)`, agree === SEEDS.length, `${agree}/${SEEDS.length}`);
  // The clamped scalar exceeds L on every seed: the helper's reduction is exercised every time.
  const h = sha512(SEEDS[3]).subarray(0, 32).slice(); h[0] &= 248; h[31] &= 127; h[31] |= 64;
  ok(G, 'clamped scalar >= L (reduction mod L exercised)', BigInt('0x' + hex(h.reverse())) >= ED25519_L);
  // Encoding of points with both x parities.
  let odd = 0, even = 0;
  for (let i = 1n; i <= 64n; i++) {
    const p = ed25519.Point.BASE.multiply(i);
    const pt = { x: p.toAffine().x, y: p.toAffine().y };
    const enc: Uint8Array = pureCircuits.encode_public_key_ed25519(...kin(pt));
    if (!eq(enc, p.toBytes())) ok(G, `encode([${i}]B)`, false);
    if (pt.x & 1n) odd++; else even++;
  }
  ok(G, 'encode([i]B) == RFC 8032 encoding for i = 1..64 (both x parities)', odd > 0 && even > 0, `odd ${odd}, even ${even}`);
}

// ── 2. Signatures: the arm's pre-check vs OpenSSL and noble ─────────────────
{
  const G = '2 signatures and pre-check';
  let agree = 0;
  for (const seed of SEEDS.slice(0, 16)) {
    const signer = solSoftwareSigner(seed);
    const msg = rnd(1 + (seed[5] % 200));
    const nobleSig = signer.sign(msg) as Uint8Array;
    const osslSig = new Uint8Array(osslSign(null, Buffer.from(msg), osslPrivate(seed)));
    const pre = verifySolSignature(msg, nobleSig, signer.publicKey);
    const dec = decodeSolSignature(nobleSig);
    if (eq(nobleSig, osslSig) && oracleAccepts(msg, nobleSig, signer.publicKey) && pre.s === dec.s && pre.s < ED25519_L) agree++;
  }
  ok(G, 'software signer == OpenSSL signature (deterministic), oracle and pre-check accept (16 keys)', agree === 16, `${agree}/16`);
  const signer = solSoftwareSigner(SEEDS[4]);
  const msg = new TextEncoder().encode('Midnight Passport test');
  const sig = signer.sign(msg) as Uint8Array;
  const S = BigInt('0x' + hex(sig.subarray(32).slice().reverse()));
  const sPlusL = new Uint8Array([...sig.subarray(0, 32), ...le(S + ED25519_L, 32)]);
  await refused(G, 'S + L twin refused (never reduced)', 'client', /not below L/, () => verifySolSignature(msg, sPlusL, signer.publicKey));
  ok(G, 'S + L twin refused by the oracle too', !oracleAccepts(msg, sPlusL, signer.publicKey));
  const flipped = sig.slice(); flipped[40] ^= 1;
  await refused(G, 'flipped S bit refused', 'client', /does not verify/, () => verifySolSignature(msg, flipped, signer.publicKey));
  const other = solSoftwareSigner(SEEDS[5]);
  await refused(G, 'another key refused', 'client', /does not verify/, () => verifySolSignature(msg, sig, other.publicKey));
  const otherMsg = msg.slice(); otherMsg[0] ^= 1;
  await refused(G, 'other bytes refused', 'client', /does not verify/, () => verifySolSignature(otherMsg, sig, signer.publicKey));
  const rId = new Uint8Array([1, ...new Uint8Array(31), ...sig.subarray(32)]);
  await refused(G, "R = identity refused (the Ed25519 core's R != O rule)", 'client', /R is the identity/, () => verifySolSignature(msg, rId, signer.publicKey));
  const rSmall = new Uint8Array([...unhex('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a'), ...sig.subarray(32)]);
  await refused(G, 'R of small order refused', 'client', /small order/, () => verifySolSignature(msg, rSmall, signer.publicKey));
  const T8 = ed25519.Point.fromBytes(unhex('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a'), false);
  const rMixed = new Uint8Array([...ed25519.Point.fromBytes(sig.subarray(0, 32), false).add(T8).toBytes(), ...sig.subarray(32)]);
  await refused(G, 'R of mixed order refused', 'client', /prime-order subgroup/, () => verifySolSignature(msg, rMixed, signer.publicKey));
  const rNonCanon = new Uint8Array([...le(P + 1n, 32), ...sig.subarray(32)]);
  await refused(G, 'non-canonical R (y = p + 1) refused', 'client', /does not decode|not canonical/, () => verifySolSignature(msg, rNonCanon, signer.publicKey));
  // A Ledger-style wrapped signature (the off-chain envelope): signs other bytes.
  const wrapped = signer.sign(new Uint8Array([0xff, ...new TextEncoder().encode('solana offchain'), ...msg])) as Uint8Array;
  await refused(G, 'off-chain-envelope signature refused (signs other bytes)', 'client', /does not verify/, () => verifySolSignature(msg, wrapped, signer.publicKey));
}

// ── 3. Key admissibility: client decode and runtime type ────────────────────
const SMALL_ORDER = [
  '0100000000000000000000000000000000000000000000000000000000000000', // identity
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', // order 2
  '0000000000000000000000000000000000000000000000000000000000000000', // order 4
  '0000000000000000000000000000000000000000000000000000000000000080', // order 4
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a', // order 8
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa', // order 8
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', // order 8
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85', // order 8
];
{
  const G = '3 key admissibility';
  // Self-check of the list: each decodes (non-strictly) to a point of order dividing 8.
  ok(G, 'the 8 small-order encodings are of small order (noble)', SMALL_ORDER.every((h) => ed25519.Point.fromBytes(unhex(h), true).multiplyUnsafe(8n).is0()));
  for (const h of SMALL_ORDER) {
    await refused(G, `client decode refuses small-order key ${h.slice(0, 8)}…`, 'client', /small order|non-canonical|not a canonical/, () => solPublicKeyPoint(unhex(h)));
  }
  const T8 = ed25519.Point.fromBytes(unhex(SMALL_ORDER[4]), false);
  for (const seed of SEEDS.slice(0, 4)) {
    const A = ed25519.Point.fromBytes(ed25519.getPublicKey(seed), false).add(T8);
    await refused(G, `client decode refuses mixed-order key A + T8 (${hex(seed).slice(0, 8)}…)`, 'client', /mixed order/, () => solPublicKeyPoint(A.toBytes()));
    const pt = { x: A.toAffine().x, y: A.toAffine().y };
    await refused(G, `runtime type check refuses mixed-order point (${hex(seed).slice(0, 8)}…)`, 'runtime', /Curve25519Point|type/i,
      () => pureCircuits.derive_device_entry_with_sol_ed25519({ bytes: rnd(32) }, ...kin(pt), rnd(32), 0n, 0n));
  }
  for (const h of SMALL_ORDER.slice(1)) {
    const p = ed25519.Point.fromBytes(unhex(h), true).toAffine();
    await refused(G, `runtime type check refuses small-order point ${h.slice(0, 8)}…`, 'runtime', /Curve25519Point|type/i,
      () => pureCircuits.derive_device_entry_with_sol_ed25519({ bytes: rnd(32) }, ...kin({ x: p.x, y: p.y }), rnd(32), 0n, 0n));
  }
  // The identity is in the subgroup: the type admits it, the circuits' asserts refuse it (section 6).
  let identityTyped = true;
  try { pureCircuits.encode_public_key_ed25519(...kin({ x: 0n, y: 1n })); } catch { identityTyped = false; }
  ok(G, 'the identity passes the point type (its refusal is the circuit assert, section 6)', identityTyped);
  // Non-canonical and malformed encodings: client decode only (the circuit never takes bytes).
  const nonCanonical: [string, Uint8Array][] = [
    ['y = p (non-canonical 0)', le(P, 32)],
    ['y = p + 1 (non-canonical identity)', le(P + 1n, 32)],
    ['y = 2^255 - 1', le(2n ** 255n - 1n, 32)],
    ['negative zero: x = 0 with the sign bit', unhex('0100000000000000000000000000000000000000000000000000000000000080')],
  ];
  for (const [name, b] of nonCanonical) await refused(G, `client decode refuses ${name}`, 'client', /descriptor:/, () => solPublicKeyPoint(b));
  // Off the curve: a y whose x^2 is not a square.
  let off: Uint8Array | null = null;
  for (let y = 2n; y < 200n && !off; y++) { try { ed25519.Point.fromBytes(le(y, 32), true); } catch { off = le(y, 32); } }
  await refused(G, 'client decode refuses a y off the curve', 'client', /descriptor:/, () => solPublicKeyPoint(off!));
  await refused(G, 'client decode refuses 31 bytes', 'client', /32 bytes/, () => solPublicKeyPoint(rnd(31)));
  await refused(G, 'client decode refuses non-canonical base58 (leading zero digit)', 'client', /base58|descriptor/, () => solPublicKeyPoint('1' + 'J'.repeat(43)));
  // Runtime: a coordinate outside the field (a non-canonical representation of a valid point).
  const B = ed25519.Point.BASE.toAffine();
  await refused(G, 'runtime type check refuses y + p (coordinate not below p)', 'runtime', /Curve25519Point|type/i,
    () => pureCircuits.encode_public_key_ed25519(...kin({ x: B.x, y: B.y + P })));
}

// ── 4. Derivations: the account's circuits, the shared module, SHA-256 ──────
{
  const G = '4 derivations';
  const tag = (t: string) => padTag(t);
  let n = 0;
  for (const seed of SEEDS.slice(0, 24)) {
    const { pk, key } = solPublicKeyFromSeed(seed);
    const blind = rnd(32), account = rnd(32), salt = rnd(32), originHash = rnd(32);
    const epoch = BigInt(seed[1]) * 1000003n % 2n ** 32n, counter = BigInt('0x' + hex(seed.subarray(0, 8))), slot = BigInt(seed[2]);
    const d = new SolEd25519Device({ publicKey: key, blind });
    const entry = pureCircuits.derive_device_entry_with_sol_ed25519({ bytes: account }, ...kin(pk), blind, epoch, counter);
    const entrySpec = sha256(tag('midnight:account:device:sol:v1'), account, key, blind, le(epoch, 4), le(counter, 8));
    const entryModule = derive(Probe.pureCircuits, entryCall(d.descriptor(), account, epoch, counter));
    const boot = pureCircuits.derive_boot_commitment_with_sol_ed25519(salt, ...kin(pk), blind);
    const bootSpec = sha256(tag('midnight:account:boot:sol:v1'), salt, key, blind);
    const bootModule = derive(Probe.pureCircuits, bootCall(d.descriptor(), salt));
    const gid = pureCircuits.derive_grant_id_with_sol_ed25519({ bytes: account }, ...kin(pk), blind, originHash, slot);
    const gidSpec = sha256(tag('midnight:account:grant:id:sol:v1'), account, key, blind, originHash, le(slot, 1));
    const gidModule = derive(Probe.pureCircuits, grantIdCall(d.descriptor(), account, originHash, slot));
    const sig = rnd(64);
    const blindC = pureCircuits.derive_blind_with_sol_ed25519(sig);
    const blindSpec = sha256(tag('midnight:account:blind:sol:v1'), sig);
    const all = eq(entry, entrySpec) && eq(entry, entryModule) && eq(entry, d.entryAt(account, epoch, counter))
      && eq(boot, bootSpec) && eq(boot, bootModule) && eq(boot, d.bootCommitment(salt))
      && eq(gid, gidSpec) && eq(gid, gidModule) && eq(gid, d.grantId(account, originHash, slot))
      && eq(blindC, blindSpec) && eq(blindC, deriveBlind('sol_ed25519', sig));
    if (all) n++; else ok(G, `vector ${hex(seed).slice(0, 8)}`, false);
  }
  ok(G, 'entry, boot, grant id and blind == SHA-256 of the spec preimages == the base module (24 vectors)', n === 24, `${n}/24`);
  // The blind separates: same key, two blinds, two unrelated entries.
  const { pk } = solPublicKeyFromSeed(SEEDS[6]);
  const a = rnd(32);
  ok(G, 'different blinds give different entries for one key', !eq(
    pureCircuits.derive_device_entry_with_sol_ed25519({ bytes: a }, ...kin(pk), rnd(32), 0n, 0n),
    pureCircuits.derive_device_entry_with_sol_ed25519({ bytes: a }, ...kin(pk), rnd(32), 0n, 0n)));
}

// ── 5. The blind protocol ───────────────────────────────────────────────────
{
  const G = '5 blind protocol';
  const signer = solSoftwareSigner(SEEDS[7]);
  const req = { network: 'undeployed', accountIndex: 0 };
  const r1 = await deriveSolBlind(signer, req);
  const r2 = await deriveSolBlind(signer, req);
  ok(G, 'deterministic wallet: two enrolments give the same blind', eq(r1.blind, r2.blind));
  const msg = solBlindMessage(signer.publicKey, req);
  const expectedSig = new Uint8Array(osslSign(null, Buffer.from(msg.bytes), osslPrivate(SEEDS[7])));
  ok(G, 'blind == SHA-256(blind tag || OpenSSL signature of the request message)', eq(r1.blind, sha256(padTag('midnight:account:blind:sol:v1'), expectedSig)));
  const lines = msg.text.split('\n');
  ok(G, 'request message: first line, network, base58 key, index, warning', lines[0] === 'Midnight Passport account privacy key (v1)'
    && lines[1] === 'Network: undeployed' && lines[2] === `Wallet: Solana public key ${new SolEd25519Device({ publicKey: signer.publicKey, blind: r1.blind }).address}`
    && lines[3] === 'Account index: 0' && lines[4].startsWith('Warning:') && !msg.text.includes('\r'), JSON.stringify(lines.slice(0, 4)));
  const r3 = await deriveSolBlind(signer, { network: 'undeployed', accountIndex: 1 });
  const r4 = await deriveSolBlind(signer, { network: 'preview', accountIndex: 0 });
  ok(G, 'per account index and per network: different blinds', !eq(r1.blind, r3.blind) && !eq(r1.blind, r4.blind));
  // A hedged signer (random nonce r): valid signatures that differ.
  const a = (() => { const h = sha512(SEEDS[7]).subarray(0, 32).slice(); h[0] &= 248; h[31] &= 127; h[31] |= 64; return BigInt('0x' + hex(h.reverse())) % ED25519_L; })();
  const hedged: SolSigner = {
    publicKey: signer.publicKey,
    formats: signer.formats,
    sign: (m) => {
      const r = BigInt('0x' + hex(rnd(64))) % ED25519_L;
      const R = ed25519.Point.BASE.multiply(r).toBytes();
      const k = BigInt('0x' + hex(sha512(new Uint8Array([...R, ...signer.publicKey, ...m])).reverse())) % ED25519_L;
      return new Uint8Array([...R, ...le((r + k * a) % ED25519_L, 32)]);
    },
  };
  const hs = hedged.sign(msg.bytes) as Uint8Array;
  ok(G, 'the hedged signer produces valid signatures (oracle accepts)', oracleAccepts(msg.bytes, hs, signer.publicKey));
  await refused(G, 'sign-twice check refuses a non-deterministic (hedged) wallet', 'client', /not deterministic/, () => deriveSolBlind(hedged, req));
  const liar: SolSigner = { publicKey: signer.publicKey, formats: signer.formats, sign: (m) => signer.sign(new Uint8Array([...m, 0x20])) };
  await refused(G, 'a wallet that signs other bytes is refused', 'client', /refused before proving: the signature is not from the expected/, () => deriveSolBlind(liar, req));
  const impostor: SolSigner = { publicKey: signer.publicKey, formats: signer.formats, sign: (m) => solSoftwareSigner(SEEDS[8]).sign(m) };
  await refused(G, 'a wallet that signs with another key is refused', 'client', /refused before proving: the signature is not from the expected/, () => deriveSolBlind(impostor, req));
  await refused(G, 'bad network name refused', 'client', /blind:/, () => deriveSolBlind(signer, { network: 'Main Net', accountIndex: 0 }));
  await refused(G, 'account index above 2^32 - 1 refused', 'client', /blind:/, () => deriveSolBlind(signer, { network: 'undeployed', accountIndex: 2n ** 32n }));
  // Roster persistence.
  const account = rnd(32);
  const json = solRosterEntry(r1, account);
  const back = parseSolRosterEntry(JSON.parse(JSON.stringify(json)));
  ok(G, 'roster entry round trip (key, blind, index, network, account)', eq(back.key, r1.key) && eq(back.blind, r1.blind) && back.accountIndex === 0n && back.network === 'undeployed' && eq(back.account!, account));
  await refused(G, 'roster entry with a small-order key refused', 'client', /descriptor:/, () => parseSolRosterEntry({ ...json, key: SMALL_ORDER[4] }));
  await refused(G, 'roster entry with upper-case hex refused', 'client', /hex/, () => parseSolRosterEntry({ ...json, blind: json.blind.toUpperCase() }));
  await refused(G, 'roster entry with an index above 2^32 - 1 refused', 'client', /index/, () => parseSolRosterEntry({ ...json, accountIndex: '4294967296' }));
  await refused(G, 'device from a blind record of another key refused', 'client', /another key/, () => SolEd25519Device.fromSigner(solSoftwareSigner(SEEDS[9]), r1));
}

// ── 6. Activation in the simulator (runtime layer) ──────────────────────────
interface Sim { contract: any; state: any; ps: any; address: string; addressBytes: Uint8Array }
/** The ledger view of a constructor state (ContractState) or of a call's state (ChargedState). */
const ledgerOf = (s: any) => ledger(s?.constructor?.name === 'ContractState' ? s.data : s);
async function deploySim(boot: Uint8Array): Promise<Sim> {
  const contract = new (Contract as any)(makeWitnesses());
  const ps = emptyCoinStore();
  const coinPk = { bytes: rnd(32) };
  const init = await contract.initialState(createConstructorContext(ps, coinPk), boot, rnd(32), JubjubDevice.generate().pk, new Uint8Array(64), 259200n);
  const address = sampleContractAddress();
  return { contract, state: init.currentContractState, ps, address, addressBytes: unhex(address.replace(/^0x/, '')) };
}
async function simCall(sim: Sim, circuit: string, ...args: unknown[]) {
  const ctx = createCircuitContext({ circuitId: circuit, contractAddress: sim.address, coinPublicKeyOrZswapState: { bytes: rnd(32) }, contractState: sim.state, privateState: sim.ps, time: 1_800_000_000 } as any);
  const r = await sim.contract.impureCircuits[circuit](ctx, ...args);
  sim.state = r.context.callContext.currentQueryContext.state;
  return r.result;
}
{
  const G = '6 activation (simulator)';
  const signer = solSoftwareSigner(SEEDS[10]);
  const rec = await deriveSolBlind(signer, { network: 'undeployed', accountIndex: 0 });
  const device = SolEd25519Device.fromSigner(signer, rec);
  const salt = rnd(32);
  const sim = await deploySim(device.bootCommitment(salt));
  await refused(G, 'wrong blind: boot commitment mismatch', 'runtime', /boot commitment mismatch/, () => simCall(sim, 'activate_initial_device_with_sol_ed25519', ...kin(device.pk), salt, rnd(32)));
  await refused(G, 'wrong salt: boot commitment mismatch', 'runtime', /boot commitment mismatch/, () => simCall(sim, 'activate_initial_device_with_sol_ed25519', ...kin(device.pk), rnd(32), device.blind));
  const other = solPublicKeyFromSeed(SEEDS[11]);
  await refused(G, 'another key: boot commitment mismatch', 'runtime', /boot commitment mismatch/, () => simCall(sim, 'activate_initial_device_with_sol_ed25519', ...kin(other.pk), salt, device.blind));
  const before = ledgerOf(sim.state);
  await simCall(sim, 'activate_initial_device_with_sol_ed25519', ...device.activationArgs(salt));
  const after = ledgerOf(sim.state);
  ok(G, 'positive: activation boots the account with the device entry at (epoch, 0)',
    !before.booted && after.booted && after.device_count === 1n && after.devices.member(device.entryAt(sim.addressBytes, after.device_epoch, 0n))
    && after.round > before.round && eq(after.boot, new Uint8Array(32)));
  await refused(G, 'second activation refused', 'runtime', /already activated/, () => simCall(sim, 'activate_initial_device_with_sol_ed25519', ...device.activationArgs(salt)));
  // The identity key: its boot commitment by the documented recipe (the contract's
  // own derivation refuses O, A != O); the activation's derivation refuses it.
  const O = { x: 0n, y: 1n };
  const blind = rnd(32);
  await refused(G, "the identity key's boot commitment: the contract's derivation refuses it", 'runtime', /the Ed25519 key is the identity/, () => pureCircuits.derive_boot_commitment_with_sol_ed25519(salt, ...kin(O), blind));
  const idKey = new Uint8Array(32); idKey[0] = 1;
  const simO = await deploySim(sha256(padTag('midnight:account:boot:sol:v1'), salt, idKey, blind));
  await refused(G, 'identity key refused at activation (A != O in the module\'s ed25519 class)', 'runtime', /the Ed25519 key is the identity/, () => simCall(simO, 'activate_initial_device_with_sol_ed25519', ...kin(O), salt, blind));
}

// ── 7. The deploy roster ────────────────────────────────────────────────────
{
  const G = '7 deploy roster';
  const provable = Object.keys(new (Contract as any)(makeWitnesses()).impureCircuits).sort();
  const roster = [...allCircuits()].sort();
  ok(G, "allCircuits() is exactly the compiled contract's provable circuits", JSON.stringify(roster) === JSON.stringify(provable),
    `roster ${roster.length}, provable ${provable.length}; missing ${provable.filter((c) => !roster.includes(c)).join(', ') || 'none'}; extra ${roster.filter((c) => !provable.includes(c)).join(', ') || 'none'}`);
  const arm = roster.filter((c) => /_(with|with_grant)_sol_ed25519$/.test(c));
  ok(G, 'the sixteen sol_ed25519 circuits are in the roster', arm.length === 16, `${arm.length}`);
  ok(G, 'sol_ed25519 is a registered arm', ARMS.includes('sol_ed25519'), ARMS.join(', '));
}

// ── report ───────────────────────────────────────────────────────────────────
const failed = cases.filter((c) => c.verdict !== 'PASS');
const groups = [...new Set(cases.map((c) => c.group))];
for (const g of groups) {
  const cs = cases.filter((c) => c.group === g);
  console.log(`  ${cs.every((c) => c.verdict === 'PASS') ? '✓' : '✗'} ${g}: ${cs.filter((c) => c.verdict === 'PASS').length}/${cs.length}`);
}
const verdict = failed.length ? 'FAIL' : 'PASS';
if (process.env.EVIDENCE_DIR) {
  fs.mkdirSync(process.env.EVIDENCE_DIR, { recursive: true });
  const file = path.join(process.env.EVIDENCE_DIR, 'sol-ed25519-offline.json');
  fs.writeFileSync(file, JSON.stringify({ suite: 'sol-ed25519-offline', ranAt: new Date().toISOString(), node: process.version, cases, verdict }, null, 2) + '\n');
  console.log(`\n■ evidence → ${file}`);
}
console.log(`\n◆ sol-ed25519-offline: ${verdict} (${cases.length} cases, ${failed.length} failed)`);
process.exit(verdict === 'PASS' ? 0 : 1);
