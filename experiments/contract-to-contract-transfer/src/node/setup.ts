// Deploy-or-connect helpers for the probes.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';

import * as FaucetModule from '../../contracts/managed/faucet/contract/index.js';
import { Contract } from '../wallet/contract.js';
import { makeWitnesses } from '../wallet/witnesses.js';
import { StatelessCustody } from '../wallet/custody.js';
import type { EncKeyPair } from '../wallet/coinstore.js';
import {
  createWallet,
  createProviders,
  syncWallet,
  zkConfigPath,
  faucetZkConfigPath,
  type WalletContext,
} from './wallet.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEPLOYMENT_FILE = path.resolve(__dirname, '..', '..', 'deployment.json');

export function compiledC2CContract() {
  return CompiledContract.make('c2c', Contract).pipe(
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

export async function deployCustody(
  ctx: TestContext,
  encKeys: EncKeyPair,
  label = 'custody',
): Promise<StatelessCustody> {
  const custody = await StatelessCustody.deploy(ctx.providers, compiledC2CContract(), encKeys);
  let record: Record<string, unknown> = {};
  try {
    record = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf8'));
  } catch { /* first deployment of the run */ }
  record[label] = { contractAddress: custody.address, deployedAt: new Date().toISOString() };
  fs.writeFileSync(DEPLOYMENT_FILE, JSON.stringify(record, null, 2));
  return custody;
}

export async function connectCustody(
  ctx: TestContext,
  address: string,
  initialState?: any,
): Promise<StatelessCustody> {
  return StatelessCustody.connect(ctx.providers, compiledC2CContract(), address, initialState);
}

// ── Faucet (test scaffolding — shielded-token origin on localnet) ───────────

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
