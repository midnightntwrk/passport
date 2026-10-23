// The checked byte hints of every `evm_eip712` circuit, at the offline layer
// (the compact-runtime local simulator, the generated JavaScript; no node, no
// proof server):
//
//   - every hint field of every circuit that takes one, at each place it is
//     checked (activation, the three device-seam bodies, the grant seam, and
//     each operation's own hints): one byte flipped is refused with the check's
//     message, and the ledger is unchanged;
//   - the carry attack (one byte + 256, the next − 1, which rebuilds the same
//     number) is refused by the runtime's own type check of a `Uint<8>`
//     argument; the circuit's range check of the same byte is the prover
//     suite's (section `hints`, at the proof server);
//   - the honest call then lands on the unchanged state, and the hints the
//     client library computes from the signed typed data equal the ones
//     computed from the executed values;
//   - the display inputs of the readable texts (the site's amount label, a
//     Solana key's base58 digits, the expiry's date and year split) refused
//     by the shared rendering module's checks the same way;
//   - the exported pure oracles refuse a flipped hint too;
//   - the Solana key inputs of the four descriptor circuits (the key's encoded
//     bytes and its x-coordinate's bytes) are checked by the shared encoder,
//     for a Solana target and for the filler key of any other target.
//
// Writes $EVIDENCE_DIR/evm-eip712-hints-offline.json when EVIDENCE_DIR is set.

import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createCircuitContext, createConstructorContext, sampleContractAddress } from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger, pureCircuits as pc } from '../wallet/contract.js';
import { hexToBytes } from '../wallet/hex.js';
import { makeWitnesses, emptyCoinStore, type CoinStorePrivateState } from '../wallet/witnesses.js';
import { JubjubDevice, K256Device, grantAuthArgs, RECIPIENT_USER_ADDRESS, RECIPIENT_ZSWAP_COIN_PUBLIC_KEY, type GrantOpening } from '../wallet/signer.js';
import {
  SoftwareEvmWallet, EvmEip712Device, EvmEip712Grantee, evmEip712DescriptorInput, evmEip712IssueArgs, evmEip712GrantScopeSalt, solArgs, solKeyOf,
} from '../wallet/signer-evm-eip712.js';
import { evmEip712Messages, type Eip712TypedData, type IssueScope } from '../wallet/evm-eip712-codec.js';
import { grantLabel } from '../wallet/descriptors.js';
import {
  evmEip712KeyHint, accountHashHint, bytesHint, leHint, evmEip712DescriptorHint, evmEip712GranteeHint, evmEip712AmountHint, evmEip712CoinHint,
  evmEip712IssueHint,
} from '../wallet/evm-eip712-hints.js';
import { withExecutedHints, storeCoin, forgeHints, TEST_SITE } from './evm-eip712-hint-fill.js';

const rnd = (n = 32) => new Uint8Array(randomBytes(n));
const ZERO32 = new Uint8Array(32);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? hex(x) : x));

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(condition: boolean, label: string) {
  if (condition) { pass++; console.log(`  ✓ ${label}`); } else { fail++; failures.push(label); console.log(`  ✗ ${label}`); }
}
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
const E = await EvmEip712Device.enrol(SoftwareEvmWallet.generate(), 'undeployed', 0);
const salt = rnd();
const init = await contract.initialState(createConstructorContext(privateState, coinPk),
  E.bootCommitment(salt), rnd(), JubjubDevice.generate().pk, new Uint8Array(64), 259_200n);
let state: any = init.currentContractState;
let booted = false;
const L = () => ledger(state) as any;
const ctx = () => ({ account: address, get ledger() { return L(); }, coin: (c: Uint8Array) => storeCoin(privateState, c) });

/** Runs a call; hints are recomputed from the executed values unless the call
 *  is marked KEEP_HINTS. */
async function call(name: string, args0: unknown[]) {
  const args = withExecutedHints(pc, ctx(), name, args0);
  const c: any = createCircuitContext({ circuitId: name, contractAddress: addressHex, coinPublicKeyOrZswapState: coinPk,
    contractState: state, privateState, time } as any);
  const res = await impure[name](c, ...args);
  state = res.context.callContext.currentQueryContext.state;
  privateState = res.context.callContext.currentPrivateState ?? privateState;
  return res;
}
const fingerprint = () => (booted ? json({ r: L().round, n: L().auth_nonce, d: L().device_count, g: L().grant_generation, i: L().inbox_count }) : 'dormant');
async function refused(label: string, f: () => Promise<unknown>, needle: string | RegExp) {
  const before = fingerprint();
  try { await f(); ok(false, `${label} (NOT refused)`); return; }
  catch (e: any) {
    const m = String(e?.message ?? e);
    refusals.push({ label, message: m.slice(0, 240) });
    const hit = typeof needle === 'string' ? m.includes(needle) : needle.test(m);
    ok(hit, `${label}${hit ? '' : ` (refused by "${m.slice(0, 160)}", expected ${needle})`}`);
  }
  ok(fingerprint() === before, `${label}: the ledger is unchanged`);
}

// ── Forging one hint ────────────────────────────────────────────────────────

const BYTE = 'evm_eip712: byte hint does not match its value';
const HASH = 'evm_eip712: hash hint does not match the hash';
const DIGEST = 'evm_eip712: digest hint does not match the digest';
const WORD = 'evm_eip712: word hint does not match its value';
const CARRY = /type error:[\s\S]*expected/;
const SOL_Y = "descriptor: the Ed25519 key bytes do not match the point's y";
const LABEL = 'display: the site amount label does not match the value';
const B58 = 'display: the base58 carry hints do not split the leading digits';
const MONTH = 'display: month out of range';
const SPLIT = 'display: the year split is not canonical';
const SOL_X = "descriptor: the Ed25519 x bytes do not match the point's x";

/** The exact args with the hint at `path` changed (evm-eip712-hint-fill.ts). */
const forged = (circuit: string, args: unknown[], authIndex: number, where: 'auth' | 'op' | number, path: string[], mode: 'flip' | 'carry', at = 0) =>
  forgeHints(pc, ctx(), circuit, args, authIndex, where, path, mode, at);
const fieldName = (where: 'auth' | 'op' | number, path: string[]) =>
  [where === 'auth' ? 'auth.hint' : where === 'op' ? 'hint' : `argument ${where}`, ...path].join('.');
/** Each listed hint field flipped (and, when asked, the carry attack on the first). */
async function eachForged(label: string, circuit: string, args: () => Promise<unknown[]> | unknown[], authIndex: number,
  fields: [where: 'auth' | 'op' | number, path: string[], needle: string][], carry = false) {
  for (const [where, path, needle] of fields) {
    const name = `${label}: ${fieldName(where, path)} with one byte flipped`;
    const a = await args();
    await refused(name, () => call(circuit, forged(circuit, a, authIndex, where, path, 'flip', path.at(-1) === 'origin' ? 3 : 5)), needle);
  }
  if (carry) {
    const [where, path] = fields[0];
    const a = await args();
    await refused(`${label}: the carry attack on ${fieldName(where, path)} (byte + 256, next − 1)`,
      () => call(circuit, forged(circuit, a, authIndex, where, path, 'carry')), CARRY);
  }
}
/** The facade's hints (from the signed typed data) == the executed values' hints. */
function facadeAgrees(label: string, circuit: string, args: unknown[], authIndex: number) {
  const exact: any = withExecutedHints(pc, ctx(), circuit, args);
  ok(json((args[authIndex] as any).hint) === json(exact[authIndex].hint), `${label}: the client library's hints == the hints of the executed values`);
  if (args.length === exact.length) ok(json(args.at(-1)) === json(exact.at(-1)), `${label}: the client library's operation hint == the executed values'`);
}

// ── Approvals ───────────────────────────────────────────────────────────────

const counterOf = (d: EvmEip712Device): bigint => {
  for (let k = 0n; k < 256n; k++) if (L().devices.member(d.entryAt(address, L().device_epoch, k))) return k;
  return -1n;
};
type DeviceFrame = { account: Uint8Array; device: Uint8Array; authNonce: bigint };
const frame = (): DeviceFrame => ({ account: address, device: E.address, authNonce: L().auth_nonce as bigint });
const honest = async (msg: (f: DeviceFrame) => Eip712TypedData) => { const { arm, op, ...a } = await E.authorise(msg(frame()), counterOf(E)); return a; };
/** The honest call through the same circuit, then its landing checked. */
async function lands(label: string, circuit: string, args: unknown[], authIndex: number) {
  if (authIndex >= 0) facadeAgrees(label, circuit, args, authIndex);
  const n0 = booted ? L().auth_nonce : 0n;
  await call(circuit, args);
  ok(!booted || circuit.includes('_with_grant_') || L().auth_nonce === n0 + 1n, `${label}: the honest call lands on the unchanged state`);
}

const U_COLOR = rnd(), A = rnd(), RCPT = rnd(), ZSWAP_PK = rnd(), CONTRACT = rnd(), CHANGE = rnd(192);
const holding = (key: Uint8Array, coin: { nonce: Uint8Array; color: Uint8Array; value: bigint; mtIndex: bigint }) => {
  privateState = { ...privateState, coins: { ...privateState.coins, [hex(key)]: { nonceHex: hex(coin.nonce), colorHex: hex(coin.color), value: coin.value.toString(), mtIndex: coin.mtIndex.toString() } } };
};
const scope = (o: Partial<IssueScope>): IssueScope => ({
  opWithdrawUnshielded: false, opWithdrawShielded: false, opWithdrawShieldedToContract: false, read: false,
  color: ZERO32, recipientKind: 0n, recipient: ZERO32, maxCoinValue: 0n, perCallCap: 0n, cap: 0n, expiresAt: 0n,
  rpIdHash: ZERO32, readPk: ZERO32, windowLen: 0n, windowCap: 0n, caller: null, ...o,
});

// ═══════════════════════════════════════════════════════════════════════════

await section('activation: the key hint (coordinates and key hash)', async () => {
  const args = E.activationArgs(salt);
  for (const [path, needle] of [[['x'], BYTE], [['y'], BYTE], [['key_hash'], HASH]] as [string[], string][]) {
    await refused(`activate: hint.${path.join('.')} with one byte flipped`, () => call('activate_initial_device_with_evm_eip712', forged('activate_initial_device_with_evm_eip712', args, 3, 3, path, 'flip', 7)), needle);
  }
  ok(json(args[3]) === json(evmEip712KeyHint(E.pk)), 'activate: the client library\'s key hint == the hint of the executed point');
  await call('activate_initial_device_with_evm_eip712', args);
  booted = true;
  ok(L().device_count === 1n, 'activate: the honest activation lands');
  await call('deposit_unshielded', [U_COLOR, 1_000n]);
});

await section('the device seam (one-type body): every seam hint, then the honest call', async () => {
  const newKey = rnd();
  const args = async () => [newKey, await honest((f) => evmEip712Messages.rotateEncKey(f, newKey))];
  await eachForged('rotate_enc_key', 'rotate_enc_key_with_evm_eip712', args, 1, [
    ['auth', ['nonce'], WORD], ['auth', ['key', 'x'], BYTE], ['auth', ['key', 'y'], BYTE], ['auth', ['key', 'key_hash'], HASH],
    ['auth', ['account_hash'], HASH], ['auth', ['digest'], DIGEST],
  ], true);
  await lands('rotate_enc_key', 'rotate_enc_key_with_evm_eip712', await args(), 1);
});

await section('the operation hints of the custody circuits', async () => {
  const wu = async () => [U_COLOR, 10n, { bytes: RCPT }, await honest((f) => evmEip712Messages.withdrawUnshielded(f, U_COLOR, 10n, RCPT, TEST_SITE)), evmEip712AmountHint(10n, TEST_SITE)];
  await eachForged('withdraw_unshielded', 'withdraw_unshielded_with_evm_eip712', wu, 3, [['op', ['amount'], WORD], ['op', ['label'], LABEL]], true);
  await lands('withdraw_unshielded', 'withdraw_unshielded_with_evm_eip712', await wu(), 3);
  const coinA = { nonce: rnd(), color: A, value: 1000n, mtIndex: 3n }; holding(A, coinA);
  const spent = { nonce: coinA.nonce, value: coinA.value, mtIndex: coinA.mtIndex };
  const ws = async () => [{ bytes: ZSWAP_PK }, A, 300n, await honest((f) => evmEip712Messages.withdrawShielded(f, A, 300n, ZSWAP_PK, spent, TEST_SITE)), evmEip712CoinHint(300n, 1000n, 3n, TEST_SITE)];
  await eachForged('withdraw_shielded', 'withdraw_shielded_with_evm_eip712', ws, 3,
    [['op', ['amount'], WORD], ['op', ['value'], WORD], ['op', ['mt_index'], WORD], ['op', ['change'], WORD], ['op', ['label'], LABEL]]);
  await lands('withdraw_shielded', 'withdraw_shielded_with_evm_eip712', await ws(), 3);
  const wsc = async () => [{ bytes: CONTRACT }, A, 300n, await honest((f) => evmEip712Messages.withdrawShieldedToContract(f, A, 300n, CONTRACT, spent, TEST_SITE)), evmEip712CoinHint(300n, 1000n, 3n, TEST_SITE)];
  await eachForged('withdraw_shielded_to_contract', 'withdraw_shielded_to_contract_with_evm_eip712', wsc, 3, [['op', ['change'], WORD], ['op', ['value'], WORD]]);
  await lands('withdraw_shielded_to_contract', 'withdraw_shielded_to_contract_with_evm_eip712', await wsc(), 3);
});

await section('the descriptor hints of add_device and remove_device (the two-form body)', async () => {
  const K = new K256Device(0x5eed9n);
  const kIn = evmEip712DescriptorInput({ scheme: 'k256', x: K.pk.x, y: K.pk.y, envelope: 0 });
  const add = async () => [kIn, ...solArgs(kIn), await honest((f) => evmEip712Messages.addDevice(f, kIn)), evmEip712DescriptorHint(kIn)];
  await eachForged('add_device', 'add_device_with_evm_eip712', add, 4, [['op', ['key'], BYTE], ['op', ['key2'], BYTE], ['op', ['origin'], BYTE], ['op', ['b58', 'digits'], B58]], true);
  // any target: the filler key's inputs are checked like a Solana key's
  await eachForged('add_device (the filler key of a k256 target)', 'add_device_with_evm_eip712', add, 4, [[2, [], SOL_Y], [3, [], SOL_X]]);
  await lands('add_device', 'add_device_with_evm_eip712', await add(), 4);
  const ep = L().device_epoch as bigint;
  const NONE = { is_some: false, value: new Uint8Array(32) };
  const rm = async () => [kIn, ...solArgs(kIn), ep, 0n, NONE, await honest((f) => evmEip712Messages.removeDevice(f, kIn, ep, 0n)), { target: evmEip712DescriptorHint(kIn), epoch: leHint(ep, 4), counter: leHint(0n, 8) }];
  await eachForged('remove_device', 'remove_device_with_evm_eip712', rm, 7, [
    ['op', ['target', 'key'], BYTE], ['op', ['target', 'key2'], BYTE], ['op', ['target', 'origin'], BYTE], ['op', ['epoch'], WORD], ['op', ['counter'], WORD],
    ['auth', ['nonce'], WORD], ['auth', ['digest'], DIGEST], ['auth', ['account_hash'], HASH], [2, [], SOL_Y], [3, [], SOL_X],
    ['op', ['target', 'b58', 'digits'], B58],
  ]);
  await lands('remove_device', 'remove_device_with_evm_eip712', await rm(), 7);
});

await section('the Solana key inputs of a Solana target (add_device)', async () => {
  const solIn = evmEip712DescriptorInput({ scheme: 'sol_ed25519', key: ed25519.getPublicKey(rnd()), blind: rnd() });
  const add = async () => [solIn, ...solArgs(solIn), await honest((f) => evmEip712Messages.addDevice(f, solIn)), evmEip712DescriptorHint(solIn)];
  await eachForged('add_device (Solana target)', 'add_device_with_evm_eip712', add, 4, [[2, [], SOL_Y], [3, [], SOL_X], ['op', ['b58', 'digits'], B58]], true);
  await lands('add_device (Solana target)', 'add_device_with_evm_eip712', await add(), 4);
});

let G: { g: EvmEip712Grantee; s: IssueScope; salt: Uint8Array } | undefined;
await section('the grantee and scope hints of issue_grant and revoke_grant', async () => {
  const wallet = SoftwareEvmWallet.generate();
  const g = await EvmEip712Grantee.enrol(wallet, 'undeployed', address, grantLabel('bank.example'), 1n);
  const gin = g.descriptor();
  const s = scope({ opWithdrawUnshielded: true, color: U_COLOR, recipientKind: RECIPIENT_USER_ADDRESS, recipient: RCPT, maxCoinValue: 100n, perCallCap: 100n, cap: 500n,
    expiresAt: 4_000_000_000n });
  const issue = async () => [gin, ...solArgs(gin), ...evmEip712IssueArgs(s), await honest((f) => evmEip712Messages.issueGrant(f, gin, s))];
  const withHint = async () => { const a = await issue(); return [...a, withExecutedHints(pc, ctx(), 'issue_grant_with_evm_eip712', a).at(-1)]; };
  await eachForged('issue_grant', 'issue_grant_with_evm_eip712', withHint, 20, [
    ['op', ['grantee', 'key'], BYTE], ['op', ['grantee', 'key2'], BYTE], ['op', ['grantee', 'origin'], BYTE], ['op', ['grantee', 'label'], BYTE],
    ['op', ['max_coin_value'], WORD], ['op', ['per_call_cap'], WORD], ['op', ['cap'], WORD], ['op', ['expires_at'], WORD], ['op', ['window_len'], WORD], ['op', ['window_cap'], WORD],
    [2, [], SOL_Y], [3, [], SOL_X], ['op', ['grantee', 'b58', 'digits'], B58], ['op', ['expiry_text'], MONTH], ['op', ['year_split'], SPLIT],
  ], true);
  const a = await issue();
  // the salt the circuit derives from the issuing device's blind, the account and auth_nonce
  const iSalt = evmEip712GrantScopeSalt(E.blind, address, L().auth_nonce as bigint);
  await lands('issue_grant', 'issue_grant_with_evm_eip712', [...a, evmEip712IssueHint(gin, s)], 20);
  G = { g, s, salt: iSalt };
  // a second grantee to revoke
  const g2 = await EvmEip712Grantee.enrol(SoftwareEvmWallet.generate(), 'undeployed', address, grantLabel('shop.example'), 2n);
  const gin2 = g2.descriptor();
  await call('issue_grant_with_evm_eip712', [gin2, ...solArgs(gin2), ...evmEip712IssueArgs(s), await honest((f) => evmEip712Messages.issueGrant(f, gin2, s))]);
  const rv = async () => [gin2, ...solArgs(gin2), await honest((f) => evmEip712Messages.revokeGrant(f, gin2)), evmEip712GranteeHint(gin2)];
  await eachForged('revoke_grant', 'revoke_grant_with_evm_eip712', rv, 4, [['op', ['key'], BYTE], ['op', ['key2'], BYTE], ['op', ['origin'], BYTE], ['op', ['label'], BYTE],
    [2, [], SOL_Y], [3, [], SOL_X], ['op', ['b58', 'digits'], B58]]);
  await lands('revoke_grant', 'revoke_grant_with_evm_eip712', await rv(), 4);
});

await section('the grant seam: every seam hint and the operation hints of the grantee twins', async () => {
  const x = G!;
  const opening = (spent: bigint): GrantOpening => ({ originHash: x.g.originHash, slot: x.g.slot, scopeSalt: x.salt, recipientKind: x.s.recipientKind,
    pinnedRecipient: x.s.recipient, maxCoinValue: x.s.maxCoinValue, spentPrev: spent });
  const gframe = () => { const rec = L().grants.lookup(x.g.grantId(address)); return { account: address, grantee: x.g.address, label: x.g.label, slot: x.g.slot, issuedAt: rec.issued_at, grantNonce: rec.nonce }; };
  const tw = async () => {
    const a: any = { ...(await x.g.authorise(evmEip712Messages.withdrawUnshieldedAsGrantee(gframe(), U_COLOR, 50n, RCPT, TEST_SITE))), op: evmEip712AmountHint(50n, TEST_SITE) };
    return [U_COLOR, 50n, { bytes: RCPT }, ...grantAuthArgs(opening(0n), a)];
  };
  await eachForged('withdraw_unshielded_with_grant', 'withdraw_unshielded_with_grant_evm_eip712', tw, 10, [
    ['auth', ['label'], BYTE], ['auth', ['issued_at'], WORD], ['auth', ['grant_nonce'], WORD], ['auth', ['key', 'x'], BYTE], ['auth', ['key', 'key_hash'], HASH],
    ['auth', ['account_hash'], HASH], ['auth', ['digest'], DIGEST], ['op', ['amount'], WORD], ['op', ['label'], LABEL],
  ], true);
  await lands('withdraw_unshielded_with_grant', 'withdraw_unshielded_with_grant_evm_eip712', await tw(), 10);
});

await section('the bare body (revoke_all_grants): the seam hints, then the honest call', async () => {
  const args = async () => [await honest((f) => evmEip712Messages.revokeAllGrants(f))];
  await eachForged('revoke_all_grants', 'revoke_all_grants_with_evm_eip712', args, 0, [['auth', ['nonce'], WORD], ['auth', ['digest'], DIGEST], ['auth', ['account_hash'], HASH], ['auth', ['key', 'y'], BYTE]]);
  await lands('revoke_all_grants', 'revoke_all_grants_with_evm_eip712', await args(), 0);
});

await section('the exported pure oracles refuse a flipped hint', async () => {
  const f = (h: bigint[], i = 4) => h.map((v, j) => (j === i ? v ^ 1n : v));
  const kh = evmEip712KeyHint(E.pk);
  ok(hex(pc.evm_eip712_address(E.pk, kh)) === hex(E.address), 'evm_eip712_address with the exact hint == the device address');
  for (const [k, needle] of [['x', BYTE], ['y', BYTE], ['key_hash', HASH]] as const) {
    await refused(`evm_eip712_address: hint.${k} flipped`, async () => pc.evm_eip712_address(E.pk, { ...kh, [k]: f(kh[k]) }), needle);
  }
  const ah = accountHashHint(address);
  for (const name of ['evm_eip712_verifying_contract', 'evm_eip712_domain_separator'] as const) {
    await refused(`${name}: the account-hash hint flipped`, async () => (pc as any)[name](address, f(ah)), HASH);
  }
  await refused('evm_eip712_digest: the account-hash hint flipped', async () => pc.evm_eip712_digest(address, rnd(), f(ah)), HASH);
  const label = grantLabel('bank.example');
  await refused('evm_eip712_site_label_hash: the label hint flipped', async () => pc.evm_eip712_site_label_hash(label, f(bytesHint(label))), BYTE);
  const kIn = evmEip712DescriptorInput({ scheme: 'k256', x: E.pk.x, y: E.pk.y, envelope: 0 });
  const dh = evmEip712DescriptorHint(kIn);
  await refused('evm_eip712_device_descriptor_hash: hint.key flipped', async () => pc.evm_eip712_device_descriptor_hash(kIn, solKeyOf(kIn), { ...dh, key: f(dh.key) }), BYTE);
  const gin = G!.g.descriptor();
  const gh = evmEip712GranteeHint(gin);
  const solIn = evmEip712DescriptorInput({ scheme: 'sol_ed25519', key: ed25519.getPublicKey(rnd()), blind: rnd() });
  const [sPt, sBytes, sX] = solArgs(solIn);
  ok(hex(pc.evm_eip712_sol_device_target({ bytes: address }, solIn, sPt, sBytes, sX, 0n, 0n)[0]) === hex(solIn.key), 'evm_eip712_sol_device_target with the exact inputs shows the key');
  await refused('evm_eip712_sol_device_target: the key bytes flipped', async () => pc.evm_eip712_sol_device_target({ bytes: address }, solIn, sPt, f(sBytes), sX, 0n, 0n), SOL_Y);
  await refused('evm_eip712_sol_device_target: the x bytes flipped', async () => pc.evm_eip712_sol_device_target({ bytes: address }, solIn, sPt, sBytes, f(sX), 0n, 0n), SOL_X);
  await refused('evm_eip712_grantee_descriptor_hash: hint.label flipped', async () => pc.evm_eip712_grantee_descriptor_hash(gin, solKeyOf(gin), { ...gh, label: f(gh.label) }), BYTE);
  await refused('evm_eip712_struct_withdraw_unshielded: the nonce hint flipped', async () =>
    pc.evm_eip712_struct_withdraw_unshielded(address, E.address, 7n, f(leHint(7n, 8), 0), U_COLOR, 10n, RCPT, evmEip712AmountHint(10n, TEST_SITE)), WORD);
  await refused('evm_eip712_struct_withdraw_unshielded: the amount hint flipped', async () =>
    pc.evm_eip712_struct_withdraw_unshielded(address, E.address, 7n, leHint(7n, 8), U_COLOR, 10n, RCPT, { ...evmEip712AmountHint(10n, TEST_SITE), amount: f(leHint(10n, 16), 0) }), WORD);
  await refused('evm_eip712_struct_withdraw_unshielded: a digit of the amount label changed', async () =>
    pc.evm_eip712_struct_withdraw_unshielded(address, E.address, 7n, leHint(7n, 8), U_COLOR, 10n, RCPT, { ...evmEip712AmountHint(10n, TEST_SITE), label: f(evmEip712AmountHint(10n, TEST_SITE).label, 6) }), LABEL);
  await refused('evm_eip712_struct_withdraw_unshielded_as_grantee: the label hint flipped', async () =>
    pc.evm_eip712_struct_withdraw_unshielded_as_grantee(address, E.address, label, f(bytesHint(label)), 1n, 5n, leHint(5n, 8), 0n, leHint(0n, 8), U_COLOR, 10n, RCPT, evmEip712AmountHint(10n, TEST_SITE)), BYTE);
});

console.log('');
for (const s of sections) console.log(`  ${String(s.pass).padStart(3)} passed, ${s.fail} failed  ${s.label}`);
const verdict = fail === 0 && pass > 0 ? 'PASS' : 'FAIL';
console.log(`\n◆ evm-eip712-hints-offline: ${verdict} (${pass} passed, ${fail} failed)`);
if (process.env.EVIDENCE_DIR) {
  const fs = await import('node:fs');
  fs.writeFileSync(`${process.env.EVIDENCE_DIR}/evm-eip712-hints-offline.json`, JSON.stringify({ suite: 'evm-eip712-hints-offline', ranAt: new Date().toISOString(),
    layer: 'runtime (generated JavaScript, compact-runtime simulator)', sections, pass, fail, failures, refusals, verdict }, null, 2) + '\n');
}
process.exit(verdict === 'PASS' ? 0 : 1);
