/**
 * The MetaMask device rules, drilled against a FIXED vector.
 *
 * WHY A FIXED VECTOR AND NOT "the same twice"
 * ------------------------------------------
 * The whole scheme rests on one claim: the same MetaMask account signing the
 * same message always yields the same device, on every machine and every
 * build. Asserting that two calls in one process agree proves only that the
 * function is not random. What proves the claim is a signature captured once,
 * from a known secp256k1 key, checked in here as a literal — so a change to the
 * salt, the info string, the message text, or the byte order fails this file
 * rather than silently un-pairing every device already on an account.
 *
 * THE VECTOR
 * ----------
 * Private key `0x00…2a` over secp256k1, whose Ethereum account address is
 * `0xae3dffee97f92db0201d11cb8877c89738353bce`, signing the message this module
 * builds for the account address below, EIP-191 style
 * (`\x19Ethereum Signed Message:\n<len>` ‖ message, keccak-256, RFC 6979).
 * The signature was produced with `@noble/curves` 2.3.0 and is reproduced by
 * `e2e/support/metamaskStub.ts`, which is what the live browser walk signs
 * with — so the browser and this file are proving the same derivation.
 */

import { describe, expect, it } from 'vitest';

import {
  METAMASK_DEVICE_MESSAGE_VERSION,
  MetamaskDeviceError,
  deriveMetamaskSeed,
  metamaskDeviceEnabled,
  metamaskDeviceMessage,
  metamaskSeedProvider,
  normaliseEthereumAddress,
  pairedDeviceFor,
  pairedDevicesForAccount,
  parsePairedDevices,
  personalSignatureBytes,
  serialisePairedDevices,
  shortEthereumAddress,
  withPairedDevice,
  withoutPairedDevice,
  type PairedMetamaskDevice,
} from './metamaskDevice.js';

/* -------------------------------------------------------------------------- */
/* The vector                                                                 */
/* -------------------------------------------------------------------------- */

const VECTOR_ADDRESS = '0xae3dffee97f92db0201d11cb8877c89738353bce';
const VECTOR_ACCOUNT =
  '0200aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
const VECTOR_NETWORK = 'stagenet';
const VECTOR_SIGNATURE =
  '0x3100457c20459a04732503ea36a252ba5bc96a00d64554c6e1e97de5f2e9674b7c907e64a1cdaa578bdb4cf2af59cca780746eb04c910cefd59dde6bf5ff3ec61b';

/** `APP_ID` in `src/App.tsx`. */
const APP_ID = 'org.midnight.passport.demo';
/** `PASSPORT_CONTRACT_SCOPE` in `src/App.tsx`. */
const CONTRACT_SCOPE = { appId: APP_ID, accountId: 'passport-contract-v1' };
/** The scope the MetaMask device's own wallet is opened under. */
const WALLET_SCOPE = { appId: APP_ID, accountId: `metamask-${VECTOR_ADDRESS}` };

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

function device(overrides: Partial<PairedMetamaskDevice> = {}): PairedMetamaskDevice {
  return {
    address: VECTOR_ADDRESS,
    accountAddress: VECTOR_ACCOUNT,
    network: VECTOR_NETWORK,
    commitmentHex: 'a'.repeat(64),
    name: 'ada',
    pairedAt: '2026-09-04T09:00:00.000Z',
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* The message                                                                */
/* -------------------------------------------------------------------------- */

describe('metamaskDeviceMessage', () => {
  it('is exactly the three lines MetaMask is asked to sign', () => {
    expect(metamaskDeviceMessage({ network: VECTOR_NETWORK, accountAddress: VECTOR_ACCOUNT })).toBe(
      `Midnight Passport device key v1\nnetwork: stagenet\naccount: ${VECTOR_ACCOUNT}`,
    );
  });

  it('opens with the version, so a v2 derives different devices', () => {
    expect(
      metamaskDeviceMessage({ network: VECTOR_NETWORK, accountAddress: VECTOR_ACCOUNT }).startsWith(
        METAMASK_DEVICE_MESSAGE_VERSION,
      ),
    ).toBe(true);
  });

  it('refuses an empty network rather than signing a message with a hole in it', () => {
    expect(() => metamaskDeviceMessage({ network: '', accountAddress: VECTOR_ACCOUNT })).toThrow(
      /needs a network/,
    );
  });

  it('refuses a network that is not a string at all', () => {
    expect(() =>
      metamaskDeviceMessage({
        network: undefined as unknown as string,
        accountAddress: VECTOR_ACCOUNT,
      }),
    ).toThrow(MetamaskDeviceError);
  });

  it('refuses an empty account', () => {
    expect(() => metamaskDeviceMessage({ network: VECTOR_NETWORK, accountAddress: '' })).toThrow(
      /needs a account/,
    );
  });

  it('refuses whitespace rather than trimming it, because trimming derives a different device', () => {
    expect(() =>
      metamaskDeviceMessage({ network: ' stagenet', accountAddress: VECTOR_ACCOUNT }),
    ).toThrow(/whitespace/);
  });

  it('refuses a line break, which could forge the lines below it', () => {
    expect(() =>
      metamaskDeviceMessage({ network: 'stagenet\naccount: mine', accountAddress: VECTOR_ACCOUNT }),
    ).toThrow(/line break/);
  });

  it('carries the code and the name on the error', () => {
    try {
      metamaskDeviceMessage({ network: '', accountAddress: VECTOR_ACCOUNT });
      expect.unreachable('an empty network must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(MetamaskDeviceError);
      expect((error as MetamaskDeviceError).code).toBe('invalid-message');
      expect((error as MetamaskDeviceError).name).toBe('MetamaskDeviceError');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Addresses                                                                  */
/* -------------------------------------------------------------------------- */

describe('normaliseEthereumAddress', () => {
  it('lower-cases, so one account is never two devices', () => {
    expect(normaliseEthereumAddress('0xAE3DffEE97F92DB0201D11CB8877C89738353BCE')).toBe(
      VECTOR_ADDRESS,
    );
  });

  it('refuses anything that is not a 20-byte 0x address', () => {
    expect(() => normaliseEthereumAddress('0xabc')).toThrow(/not a MetaMask account address/);
  });

  it('refuses a non-string', () => {
    expect(() => normaliseEthereumAddress(null as unknown as string)).toThrow(MetamaskDeviceError);
  });
});

describe('shortEthereumAddress', () => {
  it('keeps both ends, which is what a person recognises', () => {
    expect(shortEthereumAddress(VECTOR_ADDRESS)).toBe('0xae3d…3bce');
  });
});

/* -------------------------------------------------------------------------- */
/* Signatures                                                                 */
/* -------------------------------------------------------------------------- */

describe('personalSignatureBytes', () => {
  it('reads the 65 bytes of the vector signature', () => {
    const bytes = personalSignatureBytes(VECTOR_SIGNATURE);
    expect(bytes).toHaveLength(65);
    expect(hex(bytes)).toBe(VECTOR_SIGNATURE.slice(2));
    /* The recovery byte, which is the one a length check alone would miss. */
    expect(bytes[64]).toBe(0x1b);
  });

  it('refuses something that is not hex', () => {
    expect(() => personalSignatureBytes('not a signature')).toThrow(/Passport can read/);
  });

  it('refuses a non-string', () => {
    expect(() => personalSignatureBytes(undefined as unknown as string)).toThrow(
      MetamaskDeviceError,
    );
  });

  it('names the length it got when it is the wrong one', () => {
    expect(() => personalSignatureBytes('0xdeadbeef')).toThrow(/returned 4 bytes/);
  });
});

/* -------------------------------------------------------------------------- */
/* Derivation                                                                 */
/* -------------------------------------------------------------------------- */

describe('deriveMetamaskSeed', () => {
  it('turns the vector signature into the contract root secret, byte for byte', async () => {
    const seed = await deriveMetamaskSeed(personalSignatureBytes(VECTOR_SIGNATURE), CONTRACT_SCOPE);
    expect(seed).toHaveLength(32);
    expect(hex(seed)).toBe('0a993b41b0605aaeb6247f992ec9c5436e68aa3e829bc9cd8abfb79d554fb604');
  });

  it('turns the same signature into a DIFFERENT wallet seed, byte for byte', async () => {
    const seed = await deriveMetamaskSeed(personalSignatureBytes(VECTOR_SIGNATURE), WALLET_SCOPE);
    expect(hex(seed)).toBe('93c88cc2d2c371ce1f6aba9a45d5fc8bdd4d0467d964c06aad328ecf2b36ec8d');
  });

  it('separates the two scopes — the wallet seed is not the contract root', async () => {
    const signature = personalSignatureBytes(VECTOR_SIGNATURE);
    const [contract, wallet] = await Promise.all([
      deriveMetamaskSeed(signature, CONTRACT_SCOPE),
      deriveMetamaskSeed(signature, WALLET_SCOPE),
    ]);
    expect(hex(contract)).not.toBe(hex(wallet));
  });

  it('refuses a signature that is not 65 bytes', async () => {
    await expect(deriveMetamaskSeed(new Uint8Array(32), CONTRACT_SCOPE)).rejects.toThrow(
      /received 32/,
    );
  });

  it('refuses a scope with no appId', async () => {
    await expect(
      deriveMetamaskSeed(personalSignatureBytes(VECTOR_SIGNATURE), {
        appId: '',
        accountId: 'x',
      }),
    ).rejects.toThrow(/needs a appId/);
  });

  it("refuses a scope field carrying the ':' the info string glues with", async () => {
    await expect(
      deriveMetamaskSeed(personalSignatureBytes(VECTOR_SIGNATURE), {
        appId: APP_ID,
        accountId: 'a:b',
      }),
    ).rejects.toThrow(/needs a accountId/);
  });

  it('refuses no scope at all', async () => {
    await expect(
      deriveMetamaskSeed(
        personalSignatureBytes(VECTOR_SIGNATURE),
        undefined as unknown as { appId: string; accountId: string },
      ),
    ).rejects.toThrow(MetamaskDeviceError);
  });
});

describe('metamaskSeedProvider', () => {
  it('answers the same question a discovered passkey answers', async () => {
    const provider = metamaskSeedProvider(personalSignatureBytes(VECTOR_SIGNATURE));
    expect(hex(await provider.deriveWalletSeed(CONTRACT_SCOPE))).toBe(
      '0a993b41b0605aaeb6247f992ec9c5436e68aa3e829bc9cd8abfb79d554fb604',
    );
    provider.dispose();
  });

  it('copies the signature, so the caller may zero their own bytes', async () => {
    const signature = personalSignatureBytes(VECTOR_SIGNATURE);
    const provider = metamaskSeedProvider(signature);
    signature.fill(0);
    expect(hex(await provider.deriveWalletSeed(CONTRACT_SCOPE))).toBe(
      '0a993b41b0605aaeb6247f992ec9c5436e68aa3e829bc9cd8abfb79d554fb604',
    );
    provider.dispose();
  });

  it('derives nothing once disposed — the signature IS the device', async () => {
    const provider = metamaskSeedProvider(personalSignatureBytes(VECTOR_SIGNATURE));
    provider.dispose();
    await expect(provider.deriveWalletSeed(CONTRACT_SCOPE)).rejects.toThrow(/already been disposed/);
  });

  it('is safe to dispose twice', () => {
    const provider = metamaskSeedProvider(personalSignatureBytes(VECTOR_SIGNATURE));
    provider.dispose();
    expect(() => provider.dispose()).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* The pairing record                                                         */
/* -------------------------------------------------------------------------- */

describe('parsePairedDevices', () => {
  it('reads back what it wrote', () => {
    const rows = [device()];
    expect(parsePairedDevices(serialisePairedDevices(rows))).toEqual(rows);
  });

  it('accepts a row with no name', () => {
    expect(parsePairedDevices(serialisePairedDevices([device({ name: null })]))).toHaveLength(1);
  });

  it('is an empty list for nothing stored', () => {
    expect(parsePairedDevices(null)).toEqual([]);
  });

  it('is an empty list for an empty string', () => {
    expect(parsePairedDevices('')).toEqual([]);
  });

  it('is an empty list rather than a throw for corrupt JSON', () => {
    expect(parsePairedDevices('{not json')).toEqual([]);
  });

  it('is an empty list for JSON that is not an array', () => {
    expect(parsePairedDevices('{"address":"0x1"}')).toEqual([]);
  });

  it.each([
    ['a row that is not an object', 'nope'],
    ['a null row', null],
    ['no address', { ...device(), address: undefined }],
    ['a checksummed address, which is not the stored form', { ...device(), address: VECTOR_ADDRESS.toUpperCase() }],
    ['no account', { ...device(), accountAddress: undefined }],
    ['an empty account', { ...device(), accountAddress: '' }],
    ['no network', { ...device(), network: undefined }],
    ['an empty network', { ...device(), network: '' }],
    ['no commitment', { ...device(), commitmentHex: undefined }],
    ['a short commitment', { ...device(), commitmentHex: 'ab' }],
    ['a name that is neither a string nor null', { ...device(), name: 7 }],
    ['no pairedAt', { ...device(), pairedAt: undefined }],
  ])('drops %s rather than refusing the whole list', (_label, row) => {
    const good = device({ address: '0x' + '1'.repeat(40) });
    expect(parsePairedDevices(JSON.stringify([row, good]))).toEqual([good]);
  });
});

describe('pairedDeviceFor', () => {
  it('finds a row stored in lower case from a checksummed address', () => {
    expect(pairedDeviceFor([device()], VECTOR_ADDRESS.toUpperCase().replace('0X', '0x'))).toEqual(
      device(),
    );
  });

  it('is null for an address nothing was paired for', () => {
    expect(pairedDeviceFor([device()], '0x' + '2'.repeat(40))).toBeNull();
  });
});

describe('withPairedDevice', () => {
  it('adds a pairing', () => {
    expect(withPairedDevice([], device())).toEqual([device()]);
  });

  it('normalises the address on the way in', () => {
    const [stored] = withPairedDevice([], device({ address: VECTOR_ADDRESS.toUpperCase().replace('0X', '0x') }));
    expect(stored.address).toBe(VECTOR_ADDRESS);
  });

  it('replaces the row for the same MetaMask account on the same Passport', () => {
    const first = device({ commitmentHex: 'b'.repeat(64) });
    const again = device({ commitmentHex: 'c'.repeat(64) });
    expect(withPairedDevice([first], again)).toEqual([again]);
  });

  it('keeps the same MetaMask account paired to a DIFFERENT Passport', () => {
    const other = device({ accountAddress: '0200' + 'f'.repeat(64) });
    expect(withPairedDevice([other], device())).toEqual([other, device()]);
  });

  it('keeps a different MetaMask account on the same Passport', () => {
    const other = device({ address: '0x' + '3'.repeat(40) });
    expect(withPairedDevice([other], device())).toEqual([other, device()]);
  });

  it('refuses a record it could not read back', () => {
    expect(() => withPairedDevice([], device({ commitmentHex: 'nope' }))).toThrow(
      /not a MetaMask pairing/,
    );
  });
});

describe('withoutPairedDevice', () => {
  it('removes the pairing named', () => {
    expect(withoutPairedDevice([device()], VECTOR_ADDRESS, VECTOR_ACCOUNT)).toEqual([]);
  });

  it('leaves another MetaMask account alone', () => {
    const other = device({ address: '0x' + '4'.repeat(40) });
    expect(withoutPairedDevice([other], VECTOR_ADDRESS, VECTOR_ACCOUNT)).toEqual([other]);
  });

  it('leaves the same MetaMask account on another Passport alone', () => {
    const other = device({ accountAddress: '0200' + 'e'.repeat(64) });
    expect(withoutPairedDevice([other], VECTOR_ADDRESS, VECTOR_ACCOUNT)).toEqual([other]);
  });
});

describe('pairedDevicesForAccount', () => {
  it('is the rows for one Passport, in the order they were paired', () => {
    const mine = device();
    const theirs = device({ address: '0x' + '5'.repeat(40), accountAddress: '0200' + 'd'.repeat(64) });
    expect(pairedDevicesForAccount([mine, theirs], VECTOR_ACCOUNT)).toEqual([mine]);
  });
});

/* -------------------------------------------------------------------------- */
/* The flag                                                                   */
/* -------------------------------------------------------------------------- */

describe('metamaskDeviceEnabled', () => {
  it('is on for the literal 1', () => {
    expect(metamaskDeviceEnabled({ VITE_METAMASK_DEVICE: '1' })).toBe(true);
  });

  it.each([undefined, '', '0', 'true', 'yes'])('is off for %o', (value) => {
    expect(metamaskDeviceEnabled({ VITE_METAMASK_DEVICE: value })).toBe(false);
  });
});
