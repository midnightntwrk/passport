/**
 * Sizing for a DUST-coin split of the balancer's NIGHT.
 *
 * Nothing here touches a wallet, a seed, or the chain: it is arithmetic over
 * the ledger's DUST parameters, so it can be run, tested, and reviewed long
 * before anybody is allowed to move NIGHT. As of 2026/09/02 the split itself is
 * NOT approved — see `./SPLIT.md`.
 *
 * WHY A SPLIT IS ON THE TABLE. The balancer holds its 4,998.916 NIGHT as two
 * UTxOs, so it generates DUST into two coins. Fee balancing selects coins
 * smallest-first and keeps taking them until the fee is covered, so a single
 * sponsored transaction touches BOTH coins, and the ledger marks every spent
 * DUST entry `pending_until = ctime + grace` — it is hidden from
 * `utxos()`/`wallet_balance()` until the change lands (50–95 s observed) or the
 * grace period expires. Two coins therefore mean one lane: every sponsored
 * transaction blocks the next one. N coins mean up to N lanes, PROVIDED each
 * coin on its own holds at least one whole fee.
 *
 * That proviso is the whole of the sizing question, and it is what this module
 * answers: after a split each new coin starts at ZERO DUST and accrues
 * linearly, so there is a window — {@link SplitPlan.secondsToFirstFee} — during
 * which the coins are individually too small to pay a fee and smallest-first
 * selection sweeps all of them exactly as it does today.
 *
 * ALL SPECK ARITHMETIC IS BigInt. Specks are integers of order 1e19; a `number`
 * loses precision above 2^53 and would quietly mis-size the plan. Ratios that
 * genuinely are fractional (fees per hour) are returned as integers scaled by
 * 1,000 — `feesPerHourMilli` of `10859` means 10.859 fees per hour.
 */

/** The ledger's DUST parameters, as measured against the live stagenet state. */
export interface DustParameters {
  /** Specks of DUST cap per atomic NIGHT (`nightDustRatio`). */
  nightDustRatio: bigint;
  /**
   * Specks per atomic NIGHT per second — the rate DUST accrues towards the cap,
   * and the same rate at which an orphaned coin decays (`generationDecayRate`).
   */
  generationDecayRate: bigint;
  /** Seconds from zero to cap at the full rate — `nightDustRatio / rate`. */
  timeToCapSeconds: bigint;
  /** Seconds a SPENT DUST entry stays `pending_until` and invisible. */
  graceSeconds: bigint;
}

/**
 * Ledger parameters on stagenet, 2026/09/02. `nightDustRatio` and
 * `generationDecayRate` come from `LedgerParameters.initialParameters().dust`;
 * both were confirmed against `updatedValue` on the live balancer state (the
 * 0.916 NIGHT coin generates 7.57e9 Specks/s, the 4,998 NIGHT coin 4.13e13/s).
 */
export const LEDGER_DUST_PARAMETERS: DustParameters = {
  nightDustRatio: 5_000_000_000n,
  generationDecayRate: 8_267n,
  timeToCapSeconds: 604_815n,
  graceSeconds: 10_800n,
};

/**
 * The largest single sponsored fee measured from the indexer's `paidFees` on
 * the 13:31–13:34 activation of 2026/09/02: the resolver-leaf deploy, at
 * 1.37e16 Specks. A coin that holds this holds any one leg of an activation.
 */
export const MEASURED_MAX_FEE_SPECKS = 13_700_000_000_000_000n;

/**
 * One activation's five SPONSORED legs — resolver deploy 1.37e16, register
 * 0.85e16, deposit_night 0.69e16, mint 0.50e16, deposit_shielded 0.71e16.
 */
export const MEASURED_ACTIVATION_FEE_SPECKS = 41_200_000_000_000_000n;

/**
 * The same activation plus the balance-only send leg (1.14e16) the user's first
 * payment costs the sponsor. The pessimistic figure to plan capacity against.
 */
export const MEASURED_ACTIVATION_WITH_SEND_FEE_SPECKS = 52_600_000_000_000_000n;

/**
 * The big DUST coin as the saved snapshot recorded it (nonce 108f32bb…, seq
 * 368): what would be left decaying if its backing NIGHT were spent by a split.
 */
export const MEASURED_OLD_COIN_SPECKS = 24_946_432_797_282_076_896n;

export interface SplitPlanInput {
  /** Atomic NIGHT the wallet holds (6 decimals: 4,998,916,000 = 4,998.916). */
  totalAtomicNight: bigint;
  /** How many NIGHT UTxOs — and therefore DUST coins — to end up with. */
  outputs: number;
  parameters?: DustParameters;
  /** Largest single sponsored fee a coin must cover on its own. */
  maxFeeSpecks?: bigint;
  /** Fee of one whole activation, for the capacity figures. */
  activationFeeSpecks?: bigint;
  /** Fee of one activation plus a first send. */
  activationWithSendFeeSpecks?: bigint;
  /** Value of the DUST coin that would be left decaying after the split. */
  oldCoinSpecks?: bigint;
}

export interface SplitPlan {
  outputs: number;
  totalAtomicNight: bigint;
  /** `floor(total / outputs)` — the value of each of the explicit outputs. */
  perCoinAtomicNight: bigint;
  /** `total - outputs * perCoin`; carried by the change output. */
  remainderAtomicNight: bigint;
  /** The transaction pays `outputs - 1` explicit outputs; change is the last. */
  explicitOutputs: number;
  /** What the change output ends up holding: `perCoin + remainder`. */
  changeAtomicNight: bigint;
  /** DUST cap of one new coin. */
  perCoinCapSpecks: bigint;
  /** DUST cap of the wallet as a whole — unchanged by the split. */
  totalCapSpecks: bigint;
  /** Specks per second one new coin accrues. */
  perCoinSpecksPerSecond: bigint;
  /** Seconds until ONE new coin can pay one maximum fee by itself. */
  secondsToFirstFeePerCoin: bigint;
  /** Seconds until one new coin can pay two maximum fees back to back. */
  secondsToSecondFeePerCoin: bigint;
  /**
   * Seconds until the wallet as a WHOLE holds one maximum fee again, counting
   * every new coin together. Smallest-first selection sweeps all of them while
   * they are small, so this — not {@link secondsToFirstFeePerCoin} — is how
   * long the balancer cannot sponsor anything at all after the split, IF the
   * pre-split DUST does not survive the NIGHT rotation. See `./SPLIT.md`.
   */
  secondsToFirstFeeAggregate: bigint;
  /**
   * The blackout to plan the maintenance window around: equal to
   * {@link secondsToFirstFeeAggregate}, on the conservative assumption that a
   * NIGHT rotation leaves the wallet with no spendable DUST whatsoever.
   */
  worstCaseBlackoutSeconds: bigint;
  /**
   * How long after the split the wallet is still effectively single-lane:
   * until each coin holds a whole fee, smallest-first selection keeps sweeping
   * every coin, exactly as it does today. Equal to
   * {@link secondsToFirstFeePerCoin}.
   */
  singleLaneGapSeconds: bigint;
  /** Specks per second the wallet accrues in total — the split does not change it. */
  aggregateSpecksPerSecond: bigint;
  aggregateSpecksPerHour: bigint;
  /** Sustained maximum fees per hour, ×1,000 (10859 = 10.859/h). */
  feesPerHourMilli: bigint;
  /** Sustained activations per hour, ×1,000 (3611 = 3.611/h). */
  activationsPerHourMilli: bigint;
  /** Sustained activations-with-a-send per hour, ×1,000. */
  activationsWithSendPerHourMilli: bigint;
  /** Value of the coin left decaying after its backing NIGHT is spent. */
  oldCoinSpecks: bigint;
  /** Seconds that coin takes to decay to nothing. Spendable throughout. */
  oldCoinDecaySeconds: bigint;
  /** Echoed for the printed plan. */
  timeToCapSeconds: bigint;
  graceSeconds: bigint;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('ceilDiv needs a positive denominator');
  return (numerator + denominator - 1n) / denominator;
}

export function computeSplitPlan(input: SplitPlanInput): SplitPlan {
  const { totalAtomicNight, outputs } = input;
  if (!Number.isInteger(outputs) || outputs < 1) {
    throw new Error('outputs must be a positive integer');
  }
  if (totalAtomicNight <= 0n) {
    throw new Error('totalAtomicNight must be positive');
  }

  const parameters = input.parameters ?? LEDGER_DUST_PARAMETERS;
  const maxFeeSpecks = input.maxFeeSpecks ?? MEASURED_MAX_FEE_SPECKS;
  const activationFeeSpecks = input.activationFeeSpecks ?? MEASURED_ACTIVATION_FEE_SPECKS;
  const activationWithSendFeeSpecks =
    input.activationWithSendFeeSpecks ?? MEASURED_ACTIVATION_WITH_SEND_FEE_SPECKS;
  const oldCoinSpecks = input.oldCoinSpecks ?? MEASURED_OLD_COIN_SPECKS;

  const outputsBig = BigInt(outputs);
  const perCoinAtomicNight = totalAtomicNight / outputsBig;
  if (perCoinAtomicNight <= 0n) {
    throw new Error('outputs exceeds the atomic NIGHT available to split');
  }
  const remainderAtomicNight = totalAtomicNight - perCoinAtomicNight * outputsBig;

  const perCoinCapSpecks = perCoinAtomicNight * parameters.nightDustRatio;
  const totalCapSpecks = totalAtomicNight * parameters.nightDustRatio;
  const perCoinSpecksPerSecond = perCoinAtomicNight * parameters.generationDecayRate;
  const aggregateSpecksPerSecond = totalAtomicNight * parameters.generationDecayRate;
  const aggregateSpecksPerHour = aggregateSpecksPerSecond * 3_600n;

  return {
    outputs,
    totalAtomicNight,
    perCoinAtomicNight,
    remainderAtomicNight,
    explicitOutputs: outputs - 1,
    changeAtomicNight: perCoinAtomicNight + remainderAtomicNight,
    perCoinCapSpecks,
    totalCapSpecks,
    perCoinSpecksPerSecond,
    secondsToFirstFeePerCoin: ceilDiv(maxFeeSpecks, perCoinSpecksPerSecond),
    secondsToSecondFeePerCoin: ceilDiv(maxFeeSpecks * 2n, perCoinSpecksPerSecond),
    secondsToFirstFeeAggregate: ceilDiv(maxFeeSpecks, aggregateSpecksPerSecond),
    worstCaseBlackoutSeconds: ceilDiv(maxFeeSpecks, aggregateSpecksPerSecond),
    singleLaneGapSeconds: ceilDiv(maxFeeSpecks, perCoinSpecksPerSecond),
    aggregateSpecksPerSecond,
    aggregateSpecksPerHour,
    feesPerHourMilli: (aggregateSpecksPerHour * 1_000n) / maxFeeSpecks,
    activationsPerHourMilli: (aggregateSpecksPerHour * 1_000n) / activationFeeSpecks,
    activationsWithSendPerHourMilli:
      (aggregateSpecksPerHour * 1_000n) / activationWithSendFeeSpecks,
    oldCoinSpecks,
    oldCoinDecaySeconds: ceilDiv(oldCoinSpecks, aggregateSpecksPerSecond),
    timeToCapSeconds: parameters.timeToCapSeconds,
    graceSeconds: parameters.graceSeconds,
  };
}

/** `10859` → `10.859`. Presentation only; the plan itself stays integral. */
export function formatMilli(value: bigint): string {
  const whole = value / 1_000n;
  const fraction = (value < 0n ? -value : value) % 1_000n;
  return `${whole}.${fraction.toString().padStart(3, '0')}`;
}

/** Atomic NIGHT (6 decimals) → a readable NIGHT figure. */
export function formatNightAtomic(atomic: bigint): string {
  const whole = atomic / 1_000_000n;
  const fraction = (atomic < 0n ? -atomic : atomic) % 1_000_000n;
  return `${whole}.${fraction.toString().padStart(6, '0')}`;
}

/* Rounded to nearest, not truncated: 603,650 s is seven days, and calling it
   six would understate how long the old coin lasts. */
function formatDuration(seconds: bigint): string {
  if (seconds < 5_400n) return `${seconds} s (${(seconds + 30n) / 60n} min)`;
  if (seconds < 172_800n) return `${seconds} s (${(seconds + 1_800n) / 3_600n} h)`;
  return `${seconds} s (${(seconds + 43_200n) / 86_400n} days)`;
}

export function formatSplitPlan(plan: SplitPlan): string {
  return [
    `DUST-coin split plan — ${plan.outputs} coins`,
    '',
    `  total NIGHT                ${formatNightAtomic(plan.totalAtomicNight)} (${plan.totalAtomicNight} atomic)`,
    `  per coin                   ${formatNightAtomic(plan.perCoinAtomicNight)} (${plan.perCoinAtomicNight} atomic)`,
    `  explicit outputs           ${plan.explicitOutputs} × ${plan.perCoinAtomicNight} atomic`,
    `  change output              ${plan.changeAtomicNight} atomic (remainder ${plan.remainderAtomicNight})`,
    '',
    `  cap per coin               ${plan.perCoinCapSpecks} Specks`,
    `  cap in total               ${plan.totalCapSpecks} Specks (unchanged by the split)`,
    `  generation per coin        ${plan.perCoinSpecksPerSecond} Specks/s`,
    `  generation in total        ${plan.aggregateSpecksPerSecond} Specks/s (unchanged by the split)`,
    `  time to cap                ${formatDuration(plan.timeToCapSeconds)}`,
    `  spent-coin grace           ${formatDuration(plan.graceSeconds)}`,
    '',
    `  any fee at all after       ${formatDuration(plan.secondsToFirstFeeAggregate)} — every new coin swept together`,
    `  one fee per coin after     ${formatDuration(plan.secondsToFirstFeePerCoin)}`,
    `  two fees per coin after    ${formatDuration(plan.secondsToSecondFeePerCoin)}`,
    `  single-lane gap            ${formatDuration(plan.singleLaneGapSeconds)} — until then, spends still sweep every coin`,
    '',
    `  sustained fees/hour        ${formatMilli(plan.feesPerHourMilli)}`,
    `  sustained activations/hour ${formatMilli(plan.activationsPerHourMilli)} (${formatMilli(plan.activationsWithSendPerHourMilli)} with a first send)`,
    '',
    `  worst-case blackout        ${formatDuration(plan.worstCaseBlackoutSeconds)} — assume the pre-split DUST does not survive the rotation`,
    `  old coin left decaying     ${plan.oldCoinSpecks} Specks, gone in ${formatDuration(plan.oldCoinDecaySeconds)} — see SPLIT.md before relying on it`,
    '',
    '  Nothing above moves anything. The split is NOT approved: see ops/SPLIT.md.',
  ].join('\n');
}
