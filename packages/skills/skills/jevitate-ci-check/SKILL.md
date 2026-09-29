---
name: jevitate-ci-check
description: Set up and read jevitate's CI regression gate. `jevitate check --suite <file>` runs promoted Journeys, invariants, goals, missions and verify-fix re-checks within a budget, writes JUnit + SARIF + JSON, and its exit code decides pass/fail. Also covers `--baseline`/`--changed-routes`, `jevitate report` (deduped defect list), `jevitate diff`, and `baseline tag`. Use when adding jevitate to CI, reading a failed check, or comparing runs.
---

`jevitate check` is the gate. It runs a suite one item after another within a total budget and
decides pass or fail from independent code signals. Advisory findings (UX, model flags) never fail
it unless the suite sets `"gateAdvisory": true`.

## Write the suite

A JSON file. It's validated in full before any browser opens, and unknown fields are refused.
Relative paths resolve against the suite file.

```json
{
  "version": 1,
  "name": "app-ci",
  "budget": { "maxActions": 400, "maxMinutes": 20, "maxUsd": 2 },
  "ai": "real",
  "targets": [{
    "name": "app",
    "url": "http://localhost:3000/",
    "allow": ["http://localhost:3000"],
    "journeys": ["login", { "id": "checkout", "env": "local", "params": { "sku": "A1" } }],
    "goals": [{ "name": "export", "goal": "export the report as CSV", "success": ["requestMade:GET /api/export"] }],
    "missions": [{ "strategy": "adversarial", "url": "http://localhost:3000/settings", "maxActions": 60 }],
    "invariants": ["invariants/saved-means-stored.json"],
    "verifyFix": [{ "result": "baseline/adversarial-2026-09-20T10-00-00-000Z.result.json", "fingerprint": "3fa2c1d09b7e4a55" }]
  }]
}
```

- `journeys` must be promoted, and their origin must be on the target's allowlist. Journeys,
  `feature` missions and `verifyFix` are model-free. Goals and `coverage`/`exploratory`/
  `adversarial`/`usability` missions need `"ai": "real"` (or `--real`) and keys.
- `"ai": "fake"` (`--fake-ai`) is a pipeline smoke. It never gates a goal on the fake judge's
  verdict (such an item is an error, exit 2), but hard signals still gate.
- `storageState` holds live cookies. Keep it outside the repo (under `~/.jevitate/`, or generate
  it at CI runtime). Never commit one.
- Lint invariant files in an earlier, browser-free step:
  `jevitate invariants validate invariants/*.json --url <target url>`.

## Run it

- `jevitate check --suite jevitate-suite.json [--out jevitate-check] [--target-build $GIT_SHA] --json`
  (MCP `run_check`). Outputs go under `--out`: `junit.xml`, `jevitate.sarif` (SARIF 2.1.0, one
  result per finding), `check.json`, `report.md` and `results/`. Publish the JUnit to the CI test
  view and upload the SARIF to code scanning.
- `--changed-routes '/settings/**'` runs only the Journeys and goals that touch those routes.
  Missions, invariant sweeps and verify-fix always run. Derive the routes from the diff (see
  `jevitate-mission-scope`).
- `--baseline <run|tag|last>` gates only findings not in the baseline. Findings already known are
  listed but don't gate. Tag a known-good run with `jevitate baseline tag <name> <runs...>`.

## Exit codes: gate on 1, and treat 2 and 64 as broken

`0` pass · `1` at least one gating finding (a Journey assertion, an invariant, a goal check, a
verify-fix that still reproduces or is intermittent, a hard-signal defect or hang) · `2` no
gating finding, but an item errored, was inconclusive, or the budget ran out · `64` the suite,
targets file or AI setup was refused, so nothing ran. Exit 2 or 64 is never "green". Report it as
a broken check, with the item and reason from `check.json`.

## Read and compare results

- `jevitate report [--target <origin|name>] [--since <run|date>] [--baseline <run|tag|last>] --json`
  gives one deduped defect list across modes and runs (MCP `get_report`).
- `jevitate diff <runA> <runB> --json` classifies findings as new / resolved / still-present /
  flaky / not-rerun (runA is the baseline; MCP `diff_runs`).
- For a failing finding, hand its fingerprint to `jevitate-verify-fix` to reproduce it, attach
  evidence, or turn it into a committed regression.

## What you must never do

- Never loosen a suite (drop an item, raise a budget, add a baseline, set `gateAdvisory: false`)
  just to make CI pass, unless the human asks for that change.
- Never report exit 2 as a pass or a flake to ignore.
