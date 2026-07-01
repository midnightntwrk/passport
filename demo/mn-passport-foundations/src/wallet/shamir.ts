// Byte-wise Shamir secret sharing over GF(256), threshold k of n.
//
// Used by the C14 recovery flow: the recovery secret is split 2-of-3 at
// onboarding and the share values are stored in the account contract's
// public ledger state, keyed by share index.
//
// TODO(PVSS): this is a placeholder for a publicly verifiable secret
// sharing scheme. Plain Shamir shares stored in public ledger state mean
// ANYONE can take two of them and reconstruct the recovery secret. The
// target design encrypts each share to a recovery helper's public key and
// publishes a proof of correct sharing instead (C15 helper protocol).
// Do not ship this version.
//
// GF(256) arithmetic uses the AES polynomial x^8 + x^4 + x^3 + x + 1
// (0x11b) with generator 3 — the same construction as HashiCorp Vault's
// shamir package and ssss.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    // multiply x by the generator 3 = x ^ (x << 1) in GF(256)
    x ^= (x << 1) ^ (x & 0x80 ? 0x11b : 0);
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error('division by zero in GF(256)');
  if (a === 0) return 0;
  return EXP[(LOG[a] - LOG[b] + 255) % 255];
}

export interface Share {
  /** The x-coordinate, 1..255. Doubles as the ledger map key. */
  index: number;
  /** The y-coordinates, one byte per secret byte. */
  value: Uint8Array;
}

/** Split `secret` into `n` shares such that any `k` reconstruct it. */
export function split(secret: Uint8Array, k: number, n: number): Share[] {
  if (k < 2 || k > n) throw new Error(`invalid threshold ${k} of ${n}`);
  if (n > 255) throw new Error('at most 255 shares');

  // One random polynomial of degree k-1 per secret byte; constant term is
  // the secret byte itself.
  const coefficients: Uint8Array[] = [];
  for (let j = 0; j < secret.length; j++) {
    const coeff = new Uint8Array(k);
    coeff[0] = secret[j];
    const rand = new Uint8Array(k - 1);
    globalThis.crypto.getRandomValues(rand);
    coeff.set(rand, 1);
    coefficients.push(coeff);
  }

  const shares: Share[] = [];
  for (let x = 1; x <= n; x++) {
    const value = new Uint8Array(secret.length);
    for (let j = 0; j < secret.length; j++) {
      // Horner evaluation of the polynomial at x.
      let y = 0;
      for (let c = k - 1; c >= 0; c--) {
        y = gfMul(y, x) ^ coefficients[j][c];
      }
      value[j] = y;
    }
    shares.push({ index: x, value });
  }
  return shares;
}

/** Reconstruct the secret from at least k shares (Lagrange at x = 0). */
export function reconstruct(shares: Share[]): Uint8Array {
  if (shares.length < 2) throw new Error('need at least two shares');
  const length = shares[0].value.length;
  const indices = shares.map((s) => s.index);
  if (new Set(indices).size !== indices.length) {
    throw new Error('duplicate share indices');
  }

  const secret = new Uint8Array(length);
  for (let j = 0; j < length; j++) {
    let acc = 0;
    for (let i = 0; i < shares.length; i++) {
      // Lagrange basis polynomial evaluated at 0.
      let num = 1;
      let den = 1;
      for (let m = 0; m < shares.length; m++) {
        if (m === i) continue;
        num = gfMul(num, shares[m].index);
        den = gfMul(den, shares[m].index ^ shares[i].index);
      }
      acc ^= gfMul(shares[i].value[j], gfDiv(num, den));
    }
    secret[j] = acc;
  }
  return secret;
}
