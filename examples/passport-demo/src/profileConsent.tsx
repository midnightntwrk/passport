import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ExternalLink, ShieldCheck, X } from 'lucide-react';
import { ConsentNotice } from './consentNotice.js';
import { PASSPORT_SETUP_WAITING_MESSAGE } from './lib/passportIdentity.js';
import { passportCallbackLaunch } from './identity/callbackLaunch.js';
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
  /**
   * Whether this Passport is enough of a Passport to answer an app — see
   * `./lib/passportIdentity.ts`. A session being open is NOT the same question:
   * a passkey exists long before there is an identity behind it, and this sheet
   * used to arm on the difference, putting a modal backdrop over the Welcome
   * screen and the name step. Nothing modal renders until this is true.
   */
  passportSetUp: boolean;
  /** The `.night` name, or null. Never the device's label. */
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
   the engine-address field should leave the profile protocol altogether — has
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
  /* THE OPENER IS NO LONGER PART OF THIS TEST (2026/09/05). It used to be, and
     the effect was that a launch WITH an opener and a launch that had LOST one
     were the same thing to this file — nothing. See
     {@link consentReplyChannel} for what the difference is now worth. */
  if (!requestId || !nonce) return null;
  return { requestId, nonce };
}

/**
 * Which channel, if any, can carry this window's answer back to the app that
 * asked — and the reason a Passport installed to an iPhone home screen needs
 * to be asked the question at all.
 *
 * `window.open` from a standalone iOS web app opens a SAFARI tab, and that tab
 * gets `window.opener === null`. Both consent surfaces read that as "there is
 * no launch here", so the ready handshake was never posted, the request never
 * arrived, and Passport rendered as an ordinary sign-in page over a request
 * nobody could see. The app on the other side polls `opened.closed`, which
 * reads `false` on a handle it cannot reach, so nothing there noticed either:
 * the only exit was the client's three-minute timeout, spent in silence.
 *
 * The three answers:
 *
 *   - `opener` — an ordinary pop-up. Post the handshake and serve the request,
 *     exactly as before.
 *   - `redirect` — no opener, but this load ALSO carries the signed redirect
 *     launch (`org.midnight.passport.callback/v1`), which is a channel that
 *     survives a navigation and does not depend on a window handle. That
 *     surface owns the reply, so this one shows nothing rather than a second
 *     sheet asking the same question.
 *   - `none` — a launch with no way home. Say so at once, in one sentence,
 *     rather than showing a sign-in page for three minutes.
 *
 * `null` where this load carries no launch at all, which is every ordinary
 * visit to Passport.
 *
 * `txConsent.tsx` decides by the same rule, for the same reason.
 */
export type PassportConsentChannel = 'opener' | 'redirect' | 'none';

export function consentReplyChannel(input: {
  launched: boolean;
  hasOpener: boolean;
  redirectArmed: boolean;
}): PassportConsentChannel | null {
  if (!input.launched) return null;
  if (input.hasOpener) return 'opener';
  return input.redirectArmed ? 'redirect' : 'none';
}

/**
 * What a window with no way home says, and why it is one sentence.
 *
 * It names neither the opener, the channel, nor the transport. What a reader
 * can act on is where to go back to and what to do differently, and both are
 * in the sentence.
 */
export const CONSENT_NO_CHANNEL_MESSAGE =
  'Passport has no way to send an answer back to the app that opened this. Return to the app and try again, or open its link in Safari.';

export function PassportProfileConsent({
  sessionActive,
  passportSetUp,
  displayName,
  passportContract,
}: ProfileConsentProps) {
  const launch = useMemo(launchParameters, []);
  /* Pinned on first render alongside the launch: an opener that disappears
     later must not change which channel this window decided to answer on. */
  const channel = useMemo(
    () =>
      consentReplyChannel({
        launched: launch !== null,
        hasOpener: Boolean(window.opener),
        /* The signed redirect launch, captured at import time by
           `identity/callbackLaunch.ts` and answered by
           `screens/callbackConsent.tsx`. An app that sends both survives an
           installed iOS Passport with no change on this side. */
        redirectArmed: passportCallbackLaunch.parse.kind === 'ok',
      }),
    [launch],
  );
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
    if (!launch || channel !== 'opener') return;
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
  }, [launch, channel]);

  /**
   * Whether this window can answer the request in front of it.
   *
   * TWO CONDITIONS, and the first of them was missing until 2026/09/08. A
   * Passport that is SET UP — see `./lib/passportIdentity.ts` — and whose
   * requested fields have hydrated can answer. `displayName` alone used to
   * stand for both, and because it fell back to the enrolled passkey's label it
   * was truthy the instant a passkey existed: this sheet armed over the Welcome
   * screen of a Passport with no identity at all, and its backdrop covered the
   * one action that would have given it one.
   */
  const profileReady =
    passportSetUp &&
    (!pending ||
      pending.request.fields.every((field) => {
        if (field === 'displayName') return Boolean(displayName);
        return true;
      }));

  /* A request this Passport cannot serve must still be answered — silence
     leaves the opener disabled forever. But "cannot serve" is only knowable
     once a session is open AND the Passport is one: before either, the user is
     mid-sign-in or mid-setup, so wait — the notice below says an app is
     waiting, and the wait ends when they finish. With a set-up Passport, if the
     profile has not hydrated within the grace period, tell the opener so; the
     timer is cancelled the moment the fields arrive. */
  useEffect(() => {
    if (!pending || !sessionActive || !passportSetUp || profileReady || outcome) return;
    const timer = window.setTimeout(() => {
      if (!replyOnce(pending, { approved: false, error: 'profile_unavailable' })) return;
      setOutcome('unavailable');
    }, PROFILE_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [pending, sessionActive, passportSetUp, profileReady, outcome]);

  /* THE FAST FAIL. A launch arrived, and nothing in this window can answer it.
     Three minutes of a sign-in page is not an answer, and it is what a reader
     used to get. */
  if (channel === 'none') {
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
              <h2 id="profile-consent-title">This window cannot answer.</h2>
            </div>
          </header>
          <div className="profile-consent-outcome unavailable">
            <X size={22} />
            <p>{CONSENT_NO_CHANNEL_MESSAGE}</p>
          </div>
        </section>
      </div>
    );
  }
  if (!launch || channel !== 'opener' || !pending) return null;
  /* SIGNED IN, BUT NOT SET UP YET (2026/09/08). The user is on the Welcome
     screen or the name step, and a modal backdrop over it is what stopped them
     finishing. Say so beside the task, block nothing, and let the sheet arm by
     itself the moment the Passport becomes one. */
  if (!passportSetUp && !outcome) {
    return (
      <ConsentNotice icon={<ShieldCheck size={16} aria-hidden />}>
        {PASSPORT_SETUP_WAITING_MESSAGE}
      </ConsentNotice>
    );
  }
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
                  {/* Said here for the same reason the row above says it, and
                      the redirect sheet has said it all along: a Passport with
                      no `.night` name has no display name, and the user should
                      read that on the sheet rather than discover it in what the
                      app did or did not receive. */}
                  {field === 'displayName' && !displayName && (
                    <small>Not set — will not be shared</small>
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
