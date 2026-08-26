/**
 * Activation — what the sponsor's `/fund-account` answer actually means.
 *
 * A Passport's account-custody contract (ACC) is deployed empty. The opening
 * balance arrives as a GRANT: the sponsor proves a `deposit_night` — and, where
 * it holds one, a shielded stablecoin deposit as well — straight into the
 * contract. Nothing lands in the wallet, because nothing is ever supposed to:
 * the passkey wallet originates exactly one transaction in its life, and that
 * is the ACC deploy.
 *
 * Asking is easy. Reading the answer is where this has gone wrong twice, so it
 * lives here as a pure function over the response rather than inline in the
 * effect that fires it:
 *
 *   `deposited` — a 200 with both legs in, or the sponsor saying the grant
 *                 already exists. This is the ONLY outcome that writes the
 *                 once-per-account marker, so a contract is only ever marked
 *                 funded on evidence that it is.
 *   `refused`   — a refusal time cannot fix (out of NIGHT, rate ceiling, a
 *                 malformed request). Recorded, and not retried.
 *   `retry`     — a 5xx, a 429, a timeout, a transport failure, or a 200 whose
 *                 stablecoin leg failed. Carries the sponsor's own words for
 *                 the caller's backoff schedule to keep.
 *
 * THE TWO ANSWERS THAT LOOK LIKE RESULTS AND ARE NOT
 * -------------------------------------------------
 * 1. The 503. The sponsor reports itself SYNCING for a minute or two after its
 *    own spends, which is exactly the moment a freshly registered name asks it
 *    for an opening balance. Observed live 2026/08/24, and the account sat at
 *    zero because a single attempt was all it got.
 * 2. The 200 with an `assetError`. The two legs are independent and the
 *    sponsor says so: a 200 can carry a landed NIGHT deposit and a failed
 *    stablecoin half. The sponsor performs only the MISSING leg on the next
 *    request, so this is a retry — no marker, the schedule keeps going, and
 *    the NIGHT already in the account shows up through the balance refresh.
 *    Observed live 2026/08/25: one account opened with NIGHT and no mUSD, and
 *    stopped asking, because the marker had already been written a few lines
 *    above the check that was supposed to prevent exactly this.
 *
 * The function returns a PLAN rather than performing anything: which outcome,
 * whether to write the marker, whether to refresh balances, the stablecoin
 * colour the sponsor named, and the activity rows to add. Every side effect
 * the caller has stays with the caller; every decision comes from here, where
 * it can be held to all of it without a chain.
 */

import { compactAddress } from './address.js';
import { normalisedColourHex } from './colour.js';

/**
 * What came back from one `/fund-account` attempt.
 *
 * A transport failure is a distinct shape rather than a status code, because
 * "nothing arrived" and "the sponsor said no" are different facts and the
 * taxonomy below depends on telling them apart.
 */
export type FundAccountAnswer =
  /** Unreachable, aborted, or past the round-trip ceiling. Nothing arrived. */
  | { kind: 'transport-failure'; message: string }
  /** A real HTTP answer. `body` is whatever JSON came with it, or `{}`. */
  | { kind: 'response'; ok: boolean; status: number; body: unknown };

/** One row for the activity feed. The caller supplies `source: 'chain'`. */
export interface ActivationActivity {
  label: string;
  detail: string;
  status: 'complete' | 'blocked';
  txHash?: string;
}

/** The stablecoin the sponsor named, where it named one. */
export interface ActivationStablecoin {
  symbol: string;
  colourHex: string;
}

/**
 * What the caller should do about one answer. Deliberately explicit about the
 * two things that used to be decided by where a statement sat in the function:
 * {@link rememberFunded} and {@link refreshBalances}.
 */
export interface ActivationPlan {
  outcome: 'deposited' | 'refused' | 'retry';
  /**
   * The sponsor's own sentence, for a `retry` the schedule will log and a
   * `refused` that reaches the feed. Empty string on `deposited`, which has
   * activity rows instead.
   */
  reason: string;
  /**
   * Whether to write the once-per-account "already asked" marker. TRUE ONLY
   * for `deposited` — a marker written on any other outcome is a Passport that
   * stops asking for a grant it never got.
   */
  rememberFunded: boolean;
  /** Whether to re-read the account's balances: true wherever value moved. */
  refreshBalances: boolean;
  /**
   * The stablecoin colour the sponsor just deposited, or `null`. Fills a gap
   * only — the caller must not overwrite a colour it already holds, because
   * that came from the same service and changing it mid-session would relabel
   * a balance under another colour's name.
   */
  stablecoin: ActivationStablecoin | null;
  /** Rows to add to the activity feed, in order. */
  activities: ActivationActivity[];
}

/** The fields the sponsor may put in a `/fund-account` body. */
interface FundAccountBody {
  txHash?: unknown;
  amountAtomic?: unknown;
  assetTx?: unknown;
  assetAmount?: unknown;
  assetColourHex?: unknown;
  assetSymbol?: unknown;
  assetError?: unknown;
  error?: unknown;
  message?: unknown;
}

/** The refusal codes that mean the grant is already in place. */
const ALREADY_GRANTED_CODES = new Set(['already-activated', 'already-funded']);

function asBody(value: unknown): FundAccountBody {
  return typeof value === 'object' && value !== null ? (value as FundAccountBody) : {};
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * Classifies one `/fund-account` answer for one account contract.
 *
 * Pure: it reads the answer and returns the plan. It writes no marker, adds no
 * activity, and touches no balance — see {@link ActivationPlan}.
 */
export function classifyFundAccountAnswer(
  answer: FundAccountAnswer,
  contractAddress: string,
): ActivationPlan {
  /* Nothing arrived. Nothing is recorded either: a network that is down for
     one attempt is not a verdict on the grant, and the schedule will ask
     again. */
  if (answer.kind === 'transport-failure') {
    return {
      outcome: 'retry',
      reason: answer.message,
      rememberFunded: false,
      refreshBalances: false,
      stablecoin: null,
      activities: [],
    };
  }

  const body = asBody(answer.body);
  const code = typeof body.error === 'string' ? body.error : null;
  const sponsorSentence =
    typeof body.message === 'string' && body.message
      ? body.message
      : `The sponsor answered with status ${answer.status}.`;

  if (!answer.ok) {
    /* The grant already exists. That is the outcome the call wanted, so it is
       recorded as reached — and the marker is written, because asking again
       would only earn the same refusal. */
    if (code !== null && ALREADY_GRANTED_CODES.has(code)) {
      return {
        outcome: 'deposited',
        reason: '',
        rememberFunded: true,
        refreshBalances: true,
        stablecoin: null,
        activities: [],
      };
    }
    /* The sponsor is up but cannot answer YET — it is syncing behind its own
       spends, or shedding load. Waiting is the honest response, so no marker
       is written and no failure is claimed. */
    if (answer.status >= 500 || answer.status === 429) {
      return {
        outcome: 'retry',
        reason: sponsorSentence,
        rememberFunded: false,
        refreshBalances: false,
        stablecoin: null,
        activities: [],
      };
    }
    return {
      outcome: 'refused',
      reason: sponsorSentence,
      rememberFunded: false,
      refreshBalances: false,
      stablecoin: null,
      activities: [
        {
          label: 'Opening balance not deposited',
          detail: sponsorSentence,
          status: 'blocked',
        },
      ],
    };
  }

  /* The sponsor names the colour it just deposited, so a `/status` probe that
     had not answered — or answered before the sponsor had an asset — is
     corrected here. */
  const fundedColour = normalisedColourHex(
    typeof body.assetColourHex === 'string' ? body.assetColourHex : null,
  );
  const stablecoin: ActivationStablecoin | null = fundedColour
    ? {
        symbol:
          typeof body.assetSymbol === 'string' && body.assetSymbol.trim()
            ? body.assetSymbol.trim()
            : 'mUSD',
        colourHex: fundedColour,
      }
    : null;

  const assetTx = asNonEmptyString(body.assetTx);
  const assetError = typeof body.assetError === 'string' ? body.assetError : null;

  /* A landed NIGHT deposit with a FAILED stablecoin half is not a finished
     activation — see the module header. The colour still travels, because the
     sponsor named it and the next attempt will deposit that same colour. */
  if (!assetTx && assetError) {
    return {
      outcome: 'retry',
      reason: assetError,
      rememberFunded: false,
      refreshBalances: true,
      stablecoin,
      activities: [],
    };
  }

  const txHash = typeof body.txHash === 'string' ? body.txHash : undefined;
  const activities: ActivationActivity[] = [
    {
      label: 'Opening balance deposited',
      detail: `The sponsor deposited ${
        typeof body.amountAtomic === 'string' ? body.amountAtomic : 'an opening'
      } atomic NIGHT into your account contract ${compactAddress(contractAddress)}.${
        assetError ? ` The stablecoin half did not land: ${assetError}` : ''
      }`,
      status: 'complete',
      ...(txHash ? { txHash } : {}),
    },
  ];
  if (assetTx) {
    activities.push({
      label: 'Stablecoin deposited',
      detail: `${
        typeof body.assetAmount === 'string' ? body.assetAmount : 'The sponsor’s stablecoin'
      } went into your account contract ${compactAddress(contractAddress)} alongside the NIGHT.`,
      status: 'complete',
      txHash: assetTx,
    });
  }

  return {
    outcome: 'deposited',
    reason: '',
    rememberFunded: true,
    refreshBalances: true,
    stablecoin,
    activities,
  };
}
