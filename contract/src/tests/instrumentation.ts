// Shared localnet instrumentation for the interactive and scripted P-256
// probes: hex transport parsing, the node/indexer consistency check, a timed
// proving provider, and accepted-transaction confirmation.
import { strict as assert } from 'node:assert';
import { CostModel } from '@midnightntwrk/ledger-v9';
import { nodeZkConfigRegistry } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProvingProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { createProofProviderFromHandlers } from '@midnight-ntwrk/midnight-js-types';
import type { TestContext } from '../node/setup.js';
import { CONFIG, managedPath } from '../node/wallet.js';
import { queryTxPosition } from '../wallet/capture.js';

const post = async (url: string, body: unknown): Promise<any> => (await fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})).json();
const stripHex = (s: string | undefined) => s?.replace(/^0x/, '');

/** Strict hex transport field: even-length hex string, optional exact length. */
export function bytes(value: unknown, length?: number): Uint8Array {
  assert.equal(typeof value, 'string', 'hex string required');
  assert.match(value as string, /^(?:[0-9a-f]{2})+$/i, 'invalid hex');
  const result = new Uint8Array(Buffer.from(value as string, 'hex'));
  if (length !== undefined) assert.equal(result.length, length);
  return result;
}

/** The node's block hash at a height, as returned by `chain_getBlockHash`. */
export async function nodeBlockHash(height: number): Promise<string | undefined> {
  const rpc = await post(CONFIG.node, { jsonrpc: '2.0', id: 1, method: 'chain_getBlockHash', params: [height] });
  return rpc.result;
}

/**
 * A dev node may have been recreated while its indexer kept the old chain.
 * Wallet isSynced then means synced to stale indexed data, not to this node.
 * Returns the indexed tip (with the requested fields) and the node's hash.
 */
export async function assertNodeIndexerConsistent(fields = 'height hash timestamp') {
  const indexed = await post(CONFIG.indexer, { query: `{ block { ${fields} } }` });
  assert.equal(indexed.errors, undefined);
  const block = indexed.data?.block;
  assert.ok(block, 'indexer has no block yet');
  const hash = await nodeBlockHash(block.height);
  assert.equal(stripHex(hash), stripHex(block.hash),
    'Node/indexer chain mismatch; the indexer must be rebuilt for this dev chain before spending DUST');
  return { block, nodeBlockHash: hash };
}

export interface ProofSample { keyLocation: unknown; startedAt: string; milliseconds: number; proofBytes: number }

/** Replaces the proof provider with one that times every HTTP proof. */
export async function installTimedProver(providers: TestContext['providers'],
  onSample: (sample: ProofSample) => void, onStart?: () => void) {
  const base = httpClientProvingProvider(CONFIG.proofServer, await nodeZkConfigRegistry(managedPath));
  const timed = { ...base, async prove(...args: Parameters<typeof base.prove>) {
    onStart?.();
    const startedAt = new Date().toISOString(), start = performance.now();
    const proof = await base.prove(...args);
    onSample({ keyLocation: args[1], startedAt, milliseconds: performance.now() - start, proofBytes: proof.length });
    return proof;
  } };
  providers.proofProvider = createProofProviderFromHandlers({ currentEra: tx => tx.prove(timed, CostModel.initialCostModel()) });
}

/** Confirms an accepted transaction; optionally cross-checks its block on the node. */
export async function confirmTransaction(txId: string, checkNode = false) {
  const position = await queryTxPosition(txId);
  assert.equal(position.error, undefined); assert.equal(position.status, 'SUCCESS');
  if (!checkNode) return { txId, ...position };
  const row: any = position.raw;
  const hash = await nodeBlockHash(position.blockHeight!);
  assert.equal(stripHex(hash), stripHex(row.block.hash));
  return { txId, ...position, nodeBlockHash: hash };
}
