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
  '/midnight-wordmark.svg',
  // Hero art for the onboarding screen, which is now the default first view.
  '/passport-portal-monochrome.png',
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
