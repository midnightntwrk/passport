// Independent byte recipes for test fixtures. Unlike the generated helpers,
// these deliberately accept arbitrary coordinates so tests can plant opaque
// entries for legacy weak keys, then exercise rejection at authorisation.
// Valid-key controls in unit-offline check these recipes against the compiler.

import { createHash } from 'node:crypto';

const hash = (...parts: Uint8Array[]): Uint8Array => {
  const h = createHash('sha256');
  for (const part of parts) h.update(part);
  return new Uint8Array(h.digest());
};

const tag = (text: string, width = 32): Uint8Array => {
  const bytes = Buffer.from(text, 'ascii');
  if (bytes.length > width) throw new Error('fixture tag exceeds width');
  const out = new Uint8Array(width);
  out.set(bytes);
  return out;
};

const le = (value: bigint, width: number): Uint8Array => {
  if (value < 0n || value >= (1n << BigInt(8 * width))) throw new Error('fixture integer out of range');
  const out = new Uint8Array(width);
  for (let i = 0; i < width; i++, value >>= 8n) out[i] = Number(value & 255n);
  return out;
};

type Coordinates = { x: bigint; y: bigint };

export function k256DeviceEntryFixture(
  address: Uint8Array, pk: Coordinates, envelope: bigint, epoch: bigint, counter: bigint,
): Uint8Array {
  return hash(tag('midnight:account:device:k1:v2'), address, le(pk.x, 32), le(pk.y, 32),
    le(envelope, 1), le(epoch, 4), le(counter, 8));
}

export function k256GrantIdFixture(
  address: Uint8Array, pk: Coordinates, envelope: bigint, origin: Uint8Array, slot: bigint,
): Uint8Array {
  return hash(tag('midnight:account:grant:id:k1:v1'), address, le(pk.x, 32), le(pk.y, 32),
    le(envelope, 1), origin, le(slot, 1));
}

export function k256AddDeviceChallengeFixture(
  address: Uint8Array, pk: Coordinates, entry: Uint8Array, nonce: bigint,
): Uint8Array {
  return hash(hash(tag('midnight:account:auth:k1:v1:add_device', 64)), address,
    le(pk.x, 32), le(pk.y, 32), entry, le(nonce, 8));
}
