// Crop parameters. These are agronomic rules of thumb drawn from extension
// guidance, not cultivar-specific truth — tune them for local varieties.
//
// base / cap   growing-degree-day base and upper cutoff (°C)
// gdd          thermal time from planting to physiological maturity (°C·day),
//              for the medium maturity class; `maturity` scales it
// germ         minimum 7-day mean air temperature after planting for the seed
//              to germinate reliably (proxy for soil temperature, °C)
// frostKill    2 m minimum temperature at or below which an emerged crop is
//              lost (°C)
// emerge       days from planting to emergence (frost cannot hurt before this)
// heat         daily maximum that damages flowering (°C)
// maxDays      longest crop cycle considered practical
export const CROPS = {
  maize:     { name: 'Maize (corn)',  base: 10, cap: 30, gdd: 1400, germ: 10, frostKill: -1, emerge: 8,  heat: 36, maxDays: 200 },
  soybean:   { name: 'Soybean',       base: 10, cap: 30, gdd: 1300, germ: 12, frostKill: -1, emerge: 7,  heat: 37, maxDays: 170 },
  wheat:     { name: 'Spring wheat',  base: 0,  cap: 30, gdd: 1600, germ: 4,  frostKill: -5, emerge: 10, heat: 33, maxDays: 160 },
  sorghum:   { name: 'Sorghum',       base: 10, cap: 34, gdd: 1500, germ: 15, frostKill: 0,  emerge: 7,  heat: 40, maxDays: 170 },
  millet:    { name: 'Pearl millet',  base: 10, cap: 35, gdd: 1500, germ: 16, frostKill: 0,  emerge: 5,  heat: 42, maxDays: 150 },
  cotton:    { name: 'Cotton',        base: 15.6, cap: 35, gdd: 1300, germ: 16, frostKill: 0, emerge: 8, heat: 40, maxDays: 200 },
  potato:    { name: 'Potato',        base: 7,  cap: 30, gdd: 1200, germ: 7,  frostKill: -2, emerge: 18, heat: 34, maxDays: 160 },
  bean:      { name: 'Dry bean',      base: 10, cap: 30, gdd: 1050, germ: 13, frostKill: 0,  emerge: 7,  heat: 35, maxDays: 140 },
  sunflower: { name: 'Sunflower',     base: 7,  cap: 30, gdd: 1600, germ: 8,  frostKill: -2, emerge: 9,  heat: 38, maxDays: 170 },
};

export const MATURITY = {
  early:  { name: 'Early',  scale: 0.87 },
  medium: { name: 'Medium', scale: 1.0 },
  late:   { name: 'Late',   scale: 1.13 },
};
