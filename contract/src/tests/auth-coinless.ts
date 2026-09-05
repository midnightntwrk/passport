// Seam conformance on the coinless authorisation surface, both arms — the
// arm-specific halves of MIP-0013 tests 1, 2 (fault (a)), 6, and 10 that
// carry no token offer, plus the cross-arm enrolment path that only exists
// because the arms are co-resident.
//
// Rationale: on the ledger-9 localnet, any transaction combining a contract
// call with an unshielded offer is rejected at the mempool by the fee
// model's time-to-dismiss limit (see README, "Known localnet limitation"),
// which blocks the funded suites. The authorisation seam itself is
// exercisable without coins: activation (bootstrap), gated add_device, the
// tampered-signature aborts, and each arm authorising gated calls of its
// own. Flow:
//
//   1. deploy + activate under the k256 arm (test 10 happy leg; entry at
//      epoch 0, counter 0)
//   2. CROSS-ARM: the k256 device enrols a JUBJUB device — the k256 seam
//      gates the call, the jubjub entry lands (the arm-migration path)
//   3. the jubjub device authorises a gated call of its own: it enrols a
//      second jubjub device — the Schnorr seam verifies on-node and the
//      rolling entry advances (test 6's 1-of-n half under the jubjub arm)
//   4. gated add_device with tampered jubjub sig_s -> in-circuit Schnorr
//      verify fails, call aborts, no state change (test 2 fault (a))
//   5. gated add_device with tampered k256 sig.s -> in-circuit ECDSA verify
//      fails, call aborts, no state change (test 2 fault (a))
//   6. CROSS-ARM, reverse: the jubjub device enrols a k256 device

import {
  ecMulGenerator,
  secp256k1MulGenerator,
  secp256k1PointX,
  secp256k1ScalarInv,
  secp256k1ScalarMul,
} from '@midnight-ntwrk/compact-runtime';
import {
  ContractOperationVersion,
  ContractOperationVersionedVerifierKey,
  ContractState,
  Intent,
  MaintenanceUpdate,
  Transaction,
  VerifierKeyInsert,
  VerifierKeyRemove,
  signData,
} from '@midnightntwrk/ledger-v9';
import { submitTx } from '@midnight-ntwrk/midnight-js-contracts';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { CONFIG } from '../node/wallet.js';

import { runScenario, step, waitForLedger } from './runner.js';
import { writeEvidence } from './evidence.js';
import { standardSetup, expectAbort } from './flow.js';
import { compiledAccountContract } from '../node/setup.js';
import { CustodyAccount } from '../wallet/account.js';
import { generateEncKeyPair } from '../wallet/inbox.js';
import { pureCircuits, type JubjubPoint, type Secp256k1Point } from '../wallet/contract.js';
import {
  JubjubDevice,
  K256Device,
  SECP256K1_N,
  jubjubChallenges,
  k256Challenges,
  type JubjubAuthorisation,
  type K256Authorisation,
} from '../wallet/signer.js';

/** The challenge as ECDSA reads it: big-endian integer, reduced mod n. */
const bytesToScalarBE = (b: Uint8Array): bigint => {
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  return v % SECP256K1_N;
};

await runScenario('auth-coinless (both arms)', async () => {
  const s = await standardSetup(); // initial device: k256
  const details: Record<string, unknown> = { account: s.account.address };
  const l0 = await s.account.ledgerState();
  console.log(`  account ${s.account.address}; auth_nonce ${l0.auth_nonce}; initial arm k256`);

  step('cross-arm enrolment: the k256 device adds a jubjub device');
  const j1 = JubjubDevice.generate();
  const { txId } = await s.account.addDevice(s.device, j1);
  const l1 = await waitForLedger(
    () => s.account.ledgerState(),
    'auth_nonce advanced',
    (l) => l.auth_nonce === l0.auth_nonce + 1n,
  );
  if (l1.device_count !== 2n) throw new Error('jubjub device entry did not land');
  details.crossArmAddTx = txId;
  console.log(`  accepted tx ${txId}; auth_nonce ${l0.auth_nonce} -> ${l1.auth_nonce}; devices ${l1.device_count}`);

  step('the jubjub device authorises a gated call of its own (Schnorr seam on-node)');
  const j2 = JubjubDevice.generate();
  const r2 = await s.account.addDevice(j1, j2);
  const l2 = await waitForLedger(
    () => s.account.ledgerState(),
    'auth_nonce advanced again',
    (l) => l.auth_nonce === l0.auth_nonce + 2n,
  );
  if (l2.device_count !== 3n) throw new Error('second jubjub entry did not land');
  details.jubjubSeamTx = r2.txId;
  console.log(`  accepted tx ${r2.txId}; auth_nonce ${l1.auth_nonce} -> ${l2.auth_nonce}; devices ${l2.device_count}`);

  step('gated add_device with tampered jubjub sig_s aborts');
  {
    const probe = JubjubDevice.generate();
    const ctx = await s.account.callContext();
    const counter = await s.account.resolveUseCounter(j1);
    const newEntry = probe.entryAt(s.account.addressBytes, l2.device_epoch, 0n);
    const auth = j1.sign(jubjubChallenges.addDevice(ctx, j1.pk, newEntry), counter);
    const bad: JubjubAuthorisation = { ...auth, sig_s: auth.sig_s + 1n };
    details.tamperedJubjubAbort = await expectAbort('tampered jubjub sig_s', () =>
      s.account.addDeviceWithAuth(newEntry, bad));
    const untouched = await s.account.ledgerState();
    if (untouched.auth_nonce !== l2.auth_nonce) {
      throw new Error('aborted jubjub call changed auth_nonce');
    }
  }

  step('gated add_device with tampered k256 sig.s aborts');
  {
    const probe = K256Device.generate();
    const ctx = await s.account.callContext();
    const counter = await s.account.resolveUseCounter(s.device);
    const newEntry = probe.entryAt(s.account.addressBytes, l2.device_epoch, 0n);
    const auth = s.device.sign(k256Challenges.addDevice(ctx, s.device.pk, newEntry), counter);
    const bad: K256Authorisation = { ...auth, sig: { r: auth.sig.r, s: auth.sig.s + 1n } };
    details.tamperedK256Abort = await expectAbort('tampered k256 sig.s', () =>
      s.account.addDeviceWithAuth(newEntry, bad));
    const untouched = await s.account.ledgerState();
    if (untouched.auth_nonce !== l2.auth_nonce) {
      throw new Error('aborted k256 call changed auth_nonce');
    }
  }

  // ── Seam guards (S12, S13) ────────────────────────────────────────────────
  //
  // Two properties the entry-based enrolment ABI makes reachable, and which
  // the seam must therefore refuse. Both are exercised through the real
  // attack, not a proxy: the entry is genuinely planted on-ledger first.

  step('S12: the point at infinity is refused as a k256 device key');
  {
    // ECDSA is forgeable against the identity: the stdlib verify computes
    // P = u1·G + u2·pk and tests x(P) == r, so with pk = O the key-dependent
    // term vanishes and any s yields a passing r = x((z·s⁻¹)·G). Plant the
    // identity's entry (do_add_device takes an already-derived entry, so this
    // is permitted), then present a genuine forgery against it.
    const identity: Secp256k1Point = { x: 0n, y: 0n, identity: true };
    const lPre = await s.account.ledgerState();
    const identityEntry = pureCircuits.derive_device_entry_with_k256(
      { bytes: s.account.addressBytes }, identity, false, lPre.device_epoch, 0n,
    );
    const planted = await s.account.addDeviceEntry(j1, identityEntry);
    const lPlanted = await waitForLedger(
      () => s.account.ledgerState(),
      'identity entry planted',
      (l) => l.devices.member(identityEntry),
    );
    details.identityEntryPlantedTx = planted.txId;

    const ctx = await s.account.callContext();
    const probe = K256Device.generate();
    const newEntry = probe.entryAt(s.account.addressBytes, lPlanted.device_epoch, 0n);
    const challenge = k256Challenges.addDevice(ctx, identity, newEntry);
    // Forge: choose s freely, then derive the r that closes the equation.
    const z = bytesToScalarBE(challenge);
    const sForged = 0xdeadbeefn;
    const w = secp256k1ScalarInv(sForged);
    const rForged = secp256k1PointX(secp256k1MulGenerator(secp256k1ScalarMul(z, w))) % SECP256K1_N;
    const forged: K256Authorisation = {
      arm: 'k256', pk: identity, use_counter: 0n, sig: { r: rForged, s: sForged },
      connector: false,
    };
    details.identityForgeryAbort = await expectAbort('forged signature under pk = O', () =>
      s.account.addDeviceWithAuth(newEntry, forged));

    // BOTH encodings must be refused. Secp256k1Point carries an identity flag,
    // and a flag-based guard (`pk != default<Secp256k1Point>`) lets the
    // unflagged twin {0,0,identity:false} through: the structural comparison
    // returns "not equal" the moment the flags differ. That twin hashes to the
    // SAME entry as the flagged form (the entry binds only x and y), so it
    // reaches the very same planted entry — which is why the guard compares
    // coordinates instead. Presenting only the flagged form would leave this
    // untested, which is exactly how the gap survived its first fix.
    const identityUnflagged: Secp256k1Point = { x: 0n, y: 0n, identity: false };
    const unflaggedEntry = pureCircuits.derive_device_entry_with_k256(
      { bytes: s.account.addressBytes }, identityUnflagged, false, lPlanted.device_epoch, 0n,
    );
    if (Buffer.compare(Buffer.from(unflaggedEntry), Buffer.from(identityEntry)) !== 0) {
      throw new Error('the two identity encodings no longer share an entry; revisit this test');
    }
    const forgedUnflagged: K256Authorisation = { ...forged, pk: identityUnflagged };
    details.identityUnflaggedForgeryAbort = await expectAbort(
      'forged signature under the UNFLAGGED twin {0,0,identity:false}', () =>
        s.account.addDeviceWithAuth(newEntry, forgedUnflagged));

    const untouched = await s.account.ledgerState();
    if (untouched.auth_nonce !== lPlanted.auth_nonce) {
      throw new Error('refused identity call changed auth_nonce');
    }
    console.log('  ✓ the entry is on-ledger and the forgery is valid ECDSA; both encodings refused');
  }

  step('S12, normative arm: a small-order jubjub key is refused');
  {
    // The identical break on the JubJub arm, which is the normative MIP-0013
    // scheme: the seam asserts s·G == R + c·pk, so at pk = O the check is just
    // s·G == R and the challenge never matters. JubJub's identity is the plain
    // affine point (0, 1) — nothing in the type marks it. Plant its entry,
    // then present R = s·G for a chosen s.
    const identityJ: JubjubPoint = { x: 0n, y: 1n };
    const lPre = await s.account.ledgerState();
    const identityEntry = pureCircuits.derive_device_entry_with_jubjub(
      { bytes: s.account.addressBytes }, identityJ, lPre.device_epoch, 0n,
    );
    const planted = await s.account.addDeviceEntry(j1, identityEntry);
    const lPlanted = await waitForLedger(
      () => s.account.ledgerState(),
      'jubjub identity entry planted',
      (l) => l.devices.member(identityEntry),
    );
    details.jubjubIdentityEntryPlantedTx = planted.txId;

    const probe = JubjubDevice.generate();
    const newEntry = probe.entryAt(s.account.addressBytes, lPlanted.device_epoch, 0n);
    const sForged = 0xfeedfacen;
    const forged: JubjubAuthorisation = {
      arm: 'jubjub', pk: identityJ, use_counter: 0n,
      sig_r: ecMulGenerator(sForged), sig_s: sForged, grind_nonce: 0n,
    };
    details.jubjubIdentityForgeryAbort = await expectAbort('forged Schnorr under pk = O', () =>
      s.account.addDeviceWithAuth(newEntry, forged));
    const untouched = await s.account.ledgerState();
    if (untouched.auth_nonce !== lPlanted.auth_nonce) {
      throw new Error('refused jubjub identity call changed auth_nonce');
    }
    console.log('  ✓ s·G == R holds for the forgery; cofactor clearing refuses the key first');
  }

  step('S13: a device cannot remove the entry it just authorised with (AUTH-5)');
  {
    // device_count cannot carry AUTH-5 once entries arrive pre-derived, so the
    // rule is anchored on the caller. Removing the PRE-roll entry already fails
    // on membership; the hole was the POST-roll entry, which is live.
    const l = await s.account.ledgerState();
    const counter = await s.account.resolveUseCounter(j1);
    const postRoll = j1.entryAt(s.account.addressBytes, l.device_epoch, counter + 1n);
    details.selfRemovalAbort = await expectAbort('self-removal at the post-roll entry', () =>
      s.account.removeDeviceEntry(j1, postRoll));
    const after = await s.account.ledgerState();
    if (after.device_count !== l.device_count) {
      throw new Error('refused self-removal changed device_count');
    }
    console.log('  ✓ the authorising device survives its own removal attempt');
  }

  step('S14: the retired maintenance authority cannot amend the contract');
  {
    // While a maintenance authority is live it sits ABOVE the seam: a
    // VerifierKeyInsert replaces an operation's verifier key outright, so its
    // holder can substitute an arbitrary relation for a gated circuit and
    // release assets with no device signature. Wave 2 retires it.
    //
    // The rejection alone would not show WHY the update failed, so this runs
    // with a positive control, the way leak-audit does: the identical swap is
    // built against an account deployed with retireAuthority: false, where it
    // must SUCCEED. That the same bytes land there and are refused here
    // isolates the retirement as the cause, and demonstrates that the bypass
    // is real when the authority survives.
    // The authority's counter is read from chain rather than assumed: it is
    // what a signer must match, and it advances with each applied update.
    const authorityCounter = async (address: string): Promise<bigint> => {
      const r = await fetch(CONFIG.indexer, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: `{contractAction(address:"${address}"){state}}` }),
      });
      const hex = (await r.json() as any)?.data?.contractAction?.state;
      if (!hex) throw new Error(`no on-chain state for ${address}`);
      const st = ContractState.deserialize(
        Uint8Array.from(hex.match(/../g)!.map((b: string) => parseInt(b, 16))),
      );
      return st.maintenanceAuthority.counter;
    };

    const swapFor = async (account: typeof s.account) => {
      const signingKey =
        await account.providers.privateStateProvider.getSigningKey(account.address);
      if (!signingKey) throw new Error('no stored signing key: the attempt would be vacuous');
      // A DIFFERENT circuit's key under the gated operation's id.
      // deposit_unshielded is permissionless and verifies no signature, so
      // this genuinely substitutes the relation behind
      // withdraw_shielded_with_k256 rather than re-inserting the same key.
      //
      // Remove THEN insert, in one update: a bare VerifierKeyInsert over an
      // operation that already holds a key is refused (measured: FailFallible
      // at every counter), so insert means insert, not replace. Note this is
      // also why compact-js's addOrReplaceContractOperation, which emits a
      // bare insert, cannot replace an existing key.
      const vk = await account.providers.zkConfigProvider.getVerifierKey('deposit_unshielded');
      const bare = new MaintenanceUpdate(
        account.address,
        [
          new VerifierKeyRemove('withdraw_shielded_with_k256', new ContractOperationVersion('v4')),
          new VerifierKeyInsert('withdraw_shielded_with_k256',
            new ContractOperationVersionedVerifierKey('v4', vk)),
        ],
        await authorityCounter(account.address),
      );
      const signed = bare.addSignature(0n, signData(signingKey, bare.dataToSign));
      const ttl = new Date(Date.now() + Number(process.env.TX_TTL_MS ?? '60000'));
      return Transaction.fromParts(
        getNetworkId(), undefined, undefined, Intent.new(ttl).addMaintenanceUpdate(signed),
      );
    };

    console.log('  positive control: an account whose authority was NOT retired');
    const control = await CustodyAccount.deploy(
      s.ctx.providers, compiledAccountContract(),
      K256Device.generate(), generateEncKeyPair(),
      { retireAuthority: false },
    );
    const controlTx = await swapFor(control);
    const accepted: any = await (submitTx as any)(control.providers, { unprovenTx: controlTx });
    details.liveAuthoritySwapTx = accepted?.txId ?? 'unknown';
    const status = String(accepted?.status ?? 'unknown');
    details.liveAuthoritySwapStatus = status;
    if (status.toLowerCase().includes('fail')) {
      throw new Error(`positive control did not land: ${status}`);
    }
    console.log(`  ✓ the swap LANDS on a live authority — tx ${details.liveAuthoritySwapTx} (${status})`);
    console.log('    (the bypass: withdraw_shielded_with_k256 now verifies the permissionless');
    console.log('     deposit relation, so the seam no longer gates it — no device signature involved)');

    // Now the identical update against the default account. A refusal can
    // arrive two ways and both count: the node can reject the transaction at
    // the mempool (which throws), or include it and fail its fallible section
    // (which returns a status). Only an applied update is a failure here.
    const retiredTx = await swapFor(s.account);
    let applied = false;
    let refusal: string;
    try {
      const r: any = await (submitTx as any)(s.account.providers, { unprovenTx: retiredTx });
      const st = String(r?.status ?? 'unknown');
      applied = !st.toLowerCase().includes('fail');
      refusal = `included, ${st}`;
      details.retiredAuthoritySwapTx = r?.txId ?? 'unknown';
    } catch (e: any) {
      refusal = `rejected at submission: ${String(e?.message ?? e).slice(0, 120)}`;
    }
    details.retiredAuthoritySwapRefusal = refusal;
    if (applied) {
      throw new Error(`the retired authority still applied an update: ${refusal}`);
    }
    // And confirm positively, from chain, that the authority is unsatisfiable.
    const retiredState = await (async () => {
      const r = await fetch(CONFIG.indexer, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: `{contractAction(address:"${s.account.address}"){state}}` }),
      });
      const hex = (await r.json() as any)?.data?.contractAction?.state;
      return ContractState.deserialize(
        Uint8Array.from(hex.match(/../g)!.map((b: string) => parseInt(b, 16))),
      );
    })();
    const committee = retiredState.maintenanceAuthority.committee.length;
    details.retiredAuthorityCommitteeSize = committee;
    details.retiredAuthorityThreshold = retiredState.maintenanceAuthority.threshold;
    if (committee !== 0) throw new Error(`authority not retired: committee=${committee}`);
    console.log(`  ✓ identical update refused (${refusal}); on-chain committee=${committee}` +
      ` threshold=${retiredState.maintenanceAuthority.threshold}, so no signature set can satisfy it`);
  }

  step('cross-arm enrolment, reverse: the jubjub device adds a k256 device');
  const k2 = K256Device.generate();
  const r3 = await s.account.addDevice(j1, k2);
  const l3 = await waitForLedger(
    () => s.account.ledgerState(),
    'auth_nonce advanced a fifth time',
    // +5: two cross-arm enrolments, the jubjub device's own gated call, and
    // the two S12 identity-entry plants. The four refused calls advance
    // nothing.
    (l) => l.auth_nonce === l0.auth_nonce + 5n,
  );
  // 6 entries: the k256 bootstrap device, j1, j2, the two identity entries
  // planted by S12, and k2. The identity entries are unusable but still
  // counted — the documented consequence of the entry-based ABI, harmless now
  // that AUTH-5 rests on the caller rather than the count.
  if (l3.device_count !== 6n) throw new Error('reverse cross-arm entry did not land');
  details.reverseCrossArmAddTx = r3.txId;
  console.log(`  accepted tx ${r3.txId}; auth_nonce ${l2.auth_nonce} -> ${l3.auth_nonce}; devices ${l3.device_count}`);

  writeEvidence({
    testId: 'AUTH-COINLESS-ARMS',
    name: 'auth-coinless',
    description:
      'Co-resident arms: k256 and jubjub seams both gate on-node; cross-arm enrolment in both directions; tampered signatures abort per arm; seam guards S12 (identity key) and S13 (self-removal) hold',
    verdict: 'PASS',
    note: 'Both in-circuit verifications gate state changes on-node: a k256 device enrolled a jubjub device and vice versa (the arm-migration path), the jubjub device authorised its own gated call through its rolling entry, and a tampered signature of either arm failed its in-circuit assert with no state change. The seam guards are exercised through their real attacks. S12, on BOTH arms: an entry for the weak key was planted on-ledger, then a genuine forgery against it was refused — the secp256k1 point at infinity, against which ECDSA needs no private key, and the JubJub identity (0,1), against which the Schnorr equation collapses to s·G == R. S13: a device was refused the removal of the post-roll entry it had just authorised with. Each refusal left auth_nonce and device_count unchanged. S14, with a positive control: the deploy-time signing key was used to build a maintenance update that removes the verifier key of the gated operation withdraw_shielded_with_k256 and inserts the permissionless deposit_unshielded key in its place, substituting a relation that verifies no signature at all for the seam, at the authority counter read from chain. Against an account deployed with retireAuthority: false that update returns SucceedEntirely, which demonstrates that a live maintenance authority sits above the seam and can replace a gate; the identical update against the default account fails, and the account state shows a maintenance authority with an empty committee at threshold 1, which no signature set can satisfy. Measured while establishing this: a bare VerifierKeyInsert over an operation that already holds a key is refused at every counter, so replacing a key requires the remove-and-insert pair, and compact-js addOrReplaceContractOperation (which emits a bare insert) cannot replace one.',
    details,
  });
});
