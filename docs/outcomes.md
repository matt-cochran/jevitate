# Mission outcomes and exit codes

Every Jevitate mission ends in a typed, exit-coded outcome. This page is the full reference; the README keeps the short table.

## Mission outcomes and exit codes

A mission never answers with a crash: every run ends in a typed outcome, and its
transcript and Recording are flushed to disk step by step, so they survive even
a run that dies mid-way. A run that could not do its work is never reported as
clean.

| Outcome | Exit code | Meaning |
|---|---|---|
| `clean` | 0 | the run finished its budget and found nothing (goal mission: the success assertion held) |
| `defects-found` | 1 | at least one confirmed defect (goal mission: the success assertion did not hold) |
| `inconclusive` / `crashed` | 2 | the run itself broke (page never rendered, model unavailable, browser/page crash), or it proved nothing: a run that exercised too little of its target to call its silence clean (`failure.kind: "insufficient-coverage"`), a goal whose only failing checks were vacuous (`vacuous-check`), a usability review whose job was never completed (`job-incomplete`) |
| `hang` | 3 | the app under test hung, and the hang reproduced on replay |
| `intermittent` | 4 | a hang was observed but did not reproduce on every replay |

The MCP tool `get_mission_result` returns the same status and code for a
finished run; a broken run comes back as an error result. Its `id` is a result stem —
`explore-<stamp>` (a goal run; its own `succeeded`/`failed`/`exhausted`/`blocked` comes back as
`goalOutcome`, folded onto `clean`/`defects-found`), `coverage-`, `adversarial-`, `feature-` or
`usability-<stamp>` — or a `queue_exploration` `missionId`.

### Every `outcome`, `stop` and `missionOutcome` value

The table above is the canonical `MissionOutcome` — every mission's typed verdict and the
process exit code it maps to (`missionExitCode()`, `packages/domain/src/mission-outcome.ts`).
Every mission's result also carries a `missionOutcome: MissionOutcome` (and `exitCode`) field —
the canonical, exit-coded verdict from that table — so a caller that only cares "did this run
prove something clean, or not" never needs to interpret a mission-specific `outcome`/`stop`
below. Those mission-specific fields exist for diagnosis: why the run stopped, in that mission's
own terms.

**Goal mission (`--goal`) — its own `outcome: GoalBasedOutcome`.** Each goal-only value folds onto a
canonical outcome, and so onto its exit code, in ONE place (`GOAL_OUTCOME_FOLD` / `outcomeExitCode()`,
`packages/domain/src/mission-outcome.ts`; the CLI's `goalExitCode()` and MCP `get_mission_result` both
read it):

| `outcome` | Folds onto | Exit code | Meaning |
|---|---|---|---|
| `succeeded` | `clean` | 0 | every independent success check held |
| `failed` | `defects-found` | 1 | the model said `done` (or kept proposing it until code stopped accepting proposals), but an independent success check did not hold — `failure.kind: "success-check-failed"`, the check named in `failure.message` |
| `exhausted` | `defects-found` | 1 | the action/decision budget ran out before the checks held |
| `blocked` | `defects-found` | 1 | the loop stopped without the goal met and without claiming it: the model gave up (e.g. no matching control), or no progress was possible |
| `defects-found` | — | 1 | an app-declared invariant was violated (it overrides the endings above) |
| `inconclusive` | — | 2 | the run could not do its work (page never rendered, a required model call stayed unavailable) — or every failing success check was **vacuous** (#202: satisfied before the run's first action), so the run proved nothing either way: `failure.kind: "vacuous-check"`, naming the check |
| `crashed` | 2 | the engine failed (browser/page crash, unexpected exception) |
| `hang` | 3 | the app under test hung, and it reproduced on replay |
| `intermittent` | 4 | a hang was observed but did not reproduce on every replay |

**Goal / explore loop — `stop: StopReason`**, why the loop itself stopped acting (folds into
the `outcome` above; not separately exit-coded):

| `stop` | Meaning |
|---|---|
| `done` | the model proposed the goal complete and code accepted the proposal (the transcript says "done accepted provisionally" when a check — a `reloadThen`, or one holding since before any action — is still left to the final verdict, which may still fail it: outcome `failed`) |
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
| `targets-refused` | every target control on the page was refused by the safety policy (paid, destructive, session-ending or `--deny`'d) and none could be exercised, so the hunt stopped at once — `inconclusive`, `failure.kind: "insufficient-coverage"`, its message naming the refused controls and how to permit them (`--allow-destructive`; remove the `--deny`; reclassify with `--paid`/`--deny`) |
| `not-rendered` | the target page never rendered |
| `scope-unreachable` | the start URL did not stay in scope (e.g. it redirected to a login page) |
| `hang` | the app under test hung |
| `crashed` | the engine failed |

**Coverage and exploratory missions (`--strategy coverage` / `exploratory`) — their own
`outcome`**, before it's folded into `missionOutcome`:

| `outcome` | Meaning |
|---|---|
| `exhausted` | the state frontier was fully explored, and exercised enough of the target to call its silence clean |
| `insufficient-coverage` | the frontier emptied without proving anything — its actions **timed out** (at least as many timed-out actions as exercised transitions), or it exercised only global navigation / mostly failing controls — `inconclusive` (a defect found before still wins), `failure.kind: "insufficient-coverage"`: one name for outcome and failure (it was `insufficient-exploration` / `exhausted` before #209). `failure.message` lists the shortfalls and how to reach `clean` |
| `cap` | the action budget ran out before the frontier was exhausted |
| `scope-unreachable` | the start URL redirected elsewhere, or the run could not return to it after a departure (e.g. the session was lost after "Sign out") — `inconclusive` |
| `stalled` | no step completed within `--stall-timeout` seconds (default 120) — `inconclusive` |
| `crashed` | the engine failed |
| `hang` | stopped at a hang it could not reset from |

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

### A usability review (`--strategy usability`)

UX findings are advisory: a review whose job was completed is `clean` whatever it found. A review whose
job was **not** completed (`outcome.status: "incomplete"` — the model gave up, the budget ran out, or its
`done` was never verified) did not see what a user who finished the job would: `inconclusive`,
`failure.kind: "job-incomplete"` (#209), never `clean`.
