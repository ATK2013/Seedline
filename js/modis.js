// Satellite green-up dates for one pixel, from NASA's ORNL DAAC subset service:
// MCD12Q2 land-surface phenology (500 m), which gives the mid-green-up date of
// each growing cycle in each year. Free, no key, CORS-enabled.
// https://modis.ornl.gov/data/modis_webservice.html
//
// Why this module is shaped the way it is: the service's speed swings widely.
// On a quiet day a request takes 1–5 s; on a busy one 10–60 s, and its gateway
// gives up at about 60 s with a 502. Requests sent together come back together,
// so the wait is the service's queue, not the size of the request. Therefore:
//  - every request for a field goes out at once, never in rounds;
//  - a field is fetched once: green-up belongs to the pixel, not the crop;
//  - answers are kept in the browser, and the example fields ship with a saved
//    copy (data/greenups.json) so a demo never waits on NASA;
//  - a request that fails after a long wait is not retried automatically.

const BASE = 'https://modis.ornl.gov/rst/api/v1/MCD12Q2/subset';
const BANDS = ['MidGreenup.Num_Modes_01', 'MidGreenup.Num_Modes_02'];   // first and second growing cycle of the year
const DAY = 86400000;
const YEARS = 18;          // enough for 15 seasons plus southern seasons that straddle two years
const MAX_DATES = 10;      // the service refuses more than 10 dates in one request
const TIMING = { timeoutMs: 65000, quickFailMs: 15000, retryDelayMs: 1500 };

const store = (() => { try { return globalThis.localStorage ?? null; } catch { return null; } })();

/** Cache key for a pixel: 0.001° is about 110 m, finer than the 500 m pixel. */
export const pixelKey = (lat, lon) => `${lat.toFixed(3)},${lon.toFixed(3)}`;

/** The requests that cover one field: both cycle bands over the last YEARS years,
 *  split into chunks the service accepts. */
export function greenupRequests(year = new Date().getUTCFullYear()) {
  const from = year - YEARS + 1;
  const chunks = Math.ceil(YEARS / MAX_DATES), size = Math.ceil(YEARS / chunks);
  const out = [];
  for (const band of BANDS) {
    for (let y = from; y <= year; y += size) out.push({ band, from: y, to: Math.min(year, y + size - 1) });
  }
  return out;
}

const urlFor = (lat, lon, r) => `${BASE}?latitude=${lat.toFixed(5)}&longitude=${lon.toFixed(5)}&band=${r.band}&startDate=A${r.from}001&endDate=A${r.to}001&kmAboveBelow=0&kmLeftRight=0`;

async function request(url, signal, timing) {
  const ctrl = new AbortController();
  const stop = () => ctrl.abort();
  signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, timing.timeoutMs);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`NASA MODIS service answered ${res.status}`);
    // Values are days since 1970; 32767 marks "no cycle detected".
    const out = [];
    for (const s of (await res.json()).subset) if (s.data[0] > 0 && s.data[0] < 32000) out.push(s.data[0] * DAY);
    return out;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

/** One retry, but only for a failure that came back fast (a dropped connection).
 *  A failure after a long wait means the service is overloaded: asking again
 *  straight away would only double the wait. */
async function requestWithQuickRetry(url, signal, timing) {
  const t0 = Date.now();
  try {
    return await request(url, signal, timing);
  } catch (e) {
    if (signal?.aborted || Date.now() - t0 > timing.quickFailMs) throw e;
    await new Promise((r) => setTimeout(r, timing.retryDelayMs));
    if (signal?.aborted) throw e;
    return request(url, signal, timing);
  }
}

let snapshot = null;
function savedCopy() {
  snapshot ??= fetch(new URL('../data/greenups.json', import.meta.url))
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  return snapshot;
}

/**
 * Mid-green-up dates (ms, ascending) of every growing cycle NASA saw at this
 * pixel over the last 18 years. Resolves to { greens, source, fetched } where
 * source is 'saved' (shipped copy), 'cache' (this browser) or 'live'.
 */
export async function fetchGreenups(lat, lon, { signal, year = new Date().getUTCFullYear(), timing = TIMING } = {}) {
  const key = pixelKey(lat, lon);
  const cacheKey = `seedline:greenups:${key}:${year}`;
  try {
    const hit = JSON.parse(store?.getItem(cacheKey) ?? 'null');
    if (hit?.greens) return { ...hit, source: 'cache' };
  } catch { /* ignore a bad cache entry */ }

  const saved = await savedCopy();
  if (saved.fields?.[key]?.length) return { greens: saved.fields[key], source: 'saved', fetched: saved.fetched };

  const parts = await Promise.all(greenupRequests(year).map((r) => requestWithQuickRetry(urlFor(lat, lon, r), signal, timing)));
  const out = { greens: parts.flat().sort((a, b) => a - b), fetched: new Date().toISOString().slice(0, 10) };
  try { store?.setItem(cacheKey, JSON.stringify(out)); } catch { /* storage full or blocked */ }
  return { ...out, source: 'live' };
}
