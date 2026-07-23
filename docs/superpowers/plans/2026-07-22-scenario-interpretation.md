# Scenario Interpretation Implementation Plan

> **For agentic workers:** Execute this plan inline in the current task with test-first checkpoints.

**Goal:** Make every land ignition a reproducible, interpretable scenario run with explicit metadata, calibrated model-time metrics, and clear visual interpretation.

**Architecture:** Keep the existing worker-based cellular automaton and add deterministic metrics at the simulation boundary. Keep display formatting in a focused pure module so the UI can render metadata and explanations without embedding math or policy decisions in `main.js`. Add presentation-only overlays and metadata rows to the existing instrument panels while preserving one-click land ignition.

**Tech Stack:** Vanilla JavaScript ES modules, Three.js, Web Worker, Node test runner, Vite.

## Global Constraints

- Preserve direct land-click ignition and ocean rejection.
- Keep the physical model at 128 x 128 cells, 1 km per cell, 128 km field.
- Treat model time as an explicit educational convention: 1 simulation step = 1 model minute.
- Never describe synthetic fallback terrain as measured terrain.
- Use deterministic seeds and pure helpers for testable interpretation behavior.
- Verify with `npm test`, `npm run build`, `git diff --check`, and a live browser smoke test.

### Task 1: Define interpretation helpers

**Files:**
- Create: `src/lib/scenarioInterpretation.js`
- Create: `src/lib/scenarioInterpretation.test.js`

**Interfaces:**
- `formatModelTime(minutes)` returns a compact `Hh Mm` or `Mm` label.
- `formatCompassDirection(degrees)` returns a 16-point compass label.
- `buildSpreadExplanation({ direction, windSpeed, slopeStrength, moisture })` returns a short plain-language explanation.

- [ ] Write failing tests for model-time formatting, compass wrapping, and explanation precedence.
- [ ] Run `npm test` and verify the new test fails because the helper module is missing.
- [ ] Implement the smallest pure helper module that satisfies those tests.
- [ ] Run `npm test` and verify all tests pass.

### Task 2: Add deterministic simulation metrics

**Files:**
- Modify: `src/lib/fireSimulation.js`
- Modify: `src/lib/fireSimulation.test.js`
- Modify: `src/workers/fireWorker.js`

**Interfaces:**
- `getMetrics(cellSizeKm, timestepMinutes)` additionally returns `elapsedMinutes`, `maxSpreadDistanceKm`, `averageSpreadRateKmh`, and `dominantSpreadDirectionDeg`.
- Worker frames pass through the expanded metrics unchanged.

- [ ] Write failing tests for elapsed model time, farthest reached distance, compass direction, and average rate.
- [ ] Run the focused fire tests and verify failure.
- [ ] Implement metrics from reached cells relative to the ignition cell, preserving existing area and perimeter calculations.
- [ ] Pass `timestepMinutes: 1` from the worker and use it when calculating metrics.
- [ ] Run the full test suite and verify green.

### Task 3: Build the scenario metadata and interpretation UI

**Files:**
- Modify: `index.html`
- Modify: `src/main.js`
- Modify: `src/styles.css`

**Interfaces:**
- Add metadata rows for model, terrain, fuel, wind, moisture, slope, and seed.
- Add a four-state fire legend and a scale/north marker overlay.
- Render metrics for model time, burned area, footprint, perimeter, maximum spread, average rate, and dominant direction.
- Render a plain-language driver explanation from the current metrics and controls.

- [ ] Add stable DOM IDs and accessible labels for the new fields.
- [ ] Initialize metadata to placeholders and reset it on new/blocked selections.
- [ ] Populate metadata when a run starts and update terrain status after the elevation request resolves.
- [ ] Update the interpretation readout from worker metrics without overwriting terrain provenance.
- [ ] Add responsive CSS that keeps all text inside the panels at desktop and mobile widths.

### Task 4: Verify the complete workflow

**Files:**
- Modify: `src/lib/scenarioInterpretation.test.js` only if a discovered edge case requires a pure regression test.

- [ ] Run `npm test` and confirm all tests pass.
- [ ] Run `npm run build` and confirm Vite completes.
- [ ] Run `git diff --check`.
- [ ] Browser-test initial placeholders, confirmed land ignition, GLO-90 metadata, advancing model time, metrics, legend, and an ocean click that stops/clears the run.
- [ ] Browser-test a narrow viewport and confirm metadata text does not overflow or overlap.
- [ ] Leave the verified localhost tab open.
