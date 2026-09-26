# Result schema

Every explore strategy writes the same result shape, so a suite runner, a ledger or a report can
parse any run without knowing which strategy produced it.

## Where results appear

The same object appears in three places:

- as `data` in `jevitate explore --json` output, or the whole output without `--json`;
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
| `missionOutcome` | string | The verdict. It is one of the [mission outcomes](./outcomes.md), except that a goal run keeps its own `succeeded`, `exhausted` and `blocked`. |
| `exitCode` | number | The process exit code for `missionOutcome`. This is the value to compare across strategies. |
| `defects` | array | Every defect the run found, whichever oracle found it: hard signals, declared invariants and `server-log` defects. Each one has a `fingerprint` (16 hex characters) and a `kind`. A defect the strategy reports without gating on it (a usability run's `server-log` defect) has `advisory: true`. |
| `hangs` | array | Every hang finding, each with its `fingerprint` and reproduction. |
| `recordingPaths` | string[] | Every Recording the run wrote: one for goal, adversarial and usability runs, one per path for coverage and feature runs. It can be empty when a frontier run found no path. |
| `transcriptPath` | string | The run's decision transcript. |
| `resultPath` | string | The persisted `<stem>.result.json`. |
| `target` | object | The run's scope: `seedUrl` and `allowlist`. It can also hold a storage-state path, never the file's contents. `verify-fix` uses it to replay a finding. |
| `engine` | object | The build that produced the result: `{version, commit, builtAt}`. |
| `usage` | object | Model calls, tokens and cost. The CLI always sets it; a programmatic caller that does not track usage leaves it out. |
| `failure` | object | Present only when the run broke. It says why the run ended `crashed` or `inconclusive`. |

`verify-fix`, `ledger add`, `report`, `check` and `--repeat` voting all read defects from `defects`.

## Strategy-specific fields

All other fields are specific to one strategy. The schema passes them through unchanged and gives
them no meaning across strategies. For example:

- goal runs have `checks`, `answer`, `runOutcome`, `stop` and `finalUrl`;
- coverage runs have `coverage`, and feature runs have their own `coverage`;
- adversarial runs have `advisories`, `scope` and `coverage`;
- usability runs have `report`, `reportPath` and `screenshots`.

`outcome` is one of these fields. For a goal run it is the goal outcome, and for a frontier run it
is the stop reason. It is not the portable verdict: use `missionOutcome` or `exitCode` for that.

## Deprecated aliases (0.2.0 only)

These fields are still written in 0.2.0 and will be removed in the next minor release:

| Deprecated | Use instead |
|---|---|
| `serverLogDefects` | the entries in `defects` with `kind: "server-log"` |
| `recordingPath` (goal, adversarial, usability) | `recordingPaths[0]` |

Before this schema, a coverage, adversarial, feature or usability run listed its `server-log`
defects only in `serverLogDefects`. Readers that only looked at `defects` missed them.
