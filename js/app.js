// Bump ?v= here and in index.html whenever these files change, so browsers
// never pair a new page with stale cached scripts or styles.
import { CROPS, MATURITY } from './crops.js?v=5';
import { fetchDaily } from './power.js?v=5';
import { ndviTargets, compareNdvi, TOLERANCE } from './ndvi.js?v=5';
import { fetchNdvi } from './modis.js?v=5';
import { parsePower, addWaterBalance, analyze, riskBand, offsetLabel, OUT, SEASON_DAYS } from './analysis.js?v=5';

const $ = (id) => document.getElementById(id);
const DAY = 86400000;

// Outcome display order = stacking order = validated palette order.
const OUTCOMES = [
  { code: OUT.FROST, key: 'frost', label: 'Frost after emergence' },
  { code: OUT.DRY_START, key: 'dry', label: 'Too dry to establish' },
  { code: OUT.COLD, key: 'cold', label: 'Too cold to germinate' },
  { code: OUT.DROUGHT, key: 'drought', label: 'Drought in season' },
  { code: OUT.HEAT, key: 'heat', label: 'Heat at flowering' },
  { code: OUT.SHORT, key: 'short', label: 'Season ends before maturity' },
];
const byCode = Object.fromEntries(OUTCOMES.map((o) => [o.code, o]));
const pct = (v) => `${Math.round(v * 100)}%`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ------------------------------------------------------------------ controls

const ICON = { maize: '🌽', soybean: '🫘', wheat: '🌾', sorghum: '🌱', millet: '🌿', cotton: '☁️', potato: '🥔', bean: '🫛', sunflower: '🌻' };
for (const [k, c] of Object.entries(CROPS)) $('crop').add(new Option(c.name, k));
$('cropChips').innerHTML = Object.entries(CROPS).map(([k, c]) => `<button type="button" role="radio" class="chip" data-crop="${k}"><span aria-hidden="true">${ICON[k]}</span>${c.name.replace(/ \(.*\)/, '')}</button>`).join('');
function syncChips() {
  for (const b of $('cropChips').children) b.setAttribute('aria-checked', String(b.dataset.crop === $('crop').value));
}
$('cropChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-crop]');
  if (!b) return;
  $('crop').value = b.dataset.crop;
  syncChips();
  if (pin) run();
});
syncChips();
for (const [k, m] of Object.entries(MATURITY)) $('maturity').add(new Option(m.name, k));
$('maturity').value = 'medium';

const map = L.map('map', { worldCopyJump: true, zoomControl: false }).setView([20, 10], 3);
L.control.zoom({ position: 'bottomright' }).addTo(map);
const streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 17,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 17,
  attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
});
L.control.layers({ Map: streets, Satellite: satellite }, null, { collapsed: false, position: 'bottomleft' }).addTo(map);
const pinIcon = L.divIcon({ className: 'pin', html: '<svg viewBox="0 0 32 42" width="32" height="42"><path d="M16 41C16 41 30 25.5 30 15A14 14 0 0 0 2 15C2 25.5 16 41 16 41Z" fill="var(--accent)" stroke="#fff" stroke-width="2"/><path d="M16 23v-8m0 1c0-4-2.5-5.5-5.5-5.5 0 3.5 2 5.500 5.500 5.500Zm0 2.500c0-3 2-4.500 5-4.500 0 3-2 4.500-5 4.500Z" fill="#fff" stroke="#fff" stroke-width="1.200" stroke-linecap="round"/></svg>', iconSize: [32, 42], iconAnchor: [16, 41] });
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
/** A location was chosen: analyse it, and leave full-screen once the pin has landed. */
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

// Place search (OpenStreetMap Nominatim): moves the map, the click still picks the field.
$('search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('q').value.trim();
  if (!q) return;
  const msg = $('searchMsg');
  msg.hidden = false;
  msg.textContent = 'Searching…';
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
    const hit = (await res.json())[0];
    if (!hit) { msg.textContent = `Nothing found for “${q}”. Try a nearby town.`; return; }
    const [s, n, w, e2] = hit.boundingbox.map(Number);
    map.fitBounds([[s, w], [n, e2]], { maxZoom: 12 });
    msg.textContent = 'Now click your field on the map.';
  } catch {
    msg.textContent = 'Search is unavailable right now. Zoom the map instead.';
  }
});
$('controls').addEventListener('submit', (e) => { e.preventDefault(); choose(+$('lat').value, +$('lon').value); });
for (const id of ['maturity', 'irrigated']) $(id).addEventListener('change', () => { if (pin) run(); });
document.querySelectorAll('.locate').forEach((btn) => btn.addEventListener('click', () => {
  const fail = (text) => { if (picking()) { $('searchMsg').hidden = false; $('searchMsg').textContent = text; } else showStatus('Location unavailable', text); };
  if (!navigator.geolocation) return fail('This browser cannot share a location. Click the map instead.');
  navigator.geolocation.getCurrentPosition(
    (p) => choose(p.coords.latitude, p.coords.longitude),
    () => fail('Could not read your location. Click the map instead.'),
  );
}));

function showStatus(title, body, kind = 'info') {
  const el = $('status');
  el.hidden = false;
  el.className = `status ${kind}`;
  el.innerHTML = `${kind === 'loading' ? '<div class="sprout" aria-hidden="true"><i></i><i></i><i></i></div>' : ''}<h2>${esc(title)}</h2><p>${esc(body)}</p>${kind === 'loading' ? '<div class="progress"><span></span></div>' : ''}`;
}

document.querySelectorAll('[data-example]').forEach((b) => b.addEventListener('click', () => {
  const [lat, lon, crop] = b.dataset.example.split(',');
  $('crop').value = crop;
  syncChips();
  if (picking()) map.setView([+lat, +lon], 6, { animate: false });
  choose(+lat, +lon);
}));

// ---------------------------------------------------------------------- run

let runId = 0;
let current = null;

async function run() {
  const lat = +$('lat').value, lon = +$('lon').value;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) return;
  const id = ++runId;
  ndviRun++;
  ndviAbort?.abort();
  const cropKey = $('crop').value, maturity = $('maturity').value, irrigated = $('irrigated').checked;
  location.hash = `${lat.toFixed(4)},${lon.toFixed(4)},${cropKey},${maturity},${irrigated ? 1 : 0}`;
  $('go').disabled = true;
  $('output').hidden = true;
  showStatus('Replaying 45 years of weather…', `Fetching about 16,000 days from NASA for ${lat.toFixed(2)}°, ${lon.toFixed(2)}° and growing ${CROPS[cropKey].name.replace(/ \(.*\)/, '').toLowerCase()} through every one of them.`, 'loading');
  try {
    const json = await fetchDaily(lat, lon);
    if (id !== runId) return;
    const series = addWaterBalance(parsePower(json), lat);
    if (series.n < 365 * 20) throw new Error('NASA POWER returned too little data for this point.');
    const crop = CROPS[cropKey];
    const result = analyze(series, crop, lat, { irrigated, gddScale: MATURITY[maturity].scale });
    current = { result, crop, lat, lon, irrigated, maturity };
    // Unhide first: the charts measure their containers to size themselves.
    $('status').hidden = true;
    $('output').hidden = false;
    render();
  } catch (e) {
    if (id !== runId) return;
    $('output').hidden = true;
    showStatus('Could not load weather for this spot', `${e.message || e}. Check your connection and try again.`, 'error');
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
}
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => current && render(), 150); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => current && renderHeat());

const lab = (o) => offsetLabel(current.result, o);
const seasonDate = (rec, o) => new Date(rec.seasonStartMs + o * DAY).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function topReasons(reasons, n = 3) {
  return OUTCOMES.map((o) => ({ ...o, share: reasons[o.code] })).filter((o) => o.share >= 0.01).sort((a, b) => b.share - a.share).slice(0, n);
}

function shiftSentence() {
  const { windows, firstYear, lastYear } = current.result;
  const a = windows.early, b = windows.late;
  if (!a || !b || a.pMax < 0.4 || b.pMax < 0.4) return '';
  const part = (d, what) => {
    if (Math.abs(d) < 2) return `${what} at about the same time`;
    return `${what} ${Math.abs(d)} days ${d < 0 ? 'earlier' : 'later'}`;
  };
  return `Compared with ${firstYear}–${firstYear + 19}, the window of the last 15 years (${lastYear - 14}–${lastYear}) ${part(b.open - a.open, 'opens')} and ${part(b.close - a.close, 'closes')}.`;
}

const BAND_COLOR = { low: '--good', moderate: '--warning', high: '--serious', 'very-high': '--critical' };
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Half-dial risk gauge; the arc sweeps in and the number counts up. */
function gaugeSvg(risk, band) {
  const len = Math.PI * 54;
  return `<svg class="gauge" viewBox="0 0 140 86" role="img" aria-label="Risk score ${risk} out of 100, ${band.label}">
    <path d="M16 74A54 54 0 0 1 124 74" fill="none" stroke="var(--surface-2)" stroke-width="12" stroke-linecap="round"/>
    <path class="arc" d="M16 74A54 54 0 0 1 124 74" fill="none" stroke="var(${BAND_COLOR[band.key]})" stroke-width="12" stroke-linecap="round" stroke-dasharray="${len}" stroke-dashoffset="${len}" data-to="${len * (1 - Math.max(0.03, risk / 100))}"/>
    <text class="num" x="70" y="70" text-anchor="middle" data-count="${risk}">${reduceMotion ? risk : 0}</text>
  </svg>`;
}
function animateGauge(el) {
  const arc = el.querySelector('.arc'), num = el.querySelector('.num');
  if (!arc) return;
  if (reduceMotion) { arc.setAttribute('stroke-dashoffset', arc.dataset.to); return; }
  requestAnimationFrame(() => requestAnimationFrame(() => arc.setAttribute('stroke-dashoffset', arc.dataset.to)));
  const to = +num.dataset.count, t0 = performance.now();
  const tick = (t) => {
    const k = Math.min(1, (t - t0) / 900);
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
  const months = monthTicks(current.result).map((t) => `<span style="left:${pos(t.o)}">${t.label}</span>`).join('');
  const today = Math.round((rec.now.dateMs - rec.seasonStartMs) / DAY);
  const marks = [`<div class="mark today" style="left:${pos(today)}"><b>Today</b></div>`];
  if (rec.viable) {
    marks.push(`<div class="bracket" style="left:${pos(rec.open)};width:${((rec.close - rec.open) / 365) * 100}%"></div>`);
    marks.push(`<div class="mark best" style="left:${pos(rec.best)}"><b>Best day</b></div>`);
    const mat = rec.best + rec.cycleDays;
    if (mat < 365) marks.push(`<div class="mark harvest" style="left:${pos(mat)}"><b>Mature</b></div>`);
  }
  return `<div class="ribbon" role="img" aria-label="Chance of success by planting date across the year"><div class="strip">${cells}</div>${marks.join('')}<div class="months">${months}</div></div>
    <div class="ribbonkey"><span>Poor odds</span><i></i><span>Good odds for planting that day</span></div>`;
}

function renderRec() {
  const { result, crop, irrigated } = current;
  const rec = result.rec;
  const el = $('rec');
  const name = crop.name.replace(/ \(.*\)/, '').toLowerCase();
  const icon = ICON[$('crop').value];
  if (!rec || !rec.viable) {
    const why = rec ? topReasons(rec.reasons, 2) : [];
    const dry = why.some((w) => w.key === 'dry' || w.key === 'drought');
    el.className = 'card rec nogo';
    el.innerHTML = `
      <div class="eyebrow">Recommendation · ${current.lat.toFixed(2)}°, ${current.lon.toFixed(2)}°</div>
      <div class="headline"><span class="cropicon" aria-hidden="true">${icon}</span>${esc(crop.name.replace(/ \(.*\)/, ''))} is not a safe bet here</div>
      <p class="lede">${rec ? `Even on the best planting date (around ${lab(rec.best)}), a ${name} crop would have succeeded in only ${pct(rec.pMax)} of recent seasons.` : `No planting date in any year on record would have carried a ${name} crop to maturity at this spot.`}
      ${why.length ? ` The main obstacle: ${why.map((w) => w.label.toLowerCase()).join(', then ')}.` : ''}
      ${dry && !irrigated ? ' If this field is irrigated, tick “Irrigated field” to lift the rainfall limits.' : ' Try an earlier-maturing class or a different crop.'}</p>
      ${rec ? ribbonHtml(rec) : ''}`;
    return;
  }
  const band = riskBand(rec.risk);
  const harvest = rec.best + rec.cycleDays;
  const why = topReasons(rec.reasons);
  const n = rec.now;
  let timing;
  if (rec.inWindowNow) {
    const ready = n.warmEnough && n.moistEnough;
    timing = `<b>The window is open now.</b> ${ready ? 'Conditions on the ground look ready' : 'But hold off'}: the last 7 days averaged ${n.tmean7.toFixed(1)} °C (needs ${crop.germ} °C)${irrigated ? '' : ` and modelled soil moisture is ${pct(n.soilWater)} of capacity (needs 20%)`}.`;
  } else {
    timing = `The window opens in <b>${rec.daysToOpen} days</b>. Latest weather on record (${new Date(n.dateMs).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}): 7-day mean ${n.tmean7.toFixed(1)} °C, ${n.rain14.toFixed(0)} mm of rain in 14 days.`;
  }
  el.className = 'card rec';
  el.innerHTML = `
    <div class="rechead">
      <div>
        <div class="eyebrow">${esc(rec.seasonLabel)} season · ${current.lat.toFixed(2)}°, ${current.lon.toFixed(2)}°</div>
        <div class="kicker"><span class="cropicon" aria-hidden="true">${icon}</span>Plant ${esc(name)}</div>
        <div class="headline">${esc(seasonDate(rec, rec.open).replace(/, \d+$/, ''))} <span class="dash">→</span> ${esc(seasonDate(rec, rec.close).replace(/, \d+$/, ''))}</div>
        <p class="lede">Best odds around <b>${esc(lab(rec.best))}</b>. ${esc(shiftSentence())}</p>
      </div>
      <div class="gaugebox">${gaugeSvg(rec.risk, band)}<div class="band"><i class="${band.key}"></i>${band.label}</div><div class="gaugecap">risk score out of 100</div></div>
    </div>
    ${ribbonHtml(rec)}
    <div id="satStrip" class="satstrip"></div>
    <div class="tiles">
      <div class="tile"><div class="k">Chance of a successful crop</div><div class="v">${pct(rec.pMean)}</div><div class="d">planted inside the window</div></div>
      <div class="tile"><div class="k">Expected maturity</div><div class="v">${esc(lab(harvest % 365))}</div><div class="d">about ${Math.round(rec.cycleDays)} days after ${esc(lab(rec.best))}</div></div>
      <div class="tile"><div class="k">Dry spell of 10+ days</div><div class="v">${pct(rec.drySpellProb)}</div><div class="d">in the 30 days after planting</div></div>
      <div class="tile"><div class="k">Frost (0 °C or below)</div><div class="v">${pct(rec.frostAfterProb)}</div><div class="d">in the 60 days after planting</div></div>
    </div>
    ${why.length ? `<div class="why">When it fails inside the window: ${why.map((w) => `<span><i class="sw" style="background:var(--o-${w.key})"></i>${esc(w.label)} ${pct(w.share)}</span>`).join('')}</div>` : ''}
    <div class="now">${timing}</div>`;
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
    ticks.push({ o: Math.round((ms - result.refStartMs) / DAY), label: new Date(ms).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }) });
  }
  return ticks;
}

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

  $('riskSub').textContent = 'Share of recent seasons in which a crop sown on each date would have failed, and why. The valley is your window.';
  $('riskLegend').innerHTML = OUTCOMES.map((o) => `<span><i class="sw" style="background:var(--o-${o.key})"></i>${o.label}</span>`).join('');

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Stacked area chart of failure risk by planting date">`;
  for (const v of [0, 0.25, 0.5, 0.75, 1]) svg += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${v * 100}%</text>`;
  for (const t of monthTicks(result, W)) svg += `<text x="${x(t.o) + 3}" y="${H - 6}">${t.label}</text><line class="grid" x1="${x(t.o)}" x2="${x(t.o)}" y1="${H - m.b}" y2="${H - m.b + 4}"/>`;

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
      <text class="lab" x="${Math.min(Math.max((x0 + x1) / 2, m.l + 70), W - m.r - 70)}" y="${m.t - 7}" text-anchor="middle">Window ${esc(lab(rec.open))} – ${esc(lab(rec.close))}</text>`;
  }
  svg += `<line id="riskCross" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" stroke="var(--text-2)" stroke-width="1" visibility="hidden"/>
    <rect id="riskHit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent"/></svg>`;
  host.innerHTML = svg;

  const hit = host.querySelector('#riskHit'), cross = host.querySelector('#riskCross');
  hit.addEventListener('pointermove', (e) => {
    const box = hit.getBoundingClientRect();
    const d = Math.max(0, Math.min(SEASON_DAYS - 1, Math.round(((e.clientX - box.left) / box.width) * (SEASON_DAYS - 1))));
    cross.setAttribute('x1', x(d)); cross.setAttribute('x2', x(d)); cross.setAttribute('visibility', 'visible');
    const rows = OUTCOMES.filter((o) => curves[o.code][d] >= 0.005).map((o) => `<div><i class="sw" style="background:var(--o-${o.key})"></i>${o.label}<em>${pct(curves[o.code][d])}</em></div>`).join('');
    showTip(e, `<b>Plant ${esc(lab(d))}</b><div>Succeeds<em>${pct(curves[OUT.OK][d])}</em></div>${rows}`);
  });
  hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });
}

// --------------------------------------------------- chart: window by year

function fmtSlope(t, unit = 'days') {
  if (!Number.isFinite(t.slope)) return { v: '—', d: 'not enough years' };
  const per = t.slope * 10;
  const mag = Math.abs(per) >= 10 ? Math.round(Math.abs(per)) : Math.abs(per).toFixed(1);
  let v;
  if (unit === 'days') v = Math.abs(per) < 0.05 ? 'No change' : `${mag} days ${per < 0 ? 'earlier' : 'later'}`;
  else v = `${per > 0 ? '+' : '−'}${mag} ${unit}`;
  return { v, d: `per decade · ${t.significant ? 'significant' : 'not significant'} (p ${t.p < 0.01 ? '< 0.01' : `= ${t.p.toFixed(2)}`})` };
}

function renderShift() {
  const { result } = current;
  const seasons = result.seasons, tr = result.trends;
  const host = $('shiftChart');
  const withWin = seasons.filter((s) => Number.isFinite(s.open));
  const hasFrost = seasons.filter((s) => Number.isFinite(s.lastFrost)).length >= 8;

  const tiles = [
    ['Window opens', fmtSlope(tr.open)], ['Window closes', fmtSlope(tr.close)],
    ...(hasFrost ? [['Last spring frost', fmtSlope(tr.lastFrost)], ['First autumn frost', fmtSlope(tr.firstFrost)]] : []),
    ['Season heat (GDD)', fmtSlope(tr.gdd, '°C·days')], ['Yearly rainfall', fmtSlope(tr.rain, 'mm')],
  ];
  $('trendTiles').innerHTML = tiles.map(([k, t]) => `<div class="tile"><div class="k">${k}</div><div class="v">${t.v}</div><div class="d">${t.d}</div></div>`).join('');

  if (withWin.length < 3) {
    $('shiftSub').textContent = 'Too few seasons had any safe planting date to draw a window for each year.';
    $('shiftLegend').innerHTML = ''; host.innerHTML = ''; $('thenNow').innerHTML = '';
    return;
  }
  const failed = seasons.filter((s) => s.complete && !Number.isFinite(s.open)).length;
  $('shiftSub').textContent = `Each bar spans the planting dates that would have worked in that one year; the recommended window is narrower because it has to work in most years.${failed ? ` ${failed} season${failed > 1 ? 's' : ''} had no safe date at all and show${failed > 1 ? '' : 's'} no bar.` : ''}`;
  $('thenNow').innerHTML = thenNowHtml();
  $('shiftLegend').innerHTML = `<span><i class="sw" style="background:var(--window)"></i>Safe planting dates that year</span><span><i class="sw line" style="background:var(--text)"></i>Trend (Theil–Sen)</span>${hasFrost ? '<span><i class="sw dot" style="background:var(--o-frost)"></i>Last spring frost</span>' : ''}`;

  const W = Math.max(320, host.clientWidth), H = Math.min(340, Math.max(240, W * 0.4));
  const m = { l: 48, r: 96, t: 10, b: 24 };
  const vals = withWin.flatMap((s) => [s.open, s.close]).concat(hasFrost ? seasons.map((s) => s.lastFrost).filter(Number.isFinite) : []);
  const lo = Math.max(0, Math.min(...vals) - 8), hi = Math.min(364, Math.max(...vals) + 8);
  const y0 = seasons[0].year, y1 = seasons[seasons.length - 1].year;
  const band = (W - m.l - m.r) / (y1 - y0 + 1);
  const x = (yr) => m.l + (yr - y0 + 0.5) * band;
  const y = (o) => H - m.b - ((o - lo) / (hi - lo)) * (H - m.t - m.b);
  const bw = Math.max(3, Math.min(10, band - 2));

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Safe planting window for each year with trend lines">`;
  const step = hi - lo > 150 ? 30 : hi - lo > 70 ? 14 : 7;
  for (let o = Math.ceil(lo / step) * step; o <= hi; o += step) svg += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(o)}" y2="${y(o)}"/><text x="${m.l - 6}" y="${y(o) + 4}" text-anchor="end">${esc(lab(o))}</text>`;
  for (let yr = Math.ceil(y0 / 5) * 5; yr <= y1; yr += W < 520 ? 10 : 5) svg += `<text x="${x(yr)}" y="${H - 6}" text-anchor="middle">${yr}</text>`;
  for (const s of withWin) {
    const top = y(s.close), h = Math.max(bw, y(s.open) - top);
    svg += `<rect x="${x(s.year) - bw / 2}" y="${top}" width="${bw}" height="${h}" rx="${bw / 2}" fill="var(--window)"/>`;
  }
  if (hasFrost) for (const s of seasons) if (Number.isFinite(s.lastFrost)) svg += `<circle cx="${x(s.year)}" cy="${y(s.lastFrost)}" r="4" fill="var(--o-frost)" stroke="var(--surface)" stroke-width="2"/>`;
  const labels = [];
  for (const [key, text] of [['open', 'opens'], ['close', 'closes']]) {
    const t = tr[key];
    if (!Number.isFinite(t.slope)) continue;
    const f = (yr) => Math.max(lo, Math.min(hi, t.intercept + t.slope * yr));
    svg += `<line x1="${x(y0)}" x2="${x(y1)}" y1="${y(f(y0))}" y2="${y(f(y1))}" stroke="var(--text)" stroke-width="2" stroke-linecap="round"/>`;
    labels.push({ y: y(f(y1)), text: `${text} ${esc(lab(Math.round(f(y1))))}` });
  }
  if (labels.length === 2 && Math.abs(labels[0].y - labels[1].y) < 14) { labels[0].y += 7; labels[1].y -= 7; }
  for (const l of labels) svg += `<text class="lab" x="${x(y1) + bw / 2 + 6}" y="${l.y + 4}">${l.text}</text>`;
  for (const s of seasons) svg += `<rect class="yrhit" data-y="${s.year}" x="${x(s.year) - band / 2}" y="${m.t}" width="${band}" height="${H - m.t - m.b}" fill="transparent"/>`;
  host.innerHTML = svg + '</svg>';

  const bySeason = new Map(seasons.map((s) => [String(s.year), s]));
  host.querySelectorAll('.yrhit').forEach((r) => {
    r.addEventListener('pointermove', (e) => {
      const s = bySeason.get(r.dataset.y);
      const win = Number.isFinite(s.open) ? `<div>Safe to plant<em>${esc(lab(s.open))} – ${esc(lab(s.close))}</em></div>` : `<div>${s.complete ? 'No safe planting date' : 'Season still in progress'}</div>`;
      showTip(e, `<b>${esc(s.label)}</b>${win}${Number.isFinite(s.lastFrost) ? `<div>Last spring frost<em>${esc(lab(s.lastFrost))}</em></div>` : ''}`);
    });
    r.addEventListener('pointerleave', hideTip);
  });
}

// ------------------------------------------------------------ chart: heatmap

function renderHeat() {
  const { result } = current;
  const { seasons, outcomes } = result;
  const host = $('heatChart'), canvas = $('heat');
  $('heatLegend').innerHTML = `<span><i class="sw" style="background:var(--o-ok);outline:1px solid var(--line)"></i>Crop succeeds</span>` + OUTCOMES.map((o) => `<span><i class="sw" style="background:var(--o-${o.key})"></i>${o.label}</span>`).join('');
  const css = getComputedStyle(document.documentElement);
  const col = (n) => css.getPropertyValue(n).trim();
  const colors = { [OUT.OK]: col('--o-ok'), [OUT.UNKNOWN]: col('--o-unknown') };
  for (const o of OUTCOMES) colors[o.code] = col(`--o-${o.key}`);

  const W = Math.max(320, host.clientWidth), ml = 52, mb = 20;
  const rowH = Math.max(5, Math.min(9, Math.floor(360 / seasons.length)));
  const H = seasons.length * rowH + mb;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr; canvas.height = H * dpr; canvas.style.height = `${H}px`;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, W, H);
  const cw = (W - ml) / SEASON_DAYS;
  seasons.forEach((s, k) => {
    // Draw runs of equal outcome as one rectangle so there are no seams.
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
  for (const t of monthTicks(result, W)) g.fillText(t.label, ml + t.o * cw + 2, H - 5);

  canvas.onpointermove = (e) => {
    const box = canvas.getBoundingClientRect();
    const k = Math.floor((e.clientY - box.top) / rowH), o = Math.floor((e.clientX - box.left - ml) / cw);
    if (k < 0 || k >= seasons.length || o < 0 || o >= SEASON_DAYS) return hideTip();
    const c = outcomes[k * SEASON_DAYS + o];
    const what = c === OUT.OK ? 'Crop succeeds' : c === OUT.UNKNOWN ? 'Not known yet' : byCode[c].label;
    showTip(e, `<b>${esc(seasons[k].label)} · planted ${esc(lab(o))}</b><div>${c > 0 ? `<i class="sw" style="background:var(--o-${byCode[c].key})"></i>` : ''}${what}</div>`);
  };
  canvas.onpointerleave = hideTip;
}

// ---------------------------------------------------------- satellite check

let ndviRun = 0;
let ndviAbort = null;

function resetNdvi() {
  const n = ndviTargets(current.result).length;
  $('ndviLegend').innerHTML = ''; $('ndviChart').innerHTML = ''; $('ndviNote').hidden = true;
  $('ndviBody').innerHTML = n
    ? `<div class="ndvistart"><button type="button" id="ndviGo" class="primary">Run satellite check on ${n} seasons</button><span class="hint">Fetched from NASA one season at a time; it can take a few minutes, and results appear as they arrive.</span></div>`
    : '<p class="sub">There is no recommended window here to check.</p>';
  $('ndviGo')?.addEventListener('click', runNdvi);
  renderSatStrip();
}

const SAT_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><g transform="rotate(-35 12 12)" fill="currentColor"><rect x="9" y="9" width="6" height="6" rx="1"/><rect x="1.500" y="10" width="6" height="4" rx=".5"/><rect x="16.500" y="10" width="6" height="4" rx=".5"/></g><path d="M5 19a6 6 0 0 0 4 1.500M3.500 16.500" fill="none" stroke="currentColor" stroke-width="1.500" stroke-linecap="round"/></svg>';

/** The satellite verdict, surfaced at the top of the recommendation and on the ribbon. */
function renderSatStrip() {
  const el = $('satStrip');
  if (!el) return;
  const n = ndviTargets(current.result).length;
  const nd = current.ndvi;
  const more = '<button type="button" class="ghost" data-sat="more">See the evidence</button>';
  let cls = 'idle', html;
  if (!nd) {
    html = `<div><b>Not yet checked against satellite.</b> See whether this field really greened up on this schedule in the last ${n} seasons.</div><button type="button" class="primary" data-sat="go">Run satellite check</button>`;
  } else if (!nd.state.finished) {
    cls = 'busy';
    html = `<div><b>Checking against satellite…</b> ${nd.state.done} of ${nd.state.total} seasons fetched from NASA.<div class="progress wide"><span style="width:${(nd.state.done / nd.state.total) * 100}%;animation:none"></span></div></div>${more}`;
  } else if (nd.state.done === nd.state.failed) {
    html = '<div><b>Satellite check unavailable.</b> NASA\'s service did not answer.</div><button type="button" class="primary" data-sat="go">Try again</button>';
  } else {
    const s = nd.cmp.summary;
    cls = s.verdict;
    const [title, text] = NDVI_VERDICT[s.verdict] ?? ['Satellite check inconclusive', () => 'Too few seasons showed both a model window and a clear green-up.'];
    html = `<div><b>${title}.</b> ${esc(text(s))}</div>${more}`;
  }
  el.className = `satstrip ${cls}`;
  el.innerHTML = `<span class="saticon">${SAT_ICON}</span>${html}`;
  el.querySelector('[data-sat=go]')?.addEventListener('click', () => { runNdvi(); });
  el.querySelector('[data-sat=more]')?.addEventListener('click', () => $('ndviCard').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' }));

  // Mark the observed green-up on the season ribbon.
  const ribbon = $('rec').querySelector('.ribbon');
  ribbon?.querySelector('.mark.green')?.remove();
  const g = nd?.cmp.summary.medianGreen;
  if (ribbon && Number.isFinite(g)) ribbon.insertAdjacentHTML('beforeend', `<div class="mark green" style="left:${((((g % 365) + 365) % 365) / 365) * 100}%"><b>Green-up seen</b></div>`);
}

async function runNdvi() {
  const id = ++ndviRun;
  const run = current;
  const { result, crop, lat, lon } = run;
  const targets = ndviTargets(result);
  const observed = [];
  const ctrl = new AbortController();
  ndviAbort = ctrl;
  const state = { done: 0, failed: 0, total: targets.length, finished: false };
  const update = () => {
    if (id !== ndviRun) return;
    run.ndvi = { cmp: compareNdvi(result, crop, observed), state };
    renderNdvi();
  };
  update();
  const queue = [...targets];
  // Two at a time: the service starts refusing requests beyond that.
  await Promise.all([0, 1].map(async () => {
    for (let t; id === ndviRun && (t = queue.shift());) {
      try { observed.push({ year: t.year, points: await fetchNdvi(lat, lon, t.dates, ctrl.signal) }); } catch { state.failed++; }
      state.done++;
      update();
    }
  }));
  state.finished = true;
  update();
}

const NDVI_VERDICT = {
  agrees: ['Satellite agrees', (s) => `In ${s.inside} of ${s.judged} seasons the field greened up when a crop sown inside the model's safe dates would have.`],
  partly: ['Partial agreement', (s) => `In ${s.inside} of ${s.judged} seasons the green-up matched a crop sown inside the model's safe dates; in the rest it came ${s.offset < 0 ? 'earlier' : 'later'}.`],
  earlier: ['Greens up earlier than the model expects', (s) => `Only ${s.inside} of ${s.judged} seasons matched. The land turns green about ${Math.abs(Math.round(s.offset))} days ahead of a crop sown on the recommended best day: farmers here may sow earlier, or this pixel is pasture, trees or a winter crop.`],
  later: ['Greens up later than the model expects', (s) => `Only ${s.inside} of ${s.judged} seasons matched. The land turns green about ${Math.round(s.offset)} days behind a crop sown on the recommended best day: farmers here may sow later, or grow a different crop.`],
  'no-crop': ['This pixel does not look like cropland', (s) => `Only ${s.greened} of ${s.checked} seasons showed a clear seasonal green-up. Try moving the pin onto a field.`],
};

function renderNdvi() {
  const { cmp, state } = current.ndvi;
  const s = cmp.summary;
  let html = '';
  if (!state.finished) html += `<div class="ndviprog"><div class="progress wide"><span style="width:${(state.done / state.total) * 100}%;animation:none"></span></div><span class="hint">Fetched ${state.done} of ${state.total} seasons from NASA… each can take up to a minute.</span></div>`;
  if (state.finished && state.done === state.failed) {
    html += '<p class="sub">NASA\'s MODIS service did not answer. <button type="button" id="ndviGo" class="ghost">Try again</button></p>';
  } else if (NDVI_VERDICT[s.verdict]) {
    const [title, text] = NDVI_VERDICT[s.verdict];
    html += `<div class="verdict ${s.verdict}"><b>${title}${state.finished ? '' : ' so far'}.</b> ${esc(text(s))}</div>`;
  }
  if (s.greened) {
    const off = Math.round(s.offset);
    const strength = !Number.isFinite(s.rho) ? null : s.rho >= 0.5 ? 'Strong' : s.rho >= 0.25 ? 'Moderate' : s.rho > -0.25 ? 'Weak' : 'Opposite';
    html += `<div class="tiles">
      <div class="tile"><div class="k">Typical green-up</div><div class="v">${esc(lab(Math.round(s.medianGreen)))}</div><div class="d">halfway to peak greenness</div></div>
      <div class="tile"><div class="k">Satellite-implied sowing</div><div class="v">${esc(lab(Math.round(s.medianImplied)))}</div><div class="d">${Math.abs(off) < 2 ? 'on' : `${Math.abs(off)} days ${off < 0 ? 'before' : 'after'}`} the recommended best day</div></div>
      ${strength ? `<div class="tile"><div class="k">Early years match early years</div><div class="v">${strength}</div><div class="d">rank correlation ${s.rho.toFixed(2)} between model and satellite</div></div>` : ''}
      <div class="tile"><div class="k">Peak greenness</div><div class="v">${s.medianPeak.toFixed(2)}</div><div class="d">NDVI; dense crops reach 0.8 or more</div></div>
    </div>`;
  }
  $('ndviBody').innerHTML = html;
  $('ndviGo')?.addEventListener('click', runNdvi);
  $('ndviNote').hidden = !s.greened;
  $('ndviNote').textContent = `Implied sowing is green-up minus ${s.lag} days (emergence plus about 30 days to mid green-up). Dates from 16-day composites are good to about ±${TOLERANCE} days.${state.failed ? ` ${state.failed} season${state.failed > 1 ? 's' : ''} could not be fetched.` : ''}`;

  // Chart: the model's safe dates per year (bars) against satellite-implied sowing (dots).
  const host = $('ndviChart');
  const rows = cmp.years;
  renderSatStrip();
  if (!s.greened || rows.length < 2) { host.innerHTML = ''; $('ndviLegend').innerHTML = ''; return; }
  $('ndviLegend').innerHTML = '<span><i class="sw" style="background:var(--window)"></i>Dates the model called safe</span><span><i class="sw dot" style="background:var(--o-short)"></i>Satellite-implied sowing, inside</span><span><i class="sw dot ring"></i>Outside</span>';
  const W = Math.max(320, host.clientWidth), H = Math.min(300, Math.max(220, W * 0.34));
  const m = { l: 48, r: 14, t: 10, b: 24 };
  const vals = rows.flatMap((r) => [r.open, r.close, r.implied]).filter(Number.isFinite);
  const lo = Math.min(...vals) - 8, hi = Math.max(...vals) + 8;
  const y0 = rows[0].year, y1 = rows[rows.length - 1].year;
  const band = (W - m.l - m.r) / (y1 - y0 + 1);
  const x = (yr) => m.l + (yr - y0 + 0.5) * band;
  const y = (o) => H - m.b - ((o - lo) / (hi - lo)) * (H - m.t - m.b);
  const bw = Math.max(4, Math.min(14, band - 4));
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Model safe planting dates and satellite-implied sowing date for each season">`;
  const step = hi - lo > 150 ? 30 : hi - lo > 70 ? 14 : 7;
  for (let o = Math.ceil(lo / step) * step; o <= hi; o += step) svg += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(o)}" y2="${y(o)}"/><text x="${m.l - 6}" y="${y(o) + 4}" text-anchor="end">${esc(lab(((o % 365) + 365) % 365))}</text>`;
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
      showTip(e, `<b>${esc(r.label)}</b><div>Model: safe to plant<em>${Number.isFinite(r.open) ? `${esc(lab(r.open))} – ${esc(lab(r.close))}` : 'no date'}</em></div>${Number.isFinite(r.green) ? `<div>Satellite green-up<em>${esc(lab(Math.round(r.green)))}</em></div><div>Implied sowing<em>${esc(lab(Math.round(r.implied)))}</em></div>` : '<div>No clear green-up seen</div>'}`);
    });
    el.addEventListener('pointerleave', hideTip);
  });
}

// -------------------------------------------------------------------- table

function tableRows() {
  const f = (o) => (Number.isFinite(o) ? lab(o) : '');
  return current.result.seasons.map((s) => [s.label, f(s.open), f(s.close), Number.isFinite(s.length) ? s.length : '', f(s.lastFrost), f(s.firstFrost), Number.isFinite(s.gdd) ? Math.round(s.gdd) : '', Number.isFinite(s.rain) ? Math.round(s.rain) : '']);
}
const HEAD = ['Season', 'Window opens', 'Window closes', 'Safe days', 'Last spring frost', 'First autumn frost', 'GDD (°C·days)', 'Rain (mm)'];

function renderTable() {
  $('yearTable').innerHTML = `<thead><tr>${HEAD.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${tableRows().map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
}
$('csv').addEventListener('click', () => {
  if (!current) return;
  const csv = [HEAD, ...tableRows()].map((r) => r.map((c) => `"${c}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `seedline_${$('crop').value}_${current.lat.toFixed(2)}_${current.lon.toFixed(2)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ------------------------------------------------------- restore from link

const h = location.hash.slice(1).split(',');
if (h.length >= 3 && Number.isFinite(+h[0]) && Number.isFinite(+h[1]) && CROPS[h[2]]) {
  $('crop').value = h[2];
  syncChips();
  if (MATURITY[h[3]]) $('maturity').value = h[3];
  $('irrigated').checked = h[4] === '1';
  setPicking(false);
  setPin(+h[0], +h[1], { pan: true });
  run();
}
