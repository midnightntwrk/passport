/**
 * A `window` with just enough of a browser in it for the redirect entry point.
 *
 * There is no jsdom in this package. What the redirect module actually touches
 * is four things — `location`, `history.replaceState`, `sessionStorage`, and
 * `localStorage` — and every one of them has a failure mode that matters and
 * that a real DOM will not reproduce on demand: Safari in private mode THROWS
 * on storage access, a page served from `file:` refuses `replaceState`, and a
 * page rendered on a server has no `window` at all. A stub is the only way to
 * drill those, and they are exactly the paths a flow written for a phone has
 * to survive.
 */

class MemoryStorage implements Storage {
  private readonly entries = new Map<string, string>();

  get length(): number {
    return this.entries.size;
  }
  clear(): void {
    this.entries.clear();
  }
  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.entries.delete(key);
  }
  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
}

export interface FakeDomOptions {
  /** Models Safari in private mode: the accessor itself throws. */
  readonly sessionStorageThrows?: boolean;
  readonly localStorageThrows?: boolean;
  /** Models a full quota: the accessor works, the operation does not. */
  readonly storageOperationsThrow?: boolean;
  /** Models a `file:` page, or a browser that refuses the call. */
  readonly replaceStateThrows?: boolean;
  readonly href?: string;
}

export interface FakeDom {
  readonly location: { hash: string; search: string; pathname: string };
  navigate(href: string): void;
}

/** Installs the stub as the global `window`, and returns the teardown. */
export function installFakeDom(options: FakeDomOptions = {}): FakeDom {
  const url = new URL(options.href ?? 'https://doorman.example/');
  const location = { hash: url.hash, search: url.search, pathname: url.pathname };
  const refusing: Storage = {
    length: 0,
    clear() {
      throw new Error('the quota is exhausted');
    },
    getItem() {
      throw new Error('the quota is exhausted');
    },
    key() {
      throw new Error('the quota is exhausted');
    },
    removeItem() {
      throw new Error('the quota is exhausted');
    },
    setItem() {
      throw new Error('the quota is exhausted');
    },
  };
  const session = options.storageOperationsThrow ? refusing : new MemoryStorage();
  const local = options.storageOperationsThrow ? refusing : new MemoryStorage();

  const stub = {
    location,
    history: {
      replaceState(_state: unknown, _title: string, next: string) {
        if (options.replaceStateThrows) throw new Error('replaceState is not available here');
        const parsed = new URL(next, 'https://doorman.example');
        location.hash = parsed.hash;
        location.search = parsed.search;
        location.pathname = parsed.pathname;
      },
    },
    get sessionStorage(): Storage {
      if (options.sessionStorageThrows) throw new Error('storage is not available here');
      return session;
    },
    get localStorage(): Storage {
      if (options.localStorageThrows) throw new Error('storage is not available here');
      return local;
    },
  };

  (globalThis as { window?: unknown }).window = stub;
  return {
    location,
    navigate(href: string) {
      const parsed = new URL(href, 'https://doorman.example');
      location.hash = parsed.hash;
      location.search = parsed.search;
      location.pathname = parsed.pathname;
    },
  };
}

export function removeFakeDom(): void {
  delete (globalThis as { window?: unknown }).window;
}
