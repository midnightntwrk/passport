import { useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';

/**
 * A live transcript of the bridge.
 *
 * This is a teaching device, not a requirement — delete it and the app still
 * works. It is here because the protocols are only three message types each,
 * and seeing the actual JSON go past teaches them faster than any diagram:
 * you can watch the `requestId`/`nonce` pair be minted, echoed back, and
 * matched, which is the whole security story in one glance.
 *
 * It records only what THIS app sent and what it accepted. Messages dropped by
 * the origin check never reach it, which is itself worth noticing — if you
 * point `VITE_PASSPORT_ORIGIN` at the wrong origin, the log stays empty rather
 * than filling with someone else's traffic.
 */

export type BridgeDirection = 'out' | 'in';

export interface BridgeEntry {
  id: number;
  at: string;
  direction: BridgeDirection;
  /** The message `type`, e.g. `passport.profile.request`. */
  label: string;
  /** The message body, as it went on (or came off) the wire. */
  payload: unknown;
}

type Listener = (entries: BridgeEntry[]) => void;

let entries: BridgeEntry[] = [];
let nextId = 0;
const listeners = new Set<Listener>();

/** Keeps the panel bounded; the protocol exchanges are short by design. */
const MAX_ENTRIES = 24;

export function recordBridgeMessage(
  direction: BridgeDirection,
  label: string,
  payload: unknown,
): void {
  const entry: BridgeEntry = {
    id: ++nextId,
    at: new Date().toISOString().slice(11, 19),
    direction,
    label,
    payload,
  };
  entries = [...entries, entry].slice(-MAX_ENTRIES);
  for (const listener of listeners) listener(entries);
}

export default function BridgeLog() {
  const [items, setItems] = useState<BridgeEntry[]>(entries);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    const listener: Listener = (next) => setItems(next);
    listeners.add(listener);
    listener(entries);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return (
    <section className="pt-card pt-log" aria-label="Bridge transcript">
      <header className="pt-card-head">
        <h2>Bridge transcript</h2>
        <span className="pt-count">{items.length}</span>
      </header>
      {items.length === 0 ? (
        <p className="pt-muted">
          Nothing yet. Every message this app posts to Passport, and every
          message it accepts back, is listed here.
        </p>
      ) : (
        <ol className="pt-log-list">
          {items.map((entry) => (
            <li key={entry.id} className={`pt-log-row ${entry.direction}`}>
              <button
                type="button"
                className="pt-log-summary"
                onClick={() => setOpen((current) => (current === entry.id ? null : entry.id))}
                aria-expanded={open === entry.id}
              >
                <span className="pt-log-arrow" aria-hidden="true">
                  {entry.direction === 'out' ? (
                    <ArrowUpRight size={13} strokeWidth={2.4} />
                  ) : (
                    <ArrowDownLeft size={13} strokeWidth={2.4} />
                  )}
                </span>
                <code className="pt-log-label">{entry.label}</code>
                <span className="pt-log-time">{entry.at}</span>
              </button>
              {open === entry.id ? (
                <pre className="pt-log-payload">{JSON.stringify(entry.payload, null, 2)}</pre>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
