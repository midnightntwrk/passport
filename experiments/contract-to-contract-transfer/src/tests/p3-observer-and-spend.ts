// P3 — what did the world see, and can B actually use the money?
//
// Runs against the composed transaction P2 recorded (evidence/p2-context.json).
//
//   (a) Observer audit. Fetch the composed transaction from the indexer and
//       scan every hex surface it exposes for: contract address A, contract
//       address B, the transfer color, the transfer value, and the sent
//       coin's nonce. Expectation (the accepted trade): BOTH ADDRESSES are
//       visible together in one transaction — the counterparty linking
//       MIP-0012's 6.6 one-hop rule exists to avoid — while value, color,
//       and nonce stay hidden (commitment-only, stateless custody).
//
//   (b) Spendability. Reconnect to B with its encryption secret, recover
//       the received coin's mt_index (multi-output tx ⇒ candidate indices
//       from the indexer, tried in order), and spend it from B to a user
//       key. Node accept ⇒ the directly-received coin is a first-class
//       custody coin: discoverable, decryptable, spendable cross-tx.
//
// Verdict PASS requires (b) to land on-chain; (a) is recorded evidence
// either way.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { firstValueFrom } from 'rxjs';

import { runScenario, step, sleep } from './runner.js';
import { writeEvidence, serialiseError } from './evidence.js';
import { setupWallet, connectCustody } from '../node/setup.js';
import { coinPublicKeyBytes } from '../node/wallet.js';
import { emptyCoinStore } from '../wallet/witnesses.js';
import { candidateIndices, decryptCoinBlob, indexerUrl } from '../wallet/coinstore.js';
import { hexToBytes, bytesToHex } from '../wallet/hex.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTEXT_FILE = path.resolve(__dirname, '..', '..', 'evidence', 'p2-context.json');

interface P2Context {
  composedTxId: string;
  custodyA: string;
  custodyB: string;
  color: string;
  sent: { nonce: string; color: string; value: string };
  encKeysB: { publicKeyHex: string; secretKeyHex: string };
}

/** Pull every string that looks like hex out of a JSON-ish object, joined. */
function hexSoup(x: unknown): string {
  const parts: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') parts.push(v.replace(/^0x/, '').toLowerCase());
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(x);
  return parts.join('|');
}

async function fetchTxSurfaces(txId: string): Promise<{ raw: unknown; soup: string }> {
  const query = `
    query Tx($offset: TransactionOffset!) {
      transactions(offset: $offset) {
        id
        hash
        raw
        ... on RegularTransaction {
          startIndex
          endIndex
          identifiers
          contractActions { address state ... on ContractCall { entryPoint } }
          transactionResult { status }
        }
      }
    }
  `.trim();
  const res = await fetch(indexerUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { offset: { identifier: txId.replace(/^0x/, '') } } }),
  });
  const body: any = await res.json();
  if (body?.errors?.length) {
    // Schema drift: retry without the fields most likely to be absent.
    const fallback = query.replace('raw\n', '').replace(/contractActions[^}]+}\s*}/, '');
    const res2 = await fetch(indexerUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: fallback, variables: { offset: { identifier: txId.replace(/^0x/, '') } } }),
    });
    const body2: any = await res2.json();
    const t2 = (body2?.data?.transactions ?? [])[0] ?? { schemaErrors: body.errors };
    return { raw: t2, soup: hexSoup(t2) };
  }
  const t = (body?.data?.transactions ?? [])[0];
  return { raw: t, soup: hexSoup(t) };
}

await runScenario('p3-observer-and-spend', async () => {
  const details: Record<string, unknown> = {};

  if (!fs.existsSync(CONTEXT_FILE)) {
    writeEvidence({
      testId: 'P3',
      name: 'observer-and-spend',
      description: 'Observer audit of the composed tx + B-side spend of the received coin',
      verdict: 'FAIL',
      errorCode: 'no-p2-context',
      note: 'evidence/p2-context.json missing — P2 did not pass; nothing to audit.',
      details,
    });
    throw new Error('P2 context missing — run P2 first');
  }
  const ctx: P2Context = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf8'));
  details.composedTxId = ctx.composedTxId;

  // ── (a) Observer audit ─────────────────────────────────────────────────────

  step('observer audit: scan the composed transaction surfaces');
  const { raw, soup } = await fetchTxSurfaces(ctx.composedTxId);
  const probes: Record<string, { needle: string; found: boolean }> = {
    contractAddressA: { needle: ctx.custodyA.replace(/^0x/, '').toLowerCase(), found: false },
    contractAddressB: { needle: ctx.custodyB.replace(/^0x/, '').toLowerCase(), found: false },
    transferColor: { needle: ctx.color.toLowerCase(), found: false },
    sentNonce: { needle: ctx.sent.nonce.toLowerCase(), found: false },
    transferValueLE16: {
      needle: Buffer.from(
        (() => { const b = Buffer.alloc(16); let v = BigInt(ctx.sent.value); for (let i = 0; i < 16; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; })(),
      ).toString('hex'),
      found: false,
    },
  };
  for (const p of Object.values(probes)) p.found = soup.includes(p.needle);
  details.observer = {
    surfaces: Object.fromEntries(Object.entries(probes).map(([k, v]) => [k, v.found])),
    soupBytes: soup.length,
    txSummary: JSON.parse(JSON.stringify(raw, (_k, v) => (typeof v === 'string' && v.length > 300 ? `${v.slice(0, 64)}…(${v.length})` : v))),
  };
  console.log(
    `  A addr: ${probes.contractAddressA.found ? 'VISIBLE' : 'hidden'} · ` +
    `B addr: ${probes.contractAddressB.found ? 'VISIBLE' : 'hidden'} · ` +
    `color: ${probes.transferColor.found ? 'LEAKED' : 'hidden'} · ` +
    `value: ${probes.transferValueLE16.found ? 'LEAKED' : 'hidden'} · ` +
    `nonce: ${probes.sentNonce.found ? 'LEAKED' : 'hidden'}`,
  );

  // ── (b) B-side spend ───────────────────────────────────────────────────────

  step('reconnect B with its encryption secret and decrypt the inbox');
  const wctx = await setupWallet();
  const encSecret = hexToBytes(ctx.encKeysB.secretKeyHex);
  const custodyB = await connectCustody(wctx, ctx.custodyB, emptyCoinStore(encSecret));
  const ledgerB: any = await custodyB.ledgerState();
  if (ledgerB.inbox_count < 1n) throw new Error('B inbox empty — nothing was received');
  const blob = ledgerB.inbox.lookup(0n);
  const coin = decryptCoinBlob(encSecret, blob);
  details.decryptedInbox = { value: String(coin.value), colorMatches: bytesToHex(coin.color) === ctx.color };
  console.log(`  inbox[0] decrypts to value=${coin.value} (expected ${ctx.sent.value})`);
  if (String(coin.value) !== ctx.sent.value) throw new Error('decrypted inbox coin does not match the sent coin');

  step('recover mt_index (multi-output tx: try candidate indices in order)');
  const { candidates, position } = await candidateIndices(ctx.composedTxId);
  details.mtCandidates = candidates.map(String);
  details.txPosition = { start: position.startIndex, end: position.endIndex, status: position.status };
  console.log(`  candidates: [${candidates.join(', ')}]`);

  const state: any = await firstValueFrom(wctx.walletCtx.wallet.state());
  const userCpk = coinPublicKeyBytes(state);

  let spendTx: string | null = null;
  const attempts: Array<{ mtIndex: string; outcome: string }> = [];
  for (const mtIndex of candidates) {
    await custodyB.putCoin({ nonce: coin.nonce, color: coin.color, value: coin.value, mtIndex });
    try {
      step(`spend from B with mt_index = ${mtIndex}`);
      const r = await custodyB.spendStateless(userCpk, coin.color, coin.value);
      spendTx = r.txId;
      attempts.push({ mtIndex: String(mtIndex), outcome: `ACCEPTED tx=${r.txId}` });
      break;
    } catch (e: any) {
      attempts.push({ mtIndex: String(mtIndex), outcome: `failed: ${e?.message?.slice(0, 160)}` });
    }
  }
  details.spendAttempts = attempts;

  if (!spendTx) {
    writeEvidence({
      testId: 'P3',
      name: 'observer-and-spend',
      description: 'Observer audit of the composed tx + B-side spend of the received coin',
      verdict: 'PARTIAL',
      errorCode: 'spend-blocked',
      note: 'Observer audit recorded, but B could not spend the received coin under any candidate mt_index — see spendAttempts.',
      details,
    });
    throw new Error('B-side spend failed for every candidate mt_index');
  }

  await sleep(5_000);
  details.spendTx = spendTx;

  const linkingConfirmed = probes.contractAddressA.found && probes.contractAddressB.found;
  const privacyHeld = !probes.transferColor.found && !probes.transferValueLE16.found && !probes.sentNonce.found;
  writeEvidence({
    testId: 'P3',
    name: 'observer-and-spend',
    description: 'Observer audit of the composed tx + B-side spend of the received coin',
    verdict: 'PASS',
    note:
      `B spent the directly-received coin (tx ${spendTx}). Observer surface: both contract addresses ` +
      `${linkingConfirmed ? 'VISIBLE together (the accepted linking, as predicted)' : 'NOT both visible (re-examine!)'}; ` +
      `value/color/nonce ${privacyHeld ? 'hidden' : 'LEAKED — investigate'}.`,
    details,
  });
});
