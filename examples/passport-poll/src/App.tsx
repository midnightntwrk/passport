import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { PassportProfileResult, PassportTrafficEvent } from '@midnight-passport/connect';
import { usePassport, usePassportProfile } from '@midnight-passport/connect/react';

import { listPolls, newPoll, readPoll, vote } from './api.js';
import { PASSPORT_ORIGIN, REFRESH_MS } from './config.js';
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

  const [voter, setVoter] = useState<Voter | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [polls, setPolls] = useState<PollResults[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
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
    const outcome = await vote(current.poll.id, {
      option,
      account: voter.account,
      ...(voter.name === undefined ? {} : { name: voter.name }),
      proof: { exchange: voter.exchange },
    });
    setBusy(false);
    if (!outcome.ok) {
      setNotice(outcome.message);
      return;
    }
    setNotice(`Counted. You voted for ${option}.`);
    await refresh();
    void readPoll(current.poll.id);
  };

  const alreadyVoted =
    voter !== null && current !== null && current.receipts.some((r) => r.account === voter.account);

  return (
    <main className="poll">
      <ThemeToggle />
      <header>
        <p className="eyebrow">Passport-signed voting on stagenet</p>
        <h1>Passport Poll</h1>
        <p className="lede">
          Ask a question, answer it with your Passport. Every vote is counted against the account
          that cast it, so one person is one vote — and you can check the workings yourself.
        </p>
      </header>

      <section className="card identity">
        <div className="who">
          <h2>{voter ? (voter.name ?? shorten(voter.account)) : 'Not signed in'}</h2>
          <p className="detail">
            {voter
              ? shorten(voter.account)
              : presence === null
                ? 'Looking for a Passport…'
                : presence.present === false
                  ? `No Passport answered at ${PASSPORT_ORIGIN}.`
                  : 'Sign in and your vote gets counted.'}
          </p>
        </div>
        {voter ? (
          <button type="button" onClick={() => setVoter(null)}>
            Sign out
          </button>
        ) : (
          <button type="button" className="primary" onClick={() => void signIn()} disabled={profile.pending}>
            {profile.pending ? 'Waiting for Passport…' : 'Sign in with Passport'}
          </button>
        )}
      </section>

      {notice ? <p className="notice">{notice}</p> : null}

      {current ? (
        <section className="card">
          <h2>{current.poll.question}</h2>
          <p className="detail">
            {current.total === 0
              ? 'No votes yet.'
              : `${current.total} ${current.total === 1 ? 'vote' : 'votes'} so far.`}
          </p>
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
                  <span className="bar" style={{ width: `${option.share}%` }} aria-hidden="true" />
                  <span className="label">{option.option}</span>
                  <span className="count">
                    {option.count} · {option.share}%
                  </span>
                </button>
                {option.voters.length > 0 ? (
                  <p className="voters">{option.voters.join(', ')}</p>
                ) : null}
              </li>
            ))}
          </ul>
          {alreadyVoted ? <p className="detail">You have voted in this poll.</p> : null}

          <button type="button" className="ghost" onClick={() => setVerifying((on) => !on)}>
            {verifying ? 'Hide the workings' : 'Verify'}
          </button>
          {verifying ? (
            <div className="verify">
              <p className="detail">
                Every vote, the account it was counted against, and the reference Passport answered
                the consent under. Nothing here was taken without being handed over.
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
                        {receipt.proof.signature ?? receipt.proof.exchange}
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

      <section className="card">
        <h2>Ask something</h2>
        <label>
          <span>Question</span>
          <input
            value={question}
            maxLength={140}
            onChange={(event) => setQuestion(event.target.value)}
          />
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
        <button type="button" className="primary" onClick={() => void create()} disabled={busy}>
          Create the poll
        </button>
      </section>

      {polls.length > 1 ? (
        <section className="card">
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
          Passport Poll runs on {window.location.origin} and asks a Passport at {PASSPORT_ORIGIN}.
          It never sees your keys and never holds anything of yours.
        </p>
      </footer>
    </main>
  );
}
