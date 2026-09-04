/**
 * THE BACK GESTURE, AND THE SHEET IT IS SUPPOSED TO CLOSE.
 *
 * THE DEFECT THIS IS THE PURE HALF OF
 * -----------------------------------
 * Found by `e2e/android-shapes.spec.ts` on 2026/09/04. Passport's sheets —
 * Send, and the Receive code — are React state and nothing else. They put no
 * entry on the history stack, so the back gesture, which on Android is the
 * primary way anybody dismisses anything, never reached them. It reached the
 * document instead: with a sheet open over Home, a back swipe left the page
 * and took the open sheet, the amount typed into it, and the session's warm
 * wallet with it. Installed to the home screen there is frequently nothing
 * behind Passport to go back TO, so the same gesture closed the app.
 *
 * Either way the sheet is the one thing that did not close, which is the one
 * thing the gesture meant.
 *
 * THE SHAPE OF THE FIX. A sheet that opens pushes one history entry and marks
 * it as its own. A `popstate` off that entry closes the sheet and nothing else
 * — the entry has already gone, so there is nothing to unwind. A sheet closed
 * any OTHER way (its own close control, the scrim, Escape, a send that
 * finished) still owns an entry that nobody has popped, and must take it back
 * off the stack itself; otherwise the entries pile up and the reader's next
 * back press does nothing visible, which is its own kind of broken.
 *
 * WHY THE MARK IS ON THE STATE AND NOT THE URL. The URL is load-bearing here:
 * `identity/callbackLaunch.ts` deliberately does not scrub the launch
 * parameters an app hands Passport, and `verify/main.ts` writes its own. A
 * sheet that changed the address bar would be a sheet that could change what a
 * reload does. `pushState(state, '')` keeps the URL exactly as it was and
 * carries the mark in the entry's state, where nothing else reads.
 *
 * There is no DOM and no React in here — the wiring that owns the listener is
 * `src/screens/useSheetBackButton.ts`, on the same rule as `balanceWatch.ts`
 * and its hook: the decisions live where they can be drilled.
 */

/**
 * The property a Passport sheet's history entry carries, and the reason it is
 * namespaced rather than something like `sheet`.
 *
 * Anything may push onto this stack — a framed app, a library, a later version
 * of this app — and a mark that reads a stranger's entry as ours would close a
 * sheet on a `popstate` that had nothing to do with it.
 */
export const SHEET_HISTORY_KEY = 'passportSheet';

/** The history state a sheet pushes when it opens. */
export function sheetHistoryState(sheet: string): Record<string, string> {
  return { [SHEET_HISTORY_KEY]: sheet };
}

/**
 * Which Passport sheet a history entry belongs to, or null for every entry
 * that is not one of ours — including the ones a browser hands back as `null`
 * for the document's own first entry.
 */
export function sheetFromHistoryState(state: unknown): string | null {
  if (typeof state !== 'object' || state === null) return null;
  const mark = (state as Record<string, unknown>)[SHEET_HISTORY_KEY];
  return typeof mark === 'string' && mark !== '' ? mark : null;
}

/**
 * Whether a sheet that is closing still owes the history stack an entry.
 *
 * `closedByBack` is the whole of the distinction. A sheet the gesture closed
 * has already had its entry popped by the browser, and calling `back()` again
 * would leave the page — the exact navigation this module exists to prevent,
 * arrived at from the other side. A sheet closed by anything else still has
 * its entry on top, and leaving it there costs the reader a back press that
 * appears to do nothing.
 *
 * The state is checked as well as the flag because the top of the stack is not
 * ours to assume: another sheet, or anything else, may have pushed since.
 * Unwinding then would drop somebody else's entry.
 */
export function shouldUnwindSheetEntry(input: {
  sheet: string;
  closedByBack: boolean;
  state: unknown;
}): boolean {
  if (input.closedByBack) return false;
  return sheetFromHistoryState(input.state) === input.sheet;
}
