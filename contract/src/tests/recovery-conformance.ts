// Recovery conformance on a live localnet (recovery MIP, Path to Active):
// recovery and grant lifecycle transitions use real transactions, proofs
// and block time. Negative probes refuse during client circuit building
// against funded on-chain state. Arithmetic and foreign-witness controls
// remain simulator-only in recovery-sim.ts. Deploys its own account with
// birth artefacts and a short veto window so finalisation completes in one run.
//
// Requires the localnet from infra/ and WALLET_SEED, like the other
// on-node suites.

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { runScenario, step, sleep, waitForLedger } from './runner.js';
import { writeEvidence, serialiseError } from './evidence.js';
import { expectAbort, issueGrantForCircuitTest } from './flow.js';
import { setupWallet, compiledAccountContract, deployFaucet } from '../node/setup.js';
import { userAddressBytes } from '../node/wallet.js';
import { CustodyAccount } from '../wallet/account.js';
import {
  JubjubDevice, JubjubGrantee, K256Grantee, jubjubGrantChallenges,
  k256GrantChallenges, originHash, openingOf, spendScope,
} from '../wallet/signer.js';
import { generateEncKeyPair } from '../wallet/inbox.js';
import { recoveryKey, matchesRecoveryPk, eqPoint, readArtefactSet } from '../wallet/recovery-gate.js';
import {
  deriveShare,
  split,
  reconstruct,
  fieldToBytes,
  guardianSecretFromPrf,
  sealWrap,
  openWrap,
  newRecoverySecret,
  newSessionNonce,
  type IndexedShare,
} from '../wallet/recovery.js';

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`assertion failed: ${label}`);
  console.log(`  ✓ ${label}`);
}

const eqBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

// Short deployment window: long enough that the early-finalise probe has
// time to land inside it under localnet block cadence, short enough that
// one suite run waits it out.
const WINDOW_SECONDS = 60n;

await runScenario('recovery-conformance', async () => {
  const hashFile = (relative: string) => createHash('sha256')
    .update(readFileSync(new URL(relative, import.meta.url))).digest('hex');
  const circuits = [
    'activate_initial_device_with_jubjub', 'deposit_unshielded',
    'issue_grant_with_jubjub', 'revoke_grant_with_jubjub',
    'withdraw_unshielded_with_grant_jubjub', 'withdraw_unshielded_with_grant_k256',
    'publish_recovery_session_with_jubjub', 'recover_submit',
    'recover_cancel_with_jubjub', 'recover_finalise',
  ];
  const details: Record<string, unknown> = {
    sourceSha256: Object.fromEntries([
      './recovery-conformance.ts', '../wallet/account.ts', '../wallet/signer.ts',
      '../wallet/recovery-gate.ts', '../../contracts/account.compact',
      '../../contracts/managed/account/contract/index.js',
    ].map(path => [path, hashFile(path)])),
    circuitSha256: Object.fromEntries(circuits.map(circuit => [circuit, {
      zkir: hashFile(`../../contracts/managed/account/zkir/${circuit}.bzkir`),
      verifier: hashFile(`../../contracts/managed/account/keys/${circuit}.verifier`),
    }])),
  };

  step('setup: wallet, account with birth artefacts and a 60 s window');
  const ctx = await setupWallet();
  const device = JubjubDevice.generate();
  const encKeys = generateEncKeyPair();
  const birth = newRecoverySecret();
  const account = await CustodyAccount.deploy(
    ctx.providers,
    compiledAccountContract(),
    device,
    encKeys,
    {
      recovery: {
        recoveryPk: recoveryKey(birth.field).pk,
        wrap: new Uint8Array(64), // birth wrap sealed post-deploy sessions only
        vetoWindowSeconds: WINDOW_SECONDS,
      },
    },
  );
  console.log(`  account @ ${account.address}`);
  details.account = account.address;
  let l = await account.ledgerState();
  assert(l.recovery_phi_len === 0n, 'no phi at deploy (recovery at birth is commitment-only here)');
  assert(l.recovery_version === 1n, 'artefact-set version tag present');

  step('fund non-native grant spends and issue the pre-recovery grant');
  const faucet = await deployFaucet(ctx.walletCtx);
  const domain = new Uint8Array(randomBytes(32));
  const color = await faucet.unshieldedColor(domain);
  const recipient = userAddressBytes(ctx.walletCtx);
  const mintTx = await faucet.mintUnshielded(domain, 100n, recipient);
  await sleep(15_000); // allow the funding wallet to index its minted output
  const depositTx = await account.depositUnshielded(color, 100n);
  await waitForLedger(() => account.ledgerState(), 'grant mirror funded',
    led => led.unshielded_balances.member(color) && led.unshielded_balances.lookup(color) === 100n);
  const origin = originHash('https://recovery-grants.example');
  const scope = spendScope({ expiresAt: 0n, withdrawUnshielded: true, color, cap: 100n, perCallCap: 10n });
  const delegates = [JubjubGrantee.generate(), K256Grantee.generate()];
  const grants = delegates.map((grantee, index) => ({
    grantee, id: grantee.grantId(account.addressBytes, origin, BigInt(index)),
    salt: new Uint8Array(randomBytes(32)), slot: BigInt(index),
  }));
  const grantEvidence: Record<string, unknown> = {
    funding: { faucet: faucet.address, domain, color, mintTx, depositTx: depositTx.txId },
    negativeCases: [], reissued: [],
  };
  details.grantRecovery = grantEvidence;
  const snapshot = async () => {
    const state = await account.ledgerState();
    return JSON.stringify({
      round: state.round, authNonce: state.auth_nonce, epoch: state.device_epoch,
      count: state.device_count, devices: [...state.devices],
      grants: [...state.grants], generation: state.grant_generation,
      balances: [...state.unshielded_balances], inboxCount: state.inbox_count,
      pending: state.pending_recovery, encKey: state.enc_key,
    }, (_, value) => typeof value === 'bigint' ? value.toString() : value);
  };
  const issueGrant = async (index: number, owner: JubjubDevice) => {
    const grant = grants[index];
    const tx = await account.issueGrant(owner, grant.id, scope, grant.salt);
    const state = await waitForLedger(() => account.ledgerState(), `grant ${index} issued in the live epoch`,
      led => led.grants.member(grant.id) && led.grants.lookup(grant.id).active &&
        led.grants.lookup(grant.id).epoch === led.device_epoch);
    return { tx: tx.txId, record: state.grants.lookup(grant.id) };
  };
  const signedGrantSpend = async (index: number) => {
    const grant = grants[index];
    const record = (await account.ledgerState()).grants.lookup(grant.id);
    const grantCtx = { contractAddress: account.addressBytes, grantId: grant.id, issuedAt: record.issued_at, grantNonce: record.nonce };
    const auth = grant.grantee.arm === 'jubjub'
      ? grant.grantee.sign(jubjubGrantChallenges.withdrawUnshielded(grantCtx, grant.grantee.pk, color, 5n, recipient))
      : grant.grantee.sign(k256GrantChallenges.withdrawUnshielded(grantCtx, grant.grantee.pk, color, 5n, recipient));
    const opening = openingOf(scope, grant.salt, origin, grant.slot);
    return (currentOpening = opening) => account.withdrawUnshieldedWithGrantAuth(color, 5n, recipient, currentOpening, auth);
  };
  const refuseGrant = async (index: number, label: string) => {
    const before = await snapshot();
    let refusal: Record<string, unknown> | undefined;
    try { await (await signedGrantSpend(index))(); }
    catch (error) {
      refusal = serialiseError(error);
      assert(JSON.stringify(refusal).includes('grant epoch stale'), `${label}: fails the grant epoch check`);
    }
    assert(refusal !== undefined, `${label}: old grant refused`);
    const after = await snapshot();
    assert(after === before, `${label}: all tracked state unchanged`);
    (grantEvidence.negativeCases as unknown[]).push({ label, phase: 'client-build', before: JSON.parse(before), after: JSON.parse(after), refusal });
  };
  const waitForVeto = async () => {
    const deadline = Number((await account.ledgerState()).pending_not_before) * 1000 + 12_000;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      console.log(`  waiting ${Math.ceil(remaining / 1000)}s for the recorded veto deadline...`);
      await sleep(Math.min(remaining, 15_000));
    }
  };
  grantEvidence.beforeRecoveryIssue = await issueGrant(0, device);

  step('revoking one slot leaves another slot under the same key usable');
  grantEvidence.slotIsolation = [];
  for (const grantee of delegates) {
    const entries = [64n, 65n].map(slot => ({
      slot, salt: new Uint8Array(randomBytes(32)),
      id: grantee.grantId(account.addressBytes, origin, slot),
    }));
    const issueTxs: string[] = [];
    for (const entry of entries) {
      const tx = await account.issueGrant(device, entry.id, scope, entry.salt);
      issueTxs.push(tx.txId);
      await waitForLedger(() => account.ledgerState(), `${grantee.arm} slot ${entry.slot} issued`,
        led => led.grants.member(entry.id) && led.grants.lookup(entry.id).active);
    }
    const revokeTx = await account.revokeGrant(device, entries[0].id);
    await waitForLedger(() => account.ledgerState(), `${grantee.arm} slot 64 revoked`,
      led => !led.grants.lookup(entries[0].id).active);
    const beforeRefusal = await snapshot();
    // This row establishes circuit refusal, so retain the raw signed path.
    // Client preflight rejection is exercised separately by its own suite.
    const revokedContext = await account.grantContext(entries[0].id);
    const revokedAuth = grantee.arm === 'jubjub'
      ? grantee.sign(jubjubGrantChallenges.withdrawUnshielded(revokedContext, grantee.pk, color, 5n, recipient))
      : grantee.sign(k256GrantChallenges.withdrawUnshielded(revokedContext, grantee.pk, color, 5n, recipient));
    const refusal = await expectAbort(`${grantee.arm} revoked slot 64`, () =>
      account.withdrawUnshieldedWithGrantAuth(color, 5n, recipient,
        openingOf(scope, entries[0].salt, origin, entries[0].slot), revokedAuth));
    assert(refusal.includes('grant revoked'), 'revoked slot fails its lifecycle check');
    const afterRefusal = await snapshot();
    assert(afterRefusal === beforeRefusal, 'revoked-slot refusal changes no tracked state');
    const before = await account.ledgerState();
    const deviceEntries = [...before.devices];
    const spendTx = await account.withdrawUnshieldedWithGrant(grantee,
      openingOf(scope, entries[1].salt, origin, entries[1].slot), color, 5n, recipient);
    const after = await waitForLedger(() => account.ledgerState(), `${grantee.arm} slot 65 still spends`,
      led => led.grants.lookup(entries[1].id).nonce === 1n);
    assert(!after.grants.lookup(entries[0].id).active && after.grants.lookup(entries[0].id).nonce === 0n,
      'spending slot 65 does not revive or advance slot 64');
    assert(after.auth_nonce === before.auth_nonce && after.device_count === before.device_count &&
      after.devices.size() === BigInt(deviceEntries.length) && deviceEntries.every(entry => after.devices.member(entry)),
      'slot-isolated spending preserves device authority');
    assert(after.unshielded_balances.lookup(color) === before.unshielded_balances.lookup(color) - 5n,
      'the surviving slot releases exactly its authorised amount');
    (grantEvidence.slotIsolation as unknown[]).push({
      arm: grantee.arm, issueTxs, revokeTx: revokeTx.txId, spendTx: spendTx.txId,
      revoked: after.grants.lookup(entries[0].id), surviving: after.grants.lookup(entries[1].id),
      refusal, phase: 'client-build', beforeRefusal: JSON.parse(beforeRefusal), afterRefusal: JSON.parse(afterRefusal),
    });
  }

  step('an expired but unrevoked grant cannot be overwritten');
  const expiredId = delegates[0].grantId(account.addressBytes, origin, 250n);
  const expiredSalt = new Uint8Array(randomBytes(32));
  const expiredScope = { ...scope, expiresAt: BigInt(Math.floor(Date.now() / 1000) - 60) };
  const expiredIssue = await issueGrantForCircuitTest(account, device, expiredId, expiredScope, expiredSalt);
  await waitForLedger(() => account.ledgerState(), 'expired record issued and active',
    led => led.grants.member(expiredId) && led.grants.lookup(expiredId).active);
  const beforeExpired = await snapshot();
  const expiredRefusal = await expectAbort('reissue expired but unrevoked id', () =>
    account.issueGrant(device, expiredId, scope, new Uint8Array(randomBytes(32))));
  assert(expiredRefusal.includes('grant already active'), 'expiry does not bypass explicit revocation');
  const afterExpired = await snapshot();
  assert(afterExpired === beforeExpired, 'expired-record reissue refusal changes no tracked state');
  grantEvidence.expiredUnrevoked = {
    issueTx: expiredIssue.txId, refusal: expiredRefusal, phase: 'client-build',
    before: JSON.parse(beforeExpired), after: JSON.parse(afterExpired),
  };

  step('session: three guardians at threshold two, published through the seam');
  const t = 1;
  const guardians = [0, 1, 2].map(() => guardianSecretFromPrf(new Uint8Array(randomBytes(32))));
  const s = newRecoverySecret();
  const sid = newSessionNonce();
  const shares: IndexedShare[] = guardians.map((g, i) => ({
    index: i + 1,
    sigma: deriveShare(sid, account.addressBytes, g),
  }));
  const phi = split(s.field, shares, t);
  const sessionTx = await account.publishRecoverySession(device, {
    recoveryPk: recoveryKey(s.field).pk,
    sessionNonce: sid,
    phi,
    wrap: sealWrap(s.bytes, account.addressBytes, encKeys.secretKey),
  });
  details.sessionTx = sessionTx.txId;
  await waitForLedger(
    () => account.ledgerState(),
    'artefact set on-chain',
    (led) => led.recovery_phi_len === 2n && eqBytes(led.recovery_session, sid),
  );

  step('freshness backstop on-node: reused identifier rejected');
  const s2 = newRecoverySecret();
  await expectAbort('publishing under the stored session identifier', () =>
    account.publishRecoverySession(device, {
      recoveryPk: recoveryKey(s2.field).pk,
      sessionNonce: sid,
      phi: [1n, 2n],
      wrap: sealWrap(s2.bytes, account.addressBytes, encKeys.secretKey),
    }));

  step('total loss: reconstruct from t+1 shares and the on-chain vector');
  l = await account.ledgerState();
  const set = readArtefactSet(l);
  const sRec = reconstruct(set.phi, [shares[0], shares[2]], t);
  assert(matchesRecoveryPk(sRec, set.recoveryPk), 'reconstructed secret opens the stored recovery key');
  const vk = openWrap(fieldToBytes(sRec), account.addressBytes, set.wrap);
  assert(vk !== null && eqBytes(vk, encKeys.secretKey), 'the on-chain wrap restores the encryption secret (REC-7)');

  step('submission records the pending recovery');
  const successor = JubjubDevice.generate();
  const successorSecret = newRecoverySecret();
  const successorRecoveryPk = recoveryKey(successorSecret.field).pk;
  const nowUpper = BigInt(Math.floor(Date.now() / 1000) + 60);
  const submitTx = await account.recoverSubmit(sRec, successor, successorRecoveryPk, nowUpper);
  details.submitTx = submitTx.txId;
  await waitForLedger(
    () => account.ledgerState(),
    'pending recovery on-chain',
    (led) => led.pending_recovery === true,
  );
  const epochBefore = (await account.ledgerState()).device_epoch;

  step('the window holds: early finalisation aborts');
  await expectAbort('finalising inside the veto window', () => account.recoverFinalise());

  step('cancel: immediate, epoch unchanged, pending cleared');
  const cancelTx = await account.recoverCancel(device);
  details.cancelTx = cancelTx.txId;
  await waitForLedger(
    () => account.ledgerState(),
    'pending record cleared',
    (led) => led.pending_recovery === false && led.device_epoch === epochBefore,
  );

  step('resubmission after the cancel, then finalisation after the window');
  const nowUpper2 = BigInt(Math.floor(Date.now() / 1000) + 60);
  const submit2 = await account.recoverSubmit(sRec, successor, successorRecoveryPk, nowUpper2);
  details.resubmitTx = submit2.txId;
  await waitForLedger(
    () => account.ledgerState(),
    'second pending recovery on-chain',
    (led) => led.pending_recovery === true,
  );
  grantEvidence.pendingRecoveryIssue = await issueGrant(1, device);
  assert((await account.ledgerState()).pending_recovery, 'second grant issued while recovery is pending');
  const oldGrantEpoch = (await account.ledgerState()).device_epoch;
  await waitForVeto();
  const beforeFinalise = await account.ledgerState();
  const finaliseTx = await account.recoverFinalise();
  details.finaliseTx = finaliseTx.txId;
  await waitForLedger(
    () => account.ledgerState(),
    'recovery finalised',
    (led) =>
      led.device_epoch === epochBefore + 1n &&
      led.device_count === 1n &&
      led.pending_recovery === false &&
      led.recovery_phi_len === 0n &&
      eqPoint(led.recovery_pk, successorRecoveryPk) &&
      led.auth_nonce === beforeFinalise.auth_nonce + 1n &&
      led.round === beforeFinalise.round + 1n,
  );

  const afterFinalise = await account.ledgerState();
  assert(afterFinalise.devices.size() === 1n &&
    afterFinalise.devices.member(successor.entryAt(account.addressBytes, afterFinalise.device_epoch, 0n)),
    'first recovery retains exactly the authorised successor entry');
  assert([...beforeFinalise.devices].every(entry => !afterFinalise.devices.member(entry)),
    'first recovery removes every prior device entry');
  for (let index = 0; index < grants.length; index++) {
    await refuseGrant(index, `grant ${index} after first recovery`);
  }

  step('the successor controls the account; the old device is dead (REC-8, AUTH-6)');
  account.registerDevice(successor.pk);
  await expectAbort('old device authorising after the epoch bump', () =>
    account.addDevice(device, JubjubDevice.generate()));
  const s3 = newRecoverySecret();
  const sid3 = newSessionNonce();
  const shares3: IndexedShare[] = guardians.map((g, i) => ({
    index: i + 1,
    sigma: deriveShare(sid3, account.addressBytes, g),
  }));
  const reSession = await account.publishRecoverySession(successor, {
    recoveryPk: recoveryKey(s3.field).pk,
    sessionNonce: sid3,
    phi: split(s3.field, shares3, t),
    wrap: sealWrap(s3.bytes, account.addressBytes, encKeys.secretKey),
  });
  details.postRecoverySessionTx = reSession.txId;
  await waitForLedger(
    () => account.ledgerState(),
    'post-recovery session published by the successor',
    (led) => led.recovery_phi_len === 2n && eqBytes(led.recovery_session, sid3),
  );

  step('a later recovery cannot reactivate either old grant');
  const finalDevice = JubjubDevice.generate();
  const finalRecoveryPk = recoveryKey(newRecoverySecret().field).pk;
  const laterSubmit = await account.recoverSubmit(s3.field, finalDevice, finalRecoveryPk,
    BigInt(Math.floor(Date.now() / 1000) + 60));
  grantEvidence.laterSubmitTx = laterSubmit.txId;
  await waitForLedger(() => account.ledgerState(), 'later recovery pending', led => led.pending_recovery);
  await waitForVeto();
  const beforeLaterFinalise = await account.ledgerState();
  const laterFinalise = await account.recoverFinalise();
  grantEvidence.laterFinaliseTx = laterFinalise.txId;
  const finalState = await waitForLedger(() => account.ledgerState(), 'second epoch increment',
    led => !led.pending_recovery && led.device_epoch === oldGrantEpoch + 2n &&
      led.auth_nonce === beforeLaterFinalise.auth_nonce + 1n && led.round === beforeLaterFinalise.round + 1n);
  account.registerDevice(finalDevice.pk);
  assert(finalState.device_count === 1n && finalState.devices.size() === 1n,
    'second recovery leaves only its authorised successor');
  assert(finalState.devices.member(finalDevice.entryAt(account.addressBytes, finalState.device_epoch, 0n)),
    'the sole remaining device is the second successor');
  for (let index = 0; index < grants.length; index++) {
    await refuseGrant(index, `grant ${index} after later recovery`);
    assert((await account.ledgerState()).grants.lookup(grants[index].id).epoch === oldGrantEpoch,
      'an old record retains its original issuance epoch');
  }

  step('the successor revokes, re-issues, and exercises both grantee arms');
  for (let index = 0; index < grants.length; index++) {
    const grant = grants[index];
    const oldIssuedAt = (await account.ledgerState()).grants.lookup(grant.id).issued_at;
    const oldCall = await signedGrantSpend(index);
    const revokeTx = await account.revokeGrant(finalDevice, grant.id);
    await waitForLedger(() => account.ledgerState(), `old grant ${index} revoked`, led => !led.grants.lookup(grant.id).active);
    grant.salt = new Uint8Array(randomBytes(32));
    const issued = await issueGrant(index, finalDevice);
    assert(issued.record.issued_at > oldIssuedAt, 'successor issuance creates a new incarnation');
    // Both incarnations have nonce zero. Give the old signature the new
    // opening so the refusal demonstrates incarnation binding, not a stale
    // commitment opening or an advanced grant nonce.
    const beforeReplay = await snapshot();
    let replayRefusal: Record<string, unknown> | undefined;
    try { await oldCall(openingOf(scope, grant.salt, origin, grant.slot)); }
    catch (error) {
      replayRefusal = serialiseError(error);
      assert(/invalid grant signature|range error/.test(JSON.stringify(replayRefusal)),
        'old-incarnation signature fails even with the fresh scope opening');
    }
    assert(replayRefusal !== undefined, 'pre-recovery signature cannot authorise a reissued grant');
    const afterReplay = await snapshot();
    assert(afterReplay === beforeReplay, 'incarnation replay refusal changes no tracked state');
    (grantEvidence.negativeCases as unknown[]).push({
      label: `grant ${index} prior-incarnation signature with fresh opening`,
      phase: 'client-build', oldIssuedAt, newIssuedAt: issued.record.issued_at,
      before: JSON.parse(beforeReplay), after: JSON.parse(afterReplay), refusal: replayRefusal,
    });
    const before = await account.ledgerState();
    const deviceEntries = [...before.devices];
    const spendTx = await (await signedGrantSpend(index))();
    const after = await waitForLedger(() => account.ledgerState(), `new grant ${index} spent`,
      led => led.grants.lookup(grant.id).nonce === 1n &&
        led.unshielded_balances.lookup(color) === before.unshielded_balances.lookup(color) - 5n);
    assert(after.auth_nonce === before.auth_nonce && after.device_count === before.device_count,
      'grant spend preserves the device nonce and count');
    assert(after.devices.size() === BigInt(deviceEntries.length) && deviceEntries.every(entry => after.devices.member(entry)),
      'grant spend preserves the device set');
    assert(after.round === before.round + 1n, 'grant spend advances round exactly once');
    (grantEvidence.reissued as unknown[]).push({
      arm: grant.grantee.arm, grantId: grant.id, revokeTx: revokeTx.txId, issue: issued,
      spendTx: spendTx.txId, oldIssuedAt, epoch: after.device_epoch,
      authNonceBefore: before.auth_nonce, authNonceAfter: after.auth_nonce,
      balanceBefore: before.unshielded_balances.lookup(color), balanceAfter: after.unshielded_balances.lookup(color),
      grant: after.grants.lookup(grant.id),
    });
  }

  writeEvidence({
    testId: 'rec-1-9',
    name: 'recovery-conformance',
    description:
      'Recovery MIP on-node conformance: session publish through the seam, ' +
      'freshness backstop, reconstruction and wrap round-trip, the signature ' +
      'gate (recovery key plus successor co-signature, no secret in the ' +
      'proof), veto window and cancel, epoch bump, successor control; ' +
      'pre-existing and pending-window grants stay invalid across two recoveries, ' +
      'then successor-issued JubJub and k256 grants spend without modifying devices.',
    verdict: 'PASS',
    txHash: String(details.finaliseTx ?? ''),
    note:
      'Deployed with birth artefacts and a 60 s veto window; the full ' +
      'lifecycle including real window waits ran against the localnet. Grant ' +
      'negatives are client-build refusals against funded on-chain state, ' +
      'not submitted node-admission refusals.',
    details,
  });
});
