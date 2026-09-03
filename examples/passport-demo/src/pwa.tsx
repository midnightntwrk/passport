import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Bell, Download, RefreshCw, Share, SquarePlus, WifiOff } from 'lucide-react';

import { criticalWorkInFlight } from './lib/appBusy.js';
import './pwa-install.css';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
}

interface NavigatorWithStandalone extends Navigator {
  standalone?: boolean;
}

function isStandaloneDisplay(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    Boolean((navigator as NavigatorWithStandalone).standalone)
  );
}

function pwaRegistrationEnabled(): boolean {
  return import.meta.env.PROD || import.meta.env.VITE_ENABLE_PWA_DEV === 'true';
}

/* -------------------------------------------------------------------------- */
/* Mobile install and notifications invitation (2026/08/06)                   */
/*                                                                            */
/* On a phone, "install" is the difference between a tab someone loses and an */
/* icon on their home screen. Desktop keeps the quiet corner button it always */
/* had; only mobile gets the sheet, and only once — a prompt that reappears   */
/* after it has been declined is a nag, so ANY dismissal is permanent.        */
/*                                                                            */
/* Nothing here asks the browser for anything on load. `prompt()` runs on an  */
/* affirmative tap and nowhere else, and the notification permission is       */
/* requested only from its own explicit button, because a permission dialog   */
/* nobody asked for is the fastest way to a permanent "denied".               */
/* -------------------------------------------------------------------------- */

const INSTALL_DISMISSED_KEY = 'mn-passport:install-dismissed';
const NOTIFICATIONS_DECLINED_KEY = 'mn-passport:notifications-declined';

/**
 * Written by the app the first time a passkey Passport is created or signed
 * in to. Read here — never written — as the signal that the invitation is
 * worth making: "add this to your home screen" is a question for somebody who
 * has a Passport, not for somebody looking at the welcome screen, and a modal
 * sheet over an onboarding ceremony would be actively in the way.
 */
const PASSPORT_SESSION_KEY = 'passport-last-passkey';

/** How long the app is left alone after that before the invitation appears. */
const INSTALL_SHEET_DELAY_MS = 4_000;

/** How often the session signal is re-read while an invitation is pending. */
const SESSION_POLL_MS = 1_500;

/**
 * The floor on how often the browser is asked whether `/sw.js` has changed.
 *
 * The interval is the backstop, not the mechanism: the check that matters runs
 * on `visibilitychange` and `pageshow`, i.e. the moment somebody opens the
 * installed app. That is the literal question a reviewer asked on 2026/08/26
 * — "shouldn't it update on its own when I open the PWA?" — and until this
 * was added the answer was no: the only check was an hourly timer in a
 * document that a phone had long since backgrounded.
 */
const UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1_000;

/** How long an update check is left alone after one has just run. */
const UPDATE_CHECK_MIN_GAP_MS = 60 * 1_000;

function hasPassportSession(): boolean {
  try {
    return Boolean(window.localStorage.getItem(PASSPORT_SESSION_KEY));
  } catch {
    return false;
  }
}

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    window.localStorage.setItem(key, '1');
  } catch {
    // Without storage the invitation may be offered once more. Acceptable;
    // silently failing to record it is not worth blocking the flow over.
  }
}

function isMobileViewport(): boolean {
  return window.matchMedia('(max-width: 860px)').matches;
}

/**
 * iOS, including iPadOS, which reports itself as a Mac with a touchscreen.
 * iOS has no `beforeinstallprompt` at all, so it gets instructions instead of
 * a button that cannot work.
 */
function isIosDevice(): boolean {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

/** Safari proper — not Chrome, Firefox, or Edge wearing its engine. */
function isSafariBrowser(): boolean {
  const ua = navigator.userAgent;
  return /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|Chrome|Chromium|Android/.test(ua);
}

export async function requestPassportStoragePersistence(): Promise<boolean | null> {
  if (!navigator.storage?.persist) return null;
  try {
    if (await navigator.storage.persisted?.()) return true;
    return navigator.storage.persist();
  } catch {
    return null;
  }
}

export function PassportPwaShell({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState(() => navigator.onLine);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [updateRegistration, setUpdateRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [updateReady, setUpdateReady] = useState(false);
  const [reloadingForUpdate, setReloadingForUpdate] = useState(false);
  const [standalone, setStandalone] = useState(isStandaloneDisplay);
  /** Set by the banner's own button: an explicit ask overrides the busy check. */
  const reloadRequested = useRef(false);
  const reloadedForUpdate = useRef(false);
  const [installSheetOpen, setInstallSheetOpen] = useState(false);
  const [installSheetSettled, setInstallSheetSettled] = useState(() =>
    readFlag(INSTALL_DISMISSED_KEY),
  );
  const [notificationsAsked, setNotificationsAsked] = useState(() =>
    readFlag(NOTIFICATIONS_DECLINED_KEY),
  );
  const [mobile] = useState(isMobileViewport);
  const [ios] = useState(isIosDevice);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    const onInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstallPrompt(null);
      setStandalone(true);
      // Installed is the strongest possible "do not ask again".
      setInstallSheetOpen(false);
      setInstallSheetSettled(true);
      writeFlag(INSTALL_DISMISSED_KEY);
    };

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('beforeinstallprompt', onInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);

    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('beforeinstallprompt', onInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  /* --- Keeping an installed Passport on the deployed build ----------------- */

  /**
   * The whole update path, and the fix for the 2026/08/26 incident in which a
   * reviewer's installed PWA served a client build weeks out of date. The
   * mechanism is written up in `public/sw.js`; the two halves that live here
   * are:
   *
   *   ASK OFTEN ENOUGH. `registration.update()` runs when the app becomes
   *   visible and when a page is restored from the back/forward cache — i.e.
   *   every time somebody opens the installed app — not only on a timer in a
   *   document a phone stopped running hours ago.
   *
   *   ACT WHEN IT LANDS. The new worker now calls `skipWaiting()` itself, so
   *   it activates and claims this page without waiting for anything. That
   *   fires `controllerchange`, and this page then reloads INTO the build the
   *   new worker serves — automatically when Passport is idle, and behind a
   *   visible banner when it is not. It never reloads out from under a
   *   ceremony or a transaction: `criticalWorkInFlight()` is the app's own
   *   answer to that, held by the screens in `App.tsx` and `txConsent.tsx`.
   */
  useEffect(() => {
    if (!pwaRegistrationEnabled() || !('serviceWorker' in navigator)) return;

    let disposed = false;
    let updateTimer: number | undefined;
    let liveRegistration: ServiceWorkerRegistration | null = null;
    let lastCheckedAt = 0;
    /* A page with no controller is a FIRST install, and the `clients.claim()`
       that follows it fires `controllerchange` on THIS page. That one is not
       an update and must not reload anything, or every first visit would
       reload itself once for no reason.
       It is a `let` rather than a captured constant: the effect runs once, so
       a value frozen at mount would still read "never controlled" at the
       second controllerchange — the real one — and swallow it. Measured on
       2026/08/26 against two successive local builds: the worker rolled
       forward and the page kept running the old bundle. */
    let controlled = Boolean(navigator.serviceWorker.controller);

    const reloadForUpdate = () => {
      if (reloadedForUpdate.current) return;
      reloadedForUpdate.current = true;
      window.location.reload();
    };

    const inspectInstallingWorker = (registration: ServiceWorkerRegistration) => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (
          !disposed &&
          installing.state === 'installed' &&
          navigator.serviceWorker.controller
        ) {
          setUpdateRegistration(registration);
        }
      });
    };

    /* Belt and braces. The shipped worker skips waiting on its own, so this
       should never find one parked — but a worker installed by an OLDER
       `sw.js` can be, and that is precisely the state this incident was.
       Offering it is how such a client gets out on the next visit. */
    const noteWaitingWorker = (registration: ServiceWorkerRegistration) => {
      if (!disposed && registration.waiting) {
        setUpdateRegistration(registration);
        setUpdateReady(true);
      }
    };

    const checkForUpdate = () => {
      const registration = liveRegistration;
      if (!registration || document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastCheckedAt < UPDATE_CHECK_MIN_GAP_MS) return;
      lastCheckedAt = now;
      void registration
        .update()
        .then(() => noteWaitingWorker(registration))
        .catch(() => undefined);
    };

    const register = async () => {
      try {
        const registration = await navigator.serviceWorker.register('/sw.js', {
          scope: '/',
          updateViaCache: 'none',
        });
        if (disposed) return;
        liveRegistration = registration;
        lastCheckedAt = Date.now();
        noteWaitingWorker(registration);
        inspectInstallingWorker(registration);
        registration.addEventListener('updatefound', () => inspectInstallingWorker(registration));
        updateTimer = window.setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
      } catch (error) {
        console.error('Midnight Passport service worker registration failed.', error);
      }
    };

    const onControllerChange = () => {
      if (!controlled) {
        controlled = true;
        return;
      }
      // An explicit "Reload" tap wins over everything: the user asked.
      if (reloadRequested.current || !criticalWorkInFlight()) {
        reloadForUpdate();
        return;
      }
      // Mid-ceremony. The new worker is already in charge, but this document
      // keeps running the build it loaded until the user is ready.
      setUpdateReady(true);
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    /* The reviewer's question, answered: opening the app IS the update check. */
    document.addEventListener('visibilitychange', checkForUpdate);
    window.addEventListener('pageshow', checkForUpdate);
    window.addEventListener('focus', checkForUpdate);

    if (document.readyState === 'complete') {
      void register();
    } else {
      window.addEventListener('load', register, { once: true });
    }

    return () => {
      disposed = true;
      if (updateTimer) window.clearInterval(updateTimer);
      window.removeEventListener('load', register);
      document.removeEventListener('visibilitychange', checkForUpdate);
      window.removeEventListener('pageshow', checkForUpdate);
      window.removeEventListener('focus', checkForUpdate);
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    };
  }, []);

  /* --- The mobile invitation ---------------------------------------------- */

  /**
   * Android and other Chromium browsers can only be invited once the browser
   * has told us it is installable. iOS never will, so it is invited on the
   * strength of being iOS Safari — and shown instructions, not a button.
   */
  const iosInstructional = ios && isSafariBrowser();
  const installSheetEligible =
    mobile && !standalone && !installSheetSettled && (Boolean(installPrompt) || iosInstructional);

  useEffect(() => {
    if (!installSheetEligible) return;
    /**
     * The invitation may only open once the user is clear of onboarding: a
     * session exists AND no identity screen (`.mnid-screen` — the name step,
     * and Backup/Ecosystem when routed to) is on show. The session key is
     * written the moment the wallet opens, which is BEFORE the name step, so
     * the session alone is not enough — on iOS, where no install event gates
     * the sheet, it would slide over "Choose your .night name" four seconds
     * into it (observed live, 2026/08/06).
     */
    const clearToOpen = () =>
      hasPassportSession() && !document.querySelector('.mnid-screen');
    // `localStorage` fires no same-tab event, so the signal is polled rather
    // than subscribed to. The sheet opens only after the app has been clear
    // for a full INSTALL_SHEET_DELAY_MS — an identity screen appearing mid-
    // countdown resets it, so the invitation follows the flow, it never
    // interrupts one.
    let clearSince: number | undefined;
    const tick = () => {
      if (!clearToOpen()) {
        clearSince = undefined;
        return;
      }
      clearSince = clearSince ?? Date.now();
      if (Date.now() - clearSince >= INSTALL_SHEET_DELAY_MS) {
        window.clearInterval(poll);
        setInstallSheetOpen(true);
      }
    };
    const poll = window.setInterval(tick, SESSION_POLL_MS);
    tick();
    return () => window.clearInterval(poll);
  }, [installSheetEligible]);

  /** Any dismissal is permanent — no second invitation, ever. */
  const dismissInstallSheet = useCallback(() => {
    setInstallSheetOpen(false);
    setInstallSheetSettled(true);
    writeFlag(INSTALL_DISMISSED_KEY);
  }, []);

  const acceptInstall = async () => {
    if (!installPrompt) return;
    // The affirmative tap, and the only place `prompt()` is ever called from
    // on mobile.
    setInstallSheetOpen(false);
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === 'accepted') setInstallPrompt(null);
    } finally {
      setInstallSheetSettled(true);
      writeFlag(INSTALL_DISMISSED_KEY);
    }
  };

  /**
   * Notifications are unavailable to an iOS Safari tab — the API only exists
   * for an installed app from 16.4 — so the button is not offered where it
   * could only fail. A previous refusal is remembered and never revisited.
   */
  const notificationsOfferable =
    typeof Notification !== 'undefined' &&
    Notification.permission === 'default' &&
    !notificationsAsked &&
    (!ios || standalone);

  const enableNotifications = async () => {
    if (!notificationsOfferable) return;
    setNotificationsAsked(true);
    try {
      const permission = await Notification.requestPermission();
      // "Denied" and "dismissed" both mean: do not put this in front of them
      // again. Only a grant leaves the flag unwritten.
      if (permission !== 'granted') writeFlag(NOTIFICATIONS_DECLINED_KEY);
    } catch {
      writeFlag(NOTIFICATIONS_DECLINED_KEY);
    }
  };

  /**
   * The banner's button. Two cases, and both end in this document running the
   * deployed build:
   *
   *   - a worker is parked in `waiting` (only possible for one installed by an
   *     older `sw.js`): tell it to skip waiting and reload on the
   *     `controllerchange` that follows;
   *   - the new worker already claimed this page and the reload was deferred
   *     because Passport was busy: just reload.
   */
  const activateUpdate = () => {
    reloadRequested.current = true;
    setReloadingForUpdate(true);
    const waiting = updateRegistration?.waiting;
    if (!waiting) {
      window.location.reload();
      return;
    }
    waiting.postMessage({ type: 'SKIP_WAITING' });
  };

  return (
    <>
      {children}

      {!online && (
        <div className="pwa-offline-bar" role="status" aria-live="polite">
          <WifiOff size={15} aria-hidden="true" />
          <span>
            Offline shell. Sign-in, syncing, proofs, and transactions require a connection.
          </span>
        </div>
      )}

      {/* Shown only when the reload could not simply happen: Passport was in
          the middle of something, or the worker came from an older `sw.js`
          and is parked in `waiting`. It is a bar, not a modal — nothing
          behind it is blocked, and the flow underneath can be finished. */}
      {updateReady && (
        <div className="pwa-update-bar" role="status" aria-live="polite">
          <RefreshCw className={reloadingForUpdate ? 'spin' : undefined} size={15} aria-hidden="true" />
          <span>A new version of Passport is ready.</span>
          <button type="button" onClick={activateUpdate} disabled={reloadingForUpdate}>
            {reloadingForUpdate ? 'Reloading' : 'Reload'}
          </button>
        </div>
      )}

      <div className="pwa-actions" aria-live="polite">
        {updateRegistration && !updateReady && (
          <button
            type="button"
            className="pwa-action"
            onClick={activateUpdate}
            disabled={reloadingForUpdate}
          >
            <RefreshCw className={reloadingForUpdate ? 'spin' : undefined} size={15} />
            {reloadingForUpdate ? 'Updating' : 'Update Passport'}
          </button>
        )}
        {/* THE CORNER BUTTON WENT ON 2026/09/03. Installing is offered from
            Home's top bar now (`screens/InstallPassport.tsx`), where a person
            looks for it and on every browser that can do it rather than only a
            desktop-width Chromium one. A second button saying the same thing
            in the corner of the same screen is one too many. */}
      </div>

      {installSheetOpen && (
        <>
          <div
            className="pwainstall-scrim"
            role="presentation"
            onClick={dismissInstallSheet}
          />
          <section
            className="pwainstall-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pwainstall-title"
          >
            <span className="pwainstall-grip" aria-hidden="true" />

            <header className="pwainstall-head">
              <span className="pwainstall-mark" aria-hidden="true">
                <SquarePlus size={20} strokeWidth={2} />
              </span>
              <div>
                <h2 id="pwainstall-title">Add Passport to your home screen</h2>
                <p>
                  It opens full-screen, keeps you signed in, and is one tap away
                  next time.
                </p>
              </div>
            </header>

            {iosInstructional && !installPrompt ? (
              /* iOS fires no install event, so the only honest thing to offer
                 is the two taps the user has to make themselves. */
              <ol className="pwainstall-steps">
                <li>
                  <Share size={16} strokeWidth={2} aria-hidden="true" />
                  <span>Tap the Share button in Safari&rsquo;s toolbar.</span>
                </li>
                <li>
                  <SquarePlus size={16} strokeWidth={2} aria-hidden="true" />
                  <span>Choose &ldquo;Add to Home Screen&rdquo;.</span>
                </li>
              </ol>
            ) : null}

            <div className="pwainstall-actions">
              {installPrompt ? (
                <button
                  type="button"
                  className="pwainstall-primary"
                  onClick={() => void acceptInstall()}
                >
                  <Download size={17} strokeWidth={2} aria-hidden="true" />
                  Add to home screen
                </button>
              ) : null}

              {notificationsOfferable ? (
                <button
                  type="button"
                  className="pwainstall-secondary"
                  onClick={() => void enableNotifications()}
                >
                  <Bell size={16} strokeWidth={2} aria-hidden="true" />
                  Enable notifications
                </button>
              ) : null}

              <button
                type="button"
                className="pwainstall-secondary"
                onClick={dismissInstallSheet}
              >
                Not now
              </button>
            </div>

            <p className="pwainstall-note">
              Asked once. Dismiss it and Passport will not bring it up again.
            </p>
          </section>
        </>
      )}
    </>
  );
}
