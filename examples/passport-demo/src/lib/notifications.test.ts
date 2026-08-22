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
