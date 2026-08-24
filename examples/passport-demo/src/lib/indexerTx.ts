/**
 * Recent-transaction client for the Midnight indexer (GraphQL v4).
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS VERIFIED AGAINST THE LIVE SCHEMA
 * ---------------------------------------------------------------------------
 * Endpoint introspected on 2026/08/04:
 *   https://indexer.preview.midnight.network/api/v4/graphql
 *
 * The build moved to stagenet on 2026/08/24 and this module did not have to:
 * https://indexer.stagenet.shielded.tools/api/v4/graphql serves the same v4
 * schema, and both fields relied on below — `block(offset:)` and the
 * `transactions(offset: { identifier })` point lookup — were exercised against
 * it live. What could NOT sync stagenet was the ledger-8 wallet SDK's own
 * indexer client, not this one; see `./networks.ts`.
 *
 * 1. There is NO per-address transaction QUERY over HTTP. The full `Query`
 *    field list is: block, zswapMerkleTreeCollapsedUpdate, transactions,
 *    contractAction, contract, dustGenerationStatus, dustGenerations,
 *    dustCommitmentMerkleTreeUpdate, dustGenerationMerkleTreeUpdate,
 *    contractEvents, dParameterHistory, termsAndConditionsHistory, and a long
 *    tail of SPO / epoch / bridge analytics fields. Critically:
 *      - `transactions(offset: TransactionOffset!)` is NOT a listing field.
 *        `TransactionOffset` only accepts `{ hash }` or `{ identifier }`, so
 *        it is a point lookup — you must already know the hash.
 *      - `block(offset: BlockOffset)` accepts `{ hash }` or `{ height }` and
 *        returns the latest block when the offset is omitted.
 *
 * 2. Per-address history IS available, but only as a WebSocket SUBSCRIPTION:
 *      subscription { unshieldedTransactions(address: UnshieldedAddress!,
 *                                            transactionId: Int) { ... } }
 *    It replays the address's entire history in ascending `transaction.id`
 *    order and then stays open for live updates. The union member set is
 *    `UnshieldedTransaction | UnshieldedTransactionsProgress`.
 *    Measured on preview: a 335-transaction address replayed fully in ~1.7 s.
 *
 * 3. Protocol facts confirmed by live runs:
 *      - The WebSocket URL is the HTTP endpoint with `/ws` appended
 *        (wss://…/api/v4/graphql/ws). The bare `…/api/v4/graphql` path
 *        REFUSES the WebSocket upgrade.
 *      - Sub-protocol `graphql-transport-ws` (graphql-ws). Handshake is
 *        connection_init -> connection_ack -> subscribe -> next…
 *      - The FIRST `next` payload is always an
 *        `UnshieldedTransactionsProgress { highestTransactionId }` giving the
 *        highest transaction id relevant TO THAT ADDRESS. History is complete
 *        once a transaction with `id >= highestTransactionId` has arrived.
 *      - The server sends NO `complete` after the history replay (it keeps
 *        streaming live), so an idle timer is required to finish early for
 *        accounts whose history is empty.
 *      - A malformed address yields a `next` frame carrying `errors`
 *        ("cannot bech32m-decode unshielded address"), immediately followed
 *        by `complete`.
 *
 * 4. HTTP fallback (used when no address is known, or when the WebSocket
 *    path fails): walk the chain backwards with aliased `block(offset:
 *    { height })` selections. The endpoint enforces a query-complexity limit —
 *    with the owner sub-selections below, 10 aliases per request is accepted
 *    and 20 is rejected with "Query is too complex." Very large request
 *    bodies (~15 KB) are also rejected by the load balancer with a bare
 *    HTTP 403, so batches are kept small.
 *
 * 5. CORS: the HTTP endpoint replies with `access-control-allow-origin: *`,
 *    so browser `fetch` works from any origin. WebSockets are not subject to
 *    CORS at all.
 *
 * The exact documents this module sends are `UNSHIELDED_SUBSCRIPTION` and
 * `buildBlockWindowQuery` below.
 *
 * ---------------------------------------------------------------------------
 * PROVENANCE: WHY EVERY RESULT CARRIES A `scope`
 * ---------------------------------------------------------------------------
 * The two paths above answer two different questions, so `fetchRecentTransactions`
 * reports which one produced the rows:
 *
 *   - `scope: 'address'` — the rows came from the per-address subscription.
 *     Every row genuinely belongs to the signed-in account, and the list is
 *     that account's history. An empty list here does mean "no history".
 *
 *   - `scope: 'chain'` — the rows came from the block walk. This is a
 *     CHAIN-WIDE sample of the most recent blocks: it contains whatever
 *     anybody transacted in that window, not the user's account history.
 *     A `chain` result CANNOT prove that an account has no history. Preview
 *     blocks are nearly all empty (a scan of 1,200 consecutive blocks found
 *     one transaction), so the ~120-block walk returns an empty list for
 *     almost any real account — that emptiness says nothing about the
 *     account. Callers must not render a `chain` result as the user's own
 *     recent activity, and must not turn an empty `chain` result into a claim
 *     such as "no transactions yet on this account".
 */

/** One row in the "Recent transactions" panel. */
export interface RecentTransaction {
  hash: string
  blockHeight?: number | null
  timestamp?: string | null
  /** Ledger apply result: 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILURE'. */
  applyStage?: string | null
  /** True when the row is known to touch the user's unshielded address. */
  involvesUser?: boolean
  /** Human-readable classification, e.g. 'Received', 'Sent', 'Contract call'. */
  kind?: string | null
}

export interface FetchRecentTransactionsOptions {
  unshieldedAddress?: string | null
  limit?: number
}

/**
 * Where a batch of rows came from.
 *
 * - `'address'` — the signed-in account's own history, from the per-address
 *   subscription. Authoritative; an empty list means the account has none.
 *   Only a replay seen through to its end ever carries this scope: the
 *   subscription streams OLDEST first, so a truncated one would be the wrong
 *   end of the history, and it is rejected in favour of the chain walk rather
 *   than presented as the newest rows.
 * - `'chain'` — a chain-wide sample of recent blocks, from the block-walk
 *   fallback. Rows may belong to anybody, and an empty list proves nothing
 *   about the account.
 */
export type RecentTransactionsScope = 'address' | 'chain'

export interface RecentTransactionsResult {
  rows: RecentTransaction[]
  scope: RecentTransactionsScope
}

/** Thrown when the indexer cannot be reached, times out, or replies with errors. */
export class IndexerUnavailableError extends Error {
  readonly indexerUrl: string
  readonly stage: 'connect' | 'query' | 'timeout' | 'protocol'

  constructor(
    message: string,
    options: { indexerUrl: string; stage: IndexerUnavailableError['stage']; cause?: unknown },
  ) {
    super(message, { cause: options.cause })
    this.name = 'IndexerUnavailableError'
    this.indexerUrl = options.indexerUrl
    this.stage = options.stage
  }
}

/** Hard ceiling for the whole call, as required by the demo contract. */
const HARD_TIMEOUT_MS = 10_000
/** Quiet period after which we treat the history replay as finished. */
const IDLE_AFTER_FIRST_FRAME_MS = 1_400
const DEFAULT_LIMIT = 12
/** Aliased blocks per HTTP request — 10 passes the complexity limit, 20 does not. */
const BLOCKS_PER_REQUEST = 10
/** Parallel block requests per round. */
const REQUESTS_PER_ROUND = 4
const MAX_ROUNDS = 3

const NATIVE_TOKEN_TYPE = '0'.repeat(64)

/* -------------------------------------------------------------------------- */
/* GraphQL documents                                                          */
/* -------------------------------------------------------------------------- */

const UNSHIELDED_SUBSCRIPTION = `subscription PassportRecentTransactions($address: UnshieldedAddress!) {
  unshieldedTransactions(address: $address) {
    __typename
    ... on UnshieldedTransactionsProgress {
      highestTransactionId
    }
    ... on UnshieldedTransaction {
      createdUtxos { owner value tokenType }
      spentUtxos { owner value tokenType }
      transaction {
        __typename
        id
        hash
        block { height timestamp }
        ... on RegularTransaction {
          transactionResult { status }
          contractActions { __typename }
        }
      }
    }
  }
}`

/**
 * Builds an aliased multi-block query. Kept at BLOCKS_PER_REQUEST aliases —
 * the endpoint rejects roughly twice that with "Query is too complex.".
 */
function buildBlockWindowQuery(topHeight: number, count: number): string {
  const selections: string[] = []
  for (let index = 0; index < count; index += 1) {
    const height = topHeight - index
    if (height < 0) break
    selections.push(
      `b${index}: block(offset: { height: ${height} }) {
        height
        timestamp
        transactions {
          __typename
          hash
          ... on RegularTransaction {
            transactionResult { status }
            contractActions { __typename }
            unshieldedCreatedOutputs { owner }
            unshieldedSpentOutputs { owner }
          }
        }
      }`,
    )
  }
  return `query PassportRecentBlocks { ${selections.join('\n')} }`
}

const TIP_QUERY = `query PassportChainTip { block { height } }`

/* -------------------------------------------------------------------------- */
/* Wire shapes                                                                */
/* -------------------------------------------------------------------------- */

interface GraphQLError {
  message?: string
}

interface GraphQLResponse<T> {
  data?: T | null
  errors?: GraphQLError[] | null
}

interface WireUtxoOwner {
  owner: string
}

interface WireBlockRef {
  height: number
  timestamp: number
}

interface WireTransaction {
  __typename: string
  id?: number
  hash: string
  block?: WireBlockRef | null
  transactionResult?: { status: string } | null
  contractActions?: { __typename: string }[] | null
}

interface WireUnshieldedTransaction {
  __typename: 'UnshieldedTransaction'
  createdUtxos: { owner: string; value: string; tokenType: string }[]
  spentUtxos: { owner: string; value: string; tokenType: string }[]
  transaction: WireTransaction
}

interface WireProgress {
  __typename: 'UnshieldedTransactionsProgress'
  highestTransactionId: number
}

type WireUnshieldedEvent = WireUnshieldedTransaction | WireProgress

interface WireBlockTransaction {
  __typename: string
  hash: string
  transactionResult?: { status: string } | null
  contractActions?: { __typename: string }[] | null
  unshieldedCreatedOutputs?: WireUtxoOwner[] | null
  unshieldedSpentOutputs?: WireUtxoOwner[] | null
}

interface WireBlock {
  height: number
  timestamp: number
  transactions: WireBlockTransaction[]
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** `https://host/api/v4/graphql` -> `wss://host/api/v4/graphql/ws`. */
export function toIndexerWebSocketUrl(indexerUrl: string): string {
  const url = new URL(indexerUrl)
  if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol === 'http:') url.protocol = 'ws:'
  if (!url.pathname.endsWith('/ws')) {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/ws`
  }
  url.search = ''
  url.hash = ''
  return url.toString()
}

function isoTimestamp(milliseconds: number | null | undefined): string | null {
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds <= 0) {
    return null
  }
  return new Date(milliseconds).toISOString()
}

function describeKind(
  typename: string,
  contractActionCount: number,
  createdForUser: boolean,
  spentByUser: boolean,
): string {
  if (typename === 'SystemTransaction') return 'System'
  if (typename === 'BridgeClaimTransaction') return 'Bridge claim'
  if (contractActionCount > 0) return 'Contract call'
  if (createdForUser && spentByUser) return 'Self transfer'
  if (spentByUser) return 'Sent'
  if (createdForUser) return 'Received'
  return 'Transfer'
}

function pushCapped(rows: RecentTransaction[], row: RecentTransaction, limit: number): void {
  rows.push(row)
  while (rows.length > limit) rows.shift()
}

function remaining(deadline: number): number {
  return deadline - Date.now()
}

/* -------------------------------------------------------------------------- */
/* WebSocket path — per-address history                                       */
/* -------------------------------------------------------------------------- */

function fetchViaSubscription(
  indexerUrl: string,
  address: string,
  limit: number,
  deadline: number,
): Promise<RecentTransaction[]> {
  return new Promise<RecentTransaction[]>((resolve, reject) => {
    if (typeof WebSocket === 'undefined') {
      reject(
        new IndexerUnavailableError('This runtime has no WebSocket support.', {
          indexerUrl,
          stage: 'connect',
        }),
      )
      return
    }

    let socket: WebSocket
    try {
      socket = new WebSocket(toIndexerWebSocketUrl(indexerUrl), 'graphql-transport-ws')
    } catch (cause) {
      reject(
        new IndexerUnavailableError('Could not open a connection to the indexer.', {
          indexerUrl,
          stage: 'connect',
          cause,
        }),
      )
      return
    }

    const collected: RecentTransaction[] = []
    let highestTransactionId: number | null = null
    /* The subscription replays history in ASCENDING id order, so an
       interrupted replay is not a shorter answer — it is the wrong end of the
       account's history. Resolving one would hand the caller the account's
       oldest transactions and let it print them under "recent activity", with
       `scope: 'address'` vouching for them. So the replay has to be seen
       through to its end before anything it produced may be resolved; short of
       that this path rejects, and `fetchRecentTransactions` degrades to the
       chain walk, whose `scope: 'chain'` says plainly what it is. */
    let historyComplete = false
    let settled = false
    let idleTimer: ReturnType<typeof setTimeout> | null = null

    const hardTimer = setTimeout(() => {
      abandon('The indexer did not answer in time.', 'timeout')
    }, Math.max(0, remaining(deadline)))

    function clearIdle(): void {
      if (idleTimer !== null) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
    }

    function armIdle(): void {
      clearIdle()
      idleTimer = setTimeout(() => {
        /* The server sends no `complete` after the replay — it holds the socket
           open for live traffic — so silence is how a finished replay announces
           itself, and it is the only way an empty history ever ends. It counts
           as an ending only once the Progress frame has arrived, though: before
           that we have not been told what the end of history even is, and
           silence is just an unanswered subscription. */
        if (highestTransactionId !== null) historyComplete = true
        abandon('The indexer went quiet before replaying this account.', 'timeout')
      }, Math.min(IDLE_AFTER_FIRST_FRAME_MS, Math.max(0, remaining(deadline))))
    }

    function finish(error: IndexerUnavailableError | null): void {
      if (settled) return
      settled = true
      clearTimeout(hardTimer)
      clearIdle()
      try {
        socket.close()
      } catch {
        /* the socket may already be closing; nothing to recover here */
      }
      if (error) reject(error)
      else resolve(collected.slice().reverse())
    }

    /**
     * Ends a call that stopped for a reason of its own — a ceiling, an error,
     * a closed socket. Rows collected so far are only an answer if the replay
     * had already run to completion; otherwise they are the oldest slice of
     * history and this rejects rather than pass them off as the newest.
     */
    function abandon(message: string, stage: IndexerUnavailableError['stage']): void {
      finish(historyComplete ? null : new IndexerUnavailableError(message, { indexerUrl, stage }))
    }

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'connection_init' }))
    }

    socket.onerror = () => {
      abandon('The indexer WebSocket reported an error.', 'connect')
    }

    socket.onclose = () => {
      abandon('The indexer closed the connection before replaying this account.', 'connect')
    }

    socket.onmessage = (event: MessageEvent) => {
      let message: { type?: string; id?: string; payload?: unknown }
      try {
        message = JSON.parse(String(event.data)) as { type?: string; id?: string; payload?: unknown }
      } catch {
        return
      }

      if (message.type === 'connection_ack') {
        socket.send(
          JSON.stringify({
            id: '1',
            type: 'subscribe',
            payload: { query: UNSHIELDED_SUBSCRIPTION, variables: { address } },
          }),
        )
        return
      }

      if (message.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }))
        return
      }

      if (message.type === 'error') {
        finish(
          new IndexerUnavailableError('The indexer rejected the transaction subscription.', {
            indexerUrl,
            stage: 'query',
            cause: message.payload,
          }),
        )
        return
      }

      if (message.type === 'complete') {
        // The server ended the subscription itself; there is no more history.
        historyComplete = true
        finish(null)
        return
      }

      if (message.type !== 'next') return

      const payload = message.payload as GraphQLResponse<{ unshieldedTransactions: WireUnshieldedEvent }> | undefined
      if (payload?.errors && payload.errors.length > 0) {
        finish(
          new IndexerUnavailableError(payload.errors[0]?.message ?? 'The indexer returned a GraphQL error.', {
            indexerUrl,
            stage: 'query',
            cause: payload.errors,
          }),
        )
        return
      }

      const node = payload?.data?.unshieldedTransactions
      if (!node) return

      if (node.__typename === 'UnshieldedTransactionsProgress') {
        highestTransactionId = node.highestTransactionId
        // An account with no history never emits a transaction frame, so the
        // idle timer is what ends the call.
        armIdle()
        return
      }

      const spentByUser = node.spentUtxos.some((utxo) => utxo.owner === address)
      const createdForUser = node.createdUtxos.some((utxo) => utxo.owner === address)
      const transaction = node.transaction

      pushCapped(
        collected,
        {
          hash: transaction.hash,
          blockHeight: transaction.block?.height ?? null,
          timestamp: isoTimestamp(transaction.block?.timestamp),
          applyStage: transaction.transactionResult?.status ?? null,
          involvesUser: true,
          kind: describeKind(
            transaction.__typename,
            transaction.contractActions?.length ?? 0,
            createdForUser,
            spentByUser,
          ),
        },
        limit,
      )

      if (highestTransactionId !== null && typeof transaction.id === 'number' && transaction.id >= highestTransactionId) {
        // History replay is complete; everything after this is live traffic.
        historyComplete = true
        finish(null)
        return
      }
      armIdle()
    }
  })
}

/* -------------------------------------------------------------------------- */
/* HTTP path — chain walk                                                     */
/* -------------------------------------------------------------------------- */

async function postGraphQL<T>(indexerUrl: string, query: string, deadline: number): Promise<T> {
  const budget = remaining(deadline)
  if (budget <= 0) {
    throw new IndexerUnavailableError('Ran out of time before querying the indexer.', {
      indexerUrl,
      stage: 'timeout',
    })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), budget)
  try {
    const response = await fetch(indexerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new IndexerUnavailableError(`The indexer replied with HTTP ${response.status}.`, {
        indexerUrl,
        stage: 'query',
      })
    }
    const body = (await response.json()) as GraphQLResponse<T>
    if (body.errors && body.errors.length > 0) {
      throw new IndexerUnavailableError(body.errors[0]?.message ?? 'The indexer returned a GraphQL error.', {
        indexerUrl,
        stage: 'query',
        cause: body.errors,
      })
    }
    if (!body.data) {
      throw new IndexerUnavailableError('The indexer returned an empty response.', {
        indexerUrl,
        stage: 'protocol',
      })
    }
    return body.data
  } catch (cause) {
    if (cause instanceof IndexerUnavailableError) throw cause
    const aborted = cause instanceof DOMException && cause.name === 'AbortError'
    throw new IndexerUnavailableError(
      aborted ? 'The indexer did not answer in time.' : 'Could not reach the indexer.',
      { indexerUrl, stage: aborted ? 'timeout' : 'connect', cause },
    )
  } finally {
    clearTimeout(timer)
  }
}

async function fetchViaBlockWalk(
  indexerUrl: string,
  address: string | null,
  limit: number,
  deadline: number,
): Promise<RecentTransaction[]> {
  const tip = await postGraphQL<{ block: { height: number } | null }>(indexerUrl, TIP_QUERY, deadline)
  const tipHeight = tip.block?.height
  if (typeof tipHeight !== 'number') {
    throw new IndexerUnavailableError('The indexer did not report a chain tip.', {
      indexerUrl,
      stage: 'protocol',
    })
  }

  const rows: RecentTransaction[] = []
  let nextTop = tipHeight

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    if (rows.length >= limit || nextTop < 0 || remaining(deadline) <= 0) break

    const windows: number[] = []
    for (let slot = 0; slot < REQUESTS_PER_ROUND; slot += 1) {
      const top = nextTop - slot * BLOCKS_PER_REQUEST
      if (top < 0) break
      windows.push(top)
    }
    nextTop -= windows.length * BLOCKS_PER_REQUEST

    const settled = await Promise.allSettled(
      windows.map((top) =>
        postGraphQL<Record<string, WireBlock | null>>(
          indexerUrl,
          buildBlockWindowQuery(top, BLOCKS_PER_REQUEST),
          deadline,
        ),
      ),
    )

    const blocks: WireBlock[] = []
    let anyFulfilled = false
    for (const result of settled) {
      if (result.status !== 'fulfilled') continue
      anyFulfilled = true
      for (const block of Object.values(result.value)) {
        if (block) blocks.push(block)
      }
    }
    if (!anyFulfilled && rows.length === 0) {
      throw new IndexerUnavailableError('Could not read recent blocks from the indexer.', {
        indexerUrl,
        stage: 'query',
      })
    }

    blocks.sort((left, right) => right.height - left.height)
    for (const block of blocks) {
      for (const transaction of block.transactions) {
        const created = transaction.unshieldedCreatedOutputs ?? []
        const spent = transaction.unshieldedSpentOutputs ?? []
        const createdForUser = address !== null && created.some((utxo) => utxo.owner === address)
        const spentByUser = address !== null && spent.some((utxo) => utxo.owner === address)
        rows.push({
          hash: transaction.hash,
          blockHeight: block.height,
          timestamp: isoTimestamp(block.timestamp),
          applyStage: transaction.transactionResult?.status ?? null,
          involvesUser: address === null ? undefined : createdForUser || spentByUser,
          kind: describeKind(
            transaction.__typename,
            transaction.contractActions?.length ?? 0,
            createdForUser,
            spentByUser,
          ),
        })
      }
    }
  }

  return rows.slice(0, limit)
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Reads recent transactions for the signed-in Passport, together with the
 * provenance of what it found.
 *
 * With an `unshieldedAddress` the account's own history is replayed over the
 * `unshieldedTransactions` subscription — newest first, every row genuinely
 * belonging to the user — and the result carries `scope: 'address'`. Without
 * one (or if that connection fails) the chain tip is walked over HTTP instead;
 * that result carries `scope: 'chain'` and is a chain-wide sample, with rows
 * flagged via `involvesUser` where the address is known.
 *
 * Only a `scope: 'address'` result speaks for the account: an empty `rows`
 * there means the account has no history. An empty `scope: 'chain'` result
 * means only that the walked block window happened to be empty — it cannot
 * establish that the account has no history. Throws
 * `IndexerUnavailableError` when the indexer cannot be read at all.
 */
export async function fetchRecentTransactions(
  indexerUrl: string,
  opts: FetchRecentTransactionsOptions,
): Promise<RecentTransactionsResult> {
  const limit = Math.max(1, Math.min(50, opts.limit ?? DEFAULT_LIMIT))
  const address = opts.unshieldedAddress?.trim() || null
  const deadline = Date.now() + HARD_TIMEOUT_MS

  if (address) {
    try {
      return { rows: await fetchViaSubscription(indexerUrl, address, limit, deadline), scope: 'address' }
    } catch (cause) {
      // Degrade to a chain-wide walk, which the `scope` in the result declares
      // so the caller never mistakes it for this account's history.
      if (remaining(deadline) < 1_500) {
        throw cause instanceof IndexerUnavailableError
          ? cause
          : new IndexerUnavailableError('Could not read transactions from the indexer.', {
              indexerUrl,
              stage: 'connect',
              cause,
            })
      }
    }
  }

  return { rows: await fetchViaBlockWalk(indexerUrl, address, limit, deadline), scope: 'chain' }
}

/** Exposed so callers can label native-token rows without re-deriving the constant. */
export const NATIVE_UNSHIELDED_TOKEN_TYPE = NATIVE_TOKEN_TYPE
