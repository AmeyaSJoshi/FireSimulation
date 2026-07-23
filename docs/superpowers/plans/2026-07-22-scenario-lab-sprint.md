# Scenario Lab Sprint Implementation Plan

> **For agentic workers:** Execute this plan inline with test-first checkpoints.

**Goal:** Turn the existing click-to-fire demo into a reproducible, local-first Scenario Lab while keeping the global educational model honest and resilient.

**Architecture:** Keep simulation execution in the existing Web Worker. Add a small pure record module for serializable run history, metric deltas, and injected storage so persistence is testable without a browser. Add a coordinate inverse beside the existing Earth adapter so saved locations can be replayed without depending on the current camera orientation. Keep UI orchestration in `main.js`, with DOM-safe element construction for saved runs.

**Tech Stack:** Vanilla JavaScript ES modules, Three.js, Web Worker, Node test runner, Vite, browser `localStorage`.

## Global Constraints

- Preserve direct land-click ignition and ocean rejection.
- Keep the 128 x 128, 1 km-cell, 1-minute educational cellular model.
- Keep results deterministic for identical location, inputs, terrain, and seed.
- Never describe synthetic fallback terrain as measured terrain.
- Do not add paid services or dependencies.
- Run `npm test`, `npm run build`, and `git diff --check` before claiming completion.

## Tasks

1. Add failing tests for serializable records, bounded persistence, metric deltas, coordinate round-trips, and malformed elevation payloads; verify the tests fail for the missing behavior.
2. Implement the pure record and coordinate helpers, then verify focused tests and the full suite.
3. Add a Recent Runs UI with replay and clear-history actions. Save settled runs to local storage, show input summaries and metric deltas, and replay the saved coordinate/inputs through the existing terrain cache and worker.
4. Add an explicit educational-model warning and a compact terrain attribution/provenance line; keep the detailed metadata visible for curious users.
5. Browser-test fresh ignition, ocean rejection, terrain-backed metrics, replay, persistence after reload, mobile panel scrolling, and console errors. Finish with a production build and whitespace check.
