// MODIS NDVI for one pixel from NASA's ORNL DAAC subset service — free, no
// key, CORS-enabled. https://modis.ornl.gov/data/modis_webservice.html
// The service returns at most 10 composites per request and can be slow, so
// callers fetch one season at a time and results are cached in the browser.
const BASE = 'https://modis.ornl.gov/rst/api/v1/MOD13Q1/subset';
const BAND = '250m_16_days_NDVI';

const store = (() => { try { return globalThis.localStorage ?? null; } catch { return null; } })();

async function once(url, signal) {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  if (!res.ok) throw new Error(`NASA MODIS service answered ${res.status}`);
  const json = await res.json();
  const scale = +json.scale || 0.0001;
  return json.subset.map((s) => ({ ms: Date.parse(`${s.calendar_date}T00:00:00Z`), ndvi: s.data[0] * scale }));
}

/** NDVI series for the given composites (from ndvi.js compositeDates). */
export async function fetchNdvi(lat, lon, dates, signal) {
  const first = dates[0].modis, last = dates[dates.length - 1].modis;
  const key = `seedline:ndvi:${lat.toFixed(3)},${lon.toFixed(3)}:${first}:${last}`;
  try { const hit = store?.getItem(key); if (hit) return JSON.parse(hit); } catch { /* ignore a bad cache entry */ }
  const url = `${BASE}?latitude=${lat.toFixed(5)}&longitude=${lon.toFixed(5)}&band=${BAND}&startDate=${first}&endDate=${last}&kmAboveBelow=0&kmLeftRight=0`;
  // The service intermittently answers 502 under load: back off and retry.
  let points;
  for (let attempt = 0; ; attempt++) {
    try { points = await once(url, signal); break; } catch (e) {
      if (signal?.aborted || attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1) ** 2));
    }
  }
  try { store?.setItem(key, JSON.stringify(points)); } catch { /* storage full or blocked */ }
  return points;
}

// ---------------------------------------------------------------------------
// Fast path: MCD12Q2 land-surface phenology (500 m, yearly). One value per
// year instead of 23 composites, so 15 seasons need four requests, not 15.
const PHENO = 'https://modis.ornl.gov/rst/api/v1/MCD12Q2/subset';
const DAY = 86400000;

/** Mid-green-up dates (ms) of every growing cycle NASA detected in fromYear..toYear. */
export async function fetchGreenups(lat, lon, fromYear, toYear, signal, onProgress = () => {}) {
  const key = `seedline:pheno:${lat.toFixed(3)},${lon.toFixed(3)}:${fromYear}:${toYear}`;
  try { const hit = store?.getItem(key); if (hit) return JSON.parse(hit); } catch { /* ignore */ }
  const jobs = [];
  for (const band of ['MidGreenup.Num_Modes_01', 'MidGreenup.Num_Modes_02']) {
    for (let y = fromYear; y <= toYear; y += 10) jobs.push({ band, from: y, to: Math.min(toYear, y + 9) });
  }
  const out = [];
  let done = 0;
  onProgress(done, jobs.length);
  await Promise.all([0, 1].map(async () => {
    for (let job; (job = jobs.shift());) {
      const url = `${PHENO}?latitude=${lat.toFixed(5)}&longitude=${lon.toFixed(5)}&band=${job.band}&startDate=A${job.from}001&endDate=A${job.to}001&kmAboveBelow=0&kmLeftRight=0`;
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
          if (!res.ok) throw new Error(`NASA MODIS service answered ${res.status}`);
          // Values are days since 1970; 32767 marks "no cycle detected".
          for (const s of (await res.json()).subset) if (s.data[0] > 0 && s.data[0] < 32000) out.push(s.data[0] * DAY);
          break;
        } catch (e) {
          if (signal?.aborted || attempt === 2) throw e;
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1) ** 2));
        }
      }
      onProgress(++done, done + jobs.length);
    }
  }));
  out.sort((a, b) => a - b);
  try { store?.setItem(key, JSON.stringify(out)); } catch { /* storage full or blocked */ }
  return out;
}
