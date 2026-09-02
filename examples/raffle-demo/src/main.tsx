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
  PASSPORT_TX_PROTOCOL,
  parsePassportProfileReady,
  parsePassportProfileResponse,
  parsePassportTxResponse,
  type PassportProfileField,
  type PassportProfileResponse,
} from './bridge/index.js';

import RaffleArt from './RaffleArt.js';
import RaffleToast, { pushRaffleToast } from './RaffleToast.js';
import './tokens.css';
import './styles.css';

type FlowState =
  | 'hero'
  | 'opening'
  | 'waiting'
  | 'connected'
  | 'submitting'
  | 'entered'
  | 'denied'
  | 'error';

const PASSPORT_ORIGIN =
  import.meta.env.VITE_PASSPORT_ORIGIN?.replace(/\/+$/, '') ?? 'http://localhost:5175';

const TELEGRAM_URL = import.meta.env.VITE_TELEGRAM_URL;

/**
 * The 1AM explorer, verified live 2026/08/07 with this raffle's own entry
 * transaction (hash 2cc3d4…, block 312237). The route takes the 32-byte
 * ledger transaction hash Passport reports over the bridge — never the
 * 33-byte identifier, which no explorer resolves.
 */
const EXPLORER_URL = 'https://explorer.1am.xyz';

function explorerTxHref(txId: string): string {
  return `${EXPLORER_URL}/tx/${encodeURIComponent(txId)}?network=preview`;
}

// The raffle runs two ways: standalone (it opens Passport as a popup and
// mints the request id and nonce itself), or embedded inside Passport's
// in-app browser (Passport is the parent frame, mints the id and nonce, and
// posts a ready message down; the raffle must echo those exact values in its
// request).
//
// Both modes can now pay. The profile exchange and the entry payment each run
// over whichever channel this build finds itself on, with the same protocol
// messages either way; only who mints the pair, and where the message is
// posted, differ.
const EMBEDDED = window.parent !== window;

/**
 * On-chain mode.
 *
 * Entry costs real NIGHT, paid to an address the operator controls, and the
 * ticket carries the node's own transaction id. With no collection address
 * configured there is nothing to pay to, so the raffle stays profile-only and
 * the footer keeps saying so — it never pretends a transaction happened.
 */
const COLLECTION_ADDRESS = import.meta.env.VITE_RAFFLE_COLLECTION_ADDRESS?.trim() ?? '';
const ENTRY_AMOUNT = (import.meta.env.VITE_RAFFLE_ENTRY_AMOUNT ?? '100000').trim();
const ON_CHAIN = COLLECTION_ADDRESS.length > 0 && /^[0-9]{1,20}$/.test(ENTRY_AMOUNT);

/** Passport signs and submits; the wait covers proving as well as the node. */
const TX_TIMEOUT_MS = 180_000;

/**
 * Standalone only: how often an open Passport popup is checked for having been
 * closed. A user who dismisses the window has answered, even though no message
 * will ever say so — without this the raffle would sit on a spinner forever.
 */
const POPUP_POLL_MS = 500;

/**
 * One name, therefore one Passport window. Both exchanges — the profile
 * connect and the entry payment — target it, so the payment reuses the window
 * the user already signed in to rather than stacking a second one beside it.
 * Passport restores its session across that navigation without a further
 * ceremony; the passkey is asked for at approval, which is where it belongs.
 */
const PASSPORT_WINDOW = 'midnight-passport';

const ENTRY_PURPOSE = 'F1 Grand Prix raffle entry';

/**
 * What the raffle asks Passport for, and it is deliberately not an address.
 *
 * A Passport user's identity IS their account-custody contract: the `.night`
 * name resolves to it, the money the entry payment comes out of lives in it,
 * and the wallet behind it exists to sign, not to be known. So the raffle keys
 * a ticket on `passportContract.address` — one account, one entry, stable
 * across every device that passkey opens. It has no use for a receiving
 * address at all: entries are PAID to the collection address below, not to
 * the entrant.
 */
const REQUEST_FIELDS: PassportProfileField[] = ['displayName', 'passportContract'];

const ENTRY_STORAGE_PREFIX = 'mn-raffle-entry:';

const NIGHT_DECIMALS = 6;

/** Atomic NIGHT → display NIGHT, by string arithmetic. Never a float. */
function formatNight(atomic: string): string {
  const digits = atomic.replace(/^0+(?=\d)/, '').padStart(NIGHT_DECIMALS + 1, '0');
  const whole = digits.slice(0, digits.length - NIGHT_DECIMALS);
  const fraction = digits.slice(digits.length - NIGHT_DECIMALS).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

const ENTRY_PRICE = formatNight(ENTRY_AMOUNT);

function randomHex(bytes = 24): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The account this Passport is, or `null` before Passport has answered. */
function accountOf(profile: PassportProfileResponse | null): string | null {
  return profile?.profile?.passportContract?.address ?? null;
}

function shortAddress(value: string): string {
  if (value.length <= 20) return value;
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

/**
 * The network segment of a Midnight bech32m address — the human-readable part
 * before the `1` separator, minus the `mn_addr_` prefix. `undeployed`,
 * `preview`, and `preprod` are the values seen in practice; `null` means the
 * configured value does not even look like an address.
 */
function addressNetwork(address: string): string | null {
  const match = /^mn_addr_([a-z]+)1/.exec(address);
  return match ? match[1] : null;
}

function shortHash(value: string): string {
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

/** Deterministic ticket number: the last six hex digits of the account
 *  address, so re-entering with the same Passport shows the same ticket. */
function ticketFromAddress(address: string): string {
  const hex = address.toLowerCase().replace(/[^0-9a-f]/g, '');
  return (hex.slice(-6) || '0').padStart(6, '0').toUpperCase();
}

/**
 * A stored entry. `txId` is present only when Passport really submitted the
 * entry payment — in on-chain mode an entry without one is not a ticket, and
 * the raffle will ask for payment again rather than honour it.
 */
interface StoredEntry {
  at: string;
  txId?: string;
}

function loadEntry(address: string): StoredEntry | null {
  try {
    const raw = localStorage.getItem(`${ENTRY_STORAGE_PREFIX}${address}`);
    if (raw === null) return null;
    if (!raw.startsWith('{')) return { at: raw };
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as StoredEntry;
    if (typeof record.at !== 'string') return null;
    return typeof record.txId === 'string' && record.txId
      ? { at: record.at, txId: record.txId }
      : { at: record.at };
  } catch {
    return null;
  }
}

function storeEntry(address: string, txId?: string): void {
  try {
    const record: StoredEntry = { at: new Date().toISOString(), ...(txId ? { txId } : {}) };
    localStorage.setItem(`${ENTRY_STORAGE_PREFIX}${address}`, JSON.stringify(record));
  } catch {
    // Storage may be unavailable — the entry simply will not persist.
  }
}

/** An entry that counts on the mode this raffle is running in. */
function entryIsValid(entry: StoredEntry | null): boolean {
  if (!entry) return false;
  return ON_CHAIN ? Boolean(entry.txId) : true;
}

function App() {
  const [state, setState] = useState<FlowState>('hero');
  const [detail, setDetail] = useState('Passport has not been contacted.');
  const [response, setResponse] = useState<PassportProfileResponse | null>(null);
  const [entry, setEntry] = useState<StoredEntry | null>(null);
  const popup = useRef<Window | null>(null);
  const request = useRef<{ requestId: string; nonce: string } | null>(null);
  // Embedded mode: the handshake Passport issued from the parent frame.
  const parentHandshake = useRef<{ requestId: string; nonce: string } | null>(null);
  /* The transaction exchange is its OWN id and nonce pair, minted here and
     matched on the way back: a payment reply must never be mistaken for the
     answer to a different question. */
  const txExchange = useRef<{ requestId: string; nonce: string } | null>(null);
  const txTimer = useRef<number | null>(null);
  /* Standalone only: the closed-popup poll for the payment exchange. */
  const txPoll = useRef<number | null>(null);
  /* The same two watchers for the PROFILE exchange. A connect that is never
     answered wedges the app just as a payment does — the popup is the only
     thing that could reply, and a closed one never will — so it gets the same
     treatment rather than a spinner with no end. */
  const connectTimer = useRef<number | null>(null);
  const connectPoll = useRef<number | null>(null);
  /* The connected Passport's ACCOUNT contract address — the thing a ticket is
     keyed on. The message listeners are registered once, so anything they need
     about the connected Passport lives in a ref rather than in a render-scoped
     closure that would still be holding the first render's `null`. */
  const connectedAccount = useRef<string | null>(null);

  const settle = (profileResponse: PassportProfileResponse) => {
    // Passport answered, so neither connect watcher has anything left to do.
    clearConnectWatch();
    setResponse(profileResponse);
    connectedAccount.current = accountOf(profileResponse);
    if (!profileResponse.approved) {
      setState('denied');
      setDetail('The Passport request was declined. No data was shared.');
      return;
    }
    const address = accountOf(profileResponse);
    const stored = address ? loadEntry(address) : null;
    setEntry(stored);
    if (entryIsValid(stored)) {
      setState('entered');
      setDetail('Welcome back — your ticket is already in the draw.');
    } else {
      setState('connected');
      setDetail(
        ON_CHAIN
          ? `Passport connected. Entry costs ${ENTRY_PRICE} NIGHT, paid from your Passport account.`
          : 'Passport connected. Your entry is one tap away.',
      );
    }
  };

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

  function clearConnectWatch(): void {
    if (connectTimer.current !== null) {
      window.clearTimeout(connectTimer.current);
      connectTimer.current = null;
    }
    if (connectPoll.current !== null) {
      window.clearInterval(connectPoll.current);
      connectPoll.current = null;
    }
  }

  useEffect(
    () => () => {
      clearTxTimer();
      clearConnectWatch();
    },
    [],
  );

  /**
   * Tells Passport what this entry earned the user. Passport records exactly
   * these two and nothing else — it does not invent incentives on our behalf.
   *
   * Embedded only, and not for want of trying: the incentive report is a
   * fire-and-forget message to the Passport frame hosting this app, and the
   * popup approval surface does not record them. In standalone mode there is
   * no parent to post to — `window.parent` is this very window — so the raffle
   * says nothing rather than posting a report to itself.
   */
  const reportIncentives = (
    address: string,
    txId: string,
    exchange: { requestId: string; nonce: string },
  ) => {
    if (!EMBEDDED) return;
    for (const incentive of [
      { id: `raffle-entry:${txId}`, label: ENTRY_PURPOSE, txId },
      { id: `grab-credit:${address}`, label: 'Grab ride credit' },
    ]) {
      window.parent.postMessage(
        {
          protocol: PASSPORT_TX_PROTOCOL,
          type: 'passport.incentive.report',
          requestId: exchange.requestId,
          nonce: exchange.nonce,
          incentive,
        },
        PASSPORT_ORIGIN,
      );
    }
  };

  useEffect(() => {
    if (!EMBEDDED) return;
    const onParentMessage = (event: MessageEvent) => {
      if (event.origin !== PASSPORT_ORIGIN || event.source !== window.parent) return;

      const ready = parsePassportProfileReady(event.data);
      if (ready) {
        parentHandshake.current = { requestId: ready.requestId, nonce: ready.nonce };
        /* Passport re-broadcasts ready until the frame answers, so this can
           arrive mid-flow. It may reset the opening screen, never a payment
           already in flight or a ticket already issued. */
        setState((current) => (current === 'hero' || current === 'error' ? 'hero' : current));
        setDetail((current) =>
          current === 'Passport has not been contacted.'
            ? 'Passport is present. Connect to claim.'
            : current,
        );
        // Acknowledge so Passport stops re-broadcasting ready and clears its
        // slow-frame hint. Unknown types are silently dropped by its parsers;
        // any message from this frame counts as the app having spoken.
        window.parent.postMessage(
          { protocol: PASSPORT_PROFILE_PROTOCOL, type: 'passport.profile.hello' },
          PASSPORT_ORIGIN,
        );
        return;
      }

      /* The entry payment's reply, bound to the pair minted for it. */
      const exchange = txExchange.current;
      const txResponse = parsePassportTxResponse(event.data);
      if (txResponse) {
        if (
          !exchange ||
          txResponse.requestId !== exchange.requestId ||
          txResponse.nonce !== exchange.nonce
        ) {
          return;
        }
        clearTxTimer();
        txExchange.current = null;
        /* The incentive reports are bound to the pair that paid for them, so
           the exchange is passed on rather than read back from the ref. */
        settleTransaction(
          txResponse.status,
          txResponse.txId,
          txResponse.error,
          txResponse.detail,
          exchange,
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

  /** Turns Passport's answer into a ticket, or into honest copy and no ticket. */
  const settleTransaction = (
    status: 'submitted' | 'declined' | 'failed',
    txId: string | undefined,
    error: string | undefined,
    responseDetail: string | undefined,
    exchange: { requestId: string; nonce: string },
  ) => {
    const address = connectedAccount.current;

    if (status === 'submitted' && txId && address) {
      storeEntry(address, txId);
      setEntry({ at: new Date().toISOString(), txId });
      setState('entered');
      setDetail(`Entry paid. Transaction ${shortHash(txId)} was submitted to the node.`);
      /* The confirmation the user actually reads, with the explorer one tap
         away. Preview is the only network with a public explorer, and it is
         the only network Passport submits on today. */
      pushRaffleToast({
        title: 'You are in the draw',
        body: `Entry paid — ${shortHash(txId)}.`,
        link: { label: 'View on explorer', href: explorerTxHref(txId) },
      });
      reportIncentives(address, txId, exchange);
      return;
    }

    if (status === 'declined') {
      setState('connected');
      setDetail('You declined the entry payment. No ticket was issued.');
      return;
    }

    /* Everything below leaves the user exactly where they were: no ticket, no
       stored entry, and a sentence naming what actually stopped it. */
    setState('connected');
    if (error === 'insufficient-funds') {
      setDetail(
        `Your Passport account does not hold the ${ENTRY_PRICE} NIGHT this entry costs, so nothing was sent. Top the account up and try again.`,
      );
      return;
    }
    if (error === 'wallet-unavailable') {
      setDetail(
        'Passport has no open session or no account to pay from, so the entry payment could not be signed. Sign in to Passport and try again.',
      );
      return;
    }
    if (error === 'network-mismatch') {
      /* The fault here is as likely to be the raffle's own configuration as
         the user's Passport, so name both sides — and log the full configured
         address so an operator can spot a stale env instantly. */
      console.warn(
        `Raffle collection address configured as: ${COLLECTION_ADDRESS || '(empty)'} — check VITE_RAFFLE_COLLECTION_ADDRESS.`,
      );
      const collectionNetwork = addressNetwork(COLLECTION_ADDRESS);
      setDetail(
        `This raffle's collection address is on ${collectionNetwork ?? 'an unrecognised network'}; your Passport is on a different network — check the raffle's VITE_RAFFLE_COLLECTION_ADDRESS configuration. ${responseDetail ?? ''}`.trim(),
      );
      return;
    }
    if (error === 'invalid-request') {
      setDetail(
        `Passport refused the entry request. ${responseDetail ?? 'It was already showing an approval sheet, or the collection address is not a valid unshielded address.'}`,
      );
      return;
    }
    setDetail(
      `The entry payment did not go through, so no ticket was issued. ${responseDetail ?? 'Passport reported no further detail.'}`,
    );
  };

  /**
   * Posts the entry-payment intent to the Passport popup. Split out because
   * standalone mode sends it on `ready` rather than immediately: the window
   * has to say it is listening first, exactly as for the profile exchange.
   */
  const postTxRequest = (
    target: Window,
    exchange: { requestId: string; nonce: string },
  ) => {
    target.postMessage(
      {
        protocol: PASSPORT_TX_PROTOCOL,
        type: 'passport.tx.request',
        requestId: exchange.requestId,
        nonce: exchange.nonce,
        intent: {
          kind: 'unshielded-transfer',
          recipientAddress: COLLECTION_ADDRESS,
          amount: ENTRY_AMOUNT,
          purpose: ENTRY_PURPOSE,
        },
      },
      PASSPORT_ORIGIN,
    );
  };

  useEffect(() => {
    if (EMBEDDED) return;
    const onMessage = (event: MessageEvent) => {
      /* Two gates before anything is parsed: the pinned origin, and the window
         this app opened itself. */
      if (event.origin !== PASSPORT_ORIGIN || event.source !== popup.current) return;

      /* The payment exchange is checked first and matched on its OWN pair. The
         popup announces itself with the same `ready` message either way, so
         the pair is the only thing that says which question it is answering. */
      const txActive = txExchange.current;
      if (txActive) {
        const txReady = parsePassportProfileReady(event.data);
        if (
          txReady &&
          txReady.requestId === txActive.requestId &&
          txReady.nonce === txActive.nonce
        ) {
          const target = popup.current;
          if (target) {
            postTxRequest(target, txActive);
            setDetail(
              `Passport is asking you to approve the ${ENTRY_PRICE} NIGHT entry payment.`,
            );
          }
          return;
        }
        const popupTxResponse = parsePassportTxResponse(event.data);
        if (popupTxResponse) {
          if (
            popupTxResponse.requestId !== txActive.requestId ||
            popupTxResponse.nonce !== txActive.nonce
          ) {
            return;
          }
          clearTxTimer();
          txExchange.current = null;
          settleTransaction(
            popupTxResponse.status,
            popupTxResponse.txId,
            popupTxResponse.error,
            popupTxResponse.detail,
            txActive,
          );
          return;
        }
      }

      const active = request.current;
      if (!active) return;

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
    clearConnectWatch();
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
      PASSPORT_WINDOW,
      'popup,width=620,height=780',
    );
    if (!popup.current) {
      /* No window, no handshake, nothing to wait for — so the exchange is
         dropped here rather than left live for a reply that cannot come. */
      request.current = null;
      setState('error');
      setDetail('The browser blocked the Passport window. Allow popups and try again.');
      return;
    }
    popup.current.focus();
    armConnectWatch({ requestId, nonce });
  };

  const enterRaffle = () => {
    const address = accountOf(response);
    if (!address) {
      setState('error');
      setDetail(
        'Passport did not share an account, so a ticket cannot be issued. A Passport has one once its account contract is deployed.',
      );
      return;
    }

    /* Profile-only mode: no collection address is configured, so there is
       nothing to pay and nothing on-chain is claimed. */
    if (!ON_CHAIN) {
      storeEntry(address);
      setEntry({ at: new Date().toISOString() });
      setState('entered');
      setDetail('You are in the draw. Good luck.');
      return;
    }

    const requestId = crypto.randomUUID();
    const nonce = randomHex();
    /* A fresh pair per payment, never the profile handshake's: a payment reply
       must not be mistakable for the answer to a different question. */
    const exchange = { requestId, nonce };

    if (EMBEDDED) {
      txExchange.current = exchange;
      setState('submitting');
      setDetail(`Passport is asking you to approve the ${ENTRY_PRICE} NIGHT entry payment.`);
      postTxRequest(window.parent, exchange);
      armTxWatch(exchange);
      return;
    }

    /* Standalone. The same request over the popup channel: the pair goes on
       Passport's launch URL, Passport echoes it back to say it is listening,
       and the intent follows. Reusing PASSPORT_WINDOW navigates the window the
       user already connected with rather than opening a second Passport. */
    clearTxTimer();
    txExchange.current = exchange;
    setState('submitting');
    setDetail('Opening Midnight Passport to approve the entry payment…');
    const query = new URLSearchParams({
      passportTxRequestId: requestId,
      passportTxNonce: nonce,
    });
    popup.current = window.open(
      `${PASSPORT_ORIGIN}/?${query.toString()}`,
      PASSPORT_WINDOW,
      'popup,width=620,height=780',
    );
    if (!popup.current) {
      /* No window, no approval, no payment — and therefore no ticket. The
         raffle says exactly that rather than issuing one it did not earn. */
      txExchange.current = null;
      setState('connected');
      setDetail(
        'The browser blocked the Passport window, so the entry payment could not be approved. No ticket was issued — allow popups for this site and try again.',
      );
      return;
    }
    popup.current.focus();
    armTxWatch(exchange);
  };

  /**
   * The two watchers on a payment in flight: the overall budget, and — in
   * standalone mode — the closed-popup poll. Both settle only the exchange
   * they were armed for, so a stale timer can never kill a later attempt, and
   * neither ever issues a ticket: a payment that did not come back is a
   * payment that did not happen as far as this app can honestly claim.
   */
  const armTxWatch = (exchange: { requestId: string; nonce: string }) => {
    clearTxTimer();
    const abandon = (reason: string) => {
      clearTxTimer();
      if (!txExchange.current || txExchange.current.requestId !== exchange.requestId) return;
      txExchange.current = null;
      setState('connected');
      setDetail(reason);
    };
    if (!EMBEDDED) {
      txPoll.current = window.setInterval(() => {
        if (popup.current?.closed) {
          abandon(
            'The Passport window was closed before the entry payment was approved. No ticket was issued; you can try again.',
          );
        }
      }, POPUP_POLL_MS);
    }
    txTimer.current = window.setTimeout(() => {
      abandon(
        'Passport did not answer the entry payment request. No ticket was issued; you can try again.',
      );
    }, TX_TIMEOUT_MS);
  };

  /**
   * The same two watchers for the standalone PROFILE exchange.
   *
   * The popup is the only thing that can answer a connect, so a user who
   * closes it has answered — with a refusal — and no message will ever say so.
   * Without this the app sits on "Opening Midnight Passport…" for as long as
   * the tab is open, with a dead `request.current` swallowing the retry.
   *
   * Like the payment watchers, both settle only the exchange they were armed
   * for, so a stale timer cannot kill a later attempt, and neither invents a
   * connection: the app returns to the hero screen saying plainly that nothing
   * was shared.
   */
  const armConnectWatch = (exchange: { requestId: string; nonce: string }) => {
    clearConnectWatch();
    const abandon = (reason: string) => {
      clearConnectWatch();
      if (!request.current || request.current.requestId !== exchange.requestId) return;
      request.current = null;
      setResponse(null);
      setState('hero');
      setDetail(reason);
    };
    connectPoll.current = window.setInterval(() => {
      if (popup.current?.closed) {
        abandon('The Passport window was closed before anything was shared. You can try again.');
      }
    }, POPUP_POLL_MS);
    connectTimer.current = window.setTimeout(() => {
      abandon('Passport did not answer the connection request. Nothing was shared; you can try again.');
    }, TX_TIMEOUT_MS);
  };

  const busy = state === 'opening' || state === 'waiting';
  const name = response?.profile?.displayName ?? 'there';
  const address = accountOf(response);
  const ticketTxId = entry?.txId;

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
          {state === 'connected' || state === 'entered' || state === 'submitting'
            ? 'Passport connected'
            : EMBEDDED
              ? 'Inside Passport'
              : 'External dApp'}
        </span>
      </header>

      <main className="raffle-main">
        {(state === 'hero' || busy || state === 'denied' || state === 'error') && (
          <section className="raffle-hero" aria-label="Raffle offer">
            <div className="raffle-art-frame">
              <RaffleArt title="A raffle ticket with its prize stub" />
            </div>
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
                <span className="perk-tag">{ON_CHAIN ? `${ENTRY_PRICE} NIGHT` : '+1'}</span>
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

        {(state === 'connected' || state === 'submitting') && (
          <section className="raffle-hero" aria-label="Enter the raffle">
            <span className="raffle-eyebrow">Passport connected</span>
            <h1>Hey, {name}.</h1>
            <p className="raffle-sub">
              {ON_CHAIN ? (
                /* Kept deliberately clean — the amount and recipient are
                   named on Passport's approval sheet, which is where the
                   informed-consent moment actually lives. */
                <>
                  Your ride credit is reserved. Enter the draw to lock in your
                  ticket — Passport will ask you to approve the entry.
                </>
              ) : (
                <>
                  Your ride credit is reserved. Enter the draw to lock in your ticket — same
                  Passport, same ticket, every time.
                </>
              )}
            </p>

            <button
              type="button"
              className="raffle-cta"
              onClick={enterRaffle}
              disabled={state === 'submitting'}
            >
              {state === 'submitting' ? (
                <LoaderCircle className="spin" size={18} aria-hidden="true" />
              ) : (
                <Ticket size={18} aria-hidden="true" />
              )}
              {state === 'submitting' ? 'Waiting for Passport…' : 'Enter the raffle'}
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
              {ticketTxId ? (
                <a
                  className="ticket-tx"
                  href={explorerTxHref(ticketTxId)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span>Entry transaction</span>
                  <code>{shortHash(ticketTxId)}</code>
                  <ArrowUpRight size={14} aria-hidden="true" />
                </a>
              ) : (
                <p className="ticket-offchain">
                  Profile-only ticket — no entry payment was made.
                </p>
              )}
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

      <RaffleToast />

      <footer className="raffle-footer">
        {ON_CHAIN
          ? `Demo raffle — entries are real ${ENTRY_PRICE} NIGHT preview transactions; prizes are not.`
          : 'Demo raffle — no real prizes, nothing on-chain yet.'}
      </footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
