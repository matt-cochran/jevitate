# Mission outcomes and exit codes

Every Jevitate mission ends in a typed, exit-coded outcome. This page is the full reference; the README keeps the short table.

## Exit codes

One table for every `jevitate` command (`packages/cli/src/exit-codes.ts`). Other pages list a
command's codes only as a reminder; this is the reference.

| Exit | Class | Meaning |
|---|---|---|
| `0` | ok | clean, succeeded, check passed, fixed, or the command did what it was asked |
| `1` | defects | defects found, a gating finding (`check`), still reproduces (`verify-fix`, `ledger verify`, `regression run`), a success check that did not hold, an invalid invariant file (`invariants validate`) |
| `2` | inconclusive | the run or command could not finish its work: `inconclusive`/`crashed`, a `check` item errored or the budget ran out, a queued mission could not run, an unexpected error. It proves nothing. |
| `3` | hang | the app hung, and the hang reproduced on replay |
| `4` | intermittent | a hang, or a `verify-fix` signal, fired on some but not every replay |
| `64` | usage | a usage or input error, and nothing ran: an unknown or missing flag, a bad argument (`E_EXPLORE_ARGS`, `E_EXPLORE_ASSERTION`, `E_VERIFY_FIX_ARGS`, …), an unreadable or invalid input file (`E_CHECK_SUITE`, `E_LEDGER_INPUT`, `E_TARGET_CONFIG`, …), an unknown id, missing keys (`E_AI_SETUP_REQUIRED`), or a target outside the allowlist |
| `130` / `143` | killed | SIGINT / SIGTERM; the partial result is still written (see [operations](./operations.md)) |

`64` is `EX_USAGE` from `sysexits.h`. It is deliberately not `5`, so a future outcome code never
collides with it. A refused command's code comes from its error code: `_ARGS`, `_INPUT`,
`_ASSERTION`, `_SPEC`, `_CONFIG`, `_NOT_FOUND` and `E_UNKNOWN_*` codes are usage errors (64), and any
other error is `2`.

### Output: `--json` or a human summary

Every command that takes `--json` follows one rule:

- With `--json`, stdout is exactly one line: the `{v, ok, data}` envelope, or `{v, ok: false, error:
  {code, message}}`. This is the machine contract.
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
| `defects-found` | 1 | a defect was found: an HTTP 5xx from the app, a violated declared invariant, or a `--log-defect` match. This holds even when the success assertion held: the checks' own verdict stays in `assertionPassed` and `checks`, and `reason` names the defect (`PUT /api/profile → 500`). A broken run or a hang keeps its own outcome, and the defect is still listed in `defects`. |
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
| `not-rendered` | the target page never rendered. When the start page itself answered 5xx, that is an `http-5xx` defect and the run is `defects-found`. |
| `scope-unreachable` | the start URL did not stay in scope (e.g. it redirected to a login page) |
| `hang` | the app under test hung |
| `crashed` | the engine failed |

**Coverage and exploratory missions (`--strategy coverage` / `exploratory`) — their own
`outcome`**, before it's folded into `missionOutcome`:

| `outcome` | Meaning |
|---|---|
| `exhausted` | the state frontier was fully explored |
| `insufficient-exploration` | the frontier emptied because its actions **timed out** (at least as many timed-out actions as exercised transitions), not because its states ran out — `inconclusive` (a defect found before still wins), `failure.kind: "insufficient-exploration"` |
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
