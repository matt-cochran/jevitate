# Sweeps: many targets in one run

A release check usually means dozens of missions: one per feature or route, often once per
persona. `jevitate sweep` runs them from one targets file, with bounded concurrency, resumes after
an interruption, and writes one aggregated `sweep.result.json`. Without it you would write a shell
loop that throttles runs, keeps per-target output dirs, logs a summary, skips finished targets on
a restart and re-aggregates the results.

```bash
jevitate sweep --targets release-targets.tsv --base-url https://staging.example.test \
  --concurrency 3 --out .jevitate/sweeps/0.8.0 --tag release=0.8.0 --real

# after an interruption (or a fixed environment): finished targets are not re-run
jevitate sweep --targets release-targets.tsv --base-url https://staging.example.test \
  --concurrency 3 --out .jevitate/sweeps/0.8.0 --tag release=0.8.0 --real --resume
```

Each target runs as the same `jevitate explore` command you would type yourself: the same
validation, gateways, invariants, checks and results. Runs go through the shared browser pool and
the machine-wide browser cap (`--max-browsers`), so `--concurrency` never exceeds what the machine
admits.

## The targets file

A `.tsv` file (a header row, then one target per line) or a `.json` file. Every target has:

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | 1-64 of `[A-Za-z0-9_.-]`, starting alphanumeric, unique in the file. It names the target's directory (`<out>/<id>/`) and is the run's `target=<id>` tag. |
| `url` or `route` | one of them | An absolute `http(s)` URL, or a path starting with `/`. A route resolves against `--base-url`, else `--env <name>`'s base URL, else the file's `baseUrl` (JSON), else `JEVITATE_BASE_URL`. |
| `persona` | no | A Playwright storage state for the run (`--storage-state`): a path (the persona is named after the file: `admin.json` → `admin`), `name=<path>`, or in JSON `{"name", "storageState"}`. Relative paths resolve against the targets file. |
| `strategy` | no | `goal` (the default), `coverage`, `exploratory`, `adversarial` or `usability`. |
| `goal` | for `goal` and `usability` | The goal or job. A `goal` target may instead set the `feature` option for a feature run. |
| `tags` | no | Run tags (see [run tags](./results.md#run-tags)). JSON: an object. TSV: `key=value` entries separated by `;`. The key `target` is reserved. |
| explore options | no | JSON: an `options` object. TSV: one extra column per option. See below. |

A JSON file is an array of targets, or an object with `targets` and optional `baseUrl` and
`defaults` (a `strategy`, `goal`, `persona`, `tags` and `options` every target inherits unless it
sets its own; tags and options are merged, the target's winning):

```json
{
  "baseUrl": "https://staging.example.test",
  "defaults": {
    "strategy": "adversarial",
    "tags": { "release": "0.8.0" },
    "options": { "maxActions": 30, "deny": ["Delete account"] }
  },
  "targets": [
    { "id": "billing-admin", "route": "/billing", "persona": "sessions/admin.json", "tags": { "feature": "billing" } },
    { "id": "billing-viewer", "route": "/billing", "persona": "viewer=sessions/viewer.json", "tags": { "feature": "billing" } },
    { "id": "checkout", "route": "/checkout", "strategy": "goal", "goal": "buy the cheapest item", "options": { "success": ["urlIncludes:/order/"] } },
    { "id": "settings", "url": "https://staging.example.test/settings", "strategy": "goal", "options": { "feature": "save settings" } }
  ]
}
```

The same targets as TSV (columns are tab-separated; empty cells are unset; lines starting with
`#` are comments; a list option takes a JSON array or a single value):

```tsv
id	route	persona	strategy	goal	tags	maxActions	deny
billing-admin	/billing	sessions/admin.json	adversarial		feature=billing;release=0.8.0	30	["Delete account"]
billing-viewer	/billing	viewer=sessions/viewer.json	adversarial		feature=billing;release=0.8.0	30
checkout	/checkout		goal	buy the cheapest item	feature=checkout		
```

**Explore options a target may set.** Exactly the value-typed arguments MCP `run_exploration`
takes (by their camelCase names: `maxActions`, `maxDecisions`, `deny`, `paid`, `allowControl`,
`allowDestructive`, `allowWrites`, `feature`, `route`, `success`, `minActions`,
`minDistinctStates`, `authCheck`, `minControlCoverage`, `requireFormSubmit`, `viewport`,
`device`, …), minus the ones the sweep sets per target (and `jevProvider`: one per sweep, via
`sweep --jev-provider`). An unknown option or a wrong type is refused, and the checks `explore`
makes before a browser opens are made for every target before any run: `deny` and `allowControl`
regexes must compile (an `allowControl` pattern that matches every name is refused), `authCheck`
must be `off`, `auto`, `urlExcludes:<text>` or `selector:<css>`, and `minActions` /
`minDistinctStates` are positive integers on a `goal` target only (not a feature run). Options that name files, read logs, run commands or bind secrets are not
per-target options: give them once on the `sweep` command line (`--invariants`, `--log-source`,
`--deny`, `--paid`, `--allow-control`, `--allow-destructive`, `--record-video`, `--screenshots`,
`--jev-provider`, …), which forwards them to every run, as `campaign run` does.

**Validation.** The whole file is checked before anything runs; every problem (with its line or
target) is listed in one refusal (`E_SWEEP_SPEC`, exit 64).

**Persona paths are confined.** A persona storage state must be inside the targets file's
directory, the project or `~/.jevitate/`, and never inside a repository's `.jevitate/` (sessions
never live in a repo). This is the same rule an MCP `storageState` argument follows, so a targets
file reaches no session an MCP call could not.

## Concurrency, resume and stopping early

- `--concurrency N` (1-16, default 1) runs up to N targets at once, in file order. Concurrent runs
  share the app under test: give targets that write state (a goal that creates or edits data)
  `--concurrency 1`, or point them at separate accounts.
- `--out <dir>` is the sweep directory: `<id>/` per target (its artifacts and
  `run.envelope.json`) and `sweep.result.json`, rewritten after every finished run. Default:
  `.jevitate/logs/<date>/sweep-<stamp>`.
- `--resume` (needs `--out`) skips every target whose `<id>/run.envelope.json` holds a finished
  run, reads it back into the aggregate, and runs the rest. A run that could not start (an error
  envelope) is run again.
- `--stop-on-env-failure K` stops starting runs when the first K runs of this invocation ALL
  failed for an environment or setup reason: an expired session (`auth-expired`, from the
  pre-flight auth check — see [authentication](./authentication.md)), a session that
  was not honoured, an unreachable or unresponsive target, a starved host, a configuration or
  resource-limit failure, a crash, or a run that could not start. The runs already in flight
  finish; the rest are `skipped`, the sweep is `inconclusive` (exit 2), and the message says to
  fix the environment and re-run with `--resume`.
- A killed sweep (SIGINT/SIGTERM) writes its partial `sweep.result.json` (`complete: false`,
  `interrupted`) before it exits 130/143.

## `sweep.result.json`

| Field | Meaning |
|---|---|
| `kind` | `"sweep"`. |
| `missionOutcome`, `exitCode` | The worst target outcome; `inconclusive` while incomplete or after a stop. |
| `complete`, `reason`, `aborted`, `interrupted` | Whether every target finished, and why not. |
| `summary` | Targets, `ran`, `resumed`, `errors`, `skipped`, `pending`, counts by outcome, deduped defects (advisory ones excluded) and environment failures. |
| `targets[]` | Per target: `id`, `url`, `persona`, `strategy`, `tags` (the run's: the sweep's, the target's and `target=<id>`), `status` (`ran`, `resumed`, `error`, `skipped`, `pending`), `missionOutcome`, `goalOutcome`, `exitCode`, `defectOutcome`, `depth` (distinct states, actions, forms submitted) and `safetyOverrides` (each refusal an `allowControl` exemption waived) when the run's result carries them, `failure`, `environmentFailure`, the defect count, and the run's `resultPath` and `envelopePath`. |
| `defects[]` | Every defect and hang, deduped by fingerprint ACROSS targets: one entry per fingerprint with its `kind`, `title` (and `level`/`source`/`message` for a `server-log` defect), `sightingCount`, the `targets` that saw it and one `sightings[]` entry per target (route, URL, count, result path). A defect seen on five pages is one finding with five sightings. It is `advisory` only when every sighting was. |
| `environment.causes[]` | Every run's `environmentDegraded` causes, grouped by rule, source and message, with their total count and the targets they hit. |
| `environment.failures[]` | Runs that failed for an environment or setup reason, grouped by kind. |

Every run's own result is a normal result (`<out>/<id>/…result.json`), so `jevitate report
--tag release=0.8.0` or `--tag target=checkout` reads the sweep's runs like any others.

## Over MCP

`run_sweep` mirrors the command (`targets`, `concurrency`, `resume`, `out`, `stopOnEnvFailure`,
`baseUrl`/`env`, `tags`, the forwarded safety and media flags including `allowControl`,
`real`/`fakeAi`/`jevProvider`). The targets and
out paths are confined like every MCP path; log sources and log triage stay operator-only. A sweep
is long-running: bound it with the targets file and `concurrency`.
