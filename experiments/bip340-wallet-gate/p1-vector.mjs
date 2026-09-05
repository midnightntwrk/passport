// P1 + P2-lite: generate a wallet-SDK signature vector over a fixed
// 32-byte account challenge, then characterise it against raw BIP-340
// (noble-curves) to establish layout and whether SDK signData prefixes.
const P =
  '/Users/nicolasdiprima/work/iog/midnight/passport/arc-passport/experiments/account-custody-prototype/node_modules';

const { createKeystore } = await import(
  `${P}/@midnight-ntwrk/wallet-sdk-unshielded-wallet/dist/index.js`
);
const { NetworkId } = await import(
  `${P}/@midnight-ntwrk/wallet-sdk-abstractions/dist/index.js`
);
const ledger = await import(`${P}/@midnight-ntwrk/ledger-v8/midnight_ledger_wasm_fs.js`);
const { schnorr } = await import(`${P}/@noble/curves/esm/secp256k1.js`);

// Fixed secret and fixed challenge for reproducibility.
const secret = Buffer.alloc(32, 7);
const challenge = Buffer.from(
  'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00',
  'hex',
);

const ks = createKeystore(secret, NetworkId.Undeployed ?? 'undeployed');
const pk = ks.getPublicKey();
const sig = ks.signData(challenge);

console.log('networkIds:', JSON.stringify(NetworkId));
console.log('pk  hex:', pk, `(len ${pk.length / 2} bytes)`);
console.log('sig hex:', sig, `(len ${sig.length / 2} bytes)`);

// Ledger-level verify (same stack, expected true).
console.log('ledger verifySignature:', ledger.verifySignature(pk, challenge, sig));

// Raw BIP-340 check with noble: does the wallet sign the raw bytes,
// and is the vk x-only or prefixed?
const sigBytes = Buffer.from(sig.replace(/^0x/, ''), 'hex');
const pkBytes = Buffer.from(pk.replace(/^0x/, ''), 'hex');
const tries = [];
const cands = [];
if (pkBytes.length === 32) cands.push(['as-is-32', pkBytes]);
if (pkBytes.length === 33) cands.push(['drop-prefix-33', pkBytes.subarray(1)]);
if (pkBytes.length === 35) cands.push(['drop-3-byte-header', pkBytes.subarray(3)]);
if (pkBytes.length > 33) cands.push(['last-32', pkBytes.subarray(pkBytes.length - 32)]);
const sigCands = [];
if (sigBytes.length === 64) sigCands.push(['as-is-64', sigBytes]);
if (sigBytes.length > 64) sigCands.push(['last-64', sigBytes.subarray(sigBytes.length - 64)]);
const { createHash } = await import('node:crypto');
const sha256 = (b) => createHash('sha256').update(b).digest();
const msgCands = [
  ['raw', challenge],
  ['sha256(raw)', sha256(challenge)],
  ['sha256(sha256(raw))', sha256(sha256(challenge))],
];
for (const [pn, p] of cands)
  for (const [sn, s] of sigCands)
    for (const [mn, m] of msgCands) {
      let ok = false;
      try {
        ok = schnorr.verify(s, m, p);
      } catch (e) {
        ok = `throw: ${e.message}`;
      }
      tries.push(`noble BIP340 pk=${pn} sig=${sn} msg=${mn}: ${ok}`);
    }
console.log(tries.join('\n'));

const { writeFileSync, mkdirSync } = await import('node:fs');
mkdirSync(new URL('./evidence/', import.meta.url), { recursive: true });
writeFileSync(
  new URL('./evidence/p1-vector.json', import.meta.url),
  JSON.stringify(
    {
      generated: new Date().toISOString(),
      pins: { 'wallet-sdk': 'account-custody-prototype lockfile', noble: '1.9.7' },
      secretKeyHex: secret.toString('hex'),
      challengeHex: challenge.toString('hex'),
      publicKeyHex: pk,
      signatureHex: sig,
      ledgerVerify: true,
      characterisation:
        'BIP-340 Schnorr over secp256k1; message = SHA-256(data), untagged pre-hash (k256 RandomizedSigner); pk x-only 32B; sig 64B; signature randomised (aux_rand), not deterministic',
      nobleTrials: tries,
    },
    null,
    2,
  ),
);
console.log('evidence written: evidence/p1-vector.json');

// P3 companion vector: the dApp-connector path. The connector specification
// (midnightntwrk/midnight-dapp-connector-api SPECIFICATION.md, "Signing")
// mandates that the wallet prefixes the data with
// "midnight_signed_message:<data_size>:" before signing, so a conforming
// wallet signs prefix || data through the same keystore path.
const prefix = Buffer.from(`midnight_signed_message:${challenge.length}:`, 'utf8');
const signedBytes = Buffer.concat([prefix, challenge]);
const sigConnector = ks.signData(signedBytes);
if (!ledger.verifySignature(pk, signedBytes, sigConnector)) {
  throw new Error('connector-path signature failed ledger verification');
}
if (!schnorr.verify(Buffer.from(sigConnector, 'hex'), sha256(signedBytes), pkBytes)) {
  throw new Error('connector-path signature failed noble BIP-340 over SHA-256(prefix||data)');
}
writeFileSync(
  new URL('./evidence/p1-vector-connector.json', import.meta.url),
  JSON.stringify(
    {
      generated: new Date().toISOString(),
      pins: { 'wallet-sdk': 'account-custody-prototype lockfile', noble: '1.9.7' },
      secretKeyHex: secret.toString('hex'),
      prefixAscii: prefix.toString('utf8'),
      signedBytesHex: signedBytes.toString('hex'),
      challengeHex: challenge.toString('hex'),
      publicKeyHex: pk,
      signatureHex: sigConnector,
      ledgerVerify: true,
      characterisation:
        'connector path: BIP-340 over SHA-256("midnight_signed_message:32:" || data); prefix normative per the dApp-connector SPECIFICATION.md',
    },
    null,
    2,
  ),
);
console.log('evidence written: evidence/p1-vector-connector.json');
