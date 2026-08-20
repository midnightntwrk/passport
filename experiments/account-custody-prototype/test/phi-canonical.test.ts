// φ entries are stored on-chain as Field values, so a non-canonical or
// out-of-range encoding is rejected when the publishing call is built,
// instead of landing on-chain as opaque bytes and blocking every future
// recovery attempt until the owner republishes. These tests pin the
// boundary conversion and the rejection itself.

import { describe, it, expect, beforeEach } from 'vitest';

import { AccountSimulator } from './simulator.js';
import { randomBytes32, bytesToHex } from '../src/wallet/hex.js';
import { recoveryCommitment } from '../src/wallet/contract.js';
import {
  newRecoverySecret,
  newSessionNonce,
  newPaperKey,
  paperSigma,
  buildPhi,
  phiFieldFromBytes,
  phiBytesFromField,
} from '../src/wallet/buss.js';

// BLS12-381 scalar field modulus (the Compact Field modulus).
const FR_MODULUS =
  0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n;

describe('phi field/bytes boundary conversion', () => {
  it('round-trips canonical field encodings from the wasm side', () => {
    const bytes = newRecoverySecret(); // random field element, canonical repr
    expect(phiBytesFromField(phiFieldFromBytes(bytes))).toEqual(bytes);
  });

  it('rejects a repr of the wrong length', () => {
    expect(() => phiFieldFromBytes(new Uint8Array(31))).toThrow(/must be 32 bytes/);
    expect(() => phiFieldFromBytes(new Uint8Array(33))).toThrow(/must be 32 bytes/);
  });

  it('rejects a field value that does not fit in 32 bytes', () => {
    expect(() => phiBytesFromField(1n << 256n)).toThrow(/does not fit in 32 bytes/);
    expect(() => phiBytesFromField(-1n)).toThrow(/non-negative/);
  });

  it('uses little-endian byte order (matches the wasm repr)', () => {
    const bytes = new Uint8Array(32);
    bytes[0] = 0x02; // least significant byte
    expect(phiFieldFromBytes(bytes)).toBe(2n);
  });
});

describe('on-chain canonicity guard', () => {
  let sim: AccountSimulator;

  beforeEach(() => {
    sim = new AccountSimulator({
      deviceSecret: randomBytes32(),
      recoverySecret: newRecoverySecret(),
    });
  });

  const publishWithSlot = (slot: bigint): unknown =>
    sim.call(
      'publish_recovery_backup',
      recoveryCommitment(newRecoverySecret()),
      newSessionNonce(),
      slot,
      0n,
      0n,
      0n,
      1n,
    );

  it('rejects an out-of-range φ value at the call boundary', () => {
    expect(() => publishWithSlot(FR_MODULUS)).toThrow();
    expect(() => publishWithSlot((1n << 256n) - 1n)).toThrow();
  });

  it('accepts the full canonical range and round-trips through the ledger', () => {
    const phiBytes = newRecoverySecret();
    publishWithSlot(phiFieldFromBytes(phiBytes));
    const fromChain = sim.ledger().recovery_phi.lookup(1n);
    expect(phiBytesFromField(fromChain)).toEqual(phiBytes);
  });

  it('preserves the full BUSS round trip through the typed ledger', () => {
    const rotated = newRecoverySecret();
    const nonce = newSessionNonce();
    const nonceHex = bytesToHex(nonce);
    const papers = [1, 2, 3].map(newPaperKey);
    const replies = papers.map((p) => paperSigma(p, sim.address, nonceHex));
    const phi = buildPhi(rotated, replies, { t: 1, n: 4 });

    sim.call(
      'publish_recovery_backup',
      recoveryCommitment(rotated),
      nonce,
      phiFieldFromBytes(phi[0]),
      phiFieldFromBytes(phi[1]),
      0n,
      0n,
      2n,
    );

    const l = sim.ledger();
    const phiFromChain = [
      phiBytesFromField(l.recovery_phi.lookup(1n)),
      phiBytesFromField(l.recovery_phi.lookup(2n)),
    ];
    expect(phiFromChain).toEqual([phi[0], phi[1]]);
  });
});
