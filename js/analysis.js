// Seedline analysis engine. Pure functions, no DOM — runs in the browser and
// under `node --test`.
//
// The core idea: for every year on record and every possible planting day,
// replay the actual weather that followed and ask "would this crop have made
// it?". The safe planting window, its drift over the decades and this season's
// risk score all fall out of that one table of outcomes.

const DAY = 86400000;
export const SEASON_DAYS = 365;

// Outcome codes for one (year, planting day) replay.
export const OUT = { UNKNOWN: -1, OK: 0, COLD: 1, FROST: 2, DRY_START: 3, HEAT: 4, DROUGHT: 5, SHORT: 6 };
export const N_OUT = 7;

const SOIL_CAPACITY = 100;   // mm of plant-available water in the root zone
const DRY_START_SW = 0.20;   // mean relative soil water needed in the first 3 weeks
const DROUGHT_SW = 0.12;     // below this the crop is under severe water stress
const DROUGHT_FRAC = 0.40;   // share of the cycle under severe stress that fails it
const HEAT_DAYS = 5;         // damaging days at flowering that fail the crop
const RUN_GAP = 5;           // days of failures tolerated inside a yearly window

// ---------------------------------------------------------------- data prep

const ymd = (k) => Date.UTC(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8));

/** Turn a NASA POWER daily point response into gap-filled typed arrays. */
export function parsePower(json) {
  const p = json.properties.parameter;
  const keys = Object.keys(p.T2M_MIN).sort();
  const ok = (v) => v !== undefined && v !== null && v > -900;
  let n = keys.length;
  while (n > 0 && !(ok(p.T2M_MIN[keys[n - 1]]) && ok(p.T2M_MAX[keys[n - 1]]))) n--;
  const series = { t0: ymd(keys[0]), n, tmin: new Float32Array(n), tmax: new Float32Array(n), rain: new Float32Array(n), rs: new Float32Array(n) };
  let lastMin = 10, lastMax = 20;
  for (let i = 0; i < n; i++) {
    const k = keys[i];
    lastMin = series.tmin[i] = ok(p.T2M_MIN[k]) ? p.T2M_MIN[k] : lastMin;
    lastMax = series.tmax[i] = ok(p.T2M_MAX[k]) ? p.T2M_MAX[k] : lastMax;
    series.rain[i] = ok(p.PRECTOTCORR?.[k]) ? p.PRECTOTCORR[k] : 0;
    series.rs[i] = ok(p.ALLSKY_SFC_SW_DWN?.[k]) ? p.ALLSKY_SFC_SW_DWN[k] : NaN;
  }
  return series;
}

/** Extraterrestrial radiation, MJ m-2 day-1 (FAO-56 eq. 21). */
export function extraterrestrialRadiation(latDeg, doy) {
  const phi = (latDeg * Math.PI) / 180;
  const dr = 1 + 0.033 * Math.cos((2 * Math.PI * doy) / 365);
  const delta = 0.409 * Math.sin((2 * Math.PI * doy) / 365 - 1.39);
  const x = Math.max(-1, Math.min(1, -Math.tan(phi) * Math.tan(delta)));
  const ws = Math.acos(x);
  return (24 * 60 / Math.PI) * 0.082 * dr * (ws * Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.sin(ws));
}

const doyOf = (ms) => { const d = new Date(ms); return Math.floor((ms - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY) + 1; };

/**
 * Add reference evapotranspiration (Hargreaves) and a running one-bucket soil
 * water balance. Measured solar radiation is used where POWER has it; before
 * 1984 and in the most recent days it falls back to the temperature-range form.
 */
export function addWaterBalance(s, lat) {
  s.et0 = new Float32Array(s.n);
  s.sw = new Float32Array(s.n);
  let w = SOIL_CAPACITY / 2;
  for (let i = 0; i < s.n; i++) {
    const tmean = (s.tmin[i] + s.tmax[i]) / 2;
    let et0;
    if (Number.isFinite(s.rs[i])) et0 = 0.0135 * (tmean + 17.8) * s.rs[i] * 0.408;
    else et0 = 0.0023 * (tmean + 17.8) * Math.sqrt(Math.max(0, s.tmax[i] - s.tmin[i])) * extraterrestrialRadiation(lat, doyOf(s.t0 + i * DAY)) * 0.408;
    et0 = Math.max(0, et0);
    s.et0[i] = et0;
    w = Math.min(SOIL_CAPACITY, w + s.rain[i]);
    w = Math.max(0, w - et0 * 0.9 * Math.min(1, w / (0.5 * SOIL_CAPACITY)));
    s.sw[i] = w / SOIL_CAPACITY;
  }
  return s;
}

// ------------------------------------------------------------- crop replay

function mean30(s, j) {
  let sum = 0, n = 0;
  for (let i = Math.max(0, j - 30); i < j; i++) { sum += s.tmin[i] + s.tmax[i]; n++; }
  return n ? sum / (2 * n) : 0;
}

/**
 * Replay one planting: sow on day index `d` and follow the real weather.
 * Returns { code, days } where days is the cycle length when the crop matured.
 */
export function simulatePlanting(s, d, crop, opts = {}) {
  const target = crop.gdd * (opts.gddScale ?? 1);
  const rainfed = !opts.irrigated;
  if (d + 21 >= s.n) return { code: OUT.UNKNOWN };

  let t7 = 0;
  for (let j = d; j < d + 7; j++) t7 += (s.tmin[j] + s.tmax[j]) / 2;
  if (t7 / 7 < crop.germ) return { code: OUT.COLD };

  if (rainfed) {
    let sw = 0;
    for (let j = d; j < d + 21; j++) sw += s.sw[j];
    if (sw / 21 < DRY_START_SW) return { code: OUT.DRY_START };
  }

  let gdd = 0, heatDays = 0, dryDays = 0;
  for (let j = d; ; j++) {
    const age = j - d;
    if (j >= s.n) return { code: OUT.UNKNOWN };
    if (age > crop.maxDays) return { code: OUT.SHORT };
    if (age >= crop.emerge && s.tmin[j] <= crop.frostKill) {
      // A frost while the season is still warming up means "planted too
      // early"; a frost once it is cooling means the season ran out.
      const warming = mean30(s, j) >= mean30(s, d);
      return { code: warming && gdd < 0.5 * target ? OUT.FROST : OUT.SHORT };
    }
    const hi = Math.max(crop.base, Math.min(s.tmax[j], crop.cap));
    const lo = Math.max(crop.base, Math.min(s.tmin[j], crop.cap));
    gdd += (hi + lo) / 2 - crop.base;
    if (gdd >= 0.45 * target && gdd <= 0.65 * target && s.tmax[j] >= crop.heat) heatDays++;
    if (age >= 21 && s.sw[j] < DROUGHT_SW) dryDays++;
    if (gdd >= target) {
      if (heatDays >= HEAT_DAYS) return { code: OUT.HEAT, days: age };
      if (rainfed && dryDays / Math.max(1, age - 21) > DROUGHT_FRAC) return { code: OUT.DROUGHT, days: age };
      return { code: OUT.OK, days: age };
    }
  }
}

// ---------------------------------------------------------------- statistics

export function median(a) {
  const v = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

const normCdf = (z) => {
  // Abramowitz & Stegun 26.2.17
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
};

/**
 * Robust monotonic trend: Theil–Sen slope with a Mann–Kendall significance
 * test (tie-corrected). Pairs with a non-finite y are dropped.
 */
export function trend(xs, ys) {
  const x = [], y = [];
  for (let i = 0; i < xs.length; i++) if (Number.isFinite(ys[i])) { x.push(xs[i]); y.push(ys[i]); }
  const n = x.length;
  if (n < 8) return { n, slope: NaN, intercept: NaN, p: NaN, significant: false };
  const slopes = [];
  let S = 0;
  for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) {
    slopes.push((y[j] - y[i]) / (x[j] - x[i]));
    S += Math.sign(y[j] - y[i]);
  }
  const ties = new Map();
  for (const v of y) ties.set(v, (ties.get(v) || 0) + 1);
  let varS = n * (n - 1) * (2 * n + 5);
  for (const t of ties.values()) varS -= t * (t - 1) * (2 * t + 5);
  varS /= 18;
  const z = varS > 0 ? (S - Math.sign(S)) / Math.sqrt(varS) : 0;
  const p = 2 * (1 - normCdf(Math.abs(z)));
  const slope = median(slopes);
  const intercept = median(y.map((v, i) => v - slope * x[i]));
  return { n, slope, intercept, p, significant: p < 0.05 };
}

// ------------------------------------------------------------------ analysis

/** Season years start on 1 Jan in the north and 1 Jul in the south, so a
 *  growing season never straddles the boundary. */
function seasonStarts(s, lat) {
  const y0 = new Date(s.t0).getUTCFullYear();
  const yN = new Date(s.t0 + (s.n - 1) * DAY).getUTCFullYear();
  const month = lat >= 0 ? 0 : 6;
  const out = [];
  for (let y = y0; y <= yN; y++) {
    const idx = Math.round((Date.UTC(y, month, 1) - s.t0) / DAY);
    if (idx >= 0 && idx < s.n) out.push({ year: y, idx, label: lat >= 0 ? String(y) : `${y}/${String(y + 1).slice(2)}` });
  }
  return out;
}

/** Share of each outcome by planting day, pooled over years (weighted) and a
 *  centred 7-day window. Returns one Float64Array per outcome code. */
function outcomeCurves(outcomes, weights, half = 3) {
  const nS = weights.length;
  const raw = Array.from({ length: N_OUT }, () => new Float64Array(SEASON_DAYS));
  const tot = new Float64Array(SEASON_DAYS);
  for (let k = 0; k < nS; k++) {
    if (!weights[k]) continue;
    for (let o = 0; o < SEASON_DAYS; o++) {
      const c = outcomes[k * SEASON_DAYS + o];
      if (c >= 0) { raw[c][o] += weights[k]; tot[o] += weights[k]; }
    }
  }
  const curves = Array.from({ length: N_OUT }, () => new Float64Array(SEASON_DAYS));
  for (let o = 0; o < SEASON_DAYS; o++) {
    let t = 0;
    const acc = new Float64Array(N_OUT);
    for (let q = Math.max(0, o - half); q <= Math.min(SEASON_DAYS - 1, o + half); q++) {
      t += tot[q];
      for (let c = 0; c < N_OUT; c++) acc[c] += raw[c][q];
    }
    for (let c = 0; c < N_OUT; c++) curves[c][o] = t > 0 ? acc[c] / t : (c === OUT.COLD ? 1 : 0);
  }
  return curves;
}

/** The planting window implied by a success curve: the contiguous stretch
 *  around the best day where the chance of success stays at 80% or better
 *  (or within 10% of the best achievable, where 80% is out of reach). */
export function windowFromCurve(success) {
  let best = 0;
  for (let o = 1; o < SEASON_DAYS; o++) if (success[o] > success[best]) best = o;
  const pMax = success[best];
  if (pMax <= 0) return null;
  const thr = Math.min(0.8, 0.9 * pMax);
  let open = best, close = best;
  while (open > 0 && success[open - 1] >= thr) open--;
  while (close < SEASON_DAYS - 1 && success[close + 1] >= thr) close++;
  // Centre "best" on the plateau rather than on a noisy first maximum.
  let lo = best, hi = best;
  while (lo > open && success[lo - 1] >= pMax - 0.02) lo--;
  while (hi < close && success[hi + 1] >= pMax - 0.02) hi++;
  let mean = 0;
  for (let o = open; o <= close; o++) mean += success[o];
  return { open, close, best: Math.round((lo + hi) / 2), pMax, pMean: mean / (close - open + 1), threshold: thr };
}

/** A single year's window: the run of successful planting days (small gaps
 *  tolerated) that overlaps the climatological season the most. */
function yearWindow(outcomes, k, centre) {
  let bestRun = null, start = -1, last = -1, count = 0;
  const flush = () => {
    if (start < 0) return;
    const lo = Math.max(start, centre - 90), hi = Math.min(last, centre + 90);
    const score = hi >= lo ? count : 0;
    if (score > 0 && (!bestRun || score > bestRun.score)) bestRun = { open: start, close: last, score };
    start = -1; count = 0;
  };
  for (let o = 0; o < SEASON_DAYS; o++) {
    if (outcomes[k * SEASON_DAYS + o] === OUT.OK) {
      if (start >= 0 && o - last > RUN_GAP + 1) flush();
      if (start < 0) start = o;
      last = o; count++;
    }
  }
  flush();
  return bestRun;
}

export function analyze(series, crop, lat, opts = {}) {
  const s = series.sw ? series : addWaterBalance(series, lat);
  const seasons = seasonStarts(s, lat);
  const nS = seasons.length;
  const outcomes = new Int8Array(nS * SEASON_DAYS);
  const cycle = new Int16Array(nS * SEASON_DAYS);
  seasons.forEach((se, k) => {
    let complete = true;
    for (let o = 0; o < SEASON_DAYS; o++) {
      const r = simulatePlanting(s, se.idx + o, crop, opts);
      outcomes[k * SEASON_DAYS + o] = r.code;
      cycle[k * SEASON_DAYS + o] = r.days ?? 0;
      if (r.code === OUT.UNKNOWN) complete = false;
    }
    se.complete = complete;
  });

  const done = seasons.filter((se) => se.complete);
  const lastYear = done.length ? done[done.length - 1].year : seasons[nS - 1].year;
  const firstYear = seasons[0].year;
  const w = (fn) => seasons.map((se) => (se.complete ? fn(se.year) : 0));
  const curves = {
    all: outcomeCurves(outcomes, w(() => 1)),
    // Recency-weighted: the climate of the last ~15 years counts most.
    recent: outcomeCurves(outcomes, w((y) => Math.exp(-(lastYear - y) / 15))),
    early: outcomeCurves(outcomes, w((y) => (y < firstYear + 20 ? 1 : 0))),
    late: outcomeCurves(outcomes, w((y) => (y > lastYear - 15 ? 1 : 0))),
  };
  const windows = {
    all: windowFromCurve(curves.all[OUT.OK]),
    recent: windowFromCurve(curves.recent[OUT.OK]),
    early: windowFromCurve(curves.early[OUT.OK]),
    late: windowFromCurve(curves.late[OUT.OK]),
  };
  const centre = windows.all ? windows.all.best : 180;

  // Per-year indicators.
  seasons.forEach((se, k) => {
    const yw = se.complete ? yearWindow(outcomes, k, centre) : null;
    se.open = yw ? yw.open : NaN;
    se.close = yw ? yw.close : NaN;
    se.length = yw ? yw.close - yw.open + 1 : (se.complete ? 0 : NaN);
    let lastFrost = NaN, firstFrost = NaN, gdd = 0, rain = 0;
    const end = Math.min(se.idx + SEASON_DAYS, s.n);
    for (let j = se.idx; j < end; j++) {
      const o = j - se.idx;
      if (s.tmin[j] <= 0) { if (o < 200) lastFrost = o; else if (Number.isNaN(firstFrost)) firstFrost = o; }
      const hi = Math.max(crop.base, Math.min(s.tmax[j], crop.cap)), lo = Math.max(crop.base, Math.min(s.tmin[j], crop.cap));
      gdd += (hi + lo) / 2 - crop.base;
      rain += s.rain[j];
    }
    const full = end - se.idx === SEASON_DAYS;
    se.lastFrost = full ? lastFrost : NaN;
    se.firstFrost = full ? firstFrost : NaN;
    se.gdd = full ? gdd : NaN;
    se.rain = full ? rain : NaN;
  });

  const years = seasons.map((se) => se.year);
  const tr = (key) => trend(years, seasons.map((se) => se[key]));
  const trends = { open: tr('open'), close: tr('close'), length: tr('length'), lastFrost: tr('lastFrost'), firstFrost: tr('firstFrost'), gdd: tr('gdd'), rain: tr('rain') };

  // Recommendation for the coming season.
  const win = windows.recent;
  const viable = !!win && win.pMax >= 0.4;
  let rec = null;
  if (win) {
    const reasons = new Float64Array(N_OUT);
    for (let o = win.open; o <= win.close; o++) for (let c = 0; c < N_OUT; c++) reasons[c] += curves.recent[c][o];
    for (let c = 0; c < N_OUT; c++) reasons[c] /= win.close - win.open + 1;

    // Weighted extras at the best day: frost after planting, dry spell, cycle length.
    let wSum = 0, drySpell = 0, frostAfter = 0;
    const cycles = [];
    seasons.forEach((se, k) => {
      if (!se.complete) return;
      const wt = Math.exp(-(lastYear - se.year) / 15);
      const d = se.idx + win.best;
      let run = 0, maxRun = 0;
      for (let j = d; j < d + 30; j++) { run = s.rain[j] < 1 ? run + 1 : 0; maxRun = Math.max(maxRun, run); }
      let frost = false;
      for (let j = d; j < d + 60; j++) if (s.tmin[j] <= 0) frost = true;
      wSum += wt; if (maxRun >= 10) drySpell += wt; if (frost) frostAfter += wt;
      const c = cycle[k * SEASON_DAYS + win.best];
      if (c > 0) cycles.push(c);
    });

    // Which season is "this season"? The first whose window has not closed.
    const lastIdx = s.n - 1;
    const month = lat >= 0 ? 0 : 6;
    let ty = new Date(s.t0 + lastIdx * DAY).getUTCFullYear() - 1;
    let startMs;
    do { ty++; startMs = Date.UTC(ty, month, 1); } while (startMs + win.close * DAY < s.t0 + lastIdx * DAY);
    const todayOffset = Math.round((s.t0 + lastIdx * DAY - startMs) / DAY);

    let t7 = 0, r14 = 0;
    for (let j = lastIdx - 6; j <= lastIdx; j++) t7 += (s.tmin[j] + s.tmax[j]) / 2;
    for (let j = lastIdx - 13; j <= lastIdx; j++) r14 += s.rain[j];

    rec = {
      ...win,
      viable,
      risk: Math.round(100 * (1 - win.pMean)),
      reasons,
      drySpellProb: drySpell / wSum,
      frostAfterProb: frostAfter / wSum,
      cycleDays: median(cycles),
      seasonStartMs: startMs,
      seasonLabel: lat >= 0 ? String(ty) : `${ty}/${String(ty + 1).slice(2)}`,
      inWindowNow: todayOffset >= win.open && todayOffset <= win.close,
      daysToOpen: win.open - todayOffset,
      now: { dateMs: s.t0 + lastIdx * DAY, tmean7: t7 / 7, rain14: r14, soilWater: s.sw[lastIdx], warmEnough: t7 / 7 >= crop.germ, moistEnough: !!opts.irrigated || s.sw[lastIdx] >= DRY_START_SW },
    };
  }

  return { seasons, outcomes, curves, windows, trends, rec, lat, firstYear, lastYear, southern: lat < 0, refStartMs: Date.UTC(2023, lat >= 0 ? 0 : 6, 1) };
}

/** Risk score (0–100) to a plain-language band. */
export function riskBand(risk) {
  if (risk < 15) return { key: 'low', label: 'Low risk' };
  if (risk < 30) return { key: 'moderate', label: 'Moderate risk' };
  if (risk < 50) return { key: 'high', label: 'High risk' };
  return { key: 'very-high', label: 'Very high risk' };
}

/** Day-of-season offset to a calendar label such as "May 3". */
export function offsetLabel(result, offset, opts = { month: 'short', day: 'numeric' }) {
  return new Date(result.refStartMs + offset * DAY).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });
}
