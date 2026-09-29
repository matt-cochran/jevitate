---
name: jevitate-load-test
description: Run a seeded, human-paced concurrent load test of a promoted jevitate Journey (`jevitate load run`, MCP `run_load_test`) against an origin the human explicitly authorized, optionally on a named environment (`--env`). Use when the user wants capacity, throughput or latency numbers. For a single functional run, use jevitate-run-journey.
---

You scope and run a throughput/capacity measurement, never a single functional
check (use `jevitate-run-journey` for that instead).

## Before you start — authorization is mandatory, not optional

- `jevitate load run` refuses to start with zero `--authorized-origin` values
  (`E_LOAD_RUN`, "at least one --authorized-origin is required"). This is not a
  formality — running N concurrent actors against a target the operator hasn't
  explicitly authorized for load is exactly the kind of irreversible,
  high-blast-radius action this platform's guardrails exist to prevent. Never
  add an `--authorized-origin` value the human did not explicitly state.

## Running it

- `jevitate load run <journeyId> --authorized-origin <origin> [--authorized-origin
  <origin2> ...] --param k=v --concurrency <n> --iterations <n> --seed <n>
  [--storage-state <file>] --json`.
- `<journeyId>` must be a promoted Journey id (same discovery flow as
  `jevitate-run-journey`: `jevitate journey find`/`find_capabilities` first).
- `--env <name>` / `--base-url <origin>` runs it against a named environment
  (`.jevitate/environments.json`) instead of the recorded site; the
  `--authorized-origin` must still name that origin explicitly.
- MCP: `run_load_test` takes the same arguments (`authorizedOrigin`,
  `concurrency`, `iterations`, `seed`, …).
- `--seed` makes the run reproducible — if the human wants to compare two
  configurations, keep the seed fixed and vary only `--concurrency`/
  `--iterations`.
- `--storage-state <file>` seeds EVERY pool member's session from the same
  Playwright storageState file (the same authenticated pre-step as `jevitate
  journey run` — see `jevitate-run-journey`), for load-testing a Journey that
  needs an authenticated session.

## Reading the result

- The report's metrics are always labeled `measured` or `modeled` — never
  report a `modeled` number as if it were `measured`, and if the report says a
  requested live run could not run, that is a failure to surface honestly, not
  a number to approximate around.

## What you must never do

- Never run a load test against a target without an explicit, human-stated
  `--authorized-origin`.
- Never scale `--concurrency`/`--iterations` up beyond what the human asked for
  "just to get a cleaner number" — a bigger run is a bigger real-world load on
  someone's infrastructure.
