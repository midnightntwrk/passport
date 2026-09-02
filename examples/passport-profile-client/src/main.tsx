import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowUpRight,
  Check,
  Copy,
  Fingerprint,
  LoaderCircle,
  LockKeyhole,
  ShieldCheck,
} from 'lucide-react';
import {
  PASSPORT_PROFILE_PROTOCOL,
  parsePassportProfileReady,
  parsePassportProfileResponse,
  type PassportProfileField,
  type PassportProfileResponse,
} from 'passport-demo-backend';

import './styles.css';

type ConnectionState = 'idle' | 'opening' | 'waiting' | 'approved' | 'denied' | 'error';

const PASSPORT_ORIGIN =
  import.meta.env.VITE_PASSPORT_ORIGIN?.replace(/\/+$/, '') ?? 'http://localhost:5175';

// Atlas can run two ways: standalone (it opens Passport as a popup and mints
// the request id and nonce itself), or embedded inside Passport's in-app
// browser (Passport is the parent frame, mints the id and nonce, and posts a
// ready message down; Atlas must echo those exact values in its request).
const EMBEDDED = window.parent !== window;

const FIELD_OPTIONS: Array<{
  field: PassportProfileField;
  label: string;
  detail: string;
}> = [
  {
    field: 'displayName',
    label: 'Display name',
    detail: 'The public name attached to this Passport session.',
  },
  {
    field: 'passportContract',
    label: 'Passport account',
    detail: 'The account a Passport is, and the network it lives on.',
  },
];

function randomHex(bytes = 24): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function short(value: string): string {
  if (value.length <= 28) return value;
  return `${value.slice(0, 14)}...${value.slice(-10)}`;
}

function App() {
  const [selected, setSelected] = useState<PassportProfileField[]>([
    'displayName',
    'passportContract',
  ]);
  const [state, setState] = useState<ConnectionState>('idle');
  const [detail, setDetail] = useState('Passport has not been contacted.');
  const [response, setResponse] = useState<PassportProfileResponse | null>(null);
  const popup = useRef<Window | null>(null);
  const request = useRef<{ requestId: string; nonce: string } | null>(null);
  // Embedded mode: the handshake Passport issued from the parent frame.
  const parentHandshake = useRef<{ requestId: string; nonce: string } | null>(null);

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  useEffect(() => {
    if (!EMBEDDED) return;
    const onParentMessage = (event: MessageEvent) => {
      if (event.origin !== PASSPORT_ORIGIN || event.source !== window.parent) return;

      const ready = parsePassportProfileReady(event.data);
      if (ready) {
        parentHandshake.current = { requestId: ready.requestId, nonce: ready.nonce };
        setState('idle');
        setDetail('Passport is present. Choose fields and connect.');
        // Acknowledge so Passport stops re-broadcasting ready and clears its
        // slow-frame hint; unknown types are dropped silently by its parsers.
        window.parent.postMessage(
          { protocol: PASSPORT_PROFILE_PROTOCOL, type: 'passport.profile.hello' },
          PASSPORT_ORIGIN,
        );
        return;
      }

      const active = parentHandshake.current;
      const profileResponse = parsePassportProfileResponse(event.data);
      if (
        !active ||
        !profileResponse ||
        profileResponse.requestId !== active.requestId ||
        profileResponse.nonce !== active.nonce
      ) {
        return;
      }
      setResponse(profileResponse);
      if (profileResponse.approved) {
        setState('approved');
        setDetail('Passport returned the fields you approved.');
      } else {
        setState('denied');
        setDetail('The Passport request was declined. No data was returned.');
      }
    };
    window.addEventListener('message', onParentMessage);
    return () => window.removeEventListener('message', onParentMessage);
  }, []);

  useEffect(() => {
    if (EMBEDDED) return;
    const onMessage = (event: MessageEvent) => {
      const active = request.current;
      if (!active || event.origin !== PASSPORT_ORIGIN || event.source !== popup.current) return;

      const ready = parsePassportProfileReady(event.data);
      if (
        ready &&
        ready.requestId === active.requestId &&
        ready.nonce === active.nonce
      ) {
        setState('waiting');
        setDetail('Passport is waiting for your approval.');
        popup.current?.postMessage(
          {
            protocol: PASSPORT_PROFILE_PROTOCOL,
            type: 'passport.profile.request',
            requestId: active.requestId,
            nonce: active.nonce,
            fields: selected,
          },
          PASSPORT_ORIGIN,
        );
        return;
      }

      const profileResponse = parsePassportProfileResponse(event.data);
      if (
        !profileResponse ||
        profileResponse.requestId !== active.requestId ||
        profileResponse.nonce !== active.nonce
      ) {
        return;
      }
      setResponse(profileResponse);
      if (profileResponse.approved) {
        setState('approved');
        setDetail('Passport returned the fields you approved.');
      } else {
        setState('denied');
        setDetail('The Passport request was declined. No data was returned.');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [selected]);

  const toggle = (field: PassportProfileField) => {
    if (state === 'opening' || state === 'waiting') return;
    setSelected((current) =>
      current.includes(field)
        ? current.filter((value) => value !== field)
        : [...current, field],
    );
  };

  const connect = () => {
    if (selected.length === 0) return;

    if (EMBEDDED) {
      const issued = parentHandshake.current;
      if (!issued) {
        setState('error');
        setDetail('Passport has not completed the handshake yet. Try again in a moment.');
        return;
      }
      setResponse(null);
      setState('waiting');
      setDetail('Passport is waiting for your approval.');
      window.parent.postMessage(
        {
          protocol: PASSPORT_PROFILE_PROTOCOL,
          type: 'passport.profile.request',
          requestId: issued.requestId,
          nonce: issued.nonce,
          fields: selected,
        },
        PASSPORT_ORIGIN,
      );
      return;
    }

    const requestId = crypto.randomUUID();
    const nonce = randomHex();
    request.current = { requestId, nonce };
    setResponse(null);
    setState('opening');
    setDetail('Opening Midnight Passport...');
    const query = new URLSearchParams({
      passportRequestId: requestId,
      passportNonce: nonce,
    });
    popup.current = window.open(
      `${PASSPORT_ORIGIN}/?${query.toString()}`,
      'midnight-passport-profile',
      'popup,width=620,height=780',
    );
    if (!popup.current) {
      setState('error');
      setDetail('The browser blocked the Passport window. Allow popups and try again.');
    }
  };

  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value);
    setDetail('Address copied.');
  };

  return (
    <main className="client-shell">
      <header className="client-bar">
        <div className="client-brand">
          <span className="client-mark">A</span>
          <strong>ATLAS</strong>
        </div>
        <span className={`connection-indicator ${state}`}>
          <i />
          {state === 'approved' ? 'Passport connected' : EMBEDDED ? 'Inside Passport' : 'External dApp'}
        </span>
      </header>

      <section className="client-main">
        <div className="client-intro">
          <p>Identity request</p>
          <h1>Bring your Passport.</h1>
          <span>
            Atlas runs on a separate web origin. It cannot read Passport storage and receives
            nothing until you approve a scoped request.
          </span>
        </div>

        <section className="request-surface" aria-label="Passport profile request">
          <div className="request-heading">
            <div>
              <p>Requested fields</p>
              <h2>Choose what Atlas may read.</h2>
            </div>
            <Fingerprint size={24} />
          </div>

          <div className="field-list">
            {FIELD_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.field}
                className={selectedSet.has(option.field) ? 'selected' : ''}
                onClick={() => toggle(option.field)}
              >
                <span className="field-check">
                  {selectedSet.has(option.field) && <Check size={14} />}
                </span>
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.detail}</small>
                </span>
              </button>
            ))}
          </div>

          <div className="request-boundary">
            <LockKeyhole size={16} />
            <span>Passkeys, encrypted witnesses, recovery data, and wallet secrets are excluded.</span>
          </div>

          <button
            type="button"
            className="connect-button"
            onClick={connect}
            disabled={selected.length === 0 || state === 'opening' || state === 'waiting'}
          >
            {state === 'opening' || state === 'waiting' ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              <ShieldCheck size={17} />
            )}
            {state === 'opening'
              ? 'Opening Passport'
              : state === 'waiting'
                ? 'Waiting for approval'
                : 'Connect Midnight Passport'}
            <ArrowUpRight size={17} />
          </button>
        </section>

        <section className={`result-surface ${state}`}>
          <div className="result-status">
            <i />
            <span>{detail}</span>
          </div>
          {response?.approved && (
            <div className="profile-result">
              {response.profile?.displayName && (
                <div>
                  <small>Display name</small>
                  <strong>{response.profile.displayName}</strong>
                </div>
              )}
              {response.profile?.passportContract && (
                <div>
                  <small>Passport account</small>
                  <strong>{short(response.profile.passportContract.address)}</strong>
                  <code>{response.profile.passportContract.network}</code>
                  <button
                    type="button"
                    onClick={() => void copy(response.profile!.passportContract!.address)}
                    aria-label="Copy the Passport account address"
                  >
                    <Copy size={14} />
                  </button>
                </div>
              )}
            </div>
          )}
        </section>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
