/* ===========================================================================
 * ClubCoin — a mock membership app, and the round-trip test for Passport's
 * URL-callback contract
 * ===========================================================================
 *
 * ONE page, and the whole third-party integration is on it:
 *
 *   1  LEAVE   Mint a state token, remember it somewhere that survives the tab
 *              being discarded, and navigate to Passport.
 *   2  RETURN  Read the fragment, VERIFY it before believing any of it, and
 *              render the member.
 *
 * There is no popup, no window reference, and nothing held in memory across
 * the boundary. That is the point: on a phone the tab that navigates to
 * Passport is frequently discarded before it comes back, so an integration
 * that depends on a live `Window` is an integration that works on a laptop and
 * fails on the device the user actually has.
 *
 * Everything in `./passportCallback.ts` is the receiving half of Passport's
 * own contract, copied. Do not edit that; edit this file.
 *
 * WHAT THIS PAGE PROVES, and what it deliberately shows on screen: the checks.
 * A demo that renders a name and a green tick proves that base64 decoding
 * works. The verification panel lists every check by name with its verdict, so
 * a reviewer can see that the signature was verified against the payload
 * bytes, and that the signing key was bound to the address inside those bytes.
 * A production app keeps the checks and drops the panel.
 * ========================================================================= */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  buildPassportLaunchUrl,
  newPassportState,
  parsePassportCallbackReturn,
  verifyPassportCallbackReply,
  type PassportCallbackCheck,
  type PassportCallbackField,
  type PassportCallbackPayload,
} from './passportCallback.js';
import './styles.css';

/* ---------------------------------------------------------------------------
 * Configuration
 * ------------------------------------------------------------------------ */

/** Where Passport lives. Overridable at runtime — see the footer control. */
const DEFAULT_PASSPORT_ORIGIN =
  import.meta.env.VITE_PASSPORT_ORIGIN?.replace(/\/+$/, '') ?? 'http://localhost:5175';

/** Ask for the least the app can actually use. ClubCoin needs a name to greet
    and an address to pay membership rewards to. */
const REQUESTED_FIELDS: readonly PassportCallbackField[] = ['displayName', 'midnightAddresses'];

/**
 * Whether an unsigned reply is acceptable. `false` is the right default and the
 * only one this app ships: a Dynamic-hosted Passport session with no local
 * wallet cannot sign, and ClubCoin would rather say so than pretend it checked
 * something. Flip it to `1` to see the downgrade path, which is rendered with
 * an explicit warning rather than silently.
 */
const ACCEPT_UNSIGNED = import.meta.env.VITE_ACCEPT_UNSIGNED === '1';

/* ---------------------------------------------------------------------------
 * Persistence
 *
 * `sessionStorage`, not a variable and not `localStorage`. Not a variable
 * because the tab is discarded; not `localStorage` because a state token that
 * outlives the tab is a state token that can be replayed into a later visit.
 * ------------------------------------------------------------------------ */

const STATE_KEY = 'clubcoin.passport.state';
const NONCE_KEY = 'clubcoin.passport.nonces';
const MEMBER_KEY = 'clubcoin.passport.member';

function readStorage(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    /* Private browsing. The flow still works within one page life. */
  }
}

function clearStorage(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    /* As above. */
  }
}

function seenNonces(): string[] {
  const raw = readStorage(NONCE_KEY);
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function rememberNonce(nonce: string): void {
  /* Bounded: the last 50 are plenty for a session, and an unbounded list in
     storage is a slow leak with no upper limit an app controls. */
  const next = [...seenNonces().filter((entry) => entry !== nonce), nonce].slice(-50);
  writeStorage(NONCE_KEY, JSON.stringify(next));
}

/* ---------------------------------------------------------------------------
 * The screen
 * ------------------------------------------------------------------------ */

interface Member {
  payload: PassportCallbackPayload;
  signed: boolean;
  checks: PassportCallbackCheck[];
}

type Status =
  | { kind: 'anonymous' }
  | { kind: 'member'; member: Member }
  | { kind: 'declined'; code: string }
  /** A reply arrived, but this browser no longer holds the token it was sent with. */
  | { kind: 'lost-token' }
  | { kind: 'rejected'; reason: string; checks: PassportCallbackCheck[] };

/**
 * Reads a remembered member, refusing anything that is not shaped like one.
 *
 * `sessionStorage` is not a schema. A record written by an older build, a
 * half-written value, or an entry another script put under the same key would
 * otherwise reach the render as a `Member` and take the page down on the first
 * property access — a stored value must never be able to do that.
 */
function readStoredMember(): Member | null {
  const raw = readStorage(MEMBER_KEY);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<Member>;
    const payload = candidate.payload as PassportCallbackPayload | undefined;
    if (
      !payload ||
      typeof payload !== 'object' ||
      typeof payload.audience !== 'string' ||
      typeof payload.nonce !== 'string' ||
      typeof payload.issuedAt !== 'number' ||
      !payload.profile ||
      typeof payload.profile !== 'object' ||
      !Array.isArray(candidate.checks)
    ) {
      return null;
    }
    return { payload, signed: candidate.signed === true, checks: candidate.checks };
  } catch {
    return null;
  }
}

/**
 * The callback URL this app hands Passport. Origin plus path, with no query and
 * no fragment: the contract refuses a callback that already carries a fragment
 * (the reply IS the fragment), and a query would survive the round trip
 * unread.
 */
function callbackUrl(): string {
  return `${window.location.origin}${window.location.pathname}`;
}

function shorten(value: string): string {
  return value.length <= 26 ? value : `${value.slice(0, 14)}…${value.slice(-8)}`;
}

function ClubCoin() {
  const [passportOrigin, setPassportOrigin] = useState(DEFAULT_PASSPORT_ORIGIN);
  const [status, setStatus] = useState<Status>({ kind: 'anonymous' });
  const [showChecks, setShowChecks] = useState(false);
  /* The fragment is read exactly once. React 18 StrictMode runs effects twice,
     and the second run would find the hash already scrubbed and conclude the
     user arrived with nothing. */
  const consumed = useRef(false);

  useEffect(() => {
    if (consumed.current) return;
    consumed.current = true;

    const arrival = parsePassportCallbackReturn(window.location.hash);

    /* Scrub immediately, whatever it turned out to be. A shared profile in the
       address bar is a shared profile in the history, in a screenshot, and in
       whatever the user pastes into a chat window. `replaceState` also means
       the Back button does not re-deliver it. */
    if (arrival.kind !== 'absent') {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    }

    if (arrival.kind === 'absent') {
      /* No reply, but possibly a member from earlier in this session. */
      const stored = readStoredMember();
      if (stored) setStatus({ kind: 'member', member: stored });
      else clearStorage(MEMBER_KEY);
      return;
    }

    if (arrival.kind === 'malformed') {
      setStatus({ kind: 'rejected', reason: arrival.reason, checks: [] });
      return;
    }

    if (arrival.kind === 'error') {
      /* Unauthenticated by construction, so it is used for nothing except
         stopping the wait. The state is not even compared: there is no
         signature over it, so a match would prove nothing. */
      clearStorage(STATE_KEY);
      setStatus({ kind: 'declined', code: arrival.code });
      return;
    }

    const expectedState = readStorage(STATE_KEY);
    /* NO TOKEN, but a reply. This app always writes one before it navigates,
       so its absence is almost never tampering — it is this browser having
       lost the token: storage partitioned or blocked by the browser's own
       restrictions, a return landing in a different tab, or the session
       storage cleared under the page. Calling that "the reply does not echo
       the state that was sent" accused the user of an attack for a browser
       behaviour they did not choose, so it gets its own message. */
    if (expectedState === null) {
      setStatus({ kind: 'lost-token' });
      return;
    }

    const verdict = verifyPassportCallbackReply(arrival.envelope, {
      expectedAudience: window.location.origin,
      expectedState,
      seenNonce: (nonce) => seenNonces().includes(nonce),
      requireSignature: !ACCEPT_UNSIGNED,
    });

    if (!verdict.ok) {
      /* The token stays put on a refusal. Consuming it before the verdict
         meant a reply that failed for any reason — a clock skew, a stale
         nonce — left the next attempt with nothing to compare against, so the
         retry was refused as tampering too. */
      setStatus({ kind: 'rejected', reason: verdict.reason, checks: verdict.checks });
      return;
    }
    /* Consumed only now, on a verdict that passed. A state token that survives
       a SUCCESSFUL use is a state token that can be replayed. */
    clearStorage(STATE_KEY);
    rememberNonce(verdict.payload.nonce);
    const member: Member = {
      payload: verdict.payload,
      signed: verdict.signed,
      checks: verdict.checks,
    };
    writeStorage(MEMBER_KEY, JSON.stringify(member));
    setStatus({ kind: 'member', member });
  }, []);

  const launch = useCallback(() => {
    const state = newPassportState();
    /* Written BEFORE the navigation. After `location.assign` this document may
       never run another line. */
    writeStorage(STATE_KEY, state);
    let href: string;
    try {
      href = buildPassportLaunchUrl({
        passportOrigin,
        callbackUrl: callbackUrl(),
        fields: REQUESTED_FIELDS,
        state,
      });
    } catch {
      setStatus({ kind: 'rejected', reason: 'the configured Passport origin is not a URL', checks: [] });
      return;
    }
    window.location.assign(href);
  }, [passportOrigin]);

  const signOut = () => {
    clearStorage(MEMBER_KEY);
    setStatus({ kind: 'anonymous' });
  };

  const preview = useMemo(() => {
    try {
      return buildPassportLaunchUrl({
        passportOrigin,
        callbackUrl: callbackUrl(),
        fields: REQUESTED_FIELDS,
        state: '<fresh random token>',
      });
    } catch {
      return null;
    }
  }, [passportOrigin]);

  return (
    <main className="club">
      <header className="club-bar">
        <span className="club-mark" aria-hidden>
          CC
        </span>
        <div>
          <h1>ClubCoin</h1>
          <p>Membership rewards, on Midnight</p>
        </div>
      </header>

      {status.kind === 'member' ? (
        <section className="card">
          <p className="eyebrow">Signed in with Passport</p>
          <h2>{status.member.payload.profile.displayName ?? 'Member'}</h2>
          {status.member.signed ? (
            <p className="verdict ok">
              Verified — signed by the Passport that owns the address below.
            </p>
          ) : (
            <p className="verdict warn">
              Accepted UNSIGNED. This Passport session had no key that could sign, so nothing about
              this profile has been cryptographically checked. Integrity here rests only on the
              connection to Passport, the audience binding, and the state echo.
            </p>
          )}

          <dl className="fields">
            {status.member.payload.profile.midnightAddresses ? (
              <>
                <dt>Unshielded address</dt>
                <dd>
                  <code title={status.member.payload.profile.midnightAddresses.unshielded}>
                    {shorten(status.member.payload.profile.midnightAddresses.unshielded)}
                  </code>
                </dd>
                {status.member.payload.profile.midnightAddresses.shielded && (
                  <>
                    <dt>Shielded address</dt>
                    <dd>
                      <code title={status.member.payload.profile.midnightAddresses.shielded}>
                        {shorten(status.member.payload.profile.midnightAddresses.shielded)}
                      </code>
                    </dd>
                  </>
                )}
                {status.member.payload.profile.midnightAddresses.dust && (
                  <>
                    <dt>DUST address</dt>
                    <dd>
                      <code title={status.member.payload.profile.midnightAddresses.dust}>
                        {shorten(status.member.payload.profile.midnightAddresses.dust)}
                      </code>
                    </dd>
                  </>
                )}
              </>
            ) : null}
            {status.member.payload.profile.passportContract && (
              <>
                <dt>Passport contract</dt>
                <dd>
                  <code title={status.member.payload.profile.passportContract.address}>
                    {shorten(status.member.payload.profile.passportContract.address)}
                  </code>{' '}
                  <span className="muted">
                    on {status.member.payload.profile.passportContract.network}
                  </span>
                </dd>
              </>
            )}
            <dt>Issued for</dt>
            <dd>
              <code>{status.member.payload.audience}</code>
            </dd>
            <dt>Issued at</dt>
            <dd>{new Date(status.member.payload.issuedAt).toISOString()}</dd>
          </dl>

          {/* A field ClubCoin asked for and did not get is stated, not hidden.
              The user may have skipped the name step, and pretending the field
              was never requested would make that look like a bug. */}
          {REQUESTED_FIELDS.filter(
            (field) => !(field in status.member.payload.profile),
          ).map((field) => (
            <p key={field} className="muted small">
              Requested <code>{field}</code>, which this Passport does not hold yet.
            </p>
          ))}

          <ChecksPanel
            checks={status.member.checks}
            open={showChecks}
            onToggle={() => setShowChecks((value) => !value)}
          />
          <div className="actions">
            <button type="button" className="ghost" onClick={signOut}>
              Sign out
            </button>
          </div>
        </section>
      ) : (
        <section className="card">
          <p className="eyebrow">
            {status.kind === 'declined'
              ? 'Not shared'
              : status.kind === 'rejected'
                ? 'Reply refused'
                : status.kind === 'lost-token'
                  ? 'Launch token lost'
                  : 'Members only'}
          </p>
          <h2>
            {status.kind === 'declined'
              ? status.code === 'profile_unavailable'
                ? 'That Passport has nothing to share yet.'
                : 'You chose not to share your Passport.'
              : status.kind === 'rejected'
                ? 'ClubCoin would not accept that reply.'
                : status.kind === 'lost-token'
                  ? 'This browser lost the launch token.'
                  : 'Join with your Midnight Passport.'}
          </h2>
          <p className="lede">
            {status.kind === 'rejected' ? (
              <>
                The reply came back but failed verification: <strong>{status.reason}</strong>. Nothing
                was stored. This is the correct outcome for an altered or replayed fragment.
              </>
            ) : status.kind === 'lost-token' ? (
              <>
                Your Passport replied, but the token this page minted before sending you there is no
                longer in this browser&rsquo;s session storage — most likely storage restrictions, or
                a return that landed in a different tab. Nothing was stored and nothing is wrong with
                the reply itself; it simply cannot be matched to a launch from here. Try again from
                this page.
              </>
            ) : (
              <>
                ClubCoin asks Passport for a display name and your Midnight addresses. Passport shows
                you exactly what is being asked and returns you here — nothing leaves without your
                approval on Passport&rsquo;s own screen.
              </>
            )}
          </p>

          {status.kind === 'rejected' && status.checks.length > 0 && (
            <ChecksPanel
              checks={status.checks}
              open={showChecks}
              onToggle={() => setShowChecks((value) => !value)}
            />
          )}

          <div className="actions">
            <button type="button" className="primary" onClick={launch}>
              Continue with Passport
            </button>
          </div>
        </section>
      )}

      <section className="card config">
        <p className="eyebrow">Demo configuration</p>
        <label htmlFor="passport-origin">Passport origin</label>
        <input
          id="passport-origin"
          type="url"
          value={passportOrigin}
          spellCheck={false}
          onChange={(event) => setPassportOrigin(event.target.value.replace(/\/+$/, ''))}
        />
        <dl className="fields">
          <dt>Returns to</dt>
          <dd>
            <code>{callbackUrl()}</code>
          </dd>
          <dt>Requests</dt>
          <dd>
            <code>{REQUESTED_FIELDS.join(', ')}</code>
          </dd>
          <dt>Unsigned replies</dt>
          <dd>{ACCEPT_UNSIGNED ? 'accepted, with a warning' : 'refused'}</dd>
        </dl>
        {preview ? (
          <>
            <p className="muted small">The launch URL this button navigates to:</p>
            <pre>{preview}</pre>
          </>
        ) : (
          <p className="verdict warn">That Passport origin is not a URL.</p>
        )}
      </section>
    </main>
  );
}

function ChecksPanel({
  checks,
  open,
  onToggle,
}: {
  checks: PassportCallbackCheck[];
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="checks">
      <button type="button" className="link" aria-expanded={open} onClick={onToggle}>
        {open ? 'Hide' : 'Show'} the {checks.length} verification {checks.length === 1 ? 'check' : 'checks'}
      </button>
      {open && (
        <ul>
          {checks.map((check) => (
            <li key={check.label} className={check.ok ? 'ok' : 'bad'}>
              <span aria-hidden>{check.ok ? '✓' : '✗'}</span>
              <span>{check.label}</span>
              {check.detail && <code>{check.detail}</code>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<ClubCoin />);
