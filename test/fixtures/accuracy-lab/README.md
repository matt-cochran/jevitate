# Seeded-defect accuracy lab

A self-contained benchmark for scoring jevitate's verdicts against known ground truth. A plain
`node:http` server serves a fictional **Acme CRM** with three jobs (J1 update profile, J2 send a
message, J3 import a CSV); each variant changes exactly one behaviour, so a verdict can be graded
against `ground-truth.json` instead of a human guess.

Everything is in-process and dependency-free: no build, no external assets, in-memory state reset
per server. A browser run and the fixture tests both drive the same public `data-testid`/HTTP hooks.

## Layout

| path | purpose |
| --- | --- |
| `app.mjs` | the Acme CRM server. CLI: `node app.mjs --port 0 --variant <v>` prints `ACME_CRM_LISTENING <port> variant=<v>`. Library: `startAccuracyLab({ variant, port }) -> { url, port, close }` |
| `ground-truth.json` | per variant: affected job, defect class, step, and the correct `goal`/`usability` verdict |
| `../../scripts/accuracy-lab/run-cell.mjs` | starts `app.mjs` on a free port, runs one `jevitate explore` cell, stops the server, appends one JSON line |
| `../../scripts/accuracy-lab/run-matrix.mjs` | runs the full matrix one cell at a time, skipping cells already recorded |
| `../../scripts/accuracy-lab/score.mjs` | grades a `results.jsonl` against the ground truth |
| `../../scripts/accuracy-lab/score.test.mjs` | `node:test` guard that the 2026-10-23 baseline reproduces its headline numbers |
| `../../scripts/accuracy-lab/fixtures/baseline-results.jsonl` | the frozen 2026-10-23 baseline run |

## Variants

| variant | defect class | affected | expected `goal` | expected `usability` |
| --- | --- | --- | --- | --- |
| `clean` | none | — | succeeds (no defect) | no defect |
| `j1-5xx` | failed-submit-masked | J1 Save | fails/blocks; **defect expected** | **defect expected**: the 500 surfaces via the backend signal |
| `j2-stall` | stall-no-request | J2 Send | blocks; **defect expected** | **defect expected** |
| `j3-effort` | excess-effort | J3 confirm | succeeds; no functional defect | no functional defect, but **effort elevated** |
| `j3-deadend` | dead-end | J3 confirm | blocks; **defect expected** | **defect expected** |

`ground-truth.json` is the source of truth; the table above mirrors it.

## Run the matrix

Cells are `clean` on J1/J2/J3 plus each seeded variant on its affected job, each with both
strategies (`goal`, `usability`), repeated `--replicates` times (default 3). Cells already present
in `<out>/results.jsonl` are skipped, so a rerun finishes an interrupted matrix.

```bash
# From the repo root. --out is REQUIRED; it receives results.jsonl and artifacts/.
node scripts/accuracy-lab/run-matrix.mjs --out /tmp/accuracy-lab --replicates 3

# One cell, for a focused change:
node scripts/accuracy-lab/run-cell.mjs --variant j2-stall --job J2 --strategy goal --replicate 0 --out /tmp/accuracy-lab
```

`run-cell.mjs` runs the global `jevitate` by default; set `JEVITATE_BIN` to a built CLI entry
(e.g. `packages/cli/dist/bin.js`) to measure a local build. `usability` adds `--app-class internal`;
`--real` is only ever pointed at the 127.0.0.1 server the cell starts. Optional bounds:
`--timeout-ms` (default 200000), `--max-actions` (default 25). Cells run one at a time.

## Score a run

```bash
node scripts/accuracy-lab/score.mjs --out /tmp/accuracy-lab
node scripts/accuracy-lab/score.mjs --results scripts/accuracy-lab/fixtures/baseline-results.jsonl --json
```

It prints, and with `--json` emits, per variant x strategy `TP/FP/TN/FN/inconclusive`, per-strategy
precision/recall/specificity over conclusive cells, cross-strategy agreement per variant/job
(majority verdict), and actions/duration mean + min-max per variant x strategy.

### Verdict rules

* **inconclusive** — `missionOutcome` is `null` or `"inconclusive"`, *except* a usability
  `failureKind` of `job-incomplete`, which **is** a reported problem. Inconclusive cells are
  excluded from every rate.
* **reported problem** — `missionOutcome === "defects-found"`, or a usability
  `failureKind === "job-incomplete"`, or any non-empty `findings`, or any non-empty `fingerprints`.
* A conclusive cell is **TP/FP/TN/FN** by comparing "reported problem" with
  `variants.<variant>.<strategy>.defectExpected`. **precision** = TP/(TP+FP),
  **recall** = TP/(TP+FN), **specificity** = TN/(TN+FP).
* **majority verdict** per variant/job/strategy is the majority "reported problem" over that
  strategy's conclusive cells (`null` on a tie or when all are inconclusive); the two strategies
  **agree** when both majorities are non-null and equal.

## 2026-10-23 baseline

Baseline run in `scripts/accuracy-lab/fixtures/baseline-results.jsonl` (42 cells, R=3), scored
against the corrected ground truth:

| strategy | TP | FP | TN | FN | inconclusive | precision | recall | specificity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| goal | 8 | 4 | 5 | 0 | 4 | **0.667** (8/12) | **1.000** | 0.556 |
| usability | 5 | 2 | 8 | 0 | 6 | 0.714 (5/7) | 1.000 | 0.800 |

Known false positives at baseline: `clean` reports a defect in one goal replicate, and `j3-effort`
is reported as a defect in all three goal replicates (an excess-effort job is not a functional
defect). Both are measurable by the lab and tracked here rather than hidden.
