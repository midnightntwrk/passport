// Recovery with `evm_k256` devices, through the compact-runtime local
// simulator (no node, no proof), with explicit wall-clock control. It extends
// upstream's recovery-sim.ts, which is left unchanged and drives the JubJub
// arm only, to an account whose devices are Ethereum accounts:
//
//   - the readable approval: PublishRecoverySession shows
//     the circuit-fixed line "Sets this account's recovery key" and every
//     operand in full (the new recovery key's JubJub coordinates and the four
//     phi values little-endian; the session identifier; phiLength; the
//     64-byte wrap as `bytes`), exactly the values the chip then stores; the
//     digest is the contract's own;
//   - publish_recovery_session_with_evm_k256: the binding matrix (every
//     signed member changed after signing, every operand changed after
//     signing), the shared chip's freshness and slot rules under a valid
//     signature, the client's refusals, unauthorised keys;
//   - the shared JubJub recovery gate (recover_submit) on an evm account,
//     pending exclusivity (no session while a recovery is pending), the veto
//     window;
//   - recover_cancel_with_evm_k256 by a second evm device: its binding (a
//     RevokeAllGrants signature over the same bare frame, a stale nonce, an
//     unenrolled key), the cancelled submission replayed, nothing to cancel;
//   - finalisation (upstream #183: the device set is cleared): every old
//     evm_k256 device is refused afterwards, INCLUDING an entry an upstream
//     arm planted at device_epoch + 1 before the recovery (README erratum 7:
//     without the clear it would be live at the new epoch); the old JubJub
//     device too; the JubJub successor enrols a fresh evm device at the new
//     epoch, which publishes a fresh session through the arm;
//   - a grant issued before the recovery is refused after the finalisation
//     (its epoch is one behind), while a grant the new device issues lands.
//
// Writes $EVIDENCE_DIR/evm-k256-recovery-sim.json when EVIDENCE_DIR is set.

import { withExecutedHints, storeCoin, TEST_SITE } from './evm-k256-hint-fill.js';
import { pureCircuits as hintPure } from '../wallet/contract.js';
import { randomBytes } from 'node:crypto';
import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';

import { Contract, ledger, pureCircuits as pc, type JubjubPoint } from '../wallet/contract.js';
import { hexToBytes } from '../wallet/hex.js';
import { makeWitnesses, emptyCoinStore, type CoinStorePrivateState } from '../wallet/witnesses.js';
import { JubjubDevice, K256Device, jubjubChallenges, authArgs, grantAuthArgs, RECIPIENT_USER_ADDRESS, type GrantOpening } from '../wallet/signer.js';
import {
  SoftwareEvmWallet, EvmK256Device, EvmK256Grantee, evmK256DescriptorInput, evmDeviceDescriptor, evmK256RecoverySession, evmK256IssueArgs, evmK256GrantScopeSalt, ed25519Args, EVM_K256_UNUSED_DESCRIPTOR,
  parseEvmSignature } from '../wallet/signer-evm-k256.js';
import { evmK256Messages, typedDataDigest, typeString, fieldLE, type Eip712TypedData, type IssueScope, type RecoverySession } from '../wallet/evm-k256-codec.js';
import { grantLabel } from '../wallet/descriptors.js';
import { leHint, evmK256SeamHint } from '../wallet/evm-k256-hints.js';
import {
  recoveryKey, signRecoverSubmit, recoverSubmitArgs, recoverSubmitChallenge, readArtefactSet, matchesRecoveryPk, eqPoint,
  JUBJUB_IDENTITY, JUBJUB_ORDER_TWO,
} from '../wallet/recovery-gate.js';
import {
  deriveShare, split, reconstruct, fieldToBytes, guardianSecretFromPrf, sealWrap, openWrap, newRecoverySecret, newSessionNonce,
  type IndexedShare,
} from '../wallet/recovery.js';

const rnd = (n = 32) => new Uint8Array(randomBytes(n));
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const clone = <T>(t: T): T => JSON.parse(JSON.stringify(t));

// ── Reporting (the lane's offline shape) ────────────────────────────────────

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(condition: boolean, label: string) {
  if (condition) { pass++; console.log(`  ✓ ${label}`); } else { fail++; failures.push(label); console.log(`  ✗ ${label}`); }
}
/** Every refusal with the generated JavaScript's (or the client's) message,
 *  for the evidence: the refusing layer of each negative. */
const refusals: { label: string; message: string }[] = [];
async function expectAbort(label: string, f: () => Promise<unknown>, needle: string | RegExp) {
  try { await f(); ok(false, `${label} (NOT refused)`); }
  catch (e: any) {
    const m = String(e?.message ?? e);
    refusals.push({ label, message: m.slice(0, 240) });
    const hit = typeof needle === 'string' ? m.includes(needle) : needle.test(m);
    ok(hit, `${label}${hit ? '' : ` (refused by "${m.slice(0, 160)}", expected ${String(needle)})`}`);
  }
}
const sections: { label: string; pass: number; fail: number }[] = [];
async function section(label: string, f: () => Promise<void>) {
  const p0 = pass, f0 = fail;
  console.log(`── ${label}`);
  try { await f(); } catch (e: any) { ok(false, `${label}: unexpected error ${String(e?.message ?? e).slice(0, 300)}`); }
  sections.push({ label, pass: pass - p0, fail: fail - f0 });
}

// ── The simulated account ───────────────────────────────────────────────────

const WINDOW = 3n * 24n * 3600n; // upstream recovery-sim's window
const PUBLISH = 'publish_recovery_session_with_evm_k256';
const CANCEL = 'recover_cancel_with_evm_k256';
const ROTATE = 'rotate_enc_key_with_evm_k256';
const EFFECT = "Sets this account's recovery key";

const contract: any = new (Contract as any)(makeWitnesses());
const impure: Record<string, (...a: any[]) => Promise<any>> = contract.impureCircuits;
const coinPk = { bytes: rnd() };
const addressHex: string = sampleContractAddress();
const address = hexToBytes(addressHex.replace(/^0x/, ''));
let privateState: CoinStorePrivateState = emptyCoinStore();
let time = 1_800_000_000;
const encSecret = rnd();
const birth = newRecoverySecret();
const E = await EvmK256Device.enrol(SoftwareEvmWallet.generate(), 'undeployed', 0);
const salt = rnd();
const init = await contract.initialState(createConstructorContext(privateState, coinPk),
  E.bootCommitment(salt), rnd(), recoveryKey(birth.field).pk, sealWrap(birth.bytes, new Uint8Array(32), encSecret), WINDOW);
let state: any = init.currentContractState;
const L = () => ledger(state) as any;

async function call(name: string, args0: unknown[]) {
  const args = withExecutedHints(hintPure, { account: address, get ledger() { return L(); }, coin: (c) => storeCoin(privateState, c) }, name, args0);
  const ctx: any = createCircuitContext({ circuitId: name, contractAddress: addressHex, coinPublicKeyOrZswapState: coinPk,
    contractState: state, privateState, time } as any);
  const res = await impure[name](ctx, ...args);
  state = res.context.callContext.currentQueryContext.state;
  privateState = res.context.callContext.currentPrivateState ?? privateState;
  return res;
}
/** A refused call must leave the state untouched (atomic abort). */
async function refused(label: string, f: () => Promise<unknown>, needle: string | RegExp) {
  const before = { round: L().round as bigint, nonce: L().auth_nonce as bigint, size: L().devices.size() as bigint, pending: L().pending_recovery as boolean };
  await expectAbort(label, f, needle);
  const after = { round: L().round, nonce: L().auth_nonce, size: L().devices.size(), pending: L().pending_recovery };
  if (JSON.stringify(before, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) !== JSON.stringify(after, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) {
    ok(false, `${label}: the refused call changed the state`);
  }
}

// evm devices: the live counter (MIP-0013 S11 rescan) and an authorisation
// over a typed message (signed as given: a tampered message signs the tamper)
const counterOf = (d: EvmK256Device): bigint => {
  for (let k = 0n; k < 256n; k++) if (L().devices.member(d.entryAt(address, L().device_epoch, k))) return k;
  return -1n;
};
const frame = (d: EvmK256Device) => ({ account: address, device: d.address, authNonce: L().auth_nonce as bigint });
const authOf = async (d: EvmK256Device, td: Eip712TypedData, counter = counterOf(d)) => {
  const { arm, ...a } = await d.authorise(td, counter < 0n ? 0n : counter);
  return a;
};
const sessionArgs = (s: RecoverySession) => [s.recoveryPk, s.sessionNonce, ...s.phi, s.phiLen, s.wrap];
async function publish(d: EvmK256Device, s: RecoverySession, tamper?: (t: any) => void, executed: RecoverySession = s) {
  const td = evmK256Messages.publishRecoverySession(frame(d), s);
  const signed = tamper ? clone(td) : td;
  if (tamper) tamper(signed);
  return call(PUBLISH, [...sessionArgs(executed), signed.domain.verifyingContract === td.domain.verifyingContract ? await authOf(d, signed) : uncheckedAuthOf(d, signed)]);
}
/** The authorising material of the device's software key's signature over
 *  `td` as given, built without the client's checks: the client refuses
 *  typed data under another domain before the wallet is asked, so only a
 *  client without that check presents such a signature to the circuit. */
function uncheckedAuthOf(d: EvmK256Device, td: Eip712TypedData) {
  const digest = typedDataDigest(td);
  const sig = parseEvmSignature((d.wallet as SoftwareEvmWallet).signDigest(digest));
  const counter = counterOf(d);
  return { pk: d.pk, use_counter: counter < 0n ? 0n : counter, blind: d.blind, sig: { r: sig.r, s: sig.s },
    hint: evmK256SeamHint(d.pk, digest, BigInt((td.message as { authNonce: string }).authNonce)) };
}
async function cancel(d: EvmK256Device, td?: Eip712TypedData) {
  return call(CANCEL, [await authOf(d, td ?? evmK256Messages.cancelRecovery(frame(d)))]);
}
const jctx = () => ({ contractAddress: address, authNonce: L().auth_nonce as bigint });
const jCounter = (j: JubjubDevice): bigint => {
  for (let k = 0n; k < 256n; k++) if (L().devices.member(j.entryAt(address, L().device_epoch, k))) return k;
  return -1n;
};

// A guardian session (upstream recovery-sim's shape): three guardians at
// threshold two publish two phi values.
interface Session { secretField: bigint; secretBytes: Uint8Array; sid: Uint8Array; phi: bigint[]; shares: IndexedShare[]; t: number; s: RecoverySession }
function newSession(): Session {
  const t = 1;
  const guardians = [0, 1, 2].map(() => guardianSecretFromPrf(rnd()));
  const sec = newRecoverySecret();
  const sid = newSessionNonce();
  const shares: IndexedShare[] = guardians.map((g, i) => ({ index: i + 1, sigma: deriveShare(sid, address, g) }));
  const phi = split(sec.field, shares, t);
  const s = evmK256RecoverySession({ recoveryPk: recoveryKey(sec.field).pk, sessionNonce: sid, phi, wrap: sealWrap(sec.bytes, address, encSecret) });
  return { secretField: sec.field, secretBytes: sec.bytes, sid, phi, shares, t, s };
}
/** The shared JubJub recovery gate (recover_submit), as sim.ts drives it. */
function submitArgs(sField: bigint, successor: JubjubDevice, successorRecoveryPk: JubjubPoint, nowUpper: bigint, nonce?: bigint): unknown[] {
  const l = L();
  const n = nonce ?? l.auth_nonce;
  const auth = signRecoverSubmit(recoveryKey(sField), successor,
    recoverSubmitChallenge({ contractAddress: address, authNonce: n }, l.recovery_pk, successor.pk, successorRecoveryPk, l.device_epoch + 1n, nowUpper),
    { successorRecoveryPk, expectedEpoch: l.device_epoch, expectedNonce: n, nowUpper });
  return recoverSubmitArgs(auth);
}

// ═════════════════════════════════════════════════════════════════════════════

await call('activate_initial_device_with_evm_k256', E.activationArgs(salt));
const S1 = newSession();
const E2 = await EvmK256Device.enrol(SoftwareEvmWallet.generate(), 'undeployed', 0);
const J = JubjubDevice.generate();
const W = await EvmK256Device.enrol(SoftwareEvmWallet.generate(), 'undeployed', 0);
const stranger = await EvmK256Device.enrol(SoftwareEvmWallet.generate(), 'undeployed', 0);
let plant: Uint8Array = new Uint8Array(32);
let epochBefore = 0n;

await section('recovery at birth on an evm_k256 account', async () => {
  ok(L().booted === true && L().device_count === 1n && counterOf(E) === 0n, 'the evm_k256 device is the only device (counter 0)');
  ok(L().recovery_phi_len === 0n && L().recovery_version === 1n && L().pending_recovery === false, 'commitment and wrap present, no vector, nothing pending');
});

await section('the readable approval: every recovery operand in full, the consequence line', async () => {
  const td = evmK256Messages.publishRecoverySession(frame(E), S1.s);
  const m: any = td.message;
  ok(typeString('PublishRecoverySession') === 'PublishRecoverySession(bytes32 account,address device,uint64 authNonce,string effect,bytes32 recoveryKeyX,bytes32 recoveryKeyY,bytes32 sessionNonce,bytes32 phi1,bytes32 phi2,bytes32 phi3,bytes32 phi4,uint8 phiLength,bytes wrap)',
    'the frozen type: frame, effect, the key, the session nonce, four phi values, the length, the wrap');
  ok(m.effect === EFFECT, `the consequence line reads "${EFFECT}"`);
  ok(m.recoveryKeyX === '0x' + hex(fieldLE(S1.s.recoveryPk.x)) && m.recoveryKeyY === '0x' + hex(fieldLE(S1.s.recoveryPk.y)),
    'the new recovery key: both JubJub coordinates, 32 bytes each, little-endian');
  ok(m.sessionNonce === '0x' + hex(S1.sid), 'the session identifier: 32 bytes in full');
  ok([m.phi1, m.phi2, m.phi3, m.phi4].every((v: string, i: number) => v === '0x' + hex(fieldLE(S1.s.phi[i])) && v.length === 66),
    'phi1..phi4: each Field value in full, little-endian (unused slots shown as zero)');
  ok(m.phiLength === '2', 'phiLength shown as a number');
  ok(m.wrap === '0x' + hex(S1.s.wrap) && m.wrap.length === 2 + 128, 'the 64-byte wrap in full hex (no fingerprint, no truncation)');
  const oracle = pc.eip712_v1_digest(pc.evm_k256_struct_publish_recovery_session(address, E.address, L().auth_nonce,
    leHint(L().auth_nonce, 8), S1.s.recoveryPk, S1.s.sessionNonce, ...S1.s.phi, S1.s.phiLen, S1.s.wrap));
  ok(eq(typedDataDigest(td), oracle), "the digest the wallet signs == the contract's own oracle");
});

await section('publish_recovery_session_with_evm_k256: the session lands, exactly the shown values stored', async () => {
  const before = L();
  await publish(E, S1.s);
  const l = L();
  ok(l.recovery_phi_len === 2n, 'three guardians at threshold two publish two (|phi| = n - t)');
  ok(eqPoint(l.recovery_pk, S1.s.recoveryPk as JubjubPoint), 'stored recovery key == the approval\'s');
  ok(eq(l.recovery_session, S1.sid), 'stored session identifier == the approval\'s');
  ok([1n, 2n, 3n, 4n].every((i) => l.recovery_phi.lookup(i) === S1.s.phi[Number(i) - 1]), 'stored phi1..phi4 == the approval\'s');
  ok(eq(l.recovery_wrap, S1.s.wrap), 'stored wrap == the approval\'s');
  ok(openWrap(S1.secretBytes, address, l.recovery_wrap) !== null, 'the ledger wrap opens under the session secret');
  ok(l.auth_nonce === before.auth_nonce + 1n && l.round === before.round + 1n && counterOf(E) === 1n, 'auth_nonce +1, round +1, the device entry rolled to counter 1');
});

await section('binding: every signed member changed after signing (the circuit recomputes the digest)', async () => {
  const S = newSession();
  const other = recoveryKey(newRecoverySecret().field).pk;
  const flipHex = (h: string) => h.slice(0, -2) + (h.slice(-2) === '00' ? '01' : '00');
  const members: [string, (t: any) => void][] = [
    ['effect line', (t) => { t.message.effect = 'Adds a backup'; }],
    ['recoveryKeyX', (t) => { t.message.recoveryKeyX = '0x' + hex(fieldLE(other.x)); }],
    ['recoveryKeyY', (t) => { t.message.recoveryKeyY = '0x' + hex(fieldLE(other.y)); }],
    ['sessionNonce', (t) => { t.message.sessionNonce = flipHex(t.message.sessionNonce); }],
    ['phi1', (t) => { t.message.phi1 = flipHex(t.message.phi1); }],
    ['phi2', (t) => { t.message.phi2 = flipHex(t.message.phi2); }],
    ['phi3 (an unused slot)', (t) => { t.message.phi3 = '0x' + hex(fieldLE(1n)); }],
    ['phi4 (an unused slot)', (t) => { t.message.phi4 = '0x' + hex(fieldLE(1n)); }],
    ['phiLength', (t) => { t.message.phiLength = '3'; }],
    ['wrap (last byte)', (t) => { t.message.wrap = flipHex(t.message.wrap); }],
    ['account', (t) => { t.message.account = '0x' + hex(rnd()); }],
    ['device (another address)', (t) => { t.message.device = '0x' + hex(stranger.address); }],
    ['authNonce', (t) => { t.message.authNonce = String(BigInt(t.message.authNonce) + 1n); }],
    ['domain verifyingContract', (t) => { t.domain.verifyingContract = '0x' + hex(rnd(20)); }],
    ['primary type renamed', (t) => { t.types.PublishBackup = t.types.PublishRecoverySession; delete t.types.PublishRecoverySession; t.primaryType = 'PublishBackup'; }],
  ];
  for (const [name, f] of members) await refused(`signed ${name} changed, executed the original: refused`, () => publish(E, S.s, f), 'invalid signature');
  // the other direction: the signature over S, an operand changed in the call
  const executed: [string, RecoverySession][] = [
    ['another recovery key', { ...S.s, recoveryPk: other }],
    ['another session identifier', { ...S.s, sessionNonce: rnd() }],
    ['phi1 + 1', { ...S.s, phi: [S.s.phi[0] + 1n, S.s.phi[1], 0n, 0n] }],
    ['phi2 + 1', { ...S.s, phi: [S.s.phi[0], S.s.phi[1] + 1n, 0n, 0n] }],
    ['phi length 1', { ...S.s, phiLen: 1n }],
    ['another wrap', { ...S.s, wrap: rnd(64) }],
  ];
  for (const [name, x] of executed) await refused(`signed the session, executed with ${name}: refused`, () => publish(E, S.s, undefined, x), 'invalid signature');
  await refused('a CancelRecovery signature presented as the session approval', async () =>
    call(PUBLISH, [...sessionArgs(S.s), await authOf(E, evmK256Messages.cancelRecovery(frame(E)))]), 'invalid signature');
});

await section('the shared chip under a VALID signature: freshness and slot gating (recovery MIP §5)', async () => {
  const S = newSession();
  const stored = L();
  await refused('a reused session identifier', () => publish(E, { ...S.s, sessionNonce: new Uint8Array(stored.recovery_session) }), 'session nonce reused');
  await refused('a reused recovery commitment', () => publish(E, { ...S.s, recoveryPk: stored.recovery_pk }), 'recovery commitment reused');
  await refused('an all-zero session identifier', () => publish(E, { ...S.s, sessionNonce: new Uint8Array(32) }), 'session nonce is zero');
  await refused('length 2 with phi3 non-zero', () => publish(E, { ...S.s, phi: [1n, 2n, 3n, 0n] }), 'unused phi slot 3 not zero');
  await refused('length 1 with phi2 non-zero', () => publish(E, { ...S.s, phi: [1n, 2n, 0n, 0n], phiLen: 1n }), 'unused phi slot 2 not zero');
  await refused('length 3 with phi4 non-zero', () => publish(E, { ...S.s, phi: [1n, 2n, 3n, 4n], phiLen: 3n }), 'unused phi slot 4 not zero');
  await refused('an empty vector (length 0)', () => publish(E, { ...S.s, phi: [0n, 0n, 0n, 0n], phiLen: 0n }), 'phi must not be empty');
  await refused('a length beyond the slot bound (5)', () => publish(E, { ...S.s, phi: [1n, 2n, 3n, 4n], phiLen: 5n }), 'phi length out of range');
  await refused('the identity as the new recovery key', () => publish(E, { ...S.s, recoveryPk: JUBJUB_IDENTITY }), 'recovery key is the identity');
  await refused('a small-order recovery key (refused by the runtime at the boundary, or by the cofactor check)',
    () => publish(E, { ...S.s, recoveryPk: JUBJUB_ORDER_TWO }), /small order|unreachable/); // upstream recovery-sim's TORSION_REFUSED
  // the client refuses the same values before any wallet signature
  for (const [label, a] of [
    ['an empty phi', { recoveryPk: S.s.recoveryPk, sessionNonce: S.sid, phi: [], wrap: S.s.wrap }],
    ['five phi values', { recoveryPk: S.s.recoveryPk, sessionNonce: S.sid, phi: [1n, 2n, 3n, 4n, 5n], wrap: S.s.wrap }],
    ['an all-zero session identifier', { recoveryPk: S.s.recoveryPk, sessionNonce: new Uint8Array(32), phi: S.phi, wrap: S.s.wrap }],
    ['a 63-byte wrap', { recoveryPk: S.s.recoveryPk, sessionNonce: S.sid, phi: S.phi, wrap: rnd(63) }],
  ] as const) {
    let threw = '';
    try { evmK256RecoverySession(a as any); } catch (e: any) { threw = String(e?.message ?? e); }
    ok(threw.startsWith('evm_k256:'), `client layer: ${label} refused before signing (${threw.slice(0, 60)})`);
  }
});

await section('unauthorised keys', async () => {
  const S = newSession();
  await refused('an unenrolled evm key signs the session', () => publish(stranger, S.s), 'unknown device entry');
  await refused('the device key with another account\'s blind', async () => {
    const other = await EvmK256Device.enrol(E.wallet!, 'undeployed', 1);
    const td = evmK256Messages.publishRecoverySession(frame(E), S.s);
    const { arm, ...a } = await E.authorise(td, counterOf(E));
    return call(PUBLISH, [...sessionArgs(S.s), { ...a, blind: other.blind }]);
  }, 'unknown device entry');
  await refused('a stale use counter (the entry already rolled)', async () => {
    const td = evmK256Messages.publishRecoverySession(frame(E), S.s);
    return call(PUBLISH, [...sessionArgs(S.s), await authOf(E, td, 0n)]);
  }, 'unknown device entry');
});

await section('more devices: a second evm device and a JubJub device, and the upstream plant at device_epoch + 1', async () => {
  const e2In = evmK256DescriptorInput(evmDeviceDescriptor(E2));
  await call('add_device_with_evm_k256', [e2In, ...ed25519Args(e2In), await authOf(E, evmK256Messages.addDevice(frame(E), e2In))]);
  const jIn = evmK256DescriptorInput({ scheme: 'jubjub', x: J.pk.x, y: J.pk.y });
  await call('add_device_with_evm_k256', [jIn, ...ed25519Args(jIn), await authOf(E, evmK256Messages.addDevice(frame(E), jIn))]);
  ok(counterOf(E2) === 0n && jCounter(J) === 0n && L().device_count === 3n, 'E2 (evm_k256) and J (jubjub) enrolled at epoch 0, counter 0');
  // README erratum 7: an upstream arm's raw add_device takes any entry; J
  // enrols W's evm_k256 entry at device_epoch + 1, counter 0
  epochBefore = L().device_epoch;
  plant = W.entryAt(address, epochBefore + 1n, 0n);
  const a = J.sign(jubjubChallenges.addDevice(jctx(), J.pk, plant), jCounter(J));
  await call('add_device_with_jubjub', [plant, ...authArgs(a)]);
  ok(L().devices.member(plant) && L().device_count === 4n, 'the planted evm_k256 entry (epoch + 1) is in the set');
  await refused('the planted device cannot act before the bump (its entry is not at the live epoch)', async () => {
    const k = rnd();
    return call(ROTATE, [k, await authOf(W, evmK256Messages.rotateEncKey(frame(W), k), 0n)]);
  }, 'unknown device entry');
});

// A grant across the recovery: an unshielded scope issued to one grantee
// wallet; the grantee withdraws under the record's live frame
const G_WALLET = SoftwareEvmWallet.generate();
const U_COLOR = rnd(), RCPT = rnd();
const grantScope: IssueScope = { opWithdrawUnshielded: true, opWithdrawShielded: false, opWithdrawShieldedToContract: false, read: false,
  color: U_COLOR, recipientKind: RECIPIENT_USER_ADDRESS, recipient: RCPT, maxCoinValue: 100n, perCallCap: 100n, cap: 500n, expiresAt: 0n,
  rpIdHash: new Uint8Array(32), readPk: new Uint8Array(32), windowLen: 0n, windowCap: 0n, caller: null };
interface Held { g: EvmK256Grantee; salt: Uint8Array; spent: bigint }
async function issueTo(d: EvmK256Device, slot: bigint): Promise<Held> {
  const g = await EvmK256Grantee.enrol(G_WALLET, 'undeployed', address, grantLabel('bank.example'), slot);
  const gin = g.descriptor();
  // the salt the circuit derives from the issuing device's blind, the account and auth_nonce
  const s = evmK256GrantScopeSalt(d.blind, address, frame(d).authNonce);
  await call('issue_grant_with_evm_k256', [gin, ...ed25519Args(gin), ...evmK256IssueArgs(grantScope), await authOf(d, evmK256Messages.issueGrant(frame(d), gin, grantScope))]);
  return { g, salt: s, spent: 0n };
}
async function grantWithdraw(h: Held, amount: bigint) {
  const rec = L().grants.lookup(h.g.grantId(address));
  const td = evmK256Messages.withdrawUnshieldedAsGrantee({ account: address, grantee: h.g.address, label: h.g.label, slot: h.g.slot, issuedAt: rec.issued_at, grantNonce: rec.nonce }, U_COLOR, amount, RCPT, TEST_SITE);
  const opening: GrantOpening = { originHash: h.g.originHash, slot: h.g.slot, scopeSalt: h.salt, recipientKind: RECIPIENT_USER_ADDRESS, pinnedRecipient: RCPT, maxCoinValue: 100n, spentPrev: h.spent };
  await call('withdraw_unshielded_with_grant_evm_k256', [U_COLOR, amount, { bytes: RCPT }, ...grantAuthArgs(opening, await h.g.authorise(td))]);
  h.spent += amount;
}
let oldGrant: Held | undefined;
await section('a grant issued at the first epoch: its grantee withdraws', async () => {
  oldGrant = await issueTo(E, 0n);
  await call('deposit_unshielded', [U_COLOR, 1000n]);
  const id = oldGrant.g.grantId(address); const n0 = L().grants.lookup(id).nonce as bigint;
  await grantWithdraw(oldGrant, 50n);
  ok(L().grants.lookup(id).nonce === n0 + 1n && L().unshielded_balances.lookup(U_COLOR) === 950n, 'the grantee withdraws 50 (the record\'s nonce advanced, the mirror at 950)');
});

let firstSubmit: unknown[] = [];
const Q = JubjubDevice.generate();
const QR = newRecoverySecret();
await section('the shared recovery gate on an evm_k256 account; pending exclusivity; the veto window', async () => {
  const set = readArtefactSet(L());
  const sRec = reconstruct(set.phi, S1.shares.slice(0, 2), S1.t);
  ok(matchesRecoveryPk(sRec, set.recoveryPk), 'the secret reconstructed from the on-chain phi (published by the evm device) opens the stored recovery key');
  const vk = openWrap(fieldToBytes(sRec), address, set.wrap);
  ok(vk !== null && eq(vk, encSecret), 'the wrap the evm device published restores the encryption secret (REC-7)');
  await refused('a wrong secret fails the gate', async () => call('recover_submit', submitArgs(newRecoverySecret().field, Q, recoveryKey(QR.field).pk, BigInt(time))), 'invalid recovery signature');
  firstSubmit = submitArgs(sRec, Q, recoveryKey(QR.field).pk, BigInt(time));
  await call('recover_submit', firstSubmit);
  ok(L().pending_recovery === true && L().device_epoch === epochBefore, 'pending recovery recorded; the epoch unchanged');
  const S = newSession();
  await refused('publish_recovery_session_with_evm_k256 while a recovery is pending (valid signature)', () => publish(E, S.s), 'recovery pending; cancel first');
  await refused('finalisation inside the veto window', () => call('recover_finalise', []), 'veto window still open');
  time += 3600;
  await refused('still inside the window an hour later', () => call('recover_finalise', []), 'veto window still open');
});

await section('recover_cancel_with_evm_k256: binding, then the veto by a second evm device', async () => {
  await refused('a RevokeAllGrants signature over the same bare frame presented as CancelRecovery', () => cancel(E2, evmK256Messages.revokeAllGrants(frame(E2))), 'invalid signature');
  await refused('a CancelRecovery signature over authNonce + 1', async () => {
    const td = clone(evmK256Messages.cancelRecovery(frame(E2))); (td.message as any).authNonce = String(L().auth_nonce + 1n);
    return cancel(E2, td);
  }, 'invalid signature');
  await refused('a CancelRecovery signature for another account', async () => {
    const td = evmK256Messages.cancelRecovery({ ...frame(E2), account: rnd() });
    return cancel(E2, td);
  }, 'invalid signature');
  await refused('an unenrolled evm key cancels', () => cancel(stranger), 'unknown device entry');
  const before = L();
  const td = evmK256Messages.cancelRecovery(frame(E2));
  ok(typeString('CancelRecovery') === 'CancelRecovery(bytes32 account,address device,uint64 authNonce)', 'the frozen type: the frame alone');
  const auth = await authOf(E2, td);
  await call(CANCEL, [auth]);
  const l = L();
  ok(l.pending_recovery === false && l.device_epoch === before.device_epoch, 'cancel clears the pending record; the epoch unchanged');
  ok(l.auth_nonce === before.auth_nonce + 1n && l.round === before.round + 1n && counterOf(E2) === 1n, 'auth_nonce +1, round +1, E2 rolled to counter 1');
  ok(eq(l.pending_entry, new Uint8Array(32)) && l.pending_not_before === 0n, 'the pending entry and bound cleared');
  await refused('the cancel replayed verbatim (its entry was consumed)', () => call(CANCEL, [auth]), 'unknown device entry');
  await refused('a fresh, valid cancel with nothing pending', () => cancel(E), 'no recovery pending');
  await refused('the cancelled submission replayed verbatim', () => call('recover_submit', firstSubmit), 'stale authorisation nonce');
  await refused('nothing to finalise after the cancel', () => call('recover_finalise', []), 'no recovery pending');
});

await section('finalisation clears every old device, the planted evm_k256 entry included (#183; replaces erratum 7)', async () => {
  const set = readArtefactSet(L());
  const sRec = reconstruct(set.phi, [S1.shares[0], S1.shares[2]], S1.t);
  await call('recover_submit', submitArgs(sRec, Q, recoveryKey(QR.field).pk, BigInt(time)));
  time += Number(WINDOW) + 60;
  const before = L();
  const cE = counterOf(E), cE2 = counterOf(E2), cJ = jCounter(J);
  ok(cE >= 0n && cE2 >= 0n && cJ >= 0n, `before: E live at counter ${cE}, E2 at ${cE2}, J at ${cJ}`);
  const successorEntry = new Uint8Array(before.pending_entry);
  ok(before.devices.size() === 4n && before.devices.member(plant), 'before: four entries, the plant among them');
  await call('recover_finalise', []);
  const l = L();
  ok(l.device_epoch === epochBefore + 1n && l.device_count === 1n, 'the epoch bumped; one device');
  ok(l.devices.size() === 1n && l.devices.member(successorEntry), 'the set holds only the successor\'s entry');
  ok(eq(plant, W.entryAt(address, l.device_epoch, 0n)), 'the plant IS the planted device\'s entry at the new live epoch, counter 0 (erratum 7: it would be live without the clear)');
  ok(!l.devices.member(plant), 'the planted evm_k256 entry is gone');
  ok(l.auth_nonce === before.auth_nonce + 1n && l.pending_recovery === false && l.recovery_phi_len === 0n && eqPoint(l.recovery_pk, recoveryKey(QR.field).pk as JubjubPoint),
    'auth_nonce +1, nothing pending, the vector retired, the successor recovery key installed');
  // every old device signs a gated call: each is refused by membership
  const k = rnd();
  await refused('the planted evm_k256 device (counter 0 at the new epoch) rotates', async () =>
    call(ROTATE, [k, await authOf(W, evmK256Messages.rotateEncKey(frame(W), k), 0n)]), 'unknown device entry');
  await refused('the planted evm_k256 device publishes a session', async () =>
    call(PUBLISH, [...sessionArgs(newSession().s), await authOf(W, evmK256Messages.publishRecoverySession(frame(W), newSession().s), 0n)]), 'unknown device entry');
  for (const [name, d, c] of [['E (the original evm device)', E, cE], ['E2 (the cancelling evm device)', E2, cE2]] as const) {
    for (const ctr of [0n, c]) {
      await refused(`${name}, counter ${ctr}, rotates`, async () => call(ROTATE, [k, await authOf(d, evmK256Messages.rotateEncKey(frame(d), k), ctr)]), 'unknown device entry');
    }
    const S = newSession();
    await refused(`${name} publishes a session`, async () => call(PUBLISH, [...sessionArgs(S.s), await authOf(d, evmK256Messages.publishRecoverySession(frame(d), S.s), c)]), 'unknown device entry');
    await refused(`${name} cancels`, async () => call(CANCEL, [await authOf(d, evmK256Messages.cancelRecovery(frame(d)), c)]), 'unknown device entry');
  }
  await refused('J (the old jubjub device) adds a device', async () => {
    const e = W.entryAt(address, L().device_epoch, 1n);
    return call('add_device_with_jubjub', [e, ...authArgs(J.sign(jubjubChallenges.addDevice(jctx(), J.pk, e), cJ))]);
  }, 'unknown device entry');
});

let fDevice: EvmK256Device | undefined;
await section('after recovery: the JubJub successor enrols a fresh evm device, which publishes a fresh session', async () => {
  const F = await EvmK256Device.enrol(SoftwareEvmWallet.generate(), 'undeployed', 0);
  fDevice = F;
  const fEntry = F.entryAt(address, L().device_epoch, 0n);
  await call('add_device_with_jubjub', [fEntry, ...authArgs(Q.sign(jubjubChallenges.addDevice(jctx(), Q.pk, fEntry), jCounter(Q)))]);
  ok(counterOf(F) === 0n && L().device_count === 2n, 'F enrolled at the new epoch by the successor');
  const S = newSession();
  await publish(F, S.s);
  ok(L().recovery_phi_len === 2n && eq(L().recovery_session, S.sid) && counterOf(F) === 1n, 'F published a fresh session through the arm (§6 step 7)');
  await refused('F cancels with nothing pending (valid signature)', () => cancel(F), 'no recovery pending');
});

// remove_device in both of its forms, through the seam's two-form body: each
// form is an honest removal, so a body that framed either form with another
// address, account or nonce fails here
await section('remove_device in both forms (descriptor; literal entry) by the evm device F', async () => {
  const F = fDevice!;
  const K = new K256Device(0x5eed7n);
  const kIn = evmK256DescriptorInput({ scheme: 'k256', x: K.pk.x, y: K.pk.y, envelope: 0 });
  await call('add_device_with_evm_k256', [kIn, ...ed25519Args(kIn), await authOf(F, evmK256Messages.addDevice(frame(F), kIn))]);
  const kEntry = K.entryAt(address, L().device_epoch, 0n);
  ok(L().devices.member(kEntry), 'F enrols a k256 device K by descriptor');
  await call('remove_device_with_evm_k256', [EVM_K256_UNUSED_DESCRIPTOR, ...ed25519Args(EVM_K256_UNUSED_DESCRIPTOR), 0n, 0n, { is_some: true, value: kEntry },
    await authOf(F, evmK256Messages.removeUnknownDevice(frame(F), kEntry))]);
  ok(!L().devices.member(kEntry), 'F removes K by the literal form ("Removes a device this wallet cannot identify")');
  await call('add_device_with_evm_k256', [kIn, ...ed25519Args(kIn), await authOf(F, evmK256Messages.addDevice(frame(F), kIn))]);
  const ep = L().device_epoch as bigint;
  await call('remove_device_with_evm_k256', [kIn, ...ed25519Args(kIn), ep, 0n, { is_some: false, value: new Uint8Array(32) },
    await authOf(F, evmK256Messages.removeDevice(frame(F), kIn, ep, 0n))]);
  ok(!L().devices.member(K.entryAt(address, ep, 0n)), 'F removes K by descriptor (epoch, counter 0)');
});

await section('after recovery: the grant of the old epoch is refused; a grant the new device issues lands', async () => {
  const F = fDevice!;
  const id = oldGrant!.g.grantId(address);
  ok(L().grants.member(id) && L().grants.lookup(id).active === true && L().grants.lookup(id).epoch === epochBefore && L().device_epoch === epochBefore + 1n,
    'the old grant is kept and active, its epoch one behind the live one');
  await refused('the grantee withdraws under the old grant after the finalisation (an honest approval over the live record)', () => grantWithdraw(oldGrant!, 50n), 'grant epoch stale');
  ok(L().unshielded_balances.lookup(U_COLOR) === 950n, 'the mirror is unchanged');
  const fresh = await issueTo(F, 1n);
  await grantWithdraw(fresh, 50n);
  ok(L().unshielded_balances.lookup(U_COLOR) === 900n, 'the grantee withdraws 50 under the grant F issued at the new epoch');
});

console.log('');
for (const s of sections) console.log(`  ${String(s.pass).padStart(3)} passed, ${s.fail} failed  ${s.label}`);
const verdict = fail === 0 && pass > 0 ? 'PASS' : 'FAIL';
console.log(`\n◆ evm-k256-recovery-sim: ${verdict} (${pass} passed, ${fail} failed)`);
if (process.env.EVIDENCE_DIR) {
  const fs = await import('node:fs');
  fs.writeFileSync(`${process.env.EVIDENCE_DIR}/evm-k256-recovery-sim.json`, JSON.stringify({ suite: 'evm-k256-recovery-sim', ranAt: new Date().toISOString(), layer: 'runtime (generated JavaScript, compact-runtime simulator) unless the label says client', sections, pass, fail, failures, refusals, verdict }, null, 2) + '\n');
}
process.exit(verdict === 'PASS' ? 0 : 1);
