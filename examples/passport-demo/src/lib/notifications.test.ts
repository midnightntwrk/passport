/**
 * Unit tests for the notifications module's decisions.
 *
 * Two things are worth testing here and nothing else is: what the module
 * believes the permission to be, and the promise that {@link notify} is silent
 * whenever it has not been told it may speak. The shade itself is the
 * browser's, and a test that asserted a real notification appeared would only
 * be asserting that the fake it installed was called.
 *
 * The fake `Notification` is installed on `globalThis` rather than a `window`,
 * because the repo's vitest setup runs in node and the module reads the global
 * for exactly that reason.
 *
 * Run from the workspace root: `npx vitest run examples/passport-demo/src/lib`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NOTIFICATIONS_STORAGE_KEY,
  notificationPermission,
  notificationsEnabled,
  notificationsState,
  notificationsSupported,
  notify,
  requestNotificationPermission,
  resetNotificationsForTest,
  setNotificationsEnabled,
  subscribeToNotifications,
} from './notifications.js';

type Constructed = { title: string; init: NotificationOptions | undefined };

/**
 * The smallest thing that satisfies the module: a constructor with a static
 * `permission` and `requestPermission`. `answer` is what a prompt would
 * resolve to; `shape` picks which of the two `requestPermission` conventions
 * the fake speaks.
 */
function installNotification(options: {
  permission: string;
  answer?: string;
  shape?: 'promise' | 'callback' | 'both' | 'throws';
  constructorThrows?: boolean;
}): { constructed: Constructed[]; requests: number } {
  const constructed: Constructed[] = [];
  const record = { requests: 0 };

  class FakeNotification {
    static permission = options.permission;

    static requestPermission(callback?: (value: string) => void): Promise<string> | undefined {
      record.requests += 1;
      const answer = options.answer ?? 'granted';
      const shape = options.shape ?? 'promise';
      if (shape === 'throws') throw new Error('refused');
      FakeNotification.permission = answer;
      if (shape === 'callback') {
        callback?.(answer);
        return undefined;
      }
      if (shape === 'both') callback?.(answer);
      return Promise.resolve(answer);
    }

    onclick: (() => void) | null = null;

    constructor(title: string, init?: NotificationOptions) {
      if (options.constructorThrows) {
        throw new TypeError('Illegal constructor. Use ServiceWorkerRegistration.showNotification()');
      }
      constructed.push({ title, init });
    }

    close(): void {}
  }

  Object.defineProperty(globalThis, 'Notification', {
    value: FakeNotification,
    configurable: true,
    writable: true,
  });
  return { constructed, requests: record.requests as number };
}

/** A localStorage good enough for one key. */
function installStorage(seed: Record<string, string> = {}): Map<string, string> {
  const map = new Map(Object.entries(seed));
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    },
    configurable: true,
    writable: true,
  });
  return map;
}

function clearGlobals(): void {
  for (const key of ['Notification', 'localStorage', 'navigator']) {
    if (key in globalThis) {
      Object.defineProperty(globalThis, key, {
        value: undefined,
        configurable: true,
        writable: true,
      });
    }
  }
}

beforeEach(() => {
  resetNotificationsForTest();
  clearGlobals();
  installStorage();
});

afterEach(() => {
  resetNotificationsForTest();
  clearGlobals();
});

describe('notificationPermission', () => {
  it('reports unsupported when the API is absent entirely', () => {
    expect(notificationsSupported()).toBe(false);
    expect(notificationPermission()).toBe('unsupported');
  });

  it('reports unsupported when Notification is present but is not a constructor', () => {
    Object.defineProperty(globalThis, 'Notification', {
      value: { permission: 'granted' },
      configurable: true,
      writable: true,
    });
    expect(notificationsSupported()).toBe(false);
    expect(notificationPermission()).toBe('unsupported');
  });

  it('passes each of the three real answers through', () => {
    for (const permission of ['default', 'granted', 'denied'] as const) {
      installNotification({ permission });
      expect(notificationPermission()).toBe(permission);
    }
  });

  it('treats a value outside the enum as never having been asked', () => {
    installNotification({ permission: 'wat' });
    expect(notificationPermission()).toBe('default');
  });

  it('re-reads the global rather than a value cached at import', () => {
    installNotification({ permission: 'default' });
    expect(notificationPermission()).toBe('default');
    installNotification({ permission: 'granted' });
    expect(notificationPermission()).toBe('granted');
  });
});

describe('notificationsState', () => {
  it('is active only when permission is granted and nothing is muted', () => {
    installNotification({ permission: 'granted' });
    expect(notificationsState()).toEqual({
      permission: 'granted',
      enabled: true,
      active: true,
    });
  });

  it('is inactive while muted, even with permission granted', () => {
    installNotification({ permission: 'granted' });
    installStorage({ [NOTIFICATIONS_STORAGE_KEY]: 'off' });
    expect(notificationsState()).toEqual({
      permission: 'granted',
      enabled: false,
      active: false,
    });
  });

  it('is inactive on a granted-but-absent API, so `enabled` alone never speaks', () => {
    installStorage({ [NOTIFICATIONS_STORAGE_KEY]: 'on' });
    expect(notificationsState().active).toBe(false);
  });

  it('defaults to unmuted when nothing has been recorded', () => {
    expect(notificationsEnabled()).toBe(true);
  });

  it('survives storage being unreadable', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      get() {
        throw new Error('storage disabled by policy');
      },
      configurable: true,
    });
    installNotification({ permission: 'granted' });
    expect(() => notificationsState()).not.toThrow();
    expect(notificationsState().active).toBe(true);
    expect(() => setNotificationsEnabled(false)).not.toThrow();
  });
});

describe('setNotificationsEnabled', () => {
  it('records the switch and tells subscribers', () => {
    installNotification({ permission: 'granted' });
    const seen: boolean[] = [];
    const unsubscribe = subscribeToNotifications((state) => seen.push(state.active));

    setNotificationsEnabled(false);
    expect(notificationsEnabled()).toBe(false);
    setNotificationsEnabled(true);
    expect(notificationsEnabled()).toBe(true);

    expect(seen).toEqual([false, true]);
    unsubscribe();
    setNotificationsEnabled(false);
    expect(seen).toEqual([false, true]);
  });
});

describe('requestNotificationPermission', () => {
  it('answers unsupported without inventing a prompt', async () => {
    await expect(requestNotificationPermission()).resolves.toBe('unsupported');
  });

  it('prompts a browser that has never been asked, and reports the grant', async () => {
    installNotification({ permission: 'default', answer: 'granted' });
    const request = vi.spyOn(globalThis.Notification, 'requestPermission');
    await expect(requestNotificationPermission()).resolves.toBe('granted');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('understands the callback-only convention', async () => {
    installNotification({ permission: 'default', answer: 'granted', shape: 'callback' });
    await expect(requestNotificationPermission()).resolves.toBe('granted');
  });

  it('settles once when a browser honours both conventions', async () => {
    installNotification({ permission: 'default', answer: 'denied', shape: 'both' });
    await expect(requestNotificationPermission()).resolves.toBe('denied');
  });

  it('never re-prompts a denied origin', async () => {
    installNotification({ permission: 'denied' });
    const request = vi.spyOn(globalThis.Notification, 'requestPermission');
    await expect(requestNotificationPermission()).resolves.toBe('denied');
    await expect(requestNotificationPermission()).resolves.toBe('denied');
    expect(request).not.toHaveBeenCalled();
  });

  it('does not re-prompt an origin that already granted', async () => {
    installNotification({ permission: 'granted' });
    const request = vi.spyOn(globalThis.Notification, 'requestPermission');
    await expect(requestNotificationPermission()).resolves.toBe('granted');
    expect(request).not.toHaveBeenCalled();
  });

  it('reads the permission back when the request itself throws', async () => {
    installNotification({ permission: 'default', shape: 'throws' });
    await expect(requestNotificationPermission()).resolves.toBe('default');
  });

  it('clears a stale mute when permission is granted afresh', async () => {
    installNotification({ permission: 'default', answer: 'granted' });
    installStorage({ [NOTIFICATIONS_STORAGE_KEY]: 'off' });
    await requestNotificationPermission();
    expect(notificationsState().active).toBe(true);
  });

  it('leaves the mute alone when the answer is no', async () => {
    installNotification({ permission: 'default', answer: 'denied' });
    installStorage({ [NOTIFICATIONS_STORAGE_KEY]: 'off' });
    await requestNotificationPermission();
    expect(notificationsEnabled()).toBe(false);
  });
});

describe('notify', () => {
  it('no-ops when the API is absent', async () => {
    await expect(notify('Title', 'Body')).resolves.toBe(false);
  });

  it('no-ops on a permission never asked for', async () => {
    const { constructed } = installNotification({ permission: 'default' });
    await expect(notify('Title', 'Body')).resolves.toBe(false);
    expect(constructed).toHaveLength(0);
  });

  it('no-ops on a denied permission', async () => {
    const { constructed } = installNotification({ permission: 'denied' });
    await expect(notify('Title', 'Body')).resolves.toBe(false);
    expect(constructed).toHaveLength(0);
  });

  it('no-ops while muted, even though the browser would allow it', async () => {
    const { constructed } = installNotification({ permission: 'granted' });
    installStorage({ [NOTIFICATIONS_STORAGE_KEY]: 'off' });
    await expect(notify('Title', 'Body')).resolves.toBe(false);
    expect(constructed).toHaveLength(0);
  });

  it('never asks for permission of its own accord', async () => {
    installNotification({ permission: 'default' });
    const request = vi.spyOn(globalThis.Notification, 'requestPermission');
    await notify('Title', 'Body');
    expect(request).not.toHaveBeenCalled();
  });

  it('shows the notification when granted, with the Passport icon', async () => {
    const { constructed } = installNotification({ permission: 'granted' });
    await expect(notify('NIGHT received', '5 NIGHT arrived.')).resolves.toBe(true);
    expect(constructed).toHaveLength(1);
    expect(constructed[0]?.title).toBe('NIGHT received');
    expect(constructed[0]?.init?.body).toBe('5 NIGHT arrived.');
    expect(constructed[0]?.init?.icon).toBe('/icons/passport-192.png');
  });

  it('passes a tag through and leaves it off when none was given', async () => {
    const { constructed } = installNotification({ permission: 'granted' });
    await notify('A', 'B', { tag: 'passport-night-received' });
    await notify('C', 'D');
    expect(constructed[0]?.init?.tag).toBe('passport-night-received');
    expect(constructed[1]?.init?.tag).toBeUndefined();
  });

  it('falls back to the service worker when the constructor is forbidden', async () => {
    installNotification({ permission: 'granted', constructorThrows: true });
    const showNotification = vi.fn(async () => undefined);
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        serviceWorker: { getRegistration: async () => ({ showNotification }) },
      },
      configurable: true,
      writable: true,
    });
    await expect(notify('Name registered', 'alice.night is yours.')).resolves.toBe(true);
    expect(showNotification).toHaveBeenCalledWith('Name registered', {
      body: 'alice.night is yours.',
      icon: '/icons/passport-192.png',
    });
  });

  it('reports failure rather than throwing when neither channel works', async () => {
    installNotification({ permission: 'granted', constructorThrows: true });
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        serviceWorker: {
          getRegistration: async () => {
            throw new Error('no worker here');
          },
        },
      },
      configurable: true,
      writable: true,
    });
    await expect(notify('Title', 'Body')).resolves.toBe(false);
  });

  it('reports failure when the constructor is forbidden and no worker is registered', async () => {
    installNotification({ permission: 'granted', constructorThrows: true });
    Object.defineProperty(globalThis, 'navigator', {
      value: { serviceWorker: { getRegistration: async () => undefined } },
      configurable: true,
      writable: true,
    });
    await expect(notify('Title', 'Body')).resolves.toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The paths a browser takes and a happy desktop does not                      */
/* -------------------------------------------------------------------------- */

/** A `localStorage` that throws on ACCESS — private mode, or disabled by policy. */
function installUnreachableStorage(): void {
  Object.defineProperty(globalThis, 'localStorage', {
    get() {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
    configurable: true,
  });
}

/** A `localStorage` that exists but refuses to write — a full or partitioned quota. */
function installReadOnlyStorage(): void {
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      },
      removeItem: () => {},
    },
    configurable: true,
    writable: true,
  });
}

describe('storage that is not there, or will not take a write', () => {
  it('keeps working when reading localStorage throws outright', () => {
    installUnreachableStorage();
    installNotification({ permission: 'granted' });
    // The preference simply does not persist. The default is ON, so a granted
    // permission is still an active one.
    expect(notificationsEnabled()).toBe(true);
    expect(notificationsState().active).toBe(true);
  });

  it('keeps working where there is no localStorage property at all', () => {
    // A worker, or the node process these tests run in before anything is
    // installed. `storage()` answers null and the default preference stands.
    Reflect.deleteProperty(globalThis, 'localStorage');
    installNotification({ permission: 'granted' });
    expect(notificationsEnabled()).toBe(true);
    expect(setNotificationsEnabled(false).enabled).toBe(true);
  });

  it('still tells subscribers when the write is refused', () => {
    installReadOnlyStorage();
    installNotification({ permission: 'granted' });
    const seen: boolean[] = [];
    const unsubscribe = subscribeToNotifications((state) => seen.push(state.active));
    // The mute is lost for the next session, and said out loud for this one.
    const state = setNotificationsEnabled(false);
    expect(state.enabled).toBe(true);
    expect(seen).toEqual([true]);
    unsubscribe();
  });
});

describe('the Permissions API listener', () => {
  /** A `navigator.permissions` whose `query` behaves as `shape` says. */
  function installPermissions(shape: 'resolves' | 'rejects' | 'throws' | 'absent' | 'not-a-function'): {
    listeners: (() => void)[];
    queries: number;
  } {
    const listeners: (() => void)[] = [];
    const record = { queries: 0 };
    const permissions =
      shape === 'absent'
        ? undefined
        : {
            query: shape === 'not-a-function'
              ? 'nope'
              : () => {
                  record.queries += 1;
                  if (shape === 'throws') throw new Error('unsupported permission name');
                  if (shape === 'rejects') return Promise.reject(new Error('refused'));
                  return Promise.resolve({
                    addEventListener: (_name: string, listener: () => void) => {
                      listeners.push(listener);
                    },
                  });
                },
          };
    Object.defineProperty(globalThis, 'navigator', {
      value: { permissions },
      configurable: true,
      writable: true,
    });
    return { listeners, get queries() { return record.queries; } };
  }

  it('re-reports state when the browser says the permission changed', async () => {
    installNotification({ permission: 'granted' });
    const permissions = installPermissions('resolves');
    const seen: string[] = [];
    const unsubscribe = subscribeToNotifications((state) => seen.push(state.permission));
    // The query is asynchronous; the listener is attached once it settles.
    await Promise.resolve();
    expect(permissions.listeners).toHaveLength(1);

    // The user revoked it in site settings — the only channel that reports this.
    installNotification({ permission: 'denied' });
    permissions.listeners[0]?.();
    expect(seen).toEqual(['denied']);
    unsubscribe();
  });

  it('binds exactly once however many subscribers arrive', async () => {
    installNotification({ permission: 'granted' });
    const permissions = installPermissions('resolves');
    const first = subscribeToNotifications(() => {});
    const second = subscribeToNotifications(() => {});
    await Promise.resolve();
    expect(permissions.queries).toBe(1);
    first();
    second();
  });

  it('carries on when the query rejects, throws, or is simply absent', async () => {
    /* Safari has historically thrown on the 'notifications' name. The control
       keeps whatever it last read, which is no worse than the alternative. */
    for (const shape of ['rejects', 'throws', 'absent', 'not-a-function'] as const) {
      resetNotificationsForTest();
      installNotification({ permission: 'granted' });
      installPermissions(shape);
      const unsubscribe = subscribeToNotifications(() => {});
      await Promise.resolve();
      expect(notificationsState().active).toBe(true);
      unsubscribe();
    }
  });

  it('does not look for a Permissions API where there is no navigator', () => {
    installNotification({ permission: 'granted' });
    const unsubscribe = subscribeToNotifications(() => {});
    expect(notificationsState().permission).toBe('granted');
    unsubscribe();
  });
});

describe('what a click on the notification does', () => {
  /** A Notification fake that hands back the instance, so its `onclick` can be run. */
  function installClickableNotification(): { shown: { onclick: (() => void) | null; closed: boolean }[] } {
    const shown: { onclick: (() => void) | null; closed: boolean }[] = [];
    class ClickableNotification {
      static permission = 'granted';
      static requestPermission(): Promise<string> {
        return Promise.resolve('granted');
      }
      onclick: (() => void) | null = null;
      closed = false;
      constructor() {
        shown.push(this);
      }
      close(): void {
        this.closed = true;
      }
    }
    Object.defineProperty(globalThis, 'Notification', {
      value: ClickableNotification,
      configurable: true,
      writable: true,
    });
    return { shown };
  }

  it('focuses the tab and closes the shade', async () => {
    const { shown } = installClickableNotification();
    const focus = vi.fn();
    Object.defineProperty(globalThis, 'focus', { value: focus, configurable: true, writable: true });

    await expect(notify('Name registered', 'alice.night is yours.')).resolves.toBe(true);
    expect(shown).toHaveLength(1);

    // The constructor path is the one that can focus the tab — which is why it
    // is tried before the worker, even where the worker would also work.
    shown[0]?.onclick?.();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(shown[0]?.closed).toBe(true);
    Reflect.deleteProperty(globalThis, 'focus');
  });

  it('still closes the shade when the browser refuses the focus', async () => {
    const { shown } = installClickableNotification();
    Object.defineProperty(globalThis, 'focus', {
      value: () => {
        throw new Error('focus is not allowed here');
      },
      configurable: true,
      writable: true,
    });
    await notify('Title', 'Body');
    expect(() => shown[0]?.onclick?.()).not.toThrow();
    expect(shown[0]?.closed).toBe(true);
    Reflect.deleteProperty(globalThis, 'focus');
  });

  it('closes the shade in a context with no focus at all', async () => {
    const { shown } = installClickableNotification();
    Reflect.deleteProperty(globalThis, 'focus');
    await notify('Title', 'Body');
    shown[0]?.onclick?.();
    expect(shown[0]?.closed).toBe(true);
  });
});

describe('the worker path', () => {
  it('reports failure where there is no service-worker container at all', async () => {
    // An iOS Safari tab: no constructor, and no worker to fall back to.
    installNotification({ permission: 'granted', constructorThrows: true });
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      configurable: true,
      writable: true,
    });
    await expect(notify('Title', 'Body')).resolves.toBe(false);
  });
});
