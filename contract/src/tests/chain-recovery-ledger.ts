import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ZswapChainState, ZswapOffer, ZswapOutput, ZswapInput,
  createShieldedCoinInfo, sampleRawTokenType, dummyContractAddress,
} from '@midnight-ntwrk/midnight-js-protocol/ledger';

function nativeFixture() {
  const address = dummyContractAddress(), type = sampleRawTokenType();
  const coin = createShieldedCoinInfo(type, 100n), sibling = createShieldedCoinInfo(type, 70n);
  const outputs = [coin, sibling].map(value => ZswapOutput.newContractOwned(value, 0, address));
  const [initial, positions] = new ZswapChainState().tryApply(
    ZswapOffer.fromOutput(outputs[0]).merge(ZswapOffer.fromOutput(outputs[1])));
  const state = initial.postBlockUpdate(new Date('2026-11-11T00:00:00Z'), 600n);
  const qualified = { ...coin, mt_index: positions.get(outputs[0].commitment)! };
  const siblingQualified = { ...sibling, mt_index: positions.get(outputs[1].commitment)! };
  const input = ZswapInput.newContractOwned(qualified, 0, address, state);
  return { address, state, qualified, siblingQualified, input };
}

test('native unspent predicate leaves its snapshot unchanged and rejects the consumed nullifier', () => {
  const f = nativeFixture(), before = f.state.serialize();
  const [spent] = f.state.tryApply(ZswapOffer.fromInput(f.input));
  assert.deepEqual(f.state.serialize(), before, 'testing an input must not mutate the pinned snapshot');
  assert.doesNotThrow(() => f.state.tryApply(ZswapOffer.fromInput(f.input)));
  assert.throws(() => spent.tryApply(ZswapOffer.fromInput(f.input)), error => {
    assert.match(String(error), /double-spend attempt with nullifier/);
    assert.ok(String(error).includes(f.input.nullifier));
    return true;
  });
  const neighbour = ZswapInput.newContractOwned(f.siblingQualified, 0, f.address, spent);
  assert.doesNotThrow(() => spent.tryApply(ZswapOffer.fromInput(neighbour)),
    'spending one coin does not retire another coin of the same colour');
});

test('contract-filtered state cannot establish unspentness, even after registering its root locally', () => {
  const f = nativeFixture();
  const [spent] = f.state.tryApply(ZswapOffer.fromInput(f.input));
  const filtered = spent.filter(f.address);
  const candidate = ZswapInput.newContractOwned(f.qualified, 0, f.address, filtered);
  assert.throws(() => filtered.tryApply(ZswapOffer.fromInput(candidate)), /unknown coin tree root/);
  const registered = filtered.postBlockUpdate(new Date('2026-11-11T00:00:01Z'), 600n);
  const rebuilt = ZswapInput.newContractOwned(f.qualified, 0, f.address, registered);
  assert.doesNotThrow(() => registered.tryApply(ZswapOffer.fromInput(rebuilt)),
    'filtering discarded the spent nullifier, so this acceptance is not authoritative');
  assert.throws(() => spent.tryApply(ZswapOffer.fromInput(f.input)), /double-spend attempt/);
});

test('local unproven application does not qualify an occupied commitment position', () => {
  const f = nativeFixture();
  assert.notEqual(f.qualified.mt_index, f.siblingQualified.mt_index);
  const wrong = ZswapInput.newContractOwned({ ...f.qualified, mt_index: f.siblingQualified.mt_index }, 0, f.address, f.state);
  assert.equal(wrong.nullifier, f.input.nullifier, 'position is not the coin identity');
  assert.doesNotThrow(() => f.state.tryApply(ZswapOffer.fromInput(wrong)),
    'unproven local application checks ledger predicates, not witness constraints');
});

test('native nullifiers are bound to the owning contract', () => {
  const f = nativeFixture();
  const otherAddress = 'ff'.repeat(32);
  assert.notEqual(otherAddress, f.address);
  const wrongOwner = ZswapInput.newContractOwned(f.qualified, 0, otherAddress, f.state);
  assert.notEqual(wrongOwner.nullifier, f.input.nullifier);
});
