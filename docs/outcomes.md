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
| `inconclusive` / `crashed` | 2 | the run itself broke (page never rendered, model unavailable, browser/page crash), or an adversarial run exercised too little of its target to call its silence clean |
| `hang` | 3 | the app under test hung, and the hang reproduced on replay |
| `intermittent` | 4 | a hang was observed but did not reproduce on every replay |

The MCP tool `get_mission_result` returns the same status and code for a
finished run; a broken run comes back as an error result. Its `id` is a result stem —
`explore-<stamp>` (a goal run; its own `succeeded`/`exhausted`/`blocked` comes back as
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

**Coverage vs exploratory.** Both expand the same state frontier. `coverage` sweeps it
breadth-first: every control of a state, in page order, before the controls a click revealed.
`exploratory` seeks novelty: it tries the control that appeared most recently first (a panel
that just opened, a page just reached), so it follows the UI deeper before it sweeps siblings.
In all three frontier missions (coverage, exploratory, `--feature`), global chrome — controls
inside `<nav>` or a page-level `<header>`/`<footer>`, or repeated unchanged across pages — is
tried only after the target's own controls, each destination at most once per run. Chrome that
leaves the target scope never takes more than 20% of the run's actions.
