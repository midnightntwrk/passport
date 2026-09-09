// VENDORED SLICE — client-side mt_index capture (MIP-0012 §6.5).
//
// Adapted from arc-passport branch nicolasdp/ecdsa-k1-arm,
// contract/src/wallet/capture.ts, commit 2b0b55d, trimmed for P7: only the
// per-transaction commitment-tree window query survives (the
// contract-action-history enumeration is not needed here), and the indexer
// URL comes from the harness CONFIG rather than raw env vars.
//
// The indexer's per-transaction startIndex/endIndex give the Zswap
// commitment-tree positions the transaction's outputs occupy. For a
// single-output transaction the coin's mt_index IS startIndex; for
// multi-output transactions the client gets every candidate and MAY resolve
// by retry: an incorrect qualified description yields an unsatisfiable
// witness at proving time and no transaction is submitted, so retry cannot
// mis-spend (INV-5).

import { CONFIG } from '../../node/wallet.js';

export interface TxPosition {
  startIndex?: number;
  endIndex?: number;
  blockHeight?: number;
  status?: string;
  raw?: unknown;
  error?: string;
}

export async function queryTxPosition(txId: string): Promise<TxPosition> {
  const query = `
    query TxPosition($offset: TransactionOffset!) {
      transactions(offset: $offset) {
        id
        hash
        block { height hash }
        ... on RegularTransaction {
          startIndex
          endIndex
          transactionResult { status }
        }
      }
    }
  `.trim();
  try {
    const res = await fetch(CONFIG.indexer, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: { offset: { identifier: txId.replace(/^0x/, '') } },
      }),
    });
    if (!res.ok) return { error: `HTTP ${res.status} ${res.statusText}` };
    const body: any = await res.json();
    if (body?.errors?.length) return { error: `GraphQL errors: ${JSON.stringify(body.errors)}` };
    const t = (body?.data?.transactions ?? [])[0];
    if (!t) return { error: `indexer returned no transaction for identifier ${txId}` };
    return {
      startIndex: Number(t?.startIndex ?? 0),
      endIndex: Number(t?.endIndex ?? 0),
      blockHeight: Number(t?.block?.height ?? 0),
      status: String(t?.transactionResult?.status ?? ''),
      raw: t,
    };
  } catch (e: any) {
    return { error: `fetch failed: ${e?.message ?? String(e)}` };
  }
}

/** mt_index for a transaction expected to carry exactly one shielded output. */
export async function mtIndexForSingleOutput(
  txId: string,
): Promise<{ mtIndex: bigint; position: TxPosition }> {
  const position = await queryTxPosition(txId);
  if (position.error) throw new Error(`mt_index capture failed: ${position.error}`);
  const count = (position.endIndex ?? 0) - (position.startIndex ?? 0);
  if (count !== 1) {
    throw new Error(
      `mt_index capture: tx produced ${count} commitments, expected exactly 1 — ` +
      'use candidateIndices for multi-output transactions',
    );
  }
  return { mtIndex: BigInt(position.startIndex ?? 0), position };
}

/** Every commitment-tree position a multi-output transaction may have used. */
export async function candidateIndices(
  txId: string,
): Promise<{ candidates: bigint[]; position: TxPosition }> {
  const position = await queryTxPosition(txId);
  if (position.error) throw new Error(`mt_index capture failed: ${position.error}`);
  const out: bigint[] = [];
  for (let i = position.startIndex ?? 0; i < (position.endIndex ?? 0); i++) out.push(BigInt(i));
  return { candidates: out, position };
}
