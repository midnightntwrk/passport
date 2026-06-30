// Lazily-initialised Midnight context shared by the whole app:
// genesis fee wallet (synced), providers for the account and faucet
// contracts, and the faucet handle.

import { firstValueFrom } from 'rxjs';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';

import {
  createWallet,
  createProviders,
  awaitSync,
  compiledFaucetContract,
  type WalletContext,
  GENESIS_SEED,
} from './providers.js';

declare const __FAUCET_ADDRESS__: string;

export interface Midnight {
  walletCtx: WalletContext;
  accountProviders: any;
  faucetProviders: any;
  nightColorHex: string;
  faucetAddress: string;
}

let booted: Promise<Midnight> | null = null;

export function getMidnight(): Promise<Midnight> {
  if (!booted) booted = init();
  return booted;
}

async function init(): Promise<Midnight> {
  const walletCtx = await createWallet(GENESIS_SEED);
  const state = await awaitSync(walletCtx);

  const held = Object.entries(state.unshielded.balances as Record<string, bigint>);
  if (held.length === 0) {
    throw new Error('Genesis wallet holds no Night — is the localnet up and seeded?');
  }
  const [nightColorHex] = held[0];

  const accountProviders = await createProviders(walletCtx, 'account');
  const faucetProviders = await createProviders(walletCtx, 'faucet');

  return {
    walletCtx,
    accountProviders,
    faucetProviders,
    nightColorHex,
    faucetAddress: __FAUCET_ADDRESS__ ?? '',
  };
}

export async function walletState(mid: Midnight): Promise<any> {
  return firstValueFrom(mid.walletCtx.wallet.state());
}

let faucetHandle: { address: string; handle: any } | null = null;

export async function getFaucet(mid: Midnight, address: string): Promise<any> {
  if (faucetHandle?.address === address) return faucetHandle.handle;
  const handle = await (findDeployedContract as any)(mid.faucetProviders, {
    contractAddress: address,
    compiledContract: compiledFaucetContract(),
    privateStateId: 'faucet-demo',
    initialPrivateState: {},
  });
  faucetHandle = { address, handle };
  return handle;
}
