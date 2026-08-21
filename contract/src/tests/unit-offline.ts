// Offline unit checks — no localnet required.
//
// Exercises the client-side halves of both standards against the compiled
// contract module: the ECDSA signing pipeline (scalar sampling, the digest
// signature, the verify equation via the runtime's own curve built-ins),
// the InboxEntry v1 codec (§6.4), and the challenge domain separation
// (AUTH-3 at the hash level). The rejection matrix proper runs against a
// node (auth-conformance.ts); this file guards the vacuous-verifier hazard
// (S10) cheaply on every change.

import { randomBytes } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  SECP256K1_SCALAR_MODULUS,
  secp256k1Add,
  secp256k1Mul,
  secp256k1MulGenerator,
  secp256k1PointX,
  secp256k1ScalarInv,
  secp256k1ScalarMul,
} from '@midnight-ntwrk/compact-runtime';

import { runScenario, step } from './runner.js';
import { Device, challenges, SECP256K1_N, type CallContext } from '../wallet/signer.js';
import { generateEncKeyPair, sealInboxEntry, openInboxEntry, ENTRY_SIZE } from '../wallet/inbox.js';

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`assertion failed: ${label}`);
  console.log(`  ✓ ${label}`);
}

/** Big-endian integer interpretation of the 32-byte challenge — the
 *  in-circuit secp256k1EcdsaVerify's reading of its message. */
function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let r = 0n;
  for (const b of bytes) r = (r << 8n) | BigInt(b);
  return r;
}

/** Noble's encodings for the independent-stack verification. */
const pkBytes = (pk: { x: bigint; y: bigint }) =>
  secp256k1.Point.fromAffine({ x: pk.x, y: pk.y }).toBytes(false);
const sigBytes = (sig: { r: bigint; s: bigint }) =>
  new secp256k1.Signature(sig.r, sig.s).toBytes('compact');
const nobleVerify = (sig: { r: bigint; s: bigint }, digest: Uint8Array, pk: { x: bigint; y: bigint }) =>
  secp256k1.verify(sigBytes(sig), digest, pkBytes(pk), { prehash: false, lowS: false });

await runScenario('unit-offline', async () => {
  step('device keys and rolling entries (§3, AUTH-9)');
  assert(SECP256K1_N === SECP256K1_SCALAR_MODULUS, 'signer n matches the runtime curve order');
  const device = Device.generate();
  assert(device.sk > 0n && device.sk < SECP256K1_N, 'sk in [1, n)');
  assert(device.pk.identity === false, 'pk is a real point, never the identity');
  const accountAddr = new Uint8Array(randomBytes(32));
  const e0 = device.entryAt(accountAddr, 0n, 0n);
  assert(e0.length === 32, 'device entry is 32 bytes');
  assert(
    Buffer.from(e0).equals(Buffer.from(device.entryAt(accountAddr, 0n, 0n))),
    'entry deterministic',
  );
  const other = Device.generate();
  assert(
    !Buffer.from(e0).equals(Buffer.from(other.entryAt(accountAddr, 0n, 0n))),
    'distinct keys give distinct entries',
  );
  assert(
    !Buffer.from(e0).equals(Buffer.from(device.entryAt(accountAddr, 0n, 1n))),
    'the use counter rolls the entry (single-use, AUTH-9)',
  );
  assert(
    !Buffer.from(e0).equals(Buffer.from(device.entryAt(accountAddr, 1n, 0n))),
    'an epoch bump invalidates every prior entry (AUTH-6)',
  );
  assert(
    !Buffer.from(e0).equals(Buffer.from(device.entryAt(new Uint8Array(randomBytes(32)), 0n, 0n))),
    'entries for one key are unequal across accounts',
  );

  step('signing pipeline: ECDSA over the challenge digest');
  const ctx: CallContext = { contractAddress: new Uint8Array(randomBytes(32)), authNonce: 0n };
  const color = new Uint8Array(32);
  const recipient = new Uint8Array(randomBytes(32));
  const h = challenges.withdrawUnshielded(ctx, device.pk, color, 100n, recipient);
  const auth = device.sign(h, 0n);
  assert(auth.sig.r > 0n && auth.sig.r < SECP256K1_N, 'r in [1, n)');
  assert(auth.sig.s > 0n && auth.sig.s < SECP256K1_N, 's in [1, n)');
  assert(auth.sig.s <= SECP256K1_N >> 1n, 'signer emits low-S (the circuit accepts both forms)');
  assert(
    Buffer.from(h).equals(Buffer.from(challenges.withdrawUnshielded(ctx, device.pk, color, 100n, recipient))),
    'challenge deterministic',
  );
  assert(nobleVerify(auth.sig, h, device.pk), 'signature verifies on an independent stack (noble)');
  // Replicate the in-circuit verify with the runtime's own curve built-ins
  // (the same functions the generated verifier calls): z = BE(challenge)
  // mod n, w = s⁻¹, then x(z·w·G + r·w·pk) mod n == r.
  const z = bytesToBigIntBE(h) % SECP256K1_N;
  const w = secp256k1ScalarInv(auth.sig.s);
  const point = secp256k1Add(
    secp256k1MulGenerator(secp256k1ScalarMul(z, w)),
    secp256k1Mul(device.pk, secp256k1ScalarMul(auth.sig.r, w)),
  );
  assert(
    secp256k1PointX(point) % SECP256K1_N === auth.sig.r,
    'x(u1·G + u2·pk) mod n == r (the verify equation, off-circuit)',
  );
  assert(
    !nobleVerify(auth.sig, h, other.pk),
    'verification fails for a different pk (non-vacuous verifier, S10)',
  );
  const hBad = new Uint8Array(h);
  hBad[0] ^= 0x01;
  assert(!nobleVerify(auth.sig, hBad, device.pk), 'verification fails for a tampered challenge');
  assert(
    !nobleVerify({ r: auth.sig.r, s: (auth.sig.s + 1n) % SECP256K1_N }, h, device.pk),
    'verification fails for a tampered s',
  );
  // Malleability, deliberately accepted (see the contract header): the
  // high-S twin (r, n − s) authorises the same challenge; replay is dead
  // regardless because the device entry is consumed (AUTH-9) and
  // auth_nonce advances (AUTH-8).
  assert(
    nobleVerify({ r: auth.sig.r, s: SECP256K1_N - auth.sig.s }, h, device.pk),
    'the high-S twin verifies too (accepted; replay-dead via AUTH-8/9)',
  );

  step('challenge domain separation (AUTH-3) and witness binding (AUTH-10)');
  const witnessCoin = { nonce: new Uint8Array(randomBytes(32)), color, value: 100n, mt_index: 7n };
  const shieldedH = challenges.withdrawShielded(ctx, device.pk, recipient, color, 100n, witnessCoin);
  const toContractH = challenges.withdrawShieldedToContract(ctx, device.pk, recipient, color, 100n, witnessCoin);
  assert(
    !Buffer.from(shieldedH).equals(Buffer.from(toContractH)),
    'per-circuit tags separate identical argument lists',
  );
  const otherCoin = { ...witnessCoin, mt_index: 8n };
  assert(
    !Buffer.from(shieldedH).equals(
      Buffer.from(challenges.withdrawShielded(ctx, device.pk, recipient, color, 100n, otherCoin)),
    ),
    'the witness values pin the private state (AUTH-10): a different coin, a different challenge',
  );
  const otherAccount: CallContext = { ...ctx, contractAddress: new Uint8Array(randomBytes(32)) };
  assert(
    !Buffer.from(h).equals(
      Buffer.from(challenges.withdrawUnshielded(otherAccount, device.pk, color, 100n, recipient)),
    ),
    'account address separates challenges across accounts',
  );
  const laterNonce: CallContext = { ...ctx, authNonce: 1n };
  assert(
    !Buffer.from(h).equals(
      Buffer.from(challenges.withdrawUnshielded(laterNonce, device.pk, color, 100n, recipient)),
    ),
    'auth_nonce separates challenges across calls (AUTH-2)',
  );
  assert(
    !Buffer.from(h).equals(
      Buffer.from(challenges.withdrawUnshielded(ctx, other.pk, color, 100n, recipient)),
    ),
    'the signing key is bound into the challenge (pk coordinate bytes)',
  );

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
  const tamperedAd = new Uint8Array(entry);
  tamperedAd[142] = 0xff; // padding is not covered by the AEAD; ciphertext is
  const tamperedCt = new Uint8Array(entry);
  tamperedCt[70] ^= 0x01;
  assert(openInboxEntry(keys.secretKey, tamperedCt) === null, 'tampered ciphertext is skipped');
});
