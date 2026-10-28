// Arm `sol_ed25519`: the device seam, offline (the generated JavaScript, no
// proof server, no node), through `rotate_enc_key_with_sol_ed25519`.
//
// The binding matrix: a valid signature, then one signed value changed at
// execution (the new key, the site's label, the nonce, the account, the
// signing key, the use counter, the blind, the operation), each refused. The
// replay matrix: the same authorisation again, at the old and at the new use
// counter; across two accounts of the same device; across operations. The
// degenerate signatures: R = O, small-order and mixed-order R, S + L. The
// verification's checked inputs (R's encoding and R's x bytes) forged under a
// signature made over the forged encoding: each refused by its own check. The
// positive control lands first and the state transition is checked (the
// entry rolls, auth_nonce and round advance, last-device rule). The two
// signing formats: the same key and blind authorise in either; from one
// state the two calls leave equal public transcripts; a signature in one
// format is refused in the other; the old raw bytes (the text alone), an
// off-chain envelope naming another signer, an off-chain message v0 and a
// head with one byte changed are refused in both.
//
// The constraint-level half of the same matrix is `npm run test:sol-ed25519`
// (src/tests/sol-ed25519-prover.ts, section `seam`). No test reads the
// contract source: what the seams' call sites must do is held by these
// functional calls.
//
// Writes $EVIDENCE_DIR/sol-ed25519-seam-offline.json when EVIDENCE_DIR is set.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { createCircuitContext, createConstructorContext, sampleContractAddress } from '@midnight-ntwrk/compact-runtime';

import { Contract, ledger, pureCircuits } from '../wallet/contract.js';
import { makeWitnesses, emptyCoinStore } from '../wallet/witnesses.js';
import { JubjubDevice, K256Device, authArgs, k256Challenges, p256Challenges } from '../wallet/signer.js';
import { softwarePasskey } from './p256-fixtures.js';
import {
  ED25519_L, SolEd25519Device, authoriseSolDevice, decodeSolSignature, deriveSolBlind, solSoftwareSigner,
  solDeviceMessageCircuit, solEd25519AuthArgs, solSignatureHints, type SolEd25519Authorisation,
} from '../wallet/signer-sol-ed25519.js';
import { SOL_OFFCHAIN_DOMAIN, SOL_RAW_HEAD, assertSolOffchainMessage, nibblesOf, solFrameNibbles, solShow, solSignedMessage } from '../wallet/sol-ed25519-message.js';
import { solBlindMessage } from '../wallet/signer-sol-ed25519.js';

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
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const SITE = 'Seam test';

interface Sim { contract: any; state: any; ps: any; address: string; bytes: Uint8Array }
const ledgerOf = (s: any) => ledger(s?.constructor?.name === 'ContractState' ? s.data : s);
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
async function call(sim: Sim, circuit: string, ...args: unknown[]) {
  const ctx = createCircuitContext({ circuitId: circuit, contractAddress: sim.address, coinPublicKeyOrZswapState: { bytes: rnd(32) }, contractState: sim.state, privateState: sim.ps, time: 1_800_000_000 } as any);
  const r = await sim.contract.impureCircuits[circuit](ctx, ...args);
  sim.state = r.context.callContext.currentQueryContext.state;
  return r.result;
}
const ctxOf = (sim: Sim) => ({ contractAddress: sim.bytes, authNonce: ledgerOf(sim.state).auth_nonce as bigint });
const rotate = (sim: Sim, newKey: Uint8Array, a: SolEd25519Authorisation) => call(sim, 'rotate_enc_key_with_sol_ed25519', newKey, ...authArgs(a));
const withSig = (a: SolEd25519Authorisation, sig: any): SolEd25519Authorisation => ({ ...a, sig });

const signerA = solSoftwareSigner(rnd(32));
const recA = await deriveSolBlind(signerA, { network: 'undeployed', accountIndex: 0 });
const devA = SolEd25519Device.fromSigner(signerA, recA);
const signerB = solSoftwareSigner(rnd(32));
const devB = SolEd25519Device.fromSigner(signerB, await deriveSolBlind(signerB, { network: 'undeployed', accountIndex: 0 }));

// ── 1. Positive control and the state transition ────────────────────────────
const G1 = '1 positive control';
const sim = await deploy(devA);
const k1 = rnd(32);
const before = ledgerOf(sim.state);
const a1 = await authoriseSolDevice(devA, ctxOf(sim), SITE, { op: 'rotate_enc_key', newKey: k1 }, 0n);
ok(G1, 'authArgs routes through the signer.ts registry entry', JSON.stringify(authArgs(a1), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) === JSON.stringify(solEd25519AuthArgs(a1), (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
await rotate(sim, k1, a1);
const after = ledgerOf(sim.state);
ok(G1, 'rotate lands: enc_key set, auth_nonce +1, round +1, entry rolled 0 -> 1, one device', hex(after.enc_key) === hex(k1)
  && after.auth_nonce === before.auth_nonce + 1n && after.round > before.round && after.device_count === 1n
  && !after.devices.member(devA.entryAt(sim.bytes, after.device_epoch, 0n)) && after.devices.member(devA.entryAt(sim.bytes, after.device_epoch, 1n)));
ok(G1, 'the signed message is the raw head, then the contract\'s own text (50 + 491, format sol v1)', a1.message.length === 50 + 491 && Buffer.from(a1.message.subarray(0, 50)).toString('latin1') === SOL_RAW_HEAD && Buffer.from(a1.message.subarray(50)).toString('latin1') === a1.text && a1.text.startsWith('Midnight Passport approval (sol v1)\nOperation: Rotate the encryption key\n'));

// An attacker who changes executed values supplies display inputs that are
// CONSISTENT with them (otherwise the display check refuses first); the
// signature is the one the wallet gave. `exec` builds exactly that call.
const exec = (target: Sim, newKey: Uint8Array, a: SolEd25519Authorisation, opt: { site?: string; key?: Uint8Array } = {}) => {
  const { showArgs } = solDeviceMessageCircuit(opt.key ?? devA.key, ctxOf(target), opt.site ?? SITE, { op: 'rotate_enc_key', newKey });
  return rotate(target, newKey, { ...a, showArgs });
};

// ── 2. Binding: one signed value changed at execution ────────────────────────
const G2 = '2 binding';
const ctx = ctxOf(sim); // auth_nonce 1, counter 1
const k2 = rnd(32);
const a2 = await authoriseSolDevice(devA, ctx, SITE, { op: 'rotate_enc_key', newKey: k2 }, 1n);
await refused(G2, 'another new key at execution (consistent display inputs)', 'runtime', /invalid signature/, () => exec(sim, rnd(32), a2));
await refused(G2, 'another site label at execution (consistent display inputs)', 'runtime', /invalid signature/, () => exec(sim, k2, a2, { site: 'Another site' }));
await refused(G2, "device B's signature presented with A's key", 'runtime', /invalid signature/, async () => {
  const b = await authoriseSolDevice(devB, ctx, SITE, { op: 'rotate_enc_key', newKey: k2 }, 1n);
  return exec(sim, k2, withSig(a2, b.sig));
});
await refused(G2, 'device B presents its own key (no entry in this account)', 'runtime', /unknown device entry/, async () =>
  rotate(sim, k2, await authoriseSolDevice(devB, ctx, SITE, { op: 'rotate_enc_key', newKey: k2 }, 0n)));
await refused(G2, 'another use counter', 'runtime', /unknown device entry/, () => exec(sim, k2, { ...a2, use_counter: 2n }));
await refused(G2, 'another blind', 'runtime', /unknown device entry/, () => exec(sim, k2, { ...a2, blind: rnd(32) }));
await refused(G2, 'the signature of another operation (append_inbox) over the same nonce', 'runtime', /invalid signature/, async () => {
  const other = await authoriseSolDevice(devA, ctx, SITE, { op: 'append_inbox', entry: rnd(192) }, 1n);
  return exec(sim, k2, withSig(a2, other.sig));
});
const G2b = '2b display inputs inconsistent with the executed values';
await refused(G2b, 'nonce digits of another value', 'runtime', /digits do not match/, () => rotate(sim, k2, { ...a2, showArgs: [solShow(SITE, 2n), a2.showArgs[1], a2.showArgs[2]] }));
await refused(G2b, 'hex nibbles of the signed key while another key executes', 'runtime', /hex digits do not match/, () => rotate(sim, rnd(32), a2));
// The frame (account, signing key) is the seam's; foreign frame nibbles are refused.
await refused(G2b, 'frame nibbles of another account', 'runtime', /hex digits do not match/, () => rotate(sim, k2, { ...a2, showArgs: [a2.showArgs[0], solFrameNibbles(rnd(32), devA.key), a2.showArgs[2]] }));
await refused(G2b, "the frame's base58 text of another device's key", 'runtime', /base58 digits do not match|base58 carry hints|leading base58 ones/, () => rotate(sim, k2, { ...a2, showArgs: [a2.showArgs[0], solFrameNibbles(sim.bytes, devB.key), a2.showArgs[2]] }));
// The wallet signed the message of exactly this call, but
// showing a foreign account (its frame nibbles with it); the honest call
// lands at the end of group 4 (positive control)
await refused(G2b, 'the wallet signed a message showing a foreign account (its frame nibbles with it): the seam\'s frame check', 'runtime', /hex digits do not match/, async () =>
  rotate(sim, k2, await authoriseSolDevice(devA, { ...ctx, contractAddress: rnd(32) }, SITE, { op: 'rotate_enc_key', newKey: k2 }, 1n)));

// ── 3. Replay ───────────────────────────────────────────────────────────────
const G3 = '3 replay';
await refused(G3, 'the landed authorisation again (consumed entry)', 'runtime', /unknown device entry/, () => exec(sim, k1, a1));
await refused(G3, 'the landed signature at the current counter (the message now carries nonce 1)', 'runtime', /invalid signature/, () => exec(sim, k1, { ...a1, use_counter: 1n }));
const sim2 = await deploy(devA); // the same device and blind on another account
const a2b = await authoriseSolDevice(devA, ctxOf(sim2), SITE, { op: 'rotate_enc_key', newKey: k2 }, 0n);
await refused(G3, "another account's signature (same device, same blind, nonce 0)", 'runtime', /invalid signature/, () => exec(sim2, k1, withSig(a2b, a1.sig)));
await rotate(sim2, k2, a2b);
ok(G3, 'the same device rotates the second account with its own approval (positive control)', hex(ledgerOf(sim2.state).enc_key) === hex(k2));

// ── 3b. Cross-arm replay ─────────────────────────────────────────────────────
// What another arm's device signs for the same call (its 32-byte challenge for
// rotate_enc_key on this account, nonce and key), or the arm's own blind
// request, signed raw by this Solana key (a wallet that signs whatever bytes
// it is given), presented to this arm's seam with consistent display inputs:
// refused by the signature, because the seam verifies over the sol v1 bytes
// it renders. The reverse direction has no vector on this branch: no other
// arm verifies Ed25519 (jubjub verifies Schnorr over JubJub, k256 and p256
// ECDSA), so a sol_ed25519 signature cannot even be passed to them.
const G3b = '3b cross-arm replay';
{
  const k = K256Device.generate();
  const pass = softwarePasskey();
  const ctxNow = ctxOf(sim); // auth_nonce 1, counter 1 (a2 is still unused)
  const kCh: Uint8Array = k256Challenges.rotateEncKey(ctxNow, k.pk, k2);
  const pCh: Uint8Array = p256Challenges.rotateEncKey(ctxNow, pass.pk, k2);
  const blindReq = solBlindMessage(devA.key, { network: 'undeployed', accountIndex: 0 }).bytes;
  for (const [name, bytes] of [
    ['the k256 arm\'s rotate_enc_key challenge (same account, nonce, key), signed by the Solana key', kCh],
    ['the p256 arm\'s rotate_enc_key challenge (same account, nonce, key), signed by the Solana key', pCh],
    ['the arm\'s own blind request (non-authorising), signed by the same key', blindReq],
  ] as [string, Uint8Array][]) {
    const { sig } = await devA.signBytes(bytes);
    await refused(G3b, name, 'runtime', /invalid signature/, () => exec(sim, k2, withSig(a2, sig)));
  }
  ok(G3b, 'positive control: the same key\'s sol v1 approval for that call is a different message', !Buffer.from(a2.message).equals(Buffer.from(kCh)) && a2.message.length === 50 + 491);
}

// ── 4. Degenerate signatures ────────────────────────────────────────────────
const G4 = '4 degenerate signatures';
const sigBytes = (a: SolEd25519Authorisation) => a.sig;
const T8 = ed25519.Point.fromBytes(Buffer.from('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a', 'hex'), false);
const aff = (p: any) => { const q = p.toAffine(); return { x: q.x, y: q.y }; };
await refused(G4, 'R = O (identity commitment)', 'runtime', /R is the identity/, () => rotate(sim, k2, withSig(a2, { r: { x: 0n, y: 1n }, s: sigBytes(a2).s })));
await refused(G4, 'R of small order (8)', 'runtime', /Curve25519Point|type error/i, () => rotate(sim, k2, withSig(a2, { r: aff(T8), s: sigBytes(a2).s })));
await refused(G4, 'R of mixed order (R + T8)', 'runtime', /Curve25519Point|type error/i, () => rotate(sim, k2, withSig(a2, { r: aff(ed25519.Point.fromAffine(sigBytes(a2).r).add(T8)), s: sigBytes(a2).s })));
await refused(G4, 'S + L (the malleated twin)', 'runtime', /Curve25519Scalar|type error/i, () => rotate(sim, k2, withSig(a2, { r: sigBytes(a2).r, s: sigBytes(a2).s + ED25519_L })));
await refused(G4, 'S + L at the client (never reduced)', 'client', /not below L/, () => {
  const raw = new Uint8Array([...ed25519.Point.fromAffine(sigBytes(a2).r).toBytes(), ...(() => { const o = new Uint8Array(32); let x = sigBytes(a2).s + ED25519_L; for (let i = 0; i < 32; i++) { o[i] = Number(x & 0xffn); x >>= 8n; } return o; })()]);
  return decodeSolSignature(raw);
});
await refused(G4, 'a flipped S bit', 'runtime', /invalid signature/, () => rotate(sim, k2, withSig(a2, { r: sigBytes(a2).r, s: sigBytes(a2).s ^ 1n })));
// The honest call still lands afterwards: the refusals changed nothing.
await rotate(sim, k2, a2);
const end = ledgerOf(sim.state);
ok(G4, 'after every refusal the honest call lands (state untouched by the refusals)', hex(end.enc_key) === hex(k2) && end.auth_nonce === 2n
  && end.devices.member(devA.entryAt(sim.bytes, end.device_epoch, 2n)));


// ── 5. The verification's checked inputs ────────────────────────────────────
const G5 = '5 verification inputs';
{
  const seedC = rnd(32);
  const signerC = solSoftwareSigner(seedC);
  const devC = SolEd25519Device.fromSigner(signerC, await deriveSolBlind(signerC, { network: 'undeployed', accountIndex: 0 }));
  const simC = await deploy(devC);
  const kC = rnd(32);
  const aC = await authoriseSolDevice(devC, ctxOf(simC), SITE, { op: 'rotate_enc_key', newKey: kC }, 0n);
  const raw = await signerC.sign(aC.message);
  const hintsC = solSignatureHints(aC.sig);
  const le = (v: bigint) => Array.from({ length: 32 }, (_, i) => (v >> BigInt(8 * i)) & 0xffn);
  ok(G5, "the client's inputs: R's encoding equals the signature's first 32 bytes, and R's x bytes its x-coordinate",
    hintsC.r_bytes.every((b, i) => b === BigInt(raw[i])) && hintsC.r_x.every((b, i) => b === le(aC.sig.r.x)[i]));
  const keyArgs = authArgs(aC as any).at(-1) as any;
  ok(G5, "the client's inputs: the key's bytes equal the wallet's 32-byte key, and its x bytes the point's x-coordinate",
    keyArgs.pk_bytes.every((b: bigint, i: number) => b === BigInt(devC.key[i])) && keyArgs.pk_x.every((b: bigint, i: number) => b === le(devC.pk.x)[i]));
  const leInt = (b: Uint8Array) => { let v = 0n; for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return v; };
  const h = sha512(seedC).slice(0, 32); h[0] &= 248; h[31] &= 127; h[31] |= 64;
  const secret = leInt(h) % ED25519_L;
  const P = (1n << 255n) - 19n;
  const nonce = (odd?: boolean) => {
    for (;;) {
      const r = leInt(rnd(32)) % ED25519_L;
      if (r === 0n) continue;
      const R = ed25519.Point.BASE.multiply(r).toAffine();
      if (odd !== undefined && ((R.x & 1n) === 1n) !== odd) continue;
      return { r, R, e: Array.from(ed25519.Point.fromAffine(R).toBytes(), (x) => BigInt(x)), x: le(R.x) };
    }
  };
  // s = r + k a with k = SHA-512(e || A || M) mod L: the equation holds for
  // the bytes the circuit hashes, so only the encoding checks can refuse
  const signedOver = (n: ReturnType<typeof nonce>, e: bigint[]) => {
    const k = leInt(sha512(new Uint8Array([...e.map((x) => Number(x & 0xffn)), ...devC.key, ...aC.message]))) % ED25519_L;
    return { r: { x: n.R.x, y: n.R.y }, s: (n.r + k * secret) % ED25519_L };
  };
  const argsWith = (sig: any, r_bytes: bigint[], r_x: bigint[]) => {
    const args = authArgs(aC as any);
    args[args.length - 1] = { ...(args.at(-1) as any), sig, r_bytes, r_x };
    return args;
  };
  // every case below runs on the same state and leaves it unchanged, so a
  // build that wrongly accepts one case cannot change the outcome of the next
  const forged = async (sig: any, r_bytes: bigint[], r_x: bigint[]) => {
    const st = simC.state;
    try { return await call(simC, 'rotate_enc_key_with_sol_ed25519', kC, ...argsWith(sig, r_bytes, r_x)); } finally { simC.state = st; }
  };
  const accepted = async (name: string, n: ReturnType<typeof nonce>) => {
    try { await forged(signedOver(n, n.e), n.e, n.x); ok(G5, name, true); } catch (e: any) { ok(G5, name, false, String(e?.message ?? e).slice(0, 200)); }
  };
  /** A nonce whose R encoding ends in the byte `last` (y's top byte and the
   *  sign bit together). */
  const nonceEnding = (last: bigint) => { for (;;) { const n = nonce(); if (n.e[31] === last) return n; } };
  { const n = nonce(); const e = [...n.e]; e[5] ^= 1n;
    await refused(G5, "R's encoding with one byte flipped, signed over that encoding", 'runtime', /ed25519: the encoding does not match the point's y/, () => forged(signedOver(n, e), e, n.x)); }
  { const n = nonce(); const e = [...n.e]; e[31] ^= 128n;
    await refused(G5, "R's encoding with the sign bit flipped, signed over that encoding", 'runtime', /ed25519: the sign bit is not x's parity/, () => forged(signedOver(n, e), e, n.x)); }
  { const n = nonce(true); const e = le((n.R.y + P) & ((1n << 256n) - 1n));
    await refused(G5, "R's encoding as y + p, signed over that encoding", 'runtime', /ed25519: the encoding does not match the point's y/, () => forged(signedOver(n, e), e, n.x)); }
  { const n = nonce(); const x = [...n.x]; x[7] ^= 1n;
    await refused(G5, "R's x bytes with one byte flipped", 'runtime', /ed25519: the x bytes do not match the point's x/, () => forged(signedOver(n, n.e), n.e, x)); }
  { const n = nonce(); const x = le(n.R.x + P);
    await refused(G5, "R's x bytes as x + p", 'runtime', /ed25519: the x bytes do not match the point's x/, () => forged(signedOver(n, n.e), n.e, x)); }
  { const n = nonce(); const e = [...n.e]; const i = e.findIndex((_, j) => j > 0 && j < 30 && e[j + 1] > 0n); e[i] += 256n; e[i + 1] -= 1n;
    await refused(G5, "R's encoding with the carry attack (a byte of 256, its neighbour minus one)", 'runtime', /type error/, () => forged(signedOver(n, n.e), e, n.x)); }
  // the signing key's byte inputs: the seam's derivation checks them against
  // the key's point before anything else uses them
  const withKey = async (pk_bytes: bigint[], pk_x: bigint[]) => {
    const st = simC.state;
    const args = authArgs(aC as any);
    args[args.length - 1] = { ...(args.at(-1) as any), pk_bytes, pk_x };
    try { return await call(simC, 'rotate_enc_key_with_sol_ed25519', kC, ...args); } finally { simC.state = st; }
  };
  { const b = [...keyArgs.pk_bytes]; b[9] ^= 4n;
    await refused(G5, "the key's bytes with one byte flipped", 'runtime', /ed25519: the encoding does not match the point's y/, () => withKey(b, keyArgs.pk_x)); }
  { const b = [...keyArgs.pk_bytes]; b[31] ^= 128n;
    await refused(G5, "the key's bytes with the sign bit flipped", 'runtime', /ed25519: the sign bit is not x's parity/, () => withKey(b, keyArgs.pk_x)); }
  { const x = [...keyArgs.pk_x]; x[20] ^= 1n;
    await refused(G5, "the key's x bytes with one byte flipped", 'runtime', /ed25519: the x bytes do not match the point's x/, () => withKey(keyArgs.pk_bytes, x)); }
  { const b = [...keyArgs.pk_bytes]; const i = b.findIndex((_, j) => j > 0 && j < 30 && b[j + 1] > 0n); b[i] += 256n; b[i + 1] -= 1n;
    await refused(G5, "the key's bytes with the carry attack (a byte of 256, its neighbour minus one)", 'runtime', /type error/, () => withKey(b, keyArgs.pk_x)); }
  // the sign bit's boundary: a last byte of exactly 128 (y's top byte 0, x
  // odd) and of exactly 127 (y's top byte 127, x even)
  await accepted("an honest signature whose R encoding ends in the byte 128 (y's top byte 0, x odd) is accepted", nonceEnding(128n));
  await accepted("an honest signature whose R encoding ends in the byte 127 (y's top byte 127, x even) is accepted", nonceEnding(127n));
  {
    const n = nonce(); let why = '';
    try { await call(simC, 'rotate_enc_key_with_sol_ed25519', kC, ...argsWith(signedOver(n, n.e), n.e, n.x)); } catch (e: any) { why = String(e?.message ?? e).slice(0, 200); }
    ok(G5, "a signature from the test's own nonce over the honest encoding lands after every refusal", !why && ledgerOf(simC.state).auth_nonce === 1n && hex(ledgerOf(simC.state).enc_key) === hex(kC), why || undefined);
  }
}


// ── 6. The two signing formats ──────────────────────────────────────────────
// The same key and blind (one enrolled device) sign the same approval text
// raw (the raw head, then the text) or as an off-chain message v1 (the
// envelope naming the key, then the text); the authorisation's private flag
// `offchain` names the format.
const G6 = '6 signing formats';
{
  const devOff = new SolEd25519Device({ publicKey: devA.key, blind: devA.blind, signer: signerA, format: 'offchain' });
  const simF = await deploy(devA);
  const kF = rnd(32);
  const aRaw = await authoriseSolDevice(devA, ctxOf(simF), SITE, { op: 'rotate_enc_key', newKey: kF }, 0n);
  const aOff = await authoriseSolDevice(devOff, ctxOf(simF), SITE, { op: 'rotate_enc_key', newKey: kF }, 0n);
  ok(G6, 'the two authorisations carry the same text and differ only in the flag and the signature', aRaw.text === aOff.text && !aRaw.offchain && aOff.offchain
    && JSON.stringify(aRaw.showArgs, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) === JSON.stringify(aOff.showArgs, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    && Buffer.from(aOff.message.subarray(0, 18)).toString('hex') === 'ff736f6c616e61206f6666636861696e0101' && Buffer.from(aOff.message.subarray(18, 50)).equals(Buffer.from(devA.key)));
  // one call from the state, never written back
  const once = async (a: SolEd25519Authorisation) => {
    const ctx = createCircuitContext({ circuitId: 'rotate_enc_key_with_sol_ed25519', contractAddress: simF.address, coinPublicKeyOrZswapState: { bytes: new Uint8Array(32) },
      contractState: simF.state, privateState: simF.ps, time: 1_800_000_000 } as any);
    return simF.contract.impureCircuits.rotate_enc_key_with_sol_ed25519(ctx, kF, ...authArgs(a));
  };
  const J = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? hex(x) : x));
  let rRaw: any, rOff: any;
  try { rRaw = await once(aRaw); ok(G6, 'raw: the call lands', true); } catch (e: any) { ok(G6, 'raw: the call lands', false, String(e?.message ?? e).slice(0, 200)); }
  try { rOff = await once(aOff); ok(G6, 'off-chain message v1: the call lands (same key, same blind, same entry)', true); } catch (e: any) { ok(G6, 'off-chain message v1: the call lands (same key, same blind, same entry)', false, String(e?.message ?? e).slice(0, 200)); }
  if (rRaw && rOff) {
    const pt = (r: any) => J(r.context.callProofDataTrace.at(-1).publicTranscript);
    const out = (r: any) => J(r.context.callProofDataTrace.at(-1).output);
    const after = (r: any) => J(ledger(r.context.callContext.currentQueryContext.state));
    ok(G6, 'from one state, the two formats leave equal public transcripts, outputs, gas and ledger states', pt(rRaw) === pt(rOff) && out(rRaw) === out(rOff)
      && J(rRaw.gasCost) === J(rOff.gasCost) && after(rRaw) === after(rOff), `ops ${rRaw.context.callProofDataTrace.at(-1).publicTranscript.length}`);
  }
  const both = async (name: string, a: SolEd25519Authorisation) => {
    for (const offchain of [false, true]) await refused(G6, `${name}, presented as ${offchain ? 'off-chain' : 'raw'}`, 'runtime', /invalid signature/, () => once({ ...a, offchain }));
  };
  await refused(G6, 'the raw signature presented as off-chain (same key, validly enrolled device)', 'runtime', /invalid signature/, () => once({ ...aRaw, offchain: true }));
  await refused(G6, 'the off-chain signature presented as raw (same key, validly enrolled device)', 'runtime', /invalid signature/, () => once({ ...aOff, offchain: false }));
  const sigOver = async (bytes: Uint8Array) => decodeSolSignature(await signerA.sign(bytes));
  const text = new Uint8Array(Buffer.from(aRaw.text, 'latin1'));
  const otherKey = solSoftwareSigner(rnd(32)).publicKey;
  const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((t, x) => t + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
  await both('the old raw bytes (the text alone) signed by the key', { ...aRaw, sig: await sigOver(text) });
  const another = cat(SOL_OFFCHAIN_DOMAIN, Uint8Array.of(1, 1), otherKey, text);
  await refused(G6, 'an off-chain envelope naming another signer: the client refuses to build or accept it', 'client', /names another signer/, () => assertSolOffchainMessage(another, devA.key));
  await both('an off-chain envelope naming another signer, signed by the key', { ...aRaw, sig: await sigOver(another) });
  const v0 = cat(SOL_OFFCHAIN_DOMAIN, Uint8Array.of(0), new Uint8Array(32), Uint8Array.of(0, 1), devA.key, Uint8Array.of(text.length & 0xff, text.length >> 8), text);
  await refused(G6, 'an off-chain message v0: the client refuses it', 'client', /version 0/, () => assertSolOffchainMessage(v0, devA.key));
  await both('an off-chain message v0 of the text, signed by the key', { ...aRaw, sig: await sigOver(v0) });
  const rawFlip = solSignedMessage('raw', devA.key, text); rawFlip[20] ^= 0x01;
  await both('the raw head with one byte changed, signed by the key', { ...aRaw, sig: await sigOver(rawFlip) });
  const offVer = solSignedMessage('offchain', devA.key, text); offVer[16] = 0;
  await both('the off-chain head with version 0, signed by the key', { ...aRaw, sig: await sigOver(offVer) });
  const offDom = solSignedMessage('offchain', devA.key, text); offDom[3] ^= 0x20;
  await both('the off-chain head with a signing-domain byte changed, signed by the key', { ...aRaw, sig: await sigOver(offDom) });
  await refused(G6, 'off-chain: another new key at execution (consistent display inputs)', 'runtime', /invalid signature/, () => exec(simF, rnd(32), aOff));
  await refused(G6, 'off-chain: a flipped S bit', 'runtime', /invalid signature/, () => once({ ...aOff, sig: { r: aOff.sig.r, s: aOff.sig.s ^ 1n } }));
  await rotate(simF, kF, aOff);
  ok(G6, 'the off-chain approval lands after every refusal (state untouched by the refusals)', hex(ledgerOf(simF.state).enc_key) === hex(kF) && ledgerOf(simF.state).auth_nonce === 1n);
}


const failed = cases.filter((c) => c.verdict !== 'PASS');
for (const g of [...new Set(cases.map((c) => c.group))]) {
  const cs = cases.filter((c) => c.group === g);
  console.log(`  ${cs.every((c) => c.verdict === 'PASS') ? '✓' : '✗'} ${g}: ${cs.filter((c) => c.verdict === 'PASS').length}/${cs.length}`);
}
const verdict = failed.length ? 'FAIL' : 'PASS';
if (process.env.EVIDENCE_DIR) {
  fs.mkdirSync(process.env.EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.EVIDENCE_DIR, 'sol-ed25519-seam-offline.json'), JSON.stringify({ suite: 'sol-ed25519-seam-offline', ranAt: new Date().toISOString(), cases, verdict }, null, 2) + '\n');
}
console.log(`\n◆ sol-ed25519-seam-offline: ${verdict} (${cases.length} cases, ${failed.length} failed)`);
process.exit(verdict === 'PASS' ? 0 : 1);
