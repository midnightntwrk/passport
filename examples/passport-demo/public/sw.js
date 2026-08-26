const CACHE_PREFIX = 'midnight-passport-';
// Bump this value for every released service-worker shell.
const CACHE_VERSION = '2026-08-04-1';
const SHELL_CACHE = `${CACHE_PREFIX}shell-${CACHE_VERSION}`;
const STATIC_CACHE = `${CACHE_PREFIX}static-${CACHE_VERSION}`;

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
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)));
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
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
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

  if (request.mode === 'navigate') {
    event.respondWith(networkNavigation(request));
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
