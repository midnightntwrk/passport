/**
 * Length caps the Passport wire protocols share.
 *
 * They live here, in one module, because the two address caps DIVERGE and the
 * divergence is deliberate. Left in their own files they read as an accident
 * and drift apart on the next edit; side by side, the reason is visible and
 * a change to one is a change made in sight of the other.
 *
 * WHY THEY DIFFER. A profile address may be a bech32m SHIELDED address (or a
 * dust address), which runs long — hence 512. A transaction recipient is
 * UNSHIELDED-only by protocol: `unshielded-transfer` is the single intent kind
 * the tx protocol carries, so a recipient that needed more than 200 characters
 * would not be a recipient this protocol can pay. The tighter bound is the
 * honest one there, and loosening it to match the profile cap would widen the
 * text a hostile app can push into an approval sheet for no gain.
 *
 * Neither value changes here. Raising the tx cap is only correct alongside a
 * shielded intent kind; raising the profile cap needs a longer address format
 * to point at.
 */

/** Profile addresses. The account-custody contract address is bech32m. */
export const MAX_PROFILE_ADDRESS_LENGTH = 512;

/** Transaction recipients: unshielded only, and deliberately tighter. */
export const MAX_TX_RECIPIENT_ADDRESS_LENGTH = 200;

/** Ids, nonces, names, network labels — every short string on every channel. */
export const MAX_STRING_LENGTH = 256;

/** A transaction purpose, as it is shown on Passport's approval sheet. */
export const MAX_PURPOSE_LENGTH = 140;

/** A wallet's own sentence about why a transaction did not happen. */
export const MAX_DETAIL_LENGTH = 400;

/** An incentive label, as an app reports it. */
export const MAX_LABEL_LENGTH = 80;

/** A note about who covered the network fee. */
export const MAX_FEE_NOTE_LENGTH = 140;
