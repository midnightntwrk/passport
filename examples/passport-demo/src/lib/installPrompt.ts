/**
 * WHETHER TO OFFER TO INSTALL PASSPORT, AND WHICH OFFER TO MAKE.
 *
 * THE DEFECT
 * ----------
 * Reported 2026/09/02: a reviewer running Passport in an ordinary browser tab
 * found no way to install it. There WAS one — a corner button in `pwa.tsx` —
 * but it only appeared on a desktop viewport, only once Chromium had fired
 * `beforeinstallprompt`, and nowhere near where anybody looks. On mobile the
 * only offer was a one-shot sheet four seconds into a clear screen, which any
 * dismissal retires permanently. A person who says "not now" once, or who
 * never sees it, has no route back.
 *
 * So the offer moved to the top bar, where a person looks for it, and this
 * module is the rule that decides what it says. There are exactly three
 * answers and the whole point is that the third one is honest:
 *
 *   `prompt` — Chromium has offered this page an install prompt and the page
 *              is holding it. A button, and pressing it opens the browser's
 *              own dialogue.
 *   `hint`   — iOS Safari, which fires no install event and never will. Two
 *              taps the person has to make themselves, said plainly. A button
 *              here would be a control that cannot work.
 *   `hidden` — already installed, or a browser that can do neither. Offering
 *              an install to somebody who is running the installed app is the
 *              clearest possible signal that a screen is not reading its own
 *              state, and offering one to a browser that cannot install is a
 *              dead end dressed as a feature.
 *
 * WHY "ALREADY INSTALLED" IS TWO QUESTIONS
 * ----------------------------------------
 * `display-mode: standalone` is the standard answer and iOS does not give it
 * on every version; `navigator.standalone` is iOS's own, non-standard one and
 * exists nowhere else. Either being true means installed. Asking only the
 * standard one put an "Install Passport" button inside the installed app on
 * older iOS, which is the exact opposite of the fix.
 *
 * No DOM, no React, no `window`: the environment is passed in, so every rule
 * here is drilled directly rather than through a browser nobody can pin down.
 */

/** What the top bar should offer, if anything. */
export type InstallAffordance = 'prompt' | 'hint' | 'hidden';

/** Everything the rules need, read off the browser by the caller. */
export interface InstallEnvironment {
  /** `matchMedia('(display-mode: standalone)').matches`. */
  standaloneDisplay: boolean;
  /** `navigator.standalone` — iOS's own answer, absent everywhere else. */
  iosStandalone?: boolean | undefined;
  /** True once this page has captured a `beforeinstallprompt` it can replay. */
  promptHeld: boolean;
  /** `navigator.userAgent`. */
  userAgent: string;
  /** `navigator.maxTouchPoints`. iPadOS reports itself as a Mac. */
  maxTouchPoints: number;
}

/** The two taps an iOS reader has to make. Shown, never performed. */
export const INSTALL_HINT_STEPS: readonly string[] = [
  'Tap Share in Safari’s toolbar.',
  'Choose “Add to Home Screen”.',
];

/** The control's one label, shared by the button and its accessible name. */
export const INSTALL_LABEL = 'Install Passport';

/**
 * iOS, including iPadOS, which reports itself as a Mac with a touchscreen.
 * The touch-point test is the only thing separating an iPad from a laptop in a
 * user-agent string Apple deliberately made indistinguishable.
 */
export function isIosDevice(userAgent: string, maxTouchPoints: number): boolean {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true;
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}

/**
 * Safari proper — not Chrome, Firefox, Edge, or Opera wearing its engine.
 *
 * It matters because only Safari has the Share sheet the hint names. Chrome on
 * iOS is running WebKit too, but its toolbar is its own and "tap Share in
 * Safari's toolbar" would be directions to a button that is not there.
 */
export function isSafariBrowser(userAgent: string): boolean {
  return (
    /Safari/.test(userAgent) &&
    !/CriOS|FxiOS|EdgiOS|OPiOS|Chrome|Chromium|Android/.test(userAgent)
  );
}

/** Running as an installed app, by either browser's way of saying so. */
export function alreadyInstalled(environment: InstallEnvironment): boolean {
  return environment.standaloneDisplay || environment.iosStandalone === true;
}

/** The one decision. See the module header for what each answer means. */
export function installAffordance(environment: InstallEnvironment): InstallAffordance {
  if (alreadyInstalled(environment)) return 'hidden';
  if (environment.promptHeld) return 'prompt';
  if (
    isIosDevice(environment.userAgent, environment.maxTouchPoints) &&
    isSafariBrowser(environment.userAgent)
  ) {
    return 'hint';
  }
  return 'hidden';
}
