# Seedline

Drop a pin on a map, pick a crop. Seedline pulls 45 years of daily weather for
that exact spot from NASA, shows how the safe planting window has moved over
the decades, and recommends a window for the coming season with a risk score.

![Seedline showing a maize recommendation for central Iowa](docs/screenshot.png)

## Run it

It is a static site with no build step and no API key.

```bash
npm start
```

Then open http://localhost:8000. Any static file server works (or GitHub
Pages). Tests run with:

```bash
npm test
```

## How it works

**Data.** One request to the [NASA POWER](https://power.larc.nasa.gov/) daily
point API returns minimum and maximum temperature, rainfall and solar
radiation from 1981 to this week (`js/power.js`).

**Replay, not averages.** For every year on record and every possible planting
day, the crop is "grown" through the weather that actually followed
(`simulatePlanting` in `js/analysis.js`). A planting succeeds only if it:

1. germinates: the 7-day mean temperature after sowing clears the crop's minimum;
2. establishes: a soil-water bucket (rain in, Hargreaves evapotranspiration
   out, using measured solar radiation) holds enough moisture for three weeks;
3. escapes frost between emergence and maturity;
4. avoids damaging heat during flowering;
5. is not under severe water stress for most of its cycle;
6. accumulates enough growing-degree days to mature before the season ends.

Each failure is labelled with its cause, giving a year × planting-day table of
outcomes that everything else is derived from.

**Recommendation.** Outcomes are pooled across years with recent years
weighted most (15-year e-folding), so the answer reflects today's climate
rather than the 1980s. The window is the run of planting dates with at least
an 80% chance of success; the risk score is 100 minus the average chance of
success inside it.

**Trend detection.** Each year's own safe window, last spring frost, first
autumn frost, season heat and rainfall are tested with a Theil–Sen slope and a
Mann–Kendall significance test, and the 1981–2000 window is compared with the
last 15 years.

**Satellite check.** On request, the app pulls MODIS NDVI (MOD13Q1, 250 m,
16-day) for the pixel under the pin from NASA's
[ORNL DAAC subset service](https://modis.ornl.gov/data/modis_webservice.html),
for the last 15 seasons. Green-up is the date NDVI is halfway from its
pre-season low to its peak; stepping back by emergence plus about 30 days
gives a satellite-implied sowing date, which is compared with the dates the
weather model called safe in that same year (`js/ndvi.js`). The service
returns 10 composites per request and can be slow, so seasons are fetched two
at a time, shown as they arrive, and cached in the browser.

## Layout

| Path | What |
|---|---|
| `js/analysis.js` | The model: water balance, crop replay, windows, trends. No DOM. |
| `js/crops.js` | Crop parameters (GDD base and target, frost and heat limits). |
| `js/power.js` | NASA POWER fetch. |
| `js/ndvi.js` | Satellite check: green-up dating and comparison with the model. No DOM. |
| `js/modis.js` | MODIS NDVI fetch with retry and browser cache. |
| `js/app.js` | Map, controls and charts. |
| `test/` | Unit tests on synthetic climates. |
| `vendor/leaflet/` | Leaflet 1.9.4 (BSD-2-Clause), vendored so the demo has no CDN dependency. |

## Limits

- POWER weather is a roughly 50 km grid average. Frost pockets, slopes and
  local soils are invisible to it, and grid-average minimum temperatures run
  warmer than a cold hollow.
- Crop parameters are generic rules of thumb, not cultivar-specific. Edit
  `js/crops.js` for local varieties.
- The soil is one 100 mm bucket everywhere. Irrigated fields should tick
  "Irrigated field", which lifts the rainfall rules.
- The satellite check sees one 250 m pixel, which may be pasture, trees or a
  different crop, and its dates are good to about ±8 days. The 30-day
  green-up lag is a rule of thumb.
- Only spring-sown, single-season crops are modelled (no winter wheat, no
  paddy rice).

## Next

- Screen NDVI with the MODIS pixel-reliability band instead of the simple
  dip filter, and average a few pixels around the pin.
- Units in °F and inches.
