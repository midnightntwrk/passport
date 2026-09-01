// In-process simulator for the reference contract over
// @midnight-ntwrk/compact-runtime. Executes circuits (witness evaluation
// included) against a local QueryContext — no node, indexer, or proof
// server — with explicit wall-clock control, which is what makes the veto
// window testable offline: every call builds its CircuitContext at the
// simulator's current block time, and advanceTime moves that clock.
//
// The seam is driven exactly as a wallet drives it: a JubJub device signs
// the per-circuit challenge over the observed auth_nonce, and the simulator
// tracks each device's use counter for the rolling entry (AUTH-9). The
// simulator drives the JubJub arm only; the k256 twins of the recovery
// operations share the same `do_*` chips and are exercised on node.

import { randomBytes } from 'node:crypto';
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';

import { Contract, ledger, type Ledger } from '../wallet/contract.js';
import {
  makeWitnesses,
  emptyCoinStore,
  type CoinStorePrivateState,
} from '../wallet/witnesses.js';
import { JubjubDevice, jubjubChallenges, type CallContext, type ChallengeBuilder } from '../wallet/signer.js';
import { hexToBytes } from '../wallet/hex.js';

export interface SimOptions {
  vetoWindowSeconds: bigint;
  initialRecoveryCommitment: Uint8Array;
  initialWrap: Uint8Array;
  /** Simulated wall clock at deploy, seconds since epoch. */
  time?: number;
}

export class AccountSim {
  readonly contract: any;
  readonly impure: Record<string, (...a: any[]) => Promise<any>>;
  readonly addressHex: string = sampleContractAddress();
  readonly address: Uint8Array;
  readonly coinPk = { bytes: new Uint8Array(randomBytes(32)) };
  readonly device: JubjubDevice;
  state: any;
  privateState: CoinStorePrivateState;
  now: number;
  private counters = new Map<JubjubDevice, bigint>();

  private constructor(opts: SimOptions) {
    this.contract = new (Contract as any)(makeWitnesses());
    this.impure = this.contract.impureCircuits;
    this.device = JubjubDevice.generate();
    this.address = hexToBytes(this.addressHex.replace(/^0x/, ''));
    this.now = opts.time ?? 1_800_000_000;
    this.privateState = emptyCoinStore();
  }

  /** Deploy (constructor + wave-free) and activate the initial device. */
  static async create(opts: SimOptions): Promise<AccountSim> {
    const sim = new AccountSim(opts);
    const salt = new Uint8Array(randomBytes(32));
    const boot = sim.device.bootCommitment(salt);
    const init = await sim.contract.initialState(
      createConstructorContext(sim.privateState, sim.coinPk),
      boot,
      new Uint8Array(randomBytes(32)), // enc_key (X25519 pk; opaque here)
      opts.initialRecoveryCommitment,
      opts.initialWrap,
      opts.vetoWindowSeconds,
    );
    sim.state = init.currentContractState;
    await sim.call('activate_initial_device_with_jubjub', sim.device.pk, salt);
    sim.counters.set(sim.device, 0n);
    return sim;
  }

  /** Move the simulated wall clock; state carries over. */
  advanceTime(seconds: number): void {
    this.now += seconds;
  }

  async call(circuit: string, ...args: unknown[]): Promise<unknown> {
    const ctx = createCircuitContext<CoinStorePrivateState>(
      circuit,
      this.addressHex,
      this.coinPk,
      this.state,
      this.privateState,
      undefined,
      undefined,
      undefined,
      this.now,
    );
    const r = await this.impure[circuit](ctx, ...args);
    this.state = r.context.callContext.currentQueryContext.state;
    if (r.context.callContext.currentPrivateState !== undefined) {
      this.privateState = r.context.callContext.currentPrivateState;
    }
    return r.result;
  }

  ledger(): Ledger {
    return ledger(this.state);
  }

  callContext(): CallContext {
    return { contractAddress: this.address, authNonce: this.ledger().auth_nonce };
  }

  /** Sign and place a seam-gated call as `device` (default: the initial
   *  one). `circuit` is the operation's base name; the simulator drives the
   *  JubJub arm, so it calls `<circuit>_with_jubjub`. */
  async authorised(
    circuit: string,
    build: (ctx: CallContext, device: JubjubDevice) => ChallengeBuilder,
    args: unknown[],
    device: JubjubDevice = this.device,
  ): Promise<unknown> {
    const counter = this.counters.get(device) ?? 0n;
    const auth = device.sign(build(this.callContext(), device), counter);
    const result = await this.call(
      `${circuit}_with_jubjub`,
      ...args,
      auth.pk,
      auth.use_counter,
      auth.sig_r,
      auth.sig_s,
      auth.grind_nonce,
    );
    this.counters.set(device, counter + 1n);
    return result;
  }

  /** The entry a fresh device enrols under: the live epoch, counter 0. */
  entryFor(device: JubjubDevice): Uint8Array {
    return device.entryAt(this.address, this.ledger().device_epoch, 0n);
  }

  /** Enrol a fresh device through the seam and start its counter. The new
   *  device travels as its derived entry (MIP-0013 as landed on main). */
  async enrolDevice(): Promise<JubjubDevice> {
    const fresh = JubjubDevice.generate();
    const entry = this.entryFor(fresh);
    await this.authorised(
      'add_device',
      (ctx, d) => jubjubChallenges.addDevice(ctx, d.pk, entry),
      [entry],
    );
    this.counters.set(fresh, 0n);
    return fresh;
  }

  /** Register a device that recover_finalise enrolled (counter starts at 0). */
  adoptRecoveredDevice(device: JubjubDevice): void {
    this.counters.set(device, 0n);
  }
}
