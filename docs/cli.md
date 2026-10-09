# CLI reference

> Generated from the CLI — do not edit by hand; run `pnpm docs:cli`.

Autonomous browser testing that turns discovered bugs into deterministic regression tests

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `-V, --version` | output the version number |  |  |  |  |

## Commands

- [`ai`](#ai): check or configure the model gateway credentials jevitate's AI features need
- [`baseline`](#baseline): named baselines for `diff`, `report --baseline` and `check --baseline`
- [`campaign`](#campaign): journey-anchored test campaigns (#293): many anchored missions, one deduped report
- [`catalog`](#catalog): #433: the human-vetted catalog of personas, jobs and the Journeys linked to them
- [`check`](#check): CI regression gate: run a suite of Journeys, invariants, goals and missions within a budget; JUnit + SARIF + JSON
- [`demo`](#demo): demo one aspect of an app from a one-line request: explore → clean path → Journey → annotate → a DRAFT narrated demo; `demo approve <id>` promotes and renders the final one
- [`diff`](#diff): classify findings new / resolved / still-present / flaky / not-rerun between two runs (runA = baseline)
- [`doctor`](#doctor): resource governance on this machine (#205): host load, machine-wide browser slots, jevitate browsers and orphans left by a killed run
- [`explore`](#explore): goal-directed exploration -> a deterministic Recording (authoring/test plane)
- [`explore-author-journey`](#explore-author-journey): Jev-driving authors a promotable Journey (authoring plane); never auto-promoted
- [`inbox`](#inbox): the HITL inbox from the CLI — the same tools `jevitate mcp` serves (approve/cancel stay human-only in `jevitate ui`)
- [`init`](#init): set up jevitate: collect API keys, install skills/MCP wiring, create the repo's .jevitate/
- [`invariants`](#invariants): declared-invariant files (`explore --invariants`)
- [`job`](#job): #433: catalog jobs — job stories in .jevitate/jobs.json ("When …, I want to …, so I can ….") — review a job's sheet, approve it (bound to its content hash)
- [`journey`](#journey): manage and run promoted Journeys (regression-test replays)
- [`ledger`](#ledger): keep each finding's repro material by fingerprint, so verify-fix works long after the run's output is gone
- [`load`](#load): run a promoted Journey as a load test
- [`login`](#login): #427: sign in as a persona with credentials from environment variables and save its Playwright storage state (mode 0600) — the session `explore --storage-state/--persona` starts from. Credentials are never accepted as values, never printed or recorded
- [`logs`](#logs): run output under .jevitate/logs (dated; pruned by retention)
- [`mcp`](#mcp): start an MCP stdio server exposing only the allowlisted Jevitate tools
- [`mission`](#mission): manage exploration mission targets and drain the mission queue
- [`persona`](#persona): #433: catalog personas (.jevitate/personas.json) — review a persona's sheet, approve it (a person's sign-off, bound to its content hash)
- [`profile`](#profile): manage jevitate profiles (isolated credential/data sets)
- [`record`](#record): record a demonstrated flow into a Recording (authoring plane)
- [`recording`](#recording): inspect and edit recorded takes (promote, edit steps, diff, postdoc)
- [`regression`](#regression): capture, run and manage regression tests from discovered failures
- [`report`](#report): one deduped defect list for a target across every mode and run (markdown + JSON envelope)
- [`site`](#site): per-site policies for Journey runs: human-like pacing, throttles, run budgets and quiet hours
- [`source`](#source): manage distributed Journey sources (git-backed collections of Journeys)
- [`sweep`](#sweep): run many explore missions — one per target in a targets file (.tsv or .json: id, url|route, persona, strategy, goal, tags, explore options) — with bounded concurrency, resumable, and write ONE sweep.result.json: per-target outcomes and depth, defects deduped by fingerprint across targets, environment causes grouped. Every run is tagged target=<id> plus the sweep's and the target's tags
- [`ui`](#ui): start the local HITL approval dashboard (loopback-only HTTP server)
- [`ux`](#ux): offline UX review of a saved Recording — ranked, cited usability findings
- [`verify-fix`](#verify-fix): replay a defect's repro from a mission result (or the ledger); passes only if the defect signal is absent on every replay

## ai

```
jevitate ai [command]
```

check or configure the model gateway credentials jevitate's AI features need

### ai generate

```
jevitate ai generate [options] <task>
```

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `task` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--fake` | explicitly opt into the deterministic fake gateway (no key required) | `false` |  |  |  |
| `--input <json>` | task input as a JSON string |  |  | yes |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--real` | use the real OpenRouter adapter (requires OPENROUTER_API_KEY) | `false` |  |  |  |

### ai setup

```
jevitate ai setup [options] <feature>
```

enter (masked) and store the keys a feature needs in ~/.jevitate/credentials.json (0600); each key is verified with its provider before it is stored

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `feature` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--jev-provider <provider>` | judgment only: which Jev key to set up — typesafe (TYPESAFE_API_KEY, the default) or openrouter (OPENROUTER_API_KEY: Jev through OpenRouter) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--no-verify` | store the entered key without the live auth check (offline / CI) |  |  |  |  |
| `--replace` | prompt for a new value even when a key is already stored (rotate / replace it) |  |  |  |  |

### ai status

```
jevitate ai status [options]
```

which keys each AI feature uses, where each comes from (env or ~/.jevitate/credentials.json), and whether the provider accepts it (a live auth check; never prints a key)

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--jev-provider <provider>` | report judgment as it would run with this Jev provider: typesafe or openrouter (default: JEVITATE_JEV_PROVIDER, else the TypeSafe key when both are set) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--no-verify` | skip the live auth check (offline / CI): report presence and source only |  |  |  |  |

## baseline

```
jevitate baseline [command]
```

named baselines for `diff`, `report --baseline` and `check --baseline`

### baseline list

```
jevitate baseline list [options]
```

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--json` | emit a JSON envelope |  |  |  |  |

### baseline show

```
jevitate baseline show [options] <name>
```

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `name` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--json` | emit a JSON envelope |  |  |  |  |

### baseline tag

```
jevitate baseline tag [options] <name> <runs...>
```

snapshot runs (result files, run ids, check records or other tags) as a named baseline

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `name` |  | yes |  |  |
| `runs...` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--dir <dir>` | results dir to look run ids up in (repeatable) | `[]` |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |

## campaign

```
jevitate campaign [command]
```

journey-anchored test campaigns (#293): many anchored missions, one deduped report

### campaign run

```
jevitate campaign run [options] <spec>
```

run a campaign spec (JSON): replay each job's promoted Journey (discovery), then run its anchored missions in order — explore --from-journey <journey> --at-step <anchor> --strategy <s> — with the spec's --fixtures restore around every run, and write ONE deduped report (campaign.json + campaign.md). An invalid spec is refused with every problem listed (exit 64)

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `spec` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--allow-control <regex>` | exempt a control whose name matches from the soft 'may cost money' heuristic only (repeatable, #428) (forwarded to every mission, as explore's) | `[]` |  |  |  |
| `--allow-destructive` | let missions click session-ending, destructive and paid controls (a --deny pattern still holds) (forwarded to every mission, as explore's) |  |  |  |  |
| `--allow-log-cmd` | a --log-source cmd:<command> may run as a subprocess (forwarded to every mission, as explore's) |  |  |  |  |
| `--allow-shell-hooks` | opt in to running the spec's before/after operator hooks around every run (never model-chosen) | `false` |  |  |  |
| `--allow-writes` | let a find-out mission change the app (forwarded to every mission, as explore's) |  |  |  |  |
| `--deny <pattern>` | a control no mission may click (repeatable) (forwarded to every mission, as explore's) | `[]` |  |  |  |
| `--evidence-video` | per defect: a captioned repro clip and before/at screenshots (forwarded to every mission, as explore's) |  |  |  |  |
| `--fake-ai` | use deterministic fake gateways (pipeline smoke only) | `false` |  |  |  |
| `--hook-timeout-ms <ms>` | timeout for each of the spec's before/after hooks (default 60000; the process group is killed) |  |  |  |  |
| `--invariants <file>` | app-declared invariants JSON (repeatable) (forwarded to every mission, as explore's) | `[]` |  |  |  |
| `--jev-provider <provider>` | with --real: which key judgment (Jev) uses — typesafe (TYPESAFE_API_KEY) or openrouter (OPENROUTER_API_KEY, Jev through OpenRouter). Default: JEVITATE_JEV_PROVIDER, else the TypeSafe key when both are set |  |  |  |  |
| `--journeys-dir <path>` | journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys) |  |  |  |  |
| `--json` | emit the JSON envelope (default: a human summary) |  |  |  |  |
| `--log-correlation-header <name>` | another header carrying a correlation id (repeatable) (forwarded to every mission, as explore's) | `[]` |  |  |  |
| `--log-defect <level|/regex/>` | backend log lines matching this become a server-log defect (repeatable) (forwarded to every mission, as explore's) | `[]` |  |  |  |
| `--log-id-pattern </regex/>` | how a correlation id is written in log lines (repeatable) (forwarded to every mission, as explore's) | `[]` |  |  |  |
| `--log-ignore <regex|substring>` | known-noise backend log lines to exclude (repeatable) (forwarded to every mission, as explore's) | `[]` |  |  |  |
| `--log-quiet-ok <spec>` | compatibility only since 0.8.0 (#420): quiet sources are always healthy (repeatable) (forwarded to every mission, as explore's) | `[]` |  |  |  |
| `--log-scope <regex|substring>` | attribute only backend log lines matching this (repeatable) (forwarded to every mission, as explore's) | `[]` |  |  |  |
| `--log-source <spec>` | backend log source: file:<path> \| docker:<container> \| cmd:<command> (needs --allow-log-cmd) (repeatable) (forwarded to every mission, as explore's) | `[]` |  |  |  |
| `--log-triage` | record each mission's signal timeline and attach only the related lines to each defect (#313) (forwarded to every mission, as explore's) |  |  |  |  |
| `--out <dir>` | the campaign's directory: every mission's results, campaign.json and campaign.md (default .jevitate/logs/<date>/campaign-<stamp>) |  |  |  |  |
| `--paid <pattern>` | an app control that costs money or credits (repeatable) (forwarded to every mission, as explore's) | `[]` |  |  |  |
| `--real` | use live Jev + OpenRouter gateways for the missions (requires keys) | `false` |  |  |  |
| `--record-video [dir]` | record a video of each mission's browser context (forwarded to every mission, as explore's) |  |  |  |  |
| `--screenshots [mode|dir]` | masked screenshots + index.md: one per distinct screen (default), `steps` one per step; `screens:<dir>`/`steps:<dir>`/`<dir>` set the folder (default: next to the run's result); listed as screenshotPaths |  |  |  |  |
| `--server-log-drain-ms <ms>` | how long to keep tailing --log-source after a mission's last action (default 3000) (forwarded to every mission, as explore's) |  |  |  |  |
| `--tag <key=value>` | run metadata tag stored in the result, its envelope and the run index (repeatable; key [A-Za-z0-9_.-]; never a secret) | `[]` |  |  |  |

## catalog

```
jevitate catalog [command]
```

#433: the human-vetted catalog of personas, jobs and the Journeys linked to them

### catalog analyze

```
jevitate catalog analyze [options]
```

#435: problems BETWEEN catalog items, grouped by INCOSE GtWR set characteristic — candidate pairs (paired by code: shared persona/terms, opposing writes, same role) classified by Jev (with --real) as compatible/duplicate/overlapping/conflicting/dependent, completeness gaps, and update advice (stale approvals, Journeys whose last mutation proof fails). Read-only and advisory: it never changes the catalog and never gates

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--dir <path>` | the project data dir holding personas.json and jobs.json (default: the repo's .jevitate/); its journeys/ are the Journeys |  |  |  |  |
| `--jev-provider <provider>` | with --real: which key judgment (Jev) uses — typesafe (TYPESAFE_API_KEY) or openrouter (OPENROUTER_API_KEY, Jev through OpenRouter). Default: JEVITATE_JEV_PROVIDER, else the TypeSafe key when both are set |  |  |  |  |
| `--json` | emit a JSON envelope (the schema-checked report) |  |  |  |  |
| `--markdown` | render the report as Markdown |  |  |  |  |
| `--max-pairs <n>` | the most candidate pairs to judge (default 50); the rest are listed as overflow, never dropped |  |  |  |  |
| `--real` | #435: classify the candidate pairs with Jev (advisory; cached by content hash). Without a judgment key: the deterministic layer only |  |  |  |  |

### catalog status

```
jevitate catalog status [options]
```

the jobs × personas matrix (which have a promoted Journey), approved jobs with no promoted Journey, Journeys linked to nothing, dangling links and stale approvals

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--allow-channels <list>` | #437: with --require-approvals, the approval channels that pass (comma list of tty, non-interactive, mcp, ci; default tty) |  |  |  |  |
| `--dir <path>` | the project data dir holding personas.json and jobs.json (default: the repo's .jevitate/); its journeys/ are the Journeys |  |  |  |  |
| `--json` | emit a JSON envelope (the schema-checked report) |  |  |  |  |
| `--require-approvals` | #437: exit 1 when a promoted Journey or an approved persona/job has a missing or stale approval, or one made over a channel not allowed (--allow-channels) |  |  |  |  |

## check

```
jevitate check [options]
```

CI regression gate: run a suite of Journeys, invariants, goals and missions within a budget; JUnit + SARIF + JSON

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--allow-channels <list>` | #437: with --require-approvals, the approval channels that pass (comma list of tty, non-interactive, mcp, ci; default tty) |  |  |  |  |
| `--baseline <run|tag|last>` | only findings NOT in this baseline gate (a run, a `baseline tag`, or `last`) |  |  |  |  |
| `--baseline-dir <dir>` | results dir holding baseline runs (repeatable; default: this check's results, then ~/.jevitate) | `[]` |  |  |  |
| `--browser-arg <arg>` | extra Chromium switch (repeatable); extends the Linux defaults --no-sandbox --disable-dev-shm-usage | `[]` |  |  |  |
| `--browser-channel <name>` | Playwright browser channel to launch, e.g. chrome \| msedge |  |  |  |  |
| `--browser-executable <path>` | launch this Chromium binary instead of Playwright's pinned one |  |  |  |  |
| `--changed-routes <globs>` | only run Journeys and goals touching these route globs (comma list, repeatable), e.g. '/settings/**' | `[]` |  |  |  |
| `--extension <dir>` | load this unpacked browser extension (repeatable; a directory with manifest.json). Its chrome-extension://<id> pages are allowed and navigable, e.g. --url chrome-extension://<id>/sidepanel.html; headless uses Chromium's new headless | `[]` |  |  |  |
| `--fake-ai` | use deterministic fake gateways (pipeline smoke only) | `false` |  |  |  |
| `--ignore-host-load` | start even when the host is starved (load >= 4/core or < 512 MiB free) instead of refusing with E_HOST_STARVED; the run is throttled and its result records it |  |  |  |  |
| `--jev-provider <provider>` | with --real: which key judgment (Jev) uses — typesafe (TYPESAFE_API_KEY) or openrouter (OPENROUTER_API_KEY, Jev through OpenRouter). Default: JEVITATE_JEV_PROVIDER, else the TypeSafe key when both are set |  |  |  |  |
| `--json` | emit the JSON envelope (default: a one-line summary per item, then the envelope path) |  |  |  |  |
| `--json-out <path>` | JSON envelope path (default <out>/check.json) |  |  |  |  |
| `--junit <path>` | JUnit XML path (default <out>/junit.xml) |  |  |  |  |
| `--max-browser-memory <MiB>` | memory ceiling of this run's browsers (browser + renderers); over it the run ends inconclusive with failure kind resource-limit (default: JEVITATE_MAX_BROWSER_MEMORY_MB, else 4096 or half the RAM) |  |  |  |  |
| `--max-browsers <n>` | machine-wide cap on jevitate runs with a browser open at once, shared by every jevitate on this machine (default: JEVITATE_MAX_BROWSERS, else cores/4 within 2..6; halved while the host is loaded) |  |  |  |  |
| `--out <dir>` | output dir: results/, junit.xml, jevitate.sarif, report.md, check.json | `jevitate-check` |  |  |  |
| `--real` | use live Jev + OpenRouter gateways for goals and model-driven missions (requires keys) | `false` |  |  |  |
| `--require-approvals` | #437: also fail (an `approval` finding, exit 1, in JUnit + SARIF) when a promoted Journey or an approved persona/job has a missing or stale approval, or one made over a channel not allowed |  |  |  |  |
| `--sarif <path>` | SARIF path (default <out>/jevitate.sarif) |  |  |  |  |
| `--suite <file>` | the suite JSON (targets, promoted Journeys, invariant files, goals, missions, budget) |  |  | yes |  |
| `--tag <key=value>` | run metadata tag stored in the result, its envelope and the run index (repeatable; key [A-Za-z0-9_.-]; never a secret) | `[]` |  |  |  |
| `--target-build <id>` | the target's build/commit id, stamped on every result |  |  |  |  |

## demo

```
jevitate demo [command]
```

demo one aspect of an app from a one-line request: explore → clean path → Journey → annotate → a DRAFT narrated demo; `demo approve <id>` promotes and renders the final one

### demo approve

```
jevitate demo approve [options] <id>
```

the one human approval of a DRAFT demo: shows the Journey and its annotations, renders the final demo (no DRAFT marks) on the environment it was made on, then applies the annotations and promotes the Journey; a replay that no longer works promotes nothing (exit 1)

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `id` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--accept-findings <reason>` | #433: approve although pre-approval findings need an acknowledgment, recording the reason in approval.acceptedFindings |  |  |  |  |
| `--accept-unvetted <reason>` | #433: approve although the Journey's linked job/persona is not approved, recording the reason in approval.waivers |  |  |  |  |
| `--after <cmd>` | operator shell hook run after the mission and every replay (needs --allow-shell-hooks) |  |  |  |  |
| `--allow-shell-hooks` | opt in to running --before/--after (operator commands; never model-chosen) | `false` |  |  |  |
| `--before <cmd>` | operator shell hook run before the mission and every replay (needs --allow-shell-hooks); may print {vars, secret} |  |  |  |  |
| `--browser-arg <arg>` | extra Chromium switch (repeatable); extends the Linux defaults --no-sandbox --disable-dev-shm-usage | `[]` |  |  |  |
| `--browser-channel <name>` | Playwright browser channel to launch, e.g. chrome \| msedge |  |  |  |  |
| `--browser-executable <path>` | launch this Chromium binary instead of Playwright's pinned one |  |  |  |  |
| `--device <name>` | emulate a Playwright registered device by name, e.g. --device "iPhone 13" (viewport + scale + mobile/touch + UA; mutually exclusive with --viewport) |  |  |  |  |
| `--dir <path>` | journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys) |  |  |  |  |
| `--extension <dir>` | load this unpacked browser extension (repeatable; a directory with manifest.json). Its chrome-extension://<id> pages are allowed and navigable, e.g. --url chrome-extension://<id>/sidepanel.html; headless uses Chromium's new headless | `[]` |  |  |  |
| `--fixture-identity <name=storageState>` | #243: a named identity fixture steps can authenticate as (`auth.identity`), separate from the mission's own session — e.g. mint an invite as the owner, run the mission cold (repeatable) | `[]` |  |  |  |
| `--fixtures <file>` | mission fixtures JSON {setup:[...], restore:[...]} (#140/#144): HTTP steps to an --allow origin, authenticated from --storage-state/--secret-field, run before the mission and restored after it — and around every replay. Outputs bind as ${setup.<name>} |  |  |  |  |
| `--geolocation <lat,lng>` | place the browser at this position, e.g. --geolocation 41.6376,-70.9036 (optional third value: accuracy in metres); the geolocation permission is granted to the run's allowed origins only |  |  |  |  |
| `--headed` | show the browser window (demo mode); also JEVITATE_HEADED=1. Default: headless. Needs a display |  |  |  |  |
| `--hook-timeout-ms <ms>` | timeout for each --before/--after hook (default 60000; the process group is killed) |  |  |  |  |
| `--ignore-host-load` | start even when the host is starved (load >= 4/core or < 512 MiB free) instead of refusing with E_HOST_STARVED; the run is throttled and its result records it |  |  |  |  |
| `--jev-provider <provider>` | with --real: which key judgment (Jev) uses — typesafe (TYPESAFE_API_KEY) or openrouter (OPENROUTER_API_KEY, Jev through OpenRouter). Default: JEVITATE_JEV_PROVIDER, else the TypeSafe key when both are set |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--max-browser-memory <MiB>` | memory ceiling of this run's browsers (browser + renderers); over it the run ends inconclusive with failure kind resource-limit (default: JEVITATE_MAX_BROWSER_MEMORY_MB, else 4096 or half the RAM) |  |  |  |  |
| `--max-browsers <n>` | machine-wide cap on jevitate runs with a browser open at once, shared by every jevitate on this machine (default: JEVITATE_MAX_BROWSERS, else cores/4 within 2..6; halved while the host is loaded) |  |  |  |  |
| `--non-interactive-approval <reason>` | #437: approve without a terminal confirmation (a scripted setup), recorded as channel non-interactive (ci under a CI marker) with the reason — never as a person's; check --require-approvals fails it. A coding agent never uses this |  |  |  |  |
| `--out <dir>` | write the demo (demo.webm + demo.vtt + guide.md with guide.assets/) into this folder (default: a fresh folder in the logs dir) |  |  |  |  |
| `--pace <ms>` | how long each step's caption shows before it acts (default 1500) |  |  |  |  |
| `--real` | #434/#435: ask Jev (advisory; never blocks on its own) — readiness questions and catalog pair classifications, cached by content hash. Without a judgment key the Jev layer is skipped, the deterministic layer still runs; a conflicting/duplicate pair classification at or above the documented threshold then needs --accept-findings |  |  |  |  |
| `--slow-mo <ms>` | slow every browser operation by this many ms (default 250 with --headed, else 0) |  |  |  |  |
| `--storage-state <file>` | Playwright storageState JSON to start authenticated (default: the environment's session in ~/.jevitate/targets.json); must exist |  |  |  |  |
| `--viewport <WxH>` | emulate a viewport of this size, e.g. --viewport 375x812 (mutually exclusive with --device) |  |  |  |  |

### demo create

```
jevitate demo create [options] <aspect>
```

explore a named non-production environment toward <aspect> (checked by --success), minimize the path to its essential steps (verified by replay), annotate it and render a DRAFT demo (video, .vtt, guide); nothing is promoted until `demo approve <id>` (also: jevitate demo "<aspect>")

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `aspect` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--after <cmd>` | operator shell hook run after the mission and every replay (needs --allow-shell-hooks) |  |  |  |  |
| `--allow-shell-hooks` | opt in to running --before/--after (operator commands; never model-chosen) | `false` |  |  |  |
| `--before <cmd>` | operator shell hook run before the mission and every replay (needs --allow-shell-hooks); may print {vars, secret} |  |  |  |  |
| `--browser-arg <arg>` | extra Chromium switch (repeatable); extends the Linux defaults --no-sandbox --disable-dev-shm-usage | `[]` |  |  |  |
| `--browser-channel <name>` | Playwright browser channel to launch, e.g. chrome \| msedge |  |  |  |  |
| `--browser-executable <path>` | launch this Chromium binary instead of Playwright's pinned one |  |  |  |  |
| `--device <name>` | emulate a Playwright registered device by name, e.g. --device "iPhone 13" (viewport + scale + mobile/touch + UA; mutually exclusive with --viewport) |  |  |  |  |
| `--dir <path>` | journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys) |  |  |  |  |
| `--env <name>` | the named environment to demo on (.jevitate/environments.json); required, and never one flagged production: true |  |  |  |  |
| `--extension <dir>` | load this unpacked browser extension (repeatable; a directory with manifest.json). Its chrome-extension://<id> pages are allowed and navigable, e.g. --url chrome-extension://<id>/sidepanel.html; headless uses Chromium's new headless | `[]` |  |  |  |
| `--fake-ai` | use deterministic fake gateways (pipeline smoke only) | `false` |  |  |  |
| `--fixture-identity <name=storageState>` | #243: a named identity fixture steps can authenticate as (`auth.identity`), separate from the mission's own session — e.g. mint an invite as the owner, run the mission cold (repeatable) | `[]` |  |  |  |
| `--fixtures <file>` | mission fixtures JSON {setup:[...], restore:[...]} (#140/#144): HTTP steps to an --allow origin, authenticated from --storage-state/--secret-field, run before the mission and restored after it — and around every replay. Outputs bind as ${setup.<name>} |  |  |  |  |
| `--geolocation <lat,lng>` | place the browser at this position, e.g. --geolocation 41.6376,-70.9036 (optional third value: accuracy in metres); the geolocation permission is granted to the run's allowed origins only |  |  |  |  |
| `--headed` | show the browser window (demo mode); also JEVITATE_HEADED=1. Default: headless. Needs a display |  |  |  |  |
| `--hook-timeout-ms <ms>` | timeout for each --before/--after hook (default 60000; the process group is killed) |  |  |  |  |
| `--id <id>` | the Journey id (default: demo-<aspect slug>) |  |  |  |  |
| `--ignore-host-load` | start even when the host is starved (load >= 4/core or < 512 MiB free) instead of refusing with E_HOST_STARVED; the run is throttled and its result records it |  |  |  |  |
| `--jev-provider <provider>` | with --real: which key judgment (Jev) uses — typesafe (TYPESAFE_API_KEY) or openrouter (OPENROUTER_API_KEY, Jev through OpenRouter). Default: JEVITATE_JEV_PROVIDER, else the TypeSafe key when both are set |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--max-actions <n>` | hard cap on explored actions |  |  |  |  |
| `--max-browser-memory <MiB>` | memory ceiling of this run's browsers (browser + renderers); over it the run ends inconclusive with failure kind resource-limit (default: JEVITATE_MAX_BROWSER_MEMORY_MB, else 4096 or half the RAM) |  |  |  |  |
| `--max-browsers <n>` | machine-wide cap on jevitate runs with a browser open at once, shared by every jevitate on this machine (default: JEVITATE_MAX_BROWSERS, else cores/4 within 2..6; halved while the host is loaded) |  |  |  |  |
| `--max-decisions <n>` | hard cap on model decisions |  |  |  |  |
| `--out <dir>` | write the demo (demo.webm + demo.vtt + guide.md with guide.assets/) into this folder (default: a fresh folder in the logs dir) |  |  |  |  |
| `--pace <ms>` | how long each step's caption shows before it acts (default 1500) |  |  |  |  |
| `--persona <name>` | the persona whose session (~/.jevitate/targets.json personas) the demo runs as |  |  |  |  |
| `--real` | use live Jev + OpenRouter gateways (requires keys) | `false` |  |  |  |
| `--slow-mo <ms>` | slow every browser operation by this many ms (default 250 with --headed, else 0) |  |  |  |  |
| `--start <path>` | the app path exploration starts from (default /) |  |  |  |  |
| `--storage-state <file>` | Playwright storageState JSON to start authenticated (default: the environment's session in ~/.jevitate/targets.json); must exist |  |  |  |  |
| `--success <spec>` | independent success check that proves the aspect was shown, e.g. textIncludes:testId=status\|Saved (required) |  |  |  |  |
| `--tag <key=value>` | run metadata tag stored in the result, its envelope and the run index (repeatable; key [A-Za-z0-9_.-]; never a secret) | `[]` |  |  |  |
| `--viewport <WxH>` | emulate a viewport of this size, e.g. --viewport 375x812 (mutually exclusive with --device) |  |  |  |  |

## diff

```
jevitate diff [options] <runA> <runB>
```

classify findings new / resolved / still-present / flaky / not-rerun between two runs (runA = baseline)

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `runA` |  | yes |  |  |
| `runB` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--dir <dir>` | results dir to look run ids up in (repeatable) | `[]` |  |  |  |
| `--json` | emit the JSON envelope instead of markdown |  |  |  |  |
| `--tag <key=value>` | compare only runs carrying this tag, on both sides (repeatable; every tag must match) | `[]` |  |  |  |

## doctor

```
jevitate doctor [options]
```

resource governance on this machine (#205): host load, machine-wide browser slots, jevitate browsers and orphans left by a killed run

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--cleanup` | close orphaned jevitate browsers (only processes jevitate launched, whose jevitate exited) and clear stale browser slots |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |

## explore

```
jevitate explore [options]
```

goal-directed exploration -> a deterministic Recording (authoring/test plane)

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--action-deltas` | opt-in (#303; every --strategy, not --feature): record what each action changed on the page — an accessibility snapshot before and after, announcements, the action's requests — redacted, with a code verdict per step (no-change \| relevant-change \| inconclusive) used by the goal loop's no-progress check and a persistence re-check after writes (goal), and as defect evidence (adversarial, coverage); adds `delta` to every transcript step (and Recording step, goal) and `actionDeltas` to the result. Costs about 50-100 ms per action on a small page, 0.3-0.5 s on a large one |  |  |  |  |
| `--actor <name=storageState>` | multi-actor mission (#147, goal only; repeatable): the FIRST actor is the primary (the only one the model drives, from its own storageState); every other actor is an observer in its OWN fresh context that only runs the --invariants' cross-actor checks (capture + probe as:/deniedAs) — never clicks or types. Replaces --storage-state | `[]` |  |  |  |
| `--after <cmd>` | operator shell hook run after the mission and every replay (needs --allow-shell-hooks) |  |  |  |  |
| `--allow <origin>` | authorized origin (repeatable); REPLACES the default allowlist when given (the URL's own origin is used only when --allow is omitted entirely) -- include the URL's own origin explicitly if you still need it | `[]` |  |  |  |
| `--allow-control <regex>` | #428: exempt a control whose accessible name matches this regex (case-sensitive; /src/i for case-insensitive) from the soft built-in 'may cost money' name heuristic only — e.g. --allow-control "^Generate Your First Key$" (repeatable). It never lifts --deny, --paid, destructive, session-end, read-only or origin rules; every use is recorded in the result's safetyOverrides | `[]` |  |  |  |
| `--allow-destructive` | let missions click session-ending, destructive and paid controls (a --deny pattern still holds). A goal run already may click one its goal asks for |  |  |  |  |
| `--allow-log-cmd` | opt-in: a --log-source cmd:<command> may run as a subprocess (operator-declared only; refused otherwise) | `false` |  |  |  |
| `--allow-secret-cmd` | opt-in: a --secret-field <descriptor>=cmd:<command> may run its command (in a shell, at type time, 60s timeout) and type its output (operator-declared only; refused otherwise) | `false` |  |  |  |
| `--allow-shell-hooks` | opt in to running --before/--after (operator commands; never model-chosen) | `false` |  |  |  |
| `--allow-vacuous-checks` | downgrade a vacuous --success check to a warning. By default a check satisfied before the run's first action — a page check that held on the seed page and never changed (an empty result container), a requestMade/responseStatus matched only by a page-load or polling request — FAILS: it cannot verify the goal |  |  |  |  |
| `--allow-write <glob>` | a write-request path a read-only find-out goal never blocks (repeatable; ** spans segments; a glob starting with https:// matches origin + path, e.g. https://abc.supabase.co/rest/v1/**), beyond the built-in auth-refresh ones (**/refresh*, **/token*, **/oauth/**, **/auth/**/refresh*). The app's background writes outside an action always pass | `[]` |  |  |  |
| `--allow-writes` | let a find-out goal (no --success check, ended by report) change the app. By default it is read-only: controls that start a write flow (checkout, upgrade, create, save, submit…) are refused and the write requests an action fires are blocked, unless the goal itself asks for a change |  |  |  |  |
| `--api-prefix <path>` | a path prefix whose requests are the app's API in the timing summary (repeatable), e.g. /api/ | `[]` |  |  |  |
| `--app-class <class>` | app class for UX calibration (required for --strategy usability), e.g. consumer\|admin\|internal |  |  |  |  |
| `--at-step <n|name|all|anchors>` | with --from-journey: the step to branch off — a 1-based top-level step number or an anchor name (`jevitate journey anchors <id>`); `all` sweeps every step and `anchors` every anchor: each a fresh session (restored by --fixtures), --max-actions/--max-decisions split evenly per stop, one deduped report |  |  |  |  |
| `--auth-check <mode>` | #427 pre-flight auth check before a run that starts from a session (--storage-state, --persona/--personas, --actor's primary): load the session, open --url and end the run fast (inconclusive, failure.kind auth-expired, exit 2) when it lands on a sign-in page — the login page is never explored. auto (default): a login-like URL (/login, /signin, /sign-in, /auth, …) or a visible password field, unless --url is itself such a route; urlExcludes:<text>: expired when the landed URL includes <text>; selector:<css>: alive only when this signed-in marker is visible; off. A persona with login parameters (a personas file entry's `login`, or .jevitate/personas.json) is signed in again once instead |  |  |  |  |
| `--base-url <origin>` | run against this origin (an ad-hoc environment; with --env, replaces its baseUrl) |  |  |  |  |
| `--before <cmd>` | operator shell hook run before the mission and every replay (needs --allow-shell-hooks); may print {vars, secret} |  |  |  |  |
| `--browser-arg <arg>` | extra Chromium switch (repeatable); extends the Linux defaults --no-sandbox --disable-dev-shm-usage | `[]` |  |  |  |
| `--browser-channel <name>` | Playwright browser channel to launch, e.g. chrome \| msedge |  |  |  |  |
| `--browser-executable <path>` | launch this Chromium binary instead of Playwright's pinned one |  |  |  |  |
| `--check-overflow` | check the horizontal-overflow (#149) and vertical-clipping (#302: text cut off by a fixed-height box or above the page top) hard signals even at a desktop (>=1024px) viewport — --strategy coverage/exploratory (a defect), adversarial (a defect) or usability (a signal finding). On by default whenever --viewport/--device emulates a viewport narrower than 1024px |  |  |  |  |
| `--deny <pattern>` | a control no mission may click (repeatable): an accessible-name regex (/Archive/i or Archive) or a descriptor role=button;name=Archive. Session-ending (Sign out), destructive (Delete, Revoke, Rotate) and paid (Buy, Run simulation, Generate, Send invite) controls are refused by default | `[]` |  |  |  |
| `--device <name>` | emulate a Playwright registered device by name, e.g. --device "iPhone 13" (viewport + scale + mobile/touch + UA; mutually exclusive with --viewport) |  |  |  |  |
| `--dialogs <policy>` | native window.confirm/prompt dialogs: dismiss (default) or accept. accept still dismisses one whose message names a session-ending, destructive or paid action the run may not take (without --allow-destructive or a goal asking for it); every dialog is logged |  |  |  |  |
| `--env <name>` | run against a named environment from the repo's .jevitate/environments.json (default: the Journey's recorded site) |  |  |  |  |
| `--evidence-video` | per defect: replay its minimal repro with captions + the failing step marked, record a masked clip and before/at screenshots (defects[].evidence; linked from drafts) |  |  |  |  |
| `--extension <dir>` | load this unpacked browser extension (repeatable; a directory with manifest.json). Its chrome-extension://<id> pages are allowed and navigable, e.g. --url chrome-extension://<id>/sidepanel.html; headless uses Chromium's new headless | `[]` |  |  |  |
| `--fake-ai` | use deterministic fake gateways (pipeline smoke only) | `false` |  |  |  |
| `--feature <name>` | run the capability-scoped feature-testing mission (instead of --goal/--success) |  |  |  |  |
| `--file-issues` | file findings as issues (needs a repo: --issue-repo or ~/.jevitate/filing.json); default: drafts only |  |  |  |  |
| `--fixture <path>` | local file the upload op attaches to a file input (goal and usability strategies); must exist |  |  |  |  |
| `--fixture-identity <name=storageState>` | #243: a named identity fixture steps can authenticate as (`auth.identity`), separate from the mission's own session — e.g. mint an invite as the owner, run the mission cold (repeatable) | `[]` |  |  |  |
| `--fixtures <file>` | mission fixtures JSON {setup:[...], restore:[...]} (#140/#144): HTTP steps to an --allow origin, authenticated from --storage-state/--secret-field, run before the mission and restored after it — and around every replay. Outputs bind as ${setup.<name>} |  |  |  |  |
| `--from-journey <id>` | journey-anchored exploration (#293): start from a PROMOTED Journey instead of --url — its first --at-step steps are replayed in the mission's own browser context (page, form contents and session kept; fail-closed, never self-healed; --env/--base-url apply), then the mission starts on the live page. A replay that stops before the anchor ends the run inconclusive (failure.kind journey-stale, exit 2). Strategies: goal, coverage, exploratory, adversarial, usability |  |  |  |  |
| `--geolocation <lat,lng>` | place the browser at this position, e.g. --geolocation 41.6376,-70.9036 (optional third value: accuracy in metres); the geolocation permission is granted to the run's allowed origins only |  |  |  |  |
| `--goal <text>` | natural-language goal / job (required for --strategy goal and usability) |  |  |  |  |
| `--hang-replay-writes` | let hang replays re-send a paid/destructive write the run sent (default: such a hang is reported inconclusive, never replayed) |  |  |  |  |
| `--hang-replays <n>` | fresh-context replays that confirm a hang (default 2; 0 = don't replay, the hang is reported unconfirmed) |  |  |  |  |
| `--headed` | show the browser window (demo mode); also JEVITATE_HEADED=1. Default: headless. Needs a display — else use --record-video |  |  |  |  |
| `--hook-timeout-ms <ms>` | timeout for each --before/--after hook (default 60000; the process group is killed) |  |  |  |  |
| `--ignore-host-load` | start even when the host is starved (load >= 4/core or < 512 MiB free) instead of refusing with E_HOST_STARVED; the run is throttled and its result records it |  |  |  |  |
| `--ignore-no-progress <pattern>` | a route / action label / busy indicator where ui-no-progress is expected (repeatable, * wildcard) | `[]` |  |  |  |
| `--ignore-overflow <selector>` | a CSS selector (repeatable) whose overflow or clipping is intentional — excluded from the horizontal-overflow and vertical-clipping signals, like --ignore-no-progress | `[]` |  |  |  |
| `--invariants <file>` | app-declared invariants JSON (repeatable; goal, coverage, exploratory, adversarial, --feature): checked around every action, a violation is a defect (exit 1). Validated before any browser opens; probes are GET/HEAD on an --allow origin only | `[]` |  |  |  |
| `--issue-repo <owner/name>` | the system-under-test repo findings for THIS target are filed to |  |  |  |  |
| `--jev-provider <provider>` | with --real: which key judgment (Jev) uses — typesafe (TYPESAFE_API_KEY) or openrouter (OPENROUTER_API_KEY, Jev through OpenRouter). Default: JEVITATE_JEV_PROVIDER, else the TypeSafe key when both are set |  |  |  |  |
| `--jevitate-repo <owner/name>` | where jevitate engine findings are filed (default matt-cochran/jevitate) |  |  |  |  |
| `--job-wait-ms <ms>` | goal and usability: while the page shows an in-progress status ("Simulating…", aria-busy, a job "is running"), waits keep waiting with backoff — and a model 'blocked' is deferred — up to this budget (default: --reply-ceiling-ms, 180000); it also bounds a busy indicator the app visibly keeps working behind (live progress, a job poll) before it is a hang, and a wait the page documents ("usually takes a minute") can raise it |  |  |  |  |
| `--journeys-dir <path>` | with --from-journey: the journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys) |  |  |  |  |
| `--json` | emit the JSON envelope (default: a human summary) |  |  |  |  |
| `--log-correlation-header <name>` | another request/response header that carries a correlation id (repeatable; built in: traceparent, x-request-id, x-correlation-id, request-id, x-amzn-trace-id, x-b3-traceid, x-cloud-trace-context). A log line carrying a request's id is attached to that exact request and the step that sent it, not by time (#204) | `[]` |  |  |  |
| `--log-defect <level|/regex/>` | backend log lines matching this (repeatable) become a server-log defect: a level (error\|warn\|info\|debug, matched as level>=this) or a /regex/flags/ over the raw line. Its fingerprint is the normalized message (ids/numbers/uuids/timestamps stripped) plus the correlated route; verify-fix re-checks it by re-tailing the same --log-source(s) | `[]` |  |  |  |
| `--log-id-pattern </regex/>` | how a correlation id is written in your log lines, when not as trace_id=/request_id=/correlation_id= or a traceparent (repeatable; the first capture group is the id). Once ids correlate, a line with another request's id is never attributed to the run (#204) | `[]` |  |  |  |
| `--log-ignore <regex|substring>` | excludes known-noise backend log lines (repeatable, /regex/flags/ over the raw line or a plain substring) from BOTH correlation and the --log-defect oracle (#169 item 3) — e.g. a periodic background job's own expected error. Counted separately as serverLogs.ignoredLines; never makes --log-quiet-ok unnecessary, since an ignored line still proves the source is being tailed | `[]` |  |  |  |
| `--log-quiet-ok <spec>` | compatibility only since 0.8.0 (#420): a --log-source that opens and reads zero lines is now always a healthy oracle (the silence is recorded as serverLogs.quietSources), so this flag no longer changes any outcome. Kept so existing invocations keep working | `[]` |  |  |  |
| `--log-scope <regex|substring>` | attributes only backend log lines matching this (repeatable, /regex/flags/ or a plain substring, e.g. a tenant id) to the run (#282); the rest count as serverLogs.ignoredLines. For concurrent runs tailing one log. A line carrying one of the run's own correlation ids is in scope | `[]` |  |  |  |
| `--log-source <spec>` | backend log source (repeatable; every strategy, incl. usability): file:<path> (tailed from its current end) \| docker:<container> (docker logs -f --since 0s) \| cmd:<command> (needs --allow-log-cmd). Read-only, operator-declared, never the model's choice. Error/warning lines are correlated to the step they landed during and attached to its transcript evidence, redacted | `[]` |  |  |  |
| `--log-triage` | #313: record the run's whole signal timeline (backend lines at every level, the browser's console, page errors, failed requests) to <run>.signals.jsonl, and attach to each defect only the lines that relate to it (defects[].relatedLogs): code keeps the lines correlated to its request and prefilters its step's window, then, with --real, Jev scores each remaining line's relevance (log text goes to the judgment model, redacted — operator opt-in, never an MCP argument). Needs --log-source |  |  |  |  |
| `--long-poll-ms <n>` | a request pending this long on an interactive page is a long-poll (default 5000) |  |  |  |  |
| `--max-actions <n>` | hard cap on executed actions |  |  |  |  |
| `--max-browser-memory <MiB>` | memory ceiling of this run's browsers (browser + renderers); over it the run ends inconclusive with failure kind resource-limit (default: JEVITATE_MAX_BROWSER_MEMORY_MB, else 4096 or half the RAM) |  |  |  |  |
| `--max-browsers <n>` | machine-wide cap on jevitate runs with a browser open at once, shared by every jevitate on this machine (default: JEVITATE_MAX_BROWSERS, else cores/4 within 2..6; halved while the host is loaded) |  |  |  |  |
| `--max-decisions <n>` | hard cap on model decisions |  |  |  |  |
| `--max-findings-per-page <n>` | (--strategy usability) cap on UX findings per route/page, highest-confidence first; the rest are counted in report.suppressed as per-page-cap, never dropped silently; default JEVITATE_UX_MAX_FINDINGS_PER_PAGE, then ~/.jevitate/config.json ux.maxFindingsPerPage, then 5 |  |  |  |  |
| `--min-actions <n>` | --strategy goal (#424): the minimum actions before the model may conclude — until then an early report, blocked or answerless done is deferred and the run steered to breadth (unvisited tabs, detail views, primary forms). Default: 12 (at most half the budget) for an open-ended find-out goal (no --success; "the main features", "what works", "every error", "explore"…), none otherwise. Capped by --max-actions (with a warning) |  |  |  |  |
| `--min-agreement <k>` | with --repeat: runs a finding (and the outcome) must recur in to count (default: a majority of N) |  |  |  |  |
| `--min-confidence <n>` | (--strategy usability) findings below this FINDING confidence (0..1, a finding's own violation/applicability/grounding score — NOT its quality-grade confidence, a separate independent-grader number shown as finding.quality.confidence) are suppressed and counted in report.suppressed; default JEVITATE_UX_MIN_CONFIDENCE, then ~/.jevitate/config.json ux.minConfidence, then 0.3 |  |  |  |  |
| `--min-control-coverage <ratio>` | adversarial: share of the target's controls (0..1) a run must exercise before 'found nothing' is clean (default 0.25); below it the run is inconclusive |  |  |  |  |
| `--min-distinct-states <n>` | --strategy goal (#424): the minimum distinct page states (URL + visible controls) observed before the model may conclude. Default: 5 (scaled to the budget) for an open-ended find-out goal, none otherwise. Capped by the budget (with a warning) |  |  |  |  |
| `--no-overlay` | with --headed: hide the on-page overlay (step, intent, target highlight, outcome banner) |  |  |  |  |
| `--no-require-form-submit` | adversarial: do not require a submitted form for a clean result (default: required when the target has a form) |  |  |  |  |
| `--out <dir>` | directory to write the emitted Recording |  |  |  |  |
| `--paid <pattern>` | an app control that costs money or credits (repeatable; same syntax as --deny), e.g. /^(Analyze\|Draft\|Improve)\b/i: treated like the built-in paid vocabulary — the budget guard sees it, hang replays never repeat it, and a goal that asks for it may still click it | `[]` |  |  |  |
| `--param <kv>` | with --from-journey: a Journey param as key=value (repeatable); only the prefix's own params are required | `{}` |  |  |  |
| `--persona <name=storageState>` | run the same mission once per persona (repeatable), serially, each from its own storageState, and diff them (#143): requests, statuses (a 403 vs 200 is a candidate RBAC finding), controls, outcome | `[]` |  |  |  |
| `--personas <file>` | personas JSON: {"<name>": "<storageState>"} or {"personas": [{"name", "storageState", "login"?}]} — #427: `login` ({url, userEnv, passwordEnv, userField?, passwordField?, submit?, success?}, environment variable NAMES only) re-mints an expired session once. A bare --persona <name> is the project's persona of that name (.jevitate/personas.json, same format) |  |  |  |  |
| `--polish` | (--strategy usability) polish each verified UX finding's recommendation with one generation call (opt-in; the default prose is built from templates) |  |  |  |  |
| `--probe-guards` | (--strategy usability) opt in to clicking each destructive control once to check for a confirmation step — fail-safe: every write and destructive-looking request is aborted, and a page with an open WebSocket/EventSource or a service worker is not probed; without it those claims are reported unverifiable (docs/ux-findings.md) |  |  |  |  |
| `--product <file>` | (--strategy usability) product facts JSON (plans/prices, key journeys, each page's intended next step) the review checks screens against in code; default .jevitate/product.json in the project when present (docs/ux-findings.md) |  |  |  |  |
| `--read-rpc <glob>` | a POST request that only READS (repeatable): an RPC-method glob (Estimate*, pkg.Service/Preview*) or a path glob (/api/search*). gRPC-web/Connect Get*/List*/Search*/Find*/Watch*/Stream*/Count*/Describe*/Read* methods are reads already. Reads are never guarded or reported as duplicate writes | `[]` |  |  |  |
| `--real` | use live Jev + OpenRouter gateways (requires keys) | `false` |  |  |  |
| `--record-video [dir]` | record a video of each browser context (works headless too); default: next to the run's result; listed as videoPaths |  |  |  |  |
| `--repeat <n>` | run the mission N times, one after another, each in a fresh browser context, and vote (#141): findings seen in fewer than --min-agreement runs are reported as flaky, not counted |  |  |  |  |
| `--reply-ceiling-ms <ms>` | conversational pages: hard ceiling on the TOTAL wait for one sent message's reply — the send's own wait plus every later 'wait' — however busy the page stays; once spent the run ends naming the missing reply (default 180000; never below --reply-wait-ms) (default 180000; never below --reply-wait-ms) |  |  |  |  |
| `--reply-max-chars <n>` | conversational pages: cap on each generated chat message (goal and usability; default 300) |  |  |  |  |
| `--reply-quiet-ms <ms>` | conversational pages: how long a reply must hold still (no new text, no busy sign) before it is read as complete (goal and usability; default 1000). Raise it for an assistant that answers in several parts (a sentence, then a card a moment later) |  |  |  |  |
| `--reply-wait-ms <ms>` | conversational pages: how long to keep waiting for a reply while the page shows no sign of working on one (goal and usability; default 60000). While a request the message started is in flight, a busy indicator shows, or the reply is still growing, the wait continues up to --reply-ceiling-ms |  |  |  |  |
| `--route <glob>` | in-scope route glob (repeatable), e.g. /thread/** — for --feature it replaces the default scope (the start URL's route and everything under it); it widens --strategy adversarial/coverage/exploratory beyond the start URL's route | `[]` |  |  |  |
| `--save-storage-state <file>` | write the context's storageState (cookies + origin storage) here when the run ends; mode 0600, contents never logged. Useful with a rotating refresh token: --storage-state's file goes stale after one authenticated run refreshes it, so point --save-storage-state at the SAME file (or a new one) to keep it usable for the next run. Written on every exit path -- a crash or a SIGTERM/SIGINT kill included (#159), not only a clean end -- but never over a good file with a session that already looks lost/logged-out; the last known-good state is used instead, or nothing is written if none was ever captured. |  |  |  |  |
| `--scope <mode>` | --strategy coverage/exploratory: 'app' widens containment to the whole app (same as --route '/**'); default: the start URL's route plus --route globs |  |  |  |  |
| `--screenshots [mode|dir]` | masked screenshots + index.md: one per distinct screen (default), `steps` one per step; `screens:<dir>`/`steps:<dir>`/`<dir>` set the folder (default: next to the run's result); listed as screenshotPaths |  |  |  |  |
| `--secret <value|env:VAR>` | REDACTION ONLY: a secret/PII value kept out of every model call and artifact (repeatable); env:VAR reads it from the environment (preferred: a literal is visible in the process list and shell history). It is never typed into a field — to log in, bind it with --secret-field (or start from --storage-state) | `[]` |  |  |  |
| `--secret-cmd-attempts <n>` | #359: how many times one cmd: secret field's command may run in this run (default 3); past it, typing that field fails without running the command again (read-the-code commands usually have side effects) |  |  |  |  |
| `--secret-field <binding>` | goal/usability strategy: '<label\|testId\|type\|id\|name>=<value>=env:<VAR>' (repeatable), e.g. 'label=Password=env:APP_PASSWORD'. When the run types into a matching field, code types $VAR itself; the model sees only «secret:VAR» and the Recording {redacted:true}. A value delivered during the run (an emailed code): '<descriptor>=cmd:<command>' runs the command when the field is typed and types its stdout (needs --allow-secret-cmd) | `[]` |  |  |  |
| `--server-log-drain-ms <ms>` | how long to keep tailing --log-source after the run's last action, to catch async backend work that settles after the browser gave up (default 3000) |  |  |  |  |
| `--settle-ignore <pattern>` | a request URL pattern the target marks as background (never pending work; repeatable, * wildcard) | `[]` |  |  |  |
| `--show <labels>` | opt-in filter on the quality grade (comma list of actionable,relevant-minor,generic,wrong); others are suppressed and counted; default JEVITATE_UX_SHOW, then ~/.jevitate/config.json ux.show, then ALL grades — the grader is uncalibrated (#133), so by default every finding is shown with its grade |  |  |  |  |
| `--slow-mo <ms>` | slow every browser operation by this many ms (default 250 with --headed, else 0) |  |  |  |  |
| `--stall-timeout <seconds>` | --strategy coverage/exploratory and --feature: end the run inconclusive (stalled) when no step completes within this many seconds (default 120) |  |  |  |  |
| `--storage-state <file>` | Playwright storageState JSON to start the session authenticated (deterministic login pre-step); must exist |  |  |  |  |
| `--strategy <name>` | exploration strategy: goal (default) \| coverage \| exploratory \| adversarial \| usability (UX review: ranked, cited findings) | `goal` |  |  |  |
| `--success <spec>` | independent success check (repeatable; every one must hold; --strategy goal and usability). Kinds: urlIncludes:<text> \| visible:<d> \| textIncludes:<d>\|<text> (case-insensitive) \| count:<d>\|min=<n>,max=<n> \| valueEquals:<d>\|<value> (a form control's value) \| reloadThen:<check> (reload first: proves it persisted) \| visual state (#148, read and decided by code): style:<d>\|<prop><op><value> (computed style of every match; <prop> an allowlisted CSS property or a channel of one, e.g. alpha(background-color)>0, color=rgb(255, 0, 0); op = != > >= < <=) \| inViewport:<d>[\|min=<ratio>] (visible fraction, default 0.5) \| box:<d>\|minWidth=<n>,maxWidth=<n>,minHeight=<n>,maxHeight=<n> \| overlaps:<d>\|<d2> \| noOverlap:<d>\|<d2> \| attr:<d>\|<name>=<value> (or <name> present, !<name> absent) \| flashed:<d>\|class=<cls> (or attr=<name>, animation)[\|withinMs=<n>] (a transient state gained after the last user input) \| requestMade:<METHOD> <path-glob> \| responseStatus:<METHOD> <path-glob>=<2xx\|4xx\|code>. <d> is testId=..;role=..;name=..;label=..;text=..;css=.. or a CSS selector such as [data-testid=x]. <path-glob> must start with "/" (it matches the request's path, e.g. /api/profile/* or /api/**); * as METHOD matches any method. e.g. --success 'requestMade:PUT /api/profile' --success 'reloadThen:valueEquals:[data-testid=last-name]\|Litmus'. Omit it for a find-out goal (e.g. "find out how many contacts... report the answer"): the run must then end with the model's own `report` op, and the grounded answer (#101) is the verdict — no page/network check needed. | `[]` |  |  |  |
| `--success-when <when>` | when the --success page checks must hold: final (default; on the final page) \| held (on the final page, or all together at any settled step — a one-time secret, a toast) \| each (each went from not holding to holding at some settled step, in any order — checks on different pages; the run stops once all have). reloadThen is always final |  |  |  |  |
| `--tag <key=value>` | run metadata tag stored in the result, its envelope and the run index (repeatable; key [A-Za-z0-9_.-]; never a secret) | `[]` |  |  |  |
| `--target <id>` | the target this run was meant to cover, stamped as target.id in the result, its envelope and the run index (1-64 of [A-Za-z0-9_.-]; a sweep sets it per target); key on it to attribute a run |  |  |  |  |
| `--totp <binding>` | goal/usability strategy: '<descriptor>=env:<VAR>' with $VAR a base32 TOTP seed (repeatable), e.g. 'label=Authentication code=env:APP_TOTP_SEED'. The 6-digit code is computed locally (RFC 6238) when the field is typed; the seed never reaches a model or disk | `[]` |  |  |  |
| `--type-fixture <binding>` | goal strategy: '<label\|testId\|type\|id\|name>=<value>=<file>' (repeatable), e.g. 'label=Paste your text=./fixtures/import.txt'. When the run types into a matching field, code types the file's exact text verbatim (line breaks kept, never paraphrased or capped); the model sees only «fixture:<file name>». Recorded as typed unless it holds a --secret | `[]` |  |  |  |
| `--url <url>` | target URL (must be an authorized origin) |  |  |  |  |
| `--viewport <WxH>` | emulate a viewport of this size, e.g. --viewport 375x812 (mutually exclusive with --device) |  |  |  |  |

## explore-author-journey

```
jevitate explore-author-journey [options]
```

Jev-driving authors a promotable Journey (authoring plane); never auto-promoted

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--action-deltas` | opt-in (#303; every --strategy, not --feature): record what each action changed on the page — an accessibility snapshot before and after, announcements, the action's requests — redacted, with a code verdict per step (no-change \| relevant-change \| inconclusive) used by the goal loop's no-progress check and a persistence re-check after writes (goal), and as defect evidence (adversarial, coverage); adds `delta` to every transcript step (and Recording step, goal) and `actionDeltas` to the result. Costs about 50-100 ms per action on a small page, 0.3-0.5 s on a large one |  |  |  |  |
| `--allow <origin>` | authorized origin (repeatable); REPLACES the default allowlist when given (the URL's own origin is used only when --allow is omitted entirely) -- include the URL's own origin explicitly if you still need it | `[]` |  |  |  |
| `--allow-control <regex>` | #428: exempt a control whose accessible name matches this regex (case-sensitive; /src/i for case-insensitive) from the soft built-in 'may cost money' name heuristic only — e.g. --allow-control "^Generate Your First Key$" (repeatable). It never lifts --deny, --paid, destructive, session-end, read-only or origin rules; every use is recorded in the result's safetyOverrides | `[]` |  |  |  |
| `--allow-destructive` | let missions click session-ending, destructive and paid controls (a --deny pattern still holds). A goal run already may click one its goal asks for |  |  |  |  |
| `--allow-secret-cmd` | opt-in: a --secret-field <descriptor>=cmd:<command> may run its command (in a shell, at type time, 60s timeout) and type its output (operator-declared only; refused otherwise) | `false` |  |  |  |
| `--allow-vacuous-checks` | downgrade a vacuous --success check to a warning. By default a check satisfied before the run's first action — a page check that held on the seed page and never changed (an empty result container), a requestMade/responseStatus matched only by a page-load or polling request — FAILS: it cannot verify the goal |  |  |  |  |
| `--api-prefix <path>` | a path prefix whose requests are the app's API in the timing summary (repeatable), e.g. /api/ | `[]` |  |  |  |
| `--browser-arg <arg>` | extra Chromium switch (repeatable); extends the Linux defaults --no-sandbox --disable-dev-shm-usage | `[]` |  |  |  |
| `--browser-channel <name>` | Playwright browser channel to launch, e.g. chrome \| msedge |  |  |  |  |
| `--browser-executable <path>` | launch this Chromium binary instead of Playwright's pinned one |  |  |  |  |
| `--deny <pattern>` | a control no mission may click (repeatable): an accessible-name regex (/Archive/i or Archive) or a descriptor role=button;name=Archive. Session-ending (Sign out), destructive (Delete, Revoke, Rotate) and paid (Buy, Run simulation, Generate, Send invite) controls are refused by default | `[]` |  |  |  |
| `--device <name>` | emulate a Playwright registered device by name, e.g. --device "iPhone 13" (viewport + scale + mobile/touch + UA; mutually exclusive with --viewport) |  |  |  |  |
| `--dialogs <policy>` | native window.confirm/prompt dialogs: dismiss (default) or accept. accept still dismisses one whose message names a session-ending, destructive or paid action the run may not take (without --allow-destructive or a goal asking for it); every dialog is logged |  |  |  |  |
| `--extension <dir>` | load this unpacked browser extension (repeatable; a directory with manifest.json). Its chrome-extension://<id> pages are allowed and navigable, e.g. --url chrome-extension://<id>/sidepanel.html; headless uses Chromium's new headless | `[]` |  |  |  |
| `--fake-ai` | use deterministic fake gateways (pipeline smoke only) | `false` |  |  |  |
| `--fixture <path>` | local file the upload op attaches to a file input (goal and usability strategies); must exist |  |  |  |  |
| `--geolocation <lat,lng>` | place the browser at this position, e.g. --geolocation 41.6376,-70.9036 (optional third value: accuracy in metres); the geolocation permission is granted to the run's allowed origins only |  |  |  |  |
| `--goal <text>` | natural-language goal |  |  |  |  |
| `--hang-replays <n>` | fresh-context replays that confirm a hang (default 2; 0 = don't replay, the hang is reported unconfirmed) |  |  |  |  |
| `--id <id>` | journey id (used for the <id>.json filename in the store) |  |  |  |  |
| `--ignore-host-load` | start even when the host is starved (load >= 4/core or < 512 MiB free) instead of refusing with E_HOST_STARVED; the run is throttled and its result records it |  |  |  |  |
| `--ignore-no-progress <pattern>` | a route / action label / busy indicator where ui-no-progress is expected (repeatable, * wildcard) | `[]` |  |  |  |
| `--jev-provider <provider>` | with --real: which key judgment (Jev) uses — typesafe (TYPESAFE_API_KEY) or openrouter (OPENROUTER_API_KEY, Jev through OpenRouter). Default: JEVITATE_JEV_PROVIDER, else the TypeSafe key when both are set |  |  |  |  |
| `--job-wait-ms <ms>` | goal and usability: while the page shows an in-progress status ("Simulating…", aria-busy, a job "is running"), waits keep waiting with backoff — and a model 'blocked' is deferred — up to this budget (default: --reply-ceiling-ms, 180000); it also bounds a busy indicator the app visibly keeps working behind (live progress, a job poll) before it is a hang, and a wait the page documents ("usually takes a minute") can raise it |  |  |  |  |
| `--journeys-dir <dir>` | journeys store directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--long-poll-ms <n>` | a request pending this long on an interactive page is a long-poll (default 5000) |  |  |  |  |
| `--max-actions <n>` | hard cap on executed actions |  |  |  |  |
| `--max-browser-memory <MiB>` | memory ceiling of this run's browsers (browser + renderers); over it the run ends inconclusive with failure kind resource-limit (default: JEVITATE_MAX_BROWSER_MEMORY_MB, else 4096 or half the RAM) |  |  |  |  |
| `--max-browsers <n>` | machine-wide cap on jevitate runs with a browser open at once, shared by every jevitate on this machine (default: JEVITATE_MAX_BROWSERS, else cores/4 within 2..6; halved while the host is loaded) |  |  |  |  |
| `--max-decisions <n>` | hard cap on model decisions |  |  |  |  |
| `--name <name>` | human-readable journey name |  |  |  |  |
| `--out <dir>` | directory each take's result, transcript and Recording are written to (default: .jevitate/logs/<date>) |  |  |  |  |
| `--paid <pattern>` | an app control that costs money or credits (repeatable; same syntax as --deny), e.g. /^(Analyze\|Draft\|Improve)\b/i: treated like the built-in paid vocabulary — the budget guard sees it, hang replays never repeat it, and a goal that asks for it may still click it | `[]` |  |  |  |
| `--read-rpc <glob>` | a POST request that only READS (repeatable): an RPC-method glob (Estimate*, pkg.Service/Preview*) or a path glob (/api/search*). gRPC-web/Connect Get*/List*/Search*/Find*/Watch*/Stream*/Count*/Describe*/Read* methods are reads already. Reads are never guarded or reported as duplicate writes | `[]` |  |  |  |
| `--real` | use live Jev + OpenRouter gateways (requires keys) | `false` |  |  |  |
| `--reply-ceiling-ms <ms>` | conversational pages: hard ceiling on the TOTAL wait for one sent message's reply — the send's own wait plus every later 'wait' — however busy the page stays; once spent the run ends naming the missing reply (default 180000; never below --reply-wait-ms) (default 180000; never below --reply-wait-ms) |  |  |  |  |
| `--reply-max-chars <n>` | conversational pages: cap on each generated chat message (goal and usability; default 300) |  |  |  |  |
| `--reply-quiet-ms <ms>` | conversational pages: how long a reply must hold still (no new text, no busy sign) before it is read as complete (goal and usability; default 1000). Raise it for an assistant that answers in several parts (a sentence, then a card a moment later) |  |  |  |  |
| `--reply-wait-ms <ms>` | conversational pages: how long to keep waiting for a reply while the page shows no sign of working on one (goal and usability; default 60000). While a request the message started is in flight, a busy indicator shows, or the reply is still growing, the wait continues up to --reply-ceiling-ms |  |  |  |  |
| `--save-storage-state <file>` | write the context's storageState (cookies + origin storage) here when the run ends; mode 0600, contents never logged. Useful with a rotating refresh token: --storage-state's file goes stale after one authenticated run refreshes it, so point --save-storage-state at the SAME file (or a new one) to keep it usable for the next run. Written on every exit path -- a crash or a SIGTERM/SIGINT kill included (#159), not only a clean end -- but never over a good file with a session that already looks lost/logged-out; the last known-good state is used instead, or nothing is written if none was ever captured. |  |  |  |  |
| `--screenshots [mode|dir]` | masked screenshots + index.md: one per distinct screen (default), `steps` one per step; `screens:<dir>`/`steps:<dir>`/`<dir>` set the folder (default: next to the run's result); listed as screenshotPaths |  |  |  |  |
| `--secret <value|env:VAR>` | REDACTION ONLY: a secret/PII value kept out of every model call and artifact (repeatable); env:VAR reads it from the environment (preferred: a literal is visible in the process list and shell history). It is never typed into a field — to log in, bind it with --secret-field (or start from --storage-state) | `[]` |  |  |  |
| `--secret-cmd-attempts <n>` | #359: how many times one cmd: secret field's command may run in this run (default 3); past it, typing that field fails without running the command again (read-the-code commands usually have side effects) |  |  |  |  |
| `--secret-field <binding>` | goal/usability strategy: '<label\|testId\|type\|id\|name>=<value>=env:<VAR>' (repeatable), e.g. 'label=Password=env:APP_PASSWORD'. When the run types into a matching field, code types $VAR itself; the model sees only «secret:VAR» and the Recording {redacted:true}. A value delivered during the run (an emailed code): '<descriptor>=cmd:<command>' runs the command when the field is typed and types its stdout (needs --allow-secret-cmd) | `[]` |  |  |  |
| `--settle-ignore <pattern>` | a request URL pattern the target marks as background (never pending work; repeatable, * wildcard) | `[]` |  |  |  |
| `--storage-state <file>` | Playwright storageState JSON to start the session authenticated (deterministic login pre-step); must exist |  |  |  |  |
| `--success <spec>` | independent success check (repeatable; all must hold), any explore --success kind, e.g. urlIncludes:/confirmed, 'reloadThen:textIncludes:css=main\|Saved' or 'responseStatus:POST /api/save=2xx': every check is kept as the Journey's end state and re-checked after every replay's last step | `[]` |  |  |  |
| `--success-when <when>` | when the --success page checks must hold: final (default; on the final page) \| held (on the final page, or all together at any settled step — a one-time secret, a toast) \| each (each went from not holding to holding at some settled step, in any order — checks on different pages; the run stops once all have). reloadThen is always final |  |  |  |  |
| `--takes <n>` | corroborating takes incl. discovery (default 1) | `1` |  |  |  |
| `--totp <binding>` | goal/usability strategy: '<descriptor>=env:<VAR>' with $VAR a base32 TOTP seed (repeatable), e.g. 'label=Authentication code=env:APP_TOTP_SEED'. The 6-digit code is computed locally (RFC 6238) when the field is typed; the seed never reaches a model or disk | `[]` |  |  |  |
| `--type-fixture <binding>` | goal strategy: '<label\|testId\|type\|id\|name>=<value>=<file>' (repeatable), e.g. 'label=Paste your text=./fixtures/import.txt'. When the run types into a matching field, code types the file's exact text verbatim (line breaks kept, never paraphrased or capped); the model sees only «fixture:<file name>». Recorded as typed unless it holds a --secret | `[]` |  |  |  |
| `--url <url>` | target URL (must be an authorized origin) |  |  |  |  |
| `--viewport <WxH>` | emulate a viewport of this size, e.g. --viewport 375x812 (mutually exclusive with --device) |  |  |  |  |

## inbox

```
jevitate inbox [command]
```

the HITL inbox from the CLI — the same tools `jevitate mcp` serves (approve/cancel stay human-only in `jevitate ui`)

### inbox approve

```
jevitate inbox approve [options] <id>
```

always refused (MCP approve_action): only a human can approve an inbox item, in `jevitate ui`

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `id` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--inbox-dir <path>` | inbox store directory (default: ~/.jevitate/inbox — the dir `jevitate mcp` and `jevitate ui` use) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |

### inbox cancel

```
jevitate inbox cancel [options] <id>
```

always refused (MCP cancel_command): only a human can cancel an inbox item, in `jevitate ui`

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `id` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--inbox-dir <path>` | inbox store directory (default: ~/.jevitate/inbox — the dir `jevitate mcp` and `jevitate ui` use) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |

### inbox command

```
jevitate inbox command [options] <id>
```

poll one inbox item as the agent does (MCP get_command): burn-after-read — unread human input needs --reveal, which consumes and prints it

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `id` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--inbox-dir <path>` | inbox store directory (default: ~/.jevitate/inbox — the dir `jevitate mcp` and `jevitate ui` use) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--reveal` | consume the human's unread input and print it, exactly as MCP get_command returns it |  |  |  |  |

### inbox health

```
jevitate inbox health [options]
```

inbox store health: pending count, oldest pending age, build (MCP get_site_health)

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--inbox-dir <path>` | inbox store directory (default: ~/.jevitate/inbox — the dir `jevitate mcp` and `jevitate ui` use) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |

### inbox list

```
jevitate inbox list [options]
```

list pending inbox items (MCP list_incoming)

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--inbox-dir <path>` | inbox store directory (default: ~/.jevitate/inbox — the dir `jevitate mcp` and `jevitate ui` use) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |

### inbox queue-action

```
jevitate inbox queue-action [options]
```

ask a human for a decision — an 'approval' item by default; only queues (MCP queue_action)

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--agent <name>` | who is asking (required) |  |  |  |  |
| `--findings <file>` | a JSON file holding an array of {id, title, severity: low\|med\|high, evidence?} |  |  |  |  |
| `--has-screenshot` | a screenshot accompanies the item |  |  |  |  |
| `--inbox-dir <path>` | inbox store directory (default: ~/.jevitate/inbox — the dir `jevitate mcp` and `jevitate ui` use) |  |  |  |  |
| `--journey <id>` | the Journey (required) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--kind <kind>` | approval (default) \| handback \| review |  | `approval`, `handback`, `review` |  |  |
| `--reason <text>` | what the human is asked for (required) |  |  |  |  |
| `--run <id>` | the run this item belongs to (required) |  |  |  |  |
| `--step <step>` | the step it stopped at (required) |  |  |  |  |
| `--target-url <url>` | the page it concerns |  |  |  |  |

### inbox queue-retrieval

```
jevitate inbox queue-retrieval [options]
```

ask a human to provide something back to the agent — a 'handback' item; only queues (MCP queue_retrieval)

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--agent <name>` | who is asking (required) |  |  |  |  |
| `--findings <file>` | a JSON file holding an array of {id, title, severity: low\|med\|high, evidence?} |  |  |  |  |
| `--has-screenshot` | a screenshot accompanies the item |  |  |  |  |
| `--inbox-dir <path>` | inbox store directory (default: ~/.jevitate/inbox — the dir `jevitate mcp` and `jevitate ui` use) |  |  |  |  |
| `--journey <id>` | the Journey (required) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--reason <text>` | what the human is asked for (required) |  |  |  |  |
| `--run <id>` | the run this item belongs to (required) |  |  |  |  |
| `--step <step>` | the step it stopped at (required) |  |  |  |  |
| `--target-url <url>` | the page it concerns |  |  |  |  |

### inbox show

```
jevitate inbox show [options] <id>
```

an inbox item's conversation thread — never its secret input (MCP get_thread)

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `id` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--inbox-dir <path>` | inbox store directory (default: ~/.jevitate/inbox — the dir `jevitate mcp` and `jevitate ui` use) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |

## init

```
jevitate init [options]
```

set up jevitate: collect API keys, install skills/MCP wiring, create the repo's .jevitate/

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--claude-md` | #431: also keep a marked jevitate block in the project's CLAUDE.md pointing at the installed skills (Claude Code only) |  |  |  |  |
| `--codeowners <owners>` | #437: write/merge a marked CODEOWNERS block (.github/CODEOWNERS, or the repo's existing one) making .jevitate/journeys/, personas.json and jobs.json need these owners' review ("@org/team @user"); enable code-owner review in branch protection |  |  |  |  |
| `--dry-run` | report planned skill-install/mcp-register actions without writing |  |  |  |  |
| `--force` | overwrite a user-modified installed skill file/block or MCP config entry |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--no-verify` | skip the live auth check of each key (offline / CI): report presence and source only |  |  |  |  |
| `--replace-keys` | prompt (masked) for a new value of every key, even one already stored, and store it |  |  |  |  |
| `--skip-keys` | skip credential collection |  |  |  |  |
| `--skip-mcp` | skip registering the jevitate MCP server in detected harnesses |  |  |  |  |
| `--skip-project` | skip creating the repo's .jevitate/ (journeys, regressions, baselines, logs) |  |  |  |  |
| `--skip-skills` | skip skill installation |  |  |  |  |
| `--targets <ids>` | comma-separated runtime ids to force-install to, overriding detection |  |  |  |  |
| `--uninstall` | #431: remove the skill files and marked AGENTS.md/CLAUDE.md blocks jevitate installed (user-modified ones are skipped unless --force); keys, MCP registration and .jevitate/ are left alone |  |  |  |  |

## invariants

```
jevitate invariants [command]
```

declared-invariant files (`explore --invariants`)

### invariants validate

```
jevitate invariants validate [options] <files...>
```

validate invariant files without a browser (the same pre-browser check `explore --invariants` runs); exit 1 when any is invalid, 64 when one cannot be read

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `files...` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--allow <origin>` | authorized origin (repeatable; needs --url); REPLACES the URL's own origin, as `explore --allow` | `[]` |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--observer <name>` | a registered observer actor a probe `as:` / `deniedAs.actor` may name (repeatable; `explore --actor` minus the primary) | `[]` |  |  |  |
| `--url <url>` | the run's start URL: relative probe/deniedAs paths resolve against it, and its origin is authorized |  |  |  |  |

## job

```
jevitate job [command]
```

#433: catalog jobs — job stories in .jevitate/jobs.json ("When …, I want to …, so I can ….") — review a job's sheet, approve it (bound to its content hash)

### job approve

```
jevitate job approve [options] <id>
```

approve a job (a person's sign-off; CLI only, never an MCP tool): shows its review sheet, runs the pre-approval findings, then records {contentHash, at} in its jobs file. Editing it later makes it — and its Journeys — "needs re-review"

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `id` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--accept-findings <reason>` | approve although pre-approval findings need an acknowledgment, recording the reason with the approval |  |  |  |  |
| `--dir <path>` | the project data dir holding personas.json and jobs.json (default: the repo's .jevitate/); its journeys/ are the Journeys |  |  |  |  |
| `--jev-provider <provider>` | with --real: which key judgment (Jev) uses — typesafe (TYPESAFE_API_KEY) or openrouter (OPENROUTER_API_KEY, Jev through OpenRouter). Default: JEVITATE_JEV_PROVIDER, else the TypeSafe key when both are set |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--non-interactive-approval <reason>` | #437: approve without a terminal confirmation (a scripted setup), recorded as channel non-interactive (ci under a CI marker) with the reason — never as a person's; check --require-approvals fails it. A coding agent never uses this |  |  |  |  |
| `--real` | #434/#435: ask Jev (advisory; never blocks on its own) — readiness questions and catalog pair classifications, cached by content hash. Without a judgment key the Jev layer is skipped, the deterministic layer still runs; a conflicting/duplicate pair classification at or above the documented threshold then needs --accept-findings |  |  |  |  |
| `--reviewed-hash <hash>` | the content hash of the review sheet you read; refused (E_CATALOG_REVIEW_STALE) if the job changed since |  |  |  |  |

### job review

```
jevitate job review [options] <id>
```

a job's review sheet: its story, its personas and which have a promoted Journey for it, the gaps, its Journeys, its approval state, the pre-approval findings, its content hash

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `id` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--dir <path>` | the project data dir holding personas.json and jobs.json (default: the repo's .jevitate/); its journeys/ are the Journeys |  |  |  |  |
| `--jev-provider <provider>` | with --real: which key judgment (Jev) uses — typesafe (TYPESAFE_API_KEY) or openrouter (OPENROUTER_API_KEY, Jev through OpenRouter). Default: JEVITATE_JEV_PROVIDER, else the TypeSafe key when both are set |  |  |  |  |
| `--json` | emit a JSON envelope (the schema-checked sheet) |  |  |  |  |
| `--markdown` | render the sheet as Markdown |  |  |  |  |
| `--out <file>` | write the sheet (JSON with --json, Markdown with --markdown, else text) to this file |  |  |  |  |
| `--readiness` | #434: add the Readiness section — deterministic checks with INCOSE GtWR rule findings, and (with --real and a judgment key) advisory Jev questions with probabilities |  |  |  |  |
| `--real` | #434/#435: ask Jev (advisory; never blocks on its own) — readiness questions and catalog pair classifications, cached by content hash. Without a judgment key the Jev layer is skipped, the deterministic layer still runs |  |  |  |  |

## journey

```
jevitate journey [command]
```

manage and run promoted Journeys (regression-test replays)

### journey anchors

```
jevitate journey anchors [options] <id>
```

list a Journey's anchors (#293): named steps to branch a mission off with `explore --from-journey <id> --at-step <name>`, and their suggested probes

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `id` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--dir <path>` | journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |

### journey annotate

```
jevitate journey annotate [options] <id>
```

draft each step's objective/expected result (and the goal/success criteria when missing) by replaying the Journey; writes a reviewable draft, never the Journey — `--approve` applies a reviewed draft (human gate)

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `id` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--action-deltas` | opt-in (#303): record what each replayed step changed and draft its expected result from that delta (by code, redacted) — the model is asked only for what the delta cannot say |  |  |  |  |
| `--after <cmd>` | operator shell hook run after the mission and every replay (needs --allow-shell-hooks) |  |  |  |  |
| `--allow-shell-hooks` | opt in to running --before/--after (operator commands; never model-chosen) | `false` |  |  |  |
| `--approve` | apply the reviewed draft to the Journey (shows the diff; refused if the Journey changed since the draft) | `false` |  |  |  |
| `--base-url <origin>` | run against this origin (an ad-hoc environment; with --env, replaces its baseUrl) |  |  |  |  |
| `--before <cmd>` | operator shell hook run before the mission and every replay (needs --allow-shell-hooks); may print {vars, secret} |  |  |  |  |
| `--browser-arg <arg>` | extra Chromium switch (repeatable); extends the Linux defaults --no-sandbox --disable-dev-shm-usage | `[]` |  |  |  |
| `--browser-channel <name>` | Playwright browser channel to launch, e.g. chrome \| msedge |  |  |  |  |
| `--browser-executable <path>` | launch this Chromium binary instead of Playwright's pinned one |  |  |  |  |
| `--device <name>` | emulate a Playwright registered device by name, e.g. --device "iPhone 13" (viewport + scale + mobile/touch + UA; mutually exclusive with --viewport) |  |  |  |  |
| `--dir <path>` | journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys) |  |  |  |  |
| `--env <name>` | run against a named environment from the repo's .jevitate/environments.json (default: the Journey's recorded site) |  |  |  |  |
| `--extension <dir>` | load this unpacked browser extension (repeatable; a directory with manifest.json). Its chrome-extension://<id> pages are allowed and navigable, e.g. --url chrome-extension://<id>/sidepanel.html; headless uses Chromium's new headless | `[]` |  |  |  |
| `--fake-ai` | draft with the deterministic fake generator (pipeline smoke only) | `false` |  |  |  |
| `--fixture-identity <name=storageState>` | #243: a named identity fixture steps can authenticate as (`auth.identity`), separate from the mission's own session — e.g. mint an invite as the owner, run the mission cold (repeatable) | `[]` |  |  |  |
| `--fixtures <file>` | mission fixtures JSON {setup:[...], restore:[...]} (#140/#144): HTTP steps to an --allow origin, authenticated from --storage-state/--secret-field, run before the mission and restored after it — and around every replay. Outputs bind as ${setup.<name>} |  |  |  |  |
| `--geolocation <lat,lng>` | place the browser at this position, e.g. --geolocation 41.6376,-70.9036 (optional third value: accuracy in metres); the geolocation permission is granted to the run's allowed origins only |  |  |  |  |
| `--hook-timeout-ms <ms>` | timeout for each --before/--after hook (default 60000; the process group is killed) |  |  |  |  |
| `--ignore-host-load` | start even when the host is starved (load >= 4/core or < 512 MiB free) instead of refusing with E_HOST_STARVED; the run is throttled and its result records it |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--max-browser-memory <MiB>` | memory ceiling of this run's browsers (browser + renderers); over it the run ends inconclusive with failure kind resource-limit (default: JEVITATE_MAX_BROWSER_MEMORY_MB, else 4096 or half the RAM) |  |  |  |  |
| `--max-browsers <n>` | machine-wide cap on jevitate runs with a browser open at once, shared by every jevitate on this machine (default: JEVITATE_MAX_BROWSERS, else cores/4 within 2..6; halved while the host is loaded) |  |  |  |  |
| `--param <kv>` | param as key=value (repeatable) | `{}` |  |  |  |
| `--real` | draft with the live OpenRouter generation gateway (requires keys) | `false` |  |  |  |
| `--screenshots [mode|dir]` | masked screenshots + index.md: one per distinct screen (default), `steps` one per step; `screens:<dir>`/`steps:<dir>`/`<dir>` set the folder (default: next to the run's result); listed as screenshotPaths |  |  |  |  |
| `--storage-state <file>` | Playwright storageState JSON to start the replay authenticated; must exist |  |  |  |  |
| `--viewport <WxH>` | emulate a viewport of this size, e.g. --viewport 375x812 (mutually exclusive with --device) |  |  |  |  |

### journey demo

```
jevitate journey demo [options] <id>
```

replay a Journey as a narrated demo (goal, step objectives as captions, target highlights) → a WebM video with .vtt subtitles and/or a Markdown step-by-step guide with screenshots; a Journey that no longer replays fails (exit 1)

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `id` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--action-deltas` | opt-in (#303): record each replayed step's delta, and caption each step with what it changed when its Recording was made (an "observed:" line in the subtitles and the guide) |  |  |  |  |
| `--after <cmd>` | operator shell hook run after the mission and every replay (needs --allow-shell-hooks) |  |  |  |  |
| `--allow-shell-hooks` | opt in to running --before/--after (operator commands; never model-chosen) | `false` |  |  |  |
| `--base-url <origin>` | run against this origin (an ad-hoc environment; with --env, replaces its baseUrl) |  |  |  |  |
| `--before <cmd>` | operator shell hook run before the mission and every replay (needs --allow-shell-hooks); may print {vars, secret} |  |  |  |  |
| `--browser-arg <arg>` | extra Chromium switch (repeatable); extends the Linux defaults --no-sandbox --disable-dev-shm-usage | `[]` |  |  |  |
| `--browser-channel <name>` | Playwright browser channel to launch, e.g. chrome \| msedge |  |  |  |  |
| `--browser-executable <path>` | launch this Chromium binary instead of Playwright's pinned one |  |  |  |  |
| `--device <name>` | emulate a Playwright registered device by name, e.g. --device "iPhone 13" (viewport + scale + mobile/touch + UA; mutually exclusive with --viewport) |  |  |  |  |
| `--dir <path>` | journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys) |  |  |  |  |
| `--env <name>` | run against a named environment from the repo's .jevitate/environments.json (default: the Journey's recorded site) |  |  |  |  |
| `--extension <dir>` | load this unpacked browser extension (repeatable; a directory with manifest.json). Its chrome-extension://<id> pages are allowed and navigable, e.g. --url chrome-extension://<id>/sidepanel.html; headless uses Chromium's new headless | `[]` |  |  |  |
| `--fixture-identity <name=storageState>` | #243: a named identity fixture steps can authenticate as (`auth.identity`), separate from the mission's own session — e.g. mint an invite as the owner, run the mission cold (repeatable) | `[]` |  |  |  |
| `--fixtures <file>` | mission fixtures JSON {setup:[...], restore:[...]} (#140/#144): HTTP steps to an --allow origin, authenticated from --storage-state/--secret-field, run before the mission and restored after it — and around every replay. Outputs bind as ${setup.<name>} |  |  |  |  |
| `--geolocation <lat,lng>` | place the browser at this position, e.g. --geolocation 41.6376,-70.9036 (optional third value: accuracy in metres); the geolocation permission is granted to the run's allowed origins only |  |  |  |  |
| `--guide <file>` | write a Markdown guide here (.md), screenshots in <name>.assets/ beside it |  |  |  |  |
| `--headed` | show the browser window (demo mode); also JEVITATE_HEADED=1. Default: headless. Needs a display |  |  |  |  |
| `--hook-timeout-ms <ms>` | timeout for each --before/--after hook (default 60000; the process group is killed) |  |  |  |  |
| `--ignore-host-load` | start even when the host is starved (load >= 4/core or < 512 MiB free) instead of refusing with E_HOST_STARVED; the run is throttled and its result records it |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--max-browser-memory <MiB>` | memory ceiling of this run's browsers (browser + renderers); over it the run ends inconclusive with failure kind resource-limit (default: JEVITATE_MAX_BROWSER_MEMORY_MB, else 4096 or half the RAM) |  |  |  |  |
| `--max-browsers <n>` | machine-wide cap on jevitate runs with a browser open at once, shared by every jevitate on this machine (default: JEVITATE_MAX_BROWSERS, else cores/4 within 2..6; halved while the host is loaded) |  |  |  |  |
| `--pace <ms>` | how long each step's caption shows before it acts (default 1500) |  |  |  |  |
| `--param <kv>` | param as key=value (repeatable) | `{}` |  |  |  |
| `--screenshots [mode|dir]` | masked screenshots + index.md: one per distinct screen (default), `steps` one per step; `screens:<dir>`/`steps:<dir>`/`<dir>` set the folder (default: next to the run's result); listed as screenshotPaths |  |  |  |  |
| `--slow-mo <ms>` | slow every browser operation by this many ms (default 250 with --headed, else 0) |  |  |  |  |
| `--storage-state <file>` | Playwright storageState JSON to start the replay authenticated; must exist |  |  |  |  |
| `--video <file>` | write the demo video here (.webm) and its subtitles beside it (.vtt) |  |  |  |  |
| `--viewport <WxH>` | emulate a viewport of this size, e.g. --viewport 375x812 (mutually exclusive with --device) |  |  |  |  |

### journey find

```
jevitate journey find [options] <query>
```

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `query` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--dir <path>` | journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |

### journey lint

```
jevitate journey lint [options] <id>
```

report a Journey's weak assertions (writes without an asserted effect, visibility-only claims, nothing after the last write, …)

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `id` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--dir <path>` | journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--sarif <file>` | also write a SARIF 2.1.0 log here |  |  |  |  |

### journey list

```
jevitate journey list [options]
```

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--dir <path>` | journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |

### journey promote

```
jevitate journey promote [options] <id>
```

promote a local Journey (human-approval gate) so it becomes discoverable/runnable; shows its review sheet first and records the approval

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `id` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--accept-findings <reason>` | #433: promote although pre-approval findings need an acknowledgment, recording the reason in approval.acceptedFindings |  |  |  |  |
| `--accept-unvetted <reason>` | #433: promote although its linked job/persona is not approved (unknown, draft or stale), recording the reason in approval.waivers |  |  |  |  |
| `--accept-weak <reason>` | #401: promote a Journey whose assertions cannot prove its outcome, recording the reason |  |  |  |  |
| `--dir <path>` | journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys) |  |  |  |  |
| `--jev-provider <provider>` | with --real: which key judgment (Jev) uses — typesafe (TYPESAFE_API_KEY) or openrouter (OPENROUTER_API_KEY, Jev through OpenRouter). Default: JEVITATE_JEV_PROVIDER, else the TypeSafe key when both are set |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--non-interactive-approval <reason>` | #437: approve without a terminal confirmation (a scripted setup), recorded as channel non-interactive (ci under a CI marker) with the reason — never as a person's; check --require-approvals fails it. A coding agent never uses this: it hands the approval to a person |  |  |  |  |
| `--real` | #434/#435: ask Jev (advisory; never blocks on its own) — readiness questions and catalog pair classifications, cached by content hash. Without a judgment key the Jev layer is skipped, the deterministic layer still runs; a conflicting/duplicate pair classification at or above the documented threshold then needs --accept-findings |  |  |  |  |
| `--review-sheet <file>` | #432: the review sheet file you read (journey review --out); its content hash binds the approval like --reviewed-hash |  |  |  |  |
| `--reviewed-hash <hash>` | #432: the content hash of the review sheet you read; refused (E_JOURNEY_REVIEW_STALE) if the Journey changed since |  |  |  |  |

### journey publish

```
jevitate journey publish [options] <id>
```

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `id` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--as <id>` | publish under a different id than the local one |  |  |  |  |
| `--declare-origin <origin>` | origin this Journey is authorized for (repeatable; default: derived from navigate steps) | `[]` |  |  |  |
| `--dir <path>` | journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--to <source>` | registered source name to publish into |  |  | yes |  |

### journey review

```
jevitate journey review [options] <id>
```

a human-readable review sheet for promotion sign-off: summary, steps, side effects, inputs (names only), proof, change since last approval, content hash

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `id` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--dir <path>` | journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys) |  |  |  |  |
| `--jev-provider <provider>` | with --real: which key judgment (Jev) uses — typesafe (TYPESAFE_API_KEY) or openrouter (OPENROUTER_API_KEY, Jev through OpenRouter). Default: JEVITATE_JEV_PROVIDER, else the TypeSafe key when both are set |  |  |  |  |
| `--json` | emit a JSON envelope (the schema-checked sheet) |  |  |  |  |
| `--markdown` | render the sheet as Markdown |  |  |  |  |
| `--out <file>` | write the sheet (JSON with --json, Markdown with --markdown, else text) to this file |  |  |  |  |
| `--readiness` | #434: add the Readiness section — deterministic checks with INCOSE GtWR rule findings, and (with --real and a judgment key) advisory Jev questions with probabilities |  |  |  |  |
| `--real` | #434/#435: ask Jev (advisory; never blocks on its own) — readiness questions and catalog pair classifications, cached by content hash. Without a judgment key the Jev layer is skipped, the deterministic layer still runs |  |  |  |  |

### journey run

```
jevitate journey run [options] <id>
```

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `id` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--action-deltas` | opt-in (#303): record what each replayed step changed on the page (redacted, a code verdict per step) and compare it with the delta its Recording stored — returned as actionDeltas |  |  |  |  |
| `--after <cmd>` | operator shell hook run after the mission and every replay (needs --allow-shell-hooks) |  |  |  |  |
| `--allow-shell-hooks` | opt in to running --before/--after (operator commands; never model-chosen) | `false` |  |  |  |
| `--base-url <origin>` | run against this origin (an ad-hoc environment; with --env, replaces its baseUrl) |  |  |  |  |
| `--before <cmd>` | operator shell hook run before the mission and every replay (needs --allow-shell-hooks); may print {vars, secret} |  |  |  |  |
| `--browser-arg <arg>` | extra Chromium switch (repeatable); extends the Linux defaults --no-sandbox --disable-dev-shm-usage | `[]` |  |  |  |
| `--browser-channel <name>` | Playwright browser channel to launch, e.g. chrome \| msedge |  |  |  |  |
| `--browser-executable <path>` | launch this Chromium binary instead of Playwright's pinned one |  |  |  |  |
| `--device <name>` | emulate a Playwright registered device by name, e.g. --device "iPhone 13" (viewport + scale + mobile/touch + UA; mutually exclusive with --viewport) |  |  |  |  |
| `--dir <path>` | journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys) |  |  |  |  |
| `--env <name>` | run against a named environment from the repo's .jevitate/environments.json (default: the Journey's recorded site) |  |  |  |  |
| `--extension <dir>` | load this unpacked browser extension (repeatable; a directory with manifest.json). Its chrome-extension://<id> pages are allowed and navigable, e.g. --url chrome-extension://<id>/sidepanel.html; headless uses Chromium's new headless | `[]` |  |  |  |
| `--fake-ai` | use deterministic fake gateways for self-heal (pipeline smoke only) | `false` |  |  |  |
| `--fixture-identity <name=storageState>` | #243: a named identity fixture steps can authenticate as (`auth.identity`), separate from the mission's own session — e.g. mint an invite as the owner, run the mission cold (repeatable) | `[]` |  |  |  |
| `--fixtures <file>` | mission fixtures JSON {setup:[...], restore:[...]} (#140/#144): HTTP steps to an --allow origin, authenticated from --storage-state/--secret-field, run before the mission and restored after it — and around every replay. Outputs bind as ${setup.<name>} |  |  |  |  |
| `--geolocation <lat,lng>` | place the browser at this position, e.g. --geolocation 41.6376,-70.9036 (optional third value: accuracy in metres); the geolocation permission is granted to the run's allowed origins only |  |  |  |  |
| `--headed` | show the browser window (demo mode); also JEVITATE_HEADED=1. Default: headless. Needs a display — else use --record-video |  |  |  |  |
| `--hook-timeout-ms <ms>` | timeout for each --before/--after hook (default 60000; the process group is killed) |  |  |  |  |
| `--ignore-host-load` | start even when the host is starved (load >= 4/core or < 512 MiB free) instead of refusing with E_HOST_STARVED; the run is throttled and its result records it |  |  |  |  |
| `--jev-provider <provider>` | with --real: which key judgment (Jev) uses — typesafe (TYPESAFE_API_KEY) or openrouter (OPENROUTER_API_KEY, Jev through OpenRouter). Default: JEVITATE_JEV_PROVIDER, else the TypeSafe key when both are set |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--max-browser-memory <MiB>` | memory ceiling of this run's browsers (browser + renderers); over it the run ends inconclusive with failure kind resource-limit (default: JEVITATE_MAX_BROWSER_MEMORY_MB, else 4096 or half the RAM) |  |  |  |  |
| `--max-browsers <n>` | machine-wide cap on jevitate runs with a browser open at once, shared by every jevitate on this machine (default: JEVITATE_MAX_BROWSERS, else cores/4 within 2..6; halved while the host is loaded) |  |  |  |  |
| `--param <kv>` | param as key=value (repeatable) | `{}` |  |  |  |
| `--real` | use live Jev + OpenRouter gateways for self-heal (requires keys) | `false` |  |  |  |
| `--record-video [dir]` | record a video of each browser context (works headless too); default: next to the run's result; listed as videoPaths |  |  |  |  |
| `--screenshots [mode|dir]` | masked screenshots + index.md: one per distinct screen (default), `steps` one per step; `screens:<dir>`/`steps:<dir>`/`<dir>` set the folder (default: next to the run's result); listed as screenshotPaths |  |  |  |  |
| `--self-heal <mode>` | self-heal policy mode: fail-closed \| hybrid \| full | `fail-closed` |  |  |  |
| `--slow-mo <ms>` | slow every browser operation by this many ms (default 250 with --headed, else 0) |  |  |  |  |
| `--storage-state <file>` | Playwright storageState JSON to start the session authenticated (#118: required when the journey declares metadata.requiresAuth); must exist |  |  |  |  |
| `--tag <key=value>` | run metadata tag stored in the result, its envelope and the run index (repeatable; key [A-Za-z0-9_.-]; never a secret) | `[]` |  |  |  |
| `--viewport <WxH>` | emulate a viewport of this size, e.g. --viewport 375x812 (mutually exclusive with --device) |  |  |  |  |

### journey verify

```
jevitate journey verify [options] <id>
```

prove each assertion of a Journey can fail: --mutate replays it with each write step skipped or blocked, and each checked fill emptied

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `id` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--after <cmd>` | operator shell hook run after the mission and every replay (needs --allow-shell-hooks) |  |  |  |  |
| `--allow-shell-hooks` | opt in to running --before/--after (operator commands; never model-chosen) | `false` |  |  |  |
| `--base-url <origin>` | run against this origin (an ad-hoc environment; with --env, replaces its baseUrl) |  |  |  |  |
| `--before <cmd>` | operator shell hook run before the mission and every replay (needs --allow-shell-hooks); may print {vars, secret} |  |  |  |  |
| `--browser-arg <arg>` | extra Chromium switch (repeatable); extends the Linux defaults --no-sandbox --disable-dev-shm-usage | `[]` |  |  |  |
| `--browser-channel <name>` | Playwright browser channel to launch, e.g. chrome \| msedge |  |  |  |  |
| `--browser-executable <path>` | launch this Chromium binary instead of Playwright's pinned one |  |  |  |  |
| `--dir <path>` | journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys) |  |  |  |  |
| `--env <name>` | run against a named environment from the repo's .jevitate/environments.json (default: the Journey's recorded site) |  |  |  |  |
| `--extension <dir>` | load this unpacked browser extension (repeatable; a directory with manifest.json). Its chrome-extension://<id> pages are allowed and navigable, e.g. --url chrome-extension://<id>/sidepanel.html; headless uses Chromium's new headless | `[]` |  |  |  |
| `--fixture-identity <name=storageState>` | #243: a named identity fixture steps can authenticate as (`auth.identity`), separate from the mission's own session — e.g. mint an invite as the owner, run the mission cold (repeatable) | `[]` |  |  |  |
| `--fixtures <file>` | mission fixtures JSON {setup:[...], restore:[...]} (#140/#144): HTTP steps to an --allow origin, authenticated from --storage-state/--secret-field, run before the mission and restored after it — and around every replay. Outputs bind as ${setup.<name>} |  |  |  |  |
| `--hook-timeout-ms <ms>` | timeout for each --before/--after hook (default 60000; the process group is killed) |  |  |  |  |
| `--ignore-host-load` | start even when the host is starved (load >= 4/core or < 512 MiB free) instead of refusing with E_HOST_STARVED; the run is throttled and its result records it |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--max-browser-memory <MiB>` | memory ceiling of this run's browsers (browser + renderers); over it the run ends inconclusive with failure kind resource-limit (default: JEVITATE_MAX_BROWSER_MEMORY_MB, else 4096 or half the RAM) |  |  |  |  |
| `--max-browsers <n>` | machine-wide cap on jevitate runs with a browser open at once, shared by every jevitate on this machine (default: JEVITATE_MAX_BROWSERS, else cores/4 within 2..6; halved while the host is loaded) |  |  |  |  |
| `--mutate` | run the mutation proof (required) |  |  |  |  |
| `--param <kv>` | param as key=value (repeatable) | `{}` |  |  |  |
| `--storage-state <file>` | Playwright storageState JSON to start each replay authenticated (as journey run) |  |  |  |  |

## ledger

```
jevitate ledger [command]
```

keep each finding's repro material by fingerprint, so verify-fix works long after the run's output is gone

### ledger add

```
jevitate ledger add [options] <result> <fingerprint>
```

store a finding's redacted repro material (never a session or storage state) in the committed ledger

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `result` | the mission's <stem>.result.json that contains the finding | yes |  |  |
| `fingerprint` | the defect/hang fingerprint | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--dir <path>` | regressions directory; the ledger is its ledger/ subdirectory (default: the repo's .jevitate/regressions) |  |  |  |  |
| `--json` | emit a JSON envelope (default: a human summary) |  |  |  |  |
| `--secret <value>` | refuse the entry if its material contains this value (repeatable) | `[]` |  |  |  |
| `--ticket <id>` | the tracker ticket the finding was filed as |  |  |  |  |

### ledger list

```
jevitate ledger list [options]
```

list the ledger's entries (fingerprint, kind, title, ticket, when added)

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--dir <path>` | regressions directory; the ledger is its ledger/ subdirectory (default: the repo's .jevitate/regressions) |  |  |  |  |
| `--json` | emit a JSON envelope (default: a human summary) |  |  |  |  |

### ledger verify

```
jevitate ledger verify [options] [fingerprints...]
```

re-check every ledger entry (or the named ones) with verify-fix, from the ledger alone

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `fingerprints...` | only these entries (default: every entry) | no |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--allow-log-cmd` | re-checking a server-log entry whose source is cmd:<command> needs this too | `false` |  |  |  |
| `--browser-arg <arg>` | extra Chromium switch (repeatable); extends the Linux defaults --no-sandbox --disable-dev-shm-usage | `[]` |  |  |  |
| `--browser-channel <name>` | Playwright browser channel to launch, e.g. chrome \| msedge |  |  |  |  |
| `--browser-executable <path>` | launch this Chromium binary instead of Playwright's pinned one |  |  |  |  |
| `--dir <path>` | regressions directory; the ledger is its ledger/ subdirectory (default: the repo's .jevitate/regressions) |  |  |  |  |
| `--extension <dir>` | load this unpacked browser extension (repeatable; a directory with manifest.json). Its chrome-extension://<id> pages are allowed and navigable, e.g. --url chrome-extension://<id>/sidepanel.html; headless uses Chromium's new headless | `[]` |  |  |  |
| `--ignore-host-load` | start even when the host is starved (load >= 4/core or < 512 MiB free) instead of refusing with E_HOST_STARVED; the run is throttled and its result records it |  |  |  |  |
| `--json` | emit a JSON envelope (default: a human summary) |  |  |  |  |
| `--max-browser-memory <MiB>` | memory ceiling of this run's browsers (browser + renderers); over it the run ends inconclusive with failure kind resource-limit (default: JEVITATE_MAX_BROWSER_MEMORY_MB, else 4096 or half the RAM) |  |  |  |  |
| `--max-browsers <n>` | machine-wide cap on jevitate runs with a browser open at once, shared by every jevitate on this machine (default: JEVITATE_MAX_BROWSERS, else cores/4 within 2..6; halved while the host is loaded) |  |  |  |  |
| `--replays <n>` | fresh-context replays per entry that confirm a fix (default 3) |  |  |  |  |
| `--storage-state <file>` | the session to replay an authenticated target with (entries never store one) |  |  |  |  |
| `--ticket <id>` | only the entries filed as this ticket |  |  |  |  |

## load

```
jevitate load [command]
```

run a promoted Journey as a load test

### load run

```
jevitate load run [options] <journeyId>
```

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `journeyId` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--authorized-origin <origin>` | allowed load-test target origin (repeatable) — required, fails closed if omitted | `[]` |  |  |  |
| `--base-url <origin>` | run against this origin (an ad-hoc environment; with --env, replaces its baseUrl) |  |  |  |  |
| `--browser-arg <arg>` | extra Chromium switch (repeatable); extends the Linux defaults --no-sandbox --disable-dev-shm-usage | `[]` |  |  |  |
| `--browser-channel <name>` | Playwright browser channel to launch, e.g. chrome \| msedge |  |  |  |  |
| `--browser-executable <path>` | launch this Chromium binary instead of Playwright's pinned one |  |  |  |  |
| `--concurrency <n>` | pool size | `1` |  |  |  |
| `--device <name>` | emulate a Playwright registered device by name, e.g. --device "iPhone 13" (viewport + scale + mobile/touch + UA; mutually exclusive with --viewport) |  |  |  |  |
| `--dir <path>` | journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys) |  |  |  |  |
| `--env <name>` | run against a named environment from the repo's .jevitate/environments.json (default: the Journey's recorded site) |  |  |  |  |
| `--extension <dir>` | load this unpacked browser extension (repeatable; a directory with manifest.json). Its chrome-extension://<id> pages are allowed and navigable, e.g. --url chrome-extension://<id>/sidepanel.html; headless uses Chromium's new headless | `[]` |  |  |  |
| `--geolocation <lat,lng>` | place the browser at this position, e.g. --geolocation 41.6376,-70.9036 (optional third value: accuracy in metres); the geolocation permission is granted to the run's allowed origins only |  |  |  |  |
| `--ignore-host-load` | start even when the host is starved (load >= 4/core or < 512 MiB free) instead of refusing with E_HOST_STARVED; the run is throttled and its result records it |  |  |  |  |
| `--iterations <n>` | iterations per actor | `1` |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--max-browser-memory <MiB>` | memory ceiling of this run's browsers (browser + renderers); over it the run ends inconclusive with failure kind resource-limit (default: JEVITATE_MAX_BROWSER_MEMORY_MB, else 4096 or half the RAM) |  |  |  |  |
| `--max-browsers <n>` | machine-wide cap on jevitate runs with a browser open at once, shared by every jevitate on this machine (default: JEVITATE_MAX_BROWSERS, else cores/4 within 2..6; halved while the host is loaded) |  |  |  |  |
| `--param <kv>` | param as key=value (repeatable) | `{}` |  |  |  |
| `--seed <n>` | master RNG seed | `1` |  |  |  |
| `--storage-state <file>` | Playwright storageState JSON to start every actor's session authenticated (#118: required when the journey declares metadata.requiresAuth); must exist |  |  |  |  |
| `--tag <key=value>` | run metadata tag stored in the result, its envelope and the run index (repeatable; key [A-Za-z0-9_.-]; never a secret) | `[]` |  |  |  |
| `--viewport <WxH>` | emulate a viewport of this size, e.g. --viewport 375x812 (mutually exclusive with --device) |  |  |  |  |

## login

```
jevitate login [options]
```

#427: sign in as a persona with credentials from environment variables and save its Playwright storage state (mode 0600) — the session `explore --storage-state/--persona` starts from. Credentials are never accepted as values, never printed or recorded

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--allow <origin>` | an origin credentials may be typed into (repeatable; default: the sign-in page's own) — e.g. an SSO provider | `[]` |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--password-env <VAR>` | environment variable holding the password (its NAME — the value is read from the environment) |  |  |  |  |
| `--password-field <field>` | the password field: its label, else a CSS selector (default: the visible password input) |  |  |  |  |
| `--persona <name>` | the persona being signed in (names it in the result); with a declared persona (--personas or .jevitate/personas.json) its login parameters and storage state path are the defaults |  |  |  |  |
| `--personas <file>` | personas JSON to read --persona's login parameters from (default: the project's .jevitate/personas.json) |  |  |  |  |
| `--save <file>` | where to write the storage state (parent directory created; mode 0600; never inside a repo's .jevitate/) |  |  |  |  |
| `--submit <name>` | the submit button's accessible name (default: the form's submit button, else Enter) |  |  |  |  |
| `--success <check>` | how a successful sign-in is recognised: urlIncludes:<text> \| selector:<css> \| text:<text> (default: the page leaves the sign-in form — no login-like URL, no password field) |  |  |  |  |
| `--timeout <seconds>` | how long each step of the sign-in may take (default 30) |  |  |  |  |
| `--url <loginUrl>` | the sign-in page (must be an authorized origin: its own, or --allow) |  |  |  |  |
| `--user-env <VAR>` | environment variable holding the username (its NAME — the value is read from the environment) |  |  |  |  |
| `--user-field <field>` | the username field: its label, else a CSS selector (default: found by autocomplete/type/name) |  |  |  |  |

## logs

```
jevitate logs [command]
```

run output under .jevitate/logs (dated; pruned by retention)

### logs prune

```
jevitate logs prune [options]
```

delete runs older than the retention TTL, always keeping the newest runs (config.json logs.ttlDays / logs.keepLatest; defaults 14 and 50)

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--dir <dir>` | logs root to prune (default: the project's .jevitate/logs, else ~/.jevitate/logs) |  |  |  |  |
| `--dry-run` | list what would be deleted, deleting nothing |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |

### logs triage

```
jevitate logs triage [options]
```

#313: re-triage a finished run's signals (<run>.signals.jsonl, written by explore --log-triage): attach to each defect only the lines that relate to it (defects[].relatedLogs) — the lines correlated to its request, then, with --real, the window lines Jev scores relevant (else its error/warning lines). Rewrites the result

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--fake-ai` | no model: keep the correlated lines and the window's error/warning lines (code only) | `false` |  |  |  |
| `--jev-provider <provider>` | with --real: which key judgment (Jev) uses — typesafe (TYPESAFE_API_KEY) or openrouter (OPENROUTER_API_KEY, Jev through OpenRouter). Default: JEVITATE_JEV_PROVIDER, else the TypeSafe key when both are set |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--real` | score relevance with the live Jev gateway (requires keys; log text goes to the judgment model, redacted) | `false` |  |  |  |
| `--result <path>` | the run's <run>.result.json (its <run>.signals.jsonl must sit next to it) |  |  | yes |  |
| `--secret <value|env:VAR>` | a value to keep out of the judgment payload (repeatable; env:VAR reads it from the environment) | `[]` |  |  |  |
| `--threshold <p>` | Jev relevance probability at or above which a line is kept (default 0.5) |  |  |  |  |

## mcp

```
jevitate mcp [options]
```

start an MCP stdio server exposing only the allowlisted Jevitate tools

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--dir <path>` | journeys directory (default: the repo's .jevitate/journeys; outside a repo ~/.jevitate/journeys) |  |  |  |  |
| `--print-config <harness>` | print the config snippet to register `jevitate mcp` in a harness (claude \| cursor \| codex \| json) and exit — prints only, writes nothing |  |  |  |  |

## mission

```
jevitate mission [command]
```

manage exploration mission targets and drain the mission queue

### mission queue

```
jevitate mission queue [options] <target>
```

enqueue an exploration mission against a PROMOTED target — only queues; `mission run` drains (MCP queue_exploration)

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `target` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--device <name>` | emulate a Playwright registered device by name, e.g. --device "iPhone 13" (viewport + scale + mobile/touch + UA; mutually exclusive with --viewport) |  |  |  |  |
| `--dir <path>` | mission queue directory (default: ~/.jevitate/missions/queue — the queue `jevitate mcp` and `mission run` use) |  |  |  |  |
| `--evidence-video` | per defect: a captioned evidence clip of its minimal repro + before/at screenshots (defects[].evidence) |  |  |  |  |
| `--feature <name>` | feature: the capability to test (goal-based: the objective) |  |  |  |  |
| `--goal <text>` | goal-based: the objective (exactly one of --goal/--feature/--route) |  |  |  |  |
| `--invariants <file>` | app-declared invariants JSON file (the `explore --invariants` format; probes GET/HEAD on the target's origins; no authFrom.secret) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--max-actions <n>` | budget: max actions (bounded by the queue's ceiling) |  |  |  |  |
| `--max-candidates <n>` | budget: max candidates |  |  |  |  |
| `--max-decisions <n>` | budget: max decisions |  |  |  |  |
| `--min-actions <n>` | goal-based (#424): the minimum actions before the model may conclude (capped by the budget; `explore --min-actions`) |  |  |  |  |
| `--min-distinct-states <n>` | goal-based (#424): the minimum distinct page states before the model may conclude (`explore --min-distinct-states`) |  |  |  |  |
| `--persona <name>` | run as this persona: its session in ~/.jevitate/targets.json (personas) for the target's origin — a name, never a path |  |  |  |  |
| `--record-video` | record a video of the run (headless too), written next to its result; listed as videoPaths |  |  |  |  |
| `--route <glob>` | coverage/exploratory/adversarial/feature: an in-scope route glob, e.g. /thread/** (goal-based: the objective) |  |  |  |  |
| `--screenshots [mode]` | masked screenshots + index.md next to the result: screens (default, one per distinct screen) \| steps (one per step) |  |  |  |  |
| `--strategy <strategy>` | goal-based \| coverage \| exploratory \| adversarial \| feature (required) |  | `goal-based`, `coverage`, `exploratory`, `adversarial`, `feature` |  |  |
| `--success <spec>` | goal-based: the independent success check (required there), e.g. urlIncludes:/done — the `explore --success` page-check forms |  |  |  |  |
| `--targets-dir <path>` | mission targets directory (default: ~/.jevitate/missions/targets) |  |  |  |  |
| `--viewport <WxH>` | emulate a viewport of this size, e.g. --viewport 375x812 (mutually exclusive with --device) |  |  |  |  |

### mission result

```
jevitate mission result [options] <id>
```

a mission's status and typed result, by result id or queued missionId (MCP get_mission_result); exits with its contract code

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `id` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--dir <path>` | mission queue directory (default: ~/.jevitate/missions/queue — the queue `jevitate mcp` and `mission run` use) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--results-dir <path>` | read the result file from this directory only (default: where `mission run` writes — .jevitate/logs/<date>, then ~/.jevitate) |  |  |  |  |

### mission run

```
jevitate mission run [options]
```

run queued missions (queue_exploration) through their strategy's runner; get_mission_result {id: missionId} then reads the result

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--browser-arg <arg>` | extra Chromium switch (repeatable); extends the Linux defaults --no-sandbox --disable-dev-shm-usage | `[]` |  |  |  |
| `--browser-channel <name>` | Playwright browser channel to launch, e.g. chrome \| msedge |  |  |  |  |
| `--browser-executable <path>` | launch this Chromium binary instead of Playwright's pinned one |  |  |  |  |
| `--dir <path>` | mission queue directory (default: ~/.jevitate/missions/queue) |  |  |  |  |
| `--extension <dir>` | load this unpacked browser extension (repeatable; a directory with manifest.json). Its chrome-extension://<id> pages are allowed and navigable, e.g. --url chrome-extension://<id>/sidepanel.html; headless uses Chromium's new headless | `[]` |  |  |  |
| `--fake-ai` | use deterministic fake gateways (pipeline smoke only) | `false` |  |  |  |
| `--ignore-host-load` | start even when the host is starved (load >= 4/core or < 512 MiB free) instead of refusing with E_HOST_STARVED; the run is throttled and its result records it |  |  |  |  |
| `--interval <ms>` | --watch poll interval in ms (default 5000) | `5000` |  |  |  |
| `--jev-provider <provider>` | with --real: which key judgment (Jev) uses — typesafe (TYPESAFE_API_KEY) or openrouter (OPENROUTER_API_KEY, Jev through OpenRouter). Default: JEVITATE_JEV_PROVIDER, else the TypeSafe key when both are set |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--max-browser-memory <MiB>` | memory ceiling of this run's browsers (browser + renderers); over it the run ends inconclusive with failure kind resource-limit (default: JEVITATE_MAX_BROWSER_MEMORY_MB, else 4096 or half the RAM) |  |  |  |  |
| `--max-browsers <n>` | machine-wide cap on jevitate runs with a browser open at once, shared by every jevitate on this machine (default: JEVITATE_MAX_BROWSERS, else cores/4 within 2..6; halved while the host is loaded) |  |  |  |  |
| `--once` | drain the missions queued now, then exit (default) |  |  |  |  |
| `--out <dir>` | where results are written (default: .jevitate/logs/<date> in the project, else ~/.jevitate/logs/<date> — where `jevitate mcp` reads them) |  |  |  |  |
| `--real` | use live Jev + OpenRouter gateways for model-driven missions (requires keys) | `false` |  |  |  |
| `--tag <key=value>` | run metadata tag stored in the result, its envelope and the run index (repeatable; key [A-Za-z0-9_.-]; never a secret) | `[]` |  |  |  |
| `--targets-dir <path>` | mission targets directory (default: ~/.jevitate/missions/targets) |  |  |  |  |
| `--watch` | keep draining: poll the queue every --interval ms until interrupted |  |  |  |  |

### mission target

```
jevitate mission target [command]
```

#### mission target add

```
jevitate mission target add [options] <id>
```

register an exploration mission target (UNPROMOTED — not usable by queue_exploration until promoted)

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `id` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--api-origin <origin>` | a further origin the app talks to, e.g. its API on another origin (repeatable) — the queued-mission analogue of a second `explore --allow` | `[]` |  |  |  |
| `--authorized-origin <origin>` | the target's app origin (a bare http(s) origin); --base-url must be on it |  |  |  |  |
| `--base-url <url>` | the base URL a mission starts navigation from |  |  |  |  |
| `--description <text>` | optional human-readable description |  |  |  |  |
| `--dir <path>` | mission targets directory (default: ~/.jevitate/missions/targets) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--name <name>` | human-readable target name |  |  |  |  |
| `--save-storage-state [file]` | #175: write the rotated session back after each queued mission — to --storage-state (no value) or to <file>; for rotating refresh tokens |  |  |  |  |
| `--secret-field <spec>` | #175: '<label\|testId\|type\|id\|name>=<value>=env:<VAR>' typed by queued goal missions (repeatable); the value is read from the environment at run time |  |  |  |  |
| `--storage-state <file>` | #175: Playwright storageState JSON queued missions on this target start from (must exist; wins over targets.json) |  |  |  |  |

#### mission target list

```
jevitate mission target list [options]
```

list ALL mission targets (promoted and unpromoted) — a local/dev-facing listing

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--dir <path>` | mission targets directory (default: ~/.jevitate/missions/targets) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |

#### mission target promote

```
jevitate mission target promote [options] <id>
```

promote a registered target so queue_exploration can resolve it

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `id` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--dir <path>` | mission targets directory (default: ~/.jevitate/missions/targets) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |

#### mission target update

```
jevitate mission target update [options] <id>
```

set a registered target's operator-declared auth for queued missions (#175); keeps its promotion state

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `id` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--clear-auth` | drop the target's storage state, save-back and secret fields first |  |  |  |  |
| `--dir <path>` | mission targets directory (default: ~/.jevitate/missions/targets) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--save-storage-state [file]` | #175: write the rotated session back after each queued mission — to --storage-state (no value) or to <file>; for rotating refresh tokens |  |  |  |  |
| `--secret-field <spec>` | #175: '<label\|testId\|type\|id\|name>=<value>=env:<VAR>' typed by queued goal missions (repeatable); the value is read from the environment at run time |  |  |  |  |
| `--storage-state <file>` | #175: Playwright storageState JSON queued missions on this target start from (must exist; wins over targets.json) |  |  |  |  |

## persona

```
jevitate persona [command]
```

#433: catalog personas (.jevitate/personas.json) — review a persona's sheet, approve it (a person's sign-off, bound to its content hash)

### persona approve

```
jevitate persona approve [options] <id>
```

approve a persona (a person's sign-off; CLI only, never an MCP tool): shows its review sheet, runs the pre-approval findings, then records {contentHash, at} in personas.json. Editing it later makes it — and its Journeys — "needs re-review"

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `id` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--accept-findings <reason>` | approve although pre-approval findings need an acknowledgment, recording the reason with the approval |  |  |  |  |
| `--dir <path>` | the project data dir holding personas.json and jobs.json (default: the repo's .jevitate/); its journeys/ are the Journeys |  |  |  |  |
| `--jev-provider <provider>` | with --real: which key judgment (Jev) uses — typesafe (TYPESAFE_API_KEY) or openrouter (OPENROUTER_API_KEY, Jev through OpenRouter). Default: JEVITATE_JEV_PROVIDER, else the TypeSafe key when both are set |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--non-interactive-approval <reason>` | #437: approve without a terminal confirmation (a scripted setup), recorded as channel non-interactive (ci under a CI marker) with the reason — never as a person's; check --require-approvals fails it. A coding agent never uses this |  |  |  |  |
| `--real` | #434/#435: ask Jev (advisory; never blocks on its own) — readiness questions and catalog pair classifications, cached by content hash. Without a judgment key the Jev layer is skipped, the deterministic layer still runs; a conflicting/duplicate pair classification at or above the documented threshold then needs --accept-findings |  |  |  |  |
| `--reviewed-hash <hash>` | the content hash of the review sheet you read; refused (E_CATALOG_REVIEW_STALE) if the persona changed since |  |  |  |  |

### persona review

```
jevitate persona review [options] <id>
```

a persona's review sheet: who it is, the jobs it serves, the Journeys linked to it, its approval state (stale = needs re-review), the pre-approval findings, its content hash

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `id` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--dir <path>` | the project data dir holding personas.json and jobs.json (default: the repo's .jevitate/); its journeys/ are the Journeys |  |  |  |  |
| `--jev-provider <provider>` | with --real: which key judgment (Jev) uses — typesafe (TYPESAFE_API_KEY) or openrouter (OPENROUTER_API_KEY, Jev through OpenRouter). Default: JEVITATE_JEV_PROVIDER, else the TypeSafe key when both are set |  |  |  |  |
| `--json` | emit a JSON envelope (the schema-checked sheet) |  |  |  |  |
| `--markdown` | render the sheet as Markdown |  |  |  |  |
| `--out <file>` | write the sheet (JSON with --json, Markdown with --markdown, else text) to this file |  |  |  |  |
| `--readiness` | #434: add the Readiness section — deterministic checks with INCOSE GtWR rule findings, and (with --real and a judgment key) advisory Jev questions with probabilities |  |  |  |  |
| `--real` | #434/#435: ask Jev (advisory; never blocks on its own) — readiness questions and catalog pair classifications, cached by content hash. Without a judgment key the Jev layer is skipped, the deterministic layer still runs |  |  |  |  |

## profile

```
jevitate profile [command]
```

manage jevitate profiles (isolated credential/data sets)

### profile create

```
jevitate profile create [options] <name>
```

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `name` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--json` | emit a JSON envelope |  |  |  |  |

### profile status

```
jevitate profile status [options] <name>
```

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `name` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--json` | emit a JSON envelope |  |  |  |  |

## record

```
jevitate record [options]
```

record a demonstrated flow into a Recording (authoring plane)

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--allow <origin>` | authorized origin (repeatable); REPLACES the default allowlist when given (the URL's own origin is used only when --allow is omitted entirely) -- include the URL's own origin explicitly if you still need it | `[]` |  |  |  |
| `--extension <dir>` | load this unpacked browser extension (repeatable; a directory with manifest.json); its chrome-extension://<id> origin is allowed | `[]` |  |  |  |
| `--headless` | run headless (default: headed — a record session is a live demonstration) | `false` |  |  |  |
| `--intent <text>` | your framing of the journey (carried to Recording.intent) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--out <dir>` | directory to write the emitted Recording (default: .jevitate/logs/<date> in the project, else ~/.jevitate/logs/<date>) |  |  |  |  |
| `--retro <text>` | optional retrospective note (carried to Recording.retro) |  |  |  |  |
| `--url <url>` | start URL to demonstrate from (must be an authorized origin) |  |  |  |  |

## recording

```
jevitate recording [command]
```

inspect and edit recorded takes (promote, edit steps, diff, postdoc)

### recording diff

```
jevitate recording diff [options] <takeA> <takeB> [more...]
```

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `takeA` |  | yes |  |  |
| `takeB` |  | yes |  |  |
| `more...` |  | no |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--json` | emit a JSON envelope |  |  |  |  |

### recording fit

```
jevitate recording fit [options] <file>
```

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `file` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--json` | emit a JSON envelope |  |  |  |  |

### recording postdoc

```
jevitate recording postdoc [options] <take> [more...]
```

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `take` |  | yes |  |  |
| `more...` |  | no |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--decisions <file>` | path to a PostdocDecision[] JSON file (non-interactive mode) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--out <file>` | write the resulting Recording to this file instead of stdout |  |  |  |  |

### recording promote

```
jevitate recording promote [options] <file>
```

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `file` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--page <n>` | page index |  |  | yes |  |
| `--step <n>` | step index within the page |  |  | yes |  |
| `--var <name>` | variable name to bind |  |  | yes |  |

## regression

```
jevitate regression [command]
```

capture, run and manage regression tests from discovered failures

### regression capture

```
jevitate regression capture [options]
```

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--after <cmd>` | operator shell hook run after the mission and every replay (needs --allow-shell-hooks) |  |  |  |  |
| `--allow-shell-hooks` | opt in to running --before/--after (operator commands; never model-chosen) | `false` |  |  |  |
| `--attempts <n>` | reproduction attempts before labeling flaky | `3` |  |  |  |
| `--before <cmd>` | operator shell hook run before the mission and every replay (needs --allow-shell-hooks); may print {vars, secret} |  |  |  |  |
| `--browser-arg <arg>` | extra Chromium switch (repeatable); extends the Linux defaults --no-sandbox --disable-dev-shm-usage | `[]` |  |  |  |
| `--browser-channel <name>` | Playwright browser channel to launch, e.g. chrome \| msedge |  |  |  |  |
| `--browser-executable <path>` | launch this Chromium binary instead of Playwright's pinned one |  |  |  |  |
| `--device <name>` | emulate a Playwright registered device by name, e.g. --device "iPhone 13" (viewport + scale + mobile/touch + UA; mutually exclusive with --viewport) |  |  |  |  |
| `--dir <path>` | regressions directory (default: the repo's .jevitate/regressions; outside a repo ~/.jevitate/regressions) |  |  |  |  |
| `--extension <dir>` | load this unpacked browser extension (repeatable; a directory with manifest.json). Its chrome-extension://<id> pages are allowed and navigable, e.g. --url chrome-extension://<id>/sidepanel.html; headless uses Chromium's new headless | `[]` |  |  |  |
| `--fingerprint <fp>` | pin the required failure — a structural step signature (alone, restricts --from to failing at exactly that step), or (with --result, #119/#129) a defect/invariant fingerprint from the mission's own findings; with --result alone, cross-checks the derived oracle |  |  |  |  |
| `--fixture-identity <name=storageState>` | #243: a named identity fixture steps can authenticate as (`auth.identity`), separate from the mission's own session — e.g. mint an invite as the owner, run the mission cold (repeatable) | `[]` |  |  |  |
| `--fixtures <file>` | mission fixtures JSON {setup:[...], restore:[...]} (#140/#144): HTTP steps to an --allow origin, authenticated from --storage-state/--secret-field, run before the mission and restored after it — and around every replay. Outputs bind as ${setup.<name>} |  |  |  |  |
| `--force` | overwrite an existing regression id's committed files (default: refused, #213) | `false` |  |  |  |
| `--from <file>` | path to the schema-valid failing Recording JSON to capture |  |  | yes |  |
| `--geolocation <lat,lng>` | place the browser at this position, e.g. --geolocation 41.6376,-70.9036 (optional third value: accuracy in metres); the geolocation permission is granted to the run's allowed origins only |  |  |  |  |
| `--headed` | show the browser window (demo mode); also JEVITATE_HEADED=1. Default: headless. Needs a display |  |  |  |  |
| `--hook-timeout-ms <ms>` | timeout for each --before/--after hook (default 60000; the process group is killed) |  |  |  |  |
| `--id <id>` | regression id (used for the committed <id>.recording.json/<id>.meta.json filenames) |  |  | yes |  |
| `--ignore-host-load` | start even when the host is starved (load >= 4/core or < 512 MiB free) instead of refusing with E_HOST_STARVED; the run is throttled and its result records it |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--max-browser-memory <MiB>` | memory ceiling of this run's browsers (browser + renderers); over it the run ends inconclusive with failure kind resource-limit (default: JEVITATE_MAX_BROWSER_MEMORY_MB, else 4096 or half the RAM) |  |  |  |  |
| `--max-browsers <n>` | machine-wide cap on jevitate runs with a browser open at once, shared by every jevitate on this machine (default: JEVITATE_MAX_BROWSERS, else cores/4 within 2..6; halved while the host is loaded) |  |  |  |  |
| `--param <kv>` | #293: a Journey param as key=value (repeatable) for a failure found from a Journey branch point — every replay goes through the same prefix; a secret param (never persisted) must be given again | `{}` |  |  |  |
| `--result <file>` | mission result JSON (as written alongside --from by `jevitate explore`) — supplies a failure oracle when the Recording alone never fails on replay |  |  |  |  |
| `--slow-mo <ms>` | slow every browser operation by this many ms (default 250 with --headed, else 0) |  |  |  |  |
| `--storage-state <file>` | Playwright storageState JSON to open the reproduce/minimize browser sessions authenticated (#129); must exist |  |  |  |  |
| `--summary <text>` | optional human-readable bug summary recorded in the meta sidecar |  |  |  |  |
| `--viewport <WxH>` | emulate a viewport of this size, e.g. --viewport 375x812 (mutually exclusive with --device) |  |  |  |  |

### regression run

```
jevitate regression run [options] <id>
```

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `id` | the committed regression id (its <id>.recording.json/<id>.meta.json) | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--attempts <n>` | fresh-context replays for a declared-invariant oracle (default 3) |  |  |  |  |
| `--base-url <origin>` | run against this origin (an ad-hoc environment; with --env, replaces its baseUrl) |  |  |  |  |
| `--browser-arg <arg>` | extra Chromium switch (repeatable); extends the Linux defaults --no-sandbox --disable-dev-shm-usage | `[]` |  |  |  |
| `--browser-channel <name>` | Playwright browser channel to launch, e.g. chrome \| msedge |  |  |  |  |
| `--browser-executable <path>` | launch this Chromium binary instead of Playwright's pinned one |  |  |  |  |
| `--device <name>` | emulate a Playwright registered device by name, e.g. --device "iPhone 13" (viewport + scale + mobile/touch + UA; mutually exclusive with --viewport) |  |  |  |  |
| `--dir <path>` | regressions directory (default: the repo's .jevitate/regressions; outside a repo ~/.jevitate/regressions) |  |  |  |  |
| `--env <name>` | run against a named environment from the repo's .jevitate/environments.json (default: the Journey's recorded site) |  |  |  |  |
| `--extension <dir>` | load this unpacked browser extension (repeatable; a directory with manifest.json). Its chrome-extension://<id> pages are allowed and navigable, e.g. --url chrome-extension://<id>/sidepanel.html; headless uses Chromium's new headless | `[]` |  |  |  |
| `--geolocation <lat,lng>` | place the browser at this position, e.g. --geolocation 41.6376,-70.9036 (optional third value: accuracy in metres); the geolocation permission is granted to the run's allowed origins only |  |  |  |  |
| `--headed` | show the browser window (demo mode); also JEVITATE_HEADED=1. Default: headless. Needs a display |  |  |  |  |
| `--ignore-host-load` | start even when the host is starved (load >= 4/core or < 512 MiB free) instead of refusing with E_HOST_STARVED; the run is throttled and its result records it |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--max-browser-memory <MiB>` | memory ceiling of this run's browsers (browser + renderers); over it the run ends inconclusive with failure kind resource-limit (default: JEVITATE_MAX_BROWSER_MEMORY_MB, else 4096 or half the RAM) |  |  |  |  |
| `--max-browsers <n>` | machine-wide cap on jevitate runs with a browser open at once, shared by every jevitate on this machine (default: JEVITATE_MAX_BROWSERS, else cores/4 within 2..6; halved while the host is loaded) |  |  |  |  |
| `--param <kv>` | #293: a Journey param as key=value (repeatable) for a failure found from a Journey branch point — every replay goes through the same prefix; a secret param (never persisted) must be given again | `{}` |  |  |  |
| `--slow-mo <ms>` | slow every browser operation by this many ms (default 250 with --headed, else 0) |  |  |  |  |
| `--storage-state <file>` | Playwright storageState JSON to open the replay session authenticated (#129); must exist |  |  |  |  |
| `--tag <key=value>` | run metadata tag stored in the result, its envelope and the run index (repeatable; key [A-Za-z0-9_.-]; never a secret) | `[]` |  |  |  |
| `--viewport <WxH>` | emulate a viewport of this size, e.g. --viewport 375x812 (mutually exclusive with --device) |  |  |  |  |

## report

```
jevitate report [options]
```

one deduped defect list for a target across every mode and run (markdown + JSON envelope)

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--baseline <run|tag|last>` | add a diff section against a baseline: a run, a `baseline tag`, or `last` (the previous run per target+mode) |  |  |  |  |
| `--dir <dir>` | results dir to read (repeatable). Default: this project's runs — its .jevitate/logs plus every run recorded for it in ~/.jevitate/run-index.jsonl (including --out dirs); with --target, every .jevitate/logs dir (project and ~/.jevitate) and the 0.1.0 recordings/ux-reports dirs too | `[]` |  |  |  |
| `--json` | emit the JSON envelope instead of markdown |  |  |  |  |
| `--out <dir>` | also write report.md and report.json here |  |  |  |  |
| `--since <run|date>` | only runs that started at/after this ISO date or this run |  |  |  |  |
| `--tag <key=value>` | only runs carrying this tag (repeatable; every tag must match) | `[]` |  |  |  |
| `--target <origin|name>` | the target: an origin (or URL on it), a suite target name, or a registered mission target |  |  |  |  |

## site

```
jevitate site [command]
```

per-site policies for Journey runs: human-like pacing, throttles, run budgets and quiet hours

### site policy

```
jevitate site policy [command]
```

read or set a site's policy (the site is the Journey's origin, e.g. https://app.example.com)

#### site policy get

```
jevitate site policy get [options] <site>
```

print the policy for a site (an origin) and account

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `site` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--account <account>` | account id | `primary` |  |  |  |
| `--db <path>` | sqlite db path |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |

#### site policy rules

```
jevitate site policy rules [options]
```

#428: list the control safety rules every run applies — built-in heuristics (ids, what they match, their regex), operator patterns and hard boundaries — and whether --allow-control can waive each (only the soft 'may cost money' heuristic). A refusal names the rule id it matched

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--json` | emit a JSON envelope |  |  |  |  |

#### site policy set

```
jevitate site policy set [options] <site>
```

set the policy for a site (an origin): Journey runs there are paced, throttled, budgeted and kept out of quiet hours (journey run, source run, check, MCP run_journey); load run applies the pacing only

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `site` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--account <account>` | account id | `primary` |  |  |  |
| `--db <path>` | sqlite db path |  |  |  |  |
| `--file <path>` | path to a policy JSON file |  |  | yes |  |
| `--json` | emit a JSON envelope |  |  |  |  |

### site simulate

```
jevitate site simulate [options] <site>
```

estimate, offline, how long a planned step script takes under a site's pacing policy

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `site` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--account <account>` | account id | `primary` |  |  |  |
| `--db <path>` | sqlite db path |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--script <path>` | path to a planned-step script JSON file |  |  | yes |  |
| `--seed <n>` | deterministic RNG seed | `0` |  |  |  |

## source

```
jevitate source [command]
```

manage distributed Journey sources (git-backed collections of Journeys)

### source add

```
jevitate source add [options] <name> <gitUrl>
```

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `name` |  | yes |  |  |
| `gitUrl` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--accept-tou` | acknowledge the source's declared Terms of Use (required before its Journeys can run) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |

### source list

```
jevitate source list [options]
```

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--json` | emit a JSON envelope |  |  |  |  |

### source pull

```
jevitate source pull [options] <name>
```

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `name` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--json` | emit a JSON envelope |  |  |  |  |

### source remove

```
jevitate source remove [options] <name>
```

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `name` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--json` | emit a JSON envelope |  |  |  |  |

### source run

```
jevitate source run [options] <name> <journeyId>
```

run a Journey from a trusted remote source through the run-gate

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `name` |  | yes |  |  |
| `journeyId` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--browser-arg <arg>` | extra Chromium switch (repeatable); extends the Linux defaults --no-sandbox --disable-dev-shm-usage | `[]` |  |  |  |
| `--browser-channel <name>` | Playwright browser channel to launch, e.g. chrome \| msedge |  |  |  |  |
| `--browser-executable <path>` | launch this Chromium binary instead of Playwright's pinned one |  |  |  |  |
| `--device <name>` | emulate a Playwright registered device by name, e.g. --device "iPhone 13" (viewport + scale + mobile/touch + UA; mutually exclusive with --viewport) |  |  |  |  |
| `--extension <dir>` | load this unpacked browser extension (repeatable; a directory with manifest.json). Its chrome-extension://<id> pages are allowed and navigable, e.g. --url chrome-extension://<id>/sidepanel.html; headless uses Chromium's new headless | `[]` |  |  |  |
| `--geolocation <lat,lng>` | place the browser at this position, e.g. --geolocation 41.6376,-70.9036 (optional third value: accuracy in metres); the geolocation permission is granted to the run's allowed origins only |  |  |  |  |
| `--ignore-host-load` | start even when the host is starved (load >= 4/core or < 512 MiB free) instead of refusing with E_HOST_STARVED; the run is throttled and its result records it |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--max-browser-memory <MiB>` | memory ceiling of this run's browsers (browser + renderers); over it the run ends inconclusive with failure kind resource-limit (default: JEVITATE_MAX_BROWSER_MEMORY_MB, else 4096 or half the RAM) |  |  |  |  |
| `--max-browsers <n>` | machine-wide cap on jevitate runs with a browser open at once, shared by every jevitate on this machine (default: JEVITATE_MAX_BROWSERS, else cores/4 within 2..6; halved while the host is loaded) |  |  |  |  |
| `--param <kv>` | param as key=value (repeatable) | `{}` |  |  |  |
| `--storage-state <file>` | Playwright storageState JSON to start the session authenticated (#118: required when the journey declares metadata.requiresAuth); must exist |  |  |  |  |
| `--tag <key=value>` | run metadata tag stored in the result, its envelope and the run index (repeatable; key [A-Za-z0-9_.-]; never a secret) | `[]` |  |  |  |
| `--viewport <WxH>` | emulate a viewport of this size, e.g. --viewport 375x812 (mutually exclusive with --device) |  |  |  |  |

### source trust

```
jevitate source trust [options] <name> <journeyId>
```

explicitly trust one Journey in a source, bound to its current content hash

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `name` |  | yes |  |  |
| `journeyId` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--json` | emit a JSON envelope |  |  |  |  |

### source update

```
jevitate source update [options] <name>
```

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `name` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--json` | emit a JSON envelope |  |  |  |  |

## sweep

```
jevitate sweep [options]
```

run many explore missions — one per target in a targets file (.tsv or .json: id, url|route, persona, strategy, goal, tags, explore options) — with bounded concurrency, resumable, and write ONE sweep.result.json: per-target outcomes and depth, defects deduped by fingerprint across targets, environment causes grouped. Every run is tagged target=<id> plus the sweep's and the target's tags

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--allow-control <regex>` | exempt a control whose name matches from the soft 'may cost money' heuristic only (repeatable, #428) (forwarded to every mission, as explore's) | `[]` |  |  |  |
| `--allow-destructive` | let missions click session-ending, destructive and paid controls (a --deny pattern still holds) (forwarded to every mission, as explore's) |  |  |  |  |
| `--allow-log-cmd` | a --log-source cmd:<command> may run as a subprocess (forwarded to every mission, as explore's) |  |  |  |  |
| `--allow-writes` | let a find-out mission change the app (forwarded to every mission, as explore's) |  |  |  |  |
| `--base-url <url>` | resolve each target's route against this origin (wins over --env and the file's baseUrl; else JEVITATE_BASE_URL) |  |  |  |  |
| `--concurrency <n>` | runs at once (default 1, at most 16; the machine-wide browser cap still applies) |  |  |  |  |
| `--deny <pattern>` | a control no mission may click (repeatable) (forwarded to every mission, as explore's) | `[]` |  |  |  |
| `--env <name>` | resolve each target's route against this named environment's base URL (.jevitate/environments.json) |  |  |  |  |
| `--evidence-video` | per defect: a captioned repro clip and before/at screenshots (forwarded to every mission, as explore's) |  |  |  |  |
| `--fake-ai` | use deterministic fake gateways for every run (pipeline smoke only) |  |  |  |  |
| `--invariants <file>` | app-declared invariants JSON (repeatable) (forwarded to every mission, as explore's) | `[]` |  |  |  |
| `--jev-provider <provider>` | with --real: which key judgment (Jev) uses — typesafe (TYPESAFE_API_KEY) or openrouter (OPENROUTER_API_KEY, Jev through OpenRouter). Default: JEVITATE_JEV_PROVIDER, else the TypeSafe key when both are set |  |  |  |  |
| `--json` | emit the JSON envelope (default: a human summary) |  |  |  |  |
| `--log-correlation-header <name>` | another header carrying a correlation id (repeatable) (forwarded to every mission, as explore's) | `[]` |  |  |  |
| `--log-defect <level|/regex/>` | backend log lines matching this become a server-log defect (repeatable) (forwarded to every mission, as explore's) | `[]` |  |  |  |
| `--log-id-pattern </regex/>` | how a correlation id is written in log lines (repeatable) (forwarded to every mission, as explore's) | `[]` |  |  |  |
| `--log-ignore <regex|substring>` | known-noise backend log lines to exclude (repeatable) (forwarded to every mission, as explore's) | `[]` |  |  |  |
| `--log-quiet-ok <spec>` | compatibility only since 0.8.0 (#420): quiet sources are always healthy (repeatable) (forwarded to every mission, as explore's) | `[]` |  |  |  |
| `--log-scope <regex|substring>` | attribute only backend log lines matching this (repeatable) (forwarded to every mission, as explore's) | `[]` |  |  |  |
| `--log-source <spec>` | backend log source: file:<path> \| docker:<container> \| cmd:<command> (needs --allow-log-cmd) (repeatable) (forwarded to every mission, as explore's) | `[]` |  |  |  |
| `--log-triage` | record each mission's signal timeline and attach only the related lines to each defect (#313) (forwarded to every mission, as explore's) |  |  |  |  |
| `--out <dir>` | the sweep directory: <id>/ per target and sweep.result.json (default .jevitate/logs/<date>/sweep-<stamp>; required with --resume) |  |  |  |  |
| `--paid <pattern>` | an app control that costs money or credits (repeatable) (forwarded to every mission, as explore's) | `[]` |  |  |  |
| `--real` | use live Jev + OpenRouter gateways for every run (requires keys) |  |  |  |  |
| `--record-video [dir]` | record a video of each mission's browser context (forwarded to every mission, as explore's) |  |  |  |  |
| `--resume` | skip every target whose run already finished in --out (its run.envelope.json); re-run the rest | `false` |  |  |  |
| `--screenshots [mode|dir]` | masked screenshots + index.md: one per distinct screen (default), `steps` one per step; `screens:<dir>`/`steps:<dir>`/`<dir>` set the folder (default: next to the run's result); listed as screenshotPaths |  |  |  |  |
| `--server-log-drain-ms <ms>` | how long to keep tailing --log-source after a mission's last action (default 3000) (forwarded to every mission, as explore's) |  |  |  |  |
| `--stop-on-env-failure <k>` | stop starting runs when the first K runs ALL failed for environment/setup reasons (auth expired, target unreachable, crash, a run that could not start) |  |  |  |  |
| `--tag <key=value>` | run metadata tag stored in the result, its envelope and the run index (repeatable; key [A-Za-z0-9_.-]; never a secret) | `[]` |  |  |  |
| `--targets <file>` | the targets file (.tsv with a header row, or .json: an array or {baseUrl?, defaults?, targets}) |  |  | yes |  |

## ui

```
jevitate ui [options]
```

start the local HITL approval dashboard (loopback-only HTTP server)

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--inbox-dir <path>` | inbox store directory (default: ~/.jevitate/inbox — same dir `jevitate mcp` serves) |  |  |  |  |
| `--no-open` | do not open the dashboard URL in the default browser |  |  |  |  |
| `--port <n>` | explicit port (fails on conflict; default 4180, retries on conflict) |  |  |  |  |

## ux

```
jevitate ux [options] <recording>
```

offline UX review of a saved Recording — ranked, cited usability findings

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `recording` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--app-class <class>` | app class for calibration (required), e.g. consumer\|admin\|internal |  |  |  |  |
| `--evidence <file>` | a live usability run's evidence sidecar (screens as analyzed + run signals); default: <stem>.evidence.json next to the Recording — with it, offline review reproduces the live run's findings |  |  |  |  |
| `--fake-ai` | use deterministic fake gateways | `false` |  |  |  |
| `--jev-provider <provider>` | with --real: which key judgment (Jev) uses — typesafe (TYPESAFE_API_KEY) or openrouter (OPENROUTER_API_KEY, Jev through OpenRouter). Default: JEVITATE_JEV_PROVIDER, else the TypeSafe key when both are set |  |  |  |  |
| `--job <text>` | the job the flow pursues (improves relevance) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--max-findings-per-page <n>` | cap on UX findings per route/page, highest-confidence first; the rest are counted in report.suppressed as per-page-cap, never dropped silently; default JEVITATE_UX_MAX_FINDINGS_PER_PAGE, then ~/.jevitate/config.json ux.maxFindingsPerPage, then 5 |  |  |  |  |
| `--min-confidence <n>` | findings below this FINDING confidence (0..1, a finding's own violation/applicability/grounding score — NOT its quality-grade confidence, a separate independent-grader number shown as finding.quality.confidence) are suppressed and counted in report.suppressed; default JEVITATE_UX_MIN_CONFIDENCE, then ~/.jevitate/config.json ux.minConfidence, then 0.3 |  |  |  |  |
| `--out <dir>` | directory to write the UX report |  |  |  |  |
| `--persona <p>` | optional persona for calibration |  |  |  |  |
| `--polish` | polish each verified finding's recommendation with one generation call (opt-in; the default prose is built from templates) |  |  |  |  |
| `--product <file>` | product facts JSON (plans/prices, key journeys, each page's intended next step) the review checks screens against in code; default .jevitate/product.json in the project when present (docs/ux-findings.md) |  |  |  |  |
| `--real` | use live Jev gateways (requires keys) | `false` |  |  |  |
| `--result <file>` | mission result JSON (as written alongside the Recording by `jevitate explore`) — supplies blocked/disabled-target evidence the Recording alone cannot carry; default: <stem>.result.json, else <stem>.transcript.json, next to the Recording |  |  |  |  |
| `--show <labels>` | opt-in filter on the quality grade (comma list of actionable,relevant-minor,generic,wrong); others are suppressed and counted; default JEVITATE_UX_SHOW, then ~/.jevitate/config.json ux.show, then ALL grades — the grader is uncalibrated (#133), so by default every finding is shown with its grade |  |  |  |  |

## verify-fix

```
jevitate verify-fix [options] [fingerprint]
```

replay a defect's repro from a mission result (or the ledger); passes only if the defect signal is absent on every replay

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `fingerprint` | the defect/hang fingerprint to verify (same as --fingerprint) | no |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--action-deltas` | opt-in (#303): record what each replayed step changed and compare the defect step's delta with the one the Recording stored — a mismatch is evidence on each attempt (never the verdict) |  |  |  |  |
| `--after <cmd>` | operator shell hook run after the mission and every replay (needs --allow-shell-hooks) |  |  |  |  |
| `--allow-emulation-override` | replay at --viewport/--device even though it differs from the finding's recorded emulation (#149); default: refused (fails closed) |  |  |  |  |
| `--allow-log-cmd` | re-checking a server-log defect whose --log-source includes cmd:<command> needs this too (operator-declared only) | `false` |  |  |  |
| `--allow-shell-hooks` | opt in to running --before/--after (operator commands; never model-chosen) | `false` |  |  |  |
| `--before <cmd>` | operator shell hook run before the mission and every replay (needs --allow-shell-hooks); may print {vars, secret} |  |  |  |  |
| `--browser-arg <arg>` | extra Chromium switch (repeatable); extends the Linux defaults --no-sandbox --disable-dev-shm-usage | `[]` |  |  |  |
| `--browser-channel <name>` | Playwright browser channel to launch, e.g. chrome \| msedge |  |  |  |  |
| `--browser-executable <path>` | launch this Chromium binary instead of Playwright's pinned one |  |  |  |  |
| `--device <name>` | emulate a Playwright registered device by name, e.g. --device "iPhone 13" (viewport + scale + mobile/touch + UA; mutually exclusive with --viewport) |  |  |  |  |
| `--extension <dir>` | load this unpacked browser extension (repeatable; a directory with manifest.json). Its chrome-extension://<id> pages are allowed and navigable, e.g. --url chrome-extension://<id>/sidepanel.html; headless uses Chromium's new headless | `[]` |  |  |  |
| `--fingerprint <fp>` | the defect/hang fingerprint to verify |  |  |  |  |
| `--fixture-identity <name=storageState>` | #243: a named identity fixture steps can authenticate as (`auth.identity`), separate from the mission's own session — e.g. mint an invite as the owner, run the mission cold (repeatable) | `[]` |  |  |  |
| `--fixtures <file>` | mission fixtures JSON {setup:[...], restore:[...]} (#140/#144): HTTP steps to an --allow origin, authenticated from --storage-state/--secret-field, run before the mission and restored after it — and around every replay. Outputs bind as ${setup.<name>} |  |  |  |  |
| `--geolocation <lat,lng>` | place the browser at this position, e.g. --geolocation 41.6376,-70.9036 (optional third value: accuracy in metres); the geolocation permission is granted to the run's allowed origins only |  |  |  |  |
| `--hang-replay-writes` | let a hang's replay re-send a paid/destructive write the run sent (default: the verdict is inconclusive, never replayed) |  |  |  |  |
| `--headed` | show the browser window (demo mode); also JEVITATE_HEADED=1. Default: headless. Needs a display — else use --record-video |  |  |  |  |
| `--hook-timeout-ms <ms>` | timeout for each --before/--after hook (default 60000; the process group is killed) |  |  |  |  |
| `--ignore-host-load` | start even when the host is starved (load >= 4/core or < 512 MiB free) instead of refusing with E_HOST_STARVED; the run is throttled and its result records it |  |  |  |  |
| `--invariants <file>` | re-check a declared-invariant defect with these invariant files (repeatable) instead of the spec saved with the mission | `[]` |  |  |  |
| `--json` | emit the JSON envelope (default: a human summary) |  |  |  |  |
| `--max-browser-memory <MiB>` | memory ceiling of this run's browsers (browser + renderers); over it the run ends inconclusive with failure kind resource-limit (default: JEVITATE_MAX_BROWSER_MEMORY_MB, else 4096 or half the RAM) |  |  |  |  |
| `--max-browsers <n>` | machine-wide cap on jevitate runs with a browser open at once, shared by every jevitate on this machine (default: JEVITATE_MAX_BROWSERS, else cores/4 within 2..6; halved while the host is loaded) |  |  |  |  |
| `--param <kv>` | #293: a Journey param as key=value (repeatable) for a finding found from a Journey branch point — its replays go through the same prefix; a secret param (never persisted with the result) must be given again; redacted like --secret | `{}` |  |  |  |
| `--record-video [dir]` | record a video of each browser context (works headless too); default: next to the run's result; listed as videoPaths |  |  |  |  |
| `--regressions-dir <path>` | regressions directory whose ledger/ is searched when --result is omitted (default: .jevitate/regressions) |  |  |  |  |
| `--replays <n>` | fresh-context replays that confirm a fix (default 3) |  |  |  |  |
| `--result <path>` | the mission's <stem>.result.json (written next to its Recording); default: the fingerprint's ledger entry (#195) |  |  |  |  |
| `--screenshots [mode|dir]` | masked screenshots + index.md: one per distinct screen (default), `steps` one per step; `screens:<dir>`/`steps:<dir>`/`<dir>` set the folder (default: next to the run's result); listed as screenshotPaths |  |  |  |  |
| `--secret <value|env:VAR>` | REDACTION ONLY: a value kept out of the fixture log (repeatable), e.g. one a --before hook prints; env:VAR reads it from the environment | `[]` |  |  |  |
| `--slow-mo <ms>` | slow every browser operation by this many ms (default 250 with --headed, else 0) |  |  |  |  |
| `--storage-state <file>` | override the storageState the mission ran with |  |  |  |  |
| `--tag <key=value>` | run metadata tag stored in the result, its envelope and the run index (repeatable; key [A-Za-z0-9_.-]; never a secret) | `[]` |  |  |  |
| `--viewport <WxH>` | emulate a viewport of this size, e.g. --viewport 375x812 (mutually exclusive with --device) |  |  |  |  |
