// Deploy-or-connect helpers for the integration tests.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';

import * as FaucetModule from '../../contracts/managed/faucet/contract/index.js';
import { Contract as IdentityRegistryContract, IdentityRegistry } from '../wallet/identity.js';
import { Contract } from '../wallet/contract.js';
import { makeWitnesses } from '../wallet/witnesses.js';
import { PassportAccount, type AccountSecrets } from '../wallet/account.js';
import {
  createWallet,
  createProviders,
  syncWallet,
  zkConfigPath,
  faucetZkConfigPath,
  identityRegistryZkConfigPath,
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
  if (!fs.existsSync(path.join(identityRegistryZkConfigPath, 'contract', 'index.js'))) {
    throw new Error('Identity registry contract not compiled. Run: npm run compile');
  }
  const walletCtx = await createWallet(walletSeed);
  await syncWallet(walletCtx, 'funding-wallet');
  const providers = await createProviders(walletCtx);
  return { walletCtx, providers };
}

export async function deployAccount(
  ctx: TestContext,
  secrets: { deviceSecret: Uint8Array; recoverySecret: Uint8Array },
): Promise<PassportAccount> {
  const account = await PassportAccount.deploy(ctx.providers, compiledAccountContract(), secrets);
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
  secrets: AccountSecrets,
): Promise<PassportAccount> {
  return PassportAccount.connect(ctx.providers, compiledAccountContract(), address, secrets);
}

export function savedDeploymentAddress(): string | null {
  if (!fs.existsSync(DEPLOYMENT_FILE)) return null;
  return JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf-8')).contractAddress;
}

// ── Faucet (test scaffolding — shielded-token origin on localnet) ───────────

export function compiledFaucetContract() {
  return CompiledContract.make('faucet', (FaucetModule as any).Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(faucetZkConfigPath),
  );
}

export function compiledIdentityRegistryContract() {
  return CompiledContract.make('identity_registry', IdentityRegistryContract as any).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(identityRegistryZkConfigPath),
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
}

export async function deployFaucet(walletCtx: WalletContext): Promise<FaucetHandle> {
  const providers = await createProviders(walletCtx, faucetZkConfigPath);
  const deployed = await deployContract(providers, {
    compiledContract: compiledFaucetContract(),
    privateStateId: 'faucet',
    initialPrivateState: {},
  } as any);
  const address = deployed.deployTxData.public.contractAddress;
  return {
    address,
    providers,
    mint: async (color, amount, nonce, recipientCoinPublicKey) => {
      const r = await (deployed as any).callTx.mint_shielded(color, amount, nonce, {
        bytes: recipientCoinPublicKey,
      });
      return r?.public?.txId ?? r?.public?.transactionHash;
    },
  };
}

export async function deployIdentityRegistry(walletCtx: WalletContext): Promise<IdentityRegistry> {
  const providers = await createProviders(walletCtx, identityRegistryZkConfigPath);
  return IdentityRegistry.deploy(providers, compiledIdentityRegistryContract());
}
