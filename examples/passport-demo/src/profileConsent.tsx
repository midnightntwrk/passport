import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ExternalLink, ShieldCheck, X } from 'lucide-react';
import {
  createPassportProfileReady,
  createPassportProfileResponse,
  pairOfUnreadableMessage,
  readPassportProfileRequest,
  type PassportProfileField,
  type PassportProfileRequest,
  type PassportProfileResponse,
} from './backend.js';

interface ProfileConsentProps {
  /**
   * Whether a Passport session is open. While it is
   * false the popup is still mid-sign-in — the passkey ceremony takes as long
   * as it takes — so the unavailability grace timer must not run: answering
   * "unavailable" then would refuse every standalone popup connect.
   */
  sessionActive: boolean;
  displayName: string | null;
  passportContract: {
    address: string;
    network: string;
  } | null;
  /**
   * @deprecated Ignored, and removed from the wire on 2026/09/01 with the
   * account-custody ruling: the transaction engine's addresses are a signing
   * detail no app has a legitimate use for, and offering them invited an app
   * to pay an address the account cannot see. The prop is still accepted so
   * the host can drop it in its own change rather than in this one; nothing
   * reads it.
   */
  midnightAddresses?: {
    unshielded: string;
    shielded?: string;
    dust?: string;
  } | null;
}

interface PendingRequest {
  request: PassportProfileRequest;
  origin: string;
  source: Window;
}

/* DONE (2026/09/01): the follow-up recorded here on 2026/08/25 — that
   `midnightAddresses` should leave the profile protocol altogether — has
   happened. A Passport user's identity is their account-custody contract, and
   `passportContract` is what an app keys on; the three engine addresses were a
   signing detail no dApp had a legitimate use for, and offering them here
   invited an app to pay an address the account cannot see. There is one copy
   of the vocabulary now, in `@midnight-passport/connect`, so removing the
   field was a single edit rather than a wire change replicated across three
   files that were asked to stay byte-identical. */
const FIELD_LABELS: Record<PassportProfileField, string> = {
  displayName: 'Passport display name',
  passportContract: 'Your Passport account — its address and network',
};

/**
 * How long a request may wait, ONCE A SESSION IS OPEN, for the profile props
 * to hydrate before the opener is told the profile is unavailable. The props
 * arrive asynchronously (session resume, wallet surfaces), so answering
 * instantly would refuse requests this Passport could in fact serve — but
 * never answering at all leaves the opener hanging on a window whose fields
 * genuinely failed to hydrate. Before a session exists the timer never runs:
 * the user may still be mid-passkey-ceremony, and that takes as long as it
 * takes.
 */
const PROFILE_WAIT_MS = 5_000;

function launchParameters(): { requestId: string; nonce: string } | null {
  const parameters = new URLSearchParams(window.location.search);
  const requestId = parameters.get('passportRequestId');
  const nonce = parameters.get('passportNonce');
  if (!requestId || !nonce || !window.opener) return null;
  return { requestId, nonce };
}

export function PassportProfileConsent({
  sessionActive,
  displayName,
  passportContract,
}: ProfileConsentProps) {
  const launch = useMemo(launchParameters, []);
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const [outcome, setOutcome] = useState<'approved' | 'denied' | 'unavailable' | null>(null);

  /* Exactly one reply per window, whatever React does around it: the grace
     timer below can be armed twice on mount under StrictMode, and posting a
     second answer to a question already answered would let the opener see a
     refusal after an approval — or two different profiles. Mirrors the same
     guard in `txConsent.tsx`. */
  const answered = useRef(false);

  /**
   * The single exit from this window. Every reply goes through here, so the
   * first answer is the only one that ever reaches the opener — a later one
   * would contradict it, and the opener has no way to tell which is real.
   */
  function replyOnce(
    target: PendingRequest,
    body: Omit<PassportProfileResponse, 'protocol' | 'type' | 'version' | 'requestId' | 'nonce'>,
  ): boolean {
    if (answered.current) return false;
    answered.current = true;
    target.source.postMessage(
      createPassportProfileResponse(target.request, body),
      target.origin,
    );
    return true;
  }

  useEffect(() => {
    if (!launch || !window.opener) return;
    const opener = window.opener;
    /* The wildcard is deliberate, and it is the only origin this line can
       name. A window opened by an app learns that app's origin only when a
       message arrives from it, and this is the message that invites one.
       What it carries is the request id and nonce the opener itself minted
       and passed in through the launch URL, so it tells the opener nothing
       it did not already know, and every later reply is sent to the origin
       the first message revealed. */
    // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration
    opener.postMessage(createPassportProfileReady(launch.requestId, launch.nonce), '*');

    const onMessage = (event: MessageEvent) => {
      if (event.source !== opener) return;
      const parsed = readPassportProfileRequest(event.data);
      if (parsed.kind !== 'ok') {
        /* NOT silence. A message that IS a profile request and that this build
           cannot read used to be dropped, and the opener experienced that as
           a three-minute hang it could not tell from Passport being absent.
           It is answered now — but only when it is addressed to THIS window's
           launch pair, so a stray message from another exchange cannot spend
           the one reply this window is allowed. */
        if (parsed.kind === 'not-passport') return;
        const pair = pairOfUnreadableMessage(event.data);
        if (!pair || pair.requestId !== launch.requestId || pair.nonce !== launch.nonce) return;
        const error = parsed.kind === 'version-mismatch' ? 'version_mismatch' : 'invalid_request';
        if (
          replyOnce(
            { request: { ...pair } as PassportProfileRequest, origin: event.origin, source: opener },
            { approved: false, error },
          )
        ) {
          setOutcome('unavailable');
        }
        return;
      }
      const request = parsed.value;
      if (request.requestId !== launch.requestId || request.nonce !== launch.nonce) return;
      /* One exchange per launch. The launch pair already fixes WHICH request
         this window serves, but the opener can re-send it — and a later
         message could arrive while the user is reading the sheet, swapping
         the request out from under the consent they are about to give. A
         re-send of the same pair is the same request, not a second sheet, so
         the first one stands and the rest are ignored rather than refused. */
      setPending((current) => current ?? { request, origin: event.origin, source: opener });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [launch]);

  const profileReady =
    !pending ||
    pending.request.fields.every((field) => {
      if (field === 'displayName') return Boolean(displayName);
      return true;
    });

  /* A request this Passport cannot serve must still be answered — silence
     leaves the opener disabled forever. But "cannot serve" is only knowable
     once a session is open: before then the user is mid-sign-in, so wait
     indefinitely. With a session open, if the profile has not hydrated within
     the grace period, tell the opener so; the timer is cancelled the moment
     the fields arrive. */
  useEffect(() => {
    if (!pending || !sessionActive || profileReady || outcome) return;
    const timer = window.setTimeout(() => {
      if (!replyOnce(pending, { approved: false, error: 'profile_unavailable' })) return;
      setOutcome('unavailable');
    }, PROFILE_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [pending, sessionActive, profileReady, outcome]);

  if (!launch || !pending) return null;
  /* Not ready and not yet answered: the grace timer above is running. */
  if (!profileReady && !outcome) return null;

  const send = (
    response: Omit<
      PassportProfileResponse,
      'protocol' | 'type' | 'version' | 'requestId' | 'nonce'
    >,
  ) => replyOnce(pending, response);

  const approve = () => {
    const profile: NonNullable<PassportProfileResponse['profile']> = {};
    for (const field of pending.request.fields) {
      if (field === 'displayName' && displayName) profile.displayName = displayName;
      if (field === 'passportContract' && passportContract) {
        profile.passportContract = passportContract;
      }
    }
    /* An approval that carries nothing is not an approval. The grace timer
       above only guards `displayName`, so a request
       for `passportContract` alone reaches this button on a Passport that has
       not deployed one — and `{ approved: true, profile: {} }` parses, leaving
       the app to read a yes and find no fields behind it. Answer with what is
       true instead, exactly as the in-app browser's sheet does. */
    if (Object.keys(profile).length === 0) {
      if (send({ approved: false, error: 'profile_unavailable' })) setOutcome('unavailable');
      return;
    }
    /* The outcome only changes if this reply is the one that left: a window
       that already answered says what it actually said, never what the last
       button tapped would have said. */
    if (send({ approved: true, profile })) setOutcome('approved');
  };

  const deny = () => {
    if (send({ approved: false, error: 'denied' })) setOutcome('denied');
  };

  return (
    <div className="profile-consent-backdrop">
      <section
        className="profile-consent"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-consent-title"
      >
        <header>
          <span className="profile-consent-mark">
            <ShieldCheck size={20} />
          </span>
          <div>
            <p>Passport connection</p>
            <h2 id="profile-consent-title">
              {outcome === 'approved'
                ? 'Profile shared.'
                : outcome === 'denied'
                  ? 'Request declined.'
                  : outcome === 'unavailable'
                    ? 'Profile not ready.'
                    : 'Share your public profile?'}
            </h2>
          </div>
        </header>

        {outcome ? (
          <div className={`profile-consent-outcome ${outcome}`}>
            {outcome === 'approved' ? <Check size={22} /> : <X size={22} />}
            <p>
              {outcome === 'approved'
                ? `Approved fields were returned only to ${pending.origin}.`
                : outcome === 'unavailable'
                  ? `Passport has no profile to share yet, so nothing was returned to ${pending.origin}. Finish setting up this Passport, then ask again from the app.`
                  : `No Passport data was returned to ${pending.origin}.`}
            </p>
            <button type="button" onClick={() => window.close()}>
              Close window
            </button>
          </div>
        ) : (
          <>
            <p className="profile-consent-origin">
              <ExternalLink size={15} />
              <span>{pending.origin}</span>
            </p>
            <p className="profile-consent-copy">
              This application is asking Passport for:
            </p>
            <ul>
              {pending.request.fields.map((field) => (
                <li key={field}>
                  <Check size={15} />
                  <span>{FIELD_LABELS[field]}</span>
                  {field === 'passportContract' && !passportContract && (
                    <small>Not deployed yet</small>
                  )}
                </li>
              ))}
            </ul>
            <div className="profile-consent-boundary">
              Private state, passkey references, recovery data, and IndexedDB records are never
              shared.
            </div>
            <div className="profile-consent-actions">
              <button type="button" className="deny" onClick={deny}>
                Decline
              </button>
              <button type="button" className="approve" onClick={approve} disabled={!profileReady}>
                <ShieldCheck size={16} />
                {/* "Selected" would be a lie on this surface: unlike the in-app
                    browser's sheet there is nothing to tick here, and the
                    button shares every field listed above that this Passport
                    can serve. */}
                Share these fields
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
