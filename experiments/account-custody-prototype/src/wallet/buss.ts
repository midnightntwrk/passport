// Node binding of the BUSS recovery core: loads the `nodejs` build of
// passport-buss-wasm and re-exports the same API the tests and CLI demo
// always used. Browser code binds the `bundler` build instead — see
// app/src/lib/buss.ts. All logic lives in buss-core.ts.

import { createRequire } from 'node:module';

import { makeBussApi, type BussWasm } from './buss-core.js';

const require = createRequire(import.meta.url);
const wasm: BussWasm = require('../../buss-wasm/pkg-node/passport_buss_wasm.js');

const api = makeBussApi(wasm);

export const {
  newRecoverySecret,
  newPaperKey,
  guardianSkFromDeviceSecret,
  computeSigma,
  paperSigma,
  buildPhi,
  reconstructRecoverySecret,
} = api;

export {
  sessionIdBytes,
  paramsFromPhi,
  phiFieldFromBytes,
  phiBytesFromField,
  newSessionNonce,
  encodeGuardianRequest,
  decodeGuardianRequest,
  encodeGuardianReply,
  decodeGuardianReply,
  encodePaperKey,
  decodePaperKey,
  classifyPaste,
  type GuardianRequest,
  type GuardianReply,
  type PaperKey,
  type BussParams,
} from './buss-core.js';
