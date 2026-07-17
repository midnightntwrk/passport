// CustodyAccount — the high-level client over a deployed account custody
// contract (MIP-0012 asset surface + MIP-0013 authorisation seam).
//
// Every authorised call follows the same shape: read the live auth_nonce,
// build the per-circuit challenge (MIP-0013 §5.1), have the device sign it
// (§5.3), and pass (pk, R, s, grind_nonce) as the circuit's authorising
// material. Low-level `*WithAuth` variants accept a pre-built Authorisation
// so conformance tests can inject faults (wrong s, stale nonce, replays).

import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';

import { ledger, type Ledger, type ShieldedCoin } from './contract.js';
import {
  emptyCoinStore,
  withCoin,
  withoutCoin,
  type CoinStorePrivateState,
} from './witnesses.js';
import { bytesToHex, hexToBytes } from './hex.js';
import { challenges, type Authorisation, type CallContext, type Device } from './signer.js';
import type { EncKeyPair } from './inbox.js';

export interface TxResult {
  txId: string;
}

export interface SpendOutcome extends TxResult {
  /** The surviving change coin returned by the circuit (private channel). */
  change: ShieldedCoin | null;
}

export interface DirectSpendOutcome extends SpendOutcome {
  /** The coin sent to the recipient contract — the payee's claim argument. */
  sent: ShieldedCoin;
}

function txId(r: any): string {
  const id = r?.public?.txId ?? r?.public?.transactionHash;
  if (!id) throw new Error('contract call returned without a transaction id');
  return id;
}

/** The circuit's declared return value travels in the call result's private
 *  section; probe the surfaces the midnight-js versions disagree on. */
function circuitResult(r: any): any {
  for (const v of [r?.private?.result, r?.private?.circuitResult, r?.private?.returnValue, r?.result]) {
    if (v !== undefined) return v;
  }
  return undefined;
}

function changeOf(r: any): ShieldedCoin | null {
  const value = circuitResult(r);
  return value && value.is_some ? (value.value as ShieldedCoin) : null;
}

export class CustodyAccount {
  private constructor(
    readonly address: string,
    readonly addressBytes: Uint8Array,
    readonly providers: any,
    readonly privateStateId: string,
    private readonly handle: any,
  ) {}

  static async deploy(
    providers: any,
    compiledContract: any,
    initialDevice: Device,
    encKeys: EncKeyPair,
  ): Promise<CustodyAccount> {
    const privateStateId = freshPrivateStateId();
    const initialPrivateState = emptyCoinStore(encKeys.secretKey);
    const deployed = await deployContract(providers, {
      compiledContract,
      privateStateId,
      initialPrivateState,
      args: [initialDevice.pk, encKeys.publicKey],
    } as any);
    const address = deployed.deployTxData.public.contractAddress;
    // deployContract does not persist initialPrivateState on every provider
    // version; seed it explicitly so witnesses see it (c2c experiment note).
    await providers.privateStateProvider.set(privateStateId, initialPrivateState);
    return new CustodyAccount(address, addressToBytes(address), providers, privateStateId, deployed);
  }

  static async connect(
    providers: any,
    compiledContract: any,
    address: string,
    initialState: CoinStorePrivateState = emptyCoinStore(),
  ): Promise<CustodyAccount> {
    const privateStateId = freshPrivateStateId();
    const found = await (findDeployedContract as any)(providers, {
      contractAddress: address,
      compiledContract,
      privateStateId,
      initialPrivateState: initialState,
    });
    return new CustodyAccount(address, addressToBytes(address), providers, privateStateId, found);
  }

  // ── Ledger reads ──────────────────────────────────────────────────────────

  async ledgerState(): Promise<Ledger> {
    const state = await this.providers.publicDataProvider.queryContractState(this.address);
    if (!state) throw new Error(`no contract state found at ${this.address}`);
    return ledger(state.data);
  }

  /** The signing context for the next authorised call (MIP-0013 §5.1). */
  async callContext(): Promise<CallContext> {
    const l = await this.ledgerState();
    return { contractAddress: this.addressBytes, authNonce: l.auth_nonce };
  }

  // ── Wallet-local coin store (MIP-0012 §6.5) ───────────────────────────────

  async coinStore(): Promise<CoinStorePrivateState> {
    const s = await this.providers.privateStateProvider.get(this.privateStateId);
    return (s as CoinStorePrivateState) ?? emptyCoinStore();
  }

  async putCoin(coin: { nonce: Uint8Array; color: Uint8Array; value: bigint; mtIndex: bigint }): Promise<void> {
    const s = await this.coinStore();
    await this.providers.privateStateProvider.set(this.privateStateId, withCoin(s, coin));
  }

  async dropCoin(color: Uint8Array): Promise<void> {
    const s = await this.coinStore();
    await this.providers.privateStateProvider.set(this.privateStateId, withoutCoin(s, color));
  }

  // ── Permissionless surface ────────────────────────────────────────────────

  async depositUnshielded(color: Uint8Array, amount: bigint): Promise<TxResult> {
    const r = await this.handle.callTx.deposit_unshielded(color, amount);
    return { txId: txId(r) };
  }

  async depositShielded(coin: ShieldedCoin, entry: Uint8Array): Promise<TxResult> {
    const r = await this.handle.callTx.deposit_shielded(coin, entry);
    return { txId: txId(r) };
  }

  // ── Authorised surface (high level: sign with a device, then call) ───────

  async withdrawUnshielded(
    device: Device,
    color: Uint8Array,
    amount: bigint,
    recipient: Uint8Array,
  ): Promise<TxResult> {
    const ctx = await this.callContext();
    const auth = device.sign(challenges.withdrawUnshielded(ctx, device.pk, color, amount, recipient));
    return this.withdrawUnshieldedWithAuth(color, amount, recipient, auth);
  }

  async withdrawShielded(
    device: Device,
    recipient: Uint8Array,
    color: Uint8Array,
    amount: bigint,
  ): Promise<SpendOutcome> {
    const ctx = await this.callContext();
    const auth = device.sign(challenges.withdrawShielded(ctx, device.pk, recipient, color, amount));
    return this.withdrawShieldedWithAuth(recipient, color, amount, auth);
  }

  async withdrawShieldedToContract(
    device: Device,
    recipient: Uint8Array,
    color: Uint8Array,
    amount: bigint,
  ): Promise<DirectSpendOutcome> {
    const ctx = await this.callContext();
    const auth = device.sign(challenges.withdrawShieldedToContract(ctx, device.pk, recipient, color, amount));
    return this.withdrawShieldedToContractWithAuth(recipient, color, amount, auth);
  }

  async appendInbox(device: Device, entry: Uint8Array): Promise<TxResult> {
    const ctx = await this.callContext();
    const auth = device.sign(challenges.appendInbox(ctx, device.pk, entry));
    return this.appendInboxWithAuth(entry, auth);
  }

  async rotateEncKey(device: Device, newKey: Uint8Array): Promise<TxResult> {
    const ctx = await this.callContext();
    const auth = device.sign(challenges.rotateEncKey(ctx, device.pk, newKey));
    return this.rotateEncKeyWithAuth(newKey, auth);
  }

  async addDevice(device: Device, newPk: { x: bigint; y: bigint }): Promise<TxResult> {
    const ctx = await this.callContext();
    const auth = device.sign(challenges.addDevice(ctx, device.pk, newPk));
    return this.addDeviceWithAuth(newPk, auth);
  }

  async removeDevice(device: Device, commitment: Uint8Array): Promise<TxResult> {
    const ctx = await this.callContext();
    const auth = device.sign(challenges.removeDevice(ctx, device.pk, commitment));
    return this.removeDeviceWithAuth(commitment, auth);
  }

  // ── Authorised surface (low level: caller supplies the Authorisation) ────

  async withdrawUnshieldedWithAuth(
    color: Uint8Array,
    amount: bigint,
    recipient: Uint8Array,
    a: Authorisation,
  ): Promise<TxResult> {
    const r = await this.handle.callTx.withdraw_unshielded(
      color, amount, { bytes: recipient }, a.pk, a.sig_r, a.sig_s, a.grind_nonce,
    );
    return { txId: txId(r) };
  }

  async withdrawShieldedWithAuth(
    recipient: Uint8Array,
    color: Uint8Array,
    amount: bigint,
    a: Authorisation,
  ): Promise<SpendOutcome> {
    const r = await this.handle.callTx.withdraw_shielded(
      { bytes: recipient }, color, amount, a.pk, a.sig_r, a.sig_s, a.grind_nonce,
    );
    return { txId: txId(r), change: changeOf(r) };
  }

  async withdrawShieldedToContractWithAuth(
    recipient: Uint8Array,
    color: Uint8Array,
    amount: bigint,
    a: Authorisation,
  ): Promise<DirectSpendOutcome> {
    const r = await this.handle.callTx.withdraw_shielded_to_contract(
      { bytes: recipient }, color, amount, a.pk, a.sig_r, a.sig_s, a.grind_nonce,
    );
    const result = circuitResult(r);
    if (!Array.isArray(result) || !result[0]?.nonce) {
      throw new Error('withdraw_shielded_to_contract: [sent, change] result not found on the call surface');
    }
    const maybeChange = result[1];
    return {
      txId: txId(r),
      sent: result[0] as ShieldedCoin,
      change: maybeChange?.is_some ? (maybeChange.value as ShieldedCoin) : null,
    };
  }

  async appendInboxWithAuth(entry: Uint8Array, a: Authorisation): Promise<TxResult> {
    const r = await this.handle.callTx.append_inbox(entry, a.pk, a.sig_r, a.sig_s, a.grind_nonce);
    return { txId: txId(r) };
  }

  async rotateEncKeyWithAuth(newKey: Uint8Array, a: Authorisation): Promise<TxResult> {
    const r = await this.handle.callTx.rotate_enc_key(newKey, a.pk, a.sig_r, a.sig_s, a.grind_nonce);
    return { txId: txId(r) };
  }

  async addDeviceWithAuth(newPk: { x: bigint; y: bigint }, a: Authorisation): Promise<TxResult> {
    const r = await this.handle.callTx.add_device(newPk, a.pk, a.sig_r, a.sig_s, a.grind_nonce);
    return { txId: txId(r) };
  }

  async removeDeviceWithAuth(commitment: Uint8Array, a: Authorisation): Promise<TxResult> {
    const r = await this.handle.callTx.remove_device(commitment, a.pk, a.sig_r, a.sig_s, a.grind_nonce);
    return { txId: txId(r) };
  }

  /** Raw call-tx surface, for tests that need shapes not modelled above. */
  get callTx(): any {
    return this.handle.callTx;
  }
}

// ContractAddress circuit arguments are { bytes: Bytes<32> }; the hex form
// of a deployed address maps to those bytes directly (validated by the
// contract-to-contract transfer experiment).
function addressToBytes(address: string): Uint8Array {
  return hexToBytes(address.replace(/^0x/, ''));
}

function freshPrivateStateId(): string {
  const rand = new Uint8Array(8);
  globalThis.crypto.getRandomValues(rand);
  return `account-${bytesToHex(rand)}`;
}
