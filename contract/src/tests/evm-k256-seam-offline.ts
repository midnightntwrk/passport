// The authorisation of every gated `evm_k256` export, checked at the offline
// layer: the compact-runtime local simulator (the generated JavaScript), with
// no node and no proof server, so the suite a maintainer runs after an edit
// fails on a contract that loses one of these properties:
//
//   - every device-gated export (12) refuses an approval over another
//     account's frame (signed by the device; the frame's `account` names a
//     foreign account, under the same fixed domain), another key's
//     signature with the device's entry opening, and (r, s) = (0, 0), which
//     reaches K256Core's zero-scalar assert through each body (the one-type,
//     the two-form remove_device and the bare body);
//   - every grantee twin (3) refuses the same three approvals at the grant
//     seam;
//   - every shielded spend (the two device exports and the two shielded
//     grantee twins) refuses a held coin of another colour under an approval
//     naming the withdrawn colour (witness substitution);
//   - every grantee twin refuses a recipient other than the pinned one,
//     honestly signed;
//   - both shielded grantee twins refuse a coin above the grant's max coin
//     value and a change entry sealed to a key that is not the live one, each
//     honestly signed;
//   - remove_device refuses the authorising device's own post-roll entry in
//     both forms (the self-removal guard reads the caller's entry).
//
// A refused call must leave the ledger untouched (atomic abort), and the
// honest call then lands on the unchanged state with its effect asserted (the
// simulator records a shielded spend's effects; the Zswap proof and the
// ledger's checks of the spend are the prover suite's and the node's).
//
// Writes $EVIDENCE_DIR/evm-k256-seam-offline.json when EVIDENCE_DIR is set.

import { withExecutedHints, storeCoin, TEST_SITE } from './evm-k256-hint-fill.js';
import { pureCircuits as hintPure } from '../wallet/contract.js';
import { randomBytes } from 'node:crypto';
import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';

import { Contract, ledger } from '../wallet/contract.js';
import { hexToBytes } from '../wallet/hex.js';
import { makeWitnesses, emptyCoinStore, type CoinStorePrivateState } from '../wallet/witnesses.js';
import {
  JubjubDevice, K256Device, grantAuthArgs, RECIPIENT_USER_ADDRESS, RECIPIENT_ZSWAP_COIN_PUBLIC_KEY, RECIPIENT_CONTRACT_ADDRESS,
  type GrantOpening,
} from '../wallet/signer.js';
import {
  SoftwareEvmWallet, EvmK256Device, EvmK256Grantee, evmK256DescriptorInput, evmK256IssueArgs, evmK256GrantScopeSalt, evmK256RecoverySession,
  parseEvmSignature, ed25519Args, evmDeviceDescriptor, EVM_K256_UNUSED_DESCRIPTOR,
} from '../wallet/signer-evm-k256.js';
import { evmK256Messages, type Eip712TypedData, type IssueScope } from '../wallet/evm-k256-codec.js';
import { grantLabel } from '../wallet/descriptors.js';
import { recoveryKey, signRecoverSubmit, recoverSubmitArgs, recoverSubmitChallenge } from '../wallet/recovery-gate.js';
import { deriveShare, split, guardianSecretFromPrf, sealWrap, newRecoverySecret, newSessionNonce } from '../wallet/recovery.js';

const rnd = (n = 32) => new Uint8Array(randomBytes(n));
const ZERO32 = new Uint8Array(32);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

// ── Reporting (the lane's offline shape) ────────────────────────────────────

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(condition: boolean, label: string) {
  if (condition) { pass++; console.log(`  ✓ ${label}`); } else { fail++; failures.push(label); console.log(`  ✗ ${label}`); }
}
/** Every refusal with the generated JavaScript's message, for the evidence. */
const refusals: { label: string; message: string }[] = [];
const sections: { label: string; pass: number; fail: number }[] = [];
async function section(label: string, f: () => Promise<void>) {
  const p0 = pass, f0 = fail;
  console.log(`── ${label}`);
  try { await f(); } catch (e: any) { ok(false, `${label}: unexpected error ${String(e?.message ?? e).slice(0, 300)}`); }
  sections.push({ label, pass: pass - p0, fail: fail - f0 });
}

// ── The simulated account ───────────────────────────────────────────────────

const contract: any = new (Contract as any)(makeWitnesses());
const impure: Record<string, (...a: any[]) => Promise<any>> = contract.impureCircuits;
const coinPk = { bytes: rnd() };
const addressHex: string = sampleContractAddress();
const address = hexToBytes(addressHex.replace(/^0x/, ''));
let privateState: CoinStorePrivateState = emptyCoinStore();
const time = 1_800_000_000;
const birth = newRecoverySecret();
const encSecret = rnd();
const E = await EvmK256Device.enrol(SoftwareEvmWallet.generate(), 'undeployed', 0);
const other = SoftwareEvmWallet.generate(); // a key with no entry and no grant
const salt = rnd();
const init = await contract.initialState(createConstructorContext(privateState, coinPk),
  E.bootCommitment(salt), rnd(), recoveryKey(birth.field).pk, sealWrap(birth.bytes, new Uint8Array(32), encSecret), 3n * 24n * 3600n);
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
const fingerprint = () => JSON.stringify({ round: L().round, nonce: L().auth_nonce, devices: L().device_count, epoch: L().device_epoch, gen: L().grant_generation, pending: L().pending_recovery },
  (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
/** The call must be refused with `needle` and leave the ledger untouched. */
async function refused(label: string, f: () => Promise<unknown>, needle: string) {
  const before = fingerprint();
  try { await f(); ok(false, `${label} (NOT refused)`); return; }
  catch (e: any) {
    const m = String(e?.message ?? e);
    refusals.push({ label, message: m.slice(0, 240) });
    const hit = m.includes(needle);
    ok(hit, `${label}${hit ? '' : ` (refused by "${m.slice(0, 160)}", expected ${needle})`}`);
  }
  ok(fingerprint() === before, `${label}: the ledger is unchanged (atomic abort)`);
}

// ── Approvals ───────────────────────────────────────────────────────────────

const counterOf = (d: { entryAt(a: Uint8Array, e: bigint, k: bigint): Uint8Array }): bigint => {
  for (let k = 0n; k < 256n; k++) if (L().devices.member(d.entryAt(address, L().device_epoch, k))) return k;
  return -1n;
};
type DeviceFrame = { account: Uint8Array; device: Uint8Array; authNonce: bigint };
const frame = (account: Uint8Array = address): DeviceFrame => ({ account, device: E.address, authNonce: L().auth_nonce as bigint });
const sigOf = async (w: SoftwareEvmWallet, td: Eip712TypedData) => { const s = parseEvmSignature(await w.signTypedData(td)); return { r: s.r, s: s.s }; };
/** The device's entry opening with a signature: the device's own (honest),
 *  over another account's frame, another key's, or zero scalars. */
async function deviceAuth(kind: 'honest' | 'foreign' | 'other' | 'zero', msg: (f: DeviceFrame) => Eip712TypedData) {
  const opening = { pk: E.pk, use_counter: counterOf(E), blind: E.blind };
  if (kind === 'honest') { const { arm, ...a } = await E.authorise(msg(frame()), opening.use_counter); return a; }
  if (kind === 'foreign') { const { arm, ...a } = await E.authorise(msg(frame(rnd())), opening.use_counter); return a; }
  if (kind === 'other') return { ...opening, sig: await sigOf(other, msg(frame())) };
  return { ...opening, sig: { r: 0n, s: 0n } };
}
const BODY = { one: 'the one-type body', either: 'the two-form remove_device body', bare: 'the bare body' } as const;

/**
 * A device-gated export: the three refused approvals, then (when the
 * simulator can complete the call) the honest approval through the same call,
 * which consumes the entry and advances auth_nonce.
 */
async function deviceGated(label: string, circuit: string, msg: (f: DeviceFrame) => Eip712TypedData, args: (auth: unknown) => unknown[],
  body: keyof typeof BODY, positive: 'positive' | string, effect?: [string, () => boolean]) {
  await refused(`${label}: an approval over another account's frame, signed by the device`, async () => call(circuit, args(await deviceAuth('foreign', msg))), 'invalid signature');
  await refused(`${label}: another key's signature with the device's entry opening`, async () => call(circuit, args(await deviceAuth('other', msg))), 'invalid signature');
  await refused(`${label}: (r, s) = (0, 0) with the device's entry opening (K256Core's assert, through ${BODY[body]})`, async () => call(circuit, args(await deviceAuth('zero', msg))),
    'k256: signature scalar is zero');
  if (positive === 'positive') {
    const n0 = L().auth_nonce as bigint, c0 = counterOf(E);
    await call(circuit, args(await deviceAuth('honest', msg)));
    ok(L().auth_nonce === n0 + 1n && counterOf(E) === c0 + 1n, `${label}: the honest approval lands through the same call on the unchanged state (positive control: entry rolled, auth_nonce advanced)`);
    if (effect) ok(effect[1](), `${label}: the honest call's effect: ${effect[0]}`);
  } else console.log(`  · ${label}: positive control not in this suite (${positive})`);
}

// ── Grantees ────────────────────────────────────────────────────────────────

const U_COLOR = rnd(), A = rnd(), B = rnd();
const RCPT = rnd(), RCPT_OTHER = rnd(), CONTRACT = rnd(), CONTRACT_OTHER = rnd();
const ZSWAP_PK = rnd(), ZSWAP_PK_OTHER = rnd();
const CHANGE_ENTRY = rnd(192);
const coinOf = (color: Uint8Array) => ({ nonce: rnd(), color, value: 1000n, mtIndex: 3n });
/** held_coin(key) answers `coin` (whose colour may differ: witness substitution). */
const holding = (key: Uint8Array, coin: { nonce: Uint8Array; color: Uint8Array; value: bigint; mtIndex: bigint }) => {
  privateState = { ...privateState, coins: { ...privateState.coins, [hex(key)]: { nonceHex: hex(coin.nonce), colorHex: hex(coin.color), value: coin.value.toString(), mtIndex: coin.mtIndex.toString() } } };
};
const scope = (o: Partial<IssueScope>): IssueScope => ({
  opWithdrawUnshielded: false, opWithdrawShielded: false, opWithdrawShieldedToContract: false, read: false,
  color: ZERO32, recipientKind: 0n, recipient: ZERO32, maxCoinValue: 0n, perCallCap: 0n, cap: 0n, expiresAt: 0n,
  rpIdHash: ZERO32, readPk: ZERO32, windowLen: 0n, windowCap: 0n, caller: null, ...o,
});
interface Granted { g: EvmK256Grantee; wallet: SoftwareEvmWallet; s: IssueScope; salt: Uint8Array; spent: bigint }
async function issue(slot: bigint, s: IssueScope): Promise<Granted> {
  const wallet = SoftwareEvmWallet.generate();
  const g = await EvmK256Grantee.enrol(wallet, 'undeployed', address, grantLabel('bank.example'), slot);
  const gin = g.descriptor();
  // the salt the circuit derives from the issuing device's blind, the account and auth_nonce
  const sSalt = evmK256GrantScopeSalt(E.blind, address, L().auth_nonce as bigint);
  await call('issue_grant_with_evm_k256', [gin, ...ed25519Args(gin), ...evmK256IssueArgs(s), await deviceAuth('honest', (f) => evmK256Messages.issueGrant(f, gin, s))]);
  return { g, wallet, s, salt: sSalt, spent: 0n };
}
const openingOf = (x: Granted): GrantOpening => ({ originHash: x.g.originHash, slot: x.g.slot, scopeSalt: x.salt, recipientKind: x.s.recipientKind,
  pinnedRecipient: x.s.recipient, maxCoinValue: x.s.maxCoinValue, spentPrev: x.spent });
type GranteeFrame = { account: Uint8Array; grantee: Uint8Array; label: Uint8Array; slot: bigint; issuedAt: bigint; grantNonce: bigint };
const gframe = (x: Granted, account: Uint8Array = address): GranteeFrame => {
  const rec = L().grants.lookup(x.g.grantId(address));
  return { account, grantee: x.g.address, label: x.g.label, slot: x.g.slot, issuedAt: rec.issued_at, grantNonce: rec.nonce };
};
async function granteeAuth(x: Granted, kind: 'honest' | 'foreign' | 'other' | 'zero', msg: (f: GranteeFrame) => Eip712TypedData) {
  const base = { arm: 'evm_k256' as const, pk: x.g.pk, blind: x.g.blind, label: x.g.label };
  if (kind === 'honest') return x.g.authorise(msg(gframe(x)));
  if (kind === 'foreign') return x.g.authorise(msg(gframe(x, rnd())));
  if (kind === 'other') return { ...base, sig: await sigOf(other, msg(gframe(x))) };
  return { ...base, sig: { r: 0n, s: 0n } };
}
const twinArgs = (x: Granted, ops: unknown[], a: any) => [...ops, ...grantAuthArgs(openingOf(x), a)];
/** The account's live encryption key (the change entry is sealed to it). */
const ENC = () => L().enc_key as Uint8Array;
/** The honest device call that follows a refusal, on the unchanged state. */
async function honestDevice(label: string, circuit: string, ops: unknown[], msg: (f: DeviceFrame) => Eip712TypedData) {
  const n0 = L().auth_nonce as bigint, c0 = counterOf(E);
  await call(circuit, [...ops, await deviceAuth('honest', msg)]);
  ok(L().auth_nonce === n0 + 1n && counterOf(E) === c0 + 1n, `${label}: the honest call lands on the unchanged state (entry rolled, auth_nonce advanced)`);
}
/** The honest grantee call that follows a refusal, on the unchanged state. */
async function honestTwin(label: string, circuit: string, x: Granted, ops: unknown[], msg: (f: GranteeFrame) => Eip712TypedData, amount: bigint) {
  const id = x.g.grantId(address); const n0 = L().grants.lookup(id).nonce as bigint, a0 = L().auth_nonce as bigint;
  await call(circuit, twinArgs(x, ops, await granteeAuth(x, 'honest', msg)));
  x.spent += amount;
  ok(L().grants.lookup(id).nonce === n0 + 1n && L().auth_nonce === a0, `${label}: the honest call lands on the unchanged state (the record's nonce advanced, auth_nonce untouched)`);
}

// ═══════════════════════════════════════════════════════════════════════════

await call('activate_initial_device_with_evm_k256', E.activationArgs(salt));
await call('deposit_unshielded', [U_COLOR, 1_000n]);

await section('every device-gated export refuses an approval it did not get (the device seam, three bodies)', async () => {
  ok(counterOf(E) === 0n && L().device_count === 1n, 'the evm_k256 device is the only device (counter 0)');
  const newKey = rnd();
  await deviceGated('rotate_enc_key', 'rotate_enc_key_with_evm_k256', (f) => evmK256Messages.rotateEncKey(f, newKey), (a) => [newKey, a], 'one', 'positive',
    ['enc_key is the new key', () => eq(L().enc_key, newKey)]);
  const entry = rnd(192);
  const inbox0 = L().inbox_count as bigint;
  await deviceGated('append_inbox', 'append_inbox_with_evm_k256', (f) => evmK256Messages.appendInbox(f, entry), (a) => [entry, a], 'one', 'positive',
    ['the entry is appended', () => L().inbox_count === inbox0 + 1n && eq(L().inbox.lookup(inbox0), entry)]);
  await deviceGated('withdraw_unshielded', 'withdraw_unshielded_with_evm_k256', (f) => evmK256Messages.withdrawUnshielded(f, U_COLOR, 10n, RCPT, TEST_SITE),
    (a) => [U_COLOR, 10n, { bytes: RCPT }, a], 'one', 'positive', ['only the honest call debited the mirror (990)', () => L().unshielded_balances.lookup(U_COLOR) === 990n]);
  const coinA = coinOf(A); holding(A, coinA);
  const spent = { nonce: coinA.nonce, value: coinA.value, mtIndex: coinA.mtIndex };
  await deviceGated('withdraw_shielded', 'withdraw_shielded_with_evm_k256', (f) => evmK256Messages.withdrawShielded(f, A, 300n, ZSWAP_PK, spent, TEST_SITE),
    (a) => [{ bytes: ZSWAP_PK }, A, 300n, a], 'one', 'positive');
  await deviceGated('withdraw_shielded_to_contract', 'withdraw_shielded_to_contract_with_evm_k256', (f) => evmK256Messages.withdrawShieldedToContract(f, A, 300n, CONTRACT, spent, TEST_SITE),
    (a) => [{ bytes: CONTRACT }, A, 300n, a], 'one', 'positive');
  const K = new K256Device(0x5eed7n);
  const kIn = evmK256DescriptorInput({ scheme: 'k256', x: K.pk.x, y: K.pk.y, envelope: 0 });
  const ep = L().device_epoch as bigint;
  await deviceGated('add_device', 'add_device_with_evm_k256', (f) => evmK256Messages.addDevice(f, kIn), (a) => [kIn, ...ed25519Args(kIn), a], 'one', 'positive',
    ['the k256 device is enrolled', () => L().devices.member(K.entryAt(address, ep, 0n)) && L().device_count === 2n]);
  const NONE = { is_some: false, value: new Uint8Array(32) };
  await deviceGated('remove_device (descriptor form)', 'remove_device_with_evm_k256', (f) => evmK256Messages.removeDevice(f, kIn, ep, 0n),
    (a) => [kIn, ...ed25519Args(kIn), ep, 0n, NONE, a], 'either', 'positive', ['the k256 device is removed by descriptor', () => !L().devices.member(K.entryAt(address, ep, 0n)) && L().device_count === 1n]);
  await call('add_device_with_evm_k256', [kIn, ...ed25519Args(kIn), await deviceAuth('honest', (f) => evmK256Messages.addDevice(f, kIn))]);
  const kEntry = K.entryAt(address, L().device_epoch, 0n);
  await deviceGated('remove_device (literal form)', 'remove_device_with_evm_k256', (f) => evmK256Messages.removeUnknownDevice(f, kEntry),
    (a) => [EVM_K256_UNUSED_DESCRIPTOR, ...ed25519Args(EVM_K256_UNUSED_DESCRIPTOR), 0n, 0n, { is_some: true, value: kEntry }, a], 'either', 'positive',
    ['the k256 device is removed by the literal form', () => !L().devices.member(kEntry) && L().device_count === 1n]);
  const wallet = SoftwareEvmWallet.generate();
  const gi = await EvmK256Grantee.enrol(wallet, 'undeployed', address, grantLabel('bank.example'), 0n);
  const gin = gi.descriptor();
  const sI = scope({ opWithdrawUnshielded: true, color: U_COLOR, recipientKind: RECIPIENT_USER_ADDRESS, recipient: RCPT, maxCoinValue: 100n, perCallCap: 100n, cap: 500n });
  await deviceGated('issue_grant', 'issue_grant_with_evm_k256', (f) => evmK256Messages.issueGrant(f, gin, sI), (a) => [gin, ...ed25519Args(gin), ...evmK256IssueArgs(sI), a], 'one', 'positive',
    ['the grant is recorded, active', () => L().grants.member(gi.grantId(address)) && L().grants.lookup(gi.grantId(address)).active === true]);
  await deviceGated('revoke_grant', 'revoke_grant_with_evm_k256', (f) => evmK256Messages.revokeGrant(f, gin), (a) => [gin, ...ed25519Args(gin), a], 'one', 'positive',
    ['the grant is a tombstone', () => L().grants.lookup(gi.grantId(address)).active === false]);
  // a guardian session (recovery-sim's shape)
  const guardians = [0, 1, 2].map(() => guardianSecretFromPrf(rnd()));
  const sec = newRecoverySecret(); const sid = newSessionNonce();
  const phi = split(sec.field, guardians.map((g, i) => ({ index: i + 1, sigma: deriveShare(sid, address, g) })), 1);
  const session = evmK256RecoverySession({ recoveryPk: recoveryKey(sec.field).pk, sessionNonce: sid, phi, wrap: sealWrap(sec.bytes, address, encSecret) });
  await deviceGated('publish_recovery_session', 'publish_recovery_session_with_evm_k256', (f) => evmK256Messages.publishRecoverySession(f, session),
    (a) => [session.recoveryPk, session.sessionNonce, ...session.phi, session.phiLen, session.wrap, a], 'one', 'positive',
    ['the session is stored as shown', () => eq(L().recovery_session, sid) && L().recovery_phi_len === session.phiLen && eq(L().recovery_wrap, session.wrap)]);
  // a pending recovery through the shared JubJub gate (recovery-sim's shape),
  // so the veto's negatives meet the seam and its honest call lands
  const Q = JubjubDevice.generate(), QR = newRecoverySecret();
  const l = L(); const n = l.auth_nonce as bigint;
  const sub = signRecoverSubmit(recoveryKey(sec.field), Q,
    recoverSubmitChallenge({ contractAddress: address, authNonce: n }, l.recovery_pk, Q.pk, recoveryKey(QR.field).pk, l.device_epoch + 1n, BigInt(time)),
    { successorRecoveryPk: recoveryKey(QR.field).pk, expectedEpoch: l.device_epoch, expectedNonce: n, nowUpper: BigInt(time) });
  await call('recover_submit', recoverSubmitArgs(sub));
  ok(L().pending_recovery === true, 'recover_submit: a recovery is pending (the shared gate)');
  await deviceGated('recover_cancel', 'recover_cancel_with_evm_k256', (f) => evmK256Messages.cancelRecovery(f), (a) => [a], 'bare', 'positive',
    ['the pending recovery is cleared (the veto)', () => L().pending_recovery === false]);
});

const GU = await issue(1n, scope({ opWithdrawUnshielded: true, color: U_COLOR, recipientKind: RECIPIENT_USER_ADDRESS, recipient: RCPT, maxCoinValue: 100n, perCallCap: 100n, cap: 500n }));
const GS = await issue(2n, scope({ opWithdrawShielded: true, read: true, readPk: rnd(), color: A, recipientKind: RECIPIENT_ZSWAP_COIN_PUBLIC_KEY, recipient: ZSWAP_PK, maxCoinValue: 1000n, perCallCap: 500n, cap: 1000n }));
const GC = await issue(3n, scope({ opWithdrawShieldedToContract: true, read: true, readPk: rnd(), color: A, recipientKind: RECIPIENT_CONTRACT_ADDRESS, recipient: CONTRACT, maxCoinValue: 1000n, perCallCap: 500n, cap: 1000n }));
const coinA = coinOf(A);
const spentA = { nonce: coinA.nonce, value: coinA.value, mtIndex: coinA.mtIndex };
const TWIN_U = 'withdraw_unshielded_with_grant_evm_k256', TWIN_S = 'withdraw_shielded_with_grant_evm_k256', TWIN_C = 'withdraw_shielded_to_contract_with_grant_evm_k256';

await section('every grantee twin refuses an approval it did not get (the grant seam)', async () => {
  holding(A, coinA);
  const twins: [string, string, Granted, (f: GranteeFrame) => Eip712TypedData, unknown[], string][] = [
    ['withdraw_unshielded_with_grant', TWIN_U, GU, (f) => evmK256Messages.withdrawUnshieldedAsGrantee(f, U_COLOR, 50n, RCPT, TEST_SITE), [U_COLOR, 50n, { bytes: RCPT }], 'positive'],
    ['withdraw_shielded_with_grant', TWIN_S, GS, (f) => evmK256Messages.withdrawShieldedAsGrantee(f, A, 300n, ZSWAP_PK, CHANGE_ENTRY, ENC(), spentA, TEST_SITE),
      [{ bytes: ZSWAP_PK }, A, 300n, CHANGE_ENTRY, ENC()], 'positive'],
    ['withdraw_shielded_to_contract_with_grant', TWIN_C, GC, (f) => evmK256Messages.withdrawShieldedToContractAsGrantee(f, A, 300n, CONTRACT, CHANGE_ENTRY, ENC(), spentA, TEST_SITE),
      [{ bytes: CONTRACT }, A, 300n, CHANGE_ENTRY, ENC()], 'positive'],
  ];
  for (const [label, circuit, x, msg, ops, positive] of twins) {
    await refused(`${label}: an approval over another account's frame, signed by the grantee`, async () => call(circuit, twinArgs(x, ops, await granteeAuth(x, 'foreign', msg))), 'invalid grant signature');
    await refused(`${label}: another key's signature with the grantee's opening`, async () => call(circuit, twinArgs(x, ops, await granteeAuth(x, 'other', msg))), 'invalid grant signature');
    await refused(`${label}: (r, s) = (0, 0) with the grantee's opening (K256Core's assert, through the grant seam)`, async () => call(circuit, twinArgs(x, ops, await granteeAuth(x, 'zero', msg))),
      'k256: signature scalar is zero');
    if (positive === 'positive') {
      const id = x.g.grantId(address); const n0 = L().grants.lookup(id).nonce as bigint, a0 = L().auth_nonce as bigint;
      await call(circuit, twinArgs(x, ops, await granteeAuth(x, 'honest', msg)));
      x.spent += circuit === TWIN_U ? 50n : 300n; // the cumulative spend the next opening shows
      ok(L().grants.lookup(id).nonce === n0 + 1n && L().auth_nonce === a0, `${label}: the honest approval lands (positive control: the record's nonce advanced, auth_nonce untouched)`);
    } else console.log(`  · ${label}: positive control not in this suite (${positive})`);
  }
});

await section('every shielded spend refuses a held coin of another colour (witness substitution)', async () => {
  // held_coin(A) answers a coin of colour B; every approval names A and that
  // coin's nonce, value and Merkle index, honestly signed
  const coinB = coinOf(B); holding(A, coinB);
  const spentB = { nonce: coinB.nonce, value: coinB.value, mtIndex: coinB.mtIndex };
  const COLOUR = 'held coin colour does not match the withdrawn colour';
  await refused('withdraw_shielded (device): a coin of colour B under an approval for A', async () =>
    call('withdraw_shielded_with_evm_k256', [{ bytes: ZSWAP_PK }, A, 300n, await deviceAuth('honest', (f) => evmK256Messages.withdrawShielded(f, A, 300n, ZSWAP_PK, spentB, TEST_SITE))]), COLOUR);
  await refused('withdraw_shielded_to_contract (device): a coin of colour B under an approval for A', async () =>
    call('withdraw_shielded_to_contract_with_evm_k256', [{ bytes: CONTRACT }, A, 300n, await deviceAuth('honest', (f) => evmK256Messages.withdrawShieldedToContract(f, A, 300n, CONTRACT, spentB, TEST_SITE))]), COLOUR);
  await refused('withdraw_shielded_with_grant: a coin of colour B under a grant and an approval for A', async () =>
    call(TWIN_S, twinArgs(GS, [{ bytes: ZSWAP_PK }, A, 300n, CHANGE_ENTRY, ENC()], await granteeAuth(GS, 'honest', (f) => evmK256Messages.withdrawShieldedAsGrantee(f, A, 300n, ZSWAP_PK, CHANGE_ENTRY, ENC(), spentB, TEST_SITE)))), COLOUR);
  await refused('withdraw_shielded_to_contract_with_grant: a coin of colour B under a grant and an approval for A', async () =>
    call(TWIN_C, twinArgs(GC, [{ bytes: CONTRACT }, A, 300n, CHANGE_ENTRY, ENC()], await granteeAuth(GC, 'honest', (f) => evmK256Messages.withdrawShieldedToContractAsGrantee(f, A, 300n, CONTRACT, CHANGE_ENTRY, ENC(), spentB, TEST_SITE)))), COLOUR);
  // the same calls with the coin of the approved colour, on the unchanged state
  holding(A, coinA);
  await honestDevice('withdraw_shielded (device), the coin of colour A', 'withdraw_shielded_with_evm_k256', [{ bytes: ZSWAP_PK }, A, 300n],
    (f) => evmK256Messages.withdrawShielded(f, A, 300n, ZSWAP_PK, spentA, TEST_SITE));
  await honestDevice('withdraw_shielded_to_contract (device), the coin of colour A', 'withdraw_shielded_to_contract_with_evm_k256', [{ bytes: CONTRACT }, A, 300n],
    (f) => evmK256Messages.withdrawShieldedToContract(f, A, 300n, CONTRACT, spentA, TEST_SITE));
  await honestTwin('withdraw_shielded_with_grant, the coin of colour A', TWIN_S, GS, [{ bytes: ZSWAP_PK }, A, 300n, CHANGE_ENTRY, ENC()],
    (f) => evmK256Messages.withdrawShieldedAsGrantee(f, A, 300n, ZSWAP_PK, CHANGE_ENTRY, ENC(), spentA, TEST_SITE), 300n);
  await honestTwin('withdraw_shielded_to_contract_with_grant, the coin of colour A', TWIN_C, GC, [{ bytes: CONTRACT }, A, 300n, CHANGE_ENTRY, ENC()],
    (f) => evmK256Messages.withdrawShieldedToContractAsGrantee(f, A, 300n, CONTRACT, CHANGE_ENTRY, ENC(), spentA, TEST_SITE), 300n);
});

await section('the recipient pin on both shielded grantee twins (a recipient other than the pinned one, honestly signed)', async () => {
  const PIN = 'recipient not admitted by pin';
  await refused('withdraw_shielded_with_grant: another coin public key than the pinned one', async () =>
    call(TWIN_S, twinArgs(GS, [{ bytes: ZSWAP_PK_OTHER }, A, 300n, CHANGE_ENTRY, ENC()], await granteeAuth(GS, 'honest', (f) => evmK256Messages.withdrawShieldedAsGrantee(f, A, 300n, ZSWAP_PK_OTHER, CHANGE_ENTRY, ENC(), spentA, TEST_SITE)))), PIN);
  await refused('withdraw_shielded_to_contract_with_grant: another contract than the pinned one', async () =>
    call(TWIN_C, twinArgs(GC, [{ bytes: CONTRACT_OTHER }, A, 300n, CHANGE_ENTRY, ENC()], await granteeAuth(GC, 'honest', (f) => evmK256Messages.withdrawShieldedToContractAsGrantee(f, A, 300n, CONTRACT_OTHER, CHANGE_ENTRY, ENC(), spentA, TEST_SITE)))), PIN);
  await refused('withdraw_unshielded_with_grant: another user address than the pinned one', async () =>
    call(TWIN_U, twinArgs(GU, [U_COLOR, 50n, { bytes: RCPT_OTHER }], await granteeAuth(GU, 'honest', (f) => evmK256Messages.withdrawUnshieldedAsGrantee(f, U_COLOR, 50n, RCPT_OTHER, TEST_SITE)))), PIN);
  // the pinned recipients, on the unchanged state
  await honestTwin('withdraw_shielded_with_grant, the pinned coin public key', TWIN_S, GS, [{ bytes: ZSWAP_PK }, A, 300n, CHANGE_ENTRY, ENC()],
    (f) => evmK256Messages.withdrawShieldedAsGrantee(f, A, 300n, ZSWAP_PK, CHANGE_ENTRY, ENC(), spentA, TEST_SITE), 300n);
  await honestTwin('withdraw_shielded_to_contract_with_grant, the pinned contract', TWIN_C, GC, [{ bytes: CONTRACT }, A, 300n, CHANGE_ENTRY, ENC()],
    (f) => evmK256Messages.withdrawShieldedToContractAsGrantee(f, A, 300n, CONTRACT, CHANGE_ENTRY, ENC(), spentA, TEST_SITE), 300n);
  await honestTwin('withdraw_unshielded_with_grant, the pinned user address', TWIN_U, GU, [U_COLOR, 50n, { bytes: RCPT }],
    (f) => evmK256Messages.withdrawUnshieldedAsGrantee(f, U_COLOR, 50n, RCPT, TEST_SITE), 50n);
});

await section('both shielded grantee twins check the coin bound and the live encryption key (honestly signed), then the honest call', async () => {
  // grants whose max coin value (600) is below the held coin's value (1000)
  const GS2 = await issue(4n, scope({ opWithdrawShielded: true, read: true, readPk: rnd(), color: A, recipientKind: RECIPIENT_ZSWAP_COIN_PUBLIC_KEY, recipient: ZSWAP_PK, maxCoinValue: 600n, perCallCap: 500n, cap: 2000n }));
  const GC2 = await issue(5n, scope({ opWithdrawShieldedToContract: true, read: true, readPk: rnd(), color: A, recipientKind: RECIPIENT_CONTRACT_ADDRESS, recipient: CONTRACT, maxCoinValue: 600n, perCallCap: 500n, cap: 2000n }));
  const big = coinOf(A), small = { nonce: rnd(), color: A, value: 600n, mtIndex: 4n };
  const spentOf = (c: typeof big) => ({ nonce: c.nonce, value: c.value, mtIndex: c.mtIndex });
  const stale = rnd();
  const twins: [string, string, Granted, (f: GranteeFrame, enc: Uint8Array, c: ReturnType<typeof spentOf>) => Eip712TypedData, (enc: Uint8Array) => unknown[]][] = [
    ['withdraw_shielded_with_grant', TWIN_S, GS2, (f, enc, c) => evmK256Messages.withdrawShieldedAsGrantee(f, A, 300n, ZSWAP_PK, CHANGE_ENTRY, enc, c, TEST_SITE), (enc) => [{ bytes: ZSWAP_PK }, A, 300n, CHANGE_ENTRY, enc]],
    ['withdraw_shielded_to_contract_with_grant', TWIN_C, GC2, (f, enc, c) => evmK256Messages.withdrawShieldedToContractAsGrantee(f, A, 300n, CONTRACT, CHANGE_ENTRY, enc, c, TEST_SITE), (enc) => [{ bytes: CONTRACT }, A, 300n, CHANGE_ENTRY, enc]],
  ];
  for (const [label, circuit, x, msg, ops] of twins) {
    holding(A, big);
    await refused(`${label}: a coin of value 1000 under a grant whose max coin value is 600`, async () =>
      call(circuit, twinArgs(x, ops(ENC()), await granteeAuth(x, 'honest', (f) => msg(f, ENC(), spentOf(big))))), 'coin above max_coin_value');
    holding(A, small);
    await refused(`${label}: the change entry sealed to a key that is not the live one`, async () =>
      call(circuit, twinArgs(x, ops(stale), await granteeAuth(x, 'honest', (f) => msg(f, stale, spentOf(small))))), 'stale encryption key');
    await honestTwin(`${label}, a coin of value 600 and the live key`, circuit, x, ops(ENC()), (f) => msg(f, ENC(), spentOf(small)), 300n);
  }
});

await section('remove_device refuses the authorising device\'s own post-roll entry in both forms, then removes another device', async () => {
  const SELF = 'cannot remove the authorising device';
  const K = new K256Device(0x5eed8n);
  const kIn = evmK256DescriptorInput({ scheme: 'k256', x: K.pk.x, y: K.pk.y, envelope: 0 });
  await call('add_device_with_evm_k256', [kIn, ...ed25519Args(kIn), await deviceAuth('honest', (f) => evmK256Messages.addDevice(f, kIn))]);
  ok(L().device_count === 2n, 'a second device, so the last-device rule cannot refuse first');
  const ep = L().device_epoch as bigint, c = counterOf(E);
  const selfIn = evmK256DescriptorInput(evmDeviceDescriptor(E));
  const NONE = { is_some: false, value: new Uint8Array(32) };
  // the device signs with its entry at counter c, which rolls to c + 1
  await refused('remove_device (descriptor form): the device names its own post-roll entry', async () =>
    call('remove_device_with_evm_k256', [selfIn, ...ed25519Args(selfIn), ep, c + 1n, NONE, await deviceAuth('honest', (f) => evmK256Messages.removeDevice(f, selfIn, ep, c + 1n))]), SELF);
  const selfPost = E.entryAt(address, ep, c + 1n);
  await refused('remove_device (literal form): the device names its own post-roll entry', async () =>
    call('remove_device_with_evm_k256', [EVM_K256_UNUSED_DESCRIPTOR, ...ed25519Args(EVM_K256_UNUSED_DESCRIPTOR), 0n, 0n, { is_some: true, value: selfPost },
      await deviceAuth('honest', (f) => evmK256Messages.removeUnknownDevice(f, selfPost))]), SELF);
  await honestDevice('remove_device (descriptor form) of the k256 device', 'remove_device_with_evm_k256', [kIn, ...ed25519Args(kIn), ep, 0n, NONE],
    (f) => evmK256Messages.removeDevice(f, kIn, ep, 0n));
  ok(!L().devices.member(K.entryAt(address, ep, 0n)) && L().device_count === 1n, 'remove_device: the k256 device is removed and the device itself kept');
});

await section('revoke_all_grants refuses an approval it did not get (the bare body), then lands', async () => {
  await deviceGated('revoke_all_grants', 'revoke_all_grants_with_evm_k256', (f) => evmK256Messages.revokeAllGrants(f), (a) => [a], 'bare', 'positive');
  ok(L().grant_generation === 1n && L().grants.isEmpty(), 'revoke_all_grants: the generation is bumped and the grants map cleared');
});

console.log('');
for (const s of sections) console.log(`  ${String(s.pass).padStart(3)} passed, ${s.fail} failed  ${s.label}`);
const verdict = fail === 0 && pass > 0 ? 'PASS' : 'FAIL';
console.log(`\n◆ evm-k256-seam-offline: ${verdict} (${pass} passed, ${fail} failed)`);
if (process.env.EVIDENCE_DIR) {
  const fs = await import('node:fs');
  fs.writeFileSync(`${process.env.EVIDENCE_DIR}/evm-k256-seam-offline.json`, JSON.stringify({ suite: 'evm-k256-seam-offline', ranAt: new Date().toISOString(),
    layer: 'runtime (generated JavaScript, compact-runtime simulator)', sections, pass, fail, failures, refusals, verdict }, null, 2) + '\n');
}
process.exit(verdict === 'PASS' ? 0 : 1);
