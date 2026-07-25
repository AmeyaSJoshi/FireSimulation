import { runConusHackathonBenchmarks } from '../src/lib/hackathonBenchmarkRunner.js';

function numericArgument(name, fallback, minimum = 0, maximum = Infinity) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be in [${minimum}, ${maximum}]`);
  }
  return value;
}

console.log(JSON.stringify(runConusHackathonBenchmarks({
  deadMoistureFraction: numericArgument('--dead-moisture', 0.05, 0, 1),
  liveMoistureFraction: numericArgument('--live-moisture', 0.5, 0, 2),
  midflameWindKmh: numericArgument('--wind-kmh', 0),
  fuelLoadScale: numericArgument('--fuel-scale', 1, 0, 1),
  enableSpotting: process.argv.includes('--enable-spotting')
}), null, 2));
