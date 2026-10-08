// These tests drive the compiled Compact runtime with replaceable, adversarial
// witnesses. They are execution evidence, not a generated/verified ZK proof.
import { strict as assert } from 'node:assert';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  createCircuitContext, createConstructorContext, sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { proofDataIntoSerializedPreimage } from '@midnightntwrk/ledger-v9';
import { Contract, pureCircuits } from '../../../contracts/managed/probe-webauthn-variable/contract/index.js';
import { parseES256Signature } from '../../wallet/webauthn.js';
import { inspectJSON, padded, splitWord, witnesses } from './witnesses.js';

const output = new URL('../../../evidence/webauthn-variable-json/', import.meta.url);
mkdirSync(output, { recursive: true });
const sha = (x: Uint8Array | string) => new Uint8Array(createHash('sha256').update(x).digest());
const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const challenge = sha('witness-assisted variable-length WebAuthn experiment');
const rpHash = sha('example.test');
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = publicKey.export({ format: 'jwk' });
const pk = { x: BigInt('0x' + Buffer.from(jwk.x!, 'base64url').toString('hex')),
  y: BigInt('0x' + Buffer.from(jwk.y!, 'base64url').toString('hex')), identity: false };
const auth = new Uint8Array([...rpHash, 5, 0, 0, 0, 0]);
const client = (origin: string, extra = '') => utf8(
  `{"type":"webauthn.get","challenge":"${Buffer.from(challenge).toString('base64url')}","origin":"${origin}","crossOrigin":false${extra}}`,
);
const signature = (data: Uint8Array, authenticatorData = auth) =>
  parseES256Signature(new Uint8Array(sign('sha256', Buffer.concat([authenticatorData, sha(data)]), privateKey)));
const policy = (origin: string, key = pk, rp = rpHash) =>
  pureCircuits.policy_commitment(rp, padded(utf8(origin), 96), BigInt(utf8(origin).length), key);

type Run = { name: string; result: 'PASS'; milliseconds: number };
const runs: Run[] = [];
const observed: unknown[] = [];
const suite = process.argv[2] ?? 'all';
assert.ok(['all', 'sha256', 'webauthn'].includes(suite), 'suite must be all, sha256, or webauthn');
const selectedTests: string[] = [];
let wordCalls = 0;
const countedWitnesses = {
  ...witnesses,
  split_word: (context: any, value: bigint) => { wordCalls++; return witnesses.split_word(context, value); },
};
async function harness(origin = 'https://example.test', limited = false, overrides: any = {}, expected = challenge, key = pk, rp = rpHash) {
  const contract = new Contract<any>({ ...countedWitnesses, ...overrides } as any);
  const address = sampleContractAddress();
  const coinPk = { bytes: new Uint8Array(32) };
  const initial = await contract.initialState(createConstructorContext({}, coinPk), expected, policy(origin, key, rp), limited);
  let state = initial.currentContractState;
  return async (name: 'hash_bytes' | 'verify_webauthn', ...args: any[]) => {
    const ctx = createCircuitContext({ circuitId: name, contractAddress: address,
      coinPublicKeyOrZswapState: coinPk, contractState: state, privateState: {} });
    const result = await (contract.impureCircuits[name] as any)(ctx, ...args);
    state = result.context.callContext.currentQueryContext.state;
    return result;
  };
}
async function test(name: string, f: () => Promise<void>) {
  const group = name.startsWith('SHA-256:') ? 'sha256' : 'webauthn';
  if (suite !== 'all' && suite !== group) return;
  selectedTests.push(name);
  const start = performance.now(); await f();
  runs.push({ name, result: 'PASS', milliseconds: performance.now() - start });
  console.log('PASS', name);
}
const adviceFor = (origin: string) => ({ origin: padded(utf8(origin), 96),
  origin_length: BigInt(utf8(origin).length), prefix_length: 112n + BigInt(utf8(origin).length) });
const fakeParser = (advice: ReturnType<typeof adviceFor>) => ({ inspect_json: ({ privateState }: any) => [privateState, advice] });
const verifyArgs = (bytes: Uint8Array, data = auth) => [padded(bytes, 256), BigInt(bytes.length), rpHash, data, signature(bytes, data), pk];

async function main() {
  await test('SHA-256: every length 0..256 matches independent Node/OpenSSL', async () => {
    const call = await harness();
    for (let length = 0; length <= 256; length++) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 137 + length * 13) & 255);
      const result = await call('hash_bytes', padded(bytes, 256), BigInt(length));
      assert.deepEqual(result.result, sha(bytes), `length ${length}`);
    }
  });
  await test('SHA-256: zero messages and padding boundaries', async () => {
    const call = await harness();
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 183, 184, 191, 192, 247, 248, 255, 256]) {
      assert.deepEqual((await call('hash_bytes', new Uint8Array(256), BigInt(length))).result, sha(new Uint8Array(length)));
    }
  });
  await test('SHA-256: dishonest length, nonzero tail and oversized input rejected', async () => {
    const call = await harness();
    const bytes = padded(utf8('abc'), 256);
    await assert.rejects(() => call('hash_bytes', bytes, 2n), /nonzero buffer tail/);
    await assert.rejects(() => call('hash_bytes', bytes, 257n), /capacity/);
    assert.notDeepEqual((await call('hash_bytes', bytes, 4n)).result, sha(utf8('abc')));
  });
  for (const mutation of ['bit', 'carry']) {
    await test(`SHA-256: malicious ${mutation} witness rejected`, async () => {
      const call = await harness(undefined, false, {
        split_word: ({ privateState }: any, value: bigint) => {
          const hint = splitWord(value);
          if (mutation === 'bit') hint.bits[0] = !hint.bits[0]; else hint.carry ^= 1n;
          return [privateState, hint];
        },
      });
      await assert.rejects(() => call('hash_bytes', padded(utf8('abc'), 256), 3n), /dishonest SHA/);
    });
  }
  await test('strict WebAuthn: varying origin lengths under one circuit', async () => {
    const origins = ['https://a.test', 'http://localhost:8973', 'https://wallet.example.test',
      'https://' + 'a'.repeat(48) + '.example.test',
      'https://' + 'a'.repeat(60) + '.' + 'b'.repeat(14) + '.example.test'];
    for (const origin of origins) {
      const bytes = client(origin), call = await harness(origin);
      const start = wordCalls;
      const result = await call('verify_webauthn', ...verifyArgs(bytes));
      observed.push({ originBytes: utf8(origin).length, clientBytes: bytes.length, splitWordCalls: wordCalls - start });
      // Save one proving preimage for an optional, separate proof-server run.
      if (origin === origins[2]) {
        const proofData = result.context.callProofDataTrace.at(-1);
        assert.ok(proofData);
        writeFileSync(new URL('verify.preimage', output), proofDataIntoSerializedPreimage(
          proofData.input, proofData.output, proofData.publicTranscript, proofData.privateTranscriptOutputs, 'verify_webauthn',
        ));
      }
    }
  });
  await test('captured real Safari wa-json134 assertion accepted by new circuit', async () => {
    const v = JSON.parse(readFileSync(new URL('../../../../experiments/p256-in-circuit/webauthn/vector.json', import.meta.url), 'utf8'));
    const bytes = new Uint8Array(Buffer.from(v.client_data_json_b64url, 'base64url'));
    const origin = JSON.parse(Buffer.from(bytes).toString()).origin;
    const key = { x: BigInt('0x' + v.pk_x_hex), y: BigInt('0x' + v.pk_y_hex), identity: false };
    const data = hex(v.authenticator_data_hex), rp = data.slice(0, 32);
    const call = await harness(origin, false, {}, hex(v.challenge_hex), key, rp);
    await call('verify_webauthn', padded(bytes, 256), BigInt(bytes.length), rp, data, parseES256Signature(hex(v.signature_der_hex)), key);
  });
  const origin = 'https://example.test', good = client(origin), goodAdvice = adviceFor(origin);
  await test('malicious JSON witness cannot invent origin or prefix length', async () => {
    for (const [hint, expectedError] of [
      [{ ...goodAdvice, prefix_length: goodAdvice.prefix_length + 1n }, /dishonest prefix length/],
      [{ ...goodAdvice, origin_length: 97n }, /origin length out of range/],
      [adviceFor('https://invalid.test'), /unknown key or origin policy/],
    ] as const) {
      const call = await harness(origin, false, fakeParser(hint));
      await assert.rejects(() => call('verify_webauthn', ...verifyArgs(good)), expectedError);
    }
  });
  await test('resigned bad JSON rejected even when JSON witness returns good advice', async () => {
    const text = Buffer.from(good).toString();
    const cases = [
      text.replace('webauthn.get', 'webauthn.bad'), text.replace('false', 'true'),
      text.replace(origin, 'https://attacker.test'),
      text.replace(Buffer.from(challenge).toString('base64url'), Buffer.from(sha('wrong challenge')).toString('base64url')),
      text.replace('"type":', '"type":"evil","type":'),
      '{ ' + text.slice(1), text.slice(0, -1) + ',"extra":1}', text.slice(0, -1),
    ];
    for (const text of cases) {
      const call = await harness(origin, false, fakeParser(goodAdvice));
      await assert.rejects(() => call('verify_webauthn', ...verifyArgs(utf8(text))), /mismatch|envelope|truncated/);
    }
  });
  await test('length is bound to the raw signed message, not just a witness claim', async () => {
    const call = await harness(origin, true, fakeParser(goodAdvice));
    const args = verifyArgs(client(origin, ',"extra":123'));
    args[1] = (args[1] as bigint) + 1n; // Adds a real zero byte to the SHA input.
    await assert.rejects(() => call('verify_webauthn', ...args), /invalid WebAuthn signature/);
  });
  await test('policy, RP hash, flags and signature independently enforced', async () => {
    const call = await harness(origin, false, fakeParser(goodAdvice));
    const wrongRP = new Uint8Array(auth); wrongRP[0] ^= 1;
    await assert.rejects(() => call('verify_webauthn', ...verifyArgs(good, wrongRP)), /RP hash mismatch/);
    for (const flags of [0, 1, 4, 21, 133]) {
      const data = new Uint8Array(auth); data[32] = flags;
      await assert.rejects(() => call('verify_webauthn', ...verifyArgs(good, data)), /flags/);
    }
    const args = verifyArgs(good); args[4] = { r: 1n, s: 1n };
    await assert.rejects(() => call('verify_webauthn', ...args), /invalid WebAuthn signature/);
  });
  await test('limited verifier: extra fields and SHA block boundaries accepted', async () => {
    const call = await harness(origin, true);
    for (const target of [183, 184, 191, 192, 247, 248, 255, 256]) {
      const empty = client(origin, ',"extra":""');
      const bytes = client(origin, ',"extra":"' + 'x'.repeat(target - empty.length) + '"');
      assert.equal(bytes.length, target);
      await call('verify_webauthn', ...verifyArgs(bytes));
    }
  });
  await test('limited verifier hashes unknown fields: suffix substitution rejected', async () => {
    const a = client(origin, ',"extra":"a"'), b = client(origin, ',"extra":"b"');
    const call = await harness(origin, true);
    await assert.rejects(() => call('verify_webauthn', padded(b, 256), BigInt(b.length), rpHash, auth, signature(a), pk), /invalid WebAuthn signature/);
  });
  await test('evidence boundary: JSON.parse alone is not enforced by limited mode', async () => {
    const malformed = utf8(Buffer.from(good).toString().slice(0, -1) + ',NOT_JSON');
    assert.throws(() => inspectJSON(padded(malformed, 256), BigInt(malformed.length)));
    // A forged hint bypasses JSON.parse. The standards-defined limited verifier
    // deliberately verifies only the required prefix and the signed full hash.
    const limited = await harness(origin, true, fakeParser(goodAdvice));
    await limited('verify_webauthn', ...verifyArgs(malformed));
    const strict = await harness(origin, false, fakeParser(goodAdvice));
    await assert.rejects(() => strict('verify_webauthn', ...verifyArgs(malformed)), /strict mode/);
  });
}

const sources = Object.fromEntries([
  'contracts/probe-webauthn-variable.compact', 'contracts/webauthn.compact',
  'src/tests/webauthn-variable/offline.ts', 'src/tests/webauthn-variable/witnesses.ts',
].map(file => [file, Buffer.from(sha(readFileSync(new URL('../../../' + file, import.meta.url)))).toString('hex')]));
const startedAt = new Date().toISOString();
let failure: string | undefined;
try { await main(); } catch (error) { failure = error instanceof Error ? error.stack ?? error.message : String(error); }
const reportName = suite === 'all' ? 'offline.json' : `offline-${suite}.json`;
writeFileSync(new URL(reportName, output), JSON.stringify({
  result: failure ? 'FAIL' : 'PASS', startedAt, completedAt: new Date().toISOString(),
  suite, selectedTests,
  baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  compiler: '0.35.0', runtime: '0.20.0', capacityBytes: 256, originCapacityBytes: 96,
  evidenceLayer: 'compiled Compact execution with adversarial witness substitution; no ZK proof or on-node call',
  realBrowserEvidence: 'replayed existing Safari 134-byte assertion; new lengths use software ES256',
  sources, observed, tests: runs, failure,
}, null, 2) + '\n');
if (failure) throw new Error(failure);
console.log(`PASS: ${runs.length} ${suite} groups; results in evidence/webauthn-variable-json/${reportName}`);
