// In-process contract simulator over @midnight-ntwrk/compact-runtime.
// Executes circuits (including witness evaluation) against a local
// QueryContext — no node, indexer, or proof server required. Token
// operations are not settled against a real ledger, but the QueryContext
// records what the ledger WOULD enforce (claimed token effects), and
// every call reconciles the night_balances mirror against those claims —
// see reconcileNightSettlement below. Shielded effects carry commitments,
// not amounts, so shielded settlement remains observable only through the
// mirror fields plus the devnet e2e scripts.

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
import { bytesToHex } from '../src/wallet/hex.js';

const COIN_PUBLIC_KEY = '00'.repeat(32);

export interface SimulatorSecrets {
  deviceSecret?: Uint8Array;
  grantSecret?: Uint8Array;
  recoverySecret?: Uint8Array;
}

// ── Unshielded settlement reconciliation ────────────────────────────────────
//
// On a real node the ledger matches a call's claimed token effects against
// the transaction's actual inputs and outputs; the simulator has no
// transaction, so without this check a change that credits the mirror
// without receiving the coin (or debits without sending) would pass every
// unit test and only surface on devnet. The QueryContext accumulates the
// claims (effects.unshieldedInputs / unshieldedOutputs), so after every
// call the mirror delta must equal claimed inputs minus claimed outputs,
// per color.

/** color hex → total amount. */
export type UnshieldedTotals = Map<string, bigint>;

interface UnshieldedTokenType {
  tag: string;
  raw: string;
}

function claimedTotals(
  effects: { unshieldedInputs: Map<UnshieldedTokenType, bigint>; unshieldedOutputs: Map<UnshieldedTokenType, bigint> },
  side: 'unshieldedInputs' | 'unshieldedOutputs',
): UnshieldedTotals {
  const out: UnshieldedTotals = new Map();
  for (const [tokenType, amount] of effects[side]) {
    if (tokenType.tag !== 'unshielded') continue;
    out.set(tokenType.raw, (out.get(tokenType.raw) ?? 0n) + amount);
  }
  return out;
}

function mirrorTotals(l: Ledger): UnshieldedTotals {
  const out: UnshieldedTotals = new Map();
  for (const [color, amount] of l.night_balances) {
    out.set(bytesToHex(color), amount);
  }
  return out;
}

function totalsDelta(before: UnshieldedTotals, after: UnshieldedTotals): UnshieldedTotals {
  const out: UnshieldedTotals = new Map();
  for (const color of new Set([...before.keys(), ...after.keys()])) {
    const d = (after.get(color) ?? 0n) - (before.get(color) ?? 0n);
    if (d !== 0n) out.set(color, d);
  }
  return out;
}

/**
 * Throws unless, for every color touched, the night_balances mirror moved
 * by exactly (claimed unshielded inputs − claimed unshielded outputs).
 * Exported so the check itself is unit-testable.
 */
export function reconcileNightSettlement(opts: {
  circuit: string;
  claimedIn: UnshieldedTotals;
  claimedOut: UnshieldedTotals;
  mirrorDelta: UnshieldedTotals;
}): void {
  const colors = new Set([
    ...opts.claimedIn.keys(),
    ...opts.claimedOut.keys(),
    ...opts.mirrorDelta.keys(),
  ]);
  for (const color of colors) {
    const claimed = (opts.claimedIn.get(color) ?? 0n) - (opts.claimedOut.get(color) ?? 0n);
    const mirrored = opts.mirrorDelta.get(color) ?? 0n;
    if (claimed !== mirrored) {
      throw new Error(
        `night settlement mismatch in ${opts.circuit} for color ${color}: ` +
          `mirror moved by ${mirrored}, claimed token effects total ${claimed}`,
      );
    }
  }
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

  /**
   * Call an impure circuit; commits the resulting context on success and
   * reconciles the night_balances mirror against the call's claimed
   * unshielded token effects.
   */
  call(circuit: string, ...args: unknown[]): unknown {
    const effectsBefore = this.ctx.currentQueryContext.effects as any;
    const inBefore = claimedTotals(effectsBefore, 'unshieldedInputs');
    const outBefore = claimedTotals(effectsBefore, 'unshieldedOutputs');
    const mirrorBefore = mirrorTotals(this.ledger());

    const r = this.contract.impureCircuits[circuit](this.ctx, ...args);
    this.ctx = r.context;

    const effectsAfter = this.ctx.currentQueryContext.effects as any;
    reconcileNightSettlement({
      circuit,
      claimedIn: totalsDelta(inBefore, claimedTotals(effectsAfter, 'unshieldedInputs')),
      claimedOut: totalsDelta(outBefore, claimedTotals(effectsAfter, 'unshieldedOutputs')),
      mirrorDelta: totalsDelta(mirrorBefore, mirrorTotals(this.ledger())),
    });
    return r.result;
  }

  ledger(): Ledger {
    return ledger(this.ctx.currentQueryContext.state);
  }
}
