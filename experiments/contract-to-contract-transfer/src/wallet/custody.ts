// StatelessCustody — the high-level client over a deployed stateless-custody
// contract instance. Owns the private-state bookkeeping that IS the design:
// captured coins go into the wallet-local store (witness source), never into
// public ledger state.

import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';

import { ledger, type Ledger, type ShieldedCoin } from './contract.js';
import {
  emptyCoinStore,
  withCoin,
  withoutCoin,
  type CoinStorePrivateState,
} from './witnesses.js';
import { bytesToHex, hexToBytes } from './hex.js';
import type { EncKeyPair } from './coinstore.js';

export interface TxResult {
  txId: string;
}

export interface SpendOutcome extends TxResult {
  /** The change coin returned by the circuit (private channel), if any. */
  change: ShieldedCoin | null;
  /** Which surface of the call result carried the circuit's return value. */
  resultSurface: string | null;
  /** The raw probe trace, for evidence. */
  probes: Array<{ surface: string; present: boolean }>;
  /** Summary of r.private.nextZswapLocalState (OZ discovery-flow surface). */
  zswapLocal?: unknown;
}

function txId(r: any): string {
  const id = r?.public?.txId ?? r?.public?.transactionHash;
  if (!id) throw new Error('contract call returned without a transaction id');
  return id;
}

/**
 * The circuit's declared return value travels in the call result's private
 * section, but the exact property path differs across midnight-js versions.
 * Probe the plausible surfaces and record which one answered — the discovery
 * flow is itself part of what this experiment documents.
 */
function extractCircuitResult(r: any): { value: any; surface: string | null; probes: Array<{ surface: string; present: boolean }> } {
  const surfaces: Array<[string, () => any]> = [
    ['private.result', () => r?.private?.result],
    ['private.circuitResult', () => r?.private?.circuitResult],
    ['private.returnValue', () => r?.private?.returnValue],
    ['result', () => r?.result],
    ['public.result', () => r?.public?.result],
  ];
  const probes: Array<{ surface: string; present: boolean }> = [];
  let value: any;
  let surface: string | null = null;
  for (const [name, get] of surfaces) {
    let v: any;
    try { v = get(); } catch { v = undefined; }
    probes.push({ surface: name, present: v !== undefined });
    if (v !== undefined && surface === null) {
      value = v;
      surface = name;
    }
  }
  return { value, surface, probes };
}

export class StatelessCustody {
  private constructor(
    readonly address: string,
    readonly providers: any,
    readonly privateStateId: string,
    private readonly handle: any,
  ) {}

  static async deploy(
    providers: any,
    compiledContract: any,
    encKeys: EncKeyPair,
  ): Promise<StatelessCustody> {
    const privateStateId = freshPrivateStateId();
    const deployed = await deployContract(providers, {
      compiledContract,
      privateStateId,
      initialPrivateState: emptyCoinStore(encKeys.secretKey),
      args: [encKeys.publicKey],
    } as any);
    // deployContract does not persist initialPrivateState to the provider;
    // createUnprovenCallTx(privateStateId) requires it to be present. Seed it.
    await providers.privateStateProvider.set(privateStateId, emptyCoinStore(encKeys.secretKey));
    return new StatelessCustody(
      deployed.deployTxData.public.contractAddress,
      providers,
      privateStateId,
      deployed,
    );
  }

  static async connect(
    providers: any,
    compiledContract: any,
    address: string,
    initialState: CoinStorePrivateState = emptyCoinStore(),
  ): Promise<StatelessCustody> {
    const privateStateId = freshPrivateStateId();
    const found = await (findDeployedContract as any)(providers, {
      contractAddress: address,
      compiledContract,
      privateStateId,
      initialPrivateState: initialState,
    });
    return new StatelessCustody(address, providers, privateStateId, found);
  }

  // ── Ledger reads ──────────────────────────────────────────────────────────

  async ledgerState(): Promise<Ledger> {
    const state = await this.providers.publicDataProvider.queryContractState(this.address);
    if (!state) throw new Error(`no contract state found at ${this.address}`);
    return ledger(state.data);
  }

  // ── Wallet-local coin store (the private half of the design) ─────────────

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

  // ── Stateless path ────────────────────────────────────────────────────────

  async depositStateless(coin: ShieldedCoin, blob: Uint8Array): Promise<TxResult> {
    const r = await this.handle.callTx.deposit_stateless(coin, blob);
    return { txId: txId(r) };
  }

  async spendStateless(
    recipientCoinPublicKey: Uint8Array,
    color: Uint8Array,
    amount: bigint,
  ): Promise<SpendOutcome> {
    const r = await this.handle.callTx.spend_stateless({ bytes: recipientCoinPublicKey }, color, amount);
    const { value, surface, probes } = extractCircuitResult(r);
    const change: ShieldedCoin | null =
      value && value.is_some ? (value.value as ShieldedCoin) : null;
    // Evidence capture: the OZ ShieldedMultiSigV3 discovery flow reads the
    // change coin from the private nextZswapLocalState — record what this
    // stack exposes there.
    let zswapLocal: unknown = null;
    try {
      const z = r?.private?.nextZswapLocalState;
      if (z) {
        zswapLocal = {
          keys: Object.keys(z),
          outputs: (z.outputs ?? []).map((o: any) => {
            try { return JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v))); }
            catch { return String(o); }
          }),
        };
      }
    } catch { /* evidence only */ }
    return { txId: txId(r), change, resultSurface: surface, probes, zswapLocal };
  }

  async appendBackup(blob: Uint8Array): Promise<TxResult> {
    const r = await this.handle.callTx.append_backup(blob);
    return { txId: txId(r) };
  }

  // ── Direct contract-to-contract spend (the design under test) ────────────
  //
  // Submits A.spend_to_contract as its OWN transaction. On the current
  // ledger this is expected to fail (the target contract cannot claim the
  // output in the same tx) — P1 records the exact failure. The composed
  // two-call path is built manually in P2, not through this method.

  async spendToContract(
    targetAddress: string,
    color: Uint8Array,
    amount: bigint,
  ): Promise<SpendToContractOutcome> {
    // The circuit's ContractAddress parameter is a struct { bytes: Bytes<32> }.
    const target = { bytes: hexToBytes(targetAddress.replace(/^0x/, '')) };
    const r = await this.handle.callTx.spend_to_contract(target, color, amount);
    const { value, surface, probes } = extractCircuitResult(r);
    let sent: ShieldedCoin | null = null;
    let change: ShieldedCoin | null = null;
    if (Array.isArray(value)) {
      sent = (value[0] as ShieldedCoin) ?? null;
      change = value[1]?.is_some ? (value[1].value as ShieldedCoin) : null;
    }
    return { txId: txId(r), sent, change, resultSurface: surface, probes };
  }

  /** The deployed handle, exposed for probes that need to go below callTx. */
  get raw(): any {
    return this.handle;
  }
}

export interface SpendToContractOutcome extends TxResult {
  sent: ShieldedCoin | null;
  change: ShieldedCoin | null;
  resultSurface: string | null;
  probes: Array<{ surface: string; present: boolean }>;
}

function freshPrivateStateId(): string {
  const rand = new Uint8Array(8);
  globalThis.crypto.getRandomValues(rand);
  return `c2c-${bytesToHex(rand)}`;
}
