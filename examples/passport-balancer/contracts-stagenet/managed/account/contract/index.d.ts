import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type Witnesses<PS> = {
  device_secret(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
  grant_secret(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
  recovery_secret(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
}

export type ImpureCircuits<PS> = {
  deposit_night(context: __compactRuntime.CircuitContext<PS>,
                color_0: Uint8Array,
                amount_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  withdraw_night(context: __compactRuntime.CircuitContext<PS>,
                 color_0: Uint8Array,
                 amount_0: bigint,
                 recipient_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  grant_withdraw_night(context: __compactRuntime.CircuitContext<PS>,
                       color_0: Uint8Array,
                       amount_0: bigint,
                       recipient_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  deposit_shielded(context: __compactRuntime.CircuitContext<PS>,
                   coin_0: { nonce: Uint8Array, color: Uint8Array, value: bigint
                           }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  withdraw_shielded(context: __compactRuntime.CircuitContext<PS>,
                    recipient_0: { bytes: Uint8Array },
                    color_0: Uint8Array,
                    amount_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  grant_withdraw_shielded(context: __compactRuntime.CircuitContext<PS>,
                          recipient_0: { bytes: Uint8Array },
                          color_0: Uint8Array,
                          amount_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  add_device(context: __compactRuntime.CircuitContext<PS>, new_device_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  remove_device(context: __compactRuntime.CircuitContext<PS>, device_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  add_grant(context: __compactRuntime.CircuitContext<PS>,
            grant_0: bigint,
            color_0: Uint8Array,
            cap_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  revoke_grant(context: __compactRuntime.CircuitContext<PS>, grant_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  recover(context: __compactRuntime.CircuitContext<PS>,
          new_device_commitment_0: bigint,
          new_recovery_commitment_0: bigint,
          new_share_1_0: Uint8Array,
          new_share_2_0: Uint8Array,
          new_share_3_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
}

export type ProvableCircuits<PS> = {
  deposit_night(context: __compactRuntime.CircuitContext<PS>,
                color_0: Uint8Array,
                amount_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  withdraw_night(context: __compactRuntime.CircuitContext<PS>,
                 color_0: Uint8Array,
                 amount_0: bigint,
                 recipient_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  grant_withdraw_night(context: __compactRuntime.CircuitContext<PS>,
                       color_0: Uint8Array,
                       amount_0: bigint,
                       recipient_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  deposit_shielded(context: __compactRuntime.CircuitContext<PS>,
                   coin_0: { nonce: Uint8Array, color: Uint8Array, value: bigint
                           }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  withdraw_shielded(context: __compactRuntime.CircuitContext<PS>,
                    recipient_0: { bytes: Uint8Array },
                    color_0: Uint8Array,
                    amount_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  grant_withdraw_shielded(context: __compactRuntime.CircuitContext<PS>,
                          recipient_0: { bytes: Uint8Array },
                          color_0: Uint8Array,
                          amount_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  add_device(context: __compactRuntime.CircuitContext<PS>, new_device_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  remove_device(context: __compactRuntime.CircuitContext<PS>, device_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  add_grant(context: __compactRuntime.CircuitContext<PS>,
            grant_0: bigint,
            color_0: Uint8Array,
            cap_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  revoke_grant(context: __compactRuntime.CircuitContext<PS>, grant_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  recover(context: __compactRuntime.CircuitContext<PS>,
          new_device_commitment_0: bigint,
          new_recovery_commitment_0: bigint,
          new_share_1_0: Uint8Array,
          new_share_2_0: Uint8Array,
          new_share_3_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
}

export type PureCircuits = {
  derive_device_commitment(secret_0: Uint8Array): bigint;
  derive_grant_commitment(secret_0: Uint8Array): bigint;
  derive_recovery_commitment(secret_0: Uint8Array): bigint;
}

export type Circuits<PS> = {
  derive_device_commitment(context: __compactRuntime.CircuitContext<PS>,
                           secret_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  derive_grant_commitment(context: __compactRuntime.CircuitContext<PS>,
                          secret_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  derive_recovery_commitment(context: __compactRuntime.CircuitContext<PS>,
                             secret_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  deposit_night(context: __compactRuntime.CircuitContext<PS>,
                color_0: Uint8Array,
                amount_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  withdraw_night(context: __compactRuntime.CircuitContext<PS>,
                 color_0: Uint8Array,
                 amount_0: bigint,
                 recipient_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  grant_withdraw_night(context: __compactRuntime.CircuitContext<PS>,
                       color_0: Uint8Array,
                       amount_0: bigint,
                       recipient_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  deposit_shielded(context: __compactRuntime.CircuitContext<PS>,
                   coin_0: { nonce: Uint8Array, color: Uint8Array, value: bigint
                           }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  withdraw_shielded(context: __compactRuntime.CircuitContext<PS>,
                    recipient_0: { bytes: Uint8Array },
                    color_0: Uint8Array,
                    amount_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  grant_withdraw_shielded(context: __compactRuntime.CircuitContext<PS>,
                          recipient_0: { bytes: Uint8Array },
                          color_0: Uint8Array,
                          amount_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  add_device(context: __compactRuntime.CircuitContext<PS>, new_device_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  remove_device(context: __compactRuntime.CircuitContext<PS>, device_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  add_grant(context: __compactRuntime.CircuitContext<PS>,
            grant_0: bigint,
            color_0: Uint8Array,
            cap_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  revoke_grant(context: __compactRuntime.CircuitContext<PS>, grant_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  recover(context: __compactRuntime.CircuitContext<PS>,
          new_device_commitment_0: bigint,
          new_recovery_commitment_0: bigint,
          new_share_1_0: Uint8Array,
          new_share_2_0: Uint8Array,
          new_share_3_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
}

export type Ledger = {
  readonly round: bigint;
  readonly device_epoch: bigint;
  devices: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: bigint): boolean;
    lookup(key_0: bigint): bigint;
    [Symbol.iterator](): Iterator<[bigint, bigint]>
  };
  readonly device_count: bigint;
  readonly recovery: bigint;
  recovery_shares: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: bigint): boolean;
    lookup(key_0: bigint): Uint8Array;
    [Symbol.iterator](): Iterator<[bigint, Uint8Array]>
  };
  grants: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: bigint): boolean;
    lookup(key_0: bigint): { epoch: bigint,
                             color: Uint8Array,
                             cap: bigint,
                             spent: bigint,
                             active: boolean
                           };
    [Symbol.iterator](): Iterator<[bigint, { epoch: bigint, color: Uint8Array, cap: bigint, spent: bigint, active: boolean
}]>
  };
  night_balances: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): bigint;
    [Symbol.iterator](): Iterator<[Uint8Array, bigint]>
  };
  coins: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): { nonce: Uint8Array,
                                 color: Uint8Array,
                                 value: bigint,
                                 mt_index: bigint
                               };
    [Symbol.iterator](): Iterator<[Uint8Array, { nonce: Uint8Array, color: Uint8Array, value: bigint, mt_index: bigint }]>
  };
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>,
               initial_device_commitment_0: bigint,
               recovery_commitment_0: bigint,
               share_1_0: Uint8Array,
               share_2_0: Uint8Array,
               share_3_0: Uint8Array): Promise<__compactRuntime.ConstructorResult<PS>>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
export declare const expectedVk: Record<string, string>;
