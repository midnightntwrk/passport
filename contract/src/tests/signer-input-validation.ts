import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ecAdd, ecMul, ecMulGenerator } from '@midnight-ntwrk/compact-runtime';
import {
  JubjubDevice, JubjubGrantee, K256Device, K256Grantee,
  JUBJUB_R, SECP256K1_N, K256_ENVELOPE_CONNECTOR,
} from '../wallet/signer.js';

const signingSecretError = /signing secret must be greater than zero and less than the curve order/;

for (const [Signer, order] of [
  [JubjubDevice, JUBJUB_R], [JubjubGrantee, JUBJUB_R],
  [K256Device, SECP256K1_N], [K256Grantee, SECP256K1_N],
] as const) {
  test(`${Signer.name} rejects noncanonical signing secrets`, () => {
    for (const sk of [-order, -1n, 0n, order, order + 1n, 2n * order, 1n << 256n]) {
      assert.throws(() => new Signer(sk), { name: 'RangeError', message: signingSecretError });
    }
  });

  test(`${Signer.name} rejects non-bigint signing secrets`, () => {
    for (const sk of [1, '1', null, undefined]) {
      assert.throws(() => new Signer(sk as unknown as bigint), {
        name: 'TypeError', message: /signing secret must be a bigint/,
      });
    }
  });
}

for (const Signer of [JubjubDevice, JubjubGrantee]) {
  for (const sk of [1n, JUBJUB_R - 1n]) {
    test(`${Signer.name} signs with valid boundary scalar ${sk === 1n ? '1' : 'order - 1'}`, () => {
      const signer = new Signer(sk);
      assert.equal(signer.sk, sk);
      assert.notDeepEqual(signer.pk, { x: 0n, y: 1n });
      const challenge = new Uint8Array(32);
      challenge[0] = 5;
      const build = () => challenge;
      const auth = signer instanceof JubjubDevice ? signer.sign(build, 7n) : signer.sign(build);
      assert.deepEqual(ecMulGenerator(auth.sig_s), ecAdd(auth.sig_r, ecMul(signer.pk, 5n)));
      assert.notDeepEqual(ecMulGenerator(auth.sig_s), ecAdd(auth.sig_r, ecMul(signer.pk, 6n)));
    });
  }
}

for (const Signer of [K256Device, K256Grantee]) {
  for (const sk of [1n, SECP256K1_N - 1n]) {
    test(`${Signer.name} signs with valid boundary scalar ${sk === 1n ? '1' : 'order - 1'}`, () => {
      const signer = new Signer(sk, K256_ENVELOPE_CONNECTOR);
      assert.equal(signer.sk, sk);
      assert.equal(signer.envelope, K256_ENVELOPE_CONNECTOR);
      const expectedPk = secp256k1.Point.BASE.multiply(sk);
      assert.deepEqual(signer.pk, { ...expectedPk.toAffine(), identity: false });
      const challenge = new Uint8Array(32).fill(5);
      const auth = signer instanceof K256Device ? signer.sign(challenge, 7n) : signer.sign(challenge);
      const signature = new secp256k1.Signature(auth.sig.r, auth.sig.s).toBytes('compact');
      assert(secp256k1.verify(signature, signer.signedDigest(challenge), expectedPk.toBytes(), { prehash: false }));
      assert(!secp256k1.verify(signature, signer.signedDigest(new Uint8Array(32).fill(6)), expectedPk.toBytes(), { prehash: false }));
    });
  }
}
