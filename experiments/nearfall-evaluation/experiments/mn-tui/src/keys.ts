import * as bip39                                     from 'bip39';
import { Buffer }                                      from 'buffer';
import { HDWallet, Roles }                             from '@midnight-ntwrk/wallet-sdk-hd';
import { ZswapSecretKeys, DustSecretKey }              from '@midnight-ntwrk/ledger-v7';
import {
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
  DustAddress,
  MidnightBech32m,
}                                                      from '@midnight-ntwrk/wallet-sdk-address-format';
import { createKeystore }                              from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { setNetworkId }                                from '@midnight-ntwrk/midnight-js-network-id';
import * as openpgp                                    from 'openpgp';
import type { NetworkName }                            from './types.js';

// ---------------------------------------------------------------------------
// Address derivation
// ---------------------------------------------------------------------------

export interface DerivedAddresses {
  unshielded: string;
  shielded:   string;
  dust:       string;
}

function deriveRawKeys(seed: string) {
  const hdWallet = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hdWallet.type !== 'seedOk') throw new Error('Invalid seed');
  const result = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (result.type !== 'keysDerived') throw new Error('Key derivation failed');
  hdWallet.hdWallet.clear();
  return result.keys;
}

export async function deriveFromMnemonic(
  mnemonic:    string,
  networkName: NetworkName,
): Promise<DerivedAddresses> {
  const trimmed = mnemonic.trim();
  if (!bip39.validateMnemonic(trimmed))
    throw new Error('Invalid mnemonic (bad checksum or unknown words)');

  setNetworkId(networkName);

  const seed = await bip39.mnemonicToSeed(trimmed).then(b => b.toString('hex'));
  const keys = deriveRawKeys(seed);

  // createKeystore derives the Ed25519 public key from the secret key internally;
  // passing the secret key directly to UnshieldedAddress produces the wrong address.
  // MidnightBech32m.encode() returns an object, not a string primitive — toString()
  // is typed incorrectly in 3.0.0, so we cast to any first.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const unshielded: string = (createKeystore(keys[Roles.NightExternal], networkName).getBech32Address() as any).toString();

  const zswapKeys = ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const shielded:  string = (MidnightBech32m.encode(
    networkName,
    new ShieldedAddress(
      ShieldedCoinPublicKey.fromHexString(zswapKeys.coinPublicKey),
      ShieldedEncryptionPublicKey.fromHexString(zswapKeys.encryptionPublicKey),
    ),
  ) as any).toString();

  const dustKey = DustSecretKey.fromSeed(keys[Roles.Dust]);
  const dust: string = DustAddress.encodePublicKey(networkName, dustKey.publicKey);
  /* eslint-enable */

  return { unshielded, shielded, dust };
}

// ---------------------------------------------------------------------------
// Symmetric OpenPGP encryption (equivalent to gpg -c --armor)
// ---------------------------------------------------------------------------

/** Encrypt a mnemonic with a passphrase; returns an ASCII-armored PGP message. */
export async function encryptMnemonic(mnemonic: string, passphrase: string): Promise<string> {
  const message   = await openpgp.createMessage({ text: mnemonic });
  const encrypted = await openpgp.encrypt({ message, passwords: [passphrase], format: 'armored' });
  return encrypted as string;
}

/** Decrypt an ASCII-armored PGP message produced by encryptMnemonic or gpg -c --armor. */
export async function decryptMnemonic(armoredCiphertext: string, passphrase: string): Promise<string> {
  const message    = await openpgp.readMessage({ armoredMessage: armoredCiphertext });
  const { data }   = await openpgp.decrypt({ message, passwords: [passphrase] });
  return data as string;
}
