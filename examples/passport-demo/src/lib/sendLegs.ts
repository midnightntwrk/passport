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
 * `change` is the third leg, and it exists only for a shielded run that took a
 * WHOLE coin out to pay part of it away — see {@link planShieldedSend}. The
 * recipient has been paid by the time a record reaches it; what is outstanding
 * is the sender's own change, sitting in their wallet rather than their
 * account.
 *
 * None of these is a state a record may be silently dropped from: a `settle`,
 * `deposit`, `change`, or `failed` record is value the sender has moved and not
 * yet given to anybody — or, at `change`, not yet put back — and Home offers to
 * carry each of them on.
 */
export type PendingSendLeg = 'withdraw' | 'settle' | 'deposit' | 'change' | 'done' | 'failed';

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
  /**
   * WHAT LEG ONE REALLY TOOK OUT, which is not always {@link amount}.
   *
   * A shielded run takes the WHOLE coin the account holds of that colour and
   * pays only part of it away — see {@link planShieldedSend} for why a partial
   * withdrawal is not an option on the deployed contract. So the note leg two
   * waits for is worth this, the recipient is paid {@link amount}, and the
   * difference comes back in leg three. Absent on a NIGHT run and on a record
   * written before the third leg existed, where it is simply the amount.
   */
  withdrawAmount?: string;
  /** Set the moment the paying leg is accepted. Its presence is what says so. */
  depositTxHash?: string;
  expectedNote?: PendingSendExpectation;
  attempts: { withdraw: number; deposit: number; change: number };
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
    value === 'change' ||
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

function readAttempts(value: unknown): { withdraw: number; deposit: number; change: number } {
  if (typeof value !== 'object' || value === null) {
    return { withdraw: 0, deposit: 0, change: 0 };
  }
  const row = value as Record<string, unknown>;
  const count = (raw: unknown) =>
    typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0;
  return {
    withdraw: count(row.withdraw),
    deposit: count(row.deposit),
    /* Absent in every record written before the third leg existed, and zero is
       the honest reading: nothing had ever been attempted at it. */
    change: count(row.change),
  };
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
    /* A withdrawn figure SMALLER than the amount is not a record this app ever
       wrote: leg one takes the whole coin, so it is at least what is being
       paid. Read back as absent rather than kept, which leaves the run behaving
       as the two-leg one it looks like. */
    if (isAmount(row.withdrawAmount) && BigInt(row.withdrawAmount) >= BigInt(row.amount)) {
      record.withdrawAmount = row.withdrawAmount;
    }
    if (typeof row.depositTxHash === 'string' && row.depositTxHash) {
      record.depositTxHash = row.depositTxHash;
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
      attempts: {
        withdraw: record.attempts.withdraw,
        deposit: record.attempts.deposit,
        change: record.attempts.change,
      },
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.tokenType ? { tokenType: record.tokenType } : {}),
      ...(record.withdrawTxHash ? { withdrawTxHash: record.withdrawTxHash } : {}),
      ...(record.withdrawAmount ? { withdrawAmount: record.withdrawAmount } : {}),
      ...(record.depositTxHash ? { depositTxHash: record.depositTxHash } : {}),
      ...(record.expectedNote ? { expectedNote: record.expectedNote } : {}),
      ...(record.lastError ? { lastError: record.lastError } : {}),
      ...(record.activityId ? { activityId: record.activityId } : {}),
    }));
  return JSON.stringify(kept);
}

/* -------------------------------------------------------------------------- */
/* How many transactions a shielded payment really is                          */
/* -------------------------------------------------------------------------- */

/** What the three legs of one shielded payment move. */
export interface ShieldedSendPlan {
  /** What leg one takes out of the account: the WHOLE coin, never a part. */
  withdraw: bigint;
  /** What leg two pays the recipient. */
  pay: bigint;
  /** What leg three puts back into the sender's own account, or `null`. */
  change: bigint | null;
  /** How many steps the person watching is told about. */
  steps: 2 | 3;
}

/**
 * WHY A SHIELDED PAYMENT TAKES THE WHOLE COIN OUT (2026/09/03).
 *
 * The deployed account contract holds at most one shielded coin per colour, and
 * `withdraw_shielded` has two branches. Asked for the WHOLE coin it takes the
 * `coins.remove` branch and the entry goes; asked for PART of it, it splits —
 * `sendShielded`, then `sendImmediateShielded` for the remainder and
 * `coins.insertCoin` to re-register it — and the coin that lands back in the
 * account is one the node then refuses every later withdrawal against
 * (`1010 Invalid Transaction: Custom error: 239`, hit live on stagenet). One
 * partial withdrawal therefore costs the account every shielded withdrawal
 * after it, for as long as the account exists.
 *
 * The contract cannot be changed: adding or altering a circuit changes the
 * verifier keys, and opening a contract verifies every local circuit's key
 * against the deployed state, so it would strand every Passport already
 * deployed. So the CLIENT stops asking for partial withdrawals:
 *
 *   1. take the whole coin out to the sender's own wallet — the safe branch;
 *   2. pay the recipient what they are owed out of it;
 *   3. put the rest back into the sender's own account.
 *
 * Leg three is what makes the account whole again, and it is skipped entirely
 * when the payment happens to be the whole coin, which is the two-leg send this
 * app has always made.
 *
 * Refuses, rather than rounding, when the account does not hold enough: a plan
 * that quietly paid less than was asked for is the one failure mode worse than
 * saying no.
 */
export function planShieldedSend(input: { held: bigint; amount: bigint }): ShieldedSendPlan | null {
  if (input.amount <= 0n) return null;
  if (input.held < input.amount) return null;
  const change = input.held - input.amount;
  return {
    withdraw: input.held,
    pay: input.amount,
    change: change > 0n ? change : null,
    steps: change > 0n ? 3 : 2,
  };
}

/**
 * The record's own reading of its plan, for a run being carried on.
 *
 * A record with no {@link PendingSend.withdrawAmount} is a two-leg run —
 * either a NIGHT one, or a shielded one written before the third leg existed,
 * or one whose payment was the whole coin — and the plan says so.
 */
export function planOfRecord(record: PendingSend): ShieldedSendPlan {
  const pay = BigInt(record.amount);
  const withdraw = record.withdrawAmount === undefined ? pay : BigInt(record.withdrawAmount);
  const change = withdraw - pay;
  return {
    withdraw,
    pay,
    change: change > 0n ? change : null,
    steps: change > 0n ? 3 : 2,
  };
}

/* -------------------------------------------------------------------------- */
/* What the sheet says while it runs                                           */
/* -------------------------------------------------------------------------- */

/** Which of the legs is running, as the sheet is told about it. */
export type SendStep = 'withdrawing' | 'settling' | 'depositing' | 'changing' | 'returning';

/** What the progress line is built out of. */
export interface SendStepLineInput {
  step: SendStep;
  /** How many steps this run has: two, or three when there is change to put back. */
  steps: 2 | 3;
  /** Who is being paid, in the sender's own words. */
  recipient: string;
  /** "(retry 1 of 2)", or an empty string on a first attempt. */
  attemptSuffix?: string;
}

/**
 * ONE LINE, SAYING WHICH STEP IS RUNNING — in plain words, and counted honestly.
 *
 * A three-leg run that narrated itself as two would leave somebody watching an
 * apparently finished payment carry on for another minute, which is the exact
 * complaint the two-step line was written to answer in the first place. So the
 * count is the plan's, not a constant.
 *
 * NO MACHINERY. "Taking the coin out" is what leg one does, said the way a
 * person would say it; the words coin, note, contract, circuit, and nonce are
 * deliberately not on this surface. `returning` is not a step of the payment at
 * all — it is the amount going back after the paying leg refused — so it is
 * never numbered, and since 2026/09/07 neither is `changing`: the change comes
 * back after the payment is confirmed, with nobody waiting on it.
 */
export function sendStepLine(input: SendStepLineInput): string {
  const suffix = input.attemptSuffix ?? '';
  /* TWO, WHATEVER THE PLAN IS (2026/09/07). A part-coin payment is still three
     transactions and `steps` still says so — it is what chooses the wording
     below — but the third puts the SENDER's own change back into the SENDER's
     own account and runs after the confirmation, with nobody waiting on it. So
     the count on screen is the count somebody actually sits through, and
     `changing` is no longer numbered at all. */
  const of = 'of 2';
  switch (input.step) {
    case 'withdrawing':
      return input.steps === 3
        ? `Step 1 ${of} · Taking the coin out${suffix}.`
        : `Step 1 ${of} — taking the amount out of your account${suffix}.`;
    case 'settling':
      return input.steps === 3
        ? 'Step 1 done. Waiting for it to clear before it goes on.'
        : 'Step 1 of 2 done. Waiting for the amount to clear before it goes on.';
    case 'depositing':
      return input.steps === 3
        ? `Step 2 ${of} · Paying ${input.recipient}${suffix}.`
        : `Step 2 ${of} — paying it into ${input.recipient}’s account${suffix}.`;
    case 'changing':
      return `Returning your change${suffix}.`;
    default:
      /* Not a step of the payment: the paying leg refused, and the amount is
         being put back. Said plainly and immediately, because the alternative
         is a spinner still claiming a step that has already failed. */
      return `${input.recipient} was not paid. Putting the amount back into your account.`;
  }
}

/**
 * What Home says about one unfinished payment, in the same plain words.
 *
 * The three-leg case earns its own sentence and it is the one that matters
 * most: the recipient HAS been paid, and what is outstanding is the sender's
 * own change sitting in their wallet. A card that said "they have not been
 * paid" over that would send somebody looking for a payment that already
 * happened.
 */
export function pendingSendStepLine(record: PendingSend): string {
  if (!record.withdrawTxHash) return 'Nothing has left your account yet.';
  const steps = planOfRecord(record).steps;
  if (record.leg === 'change') {
    return `${record.recipient.label} has been paid. Your change has not come back to your account yet.`;
  }
  if (record.leg === 'settle') return 'Step 1 done. Waiting for the amount to reach your Passport.';
  return steps === 3
    ? `Step 1 done. Paying ${record.recipient.label} has not finished.`
    : `Step 1 done. Step 2 — paying it into ${record.recipient.label}’s account — has not finished.`;
}

/** What names the colour a run is denominated in, as a screen already has it. */
export interface PendingSendAsset {
  /** The asset's own ticker — `mUSD`, `NIGHT`, or `Token · 1a29…`. */
  symbol: string;
  /** How many decimal places its amount is quoted with. Zero for a shielded colour. */
  decimals: number;
}

/**
 * The amount on the recovery card, in the asset's own name (2026/09/04).
 *
 * This read `${amount} units` for everything that was not NIGHT, and the
 * 2026/09/04 stability audit read the result back: "SENDING 1 UNITS TO
 * SBMTN702YEJFH.NIGHT" over a payment of one mUSD. "Units" names nothing — the
 * Send sheet that opened the payment said `mUSD`, the balance above the card
 * says `mUSD`, and the one surface that appears when something has gone wrong
 * was the one that would not say which asset was in flight.
 *
 * So the ticker comes in, from the same `describeColour` both balance lists are
 * painted from, and the amount is put on that colour's own scale. Six decimals
 * for NIGHT, zero for a shielded colour — which is not a rounding but the
 * ledger's own truth, since a shielded colour publishes no decimal scale
 * anywhere and its amount IS a whole count. A colour nothing can name still
 * gets its `Token · 1a29…`, which at least identifies the asset rather than
 * denying that it has one.
 *
 * Scaled here rather than by a caller because this module is the one that holds
 * the record, and it takes no imports on purpose — see the header.
 */
export function pendingSendAmountLabel(record: PendingSend, asset: PendingSendAsset): string {
  return `${scaledAmount(record.amount, asset.decimals)} ${asset.symbol}`;
}

/**
 * An atomic amount on its colour's own scale, with no trailing zeroes.
 *
 * `0` decimals is the identity, which is every shielded colour. A figure that
 * does not parse comes back untouched: a record written by a build that is not
 * this one is not worth turning into `NaN` on a card whose whole job is to say
 * what is outstanding.
 */
function scaledAmount(amount: string, decimals: number): string {
  if (decimals <= 0) return amount;
  if (!/^\d+$/.test(amount)) return amount;
  const digits = amount.padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * WHETHER THIS RUN CAN BE CARRIED ON WITHOUT ASKING ANYBODY (2026/09/04).
 *
 * A reload in the middle of a send leaves the record on Home behind a
 * `Continue`, and the 2026/09/04 stability audit sat in front of one for three
 * minutes: the first leg had landed, the money was at the sender's own
 * Passport, and the only thing between it and the recipient was a button
 * nobody had told the reader to press. Pressing it then finished the payment
 * exactly as it would have without the reload.
 *
 * A run whose first leg is ALREADY SUBMITTED is one the sender has already
 * authorised: raising the account's assertion is what leg one costs, and that
 * ceremony covered the whole run. What is left — waiting for the amount to
 * clear, the permissionless call that pays the recipient, the permissionless
 * call that puts the change back — needs no signature from anybody. So it is
 * carried on by itself, and `Continue` stays for the runs that do need a
 * person. `withdrawTxHash` is the whole test of that: its presence is what
 * says the first leg was accepted.
 *
 * TWO STATES ARE DELIBERATELY REFUSED, and both would be worse than a button:
 *
 *   `failed` — the run stopped with a reason on it, and the card is showing
 *              that reason. Starting again underneath somebody who is reading
 *              why it did not work is the screen acting on a decision they
 *              have not made.
 *   `done`   — there is nothing to carry on.
 *
 * A run that never spent — no `withdrawTxHash` — needs the account's own
 * assertion for its first leg, which is a passkey prompt, and a prompt nobody
 * asked for is exactly what this must not produce.
 */
export function resumesWithoutPrompt(record: PendingSend): boolean {
  if (record.leg === 'done' || record.leg === 'failed') return false;
  return typeof record.withdrawTxHash === 'string' && record.withdrawTxHash.length > 0;
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
    if (INSUFFICIENT_PATTERN.test(messageOf(node))) {
      return { retryable: false, rebuild: false, message: INSUFFICIENT_TEXT };
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

/** What "there is not enough" looks like, wherever in the chain it is said. */
const INSUFFICIENT_PATTERN = /insufficient funds|insufficient balance|not enough/i;

/** And what a reader is told about it — a sentence, not a classification. */
const INSUFFICIENT_TEXT = 'There was not enough to cover this step, so nothing further was sent.';

/**
 * THE ONE SENTENCE A REFUSED TRANSFER IS TOLD IN.
 *
 * Reported by a user on 2026/09/03, from production: a second mUSD send showed
 * them
 *
 *     The account contract rejected withdraw_shielded — SubmissionError:
 *     1010: Invalid Transaction: Custom error: 239
 *
 * which names the machinery three times, quotes a circuit, and ends in a
 * number. Nothing in it is theirs to act on, and the one fact that IS —
 * that their money did not move — is the one thing it does not say.
 *
 * So the panel gets this and nothing else. It is deliberately not a
 * classification: a person deciding whether to press the button again does not
 * need to know whether the node refused, the proof failed, or the sponsor was
 * out of DUST, and every one of those words has been shown to leak the
 * machinery back in. What varies is the console, where the whole cause chain
 * goes untouched for whoever is debugging it.
 *
 * "nothing left your account" is a claim, and it is only made where it is
 * true: {@link callAccountCircuit} raises this class of failure only when the
 * submission was refused, which means no transaction landed. A leg that failed
 * AFTER something moved is the two-leg orchestrator's business and says so in
 * its own words.
 */
export const SEND_REFUSED_TEXT =
  'That transfer could not be sent just now — nothing left your account. Try again.';

/**
 * What to SHOW a person whose transfer was refused, and what to log instead.
 *
 * One sentence out, always — see {@link SEND_REFUSED_TEXT} — except where a
 * failure carries a message that was written FOR a reader in the first place:
 * a balancing refusal the runtime classified with its own `userMessage`, and
 * the "not enough to cover this" case, are both about a decision the person can
 * make, and replacing them with a generic sentence would be a worse screen
 * rather than a cleaner one. Neither names a circuit or a contract.
 *
 * `console.debug` is the caller's to make, with the cause itself rather than a
 * string of it: an error printed as an object keeps its chain, and the chain is
 * the whole of what a debugger wants.
 */
export function sendRefusalText(error: unknown): string {
  const chain = chainOf(error);
  for (const node of chain) {
    /* Written for a reader by the runtime that classified it. */
    const verdict = balancingVerdict(node);
    if (verdict) return verdict.message;
  }
  for (const node of chain) {
    if (INSUFFICIENT_PATTERN.test(messageOf(node))) return INSUFFICIENT_TEXT;
  }
  /* Everything else — a node refusal, a proof that failed, a circuit that was
     rejected, an error nobody has classified — is the one sentence. The
     alternative is the head of the chain, and the head of the chain is where
     "The account contract rejected withdraw_shielded" came from. */
  return SEND_REFUSED_TEXT;
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
/* Waiting for leg one to arrive                                               */
/* -------------------------------------------------------------------------- */

/**
 * What one look at the wallet found.
 *
 * `note` is the shielded note the paying leg will consume, and `null` for a
 * NIGHT run — which arrives as a rise in a balance and has no note to name. So
 * "nothing yet" is a flag rather than a null: the two are different answers and
 * a null that meant both is how a NIGHT run comes to pay itself twice.
 */
export type SettleProbe<T> = { arrived: false } | { arrived: true; note: T };

/**
 * A wait for the withdrawn amount to appear in the sender's own wallet.
 *
 * WHY THIS IS NOT A `setInterval` IN THE ORCHESTRATOR (2026/09/03)
 * ---------------------------------------------------------------
 * It was, and the measured cost of it was 20 to 30 seconds of a 54-second
 * NIGHT send. Between the two legs the client looked at its own wallet, slept a
 * flat two or three seconds, and looked again — so the arrival was noticed up
 * to a full tick after it had happened, and the tick was chosen for a wallet
 * that had not yet been asked whether the transaction was even on chain.
 *
 * The chain is the thing that knows. Leg one returns an identifier the indexer
 * can be asked about directly ({@link SettleWatchOptions.confirmLanded}, one
 * bounded point lookup), and until the indexer has the transaction there is
 * nothing the wallet could possibly be holding — so the wait runs at two
 * cadences and the interesting one starts at the LANDING EDGE:
 *
 *   - before it lands: {@link SETTLE_LOOK_BEFORE_LANDING_MS}, one free wallet
 *     read and one cheap indexer question per turn;
 *   - the moment it lands: the wallet is re-read IMMEDIATELY, with no sleep in
 *     between — this is the tick that used to be waited out;
 *   - after it lands: {@link SETTLE_LOOK_AFTER_LANDING_MS}, because the only
 *     question left is when the wallet's own sync applies a transaction the
 *     chain already carries, and the read that answers it touches no network.
 *
 * A run whose leg one resolved its own ledger hash starts `landed` — that
 * resolution IS an indexer answer for the transaction, and asking again would
 * be paying for a fact already in hand.
 *
 * NO CLOCK AND NO `fetch` IN HERE. `now` and `sleep` are arguments and both
 * probes are callbacks, which is what lets the whole schedule — including the
 * landing edge and the deadline — be driven by a test rather than waited out by
 * one. Same rule as the rest of this module: the orchestrator does the talking,
 * this decides when.
 */
export interface SettleWatchOptions<T> {
  /**
   * One look at the sender's own wallet. No network: this reads the state the
   * wallet's live sync has already applied.
   */
  readWallet: () => Promise<SettleProbe<T>>;
  /**
   * One bounded question to the indexer — has leg one's transaction landed? —
   * or omitted when leg one already proved that it had.
   */
  confirmLanded?: () => Promise<boolean>;
  /** True when leg one resolved its own ledger hash. */
  landed?: boolean;
  /**
   * Called once, on the landing edge, so the orchestrator can begin everything
   * leg two needs that is not the note itself.
   */
  onLanded?: () => void;
  /** How long the whole wait may take. */
  deadlineMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  beforeLandingMs?: number;
  afterLandingMs?: number;
}

/** How the wait ended, and what it learnt on the way. */
export type SettleOutcome<T> =
  | { settled: true; note: T; landed: boolean; looks: number }
  | { settled: false; landed: boolean; looks: number };

/**
 * While the chain has not been shown to carry leg one yet.
 *
 * One second, against a block time measured in seconds: the wallet read is free
 * and the indexer question is a single point lookup measured at 102–123 ms warm
 * (see `identity/contractRuntime.ts`, which records the samples), so a second
 * is already several times the cost of asking.
 */
export const SETTLE_LOOK_BEFORE_LANDING_MS = 1_000;

/**
 * Once it has landed.
 *
 * The transaction is on chain and the only question left is when this wallet's
 * own sync applies it. The read that answers is a projection of state already
 * in memory — no network at all — so the interval is set by how soon a person
 * should be moved on rather than by what it costs to ask.
 */
export const SETTLE_LOOK_AFTER_LANDING_MS = 400;

/**
 * Waits for what leg one paid in, and says whether it arrived.
 *
 * Never throws: a wait that ran out of time is an OUTCOME, because the money
 * has moved and the record must be left at `settle` rather than failed. The
 * only exceptions that escape are the caller's own probes'.
 */
export async function watchForSettlement<T>(
  options: SettleWatchOptions<T>,
): Promise<SettleOutcome<T>> {
  const beforeMs = options.beforeLandingMs ?? SETTLE_LOOK_BEFORE_LANDING_MS;
  const afterMs = options.afterLandingMs ?? SETTLE_LOOK_AFTER_LANDING_MS;
  const started = options.now();
  let landed = options.landed ?? false;
  let looks = 0;
  /* The hook fires for a run that STARTS landed too. That is the common case —
     leg one resolves its own hash — and it is the earliest leg two's
     preparation could possibly begin. */
  if (landed) options.onLanded?.();
  for (;;) {
    looks += 1;
    const probe = await options.readWallet();
    if (probe.arrived) return { settled: true, note: probe.note, landed, looks };
    if (!landed && options.confirmLanded !== undefined) {
      landed = await options.confirmLanded();
      if (landed) {
        options.onLanded?.();
        /* THE TICK THAT WAS WAITED OUT. The chain has it, so the wallet is
           asked again now rather than after another interval. */
        continue;
      }
    }
    if (options.now() - started >= options.deadlineMs) {
      return { settled: false, landed, looks };
    }
    await options.sleep(landed ? afterMs : beforeMs);
  }
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
  /**
   * Whether the RECIPIENT was paid before the run stopped — true only of a
   * three-leg run that fell over on the change coming back. Saying "they were
   * not paid" over that would send somebody chasing a payment that happened.
   */
  recipientPaid?: boolean;
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
  if (notice.recipientPaid) {
    /* The payment WORKED. What is outstanding is the sender's own change, and
       the card on Home is where it comes back from. */
    return (
      'Your payment went through. Your change has not come back to your account yet — ' +
      'finish that from Home.'
    );
  }
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

/* -------------------------------------------------------------------------- */
/* The change that comes back on its own                                       */
/* -------------------------------------------------------------------------- */

/**
 * WHY THE THIRD LEG STOPPED BEING SOMETHING PEOPLE WATCH (2026/09/07)
 * -------------------------------------------------------------------
 * Reported as "improve the transfer times". A shielded payment out of a coin
 * bigger than the amount is three transactions, and the recipient has their
 * money at the end of the SECOND one — `deposit_shielded` into their account.
 * The third puts the sender's own change back into the sender's own account.
 * Nobody but the sender is waiting on it, and until this date it was awaited
 * inline with its own 180-second settlement watch, so the last third of every
 * mUSD transfer was a person watching a step that concerned only themselves
 * while the screen still said the payment was in progress.
 *
 * So the run is COMPLETE, to the reader, when leg two lands: the confirmation,
 * the "Sent" row on the trail, the balances. Leg three runs detached. The
 * record it leaves behind is unchanged — it is still written at `change`, it
 * still resumes without a prompt after a reload, and Home still offers to carry
 * it on if it stops — so nothing about the money's safety turns on the tab
 * staying open. What changed is only who is asked to wait.
 *
 * THE ONE THING THAT MUST STILL BE SEQUENCED. The change is a coin, and the
 * next send has to spend it. A second send started while it is in flight would
 * build against a wallet that is one note short and be refused by the node for
 * it, so the sheet holds the next transfer until the change has landed — see
 * {@link sendBlockedByChangeReturn}.
 */

/**
 * Whether this record's recipient has been paid and only the sender's own
 * change is outstanding.
 *
 * `change` is the leg the paying transaction writes when it succeeds and the
 * plan had a remainder, so the presence of the leg IS the fact.
 */
export function awaitsChangeReturn(record: PendingSend): boolean {
  return record.leg === 'change';
}

/**
 * Whether a change return is running rather than stopped.
 *
 * A record at `change` with no reason on it is one the app is carrying, or is
 * about to carry, by itself. One WITH a reason has stopped, and it has a card
 * on Home saying so — a quiet line claiming the change was on its way over a
 * run that had given up would be the screen making a promise nothing was
 * keeping.
 */
export function changeReturnInFlight(records: readonly PendingSend[]): boolean {
  return records.some((record) => awaitsChangeReturn(record) && record.lastError === undefined);
}

/**
 * The quiet line Home prints under the balances while the change comes back.
 *
 * NO MACHINERY, and no figure. The balance above it is the account's own and it
 * is correct; this only says that a little more is on its way back to it. An
 * amount here would invite the reader to add the two together, which is exactly
 * what a balance line must never make somebody do.
 */
export const CHANGE_RETURN_LINE = 'Returning your change…';

/** The line, or nothing at all when there is no change in flight. */
export function changeReturnLine(records: readonly PendingSend[]): string | null {
  return changeReturnInFlight(records) ? CHANGE_RETURN_LINE : null;
}

/**
 * Why the next transfer has to wait, in the plainest words there are.
 *
 * It is not "busy" and it is not an error: the previous transfer WORKED, and
 * the only thing outstanding is the sender's own change on its way back into
 * their account. The next send needs that coin, so it waits for it.
 */
export const SEND_BLOCKED_BY_CHANGE_RETURN = 'Finishing your last transfer…';

/**
 * Whether a new send must wait, and what to say while it does.
 *
 * A record at `change` blocks whether or not it is running: a stopped one is
 * still change that has not come back, and the coin the next send would spend
 * is still not in the account. The card on Home is the way to move it along.
 */
export function sendBlockedByChangeReturn(records: readonly PendingSend[]): string | null {
  return records.some(awaitsChangeReturn) ? SEND_BLOCKED_BY_CHANGE_RETURN : null;
}

/* -------------------------------------------------------------------------- */
/* Where the time actually goes                                                */
/* -------------------------------------------------------------------------- */

/**
 * THE STAGES ONE LEG CAN BE TIMED AT, and why these four and not others.
 *
 * "Improve the transfer times" cannot be answered without knowing which part is
 * slow, and until 2026/09/07 the only figure anybody had was the whole send.
 * These are the four spans a leg is really made of, as this client can
 * attribute them:
 *
 *   `prove`   — every local cryptographic step: balancing the transaction,
 *               signing the recipe, and computing the wallet's own proof. One
 *               figure because they are one uninterrupted stretch of work on
 *               this device, and the reader of a console line wants to know
 *               whether the device or the network is the cost.
 *   `sponsor` — the fee sponsor holding the balanced transaction.
 *   `submit`  — the node being asked to take it, up to inclusion.
 *   `settle`  — waiting for what the leg moved to become visible: leg one's
 *               amount arriving at the sender's own Passport, leg three's
 *               change appearing after leg two spent the bigger note.
 *
 * A stage with no time against it is LEFT OUT of the line rather than printed
 * as `0.0 s` — a zero would read as "this was instant" when what happened is
 * that the leg never reached it.
 */
export type SendStage = 'prove' | 'sponsor' | 'submit' | 'settle';

/** The order stages are printed in: the order a leg walks them. */
export const SEND_STAGES: readonly SendStage[] = ['prove', 'sponsor', 'submit', 'settle'];

/** One leg, once it is over, with a wall-clock figure against each stage. */
export interface SendLegTiming {
  /** 1, 2, or 3 — the leg's number in the plan, as the step lines count them. */
  leg: number;
  /** `withdraw`, `deposit`, `change`. A console word, never a screen one. */
  name: string;
  /** Milliseconds per stage. An absent stage was never entered. */
  stages: Partial<Record<SendStage, number>>;
}

/**
 * A duration as a console reads it: one decimal place, in seconds.
 *
 * Seconds because every figure here is one — the fastest stage this has ever
 * measured is a sponsor round trip at about a second — and one decimal because
 * a millisecond count of a network wait is precision nobody can act on.
 */
export function formatSendDuration(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

/** The total of every stage on a leg. */
export function sendLegTotalMs(timing: SendLegTiming): number {
  return SEND_STAGES.reduce((total, stage) => total + (timing.stages[stage] ?? 0), 0);
}

/**
 * The per-leg line.
 *
 *     [send] leg 2 deposit: prove 9.8 s · sponsor 1.2 s · submit 6.1 s · settle 4.0 s
 *
 * A leg that reached no stage at all still gets a line, because "leg 1 withdraw
 * was skipped" is itself worth reading in a console that is being used to work
 * out where a send's time went.
 */
export function formatSendLegTiming(timing: SendLegTiming): string {
  const parts: string[] = [];
  for (const stage of SEND_STAGES) {
    const ms = timing.stages[stage];
    /* An absent stage is left out; a stage that really measured zero is
       printed, because "0.0 s" against a stage that ran is a fact and "nothing
       here" against one that did not is a different one. */
    if (ms === undefined) continue;
    parts.push(`${stage} ${formatSendDuration(ms)}`);
  }
  const body = parts.length === 0 ? 'nothing timed' : parts.join(' · ');
  return `[send] leg ${timing.leg} ${timing.name}: ${body}`;
}

/**
 * The one summary line, and the value the dev diagnostics hold.
 *
 *     [send] total 21.1 s · leg 1 withdraw 8.0 s · leg 2 deposit 13.1 s
 *
 * The total is the sum of the legs rather than a separate stopwatch, so the
 * line can never disagree with itself — a wall-clock total that did not match
 * its own parts would send somebody looking for a stage that was never
 * measured.
 */
export function formatSendSummary(legs: readonly SendLegTiming[]): string {
  if (legs.length === 0) return '[send] nothing timed';
  const total = legs.reduce((sum, leg) => sum + sendLegTotalMs(leg), 0);
  const parts = legs.map(
    (leg) => `leg ${leg.leg} ${leg.name} ${formatSendDuration(sendLegTotalMs(leg))}`,
  );
  return `[send] total ${formatSendDuration(total)} · ${parts.join(' · ')}`;
}

/**
 * A stopwatch for one leg's stages.
 *
 * NO CLOCK OF ITS OWN — `now` is an argument, on the same principle as
 * {@link watchForSettlement}: a timing rule a test has to wait out in real time
 * is one nobody drills. Stages ACCUMULATE, because a leg that was attempted
 * three times really did spend the sum of its three provings, and a figure that
 * only remembered the last attempt would say a slow leg was a fast one.
 */
export interface SendStageClock {
  /** Adds `ms` to a stage. Negative and non-finite figures are ignored. */
  add: (stage: SendStage, ms: number) => void;
  /** Times `run`, charging however long it took to `stage`. */
  time: <T>(stage: SendStage, run: () => Promise<T>) => Promise<T>;
  /** What has been charged so far. A fresh object each time. */
  stages: () => Partial<Record<SendStage, number>>;
}

export function createSendStageClock(now: () => number = () => Date.now()): SendStageClock {
  const charged: Partial<Record<SendStage, number>> = {};
  const add = (stage: SendStage, ms: number): void => {
    if (!Number.isFinite(ms) || ms < 0) return;
    charged[stage] = (charged[stage] ?? 0) + ms;
  };
  return {
    add,
    time: async <T,>(stage: SendStage, run: () => Promise<T>): Promise<T> => {
      const started = now();
      try {
        return await run();
      } finally {
        /* CHARGED EVEN WHEN IT THREW. A stage that failed after eleven seconds
           cost those eleven seconds, and a retry ladder whose failures were
           free would report a two-minute leg as a twenty-second one. */
        add(stage, now() - started);
      }
    },
    stages: () => ({ ...charged }),
  };
}
