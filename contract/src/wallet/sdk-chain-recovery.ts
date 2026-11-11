import WebSocket from 'ws';
import { ContractState } from '@midnight-ntwrk/compact-runtime';
import { ZswapChainState, ZswapInput, ZswapOutput } from '@midnightntwrk/ledger-v9';
import { versionOfRecord } from '@midnight-ntwrk/midnight-js-protocol/version';
import { httpClientProvingProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { ledger, type QualifiedCoin, type ShieldedCoin } from './contract.js';
import type { ChainRecoveryAdapter, ChainCoinInspection } from './chain-recovery.js';

export interface SdkChainRecoveryOptions {
  /** Expected genesis block hash, without relying on a caller's network nickname. */
  networkId: string;
  nodeUrl: string;
  indexerUrl: string;
  indexerWsUrl: string;
  /** A trusted prover receives private coin witnesses during qualification. */
  proofServerUrl: string;
  zkConfigProvider: any;
  requestTimeoutMs?: number;
  subscriptionTimeoutMs?: number;
  maxEventPages?: number;
}

const snapshotQuery = `query RecoverySnapshot($address: HexEncoded!, $offset: BlockOffset!) {
  block(offset: $offset) { hash height protocolVersion contractZswapState(address: $address) }
  contract(address: $address, offset: $offset) { state }
}`;
const anchorQuery = `query RecoveryAnchor($offset: BlockOffset!) { block(offset: $offset) { hash height protocolVersion } }`;
const outputQuery = `query RecoveryOutputs($filter: ContractEventFilter!, $limit: Int!, $offset: Int!) {
  contractEvents(filter: $filter, limit: $limit, offset: $offset) {
    id version protocolVersion contractAddress
    ... on ShieldedReceiveEvent { commitment }
    ... on ShieldedMintEvent { commitment }
    transaction { hash block { hash height } ... on RegularTransaction { zswapStartIndex zswapEndIndex } }
  }
}`;
const nullifierQuery = `subscription RecoveryNullifiers($prefixes: [HexEncoded!]!, $to: Int!) {
  shieldedNullifierTransactions(nullifierPrefixes: $prefixes, fromBlock: 0, toBlock: $to) {
    nullifier transactionHash blockHash blockHeight
    transaction { hash block { hash height } }
  }
}`;

function hex32(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^(0x)?[0-9a-fA-F]{64}$/.test(value)) throw new Error(`invalid ${name}`);
  return value.replace(/^0x/, '').toLowerCase();
}
function bytes(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(value)) throw new Error('invalid snapshot encoding');
  return new Uint8Array(Buffer.from(value, 'hex'));
}
function uint(value: unknown, name: string, bits = 64): bigint {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`unsafe ${name}`);
  if (!['number', 'string', 'bigint'].includes(typeof value) || !/^(0|[1-9]\d*)$/.test(String(value))) throw new Error(`invalid ${name}`);
  const n = BigInt(value as string);
  if (n >= (1n << BigInt(bits))) throw new Error(`${name} is out of range`);
  return n;
}
function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid ${name}`);
  return value;
}

/**
 * Read-only v9 reconstruction. Commitment membership and spentness use separate
 * evidence: a checked witness, then committed nullifiers through an indexed,
 * finalised anchor. No wallet, device, signature, or submitted trial spend is used.
 */
export function createSdkChainRecoveryAdapter(options: SdkChainRecoveryOptions): ChainRecoveryAdapter {
  const networkId = hex32(options.networkId, 'network genesis hash');
  const requestTimeout = positive(options.requestTimeoutMs ?? 15_000, 'request timeout');
  const subscriptionTimeout = positive(options.subscriptionTimeoutMs ?? 30_000, 'subscription timeout');
  const maxEventPages = positive(options.maxEventPages ?? 8, 'event page limit');
  for (const endpoint of [options.nodeUrl, options.indexerUrl, options.proofServerUrl]) {
    if (!['http:', 'https:'].includes(new URL(endpoint).protocol)) throw new Error('unsupported recovery HTTP endpoint');
  }
  if (!['ws:', 'wss:'].includes(new URL(options.indexerWsUrl).protocol)) throw new Error('unsupported recovery websocket endpoint');
  const prover = httpClientProvingProvider(options.proofServerUrl, options.zkConfigProvider, { timeout: requestTimeout });

  async function post(url: string, payload: unknown): Promise<any> {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(requestTimeout) });
    if (!response.ok) throw new Error(`recovery endpoint returned HTTP ${response.status}`);
    return response.json();
  }
  async function rpc(method: string, params: unknown[] = []): Promise<any> {
    const response = await post(options.nodeUrl, { jsonrpc: '2.0', id: 1, method, params });
    if (response.jsonrpc !== '2.0' || response.id !== 1 || response.error || response.result === undefined || response.result === null) throw new Error(`node ${method} unavailable`);
    return response.result;
  }
  async function gql(query: string, variables: unknown): Promise<any> {
    const response = await post(options.indexerUrl, { query, variables });
    if ((response.errors != null && (!Array.isArray(response.errors) || response.errors.length)) || !response.data) throw new Error('recovery indexer query failed');
    return response.data;
  }
  function headerHeight(header: any): bigint {
    if (typeof header?.number !== 'string' || !/^0x[0-9a-f]+$/i.test(header.number)) throw new Error('invalid node block height');
    return uint(BigInt(header.number), 'block height', 31);
  }
  async function canonical(height: bigint, hash: string): Promise<void> {
    if (hex32(await rpc('chain_getBlockHash', [Number(height)]), 'canonical block hash') !== hash) throw new Error('chain snapshot is no longer canonical');
  }

  /** COMPLETE is meaningful only after the upper bound was already indexed.
   * Close/error/timeout are failures, including a normal websocket close. */
  function nullifierRows(nullifier: string, height: number): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(options.indexerWsUrl, 'graphql-transport-ws', { maxPayload: 1024 * 1024 });
      let finished = false, subscribed = false;
      const rows: any[] = [];
      const timer = setTimeout(() => finish(new Error('nullifier scan timed out')), subscriptionTimeout);
      function finish(error?: Error) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        socket.removeAllListeners();
        // A pending connection may emit an error on termination.
        socket.on('error', () => undefined);
        socket.terminate();
        error ? reject(error) : resolve(rows);
      }
      socket.on('error', () => finish(new Error('nullifier scan transport failed')));
      socket.on('close', () => finish(new Error('nullifier scan closed before completion')));
      socket.on('open', () => socket.send(JSON.stringify({ type: 'connection_init' })));
      socket.on('message', data => {
        try {
          const message = JSON.parse(String(data));
          if (message.type === 'ping') { socket.send(JSON.stringify({ type: 'pong' })); return; }
          if (message.type === 'pong') return;
          if (message.type === 'connection_ack' && !subscribed) {
            subscribed = true;
            socket.send(JSON.stringify({ id: '1', type: 'subscribe', payload: {
              query: nullifierQuery, variables: { prefixes: [nullifier], to: height },
            } }));
            return;
          }
          if (!subscribed || message.id !== '1') throw new Error('unexpected nullifier stream message');
          if (message.type === 'error') throw new Error('nullifier scan query failed');
          if (message.type === 'complete') {
            if (Object.keys(message).some(key => key !== 'id' && key !== 'type')) throw new Error('invalid nullifier completion message');
            finish(); return;
          }
          if (message.type !== 'next' || (message.payload?.errors != null
            && (!Array.isArray(message.payload.errors) || message.payload.errors.length))) throw new Error('invalid nullifier stream response');
          const row = message.payload?.data?.shieldedNullifierTransactions;
          if (!row || rows.length >= 16) throw new Error('invalid or excessive nullifier matches');
          rows.push(row);
        } catch (error) { finish(error instanceof Error ? error : new Error('invalid nullifier stream')); }
      });
    });
  }

  return {
    async openSnapshot(request) {
      const address = hex32(request.address, 'contract address');
      if (hex32(await rpc('chain_getBlockHash', [0]), 'node genesis hash') !== networkId) throw new Error('recovery network mismatch');
      const finalisedHash = hex32(await rpc('chain_getFinalizedHead'), 'finalised block hash');
      const finalisedHeight = headerHeight(await rpc('chain_getHeader', [`0x${finalisedHash}`]));
      // An indexed, finalised anchor avoids treating normal indexer lag as a
      // missing history. A supplied cursor remains pinned to its original block.
      const tip = request.blockHash ? null : (await gql('query RecoveryTip { block { hash height protocolVersion } }', {})).block;
      const indexedHeight = tip ? uint(tip.height, 'indexed tip height', 31) : finalisedHeight;
      const blockHash = request.blockHash ? hex32(request.blockHash, 'snapshot block hash')
        : tip && indexedHeight <= finalisedHeight ? hex32(tip.hash, 'indexed tip hash') : finalisedHash;
      const blockHeight = request.blockHash ? headerHeight(await rpc('chain_getHeader', [`0x${blockHash}`]))
        : indexedHeight < finalisedHeight ? indexedHeight : finalisedHeight;
      if (blockHeight > finalisedHeight) throw new Error('requested recovery snapshot is not finalised');
      await canonical(blockHeight, blockHash);
      const response = await gql(snapshotQuery, { address, offset: { hash: blockHash } });
      const checkAnchor = (block: any) => {
        if (!block || hex32(block.hash, 'indexed block hash') !== blockHash
          || uint(block.height, 'indexed height', 31) !== blockHeight || versionOfRecord(block) !== 'v9') {
          throw new Error('recovery snapshot is not indexed consistently');
        }
      };
      checkAnchor(response.block);
      const contract = ContractState.deserialize(bytes(response.contract?.state));
      const state = ledger(contract.data);
      const commitments = ZswapChainState.deserialize(bytes(response.block.contractZswapState));
      const scope = { networkId, address, blockHash, blockHeight: blockHeight.toString() };
      async function anchorStillValid() {
        await canonical(blockHeight, blockHash);
        checkAnchor((await gql(anchorQuery, { offset: { height: Number(blockHeight) } })).block);
      }

      async function spentness(input: ReturnType<typeof ZswapInput.newContractOwned>): Promise<'live' | 'spent'> {
        // The filtered commitment tree is deliberately NOT used for spentness.
        const nullifier = hex32(input.nullifier, 'coin nullifier');
        await anchorStillValid();
        const rows = await nullifierRows(nullifier, Number(blockHeight));
        for (const row of rows) {
          if (hex32(row.nullifier, 'observed nullifier') !== nullifier) throw new Error('nullifier observation mismatch');
          const height = uint(row.blockHeight, 'nullifier block height', 31);
          const hash = hex32(row.blockHash, 'nullifier block hash');
          if (height > blockHeight || hex32(row.transactionHash, 'nullifier transaction hash') !== hex32(row.transaction?.hash, 'transaction hash')
            || uint(row.transaction?.block?.height, 'transaction block height', 31) !== height
            || hex32(row.transaction?.block?.hash, 'transaction block hash') !== hash) throw new Error('inconsistent nullifier receipt');
          await canonical(height, hash);
        }
        await anchorStillValid();
        return rows.length ? 'spent' : 'live';
      }

      async function inspect(coin: ShieldedCoin, search: { hints: bigint[]; nextIndex?: bigint; eventOffset?: number; maxIndices: number }): Promise<ChainCoinInspection> {
        try {
          const maxIndices = positive(search.maxIndices, 'qualification limit');
          if (maxIndices > 4096) throw new Error('qualification limit exceeds 4096');
          const start = search.nextIndex ?? 0n;
          uint(start, 'qualification cursor');
          const windowOffset = Number(uint(search.eventOffset ?? 0, 'event cursor', 31));
          const raw = { nonce: hex32(Buffer.from(coin.nonce).toString('hex'), 'coin nonce'),
            type: hex32(Buffer.from(coin.color).toString('hex'), 'coin colour'), value: uint(coin.value, 'coin value', 128) };
          const commitment = ZswapOutput.newContractOwned(raw, undefined, address).commitment;
          const visited = new Set<string>();
          let attempts = 0;
          async function check(index: bigint): Promise<ChainCoinInspection | undefined> {
            uint(index, 'candidate index');
            if (index < start || visited.has(index.toString())) return;
            if (attempts >= maxIndices) return { status: 'unknown', reason: 'commitment search budget exhausted', nextIndex: index.toString(), nextEventOffset: windowOffset };
            visited.add(index.toString()); attempts++;
            let input: ReturnType<typeof ZswapInput.newContractOwned>;
            try { input = ZswapInput.newContractOwned({ ...raw, mt_index: index }, undefined, address, commitments); }
            catch { return; }
            try { await prover.check(input.proof.serialize(), 'midnight/zswap/spend'); }
            catch (error) {
              // The pinned prover rejects unsatisfied candidates with HTTP 400.
              // Other errors are unavailable evidence, not a reason to retry all positions.
              if (!String(error).includes('code="400"')) throw new Error('commitment verifier unavailable');
              return;
            }
            const qualified: QualifiedCoin = { ...coin, mt_index: index };
            return { status: await spentness(input), coin: qualified };
          }
          // Hints are tried once. On continuation, resume the ordered chain
          // ranges, so a bad high hint cannot consume every page or skip lows.
          if (search.nextIndex === undefined && windowOffset === 0) for (const hint of [...search.hints].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)) {
            const found = await check(hint);
            if (found) return found.status === 'unknown' && found.nextIndex !== undefined ? { ...found, nextIndex: '0' } : found;
          }
          const pageSize = 100;
          let lastId = -1;
          const ranges: { lower: bigint; upper: bigint }[] = [];
          let eventHistoryComplete = false;
          let nextEventOffset = windowOffset;
          // On a position continuation, the first event page was necessarily in
          // the original window. Recheck only that page, then advance/reset, so
          // changing maxEventPages between calls cannot skip newly added lows.
          const eventPageLimit = start > 0n ? 1 : maxEventPages;
          for (let page = 0; page < eventPageLimit; page++) {
            uint(nextEventOffset, 'event cursor', 31);
            const data = await gql(outputQuery, { filter: { contractAddress: address,
              types: ['SHIELDED_RECEIVE', 'SHIELDED_MINT'], fieldPrefixes: [{ fieldName: 'commitment', prefix: commitment }],
              fromBlock: 0, toBlock: Number(blockHeight) }, limit: pageSize, offset: nextEventOffset });
            if (!Array.isArray(data.contractEvents) || data.contractEvents.length > pageSize) throw new Error('invalid commitment event page');
            for (const event of data.contractEvents) {
              if (!Number.isSafeInteger(event.id) || event.id <= lastId || event.version !== 1 || versionOfRecord(event) !== 'v9'
                || hex32(event.contractAddress, 'event contract') !== address || hex32(event.commitment, 'event commitment') !== commitment) {
                throw new Error('inconsistent commitment event');
              }
              lastId = event.id;
              const transaction = event.transaction;
              const eventHeight = uint(transaction?.block?.height, 'output block height', 31);
              if (eventHeight > blockHeight) throw new Error('output lies beyond recovery snapshot');
              await canonical(eventHeight, hex32(transaction.block.hash, 'output block hash'));
              hex32(transaction.hash, 'output transaction hash');
              const lower = uint(transaction.zswapStartIndex, 'output start index');
              const upper = uint(transaction.zswapEndIndex, 'output end index');
              if (upper <= lower) throw new Error('invalid output commitment range');
              ranges.push({ lower, upper });
            }
            nextEventOffset += data.contractEvents.length;
            if (data.contractEvents.length < pageSize) { eventHistoryComplete = true; break; }
          }
          ranges.sort((a, b) => a.lower < b.lower ? -1 : a.lower > b.lower ? 1 : 0);
          const merged: typeof ranges = [];
          for (const range of ranges) {
            const previous = merged.at(-1);
            if (previous && range.lower <= previous.upper) {
              if (range.upper > previous.upper) previous.upper = range.upper;
            } else merged.push({ ...range });
          }
          for (const range of merged) for (let index = range.lower > start ? range.lower : start; index < range.upper; index++) {
            const found = await check(index); if (found) return found;
          }
          // Event order need not match commitment order. Advancing the event
          // window resets the index; a qualification pause retains this window.
          if (!eventHistoryComplete) {
            uint(nextEventOffset, 'event cursor', 31);
            return { status: 'unknown', reason: 'commitment event history budget exhausted', nextIndex: '0', nextEventOffset };
          }
          return { status: 'unknown', reason: 'no verified commitment position in available output events' };
        } catch (error) {
          return { status: 'unknown', reason: error instanceof Error ? error.message : 'chain evidence unavailable' };
        }
      }
      return {
        scope, encKey: new Uint8Array(state.enc_key), inboxCount: state.inbox_count,
        async readInbox(index) {
          if (index < 0n || index >= state.inbox_count || !state.inbox.member(index)) return null;
          return new Uint8Array(state.inbox.lookup(index));
        },
        inspect,
      };
    },
  };
}
