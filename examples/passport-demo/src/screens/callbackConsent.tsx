import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AlertTriangle, ArrowRight, Check, ExternalLink, Loader2, ShieldCheck, X } from 'lucide-react';
import {
  buildPassportCallbackPayload,
  passportCallbackErrorUrl,
  passportCallbackSuccessUrl,
  sealPassportCallbackResponse,
  selectPassportCallbackProfile,
  type PassportCallbackLaunch,
  type PassportCallbackSigner,
} from '../identity/callbackProtocol.js';
import {
  settlePassportCallbackLaunch,
  type PassportCallbackLaunchRecord,
} from '../identity/callbackLaunch.js';

/**
 * The URL-callback consent surface — third sibling of `../profileConsent.tsx`
 * (popup profile) and `../txConsent.tsx` (popup payment), and the only one of
 * the three that survives a navigation.
 *
 * The contract it serves, and every rule it enforces, is documented in
 * `../identity/callbackProtocol.ts`. Read that first; this file is the
 * interface, not the specification.
 *
 * What is specific to this surface:
 *
 *   - It is armed by `passportCallback` on Passport's OWN launch URL, captured
 *     at module-import time by `../identity/callbackLaunch.ts`. On every other
 *     launch it renders nothing, exactly as its two siblings do.
 *   - It waits out the whole onboarding. `sessionActive` is false while the
 *     user is creating a passkey, opening a wallet, or claiming a name, and
 *     nothing is shown then — the request has not gone anywhere, it is simply
 *     not this user's business yet. When the user was already signed in,
 *     `sessionActive` is true on the first render and the sheet appears
 *     immediately.
 *   - The callback target is PINNED on first render (see `pinned` below). The
 *     origin the user reads and the origin the reply is sent to are the same
 *     object, so nothing that changes afterwards can redirect an approval
 *     somewhere else.
 *   - Both answers are a full-page redirect. There is no window to post back
 *     through: the tab that started this may not exist any more, which is the
 *     whole reason this contract exists.
 *   - A malformed launch produces a dismissible notice over the normal app —
 *     never a broken screen, and never a redirect. A launch we could not parse
 *     is a launch whose return address we may not be able to trust.
 *
 * STYLING. This reuses the `.profile-consent*` classes from `../styles.css`
 * deliberately: the two sheets are the same object in the user's mind and
 * should not drift apart. The malformed-launch notice is the one thing with no
 * existing class, so it carries inline styles rather than growing the
 * stylesheet for a surface that appears only when a developer has made a
 * mistake.
 */

interface CallbackConsentProps {
  /** The launch captured at import time. Absent on an ordinary Passport visit. */
  launch: PassportCallbackLaunchRecord;
  /**
   * Whether a Passport session is open. False while
   * the user is still onboarding, so the hydration grace timer below must not
   * run: a passkey ceremony takes as long as it takes, and answering
   * "unavailable" during one would refuse every first-time user.
   */
  sessionActive: boolean;
  displayName: string | null;
  passportContract: { address: string; network: string } | null;
  midnightAddresses: { unshielded: string; shielded?: string; dust?: string } | null;
  /**
   * The signing seam, read LAZILY at approve time rather than passed as a
   * value: the wallet lives in a ref in `App.tsx` and may open after this
   * component first renders, so a value captured during render would be stale
   * exactly when it matters.
   *
   * Structurally identical to `wallet.keys.unshieldedKeystore`, so the host
   * wires it with no adapter. Return null when nothing in this tab can sign,
   * and the reply goes out honestly unsigned rather than with a fabricated
   * signature.
   */
  getSigningKeystore?: () => {
    getPublicKey(): TaggedKeyMaterial;
    signData(data: Uint8Array): TaggedKeyMaterial;
  } | null;
}

/**
 * What a ledger-9 keystore hands back: `{ tag, value }`, where `tag` names the
 * signature scheme (`schnorr` for the NightExternal role key) and `value` is
 * the hex.
 *
 * On ledger-8 both were bare strings, and this seam took `string`. Structural
 * rather than imported so this component keeps no dependency on the ledger, and
 * so the shape is stated where it is consumed. See {@link encodeTagged} for why
 * the tag is not thrown away.
 */
interface TaggedKeyMaterial {
  readonly tag: string;
  readonly value: string;
}

/**
 * `"<scheme>:<hex>"` — the wire form of a ledger-9 key or signature.
 *
 * The tag is carried rather than dropped because an unqualified hex string of a
 * schnorr key and of an ECDSA key are indistinguishable, and a receiver that
 * cannot tell which scheme signed cannot verify at all. This is a deliberate
 * change of the `v1` callback wire format, made at the same moment the app
 * changed ledger; every party to it is on the ledger-9 build.
 */
function encodeTagged(material: TaggedKeyMaterial): string {
  return `${material.tag}:${material.value}`;
}

/* Word for word `../profileConsent.tsx`, and for the reason given there: the
   wire field still carries all three of the transaction engine's addresses,
   but they are kept out of Passport's primary UI and a consent sheet must not
   be where the fee token first reaches a user. The two sheets are one object
   in the user's mind, so the labels cannot drift apart. */
const FIELD_LABELS = {
  displayName: 'Passport display name',
  passportContract: 'Your Passport account — its address and network',
  midnightAddresses: 'Midnight technical addresses',
} as const;

/**
 * How long a launch may wait, ONCE A SESSION IS OPEN, for the profile props to
 * hydrate. The same five seconds and the same reasoning as
 * `../profileConsent.tsx`: the wallet surfaces arrive asynchronously, so
 * showing the sheet instantly would offer to share fields that are about to
 * appear, and waiting forever would strand a Passport whose fields genuinely
 * never arrive.
 *
 * Unlike the popup flow, elapsing does NOT mean refusal. Once the grace period
 * is over the sheet is shown with whatever exists, and each missing field is
 * marked as such — a user who skipped the name step should still be able to
 * share their addresses. Only when NOTHING was resolved is the app told
 * `profile_unavailable`.
 */
const PROFILE_WAIT_MS = 5_000;

type Outcome = 'shared' | 'declined' | 'unavailable';

type Phase =
  | { kind: 'asking' }
  /** `location.assign` has been called; this document is on its way out. */
  | { kind: 'returning'; outcome: Outcome };

const noticeStyles = {
  wrapper: {
    position: 'fixed',
    zIndex: 130,
    right: 16,
    bottom: 16,
    left: 16,
    display: 'flex',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
  notice: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
    width: 'min(520px, 100%)',
    padding: '14px 16px',
    border: '1px solid #111',
    borderLeftWidth: 3,
    color: '#111',
    background: '#f8f8f6',
    boxShadow: '0 18px 48px rgba(0, 0, 0, .28)',
    font: 'inherit',
    fontSize: 13,
    lineHeight: 1.5,
    pointerEvents: 'auto',
  },
  dismiss: {
    display: 'grid',
    placeItems: 'center',
    width: 26,
    height: 26,
    flex: '0 0 auto',
    padding: 0,
    border: '1px solid #111',
    color: '#111',
    background: 'transparent',
    cursor: 'pointer',
  },
} as const satisfies Record<string, CSSProperties>;

export function PassportCallbackConsent({
  launch,
  sessionActive,
  displayName,
  passportContract,
  midnightAddresses,
  getSigningKeystore,
}: CallbackConsentProps) {
  /**
   * THE PIN. Captured once, on first render, and never recomputed. Everything
   * below — the origin shown to the user, the fields listed, the redirect
   * target, the state echoed — reads from this one object, so the sheet the
   * user approved and the reply that leaves are provably the same request.
   */
  /* Empty dependency lists on purpose: the pin must not follow a prop change.
     `launch` is itself a module-level constant, so there is nothing to follow —
     the empty list states the invariant rather than relying on it. */
  const pinned = useMemo<PassportCallbackLaunch | null>(
    () => (launch.parse.kind === 'ok' ? launch.parse.launch : null),
    [],
  );
  const malformed = useMemo(
    () => (launch.parse.kind === 'malformed' ? launch.parse : null),
    [],
  );

  const [phase, setPhase] = useState<Phase>({ kind: 'asking' });
  const [graceElapsed, setGraceElapsed] = useState(false);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  /* Exactly one redirect per launch, whatever React does around it. Under
     StrictMode an effect body runs twice, and a second `location.assign` after
     the first would be a second answer to a question already answered. */
  const answered = useRef(false);

  const available = useMemo(() => {
    if (!pinned) return { resolved: [] as string[], missing: [] as string[] };
    const resolved: string[] = [];
    const missing: string[] = [];
    for (const field of pinned.fields) {
      const present =
        field === 'displayName'
          ? Boolean(displayName)
          : field === 'passportContract'
            ? Boolean(passportContract)
            : Boolean(midnightAddresses);
      (present ? resolved : missing).push(field);
    }
    return { resolved, missing };
  }, [displayName, midnightAddresses, passportContract, pinned]);

  /* The grace timer starts only once a session exists — before that the user
     may still be mid-ceremony — and is cancelled the moment every requested
     field has arrived. */
  const everythingResolved = available.missing.length === 0;
  useEffect(() => {
    if (!pinned || !sessionActive || everythingResolved || graceElapsed) return;
    const timer = window.setTimeout(() => setGraceElapsed(true), PROFILE_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [everythingResolved, graceElapsed, pinned, sessionActive]);

  const leave = (href: string, outcome: Outcome) => {
    if (answered.current) return;
    answered.current = true;
    /* Settled BEFORE the navigation: after `location.assign` this document may
       never run another line, and an unsettled launch would re-arm the sheet
       when the user pressed Back. */
    settlePassportCallbackLaunch(launch);
    setPhase({ kind: 'returning', outcome });
    window.location.assign(href);
  };

  /* Nothing at all to share and the grace period is over: the app is told so
     rather than being left on a spinner. This is the one automatic redirect —
     it needs no consent, because no data leaves. */
  useEffect(() => {
    if (!pinned || !sessionActive || !graceElapsed) return;
    if (available.resolved.length > 0) return;
    leave(passportCallbackErrorUrl(pinned, 'profile_unavailable'), 'unavailable');
  }, [available.resolved.length, graceElapsed, pinned, sessionActive]);

  if (malformed) {
    if (noticeDismissed) return null;
    return (
      <div style={noticeStyles.wrapper}>
        <div style={noticeStyles.notice} role="status">
          <AlertTriangle size={16} aria-hidden />
          <span style={{ flex: 1 }}>
            <strong>An app asked Passport for your profile, and the request was not valid.</strong>{' '}
            {malformed.message} Nothing was shared and no one was contacted.
          </span>
          <button
            type="button"
            style={noticeStyles.dismiss}
            aria-label="Dismiss"
            onClick={() => {
              settlePassportCallbackLaunch(launch);
              setNoticeDismissed(true);
            }}
          >
            <X size={13} aria-hidden />
          </button>
        </div>
      </div>
    );
  }

  if (!pinned) return null;
  /* Onboarding is still running, or the fields have not arrived and the grace
     period has not elapsed. Either way the app is not owed an answer yet, and
     a sheet over a passkey prompt would be worse than nothing. */
  if (!sessionActive) return null;
  if (!everythingResolved && !graceElapsed && phase.kind === 'asking') return null;

  const approve = () => {
    const profile = selectPassportCallbackProfile(pinned.fields, {
      displayName,
      passportContract,
      midnightAddresses,
    });
    const { bytes, encoded } = buildPassportCallbackPayload({ launch: pinned, profile });

    /* The keystore is read here and nowhere else — one read, at the moment the
       user consented, so a wallet that opened while the sheet was on screen is
       used and a wallet that closed is not signed with. */
    const keystore = getSigningKeystore?.() ?? null;
    let signer: PassportCallbackSigner | null = null;
    if (keystore) {
      signer = {
        publicKey: encodeTagged(keystore.getPublicKey()),
        sign: (payload) => encodeTagged(keystore.signData(payload)),
      };
    }
    const envelope = sealPassportCallbackResponse(encoded, bytes, signer);
    leave(passportCallbackSuccessUrl(pinned, envelope), 'shared');
  };

  const deny = () => leave(passportCallbackErrorUrl(pinned, 'denied'), 'declined');

  return (
    <div className="profile-consent-backdrop">
      <section
        className="profile-consent passport-callback-consent"
        role="dialog"
        aria-modal="true"
        aria-labelledby="passport-callback-consent-title"
      >
        <header>
          <span className="profile-consent-mark">
            <ShieldCheck size={20} aria-hidden />
          </span>
          <div>
            <p>Sign in to an app</p>
            <h2 id="passport-callback-consent-title">
              {phase.kind === 'returning'
                ? phase.outcome === 'shared'
                  ? 'Returning to the app.'
                  : phase.outcome === 'declined'
                    ? 'Nothing shared.'
                    : 'No profile to share.'
                : 'Share your Passport?'}
            </h2>
          </div>
        </header>

        {phase.kind === 'returning' ? (
          <div className={`profile-consent-outcome ${phase.outcome === 'shared' ? 'approved' : 'denied'}`}>
            <Loader2 size={22} aria-hidden />
            <p>
              {phase.outcome === 'shared'
                ? `Taking you back to ${pinned.callbackOrigin} with the fields you approved.`
                : phase.outcome === 'declined'
                  ? `Taking you back to ${pinned.callbackOrigin}. No Passport data went with you.`
                  : `Passport has nothing to share yet, so ${pinned.callbackOrigin} is being told that instead. Finish setting up this Passport, then try again from the app.`}
            </p>
          </div>
        ) : (
          <>
            {/* The origin, first and unabbreviated. It is the only thing on
                this sheet that tells the user who they are talking to, and a
                truncated origin is a phishable origin. */}
            <p className="profile-consent-origin">
              <ExternalLink size={15} aria-hidden />
              <span>{pinned.callbackOrigin}</span>
            </p>
            <p className="profile-consent-copy">This application is asking Passport for:</p>
            <ul>
              {pinned.fields.map((field) => (
                <li key={field}>
                  <Check size={15} aria-hidden />
                  <span>{FIELD_LABELS[field]}</span>
                  {available.missing.includes(field) && <small>Not set — will not be shared</small>}
                </li>
              ))}
            </ul>
            <div className="profile-consent-boundary">
              Private state, passkey references, recovery data, and IndexedDB records are never
              shared. The reply travels in the address bar, signed by your Passport, so the app can
              check it was not altered on the way.
            </div>
            <div className="profile-consent-actions">
              <button type="button" className="deny" onClick={deny}>
                Don’t share
              </button>
              <button type="button" className="approve" onClick={approve}>
                Share and return to {pinned.callbackOrigin.replace(/^https?:\/\//, '')}
                <ArrowRight size={16} aria-hidden />
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
