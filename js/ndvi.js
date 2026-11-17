// Satellite cross-check: does the land actually green up when the model says
// a crop sown in the window should? Pure functions, no DOM, no network.
//
// MODIS MOD13Q1 gives one NDVI value per 250 m pixel every 16 days. For each
// season we look at the composites around the planting window, find the date
// the pixel is halfway from bare to its peak ("green-up"), and step back by
// the crop's usual sowing-to-green-up lag to get a satellite-implied sowing
// date. That date is then compared with the dates the weather model called
// safe in the same year.

const median = (a) => {
  const v = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

const DAY = 86400000;
export const COMPOSITE_DAYS = 16;
export const LEAD_DAYS = 40;         // start looking this long before the window opens
export const GREENUP_LAG = 30;       // days from emergence to mid green-up, typical annual crop
export const TOLERANCE = 8;          // half a composite: the dating precision of the method
const MIN_AMPLITUDE = 0.15;          // smaller seasonal swings are not a crop cycle

const modisDate = (ms) => {
  const d = new Date(ms);
  const doy = Math.round((ms - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY) + 1;
  return `A${d.getUTCFullYear()}${String(doy).padStart(3, '0')}`;
};

/** The `count` consecutive 16-day composites starting on or after `startMs`.
 *  Composites restart at day 1 of every calendar year (1, 17, … 353). */
export function compositeDates(startMs, count = 10) {
  const out = [];
  for (let y = new Date(startMs).getUTCFullYear(); out.length < count; y++) {
    for (let doy = 1; doy <= 353 && out.length < count; doy += COMPOSITE_DAYS) {
      const ms = Date.UTC(y, 0, doy);
      if (ms >= startMs) out.push({ ms, modis: modisDate(ms) });
    }
  }
  return out;
}

/**
 * Green-up date from a short NDVI series [{ ms, ndvi }]: the first time the
 * rising limb crosses halfway between the pre-season minimum and the peak.
 * Returns null when the pixel shows no clear seasonal rise.
 */
export function greenUp(points) {
  const p = points.filter((q) => Number.isFinite(q.ndvi) && q.ndvi > -0.2 && q.ndvi <= 1).sort((a, b) => a.ms - b.ms);
  if (p.length < 5) return null;
  const v = p.map((q) => q.ndvi);
  // Cloud and snow only ever pull NDVI down: lift isolated dips.
  for (let i = 1; i < v.length - 1; i++) if (v[i] < v[i - 1] - 0.1 && v[i] < v[i + 1] - 0.1) v[i] = (v[i - 1] + v[i + 1]) / 2;
  let iMax = 0;
  for (let i = 1; i < v.length; i++) if (v[i] > v[iMax]) iMax = i;
  let iMin = 0;
  for (let i = 1; i <= iMax; i++) if (v[i] <= v[iMin]) iMin = i;
  const amp = v[iMax] - v[iMin];
  if (iMax <= iMin || amp < MIN_AMPLITUDE) return null;
  const thr = v[iMin] + amp / 2;
  for (let i = iMin; i < iMax; i++) {
    if (v[i] < thr && v[i + 1] >= thr) {
      const f = (thr - v[i]) / (v[i + 1] - v[i]);
      // A composite is dated by its first day; its typical acquisition is mid-period.
      return { ms: p[i].ms + f * (p[i + 1].ms - p[i].ms) + (COMPOSITE_DAYS / 2) * DAY, min: v[iMin], max: v[iMax], amp };
    }
  }
  return null;
}

/** Spearman rank correlation (average ranks for ties). */
export function spearman(a, b) {
  const rank = (x) => {
    const idx = x.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(x.length);
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const n = a.length;
  if (n < 5) return NaN;
  const ra = rank(a), rb = rank(b);
  const ma = (n - 1) / 2;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (ra[i] - ma) * (rb[i] - ma); saa += (ra[i] - ma) ** 2; sbb += (rb[i] - ma) ** 2; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : NaN;
}

/** Seasons to check: the most recent complete ones the satellite record covers. */
export function ndviTargets(result, count = 15) {
  const rec = result.rec;
  if (!rec || !rec.viable) return [];
  return result.seasons
    .filter((s) => s.complete && s.startMs + (rec.open - LEAD_DAYS) * DAY >= Date.UTC(2000, 2, 1))
    .slice(-count)
    .map((s) => ({ year: s.year, label: s.label, dates: compositeDates(s.startMs + (rec.open - LEAD_DAYS) * DAY) }))
    .reverse();
}

/**
 * Fast path: NASA's yearly phenology product (MCD12Q2) already gives the
 * mid-green-up date of each growing cycle. Hand each recent season the first
 * cycle that starts in the same search window the NDVI method uses.
 */
export function assignGreenups(result, greenMsList, count = 15) {
  const dates = greenMsList.filter(Number.isFinite).sort((a, b) => a - b);
  if (!dates.length) return [];
  const last = dates[dates.length - 1];
  return ndviTargets(result, 60)
    .filter((t) => t.dates[0].ms <= last)       // the product lags a year or two
    .slice(0, count)
    .map((t) => {
      const from = t.dates[0].ms, to = from + 160 * DAY;
      return { year: t.year, greenMs: dates.find((d) => d >= from && d <= to) ?? NaN };
    });
}

/**
 * Compare satellite green-up with the model. `observed` is a list of
 * { year, points } where points is the NDVI series for that season.
 */
export function compareNdvi(result, crop, observed) {
  const lag = crop.emerge + GREENUP_LAG;
  const byYear = new Map(result.seasons.map((s) => [s.year, s]));
  const years = observed.map((o) => {
    const s = byYear.get(o.year);
    // Either a raw NDVI series to date, or a green-up date already dated by NASA (MCD12Q2).
    const g = o.points ? greenUp(o.points) : (Number.isFinite(o.greenMs) ? { ms: o.greenMs, max: NaN } : null);
    const row = { year: o.year, label: s.label, open: s.open, close: s.close, green: NaN, implied: NaN, inside: null, peak: NaN };
    if (g) {
      row.green = (g.ms - s.startMs) / DAY;
      row.implied = row.green - lag;
      row.peak = g.max;
      if (Number.isFinite(s.open)) row.inside = row.implied >= s.open - TOLERANCE && row.implied <= s.close + TOLERANCE;
    }
    return row;
  }).sort((a, b) => a.year - b.year);

  const seen = years.filter((y) => Number.isFinite(y.green));
  const judged = seen.filter((y) => y.inside !== null);
  const both = seen.filter((y) => Number.isFinite(y.open));
  const summary = {
    lag,
    checked: years.length,
    greened: seen.length,
    judged: judged.length,
    inside: judged.filter((y) => y.inside).length,
    medianGreen: median(seen.map((y) => y.green)),
    medianImplied: median(seen.map((y) => y.implied)),
    medianPeak: median(seen.map((y) => y.peak)),
    rho: spearman(both.map((y) => y.open), both.map((y) => y.green)),
  };
  summary.offset = summary.medianImplied - result.rec.best;   // + means farmers appear to sow later than advised

  if (years.length >= 4 && seen.length < years.length / 2) summary.verdict = 'no-crop';
  else if (judged.length < 3) summary.verdict = 'pending';
  else if (summary.inside / judged.length >= 0.7) summary.verdict = 'agrees';
  else if (summary.inside / judged.length >= 0.4) summary.verdict = 'partly';
  else summary.verdict = summary.offset < 0 ? 'earlier' : 'later';
  return { years, summary };
}
