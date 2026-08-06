import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Bell, Download, RefreshCw, Share, SquarePlus, WifiOff } from 'lucide-react';

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
  const [reloadingForUpdate, setReloadingForUpdate] = useState(false);
  const [standalone, setStandalone] = useState(isStandaloneDisplay);
  const reloadOnControllerChange = useRef(false);
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

  useEffect(() => {
    if (!pwaRegistrationEnabled() || !('serviceWorker' in navigator)) return;

    let disposed = false;
    let updateTimer: number | undefined;

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

    const register = async () => {
      try {
        const registration = await navigator.serviceWorker.register('/sw.js', {
          scope: '/',
          updateViaCache: 'none',
        });
        if (disposed) return;
        if (registration.waiting) setUpdateRegistration(registration);
        inspectInstallingWorker(registration);
        registration.addEventListener('updatefound', () => inspectInstallingWorker(registration));
        updateTimer = window.setInterval(() => void registration.update(), 60 * 60 * 1_000);
      } catch (error) {
        console.error('Midnight Passport service worker registration failed.', error);
      }
    };

    const onControllerChange = () => {
      if (reloadOnControllerChange.current) window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    if (document.readyState === 'complete') {
      void register();
    } else {
      window.addEventListener('load', register, { once: true });
    }

    return () => {
      disposed = true;
      if (updateTimer) window.clearInterval(updateTimer);
      window.removeEventListener('load', register);
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    };
  }, []);

  const install = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === 'accepted') setInstallPrompt(null);
  };

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
    let delay: number | undefined;
    // `localStorage` fires no same-tab event, so the session signal is polled
    // rather than subscribed to. The poll stops the moment it is satisfied.
    const arm = () => {
      if (delay !== undefined || !hasPassportSession()) return;
      window.clearInterval(poll);
      // Deliberately late even then: it follows the session, it does not
      // interrupt it.
      delay = window.setTimeout(() => setInstallSheetOpen(true), INSTALL_SHEET_DELAY_MS);
    };
    const poll = window.setInterval(arm, SESSION_POLL_MS);
    arm();
    return () => {
      window.clearInterval(poll);
      if (delay !== undefined) window.clearTimeout(delay);
    };
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

  const activateUpdate = () => {
    const waiting = updateRegistration?.waiting;
    if (!waiting) return;
    reloadOnControllerChange.current = true;
    setReloadingForUpdate(true);
    waiting.postMessage({ type: 'SKIP_WAITING' });
  };

  return (
    <>
      {children}

      {!online && (
        <div className="pwa-offline-bar" role="status" aria-live="polite">
          <WifiOff size={15} aria-hidden="true" />
          <span>
            Offline shell. Sign-in, wallet sync, proofs, and transactions require a connection.
          </span>
        </div>
      )}

      <div className="pwa-actions" aria-live="polite">
        {updateRegistration && (
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
        {/* Desktop keeps the quiet corner button. On mobile the sheet is the
            invitation, and two competing install affordances is one too many. */}
        {installPrompt && !standalone && !mobile && (
          <button type="button" className="pwa-action" onClick={() => void install()}>
            <Download size={15} />
            Install Passport
          </button>
        )}
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
