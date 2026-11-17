// Offline reuse. Network first for everything, so a new deploy is never
// masked by a stale copy; the cache is only the fallback when the network
// fails. Weather requests are keyed without their end date, so yesterday's
// download for a field still answers today when there is no connection.
const CACHE = 'seedline-v1';
const WEATHER = 'power.larc.nasa.gov';

function keyFor(request) {
  const url = new URL(request.url);
  if (url.hostname === WEATHER) { url.searchParams.delete('end'); return url.toString(); }
  return request.url;
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  const mine = url.origin === self.location.origin || url.hostname === WEATHER || url.hostname.endsWith('gstatic.com') || url.hostname.endsWith('googleapis.com');
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
