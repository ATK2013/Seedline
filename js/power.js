// NASA POWER daily point API — free, no key, CORS-enabled.
// https://power.larc.nasa.gov/docs/services/api/temporal/daily/
const BASE = 'https://power.larc.nasa.gov/api/temporal/daily/point';
const PARAMS = 'T2M_MIN,T2M_MAX,PRECTOTCORR,ALLSKY_SFC_SW_DWN';
const START = '19810101';
const cache = new Map();

const stamp = (d) => d.toISOString().slice(0, 10).replaceAll('-', '');

export async function fetchDaily(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (cache.has(key)) return cache.get(key);
  let lastError;
  // POWER rejects an end date it has no data for yet, so step back if needed.
  for (const back of [0, 3, 10]) {
    const end = stamp(new Date(Date.now() - back * 86400000));
    const url = `${BASE}?parameters=${PARAMS}&community=AG&longitude=${lon.toFixed(4)}&latitude=${lat.toFixed(4)}&start=${START}&end=${end}&format=JSON`;
    try {
      const res = await fetch(url);
      if (res.ok) {
        const json = await res.json();
        cache.set(key, json);
        return json;
      }
      lastError = new Error(`NASA POWER answered ${res.status}`);
      if (res.status !== 422) break;
    } catch (e) {
      lastError = e;
      break;
    }
  }
  throw lastError;
}
