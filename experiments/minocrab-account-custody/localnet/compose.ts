// Exact-spend composition through public runtime/ledger APIs. The high-level SDK
// assembles each root independently and rejects an outgoing contract coin before
// another root can claim it. Execute both roots first, then assemble one offer.
import { strict as assert } from 'node:assert';
import { compiledNative, contracts, sdk, types, ledgerApi, rt } from './adapter.js';
import { CONFIG } from '../../../contract/src/node/wallet.js';
import { sealInboxEntry } from '../../../contract/src/wallet/inbox.js';
export async function composeExactSpend(providers: any, sender: any, receiver: any, receiverKey: Uint8Array, coinPublicKey: Uint8Array, circuit: string, args: any[], held: any) {
    const block = await providers.publicDataProvider.queryBlock();
    assert.ok(block?.hash);
    const states = new Map<string, any>();
    const runtime = types.makeContractExecutableRuntime(providers.zkConfigProvider, { coinPublicKey: Buffer.from(coinPublicKey).toString('hex') });
    const executable = sdk.ContractExecutable.make(compiledNative());
    async function execute(account: any, name: string, parameters: any[]) {
        await providers.privateStateProvider.setContractAddress(account.address);
        const state = await contracts.getStates(providers.publicDataProvider, providers.privateStateProvider, account.address, account.privateStateId, block.hash);
        states.set(account.address, state);
        const result = types.exitResultOrError(await runtime.runPromiseExit(executable.circuit(name, {
            address: account.address,
            contractState: state.contractState,
            privateState: state.privateState,
            ledgerParameters: state.ledgerParameters,
            parentBlockHash: block.hash,
        }, ...parameters)));
        assert.equal(result.calls.length, 1);
        assert.equal(result.calls[0].contractAddress, account.address);
        assert.equal(result.calls[0].circuitId, name);
        assert.equal(result.calls[0].communicationCommitment._tag, 'None');
        return result;
    }
    const from = await execute(sender, circuit, args);
    const sent = from.result[0];
    assert.equal(sent.value, held.value, 'this assembler supports exact spends only');
    assert.equal(from.result[1].is_some, false, 'no change output');
    assert.deepEqual(sent.color, held.color);
    const to = await execute(receiver, 'deposit_shielded', [sent, sealInboxEntry(receiverKey, sent)]);
    const input = ledgerApi.ZswapInput.newContractOwned(rt.decodeQualifiedShieldedCoinInfo(held), 0, sender.address, states.get(sender.address).zswapChainState.postBlockUpdate(new Date(), 3600n));
    const output = ledgerApi.ZswapOutput.newContractOwned(rt.decodeShieldedCoinInfo(sent), 0, receiver.address);
    const calls = [from.calls[0], to.calls[0]];
    // Constrain this small assembler to the guaranteed, one-input/one-output case.
    // No transcript, receive claim, or proof verification is bypassed.
    assert.deepEqual(calls[0].public.partitionedTranscript[0].effects.claimedNullifiers, [input.nullifier]);
    assert.deepEqual(calls[0].public.partitionedTranscript[0].effects.claimedShieldedSpends, [output.commitment]);
    assert.deepEqual(calls[0].public.partitionedTranscript[0].effects.claimedShieldedReceives, []);
    assert.deepEqual(calls[1].public.partitionedTranscript[0].effects.claimedShieldedReceives, [output.commitment]);
    assert.deepEqual(calls[1].public.partitionedTranscript[0].effects.claimedNullifiers, []);
    assert.deepEqual(calls[1].public.partitionedTranscript[0].effects.claimedShieldedSpends, []);
    let intent = ledgerApi.Intent.new(new Date(Date.now() + 3600000));
    for (const call of calls) {
        for (const transcript of call.public.partitionedTranscript)
            if (transcript) {
                assert.equal(transcript.effects.claimedUnshieldedSpends.size, 0);
                assert.equal(transcript.effects.claimedContractCalls.length, 0);
                for (const field of ['shieldedMints', 'unshieldedMints', 'unshieldedInputs', 'unshieldedOutputs'])
                    assert.equal(transcript.effects[field].size, 0);
            }
        const fallible = call.public.partitionedTranscript[1];
        if (fallible) {
            assert.deepEqual(fallible.effects.claimedNullifiers, []);
            assert.deepEqual(fallible.effects.claimedShieldedSpends, []);
            assert.deepEqual(fallible.effects.claimedShieldedReceives, []);
        }
        const state = ledgerApi.ContractState.deserialize(states.get(call.contractAddress).contractState.serialize());
        const op = state.operation(call.circuitId);
        assert.ok(op?.verifierKey);
        intent = intent.addCall(new ledgerApi.ContractCallPrototype(call.contractAddress, call.circuitId, op, ...call.public.partitionedTranscript, call.private.privateTranscriptOutputs, call.private.input, call.private.output, ledgerApi.communicationCommitmentRandomness(), sdk.encodeContractKeyLocation({ contractAddress: call.contractAddress, circuitId: call.circuitId, verifierKeyHash: sdk.hashVerifierKey(op.verifierKey) })));
    }
    const offer = ledgerApi.ZswapOffer.fromInput(input).merge(ledgerApi.ZswapOffer.fromOutput(output));
    const unprovenTx = ledgerApi.Transaction.fromPartsRandomized(CONFIG.networkId, offer, undefined, intent);
    const finalized = await contracts.submitTx(providers, { unprovenTx, circuitId: [circuit, 'deposit_shielded'] });
    return { txId: finalized.txId, sent, name: circuit };
}
