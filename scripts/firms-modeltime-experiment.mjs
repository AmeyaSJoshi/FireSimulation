// EXPERIMENT ONLY -- lives in scratchpad, never touches the committed repo.
// Overrides modelTimeMinutes on the in-memory HACKATHON_BENCHMARK_DEFINITIONS
// (the mapped definition objects are plain object literals, not frozen --
// only the outer array is Object.freeze()'d) using FIRMS 95%-growth-window
// data computed by firms_growth.py, then reruns the default 6-case
// calibration+holdout benchmark. Baseline fixtures in the repo are untouched.
import { HACKATHON_BENCHMARK_DEFINITIONS, runConusHackathonBenchmarks } from '/Users/ameyajoshi/Claude Projects/Fire Simulation/src/lib/hackathonBenchmarkRunner.js';

// From firms_growth.py output (FIRMS 95%-growth-window days per case).
// dinely-2017 measured 0 days (single active day, 12 detections) -> floored to 1 day.
// stoll-2018 had ZERO FIRMS detections in its bbox+pad during its 1-day
// calendar window -- no data-derived value exists, so its baseline
// modelTimeMinutes (1440) is left unchanged rather than fabricated.
const FIRMS_GROWTH_WINDOW_MINUTES = {
  'oregon-gulch-2014': 3 * 1440,   // 4320
  'big-five-2015': 81 * 1440,      // 116640 (45 detections only -- sparse, low confidence)
  'dinely-2017': 1 * 1440,         // 1440 (floored from measured 0; 12 detections, 1 active day)
  'reservoir-2016': 1 * 1440,      // 1440
  'deer-2016': 1 * 1440            // 1440
  // stoll-2018 intentionally omitted -- no FIRMS detections found, baseline kept.
};

const baselineModelTimeMinutes = {};
for (const def of HACKATHON_BENCHMARK_DEFINITIONS) {
  baselineModelTimeMinutes[def.id] = def.modelTimeMinutes;
  if (Object.prototype.hasOwnProperty.call(FIRMS_GROWTH_WINDOW_MINUTES, def.id)) {
    def.modelTimeMinutes = FIRMS_GROWTH_WINDOW_MINUTES[def.id];
  }
}

const result = runConusHackathonBenchmarks({
  splits: ['calibration', 'holdout']
});

console.log(JSON.stringify({
  experiment: 'firms-95pct-growth-window-modelTimeMinutes',
  baselineModelTimeMinutes,
  appliedModelTimeMinutes: Object.fromEntries(
    HACKATHON_BENCHMARK_DEFINITIONS
      .filter((d) => Object.prototype.hasOwnProperty.call(FIRMS_GROWTH_WINDOW_MINUTES, d.id))
      .map((d) => [d.id, d.modelTimeMinutes])
  ),
  result
}, null, 2));
