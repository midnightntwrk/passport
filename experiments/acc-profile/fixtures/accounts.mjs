// Exercise each exported operation on a valid simulated account. Fixtures use
// disposable keys, a current device entry, funded coins and an opened grant.
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export async function accountFixtures(contract, captureCalls) {
  const { AccountSim } = await import(path.join(contract, 'src/tests/sim.ts'));
  const { softwarePasskey, TEST_ORIGIN } = await import(path.join(contract, 'src/tests/p256-fixtures.ts'));
  const {
    JubjubDevice, K256Device, JubjubGrantee, K256Grantee,
    jubjubChallenges, k256Challenges, p256Challenges, jubjubGrantChallenges,
    k256GrantChallenges, p256GrantChallenges, authArgs, grantAuthArgs,
    scopeArgs, scopeDigest, openingOf, spendScope, originHash,
  } = await import(path.join(contract, 'src/wallet/signer.ts'));
  const { withCoin, withSelectedCoin } = await import(path.join(contract, 'src/wallet/witnesses.ts'));
  const { generateEncKeyPair } = await import(path.join(contract, 'src/wallet/inbox.ts'));

  const bytes = (n = 32) => new Uint8Array(randomBytes(n));
  const passkey = softwarePasskey();
  const delegate = softwarePasskey();
  for (const [arm, device, grantee, challenges, grantChallenges] of [
    ['jubjub', JubjubDevice.generate(), JubjubGrantee.generate(), jubjubChallenges, jubjubGrantChallenges],
    ['k256', K256Device.generate(), K256Grantee.generate(), k256Challenges, k256GrantChallenges],
    ['p256', passkey.device, delegate.grantee, p256Challenges, p256GrantChallenges],
  ]) {
    const birth = JubjubDevice.generate(), salt = bytes();
    const sim = await AccountSim.createDormant({
      initialRecoveryPk: birth.pk, initialWrap: bytes(64), vetoWindowSeconds: 60n,
    }, device.bootCommitment(salt));
    const extra = arm === 'k256' ? [device.envelope] : arm === 'p256' ? [passkey.policy] : [];
    captureCalls(sim.impure);
    await sim.call('activate_initial_device_with_' + arm, device.pk, salt, ...extra);
    let counter = 0n;
    async function call(name, builder, args, challengeArgs = args) {
      const auth = await device.sign(builder(sim.callContext(), device.pk, ...challengeArgs), counter);
      await sim.call(name + '_with_' + arm, ...args, ...authArgs(auth));
      counter++;
    }
    const enc = generateEncKeyPair().publicKey;
    await call('rotate_enc_key', challenges.rotateEncKey, [enc]);
    const extraEntry = JubjubDevice.generate().entryAt(sim.address, 0n, 0n);
    await call('add_device', challenges.addDevice, [extraEntry]);
    await call('remove_device', challenges.removeDevice, [extraEntry]);
    await call('append_inbox', challenges.appendInbox, [bytes(192)]);
    const color = bytes(), recipient = bytes(), amount = 5n;
    await sim.call('deposit_unshielded', color, 100n);
    await call('withdraw_unshielded', challenges.withdrawUnshielded, [color, amount, {bytes: recipient}], [color, amount, recipient]);
    const origin = originHash(TEST_ORIGIN), scopeSalt = bytes();
    const id = grantee.grantId(sim.address, origin, 0n);
    const scope = spendScope({
      expiresAt: 0n, color, cap: 100n, withdrawUnshielded: true, withdrawShielded: true,
      withdrawShieldedToContract: true, readPkHash: bytes(), rpIdHash: arm === 'p256' ? delegate.policy.rp_id_hash : undefined,
    });
    await call('issue_grant', challenges.issueGrant, [id, ...scopeArgs(scope), scopeSalt], [id, scopeDigest(scopeSalt, scope)]);
    const opening = openingOf(scope, scopeSalt, origin, 0n);
    async function grant(name, builder, args, challengeArgs) {
      const record = sim.ledger().grants.lookup(id);
      const context = {contractAddress: sim.address, grantId: id, issuedAt: record.issued_at, grantNonce: record.nonce};
      const signed = await grantee.sign(builder(context, grantee.pk, ...challengeArgs));
      await sim.call(name + '_with_grant_' + arm, ...args, ...grantAuthArgs(opening, signed));
      opening.spentPrev += amount;
    }
    await grant('withdraw_unshielded', grantChallenges.withdrawUnshielded, [color, amount, {bytes: recipient}], [color, amount, recipient]);
    let index = 0n;
    async function fund() {
      const coin = {nonce: bytes(), color, value: 2n * amount, mt_index: index++};
      await sim.call('deposit_shielded', {nonce: coin.nonce, color, value: coin.value}, bytes(192));
      sim.privateState = withSelectedCoin(withCoin(sim.privateState, {...coin, mtIndex: coin.mt_index}), coin);
      return coin;
    }
    for (const [name, builder, grantBuilder] of [
      ['withdraw_shielded', challenges.withdrawShielded, grantChallenges.withdrawShielded],
      ['withdraw_shielded_to_contract', challenges.withdrawShieldedToContract, grantChallenges.withdrawShieldedToContract],
    ]) {
      await call(name, builder, [{bytes: recipient}, color, amount], [recipient, color, amount, await fund()]);
      const changeEntry = bytes(192);
      await grant(name, grantBuilder, [{bytes: recipient}, color, amount, changeEntry, enc],
                  [recipient, color, amount, changeEntry, enc, await fund()]);
    }
    await call('revoke_grant', challenges.revokeGrant, [id]);
    await call('revoke_all_grants', challenges.revokeAllGrants, []);
    const recovery = JubjubDevice.generate(), session = bytes(), phi = [1n, 0n, 0n, 0n], wrap = bytes(64);
    await call('publish_recovery_session', challenges.publishRecoverySession, [recovery.pk, session, ...phi, 1n, wrap],
               [recovery.pk, session, phi, 1n, wrap]);
    const successor = JubjubDevice.generate();
    const submit = () => sim.recoverSubmit(recovery, successor, birth.pk, BigInt(sim.now + 1));
    await submit();
    await call('recover_cancel', challenges.recoverCancel, []);
    await submit();
    sim.advanceTime(120);
    await sim.call('recover_finalise');
    console.log(arm + ' completed');
  }
}
