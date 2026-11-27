// Offline reuse, and what lets the installed phone app open without signal.
// Network first for everything, so a new deploy is never masked by a stale
// copy; the cache is only the fallback when the network fails. The app's own
// files are cached when the worker installs, so the app opens offline even
// before every screen has been visited. Weather requests are keyed without their end date, so yesterday's
// download for a field still answers today when there is no connection.
const CACHE = 'seedline-v1';
const WEATHER = 'power.larc.nasa.gov';
const STATIC_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com'];

function keyFor(request) {
  const url = new URL(request.url);
  if (url.hostname === WEATHER) { url.searchParams.delete('end'); return url.toString(); }
  return request.url;
}

// The app shell. Pages ask for some of these with a ?v= version; the offline
// fallback below ignores that for this site's own files.
const SHELL = [
  './', 'index.html', 'validation.html', 'manifest.webmanifest',
  'css/style.css', 'vendor/leaflet/leaflet.css', 'vendor/leaflet/leaflet.js',
  'js/app.js', 'js/account.js', 'js/analysis.js', 'js/crops.js', 'js/forecast.js', 'js/i18n.js',
  'js/modis.js', 'js/ndvi.js', 'js/power.js', 'js/validate.js', 'js/validation-sites.js',
  'data/greenups.json', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  // One file at a time, so a single failure cannot stop the worker installing.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.allSettled(SHELL.map(async (path) => {
      const res = await fetch(path, { cache: 'no-cache' });
      if (res.ok) await cache.put(new URL(path, self.location).href, res);
    }));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // Only the app, its weather and its fonts and libraries. Firebase sign-in and
  // database traffic must never pass through here: buffering a streaming
  // database response into the cache would stall it.
  const mine = url.origin === self.location.origin || url.hostname === WEATHER || STATIC_HOSTS.includes(url.hostname);
  if (request.method !== 'GET' || !mine) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = keyFor(request);
    try {
      const fresh = await fetch(request);
      if (fresh.ok) {
        await cache.put(key, fresh.clone());
        if (url.hostname === WEATHER) trimWeather(cache);
      }
      return fresh;
    } catch (err) {
      const hit = await cache.match(key, { ignoreSearch: url.origin === self.location.origin });
      if (hit) return hit;
      throw err;
    }
  })());
});

// Each field's record is about 1 MB: keep the eight most recent.
async function trimWeather(cache) {
  const keys = (await cache.keys()).filter((r) => new URL(r.url).hostname === WEATHER);
  for (const old of keys.slice(0, Math.max(0, keys.length - 8))) await cache.delete(old);
}
