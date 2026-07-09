// Demo step 2 — total-loss recovery: rebuild the recovery secret from the
// on-chain φ plus a quorum of guardian replies and paper keys, then take
// the account over with a brand-new device.
//
//   npm run demo:recover -- --address <contract> --guardians 3
//
// (--address defaults to owner-identity.json to keep the demo one-machine,
// but note the point of the exercise: the recovering party needs NO prior
// state beyond the address, the guardian count, and a t+1 quorum.)
//
// For a passport guardian: the script prints the request string to hand
// them (rebuilt purely from on-chain session data); paste their reply.
// For a paper key: paste the buss-paper.v0.… slip.

import { setupWallet, connectAccount } from '../node/setup.js';
import { bytesToHex, hexToBytes, randomBytes32 } from '../wallet/hex.js';
import { recoveryCommitment } from '../wallet/contract.js';
import { waitForLedger } from '../tests/runner.js';
import {
  newRecoverySecret,
  paperSigma,
  reconstructRecoverySecret,
  paramsFromPhi,
  encodeGuardianRequest,
  decodeGuardianReply,
  decodePaperKey,
  type GuardianReply,
} from '../wallet/buss.js';
import {
  loadEnv,
  saveOwnerIdentity,
  withPrompt,
  argValue,
  done,
  OWNER_IDENTITY_FILE,
} from './common.js';
import * as fs from 'node:fs';

loadEnv();

const addressArg = argValue('--address', '');
const address =
  addressArg ||
  (fs.existsSync(OWNER_IDENTITY_FILE)
    ? JSON.parse(fs.readFileSync(OWNER_IDENTITY_FILE, 'utf-8')).address
    : '');
if (!address) throw new Error('pass --address <contract> (no owner-identity.json found)');

const guardians = Number(argValue('--guardians', '3'));

const ctx = await setupWallet();

// Everything below starts from PUBLIC state: φ, session nonce, commitment.
const reader = await connectAccount(ctx, address, {});
const l = await reader.ledgerState();
const phiLen = Number(l.recovery_phi_len);
if (phiLen === 0) throw new Error('no recovery backup published on this account');
const phi = Array.from({ length: phiLen }, (_, i) => l.recovery_phi.lookup(BigInt(i + 1)));
const sessionHex = bytesToHex(l.recovery_session);
const params = paramsFromPhi(phiLen, guardians);
const threshold = params.t + 1;

console.log('');
console.log(`account ${address.slice(0, 20)}…`);
console.log(`on-chain backup: φ length ${phiLen}, ${guardians} guardians → need ${threshold} of them.`);

const quorum: GuardianReply[] = await withPrompt(async (ask) => {
  const collected: GuardianReply[] = [];
  while (collected.length < threshold) {
    console.log('');
    const kind = (
      await ask(`quorum ${collected.length}/${threshold} — add [g]uardian or [p]aper key? `)
    ).trim();
    if (kind === 'g') {
      const index = Number(await ask('  guardian index: '));
      const request = encodeGuardianRequest({ address, sessionNonce: sessionHex, index });
      console.log('  hand them this request:');
      console.log(`  ${request}`);
      collected.push(decodeGuardianReply(await ask('  paste their reply: ')));
    } else if (kind === 'p') {
      const paper = decodePaperKey(await ask('  paste the paper slip (buss-paper.v0.…): '));
      collected.push(paperSigma(paper, address, sessionHex));
    } else {
      console.log('  g or p, please');
    }
  }
  return collected;
});

console.log('');
console.log('Reconstructing the recovery secret from φ + quorum…');
const reconstructed = reconstructRecoverySecret(phi, quorum, params);
if (recoveryCommitment(reconstructed) !== l.recovery) {
  throw new Error(
    'reconstructed secret does not match the on-chain commitment — wrong quorum member or wrong guardian count?',
  );
}
console.log('✓ matches the on-chain commitment.');

console.log('');
console.log('Recovering: fresh device, rotated recovery secret, epoch bump…');
const freshDevice = randomBytes32();
const recoverer = await connectAccount(ctx, address, { recoverySecret: reconstructed });
await recoverer.recover(freshDevice, newRecoverySecret());
await waitForLedger(recoverer, 'device_epoch bumped, φ cleared', (l2) =>
  l2.device_epoch === l.device_epoch + 1n && l2.recovery_phi_len === 0n,
);

saveOwnerIdentity({ address, deviceSecretHex: bytesToHex(freshDevice) });

console.log('');
console.log('Recovered. The new device now controls the account; every old device,');
console.log('grant, and the old recovery secret are dead (epoch bump + rotation).');
console.log(`owner-identity.json updated with the fresh device secret.`);
console.log('');
console.log('The published φ was cleared — run demo:backup again to re-enrol guardians.');

await ctx.walletCtx.wallet.stop();
done();
