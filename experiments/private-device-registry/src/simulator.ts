import {
  createConstructorContext, createCircuitContext, sampleContractAddress,
  type CircuitContext, type CircuitResults, type ChargedState,
} from '@midnight-ntwrk/compact-runtime';
import {
  Contract, ledger, pureCircuits as pure,
  type DeviceRow, type DeviceAuth, type ImpureCircuits,
} from '../contracts/managed/registry/contract/index.js';
import { Device, freshBytes } from './signing.js';

export { pure };
export type { DeviceRow, DeviceAuth };
export const cloneRows = (rows: DeviceRow[]) => structuredClone(rows);

/** An in-process caller of the actual compiled circuits; not a model of them. */
export class Simulator {
  readonly contract = new Contract<{}>({});
  readonly addressHex = sampleContractAddress();
  readonly address = { bytes: new Uint8Array(Buffer.from(this.addressHex, 'hex')) };
  readonly coinPk = { bytes: freshBytes() };
  readonly owner = new Device();
  readonly recovery = new Device();
  readonly bootSalt = freshBytes();
  blind: Uint8Array = freshBytes();
  rows: DeviceRow[] = [];
  state!: ChargedState;
  results: { operation: string; result: CircuitResults<{}, []> }[] = [];

  static async create(activate = true) {
    const sim = new Simulator();
    const boot = pure.derive_boot(sim.owner.pk, sim.owner.policy, sim.blind, sim.bootSalt);
    const initial = await sim.contract.initialState(
      createConstructorContext({}, sim.coinPk), boot, sim.recovery.pk,
    );
    sim.state = initial.currentContractState.data;
    sim.rows = pure.singleton_rows(sim.address, sim.owner.pk, sim.owner.policy);
    if (activate) await sim.call('activate', sim.owner.pk, sim.owner.policy, sim.bootSalt, sim.blind);
    return sim;
  }

  ledger() { return ledger(this.state); }
  identity(device: Device) { return pure.derive_identity(this.address, device.pk); }
  root(rows: DeviceRow[], blind: Uint8Array, epoch = this.ledger().epoch) {
    return pure.derive_root(this.address, epoch, rows, blind);
  }

  async call(name: keyof ImpureCircuits<{}>, ...args: unknown[]) {
    const context = createCircuitContext<{}>({
      circuitId: name, contractAddress: this.addressHex,
      coinPublicKeyOrZswapState: this.coinPk, contractState: this.state,
      privateState: {}, time: 1_800_000_000,
    });
    const circuit = this.contract.impureCircuits[name] as
      (ctx: CircuitContext<{}>, ...values: unknown[]) => Promise<CircuitResults<{}, []>>;
    const result = await circuit(context, ...args);
    this.state = result.context.callContext.currentQueryContext.state;
    this.results.push({ operation: name, result });
    return result;
  }

  auth(device: Device, policy = device.policy): DeviceAuth {
    const l = this.ledger();
    return { ...device.sign((r, grind) => pure.challenge_authorise(
      this.address, device.pk, r, policy, l.root, l.epoch, l.auth_nonce, grind,
    )), policy };
  }

  async authorise(device: Device) {
    return this.call('authorise', this.rows, this.blind, this.auth(device));
  }

  addArgs(caller: Device, target: Device, options: {
    rows?: DeviceRow[]; blind?: Uint8Array; policy?: Uint8Array;
  } = {}) {
    const rows = options.rows ?? cloneRows(this.rows);
    const blind = options.blind ?? freshBytes();
    const policy = options.policy ?? target.policy;
    if (!options.rows) {
      const slot = rows.findIndex(r => !r.active);
      if (slot < 0) throw new Error('test roster is full');
      rows[slot] = { active: true, identity: this.identity(target), policy };
    }
    const l = this.ledger();
    const auth = caller.sign((r, grind) => pure.challenge_add_device(
      this.address, caller.pk, r, caller.policy, l.root, this.root(rows, blind),
      target.pk, policy, l.epoch, l.auth_nonce, grind,
    ));
    const args = [this.rows, this.blind, rows, blind, target.pk, policy, auth];
    return { rows, blind, args };
  }

  async add(caller: Device, target: Device) {
    const change = this.addArgs(caller, target);
    const result = await this.call('add_device', ...change.args);
    this.rows = change.rows;
    this.blind = change.blind;
    return result;
  }

  removeArgs(caller: Device, target: Device, options: {
    rows?: DeviceRow[]; blind?: Uint8Array; identity?: Uint8Array;
  } = {}) {
    const identity = options.identity ?? this.identity(target);
    const rows = options.rows ?? this.rows.map(row =>
      Buffer.from(row.identity).equals(identity) ? pure.empty_row() : structuredClone(row));
    const blind = options.blind ?? freshBytes();
    const l = this.ledger();
    const auth = caller.sign((r, grind) => pure.challenge_remove_device(
      this.address, caller.pk, r, caller.policy, l.root, this.root(rows, blind),
      identity, l.epoch, l.auth_nonce, grind,
    ));
    return { rows, blind, args: [this.rows, this.blind, rows, blind, identity, auth] };
  }

  async remove(caller: Device, target: Device) {
    const change = this.removeArgs(caller, target);
    const result = await this.call('remove_device', ...change.args);
    this.rows = change.rows;
    this.blind = change.blind;
    return result;
  }

  recoveryArgs(successor: Device, signer = this.recovery) {
    const l = this.ledger();
    const blind = freshBytes();
    const rows = pure.singleton_rows(this.address, successor.pk, successor.policy);
    const auth = signer.sign((r, grind) => pure.challenge_recover(
      this.address, l.recovery_pk, r, l.root, this.root(rows, blind, l.epoch + 1n),
      successor.pk, successor.policy, l.epoch + 1n, l.auth_nonce, grind,
    ));
    return { rows, blind, args: [successor.pk, successor.policy, blind,
      auth.sig_r, auth.sig_s, auth.grind_nonce] };
  }
}
