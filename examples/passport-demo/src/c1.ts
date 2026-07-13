import type { MidnightWallet, MidnightWalletConnector } from '@dynamic-labs/midnight';
import { MIDNIGHT_NETWORKS } from '@dynamic-labs/midnight';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { signingKeyFromBip340, type WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { createUnprovenDeployTx } from '@midnight-ntwrk/midnight-js-contracts';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

import { Contract, pureCircuits, type Ledger, type Witnesses } from '../.generated/passport-c1/contract/index.js';

export const PASSPORT_C1_ARTIFACT = 'passport-c1-pilot-v1';
export const PASSPORT_C1_NETWORK = 'preview' as const;

export interface PassportC1PrivateState {
  deviceSecretHex: string;
}

export interface PassportC1DeploymentDraft {
  artifact: typeof PASSPORT_C1_ARTIFACT;
  network: typeof PASSPORT_C1_NETWORK;
  contractAddress: string;
  privateStateId: string;
  maintenanceSigningKey: string;
  serializedTransaction: string;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let start = 0; start < bytes.length; start += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(start, start + chunkSize));
  }
  return btoa(binary);
}

function isDynamicTestnet(wallet: MidnightWallet): boolean {
  return (wallet.connector as MidnightWalletConnector).networkId === MIDNIGHT_NETWORKS.TESTNET;
}

function passportC1Witnesses(): Witnesses<PassportC1PrivateState> {
  return {
    device_secret(context: WitnessContext<Ledger, PassportC1PrivateState>): [PassportC1PrivateState, Uint8Array] {
      const secret = hexToBytes(context.privateState.deviceSecretHex);
      return [context.privateState, secret];
    },
  };
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('Passport C1 private state is missing a valid device secret.');
  const result = new Uint8Array(32);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function compiledPassportC1Contract() {
  return CompiledContract.make('passport_c1', Contract).pipe(
    CompiledContract.withWitnesses(passportC1Witnesses()),
    CompiledContract.withCompiledFileAssets('/zk/passport-c1'),
  );
}

/** Generates a C1 maintenance authority from browser CSPRNG output. */
export function createPassportC1MaintenanceSigningKey(): string {
  const source = new Uint8Array(32);
  crypto.getRandomValues(source);
  try {
    return signingKeyFromBip340(source);
  } finally {
    source.fill(0);
  }
}

/**
 * Builds a real Compact deployment transaction from public Dynamic wallet
 * material. The transaction remains unsigned and is never submitted here.
 */
export async function buildPassportC1Deployment(
  wallet: MidnightWallet,
  deviceSecret: Uint8Array,
  maintenanceSigningKey: string,
): Promise<PassportC1DeploymentDraft> {
  if (!isDynamicTestnet(wallet)) {
    throw new Error('Passport C1 pilot deployments are testnet-only. Switch the Dynamic Midnight wallet to testnet before deploying.');
  }
  if (deviceSecret.byteLength !== 32) throw new Error('Passport requires a 32-byte device secret.');
  if (!maintenanceSigningKey) throw new Error('Passport C1 maintenance authority is unavailable.');

  const connector = wallet.connector as MidnightWalletConnector;
  const { shieldedCoinPublicKey, shieldedEncryptionPublicKey } = await connector.getShieldedAddresses();
  if (!shieldedCoinPublicKey || !shieldedEncryptionPublicKey) {
    throw new Error('Dynamic did not return the shielded public keys needed to prepare Passport deployment. Refresh the Midnight wallet and try again.');
  }

  // midnight-js uses a process-wide network id to parse the coin public key.
  // Dynamic maps its testnet wallet to the Midnight "preview" network.
  setNetworkId(PASSPORT_C1_NETWORK);
  const initialPrivateState: PassportC1PrivateState = { deviceSecretHex: bytesToHex(deviceSecret) };
  const providers = {
    zkConfigProvider: new FetchZkConfigProvider(`${window.location.origin}/zk/passport-c1`, window.fetch.bind(window)),
    walletProvider: {
      getCoinPublicKey: () => shieldedCoinPublicKey,
      getEncryptionPublicKey: () => shieldedEncryptionPublicKey,
    },
  };
  const deployment = await createUnprovenDeployTx(providers as never, {
    compiledContract: compiledPassportC1Contract(),
    signingKey: maintenanceSigningKey,
    initialPrivateState,
    args: [pureCircuits.derive_device_commitment(deviceSecret)],
  } as never);
  const contractAddress = String(deployment.public.contractAddress);

  return {
    artifact: PASSPORT_C1_ARTIFACT,
    network: PASSPORT_C1_NETWORK,
    contractAddress,
    privateStateId: `passport-c1:${contractAddress}`,
    maintenanceSigningKey,
    serializedTransaction: toBase64(deployment.private.unprovenTx.serialize()),
  };
}
