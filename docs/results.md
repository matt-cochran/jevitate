# Result schema

Every explore strategy writes the same result shape, so a suite runner, a ledger or a report can
parse any run without knowing which strategy produced it.

## Where results appear

The same object appears in three places:

- as `data` in `jevitate explore --json` output, for every strategy (without `--json`, `explore`
  prints a human summary instead, never JSON: see [output](./outcomes.md#output---json-or-a-human-summary));
- as `result` in the persisted `<stem>.result.json`, next to `missionOutcome` and `exitCode`;
- in the MCP `get_mission_result` response.

The schema is exported as zod schemas and TypeScript types from `@jevitate/cli`:
`MissionResultSchema` for a result, `PersistedMissionResultSchema` for a `<stem>.result.json` file,
and `MissionResultCore` for the typed common fields. Its version is
`MISSION_RESULT_SCHEMA_VERSION`.

## Common fields (schemaVersion 1)

Every strategy (`goal`, `coverage`, `exploratory`, `adversarial`, `feature`, `usability`) sets these
fields the same way:

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | `1` | Increases whenever any field in this table changes incompatibly. |
| `strategy` | string | The strategy that produced the result. |
| `missionOutcome` | string | The verdict: always one of the canonical [mission outcomes](./outcomes.md) (`clean`, `defects-found`, `hang`, `intermittent`, `inconclusive`, `crashed`), on every strategy — a goal run included. |
| `goalOutcome` | string | Goal runs only (and on every goal run): the goal's own ending — `succeeded`, `failed`, `exhausted`, `blocked`, or a shared outcome it ended with directly (e.g. `defects-found`, `crashed`). It folds onto `missionOutcome` (`succeeded` → `clean`; `failed`/`exhausted`/`blocked` → `defects-found`; see [outcomes](./outcomes.md)). Additive in schema version 1. |
| `exitCode` | number | The process exit code for `missionOutcome`. This is the value to compare across strategies. |
| `defects` | array | Every defect the run found, whichever oracle found it: hard signals, declared invariants and `server-log` defects — and a coverage/exploratory run's frontier defects (`horizontal-overflow`, `judgment-flagged-state`), which are also listed with their repro Recording in `coverage.defects`. Each one has a `fingerprint` (16 hex characters) and a `kind`. Every strategy records an HTTP 5xx from the app's own origins as an `http-5xx` defect with the same fingerprint (endpoint pattern + status), whichever strategy found it; a 5xx from a third-party origin is not the app's defect. A defect the strategy reports without gating on it has `advisory: true`: a usability run's `server-log` or `http-5xx` defect, and every `judgment-flagged-state` (Jev's opinion alone, #214). An advisory defect never sets `missionOutcome`/`exitCode`, and `check` never gates on it (unless the suite sets `gateAdvisory`). |
| `hangs` | array | Every hang finding, each with its `fingerprint` and reproduction. |
| `recordingPaths` | string[] | Every Recording the run wrote: one for goal, adversarial and usability runs, one per path for coverage and feature runs. It can be empty when a frontier run found no path. |
| `transcriptPath` | string | The run's decision transcript. |
| `resultPath` | string | The persisted `<stem>.result.json`. The stem starts with the strategy (`explore-` for goal, `coverage-`, `exploratory-`, `adversarial-`, `feature-`, `usability-`); readers find a result by its content, never by its prefix. |
| `scope` | object | Coverage, exploratory and feature runs: the route scope the run was contained to — `routeGlobs`, and `source` (`start-url` when derived from the start URL, `route` when `--route`/`--scope app` widened or set it). The human output prints it as a `SCOPE` line. |
| `target` | object | The run's scope: `seedUrl` and `allowlist`. It can also hold a storage-state path, never the file's contents. `verify-fix` uses it to replay a finding. |
| `engine` | object | The build that produced the result: `{version, commit, builtAt}`. |
| `usage` | object | Model calls, tokens and cost. The CLI always sets it; a programmatic caller that does not track usage leaves it out. |
| `failure` | object | Present when the run broke, proved nothing, or (goal) failed a check after the model's `done`. `failure.kind` says why the run ended `crashed` or `inconclusive` (e.g. `insufficient-coverage`, `vacuous-check`, `job-incomplete`, `degraded-environment`, `target-unresponsive`) or `failed` (`success-check-failed`), and `failure.message` names the cause. |
| `hostHealth` | object | The host's health over the run (#203): peak load per core, minimum free memory, peak driver event-loop lag, the slowest render, how many steps ran on a starved host. See [a starved host](./outcomes.md#a-starved-host-hosthealth-environmentdegraded). Additive: older results do not have it. |
| `environmentDegraded` | array | Hangs, click timeouts and no-progress stops met while the host was starved: advisory (`advisory: true`), never a defect or hang, never failing the run. |

`verify-fix`, `ledger add`, `report`, `check` and `--repeat` voting all read defects from `defects`.

## Multi-run results (`--repeat`, `--persona`)

`multi-run.result.json` (and the `--json` envelope's `data`) is an aggregate, not a mission result:
it has `kind: "multi-run"`, and `jevitate report` reads each run's own `<stem>.result.json` under it
instead. It follows the same verdict contract as a single result:

| Field | Meaning |
|---|---|
| `missionOutcome` | The canonical verdict. Each run's `missionOutcome` is voted (a goal run's own ending folds first, so `exhausted` and `blocked` runs agree on `defects-found`). With personas it is the shared outcome when they agree, else the most severe persona's. `inconclusive` while runs are pending or after a kill. |
| `goalOutcome` | `--goal` multi-runs only: the goal ending the runs agreed on, else the canonical outcome. |
| `exitCode` | The exit code of `missionOutcome` (130/143 for a killed multi-run). |
| `engine` | The build that produced the aggregate. |
| `outcome` | The runs' own agreed ending (a goal's `succeeded`, …), or `"mixed"` when personas disagree. Not the portable verdict. |

Each `cells[]` entry (one per persona) and each of its `runs[]` carries its own `missionOutcome` (and
`goalOutcome` for goal runs); a run also carries its `reason` and a find-out run its `answer`. The
persona `diff.outcomes` map holds canonical outcomes. See [multi-run](./multi-run.md).

## Strategy-specific fields

All other fields are specific to one strategy. The schema passes them through unchanged and gives
them no meaning across strategies. For example:

- goal runs have `checks`, `answer`, `runOutcome`, `stop` and `finalUrl`;
- coverage runs have `coverage`, and feature runs have their own `coverage`;
- adversarial runs have `advisories`, `scope` and `coverage`;
- usability runs have `report`, `reportPath` and `screenshots`.

`outcome` is one of these fields. For a goal run it is the goal outcome (the same as `goalOutcome`), and for a frontier run it
is the stop reason. It is not the portable verdict: use `missionOutcome` or `exitCode` for that.

## Deprecated aliases (0.2.0 only)

These fields are still written in 0.2.0 and will be removed in the next minor release:

| Deprecated | Use instead |
|---|---|
| `serverLogDefects` | the entries in `defects` with `kind: "server-log"` |
| `recordingPath` (goal, adversarial, usability) | `recordingPaths[0]` |
| `usage.usd` | `usage.totalUsd` |
| `usage.jevPriceSource` | `usage.priceSource` (also covers generation calls, not just Jev's) |

Before this schema, a goal, coverage, adversarial, feature or usability run listed its `server-log`
defects only in `serverLogDefects`. Readers that only looked at `defects` missed them.
`serverLogDefects` (like the `server-log` entries it duplicates in `defects`) is present on EVERY
strategy's result, but only when that run actually checked server logs (`--log-source`/`logSource`)
AND found a matching defect — it is absent, not "missing", on a run with no log source configured or
no match. A result with neither is not evidence that a strategy stopped writing it.
