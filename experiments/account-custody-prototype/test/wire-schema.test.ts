// The copy-paste wire formats must reject a tampered or corrupted payload
// at decode time with a legible error, instead of letting a mistyped object
// (sigma as a number, a missing index) propagate into wasm.guardian_sigma
// or buss_reconstruct.

import { describe, it, expect } from 'vitest';
import {
  encodeGuardianRequest,
  decodeGuardianRequest,
  encodeGuardianReply,
  decodeGuardianReply,
  encodePaperKey,
  decodePaperKey,
} from '../src/wallet/buss-core.js';

const b64url = (v: unknown): string =>
  Buffer.from(JSON.stringify(v)).toString('base64url');

const HEX32 = 'ab'.repeat(32);

describe('wire format schema validation', () => {
  it('round-trips well-formed payloads', () => {
    const req = { address: '0200aabb', sessionNonce: HEX32, index: 3 };
    expect(decodeGuardianRequest(encodeGuardianRequest(req))).toEqual(req);

    const reply = { index: 2, sigma: HEX32 };
    expect(decodeGuardianReply(encodeGuardianReply(reply))).toEqual(reply);

    const paper = { index: 1, sk: HEX32 };
    expect(decodePaperKey(encodePaperKey(paper))).toEqual(paper);
  });

  it('rejects sigma present as a number instead of a hex string', () => {
    const s = `buss-sig.v0.${b64url({ index: 2, sigma: 12345 })}`;
    expect(() => decodeGuardianReply(s)).toThrow(/sigma must be 32 bytes of hex/);
  });

  it('rejects a sigma of the wrong length', () => {
    const s = `buss-sig.v0.${b64url({ index: 2, sigma: 'ab'.repeat(16) })}`;
    expect(() => decodeGuardianReply(s)).toThrow(/sigma must be 32 bytes of hex/);
  });

  it('rejects a missing or non-positive index', () => {
    expect(() => decodeGuardianReply(`buss-sig.v0.${b64url({ sigma: HEX32 })}`)).toThrow(
      /index must be a positive integer/,
    );
    expect(() =>
      decodeGuardianReply(`buss-sig.v0.${b64url({ index: 0, sigma: HEX32 })}`),
    ).toThrow(/index must be a positive integer/);
    expect(() =>
      decodeGuardianReply(`buss-sig.v0.${b64url({ index: 1.5, sigma: HEX32 })}`),
    ).toThrow(/index must be a positive integer/);
  });

  it('rejects a request with a malformed session nonce or empty address', () => {
    expect(() =>
      decodeGuardianRequest(
        `buss-req.v0.${b64url({ address: '0200aabb', sessionNonce: 'xyz', index: 1 })}`,
      ),
    ).toThrow(/sessionNonce must be 32 bytes of hex/);
    expect(() =>
      decodeGuardianRequest(
        `buss-req.v0.${b64url({ address: '', sessionNonce: HEX32, index: 1 })}`,
      ),
    ).toThrow(/address must be a non-empty string/);
  });

  it('rejects a paper key whose sk is not a 32-byte hex string', () => {
    expect(() => decodePaperKey(`buss-paper.v0.${b64url({ index: 1, sk: 42 })}`)).toThrow(
      /sk must be 32 bytes of hex/,
    );
  });

  it('rejects a non-object payload', () => {
    expect(() => decodeGuardianReply(`buss-sig.v0.${b64url(42)}`)).toThrow(
      /payload is not an object/,
    );
  });

  it('rejects corrupted base64url with a legible error', () => {
    expect(() => decodeGuardianReply('buss-sig.v0.%%%%')).toThrow(
      /not valid base64url JSON/,
    );
  });

  it('tolerates unknown extra fields (forward compatibility)', () => {
    const s = `buss-sig.v0.${b64url({ index: 2, sigma: HEX32, note: 'later-version field' })}`;
    expect(decodeGuardianReply(s).sigma).toBe(HEX32);
  });
});
