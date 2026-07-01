// PassportAccount — the high-level client API over a deployed
// account-custody contract instance. Platform-neutral: the caller supplies
// providers and a CompiledContract prepared for its platform (Node file
// assets vs browser fetch assets).

import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';

import { deviceCommitment, grantCommitment, recoveryCommitment, ledger, type Ledger } from './contract.js';
import { privateStateFromSecrets, type AccountPrivateState } from './witnesses.js';
import { split, type Share } from './shamir.js';
import { bytesToHex } from './hex.js';

export interface AccountSecrets {
  deviceSecret?: Uint8Array;
  grantSecret?: Uint8Array;
  recoverySecret?: Uint8Array;
}

export interface TxResult {
  txId: string;
}

export interface ShieldedCoin {
  nonce: Uint8Array;
  color: Uint8Array;
  value: bigint;
}

function txResult(r: any): TxResult {
  const txId = r?.public?.txId ?? r?.public?.transactionHash;
  if (!txId) throw new Error('contract call returned without a transaction id');
  return { txId };
}

export class PassportAccount {
  private constructor(
    readonly address: string,
    readonly providers: any,
    private readonly handle: any,
  ) {}

  /**
   * Deploy a fresh account contract: derives the device and recovery
   * commitments, splits the recovery secret 2-of-3 (TODO(PVSS) — shares land
   * in public ledger state), and submits the deployment.
   */
  static async deploy(
    providers: any,
    compiledContract: any,
    opts: {
      deviceSecret: Uint8Array;
      recoverySecret: Uint8Array;
      privateStateId?: string;
    },
  ): Promise<PassportAccount> {
    const shares: Share[] = split(opts.recoverySecret, 2, 3);
    const deployed = await deployContract(providers, {
      compiledContract,
      privateStateId: opts.privateStateId ?? freshPrivateStateId(),
      initialPrivateState: privateStateFromSecrets(opts),
      args: [
        deviceCommitment(opts.deviceSecret),
        recoveryCommitment(opts.recoverySecret),
        shares[0].value,
        shares[1].value,
        shares[2].value,
      ],
    } as any);
    const address = deployed.deployTxData.public.contractAddress;
    return new PassportAccount(address, providers, deployed);
  }

  /**
   * Connect to an existing account contract with whatever secrets this
   * client holds. A fresh privateStateId is used per connection so the
   * supplied secrets always win over previously persisted private state.
   */
  static async connect(
    providers: any,
    compiledContract: any,
    address: string,
    secrets: AccountSecrets = {},
    privateStateId?: string,
  ): Promise<PassportAccount> {
    const found = await (findDeployedContract as any)(providers, {
      contractAddress: address,
      compiledContract,
      privateStateId: privateStateId ?? freshPrivateStateId(),
      initialPrivateState: privateStateFromSecrets(secrets),
    });
    return new PassportAccount(address, providers, found);
  }

  // ── Ledger reads ──────────────────────────────────────────────────────────

  async ledgerState(): Promise<Ledger> {
    const state = await this.providers.publicDataProvider.queryContractState(this.address);
    if (!state) throw new Error(`no contract state found at ${this.address}`);
    return ledger(state.data);
  }

  // ── Night custody ─────────────────────────────────────────────────────────

  depositNight(color: Uint8Array, amount: bigint): Promise<TxResult> {
    return this.call('deposit_night', color, amount);
  }

  withdrawNight(color: Uint8Array, amount: bigint, recipient: Uint8Array): Promise<TxResult> {
    return this.call('withdraw_night', color, amount, { bytes: recipient });
  }

  grantWithdrawNight(color: Uint8Array, amount: bigint, recipient: Uint8Array): Promise<TxResult> {
    return this.call('grant_withdraw_night', color, amount, { bytes: recipient });
  }

  // ── Shielded custody (OZ pattern) ─────────────────────────────────────────

  depositShielded(coin: ShieldedCoin): Promise<TxResult> {
    return this.call('deposit_shielded', coin);
  }

  withdrawShielded(recipientCoinPublicKey: Uint8Array, color: Uint8Array, amount: bigint): Promise<TxResult> {
    return this.call('withdraw_shielded', { bytes: recipientCoinPublicKey }, color, amount);
  }

  grantWithdrawShielded(recipientCoinPublicKey: Uint8Array, color: Uint8Array, amount: bigint): Promise<TxResult> {
    return this.call('grant_withdraw_shielded', { bytes: recipientCoinPublicKey }, color, amount);
  }

  // ── Device management ─────────────────────────────────────────────────────

  addDevice(newDeviceSecret: Uint8Array): Promise<TxResult> {
    return this.call('add_device', deviceCommitment(newDeviceSecret));
  }

  addDeviceByCommitment(commitment: bigint): Promise<TxResult> {
    return this.call('add_device', commitment);
  }

  removeDeviceByCommitment(commitment: bigint): Promise<TxResult> {
    return this.call('remove_device', commitment);
  }

  // ── Grants (C10 / C11) ────────────────────────────────────────────────────

  addGrant(grantSecret: Uint8Array, color: Uint8Array, cap: bigint): Promise<TxResult> {
    return this.call('add_grant', grantCommitment(grantSecret), color, cap);
  }

  addGrantByCommitment(commitment: bigint, color: Uint8Array, cap: bigint): Promise<TxResult> {
    return this.call('add_grant', commitment, color, cap);
  }

  revokeGrantByCommitment(commitment: bigint): Promise<TxResult> {
    return this.call('revoke_grant', commitment);
  }

  // ── Recovery (C14) ────────────────────────────────────────────────────────

  /**
   * Total-loss recovery. The connected client must hold the recovery secret
   * in its private state. Bumps the device epoch (invalidating all devices
   * and grants), registers the new device, rotates the recovery secret, and
   * stores fresh shares. Reconnect with the new device secret afterwards.
   */
  recover(newDeviceSecret: Uint8Array, newRecoverySecret: Uint8Array): Promise<TxResult> {
    const shares = split(newRecoverySecret, 2, 3);
    return this.call(
      'recover',
      deviceCommitment(newDeviceSecret),
      recoveryCommitment(newRecoverySecret),
      shares[0].value,
      shares[1].value,
      shares[2].value,
    );
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async call(circuit: string, ...args: unknown[]): Promise<TxResult> {
    const r = await this.handle.callTx[circuit](...args);
    return txResult(r);
  }
}

function freshPrivateStateId(): string {
  const rand = new Uint8Array(8);
  globalThis.crypto.getRandomValues(rand);
  return `account-${bytesToHex(rand)}`;
}
