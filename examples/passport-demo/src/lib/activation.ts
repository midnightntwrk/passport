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

/**
 * The four labels an activation writes to the activity trail, as constants,
 * because {@link activationRetryRowId} has to tell them apart by identity and a
 * literal repeated in two files is a rule that drifts. `Opening balance
 * deposited` and `Opening balance not deposited` differ by one word, which is
 * exactly the kind of pair a substring match gets wrong.
 */
export const ACTIVATION_DEPOSITED_LABEL = 'Opening balance deposited';
export const ACTIVATION_STABLECOIN_LABEL = 'Stablecoin deposited';
/** The sponsor said no, in one attempt. Written by the classifier below. */
export const ACTIVATION_REFUSED_LABEL = 'Opening balance not deposited';
/** The whole retry schedule ran out. Written by `fundAccountOnce` in `App.tsx`. */
export const ACTIVATION_EXHAUSTED_LABEL = 'Opening balance not added';

/**
 * THE GRANT'S TWO FIGURES, ONCE.
 *
 * The sponsor's opening grant is fixed — the same two amounts for every
 * Passport — so this device can name them before the sponsor has answered
 * without inventing anything. They live here, beside the labels, because the
 * copy below is built from them and a figure written out a second time in a
 * screen is a figure that drifts from the one the sponsor actually deposits.
 *
 * `OPENING_NIGHT` is a STRING. `0.002` as a number is not `0.002`, and a
 * trailing-digit surprise under a balance is exactly the kind of thing this
 * row exists to avoid.
 */
export const OPENING_MUSD = 100;
export const OPENING_NIGHT = '0.002';

/**
 * What the pending opening-balance row says, now that it names the figures.
 *
 * Asked for on 2026/09/03: the reviewer wanted the expected amounts VISIBLE
 * while the deposits are pending, rather than a row that admits only that
 * something unnamed is coming. Naming them is safe in a way that naming an
 * arbitrary number would not have been — the grant is the sponsor's fixed one,
 * and it is the figure every Passport gets.
 *
 * The row is only ever the PENDING one. It carries no transaction, it is never
 * added to a balance, and it is gone the moment the account holds something or
 * the trail says the grant is not coming — see {@link openingBalanceOnTheWay},
 * which is the whole of that rule and is unchanged by this copy.
 *
 * Deliberately in NEITHER label set above: this is not a row an activation
 * writes to the trail, so {@link activationRetryRowId} must not see it as a
 * landing or as a failure. Both sets match by identity, and this label is
 * distinct from all four.
 */
export const OPENING_BALANCE_ON_THE_WAY_LABEL = 'Opening balance on the way';
export const OPENING_BALANCE_ON_THE_WAY_DETAIL = `${OPENING_MUSD} mUSD and ${OPENING_NIGHT} NIGHT are being added to your account.`;

const ACTIVATION_FAILURE_LABELS = new Set<string>([
  ACTIVATION_REFUSED_LABEL,
  ACTIVATION_EXHAUSTED_LABEL,
]);
const ACTIVATION_LANDED_LABELS = new Set<string>([
  ACTIVATION_DEPOSITED_LABEL,
  ACTIVATION_STABLECOIN_LABEL,
]);

/**
 * Which trail row — if any — should carry a "Retry" the reader can press.
 *
 * THE SECOND HALF OF THE 2026/09/02 DEAD END. A Passport can finish onboarding
 * with its name and its stablecoin on the trail and no opening NIGHT, because
 * the two are independent asks and the grant has its own ten-minute schedule to
 * run out of. When it does, the trail says so — and said only that. The grant
 * is only ever marked done on evidence that it landed, so asking again was
 * always going to work; there was simply nothing to press.
 *
 * `entries` are newest first, as `addActivity` writes them. The rule is the
 * newest activation row wins: a failure with nothing after it earns the
 * control, and a failure with a landed deposit ABOVE it earns nothing, because
 * a retry beside a grant that has since arrived would ask the sponsor for a
 * second one. Rows that are not about activation are stepped over, so a send
 * made after a failed grant does not hide it.
 *
 * At most one id comes back. A schedule that has been spent twice leaves two
 * failure rows and one of them is history; a control on both would be the same
 * action offered twice, with the older one describing an attempt that is over.
 */
export function activationRetryRowId(
  entries: readonly { id: string; label: string }[],
): string | null {
  for (const entry of entries) {
    if (ACTIVATION_LANDED_LABELS.has(entry.label)) return null;
    if (ACTIVATION_FAILURE_LABELS.has(entry.label)) return entry.id;
  }
  return null;
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
 * Classifies one `/fund-account` answer for one Passport account.
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
          label: ACTIVATION_REFUSED_LABEL,
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
      label: ACTIVATION_DEPOSITED_LABEL,
      detail: `The sponsor deposited ${
        typeof body.amountAtomic === 'string' ? body.amountAtomic : 'an opening'
      } atomic NIGHT into your account ${compactAddress(contractAddress)}.${
        assetError ? ` The stablecoin half did not land: ${assetError}` : ''
      }`,
      status: 'complete',
      ...(txHash ? { txHash } : {}),
    },
  ];
  if (assetTx) {
    activities.push({
      label: ACTIVATION_STABLECOIN_LABEL,
      detail: `${
        typeof body.assetAmount === 'string' ? body.assetAmount : 'The sponsor’s stablecoin'
      } went into your account ${compactAddress(contractAddress)} alongside the NIGHT.`,
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

/**
 * Whether the opening balance should be shown as ON ITS WAY.
 *
 * Asked for directly on 2026/09/02: "show the expected opening balance as
 * pending from the moment activation begins" — and never as a settled figure
 * until the chain shows it. Activation begins the moment this Passport has an
 * account for a grant to be deposited INTO, which is what `hasAccount` means;
 * from then until either the money shows up or the sponsor gives up, the
 * honest reading of an empty account is "it is coming", not "you have nothing".
 *
 * Three conditions, and each one is a way of misleading somebody if dropped:
 *
 *   `hasAccount`   — no account, nothing has been asked for, and a line
 *                    promising an opening balance would be a promise nobody
 *                    made.
 *   `holdsNothing` — the moment the account holds ANYTHING the balance itself
 *                    is the answer, and a line saying it is still on its way
 *                    would be contradicting the figure printed above it.
 *   no failure row — the sponsor refusing, or its ten minutes running out,
 *                    ends the wait. The trail already says so in the sponsor's
 *                    own words and carries the control to ask again; a line
 *                    still saying "on the way" beside it would be the screen
 *                    telling two stories at once.
 *
 * Pure over the trail the screens already hold, so Home and Assets cannot
 * disagree about whether a Passport is still waiting for its first money.
 */
export function openingBalanceOnTheWay(input: {
  hasAccount: boolean;
  holdsNothing: boolean;
  entries: readonly { label: string }[];
}): boolean {
  if (!input.hasAccount || !input.holdsNothing) return false;
  return !input.entries.some((entry) => ACTIVATION_FAILURE_LABELS.has(entry.label));
}
