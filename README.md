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
- **UX review.** Usability findings grounded in what the run observed (run
  signals and journey friction), ranked by impact on the job and cited to Nielsen
  and cognitive-science heuristics. Heuristic-only findings go in an appendix.
  Advisory only.
- **Load testing** of a Journey against an authorized origin.
- **CI gate.** `jevitate check --suite` runs Journeys, invariants, goals and missions within a
  budget; JUnit + SARIF + JSON; `report` and `diff` give one deduped defect list and a baseline diff.
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
section — so a result on disk always says which build produced it. So is every other command's
result envelope (`ux`, `journey run`, `load run`, `source run`, `verify-fix`, `regression capture`,
`mission run`), a killed run's partial result, `jevitate mcp`'s `initialize` (`serverInfo.version`,
with the commit in its description), MCP `get_site_health`, and `jevitate ui`'s `/api/health`.

A run killed by SIGTERM/SIGINT (`timeout -s TERM 900 jevitate explore …`) exits 143/130 and still
writes `<stem>.result.json`: `missionOutcome: "inconclusive"`, `stop: "terminated"`, the real step
count and transcript, the `transcriptPath` that exists, `engine`, the `usage` spent so far, and any
partial report (a usability review's observed screens). With `--json` the same result is printed
as the envelope before the process exits.

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
finished run; a broken run comes back as an error result. Its `id` is a result stem —
`explore-<stamp>` (a goal run; its own `succeeded`/`exhausted`/`blocked` comes back as
`goalOutcome`, folded onto `clean`/`defects-found`), `coverage-`, `adversarial-`, `feature-` or
`usability-<stamp>` — or a `queue_exploration` `missionId`.

### Queued missions (MCP)

`queue_exploration` only enqueues a mission (`~/.jevitate/missions/queue/<missionId>.json`).
`jevitate mission run` drains the queue: each mission runs through the runner its strategy uses on
the CLI, its result lands in `~/.jevitate/recordings`, and its queue record moves
`queued → running → done | failed`. `get_mission_result {id: missionId}` reports `queued`/`running`
(`pending: true`), the finished result, or `failed` (an error: it could not run, e.g. its target was
unpromoted meanwhile); `verify_fix` takes the missionId too once it is done.

```bash
jevitate mission target add spa --name "App" --authorized-origin http://127.0.0.1:5193 \
  --api-origin http://127.0.0.1:18582 --base-url http://127.0.0.1:5193/settings --json
jevitate mission target promote spa --json          # a human act: only promoted targets are queueable
jevitate mission run --once --real --json           # drain what is queued now (--watch keeps polling)
```

A mission may reach only its target's `--authorized-origin` plus its `--api-origin`s (each a bare
http(s) origin — the queued-mission form of a second `explore --allow`); the target is re-resolved
(promoted-only) when the mission runs. Queueable strategies: `goal-based` (a goal and a
`successAssertion`), `coverage` and `adversarial` (an optional in-scope `route` glob), and
`feature` (a `feature` name, optional `route`). A usability review needs an app class the request
cannot carry, so it is CLI-only. Without `--real`/`--fake-ai`, model-driven missions stay queued
(reported as `skipped`) and only feature missions run. The exit code is 1 only when a mission could
not run at all; each mission's own outcome is in its result. A drain killed mid-mission records
that mission `done` with its partial `inconclusive` result, never leaves it `running`.

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
| `inconclusive` | 2 | the run could not do its work (page never rendered, a required model call stayed unavailable, or a declared mission spend budget was crossed — `run.stop === "budget"`, see below) |
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
| `budget` | a declared mission spend budget (#150) was crossed, or a paid action was refused before crossing it — folds into `outcome: "inconclusive"`, never `succeeded`, never `crashed` |

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

**Coverage and exploratory missions (`--strategy coverage` / `exploratory`) — their own
`outcome`**, before it's folded into `missionOutcome`:

| `outcome` | Meaning |
|---|---|
| `exhausted` | the state frontier was fully explored |
| `cap` | the action budget ran out before the frontier was exhausted |
| `scope-unreachable` | the start URL redirected elsewhere, or the run could not return to it after a departure (e.g. the session was lost after "Sign out") — `inconclusive` |
| `stalled` | no step completed within `--stall-timeout` seconds (default 120) — `inconclusive` |
| `crashed` | the engine failed |
| `hang` | stopped at a hang it could not reset from |
| `budget` | a declared mission spend budget (#150) was crossed, or a paid action was refused before crossing it — `inconclusive` (`defects-found` still wins if any were found first) |

**Feature mission (`--feature`) — its own `outcome`**, same idea plus its own path cap:

| `outcome` | Meaning |
|---|---|
| `exhausted` | the state frontier was fully explored |
| `cap` | the action budget ran out |
| `path-cap` | the max-discovered-paths budget ran out |
| `scope-unreachable` | as above — `inconclusive` |
| `stalled` | as above — `inconclusive` |
| `crashed` | the engine failed |
| `hang` | stopped at a hang it could not reset from |
| `budget` | as above — `inconclusive` (`defects-found` still wins if any were found first) |

**Coverage vs exploratory.** Both expand the same state frontier. `coverage` sweeps it
breadth-first: every control of a state, in page order, before the controls a click revealed.
`exploratory` seeks novelty: it tries the control that appeared most recently first (a panel
that just opened, a page just reached), so it follows the UI deeper before it sweeps siblings.
In all three frontier missions (coverage, exploratory, `--feature`), global chrome — controls
inside `<nav>` or a page-level `<header>`/`<footer>`, or repeated unchanged across pages — is
tried only after the target's own controls, each destination at most once per run. Chrome that
leaves the target scope never takes more than 20% of the run's actions.

### Success checks (goal mission)

A goal run succeeds only if its independent checks hold. The model's "done" never
decides it. `--success` can be repeated, and every check must hold:

| Check | Holds when |
|---|---|
| `urlIncludes:<text>` | the final URL contains the text |
| `visible:<d>` | the element is visible |
| `textIncludes:<d>\|<text>` | the element's text contains the text (case-insensitive) |
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

### Find-out goals (no `--success`)

A goal that asks the run to find out / understand something (e.g. "find out how many
contacts are overdue and report the count") has no page state to assert on, so
`--success` can be omitted. The model ends such a run with a `report` op instead of
`done`: it proposes an answer, and code grounds it — every claim must trace back to
text the run actually observed on a page — before accepting it. An ungrounded report
is rejected and the model keeps looking; the run is `succeeded` only once a report is
accepted, and the accepted answer (with its grounding evidence) is returned as
`answer`. Never Jev's self-report: the same independent-grounding rule the page/network
checks get.

```bash
jevitate explore --url https://app.example.test/contacts \
  --goal "find out how many contacts are overdue and report the count"
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
  followed, and nothing else is sent: no other method, headers or body (except
  `authFrom`'s `Authorization` header — see below). Without `json`, the value is the
  HTTP status.
  - `authFrom` (read-only probes, an authenticated API): `{ "localStorage": "<key>" }`
    reads a token from the run's own page (`page.evaluate`); `{ "cookie": "<name>" }`
    reads a named cookie from the browser context; `{ "secret": "env:VAR" }` resolves
    from the environment (the same `env:VAR` shape `--secret-field` uses) — never read
    from a file. All three become an `Authorization` header, prefixed by `scheme`
    (default `"Bearer"`; `""` sends the raw value). The token is never logged, never
    persisted, and is redacted from every value/evidence the same way a bound secret
    is. When the token cannot be read, the probe is refused (unknown) — never sent
    unauthenticated.

`optional: true` makes a missing value `null`. Without it, a value that cannot be read
makes the invariant **unknown**. An unknown invariant is not a violation and is not a
pass: it is counted in the result's `invariants` report.

**Invariants** are each one of:

- `require`: an expression checked after each action that matches `when` (every
  action when `when` is left out). `when` can match `control.name` (an exact string or
  a `/regex/flags` pattern), `route` (a path glob) and `op` — `op` is an ARRAY of one
  or more action-op names (e.g. `"op": ["click", "type"]`, not a bare string), matched
  if the action's op is any one of them. The op vocabulary: `click`, `type`, `send`
  (type-and-submit, e.g. a chat composer), `select`, `upload`, `scroll_up`,
  `scroll_down`, `wait`, `reload`.
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

### Mission spend budgets

A `budget` key in the same invariants file (#150) puts a cumulative spend cap on a declared
observable — e.g. a credits balance that pays for real LLM/provider calls. Code reads it at
run start and after every settled step; crossing it stops the mission CLEANLY, before its
next action, with `stop: "budget"` (never folded into `clean`/`succeeded`, never `crashed`).

```json
{
  "observe": {
    "credits":    { "probe": { "get": "/v1/billing/balance", "json": "$.credits" } },
    "confirmEst": { "dom": { "selector": "[data-testid=confirm-estimate]", "number": true, "optional": true } }
  },
  "invariants": [],
  "budget": [
    {
      "observe": "credits",
      "maxDelta": -150,
      "guard": { "estimate": "confirmEst", "factor": 2.0 },
      "settle": { "withinMs": 600000, "pollMs": 10000 },
      "onUnreadable": "stop"
    }
  ]
}
```

- `observe` names an entry in this same file's `observe` map (a `dom` read or a read-only
  `probe`, authenticated the same way #86/#135 probes are — never a new credential path).
- `maxDelta` is the cap on `current - baseline` since the run's first settled snapshot:
  **negative** caps spend (a balance that must not drop past it), **positive** caps growth
  (a counter that must not climb past it).
- `guard` (optional): before an action the #116 safety policy flags **paid**, code computes
  `estimate × factor` (`estimate` is a constant or another observable, read before the
  action) and refuses the action if it would cross what remains of the budget — a missing
  estimate is refused, never treated as zero cost.
- `settle`: after the loop ends (for any reason), keep re-reading for `withinMs` to catch a
  charge that lands after the last action (an async job that settles after the click) — an
  overrun seen during drain is still reported.
- `onUnreadable` (default `"stop"`): an observable that cannot be read fails the run closed
  (`inconclusive`, with the reason) rather than being treated as unspent.

The result carries a `budget` field per declared budget: `{ observe, limit, baseline, final,
delta, perAction, refused?, unreadable? }` — the full observed trajectory, whatever the
outcome. If a hard defect was already found before the budget stopped the run, the defect
still wins (`missionOutcome: "defects-found"`, reported with `stop: "budget"`).

`budget` works through the same `--invariants <file.json>` transport (repeatable, merged) as
declared invariants — no separate flag, and it currently applies to the **goal**, **coverage**
and **exploratory** and **`--feature`** missions. (Adversarial and the usability review do not
yet read a declared budget — tracked as follow-up work.)

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

**Replaying an authenticated Journey.** A Journey `explore-author-journey` authors
with `--storage-state` needs the SAME authenticated pre-step to replay: pass
`--storage-state <file>` to `jevitate journey run`, `jevitate load run` and
`jevitate source run`. Over MCP, `run_journey`'s optional `storageState` argument is
the same thing — a file PATH on the machine running the MCP server; its contents are
read only by that server's own browser session, never returned or logged. A Journey
can also declare `metadata.requiresAuth: true` so a run given no `storageState` fails
fast, before any browser opens, with a clear message — instead of a confusing
`replay-target-not-found` partway into the steps.

### Usage accounting

An exploration mission's result carries `usage: { judgments, generations,
inputTokens, outputTokens, usd? }` when the CLI command was built with usage
tracking (a `--real` run). `usd` is populated ONLY when the underlying provider
itself reports a cost — today, that is OpenRouter's usage-accounting `cost` on a
**generation** call (the model that writes form text). It is never estimated or
derived from a price table. **Jev's own judgment calls are not priced**: they have
no cost-reporting path today, so `usage.usd` is absent whenever a run made only
judgments and no generations (`generations: 0`), even though `judgments` is
non-zero and those calls cost real money against your provider account. Read
`usage.usd`'s absence as "not priced by this build," never as "free."

### Persistent browser profiles (`jevitate profile`)

`jevitate profile create <name>` / `jevitate profile status <name>` provision and
check a directory under `~/.jevitate/profiles/<name>` — an on-disk Chromium
user-data directory (Playwright's `persistentProfile`, distinct from a
`--storage-state` JSON snapshot: a real profile directory instead of a serialized
cookie/localStorage file). **No `jevitate` command consumes one yet** — there is no
`--profile` flag on `explore`, `journey run`, `record` or `load run` today. Treat
`jevitate profile` as reserved surface: it prepares the directory a future
`--profile` flag would point a browser session at, not a currently wired
authentication path. Use `--storage-state` (above) for authenticated runs today.

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

### CI mode: `jevitate check`

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
        { "strategy": "usability", "goal": "invite a teammate", "appClass": "admin" }
      ],
      "verifyFix": [{ "result": "baseline/adversarial-2026-09-20T10-00-00-000Z.result.json", "fingerprint": "3fa2c1d09b7e4a55" }]
    }
  ]
}
```

- `budget`: the total over every item. `maxActions` counts executed browser actions, and each item
  is capped at what is left. `maxMinutes` is wall-clock time. `maxUsd` is the provider-reported
  model spend. If a model call reports no cost, the spend cannot be measured, so the check fails.
  Fake gateways cost nothing.
- `ai`: the gateway for goals and model-driven missions (`coverage`, `adversarial`, `usability`).
  `--real` or `--fake-ai` override it. If a suite needs a model and none is selected, it is refused
  before anything runs. Journeys, `feature` missions and verify-fix are model-free.
- `journeys`: promoted Journeys only. Each one must run on an origin in the target's allowlist.
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

### Consolidated defect report and baseline diff

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
(default `~/.jevitate/recordings` and `~/.jevitate/ux-reports`). Each defect lists:

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

"Comparable" runs are runs of the modes that observed the finding: a goal run's silence is not
evidence that an adversarial-only defect is gone. `last` means the previous run on the same
target, per mode. A tag is a snapshot stored under `~/.jevitate/baselines/<name>.json`, so it
survives pruned result files.

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
