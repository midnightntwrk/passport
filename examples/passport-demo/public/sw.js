/**
 * Passport's service worker.
 *
 * WHY THIS FILE CARRIES A BUILD ID (2026/08/26)
 * ---------------------------------------------
 * A reviewer's installed Passport served a months-old client for weeks. The
 * app shell was NEVER the problem — navigations have always been network-first
 * (`networkNavigation` below) and Vercel has always answered `/` with
 * `max-age=0, must-revalidate`. The problem was this file's own identity:
 *
 *   1. `CACHE_VERSION` used to be a hand-bumped literal. A browser decides
 *      there is an update by comparing the worker script BYTE FOR BYTE, so
 *      every deploy between two hand-bumps shipped a byte-identical `sw.js`
 *      and no update was detected AT ALL — not installed, not waiting, not
 *      offered. Sixteen days of deploys went by that way between 2026/08/04
 *      and 2026/08/20.
 *   2. When the bytes did change, the new worker installed and then sat in
 *      `waiting` for ever, because `install` did not call `skipWaiting()` and
 *      the waiting worker only activates once EVERY client on the origin has
 *      gone. An installed PWA on a phone is resumed, not closed, so that
 *      moment never arrived. The only escape was a corner button the user had
 *      to notice and press.
 *
 * `BUILD_ID` fixes both at the root. It is stamped by the build (see
 * `stampServiceWorkerBuildId` in `vite.config.ts`) with a digest of everything
 * the client build emitted, so these bytes change on every deploy that changes
 * the client and on no other. The worker then activates itself rather than
 * depending on any page code — the page code is exactly what was stale.
 *
 * THE TRADE-OFF `skipWaiting()` BUYS, STATED
 * ------------------------------------------
 * A worker that claims a page mid-session can leave that page's lazily
 * imported chunks 404ing, because `activate` deletes the previous build's
 * caches and the alias no longer serves the previous build's hashes. That is
 * why `src/pwa.tsx` reloads an IDLE page the instant this worker claims it,
 * and shows a banner instead of reloading when Passport is in the middle of
 * something. The exposure is one flow's dynamic import inside that window,
 * and it is worth it: an installed client that cannot update itself is worse
 * than one that reloads a beat early.
 */

/**
 * Replaced at build time with a 16-character digest of the emitted client.
 * Left as the literal placeholder in source so `scripts/check-pwa.mjs` can
 * assert BOTH halves of the contract: the placeholder is here, and it is gone
 * from the build output.
 */
const BUILD_ID = '__BUILD_ID__';

const CACHE_PREFIX = 'midnight-passport-';
const SHELL_CACHE = `${CACHE_PREFIX}shell-${BUILD_ID}`;
const STATIC_CACHE = `${CACHE_PREFIX}static-${BUILD_ID}`;

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/offline.html',
  '/manifest.webmanifest',
  '/midnight-symbol.svg',
  // The wordmark IS the onboarding screen's only art, and onboarding is the
  // default first view — so it belongs in the shell rather than in the
  // runtime cache.
  '/midnight-wordmark.svg',
  '/icons/passport-192.png',
  '/icons/passport-512.png',
  '/icons/passport-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) =>
        // `cache: 'reload'` and not a plain URL: precaching the shell through
        // the HTTP cache is how a worker installs a copy of the deploy it is
        // replacing. Every one of these is fetched from the network.
        cache.addAll(SHELL_ASSETS.map((asset) => new Request(asset, { cache: 'reload' }))),
      )
      // Activate as soon as the shell is in place instead of waiting for every
      // client on the origin to close. See the header: on an installed PWA
      // that moment never comes.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key.startsWith(CACHE_PREFIX) && key !== SHELL_CACHE && key !== STATIC_CACHE,
            )
            .map((key) => caches.delete(key)),
        ),
      )
      // Control the pages that are already open, so `controllerchange` fires
      // in them and `src/pwa.tsx` can act on it.
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  // "Which build are you?", answerable from a running install. This incident
  // cost days because there was no way to ask that of a reviewer's phone.
  if (event.data?.type === 'BUILD_ID') event.ports?.[0]?.postMessage(BUILD_ID);
});

// The click side of the notifications `src/lib/notifications.ts` shows through
// this worker. Android Chrome forbids the page-side Notification constructor
// wherever a service worker is registered, so on the one platform this demo
// notifies from, every notification is shown here and every tap arrives here
// too — without this handler they would be inert.
//
// This is NOT push. There is no `push` handler, deliberately: a notification
// only ever exists because a running Passport tab observed something on its
// own wallet stream. See the scope note in `src/lib/notifications.ts`.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        return 'focus' in client ? client.focus() : undefined;
      }
      return self.clients.openWindow('/');
    }),
  );
});

async function networkNavigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put('/index.html', response.clone());
    }
    return response;
  } catch {
    return (await caches.match('/offline.html')) || Response.error();
  }
}

/**
 * `/assets/**` only. Every URL there is content-hashed by the build, so its
 * bytes can never change: served from the cache with no revalidation at all,
 * and fetched exactly once per build.
 */
async function immutableAsset(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request).catch(() => null);
  if (response?.ok && response.type === 'basic') {
    const cache = await caches.open(STATIC_CACHE);
    await cache.put(request, response.clone());
  }
  return response || Response.error();
}

/**
 * Everything else static — `/icons/**`, the wordmark, the manifest. These keep
 * a STABLE url across deploys, so a cached copy may be out of date and the
 * cached answer is always chased with a network refresh.
 */
async function staticAsset(request, event) {
  const cached = await caches.match(request);
  const network = fetch(request)
    .then(async (response) => {
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(STATIC_CACHE);
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    event.waitUntil(network.then(() => undefined));
    return cached;
  }
  return (await network) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.headers.has('range')) return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // `/verify/**` is the step verifier — a read-only operator page that is not
  // part of the app and is deliberately unreachable from its UI. It is skipped
  // here for two reasons, and the first is a correctness one:
  // `networkNavigation` below caches EVERY successful navigation response as
  // `/index.html`, so a reviewer opening /verify/ in an installed Passport
  // would poison the app shell with the verifier's HTML. The second is that a
  // page whose whole job is to show what the chain says right now must never
  // be served from a cache.
  if (url.pathname === '/verify' || url.pathname.startsWith('/verify/')) return;

  // The app shell, and the one request that decides which build runs: always
  // from the network, so a new deploy's asset hashes are seen. The cached copy
  // exists for `/offline.html`'s sake and is never preferred to a live answer.
  if (request.mode === 'navigate') {
    event.respondWith(networkNavigation(request));
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(immutableAsset(request));
    return;
  }

  const cacheableDestination = ['font', 'image', 'script', 'style', 'worker'].includes(
    request.destination,
  );
  const cacheableExtension = /\.(?:css|js|png|svg|wasm|woff2?)$/i.test(url.pathname);
  if (cacheableDestination || cacheableExtension) {
    event.respondWith(staticAsset(request, event));
  }
});
