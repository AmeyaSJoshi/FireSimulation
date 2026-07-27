import fields from '../src/lib/regionalBenchmarkFields.generated.json' with { type: 'json' };
import {
  HACKATHON_BENCHMARK_DEFINITIONS,
  nearestWellConnectedIgnition
} from '../src/lib/hackathonBenchmarkRunner.js';
import { summarizeHackathonBenchmarks } from '../src/lib/hackathonValidation.js';
import {
  rasterizePerimeterGeometry,
  validateArrivalAgainstPerimeter
} from '../src/lib/perimeterValidation.js';
import { createSpatialGrid } from '../src/lib/spatialGrid.js';
import { createJacFireRequest } from '../src/sim/jacFireContract.js';
import { propagateRothermelWithJac } from '../src/sim/jacPropagation.js';

const DEFAULT_SIZE = 128;
const DEFAULT_CELL_SIZE_METERS = 100;
const endpoint = process.env.JAC_ENDPOINT ?? 'http://127.0.0.1:8010/walker/RunFire';
const requestedId = process.argv.includes('--case')
  ? process.argv[process.argv.indexOf('--case') + 1]
  : null;
const staticWeather = process.argv.includes('--static-weather');
const includeExpansion = process.argv.includes('--include-expansion');
const fieldsById = new Map(fields.map((entry) => [entry.id, entry]));

function expectedLength(size) {
  return size * size;
}

function scenarioInput(definition) {
  const size = definition.size ?? DEFAULT_SIZE;
  const cellSizeMeters = definition.cellSizeMeters ?? DEFAULT_CELL_SIZE_METERS;
  const field = fieldsById.get(definition.id);
  if (!field?.fuel?.available || field.fuel.fuelModelCodes.length !== expectedLength(size)) {
    throw new Error(`${definition.id}: frozen mapped fuel is unavailable`);
  }
  if (!field?.terrain?.available || field.terrain.heights.length !== expectedLength(size)) {
    throw new Error(`${definition.id}: frozen terrain is unavailable`);
  }
  if (!field?.weather?.available || !Array.isArray(field.weather.windTimeline) || field.weather.windTimeline.length === 0) {
    throw new Error(`${definition.id}: frozen historical weather is unavailable`);
  }
  const grid = createSpatialGrid({ ...definition.center, cellSizeMeters, gridSize: size });
  const rawIgnition = definition.ignition ?? (() => {
    const cell = grid.latLonToCell(
      definition.fixture.ignition.latitude,
      definition.fixture.ignition.longitude
    );
    return { x: cell.col, y: cell.row };
  })();
  const ignition = (!definition.fixture.ignition)
    ? nearestWellConnectedIgnition({
      fuelModelCodes: field.fuel.fuelModelCodes,
      size,
      startCol: Math.round(rawIgnition.x),
      startRow: Math.round(rawIgnition.y)
    })
    : rawIgnition;
  return { field, grid, size, cellSizeMeters, ignition };
}

async function scoreCase(definition) {
  const { field, grid, size, cellSizeMeters, ignition } = scenarioInput(definition);
  const ignitionIndex = Math.floor(ignition.y) * size + Math.floor(ignition.x);
  const initialWeather = field.weather.windTimeline[0];
  const request = createJacFireRequest({
    fuelCodes: field.fuel.fuelModelCodes,
    terrainHeights: field.terrain.heights,
    gridSize: size,
    cellSizeMeters,
    ignitionIndex,
    maxPropagationMinutes: definition.modelTimeMinutes,
    deadMoistureFraction: initialWeather.deadMoistureByClass?.['1h'] ?? 0.05,
    liveMoistureFraction: initialWeather.liveMoistureByClass?.woody ?? 0.5,
    deadMoistureByClass: initialWeather.deadMoistureByClass ?? null,
    liveMoistureByClass: initialWeather.liveMoistureByClass ?? null,
    weatherTimeline: staticWeather ? null : field.weather.windTimeline,
    tenMeterWindKmh: initialWeather.tenMeterWindKmh,
    windDirectionRadians: initialWeather.windDirectionRadians
  });
  const jac = await propagateRothermelWithJac(request, { endpoint });
  if (jac.engine !== 'jac-rothermel' || !jac.arrivalField) {
    throw new Error(`${definition.id}: Jac RunFire is required (${jac.fallbackReason ?? jac.engine})`);
  }
  const arrivals = Float64Array.from(jac.arrivalField, (value) => value < 0 ? Infinity : value);
  const observedMask = rasterizePerimeterGeometry({ geometry: definition.fixture.geometry, grid });
  return {
    id: definition.id,
    name: definition.fixture.name,
    split: definition.split,
    engine: jac.engine,
    grid: { size, cellSizeMeters },
    modelTimeMinutes: definition.modelTimeMinutes,
    ignitionAssumption: definition.ignitionAssumption,
    inputProfile: 'frozen mapped WorldCover fuel; frozen terrain; frozen archived weather; Jac surface spread only',
    report: validateArrivalAgainstPerimeter({
      arrivalTimes: arrivals,
      observedMask,
      size,
      modelTimeMinutes: definition.modelTimeMinutes,
      cellSizeMeters
    })
  };
}

const definitions = HACKATHON_BENCHMARK_DEFINITIONS.filter((definition) => (
  requestedId
    ? definition.id === requestedId
    : (includeExpansion || definition.split !== 'expansion')
));
if (definitions.length === 0) {
  throw new RangeError(`Unknown benchmark case: ${requestedId}`);
}
const cases = [];
for (const definition of definitions) {
  console.error(`Jac benchmark: ${definition.id}`);
  cases.push(await scoreCase(definition));
}
const summary = summarizeHackathonBenchmarks(cases);
console.log(JSON.stringify({
  benchmark: staticWeather
    ? 'Jac six-fire static-weather surface perimeter diagnostic'
    : 'Jac six-fire time-varying-weather surface perimeter diagnostic',
  endpoint,
  engine: 'jac-rothermel',
  caseCount: cases.length,
  primaryScore: {
    label: 'mean IoU across the scored frozen cases',
    value: summary.meanIoU
  },
  summary,
  cases,
  limitation: `${staticWeather ? 'This diagnostic holds each case at its ignition-time weather; the full archived timeline is not applied. ' : ''}This measures final perimeters for these six fixtures only. Several ignition points are documented assumptions; no suppression, crown-fire, spotting, or fuel-persistence effects are represented by this Jac surface solver. It is not a universal or operational accuracy claim.`
}, null, 2));

