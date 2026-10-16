// Characterize the installed SDK, without a browser wallet or live chain.
// Funding is synthetic local Merkle-tree state; no real funds are used.
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as ledger from '@midnightntwrk/ledger-v9';
import {
  MidnightBech32m, ShieldedAddress, ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey, ShieldedEncryptionSecretKey,
} from '@midnightntwrk/wallet-sdk-address-format';
import { CoreWallet, Transacting, Keys, CoinsAndBalances } from '@midnightntwrk/wallet-sdk-shielded/v2';
import { chooseCoin } from '@midnightntwrk/wallet-sdk-capabilities';
import { Either } from 'effect';

const network = 'undeployed';
const identity = '01' + '00'.repeat(31);
const zeroSecret = ledger.EncryptionSecretKey.deserialize(new Uint8Array([0]));
const sender = ledger.ZswapSecretKeys.fromSeed(new Uint8Array(32).fill(73));
const recipient = ledger.ZswapSecretKeys.fromSeed(new Uint8Array(32).fill(74));
const type = 'ab'.repeat(32);
const rows: { boundary: string; input: string; expectedAccepted: boolean; accepted: boolean; error?: string }[] = [];
function check(boundary: string, input: string, expected: boolean, action: () => unknown, errorPattern?: RegExp) {
  let error: string | undefined;
  try { action(); } catch (e) {
    error = String(e);
    if (e && typeof e === 'object' && 'cause' in e) error += `: ${String(e.cause)}`;
  }
  const accepted = error === undefined;
  rows.push({ boundary, input, expectedAccepted: expected, accepted, ...(error ? { error } : {}) });
  assert.equal(accepted, expected, `${boundary}: ${input}: ${error ?? 'accepted'}`);
  if (errorPattern) assert.match(error!, errorPattern);
  console.log(`PASS ${boundary}: ${input}: ${accepted ? 'accepted' : 'rejected'}`);
}
function address(epk: string) {
  return new ShieldedAddress(
    ShieldedCoinPublicKey.fromHexString(recipient.coinPublicKey),
    ShieldedEncryptionPublicKey.fromHexString(epk),
  );
}
function roundTrip(epk: string) {
  const encoded = MidnightBech32m.encode(network, address(epk)).asString();
  const decoded = MidnightBech32m.parse(encoded).decode(ShieldedAddress, network);
  assert.equal(decoded.encryptionPublicKey.toHexString(), epk);
  return decoded;
}

// Order-two and mixed-torsion points are valid full-curve encodings but are
// outside the prime-order subgroup. For twisted Edwards, P+(0,-1)=(-x,-y).
const modulus = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n;
const le = (x: bigint) => Buffer.from(x.toString(16).padStart(64, '0'), 'hex').reverse().toString('hex');
const base = Buffer.from(recipient.encryptionPublicKey, 'hex');
const sign = base[31] & 128;
base[31] &= 127;
const y = BigInt('0x' + Buffer.from(base).reverse().toString('hex'));
const mixed = Buffer.from(le(modulus - y), 'hex');
mixed[31] |= sign ^ 128;
const vectors = [
  ['normal', recipient.encryptionPublicKey, true],
  ['identity', identity, true],
  ['order-two', le(modulus - 1n), false],
  ['mixed-torsion', mixed.toString('hex'), false],
  ['invalid-group-zero', '00'.repeat(32), false],
  ['noncanonical-field', 'ff'.repeat(32), false],
  ['empty', '', false],
  ['31-bytes', '01'.repeat(31), false],
  ['33-bytes', '01'.repeat(33), false],
] as const;

for (const [name, epk] of vectors) {
  check('address encode/parse/decode', name, true, () => roundTrip(epk));
}
check('address network control', 'wrong-network', false, () =>
  MidnightBech32m.parse(MidnightBech32m.encode(network, address(identity)).asString())
    .decode(ShieldedAddress, 'preview'));
check('address checksum control', 'damaged-checksum', false, () => {
  const encoded = MidnightBech32m.encode(network, address(identity)).asString();
  MidnightBech32m.parse(encoded.slice(0, -1) + (encoded.endsWith('q') ? 'p' : 'q'));
});
check('wallet secret-key codec', 'zero-secret import', true, () => {
  const encoded = ShieldedEncryptionSecretKey.codec.encode(network, new ShieldedEncryptionSecretKey(zeroSecret));
  const decoded = ShieldedEncryptionSecretKey.codec.decode(network, MidnightBech32m.parse(encoded.asString()));
  assert.deepEqual(decoded.zswap.yesIKnowTheSecurityImplicationsOfThis_serialize(), new Uint8Array([0]));
});

const context = {
  coinSelection: chooseCoin,
  keysCapability: Keys.makeDefaultKeysCapability(),
  coinsAndBalancesCapability: CoinsAndBalances.makeDefaultCoinsAndBalancesCapability(),
};
const transacting = Transacting.makeDefaultTransactingCapability({ networkId: network }, () => context);
let identityTransaction: ledger.UnprovenTransaction | undefined;
const constructed: { name: string; tx: ledger.UnprovenTransaction; chain: ledger.ZswapChainState }[] = [];
for (const [name, epk, expected] of vectors) {
  check('wallet makeTransfer', name, expected, () => {
    const funding = ledger.createShieldedCoinInfo(type, 100n);
    const local = new ledger.ZswapLocalState().insertCoin(sender, funding);
    const state = CoreWallet.init(local, sender, network);
    const result = transacting.makeTransfer(sender, state, [
      { amount: 42n, type, receiverAddress: roundTrip(epk) },
    ]);
    if (Either.isLeft(result)) throw result.left;
    // Negative cases must fail in the SDK, not in a later harness assertion.
    if (!expected) return;
    const [tx] = result.right;
    assert.equal(tx.guaranteedOffer!.inputs.length, 1);
    assert.equal(tx.guaranteedOffer!.outputs.length, 2); // recipient plus change
    assert.equal(tx.imbalances(0).size, 0);
    const fundingOutput = ledger.ZswapOutput.new(funding, 0, sender.coinPublicKey, sender.encryptionPublicKey);
    const [chain] = new ledger.ZswapChainState().tryApply(ledger.ZswapOffer.fromOutput(fundingOutput));
    constructed.push({ name, tx, chain: chain.postBlockUpdate(new Date('2026-10-15T12:00:00Z'), 600n) });
    if (name === 'identity') identityTransaction = tx;
    assert.equal(zeroSecret.test(tx.guaranteedOffer!), name === 'identity');
  });
}
check('wallet identity transaction serialization', 'unproven round-trip retains zero-secret detection', true, () => {
  assert(identityTransaction);
  const restored = ledger.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', identityTransaction.serialize());
  assert(zeroSecret.test(restored.guaranteedOffer!));
});

// Exercise ledger validation/application, explicitly with native proofs and
// fee balancing disabled. This is NOT node/mempool or proof acceptance.
const timestamp = new Date('2026-10-15T12:00:00Z');
for (const { name, tx, chain } of constructed) {
  check('local ledger (proofs/fees disabled)', name, true, () => {
    const state = new ledger.LedgerState(network, chain);
    const strictness = new ledger.WellFormedStrictness();
    strictness.enforceBalancing = false;
    strictness.verifyNativeProofs = false;
    strictness.verifyContractProofs = false;
    strictness.enforceLimits = true;
    strictness.verifySignatures = true;
    const erased = tx.eraseProofs();
    const restored = ledger.Transaction.deserialize('signature', 'no-proof', 'no-binding', erased.serialize());
    assert.equal(zeroSecret.test(restored.guaranteedOffer!), name === 'identity');
    const verified = restored.wellFormed(state, strictness, timestamp);
    const seconds = BigInt(timestamp.getTime() / 1000);
    const [next, result] = state.apply(verified, new ledger.TransactionContext(state, {
      secondsSinceEpoch: seconds, secondsSinceEpochErr: 0,
      parentBlockHash: '00'.repeat(32), lastBlockTime: seconds - 6n,
    }));
    assert.equal(result.type, 'success', result.error);
    assert.equal(next.zswap.firstFree, 3n, result.toString()); // funding, recipient, change
    assert(result.events.length > 0);
  });
  check('local ledger native-proof control', `${name}: mock proof`, false, () => {
    const strictness = new ledger.WellFormedStrictness();
    strictness.enforceBalancing = false;
    strictness.verifyNativeProofs = true;
    strictness.verifyContractProofs = true;
    strictness.enforceLimits = true;
    strictness.verifySignatures = true;
    tx.mockProve().bind().wellFormed(new ledger.LedgerState(network, chain), strictness, timestamp);
  }, /Invalid proof -- while verifying Zswap proof/);
}

const evidence = new URL('../../evidence/ecc-validation/', import.meta.url);
mkdirSync(evidence, { recursive: true });
const sha256 = (path: URL) => createHash('sha256').update(readFileSync(path)).digest('hex');
writeFileSync(new URL('wallet.json', evidence), JSON.stringify({
  completed: true, runAt: new Date().toISOString(), node: process.version,
  scope: 'Installed SDK address codec, default v9 transfer capability and local ledger validation/application with proofs and fee balancing disabled; synthetic funding; no browser UI or node submission',
  lockfileSha256: sha256(new URL('../../package-lock.json', import.meta.url)),
  testSha256: sha256(new URL(import.meta.url)),
  versions: { ledger: '1.0.0-rc.5', shieldedWallet: '4.0.0-rc.0', addressFormat: '4.0.0-rc.0' },
  recipientVectors: vectors.map(([input, encryptionPublicKey, transferAccepted]) => ({ input, encryptionPublicKey, transferAccepted })),
  rows,
}, null, 2) + '\n');
console.log(`Wallet checks complete: ${rows.length}/${rows.length} expectations matched.`);
