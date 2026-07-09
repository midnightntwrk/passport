// In-process contract simulator over @midnight-ntwrk/compact-runtime.
// Executes circuits (including witness evaluation) against a local
// QueryContext — no node, indexer, or proof server required. Token
// operations record their effects but are not settled; balance-mirror
// ledger fields make the outcomes observable anyway.

import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
  type CircuitContext,
} from '@midnight-ntwrk/compact-runtime';

import {
  Contract,
  ledger,
  deviceCommitment,
  recoveryCommitment,
  type Ledger,
} from '../src/wallet/contract.js';
import {
  makeWitnesses,
  privateStateFromSecrets,
  type AccountPrivateState,
} from '../src/wallet/witnesses.js';

const COIN_PUBLIC_KEY = '00'.repeat(32);

export interface SimulatorSecrets {
  deviceSecret?: Uint8Array;
  grantSecret?: Uint8Array;
  recoverySecret?: Uint8Array;
}

export class AccountSimulator {
  readonly contract: any;
  readonly address = sampleContractAddress();
  ctx: CircuitContext<AccountPrivateState>;

  constructor(opts: { deviceSecret: Uint8Array; recoverySecret: Uint8Array }) {
    this.contract = new (Contract as any)(makeWitnesses());
    const constructorCtx = createConstructorContext(
      privateStateFromSecrets(opts),
      COIN_PUBLIC_KEY,
    );
    const { currentContractState, currentPrivateState, currentZswapLocalState } =
      this.contract.initialState(
        constructorCtx,
        deviceCommitment(opts.deviceSecret),
        recoveryCommitment(opts.recoverySecret),
      );
    this.ctx = createCircuitContext(
      this.address,
      currentZswapLocalState,
      currentContractState,
      currentPrivateState,
    );
  }

  /** Switch the acting client: subsequent calls use these secrets. */
  as(secrets: SimulatorSecrets): this {
    this.ctx = {
      ...this.ctx,
      currentPrivateState: privateStateFromSecrets(secrets),
    };
    return this;
  }

  /** Call an impure circuit; commits the resulting context on success. */
  call(circuit: string, ...args: unknown[]): unknown {
    const r = this.contract.impureCircuits[circuit](this.ctx, ...args);
    this.ctx = r.context;
    return r.result;
  }

  ledger(): Ledger {
    return ledger(this.ctx.currentQueryContext.state);
  }
}
