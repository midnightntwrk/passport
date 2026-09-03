import { useEffect, useRef } from 'react'

/* The app's own "in the middle of something" counter — the same one that stops
   a service-worker reload landing inside a passkey ceremony. The watch stands
   off while it is held rather than piling an indexer read and a ledger decode
   on top of a proving run: see BALANCE_WATCH_BUSY_STANDOFF_MS. */
import { criticalWorkInFlight } from '../lib/appBusy.js'
import { startBalanceWatch } from '../lib/balanceWatch.js'

/**
 * The React half of the account watch. All the rules are in
 * `lib/balanceWatch.ts`, which is where they are drilled; this file is the
 * wiring, and it holds three things and no decisions:
 *
 *   - the watch's lifetime, which is the lifetime of the screen showing
 *     balances (Home and Assets — only one of them is ever mounted at a time,
 *     so there is only ever one watch);
 *   - the `visibilitychange` listener, so a backgrounded tab stops asking and
 *     reads once on the way back;
 *   - the latest `refresh` and `signature`, held in refs so a re-render does
 *     not tear down and restart the watch — restarting it would reset the
 *     chase, and a chase that restarts on every render never backs off.
 *
 * It lives beside the screens rather than in `src/lib` because it imports
 * React, and everything in the coverage denominator is deliberately free of
 * it: there is no jsdom in this workspace to render a hook into, and a hook
 * that could not be drilled would be a hole in a 100% bar rather than a
 * measurement.
 */
export interface BalanceWatchWiring {
  /** False when there is nothing to watch — no account, no session. */
  active: boolean
  /** Re-reads the account. Undefined where the screen was handed no refresh. */
  refresh: (() => void) | undefined
  /** What the account holds right now — see `holdingsSignature`. */
  signature: string
  /**
   * A token that changes whenever something has been ANNOUNCED: a row lands on
   * the trail, or the set of amounts on their way changes. Each change starts
   * a chase, which runs until the holdings move or its window is spent.
   */
  chaseKey: string
}

export function useBalanceWatch({ active, refresh, signature, chaseKey }: BalanceWatchWiring): void {
  const refreshRef = useRef(refresh)
  const signatureRef = useRef(signature)
  refreshRef.current = refresh
  signatureRef.current = signature

  const watchRef = useRef<ReturnType<typeof startBalanceWatch> | null>(null)

  useEffect(() => {
    if (!active) return undefined
    const watch = startBalanceWatch({
      refresh: () => refreshRef.current?.(),
      signature: () => signatureRef.current,
      busy: criticalWorkInFlight,
    })
    watchRef.current = watch
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') watch.pause()
      else watch.resume()
    }
    document.addEventListener('visibilitychange', onVisibility)
    /* A screen mounted while the tab is already in the background must not
       start reading. Nothing fires `visibilitychange` for a state that was
       already true, so it is asked once here. */
    if (document.visibilityState === 'hidden') watch.pause()
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      watch.stop()
      watchRef.current = null
    }
  }, [active])

  useEffect(() => {
    /* Fires on mount too, and that is wanted: a Passport opened with an
       opening balance already on its way should be chasing it from the first
       frame, not from whenever the next thing happens. */
    watchRef.current?.expectChange()
  }, [chaseKey])
}
