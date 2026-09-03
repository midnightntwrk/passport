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
      <header className="hero">
        <h1>Swap anytime, anywhere, privately.</h1>
        <p className="lede">Your Passport pays, the desk delivers, and both sides are on chain.</p>
      </header>

      <section className="box" aria-label="Swap">
        <div className="panel sell">
          <div className="panel-head">
            <span>Sell</span>
            {account ? <span className="who">{greeting?.replace('Signed in as ', '').replace(/\.$/, '')}</span> : null}
          </div>
          <div className="panel-row">
            <div className="amount">{quote ? quote.pay : '0'}</div>
            <div className="token pill">
              <img className="coin" src="/midnight-symbol.svg" alt="" />
              NIGHT
            </div>
          </div>
          <div className="panel-foot">Fixed lot · one price for everyone</div>
        </div>

        <div className="flip" aria-hidden="true">
          <span>↓</span>
        </div>

        <div className="panel buy">
          <div className="panel-head">
            <span>Buy</span>
          </div>
          <div className="panel-row">
            <div className="amount">{quote ? quote.receive : '0'}</div>
            <div className="token pill accent">
              <img className="coin" src="/usd.svg" alt="" />
              {quote ? quote.to : 'sUSD'}
            </div>
          </div>
          <div className="panel-foot">
            {quote
              ? `${quote.rate} · holds until ${new Date(quote.expiresAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
              : (quoteError ?? 'Asking the desk for a price…')}
          </div>
        </div>

        {!account ? (
          <button type="button" className="cta" onClick={() => void connect()} disabled={profile.pending}>
            {profile.pending ? 'Waiting for Passport…' : 'Connect Passport'}
          </button>
        ) : (
          <button type="button" className="cta" onClick={() => void swap()} disabled={!quote || busy}>
            {stage === 'paying'
              ? 'Confirm in Passport…'
              : stage === 'settling'
                ? 'Settling on chain…'
                : quoteError
                  ? 'No price yet'
                  : 'Swap'}
          </button>
        )}

        {quoteError ? (
          <button type="button" className="link" onClick={() => void loadQuote()}>
            Ask the desk again
          </button>
        ) : null}
        {problem ? <p className="problem">{problem}</p> : null}
      </section>

      <p className="foot">
        Passport asks before anything is sent. The desk pays out only once your payment is on chain.
        {presence?.present === false ? ' No Passport answered from this page.' : ''}
      </p>
      <p className="powered">
        <span>Powered by</span>
        <img src="/midnight-wordmark.svg" alt="Midnight" />
      </p>

      {settlement ? (
        <section className="receipt" aria-live="polite">
          <div className="receipt-head">
            <span className="tick" aria-hidden="true">✓</span>
            <div>
              <h2>
                Received {settlement.received} {settlement.symbol}
              </h2>
              <p>
                {settlement.repeat
                  ? 'That payment had already been settled, so this is the same swap, not a second one.'
                  : `You paid ${settlement.paid} NIGHT. Both transactions are on chain.`}
              </p>
            </div>
          </div>
          <ul className="hashes">
            <li>
              <span>Your payment</span>
              <a href={explorerTxUrl(settlement.paymentTx)} target="_blank" rel="noreferrer">
                {shortHash(settlement.paymentTx)} ↗
              </a>
            </li>
            <li>
              <span>Desk payout</span>
              <a href={explorerTxUrl(settlement.depositTx)} target="_blank" rel="noreferrer">
                {shortHash(settlement.depositTx)} ↗
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
