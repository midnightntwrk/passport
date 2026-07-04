// The GUARDIAN PASSPORT side of the demo — run this in a second terminal.
//
//   npm run demo:guardian -- <request-string>
//
// Paste the buss-req.v0.… string the key-owner gives you; get back the
// buss-sig.v0.… reply to paste into their terminal. Works for both the
// backup ceremony and recovery, because σ is deterministic per (session,
// guardian key): this guardian stores NOTHING except its own device secret
// (guardian-identity.json, created on first run).
//
// Note what is absent: no chain connection, no share storage, no state
// updates. The guardian can answer from a plane.

import {
  decodeGuardianRequest,
  encodeGuardianReply,
  computeSigma,
  guardianSkFromDeviceSecret,
} from '../wallet/buss.js';
import { loadOrCreateGuardianDeviceSecret } from './common.js';

const requestString = process.argv[2];
if (!requestString) {
  console.error('usage: npm run demo:guardian -- <buss-req.v0.…>');
  process.exit(1);
}

const request = decodeGuardianRequest(requestString);
const guardianSk = guardianSkFromDeviceSecret(loadOrCreateGuardianDeviceSecret());
const reply = computeSigma(request, guardianSk);

console.log('');
console.log(`request from  ${request.address.slice(0, 20)}… (guardian index ${request.index})`);
console.log('');
console.log('give this back to the key-owner:');
console.log('');
console.log(`  ${encodeGuardianReply(reply)}`);
console.log('');
