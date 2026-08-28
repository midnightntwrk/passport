import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export enum AddressType { ContractAddr = 0, ZswapCPKAddr = 1, UnshieldedAddr = 2
}

export type DomainData = { owner: Uint8Array; resolver: { bytes: Uint8Array } };

export type Either<A, B> = { is_left: boolean; left: A; right: B };

export type Maybe<T> = { is_some: boolean; value: T };

export type Witnesses<PS> = {
  secretKey(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
}

export type ImpureCircuits<PS> = {
  update_color(context: __compactRuntime.CircuitContext<PS>, c_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
  update_costs(context: __compactRuntime.CircuitContext<PS>,
               cost_short_0: bigint,
               cost_med_0: bigint,
               cost_long_0: bigint,
               enabled_0: boolean): Promise<__compactRuntime.CircuitResults<PS, []>>;
  update_default_field(context: __compactRuntime.CircuitContext<PS>,
                       d_0: Maybe<string>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  add_multiple_fields(context: __compactRuntime.CircuitContext<PS>,
                      kvs_0: Maybe<[string, string]>[]): Promise<__compactRuntime.CircuitResults<PS, []>>;
  clear_field(context: __compactRuntime.CircuitContext<PS>, k_0: string): Promise<__compactRuntime.CircuitResults<PS, []>>;
  clear_all_fields(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  register_domain_for(context: __compactRuntime.CircuitContext<PS>,
                      owner_0: Uint8Array,
                      domain_0: Uint8Array,
                      len_0: bigint,
                      resolver_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  set_resolver(context: __compactRuntime.CircuitContext<PS>,
               domain_0: Uint8Array,
               resolver_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  update_domain_target(context: __compactRuntime.CircuitContext<PS>,
                       new_target_0: Either<{ bytes: Uint8Array },
                                            Either<{ bytes: Uint8Array },
                                                   { bytes: Uint8Array }>>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  transfer_domain(context: __compactRuntime.CircuitContext<PS>,
                  domain_0: Uint8Array,
                  new_owner_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
  change_owner(context: __compactRuntime.CircuitContext<PS>,
               new_owner_0: Uint8Array,
               new_address_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, []>>;
}

export type ProvableCircuits<PS> = {
  update_color(context: __compactRuntime.CircuitContext<PS>, c_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
  update_costs(context: __compactRuntime.CircuitContext<PS>,
               cost_short_0: bigint,
               cost_med_0: bigint,
               cost_long_0: bigint,
               enabled_0: boolean): Promise<__compactRuntime.CircuitResults<PS, []>>;
  update_default_field(context: __compactRuntime.CircuitContext<PS>,
                       d_0: Maybe<string>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  add_multiple_fields(context: __compactRuntime.CircuitContext<PS>,
                      kvs_0: Maybe<[string, string]>[]): Promise<__compactRuntime.CircuitResults<PS, []>>;
  clear_field(context: __compactRuntime.CircuitContext<PS>, k_0: string): Promise<__compactRuntime.CircuitResults<PS, []>>;
  clear_all_fields(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  register_domain_for(context: __compactRuntime.CircuitContext<PS>,
                      owner_0: Uint8Array,
                      domain_0: Uint8Array,
                      len_0: bigint,
                      resolver_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  set_resolver(context: __compactRuntime.CircuitContext<PS>,
               domain_0: Uint8Array,
               resolver_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  update_domain_target(context: __compactRuntime.CircuitContext<PS>,
                       new_target_0: Either<{ bytes: Uint8Array },
                                            Either<{ bytes: Uint8Array },
                                                   { bytes: Uint8Array }>>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  transfer_domain(context: __compactRuntime.CircuitContext<PS>,
                  domain_0: Uint8Array,
                  new_owner_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
  change_owner(context: __compactRuntime.CircuitContext<PS>,
               new_owner_0: Uint8Array,
               new_address_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, []>>;
}

export type PureCircuits = {
}

export type Circuits<PS> = {
  update_color(context: __compactRuntime.CircuitContext<PS>, c_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
  update_costs(context: __compactRuntime.CircuitContext<PS>,
               cost_short_0: bigint,
               cost_med_0: bigint,
               cost_long_0: bigint,
               enabled_0: boolean): Promise<__compactRuntime.CircuitResults<PS, []>>;
  update_default_field(context: __compactRuntime.CircuitContext<PS>,
                       d_0: Maybe<string>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  add_multiple_fields(context: __compactRuntime.CircuitContext<PS>,
                      kvs_0: Maybe<[string, string]>[]): Promise<__compactRuntime.CircuitResults<PS, []>>;
  clear_field(context: __compactRuntime.CircuitContext<PS>, k_0: string): Promise<__compactRuntime.CircuitResults<PS, []>>;
  clear_all_fields(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  register_domain_for(context: __compactRuntime.CircuitContext<PS>,
                      owner_0: Uint8Array,
                      domain_0: Uint8Array,
                      len_0: bigint,
                      resolver_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  set_resolver(context: __compactRuntime.CircuitContext<PS>,
               domain_0: Uint8Array,
               resolver_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, []>>;
  update_domain_target(context: __compactRuntime.CircuitContext<PS>,
                       new_target_0: Either<{ bytes: Uint8Array },
                                            Either<{ bytes: Uint8Array },
                                                   { bytes: Uint8Array }>>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  transfer_domain(context: __compactRuntime.CircuitContext<PS>,
                  domain_0: Uint8Array,
                  new_owner_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
  change_owner(context: __compactRuntime.CircuitContext<PS>,
               new_owner_0: Uint8Array,
               new_address_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, []>>;
}

export type Ledger = {
  readonly PARENT_DOMAIN: Maybe<Uint8Array>;
  readonly PARENT_RESOLVER: { bytes: Uint8Array };
  readonly DOMAIN: Maybe<Uint8Array>;
  readonly DOMAIN_OWNER: [Uint8Array, { bytes: Uint8Array }];
  readonly DOMAIN_TARGET: Either<{ bytes: Uint8Array },
                                 Either<{ bytes: Uint8Array },
                                        { bytes: Uint8Array }>>;
  domains: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): DomainData;
    [Symbol.iterator](): Iterator<[Uint8Array, DomainData]>
  };
  domains_owned: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): {
      isEmpty(): boolean;
      size(): bigint;
      member(elem_0: Uint8Array): boolean;
      [Symbol.iterator](): Iterator<Uint8Array>
    }
  };
  fields: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: string): boolean;
    lookup(key_0: string): string;
    [Symbol.iterator](): Iterator<[string, string]>
  };
  readonly DEFAULT_FIELD: Maybe<string>;
  readonly BUY_ENABLED: boolean;
  readonly COIN_COLOR: Uint8Array;
  readonly COST_SHORT: bigint;
  readonly COST_MED: bigint;
  readonly COST_LONG: bigint;
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
               parent_domain_0: Maybe<Uint8Array>,
               parent_resolver_0: { bytes: Uint8Array },
               target_0: [Uint8Array, AddressType],
               domain_0: Maybe<Uint8Array>,
               coin_color_0: Uint8Array,
               cost_short_0: bigint,
               cost_med_0: bigint,
               cost_long_0: bigint,
               default_field_0: Maybe<string>,
               buy_enabled_0: boolean,
               owner_pubkey_0: Uint8Array,
               owner_address_0: { bytes: Uint8Array },
               kvs_0: Maybe<[string, string]>[]): Promise<__compactRuntime.ConstructorResult<PS>>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
export declare const expectedVk: Record<string, string>;
