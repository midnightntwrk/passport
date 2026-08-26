import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type Witnesses<PS> = {
}

export type ImpureCircuits<PS> = {
  mint_shielded(context: __compactRuntime.CircuitContext<PS>,
                color_0: Uint8Array,
                amount_0: bigint,
                nonce_0: Uint8Array,
                recipient_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, []>>;
}

export type ProvableCircuits<PS> = {
  mint_shielded(context: __compactRuntime.CircuitContext<PS>,
                color_0: Uint8Array,
                amount_0: bigint,
                nonce_0: Uint8Array,
                recipient_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, []>>;
}

export type PureCircuits = {
}

export type Circuits<PS> = {
  mint_shielded(context: __compactRuntime.CircuitContext<PS>,
                color_0: Uint8Array,
                amount_0: bigint,
                nonce_0: Uint8Array,
                recipient_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, []>>;
}

export type Ledger = {
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>): Promise<__compactRuntime.ConstructorResult<PS>>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
export declare const expectedVk: Record<string, string>;
