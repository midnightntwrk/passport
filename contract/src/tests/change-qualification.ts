// Live native-spend constraint controls. This does not submit a transaction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ZswapChainState, ZswapInput, ZswapOutput, ZswapOffer,
  createShieldedCoinInfo, sampleRawTokenType, dummyContractAddress,
  createCheckPayload, parseCheckResult,
} from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { createSdkChangeAdapter } from '../wallet/sdk-change-adapter.js';

test('live prover qualifies the actual commitment and rejects a wrong occupied index', async () => {
  const proofServerUrl = process.env.PROOF_SERVER_URL;
  assert(proofServerUrl, 'set PROOF_SERVER_URL to a trusted local proof server');
  const address = dummyContractAddress();
  const coin = createShieldedCoinInfo(sampleRawTokenType(), 100n);
  const other = createShieldedCoinInfo(coin.type, 100n);
  const first = ZswapOutput.newContractOwned(coin, 0, address);
  const second = ZswapOutput.newContractOwned(other, 0, address);
  const [initial, commitments] = new ZswapChainState().tryApply(
    ZswapOffer.fromOutput(first).merge(ZswapOffer.fromOutput(second)));
  const chain = initial.postBlockUpdate(new Date(), 600n);
  const correct = commitments.get(first.commitment)!;
  const wrong = commitments.get(second.commitment)!;
  assert.notEqual(correct, wrong);
  for (const [label, index] of [['correct', correct], ['wrong occupied', wrong]] as const) {
    // Both inputs construct successfully. Only checking the constraints rejects
    // the occupied index whose commitment belongs to the other coin.
    const input = ZswapInput.newContractOwned({ ...coin, mt_index: index }, 0, address, chain);
    const response = await fetch(new URL('check', `${proofServerUrl.replace(/\/$/, '')}/`), {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
      body: createCheckPayload(input.proof.serialize()) as BodyInit,
      signal: AbortSignal.timeout(60_000),
    });
    if (label === 'correct') {
      assert.equal(response.status, 200, await response.clone().text());
      const metadata = parseCheckResult(new Uint8Array(await response.arrayBuffer()));
      assert(Array.isArray(metadata), 'successful check returns public-input skip metadata');
      console.log(`Correct index accepted; check metadata entries: ${metadata.length}`);
    } else {
      const reason = await response.text();
      assert.equal(response.status, 400, reason);
      assert.match(reason, /assert|constraint|public transcript input mismatch/i,
        'the witness must fail constraints or their public binding, not payload decoding');
      console.log('Wrong occupied index rejected by spend constraints');
    }
  }
});

test('SDK qualification skips the occupied wrong candidate and refuses an all-wrong window', async () => {
  const proofServerUrl = process.env.PROOF_SERVER_URL;
  assert(proofServerUrl, 'set PROOF_SERVER_URL to a trusted local proof server');
  const address = dummyContractAddress(), type = sampleRawTokenType();
  const coins = [createShieldedCoinInfo(type, 70n), createShieldedCoinInfo(type, 90n)];
  const outputs = coins.map(coin => ZswapOutput.newContractOwned(coin, 0, address));
  const [initial, commitments] = new ZswapChainState().tryApply(
    ZswapOffer.fromOutput(outputs[0]).merge(ZswapOffer.fromOutput(outputs[1])));
  const target = commitments.get(outputs[0].commitment)! > commitments.get(outputs[1].commitment)! ? 0 : 1;
  const index = commitments.get(outputs[target].commitment)!;
  assert.equal(index, 1n, 'the target must follow an occupied wrong candidate');
  const chain = initial.postBlockUpdate(new Date(), 600n);
  const change = { nonce: new Uint8Array(Buffer.from(coins[target].nonce, 'hex')),
    color: new Uint8Array(Buffer.from(type, 'hex')), value: coins[target].value };
  const id = '11'.repeat(32), blockHash = '22'.repeat(32);
  let end = '2', submissions = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) === 'https://indexer.invalid/graphql') return Response.json({ data: { transactions: [{
      protocolVersion: 2_000_000, identifiers: [id], block: { hash: blockHash },
      zswapStartIndex: '0', zswapEndIndex: end, transactionResult: { status: 'SUCCESS', segments: [] },
    }] } });
    return originalFetch(url, init);
  };
  try {
    const adapter = createSdkChangeAdapter({ address, privateStateId: 'qualification-control', compiledContract: {},
      proofServerUrl, indexerUrl: 'https://indexer.invalid/graphql', providers: {
        zkConfigProvider: { get: async () => { throw new Error('native key supplied by the proof server'); } },
        publicDataProvider: { queryZSwapAndContractState: async (requested: string, config: any) => {
          assert.equal(requested, address);
          assert.deepEqual(config, { blockHash });
          return [chain, {}, {}];
        } },
        midnightProvider: { submitTx: async () => { submissions++; throw new Error('qualification must not submit'); } },
      } });
    assert.equal((await adapter.qualify(change, [id])).mt_index, index);
    end = '1';
    await assert.rejects(adapter.qualify(change, [id]), /no verified commitment-tree position/);
    assert.equal(submissions, 0);
  } finally { globalThis.fetch = originalFetch; }
});
