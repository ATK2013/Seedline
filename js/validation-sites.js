// Reference planting dates the model is checked against.
//
// IMPORTANT: these ranges were written down from memory of the sources below
// and are approximate (to the week for the US, to the half-month elsewhere).
// They have NOT been re-checked line by line against the publications.
// Verify them before citing the validation result anywhere that matters.
//
//  US   USDA NASS, "Field Crops: Usual Planting and Harvesting Dates"
//       (Agricultural Handbook 628, October 2010), "most active" period.
//  FAO  FAO GIEWS country crop calendars, sowing period.
//
// ref: [startMonth, startDay, endMonth, endDay]
export const SITES = [
  { place: 'Central Iowa, USA',          lat: 42.03, lon: -93.63, crop: 'maize',       ref: [4, 25, 5, 18], src: 'US' },
  { place: 'Central Illinois, USA',      lat: 40.10, lon: -89.20, crop: 'maize',       ref: [4, 21, 5, 23], src: 'US' },
  { place: 'Eastern Nebraska, USA',      lat: 40.90, lon: -97.00, crop: 'maize',       ref: [4, 27, 5, 17], src: 'US' },
  { place: 'Central Iowa, USA',          lat: 42.03, lon: -93.63, crop: 'soybean',     ref: [5, 8, 6, 2],   src: 'US' },
  { place: 'Central Kansas, USA',        lat: 38.50, lon: -98.50, crop: 'sorghum',     ref: [5, 22, 6, 25], src: 'US' },
  { place: 'Central Kansas, USA',        lat: 38.50, lon: -98.50, crop: 'winterwheat', ref: [9, 15, 10, 20], src: 'US' },
  { place: 'North Dakota, USA',          lat: 47.50, lon: -99.50, crop: 'wheat',       ref: [4, 24, 5, 25], src: 'US' },
  { place: 'Texas High Plains, USA',     lat: 33.60, lon: -101.80, crop: 'cotton',     ref: [5, 5, 6, 5],   src: 'US', irrigated: true },
  { place: 'Snake River Plain, USA',     lat: 42.90, lon: -112.50, crop: 'potato',     ref: [4, 15, 5, 20], src: 'US', irrigated: true },
  { place: 'Arkansas Delta, USA',        lat: 34.50, lon: -91.50, crop: 'rice',        ref: [4, 10, 5, 20], src: 'US', irrigated: true },
  { place: 'Saskatchewan, Canada',       lat: 52.10, lon: -106.60, crop: 'wheat',      ref: [5, 1, 5, 31],  src: 'FAO' },
  { place: 'Paris Basin, France',        lat: 48.50, lon: 2.50,   crop: 'winterwheat', ref: [10, 1, 11, 5], src: 'FAO' },
  { place: 'Central Ukraine',            lat: 49.50, lon: 32.00,  crop: 'maize',       ref: [4, 20, 5, 15], src: 'FAO' },
  { place: 'Niamey, Niger',              lat: 13.50, lon: 2.10,   crop: 'millet',      ref: [6, 1, 7, 15],  src: 'FAO' },
  { place: 'Punjab, India',              lat: 30.90, lon: 75.85,  crop: 'maize',       ref: [6, 15, 7, 15], src: 'FAO' },
  { place: 'Central Plain, Thailand',    lat: 14.50, lon: 100.50, crop: 'rice',        ref: [5, 15, 7, 31], src: 'FAO' },
  { place: 'Lusaka, Zambia',             lat: -15.40, lon: 28.30, crop: 'maize',       ref: [11, 15, 12, 31], src: 'FAO' },
  { place: 'Free State, South Africa',   lat: -27.50, lon: 26.70, crop: 'maize',       ref: [10, 15, 12, 15], src: 'FAO' },
  { place: 'Pampas, Argentina',          lat: -33.90, lon: -60.60, crop: 'soybean',    ref: [10, 25, 12, 15], src: 'FAO' },
  { place: 'Mato Grosso, Brazil',        lat: -13.00, lon: -56.00, crop: 'soybean',    ref: [9, 20, 11, 15], src: 'FAO' },
];

const DAY = 86400000;

/** Reference range as day offsets in the model's season frame. */
export function refOffsets(site, result) {
  const y = new Date(result.refStartMs).getUTCFullYear();
  const off = (m, d) => {
    let o = Math.round((Date.UTC(y, m - 1, d) - result.refStartMs) / DAY);
    if (o < 0) o += 365;
    return o;
  };
  return { open: off(site.ref[0], site.ref[1]), close: off(site.ref[2], site.ref[3]) };
}

/**
 * Score one site. 'hit': the model's best day falls in the reference period,
 * or at least half of the model window does. 'near': the two overlap, or sit
 * within two weeks of each other. Otherwise 'miss'. 'none': no viable window.
 */
export function scoreSite(site, result) {
  const ref = refOffsets(site, result);
  const rec = result.rec;
  if (!rec || !rec.viable) return { verdict: 'none', ref };
  const overlap = Math.max(0, Math.min(rec.close, ref.close) - Math.max(rec.open, ref.open) + 1);
  const gap = overlap ? 0 : Math.max(rec.open - ref.close, ref.open - rec.close);
  const shift = Math.round((rec.open + rec.close) / 2 - (ref.open + ref.close) / 2);   // + = model later
  const bestIn = rec.best >= ref.open - 3 && rec.best <= ref.close + 3;
  const verdict = bestIn || overlap >= (rec.close - rec.open + 1) / 2 ? 'hit' : overlap || gap <= 14 ? 'near' : 'miss';
  return { verdict, ref, overlap, gap, shift };
}
