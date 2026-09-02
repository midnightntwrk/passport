/**
 * The two-leg send, as a record that survives the tab it started in.
 *
 * WHY THIS EXISTS (2026/09/02)
 * ---------------------------
 * Paying a Passport is two transactions — the amount leaves the sender's
 * account, and a second, permissionless call pays it into the recipient's — and
 * until this date every fact about a run in progress lived in one closure in
 * `App.tsx`: whether the first leg had landed, what the wallet held before it
 * did, which note the second leg was waiting for. A reload, a backgrounded tab,
 * or a browser that reclaimed the page took all of it, and what was left was
 * value parked at the sender's own receiving address with nothing on screen
 * offering to finish the transfer or put it back. A shielded note parked that
 * way had no control at all: Home's sweep card only sees unshielded value.
 *
 * So the run is a RECORD, written before the first leg is submitted and again
 * at every transition, and this module owns its shape, its reading back, and
 * the two decisions a retry needs: whether a failure is worth trying again, and
 * how long to wait before doing so.
 *
 * WHAT IS HERE AND WHAT IS NOT
 * ----------------------------
 * Nothing here touches React, the DOM, `fetch`, `localStorage`, or the wallet
 * SDK. The orchestrator in `App.tsx` submits the legs, polls for the arrival,
 * and holds the passkey ceremony; this module is handed what came back and says
 * what it means. That split is the point: the rules that decide whether
 * somebody's half-finished payment is retried, abandoned, or resumed are the
 * ones with a wrong answer in them, and they are drilled directly in
 * `src/lib/sendLegs.test.ts` rather than through a screen.
 */

/** Which of the two ledgers a pending send moves value on. */
export type PendingSendKind = 'night' | 'shielded';

/**
 * How far a send has got.
 *
 * `withdraw` with no `withdrawTxHash` is a run that has not spent anything yet;
 * the same leg WITH one has spent and is waiting to be seen. `settle` is the
 * wait for the wallet to hold what it withdrew, `deposit` is the paying leg,
 * `done` is paid, and `failed` is a run that stopped with a reason on it.
 *
 * None of these is a state a record may be silently dropped from: a `settle`,
 * `deposit`, or `failed` record is value the sender has moved and not yet
 * given to anybody, and Home offers to carry each of them on.
 */
export type PendingSendLeg = 'withdraw' | 'settle' | 'deposit' | 'done' | 'failed';

/** Who is being paid — the words on screen, and the account that receives. */
export interface PendingSendRecipient {
  /** What the sender typed and what every sentence about this run calls them. */
  label: string;
  /** The account contract the paying leg deposits into. */
  accountAddress: string;
}

/**
 * What the settle step is waiting for, recorded BEFORE the first leg goes out.
 *
 * A shielded run records every note identity the wallet already held, because
 * the note to deposit is the one whose nonce was not among them — see
 * `lib/shieldedNote.ts`, where that rule lives. A NIGHT run records the balance
 * it started from, because the arrival is a RISE of at least the amount and not
 * a total: a wallet that already held enough would otherwise let the paying leg
 * run before anything had arrived at all.
 */
export type PendingSendExpectation =
  | { heldBeforeIds: string[] }
  | { unshieldedBefore: string };

/** How many times one leg is attempted before the run stops. */
export const SEND_LEG_ATTEMPTS = 3;

/** One two-leg send, as it is written down. */
export interface PendingSend {
  /** Stable for the life of the run, including across reloads. */
  id: string;
  kind: PendingSendKind;
  recipient: PendingSendRecipient;
  /** Atomic units, as a string: `JSON` has no `bigint`. */
  amount: string;
  /** The ledger colour a shielded run moves. Absent for NIGHT. */
  tokenType?: string;
  /** The colour the run is denominated in — NIGHT's own, or `tokenType`. */
  colourHex: string;
  /** Where the first leg pays: the sender's own address, never the recipient's. */
  ownReceivingAddress: string;
  leg: PendingSendLeg;
  /** Set the moment the first leg is accepted. Its presence is what says so. */
  withdrawTxHash?: string;
  expectedNote?: PendingSendExpectation;
  attempts: { withdraw: number; deposit: number };
  lastError?: { message: string; retryable: boolean };
  createdAt: string;
  updatedAt: string;
  /** The feed row this run writes into, so a resumed run does not open a second. */
  activityId?: string;
}

/**
 * Where one Passport's unfinished sends live.
 *
 * Keyed by credential and version-prefixed, exactly as the activity trail is:
 * a browser can hold several Passports, and one Passport's half-finished
 * payment is not another's to offer to finish.
 */
export function pendingSendsStorageKey(credentialId: string): string {
  return `midnight.passport.sends.v1:${credentialId}`;
}

function isLeg(value: unknown): value is PendingSendLeg {
  return (
    value === 'withdraw' ||
    value === 'settle' ||
    value === 'deposit' ||
    value === 'done' ||
    value === 'failed'
  );
}

/** An atomic amount as it may be stored: digits, and a value above zero. */
function isAmount(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]+$/.test(value) && BigInt(value) > 0n;
}

function readExpectation(value: unknown): PendingSendExpectation | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const row = value as Record<string, unknown>;
  if (Array.isArray(row.heldBeforeIds)) {
    const ids = row.heldBeforeIds.filter((id): id is string => typeof id === 'string');
    return { heldBeforeIds: ids };
  }
  if (isAmount(row.unshieldedBefore) || row.unshieldedBefore === '0') {
    return { unshieldedBefore: row.unshieldedBefore as string };
  }
  return undefined;
}

function readAttempts(value: unknown): { withdraw: number; deposit: number } {
  if (typeof value !== 'object' || value === null) return { withdraw: 0, deposit: 0 };
  const row = value as Record<string, unknown>;
  const count = (raw: unknown) =>
    typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0;
  return { withdraw: count(row.withdraw), deposit: count(row.deposit) };
}

/**
 * Reads stored records back, keeping only rows that are entirely well-formed.
 *
 * Every refusal here is a refusal to offer somebody a Continue button over a
 * run that cannot be run: a record with no amount has nothing to resume, one
 * with no recipient account has nowhere to pay, and one with an unknown leg
 * would fall through the orchestrator's own dispatch. Storage is a place other
 * code can write to, and this is the only reader.
 *
 * A parse failure is not an error condition — it is a browser with nothing
 * stored — and the answer is no pending sends.
 */
export function readPendingSends(raw: string | null | undefined): PendingSend[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const records: PendingSend[] = [];
  for (const candidate of parsed) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const row = candidate as Record<string, unknown>;
    if (typeof row.id !== 'string' || !row.id) continue;
    if (row.kind !== 'night' && row.kind !== 'shielded') continue;
    if (!isLeg(row.leg)) continue;
    if (!isAmount(row.amount)) continue;
    if (typeof row.colourHex !== 'string' || !row.colourHex) continue;
    if (typeof row.ownReceivingAddress !== 'string' || !row.ownReceivingAddress) continue;
    const recipient = row.recipient as Record<string, unknown> | undefined;
    if (typeof recipient !== 'object' || recipient === null) continue;
    if (typeof recipient.label !== 'string' || !recipient.label) continue;
    if (typeof recipient.accountAddress !== 'string' || !recipient.accountAddress) continue;
    if (typeof row.createdAt !== 'string' || Number.isNaN(Date.parse(row.createdAt))) continue;
    if (typeof row.updatedAt !== 'string' || Number.isNaN(Date.parse(row.updatedAt))) continue;
    /* A shielded run with no colour cannot name the note it is waiting for, so
       it is not a run anything could carry on. */
    if (row.kind === 'shielded' && (typeof row.tokenType !== 'string' || !row.tokenType)) continue;
    const record: PendingSend = {
      id: row.id,
      kind: row.kind,
      recipient: { label: recipient.label, accountAddress: recipient.accountAddress },
      amount: row.amount,
      colourHex: row.colourHex,
      ownReceivingAddress: row.ownReceivingAddress,
      leg: row.leg,
      attempts: readAttempts(row.attempts),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    if (typeof row.tokenType === 'string' && row.tokenType) record.tokenType = row.tokenType;
    if (typeof row.withdrawTxHash === 'string' && row.withdrawTxHash) {
      record.withdrawTxHash = row.withdrawTxHash;
    }
    const expectation = readExpectation(row.expectedNote);
    if (expectation) record.expectedNote = expectation;
    const lastError = row.lastError as Record<string, unknown> | undefined;
    if (
      typeof lastError === 'object' &&
      lastError !== null &&
      typeof lastError.message === 'string' &&
      typeof lastError.retryable === 'boolean'
    ) {
      record.lastError = { message: lastError.message, retryable: lastError.retryable };
    }
    if (typeof row.activityId === 'string' && row.activityId) record.activityId = row.activityId;
    records.push(record);
  }
  return records;
}

/**
 * The records as they are written back.
 *
 * A `done` run is dropped rather than kept: it is finished, the feed already
 * carries it, and a Home card offering to continue a completed payment is how
 * somebody pays twice. Only the fields {@link readPendingSends} accepts are
 * written — a field the reader discards is how a store comes to hold things
 * nobody can explain.
 */
export function serialisePendingSends(records: readonly PendingSend[]): string {
  const kept = records
    .filter((record) => record.leg !== 'done')
    .map((record) => ({
      id: record.id,
      kind: record.kind,
      recipient: {
        label: record.recipient.label,
        accountAddress: record.recipient.accountAddress,
      },
      amount: record.amount,
      colourHex: record.colourHex,
      ownReceivingAddress: record.ownReceivingAddress,
      leg: record.leg,
      attempts: { withdraw: record.attempts.withdraw, deposit: record.attempts.deposit },
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.tokenType ? { tokenType: record.tokenType } : {}),
      ...(record.withdrawTxHash ? { withdrawTxHash: record.withdrawTxHash } : {}),
      ...(record.expectedNote ? { expectedNote: record.expectedNote } : {}),
      ...(record.lastError ? { lastError: record.lastError } : {}),
      ...(record.activityId ? { activityId: record.activityId } : {}),
    }));
  return JSON.stringify(kept);
}

/* -------------------------------------------------------------------------- */
/* What a failure means                                                        */
/* -------------------------------------------------------------------------- */

/** What one failed leg is, once it has been read. */
export interface LegErrorVerdict {
  /** Whether attempting the same leg again could plausibly succeed. */
  retryable: boolean;
  /**
   * Whether the retry has to be BUILT again — state re-read, proof re-made —
   * rather than resubmitted. A transaction the node turned down was proved
   * against a state that has since moved; resubmitting the same bytes earns the
   * same refusal.
   */
  rebuild: boolean;
  /** What the person waiting is told. Never an SDK or Effect string. */
  message: string;
}

/** How deep the `cause` chain is walked. Deep enough for every wrapper we set. */
const CAUSE_DEPTH = 8;

function chainOf(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let node: unknown = error;
  for (let depth = 0; depth < CAUSE_DEPTH && node !== undefined && node !== null; depth += 1) {
    chain.push(node);
    node = (node as { cause?: unknown }).cause;
  }
  return chain;
}

function messageOf(node: unknown): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'object' && node !== null) {
    const message = (node as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return '';
}

function nameOf(node: unknown): string {
  if (typeof node === 'object' && node !== null) {
    const name = (node as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return '';
}

/**
 * A refusal the transaction runtime has already classified for us.
 *
 * Duck-typed rather than imported: the runtime that raises it is a fenced
 * module this one must not drag in, and what matters is the three fields it
 * promises — `retryable`, `userMessage`, and the `stage` it failed at.
 */
function balancingVerdict(node: unknown): LegErrorVerdict | null {
  if (nameOf(node) !== 'BalancingFailure') return null;
  const row = node as { retryable?: unknown; userMessage?: unknown };
  if (typeof row.retryable !== 'boolean') return null;
  if (typeof row.userMessage !== 'string' || !row.userMessage) return null;
  return { retryable: row.retryable, rebuild: row.retryable, message: row.userMessage };
}

/**
 * What to do about one failed leg.
 *
 * The chain is walked whole rather than read at its head, because every layer
 * between the SDK and the screen wraps rather than replaces: the runtime's own
 * classification, the node's refusal, and the account module's sentence about
 * which circuit was called are three different depths of the same failure, and
 * the head of the chain is the least specific of them.
 *
 * The order below is the order of authority, not the order of the chain:
 *
 *   1. A classification the runtime already made. It saw the balancing attempt
 *      and nothing further out knows more about it than that.
 *   2. NOT ENOUGH MONEY, which no amount of retrying changes. Checked before
 *      the node refusals precisely because it can arrive wrapped in one, and
 *      a retry schedule spent on it is three more passkey prompts for a send
 *      that could never have gone.
 *   3. A refusal from the NODE, or a submission that never got there. Both are
 *      retryable and both need REBUILDING: the transaction was proved against
 *      a state that has moved, so the same bytes earn the same answer.
 *
 * Anything else is reported as it came, and not retried. An unrecognised
 * failure repeated three times is three chances to make it worse.
 */
export function classifyLegError(error: unknown): LegErrorVerdict {
  const chain = chainOf(error);
  for (const node of chain) {
    const verdict = balancingVerdict(node);
    if (verdict) return verdict;
  }
  for (const node of chain) {
    if (/insufficient funds|insufficient balance|not enough/i.test(messageOf(node))) {
      return {
        retryable: false,
        rebuild: false,
        message: 'There was not enough to cover this step, so nothing further was sent.',
      };
    }
  }
  for (const node of chain) {
    const name = nameOf(node);
    if (
      name === 'SubmissionError' ||
      name === 'CallTxFailedError' ||
      /invalid transaction/i.test(messageOf(node))
    ) {
      return {
        retryable: true,
        rebuild: true,
        message: 'The network turned this step down. Passport is building it again.',
      };
    }
  }
  const head = messageOf(chain[0]);
  return {
    retryable: false,
    rebuild: false,
    message: head || 'This step could not be finished.',
  };
}

/**
 * How long to wait before attempting a leg again.
 *
 * Two seconds, five, ten, then twenty for anything after. The first wait is
 * short because the commonest retryable failure is a fee sponsor whose own
 * change is settling and clears within a block; the cap is twenty because a
 * person is watching a sheet, and a wait longer than that reads as a hang
 * rather than as patience.
 */
export function retryDelayMs(attempt: number): number {
  const ladder = [2_000, 5_000, 10_000, 20_000];
  if (attempt < 0) return ladder[0];
  return ladder[Math.min(attempt, ladder.length - 1)];
}

/* -------------------------------------------------------------------------- */
/* What the Send sheet says about a failure                                    */
/* -------------------------------------------------------------------------- */

/** What the sheet knows about a refused send when it comes to write about it. */
export interface SendFailureNotice {
  /** Whether the first leg was accepted before the run stopped. */
  legLanded: boolean;
  /** The classified sentence — never an SDK string. */
  message: string;
  /** What is being sent, in the sender's own words: "10 mUSD", "0.5 NIGHT". */
  amountLabel: string;
  /** The asset's own ticker, for the sentence about what did not move. */
  assetSymbol: string;
  /** Whether the thing being sent is a one-of-a-kind item rather than a balance. */
  item?: boolean;
}

/**
 * The sentence a refused send earns.
 *
 * There are two, and until 2026/09/02 there was one. "Nothing was sent — no
 * mUSD moved from your account" was prefixed to EVERY failure, including the
 * ones where the first leg had landed and the amount was sitting at the
 * sender's own Passport — which is the one state where saying "nothing was
 * sent" is not a simplification but a false statement about where somebody's
 * money is. The reader then had no reason to look for the card that would have
 * finished the transfer.
 *
 * So the prefix is gated on the fact, and the other branch says the fact
 * instead: what landed, where it is, what did not, and where to carry on.
 */
export function sendFailureNotice(notice: SendFailureNotice): string {
  if (notice.legLanded) {
    return (
      `Step 1 landed: ${notice.amountLabel} left your account and is waiting at your Passport. ` +
      `Step 2 did not finish: ${notice.message} Continue from Home.`
    );
  }
  const nothing = notice.item
    ? 'the item is still in your account'
    : `no ${notice.assetSymbol} moved from your account`;
  return `Nothing was sent — ${nothing}. ${notice.message}`;
}
