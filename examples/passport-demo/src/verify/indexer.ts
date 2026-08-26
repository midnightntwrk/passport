/**
 * The step verifier's one connection to the world: the stagenet indexer.
 *
 * Everything this module exports is a READ. There is no wallet here, no key,
 * no proof server, and no submit path — a reviewer running this page cannot
 * change anything they are looking at, which is the property that makes it
 * usable in front of an audience.
 *
 * Two rules the rest of the verifier depends on:
 *
 *   1. **Every query is recorded verbatim.** {@link runQuery} returns the data
 *      AND the exact GraphQL document it sent, so each row on the page can
 *      show the query behind it and hand over a `curl` that reproduces it. A
 *      value nobody can re-derive is not evidence.
 *   2. **Addresses are never invented.** {@link normaliseContractAddress}
 *      throws on anything that is not 64 hex characters rather than padding or
 *      truncating, so a mistyped address fails loudly instead of quietly
 *      verifying the wrong account.
 *
 * The endpoint takes POST only and answers with `access-control-allow-origin:
 * *` (checked with an OPTIONS preflight from `https://midnightpassport.com` on
 * 2026/08/25), so the browser reaches it directly with no proxy in between.
 */

/** The stagenet indexer. POST only. */
export const INDEXER_URL = 'https://indexer.stagenet.shielded.tools/api/v4/graphql';

/**
 * The `.night` top-level domain on stagenet — ours, deployed 2026/08/24 with
 * the preview registry's own parameters. See `src/identity/midnames.ts`.
 */
export const TLD_ADDRESS = '29be1e64846cff4600c5297fa54b27d4c9296b3ccc2cdba190eaba1d64c5f116';

/** The demo mUSD faucet. `mint_shielded` on it is step 5 of onboarding. */
export const FAUCET_ADDRESS = '4fc92e152e8d854ef9337275504244e18bd6e3d7d41fd81ed2dabf62be78e92f';

/** The colour of that faucet's token, labelled mUSD wherever it appears. */
export const MUSD_COLOUR = '1a2917fbed8b5ce44d12ebc7d337689045f6c96a6bbd39cf3d8691ab310ef6a6';

/** Native NIGHT: 32 zero bytes. */
export const NIGHT_COLOUR = '0'.repeat(64);

/**
 * The fee sponsor's unshielded address. Every Passport transaction on stagenet
 * is funded from it, so it is both the input owner on the activation grant and
 * the owner of the fee-change outputs on every other step.
 */
export const SPONSOR_ADDRESS =
  'mn_addr_stagenet127xnp9uuxwhh7a8an77mxv02ypt6u09xkk63c9zvdkjsrj4mj68qg7c5ad';

/* -------------------------------------------------------------------------- */
/* The 1AM explorer                                                           */
/* -------------------------------------------------------------------------- */

/**
 * ONE constant, and three builders over it.
 *
 * Stagenet support in the 1AM explorer is being built in parallel with this
 * page, so the route shapes below are provisional. They are gathered here on
 * purpose: when the explorer reports its exact patterns, this block is the
 * only thing that changes and every link on the page follows.
 *
 * Nothing on the page DEPENDS on these links resolving. Each one sits beside
 * the value it links to in full, and every row still carries the indexer query
 * and a `curl` that reproduces it, so a dead explorer costs a reviewer a
 * convenience rather than the evidence.
 */
export const EXPLORER_BASE = 'https://explorer.1am.xyz';

/** The network query parameter every explorer route carries. */
export const EXPLORER_NETWORK = 'stagenet';

export function explorerTxUrl(hash: string): string {
  return `${EXPLORER_BASE}/tx/${hash}?network=${EXPLORER_NETWORK}`;
}

export function explorerContractUrl(address: string): string {
  return `${EXPLORER_BASE}/contract/${address}?network=${EXPLORER_NETWORK}`;
}

export function explorerBlockUrl(height: number): string {
  return `${EXPLORER_BASE}/block/${height}?network=${EXPLORER_NETWORK}`;
}

/* -------------------------------------------------------------------------- */
/* Query plumbing                                                             */
/* -------------------------------------------------------------------------- */

/** A query as it was actually sent, kept so the page can show and reproduce it. */
export interface RecordedQuery {
  /** What this query was asked FOR, in the reviewer's vocabulary. */
  readonly label: string;
  /** The GraphQL document, verbatim. */
  readonly text: string;
}

/** The `curl` that reproduces a recorded query, ready to paste into a shell. */
export function curlFor(query: RecordedQuery): string {
  const body = JSON.stringify({ query: query.text });
  /* Single-quoted shell string: the only character that needs handling is the
     single quote itself, and JSON has already escaped everything else. */
  const quoted = body.replace(/'/g, `'\\''`);
  return [
    `curl -s -X POST ${INDEXER_URL} \\`,
    `  -H 'content-type: application/json' \\`,
    `  -d '${quoted}'`,
  ].join('\n');
}

/** Raised when the indexer answers with GraphQL errors or an HTTP failure. */
export class IndexerError extends Error {
  constructor(
    message: string,
    readonly query: RecordedQuery,
  ) {
    super(message);
    this.name = 'IndexerError';
  }
}

/**
 * Runs one query and returns its data together with the document that produced
 * it. A GraphQL `errors` array is a failure here even when `data` is present:
 * a partially answered query would put a half-read row on the page, and a
 * half-read row is indistinguishable on screen from a fully read one.
 */
export async function runQuery<T>(
  label: string,
  text: string,
): Promise<{ data: T; query: RecordedQuery }> {
  const query: RecordedQuery = { label, text };
  let response: Response;
  try {
    response = await fetch(INDEXER_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: text }),
    });
  } catch (cause) {
    throw new IndexerError(
      `The indexer could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
      query,
    );
  }
  if (!response.ok) {
    throw new IndexerError(`The indexer answered HTTP ${response.status}.`, query);
  }
  const body = (await response.json()) as {
    data?: T;
    errors?: Array<{ message?: string }>;
  };
  if (body.errors?.length) {
    const detail = body.errors.map((error) => error.message ?? 'unknown').join('; ');
    throw new IndexerError(`The indexer refused the query: ${detail}`, query);
  }
  if (body.data === undefined || body.data === null) {
    throw new IndexerError('The indexer answered with no data.', query);
  }
  return { data: body.data, query };
}

/* -------------------------------------------------------------------------- */
/* The shapes the indexer answers with                                        */
/* -------------------------------------------------------------------------- */

export interface UnshieldedOutput {
  readonly owner: string;
  readonly tokenType: string;
  readonly value: string;
}

export interface ActionTransaction {
  readonly hash: string;
  readonly block: { readonly height: number; readonly timestamp: number };
  readonly transactionResult?: { readonly status: string } | null;
  readonly fee?: string | null;
  readonly unshieldedCreatedOutputs?: readonly UnshieldedOutput[] | null;
  readonly unshieldedSpentOutputs?: readonly UnshieldedOutput[] | null;
}

export interface ContractActionRow {
  readonly __typename: 'ContractDeploy' | 'ContractCall' | 'ContractUpdate';
  /** Present on `ContractCall` only — the circuit that was invoked. */
  readonly entryPoint?: string | null;
  /** The contract's own token balances AFTER this action. */
  readonly unshieldedBalances?: ReadonlyArray<{
    readonly tokenType: string;
    readonly amount: string;
  }> | null;
  readonly transaction: ActionTransaction;
}

/**
 * The selection set every action row on the page is built from.
 *
 * `transactionResult`, `fee`, and the unshielded output lists live on
 * `RegularTransaction` rather than on the `Transaction` interface, so they
 * arrive through an inline fragment and are optional on the type above. The
 * per-action `state` is deliberately NOT selected: it is ~19 KB of hex per
 * action, and the two places that genuinely need a historical state ask for
 * exactly those two.
 */
export const ACTION_FIELDS = `fragment ActionFields on ContractAction {
  __typename
  ... on ContractCall {
    entryPoint
    unshieldedBalances { tokenType amount }
  }
  ... on ContractDeploy {
    unshieldedBalances { tokenType amount }
  }
  transaction {
    hash
    block { height timestamp }
    ... on RegularTransaction {
      transactionResult { status }
      fee
      unshieldedCreatedOutputs { owner tokenType value }
      unshieldedSpentOutputs { owner tokenType value }
    }
  }
}`;

/**
 * Every action on a contract, oldest first.
 *
 * The indexer answers newest first; the order is reversed here because a
 * timeline reads forwards and because every "what was the balance before this"
 * question in `verify.ts` is answered by the row before it.
 */
export async function contractActions(
  label: string,
  address: string,
  options: { readonly limit?: number; readonly upToHeight?: number } = {},
): Promise<{ actions: ContractActionRow[]; query: RecordedQuery }> {
  const limit = options.limit ?? 200;
  const offset =
    options.upToHeight === undefined ? '' : `, offset: { height: ${options.upToHeight} }`;
  const text = `${ACTION_FIELDS}

query Actions {
  contract(address: "${address}"${offset}) {
    actions(limit: ${limit}) { ...ActionFields }
  }
}`;
  const { data, query } = await runQuery<{
    contract: { actions: ContractActionRow[] } | null;
  }>(label, text);
  const actions = data.contract?.actions ?? [];
  return { actions: [...actions].reverse(), query };
}

/** The current serialised state of a contract, as 2-character-per-byte hex. */
export async function contractState(
  label: string,
  address: string,
): Promise<{ state: string | null; query: RecordedQuery }> {
  const text = `query State {
  contract(address: "${address}") { address state }
}`;
  const { data, query } = await runQuery<{
    contract: { address: string; state: string } | null;
  }>(label, text);
  return { state: data.contract?.state ?? null, query };
}

/**
 * The state a contract was left in by one particular transaction.
 *
 * This is what makes "the name was registered by THIS transaction" a
 * measurement rather than a guess: decode the state the call produced, and the
 * name is either in the registry's `domains` map or it is not.
 */
export async function contractStateAfterTx(
  label: string,
  address: string,
  txHash: string,
): Promise<{ state: string | null; query: RecordedQuery }> {
  const text = `query StateAfterTransaction {
  contractAction(
    address: "${address}"
    offset: { transactionOffset: { hash: "${txHash}" } }
  ) { state }
}`;
  const { data, query } = await runQuery<{ contractAction: { state: string } | null }>(
    label,
    text,
  );
  return { state: data.contractAction?.state ?? null, query };
}

/* -------------------------------------------------------------------------- */
/* Small value helpers                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A Midnight contract address in the raw 64-hex form the indexer takes.
 * Throws rather than guessing — see the module header.
 */
export function normaliseContractAddress(value: string): string {
  const normalised = value.trim().toLowerCase().replace(/^0x/, '').replace(/^0200/, '');
  if (!/^[0-9a-f]{64}$/.test(normalised)) {
    throw new Error(`Not a Midnight contract address: ${value}`);
  }
  return normalised;
}

export function hexToBytes(value: string): Uint8Array {
  const normalised = value.replace(/^0x/, '');
  if (normalised.length % 2 !== 0) throw new Error(`Odd-length hex string: ${value}`);
  const bytes = new Uint8Array(normalised.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalised.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(value: Uint8Array): string {
  let hex = '';
  for (const byte of value) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** The SHA-256 of a serialised state, so two reviewers can compare one line. */
export async function digestOf(stateHex: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', hexToBytes(stateHex) as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}
