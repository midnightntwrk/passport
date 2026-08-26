import { useEffect, useState } from 'react';
import { Check, ExternalLink, X } from 'lucide-react';

/**
 * A single confirmation toast, carrying an optional link.
 *
 * Passport confirms transactions with a toast rather than a popup, and an app
 * that does the same feels like part of the same product. This is a
 * deliberately small, dependency-free reimplementation rather than a shared
 * import: the template must survive being copied out of the repository, and
 * one animation library is one more thing to explain.
 *
 * Delete it if your app already has notifications. Nothing in `src/bridge/`
 * depends on it.
 */

export interface PassportToastLink {
  label: string;
  href: string;
}

export interface PassportToastPayload {
  title: string;
  body?: string;
  /** Omit where no public explorer resolves the identifier. */
  link?: PassportToastLink;
  /** `error` is used for a refusal; the copy still has to be honest. */
  tone?: 'success' | 'error';
}

type Toast = PassportToastPayload & { id: number };
type Listener = (toast: Toast | null) => void;

/* Module-level state, so any code path can raise a toast without the caller
   having to be inside the React tree. */
let current: Toast | null = null;
let nextId = 0;
const listeners = new Set<Listener>();

export function pushToast(toast: PassportToastPayload): void {
  current = { ...toast, id: ++nextId };
  for (const listener of listeners) listener(current);
}

/** Longer than a plain notice: a link has to survive being aimed at. */
const DISMISS_MS = 12_000;

export default function PassportToast() {
  const [toast, setToast] = useState<Toast | null>(null);
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
      className={`pt-toast ${toast.tone === 'error' ? 'is-error' : 'is-success'}`}
      role="status"
      aria-live="polite"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
    >
      <span className="pt-toast-icon" aria-hidden="true">
        {toast.tone === 'error' ? (
          <X size={15} strokeWidth={2.4} />
        ) : (
          <Check size={15} strokeWidth={2.4} />
        )}
      </span>
      <div className="pt-toast-copy">
        <p className="pt-toast-title">{toast.title}</p>
        {toast.body ? <p className="pt-toast-body">{toast.body}</p> : null}
        {toast.link ? (
          <a
            className="pt-toast-link"
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
        className="pt-toast-close"
        onClick={dismiss}
        aria-label="Dismiss notification"
      >
        <X size={13} strokeWidth={2.2} aria-hidden="true" />
      </button>
    </div>
  );
}
