// Test-client signing only. Neither sk nor the nonce scalar is a circuit input.
import { randomBytes } from 'node:crypto';
import { ecAdd, ecMul, ecMulGenerator } from '@midnight-ntwrk/compact-runtime';

export type Point = { x: bigint; y: bigint };
export const JUBJUB_R = 0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7n;
export const freshBytes = () => new Uint8Array(randomBytes(32));

function scalar(): bigint {
  for (;;) {
    const s = BigInt('0x' + randomBytes(32).toString('hex'));
    if (s > 0n && s < JUBJUB_R) return s;
  }
}

export function littleEndian(bytes: Uint8Array): bigint {
  return BigInt('0x' + Buffer.from(bytes).reverse().toString('hex'));
}

export function fieldBytes(value: bigint): Uint8Array {
  return new Uint8Array(Buffer.from(value.toString(16).padStart(64, '0'), 'hex').reverse());
}

export class Device {
  readonly sk = scalar();
  readonly pk = ecMulGenerator(this.sk);
  readonly policy = freshBytes();

  sign(build: (r: Point, grind: bigint) => Uint8Array) {
    const r = scalar();
    const sig_r = ecMulGenerator(r);
    for (let grind_nonce = 0n; ; grind_nonce++) {
      const challenge = littleEndian(build(sig_r, grind_nonce));
      if (challenge >= JUBJUB_R) continue;
      const sig_s = (r + challenge * this.sk) % JUBJUB_R;
      // Independent curve equation check catches a client construction error.
      const lhs = ecMulGenerator(sig_s);
      const rhs = ecAdd(sig_r, ecMul(this.pk, challenge));
      if (lhs.x !== rhs.x || lhs.y !== rhs.y) throw new Error('invalid test-client signature');
      return { pk: this.pk, policy: this.policy, sig_r, sig_s, grind_nonce };
    }
  }
}
