import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowUpRight,
  Car,
  Flag,
  LoaderCircle,
  Send,
  ShieldCheck,
  Ticket,
  Trophy,
  Zap,
} from 'lucide-react';
import {
  PASSPORT_PROFILE_PROTOCOL,
  parsePassportProfileReady,
  parsePassportProfileResponse,
  type PassportProfileField,
  type PassportProfileResponse,
} from 'passport-demo-backend';

import '../../passport-demo/src/screens/tokens.css';
import './styles.css';

type FlowState =
  | 'hero'
  | 'opening'
  | 'waiting'
  | 'connected'
  | 'entered'
  | 'denied'
  | 'error';

const PASSPORT_ORIGIN =
  import.meta.env.VITE_PASSPORT_ORIGIN?.replace(/\/+$/, '') ?? 'http://localhost:5175';

const TELEGRAM_URL = import.meta.env.VITE_TELEGRAM_URL;

// The raffle runs two ways: standalone (it opens Passport as a popup and
// mints the request id and nonce itself), or embedded inside Passport's
// in-app browser (Passport is the parent frame, mints the id and nonce, and
// posts a ready message down; the raffle must echo those exact values in its
// request).
const EMBEDDED = window.parent !== window;

const REQUEST_FIELDS: PassportProfileField[] = ['displayName', 'midnightAddresses'];

const ENTRY_STORAGE_PREFIX = 'mn-raffle-entry:';

function randomHex(bytes = 24): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function shortAddress(value: string): string {
  if (value.length <= 20) return value;
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

/** Deterministic ticket number: the last six hex digits of the unshielded
 *  address, so re-entering with the same Passport shows the same ticket. */
function ticketFromAddress(address: string): string {
  const hex = address.toLowerCase().replace(/[^0-9a-f]/g, '');
  return (hex.slice(-6) || '0').padStart(6, '0').toUpperCase();
}

function hasStoredEntry(address: string): boolean {
  try {
    return localStorage.getItem(`${ENTRY_STORAGE_PREFIX}${address}`) !== null;
  } catch {
    return false;
  }
}

function storeEntry(address: string): void {
  try {
    localStorage.setItem(`${ENTRY_STORAGE_PREFIX}${address}`, new Date().toISOString());
  } catch {
    // Storage may be unavailable — the entry simply will not persist.
  }
}

function App() {
  const [state, setState] = useState<FlowState>('hero');
  const [detail, setDetail] = useState('Passport has not been contacted.');
  const [response, setResponse] = useState<PassportProfileResponse | null>(null);
  const popup = useRef<Window | null>(null);
  const request = useRef<{ requestId: string; nonce: string } | null>(null);
  // Embedded mode: the handshake Passport issued from the parent frame.
  const parentHandshake = useRef<{ requestId: string; nonce: string } | null>(null);

  const settle = (profileResponse: PassportProfileResponse) => {
    setResponse(profileResponse);
    if (!profileResponse.approved) {
      setState('denied');
      setDetail('The Passport request was declined. No data was shared.');
      return;
    }
    const address = profileResponse.profile?.midnightAddresses?.unshielded;
    if (address && hasStoredEntry(address)) {
      setState('entered');
      setDetail('Welcome back — your ticket is already in the draw.');
    } else {
      setState('connected');
      setDetail('Passport connected. Your entry is one tap away.');
    }
  };

  useEffect(() => {
    if (!EMBEDDED) return;
    const onParentMessage = (event: MessageEvent) => {
      if (event.origin !== PASSPORT_ORIGIN || event.source !== window.parent) return;

      const ready = parsePassportProfileReady(event.data);
      if (ready) {
        parentHandshake.current = { requestId: ready.requestId, nonce: ready.nonce };
        setState('hero');
        setDetail('Passport is present. Connect to claim.');
        // Acknowledge so Passport stops re-broadcasting ready and clears its
        // slow-frame hint. Unknown types are silently dropped by its parsers;
        // any message from this frame counts as the app having spoken.
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
      settle(profileResponse);
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
      if (ready && ready.requestId === active.requestId && ready.nonce === active.nonce) {
        setState('waiting');
        setDetail('Passport is waiting for your approval.');
        popup.current?.postMessage(
          {
            protocol: PASSPORT_PROFILE_PROTOCOL,
            type: 'passport.profile.request',
            requestId: active.requestId,
            nonce: active.nonce,
            fields: REQUEST_FIELDS,
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
      settle(profileResponse);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const connect = () => {
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
          fields: REQUEST_FIELDS,
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
    setDetail('Opening Midnight Passport…');
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

  const enterRaffle = () => {
    const address = response?.profile?.midnightAddresses?.unshielded;
    if (!address) {
      setState('error');
      setDetail('Passport did not share an address, so a ticket cannot be issued.');
      return;
    }
    storeEntry(address);
    setState('entered');
    setDetail('You are in the draw. Good luck.');
  };

  const busy = state === 'opening' || state === 'waiting';
  const name = response?.profile?.displayName ?? 'there';
  const address = response?.profile?.midnightAddresses?.unshielded;

  return (
    <div className="raffle-shell">
      <header className="raffle-bar">
        <div className="raffle-brand">
          <span className="raffle-mark" aria-hidden="true">
            <Flag size={15} strokeWidth={2.4} />
          </span>
          <strong>Grand Prix Raffle</strong>
        </div>
        <span className={`raffle-status ${state}`}>
          <i aria-hidden="true" />
          {state === 'connected' || state === 'entered'
            ? 'Passport connected'
            : EMBEDDED
              ? 'Inside Passport'
              : 'External dApp'}
        </span>
      </header>

      <main className="raffle-main">
        {(state === 'hero' || busy || state === 'denied' || state === 'error') && (
          <section className="raffle-hero" aria-label="Raffle offer">
            <span className="raffle-eyebrow">Grand Prix weekend</span>
            <h1>
              Free Grab
              <br />
              ride credit
            </h1>
            <p className="raffle-sub">
              Connect your Midnight Passport to claim a Grab ride credit for race weekend, and
              take one entry in the F1 Grand Prix raffle.
            </p>

            <ul className="raffle-perks">
              <li>
                <span className="perk-icon" aria-hidden="true">
                  <Car size={18} />
                </span>
                <span className="perk-label">Grab ride credit</span>
                <span className="perk-tag">Free</span>
              </li>
              <li>
                <span className="perk-icon" aria-hidden="true">
                  <Trophy size={18} />
                </span>
                <span className="perk-label">F1 Grand Prix raffle</span>
                <span className="perk-tag">+1</span>
              </li>
            </ul>

            <button
              type="button"
              className="raffle-cta"
              onClick={connect}
              disabled={busy}
            >
              {busy ? (
                <LoaderCircle className="spin" size={18} aria-hidden="true" />
              ) : (
                <ShieldCheck size={18} aria-hidden="true" />
              )}
              {state === 'opening'
                ? 'Opening Passport…'
                : state === 'waiting'
                  ? 'Waiting for approval…'
                  : 'Connect Midnight Passport'}
            </button>

            <ul className="raffle-assurances">
              <li>
                <ShieldCheck size={15} aria-hidden="true" />
                No seed phrase, ever
              </li>
              <li>
                <Zap size={15} aria-hidden="true" />
                Takes 10 seconds
              </li>
            </ul>

            {(state === 'denied' || state === 'error') && (
              <p className="raffle-notice" role="status">
                {detail}
              </p>
            )}
          </section>
        )}

        {state === 'connected' && (
          <section className="raffle-hero" aria-label="Enter the raffle">
            <span className="raffle-eyebrow">Passport connected</span>
            <h1>Hey, {name}.</h1>
            <p className="raffle-sub">
              Your ride credit is reserved. Enter the draw to lock in your ticket — same
              Passport, same ticket, every time.
            </p>

            {address && (
              <div className="raffle-address">
                <span>Connected address</span>
                <code>{shortAddress(address)}</code>
              </div>
            )}

            <button type="button" className="raffle-cta" onClick={enterRaffle}>
              <Ticket size={18} aria-hidden="true" />
              Enter the raffle
            </button>

            <p className="raffle-detail" role="status">
              {detail}
            </p>
          </section>
        )}

        {state === 'entered' && (
          <section className="raffle-hero" aria-label="Your raffle ticket">
            <span className="raffle-eyebrow">You are in the draw</span>
            <h1>Ticket secured.</h1>

            <div className="raffle-ticket">
              <div className="ticket-head">
                <span className="ticket-label">
                  <Ticket size={15} aria-hidden="true" />
                  Raffle entry
                </span>
                {response?.profile?.displayName && (
                  <span className="ticket-holder">{response.profile.displayName}</span>
                )}
              </div>
              <p className="ticket-number">Nº {address ? ticketFromAddress(address) : '——————'}</p>
              {address && <code className="ticket-address">{shortAddress(address)}</code>}
              <div className="ticket-divider" aria-hidden="true" />
              <ul className="ticket-incentives">
                <li>
                  <span className="perk-icon" aria-hidden="true">
                    <Car size={18} />
                  </span>
                  <span className="perk-label">Grab ride credit</span>
                  <span className="perk-tag">Claimed</span>
                </li>
                <li>
                  <span className="perk-icon" aria-hidden="true">
                    <Trophy size={18} />
                  </span>
                  <span className="perk-label">F1 Grand Prix raffle</span>
                  <span className="perk-tag">+1</span>
                </li>
              </ul>
            </div>

            {TELEGRAM_URL && (
              <a
                className="raffle-telegram"
                href={TELEGRAM_URL}
                target="_blank"
                rel="noreferrer"
              >
                <Send size={16} aria-hidden="true" />
                Message support on Telegram
                <ArrowUpRight size={16} aria-hidden="true" />
              </a>
            )}

            <p className="raffle-detail" role="status">
              {detail}
            </p>
          </section>
        )}
      </main>

      <footer className="raffle-footer">
        Demo raffle — no real prizes, nothing on-chain yet.
      </footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
