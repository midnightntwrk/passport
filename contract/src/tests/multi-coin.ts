// Local multi-coin storage and signing/witness boundary regressions.
// Transport fixtures exercise real signers and witnesses, but do not prove
// transactions or establish node acceptance. The runtime control below checks
// refusal of a signature bound to a different qualified coin.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCircuitContext } from '@midnight-ntwrk/compact-runtime';
import { CustodyAccount } from '../wallet/account.js';
import {
  coinId, coinsForColour, emptyCoinStore, makeWitnesses, migrateCoinStore,
  selectCoin, withCoin, withoutCoin, withSelectedCoin,
  type CoinStorePrivateState,
} from '../wallet/witnesses.js';
import {
  JubjubDevice, K256Device, JubjubGrantee, K256Grantee,
  jubjubChallenges, k256Challenges, p256Challenges,
  jubjubGrantChallenges, k256GrantChallenges, p256GrantChallenges,
  authArgs, openingOf, spendScope, JUBJUB_R, bytesToBigIntLE,
} from '../wallet/signer.js';
import type { QualifiedCoin } from '../wallet/contract.js';
import { bytesToHex } from '../wallet/hex.js';
import { inboxWalk } from '../wallet/discovery.js';
import { generateEncKeyPair, sealInboxEntry } from '../wallet/inbox.js';
import { softwarePasskey } from './p256-fixtures.js';
import { AccountSim } from './sim.js';

const b = (n: number) => new Uint8Array(32).fill(n);
const colour = b(4), recipient = b(8), address = b(7), enc = b(9);
const entry = new Uint8Array(192);
const copy = <T>(value: T): T => structuredClone(value);
const jsonCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const coin = (n: number, value = 10n, color = colour, mtIndex = BigInt(n)) =>
  ({ nonce: b(n), color, value, mtIndex });
const qualified = (value: ReturnType<typeof coin>): QualifiedCoin =>
  ({ nonce: value.nonce, color: value.color, value: value.value, mt_index: value.mtIndex });
const stored = (value: ReturnType<typeof coin>) => ({ nonceHex: bytesToHex(value.nonce),
  colorHex: bytesToHex(value.color), value: String(value.value), mtIndex: String(value.mtIndex) });
const liveIds = (state: CoinStorePrivateState, color = colour) => coinsForColour(state, color).map(coinId).sort();
const twoCoins = () => withCoin(withCoin(emptyCoinStore(b(42)), coin(1)), coin(2, 20n));

test('independent same-colour deposits remain distinct, including equal-value coins', () => {
  const a = coin(1), c = coin(3), other = coin(1, 10n, b(5));
  const state = withCoin(withCoin(withCoin(emptyCoinStore(), a), c), other);
  assert.deepEqual(liveIds(state), [coinId(a), coinId(c)].sort());
  assert.deepEqual(liveIds(state, b(5)), [coinId(other)]);
  assert.throws(() => selectCoin(state, colour), /ambiguous|multiple|more than one/i);
  assert.deepEqual(selectCoin(state, colour, coinId(a)), qualified(a));
  assert.deepEqual(selectCoin(state, colour, coinId(c)), qualified(c));
});

test('identity excludes the candidate index, while different coin descriptions stay distinct', () => {
  const a = coin(1), candidate = { ...a, mtIndex: 123n };
  assert.equal(coinId(a), coinId(candidate));
  assert.notEqual(coinId(a), coinId({ ...a, value: 11n }));
  assert.notEqual(coinId(a), coinId({ ...a, color: b(5) }));
  const state = withCoin(withCoin(twoCoins(), a), candidate);
  assert.equal(coinsForColour(state, colour).length, 2);
  assert.equal(selectCoin(state, colour, coinId(a)).mt_index, 123n);
});

test('exact removal preserves neighbouring coins and a replay cannot revive a spent identity', () => {
  const a = coin(1), other = coin(2, 20n);
  const removed = withoutCoin(twoCoins(), a);
  assert.deepEqual(liveIds(removed), [coinId(other)]);
  assert.throws(() => selectCoin(removed, colour, coinId(a)), /spent|not found|no .*coin/i);
  const replay = withCoin(removed, { ...a, mtIndex: 999n });
  assert.deepEqual(liveIds(replay), [coinId(other)]);
  assert.deepEqual(liveIds(withoutCoin(replay, coinId(other))), []);
});

test('legacy migration preserves every surviving description, viewing key, and input object', () => {
  const a = coin(1), other = coin(2, 20n, b(5));
  const legacy = { encSecretKeyHex: bytesToHex(b(42)), coins: {
    [bytesToHex(a.color)]: stored(a), [bytesToHex(other.color)]: stored(other),
  } };
  const before = jsonCopy(legacy);
  const migrated = migrateCoinStore(legacy);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.encSecretKeyHex, legacy.encSecretKeyHex);
  assert.deepEqual(selectCoin(migrated, a.color), qualified(a));
  assert.deepEqual(selectCoin(migrated, other.color), qualified(other));
  assert.deepEqual(legacy, before);
  assert.deepEqual(migrateCoinStore(migrated), migrated);
});

test('JSON persistence preserves same-colour inventory and spent state through restart', () => {
  const a = coin(1), other = coin(2, 20n);
  const restored = migrateCoinStore(jsonCopy(withoutCoin(twoCoins(), a)));
  assert.deepEqual(selectCoin(restored, colour), qualified(other));
  assert.deepEqual(liveIds(withCoin(restored, a)), [coinId(other)]);
  assert.equal(restored.encSecretKeyHex, bytesToHex(b(42)));
});

test('migration refuses malformed retained descriptions instead of silently discarding holdings', () => {
  const legacy = { encSecretKeyHex: null, coins: { [bytesToHex(colour)]: stored(coin(1)) } };
  for (const fault of [
    { ...stored(coin(1)), value: '-1' },
    { ...stored(coin(1)), value: String(1n << 128n) },
    { ...stored(coin(1)), mtIndex: String(1n << 64n) },
    { ...stored(coin(1)), nonceHex: '01' },
  ]) assert.throws(() => migrateCoinStore({ ...legacy, coins: { [bytesToHex(colour)]: fault } }), /invalid|range/i);
  assert.throws(() => migrateCoinStore({ ...legacy, version: 99 } as any), /version/i);
});

test('spent identities must be canonical and take precedence over stale live records', () => {
  const a = coin(1), state = withCoin(emptyCoinStore(), a);
  for (const suffix of ['010', '-1', String(1n << 128n)]) {
    const id = `${bytesToHex(a.nonce)}:${bytesToHex(a.color)}:${suffix}`;
    assert.throws(() => migrateCoinStore({ ...state, spentCoins: { [id]: true } }), /invalid.*identity/i);
  }
  const recovered = migrateCoinStore({ ...state, spentCoins: { [coinId(a)]: true } });
  assert.deepEqual(liveIds(recovered), []);
  assert.deepEqual(liveIds(withCoin(recovered, a)), []);
});

test('coin selection and pinning detach their snapshots from caller-owned arrays', () => {
  const state = twoCoins(), selected = selectCoin(state, colour, coinId(coin(1)));
  const pinned = withSelectedCoin(state, selected);
  selected.nonce.fill(99); selected.color.fill(99); selected.mt_index = 999n;
  const [, witnessed] = makeWitnesses().held_coin({ privateState: pinned } as any, colour);
  assert.deepEqual(witnessed, qualified(coin(1)));
  assert.deepEqual(selectCoin(state, colour, coinId(coin(1))), qualified(coin(1)));
});

test('recovery inbox deduplicates descriptions without combining same-colour holdings', () => {
  const keys = generateEncKeyPair(), a = coin(1), other = coin(2, 20n);
  const entries = [sealInboxEntry(keys.publicKey, a), sealInboxEntry(keys.publicKey, other),
    sealInboxEntry(keys.publicKey, a), new Uint8Array(192)];
  const ledger = { inbox_count: BigInt(entries.length), inbox: {
    member: (n: bigint) => n < BigInt(entries.length), lookup: (n: bigint) => entries[Number(n)],
  } } as any;
  const recovered = inboxWalk(ledger, keys.secretKey);
  assert.deepEqual(recovered.map(coinId).sort(), [coinId(a), coinId(other)].sort());
  let state = withoutCoin(twoCoins(), a);
  for (const found of recovered) state = withCoin(state, { ...found, mtIndex: 77n });
  assert.deepEqual(liveIds(state), [coinId(other)], 'local spent tombstone survives replayed descriptions');
  // Inbox decryption/deduplication does not prove chain membership or unspentness.
});

test('witness consumes only the pinned coin and leaves the caller snapshot unchanged', () => {
  const a = coin(1), other = coin(2, 20n);
  const before = twoCoins(), pinned = withSelectedCoin(before, qualified(a));
  const [after, witnessed] = makeWitnesses().held_coin({ privateState: pinned } as any, colour);
  assert.deepEqual(witnessed, qualified(a));
  assert.deepEqual(liveIds(after), [coinId(other)]);
  assert.deepEqual(liveIds(before), [coinId(a), coinId(other)].sort());
  assert.deepEqual(liveIds(withCoin(after, a)), [coinId(other)]);
});

test('witness refuses an ambiguous store and a selected description changed after pinning', () => {
  assert.throws(() => makeWitnesses().held_coin({ privateState: twoCoins() } as any, colour), /ambiguous|multiple|selection|selected/i);
  const pinned = withSelectedCoin(twoCoins(), qualified(coin(1)));
  const changed = jsonCopy(pinned);
  changed.coins[coinId(coin(1))].mtIndex = '99';
  assert.throws(() => makeWitnesses().held_coin({ privateState: changed } as any, colour), /changed|stale|match|selected/i);
});

type Profile = 'jubjub' | 'k256' | 'connector' | 'p256';
type Mode = 'owner' | 'grant';
type Twin = 'user' | 'contract';

function fixture(mode: Mode = 'owner', profile: Profile = 'jubjub', twin: Twin = 'user') {
  const signer: any = mode === 'owner'
    ? profile === 'jubjub' ? new JubjubDevice(31n) : profile === 'p256' ? softwarePasskey().device
      : new K256Device(32n, profile === 'connector' ? 1n : 0n)
    : profile === 'jubjub' ? new JubjubGrantee(33n) : profile === 'p256' ? softwarePasskey().grantee
      : new K256Grantee(34n);
  let state: CoinStorePrivateState = twoCoins();
  const observations = { signs: 0, calls: 0, expiresAt: 0n, fail: false, failureMessage: 'deliberate transport refusal', witnessed: [] as QualifiedCoin[],
    challenge: undefined as Uint8Array | undefined, auth: undefined as any,
    onSign: undefined as undefined | (() => void | Promise<void>),
    onDispatch: undefined as undefined | (() => void),
  };
  const provider = { get: async () => jsonCopy(state), set: async (_id: string, value: CoinStorePrivateState) => { state = jsonCopy(value); } };
  const callTx = new Proxy({}, { get: (_, name: string) => async () => {
    observations.calls++;
    observations.onDispatch?.();
    const [next, held] = makeWitnesses().held_coin({ privateState: state } as any, colour);
    observations.witnessed.push(copy(held));
    if (observations.fail) throw new Error(observations.failureMessage);
    state = next;
    const sent = { nonce: held.nonce, color: held.color, value: 1n };
    const none = { is_some: false, value: sent };
    return { public: { txId: name }, private: { result: twin === 'contract' ? [sent, none] : none } };
  } });
  const providers = { privateStateProvider: provider };
  const client = () => {
    const account = Reflect.construct(CustodyAccount, [bytesToHex(address), address, { ...providers }, 'multi-coin', { callTx }]) as CustodyAccount;
    account.ledgerState = async () => ({ spec_version: 3n, auth_nonce: 0n, device_epoch: 0n,
      grant_generation: 0n, enc_key: enc, devices: { member: () => true },
      grants: { member: () => true, lookup: () => ({ active: true, epoch: 0n, gen: 0n,
        issued_at: 4n, nonce: 5n, scope: { expires_at: observations.expiresAt } }) },
    }) as any;
    return account;
  };
  const account = client();
  const scope = spendScope({ withdrawShielded: twin === 'user', withdrawShieldedToContract: twin === 'contract',
    color: colour, cap: 100n, expiresAt: 0n, readPkHash: b(13) });
  const opening = openingOf(scope, b(11), b(12), 0n);
  const context = { contractAddress: address, authNonce: 0n };
  const grantContext = { contractAddress: address, grantId: signer.arm && mode === 'grant'
    ? signer.grantId(address, opening.originHash, opening.slot) : b(0), issuedAt: 4n, grantNonce: 5n };
  const builderFor = (selected: QualifiedCoin, amount = 1n) => {
    const name = twin === 'user' ? 'withdrawShielded' : 'withdrawShieldedToContract';
    const builders: any = mode === 'owner'
      ? signer.arm === 'jubjub' ? jubjubChallenges : signer.arm === 'k256' ? k256Challenges : p256Challenges
      : signer.arm === 'jubjub' ? jubjubGrantChallenges : signer.arm === 'k256' ? k256GrantChallenges : p256GrantChallenges;
    return mode === 'owner'
      ? builders[name](context, signer.pk, recipient, colour, amount, selected)
      : builders[name](grantContext, signer.pk, recipient, colour, amount, entry, enc, selected);
  };
  const originalSign = signer.sign.bind(signer);
  signer.sign = (builder: any, counter?: bigint) => {
    observations.signs++;
    const finish = (auth: any) => {
      observations.auth = auth;
      observations.challenge = typeof builder === 'function' ? builder(auth.sig_r, auth.grind_nonce) : new Uint8Array(builder);
      return auth;
    };
    const auth = originalSign(builder, counter);
    if (auth instanceof Promise) return auth.then(async (a: any) => { finish(a); await observations.onSign?.(); return a; });
    finish(auth); observations.onSign?.(); return auth;
  };
  const invoke = (id: string | undefined = coinId(coin(1)), amount = 1n, raw = false, omitSelection = false) => {
    if (omitSelection) id = undefined;
    const method = twin === 'user' ? 'withdrawShielded' : 'withdrawShieldedToContract';
    if (raw) {
      const selected = id === undefined ? undefined : selectCoin(state, colour, id);
      const auth = signer.sign(builderFor(selected ?? qualified(coin(1)), amount), 0n);
      return Promise.resolve(auth).then(a => mode === 'owner'
        ? (account as any)[`${method}WithAuth`](recipient, colour, amount, a, selected)
        : (account as any)[`${method}WithGrantAuth`](recipient, colour, amount, entry, enc, opening, a, selected));
    }
    if (mode === 'owner') return twin === 'user'
      ? account.withdrawShielded(signer, recipient, colour, amount, id)
      : account.withdrawShieldedToContract(signer, recipient, colour, amount, id);
    return twin === 'user'
      ? account.withdrawShieldedWithGrant(signer, opening, recipient, colour, amount, entry, undefined, { coinId: id })
      : account.withdrawShieldedToContractWithGrant(signer, opening, recipient, colour, amount, entry, undefined, { coinId: id });
  };
  const assertSigned = (expected: QualifiedCoin, amount = 1n) => {
    const builder = builderFor(expected, amount), a = observations.auth;
    assert.deepEqual(observations.challenge, typeof builder === 'function' ? builder(a.sig_r, a.grind_nonce) : builder);
    assert.deepEqual(observations.witnessed, [expected], 'witness uses exactly the signed qualified coin');
  };
  return { account, client, signer, opening, observations, invoke, assertSigned,
    state: () => jsonCopy(state), replace: (next: CoinStorePrivateState) => { state = jsonCopy(next); } };
}

for (const mode of ['owner', 'grant'] as const) {
  const profiles: Profile[] = mode === 'owner' ? ['jubjub', 'k256', 'connector', 'p256'] : ['jubjub', 'k256', 'p256'];
  for (const profile of profiles) for (const twin of ['user', 'contract'] as const) {
    test(`${mode} ${profile} ${twin}: explicit selection signs and consumes either same-colour coin`, async () => {
      for (const selected of [coin(1), coin(2, 20n)]) {
        const f = fixture(mode, profile, twin);
        await f.invoke(coinId(selected));
        f.assertSigned(qualified(selected));
        assert.equal(f.observations.signs, 1); assert.equal(f.observations.calls, 1);
        assert.deepEqual(liveIds(f.state()), [coinId(selected.nonce[0] === 1 ? coin(2, 20n) : coin(1))]);
      }
    });
  }
}

for (const twin of ['user', 'contract'] as const) {
  test(`finite grant ${twin}: selecting a coin still requires complete timing before signing`, async () => {
    const f = fixture('grant', 'p256', twin); f.observations.expiresAt = 2000n;
    await assert.rejects(() => f.invoke(), (error: any) => error.code === 'timing_required');
    assert.equal(f.observations.signs, 0); assert.equal(f.observations.calls, 0);
    assert.equal(liveIds(f.state()).length, 2);
    const options = { coinId: coinId(coin(2, 20n)), nowSeconds: () => 1000n,
      readNodeHeadTimeSeconds: async () => 1000n, admissionMarginSeconds: 10n, proveAndBalanceSeconds: 15n };
    if (twin === 'user') await f.account.withdrawShieldedWithGrant(f.signer, f.opening,
      recipient, colour, 1n, entry, undefined, options);
    else await f.account.withdrawShieldedToContractWithGrant(f.signer, f.opening,
      recipient, colour, 1n, entry, undefined, options);
    f.assertSigned(qualified(coin(2, 20n)));
    assert.equal(f.observations.signs, 1); assert.equal(f.observations.calls, 1);
    assert.deepEqual(liveIds(f.state()), [coinId(coin(1))]);
  });
}

for (const mode of ['owner', 'grant'] as const) for (const twin of ['user', 'contract'] as const) {
  test(`${mode} ${twin}: ambiguity and insufficient selected value never reach signing`, async () => {
    const f = fixture(mode, 'p256', twin);
    await assert.rejects(() => f.invoke(undefined, 1n, false, true), /ambiguous|multiple|coin|identity/i);
    await assert.rejects(() => f.invoke('missing-coin-id'), /coin|identity/i);
    await assert.rejects(() => f.invoke(coinId(coin(1)), 11n), /insufficient|amount|value/i);
    assert.equal(f.observations.signs, 0); assert.equal(f.observations.calls, 0);
    assert.equal(liveIds(f.state()).length, 2);
  });

  test(`${mode} ${twin}: failed submission retains the exact selected coin and its neighbour`, async () => {
    const f = fixture(mode, 'jubjub', twin); f.observations.fail = true;
    await assert.rejects(() => f.invoke(), /deliberate transport refusal/);
    assert.equal(f.observations.calls, 1);
    assert.deepEqual(liveIds(f.state()), [coinId(coin(1)), coinId(coin(2, 20n))].sort());
    f.observations.fail = false; f.observations.witnessed.length = 0;
    await f.invoke(); f.assertSigned(qualified(coin(1)));
  });

  test(`${mode} ${twin}: pre-signed raw calls bind the explicit coin and preserve neighbours`, async () => {
    for (const profile of ['jubjub', 'k256', 'p256'] as const) {
      const f = fixture(mode, profile, twin);
      await f.invoke(coinId(coin(2, 20n)), 1n, true);
      f.assertSigned(qualified(coin(2, 20n)));
      assert.deepEqual(liveIds(f.state()), [coinId(coin(1))]);
    }
  });

  test(`${mode} ${twin}: a unique coin still works without an explicit identity`, async () => {
    for (const raw of [false, true]) {
      const f = fixture(mode, 'jubjub', twin);
      f.replace(withCoin(emptyCoinStore(), coin(1)));
      await f.invoke(undefined, 1n, raw, true);
      f.assertSigned(qualified(coin(1)));
      assert.deepEqual(liveIds(f.state()), []);
    }
  });
}

test('a competing account cannot replace the selected candidate while a signer is awaiting approval', async () => {
  const f = fixture('owner', 'p256');
  const peer = f.client();
  f.observations.onSign = async () => {
    await assert.rejects(() => peer.putCoin(coin(1, 10n, colour, 99n)), /busy|progress|concurrent|active|locked/i);
    await assert.rejects(() => peer.dropCoin(coin(2, 20n)), /busy|progress|concurrent|active|locked/i);
    await assert.rejects(() => peer.depositUnshielded(colour, 1n), /busy|progress|concurrent|active|locked/i);
    await assert.rejects(() => peer.callTx.rotate_enc_key_with_p256(enc, {}), /busy|progress|concurrent|active|locked/i);
  };
  await f.invoke(); f.assertSigned(qualified(coin(1)));
});

test('overlapping writes from two accounts fail explicitly and can be retried without losing deposits', async () => {
  const f = fixture(), peer = f.client();
  const result = await Promise.allSettled([f.account.putCoin(coin(3, 30n)), peer.putCoin(coin(4, 40n))]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  const failed = result.findIndex(r => r.status === 'rejected');
  assert.match(String((result[failed] as PromiseRejectedResult).reason), /busy|progress|concurrent|active|locked/i);
  await (failed === 0 ? f.account.putCoin(coin(3, 30n)) : peer.putCoin(coin(4, 40n)));
  assert.deepEqual(liveIds(f.state()), [coin(1), coin(2, 20n), coin(3, 30n), coin(4, 40n)].map(coinId).sort());
});

test('restart discards an abandoned pin and allows an explicitly selected neighbour', async () => {
  const f = fixture();
  f.replace(jsonCopy(withSelectedCoin(twoCoins(), qualified(coin(1)))));
  assert.equal((await f.client().coinStore()).selectedCoin, undefined);
  await f.invoke(coinId(coin(2, 20n)));
  f.assertSigned(qualified(coin(2, 20n)));
  assert.deepEqual(liveIds(f.state()), [coinId(coin(1))]);
});

test('dust rebuild retries retain the exact signed input and reject candidate changes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const paths = [{ mode: 'owner', raw: false }, { mode: 'owner', raw: true }, { mode: 'grant', raw: true }] as const;
  for (const path of paths) for (const mutate of [false, true]) {
    const f = fixture(path.mode); f.observations.fail = true; f.observations.failureMessage = 'DustDoubleSpend';
    f.observations.onDispatch = () => { if (f.observations.calls === 2) f.observations.fail = false; };
    const pending = f.invoke(undefined, 1n, path.raw);
    // Let the first dispatch reject and install its retry timer.
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.observations.calls, 1);
    assert.equal(liveIds(f.state()).length, 2, 'a rejected first attempt did not consume either coin');
    if (mutate) {
      const changed = f.state(); changed.coins[coinId(coin(1))].mtIndex = '99'; f.replace(changed);
      const rejected = assert.rejects(pending, /changed|stale|selected/i);
      t.mock.timers.tick(10_000); await rejected;
      assert.equal(f.observations.calls, 1, 'the changed candidate never reaches a second submission');
      assert.equal(liveIds(f.state()).length, 2);
    } else {
      t.mock.timers.tick(10_000); await pending;
      assert.equal(f.observations.signs, 1); assert.equal(f.observations.calls, 2);
      assert.deepEqual(f.observations.witnessed, [qualified(coin(1)), qualified(coin(1))]);
      assert.deepEqual(liveIds(f.state()), [coinId(coin(2, 20n))]);
    }
  }
});

for (const mode of ['owner', 'grant'] as const) {
  test(`${mode}: direct provider mutation during signing refuses dispatch without substituting a coin`, async () => {
    const f = fixture(mode, 'p256');
    f.observations.onSign = () => {
      const changed = f.state(); changed.coins[coinId(coin(1))].mtIndex = '99'; f.replace(changed);
    };
    await assert.rejects(() => f.invoke(), /changed|stale|match|selected/i);
    assert.equal(f.observations.signs, 1); assert.equal(f.observations.calls, 0);
    assert.equal(liveIds(f.state()).length, 2);
  });

  test(`${mode}: mutation after dispatch is refused by the witness without persisting consumption`, async () => {
    const f = fixture(mode, 'p256');
    f.observations.onDispatch = () => {
      const changed = f.state(); changed.coins[coinId(coin(1))].mtIndex = '99'; f.replace(changed);
    };
    await assert.rejects(() => f.invoke(), /changed|stale|match|selected/i);
    assert.equal(f.observations.signs, 1); assert.equal(f.observations.calls, 1);
    assert.deepEqual(liveIds(f.state()), [coinId(coin(1)), coinId(coin(2, 20n))].sort());
  });
}

test('an out-of-band same-colour arrival cannot silently replace a signed selection', async () => {
  const f = fixture('owner', 'p256');
  f.observations.onSign = () => f.replace(withCoin(f.state(), coin(3, 30n)));
  await assert.rejects(() => f.invoke(), /changed|stale|match|selected|selection|pin/i);
  assert.equal(f.observations.calls, 0);
  assert.deepEqual(liveIds(f.state()), [coinId(coin(1)), coinId(coin(2, 20n)), coinId(coin(3, 30n))].sort());
});

for (const twin of ['user', 'contract'] as const) {
  test(`generated runtime ${twin}: deposits and spends two same-colour coin fixtures individually`, async () => {
    const sim = await AccountSim.create({ initialRecoveryPk: new JubjubDevice(50n).pk,
      initialWrap: new Uint8Array(64), vetoWindowSeconds: 1n });
    const deposits = [coin(1), coin(2, 20n)];
    for (const held of deposits) {
      await sim.call('deposit_shielded', held, entry);
      // Local qualified fixtures stand in for index capture. Runtime execution
      // records Zswap inputs/outputs; it does not verify their chain membership.
      sim.privateState = withCoin(sim.privateState, held);
    }
    assert.equal(sim.ledger().inbox_count, 2n);
    assert.equal(liveIds(sim.privateState).length, 2);
    for (const [counter, held] of deposits.entries()) {
      const selected = qualified(held), id = coinId(held);
      sim.privateState = withSelectedCoin(jsonCopy(sim.privateState), selected);
      const method = twin === 'user' ? 'withdrawShielded' : 'withdrawShieldedToContract';
      const circuit = twin === 'user' ? 'withdraw_shielded_with_jubjub' : 'withdraw_shielded_to_contract_with_jubjub';
      const auth = sim.device.sign(jubjubChallenges[method](sim.callContext(), sim.device.pk,
        recipient, colour, held.value, selected), BigInt(counter));
      const context = createCircuitContext({ circuitId: circuit, contractAddress: sim.addressHex,
        coinPublicKeyOrZswapState: sim.coinPk, contractState: sim.state,
        privateState: sim.privateState, time: sim.now });
      const result = await sim.impure[circuit](context, { bytes: recipient }, colour, held.value, ...authArgs(auth));
      const next = result.context.callContext;
      assert.deepEqual(next.currentZswapLocalState.inputs, [selected]);
      assert.equal(next.currentZswapLocalState.outputs.length, 1);
      assert.equal(next.currentZswapLocalState.outputs[0].coinInfo.value, held.value);
      sim.state = next.currentQueryContext.state;
      sim.privateState = next.currentPrivateState;
      assert.ok(sim.privateState.spentCoins?.[id]);
      assert.deepEqual(liveIds(sim.privateState), deposits.slice(counter + 1).map(coinId));
      assert.equal(sim.ledger().auth_nonce, BigInt(counter + 1));
    }
  });
}

test('generated runtime refuses authorisation signed over a different qualified coin', async t => {
  const sim = await AccountSim.create({ initialRecoveryPk: new JubjubDevice(51n).pk,
    initialWrap: new Uint8Array(64), vetoWindowSeconds: 1n });
  const signed = qualified(coin(1)), served = qualified(coin(2, 20n));
  const auth = sim.device.sign(jubjubChallenges.withdrawShielded(sim.callContext(), sim.device.pk,
    recipient, colour, 1n, signed), 0n);
  // Choose a differing candidate whose challenge is in range so refusal must
  // reach the signature equation, rather than the earlier hash-to-Field cast.
  let inRange = false;
  for (let i = 0n; i < 4096n; i++) {
    served.mt_index = i;
    const challenge = jubjubChallenges.withdrawShielded(sim.callContext(), sim.device.pk,
      recipient, colour, 1n, served)(auth.sig_r, auth.grind_nonce);
    if (bytesToBigIntLE(challenge) < JUBJUB_R) { inRange = true; break; }
  }
  assert.ok(inRange, 'bounded search found a canonical mismatched challenge');
  sim.privateState = withSelectedCoin(withCoin(twoCoins(), { ...coin(2, 20n), mtIndex: served.mt_index }), served);
  const before = copy(sim.privateState), nonce = sim.ledger().auth_nonce;
  await assert.rejects(() => sim.call('withdraw_shielded_with_jubjub', { bytes: recipient }, colour, 1n, ...authArgs(auth)), error => {
    const message = String(error);
    assert.match(message, /invalid signature/i);
    t.diagnostic(`Actual AUTH-10 refusal: ${message}`);
    return true;
  });
  assert.deepEqual(sim.privateState, before, 'rejected runtime call does not persist the consumed witness state');
  assert.equal(sim.ledger().auth_nonce, nonce);
});
