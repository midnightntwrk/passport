/* ===========================================================================
 * Midnight Passport — app template
 * ===========================================================================
 *
 * ONE page, THREE acts, and nothing else. Read it top to bottom and you have
 * seen the whole integration:
 *
 *   Act 1  CONNECT   Establish a channel with Passport and pin its origin.
 *   Act 2  PROFILE   Ask for fields; render exactly what came back.
 *   Act 3  PAYMENT   (optional, off by default) Ask Passport to pay. Works
 *                    over either channel — framed, or popup.
 *
 * The things worth internalising, all of which are enforced below:
 *
 *   - Your app never sees a key, a seed, or a signature. It ASKS; Passport
 *     decides, with the user, on its own surface.
 *   - Every message is posted to ONE exact origin, never `'*'`, and every
 *     inbound message from another origin is dropped before it is parsed.
 *   - Every reply is bound to the `requestId` + `nonce` pair of the request it
 *     answers. Anything that does not match a pair you are currently waiting
 *     on is not your answer — drop it.
 *   - Consent is opt-in and partial. The user may approve some requested
 *     fields and not others, so render what actually arrived and say plainly
 *     what did not.
 *
 * Everything under `src/bridge/` is a verbatim copy of Passport's own protocol
 * definitions. Do not edit those; edit this file.
 * ========================================================================= */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowUpRight,
  BadgeCheck,
  Coins,
  Fingerprint,
  Link2,
  LoaderCircle,
  ShieldCheck,
  ShieldX,
} from 'lucide-react';

import {
  PASSPORT_PROFILE_PROTOCOL,
  PASSPORT_TX_PROTOCOL,
  parsePassportProfileReady,
  parsePassportProfileResponse,
  parsePassportTxResponse,
  type PassportProfileField,
  type PassportProfileResponse,
  type PassportTxErrorCode,
  type PassportTxResponse,
} from './bridge/index.js';

import BridgeLog, { recordBridgeMessage } from './BridgeLog.js';
import PassportToast, { pushToast } from './PassportToast.js';
import './tokens.css';
import './styles.css';

/* ---------------------------------------------------------------------------
 * Configuration
 * ------------------------------------------------------------------------ */

/**
 * ORIGIN PINNING — the single most important line in this file.
 *
 * This is the only origin messages are ever sent to, and the only origin
 * messages are ever accepted from. Never post to `'*'`: that hands your
 * request — and, worse, whatever Passport replies with — to whatever document
 * happens to be in that window.
 *
 * The trailing slash is stripped because `event.origin` never has one, and
 * `'https://x.example/' !== 'https://x.example'` would silently drop every
 * inbound message.
 */
const PASSPORT_ORIGIN =
  import.meta.env.VITE_PASSPORT_ORIGIN?.replace(/\/+$/, '') ?? 'http://localhost:5175';

/**
 * MOUNTING MODE.
 *
 * Embedded: Passport framed your app in its in-app browser. Passport is the
 * parent window, and it mints the handshake pair and posts it down to you.
 *
 * Standalone: your app was opened directly. It opens Passport in a popup and
 * mints the handshake pair itself.
 *
 * The same build handles both. Detecting it is one comparison.
 */
const EMBEDDED = window.parent !== window;

/** The fields this app asks for. Ask for the least you can actually use. */
const REQUESTED_FIELDS: PassportProfileField[] = ['displayName', 'midnightAddresses'];

/* --- Act three, the optional payment ------------------------------------ */

/** Armed only by an explicit `VITE_DEMO_PAYMENT=1`. */
const PAYMENT_ENABLED = import.meta.env.VITE_DEMO_PAYMENT === '1';
const PAYMENT_ADDRESS = import.meta.env.VITE_DEMO_PAYMENT_ADDRESS?.trim() ?? '';
const PAYMENT_AMOUNT = (import.meta.env.VITE_DEMO_PAYMENT_AMOUNT ?? '100000').trim();
/** Atomic-unit amounts are base-10 strings. A float would lose precision. */
const AMOUNT_IS_VALID = /^[0-9]{1,20}$/.test(PAYMENT_AMOUNT) && !/^0+$/.test(PAYMENT_AMOUNT);
/**
 * All three conditions. An armed flag with no recipient is not a payment — it
 * is a button that lies. The mounting mode is deliberately NOT one of them:
 * payment works framed and standalone alike, over the channel each mode has.
 */
const PAYMENT_ARMED = PAYMENT_ENABLED && PAYMENT_ADDRESS.length > 0 && AMOUNT_IS_VALID;

const PAYMENT_PURPOSE = 'Template demo payment';

/**
 * Passport proves, signs, and submits before it answers, so the wait is long
 * by web standards. Time out anyway: a promise that never settles is a spinner
 * that never stops.
 */
const TX_TIMEOUT_MS = 180_000;

/**
 * Standalone only: how often the popup is checked for having been closed. A
 * user who dismisses the Passport window has answered, even though no message
 * will ever say so — without this, the Connect button stays disabled forever.
 */
const POPUP_POLL_MS = 500;

/**
 * Standalone only: the name of the Passport window. One name means one
 * window — the payment reuses the Passport the user already connected with
 * instead of stacking a second one beside it. Passport restores its session
 * across that navigation without a further ceremony; the passkey is asked for
 * at approval, which is where it belongs.
 */
const PASSPORT_WINDOW = 'midnight-passport';

/**
 * The explorer link, as a URL template with a `{hash}` placeholder. The
 * default is the 1AM explorer, verified live 2026/08/07 with a real preview
 * transaction. The placeholder takes the 32-byte ledger transaction hash that
 * Passport reports — never a transaction identifier, which no explorer
 * resolves. A link that looks right and goes nowhere is worse than showing
 * the bare hash, so an empty value here renders the hash as plain text
 * instead.
 */
const EXPLORER_TX_URL = (
  import.meta.env.VITE_EXPLORER_TX_URL ?? 'https://explorer.1am.xyz/tx/{hash}?network=preview'
).trim();

function explorerTxHref(txId: string): string | null {
  return EXPLORER_TX_URL.includes('{hash}')
    ? EXPLORER_TX_URL.replace('{hash}', encodeURIComponent(txId))
    : null;
}

/* ---------------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------------ */

/** A nonce is unguessable random, not a counter and not a timestamp. */
function randomNonce(bytes = 24): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function shorten(value: string, head = 10, tail = 8): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

const NIGHT_DECIMALS = 6;

/** Atomic NIGHT → display NIGHT, by string arithmetic. Never a float. */
function formatNight(atomic: string): string {
  const digits = atomic.replace(/^0+(?=\d)/, '').padStart(NIGHT_DECIMALS + 1, '0');
  const whole = digits.slice(0, digits.length - NIGHT_DECIMALS);
  const fraction = digits.slice(digits.length - NIGHT_DECIMALS).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Plain words for each refusal. Never show the user a bare error code. */
const PROFILE_REFUSALS: Record<string, string> = {
  denied: 'You declined the request in Passport. Nothing was shared with this app.',
  profile_unavailable:
    'Passport has no profile to share yet — it has not finished setting one up.',
  invalid_request:
    'Passport rejected the request as malformed. That is this app’s bug, not yours.',
};

const TX_REFUSALS: Record<PassportTxErrorCode, string> = {
  declined: 'You declined the payment on Passport’s approval sheet. Nothing was signed.',
  'insufficient-funds':
    'The Passport wallet cannot cover this payment — it is short of NIGHT, or of the DUST that pays the network fee.',
  'wallet-unavailable': 'No Passport wallet session is open, so nothing could be signed.',
  'invalid-request':
    'Passport refused the request — it was already showing an approval sheet, or the recipient is not a valid unshielded address.',
  'network-mismatch':
    'The recipient address belongs to a different network from the Passport wallet.',
  'submit-failed': 'It was signed, but the node rejected it or could not be reached.',
};

/* ---------------------------------------------------------------------------
 * State
 * ------------------------------------------------------------------------ */

type ConnectPhase =
  /** Nothing has happened yet. */
  | 'idle'
  /** Standalone only: the popup is opening and has not said `ready`. */
  | 'opening'
  /** The request has been sent; Passport is showing its consent sheet. */
  | 'awaiting-consent'
  /** A response arrived with `approved: true`. */
  | 'connected'
  /** A response arrived with `approved: false`. */
  | 'refused'
  /** Something on this side went wrong — popup blocked, no handshake yet. */
  | 'error';

type PaymentPhase = 'idle' | 'awaiting-approval' | 'submitted' | 'refused';

interface Exchange {
  requestId: string;
  nonce: string;
}

function App() {
  const [phase, setPhase] = useState<ConnectPhase>('idle');
  const [note, setNote] = useState('Passport has not been contacted.');
  const [profile, setProfile] = useState<PassportProfileResponse | null>(null);

  const [paymentPhase, setPaymentPhase] = useState<PaymentPhase>('idle');
  const [paymentNote, setPaymentNote] = useState('');
  const [txId, setTxId] = useState<string | null>(null);
  const [sponsored, setSponsored] = useState(false);

  /**
   * EMBEDDED: the pair Passport minted and sent in `passport.profile.ready`.
   * You must echo these EXACT values in your request. Minting your own works
   * (Passport accepts it) but it is not bound to the handshake, so do not.
   */
  const handshake = useRef<Exchange | null>(null);

  /** STANDALONE: the pair this app minted, and the popup it opened. */
  const popup = useRef<Window | null>(null);
  const profileExchange = useRef<Exchange | null>(null);
  /** STANDALONE: the closed-popup poll and the overall exchange timeout. */
  const profilePoll = useRef<number | null>(null);
  const profileTimer = useRef<number | null>(null);

  const clearProfileWatch = () => {
    if (profilePoll.current !== null) {
      window.clearInterval(profilePoll.current);
      profilePoll.current = null;
    }
    if (profileTimer.current !== null) {
      window.clearTimeout(profileTimer.current);
      profileTimer.current = null;
    }
  };
  useEffect(() => clearProfileWatch, []);

  /**
   * The payment is its OWN pair, minted fresh. A payment reply must never be
   * mistakable for the answer to the profile question, or to an earlier
   * payment the user already declined.
   */
  const txExchange = useRef<Exchange | null>(null);
  const txTimer = useRef<number | null>(null);
  /** STANDALONE: the closed-popup poll for a payment in flight. */
  const txPoll = useRef<number | null>(null);

  const clearTxTimer = () => {
    if (txTimer.current !== null) {
      window.clearTimeout(txTimer.current);
      txTimer.current = null;
    }
    if (txPoll.current !== null) {
      window.clearInterval(txPoll.current);
      txPoll.current = null;
    }
  };
  useEffect(() => clearTxTimer, []);

  /** One place that sends, so one place that logs and targets the origin. */
  const send = useCallback((target: Window, message: Record<string, unknown>) => {
    recordBridgeMessage('out', String(message.type ?? 'unknown'), message);
    /* The second argument is the whole point. Never `'*'`. */
    target.postMessage(message, PASSPORT_ORIGIN);
  }, []);

  /**
   * The payment intent, in one place because two channels send it. Embedded it
   * goes to `window.parent` the moment the button is tapped; standalone it
   * goes to the popup, but only once that window has said `ready` — there is
   * no point posting into a document that has not loaded yet.
   */
  const sendTxRequest = useCallback(
    (target: Window, exchange: Exchange) => {
      send(target, {
        protocol: PASSPORT_TX_PROTOCOL,
        type: 'passport.tx.request',
        requestId: exchange.requestId,
        nonce: exchange.nonce,
        intent: {
          kind: 'unshielded-transfer',
          recipientAddress: PAYMENT_ADDRESS,
          /* Atomic units, base-10 string. Not a number: JSON numbers cannot
             carry atomic amounts without precision loss. */
          amount: PAYMENT_AMOUNT,
          purpose: PAYMENT_PURPOSE,
        },
      });
    },
    [send],
  );

  /* -------------------------------------------------------------------------
   * ACT 3 (settling) — turn a payment response into interface state.
   *
   * One function, both channels. A reply that arrived through the parent frame
   * and one that arrived through the popup say exactly the same things and are
   * treated exactly the same way; the channel is a transport detail and must
   * never leak into what the user is told.
   * ---------------------------------------------------------------------- */
  const settleTxResponse = useCallback((txResponse: PassportTxResponse) => {
    clearTxTimer();
    txExchange.current = null;

    if (txResponse.status === 'submitted' && txResponse.txId) {
      setPaymentPhase('submitted');
      setTxId(txResponse.txId);
      /* `sponsored: true` is the ONLY thing that may be rendered as a
         covered fee. Absent means "not stated", which is an ordinary,
         user-paid transaction — not a free one. */
      setSponsored(txResponse.sponsored === true);
      setPaymentNote(
        txResponse.sponsored === true
          ? `Submitted. ${txResponse.feeNote ?? 'The network fee was covered by a sponsor.'}`
          : 'Submitted to the node, and paid for out of the Passport wallet.',
      );
      const href = explorerTxHref(txResponse.txId);
      pushToast({
        title: 'Payment submitted',
        body: `Transaction ${shorten(txResponse.txId, 10, 6)}.`,
        ...(href ? { link: { label: 'View on explorer', href } } : {}),
      });
      return;
    }

    /* declined and failed both land here: no transaction, and copy that
       names what actually stopped it. */
    setPaymentPhase('refused');
    setTxId(null);
    setSponsored(false);
    const reason = txResponse.error ? TX_REFUSALS[txResponse.error] : undefined;
    setPaymentNote(
      [reason ?? 'The payment did not go through.', txResponse.detail].filter(Boolean).join(' '),
    );
    pushToast({
      title: txResponse.status === 'declined' ? 'Payment declined' : 'Payment failed',
      /* `detail` is the wallet's own sentence about what stopped it —
         worth more to the user than any generic mapping, so show it. */
      body: [reason ?? 'No transaction was made.', txResponse.detail].filter(Boolean).join(' '),
      tone: 'error',
    });
  }, []);

  /* -------------------------------------------------------------------------
   * ACT 2 (settling) — turn a profile response into interface state.
   * ---------------------------------------------------------------------- */
  const settleProfile = useCallback((response: PassportProfileResponse) => {
    clearProfileWatch();
    setProfile(response);
    if (!response.approved) {
      setPhase('refused');
      setNote(PROFILE_REFUSALS[response.error ?? 'denied'] ?? 'The request was refused.');
      return;
    }
    setPhase('connected');
    setNote('Passport shared the fields you approved. Nothing else was returned.');
  }, []);

  /* -------------------------------------------------------------------------
   * ACT 1 — EMBEDDED. Passport is the parent frame.
   *
   * Passport posts `passport.profile.ready` down as soon as the frame loads,
   * and RE-BROADCASTS the same pair every 800 ms until the frame says
   * something back. Two consequences you must handle:
   *
   *   1. `ready` can arrive more than once, and can arrive late — mid-flow.
   *      Treat it as idempotent. Never let it reset a payment in flight or a
   *      result already on screen.
   *   2. Answer it. Any message from your frame counts as "the app spoke", and
   *      that is what stops the re-broadcast and clears Passport's "this app
   *      is not responding" hint. A `passport.profile.hello` is enough —
   *      Passport's parsers drop unknown types harmlessly, and the ack costs
   *      nothing.
   * ---------------------------------------------------------------------- */
  useEffect(() => {
    if (!EMBEDDED) return;

    const onMessage = (event: MessageEvent) => {
      /* Gate one: the origin must be exactly Passport's. Gate two: it must be
         the parent window, not some other frame that guessed the origin. */
      if (event.origin !== PASSPORT_ORIGIN || event.source !== window.parent) return;

      /* --- ready ------------------------------------------------------- */
      const ready = parsePassportProfileReady(event.data);
      if (ready) {
        recordBridgeMessage('in', ready.type, ready);
        handshake.current = { requestId: ready.requestId, nonce: ready.nonce };
        setPhase((current) => (current === 'error' ? 'idle' : current));
        setNote((current) =>
          current === 'Passport has not been contacted.'
            ? 'Passport is present and the handshake pair has arrived. Connect when you are ready.'
            : current,
        );
        /* The acknowledgement. See the comment block above. */
        send(window.parent, {
          protocol: PASSPORT_PROFILE_PROTOCOL,
          type: 'passport.profile.hello',
        });
        return;
      }

      /* --- transaction response (act three) ---------------------------- */
      const txResponse = parsePassportTxResponse(event.data);
      if (txResponse) {
        const active = txExchange.current;
        /* Not bound to the pair we are waiting on? Not our answer. */
        if (
          !active ||
          txResponse.requestId !== active.requestId ||
          txResponse.nonce !== active.nonce
        ) {
          return;
        }
        recordBridgeMessage('in', txResponse.type, txResponse);
        settleTxResponse(txResponse);
        return;
      }

      /* --- profile response -------------------------------------------- */
      const response = parsePassportProfileResponse(event.data);
      const active = handshake.current;
      if (
        !response ||
        !active ||
        response.requestId !== active.requestId ||
        response.nonce !== active.nonce
      ) {
        return;
      }
      recordBridgeMessage('in', response.type, response);
      settleProfile(response);
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [send, settleProfile, settleTxResponse]);

  /* -------------------------------------------------------------------------
   * ACT 1 — STANDALONE. Passport is a popup this app opened.
   *
   * Here the app mints the pair and hands it to Passport on the popup URL and
   * Passport echoes it back in `ready`, which is the app's signal that the
   * window is listening. Two launch contracts, one per exchange, and the
   * parameter names are what keep them apart:
   *
   *   profile — `passportRequestId` + `passportNonce`
   *   payment — `passportTxRequestId` + `passportTxNonce`
   *
   * Passport arms exactly one consent surface per window load, from whichever
   * pair of parameters it was given. Both surfaces announce themselves with
   * the same `passport.profile.ready` message, so the PAIR — not the message
   * type — is what tells the app which question is being answered. Match on
   * it, always.
   * ---------------------------------------------------------------------- */
  useEffect(() => {
    if (EMBEDDED) return;

    const onMessage = (event: MessageEvent) => {
      /* Two gates before anything is parsed: the pinned origin, and the window
         we opened ourselves. */
      if (event.origin !== PASSPORT_ORIGIN || event.source !== popup.current) return;

      /* --- the payment exchange, matched on its own pair ---------------- */
      const txActive = txExchange.current;
      if (txActive) {
        const txReady = parsePassportProfileReady(event.data);
        if (
          txReady &&
          txReady.requestId === txActive.requestId &&
          txReady.nonce === txActive.nonce
        ) {
          recordBridgeMessage('in', txReady.type, txReady);
          const target = popup.current;
          if (target) sendTxRequest(target, txActive);
          return;
        }
        const popupTx = parsePassportTxResponse(event.data);
        if (popupTx) {
          if (popupTx.requestId !== txActive.requestId || popupTx.nonce !== txActive.nonce) {
            return;
          }
          recordBridgeMessage('in', popupTx.type, popupTx);
          settleTxResponse(popupTx);
          return;
        }
      }

      const active = profileExchange.current;
      /* The third gate for the profile exchange: it must actually be live. */
      if (!active) return;

      const ready = parsePassportProfileReady(event.data);
      if (ready && ready.requestId === active.requestId && ready.nonce === active.nonce) {
        recordBridgeMessage('in', ready.type, ready);
        setPhase('awaiting-consent');
        setNote('Passport is open and waiting for your approval.');
        const target = popup.current;
        if (target) {
          send(target, {
            protocol: PASSPORT_PROFILE_PROTOCOL,
            type: 'passport.profile.request',
            requestId: active.requestId,
            nonce: active.nonce,
            fields: REQUESTED_FIELDS,
          });
        }
        return;
      }

      const response = parsePassportProfileResponse(event.data);
      if (
        !response ||
        response.requestId !== active.requestId ||
        response.nonce !== active.nonce
      ) {
        return;
      }
      recordBridgeMessage('in', response.type, response);
      settleProfile(response);
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [send, sendTxRequest, settleProfile, settleTxResponse]);

  /* -------------------------------------------------------------------------
   * ACT 2 — ask. One button, two mounting modes.
   * ---------------------------------------------------------------------- */
  const connect = () => {
    setProfile(null);
    setPaymentPhase('idle');
    setPaymentNote('');
    setTxId(null);

    if (EMBEDDED) {
      const issued = handshake.current;
      if (!issued) {
        /* Passport has not sent `ready` yet. It re-broadcasts every 800 ms, so
           this is nearly always a matter of waiting a beat — say that rather
           than inventing a pair of our own. */
        setPhase('error');
        setNote('Passport has not completed the handshake yet. Try again in a moment.');
        return;
      }
      setPhase('awaiting-consent');
      setNote('Passport is showing its consent sheet. Approve the fields you want to share.');
      send(window.parent, {
        protocol: PASSPORT_PROFILE_PROTOCOL,
        type: 'passport.profile.request',
        requestId: issued.requestId,
        nonce: issued.nonce,
        fields: REQUESTED_FIELDS,
      });
      return;
    }

    /* Standalone: mint the pair, then hand it over on the URL. */
    clearProfileWatch();
    const exchange: Exchange = { requestId: crypto.randomUUID(), nonce: randomNonce() };
    profileExchange.current = exchange;
    setPhase('opening');
    setNote('Opening Midnight Passport…');
    const query = new URLSearchParams({
      passportRequestId: exchange.requestId,
      passportNonce: exchange.nonce,
    });
    popup.current = window.open(
      `${PASSPORT_ORIGIN}/?${query.toString()}`,
      PASSPORT_WINDOW,
      'popup,width=620,height=780',
    );
    if (!popup.current) {
      setPhase('error');
      setNote('The browser blocked the Passport window. Allow popups for this site and retry.');
      return;
    }

    /* A closed popup will never answer, and no message says it closed — the
       only way to find out is to ask. Both watchers settle the SAME exchange
       they were armed for, so a stale timer can never kill a later attempt. */
    const abandon = (reason: string) => {
      clearProfileWatch();
      if (profileExchange.current?.requestId !== exchange.requestId) return;
      profileExchange.current = null;
      setPhase('error');
      setNote(reason);
    };
    profilePoll.current = window.setInterval(() => {
      if (popup.current?.closed) {
        abandon(
          'The Passport window was closed before it answered. Nothing was shared — connect again to retry.',
        );
      }
    }, POPUP_POLL_MS);
    /* Same budget as the transaction path: a promise that never settles is a
       Connect button that never re-enables. */
    profileTimer.current = window.setTimeout(() => {
      abandon(
        'Passport did not answer within three minutes. Nothing was shared — close the Passport window and connect again.',
      );
    }, TX_TIMEOUT_MS);
  };

  /* -------------------------------------------------------------------------
   * ACT 3 — the optional payment.
   *
   * Off unless `VITE_DEMO_PAYMENT=1` AND a recipient is configured. Read
   * `PAYMENT_ARMED` above: an armed flag with no recipient is a button that
   * lies, so it stays off.
   *
   * Your app does not build, sign, or submit anything. It posts an INTENT —
   * recipient, amount, purpose — and Passport does the rest on its own
   * surface, returning either the node's transaction identifier or a named
   * refusal. That asymmetry is the security model, not an inconvenience.
   *
   * Both mounting modes reach it. Embedded, the intent goes straight to the
   * parent frame. Standalone, the app opens (or reuses) the Passport window on
   * the payment launch contract — `passportTxRequestId` and `passportTxNonce`
   * — waits for that window to echo the pair back in `ready`, and posts the
   * intent then. Same protocol, same replies, same 180 s budget.
   * ---------------------------------------------------------------------- */
  const requestPayment = () => {
    if (!PAYMENT_ARMED) return;

    /* A fresh pair per payment, never the handshake pair. */
    const exchange: Exchange = { requestId: crypto.randomUUID(), nonce: randomNonce() };
    clearTxTimer();
    txExchange.current = exchange;
    setPaymentPhase('awaiting-approval');
    setTxId(null);
    setSponsored(false);

    if (EMBEDDED) {
      setPaymentNote(
        `Passport is asking you to approve ${formatNight(PAYMENT_AMOUNT)} NIGHT. The amount and recipient are named on its own sheet — that is where consent happens.`,
      );
      sendTxRequest(window.parent, exchange);
      armTxWatch(exchange);
      return;
    }

    setPaymentNote(
      `Opening Midnight Passport to approve ${formatNight(PAYMENT_AMOUNT)} NIGHT. The amount and recipient are named on its own sheet — that is where consent happens.`,
    );
    const query = new URLSearchParams({
      passportTxRequestId: exchange.requestId,
      passportTxNonce: exchange.nonce,
    });
    popup.current = window.open(
      `${PASSPORT_ORIGIN}/?${query.toString()}`,
      PASSPORT_WINDOW,
      'popup,width=620,height=780',
    );
    if (!popup.current) {
      /* No window, no approval sheet, no payment. Say so; do not pretend. */
      txExchange.current = null;
      setPaymentPhase('refused');
      setPaymentNote(
        'The browser blocked the Passport window, so nothing could be approved and nothing was paid. Allow popups for this site and try again.',
      );
      return;
    }
    popup.current.focus();
    armTxWatch(exchange);
  };

  /**
   * The watchers on a payment in flight: the 180 s budget, and — standalone —
   * the closed-popup poll. Both settle only the exchange they were armed for,
   * so a stale watcher can never kill a later attempt.
   */
  const armTxWatch = (exchange: Exchange) => {
    clearTxTimer();
    const abandon = (reason: string) => {
      clearTxTimer();
      if (!txExchange.current || txExchange.current.requestId !== exchange.requestId) return;
      txExchange.current = null;
      setPaymentPhase('refused');
      setPaymentNote(reason);
    };
    if (!EMBEDDED) {
      txPoll.current = window.setInterval(() => {
        if (popup.current?.closed) {
          abandon(
            'The Passport window was closed before the payment was approved. Nothing was signed and nothing was paid — try again when you are ready.',
          );
        }
      }, POPUP_POLL_MS);
    }
    txTimer.current = window.setTimeout(() => {
      abandon(
        'Passport did not answer within three minutes. Nothing was confirmed — check Passport before retrying, in case the transaction did reach the node.',
      );
    }, TX_TIMEOUT_MS);
  };

  /* -------------------------------------------------------------------------
   * Render
   * ---------------------------------------------------------------------- */

  const busy = phase === 'opening' || phase === 'awaiting-consent';
  const approvedProfile = phase === 'connected' ? profile?.profile : undefined;
  const displayName = approvedProfile?.displayName;
  const addresses = approvedProfile?.midnightAddresses;
  const txHref = txId ? explorerTxHref(txId) : null;

  return (
    <div className="pt-shell">
      <header className="pt-bar">
        <div className="pt-brand">
          <span className="pt-mark" aria-hidden="true">
            <Fingerprint size={15} strokeWidth={2.4} />
          </span>
          <strong>Passport app template</strong>
          <span className="beta-badge">Beta</span>
        </div>
        <span className={`pt-chip ${phase === 'connected' ? 'on' : ''}`}>
          <i aria-hidden="true" />
          {EMBEDDED ? 'Inside Passport' : 'Standalone'}
        </span>
      </header>

      <main className="pt-main">
        {/* ---- ACT 1 -------------------------------------------------- */}
        <section className="pt-card" aria-label="Act one: connect">
          <header className="pt-card-head">
            <h2>
              <span className="pt-act">1</span> Connect
            </h2>
            <span className="pt-tag">{EMBEDDED ? 'embedded' : 'popup fallback'}</span>
          </header>
          <p className="pt-muted">
            {EMBEDDED
              ? 'Passport framed this app and minted the handshake pair. The app echoes that exact pair in its request, and acknowledges the ready message so Passport knows the frame is alive.'
              : 'This app was opened directly, so it mints the handshake pair itself and hands it to Passport on the popup URL. Both exchanges run over that window — the profile connect and the payment, each on its own launch parameters and its own pair.'}
          </p>
          <dl className="pt-facts">
            <div>
              <dt>Passport origin</dt>
              <dd>
                <code>{PASSPORT_ORIGIN}</code>
              </dd>
            </div>
            <div>
              <dt>Handshake</dt>
              <dd>
                {EMBEDDED ? (
                  handshake.current ? (
                    <code>{shorten(handshake.current.requestId, 8, 6)}</code>
                  ) : (
                    <span className="pt-pending">waiting for ready…</span>
                  )
                ) : profileExchange.current ? (
                  <code>{shorten(profileExchange.current.requestId, 8, 6)}</code>
                ) : (
                  <span className="pt-pending">not started</span>
                )}
              </dd>
            </div>
          </dl>
          <button type="button" className="pt-cta" onClick={connect} disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" size={17} aria-hidden="true" />
            ) : (
              <ShieldCheck size={17} aria-hidden="true" />
            )}
            {phase === 'opening'
              ? 'Opening Passport…'
              : phase === 'awaiting-consent'
                ? 'Waiting for your approval…'
                : phase === 'connected' || phase === 'refused'
                  ? 'Ask again'
                  : 'Connect Midnight Passport'}
          </button>
          <p className="pt-note" role="status">
            {note}
          </p>
        </section>

        {/* ---- ACT 2 -------------------------------------------------- */}
        <section className="pt-card" aria-label="Act two: profile">
          <header className="pt-card-head">
            <h2>
              <span className="pt-act">2</span> Profile
            </h2>
            <span className="pt-tag">{REQUESTED_FIELDS.join(' · ')}</span>
          </header>

          {phase === 'connected' ? (
            <>
              {/* Only what was actually approved is rendered. Consent is
                  per-field and opt-in, so a requested field can legitimately
                  be missing — say so, do not fill the gap. */}
              <ul className="pt-fields">
                <li className={displayName ? 'shared' : 'withheld'}>
                  <span className="pt-field-name">displayName</span>
                  {displayName ? (
                    <strong>{displayName}</strong>
                  ) : (
                    <em>not shared — you did not approve this field</em>
                  )}
                </li>
                <li className={addresses ? 'shared' : 'withheld'}>
                  <span className="pt-field-name">midnightAddresses.unshielded</span>
                  {addresses?.unshielded ? (
                    <code title={addresses.unshielded}>{shorten(addresses.unshielded)}</code>
                  ) : (
                    <em>not shared — you did not approve this field</em>
                  )}
                </li>
              </ul>
              <p className="pt-muted">
                <BadgeCheck size={13} aria-hidden="true" /> This app holds nothing else. It never
                saw a key, a seed, or a signature — only these values, and only because they were
                approved.
              </p>
            </>
          ) : phase === 'refused' ? (
            <div className="pt-refused">
              <ShieldX size={17} aria-hidden="true" />
              <div>
                <strong>Nothing was shared.</strong>
                <p>{note}</p>
                <p className="pt-muted">
                  A refusal is an ordinary outcome, not an error state. The app carries on with
                  what it can do for an anonymous visitor.
                </p>
              </div>
            </div>
          ) : (
            <p className="pt-muted">
              Nothing has been requested yet. When you connect, Passport shows its own consent
              sheet listing this app’s origin and the fields above, each one unticked by default.
            </p>
          )}
        </section>

        {/* ---- ACT 3 -------------------------------------------------- */}
        <section className="pt-card" aria-label="Act three: payment">
          <header className="pt-card-head">
            <h2>
              <span className="pt-act">3</span> Payment
            </h2>
            <span className={`pt-tag ${PAYMENT_ARMED ? 'live' : ''}`}>
              {PAYMENT_ARMED ? `${formatNight(PAYMENT_AMOUNT)} NIGHT` : 'disabled'}
            </span>
          </header>

          {!PAYMENT_ENABLED ? (
            <p className="pt-muted">
              Off by default. Set <code>VITE_DEMO_PAYMENT=1</code> and{' '}
              <code>VITE_DEMO_PAYMENT_ADDRESS</code> to arm it. The code is in{' '}
              <code>requestPayment()</code> in <code>src/main.tsx</code> — read it even if you
              never turn it on; it is the whole transaction protocol in thirty lines.
            </p>
          ) : !PAYMENT_ARMED ? (
            <p className="pt-muted">
              <code>VITE_DEMO_PAYMENT=1</code> is set, but{' '}
              {PAYMENT_ADDRESS.length === 0
                ? 'no recipient address is configured'
                : 'the amount is not a positive base-10 integer of atomic units'}
              , so the act stays off rather than offering a button that cannot work.
            </p>
          ) : phase !== 'connected' ? (
            <p className="pt-muted">Connect first — the payment act needs an approved profile.</p>
          ) : (
            <>
              <dl className="pt-facts">
                <div>
                  <dt>Recipient</dt>
                  <dd>
                    <code title={PAYMENT_ADDRESS}>{shorten(PAYMENT_ADDRESS)}</code>
                  </dd>
                </div>
                <div>
                  <dt>Amount</dt>
                  <dd>
                    {formatNight(PAYMENT_AMOUNT)} NIGHT{' '}
                    <span className="pt-muted">({PAYMENT_AMOUNT} atomic)</span>
                  </dd>
                </div>
              </dl>
              <p className="pt-muted">
                {EMBEDDED
                  ? 'The intent goes to the Passport frame around this app, which shows its own approval sheet. This app never builds, signs, or submits anything.'
                  : 'The intent goes to the Passport window this app opens on the payment launch parameters, which shows its own approval sheet there. This app never builds, signs, or submits anything.'}
              </p>
              <button
                type="button"
                className="pt-cta"
                onClick={requestPayment}
                disabled={paymentPhase === 'awaiting-approval'}
              >
                {paymentPhase === 'awaiting-approval' ? (
                  <LoaderCircle className="spin" size={17} aria-hidden="true" />
                ) : (
                  <Coins size={17} aria-hidden="true" />
                )}
                {paymentPhase === 'awaiting-approval'
                  ? 'Waiting for Passport…'
                  : paymentPhase === 'submitted'
                    ? 'Pay again'
                    : 'Request payment'}
              </button>

              {paymentPhase === 'submitted' && txId ? (
                <div className="pt-result ok">
                  <p>
                    <strong>submitted</strong>
                    {sponsored ? <span className="pt-tag live">fee covered</span> : null}
                  </p>
                  {txHref ? (
                    <a className="pt-tx" href={txHref} target="_blank" rel="noreferrer">
                      <Link2 size={13} aria-hidden="true" />
                      <code>{shorten(txId, 10, 6)}</code>
                      <ArrowUpRight size={13} aria-hidden="true" />
                    </a>
                  ) : (
                    <code>{txId}</code>
                  )}
                </div>
              ) : null}

              {paymentPhase === 'refused' ? (
                <div className="pt-result bad">
                  <p>
                    <strong>declined or failed</strong>
                  </p>
                </div>
              ) : null}

              {paymentNote ? (
                <p className="pt-note" role="status">
                  {paymentNote}
                </p>
              ) : null}
            </>
          )}
        </section>

        <BridgeLog />
      </main>

      <PassportToast />

      <footer className="pt-footer">
        A template, not a product. Fork it, delete what you do not need, and keep the origin
        pinning.
      </footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
