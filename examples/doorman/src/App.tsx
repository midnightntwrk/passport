import { useState } from 'react';

import type {
  PassportPaymentResult,
  PassportProfileResult,
  PassportTxErrorCode,
} from '@midnight-passport/connect';
import {
  usePassport,
  usePassportPayment,
  usePassportProfile,
} from '@midnight-passport/connect/react';

import { DOORMAN_ACCOUNT, DOOR_FEE, PASSPORT_ORIGIN } from './config.js';

/* ---------------------------------------------------------------------------
 * Copy
 *
 * Doorman is a door. It knows who is asking and it knows whether they paid.
 * Everything else — how the payment is made, what it is made of, what Passport
 * has to do to make it — is Passport's business, and none of it belongs on
 * this screen.
 * ------------------------------------------------------------------------ */

const TX_REFUSALS: Record<PassportTxErrorCode, string> = {
  declined: 'You turned the payment down. Nothing was sent.',
  'insufficient-funds': 'There was not enough to cover the entry fee. Nothing was sent.',
  'wallet-unavailable': 'Passport could not reach your account just now. Nothing was sent.',
  'invalid-request': 'Passport could not read what Doorman asked for, so it refused to act on it.',
  'network-mismatch': 'Doorman and your Passport are not on the same network. Nothing was sent.',
  'submit-failed': 'The payment could not be completed. Check Passport before trying again.',
  'version-mismatch':
    'This Passport speaks an older revision of the payment protocol than Doorman does. Update Passport, or use an older Doorman.',
};

function describePayment(result: PassportPaymentResult): string {
  if (result.status === 'submitted') {
    return `You are through the door. Reference ${result.txId}.`;
  }
  if (result.source === 'passport') {
    return TX_REFUSALS[result.error];
  }
  switch (result.error) {
    case 'popup-blocked':
      return 'The browser blocked the Passport window. Allow pop-ups for this page and ask again.';
    case 'passport-closed':
      return 'The Passport window closed before it answered. Nothing is known about the outcome.';
    case 'timed-out':
      return 'Passport did not answer in time. Check Passport before asking again.';
    case 'not-present':
      return 'No Passport answered. Open one, then ask again.';
    case 'invalid-request':
      return 'Doorman built a request Passport would not have been able to read, so it was never sent.';
    case 'unsupported-transport':
      return 'This page cannot carry that request to Passport.';
    default:
      return 'Passport could not complete the request. Nothing was sent.';
  }
}

function describeProfile(result: PassportProfileResult): string {
  if (result.approved) {
    const name = result.profile.displayName;
    return name ? `Welcome, ${name}.` : 'Passport shared what it was willing to share.';
  }
  if (result.source === 'passport') {
    switch (result.error) {
      case 'denied':
        return 'You kept your details to yourself. Doorman will ask again when you are ready.';
      case 'version_mismatch':
        return 'This Passport speaks an older revision of the profile protocol than Doorman does.';
      case 'invalid_request':
        return 'Passport could not read what Doorman asked for, so it refused to answer.';
      default:
        return 'Passport had nothing to share.';
    }
  }
  return result.message;
}

export function App() {
  /* One detection on mount, plus a running transcript of every message. */
  const { presence, traffic } = usePassport();
  const profile = usePassportProfile(['displayName', 'passportContract']);
  const payment = usePassportPayment();
  const [greeting, setGreeting] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const introduce = async () => {
    setGreeting(null);
    setGreeting(describeProfile(await profile.request()));
  };

  const payTheFee = async () => {
    setOutcome(null);
    /*
     * The request is built by the package, sent to the Passport origin, and
     * answered from Passport's own consent sheet. Doorman never sees an
     * approval and never holds anything of the visitor's.
     */
    setOutcome(
      describePayment(
        await payment.request({
          recipientAddress: DOORMAN_ACCOUNT,
          amount: DOOR_FEE,
          purpose: 'Doorman entry fee',
        }),
      ),
    );
  };

  const admitted = payment.result?.status === 'submitted';

  return (
    <main className="doorman">
      <header>
        <p className="eyebrow">A door on its own origin</p>
        <h1>Doorman</h1>
        <p className="lede">
          Doorman is not part of Passport. It runs on {window.location.origin}, talks to a Passport
          at {PASSPORT_ORIGIN}, and asks for exactly two things: who you are, and the entry fee.
        </p>
      </header>

      <section className="step">
        <h2>1. Is there a Passport?</h2>
        <p className="detail">
          {presence === null
            ? 'Looking…'
            : presence.present === true
              ? 'A Passport answered.'
              : presence.present === 'unknown'
                ? 'Doorman cannot tell from here — it will find out when it asks.'
                : 'No Passport answered.'}
        </p>
      </section>

      <section className="step">
        <h2>2. Who is at the door?</h2>
        <button type="button" onClick={() => void introduce()} disabled={profile.pending}>
          {profile.pending ? 'Waiting for Passport…' : 'Introduce yourself'}
        </button>
        {greeting ? <p className="detail">{greeting}</p> : null}
      </section>

      <section className="step">
        <h2>3. Pay the entry fee</h2>
        <p className="detail">Entry is {DOOR_FEE}. Passport asks you before anything is sent.</p>
        <button
          type="button"
          className="primary"
          onClick={() => void payTheFee()}
          disabled={payment.pending}
        >
          {payment.pending ? 'Waiting for Passport…' : `Pay ${DOOR_FEE} and go in`}
        </button>
        {outcome ? <p className={admitted ? 'detail good' : 'detail'}>{outcome}</p> : null}
      </section>

      <section className="step">
        <h2>What crossed the boundary</h2>
        {traffic.length === 0 ? (
          <p className="detail">Nothing yet.</p>
        ) : (
          <ol className="traffic">
            {traffic.map((event, index) => (
              <li key={`${event.at}-${index}`}>
                <span className={event.direction}>{event.direction === 'out' ? '→' : '←'}</span>{' '}
                {event.type}
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}
