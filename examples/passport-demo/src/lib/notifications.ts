/**
 * System notifications for the events Passport observes while it is open.
 *
 * SCOPE, STATED PLAINLY (agreed 2026/08/20)
 * -----------------------------------------
 * This module is the **Notification API** path and nothing else. Passport
 * raises a notification for something IT has just seen on its own live wallet
 * stream, from a tab that is running. That covers the phone lying on the desk
 * with Passport installed and backgrounded — the case the demo needs — and it
 * works on Android Chrome and on desktop Chrome, Edge, Firefox, and Safari.
 *
 * It is NOT background Web Push, and must not be described as such:
 *
 * - A Passport whose tab is CLOSED gets nothing. No server is watching the
 *   chain on the user's behalf; the observation happens in the page or not at
 *   all.
 * - An iOS Safari TAB gets nothing at all — `Notification` is simply absent
 *   there, and the Home control hides itself accordingly. An iOS home-screen
 *   web app on 16.4 or later can be granted permission and can show one
 *   through its service worker while it is running, so the paths below do
 *   cover it, but only while it is running. Nothing here survives the app
 *   being closed on any platform.
 *
 * The half a real background push would need, so the gap reads as a size
 * rather than a shrug:
 *
 * - `public/sw.js` gains `push` and `pushsubscriptionchange` handlers. It has
 *   neither today, deliberately — its `notificationclick` handler serves the
 *   notifications THIS module shows through the worker, and nothing more.
 * - The client calls `registration.pushManager.subscribe()` with the server's
 *   VAPID public key, then posts the resulting endpoint and its `p256dh` and
 *   `auth` keys somewhere durable.
 * - That server keeps a subscription set per Passport, signs a VAPID JWT per
 *   delivery, encrypts every payload under RFC 8291, POSTs it to the push
 *   service, and drops subscriptions the service answers 404 or 410 for.
 * - Something server-side has to WATCH the chain per address, because a closed
 *   tab cannot watch it for itself. That is the real cost of the feature: an
 *   indexer subscription for every registered Passport, and a decision about
 *   holding the addresses needed to run it — which is precisely the privacy
 *   decision this demo has not taken.
 *
 * The mute switch
 * ---------------
 * Browser permission is one-way: a page can ask, and only the browser's own
 * settings can take the answer back. So a granted permission is paired with a
 * local preference here, and {@link notify} honours both. That is what lets
 * the Home control be a real toggle rather than a button that can only ever be
 * pressed once.
 */

/**
 * Permission as this app cares about it. `unsupported` is kept distinct from
 * `denied`: one is a browser that cannot, the other is a user who said no, and
 * the control says a different sentence for each.
 */
export type NotificationPermissionState = 'unsupported' | 'default' | 'granted' | 'denied';

/** What the Home control renders from. */
export interface NotificationsState {
  permission: NotificationPermissionState;
  /**
   * The local mute switch. Meaningful only alongside a granted permission —
   * `true` with `permission: 'default'` just means nothing has been muted yet.
   */
  enabled: boolean;
  /** `permission === 'granted' && enabled`: the one condition {@link notify} obeys. */
  active: boolean;
}

export interface NotifyOptions {
  /**
   * Collapses successive notifications about the same subject into one entry
   * in the shade, rather than stacking a tray full of them. A tagged
   * notification still re-alerts when it is replaced.
   */
  tag?: string;
  /** Overrides the Passport icon. Absolute path from the site root. */
  icon?: string;
}

/** localStorage key for the mute switch. Stable — do not rename without a migration. */
export const NOTIFICATIONS_STORAGE_KEY = 'passport-notifications';

/** Precached by the service worker, so the shade has art even offline. */
const PASSPORT_ICON = '/icons/passport-192.png';

type Listener = (state: NotificationsState) => void;

const listeners = new Set<Listener>();

let permissionStatusBound = false;

/**
 * The constructor, or null where there is none — a non-secure origin, an
 * iOS Safari tab, a worker, or the node process the tests run in. Read fresh
 * every time rather than cached at import: the tests swap it, and a module
 * that snapshotted it at load would answer for the wrong global.
 */
function notificationApi(): typeof Notification | null {
  const api = (globalThis as { Notification?: typeof Notification }).Notification;
  return typeof api === 'function' ? api : null;
}

function storage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    /* Private mode, or storage disabled by policy. The preference simply does
       not persist; notifications still work for the life of the session. */
    return null;
  }
}

/** True when this browser can raise a notification at all. */
export function notificationsSupported(): boolean {
  return notificationApi() !== null;
}

/** The browser's answer, normalised. Never throws. */
export function notificationPermission(): NotificationPermissionState {
  const api = notificationApi();
  if (!api) return 'unsupported';
  const value = api.permission;
  if (value === 'granted' || value === 'denied' || value === 'default') return value;
  /* A browser reporting something outside the enum is treated as never having
     been asked, which is the only reading that leads anywhere useful. */
  return 'default';
}

/**
 * The mute switch. Defaults to ON, because granting permission is itself the
 * opt-in — a user who has just said yes should not have to say it twice.
 */
export function notificationsEnabled(): boolean {
  return storage()?.getItem(NOTIFICATIONS_STORAGE_KEY) !== 'off';
}

export function notificationsState(): NotificationsState {
  const permission = notificationPermission();
  const enabled = notificationsEnabled();
  return { permission, enabled, active: permission === 'granted' && enabled };
}

function notifyListeners(): void {
  const state = notificationsState();
  for (const listener of listeners) listener(state);
}

/**
 * Some browsers report a permission changed in site settings through the
 * Permissions API; none report it any other way. Where the query is refused —
 * Safari has historically thrown on the 'notifications' name — the control
 * simply keeps whatever it last read, which is no worse than the alternative.
 */
function bindPermissionChanges(): void {
  if (permissionStatusBound) return;
  const permissions = (globalThis as { navigator?: Navigator }).navigator?.permissions;
  if (!permissions || typeof permissions.query !== 'function') return;
  permissionStatusBound = true;
  try {
    void permissions
      .query({ name: 'notifications' as PermissionName })
      .then((status) => {
        status.addEventListener?.('change', () => notifyListeners());
      })
      .catch(() => undefined);
  } catch {
    /* A synchronous throw from query() itself. Same outcome as a rejection. */
  }
}

/** Records the mute switch and tells subscribers. Returns the state it left behind. */
export function setNotificationsEnabled(enabled: boolean): NotificationsState {
  try {
    storage()?.setItem(NOTIFICATIONS_STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    /* See storage(). */
  }
  notifyListeners();
  return notificationsState();
}

/** Subscribes to permission and mute changes. Returns the unsubscribe function. */
export function subscribeToNotifications(listener: Listener): () => void {
  listeners.add(listener);
  bindPermissionChanges();
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Asks the browser for permission.
 *
 * MUST be called from a user gesture — every browser requires it, and Chrome
 * additionally holds the whole origin's permission-request budget against
 * pages that ask without one. The Home control is the only caller.
 *
 * An already-answered permission is returned WITHOUT asking again. That is not
 * an optimisation: a denied origin cannot be re-prompted from script, so a
 * caller that retried would spin forever against a browser that had already
 * decided. The control shows the browser-settings sentence instead.
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  const api = notificationApi();
  if (!api) return 'unsupported';

  const current = notificationPermission();
  if (current !== 'default') return current;

  let answer: NotificationPermissionState;
  try {
    answer = await new Promise<NotificationPermissionState>((resolve) => {
      /* Two shapes in the wild: the promise this standardised on, and Safari's
         original callback. Calling with the callback satisfies both — the
         return value is a promise where there is one, and undefined where the
         callback is the only channel. `resolve` after the first settle is a
         no-op, so a browser honouring both cannot double-report. */
      const returned = api.requestPermission((value) =>
        resolve(value as NotificationPermissionState),
      );
      if (returned && typeof returned.then === 'function') {
        void returned.then(
          (value) => resolve(value as NotificationPermissionState),
          () => resolve(notificationPermission()),
        );
      }
    });
  } catch {
    /* A browser that refused the request outright. Read back whatever it holds
       rather than claiming an answer it never gave. */
    answer = notificationPermission();
  }

  /* Granting is the opt-in, so it clears any mute left over from a previous
     grant on this origin. Nothing else about the preference is touched. */
  if (answer === 'granted') setNotificationsEnabled(true);
  else notifyListeners();
  bindPermissionChanges();
  return answer;
}

/**
 * Raises one notification, through whichever channel this browser allows.
 *
 * The constructor is tried first because it is the one that can focus the tab
 * on click. Android Chrome forbids it outright wherever a service worker is
 * registered — "Illegal constructor. Use
 * ServiceWorkerRegistration.showNotification() instead" — and Passport always
 * registers one, so the worker path below is not a fallback on that platform
 * but the whole of it. Clicks on that path are handled by `notificationclick`
 * in `public/sw.js`.
 *
 * Resolves `true` only when a notification was genuinely shown. It never
 * throws and never rejects: a caller is announcing something that already
 * happened on chain, and a shade that would not open is not a reason to fail
 * the thing being announced.
 */
export async function notify(
  title: string,
  body: string,
  options: NotifyOptions = {},
): Promise<boolean> {
  if (!notificationsState().active) return false;

  const init: NotificationOptions = {
    body,
    icon: options.icon ?? PASSPORT_ICON,
    ...(options.tag ? { tag: options.tag, renotify: true } : {}),
  };

  const api = notificationApi();
  if (api) {
    try {
      const shown = new api(title, init);
      shown.onclick = () => {
        try {
          (globalThis as { focus?: () => void }).focus?.();
        } catch {
          /* A browser that refuses the focus has still dismissed the shade. */
        }
        shown.close();
      };
      return true;
    } catch {
      /* Android Chrome, as above. Fall through to the worker. */
    }
  }

  try {
    const container = (globalThis as { navigator?: Navigator }).navigator?.serviceWorker;
    if (!container) return false;
    const registration = await container.getRegistration();
    if (!registration) return false;
    await registration.showNotification(title, init);
    return true;
  } catch {
    return false;
  }
}

/**
 * Drops every subscriber and unbinds the Permissions API listener flag.
 * Test seam only — nothing in the app needs it, because the module's state is
 * the browser's, not its own.
 */
export function resetNotificationsForTest(): void {
  listeners.clear();
  permissionStatusBound = false;
}
