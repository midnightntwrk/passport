/**
 * One-shot recipient balance read, straight from the indexer.
 *
 * The indexer's root Query type has no per-address balance field, but its
 * `unshieldedTransactions(address)` SUBSCRIPTION replays an address's history
 * and — measured live against a localnet indexer on 2026/08/07 — always opens
 * with an `UnshieldedTransactionsProgress` frame whose `highestTransactionId`
 * is the highest transaction RELEVANT TO THAT ADDRESS (0 for a fresh address),
 * then streams the history up to exactly that id. So a bounded, deterministic
 * read is: take the first progress frame as the target, fold created minus
 * spent NIGHT UTxOs until the target id has been applied, and disconnect.
 *
 * Returns `null` when the read could not complete — an unknown balance is not
 * a zero balance, and the caller decides what to do with "could not tell".
 */

import WebSocket from 'ws';

interface UtxoFrame {
  owner: string;
  tokenType: string;
  value: string;
  intentHash: string;
  outputIndex: number;
}

interface EventFrame {
  __typename: 'UnshieldedTransaction' | 'UnshieldedTransactionsProgress';
  transaction?: { id: number };
  createdUtxos?: UtxoFrame[];
  spentUtxos?: UtxoFrame[];
  highestTransactionId?: number;
}

const QUERY = `subscription($address: UnshieldedAddress!) {
  unshieldedTransactions(address: $address) {
    __typename
    ... on UnshieldedTransaction {
      transaction { id }
      createdUtxos { owner tokenType value intentHash outputIndex }
      spentUtxos { owner tokenType value intentHash outputIndex }
    }
    ... on UnshieldedTransactionsProgress { highestTransactionId }
  }
}`;

export function recipientNightBalance(
  indexerWsUrl: string,
  address: string,
  nightTokenType: string,
  timeoutMs = 10_000,
): Promise<bigint | null> {
  return new Promise((resolve) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(indexerWsUrl, 'graphql-transport-ws');
    } catch {
      resolve(null);
      return;
    }

    const unspent = new Map<string, bigint>();
    let target: number | null = null;
    let applied = 0;
    let settled = false;

    const finish = (outcome: bigint | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Already closing.
      }
      resolve(outcome);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    const balance = () => {
      let total = 0n;
      for (const value of unspent.values()) total += value;
      return total;
    };

    socket.on('open', () => socket.send(JSON.stringify({ type: 'connection_init' })));
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(null));
    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      let message: { type: string; payload?: { data?: { unshieldedTransactions?: EventFrame } } };
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (message.type === 'connection_ack') {
        socket.send(
          JSON.stringify({
            id: '1',
            type: 'subscribe',
            payload: { query: QUERY, variables: { address } },
          }),
        );
        return;
      }
      if (message.type === 'error' || message.type === 'complete') {
        finish(null);
        return;
      }
      const event = message.payload?.data?.unshieldedTransactions;
      if (!event) return;
      if (event.__typename === 'UnshieldedTransactionsProgress') {
        if (target === null) {
          target = event.highestTransactionId ?? 0;
          if (target <= applied) finish(balance());
        }
        return;
      }
      for (const utxo of event.createdUtxos ?? []) {
        if (utxo.owner === address && utxo.tokenType.toLowerCase() === nightTokenType.toLowerCase()) {
          unspent.set(`${utxo.intentHash}:${utxo.outputIndex}`, BigInt(utxo.value));
        }
      }
      for (const utxo of event.spentUtxos ?? []) {
        unspent.delete(`${utxo.intentHash}:${utxo.outputIndex}`);
      }
      applied = Math.max(applied, event.transaction?.id ?? 0);
      if (target !== null && applied >= target) finish(balance());
    });
  });
}
