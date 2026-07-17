// InboxEntry v1 — the fixed 192-byte encrypted coin-description container of
// MIP-0012 §6.4.
//
//   | offset | length | field                                     |
//   |--------|--------|-------------------------------------------|
//   | 0      | 1      | version = 0x01                            |
//   | 1      | 1      | suite   = 0x01 (X25519+HKDF-SHA256+GCM)   |
//   | 2      | 32     | ephemeral X25519 public key               |
//   | 34     | 12     | AEAD nonce                                |
//   | 46     | 16     | AEAD tag                                  |
//   | 62     | 80     | ciphertext                                |
//   | 142    | 50     | zero padding                              |
//
// Plaintext (80 bytes): coin nonce (32) ‖ color (32) ‖ value as unsigned
// 128-bit big-endian (16). AEAD key = HKDF-SHA256(ikm = X25519(eph_sk,
// enc_key), salt = empty, info = "midnight:custody:inbox:v1", L = 32); the
// AEAD associated data is the first two container bytes (version ‖ suite).
// Writers MUST zero the padding; readers MUST ignore it, and MUST skip
// entries with an unknown version or suite rather than error (§6.4), and
// skip entries that fail authentication (§6.5 inbox walk).
//
// All entry cryptography is client-side: the contract stores the container
// as opaque Bytes<192> and never encrypts, decrypts, or inspects it.

import {
  createPublicKey,
  createPrivateKey,
  generateKeyPairSync,
  diffieHellman,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { Buffer } from 'node:buffer';

export const ENTRY_SIZE = 192;
export const ENTRY_VERSION = 0x01;
export const ENTRY_SUITE = 0x01;
const PLAINTEXT_SIZE = 80;
const HKDF_INFO = 'midnight:custody:inbox:v1';

// ── X25519 key handling ─────────────────────────────────────────────────────
//
// node:crypto only speaks DER/JWK for raw key material; these fixed DER
// prefixes wrap a raw 32-byte X25519 key into SPKI/PKCS8.

const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

export interface EncKeyPair {
  publicKey: Uint8Array;  // raw 32 bytes — what the contract advertises as enc_key
  secretKey: Uint8Array;  // raw 32 bytes — the viewing capability (MIP-0012 R9)
}

export function generateEncKeyPair(): EncKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
  return {
    publicKey: new Uint8Array(spki.subarray(spki.length - 32)),
    secretKey: new Uint8Array(pkcs8.subarray(pkcs8.length - 32)),
  };
}

function x25519(rawSecret: Uint8Array, rawPeerPublic: Uint8Array): Buffer {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(rawSecret)]),
    type: 'pkcs8',
    format: 'der',
  });
  const publicKey = createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(rawPeerPublic)]),
    type: 'spki',
    format: 'der',
  });
  return diffieHellman({ privateKey, publicKey });
}

function deriveAeadKey(ikm: Buffer): Buffer {
  // RFC 5869 with an empty salt (the RFC default) and L = 32.
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), HKDF_INFO, 32));
}

// ── Coin plaintext codec ────────────────────────────────────────────────────

export interface PlainCoin {
  nonce: Uint8Array;
  color: Uint8Array;
  value: bigint;
}

function encodeCoin(coin: PlainCoin): Buffer {
  const out = Buffer.alloc(PLAINTEXT_SIZE);
  Buffer.from(coin.nonce).copy(out, 0);
  Buffer.from(coin.color).copy(out, 32);
  let v = coin.value;
  for (let i = 15; i >= 0; i--) {
    out[64 + i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function decodeCoin(buf: Buffer): PlainCoin {
  let value = 0n;
  for (let i = 0; i < 16; i++) value = (value << 8n) | BigInt(buf[64 + i]);
  return {
    nonce: new Uint8Array(buf.subarray(0, 32)),
    color: new Uint8Array(buf.subarray(32, 64)),
    value,
  };
}

// ── Sealed entry ────────────────────────────────────────────────────────────

export function sealInboxEntry(recipientEncKey: Uint8Array, coin: PlainCoin): Uint8Array {
  const eph = generateEncKeyPair();
  const key = deriveAeadKey(x25519(eph.secretKey, recipientEncKey));
  const nonce = randomBytes(12);
  const ad = Buffer.from([ENTRY_VERSION, ENTRY_SUITE]);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(ad);
  const ct = Buffer.concat([cipher.update(encodeCoin(coin)), cipher.final()]);
  const tag = cipher.getAuthTag();

  const entry = Buffer.alloc(ENTRY_SIZE); // trailing padding stays zero
  entry[0] = ENTRY_VERSION;
  entry[1] = ENTRY_SUITE;
  Buffer.from(eph.publicKey).copy(entry, 2);
  nonce.copy(entry, 34);
  tag.copy(entry, 46);
  ct.copy(entry, 62);
  return new Uint8Array(entry);
}

/**
 * Open an entry with the account encryption secret. Returns the coin, or
 * null when the entry must be skipped (unknown version or suite, wrong
 * length, or failed authentication) — the §6.5 walk treats those entries as
 * absent, never as errors.
 */
export function openInboxEntry(encSecretKey: Uint8Array, entry: Uint8Array): PlainCoin | null {
  if (entry.length !== ENTRY_SIZE) return null;
  const b = Buffer.from(entry);
  if (b[0] !== ENTRY_VERSION || b[1] !== ENTRY_SUITE) return null;
  try {
    const ephPub = new Uint8Array(b.subarray(2, 34));
    const nonce = b.subarray(34, 46);
    const tag = b.subarray(46, 62);
    const ct = b.subarray(62, 62 + PLAINTEXT_SIZE);
    const key = deriveAeadKey(x25519(encSecretKey, ephPub));
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(b.subarray(0, 2));
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return decodeCoin(pt);
  } catch {
    return null; // authentication failure — not our entry, or poisoned (S3)
  }
}
