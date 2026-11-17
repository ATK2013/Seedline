// Bump ?v= here and in index.html whenever these files change, so browsers
// never pair a new page with stale cached scripts or styles.
import { CROPS, MATURITY } from './crops.js?v=6';
import { fetchDaily } from './power.js?v=6';
import { ndviTargets, compareNdvi, assignGreenups, TOLERANCE } from './ndvi.js?v=6';
import { fetchNdvi, fetchGreenups } from './modis.js?v=6';
import { fetchForecast, outlook } from './forecast.js?v=6';
import { parsePower, analyze, riskBand, looksLikeWater, SOILS, OUT, SEASON_DAYS } from './analysis.js?v=6';
import { LANGS, t, setLang, getLang, locale, applyStatic } from './i18n.js?v=6';

const $ = (id) => document.getElementById(id);
const DAY = 86400000;
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* blocked or full */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* blocked */ } },
};

// Outcome display order = stacking order = validated palette order.
const OUTCOMES = [
  { code: OUT.FROST, key: 'frost' }, { code: OUT.DRY_START, key: 'dry' }, { code: OUT.COLD, key: 'cold' }, { code: OUT.DROUGHT, key: 'drought' },
  { code: OUT.HEAT, key: 'heat' }, { code: OUT.SHORT, key: 'short' }, { code: OUT.WINTER, key: 'winter' },
];
const byCode = Object.fromEntries(OUTCOMES.map((o) => [o.code, o]));
const ICON = { maize: '🌽', soybean: '🫘', wheat: '🌾', winterwheat: '❄️', rice: '🍚', sorghum: '🌱', millet: '🌿', cotton: '☁️', potato: '🥔', bean: '🫛', sunflower: '🌻' };
const pct = (v) => `${Math.round(v * 100)}%`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cropName = (k) => t(`crop.${k}`);

// ------------------------------------------------------- language and units

let units = ls.get('seedline:units') === 'imperial' ? 'imperial' : 'metric';
setLang(ls.get('seedline:lang') || (navigator.language || 'en').slice(0, 2));
const imperial = () => units === 'imperial';
const fT = (c, digits = 1) => (imperial() ? `${Math.round(c * 1.8 + 32)} °F` : `${c.toFixed(digits)} °C`);
const fThr = (c) => (imperial() ? `${Math.round(c * 1.8 + 32)} °F` : `${c} °C`);
const fR = (mm) => (imperial() ? `${(mm / 25.4).toFixed(1)} in` : `${Math.round(mm)} mm`);
const fmtDate = (ms, opts = { month: 'short', day: 'numeric' }) => new Date(ms).toLocaleDateString(locale(), { ...opts, timeZone: 'UTC' });

for (const [k, name] of Object.entries(LANGS)) $('lang').add(new Option(name, k));
$('lang').value = getLang();
$('units').value = units;
$('lang').addEventListener('change', () => { setLang($('lang').value); ls.set('seedline:lang', getLang()); refreshText(); });
$('units').addEventListener('change', () => { units = $('units').value; ls.set('seedline:units', units); if (current) render(); });

function refreshText() {
  applyStatic();
  for (const [k, m] of Object.entries(MATURITY)) [...$('maturity').options].find((o) => o.value === k).textContent = t(`mat.${k}`);
  buildChips();
  buildAssume();
  if (current) render();
}

// ------------------------------------------------------------------ controls

let cropKey = 'maize';
for (const k of Object.keys(MATURITY)) $('maturity').add(new Option(k, k));
$('maturity').value = 'medium';

function buildChips() {
  $('cropChips').innerHTML = Object.keys(CROPS).map((k) => `<button type="button" role="radio" class="chip" data-crop="${k}" aria-checked="${k === cropKey}"><span aria-hidden="true">${ICON[k]}</span>${esc(cropName(k))}</button>`).join('');
}
function setCrop(k) { cropKey = k; buildChips(); buildAssume(); }
$('cropChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-crop]');
  if (!b) return;
  setCrop(b.dataset.crop);
  if (pin) run();
});

// Crop assumptions: generic defaults the user (or an agronomist) can correct.
const ASSUME = ['gdd', 'base', 'germ', 'frostKill', 'heat'];
const overrides = (k) => { try { return JSON.parse(ls.get(`seedline:crop:${k}`)) || {}; } catch { return {}; } };
const cropFor = (k) => ({ ...CROPS[k], ...overrides(k) });
function buildAssume() {
  const ov = overrides(cropKey);
  $('assumeFields').innerHTML = ASSUME.map((f) => `<label>${esc(t(`assume.${f}`))} <input type="number" step="any" data-field="${f}" value="${ov[f] ?? CROPS[cropKey][f]}"></label>`).join('');
  $('assumeFlag').hidden = !Object.keys(ov).length;
}
$('assumeFields').addEventListener('change', (e) => {
  const f = e.target.dataset.field, v = parseFloat(e.target.value);
  if (!f) return;
  const ov = overrides(cropKey);
  if (Number.isFinite(v) && v !== CROPS[cropKey][f]) ov[f] = v; else delete ov[f];
  if (Object.keys(ov).length) ls.set(`seedline:crop:${cropKey}`, JSON.stringify(ov)); else ls.del(`seedline:crop:${cropKey}`);
  buildAssume();
  if (pin) run();
});
$('assumeReset').addEventListener('click', () => { ls.del(`seedline:crop:${cropKey}`); buildAssume(); if (pin) run(); });

// ----------------------------------------------------------------------- map

const map = L.map('map', { worldCopyJump: true, zoomControl: false }).setView([20, 10], 3);
L.control.zoom({ position: 'bottomright' }).addTo(map);
const streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 17, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' });
L.control.layers({ Map: streets, Satellite: satellite }, null, { collapsed: false, position: 'bottomleft' }).addTo(map);
const pinIcon = L.divIcon({ className: 'pin', html: '<svg viewBox="0 0 32 42" width="32" height="42"><path d="M16 41C16 41 30 25.5 30 15A14 14 0 0 0 2 15C2 25.5 16 41 16 41Z" fill="var(--accent)" stroke="#fff" stroke-width="2"/><path d="M16 23v-8m0 1c0-4-2.500-5.500-5.500-5.500 0 3.500 2 5.500 5.500 5.500Zm0 2.500c0-3 2-4.500 5-4.500 0 3-2 4.500-5 4.500Z" fill="#fff" stroke="#fff" stroke-width="1.200" stroke-linecap="round"/></svg>', iconSize: [32, 42], iconAnchor: [16, 41] });
let pin = null;

function setPin(lat, lon, { pan = false } = {}) {
  lon = ((lon + 540) % 360) - 180;
  $('lat').value = lat.toFixed(4);
  $('lon').value = lon.toFixed(4);
  if (!pin) pin = L.marker([lat, lon], { icon: pinIcon }).addTo(map); else pin.setLatLng([lat, lon]);
  if (pan) map.setView([lat, lon], Math.max(map.getZoom(), 7));
}

// The map starts as the whole screen so a field is easy to find; once a pin is
// down it shrinks into the side panel. "Full-screen map" brings it back.
const picking = () => document.body.classList.contains('picking');
function setPicking(on) {
  document.body.classList.toggle('picking', on);
  $('pickDone').hidden = !pin;
  if (on) scrollTo(0, 0);
  map.invalidateSize();
  if (pin) map.setView(pin.getLatLng(), Math.max(map.getZoom(), on ? 5 : 7), { animate: false });
}
function choose(lat, lon) {
  const wasPicking = picking();
  setPin(lat, lon, { pan: !wasPicking });
  run();
  if (wasPicking) setTimeout(() => setPicking(false), 550);
}
map.on('click', (e) => choose(e.latlng.lat, e.latlng.lng));
$('expand').addEventListener('click', () => setPicking(true));
$('pickDone').addEventListener('click', () => setPicking(false));
addEventListener('keydown', (e) => { if (e.key === 'Escape' && picking() && pin) setPicking(false); });

const pickMsg = (text) => { $('searchMsg').hidden = false; $('searchMsg').textContent = text; };
$('search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('q').value.trim();
  if (!q) return;
  pickMsg(t('search.busy'));
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
    const hit = (await res.json())[0];
    if (!hit) return pickMsg(t('search.none', { q }));
    const [s, n, w, e2] = hit.boundingbox.map(Number);
    map.fitBounds([[s, w], [n, e2]], { maxZoom: 12 });
    pickMsg(t('search.ok'));
  } catch { pickMsg(t('search.fail')); }
});

$('controls').addEventListener('submit', (e) => { e.preventDefault(); choose(+$('lat').value, +$('lon').value); });
for (const id of ['maturity', 'irrigated', 'soil']) $(id).addEventListener('change', () => { if (pin) run(); });
document.querySelectorAll('.locate').forEach((btn) => btn.addEventListener('click', () => {
  const fail = (text) => { if (picking()) pickMsg(text); else showStatus(t('loc.title'), text); };
  if (!navigator.geolocation) return fail(t('loc.none'));
  navigator.geolocation.getCurrentPosition((p) => choose(p.coords.latitude, p.coords.longitude), () => fail(t('loc.fail')));
}));
document.querySelectorAll('[data-example]').forEach((b) => b.addEventListener('click', () => {
  const [lat, lon, crop] = b.dataset.example.split(',');
  setCrop(crop);
  if (picking()) map.setView([+lat, +lon], 6, { animate: false });
  choose(+lat, +lon);
}));

function showStatus(title, body, kind = 'info') {
  const el = $('status');
  el.hidden = false;
  el.className = `status ${kind}`;
  el.innerHTML = `${kind === 'loading' ? '<div class="sprout" aria-hidden="true"><i></i><i></i><i></i></div>' : ''}<h2>${esc(title)}</h2><p>${esc(body)}</p>${kind === 'loading' ? '<div class="progress"><span></span></div>' : ''}`;
}

// ---------------------------------------------------------------------- run

let runId = 0;
let current = null;

function applyHash(hash) {
  const h = hash.replace(/^#/, '').split(',');
  if (!(h.length >= 3 && h[0] !== '' && Number.isFinite(+h[0]) && Number.isFinite(+h[1]) && CROPS[h[2]])) return false;
  setCrop(h[2]);
  if (MATURITY[h[3]]) $('maturity').value = h[3];
  $('irrigated').checked = h[4] === '1';
  if (SOILS[h[5]]) $('soil').value = h[5];
  setPicking(false);
  setPin(+h[0], +h[1], { pan: true });
  run();
  return true;
}

async function run() {
  const lat = +$('lat').value, lon = +$('lon').value;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) return;
  const id = ++runId;
  ndviRun++;
  ndviAbort?.abort();
  const maturity = $('maturity').value, irrigated = $('irrigated').checked, soil = $('soil').value;
  const key = cropKey;
  location.hash = `${lat.toFixed(4)},${lon.toFixed(4)},${key},${maturity},${irrigated ? 1 : 0},${soil}`;
  ls.set('seedline:last', location.hash);
  $('go').disabled = true;
  $('output').hidden = true;
  $('offlineNote').hidden = true;
  showStatus(t('loading.title'), t('loading.body', { lat: lat.toFixed(2), lon: lon.toFixed(2), crop: cropName(key).toLowerCase() }), 'loading');
  try {
    const json = await fetchDaily(lat, lon);
    if (id !== runId) return;
    const series = parsePower(json);
    if (series.n < 365 * 20) throw new Error('NASA POWER returned too little data for this point');
    if (looksLikeWater(series, json.geometry?.coordinates?.[2] ?? 100)) {
      current = null;
      return showStatus(t('water.title'), t('water.body', { lat: lat.toFixed(2), lon: lon.toFixed(2) }), 'error');
    }
    const crop = cropFor(key);
    const opts = { irrigated, gddScale: MATURITY[maturity].scale, soilCapacity: SOILS[soil] };
    const result = analyze(series, crop, lat, opts);
    current = { series, result, crop, cropKey: key, lat, lon, irrigated, maturity, soil, opts };
    // Unhide first: the charts measure their containers to size themselves.
    $('status').hidden = true;
    $('output').hidden = false;
    $('offlineNote').hidden = navigator.onLine !== false;
    render();
    loadForecast(current);
    setTimeout(() => computeAlternatives(current), 60);
  } catch (e) {
    if (id !== runId) return;
    $('output').hidden = true;
    showStatus(t('error.title'), t('error.body', { msg: e.message || e }), 'error');
  } finally {
    if (id === runId) $('go').disabled = false;
  }
}

// ------------------------------------------------------------------- render

function render() {
  renderRec();
  renderRisk();
  renderShift();
  renderHeat();
  renderTable();
  if (current.ndvi) renderNdvi(); else resetNdvi();
  renderSatStrip();
  renderForecast();
  renderAlternatives();
}
let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => current && render(), 150); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => current && renderHeat());

const lab = (o) => fmtDate(current.result.refStartMs + ((((o % 365) + 365) % 365)) * DAY);
const seasonDate = (rec, o) => fmtDate(rec.seasonStartMs + o * DAY);

function topReasons(reasons, n = 3) {
  return OUTCOMES.map((o) => ({ ...o, share: reasons[o.code] })).filter((o) => o.share >= 0.01).sort((a, b) => b.share - a.share).slice(0, n);
}

function shiftSentence() {
  const { windows, firstYear, lastYear } = current.result;
  const a = windows.early, b = windows.late;
  if (!a || !b || a.pMax < 0.4 || b.pMax < 0.4) return '';
  const part = (d, what) => t(`${what}.${Math.abs(d) < 2 ? 'same' : d < 0 ? 'earlier' : 'later'}`, { n: Math.abs(d) });
  return t('shift.cmp', { a: `${firstYear}–${firstYear + 19}`, b: `${lastYear - 14}–${lastYear}`, opens: part(b.open - a.open, 'opens'), closes: part(b.close - a.close, 'closes') });
}

const BAND_COLOR = { low: '--good', moderate: '--warning', high: '--serious', 'very-high': '--critical' };
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let animateNext = true;   // only count the dial up on a fresh result, not on every re-render

function gaugeSvg(risk, band) {
  const len = Math.PI * 54, to = len * (1 - Math.max(0.03, risk / 100));
  const still = reduceMotion || !animateNext;
  return `<svg class="gauge" viewBox="0 0 140 86" role="img" aria-label="${risk} / 100">
    <path d="M16 74A54 54 0 0 1 124 74" fill="none" stroke="var(--surface-2)" stroke-width="12" stroke-linecap="round"/>
    <path class="arc" d="M16 74A54 54 0 0 1 124 74" fill="none" stroke="var(${BAND_COLOR[band.key]})" stroke-width="12" stroke-linecap="round" stroke-dasharray="${len}" stroke-dashoffset="${still ? to : len}" data-to="${to}"/>
    <text class="num" x="70" y="70" text-anchor="middle" data-count="${risk}">${still ? risk : 0}</text>
  </svg>`;
}
function animateGauge(el) {
  const arc = el.querySelector('.arc'), num = el.querySelector('.num');
  if (!arc || reduceMotion || !animateNext) return;
  animateNext = false;
  requestAnimationFrame(() => requestAnimationFrame(() => arc.setAttribute('stroke-dashoffset', arc.dataset.to)));
  const to = +num.dataset.count, t0 = performance.now();
  const tick = (now) => {
    const k = Math.min(1, (now - t0) / 900);
    num.textContent = Math.round(to * (1 - (1 - k) ** 3));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** A year at a glance: greener = better odds for planting that day. */
function ribbonHtml(rec) {
  const ok = current.result.curves.recent[OUT.OK];
  const pos = (o) => `${((((o % 365) + 365) % 365) / 365) * 100}%`;
  let cells = '';
  for (let o = 0; o < SEASON_DAYS; o += 3) cells += `<i style="opacity:${(0.06 + 0.94 * ok[o]).toFixed(2)}"></i>`;
  const months = monthTicks(current.result).map((m) => `<span style="left:${pos(m.o)}">${m.label}</span>`).join('');
  const today = Math.round((Date.now() - rec.seasonStartMs) / DAY);
  const marks = [`<div class="mark today" style="left:${pos(today)}"><b>${t('mark.today')}</b></div>`];
  if (rec.viable) {
    marks.push(`<div class="bracket" style="left:${pos(rec.open)};width:${((rec.close - rec.open) / 365) * 100}%"></div>`);
    marks.push(`<div class="mark best" style="left:${pos(rec.best)}"><b>${t('mark.best')}</b></div>`);
    const mat = rec.best + rec.cycleDays;
    if (mat < 365) marks.push(`<div class="mark harvest" style="left:${pos(mat)}"><b>${t('mark.mature')}</b></div>`);
  }
  return `<div class="ribbon"><div class="strip">${cells}</div>${marks.join('')}<div class="months">${months}</div></div>
    <div class="ribbonkey"><span>${t('ribbon.poor')}</span><i></i><span>${t('ribbon.good')}</span></div>`;
}

const actionsHtml = () => `<div class="actions"><button type="button" class="ghost" data-act="print">${t('act.print')}</button><button type="button" class="ghost" data-act="copy">${t('act.copy')}</button></div>`;
function wireActions(el) {
  el.querySelector('[data-act=print]')?.addEventListener('click', () => print());
  el.querySelector('[data-act=copy]')?.addEventListener('click', async (e) => {
    try { await navigator.clipboard.writeText(location.href); e.target.textContent = t('act.copied'); } catch { prompt(t('act.copy'), location.href); }
  });
}

function renderRec() {
  const { result, crop, irrigated, cropKey: key } = current;
  const rec = result.rec;
  const el = $('rec');
  const where = `${current.lat.toFixed(2)}°, ${current.lon.toFixed(2)}°`;
  const icon = `<span class="cropicon" aria-hidden="true">${ICON[key]}</span>`;
  if (!rec || !rec.viable) {
    const why = rec ? topReasons(rec.reasons, 2) : [];
    const dry = why.some((w) => w.key === 'dry' || w.key === 'drought');
    el.className = 'card rec nogo';
    el.innerHTML = `
      <div class="eyebrow">${where}</div>
      <div class="headline">${icon}${esc(t('nogo.title', { crop: cropName(key) }))}</div>
      <p class="lede">${esc(rec ? t('nogo.best', { date: lab(rec.best), p: pct(rec.pMax) }) : t('nogo.none'))}
      ${why.length ? esc(t('nogo.obstacle', { list: why.map((w) => t(`out.${w.key}`).toLowerCase()).join(', ') })) : ''}
      ${esc(dry && !irrigated ? t('nogo.irrigate') : t('nogo.try'))}</p>
      ${rec ? ribbonHtml(rec) : ''}${actionsHtml()}`;
    wireActions(el);
    return;
  }
  const band = riskBand(rec.risk);
  const why = topReasons(rec.reasons);
  const n = rec.now;
  let timing;
  if (rec.inWindowNow) {
    const ready = n.warmEnough && n.moistEnough;
    timing = `<b>${t('now.open')}</b> ${t(ready ? 'now.ready' : 'now.hold')}: ${t('now.temp', { t: fT(n.tmean7), g: fThr(crop.germ) })}${irrigated ? '' : `; ${t('now.soil', { p: pct(n.soilWater), n: pct(crop.dryStart ?? 0.2) })}`}.`;
  } else {
    timing = `${t('now.opens', { n: rec.daysToOpen })} ${t('now.latest', { date: fmtDate(n.dateMs), t: fT(n.tmean7), r: fR(n.rain14) })}`;
  }
  el.className = 'card rec';
  el.innerHTML = `
    <div class="rechead">
      <div>
        <div class="eyebrow">${esc(t('rec.season', { season: rec.seasonLabel }))} · ${where}</div>
        <div class="kicker">${icon}${esc(t('rec.plant', { crop: cropName(key).toLowerCase() }))}</div>
        <div class="headline">${esc(seasonDate(rec, rec.open))} <span class="dash">→</span> ${esc(seasonDate(rec, rec.close))}</div>
        <p class="lede">${t('rec.best', { date: `<b>${esc(lab(rec.best))}</b>` })} ${esc(shiftSentence())}</p>
      </div>
      <div class="gaugebox">${gaugeSvg(rec.risk, band)}<div class="band"><i class="${band.key}"></i>${t(`band.${band.key}`)}</div><div class="gaugecap">${t('gauge.cap')}</div></div>
    </div>
    ${ribbonHtml(rec)}
    <div id="satStrip" class="satstrip"></div>
    <div id="outlook" class="outlook"></div>
    <div class="tiles">
      <div class="tile"><div class="k">${t('tile.success.k')}</div><div class="v">${pct(rec.pMean)}</div><div class="d">${t('tile.success.d')}</div></div>
      <div class="tile"><div class="k">${t('tile.maturity.k')}</div><div class="v">${esc(lab(rec.best + rec.cycleDays))}</div><div class="d">${esc(t('tile.maturity.d', { n: Math.round(rec.cycleDays), date: lab(rec.best) }))}</div></div>
      <div class="tile"><div class="k">${t('tile.dry.k')}</div><div class="v">${pct(rec.drySpellProb)}</div><div class="d">${t('tile.dry.d')}</div></div>
      <div class="tile"><div class="k">${t('tile.frost.k', { t: fThr(0) })}</div><div class="v">${pct(rec.frostAfterProb)}</div><div class="d">${t('tile.frost.d')}</div></div>
    </div>
    ${why.length ? `<div class="why">${t('why')} ${why.map((w) => `<span><i class="sw" style="background:var(--o-${w.key})"></i>${esc(t(`out.${w.key}`))} ${pct(w.share)}</span>`).join('')}</div>` : ''}
    <div class="now">${timing}</div>${actionsHtml()}`;
  wireActions(el);
  animateGauge(el);
}

/** Then-versus-now strips for the window shift card. */
function thenNowHtml() {
  const { windows, firstYear, lastYear } = current.result;
  const a = windows.early, b = windows.late;
  if (!a || !b || a.pMax < 0.4 || b.pMax < 0.4) return '';
  const lo = Math.max(0, Math.min(a.open, b.open) - 12), hi = Math.min(364, Math.max(a.close, b.close) + 12);
  const row = (w, label, cls) => `<div class="tnrow"><span class="tnlabel">${label}</span><div class="tntrack"><div class="tnbar ${cls}" style="left:${((w.open - lo) / (hi - lo)) * 100}%;width:${Math.max(1.5, ((w.close - w.open) / (hi - lo)) * 100)}%"><em>${esc(lab(w.open))}</em><em>${esc(lab(w.close))}</em></div></div></div>`;
  return `<div class="thennow">${row(a, `${firstYear}–${String(firstYear + 19).slice(2)}`, 'then')}${row(b, `${lastYear - 14}–${String(lastYear).slice(2)}`, 'nowbar')}</div>`;
}

// ----------------------------------------------------------------- forecast

async function loadForecast(run) {
  run.forecast = { state: 'loading' };
  try {
    const days = await fetchForecast(run.lat, run.lon);
    run.forecast = { state: 'ok', days };
  } catch { run.forecast = { state: 'failed' }; }
  if (run === current) renderForecast();
}

function renderForecast() {
  const el = $('outlook');
  if (!el) return;
  const f = current.forecast, { crop, result, irrigated } = current;
  if (!f || f.state === 'loading') { el.innerHTML = ''; return; }
  if (f.state === 'failed') { el.className = 'outlook quiet'; el.innerHTML = `<span>${t('fc.fail')}</span>`; return; }
  const o = outlook(f.days, crop, result.rec, { irrigated });
  if (o.status === 'none') { el.innerHTML = ''; return; }
  if (o.status === 'far') { el.className = 'outlook quiet'; el.innerHTML = `<span>${t('fc.far')}</span>`; return; }
  const reason = (r) => (r === 'cold' ? t('fc.cold', { t: fT(o.tmean7), g: fThr(crop.germ) }) : r === 'frost' ? t('fc.frost', { date: fmtDate(o.frostMs, { weekday: 'short', month: 'short', day: 'numeric' }) }) : t('fc.dry', { r: fR(o.rain7) }));
  const list = o.reasons.map(reason).join('; ');
  let head;
  if (o.status === 'go') head = `<b>${t('fc.go')}</b> ${esc(t('fc.go.d', { t: fT(o.tmean7) }))}`;
  else if (o.status === 'wait') head = `<b>${t('fc.wait')}</b> ${esc(list)}.`;
  else head = `<b>${t('fc.soon', { n: Math.max(1, o.daysToOpen) })}</b> ${o.reasons.length ? `${t('fc.soon.watch')} ${esc(list)}.` : t('fc.soon.ok')}`;
  const kill = crop.winter ? crop.winter.kill : crop.frostKill;
  const maxRain = Math.max(5, ...o.days.map((d) => d.rain));
  const cells = o.days.map((d) => `<div class="fcday${d.tmin <= kill ? ' frost' : ''}" title="${esc(fmtDate(d.ms, { weekday: 'short', month: 'short', day: 'numeric' }))}: ${fT(d.tmin, 0)} – ${fT(d.tmax, 0)}, ${fR(d.rain)}">
      <span class="fcd">${new Date(d.ms).getUTCDate()}</span><span class="fct">${imperial() ? Math.round(d.tmax * 1.8 + 32) : Math.round(d.tmax)}°</span><span class="fcn">${imperial() ? Math.round(d.tmin * 1.8 + 32) : Math.round(d.tmin)}°</span>
      <span class="fcr"><i style="height:${Math.round((d.rain / maxRain) * 100)}%"></i></span></div>`).join('');
  el.className = `outlook ${o.status}${o.status === 'soon' && o.reasons.length ? ' watch' : ''}`;
  el.innerHTML = `<div class="fchead"><span class="fctitle">${t('fc.title')}</span><span>${head}</span></div><div class="fcdays">${cells}</div><div class="fcsrc">${t('fc.src')}</div>`;
}

// ------------------------------------------------------------- alternatives

function computeAlternatives(run) {
  const base = run.opts;
  const summarise = (result) => ({ rec: result.rec, viable: !!result.rec?.viable, risk: result.rec?.viable ? result.rec.risk : 101, refStartMs: result.refStartMs });
  const maturities = Object.keys(MATURITY).map((m) => ({ key: m, ...summarise(m === run.maturity ? run.result : analyze(run.series, run.crop, run.lat, { ...base, gddScale: MATURITY[m].scale })) }));
  const crops = Object.keys(CROPS).map((k) => ({ key: k, ...summarise(k === run.cropKey ? run.result : analyze(run.series, cropFor(k), run.lat, base)) }));
  crops.sort((a, b) => a.risk - b.risk || (b.rec?.pMax ?? 0) - (a.rec?.pMax ?? 0));
  run.alts = { maturities, crops };
  if (run === current) renderAlternatives();
}

function renderAlternatives() {
  const a = current.alts;
  if (!a) { $('altMaturity').innerHTML = $('altCrops').innerHTML = '<div class="altrow ghostrow"></div><div class="altrow ghostrow"></div><div class="altrow ghostrow"></div>'; return; }
  const row = (o, kind, label, isCurrent) => {
    const d = (off) => fmtDate(o.refStartMs + ((((off % 365) + 365) % 365)) * DAY);
    const band = o.viable ? riskBand(o.risk).key : 'none';
    return `<button type="button" class="altrow${isCurrent ? ' cur' : ''}" data-${kind}="${o.key}">
      <span class="altname">${label}${isCurrent ? ` <em>${t('alt.current')}</em>` : ''}</span>
      <span class="altwin">${o.viable ? `${esc(d(o.rec.open))} – ${esc(d(o.rec.close))}` : t('alt.none')}</span>
      <span class="altbar"><i class="${band}" style="width:${o.viable ? Math.max(4, o.risk) : 100}%"></i></span>
      <span class="altrisk">${o.viable ? o.risk : '—'}</span></button>`;
  };
  $('altMaturity').innerHTML = a.maturities.map((o) => row(o, 'mat', esc(t(`mat.${o.key}`)), o.key === current.maturity)).join('');
  $('altCrops').innerHTML = a.crops.map((o) => row(o, 'altcrop', `<span aria-hidden="true">${ICON[o.key]}</span> ${esc(cropName(o.key))}`, o.key === current.cropKey)).join('');
}
$('altCard').addEventListener('click', (e) => {
  const b = e.target.closest('.altrow');
  if (!b || b.classList.contains('cur')) return;
  if (b.dataset.mat) $('maturity').value = b.dataset.mat;
  if (b.dataset.altcrop) setCrop(b.dataset.altcrop);
  animateNext = true;
  run();
  scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
});

// ---------------------------------------------------------------- tooltip

const tip = $('tip');
function showTip(evt, html) {
  tip.innerHTML = html;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let x = evt.clientX + 14, y = evt.clientY + 14;
  if (x + r.width > innerWidth - 8) x = evt.clientX - r.width - 14;
  if (y + r.height > innerHeight - 8) y = evt.clientY - r.height - 14;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}
const hideTip = () => { tip.hidden = true; };

function monthTicks(result, width = 1000) {
  const ticks = [];
  for (let m = 0; m < 12; m += width < 520 ? 2 : 1) {
    const d = new Date(result.refStartMs);
    const ms = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + m, 1);
    ticks.push({ o: Math.round((ms - result.refStartMs) / DAY), label: fmtDate(ms, { month: 'short' }) });
  }
  return ticks;
}
const outLegend = () => OUTCOMES.map((o) => `<span><i class="sw" style="background:var(--o-${o.key})"></i>${esc(t(`out.${o.key}`))}</span>`).join('');

// ----------------------------------------------------- chart: risk by date

function renderRisk() {
  const { result } = current;
  const curves = result.curves.recent;
  const rec = result.rec;
  const host = $('riskChart');
  const W = Math.max(320, host.clientWidth), H = Math.min(320, Math.max(220, W * 0.36));
  const m = { l: 38, r: 10, t: 22, b: 24 };
  const x = (o) => m.l + (o / (SEASON_DAYS - 1)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - v) * (H - m.t - m.b);
  $('riskLegend').innerHTML = outLegend();

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  for (const v of [0, 0.25, 0.5, 0.75, 1]) svg += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${v * 100}%</text>`;
  for (const k of monthTicks(result, W)) svg += `<text x="${x(k.o) + 3}" y="${H - 6}">${k.label}</text><line class="grid" x1="${x(k.o)}" x2="${x(k.o)}" y1="${H - m.b}" y2="${H - m.b + 4}"/>`;
  const base = new Float64Array(SEASON_DAYS);
  for (const o of OUTCOMES) {
    const c = curves[o.code];
    let up = '', down = '';
    for (let d = 0; d < SEASON_DAYS; d++) {
      up += `${d ? 'L' : 'M'}${x(d).toFixed(1)},${y(base[d] + c[d]).toFixed(1)}`;
      down = `L${x(d).toFixed(1)},${y(base[d]).toFixed(1)}` + down;
      base[d] += c[d];
    }
    svg += `<path d="${up}${down}Z" fill="var(--o-${o.key})" stroke="var(--surface)" stroke-width="1" stroke-linejoin="round"/>`;
  }
  if (rec && rec.viable) {
    const x0 = x(rec.open), x1 = x(rec.close);
    svg += `<rect x="${x0}" y="${m.t}" width="${Math.max(2, x1 - x0)}" height="${H - m.t - m.b}" fill="var(--text)" opacity="0.06"/>
      <line x1="${x0}" x2="${x0}" y1="${m.t}" y2="${H - m.b}" stroke="var(--text)" stroke-width="1"/><line x1="${x1}" x2="${x1}" y1="${m.t}" y2="${H - m.b}" stroke="var(--text)" stroke-width="1"/>
      <text class="lab" x="${Math.min(Math.max((x0 + x1) / 2, m.l + 80), W - m.r - 80)}" y="${m.t - 7}" text-anchor="middle">${esc(t('window', { a: lab(rec.open), b: lab(rec.close) }))}</text>`;
  }
  svg += `<line id="riskCross" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" stroke="var(--text-2)" stroke-width="1" visibility="hidden"/>
    <rect id="riskHit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent"/></svg>`;
  host.innerHTML = svg;

  const hit = host.querySelector('#riskHit'), cross = host.querySelector('#riskCross');
  hit.addEventListener('pointermove', (e) => {
    const box = hit.getBoundingClientRect();
    const d = Math.max(0, Math.min(SEASON_DAYS - 1, Math.round(((e.clientX - box.left) / box.width) * (SEASON_DAYS - 1))));
    cross.setAttribute('x1', x(d)); cross.setAttribute('x2', x(d)); cross.setAttribute('visibility', 'visible');
    const rows = OUTCOMES.filter((o) => curves[o.code][d] >= 0.005).map((o) => `<div><i class="sw" style="background:var(--o-${o.key})"></i>${esc(t(`out.${o.key}`))}<em>${pct(curves[o.code][d])}</em></div>`).join('');
    showTip(e, `<b>${esc(t('tip.plant', { date: lab(d) }))}</b><div>${t('tip.succeeds')}<em>${pct(curves[OUT.OK][d])}</em></div>${rows}`);
  });
  hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });
}

// --------------------------------------------------- chart: window by year

function fmtSlope(tr, unit = 'days') {
  if (!Number.isFinite(tr.slope)) return { v: '—', d: t('tr.few') };
  let per = tr.slope * 10;
  let v;
  if (unit === 'days') {
    const mag = Math.abs(per) >= 10 ? Math.round(Math.abs(per)) : Math.abs(per).toFixed(1);
    v = Math.abs(per) < 0.05 ? t('tr.nochange') : t(per < 0 ? 'tr.earlier' : 'tr.later', { n: mag });
  } else if (unit === 'gdd') {
    if (imperial()) per *= 1.8;
    v = `${per > 0 ? '+' : '−'}${Math.round(Math.abs(per))} ${imperial() ? '°F·d' : '°C·d'}`;
  } else {
    v = `${per > 0 ? '+' : '−'}${fR(Math.abs(per))}`;
  }
  return { v, d: t('tr.per', { sig: t(tr.significant ? 'sig.yes' : 'sig.no'), p: tr.p < 0.01 ? '< 0.01' : `= ${tr.p.toFixed(2)}` }) };
}

function renderShift() {
  const { result } = current;
  const seasons = result.seasons, tr = result.trends;
  const host = $('shiftChart');
  const withWin = seasons.filter((s) => Number.isFinite(s.open));
  const hasFrost = seasons.filter((s) => Number.isFinite(s.lastFrost)).length >= 8;
  const tiles = [
    ['tr.open', fmtSlope(tr.open)], ['tr.close', fmtSlope(tr.close)],
    ...(hasFrost ? [['tr.lastFrost', fmtSlope(tr.lastFrost)], ['tr.firstFrost', fmtSlope(tr.firstFrost)]] : []),
    ['tr.gdd', fmtSlope(tr.gdd, 'gdd')], ['tr.rain', fmtSlope(tr.rain, 'rain')],
  ];
  $('trendTiles').innerHTML = tiles.map(([k, s]) => `<div class="tile"><div class="k">${t(k)}</div><div class="v">${s.v}</div><div class="d">${s.d}</div></div>`).join('');

  if (withWin.length < 3) {
    $('shiftSub').textContent = t('shift.few');
    $('shiftLegend').innerHTML = ''; host.innerHTML = ''; $('thenNow').innerHTML = '';
    return;
  }
  const failed = seasons.filter((s) => s.complete && !Number.isFinite(s.open)).length;
  $('shiftSub').textContent = `${t('shift.sub')}${failed ? ` ${t('shift.failed', { n: failed })}` : ''}`;
  $('thenNow').innerHTML = thenNowHtml();
  $('shiftLegend').innerHTML = `<span><i class="sw" style="background:var(--window)"></i>${t('leg.safe')}</span><span><i class="sw line" style="background:var(--text)"></i>${t('leg.trend')}</span>${hasFrost ? `<span><i class="sw dot" style="background:var(--o-frost)"></i>${t('leg.frost')}</span>` : ''}`;

  const W = Math.max(320, host.clientWidth), H = Math.min(340, Math.max(240, W * 0.4));
  const m = { l: 48, r: 104, t: 10, b: 24 };
  const vals = withWin.flatMap((s) => [s.open, s.close]).concat(hasFrost ? seasons.map((s) => s.lastFrost).filter(Number.isFinite) : []);
  const lo = Math.max(0, Math.min(...vals) - 8), hi = Math.min(364, Math.max(...vals) + 8);
  const y0 = seasons[0].year, y1 = seasons[seasons.length - 1].year;
  const band = (W - m.l - m.r) / (y1 - y0 + 1);
  const x = (yr) => m.l + (yr - y0 + 0.5) * band;
  const y = (o) => H - m.b - ((o - lo) / (hi - lo)) * (H - m.t - m.b);
  const bw = Math.max(3, Math.min(10, band - 2));

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  const step = hi - lo > 150 ? 30 : hi - lo > 70 ? 14 : 7;
  for (let o = Math.ceil(lo / step) * step; o <= hi; o += step) svg += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(o)}" y2="${y(o)}"/><text x="${m.l - 6}" y="${y(o) + 4}" text-anchor="end">${esc(lab(o))}</text>`;
  for (let yr = Math.ceil(y0 / 5) * 5; yr <= y1; yr += W < 520 ? 10 : 5) svg += `<text x="${x(yr)}" y="${H - 6}" text-anchor="middle">${yr}</text>`;
  for (const s of withWin) {
    const top = y(s.close), h = Math.max(bw, y(s.open) - top);
    svg += `<rect x="${x(s.year) - bw / 2}" y="${top}" width="${bw}" height="${h}" rx="${bw / 2}" fill="var(--window)"/>`;
  }
  if (hasFrost) for (const s of seasons) if (Number.isFinite(s.lastFrost)) svg += `<circle cx="${x(s.year)}" cy="${y(s.lastFrost)}" r="4" fill="var(--o-frost)" stroke="var(--surface)" stroke-width="2"/>`;
  const labels = [];
  for (const key of ['open', 'close']) {
    const s = tr[key];
    if (!Number.isFinite(s.slope)) continue;
    const f = (yr) => Math.max(lo, Math.min(hi, s.intercept + s.slope * yr));
    svg += `<line x1="${x(y0)}" x2="${x(y1)}" y1="${y(f(y0))}" y2="${y(f(y1))}" stroke="var(--text)" stroke-width="2" stroke-linecap="round"/>`;
    labels.push({ y: y(f(y1)), text: esc(t(key === 'open' ? 'lab.opens' : 'lab.closes', { date: lab(Math.round(f(y1))) })) });
  }
  if (labels.length === 2 && Math.abs(labels[0].y - labels[1].y) < 14) { labels[0].y += 7; labels[1].y -= 7; }
  for (const l of labels) svg += `<text class="lab" x="${x(y1) + bw / 2 + 6}" y="${l.y + 4}">${l.text}</text>`;
  for (const s of seasons) svg += `<rect class="yrhit" data-y="${s.year}" x="${x(s.year) - band / 2}" y="${m.t}" width="${band}" height="${H - m.t - m.b}" fill="transparent"/>`;
  host.innerHTML = svg + '</svg>';

  const bySeason = new Map(seasons.map((s) => [String(s.year), s]));
  host.querySelectorAll('.yrhit').forEach((r) => {
    r.addEventListener('pointermove', (e) => {
      const s = bySeason.get(r.dataset.y);
      const win = Number.isFinite(s.open) ? `<div>${t('tip.safe')}<em>${esc(lab(s.open))} – ${esc(lab(s.close))}</em></div>` : `<div>${t(s.complete ? 'tip.nosafe' : 'tip.progress')}</div>`;
      showTip(e, `<b>${esc(s.label)}</b>${win}${Number.isFinite(s.lastFrost) ? `<div>${t('leg.frost')}<em>${esc(lab(s.lastFrost))}</em></div>` : ''}`);
    });
    r.addEventListener('pointerleave', hideTip);
  });
}

// ------------------------------------------------------------ chart: heatmap

function renderHeat() {
  const { result } = current;
  const { seasons, outcomes } = result;
  const host = $('heatChart'), canvas = $('heat');
  $('heatLegend').innerHTML = `<span><i class="sw" style="background:var(--o-ok);outline:1px solid var(--line)"></i>${t('out.ok')}</span>${outLegend()}`;
  const css = getComputedStyle(document.documentElement);
  const col = (n) => css.getPropertyValue(n).trim();
  const colors = { [OUT.OK]: col('--o-ok'), [OUT.UNKNOWN]: col('--o-unknown') };
  for (const o of OUTCOMES) colors[o.code] = col(`--o-${o.key}`);

  const W = Math.max(320, host.clientWidth), ml = 52, mb = 20;
  const rowH = Math.max(5, Math.min(9, Math.floor(360 / seasons.length)));
  const H = seasons.length * rowH + mb;
  const dpr = devicePixelRatio || 1;
  canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.height = `${H}px`;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, W, H);
  const cw = (W - ml) / SEASON_DAYS;
  seasons.forEach((s, k) => {
    let start = 0;
    for (let o = 1; o <= SEASON_DAYS; o++) {
      const prev = outcomes[k * SEASON_DAYS + o - 1];
      if (o === SEASON_DAYS || outcomes[k * SEASON_DAYS + o] !== prev) {
        g.fillStyle = colors[prev];
        g.fillRect(ml + start * cw, k * rowH, (o - start) * cw + 0.5, rowH - 1);
        start = o;
      }
    }
  });
  g.fillStyle = col('--text-3');
  g.font = '11.5px system-ui, sans-serif';
  g.textBaseline = 'middle';
  seasons.forEach((s, k) => { if (s.year % 5 === 0) g.fillText(s.label, 0, k * rowH + rowH / 2); });
  g.textBaseline = 'alphabetic';
  for (const k of monthTicks(result, W)) g.fillText(k.label, ml + k.o * cw + 2, H - 5);

  canvas.onpointermove = (e) => {
    const box = canvas.getBoundingClientRect();
    const k = Math.floor((e.clientY - box.top) / rowH), o = Math.floor((e.clientX - box.left - ml) / cw);
    if (k < 0 || k >= seasons.length || o < 0 || o >= SEASON_DAYS) return hideTip();
    const c = outcomes[k * SEASON_DAYS + o];
    const what = c === OUT.OK ? t('out.ok') : c === OUT.UNKNOWN ? t('out.unknown') : t(`out.${byCode[c].key}`);
    showTip(e, `<b>${esc(t('tip.planted', { season: seasons[k].label, date: lab(o) }))}</b><div>${c > 0 ? `<i class="sw" style="background:var(--o-${byCode[c].key})"></i>` : ''}${esc(what)}</div>`);
  };
  canvas.onpointerleave = hideTip;
}

// ---------------------------------------------------------- satellite check

let ndviRun = 0;
let ndviAbort = null;

const satSupported = () => !current.crop.winter && ndviTargets(current.result).length > 0;

function resetNdvi() {
  const n = satSupported();
  $('ndviLegend').innerHTML = ''; $('ndviChart').innerHTML = ''; $('ndviNote').hidden = true;
  $('ndviBody').innerHTML = n
    ? `<div class="ndvistart"><button type="button" id="ndviGo" class="primary">${t('sat.start')}</button><span class="hint">${t('sat.start.d')}</span></div>`
    : `<p class="sub">${t(current.crop.winter ? 'sat.winter' : 'sat.none')}</p>`;
  $('ndviGo')?.addEventListener('click', runNdvi);
}

const SAT_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><g transform="rotate(-35 12 12)" fill="currentColor"><rect x="9" y="9" width="6" height="6" rx="1"/><rect x="1.500" y="10" width="6" height="4" rx=".5"/><rect x="16.500" y="10" width="6" height="4" rx=".5"/></g></svg>';
const verdictText = (s) => t(`v.${s.verdict}.d`, { inside: s.inside, judged: s.judged, greened: s.greened, checked: s.checked, n: Math.abs(Math.round(s.offset)) });

/** The satellite verdict, surfaced at the top of the recommendation and on the ribbon. */
function renderSatStrip() {
  const el = $('satStrip');
  if (!el) return;
  if (!satSupported()) { el.hidden = true; return; }
  el.hidden = false;
  const nd = current.ndvi;
  const more = `<button type="button" class="ghost" data-sat="more">${t('sat.more')}</button>`;
  let cls = 'idle', html;
  if (!nd) html = `<div><b>${t('sat.idle')}</b> ${t('sat.idle.d')}</div><button type="button" class="primary" data-sat="go">${t('sat.run')}</button>`;
  else if (!nd.state.finished) {
    cls = 'busy';
    html = `<div><b>${t('sat.busy')}</b> ${t('sat.busy.d', { done: nd.state.done, total: nd.state.total })}<div class="progress wide"><span style="width:${(nd.state.done / Math.max(1, nd.state.total)) * 100}%;animation:none"></span></div></div>${more}`;
  } else if (nd.state.failedAll) html = `<div><b>${t('sat.unavail')}</b> ${t('sat.unavail.d')}</div><button type="button" class="primary" data-sat="go">${t('sat.retry')}</button>`;
  else {
    const s = nd.cmp.summary;
    cls = s.verdict;
    html = `<div><b>${t(`v.${s.verdict}`)}.</b> ${esc(verdictText(s))}</div>${more}`;
  }
  el.className = `satstrip ${cls}`;
  el.innerHTML = `<span class="saticon">${SAT_ICON}</span>${html}`;
  el.querySelector('[data-sat=go]')?.addEventListener('click', runNdvi);
  el.querySelector('[data-sat=more]')?.addEventListener('click', () => $('ndviCard').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' }));

  const ribbon = $('rec').querySelector('.ribbon');
  ribbon?.querySelector('.mark.green')?.remove();
  const g = nd?.cmp.summary.medianGreen;
  if (ribbon && Number.isFinite(g)) ribbon.insertAdjacentHTML('beforeend', `<div class="mark green" style="left:${((((g % 365) + 365) % 365) / 365) * 100}%"><b>${t('mark.green')}</b></div>`);
}

async function runNdvi() {
  const id = ++ndviRun;
  const run = current;
  const { result, crop, lat, lon } = run;
  const ctrl = new AbortController();
  ndviAbort = ctrl;
  const state = { done: 0, total: 4, finished: false, failedAll: false, source: 'fast', failed: 0 };
  let observed = [];
  const update = () => {
    if (id !== ndviRun) return;
    run.ndvi = { cmp: compareNdvi(result, crop, observed), state };
    if (run === current) { renderNdvi(); renderSatStrip(); }
  };
  update();

  // Fast path: NASA's yearly green-up record, four small requests.
  const targets = ndviTargets(result);
  const years = targets.map((x) => x.year);
  let fastOk = false;
  try {
    const greens = await fetchGreenups(lat, lon, Math.max(2001, Math.min(...years) - 1), Math.max(...years) + 1, ctrl.signal, (done, total) => { state.done = done; state.total = total; update(); });
    observed = assignGreenups(result, greens);
    fastOk = observed.some((o) => Number.isFinite(o.greenMs));
  } catch { /* fall through to the slow path */ }
  if (id !== ndviRun) return;

  // Fallback: read raw NDVI season by season (slow, one request per season).
  if (!fastOk) {
    state.source = 'slow'; state.done = 0; state.total = targets.length; observed = [];
    update();
    const queue = [...targets];
    await Promise.all([0, 1].map(async () => {
      for (let q; id === ndviRun && (q = queue.shift());) {
        try { observed.push({ year: q.year, points: await fetchNdvi(lat, lon, q.dates, ctrl.signal) }); } catch { state.failed++; }
        state.done++;
        update();
      }
    }));
    state.failedAll = state.failed === targets.length;
  }
  state.finished = true;
  update();
}

function renderNdvi() {
  const { cmp, state } = current.ndvi;
  const s = cmp.summary;
  let html = '';
  if (!state.finished) html += `<div class="ndviprog"><div class="progress wide"><span style="width:${(state.done / Math.max(1, state.total)) * 100}%;animation:none"></span></div><span class="hint">${t('sat.busy.d', { done: state.done, total: state.total })}</span></div>${state.source === 'slow' ? `<p class="hint">${t('sat.fallback')}</p>` : ''}`;
  if (state.finished && state.failedAll) html += `<p class="sub">${t('sat.unavail')} ${t('sat.unavail.d')} <button type="button" id="ndviGo" class="ghost">${t('sat.retry')}</button></p>`;
  else if (state.finished || s.verdict !== 'pending') html += `<div class="verdict ${s.verdict}"><b>${t(`v.${s.verdict}`)}.</b> ${esc(verdictText(s))}</div>`;
  if (s.greened) {
    const off = Math.round(s.offset);
    const strength = !Number.isFinite(s.rho) ? null : s.rho >= 0.5 ? 'strong' : s.rho >= 0.25 ? 'moderate' : s.rho > -0.25 ? 'weak' : 'opposite';
    html += `<div class="tiles">
      <div class="tile"><div class="k">${t('st.green.k')}</div><div class="v">${esc(lab(Math.round(s.medianGreen)))}</div><div class="d">${t('st.green.d')}</div></div>
      <div class="tile"><div class="k">${t('st.implied.k')}</div><div class="v">${esc(lab(Math.round(s.medianImplied)))}</div><div class="d">${Math.abs(off) < 2 ? t('st.implied.on') : t(off < 0 ? 'st.implied.before' : 'st.implied.after', { n: Math.abs(off) })}</div></div>
      ${strength ? `<div class="tile"><div class="k">${t('st.rho.k')}</div><div class="v">${t(`rho.${strength}`)}</div><div class="d">${t('st.rho.d', { r: s.rho.toFixed(2) })}</div></div>` : ''}
      ${Number.isFinite(s.medianPeak) ? `<div class="tile"><div class="k">${t('st.peak.k')}</div><div class="v">${s.medianPeak.toFixed(2)}</div><div class="d">${t('st.peak.d')}</div></div>` : `<div class="tile"><div class="k">${t('st.n.k')}</div><div class="v">${s.greened} / ${s.checked}</div><div class="d">${t('st.n.d')}</div></div>`}
    </div>`;
  }
  $('ndviBody').innerHTML = html;
  $('ndviGo')?.addEventListener('click', runNdvi);
  $('ndviNote').hidden = !s.greened;
  $('ndviNote').textContent = `${t('sat.note', { lag: s.lag, tol: TOLERANCE })} ${t(state.source === 'fast' ? 'sat.src.fast' : 'sat.src.slow')}`;

  const host = $('ndviChart');
  const rows = cmp.years;
  if (!s.greened || rows.length < 2) { host.innerHTML = ''; $('ndviLegend').innerHTML = ''; return; }
  $('ndviLegend').innerHTML = `<span><i class="sw" style="background:var(--window)"></i>${t('sat.leg.safe')}</span><span><i class="sw dot" style="background:var(--o-short)"></i>${t('sat.leg.in')}</span><span><i class="sw dot ring"></i>${t('sat.leg.out')}</span>`;
  const W = Math.max(320, host.clientWidth), H = Math.min(300, Math.max(220, W * 0.34));
  const m = { l: 48, r: 14, t: 10, b: 24 };
  const vals = rows.flatMap((r) => [r.open, r.close, r.implied]).filter(Number.isFinite);
  const lo = Math.min(...vals) - 8, hi = Math.max(...vals) + 8;
  const y0 = rows[0].year, y1 = rows[rows.length - 1].year;
  const band = (W - m.l - m.r) / (y1 - y0 + 1);
  const x = (yr) => m.l + (yr - y0 + 0.5) * band;
  const y = (o) => H - m.b - ((o - lo) / (hi - lo)) * (H - m.t - m.b);
  const bw = Math.max(4, Math.min(14, band - 4));
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  const step = hi - lo > 150 ? 30 : hi - lo > 70 ? 14 : 7;
  for (let o = Math.ceil(lo / step) * step; o <= hi; o += step) svg += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(o)}" y2="${y(o)}"/><text x="${m.l - 6}" y="${y(o) + 4}" text-anchor="end">${esc(lab(o))}</text>`;
  for (const r of rows) if (band > 34 || r.year % 2 === 0) svg += `<text x="${x(r.year)}" y="${H - 6}" text-anchor="middle">${r.year}</text>`;
  for (const r of rows) {
    if (Number.isFinite(r.open)) svg += `<rect x="${x(r.year) - bw / 2}" y="${y(r.close)}" width="${bw}" height="${Math.max(bw, y(r.open) - y(r.close))}" rx="${bw / 2}" fill="var(--window)" opacity="0.55"/>`;
    if (Number.isFinite(r.implied)) svg += r.inside === false
      ? `<circle cx="${x(r.year)}" cy="${y(r.implied)}" r="4.500" fill="var(--surface)" stroke="var(--o-short)" stroke-width="2.500"/>`
      : `<circle cx="${x(r.year)}" cy="${y(r.implied)}" r="5" fill="var(--o-short)" stroke="var(--surface)" stroke-width="2"/>`;
    svg += `<rect class="yrhit" data-y="${r.year}" x="${x(r.year) - band / 2}" y="${m.t}" width="${band}" height="${H - m.t - m.b}" fill="transparent"/>`;
  }
  host.innerHTML = svg + '</svg>';
  const byYear = new Map(rows.map((r) => [String(r.year), r]));
  host.querySelectorAll('.yrhit').forEach((el) => {
    el.addEventListener('pointermove', (e) => {
      const r = byYear.get(el.dataset.y);
      showTip(e, `<b>${esc(r.label)}</b><div>${t('tip.model')}<em>${Number.isFinite(r.open) ? `${esc(lab(r.open))} – ${esc(lab(r.close))}` : t('tip.nodate')}</em></div>${Number.isFinite(r.green) ? `<div>${t('tip.greenup')}<em>${esc(lab(Math.round(r.green)))}</em></div><div>${t('tip.implied')}<em>${esc(lab(Math.round(r.implied)))}</em></div>` : `<div>${t('tip.nogreen')}</div>`}`);
    });
    el.addEventListener('pointerleave', hideTip);
  });
}

// -------------------------------------------------------------------- table

function tableRows() {
  const f = (o) => (Number.isFinite(o) ? lab(o) : '');
  const k = imperial() ? 1.8 : 1;
  return current.result.seasons.map((s) => [s.label, f(s.open), f(s.close), Number.isFinite(s.length) ? s.length : '', f(s.lastFrost), f(s.firstFrost), Number.isFinite(s.gdd) ? Math.round(s.gdd * k) : '', Number.isFinite(s.rain) ? (imperial() ? (s.rain / 25.4).toFixed(1) : Math.round(s.rain)) : '']);
}
const tableHead = () => [t('th.season'), t('th.open'), t('th.close'), t('th.days'), t('th.lastFrost'), t('th.firstFrost'), `${t('th.gdd')} (${imperial() ? '°F·d' : '°C·d'})`, `${t('th.rain')} (${imperial() ? 'in' : 'mm'})`];
function renderTable() {
  $('yearTable').innerHTML = `<thead><tr>${tableHead().map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${tableRows().map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
}
$('csv').addEventListener('click', () => {
  if (!current) return;
  const csv = [tableHead(), ...tableRows()].map((r) => r.map((c) => `"${c}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `seedline_${current.cropKey}_${current.lat.toFixed(2)}_${current.lon.toFixed(2)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ------------------------------------------------------------------ start-up

refreshText();
const last = ls.get('seedline:last');
if (last) { $('pickLast').hidden = false; $('pickLast').addEventListener('click', () => applyHash(last)); }
applyHash(location.hash);
// Offline reuse: the service worker keeps the app and the last fields' weather.
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
