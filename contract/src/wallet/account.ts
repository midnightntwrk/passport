// CustodyAccount — the high-level client over a deployed account custody
// contract (MIP-0012 asset surface + MIP-0013 authorisation seam).
//
// Every authorised call follows the same shape: read the live auth_nonce,
// resolve the device's current use counter (the rolling-entry position,
// AUTH-9), collect the witness values the call will consume (AUTH-10),
// build the per-circuit challenge (MIP-0013 §5.1), have the device sign it
// (§5.3), and pass (pk, use_counter, R, s, grind_nonce) as the circuit's
// authorising material. Low-level `*WithAuth` variants accept a pre-built
// Authorisation so conformance tests can inject faults (wrong s, stale
// nonce, wrong counter, replays).
//
// The client tracks a device roster (pk → use counter) per MIP-0013 S11:
// counters advance on every successful gated call, and an unknown counter
// is recovered by rescanning ledger membership of candidate entries.

import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';

import { ledger, pureCircuits, type Ledger, type ShieldedCoin, type QualifiedCoin } from './contract.js';
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

/** How far the S11 rescan probes for a device's current use counter. */
const RESCAN_LIMIT = 4096n;

/**
 * Submit with a dust-race retry. The wallet builds fees from its own dust
 * state, which lags the chain by a sync cycle; two transactions built in
 * quick succession can reuse a dust nullifier (DustDoubleSpend) or emit an
 * empty dust action set (NotNormalized), and the node rejects at
 * submission. A rejected submission changes no state — the signed
 * authorisation is still valid — so waiting for the wallet to catch up and
 * rebuilding is sound.
 */
async function submitWithDustRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const RETRIES = 3;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const dustRace = /SubmissionError|Invalid Transaction|DustDoubleSpend|NotNormalized/.test(msg);
      if (!dustRace || attempt >= RETRIES) throw e;
      console.log(`  (${label}: submission rejected — dust-state race; retrying in 10s)`);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
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
  /** Device roster: pk (hex of x‖y) → current use counter (S11). */
  private readonly counters = new Map<string, bigint>();

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
    // kernel.self() is not available in the constructor, so the initial
    // entry cannot be inserted at deploy time; the constructor stores a
    // salted boot commitment and activate_initial_device inserts the real
    // address-bound entry immediately after (see the contract's `boot`
    // cell for the full rationale).
    const salt = new Uint8Array(32);
    globalThis.crypto.getRandomValues(salt);
    const boot = pureCircuits.derive_boot_commitment(salt, initialDevice.pk);
    const deployed = await deployContract(providers, {
      compiledContract,
      privateStateId,
      initialPrivateState,
      args: [boot, encKeys.publicKey],
    } as any);
    const address = deployed.deployTxData.public.contractAddress;
    // deployContract does not persist initialPrivateState on every provider
    // version; seed it explicitly so witnesses see it (c2c experiment note).
    await providers.privateStateProvider.set(privateStateId, initialPrivateState);
    await submitWithDustRetry('activate_initial_device', () => (deployed as any).callTx.activate_initial_device(initialDevice.pk, salt));
    const account = new CustodyAccount(address, addressToBytes(address), providers, privateStateId, deployed);
    account.counters.set(pkKey(initialDevice.pk), 0n);
    return account;
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

  // ── Device roster (MIP-0013 S11) ──────────────────────────────────────────

  /**
   * The device's current use counter: the roster value when it still
   * matches a live entry, else the S11 rescan — probe ledger membership of
   * the device's entry at candidate counters under the current epoch. The
   * verification step makes the roster self-healing after out-of-band
   * calls or desync.
   */
  async resolveUseCounter(device: Device): Promise<bigint> {
    const l = await this.ledgerState();
    const known = this.counters.get(pkKey(device.pk));
    if (known !== undefined) {
      const entry = device.entryAt(this.addressBytes, l.device_epoch, known);
      if (l.devices.member(entry)) return known;
    }
    for (let k = known ?? 0n; k < (known ?? 0n) + RESCAN_LIMIT; k++) {
      const entry = device.entryAt(this.addressBytes, l.device_epoch, k);
      if (l.devices.member(entry)) {
        this.counters.set(pkKey(device.pk), k);
        return k;
      }
    }
    throw new Error('device entry not found on-ledger (rescan limit reached) — not a registered device?');
  }

  private advanceCounter(pk: { x: bigint; y: bigint }, used: bigint): void {
    this.counters.set(pkKey(pk), used + 1n);
  }

  /** Record a freshly registered device (entry at use counter 0). */
  registerDevice(pk: { x: bigint; y: bigint }): void {
    this.counters.set(pkKey(pk), 0n);
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

  /** The stored qualified coin for a color — the witness value the spend
   *  will consume, needed for the AUTH-10 challenge binding. */
  async heldCoin(color: Uint8Array): Promise<QualifiedCoin> {
    const s = await this.coinStore();
    const stored = s.coins[bytesToHex(color)];
    if (!stored) throw new Error(`no held coin for color ${bytesToHex(color)} in the local store`);
    return {
      nonce: hexToBytes(stored.nonceHex),
      color: hexToBytes(stored.colorHex),
      value: BigInt(stored.value),
      mt_index: BigInt(stored.mtIndex),
    };
  }

  // ── Permissionless surface ────────────────────────────────────────────────

  async depositUnshielded(color: Uint8Array, amount: bigint): Promise<TxResult> {
    const r = await submitWithDustRetry('deposit_unshielded', () => this.handle.callTx.deposit_unshielded(color, amount));
    return { txId: txId(r) };
  }

  async depositShielded(coin: ShieldedCoin, entry: Uint8Array): Promise<TxResult> {
    const r = await submitWithDustRetry('deposit_shielded', () => this.handle.callTx.deposit_shielded(coin, entry));
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
    const counter = await this.resolveUseCounter(device);
    const auth = device.sign(
      challenges.withdrawUnshielded(ctx, device.pk, color, amount, recipient),
      counter,
    );
    const r = await this.withdrawUnshieldedWithAuth(color, amount, recipient, auth);
    this.advanceCounter(device.pk, counter);
    return r;
  }

  async withdrawShielded(
    device: Device,
    recipient: Uint8Array,
    color: Uint8Array,
    amount: bigint,
  ): Promise<SpendOutcome> {
    const ctx = await this.callContext();
    const counter = await this.resolveUseCounter(device);
    // AUTH-10: the approver signs over the exact qualified coin the spend
    // will consume, read from the same store the witness serves.
    const coin = await this.heldCoin(color);
    const auth = device.sign(
      challenges.withdrawShielded(ctx, device.pk, recipient, color, amount, coin),
      counter,
    );
    const r = await this.withdrawShieldedWithAuth(recipient, color, amount, auth);
    this.advanceCounter(device.pk, counter);
    return r;
  }

  async withdrawShieldedToContract(
    device: Device,
    recipient: Uint8Array,
    color: Uint8Array,
    amount: bigint,
  ): Promise<DirectSpendOutcome> {
    const ctx = await this.callContext();
    const counter = await this.resolveUseCounter(device);
    const coin = await this.heldCoin(color);
    const auth = device.sign(
      challenges.withdrawShieldedToContract(ctx, device.pk, recipient, color, amount, coin),
      counter,
    );
    const r = await this.withdrawShieldedToContractWithAuth(recipient, color, amount, auth);
    this.advanceCounter(device.pk, counter);
    return r;
  }

  async appendInbox(device: Device, entry: Uint8Array): Promise<TxResult> {
    const ctx = await this.callContext();
    const counter = await this.resolveUseCounter(device);
    const auth = device.sign(challenges.appendInbox(ctx, device.pk, entry), counter);
    const r = await this.appendInboxWithAuth(entry, auth);
    this.advanceCounter(device.pk, counter);
    return r;
  }

  async rotateEncKey(device: Device, newKey: Uint8Array): Promise<TxResult> {
    const ctx = await this.callContext();
    const counter = await this.resolveUseCounter(device);
    const auth = device.sign(challenges.rotateEncKey(ctx, device.pk, newKey), counter);
    const r = await this.rotateEncKeyWithAuth(newKey, auth);
    this.advanceCounter(device.pk, counter);
    return r;
  }

  async addDevice(device: Device, newPk: { x: bigint; y: bigint }): Promise<TxResult> {
    const ctx = await this.callContext();
    const counter = await this.resolveUseCounter(device);
    const auth = device.sign(challenges.addDevice(ctx, device.pk, newPk), counter);
    const r = await this.addDeviceWithAuth(newPk, auth);
    this.advanceCounter(device.pk, counter);
    this.registerDevice(newPk);
    return r;
  }

  /** Remove another device by its public key: its current entry is
   *  resolved from the roster or the S11 rescan (MIP-0013 §6). */
  async removeDevice(device: Device, target: Device): Promise<TxResult> {
    const l = await this.ledgerState();
    const targetCounter = await this.resolveUseCounter(target);
    const entry = target.entryAt(this.addressBytes, l.device_epoch, targetCounter);
    return this.removeDeviceEntry(device, entry);
  }

  /** Remove a device by its literal current set element. */
  async removeDeviceEntry(device: Device, entry: Uint8Array): Promise<TxResult> {
    const ctx = await this.callContext();
    const counter = await this.resolveUseCounter(device);
    const auth = device.sign(challenges.removeDevice(ctx, device.pk, entry), counter);
    const r = await this.removeDeviceEntryWithAuth(entry, auth);
    this.advanceCounter(device.pk, counter);
    return r;
  }

  // ── Authorised surface (low level: caller supplies the Authorisation) ────

  async withdrawUnshieldedWithAuth(
    color: Uint8Array,
    amount: bigint,
    recipient: Uint8Array,
    a: Authorisation,
  ): Promise<TxResult> {
    const r = await submitWithDustRetry('withdraw_unshielded', () => this.handle.callTx.withdraw_unshielded(
      color, amount, { bytes: recipient }, a.pk, a.use_counter, a.sig_r, a.sig_s, a.grind_nonce,
    ));
    return { txId: txId(r) };
  }

  async withdrawShieldedWithAuth(
    recipient: Uint8Array,
    color: Uint8Array,
    amount: bigint,
    a: Authorisation,
  ): Promise<SpendOutcome> {
    const r = await submitWithDustRetry('withdraw_shielded', () => this.handle.callTx.withdraw_shielded(
      { bytes: recipient }, color, amount, a.pk, a.use_counter, a.sig_r, a.sig_s, a.grind_nonce,
    ));
    return { txId: txId(r), change: changeOf(r) };
  }

  async withdrawShieldedToContractWithAuth(
    recipient: Uint8Array,
    color: Uint8Array,
    amount: bigint,
    a: Authorisation,
  ): Promise<DirectSpendOutcome> {
    const r = await submitWithDustRetry('withdraw_shielded_to_contract', () => this.handle.callTx.withdraw_shielded_to_contract(
      { bytes: recipient }, color, amount, a.pk, a.use_counter, a.sig_r, a.sig_s, a.grind_nonce,
    ));
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
    const r = await submitWithDustRetry('append_inbox', () => this.handle.callTx.append_inbox(entry, a.pk, a.use_counter, a.sig_r, a.sig_s, a.grind_nonce));
    return { txId: txId(r) };
  }

  async rotateEncKeyWithAuth(newKey: Uint8Array, a: Authorisation): Promise<TxResult> {
    const r = await submitWithDustRetry('rotate_enc_key', () => this.handle.callTx.rotate_enc_key(newKey, a.pk, a.use_counter, a.sig_r, a.sig_s, a.grind_nonce));
    return { txId: txId(r) };
  }

  async addDeviceWithAuth(newPk: { x: bigint; y: bigint }, a: Authorisation): Promise<TxResult> {
    const r = await submitWithDustRetry('add_device', () => this.handle.callTx.add_device(newPk, a.pk, a.use_counter, a.sig_r, a.sig_s, a.grind_nonce));
    return { txId: txId(r) };
  }

  async removeDeviceEntryWithAuth(entry: Uint8Array, a: Authorisation): Promise<TxResult> {
    const r = await submitWithDustRetry('remove_device', () => this.handle.callTx.remove_device(entry, a.pk, a.use_counter, a.sig_r, a.sig_s, a.grind_nonce));
    return { txId: txId(r) };
  }

  /** Raw call-tx surface, for tests that need shapes not modelled above. */
  get callTx(): any {
    return this.handle.callTx;
  }
}

function pkKey(pk: { x: bigint; y: bigint }): string {
  return `${pk.x.toString(16)}:${pk.y.toString(16)}`;
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
