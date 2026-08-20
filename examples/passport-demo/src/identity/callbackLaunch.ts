/* ===========================================================================
 * Midnight Passport — surviving the onboarding, launch side
 * ===========================================================================
 *
 * The callback contract in `./callbackProtocol.ts` is a redirect in both
 * directions. Between the two redirects sits the ENTIRE onboarding: create or
 * discover a passkey, open the wallet, optionally claim a name, land on Home.
 * That stretch is not one continuous page life.
 *
 *   - `pwa.tsx` calls `location.reload()` when a new service worker takes
 *     control, which is most likely on a first visit — exactly when a new user
 *     arrives from an app.
 *   - In development `main.tsx` does `location.replace` to pin the origin to
 *     `http://localhost:5175`.
 *   - iOS discards and restores tabs whenever it feels like it.
 *
 * So the launch parameters are read once, at MODULE IMPORT time — before any
 * component renders, before onboarding decides what to show — and copied into
 * `sessionStorage`. Every later read prefers the URL and falls back to storage.
 * Both together, because neither alone is enough:
 *
 *   - Storage alone fails the `main.tsx` dev redirect. That redirect can cross
 *     ORIGINS (`127.0.0.1` → `localhost`), and `sessionStorage` is
 *     per-origin — the copy would not follow. The URL does.
 *   - The URL alone fails anything that navigates within Passport, and fails
 *     the moment we would want to tidy the address bar.
 *
 * WHY THE URL IS NOT SCRUBBED. The tempting move is a `history.replaceState`
 * to strip the parameters after capture. It is wrong here: the capture below
 * runs during module evaluation, which is BEFORE `main.tsx` performs its
 * development origin redirect (imports are hoisted), and that redirect
 * forwards `window.location.search`. Scrubbing would delete the parameters
 * from the URL that is about to be replayed onto the origin whose storage is
 * empty, and the flow would vanish on every dev launch. Leaving them in place
 * costs nothing — the callback URL and the app's state token are not secrets.
 *
 * The consequence of not scrubbing is that a reload — or the browser back
 * button after the reply has been delivered — re-presents the same launch. So
 * a launch that has been ANSWERED or DISMISSED is recorded as settled, and a
 * settled launch reads as absent no matter what the URL still says. That, not
 * URL tidying, is what makes "Don't share" and "dismiss the notice" stick.
 * ========================================================================= */

import {
  parsePassportCallbackLaunch,
  type PassportCallbackLaunch,
  type PassportCallbackLaunchParse,
} from './callbackProtocol.js';

/** Bumped with the record shape, so an old tab's copy is ignored, not misread. */
const LAUNCH_KEY = 'passport.callback.launch.v1';
const SETTLED_KEY = 'passport.callback.settled.v1';

/**
 * One page load serves one launch. The record pairs the parse with the query
 * string it came from, because those two can disagree: the parse may have been
 * restored from storage while the current URL is bare. Carrying the source
 * query means {@link settlePassportCallbackLaunch} marks the launch that was
 * actually presented rather than whatever the address bar says now.
 */
export interface PassportCallbackLaunchRecord {
  readonly parse: PassportCallbackLaunchParse;
  /** The query string this parse came from. */
  readonly search: string;
}

/**
 * Storage is a convenience, never a requirement. Safari in private mode throws
 * on `sessionStorage` access, and a flow that dies there would be a flow that
 * dies on the exact device this contract exists for. Every access is guarded
 * and every failure degrades to "URL only".
 */
function session(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    return session()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    session()?.setItem(key, value);
  } catch {
    /* Nothing to do and nothing to report: the URL is still the source. */
  }
}

function remove(key: string): void {
  try {
    session()?.removeItem(key);
  } catch {
    /* As above. */
  }
}

/**
 * Identifies one launch across reloads. Not a security boundary and not
 * hashed — it only has to distinguish "the launch I already answered" from "a
 * new launch that happens to reuse the same callback URL", and the state token
 * is what an app varies between attempts. `JSON.stringify` of the tuple rather
 * than a joined string: a state token may legitimately contain any character a
 * query parameter can decode to, so no separator is safe by hand.
 */
function fingerprint(record: PassportCallbackLaunchRecord): string {
  if (record.parse.kind === 'absent') return '';
  if (record.parse.kind === 'malformed') {
    /* A malformed launch has no parsed fields to key on, so its raw query
       stands in — dismissing the notice must still stick across a reload. */
    return JSON.stringify(['malformed', record.search]);
  }
  const launch: PassportCallbackLaunch = record.parse.launch;
  return JSON.stringify(['ok', launch.callbackUrl, launch.fields, launch.state]);
}

function currentSearch(): string {
  if (typeof window === 'undefined') return '';
  return window.location.search;
}

function restore(): PassportCallbackLaunchRecord | null {
  const raw = read(LAUNCH_KEY);
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    remove(LAUNCH_KEY);
    return null;
  }
  const search = (value as { search?: unknown } | null)?.search;
  if (typeof search !== 'string') {
    remove(LAUNCH_KEY);
    return null;
  }
  /* Re-parsed rather than trusted. The stored copy is a cache of a query
     string, so the query string is what is kept authoritative — every rule in
     `parsePassportCallbackLaunch` is re-applied on the way out, and a record
     written by an older build cannot smuggle a launch past a rule this build
     added. */
  const parse = parsePassportCallbackLaunch(search);
  if (parse.kind === 'absent') {
    remove(LAUNCH_KEY);
    return null;
  }
  return { parse, search };
}

/**
 * The launch this page load is serving, if any. Total, never throws, and safe
 * to call repeatedly.
 *
 * Precedence: the URL wins over storage, because the URL is the thing the app
 * actually sent and storage is only a copy that survives navigation.
 */
export function readPassportCallbackLaunch(): PassportCallbackLaunchRecord {
  const search = currentSearch();
  const fromUrl = parsePassportCallbackLaunch(search);
  const chosen: PassportCallbackLaunchRecord | null =
    fromUrl.kind === 'absent' ? restore() : { parse: fromUrl, search };
  if (!chosen) return { parse: { kind: 'absent' }, search };

  const settled = read(SETTLED_KEY);
  if (settled !== null && settled === fingerprint(chosen)) {
    /* Already answered or dismissed. The URL may still carry it — a reload, or
       the back button after the reply was delivered — and it must not re-arm. */
    return { parse: { kind: 'absent' }, search };
  }

  write(LAUNCH_KEY, JSON.stringify({ search: chosen.search }));
  return chosen;
}

/**
 * Marks this launch finished — approved, declined, or dismissed. Called BEFORE
 * the redirect, not after: once `location.assign` runs this document is on its
 * way out, and a write that happens after it is a write that may not happen.
 */
export function settlePassportCallbackLaunch(record: PassportCallbackLaunchRecord): void {
  if (record.parse.kind === 'absent') return;
  write(SETTLED_KEY, fingerprint(record));
  remove(LAUNCH_KEY);
}

/**
 * Captured at import time. Importing this module from `App.tsx` is therefore
 * enough to guarantee the parameters are read and copied before the first
 * render — including the render that decides whether to show onboarding at
 * all — with no ordering rule for anyone to remember or accidentally break.
 */
export const passportCallbackLaunch: PassportCallbackLaunchRecord =
  typeof window === 'undefined'
    ? { parse: { kind: 'absent' }, search: '' }
    : readPassportCallbackLaunch();
