import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { PassportProfileResult, PassportTrafficEvent } from '@midnight-passport/connect';
import { usePassport, usePassportPayment, usePassportProfile } from '@midnight-passport/connect/react';

import { listPolls, newPoll, readPoll, vote } from './api.js';
import { BALLOT_BOX, PASSPORT_ORIGIN, REFRESH_MS, VOTE_ATOMIC, explorerTxUrl } from './config.js';
import { applyTheme, currentTheme, type Theme } from './theme.js';
import type { PollResults } from '../service/tally.js';

/* ---------------------------------------------------------------------------
 * Who is voting
 *
 * Passport Poll knows exactly two things about a voter, and it was told both:
 * the name they chose to share, and the account that name belongs to. The
 * account is what the tally is keyed on — one vote per account — and the
 * exchange reference is what Passport answered the consent under.
 * ------------------------------------------------------------------------ */

interface Voter {
  readonly account: string;
  readonly name?: string;
  readonly exchange: string;
}

/**
 * The reference Passport answered under, lifted out of the transcript.
 *
 * The consent reply is bound to a request/nonce pair this page minted, and the
 * pair is the only thing in the exchange that ties one particular answer to
 * one particular question. Recording it with the vote is what lets the Verify
 * list say which exchange each vote came out of.
 */
function latestExchange(traffic: readonly PassportTrafficEvent[]): string | null {
  for (let index = traffic.length - 1; index >= 0; index -= 1) {
    const event = traffic[index]!;
    if (event.direction !== 'in') continue;
    if (event.type !== 'passport.profile.response') continue;
    const payload = event.payload as { requestId?: unknown } | null;
    if (payload && typeof payload.requestId === 'string') return payload.requestId;
  }
  return null;
}

function shorten(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 10)}…${value.slice(-6)}`;
}

function describeRefusal(result: Extract<PassportProfileResult, { approved: false }>): string {
  if (result.source === 'passport') {
    switch (result.error) {
      case 'denied':
        return 'You kept your details to yourself. Nothing was shared.';
      case 'version_mismatch':
        return 'This Passport speaks an older revision of the protocol than the poll does.';
      case 'invalid_request':
        return 'Passport could not read what the poll asked for, so it refused to answer.';
      default:
        return 'Passport had nothing to share.';
    }
  }
  return result.message;
}

/* ------------------------------------------------------------------------ */

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
  const { presence, traffic } = usePassport();
  const profile = usePassportProfile(['displayName', 'passportContract']);
  const payment = usePassportPayment();

  const [voter, setVoter] = useState<Voter | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [polls, setPolls] = useState<PollResults[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  const [question, setQuestion] = useState("What's better: McDonald's or Burger King?");
  const [options, setOptions] = useState<string[]>(["McDonald's", 'Burger King', '', '']);

  const trafficRef = useRef(traffic);
  trafficRef.current = traffic;

  /* --- the poll list, refreshed on a timer while the page is open -------- */

  const refresh = useCallback(async () => {
    const outcome = await listPolls();
    if (!outcome.ok) {
      setNotice(outcome.message);
      return;
    }
    setPolls(outcome.value.polls.filter(Boolean));
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const current = useMemo(
    () => polls.find((poll) => poll.poll.id === selected) ?? polls[0] ?? null,
    [polls, selected],
  );

  /* --- sign in ----------------------------------------------------------- */

  const signIn = async () => {
    setNotice(null);
    const result = await profile.request();
    if (!result.approved) {
      setNotice(describeRefusal(result));
      return;
    }
    const account = result.profile.passportContract?.address;
    if (!account) {
      setNotice('Passport shared a name but not the account it belongs to, so there is nothing to key a vote on.');
      return;
    }
    const exchange = latestExchange(trafficRef.current) ?? 'unrecorded';
    setVoter({
      account,
      ...(result.profile.displayName ? { name: result.profile.displayName } : {}),
      exchange,
    });
    setNotice(
      result.profile.displayName
        ? `Signed in as ${result.profile.displayName}.`
        : 'Signed in.',
    );
  };

  /* --- create -------------------------------------------------------------*/

  const create = async () => {
    setBusy(true);
    setNotice(null);
    const chosen = options.map((option) => option.trim()).filter((option) => option.length > 0);
    const outcome = await newPoll(question, chosen);
    setBusy(false);
    if (!outcome.ok) {
      setNotice(outcome.message);
      return;
    }
    setSelected(outcome.value.poll.poll.id);
    await refresh();
  };

  /* --- vote -------------------------------------------------------------- */

  const cast = async (option: string) => {
    if (!current) return;
    if (!voter) {
      setNotice('Sign in with Passport first — a vote is counted against an account.');
      return;
    }
    setBusy(true);
    setNotice(null);
    /* A vote is a real transaction: a few atomic units of NIGHT from the
       voter's account to the ballot box, approved on Passport's own sheet.
       The tally records the transaction and confirms it once the chain has it. */
    const paid = await payment.request({
      recipientAddress: BALLOT_BOX,
      amount: VOTE_ATOMIC,
      purpose: `Vote "${option}" — ${current.poll.question}`,
    });
    if (paid.status !== 'submitted') {
      setBusy(false);
      setNotice(
        paid.status === 'declined'
          ? 'You turned the vote down. Nothing was sent.'
          : 'Passport did not send the vote. Nothing was counted — try again.',
      );
      return;
    }
    const outcome = await vote(current.poll.id, {
      option,
      account: voter.account,
      ...(voter.name === undefined ? {} : { name: voter.name }),
      proof: { exchange: voter.exchange, txHash: paid.txId },
    });
    setBusy(false);
    if (!outcome.ok) {
      setNotice(outcome.message);
      return;
    }
    setNotice(`Counted. Your vote for ${option} is on its way to the chain.`);
    await refresh();
    void readPoll(current.poll.id);
  };

  const alreadyVoted =
    voter !== null && current !== null && current.receipts.some((r) => r.account === voter.account);

  return (
    <main className="poll">
      <nav className="bar">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          Passport Poll
        </div>
        <div className="bar-right">
          {voter ? (
            <button type="button" className="chip" onClick={() => setVoter(null)} title="Sign out">
              <span className="dot" aria-hidden="true" />
              {voter.name ?? shorten(voter.account)}
            </button>
          ) : (
            <button type="button" className="chip primary" onClick={() => void signIn()} disabled={profile.pending}>
              {profile.pending ? 'Waiting…' : 'Sign in'}
            </button>
          )}
          <ThemeToggle />
        </div>
      </nav>

      <header className="hero">
        <p className="eyebrow">One account, one vote</p>
        <h1>{current ? current.poll.question : 'Ask the room.'}</h1>
        <p className="lede">
          {current
            ? current.total === 0
              ? 'No votes yet. Sign in with Passport and cast the first one.'
              : `${current.total} ${current.total === 1 ? 'vote' : 'votes'} so far, each counted against the account that cast it.`
            : 'Every vote is signed with a Passport, so one person is one vote — and anyone can check the workings.'}
        </p>
        {!voter && presence?.present === false ? (
          <p className="detail">No Passport answered at {PASSPORT_ORIGIN}.</p>
        ) : null}
      </header>

      {notice ? <p className="notice">{notice}</p> : null}

      {current ? (
        <section className="ballot" aria-label="Ballot">
          <ul className="options">
            {current.options.map((option) => (
              <li
                key={option.option}
                className={
                  current.total > 0 &&
                  option.count === Math.max(...current.options.map((o) => o.count))
                    ? 'leading'
                    : undefined
                }
              >
                <button
                  type="button"
                  className="option"
                  onClick={() => void cast(option.option)}
                  disabled={busy || alreadyVoted}
                >
                  <span className="bar-fill" style={{ width: `${option.share}%` }} aria-hidden="true" />
                  <span className="label">{option.option}</span>
                  <span className="share">{option.share}%</span>
                  <span className="count">{option.count}</span>
                </button>
                {option.voters.length > 0 ? (
                  <p className="voters">{option.voters.join(' · ')}</p>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="ballot-foot">
            <span className="detail">
              {alreadyVoted ? 'You have voted in this poll.' : voter ? 'Tap an option to vote.' : 'Sign in to vote.'}
            </span>
            <button type="button" className="ghost" onClick={() => setVerifying((on) => !on)}>
              {verifying ? 'Hide the workings' : 'Verify'}
            </button>
          </div>
          {verifying ? (
            <div className="verify">
              <p className="detail">
                Every vote, the account it was counted against, and the transaction that carried it —
                a tick once the chain has it. Nothing here was taken without being handed over.
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Voter</th>
                    <th>Account</th>
                    <th>Choice</th>
                    <th>Proof</th>
                  </tr>
                </thead>
                <tbody>
                  {current.receipts.map((receipt) => (
                    <tr key={receipt.account}>
                      <td>{receipt.name ?? '—'}</td>
                      <td className="mono">{shorten(receipt.account)}</td>
                      <td>{receipt.option}</td>
                      <td className="mono">
                        {receipt.proof.txHash ? (
                          <a href={explorerTxUrl(receipt.proof.txHash)} target="_blank" rel="noreferrer">
                            {receipt.proof.txHash.slice(0, 10)}… {receipt.proof.confirmed ? '✓' : '…'}
                          </a>
                        ) : (
                          receipt.proof.signature ?? receipt.proof.exchange
                        )}
                      </td>
                    </tr>
                  ))}
                  {current.receipts.length === 0 ? (
                    <tr>
                      <td colSpan={4}>Nothing to check yet.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="ask">
        <button type="button" className="ask-toggle" onClick={() => setAsking((on) => !on)}>
          {asking ? 'Close' : current ? '+ Ask something else' : '+ Ask something'}
        </button>
        {asking || !current ? (
          <div className="ask-form">
            <label>
              <span>Question</span>
              <input value={question} maxLength={140} onChange={(event) => setQuestion(event.target.value)} />
            </label>
            <div className="grid">
              {options.map((option, index) => (
                <label key={index}>
                  <span>{index < 2 ? `Option ${index + 1}` : `Option ${index + 1} (optional)`}</span>
                  <input
                    value={option}
                    maxLength={60}
                    onChange={(event) =>
                      setOptions((current) =>
                        current.map((value, at) => (at === index ? event.target.value : value)),
                      )
                    }
                  />
                </label>
              ))}
            </div>
            <button type="button" className="primary wide" onClick={() => void create()} disabled={busy}>
              Create the poll
            </button>
          </div>
        ) : null}
      </section>

      {polls.length > 1 ? (
        <section className="others">
          <h2>Other questions</h2>
          <ul className="list">
            {polls.map((poll) => (
              <li key={poll.poll.id}>
                <button type="button" className="ghost" onClick={() => setSelected(poll.poll.id)}>
                  {poll.poll.question} <span className="count">{poll.total}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <footer>
        <p className="detail">
          Runs on {window.location.origin}; asks a Passport at {PASSPORT_ORIGIN}. It never sees your
          keys and never holds anything of yours.
        </p>
      </footer>
    </main>
  );
}
