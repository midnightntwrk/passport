// P2 — the composed direct transfer (the experiment's headline probe).
//
// One client-composed transaction carrying two contract calls:
//
//   call 1: A.spend_to_contract(B, color, 150)   — emits a shielded output
//           whose recipient is contract B's address
//   call 2: B.deposit_stateless(sent, blob)      — claims exactly that coin
//           (receiveShielded) and records the encrypted discovery blob
//
// Pipeline (from the midnight-js-contracts public API):
//   createUnprovenCallTx(A-call) → private.result[0] = the `sent` coin
//   createUnprovenCallTx(B-call) with that coin
//   unprovenA.merge(unprovenB)   → one two-call UnprovenTransaction
//   submitTx(providers, { unprovenTx, circuitId: [both] })
//     — proves both calls, wallet-balances fees, submits
//
// Node ACCEPT + B inbox grown + A round bumped ⇒ direct contract-to-contract
// transfer works on the current stack with client-side composition (no
// Compact cross-contract calls involved). The privacy cost (one transaction
// naming both contract addresses) is accepted by design and measured in P3.
//
// Every stage records evidence; the probe stops at the first hard gap with
// the exact error, per the experiment guideline.

import { createUnprovenCallTx, submitTx } from '@midnight-ntwrk/midnight-js-contracts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runScenario, step, sleep } from './runner.js';
import { writeEvidence, serialiseError } from './evidence.js';
import { pairSetup, fundA } from './flow.js';
import { compiledC2CContract } from '../node/setup.js';
import { encryptCoinBlob } from '../wallet/coinstore.js';
import { bytesToHex, hexToBytes } from '../wallet/hex.js';

const COLOR_SEED = '0'.repeat(62) + '43';
const FUND = 400n;
const TRANSFER = 150n;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTEXT_FILE = path.resolve(__dirname, '..', '..', 'evidence', 'p2-context.json');

await runScenario('p2-composed-transfer', async () => {
  const details: Record<string, unknown> = {};
  const stages: Array<{ stage: string; ok: boolean; error?: unknown }> = [];
  const stage = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
    step(name);
    try {
      const v = await fn();
      stages.push({ stage: name, ok: true });
      return v;
    } catch (e: any) {
      stages.push({ stage: name, ok: false, error: serialiseError(e) });
      details.stages = stages;
      writeEvidence({
        testId: 'P2',
        name: 'composed-transfer',
        description: 'Client-composed two-call transaction: A.spend_to_contract + B.deposit_stateless',
        verdict: 'FAIL',
        errorCode: `blocked-at:${name}`,
        note: `Composition blocked at stage "${name}" — error recorded verbatim in details.`,
        details,
      });
      throw e;
    }
  };

  // ── Setup and funding ──────────────────────────────────────────────────────

  const s = await stage('setup: deploy A and B, fund A (mint → deposit → capture)', async () => {
    const setup = await pairSetup();
    await fundA(setup, COLOR_SEED, FUND);
    return setup;
  });
  details.custodyA = s.custodyA.address;
  details.custodyB = s.custodyB.address;

  const store = await s.custodyA.coinStore();
  const colorHex = Object.keys(store.coins)[0];
  const color = hexToBytes(colorHex);
  details.color = colorHex;

  // ── Call 1: A.spend_to_contract, unproven ─────────────────────────────────

  // The level private-state provider scopes state per contract address and
  // createUnprovenCallTx does not switch it (the callTx handles do). Point it
  // at the right contract before each build.
  const pointAt = async (address: string) => {
    const p = s.ctx.providers.privateStateProvider;
    if (typeof p.setContractAddress === 'function') await p.setContractAddress(address);
  };

  await pointAt(s.custodyA.address);
  const callA: any = await stage('build unproven call: A.spend_to_contract(B, color, 150)', () =>
    (createUnprovenCallTx as any)(
      s.ctx.providers,
      {
        compiledContract: compiledC2CContract(),
        circuitId: 'spend_to_contract',
        contractAddress: s.custodyA.address,
        // ContractAddress circuit argument is a struct { bytes: Bytes<32> }.
        args: [{ bytes: hexToBytes(s.custodyB.address.replace(/^0x/, '')) }, color, TRANSFER],
        privateStateId: s.custodyA.privateStateId,
      },
    ),
  );

  const sent: any = await stage('extract the `sent` coin from the circuit result', () => {
    const result = callA?.private?.result;
    if (!Array.isArray(result) || !result[0]?.nonce) {
      throw new Error(
        `circuit result surface unexpected: ${JSON.stringify(Object.keys(callA?.private ?? {}))} ` +
        `(result=${typeof result})`,
      );
    }
    return result[0];
  });
  details.sent = { nonce: bytesToHex(sent.nonce), color: bytesToHex(sent.color), value: String(sent.value) };
  details.change = Array.isArray(callA?.private?.result) && callA.private.result[1]?.is_some
    ? { value: String(callA.private.result[1].value.value) }
    : null;
  console.log(`  sent coin: value=${sent.value} nonce=${bytesToHex(sent.nonce).slice(0, 16)}…`);

  // ── Call 2: B.deposit_stateless, unproven ─────────────────────────────────

  const blob = encryptCoinBlob(s.encKeysB.publicKey, {
    nonce: sent.nonce,
    color: sent.color,
    value: sent.value,
  });

  await pointAt(s.custodyB.address);
  const callB: any = await stage('build unproven call: B.deposit_stateless(sent, blob)', () =>
    (createUnprovenCallTx as any)(
      s.ctx.providers,
      {
        compiledContract: compiledC2CContract(),
        circuitId: 'deposit_stateless',
        contractAddress: s.custodyB.address,
        args: [{ nonce: sent.nonce, color: sent.color, value: sent.value }, blob],
        privateStateId: s.custodyB.privateStateId,
      },
    ),
  );

  // ── Compose into one transaction ──────────────────────────────────────────
  //
  // NOT Transaction.merge: a plain merge concatenates both txs' zswap offers,
  // and B's SDK-built tx carries its own copy of the 150→B output (that is
  // how a normal wallet deposit is funded), duplicating the output A's
  // circuit already emitted — the merged offer is then 150 short and the
  // wallet balancer rejects with InsufficientFunds (recorded in the previous
  // run's evidence). Instead: shielded offers live at TRANSACTION level in
  // the v8 model while contract calls live in INTENTS — so graft B's intent
  // (the deposit call with its claim effect) onto A's transaction, whose
  // offer (in 400 → out 150→B + 250→change-A) is already balanced.

  const merged: any = await stage('graft B’s call intent onto A’s transaction', () => {
    const txA = callA?.private?.unprovenTx;
    const txB = callB?.private?.unprovenTx;
    if (!txA || !txB) throw new Error('unprovenTx missing from UnsubmittedCallTxData.private');

    const intentsB: any = txB.intents;
    details.intentSurfaces = {
      intentsBType: intentsB?.constructor?.name ?? typeof intentsB,
      isMap: intentsB instanceof Map,
      size: intentsB instanceof Map ? intentsB.size : Array.isArray(intentsB) ? intentsB.length : null,
    };
    let intentB: any;
    if (intentsB instanceof Map) intentB = [...intentsB.values()][0];
    else if (Array.isArray(intentsB)) intentB = intentsB[0];
    else if (intentsB && typeof intentsB.values === 'function') intentB = [...intentsB.values()][0];
    if (!intentB) {
      throw new Error(`cannot extract B's intent: intents surface = ${JSON.stringify(details.intentSurfaces)}`);
    }
    (details.intentSurfaces as any).intentBType = intentB?.constructor?.name;

    // addIntent(segment: SegmentSpecifier, intent) — 'random' is documented
    // as "ideal for merging with other intents".
    const grafted = txA.addIntent({ tag: 'random' }, intentB);
    return grafted ?? txA;
  });
  console.log(`  composed: ${merged?.constructor?.name}`);

  await stage('diagnose the merged transaction (offers, segments, imbalances)', () => {
    const diag: Record<string, unknown> = {};
    const describeOffer = (o: any) =>
      o
        ? {
            inputs: o.inputs?.length ?? null,
            outputs: o.outputs?.length ?? null,
            transients: o.transients?.length ?? null,
            deltas: (() => { try { return String(o.deltas?.size ?? o.deltas); } catch { return 'n/a'; } })(),
          }
        : null;
    try { diag.guaranteedOffer = describeOffer(merged.guaranteedOffer); } catch (e: any) { diag.guaranteedOffer = `threw: ${e?.message}`; }
    try { diag.fallibleOffer = describeOffer(merged.fallibleOffer); } catch (e: any) { diag.fallibleOffer = `threw: ${e?.message}`; }
    try {
      const actions = merged.contractCalls ?? merged.actions ?? null;
      diag.calls = actions ? String(actions.length ?? actions) : 'n/a';
    } catch (e: any) { diag.calls = `threw: ${e?.message}`; }
    for (const seg of [0, 1, 2]) {
      try {
        const im = merged.imbalances(seg);
        diag[`imbalances(seg ${seg})`] = (() => {
          try {
            const entries: string[] = [];
            im.forEach?.((v: any, k: any) => entries.push(`${String(k).slice(0, 18)}…=${v}`));
            return entries.length ? entries : String(im);
          } catch { return String(im); }
        })();
      } catch (e: any) { diag[`imbalances(seg ${seg})`] = `threw: ${e?.message}`; }
    }
    try {
      diag.identifiersCount = merged.identifiers?.()?.length ?? null;
    } catch { /* diagnostic only */ }
    details.mergedDiagnostics = diag;
    console.log('  merged diagnostics:', JSON.stringify(diag, (_k, v) => typeof v === 'bigint' ? String(v) : v).slice(0, 800));
  });

  // ── Prove (both circuits), balance, submit ─────────────────────────────────

  const finalized: any = await stage('submitTx: prove both circuits, balance, submit', () =>
    (submitTx as any)(s.ctx.providers, {
      unprovenTx: merged,
      circuitId: ['spend_to_contract', 'deposit_stateless'],
    }),
  );
  const composedTxId = finalized?.txId ?? finalized?.transactionHash;
  details.composedTxId = composedTxId;
  details.finalizedStatus = finalized?.status ?? null;
  console.log(`  composed tx: ${composedTxId} (${finalized?.status})`);

  // ── Post-conditions ────────────────────────────────────────────────────────

  await stage('post-conditions: B inbox grew, A round bumped', async () => {
    await sleep(10_000);
    const ledgerB = await s.custodyB.ledgerState();
    const ledgerA = await s.custodyA.ledgerState();
    details.post = {
      bInboxCount: String(ledgerB.inbox_count),
      bRound: String(ledgerB.round),
      aRound: String(ledgerA.round),
    };
    if (ledgerB.inbox_count !== 1n) {
      throw new Error(`B.inbox_count = ${ledgerB.inbox_count}, expected 1 — claim did not land`);
    }
    // A: deposit (1) + spend_to_contract (2).
    if (ledgerA.round !== 2n) {
      throw new Error(`A.round = ${ledgerA.round}, expected 2`);
    }
  });

  // ── Context for P3 ─────────────────────────────────────────────────────────

  fs.mkdirSync(path.dirname(CONTEXT_FILE), { recursive: true });
  fs.writeFileSync(
    CONTEXT_FILE,
    JSON.stringify(
      {
        composedTxId,
        custodyA: s.custodyA.address,
        custodyB: s.custodyB.address,
        color: colorHex,
        sent: details.sent,
        encKeysB: {
          publicKeyHex: bytesToHex(s.encKeysB.publicKey),
          secretKeyHex: bytesToHex(s.encKeysB.secretKey),
        },
        writtenAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`  context for P3 → ${CONTEXT_FILE}`);

  details.stages = stages;
  writeEvidence({
    testId: 'P2',
    name: 'composed-transfer',
    description: 'Client-composed two-call transaction: A.spend_to_contract + B.deposit_stateless',
    verdict: 'PASS',
    note:
      `Node accepted composed tx ${composedTxId}: contract A paid contract B directly in one transaction ` +
      '(client-side composition, no Compact cross-contract calls). B claimed the coin and recorded the blob.',
    details,
  });
});
