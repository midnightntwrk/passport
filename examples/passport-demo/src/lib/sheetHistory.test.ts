import { describe, expect, it } from 'vitest';

import {
  SHEET_HISTORY_KEY,
  sheetFromHistoryState,
  sheetHistoryState,
  shouldUnwindSheetEntry,
} from './sheetHistory.js';

describe('sheetHistoryState', () => {
  it('marks the entry with the sheet that pushed it', () => {
    expect(sheetHistoryState('send')).toEqual({ [SHEET_HISTORY_KEY]: 'send' });
  });

  it('round-trips through the reader, which is the only pairing that matters', () => {
    expect(sheetFromHistoryState(sheetHistoryState('receive'))).toBe('receive');
  });
});

describe('sheetFromHistoryState', () => {
  it('answers null for everything a browser hands back that is not ours', () => {
    /* The document's own first entry is `null`, a framed app may push a
       string, and a library may push an object of its own. A reader that
       guessed at any of these would close a Passport sheet on a `popstate`
       that had nothing to do with Passport. */
    expect(sheetFromHistoryState(null)).toBeNull();
    expect(sheetFromHistoryState(undefined)).toBeNull();
    expect(sheetFromHistoryState('send')).toBeNull();
    expect(sheetFromHistoryState(42)).toBeNull();
    expect(sheetFromHistoryState({ someoneElse: 'send' })).toBeNull();
  });

  it('refuses a mark that is not a name', () => {
    expect(sheetFromHistoryState({ [SHEET_HISTORY_KEY]: '' })).toBeNull();
    expect(sheetFromHistoryState({ [SHEET_HISTORY_KEY]: 7 })).toBeNull();
  });
});

describe('shouldUnwindSheetEntry', () => {
  it('takes back the entry a sheet closed by its own control still owns', () => {
    /* The close button, the scrim, Escape, a send that finished. The entry is
       still on top and nobody has popped it; left there, the reader's next
       back press does nothing they can see. */
    expect(
      shouldUnwindSheetEntry({
        sheet: 'send',
        closedByBack: false,
        state: sheetHistoryState('send'),
      }),
    ).toBe(true);
  });

  it('never unwinds after the gesture, because the browser already did', () => {
    /* Calling `back()` a second time here is the navigation this whole module
       exists to prevent, reached from the other side: the reader dismisses a
       sheet and leaves the app. */
    expect(
      shouldUnwindSheetEntry({
        sheet: 'send',
        closedByBack: true,
        state: sheetHistoryState('send'),
      }),
    ).toBe(false);
  });

  it('leaves an entry that is no longer ours alone', () => {
    /* Another sheet opened over this one, or something else pushed. Unwinding
       would drop somebody else's entry and close the wrong thing. */
    expect(
      shouldUnwindSheetEntry({
        sheet: 'send',
        closedByBack: false,
        state: sheetHistoryState('receive'),
      }),
    ).toBe(false);
    expect(shouldUnwindSheetEntry({ sheet: 'send', closedByBack: false, state: null })).toBe(false);
  });
});
