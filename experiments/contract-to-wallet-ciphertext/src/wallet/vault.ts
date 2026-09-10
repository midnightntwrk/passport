// Vault — the client over a deployed vault contract instance.
//
// Deposits go through the ordinary deployed-contract handle. Sends go
// through the EXPLICIT call path (createUnprovenCallTx → inspect → submitTx)
// because that is where the executor gets to say which encryption key each
// recipient coin public key should be sealed to. That single option,
// `additionalCoinEncPublicKeyMappings`, is the whole experiment.

import {
  deployContract,
  findDeployedContract,
  createUnprovenCallTx,
  submitTx,
} from '@midnight-ntwrk/midnight-js-contracts';

import { ledger, type Ledger, type ShieldedCoin } from './contract.js';
import {
  emptyCoinStore,
  withCoin,
  withoutCoin,
  type CoinStorePrivateState,
} from './witnesses.js';
import { bytesToHex, anyToHex } from './hex.js';

export interface TxResult {
  txId: string;
}

/** Which send circuit to call: cooperative or MIP-0012-shaped. */
export type SendCircuit = 'send_to_user' | 'send_to_user_opaque';

export interface SendRequest {
  circuit: SendCircuit;
  /** The recipient's 32-byte Zswap coin public key (the circuit argument). */
  recipient: Uint8Array;
  color: Uint8Array;
  amount: bigint;
  /**
   * CoinPublicKey (hex) → EncPublicKey (hex), the executor's answer to
   * "which key should this recipient's ciphertext be sealed to?".
   * Undefined means the executor supplies none.
   */
  mapping?: ReadonlyMap<string, string>;
}

export interface OutputSummary {
  commitment: string;
  /** Set when the output is contract-owned; absent for user-targeted outputs. */
  contractAddress: string | null;
  /** Serialised size — a ciphertext-bearing output is materially larger. */
  serialisedBytes: number;
  /** The serialised output, so a probe can check what it does not contain. */
  serialisedHex: string;
}

export interface SendOutcome extends TxResult {
  /**
   * The recipient's coin as the CIRCUIT returned it. Null for the opaque
   * circuit, which discloses nothing about the recipient's coin.
   */
  sentFromCircuit: ShieldedCoin | null;
  /**
   * The recipient's coin as the EXECUTOR's own runtime recorded it, read
   * from the circuit's Zswap local state. Present for both circuits — this
   * is the knowledge the contract never had to hand over.
   */
  sentFromRuntime: ShieldedCoin | null;
  /** The vault's own surviving change coin, if the spend was partial. */
  change: ShieldedCoin | null;
  /** The outputs the SDK built for this transaction, before proving. */
  outputs: OutputSummary[];
  /** Every coin the circuit created, as the executor's runtime recorded it. */
  runtimeOutputs: Array<{ recipientIsUser: boolean; nonce: string; colour: string; value: string }>;
}

function txIdOf(r: any): string {
  const id = r?.public?.txId ?? r?.public?.transactionHash ?? r?.txId ?? r?.transactionHash;
  if (!id) throw new Error('contract call returned without a transaction id');
  return id;
}

function toShieldedCoin(v: any): ShieldedCoin | null {
  if (!v?.nonce) return null;
  // The circuit's return value calls the token type `color`; the runtime's
  // own record of the same coin calls it `type`. Same 32 bytes either way.
  return { nonce: v.nonce, color: v.color ?? v.type, value: v.value };
}

/** Summarise the Zswap outputs the SDK built, for evidence. */
function summariseOutputs(unprovenTx: any): OutputSummary[] {
  const out: OutputSummary[] = [];
  const offers: any[] = [];
  try {
    if (unprovenTx?.guaranteedOffer) offers.push(unprovenTx.guaranteedOffer);
    const fallible = unprovenTx?.fallibleOffer;
    if (fallible) for (const o of fallible.values()) offers.push(o);
  } catch { /* evidence only */ }
  for (const offer of offers) {
    for (const o of offer?.outputs ?? []) {
      let serialisedBytes = -1;
      let serialisedHex = '';
      try {
        const raw: Uint8Array = o.serialize();
        serialisedBytes = raw.length;
        serialisedHex = bytesToHex(raw);
      } catch { /* evidence only */ }
      out.push({
        commitment: String(o?.commitment ?? ''),
        contractAddress: o?.contractAddress ?? null,
        serialisedBytes,
        serialisedHex,
      });
    }
  }
  return out;
}

export class Vault {
  private constructor(
    readonly address: string,
    readonly providers: any,
    readonly privateStateId: string,
    private readonly compiledContract: any,
    private readonly handle: any,
  ) {}

  static async deploy(providers: any, compiledContract: any): Promise<Vault> {
    const privateStateId = freshPrivateStateId();
    const deployed = await deployContract(providers, {
      compiledContract,
      privateStateId,
      initialPrivateState: emptyCoinStore(),
    } as any);
    // deployContract does not persist initialPrivateState to the provider;
    // createUnprovenCallTx(privateStateId) requires it to be present.
    await providers.privateStateProvider.set(privateStateId, emptyCoinStore());
    return new Vault(
      deployed.deployTxData.public.contractAddress,
      providers,
      privateStateId,
      compiledContract,
      deployed,
    );
  }

  static async connect(providers: any, compiledContract: any, address: string): Promise<Vault> {
    const privateStateId = freshPrivateStateId();
    const found = await (findDeployedContract as any)(providers, {
      contractAddress: address,
      compiledContract,
      privateStateId,
      initialPrivateState: emptyCoinStore(),
    });
    return new Vault(address, providers, privateStateId, compiledContract, found);
  }

  // ── Ledger reads ──────────────────────────────────────────────────────────

  async ledgerState(): Promise<Ledger> {
    const state = await this.providers.publicDataProvider.queryContractState(this.address);
    if (!state) throw new Error(`no contract state found at ${this.address}`);
    return ledger(state.data);
  }

  // ── Wallet-local coin store ───────────────────────────────────────────────

  async coinStore(): Promise<CoinStorePrivateState> {
    const s = await this.providers.privateStateProvider.get(this.privateStateId);
    return (s as CoinStorePrivateState) ?? emptyCoinStore();
  }

  async putCoin(
    coin: { nonce: Uint8Array; color: Uint8Array; value: bigint; mtIndex: bigint },
  ): Promise<void> {
    const s = await this.coinStore();
    await this.providers.privateStateProvider.set(this.privateStateId, withCoin(s, coin));
  }

  async dropCoin(color: Uint8Array): Promise<void> {
    const s = await this.coinStore();
    await this.providers.privateStateProvider.set(this.privateStateId, withoutCoin(s, color));
  }

  // ── Deposit ───────────────────────────────────────────────────────────────

  async deposit(coin: ShieldedCoin): Promise<TxResult> {
    const r = await this.handle.callTx.deposit(coin);
    return { txId: txIdOf(r) };
  }

  // ── Send to a user's Zswap key ────────────────────────────────────────────

  /**
   * Build the send transaction WITHOUT submitting it. Throws if the executor
   * supplied no encryption key for a user-targeted output — the SDK refuses
   * to build an output it cannot make discoverable.
   */
  async buildSend(req: SendRequest): Promise<any> {
    const p = this.providers.privateStateProvider;
    if (typeof p.setContractAddress === 'function') await p.setContractAddress(this.address);
    const options: any = {
      compiledContract: this.compiledContract,
      circuitId: req.circuit,
      contractAddress: this.address,
      args: [{ bytes: req.recipient }, req.color, req.amount],
      privateStateId: this.privateStateId,
    };
    if (req.mapping) options.additionalCoinEncPublicKeyMappings = req.mapping;
    return (createUnprovenCallTx as any)(this.providers, options);
  }

  /**
   * Send `amount` of `color` to a user's Zswap key, in ONE transaction,
   * with the recipient ciphertext the executor chose to attach.
   *
   * `candidates` are the possible mt_index values of the held coin; a wrong
   * one fails at proving inside submitTx, before any transaction exists.
   */
  async sendToUser(req: SendRequest, heldCoin: {
    nonce: Uint8Array; color: Uint8Array; value: bigint;
  }, candidates: bigint[]): Promise<SendOutcome & { attempts: Array<{ mtIndex: string; outcome: string }> }> {
    const attempts: Array<{ mtIndex: string; outcome: string }> = [];
    for (const mtIndex of candidates) {
      await this.putCoin({ ...heldCoin, mtIndex });
      const call: any = await this.buildSend(req);

      // What the CIRCUIT disclosed.
      const result = call?.private?.result;
      let sentFromCircuit: ShieldedCoin | null = null;
      let change: ShieldedCoin | null = null;
      if (Array.isArray(result)) {
        sentFromCircuit = toShieldedCoin(result[0]);
        change = result[1]?.is_some ? toShieldedCoin(result[1].value) : null;
      } else if (result) {
        change = result.is_some ? toShieldedCoin(result.value) : null;
      }

      // What the EXECUTOR's own runtime recorded, contract cooperation or
      // not: every coin the circuit created, with its full opening.
      const runtimeOutputs: any[] = call?.private?.nextZswapLocalState?.outputs ?? [];
      const sentFromRuntime = toShieldedCoin(
        runtimeOutputs.find((o) => o?.recipient?.is_left)?.coinInfo,
      );
      const runtimeOutputSummary = runtimeOutputs.map((o) => ({
        recipientIsUser: Boolean(o?.recipient?.is_left),
        nonce: anyToHex(o?.coinInfo?.nonce),
        colour: anyToHex(o?.coinInfo?.color ?? o?.coinInfo?.type),
        value: String(o?.coinInfo?.value ?? ''),
      }));

      const outputs = summariseOutputs(call?.private?.unprovenTx);

      try {
        const finalized: any = await (submitTx as any)(this.providers, {
          unprovenTx: call.private.unprovenTx,
          circuitId: req.circuit,
        });
        const txId = txIdOf(finalized);
        attempts.push({ mtIndex: mtIndex.toString(), outcome: `accepted: ${txId}` });
        return { txId, sentFromCircuit, sentFromRuntime, change, outputs, runtimeOutputs: runtimeOutputSummary, attempts };
      } catch (e: any) {
        attempts.push({
          mtIndex: mtIndex.toString(),
          outcome: `rejected: ${String(e?.message ?? e).slice(0, 100)}`,
        });
      }
    }
    throw new Error(`no candidate mt_index produced an accepted send: ${JSON.stringify(attempts)}`);
  }

  /** The deployed handle, for probes that need to go below callTx. */
  get raw(): any {
    return this.handle;
  }
}

function freshPrivateStateId(): string {
  const rand = new Uint8Array(8);
  globalThis.crypto.getRandomValues(rand);
  return `vault-${bytesToHex(rand)}`;
}
