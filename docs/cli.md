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
- [`check`](#check): CI regression gate: run a suite of Journeys, invariants, goals and missions within a budget; JUnit + SARIF + JSON
- [`demo`](#demo): demo one aspect of an app from a one-line request: explore → clean path → Journey → annotate → a DRAFT narrated demo; `demo approve <id>` promotes and renders the final one
- [`diff`](#diff): classify findings new / resolved / still-present / flaky / not-rerun between two runs (runA = baseline)
- [`explore`](#explore): goal-directed exploration -> a deterministic Recording (authoring/test plane)
- [`explore-author-journey`](#explore-author-journey): Jev-driving authors a promotable Journey (authoring plane); never auto-promoted
- [`inbox`](#inbox): the HITL inbox from the CLI — the same tools `jevitate mcp` serves (approve/cancel stay human-only in `jevitate ui`)
- [`init`](#init): set up jevitate: collect API keys, install skills/MCP wiring, create the repo's .jevitate/
- [`invariants`](#invariants): declared-invariant files (`explore --invariants`)
- [`journey`](#journey): manage and run promoted Journeys (regression-test replays)
- [`ledger`](#ledger): keep each finding's repro material by fingerprint, so verify-fix works long after the run's output is gone
- [`load`](#load): run a promoted Journey as a load test
- [`logs`](#logs): run output under .jevitate/logs (dated; pruned by retention)
- [`mcp`](#mcp): start an MCP stdio server exposing only the allowlisted Jevitate tools
- [`mission`](#mission): manage exploration mission targets and drain the mission queue
- [`profile`](#profile): manage jevitate profiles (isolated credential/data sets)
- [`record`](#record): record a demonstrated flow into a Recording (authoring plane)
- [`recording`](#recording): inspect and edit recorded takes (promote, edit steps, diff, postdoc)
- [`regression`](#regression): capture, run and manage regression tests from discovered failures
- [`report`](#report): one deduped defect list for a target across every mode and run (markdown + JSON envelope)
- [`site`](#site): per-site policies for Journey runs: human-like pacing, throttles, run budgets and quiet hours
- [`source`](#source): manage distributed Journey sources (git-backed collections of Journeys)
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

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `feature` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--json` | emit a JSON envelope |  |  |  |  |

### ai status

```
jevitate ai status [options]
```

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--json` | emit a JSON envelope |  |  |  |  |

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

## check

```
jevitate check [options]
```

CI regression gate: run a suite of Journeys, invariants, goals and missions within a budget; JUnit + SARIF + JSON

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--baseline <run|tag|last>` | only findings NOT in this baseline gate (a run, a `baseline tag`, or `last`) |  |  |  |  |
| `--baseline-dir <dir>` | results dir holding baseline runs (repeatable; default: this check's results, then ~/.jevitate) | `[]` |  |  |  |
| `--browser-arg <arg>` | extra Chromium switch (repeatable); extends the Linux defaults --no-sandbox --disable-dev-shm-usage | `[]` |  |  |  |
| `--browser-channel <name>` | Playwright browser channel to launch, e.g. chrome \| msedge |  |  |  |  |
| `--browser-executable <path>` | launch this Chromium binary instead of Playwright's pinned one |  |  |  |  |
| `--changed-routes <globs>` | only run Journeys and goals touching these route globs (comma list, repeatable), e.g. '/settings/**' | `[]` |  |  |  |
| `--fake-ai` | use deterministic fake gateways (pipeline smoke only) | `false` |  |  |  |
| `--json` | emit the JSON envelope (default: a one-line summary per item, then the envelope path) |  |  |  |  |
| `--json-out <path>` | JSON envelope path (default <out>/check.json) |  |  |  |  |
| `--junit <path>` | JUnit XML path (default <out>/junit.xml) |  |  |  |  |
| `--out <dir>` | output dir: results/, junit.xml, jevitate.sarif, report.md, check.json | `jevitate-check` |  |  |  |
| `--real` | use live Jev + OpenRouter gateways for goals and model-driven missions (requires keys) | `false` |  |  |  |
| `--sarif <path>` | SARIF path (default <out>/jevitate.sarif) |  |  |  |  |
| `--suite <file>` | the suite JSON (targets, promoted Journeys, invariant files, goals, missions, budget) |  |  | yes |  |
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
| `--after <cmd>` | operator shell hook run after the mission and every replay (needs --allow-shell-hooks) |  |  |  |  |
| `--allow-shell-hooks` | opt in to running --before/--after (operator commands; never model-chosen) | `false` |  |  |  |
| `--before <cmd>` | operator shell hook run before the mission and every replay (needs --allow-shell-hooks); may print {vars, secret} |  |  |  |  |
| `--browser-arg <arg>` | extra Chromium switch (repeatable); extends the Linux defaults --no-sandbox --disable-dev-shm-usage | `[]` |  |  |  |
| `--browser-channel <name>` | Playwright browser channel to launch, e.g. chrome \| msedge |  |  |  |  |
| `--browser-executable <path>` | launch this Chromium binary instead of Playwright's pinned one |  |  |  |  |
| `--device <name>` | emulate a Playwright registered device by name, e.g. --device "iPhone 13" (viewport + scale + mobile/touch + UA; mutually exclusive with --viewport) |  |  |  |  |
| `--dir <path>` | journeys directory (default: ~/.jevitate/journeys) |  |  |  |  |
| `--fixtures <file>` | mission fixtures JSON {setup:[...], restore:[...]} (#140/#144): HTTP steps to an --allow origin, authenticated from --storage-state/--secret-field, run before the mission and restored after it — and around every replay. Outputs bind as ${setup.<name>} |  |  |  |  |
| `--headed` | show the browser window (demo mode); also JEVITATE_HEADED=1. Default: headless. Needs a display |  |  |  |  |
| `--hook-timeout-ms <ms>` | timeout for each --before/--after hook (default 60000; the process group is killed) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--out <dir>` | write the demo (demo.webm + demo.vtt + guide.md with guide.assets/) into this folder (default: a fresh folder in the logs dir) |  |  |  |  |
| `--pace <ms>` | how long each step's caption shows before it acts (default 1500) |  |  |  |  |
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
| `--dir <path>` | journeys directory (default: ~/.jevitate/journeys) |  |  |  |  |
| `--env <name>` | the named environment to demo on (.jevitate/environments.json); required, and never one flagged production: true |  |  |  |  |
| `--fake-ai` | use deterministic fake gateways (pipeline smoke only) | `false` |  |  |  |
| `--fixtures <file>` | mission fixtures JSON {setup:[...], restore:[...]} (#140/#144): HTTP steps to an --allow origin, authenticated from --storage-state/--secret-field, run before the mission and restored after it — and around every replay. Outputs bind as ${setup.<name>} |  |  |  |  |
| `--headed` | show the browser window (demo mode); also JEVITATE_HEADED=1. Default: headless. Needs a display |  |  |  |  |
| `--hook-timeout-ms <ms>` | timeout for each --before/--after hook (default 60000; the process group is killed) |  |  |  |  |
| `--id <id>` | the Journey id (default: demo-<aspect slug>) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--max-actions <n>` | hard cap on explored actions |  |  |  |  |
| `--max-decisions <n>` | hard cap on model decisions |  |  |  |  |
| `--out <dir>` | write the demo (demo.webm + demo.vtt + guide.md with guide.assets/) into this folder (default: a fresh folder in the logs dir) |  |  |  |  |
| `--pace <ms>` | how long each step's caption shows before it acts (default 1500) |  |  |  |  |
| `--persona <name>` | the persona whose session (~/.jevitate/targets.json personas) the demo runs as |  |  |  |  |
| `--real` | use live Jev + OpenRouter gateways (requires keys) | `false` |  |  |  |
| `--slow-mo <ms>` | slow every browser operation by this many ms (default 250 with --headed, else 0) |  |  |  |  |
| `--start <path>` | the app path exploration starts from (default /) |  |  |  |  |
| `--storage-state <file>` | Playwright storageState JSON to start authenticated (default: the environment's session in ~/.jevitate/targets.json); must exist |  |  |  |  |
| `--success <spec>` | independent success check that proves the aspect was shown, e.g. textIncludes:testId=status\|Saved (required) |  |  |  |  |
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

## explore

```
jevitate explore [options]
```

goal-directed exploration -> a deterministic Recording (authoring/test plane)

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--actor <name=storageState>` | multi-actor mission (#147, goal only; repeatable): the FIRST actor is the primary (the only one the model drives, from its own storageState); every other actor is an observer in its OWN fresh context that only runs the --invariants' cross-actor checks (capture + probe as:/deniedAs) — never clicks or types. Replaces --storage-state | `[]` |  |  |  |
| `--after <cmd>` | operator shell hook run after the mission and every replay (needs --allow-shell-hooks) |  |  |  |  |
| `--allow <origin>` | authorized origin (repeatable); REPLACES the default allowlist when given (the URL's own origin is used only when --allow is omitted entirely) -- include the URL's own origin explicitly if you still need it | `[]` |  |  |  |
| `--allow-destructive` | let missions click session-ending, destructive and paid controls (a --deny pattern still holds). A goal run already may click one its goal asks for |  |  |  |  |
| `--allow-log-cmd` | opt-in: a --log-source cmd:<command> may run as a subprocess (operator-declared only; refused otherwise) | `false` |  |  |  |
| `--allow-shell-hooks` | opt in to running --before/--after (operator commands; never model-chosen) | `false` |  |  |  |
| `--allow-vacuous-checks` | downgrade a vacuous --success check to a warning. By default a check satisfied before the run's first action — a page check that held on the seed page and never changed (an empty result container), a requestMade/responseStatus matched only by a page-load or polling request — FAILS: it cannot verify the goal |  |  |  |  |
| `--allow-write <glob>` | a write-request path a read-only find-out goal never blocks (repeatable; ** spans segments; a glob starting with https:// matches origin + path, e.g. https://abc.supabase.co/rest/v1/**), beyond the built-in auth-refresh ones (**/refresh*, **/token*, **/oauth/**, **/auth/**/refresh*). The app's background writes outside an action always pass | `[]` |  |  |  |
| `--allow-writes` | let a find-out goal (no --success check, ended by report) change the app. By default it is read-only: controls that start a write flow (checkout, upgrade, create, save, submit…) are refused and the write requests an action fires are blocked, unless the goal itself asks for a change |  |  |  |  |
| `--api-prefix <path>` | a path prefix whose requests are the app's API in the timing summary (repeatable), e.g. /api/ | `[]` |  |  |  |
| `--app-class <class>` | app class for UX calibration (required for --strategy usability), e.g. consumer\|admin\|internal |  |  |  |  |
| `--before <cmd>` | operator shell hook run before the mission and every replay (needs --allow-shell-hooks); may print {vars, secret} |  |  |  |  |
| `--browser-arg <arg>` | extra Chromium switch (repeatable); extends the Linux defaults --no-sandbox --disable-dev-shm-usage | `[]` |  |  |  |
| `--browser-channel <name>` | Playwright browser channel to launch, e.g. chrome \| msedge |  |  |  |  |
| `--browser-executable <path>` | launch this Chromium binary instead of Playwright's pinned one |  |  |  |  |
| `--check-overflow` | check the horizontal-overflow hard signal (#149) even at a desktop (>=1024px) viewport — --strategy coverage/exploratory (a defect), adversarial (a defect) or usability (a signal finding). On by default whenever --viewport/--device emulates a viewport narrower than 1024px |  |  |  |  |
| `--deny <pattern>` | a control no mission may click (repeatable): an accessible-name regex (/Archive/i or Archive) or a descriptor role=button;name=Archive. Session-ending (Sign out), destructive (Delete, Revoke, Rotate) and paid (Buy, Run simulation, Generate, Send invite) controls are refused by default | `[]` |  |  |  |
| `--device <name>` | emulate a Playwright registered device by name, e.g. --device "iPhone 13" (viewport + scale + mobile/touch + UA; mutually exclusive with --viewport) |  |  |  |  |
| `--evidence-video` | per defect: replay its minimal repro with captions + the failing step marked, record a masked clip and before/at screenshots (defects[].evidence; linked from drafts) |  |  |  |  |
| `--fake-ai` | use deterministic fake gateways (pipeline smoke only) | `false` |  |  |  |
| `--feature <name>` | run the capability-scoped feature-testing mission (instead of --goal/--success) |  |  |  |  |
| `--file-issues` | file findings as issues (needs a repo: --issue-repo or ~/.jevitate/filing.json); default: drafts only |  |  |  |  |
| `--fixture <path>` | local file the upload op attaches to a file input (goal and usability strategies); must exist |  |  |  |  |
| `--fixtures <file>` | mission fixtures JSON {setup:[...], restore:[...]} (#140/#144): HTTP steps to an --allow origin, authenticated from --storage-state/--secret-field, run before the mission and restored after it — and around every replay. Outputs bind as ${setup.<name>} |  |  |  |  |
| `--goal <text>` | natural-language goal / job (required for --strategy goal and usability) |  |  |  |  |
| `--hang-replay-writes` | let hang replays re-send a paid/destructive write the run sent (default: such a hang is reported inconclusive, never replayed) |  |  |  |  |
| `--hang-replays <n>` | fresh-context replays that confirm a hang (default 2; 0 = don't replay, the hang is reported unconfirmed) |  |  |  |  |
| `--headed` | show the browser window (demo mode); also JEVITATE_HEADED=1. Default: headless. Needs a display — else use --record-video |  |  |  |  |
| `--hook-timeout-ms <ms>` | timeout for each --before/--after hook (default 60000; the process group is killed) |  |  |  |  |
| `--ignore-no-progress <pattern>` | a route / action label / busy indicator where ui-no-progress is expected (repeatable, * wildcard) | `[]` |  |  |  |
| `--ignore-overflow <selector>` | a CSS selector (repeatable) whose overflow is intentional — excluded from the horizontal-overflow signal, like --ignore-no-progress | `[]` |  |  |  |
| `--invariants <file>` | app-declared invariants JSON (repeatable; goal, coverage, exploratory, adversarial, --feature): checked around every action, a violation is a defect (exit 1). Validated before any browser opens; probes are GET/HEAD on an --allow origin only | `[]` |  |  |  |
| `--issue-repo <owner/name>` | the system-under-test repo findings for THIS target are filed to |  |  |  |  |
| `--jevitate-repo <owner/name>` | where jevitate engine findings are filed (default matt-cochran/jevitate) |  |  |  |  |
| `--job-wait-ms <ms>` | goal and usability: while the page shows an in-progress status ("Simulating…", aria-busy, a job "is running"), waits keep waiting with backoff — and a model 'blocked' is deferred — up to this budget (default: --reply-ceiling-ms, 180000) |  |  |  |  |
| `--json` | emit the JSON envelope (default: a human summary) |  |  |  |  |
| `--log-defect <level|/regex/>` | backend log lines matching this (repeatable) become a server-log defect: a level (error\|warn\|info\|debug, matched as level>=this) or a /regex/flags/ over the raw line. Its fingerprint is the normalized message (ids/numbers/uuids/timestamps stripped) plus the correlated route; verify-fix re-checks it by re-tailing the same --log-source(s) | `[]` |  |  |  |
| `--log-ignore <regex|substring>` | excludes known-noise backend log lines (repeatable, /regex/flags/ over the raw line or a plain substring) from BOTH correlation and the --log-defect oracle (#169 item 3) — e.g. a periodic background job's own expected error. Counted separately as serverLogs.ignoredLines; never makes --log-quiet-ok unnecessary, since an ignored line still proves the source is being tailed | `[]` |  |  |  |
| `--log-quiet-ok <spec>` | declares a --log-source spec (exact match, repeatable) as legitimately quiet: zero lines from it does not make the --log-defect oracle unhealthy (#169). Without it, a declared source that opened but delivered not one line makes an otherwise-clean run inconclusive, same as one that failed to open | `[]` |  |  |  |
| `--log-source <spec>` | backend log source (repeatable; every strategy, incl. usability): file:<path> (tailed from its current end) \| docker:<container> (docker logs -f --since 0s) \| cmd:<command> (needs --allow-log-cmd). Read-only, operator-declared, never the model's choice. Error/warning lines are correlated to the step they landed during and attached to its transcript evidence, redacted | `[]` |  |  |  |
| `--long-poll-ms <n>` | a request pending this long on an interactive page is a long-poll (default 5000) |  |  |  |  |
| `--max-actions <n>` | hard cap on executed actions |  |  |  |  |
| `--max-decisions <n>` | hard cap on model decisions |  |  |  |  |
| `--max-findings-per-page <n>` | (--strategy usability) cap on UX findings per route/page, highest-confidence first; the rest are counted in report.suppressed as per-page-cap, never dropped silently; default JEVITATE_UX_MAX_FINDINGS_PER_PAGE, then ~/.jevitate/config.json ux.maxFindingsPerPage, then 5 |  |  |  |  |
| `--min-agreement <k>` | with --repeat: runs a finding (and the outcome) must recur in to count (default: a majority of N) |  |  |  |  |
| `--min-confidence <n>` | (--strategy usability) findings below this FINDING confidence (0..1, a finding's own violation/applicability/grounding score — NOT its quality-grade confidence, a separate independent-grader number shown as finding.quality.confidence) are suppressed and counted in report.suppressed; default JEVITATE_UX_MIN_CONFIDENCE, then ~/.jevitate/config.json ux.minConfidence, then 0.3 |  |  |  |  |
| `--min-control-coverage <ratio>` | adversarial: share of the target's controls (0..1) a run must exercise before 'found nothing' is clean (default 0.25); below it the run is inconclusive |  |  |  |  |
| `--no-overlay` | with --headed: hide the on-page overlay (step, intent, target highlight, outcome banner) |  |  |  |  |
| `--no-require-form-submit` | adversarial: do not require a submitted form for a clean result (default: required when the target has a form) |  |  |  |  |
| `--out <dir>` | directory to write the emitted Recording |  |  |  |  |
| `--paid <pattern>` | an app control that costs money or credits (repeatable; same syntax as --deny), e.g. /^(Analyze\|Draft\|Improve)\b/i: treated like the built-in paid vocabulary — the budget guard sees it, hang replays never repeat it, and a goal that asks for it may still click it | `[]` |  |  |  |
| `--persona <name=storageState>` | run the same mission once per persona (repeatable), serially, each from its own storageState, and diff them (#143): requests, statuses (a 403 vs 200 is a candidate RBAC finding), controls, outcome | `[]` |  |  |  |
| `--personas <file>` | personas JSON: {"<name>": "<storageState>"} or {"personas": [{"name", "storageState"}]} |  |  |  |  |
| `--read-rpc <glob>` | a POST request that only READS (repeatable): an RPC-method glob (Estimate*, pkg.Service/Preview*) or a path glob (/api/search*). gRPC-web/Connect Get*/List*/Search*/Find*/Watch*/Stream*/Count*/Describe*/Read* methods are reads already. Reads are never guarded or reported as duplicate writes | `[]` |  |  |  |
| `--real` | use live Jev + OpenRouter gateways (requires keys) | `false` |  |  |  |
| `--record-video [dir]` | record a video of each browser context (works headless too); default: next to the run's result; listed as videoPaths |  |  |  |  |
| `--repeat <n>` | run the mission N times, one after another, each in a fresh browser context, and vote (#141): findings seen in fewer than --min-agreement runs are reported as flaky, not counted |  |  |  |  |
| `--reply-ceiling-ms <ms>` | conversational pages: hard ceiling on one reply wait, however busy the page stays (default 180000; never below --reply-wait-ms) |  |  |  |  |
| `--reply-max-chars <n>` | conversational pages: cap on each generated chat message (goal and usability; default 300) |  |  |  |  |
| `--reply-wait-ms <ms>` | conversational pages: how long to keep waiting for a reply while the page shows no sign of working on one (goal and usability; default 60000). While a request the message started is in flight, a busy indicator shows, or the reply is still growing, the wait continues up to --reply-ceiling-ms |  |  |  |  |
| `--route <glob>` | in-scope route glob (repeatable), e.g. /thread/** — for --feature it replaces the default scope (the start URL's route and everything under it); it widens --strategy adversarial/coverage/exploratory beyond the start URL's route | `[]` |  |  |  |
| `--save-storage-state <file>` | write the context's storageState (cookies + origin storage) here when the run ends; mode 0600, contents never logged. Useful with a rotating refresh token: --storage-state's file goes stale after one authenticated run refreshes it, so point --save-storage-state at the SAME file (or a new one) to keep it usable for the next run. Written on every exit path -- a crash or a SIGTERM/SIGINT kill included (#159), not only a clean end -- but never over a good file with a session that already looks lost/logged-out; the last known-good state is used instead, or nothing is written if none was ever captured. |  |  |  |  |
| `--scope <mode>` | --strategy coverage/exploratory: 'app' widens containment to the whole app (same as --route '/**'); default: the start URL's route plus --route globs |  |  |  |  |
| `--screenshots [mode|dir]` | masked screenshots + index.md: one per distinct screen (default), `steps` one per step; `screens:<dir>`/`steps:<dir>`/`<dir>` set the folder (default: next to the run's result); listed as screenshotPaths |  |  |  |  |
| `--secret <value|env:VAR>` | REDACTION ONLY: a secret/PII value kept out of every model call and artifact (repeatable); env:VAR reads it from the environment (preferred: a literal is visible in the process list and shell history). It is never typed into a field — to log in, bind it with --secret-field (or start from --storage-state) | `[]` |  |  |  |
| `--secret-field <binding>` | goal/usability strategy: '<label\|testId\|type\|id\|name>=<value>=env:<VAR>' (repeatable), e.g. 'label=Password=env:APP_PASSWORD'. When the run types into a matching field, code types $VAR itself; the model sees only «secret:VAR» and the Recording {redacted:true} | `[]` |  |  |  |
| `--server-log-drain-ms <ms>` | how long to keep tailing --log-source after the run's last action, to catch async backend work that settles after the browser gave up (default 3000) |  |  |  |  |
| `--settle-ignore <pattern>` | a request URL pattern the target marks as background (never pending work; repeatable, * wildcard) | `[]` |  |  |  |
| `--show <labels>` | opt-in filter on the quality grade (comma list of actionable,relevant-minor,generic,wrong); others are suppressed and counted; default JEVITATE_UX_SHOW, then ~/.jevitate/config.json ux.show, then ALL grades — the grader is uncalibrated (#133), so by default every finding is shown with its grade |  |  |  |  |
| `--slow-mo <ms>` | slow every browser operation by this many ms (default 250 with --headed, else 0) |  |  |  |  |
| `--stall-timeout <seconds>` | --strategy coverage/exploratory and --feature: end the run inconclusive (stalled) when no step completes within this many seconds (default 120) |  |  |  |  |
| `--storage-state <file>` | Playwright storageState JSON to start the session authenticated (deterministic login pre-step); must exist |  |  |  |  |
| `--strategy <name>` | exploration strategy: goal (default) \| coverage \| exploratory \| adversarial \| usability (UX review: ranked, cited findings) | `goal` |  |  |  |
| `--success <spec>` | independent success check (repeatable; every one must hold; --strategy goal and usability). Kinds: urlIncludes:<text> \| visible:<d> \| textIncludes:<d>\|<text> (case-insensitive) \| count:<d>\|min=<n>,max=<n> \| valueEquals:<d>\|<value> (a form control's value) \| reloadThen:<check> (reload first: proves it persisted) \| visual state (#148, read and decided by code): style:<d>\|<prop><op><value> (computed style of every match; <prop> an allowlisted CSS property or a channel of one, e.g. alpha(background-color)>0, color=rgb(255, 0, 0); op = != > >= < <=) \| inViewport:<d>[\|min=<ratio>] (visible fraction, default 0.5) \| box:<d>\|minWidth=<n>,maxWidth=<n>,minHeight=<n>,maxHeight=<n> \| overlaps:<d>\|<d2> \| noOverlap:<d>\|<d2> \| attr:<d>\|<name>=<value> (or <name> present, !<name> absent) \| flashed:<d>\|class=<cls> (or attr=<name>, animation)[\|withinMs=<n>] (a transient state gained after the last user input) \| requestMade:<METHOD> <path-glob> \| responseStatus:<METHOD> <path-glob>=<2xx\|4xx\|code>. <d> is testId=..;role=..;name=..;label=..;text=..;css=.. or a CSS selector such as [data-testid=x]. <path-glob> must start with "/" (it matches the request's path, e.g. /api/profile/* or /api/**); * as METHOD matches any method. e.g. --success 'requestMade:PUT /api/profile' --success 'reloadThen:valueEquals:[data-testid=last-name]\|Litmus'. Omit it for a find-out goal (e.g. "find out how many contacts... report the answer"): the run must then end with the model's own `report` op, and the grounded answer (#101) is the verdict — no page/network check needed. | `[]` |  |  |  |
| `--success-when <when>` | when the --success page checks must hold: final (default; on the final page) \| held (on the final page, or all together at any settled step — a one-time secret, a toast). reloadThen is always final |  |  |  |  |
| `--totp <binding>` | goal/usability strategy: '<descriptor>=env:<VAR>' with $VAR a base32 TOTP seed (repeatable), e.g. 'label=Authentication code=env:APP_TOTP_SEED'. The 6-digit code is computed locally (RFC 6238) when the field is typed; the seed never reaches a model or disk | `[]` |  |  |  |
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
| `--allow <origin>` | authorized origin (repeatable); REPLACES the default allowlist when given (the URL's own origin is used only when --allow is omitted entirely) -- include the URL's own origin explicitly if you still need it | `[]` |  |  |  |
| `--browser-arg <arg>` | extra Chromium switch (repeatable); extends the Linux defaults --no-sandbox --disable-dev-shm-usage | `[]` |  |  |  |
| `--browser-channel <name>` | Playwright browser channel to launch, e.g. chrome \| msedge |  |  |  |  |
| `--browser-executable <path>` | launch this Chromium binary instead of Playwright's pinned one |  |  |  |  |
| `--fake-ai` | use deterministic fake gateways (pipeline smoke only) | `false` |  |  |  |
| `--goal <text>` | natural-language goal |  |  |  |  |
| `--id <id>` | journey id (used for the <id>.json filename in the store) |  |  |  |  |
| `--journeys-dir <dir>` | journeys store directory (default: ~/.jevitate/journeys) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--max-actions <n>` | hard cap on executed actions |  |  |  |  |
| `--max-decisions <n>` | hard cap on model decisions |  |  |  |  |
| `--name <name>` | human-readable journey name |  |  |  |  |
| `--real` | use live Jev + OpenRouter gateways (requires keys) | `false` |  |  |  |
| `--storage-state <file>` | Playwright storageState JSON to start the session authenticated (deterministic login pre-step); must exist |  |  |  |  |
| `--success <spec>` | independent success assertion, e.g. urlIncludes:/confirmed |  |  |  |  |
| `--takes <n>` | corroborating takes incl. discovery (default 1) | `1` |  |  |  |
| `--url <url>` | target URL (must be an authorized origin) |  |  |  |  |

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
| `--dry-run` | report planned skill-install/mcp-register actions without writing |  |  |  |  |
| `--force` | overwrite a user-modified installed skill file/block or MCP config entry |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--skip-keys` | skip credential collection |  |  |  |  |
| `--skip-mcp` | skip registering the jevitate MCP server in detected harnesses |  |  |  |  |
| `--skip-project` | skip creating the repo's .jevitate/ (journeys, regressions, baselines, logs) |  |  |  |  |
| `--skip-skills` | skip skill installation |  |  |  |  |
| `--targets <ids>` | comma-separated runtime ids to force-install to, overriding detection |  |  |  |  |

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

## journey

```
jevitate journey [command]
```

manage and run promoted Journeys (regression-test replays)

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
| `--after <cmd>` | operator shell hook run after the mission and every replay (needs --allow-shell-hooks) |  |  |  |  |
| `--allow-shell-hooks` | opt in to running --before/--after (operator commands; never model-chosen) | `false` |  |  |  |
| `--approve` | apply the reviewed draft to the Journey (shows the diff; refused if the Journey changed since the draft) | `false` |  |  |  |
| `--base-url <origin>` | run against this origin (an ad-hoc environment; with --env, replaces its baseUrl) |  |  |  |  |
| `--before <cmd>` | operator shell hook run before the mission and every replay (needs --allow-shell-hooks); may print {vars, secret} |  |  |  |  |
| `--browser-arg <arg>` | extra Chromium switch (repeatable); extends the Linux defaults --no-sandbox --disable-dev-shm-usage | `[]` |  |  |  |
| `--browser-channel <name>` | Playwright browser channel to launch, e.g. chrome \| msedge |  |  |  |  |
| `--browser-executable <path>` | launch this Chromium binary instead of Playwright's pinned one |  |  |  |  |
| `--device <name>` | emulate a Playwright registered device by name, e.g. --device "iPhone 13" (viewport + scale + mobile/touch + UA; mutually exclusive with --viewport) |  |  |  |  |
| `--dir <path>` | journeys directory (default: ~/.jevitate/journeys) |  |  |  |  |
| `--env <name>` | run against a named environment from the repo's .jevitate/environments.json (default: the Journey's recorded site) |  |  |  |  |
| `--fake-ai` | draft with the deterministic fake generator (pipeline smoke only) | `false` |  |  |  |
| `--fixtures <file>` | mission fixtures JSON {setup:[...], restore:[...]} (#140/#144): HTTP steps to an --allow origin, authenticated from --storage-state/--secret-field, run before the mission and restored after it — and around every replay. Outputs bind as ${setup.<name>} |  |  |  |  |
| `--hook-timeout-ms <ms>` | timeout for each --before/--after hook (default 60000; the process group is killed) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
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
| `--after <cmd>` | operator shell hook run after the mission and every replay (needs --allow-shell-hooks) |  |  |  |  |
| `--allow-shell-hooks` | opt in to running --before/--after (operator commands; never model-chosen) | `false` |  |  |  |
| `--base-url <origin>` | run against this origin (an ad-hoc environment; with --env, replaces its baseUrl) |  |  |  |  |
| `--before <cmd>` | operator shell hook run before the mission and every replay (needs --allow-shell-hooks); may print {vars, secret} |  |  |  |  |
| `--browser-arg <arg>` | extra Chromium switch (repeatable); extends the Linux defaults --no-sandbox --disable-dev-shm-usage | `[]` |  |  |  |
| `--browser-channel <name>` | Playwright browser channel to launch, e.g. chrome \| msedge |  |  |  |  |
| `--browser-executable <path>` | launch this Chromium binary instead of Playwright's pinned one |  |  |  |  |
| `--device <name>` | emulate a Playwright registered device by name, e.g. --device "iPhone 13" (viewport + scale + mobile/touch + UA; mutually exclusive with --viewport) |  |  |  |  |
| `--dir <path>` | journeys directory (default: ~/.jevitate/journeys) |  |  |  |  |
| `--env <name>` | run against a named environment from the repo's .jevitate/environments.json (default: the Journey's recorded site) |  |  |  |  |
| `--fixtures <file>` | mission fixtures JSON {setup:[...], restore:[...]} (#140/#144): HTTP steps to an --allow origin, authenticated from --storage-state/--secret-field, run before the mission and restored after it — and around every replay. Outputs bind as ${setup.<name>} |  |  |  |  |
| `--guide <file>` | write a Markdown guide here (.md), screenshots in <name>.assets/ beside it |  |  |  |  |
| `--headed` | show the browser window (demo mode); also JEVITATE_HEADED=1. Default: headless. Needs a display |  |  |  |  |
| `--hook-timeout-ms <ms>` | timeout for each --before/--after hook (default 60000; the process group is killed) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
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
| `--dir <path>` | journeys directory (default: ~/.jevitate/journeys) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |

### journey list

```
jevitate journey list [options]
```

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--dir <path>` | journeys directory (default: ~/.jevitate/journeys) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |

### journey promote

```
jevitate journey promote [options] <id>
```

promote a local Journey (human-approval gate) so it becomes discoverable/runnable

**Arguments**

| Argument | Description | Required | Default | Choices |
| --- | --- | --- | --- | --- |
| `id` |  | yes |  |  |

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--dir <path>` | journeys directory (default: ~/.jevitate/journeys) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |

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
| `--dir <path>` | journeys directory (default: ~/.jevitate/journeys) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--to <source>` | registered source name to publish into |  |  | yes |  |

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
| `--after <cmd>` | operator shell hook run after the mission and every replay (needs --allow-shell-hooks) |  |  |  |  |
| `--allow-shell-hooks` | opt in to running --before/--after (operator commands; never model-chosen) | `false` |  |  |  |
| `--base-url <origin>` | run against this origin (an ad-hoc environment; with --env, replaces its baseUrl) |  |  |  |  |
| `--before <cmd>` | operator shell hook run before the mission and every replay (needs --allow-shell-hooks); may print {vars, secret} |  |  |  |  |
| `--browser-arg <arg>` | extra Chromium switch (repeatable); extends the Linux defaults --no-sandbox --disable-dev-shm-usage | `[]` |  |  |  |
| `--browser-channel <name>` | Playwright browser channel to launch, e.g. chrome \| msedge |  |  |  |  |
| `--browser-executable <path>` | launch this Chromium binary instead of Playwright's pinned one |  |  |  |  |
| `--device <name>` | emulate a Playwright registered device by name, e.g. --device "iPhone 13" (viewport + scale + mobile/touch + UA; mutually exclusive with --viewport) |  |  |  |  |
| `--dir <path>` | journeys directory (default: ~/.jevitate/journeys) |  |  |  |  |
| `--env <name>` | run against a named environment from the repo's .jevitate/environments.json (default: the Journey's recorded site) |  |  |  |  |
| `--fake-ai` | use deterministic fake gateways for self-heal (pipeline smoke only) | `false` |  |  |  |
| `--fixtures <file>` | mission fixtures JSON {setup:[...], restore:[...]} (#140/#144): HTTP steps to an --allow origin, authenticated from --storage-state/--secret-field, run before the mission and restored after it — and around every replay. Outputs bind as ${setup.<name>} |  |  |  |  |
| `--headed` | show the browser window (demo mode); also JEVITATE_HEADED=1. Default: headless. Needs a display — else use --record-video |  |  |  |  |
| `--hook-timeout-ms <ms>` | timeout for each --before/--after hook (default 60000; the process group is killed) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--param <kv>` | param as key=value (repeatable) | `{}` |  |  |  |
| `--real` | use live Jev + OpenRouter gateways for self-heal (requires keys) | `false` |  |  |  |
| `--record-video [dir]` | record a video of each browser context (works headless too); default: next to the run's result; listed as videoPaths |  |  |  |  |
| `--screenshots [mode|dir]` | masked screenshots + index.md: one per distinct screen (default), `steps` one per step; `screens:<dir>`/`steps:<dir>`/`<dir>` set the folder (default: next to the run's result); listed as screenshotPaths |  |  |  |  |
| `--self-heal <mode>` | self-heal policy mode: fail-closed \| hybrid \| full | `fail-closed` |  |  |  |
| `--slow-mo <ms>` | slow every browser operation by this many ms (default 250 with --headed, else 0) |  |  |  |  |
| `--storage-state <file>` | Playwright storageState JSON to start the session authenticated (#118: required when the journey declares metadata.requiresAuth); must exist |  |  |  |  |
| `--viewport <WxH>` | emulate a viewport of this size, e.g. --viewport 375x812 (mutually exclusive with --device) |  |  |  |  |

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
| `--json` | emit a JSON envelope (default: a human summary) |  |  |  |  |
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
| `--dir <path>` | journeys directory (default: ~/.jevitate/journeys) |  |  |  |  |
| `--env <name>` | run against a named environment from the repo's .jevitate/environments.json (default: the Journey's recorded site) |  |  |  |  |
| `--iterations <n>` | iterations per actor | `1` |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--param <kv>` | param as key=value (repeatable) | `{}` |  |  |  |
| `--seed <n>` | master RNG seed | `1` |  |  |  |
| `--storage-state <file>` | Playwright storageState JSON to start every actor's session authenticated (#118: required when the journey declares metadata.requiresAuth); must exist |  |  |  |  |
| `--viewport <WxH>` | emulate a viewport of this size, e.g. --viewport 375x812 (mutually exclusive with --device) |  |  |  |  |

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

## mcp

```
jevitate mcp [options]
```

start an MCP stdio server exposing only the allowlisted Jevitate tools

**Options**

| Flags | Description | Default | Choices | Required | Env |
| --- | --- | --- | --- | --- | --- |
| `--dir <path>` | journeys directory (default: ~/.jevitate/journeys) |  |  |  |  |
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
| `--fake-ai` | use deterministic fake gateways (pipeline smoke only) | `false` |  |  |  |
| `--interval <ms>` | --watch poll interval in ms (default 5000) | `5000` |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--once` | drain the missions queued now, then exit (default) |  |  |  |  |
| `--out <dir>` | where results are written (default: .jevitate/logs/<date> in the project, else ~/.jevitate/logs/<date> — where `jevitate mcp` reads them) |  |  |  |  |
| `--real` | use live Jev + OpenRouter gateways for model-driven missions (requires keys) | `false` |  |  |  |
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
| `--dir <path>` | regressions directory (default: ~/.jevitate/regressions) |  |  |  |  |
| `--fingerprint <fp>` | pin the required failure — a structural step signature (alone, restricts --from to failing at exactly that step), or (with --result, #119/#129) a defect/invariant fingerprint from the mission's own findings; with --result alone, cross-checks the derived oracle |  |  |  |  |
| `--fixtures <file>` | mission fixtures JSON {setup:[...], restore:[...]} (#140/#144): HTTP steps to an --allow origin, authenticated from --storage-state/--secret-field, run before the mission and restored after it — and around every replay. Outputs bind as ${setup.<name>} |  |  |  |  |
| `--force` | overwrite an existing regression id's committed files (default: refused, #213) | `false` |  |  |  |
| `--from <file>` | path to the schema-valid failing Recording JSON to capture |  |  | yes |  |
| `--headed` | show the browser window (demo mode); also JEVITATE_HEADED=1. Default: headless. Needs a display |  |  |  |  |
| `--hook-timeout-ms <ms>` | timeout for each --before/--after hook (default 60000; the process group is killed) |  |  |  |  |
| `--id <id>` | regression id (used for the committed <id>.recording.json/<id>.meta.json filenames) |  |  | yes |  |
| `--json` | emit a JSON envelope |  |  |  |  |
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
| `--dir <path>` | regressions directory (default: ~/.jevitate/regressions) |  |  |  |  |
| `--env <name>` | run against a named environment from the repo's .jevitate/environments.json (default: the Journey's recorded site) |  |  |  |  |
| `--headed` | show the browser window (demo mode); also JEVITATE_HEADED=1. Default: headless. Needs a display |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--slow-mo <ms>` | slow every browser operation by this many ms (default 250 with --headed, else 0) |  |  |  |  |
| `--storage-state <file>` | Playwright storageState JSON to open the replay session authenticated (#129); must exist |  |  |  |  |
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
| `--json` | emit a JSON envelope |  |  |  |  |
| `--param <kv>` | param as key=value (repeatable) | `{}` |  |  |  |
| `--storage-state <file>` | Playwright storageState JSON to start the session authenticated (#118: required when the journey declares metadata.requiresAuth); must exist |  |  |  |  |
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
| `--job <text>` | the job the flow pursues (improves relevance) |  |  |  |  |
| `--json` | emit a JSON envelope |  |  |  |  |
| `--max-findings-per-page <n>` | cap on UX findings per route/page, highest-confidence first; the rest are counted in report.suppressed as per-page-cap, never dropped silently; default JEVITATE_UX_MAX_FINDINGS_PER_PAGE, then ~/.jevitate/config.json ux.maxFindingsPerPage, then 5 |  |  |  |  |
| `--min-confidence <n>` | findings below this FINDING confidence (0..1, a finding's own violation/applicability/grounding score — NOT its quality-grade confidence, a separate independent-grader number shown as finding.quality.confidence) are suppressed and counted in report.suppressed; default JEVITATE_UX_MIN_CONFIDENCE, then ~/.jevitate/config.json ux.minConfidence, then 0.3 |  |  |  |  |
| `--out <dir>` | directory to write the UX report |  |  |  |  |
| `--persona <p>` | optional persona for calibration |  |  |  |  |
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
| `--after <cmd>` | operator shell hook run after the mission and every replay (needs --allow-shell-hooks) |  |  |  |  |
| `--allow-emulation-override` | replay at --viewport/--device even though it differs from the finding's recorded emulation (#149); default: refused (fails closed) |  |  |  |  |
| `--allow-log-cmd` | re-checking a server-log defect whose --log-source includes cmd:<command> needs this too (operator-declared only) | `false` |  |  |  |
| `--allow-shell-hooks` | opt in to running --before/--after (operator commands; never model-chosen) | `false` |  |  |  |
| `--before <cmd>` | operator shell hook run before the mission and every replay (needs --allow-shell-hooks); may print {vars, secret} |  |  |  |  |
| `--browser-arg <arg>` | extra Chromium switch (repeatable); extends the Linux defaults --no-sandbox --disable-dev-shm-usage | `[]` |  |  |  |
| `--browser-channel <name>` | Playwright browser channel to launch, e.g. chrome \| msedge |  |  |  |  |
| `--browser-executable <path>` | launch this Chromium binary instead of Playwright's pinned one |  |  |  |  |
| `--device <name>` | emulate a Playwright registered device by name, e.g. --device "iPhone 13" (viewport + scale + mobile/touch + UA; mutually exclusive with --viewport) |  |  |  |  |
| `--fingerprint <fp>` | the defect/hang fingerprint to verify |  |  |  |  |
| `--fixtures <file>` | mission fixtures JSON {setup:[...], restore:[...]} (#140/#144): HTTP steps to an --allow origin, authenticated from --storage-state/--secret-field, run before the mission and restored after it — and around every replay. Outputs bind as ${setup.<name>} |  |  |  |  |
| `--hang-replay-writes` | let a hang's replay re-send a paid/destructive write the run sent (default: the verdict is inconclusive, never replayed) |  |  |  |  |
| `--headed` | show the browser window (demo mode); also JEVITATE_HEADED=1. Default: headless. Needs a display — else use --record-video |  |  |  |  |
| `--hook-timeout-ms <ms>` | timeout for each --before/--after hook (default 60000; the process group is killed) |  |  |  |  |
| `--invariants <file>` | re-check a declared-invariant defect with these invariant files (repeatable) instead of the spec saved with the mission | `[]` |  |  |  |
| `--json` | emit the JSON envelope (default: a human summary) |  |  |  |  |
| `--record-video [dir]` | record a video of each browser context (works headless too); default: next to the run's result; listed as videoPaths |  |  |  |  |
| `--regressions-dir <path>` | regressions directory whose ledger/ is searched when --result is omitted (default: .jevitate/regressions) |  |  |  |  |
| `--replays <n>` | fresh-context replays that confirm a fix (default 3) |  |  |  |  |
| `--result <path>` | the mission's <stem>.result.json (written next to its Recording); default: the fingerprint's ledger entry (#195) |  |  |  |  |
| `--screenshots [mode|dir]` | masked screenshots + index.md: one per distinct screen (default), `steps` one per step; `screens:<dir>`/`steps:<dir>`/`<dir>` set the folder (default: next to the run's result); listed as screenshotPaths |  |  |  |  |
| `--secret <value|env:VAR>` | REDACTION ONLY: a value kept out of the fixture log (repeatable), e.g. one a --before hook prints; env:VAR reads it from the environment | `[]` |  |  |  |
| `--slow-mo <ms>` | slow every browser operation by this many ms (default 250 with --headed, else 0) |  |  |  |  |
| `--storage-state <file>` | override the storageState the mission ran with |  |  |  |  |
| `--viewport <WxH>` | emulate a viewport of this size, e.g. --viewport 375x812 (mutually exclusive with --device) |  |  |  |  |
