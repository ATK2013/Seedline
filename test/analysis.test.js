import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePower, addWaterBalance, simulatePlanting, analyze, trend, windowFromCurve, extraterrestrialRadiation, OUT } from '../js/analysis.js';
import { CROPS } from '../js/crops.js';

const DAY = 86400000;

/** Synthetic temperate climate: sinusoidal temperatures, steady light rain,
 *  with an optional warming trend in °C per year. */
function synthetic({ years = 30, warming = 0, rain = 3, mean = 9, amp = 14 } = {}) {
  const t0 = Date.UTC(1981, 0, 1);
  const n = Math.round((Date.UTC(1981 + years, 0, 1) - t0) / DAY);
  const s = { t0, n, tmin: new Float32Array(n), tmax: new Float32Array(n), rain: new Float32Array(n), rs: new Float32Array(n).fill(NaN) };
  for (let i = 0; i < n; i++) {
    const d = new Date(t0 + i * DAY);
    const doy = (d - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY;
    const t = mean + warming * (i / 365.25) - amp * Math.cos((2 * Math.PI * (doy - 15)) / 365);
    s.tmin[i] = t - 6;
    s.tmax[i] = t + 6;
    s.rain[i] = rain;
  }
  return s;
}

test('parsePower fills gaps and trims the unfinished tail', () => {
  const mk = (vals) => Object.fromEntries(vals.map((v, i) => [`1981010${i + 1}`, v]));
  const s = parsePower({ properties: { parameter: {
    T2M_MIN: mk([1, -999, 3, -999]), T2M_MAX: mk([10, 11, 12, -999]), PRECTOTCORR: mk([0, -999, 5, -999]), ALLSKY_SFC_SW_DWN: mk([-999, 12, 13, -999]),
  } } });
  assert.equal(s.n, 3);
  assert.deepEqual([...s.tmin], [1, 1, 3]);
  assert.deepEqual([...s.rain], [0, 0, 5]);
  assert.ok(Number.isNaN(s.rs[0]));
});

test('extraterrestrial radiation matches FAO-56 worked example', () => {
  // FAO-56 example 8: 20°S on 3 September (doy 246) gives 32.2 MJ m-2 day-1.
  assert.ok(Math.abs(extraterrestrialRadiation(-20, 246) - 32.2) < 0.3);
});

test('trend recovers a known slope and flags it significant', () => {
  const xs = Array.from({ length: 40 }, (_, i) => 1981 + i);
  const t = trend(xs, xs.map((x, i) => 120 - 0.5 * (x - 1981) + ((i * 7) % 5) - 2));
  assert.ok(Math.abs(t.slope + 0.5) < 0.1);
  assert.ok(t.significant);
  const flat = trend(xs, xs.map((_, i) => ((i * 7919) % 13)));
  assert.ok(!flat.significant);
});

test('windowFromCurve finds the plateau around the best day', () => {
  const p = new Float64Array(365);
  for (let o = 100; o <= 140; o++) p[o] = 0.9;
  p[99] = 0.5; p[141] = 0.5;
  const w = windowFromCurve(p);
  assert.deepEqual([w.open, w.close, w.best], [100, 140, 120]);
});

test('planting in midwinter fails cold; planting in spring succeeds', () => {
  const s = addWaterBalance(synthetic(), 45);
  const jan = 366 + 10, may = 366 + 135, aug = 366 + 230;
  assert.equal(simulatePlanting(s, jan, CROPS.maize).code, OUT.COLD);
  assert.equal(simulatePlanting(s, may, CROPS.maize).code, OUT.OK);
  assert.equal(simulatePlanting(s, aug, CROPS.maize).code, OUT.SHORT);
});

test('a rainless climate fails rainfed crops but not irrigated ones', () => {
  const s = addWaterBalance(synthetic({ rain: 0 }), 45);
  const may = 366 + 135;
  assert.equal(simulatePlanting(s, may, CROPS.maize).code, OUT.DRY_START);
  assert.equal(simulatePlanting(s, may, CROPS.maize, { irrigated: true }).code, OUT.OK);
});

test('analyze recommends a low-risk spring window in a stable climate', () => {
  const r = analyze(synthetic(), CROPS.maize, 45);
  assert.ok(r.rec.viable);
  assert.ok(r.rec.risk <= 5);
  assert.ok(r.rec.open > 90 && r.rec.close < 200, `window ${r.rec.open}-${r.rec.close}`);
  assert.ok(!r.trends.open.significant);
});

test('analyze detects the window opening earlier under warming', () => {
  const r = analyze(synthetic({ years: 40, warming: 0.08 }), CROPS.maize, 45);
  assert.ok(r.trends.open.slope < 0);
  assert.ok(r.trends.open.significant);
  assert.ok(r.windows.late.open < r.windows.early.open);
  assert.ok(r.trends.gdd.slope > 0);
});

test('southern hemisphere seasons run July to June', () => {
  const s = synthetic();
  // Flip the seasons by shifting half a year.
  const flip = { ...s, tmin: new Float32Array(s.n), tmax: new Float32Array(s.n) };
  for (let i = 0; i < s.n; i++) { flip.tmin[i] = s.tmin[(i + 182) % s.n]; flip.tmax[i] = s.tmax[(i + 182) % s.n]; }
  const r = analyze(flip, CROPS.maize, -35);
  assert.ok(r.rec.viable);
  assert.equal(r.seasons[0].label, '1981/82');
  assert.ok(r.rec.open > 90 && r.rec.close < 200);
});

// ------------------------------------------------------- satellite check
import { compositeDates, greenUp, spearman, ndviTargets, compareNdvi } from '../js/ndvi.js';

test('compositeDates follows the MODIS 16-day calendar across a year end', () => {
  const d = compositeDates(Date.UTC(2020, 11, 1), 4).map((c) => c.modis);
  assert.deepEqual(d, ['A2020337', 'A2020353', 'A2021001', 'A2021017']);
  assert.equal(compositeDates(Date.UTC(2020, 2, 22), 10)[0].modis, 'A2020097');
});

/** A logistic green-up centred on `midMs`, sampled every 16 days. */
function ndviSeries(startMs, midMs, { lo = 0.2, hi = 0.85 } = {}) {
  return compositeDates(startMs, 10).map((c) => ({ ms: c.ms, ndvi: lo + (hi - lo) / (1 + Math.exp(-(c.ms + 8 * DAY - midMs) / (9 * DAY))) }));
}

test('greenUp dates the half-amplitude crossing and ignores a cloud dip', () => {
  const mid = Date.UTC(2020, 5, 10);
  const pts = ndviSeries(Date.UTC(2020, 2, 22), mid);
  const g = greenUp(pts);
  assert.ok(Math.abs(g.ms - mid) < 5 * DAY, `off by ${(g.ms - mid) / DAY} days`);
  pts[6].ndvi -= 0.35;   // one cloudy composite on the rising limb
  assert.ok(Math.abs(greenUp(pts).ms - mid) < 9 * DAY);
  assert.equal(greenUp(pts.map((p) => ({ ...p, ndvi: 0.3 }))), null);
});

test('spearman is 1 for a monotonic relation and -1 for its reverse', () => {
  const a = [3, 1, 4, 1.5, 9, 2.6];
  assert.ok(Math.abs(spearman(a, a.map((v) => v * v)) - 1) < 1e-9);
  assert.ok(Math.abs(spearman(a, a.map((v) => -v)) + 1) < 1e-9);
});

test('compareNdvi agrees when green-up follows sowing in the window, and flags an early pixel', () => {
  const r = analyze(synthetic(), CROPS.maize, 45);
  const targets = ndviTargets(r, 10);
  assert.equal(targets.length, 10);
  const lag = CROPS.maize.emerge + 30;
  const season = (y) => r.seasons.find((s) => s.year === y);
  const obs = (shift) => targets.map((t) => ({ year: t.year, points: ndviSeries(t.dates[0].ms, season(t.year).startMs + (r.rec.best + lag + shift) * DAY) }));
  const ok = compareNdvi(r, CROPS.maize, obs(0));
  assert.equal(ok.summary.verdict, 'agrees');
  assert.ok(Math.abs(ok.summary.offset) < 6);
  const early = compareNdvi(r, CROPS.maize, obs(-70));
  assert.equal(early.summary.verdict, 'earlier');
  const flat = compareNdvi(r, CROPS.maize, targets.map((t) => ({ year: t.year, points: t.dates.map((c) => ({ ms: c.ms, ndvi: 0.25 })) })));
  assert.equal(flat.summary.verdict, 'no-crop');
});
