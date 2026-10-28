// Off-node grant matrices for the `evm_k256` arm, through the
// compact-runtime local simulator (no node, no proof, no Zswap). They extend
// upstream's grants-offline.ts and grants-caller-offline.ts, which are left
// unchanged, to the new arm in both roles:
//
//   - the arm as OWNER: issue, revoke and revoke-all behind the evm_k256
//     device seam, each grantee shown by its readable descriptor, for k256,
//     JubJub and evm_k256 grantees;
//   - the arm as GRANTEE: withdraw_unshielded_with_grant_evm_k256 under
//     evm_k256, k256 and JubJub owners, signed as readable EIP-712 over the
//     grant frame (the record's issuedAt and nonce, never auth_nonce).
//
// Per pairing, upstream's matrix: the issue rules (and the arm's own: a read
// key only with read, an RP hash only for a passkey grantee), the caller pin
// stored and bound by the owner's signature, the record's fields, re-issue
// and revoke refusals, a read-only grant, one spend (record nonce +1, spent
// commitment, auth_nonce and every device entry untouched, round +1, mirror
// debited), the rejection matrix (stale nonce, per-call cap, cumulative cap,
// spent opening, recipient pin, recipient kind, scope salt, foreign key,
// out-of-scope operation), the grantee key against the device seam, expiry,
// the tombstone and re-issue, revoke-all and the new generation. For the
// evm_k256 grantee also: a wrong blind, label or slot (another grant id),
// r = 0, and the device-role message type presented as a grantee approval.
//
// The caller pin (#176) as grants-caller-offline.ts drives it (callers
// injected into the simulator): a pinned grant refuses no caller, a user
// caller and another contract, and accepts the pinned contract; an
// unrestricted grant's transcript does not depend on the caller; the shared
// gate also dominates the evm_k256 shielded twins.

import { withExecutedHints, storeCoin, TEST_SITE } from './evm-k256-hint-fill.js';
import { pureCircuits as hintPure } from '../wallet/contract.js';
import { evmK256GrantSeamHint, evmK256CoinHint } from '../wallet/evm-k256-hints.js';
import { createHash, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import {
  createCallContext,
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
  type PublicAddress,
} from '@midnight-ntwrk/compact-runtime';

import { Contract, ledger, pureCircuits } from '../wallet/contract.js';
import { hexToBytes } from '../wallet/hex.js';
import { makeWitnesses, emptyCoinStore, withCoin, type CoinStorePrivateState } from '../wallet/witnesses.js';
import {
  JubjubDevice, JubjubGrantee, K256Device, K256Grantee,
  jubjubChallenges, k256Challenges, jubjubGrantChallenges, k256GrantChallenges,
  authArgs, grantAuthArgs, scopeArgs, scopeDigest, originHash,
  RECIPIENT_USER_ADDRESS, RECIPIENT_ZSWAP_COIN_PUBLIC_KEY,
  type PlainScope, type GrantOpening, type GrantContext, type GrantAuthorisation,
} from '../wallet/signer.js';
import {
  SoftwareEvmWallet, EvmK256Device, EvmK256Grantee, evmK256GranteeInput, evmK256IssueArgs, evmK256GrantScopeSalt, parseEvmSignature,
  type EvmK256GrantAuthorisation, ed25519Args} from '../wallet/signer-evm-k256.js';
import { evmK256Messages, typedDataDigest, toHex, labelOf, expiryText, passkeyRpWord, windowWord, type IssueScope, type EvmK256GranteeInput } from '../wallet/evm-k256-codec.js';
import { grantLabel, grantScopeSalt } from '../wallet/descriptors.js';
import { ed25519 } from '@noble/curves/ed25519.js';

const rnd = (n = 32) => new Uint8Array(randomBytes(n));
const ZERO32 = new Uint8Array(32);
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const sha256 = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

// ── Reporting (upstream's shape) ────────────────────────────────────────────

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(condition: boolean, label: string) {
  if (condition) pass++; else { fail++; failures.push(label); console.log(`  ✗ ${label}`); }
}
async function expectAbort(label: string, f: () => Promise<unknown>, needle: string | string[] | { exact: string }) {
  // { exact }: the whole message, so a client refusal is told apart from the
  // runtime's ("failed assert: " + the circuit's message)
  const exact = typeof needle === 'object' && !Array.isArray(needle) ? needle.exact : undefined;
  const needles = exact !== undefined ? [exact] : Array.isArray(needle) ? needle : [needle as string];
  try { await f(); ok(false, `${label} (NOT refused)`); }
  catch (e: any) {
    const m = String(e?.message ?? e);
    const hit = exact !== undefined ? m === exact : needles.some((n) => m.includes(n));
    ok(hit, `${label}${hit ? '' : ` (refused by "${m.slice(0, 160)}", expected ${needles.join(' | ')})`}`);
  }
}
const sections: { label: string; pass: number; fail: number }[] = [];
async function section(label: string, f: () => Promise<void>) {
  const p0 = pass, f0 = fail;
  console.log(`── ${label}`);
  try { await f(); } catch (e: any) { ok(false, `${label}: unexpected error ${String(e?.message ?? e).slice(0, 300)}`); }
  sections.push({ label, pass: pass - p0, fail: fail - f0 });
}

// ── Scope: one plaintext, both owner encodings ──────────────────────────────

/** The scope in the evm_k256 owner's terms (the read key itself). */
type Scope = IssueScope;
const plain = (s: Scope): PlainScope => ({
  opWithdrawUnshielded: s.opWithdrawUnshielded, opWithdrawShielded: s.opWithdrawShielded,
  opWithdrawShieldedToContract: s.opWithdrawShieldedToContract, read: s.read, color: s.color,
  recipientKind: s.recipientKind, recipient: s.recipient, maxCoinValue: s.maxCoinValue, perCallCap: s.perCallCap,
  cap: s.cap, expiresAt: s.expiresAt, rpIdHash: s.rpIdHash, readPkHash: s.read ? sha256(s.readPk) : ZERO32,
  windowLen: s.windowLen, windowCap: s.windowCap, ...(s.caller ? { caller: s.caller } : {}),
});
const spendScope = (o: Partial<Scope>): Scope => ({
  opWithdrawUnshielded: false, opWithdrawShielded: false, opWithdrawShieldedToContract: false, read: false,
  color: ZERO32, recipientKind: 0n, recipient: ZERO32, maxCoinValue: 0n, perCallCap: 0n, cap: 0n, expiresAt: 0n,
  rpIdHash: ZERO32, readPk: ZERO32, windowLen: 0n, windowCap: 0n, caller: null, ...o,
});
const openingOf = (s: Scope, salt: Uint8Array, origin: Uint8Array, slot: bigint): GrantOpening => ({
  originHash: origin, slot, scopeSalt: salt, recipientKind: s.recipientKind, pinnedRecipient: s.recipient,
  maxCoinValue: s.maxCoinValue, spentPrev: 0n,
});

// ── Grantees ────────────────────────────────────────────────────────────────

type GranteeArm = 'k256' | 'jubjub' | 'evm_k256';
interface Grantee {
  arm: GranteeArm;
  origin: Uint8Array;
  grantId(account: Uint8Array, slot: bigint): Uint8Array;
  /** As an evm_k256 owner shows it. */
  descriptor(slot: bigint): EvmK256GranteeInput;
  /** The unshielded twin's authorisation over `g` (a record's frame). */
  sign(g: GrantContext, slot: bigint, color: Uint8Array, amount: bigint, recipient: Uint8Array): Promise<GrantAuthorisation>;
  /** The grantee's key presented to the DEVICE seam of its own arm (it has
   *  no device entry): the circuit and its arguments for rotate_enc_key. */
  asDevice(account: Uint8Array, authNonce: bigint, newKey: Uint8Array): { circuit: string; args: unknown[] };
  /** evm_k256 only: the key, for hand-built approvals, and the grantee's
   *  read key per grant. */
  evm?: { pk: any; blind: Uint8Array; address: Uint8Array; label: Uint8Array; wallet: SoftwareEvmWallet; grantee: EvmK256Grantee };
}
const BANK = 'https://bank.example';
/** A grantee key of `arm`; an evm_k256 grantee derives its blind for the
 *  issuing account (the grantee blind request). */
async function makeGrantee(arm: GranteeArm, issuingAccount: Uint8Array): Promise<Grantee> {
  if (arm === 'k256') {
    const k = K256Grantee.generate();
    const origin = originHash(BANK);
    return { arm, origin, grantId: (a, slot) => k.grantId(a, origin, slot),
      descriptor: (slot) => evmK256GranteeInput({ scheme: 'k256', x: k.pk.x, y: k.pk.y, envelope: 0 }, { originHash: origin, clientId: BANK }, slot),
      sign: async (g, _slot, c, amt, r) => k.sign(k256GrantChallenges.withdrawUnshielded(g, k.pk, c, amt, r)),
      asDevice: (account, authNonce, newKey) => {
        const a = k.sign(k256Challenges.rotateEncKey({ contractAddress: account, authNonce }, k.pk, newKey));
        return { circuit: 'rotate_enc_key_with_k256', args: [newKey, ...authArgs({ arm: 'k256', pk: a.pk, use_counter: 0n, sig: a.sig, envelope: a.envelope })] };
      } };
  }
  if (arm === 'jubjub') {
    const j = JubjubGrantee.generate();
    const origin = originHash(BANK);
    return { arm, origin, grantId: (a, slot) => j.grantId(a, origin, slot),
      descriptor: (slot) => evmK256GranteeInput({ scheme: 'jubjub', x: j.pk.x, y: j.pk.y }, { originHash: origin, clientId: BANK }, slot),
      sign: async (g, _slot, c, amt, r) => j.sign(jubjubGrantChallenges.withdrawUnshielded(g, j.pk, c, amt, r)),
      asDevice: (account, authNonce, newKey) => {
        const a = j.sign(jubjubChallenges.rotateEncKey({ contractAddress: account, authNonce }, j.pk, newKey));
        return { circuit: 'rotate_enc_key_with_jubjub', args: [newKey, ...authArgs({ arm: 'jubjub', pk: a.pk, use_counter: 0n, sig_r: a.sig_r, sig_s: a.sig_s, grind_nonce: a.grind_nonce })] };
      } };
  }
  const label = grantLabel('bank.example');
  const wallet = SoftwareEvmWallet.generate();
  const base = await EvmK256Grantee.enrol(wallet, 'undeployed', issuingAccount, label, 0n);
  const at = (slot: bigint) => base.withGrant(label, slot);
  return { arm, origin: base.originHash, grantId: (a, slot) => at(slot).grantId(a),
    descriptor: (slot) => at(slot).descriptor(),
    sign: async (g, slot, c, amt, r) => at(slot).authorise(evmK256Messages.withdrawUnshieldedAsGrantee(
      { account: g.contractAddress, grantee: base.address, label, slot, issuedAt: g.issuedAt, grantNonce: g.grantNonce }, c, amt, r, TEST_SITE)),
    asDevice: (account, authNonce, newKey) => {
      // the grantee's own wallet signs a device-role RotateEncKey, with its blind
      const td = evmK256Messages.rotateEncKey({ account, device: base.address, authNonce }, newKey);
      const sig = parseEvmSignature(wallet.signDigest(typedDataDigest(td)));
      return { circuit: 'rotate_enc_key_with_evm_k256', args: [newKey, { pk: base.pk, use_counter: 0n, blind: base.blind, sig: { r: sig.r, s: sig.s } }] };
    },
    evm: { pk: base.pk, blind: base.blind, address: base.address, label, wallet, grantee: base } };
}

// ── The simulated account, its owner, and caller injection ──────────────────

type OwnerArm = 'k256' | 'jubjub' | 'evm_k256';
/** `tamperCaller`: the owner signs the scope as given, the call carries this
 *  caller instead (the signed-policy item). `rawReadPk` (evm_k256 owner):
 *  the read key passed to the circuit as given, not canonicalised by the
 *  client. `plain` (upstream owners): fields of the hashed scope overridden
 *  (for example a zero read_pk_hash). */
interface IssueOpts {
  tamperCaller?: Uint8Array | null; rawReadPk?: Uint8Array; plain?: Partial<PlainScope>;
  /** Sign this (client-admissible) scope's message, patched by `patchSigned`,
   *  and execute the given scope: an approval honestly covering values the
   *  client codec would refuse, so the circuit's own rule is what refuses. */
  signedScope?: Scope; patchSigned?: (m: Record<string, unknown>) => void;
}
interface Account {
  address: Uint8Array;
  ownerArm: OwnerArm;
  L(): any;
  /** Invoke an impure circuit (optionally with an injected caller). */
  call(name: string, args: unknown[], caller?: PublicAddress): Promise<any>;
  /** Issues a grant and returns its scope salt: an evm_k256 owner's circuit
   *  derives it (the `salt` given is not used), an upstream owner signs the
   *  given one. */
  issue(grantee: Grantee, slot: bigint, scope: Scope, salt: Uint8Array, opts?: IssueOpts): Promise<Uint8Array>;
  revoke(grantee: Grantee, slot: bigint): Promise<void>;
  revokeAll(): Promise<void>;
  /** The evm_k256 owner (when ownerArm is evm_k256). */
  evmOwner?: EvmK256Device;
  snapshot(): any; restore(s: any): void;
  setTime(t: number): void; time(): number;
  setCoins(ps: CoinStorePrivateState): void;
}

async function openAccount(ownerArm: OwnerArm): Promise<Account> {
  const contract: any = new (Contract as any)(makeWitnesses());
  const impure: Record<string, (...a: any[]) => Promise<any>> = contract.impureCircuits;
  const coinPk = { bytes: rnd() };
  const addressHex: string = sampleContractAddress();
  const address = hexToBytes(addressHex.replace(/^0x/, ''));
  let privateState: CoinStorePrivateState = emptyCoinStore();
  const salt = rnd();
  const jub = ownerArm === 'jubjub' ? JubjubDevice.generate() : undefined;
  const k1 = ownerArm === 'k256' ? K256Device.generate() : undefined;
  const evmOwner = ownerArm === 'evm_k256' ? await EvmK256Device.enrol(SoftwareEvmWallet.generate(), 'undeployed', 0) : undefined;
  const boot = jub ? jub.bootCommitment(salt) : k1 ? k1.bootCommitment(salt) : evmOwner!.bootCommitment(salt);
  const init = await contract.initialState(createConstructorContext(privateState, coinPk), boot, rnd(), JubjubDevice.generate().pk, new Uint8Array(64), 259_200n);
  let state: any = init.currentContractState;
  let counter = 0n;
  let time = 1_800_000_000;
  const L = () => ledger(state) as any;
  async function call(name: string, args0: unknown[], caller?: PublicAddress) {
    const args = withExecutedHints(hintPure, { account: address, get ledger() { return L(); }, coin: (c) => storeCoin(privateState, c) }, name, args0);
    const ctx: any = createCircuitContext({ circuitId: name, contractAddress: addressHex, coinPublicKeyOrZswapState: coinPk,
      contractState: state, privateState, time } as any);
    if (caller !== undefined) {
      ctx.callContext = createCallContext(name, addressHex, coinPk, state, privateState, time, undefined, caller);
      ctx.queryContexts[addressHex] = ctx.callContext.currentQueryContext;
    }
    const res = await impure[name](ctx, ...args);
    state = res.context.callContext.currentQueryContext.state;
    privateState = res.context.callContext.currentPrivateState ?? privateState;
    return res;
  }
  if (jub) await call('activate_initial_device_with_jubjub', [jub.pk, salt]);
  else if (k1) await call('activate_initial_device_with_k256', [k1.pk, salt, k1.envelope]);
  else await call('activate_initial_device_with_evm_k256', evmOwner!.activationArgs(salt));
  const ctx = () => ({ contractAddress: address, authNonce: L().auth_nonce as bigint });
  const evmFrame = () => ({ account: address, device: evmOwner!.address, authNonce: L().auth_nonce as bigint });
  const evmAuth = async (td: any) => { const { arm, ...a } = await evmOwner!.authorise(td, counter); return a; };

  async function issue(g: Grantee, slot: bigint, s: Scope, scopeSalt: Uint8Array, opts: IssueOpts = {}): Promise<Uint8Array> {
    const executed = opts.tamperCaller !== undefined ? { ...s, caller: opts.tamperCaller } : s;
    if (evmOwner) {
      const gin = g.descriptor(slot);
      const td = evmK256Messages.issueGrant(evmFrame(), gin, opts.signedScope ?? s);
      if (opts.patchSigned) opts.patchSigned(td.message as Record<string, unknown>);
      const auth = await evmAuth(td);
      // the salt the circuit derives: the issuing device's blind, the account
      // and the auth_nonce the device signed
      const derived = evmK256GrantScopeSalt(evmOwner.blind, address, L().auth_nonce as bigint);
      const args = evmK256IssueArgs(executed);
      if (opts.rawReadPk) args[12] = opts.rawReadPk;
      await call('issue_grant_with_evm_k256', [gin, ...ed25519Args(gin), ...args, auth]);
      counter++;
      return derived;
    } else {
      const id = g.grantId(address, slot);
      const hashed = { ...plain(s), ...opts.plain };
      const digest = scopeDigest(scopeSalt, hashed);
      const a = jub ? jub.sign(jubjubChallenges.issueGrant(ctx(), jub.pk, id, digest), counter)
                    : k1!.sign(k256Challenges.issueGrant(ctx(), k1!.pk, id, digest), counter);
      await call(`issue_grant_with_${ownerArm}`, [id, ...scopeArgs({ ...plain(executed), ...opts.plain }), scopeSalt, ...authArgs(a)]);
    }
    counter++;
    return scopeSalt;
  }
  async function revoke(g: Grantee, slot: bigint) {
    if (evmOwner) {
      const gin = g.descriptor(slot);
      await call('revoke_grant_with_evm_k256', [gin, ...ed25519Args(gin), await evmAuth(evmK256Messages.revokeGrant(evmFrame(), gin))]);
    } else {
      const id = g.grantId(address, slot);
      const a = jub ? jub.sign(jubjubChallenges.revokeGrant(ctx(), jub.pk, id), counter) : k1!.sign(k256Challenges.revokeGrant(ctx(), k1!.pk, id), counter);
      await call(`revoke_grant_with_${ownerArm}`, [id, ...authArgs(a)]);
    }
    counter++;
  }
  async function revokeAll() {
    if (evmOwner) await call('revoke_all_grants_with_evm_k256', [await evmAuth(evmK256Messages.revokeAllGrants(evmFrame()))]);
    else {
      const a = jub ? jub.sign(jubjubChallenges.revokeAllGrants(ctx(), jub.pk), counter) : k1!.sign(k256Challenges.revokeAllGrants(ctx(), k1!.pk), counter);
      await call(`revoke_all_grants_with_${ownerArm}`, [...authArgs(a)]);
    }
    counter++;
  }
  return {
    address, ownerArm, L, call, issue, revoke, revokeAll, evmOwner,
    snapshot: () => ({ state, counter, privateState }),
    restore: (x: any) => { state = x.state; counter = x.counter; privateState = x.privateState; },
    setTime: (t) => { time = t; }, time: () => time,
    setCoins: (ps) => { privateState = ps; },
  };
}

/** The unshielded twin for `g` at `slot`, signed over the live record (or a
 *  forced nonce), with optional tampering of the presented authorisation. */
async function spend(acc: Account, g: Grantee, slot: bigint, color: Uint8Array, amount: bigint, recipient: Uint8Array, opening: GrantOpening,
  o: { nonce?: bigint; caller?: PublicAddress; tamper?: (a: any) => any; signer?: Grantee } = {}) {
  const id = g.grantId(acc.address, slot);
  const l = acc.L();
  const rec = l.grants.member(id) ? l.grants.lookup(id) : { issued_at: 0n, nonce: 0n };
  const gc: GrantContext = { contractAddress: acc.address, grantId: id, issuedAt: rec.issued_at, grantNonce: o.nonce ?? rec.nonce };
  let a: any = await (o.signer ?? g).sign(gc, slot, color, amount, recipient);
  if (o.tamper) a = o.tamper(a);
  return acc.call(`withdraw_unshielded_with_grant_${a.arm}`, [color, amount, { bytes: recipient }, ...grantAuthArgs(opening, a)], o.caller);
}

// upstream's badSignatureNeedles: a stale JubJub challenge was ground for
// another nonce, so its cast can fail its range check before verification
const badSignature = (arm: GranteeArm) => arm === 'jubjub' ? ['invalid grant signature', 'range error'] : ['invalid grant signature'];
const readNeedle = (owner: OwnerArm) => owner === 'evm_k256' ? 'evm_k256: read without a read key' : 'read without delegate key';

// ── The lifecycle and the unshielded twin, per pairing ──────────────────────

async function scenario(ownerArm: OwnerArm, granteeArm: GranteeArm) {
  const tag = `[owner ${ownerArm} / grantee ${granteeArm}]`;
  const acc = await openAccount(ownerArm);
  const L = () => acc.L();
  const g = await makeGrantee(granteeArm, acc.address);
  const slot = 0n;
  const salt = rnd(), color = rnd(), recipient = rnd();
  const scope = spendScope({ opWithdrawUnshielded: true, color, cap: 450n, perCallCap: 300n, maxCoinValue: 300n,
    recipientKind: RECIPIENT_USER_ADDRESS, recipient });
  const gid = g.grantId(acc.address, slot);
  ok(L().spec_version === 3n && L().grants.isEmpty(), `${tag} spec_version 3, grants empty`);

  // the caller pin stored, and bound by the owner's signature
  const before = acc.snapshot();
  const caller = rnd();
  const pinSalt = await acc.issue(g, slot, { ...scope, caller }, salt);
  ok(eq(L().grants.lookup(gid).scope.caller_commit, pureCircuits.derive_grant_caller_commit(pinSalt, { is_some: true, value: { bytes: caller } })),
    `${tag} the owner signs and stores the caller pin`);
  acc.restore(before);
  await expectAbort(`${tag} a caller pin added to a scope signed unrestricted`, () => acc.issue(g, slot, scope, salt, { tamperCaller: caller }),
    ['invalid signature', 'range error']);
  await expectAbort(`${tag} a pin removed from a scope signed pinned`, () => acc.issue(g, slot, { ...scope, caller }, salt, { tamperCaller: null }),
    ['invalid signature', 'range error']);
  // the issue rules (upstream's chip), each refused before any write. For the
  // evm_k256 owner the client codec mirrors every one of them in the
  // circuit's order with the circuit's message, so each is refused at the
  // client with exactly that text, and again at the runtime
  // under an approval honestly covering the inadmissible values (the signed
  // message patched to show them, so the signature verifies and the chip's
  // own assert refuses).
  const ro = (o: Partial<Scope> = {}) => spendScope({ read: true, readPk: rnd(), ...o });
  const evmOwner = ownerArm === 'evm_k256';
  const rule = (msg: string) => (evmOwner ? { exact: msg } : msg);
  const layer = evmOwner ? " (client, the circuit's message)" : '';
  const shown = (x: Scope): Record<string, unknown> => ({
    withdrawUnshielded: x.opWithdrawUnshielded, withdrawShielded: x.opWithdrawShielded, withdrawShieldedToContract: x.opWithdrawShieldedToContract,
    read: x.read, color: toHex(x.color), recipientKind: labelOf('recipientKind', x.recipientKind), recipient: toHex(x.recipient),
    maxCoinValue: x.maxCoinValue.toString(), perCallCap: x.perCallCap.toString(), cap: x.cap.toString(), expiresAt: x.expiresAt.toString(),
    expiry: expiryText(x.expiresAt), passkeyRpHash: toHex(x.rpIdHash), passkeyRp: passkeyRpWord(x.rpIdHash),
    readKey: toHex(x.read ? x.readPk : ZERO32), windowLength: x.windowLen.toString(), windowCap: x.windowCap.toString(), window: windowWord(x.windowLen, x.windowCap),
    callerPinned: !!x.caller, caller: toHex(x.caller ?? ZERO32),
  });
  const chipRules: [string, Scope, string][] = [
    ['read-only grant cannot restrict caller', ro({ caller }), 'read-only grant cannot restrict caller'],
    ['empty scope', { ...scope, opWithdrawUnshielded: false, cap: 0n, perCallCap: 0n, recipientKind: 0n, color: ZERO32, recipient: ZERO32, maxCoinValue: 0n }, 'empty scope'],
    ['shielded without read', { ...scope, opWithdrawShielded: true }, 'shielded spend requires read'],
    ['per_call_cap > cap', { ...scope, perCallCap: 501n }, 'per-call cap above cap'],
    ['a spending grant with a zero cap', { ...scope, perCallCap: 0n, cap: 0n }, 'spend without cap'],
    ['max_coin_value < per_call_cap', { ...scope, opWithdrawShielded: true, read: true, readPk: rnd(), maxCoinValue: 1n }, 'coin bound below per-call cap'],
    ['window bounds reserved', { ...scope, windowLen: 1n }, 'window bounds reserved'],
    ['read-only grant with object fields', { ...scope, opWithdrawUnshielded: false, read: true, readPk: rnd(), cap: 0n, perCallCap: 0n }, 'read-only grant carries object fields'],
  ];
  for (const [what, x, msg] of chipRules) {
    await expectAbort(`${tag} ${what}${layer}`, () => acc.issue(g, slot, x, salt), rule(msg));
    if (evmOwner) await expectAbort(`${tag} ${what}, honestly signed (runtime, the shared chip)`, () => acc.issue(g, slot, x, salt,
      { signedScope: scope, patchSigned: (m) => { Object.assign(m, shown(x)); } }), { exact: `failed assert: ${msg}` });
  }
  await expectAbort(`${tag} read without a delegate key${layer}`, () => acc.issue(g, slot, { ...scope, read: true, readPk: ZERO32 }, salt, { plain: { readPkHash: ZERO32 } }), rule(readNeedle(ownerArm)));
  if (evmOwner) {
    const noKey = { ...scope, read: true, readPk: ZERO32 };
    await expectAbort(`${tag} read without a read key, honestly signed (runtime, the arm's export)`, () => acc.issue(g, slot, noKey, salt,
      { signedScope: scope, patchSigned: (m) => { Object.assign(m, shown(noKey)); } }), { exact: `failed assert: ${readNeedle(ownerArm)}` });
    await expectAbort(`${tag} a read key without read (client, the circuit's message)`, () => acc.issue(g, slot, { ...scope, readPk: rnd() }, salt), { exact: 'evm_k256: a read key without read' });
  }
  if (ownerArm === 'evm_k256') {
    // the arm's own issue rules (nothing stored that the wallet did not show)
    // signed with read off (readKey shown as zero), executed with a key
    await expectAbort(`${tag} a read key without read`, () => acc.issue(g, slot, scope, salt, { rawReadPk: rnd() }), 'evm_k256: a read key without read');
    const rp = rnd();
    // the client refuses first; under an approval honestly covering it, the circuit refuses
    await expectAbort(`${tag} an RP hash for a non-passkey grantee (client, the circuit's message)`, () => acc.issue(g, slot, { ...scope, rpIdHash: rp }, salt), { exact: 'evm_k256: an RP hash belongs to a spending passkey grant' });
    await expectAbort(`${tag} an RP hash for a non-passkey grantee, honestly signed (runtime)`, () => acc.issue(g, slot, { ...scope, rpIdHash: rp }, salt,
      { signedScope: scope, patchSigned: (m) => { m.passkeyRpHash = toHex(rp); m.passkeyRp = 'see passkeyRpHash'; } }), { exact: 'failed assert: evm_k256: an RP hash belongs to a spending passkey grant' });
    // "any recipient" carries no recipient
    const anyR = { ...scope, recipientKind: 0n, recipient: rnd() };
    await expectAbort(`${tag} any recipient with a recipient (client, the circuit's message)`, () => acc.issue(g, slot, anyR, salt), { exact: 'evm_k256: a recipient for any recipient' });
    await expectAbort(`${tag} any recipient with a recipient, honestly signed (runtime)`, () => acc.issue(g, slot, anyR, salt,
      { signedScope: { ...scope, recipientKind: 0n, recipient: ZERO32 }, patchSigned: (m) => { m.recipient = toHex(anyR.recipient); } }), { exact: 'failed assert: evm_k256: a recipient for any recipient' });
    if (granteeArm === 'evm_k256') {
      // a Solana grantee at the identity point: the descriptor module's
      // ed25519 class refuses it (A != O) through the arm's export. The client
      // codec refuses it first, so the approval is the codec's message for a
      // Solana grantee, patched to show the identity's encoding 01 00…00
      const idEncoding = new Uint8Array(32); idEncoding[0] = 1;
      const solGin = evmK256GranteeInput({ scheme: 'sol_ed25519', key: ed25519.getPublicKey(rnd()), blind: rnd() }, { label: grantLabel('bank.example') }, 5n);
      const solIdGin = { ...solGin, key: idEncoding };
      await expectAbort(`${tag} a Solana grantee at the identity point, honestly signed (runtime, the descriptor module's ed25519 class)`, async () => {
        const evmOwnerDevice = acc.evmOwner!;
        const td = evmK256Messages.issueGrant({ account: acc.address, device: evmOwnerDevice.address, authNonce: L().auth_nonce as bigint }, solGin, scope);
        (td.message as any).grantee.publicKey = toHex(idEncoding);
        let counter = 0n;
        while (counter < 256n && !L().devices.member(evmOwnerDevice.entryAt(acc.address, L().device_epoch, counter))) counter++;
        const { arm, ...auth } = await evmOwnerDevice.authorise(td, counter);
        // the identity's exact byte inputs: its encoding and x = 0
        return acc.call('issue_grant_with_evm_k256', [solIdGin, { x: 0n, y: 1n }, [...idEncoding].map(BigInt), new Array(32).fill(0n),
          ...evmK256IssueArgs(scope), auth]);
      }, { exact: 'failed assert: descriptor: the Ed25519 key is the identity' });
    }
  }
  ok(L().grants.isEmpty() && L().auth_nonce === 0n, `${tag} no record written by a refused issue`);

  // issue over an absent id; an evm_k256 owner's circuit derives the salt
  const salt0 = await acc.issue(g, slot, scope, salt);
  if (acc.evmOwner) {
    ok(eq(salt0, grantScopeSalt('evm_k256', acc.evmOwner.blind, acc.address, 0n)) && !eq(salt0, salt),
      `${tag} the scope salt is the one derived from the issuing device's blind, the account and auth_nonce 0 (the base's client mirror agrees), not one offered`);
  }
  const g0 = L().grants.lookup(gid);
  ok(g0.epoch === 0n && g0.gen === 0n && g0.active && g0.nonce === 0n, `${tag} record epoch/gen/active/nonce`);
  ok(g0.issued_at === L().auth_nonce && g0.issued_at === 1n, `${tag} issued_at = auth_nonce after the device seam`);
  ok(eq(g0.spent_commit, pureCircuits.derive_grant_spent_commit(salt0, 0n)), `${tag} spent_commit commits to 0 under the grant's salt`);
  ok(eq(g0.scope.object_commit, pureCircuits.derive_grant_object_commit(salt0, color, RECIPIENT_USER_ADDRESS, recipient, 300n)), `${tag} object_commit under the grant's salt`);
  ok(eq(g0.scope.rp_commit, pureCircuits.derive_grant_rp_commit(salt0, ZERO32)), `${tag} rp_commit under the grant's salt`);
  ok(eq(g0.scope.read_pk_hash, ZERO32), `${tag} read_pk_hash zero when read is off`);
  ok(g0.scope.per_call_cap === 300n && g0.scope.cap === 450n && g0.scope.expires_at === 0n, `${tag} clear scope fields`);
  await expectAbort(`${tag} re-issue over a live id`, () => acc.issue(g, slot, scope, salt), 'grant already active');

  // a read-only grant under slot 1: read_pk_hash = SHA-256(read key); an
  // evm_k256 grantee's read key is the one it derives for this account and grant
  const readPk = g.evm ? g.evm.grantee.withGrant(g.evm.label, 1n).readKey(acc.address).publicKey : rnd();
  const saltRo = await acc.issue(g, 1n, ro({ readPk }), rnd());
  const gRo = L().grants.lookup(g.grantId(acc.address, 1n));
  ok(gRo.scope.read === true && eq(gRo.scope.read_pk_hash, sha256(readPk)), `${tag} read-only grant (slot 1): read_pk_hash = SHA-256(read key)`);
  if (acc.evmOwner) {
    ok(!eq(saltRo, salt0) && eq(saltRo, grantScopeSalt('evm_k256', acc.evmOwner.blind, acc.address, 1n)) && eq(gRo.spent_commit, pureCircuits.derive_grant_spent_commit(saltRo, 0n)),
      `${tag} a later issuance (auth_nonce 1) derives another salt, and its commitments use it`);
  }

  // one spend
  await acc.call('deposit_unshielded', [color, 1_000n]);
  const opening = openingOf(scope, salt0, g.origin, slot);
  const authBefore = L().auth_nonce, roundBefore = L().round, devicesBefore = [...L().devices].map(hex).sort().join(), countBefore = L().device_count;
  await spend(acc, g, slot, color, 200n, recipient, opening);
  opening.spentPrev = 200n;
  const g1 = L().grants.lookup(gid);
  ok(g1.nonce === 1n, `${tag} the grant call advances the record nonce`);
  ok(eq(g1.spent_commit, pureCircuits.derive_grant_spent_commit(salt0, 200n)), `${tag} spent_commit re-commits`);
  ok(L().auth_nonce === authBefore, `${tag} auth_nonce untouched by the grant call (GR-5)`);
  ok([...L().devices].map(hex).sort().join() === devicesBefore && L().device_count === countBefore, `${tag} no device entry touched`);
  ok(L().round === roundBefore + 1n, `${tag} round advanced once`);
  ok(L().unshielded_balances.lookup(color) === 800n, `${tag} mirror debited`);

  // the rejection matrix; each item leaves state unchanged
  const snap = acc.snapshot();
  await expectAbort(`${tag} identical resubmission (stale nonce)`, () => spend(acc, g, slot, color, 200n, recipient, opening, { nonce: 0n }), badSignature(granteeArm));
  await expectAbort(`${tag} over per_call_cap`, () => spend(acc, g, slot, color, 301n, recipient, opening), 'amount above per-call cap');
  await expectAbort(`${tag} over the cumulative cap`, () => spend(acc, g, slot, color, 300n, recipient, opening), 'cumulative cap exceeded');
  await expectAbort(`${tag} wrong spent_prev`, () => spend(acc, g, slot, color, 100n, recipient, { ...opening, spentPrev: 0n }), 'spent opening mismatch');
  await expectAbort(`${tag} wrong recipient under the pin`, () => spend(acc, g, slot, color, 100n, rnd(), opening), 'recipient not admitted by pin');
  await expectAbort(`${tag} recipient-kind mismatch`, () => spend(acc, g, slot, color, 100n, recipient, { ...opening, recipientKind: RECIPIENT_ZSWAP_COIN_PUBLIC_KEY }), 'scope object mismatch');
  await expectAbort(`${tag} wrong scope_salt`, () => spend(acc, g, slot, color, 100n, recipient, { ...opening, scopeSalt: rnd() }), 'scope object mismatch');
  await expectAbort(`${tag} a foreign key (no record)`, async () => { const f = await makeGrantee(granteeArm, acc.address); return spend(acc, f, slot, color, 100n, recipient, opening); }, 'unknown grant');
  await expectAbort(`${tag} out-of-scope operation (a shielded-only grant used unshielded)`, async () => {
    const sh = spendScope({ opWithdrawShielded: true, read: true, readPk: rnd(), color, cap: 450n, perCallCap: 300n, maxCoinValue: 300n, recipientKind: RECIPIENT_USER_ADDRESS, recipient });
    const s2 = await acc.issue(g, 2n, sh, rnd());
    await spend(acc, g, 2n, color, 10n, recipient, openingOf(sh, s2, g.origin, 2n));
  }, 'operation not in scope');
  if (granteeArm === 'evm_k256') {
    const eg = g;
    await expectAbort(`${tag} evm grantee: r = 0`, () => spend(acc, eg, slot, color, 10n, recipient, opening, { tamper: (a) => ({ ...a, sig: { ...a.sig, r: 0n } }) }), 'k256: signature scalar is zero');
    await expectAbort(`${tag} evm grantee: another blind (another grant id)`, () => spend(acc, eg, slot, color, 10n, recipient, opening, { tamper: (a) => ({ ...a, blind: rnd() }) }), 'unknown grant');
    await expectAbort(`${tag} evm grantee: another site label (another grant id)`, () => spend(acc, eg, slot, color, 10n, recipient, opening, { tamper: (a) => ({ ...a, label: grantLabel('evil.example') }) }), 'unknown grant');
    await expectAbort(`${tag} evm grantee: another slot (another grant id)`, () => spend(acc, eg, slot, color, 10n, recipient, { ...opening, slot: 7n }), 'unknown grant');
  }
  acc.restore(snap);
  ok(L().grants.lookup(gid).nonce === 1n && L().unshielded_balances.lookup(color) === 800n, `${tag} state restored for the next items`);

  // the grantee key against the device seam of its own arm (no device entry)
  await expectAbort(`${tag} the grantee key against the device seam`, async () => {
    const { circuit, args } = g.asDevice(acc.address, L().auth_nonce, rnd());
    await acc.call(circuit, args);
  }, 'unknown device entry');

  // expiry through the simulated block time
  const exp = { ...scope, expiresAt: BigInt(acc.time() + 100) };
  const sExp = await acc.issue(g, 3n, exp, rnd());
  const oExp = openingOf(exp, sExp, g.origin, 3n);
  await spend(acc, g, 3n, color, 10n, recipient, oExp);
  ok(L().grants.lookup(g.grantId(acc.address, 3n)).nonce === 1n, `${tag} a call before expires_at executes`);
  oExp.spentPrev = 10n;
  acc.setTime(acc.time() + 200);
  await expectAbort(`${tag} a call after expires_at`, () => spend(acc, g, 3n, color, 10n, recipient, oExp), 'grant expired');
  acc.setTime(acc.time() - 200);

  // revoke, tombstone, re-issue
  await acc.revoke(g, slot);
  ok(L().grants.lookup(gid).active === false && L().grants.lookup(gid).nonce === 1n, `${tag} revoke writes a tombstone`);
  await expectAbort(`${tag} a call against a tombstone`, () => spend(acc, g, slot, color, 10n, recipient, opening), 'grant revoked');
  await expectAbort(`${tag} revoke of a tombstone`, () => acc.revoke(g, slot), 'grant not live');
  await expectAbort(`${tag} revoke of an absent id (another slot)`, () => acc.revoke(g, 9n), 'unknown grant');
  const sNew = await acc.issue(g, slot, scope, rnd());
  ok(L().grants.lookup(gid).active && L().grants.lookup(gid).nonce === 0n && L().grants.lookup(gid).issued_at > g0.issued_at, `${tag} re-issue over a tombstone: a fresh incarnation`);
  if (acc.evmOwner) ok(!eq(sNew, salt0) && eq(L().grants.lookup(gid).spent_commit, pureCircuits.derive_grant_spent_commit(sNew, 0n)), `${tag} the re-issued grant has its own salt (a later auth_nonce), and its commitments use it`);
  await expectAbort(`${tag} a prior-incarnation opening`, () => spend(acc, g, slot, color, 10n, recipient, { ...opening, spentPrev: 0n }), 'scope object mismatch');

  // revoke-all and the new generation
  await acc.revokeAll();
  ok(L().grant_generation === 1n && L().grants.isEmpty(), `${tag} revoke_all bumps the generation and clears the map`);
  await expectAbort(`${tag} a call after revoke_all`, () => spend(acc, g, slot, color, 10n, recipient, openingOf(scope, sNew, g.origin, slot)), 'unknown grant');
  await acc.issue(g, slot, scope, sNew);
  ok(L().grants.lookup(gid).gen === 1n, `${tag} re-issue under generation 1`);
}

// ── The caller pin on the evm_k256 twins (grants-caller-offline's matrix) ─

async function callerMatrix(ownerArm: OwnerArm) {
  const tag = `[caller pin, owner ${ownerArm} / grantee evm_k256]`;
  const acc = await openAccount(ownerArm);
  const g = await makeGrantee('evm_k256', acc.address);
  const hexOf = (b: Uint8Array) => Buffer.from(b).toString('hex');
  const pinned = rnd(), wrong = rnd();
  const contractCaller = (b: Uint8Array): PublicAddress => ({ tag: 'contract', address: hexOf(b) } as PublicAddress);
  const good = contractCaller(pinned);
  const bad: (PublicAddress | undefined)[] = [undefined, { tag: 'user', address: hexOf(pinned) } as PublicAddress, contractCaller(wrong)];
  const color = rnd(), recipient = rnd();
  await acc.call('deposit_unshielded', [color, 100n]);
  const base = spendScope({ opWithdrawUnshielded: true, color, cap: 20n, perCallCap: 10n, maxCoinValue: 10n });
  const salt = await acc.issue(g, 0n, { ...base, caller: pinned }, rnd());
  const id = g.grantId(acc.address, 0n);
  ok(eq(acc.L().grants.lookup(id).scope.caller_commit, pureCircuits.derive_grant_caller_commit(salt, { is_some: true, value: { bytes: pinned } })), `${tag} pin stored`);
  const opening = openingOf(base, salt, g.origin, 0n);
  for (const c of bad) {
    await expectAbort(`${tag} caller ${c ? c.tag : 'none'}${c && c.tag === 'contract' ? ' (another contract)' : ''} refused`,
      () => spend(acc, g, 0n, color, 5n, recipient, opening, { caller: c }), ['grant requires a contract caller', 'grant caller mismatch']);
    ok(acc.L().grants.lookup(id).nonce === 0n, `${tag} nonce unchanged after a refused caller`);
  }
  await expectAbort(`${tag} a damaged signature from the pinned contract`, () => spend(acc, g, 0n, color, 5n, recipient, opening,
    { caller: good, tamper: (a) => ({ ...a, sig: { ...a.sig, s: 1n } }) }), 'invalid grant signature');
  await spend(acc, g, 0n, color, 5n, recipient, opening, { caller: good });
  ok(acc.L().grants.lookup(id).nonce === 1n, `${tag} the pinned contract's call executes`);
  // unrestricted: the transcript does not depend on the caller
  await acc.revoke(g, 0n);
  const s2 = await acc.issue(g, 0n, base, rnd());
  const o2 = openingOf(base, s2, g.origin, 0n);
  const before = acc.snapshot();
  const transcripts: string[] = [];
  for (const c of [...bad, good]) {
    acc.restore(before);
    const r = await spend(acc, g, 0n, color, 1n, recipient, o2, { caller: c });
    transcripts.push(JSON.stringify(r.context.callProofDataTrace.at(-1).publicTranscript, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  }
  ok(transcripts.every((t) => t === transcripts[0]), `${tag} an unrestricted grant's transcript is caller-independent (4 callers)`);
  // the shared caller gate dominates both evm_k256 shielded twins
  acc.restore(before);
  await acc.revoke(g, 0n);
  const sh = spendScope({ ...base, opWithdrawShielded: true, opWithdrawShieldedToContract: true, read: true, readPk: rnd(), maxCoinValue: 10n, caller: pinned });
  const s3 = await acc.issue(g, 0n, sh, rnd());
  const coin = { nonce: rnd(), color, value: 10n, mtIndex: 0n };
  acc.setCoins(withCoin(emptyCoinStore(), coin));
  const enc = acc.L().enc_key;
  const k = g.evm!;
  for (const name of ['withdraw_shielded', 'withdraw_shielded_to_contract']) {
    const rec = acc.L().grants.lookup(id);
    const frame = { account: acc.address, grantee: k.address, label: grantLabel('bank.example'), slot: 0n, issuedAt: rec.issued_at, grantNonce: rec.nonce };
    const change = rnd(192);
    const td = name === 'withdraw_shielded'
      ? evmK256Messages.withdrawShieldedAsGrantee(frame, color, 5n, recipient, change, enc, { nonce: coin.nonce, value: 10n, mtIndex: 0n }, TEST_SITE)
      : evmK256Messages.withdrawShieldedToContractAsGrantee(frame, color, 5n, recipient, change, enc, { nonce: coin.nonce, value: 10n, mtIndex: 0n }, TEST_SITE);
    const sig = parseEvmSignature(k.wallet.signDigest(typedDataDigest(td)));
    const a: EvmK256GrantAuthorisation = { arm: 'evm_k256', pk: k.pk, blind: k.blind, label: grantLabel('bank.example'), sig: { r: sig.r, s: sig.s },
      hint: evmK256GrantSeamHint(k.pk, typedDataDigest(td), grantLabel('bank.example'), rec.issued_at, rec.nonce),
      op: evmK256CoinHint(5n, 10n, 0n, TEST_SITE) };
    await expectAbort(`${tag} ${name}: another contract caller refused by the shared gate`,
      () => acc.call(`${name}_with_grant_evm_k256`, [{ bytes: recipient }, color, 5n, change, enc, ...grantAuthArgs(openingOf(sh, s3, g.origin, 0n), a)], contractCaller(wrong)),
      'grant caller mismatch');
  }
}

// ── A grantee's read keys (the client) ──────────────────────────────────────

/** A grantee derives a fresh X25519 read key per issuing account and per
 *  grant, from its own wallet: the same wallet and grant give the same key,
 *  another account, label or slot another key; the issuer, which knows only
 *  the grantee's public descriptor and blind, cannot derive it. */
async function readKeys() {
  const tag = '[read key]';
  const wallet = SoftwareEvmWallet.generate();
  const A1 = rnd(), A2 = rnd();
  const bank = grantLabel('bank.example'), shop = grantLabel('shop.example');
  const g1 = await EvmK256Grantee.enrol(wallet, 'undeployed', A1, bank, 0n);
  const k = g1.readKey(A1);
  const again = (await EvmK256Grantee.enrol(wallet, 'undeployed', A1, bank, 0n)).readKey(A1);
  ok(eq(k.secretKey, again.secretKey) && eq(k.publicKey, again.publicKey), `${tag} the same wallet, account and grant derive the same key`);
  // the public key is X25519(sk, 9), computed independently by Node
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(k.secretKey)]);
  const spki = createPublicKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' });
  const nodePub = new Uint8Array(spki.subarray(spki.length - 32));
  ok(eq(nodePub, k.publicKey), `${tag} read_pk = X25519(sk, 9) (Node's implementation agrees)`);
  ok((k.secretKey[0] & 7) === 0 && (k.secretKey[31] & 128) === 0 && (k.secretKey[31] & 64) === 64, `${tag} the secret is clamped per RFC 7748`);
  const g2 = await EvmK256Grantee.enrol(wallet, 'undeployed', A2, bank, 0n);
  const keys = [k, g2.readKey(A2), g1.withGrant(bank, 1n).readKey(A1), g1.withGrant(shop, 0n).readKey(A1), g1.readKey(A2)];
  const distinct = new Set(keys.map((x) => hex(x.publicKey))).size === keys.length;
  ok(distinct, `${tag} another issuing account, slot or site label gives another key (${keys.length} keys, all different)`);
  ok(!eq(k.secretKey, g1.blind) && !eq(k.publicKey, g1.blind) && !eq(k.publicKey, g2.blind), `${tag} the read key is not the grantee blind the issuer learns`);
  // the issuer's view: the grantee rebuilt from what the issuer holds (point,
  // blind, label, slot) has no read seed, and no wallet to derive it from
  const issuerView = new EvmK256Grantee(g1.pk, g1.blind, bank, 0n);
  await expectAbort(`${tag} a grantee rebuilt from its descriptor cannot derive the key`, async () => issuerView.readKey(A1), 'has no read seed');
  await expectAbort(`${tag} nor from a wallet it does not hold`, () => issuerView.readKeyFromWallet(A1), 'has no wallet');
  // the grantee's own record holds the blind and never the read seed; read
  // back from it, the grantee derives the same key from one signature
  const rec = g1.toRecord();
  ok(!('readSeed' in rec) && !JSON.stringify(rec).includes(Buffer.from(k.secretKey).toString('hex')), `${tag} the grantee record holds no read seed`);
  let asked = 0;
  const counting = { address: () => wallet.address(), personalSign: (m: Uint8Array) => { asked++; return wallet.personalSign(m); }, signTypedData: (t: any) => wallet.signTypedData(t) };
  const fromRecord = EvmK256Grantee.fromRecord(JSON.parse(JSON.stringify(rec)), bank, 0n, counting);
  const kr = await fromRecord.readKeyFromWallet(A1);
  const kr2 = await fromRecord.withGrant(bank, 1n).readKeyFromWallet(A1);
  ok(eq(kr.secretKey, k.secretKey) && eq(kr2.secretKey, g1.withGrant(bank, 1n).readKey(A1).secretKey) && asked === 1, `${tag} read back from its record, the grantee derives the same keys from one signature`);
  // the issuer's rule holds for the derived key: SHA-256 of it is what a read grant stores
  ok(!eq(sha256(k.publicKey), ZERO32), `${tag} the published read_pk_hash is a hash of the derived key`);
}

async function main() {
  await section('[read key] a grantee\'s read key per account and grant', readKeys);
  for (const [o, g] of [['evm_k256', 'k256'], ['evm_k256', 'jubjub'], ['evm_k256', 'evm_k256'], ['k256', 'evm_k256'], ['jubjub', 'evm_k256']] as [OwnerArm, GranteeArm][]) {
    await section(`[owner ${o} / grantee ${g}] lifecycle and the unshielded grant twin`, () => scenario(o, g));
  }
  for (const o of ['evm_k256', 'jubjub'] as OwnerArm[]) await section(`[caller pin] owner ${o}, grantee evm_k256`, () => callerMatrix(o));
  console.log('');
  for (const s of sections) console.log(`  ${String(s.pass).padStart(3)} passed, ${s.fail} failed  ${s.label}`);
  console.log(`\n◆ evm-k256-grants-offline: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} passed, ${fail} failed)`);
  if (process.env.EVIDENCE_DIR) {
    const fs = await import('node:fs');
    fs.writeFileSync(`${process.env.EVIDENCE_DIR}/evm-k256-grants-offline.json`, JSON.stringify({ suite: 'evm-k256-grants-offline', ranAt: new Date().toISOString(), sections, pass, fail, failures, verdict: fail === 0 ? 'PASS' : 'FAIL' }, null, 2) + '\n');
  }
  process.exit(fail === 0 ? 0 : 1);
}
await main();
