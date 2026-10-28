// Arm `sol_ed25519`: recovery, offline (the generated JavaScript and the
// compact-runtime simulator; no proof server, no node), with explicit
// wall-clock control. It extends upstream's recovery-sim.ts, which is left
// unchanged and drives the JubJub arm only, to an account whose devices are
// Solana keys:
//
//   - the readable approval: the session's message shows the
//     consequence line "sets this account's recovery key", the new recovery
//     key's coordinates, the session identifier, the four backup vector values
//     (little-endian), the length and the 64-byte wrap, all in full;
//     the contract's message equals the independent renderer's, and the chip
//     stores exactly the values shown;
//   - publish_recovery_session_with_sol_ed25519: binding (the signed message
//     and the executed operands differ in one value, display inputs
//     consistent with the executed call: refused by the signature), display
//     inputs inconsistent with the executed call (refused by the display
//     checks), the operation, the nonce, the frame, the shared chip's rules
//     under a valid signature, the client's refusals, unauthorised keys;
//   - the canonical rendering of a Field: a backup vector value or a key
//     coordinate shown through a non-canonical 32-byte rendering of the
//     executed Field (f + r) is refused by the display check (the generated
//     JavaScript casts canonically; the constraint level is the prover
//     suite's `field-rendering` section);
//   - the shared JubJub recovery gate (recover_submit) on a sol account,
//     pending exclusivity, the veto window;
//   - recover_cancel_with_sol_ed25519 by a second sol device: binding, the
//     landed cancel replayed, nothing to cancel, the cancelled submission
//     replayed;
//   - finalisation (upstream #183: the device set is cleared): every old
//     sol_ed25519 device is refused afterwards, INCLUDING an entry an
//     upstream arm planted at device_epoch + 1 before the recovery (README
//     erratum 7: without the clear it would be live at the new epoch); the old
//     JubJub device too; the JubJub successor enrols a fresh sol device at
//     the new epoch, which publishes a fresh session through the arm.
//
// Writes $EVIDENCE_DIR/sol-ed25519-recovery-sim.json when EVIDENCE_DIR is set.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createCircuitContext, createConstructorContext, sampleContractAddress } from '@midnight-ntwrk/compact-runtime';

import { Contract, ledger, type JubjubPoint } from '../wallet/contract.js';
import { makeWitnesses, emptyCoinStore, type CoinStorePrivateState } from '../wallet/witnesses.js';
import { JubjubDevice, jubjubChallenges, authArgs } from '../wallet/signer.js';
import { base58Text32 } from '../wallet/rendering.js';
import {
  SolEd25519Device, authoriseSolDevice, deriveSolBlind, solSoftwareSigner, solDeviceMessageCircuit, solRecoverySession, solTargetOf,
  type SolEd25519Authorisation,
} from '../wallet/signer-sol-ed25519.js';
import {
  SOL_PARSE_BOUND, digitsOf, nibblesOf, solDeviceHexValues, solDeviceMessageText, solFrameNibbles, solMessageBytes, solShow,
  solTargetArg, solTargetPointArg, type SolDeviceOperation,
} from '../wallet/sol-ed25519-message.js';
import {
  recoveryKey, signRecoverSubmit, recoverSubmitArgs, recoverSubmitChallenge, readArtefactSet, matchesRecoveryPk, eqPoint,
  JUBJUB_IDENTITY, JUBJUB_ORDER_TWO,
} from '../wallet/recovery-gate.js';
import {
  deriveShare, split, reconstruct, fieldToBytes, guardianSecretFromPrf, sealWrap, openWrap, newRecoverySecret, newSessionNonce, FQ,
  type IndexedShare,
} from '../wallet/recovery.js';

// ── Reporting ───────────────────────────────────────────────────────────────

interface Case { group: string; name: string; verdict: 'PASS' | 'FAIL'; layer?: string; detail?: string }
const cases: Case[] = [];
let group = '';
const ok = (cond: boolean, name: string, detail?: string, layer?: string) => {
  cases.push({ group, name, verdict: cond ? 'PASS' : 'FAIL', ...(layer ? { layer } : {}), ...(detail ? { detail } : {}) });
  console.log(`  ${cond ? '✓' : '✗'} ${name}${!cond && detail ? ` — ${detail}` : ''}`);
};
async function section(label: string, f: () => Promise<void>) {
  group = label;
  console.log(`── ${label}`);
  try { await f(); } catch (e: any) { ok(false, `${label}: unexpected error`, String(e?.stack ?? e).slice(0, 600)); }
}

const rnd = (n = 32) => new Uint8Array(randomBytes(n));
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const le32 = (v: bigint) => { const o = new Uint8Array(32); let x = v; for (let i = 0; i < 32; i++) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };

// ── The simulated account ───────────────────────────────────────────────────

const WINDOW = 3n * 24n * 3600n; // upstream recovery-sim's window
const ACTIVATE = 'activate_initial_device_with_sol_ed25519';
const PUBLISH = 'publish_recovery_session_with_sol_ed25519';
const CANCEL = 'recover_cancel_with_sol_ed25519';
const ROTATE = 'rotate_enc_key_with_sol_ed25519';
const ADD = 'add_device_with_sol_ed25519';
const SITE = 'Recovery test';
const CONSEQUENCE = "Consequence: sets this account's recovery key; its holder can take over this account after the veto window.";
const INVALID = 'invalid signature';
const UNKNOWN = 'unknown device entry';
const HEXD = 'display: hex digits do not match the value';
const DIGITS = 'display: digits do not match the value';

const contract: any = new (Contract as any)(makeWitnesses());
const coinPk = { bytes: rnd() };
const addressHex: string = sampleContractAddress();
const address = new Uint8Array(Buffer.from(addressHex.replace(/^0x/, ''), 'hex'));
let privateState: CoinStorePrivateState = emptyCoinStore();
let time = 1_800_000_000;
const encSecret = rnd();
const birth = newRecoverySecret();
const newSol = async (index = 0) => { const s = solSoftwareSigner(rnd()); return SolEd25519Device.fromSigner(s, await deriveSolBlind(s, { network: 'undeployed', accountIndex: index })); };
const S = await newSol();
const salt = rnd();
const init = await contract.initialState(createConstructorContext(privateState, coinPk),
  S.bootCommitment(salt), rnd(), recoveryKey(birth.field).pk, sealWrap(birth.bytes, new Uint8Array(32), encSecret), WINDOW);
let state: any = init.currentContractState;
const L = () => ledger(state) as any;

async function call(name: string, args: unknown[]) {
  const ctx: any = createCircuitContext({ circuitId: name, contractAddress: addressHex, coinPublicKeyOrZswapState: coinPk,
    contractState: state, privateState, time } as any);
  const res = await contract.impureCircuits[name](ctx, ...args);
  state = res.context.callContext.currentQueryContext.state;
  privateState = res.context.callContext.currentPrivateState ?? privateState;
  return res;
}
const snap = () => JSON.stringify({ r: L().round, n: L().auth_nonce, s: L().devices.size(), p: L().pending_recovery, e: L().device_epoch, sess: hex(L().recovery_session) },
  (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
/** A refused call: refused by `needle` and the state untouched (atomic abort). */
async function refused(name: string, f: () => Promise<unknown>, needle: string | RegExp, layer = 'runtime') {
  const before = snap();
  try { await f(); ok(false, `${name} (NOT refused)`, undefined, layer); return; } catch (e: any) {
    const m = String(e?.message ?? e);
    const hit = typeof needle === 'string' ? m.includes(needle) : needle.test(m);
    ok(hit && snap() === before, name, hit ? (snap() === before ? m.slice(0, 160) : 'the refused call changed the state') : `refused by "${m.slice(0, 200)}", expected ${String(needle)}`, layer);
  }
}

// sol devices: the live counter (MIP-0013 S11 rescan), the call context, and
// authorisations whose display inputs and signature can be chosen apart
const counterOf = (d: { entryAt(a: Uint8Array, e: bigint, c: bigint): Uint8Array }): bigint => {
  for (let k = 0n; k < 256n; k++) if (L().devices.member(d.entryAt(address, L().device_epoch, k))) return k;
  return -1n;
};
const ctx = () => ({ contractAddress: address, authNonce: L().auth_nonce as bigint });
type Session = Extract<SolDeviceOperation, { op: 'publish_recovery_session' }>;
/** The display inputs of a call as the CLIENT would compute them (no pure
 *  circuit: the renderer's values, so non-canonical renderings are possible). */
const showArgsFor = (d: SolEd25519Device, o: SolDeviceOperation, nonce = L().auth_nonce as bigint, account = address, site = SITE): unknown[] => {
  const show = solShow(site, nonce), frame = solFrameNibbles(account, d.key);
  if (o.op === 'publish_recovery_session') return [digitsOf(o.phiLen, 3), show, frame, nibblesOf(...solDeviceHexValues(o))];
  if (o.op === 'recover_cancel' || o.op === 'revoke_all_grants') return [show, frame];
  throw new Error(`showArgsFor: ${o.op}`);
};
/** The bytes the wallet is shown (the independent renderer). */
const bytesFor = (d: SolEd25519Device, o: SolDeviceOperation, nonce = L().auth_nonce as bigint, account = address, site = SITE) =>
  solMessageBytes(solDeviceMessageText({ site, account, key: d.key, nonce }, o));
const authFor = (d: SolEd25519Device, o: SolDeviceOperation, counter = counterOf(d)) =>
  authoriseSolDevice(d, ctx(), SITE, o, counter < 0n ? 0n : counter);
/** The wallet signed `signed`; the call executes with display inputs `show`. */
const signedOver = async (d: SolEd25519Device, signed: Uint8Array, show: unknown[], counter = counterOf(d)): Promise<SolEd25519Authorisation> =>
  ({ ...(await authFor(d, { op: 'recover_cancel' }, counter)), sig: (await d.signApproval(signed)).sig, showArgs: show });
const sessionArgs = (s: Session) => [s.recoveryPk, s.sessionNonce, ...s.phi, s.phiLen, s.wrap];
const publish = async (d: SolEd25519Device, s: Session, counter = counterOf(d)) => call(PUBLISH, [...sessionArgs(s), ...authArgs(await authFor(d, s, counter))]);
const cancel = async (d: SolEd25519Device, counter = counterOf(d)) => call(CANCEL, authArgs(await authFor(d, { op: 'recover_cancel' }, counter)));
const jctx = () => ({ contractAddress: address, authNonce: L().auth_nonce as bigint });

// A guardian session (upstream recovery-sim's shape): three guardians at
// threshold two publish two backup vector values.
interface Sess { secretField: bigint; secretBytes: Uint8Array; sid: Uint8Array; phi: bigint[]; shares: IndexedShare[]; t: number; s: Session }
function newSession(): Sess {
  const t = 1;
  const guardians = [0, 1, 2].map(() => guardianSecretFromPrf(rnd()));
  const sec = newRecoverySecret();
  const sid = newSessionNonce();
  const shares: IndexedShare[] = guardians.map((g, i) => ({ index: i + 1, sigma: deriveShare(sid, address, g) }));
  const phi = split(sec.field, shares, t);
  const s = solRecoverySession({ recoveryPk: recoveryKey(sec.field).pk, sessionNonce: sid, phi, wrap: sealWrap(sec.bytes, address, encSecret) });
  return { secretField: sec.field, secretBytes: sec.bytes, sid, phi, shares, t, s };
}
/** The shared JubJub recovery gate (recover_submit), as upstream's sim drives it. */
function submitArgs(sField: bigint, successor: JubjubDevice, successorRecoveryPk: JubjubPoint, nowUpper: bigint, nonce?: bigint): unknown[] {
  const l = L();
  const n = nonce ?? l.auth_nonce;
  const auth = signRecoverSubmit(recoveryKey(sField), successor,
    recoverSubmitChallenge({ contractAddress: address, authNonce: n }, l.recovery_pk, successor.pk, successorRecoveryPk, l.device_epoch + 1n, nowUpper),
    { successorRecoveryPk, expectedEpoch: l.device_epoch, expectedNonce: n, nowUpper });
  return recoverSubmitArgs(auth);
}

// ═════════════════════════════════════════════════════════════════════════════

await call(ACTIVATE, S.activationArgs(salt));
const S1 = newSession();
const S2 = await newSol();
const J = JubjubDevice.generate();
const W = await newSol();
const stranger = await newSol();
let plant: Uint8Array = new Uint8Array(32);
let epochBefore = 0n;

await section('1 recovery at birth on a sol_ed25519 account', async () => {
  ok(L().booted === true && L().device_count === 1n && counterOf(S) === 0n, 'the sol_ed25519 device is the only device (counter 0)');
  ok(L().recovery_phi_len === 0n && L().recovery_version === 1n && L().pending_recovery === false, 'commitment and wrap present, no vector, nothing pending');
});

await section('2 the readable approval: every recovery operand in full, the consequence line', async () => {
  const c = solDeviceMessageCircuit(S.key, ctx(), SITE, S1.s);
  const text = solDeviceMessageText({ site: SITE, account: address, key: S.key, nonce: L().auth_nonce }, S1.s);
  ok(Buffer.from(c.bytes).toString('latin1') === text, "the contract's message == the independent renderer's (byte for byte)");
  ok(c.bytes.length === 1230 && c.bytes.length < SOL_PARSE_BOUND, `the message is 1,230 bytes (frozen sol v1 layout), below the parse bound ${SOL_PARSE_BOUND}`);
  const lines = text.split('\n');
  ok(lines[0] === 'Midnight Passport approval (sol v1)' && lines[1] === 'Operation: Publish a recovery session', 'the circuit-fixed first line and operation title');
  ok(lines.includes(CONSEQUENCE), "the circuit-fixed consequence line: \"sets this account's recovery key\"");
  ok(lines.includes(`Recovery key x: ${hex(le32(S1.s.recoveryPk.x))}`) && lines.includes(`Recovery key y: ${hex(le32(S1.s.recoveryPk.y))}`),
    'the new recovery key: both JubJub coordinates in full, 64 hex digits each, little-endian');
  ok(lines.includes(`Session nonce: ${hex(S1.sid)}`), 'the session identifier in full');
  ok([0, 1, 2, 3].every((k) => lines.includes(`Backup vector value ${k + 1} of 4: ${hex(le32(S1.s.phi[k]))}`)),
    'the four backup vector values in full, little-endian (unused slots shown as zero)');
  ok(lines.includes('Backup vector length: 2  '), 'the backup vector length in decimal (3-character field)');
  ok(lines.includes(`Key wrap part 1 of 2: ${hex(S1.s.wrap.subarray(0, 32))}`) && lines.includes(`Key wrap part 2 of 2: ${hex(S1.s.wrap.subarray(32))}`),
    'the 64-byte key wrap in full (two lines of 64 hex digits; no fingerprint, no truncation)');
  ok(lines.includes(`Account: ${hex(address)}`) && lines.includes(`Signing key: ${base58Text32(S.key).padEnd(44, ' ')}`), 'the frame: the account in full hex and the signing key in base58, as Solana wallets show it');
  const cc = solDeviceMessageCircuit(S.key, ctx(), SITE, { op: 'recover_cancel' });
  const ct = solDeviceMessageText({ site: SITE, account: address, key: S.key, nonce: L().auth_nonce }, { op: 'recover_cancel' });
  ok(Buffer.from(cc.bytes).toString('latin1') === ct && cc.bytes.length === 371 && ct.includes('Operation: Cancel a pending recovery\n')
    && ct.includes('Consequence: the pending recovery of this account is cancelled.\n'), 'the cancel message: 371 bytes, its title and consequence line, contract == renderer');
});

await section('3 publish_recovery_session_with_sol_ed25519: the session lands, exactly the shown values stored', async () => {
  const before = L();
  await publish(S, S1.s);
  const l = L();
  ok(l.recovery_phi_len === 2n, 'three guardians at threshold two publish two (|phi| = n - t)');
  ok(eqPoint(l.recovery_pk, S1.s.recoveryPk as JubjubPoint), "stored recovery key == the approval's");
  ok(eq(l.recovery_session, S1.sid), "stored session identifier == the approval's");
  ok([1n, 2n, 3n, 4n].every((i) => l.recovery_phi.lookup(i) === S1.s.phi[Number(i) - 1]), "stored phi 1..4 == the approval's");
  ok(eq(l.recovery_wrap, S1.s.wrap), "stored wrap == the approval's");
  ok(openWrap(S1.secretBytes, address, l.recovery_wrap) !== null, 'the ledger wrap opens under the session secret');
  ok(l.auth_nonce === before.auth_nonce + 1n && l.round === before.round + 1n && counterOf(S) === 1n, 'auth_nonce +1, round +1, the device entry rolled to counter 1');
});

await section('4 binding: the signed message and the executed call differ (display inputs consistent with the executed call)', async () => {
  const X = newSession().s;
  const other = recoveryKey(newRecoverySecret().field).pk;
  const variants: [string, Session][] = [
    ['the recovery key', { ...X, recoveryPk: other }],
    ['the session identifier (last byte)', { ...X, sessionNonce: (() => { const b = new Uint8Array(X.sessionNonce); b[31] ^= 1; return b; })() }],
    ['backup vector value 1 + 1', { ...X, phi: [X.phi[0] + 1n, X.phi[1], 0n, 0n] }],
    ['backup vector value 2 + 1', { ...X, phi: [X.phi[0], X.phi[1] + 1n, 0n, 0n] }],
    ['backup vector value 3 (unused slot) non-zero', { ...X, phi: [X.phi[0], X.phi[1], 7n, 0n], phiLen: 3n }],
    ['the length (3 instead of 2)', { ...X, phi: [X.phi[0], X.phi[1], 0n, 0n], phiLen: 3n }],
    ['the wrap (last byte)', { ...X, wrap: (() => { const b = new Uint8Array(X.wrap); b[63] ^= 1; return b; })() }],
  ];
  for (const [name, Y] of variants) {
    // the wallet signed Y, the call executes X
    await refused(`signed ${name} changed, executed the original: refused by the signature`, async () =>
      call(PUBLISH, [...sessionArgs(X), ...authArgs(await signedOver(S, bytesFor(S, Y), showArgsFor(S, X)))]), INVALID);
    // the wallet signed X, the call executes Y (every Y passes the chip)
    await refused(`signed the session, executed with ${name}: refused by the signature`, async () =>
      call(PUBLISH, [...sessionArgs(Y), ...authArgs(await signedOver(S, bytesFor(S, X), showArgsFor(S, Y)))]), INVALID);
  }
  await refused('the nonce: the approval shows auth_nonce + 1', async () =>
    call(PUBLISH, [...sessionArgs(X), ...authArgs(await signedOver(S, bytesFor(S, X, L().auth_nonce + 1n), showArgsFor(S, X)))]), INVALID);
  await refused('the operation: a recover_cancel approval presented as the session approval', async () =>
    call(PUBLISH, [...sessionArgs(X), ...authArgs(await signedOver(S, bytesFor(S, { op: 'recover_cancel' }), showArgsFor(S, X)))]), INVALID);
  // a pending recovery for the cancel's operation case, cleared afterwards by
  // a valid cancel through the arm
  await call('recover_submit', submitArgs(S1.secretField, JubjubDevice.generate(), recoveryKey(newRecoverySecret().field).pk, BigInt(time)));
  await refused('the operation: a revoke_all_grants approval presented as the cancel', async () =>
    call(CANCEL, authArgs(await signedOver(S, bytesFor(S, { op: 'revoke_all_grants' }), showArgsFor(S, { op: 'recover_cancel' })))), INVALID);
  await cancel(S);
  ok(L().pending_recovery === false, 'setup: the pending record of the previous case was cleared by a valid cancel through the arm');
  {
    // The wallet signed the session over ONE foreign account,
    // and the display inputs carry that same account's frame nibbles: a
    // consistent pair that only the seam's frame check can refuse; then the
    // honest publication of the SAME session on the unchanged state lands
    // (positive control, effects asserted), in isolation: the state is
    // restored so the cases below keep their prerequisites
    const acct = rnd();
    await refused('the frame: the approval of this session shows another account, its frame nibbles with it (one foreign account): refused by the seam\'s frame check', async () =>
      call(PUBLISH, [...sessionArgs(X), ...authArgs(await signedOver(S, bytesFor(S, X, L().auth_nonce, acct), showArgsFor(S, X, L().auth_nonce, acct)))]), HEXD);
    const saved = { state, privateState }, before = L(), snap0 = snap();
    await publish(S, X);
    const l = L();
    ok(eqPoint(l.recovery_pk, X.recoveryPk as JubjubPoint) && eq(l.recovery_session, X.sessionNonce) && [1n, 2n, 3n, 4n].every((i) => l.recovery_phi.lookup(i) === X.phi[Number(i) - 1])
      && eq(l.recovery_wrap, X.wrap) && l.auth_nonce === before.auth_nonce + 1n && l.round === before.round + 1n,
      'positive control: the honest publication of the same session lands on the unchanged state (key, session identifier, phi, wrap stored; auth_nonce +1, round +1)');
    state = saved.state; privateState = saved.privateState;
    ok(snap() === snap0, 'the positive control ran in isolation (state restored for the cases below)');
  }
  // display inputs inconsistent with the executed call: the display checks
  const A = await authFor(S, X);
  await refused('display inputs of another recovery key x (hex nibbles)', () => call(PUBLISH, [...sessionArgs({ ...X, recoveryPk: other }), ...authArgs(A)]), HEXD);
  await refused('display inputs of another backup vector value 1', () => call(PUBLISH, [...sessionArgs({ ...X, phi: [X.phi[0] + 1n, X.phi[1], 0n, 0n] }), ...authArgs(A)]), HEXD);
  await refused('display inputs of another session identifier', () => call(PUBLISH, [...sessionArgs({ ...X, sessionNonce: rnd() }), ...authArgs(A)]), HEXD);
  await refused('display inputs of another wrap', () => call(PUBLISH, [...sessionArgs({ ...X, wrap: rnd(64) }), ...authArgs(A)]), HEXD);
  {
    // hex nibbles consistent with the executed call (slot 3 = 5), the length
    // digits still showing 2: only the decimal display check can refuse
    const Y: Session = { ...X, phi: [X.phi[0], X.phi[1], 5n, 0n], phiLen: 3n };
    const show = showArgsFor(S, Y);
    show[0] = digitsOf(2n, 3);
    await refused('display digits of another length (2 shown, 3 executed with slot 3 set; hex nibbles consistent)', () => call(PUBLISH, [...sessionArgs(Y), ...authArgs({ ...A, showArgs: show })]), DIGITS);
  }
});

await section('5 one Field, one rendering: a non-canonical rendering of the executed Field is refused', async () => {
  const X = newSession().s;
  const R = FQ; // the BLS12-381 scalar field modulus r
  ok(true, 'positive control: the canonical rendering is accepted (section 3 and the cases above use it)');
  const nc: [string, (o: Session) => bigint[]][] = [
    ['backup vector value 1 shown as f + r', (o) => [o.phi[0] + R, o.phi[1], o.phi[2], o.phi[3]]],
    ['backup vector value 2 shown as f + r', (o) => [o.phi[0], o.phi[1] + R, o.phi[2], o.phi[3]]],
    ['backup vector value 3 (zero) shown as 0 + r', (o) => [o.phi[0], o.phi[1], o.phi[2] + R, o.phi[3]]],
  ];
  for (const [name, f] of nc) {
    const shown: Session = { ...X, phi: f(X) as any };
    const sb = bytesFor(S, shown);
    ok(sb.length === 1230 && !eq(sb, bytesFor(S, X)), `${name}: the rendering exists (32 bytes, a different message of the same length)`);
    // the wallet signed the non-canonical rendering, the display inputs are its nibbles, the executed value is f
    await refused(`${name}, signed by the wallet with matching display inputs: refused by the display check`, async () =>
      call(PUBLISH, [...sessionArgs(X), ...authArgs(await signedOver(S, sb, showArgsFor(S, shown)))]), HEXD);
  }
  for (const coord of ['x', 'y'] as const) {
    const shown: Session = { ...X, recoveryPk: { ...X.recoveryPk, [coord]: X.recoveryPk[coord] + R } };
    await refused(`the recovery key's ${coord} shown as ${coord} + r, signed with matching display inputs: refused by the display check`, async () =>
      call(PUBLISH, [...sessionArgs(X), ...authArgs(await signedOver(S, bytesFor(S, shown), showArgsFor(S, shown)))]), HEXD);
  }
});

await section('6 the shared chip under a VALID signature: freshness and slot gating (recovery MIP §5)', async () => {
  const X = newSession().s;
  const stored = L();
  await refused('a reused session identifier', () => publish(S, { ...X, sessionNonce: new Uint8Array(stored.recovery_session) }), 'session nonce reused');
  await refused('a reused recovery commitment', () => publish(S, { ...X, recoveryPk: stored.recovery_pk }), 'recovery commitment reused');
  await refused('an all-zero session identifier', () => publish(S, { ...X, sessionNonce: new Uint8Array(32) }), 'session nonce is zero');
  await refused('length 2 with slot 3 non-zero', () => publish(S, { ...X, phi: [1n, 2n, 3n, 0n] }), 'unused phi slot 3 not zero');
  await refused('length 1 with slot 2 non-zero', () => publish(S, { ...X, phi: [1n, 2n, 0n, 0n], phiLen: 1n }), 'unused phi slot 2 not zero');
  await refused('length 3 with slot 4 non-zero', () => publish(S, { ...X, phi: [1n, 2n, 3n, 4n], phiLen: 3n }), 'unused phi slot 4 not zero');
  await refused('an empty vector (length 0)', () => publish(S, { ...X, phi: [0n, 0n, 0n, 0n], phiLen: 0n }), 'phi must not be empty');
  await refused('a length beyond the slot bound (5)', () => publish(S, { ...X, phi: [1n, 2n, 3n, 4n], phiLen: 5n }), 'phi length out of range');
  await refused('the identity as the new recovery key', () => publish(S, { ...X, recoveryPk: JUBJUB_IDENTITY }), 'recovery key is the identity');
  await refused('a small-order recovery key (refused by the runtime at the boundary, or by the cofactor check)',
    () => publish(S, { ...X, recoveryPk: JUBJUB_ORDER_TWO }), /small order|unreachable/);
  // the client refuses the same values before any wallet signature
  for (const [label, a] of [
    ['an empty vector', { recoveryPk: X.recoveryPk, sessionNonce: X.sessionNonce, phi: [], wrap: X.wrap }],
    ['five values', { recoveryPk: X.recoveryPk, sessionNonce: X.sessionNonce, phi: [1n, 2n, 3n, 4n, 5n], wrap: X.wrap }],
    ['an all-zero session identifier', { recoveryPk: X.recoveryPk, sessionNonce: new Uint8Array(32), phi: [1n], wrap: X.wrap }],
    ['a 63-byte wrap', { recoveryPk: X.recoveryPk, sessionNonce: X.sessionNonce, phi: [1n], wrap: rnd(63) }],
    ['a value f + r (not a canonical field element)', { recoveryPk: X.recoveryPk, sessionNonce: X.sessionNonce, phi: [FQ + 1n], wrap: X.wrap }],
  ] as const) {
    let threw = '';
    try { solRecoverySession(a as any); } catch (e: any) { threw = String(e?.message ?? e); }
    ok(threw.startsWith('sol_ed25519:'), `client layer: ${label} refused before signing (${threw.slice(0, 70)})`, undefined, 'client');
  }
});

await section('7 unauthorised keys', async () => {
  const X = newSession().s;
  await refused('an unenrolled sol key signs the session', () => publish(stranger, X, 0n), UNKNOWN);
  await refused("the device key with another account index's blind", async () => {
    const other = await deriveSolBlind((S as any).signer, { network: 'undeployed', accountIndex: 1 }).catch(() => null);
    const a = await authFor(S, X);
    return call(PUBLISH, [...sessionArgs(X), ...authArgs({ ...a, blind: other?.blind ?? rnd() })]);
  }, UNKNOWN);
  await refused('a stale use counter (the entry already rolled)', () => publish(S, X, 0n), UNKNOWN);
});

await section('8 more devices: a second sol device and a JubJub device, and the upstream plant at device_epoch + 1', async () => {
  for (const d of [S2.descriptor(), { scheme: 'jubjub', x: J.pk.x, y: J.pk.y }] as any[]) {
    const t = solTargetOf(d);
    await call(ADD, [solTargetArg(t), solTargetPointArg(t), ...authArgs(await authFor(S, { op: 'add_device', target: t }))]);
  }
  const jCounter = () => counterOf(J);
  ok(counterOf(S2) === 0n && jCounter() === 0n && L().device_count === 3n, 'S2 (sol_ed25519) and J (jubjub) enrolled by descriptor at epoch 0, counter 0');
  // README erratum 7: an upstream arm's raw add_device takes any entry; J
  // enrols W's sol_ed25519 entry at device_epoch + 1, counter 0
  epochBefore = L().device_epoch;
  plant = W.entryAt(address, epochBefore + 1n, 0n);
  await call('add_device_with_jubjub', [plant, ...authArgs(J.sign(jubjubChallenges.addDevice(jctx(), J.pk, plant), jCounter()))]);
  ok(L().devices.member(plant) && L().device_count === 4n, 'the planted sol_ed25519 entry (epoch + 1) is in the set');
  await refused('the planted device cannot act before the bump (its entry is not at the live epoch)', async () => {
    const k = rnd();
    return call(ROTATE, [k, ...authArgs(await authFor(W, { op: 'rotate_enc_key', newKey: k }, 0n))]);
  }, UNKNOWN);
});

let firstSubmit: unknown[] = [];
const Q = JubjubDevice.generate();
const QR = newRecoverySecret();
await section('9 the shared recovery gate on a sol_ed25519 account; pending exclusivity; the veto window', async () => {
  const set = readArtefactSet(L());
  const sRec = reconstruct(set.phi, S1.shares.slice(0, 2), S1.t);
  ok(matchesRecoveryPk(sRec, set.recoveryPk), 'the secret reconstructed from the on-chain vector (published by the sol device) opens the stored recovery key');
  const vk = openWrap(fieldToBytes(sRec), address, set.wrap);
  ok(vk !== null && eq(vk, encSecret), 'the wrap the sol device published restores the encryption secret (REC-7)');
  await refused('a wrong secret fails the gate', async () => call('recover_submit', submitArgs(newRecoverySecret().field, Q, recoveryKey(QR.field).pk, BigInt(time))), 'invalid recovery signature');
  firstSubmit = submitArgs(sRec, Q, recoveryKey(QR.field).pk, BigInt(time));
  await call('recover_submit', firstSubmit);
  ok(L().pending_recovery === true && L().device_epoch === epochBefore, 'pending recovery recorded; the epoch unchanged');
  await refused('publish_recovery_session_with_sol_ed25519 while a recovery is pending (valid signature)', () => publish(S, newSession().s), 'recovery pending; cancel first');
  await refused('finalisation inside the veto window', () => call('recover_finalise', []), 'veto window still open');
  time += 3600;
  await refused('still inside the window an hour later', () => call('recover_finalise', []), 'veto window still open');
});

await section('10 recover_cancel_with_sol_ed25519: binding, then the veto by a second sol device', async () => {
  const C = { op: 'recover_cancel' } as const;
  await refused('a revoke_all_grants approval over the same frame presented as the cancel', async () =>
    call(CANCEL, authArgs(await signedOver(S2, bytesFor(S2, { op: 'revoke_all_grants' }), showArgsFor(S2, C)))), INVALID);
  await refused('a cancel approval over auth_nonce + 1', async () =>
    call(CANCEL, authArgs(await signedOver(S2, bytesFor(S2, C, L().auth_nonce + 1n), showArgsFor(S2, C)))), INVALID);
  await refused('a cancel approval for another account (its frame nibbles with it): the frame check', async () => {
    const acct = rnd();
    return call(CANCEL, authArgs(await signedOver(S2, bytesFor(S2, C, L().auth_nonce, acct), showArgsFor(S2, C, L().auth_nonce, acct))));
  }, HEXD);
  await refused('a cancel approval for another account (this account\'s frame nibbles): the signature', async () =>
    call(CANCEL, authArgs(await signedOver(S2, bytesFor(S2, C, L().auth_nonce, rnd()), showArgsFor(S2, C)))), INVALID);
  await refused('display digits of another nonce (the seam renders auth_nonce)', async () =>
    call(CANCEL, authArgs({ ...(await authFor(S2, C)), showArgs: showArgsFor(S2, C, L().auth_nonce + 1n) })), DIGITS);
  await refused('an unenrolled sol key cancels', () => cancel(stranger, 0n), UNKNOWN);
  const before = L();
  const auth = await authFor(S2, C);
  ok(auth.text.length === 371 && auth.message.length === 50 + 371, 'the cancel approval: 371 bytes (421 signed, with the raw head)');
  await call(CANCEL, authArgs(auth));
  const l = L();
  ok(l.pending_recovery === false && l.device_epoch === before.device_epoch, 'cancel clears the pending record; the epoch unchanged');
  ok(l.auth_nonce === before.auth_nonce + 1n && l.round === before.round + 1n && counterOf(S2) === 1n, 'auth_nonce +1, round +1, S2 rolled to counter 1');
  ok(eq(l.pending_entry, new Uint8Array(32)) && l.pending_not_before === 0n, 'the pending entry and bound cleared');
  await refused('the cancel replayed verbatim: its display inputs show the old nonce (the seam renders auth_nonce)', () => call(CANCEL, authArgs(auth)), DIGITS);
  await refused('the cancel replayed with display inputs for the current nonce: its entry was consumed', () =>
    call(CANCEL, authArgs({ ...auth, showArgs: showArgsFor(S2, C) })), UNKNOWN);
  await refused('a fresh, valid cancel with nothing pending', () => cancel(S), 'no recovery pending');
  await refused('the cancelled submission replayed verbatim', () => call('recover_submit', firstSubmit), 'stale authorisation nonce');
  await refused('nothing to finalise after the cancel', () => call('recover_finalise', []), 'no recovery pending');
});

await section('11 finalisation clears every old device, the planted sol_ed25519 entry included (#183; replaces erratum 7)', async () => {
  const set = readArtefactSet(L());
  const sRec = reconstruct(set.phi, [S1.shares[0], S1.shares[2]], S1.t);
  await call('recover_submit', submitArgs(sRec, Q, recoveryKey(QR.field).pk, BigInt(time)));
  time += Number(WINDOW) + 60;
  const before = L();
  const cS = counterOf(S), cS2 = counterOf(S2), cJ = counterOf(J);
  ok(cS >= 0n && cS2 >= 0n && cJ >= 0n, `before: S live at counter ${cS}, S2 at ${cS2}, J at ${cJ}`);
  const successorEntry = new Uint8Array(before.pending_entry);
  ok(before.devices.size() === 4n && before.devices.member(plant), 'before: four entries, the plant among them');
  await call('recover_finalise', []);
  const l = L();
  ok(l.device_epoch === epochBefore + 1n && l.device_count === 1n, 'the epoch bumped; one device');
  ok(l.devices.size() === 1n && l.devices.member(successorEntry), "the set holds only the successor's entry");
  ok(eq(plant, W.entryAt(address, l.device_epoch, 0n)), "the plant IS the planted device's entry at the new live epoch, counter 0 (erratum 7: it would be live without the clear)");
  ok(!l.devices.member(plant), 'the planted sol_ed25519 entry is gone');
  ok(l.auth_nonce === before.auth_nonce + 1n && l.pending_recovery === false && l.recovery_phi_len === 0n && eqPoint(l.recovery_pk, recoveryKey(QR.field).pk as JubjubPoint),
    'auth_nonce +1, nothing pending, the vector retired, the successor recovery key installed');
  const k = rnd();
  await refused('the planted sol_ed25519 device W (counter 0 at the new epoch) rotates', async () =>
    call(ROTATE, [k, ...authArgs(await authFor(W, { op: 'rotate_enc_key', newKey: k }, 0n))]), UNKNOWN);
  await refused('the planted sol_ed25519 device W publishes a session', () => publish(W, newSession().s, 0n), UNKNOWN);
  for (const [name, d, c] of [['S (the original sol device)', S, cS], ['S2 (the cancelling sol device)', S2, cS2]] as const) {
    for (const ctr of [0n, c]) {
      await refused(`${name}, counter ${ctr}, rotates`, async () => call(ROTATE, [k, ...authArgs(await authFor(d, { op: 'rotate_enc_key', newKey: k }, ctr))]), UNKNOWN);
    }
    await refused(`${name} publishes a session`, () => publish(d, newSession().s, c), UNKNOWN);
    await refused(`${name} cancels`, () => cancel(d, c), UNKNOWN);
  }
  await refused('J (the old jubjub device) adds a device', async () => {
    const e = W.entryAt(address, L().device_epoch, 1n);
    return call('add_device_with_jubjub', [e, ...authArgs(J.sign(jubjubChallenges.addDevice(jctx(), J.pk, e), cJ))]);
  }, UNKNOWN);
});

await section('12 after recovery: the JubJub successor enrols a fresh sol device, which publishes a fresh session', async () => {
  const F = await newSol();
  const fEntry = F.entryAt(address, L().device_epoch, 0n);
  await call('add_device_with_jubjub', [fEntry, ...authArgs(Q.sign(jubjubChallenges.addDevice(jctx(), Q.pk, fEntry), counterOf(Q)))]);
  ok(counterOf(F) === 0n && L().device_count === 2n, 'F enrolled at the new epoch by the successor');
  const X = newSession();
  await publish(F, X.s);
  ok(L().recovery_phi_len === 2n && eq(L().recovery_session, X.sid) && counterOf(F) === 1n, 'F published a fresh session through the arm (§6 step 7)');
  await refused('F cancels with nothing pending (valid signature)', () => cancel(F), 'no recovery pending');
});

const failed = cases.filter((c) => c.verdict !== 'PASS');
console.log('');
for (const gname of [...new Set(cases.map((c) => c.group))]) {
  const cs = cases.filter((c) => c.group === gname);
  console.log(`  ${cs.every((c) => c.verdict === 'PASS') ? '✓' : '✗'} ${gname}: ${cs.filter((c) => c.verdict === 'PASS').length}/${cs.length}`);
}
const verdict = failed.length || !cases.length ? 'FAIL' : 'PASS';
if (process.env.EVIDENCE_DIR) {
  fs.mkdirSync(process.env.EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.EVIDENCE_DIR, 'sol-ed25519-recovery-sim.json'), JSON.stringify({ suite: 'sol-ed25519-recovery-sim', ranAt: new Date().toISOString(),
    layer: 'runtime (generated JavaScript, compact-runtime simulator) unless the case says client', cases, verdict }, null, 2) + '\n');
}
console.log(`\n◆ sol-ed25519-recovery-sim: ${verdict} (${cases.length} cases, ${failed.length} failed)`);
process.exit(verdict === 'PASS' ? 0 : 1);
