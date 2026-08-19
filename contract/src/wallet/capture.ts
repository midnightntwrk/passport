// Client-side mt_index capture (MIP-0012 §6.5).
//
// The indexer's per-transaction startIndex/endIndex give the Zswap
// commitment-tree positions the transaction's outputs occupy. For a
// single-output deposit the coin's mt_index IS startIndex; for multi-output
// transactions the client gets every candidate and MAY resolve by retry: an
// incorrect qualified description yields an unsatisfiable witness at
// proving time and no transaction is submitted, so retry cannot mis-spend
// (INV-5).

import WebSocket from 'ws';

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

/** mt_index for a transaction expected to carry exactly one shielded output. */
export async function mtIndexForSingleOutput(txId: string): Promise<{ mtIndex: bigint; position: TxPosition }> {
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
export async function candidateIndices(txId: string): Promise<{ candidates: bigint[]; position: TxPosition }> {
  const position = await queryTxPosition(txId);
  if (position.error) throw new Error(`mt_index capture failed: ${position.error}`);
  const out: bigint[] = [];
  for (let i = position.startIndex ?? 0; i < (position.endIndex ?? 0); i++) out.push(BigInt(i));
  return { candidates: out, position };
}

// ── Contract-address → action-history enumeration (MIP-0012 §6.5) ───────────
//
// The indexer's contractAction QUERY returns a single action (the latest at
// or before an offset); enumeration is the contractActions SUBSCRIPTION,
// which replays the complete per-address history from a block height. The
// point query supplies the frontier (the latest action), the subscription is
// replayed from genesis until the frontier arrives, then closed — so a
// discovering wallet needs nothing but the contract address.

export interface ContractActionRecord {
  kind: 'ContractDeploy' | 'ContractCall' | 'ContractUpdate';
  entryPoint?: string;
  txHash: string;
  /** Wallet-style transaction identifiers (the SDK's txId encoding). */
  identifiers: string[];
  blockHeight: number;
  /** Zswap commitment-tree window of the carrying transaction. */
  startIndex?: number;
  endIndex?: number;
}

function indexerWsUrl(): string {
  return process.env.INDEXER_WS_URL ?? indexerUrl().replace(/^http/, 'ws') + '/ws';
}

const TX_FIELDS = `transaction {
  hash
  block { height }
  ... on RegularTransaction { identifiers zswapStartIndex zswapEndIndex }
}`;

const ACTION_FIELDS = `
  __typename
  ... on ContractDeploy { ${TX_FIELDS} }
  ... on ContractCall   { entryPoint ${TX_FIELDS} }
  ... on ContractUpdate { ${TX_FIELDS} }
`;

/** The latest action at or before the chain tip — the replay frontier. */
async function latestContractAction(address: string): Promise<ContractActionRecord | null> {
  const res = await fetch(indexerUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `query($address: HexEncoded!) { contractAction(address: $address) { ${ACTION_FIELDS} } }`,
      variables: { address: address.replace(/^0x/, '') },
    }),
  });
  const body: any = await res.json();
  if (body?.errors?.length) throw new Error(`contractAction query: ${JSON.stringify(body.errors)}`);
  const a = body?.data?.contractAction;
  return a ? toRecord(a) : null;
}

function toRecord(a: any): ContractActionRecord {
  const t = a.transaction ?? {};
  return {
    kind: a.__typename,
    entryPoint: a.entryPoint ?? undefined,
    txHash: String(t.hash ?? ''),
    identifiers: (t.identifiers ?? []).map(String),
    blockHeight: Number(t.block?.height ?? 0),
    startIndex: t.zswapStartIndex != null ? Number(t.zswapStartIndex) : undefined,
    endIndex: t.zswapEndIndex != null ? Number(t.zswapEndIndex) : undefined,
  };
}

/**
 * Replay the full action history of a contract address from genesis, via
 * the contractActions subscription (graphql-transport-ws). Resolves once
 * the frontier action has been received (plus a short drain for actions
 * sharing its transaction); rejects on protocol errors or timeout.
 */
export async function enumerateContractActions(
  address: string,
  { timeoutMs = 60_000, drainMs = 500 }: { timeoutMs?: number; drainMs?: number } = {},
): Promise<ContractActionRecord[]> {
  const frontier = await latestContractAction(address);
  if (!frontier) return [];

  return await new Promise<ContractActionRecord[]>((resolve, reject) => {
    const actions: ContractActionRecord[] = [];
    const ws = new WebSocket(indexerWsUrl(), 'graphql-transport-ws');
    let drain: NodeJS.Timeout | undefined;
    const deadline = setTimeout(
      () => fail(new Error(`contractActions replay timed out after ${timeoutMs}ms (${actions.length} received)`)),
      timeoutMs,
    );
    const finish = (err?: Error) => {
      clearTimeout(deadline);
      if (drain) clearTimeout(drain);
      try { ws.close(); } catch { /* already closed */ }
      err ? reject(err) : resolve(actions);
    };
    const fail = (err: Error) => finish(err);

    ws.on('error', (e) => fail(new Error(`indexer websocket: ${e.message}`)));
    ws.on('open', () => ws.send(JSON.stringify({ type: 'connection_init' })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      switch (msg.type) {
        case 'connection_ack':
          ws.send(JSON.stringify({
            id: '1',
            type: 'subscribe',
            payload: {
              query: `subscription($address: HexEncoded!) {
                contractActions(address: $address, offset: { height: 0 }) { ${ACTION_FIELDS} }
              }`,
              variables: { address: address.replace(/^0x/, '') },
            },
          }));
          break;
        case 'next': {
          if (msg.payload?.errors?.length) {
            fail(new Error(`contractActions subscription: ${JSON.stringify(msg.payload.errors)}`));
            break;
          }
          actions.push(toRecord(msg.payload.data.contractActions));
          // The stream is live and unbounded; stop once the frontier has
          // been replayed, draining briefly for same-transaction siblings.
          if (actions.at(-1)!.txHash === frontier.txHash && !drain) {
            drain = setTimeout(() => finish(), drainMs);
          }
          break;
        }
        case 'error':
          fail(new Error(`contractActions subscription: ${JSON.stringify(msg.payload)}`));
          break;
        case 'complete':
          finish();
          break;
      }
    });
  });
}
