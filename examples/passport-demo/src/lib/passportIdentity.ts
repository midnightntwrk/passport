/**
 * WHAT COUNTS AS A PASSPORT, when an app asks for one.
 *
 * Two questions live here, and they were both being answered by the same wrong
 * thing — the label a passkey happened to be enrolled under.
 *
 * ---------------------------------------------------------------------------
 * 1. WHAT `displayName` IS
 * ---------------------------------------------------------------------------
 *
 * It is the `.night` name this Passport holds, and nothing else. It used to
 * fall back to the enrolled passkey's label, which on nearly every device is
 * the string 'Midnight Passport' — so a Passport with no name answered an app
 * with the name of the app, presented as the user's own. Captured off
 * production on 2026/09/08: `profile: { displayName: 'Midnight Passport' }`,
 * signed, in an app's address bar.
 *
 * That is worse than sharing nothing. An app that keys a greeting, a record, or
 * an account on `displayName` would have keyed every no-name Passport in the
 * world onto one value. Withholding it is honest and the protocol already has
 * the words for it: the field is named in the reply's `withheld` list and the
 * consent sheet marks it "Not set — will not be shared", exactly as the
 * account contract row already did.
 *
 * A QUEUED OR FAILED name is not a name either. The record exists from the
 * moment a claim is attempted, and a claim that has not landed is a name this
 * Passport does not hold; offering it would let an app record a name the
 * registry would not resolve.
 *
 * ---------------------------------------------------------------------------
 * 2. WHEN A CONSENT SHEET MAY ARM
 * ---------------------------------------------------------------------------
 *
 * A modal sheet over onboarding is a locked door. Because the passkey label was
 * always truthy, both consent surfaces read "this Passport has a display name"
 * the instant a passkey existed, and armed over the Welcome screen of a
 * Passport that was not set up yet — backdrop and all. The user could not reach
 * the button that would have made the answer possible, and the app on the other
 * side waited out its three minutes.
 *
 * So the sheets ask this instead, and it is deliberately about the Passport
 * rather than about the fields: a Passport is set up when it holds a registered
 * name, or — for somebody who left the name step behind — when its account is
 * deployed and the name step has been settled. Until then the app is told
 * nothing and shown nothing modal: {@link PASSPORT_SETUP_WAITING_MESSAGE} is a
 * banner beside the onboarding the user is in the middle of, and the sheet arms
 * by itself the moment the Passport becomes one.
 *
 * The transaction consent does NOT share this rule and deliberately reads none
 * of this: a payment needs a wallet that can sign, not a name, and it already
 * waits on exactly that.
 */

/** The three states an alias record can be in. Mirrors `identity/aliasStore`. */
export type PassportNameStatus = 'registered' | 'queued' | 'failed';

/** The half of an alias record these rules read. Structural on purpose. */
export interface PassportNameRecord {
  readonly domain: string;
  readonly status: PassportNameStatus;
}

/**
 * The `.night` name Passport is willing to share, or `null` when there is none
 * to share.
 *
 * `null` rather than a placeholder, and never the device's label: see the
 * header. A blank or whitespace-only domain is treated as no name, because a
 * name made only of spaces is not one a registry resolved.
 */
export function shareableDisplayName(record: PassportNameRecord | null | undefined): string | null {
  if (!record || record.status !== 'registered') return null;
  const domain = record.domain.trim();
  return domain.length > 0 ? domain : null;
}

export interface PassportSetUpInput {
  /** The registered `.night` name, from {@link shareableDisplayName}. */
  readonly registeredName: string | null;
  /** Whether the account-custody contract is genuinely deployed. */
  readonly accountDeployed: boolean;
  /** Whether this credential has settled the name step in this browser. */
  readonly nameStepSettled: boolean;
}

/**
 * Whether this Passport is enough of a Passport to answer an app.
 *
 * A name is sufficient on its own — a name cannot be registered without the
 * account beneath it. Without one, a deployed account plus a settled name step
 * is the other way to be finished: it is somebody who chose to carry on, and
 * they still have an identity an app can key on.
 */
export function passportIsSetUp(input: PassportSetUpInput): boolean {
  if (input.registeredName !== null) return true;
  return input.accountDeployed && input.nameStepSettled;
}

/**
 * What is shown beside onboarding while an app waits.
 *
 * It says a thing is waiting and what ends the wait. It does not name the app's
 * origin — that belongs on the consent sheet, where there is room to read it
 * before deciding — and it offers no button, because the only useful action is
 * the one already on the screen behind it.
 */
export const PASSPORT_SETUP_WAITING_MESSAGE =
  'An app is waiting for your Passport. Finish setting up and it will be shared.';
