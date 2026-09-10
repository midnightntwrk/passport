// Client-side mt_index capture.
//
// The indexer's per-transaction `startIndex`/`endIndex` give the Zswap
// commitment-tree positions this transaction's outputs occupy. For a
// single-output deposit the coin's mt_index IS startIndex; for multi-output
// transactions the caller gets every candidate and disambiguates by retry —
// a wrong mt_index fails the in-circuit Merkle membership proof at proving
// time, before any transaction exists, so it cannot mis-spend.

export interface TxPosition {
  startIndex?: number;
  endIndex?: number;
  blockHeight?: number;
  status?: string;
  raw?: unknown;
  error?: string;
}

export function indexerUrl(): string {
  return process.env.INDEXER_URL
    ?? process.env.MIDNIGHT_INDEXER_URL
    ?? 'http://localhost:8088/api/v4/graphql';
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
    const res = await fetch(indexerUrl(), {
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

/** Every commitment-tree position a transaction's outputs may have used. */
export async function candidateIndices(
  txId: string,
): Promise<{ candidates: bigint[]; position: TxPosition }> {
  const position = await queryTxPosition(txId);
  if (position.error) throw new Error(`mt_index capture failed: ${position.error}`);
  const out: bigint[] = [];
  for (let i = position.startIndex ?? 0; i < (position.endIndex ?? 0); i++) out.push(BigInt(i));
  return { candidates: out, position };
}
