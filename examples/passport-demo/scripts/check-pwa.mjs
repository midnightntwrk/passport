import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const distDir = path.join(root, 'dist');
const checks = [];

async function text(file) {
  return readFile(file, 'utf8');
}

async function json(file) {
  return JSON.parse(await text(file));
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function pass(label) {
  checks.push(label);
  console.log(`PASS ${label}`);
}

function includes(source, expected, label) {
  assert.ok(source.includes(expected), `${label}: expected ${JSON.stringify(expected)}`);
  pass(label);
}

async function pngDimensions(file) {
  const value = await readFile(file);
  const signature = value.subarray(0, 8).toString('hex');
  assert.equal(signature, '89504e470d0a1a0a', `${file} is not a PNG`);
  return {
    width: value.readUInt32BE(16),
    height: value.readUInt32BE(20),
  };
}

assert.ok(await exists(distDir), 'Build output is missing. Run the demo build before check:pwa.');

const manifestPath = path.join(publicDir, 'manifest.webmanifest');
const manifest = await json(manifestPath);
assert.equal(manifest.name, 'Midnight Passport');
assert.equal(manifest.short_name, 'Passport');
assert.equal(manifest.id, '/');
assert.equal(manifest.start_url, '/');
assert.equal(manifest.scope, '/');
assert.equal(manifest.display, 'standalone');
assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);
pass('manifest identity, scope, colors, and standalone display');

const requiredIcons = [
  { src: '/icons/passport-192.png', width: 192, purpose: 'any' },
  { src: '/icons/passport-512.png', width: 512, purpose: 'any' },
  { src: '/icons/passport-maskable-512.png', width: 512, purpose: 'maskable' },
];

for (const expected of requiredIcons) {
  const icon = manifest.icons.find((candidate) => candidate.src === expected.src);
  assert.ok(icon, `Manifest icon ${expected.src} is missing`);
  assert.equal(icon.type, 'image/png');
  assert.match(icon.purpose, new RegExp(`(?:^|\\s)${expected.purpose}(?:\\s|$)`));
  const sourceFile = path.join(publicDir, expected.src);
  const builtFile = path.join(distDir, expected.src);
  assert.ok(await exists(sourceFile), `Source icon ${expected.src} is missing`);
  assert.ok(await exists(builtFile), `Built icon ${expected.src} is missing`);
  const sourceDimensions = await pngDimensions(sourceFile);
  const builtDimensions = await pngDimensions(builtFile);
  assert.deepEqual(sourceDimensions, { width: expected.width, height: expected.width });
  assert.deepEqual(builtDimensions, sourceDimensions);
  pass(`${expected.width}px ${expected.purpose} icon exists in source and build`);
}

const appleIcon = path.join(publicDir, 'icons/apple-touch-icon.png');
assert.deepEqual(await pngDimensions(appleIcon), { width: 180, height: 180 });
pass('180px Apple touch icon');

const sourceHtml = await text(path.join(root, 'index.html'));
const builtHtml = await text(path.join(distDir, 'index.html'));
for (const html of [sourceHtml, builtHtml]) {
  includes(html, 'rel="manifest"', 'manifest is linked from HTML');
  includes(html, 'apple-mobile-web-app-capable', 'Apple standalone metadata');
  includes(html, 'mobile-web-app-capable', 'mobile standalone metadata');
  includes(html, 'viewport-fit=cover', 'safe-area viewport metadata');
  includes(html, 'apple-touch-icon', 'Apple touch icon link');
}

const sourceWorker = await text(path.join(publicDir, 'sw.js'));
const builtWorker = await text(path.join(distDir, 'sw.js'));

/* THE BUILD ID, AND WHY IT IS CHECKED FROM BOTH ENDS
   --------------------------------------------------
   A browser decides a service worker has been updated by comparing the script
   byte for byte. `sw.js` used to carry a hand-bumped `CACHE_VERSION` literal,
   so deploys between two bumps shipped an identical worker and installed
   clients were never offered an update at all — the 2026/08/26 incident, in
   which a reviewer's installed PWA served a client weeks out of date. The id
   is now stamped by `stampServiceWorkerBuildId()` in `vite.config.ts` from a
   digest of everything the build emitted, which is a fact about the pipeline
   and not about anyone remembering. Both halves are asserted here: the
   placeholder is in source, it is GONE from the build, and the build differs
   from source in that stamp and in nothing else. */
includes(sourceWorker, "const BUILD_ID = '__BUILD_ID__'", 'service worker carries the build-id placeholder');
const builtBuildId = /const BUILD_ID = '([0-9a-f]{16})';/.exec(builtWorker);
assert.ok(builtBuildId, 'Built service worker has no stamped 16-character build id.');
assert.ok(
  !builtWorker.includes('__BUILD_ID__'),
  'Built service worker still carries the __BUILD_ID__ placeholder.',
);
assert.equal(
  builtWorker,
  sourceWorker.replaceAll('__BUILD_ID__', builtBuildId[1]),
  'Built service worker differs from source by more than the build-id stamp.',
);
pass(`service worker is stamped with build id ${builtBuildId[1]} and is otherwise the reviewed source`);

includes(sourceWorker, "self.addEventListener('install'", 'service worker install handler');
includes(sourceWorker, "self.addEventListener('activate'", 'service worker activation handler');
includes(sourceWorker, "self.addEventListener('fetch'", 'service worker fetch handler');
includes(sourceWorker, "self.addEventListener('message'", 'service worker update handler');
includes(sourceWorker, 'shell-${BUILD_ID}', 'shell cache is named for the build');
includes(sourceWorker, 'static-${BUILD_ID}', 'runtime cache is named for the build');
/* Together these are what stops a new worker parking in `waiting` for ever on
   a phone, where "every client has closed" never happens. */
includes(sourceWorker, '.then(() => self.skipWaiting())', 'a new worker activates itself rather than waiting');
includes(sourceWorker, '.then(() => self.clients.claim())', 'an activated worker claims the open page');
includes(sourceWorker, "new Request(asset, { cache: 'reload' })", 'the shell is precached from the network, not the HTTP cache');
includes(sourceWorker, "url.pathname.startsWith('/assets/')", 'content-hashed assets are served cache-first');
includes(sourceWorker, "'/midnight-wordmark.svg'", 'onboarding art is a precached shell asset');
includes(sourceWorker, "url.origin !== self.location.origin", 'cross-origin requests bypass caches');
includes(sourceWorker, "url.pathname.startsWith('/api/')", 'same-origin API requests bypass caches');
includes(
  sourceWorker,
  "url.pathname.startsWith('/verify/')",
  'the step verifier bypasses caches and cannot poison the app shell',
);
includes(sourceWorker, "request.mode === 'navigate'", 'navigation strategy is explicit');
includes(sourceWorker, "caches.match('/offline.html')", 'offline navigation fallback is explicit');
includes(sourceWorker, 'event.waitUntil(network.then(() => undefined))', 'runtime cache refresh extends worker lifetime');
assert.doesNotMatch(sourceWorker, /addEventListener\(['"](?:sync|periodicsync)['"]/);
pass('no background transaction or proof queue is registered');

const offlineHtml = await text(path.join(publicDir, 'offline.html'));
includes(
  offlineHtml,
  'Reconnect to sign in, refresh balances, generate proofs, or submit transactions.',
  'offline shell names network-only operations',
);
includes(
  offlineHtml,
  'Network operations are never queued or represented as completed while offline.',
  'offline shell rejects simulated completion',
);
includes(offlineHtml, '<a class="retry-link" href="/">Try again</a>', 'offline retry uses navigation');
assert.doesNotMatch(offlineHtml, /\son\w+=/i);
pass('offline shell has no inline event handlers');

/* THE HTTP CACHE POLICY, DECLARED RATHER THAN INHERITED
   -----------------------------------------------------
   `/assets/**` is content-hashed by the build, so a given url's bytes can
   never change and it is cached for a year. Everything with a STABLE url —
   both HTML shells, `sw.js`, the manifest, the icons — must be revalidated on
   every use, because whether an installed PWA can ever see a new deploy's
   asset hashes turns on it. Vercel's default for those files already happened
   to be `max-age=0, must-revalidate`; a default is not a decision, and this
   one is load-bearing, so it is written down and asserted. */
const vercelConfig = await json(path.join(root, 'vercel.json'));
const headerRule = (source) => vercelConfig.headers.find((rule) => rule.source === source);
const headerValue = (source, key) =>
  headerRule(source)?.headers.find((header) => header.key === key)?.value;
assert.equal(headerValue('/assets/(.*)', 'cache-control'), 'public, max-age=31536000, immutable');
pass('content-hashed assets are declared immutable');
assert.equal(headerValue('/((?!zk/|zk-params/|assets/).*)', 'cache-control'), 'no-cache');
pass('every stable-url file, both HTML shells included, must be revalidated');
assert.equal(headerValue('/sw.js', 'cache-control'), 'no-cache');
assert.equal(headerValue('/sw.js', 'service-worker-allowed'), '/');
pass('the service worker script itself must be revalidated');
assert.ok(
  vercelConfig.rewrites.some((rule) => rule.source === '/((?!zk/|zk-params/|assets/).*)'),
  'The no-cache header rule and the SPA rewrite must share one negative lookahead.',
);
pass('the cache rule and the SPA rewrite cover exactly the same paths');

const pwaSource = await text(path.join(root, 'src/pwa.tsx'));
includes(pwaSource, "navigator.serviceWorker.register('/sw.js'", 'client registers the root service worker');
includes(pwaSource, "updateViaCache: 'none'", 'service worker update checks bypass HTTP cache');
includes(pwaSource, 'inspectInstallingWorker(registration)', 'client detects an existing installing worker');
/* "Shouldn't it update on its own when I open the PWA?" — asked by a reviewer
   on 2026/08/26 about an installed client weeks out of date. These three are
   the answer: opening the app is itself the update check. */
includes(pwaSource, "document.addEventListener('visibilitychange', checkForUpdate)", 'opening the app checks for a new deployment');
includes(pwaSource, "window.addEventListener('pageshow', checkForUpdate)", 'a page restored from the back/forward cache checks too');
includes(pwaSource, "navigator.serviceWorker.addEventListener('controllerchange'", 'client reacts when a new worker takes over');
includes(pwaSource, 'criticalWorkInFlight()', 'the reload is held back while a ceremony or transaction is running');
includes(pwaSource, "window.addEventListener('beforeinstallprompt'", 'install prompt is captured progressively');
includes(pwaSource, "window.addEventListener('offline'", 'offline state is surfaced');
includes(pwaSource, 'navigator.storage.persist()', 'private-state setup requests persistent origin storage');

const assetNames = (await readdir(path.join(distDir, 'assets'))).filter((name) => name.endsWith('.js'));
const builtJavascript = (
  await Promise.all(assetNames.map((name) => text(path.join(distDir, 'assets', name))))
).join('\n');
includes(builtJavascript, '/sw.js', 'production JavaScript contains service-worker registration');
includes(builtJavascript, 'SKIP_WAITING', 'production JavaScript contains explicit update activation');

const builtManifest = await json(path.join(distDir, 'manifest.webmanifest'));
assert.deepEqual(builtManifest, manifest);
pass('production manifest matches the reviewed source manifest');

console.log(`\n${checks.length} PWA checks passed.`);
