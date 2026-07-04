// Demo step 1 — backup ceremony: enrol guardians and publish the BUSS
// backup on-chain. Run after demo:onboard.
//
//   npm run demo:backup                          # 1 passport guardian + 2 paper keys, any 2 recover
//   npm run demo:backup -- --people 2 --papers 1 --threshold 2
//
// For each human guardian the script prints a request string: paste it into
// the guardian's terminal (npm run demo:guardian -- <request>) and paste
// their buss-sig.v0.… reply back here. Paper keys are printed for writing
// down. The script then publishes φ plus the rotated recovery commitment
// and the session nonce in one transaction.
//
// Load-bearing rules enforced here: fresh recovery secret + fresh session
// nonce per publication; a guardian-set change means re-running this whole
// ceremony (never reuse old σ values).

import { setupWallet, connectAccount } from '../node/setup.js';
import { bytesToHex, hexToBytes } from '../wallet/hex.js';
import { waitForLedger } from '../tests/runner.js';
import {
  newRecoverySecret,
  newSessionNonce,
  newPaperKey,
  paperSigma,
  buildPhi,
  encodeGuardianRequest,
  decodeGuardianReply,
  encodePaperKey,
  type GuardianReply,
} from '../wallet/buss.js';
import { loadEnv, loadOwnerIdentity, withPrompt, argValue, done } from './common.js';

loadEnv();

const people = Number(argValue('--people', '1'));
const papers = Number(argValue('--papers', '2'));
const threshold = Number(argValue('--threshold', '2'));

const guardians = people + papers;
const n = guardians + 1;
const t = threshold - 1;
const phiLen = n - t - 1;
if (t < 0 || t >= n - 1) throw new Error(`threshold ${threshold} impossible with ${guardians} guardians`);
if (phiLen > 4) throw new Error(`φ length ${phiLen} exceeds the contract's 4 slots — raise the threshold or drop guardians`);

const identity = loadOwnerIdentity();
const ctx = await setupWallet();
const account = await connectAccount(ctx, identity.address, {
  deviceSecret: hexToBytes(identity.deviceSecretHex),
});

const rotatedSecret = newRecoverySecret();
const sessionNonce = newSessionNonce();
const nonceHex = bytesToHex(sessionNonce);

console.log('');
console.log(`Backup ceremony: ${people} passport guardian(s) + ${papers} paper key(s), any ${threshold} recover.`);

const replies: GuardianReply[] = await withPrompt(async (ask) => {
  const collected: GuardianReply[] = [];

  for (let index = 1; index <= people; index++) {
    const request = encodeGuardianRequest({
      address: identity.address,
      sessionNonce: nonceHex,
      index,
    });
    console.log('');
    console.log(`── guardian ${index}: hand them this request ──`);
    console.log(`  ${request}`);
    const replyString = await ask(`paste guardian ${index}'s reply (buss-sig.v0.…): `);
    const reply = decodeGuardianReply(replyString);
    if (reply.index !== index) {
      throw new Error(`reply is for index ${reply.index}, expected ${index}`);
    }
    collected.push(reply);
  }

  for (let index = people + 1; index <= guardians; index++) {
    const paper = newPaperKey(index);
    console.log('');
    console.log(`── paper key ${index}: WRITE THIS DOWN, then press enter ──`);
    console.log(`  ${encodePaperKey(paper)}`);
    await ask('  written down? ');
    collected.push(paperSigma(paper, identity.address, nonceHex));
  }

  return collected;
});

console.log('');
console.log('Publishing φ + rotated commitment + session nonce on-chain…');
const phi = buildPhi(rotatedSecret, replies, { t, n });
await account.publishRecoveryBackup(rotatedSecret, sessionNonce, phi);
await waitForLedger(account, `φ published (len ${phi.length})`, (l) =>
  l.recovery_phi_len === BigInt(phi.length),
);

console.log('');
console.log('Backup live. Nothing was stored anywhere except:');
console.log(`  - on-chain: ${phi.length} public φ points (${phi.length * 32} bytes), commitment, session nonce`);
console.log('  - your paper slips');
console.log(`  - each guardian passport: its own key it already had`);
console.log('');
console.log(`Remember: ${guardians} guardians, threshold ${threshold} (needed at recovery).`);
console.log('Next: npm run demo:recover — after "losing" every device.');

await ctx.walletCtx.wallet.stop();
done();
