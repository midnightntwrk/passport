import { useEffect, useState } from 'react';
import { Check, ExternalLink, X } from 'lucide-react';

/**
 * A single confirmation toast, carrying an optional link.
 *
 * The Passport app moved transaction confirmations out of popups and into
 * toasts on 2026/08/06, and the raffle follows: the ticket entry is confirmed
 * on a card that can be tapped straight through to the explorer, instead of
 * only being a line of text on a panel the user has to find.
 *
 * A deliberately small reimplementation rather than a shared import —
 * Passport's stack is built on `motion/react`, and this demo is meant to be
 * copied out of the repository and installed on its own. One dependency less
 * to explain.
 */

export interface RaffleToastLink {
  label: string;
  href: string;
}

export interface RaffleToastPayload {
  title: string;
  body?: string;
  /** Omit where no public explorer resolves the identifier. */
  link?: RaffleToastLink;
}

type Listener = (toast: (RaffleToastPayload & { id: number }) | null) => void;

let current: (RaffleToastPayload & { id: number }) | null = null;
let nextId = 0;
const listeners = new Set<Listener>();

export function pushRaffleToast(toast: RaffleToastPayload): void {
  current = { ...toast, id: ++nextId };
  for (const listener of listeners) listener(current);
}

/** Longer than a plain notice: a link has to survive being aimed at. */
const DISMISS_MS = 12_000;

export default function RaffleToast() {
  const [toast, setToast] = useState<(RaffleToastPayload & { id: number }) | null>(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const listener: Listener = (next) => setToast(next);
    listeners.add(listener);
    listener(current);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!toast || paused) return;
    const timer = window.setTimeout(() => {
      current = null;
      setToast(null);
    }, DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [toast, paused]);

  if (!toast) return null;

  const dismiss = () => {
    current = null;
    setToast(null);
  };

  return (
    <div
      className="raffle-toast"
      role="status"
      aria-live="polite"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
    >
      <span className="raffle-toast-icon" aria-hidden="true">
        <Check size={15} strokeWidth={2.4} />
      </span>
      <div className="raffle-toast-copy">
        <p className="raffle-toast-title">{toast.title}</p>
        {toast.body ? <p className="raffle-toast-body">{toast.body}</p> : null}
        {toast.link ? (
          <a
            className="raffle-toast-link"
            href={toast.link.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span>{toast.link.label}</span>
            <ExternalLink size={13} strokeWidth={2.2} aria-hidden="true" />
          </a>
        ) : null}
      </div>
      <button
        type="button"
        className="raffle-toast-close"
        onClick={dismiss}
        aria-label="Dismiss notification"
      >
        <X size={13} strokeWidth={2.2} aria-hidden="true" />
      </button>
    </div>
  );
}
