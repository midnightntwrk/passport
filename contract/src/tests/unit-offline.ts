// Offline unit checks — no localnet required.
//
// Exercises the client-side halves of both standards against the compiled
// contract module, once per authorisation arm: the jubjub signing pipeline
// (grinding, scalar arithmetic, the Schnorr equation via the runtime's own
// curve built-ins), the k256 pipeline (scalar sampling, the digest
// signature, the ECDSA verify equation via the runtime's own curve
// built-ins), the InboxEntry v1 codec (§6.4), and the challenge domain
// separation (AUTH-3 at the hash level). The rejection matrix proper runs
// against a node (auth-conformance.ts); this file guards the
// vacuous-verifier hazard (MIP-0013 S10) cheaply on every change.
//
// The `[grant]` section is the client half of the scoped-grants MIP's
// Testing item 5: every new pure derivation of that MIP's sections 4.3 to
// 4.5 and 6.3 recomputed by hand with node:crypto SHA-256 over the
// published byte recipe and compared bit-exactly against the compiled
// circuit, over pinned fixtures, with the vectors written out for the Rust
// signer. Nothing in that section imports a hash from the contract module;
// the compiled circuits are the thing under test.

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  ecAdd,
  ecMul,
  ecMulGenerator,
  SECP256K1_SCALAR_MODULUS,
  secp256k1Add,
  secp256k1Mul,
  secp256k1MulGenerator,
  secp256k1PointX,
  secp256k1ScalarInv,
  secp256k1ScalarMul,
} from '@midnight-ntwrk/compact-runtime';

import { runScenario, step } from './runner.js';
import { pureCircuits } from '../wallet/contract.js';
import {
  JubjubDevice,
  K256Device,
  jubjubChallenges,
  k256Challenges,
  JUBJUB_R,
  SECP256K1_N,
  bytesToBigIntLE,
  type CallContext,
  K256_ENVELOPE_CONNECTOR,
  K256_ENVELOPE_NONE,
} from '../wallet/signer.js';
import { generateEncKeyPair, sealInboxEntry, openInboxEntry, ENTRY_SIZE } from '../wallet/inbox.js';
import { bytesToHex } from '../wallet/hex.js';

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`assertion failed: ${label}`);
  console.log(`  ✓ ${label}`);
}

// S10: point equality must be structural, never object identity.
const pointsEqual = (a: { x: bigint; y: bigint }, b: { x: bigint; y: bigint }) =>
  a.x === b.x && a.y === b.y;

/** Big-endian integer interpretation of the 32-byte challenge — the
 *  in-circuit secp256k1EcdsaVerify's reading of its message. */
function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let r = 0n;
  for (const b of bytes) r = (r << 8n) | BigInt(b);
  return r;
}

/** Noble's encodings for the independent-stack ECDSA verification. */
const noblePkBytes = (pk: { x: bigint; y: bigint }) =>
  secp256k1.Point.fromAffine({ x: pk.x, y: pk.y }).toBytes(false);
const nobleSigBytes = (sig: { r: bigint; s: bigint }) =>
  new secp256k1.Signature(sig.r, sig.s).toBytes('compact');
const nobleVerify = (sig: { r: bigint; s: bigint }, digest: Uint8Array, pk: { x: bigint; y: bigint }) =>
  secp256k1.verify(nobleSigBytes(sig), digest, noblePkBytes(pk), { prehash: false, lowS: false });

// ── The scoped-grants byte recipe, by hand ───────────────────────────────────
//
// One helper per element shape of that MIP's notation, and nothing else:
// SHA-256 over a concatenation of fixed-width elements, integers
// little-endian at their Compact width, a Boolean as a single byte, an
// affine curve coordinate as a 32-byte little-endian integer, and a tag as
// its ASCII bytes zero-padded on the right to the stated width. These are
// deliberately independent of the wallet library and of the contract
// module.

const sha256 = (...parts: Uint8Array[]): Uint8Array => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};

const ascii = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'ascii'));

/** `pad(width, tag)`: the tag's ASCII bytes, zero-padded on the right. */
const padTag = (width: number, tag: string): Uint8Array => {
  const b = ascii(tag);
  if (b.length > width) throw new Error(`tag exceeds pad width ${width}: ${tag}`);
  const out = new Uint8Array(width);
  out.set(b);
  return out;
};

/** A Uint<8 * width> as its little-endian bytes. */
const le = (value: bigint, width: number): Uint8Array => {
  let v = value;
  if (v < 0n) throw new Error(`negative value: ${value}`);
  const out = new Uint8Array(width);
  for (let i = 0; i < width; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error(`value ${value} exceeds ${width} bytes`);
  return out;
};

const u8 = (v: bigint): Uint8Array => le(v, 1);
const u64 = (v: bigint): Uint8Array => le(v, 8);
const u128 = (v: bigint): Uint8Array => le(v, 16);
/** An affine coordinate or a Field atom: 32 bytes little-endian. */
const fe = (v: bigint): Uint8Array => le(v, 32);
/** `flag(b)`: a Boolean's one-byte atom. */
const flag = (b: boolean): Uint8Array => new Uint8Array([b ? 1 : 0]);

const concat = (parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/** A per-twin DST: hashed from a 64-byte pad (the authorisation MIP's
 *  amended §5.1). */
const dstOf = (tag: string): Uint8Array => sha256(padTag(64, tag));

/** A pinned cross-implementation vector, as written to
 *  `src/tests/vectors/grants-e1.json` for the Rust signer. */
interface GrantVector {
  name: string;
  circuit: string;
  section: string;
  args: Record<string, unknown>;
  preimage: string;
  preimage_len: number;
  digest: string;
}

/** Rolling-entry properties, identical for every arm (§3, AUTH-9). */
function entryChecks(arm: string, device: JubjubDevice | K256Device, other: JubjubDevice | K256Device): void {
  const accountAddr = new Uint8Array(randomBytes(32));
  const e0 = device.entryAt(accountAddr, 0n, 0n);
  assert(e0.length === 32, `[${arm}] device entry is 32 bytes`);
  assert(
    Buffer.from(e0).equals(Buffer.from(device.entryAt(accountAddr, 0n, 0n))),
    `[${arm}] entry deterministic`,
  );
  assert(
    !Buffer.from(e0).equals(Buffer.from(other.entryAt(accountAddr, 0n, 0n))),
    `[${arm}] distinct keys give distinct entries`,
  );
  assert(
    !Buffer.from(e0).equals(Buffer.from(device.entryAt(accountAddr, 0n, 1n))),
    `[${arm}] the use counter rolls the entry (single-use, AUTH-9)`,
  );
  assert(
    !Buffer.from(e0).equals(Buffer.from(device.entryAt(accountAddr, 1n, 0n))),
    `[${arm}] an epoch bump invalidates every prior entry (AUTH-6)`,
  );
  assert(
    !Buffer.from(e0).equals(Buffer.from(device.entryAt(new Uint8Array(randomBytes(32)), 0n, 0n))),
    `[${arm}] entries for one key are unequal across accounts`,
  );
}

await runScenario('unit-offline', async () => {
  const ctx: CallContext = { contractAddress: new Uint8Array(randomBytes(32)), authNonce: 0n };
  const color = new Uint8Array(32);
  const recipient = new Uint8Array(randomBytes(32));

  // ── Arm jubjub ─────────────────────────────────────────────────────────────

  step('[jubjub] device keys and rolling entries (MIP-0013 §1, §3, AUTH-9)');
  const jDevice = JubjubDevice.generate();
  const jOther = JubjubDevice.generate();
  assert(jDevice.sk > 0n && jDevice.sk < JUBJUB_R, '[jubjub] sk in [1, r_J)');
  entryChecks('jubjub', jDevice, jOther);

  step('[jubjub] signing pipeline: grinding and the Schnorr equation (§5)');
  const builder = jubjubChallenges.withdrawUnshielded(ctx, jDevice.pk, color, 100n, recipient);
  const jAuth = jDevice.sign(builder, 0n);
  const jH = builder(jAuth.sig_r, jAuth.grind_nonce);
  const c = bytesToBigIntLE(jH);
  assert(c < JUBJUB_R, '[jubjub] ground challenge below r_J (§5.2)');
  assert(jAuth.sig_s < JUBJUB_R, '[jubjub] s in scalar domain');
  assert(
    Buffer.from(jH).equals(Buffer.from(builder(jAuth.sig_r, jAuth.grind_nonce))),
    '[jubjub] challenge deterministic',
  );
  const lhs = ecMulGenerator(jAuth.sig_s);
  const rhs = ecAdd(jAuth.sig_r, ecMul(jDevice.pk, c));
  assert(pointsEqual(lhs, rhs), '[jubjub] s·G == R + c·pk (the §4 equation, off-circuit)');
  assert(
    !pointsEqual(lhs, ecAdd(jAuth.sig_r, ecMul(jOther.pk, c))),
    '[jubjub] equation fails for a different pk (non-vacuous verifier, S10)',
  );
  const cBad = (c + 1n) % JUBJUB_R;
  assert(
    !pointsEqual(lhs, ecAdd(jAuth.sig_r, ecMul(jDevice.pk, cBad))),
    '[jubjub] equation fails for a tampered challenge',
  );

  step('[jubjub] challenge domain separation (AUTH-3) and witness binding (AUTH-10)');
  const witnessCoin = { nonce: new Uint8Array(randomBytes(32)), color, value: 100n, mt_index: 7n };
  const shieldedBuilder = jubjubChallenges.withdrawShielded(ctx, jDevice.pk, recipient, color, 100n, witnessCoin);
  const toContractBuilder = jubjubChallenges.withdrawShieldedToContract(ctx, jDevice.pk, recipient, color, 100n, witnessCoin);
  assert(
    !Buffer.from(shieldedBuilder(jAuth.sig_r, jAuth.grind_nonce)).equals(
      Buffer.from(toContractBuilder(jAuth.sig_r, jAuth.grind_nonce)),
    ),
    '[jubjub] per-circuit tags separate identical argument lists',
  );
  const otherCoin = { ...witnessCoin, mt_index: 8n };
  assert(
    !Buffer.from(shieldedBuilder(jAuth.sig_r, jAuth.grind_nonce)).equals(
      Buffer.from(
        jubjubChallenges.withdrawShielded(ctx, jDevice.pk, recipient, color, 100n, otherCoin)(
          jAuth.sig_r,
          jAuth.grind_nonce,
        ),
      ),
    ),
    '[jubjub] the witness values pin the private state (AUTH-10): a different coin, a different challenge',
  );
  const otherAccount: CallContext = { ...ctx, contractAddress: new Uint8Array(randomBytes(32)) };
  assert(
    !Buffer.from(jH).equals(
      Buffer.from(
        jubjubChallenges.withdrawUnshielded(otherAccount, jDevice.pk, color, 100n, recipient)(
          jAuth.sig_r,
          jAuth.grind_nonce,
        ),
      ),
    ),
    '[jubjub] account address separates challenges across accounts',
  );
  const laterNonce: CallContext = { ...ctx, authNonce: 1n };
  assert(
    !Buffer.from(jH).equals(
      Buffer.from(
        jubjubChallenges.withdrawUnshielded(laterNonce, jDevice.pk, color, 100n, recipient)(
          jAuth.sig_r,
          jAuth.grind_nonce,
        ),
      ),
    ),
    '[jubjub] auth_nonce separates challenges across calls (AUTH-2)',
  );

  // ── Arm k256 ───────────────────────────────────────────────────────────────

  step('[k256] device keys and rolling entries (§3, AUTH-9)');
  assert(SECP256K1_N === SECP256K1_SCALAR_MODULUS, '[k256] signer n matches the runtime curve order');
  const kDevice = K256Device.generate();
  const kOther = K256Device.generate();
  assert(kDevice.sk > 0n && kDevice.sk < SECP256K1_N, '[k256] sk in [1, n)');
  assert(kDevice.pk.identity === false, '[k256] pk is a real point, never the identity');
  entryChecks('k256', kDevice, kOther);

  // The co-residency invariant: one device set, two arms, kept disjoint only
  // by the arm marker in each derivation's DST. Distinct keys give distinct
  // entries trivially, so the property has to be tested where it could
  // actually collide — the SAME coordinates presented to both derivations.
  // JubJub's field modulus is below secp256k1's p, so a JubJub point's
  // coordinates are always numerically admissible as a k256 point's.
  step('[both arms] the arm marker keeps the shared device set disjoint');
  {
    const addr = new Uint8Array(randomBytes(32));
    const { x, y } = jDevice.pk;
    const asJubjub = pureCircuits.derive_device_entry_with_jubjub(
      { bytes: addr }, { x, y }, 0n, 0n,
    );
    const asK256 = pureCircuits.derive_device_entry_with_k256(
      { bytes: addr }, { x, y, identity: false }, K256_ENVELOPE_NONE, 0n, 0n,
    );
    assert(
      !Buffer.from(asJubjub).equals(Buffer.from(asK256)),
      '[both arms] identical coordinates derive different entries under each arm',
    );
    const bootJ = pureCircuits.derive_boot_commitment_with_jubjub(addr, { x, y });
    const bootK = pureCircuits.derive_boot_commitment_with_k256(addr, { x, y, identity: false }, K256_ENVELOPE_NONE);
    assert(
      !Buffer.from(bootJ).equals(Buffer.from(bootK)),
      '[both arms] the boot commitment is arm-marked, so only one arm can activate',
    );
  }

  step('[k256] signing pipeline: ECDSA over the envelope digest (envelope 0)');
  const kH = k256Challenges.withdrawUnshielded(ctx, kDevice.pk, color, 100n, recipient);
  const kAuth = kDevice.sign(kH, 0n);
  // The signature covers the envelope digest, never the challenge itself.
  // Envelope 0 has no prefix: the digest is plain SHA-256 of the challenge
  // bytes, which is what ordinary ECDSA-SHA256 over the challenge as a
  // message computes.
  const kDigest = kDevice.signedDigest(kH);
  assert(kAuth.envelope === K256_ENVELOPE_NONE, '[k256] the authorisation carries envelope 0');
  assert(
    Buffer.from(kDigest).equals(createHash('sha256').update(Buffer.from(kH)).digest()),
    '[k256] envelope_digest(0, h) == SHA-256(h), recomputed independently',
  );
  assert(
    !nobleVerify(kAuth.sig, kH, kDevice.pk),
    '[k256] the signature does NOT verify over the raw challenge (no prehash mode exists)',
  );
  assert(kAuth.sig.r > 0n && kAuth.sig.r < SECP256K1_N, '[k256] r in [1, n)');
  assert(kAuth.sig.s > 0n && kAuth.sig.s < SECP256K1_N, '[k256] s in [1, n)');
  assert(kAuth.sig.s <= SECP256K1_N >> 1n, '[k256] signer emits low-S (the circuit accepts both forms)');
  assert(
    Buffer.from(kH).equals(Buffer.from(k256Challenges.withdrawUnshielded(ctx, kDevice.pk, color, 100n, recipient))),
    '[k256] challenge deterministic',
  );
  assert(nobleVerify(kAuth.sig, kDigest, kDevice.pk), '[k256] signature verifies on an independent stack (noble)');
  // Replicate the in-circuit verify with the runtime's own curve built-ins
  // (the same functions the generated verifier calls): z = BE(digest)
  // mod n, w = s⁻¹, then x(z·w·G + r·w·pk) mod n == r.
  const z = bytesToBigIntBE(kDigest) % SECP256K1_N;
  const w = secp256k1ScalarInv(kAuth.sig.s);
  const point = secp256k1Add(
    secp256k1MulGenerator(secp256k1ScalarMul(z, w)),
    secp256k1Mul(kDevice.pk, secp256k1ScalarMul(kAuth.sig.r, w)),
  );
  assert(
    secp256k1PointX(point) % SECP256K1_N === kAuth.sig.r,
    '[k256] x(u1·G + u2·pk) mod n == r (the verify equation, off-circuit)',
  );
  assert(
    !nobleVerify(kAuth.sig, kDigest, kOther.pk),
    '[k256] verification fails for a different pk (non-vacuous verifier, S10)',
  );
  const hBad = new Uint8Array(kDigest);
  hBad[0] ^= 0x01;
  assert(!nobleVerify(kAuth.sig, hBad, kDevice.pk), '[k256] verification fails for a tampered digest');
  assert(
    !nobleVerify({ r: kAuth.sig.r, s: (kAuth.sig.s + 1n) % SECP256K1_N }, kDigest, kDevice.pk),
    '[k256] verification fails for a tampered s',
  );
  // Malleability, deliberately accepted (see the contract header): the
  // high-S twin (r, n − s) authorises the same challenge; replay is dead
  // regardless because the device entry is consumed (AUTH-9) and
  // auth_nonce advances (AUTH-8).
  assert(
    nobleVerify({ r: kAuth.sig.r, s: SECP256K1_N - kAuth.sig.s }, kDigest, kDevice.pk),
    '[k256] the high-S twin verifies too (accepted; replay-dead via AUTH-8/9)',
  );

  step('[k256/connector] envelope 1: the connector signData digest; envelopes are enrolled, not chosen');
  // A connector device: its key sits behind the connector's `signData`
  // surface (the `ecdsa_secp256k1_sha256` scheme), which signs the
  // mandatory envelope digest SHA-256("midnight_signed_message:32:" || data)
  // and never the data itself.
  const cDevice = K256Device.generateConnector();
  const cH = k256Challenges.withdrawUnshielded(ctx, cDevice.pk, color, 100n, recipient);
  const envelopePrefix = Buffer.from('midnight_signed_message:32:', 'utf8');
  const envelopeByHand = createHash('sha256')
    .update(Buffer.concat([envelopePrefix, Buffer.from(cH)]))
    .digest();
  const envelopeViaCircuit = pureCircuits.envelope_digest(K256_ENVELOPE_CONNECTOR, cH);
  assert(
    Buffer.from(envelopeViaCircuit).equals(envelopeByHand),
    '[k256/connector] envelope_digest(1, h) == SHA-256(prefix || h), recomputed independently',
  );
  const cAuth = cDevice.sign(cH, 0n);
  assert(cAuth.envelope === K256_ENVELOPE_CONNECTOR, '[k256/connector] the authorisation carries envelope 1');
  assert(
    nobleVerify(cAuth.sig, envelopeViaCircuit, cDevice.pk),
    '[k256/connector] the signature verifies over the connector envelope digest (independent stack)',
  );
  assert(
    !nobleVerify(cAuth.sig, pureCircuits.envelope_digest(K256_ENVELOPE_NONE, cH), cDevice.pk),
    '[k256/connector] the same signature does NOT verify under envelope 0 (envelopes cannot alias)',
  );
  // The envelope is part of the enrolled identity: the same key derives
  // disjoint entries and boot commitments under each envelope, so a device
  // can never be driven under an envelope it was not enrolled with.
  const noneTwin = new K256Device(cDevice.sk, K256_ENVELOPE_NONE);
  const envAddr = new Uint8Array(randomBytes(32));
  assert(
    !Buffer.from(cDevice.entryAt(envAddr, 0n, 0n)).equals(
      Buffer.from(noneTwin.entryAt(envAddr, 0n, 0n)),
    ),
    '[k256/connector] entries are disjoint across envelopes for the same key',
  );
  assert(
    !Buffer.from(cDevice.bootCommitment(envAddr)).equals(
      Buffer.from(noneTwin.bootCommitment(envAddr)),
    ),
    '[k256/connector] boot commitments are envelope-marked too',
  );
  // Unknown envelope ids abort the pure circuit.
  let unknownAborted = false;
  try { pureCircuits.envelope_digest(2n, cH); } catch { unknownAborted = true; }
  assert(unknownAborted, '[k256] envelope_digest aborts on an unknown envelope id');

  step('[k256] v2 derivation vectors (pinned; shared with signer-rs, recomputed with hashlib)');
  // sk = 1 (pk = G), self = 0x11*32, salt = 0x22*32, epoch 0, counter 0.
  // Preimages: entry = DST32 || self || x_le || y_le || envelope(1) || epoch(4) || counter(8);
  //            boot  = DST32 || salt || x_le || y_le || envelope(1).
  const gPk = pureCircuits.compute_public_point_with_k256(1n);
  const pinAddr = new Uint8Array(32).fill(0x11);
  const pinSalt = new Uint8Array(32).fill(0x22);
  const pins = [
    [K256_ENVELOPE_NONE,
      'f88e6a3085478879ae9e3859c59493a60b2d443c1608f6bcedbdb7ee1a8f5d66',
      'bec19e88c6ea0afb279841ca7bfca1aa50a0c046cfff30ea29c819b41d564e63'],
    [K256_ENVELOPE_CONNECTOR,
      'ae28feb6281f2e2f9d9a0fcda699bb2b3e349d1f20eff7b578afb489b3115d51',
      '14697f9fb98a39cf19fae28e53dd556109237ae719599198937988939f75463b'],
  ] as const;
  for (const [env, entryHex, bootHex] of pins) {
    assert(
      Buffer.from(pureCircuits.derive_device_entry_with_k256({ bytes: pinAddr }, gPk, env, 0n, 0n)).toString('hex') === entryHex,
      `[k256] derive_device_entry_with_k256 v2 vector, envelope ${env}`,
    );
    assert(
      Buffer.from(pureCircuits.derive_boot_commitment_with_k256(pinSalt, gPk, env)).toString('hex') === bootHex,
      `[k256] derive_boot_commitment_with_k256 v2 vector, envelope ${env}`,
    );
  }

  step('[k256] challenge domain separation (AUTH-3) and witness binding (AUTH-10)');
  const kShieldedH = k256Challenges.withdrawShielded(ctx, kDevice.pk, recipient, color, 100n, witnessCoin);
  const kToContractH = k256Challenges.withdrawShieldedToContract(ctx, kDevice.pk, recipient, color, 100n, witnessCoin);
  assert(
    !Buffer.from(kShieldedH).equals(Buffer.from(kToContractH)),
    '[k256] per-circuit tags separate identical argument lists',
  );
  assert(
    !Buffer.from(kShieldedH).equals(
      Buffer.from(k256Challenges.withdrawShielded(ctx, kDevice.pk, recipient, color, 100n, otherCoin)),
    ),
    '[k256] the witness values pin the private state (AUTH-10): a different coin, a different challenge',
  );
  assert(
    !Buffer.from(kH).equals(
      Buffer.from(k256Challenges.withdrawUnshielded(otherAccount, kDevice.pk, color, 100n, recipient)),
    ),
    '[k256] account address separates challenges across accounts',
  );
  assert(
    !Buffer.from(kH).equals(
      Buffer.from(k256Challenges.withdrawUnshielded(laterNonce, kDevice.pk, color, 100n, recipient)),
    ),
    '[k256] auth_nonce separates challenges across calls (AUTH-2)',
  );
  assert(
    !Buffer.from(kH).equals(
      Buffer.from(k256Challenges.withdrawUnshielded(ctx, kOther.pk, color, 100n, recipient)),
    ),
    '[k256] the signing key is bound into the challenge (pk coordinate bytes)',
  );

  // ── Scoped grants ──────────────────────────────────────────────────────────
  //
  // Fixed fixtures throughout: pk = G on either curve (sk = 1), the account
  // address 0x11 repeated 32 times, scope_salt 0x22 repeated 32 times, slots
  // 0 and 1, and the origin_hash of "https://bank.example". Every expected
  // value is a hand-built preimage hashed with node:crypto, so a disagreement
  // is a disagreement between the compiled circuit and the published recipe,
  // not between two spellings of the same helper.
  {
    const vectors: GrantVector[] = [];
    const gSelfBytes = new Uint8Array(32).fill(0x11);
    const gSelf = { bytes: gSelfBytes };
    const gSalt = new Uint8Array(32).fill(0x22);
    const gColor = new Uint8Array(32).fill(0x33);
    const gUserAddr = new Uint8Array(32).fill(0x44);
    const gZswapPk = new Uint8Array(32).fill(0x55);
    const gContract = new Uint8Array(32).fill(0x66);
    const gCoinNonce = new Uint8Array(32).fill(0x77);
    const gEncPk = new Uint8Array(32).fill(0x88);
    const gReadPkHash = new Uint8Array(32).fill(0x99);
    const gChangeEntry = Uint8Array.from({ length: 192 }, (_, i) => i & 0xff);
    const gZero = new Uint8Array(32);
    const gOrigin = 'https://bank.example';
    // §4.4: computed off-chain, from a 32-byte pad and the normalised
    // client_id bytes. It is a private argument of the twins and of nothing
    // else, so no circuit exports it.
    const gOriginHash = sha256(padTag(32, 'midnight:account:grant:origin:v1'), ascii(gOrigin));
    // §4.2: H(host(client_id)) for an r1 grantee, zero for every other arm.
    const gRpIdHash = sha256(ascii('bank.example'));

    const gPkK256 = pureCircuits.compute_public_point_with_k256(1n);
    const gPkJubjub = pureCircuits.compute_public_point_with_jubjub(1n);
    // The k256 key element, as the arm's device entries bind it.
    const kx = fe(gPkK256.x);
    const ky = fe(gPkK256.y);

    /** Compare a compiled pure circuit against the hand-built preimage, and
     *  pin the pair as a cross-implementation vector. */
    const pin = (
      name: string,
      circuit: string,
      section: string,
      args: Record<string, unknown>,
      got: Uint8Array,
      preimage: Uint8Array[],
    ): Uint8Array => {
      const flat = concat(preimage);
      const want = sha256(flat);
      assert(
        Buffer.from(got).equals(Buffer.from(want)),
        `[grant] ${circuit} ${name} == SHA-256 of the §${section} preimage (${flat.length} bytes)`,
      );
      vectors.push({
        name, circuit, section, args,
        preimage: bytesToHex(flat),
        preimage_len: flat.length,
        digest: bytesToHex(got),
      });
      return got;
    };

    step('[grant] grant identity, both k1 envelopes and the v1 arm (§4.3)');
    const idTagK1 = padTag(32, 'midnight:account:grant:id:k1:v1');
    const grantIds: Record<string, Uint8Array> = {};
    for (const envelope of [K256_ENVELOPE_NONE, K256_ENVELOPE_CONNECTOR]) {
      for (const slot of [0n, 1n]) {
        const name = `k1_envelope${envelope}_slot${slot}`;
        grantIds[name] = pin(
          name, 'derive_grant_id_with_k256', '4.3',
          {
            self: bytesToHex(gSelfBytes), pk_x: bytesToHex(kx), pk_y: bytesToHex(ky),
            envelope: Number(envelope), origin_hash: bytesToHex(gOriginHash), slot: Number(slot),
          },
          pureCircuits.derive_grant_id_with_k256(gSelf, gPkK256, envelope, gOriginHash, slot),
          [idTagK1, gSelfBytes, kx, ky, u8(envelope), gOriginHash, u8(slot)],
        );
      }
    }
    // The v1 element width is the one place the compiled encoding contradicts
    // the MIP's table: a JubjubPoint in a persistentHash tuple is two Field
    // atoms, x then y, so the preimage is 161 bytes and not the 129 the MIP
    // states. Recorded as a mismatch; the recipe is not bent to match the
    // circuit here, the 64-byte element is simply what the circuit computes.
    const idTagV1 = padTag(32, 'midnight:account:grant:id:v1');
    const jx = fe(gPkJubjub.x);
    const jy = fe(gPkJubjub.y);
    for (const slot of [0n, 1n]) {
      const name = `v1_slot${slot}`;
      grantIds[name] = pin(
        name, 'derive_grant_id_with_jubjub', '4.3',
        {
          self: bytesToHex(gSelfBytes), pk_x: bytesToHex(jx), pk_y: bytesToHex(jy),
          origin_hash: bytesToHex(gOriginHash), slot: Number(slot),
          note: 'the JubjubPoint element is x_le32 || y_le32, so 64 bytes, not 32',
        },
        pureCircuits.derive_grant_id_with_jubjub(gSelf, gPkJubjub, gOriginHash, slot),
        [idTagV1, gSelfBytes, jx, jy, gOriginHash, u8(slot)],
      );
    }
    assert(
      !Buffer.from(grantIds.k1_envelope0_slot0).equals(Buffer.from(grantIds.k1_envelope1_slot0)),
      '[grant] the envelope separates ids of one key at one origin (GR-3)',
    );
    assert(
      !Buffer.from(grantIds.k1_envelope0_slot0).equals(Buffer.from(grantIds.k1_envelope0_slot1)),
      '[grant] the slot separates ids of one key at one origin (GR-3)',
    );
    assert(
      !Buffer.from(grantIds.k1_envelope0_slot0).equals(Buffer.from(grantIds.v1_slot0)),
      '[grant] the arm marker separates ids across arms (GR-3)',
    );

    step('[grant] the three commitments, one recipient projection per kind (§4.5)');
    const objTag = padTag(32, 'midnight:account:grant:obj:v1');
    const kinds: [bigint, Uint8Array, string][] = [
      [0n, gZero, 'any'],
      [1n, gUserAddr, 'user_address'],
      [2n, gZswapPk, 'zswap_coin_public_key'],
      [3n, gContract, 'contract_address'],
    ];
    for (const [kind, pinned, label] of kinds) {
      pin(
        `kind${kind}_${label}`, 'derive_grant_object_commit', '4.5',
        {
          scope_salt: bytesToHex(gSalt), color: bytesToHex(gColor),
          recipient_kind: Number(kind), recipient: bytesToHex(pinned),
          max_coin_value: '5000000',
        },
        pureCircuits.derive_grant_object_commit(gSalt, gColor, kind, pinned, 5_000_000n),
        [objTag, gSalt, gColor, u8(kind), pinned, u128(5_000_000n)],
      );
    }
    // Issue rule 7: a read-only grant's object fields are all zero, so its
    // object_commit is determined by scope_salt alone.
    pin(
      'read_only', 'derive_grant_object_commit', '4.5',
      {
        scope_salt: bytesToHex(gSalt), color: bytesToHex(gZero),
        recipient_kind: 0, recipient: bytesToHex(gZero), max_coin_value: '0',
        note: 'issue rule 7: all object fields zero',
      },
      pureCircuits.derive_grant_object_commit(gSalt, gZero, 0n, gZero, 0n),
      [objTag, gSalt, gZero, u8(0n), gZero, u128(0n)],
    );

    const spentTag = padTag(32, 'midnight:account:grant:spent:v1');
    const u128Max = (1n << 128n) - 1n;
    for (const spent of [0n, 200n, u128Max]) {
      pin(
        `spent${spent === u128Max ? '_u128_max' : spent}`, 'derive_grant_spent_commit', '4.5',
        { scope_salt: bytesToHex(gSalt), spent: spent.toString() },
        pureCircuits.derive_grant_spent_commit(gSalt, spent),
        [spentTag, gSalt, u128(spent)],
      );
    }

    const rpTag = padTag(32, 'midnight:account:grant:rp:v1');
    pin(
      'r1_grantee', 'derive_grant_rp_commit', '4.5',
      { scope_salt: bytesToHex(gSalt), rp_id_hash: bytesToHex(gRpIdHash), note: 'SHA-256("bank.example")' },
      pureCircuits.derive_grant_rp_commit(gSalt, gRpIdHash),
      [rpTag, gSalt, gRpIdHash],
    );
    pin(
      'non_r1_grantee', 'derive_grant_rp_commit', '4.5',
      { scope_salt: bytesToHex(gSalt), rp_id_hash: bytesToHex(gZero), note: 'zero for every non-r1 arm' },
      pureCircuits.derive_grant_rp_commit(gSalt, gZero),
      [rpTag, gSalt, gZero],
    );

    step('[grant] the seventeen-element scope digest, flags as single bytes (§4.5)');
    const scopeTag = padTag(32, 'midnight:account:grant:scope:v1');
    /** One plaintext scope, in the §4.2 argument order. */
    interface Scope {
      opU: boolean; opS: boolean; opSC: boolean; read: boolean;
      color: Uint8Array; kind: bigint; recipient: Uint8Array;
      maxCoin: bigint; perCall: bigint; cap: bigint; expiresAt: bigint;
      rpIdHash: Uint8Array; readPkHash: Uint8Array;
    }
    const scopeDigestOf = (name: string, s: Scope): Uint8Array => pin(
      name, 'derive_grant_scope_digest', '4.5',
      {
        scope_salt: bytesToHex(gSalt),
        op_withdraw_unshielded: s.opU, op_withdraw_shielded: s.opS,
        op_withdraw_shielded_to_contract: s.opSC, read: s.read,
        color: bytesToHex(s.color), recipient_kind: Number(s.kind),
        recipient: bytesToHex(s.recipient), max_coin_value: s.maxCoin.toString(),
        per_call_cap: s.perCall.toString(), cap: s.cap.toString(),
        expires_at: s.expiresAt.toString(), rp_id_hash: bytesToHex(s.rpIdHash),
        read_pk_hash: bytesToHex(s.readPkHash), window_len: '0', window_cap: '0',
      },
      pureCircuits.derive_grant_scope_digest(
        gSalt, s.opU, s.opS, s.opSC, s.read, s.color, s.kind, s.recipient,
        s.maxCoin, s.perCall, s.cap, s.expiresAt, s.rpIdHash, s.readPkHash, 0n, 0n,
      ),
      [
        scopeTag, gSalt, flag(s.opU), flag(s.opS), flag(s.opSC), flag(s.read),
        s.color, u8(s.kind), s.recipient, u128(s.maxCoin), u128(s.perCall),
        u128(s.cap), u64(s.expiresAt), s.rpIdHash, s.readPkHash, u64(0n), u128(0n),
      ],
    );
    const spendScope: Scope = {
      opU: true, opS: false, opSC: false, read: true,
      color: gColor, kind: 1n, recipient: gUserAddr,
      maxCoin: 5_000_000n, perCall: 1_000n, cap: 450n, expiresAt: 1_800_000_000n,
      rpIdHash: gZero, readPkHash: gReadPkHash,
    };
    const scopeDigest = scopeDigestOf('unshielded_and_read', spendScope);
    scopeDigestOf('shielded_and_read', {
      ...spendScope, opU: false, opS: true, opSC: true, kind: 2n, recipient: gZswapPk,
    });
    scopeDigestOf('read_only', {
      opU: false, opS: false, opSC: false, read: true,
      color: gZero, kind: 0n, recipient: gZero,
      maxCoin: 0n, perCall: 0n, cap: 0n, expiresAt: 0n,
      rpIdHash: gRpIdHash, readPkHash: gReadPkHash,
    });
    scopeDigestOf('all_flags_and_u128_bounds', {
      opU: true, opS: true, opSC: true, read: true,
      color: gColor, kind: 3n, recipient: gContract,
      maxCoin: u128Max, perCall: u128Max, cap: u128Max,
      expiresAt: (1n << 64n) - 1n, rpIdHash: gRpIdHash, readPkHash: gReadPkHash,
    });
    // The flag bytes are load-bearing: four Booleans in four positions must
    // give sixteen distinct digests, which is what makes scope_digest bind
    // the operation axis (GR-16).
    {
      const seen = new Set<string>();
      for (let bits = 0; bits < 16; bits++) {
        const d = pureCircuits.derive_grant_scope_digest(
          gSalt, (bits & 1) !== 0, (bits & 2) !== 0, (bits & 4) !== 0, (bits & 8) !== 0,
          gColor, 1n, gUserAddr, 5_000_000n, 1_000n, 450n, 1_800_000_000n, gZero, gReadPkHash, 0n, 0n,
        );
        seen.add(bytesToHex(d));
      }
      assert(seen.size === 16, '[grant] each of the sixteen flag patterns gives its own scope digest');
    }

    step('[grant] the k256 grant-twin challenges (§6.3) and the lifecycle challenges (§6.1)');
    const gid = grantIds.k1_envelope0_slot0;
    const gidOther = grantIds.k1_envelope0_slot1;
    const issuedAt = 1n;
    const gAmount = 200n;
    const dstUnshielded = dstOf('midnight:account:grant:auth:k1:v1:withdraw_unshielded');
    const hUnshielded = pin(
      'pinned', 'challenge_withdraw_unshielded_with_grant_k256', '6.3',
      {
        self: bytesToHex(gSelfBytes), pk_x: bytesToHex(kx), pk_y: bytesToHex(ky),
        grant_id: bytesToHex(gid), issued_at: issuedAt.toString(),
        color: bytesToHex(gColor), amount: gAmount.toString(),
        recipient: bytesToHex(gUserAddr), nonce: '0',
        dst_tag: 'midnight:account:grant:auth:k1:v1:withdraw_unshielded',
      },
      pureCircuits.challenge_withdraw_unshielded_with_grant_k256(
        gSelf, gPkK256, gid, issuedAt, gColor, gAmount, { bytes: gUserAddr }, 0n,
      ),
      [dstUnshielded, gSelfBytes, kx, ky, gid, u64(issuedAt), gColor, u128(gAmount), gUserAddr, u64(0n)],
    );
    // AUTH-10 on the shielded twin: the qualified coin held_coin returns is
    // flattened element by element, nonce, color, u128 value, u64 mt_index.
    const gCoin = { nonce: gCoinNonce, color: gColor, value: 4_000n, mt_index: 17n };
    const dstShielded = dstOf('midnight:account:grant:auth:k1:v1:withdraw_shielded');
    pin(
      'pinned', 'challenge_withdraw_shielded_with_grant_k256', '6.3',
      {
        self: bytesToHex(gSelfBytes), pk_x: bytesToHex(kx), pk_y: bytesToHex(ky),
        grant_id: bytesToHex(gid), issued_at: issuedAt.toString(),
        recipient: bytesToHex(gZswapPk), color: bytesToHex(gColor),
        amount: gAmount.toString(), change_entry: bytesToHex(gChangeEntry),
        enc_pk: bytesToHex(gEncPk),
        coin: {
          nonce: bytesToHex(gCoin.nonce), color: bytesToHex(gCoin.color),
          value: gCoin.value.toString(), mt_index: gCoin.mt_index.toString(),
        },
        nonce: '1',
        dst_tag: 'midnight:account:grant:auth:k1:v1:withdraw_shielded',
      },
      pureCircuits.challenge_withdraw_shielded_with_grant_k256(
        gSelf, gPkK256, gid, issuedAt, { bytes: gZswapPk }, gColor, gAmount,
        gChangeEntry, gEncPk, gCoin, 1n,
      ),
      [
        dstShielded, gSelfBytes, kx, ky, gid, u64(issuedAt), gZswapPk, gColor,
        u128(gAmount), gChangeEntry, gEncPk,
        gCoin.nonce, gCoin.color, u128(gCoin.value), u64(gCoin.mt_index), u64(1n),
      ],
    );
    pin(
      'pinned', 'challenge_issue_grant_with_k256', '6.1',
      {
        self: bytesToHex(gSelfBytes), pk_x: bytesToHex(kx), pk_y: bytesToHex(ky),
        grant_id: bytesToHex(gid), scope_digest: bytesToHex(scopeDigest), auth_nonce: '1',
        dst_tag: 'midnight:account:auth:k1:v1:issue_grant',
      },
      pureCircuits.challenge_issue_grant_with_k256(gSelf, gPkK256, gid, scopeDigest, 1n),
      [dstOf('midnight:account:auth:k1:v1:issue_grant'), gSelfBytes, kx, ky, gid, scopeDigest, u64(1n)],
    );
    pin(
      'pinned', 'challenge_revoke_grant_with_k256', '6.1',
      {
        self: bytesToHex(gSelfBytes), pk_x: bytesToHex(kx), pk_y: bytesToHex(ky),
        grant_id: bytesToHex(gid), auth_nonce: '2',
        dst_tag: 'midnight:account:auth:k1:v1:revoke_grant',
      },
      pureCircuits.challenge_revoke_grant_with_k256(gSelf, gPkK256, gid, 2n),
      [dstOf('midnight:account:auth:k1:v1:revoke_grant'), gSelfBytes, kx, ky, gid, u64(2n)],
    );
    pin(
      'pinned', 'challenge_revoke_all_grants_with_k256', '6.1',
      {
        self: bytesToHex(gSelfBytes), pk_x: bytesToHex(kx), pk_y: bytesToHex(ky), auth_nonce: '3',
        dst_tag: 'midnight:account:auth:k1:v1:revoke_all_grants',
      },
      pureCircuits.challenge_revoke_all_grants_with_k256(gSelf, gPkK256, 3n),
      [dstOf('midnight:account:auth:k1:v1:revoke_all_grants'), gSelfBytes, kx, ky, u64(3n)],
    );
    // The lifecycle family stayed at :k1:v1 while the device and boot
    // families moved to :k1:v2, so the grant lifecycle DSTs must not collide
    // with the existing gated circuits' DSTs.
    assert(
      new Set([
        bytesToHex(hUnshielded),
        bytesToHex(pureCircuits.challenge_issue_grant_with_k256(gSelf, gPkK256, gid, scopeDigest, 1n)),
        bytesToHex(pureCircuits.challenge_revoke_grant_with_k256(gSelf, gPkK256, gid, 1n)),
        bytesToHex(pureCircuits.challenge_revoke_all_grants_with_k256(gSelf, gPkK256, 1n)),
        bytesToHex(pureCircuits.challenge_withdraw_unshielded_with_k256(gSelf, gPkK256, gColor, gAmount, { bytes: gUserAddr }, 1n)),
      ]).size === 5,
      '[grant] every new challenge family is disjoint from the device families (AUTH-3)',
    );

    step('[grant] envelope digests over a grant challenge (both envelopes)');
    const gEnvDigests: Record<string, Uint8Array> = {};
    for (const [envelope, prefix] of [
      [K256_ENVELOPE_NONE, ''],
      [K256_ENVELOPE_CONNECTOR, 'midnight_signed_message:32:'],
    ] as const) {
      const got = pureCircuits.envelope_digest(envelope, hUnshielded);
      const parts = prefix === '' ? [hUnshielded] : [ascii(prefix), hUnshielded];
      gEnvDigests[`envelope${envelope}`] = pin(
        `envelope${envelope}_over_the_unshielded_grant_challenge`, 'envelope_digest', '3.1',
        { envelope: Number(envelope), prefix, challenge: bytesToHex(hUnshielded) },
        got, parts,
      );
    }

    step('[grant] a k256 grantee signs a grant challenge, and one signature fits one grant only');
    // A fresh grantee per envelope: §3.2 requires one key per account per
    // origin, so a grantee key is never a pinned fixture in practice. The
    // pinned signature vectors below use sk = 1 so the Rust side can
    // reproduce them.
    for (const grantee of [K256Device.generate(), K256Device.generateConnector()]) {
      const label = `envelope ${grantee.envelope}`;
      const h = pureCircuits.challenge_withdraw_unshielded_with_grant_k256(
        gSelf, grantee.pk, gid, issuedAt, gColor, gAmount, { bytes: gUserAddr }, 0n,
      );
      const digest = pureCircuits.envelope_digest(grantee.envelope, h);
      const auth = grantee.sign(h, 0n);
      assert(
        Buffer.from(digest).equals(Buffer.from(grantee.signedDigest(h))),
        `[grant] ${label}: the grantee signs envelope_digest(envelope, challenge), never the challenge`,
      );
      assert(
        nobleVerify(auth.sig, digest, grantee.pk),
        `[grant] ${label}: the grant signature verifies on an independent stack (noble)`,
      );
      assert(
        nobleVerify({ r: auth.sig.r, s: SECP256K1_N - auth.sig.s }, digest, grantee.pk),
        `[grant] ${label}: the high-S twin verifies too (both S forms accepted, SIG-4)`,
      );
      assert(
        !nobleVerify(auth.sig, digest, K256Device.generate().pk),
        `[grant] ${label}: verification fails for another grantee key (non-vacuous verifier, S10)`,
      );
      // GR-3: one signature fits one grant_id only. The other id here is the
      // same key at the same origin under slot 1.
      const hOtherId = pureCircuits.challenge_withdraw_unshielded_with_grant_k256(
        gSelf, grantee.pk, gidOther, issuedAt, gColor, gAmount, { bytes: gUserAddr }, 0n,
      );
      assert(
        !nobleVerify(auth.sig, pureCircuits.envelope_digest(grantee.envelope, hOtherId), grantee.pk),
        `[grant] ${label}: the signature does not verify under another grant_id (GR-3)`,
      );
      // GR-6: incarnation isolation. Re-issue over the same id advances
      // issued_at, so a signature against one issuance fits no other.
      const hOtherIssue = pureCircuits.challenge_withdraw_unshielded_with_grant_k256(
        gSelf, grantee.pk, gid, issuedAt + 1n, gColor, gAmount, { bytes: gUserAddr }, 0n,
      );
      assert(
        !nobleVerify(auth.sig, pureCircuits.envelope_digest(grantee.envelope, hOtherIssue), grantee.pk),
        `[grant] ${label}: the signature does not verify under another issued_at (GR-6)`,
      );
      // GR-5: the record's nonce is the freshness element.
      const hOtherNonce = pureCircuits.challenge_withdraw_unshielded_with_grant_k256(
        gSelf, grantee.pk, gid, issuedAt, gColor, gAmount, { bytes: gUserAddr }, 1n,
      );
      assert(
        !nobleVerify(auth.sig, pureCircuits.envelope_digest(grantee.envelope, hOtherNonce), grantee.pk),
        `[grant] ${label}: the signature does not verify under the next record nonce (GR-5)`,
      );
      // The envelope cannot alias: the other envelope's digest over the same
      // challenge is a different message.
      const otherEnvelope = grantee.envelope === K256_ENVELOPE_NONE
        ? K256_ENVELOPE_CONNECTOR : K256_ENVELOPE_NONE;
      assert(
        !nobleVerify(auth.sig, pureCircuits.envelope_digest(otherEnvelope, h), grantee.pk),
        `[grant] ${label}: the signature does not verify under the other envelope`,
      );
    }

    step('[grant] pinned signature vectors under sk = 1 (deterministic, RFC 6979)');
    const gSignatures: Record<string, unknown>[] = [];
    for (const envelope of [K256_ENVELOPE_NONE, K256_ENVELOPE_CONNECTOR] as const) {
      const device = new K256Device(1n, envelope);
      assert(
        device.pk.x === gPkK256.x && device.pk.y === gPkK256.y,
        `[grant] envelope ${envelope}: the pinned grantee key is G`,
      );
      const digest = gEnvDigests[`envelope${envelope}`];
      const auth = device.sign(hUnshielded, 0n);
      assert(
        nobleVerify(auth.sig, digest, device.pk),
        `[grant] envelope ${envelope}: the pinned signature verifies over the pinned envelope digest`,
      );
      assert(
        nobleVerify({ r: auth.sig.r, s: SECP256K1_N - auth.sig.s }, digest, device.pk),
        `[grant] envelope ${envelope}: the pinned high-S twin verifies too (SIG-4)`,
      );
      gSignatures.push({
        name: `withdraw_unshielded_grant_challenge_envelope${envelope}`,
        arm: 'k1',
        scheme: 'ecdsa_secp256k1_sha256',
        envelope: Number(envelope),
        sk: '1',
        challenge: bytesToHex(hUnshielded),
        signed_digest: bytesToHex(digest),
        // §3.4 wire form: r || s, each a 32-byte little-endian integer.
        sig_le: bytesToHex(concat([fe(auth.sig.r), fe(auth.sig.s)])),
        r: auth.sig.r.toString(),
        s: auth.sig.s.toString(),
        s_high: (SECP256K1_N - auth.sig.s).toString(),
        note: 'both S forms MUST verify',
      });
    }

    step('[grant] writing the cross-implementation vectors for signer-rs');
    const vectorsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'vectors');
    mkdirSync(vectorsDir, { recursive: true });
    const vectorsFile = path.join(vectorsDir, 'grants-e1.json');
    writeFileSync(vectorsFile, `${JSON.stringify({
      title: 'Scoped grants, stage-one cross-implementation vectors (Testing item 5)',
      source: 'contract/src/tests/unit-offline.ts, section [grant]',
      recipe: {
        hash: 'SHA-256 over the raw concatenation of fixed-width elements (persistentHash over byte atoms)',
        integers: 'little-endian at the Compact width',
        boolean: 'one byte, 0x01 true and 0x00 false',
        curve_coordinate: '32-byte little-endian integer',
        tag_pad: 'ASCII bytes zero-padded on the right to the stated width',
        dst: 'a per-twin DST is SHA-256 of the tag padded to 64 bytes; an identity or commitment tag is a raw 32-byte pad used as a tuple element',
      },
      fixtures: {
        self: bytesToHex(gSelfBytes),
        scope_salt: bytesToHex(gSalt),
        origin: gOrigin,
        origin_hash: bytesToHex(gOriginHash),
        rp_id_hash: bytesToHex(gRpIdHash),
        color: bytesToHex(gColor),
        recipients: {
          any: bytesToHex(gZero), user_address: bytesToHex(gUserAddr),
          zswap_coin_public_key: bytesToHex(gZswapPk), contract_address: bytesToHex(gContract),
        },
        read_pk_hash: bytesToHex(gReadPkHash),
        enc_pk: bytesToHex(gEncPk),
        change_entry: bytesToHex(gChangeEntry),
        pk_k1: { sk: '1', x_le: bytesToHex(kx), y_le: bytesToHex(ky) },
        pk_v1: { sk: '1', x_le: bytesToHex(jx), y_le: bytesToHex(jy) },
        slots: [0, 1],
      },
      mismatches: [{
        element: 'the v1 (JubJub) key element of the grant_id preimage',
        mip: 'section 3.4 and section 4.3: a 32-byte JubjubPoint encoding, giving a 129-byte preimage',
        compiled: 'two Field atoms, x then y, each 32 bytes little-endian, giving a 161-byte preimage',
        resolution: 'an encoding fact, not a circuit choice: the Compact stays as compiled and the MIP recipe is corrected (section 3.4 v1 pk = 128 hex x || y, each a 32-byte little-endian canonical coordinate; section 4.3 v1 width 161)',
      }],
      vectors,
      signatures: gSignatures,
    }, null, 2)}\n`);
    assert(vectors.length === 27, `[grant] ${vectors.length} pinned vectors written to src/tests/vectors/grants-e1.json`);
  }

  // ── Shared ─────────────────────────────────────────────────────────────────

  step('InboxEntry v1 codec (MIP-0012 §6.4)');
  const keys = generateEncKeyPair();
  const coin = {
    nonce: new Uint8Array(randomBytes(32)),
    color: new Uint8Array(randomBytes(32)),
    value: (1n << 100n) + 12345n,
  };
  const entry = sealInboxEntry(keys.publicKey, coin);
  assert(entry.length === ENTRY_SIZE, 'container is 192 bytes');
  assert(entry[0] === 0x01 && entry[1] === 0x01, 'version and suite bytes');
  assert(entry.subarray(142).every((b) => b === 0), 'padding zeroed');
  const opened = openInboxEntry(keys.secretKey, entry);
  assert(opened !== null, 'entry opens with the account secret');
  assert(opened!.value === coin.value, 'value roundtrips (u128 BE)');
  assert(Buffer.from(opened!.nonce).equals(Buffer.from(coin.nonce)), 'nonce roundtrips');
  assert(Buffer.from(opened!.color).equals(Buffer.from(coin.color)), 'color roundtrips');
  assert(openInboxEntry(generateEncKeyPair().secretKey, entry) === null, 'wrong key is skipped');
  const unknownVersion = new Uint8Array(entry);
  unknownVersion[0] = 0x02;
  assert(openInboxEntry(keys.secretKey, unknownVersion) === null, 'unknown version is skipped');
  const unknownSuite = new Uint8Array(entry);
  unknownSuite[1] = 0x02;
  assert(openInboxEntry(keys.secretKey, unknownSuite) === null, 'unknown suite is skipped');
  const tamperedCt = new Uint8Array(entry);
  tamperedCt[70] ^= 0x01;
  assert(openInboxEntry(keys.secretKey, tamperedCt) === null, 'tampered ciphertext is skipped');

  step('[jubjub] grinding statistics sanity (§5.2)');
  let attempts = 0;
  for (let i = 0; i < 20; i++) {
    const d = JubjubDevice.generate();
    const b = jubjubChallenges.appendInbox(ctx, d.pk, entry);
    const a = d.sign(b, 0n);
    attempts += Number(a.grind_nonce) + 1;
  }
  console.log(`  grinding: ${(attempts / 20).toFixed(1)} attempts/signature (expect ≈17.5)`);
});
