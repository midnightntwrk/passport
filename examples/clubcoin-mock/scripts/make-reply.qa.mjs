/* Build a REAL signed callback reply for the live browser session's state. */
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { signData, signatureVerifyingKey, addressFromKey } from '@midnight-ntwrk/ledger-v8';
import { UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';

const here = '/Users/utkarshvarma/lab/midnight-passport-dynamic-signing/examples/clubcoin-mock/scripts';
async function bundle(entry, name) {
  const out = path.join(tmpdir(), `${name}-${Date.now()}.mjs`);
  await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: out });
  return import(pathToFileURL(out).href);
}
const passport = await bundle(path.resolve(here, '../../passport-demo/src/identity/callbackProtocol.ts'), 'passport');

const NETWORK_ID = 'preview';
const secretKey = Buffer.alloc(32, 42).toString('hex');
const verifyingKey = signatureVerifyingKey(secretKey);
const unshielded = UnshieldedAddress.codec
  .encode(NETWORK_ID, new UnshieldedAddress(Buffer.from(addressFromKey(verifyingKey), 'hex')))
  .asString();
const signer = { publicKey: verifyingKey, sign: (bytes) => signData(secretKey, bytes) };

const [callback, fields, state] = process.argv.slice(2);
const parse = passport.parsePassportCallbackLaunch(
  `?passportCallback=${encodeURIComponent(callback)}&passportFields=${fields}&passportState=${state}`,
);
if (parse.kind !== 'ok') throw new Error(JSON.stringify(parse));
const profile = passport.selectPassportCallbackProfile(parse.launch.fields, {
  displayName: 'qa-drill.night',
  passportContract: null,
  midnightAddresses: { unshielded, shielded: null, dust: null },
});
const built = passport.buildPassportCallbackPayload({ launch: parse.launch, profile, now: Date.now() });
const envelope = passport.sealPassportCallbackResponse(built.encoded, built.bytes, signer);
console.log(passport.passportCallbackSuccessUrl(parse.launch, envelope));
