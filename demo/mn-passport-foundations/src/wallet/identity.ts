import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';

import * as IdentityModule from '../../contracts/managed/identity_registry/contract/index.js';
import type { Ledger } from '../../contracts/managed/identity_registry/contract/index.js';
import { bytesToHex, hexToBytes32 } from './hex.js';

export const { Contract, ledger, pureCircuits } = IdentityModule;
export type { Ledger };

const MAX_HANDLE_BYTES = 32;

export interface IdentityRegistration {
  registryAddress: string;
  txId: string;
  handle: string;
  accountAddress: string;
}

export function handleToBytes32(handle: string): Uint8Array {
  const bytes = new TextEncoder().encode(handle);
  if (bytes.length > MAX_HANDLE_BYTES) {
    throw new Error(`identity handle is longer than ${MAX_HANDLE_BYTES} bytes`);
  }
  const out = new Uint8Array(MAX_HANDLE_BYTES);
  out.set(bytes);
  return out;
}

export function accountAddressToBytes32(accountAddress: string): Uint8Array {
  return hexToBytes32(accountAddress);
}

export function handleKey(handle: string): bigint {
  return pureCircuits.derive_identity_key(handleToBytes32(handle));
}

function txResult(r: any): string {
  const txId = r?.public?.txId ?? r?.public?.transactionHash;
  if (!txId) throw new Error('identity registry call returned without a transaction id');
  return txId;
}

export class IdentityRegistry {
  private constructor(
    readonly address: string,
    readonly providers: any,
    private readonly handle: any,
  ) {}

  static async deploy(providers: any, compiledContract: any): Promise<IdentityRegistry> {
    const deployed = await deployContract(providers, {
      compiledContract,
      privateStateId: 'identity-registry',
      initialPrivateState: {},
    } as any);
    const address = deployed.deployTxData.public.contractAddress;
    return new IdentityRegistry(address, providers, deployed);
  }

  static async connect(
    providers: any,
    compiledContract: any,
    address: string,
  ): Promise<IdentityRegistry> {
    const found = await (findDeployedContract as any)(providers, {
      contractAddress: address,
      compiledContract,
      privateStateId: 'identity-registry',
      initialPrivateState: {},
    });
    return new IdentityRegistry(address, providers, found);
  }

  async register(handle: string, accountAddress: string): Promise<IdentityRegistration> {
    const txId = txResult(
      await this.handle.callTx.register_identity(
        handleToBytes32(handle),
        accountAddressToBytes32(accountAddress),
      ),
    );
    return {
      registryAddress: this.address,
      txId,
      handle,
      accountAddress,
    };
  }

  async ledgerState(): Promise<Ledger> {
    const state = await this.providers.publicDataProvider.queryContractState(this.address);
    if (!state) throw new Error(`no identity registry state found at ${this.address}`);
    return ledger(state.data);
  }

  async accountFor(handle: string): Promise<string | null> {
    const state = await this.ledgerState();
    const key = handleKey(handle);
    if (!state.identities.member(key)) return null;
    return bytesToHex(state.identities.lookup(key).account);
  }
}
