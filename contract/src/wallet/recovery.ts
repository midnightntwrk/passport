// Client-side recovery core (recovery MIP §2, §4, §8).
//
// Bottom-up secret sharing (ANARKey) over the BLS12-381 scalar field, the
// share derivation in the MIP's normative form (tagged, length-prefixed),
// and the wrap container v1. Pure TypeScript over bigint — no wasm, no
// external dependency — so this file doubles as the second independent
// implementation for the cross-implementation share vectors (the first is
// the Rust scheme-library fork).
//
// Scheme geometry (§8): a roster of n guardians at reconstruction
// threshold t+1 puts guardian j's share at x = j (1-based), the secret at
// x = 0, and publishes phi = f(-1) .. f(-(n-t)) for the degree-n
// polynomial f through all n+1 points. |phi| = n - t.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// ── Field arithmetic over Fq (BLS12-381 scalar field, JubJub base field) ────

export const FQ = BigInt(
  '52435875175126190479447740508185965837690552500527637822603658699938581184513',
);

const mod = (a: bigint): bigint => ((a % FQ) + FQ) % FQ;

/** Modular inverse via Fermat (FQ prime). */
function inv(a: bigint): bigint {
  if (mod(a) === 0n) throw new Error('inverse of zero');
  let result = 1n;
  let base = mod(a);
  let e = FQ - 2n;
  while (e > 0n) {
    if (e & 1n) result = (result * base) % FQ;
    base = (base * base) % FQ;
    e >>= 1n;
  }
  return result;
}

/** Canonical 32-byte little-endian representation (matches ff to_repr). */
export function fieldToBytes(x: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = mod(x);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function fieldFromBytes(bytes: Uint8Array): bigint {
  if (bytes.length !== 32) throw new Error('field repr must be 32 bytes');
  let v = 0n;
  for (let i = 31; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  if (v >= FQ) throw new Error('non-canonical field encoding');
  return v;
}

/** 64-byte wide reduction, little-endian (matches ff from_uniform_bytes). */
export function wideReduce(bytes: Uint8Array): bigint {
  if (bytes.length !== 64) throw new Error('wide reduction takes 64 bytes');
  let v = 0n;
  for (let i = 63; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v % FQ;
}

/** Uniform field element from the platform generator, by wide reduction. */
export function randomFieldElement(): bigint {
  return wideReduce(new Uint8Array(randomBytes(64)));
}

// ── Domain-separated derivations (§2 tag registry) ──────────────────────────
//
// Every hash input is length-prefixed (u32 big-endian) so no two distinct
// input tuples share a preimage (§4). SHA-512 into a 64-byte wide
// reduction is the incumbent interim construction; [CRYPTO-MEMO Q4]
// ratifies or replaces it.

export const DST_GUARDIAN = 'midnight:account:recovery:guardian:v1';
export const DST_SHARE = 'midnight:account:recovery:share:v1';
export const DST_WRAP = 'midnight:account:recovery:wrap:v1';

function lengthPrefixed(...fields: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const f of fields) total += 4 + f.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const f of fields) {
    out[o] = (f.length >>> 24) & 0xff;
    out[o + 1] = (f.length >>> 16) & 0xff;
    out[o + 2] = (f.length >>> 8) & 0xff;
    out[o + 3] = f.length & 0xff;
    out.set(f, o + 4);
    o += 4 + f.length;
  }
  return out;
}

const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

function sha512(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha512').update(data).digest());
}

/** Profile A (§3): guardian secret from a 32-byte authenticator PRF output. */
export function guardianSecretFromPrf(prfOutput: Uint8Array): bigint {
  return wideReduce(sha512(lengthPrefixed(ascii(DST_GUARDIAN), prfOutput)));
}

/** Profile C (§3): a paper key is a uniform field element, printed. */
export function newPaperKey(): bigint {
  return randomFieldElement();
}

/** §4: sigma_ij = H(DST_share, sid_i, pk_i, sk_j), length-prefixed. */
export function deriveShare(
  sessionId: Uint8Array,
  accountAddress: Uint8Array,
  guardianSecret: bigint,
): bigint {
  return wideReduce(
    sha512(
      lengthPrefixed(
        ascii(DST_SHARE),
        sessionId,
        accountAddress,
        fieldToBytes(guardianSecret),
      ),
    ),
  );
}

/** §2: the wrap key, domain-separated from the gate commitment. */
function wrapKey(recoverySecret: Uint8Array, accountAddress: Uint8Array): Uint8Array {
  return sha512(
    lengthPrefixed(ascii(DST_WRAP), accountAddress, recoverySecret),
  ).subarray(0, 32);
}

// ── BUSS split and reconstruct (§5, §6) ─────────────────────────────────────

export interface IndexedShare {
  /** The guardian's evaluation index (1-based, §7). */
  index: number;
  sigma: bigint;
}

/** Lagrange evaluation of the interpolating polynomial at x = at. */
function lagrangeAt(points: ReadonlyArray<readonly [bigint, bigint]>, at: bigint): bigint {
  let acc = 0n;
  for (let i = 0; i < points.length; i++) {
    const [xi, yi] = points[i];
    let num = 1n;
    let den = 1n;
    for (let k = 0; k < points.length; k++) {
      if (k === i) continue;
      const [xk] = points[k];
      num = (num * mod(at - xk)) % FQ;
      den = (den * mod(xi - xk)) % FQ;
    }
    acc = (acc + ((yi * num) % FQ) * inv(den)) % FQ;
  }
  return acc;
}

/**
 * Session split (§5): from the secret and every guardian's share for this
 * session, compute the public vector phi = f(-1)..f(-(n-t)).
 */
export function split(
  secret: bigint,
  shares: readonly IndexedShare[],
  t: number,
): bigint[] {
  const n = shares.length;
  if (t < 0 || t + 1 > n) throw new Error(`threshold t+1=${t + 1} exceeds roster n=${n}`);
  const seen = new Set(shares.map((s) => s.index));
  if (seen.size !== n || [...seen].some((i) => i < 1)) {
    throw new Error('guardian indices must be distinct and 1-based');
  }
  const points: Array<readonly [bigint, bigint]> = [
    [0n, mod(secret)],
    ...shares.map((s) => [BigInt(s.index), mod(s.sigma)] as const),
  ];
  const phi: bigint[] = [];
  for (let k = 1; k <= n - t; k++) phi.push(lagrangeAt(points, mod(-BigInt(k))));
  return phi;
}

/**
 * Reconstruction (§6 step 2): phi plus at least t+1 indexed shares.
 * Verification is by the caller against the gate commitment — the
 * reconstruction itself has no identifiable abort.
 */
export function reconstruct(
  phi: readonly bigint[],
  shares: readonly IndexedShare[],
  t: number,
): bigint {
  if (shares.length < t + 1) {
    throw new Error(`need t+1=${t + 1} shares, got ${shares.length}`);
  }
  const points: Array<readonly [bigint, bigint]> = [
    ...phi.map((y, i) => [mod(-BigInt(i + 1)), mod(y)] as const),
    ...shares.slice(0, t + 1).map((s) => [BigInt(s.index), mod(s.sigma)] as const),
  ];
  return lagrangeAt(points, 0n);
}

/**
 * Trial assignment (§6 step 1): reconstruct with unknown indices by trying
 * injective assignments of the returned shares onto the evaluation points
 * 1..n, verifying each candidate against the gate commitment. Returns the
 * secret and the recovered assignment, or null. Bounded by P(n, t+1)
 * candidates — the §8 parameter guidance keeps this tractable.
 */
export function reconstructByTrial(
  phi: readonly bigint[],
  sigmas: readonly bigint[],
  t: number,
  n: number,
  matchesCommitment: (candidate: bigint) => boolean,
): { secret: bigint; assignment: IndexedShare[] } | null {
  const chosen = sigmas.slice(0, t + 1);
  const indices = Array.from({ length: n }, (_, i) => i + 1);
  const assignment: IndexedShare[] = [];
  const used = new Set<number>();

  function recurse(depth: number): { secret: bigint; assignment: IndexedShare[] } | null {
    if (depth === chosen.length) {
      const candidate = reconstruct(phi, assignment, t);
      if (matchesCommitment(candidate)) {
        return { secret: candidate, assignment: [...assignment] };
      }
      return null;
    }
    for (const idx of indices) {
      if (used.has(idx)) continue;
      used.add(idx);
      assignment.push({ index: idx, sigma: chosen[depth] });
      const hit = recurse(depth + 1);
      assignment.pop();
      used.delete(idx);
      if (hit) return hit;
    }
    return null;
  }

  return recurse(0);
}

// ── Wrap container v1 (§8) ──────────────────────────────────────────────────
//
// [version 0x01][suite 0x01][nonce 12][ciphertext 32][tag 16][pad 2] = 64
// bytes: AES-256-GCM of the account encryption secret under the wrap key,
// mirroring the InboxEntry v1 layout (MIP-0012 §6.4). The AEAD suite is
// the interim incumbent; [CRYPTO-MEMO Q5] fixes the final requirements.

export const WRAP_SIZE = 64;

export function sealWrap(
  recoverySecret: Uint8Array,
  accountAddress: Uint8Array,
  encSecretKey: Uint8Array,
): Uint8Array {
  if (encSecretKey.length !== 32) throw new Error('encryption secret must be 32 bytes');
  const key = wrapKey(recoverySecret, accountAddress);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(encSecretKey), cipher.final()]);
  const tag = cipher.getAuthTag();

  const out = new Uint8Array(WRAP_SIZE);
  out[0] = 0x01; // container version
  out[1] = 0x01; // suite: AES-256-GCM
  out.set(nonce, 2);
  out.set(ct, 14);
  out.set(tag, 46);
  return out;
}

/** Returns the encryption secret, or null (wrong key, tamper, version). */
export function openWrap(
  recoverySecret: Uint8Array,
  accountAddress: Uint8Array,
  wrap: Uint8Array,
): Uint8Array | null {
  if (wrap.length !== WRAP_SIZE || wrap[0] !== 0x01 || wrap[1] !== 0x01) return null;
  const key = wrapKey(recoverySecret, accountAddress);
  const nonce = wrap.subarray(2, 14);
  const ct = wrap.subarray(14, 46);
  const tag = wrap.subarray(46, 62);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(ct), decipher.final()]));
  } catch {
    return null;
  }
}

// ── The roster record (§7) ──────────────────────────────────────────────────
//
// Durable owner-held metadata: not secret, replicated across the owner's
// devices and backups. Its loss degrades recovery to trial assignment.

export interface RosterRecord {
  n: number;
  t: number;
  guardians: Array<{
    index: number;
    profile: 'prf' | 'cold' | 'paper';
    /** The owner's means of reaching the guardian — never on-chain. */
    contact: string;
  }>;
}

/**
 * Fresh recovery secret (§2): a uniform field element, because `s` is
 * shared over the field. `bytes` is the canonical 32-byte representation:
 * the witness form the gate commitment is computed over, and what
 * reconstruction must reproduce bit-exactly.
 */
export function newRecoverySecret(): { field: bigint; bytes: Uint8Array } {
  const field = randomFieldElement();
  return { field, bytes: fieldToBytes(field) };
}

/** Fresh 32-byte session identifier (REC-4: distinct per session). */
export function newSessionNonce(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}
