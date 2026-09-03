/**
 * Sizing for a DUST-coin split of the balancer's NIGHT.
 *
 * Nothing here touches a wallet, a seed, or the chain: it is arithmetic over
 * the ledger's DUST parameters, so it can be run, tested, and reviewed long
 * before anybody is allowed to move NIGHT. See `./SPLIT.md` for the procedure
 * and for the approval this module deliberately knows nothing about.
 *
 * WHY A SPLIT IS ON THE TABLE. Fees are paid in DUST, the SDK's fee balancing
 * selects DUST coins smallest-first, and a coin only pays for a contract call
 * if it carries the whole fee ON ITS OWN — `feeCapableCoinCount` in
 * `src/wallet.ts` counts coins, not Specks, for exactly that reason. So the
 * number of DUST coins that individually clear a fee is the number of spends
 * the balancer can have in flight at once: its LANES. Splitting NIGHT into more
 * UTxOs makes more DUST coins, and therefore more lanes.
 *
 * WHAT CHANGED ON 2026/09/02, AND WHY THIS MODULE WAS REWRITTEN. The original
 * sizing assumed one wallet-wide holding cut into N equal pieces, which meant
 * every coin in the wallet started from zero at once and the wallet could not
 * pay a fee at all for a while — `worstCaseBlackoutSeconds`. The wallet now
 * holds its NIGHT in FOUR material UTxOs, so the split no longer has to be
 * wallet-wide. Splitting only the two NEWEST coins leaves the other two intact,
 * still at their accrued DUST, still fee-capable throughout: **the blackout
 * goes to zero**, and the ramp is paid for by coins that were never touched.
 * That is the model this module now computes, and {@link SplitPlan.blackoutSeconds}
 * is the field that says so.
 *
 * ALL SPECK ARITHMETIC IS BigInt. Specks are integers of order 1e19; a `number`
 * loses precision above 2^53 and would quietly mis-size the plan. Ratios that
 * genuinely are fractional (fees per hour) are returned as integers scaled by
 * 1,000 — `feesPerHourMilli` of `43444` means 43.444 fees per hour.
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

/** Atomic units per NIGHT — the ledger carries six decimals. */
export const ATOMIC_PER_NIGHT = 1_000_000n;

/**
 * The ruling of 2026/09/02: one thousand NIGHT per coin. Large enough that a
 * coin clears the fee-capable floor within half an hour of being made, small
 * enough that 10,000 NIGHT buys ten lanes rather than two.
 */
export const RULED_PER_COIN_ATOMIC_NIGHT = 1_000n * ATOMIC_PER_NIGHT;

/**
 * The largest single sponsored fee measured from the indexer's `paidFees` on
 * the 13:31–13:34 activation of 2026/09/02: the resolver-leaf deploy, at
 * 1.37e16 Specks. A coin that holds this holds any one leg of an activation.
 */
export const MEASURED_MAX_FEE_SPECKS = 13_700_000_000_000_000n;

/**
 * The midname-registration leg of the same activation, 8.5e15 Specks. This is
 * the SECOND-largest single fee, and the first one a fresh coin can pay.
 */
export const MEASURED_REGISTER_FEE_SPECKS = 8_500_000_000_000_000n;

/**
 * The DUST-registration fee — what `registerDustIfNeeded` pays to bring new
 * NIGHT UTxOs into generation, 8.5e14 Specks, an order of magnitude under the
 * midname registration above. It is quoted separately because it is the ONLY
 * fee a brand-new coin has to pay before it is useful, and because whether it
 * is payable at all after this split is the open question `./SPLIT.md` sets
 * out: the change out of a registered UTxO has been measured coming back
 * already generating, in which case this fee is never charged.
 */
export const MEASURED_DUST_REGISTRATION_FEE_SPECKS = 850_000_000_000_000n;

/**
 * The DUST a coin must hold before `src/wallet.ts` will count it as a LANE —
 * `FEE_CAPABLE_SPECKS` in `src/resolverPool.ts`, 1.5e16 Specks: the 1.37e16
 * deploy plus margin. Mirrored rather than imported because `ops/` is not part
 * of the service build; {@link SplitPlan.secondsToLaneCapablePerCoin} is the
 * figure that matters most in this whole module, since it is when the split
 * actually starts paying.
 */
export const FEE_CAPABLE_SPECKS = 15_000_000_000_000_000n;

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

export interface SplitPlanInput {
  /**
   * Atomic NIGHT the CHOSEN INPUT UTxOs carry — what this transaction spends,
   * not what the wallet holds. The whole point of the 2026/09/02 model is that
   * those are different numbers.
   */
  spendAtomicNight: bigint;
  /** How many NIGHT UTxOs — and therefore DUST coins — the spend becomes. */
  outputs: number;
  /**
   * Size of each output. Defaults to `floor(spend / outputs)`, which is the old
   * wallet-wide behaviour; pass {@link RULED_PER_COIN_ATOMIC_NIGHT} for the
   * 1,000-NIGHT coins the ruling asks for.
   */
  perCoinAtomicNight?: bigint;
  /**
   * The UTxOs the split deliberately leaves alone, atomic NIGHT each. These are
   * what keep paying fees while the new coins ramp, so their SIZES matter and
   * not merely their total: a lane is a coin, and a coin pays a fee alone.
   */
  untouchedCoinsAtomicNight?: readonly bigint[];
  /**
   * DUST those untouched coins hold RIGHT NOW, in total. Read off `/status`
   * (`dustSpecks`) or the plan's own live read. Drives
   * {@link SplitPlan.feesUntouchedCoinsCanPayNow}.
   */
  untouchedSpendableSpecks?: bigint;
  /** `BALANCER_SPEND_LANES` as it will be set after the split. */
  laneCeiling?: number;
  parameters?: DustParameters;
  /** Largest single sponsored fee a coin must cover on its own. */
  maxFeeSpecks?: bigint;
  /** The DUST-registration fee a brand-new UTxO may have to pay. */
  registrationFeeSpecks?: bigint;
  /** DUST at which `src/wallet.ts` counts a coin as a lane. */
  feeCapableSpecks?: bigint;
  /** Fee of one whole activation, for the capacity figures. */
  activationFeeSpecks?: bigint;
  /** Fee of one activation plus a first send. */
  activationWithSendFeeSpecks?: bigint;
}

export interface SplitPlan {
  outputs: number;
  /** Atomic NIGHT the chosen inputs carry. */
  spendAtomicNight: bigint;
  /** Atomic NIGHT left in the untouched UTxOs. */
  untouchedAtomicNight: bigint;
  /** How many UTxOs the split leaves alone. */
  untouchedCoins: number;
  /** Spend plus untouched — the wallet's whole holding, unchanged by the split. */
  totalAtomicNight: bigint;

  /** The value of each of the explicit outputs. */
  perCoinAtomicNight: bigint;
  /** `spend - outputs * perCoin`; carried by the change output. */
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
  /** Specks per second the new coins accrue between them. */
  newCoinsSpecksPerSecond: bigint;
  /** Specks per second the untouched coins keep accruing throughout. */
  untouchedSpecksPerSecond: bigint;
  /** Specks per second the wallet accrues in total — the split does not change it. */
  aggregateSpecksPerSecond: bigint;
  aggregateSpecksPerHour: bigint;

  /** Seconds until one new coin can pay the DUST-registration fee by itself. */
  secondsToRegistrationFeePerCoin: bigint;
  /** Seconds until one new coin can pay one maximum (resolver-deploy) fee. */
  secondsToFirstFeePerCoin: bigint;
  /** Seconds until one new coin can pay two maximum fees back to back. */
  secondsToSecondFeePerCoin: bigint;
  /**
   * Seconds until one new coin clears {@link FEE_CAPABLE_SPECKS} and the
   * service counts it as a LANE. This is when the split starts paying, and it
   * is the figure the maintenance window is planned around — not the blackout,
   * which the untouched coins remove entirely.
   */
  secondsToLaneCapablePerCoin: bigint;
  /** Seconds until the new coins TOGETHER hold one maximum fee. */
  secondsToFirstFeeAcrossNewCoins: bigint;

  /**
   * Seconds during which the wallet cannot pay a maximum fee at all.
   *
   * ZERO whenever at least one untouched coin already holds one, which is the
   * entire point of splitting only the two newest UTxOs. It is non-zero only if
   * the split is run wallet-wide, in which case it is
   * {@link secondsToFirstFeeAcrossNewCoins} — every coin starting from zero at
   * once, swept together by smallest-first selection.
   */
  blackoutSeconds: bigint;

  /** Fee-capable coins the moment the split lands: the untouched ones. */
  lanesAtSplit: number;
  /** Fee-capable coins once the new ones ramp: untouched plus outputs. */
  lanesWhenRamped: number;
  /** `BALANCER_SPEND_LANES` the ramped figure is capped by. */
  laneCeiling: number;
  /**
   * Maximum fees the untouched coins can pay out of what they hold NOW, before
   * counting a second of further generation. The ramp's actual budget.
   */
  feesUntouchedCoinsCanPayNow: bigint;
  /**
   * Maximum fees the untouched coins can pay across the whole ramp — what they
   * hold now plus what they generate during
   * {@link secondsToLaneCapablePerCoin}.
   */
  feesUntouchedCoinsCanPayDuringRamp: bigint;

  /** Sustained maximum fees per hour, ×1,000 (43444 = 43.444/h). */
  feesPerHourMilli: bigint;
  /** Sustained activations per hour, ×1,000 (14446 = 14.446/h). */
  activationsPerHourMilli: bigint;
  /** Sustained activations-with-a-send per hour, ×1,000. */
  activationsWithSendPerHourMilli: bigint;

  /** Echoed for the printed plan. */
  untouchedSpendableSpecks: bigint;
  feeCapableSpecks: bigint;
  maxFeeSpecks: bigint;
  registrationFeeSpecks: bigint;
  timeToCapSeconds: bigint;
  graceSeconds: bigint;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('ceilDiv needs a positive denominator');
  return (numerator + denominator - 1n) / denominator;
}

export function computeSplitPlan(input: SplitPlanInput): SplitPlan {
  const { spendAtomicNight, outputs } = input;
  if (!Number.isInteger(outputs) || outputs < 1) {
    throw new Error('outputs must be a positive integer');
  }
  if (spendAtomicNight <= 0n) {
    throw new Error('spendAtomicNight must be positive');
  }

  const parameters = input.parameters ?? LEDGER_DUST_PARAMETERS;
  const maxFeeSpecks = input.maxFeeSpecks ?? MEASURED_MAX_FEE_SPECKS;
  const registrationFeeSpecks =
    input.registrationFeeSpecks ?? MEASURED_DUST_REGISTRATION_FEE_SPECKS;
  const feeCapableSpecks = input.feeCapableSpecks ?? FEE_CAPABLE_SPECKS;
  const activationFeeSpecks = input.activationFeeSpecks ?? MEASURED_ACTIVATION_FEE_SPECKS;
  const activationWithSendFeeSpecks =
    input.activationWithSendFeeSpecks ?? MEASURED_ACTIVATION_WITH_SEND_FEE_SPECKS;
  const untouchedCoinsAtomicNight = input.untouchedCoinsAtomicNight ?? [];
  const untouchedSpendableSpecks = input.untouchedSpendableSpecks ?? 0n;

  const outputsBig = BigInt(outputs);
  const perCoinAtomicNight = input.perCoinAtomicNight ?? spendAtomicNight / outputsBig;
  if (perCoinAtomicNight <= 0n) {
    throw new Error('outputs exceeds the atomic NIGHT available to split');
  }
  const remainderAtomicNight = spendAtomicNight - perCoinAtomicNight * outputsBig;
  /* A negative remainder would mean the change output owes the transaction
     NIGHT it does not have — the SDK would refuse, but not before a seed had
     been read and a facade opened. Refuse here, in arithmetic. */
  if (remainderAtomicNight < 0n) {
    throw new Error(
      `${outputs} outputs of ${perCoinAtomicNight} atomic NIGHT need ${perCoinAtomicNight * outputsBig}, and the chosen inputs carry only ${spendAtomicNight}`,
    );
  }

  const untouchedAtomicNight = untouchedCoinsAtomicNight.reduce((sum, coin) => {
    if (coin <= 0n) throw new Error('an untouched UTxO cannot hold zero or negative NIGHT');
    return sum + coin;
  }, 0n);
  const totalAtomicNight = spendAtomicNight + untouchedAtomicNight;

  const perCoinCapSpecks = perCoinAtomicNight * parameters.nightDustRatio;
  const totalCapSpecks = totalAtomicNight * parameters.nightDustRatio;
  const perCoinSpecksPerSecond = perCoinAtomicNight * parameters.generationDecayRate;
  const newCoinsSpecksPerSecond =
    (perCoinAtomicNight * outputsBig + remainderAtomicNight) * parameters.generationDecayRate;
  const untouchedSpecksPerSecond = untouchedAtomicNight * parameters.generationDecayRate;
  const aggregateSpecksPerSecond = totalAtomicNight * parameters.generationDecayRate;
  const aggregateSpecksPerHour = aggregateSpecksPerSecond * 3_600n;

  const secondsToLaneCapablePerCoin = ceilDiv(feeCapableSpecks, perCoinSpecksPerSecond);
  const secondsToFirstFeeAcrossNewCoins = ceilDiv(maxFeeSpecks, newCoinsSpecksPerSecond);

  /* A coin big enough to hold a whole fee at CAP is a coin that will carry a
     lane; whether it holds one right now is `untouchedSpendableSpecks`, which
     the ramp figures below use. Counting caps here keeps the lane arithmetic
     independent of the moment the plan is printed. */
  const untouchedFeeCapableCoins = untouchedCoinsAtomicNight.filter(
    (coin) => coin * parameters.nightDustRatio >= feeCapableSpecks,
  ).length;
  const laneCeiling = input.laneCeiling ?? untouchedFeeCapableCoins + outputs;
  if (!Number.isInteger(laneCeiling) || laneCeiling < 1) {
    throw new Error('laneCeiling must be a positive integer (BALANCER_SPEND_LANES is at least 1)');
  }

  const feesUntouchedCoinsCanPayNow = untouchedSpendableSpecks / maxFeeSpecks;
  const feesUntouchedCoinsCanPayDuringRamp =
    (untouchedSpendableSpecks + untouchedSpecksPerSecond * secondsToLaneCapablePerCoin) /
    maxFeeSpecks;

  return {
    outputs,
    spendAtomicNight,
    untouchedAtomicNight,
    untouchedCoins: untouchedCoinsAtomicNight.length,
    totalAtomicNight,

    perCoinAtomicNight,
    remainderAtomicNight,
    explicitOutputs: outputs - 1,
    changeAtomicNight: perCoinAtomicNight + remainderAtomicNight,

    perCoinCapSpecks,
    totalCapSpecks,
    perCoinSpecksPerSecond,
    newCoinsSpecksPerSecond,
    untouchedSpecksPerSecond,
    aggregateSpecksPerSecond,
    aggregateSpecksPerHour,

    secondsToRegistrationFeePerCoin: ceilDiv(registrationFeeSpecks, perCoinSpecksPerSecond),
    secondsToFirstFeePerCoin: ceilDiv(maxFeeSpecks, perCoinSpecksPerSecond),
    secondsToSecondFeePerCoin: ceilDiv(maxFeeSpecks * 2n, perCoinSpecksPerSecond),
    secondsToLaneCapablePerCoin,
    secondsToFirstFeeAcrossNewCoins,

    /* The untouched coins are the whole argument for this shape of split: if
       one of them can pay a fee, the wallet never stops being able to. */
    blackoutSeconds: feesUntouchedCoinsCanPayNow > 0n ? 0n : secondsToFirstFeeAcrossNewCoins,

    lanesAtSplit: Math.max(1, Math.min(laneCeiling, untouchedFeeCapableCoins)),
    lanesWhenRamped: Math.max(1, Math.min(laneCeiling, untouchedFeeCapableCoins + outputs)),
    laneCeiling,
    feesUntouchedCoinsCanPayNow,
    feesUntouchedCoinsCanPayDuringRamp,

    feesPerHourMilli: (aggregateSpecksPerHour * 1_000n) / maxFeeSpecks,
    activationsPerHourMilli: (aggregateSpecksPerHour * 1_000n) / activationFeeSpecks,
    activationsWithSendPerHourMilli:
      (aggregateSpecksPerHour * 1_000n) / activationWithSendFeeSpecks,

    untouchedSpendableSpecks,
    feeCapableSpecks,
    maxFeeSpecks,
    registrationFeeSpecks,
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
  const whole = atomic / ATOMIC_PER_NIGHT;
  const fraction = (atomic < 0n ? -atomic : atomic) % ATOMIC_PER_NIGHT;
  return `${whole}.${fraction.toString().padStart(6, '0')}`;
}

/* Rounded to nearest, not truncated: 603,650 s is seven days, and calling it
   six would understate how long the old coin lasts. */
function formatDuration(seconds: bigint): string {
  if (seconds === 0n) return 'none';
  if (seconds < 5_400n) return `${seconds} s (${(seconds + 30n) / 60n} min)`;
  if (seconds < 172_800n) return `${seconds} s (${(seconds + 1_800n) / 3_600n} h)`;
  return `${seconds} s (${(seconds + 43_200n) / 86_400n} days)`;
}

export function formatSplitPlan(plan: SplitPlan): string {
  return [
    `DUST-coin split plan — ${plan.outputs} coins of ${formatNightAtomic(plan.perCoinAtomicNight)} NIGHT`,
    '',
    `  NIGHT spent by this split  ${formatNightAtomic(plan.spendAtomicNight)} (${plan.spendAtomicNight} atomic)`,
    `  NIGHT left untouched       ${formatNightAtomic(plan.untouchedAtomicNight)} in ${plan.untouchedCoins} UTxO(s) — these keep paying fees`,
    `  NIGHT in the wallet        ${formatNightAtomic(plan.totalAtomicNight)} (unchanged by the split)`,
    '',
    `  per coin                   ${formatNightAtomic(plan.perCoinAtomicNight)} (${plan.perCoinAtomicNight} atomic)`,
    `  explicit outputs           ${plan.explicitOutputs} × ${plan.perCoinAtomicNight} atomic`,
    `  change output              ${plan.changeAtomicNight} atomic (remainder ${plan.remainderAtomicNight})`,
    '',
    `  cap per coin               ${plan.perCoinCapSpecks} Specks`,
    `  cap in total               ${plan.totalCapSpecks} Specks (unchanged by the split)`,
    `  generation per coin        ${plan.perCoinSpecksPerSecond} Specks/s`,
    `  generation, untouched      ${plan.untouchedSpecksPerSecond} Specks/s — never interrupted`,
    `  generation in total        ${plan.aggregateSpecksPerSecond} Specks/s (unchanged by the split)`,
    `  time to cap                ${formatDuration(plan.timeToCapSeconds)}`,
    `  spent-coin grace           ${formatDuration(plan.graceSeconds)}`,
    '',
    `  blackout                   ${formatDuration(plan.blackoutSeconds)} — the untouched coins hold ${plan.feesUntouchedCoinsCanPayNow} max fee(s) right now`,
    `  DUST registration per coin ${formatDuration(plan.secondsToRegistrationFeePerCoin)} (fee ${plan.registrationFeeSpecks} Specks, if it is charged at all)`,
    `  a lane per new coin after  ${formatDuration(plan.secondsToLaneCapablePerCoin)} — clears ${plan.feeCapableSpecks} Specks, when the split starts paying`,
    `  one max fee per coin after ${formatDuration(plan.secondsToFirstFeePerCoin)}`,
    `  two max fees per coin      ${formatDuration(plan.secondsToSecondFeePerCoin)}`,
    '',
    `  lanes the moment it lands  ${plan.lanesAtSplit} (the untouched coins)`,
    `  lanes once ramped          ${plan.lanesWhenRamped} — needs BALANCER_SPEND_LANES ≥ ${plan.lanesWhenRamped}`,
    `  ramp budget                ${plan.feesUntouchedCoinsCanPayDuringRamp} max fee(s) from the untouched coins alone`,
    '',
    `  sustained fees/hour        ${formatMilli(plan.feesPerHourMilli)}`,
    `  sustained activations/hour ${formatMilli(plan.activationsPerHourMilli)} (${formatMilli(plan.activationsWithSendPerHourMilli)} with a first send)`,
    '',
    '  Nothing above moves anything. Read ops/SPLIT.md before --execute.',
  ].join('\n');
}
