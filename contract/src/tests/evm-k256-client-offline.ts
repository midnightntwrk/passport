// Offline suite of the `evm_k256` client's behaviour towards the wallet
// (src/wallet/signer-evm-k256.ts, with blind.ts restoreBlind and
// checkSigner). No node, no proof server; software keys only.
//
//   format    the arm's one format: evmK256WalletFormats() is the readable
//             registry's list (eip712-v1, "EIP-712 V1"); typed data under any
//             other domain (the per-account domain, a chainId, a salt,
//             another name, version or verifyingContract, a member missing,
//             another EIP712Domain type) is refused before the wallet is
//             asked, by the device, the grantee and authorisationFrom
//   signer    the signer check at every place a signature comes back: a
//             wallet that answers with another key is refused before any
//             proof by the device and grantee approvals, authorisationFrom,
//             each of the two blind signatures of enrolment, and the call
//             facades (the account's proving surface is never reached; the
//             honest control reaches it); the refusal names the other key
//             only when the signature recovers to it (a candidate another
//             connected wallet reports), never a candidate it does not
//             recover to, the expected address or a malformed candidate;
//             signatures over another digest (another domain, a blind
//             request presented as an approval, an unrecoverable r) are
//             refused with the signer unknown
//   blind     two sessions (two wallet instances of one key) give equal
//             signatures, canonical forms and blinds, for devices (keys ×
//             networks × account indexes) and grantees (× issuing accounts),
//             each blind equal to the contract's derive_blind; the high-S
//             twin gives the same blind; a non-deterministic wallet is
//             refused after exactly two requests, before any transaction, as
//             a device, as a grantee and in a restore
//   records   device and grantee records: the format and the cached blind
//             round-trip; records of another arm, role or format, with a
//             malformed cache, a malformed point, address, index or issuing
//             account, and grantee records that carry a read seed are
//             refused before the wallet is asked; a record without its
//             cache is refused by fromRecord
//   restore   restoreEvmK256Device and restoreEvmK256Grantee: from the cache
//             (no signature asked); from the stored format when the cache is
//             lost (the blind derived again, equal to the enrolment's, from
//             a signature by the record's key, whatever address the wallet
//             reports, and checked by the caller's test); a deterministic
//             wallet of the same key with another nonce rule refused with
//             the remedy, for each role; a record without its cache and
//             without the test refused before the wallet is asked; without a
//             record (found by the caller's test; not found: the message that
//             says so and what remains, for each role); a wallet of another
//             key against a record refused, naming the key it reports
//   counters  the use-counter resolution against a ledger that rolls the
//             entry and advances auth_nonce as the circuit does: a device at
//             counter 4095 calls, its entry moves to 4096, and the next call
//             (the same device object, and a fresh one) finds it; counters
//             of 5000 and equal to auth_nonce; the known counter checked
//             first and its successor found with one more probe; a stale
//             known counter below, above and past auth_nonce falls back to
//             the scan; an entry enrolled above auth_nonce is refused until
//             its counter is given, then used; recover_cancel past 4096; an
//             uncached restore past 4096 (restoreEvmK256Device with
//             evmK256DeviceFinds, a cache-lost record, restoreEvmDevices)
//   read seed a grantee's read seed is in memory only: no grantee record
//             written in this suite holds it; a grantee restored from its
//             cached blind reads after exactly one signature of its grantee
//             request, the same read key as at enrolment, and after that,
//             for this and its other grants, with none; concurrent reads ask
//             once; two restored sessions give the same read key; a grantee
//             whose blind was derived again, or that was just enrolled, reads
//             with no signature; another key's wallet and a non-deterministic
//             one are refused after one signature, and the seed stays absent
//   requests  every wallet request of this suite: `personal_sign` only for
//             a device or grantee blind request, byte for byte,
//             `eth_signTypedData_v4` only for V1 typed data, and no other
//             method
//
// Writes $EVIDENCE_DIR/evm-k256-client-offline.json when EVIDENCE_DIR is
// set; never writes into the repository.

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { pureCircuits } from '../wallet/contract.js';
import { blindFormats, blindFormatName, blindMessageBytes, canonicalEvmSignature, granteeBlindMessageBytes, SignerMismatchError } from '../wallet/blind.js';
import { evmChecksumAddress, grantLabel, padTag } from '../wallet/descriptors.js';
import {
  eip712V1Domain, evmK256Messages, typedDataDigest, checkEip712V1TypedData, EIP712_V1_VERIFYING_CONTRACT,
  type Eip712TypedData,
} from '../wallet/evm-k256-codec.js';
import { perAccountDomain, FOREIGN_DOMAINS } from './evm-k256-domains.js';
import {
  EVM_K256_FORMAT, EvmK256Device, EvmK256Grantee, SoftwareEvmWallet, checkEvmK256Signer, enrolEvmBlind, enrolEvmGranteeBlind,
  evmK256WalletFormats, highSTwin, parseEvmSignature, personalMessageDigest, restoreEvmK256Device, restoreEvmK256Grantee,
  revokeAllGrantsWithEvmK256, rotateEncKeyWithEvmK256, serialiseEvmSignature, withdrawUnshieldedAsEvmGrantee, SECP256K1_ORDER,
  evmK256GrantReadSeed, evmK256DeviceFinds, recoverCancelWithEvmK256, resolveEvmK256Counter, restoreEvmDevices,
  appendInboxWithEvmK256, withdrawUnshieldedWithEvmK256, withdrawShieldedWithEvmK256, authoriseWithdrawShieldedToContract, addDeviceWithEvmK256,
  removeDeviceWithEvmK256, removeUnknownDeviceWithEvmK256, issueGrantWithEvmK256, revokeGrantWithEvmK256, publishRecoverySessionWithEvmK256,
  evmK256GranteeInput, evmDeviceDescriptor,
  type EvmK256Authorisation, type EvmK256GranteeRecord, type EvmK256RosterRecord, type EvmWallet,
} from '../wallet/signer-evm-k256.js';

const SEED = 'evm-k256-client-offline/v1';
let ctr = 0;
const rnd = (n = 32): Uint8Array => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 32) out.set(createHash('sha256').update(SEED).update(String(ctr++)).digest().subarray(0, Math.min(32, n - i)), i);
  return out;
};
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const beInt = (b: Uint8Array) => { let v = 0n; for (const x of b) v = (v << 8n) | BigInt(x); return v; };
const be32 = (v: bigint) => { const o = new Uint8Array(32); let x = v; for (let i = 31; i >= 0; i--) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const scalar = () => { for (;;) { const k = beInt(rnd()); if (k > 0n && k < SECP256K1_ORDER) return k; } };
const clone = <T>(t: T): T => JSON.parse(JSON.stringify(t));
const pc = pureCircuits as any;

const tally: Record<string, { pass: number; refused: number }> = {};
const ok = (k: string, n = 1) => { (tally[k] ??= { pass: 0, refused: 0 }).pass += n; };
const counted = (k: string) => { (tally[k] ??= { pass: 0, refused: 0 }).refused++; };
/** A refusal's exact error name and message. */
type SignerRefusal = { name: string; message: string };
/** An expected refusal: a pattern tested against String(error), or the exact error name and message. */
type Refusal = RegExp | SignerRefusal;
const refused = (k: string, f: () => unknown, re: Refusal, why: string) => { assert.throws(f, re, `${k}: must refuse ${why}`); counted(k); };
const refusedAsync = async (k: string, f: () => Promise<unknown>, re: Refusal, why: string) => { await assert.rejects(f, re, `${k}: must refuse ${why}`); counted(k); };

// ── A wallet that records what it is asked ───────────────────────────────────

type Request = { method: 'address' } | { method: 'personalSign'; message: Uint8Array } | { method: 'signTypedData'; typedData: Eip712TypedData };
/** Every request any wallet of this suite received, with the address the
 *  wallet reported. */
const ALL_REQUESTS: { reported: Uint8Array; signer: Uint8Array; r: Request }[] = [];

/**
 * A wallet that reports `reported`'s address and signs with `signer`'s key
 * (the same key for an honest wallet; another for a wallet that answers with
 * another account, as a second installed extension does), optionally a
 * different key from the `switchAt`-th signature on, and lists `others` as
 * the addresses of the other connected wallets.
 */
class RecordingWallet implements EvmWallet {
  readonly requests: Request[] = [];
  otherAddresses?: () => Promise<readonly Uint8Array[]>;
  private signatures = 0;
  constructor(
    readonly reported: SoftwareEvmWallet,
    readonly signer: SoftwareEvmWallet = reported,
    others?: Uint8Array[],
    readonly switchTo?: { at: number; signer: SoftwareEvmWallet },
  ) {
    if (others) this.otherAddresses = async () => others.map((a) => new Uint8Array(a));
  }
  private log(r: Request) { this.requests.push(r); ALL_REQUESTS.push({ reported: this.reported.addressBytes, signer: this.signerNow().addressBytes, r }); }
  private signerNow() { return this.switchTo && this.signatures >= this.switchTo.at ? this.switchTo.signer : this.signer; }
  async address() { this.log({ method: 'address' }); return new Uint8Array(this.reported.addressBytes); }
  async personalSign(message: Uint8Array) {
    this.log({ method: 'personalSign', message: new Uint8Array(message) });
    const s = this.signerNow(); this.signatures++;
    return s.personalSign(message);
  }
  async signTypedData(typedData: Eip712TypedData) {
    this.log({ method: 'signTypedData', typedData: clone(typedData) });
    const s = this.signerNow(); this.signatures++;
    return s.signTypedData(typedData);
  }
  count(method: Request['method']) { return this.requests.filter((r) => r.method === method).length; }
}

/** A deterministic wallet of `sk` with another nonce rule than RFC 6979:
 *  RFC 6979 with a fixed additional input (RFC 6979 section 3.6), so it
 *  signs the same bytes the same way every time, its signatures recover to
 *  the key's address, and they differ from SoftwareEvmWallet's. */
class OtherNonceWallet extends SoftwareEvmWallet {
  override signDigest(digest: Uint8Array): Uint8Array {
    const rec = secp256k1.sign(digest, be32(this.sk), { prehash: false, format: 'recovered', extraEntropy: new Uint8Array(32).fill(0x5a) });
    return new Uint8Array([...rec.subarray(1), 27 + rec[0]]);
  }
}

const NET = 'undeployed';
const LABEL = grantLabel('bank.example');
const SITE = { decimals: 6, symbol: 'TOKEN' };
const addressText = (w: SoftwareEvmWallet) => evmChecksumAddress(w.addressBytes);
const unknownSigner = (expected: SoftwareEvmWallet): SignerRefusal => ({
  name: 'SignerMismatchError',
  message: `signer: refused before proving: the signature is not from the expected Ethereum address ${addressText(expected)}, and the signer is unknown`,
});
const namedSigner = (expected: SoftwareEvmWallet, signer: SoftwareEvmWallet): SignerRefusal => ({
  name: 'SignerMismatchError',
  message: `signer: refused before proving: the signature is not from the expected Ethereum address ${addressText(expected)}; it verifies under Ethereum address ${addressText(signer)}, another wallet's key`,
});

/** A device frame's typed data for `d` (rotate_enc_key, an unrelated key). */
const rotateTd = (d: EvmK256Device, account = rnd(), authNonce = 0n) => evmK256Messages.rotateEncKey({ account, device: d.address, authNonce }, rnd());
const granteeTd = (g: EvmK256Grantee, account: Uint8Array) =>
  evmK256Messages.withdrawUnshieldedAsGrantee({ account, grantee: g.address, label: g.label, slot: g.slot, issuedAt: 5n, grantNonce: 6n }, rnd(), 10n, rnd(), SITE);

/** A device-call surface whose proving step only counts: reaching it means
 *  the client went on to prove. */
function deviceSurface(d: EvmK256Device) {
  const account = rnd();
  const s = {
    proved: 0,
    addressBytes: account,
    async ledgerState() {
      const live = d.entryAt(account, 0n, 0n);
      return { auth_nonce: 0n, device_epoch: 0n, devices: { member: (e: Uint8Array) => eq(e, live) } };
    },
    async rotateEncKeyWithAuth() { s.proved++; return { txId: 'tx' }; },
    callTx: { revoke_all_grants_with_evm_k256: async () => { s.proved++; return { public: { txId: 'tx' } }; } } as Record<string, (...a: unknown[]) => Promise<any>>,
  };
  return s;
}
function granteeSurface(g: EvmK256Grantee) {
  const account = rnd();
  const s = {
    proved: 0,
    addressBytes: account,
    async ledgerState() { return { auth_nonce: 0n, device_epoch: 0n, devices: { member: () => false } }; },
    async rotateEncKeyWithAuth() { s.proved++; return { txId: 'tx' }; },
    callTx: {} as Record<string, (...a: unknown[]) => Promise<any>>,
    async heldCoin() { return { nonce: rnd(), color: rnd(), value: 0n, mt_index: 0n }; },
    async encKey() { return rnd(); },
    async grantRecord(id: Uint8Array) { return eq(id, g.grantId(account)) ? { issued_at: 5n, nonce: 6n } : null; },
    async withdrawUnshieldedWithGrantAuth() { s.proved++; return { txId: 'tx' }; },
    async withdrawShieldedWithGrantAuth() { s.proved++; return { txId: 'tx', change: null }; },
    async withdrawShieldedToContractWithGrantAuth() { s.proved++; return { txId: 'tx', sent: null, change: null }; },
  };
  return s;
}
const OPENING = { scopeSalt: new Uint8Array(32), recipientKind: 0n, pinnedRecipient: new Uint8Array(32), maxCoinValue: 0n, spentPrev: 0n };

const report: Record<string, unknown> = {};

/** The read seeds this suite knows (hex), and every grantee record it has
 *  written: none may hold a seed. */
const KNOWN_SEEDS = new Set<string>();
const GRANTEE_RECORDS: EvmK256GranteeRecord[] = [];
async function knowSeed(wallet: SoftwareEvmWallet, network: string, issuingAccount: Uint8Array): Promise<string> {
  const e = await enrolEvmGranteeBlind(new SoftwareEvmWallet(wallet.sk), network, issuingAccount);
  const s = hex(evmK256GrantReadSeed(canonicalEvmSignature(e.signatures[0])));
  KNOWN_SEEDS.add(s);
  return s;
}
/** A grantee's record, kept for the check that no written record holds a
 *  read seed. */
function grecOf(g: EvmK256Grantee): EvmK256GranteeRecord {
  const r = g.toRecord();
  GRANTEE_RECORDS.push(JSON.parse(JSON.stringify(r)));
  return r;
}

// ── Format ───────────────────────────────────────────────────────────────────

{
  assert.deepEqual(evmK256WalletFormats(), ['eip712-v1'], 'every EVM wallet signs the one format');
  assert.deepEqual(evmK256WalletFormats(), [...blindFormats('evm_k256')], 'the formats are the readable registry\'s');
  assert.equal(EVM_K256_FORMAT, 'eip712-v1');
  assert.equal(blindFormatName('evm_k256', EVM_K256_FORMAT), 'EIP-712 V1');
  ok('format', 4);

  const key = new SoftwareEvmWallet(scalar());
  const d = await EvmK256Device.enrol(key, NET, 0);
  const g = await EvmK256Grantee.enrol(key, NET, rnd(), LABEL, 0n);
  assert.equal(d.format, 'eip712-v1'); assert.equal(g.format, 'eip712-v1');
  const honest = rotateTd(d);
  assert.equal(checkEip712V1TypedData(honest), honest, 'the builders\' typed data passes');
  ok('format', 3);
  const P = EIP712_V1_VERIFYING_CONTRACT;
  const otherP = P.slice(0, -2) + (parseInt(P.slice(-2), 16) ^ 1).toString(16).padStart(2, '0');
  const foreign: [string, (t: any) => void][] = [
    ['the per-account domain', (t) => { t.domain = perAccountDomain(rnd()); }],
    ['a chainId in the domain and its type', (t) => { t.domain.chainId = '1'; t.types.EIP712Domain = [...t.types.EIP712Domain, { name: 'chainId', type: 'uint256' }]; }],
    ['a chainId in the domain only', (t) => { t.domain.chainId = '1'; }],
    ['a salt', (t) => { t.domain.salt = '0x' + hex(rnd()); }],
    ['the name "Midnight Passport Account"', (t) => { t.domain.name = 'Midnight Passport Account'; }],
    ['version "2"', (t) => { t.domain.version = '2'; }],
    ['P with its last byte changed', (t) => { t.domain.verifyingContract = otherP; }],
    ['P in lower case', (t) => { t.domain.verifyingContract = P.toLowerCase(); }],
    ['no verifyingContract', (t) => { delete t.domain.verifyingContract; }],
    ['no domain', (t) => { delete t.domain; }],
    ['the EIP712Domain type reordered', (t) => { t.types.EIP712Domain = [t.types.EIP712Domain[1], t.types.EIP712Domain[0], t.types.EIP712Domain[2]]; }],
    ['the EIP712Domain type with chainId', (t) => { t.types.EIP712Domain = [...t.types.EIP712Domain, { name: 'chainId', type: 'uint256' }]; }],
    ['the EIP712Domain type without verifyingContract', (t) => { t.types.EIP712Domain = t.types.EIP712Domain.slice(0, 2); }],
    ['verifyingContract typed as bytes20', (t) => { t.types.EIP712Domain = t.types.EIP712Domain.map((f: any) => (f.name === 'verifyingContract' ? { ...f, type: 'bytes20' } : f)); }],
    ['no EIP712Domain type', (t) => { delete t.types.EIP712Domain; }],
  ];
  const RE = /^Error: eip712: (not the fixed V1 domain|the EIP712Domain type is not the V1 type)/;
  for (const [name, f] of foreign) {
    const td = clone(honest); f(td);
    const w = new RecordingWallet(key);
    const dev = new EvmK256Device(d.pk, d.blind, NET, 0n, w);
    await refusedAsync('format', () => dev.authorise(td, 0n), RE, `a device approval under ${name}`);
    const gt = clone(granteeTd(g, rnd())); f(gt);
    const gw = new RecordingWallet(key);
    await refusedAsync('format', () => new EvmK256Grantee(g.pk, g.blind, LABEL, 0n, gw).authorise(gt), RE, `a grantee approval under ${name}`);
    assert.equal(w.count('signTypedData') + gw.count('signTypedData'), 0, `${name}: the wallet is never asked`);
    // the device's signature over the honest V1 digest, presented with the typed data as changed
    refused('format', () => d.authorisationFrom(td, key.signDigest(typedDataDigest(honest)), 0n), RE, `an existing signature under ${name}`);
  }
  ok('format');
  console.log(`  ✓ format: one format (eip712-v1, "EIP-712 V1") = the registry's; the builders' typed data passes; ${tally.format.refused} requests under ${foreign.length} other domains refused before the wallet was asked`);
}

// ── The signer check ─────────────────────────────────────────────────────────

const signerCases: { case: string; named: string | null }[] = [];
{
  const A = new SoftwareEvmWallet(scalar()), B = new SoftwareEvmWallet(scalar()), C = new SoftwareEvmWallet(scalar());
  const dA = await EvmK256Device.enrol(A, NET, 0);
  const gA = await EvmK256Grantee.enrol(A, NET, rnd(), LABEL, 0n);
  const zero = new Uint8Array(20), short = new Uint8Array(19).fill(1);
  // candidate lists and the key each refusal must name (null: unknown)
  const lists: [string, Uint8Array[] | undefined, SoftwareEvmWallet | null][] = [
    ['no candidate list', undefined, null],
    ['an empty list', [], null],
    ['the signer listed', [B.addressBytes], B],
    ['an unrelated key listed', [C.addressBytes], null],
    ['the unrelated key, then the signer', [C.addressBytes, B.addressBytes], B],
    ['the expected address listed', [A.addressBytes], null],
    ['the zero address and a 19-byte value listed', [zero, short], null],
    ['malformed values before the signer', [zero, short, A.addressBytes, B.addressBytes], B],
  ];
  const expectFor = (named: SoftwareEvmWallet | null) => (named ? namedSigner(A, named) : unknownSigner(A));
  const isMismatch = (named: SoftwareEvmWallet | null) => (e: unknown) => {
    assert.ok(e instanceof SignerMismatchError, 'a SignerMismatchError');
    assert.ok(eq(e.expected, A.addressBytes), 'it names the expected address');
    if (named) assert.ok(e.signer && eq(e.signer, named.addressBytes), 'it names the signer'); else assert.equal(e.signer, undefined, 'no signer named');
    const expected = expectFor(named);
    assert.equal(e.name, expected.name);
    assert.equal(e.message, expected.message);
    return true;
  };
  for (const [name, others, named] of lists) {
    // device approval: the wallet reports A and answers with B
    const w = new RecordingWallet(A, B, others);
    const dev = new EvmK256Device(dA.pk, dA.blind, NET, 0n, w);
    await assert.rejects(() => dev.authorise(rotateTd(dev), 0n), isMismatch(named)); counted('signer');
    assert.equal(w.count('signTypedData'), 1);
    // authorisationFrom with B's signature
    const td = rotateTd(dA);
    assert.throws(() => dA.authorisationFrom(td, B.signDigest(typedDataDigest(td)), 0n, others ?? []), isMismatch(named)); counted('signer');
    // grantee approval
    const gw = new RecordingWallet(A, B, others);
    await assert.rejects(() => new EvmK256Grantee(gA.pk, gA.blind, LABEL, 0n, gw).authorise(granteeTd(gA, rnd())), isMismatch(named)); counted('signer');
    // enrolment: the first blind signature from B; refused before the second request
    const ew = new RecordingWallet(A, B, others);
    await assert.rejects(() => enrolEvmBlind(ew, NET, 0), isMismatch(named)); counted('signer');
    assert.equal(ew.count('personalSign'), 1, 'refused before the second request');
    const egw = new RecordingWallet(A, B, others);
    await assert.rejects(() => enrolEvmGranteeBlind(egw, NET, rnd()), isMismatch(named)); counted('signer');
    // enrolment: the first from A, the second from B
    const sw = new RecordingWallet(A, A, others, { at: 1, signer: B });
    await assert.rejects(() => EvmK256Device.enrol(sw, NET, 0), isMismatch(named)); counted('signer');
    assert.equal(sw.count('personalSign'), 2);
    const sgw = new RecordingWallet(A, A, others, { at: 1, signer: B });
    await assert.rejects(() => EvmK256Grantee.enrol(sgw, NET, rnd(), LABEL, 0n), isMismatch(named)); counted('signer');
    assert.equal(sgw.count('personalSign'), 2);
    signerCases.push({ case: name, named: named ? addressText(named) : null });
  }
  // the honest wallet passes with every list
  for (const [, others] of lists) {
    const w = new RecordingWallet(A, A, others);
    const dev = new EvmK256Device(dA.pk, dA.blind, NET, 0n, w);
    const a = await dev.authorise(rotateTd(dev), 0n);
    assert.equal(a.pk, dA.pk);
    const td = rotateTd(dA);
    dA.authorisationFrom(td, A.signDigest(typedDataDigest(td)), 0n, others ?? []);
    await new EvmK256Grantee(gA.pk, gA.blind, LABEL, 0n, new RecordingWallet(A, A, others)).authorise(granteeTd(gA, rnd()));
    const e = await enrolEvmBlind(new RecordingWallet(A, A, others), NET, 0);
    assert.ok(eq(e.blind, dA.blind));
    ok('signer', 4);
  }
  // the high-S twin of the device's own signature passes (the same key)
  {
    const td = rotateTd(dA);
    const twin = serialiseEvmSignature(highSTwin(parseEvmSignature(A.signDigest(typedDataDigest(td)))));
    dA.authorisationFrom(td, twin, 0n); ok('signer');
  }
  // signatures over another digest: the signer is unknown, whoever is listed
  {
    const td = rotateTd(dA);
    const all = [A.addressBytes, B.addressBytes, C.addressBytes];
    for (const [name, dom] of Object.entries(FOREIGN_DOMAINS)) {
      refused('signer', () => dA.authorisationFrom(td, A.signDigest(dom.digest(td, rnd())), 0n, all), unknownSigner(A), `the device's key over the message under ${dom.name} (${name})`);
    }
    const blindSig = await A.personalSign(blindMessageBytes({ scheme: 'evm_k256', network: NET, identity: A.addressBytes, accountIndex: 0 }));
    refused('signer', () => dA.authorisationFrom(td, blindSig, 0n, all), unknownSigner(A), 'the device\'s blind signature presented as an approval');
    const approval = A.signDigest(typedDataDigest(td));
    const msg = blindMessageBytes({ scheme: 'evm_k256', network: NET, identity: A.addressBytes, accountIndex: 0 });
    refused('signer', () => checkEvmK256Signer(A.addressBytes, personalMessageDigest(msg), approval, all), unknownSigner(A), 'an approval presented as a blind signature');
    // an r with no curve point: nothing can be recovered
    let r = 0n;
    for (;;) { r = beInt(rnd()) % SECP256K1_ORDER; if (r === 0n) continue; try { secp256k1.Point.fromHex('02' + hex(be32(r))); } catch { break; } }
    const bad = new Uint8Array([...be32(r), ...be32(5n), 27]);
    refused('signer', () => dA.authorisationFrom(td, bad, 0n, all), unknownSigner(A), 'an r that is no point\'s x-coordinate');
    refused('signer', () => dA.authorisationFrom(td, approval.subarray(0, 64), 0n, all), /65 bytes/, 'a 64-byte signature');
  }
  // the call facades: refused before the proving surface is reached
  {
    const s1 = deviceSurface(dA);
    await rotateEncKeyWithEvmK256(s1, new EvmK256Device(dA.pk, dA.blind, NET, 0n, new RecordingWallet(A)), rnd());
    assert.equal(s1.proved, 1, 'the honest control reaches the proving surface');
    const s2 = deviceSurface(dA);
    await refusedAsync('signer', () => rotateEncKeyWithEvmK256(s2, new EvmK256Device(dA.pk, dA.blind, NET, 0n, new RecordingWallet(A, B, [B.addressBytes])), rnd()), namedSigner(A, B), 'rotate_enc_key signed by another wallet');
    const s3 = deviceSurface(dA);
    await refusedAsync('signer', () => revokeAllGrantsWithEvmK256(s3, new EvmK256Device(dA.pk, dA.blind, NET, 0n, new RecordingWallet(A, B))), unknownSigner(A), 'revoke_all_grants signed by another wallet');
    const s4 = deviceSurface(dA);
    await revokeAllGrantsWithEvmK256(s4, new EvmK256Device(dA.pk, dA.blind, NET, 0n, new RecordingWallet(A)));
    assert.equal(s2.proved + s3.proved, 0, 'nothing proved for a refused signature'); assert.equal(s4.proved, 1);
    const gs = granteeSurface(gA);
    await withdrawUnshieldedAsEvmGrantee(gs, new EvmK256Grantee(gA.pk, gA.blind, LABEL, 0n, new RecordingWallet(A)), OPENING, rnd(), 10n, rnd(), SITE);
    assert.equal(gs.proved, 1, 'the honest grantee control reaches the proving surface');
    const gs2 = granteeSurface(gA);
    await refusedAsync('signer', () => withdrawUnshieldedAsEvmGrantee(gs2, new EvmK256Grantee(gA.pk, gA.blind, LABEL, 0n, new RecordingWallet(A, B, [C.addressBytes, B.addressBytes])), OPENING, rnd(), 10n, rnd(), SITE),
      namedSigner(A, B), 'a grantee spend signed by another wallet');
    assert.equal(gs2.proved, 0);
    ok('signer', 4);
  }
  report.signer = signerCases;
  console.log(`  ✓ signer: another wallet's signature refused before proving at ${lists.length} candidate lists × 7 return points (the device's and the grantee's approvals, authorisationFrom, both blind signatures of each role); named only when it recovers; honest signatures pass with every list (${tally.signer.pass}); ${tally.signer.refused} refusals, the facades never reach the proving surface`);
}

// ── Blind: two sessions, the sign-twice check ────────────────────────────────

const BLIND_TAG = padTag('midnight:account:blind:evm:v1');
const sessions: Record<string, string>[] = [];
{
  for (let i = 0; i < 6; i++) {
    const k = i === 0 ? 1n : scalar();
    for (const [network, index] of [[NET, 0], [NET, 1], ['preview', 0], [NET, 0xffffffff]] as [string, number][]) {
      const one = await enrolEvmBlind(new RecordingWallet(new SoftwareEvmWallet(k)), network, index);
      const two = await enrolEvmBlind(new RecordingWallet(new SoftwareEvmWallet(k)), network, index);
      assert.ok(eq(one.signatures[0], two.signatures[0]) && eq(one.canonical, two.canonical) && eq(one.blind, two.blind), 'two sessions give one blind');
      assert.ok(eq(one.blind, pc.derive_blind(BLIND_TAG, one.canonical)), 'the blind == derive_blind');
      assert.equal(one.pk.x, two.pk.x);
      if (i < 2) sessions.push({ role: 'device', scalar: k.toString(16), network, accountIndex: String(index), blind: hex(one.blind) });
      ok('blind');
    }
    for (let j = 0; j < 3; j++) {
      const issuer = rnd();
      const one = await EvmK256Grantee.enrol(new RecordingWallet(new SoftwareEvmWallet(k)), NET, issuer, LABEL, 0n);
      const two = await EvmK256Grantee.enrol(new RecordingWallet(new SoftwareEvmWallet(k)), NET, issuer, LABEL, 0n);
      assert.ok(eq(one.blind, two.blind), 'two sessions give one grantee blind');
      assert.ok(eq(one.readKey(issuer).publicKey, two.readKey(issuer).publicKey), 'and one read key');
      assert.ok(eq(one.grantId(issuer), two.grantId(issuer)));
      if (i < 2 && j === 0) sessions.push({ role: 'grantee', scalar: k.toString(16), network: NET, issuingAccount: hex(issuer), blind: hex(one.blind) });
      ok('blind');
    }
  }
  // a second session that returns the high-S twin
  {
    const k = new SoftwareEvmWallet(scalar());
    const e = await enrolEvmBlind(k, NET, 0);
    const twin = serialiseEvmSignature(highSTwin(parseEvmSignature(e.signatures[0])));
    const viaTwin: EvmWallet = { address: () => k.address(), personalSign: async () => twin, signTypedData: () => { throw new Error('not asked'); } };
    assert.ok(eq((await enrolEvmBlind(viaTwin, NET, 0)).blind, e.blind), 'the high-S twin gives the same blind');
    ok('blind');
  }
  // a non-deterministic wallet: refused after exactly two requests
  const hedged = new SoftwareEvmWallet(scalar(), true);
  for (const [role, run] of [
    ['device', (w: EvmWallet) => EvmK256Device.enrol(w, NET, 0)],
    ['grantee', (w: EvmWallet) => EvmK256Grantee.enrol(w, NET, rnd(), LABEL, 0n)],
    ['device restore', (w: EvmWallet) => restoreEvmK256Device({ wallet: w, network: NET, accountIndex: 0, finds: () => true })],
    ['grantee restore', (w: EvmWallet) => restoreEvmK256Grantee({ wallet: w, label: LABEL, slot: 0n, network: NET, issuingAccount: rnd(), finds: () => true })],
  ] as [string, (w: EvmWallet) => Promise<unknown>][]) {
    const w = new RecordingWallet(hedged);
    await refusedAsync('blind', () => run(w), /not deterministic/, `a hedged wallet as a ${role}`);
    assert.equal(w.count('personalSign'), 2, `${role}: two requests`); assert.equal(w.count('signTypedData'), 0, `${role}: no approval`);
  }
  report.sessions = sessions;
  console.log(`  ✓ blind: two sessions give equal signatures and blinds (${tally.blind.pass} key × network × index and key × issuer cases), == derive_blind; the high-S twin agrees; ${tally.blind.refused} non-deterministic enrolments refused after two requests, nothing signed or proved`);
}

// ── Records ──────────────────────────────────────────────────────────────────

{
  const k = new SoftwareEvmWallet(scalar());
  const d = await EvmK256Device.enrol(k, NET, 3);
  const rec = d.toRecord();
  assert.equal(rec.format, 'eip712-v1'); assert.equal(rec.blind, hex(d.blind));
  const back = EvmK256Device.fromRecord(JSON.parse(JSON.stringify(rec)));
  assert.ok(eq(back.blind, d.blind) && eq(back.address, d.address) && back.accountIndex === 3n && back.format === 'eip712-v1');
  ok('records');
  const { blind: _b, ...lost } = rec;
  refused('records', () => EvmK256Device.fromRecord(lost as EvmK256RosterRecord), /holds no cached blind/, 'a device record without its cache');
  const other = new SoftwareEvmWallet(scalar());
  const bad: [string, Partial<Record<keyof EvmK256RosterRecord, unknown>>, RegExp][] = [
    ['another scheme', { scheme: 'sol_ed25519' }, /not an evm_k256 record/],
    ['no format', { format: undefined }, /has no format/],
    ['the format raw', { format: 'raw' }, /has no format/],
    ['the format EIP712-V1', { format: 'EIP712-V1' }, /has no format/],
    ['the format constructor', { format: 'constructor' }, /has no format/],
    ['a blind that is not hex', { blind: 'zz' }, /hex/],
    ['a 31-byte blind', { blind: hex(rnd(31)) }, /32 bytes/],
    ['a numeric blind', { blind: 7 }, /is hex/],
    ['an upper-case coordinate', { pk: { ...rec.pk, x: rec.pk.x.toUpperCase() } }, /64-digit lower-case hex/],
    ['a short coordinate', { pk: { ...rec.pk, x: rec.pk.x.slice(2) } }, /64-digit lower-case hex/],
    ['an off-curve point', { pk: { ...rec.pk, y: rec.pk.x } }, /not on curve|invalid|bad point/i],
    ['the point at infinity', { pk: { x: '0'.repeat(64), y: '0'.repeat(64) } }, /point at infinity/],
    ['another key\'s address', { address: addressText(other) }, /not the point's address/],
    ['no address', { address: undefined }, /not the point's address/],
    ['an account index 01', { accountIndex: '01' }, /decimal number/],
    ['an account index -1', { accountIndex: '-1' }, /decimal number/],
    ['an account index 0x1', { accountIndex: '0x1' }, /decimal number/],
    ['a numeric account index', { accountIndex: 1 }, /decimal number/],
    ['no network', { network: undefined }, /names its network/],
  ];
  for (const [why, patch, re] of bad) refused('records', () => EvmK256Device.fromRecord({ ...rec, ...patch } as EvmK256RosterRecord), re, `a device record with ${why}`);
  // the same refusals in a restore, before the wallet is asked
  for (const [why, patch, re] of bad) {
    const w = new RecordingWallet(k);
    await refusedAsync('records', () => restoreEvmK256Device({ wallet: w, record: { ...rec, ...patch } as EvmK256RosterRecord }), re, `a restore from a record with ${why}`);
    assert.equal(w.requests.length, 0, `${why}: the wallet is not asked`);
  }

  const issuer = rnd();
  const g = await EvmK256Grantee.enrol(k, NET, issuer, LABEL, 2n);
  const seed = await knowSeed(k, NET, issuer);
  const grec = grecOf(g);
  assert.equal(grec.role, 'grantee'); assert.equal(grec.format, 'eip712-v1'); assert.equal(grec.issuingAccount, hex(issuer));
  assert.ok(!('readSeed' in grec) && grec.blind === hex(g.blind), 'the grantee record caches the blind and not the read seed');
  const gback = EvmK256Grantee.fromRecord(JSON.parse(JSON.stringify(grec)), LABEL, 2n);
  assert.ok(eq(gback.blind, g.blind) && eq(gback.grantId(issuer), g.grantId(issuer)) && gback.hasReadSeed === false && g.hasReadSeed === true);
  refused('records', () => gback.readKey(issuer), /no read seed in memory/, 'a read key of a grantee read from its record, before its wallet signs');
  const shop = grantLabel('shop.example');
  assert.ok(eq(EvmK256Grantee.fromRecord(grec, shop, 0n).grantId(issuer), g.withGrant(shop, 0n).grantId(issuer)), 'one record serves every grant of the issuer');
  assert.deepEqual(grecOf(gback), grec, 'a grantee read from its record writes the same record');
  ok('records', 3);
  refused('records', () => new EvmK256Grantee(g.pk, g.blind, LABEL, 2n).toRecord(), /only a grantee enrolled or restored/, 'a record of the issuer\'s view of a grantee');
  const { blind: _gb, ...glost } = grec;
  refused('records', () => EvmK256Grantee.fromRecord(glost as EvmK256GranteeRecord, LABEL, 2n), /holds no cached blind/, 'a grantee record without its cache');
  const gbad: [string, Record<string, unknown>, RegExp][] = [
    ['the role device', { role: 'device' }, /not a grantee record/],
    ['no role', { role: undefined }, /not a grantee record/],
    ['its read seed', { readSeed: seed }, /never holds the read seed/],
    ['its read seed and no blind', { readSeed: seed, blind: undefined }, /never holds the read seed/],
    ['an empty read seed member', { readSeed: undefined }, /never holds the read seed/],
    ['a malformed read seed', { readSeed: 'zz' }, /never holds the read seed/],
    ['a 31-byte issuing account', { issuingAccount: hex(rnd(31)) }, /issuing account/],
    ['an upper-case issuing account', { issuingAccount: hex(issuer).toUpperCase() }, /issuing account/],
    ['the format raw', { format: 'raw' }, /has no format/],
  ];
  for (const [why, patch, re] of gbad) refused('records', () => EvmK256Grantee.fromRecord({ ...grec, ...patch } as EvmK256GranteeRecord, LABEL, 2n), re, `a grantee record with ${why}`);
  for (const [why, patch, re] of gbad) {
    const w = new RecordingWallet(k);
    await refusedAsync('records', () => restoreEvmK256Grantee({ wallet: w, label: LABEL, slot: 2n, record: { ...grec, ...patch } as EvmK256GranteeRecord }), re, `a grantee restore from a record with ${why}`);
    assert.equal(w.requests.length, 0, `${why}: the wallet is not asked`);
  }
  console.log(`  ✓ records: device and grantee records carry the format and the cached blind, never a read seed, round trip; ${tally.records.refused} malformed records and requests refused (a stored read seed among them), the wallet never asked`);
}

// ── Restore ──────────────────────────────────────────────────────────────────

const restoreCases: Record<string, unknown>[] = [];
{
  const A = new SoftwareEvmWallet(scalar()), B = new SoftwareEvmWallet(scalar());
  const d = await EvmK256Device.enrol(A, NET, 1);
  const rec = d.toRecord();
  const { blind: _b, ...lost } = rec;
  const request = blindMessageBytes({ scheme: 'evm_k256', network: NET, identity: A.addressBytes, accountIndex: 1 });
  const signs = (w: RecordingWallet) => w.requests.filter((r) => r.method !== 'address');
  // the account's device set: the device live at counter 2
  const A1 = rnd(), live = new Set([hex(d.entryAt(A1, 0n, 2n))]);
  const finds = (x: EvmK256Device) => [0n, 1n, 2n, 3n].some((c) => live.has(hex(x.entryAt(A1, 0n, c))));

  // 1. the cache: no signature asked
  {
    const w = new RecordingWallet(A);
    const r = await restoreEvmK256Device({ wallet: w, record: rec });
    assert.ok(r.ok === true && r.source === 'cache' && eq(r.value.blind, d.blind) && eq(r.value.address, d.address) && r.value.wallet === w);
    assert.equal(signs(w).length, 0, 'nothing signed');
    restoreCases.push({ case: 'device, cached', source: 'cache', signatures: 0 });
    ok('restore');
  }
  // 2. the cache lost: derived again in the stored format, and found
  {
    const w = new RecordingWallet(A);
    const r = await restoreEvmK256Device({ wallet: w, record: lost as EvmK256RosterRecord, finds });
    assert.ok(r.ok === true && r.source === 'stored-format' && eq(r.value.blind, d.blind) && r.value.pk.x === d.pk.x);
    assert.equal(w.count('personalSign'), 2); assert.equal(w.count('signTypedData'), 0);
    assert.ok(signs(w).every((x) => x.method === 'personalSign' && eq(x.message, request)), 'the device request of the record');
    restoreCases.push({ case: 'device, cache lost', source: 'stored-format', signatures: 2 });
    ok('restore');
  }
  // 3. the cache lost, the wallet reporting another address but signing with the record's key
  {
    const w = new RecordingWallet(B, A);
    const r = await restoreEvmK256Device({ wallet: w, record: lost as EvmK256RosterRecord, finds });
    assert.ok(r.ok === true && r.source === 'stored-format' && eq(r.value.blind, d.blind), 'the record\'s key, whatever the wallet reports');
    ok('restore');
  }
  // 3b. the cache lost, a deterministic wallet of the same key with another nonce rule: its blind finds
  // nothing, so the restore refuses it with the remedy instead of returning another device
  const STORED_NOT_FOUND = 'No account was found with the privacy key this wallet derives in the EIP-712 V1 format, the format this device was enrolled through. ' +
    'A wallet that signs the request differently from the wallet used then derives another privacy key from the same wallet key. ' +
    'Use that wallet, or add this wallet as a new device from another device of the account, or through the account\'s recovery.';
  {
    const w = new RecordingWallet(new OtherNonceWallet(A.sk));
    const r = await restoreEvmK256Device({ wallet: w, record: lost as EvmK256RosterRecord, finds });
    assert.ok(r.ok === false && r.reason === 'not-found' && r.message === STORED_NOT_FOUND, r.ok === false ? r.message : 'restored another device');
    assert.ok(w.count('personalSign') === 2 && signs(w).every((x) => x.method === 'personalSign' && eq(x.message, request)), 'the record\'s request, twice (the sign-twice check passed)');
    restoreCases.push({ case: 'device, cache lost, the same key through another nonce rule', refused: true, message: STORED_NOT_FOUND });
    ok('restore');
  }
  // 3c. the cache lost and no test: refused before the wallet is asked
  {
    const w = new RecordingWallet(A);
    await refusedAsync('restore', () => restoreEvmK256Device({ wallet: w, record: lost as EvmK256RosterRecord }), /a restore of a record without its cached blind needs finds/, 'a cache-lost device record without finds');
    assert.equal(w.requests.length, 0, 'nothing asked');
  }
  // 4. the cache lost, a wallet of another key: refused, naming the key it reports
  {
    const w = new RecordingWallet(B);
    await refusedAsync('restore', () => restoreEvmK256Device({ wallet: w, record: lost as EvmK256RosterRecord, finds }), namedSigner(A, B), 'another key\'s wallet against a device record');
    assert.equal(w.count('personalSign'), 1, 'refused at the first signature');
    restoreCases.push({ case: 'device, cache lost, another key', refused: true });
  }
  // 5. no record, found
  {
    const w = new RecordingWallet(A);
    const r = await restoreEvmK256Device({ wallet: w, network: NET, accountIndex: 1, finds });
    assert.ok(r.ok === true && r.source === 'search' && eq(r.value.blind, d.blind) && r.value.accountIndex === 1n);
    assert.equal(w.count('personalSign'), 2);
    restoreCases.push({ case: 'device, no record, found', source: 'search', signatures: 2 });
    ok('restore');
  }
  // 6. no record, not found: the message names the formats tried and what remains
  const NOT_FOUND = 'No account was found in the formats this wallet can sign (EIP-712 V1). Add this wallet as a new device from another device of the account, or through the account\'s recovery.';
  {
    const w = new RecordingWallet(A);
    const r = await restoreEvmK256Device({ wallet: w, network: NET, accountIndex: 0, finds });
    assert.ok(r.ok === false && r.reason === 'not-found');
    assert.equal(r.ok === false && r.message, NOT_FOUND);
    assert.equal(w.count('personalSign'), 2); assert.equal(w.count('signTypedData'), 0);
    restoreCases.push({ case: 'device, no record, not found', message: NOT_FOUND });
    ok('restore');
  }
  // 7. no record: another key's wallet finds nothing (its blind is another)
  {
    const r = await restoreEvmK256Device({ wallet: new RecordingWallet(B), network: NET, accountIndex: 1, finds });
    assert.ok(r.ok === false && r.message === NOT_FOUND);
    ok('restore');
  }
  // 8. a malformed request: refused before the wallet is asked
  {
    const w = new RecordingWallet(A);
    await refusedAsync('restore', () => restoreEvmK256Device({ wallet: w, network: NET, accountIndex: 0 } as any), /needs the network, the account index and finds/, 'a restore without a record or finds');
    assert.equal(w.requests.length, 0);
  }

  // grantees
  const issuer = rnd();
  const g = await EvmK256Grantee.enrol(A, NET, issuer, LABEL, 1n);
  await knowSeed(A, NET, issuer);
  const grec = grecOf(g);
  const { blind: _gb, ...glost } = grec;
  const grequest = granteeBlindMessageBytes({ scheme: 'evm_k256', network: NET, identity: A.addressBytes, issuingAccount: issuer });
  const ids = new Set([hex(g.grantId(issuer))]);
  const gfinds = (x: EvmK256Grantee) => ids.has(hex(x.grantId(issuer)));
  {
    const w = new RecordingWallet(A);
    const r = await restoreEvmK256Grantee({ wallet: w, label: LABEL, slot: 1n, record: grec });
    assert.ok(r.ok === true && r.source === 'cache' && eq(r.value.grantId(issuer), g.grantId(issuer)) && r.value.hasReadSeed === false);
    assert.equal(signs(w).length, 0);
    restoreCases.push({ case: 'grantee, cached', source: 'cache', signatures: 0 });
    ok('restore');
  }
  {
    const w = new RecordingWallet(A);
    const r = await restoreEvmK256Grantee({ wallet: w, label: LABEL, slot: 1n, record: glost as EvmK256GranteeRecord, finds: gfinds });
    assert.ok(r.ok === true && r.source === 'stored-format' && eq(r.value.blind, g.blind) && eq(r.value.readKey(issuer).secretKey, g.readKey(issuer).secretKey));
    assert.ok(signs(w).length === 2 && signs(w).every((x) => x.method === 'personalSign' && eq(x.message, grequest)), 'the grantee request of the record');
    assert.deepEqual(r.ok === true && grecOf(r.value), grec, 'the restored grantee writes the same record, cache included');
    restoreCases.push({ case: 'grantee, cache lost', source: 'stored-format', signatures: 2 });
    ok('restore');
  }
  {
    const w = new RecordingWallet(A);
    const r = await restoreEvmK256Grantee({ wallet: w, label: LABEL, slot: 1n, network: NET, issuingAccount: issuer, finds: gfinds });
    assert.ok(r.ok === true && r.source === 'search' && eq(r.value.grantId(issuer), g.grantId(issuer)));
    ok('restore');
  }
  const NO_GRANT = 'No grant was found in the formats this wallet can sign (EIP-712 V1). Ask the issuing account\'s owner for a new grant to this wallet.';
  {
    const r = await restoreEvmK256Grantee({ wallet: new RecordingWallet(A), label: LABEL, slot: 0n, network: NET, issuingAccount: issuer, finds: gfinds });
    assert.ok(r.ok === false && r.reason === 'not-found' && r.message === NO_GRANT, r.ok === false ? r.message : '');
    restoreCases.push({ case: 'grantee, no record, not found', message: NO_GRANT });
    ok('restore');
  }
  {
    const w = new RecordingWallet(B);
    await refusedAsync('restore', () => restoreEvmK256Grantee({ wallet: w, label: LABEL, slot: 1n, record: glost as EvmK256GranteeRecord, finds: gfinds }), namedSigner(A, B), 'another key\'s wallet against a grantee record');
  }
  // a grantee record, the cache lost, the same key through another nonce rule: refused with the grantee remedy
  {
    const w = new RecordingWallet(new OtherNonceWallet(A.sk));
    const r = await restoreEvmK256Grantee({ wallet: w, label: LABEL, slot: 1n, record: glost as EvmK256GranteeRecord, finds: gfinds });
    const want = 'No grant was found with the privacy key this wallet derives in the EIP-712 V1 format, the format this grant was issued through. ' +
      'A wallet that signs the request differently from the wallet used then derives another privacy key from the same wallet key. ' +
      'Use that wallet, or ask the issuing account\'s owner for a new grant to this wallet.';
    assert.ok(r.ok === false && r.reason === 'not-found' && r.message === want, r.ok === false ? r.message : 'restored another grantee');
    assert.equal(w.count('personalSign'), 2);
    restoreCases.push({ case: 'grantee, cache lost, the same key through another nonce rule', refused: true, message: want });
    ok('restore');
  }
  {
    const w = new RecordingWallet(A);
    await refusedAsync('restore', () => restoreEvmK256Grantee({ wallet: w, label: LABEL, slot: 1n, record: glost as EvmK256GranteeRecord }), /a restore of a record without its cached blind needs finds/, 'a cache-lost grantee record without finds');
    assert.equal(w.requests.length, 0, 'nothing asked');
  }
  // the restored device writes the record it was restored from (the cache back)
  {
    const r = await restoreEvmK256Device({ wallet: new RecordingWallet(A), record: lost as EvmK256RosterRecord, finds });
    assert.deepEqual(r.ok === true && r.value.toRecord(), rec);
    ok('restore');
  }
  report.restore = restoreCases;
  console.log(`  ✓ restore: ${tally.restore.pass} cases (device and grantee: cache, cache lost and found, cache lost through another deterministic nonce rule refused, no record found and not found with the restore message, another key's wallet); ${tally.restore.refused} refused`);
}

// ── Use counters: no ceiling, the known counter first ───────────────────────
//
// A ledger that holds the device set at epoch 0 and, for every call it
// accepts, does what the device seam does: the entry at the presented use
// counter must be live; it is removed, the entry at the next counter is
// inserted and auth_nonce advances by one. Membership probes are counted.

/** One account's ledger as the device seam keeps it, for `devices`. */
function rollingAccount(authNonce: bigint, live: [EvmK256Device, bigint][], epoch = 0n, account = rnd()) {
  const set = new Set(live.map(([d, c]) => hex(d.entryAt(account, epoch, c))));
  const devices = live.map(([d]) => d);
  const s = {
    authNonce, probes: 0, reads: 0, calls: [] as { circuit: string; useCounter: bigint }[],
    addressBytes: account,
    async ledgerState() {
      s.reads++;
      return { auth_nonce: s.authNonce, device_epoch: epoch, devices: { member: (e: Uint8Array) => { s.probes++; return set.has(hex(e)); } } };
    },
    seam(circuit: string, a: { pk: { x: bigint; y: bigint }; blind: Uint8Array; use_counter: bigint }) {
      const d = devices.find((x) => x.pk.x === a.pk.x && x.pk.y === a.pk.y && eq(x.blind, a.blind));
      const entry = d && hex(d.entryAt(account, epoch, a.use_counter));
      if (!d || !set.has(entry!)) throw new Error('unknown device entry');
      set.delete(entry!); set.add(hex(d.entryAt(account, epoch, a.use_counter + 1n)));
      s.authNonce++;
      s.calls.push({ circuit, useCounter: a.use_counter });
      return { txId: `tx-${s.calls.length}`, public: { txId: `tx-${s.calls.length}` } };
    },
    async rotateEncKeyWithAuth(_k: Uint8Array, a: EvmK256Authorisation) { return s.seam('rotate_enc_key_with_evm_k256', a); },
    callTx: {
      recover_cancel_with_evm_k256: async (a: EvmK256Authorisation) => s.seam('recover_cancel_with_evm_k256', a),
    } as Record<string, (...a: any[]) => Promise<any>>,
    isLive: (d: EvmK256Device, c: bigint) => set.has(hex(d.entryAt(account, epoch, c))),
  };
  return s;
}

const counterCases: Record<string, unknown>[] = [];
{
  const A = new SoftwareEvmWallet(scalar());
  const d = await EvmK256Device.enrol(A, NET, 0);
  const fresh = () => new EvmK256Device(d.pk, d.blind, NET, 0n, A);
  const rotate = async (acc: ReturnType<typeof rollingAccount>, dev: EvmK256Device) => {
    const before = acc.probes;
    const r = await rotateEncKeyWithEvmK256(acc, dev, rnd());
    return { counter: r.auth.use_counter, probes: acc.probes - before };
  };

  // 1. a device at 4095 (one device since activation: its counter is auth_nonce), then across 4096
  {
    const acc = rollingAccount(4095n, [[d, 4095n]]);
    const dev = fresh();
    const first = await rotate(acc, dev);
    assert.equal(first.counter, 4095n, 'the call at 4095 presents counter 4095');
    assert.equal(first.probes, 4096, 'a device object without a known counter scans 0..auth_nonce');
    assert.ok(acc.isLive(d, 4096n) && !acc.isLive(d, 4095n) && acc.authNonce === 4096n, 'the ledger rolled the entry to 4096');
    const second = await rotate(acc, dev);
    assert.equal(second.counter, 4096n, 'the next call finds the entry at 4096');
    assert.equal(second.probes, 2, 'the known counter (dead now), then its successor: two probes');
    const third = await rotate(acc, fresh());
    assert.equal(third.counter, 4097n, 'a fresh device object finds 4097 by the scan, with no ceiling');
    assert.equal(third.probes, 4098);
    counterCases.push({ case: 'live at 4095, then 4096, then 4097', counters: [first.counter, second.counter, third.counter].map(String), probes: [first.probes, second.probes, third.probes] });
    ok('counters', 3);
  }
  // 2. a counter of 5000, and a counter equal to auth_nonce after many calls of other devices
  {
    const acc = rollingAccount(5000n, [[d, 5000n]]);
    assert.equal((await rotate(acc, fresh())).counter, 5000n, 'counter 5000 found');
    const acc2 = rollingAccount(7000n, [[d, 5000n]]);
    assert.equal(await resolveEvmK256Counter(acc2, fresh()), 5000n, 'counter 5000 below auth_nonce 7000');
    counterCases.push({ case: 'live at 5000 (auth_nonce 5000, 7000)', counter: '5000' });
    ok('counters', 2);
  }
  // 3. stale and wrong known counters fall back to the scan; an explicit counter is checked too
  {
    const acc = rollingAccount(10n, [[d, 3n]]);
    for (const known of [0n, 2n, 7n, 10n, 11n, 9000n]) {
      const dev = fresh();
      dev.noteCounter(acc.addressBytes, 0n, known);
      assert.equal(await resolveEvmK256Counter(acc, dev), 3n, `a known counter ${known} that is not live: the scan finds 3`);
      assert.equal(dev.knownCounter(acc.addressBytes, 0n), 3n, 'the counter found becomes the known one');
      assert.equal(await resolveEvmK256Counter(acc, fresh(), { counter: known }), 3n, `an explicit counter ${known} that is not live: the scan finds 3`);
    }
    const dev = fresh();
    dev.noteCounter(acc.addressBytes, 0n, 3n);
    const before = acc.probes;
    assert.equal(await resolveEvmK256Counter(acc, dev), 3n);
    assert.equal(acc.probes - before, 1, 'a live known counter: one probe');
    // a known counter of another epoch or account is not used for this one
    const other = fresh();
    other.noteCounter(acc.addressBytes, 1n, 9n); other.noteCounter(rnd(), 0n, 9n);
    assert.equal(other.knownCounter(acc.addressBytes, 0n), undefined, 'known counters are per account and epoch');
    // a new epoch (after a recovery): the old epoch's known counter is not this epoch's
    {
      const dev = fresh();
      const before0 = rollingAccount(4100n, [[d, 4000n]]);
      assert.equal(await resolveEvmK256Counter(before0, dev), 4000n);
      const after1 = rollingAccount(4101n, [[d, 0n]], 1n, before0.addressBytes);
      assert.equal(dev.knownCounter(before0.addressBytes, 1n), undefined, 'no known counter at the new epoch');
      const p0 = after1.probes;
      assert.equal(await resolveEvmK256Counter(after1, dev), 0n, 'the device re-enrolled at counter 0 of epoch 1');
      assert.equal(after1.probes - p0, 1, 'found at the first probe: the old epoch\'s counter is not tried');
      assert.equal(dev.knownCounter(before0.addressBytes, 0n), 4000n, 'the old epoch\'s counter kept under its epoch');
    }
    refused('counters', () => fresh().noteCounter(acc.addressBytes, 0n, -1n), /a use counter is a Uint<64>/, 'a negative counter');
    refused('counters', () => fresh().noteCounter(acc.addressBytes, 0n, 1n << 64n), /a use counter is a Uint<64>/, 'a counter of 2^64');
    counterCases.push({ case: 'stale known counters 0, 2, 7, 10, 11, 9000 with the entry at 3 (auth_nonce 10)', found: '3' });
    ok('counters', 3);
  }
  // 4. an entry enrolled at a counter above auth_nonce (an entry-taking add_device): not reached by
  //    the scan, refused until its counter is given, then used and rolled
  {
    const acc = rollingAccount(20n, [[d, 9000n]]);
    await refusedAsync('counters', () => rotateEncKeyWithEvmK256(acc, fresh(), rnd()), /no live entry for this device at the current epoch, at any use counter from 0 to auth_nonce \(20\)/, 'an entry above auth_nonce, its counter not given');
    assert.equal(acc.calls.length, 0, 'nothing sent');
    const dev = fresh();
    dev.noteCounter(acc.addressBytes, 0n, 9000n);
    assert.equal((await rotate(acc, dev)).counter, 9000n, 'with the counter given, the call presents 9000');
    assert.equal((await rotate(acc, dev)).counter, 9001n, 'and the next call its successor, from the known counter');
    assert.equal(await resolveEvmK256Counter(rollingAccount(20n, [[d, 9000n]]), fresh(), { counter: 9000n }), 9000n, 'an explicit counter above auth_nonce');
    counterCases.push({ case: 'entry at 9000 above auth_nonce 20: refused, then given, used, rolled', counters: ['9000', '9001'] });
    ok('counters', 3);
  }
  // 5. recover_cancel past 4096 (the veto must never lock out)
  {
    const acc = rollingAccount(4200n, [[d, 4100n]]);
    const r = await recoverCancelWithEvmK256(acc, fresh());
    assert.ok(r.auth.use_counter === 4100n && acc.calls.at(-1)?.circuit === 'recover_cancel_with_evm_k256' && acc.isLive(d, 4101n), 'recover_cancel at counter 4100');
    counterCases.push({ case: 'recover_cancel at 4100', counter: '4100' });
    ok('counters');
  }
  // 6. an uncached restore past 4096
  {
    const acc = rollingAccount(4600n, [[d, 4500n]]);
    const r = await restoreEvmK256Device({ wallet: new RecordingWallet(A), network: NET, accountIndex: 0, finds: evmK256DeviceFinds(acc) });
    assert.ok(r.ok === true && r.source === 'search' && eq(r.value.blind, d.blind), 'no record: found at counter 4500');
    const { blind: _x, ...lostRec } = d.toRecord();
    const r2 = await restoreEvmK256Device({ wallet: new RecordingWallet(A), record: lostRec as EvmK256RosterRecord, finds: evmK256DeviceFinds(acc) });
    assert.ok(r2.ok === true && r2.source === 'stored-format' && eq(r2.value.blind, d.blind), 'the cache lost: found at counter 4500');
    assert.equal((await rotate(acc, r2.ok === true ? r2.value : fresh())).counter, 4500n, 'the restored device calls at 4500');
    const acc2 = rollingAccount(5000n, [[d, 5000n]]);
    const found = await restoreEvmDevices(new RecordingWallet(A), NET, [
      { address: acc2.addressBytes, epoch: 0n, authNonce: 5000n, isMember: (e) => eq(e, d.entryAt(acc2.addressBytes, 0n, 5000n)) },
    ], { maxIndex: 0 });
    assert.deepEqual(found.map((f) => [f.accountIndex, f.counter]), [[0n, 5000n]], 'restoreEvmDevices finds index 0 at counter 5000');
    await assert.rejects(() => restoreEvmDevices(new RecordingWallet(A), NET, [{ address: acc2.addressBytes, epoch: 0n, isMember: () => false } as any]), /each account gives its auth_nonce/);
    counted('counters');
    counterCases.push({ case: 'uncached restore at 4500 and 5000', counters: ['4500', '5000'] });
    ok('counters', 4);
  }
  // 7. counters at the top of the Uint<64> range: a known counter at, or just below, 2^64 - 1 scans
  //    forward to the largest counter only (never 2^64, which no entry can have), then from 0
  {
    const MAX = (1n << 64n) - 1n;
    const acc = rollingAccount(10n, [[d, 3n]]);
    for (const known of [MAX, MAX - 1n, MAX - 10n]) {
      const dev = fresh();
      dev.noteCounter(acc.addressBytes, 0n, known);
      const p0 = acc.probes;
      assert.equal(await resolveEvmK256Counter(acc, dev), 3n, `a noted counter ${known === MAX ? '2^64 - 1' : `2^64 - 1 - ${MAX - known}`}: the live counter 3 is found`);
      assert.equal(acc.probes - p0, Number(MAX - known) + 1 + 4, 'forward to 2^64 - 1, then 0..3');
      assert.equal(await resolveEvmK256Counter(acc, fresh(), { counter: known }), 3n, 'the same hint given as an option');
    }
    // a device whose live entry is at 2^64 - 1 itself
    const top = rollingAccount(10n, [[d, MAX]]);
    const devTop = fresh(); devTop.noteCounter(top.addressBytes, 0n, MAX);
    assert.equal(await resolveEvmK256Counter(top, devTop), MAX, 'a live entry at 2^64 - 1 is found from its counter');
    // a counter that is not a Uint<64> is refused before the ledger is read
    for (const [bad, why] of [[MAX + 1n, '2^64'], [-1n, '-1'], [3 as any, 'the number 3'], ['3' as any, 'the string "3"']] as const) {
      const r0 = acc.reads;
      await refusedAsync('counters', () => resolveEvmK256Counter(acc, fresh(), { counter: bad as bigint }), /a use counter is a Uint<64>/, `an explicit counter ${why}`);
      await refusedAsync('counters', () => rotateEncKeyWithEvmK256(acc, fresh(), rnd(), { counter: bad as bigint }), /a use counter is a Uint<64>/, `a helper given the counter ${why}`);
      assert.equal(acc.reads, r0, `the ledger is not read for the counter ${why}`);
    }
    counterCases.push({ case: 'hints at 2^64 - 1, 2^64 - 2 and 2^64 - 11 with the entry at 3; an entry at 2^64 - 1; non-Uint<64> counters refused before reading', found: '3' });
    ok('counters', 3);
  }
  // 8. a long scan runs in chunks: it yields to the event loop between chunks (other work runs), a signal
  //    stops it with a clear error, and the entry deep in the range is still found
  {
    const acc = rollingAccount(5000n, [[d, 5000n]]);
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 0);
    const seen: number[] = [];
    const watched = (a: ReturnType<typeof rollingAccount>, onProbe: (n: number) => void = () => {}) => ({
      ...a,
      async ledgerState() {
        const l = await a.ledgerState();
        return { ...l, devices: { member: (e: Uint8Array) => { seen.push(ticks); onProbe(seen.length); return l.devices.member(e); } } };
      },
    });
    try {
      assert.equal(await resolveEvmK256Counter(watched(acc), fresh()), 5000n, 'the entry at 5000 is found');
      assert.equal(seen.length, 5001, 'every counter 0..5000 probed once');
      assert.ok(seen[seen.length - 1] > seen[0], 'other work ran during the scan (it yields between chunks)');
      assert.ok(new Set(seen).size >= 5, `the scan yielded several times (${new Set(seen).size} tick values over 5,001 probes)`);
      assert.equal(seen[255], seen[0], 'no yield inside the first chunk: a live known counter and its successor cost no yield');
      // aborted mid-scan, through a helper: refused at the next chunk boundary, nothing signed or sent
      seen.length = 0;
      const ctl = new AbortController();
      const w = new RecordingWallet(A);
      const dev = new EvmK256Device(d.pk, d.blind, NET, 0n, w);
      const acc2 = rollingAccount(5000n, [[d, 5000n]]);
      let err: any;
      try { await rotateEncKeyWithEvmK256(watched(acc2, (n) => { if (n === 1000) ctl.abort(new Error('the user left the page')); }) as any, dev, rnd(), { signal: ctl.signal }); }
      catch (e) { err = e; }
      assert.ok(err && /^evm_k256: the use-counter scan was aborted after 1024 probes$/.test(err.message), `aborted with a clear error: ${err?.message}`);
      assert.equal(err.cause?.message, 'the user left the page', 'the signal\'s reason is the cause');
      assert.ok(seen.length === 1024 && w.requests.filter((r) => r.method !== 'address').length === 0 && acc2.calls.length === 0, 'stopped at the chunk boundary; nothing signed, nothing sent');
    } finally { clearInterval(timer); }
    // an aborted signal refuses every caller before the ledger is read and before the wallet is asked
    const ctl = new AbortController(); ctl.abort();
    const signal = ctl.signal;
    const acc3 = rollingAccount(5n, [[d, 5n]]);
    const w3 = new RecordingWallet(A);
    const dev3 = new EvmK256Device(d.pk, d.blind, NET, 0n, w3);
    const other = await EvmK256Device.enrol(new SoftwareEvmWallet(scalar()), NET, 0);
    const grantee = evmK256GranteeInput(evmDeviceDescriptor(other), { label: LABEL }, 1n);
    const surface = { ...acc3, async heldCoin() { return { nonce: rnd(), color: rnd(), value: 9n, mt_index: 0n }; } } as any;
    const helpers: [string, () => Promise<unknown>][] = [
      ['resolveEvmK256Counter', () => resolveEvmK256Counter(surface, dev3, { signal })],
      ['rotateEncKeyWithEvmK256', () => rotateEncKeyWithEvmK256(surface, dev3, rnd(), { signal })],
      ['appendInboxWithEvmK256', () => appendInboxWithEvmK256(surface, dev3, rnd(192), { signal })],
      ['withdrawUnshieldedWithEvmK256', () => withdrawUnshieldedWithEvmK256(surface, dev3, rnd(), 1n, rnd(), SITE, { signal })],
      ['withdrawShieldedWithEvmK256', () => withdrawShieldedWithEvmK256(surface, dev3, rnd(), rnd(), 1n, SITE, { signal })],
      ['authoriseWithdrawShieldedToContract', () => authoriseWithdrawShieldedToContract(surface, dev3, rnd(), rnd(), 1n, SITE, { signal })],
      ['addDeviceWithEvmK256', () => addDeviceWithEvmK256(surface, dev3, evmDeviceDescriptor(other), { signal })],
      ['removeDeviceWithEvmK256', () => removeDeviceWithEvmK256(surface, dev3, evmDeviceDescriptor(other), 0n, 0n, { signal })],
      ['removeUnknownDeviceWithEvmK256', () => removeUnknownDeviceWithEvmK256(surface, dev3, rnd(), { signal })],
      ['issueGrantWithEvmK256', () => issueGrantWithEvmK256(surface, dev3, grantee, {} as any, { signal })],
      ['revokeGrantWithEvmK256', () => revokeGrantWithEvmK256(surface, dev3, grantee, { signal })],
      ['revokeAllGrantsWithEvmK256', () => revokeAllGrantsWithEvmK256(surface, dev3, { signal })],
      ['publishRecoverySessionWithEvmK256', () => publishRecoverySessionWithEvmK256(surface, dev3, { recoveryPk: { x: 1n, y: 2n }, sessionNonce: rnd(), phi: [1n], wrap: rnd(64) }, { signal })],
      ['recoverCancelWithEvmK256', () => recoverCancelWithEvmK256(surface, dev3, { signal })],
      ['evmK256DeviceFinds', () => Promise.resolve().then(() => evmK256DeviceFinds(surface, { signal })(dev3))],
      ['restoreEvmDevices', () => restoreEvmDevices(w3, NET, [{ address: acc3.addressBytes, epoch: 0n, authNonce: 5n, isMember: () => false }], { maxIndex: 0, signal })],
    ];
    for (const [name, call] of helpers) {
      await refusedAsync('counters', call, /^Error: evm_k256: the use-counter scan was aborted after 0 probes$/, `${name} with an aborted signal`);
    }
    assert.ok(acc3.reads === 0 && acc3.probes === 0 && w3.requests.length === 0 && acc3.calls.length === 0, 'no ledger read, no probe, no wallet request, nothing sent');
    // a signal aborted after evmK256DeviceFinds was made, and one aborted during restoreEvmDevices' scan
    const late = new AbortController();
    const finds = evmK256DeviceFinds(acc3, { signal: late.signal });
    late.abort();
    const lateReads = acc3.reads;
    await refusedAsync('counters', () => finds(dev3), /aborted after 0 probes/, 'a predicate whose signal was aborted after it was made');
    assert.equal(acc3.reads, lateReads, 'the aborted predicate does not read the ledger');
    // a signal aborted while the ledger is read: refused before the first probe
    const c8 = new AbortController();
    const acc8 = rollingAccount(3000n, [[d, 3000n]]);
    const slow = { ...acc8, async ledgerState() { const l = await acc8.ledgerState(); c8.abort(); return l; } };
    await refusedAsync('counters', () => resolveEvmK256Counter(slow as any, fresh(), { signal: c8.signal }), /aborted after 0 probes/, 'a signal aborted while the ledger is read');
    assert.equal(acc8.probes, 0, 'no entry probed once the signal was aborted during the read');
    const mid = new AbortController();
    const acc4 = rollingAccount(3000n, [[d, 3000n]]);
    let n4 = 0;
    await refusedAsync('counters', () => restoreEvmDevices(new RecordingWallet(A), NET,
      [{ address: acc4.addressBytes, epoch: 0n, authNonce: 3000n, isMember: (e) => { if (++n4 === 600) mid.abort(); return acc4.isLive(d, 3000n) && eq(e, d.entryAt(acc4.addressBytes, 0n, 3000n)); } }],
      { maxIndex: 0, signal: mid.signal }), /aborted after 768 probes/, 'restoreEvmDevices aborted during its scan');
    // aborted mid-scan through the shared frame of the other helpers (recover_cancel), through
    // evmK256DeviceFinds inside a restore, and before restoreEvmDevices' scan starts (while the wallet signs)
    {
      const c5 = new AbortController();
      const acc5 = rollingAccount(3000n, [[d, 3000n]]);
      seen.length = 0;
      await refusedAsync('counters', () => recoverCancelWithEvmK256(watched(acc5, (n) => { if (n === 300) c5.abort(); }) as any, fresh(), { signal: c5.signal }),
        /aborted after 512 probes/, 'recover_cancel aborted during its scan');
      const c6 = new AbortController();
      const acc6 = rollingAccount(3000n, [[d, 3000n]]);
      seen.length = 0;
      await refusedAsync('counters', () => restoreEvmK256Device({ wallet: new RecordingWallet(A), network: NET, accountIndex: 0,
        finds: evmK256DeviceFinds(watched(acc6, (n) => { if (n === 300) c6.abort(); }) as any, { signal: c6.signal }) }), /aborted after 512 probes/, 'evmK256DeviceFinds aborted during its scan');
      const c7 = new AbortController();
      const acc7 = rollingAccount(3000n, [[d, 3000n]]);
      const aborting = new RecordingWallet(A);
      const sign = aborting.personalSign.bind(aborting);
      aborting.personalSign = async (m: Uint8Array) => { c7.abort(); return sign(m); };
      await refusedAsync('counters', () => restoreEvmDevices(aborting, NET, [{ address: acc7.addressBytes, epoch: 0n, authNonce: 3000n, isMember: (e) => { acc7.probes++; return eq(e, d.entryAt(acc7.addressBytes, 0n, 3000n)); } }],
        { maxIndex: 0, signal: c7.signal }), /aborted after 0 probes/, 'restoreEvmDevices aborted while the wallet signed: no probe');
      assert.equal(acc7.probes, 0, 'no entry probed after the abort');
    }
    counterCases.push({ case: 'a scan of 5,001 probes yields between chunks of 256 and finds 5000; aborted at probe 1,000 it stops at 1,024 with the reason as cause; aborted through recover_cancel, evmK256DeviceFinds and restoreEvmDevices; every caller refuses an aborted signal before reading the ledger', yielded: true });
    ok('counters', 5);
  }
  report.counters = counterCases;
  console.log(`  ✓ counters: ${tally.counters.pass} cases (4095 → 4096 → 4097 with the same and a fresh device object, 5000, stale known counters, an entry above auth_nonce given its counter, recover_cancel at 4100, uncached restores at 4500 and 5000, hints at the top of the Uint<64> range, a chunked scan that yields and is aborted, every caller's signal); ${tally.counters.refused} refused`);
}

// ── The read seed: in memory only, derived again from one signature ─────────

const readCases: Record<string, unknown>[] = [];
{
  const A = new SoftwareEvmWallet(scalar()), B = new SoftwareEvmWallet(scalar());
  const issuer = rnd(), other = rnd();
  const shop = grantLabel('shop.example');
  const g = await EvmK256Grantee.enrol(A, NET, issuer, LABEL, 3n);
  await knowSeed(A, NET, issuer);
  const grec = grecOf(g);
  const grequest = granteeBlindMessageBytes({ scheme: 'evm_k256', network: NET, identity: A.addressBytes, issuingAccount: issuer });
  const want = g.readKey(issuer), wantShop = g.withGrant(shop, 0n).readKey(issuer), wantOther = g.readKey(other);
  const signs = (w: RecordingWallet) => w.requests.filter((r) => r.method !== 'address');
  const restored = async (w: RecordingWallet) => {
    const r = await restoreEvmK256Grantee({ wallet: w, label: LABEL, slot: 3n, record: grec });
    assert.ok(r.ok === true && r.source === 'cache');
    return (r as { value: EvmK256Grantee }).value;
  };
  // an enrolled grantee holds its seed: no signature to read
  {
    const w = new RecordingWallet(A);
    const enrolled = await EvmK256Grantee.enrol(w, NET, issuer, LABEL, 3n);
    const before = signs(w).length;
    const k = await enrolled.readKeyFromWallet(issuer);
    assert.ok(eq(k.secretKey, want.secretKey) && signs(w).length === before && before === 2, 'an enrolled grantee reads with no further signature');
    readCases.push({ case: 'enrolled', signaturesToRead: 0 });
    ok('read seed');
  }
  // restored from the cache: exactly one signature, then none, for every grant of the session
  {
    const w = new RecordingWallet(A);
    const x = await restored(w);
    assert.equal(signs(w).length, 0, 'the cache restores the grantee with no signature');
    const k1 = await x.readKeyFromWallet(issuer);
    assert.ok(eq(k1.secretKey, want.secretKey) && eq(k1.publicKey, want.publicKey), 'the same read key as at enrolment');
    assert.ok(signs(w).length === 1 && signs(w)[0].method === 'personalSign' && eq((signs(w)[0] as { message: Uint8Array }).message, grequest), 'one signature, of the grantee request');
    const k2 = await x.readKeyFromWallet(issuer);
    const k3 = await x.withGrant(shop, 0n).readKeyFromWallet(issuer);
    const k4 = x.readKey(other);
    assert.ok(eq(k2.secretKey, want.secretKey) && eq(k3.secretKey, wantShop.secretKey) && eq(k4.secretKey, wantOther.secretKey), 'the session\'s seed serves every grant and account');
    assert.equal(signs(w).length, 1, 'no further signature while the seed is in memory');
    assert.ok(!JSON.stringify(grecOf(x)).includes(hex(evmK256GrantReadSeed(canonicalEvmSignature(await A.personalSign(grequest))))), 'the record written after reading still holds no seed');
    readCases.push({ case: 'restored from the cache', signaturesToRead: 1, thenForOtherGrants: 0 });
    ok('read seed', 3);
  }
  // concurrent first reads ask once
  {
    const w = new RecordingWallet(A);
    const x = await restored(w);
    const [k1, k2] = await Promise.all([x.readKeyFromWallet(issuer), x.withGrant(shop, 0n).readKeyFromWallet(issuer)]);
    assert.ok(eq(k1.secretKey, want.secretKey) && eq(k2.secretKey, wantShop.secretKey) && signs(w).length === 1, 'two concurrent first reads, one signature');
    ok('read seed');
  }
  // two restored sessions (two wallet instances of the key): the same read key
  {
    const w1 = new RecordingWallet(new SoftwareEvmWallet(A.sk)), w2 = new RecordingWallet(new SoftwareEvmWallet(A.sk));
    const k1 = await (await restored(w1)).readKeyFromWallet(issuer), k2 = await (await restored(w2)).readKeyFromWallet(issuer);
    assert.ok(eq(k1.secretKey, k2.secretKey) && eq(k1.secretKey, want.secretKey) && signs(w1).length === 1 && signs(w2).length === 1, 'two sessions, one read key');
    readCases.push({ case: 'two restored sessions', equal: true });
    ok('read seed');
  }
  // the cache lost: the restore's signatures give the seed, no extra signature
  {
    const w = new RecordingWallet(A);
    const { blind: _b, ...lost } = grec;
    const r = await restoreEvmK256Grantee({ wallet: w, label: LABEL, slot: 3n, record: lost as EvmK256GranteeRecord, finds: (x) => eq(x.grantId(issuer), g.grantId(issuer)) });
    assert.ok(r.ok === true && r.value.hasReadSeed === true);
    const k = await (r as { value: EvmK256Grantee }).value.readKeyFromWallet(issuer);
    assert.ok(eq(k.secretKey, want.secretKey) && signs(w).length === 2, 'the blind derived again brings the seed: no third signature');
    readCases.push({ case: 'restored with the cache lost', signaturesToRead: 0 });
    ok('read seed');
  }
  // refusals, after one signature, with the seed left absent
  {
    const w = new RecordingWallet(B);
    const x = await restored(w);
    await refusedAsync('read seed', () => x.readKeyFromWallet(issuer), namedSigner(A, B), 'another key\'s wallet signing the read request');
    assert.ok(signs(w).length === 1 && x.hasReadSeed === false);
    const h = new RecordingWallet(new SoftwareEvmWallet(A.sk, true));
    const y = await restored(h);
    await refusedAsync('read seed', () => y.readKeyFromWallet(issuer), /not deterministic/, 'a non-deterministic wallet of the key');
    assert.ok(signs(h).length === 1 && y.hasReadSeed === false);
    await refusedAsync('read seed', () => EvmK256Grantee.fromRecord(grec, LABEL, 3n).readKeyFromWallet(issuer), /has no wallet/, 'a grantee read from its record without a wallet');
    await refusedAsync('read seed', () => new EvmK256Grantee(g.pk, g.blind, LABEL, 3n, new RecordingWallet(A)).readKeyFromWallet(issuer), /issuing account is not known/, 'a grantee whose issuing account is not known');
  }
  // no grantee record written in this suite holds a read seed
  {
    assert.ok(GRANTEE_RECORDS.length >= 5 && KNOWN_SEEDS.size >= 3);
    for (const r of GRANTEE_RECORDS) {
      assert.ok(!('readSeed' in r), 'no readSeed member');
      const text = JSON.stringify(r).toLowerCase();
      for (const s of KNOWN_SEEDS) assert.ok(!text.includes(s), 'no known read seed in any written record');
    }
    ok('read seed', GRANTEE_RECORDS.length);
  }
  report.readSeed = { cases: readCases, recordsChecked: GRANTEE_RECORDS.length, seedsKnown: KNOWN_SEEDS.size };
  console.log(`  ✓ read seed: in memory only (${GRANTEE_RECORDS.length} grantee records written, none holds one of ${KNOWN_SEEDS.size} known seeds); a cache-restored grantee reads after exactly one signature, then none for its other grants (concurrent reads: one); two sessions, one read key; a re-derived or enrolled grantee reads with none; ${tally['read seed'].refused} refusals, the seed left absent`);
}

// ── Every wallet request of this suite ───────────────────────────────────────

{
  const counts = { address: 0, personalSign: 0, signTypedData: 0 };
  const blindRequests = { device: 0, grantee: 0 };
  for (const { r } of ALL_REQUESTS) {
    counts[r.method]++;
    if (r.method === 'signTypedData') {
      assert.doesNotThrow(() => checkEip712V1TypedData(r.typedData), 'every typed data a wallet was asked to sign is V1');
      assert.deepEqual(r.typedData.domain, eip712V1Domain());
    } else if (r.method === 'personalSign') {
      // each request must be, byte for byte, the device or grantee blind
      // request its own lines name
      const text = new TextDecoder().decode(r.message);
      const device = /^Midnight Passport account privacy key \(v1\)\nNetwork: ([a-z0-9-]+)\nWallet: Ethereum address (0x[0-9a-fA-F]{40})\nAccount index: (\d+)\n/.exec(text);
      const grantee = /^Midnight Passport grantee privacy key \(v1\)\nRole: grantee\nNetwork: ([a-z0-9-]+)\nWallet: Ethereum address (0x[0-9a-fA-F]{40})\nIssuing account: ([0-9a-f]{64})\n/.exec(text);
      const unhexAddress = (a: string) => new Uint8Array(Buffer.from(a.slice(2), 'hex'));
      const rebuilt = device
        ? blindMessageBytes({ scheme: 'evm_k256', network: device[1], identity: unhexAddress(device[2]), accountIndex: BigInt(device[3]) })
        : grantee
          ? granteeBlindMessageBytes({ scheme: 'evm_k256', network: grantee[1], identity: unhexAddress(grantee[2]), issuingAccount: new Uint8Array(Buffer.from(grantee[3], 'hex')) })
          : undefined;
      assert.ok(rebuilt && eq(rebuilt, r.message), `every personal_sign request is a blind request: ${text.slice(0, 60)}`);
      blindRequests[device ? 'device' : 'grantee']++;
    }
  }
  assert.ok(counts.personalSign > 0 && counts.signTypedData > 0);
  assert.ok(blindRequests.device > 0 && blindRequests.grantee > 0);
  report.requests = { ...counts, blindRequests };
  ok('requests', counts.personalSign + counts.signTypedData);
  console.log(`  ✓ requests: ${counts.signTypedData} eth_signTypedData_v4 requests, all V1 typed data; ${counts.personalSign} personal_sign requests, all blind requests (${blindRequests.device} device, ${blindRequests.grantee} grantee); ${counts.address} address reads; no other method`);
}

if (process.env.EVIDENCE_DIR) {
  fs.mkdirSync(process.env.EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.EVIDENCE_DIR, 'evm-k256-client-offline.json'), JSON.stringify({ tally, ...report }, null, 1) + '\n');
}
console.log('\n◆ evm-k256-client-offline: PASS');
