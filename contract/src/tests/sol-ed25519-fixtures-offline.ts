// Arm `sol_ed25519`, offline: signatures recorded from emulated hardware
// wallets (src/tests/vectors/sol-ed25519-emulator-fixtures.json: a Trezor
// Safe 5 emulator, a Ledger Flex and a Ledger Nano S Plus on Speculos, public
// test seeds only), checked on the circuit's verification path and through
// the client.
//
//   - The file: every key is its public test seed's key (BIP-39 seed,
//     SLIP-0010 at the recorded path), and every recorded signature is the
//     RFC 8032 signature of the recorded bytes under that key (OpenSSL), so
//     each device signed exactly those bytes.
//   - The circuit path: contracts/probe-sol-ed25519-fixtures.compact (the
//     seams' checked key encoding, SolanaFormats and Ed25519Core over a given
//     text) accepts each approval and blind signature with the off-chain flag
//     and refuses it with the raw flag.
//   - The client: the off-chain bytes it builds for each text and key are the
//     bytes each device signed; the signer check accepts them; a device
//     facade over a hardware signer that answers with the recorded
//     signatures authorises approvals and derives the recorded blind, the
//     same blind in two sessions and on two devices of one seed.
//   - Negatives built from every positive (a flipped text, R, S or key byte;
//     the other format; a changed head: domain, version, signer count, an
//     envelope naming another key) and the recorded off-chain v0 messages
//     are refused by the probe and by the client; a device's signature
//     offered for another device's request is refused before proving, and
//     no hardware signer is asked for the raw format.
//   - The identity key on the circuit path: the probe encodes the key without
//     the descriptor module's A != O, so the core alone must refuse a
//     signature for A = O, whose verification equation holds for every
//     message (R = [s]B, [k]O = O).
//
// Writes $EVIDENCE_DIR/sol-ed25519-fixtures-offline.json when EVIDENCE_DIR is set.

import * as fs from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import * as path from 'node:path';
import { createHash, createHmac, createPrivateKey, createPublicKey, pbkdf2Sync, sign as osslSign } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import * as Probe from '../../contracts/managed/probe-sol-ed25519-fixtures/contract/index.js';
import { padTag } from '../wallet/descriptors.js';
import { SignerMismatchError } from '../wallet/blind.js';
import {
  SolEd25519Device, checkSolSignature, decodeSolSignature, deriveSolBlind, solBlindSignedBytes, solKeyHints, solPublicKeyPoint,
  solSignatureHints, verifySolSignature,
} from '../wallet/signer-sol-ed25519.js';
import { assertSolOffchainMessage, solSignedMessage, SOL_HEAD_LENGTH } from '../wallet/sol-ed25519-message.js';
import { solHardwareSigner } from '../wallet/sol-ed25519-wallet.js';

// ── tiny harness (fail-closed: every case must PASS) ─────────────────────────

interface Case { group: string; name: string; verdict: 'PASS' | 'FAIL'; detail?: string }
const cases: Case[] = [];
const ok = (group: string, name: string, cond: boolean, detail?: string) => {
  cases.push({ group, name, verdict: cond ? 'PASS' : 'FAIL', ...(detail ? { detail } : {}) });
  if (!cond) console.log(`  ✗ ${group}: ${name}${detail ? ` — ${detail}` : ''}`);
};
/** `fn` must throw, with a message matching `re`. */
const refused = async (group: string, name: string, re: RegExp, fn: () => unknown) => {
  try { await fn(); ok(group, name, false, 'accepted (expected a refusal)'); } catch (e: any) { const m = String(e?.message ?? e); ok(group, name, re.test(m), m.slice(0, 200)); }
};

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const unhex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((t, x) => t + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const flip = (b: Uint8Array, i: number, mask = 0x01) => { const c = Uint8Array.from(b); c[i] ^= mask; return c; };
const sha256 = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
const enc = new TextEncoder();

interface Fixture {
  id: string; role: 'positive' | 'negative'; kind: 'approval' | 'blind'; operation: string; format: 'offchain' | 'offchain-v0';
  family: 'ledger' | 'trezor'; device: string; session: string; seed: { mnemonic: string; passphrase: string }; path: string;
  key: string; text: string; textBytes: number; signed: string; signedBytes: number; signature: string;
  blindRequest?: { network: string; accountIndex: number }; blind?: string;
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, 'vectors/sol-ed25519-emulator-fixtures.json');
const doc = JSON.parse(fs.readFileSync(FILE, 'utf8')) as { fixtures: Fixture[] };
const all = doc.fixtures;
const positives = all.filter((f) => f.role === 'positive');
const negatives = all.filter((f) => f.role === 'negative');

// Independent oracles: BIP-39 seed (PBKDF2-HMAC-SHA512), SLIP-0010 Ed25519
// derivation, and OpenSSL's Ed25519 signing (node:crypto).
const bip39Seed = (mnemonic: string, passphrase: string) => new Uint8Array(pbkdf2Sync(Buffer.from(mnemonic.normalize('NFKD')), Buffer.from(`mnemonic${passphrase}`.normalize('NFKD')), 2048, 64, 'sha512'));
function slip10(seed: Uint8Array, pathText: string): Uint8Array {
  const steps = pathText.replace(/^m\//, '').split('/').map((p) => { if (!p.endsWith("'")) throw new Error('SLIP-0010 Ed25519 derives hardened steps only'); return Number(p.slice(0, -1)); });
  // SLIP-0010 fixes the HMAC key "ed25519 seed" for Ed25519 master-key derivation; it is public, not a secret.
  let I = createHmac('sha512', 'ed25519 seed').update(seed).digest(); // nosemgrep: javascript.lang.security.audit.hardcoded-hmac-key.hardcoded-hmac-key
  let k = I.subarray(0, 32), c = I.subarray(32);
  for (const i of steps) {
    const data = Buffer.concat([Buffer.of(0), k, Buffer.from([(i >>> 24) | 0x80, (i >>> 16) & 0xff, (i >>> 8) & 0xff, i & 0xff])]);
    I = createHmac('sha512', c).update(data).digest(); k = I.subarray(0, 32); c = I.subarray(32);
  }
  return new Uint8Array(k);
}
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const osslPrivate = (seed: Uint8Array) => createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
const osslPublicBytes = (seed: Uint8Array) => new Uint8Array(createPublicKey(osslPrivate(seed)).export({ format: 'der', type: 'spki' }).subarray(-32));
const osslSignBytes = (seed: Uint8Array, m: Uint8Array) => new Uint8Array(osslSign(null, Buffer.from(m), osslPrivate(seed)));

/** The circuit's verification path (the probe): true = accepted. A refusal
 *  is false or the circuit's assert. */
function probe(offchain: boolean, text: Uint8Array, signature: Uint8Array, key: Uint8Array): boolean | string {
  const f = (Probe.pureCircuits as any)[`probe_sol_ed25519_verify_${text.length}`];
  if (typeof f !== 'function') return `no probe circuit for ${text.length} bytes`;
  let sig, pk;
  try { sig = decodeSolSignature(signature); pk = solPublicKeyPoint(key); } catch (e: any) { return `decode: ${String(e?.message ?? e).slice(0, 100)}`; }
  try {
    const h = solKeyHints(pk), r = solSignatureHints(sig);
    return f(offchain, text, sig, pk, h.pk_bytes, h.pk_x, r.r_bytes, r.r_x) === true;
  } catch (e: any) { return `circuit: ${String(e?.message ?? e).slice(0, 100)}`; }
}
const accepted = (r: boolean | string) => r === true;

/** The client's pre-check over exact bytes: true = accepted. */
const client = (bytes: Uint8Array, signature: Uint8Array, key: Uint8Array): boolean => { try { verifySolSignature(bytes, signature, key); return true; } catch { return false; } };

/** A hardware signer whose device answers with recorded signatures: each
 *  recorded envelope gets its signature; anything else is not a recording
 *  (the device would sign it, but nothing recorded it). Records every
 *  request. */
function replayDevice(family: 'ledger' | 'trezor', key: Uint8Array, recorded: { signed: Uint8Array; signature: Uint8Array }[], lenient?: Uint8Array) {
  const asked: Uint8Array[] = [];
  const signer = solHardwareSigner({
    family, publicKey: key,
    signOffchain: (envelope) => {
      asked.push(envelope);
      const r = recorded.find((x) => eq(x.signed, envelope));
      if (r) return { signature: r.signature, signed: r.signed };
      if (lenient) return lenient;
      throw new Error('replay: no recording of these bytes');
    },
  });
  return { signer, asked };
}

const LENGTHS = [369, 399, 491, 685, 1230, 1690];

// ── 1. The vector file ─────────────────────────────────────────────────────
{
  const G = '1 the vector file';
  const byDevice = (d: string) => positives.filter((f) => f.device.startsWith(d)).length;
  ok(G, '22 positives (Trezor 6, Ledger Flex 13, Ledger Nano S Plus 3) and 4 negatives',
    positives.length === 22 && negatives.length === 4 && byDevice('Trezor') === 6 && byDevice('Ledger Flex') === 13 && byDevice('Ledger Nano S Plus') === 3,
    `${positives.length}/${negatives.length}`);
  ok(G, 'every text length has a probe circuit', all.every((f) => LENGTHS.includes(f.textBytes) && enc.encode(f.text).length === f.textBytes));
  const seeds = new Map<string, Uint8Array>();
  let keyOk = 0, sigOk = 0;
  for (const f of all) {
    const id = `${f.seed.mnemonic}|${f.seed.passphrase}|${f.path}`;
    if (!seeds.has(id)) seeds.set(id, slip10(bip39Seed(f.seed.mnemonic, f.seed.passphrase), f.path));
    const sk = seeds.get(id)!;
    if (hex(osslPublicBytes(sk)) === f.key) keyOk++; else ok(G, `${f.id}: key of its seed`, false, `${hex(osslPublicBytes(sk))} != ${f.key}`);
    if (hex(osslSignBytes(sk, unhex(f.signed))) === f.signature) sigOk++; else ok(G, `${f.id}: deterministic signature`, false);
  }
  ok(G, `every key is its public test seed's SLIP-0010 key at m/44'/501'/0'/0' (${keyOk}/${all.length}; ${seeds.size} seeds)`, keyOk === all.length && seeds.size === 2);
  ok(G, `every recorded signature is the RFC 8032 signature of the recorded bytes under that key (OpenSSL; ${sigOk}/${all.length})`, sigOk === all.length);
}

// ── 2. Positives on the circuit path (the probe) and through the client ──────
{
  const G = '2 positives: probe and client';
  for (const f of positives) {
    const key = unhex(f.key), text = enc.encode(f.text), signed = unhex(f.signed), signature = unhex(f.signature);
    ok(G, `${f.id}: the probe accepts it with the off-chain flag`, accepted(probe(true, text, signature, key)));
    ok(G, `${f.id}: the probe refuses it with the raw flag (the other format)`, !accepted(probe(false, text, signature, key)));
    const built = f.kind === 'approval' ? solSignedMessage('offchain', key, text) : solBlindSignedBytes(key, f.blindRequest!, 'offchain');
    ok(G, `${f.id}: the client's off-chain bytes are the bytes the device signed`, eq(built, signed));
    let checked = false;
    try { checkSolSignature(built, signature, key); checked = true; } catch { checked = false; }
    ok(G, `${f.id}: the signer check accepts the device's signature`, checked);
  }
}

// ── 3. Approvals through the device facade over a hardware signer ───────────
{
  const G = '3 approvals: the device facade';
  for (const f of positives.filter((x) => x.kind === 'approval')) {
    const key = unhex(f.key), text = enc.encode(f.text);
    const { signer, asked } = replayDevice(f.family, key, [{ signed: unhex(f.signed), signature: unhex(f.signature) }]);
    const device = new SolEd25519Device({ publicKey: key, blind: new Uint8Array(32).fill(7), signer });
    const r = await device.signApproval(text);
    ok(G, `${f.id}: authorised in the device's format (off-chain, its only one), the device asked once for the recorded envelope`,
      device.format === 'offchain' && eq(r.message, unhex(f.signed)) && eq(r.signature, unhex(f.signature)) && asked.length === 1 && eq(asked[0], unhex(f.signed)));
  }
  const f = positives.find((x) => x.kind === 'approval')!;
  const { signer, asked } = replayDevice(f.family, unhex(f.key), []);
  await refused(G, 'a hardware device is never made to sign raw approvals', /cannot sign the raw format/, () => new SolEd25519Device({ publicKey: unhex(f.key), blind: new Uint8Array(32), signer, format: 'raw' }));
  await refused(G, 'a hardware signer handed raw bytes refuses them without asking the device', /cannot sign the raw format; not asked/, () => signer.sign(solSignedMessage('raw', unhex(f.key), enc.encode(f.text))));
  ok(G, 'the device was not asked', asked.length === 0);
}

// ── 4. Blind requests: the recorded blind, in two sessions and on two devices ─
{
  const G = '4 blind: two sessions, two devices';
  const blinds = positives.filter((x) => x.kind === 'blind');
  ok(G, 'four device blind signatures of one seed: the Ledger Flex in two sessions (s1 twice, s2) and the Nano S Plus', blinds.length === 4
    && new Set(blinds.map((b) => b.key)).size === 1 && blinds.some((b) => b.session === 's2') && blinds.some((b) => b.device.startsWith('Ledger Nano S Plus')));
  const derived: string[] = [];
  for (const f of blinds) {
    const key = unhex(f.key);
    const { signer, asked } = replayDevice(f.family, key, [{ signed: unhex(f.signed), signature: unhex(f.signature) }]);
    const rec = await deriveSolBlind(signer, { network: f.blindRequest!.network, accountIndex: f.blindRequest!.accountIndex });
    derived.push(hex(rec.blind));
    ok(G, `${f.id}: enrolment signs the request twice in the off-chain format and derives the recorded blind`,
      rec.format === 'offchain' && hex(rec.blind) === f.blind && asked.length === 2 && asked.every((a) => eq(a, unhex(f.signed))));
    ok(G, `${f.id}: blind = SHA-256(pad32(blind tag) || signature)`, hex(sha256(cat(padTag('midnight:account:blind:sol:v1'), unhex(f.signature)))) === f.blind);
  }
  ok(G, 'the same blind in every session and on both devices', new Set(derived).size === 1, derived.join(' '));
  // The same key's raw request gives another blind: one blind per format.
  const f = blinds[0];
  const sk = slip10(bip39Seed(f.seed.mnemonic, f.seed.passphrase), f.path);
  const rawSig = osslSignBytes(sk, solBlindSignedBytes(unhex(f.key), f.blindRequest!, 'raw'));
  ok(G, 'the raw-format blind of the same key and request is another blind (one blind per format)', hex(sha256(cat(padTag('midnight:account:blind:sol:v1'), rawSig))) !== f.blind);
  const { signer } = replayDevice(f.family, unhex(f.key), []);
  await refused(G, 'a hardware signer is never asked for the raw blind request', /cannot sign the raw format/, () => deriveSolBlind(signer, { ...f.blindRequest!, format: 'raw' }));
}

// ── 5. Negatives built from every positive ──────────────────────────────────
{
  const G = '5 negatives built from the positives';
  const other = unhex(positives.find((x) => x.family === 'trezor')!.key);
  let n = 0;
  for (const f of positives) {
    const key = unhex(f.key), text = enc.encode(f.text), signed = unhex(f.signed), signature = unhex(f.signature);
    const k2 = f.key === hex(other) ? unhex(positives.find((x) => x.family === 'ledger')!.key) : other;
    const both = (name: string, p: boolean | string, c: boolean) => { n++; ok(G, `${f.id}: ${name}`, !accepted(p) && !c, `probe ${p}, client ${c}`); };
    both('a text byte flipped', probe(true, flip(text, 40), signature, key), client(flip(signed, SOL_HEAD_LENGTH + 40), signature, key));
    both("a byte of R flipped", probe(true, text, flip(signature, 3), key), client(signed, flip(signature, 3), key));
    both("a byte of S flipped", probe(true, text, flip(signature, 40), key), client(signed, flip(signature, 40), key));
    both('a key byte flipped', probe(true, text, signature, flip(key, 7)), client(signed, signature, flip(key, 7)));
    both('the other format (raw head, same key, same text)', probe(false, text, signature, key),
      client(f.kind === 'approval' ? solSignedMessage('raw', key, text) : solBlindSignedBytes(key, f.blindRequest!, 'raw'), signature, key));
    // a changed head: the client refuses the bytes, and the signature does
    // not verify over them; the probe, which builds the head from the key,
    // refuses the envelope naming another key
    const heads: [string, Uint8Array][] = [
      ['the signing domain with one byte changed', flip(signed, 5, 0x20)],
      ['the off-chain version 0', (() => { const b = Uint8Array.from(signed); b[16] = 0; return b; })()],
      ['two signers in the head', (() => { const b = Uint8Array.from(signed); b[17] = 2; return b; })()],
      ['an envelope naming another key', cat(signed.subarray(0, 18), k2, signed.subarray(50))],
    ];
    for (const [name, b] of heads) {
      n++;
      let shape = false;
      try { if (f.kind === 'approval') assertSolOffchainMessage(b, key); else assertOffchainHead(b, key); } catch { shape = true; }
      const p = name === 'an envelope naming another key' ? probe(true, text, signature, k2) : false;
      ok(G, `${f.id}: ${name}`, shape && !client(b, signature, key) && !accepted(p), `refused by the head check ${shape}`);
    }
  }
  ok(G, `${n} constructed negatives, ${positives.length} positives × 9 kinds`, n === positives.length * 9);
}
/** The blind requests' off-chain head check (the bytes after it are a blind
 *  request, not an approval text, so assertSolOffchainMessage does not
 *  apply): the client builds its off-chain blind bytes only through
 *  solBlindSignedMessage, which checks the same fields. */
function assertOffchainHead(b: Uint8Array, key: Uint8Array): void {
  const want = cat(Uint8Array.of(0xff, ...enc.encode('solana offchain'), 1, 1), key);
  if (!eq(b.subarray(0, 50), want)) throw new Error('not the off-chain v1 head naming the key');
}

// ── 6. The recorded off-chain v0 messages ───────────────────────────────────
{
  const G = '6 recorded negatives: off-chain v0';
  for (const f of negatives) {
    const key = unhex(f.key), text = enc.encode(f.text), signed = unhex(f.signed), signature = unhex(f.signature);
    // v0: domain (16), version 0, application domain (32), format (1),
    // signer count (1), signers (32 each), length (2, little-endian), text
    const signers = signed[16 + 1 + 32 + 1];
    const body = signed.subarray(16 + 1 + 32 + 1 + 1 + 32 * signers + 2);
    ok(G, `${f.id}: a v0 envelope of the text, whose signature is valid over its own bytes`, signed[16] === 0 && eq(body, text) && client(signed, signature, key));
    ok(G, `${f.id}: the probe refuses it in both formats`, !accepted(probe(true, text, signature, key)) && !accepted(probe(false, text, signature, key)));
    let shape = false;
    try { assertSolOffchainMessage(signed, key); } catch { shape = true; }
    ok(G, `${f.id}: the client refuses the v0 envelope, and the signature does not verify over the v1 bytes`, shape && !client(solSignedMessage('offchain', key, text), signature, key));
    const { signer } = replayDevice(f.family, key, [], signature);
    await refused(G, `${f.id}: a device answering the v1 request with its v0 signature is refused before proving`, /refused before proving/,
      () => new SolEd25519Device({ publicKey: key, blind: new Uint8Array(32), signer }).signApproval(text));
  }
}

// ── 7. Another device's signature (the wrong signer) ────────────────────────
{
  const G = '7 the wrong signer';
  const t = positives.find((x) => x.family === 'trezor' && x.operation === 'rotate_enc_key')!;
  const l = positives.find((x) => x.family === 'ledger' && x.operation === 'rotate_enc_key')!;
  for (const [exp, got] of [[t, l], [l, t]] as const) {
    const key = unhex(exp.key), text = enc.encode(exp.text);
    const { signer, asked } = replayDevice(exp.family, key, [], unhex(got.signature));
    const device = new SolEd25519Device({ publicKey: key, blind: new Uint8Array(32), signer: { ...signer, others: () => [unhex(got.key)] } });
    let err: any;
    try { await device.signApproval(text); } catch (e) { err = e; }
    ok(G, `${exp.device}'s request answered with ${got.device}'s signature: refused before proving, the signer unknown although ${got.device}'s key is offered (it does not verify over the bytes asked)`,
      err instanceof SignerMismatchError && err.signer === undefined && /signer is unknown/.test(err.message) && asked.length === 1, String(err?.message ?? err).slice(0, 160));
  }
  // control: the device's own recording passes the same check
  const key = unhex(t.key);
  const { signer } = replayDevice(t.family, key, [{ signed: unhex(t.signed), signature: unhex(t.signature) }]);
  const r = await new SolEd25519Device({ publicKey: key, blind: new Uint8Array(32), signer: { ...signer, others: () => [unhex(l.key)] } }).signApproval(enc.encode(t.text));
  ok(G, 'control: the right device passes the same check', eq(r.signature, unhex(t.signature)));
}

// ── 8. The identity key on the circuit path ─────────────────────────────────
// The Ed25519 core refuses the identity key itself, whoever calls it. The
// probe passes ed25519_verify the key's checked encoding without the
// descriptor module's A != O, so a signature made for A = O (R = [s]B, any
// message: [s]B == R + [k]O) reaches the verification equation, which holds.
{
  const G = '8 the identity key on the circuit path';
  const O = { x: 0n, y: 1n };
  const s = 0x1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a7988n;
  const R = ed25519.Point.BASE.multiply(s);
  ok(G, 'the forged signature satisfies the verification equation for A = O ([s]B == R + [k]O = R, for any k)', ed25519.Point.BASE.multiply(s).equals(R.add(ed25519.Point.ZERO)));
  const sig = { r: { x: R.toAffine().x, y: R.toAffine().y }, s };
  const h = solKeyHints(O), r = solSignatureHints(sig);
  for (const n of LENGTHS) {
    const text = new Uint8Array(n).fill(0x41);
    for (const offchain of [false, true]) {
      let res: unknown;
      try { res = (Probe.pureCircuits as any)[`probe_sol_ed25519_verify_${n}`](offchain, text, sig, O, h.pk_bytes, h.pk_x, r.r_bytes, r.r_x); } catch (e: any) { res = String(e?.message ?? e); }
      ok(G, `${n}-byte text, ${offchain ? 'off-chain' : 'raw'}: the identity key refused by the core`, res !== true && /the key is the identity/.test(String(res)),
        res === true ? 'accepted (expected a refusal)' : String(res).slice(0, 160));
    }
  }
}

// ── report ───────────────────────────────────────────────────────────────────
const failed = cases.filter((c) => c.verdict !== 'PASS');
for (const g of [...new Set(cases.map((c) => c.group))]) {
  const cs = cases.filter((c) => c.group === g);
  console.log(`  ${cs.every((c) => c.verdict === 'PASS') ? '✓' : '✗'} ${g}: ${cs.filter((c) => c.verdict === 'PASS').length}/${cs.length}`);
}
const verdict = failed.length ? 'FAIL' : 'PASS';
if (process.env.EVIDENCE_DIR) {
  fs.mkdirSync(process.env.EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.EVIDENCE_DIR, 'sol-ed25519-fixtures-offline.json'),
    JSON.stringify({ suite: 'sol-ed25519-fixtures-offline', ranAt: new Date().toISOString(), node: process.version, vectors: path.basename(FILE), cases, verdict }, null, 2) + '\n');
}
console.log(`\n◆ sol-ed25519-fixtures-offline: ${verdict} (${cases.length} cases, ${failed.length} failed)`);
process.exit(verdict === 'PASS' ? 0 : 1);
