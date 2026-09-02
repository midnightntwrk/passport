import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ExternalLink, Loader2, PenLine, Wallet, X } from 'lucide-react';
import {
  createPassportProfileReady,
  createPassportTxResponse,
  pairOfUnreadableMessage,
  readPassportTxRequest,
  type PassportTxRequest,
} from './backend.js';
import {
  capTxDetail,
  evaluateTxRequest,
  explorerTxHref,
  formatNight,
  shortAddress,
  transferErrorFrom,
  txBoundaryCopy,
  accountHoldsCopy,
  type PassportTransferContext,
  type PassportTxResponseBody,
} from './lib/txApproval.js';
import { holdCriticalWork } from './lib/appBusy.js';

/**
 * The popup transaction-approval surface — deliberate sibling of
 * `profileConsent.tsx`.
 *
 * A standalone app (an ordinary tab, not framed by Passport) can already ask
 * for a profile: it mints a request id and nonce, hands them to Passport on
 * the popup URL, and `profileConsent.tsx` answers on the other side. Until now
 * that was the only thing a standalone app could do — paying existed only
 * between Passport and a frame it was hosting. This module closes that gap
 * with the same contract, the same guarantees, and the same vocabulary.
 *
 * What it does NOT do is re-decide anything. The ladder of refusals, the
 * NIGHT formatting, the wallet-error mapping, and the sentences of sheet copy
 * all come from `lib/txApproval.ts`, which the in-app browser
 * (`screens/AppBrowser.tsx`) climbs too. Two channels, one set of rules — an
 * app must never be able to tell which surface refused it, except by the
 * `detail` sentence describing its own situation.
 *
 * Constraints this file is built around:
 *
 *   - The opener is pinned twice over: `event.source` must be `window.opener`,
 *     and every reply goes to the exact origin the request arrived from —
 *     never `'*'`.
 *   - The exchange is bound to the pair on this window's OWN launch URL. A
 *     request carrying any other pair is not this window's business and is
 *     dropped without a reply, which also means exactly one exchange per
 *     launch: there is no second sheet to refuse.
 *   - Approving runs the passkey ceremony. It is not run here — it is run
 *     inside the send seam this component is handed (App.tsx's
 *     `executeAppTransfer` → `confirmLocalApproval` → `lib/passkeyPresence`),
 *     which is the same seam and the same single ceremony the embedded
 *     approval uses. A seam that skips it would break the security model of
 *     both surfaces at once, so it must never be wired to anything else.
 *   - Nothing is ever reported as submitted without the node's own id.
 */

interface TxConsentProps {
  /**
   * Whether a Passport session is open. While it is
   * false the popup is still mid-sign-in — a session restored after the
   * navigation takes as long as it takes — so the unavailability grace timer
   * must not run: answering "wallet-unavailable" then would refuse every
   * standalone popup payment.
   */
  sessionActive: boolean;
  /**
   * Signs and submits a real unshielded NIGHT payment, resolving with the
   * node's transaction id. Wired by the host to a `withdraw_night` on this
   * Passport's account-custody contract — the money is the ACCOUNT's, the
   * wallet only signs — exactly as the in-app browser's is. Left undefined
   * when there is no wallet session OR no deployed account: the approval sheet
   * is then never shown and the app is told `wallet-unavailable` rather than
   * being left waiting.
   */
  executeTransfer?: (intent: {
    recipientAddress: string;
    amount: bigint;
    purpose: string;
    origin: string;
  }) => Promise<{ txId: string }>;
  /** The wallet the approval sheet is describing. Null with no local session. */
  transferContext?: PassportTransferContext | null;
}

interface PendingTxRequest {
  request: PassportTxRequest;
  origin: string;
  source: Window;
}

type TxConsentOutcome =
  | { kind: 'submitted'; txId: string }
  | { kind: 'declined' }
  | { kind: 'failed'; message: string }
  /** Refused by the ladder, before the user was ever shown a sheet. */
  | { kind: 'refused'; message: string };

/**
 * How long a request may wait, ONCE A SESSION IS OPEN, for a wallet able to
 * sign to appear before the opener is told the wallet is unavailable. The same
 * five seconds, and the same reasoning, as `profileConsent.tsx`: the wallet
 * surfaces arrive asynchronously, so answering instantly would refuse payments
 * this Passport could in fact make — but never answering leaves the opener
 * hanging on a window that genuinely cannot sign. Before a session exists the
 * timer never runs: the user may still be mid-passkey-ceremony.
 */
const WALLET_WAIT_MS = 5_000;

/**
 * The popup launch contract, tx side. Deliberately DIFFERENT parameter names
 * from the profile contract's `passportRequestId`/`passportNonce`: one window
 * serves one exchange, and distinct names are what stop a payment popup from
 * also arming the profile consent surface (and the reverse) on the same load.
 */
function launchParameters(): { requestId: string; nonce: string } | null {
  const parameters = new URLSearchParams(window.location.search);
  const requestId = parameters.get('passportTxRequestId');
  const nonce = parameters.get('passportTxNonce');
  if (!requestId || !nonce || !window.opener) return null;
  return { requestId, nonce };
}

export function PassportTxConsent({
  sessionActive,
  executeTransfer,
  transferContext,
}: TxConsentProps) {
  const launch = useMemo(launchParameters, []);
  const [pending, setPending] = useState<PendingTxRequest | null>(null);
  /** Set once the ladder has passed: the one bigint sheet and send agree on. */
  const [amount, setAmount] = useState<bigint | null>(null);
  const [outcome, setOutcome] = useState<TxConsentOutcome | null>(null);
  /** True from the moment "Approve and sign" is tapped until the wallet answers. */
  const [signing, setSigning] = useState(false);
  /** Reveals the full recipient address in the sheet. */
  const [showFullRecipient, setShowFullRecipient] = useState(false);
  /** The grace period has elapsed with no wallet — the ladder may now refuse. */
  const [graceElapsed, setGraceElapsed] = useState(false);

  /* An app is waiting on this window for an answer it can only get once. While
     the wallet is signing, `src/pwa.tsx` must not reload the document out from
     under it for a new deployment — the app would be left with no reply at
     all, and the user with a signature they cannot see the result of. */
  useEffect(() => (signing ? holdCriticalWork() : undefined), [signing]);

  /* Exactly one reply per exchange, whatever React does around it: the ladder
     effect below can be invoked twice on mount under StrictMode, and posting a
     refusal twice would be a second answer to a question already answered. */
  const answered = useRef(false);

  /* The send seam must be the one that is open NOW: the approve handler is
     built once and the wallet may have arrived (or gone) since. */
  const executeTransferRef = useRef(executeTransfer);
  executeTransferRef.current = executeTransfer;

  const walletReady = Boolean(executeTransfer) && Boolean(transferContext);

  /* The launch handshake, mirroring the profile contract exactly: announce
     that this window is listening by echoing back the pair the opener put on
     the URL, then accept only a request carrying that same pair.

     The announcement reuses `passport.profile.ready`. The transaction protocol
     has no ready message of its own and inventing one would be a protocol
     change made unilaterally by a demo — whereas `ready` already means no more
     than "this Passport window is live, and here is your pair back". The pair
     is the transaction exchange's own, freshly minted by the app for this
     payment, so an app matching replies against the pairs it is waiting on can
     never mistake this for the answer to a profile question. */
  useEffect(() => {
    if (!launch || !window.opener) return;
    const opener = window.opener as Window;
    /* `'*'` only here, and only for the pair the opener itself chose: this
       window does not learn the opener's origin until a message arrives from
       it, and the ready message carries nothing the opener did not send. Every
       reply below goes to the exact origin instead. */
    /* The wildcard is deliberate, and it is the only origin this line can
       name. A window opened by an app learns that app's origin only when a
       message arrives from it, and this is the message that invites one.
       What it carries is the request id and nonce the opener itself minted
       and passed in through the launch URL, so it tells the opener nothing
       it did not already know, and every later reply is sent to the origin
       the first message revealed. */
    // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration
    opener.postMessage(createPassportProfileReady(launch.requestId, launch.nonce), '*');

    const onMessage = (event: MessageEvent) => {
      if (event.source !== opener) return;
      const parsed = readPassportTxRequest(event.data);
      if (parsed.kind !== 'ok') {
        /* NOT silence — the same rule as `profileConsent.tsx`. A transaction
           request this build cannot read is answered with the reason, bound to
           this window's own launch pair, so the opener learns what happened
           instead of watching a three-minute spinner. */
        if (parsed.kind === 'not-passport') return;
        const pair = pairOfUnreadableMessage(event.data);
        if (!pair || pair.requestId !== launch.requestId || pair.nonce !== launch.nonce) return;
        if (answered.current) return;
        answered.current = true;
        opener.postMessage(
          createPassportTxResponse(pair, {
            status: 'failed',
            error: parsed.kind === 'version-mismatch' ? 'version-mismatch' : 'invalid-request',
          }),
          event.origin,
        );
        setOutcome({
          kind: 'refused',
          message:
            parsed.kind === 'version-mismatch'
              ? 'The app is speaking a revision of the transaction protocol this Passport does not implement. Nothing was signed.'
              : 'The app sent a request this Passport could not read. Nothing was signed.',
        });
        return;
      }
      const request = parsed.value;
      if (request.requestId !== launch.requestId || request.nonce !== launch.nonce) return;
      /* One exchange per launch. A re-send of the same pair is the same
         request, not a second sheet, so it is ignored rather than refused. */
      setPending((current) =>
        current ? current : { request, origin: event.origin, source: opener },
      );
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [launch]);

  const reply = useCallback(
    (target: PendingTxRequest, body: PassportTxResponseBody) => {
      if (answered.current) return;
      answered.current = true;
      target.source.postMessage(
        createPassportTxResponse(target.request, capTxDetail(body)),
        target.origin,
      );
    },
    [],
  );

  /* The wallet grace timer. Only armed once a session is open and no wallet
     that can sign has appeared: before a session exists the user may still be
     mid-sign-in, and that takes as long as it takes. Cancelled the moment a
     wallet arrives. */
  useEffect(() => {
    if (!pending || !sessionActive || walletReady || outcome || graceElapsed) return;
    const timer = window.setTimeout(() => setGraceElapsed(true), WALLET_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [pending, sessionActive, walletReady, outcome, graceElapsed]);

  /* The ladder, run once the answer is knowable: either a wallet is open, or
     the grace period has proved that none is coming. `sheetOpen` is false by
     construction — this window serves one exchange and the launch pair is what
     enforces it — but the same shared ladder runs, in the same order, so a
     refusal here is indistinguishable from the embedded one. */
  useEffect(() => {
    if (!pending || outcome || amount !== null) return;
    if (!sessionActive) return;
    if (!walletReady && !graceElapsed) return;

    const verdict = evaluateTxRequest(pending.request, {
      sheetOpen: false,
      walletReady: Boolean(executeTransferRef.current),
      transferContext: transferContext ?? null,
    });
    if (verdict.kind === 'refuse') {
      reply(pending, verdict.body);
      setOutcome({
        kind: 'refused',
        message: verdict.body.detail ?? 'Passport refused the request.',
      });
      return;
    }
    setAmount(verdict.amount);
  }, [
    amount,
    graceElapsed,
    outcome,
    pending,
    reply,
    sessionActive,
    transferContext,
    walletReady,
  ]);

  const decline = useCallback(() => {
    if (!pending || signing) return;
    reply(pending, { status: 'declined', error: 'declined' });
    setOutcome({ kind: 'declined' });
  }, [pending, reply, signing]);

  const approve = useCallback(async () => {
    if (!pending || amount === null || signing) return;
    const wallet = executeTransferRef.current;
    if (!wallet) {
      /* The wallet closed between the sheet appearing and this tap. */
      reply(pending, {
        status: 'failed',
        error: 'wallet-unavailable',
        detail: 'The Passport signing session closed before this could be signed.',
      });
      setOutcome({
        kind: 'failed',
        message: 'The Passport signing session closed before this could be signed.',
      });
      return;
    }
    setSigning(true);
    try {
      /* The seam runs the passkey ceremony and only then signs and submits —
         the same single ceremony per approved action as the embedded flow. */
      const { txId } = await wallet({
        recipientAddress: pending.request.intent.recipientAddress,
        amount,
        purpose: pending.request.intent.purpose,
        origin: pending.origin,
      });
      /* Nothing is ever reported as submitted without the node's own id. */
      if (!txId) throw new Error('Passport returned no transaction id.');
      reply(pending, { status: 'submitted', txId });
      setOutcome({ kind: 'submitted', txId });
    } catch (cause) {
      /* Cancelling the passkey verification sheet is the user declining, not a
         submission that failed — the app is told exactly that. */
      const cancelledCode =
        typeof cause === 'object' &&
        cause !== null &&
        (cause as { code?: unknown }).code === 'approval-cancelled';
      if (cancelledCode) {
        reply(pending, { status: 'declined', error: 'declined' });
        setOutcome({ kind: 'declined' });
      } else {
        const { error, detail } = transferErrorFrom(cause);
        reply(pending, { status: 'failed', error, detail });
        setOutcome({ kind: 'failed', message: detail });
      }
    } finally {
      setSigning(false);
    }
  }, [amount, pending, reply, signing]);

  if (!launch || !pending) return null;
  /* Neither refused nor ready to show: the wallet is still arriving, and the
     grace timer above is the only thing that may end that wait. */
  if (amount === null && !outcome) return null;

  const networkId = transferContext?.networkId;
  const submittedHref =
    outcome?.kind === 'submitted' ? explorerTxHref(networkId, outcome.txId) : null;

  return (
    <div className="profile-consent-backdrop">
      <section
        className="profile-consent"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tx-consent-title"
      >
        <header>
          <span className="profile-consent-mark">
            <Wallet size={20} />
          </span>
          <div>
            <p>Passport</p>
            <h2 id="tx-consent-title">
              {outcome?.kind === 'submitted'
                ? 'Transaction submitted.'
                : outcome?.kind === 'declined'
                  ? 'Payment declined.'
                  : outcome?.kind === 'failed'
                    ? 'Nothing was sent.'
                    : outcome?.kind === 'refused'
                      ? 'Passport cannot pay this.'
                      : signing
                        ? 'Signing and submitting…'
                        : 'This app is asking you to pay.'}
            </h2>
          </div>
        </header>

        {outcome ? (
          <div
            className={`profile-consent-outcome ${
              outcome.kind === 'submitted' ? 'approved' : 'denied'
            }`}
          >
            {outcome.kind === 'submitted' ? <Check size={22} /> : <X size={22} />}
            <p>
              {outcome.kind === 'submitted' ? (
                <>
                  Sent — {amount === null ? '' : `${formatNight(amount)} NIGHT `}went out of
                  your account. The node accepted the transaction and returned its identifier;{' '}
                  {pending.origin} has been told the same id.
                  <br />
                  <code>{outcome.txId}</code>
                  {submittedHref ? (
                    <>
                      <br />
                      <a href={submittedHref} target="_blank" rel="noreferrer noopener">
                        View on the {networkId ?? ''} explorer
                      </a>
                    </>
                  ) : null}
                </>
              ) : outcome.kind === 'declined' ? (
                <>
                  Nothing was signed and nothing was sent. {pending.origin} was told you
                  declined.
                </>
              ) : (
                <>
                  Nothing was sent — no NIGHT moved from your account. {outcome.message}
                </>
              )}
            </p>
            <button type="button" onClick={() => window.close()}>
              Close window
            </button>
          </div>
        ) : (
          <>
            <p className="profile-consent-origin">
              <ExternalLink size={15} />
              <span>{pending.origin}</span>
            </p>
            <p className="profile-consent-copy">
              This application is asking Passport to send, from this device:
            </p>
            <ul>
              <li>
                <Check size={15} />
                <span>Amount</span>
                <strong>
                  {amount === null ? '' : formatNight(amount)} NIGHT
                  <small> · {pending.request.intent.amount} atomic units</small>
                </strong>
              </li>
              <li>
                <Check size={15} />
                <span>Purpose</span>
                <small>{pending.request.intent.purpose}</small>
              </li>
              <li>
                <Check size={15} />
                <span>Recipient</span>
                <button
                  type="button"
                  onClick={() => setShowFullRecipient((shown) => !shown)}
                  aria-expanded={showFullRecipient}
                >
                  <code>
                    {showFullRecipient
                      ? pending.request.intent.recipientAddress
                      : shortAddress(pending.request.intent.recipientAddress)}
                  </code>
                  <small> {showFullRecipient ? 'Hide' : 'Show full address'}</small>
                </button>
              </li>
              <li>
                <Check size={15} />
                <span>Your account holds</span>
                <small>{accountHoldsCopy(transferContext?.formattedBalance)}</small>
              </li>
            </ul>
            <div className="profile-consent-boundary">{txBoundaryCopy(networkId)}</div>
            <div className="profile-consent-actions">
              <button type="button" className="deny" onClick={decline} disabled={signing}>
                Decline
              </button>
              <button
                type="button"
                className="approve"
                onClick={() => void approve()}
                disabled={signing}
              >
                {signing ? (
                  <>
                    <Loader2 className="spin" size={16} />
                    Signing and submitting…
                  </>
                ) : (
                  <>
                    <PenLine size={16} />
                    Approve and sign
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
