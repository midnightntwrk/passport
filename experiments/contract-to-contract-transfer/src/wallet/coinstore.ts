// Client-side coin capture and the encrypted-inbox blob format.
//
// mt_index capture is the S5 technique from contract-custody-feasibility:
// the indexer's per-transaction `startIndex`/`endIndex` give the Zswap
// commitment-tree positions this transaction's outputs occupy. For a
// single-output deposit the coin's mt_index IS startIndex; for
// multi-output transactions the caller gets every candidate and must
// disambiguate (the tests try candidates in order — a wrong mt_index
// fails the in-circuit Merkle membership proof, it cannot mis-spend).
//
// Blob format (matches the contract's Bytes<160>):
//   ephemeral X25519 public key (32) ‖ AES-256-GCM IV (12) ‖ GCM tag (16)
//   ‖ ciphertext (80) ‖ zero padding (20)
// Plaintext (80): nonce (32) ‖ colour (32) ‖ value as u128 big-endian (16).
//
// The cipher choice is a stand-in: the probe is about the CHANNEL (opaque
// blob in contract state, key advertised on-ledger), not the scheme. A
// production design would specify a proper ECIES/HPKE construction.

import {
  createPublicKey,
  createPrivateKey,
  generateKeyPairSync,
  diffieHellman,
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { Buffer } from 'node:buffer';

export const BLOB_SIZE = 160;
const PLAINTEXT_SIZE = 80;

// ── X25519 key handling ─────────────────────────────────────────────────────
//
// node:crypto only speaks DER/JWK for raw key material; these fixed DER
// prefixes wrap a raw 32-byte X25519 key into SPKI/PKCS8.

const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

export interface EncKeyPair {
  publicKey: Uint8Array;  // raw 32 bytes — what the contract advertises
  secretKey: Uint8Array;  // raw 32 bytes — wallet private state
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

function sharedSecret(rawSecret: Uint8Array, rawPeerPublic: Uint8Array): Buffer {
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
  const dh = diffieHellman({ privateKey, publicKey });
  return createHash('sha256').update(dh).digest(); // KDF stand-in
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

// ── Sealed blob ─────────────────────────────────────────────────────────────

export function encryptCoinBlob(recipientPublicKey: Uint8Array, coin: PlainCoin): Uint8Array {
  const eph = generateEncKeyPair();
  const key = sharedSecret(eph.secretKey, recipientPublicKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(encodeCoin(coin)), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.alloc(BLOB_SIZE);
  Buffer.from(eph.publicKey).copy(blob, 0);
  iv.copy(blob, 32);
  tag.copy(blob, 44);
  ct.copy(blob, 60);
  return new Uint8Array(blob);
}

export function decryptCoinBlob(recipientSecretKey: Uint8Array, blob: Uint8Array): PlainCoin {
  const b = Buffer.from(blob);
  const ephPub = new Uint8Array(b.subarray(0, 32));
  const iv = b.subarray(32, 44);
  const tag = b.subarray(44, 60);
  const ct = b.subarray(60, 60 + PLAINTEXT_SIZE);
  const key = sharedSecret(recipientSecretKey, ephPub);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return decodeCoin(pt);
}

// ── Indexer mt_index capture (the S5 technique) ─────────────────────────────

export interface TxPosition {
  startIndex?: number;
  endIndex?: number;
  blockHeight?: number;
  status?: string;
  raw?: unknown;
  error?: string;
}

export function indexerUrl(): string {
  return process.env.INDEXER_URL
    ?? process.env.MIDNIGHT_INDEXER_URL
    ?? 'http://localhost:8088/api/v4/graphql';
}

export async function queryTxPosition(txId: string): Promise<TxPosition> {
  const query = `
    query TxPosition($offset: TransactionOffset!) {
      transactions(offset: $offset) {
        id
        hash
        block { height hash }
        ... on RegularTransaction {
          startIndex
          endIndex
          transactionResult { status }
        }
      }
    }
  `.trim();
  try {
    const res = await fetch(indexerUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: { offset: { identifier: txId.replace(/^0x/, '') } },
      }),
    });
    if (!res.ok) return { error: `HTTP ${res.status} ${res.statusText}` };
    const body: any = await res.json();
    if (body?.errors?.length) return { error: `GraphQL errors: ${JSON.stringify(body.errors)}` };
    const t = (body?.data?.transactions ?? [])[0];
    if (!t) return { error: `indexer returned no transaction for identifier ${txId}` };
    return {
      startIndex: Number(t?.startIndex ?? 0),
      endIndex: Number(t?.endIndex ?? 0),
      blockHeight: Number(t?.block?.height ?? 0),
      status: String(t?.transactionResult?.status ?? ''),
      raw: t,
    };
  } catch (e: any) {
    return { error: `fetch failed: ${e?.message ?? String(e)}` };
  }
}

/** mt_index for a transaction expected to carry exactly one shielded output. */
export async function mtIndexForSingleOutput(txId: string): Promise<{ mtIndex: bigint; position: TxPosition }> {
  const position = await queryTxPosition(txId);
  if (position.error) throw new Error(`mt_index capture failed: ${position.error}`);
  const count = (position.endIndex ?? 0) - (position.startIndex ?? 0);
  if (count !== 1) {
    throw new Error(
      `mt_index capture: tx produced ${count} commitments, expected exactly 1 — ` +
      'positional inference declined (see candidateIndices for multi-output txs)',
    );
  }
  return { mtIndex: BigInt(position.startIndex ?? 0), position };
}

/** Every commitment-tree position a multi-output transaction may have used. */
export async function candidateIndices(txId: string): Promise<{ candidates: bigint[]; position: TxPosition }> {
  const position = await queryTxPosition(txId);
  if (position.error) throw new Error(`mt_index capture failed: ${position.error}`);
  const out: bigint[] = [];
  for (let i = position.startIndex ?? 0; i < (position.endIndex ?? 0); i++) out.push(BigInt(i));
  return { candidates: out, position };
}
