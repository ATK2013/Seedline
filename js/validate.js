// Validation page: run the model live for each reference site and compare its
// recommended window with the published usual planting period.
import { CROPS } from './crops.js?v=7';
import { fetchDaily } from './power.js?v=7';
import { parsePower, analyze } from './analysis.js?v=7';
import { SITES, scoreSite } from './validation-sites.js?v=7';

const DAY = 86400000;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const LABEL = { hit: 'Hit', near: 'Near', miss: 'Miss', none: 'No window', wait: '…', error: 'No data' };
const rows = SITES.map((site) => ({ site, verdict: 'wait' }));

function draw() {
  const done = rows.filter((r) => r.verdict !== 'wait');
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  $('vhead').textContent = done.length < rows.length ? `Running the model: ${done.length} of ${rows.length} sites…` : `${count('hit')} of ${rows.length} hits, ${count('near')} near, ${count('miss') + count('none')} missed`;
  $('vsum').innerHTML = ['hit', 'near', 'miss', 'none'].map((v) => `<div class="tile"><div class="k"><span class="pill ${v}">${LABEL[v]}</span></div><div class="v">${count(v)}</div></div>`).join('');
  $('vtable').innerHTML = `<thead><tr><th>Region</th><th>Crop</th><th>Published</th><th>Model</th><th>Jan → Dec (season year)</th><th>Result</th></tr></thead><tbody>${rows.map((r) => {
    const d = (o) => new Date(r.refStartMs + o * DAY).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const bar = (cls, a, b) => `<i class="${cls}" style="left:${(a / 365) * 100}%;width:${Math.max(1, ((b - a) / 365) * 100)}%"></i>`;
    const ok = r.score;
    return `<tr><td>${esc(r.site.place)}${r.site.irrigated ? ' <span class="hint">(irrigated)</span>' : ''}</td><td>${esc(CROPS[r.site.crop].name)}</td>
      <td>${ok ? `${d(ok.ref.open)} – ${d(ok.ref.close)}` : ''} <span class="hint">${r.site.src === 'US' ? 'USDA' : 'FAO'}</span></td>
      <td>${r.rec?.viable ? `${d(r.rec.open)} – ${d(r.rec.close)}` : ok ? 'none' : ''}</td>
      <td><div class="vbar">${ok ? bar('ref', ok.ref.open, ok.ref.close) : ''}${r.rec?.viable ? bar('mod', r.rec.open, r.rec.close) : ''}</div></td>
      <td><span class="pill ${r.verdict}">${LABEL[r.verdict]}</span>${ok && Number.isFinite(ok.shift) ? ` <span class="hint">${ok.shift === 0 ? 'on time' : `${Math.abs(ok.shift)} d ${ok.shift > 0 ? 'later' : 'earlier'}`}</span>` : ''}</td></tr>`;
  }).join('')}</tbody>`;
}

draw();
const queue = [...rows];
await Promise.all([0, 1, 2].map(async () => {
  for (let r; (r = queue.shift());) {
    try {
      const result = analyze(parsePower(await fetchDaily(r.site.lat, r.site.lon)), CROPS[r.site.crop], r.site.lat, { irrigated: !!r.site.irrigated });
      r.score = scoreSite(r.site, result);
      r.rec = result.rec;
      r.refStartMs = result.refStartMs;
      r.verdict = r.score.verdict;
    } catch { r.verdict = 'error'; }
    draw();
  }
}));
