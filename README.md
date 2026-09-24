# Jevitate

[![CI](https://github.com/matt-cochran/jevitate/actions/workflows/ci.yml/badge.svg)](https://github.com/matt-cochran/jevitate/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@jevitate/cli.svg)](https://www.npmjs.com/package/@jevitate/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**Jevitate is a local-first browser-automation and testing platform.** It records
real browser sessions into reusable, typed **Journeys** (Screenplay-pattern
actions over Playwright), then replays, load-tests, explores, and reviews them
from a single CLI or an MCP server — with autonomous exploration driven by
[TypeSafe's Jev](https://typesafe.ai) judgment model, kept safe by hard
guardrails.

Website & docs: **[jevitate.com](https://jevitate.com)**

## Why

Most browser testing is either brittle scripts you hand-write or opaque
record-and-replay that breaks on the first UI change. Jevitate makes the browser
flow a **deterministic, typed artifact** you can replay, parameterize, load-test,
and reason about — and adds AI where semantic judgment actually helps (driving
toward a goal, finding defects, reviewing UX) without ever letting the model make
an unsafe or unbounded move.

## Capabilities

- **Record → replay.** Capture a flow by demonstration into a deterministic
  `Recording`; parameterize and promote it to a replayable Journey.
- **Goal-directed exploration.** Drive to a natural-language goal; success is
  judged by an independent assertion, never the model's say-so.
- **Feature, exploratory & adversarial testing.** Capability-scoped path
  discovery, state-coverage exploration, and bounded misuse with a trusted
  hard-signal defect oracle.
- **Regression artifacts.** Turn a reproducible failure into a minimized,
  deterministic, replayable regression.
- **Self-healing.** Repair a broken step under policy — never auto-healing a
  write or irreversible action.
- **UX review.** Ranked, cited, evidence-anchored usability findings (Nielsen +
  cognitive-science heuristics), advisory only.
- **Load testing** of a Journey against an authorized origin.
- **MCP server** exposing only an allowlisted, safe tool surface.
- **Distributed Journey sources** with an explicit trust/run gate.

## Install

```bash
npm i -g @jevitate/cli
# the bare-name alias installs the same `jevitate` command:
npm i -g jevitate
```

## Quick start

```bash
jevitate init                         # collect any missing keys + install agent skills
jevitate record --url https://example.test           # record a flow by demonstration
jevitate journey run <id> --param k=v                # replay a promoted Journey
jevitate explore --url https://example.test --goal "reach the confirmation page" --success urlIncludes:/confirmed
jevitate explore --strategy adversarial --url https://example.test   # try to break it (hard-signal oracle)
jevitate ux <recording.json> --app-class consumer    # ranked, cited UX findings
jevitate mcp                                          # start the allowlisted MCP server
jevitate --help                                       # everything else
```

Autonomous runs are always bounded and restricted to origins you authorize;
credentials are never sent to a model. See [SECURITY.md](./SECURITY.md).

### Build identity

`jevitate --version` prints the published version, plus the commit and build time whenever
the build could determine them (`0.1.0 (commit d63c55b, built 2026-09-24T04:11:32.000Z)`) — a
plain version number alone doesn't change between rebuilds of an `npm link`ed working tree, so
two results from different builds in one dogfooding session were otherwise indistinguishable.
When they can't be determined (no `.git`, `git` unavailable), the field reads `unknown` —
never a fabricated commit or time.

The same `{version, commit, builtAt}` (as `engine`) is on every mission's result — the
persisted `*.result.json`, the `--json` envelope, and every issue draft's `## Environment`
section — so a result on disk always says which build produced it.

### Mission outcomes and exit codes

A mission never answers with a crash: every run ends in a typed outcome, and its
transcript and Recording are flushed to disk step by step, so they survive even
a run that dies mid-way. A run that could not do its work is never reported as
clean.

| Outcome | Exit code | Meaning |
|---|---|---|
| `clean` | 0 | the run finished its budget and found nothing (goal mission: the success assertion held) |
| `defects-found` | 1 | at least one confirmed defect (goal mission: the success assertion did not hold) |
| `inconclusive` / `crashed` | 2 | the run itself broke (page never rendered, model unavailable, browser/page crash), or an adversarial run exercised too little of its target to call its silence clean |
| `hang` | 3 | the app under test hung, and the hang reproduced on replay |
| `intermittent` | 4 | a hang was observed but did not reproduce on every replay |

The MCP tool `get_mission_result` returns the same status and code for a
finished run; a broken run comes back as an error result.

The adversarial mission keeps hunting after a defect until its step, action or
time budget runs out. Defects are deduplicated by a stable fingerprint, and each
one carries its reproduction: the transcript steps that led to it and the
Recording step to replay up to. To check a fix, replay the defect:

```bash
jevitate verify-fix --result ~/.jevitate/recordings/adversarial-<stamp>.result.json --fingerprint <fp> --replays 3
# exit 0 fixed (signal absent on every replay) · 1 still reproduces · 2 inconclusive (replay could
# not reach the step) · 4 intermittent (fired on some but not all replays — never reported as fixed)
```

A single clean replay is not evidence of a fix (#74): an intermittent signal can simply not fire
once. `verify-fix` replays the defect's repro `--replays` times (default 3), each in a fresh
session; only absence across EVERY replay that reached the defect's step is `fixed`.

The MCP tool `verify_fix` (`{ id, fingerprint }`) does the same, always with the default replay count.

#### Every `outcome`, `stop` and `missionOutcome` value

The table above is the canonical `MissionOutcome` — every mission's typed verdict and the
process exit code it maps to (`missionExitCode()`, `packages/domain/src/mission-outcome.ts`).
Every mission's result also carries a `missionOutcome: MissionOutcome` (and `exitCode`) field —
the canonical, exit-coded verdict from that table — so a caller that only cares "did this run
prove something clean, or not" never needs to interpret a mission-specific `outcome`/`stop`
below. Those mission-specific fields exist for diagnosis: why the run stopped, in that mission's
own terms.

**Goal mission (`--goal`) — its own `outcome: GoalBasedOutcome`, with its own exit codes
(`goalExitCode()`, `packages/cli/src/mission-exit.ts`) instead of the generic table above:**

| `outcome` | Exit code | Meaning |
|---|---|---|
| `succeeded` | 0 | the success assertion held |
| `exhausted` | 1 | the action/decision budget ran out before the assertion held |
| `blocked` | 1 | the model decided it could not proceed (e.g. no matching control) |
| `inconclusive` | 2 | the run could not do its work (page never rendered, a required model call stayed unavailable) |
| `crashed` | 2 | the engine failed (browser/page crash, unexpected exception) |
| `hang` | 3 | the app under test hung, and it reproduced on replay |
| `intermittent` | 4 | a hang was observed but did not reproduce on every replay |

**Goal / explore loop — `stop: StopReason`**, why the loop itself stopped acting (folds into
the `outcome` above; not separately exit-coded):

| `stop` | Meaning |
|---|---|
| `done` | the model decided the goal was complete |
| `blocked` | the model decided it could not proceed |
| `exhausted` | the action or decision budget ran out |
| `no-progress` | the same state repeated with no forward movement (the no-progress detector) |
| `hang` | the app under test hung |
| `inconclusive` | a required decision round-trip stayed unavailable |
| `crashed` | the engine failed |

**Adversarial mission (`--strategy adversarial`) — `stop: AdversarialStop`**, why the hunt
ended (its own top-level `outcome` is already the canonical `MissionOutcome` from the table
above, so it needs no separate exit-code mapping):

| `stop` | Meaning |
|---|---|
| `step-budget` | the max-actions budget ran out |
| `action-budget` | the max-decisions budget ran out |
| `time-budget` | the mission's time budget ran out |
| `strategies-exhausted` | every misuse strategy was tried with nothing left to do |
| `not-rendered` | the target page never rendered |
| `scope-unreachable` | the start URL did not stay in scope (e.g. it redirected to a login page) |
| `hang` | the app under test hung |
| `crashed` | the engine failed |

**Coverage mission (`--strategy coverage`) — its own `outcome`**, before it's folded into
`missionOutcome`:

| `outcome` | Meaning |
|---|---|
| `exhausted` | the state frontier was fully explored |
| `cap` | the action budget ran out before the frontier was exhausted |
| `crashed` | the engine failed |
| `hang` | stopped at a hang it could not reset from |

**Feature mission (`--feature`) — its own `outcome`**, same idea plus its own path cap:

| `outcome` | Meaning |
|---|---|
| `exhausted` | the state frontier was fully explored |
| `cap` | the action budget ran out |
| `path-cap` | the max-discovered-paths budget ran out |
| `crashed` | the engine failed |
| `hang` | stopped at a hang it could not reset from |

### Success checks (goal mission)

A goal run succeeds only if its independent checks hold. The model's "done" never
decides it. `--success` can be repeated, and every check must hold:

| Check | Holds when |
|---|---|
| `urlIncludes:<text>` | the final URL contains the text |
| `visible:<d>` | the element is visible |
| `textIncludes:<d>\|<text>` | the element's text contains the text |
| `count:<d>\|min=<n>,max=<n>` | the number of matching elements is within the bounds |
| `valueEquals:<d>\|<value>` | a form control's **value** (input, textarea, select) equals the value exactly |
| `reloadThen:<check>` | the page is reloaded first, then the check holds (proves the value persisted) |
| `requestMade:<METHOD> <path-glob>` | the run sent a matching request (catches a save that sends nothing) |
| `responseStatus:<METHOD> <path-glob>=<2xx\|4xx\|code>` | there was at least one matching request, and every matching response had that status |

In these specs:

- `<d>` is `testId=…;role=…;name=…;label=…;text=…;css=…`, or a CSS selector
  (`[data-testid=x]` is read as the test id).
- The last `|` separates the descriptor from the text or value.
- Path globs match the request path: `*` within one segment, `**` across segments.
  A method of `*` matches any method. **The glob must start with `/`** (it matches the
  request's path, not a full URL) — `requestMade:POST */Foo` is rejected with
  `path glob must start with "/" (got "*/Foo")`, not the generic shape error.
- Network checks look only at the requests the run itself made. The reload that
  `reloadThen` performs is not counted.
- The goal loop can also choose a `reload` step itself.

The result lists each check with what the oracle saw, so a failing run names the
check that caught it:

```bash
jevitate explore --url https://app.example.test/profile --goal "set the last name to Litmus and save" \
  --success 'requestMade:PUT /api/profile' --success 'responseStatus:PUT /api/profile=2xx' \
  --success 'reloadThen:valueEquals:[data-testid=last-name]|Litmus'
```

### App-declared invariants

An app team can declare its own hard rules in a JSON file that lives in its repo.
Jevitate checks them around every action and treats a violation as a defect, like a
console error or an HTTP 5xx: the outcome is `defects-found` and the exit code is `1`.
Jevitate evaluates the rules itself. No model is asked whether an invariant held, and
nothing in the file is run as code.

```json
{
  "observe": {
    "balance":    { "dom": { "selector": "[data-testid=credit-balance]", "number": true } },
    "imports":    { "probe": { "get": "/v1/imports?limit=1", "json": "$.total" } },
    "confirmEst": { "dom": { "selector": "[data-testid=confirm-estimate]", "number": true, "optional": true } },
    "lastCharge": { "network": { "url": "**/v1/billing/credit-activity*", "json": "$.entries[0].credits", "optional": true } }
  },
  "invariants": [
    { "id": "charge-implies-delivery", "require": "delta(balance) < 0 -> delta(imports) >= 1",
      "settle": { "withinMs": 600000, "pollMs": 5000 } },
    { "id": "open-is-free", "when": { "control": { "name": "/Open as editable workspace/i" } },
      "require": "delta(balance) == 0" },
    { "id": "estimate-honest", "when": { "control": { "name": "/Confirm|Run|Analyze/i" } },
      "require": "confirmEst == null || delta(balance) >= -1.5 * before(confirmEst)" },
    { "id": "no-raw-rpc-errors", "never": { "pageText": "/\\[(deadline_exceeded|unavailable|internal|unknown)\\]/" } }
  ]
}
```

```bash
jevitate explore --url http://localhost:5173/imports --goal "import https://example.com" \
  --success 'visible:testId=import-result' --allow http://localhost:5173 --allow http://localhost:8088 \
  --invariants invariants.json
```

**Observables** are named and read-only:

- `dom`: the text of the first match of a `selector` (CSS) or a `target` descriptor.
  Add `read: "value"` for a form value, `read: "count"` for the number of matches, and
  `number: true` to parse the first number (`"≈ 1,240 credits"` becomes `1240`).
- `network`: a JSON path in the last response whose URL matches the glob. Only
  responses from an authorized origin are read.
- `probe`: a `get` (or `head`) of an existing endpoint. It must be on an `--allow`
  origin, and it runs with the mission browser's own cookies. Redirects are not
  followed, and nothing else is sent: no other method, headers or body. Without
  `json`, the value is the HTTP status.

`optional: true` makes a missing value `null`. Without it, a value that cannot be read
makes the invariant **unknown**. An unknown invariant is not a violation and is not a
pass: it is counted in the result's `invariants` report.

**Invariants** are each one of:

- `require`: an expression checked after each action that matches `when` (every
  action when `when` is left out). `when` can match `control.name` (an exact string or
  a `/regex/flags` pattern), `route` (a path glob) and `op`.
- `never`: `pageText` (a pattern) or `assertion` (a success-check assertion) that must
  never hold. It is checked after every action.
- `always`: an assertion that must hold after every action.

The expression language is small: `before(x)`, `after(x)` (or just `x`), `delta(x)`,
`+ - * /`, `== != < <= > >=`, `&&`, `||`, `->` (implication), `null`, `true` and `false`.
`settle` re-checks a violated `require` until it holds or `withinMs` passes, and only
then counts the violation.

**Refusals and results.** A file that does not validate is refused before any browser
opens, with the path of the problem, e.g. `inv.json: invariants[2].require: unknown observable "balanse"`.
So is a probe that is not a GET/HEAD or not on an authorized origin, and any unknown key.
`--invariants` can be repeated, and it works with the goal, coverage, exploratory,
adversarial and `--feature` missions. Each violation's defect carries:

- the invariant's `id` and expression,
- the before and after values (redacted),
- the action and route,
- the probe and network evidence (method, URL and status only, never a body).

A defect's fingerprint is the invariant id plus the route. The result also stores the
spec, so `jevitate verify-fix --result … --fingerprint …` re-checks the same invariant
by replaying up to the step. `--invariants` on `verify-fix` overrides the saved spec.
Over MCP, `queue_exploration` takes the same spec inline as `invariants`. It never takes
a path, and its probes are checked against the target's origin.

### Backend log correlation

`--log-source <spec>` (repeatable; goal, coverage, exploratory, adversarial, `--feature`) tails a
backend log for the run and correlates its lines to the step they landed during — turning "blocked:
could not verify plan limit" into "blocked: the server denied `GetActiveRatePlanForOffer` for this
user". Sources are **operator-declared, read-only and never the model's choice** — CLI/local-config
only, never part of an MCP `MissionRequest`:

```bash
jevitate explore --url http://localhost:5173/imports --goal "import https://example.com" \
  --success 'visible:testId=import-result' --allow http://localhost:5173 --allow http://localhost:8088 \
  --log-source docker:autopilot-local-autopilot_api-1 --log-defect error
```

- `file:<path>` tails from the file's CURRENT end (a file that does not exist yet is not an error —
  once it appears, everything written to it is new, since nothing could predate the source).
- `docker:<container>` spawns `docker logs -f --since 0s <container>`.
- `cmd:<command>` streams an arbitrary command's stdout/stderr — refused unless `--allow-log-cmd` is
  also given (a bigger trust step than reading a file or a container's own logs, since it runs a
  process). `docker:`/`cmd:` children run in their own process group and are killed as a group on
  SIGTERM/SIGINT/exit (#94) — never orphaned, never awaited past the run.

**Parsing.** A line's level and timestamp are read from common formats, in order: JSON
(`level`/`severity` + `time`/`timestamp`/`ts`/`@timestamp`), logfmt (`level=error msg="…" time=…`),
then a bracketed/bare level with an optional leading ISO timestamp. A line that matches none of
these keeps its arrival order and an `unknown` level rather than being dropped.

**Correlation.** Each step's window runs from the previous step's settle time to this step's own
settle time — the wall-clock epoch a mission's incremental transcript-flush listener already
observes, so this needs no change to the mission loop. The LAST step's window is additionally held
open for `--server-log-drain-ms` (default 3000, operator-settable up to minutes) so async backend
work that settles after the browser gave up is still caught: the run's own await for this only
happens AFTER the mission function has returned, so a log source never blocks a mission's own
budget or progress. Only `warn`/`error` lines (or any line a `--log-defect` matcher below hits,
whatever its level) are attached as evidence, redacted with the run's own `--secret` list, to the
step's transcript entry (`serverLogs`) and to any defect or `blocked` reason on it.

**Optional oracle.** `--log-defect <level|/regex/>` (repeatable) makes a matching line a defect kind
`server-log`: `error`/`warn`/`info`/`debug` matches as `level >= this`; `/pattern/flags` is compiled
once via `new RegExp` (never `eval`ed, bounded to 500 chars) and matched against the RAW line.
Its fingerprint is the normalized message (ids, numbers, uuids and timestamps stripped) plus the
correlated step's route (`"(run)"` for a line outside every step window). `verify-fix` re-checks a
`server-log` defect by replaying its recorded steps in a fresh session AND re-tailing the SAME log
source(s) for the same drain window — never by looking for it among DOM/console/network signals,
which a backend log line is none of. A `cmd:` source needs `--allow-log-cmd` on `verify-fix` too.

**Result.** `serverLogs` on the result carries counts by level, the top normalized messages, each
source's `opened`/`linesRead`/`truncated`/`error`, and `oracleOk` — false when `--log-defect` was
given but every source failed to open or delivered not one line, so a `server-log` defect's absence
is never misread as "held"/clean off an oracle that was not actually watching anything.

### Authenticated missions

`--secret <value>` **only redacts**: the value is kept out of every model call,
transcript, Recording and issue draft, but it is never typed into a field.

- **Start logged in (preferred).** Save a Playwright storageState once, for example
  with `npx playwright codegen --save-storage=auth.json https://app.example.test/login`,
  and pass `--storage-state auth.json`. The file holds live session cookies and
  localStorage. It goes only to the browser, and artifacts record its path, never
  its contents. `jevitate record` does not write a storageState.
- **Rotating refresh tokens.** When the app rotates its refresh token on every use,
  a saved state goes stale after the first run that refreshes it. Save a fresh state
  before each mission (or each CI job), and do not share one file between parallel runs.
- **Driving a login or signup form.** Bind a field to an environment variable, and
  code types the value itself. The model only ever sees `«secret:VAR»`, and the
  Recording records the fill as `{ redacted: true }`:

  ```bash
  APP_PASSWORD=… jevitate explore --url https://app.example.test/login \
    --goal "log in as ada@example.com with the bound password" \
    --secret-field 'label=Password=env:APP_PASSWORD' --success 'visible:testId=dashboard'
  ```

  A descriptor is `label=<text>`, `testId=<id>`, `type=<input type>` (for example
  `type=password`), `id=<element id>` or `name=<name attribute>`.
- **MFA (TOTP).** `--totp '<descriptor>=env:VAR'` takes a base32 TOTP seed (what
  the app shows at enrolment). The 6-digit code is computed locally (RFC 6238,
  SHA-1, 30 s) when the field is typed. The seed never reaches a model or disk.
  For an app that forces enrolment on signup, a storageState saved after
  enrolment avoids the flow entirely.

The bound value and the seed are registered as run secrets, so the existing
redaction seams scrub them everywhere.

### Stateful and conversational runs: sequential only, one tenant at a time

A conversational or otherwise stateful journey (the goal loop, or any run that
reads back its own writes — an inbox, a sidebar list, an inquiry thread) mutates
real state in the target app under the identity your `--storage-state` carries.
**Run these sequentially, never concurrently, against the same `--storage-state`
or the same tenant/session.** Two runs sharing one storage-state race on the
same underlying account, and the app's own UI (a sidebar, a list, a feed) is not
scoped per jevitate run — it shows whatever the tenant currently has. A second
run can walk straight into state the first run just created:

- **Cross-run contamination.** In a real-mode dogfood, two concurrent goal runs
  against one `--storage-state` both wrote into a single shared inquiry: the
  second run's UI listed the first run's freshly-created item, its title looked
  plausible for the second run's own goal, and the second run acted on it as if
  it were its own.
- **Fixture-vs-real carry-over.** Because the underlying tenant persists between
  invocations, a later fixture-backed run reused an item a prior real-mode run
  had created against that same tenant — the state was never reset in between.

To avoid this:

- Run conversational/stateful journeys **one at a time**, in sequence, whenever
  they share a `--storage-state` file or point at the same tenant/session. Do
  not fan them out in parallel.
- Treat one `--storage-state` as scoped to one run at a time, not as a pool to
  share across concurrent invocations.
- If you must run several stateful journeys back to back, expect state from
  each prior run to still be visible to the next one — plan goals accordingly
  or reset the tenant's data between runs.

**Not yet supported:** a `--storage-state`-per-run pattern that provisions a
fresh tenant/session from a caller-supplied seed hook, so that genuinely
parallel runs against a multi-tenant app would not cross-contaminate. Until
that lands, sequential execution against a shared identity is the only safe
pattern.

### Adversarial scope, form misuse and coverage

An adversarial run is **scoped to its target**: the start URL's route and everything
under it, plus any `--route <glob>` you add (`*` is any run of characters within one
path segment, `**` any number of segments; the path is matched, the query is not).
When an action lands outside the scope, the run records the departure (the step, the
URL and what was acted on), resets to the start URL in a fresh page and keeps hunting
there. Steps that land out of scope are counted separately and never count as coverage.
A start URL that does not stay in scope (for example, one that redirects to a login
page) ends `inconclusive`.

Most pages are forms, so the run looks for them: fields plus a Save / Submit control
(from the page's own `<form>` and submit buttons, or a Save-like button where the page
has no `<form>`). It then tries misuse around submitting:

- a double submit;
- a submit with boundary or invalid values (empty, edge, long, unicode, invalid);
- edit, then Cancel, then Save;
- a reload with unsaved edits;
- acting again while the save request is still pending.

It also acts once on every other control on the target. Password fields, file inputs
and log-out controls are never targets.

Every adversarial result reports **coverage**:

- the target controls exercised out of the total;
- the forms found and submitted;
- per strategy, how often it applied and how often it found nothing to do;
- the out-of-scope steps.

A run that found nothing is `clean` only if it also tried. By default it must have
exercised at least **25%** of the target's controls
(`--min-control-coverage <0..1>`) and, when the target has a form, submitted one
(`--no-require-form-submit` turns that off). Whatever the thresholds, a run that
exercised no control at all is never clean. Below the thresholds the outcome is
`inconclusive` (exit 2), with the coverage and the reasons in `coverage.shortfalls`.
The CLI's JSON result and the MCP `get_mission_result` both carry `coverage`.

### Hangs

A hung app is its own finding (`hang`), never folded into "no progress" or a
timeout. jevitate distinguishes four kinds: the page never settles within the
ceiling; the main thread does not answer a trivial probe; a request stays pending
past its bound on a page that cannot be used; or the UI makes no progress after an
action while the page is still alive (a busy indicator that never ends, or an
action that silently puts the page back in an earlier state). The evidence is
recorded: pending requests, the last page state, timings and the JS heap. The
steps that led to the hang are then replayed in fresh browser contexts
(`--hang-replays`, default 2). If any replay hangs again, it is a confirmed
`hang`. If none did but at least one replay ran all the way, it is
`intermittent`. If no replay could run at all (the fresh session could not
open, or the replay failed before it reached the step), it is `inconclusive`:
a replay that never ran is not evidence that the hang went away. The evidence
from every attempt is kept. The
exploring missions (adversarial, coverage and feature) then keep hunting: they
reset to a known state (a fresh page at the start URL), skip the hung route, and
go on within budget. A repeated hang counts as another occurrence of the same
finding. Findings made after a reset carry their own Recording, so they replay
from the start URL and never through the hang. The goal mission still ends at a
hang, because the hang blocks its goal.
`verify-fix` works on a hang too: it passes only if the replay now settles within
the bound.

#### When is a page "settled"?

No request in flight and no *structural* DOM change (nodes added or removed, or an
attribute that changes what can be acted on) for 500ms, within a 15s ceiling.
These do not count:

- long-lived connections: WebSocket, EventSource, and any response streamed as
  `text/event-stream`;
- requests the target marks as background (`settle.ignoreRequests`);
- auto-detected long-polls: a request pending longer than `settle.longPollMs`
  (default 5000) while the page is otherwise interactive (a control is rendered
  and no busy indicator shows);
- text-only updates of existing nodes (a clock, a live counter) and inline-style
  animation.

Configure a target in `~/.jevitate/targets.json`, keyed by origin (or per run
with `--settle-ignore`, `--long-poll-ms` and `--ignore-no-progress`):

```json
{ "https://app.example.test": {
    "settle": { "ignoreRequests": ["/api/notifications/poll*", "/hub/*"], "longPollMs": 5000 },
    "hangs": { "ignoreNoProgress": ["click Refresh*", "/dashboard"] } } }
```

`*` matches any run of characters. A pattern containing `://` is matched against
the full URL; any other pattern is matched against the path and query.

#### Known limits of the hang heuristics

- A request that runs longer than `longPollMs` on an interactive page is treated
  as background, so a genuinely stuck request on a page that still shows
  controls is not reported as `request-pending`. It can still surface as
  `ui-no-progress` if the UI shows a busy indicator.
- DOM churn that keeps adding or removing nodes more often than every 500ms (an
  infinite feed, a JS animation that rebuilds nodes) never settles and reads as
  `never-settled`. Declare it or treat such routes carefully.
- Stalled-state `ui-no-progress` means an action sent the page back to a state it
  had already shown, no new state appeared, and it stayed there for 8s. Actions
  named like "Back", "Cancel", "Close" or "Undo" are exempt. Any other UI that
  returns to an earlier state by design needs `hangs.ignoreNoProgress`.
- Busy indicators are recognised by `aria-busy="true"`, an indeterminate
  `role="progressbar"`, or a spinner class name. Custom spinners without these are
  not seen.
- A hang is confirmed only if it reproduces on every replay. A deterministic
  false positive of any kind above would therefore reproduce too.

### Page timing

Every transcript step (and the Recording step before it) records how the page
reached its state: Navigation Timing (TTFB, DOMContentLoaded, load) for a new
document, action-to-settled time for an in-place transition, the page's
requests (count, and the slowest ones with their redacted, normalized endpoint,
status and duration), and LCP where the browser exposes it. Each run's result
carries a `timing` summary keyed by normalized route (`navigation /contacts/:id`)
and endpoint pattern (`GET /api/contacts/:id`), with p50 and max, plus the
slowest pages. Requests are classified as `api`, `document` or `asset`:
- `api` is XHR or fetch that returns data (JSON or other non-HTML), or any path
  under a configured `timing.apiPrefixes` / `--api-prefix`.
- `asset` covers scripts, styles, fonts, images and media, including a dev
  server's modules such as Vite's `/src/…`, `/@vite/…` and `/node_modules/…`.

`slowestEndpoints` ranks the API only, and `slowestAssets` ranks the assets. The
full per-endpoint data keeps both. These are measurements, not verdicts: a slow page
is never a defect by itself.

### Replay finds the recorded element exactly

A replay (a Journey, `verify-fix`, a hang reproduction) never clicks a guess:

- It uses a stable anchor captured at record time when there is one: a test id,
  or a non-generated, document-unique `id` or `name` attribute. It stores
  identifiers only, never a field's value.
- Otherwise it matches the recorded role and accessible name, label or text
  **exactly**, never by substring or prefix, so "Stuck report" is never
  "Stuck report again". Among elements with the same name, it uses the recorded
  index. If the number of such elements changed since recording, the step fails
  instead of clicking whatever element now sits at that index.
- A target that is missing, or that cannot be told apart from others, fails the
  step with a typed `replay-target-not-found` or `ambiguous` result.
  `verify-fix` reports that as `inconclusive`, never as `fixed`.

Older recordings without anchors or recorded counts still replay, by exact
name plus index.

### Crashes and issue drafts

Every crash records the steps up to it, the error and stack, the page/browser
crash signals and the page's JS heap per step. It is attributed from that
evidence: to jevitate (an own-code stack frame and no page/browser crash signal),
to the system under test (page or browser crash, renderer OOM, unbounded heap
growth, a hang), or as uncertain (filed to both). The host's own resource
pressure is sampled at detection time (the same sample admission control takes:
PSI, cgroup and meminfo on Linux/WSL, a portable fallback elsewhere) and is part
of the evidence. If the host was over a threshold, an unresponsive main thread
or a navigation timeout is attributed as uncertain ("host under resource
pressure"), not to the app. Each defect and crash gets a
ready-to-file, redacted Markdown draft in `<recording>.issues/<fingerprint>.md`.

Filing is off by default. It needs `--file-issues` (or `"enabled": true`) and a
repo: engine findings go to `--jevitate-repo` (default `matt-cochran/jevitate`);
findings in the app under test go to the repo configured for that target, with
`--issue-repo` or `~/.jevitate/filing.json`:

```json
{ "enabled": false, "targets": { "https://app.example.test": { "repo": "acme/app" } } }
```

Filing uses the `gh` CLI when it is installed, otherwise the GitHub REST API with
`GITHUB_TOKEN` from jevitate's credential store. Before it opens an issue, it
searches for an open issue carrying the same fingerprint marker and comments on
that one instead.

## How it's packaged

`@jevitate/cli` is a single bundled package — all internal `@jevitate/*`
workspace code is compiled into `dist/bin.js` via esbuild, and only native/heavy
dependencies (`playwright`, `better-sqlite3`, …) install alongside it. `jevitate`
is a thin bare-name wrapper that re-execs the same binary. Every other
`packages/*` is `private` and internal.

## Development

```bash
pnpm install
pnpm -r build
pnpm exec vitest run
pnpm lint
```

Contributions welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) (feature branch →
PR into `dev`; TDD; security invariants preserved). Releases are documented in
[RELEASING.md](./RELEASING.md).

## License

MIT — see [LICENSE](./LICENSE).
