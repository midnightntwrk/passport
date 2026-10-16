// Characterize current client import behavior. No contract changes, network,
// proofs or signature-forgery claims; acceptance includes known validation gaps.
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { generateEncKeyPair, sealInboxEntry, openInboxEntry } from '../wallet/inbox.js';
import { hexToBytes } from '../wallet/hex.js';
import { K256Device, K256Grantee } from '../wallet/signer.js';

type Row = { boundary: string; input: string; accepted: boolean; expectedAccepted: boolean; detail: string };
const rows: Row[] = [];
function accepts<T>(boundary: string, input: string, action: () => T, verify: (value: T) => void, detail: string) {
  // Positive assertions intentionally propagate; they cannot count as rejection.
  const value = action();
  verify(value);
  rows.push({ boundary, input, accepted: true, expectedAccepted: true, detail });
  console.log(`PASS ${boundary}: ${input}: accepted`);
  return value;
}
function rejects(boundary: string, input: string, action: () => unknown, pattern: RegExp) {
  // Catch only the API call; expectation assertions remain outside the catch.
  let thrown: unknown;
  let didThrow = false;
  try { action(); } catch (error) { didThrow = true; thrown = error; }
  assert(didThrow, `${boundary}: ${input}: unexpectedly accepted`);
  const detail = String(thrown);
  assert.match(detail, pattern);
  rows.push({ boundary, input, accepted: false, expectedAccepted: false, detail });
  console.log(`PASS ${boundary}: ${input}: rejected`);
}

const pair = generateEncKeyPair();
const coin = { nonce: new Uint8Array(32), color: new Uint8Array(32), value: 42n };
const normal = accepts('X25519 sealing', '32-byte generated recipient',
  () => sealInboxEntry(pair.publicKey, coin),
  entry => assert.deepEqual(openInboxEntry(pair.secretKey, entry), coin),
  'Generated recipient and original secret round-trip the complete coin.');
rejects('X25519 sealing', '31-byte truncated recipient',
  () => sealInboxEntry(pair.publicKey.slice(0, 31), coin), /Failed to read asymmetric key|asn1|decode|header|length/i);
accepts('X25519 sealing', '33-byte recipient with trailing 0x63',
  () => sealInboxEntry(new Uint8Array([...pair.publicKey, 99]), coin),
  entry => assert.deepEqual(openInboxEntry(pair.secretKey, entry), coin),
  'Trailing byte is ignored by DER import; original 32-byte secret decrypts.');
accepts('X25519 opening', '33-byte secret with trailing 0x63',
  () => openInboxEntry(new Uint8Array([...pair.secretKey, 99]), normal),
  decoded => assert.deepEqual(decoded, coin),
  'Trailing secret byte is ignored by DER import.');
// Opening is a total reader: malformed material returns null instead of throwing.
accepts('X25519 opening', '31-byte truncated secret returns null',
  () => openInboxEntry(pair.secretKey.slice(0, 31), normal),
  decoded => assert.equal(decoded, null), 'Invalid secret is skipped.');
accepts('X25519 opening', 'unrelated generated secret returns null',
  () => openInboxEntry(generateEncKeyPair().secretKey, normal),
  decoded => assert.equal(decoded, null), 'Independent-key authentication control.');

for (const [input, expected] of [
  ['00a1ff', [0, 161, 255]], ['0x00a1ff', [0, 161, 255]],
  ['zz', [0]], ['1z', [1]], ['z1', [0]],
] as const) {
  accepts('hex import', input, () => hexToBytes(input),
    decoded => assert.deepEqual([...decoded], [...expected]),
    `Current decoded bytes: ${JSON.stringify(expected)}; malformed cases characterize permissive parsing.`);
}
rejects('hex import', 'odd-length abc', () => hexToBytes('abc'), /odd-length hex/);

const address = new Uint8Array(32).fill(31);
for (const Signer of [K256Device, K256Grantee]) {
  const zero = accepts('secp256k1 secret import', `${Signer.name}: zero`,
    () => new Signer(0n), signer => assert.deepEqual(signer.pk, { x: 0n, y: 0n, identity: true }),
    'Constructor accepts zero and produces flagged identity.');
  const entry = (signer: K256Device | K256Grantee) => signer instanceof K256Device
    ? signer.entryAt(address, 0n, 0n) : signer.grantId(address, new Uint8Array(32), 0n);
  rejects('secp256k1 commitment derivation', `${Signer.name}: identity`,
    () => entry(zero), /cannot extract|identity/i);
  accepts('secp256k1 commitment derivation', `${Signer.name}: valid scalar 5`,
    () => entry(new Signer(5n)), bytes => assert.equal(bytes.length, 32),
    'Valid nonzero-secret commitment control succeeds.');
}

const root = new URL('../../', import.meta.url);
const sha = (path: string) => createHash('sha256').update(readFileSync(new URL(path, root))).digest('hex');
const evidence = new URL('evidence/ecc-validation/', root);
mkdirSync(evidence, { recursive: true });
writeFileSync(new URL('import-boundaries.json', evidence), JSON.stringify({
  completed: true, runAt: new Date().toISOString(), node: process.version,
  scope: 'Current reference client import characterization with valid controls. No contract changes, proofs, live node, browser-wallet or authorization-bypass claims. Reader null results are marked as accepted API calls, not accepted malformed credentials.',
  sourceSha256: Object.fromEntries([
    'src/tests/ecc-import-boundaries.ts', 'src/wallet/inbox.ts', 'src/wallet/hex.ts',
    'src/wallet/signer.ts', 'src/wallet/contract.ts', 'contracts/account.compact',
    'contracts/account-p256.compact', 'contracts/webauthn.compact',
  ].map(path => [path, sha(path)])),
  generatedSha256: sha('contracts/managed/account/contract/index.js'),
  lockfileSha256: sha('package-lock.json'), rows,
}, null, 2) + '\n');
console.log(`Import boundary checks complete: ${rows.length}/${rows.length} expectations matched.`);
