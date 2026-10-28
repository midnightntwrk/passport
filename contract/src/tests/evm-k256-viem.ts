// The independent check of the `evm_k256` arm against viem. viem is not a
// dependency of this package: this script loads it at run time from
// `VIEM_DIR` (the root of a viem 2.x package) or a resolvable `viem`.
// Without viem it ends in ERROR, never in PASS.
//
//   keys       viem's address and public key of a secret key == the
//              contract's evm_address == the client's; EIP-55 forms
//              agree
//   blind      viem's hashMessage == the client's EIP-191 digest; viem's
//              signMessage == the software wallet's personal_sign, byte for
//              byte (both RFC 6979, low S); viem recovers the address and the
//              public point; viem's sha256 of the blind preimage == the blind
//              (enrolment and the contract's derive_blind)
//   domain     the frozen file's fixed V1 domain: viem's keccak256 of the
//              type string, the name, the version and P's text, and viem's
//              hashDomain, equal the pinned type hash, string hashes, P and
//              separator, and so do the contract's oracles; viem's keccak256
//              of every frozen type string equals its pinned type hash
//   frozen     every vector of the frozen file: viem's encodeType, domain
//              hash, struct hash and digest of the frozen typed data equal the
//              frozen values (which the generator took from viem); the
//              contract's pure circuits equal them too; viem's signTypedData ==
//              the software wallet's, byte for byte, and viem recovers the
//              signer
//
// Writes $EVIDENCE_DIR/evm-k256-viem.json when EVIDENCE_DIR is set.

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pureCircuits } from '../wallet/contract.js';
import { contractStructHash, typedDataOf, VECTOR_FILE, BLIND_TAG_TEXT } from './evm-k256-vectors.js';
import { typeString, toHex as hx } from '../wallet/evm-k256-codec.js';
import { evmK256KeyHint } from '../wallet/evm-k256-hints.js';
import { evmChecksumAddress, padTag } from '../wallet/descriptors.js';
import { blindMessageBytes } from '../wallet/blind.js';
import {
  SoftwareEvmWallet, enrolEvmBlind, personalMessageDigest, SECP256K1_ORDER,
} from '../wallet/signer-evm-k256.js';

let viem: any, accounts: any, typed: any, viemVersion: string;
try {
  const root = process.env.VIEM_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.resolve('viem'))), '..', '..');
  viem = await import(pathToFileURL(path.join(root, '_esm/index.js')).href);
  accounts = await import(pathToFileURL(path.join(root, '_esm/accounts/index.js')).href);
  typed = await import(pathToFileURL(path.join(root, '_esm/utils/signature/hashTypedData.js')).href);
  viemVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
} catch (e: any) {
  console.error(`◆ evm-k256-viem: ERROR — viem is not available (${e?.message ?? e}); set VIEM_DIR to a viem 2.x package root`);
  process.exit(2);
}
const bytesHex = (b: Uint8Array) => '0x' + Buffer.from(b).toString('hex');
const SEED = 'evm-k256-viem/v1';
let ctr = 0;
const rnd = (n: number): Uint8Array => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 32) out.set(createHash('sha256').update(SEED).update(String(ctr++)).digest().subarray(0, Math.min(32, n - i)), i);
  return out;
};
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const beInt = (b: Uint8Array) => { let v = 0n; for (const x of b) v = (v << 8n) | BigInt(x); return v; };
const scalar = () => { for (;;) { const k = beInt(rnd(32)); if (k > 0n && k < SECP256K1_ORDER) return k; } };
const sk32 = (k: bigint) => '0x' + k.toString(16).padStart(64, '0');
const pointHex = (pk: { x: bigint; y: bigint }) => '0x04' + pk.x.toString(16).padStart(64, '0') + pk.y.toString(16).padStart(64, '0');
const pc = pureCircuits as any;

const checks: Record<string, number> = {};
const ok = (k: string, n = 1) => { checks[k] = (checks[k] ?? 0) + n; };
const vectors: unknown[] = [];

// ── Keys ─────────────────────────────────────────────────────────────────────
for (const k of [1n, 2n, SECP256K1_ORDER - 1n, ...Array.from({ length: 13 }, scalar)]) {
  const w = accounts.privateKeyToAccount(sk32(k));
  const ours = new SoftwareEvmWallet(k);
  const pt = pc.compute_public_point_with_evm_k256(k);
  const contractAddr = pc.evm_address(pt, evmK256KeyHint(pt));
  assert.equal(evmChecksumAddress(contractAddr), w.address, 'contract address == viem');
  assert.equal(evmChecksumAddress(ours.addressBytes), w.address, 'client address == viem');
  assert.equal(viem.getAddress(w.address.toLowerCase()), evmChecksumAddress(ours.addressBytes), 'EIP-55 == viem');
  assert.equal(w.publicKey, pointHex(ours.pk), 'point == viem');
  ok('keys', 4);
}
console.log(`  ✓ keys: addresses, EIP-55 forms and points == viem (${checks.keys} checks)`);

// ── Blind (personal_sign) ────────────────────────────────────────────────────
const blindTag = padTag(BLIND_TAG_TEXT);
for (const [k, network, index] of [[1n, 'undeployed', 0], [1n, 'undeployed', 1], [1n, 'preview', 0], [scalar(), 'mainnet', 7], [scalar(), 'preprod', 4294967295]] as [bigint, string, number][]) {
  const w = accounts.privateKeyToAccount(sk32(k));
  const ours = new SoftwareEvmWallet(k);
  const msg = blindMessageBytes({ scheme: 'evm_k256', network, identity: ours.addressBytes, accountIndex: index });
  const digest = viem.hashMessage({ raw: msg });
  assert.equal(digest, bytesHex(personalMessageDigest(msg)), 'EIP-191 digest == viem.hashMessage');
  const theirs = await w.signMessage({ message: { raw: msg } });
  const mine = await ours.personalSign(msg);
  assert.equal(theirs, bytesHex(mine), 'personal_sign == viem signMessage, byte for byte');
  assert.equal(await viem.recoverMessageAddress({ message: { raw: msg }, signature: theirs }), w.address, 'viem recovers the address');
  const e = await enrolEvmBlind(ours, network, index);
  assert.equal(await viem.recoverPublicKey({ hash: digest, signature: theirs }), pointHex(e.pk), 'recovered point == viem');
  const sig = viem.parseSignature(theirs);
  const canonical = viem.toBytes(viem.concat([sig.r, sig.s]));
  assert.equal(hex(canonical), hex(e.canonical), 'canonical low-S r || s == viem (viem signs low-S)');
  const blind = viem.sha256(viem.concat([bytesHex(blindTag), bytesHex(canonical)]));
  assert.equal(blind, bytesHex(e.blind), 'blind == viem.sha256 of the preimage');
  assert.equal(blind, bytesHex(pc.derive_blind(blindTag, canonical)), 'blind == the contract');
  vectors.push({ scalar: k === 1n ? '1' : 'seeded', address: w.address, network, accountIndex: String(index), eip191Digest: digest, signature: theirs, blind });
  ok('blind', 7);
}
console.log(`  ✓ blind: EIP-191 digest, personal_sign bytes, recovery, canonical form and blind == viem (${checks.blind} checks)`);

// ── The fixed V1 domain ──────────────────────────────────────────────────────
const FROZEN = JSON.parse(fs.readFileSync(new URL(`./vectors/${VECTOR_FILE}`, import.meta.url), 'utf8'));
{
  const D = FROZEN.domain;
  const k = (t: string) => viem.keccak256(viem.stringToHex(t));
  const domain = { name: D.name, version: D.version, verifyingContract: D.verifyingContract };
  const fields = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'verifyingContract', type: 'address' }];
  assert.equal(typed.encodeType({ primaryType: 'EIP712Domain', types: { EIP712Domain: fields } }), D.typeString, 'domain: viem encodeType');
  assert.equal(k(D.typeString), D.typeHash, 'domain: viem keccak256 of the type string');
  assert.equal(k(D.name), D.nameHash, 'domain: viem keccak256 of the name');
  assert.equal(k(D.version), D.versionHash, 'domain: viem keccak256 of the version');
  assert.equal(viem.getAddress(viem.slice(k(D.verifyingContractText), 12)), D.verifyingContract, "domain: P from viem's keccak256 of its text");
  assert.equal(viem.hashDomain({ domain, types: { EIP712Domain: fields } }), D.separator, 'domain: viem hashDomain');
  assert.equal(bytesHex(pc.eip712_v1_domain_type_hash()), D.typeHash, 'domain: the contract type hash');
  assert.equal(bytesHex(pc.eip712_v1_name_hash()), D.nameHash, 'domain: the contract name hash');
  assert.equal(bytesHex(pc.eip712_v1_version_hash()), D.versionHash, 'domain: the contract version hash');
  assert.equal(viem.getAddress(bytesHex(pc.eip712_v1_verifying_contract())), D.verifyingContract, 'domain: the contract P');
  assert.equal(bytesHex(pc.eip712_v1_domain_separator()), D.separator, 'domain: the contract separator');
  ok('domain', 11);
  for (const [key, str] of Object.entries(FROZEN.typeStrings as Record<string, string>)) {
    assert.equal(k(str), FROZEN.typeHashes[key], `${key}: viem keccak256 of the type string == the pinned type hash`);
    ok('domain');
  }
}
console.log(`  ✓ domain: the pinned type hash, name and version hashes, P and separator == viem and == the contract's oracles; ${Object.keys(FROZEN.typeHashes).length} type hashes == viem (${checks.domain} checks)`);

// ── Frozen EIP-712 vectors ───────────────────────────────────────────────────
{
  const signer = accounts.privateKeyToAccount(sk32(0x5eedn));
  const ours = new SoftwareEvmWallet(0x5eedn);
  for (const v of FROZEN.vectors) {
    const { domain, types, primaryType, message } = v.typedData;
    const { EIP712Domain, ...structTypes } = types;
    assert.equal(typed.encodeType({ primaryType, types: structTypes }), v.encodeType, `${v.name}: encodeType`);
    assert.equal(viem.hashDomain({ domain, types: { EIP712Domain } }), v.domainSeparator, `${v.name}: domain`);
    assert.equal(viem.hashStruct({ data: message, primaryType, types: structTypes }), v.structHash, `${v.name}: struct hash`);
    assert.equal(viem.hashTypedData({ domain, types, primaryType, message }), v.digest, `${v.name}: digest`);
    const { typedData, encodeType, domainSeparator, structHash, digest, ...input } = v;
    assert.deepEqual(JSON.parse(JSON.stringify(typedDataOf(input))), v.typedData, `${v.name}: the client rebuilds the typed data`);
    assert.equal(hx(contractStructHash(pc, input)), v.structHash, `${v.name}: contract struct hash`);
    const theirs = await signer.signTypedData({ domain, types, primaryType, message });
    const mine = await ours.signTypedData(v.typedData);
    assert.equal(theirs, bytesHex(mine), `${v.name}: signTypedData == viem, byte for byte`);
    assert.equal(await viem.recoverTypedDataAddress({ domain, types, primaryType, message, signature: theirs }), signer.address, `${v.name}: viem recovers the signer`);
    ok('frozen', 8);
  }
  for (const [k, str] of Object.entries(FROZEN.typeStrings as Record<string, string>)) {
    const [p, n] = k.split('/');
    assert.equal(typeString(p, n), str);
    ok('frozen');
  }
}
console.log(`  ✓ frozen: ${FROZEN.vectors.length} vectors and ${Object.keys(FROZEN.typeStrings).length} type strings == viem; contract and client agree; signTypedData == viem (${checks.frozen} checks)`);

const report = { suite: 'evm-k256-viem', viemVersion, seed: SEED, vectorFile: VECTOR_FILE, ranAt: new Date().toISOString(), checks, vectors, verdict: 'PASS' };
if (process.env.EVIDENCE_DIR) {
  const file = path.join(process.env.EVIDENCE_DIR, 'evm-k256-viem.json');
  fs.mkdirSync(process.env.EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  console.log(`\n■ evidence → ${file}`);
}
console.log(`\n◆ evm-k256-viem: PASS (viem ${viemVersion})`);
