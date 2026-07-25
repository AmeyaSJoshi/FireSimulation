# RUN-019b record correction — execution plan

**Task:** fix an overstated evidence claim in the RUN-019b record. Two files,
edits only. No network calls, no code, no benchmark runs.

**Verified precondition (do not re-check):** RUN-019 and RUN-019b are NOT in
HEAD — uncommitted, never pushed. So **edit the entries in place**. Do NOT
append a RUN-019c correction entry; a claim that was never published needs no
public correction, and an extra entry is noise.

---

## What's wrong

RUN-019b says the endpoint failed from **"two independent networks"** (the
sandbox and the user's MacBook). False — the sandbox runs on that same
MacBook: same ISP, same router, same DNS. That was one network tested twice.

The conclusion (NO-GO) is correct, and independent evidence now exists — it
just wasn't what was logged.

## Evidence to add (already gathered — do NOT re-run these)

Four curl transport variants against
`https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_FireOccurrenceAndPerimeter_01/MapServer/11?f=json`,
each `HTTP:000 size:0`, hang until timeout:
`--http1.1` · `-A Mozilla/5.0` · `--http1.1 -A Mozilla/5.0 -L` · `--tlsv1.2 --http1.1 -A Mozilla/5.0`

Plus `WebFetch` on the same URL → **`read ECONNRESET`**. WebFetch routes
through different infrastructure than the user's ISP, so this *is* the genuine
independent-path confirmation the original entry claimed but didn't have.

## Two edits

### 1. `docs/regional-model-run/RESULTS.jsonl` — RUN-019b only

- Delete the "two independent networks" phrasing wherever it appears.
- Replace with: same-machine retry (rules out *sandboxing*, not the network),
  **plus** the four transport variants, **plus** the WebFetch ECONNRESET as the
  actual independent-path evidence.
- **Reweight the interpretation.** Currently it leads with connectivity, which
  is the contingent leg. Lead instead with the **schema finding**: the
  `California_fires_since_2014` fallback carries a single `ALARM_DATE`/`CONT_DATE`
  pair with no per-date progression field, so it cannot support suppression
  *regardless of connectivity* — that leg is structural and would hold even if
  USDA came back online. Connectivity becomes the secondary, contingent leg.
- Note the transport-variation check was prompted by this project's own RUN-018
  precedent (a USGS server that rejected Node `fetch` while `curl` succeeded on
  a byte-identical URL) — it should have run before "final" was declared.
- Keep `accuracyClaim: false`. Keep the verdict NO-GO — it is correct.

### 2. `docs/regional-model-run/THREAD.md` — update 9's follow-up paragraph only

Same three changes, one short paragraph: drop "two independent networks", add
the transport-variant + WebFetch evidence, lead with schema over connectivity.

## Guardrails

- Touch **only** RUN-019b and update 9's follow-up. Do not edit RUN-018 or any
  earlier entry, and do not restate the whole suppression story.
- After writing, validate every line parses:
  `python3 -c "import json;[json.loads(l) for l in open('docs/regional-model-run/RESULTS.jsonl')]"`
- Match the existing entry schema exactly (same keys as neighbouring entries).
- Do not soften the verdict while correcting the evidence — NO-GO is right; only
  the strength and ordering of its support is being fixed.

## Done when

Both files updated, JSONL parses, and a one-line report of what changed. Nothing else.
