/**
 * A window the transports can be driven against.
 *
 * There is no jsdom in this package and there deliberately is not one: the
 * things worth drilling here are the ORIGIN GATE, the SOURCE GATE, and the
 * pair matching, and all three are decided from three fields of a message
 * event. A fake that lets a test deliver a message claiming any origin and any
 * source exercises them far more directly than a real DOM would — a real DOM
 * would not let a test forge either field, which is the whole point of them.
 */

export interface FakePeer {
  /** Everything posted to this peer, in order. */
  readonly posts: { message: unknown; targetOrigin: string }[];
  postMessage(message: unknown, targetOrigin: string): void;
  closed: boolean;
  focus(): void;
}

export function createPeer(): FakePeer {
  const posts: { message: unknown; targetOrigin: string }[] = [];
  return {
    posts,
    postMessage(message, targetOrigin) {
      posts.push({ message, targetOrigin });
    },
    closed: false,
    focus() {},
  };
}

export interface FakeWindow {
  parent: unknown;
  addEventListener(type: string, handler: (event: MessageEvent) => void): void;
  removeEventListener(type: string, handler: (event: MessageEvent) => void): void;
  setTimeout(handler: () => void, ms?: number): number;
  clearTimeout(handle?: number): void;
  setInterval(handler: () => void, ms?: number): number;
  clearInterval(handle?: number): void;
  open(url: string, name: string, features: string): unknown;
  /** What `open` was called with, in order. */
  readonly opens: { url: string; name: string; features: string }[];
  /** What `open` returns next. `null` models a blocked pop-up. */
  nextPopup: FakePeer | null;
  /** Delivers a message event to every listener, with a forged origin/source. */
  deliver(data: unknown, origin: string, source: unknown): void;
  /** How many message listeners are attached right now. */
  listenerCount(): number;
}

export function createFakeWindow(): FakeWindow {
  const listeners = new Set<(event: MessageEvent) => void>();
  const opens: { url: string; name: string; features: string }[] = [];
  const self: FakeWindow = {
    parent: null,
    addEventListener(type, handler) {
      if (type === 'message') listeners.add(handler);
    },
    removeEventListener(_type, handler) {
      listeners.delete(handler);
    },
    setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms) as unknown as number,
    clearTimeout: (handle) => globalThis.clearTimeout(handle),
    setInterval: (handler, ms) => globalThis.setInterval(handler, ms) as unknown as number,
    clearInterval: (handle) => globalThis.clearInterval(handle),
    open(url, name, features) {
      opens.push({ url, name, features });
      return self.nextPopup;
    },
    opens,
    nextPopup: null,
    deliver(data, origin, source) {
      for (const listener of [...listeners]) {
        listener({ data, origin, source } as unknown as MessageEvent);
      }
    },
    listenerCount: () => listeners.size,
  };
  self.parent = self;
  return self;
}

/** The cast every call site needs, in one place. */
export function asWindow(fake: FakeWindow): Window {
  return fake as unknown as Window;
}

/**
 * Installs a fake as the GLOBAL `window`, so the `options.window ?? window`
 * default every transport carries is exercised rather than assumed.
 */
export function installGlobalWindow(fake: FakeWindow): () => void {
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = fake;
  return () => {
    if (previous === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previous;
  };
}

/** Waits for the microtask and timer queues to drain once. */
export function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}
