import { deepEqual, equal, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { hexToBytes, hexToBytes32 } from '../wallet/hex.js';
import {
  ENTRY_SIZE, generateEncKeyPair, openInboxEntry, sealInboxEntry,
  type PlainCoin,
} from '../wallet/inbox.js';

const coin: PlainCoin = {
  nonce: new Uint8Array(32).fill(0x31),
  color: new Uint8Array(32).fill(0xa7),
  value: 42n,
};

test('hex decoding accepts complete byte pairs and rejects malformed pairs', () => {
  for (const value of ['00a1ff', '0x00A1fF']) {
    deepEqual(hexToBytes(value), new Uint8Array([0, 0xa1, 0xff]));
  }
  for (const value of ['', '0x']) deepEqual(hexToBytes(value), new Uint8Array());
  for (const value of ['zz', '1z', 'z1', '0xgg', ' 01', '01 ', '+1', '-1', '0x0x01', '01\n0', '0\n', '\n\n']) {
    throws(() => hexToBytes(value), /invalid hex encoding|odd-length hex/);
  }
  for (const value of ['a', 'abc', '0xabc']) throws(() => hexToBytes(value), /odd-length hex/);
});

test('hexToBytes32 preserves its documented padding and truncation', () => {
  const padded = new Uint8Array(32);
  padded[0] = 0xa1;
  deepEqual(hexToBytes32('a1'), padded);
  deepEqual(hexToBytes32('ab'.repeat(33)), new Uint8Array(32).fill(0xab));
  throws(() => hexToBytes32('00'.repeat(32) + 'zz'), /invalid hex encoding/);
});

test('inbox preserves the v1 layout and exact uint128 boundary values', () => {
  const keys = generateEncKeyPair();
  for (const value of [0n, 1n, (1n << 128n) - 1n]) {
    const expected = { ...coin, value };
    const sealed = sealInboxEntry(keys.publicKey, expected);
    equal(sealed.length, ENTRY_SIZE);
    deepEqual(sealed.subarray(0, 2), new Uint8Array([1, 1]));
    deepEqual(sealed.subarray(142), new Uint8Array(50));
    deepEqual(openInboxEntry(keys.secretKey, sealed), expected);
  }
});

test('inbox rejects truncated or extended X25519 keys without accepting DER suffixes', () => {
  const keys = generateEncKeyPair();
  const sealed = sealInboxEntry(keys.publicKey, coin);
  for (const length of [0, 31, 33, 64]) {
    const publicKey = new Uint8Array(length);
    publicKey.set(keys.publicKey.subarray(0, length));
    throws(() => sealInboxEntry(publicKey, coin), /exactly 32 bytes/);
    const secretKey = new Uint8Array(length);
    secretKey.set(keys.secretKey.subarray(0, length));
    equal(openInboxEntry(secretKey, sealed), null);
  }
  deepEqual(openInboxEntry(keys.secretKey, sealed), coin);
});

test('inbox rejects low-order recipients and skips unauthenticated records', () => {
  for (const firstByte of [0, 1]) {
    const lowOrder = new Uint8Array(32);
    lowOrder[0] = firstByte;
    throws(() => sealInboxEntry(lowOrder, coin));
  }
  const keys = generateEncKeyPair();
  const sealed = sealInboxEntry(keys.publicKey, coin);
  equal(openInboxEntry(generateEncKeyPair().secretKey, sealed), null);
  const tampered = sealed.slice();
  tampered[62] ^= 1;
  equal(openInboxEntry(keys.secretKey, tampered), null);
  const unknownVersion = sealed.slice();
  unknownVersion[0] = 0xff;
  equal(openInboxEntry(keys.secretKey, unknownVersion), null);
  equal(openInboxEntry(keys.secretKey, sealed.slice(1)), null);
});

test('inbox rejects values that would wrap and malformed coin identifiers', () => {
  const keys = generateEncKeyPair();
  for (const value of [-1n, 1n << 128n, (1n << 128n) + 42n]) {
    throws(() => sealInboxEntry(keys.publicKey, { ...coin, value }), /unsigned 128-bit integer/);
  }
  for (const field of ['nonce', 'color'] as const) {
    for (const length of [0, 31, 33, 64]) {
      throws(() => sealInboxEntry(keys.publicKey, { ...coin, [field]: new Uint8Array(length) }),
        /exactly 32 bytes/);
    }
  }
  deepEqual(openInboxEntry(keys.secretKey, sealInboxEntry(keys.publicKey, coin)), coin);
});
