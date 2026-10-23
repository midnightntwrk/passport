// Arm `sol_ed25519`: the custody circuits, offline (the generated JavaScript,
// no proof server, no node): `append_inbox_with_sol_ed25519`,
// `withdraw_unshielded_with_sol_ed25519`, `withdraw_shielded_with_sol_ed25519`
// and `withdraw_shielded_to_contract_with_sol_ed25519`.
//
// For each circuit: a positive control (the state transition checked), the
// binding of every shown operand (changed at execution with display inputs
// consistent with the executed value, as an attacker would supply them:
// refused by the signature), display inputs inconsistent with the executed
// value (refused by the display check), and, on the two shielded spends,
// witness substitution: a valid signature over one coin while the
// `held_coin` witness returns another (colour, value, nonce, Merkle index).
// A substituted colour is the case only the export's own
// `coin.color == color` assert can refuse: the message shows the
// approved colour, so the signature still verifies.
//
// Every circuit also refuses an approval the wallet signed over a message
// showing a FOREIGN account (its frame nibbles with it): only the seam's frame
// check can refuse it, and the honest call then lands.
//
// The same cases at the constraint level (the generated JavaScript checks
// bypassed, the proof server refusing) are in `npm run test:sol-ed25519`.
//
// Writes $EVIDENCE_DIR/sol-ed25519-custody-offline.json when EVIDENCE_DIR is set.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createCircuitContext, createConstructorContext, sampleContractAddress } from '@midnight-ntwrk/compact-runtime';

import { Contract, ledger } from '../wallet/contract.js';
import { makeWitnesses, emptyCoinStore, withCoin, type CoinStorePrivateState } from '../wallet/witnesses.js';
import { JubjubDevice, authArgs } from '../wallet/signer.js';
import {
  SolEd25519Device, authoriseSolDevice, deriveSolBlind, solSoftwareSigner, solDeviceMessageCircuit,
  type SolEd25519Authorisation,
} from '../wallet/signer-sol-ed25519.js';
import { solFrameNibbles, solShow, type SolAmount, type SolCoin, type SolDeviceOperation } from '../wallet/sol-ed25519-message.js';

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
const SITE = 'Custody test';

interface Sim { contract: any; state: any; ps: CoinStorePrivateState; address: string; bytes: Uint8Array; coinPk: { bytes: Uint8Array } }
const ledgerOf = (s: any) => ledger(s?.constructor?.name === 'ContractState' ? s.data : s);
async function call(sim: Sim, circuit: string, ...args: unknown[]) {
  const ctx = createCircuitContext({ circuitId: circuit, contractAddress: sim.address, coinPublicKeyOrZswapState: sim.coinPk, contractState: sim.state, privateState: sim.ps, time: 1_800_000_000 } as any);
  const r = await sim.contract.impureCircuits[circuit](ctx, ...args);
  sim.state = r.context.callContext.currentQueryContext.state;
  return r.result;
}
async function deploy(device: SolEd25519Device): Promise<Sim> {
  const contract = new (Contract as any)(makeWitnesses());
  const ps = emptyCoinStore();
  const salt = rnd(32);
  const coinPk = { bytes: rnd(32) };
  const init = await contract.initialState(createConstructorContext(ps, coinPk), device.bootCommitment(salt), rnd(32), JubjubDevice.generate().pk, new Uint8Array(64), 259200n);
  const address = sampleContractAddress();
  const sim: Sim = { contract, state: init.currentContractState, ps, address, bytes: new Uint8Array(Buffer.from(address.replace(/^0x/, ''), 'hex')), coinPk };
  await call(sim, 'activate_initial_device_with_sol_ed25519', ...device.activationArgs(salt));
  return sim;
}
const ctxOf = (sim: Sim) => ({ contractAddress: sim.bytes, authNonce: ledgerOf(sim.state).auth_nonce as bigint });
const counterOf = (sim: Sim, d: SolEd25519Device) => {
  const l = ledgerOf(sim.state);
  for (let k = 0n; k < 64n; k++) if (l.devices.member(d.entryAt(sim.bytes, l.device_epoch, k))) return k;
  throw new Error('no live entry');
};
const auth = (sim: Sim, d: SolEd25519Device, o: SolDeviceOperation) => authoriseSolDevice(d, ctxOf(sim), SITE, o, counterOf(sim, d));
/** The display inputs of `o` as an attacker supplies them for the values it
 *  executes (consistent, so only the signature can refuse). */
const shownFor = (sim: Sim, d: SolEd25519Device, o: SolDeviceOperation) => solDeviceMessageCircuit(d.key, ctxOf(sim), SITE, o).showArgs;
const withShow = (a: SolEd25519Authorisation, showArgs: unknown[]): SolEd25519Authorisation => ({ ...a, showArgs });
/** The wallet's approval of exactly `o`, but over a message showing a foreign
 *  account (its frame nibbles with it): only the seam's frame check refuses it. */
const foreign = (sim: Sim, d: SolEd25519Device, o: SolDeviceOperation) => authoriseSolDevice(d, { ...ctxOf(sim), contractAddress: rnd(32) }, SITE, o, counterOf(sim, d));
const FOREIGN = 'the wallet signed a message showing a foreign account (its frame nibbles with it): the seam\'s frame check';

const signer = solSoftwareSigner(rnd(32));
const dev = SolEd25519Device.fromSigner(signer, await deriveSolBlind(signer, { network: 'undeployed', accountIndex: 0 }));
const sim = await deploy(dev);

// ── 1. append_inbox ─────────────────────────────────────────────────────────
const G1 = '1 append_inbox';
{
  const entry = rnd(192);
  const before = ledgerOf(sim.state);
  const a = await auth(sim, dev, { op: 'append_inbox', entry });
  ok(G1, 'the signed message is the contract\'s own bytes (813, all 192 bytes in full hex)', a.message.length === 813
    && a.text.includes(`Inbox entry 1 of 6: ${hex(entry.subarray(0, 32))}\n`) && a.text.includes(`Inbox entry 6 of 6: ${hex(entry.subarray(160))}\n`));
  const other = rnd(192);
  await refused(G1, 'another entry at execution (consistent display inputs)', 'runtime', /invalid signature/, () =>
    call(sim, 'append_inbox_with_sol_ed25519', other, ...authArgs(withShow(a, shownFor(sim, dev, { op: 'append_inbox', entry: other })))));
  await refused(G1, 'another entry at execution with the signed entry\'s hex nibbles', 'runtime', /hex digits do not match/, () =>
    call(sim, 'append_inbox_with_sol_ed25519', other, ...authArgs(a)));
  await refused(G1, 'frame nibbles of another account (the seam owns the frame)', 'runtime', /hex digits do not match/, () =>
    call(sim, 'append_inbox_with_sol_ed25519', entry, ...authArgs(withShow(a, [a.showArgs[0], solFrameNibbles(rnd(32), dev.key), a.showArgs[2]]))));
  await refused(G1, FOREIGN, 'runtime', /hex digits do not match/, async () =>
    call(sim, 'append_inbox_with_sol_ed25519', entry, ...authArgs(await foreign(sim, dev, { op: 'append_inbox', entry }))));
  await call(sim, 'append_inbox_with_sol_ed25519', entry, ...authArgs(a));
  const after = ledgerOf(sim.state);
  ok(G1, 'lands: inbox[count] = entry, inbox_count +1, auth_nonce +1, entry rolled', after.inbox_count === before.inbox_count + 1n
    && hex(after.inbox.lookup(before.inbox_count)) === hex(entry) && after.auth_nonce === before.auth_nonce + 1n
    && after.devices.member(dev.entryAt(sim.bytes, after.device_epoch, 1n)));
  await refused(G1, 'replay of the landed authorisation verbatim (its nonce digits no longer match auth_nonce)', 'runtime', /digits do not match/, () =>
    call(sim, 'append_inbox_with_sol_ed25519', entry, ...authArgs(a)));
  await refused(G1, 'replay of the landed authorisation with display inputs for the current nonce (consumed entry)', 'runtime', /unknown device entry/, () =>
    call(sim, 'append_inbox_with_sol_ed25519', entry, ...authArgs(withShow(a, shownFor(sim, dev, { op: 'append_inbox', entry })))));
}

// ── 2. withdraw_unshielded ───────────────────────────────────────────────────
const G2 = '2 withdraw_unshielded';
{
  const color = rnd(32);
  await call(sim, 'deposit_unshielded', color, 3000n);
  const mirror = () => (ledgerOf(sim.state).unshielded_balances.member(color) ? ledgerOf(sim.state).unshielded_balances.lookup(color) : 0n);
  ok(G2, 'deposit_unshielded (upstream, permissionless) credits the mirror', mirror() === 3000n);
  const to = rnd(32);
  const amount: SolAmount = { color, amount: 1200n, decimals: 2, symbol: 'tDUST' };
  const o: SolDeviceOperation = { op: 'withdraw_unshielded', amount, recipient: to };
  const a = await auth(sim, dev, o);
  ok(G2, 'the message shows the token, the amount (39 digits, no magnitude), the site\'s label and the recipient (600 bytes)', a.message.length === 600
    && a.text.includes(`Token: ${hex(color)}\n`) && a.text.includes('Amount (base units): 1200' + ' '.repeat(35) + '\n')
    && a.text.includes('This site labels it: 12.00 tDUST') && a.text.includes(`To unshielded address: ${hex(to)}\n`));
  const exec = (c: Uint8Array, n: bigint, r: Uint8Array, x: SolEd25519Authorisation) => call(sim, 'withdraw_unshielded_with_sol_ed25519', c, n, { bytes: r }, ...authArgs(x));
  const swap = (p: Partial<{ color: Uint8Array; amount: bigint; to: Uint8Array; decimals: number }>) => {
    const am: SolAmount = { ...amount, color: p.color ?? color, amount: p.amount ?? 1200n, decimals: p.decimals ?? 2 };
    return exec(am.color, am.amount, p.to ?? to, withShow(a, shownFor(sim, dev, { op: 'withdraw_unshielded', amount: am, recipient: p.to ?? to })));
  };
  await refused(G2, 'another token at execution (consistent display inputs)', 'runtime', /invalid signature/, () => swap({ color: rnd(32) }));
  await refused(G2, 'another amount at execution (consistent display inputs)', 'runtime', /invalid signature/, () => swap({ amount: 1201n }));
  await refused(G2, 'another recipient at execution (consistent display inputs)', 'runtime', /invalid signature/, () => swap({ to: rnd(32) }));
  await refused(G2, 'another decimal point in the site\'s label (consistent display inputs)', 'runtime', /invalid signature/, () => swap({ decimals: 3 }));
  await refused(G2, 'another amount with the signed amount\'s digits', 'runtime', /digits do not match/, () => exec(color, 1201n, to, a));
  await refused(G2, 'another recipient with the signed recipient\'s hex nibbles', 'runtime', /hex digits do not match/, () => exec(color, 1200n, rnd(32), a));
  await refused(G2, FOREIGN, 'runtime', /hex digits do not match/, async () => exec(color, 1200n, to, await foreign(sim, dev, o)));
  const before = ledgerOf(sim.state);
  await exec(color, 1200n, to, a);
  ok(G2, 'lands: the mirror debited 3000 -> 1800, auth_nonce +1', mirror() === 1800n && ledgerOf(sim.state).auth_nonce === before.auth_nonce + 1n);
  // Over-withdrawal: signed and shown in full, refused by the shared chip.
  const over = await auth(sim, dev, { op: 'withdraw_unshielded', amount: { ...amount, amount: 5000n }, recipient: to });
  await refused(G2, 'over-withdrawal (5000 of 1800, a valid signature) refused by the shared mirror check', 'runtime', /insufficient|balance|underflow|mirror/i, () => exec(color, 5000n, to, over));
  ok(G2, 'the refused over-withdrawal changed nothing', mirror() === 1800n);
}

// ── 3./4. the shielded spends and witness substitution ───────────────────────
const shielded = async (G: string, circuit: string, op: 'withdraw_shielded' | 'withdraw_shielded_to_contract') => {
  const colA = rnd(32), colB = rnd(32), nonceH = rnd(32);
  const honest = { nonce: nonceH, color: colA, value: 1000n, mtIndex: 7n };
  sim.ps = withCoin(emptyCoinStore(), honest);
  const coin: SolCoin = { nonce: nonceH, color: colA, value: 1000n, mt_index: 7n };
  const to = rnd(32);
  const amount: SolAmount = { color: colA, amount: 300n, decimals: 0, symbol: 'tTOKEN' };
  const o: SolDeviceOperation = { op, amount, recipient: to, coin };
  const a = await auth(sim, dev, o);
  const len = op === 'withdraw_shielded' ? 841 : 851;
  ok(G, `the message shows the coin's colour, value, nonce, Merkle index and the change (${len} bytes)`, a.message.length === len
    && a.text.includes(`Token: ${hex(colA)}\n`) && a.text.includes('Spent coin value: 1000' + ' '.repeat(35) + '\n')
    && a.text.includes(`Spent coin nonce: ${hex(nonceH)}\n`) && a.text.includes('Spent coin index: 7' + ' '.repeat(19) + '\n')
    && a.text.includes('Change back to this account: 700' + ' '.repeat(36) + '\n'));
  const recipient = (r: Uint8Array) => ({ bytes: r });
  const exec = (x: SolEd25519Authorisation, amt: bigint = 300n, r: Uint8Array = to, c: Uint8Array = colA) => call(sim, circuit, recipient(r), c, amt, ...authArgs(x));
  // The witness answers `w` for the approved colour; the attacker's display
  // inputs match the coin it substitutes (`consistent`), or are the signed
  // coin's (`as signed`).
  const substitute = async (name: string, w: typeof honest, consistent: boolean, re: RegExp) => {
    // held_coin looks the coin up under the APPROVED colour: store it there.
    sim.ps = { ...emptyCoinStore(), coins: { [hex(colA)]: { nonceHex: hex(w.nonce), colorHex: hex(w.color), value: w.value.toString(), mtIndex: w.mtIndex.toString() } } };
    const shown = consistent ? shownFor(sim, dev, { op, amount, recipient: to, coin: { nonce: w.nonce, color: w.color, value: w.value, mt_index: w.mtIndex } }) : a.showArgs;
    await refused(G, name, 'runtime', re, () => exec(withShow(a, shown)));
    sim.ps = withCoin(emptyCoinStore(), honest);
  };
  await substitute('witness coin of colour B (same nonce, value, index): only coin.color == color refuses', { ...honest, color: colB }, true, /held coin colour does not match/);
  await substitute('witness coin of value 999 (display inputs consistent with it)', { ...honest, value: 999n }, true, /invalid signature/);
  await substitute('witness coin of value 999 (the signed coin\'s digits)', { ...honest, value: 999n }, false, /digits do not match/);
  await substitute('witness coin of another nonce (display inputs consistent with it)', { ...honest, nonce: rnd(32) }, true, /invalid signature/);
  await substitute('witness coin of another nonce (the signed coin\'s hex nibbles)', { ...honest, nonce: rnd(32) }, false, /hex digits do not match/);
  await substitute('witness coin at another Merkle index (display inputs consistent with it)', { ...honest, mtIndex: 8n }, true, /invalid signature/);
  await substitute('witness coin at another Merkle index (the signed coin\'s digits)', { ...honest, mtIndex: 8n }, false, /digits do not match/);
  await substitute('witness coin of value 200 below the signed amount 300 (no consistent display inputs exist)', { ...honest, value: 200n }, false, /amount above the spent coin's value/);
  const swap = (amt: bigint, r: Uint8Array) => exec(withShow(a, shownFor(sim, dev, { op, amount: { ...amount, amount: amt }, recipient: r, coin })), amt, r);
  await refused(G, 'another amount at execution (consistent display inputs)', 'runtime', /invalid signature/, () => swap(301n, to));
  await refused(G, 'another recipient at execution (consistent display inputs)', 'runtime', /invalid signature/, () => swap(300n, rnd(32)));
  await refused(G, 'another approved colour at execution (its coin stored too; consistent display inputs)', 'runtime', /invalid signature/, async () => {
    sim.ps = withCoin(withCoin(emptyCoinStore(), honest), { ...honest, color: colB });
    try {
      return await call(sim, circuit, recipient(to), colB, 300n, ...authArgs(withShow(a, shownFor(sim, dev, { op, amount: { ...amount, color: colB }, recipient: to, coin: { ...coin, color: colB } }))));
    } finally { sim.ps = withCoin(emptyCoinStore(), honest); }
  });
  await refused(G, 'the amount above the coin\'s value (a renderer refusal: no change digits exist)', 'client', /does not fit 39 digits|amount above the spent coin's value/, () =>
    auth(sim, dev, { op, amount: { ...amount, amount: 1001n }, recipient: to, coin }));
  await refused(G, FOREIGN, 'runtime', /hex digits do not match/, async () => exec(await foreign(sim, dev, o)));
  // Positive: a partial spend, the change returned to the caller.
  const before = ledgerOf(sim.state);
  const r: any = await exec(a);
  const change = op === 'withdraw_shielded' ? r : r[1];
  const sent = op === 'withdraw_shielded' ? null : r[0];
  ok(G, 'lands: 300 of 1000 sent, change 700 of colour A returned, auth_nonce +1', change?.is_some === true && change.value.value === 700n
    && hex(change.value.color) === hex(colA) && ledgerOf(sim.state).auth_nonce === before.auth_nonce + 1n
    && (sent === null || (sent.value === 300n && hex(sent.color) === hex(colA))));
  // A full spend: no change.
  const full = await auth(sim, dev, { op, amount: { ...amount, amount: 1000n }, recipient: to, coin });
  ok(G, 'a full spend shows change 0', full.text.includes('Change back to this account: 0' + ' '.repeat(38) + '\n'));
  const r2: any = await call(sim, circuit, recipient(to), colA, 1000n, ...authArgs(full));
  const change2 = op === 'withdraw_shielded' ? r2 : r2[1];
  ok(G, 'a full spend lands with no change', change2?.is_some === false);
};
await shielded('3 withdraw_shielded', 'withdraw_shielded_with_sol_ed25519', 'withdraw_shielded');
await shielded('4 withdraw_shielded_to_contract', 'withdraw_shielded_to_contract_with_sol_ed25519', 'withdraw_shielded_to_contract');

const failed = cases.filter((c) => c.verdict !== 'PASS');
for (const g of [...new Set(cases.map((c) => c.group))]) {
  const cs = cases.filter((c) => c.group === g);
  console.log(`  ${cs.every((c) => c.verdict === 'PASS') ? '✓' : '✗'} ${g}: ${cs.filter((c) => c.verdict === 'PASS').length}/${cs.length}`);
}
const verdict = failed.length ? 'FAIL' : 'PASS';
if (process.env.EVIDENCE_DIR) {
  fs.mkdirSync(process.env.EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.EVIDENCE_DIR, 'sol-ed25519-custody-offline.json'), JSON.stringify({ suite: 'sol-ed25519-custody-offline', ranAt: new Date().toISOString(), cases, verdict }, null, 2) + '\n');
}
console.log(`\n◆ sol-ed25519-custody-offline: ${verdict} (${cases.length} cases, ${failed.length} failed)`);
process.exit(verdict === 'PASS' ? 0 : 1);
