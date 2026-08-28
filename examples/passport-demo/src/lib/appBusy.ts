/**
 * The one answer to "is Passport in the middle of something?".
 *
 * It exists for exactly one consumer: `src/pwa.tsx`, which reloads the page
 * the moment a new service worker takes over. That reload is what makes an
 * installed Passport pick up a deployment — see the header of `public/sw.js`
 * — and it is also the one thing that must never happen while a passkey
 * ceremony is open, a transaction is being proved, or a name is being
 * registered. A reload there does not just lose a screen: it abandons a flow
 * the user has already paid a passkey assertion for.
 *
 * This module holds no DOM, no React, and no timers. It is a counter and a
 * subscription, so the screens can declare "I am in the middle of something"
 * with a `useEffect` that returns the release function, and nothing has to
 * remember to clear a flag on an error path.
 *
 *     useEffect(() => (busy ? holdCriticalWork() : undefined), [busy]);
 *
 * A COUNTER and not a boolean, deliberately: an account deploy and a name
 * registration overlap during onboarding, and a boolean would let whichever
 * finished first declare the app idle while the other was still running.
 */

let holds = 0;

type CriticalWorkListener = (inFlight: boolean) => void;

const listeners = new Set<CriticalWorkListener>();

function publish(): void {
  const inFlight = holds > 0;
  // A copy: a listener is allowed to unsubscribe itself from inside its own
  // callback, and mutating the set mid-iteration would skip its neighbour.
  for (const listener of [...listeners]) listener(inFlight);
}

/**
 * Declares that something the user must not lose is running, and answers with
 * the release. Releasing twice is a no-op rather than an error, so a caller
 * that releases in both a `finally` and an effect cleanup cannot drive the
 * count negative and pin the app as busy for ever.
 */
export function holdCriticalWork(): () => void {
  holds += 1;
  if (holds === 1) publish();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    if (holds === 0) publish();
  };
}

/** True while any hold is outstanding. */
export function criticalWorkInFlight(): boolean {
  return holds > 0;
}

/**
 * Watches the answer. The listener is NOT called on subscribe — callers read
 * {@link criticalWorkInFlight} for the current value — and the returned
 * function unsubscribes.
 */
export function subscribeCriticalWork(listener: CriticalWorkListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
