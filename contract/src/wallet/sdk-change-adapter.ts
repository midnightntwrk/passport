import { createUnprovenCallTx } from '@midnight-ntwrk/midnight-js-contracts';
import { ZswapInput } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { versionOfRecord } from '@midnight-ntwrk/midnight-js-protocol/version';
import { httpClientProvingProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import type { DurableTransactionAdapter, TransactionObservation } from './change-journal.js';
import type { ShieldedCoin } from './contract.js';

export interface SdkChangeAdapterOptions {
  providers: any;
  compiledContract: any;
  address: string;
  privateStateId: string;
  /** The indexer for the same network as providers. No global URL fallback. */
  indexerUrl: string;
  /** Trusted prover: qualification sends the private coin witness here. */
  proofServerUrl: string;
  /** Maximum wait after one submission. Expiry means unknown, never rejection. */
  observationTimeoutMs?: number;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  maxQualificationCandidates?: number;
}

const query = `query DurableChangeTransaction($offset: TransactionOffset!) {
  transactions(offset: $offset) {
    protocolVersion hash block { hash }
    ... on RegularTransaction {
      identifiers zswapStartIndex zswapEndIndex
      transactionResult { status segments { id success } }
    }
  }
}`;

function normaliseId(id: string): string {
  if (typeof id !== 'string' || !/^(0x)?[0-9a-fA-F]+$/.test(id)) {
    throw new Error('invalid transaction identifier');
  }
  return id.replace(/^0x/, '').toLowerCase();
}

function indexOf(value: unknown): bigint {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new Error('missing or unsafe commitment-tree position');
}

function boundedInteger(value: number, name: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`invalid ${name}`);
  return value;
}

/**
 * Pinned v9 adapter. Preparation proves and balances but never submits or writes
 * speculative private state. Observation is finite, and never infers rejection
 * from an absent transaction. Use a dedicated provider instance for this account.
 */
export function createSdkChangeAdapter(options: SdkChangeAdapterOptions): DurableTransactionAdapter {
  const { providers, compiledContract, address, privateStateId } = options;
  const observationTimeout = boundedInteger(options.observationTimeoutMs ?? 60_000, 'observation timeout', true);
  const requestTimeout = boundedInteger(options.requestTimeoutMs ?? 15_000, 'request timeout');
  const pollInterval = boundedInteger(options.pollIntervalMs ?? 1_000, 'poll interval');
  const maxCandidates = boundedInteger(options.maxQualificationCandidates ?? 256, 'qualification candidate limit');
  for (const url of [options.indexerUrl, options.proofServerUrl]) {
    if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('unsupported recovery endpoint protocol');
  }
  const proving = httpClientProvingProvider(options.proofServerUrl, providers.zkConfigProvider, { timeout: requestTimeout });

  async function receipt(transactionIds: string[], deadline?: number): Promise<any | null> {
    const expected = new Set(transactionIds.map(normaliseId));
    if (!expected.size) throw new Error('transaction identifiers are required');
    for (const identifier of expected) {
      const remaining = deadline === undefined ? requestTimeout : Math.min(requestTimeout, deadline - Date.now());
      if (remaining <= 0) return null;
      const response = await fetch(options.indexerUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { offset: { identifier } } }),
        signal: AbortSignal.timeout(remaining),
      });
      if (!response.ok) throw new Error(`recovery indexer returned HTTP ${response.status}`);
      const body: any = await response.json();
      if (body.errors?.length || !Array.isArray(body.data?.transactions)) throw new Error('invalid recovery indexer response');
      // Offset queries may also return later records. Never adopt an unrelated row.
      for (const record of body.data.transactions) {
        if (!Array.isArray(record.identifiers) || !record.identifiers.some((id: string) => expected.has(normaliseId(id)))) continue;
        if (versionOfRecord(record) !== 'v9') throw new Error('recovery transaction uses an unsupported ledger era');
        return record;
      }
    }
    return null;
  }

  function observation(record: any | null): TransactionObservation {
    if (!record) return { status: 'unknown', transactionIds: [] };
    const transactionIds = record.identifiers.map(normaliseId);
    const status = record.transactionResult?.status;
    const segments = record.transactionResult?.segments ?? [];
    if (!Array.isArray(segments) || segments.some((s: any) => !s || typeof s.success !== 'boolean')) {
      return { status: 'unknown', transactionIds };
    }
    if (status === 'SUCCESS' && !segments.some((s: any) => !s.success)) {
      return { status: 'succeeded', transactionIds };
    }
    if (status === 'PARTIAL_SUCCESS') return { status: 'partial', transactionIds };
    if (status === 'FAILURE' && !segments.some((s: any) => s.success)) return { status: 'rejected', transactionIds };
    return { status: 'unknown', transactionIds };
  }

  const observe: DurableTransactionAdapter['observe'] = async ids => {
    try { return observation(await receipt(ids)); }
    catch { return { status: 'unknown', transactionIds: [] }; }
  };

  return {
    async prepare(circuitId, args) {
      providers.privateStateProvider.setContractAddress(address);
      const prepared = await (createUnprovenCallTx as any)(providers, {
        compiledContract, contractAddress: address, privateStateId, circuitId, args,
      });
      const value = prepared.private.result;
      const direct = circuitId.startsWith('withdraw_shielded_to_contract_');
      if (direct && (!Array.isArray(value) || value.length !== 2 || !value[0]?.nonce)) {
        throw new Error('direct spend returned no valid sent/change pair');
      }
      const maybeChange = direct ? value[1] : value;
      if (circuitId.startsWith('withdraw_shielded_') && typeof maybeChange?.is_some !== 'boolean') {
        throw new Error('shielded spend returned no valid change result');
      }
      const change: ShieldedCoin | null = maybeChange?.is_some ? {
        nonce: new Uint8Array(maybeChange.value.nonce), color: new Uint8Array(maybeChange.value.color), value: maybeChange.value.value,
      } : null;
      const proven = await providers.proofProvider.proveTx({ version: 'v9', tx: prepared.private.unprovenTx });
      if (proven.version !== 'v9') throw new Error('unsupported proven transaction era');
      const balanced = await providers.walletProvider.balanceTx(proven);
      if (balanced.version !== 'v9') throw new Error('unsupported balanced transaction era');
      const transactionIds = [...new Set<string>(balanced.tx.identifiers().map(normaliseId))];
      if (!transactionIds.length) throw new Error('balanced transaction has no identifiers');
      let submitted = false;
      return {
        transactionIds, change,
        result: { public: { txId: transactionIds[0] }, private: { result: value } },
        async submit() {
          if (submitted) throw new Error('prepared transaction has already been submitted');
          submitted = true;
          // The coordinator has persisted identifiers, change, and submitting
          // before this closure is invoked. A thrown acknowledgement is unknown.
          const acknowledgement = await providers.midnightProvider.submitTx(balanced);
          const deadline = Date.now() + observationTimeout;
          while (Date.now() < deadline) {
            try {
              if (observation(await receipt(transactionIds, deadline)).status !== 'unknown') break;
            } catch { /* A bounded observation failure leaves the outcome unknown. */ }
            if (Date.now() >= deadline) break;
            await new Promise(resolve => setTimeout(resolve, Math.min(pollInterval, deadline - Date.now())));
          }
          return acknowledgement;
        },
      };
    },
    observe,
    async qualify(change, transactionIds) {
      const record = await receipt(transactionIds);
      if (observation(record).status !== 'succeeded') throw new Error('change transaction has not succeeded entirely');
      const start = indexOf(record.zswapStartIndex);
      const end = indexOf(record.zswapEndIndex);
      if (end <= start || end - start > BigInt(maxCandidates)) throw new Error('invalid or excessive change qualification range');
      if (typeof record.block?.hash !== 'string' || !record.block.hash) throw new Error('change receipt has no block hash');
      const snapshot = await providers.publicDataProvider.queryZSwapAndContractState(address, { blockHash: record.block.hash });
      if (!snapshot) throw new Error('change commitment snapshot is unavailable');
      for (let mt_index = start; mt_index < end; mt_index++) {
        try {
          const input = ZswapInput.newContractOwned({
            nonce: Buffer.from(change.nonce).toString('hex'), type: Buffer.from(change.color).toString('hex'),
            value: change.value, mt_index,
          }, 0, address, snapshot[0]);
          // Construction alone accepts a wrong occupied index. Checking the
          // spend constraints establishes commitment membership without sending.
          // Successful check output is public-input skip metadata, not a list
          // of failures. Unsatisfied constraints reject the check request.
          await proving.check(input.proof.serialize(), 'midnight/zswap/spend');
          return { ...change, mt_index };
        } catch {
          // A failed check or transport never qualifies a candidate. The journal
          // retains it for a subsequent attempt, without speculative adoption.
        }
      }
      throw new Error('no verified commitment-tree position for change');
    },
  };
}
