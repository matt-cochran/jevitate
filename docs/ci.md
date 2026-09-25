# CI gate, reports and baselines

`jevitate check` for CI, plus the consolidated defect report and baseline diff.

## CI mode: `jevitate check`

`jevitate check --suite <file.json>` runs a suite of promoted Journeys, invariant files, goals and
missions against one or more targets, one after another, within a total budget. It then decides
pass or fail:

- **Hard failures fail the gate:** a Journey assertion fails, an invariant is violated, a goal
  success check fails, a `verify-fix` replay still reproduces (or is intermittent), or a
  hard-signal defect or hang is found.
- **Advisory findings never fail the gate** (UX findings, 4xx-correlated console errors, Jev
  flags), unless the suite sets `"gateAdvisory": true`.
- **Fail closed:** an item that crashed, was inconclusive or was refused is an error, never a
  pass. So is going over the budget. An item is skipped once the budget is spent, and the skipped
  item counts as an error.
- `--baseline <run|tag|last>`: only findings **not** in the baseline gate. That includes a new
  finding that is flaky. Findings already in the baseline are listed but do not gate.
- `--changed-routes '/settings/**,/cart/*'`: only Journeys and goals that touch those routes run.
  A Journey's routes are its Recording's pages, or the `routes` you give it. A goal's routes are
  its start URL's path, or its `routes`. Missions, invariant sweeps and verify-fix always run.
- `--target-build <id>` stamps your build/commit on every result, next to `engine`.

Exit codes: `0` pass · `1` at least one gating finding · `2` no gating finding, but an item errored,
the budget was exceeded, or the suite was refused. Outputs go under `--out` (default
`jevitate-check/`):

| File | What |
| --- | --- |
| `results/` | every run's persisted result (what `report`, `diff` and `baseline tag` read) |
| `junit.xml` | one `<testsuite>` per target, one `<testcase>` per item (`--junit` to move it) |
| `jevitate.sarif` | SARIF 2.1.0, one result per finding, keyed by its finding key (`--sarif`) |
| `check.json` | the JSON envelope, also a run reference for `diff`/`baseline tag` (`--json-out`) |
| `report.md` | the consolidated defect list, with the baseline diff |

The suite schema (validated in full before any browser opens; an unknown field is refused, and
relative paths resolve against the suite file):

```json
{
  "version": 1,
  "name": "shop-ci",
  "budget": { "maxActions": 400, "maxMinutes": 20, "maxUsd": 2 },
  "ai": "real",
  "gateAdvisory": false,
  "targets": [
    {
      "name": "shop",
      "url": "https://staging.shop.example/",
      "allow": ["https://staging.shop.example"],
      "storageState": "auth.json",
      "viewport": "1280x800",
      "invariants": ["invariants/credits.json"],
      "journeysDir": "journeys",
      "journeys": ["login", { "id": "checkout", "params": { "sku": "A1" }, "routes": ["/cart/**"] }],
      "goals": [
        { "name": "export", "goal": "export the report as CSV", "success": ["requestMade:GET /api/export"], "routes": ["/reports/**"], "maxActions": 40 }
      ],
      "missions": [
        { "strategy": "adversarial", "url": "https://staging.shop.example/settings", "maxActions": 60 },
        { "strategy": "feature", "feature": "import", "routes": ["/imports/**"] },
        { "strategy": "coverage", "routes": ["/**"] },
        { "strategy": "exploratory", "device": "iPhone 13" },
        { "strategy": "usability", "goal": "invite a teammate", "appClass": "admin" }
      ],
      "verifyFix": [{ "result": "baseline/adversarial-2026-09-20T10-00-00-000Z.result.json", "fingerprint": "3fa2c1d09b7e4a55" }]
    }
  ]
}
```

- `budget`: the total over every item. `maxActions` counts executed browser actions, and each item
  is capped at what is left. `maxMinutes` is wall-clock time. `maxUsd` is the full model spend:
  Jev judgments plus generation (`usage.totalUsd`, see
  [usage accounting](./operations.md#usage-accounting)). If any call cannot be priced
  (`usage.priced` is `partial` or `none`), the spend cannot be measured, so the check fails.
  Fake gateways cost nothing. The check result's `usage` sums every item that ran, and the human
  summary prints it on a `COST` line.
- `ai`: the gateway for goals and model-driven missions (`coverage`, `exploratory`, `adversarial`,
  `usability`).
  `--real` or `--fake-ai` override it. If a suite needs a model and none is selected, it is refused
  before anything runs. Journeys, `feature` missions and verify-fix are model-free.
- `storageState`, `secretFields`, `fixtures`: the target's auth and known state. Journeys run from
  the storage state (as `journey run --storage-state`) and with the fixtures; goals get the
  `secretFields` (env-sourced `--secret-field` specs, resolved before anything runs) and the
  fixtures, and usability missions get the secret fields. Without `fixtures`, the target's entry
  in `~/.jevitate/targets.json` applies.
- `viewport` (`"375x812"`) or `device` (a Playwright device name, e.g. `"iPhone 13"`): set on a
  target, it is the default for every item; set on a Journey (object form), goal or mission, it
  overrides that default for the item. An unknown device, or both on one entry, is refused before
  anything runs.
- `journeys`: promoted Journeys only. Each one must run on an origin in the target's allowlist.
  Journeys follow the site policy for their origin ([site policies](./journeys.md#site-policies)).
- `invariants`: checked around every action of every goal and mission of the target. A target that
  has invariants but no goals and no missions gets a model-free invariant sweep: the feature
  frontier from `url`.
- `verifyFix`: replays a finding from an earlier result. `still-reproduces` and `intermittent` fail.

A GitHub Actions example:

```yaml
name: jevitate
on: [pull_request]
permissions: { contents: read, security-events: write, checks: write }
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm i -g @jevitate/cli && npx playwright install --with-deps chromium
      - name: Changed routes
        id: routes
        run: echo "globs=$(git diff --name-only origin/${{ github.base_ref }}... | ./scripts/routes-for-files.sh)" >> "$GITHUB_OUTPUT"
      - name: jevitate check
        env:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
          TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}
        run: >
          jevitate check --suite ci/jevitate-suite.json --real
          --target-build ${{ github.sha }}
          --baseline ci/baseline-check.json
          ${{ steps.routes.outputs.globs && format('--changed-routes {0}', steps.routes.outputs.globs) || '' }}
      - if: always()
        uses: github/codeql-action/upload-sarif@v3
        with: { sarif_file: jevitate-check/jevitate.sarif, category: jevitate }
      - if: always()
        uses: mikepenz/action-junit-report@v4
        with: { report_paths: jevitate-check/junit.xml }
      - if: always()
        uses: actions/upload-artifact@v4
        with: { name: jevitate-check, path: jevitate-check/ }
```

`scripts/routes-for-files.sh` is your own mapping from changed files to route globs (a comma
list); leave `--changed-routes` off to run everything. `--baseline` takes a committed `check.json`
from a main-branch run, a `jevitate baseline tag` name, or `last`. With `last`, `--baseline-dir`
points at a restored results cache.

## Consolidated defect report and baseline diff

Each run writes its own result: goal, coverage/exploratory, adversarial, feature, usability,
verify-fix and invariants. `jevitate report` merges them into **one deduped defect list** per
target:

```bash
jevitate report --target https://app.example.test            # markdown
jevitate report --target shop --since 2026-09-20 --json       # the JSON envelope
jevitate report --target shop --since explore-2026-09-22T11-00-00-000Z --baseline last --out ./report
```

`--target` takes an origin (or any URL on it), a suite target name, or a registered mission
target. `--since` takes an ISO date or a run. `--dir` (repeatable) reads other results directories
(default `~/.jevitate/recordings` and `~/.jevitate/ux-reports`), including their
subdirectories. Each defect lists:

- every mode and run that observed it, with occurrence counts;
- evidence refs (step, screenshot, request, URL, transcript);
- its reproduction command, the `verify-fix` input.

Advisory findings are listed separately. The report only reads results that were already
redacted: it adds no page data and makes no model call.

**Finding identity.** Findings are matched across modes, runs and builds by a stable key. When
the finding has an engine fingerprint (a hard-signal defect, a hang, an invariant, a 4xx
advisory), the key is that fingerprint. The fingerprint already folds in the signal, the templated
route or endpoint, and the message class. Otherwise (a UX finding, a failed Journey step, a failed
goal check) the key is the signal, the templated route (`/items/42` → `/items/:id`), the control
and the request. Two findings whose fingerprint cascades overlap are merged: for example, the same
broken call surfacing as a 503 in one run and as its page error in another.

**Baselines and diffs.**

```bash
jevitate diff adversarial-2026-09-20T10-00-00-000Z adversarial-2026-09-22T10-00-00-000Z
jevitate baseline tag release-1 jevitate-check/check.json   # run ids, result files, check records or other tags
jevitate report --target shop --baseline release-1
```

Each finding is classified as one of:

- **new:** in no baseline run.
- **resolved:** in every comparable baseline run and in no current run.
- **still-present:** in every comparable run on both sides.
- **flaky:** in some but not all comparable runs of a side, or a run itself saw it come and go.
- **not-rerun:** a baseline finding that no current run could have seen. It is never reported as
  resolved without evidence.

"Comparable" runs are runs that could have observed the finding: the same mode, target and
mission settings (goal, route globs or seed route, feature, Journey, verify-fix fingerprint) as a
run that observed it, and that reached the finding's route. A goal run's silence is not evidence
that an adversarial-only defect is gone. New and resolved are decided before flaky, and resolved
needs enough comparable reruns to rule out the baseline's own hit rate. `last` means the previous run on the same
target, per mode. A tag is a snapshot stored under `~/.jevitate/baselines/<name>.json`, so it
survives pruned result files.
