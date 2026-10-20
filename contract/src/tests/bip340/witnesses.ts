import { strict as assert } from 'node:assert';
import { schnorr } from '@noble/curves/secp256k1.js';
import type { Secp256k1Point } from '@midnight-ntwrk/compact-runtime';
import type { Witnesses } from '../../../contracts/managed/probe-bip340/contract/index.js';

export type PrivateState = Record<string, never>;
export const fieldOrder = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
export const scalarOrder = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export const identity: Secp256k1Point = { x: 0n, y: 0n, identity: true };

export function integer(bytes: Uint8Array): bigint {
  assert.equal(bytes.length, 32, 'expected 32-byte integer');
  return BigInt('0x' + Buffer.from(bytes).toString('hex'));
}

export function bytes32(value: bigint): Uint8Array {
  assert.ok(value >= 0n && value < 1n << 256n, 'integer does not fit 32 bytes');
  return new Uint8Array(Buffer.from(value.toString(16).padStart(64, '0'), 'hex'));
}

/** Honest lift only. Invalid-key test vectors use an explicit replacement witness
 * so a host-side noble exception cannot be mistaken for circuit rejection. */
export function liftX(publicKey: Uint8Array): Secp256k1Point {
  const point = schnorr.utils.lift_x(integer(publicKey)).toAffine();
  return { ...point, identity: false };
}

export const witnesses: Witnesses<PrivateState> = {
  bip340LiftX: ({ privateState }, publicKey) => [privateState, liftX(publicKey)],
};

export function fixedPointWitness(point: Secp256k1Point): Witnesses<PrivateState> {
  return { bip340LiftX: ({ privateState }) => [privateState, point] };
}
