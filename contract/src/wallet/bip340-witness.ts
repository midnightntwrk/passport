import { schnorr } from '@noble/curves/secp256k1.js';
import type { Secp256k1Point } from '@midnight-ntwrk/compact-runtime';

/** The circuit independently constrains this untrusted even-Y public-key lift. */
export function bip340LiftX<S>(
  { privateState }: { privateState: S }, publicKey: Uint8Array,
): [S, Secp256k1Point] {
  if (publicKey.length !== 32) throw new Error('BIP-340 public key must be 32 bytes');
  const x = BigInt('0x' + Buffer.from(publicKey).toString('hex'));
  const point = schnorr.utils.lift_x(x).toAffine();
  return [privateState, { ...point, identity: false }];
}
