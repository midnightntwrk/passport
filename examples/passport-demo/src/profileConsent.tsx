import { useEffect, useMemo, useState } from 'react';
import { Check, ExternalLink, ShieldCheck, X } from 'lucide-react';
import {
  createPassportProfileReady,
  createPassportProfileResponse,
  parsePassportProfileRequest,
  type PassportProfileField,
  type PassportProfileRequest,
  type PassportProfileResponse,
} from '@midnight-ntwrk/passport-sdk';

interface ProfileConsentProps {
  displayName: string | null;
  passportContract: {
    address: string;
    network: string;
  } | null;
  midnightAddresses: {
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

const FIELD_LABELS: Record<PassportProfileField, string> = {
  displayName: 'Passport display name',
  passportContract: 'Passport contract address and network',
  midnightAddresses: 'Midnight unshielded, shielded, and DUST addresses',
};

function launchParameters(): { requestId: string; nonce: string } | null {
  const parameters = new URLSearchParams(window.location.search);
  const requestId = parameters.get('passportRequestId');
  const nonce = parameters.get('passportNonce');
  if (!requestId || !nonce || !window.opener) return null;
  return { requestId, nonce };
}

export function PassportProfileConsent({
  displayName,
  passportContract,
  midnightAddresses,
}: ProfileConsentProps) {
  const launch = useMemo(launchParameters, []);
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const [outcome, setOutcome] = useState<'approved' | 'denied' | null>(null);

  useEffect(() => {
    if (!launch || !window.opener) return;
    const opener = window.opener;
    opener.postMessage(createPassportProfileReady(launch.requestId, launch.nonce), '*');

    const onMessage = (event: MessageEvent) => {
      if (event.source !== opener) return;
      const request = parsePassportProfileRequest(event.data);
      if (
        !request ||
        request.requestId !== launch.requestId ||
        request.nonce !== launch.nonce
      ) {
        return;
      }
      setPending({ request, origin: event.origin, source: opener });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [launch]);

  if (!launch || !pending) return null;

  const profileReady = pending.request.fields.every((field) => {
    if (field === 'displayName') return Boolean(displayName);
    if (field === 'midnightAddresses') return Boolean(midnightAddresses);
    return true;
  });
  if (!profileReady) return null;

  const send = (
    response: Omit<
      PassportProfileResponse,
      'protocol' | 'type' | 'requestId' | 'nonce'
    >,
  ) => {
    pending.source.postMessage(
      createPassportProfileResponse(pending.request, response),
      pending.origin,
    );
  };

  const approve = () => {
    const profile: NonNullable<PassportProfileResponse['profile']> = {};
    for (const field of pending.request.fields) {
      if (field === 'displayName' && displayName) profile.displayName = displayName;
      if (field === 'passportContract' && passportContract) {
        profile.passportContract = passportContract;
      }
      if (field === 'midnightAddresses' && midnightAddresses) {
        profile.midnightAddresses = midnightAddresses;
      }
    }
    send({ approved: true, profile });
    setOutcome('approved');
  };

  const deny = () => {
    send({ approved: false, error: 'denied' });
    setOutcome('denied');
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
                Share selected fields
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
