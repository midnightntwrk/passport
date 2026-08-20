// BUSS (ANARKey, EPRINT 2025/551) client-side recovery core — C14/C15.
//
// Platform-neutral: no node:crypto, no Buffer, no module loading. The wasm
// bridge (passport-buss-wasm, Pleiades compiled to WebAssembly) is injected
// via makeBussApi(), so Node consumers bind the `nodejs` build and the demo
// app binds the `bundler` build of the same crate.
//
// Roles and message flow (star topology, single message each way):
//
//   owner  ── guardian request  (address, session nonce, index) ──▶ guardian
//   owner  ◀─ guardian reply    (index, σ)                      ── guardian
//
// σ = H(session_id ‖ guardian_sk) where session_id =
// "midnight:passport:recovery:buss:v0" ‖ contract address ‖ session nonce.
// The same request/reply exchange serves backup AND recovery — σ is
// deterministic per (session, guardian), which is the whole point of BUSS:
// guardians store nothing between the two ceremonies.
//
// Load-bearing rules (research/anarkey-buss-recovery-assessment.md):
//   - a fresh session nonce AND a fresh recovery secret per published backup;
//   - guardian-set changes are a fresh backup, never a reuse of old σ values.

import { hexToBytes, bytesToHex } from './hex.js';

const SESSION_TAG = 'midnight:passport:recovery:buss:v0';
const GUARDIAN_KEY_TAG = 'midnight:passport:guardian:v0';

/** The surface of passport-buss-wasm that the core consumes. */
export interface BussWasm {
  field_from_seed(seed: Uint8Array): string;
  guardian_sigma(sessionId: Uint8Array, guardianSkHex: string): string;
  guardian_key(tag: Uint8Array, secret: Uint8Array): string;
  buss_share(secretHex: string, sigmasJson: string, t: number, n: number): string;
  buss_reconstruct(phiJson: string, sigmasJson: string, t: number, n: number): string;
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** What the owner hands a guardian (copy/paste). Nothing in it is secret. */
export interface GuardianRequest {
  address: string; // account contract address
  sessionNonce: string; // hex, 32 bytes, fresh per backup
  index: number; // 1-based guardian index assigned by the owner
}

/** What the guardian hands back (copy/paste). σ is a share, not a secret key. */
export interface GuardianReply {
  index: number;
  sigma: string; // hex field element
}

/** A paper guardian: a random field element written down, plus its index. */
export interface PaperKey {
  index: number;
  sk: string; // hex field element — THE secret on the slip
}

/** BUSS parameters. threshold = t + 1 guardians recover; guardians = n − 1. */
export interface BussParams {
  t: number;
  n: number;
}

// ── Pure helpers (no wasm needed) ─────────────────────────────────────────────

/** session_id bytes = TAG ‖ '|' ‖ address ‖ '|' ‖ nonce hex, as UTF-8. */
export function sessionIdBytes(address: string, sessionNonceHex: string): Uint8Array {
  return new TextEncoder().encode(`${SESSION_TAG}|${address}|${sessionNonceHex}`);
}

/** Parameters from what is observable: guardian count and on-chain φ length. */
export function paramsFromPhi(phiLen: number, guardianCount: number): BussParams {
  const n = guardianCount + 1;
  return { t: n - phiLen - 1, n };
}

/** Fresh 32-byte session nonce for a backup publication. */
export function newSessionNonce(): Uint8Array {
  const nonce = new Uint8Array(32);
  globalThis.crypto.getRandomValues(nonce);
  return nonce;
}

// ── Copy/paste wire formats ───────────────────────────────────────────────────
//
// One-line, self-labelling strings: <kind>.v0.<base64url(JSON)>.

function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function encode(kind: string, payload: unknown): string {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  return `${kind}.v0.${bytesToB64url(json)}`;
}

// A hand-edited or corrupted paste must fail here, legibly, not deep inside
// a wasm call: `JSON.parse(...) as T` is a compile-time-only assertion, so
// each wire format validates its decoded shape. Unknown extra fields are
// tolerated (forward compatibility); known fields must have the right type.

const isHexString = (v: unknown, bytes: number): boolean =>
  typeof v === 'string' && v.length === bytes * 2 && /^[0-9a-fA-F]*$/.test(v);

const isIndex = (v: unknown): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1;

type ShapeCheck = (v: unknown) => string | null;

const checkGuardianRequest: ShapeCheck = (v) => {
  const r = v as Partial<GuardianRequest> | null;
  if (typeof r !== 'object' || r === null) return 'payload is not an object';
  if (typeof r.address !== 'string' || r.address.length === 0)
    return 'address must be a non-empty string';
  if (!isHexString(r.sessionNonce, 32)) return 'sessionNonce must be 32 bytes of hex';
  if (!isIndex(r.index)) return 'index must be a positive integer';
  return null;
};

const checkGuardianReply: ShapeCheck = (v) => {
  const r = v as Partial<GuardianReply> | null;
  if (typeof r !== 'object' || r === null) return 'payload is not an object';
  if (!isIndex(r.index)) return 'index must be a positive integer';
  if (!isHexString(r.sigma, 32)) return 'sigma must be 32 bytes of hex';
  return null;
};

const checkPaperKey: ShapeCheck = (v) => {
  const p = v as Partial<PaperKey> | null;
  if (typeof p !== 'object' || p === null) return 'payload is not an object';
  if (!isIndex(p.index)) return 'index must be a positive integer';
  if (!isHexString(p.sk, 32)) return 'sk must be 32 bytes of hex';
  return null;
};

function decode<T>(kind: string, s: string, check: ShapeCheck): T {
  const parts = s.trim().split('.');
  if (parts.length !== 3 || parts[0] !== kind || parts[1] !== 'v0') {
    throw new Error(`expected a ${kind}.v0.… string`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[2])));
  } catch {
    throw new Error(`${kind}.v0 payload is not valid base64url JSON`);
  }
  const problem = check(parsed);
  if (problem !== null) throw new Error(`${kind}.v0 payload: ${problem}`);
  return parsed as T;
}

export const encodeGuardianRequest = (r: GuardianRequest): string => encode('buss-req', r);
export const decodeGuardianRequest = (s: string): GuardianRequest =>
  decode<GuardianRequest>('buss-req', s, checkGuardianRequest);

export const encodeGuardianReply = (r: GuardianReply): string => encode('buss-sig', r);
export const decodeGuardianReply = (s: string): GuardianReply =>
  decode<GuardianReply>('buss-sig', s, checkGuardianReply);

export const encodePaperKey = (p: PaperKey): string => encode('buss-paper', p);
export const decodePaperKey = (s: string): PaperKey =>
  decode<PaperKey>('buss-paper', s, checkPaperKey);

/** Which wire format a pasted string is, if any. */
export function classifyPaste(s: string): 'request' | 'reply' | 'paper' | null {
  const head = s.trim().split('.')[0];
  if (head === 'buss-req') return 'request';
  if (head === 'buss-sig') return 'reply';
  if (head === 'buss-paper') return 'paper';
  return null;
}

// ── Wasm-backed API ───────────────────────────────────────────────────────────

export interface BussApi {
  /** Fresh recovery secret: a random field element as its canonical 32 bytes. */
  newRecoverySecret(): Uint8Array;
  /** Generate a paper guardian at the given index. Write `sk` down; destroy
   *  the in-memory copy after the backup ceremony. */
  newPaperKey(index: number): PaperKey;
  /**
   * A passport's guardian key, derived from its own device secret so the
   * guardian stores nothing new: sk_G = HtoField(SHA-512(tag ‖ device secret)).
   *
   * Prototype note: a real design derives this from a dedicated recovery role
   * of the account key hierarchy (MIP-0003 surface), so it survives device
   * rotation; the device secret stands in for that hierarchy here.
   */
  guardianSkFromDeviceSecret(deviceSecret: Uint8Array): string;
  /** Guardian side: answer a request with σ derived from the guardian's key. */
  computeSigma(request: GuardianRequest, guardianSkHex: string): GuardianReply;
  /** Paper side: σ for a paper key (the owner, or the recovering party after
   *  typing the slip back in, computes this locally). */
  paperSigma(paper: PaperKey, address: string, sessionNonceHex: string): GuardianReply;
  /** Backup: all n−1 replies (people and paper) → φ as contract-ready bytes. */
  buildPhi(recoverySecret: Uint8Array, replies: GuardianReply[], params: BussParams): Uint8Array[];
  /** Recovery: on-chain φ plus any t+1 replies → the recovery secret. */
  reconstructRecoverySecret(
    phi: Uint8Array[],
    replies: GuardianReply[],
    params: BussParams,
  ): Uint8Array;
}

export function makeBussApi(wasm: BussWasm): BussApi {
  const randomSeed64 = (): Uint8Array => {
    const seed = new Uint8Array(64);
    globalThis.crypto.getRandomValues(seed);
    return seed;
  };

  return {
    newRecoverySecret: () => hexToBytes(wasm.field_from_seed(randomSeed64())),

    newPaperKey: (index) => ({ index, sk: wasm.field_from_seed(randomSeed64()) }),

    guardianSkFromDeviceSecret: (deviceSecret) =>
      wasm.guardian_key(new TextEncoder().encode(GUARDIAN_KEY_TAG), deviceSecret),

    computeSigma: (request, guardianSkHex) => ({
      index: request.index,
      sigma: wasm.guardian_sigma(
        sessionIdBytes(request.address, request.sessionNonce),
        guardianSkHex,
      ),
    }),

    paperSigma: (paper, address, sessionNonceHex) => ({
      index: paper.index,
      sigma: wasm.guardian_sigma(sessionIdBytes(address, sessionNonceHex), paper.sk),
    }),

    buildPhi: (recoverySecret, replies, params) => {
      const phiJson = wasm.buss_share(
        bytesToHex(recoverySecret),
        JSON.stringify(replies),
        params.t,
        params.n,
      );
      return (JSON.parse(phiJson) as string[]).map(hexToBytes);
    },

    reconstructRecoverySecret: (phi, replies, params) =>
      hexToBytes(
        wasm.buss_reconstruct(
          JSON.stringify(phi.map(bytesToHex)),
          JSON.stringify(replies),
          params.t,
          params.n,
        ),
      ),
  };
}
