// W6 — observer leak audit: stateless path vs the insertCoin control.
//
// The privacy claim is empirical or it is nothing. This probe runs the SAME
// custody lifecycle (deposit 600, spend 200, change 400) twice against one
// contract — once through the public/insertCoin control path, once through
// the stateless path — then scans everything an observer can fetch (raw
// transactions from the indexer, the contract's public state) for the coin
// artefacts: nonce bytes, colour bytes, and value bytes.
//
//   Expected: the CONTROL path leaks nonce/colour/value into contract state
//   (that positive hit also validates the scanner); the STATELESS path
//   shows none of them anywhere observer-visible.
//
// PASS = control leaks where predicted AND stateless shows zero artefacts.

import { runScenario, step, waitForLedger, sleep } from './runner.js';
import { writeEvidence, serialiseError } from './evidence.js';
import { standardSetup, mintToUser, depositAndCapture, userCoinPublicKey } from './flow.js';
import { encryptCoinBlob, indexerUrl, type PlainCoin } from '../wallet/coinstore.js';
import { bytesToHex } from '../wallet/hex.js';
import { Buffer } from 'node:buffer';

const SEED_CONTROL = '0'.repeat(62) + '6c';
const SEED_STATELESS = '0'.repeat(62) + '65';

// ── Observer surfaces ───────────────────────────────────────────────────────

/** Fetch every observer-readable representation of a transaction. */
async function fetchTxArtefacts(txId: string): Promise<{ surfaces: Record<string, string>; probes: string[] }> {
  const probes: string[] = [];
  const surfaces: Record<string, string> = {};
  const fieldSets = [
    ['raw', '{ raw }'],
    ['contractActions', '{ contractActions { __typename ... on ContractCall { state } ... on ContractDeploy { state } } }'],
    ['identifiers', '{ identifiers }'],
  ] as const;
  for (const [name, selection] of fieldSets) {
    const query = `
      query($offset: TransactionOffset!) {
        transactions(offset: $offset) ${selection.replace('{', '{ id ')}
      }`.trim();
    try {
      const res = await fetch(indexerUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { offset: { identifier: txId.replace(/^0x/, '') } } }),
      });
      const body: any = await res.json();
      if (body?.errors?.length) {
        probes.push(`${name}: GraphQL error ${JSON.stringify(body.errors[0]?.message ?? '').slice(0, 120)}`);
        continue;
      }
      const t = (body?.data?.transactions ?? [])[0];
      if (!t) { probes.push(`${name}: no tx`); continue; }
      surfaces[name] = JSON.stringify(t);
      probes.push(`${name}: ok (${surfaces[name].length} chars)`);
    } catch (e: any) {
      probes.push(`${name}: fetch failed ${e?.message}`);
    }
  }
  return { surfaces, probes };
}

/** The contract's public state as one observer-visible hex string. */
async function fetchContractStateHex(providers: any, address: string): Promise<string> {
  const state = await providers.publicDataProvider.queryContractState(address);
  if (!state) return '';
  const data: any = state.data;
  if (data instanceof Uint8Array) return Buffer.from(data).toString('hex');
  if (typeof data?.serialize === 'function') return Buffer.from(data.serialize()).toString('hex');
  return Buffer.from(JSON.stringify(data)).toString('hex');
}

// ── Artefact scanner ────────────────────────────────────────────────────────

interface Needles {
  label: string;
  nonceHex: string;
  colorHex: string;
  valueHexBE: string;
  valueHexLE: string;
}

function needlesFor(label: string, coin: PlainCoin): Needles {
  const be = Buffer.alloc(16);
  let v = coin.value;
  for (let i = 15; i >= 0; i--) { be[i] = Number(v & 0xffn); v >>= 8n; }
  const le = Buffer.from(be).reverse();
  return {
    label,
    nonceHex: bytesToHex(coin.nonce),
    colorHex: bytesToHex(coin.color),
    valueHexBE: be.toString('hex'),
    valueHexLE: le.toString('hex'),
  };
}

function scan(haystackHexOrJson: string, needles: Needles): Record<string, boolean> {
  const h = haystackHexOrJson.toLowerCase();
  return {
    nonce: h.includes(needles.nonceHex.toLowerCase()),
    color: h.includes(needles.colorHex.toLowerCase()),
    // 16-byte value windows only (u128); short decimal substrings would
    // false-positive everywhere.
    valueBE: h.includes(needles.valueHexBE.toLowerCase()),
    valueLE: h.includes(needles.valueHexLE.toLowerCase()),
  };
}

await runScenario('w6-leak-audit', async () => {
  const s = await standardSetup();
  const userCpk = await userCoinPublicKey(s.ctx);
  const details: Record<string, unknown> = { custodyAddress: s.custody.address };

  // ── Control lifecycle (insertCoin) ────────────────────────────────────────
  step('control lifecycle: deposit_public 600 → spend_public 200 (change 400 re-inserted)');
  const controlCoin = await mintToUser(s.ctx, s.faucet, SEED_CONTROL, 600n);
  const cDep = await s.custody.depositPublic(controlCoin);
  await waitForLedger(() => s.custody.ledgerState(), 'control coin registered', (l: any) =>
    l.public_coins.member(controlCoin.color),
  );
  const cSpend = await s.custody.spendPublic(userCpk, controlCoin.color, 200n);
  await waitForLedger(() => s.custody.ledgerState(), 'control change re-registered (400)', (l: any) =>
    l.public_coins.member(controlCoin.color) && l.public_coins.lookup(controlCoin.color).value === 400n,
  );

  // ── Stateless lifecycle ───────────────────────────────────────────────────
  step('stateless lifecycle: deposit_stateless 600 → spend_stateless 200 (change 400 via witness)');
  const statelessCoin = await mintToUser(s.ctx, s.faucet, SEED_STATELESS, 600n);
  const sDep = await depositAndCapture(s, statelessCoin);
  const sSpend = await s.custody.spendStateless(userCpk, statelessCoin.color, 200n);
  console.log(`  stateless spend tx ${sSpend.txId}`);
  console.log('  waiting 10s for the indexer...');
  await sleep(10_000);

  // ── Audit ─────────────────────────────────────────────────────────────────
  step('audit every observer surface for coin artefacts');
  const controlNeedles = needlesFor('control', controlCoin);
  const statelessNeedles = needlesFor('stateless', statelessCoin);
  const stateHex = await fetchContractStateHex(s.ctx.providers, s.custody.address);
  details.contractStateBytes = stateHex.length / 2;

  const txSurfaces: Record<string, { surfaces: Record<string, string>; probes: string[] }> = {
    controlDeposit: await fetchTxArtefacts(cDep.txId),
    controlSpend: await fetchTxArtefacts(cSpend.txId),
    statelessDeposit: await fetchTxArtefacts(sDep.depositTx),
    statelessSpend: await fetchTxArtefacts(sSpend.txId),
  };
  details.txFetchProbes = Object.fromEntries(
    Object.entries(txSurfaces).map(([k, v]) => [k, v.probes]),
  );

  const report: Record<string, Record<string, Record<string, boolean>>> = {};
  for (const needles of [controlNeedles, statelessNeedles]) {
    const perSurface: Record<string, Record<string, boolean>> = {
      contractState: scan(stateHex, needles),
    };
    for (const [txLabel, { surfaces }] of Object.entries(txSurfaces)) {
      for (const [surfaceName, payload] of Object.entries(surfaces)) {
        perSurface[`${txLabel}.${surfaceName}`] = scan(payload, needles);
      }
    }
    report[needles.label] = perSurface;
  }
  details.report = report;
  details.needles = { control: controlNeedles, stateless: statelessNeedles };

  const anyHit = (r: Record<string, boolean>) => Object.values(r).some(Boolean);
  // Positive control: the insertCoin path must leak on SOME observer
  // surface (its QSCI travels in the call transcript, so the raw tx and
  // the indexer's per-call state both carry it — `queryContractState().data`
  // is only a state root, not the observer surface).
  const controlLeaks = Object.values(report.control).some(anyHit);
  const statelessHits = Object.entries(report.stateless)
    .filter(([, r]) => anyHit(r))
    .map(([surface, r]) => ({ surface, hits: r }));
  details.controlLeaksInState = controlLeaks;
  details.statelessHits = statelessHits;

  console.log(`  control coin artefacts on observer surfaces: ${controlLeaks ? 'FOUND (as predicted)' : 'NOT FOUND (scanner problem?)'}`);
  console.log(`  stateless coin artefacts anywhere: ${statelessHits.length === 0 ? 'NONE' : JSON.stringify(statelessHits)}`);

  const verdict = controlLeaks && statelessHits.length === 0 ? 'PASS' : 'FAIL';
  writeEvidence({
    testId: 'W6',
    name: 'leak-audit',
    description: 'observer-surface scan: stateless path vs insertCoin control',
    verdict,
    note:
      verdict === 'PASS'
        ? 'The insertCoin control leaks its coin (nonce/colour) into the raw transaction and the ' +
          'indexer per-call state (positive control confirms the scanner); the stateless path ' +
          'shows NO coin artefact on any observer surface scanned. The QSCI-publicity leak is a ' +
          'storage-pattern consequence, not a ledger inevitability.'
        : controlLeaks
          ? 'Stateless path leaked — see details.statelessHits for the exact surface and artefact.'
          : 'The positive control did not register on any observer surface: the scanner or the ' +
            'surface fetching needs work before the stateless claim can be evaluated.',
    details,
  });
  await s.ctx.walletCtx.wallet.stop();
  if (verdict !== 'PASS') throw new Error('leak audit did not pass — see evidence');
});
