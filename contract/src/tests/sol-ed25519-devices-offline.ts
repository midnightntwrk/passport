// Arm `sol_ed25519`: the device lifecycle, offline (the generated JavaScript,
// no proof server, no node): `add_device_with_sol_ed25519` and
// `remove_device_with_sol_ed25519`.
//
// A sol_ed25519 device adds a device of every scheme by readable descriptor
// (jubjub, k256, p256, evm_k256, sol_ed25519); each entry must equal the
// target scheme's own derivation at the current epoch and counter 0, and
// each new upstream device and the new sol device then authorise their own
// call. Devices of the upstream arms enrol a sol device by upstream's raw
// entry. Removal by descriptor and by the literal form, an entry
// planted at device_epoch + 1 by an upstream arm evicted by descriptor, S13
// in both forms, the last device. Binding: every shown descriptor field
// changed at execution, and an evm address shown with another address's
// hex digits. Guards: an unregistered tag,
// an unused field set, a Solana target whose point is not the key shown, the
// identity as a Solana target, a non-identity point on another class, the
// form's unused values.
//
// The same cases at the constraint level are in `npm run test:sol-ed25519`.
//
// Writes $EVIDENCE_DIR/sol-ed25519-devices-offline.json when EVIDENCE_DIR is set.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { createCircuitContext, createConstructorContext, sampleContractAddress } from '@midnight-ntwrk/compact-runtime';

import { Contract, ledger, pureCircuits } from '../wallet/contract.js';
import { makeWitnesses, emptyCoinStore } from '../wallet/witnesses.js';
import { JubjubDevice, K256Device, authArgs, jubjubChallenges, k256Challenges, p256Challenges } from '../wallet/signer.js';
import { DESCRIPTOR_TAGS, padTag, type Descriptor } from '../wallet/descriptors.js';
import {
  SolEd25519Device, authoriseSolDevice, deriveSolBlind, solKeyHints, solSoftwareSigner, solDeviceMessageCircuit, solTargetOf,
  type SolEd25519Authorisation,
} from '../wallet/signer-sol-ed25519.js';
/** The key argument of a point with its own consistent byte inputs. */
const keyOf = (p: { x: bigint; y: bigint }) => ({ pk: { x: p.x, y: p.y }, ...solKeyHints(p) });
import {
  solBase58, solUnusedKey, nibblesOf, solDeviceHexValues, solFrameNibbles, solMessageBytes, solShow, solTargetArg, solTargetPoint, solTargetPointArg, solTargetShow,
  type SolDeviceOperation, type SolTargetFields,
} from '../wallet/sol-ed25519-message.js';
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
const rnd = (n: number) => new Uint8Array(randomBytes(n));
const SITE = 'Devices test';

interface Sim { contract: any; state: any; ps: any; address: string; bytes: Uint8Array }
const ledgerOf = (s: any) => ledger(s?.constructor?.name === 'ContractState' ? s.data : s);
async function call(sim: Sim, circuit: string, ...args: unknown[]) {
  const ctx = createCircuitContext({ circuitId: circuit, contractAddress: sim.address, coinPublicKeyOrZswapState: { bytes: rnd(32) }, contractState: sim.state, privateState: sim.ps, time: 1_800_000_000 } as any);
  const r = await sim.contract.impureCircuits[circuit](ctx, ...args);
  sim.state = r.context.callContext.currentQueryContext.state;
  return r.result;
}
const newSolDevice = async () => { const s = solSoftwareSigner(rnd(32)); return SolEd25519Device.fromSigner(s, await deriveSolBlind(s, { network: 'undeployed', accountIndex: 0 })); };
async function deploy(device: SolEd25519Device): Promise<Sim> {
  const contract = new (Contract as any)(makeWitnesses());
  const ps = emptyCoinStore();
  const salt = rnd(32);
  const init = await contract.initialState(createConstructorContext(ps, { bytes: rnd(32) }), device.bootCommitment(salt), rnd(32), JubjubDevice.generate().pk, new Uint8Array(64), 259200n);
  const address = sampleContractAddress();
  const sim: Sim = { contract, state: init.currentContractState, ps, address, bytes: new Uint8Array(Buffer.from(address.replace(/^0x/, ''), 'hex')) };
  await call(sim, 'activate_initial_device_with_sol_ed25519', ...device.activationArgs(salt));
  return sim;
}
const snapshot = (sim: Sim): Sim => ({ ...sim });
const ctxOf = (sim: Sim) => ({ contractAddress: sim.bytes, authNonce: ledgerOf(sim.state).auth_nonce as bigint });
const epochOf = (sim: Sim) => ledgerOf(sim.state).device_epoch as bigint;
const live = (sim: Sim, e: Uint8Array) => ledgerOf(sim.state).devices.member(e);
const counterOf = (sim: Sim, d: { entryAt(a: Uint8Array, e: bigint, c: bigint): Uint8Array }) => {
  const l = ledgerOf(sim.state);
  for (let k = 0n; k < 64n; k++) if (l.devices.member(d.entryAt(sim.bytes, l.device_epoch, k))) return k;
  throw new Error('no live entry');
};
const auth = (sim: Sim, d: SolEd25519Device, o: SolDeviceOperation) => authoriseSolDevice(d, ctxOf(sim), SITE, o, counterOf(sim, d));
const shownFor = (sim: Sim, d: SolEd25519Device, o: SolDeviceOperation) => solDeviceMessageCircuit(d.key, ctxOf(sim), SITE, o).showArgs;
const withShow = (a: SolEd25519Authorisation, showArgs: unknown[]): SolEd25519Authorisation => ({ ...a, showArgs });
const add = (sim: Sim, t: SolTargetFields, a: SolEd25519Authorisation, pk: unknown = solTargetPointArg(t), arg: unknown = solTargetArg(t)) =>
  call(sim, 'add_device_with_sol_ed25519', arg, pk, ...authArgs(a));
const remove = (sim: Sim, literal: boolean, t: SolTargetFields, counter: bigint, epoch: bigint, entry: Uint8Array, a: SolEd25519Authorisation, pk: unknown = literal ? solUnusedKey() : solTargetPointArg(t)) =>
  call(sim, 'remove_device_with_sol_ed25519', literal, solTargetArg(t), pk, counter, epoch, entry, ...authArgs(a));
const rotateUpstream = async (sim: Sim, dev: any) => {
  const ctx = ctxOf(sim), key = rnd(32), c = counterOf(sim, dev);
  const a = dev.arm === 'jubjub' ? dev.sign(jubjubChallenges.rotateEncKey(ctx, dev.pk, key), c)
    : dev.arm === 'k256' ? dev.sign(k256Challenges.rotateEncKey(ctx, dev.pk, key), c)
      : await dev.sign(p256Challenges.rotateEncKey(ctx, dev.pk, key), c);
  await call(sim, `rotate_enc_key_with_${dev.arm}`, key, ...authArgs(a));
  return key;
};
const rotateSol = async (sim: Sim, d: SolEd25519Device) => {
  const key = rnd(32);
  await call(sim, 'rotate_enc_key_with_sol_ed25519', key, ...authArgs(await auth(sim, d, { op: 'rotate_enc_key', newKey: key })));
  return key;
};

const S = await newSolDevice();
const jub = JubjubDevice.generate();
const k1 = K256Device.generate();
const pass = softwarePasskey();
const evmAddr = rnd(20), evmBlind = rnd(32);
const S2 = await newSolDevice();
const D: [string, Descriptor, any][] = [
  ['jubjub', { scheme: 'jubjub', x: jub.pk.x, y: jub.pk.y }, jub],
  ['k256', { scheme: 'k256', x: k1.pk.x, y: k1.pk.y, envelope: Number(k1.envelope) as 0 | 1 }, k1],
  ['p256', { scheme: 'p256', x: pass.pk.x, y: pass.pk.y, policy: { rpIdHash: pass.policy.rp_id_hash, origin: pass.policy.origin } }, pass.device],
  ['evm_k256', { scheme: 'evm_k256', address: evmAddr, blind: evmBlind }, null],
  ['sol_ed25519', S2.descriptor(), S2],
];
// The evm_k256 entry recomputed independently: SHA-256 of the documented preimage
// (pad32(tag) || account || address(20) || blind(32) || le4(epoch) || le8(counter)).
const le = (v: bigint, n: number) => { const o = new Uint8Array(n); let x = v; for (let i = 0; i < n; i++) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; };
const evmEntry = (addr: Uint8Array, address: Uint8Array, blind: Uint8Array, e: bigint, c: bigint) =>
  sha256(new Uint8Array([...padTag(DESCRIPTOR_TAGS.device.evm_k256), ...addr, ...address, ...blind, ...le(e, 4), ...le(c, 8)]));
const entryOf = (scheme: string, d: Descriptor, dev: any, addr: Uint8Array, e: bigint, c: bigint) =>
  scheme === 'evm_k256' ? evmEntry(addr, (d as any).address, (d as any).blind, e, c) : dev.entryAt(addr, e, c);

// ── 1. add_device: every scheme, its own recipe, then its own call ─────────
const G1 = '1 add_device, all five schemes';
const sim = await deploy(S);
for (const [scheme, d, dev] of D) {
  const t = solTargetOf(d);
  const ep = epochOf(sim);
  const a = await auth(sim, S, { op: 'add_device', target: t });
  ok(G1, `${scheme}: the message is the contract's own (685 bytes) and shows the consequence`, a.text.length === 685 && a.message.length === 50 + 685 && a.text.includes('Consequence: gives this device FULL control of this account.\n'));
  await add(sim, t, a);
  const e0 = entryOf(scheme, d, dev, sim.bytes, ep, 0n);
  ok(G1, `${scheme}: the entry equals ${scheme === 'evm_k256' ? 'the descriptor module recipe' : `the ${scheme} arm's own derivation`} at (epoch, 0); nothing at epoch + 1`,
    live(sim, e0) && !live(sim, entryOf(scheme, d, dev, sim.bytes, ep + 1n, 0n)));
}
ok(G1, 'six devices', ledgerOf(sim.state).device_count === 6n);
for (const [scheme, , dev] of D) {
  if (!dev) continue;
  const before = ledgerOf(sim.state).auth_nonce;
  if (scheme === 'sol_ed25519') await rotateSol(sim, dev); else await rotateUpstream(sim, dev);
  ok(G1, `the new ${scheme} device authorises its own rotate_enc_key`, ledgerOf(sim.state).auth_nonce === before + 1n);
}

// ── 2. X → sol by upstream's raw entry, then the new sol device signs ──────
const G2 = '2 upstream arms enrol a sol device';
{
  const sim2 = await deploy(S);
  for (const [, d] of D.slice(0, 3)) { const t = solTargetOf(d); await add(sim2, t, await auth(sim2, S, { op: 'add_device', target: t })); }
  for (const dev of [jub, k1, pass.device]) {
    const Si = await newSolDevice();
    const ctx = ctxOf(sim2), c = counterOf(sim2, dev);
    const entry = Si.entryAt(sim2.bytes, epochOf(sim2), 0n);
    const a = dev.arm === 'jubjub' ? dev.sign(jubjubChallenges.addDevice(ctx, dev.pk, entry), c)
      : dev.arm === 'k256' ? dev.sign(k256Challenges.addDevice(ctx, dev.pk, entry), c) : await dev.sign(p256Challenges.addDevice(ctx, dev.pk, entry), c);
    await call(sim2, `add_device_with_${dev.arm}`, entry, ...authArgs(a));
    await rotateSol(sim2, Si);
    ok(G2, `${dev.arm} enrols a sol device by raw entry; the sol device signs its own call`, live(sim2, Si.entryAt(sim2.bytes, epochOf(sim2), 1n)));
  }
}

// ── 3. removal, the plant, S13, the last device ────────────────────────────
const G3 = '3 remove_device';
const simR = await deploy(S);
for (const [, d] of D.slice(0, 3)) { const t = solTargetOf(d); await add(simR, t, await auth(simR, S, { op: 'add_device', target: t })); }
const tJ = solTargetOf(D[0][1]), tK = solTargetOf(D[1][1]), tP = solTargetOf(D[2][1]);
{
  const ep = epochOf(simR);
  // the plant: K enrols a sol entry at device_epoch + 1 through the raw path
  const W = await newSolDevice();
  const plant = W.entryAt(simR.bytes, ep + 1n, 0n);
  await call(simR, 'add_device_with_k256', plant, ...authArgs(k1.sign(k256Challenges.addDevice(ctxOf(simR), k1.pk, plant), counterOf(simR, k1))));
  ok(G3, 'the upstream residual: K plants a sol entry at device_epoch + 1', live(simR, plant));
  const tW = solTargetOf(W.descriptor());
  const aW = await auth(simR, S, { op: 'remove_device', literal: false, target: tW, counter: 0n, epoch: ep + 1n });
  ok(G3, 'the removal message shows the epoch and counter (761 bytes)', aW.text.length === 761 && aW.message.length === 50 + 761 && aW.text.includes(`Device epoch: ${String(ep + 1n).padEnd(10, ' ')}\n`));
  await remove(simR, false, tW, 0n, ep + 1n, new Uint8Array(32), aW);
  ok(G3, 'S evicts the plant by descriptor at target epoch device_epoch + 1', !live(simR, plant));
  // descriptor and literal removals
  const jc = counterOf(simR, jub);
  await remove(simR, false, tJ, jc, ep, new Uint8Array(32), await auth(simR, S, { op: 'remove_device', literal: false, target: tJ, counter: jc, epoch: ep }));
  ok(G3, 'S removes J by descriptor', !live(simR, jub.entryAt(simR.bytes, ep, jc)));
  const eK = k1.entryAt(simR.bytes, ep, counterOf(simR, k1));
  const aL = await auth(simR, S, { op: 'remove_device', literal: true, entry: eK });
  ok(G3, 'the literal message shows the fixed line and the entry in full', aL.text.includes('Removes a device this wallet cannot identify\nDevice entry: ' + Buffer.from(eK).toString('hex')));
  await remove(simR, true, { tag: '' }, 0n, 0n, eK, aL);
  ok(G3, 'S removes K by the literal form ("Removes a device this wallet cannot identify")', !live(simR, eK));
  // S13, both forms
  const c = counterOf(simR, S);
  const tS = solTargetOf(S.descriptor());
  await refused(G3, 'S13: S removes its own post-roll entry by descriptor', 'runtime', /cannot remove the authorising device/, async () =>
    remove(simR, false, tS, c + 1n, ep, new Uint8Array(32), await auth(simR, S, { op: 'remove_device', literal: false, target: tS, counter: c + 1n, epoch: ep })));
  const own = S.entryAt(simR.bytes, ep, c + 1n);
  await refused(G3, 'S13: S removes its own post-roll entry by the literal form', 'runtime', /cannot remove the authorising device/, async () =>
    remove(simR, true, { tag: '' }, 0n, 0n, own, await auth(simR, S, { op: 'remove_device', literal: true, entry: own })));
  await refused(G3, 'an entry that is not in the set (literal form)', 'runtime', /unknown device entry/, async () => {
    const e = rnd(32); return remove(simR, true, { tag: '' }, 0n, 0n, e, await auth(simR, S, { op: 'remove_device', literal: true, entry: e }));
  });
  const pc = counterOf(simR, pass.device);
  await remove(simR, false, tP, pc, ep, new Uint8Array(32), await auth(simR, S, { op: 'remove_device', literal: false, target: tP, counter: pc, epoch: ep }));
  ok(G3, 'S removes the passkey by descriptor; S alone remains', ledgerOf(simR.state).device_count === 1n);
  await refused(G3, 'the last device: S alone removes another entry', 'runtime', /cannot remove last device/, async () => {
    const e = rnd(32); return remove(simR, true, { tag: '' }, 0n, 0n, e, await auth(simR, S, { op: 'remove_device', literal: true, entry: e }));
  });
}

// ── 4. binding: a shown descriptor field changed at execution ──────────────
const G4 = '4 binding';
{
  const b = await deploy(S);
  const flip = (x: Uint8Array) => { const o = new Uint8Array(x); o[0] ^= 1; return o; };
  const tE = solTargetOf(D[3][1]), tS2 = solTargetOf(D[4][1]);
  const other = await newSolDevice();
  const B: [string, SolTargetFields, SolTargetFields][] = [
    ['the jubjub x coordinate', tJ, { ...tJ, a: flip(tJ.a!) }],
    ['the k256 envelope (0 -> 1)', tK, { ...tK, envelope: 1n }],
    ['the passkey origin', tP, { ...tP, origin: new TextEncoder().encode('https://b.example.com') }],
    ['the passkey RP hash', tP, { ...tP, c: flip(tP.c!) }],
    ['the evm address', tE, { ...tE, address: flip(tE.address!) }],
    ['the sol key (another valid key)', tS2, { ...tS2, a: other.key }],
    ['the sol device privacy salt', tS2, { ...tS2, b: flip(tS2.b!) }],
    ['the scheme (a jubjub key signed, the same bytes executed as an evm target)', tJ, { tag: DESCRIPTOR_TAGS.device.evm_k256, address: new Uint8Array(20), a: tJ.a }],
  ];
  for (const [name, signed, executed] of B) {
    await refused(G4, `add_device: ${name} changed at execution (consistent display inputs)`, 'runtime', /invalid signature/, async () => {
      const a = await auth(b, S, { op: 'add_device', target: signed });
      return add(b, executed, withShow(a, shownFor(b, S, { op: 'add_device', target: executed })));
    });
  }
  // The wallet signed a message showing another evm address, and the display
  // inputs carry that address's hex digits: the signature holds, so only the
  // display check (the digits against the executed address) refuses it; then
  // the honest call lands (positive control)
  {
    const m = solDeviceMessageCircuit(S.key, ctxOf(b), SITE, { op: 'add_device', target: { ...tE, address: flip(tE.address!) } });
    await refused(G4, 'add_device: the wallet signed a message showing another evm address (its hex digits with it): the display check', 'runtime',
      /hex digits do not match the value/, async () => {
        const a = await auth(b, S, { op: 'add_device', target: tE });
        return add(b, tE, { ...a, sig: (await S.signApproval(m.bytes)).sig, showArgs: m.showArgs });
      });
    const ep = epochOf(b);
    await add(b, tE, await auth(b, S, { op: 'add_device', target: tE }));
    ok(G4, 'add_device (evm target): positive control, the honest approval lands', live(b, entryOf('evm_k256', D[3][1], null, b.bytes, ep, 0n)));
  }
  const sR = await deploy(S);
  await add(sR, tJ, await auth(sR, S, { op: 'add_device', target: tJ }));
  const ep = epochOf(sR);
  const o: SolDeviceOperation = { op: 'remove_device', literal: false, target: tJ, counter: 0n, epoch: ep };
  const a = await auth(sR, S, o);
  await refused(G4, 'remove_device: the counter changed at execution', 'runtime', /invalid signature/, () =>
    remove(sR, false, tJ, 1n, ep, new Uint8Array(32), withShow(a, shownFor(sR, S, { ...o, counter: 1n }))));
  await refused(G4, 'remove_device: the epoch changed at execution', 'runtime', /invalid signature/, () =>
    remove(sR, false, tJ, 0n, ep + 1n, new Uint8Array(32), withShow(a, shownFor(sR, S, { ...o, epoch: ep + 1n }))));
  await refused(G4, 'remove_device: the form swapped (a literal approval of J\'s entry executed as the descriptor form)', 'runtime', /invalid signature/, async () => {
    const lit = await auth(sR, S, { op: 'remove_device', literal: true, entry: jub.entryAt(sR.bytes, ep, 0n) });
    return remove(sR, false, tJ, 0n, ep, new Uint8Array(32), withShow(lit, shownFor(sR, S, o)));
  });
  // The wallet signed the message of exactly this call, but
  // showing a foreign account (its frame nibbles with it): only the seam's
  // frame check refuses it; then the honest call lands (positive control)
  const foreign = (op: SolDeviceOperation) => authoriseSolDevice(S, { ...ctxOf(sR), contractAddress: rnd(32) }, SITE, op, counterOf(sR, S));
  const FR = /hex digits do not match/;
  await refused(G4, 'remove_device (descriptor): the wallet signed a message showing a foreign account (its frame nibbles with it): the seam\'s frame check', 'runtime', FR, async () =>
    remove(sR, false, tJ, 0n, ep, new Uint8Array(32), await foreign(o)));
  await remove(sR, false, tJ, 0n, ep, new Uint8Array(32), a);
  ok(G4, 'remove_device (descriptor): positive control, the honest approval lands after the refusals', !live(sR, jub.entryAt(sR.bytes, ep, 0n)));
  const oK: SolDeviceOperation = { op: 'add_device', target: tK };
  await refused(G4, 'add_device: the wallet signed a message showing a foreign account (its frame nibbles with it): the seam\'s frame check', 'runtime', FR, async () =>
    add(sR, tK, await foreign(oK)));
  await add(sR, tK, await auth(sR, S, oK));
  const eK0 = k1.entryAt(sR.bytes, ep, 0n);
  ok(G4, 'add_device: positive control, the honest approval lands', live(sR, eK0));
  const oL: SolDeviceOperation = { op: 'remove_device', literal: true, entry: eK0 };
  await refused(G4, 'remove_device (literal): the wallet signed a message showing a foreign account (its frame nibbles with it): the seam\'s frame check', 'runtime', FR, async () =>
    remove(sR, true, { tag: '' }, 0n, 0n, eK0, await foreign(oL)));
  await remove(sR, true, { tag: '' }, 0n, 0n, eK0, await auth(sR, S, oL));
  ok(G4, 'remove_device (literal): positive control, the honest approval lands', !live(sR, eK0));
}

// ── 5. guards under a valid signature ──────────────────────────────────────
const G5 = '5 guards';
{
  const g = await deploy(S);
  const unreg = { ...solTargetArg(tP), tag: padTag('midnight:account:device:zz:v9') };
  await refused(G5, 'an unregistered tag under a valid signature over the passkey message', 'runtime', /not a registered device tag/, async () =>
    add(g, tP, await auth(g, S, { op: 'add_device', target: tP }), solTargetPointArg(tP), unreg));
  // a k256 target with signing envelope 2: the module's renderer has no
  // label for it; the wallet signed the text shown past that check (a blank)
  await refused(G5, "a k256 target with signing envelope 2, signed over the text past the label check: the module's envelope labels", 'runtime', /unknown signing envelope/, async () => {
    const a = await auth(g, S, { op: 'add_device', target: tK });
    if (a.text.split(/Signing envelope: .{24}/).length !== 2) throw new Error('setup: the envelope line is not shown exactly once');
    const bytes = solMessageBytes(a.text.replace(/Signing envelope: .{24}/, `Signing envelope: ${' '.repeat(24)}`));
    if (bytes.length !== a.text.length) throw new Error('setup: the blank envelope changed the layout');
    return add(g, { ...tK, envelope: 2n }, { ...a, sig: (await S.signApproval(bytes)).sig });
  });
  await refused(G5, 'a jubjub target with a non-zero envelope (not shown; its digits supplied consistently)', 'runtime', /unused envelope must be zero/, async () => {
    const a = await auth(g, S, { op: 'add_device', target: tJ });
    const sh = a.showArgs as any[];
    return add(g, tJ, withShow(a, [solTargetShow({ ...tJ, envelope: 1n }), sh[1], sh[2], sh[3]]), solTargetPointArg(tJ), { ...solTargetArg(tJ), envelope: 1n });
  });
  // fields a class does not show, non-zero: the message is the same bytes as
  // with them zero, and the wallet signed the contract's own bytes
  for (const [name, t, re] of [
    ['an evm_k256 target with a non-zero second field', { ...solTargetOf(D[3][1]), b: rnd(32) }, /unused second field must be zero/],
    ['a jubjub target with a non-zero RP hash', { ...tJ, c: rnd(32) }, /unused rp hash must be zero/],
    ['a jubjub target with a non-zero origin (its characters equal its bytes)', { ...tJ, origin: rnd(21) }, /unused origin must be zero/],
    ['a jubjub target with a non-zero address (its hex digits supplied consistently)', { ...tJ, address: rnd(20) }, /unused address must be zero/],
  ] as [string, SolTargetFields, RegExp][]) {
    await refused(G5, `${name} (not shown; the wallet signed the contract's bytes)`, 'runtime', re, async () => {
      const m = solDeviceMessageCircuit(S.key, ctxOf(g), SITE, { op: 'add_device', target: t });
      const a = await auth(g, S, { op: 'add_device', target: tJ });
      return add(g, t, { ...a, sig: (await S.signApproval(m.bytes)).sig, showArgs: m.showArgs });
    });
  }
  const S3 = await newSolDevice();
  const tS3 = solTargetOf(S3.descriptor());
  /** add_device of `exec` with the key argument `key`, under the wallet's
   *  signature over the message the circuit renders for these values: the
   *  block shows the key argument's bytes in base58 (`shown` is `exec` with
   *  those bytes as its key), every other display input is `exec`'s. */
  const addSigned = async (sim: Sim, exec: SolTargetFields, shown: SolTargetFields, key: unknown) => {
    const m = solDeviceMessageCircuit(S.key, ctxOf(sim), SITE, { op: 'add_device', target: shown });
    const sh = m.showArgs as any[];
    const a = await auth(sim, S, { op: 'add_device', target: exec });
    return add(sim, exec, { ...a, sig: (await S.signApproval(m.bytes)).sig, showArgs: [sh[0], sh[1], sh[2], nibblesOf(...solDeviceHexValues({ op: 'add_device', target: exec }))] }, key);
  };
  {
    const O = await newSolDevice();
    await refused(G5, "a Solana target whose descriptor key is not its key argument's (the message shows the key argument's)", 'runtime', /not the point's encoding/, () =>
      addSigned(g, tS3, { ...tS3, a: O.key }, keyOf(solTargetPoint(O.key))));
    await refused(G5, "a Solana target whose key argument shows another key than the descriptor (display inputs of the descriptor's key)", 'runtime',
      /base58 digits do not match|base58 carry hints|leading base58 ones/, async () => add(g, tS3, await auth(g, S, { op: 'add_device', target: tS3 }), keyOf(solTargetPoint(O.key))));
  }
  await refused(G5, 'a jubjub target with a non-identity point', 'runtime', /unused point must be the identity/, async () =>
    add(g, tJ, await auth(g, S, { op: 'add_device', target: tJ }), { ...solUnusedKey(), pk: solTargetPoint(S3.key) }));
  await refused(G5, 'a jubjub target with the identity point but non-zero key bytes (their base58 inputs supplied; a jubjub block shows no Solana key)', 'runtime', /unused key bytes must be zero/, async () => {
    const kb = [1n, ...new Array<bigint>(31).fill(0n)];
    const a = await auth(g, S, { op: 'add_device', target: tJ });
    const sh = a.showArgs as any[];
    return add(g, tJ, withShow(a, [{ ...sh[0], key: solBase58(Uint8Array.from(kb, Number)) }, sh[1], sh[2], sh[3]]), { ...solUnusedKey(), pk_bytes: kb });
  });
  await refused(G5, 'a jubjub target with the identity point but non-zero x bytes', 'runtime', /unused key bytes must be zero/, async () =>
    add(g, tJ, await auth(g, S, { op: 'add_device', target: tJ }), { ...solUnusedKey(), pk_x: [...new Array<bigint>(16).fill(0n), 9n, ...new Array<bigint>(15).fill(0n)] }));
  {
    const k = solTargetPointArg(tS3) as any;
    const b = [...k.pk_bytes]; b[3] ^= 1n;
    const tF = { ...tS3, a: Uint8Array.from(b, Number) };
    await refused(G5, "a Solana target's key bytes with one byte flipped (shown, signed and in the descriptor alike)", 'runtime', /ed25519: the encoding does not match the point's y/, () =>
      addSigned(g, tF, tF, { ...k, pk_bytes: b }));
    const x = [...k.pk_x]; x[30] ^= 2n;
    await refused(G5, "a Solana target's x bytes with one byte flipped", 'runtime', /ed25519: the x bytes do not match the point's x/, async () =>
      add(g, tS3, await auth(g, S, { op: 'add_device', target: tS3 }), { ...k, pk_x: x }));
  }
  // the identity as a Solana target: the client refuses to decode it; past
  // the client, the message renders 0100..00 and the wallet signs it
  const idKey = new Uint8Array(32); idKey[0] = 1;
  const tId: SolTargetFields = { tag: DESCRIPTOR_TAGS.device.sol_ed25519, a: idKey, b: rnd(32) };
  await refused(G5, 'the identity as a Solana target (client decode)', 'client', /identity|small order|not a valid|torsion/i, () => solTargetPoint(idKey));
  await refused(G5, 'the identity point as a Solana target under a valid signature (A != O in the derivation)', 'runtime', /the Ed25519 key is the identity/, async () => {
    const shown = [solTargetShow(tId), solShow(SITE, ledgerOf(g.state).auth_nonce), solFrameNibbles(g.bytes, S.key), nibblesOf(...solDeviceHexValues({ op: 'add_device', target: tId }))];
    const bytes: Uint8Array = (pureCircuits as any).sol_message_add_device({ bytes: g.bytes }, S.key, ledgerOf(g.state).auth_nonce, solTargetArg(tId), ...shown);
    const { sig } = await S.signApproval(bytes);
    const a = await auth(g, S, { op: 'add_device', target: tJ });
    return add(g, tId, { ...a, sig, showArgs: shown }, keyOf({ x: 0n, y: 1n }));
  });
  const T8 = ed25519.Point.fromBytes(Buffer.from('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a', 'hex'), false).toAffine();
  await refused(G5, 'a small-order point as a Solana target (the runtime type check)', 'runtime', /Curve25519Point|type error|expected/i, async () =>
    add(g, tS3, await auth(g, S, { op: 'add_device', target: tS3 }), keyOf({ x: T8.x, y: T8.y })));
  // the removal's unused form
  const s5 = await deploy(S);
  await add(s5, tJ, await auth(s5, S, { op: 'add_device', target: tJ }));
  await add(s5, tK, await auth(s5, S, { op: 'add_device', target: tK }));
  const ep = epochOf(s5);
  const eK = k1.entryAt(s5.bytes, ep, 0n);
  {
    const o: SolDeviceOperation = { op: 'remove_device', literal: false, target: tJ, counter: 0n, epoch: ep };
    const a = await auth(s5, S, o);
    const sh = a.showArgs as any[];
    const hex = nibblesOf(...solDeviceHexValues(o).slice(0, 4), eK);
    await refused(G5, 'the descriptor form carrying a non-zero literal entry (not shown; never executed)', 'runtime', /descriptor removal carries no literal entry/, () =>
      remove(s5, false, tJ, 0n, ep, eK, withShow(a, [sh[0], sh[1], sh[2], hex])));
  }
  {
    const o: SolDeviceOperation = { op: 'remove_device', literal: true, entry: eK };
    const a = await auth(s5, S, o);
    const sh = a.showArgs as any[];
    const hex = nibblesOf(...solDeviceHexValues({ op: 'remove_device', literal: false, target: tJ, counter: 0n, epoch: 0n }).slice(0, 4), eK);
    await refused(G5, 'the literal form carrying a non-zero descriptor (not shown; never executed)', 'runtime', /literal removal carries no descriptor/, () =>
      call(s5, 'remove_device_with_sol_ed25519', true, solTargetArg(tJ), solUnusedKey(), 0n, 0n, eK, ...authArgs(withShow(a, [sh[0], sh[1], sh[2], hex]))));
    await refused(G5, 'the literal form carrying a non-identity point', 'runtime', /literal removal carries no descriptor/, () =>
      remove(s5, true, { tag: '' }, 0n, 0n, eK, a, { ...solUnusedKey(), pk: solTargetPoint(S3.key) }));
    await refused(G5, 'the literal form carrying non-zero key bytes', 'runtime', /literal removal carries no descriptor/, () =>
      remove(s5, true, { tag: '' }, 0n, 0n, eK, a, { ...solUnusedKey(), pk_x: [...new Array<bigint>(31).fill(0n), 1n] }));
    // a literal removal shows no target: its display inputs must be an empty
    // target's (the message is unchanged, so the wallet's signature stands);
    // the entry is removable (a non-authorising device of three), so only
    // that check refuses
    await refused(G5, "a literal removal of a removable entry whose use counter digits are not an empty target's (the message unchanged)", 'runtime',
      /a literal removal's display inputs are not those of an empty target/, () =>
        remove(s5, true, { tag: '' }, 0n, 0n, eK, withShow(a, [{ ...sh[0], counter: [55n, ...new Array<bigint>(19).fill(32n)] }, ...sh.slice(1)])));
  }
  ok(G5, 'after every refusal both devices are still there', ledgerOf(s5.state).device_count === 3n && live(s5, eK));
  // A passkey's own RP hash is never zero. The renderer refuses to
  // build such a message; past the client, the wallet signs the contract's
  // own bytes (the pure message circuit renders the zero hash in hex) and
  // only the target's derivation refuses it, for add and for removal by
  // descriptor
  {
    const tZ: SolTargetFields = { ...tP, c: new Uint8Array(32) };
    const signedCircuit = async (sim: Sim, o: SolDeviceOperation) => {
      const { bytes, showArgs } = solDeviceMessageCircuit(S.key, ctxOf(sim), SITE, o);
      return { ...(await auth(sim, S, { op: 'add_device', target: tJ })), sig: (await S.signApproval(bytes)).sig, showArgs };
    };
    await refused(G5, "a passkey target with an all-zero RP hash: the renderer refuses the add_device message", 'client', /a passkey's RP hash is zero/, () =>
      auth(g, S, { op: 'add_device', target: tZ }));
    await refused(G5, "add_device of a passkey target with an all-zero RP hash under a valid signature over the contract's bytes", 'runtime', /a passkey's RP hash is zero/, async () =>
      add(g, tZ, await signedCircuit(g, { op: 'add_device', target: tZ })));
    const oR: SolDeviceOperation = { op: 'remove_device', literal: false, target: tZ, counter: 0n, epoch: ep };
    await refused(G5, "remove_device by descriptor of a passkey target with an all-zero RP hash: the renderer refuses the message", 'client', /a passkey's RP hash is zero/, () =>
      auth(s5, S, oR));
    await refused(G5, "remove_device by descriptor of a passkey target with an all-zero RP hash under a valid signature over the contract's bytes", 'runtime', /a passkey's RP hash is zero/, async () =>
      remove(s5, false, tZ, 0n, ep, new Uint8Array(32), await signedCircuit(s5, oR)));
    ok(G5, 'a passkey target shows its RP hash in hex (no word)', (await auth(g, S, { op: 'add_device', target: tP })).text.includes(`Passkey RP (hash): ${Buffer.from(tP.c!).toString('hex')}\n`));
  }
  // the client: an unregistered scheme is refused before any message is built
  // (the base's checkDescriptor returns nothing for one)
  await refused(G5, 'an unregistered scheme: the facade refuses the descriptor (no message, no call)', 'client', /not a registered descriptor scheme \(zz\)/, () => solTargetOf({ scheme: 'zz' } as any));
  await refused(G5, 'a descriptor without a scheme: the facade refuses it', 'client', /not a registered descriptor scheme \(undefined\)/, () => solTargetOf({} as any));
}

const failed = cases.filter((c) => c.verdict !== 'PASS');
for (const gname of [...new Set(cases.map((c) => c.group))]) {
  const cs = cases.filter((c) => c.group === gname);
  console.log(`  ${cs.every((c) => c.verdict === 'PASS') ? '✓' : '✗'} ${gname}: ${cs.filter((c) => c.verdict === 'PASS').length}/${cs.length}`);
}
const verdict = failed.length ? 'FAIL' : 'PASS';
if (process.env.EVIDENCE_DIR) {
  fs.mkdirSync(process.env.EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.EVIDENCE_DIR, 'sol-ed25519-devices-offline.json'), JSON.stringify({ suite: 'sol-ed25519-devices-offline', ranAt: new Date().toISOString(), cases, verdict }, null, 2) + '\n');
}
console.log(`\n◆ sol-ed25519-devices-offline: ${verdict} (${cases.length} cases, ${failed.length} failed)`);
process.exit(verdict === 'PASS' ? 0 : 1);
