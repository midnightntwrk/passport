import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  contractAddressBytes,
  deriveMidnamesOwnerKey,
  normalizePassportAlias,
  rawContractAddress,
} from '../src/integrations/midnames/preview.js';

describe('Midnames Passport adapter', () => {
  it('normalizes a .night alias', () => {
    expect(normalizePassportAlias('  Alice.NIGHT. ')).toBe('alice');
  });

  it('rejects invalid and nested aliases', () => {
    expect(() => normalizePassportAlias('-alice')).toThrow(/Alias must/);
    expect(() => normalizePassportAlias('alice.wallet.night')).toThrow(/Alias must/);
  });

  it('normalizes raw and formatted contract addresses', () => {
    const raw = 'ab'.repeat(32);
    expect(rawContractAddress(raw)).toBe(raw);
    expect(rawContractAddress(`0200${raw}`)).toBe(raw);
    expect(contractAddressBytes(`0x${raw}`)).toEqual(new Uint8Array(Buffer.from(raw, 'hex')));
  });

  it('derives the Midnames owner key with the contract domain separator', () => {
    const secret = new Uint8Array(32).fill(7);
    const tag = Buffer.alloc(32);
    tag.write('midnight.domains');
    const expected = createHash('sha256')
      .update(Buffer.concat([tag, Buffer.from(secret)]))
      .digest('hex');
    expect(Buffer.from(deriveMidnamesOwnerKey(secret)).toString('hex')).toBe(expected);
  });
});
