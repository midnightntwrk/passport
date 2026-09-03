import { useCallback, useEffect, useState } from 'react';

import type { PassportPaymentResult, PassportTxErrorCode } from '@midnight-passport/connect';
import {
  usePassport,
  usePassportPayment,
  usePassportProfile,
} from '@midnight-passport/connect/react';

import { PASSPORT_ORIGIN, SWAP_DESK, SWAP_DESK_KEY, explorerTxUrl } from './config.js';
import { applyTheme, currentTheme, type Theme } from './theme.js';

/* ---------------------------------------------------------------------------
 * Passport Swap
 *
 * A partner app on its own origin, with one thing to sell. It asks Passport
 * who is here, quotes a fixed lot, asks Passport for the payment, and then
 * asks the desk to settle. It never holds anything of the user's, never sees
 * an approval, and cannot move a coin on its own — every step that spends is a
 * question put to Passport, and answered there.
 *
 * WHICH WAY THE TRADE RUNS. The desk takes NIGHT and pays the stablecoin,
 * because the payment protocol a partner app may use carries exactly one
 * intent: a positive NIGHT transfer to an address the user's Passport approves.
 * That is the leg an app is allowed to ask for; the other leg is the desk's.
 * ------------------------------------------------------------------------ */

interface Quote {
  from: string;
  to: string;
  pay: string;
  payAtomic: string;
  receive: string;
  rate: string;
  depositTo: string;
  expiresAt: string;
}

interface Settlement {
  paymentTx: string;
  depositTx: string;
  received: string;
  symbol: string;
  paid: string;
  repeat?: boolean;
}

const TX_REFUSALS: Record<PassportTxErrorCode, string> = {
  declined: 'You turned the payment down. Nothing was sent.',
  'insufficient-funds': 'There was not enough NIGHT to cover the price. Nothing was sent.',
  'wallet-unavailable': 'Passport could not reach your account just now. Nothing was sent.',
  'invalid-request': 'Passport could not read what this page asked for, so it refused to act on it.',
  'network-mismatch': 'This desk and your Passport are not on the same network. Nothing was sent.',
  'submit-failed': 'The payment could not be completed. Check Passport before trying again.',
  'version-mismatch':
    'This Passport speaks an older revision of the payment protocol than this page does. Update Passport.',
};

function describeRefusal(result: PassportPaymentResult): string {
  if (result.status === 'submitted') return '';
  if (result.source === 'passport') return TX_REFUSALS[result.error];
  switch (result.error) {
    case 'popup-blocked':
      return 'The browser blocked the Passport window. Allow pop-ups for this page and swap again.';
    case 'passport-closed':
      return 'The Passport window closed before it answered. Nothing is known about the outcome — check Passport before swapping again.';
    case 'timed-out':
      return 'Passport did not answer in time. Nothing is known about the outcome — check Passport before swapping again.';
    case 'not-present':
      return 'No Passport answered. Open one, then swap again.';
    default:
      return 'Passport could not complete the request. Nothing was sent.';
  }
}

function shortHash(value: string): string {
  return value.length <= 20 ? value : `${value.slice(0, 10)}…${value.slice(-6)}`;
}

async function askDesk(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${SWAP_DESK}${path}`, {
    ...init,
    headers: {
      ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(SWAP_DESK_KEY ? { 'x-passport-key': SWAP_DESK_KEY } : {}),
      ...init?.headers,
    },
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof body.message === 'string' ? body.message : `The desk answered ${response.status}.`);
  }
  return body;
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
    >
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}

export function App() {
  const { presence } = usePassport();
  /* `passportContract` is the account the desk pays back into. Without it
     there is nothing to settle to, and the app says so rather than guessing. */
  const profile = usePassportProfile(['displayName', 'passportContract']);
  const payment = usePassportPayment();

  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [greeting, setGreeting] = useState<string | null>(null);
  const [stage, setStage] = useState<'idle' | 'paying' | 'settling' | 'done'>('idle');
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const loadQuote = useCallback(async () => {
    setQuoteError(null);
    try {
      setQuote((await askDesk('/swap/quote?from=NIGHT&to=sUSD')) as Quote);
    } catch (cause) {
      setQuote(null);
      setQuoteError(cause instanceof Error ? cause.message : 'The desk is not answering.');
    }
  }, []);

  useEffect(() => {
    void loadQuote();
  }, [loadQuote]);

  const connect = async () => {
    setProblem(null);
    const result = await profile.request();
    if (!result.approved) {
      setGreeting(null);
      setProblem(
        result.source === 'passport'
          ? 'Passport shared nothing, so there is no account to swap into.'
          : result.message,
      );
      return;
    }
    /* The account is the contract Passport holds value in — the desk pays the
       lot into it, so the address is what a settlement needs. */
    const contract = result.profile.passportContract?.address ?? null;
    setAccount(contract);
    setGreeting(
      result.profile.displayName
        ? `Signed in as ${result.profile.displayName}.`
        : 'Signed in with Passport.',
    );
    if (!contract) {
      setProblem('Passport withheld the account, so this swap cannot be settled. Share it and try again.');
    }
  };

  const swap = async () => {
    if (!quote || !account) return;
    setProblem(null);
    setSettlement(null);
    setStage('paying');

    /* Step one, and the only one that spends the user's money: a question put
       to Passport, approved on Passport's own sheet, submitted by Passport. */
    const paid = await payment.request({
      recipientAddress: quote.depositTo,
      amount: quote.payAtomic,
      purpose: `Swap ${quote.pay} NIGHT for ${quote.receive} ${quote.to}`,
    });
    if (paid.status !== 'submitted') {
      setStage('idle');
      setProblem(describeRefusal(paid));
      return;
    }

    /* Step two: the desk is told which payment to look for. It checks the
       chain itself, and one payment can only ever buy one lot. */
    setStage('settling');
    try {
      const settled = (await askDesk('/swap', {
        method: 'POST',
        body: JSON.stringify({ account, txHash: paid.txId, amount: quote.pay }),
      })) as Settlement;
      setSettlement({ ...settled, paymentTx: settled.paymentTx || paid.txId });
      setStage('done');
    } catch (cause) {
      setStage('idle');
      setProblem(
        `Your payment ${shortHash(paid.txId)} was submitted, but the desk has not settled it: ${
          cause instanceof Error ? cause.message : 'the desk is not answering'
        } Nothing else was sent — swapping again with the same payment is safe.`,
      );
    }
  };

  const busy = stage === 'paying' || stage === 'settling';

  return (
    <main className="swap">
      <ThemeToggle />
      <header>
        <p className="eyebrow">A swap desk on its own origin</p>
        <h1>Passport Swap</h1>
        <p className="lede">
          One fixed lot, one fixed price. This page runs on {window.location.origin}, talks to a
          Passport at {PASSPORT_ORIGIN}, and asks for exactly two things: who you are, and the
          payment. It never holds anything of yours.
        </p>
      </header>

      <section className="card">
        <h2>1. Sign in with Passport</h2>
        <p className="detail">
          {presence === null
            ? 'Looking for a Passport…'
            : presence.present === true
              ? 'A Passport answered.'
              : presence.present === 'unknown'
                ? 'This page cannot tell from here — it will find out when it asks.'
                : 'No Passport answered.'}
        </p>
        <button type="button" onClick={() => void connect()} disabled={profile.pending}>
          {profile.pending ? 'Waiting for Passport…' : account ? 'Sign in again' : 'Sign in with Passport'}
        </button>
        {greeting ? <p className="detail good">{greeting}</p> : null}
      </section>

      <section className="card">
        <h2>2. The quote</h2>
        {quote ? (
          <>
            <dl className="quote">
              <div>
                <dt>You pay</dt>
                <dd className="figure">
                  {quote.pay} <span>NIGHT</span>
                </dd>
              </div>
              <div className="arrow" aria-hidden="true">
                →
              </div>
              <div>
                <dt>You receive</dt>
                <dd className="figure">
                  {quote.receive} <span>{quote.to}</span>
                </dd>
              </div>
            </dl>
            <p className="detail">
              {quote.rate}. A fixed demo rate, not a market. The quote holds until{' '}
              {new Date(quote.expiresAt).toLocaleTimeString('en-GB')}.
            </p>
          </>
        ) : (
          <p className="detail bad">{quoteError ?? 'Asking the desk for a price…'}</p>
        )}
        {quoteError ? (
          <button type="button" onClick={() => void loadQuote()}>
            Ask again
          </button>
        ) : null}
      </section>

      <section className="card">
        <h2>3. Swap</h2>
        <p className="detail">
          Passport asks you before anything is sent. The desk pays out only once your payment is on
          chain.
        </p>
        <button
          type="button"
          className="primary"
          onClick={() => void swap()}
          disabled={!quote || !account || busy}
        >
          {stage === 'paying'
            ? 'Waiting for Passport…'
            : stage === 'settling'
              ? 'Settling with the desk…'
              : quote
                ? `Swap ${quote.pay} NIGHT for ${quote.receive} ${quote.to}`
                : 'Swap'}
        </button>
        {!account ? <p className="detail">Sign in first — the desk pays into your Passport.</p> : null}
        {problem ? <p className="detail bad">{problem}</p> : null}
      </section>

      {settlement ? (
        <section className="card receipt">
          <h2>
            Received {settlement.received} {settlement.symbol}
          </h2>
          <p className="detail">
            {settlement.repeat
              ? 'That payment had already been settled, so this is the same swap, not a second one.'
              : `You paid ${settlement.paid} NIGHT. Both transactions are on chain, and anybody can read them.`}
          </p>
          <ul className="hashes">
            <li>
              <span>Your payment</span>
              <a href={explorerTxUrl(settlement.paymentTx)} target="_blank" rel="noreferrer">
                {shortHash(settlement.paymentTx)}
              </a>
            </li>
            <li>
              <span>The desk’s payout</span>
              <a href={explorerTxUrl(settlement.depositTx)} target="_blank" rel="noreferrer">
                {shortHash(settlement.depositTx)}
              </a>
            </li>
          </ul>
          <a className="back" href={PASSPORT_ORIGIN} target="_blank" rel="noreferrer">
            Open Passport to see it arrive →
          </a>
        </section>
      ) : null}
    </main>
  );
}
