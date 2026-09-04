import { useEffect, useRef } from 'react'

/* Every rule is in `lib/sheetHistory.ts`, which is where they are drilled. */
import { sheetHistoryState, shouldUnwindSheetEntry } from '../lib/sheetHistory.js'

/**
 * Makes the back gesture close a sheet instead of leaving the app.
 *
 * The React half of `lib/sheetHistory.ts`; read that file for the defect and
 * the shape of the answer. This one holds the listener's lifetime and nothing
 * else, on the same rule as `useBalanceWatch.ts`: there is no jsdom in this
 * workspace, so a hook cannot be drilled, and anything a hook decided would be
 * a decision nothing measures.
 *
 * `close` is held in a ref so a re-render — which on Home is every balance
 * read — does not tear the entry down and push a second one.
 *
 * @param sheet a name for this sheet, unique among the sheets that can be open
 *   at once. It is what a `popstate` is matched against.
 * @param open whether the sheet is on screen.
 * @param close what the gesture should do. Called at most once per opening.
 */
export function useSheetBackButton(sheet: string, open: boolean, close: () => void): void {
  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    if (!open) return undefined
    /* Whether the browser has already popped the entry pushed below. It is a
       closure variable rather than state because nothing renders from it and
       the cleanup is the only reader. */
    let closedByBack = false
    window.history.pushState(sheetHistoryState(sheet), '')
    const onPopState = () => {
      closedByBack = true
      closeRef.current()
    }
    window.addEventListener('popstate', onPopState)
    return () => {
      window.removeEventListener('popstate', onPopState)
      if (shouldUnwindSheetEntry({ sheet, closedByBack, state: window.history.state })) {
        window.history.back()
      }
    }
  }, [sheet, open])
}
