// Deploy-or-connect helpers shared by the conformance suites.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { rawTokenType, encodeRawTokenType } from '@midnightntwrk/ledger-v9';

import * as FaucetModule from '../../contracts/managed/faucet/contract/index.js';
import * as ControlModule from '../../contracts/managed/control/contract/index.js';
import { Contract } from '../wallet/contract.js';
import { makeWitnesses } from '../wallet/witnesses.js';
import { CustodyAccount } from '../wallet/account.js';
import type { AnyDevice } from '../wallet/signer.js';
import type { EncKeyPair } from '../wallet/inbox.js';
import {
  createWallet,
  createProviders,
  syncWallet,
  zkConfigPath,
  controlZkConfigPath,
  faucetZkConfigPath,
  type WalletContext,
} from './wallet.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEPLOYMENT_FILE = path.resolve(__dirname, '..', '..', 'deployment.json');

export function compiledAccountContract() {
  return CompiledContract.make('account', Contract).pipe(
    CompiledContract.withWitnesses(makeWitnesses()),
    CompiledContract.withCompiledFileAssets(zkConfigPath),
  );
}

export interface TestContext {
  walletCtx: WalletContext;
  providers: any;
}

export async function setupWallet(seed?: string): Promise<TestContext> {
  const walletSeed = seed ?? process.env.WALLET_SEED;
  if (!walletSeed) throw new Error('WALLET_SEED env var required');
  if (!fs.existsSync(path.join(zkConfigPath, 'contract', 'index.js'))) {
    throw new Error('Contract not compiled. Run: npm run compile');
  }
  const walletCtx = await createWallet(walletSeed);
  await syncWallet(walletCtx, 'funding-wallet');
  const providers = await createProviders(walletCtx);
  return { walletCtx, providers };
}

export async function deployAccount(
  ctx: TestContext,
  device: AnyDevice,
  encKeys: EncKeyPair,
): Promise<CustodyAccount> {
  const account = await CustodyAccount.deploy(
    ctx.providers,
    compiledAccountContract(),
    device,
    encKeys,
  );
  fs.writeFileSync(
    DEPLOYMENT_FILE,
    JSON.stringify(
      { contractAddress: account.address, deployedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  return account;
}

export async function connectAccount(
  ctx: TestContext,
  address: string,
  initialState?: any,
): Promise<CustodyAccount> {
  return CustodyAccount.connect(ctx.providers, compiledAccountContract(), address, initialState);
}

// ── Control contract (leak-audit baseline — conformance test 5 only) ────────

export function compiledControlContract() {
  return CompiledContract.make('control', (ControlModule as any).Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(controlZkConfigPath),
  );
}

export interface ControlHandle {
  address: string;
  providers: any;
  depositPublic: (coin: { nonce: Uint8Array; color: Uint8Array; value: bigint }) => Promise<string>;
  spendPublic: (recipient: Uint8Array, color: Uint8Array, amount: bigint) => Promise<string>;
  ledgerState: () => Promise<any>;
}

export async function deployControl(walletCtx: WalletContext): Promise<ControlHandle> {
  const providers = await createProviders(walletCtx, controlZkConfigPath);
  const deployed = await deployContract(providers, {
    compiledContract: compiledControlContract(),
    privateStateId: 'control',
    initialPrivateState: {},
  } as any);
  const address = deployed.deployTxData.public.contractAddress;
  const idOf = (r: any) => r?.public?.txId ?? r?.public?.transactionHash;
  return {
    address,
    providers,
    depositPublic: async (coin) => idOf(await (deployed as any).callTx.deposit_public(coin)),
    spendPublic: async (recipient, color, amount) =>
      idOf(await (deployed as any).callTx.spend_public({ bytes: recipient }, color, amount)),
    ledgerState: async () => {
      const state = await providers.publicDataProvider.queryContractState(address);
      if (!state) throw new Error(`no contract state at ${address}`);
      return (ControlModule as any).ledger(state.data);
    },
  };
}

// ── Faucet (test scaffolding — token origins on localnet) ───────────────────

export function compiledFaucetContract() {
  return CompiledContract.make('faucet', (FaucetModule as any).Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(faucetZkConfigPath),
  );
}

export interface FaucetHandle {
  address: string;
  providers: any;
  mint: (
    color: Uint8Array,
    amount: bigint,
    nonce: Uint8Array,
    recipientCoinPublicKey: Uint8Array,
  ) => Promise<string>;
  mintUnshielded: (domain: Uint8Array, amount: bigint, recipient: Uint8Array) => Promise<string>;
  mintUnshieldedToContract: (domain: Uint8Array, amount: bigint, contractAddr: Uint8Array) => Promise<string>;
  unshieldedColor: (domain: Uint8Array) => Promise<Uint8Array>;
}

export async function deployFaucet(walletCtx: WalletContext): Promise<FaucetHandle> {
  const providers = await createProviders(walletCtx, faucetZkConfigPath);
  const deployed = await deployContract(providers, {
    compiledContract: compiledFaucetContract(),
    privateStateId: 'faucet',
    initialPrivateState: {},
  } as any);
  const address = deployed.deployTxData.public.contractAddress;
  const idOf = (r: any) => r?.public?.txId ?? r?.public?.transactionHash;
  return {
    address,
    providers,
    mint: async (color, amount, nonce, recipientCoinPublicKey) =>
      idOf(await (deployed as any).callTx.mint_shielded(color, amount, nonce, {
        bytes: recipientCoinPublicKey,
      })),
    mintUnshielded: async (domain, amount, recipient) =>
      idOf(await (deployed as any).callTx.mint_unshielded(domain, amount, { bytes: recipient })),
    mintUnshieldedToContract: async (domain, amount, contractAddr) =>
      idOf(await (deployed as any).callTx.mint_unshielded_to_contract(domain, amount, { bytes: contractAddr })),
    // Derived client-side: the ledger's token-type derivation over
    // (domain, faucet address) — the same rawTokenType used for shielded
    // colors. The on-chain unshielded_color circuit exists as a
    // cross-check but a zero-effect call is wasteful (and its
    // finalisation watch has been observed to hang the wallet SDK).
    unshieldedColor: async (domain) =>
      encodeRawTokenType(rawTokenType(domain, address)),
  };
}
