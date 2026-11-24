// Real generated state transitions; only indexer transport and persistence are
// mocked. History contains each action's state, as the SDK's `all` stream does.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { EMPTY, Observable, of, throwError } from 'rxjs';
import { CustodyAccount, BootstrapRecoveryReplacedError, type SignedBootstrapClientOptions } from '../wallet/account.js';
import { pureCircuits, ledger } from '../wallet/contract.js';
import { JubjubDevice, authArgs, jubjubChallenges } from '../wallet/signer.js';
import { p256Challenges } from '../wallet/signer-p256.js';
import { emptyCoinStore } from '../wallet/witnesses.js';
import {
  TemporaryBootstrapKey, createSignedBootstrapRecord, deriveBootstrapNetwork,
  retainBootstrapCredential, prepareSignedBootstrapActivation, signedBootstrapActivationArgs,
  serializeSignedBootstrapRecord, deserializeSignedBootstrapRecord,
} from '../wallet/signed-bootstrap.js';
import { AccountSim } from './sim.js';
import { softwarePasskey, TEST_RP, TEST_ORIGIN } from './p256-fixtures.js';

const bytes = (n = 32) => new Uint8Array(randomBytes(n));
async function fixture() {
  const passkey = softwarePasskey(), temporary = TemporaryBootstrapKey.generate(), recovery = JubjubDevice.generate();
  const config = { caip2Id: 'midnight:undeployed', genesisHash: bytes(), anchorHeight: 1n, anchorHash: bytes() };
  const network = deriveBootstrapNetwork(config);
  const boot = pureCircuits.derive_signed_boot_commitment(network, temporary.Q, passkey.policy);
  const sim = await AccountSim.createDormant({ bootstrapMode: 1n, bootstrapNetwork: network,
    initialRecoveryPk: recovery.pk, initialWrap: bytes(64), vetoWindowSeconds: 1n }, boot);
  const record = createSignedBootstrapRecord(network, sim.address, boot, temporary.Q, passkey.policy);
  retainBootstrapCredential(record, { credentialId: bytes(), pk: passkey.pk });
  const approval = await prepareSignedBootstrapActivation(record, temporary, passkey.assertion);
  const savedBeforeSubmission = serializeSignedBootstrapRecord(record);
  const history = [{ data: sim.state }];
  const call = async (name: string, ...args: unknown[]) => { await sim.call(name, ...args); history.push({ data: sim.state }); };
  const activate = () => call('activate_initial_passkey', ...signedBootstrapActivationArgs(approval));
  const activateDifferentTarget = async () => {
    const other = softwarePasskey();
    const alternative = createSignedBootstrapRecord(network, sim.address, boot, temporary.Q, passkey.policy);
    retainBootstrapCredential(alternative, { credentialId: bytes(), pk: other.pk });
    const competing = await prepareSignedBootstrapActivation(alternative, temporary, other.assertion);
    await call('activate_initial_passkey', ...signedBootstrapActivationArgs(competing)); return other;
  };
  let useCounter = 0n;
  const addDevice = async () => {
    const second = JubjubDevice.generate(), entry = second.entryAt(sim.address, 0n, 0n);
    const auth = await passkey.device.sign(p256Challenges.addDevice(sim.callContext(), passkey.pk, entry), useCounter++);
    await call('add_device_with_p256', entry, ...authArgs(auth)); return second;
  };
  const withdraw = async () => {
    const color = bytes(), recipient = bytes();
    await call('deposit_unshielded', color, 10n);
    const auth = await passkey.device.sign(p256Challenges.withdrawUnshielded(sim.callContext(), passkey.pk, color, 1n, recipient), useCounter++);
    await call('withdraw_unshielded_with_p256', color, 1n, { bytes: recipient }, ...authArgs(auth));
  };
  const recover = async () => {
    await sim.recoverSubmit(recovery, JubjubDevice.generate(), JubjubDevice.generate().pk, BigInt(sim.now));
    history.push({ data: sim.state }); sim.advanceTime(1); await call('recover_finalise');
  };
  const resume = (stream?: () => Observable<unknown>, persist?: SignedBootstrapClientOptions['persist'],
    assertionProvider?: SignedBootstrapClientOptions['assertionProvider'],
    submitActivation?: (...args: unknown[]) => Promise<unknown>) => {
    const record = deserializeSignedBootstrapRecord(savedBeforeSubmission);
    const seen = { histories: 0, registered: 0, persisted: 0, submitted: 0, erased: 0 };
    const providers = { publicDataProvider: {
      contractStateObservable: (address: string, config: unknown) => {
        assert.equal(address, sim.addressHex); assert.deepEqual(config, { type: 'all' }); seen.histories++;
        return stream ? stream() : of(...history);
      },
    }, privateStateProvider: { get: async () => emptyCoinStore(), set: async () => {} } };
    const account = Reflect.construct(CustodyAccount, [sim.addressHex, sim.address, providers, 'resume-test', {
      callTx: {
        activate_initial_passkey: (...args: unknown[]) => {
          seen.submitted++;
          if (submitActivation) return submitActivation(...args);
          throw new Error('must not resubmit activation');
        },
        rotate_enc_key_with_p256: async (...args: unknown[]) => {
          seen.submitted++; await call('rotate_enc_key_with_p256', ...args); return { public: { txId: 'simulated-rotation' } };
        },
      },
    }]) as CustodyAccount;
    account.ledgerState = async () => sim.ledger();
    const register = account.registerDevice.bind(account);
    account.registerDevice = (...args) => { seen.registered++; register(...args); };
    const options: SignedBootstrapClientOptions = { network: config, rpId: TEST_RP, origin: TEST_ORIGIN, assertionProvider,
      observeNetwork: async () => config, verifyDeployment: async () => {},
      eraseTemporaryKey: async () => { seen.erased++; },
      persist: async r => { seen.persisted++; await persist?.(r); } };
    return { record, seen, account, options, session: account.signedBootstrapSession(record, options) };
  };
  return { sim, passkey, temporary, history, call, activate, activateDifferentTarget, addDevice, withdraw, recover, resume };
}

for (const outcome of ['lost inclusion reply', 'relayer wins'] as const) {
  test(`activation completes after ${outcome} without a second submission`, async () => {
    const f = await fixture();
    const r = f.resume(undefined, undefined, f.passkey.assertion, async (...args) => {
      await f.activate();
      if (outcome === 'lost inclusion reply') throw new Error('SubmissionError: connection closed after inclusion');
      // The same approval was included between the initial check and our
      // build. The generated runtime rejects our duplicate as already booted.
      await f.call('activate_initial_passkey', ...args);
    });
    assert.equal(await r.session.activate(), r.account);
    assert.equal(r.seen.submitted, 1);
    assert.equal(r.record.retired, true);
    assert.equal(r.record.transactionId, undefined, 'a lost reply cannot supply a trustworthy transaction ID');
    assert.ok(r.session.device);
    const viewingKey = bytes();
    await r.account.rotateEncKey(r.session.device, viewingKey);
    assert.deepEqual(f.sim.ledger().enc_key, viewingKey);
  });
}

test('ambiguous activation completion still checks original installation after intervening use', async () => {
  const f = await fixture();
  const r = f.resume(undefined, undefined, f.passkey.assertion, async () => {
    await f.activate(); await f.withdraw(); throw new Error('SubmissionError: reply lost');
  });
  assert.equal(await r.session.activate(), r.account);
  assert.equal(r.seen.submitted, 1); assert.equal(r.seen.histories, 1);
  assert.equal(r.record.retired, true); assert.ok(r.session.device);
});

test('activation failure is preserved while the intended account remains dormant', async () => {
  const f = await fixture(), refusal = new Error('proof construction refused');
  const r = f.resume(undefined, undefined, undefined, async () => { throw refusal; });
  await assert.rejects(() => r.session.activate(), error => error === refusal);
  assert.equal(r.seen.submitted, 1); assert.equal(r.record.retired, undefined);
  assert.equal(r.session.device, undefined); assert.equal(f.sim.ledger().booted, false);
});

test('a failed activation cannot conceal a competing initial device', async () => {
  const f = await fixture();
  const r = f.resume(undefined, undefined, undefined, async () => {
    await f.activateDifferentTarget(); throw new Error('SubmissionError: reply lost');
  });
  await assert.rejects(() => r.session.activate(), /unexpected initial device/);
  assert.equal(r.seen.submitted, 1); assert.equal(r.seen.registered, 0);
  assert.equal(r.session.device, undefined);
});

test('a failed activation reports recovery replacement separately', async () => {
  const f = await fixture();
  const r = f.resume(undefined, undefined, undefined, async () => {
    await f.recover(); throw new Error('SubmissionError: reply lost');
  });
  await assert.rejects(() => r.session.activate(), BootstrapRecoveryReplacedError);
  assert.equal(r.seen.submitted, 1); assert.equal(r.seen.registered, 0);
  assert.equal(r.record.retired, true); assert.equal(r.session.device, undefined);
});

for (const failure of ['network', 'deployment', 'activation', 'recovery'] as const) {
  test(`external credential retention rejects after ${failure} preflight failure`, async () => {
    const f = await fixture(), r = f.resume();
    const credential = r.record.credential!;
    delete r.record.credential; delete r.record.approval;
    if (failure === 'network') r.options.observeNetwork = async () => ({ ...r.options.network, genesisHash: bytes() });
    if (failure === 'deployment') r.options.verifyDeployment = async () => { throw new Error('untrusted deployment'); };
    if (failure === 'activation') await f.activate();
    if (failure === 'recovery') await f.recover();
    await assert.rejects(() => r.session.retainCredential(credential), /mismatch|untrusted deployment|dormant bootstrap/);
    assert.equal(r.record.credential, undefined); assert.equal(r.seen.persisted, 0);
  });
}

test('external credential retention verifies the dormant deployment before persisting', async () => {
  const f = await fixture(), r = f.resume(), credential = r.record.credential!;
  delete r.record.credential; delete r.record.approval;
  let observations = 0, verifications = 0;
  r.options.observeNetwork = async () => { observations++; return r.options.network; };
  r.options.verifyDeployment = async () => { verifications++; };
  await r.session.retainCredential(credential);
  assert.equal(observations, 1); assert.equal(verifications, 1); assert.equal(r.seen.persisted, 1);
  assert.deepEqual(r.record.credential, credential);
});

test('fresh approval retains its provider for the completed device and its next account operation', async () => {
  const f = await fixture(), r = f.resume();
  delete r.record.approval;
  let assertions = 0;
  const session = r.account.signedBootstrapSession(r.record, { ...r.options,
    assertionProvider: async () => { throw new Error('explicit approval provider must override this default'); },
  }, f.temporary);
  assert.equal(session.device, undefined);
  const approval = await session.approve(async challenge => { assertions++; return f.passkey.assertion(challenge); });
  assert.equal(assertions, 1); assert.equal(session.device, undefined);
  await f.call('activate_initial_passkey', ...signedBootstrapActivationArgs(approval));
  assert.equal(await session.activate(), r.account);
  assert.ok(session.device);
  const viewingKey = bytes();
  await r.account.rotateEncKey(session.device, viewingKey);
  assert.equal(assertions, 2);
  assert.deepEqual(f.sim.ledger().enc_key, viewingKey);
  assert.equal(f.sim.ledger().auth_nonce, 1n);
});

test('a reconnected retained approval uses its supplied provider without prompting for approval again', async () => {
  const f = await fixture(); let assertions = 0;
  const r = f.resume(undefined, undefined, async challenge => { assertions++; return f.passkey.assertion(challenge); });
  assert.equal(r.session.device, undefined);
  await r.session.approve(); assert.equal(assertions, 0);
  await f.activate(); await r.session.activate(); assert.ok(r.session.device);
  const viewingKey = bytes(); await r.account.rotateEncKey(r.session.device, viewingKey);
  assert.equal(assertions, 1); assert.deepEqual(f.sim.ledger().enc_key, viewingKey);
});

test('historical completion restores the supplied signer and recovery inspection clears it', async () => {
  const f = await fixture(); await f.activate(); await f.withdraw(); let assertions = 0;
  const r = f.resume(undefined, undefined, async challenge => { assertions++; return f.passkey.assertion(challenge); });
  assert.equal(await r.session.inspect(), true); assert.ok(r.session.device);
  const viewingKey = bytes(); await r.account.rotateEncKey(r.session.device, viewingKey);
  assert.equal(assertions, 1); assert.deepEqual(f.sim.ledger().enc_key, viewingKey);
  assert.equal(f.sim.ledger().auth_nonce, 2n);
  await f.recover();
  await assert.rejects(() => r.session.inspect(), BootstrapRecoveryReplacedError);
  assert.equal(r.session.device, undefined);
});

for (const activity of ['withdrawal', 'device enrolment'] as const) {
  test(`resume a pre-submission record after activation and another session's ${activity}`, async () => {
    const f = await fixture(); await f.activate();
    if (activity === 'withdrawal') await f.withdraw(); else await f.addDevice();
    assert.equal(ledger(f.history[1].data).auth_nonce, 0n, 'history retains the original installation');
    assert.equal(f.sim.ledger().auth_nonce, 1n);
    assert.equal(f.sim.ledger().devices.member(f.passkey.device.entryAt(f.sim.address, 0n, 0n)), false);
    const r = f.resume();
    assert.equal(await r.session.inspect(), true);
    assert.equal(await r.session.activate(), r.account);
    assert.equal(r.record.retired, true); assert.equal(r.record.transactionId, undefined);
    assert.equal(r.seen.registered, 2); assert.equal(r.seen.submitted, 0);
    assert.equal(await r.account.resolveUseCounter(f.passkey.device), 1n, 'normal discovery resolves the rolled entry');
  });
}

test('historical completion survives removal of the initial device and grants no live authority', async () => {
  const f = await fixture(); await f.activate(); const second = await f.addDevice();
  const entry = f.passkey.device.entryAt(f.sim.address, 0n, 1n);
  await f.sim.authorised('remove_device', (ctx, d) => jubjubChallenges.removeDevice(ctx, d.pk, entry), [entry], second);
  f.history.push({ data: f.sim.state });
  const r = f.resume(); assert.equal(await r.session.inspect(), true);
  assert.equal(r.seen.registered, 1);
  const discovery = await r.account.discoverUseCounter(f.passkey.device, { maxProbes: 3 });
  assert.equal(discovery.status, 'exhausted');
});

for (const initiallyActivated of [false, true]) test(`recovery replacement has a distinct outcome (initial activation=${initiallyActivated})`, async () => {
  const f = await fixture(); if (initiallyActivated) await f.activate(); await f.recover();
  const r = f.resume();
  await assert.rejects(() => r.session.inspect(), BootstrapRecoveryReplacedError);
  await assert.rejects(() => r.session.activate(), BootstrapRecoveryReplacedError);
  assert.equal(r.record.retired, true); assert.equal(r.seen.registered, 0); assert.equal(r.seen.submitted, 0);
});

test('unavailable or incomplete history cannot turn a retained approval into an activation receipt', async () => {
  const f = await fixture(); await f.activate(); await f.withdraw();
  for (const stream of [() => EMPTY, () => throwError(() => new Error('history unavailable')), () => of({ data: f.sim.state })]) {
    const r = f.resume(stream); await assert.rejects(() => r.session.inspect());
    assert.equal(r.seen.registered, 0); assert.equal(r.seen.submitted, 0);
  }
});

test('the first activated state must contain the intended key, even if a later state does', async () => {
  const f = await fixture(), other = await f.activateDifferentTarget();
  const entry = f.passkey.device.entryAt(f.sim.address, 0n, 0n);
  const auth = await other.device.sign(p256Challenges.addDevice(f.sim.callContext(), other.pk, entry), 0n);
  await f.call('add_device_with_p256', entry, ...authArgs(auth));
  assert.equal(f.sim.ledger().devices.member(entry), true);
  const r = f.resume();
  await assert.rejects(() => r.session.inspect(), /unexpected initial device/);
  assert.equal(r.seen.registered, 0); assert.equal(r.seen.submitted, 0);
});

test('recovery during persistence is rechecked on the immediate-success path', async () => {
  const f = await fixture(); await f.activate(); let pending = true;
  const r = f.resume(undefined, async () => { if (pending) { pending = false; await f.recover(); } });
  await assert.rejects(() => r.session.inspect(), BootstrapRecoveryReplacedError);
  assert.equal(r.seen.registered, 0);
});

test('changing the retained target during persistence cannot register another credential', async () => {
  const f = await fixture(); await f.activate();
  const r = f.resume(undefined, async record => { record.credential!.pk = softwarePasskey().pk; });
  await assert.rejects(() => r.session.inspect(), /target changed/);
  assert.equal(r.seen.registered, 0);
});
