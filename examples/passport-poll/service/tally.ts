/* ===========================================================================
 * The tally rules
 * ===========================================================================
 *
 * Everything the vote-tally service decides lives here, as pure functions over
 * a plain state object. The HTTP layer in `server.ts` does nothing but parse a
 * request, call one of these, and serialise the answer — which is why these
 * are the things the tests exercise.
 *
 * Three rules, and they are the whole product:
 *
 *   1. One vote per account. The account is the Passport account the person
 *      signed in with, and it is the identity the tally is keyed on. A second
 *      vote from the same account is refused, not overwritten: a poll that
 *      quietly lets you change your mind is a poll whose totals nobody can
 *      reason about.
 *   2. A vote carries a proof. The proof is what Passport handed back when the
 *      person consented, and a vote without one is not recorded at all.
 *   3. Only options the poll actually offers are countable.
 *
 * Nothing here trusts its input. Every field is length-capped and shape-checked
 * before it is stored, because the caller is a web page on another origin.
 * ========================================================================= */

export const MAX_QUESTION_LENGTH = 140;
export const MAX_OPTION_LENGTH = 60;
export const MAX_NAME_LENGTH = 80;
export const MAX_ACCOUNT_LENGTH = 512;
export const MAX_PROOF_LENGTH = 256;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;

export interface Poll {
  readonly id: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly createdAt: number;
}

/**
 * What Passport handed back for this account, recorded verbatim.
 *
 * `exchange` is the request/nonce pair the app minted and Passport echoed —
 * the reference the consent was answered under. `signature` and `publicKey`
 * are filled in only when the reply came over a channel that carries one; the
 * pop-up profile channel does not, and the app says so rather than inventing
 * something. See the README.
 */
export interface VoteProof {
  readonly exchange: string;
  readonly signature?: string;
  readonly publicKey?: string;
}

export interface Vote {
  readonly pollId: string;
  readonly option: string;
  readonly account: string;
  readonly name?: string;
  readonly proof: VoteProof;
  readonly at: number;
}

export interface TallyState {
  polls: Poll[];
  votes: Vote[];
}

export function emptyState(): TallyState {
  return { polls: [], votes: [] };
}

export type CreatePollFailure =
  | 'question-missing'
  | 'question-too-long'
  | 'too-few-options'
  | 'too-many-options'
  | 'option-too-long'
  | 'duplicate-option';

export type CastFailure =
  | 'unknown-poll'
  | 'unknown-option'
  | 'account-missing'
  | 'proof-missing'
  | 'already-voted';

export type Outcome<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: E };

const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });
const no = <E>(reason: E): { ok: false; reason: E } => ({ ok: false, reason });

function tidy(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/* ---------------------------------------------------------------------------
 * Polls
 * ------------------------------------------------------------------------ */

export function createPoll(
  state: TallyState,
  input: { question: unknown; options: unknown },
  now: number = Date.now(),
  id: string = randomId(),
): Outcome<Poll, CreatePollFailure> {
  const question = tidy(input.question);
  if (question.length === 0) return no('question-missing');
  if (question.length > MAX_QUESTION_LENGTH) return no('question-too-long');

  const raw = Array.isArray(input.options) ? input.options.map(tidy).filter((o) => o.length > 0) : [];
  if (raw.length < MIN_OPTIONS) return no('too-few-options');
  if (raw.length > MAX_OPTIONS) return no('too-many-options');
  if (raw.some((option) => option.length > MAX_OPTION_LENGTH)) return no('option-too-long');
  if (new Set(raw.map((o) => o.toLowerCase())).size !== raw.length) return no('duplicate-option');

  const poll: Poll = { id, question, options: raw, createdAt: now };
  state.polls.push(poll);
  return ok(poll);
}

export function findPoll(state: TallyState, pollId: string): Poll | null {
  return state.polls.find((poll) => poll.id === pollId) ?? null;
}

/* ---------------------------------------------------------------------------
 * Votes
 * ------------------------------------------------------------------------ */

export function hasVoted(state: TallyState, pollId: string, account: string): boolean {
  return state.votes.some((vote) => vote.pollId === pollId && vote.account === account);
}

export function castVote(
  state: TallyState,
  input: { pollId: unknown; option: unknown; account: unknown; name?: unknown; proof?: unknown },
  now: number = Date.now(),
): Outcome<Vote, CastFailure> {
  const pollId = tidy(input.pollId);
  const poll = findPoll(state, pollId);
  if (!poll) return no('unknown-poll');

  const option = tidy(input.option);
  if (!poll.options.includes(option)) return no('unknown-option');

  const account = tidy(input.account).slice(0, MAX_ACCOUNT_LENGTH);
  if (account.length === 0) return no('account-missing');

  const proof = readProof(input.proof);
  if (!proof) return no('proof-missing');

  /* Rule one, and the reason this service exists at all. */
  if (hasVoted(state, poll.id, account)) return no('already-voted');

  const name = tidy(input.name).slice(0, MAX_NAME_LENGTH);
  const vote: Vote = {
    pollId: poll.id,
    option,
    account,
    ...(name.length > 0 ? { name } : {}),
    proof,
    at: now,
  };
  state.votes.push(vote);
  return ok(vote);
}

function readProof(value: unknown): VoteProof | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const exchange = tidy(record.exchange).slice(0, MAX_PROOF_LENGTH);
  if (exchange.length === 0) return null;
  const signature = tidy(record.signature).slice(0, MAX_PROOF_LENGTH);
  const publicKey = tidy(record.publicKey).slice(0, MAX_PROOF_LENGTH);
  return {
    exchange,
    ...(signature.length > 0 ? { signature } : {}),
    ...(publicKey.length > 0 ? { publicKey } : {}),
  };
}

/* ---------------------------------------------------------------------------
 * Results
 * ------------------------------------------------------------------------ */

export interface OptionResult {
  readonly option: string;
  readonly count: number;
  /** Whole percent of the votes cast, 0 when nobody has voted yet. */
  readonly share: number;
  /** The names people chose to share, in the order they voted. */
  readonly voters: readonly string[];
}

export interface PollResults {
  readonly poll: Poll;
  readonly total: number;
  readonly options: readonly OptionResult[];
  /** Account address to proof, newest last. This is the "Verify" list. */
  readonly receipts: readonly {
    readonly account: string;
    readonly name?: string;
    readonly option: string;
    readonly proof: VoteProof;
    readonly at: number;
  }[];
}

export function results(state: TallyState, pollId: string): PollResults | null {
  const poll = findPoll(state, pollId);
  if (!poll) return null;
  const cast = state.votes.filter((vote) => vote.pollId === poll.id);
  const total = cast.length;
  return {
    poll,
    total,
    options: poll.options.map((option) => {
      const forOption = cast.filter((vote) => vote.option === option);
      return {
        option,
        count: forOption.length,
        share: total === 0 ? 0 : Math.round((forOption.length / total) * 100),
        voters: forOption.map((vote) => vote.name ?? shorten(vote.account)),
      };
    }),
    receipts: cast.map((vote) => ({
      account: vote.account,
      ...(vote.name === undefined ? {} : { name: vote.name }),
      option: vote.option,
      proof: vote.proof,
      at: vote.at,
    })),
  };
}

/** A long address, ends kept, middle dropped. Used only where a name is absent. */
export function shorten(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 10)}…${value.slice(-6)}`;
}

export function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}
