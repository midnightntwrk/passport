/**
 * The rule that keeps a grant coin out of a Passport that has no name.
 *
 * THE DEFECT THIS EXISTS FOR (sponsor soak, 2026/09/04)
 * ------------------------------------------------------------------------
 * One signup was refused its name at the sponsor's own hourly ceiling and was
 * funded anyway, a second later:
 *
 *     17:38:02  POST /register-alias -> 429  {"error":"rate-limited", …}
 *     17:39:44  POST /fund-account   -> 200  (after 101.2 s)
 *
 * That Passport ended holding NIGHT and a stablecoin balance with no name
 * against it — half-provisioned, and a grant coin spent for it. The sponsor
 * hands out one grant per account, ever, so the coin is not recoverable by
 * asking again later: it went to an account nobody can send to by name.
 *
 * THE ORDER THE CODE ACTUALLY USES, WHICH IS WHY A FLAG AND NOT A BRANCH
 * ------------------------------------------------------------------------
 * The grant is NOT fired after the registration answers. Since 2026/09/02 a
 * claim fires it the moment the account contract LANDS — see the
 * `void fundAccountOnce(deployment.address)` in `App.tsx`'s claim — because an
 * activation is ~250 s of the sponsor's own work and starting it after the
 * name costs the account the whole registration. The registration is posted
 * earlier still, as soon as the deploy's address is known.
 *
 * So the two answers race, and both orders happen:
 *
 *   - the refusal first, then the landing. This is what the soak recorded: a
 *     ceiling refusal takes ~25 s and a landing waits for the indexer, so the
 *     refusal was already in hand one second before the grant was asked for.
 *   - the landing first, then the refusal. A registration that fails slowly —
 *     the service proving, then refusing — leaves a schedule already running.
 *
 * A branch at the call site can only fix the first. A flag fixes both: it is
 * consulted before every attempt in the schedule, so a refusal that arrives
 * mid-flight stops the attempts that have not been made yet, and one that
 * arrives before the landing means none is ever made.
 *
 * WHAT LIFTS IT
 * ------------------------------------------------------------------------
 * The name registering, and nothing else. `App.tsx` releases the hold on a
 * claim that returns a registered name and asks for the grant in the same
 * breath — which covers onboarding and the queued name's "Register now"
 * alike, because both run the one claim. A hold nobody lifts is an account
 * that is never funded, and that is the intended direction: no name, no
 * grant, and a coin left for a Passport that will have one.
 *
 * PERSISTED, because the race it settles outlives the tab. The claim's own
 * schedule dies with the page; the wallet-ready effect in `App.tsx` asks for a
 * pending grant on EVERY launch, so a hold kept only in memory would be gone
 * by the first reload and the coin spent on the second visit instead of the
 * first.
 */

/**
 * Accounts whose activation grant is held, keyed by contract address — what a
 * Passport has exactly one of, and the key the sponsor's own once-per-account
 * ledger uses. The value is the refusal code that placed the hold, which is
 * for a person reading their own storage; nothing branches on it.
 */
const ACTIVATION_HELD_STORAGE_PREFIX = 'mn-passport:activation-held:';

/**
 * Refusal codes that do NOT hold the grant, because the name may already be on
 * chain under them.
 *
 * `registration-in-flight` and `confirmation-failed` are the two refusals the
 * service makes when it cannot say whether the registration landed — they are
 * the same pair `AliasSponsorRefusal.selfPayWorthTrying` refuses a retry for,
 * for the same reason. Holding the grant on a name that may be registered
 * would strand a Passport that is complete, and the account is fundable either
 * way: the sponsor's grant does not depend on the name.
 *
 * Every other refusal — `rate-limited` at the ceiling, `funder-empty`,
 * `funder-no-dust`, `name-taken`, a 500 nobody can classify — leaves the name
 * genuinely unregistered and queued, and holds the grant.
 */
const ACTIVATION_NOT_HELD_CODES = new Set(['registration-in-flight', 'confirmation-failed']);

/** Whether a registration refused with this code must hold the account's grant. */
export function refusalHoldsActivation(code: string): boolean {
  return !ACTIVATION_NOT_HELD_CODES.has(code);
}

/**
 * Holds this account's activation grant until its name registers.
 *
 * Best-effort, like every other marker this app keeps: storage denied to the
 * document leaves the hold unplaced rather than failing a claim that has
 * already told the user what happened. The cost of the write not landing is
 * the defect as it stands today, which is a coin — the cost of throwing here
 * would be the claim's own error being replaced by a storage one.
 */
export function holdActivationGrant(contractAddress: string, reason: string): void {
  try {
    window.localStorage.setItem(`${ACTIVATION_HELD_STORAGE_PREFIX}${contractAddress}`, reason);
  } catch {
    // See above: a hold that cannot be written is not worth a thrown claim.
  }
}

/** Lifts the hold. Called where a name registers, and nowhere else. */
export function releaseActivationGrant(contractAddress: string): void {
  try {
    window.localStorage.removeItem(`${ACTIVATION_HELD_STORAGE_PREFIX}${contractAddress}`);
  } catch {
    /* The release failing is the one direction that cannot cost a coin: the
       account simply stays held, and the next successful claim releases it. */
  }
}

/**
 * Whether this account's grant is held right now.
 *
 * Unreadable storage answers FALSE — the same answer the funding marker gives,
 * and for the same reason: a browser that cannot be read about an account has
 * told us nothing about it, and the sponsor's own once-per-account ledger is
 * the gate that actually holds. This flag exists to stop a coin going to a
 * nameless Passport, not to stand in for that ledger.
 */
export function activationGrantHeld(contractAddress: string): boolean {
  try {
    return (
      window.localStorage.getItem(`${ACTIVATION_HELD_STORAGE_PREFIX}${contractAddress}`) !== null
    );
  } catch {
    return false;
  }
}
