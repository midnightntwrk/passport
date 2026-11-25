import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as ledger from '@midnightntwrk/ledger-v9';
import { provingProvider } from '@midnightntwrk/zkir-v3';

const network = 'undeployed';
export const blockTime = Date.parse('2026-11-25T12:00:00Z') / 1000;
export const blockHash = '11'.repeat(32);
const now = new Date(blockTime * 1000);
const ttl = new Date((blockTime + 300) * 1000);
const block = { secondsSinceEpoch: BigInt(blockTime), secondsSinceEpochErr: 1,
  parentBlockHash: blockHash, lastBlockTime: BigInt(blockTime - 1) };

let chain = ledger.LedgerState.blank(network);
const checks = new ledger.WellFormedStrictness();
// The experiment has no wallet/DUST. Keep contract proof verification enabled.
checks.enforceBalancing = false;
checks.verifyContractProofs = true;

function apply(transaction) {
  const verified = transaction.wellFormed(chain, checks, now);
  const [updated, result] = chain.apply(verified, new ledger.TransactionContext(chain, block));
  assert.equal(result.type, 'success', result.error);
  chain = updated;
}

export function deploy(state) {
  const deployment = new ledger.ContractDeploy(ledger.ContractState.deserialize(state.serialize()));
  const intent = ledger.Intent.new(ttl).addDeploy(deployment);
  apply(ledger.Transaction.fromParts(network, undefined, undefined, intent).bind());
  return deployment.address;
}

const provider = provingProvider({
  async lookupKey(location) {
    const [directory, circuit] = location.split('/');
    const file = suffix => readFile(new URL(`./managed/${directory}/${suffix}`, import.meta.url));
    const [proverKey, verifierKey, ir] = await Promise.all([
      file(`keys/${circuit}.prover`), file(`keys/${circuit}.verifier`), file(`zkir/${circuit}.bzkir`),
    ]);
    return { proverKey, verifierKey, ir };
  },
  getParams(k) {
    const directory = process.env.MIDNIGHT_ZK_PARAMS || join(homedir(), '.cache/midnight/zk-params');
    return readFile(join(directory, `bls_midnight_2p${k}`));
  },
});

// Runtime and ledger have separate WASM heaps. Carry state between them using
// the public serialization API and preserve each call's actual context.
export async function proveAndApply(trace, deployments) {
  const calls = trace.map(frame => {
    const target = deployments.get(frame.contractAddress);
    const initial = ledger.ContractState.deserialize(target.state.serialize());
    const ctx = new ledger.QueryContext(initial.data, target.address);
    ctx.block = frame.initialQueryContext.block;
    return new ledger.PrePartitionContractCall(target.address, frame.circuitId, initial.operation(frame.circuitId),
      new ledger.PreTranscript(ctx, frame.publicTranscript, frame.commCommData?.commComm),
      frame.privateTranscriptOutputs, frame.input, frame.output,
      frame.commCommData?.commCommRand ?? ledger.communicationCommitmentRandomness(),
      `${target.directory}/${frame.circuitId}`);
  });
  const tx = ledger.Transaction.fromParts(network).addCalls({ tag: 'first' }, calls, chain.parameters, ttl);
  const proven = (await tx.prove(provider, chain.parameters.transactionCostModel.runtimeCostModel)).bind();
  apply(proven);
  return new Map(trace.map(frame => [frame.contractAddress, chain.index(frame.contractAddress).serialize()]));
}
