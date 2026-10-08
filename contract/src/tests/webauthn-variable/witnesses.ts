import type { JsonAdvice, SplitWord, Witnesses } from '../../../contracts/managed/probe-webauthn-variable/contract/index.js';

export const MAX_CLIENT_BYTES = 256;
export const MAX_ORIGIN_BYTES = 96;
export type PrivateState = Record<string, never>;
export const padded = (bytes: Uint8Array, capacity: number): Uint8Array => {
  if (bytes.length > capacity) throw new Error('buffer capacity exceeded');
  const out = new Uint8Array(capacity); out.set(bytes); return out;
};

export const splitWord = (value: bigint): SplitWord => ({
  bits: Array.from({ length: 32 }, (_, i) => ((value >> BigInt(i)) & 1n) === 1n),
  carry: value >> 32n,
});

// Convenience/diagnostic parsing only. A malicious prover can replace this
// function. The Compact circuit independently enforces its stated profile.
export const inspectJSON = (data: Uint8Array, length: bigint): JsonAdvice => {
  if (length < 0n || length > BigInt(MAX_CLIENT_BYTES)) throw new Error('invalid client length');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, Number(length)));
  const parsed = JSON.parse(text);
  if (typeof parsed.origin !== 'string') throw new Error('missing origin');
  const origin = new TextEncoder().encode(parsed.origin);
  return {
    origin: padded(origin, MAX_ORIGIN_BYTES),
    origin_length: BigInt(origin.length),
    prefix_length: 112n + BigInt(origin.length),
  };
};

export const witnesses: Witnesses<PrivateState> = {
  split_word: ({ privateState }, value) => [privateState, splitWord(value)],
  inspect_json: ({ privateState }, data, length) => [privateState, inspectJSON(data, length)],
};
