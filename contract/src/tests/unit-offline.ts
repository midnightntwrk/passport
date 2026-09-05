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

import { createHash, randomBytes } from 'node:crypto';
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
