// Deploy-or-connect helpers for witness-free contracts, plus a generic
// callTx wrapper — the ~25-line deployControl/deployFaucet pattern from the
// account-custody reference harness, made generic over the generated module.
//
// Probes import their contract module themselves, e.g.
//   import * as TallyModule from '../../contracts/managed/Tally/contract/index.js';
// and pass it in. Keeping generated-module imports out of this file means
// the plumbing typechecks before any contract has been compiled.
//
// Contract-typed constructor arguments (a callee reference) are encoded as
// the bare 32-byte address struct: pass `contractRefArg(calleeAddress)`.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { encodeContractAddress } from '@midnight-ntwrk/compact-runtime';

import {
  createWallet,
  createProviders,
  syncWallet,
  type WalletContext,
} from './wallet.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEPLOYMENT_FILE = path.resolve(__dirname, '..', '..', 'deployment.json');

/** Create and sync the genesis-funded wallet (WALLET_SEED by default). */
export async function setupWallet(seed?: string): Promise<WalletContext> {
  const walletSeed = seed ?? process.env.WALLET_SEED;
  if (!walletSeed) throw new Error('WALLET_SEED env var required');
  const walletCtx = await createWallet(walletSeed);
  await syncWallet(walletCtx, 'funding-wallet');
  return walletCtx;
}

export function assertCompiled(zkPath: string): void {
  if (!fs.existsSync(path.join(zkPath, 'contract', 'index.js'))) {
    throw new Error(`contract not compiled at ${zkPath} — run: npm run compile`);
  }
}

/** CompiledContract for a contract with no witnesses. */
export function compiledWitnessFree(name: string, module: any, zkPath: string) {
  assertCompiled(zkPath);
  return CompiledContract.make(name, module.Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(zkPath),
  );
}

/** CompiledContract for a contract with witnesses (P5's account contract). */
export function compiledWithWitnesses(name: string, module: any, zkPath: string, witnesses: any) {
  assertCompiled(zkPath);
  return CompiledContract.make(name, module.Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(zkPath),
  );
}

/**
 * A contract-typed argument (constructor or circuit) at the TS boundary:
 * the bare 32-byte address struct { bytes } via encodeContractAddress.
 */
export function contractRefArg(contractAddress: string): { bytes: Uint8Array } {
  return { bytes: encodeContractAddress(contractAddress) };
}

export interface CallOutcome {
  txId: string;
  /** The full FinalizedCallTxData — P3 dumps tx structure from it. */
  result: any;
}

export interface ContractHandle {
  name: string;
  address: string;
  providers: any;
  /** The DeployedContract / FoundContract — callTx, circuitMaintenanceTx, … */
  deployed: any;
  module: any;
  call: (circuit: string, ...args: unknown[]) => Promise<CallOutcome>;
  ledgerState: () => Promise<any>;
}

/** Generic callTx wrapper: run one circuit, return txId plus the full result. */
export async function callCircuit(
  deployed: any,
  circuit: string,
  ...args: unknown[]
): Promise<CallOutcome> {
  const fn = deployed?.callTx?.[circuit];
  if (typeof fn !== 'function') {
    throw new Error(`circuit not present on callTx: ${circuit}`);
  }
  const result = await fn.apply(deployed.callTx, args);
  return { txId: result?.public?.txId ?? result?.public?.transactionHash, result };
}

function makeHandle(
  name: string,
  module: any,
  providers: any,
  deployed: any,
  address: string,
): ContractHandle {
  return {
    name,
    address,
    providers,
    deployed,
    module,
    call: (circuit, ...args) => callCircuit(deployed, circuit, ...args),
    ledgerState: async () => {
      const state = await providers.publicDataProvider.queryContractState(address);
      if (!state) throw new Error(`no contract state at ${address}`);
      return module.ledger(state.data);
    },
  };
}

export interface DeployOptions {
  /** privateStateId and the CompiledContract's name. */
  name: string;
  /** The generated module (contracts/managed/<Name>/contract/index.js). */
  module: any;
  /** The contract's own compiled bundle (leaf NodeZkConfigProvider). */
  zkPath: string;
  /** Constructor arguments; a callee reference goes in as contractRefArg(addr). */
  args?: unknown[];
}

/** Deploy a witness-free contract; the address is recorded in deployment.json. */
export async function deployWitnessFree(
  walletCtx: WalletContext,
  opts: DeployOptions,
): Promise<ContractHandle> {
  const providers = await createProviders(walletCtx, opts.zkPath);
  const deployed = await deployContract(providers, {
    compiledContract: compiledWitnessFree(opts.name, opts.module, opts.zkPath),
    privateStateId: opts.name,
    initialPrivateState: {},
    ...(opts.args !== undefined ? { args: opts.args } : {}),
  } as any);
  const address = deployed.deployTxData.public.contractAddress;
  saveDeployment(opts.name, address);
  return makeHandle(opts.name, opts.module, providers, deployed, address);
}

/**
 * Deploy a contract WITH witnesses (P6/P7's Payer: the payer_coin coin-store
 * witness). Modelled on deployWitnessFree; the witnesses run against the
 * private state stored under `name`, which the probe may update through
 * providers.privateStateProvider.set(name, …).
 */
export async function deployWithWitnesses(
  walletCtx: WalletContext,
  opts: DeployOptions & { witnesses: any; initialPrivateState?: any },
): Promise<ContractHandle> {
  const providers = await createProviders(walletCtx, opts.zkPath);
  const deployed = await deployContract(providers, {
    compiledContract: compiledWithWitnesses(opts.name, opts.module, opts.zkPath, opts.witnesses),
    privateStateId: opts.name,
    initialPrivateState: opts.initialPrivateState ?? {},
    ...(opts.args !== undefined ? { args: opts.args } : {}),
  } as any);
  const address = deployed.deployTxData.public.contractAddress;
  saveDeployment(opts.name, address);
  return makeHandle(opts.name, opts.module, providers, deployed, address);
}

/**
 * Connect to an already-deployed witness-free contract. Without an explicit
 * address the last deployment recorded under `name` in deployment.json is
 * used (probes run in separate processes; P3 reconnects to P2's pair).
 */
export async function connectWitnessFree(
  walletCtx: WalletContext,
  opts: DeployOptions & { address?: string },
): Promise<ContractHandle> {
  const address = opts.address ?? loadDeployment(opts.name);
  if (!address) {
    throw new Error(`no deployment recorded for '${opts.name}' — run the deploy probe first`);
  }
  const providers = await createProviders(walletCtx, opts.zkPath);
  const found = await (findDeployedContract as any)(providers, {
    contractAddress: address,
    compiledContract: compiledWitnessFree(opts.name, opts.module, opts.zkPath),
    privateStateId: `${opts.name}-${Date.now().toString(36)}`,
    initialPrivateState: {},
  });
  return makeHandle(opts.name, opts.module, providers, found, address);
}

// ── deployment.json — cross-probe address persistence ───────────────────────

export function saveDeployment(name: string, address: string): void {
  const current = readDeployments();
  current[name] = { contractAddress: address, deployedAt: new Date().toISOString() };
  fs.writeFileSync(DEPLOYMENT_FILE, JSON.stringify(current, null, 2));
}

export function loadDeployment(name: string): string | undefined {
  return readDeployments()[name]?.contractAddress;
}

function readDeployments(): Record<string, { contractAddress: string; deployedAt: string }> {
  if (!fs.existsSync(DEPLOYMENT_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, 'utf-8'));
  } catch {
    return {};
  }
}
