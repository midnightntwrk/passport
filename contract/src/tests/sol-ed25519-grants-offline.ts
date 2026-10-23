// Arm `sol_ed25519`: scoped grants, offline (the generated JavaScript, no
// proof server, no node). Upstream's grants-offline / grants-caller-offline
// matrices, extended in this new file (upstream's suites are untouched):
//
//   1 issue      a sol_ed25519 owner issues to a grantee of every scheme
//                (sol_ed25519, evm_eip712, k256 and JubJub with the
//                labelled origin hash, a passkey with its origin); each grant
//                id equals the grantee scheme's own derivation; the record
//                (issued_at = auth_nonce, nonce 0, read_pk_hash = SHA-256 of
//                the shown read key);
//   2 rules      the arm's issue rules under a valid signature (a read key
//                without read, read without a key, an RP hash on a
//                non-passkey grantee: refused by the renderer first and by
//                the circuit past the client), the grantee's point, the
//                shared chip's rules reached through the arm;
//   3 binding    every shown scope field and grantee field changed at
//                execution (consistent display inputs): the signature refuses;
//                issue_grant and revoke_grant approved over a message showing
//                a foreign account: the seam's frame check refuses, then the
//                honest call lands;
//   4 twins      a sol_ed25519 grantee under its grant: in-scope unshielded,
//                shielded and to-contract spends (the change entry
//                appended), never touching auth_nonce or a device entry;
//                refused outside the scope (the operation not in scope, both
//                ways, per-call cap, cap, recipient pin, colour, max coin
//                value, stale encryption key, expiry, revoked, revoke-all),
//                the replayed approval, witness substitution (colour, on the
//                shielded and the to-contract twin); the grant seam itself on
//                all three twins (a message showing a foreign account; R = O
//                with the verification equation holding); a recipient pin on
//                both shielded twins; revoke_all_grants approved over a
//                foreign account and by a key that is no device;
//   5 roles      cross-role replay: the same key's
//                device-role approval presented to the grant seam, its
//                grantee-role approval presented to the device seam;
//   6 owners     upstream jubjub and k256 owners issue to a sol_ed25519
//                grantee (grant id from derive_grant_id_with_sol_ed25519),
//                which spends under them;
//   7 caller     the #176 caller pin: refused without a contract caller and
//                with another, lands with the pinned one (callers injected
//                into the simulator, as upstream's grants-caller-offline);
//   8 blind      a grantee blind never equals the same wallet's device
//                blind, and differs per issuing account;
//   9 module     the base modules' asserts reached through issue_grant;
//  10 salt       the grant's scope salt is derived in-circuit from the
//                issuing device's blind, the account and the signed
//                auth_nonce: the chip's commitments are over it, the client
//                computes the same value, two issuances differ, and a grantee
//                spend opened with any other salt (random, zero, at nonce 0,
//                another blind, the next issuance's, the other arm's) is
//                refused; the grantee's read key is fresh per account and
//                grant, an X25519 pair, and a read grant stores its hash.
//
// Writes $EVIDENCE_DIR/sol-ed25519-grants-offline.json when EVIDENCE_DIR is set.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { createCallContext, createCircuitContext, createConstructorContext, sampleContractAddress, type PublicAddress } from '@midnight-ntwrk/compact-runtime';

import { Contract, ledger, pureCircuits } from '../wallet/contract.js';
import { makeWitnesses, emptyCoinStore, withCoin } from '../wallet/witnesses.js';
import {
  JubjubDevice, JubjubGrantee, K256Grantee, authArgs, grantAuthArgs, jubjubChallenges, jubjubGrantChallenges, k256GrantChallenges,
  originHash, scopeArgs, scopeDigest, spendScope, type GrantOpening,
} from '../wallet/signer.js';
import { DESCRIPTOR_TAGS, grantOriginHash, grantScopeSalt, padTag } from '../wallet/descriptors.js';
import {
  ED25519_L, SolEd25519Device, SolEd25519Grantee, authoriseSolDevice, authoriseSolGrantee, deriveSolBlind, deriveSolGranteeBlind, solDeviceMessageCircuit, solGrantScopeSalt, solGranteeReadKey,
  solGranteeMessageCircuit, solGranteeOf, solKeyHints, solSoftwareSigner, type SolEd25519Authorisation, type SolEd25519GrantAuthorisation, type SolIssueScope,
} from '../wallet/signer-sol-ed25519.js';
/** The key argument of a point with its own consistent byte inputs. */
const keyOf = (p: { x: bigint; y: bigint }) => ({ pk: { x: p.x, y: p.y }, ...solKeyHints(p) });
import { solBase58, solGranteeArg, solTargetPoint, solTargetPointArg, solUnusedKey, labelBytes, solMessageBytes, type SolAmount, type SolGranteeFields } from '../wallet/sol-ed25519-message.js';
import { softwarePasskey } from './p256-fixtures.js';

interface Case { group: string; name: string; verdict: 'PASS' | 'FAIL'; layer?: string; detail?: string }
const cases: Case[] = [];
const ok = (group: string, name: string, cond: boolean, detail?: string, layer?: string) => {
  cases.push({ group, name, verdict: cond ? 'PASS' : 'FAIL', ...(layer ? { layer } : {}), ...(detail ? { detail } : {}) });
  if (!cond) console.log(`  ✗ ${group}: ${name}${detail ? ` — ${detail}` : ''}`);
};
const refused = async (group: string, name: string, layer: string, re: RegExp, fn: () => Promise<unknown> | unknown) => {
  try { await fn(); ok(group, name, false, 'accepted (expected a refusal)', layer); } catch (e: any) {
    const m = String(e?.message ?? e); ok(group, name, re.test(m), m.slice(0, 200), layer);
  }
};
const rnd = (n = 32) => new Uint8Array(randomBytes(n));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const eq = (a: Uint8Array, b: Uint8Array) => hex(a) === hex(b);
const SITE = 'Grants test';
const Z32 = new Uint8Array(32);

// ── a sol_ed25519-owned account in the simulator ─────────────────────────────
class Sim {
  contract = new (Contract as any)(makeWitnesses());
  addressHex = sampleContractAddress();
  bytes = new Uint8Array(Buffer.from(this.addressHex.replace(/^0x/, ''), 'hex'));
  coinPk = { bytes: rnd() };
  state: any; ps: any = emptyCoinStore(); now = 1_800_000_000;
  constructor(readonly owner: SolEd25519Device) {}
  static async create(owner: SolEd25519Device) {
    const s = new Sim(owner);
    const salt = rnd();
    const init = await s.contract.initialState(createConstructorContext(s.ps, s.coinPk), owner.bootCommitment(salt), rnd(), JubjubDevice.generate().pk, new Uint8Array(64), 259200n);
    s.state = init.currentContractState;
    await s.call('activate_initial_device_with_sol_ed25519', ...owner.activationArgs(salt));
    return s;
  }
  async call(circuit: string, ...args: unknown[]) { return this.callAs(undefined, circuit, ...args); }
  async callAs(caller: PublicAddress | undefined, circuit: string, ...args: unknown[]) {
    const ctx = createCircuitContext({ circuitId: circuit, contractAddress: this.addressHex, coinPublicKeyOrZswapState: this.coinPk, contractState: this.state, privateState: this.ps, time: this.now } as any);
    if (caller) {
      ctx.callContext = createCallContext(circuit, this.addressHex, this.coinPk, this.state, this.ps, this.now, undefined, caller) as any;
      (ctx as any).queryContexts[this.addressHex] = ctx.callContext.currentQueryContext;
    }
    const r = await this.contract.impureCircuits[circuit](ctx, ...args);
    this.state = r.context.callContext.currentQueryContext.state;
    if (r.context.callContext.currentPrivateState !== undefined) this.ps = r.context.callContext.currentPrivateState;
    return r.result;
  }
  L() { return ledger(this.state); }
  ctx() { return { contractAddress: this.bytes, authNonce: this.L().auth_nonce as bigint }; }
  counter(d = this.owner) { const l = this.L(); for (let k = 0n; k < 64n; k++) if (l.devices.member(d.entryAt(this.bytes, l.device_epoch, k))) return k; throw new Error('no entry'); }
  auth(o: any, d = this.owner) { return authoriseSolDevice(d, this.ctx(), SITE, o, this.counter(d)); }
  shown(o: any, d = this.owner) { return solDeviceMessageCircuit(d.key, this.ctx(), SITE, o).showArgs; }
  snapshot() { return { state: this.state, ps: this.ps, now: this.now }; }
  restore(s: any) { this.state = s.state; this.ps = s.ps; this.now = s.now; }
}
const newDevice = async () => { const s = solSoftwareSigner(rnd()); return { signer: s, dev: SolEd25519Device.fromSigner(s, await deriveSolBlind(s, { network: 'undeployed', accountIndex: 0 })) }; };
const caller = (bytes: Uint8Array): PublicAddress => ({ tag: 'contract', address: hex(bytes) } as PublicAddress);
/** A device approval of `o` whose message shows a FOREIGN account (its frame
 *  nibbles with it), signed by the device: only the seam's frame check can
 *  refuse it. */
const foreignAuth = (s: Sim, o: any, d = s.owner) => authoriseSolDevice(d, { ...s.ctx(), contractAddress: rnd() }, SITE, o, s.counter(d));
const leInt = (b: Uint8Array) => { let v = 0n; for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return v; };
/** A signature with R = O for which [s]B == R + [k]A holds (s = k a mod L, a
 *  the key's secret scalar from its seed): only the grant seam's R != O
 *  assert can refuse it. */
const rIdentityFor = (seed: Uint8Array, key: Uint8Array) => (message: Uint8Array) => {
  const h = sha512(seed).slice(0, 32); h[0] &= 248; h[31] &= 127; h[31] |= 64;
  const a = leInt(h) % ED25519_L;
  const encO = new Uint8Array(32); encO[0] = 1;
  const k = leInt(sha512(new Uint8Array([...encO, ...key, ...message]))) % ED25519_L;
  return { r: { x: 0n, y: 1n }, s: (k * a) % ED25519_L };
};

const issueArgs = (g: SolGranteeFields, sc: SolIssueScope, a: SolEd25519Authorisation, pk: unknown = solTargetPointArg(g), garg: unknown = solGranteeArg(g)) => [
  garg, pk, sc.opWithdrawUnshielded, sc.opWithdrawShielded, sc.opWithdrawShieldedToContract, sc.read, sc.color, sc.recipientKind, sc.recipient,
  sc.maxCoinValue, sc.perCallCap, sc.cap, sc.expiresAt, sc.rpIdHash, sc.readPk, sc.windowLen, sc.windowCap,
  { is_some: sc.caller !== null, value: { bytes: sc.caller ?? Z32 } }, ...authArgs(a)];
/** Issues the grant; returns the scope salt the circuit derives, as the
 *  issuing client computes it for the grantee. */
const issue = async (sim: Sim, g: SolGranteeFields, sc: SolIssueScope): Promise<Uint8Array> => {
  const salt = solGrantScopeSalt(sim.owner.blind, sim.bytes, sim.L().auth_nonce as bigint);
  await sim.call('issue_grant_with_sol_ed25519', ...issueArgs(g, sc, await sim.auth({ op: 'issue_grant', grantee: g, ...sc })));
  return salt;
};
const baseScope = (o: Partial<SolIssueScope> = {}): SolIssueScope => ({
  opWithdrawUnshielded: true, opWithdrawShielded: false, opWithdrawShieldedToContract: false, read: false, color: rnd(), recipientKind: 0n,
  recipient: Z32, maxCoinValue: 500n, perCallCap: 300n, cap: 500n, expiresAt: 0n, rpIdHash: Z32, readPk: Z32, windowLen: 0n, windowCap: 0n, caller: null, ...o,
});
// The plain scope upstream's helpers take (read_pk as its hash).
const plain = (sc: SolIssueScope) => ({ ...sc, readPkHash: sc.read ? sha256(sc.readPk) : Z32, caller: sc.caller ?? undefined });

const owner = await newDevice();
const sim = await Sim.create(owner.dev);
const gSeed = rnd();
const gSigner = solSoftwareSigner(gSeed);
const G = await SolEd25519Grantee.enrol(gSigner, { network: 'undeployed', issuingAccount: sim.bytes }, 'Example dApp');

// ── 1. issue to every grantee scheme ───────────────────────────────────────
const G1 = '1 issue';
const k1 = K256Grantee.generate(), jg = JubjubGrantee.generate(), pass = softwarePasskey();
const evmAddr = rnd(20), evmBlind = rnd();
const ohK = originHash('https://k.example'), ohJ = originHash('https://j.example');
const origin21 = pass.policy.origin;
const grantees: [string, SolGranteeFields, () => Uint8Array][] = [
  ['sol_ed25519', G.grantee(0n), () => G.grantId(sim.bytes, 0n)],
  ['evm_eip712', solGranteeOf({ scheme: 'evm_eip712', address: evmAddr, blind: evmBlind }, { label: 'Example dApp' }, 1n),
    () => sha256(new Uint8Array([...padTag(DESCRIPTOR_TAGS['grant-id'].evm_eip712), ...sim.bytes, ...evmAddr, ...evmBlind, ...grantOriginHash(labelBytes('Example dApp')), 1]))],
  ['k256', solGranteeOf({ scheme: 'k256', x: k1.pk.x, y: k1.pk.y, envelope: 0 }, { originHash: ohK }, 2n), () => k1.grantId(sim.bytes, ohK, 2n)],
  ['jubjub', solGranteeOf({ scheme: 'jubjub', x: jg.pk.x, y: jg.pk.y }, { originHash: ohJ }, 3n), () => jg.grantId(sim.bytes, ohJ, 3n)],
  ['p256', solGranteeOf({ scheme: 'p256', x: pass.pk.x, y: pass.pk.y }, { origin: origin21 }, 4n), () => pass.grantee.grantId(sim.bytes, grantOriginHash(origin21), 4n)],
];
for (const [scheme, g, idOf] of grantees) {
  const readPk = rnd();
  const sc = baseScope({ read: true, readPk, rpIdHash: scheme === 'p256' ? pass.policy.rp_id_hash : Z32 });
  const nonce = sim.L().auth_nonce;
  const a = await sim.auth({ op: 'issue_grant', grantee: g, ...sc });
  ok(G1, `${scheme}: the message (1690 bytes) shows the consequence and the grantee scheme`, a.message.length === 1690
    && a.text.includes('Consequence: lets the grantee key below spend from this account within these limits.\n') && a.text.includes(`Grantee scheme: ${DESCRIPTOR_TAGS['grant-id'][scheme as 'k256']}`));
  await sim.call('issue_grant_with_sol_ed25519', ...issueArgs(g, sc, a));
  const id = idOf();
  const l = sim.L();
  const rec = l.grants.member(id) ? l.grants.lookup(id) : null;
  ok(G1, `${scheme}: the grant id equals the ${scheme} grant-id recipe; issued_at = the auth_nonce after the issuing call, nonce 0, read_pk_hash = SHA-256(read key)`,
    !!rec && rec.issued_at === nonce + 1n && rec.nonce === 0n && rec.active && eq(rec.scope.read_pk_hash, sha256(readPk)),
    rec ? `issued_at ${rec.issued_at} (nonce before ${nonce}), nonce ${rec.nonce}, active ${rec.active}` : 'no record');
}

// ── 2. issue rules under a valid signature ─────────────────────────────────
const G2 = '2 rules';
{
  const g = G.grantee(5n);
  const bad = async (name: string, sc: SolIssueScope, re: RegExp, pk?: unknown, gg: SolGranteeFields = g) =>
    refused(G2, name, 'runtime', re, async () => sim.call('issue_grant_with_sol_ed25519', ...issueArgs(gg, sc, await sim.auth({ op: 'issue_grant', grantee: gg, ...sc }), pk)));
  /** issue_grant of `exec` with the key argument `key`, under the owner's
   *  signature over the message the circuit renders for these values: the
   *  block shows the key argument's bytes in base58 (`shown` is `exec` with
   *  those bytes as its key), every other display input is `exec`'s. */
  const issueSigned = async (exec: SolGranteeFields, shown: SolGranteeFields, sc: SolIssueScope, key: unknown) => {
    const m = solDeviceMessageCircuit(sim.owner.key, sim.ctx(), SITE, { op: 'issue_grant', grantee: shown, ...sc });
    const sh = m.showArgs as any[];
    const hexOf = sim.shown({ op: 'issue_grant', grantee: exec, ...sc }).at(-1);
    const a = await sim.auth({ op: 'issue_grant', grantee: exec, ...sc });
    return sim.call('issue_grant_with_sol_ed25519', ...issueArgs(exec, sc, { ...a, sig: (await sim.owner.signBytes(m.bytes)).sig, showArgs: [...sh.slice(0, -1), hexOf] }, key));
  };
  {
    const other = (await newDevice()).dev.key;
    await refused(G2, "a sol grantee whose descriptor key is not its key argument's (the message shows the key argument's)", 'runtime', /not the point's encoding/, () =>
      issueSigned(g, { ...g, a: other }, baseScope(), keyOf(solTargetPoint(other))));
    await bad("a sol grantee whose key argument shows another key than the descriptor (display inputs of the descriptor's key)", baseScope(),
      /base58 digits do not match|base58 carry hints|leading base58 ones/, keyOf(solTargetPoint(other)));
  }
  await bad('a k256 grantee with a non-identity point', baseScope(), /unused point must be the identity/, { ...solUnusedKey(), pk: solTargetPoint(G.key) }, { ...grantees[2][1], slot: 9n });
  await refused(G2, 'a k256 grantee with the identity point but non-zero key bytes (their base58 inputs supplied; a k256 block shows no Solana key)', 'runtime', /unused key bytes must be zero/, async () => {
    const gk = { ...grantees[2][1], slot: 9n };
    const kb = [...new Array<bigint>(31).fill(0n), 7n];
    const sc = baseScope();
    const a = await sim.auth({ op: 'issue_grant', grantee: gk, ...sc });
    const sh = a.showArgs as any[];
    const showArgs = [{ ...sh[0], key: solBase58(Uint8Array.from(kb, Number)) }, ...sh.slice(1)];
    return sim.call('issue_grant_with_sol_ed25519', ...issueArgs(gk, sc, { ...a, showArgs }, { ...solUnusedKey(), pk_bytes: kb }));
  });
  await bad('a k256 grantee with the identity point but non-zero x bytes', baseScope(), /unused key bytes must be zero/,
    { ...solUnusedKey(), pk_x: [3n, ...new Array<bigint>(31).fill(0n)] }, { ...grantees[2][1], slot: 9n });
  // fields a grantee class does not use, non-zero (not shown, so the wallet's
  // signature is over the same bytes as with them zero)
  await bad('an evm_eip712 grantee with a non-zero second field', baseScope(), /unused second field must be zero/, undefined, { ...grantees[1][1], b: rnd(), slot: 10n });
  await bad('a k256 grantee carrying a label', baseScope(), /unused label must be zero/, undefined, { ...grantees[2][1], label: 'Example dApp', slot: 11n });
  await bad('a jubjub grantee with a non-zero origin (its characters equal its bytes)', baseScope(), /unused origin must be zero/, undefined, { ...grantees[3][1], origin: rnd(21), slot: 12n });
  await bad("a sol_ed25519 grantee carrying an origin hash (a readable grantee's is derived from its label)", baseScope(), /a readable grantee's origin hash is derived/, undefined,
    { ...g, originHash: rnd(), slot: 13n });
  await bad("a passkey grantee carrying an origin hash (a passkey grantee's is derived from its origin)", baseScope({ read: true, readPk: rnd(), rpIdHash: pass.policy.rp_id_hash }),
    /a passkey grantee's origin hash is derived/, undefined, { ...grantees[4][1], originHash: rnd(), slot: 14n });
  {
    const k = solTargetPointArg(g) as any;
    const b = [...k.pk_bytes]; b[0] ^= 1n;
    const gF = { ...g, a: Uint8Array.from(b, Number) };
    await refused(G2, "a sol grantee's key bytes with one byte flipped (shown, signed and in the descriptor alike)", 'runtime', /the Ed25519 key bytes do not match the point's y/, () =>
      issueSigned(gF, gF, baseScope(), { ...k, pk_bytes: b }));
  }
  await bad('the shared chip through the arm: per-call cap above cap', baseScope({ perCallCap: 600n }), /per-call cap above cap/);
  await bad('the shared chip through the arm: spend without cap', baseScope({ cap: 0n, perCallCap: 0n, maxCoinValue: 0n }), /spend without cap/);
  await bad('the shared chip through the arm: shielded spend without read', baseScope({ opWithdrawShielded: true }), /shielded spend requires read/);
  await bad('the shared chip through the arm: an empty scope', baseScope({ opWithdrawUnshielded: false }), /empty scope/);
  // A zero RP hash on a spending passkey grant and a recipient on an
  // any-recipient grant: refused by the renderer (no message) and, past the
  // client, under a valid signature over the contract's own bytes
  const circuitAuth = async (o: any) => {
    const { bytes, showArgs } = solDeviceMessageCircuit(sim.owner.key, sim.ctx(), SITE, o);
    return { ...(await sim.auth({ op: 'revoke_all_grants' })), sig: (await sim.owner.signBytes(bytes)).sig, showArgs, message: bytes };
  };
  // The circuit's first two issue rules (the read key) are the
  // renderer's first too, with the circuit's messages; past the client, the
  // circuit refuses the same under a valid signature over its own bytes
  for (const [name, sc, re] of [['a read key without read', baseScope({ readPk: rnd() }), /a read key without read/],
    ['read without a read key', baseScope({ read: true }), /read without a read key/]] as [string, SolIssueScope, RegExp][]) {
    await refused(G2, `${name}: the renderer refuses the message (the circuit's first rules and messages)`, 'client', re, () => sim.auth({ op: 'issue_grant', grantee: g, ...sc }));
    await refused(G2, `${name}, under a valid signature over the contract's bytes`, 'runtime', re, async () =>
      sim.call('issue_grant_with_sol_ed25519', ...issueArgs(g, sc, await circuitAuth({ op: 'issue_grant', grantee: g, ...sc }))));
  }
  // both rules broken at once (a read key without read AND an RP hash on a
  // non-passkey grantee): the renderer and the circuit name the same first rule
  {
    const both = baseScope({ readPk: rnd(), rpIdHash: rnd() });
    await refused(G2, 'a read key without read and an RP hash on a non-passkey grantee: the renderer names the circuit\'s first rule', 'client', /a read key without read/, () => sim.auth({ op: 'issue_grant', grantee: g, ...both }));
    await refused(G2, 'a read key without read and an RP hash on a non-passkey grantee, under a valid signature over the contract\'s bytes: the circuit names the same rule', 'runtime', /a read key without read/, async () =>
      sim.call('issue_grant_with_sol_ed25519', ...issueArgs(g, both, await circuitAuth({ op: 'issue_grant', grantee: g, ...both }))));
  }
  // The circuit's first RP rule (an RP hash belongs to a
  // passkey grantee) is the renderer's first too, with the circuit's message,
  // for a spending and for a read-only grant; past the client, the circuit
  // refuses the same under a valid signature over its own bytes
  const rpOnSol = baseScope({ rpIdHash: rnd() });
  const roRpOnSol = baseScope({ opWithdrawUnshielded: false, read: true, readPk: rnd(), rpIdHash: rnd(), color: Z32, maxCoinValue: 0n, perCallCap: 0n, cap: 0n });
  for (const [kind, sc] of [['a spending grant', rpOnSol], ['a read-only grant', roRpOnSol]] as [string, SolIssueScope][]) {
    await refused(G2, `an RP hash on a non-passkey (sol) grantee, ${kind}: the renderer refuses the message (the circuit's first RP rule and message)`, 'client',
      /an RP hash belongs to a passkey grantee/, () => sim.auth({ op: 'issue_grant', grantee: g, ...sc }));
    await refused(G2, `an RP hash on a non-passkey (sol) grantee, ${kind}, under a valid signature over the contract's bytes`, 'runtime',
      /an RP hash belongs to a passkey grantee/, async () => sim.call('issue_grant_with_sol_ed25519', ...issueArgs(g, sc, await circuitAuth({ op: 'issue_grant', grantee: g, ...sc }))));
  }
  const gP = grantees[4][1];
  const zeroRp = baseScope({ read: true, readPk: rnd(), rpIdHash: Z32 });
  await refused(G2, "a spending grant to a passkey grantee with an all-zero RP hash: the renderer refuses the message", 'client', /a passkey grantee's RP hash is zero/, () =>
    sim.auth({ op: 'issue_grant', grantee: gP, ...zeroRp }));
  await refused(G2, "a spending grant to a passkey grantee with an all-zero RP hash under a valid signature over the contract's bytes", 'runtime', /a passkey grantee's RP hash is zero/, async () =>
    sim.call('issue_grant_with_sol_ed25519', ...issueArgs(gP, zeroRp, await circuitAuth({ op: 'issue_grant', grantee: gP, ...zeroRp }))));
  // A read-only grant carries no RP hash (a passkey's included: nothing would check it)
  const roRp = baseScope({ opWithdrawUnshielded: false, read: true, readPk: rnd(), rpIdHash: pass.policy.rp_id_hash, color: Z32, maxCoinValue: 0n, perCallCap: 0n, cap: 0n });
  await refused(G2, 'a read-only grant to a passkey grantee carrying its RP hash: the renderer refuses the message', 'client', /a read-only grant carries no RP hash/, () =>
    sim.auth({ op: 'issue_grant', grantee: gP, ...roRp }));
  await refused(G2, "a read-only grant to a passkey grantee carrying its RP hash under a valid signature over the contract's bytes", 'runtime', /a read-only grant carries no RP hash/, async () =>
    sim.call('issue_grant_with_sol_ed25519', ...issueArgs(gP, roRp, await circuitAuth({ op: 'issue_grant', grantee: gP, ...roRp }))));
  {
    const ro0 = { ...roRp, rpIdHash: Z32 };
    const gP6 = { ...gP, slot: 6n };
    const a = await sim.auth({ op: 'issue_grant', grantee: gP6, ...ro0 });
    await sim.call('issue_grant_with_sol_ed25519', ...issueArgs(gP6, ro0, a));
    ok(G2, 'a read-only grant to a passkey grantee with a zero RP hash lands and its message reads "Passkey RP (hash): not applicable"',
      sim.L().grants.member(pass.grantee.grantId(sim.bytes, grantOriginHash(origin21), 6n)) && a.text.includes('Passkey RP (hash): not applicable'));
  }
  const anyWithRecipient = baseScope({ recipientKind: 0n, recipient: rnd() });
  await refused(G2, 'an any-recipient grant (kind 0) carrying a recipient: the renderer refuses the message', 'client', /a recipient without a recipient kind/, () =>
    sim.auth({ op: 'issue_grant', grantee: g, ...anyWithRecipient }));
  await refused(G2, "an any-recipient grant (kind 0) carrying a recipient under a valid signature over the contract's bytes", 'runtime', /a recipient without a recipient kind/, async () =>
    sim.call('issue_grant_with_sol_ed25519', ...issueArgs(g, anyWithRecipient, await circuitAuth({ op: 'issue_grant', grantee: g, ...anyWithRecipient }))));
  ok(G2, 'nothing was issued at slot 5', !sim.L().grants.member(G.grantId(sim.bytes, 5n)));
}

// ── 3. binding: a shown field changed at execution ─────────────────────────
const G3 = '3 binding';
{
  const g = G.grantee(6n);
  const sc = baseScope({ read: true, readPk: rnd(), recipientKind: 1n, recipient: rnd(), expiresAt: 1_900_000_000n });
  const a = await sim.auth({ op: 'issue_grant', grantee: g, ...sc });
  const exec = (eg: SolGranteeFields, esc: SolIssueScope) => sim.call('issue_grant_with_sol_ed25519',
    ...issueArgs(eg, esc, { ...a, showArgs: sim.shown({ op: 'issue_grant', grantee: eg, ...esc }) }));
  const flip = (b: Uint8Array) => { const o = new Uint8Array(b); o[0] ^= 1; return o; };
  const fields: [string, Partial<SolIssueScope>][] = [
    ['withdraw unshielded flag', { opWithdrawUnshielded: false, opWithdrawShieldedToContract: true }], ['read flag (and key)', { read: false, readPk: Z32 }],
    ['token', { color: rnd() }], ['recipient kind', { recipientKind: 2n }], ['recipient', { recipient: rnd() }], ['max coin value', { maxCoinValue: 501n }],
    ['per-call cap', { perCallCap: 299n }], ['cap', { cap: 499n }], ['expiry', { expiresAt: 1_900_000_001n }], ['read key', { readPk: rnd() }],
    ['caller pin', { caller: rnd() }],
  ];
  for (const [name, d] of fields) await refused(G3, `issue_grant: the ${name} changed at execution`, 'runtime', /invalid signature/, () => exec(g, { ...sc, ...d }));
  await refused(G3, 'issue_grant: the grantee slot changed', 'runtime', /invalid signature/, () => exec({ ...g, slot: 7n }, sc));
  await refused(G3, 'issue_grant: the grantee label changed', 'runtime', /invalid signature/, () => exec({ ...g, label: 'Other dApp' }, sc));
  await refused(G3, 'issue_grant: the grantee key changed (another valid key)', 'runtime', /invalid signature/, async () => exec({ ...g, a: (await newDevice()).dev.key }, sc));
  await refused(G3, 'issue_grant: the grantee privacy salt changed', 'runtime', /invalid signature/, () => exec({ ...g, b: flip(g.b!) }, sc));
  const gk = grantees[2][1];
  const ak = await sim.auth({ op: 'issue_grant', grantee: gk, ...sc });
  await refused(G3, 'issue_grant: the labelled origin hash of a k256 grantee changed', 'runtime', /invalid signature/, () => sim.call('issue_grant_with_sol_ed25519',
    ...issueArgs({ ...gk, originHash: flip(gk.originHash!) }, sc, { ...ak, showArgs: sim.shown({ op: 'issue_grant', grantee: { ...gk, originHash: flip(gk.originHash!) }, ...sc }) })));
  await refused(G3, 'issue_grant: the k256 grantee envelope changed', 'runtime', /invalid signature/, () => sim.call('issue_grant_with_sol_ed25519',
    ...issueArgs({ ...gk, envelope: 1n }, sc, { ...ak, showArgs: sim.shown({ op: 'issue_grant', grantee: { ...gk, envelope: 1n }, ...sc }) })));
  // revoke_grant: another grantee executed under the signature for G's slot 0
  const ar = await sim.auth({ op: 'revoke_grant', grantee: G.grantee(0n) });
  await refused(G3, 'revoke_grant: another slot executed', 'runtime', /invalid signature/, () =>
    sim.call('revoke_grant_with_sol_ed25519', solGranteeArg(G.grantee(1n)), solTargetPointArg(G.grantee(1n)), ...authArgs({ ...ar, showArgs: sim.shown({ op: 'revoke_grant', grantee: G.grantee(1n) }) })));
  // The device seam on issue_grant and revoke_grant: the wallet
  // signed the message of exactly this call, but showing a foreign account
  // (its frame nibbles with it); then the honest call lands (positive control)
  await refused(G3, 'issue_grant: the wallet signed a message showing a foreign account (its frame nibbles with it): the seam\'s frame check', 'runtime', /hex digits do not match/, async () =>
    sim.call('issue_grant_with_sol_ed25519', ...issueArgs(g, sc, await foreignAuth(sim, { op: 'issue_grant', grantee: g, ...sc }))));
  await sim.call('issue_grant_with_sol_ed25519', ...issueArgs(g, sc, a));
  ok(G3, 'issue_grant: positive control, the honest approval of the same call lands after the refusals', sim.L().grants.member(G.grantId(sim.bytes, 6n)));
  const rvo = { op: 'revoke_grant', grantee: G.grantee(0n) };
  await refused(G3, 'revoke_grant: the wallet signed a message showing a foreign account (its frame nibbles with it): the seam\'s frame check', 'runtime', /hex digits do not match/, async () =>
    sim.call('revoke_grant_with_sol_ed25519', solGranteeArg(G.grantee(0n)), solTargetPointArg(G.grantee(0n)), ...authArgs(await foreignAuth(sim, rvo))));
  await sim.call('revoke_grant_with_sol_ed25519', solGranteeArg(G.grantee(0n)), solTargetPointArg(G.grantee(0n)), ...authArgs(await sim.auth(rvo)));
  ok(G3, 'revoke_grant: positive control, the honest approval lands (the record inactive)', sim.L().grants.lookup(G.grantId(sim.bytes, 0n)).active === false);
}

// ── 4. a sol grantee under its grant ───────────────────────────────────────
const G4 = '4 twins';
const twinSim = await Sim.create(owner.dev);
const T = await SolEd25519Grantee.enrol(gSigner, { network: 'undeployed', issuingAccount: twinSim.bytes }, 'Example dApp');
const U = rnd();
await twinSim.call('deposit_unshielded', U, 1000n);
const pin = rnd();
const scU = baseScope({ color: U, recipientKind: 1n, recipient: pin, perCallCap: 300n, cap: 500n, maxCoinValue: 500n, expiresAt: 1_900_000_000n });
const salt = await issue(twinSim, T.grantee(0n), scU);
const opening = (spentPrev: bigint, sc = scU, s = salt, slot = 0n): GrantOpening => ({ originHash: grantOriginHash(labelBytes(T.label)), slot, scopeSalt: s,
  recipientKind: sc.recipientKind, pinnedRecipient: sc.recipient, maxCoinValue: sc.maxCoinValue, spentPrev });
const rIdentity = rIdentityFor(gSeed, T.key);
const gctx = (s: Sim, g = T, slot = 0n) => { const id = g.grantId(s.bytes, slot); const r = s.L().grants.lookup(id); return { contractAddress: s.bytes, label: g.label, slot, issuedAt: r.issued_at, grantNonce: r.nonce }; };
const amt = (n: bigint, color = U): SolAmount => ({ color, amount: n, decimals: 0, symbol: 'tU' });
const unsh = async (s: Sim, n: bigint, to: Uint8Array, spent: bigint, a?: SolEd25519GrantAuthorisation, o = opening(spent)) => {
  const au = a ?? await authoriseSolGrantee(T.device, gctx(s), SITE, { op: 'withdraw_unshielded_with_grant', amount: amt(n), recipient: to });
  return s.call('withdraw_unshielded_with_grant_sol_ed25519', U, n, { bytes: to }, ...grantAuthArgs(o, au));
};
{
  const before = twinSim.L();
  const a1 = await authoriseSolGrantee(T.device, gctx(twinSim), SITE, { op: 'withdraw_unshielded_with_grant', amount: amt(200n), recipient: pin });
  ok(G4, 'the grantee message (726 bytes) shows the grant label, slot, issued-at nonce and use nonce', a1.message.length === 726
    && a1.text.includes('Role: grantee of a scoped grant\n') && a1.text.includes('Grant label: Example dApp') && a1.text.includes('Grant use nonce: 0'));
  await unsh(twinSim, 200n, pin, 0n, a1);
  const after = twinSim.L();
  const rec = after.grants.lookup(T.grantId(twinSim.bytes, 0n));
  ok(G4, 'in scope: lands; the record nonce +1; auth_nonce and the device entries untouched', rec.nonce === 1n && after.auth_nonce === before.auth_nonce
    && JSON.stringify([...after.devices]) === JSON.stringify([...before.devices]) && after.unshielded_balances.lookup(U) === 800n);
  await refused(G4, 'replay of the landed approval verbatim (the spent opening moved)', 'runtime', /spent opening mismatch/, () => unsh(twinSim, 200n, pin, 0n, a1));
  await refused(G4, 'replay of the landed approval with the current opening and display inputs for the current nonce (stale grant nonce)', 'runtime', /invalid grant signature/, () =>
    unsh(twinSim, 200n, pin, 200n, { ...a1, showArgs: solGranteeMessageCircuit(T.key, gctx(twinSim), SITE, { op: 'withdraw_unshielded_with_grant', amount: amt(200n), recipient: pin }).showArgs }));
  await refused(G4, 'replay of the landed approval with the current opening (its nonce digits no longer match)', 'runtime', /digits do not match/, () => unsh(twinSim, 200n, pin, 200n, a1));
  await refused(G4, 'above the per-call cap (301)', 'runtime', /per-call cap/, () => unsh(twinSim, 301n, pin, 200n));
  await refused(G4, 'above the cumulative cap (200 + 301 > 500)', 'runtime', /per-call cap|cumulative cap/, () => unsh(twinSim, 301n, pin, 200n));
  // The grant seam itself, refused before the honest call below
  // lands (its positive control): a message showing a foreign account (its
  // frame nibbles with it), and R = O with the verification equation holding
  {
    const o250 = { op: 'withdraw_unshielded_with_grant', amount: amt(250n), recipient: pin } as const;
    await refused(G4, 'unshielded twin: the grantee signed a message showing a foreign account (its frame nibbles with it): the grant seam\'s frame check', 'runtime', /hex digits do not match/, async () =>
      unsh(twinSim, 250n, pin, 200n, await authoriseSolGrantee(T.device, { ...gctx(twinSim), contractAddress: rnd() }, SITE, o250)));
    const h = await authoriseSolGrantee(T.device, gctx(twinSim), SITE, o250);
    await refused(G4, 'unshielded twin: R = O with the verification equation holding (s = k a): the grant seam\'s R != O', 'runtime', /R is the identity/, () =>
      unsh(twinSim, 250n, pin, 200n, { ...h, sig: rIdentity(h.message) }));
  }
  await unsh(twinSim, 250n, pin, 200n);
  ok(G4, 'positive control: the honest 250 lands after the refusals (the record nonce 2)', twinSim.L().grants.lookup(T.grantId(twinSim.bytes, 0n)).nonce === 2n);
  await refused(G4, 'the cumulative cap (450 + 100 > 500)', 'runtime', /cumulative cap exceeded/, () => unsh(twinSim, 100n, pin, 450n));
  await refused(G4, 'another recipient than the pin', 'runtime', /recipient not admitted by pin/, () => unsh(twinSim, 10n, rnd(), 450n));
  await refused(G4, 'a wrong opening (spent so far)', 'runtime', /spent opening mismatch/, () => unsh(twinSim, 10n, pin, 0n));
  await refused(G4, 'the grantee shows another label (another grant id)', 'runtime', /unknown grant/, async () => {
    const other = new SolEd25519Grantee(T.device, 'Other dApp');
    const au = await authoriseSolGrantee(other.device, { ...gctx(twinSim), label: 'Other dApp' }, SITE, { op: 'withdraw_unshielded_with_grant', amount: amt(10n), recipient: pin });
    return twinSim.call('withdraw_unshielded_with_grant_sol_ed25519', U, 10n, { bytes: pin }, ...grantAuthArgs(opening(450n), au));
  });
  await refused(G4, 'a device blind instead of the grantee blind', 'runtime', /unknown grant/, async () => {
    const asDevice = SolEd25519Device.fromSigner(gSigner, await deriveSolBlind(gSigner, { network: 'undeployed', accountIndex: 0 }));
    const au = await authoriseSolGrantee(asDevice, gctx(twinSim), SITE, { op: 'withdraw_unshielded_with_grant', amount: amt(10n), recipient: pin });
    return twinSim.call('withdraw_unshielded_with_grant_sol_ed25519', U, 10n, { bytes: pin }, ...grantAuthArgs(opening(450n), au));
  });
  const snap = twinSim.snapshot();
  twinSim.now = 1_900_000_001;
  await refused(G4, 'after its expiry', 'runtime', /grant expired/, () => unsh(twinSim, 10n, pin, 450n));
  twinSim.restore(snap);
  // shielded: a grant scoped to colour A with a read key
  const A = rnd(), B = rnd(), nonceH = rnd();
  const scS = baseScope({ opWithdrawUnshielded: false, opWithdrawShielded: true, read: true, readPk: rnd(), color: A, perCallCap: 400n, cap: 400n, maxCoinValue: 1000n });
  const saltS = await issue(twinSim, T.grantee(1n), scS);
  const coin = { nonce: nonceH, color: A, value: 1000n, mtIndex: 3n };
  twinSim.ps = withCoin(emptyCoinStore(), coin);
  const encPk = twinSim.L().enc_key;
  const to = rnd();
  const sOpen = (spent: bigint, sc = scS): GrantOpening => ({ ...opening(spent, sc, saltS, 1n) });
  const shArgs = async (n: bigint, change: Uint8Array, enc = encPk, c = coin) => {
    const au = await authoriseSolGrantee(T.device, gctx(twinSim, T, 1n), SITE, { op: 'withdraw_shielded_with_grant', amount: amt(n, A), recipient: to, changeEntry: change, encPk: enc,
      coin: { nonce: c.nonce, color: c.color, value: c.value, mt_index: c.mtIndex } });
    return [{ bytes: to }, A, n, change, enc, ...grantAuthArgs(sOpen(0n), au)];
  };
  const change = rnd(192);
  const snapS = twinSim.snapshot();
  // witness substitution first, from the state before any shielded spend
  {
    const args = await shArgs(300n, change);
    twinSim.ps = { ...emptyCoinStore(), coins: { [hex(A)]: { nonceHex: hex(nonceH), colorHex: hex(B), value: '1000', mtIndex: '3' } } };
    await refused(G4, 'witness substitution: colour B for an approval of colour A', 'runtime', /held coin colour does not match/, () =>
      twinSim.call('withdraw_shielded_with_grant_sol_ed25519', ...args));
    twinSim.restore(snapS);
    twinSim.ps = withCoin(emptyCoinStore(), coin);
  }
  // The grant seam on the shielded twin (refused before the
  // honest call below lands)
  {
    const o300 = { op: 'withdraw_shielded_with_grant', amount: amt(300n, A), recipient: to, changeEntry: change, encPk,
      coin: { nonce: coin.nonce, color: coin.color, value: coin.value, mt_index: coin.mtIndex } } as const;
    const sCall = (au: SolEd25519GrantAuthorisation) => twinSim.call('withdraw_shielded_with_grant_sol_ed25519', { bytes: to }, A, 300n, change, encPk, ...grantAuthArgs(sOpen(0n), au));
    await refused(G4, 'shielded twin: the grantee signed a message showing a foreign account (its frame nibbles with it): the grant seam\'s frame check', 'runtime', /hex digits do not match/, async () =>
      sCall(await authoriseSolGrantee(T.device, { ...gctx(twinSim, T, 1n), contractAddress: rnd() }, SITE, o300)));
    const h = await authoriseSolGrantee(T.device, gctx(twinSim, T, 1n), SITE, o300);
    await refused(G4, 'shielded twin: R = O with the verification equation holding (s = k a): the grant seam\'s R != O', 'runtime', /R is the identity/, () =>
      sCall({ ...h, sig: rIdentity(h.message) }));
  }
  const inboxBefore = twinSim.L().inbox_count;
  const sAuthBefore = twinSim.L().auth_nonce;
  const r: any = await twinSim.call('withdraw_shielded_with_grant_sol_ed25519', ...(await shArgs(300n, change)));
  ok(G4, 'shielded twin in scope: 300 of the 1000 coin, the change entry appended, auth_nonce untouched', r?.is_some === true && r.value.value === 700n
    && twinSim.L().inbox_count === inboxBefore + 1n && eq(twinSim.L().inbox.lookup(inboxBefore), change) && twinSim.L().auth_nonce === sAuthBefore);
  twinSim.ps = withCoin(emptyCoinStore(), { ...coin, value: 2000n });
  await refused(G4, 'a coin above the max coin value (2000 > 1000)', 'runtime', /coin above max_coin_value/, async () => {
    const au = await authoriseSolGrantee(T.device, gctx(twinSim, T, 1n), SITE, { op: 'withdraw_shielded_with_grant', amount: amt(10n, A), recipient: to, changeEntry: change, encPk,
      coin: { nonce: nonceH, color: A, value: 2000n, mt_index: 3n } });
    return twinSim.call('withdraw_shielded_with_grant_sol_ed25519', { bytes: to }, A, 10n, change, encPk, ...grantAuthArgs(sOpen(300n), au));
  });
  twinSim.ps = withCoin(emptyCoinStore(), coin);
  await refused(G4, 'a stale encryption key', 'runtime', /stale encryption key/, async () => twinSim.call('withdraw_shielded_with_grant_sol_ed25519', ...(await shArgs(10n, change, rnd()))));
  // the to-contract twin: a grant for direct transfers (slot 2)
  {
    const scC = baseScope({ opWithdrawUnshielded: false, opWithdrawShieldedToContract: true, read: true, readPk: rnd(), color: A, perCallCap: 400n, cap: 400n, maxCoinValue: 1000n });
    const saltC = await issue(twinSim, T.grantee(2n), scC);
    const coinC = { nonce: rnd(), color: A, value: 1000n, mtIndex: 4n };
    const toC = rnd();
    const cArgs = async (slot: bigint, sc: SolIssueScope, s: typeof salt, spent: bigint, n: bigint) => {
      const au = await authoriseSolGrantee(T.device, gctx(twinSim, T, slot), SITE, { op: 'withdraw_shielded_to_contract_with_grant', amount: amt(n, A), recipient: toC, changeEntry: change, encPk,
        coin: { nonce: coinC.nonce, color: A, value: coinC.value, mt_index: coinC.mtIndex } });
      return [{ bytes: toC }, A, n, change, encPk, ...grantAuthArgs(opening(spent, sc, s, slot), au)];
    };
    // Before the honest call below lands: witness substitution
    // (the to-contract twin's own colour assert), and the grant seam itself
    {
      const args = await cArgs(2n, scC, saltC, 0n, 300n);
      twinSim.ps = { ...emptyCoinStore(), coins: { [hex(A)]: { nonceHex: hex(coinC.nonce), colorHex: hex(B), value: '1000', mtIndex: '4' } } };
      await refused(G4, 'to-contract twin: witness substitution, colour B for an approval of colour A (the export\'s own colour assert)', 'runtime', /held coin colour does not match/, () =>
        twinSim.call('withdraw_shielded_to_contract_with_grant_sol_ed25519', ...args));
      twinSim.ps = withCoin(emptyCoinStore(), coinC);
      const oC = { op: 'withdraw_shielded_to_contract_with_grant', amount: amt(300n, A), recipient: toC, changeEntry: change, encPk,
        coin: { nonce: coinC.nonce, color: A, value: coinC.value, mt_index: coinC.mtIndex } } as const;
      const cCall = (au: SolEd25519GrantAuthorisation) => twinSim.call('withdraw_shielded_to_contract_with_grant_sol_ed25519', { bytes: toC }, A, 300n, change, encPk,
        ...grantAuthArgs(opening(0n, scC, saltC, 2n), au));
      await refused(G4, 'to-contract twin: the grantee signed a message showing a foreign account (its frame nibbles with it): the grant seam\'s frame check', 'runtime', /hex digits do not match/, async () =>
        cCall(await authoriseSolGrantee(T.device, { ...gctx(twinSim, T, 2n), contractAddress: rnd() }, SITE, oC)));
      const h = await authoriseSolGrantee(T.device, gctx(twinSim, T, 2n), SITE, oC);
      await refused(G4, 'to-contract twin: R = O with the verification equation holding (s = k a): the grant seam\'s R != O', 'runtime', /R is the identity/, () =>
        cCall({ ...h, sig: rIdentity(h.message) }));
    }
    twinSim.ps = withCoin(emptyCoinStore(), coinC);
    const inbox0 = twinSim.L().inbox_count, nonce0 = twinSim.L().auth_nonce;
    const rc: any = await twinSim.call('withdraw_shielded_to_contract_with_grant_sol_ed25519', ...(await cArgs(2n, scC, saltC, 0n, 300n)));
    ok(G4, 'the to-contract twin in scope: 300 of the 1000 coin to a contract, the change (700) entry appended, the record nonce +1, auth_nonce untouched',
      rc?.[1]?.is_some === true && rc[1].value.value === 700n && rc[0]?.value === 300n && twinSim.L().inbox_count === inbox0 + 1n
      && twinSim.L().grants.lookup(T.grantId(twinSim.bytes, 2n)).nonce === 1n && twinSim.L().auth_nonce === nonce0);
    // the operation not in the grant's scope, both ways
    twinSim.ps = withCoin(emptyCoinStore(), coinC);
    await refused(G4, 'the operation not in scope: the shielded-only grant (slot 1) through the to-contract twin', 'runtime', /operation not in scope/, async () =>
      twinSim.call('withdraw_shielded_to_contract_with_grant_sol_ed25519', ...(await cArgs(1n, scS, saltS, 300n, 10n))));
    await refused(G4, 'the operation not in scope: the to-contract grant (slot 2) through the shielded twin', 'runtime', /operation not in scope/, async () => {
      const au = await authoriseSolGrantee(T.device, gctx(twinSim, T, 2n), SITE, { op: 'withdraw_shielded_with_grant', amount: amt(10n, A), recipient: to, changeEntry: change, encPk,
        coin: { nonce: coinC.nonce, color: A, value: coinC.value, mt_index: coinC.mtIndex } });
      return twinSim.call('withdraw_shielded_with_grant_sol_ed25519', { bytes: to }, A, 10n, change, encPk, ...grantAuthArgs(opening(300n, scC, saltC, 2n), au));
    });
    await refused(G4, 'the operation not in scope: the shielded-only grant (slot 1) through the unshielded twin', 'runtime', /operation not in scope/, async () => {
      const au = await authoriseSolGrantee(T.device, gctx(twinSim, T, 1n), SITE, { op: 'withdraw_unshielded_with_grant', amount: amt(10n, A), recipient: pin });
      return twinSim.call('withdraw_unshielded_with_grant_sol_ed25519', A, 10n, { bytes: pin }, ...grantAuthArgs(sOpen(300n), au));
    });
    twinSim.ps = withCoin(emptyCoinStore(), coin);
  }
  // A recipient pin on both shielded twins (kind 2: a shielded
  // key, kind 3: a contract; upstream's check_spend_scope compares the pin
  // with the recipient the twin executes): another recipient, honestly
  // signed, is refused; the pinned one lands (positive control)
  {
    const pinS = rnd(), pinC = rnd();
    const scP = (o: Partial<SolIssueScope>) => baseScope({ opWithdrawUnshielded: false, read: true, readPk: rnd(), color: A, perCallCap: 400n, cap: 400n, maxCoinValue: 1000n, ...o });
    const scS3 = scP({ opWithdrawShielded: true, recipientKind: 2n, recipient: pinS });
    const scC4 = scP({ opWithdrawShieldedToContract: true, recipientKind: 3n, recipient: pinC });
    const saltS3 = await issue(twinSim, T.grantee(3n), scS3);
    const saltC4 = await issue(twinSim, T.grantee(4n), scC4);
    const pc = { nonce: rnd(), color: A, value: 1000n, mtIndex: 5n };
    const pinned = async (op: 'withdraw_shielded_with_grant' | 'withdraw_shielded_to_contract_with_grant', slot: bigint, sc: SolIssueScope, sl: typeof salt, r: Uint8Array) => {
      twinSim.ps = withCoin(emptyCoinStore(), pc);
      const au = await authoriseSolGrantee(T.device, gctx(twinSim, T, slot), SITE, { op, amount: amt(100n, A), recipient: r, changeEntry: change, encPk,
        coin: { nonce: pc.nonce, color: A, value: pc.value, mt_index: pc.mtIndex } });
      return twinSim.call(`${op}_sol_ed25519`, { bytes: r }, A, 100n, change, encPk, ...grantAuthArgs(opening(0n, sc, sl, slot), au));
    };
    await refused(G4, 'shielded twin under a grant pinned to a shielded key: another recipient, honestly signed', 'runtime', /recipient not admitted by pin/, () =>
      pinned('withdraw_shielded_with_grant', 3n, scS3, saltS3, rnd()));
    const rs: any = await pinned('withdraw_shielded_with_grant', 3n, scS3, saltS3, pinS);
    ok(G4, 'shielded twin under the pin: the pinned recipient lands (positive control; change 900)', rs?.is_some === true && rs.value.value === 900n);
    await refused(G4, 'to-contract twin under a grant pinned to a contract: another recipient, honestly signed', 'runtime', /recipient not admitted by pin/, () =>
      pinned('withdraw_shielded_to_contract_with_grant', 4n, scC4, saltC4, rnd()));
    const rcp: any = await pinned('withdraw_shielded_to_contract_with_grant', 4n, scC4, saltC4, pinC);
    ok(G4, 'to-contract twin under the pin: the pinned contract lands (positive control; 100 sent, change 900)', rcp?.[0]?.value === 100n && rcp?.[1]?.value?.value === 900n);
    twinSim.ps = withCoin(emptyCoinStore(), coin);
  }
  // an approval built now (opening at 300), executed after revoke_all_grants
  const late = await (async () => {
    const au = await authoriseSolGrantee(T.device, gctx(twinSim, T, 1n), SITE, { op: 'withdraw_shielded_with_grant', amount: amt(10n, A), recipient: to, changeEntry: change, encPk,
      coin: { nonce: coin.nonce, color: A, value: coin.value, mt_index: coin.mtIndex } });
    return [{ bytes: to }, A, 10n, change, encPk, ...grantAuthArgs(sOpen(300n), au)];
  })();
  // revoke by descriptor, then revoke-all
  const rv = await twinSim.auth({ op: 'revoke_grant', grantee: T.grantee(0n) });
  await twinSim.call('revoke_grant_with_sol_ed25519', solGranteeArg(T.grantee(0n)), solTargetPointArg(T.grantee(0n)), ...authArgs(rv));
  ok(G4, 'revoke_grant by descriptor: the record is inactive', twinSim.L().grants.lookup(T.grantId(twinSim.bytes, 0n)).active === false);
  await refused(G4, 'after revoke_grant', 'runtime', /grant revoked/, () => unsh(twinSim, 10n, pin, 450n));
  const gen = twinSim.L().grant_generation;
  // revoke_all_grants has no operand, so only its seam can
  // refuse a bad approval: one over a foreign account, one by a key that is
  // no device of this account; the honest call then lands (below)
  await refused(G4, 'revoke_all_grants: the wallet signed a message showing a foreign account (its frame nibbles with it): the seam\'s frame check', 'runtime', /hex digits do not match/, async () =>
    twinSim.call('revoke_all_grants_with_sol_ed25519', ...authArgs(await foreignAuth(twinSim, { op: 'revoke_all_grants' }))));
  await refused(G4, 'revoke_all_grants: a key that is no device of this account (its own approval of this call)', 'runtime', /unknown device entry/, async () => {
    const stranger = (await newDevice()).dev;
    return twinSim.call('revoke_all_grants_with_sol_ed25519', ...authArgs(await authoriseSolDevice(stranger, twinSim.ctx(), SITE, { op: 'revoke_all_grants' }, 0n)));
  });
  ok(G4, 'the refused revoke_all_grants calls changed nothing (generation unchanged)', twinSim.L().grant_generation === gen);
  await twinSim.call('revoke_all_grants_with_sol_ed25519', ...authArgs(await twinSim.auth({ op: 'revoke_all_grants' })));
  ok(G4, 'revoke_all_grants: generation +1', twinSim.L().grant_generation === gen + 1n);
  await refused(G4, 'the shielded grant after revoke_all_grants (an approval made before it)', 'runtime', /unknown grant|grant generation stale/, () => twinSim.call('withdraw_shielded_with_grant_sol_ed25519', ...late));
}

// ── 5. cross-role replay ───────────────────────────────────────────────────
const G5 = '5 roles';
{
  // One wallet as a device of account R and as a grantee of R (another blind).
  const w = await newDevice();
  const R = await Sim.create(w.dev);
  const Ug = await SolEd25519Grantee.enrol(w.signer, { network: 'undeployed', issuingAccount: R.bytes }, 'Example dApp');
  const U2 = rnd();
  await R.call('deposit_unshielded', U2, 1000n);
  const sc = baseScope({ color: U2 });
  const s2 = await issue(R, Ug.grantee(0n), sc);
  const to = rnd();
  const op = (n: bigint): GrantOpening => ({ originHash: grantOriginHash(labelBytes(Ug.label)), slot: 0n, scopeSalt: s2, recipientKind: 0n, pinnedRecipient: Z32, maxCoinValue: 500n, spentPrev: 0n });
  const grCtx = { contractAddress: R.bytes, label: Ug.label, slot: 0n, issuedAt: R.L().grants.lookup(Ug.grantId(R.bytes, 0n)).issued_at, grantNonce: 0n };
  const gAuth = await authoriseSolGrantee(Ug.device, grCtx, SITE, { op: 'withdraw_unshielded_with_grant', amount: { color: U2, amount: 100n, decimals: 0, symbol: 'tU' }, recipient: to });
  // the device-role approval of the same withdrawal by the same key
  const dAuth = await R.auth({ op: 'withdraw_unshielded', amount: { color: U2, amount: 100n, decimals: 0, symbol: 'tU' }, recipient: to }, w.dev);
  await refused(G5, 'the device-role approval (same key, same withdrawal) presented to the grant seam', 'runtime', /invalid grant signature/, () =>
    R.call('withdraw_unshielded_with_grant_sol_ed25519', U2, 100n, { bytes: to }, ...grantAuthArgs(op(0n), { ...gAuth, sig: dAuth.sig })));
  await refused(G5, 'the grantee-role approval (same key, same withdrawal) presented to the device seam', 'runtime', /invalid signature/, () =>
    R.call('withdraw_unshielded_with_sol_ed25519', U2, 100n, { bytes: to }, ...authArgs({ ...dAuth, sig: gAuth.sig })));
  ok(G5, 'the two roles render different messages (the Role line and the tail differ)', !eq(gAuth.message, dAuth.message)
    && gAuth.text.includes('Role: grantee of a scoped grant') && dAuth.text.includes('Role: device of this account'));
  await R.call('withdraw_unshielded_with_grant_sol_ed25519', U2, 100n, { bytes: to }, ...grantAuthArgs(op(0n), gAuth));
  ok(G5, 'positive control: the grantee approval lands under the grant', R.L().unshielded_balances.lookup(U2) === 900n);
}

// ── 6. upstream owners issue to a sol_ed25519 grantee ──────────────────────
const G6 = '6 upstream owners';
{
  const { AccountSim } = await import('./sim.js');
  const js = await AccountSim.create({ initialRecoveryPk: JubjubDevice.generate().pk, initialWrap: rnd(64), vetoWindowSeconds: 60n });
  const Ux = await SolEd25519Grantee.enrol(gSigner, { network: 'undeployed', issuingAccount: js.address }, 'Example dApp');
  const oh = grantOriginHash(labelBytes(Ux.label));
  const id = Ux.grantId(js.address, 0n);
  ok(G6, 'the sol grant id: derive_grant_id_with_sol_ed25519 == SHA-256 of the spec preimage',
    eq(id, sha256(new Uint8Array([...padTag(DESCRIPTOR_TAGS['grant-id'].sol_ed25519), ...js.address, ...Ux.key, ...Ux.blind, ...oh, 0]))));
  const U3 = rnd();
  await js.call('deposit_unshielded', U3, 1000n);
  const scope = spendScope({ withdrawUnshielded: true, color: U3, cap: 300n });
  const s3 = rnd();
  await js.authorised('issue_grant', (c, d) => jubjubChallenges.issueGrant(c, d.pk, id, scopeDigest(s3, scope)), [id, ...scopeArgs(scope), s3]);
  const rec = js.ledger().grants.lookup(id);
  const to = rnd();
  const au = await authoriseSolGrantee(Ux.device, { contractAddress: js.address, label: Ux.label, slot: 0n, issuedAt: rec.issued_at, grantNonce: 0n }, SITE,
    { op: 'withdraw_unshielded_with_grant', amount: { color: U3, amount: 120n, decimals: 0, symbol: 'tU' }, recipient: to });
  await js.call('withdraw_unshielded_with_grant_sol_ed25519', U3, 120n, { bytes: to },
    ...grantAuthArgs({ originHash: oh, slot: 0n, scopeSalt: s3, recipientKind: 0n, pinnedRecipient: Z32, maxCoinValue: 300n, spentPrev: 0n }, au));
  ok(G6, 'a jubjub owner issues to a sol grantee; it spends 120 under the grant', js.ledger().unshielded_balances.lookup(U3) === 880n && js.ledger().grants.lookup(id).nonce === 1n);
  // the reverse: a sol owner's grant to a jubjub grantee spent through upstream's jubjub twin
  const owner2 = await newDevice();
  const so = await Sim.create(owner2.dev);
  const U4 = rnd();
  await so.call('deposit_unshielded', U4, 1000n);
  const jgr = JubjubGrantee.generate();
  const ohj = originHash('https://j.example');
  const gj = solGranteeOf({ scheme: 'jubjub', x: jgr.pk.x, y: jgr.pk.y }, { originHash: ohj }, 0n);
  const sc4 = baseScope({ color: U4, cap: 300n, perCallCap: 300n, maxCoinValue: 300n });
  const s4 = await issue(so, gj, sc4);
  const jid = jgr.grantId(so.bytes, ohj, 0n);
  const jr = so.L().grants.lookup(jid);
  const ja = jgr.sign(jubjubGrantChallenges.withdrawUnshielded({ contractAddress: so.bytes, grantId: jid, issuedAt: jr.issued_at, grantNonce: 0n }, jgr.pk, U4, 50n, to));
  await so.call('withdraw_unshielded_with_grant_jubjub', U4, 50n, { bytes: to }, ...grantAuthArgs({ originHash: ohj, slot: 0n, scopeSalt: s4, recipientKind: 0n, pinnedRecipient: Z32, maxCoinValue: 300n, spentPrev: 0n }, ja));
  ok(G6, 'a sol owner issues to a jubjub grantee (a labelled origin hash); it spends through upstream\'s jubjub twin', so.L().unshielded_balances.lookup(U4) === 950n);
  void k256GrantChallenges;
}

// ── 7. the caller pin (#176) ───────────────────────────────────────────────
const G7 = '7 caller pin';
{
  const owner3 = await newDevice();
  const cs = await Sim.create(owner3.dev);
  const Uc = await SolEd25519Grantee.enrol(gSigner, { network: 'undeployed', issuingAccount: cs.bytes }, 'Example dApp');
  const U5 = rnd();
  await cs.call('deposit_unshielded', U5, 1000n);
  const pinned = rnd();
  const sc = baseScope({ color: U5, caller: pinned });
  const s5 = solGrantScopeSalt(owner3.dev.blind, cs.bytes, cs.L().auth_nonce as bigint);
  const ia = await cs.auth({ op: 'issue_grant', grantee: Uc.grantee(0n), ...sc });
  ok(G7, 'the issue message shows the caller pin', ia.text.includes('Caller restricted to a contract: yes\nCaller: ' + hex(pinned)));
  await cs.call('issue_grant_with_sol_ed25519', ...issueArgs(Uc.grantee(0n), sc, ia));
  const to = rnd();
  const callUnder = async (who: PublicAddress | undefined) => {
    const rec = cs.L().grants.lookup(Uc.grantId(cs.bytes, 0n));
    const au = await authoriseSolGrantee(Uc.device, { contractAddress: cs.bytes, label: Uc.label, slot: 0n, issuedAt: rec.issued_at, grantNonce: rec.nonce }, SITE,
      { op: 'withdraw_unshielded_with_grant', amount: { color: U5, amount: 10n, decimals: 0, symbol: 'tU' }, recipient: to });
    return cs.callAs(who, 'withdraw_unshielded_with_grant_sol_ed25519', U5, 10n, { bytes: to },
      ...grantAuthArgs({ originHash: grantOriginHash(labelBytes(Uc.label)), slot: 0n, scopeSalt: s5, recipientKind: 0n, pinnedRecipient: Z32, maxCoinValue: 500n, spentPrev: 0n }, au));
  };
  await refused(G7, 'no contract caller', 'runtime', /grant requires a contract caller/, () => callUnder(undefined));
  await refused(G7, 'a user caller', 'runtime', /grant requires a contract caller/, () => callUnder({ tag: 'user', address: hex(pinned) } as PublicAddress));
  await refused(G7, 'another contract', 'runtime', /grant caller mismatch/, () => callUnder(caller(rnd())));
  await callUnder(caller(pinned));
  ok(G7, 'the pinned contract caller: lands', cs.L().unshielded_balances.lookup(U5) === 990n);
}

// ── 8. the grantee blind ───────────────────────────────────────────────────
const G8 = '8 grantee blind';
{
  const w = solSoftwareSigner(rnd());
  const devBlinds = await Promise.all([0, 1, 2].map(async (i) => hex((await deriveSolBlind(w, { network: 'undeployed', accountIndex: i })).blind)));
  const accounts = [rnd(), rnd(), rnd()];
  const gBlinds = await Promise.all(accounts.map(async (acc) => hex(await deriveSolGranteeBlind(w, { network: 'undeployed', issuingAccount: acc }))));
  ok(G8, 'no grantee blind equals a device blind of the same wallet (3 issuing accounts × 3 account indexes)', gBlinds.every((g) => !devBlinds.includes(g)));
  ok(G8, 'grantee blinds differ per issuing account', new Set(gBlinds).size === 3);
  const again = hex(await deriveSolGranteeBlind(w, { network: 'undeployed', issuingAccount: accounts[0] }));
  ok(G8, 'and are re-derivable (deterministic)', again === gBlinds[0]);
  ok(G8, 'another network gives another grantee blind', hex(await deriveSolGranteeBlind(w, { network: 'preview', issuingAccount: accounts[0] })) !== gBlinds[0]);
}
// the client: an unregistered grantee scheme is refused before any message
await refused(G1, 'an unregistered grantee scheme: the facade refuses the descriptor (no message, no call)', 'client', /not a registered descriptor scheme \(zz\)/,
  () => solGranteeOf({ scheme: 'zz' } as any, { label: 'Example dApp' }, 0n));
// A passkey grantee's site origin passes the base's passkey-origin
// rule (21 bytes, visible ASCII without quotes or backslashes); a P-256 key
// with no policy (the grantee's RP hash is a scope field)
{
  const p = softwarePasskey();
  const o21 = (t: string) => new TextEncoder().encode(t);
  const policyless = { scheme: 'p256', x: p.pk.x, y: p.pk.y } as any;
  ok(G1, 'a 21-byte visible origin is accepted (positive control)', (() => { try { solGranteeOf(policyless, { origin: o21('https://a.example.com') }, 0n); return true; } catch { return false; } })());
  await refused(G1, 'a passkey grantee origin with a double quote is refused by the facade', 'client', /^descriptor: passkey origin is not visible ASCII/, () => solGranteeOf(policyless, { origin: o21('https://a.exam"le.com') }, 0n));
  await refused(G1, 'a passkey grantee origin with a backslash is refused by the facade', 'client', /^descriptor: passkey origin is not visible ASCII/, () => solGranteeOf(policyless, { origin: o21('https://a.exam\\le.com') }, 0n));
  await refused(G1, 'a passkey grantee origin with a space is refused by the facade', 'client', /^descriptor: passkey origin is not visible ASCII/, () => solGranteeOf(policyless, { origin: o21('https://a example.com') }, 0n));
  await refused(G1, 'a passkey grantee origin of 20 bytes is refused by the facade', 'client', /^descriptor: a passkey origin is 21 bytes/, () => solGranteeOf(policyless, { origin: o21('https://a.example.co') }, 0n));
}
// The grant facade runs the strict descriptor parsers, as the device facade does
await refused(G1, 'a k256 grantee whose point is not on secp256k1: the facade refuses the descriptor (checkDescriptor)', 'client', /^descriptor: /,
  () => solGranteeOf({ scheme: 'k256', x: 1n, y: 1n, envelope: 0 } as any, { originHash: originHash('https://k.example') }, 0n));
await refused(G1, 'a sol_ed25519 grantee whose key is not an Ed25519 point: the facade refuses the descriptor (checkDescriptor)', 'client', /^descriptor: /,
  () => solGranteeOf({ scheme: 'sol_ed25519', key: (() => { for (let i = 2; ; i++) { const k = new Uint8Array(32); k[0] = i; try { solTargetPoint(k); } catch { return k; } } })(), blind: rnd() } as any, { label: 'Example dApp' }, 0n));

// ── 9. the base modules' asserts through this arm's exports ───────────────
const G9 = '9 module asserts';
{
  const signedOver = async (bytes: Uint8Array, showArgs: unknown[]) =>
    ({ ...(await sim.auth({ op: 'revoke_all_grants' })), sig: (await sim.owner.signBytes(bytes)).sig, showArgs, message: bytes });
  const msgOf = (o: any) => solDeviceMessageCircuit(sim.owner.key, sim.ctx(), SITE, o);
  const before = sim.snapshot();
  const sc = baseScope();
  // the identity as a grantee: its encoding (0100..00) shown and signed;
  // the Ed25519 class's A != O in the grant-id derivation refuses it
  const idKey = new Uint8Array(32); idKey[0] = 1;
  const gO = { ...G.grantee(9n), a: idKey };
  const mO = msgOf({ op: 'issue_grant', grantee: gO, ...sc });
  await refused(G9, "the identity as a sol_ed25519 grantee under a valid signature: the Ed25519 class's A != O in the grant-id derivation", 'runtime', /the Ed25519 key is the identity/,
    async () => sim.call('issue_grant_with_sol_ed25519', ...issueArgs(gO, sc, await signedOver(mO.bytes, mO.showArgs), keyOf({ x: 0n, y: 1n }))));
  // an unregistered grant-id tag: the arm's class check refuses it before
  // the module's width-64 recipe is reached (the prover suite's module
  // section refuses it past that check)
  const gP = grantees[4][1];
  const scRO = baseScope({ opWithdrawUnshielded: false, read: true, readPk: rnd(), maxCoinValue: 0n, perCallCap: 0n, cap: 0n });
  const aP = await sim.auth({ op: 'issue_grant', grantee: gP, ...scRO });
  await refused(G9, "an unregistered grant-id tag over the passkey grantee's message: the arm's class check", 'runtime', /not a registered grant-id tag/,
    async () => sim.call('issue_grant_with_sol_ed25519', ...issueArgs(gP, scRO, aP, solUnusedKey(), { ...solGranteeArg(gP), tag: padTag('midnight:account:grant:zz:v9') })));
  // recipient kind 4: the module's renderer has no label for it (the
  // approval of the same grant with kind 3 signed)
  const g = G.grantee(9n);
  const sc3 = baseScope({ recipientKind: 3n, recipient: rnd() });
  const m3 = msgOf({ op: 'issue_grant', grantee: g, ...sc3 });
  await refused(G9, "recipient kind 4: the module's recipient-kind labels", 'runtime', /unknown recipient kind/,
    async () => sim.call('issue_grant_with_sol_ed25519', ...issueArgs(g, { ...sc3, recipientKind: 4n }, await signedOver(m3.bytes, m3.showArgs))));
  // a blank decimal: grantee slot 0 shown as three spaces, signed over that text
  const g0 = G.grantee(0n);
  const a0 = await sim.auth({ op: 'issue_grant', grantee: g0, ...sc });
  const blank = solMessageBytes(a0.text.replace('\nGrantee slot: 0  \n', '\nGrantee slot:    \n'));
  const sh0 = msgOf({ op: 'issue_grant', grantee: g0, ...sc }).showArgs as any[];
  ok(G9, 'setup: the blank-slot text differs from the honest one only in the slot line', blank.length === a0.message.length && !eq(blank, a0.message));
  await refused(G9, "grantee slot 0 shown as three spaces: the module's empty-decimal check", 'runtime', /empty decimal/,
    async () => sim.call('issue_grant_with_sol_ed25519', ...issueArgs(g0, sc, await signedOver(blank, [{ ...sh0[0], slot: [32n, 32n, 32n] }, ...sh0.slice(1)]))));
  ok(G9, 'every refusal left the state unchanged', sim.L().auth_nonce === ledger(before.state).auth_nonce);
}

// ── 10. the grant's scope salt and the grantee's read key ─────────────────
// The circuit derives the scope salt from the issuing device's blind, the
// account and the auth_nonce the device signed; no argument carries it. The
// grant's commitments are the chip's over that salt, the issuing client
// computes the same value for the grantee, and a spend opened with any other
// salt is refused. A grantee's read key is fresh per account and grant.
const G10 = '10 scope salt and read key';
{
  const own = await newDevice();
  const s = await Sim.create(own.dev);
  const Gs = await SolEd25519Grantee.enrol(gSigner, { network: 'undeployed', issuingAccount: s.bytes }, 'Example dApp');
  const C = rnd(), pinR = rnd();
  await s.call('deposit_unshielded', C, 1000n);
  // auth_nonce past zero first, so a derivation that ignores it differs
  await s.call('revoke_all_grants_with_sol_ed25519', ...authArgs(await s.auth({ op: 'revoke_all_grants' })));
  const n0 = s.L().auth_nonce as bigint;
  ok(G10, 'setup: auth_nonce is past zero before the grants', n0 >= 1n);
  const sc = baseScope({ color: C, recipientKind: 1n, recipient: pinR });
  const salt0 = await issue(s, Gs.grantee(0n), sc);
  const rec0 = s.L().grants.lookup(Gs.grantId(s.bytes, 0n));
  ok(G10, "the client's salt: the issuing device's blind, the account and the signed auth_nonce under the sol salt tag",
    eq(salt0, grantScopeSalt('sol_ed25519', own.dev.blind, s.bytes, n0)));
  ok(G10, "the chip's object commitment is over the derived salt",
    eq(rec0.scope.object_commit, pureCircuits.derive_grant_object_commit(salt0, sc.color, sc.recipientKind, sc.recipient, sc.maxCoinValue)));
  ok(G10, "the chip's spent commitment is over the derived salt", eq(rec0.spent_commit, pureCircuits.derive_grant_spent_commit(salt0, 0n)));
  ok(G10, "the chip's RP and caller commitments are over the derived salt", eq(rec0.scope.rp_commit, pureCircuits.derive_grant_rp_commit(salt0, sc.rpIdHash))
    && eq(rec0.scope.caller_commit, pureCircuits.derive_grant_caller_commit(salt0, { is_some: false, value: { bytes: Z32 } })));
  // the same scope one nonce later: another salt, other commitments
  const n1 = s.L().auth_nonce as bigint;
  const salt1 = await issue(s, Gs.grantee(1n), sc);
  const rec1 = s.L().grants.lookup(Gs.grantId(s.bytes, 1n));
  ok(G10, 'two issuances of the same scope get different salts and commitments', n1 === n0 + 1n && !eq(salt0, salt1)
    && !eq(rec0.scope.object_commit, rec1.scope.object_commit) && !eq(rec0.spent_commit, rec1.spent_commit));
  // the grantee opens the commitments with the salt the issuer handed over
  const spend = async (salt: Uint8Array, n: bigint) => {
    const r = s.L().grants.lookup(Gs.grantId(s.bytes, 0n));
    const au = await authoriseSolGrantee(Gs.device, { contractAddress: s.bytes, label: Gs.label, slot: 0n, issuedAt: r.issued_at, grantNonce: r.nonce }, SITE,
      { op: 'withdraw_unshielded_with_grant', amount: { color: C, amount: n, decimals: 0, symbol: 'tU' }, recipient: pinR });
    return s.call('withdraw_unshielded_with_grant_sol_ed25519', C, n, { bytes: pinR },
      ...grantAuthArgs({ originHash: grantOriginHash(labelBytes(Gs.label)), slot: 0n, scopeSalt: salt, recipientKind: 1n, pinnedRecipient: pinR, maxCoinValue: 500n, spentPrev: 0n }, au));
  };
  for (const [name, other] of [
    ['a random salt', rnd()],
    ['an all-zero salt', Z32],
    ['the salt at auth_nonce 0', grantScopeSalt('sol_ed25519', own.dev.blind, s.bytes, 0n)],
    ["the salt of another blind (the grantee's)", grantScopeSalt('sol_ed25519', Gs.blind, s.bytes, n0)],
    ["the next issuance's salt", salt1],
    ['the EVM arm\'s salt of the same values', grantScopeSalt('evm_eip712', own.dev.blind, s.bytes, n0)],
  ] as [string, Uint8Array][]) {
    await refused(G10, `a grantee spend opened with ${name} is refused`, 'runtime', /scope object mismatch|spent opening mismatch/, () => spend(other, 10n));
  }
  const landed = await spend(salt0, 10n).then(() => '', (e: any) => String(e?.message ?? e).slice(0, 200));
  ok(G10, "the grantee spend opened with the issuer's derived salt lands", landed === '' && s.L().unshielded_balances.lookup(C) === 990n, landed || undefined);

  // the read key: fresh per account and grant, from a secret the grantee keeps
  const secret = rnd();
  const kA = solGranteeReadKey(secret, Gs.grantId(s.bytes, 0n));
  const kA2 = Gs.readKey(secret, s.bytes, 0n);
  const kB = Gs.readKey(secret, s.bytes, 2n);
  const other = await Sim.create((await newDevice()).dev);
  const Go = await SolEd25519Grantee.enrol(gSigner, { network: 'undeployed', issuingAccount: other.bytes }, 'Example dApp');
  const kC = Go.readKey(secret, other.bytes, 0n);
  ok(G10, 'the read key is the same for the same secret and grant', eq(kA.publicKey, kA2.publicKey) && eq(kA.secretKey, kA2.secretKey));
  ok(G10, 'the read key differs per grant and per account', !eq(kA.publicKey, kB.publicKey) && !eq(kA.publicKey, kC.publicKey) && !eq(kB.publicKey, kC.publicKey));
  const nodeX25519 = (sk: Uint8Array) => new Uint8Array(createPublicKey(createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(sk)]), format: 'der', type: 'pkcs8' }))
    .export({ format: 'der', type: 'spki' }).subarray(-32));
  ok(G10, "the read key is an X25519 pair (Node's OpenSSL agrees)", eq(kA.publicKey, nodeX25519(kA.secretKey)) && eq(kC.publicKey, nodeX25519(kC.secretKey)));
  const scR = baseScope({ opWithdrawUnshielded: false, read: true, readPk: kB.publicKey, color: Z32, maxCoinValue: 0n, perCallCap: 0n, cap: 0n });
  await issue(s, Gs.grantee(2n), scR);
  ok(G10, 'a read grant stores the hash of its own fresh read key', eq(s.L().grants.lookup(Gs.grantId(s.bytes, 2n)).scope.read_pk_hash, sha256(kB.publicKey))
    && !eq(sha256(kB.publicKey), sha256(kA.publicKey)));
  for (const [name, f] of [
    ['a 31-byte secret', () => solGranteeReadKey(secret.slice(1), Gs.grantId(s.bytes, 0n))],
    ['a 33-byte grant id', () => solGranteeReadKey(secret, new Uint8Array(33))],
  ] as [string, () => unknown][]) await refused(G10, `the read key refuses ${name}`, 'client', /^sol_ed25519: a /, f);
}

const failed = cases.filter((c) => c.verdict !== 'PASS');
for (const gname of [...new Set(cases.map((c) => c.group))]) {
  const cs = cases.filter((c) => c.group === gname);
  console.log(`  ${cs.every((c) => c.verdict === 'PASS') ? '✓' : '✗'} ${gname}: ${cs.filter((c) => c.verdict === 'PASS').length}/${cs.length}`);
}
const verdict = failed.length ? 'FAIL' : 'PASS';
if (process.env.EVIDENCE_DIR) {
  fs.mkdirSync(process.env.EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.EVIDENCE_DIR, 'sol-ed25519-grants-offline.json'), JSON.stringify({ suite: 'sol-ed25519-grants-offline', ranAt: new Date().toISOString(), cases, verdict }, null, 2) + '\n');
}
console.log(`\n◆ sol-ed25519-grants-offline: ${verdict} (${cases.length} cases, ${failed.length} failed)`);
process.exit(verdict === 'PASS' ? 0 : 1);
