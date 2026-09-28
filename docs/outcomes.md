# Mission outcomes and exit codes

Every Jevitate mission ends in a typed, exit-coded outcome. This page is the full reference; the README keeps the short table.

## Exit codes

One table for every `jevitate` command (`packages/cli/src/exit-codes.ts`). Other pages list a
command's codes only as a reminder; this is the reference.

| Exit | Class | Meaning |
|---|---|---|
| `0` | ok | clean, succeeded, check passed, fixed, or the command did what it was asked |
| `1` | defects | defects found, a gating finding (`check`), still reproduces (`verify-fix`, `ledger verify`, `regression run`), a success check that did not hold, an invalid invariant file (`invariants validate`; an unreadable one is `64`) |
| `2` | inconclusive | the run or command could not finish its work: `inconclusive`/`crashed`, a `check` item errored or the budget ran out, a queued mission could not run, an unexpected error, or `ledger verify` matched no entries (nothing was verified). It proves nothing. |
| `3` | hang | the app hung, and the hang reproduced on replay |
| `4` | intermittent | a hang, or a `verify-fix` signal, fired on some but not every replay |
| `64` | usage | a usage or input error, and nothing ran: an unknown or missing flag, a bad argument (`E_EXPLORE_ARGS`, `E_EXPLORE_ASSERTION`, `E_VERIFY_FIX_ARGS`, …) or number (`--max-actions abc`, `--replays 0`: refused while the command line is parsed), an unreadable or invalid input file (`E_CHECK_SUITE`, `E_LEDGER_INPUT`, `E_UX_INPUT`, `E_TARGET_CONFIG`, …), an unknown id (`E_UNKNOWN_JOURNEY`, `E_REGRESSION_NOT_FOUND`, `E_BASELINE_NOT_FOUND`, …), missing keys (`E_AI_SETUP_REQUIRED`), or a target outside the allowlist — including a `check` suite item whose start URL is off its target's allowlist, or whose `verifyFix` fingerprint is not in its result (refused up front, like a missing result file) |
| `130` / `143` | killed | SIGINT / SIGTERM; the partial result is still written (see [operations](./operations.md)) |

`64` is `EX_USAGE` from `sysexits.h`. It is deliberately not `5`, so a future outcome code never
collides with it. A refused command's code comes from its error code: `_ARGS`, `_INPUT`,
`_ASSERTION`, `_SPEC`, `_CONFIG`, `_NOT_FOUND` and `E_UNKNOWN_*` codes are usage errors (64), and any
other error is `2`.

### Output: `--json` or a human summary

Every command follows one rule:

- With `--json`, stdout is exactly one line: the `{v, ok, data}` envelope, or `{v, ok: false, error:
  {code, message}}`. This is the machine contract. A command line refused while it is parsed (an
  unknown flag, a bad number) still prints the envelope, with the command's `E_<COMMAND>_ARGS` code.
- Without `--json`, a success prints a short human summary on stdout: the verdict, key counts, each
  defect or hang with its fingerprint, where the result file is, and a `next:` line (for example
  `jevitate verify-fix <fp>` or `jevitate report`). A refusal prints `error <CODE>: <message>` on
  stderr. Neither is JSON; parse `--json` output or the persisted `<stem>.result.json` instead.

The exit code is the same either way.

## Mission outcomes and exit codes

A mission never answers with a crash: every run ends in a typed outcome, and its
transcript and Recording are flushed to disk step by step, so they survive even
a run that dies mid-way. A run that could not do its work is never reported as
clean.

| Outcome | Exit code | Meaning |
|---|---|---|
| `clean` | 0 | the run finished its budget and found nothing (goal mission: the success assertion held) |
| `defects-found` | 1 | at least one confirmed defect — one an independent code oracle decided (a hard signal, a declared invariant, an HTTP 5xx, a server-log defect, a horizontal overflow). A defect marked `advisory: true` (a model's judgment alone) never makes a run `defects-found` (goal mission: the success assertion did not hold) |
| `inconclusive` / `crashed` | 2 | the run itself broke (page never rendered, model unavailable, browser/page crash), or it proved nothing: a run that exercised too little of its target to call its silence clean (`failure.kind: "insufficient-coverage"`), a goal whose only failing checks were vacuous (`vacuous-check`), a usability review whose job was never completed (`job-incomplete`), an app that stopped answering navigation mid-run (`target-unresponsive`, always `inconclusive`) |
| `hang` | 3 | the app under test hung, and the hang reproduced on replay |
| `intermittent` | 4 | a hang was observed but did not reproduce on every replay |

The MCP tool `get_mission_result` returns the same status and code for a
finished run; a broken run comes back as an error result. Its `id` is a result stem —
`explore-<stamp>` (a goal run: `status` is its canonical `missionOutcome`, and its own
`succeeded`/`failed`/`exhausted`/`blocked` comes back beside it as `goalOutcome`), `coverage-`, `adversarial-`, `feature-` or
`usability-<stamp>` — or a `queue_exploration` `missionId`.

### Every `outcome`, `stop` and `missionOutcome` value

The table above is the canonical `MissionOutcome` — every mission's typed verdict and the
process exit code it maps to (`missionExitCode()`, `packages/domain/src/mission-outcome.ts`).
Every mission's result also carries a `missionOutcome: MissionOutcome` (and `exitCode`) field —
the canonical, exit-coded verdict from that table, on every strategy, a goal run included — so a
caller that only cares "did this run prove something clean, or not" never needs to interpret a
mission-specific `outcome`/`goalOutcome`/`stop` below. Those mission-specific fields exist for
diagnosis: why the run stopped, in that mission's own terms.

**Goal mission (`--goal`) — its own `goalOutcome: GoalBasedOutcome`** (also in `outcome`), carried
beside the canonical `missionOutcome`, never in its place. Each goal-only value folds onto a
canonical outcome — the result's `missionOutcome` — and so onto its exit code, in ONE place
(`GOAL_OUTCOME_FOLD` / `outcomeExitCode()`, `packages/domain/src/mission-outcome.ts`; the CLI's
`goalExitCode()`, the result schema and MCP `get_mission_result` all read it). For example, a goal
whose success check did not hold is `missionOutcome: "defects-found"`, `goalOutcome: "failed"`, exit 1:

| `goalOutcome` | `missionOutcome` | Exit code | Meaning |
|---|---|---|---|
| `succeeded` | `clean` | 0 | every independent success check held |
| `failed` | `defects-found` | 1 | the model said `done` (or kept proposing it until code stopped accepting proposals), but an independent success check did not hold — `failure.kind: "success-check-failed"`, the check named in `failure.message` |
| `exhausted` | `defects-found` | 1 | the action/decision budget ran out before the checks held |
| `blocked` | `defects-found` | 1 | the loop stopped without the goal met and without claiming it: the model gave up (e.g. no matching control), or no progress was possible |
| `defects-found` | `defects-found` | 1 | a defect was found: an HTTP 5xx from the app, a violated declared invariant, or a `--log-defect` match. It overrides the endings above, even when the success checks held: the checks' own verdict stays in `assertionPassed` and `checks`, and `reason` names the defect (`PUT /api/profile → 500`). A broken run or a hang keeps its own outcome, and the defect is still listed in `defects`. |
| `inconclusive` | `inconclusive` | 2 | the run could not do its work (page never rendered, a required model call stayed unavailable) — or every failing success check was **vacuous** (#202: satisfied before the run's first action), so the run proved nothing either way: `failure.kind: "vacuous-check"`, naming the check |
| `crashed` | `crashed` | 2 | the engine failed (browser/page crash, unexpected exception) |
| `hang` | `hang` | 3 | the app under test hung, and it reproduced on replay |
| `intermittent` | `intermittent` | 4 | a hang was observed but did not reproduce on every replay |

**Goal / explore loop — `stop: StopReason`**, why the loop itself stopped acting (folds into
the `goalOutcome` above; not separately exit-coded):

| `stop` | Meaning |
|---|---|
| `done` | the loop ended on the model's `done`: code accepted the proposal (the transcript says "done accepted provisionally" when a check — a `reloadThen`, or one holding since before any action — is still left to the final verdict, which may still fail it: `goalOutcome: "failed"`), or code rejected it repeatedly until it stopped taking proposals (`goalOutcome: "failed"`) |
| `blocked` | the model decided it could not proceed |
| `exhausted` | the action or decision budget ran out |
| `no-progress` | the same state repeated with no forward movement (the no-progress detector) |
| `hang` | the app under test hung |
| `inconclusive` | a required decision round-trip stayed unavailable |
| `crashed` | the engine failed |
| `budget` | a declared mission spend budget was crossed (`inconclusive`) |

**Adversarial mission (`--strategy adversarial`) — `stop: AdversarialStop`**, why the hunt
ended (its own top-level `outcome` is already the canonical `MissionOutcome` from the table
above, so it needs no separate exit-code mapping):

| `stop` | Meaning |
|---|---|
| `step-budget` | the strategy-step budget (`--max-decisions`) ran out |
| `action-budget` | the executed-action budget (`--max-actions`) ran out |
| `time-budget` | the mission's time budget ran out |
| `strategies-exhausted` | every misuse strategy was tried with nothing left to do |
| `targets-refused` | every target control on the page was refused by the safety policy (paid, destructive, session-ending or `--deny`'d) and none could be exercised, so the hunt stopped at once — `inconclusive`, `failure.kind: "insufficient-coverage"`, its message naming the refused controls and how to permit them (`--allow-destructive`; remove the `--deny`; reclassify with `--paid`/`--deny`) |
| `not-rendered` | the target page never rendered. When the start page itself answered 5xx, that is an `http-5xx` defect and the run is `defects-found`. |
| `scope-unreachable` | the start URL did not stay in scope (e.g. it redirected to a login page) |
| `target-unresponsive` | the app stopped answering mid-run (e.g. its server froze): a navigation got no response — `inconclusive`, `failure.kind: "target-unresponsive"`, `failure.message` in plain words (`the app stopped responding to navigation to /app (timed out before any response)`), never `crashed` and never a stack trace |
| `hang` | the app under test hung |
| `crashed` | the engine failed |

**Coverage and exploratory missions (`--strategy coverage` / `exploratory`) — their own
`outcome`**, before it's folded into `missionOutcome`:

| `outcome` | Meaning |
|---|---|
| `exhausted` | the state frontier was fully explored, and exercised enough of the target to call its silence clean |
| `insufficient-coverage` | the frontier emptied without proving anything — its actions **timed out** (at least as many timed-out actions as exercised transitions), or it exercised only global navigation / mostly failing controls — `inconclusive` (a defect found before still wins), `failure.kind: "insufficient-coverage"`: one name for outcome and failure (it was `insufficient-exploration` / `exhausted` before #209). `failure.message` lists the shortfalls and how to reach `clean` |
| `cap` | the action budget ran out before the frontier was exhausted |
| `scope-unreachable` | the start URL redirected elsewhere, or the run could not return to it after a departure (e.g. the session was lost after "Sign out"), or the app stopped answering navigation mid-run (`failure.kind: "target-unresponsive"`) — `inconclusive` |
| `stalled` | no step completed within `--stall-timeout` seconds (default 120) — `inconclusive` |
| `crashed` | the engine failed |
| `hang` | stopped at a hang it could not reset from |

### An app that stops answering (`target-unresponsive`)

When the app's server freezes or goes away mid-run, a navigation gets no response. That is the app,
not the engine: every strategy ends `inconclusive` with `failure.kind: "target-unresponsive"` and a
plain reason naming the path (goal: `stop: "inconclusive"`; adversarial: `stop: "target-unresponsive"`;
coverage, exploratory and feature: `outcome: "scope-unreachable"`). A defect found before is still
listed. A page whose main-thread probe gets no answer while a document is still loading is waiting on
the app, not hung: it is given the render ceiling, and a navigation still unanswered after it is a
`request-pending` hang on that document, never `main-thread-unresponsive`.

### A starved host (`hostHealth`, `environmentDegraded`)

On a saturated machine (parallel builds, a busy CI runner) a run's hangs, click timeouts and
no-progress stops can be the host, not the app. Every run samples the host (every 2s, and around
every such finding): the admission thresholds the browser pool uses (PSI / free memory), the
1-minute load average per core, the driver's own event-loop lag, and the render trend against the
run's own baseline. The thresholds (`packages/explore/src/host-health.ts`) are:

| Signal | Starved when |
|---|---|
| admission sample | over the browser pool's own thresholds (memory pressure, < 400 MiB available, CPU PSI > 80%) |
| load average | > 2 runnable tasks per core (every task gets ≤ half a core) |
| driver event-loop lag | > 500 ms (longer than the settle rule's quiet window) |
| render trend | the median of the last 3 renders ≥ 5x the run's baseline (median of its first 3) and ≥ 3 s |

A starved sample explains the 15 s after it. Then:

- a hang, a click timeout or a no-progress stop met while the host was starved is listed in
  `environmentDegraded` (`finding`, `detail`, `cause`, `step`, `advisory: true`) — never a
  defect or hang finding. A goal run that ends on one is `inconclusive`
  (`failure.kind: "degraded-environment"`);
- a run most of whose steps (> 50%) ran starved is `inconclusive` with
  `failure.kind: "degraded-environment"` instead of `clean` (goal: instead of `exhausted`/`blocked`).
  A confirmed defect, a `succeeded` goal and a crash keep their outcome.

Every result carries `hostHealth`: `peakLoadPerCore`, `minFreeMemoryBytes`,
`peakEventLoopLagMs`, `slowestRenderMs` (and the `baselineRenderMs` it is judged against),
`steps`/`degradedSteps`, `degraded`, the distinct `starvation` causes, and `attribution`.
`JEVITATE_HOST_STARVATION=off` keeps the sampling and the summary but never attributes a finding to
the host (`attribution: "off"`) — for a harness that guarantees a quiet host itself.

**Why a frontier run is `insufficient-coverage` — and how to reach `clean`.** Its silence counts only
when it exercised the target's own controls: at least one in-page control (a button, a field, or a link
in the page's body), and at most a quarter of its actions failing. "Global navigation" is page chrome —
a link inside `<nav>`, a page-level `<header>`/`<footer>`, or one repeated on 2+ pages; a link in a
page's own body (a small app whose pages link to each other in their content) is coverage. To reach
`clean`, start `--url` on a page with its own controls or content links, widen the scope with `--route`,
or fix/`--deny` the controls that keep failing (they are in the transcript with `actOk: false`).

**Feature mission (`--feature`) — its own `outcome`**, same idea plus its own path cap. A run that
exercised no in-scope, non-chrome control — or (#209) only controls unrelated to the feature (every one at
`relevance=0`: no word of the feature text in its name, label, test id or role) — proved nothing about
the feature: `inconclusive`, `failure.kind: "insufficient-coverage"` (`coverage.relevantActionsExercised`
counts the relevant ones). Name the feature with the words its controls use, or point `--url`/`--route`
at the page that has them.

| `outcome` | Meaning |
|---|---|
| `exhausted` | the state frontier was fully explored, and exercised the feature |
| `insufficient-coverage` | the frontier emptied having exercised nothing in scope, or nothing relevant to the feature — `inconclusive`, `failure.kind: "insufficient-coverage"` |
| `cap` | the action budget ran out |
| `path-cap` | the max-discovered-paths budget ran out |
| `scope-unreachable` | as above — `inconclusive` |
| `stalled` | as above — `inconclusive` |
| `crashed` | the engine failed |
| `hang` | stopped at a hang it could not reset from |

**Coverage vs exploratory.** Both expand the same state frontier. `coverage` sweeps it
breadth-first: every control of a state, in page order, before the controls a click revealed.
`exploratory` seeks novelty: it tries the control that appeared most recently first (a panel
that just opened, a page just reached), so it follows the UI deeper before it sweeps siblings.
In all three frontier missions (coverage, exploratory, `--feature`), global chrome — controls
inside `<nav>` or a page-level `<header>`/`<footer>`, or repeated unchanged across pages — is
tried only after the target's own controls, each destination at most once per run. Chrome that
leaves the target scope never takes more than 20% of the run's actions.

**A state Jev flagged is advisory (#214).** On every new state a frontier run asks Jev whether it
looks broken. A state it flags is recorded as a `judgment-flagged-state` defect with `advisory: true`:
it is listed in `defects` and in `coverage.defects` (with the repro Recording, so `verify-fix` can
replay it), shown as `(advisory)` in the human summary, and read as an advisory finding by `check`
and `report`. It never sets `missionOutcome` or the exit code: a run whose only finding is a flagged
state ends `clean` (or `inconclusive`, when it exercised too little), never `defects-found`. The run
is `defects-found` only when an independent code oracle confirms a defect — the same state's HTTP
5xx, horizontal overflow, invariant or server-log defect gates as usual. (Before #214, a flagged
state alone made the run `defects-found`, exit 1.) The adversarial mission's own `looksBroken`
judgment is recorded in the transcript only and never becomes a finding.

### A usability review (`--strategy usability`)

UX findings are advisory: a review whose job was completed is `clean` whatever it found. A review whose
job was **not** completed (`outcome.status: "incomplete"` — the model gave up, the budget ran out, or its
`done` was never verified) did not see what a user who finished the job would: `inconclusive`,
`failure.kind: "job-incomplete"` (#209), never `clean`.
