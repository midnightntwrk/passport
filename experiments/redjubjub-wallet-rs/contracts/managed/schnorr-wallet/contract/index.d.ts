import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type Witnesses<PS> = {
}

export type ImpureCircuits<PS> = {
  register_owner(context: __compactRuntime.CircuitContext<PS>, sk_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  deposit(context: __compactRuntime.CircuitContext<PS>,
          color_0: Uint8Array,
          amount_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  withdraw(context: __compactRuntime.CircuitContext<PS>,
           sig_r_0: __compactRuntime.JubjubPoint,
           sig_s_0: bigint,
           color_0: Uint8Array,
           amount_0: bigint,
           recipient_0: { bytes: Uint8Array },
           nonce_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  query_balance(context: __compactRuntime.CircuitContext<PS>,
                color_0: Uint8Array): __compactRuntime.CircuitResults<PS, bigint>;
}

export type ProvableCircuits<PS> = {
  register_owner(context: __compactRuntime.CircuitContext<PS>, sk_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  deposit(context: __compactRuntime.CircuitContext<PS>,
          color_0: Uint8Array,
          amount_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  withdraw(context: __compactRuntime.CircuitContext<PS>,
           sig_r_0: __compactRuntime.JubjubPoint,
           sig_s_0: bigint,
           color_0: Uint8Array,
           amount_0: bigint,
           recipient_0: { bytes: Uint8Array },
           nonce_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  query_balance(context: __compactRuntime.CircuitContext<PS>,
                color_0: Uint8Array): __compactRuntime.CircuitResults<PS, bigint>;
}

export type PureCircuits = {
  compute_nonce_point(r_0: bigint): __compactRuntime.JubjubPoint;
  compute_withdraw_challenge(sig_r_0: __compactRuntime.JubjubPoint,
                             pk_0: __compactRuntime.JubjubPoint,
                             color_0: Uint8Array,
                             amount_0: bigint,
                             recipient_0: { bytes: Uint8Array },
                             current_tx_count_0: bigint,
                             nonce_0: bigint): Uint8Array;
}

export type Circuits<PS> = {
  register_owner(context: __compactRuntime.CircuitContext<PS>, sk_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  deposit(context: __compactRuntime.CircuitContext<PS>,
          color_0: Uint8Array,
          amount_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  withdraw(context: __compactRuntime.CircuitContext<PS>,
           sig_r_0: __compactRuntime.JubjubPoint,
           sig_s_0: bigint,
           color_0: Uint8Array,
           amount_0: bigint,
           recipient_0: { bytes: Uint8Array },
           nonce_0: bigint): __compactRuntime.CircuitResults<PS, []>;
  query_balance(context: __compactRuntime.CircuitContext<PS>,
                color_0: Uint8Array): __compactRuntime.CircuitResults<PS, bigint>;
  compute_nonce_point(context: __compactRuntime.CircuitContext<PS>, r_0: bigint): __compactRuntime.CircuitResults<PS, __compactRuntime.JubjubPoint>;
  compute_withdraw_challenge(context: __compactRuntime.CircuitContext<PS>,
                             sig_r_0: __compactRuntime.JubjubPoint,
                             pk_0: __compactRuntime.JubjubPoint,
                             color_0: Uint8Array,
                             amount_0: bigint,
                             recipient_0: { bytes: Uint8Array },
                             current_tx_count_0: bigint,
                             nonce_0: bigint): __compactRuntime.CircuitResults<PS, Uint8Array>;
}

export type Ledger = {
  readonly owner_pk: __compactRuntime.JubjubPoint;
  readonly registered: boolean;
  readonly tx_count: bigint;
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>): __compactRuntime.ConstructorResult<PS>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
