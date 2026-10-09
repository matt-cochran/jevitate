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
| `goalOutcome` | string | Goal runs only (and on every goal run): the goal's own ending — `succeeded`, `failed`, `exhausted`, `blocked`, or a shared outcome it ended with directly (e.g. `crashed`, `hang`). Since 0.8.0 (#423) a defect never replaces it: `missionOutcome` is derived from `goalOutcome` and `defectOutcome` by one table (a `succeeded` goal with defects is `defects-found`; see [outcomes](./outcomes.md#goal-outcome--defect-outcome-423)). Additive in schema version 1. |
| `goalReason` | string | #423, goal runs whose `goalOutcome` is not `succeeded`: why — `success-check-failed`, `not-found`, `ungrounded`, `blocked-by-policy`, `gave-up`, `no-progress`, `budget`, `hang`, `vacuous-check`, `broken-run` or `defects`. Additive. |
| `exitCode` | number | The process exit code for `missionOutcome`. This is the value to compare across strategies. |
| `defects` | array | Every defect the run found, whichever oracle found it: hard signals, declared invariants and `server-log` defects — and a coverage/exploratory run's frontier defects (`horizontal-overflow`, `vertical-clipping`, `judgment-flagged-state`), which are also listed with their repro Recording in `coverage.defects`. Each one has a `fingerprint` (16 hex characters) and a `kind`. Every strategy records an HTTP 5xx from the app's own origins as an `http-5xx` defect with the same fingerprint (endpoint pattern + status), whichever strategy found it; a 5xx from a third-party origin is not the app's defect. A defect the strategy reports without gating on it has `advisory: true`: a usability run's `server-log` or `http-5xx` defect, and every `judgment-flagged-state` (Jev's opinion alone, #214). An advisory defect never sets `missionOutcome`/`exitCode`, and `check` never gates on it (unless the suite sets `gateAdvisory`). |
| `defects[]` (`server-log`) | object | #421: a backend log defect also carries `level`, `source` (the `--log-source` spec), `message` (redacted), `firstSeenStep` and `count` (= `occurrences`); see [backend logs](./backend-logs.md). |
| `defectOutcome` | object | #421/#423: `{status, byKind, advisoryByKind?}` — `status` is `defects` when the run recorded at least one gating (non-advisory) defect, else `none`; `byKind` counts those defects per `kind` (`{"server-log": 2, "http-5xx": 1}`), `advisoryByKind` the advisory ones (omitted when there are none). Hangs are not counted here. Orthogonal to `goalOutcome`: see [outcomes](./outcomes.md). Additive: results written before 0.8.0 do not have it. |
| `hangs` | array | Every hang finding, each with its `fingerprint` and reproduction. |
| `recordingPaths` | string[] | Every Recording the run wrote: one for goal, adversarial and usability runs, one per path for coverage and feature runs. It can be empty when a frontier run found no path. |
| `transcriptPath` | string | The run's decision transcript. |
| `resultPath` | string | The persisted `<stem>.result.json`. The stem starts with the strategy (`explore-` for goal, `coverage-`, `exploratory-`, `adversarial-`, `feature-`, `usability-`); readers find a result by its content, never by its prefix. |
| `sessionLost` | object | Goal runs with `--storage-state`, only when it happened: `{reason}` — the session was not honoured (the first page was a sign-in page: a login-like URL or a password field), so the run did not start signed in as that session. A warning, printed as a `WARNING` line; it does not change the outcome. |
| `scope` | object | Coverage, exploratory and feature runs: the route scope the run was contained to — `routeGlobs`, and `source` (`start-url` when derived from the start URL, `route` when `--route`/`--scope app` widened or set it). The human output prints it as a `SCOPE` line. |
| `target` | object | The run's scope: `seedUrl` and `allowlist`. It can also hold a storage-state path, never the file's contents. `verify-fix` uses it to replay a finding. #426 adds structured fields: `startUrl` (where the run started), `strategy`, and `persona` (the persona name, for a `--persona` multi-run or a [sweep](./sweeps.md) target). Additive. |
| `tags` | object | #426: the run's `--tag key=value` metadata (`{"feature": "checkout"}`), present only when the run was tagged. See [run tags](#run-tags). Additive. |
| `engine` | object | The build that produced the result: `{version, commit, builtAt}`. |
| `usage` | object | Model calls, tokens and cost. The CLI always sets it; a programmatic caller that does not track usage leaves it out. |
| `failure` | object | Present when the run broke, proved nothing, or (goal) failed a check after the model's `done`. `failure.kind` says why the run ended `crashed` or `inconclusive` (e.g. `insufficient-coverage`, `vacuous-check`, `job-incomplete`, `degraded-environment`, `target-unresponsive`, `auth-expired` — the session was expired before the mission started; `failure.persona` names whose, see [persona sessions](./multi-run.md#persona-sessions-jevitate-login-the-pre-flight-auth-check-and-refresh)) or `failed` (`success-check-failed`), and `failure.message` names the cause. |
| `hostHealth` | object | The host's health over the run (#203): peak load per core, minimum free memory, peak driver event-loop lag, the slowest render (the page's own time — never a reply/job wait the run chose, #368), how many steps ran on a starved host. See [a starved host](./outcomes.md#a-starved-host-hosthealth-environmentdegraded). Additive: older results do not have it. |
| `environmentDegraded` | array | Hangs, click timeouts and no-progress stops met while the host was starved (host samples showing load or memory pressure — a slow render alone never counts, #368): advisory (`advisory: true`), never a defect or hang, never failing the run. |
| `environmentFaults` | object | #422, runs with `--log-defect` only, when there were any: `{causes: [{ruleId, source, message, count}]}` — backend log lines a `.jevitate/log-classes.json` or built-in rule classed `environment` (a placeholder key, an unconfigured provider). Never defects, never failing the run. Not to be confused with `environmentDegraded` (a starved host). See [backend logs](./backend-logs.md). |
| `expectedValidation` | array | #422, when there were any: `[{ruleId, source, message, count}]` — backend log lines classed `expected-validation` (validation errors the mission's own input caused). Recorded, never failing the run. |
| `videoPaths` | string[] | `--record-video` runs only (#245): every video the run recorded. Additive. |
| `defects[].evidence` | object | `--evidence-video` runs only (#250): `videoPath` (the captioned repro clip), `screenshots` (just before, and at, the failing step), `failingStep`, `signal` (what the step is marked with), `reproduced` (whether the replay saw it fire again, when a page signal can tell), `replay`, and `skipped` / `captureSkips` when media was refused (e.g. the secret mask could not be proven). Additive. |
| `screenshotPaths`, `screenshotIndex`, `screenshotsSkipped` | string[], string, array | `--screenshots` runs only (#251): the masked images, the `index.md` contact sheet, and `{step, reason}` for each capture refused. Additive. |

`verify-fix`, `ledger add`, `report`, `check` and `--repeat` voting all read defects from `defects`.

## Journey results (`journey-<id>-<stamp>.result.json`)

`journey run` with `--self-heal hybrid|full`, and `check`, persist `{missionOutcome, exitCode, result}`
for a Journey run (a plain fail-closed `journey run` prints its result and writes no file). The
`result` has:

| Field | Meaning |
|---|---|
| `mode` | `"journey"` |
| `journeyId`, `startedAt`, `target` | which Journey, when, on what origin |
| `outcome` | `ok`, `healed-pending-review`, `heal-exhausted` or `quarantined` (see [journey run outcomes](./outcomes.md#journey-run-outcomes-453)) |
| `reason`, `at`, `url` | why and at which step (0-based) a failed run stopped |
| `heal` | when a self-heal ran: `mode`, `verdict`, `changeScope` (range, SHAs, counts; never raw hunks), `budget` (limits, used, `exhaustedBy`) and `attempts` |
| `heal.attempts[]` | `n`, `stepIndex`, `source`, `hypothesis`, `evidence` (kind, before/after, file:line), `candidate` (values hidden), `observation` (a masked screenshot under `journey-<id>-<stamp>.heal/`), `result`, `rejection {code, detail}`, `usage` |
| `proposal` | `{id, path, steps, reviewCommand, acceptCommand}` of the revision a `healed-pending-review` run wrote |

Every string is redacted of the run's secret params. `jevitate report` turns `heal-exhausted` and
unexplained breaks into defects (with the attempt table) and a pending proposal into a
`journey-heal-pending` finding that is not counted as a defect.

## Run tags

Every command that produces a run result takes `--tag key=value` (repeatable): `explore`,
`journey run`, `check`, `load run`, `verify-fix`, `regression run`, `demo`, `mission run`,
`source run`, `campaign run` and `sweep` (which adds `target=<id>` to every run). MCP run tools take the same thing as a `tags` object.
A tag says which feature, journey or release a run exercised, so a release dashboard or a coverage
tracker can attribute the run without guessing from its output path or its final URL (a run that
ends on a login page still says what it tested).

```bash
jevitate explore --url https://app.example.test/checkout --strategy adversarial \
  --tag feature=checkout --tag release=0.8.0
jevitate report --tag feature=checkout --tag release=0.8.0   # only runs carrying BOTH tags
jevitate diff before after --tag feature=checkout            # both sides narrowed to the tag
```

- A key is 1-64 of `[A-Za-z0-9_.-]`; a value is 1-256 characters with no control characters; a
  key given twice, a malformed tag, or more than 32 tags is refused (`E_TAG_ARGS`, exit 64) before
  anything runs.
- Tags are stored in `result.tags` (the persisted `<stem>.result.json` and the `--json` envelope's
  `data`), in a multi-run's per-run `run.envelope.json`, and on the run's line in the run index
  (`~/.jevitate/run-index.jsonl`: `{project, path, tags}`).
- `jevitate report --tag` and `jevitate diff --tag` filter with AND semantics: a run must carry
  every given tag with exactly that value. A tag no run carries is refused (exit 64), never an
  empty report.
- **Tags are plain metadata and are never redacted.** Never put a secret in a tag: no password,
  token, session id or API key, and no value read from a credential variable. jevitate does not
  inspect tag values for secrets; it stores exactly what it is given.

## Multi-run results (`--repeat`, `--persona`)

`multi-run.result.json` (and the `--json` envelope's `data`) is an aggregate, not a mission result:
it has `kind: "multi-run"`, and `jevitate report` reads each run's own `<stem>.result.json` under it
instead. It follows the same verdict contract as a single result:

| Field | Meaning |
|---|---|
| `missionOutcome` | The canonical verdict. Each run's `missionOutcome` is voted (a goal run's own ending folds first, so `exhausted` and `blocked` runs agree on `defects-found`). With personas it is the shared outcome when they agree, else the most severe persona's. `inconclusive` while runs are pending or after a kill. |
| `goalOutcome` | `--goal` multi-runs only: the goal ending the runs agreed on, else the canonical outcome. |
| `exitCode` | The exit code of `missionOutcome` (129/130/143 for a killed multi-run). |
| `engine` | The build that produced the aggregate. |
| `outcome` | The runs' own agreed ending (a goal's `succeeded`, …), or `"mixed"` when personas disagree. Not the portable verdict. |

Each `cells[]` entry (one per persona) and each of its `runs[]` carries its own `missionOutcome` (and
`goalOutcome` for goal runs); a run also carries its `reason` and a find-out run its `answer`. The
persona `diff.outcomes` map holds canonical outcomes. See [multi-run](./multi-run.md).

## Strategy-specific fields

All other fields are specific to one strategy. The schema passes them through unchanged and gives
them no meaning across strategies. For example:

- goal runs have `checks`, `answer`, `runOutcome`, `stop`, `finalUrl` and `depth` (#424: distinct states and pages, actions, decisions, forms submitted, and the minimum effort with `met`); a find-out that ended without a grounded answer also has `partialReport` (per page: its own grounded text, controls, and what was tried; see [find-out goals](./success-checks.md#open-ended-find-outs-minimum-effort-depth-and-partial-reports));
- coverage runs have `coverage`, and feature runs have their own `coverage`;
- adversarial runs have `advisories`, `scope` and `coverage` (an advisory is a console error
  correlated with a 4xx (`status`), or one raised inside a third-party iframe (`thirdPartyFrame`,
  the frame's origin; `frameUrl`): reported, never a defect);
- usability runs have `report`, `reportPath` and `screenshots`. Since 0.3.0 the report also
  carries the claim ledger (`report.claims`), and each finding carries its verified claim
  (`claim`), its two-question grade (`grade`) and, on a live run, a cropped screenshot with the
  cited control boxed (`screenshot`, under `usability-<stamp>.findings/`). See
  [UX findings](./ux-findings.md).

`outcome` is one of these fields. For a goal run it is the goal outcome (the same as `goalOutcome`), and for a frontier run it
is the stop reason. It is not the portable verdict: use `missionOutcome` or `exitCode` for that.

## Removed aliases (0.3.0)

0.2.0 deprecated these fields; 0.3.0 no longer writes them. `schemaVersion` stays `1`: this is the
removal announced in 0.2.0, not a new schema. A 0.2.0 result that still carries them still
validates, and `report`, `ledger` and `verify-fix` still read them from older result files (a
0.2.0 `usage.usd` is read as `totalUsd`, a `serverLogDefects` entry as a defect, a `recordingPath` as
the Recording).

| Removed | Read instead |
|---|---|
| `serverLogDefects` | the entries in `defects` with `kind: "server-log"` |
| `recordingPath` (goal, adversarial, usability) | `recordingPaths[0]` |
| `usage.usd` | `usage.totalUsd` |
| `usage.jevPriceSource` | `usage.priceSource` (also covers generation calls, not just Jev's) |

Before #195, a goal, coverage, adversarial, feature or usability run listed its `server-log`
defects only in `serverLogDefects`. Since 0.2.0 every one is in `defects` (with `kind:
"server-log"`) on every strategy, present only when that run checked server logs
(`--log-source`/`logSource`) and found a matching defect.
