/**
 * Where "Chat with your Midnight Companion" goes, and the one rule that
 * decides it.
 *
 * The Companion is a Telegram chat. Passport does not talk to it, does not
 * hold a token for it, and learns nothing from it: pressing the control opens
 * a link in a new tab and that is the whole of the interaction. So the only
 * thing worth drilling is the ADDRESS, and the only way this can be wrong is
 * user-visible in exactly two ways — sending a reader to a build's misspelt or
 * half-configured value, or ignoring a value the operator deliberately set.
 *
 * The rule is therefore the same one `registry.ts` applies to every other
 * configured origin, stated once here so the control itself holds no policy:
 * a configured URL is used when it is a string that parses and is served over
 * https, and in every other case the default stands. There is no partial
 * acceptance and no repair — a value that does not parse is not a value, and
 * guessing at what an operator meant by `t.me/whatever` is how a demo opens a
 * page nobody proof-read.
 *
 * THE DEFAULT IS A PLACEHOLDER. `https://t.me/MidnightCompanionBot` is NOT the
 * real handle — the Companion's handle is not known yet as of 2026/09/03. Any
 * build that wants the working chat sets `VITE_COMPANION_URL`; when the real
 * handle is issued, it replaces the constant below and nothing else changes.
 */

/** The control's label, said the same way wherever the control appears. */
export const COMPANION_LABEL = 'Chat with your Midnight Companion';

/**
 * Placeholder handle — see the module header. Replace when the real one is
 * issued; until then a build sets `VITE_COMPANION_URL`.
 */
export const COMPANION_DEFAULT_URL = 'https://t.me/MidnightCompanionBot';

/**
 * The address the Companion control opens.
 *
 * @param configured the build's `VITE_COMPANION_URL`, in whatever state the
 *   environment left it — unset, blank, or a string.
 * @returns the configured URL when it is an https one, and
 *   {@link COMPANION_DEFAULT_URL} otherwise.
 */
/* Shown only when a real handle is configured. The placeholder handle does
   not exist on Telegram, and a button that opens a failed chat is worse than
   no button; the demo video sets VITE_COMPANION_URL, the public link does not. */
export function companionEnabled(configured: unknown): boolean {
  return companionUrl(configured) !== COMPANION_DEFAULT_URL;
}

export function companionUrl(configured: unknown): string {
  if (typeof configured !== 'string') return COMPANION_DEFAULT_URL;
  const candidate = configured.trim();
  if (candidate === '') return COMPANION_DEFAULT_URL;
  try {
    /* Parsed rather than pattern-matched: the question is whether a browser
       will treat this as an https address, and `URL` is the thing that
       answers it. http is refused along with everything else — this link is
       handed to another site, and there is no local-development case for it
       the way there is for an app's own dev server. */
    return new URL(candidate).protocol === 'https:' ? candidate : COMPANION_DEFAULT_URL;
  } catch {
    return COMPANION_DEFAULT_URL;
  }
}
