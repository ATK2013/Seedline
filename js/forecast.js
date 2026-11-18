// 16-day forecast from Open-Meteo (free for non-commercial use, no key,
// CORS-enabled) and the plant-now-or-wait call built on it.
// https://open-meteo.com/en/docs
const DAY = 86400000;

export async function fetchForecast(lat, lon, signal) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&forecast_days=16&timezone=UTC`;
  let res;
  try { res = await fetch(url, { signal }); } catch (e) {
    if (signal?.aborted) throw e;
    res = await fetch(url, { signal });   // one retry on a dropped connection
  }
  if (!res.ok) throw new Error(`Open-Meteo answered ${res.status}`);
  const d = (await res.json()).daily;
  const days = [];
  for (let i = 0; i < d.time.length; i++) {
    if (d.temperature_2m_max[i] == null || d.temperature_2m_min[i] == null) continue;
    days.push({ ms: Date.parse(`${d.time[i]}T00:00:00Z`), tmax: d.temperature_2m_max[i], tmin: d.temperature_2m_min[i], rain: d.precipitation_sum[i] ?? 0 });
  }
  return days;
}

/**
 * Turn a forecast into advice for a crop whose recommended window is `rec`.
 * status: 'far'  — the window is more than 16 days off, the forecast says nothing yet
 *         'soon' — the window opens within the forecast; reasons describe the outlook
 *         'go'   — the window is open and the next days look right for sowing
 *         'wait' — the window is open but something in the forecast argues for holding off
 * reasons: any of 'cold' (too cold to germinate), 'frost' (killing frost after
 *          emergence), 'dry' (no moisture to establish).
 */
export function outlook(days, crop, rec, opts = {}) {
  if (!rec || !rec.viable || days.length < 5) return { status: 'none', reasons: [], days };
  const today = days[0].ms;
  const todayOffset = Math.round((today - rec.seasonStartMs) / DAY);
  const daysToOpen = rec.open - todayOffset;
  if (todayOffset > rec.close || daysToOpen > 16) return { status: 'far', reasons: [], days, daysToOpen };

  const week = days.slice(0, 7);
  const tmean7 = week.reduce((a, d) => a + (d.tmin + d.tmax) / 2, 0) / week.length;
  const rain7 = week.reduce((a, d) => a + d.rain, 0);
  // Before half its heat sum a winter crop is hardy; everything else dies at frostKill.
  const kill = crop.winter ? crop.winter.kill : crop.frostKill;
  const frost = days.slice(crop.emerge).find((d) => d.tmin <= kill) ?? null;
  const reasons = [];
  if (tmean7 < crop.germ) reasons.push('cold');
  if (frost) reasons.push('frost');
  if (!opts.irrigated && (rec.now?.soilWater ?? 0) < (crop.dryStart ?? 0.2) && rain7 < 15) reasons.push('dry');
  const open = daysToOpen <= 0;
  return { status: open ? (reasons.length ? 'wait' : 'go') : 'soon', reasons, days, daysToOpen, tmean7, rain7, frostMs: frost?.ms ?? null };
}
