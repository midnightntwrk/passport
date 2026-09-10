// Browser binding of the BUSS recovery core: the `bundler` build of
// passport-buss-wasm is wired straight into Vite (vite-plugin-wasm +
// top-level await handle the .wasm ESM import). All logic lives in the
// shared platform-neutral core.

import * as wasm from '../../../buss-wasm/pkg-bundler/passport_buss_wasm.js';

import { makeBussApi } from '../../../src/wallet/buss-core.js';

export const buss = makeBussApi(wasm);

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
} from '../../../src/wallet/buss-core.js';
