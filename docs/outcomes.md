# Mission outcomes and exit codes

Every Jevitate mission ends in a typed, exit-coded outcome. This page is the full reference; the README keeps the short table.

## Exit codes

One table for every `jevitate` command (`packages/cli/src/exit-codes.ts`). Other pages list a
command's codes only as a reminder; this is the reference.

| Exit | Class | Meaning |
|---|---|---|
| `0` | ok | clean, succeeded, check passed, fixed, or the command did what it was asked |
| `1` | defects | defects found, a gating finding (`check`), still reproduces (`verify-fix`, `ledger verify`, `regression run`), an assertion still passing under its mutation (`journey verify --mutate`), a success check that did not hold, an invalid invariant file (`invariants validate`; an unreadable one is `64`) |
| `2` | inconclusive | the run or command could not finish its work: `inconclusive`/`crashed`, a `check` item errored or the budget ran out, a queued mission could not run, an unexpected error, or `ledger verify` matched no entries (nothing was verified). It proves nothing. |
| `3` | hang | the app hung, and the hang reproduced on replay |
| `4` | intermittent | a hang, or a `verify-fix` signal, fired on some but not every replay |
| `5` | pending-review | a self-heal produced a proposed Journey revision; nothing passes until a person accepts it (`journey promote <id> --proposal <pid>`) |
| `64` | usage | a usage or input error, and nothing ran: an unknown or missing flag, a bad argument (`E_EXPLORE_ARGS`, `E_EXPLORE_ASSERTION`, `E_VERIFY_FIX_ARGS`, …) or number (`--max-actions abc`, `--replays 0`: refused while the command line is parsed), an unreadable or invalid input file (`E_CHECK_SUITE`, `E_LEDGER_INPUT`, `E_UX_INPUT`, `E_TARGET_CONFIG`, …), an unknown id (`E_UNKNOWN_JOURNEY`, `E_REGRESSION_NOT_FOUND`, `E_BASELINE_NOT_FOUND`, …), a `journey annotate --approve` draft that is missing, invalid or stale (`E_JOURNEY_ANNOTATIONS_STALE`: the Journey changed since the draft), missing keys (`E_AI_SETUP_REQUIRED`), or a target outside the allowlist — including a `check` suite item whose start URL is off its target's allowlist, or whose `verifyFix` fingerprint is not in its result (refused up front, like a missing result file) |
| `129` / `130` / `143` | killed | SIGHUP (or the parent died) / SIGINT / SIGTERM. A mission writes its partial result; `journey verify` and `verify-fix` print one envelope (`E_TERMINAL_SIGNAL`, or `E_TERMINAL_PARENT_GONE` for a parent that died) and write a result file; every browser is closed (see [operations](./operations.md)) |

`journey verify` and `verify-fix` always end with a result. Besides the signal codes above, they report
`E_TERMINAL_WATCHDOG` (2) when no replay has started for the run's inactivity limit, `E_TERMINAL_INTERNAL` (2)
for an unexpected error, and `E_TERMINAL_UNSETTLED` (2) if the process would otherwise have exited without a
verdict. The limit measures silence, not length: a proof whose replays keep starting is never ended. A run
ended this way has no verdict, leaves any earlier mutation-proof receipt as it was, and does not run `after`
fixtures, so state a fixture would have restored may remain.

In `journey verify --mutate`, any errored replay leaves the proof `inconclusive`, even when other mutations
covered the same assertions. A replay that errored before opening a browser, as on an admission timeout, is
retried once and listed in `mutations[].retries`. One that opened a browser may have changed the app, so it is
not retried. A failed replay or a stall is never retried. `--resume` runs an errored pair again without starting
the proof over.

What `journey verify --mutate` runs, in order:

1. **The base**: the Journey as recorded. It must pass. It stays open until the writes it sent are answered, up to
   the longest of the Journey's response timeouts and the base's own length. A write that outlasts that makes the
   proof `inconclusive`, unless it is a line the Journey never recorded and is also still open in the next replay,
   which marks it a long-lived connection.
2. **The independence replay**: as recorded, straight after the base, held to the floors of the first mutated
   replay. A failure is run again after a quiet gap of at least 5 s. If that passes, or the Journey no longer passes
   unheld, the proof is `inconclusive`, because state may cross replays. If both held replays fail and the unheld one
   passes, the hold is what breaks the claim, and the proof goes on.
3. **One replay per mutation**, each held to floors: from the mutated step on, it cannot leave a step or read its end
   state before the base did plus a margin of 1 s and a quarter of the base's time on the mutated step. Before the end
   state, it waits for its open writes as the base did. A claim wait runs past what the base's claim took, and no
   further than the larger of that and the hang threshold. If a failure at the step's own claim hides later paired
   sites, a relaxed replay of the same mutation reads them. If an earlier check still hides a site, a targeted replay
   relaxes it.
4. **A matched control**, only when needed: a fresh replay as recorded on the same floors. It must pass the site and
   reach it within the margin of the mutated replay, in either direction. A `sensitive` reading needs one when the
   site was reached inside twice the margin of the base's time, or the replay was held on the way there. Mutations of
   one step share a control. A targeted proof always has its own, with the same relaxations and floors, because it also
   answers whether relaxing broke the site.
5. **The mutation at the base's time**, only when the control failed at the same site: the mutated replay held with
   no margin. A pass reads `insensitive`, since the claim held without the mutation. A failure reads `cascade`.
6. **Disagreement**: when one mutation of a step fails a site and another passes it, a control runs and the failing
   mutation runs once more. If the failure reproduces, `sensitive` stands, since skip and block can really differ. If
   the re-run passes the site, the failure is struck and the site reads `insensitive`, since a replay saw the claim
   hold with the mutation applied. If neither is clear, the proof is `inconclusive`.
7. **The closing replay**: as recorded, last, when the verdict could still change.

A blocked write's recorded lines stay blocked for the rest of that replay, except while a later step that records the
same line runs. If one is answered anyway (a popup, a worker), that mutation reads `not-applied`. Open writes are
counted when they go to the Journey's own origins or a line it recorded, and a line it did not record that repeats is
background. A write still open when any replay closes makes the proof `inconclusive`, and nothing further runs, as
with a failed fixture restore. A mutated replay that stopped early still stays open as long as the base did.

### What a proof assumes

A `proven` verdict says what was shown, and no more: this Journey's checks noticed when a recorded step was changed,
under the conditions the proof ran in. It does not say the Journey's checks are right in general, or that a real job
can be done. A job being doable is shown by a successful run with a done check, not by a mutation proof. The verdict
holds only if all of these are true. Each one that fails can produce a false reading.

- **No one-off slowdown that nothing cross-checks.** A job can run slower in one mutated replay than in any other,
  so that a claim fails with room to spare. Nothing catches that unless the failure was thin or held, or a sibling
  mutation of the step passed the same site. A mutation with no sibling, or whose sibling also failed, reads
  `sensitive`.
- **State from one replay reaches the next only where the independence replay would meet it.** A job that
  lands after the independence replay ends, and changes what a site reads only inside one mutated replay, reads
  `sensitive` if that replay has no sibling that passes. So does a change made to the app from outside the proof.
- **A control and a mutated replay see the same app.** A control that passes says the hold did not break the claim. It
  cannot say the mutated replay was not unluckily slow, so a job slow only in that replay reads `sensitive` even when a
  control ran. Siblings that share a control may reach a site up to the margin apart, so a claim that decays in that
  gap is not told apart.
- **Sibling mutations of a step are the cross-check.** Disagreement is looked for only between mutations of the same
  step. Two siblings that both fail for a reason other than the mutation read `sensitive`.
- **A resumed proof's reused results still describe the app.** A resume measures a new base and runs the independence
  replay again, but a reused pair ran against the app as it was then.
- **A blocked write's retry uses a recorded line.** A retry on a path the step never recorded is a new write and gets
  through. The site then reads `insensitive`, or `sensitive` for what remains, on an app the block no longer describes.
- **An aborted write ends soon.** A write the browser gave up on keeps its replay open for 2 s. A server still working
  after that is seen only through the independence replay.

Some readings are limits rather than assumptions: they are never `proven`, but they say less than the Journey deserves.

- A claim that really depends on the mutated write and also decays inside the hold (a toast shorter than the margin)
  reads `cascade`, and the proof `inconclusive`: the experiment cannot tell it from a claim the hold broke.
- A failed fixture restore, a write left open, and state crossing replays stop the proof at once, so sites not yet
  reached read `error`. Fix the cause and run it again.

#### Following and resuming a long proof

`journey verify <id> --mutate` writes a progress receipt to `.jevitate/logs/verify-progress/` as it goes, atomically,
after each pair (one planned mutation with all its replays). `journey verify <id> --status` reads it: live, exited
or stale verifier (pid plus the kernel's start time, so a reused pid is `stale`), pairs finished of the total, the
current pair, and whether a resume could run. It opens no browser, runs no hook and reads nothing of the app's.
MCP: `verify_journey` with `status: true`, which answers even while the same server is running that proof.

`journey verify <id> --mutate --resume` (MCP: `mutate: true, resume: true`) continues an interrupted proof with the
same flags. The base replay runs again and must pass, the pair that was interrupted runs again, later pairs run,
and finished pairs are reused. A pair with an errored replay is not reused: it runs again, in an interrupted proof
and in one that finished `inconclusive` on errored replays and nothing else, which `--resume` also accepts. Nor is a
pair that skipped its control because the verdict looked decided: another pair's error may be why, and the resume
repairs that, so the pair runs again and decides afresh whether its control is needed. A proof whose independence replay errored is such a proof: the resume runs that replay again against its own base, as every resume does, and an error there leaves it `inconclusive`. The closing replay always runs. The result says how many pairs were reused in
`reusedPairs` (0 on a run that did not resume), each one is marked `reused: true`, and the verdict comes from the
same rule over the same results as an uninterrupted proof. A plain `--mutate` starts again and replaces the
checkpoint, unless a live verifier owns it, in which case it runs without progress of its own.

A resume never starts over silently. It exits 2 with `E_JOURNEY_VERIFY_RESUME_REFUSED` and a reason in `data.reason`:

| `reason` | Why |
| --- | --- |
| `no-checkpoint`, `finished`, `live-verifier`, `other-host` | nothing to resume (`finished`: the proof ended with a verdict a re-run of errored pairs could not change), or a verifier owns it or cannot be checked from this host |
| `journey-hash`, `mutation-plan`, `params`, `hook`, `origin`, `browser`, `cli-build` | what the proof ran under changed. A build that cannot name itself counts as changed |
| `too-old` | a reused result is over 24 hours old |
| `corrupt`, `integrity`, `not-regular-file`, `key-unavailable`, `not-writable` | the file is damaged or was changed outside jevitate, a link or FIFO is at its path, or the key below cannot be used |
| `base-failed` | the Journey as recorded no longer passes |
| `pace`, `isolation` | the base, measured again, is slower than a reused failure allows (it reached a site sooner than the new base passes it, or with little to spare and no control), or left fewer writes open than a reused replay did. Controls are held to the same checks |
| `unknown-record` | the checkpoint holds a kind of replay this build cannot re-check |

Timing is why a resume on a slower or busier machine can be refused: a reused failure counts only against the base
measured now. Run the proof again from the start.

The checkpoint holds outcome classes, structured failed sites, site keys, mutation ids, step timings and write
counts. It holds no hook text, parameter value, failure message, blocked request path or page text. On a reused pair
`reason`, `blockedWrites` and `controlDiagnostics` are therefore absent, and a targeted refusal's or a retry's wording
says it was not kept. The verdict reads none of these. Hooks, params, origin and browser settings are compared by
HMAC-SHA-256 under a random key in `~/.jevitate/verify-checkpoint.key` (mode 0600), which also signs the file. The
signature proves the file came from this user's own runs. It does not stop that user's own processes, which can read
the key, nor someone putting back an older genuine file: a rollback reads as that earlier proof, within the 24-hour
limit. Only the bytes of a fixture file, a `--fixture-identity` session file and a `--storage-state` file and the text
of a hook are bound: a script a hook calls, and a new deploy of the app between the two runs, cannot be detected, beyond
the base and closing replays having to pass.
Receipts stay until the next proof of that Journey replaces them; `logs prune` does not remove them.

The key protects against a change to the file, not against everything. Someone who can write `.jevitate/` but cannot
read the key cannot make up a result, but can delete the checkpoint, or put back an older one this user's own run wrote
for the same configuration within the 24 hours, which forgets any later pairs and any later taint such as a failed
restore. That person can also edit the Journey and the proof receipt in `.jevitate/journeys/` directly, so treat
`.jevitate/` as you treat the rest of the repository. A process running as you can read the key and sign anything.

A coordinator that dies takes a verifier with it unless the run set `JEVITATE_PARENT_WATCHDOG=off`; either way the
finished pairs stay on disk. A killed verifier never ran its `after` hook, so use a `--before` that resets the app.

A closed output pipe never becomes a result. A closed stderr only stops progress lines. With stdout closed, a
command keeps the exit code it set; one still running finishes first; and if no verdict was reached, it exits
2. Only a command with no code to keep (`jevitate <cmd> | head -1`) exits 0.

`64` is `EX_USAGE` from `sysexits.h`. It is deliberately not a small integer, so a new outcome code
(such as `5`) never collides with it. A refused command's code comes from its error code: `_ARGS`, `_INPUT`,
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

### Journey run outcomes (#453)

`jevitate journey run` (and MCP `run_journey`, whose result carries the same `exitCode`) ends in one of:

| Journey outcome | Exit code | Mission outcome | Meaning |
|---|---|---|---|
| `ok` | 0 | `clean` | every step and the end state held as recorded |
| `healed-pending-review` | 5 | `pending-review` | a self-heal completed the run only after retargeting steps the change explains; a proposed revision was written and nothing passes until a person accepts it |
| `heal-exhausted` | 1 | `defects-found` | the break was explained but every candidate (or the budget) ran out; the attempts are in the result |
| `quarantined` | 1 | `defects-found` | a step failed and no self-heal ran, or the change does not explain the break (`heal.verdict: "unexplained"`: a likely regression) |

Exit `5` is not a failure and not a pass: review the proposal (`jevitate journey review <id>`), then
`journey promote <id> --proposal <pid>`. Missions never end `pending-review`.

The MCP tool `get_mission_result` returns the same status and code for a
finished run; a broken run comes back as an error result. Its `id` is a result stem —
`explore-<stamp>` (a goal run: `status` is its canonical `missionOutcome`, and its own
`succeeded`/`failed`/`exhausted`/`blocked` comes back beside it as `goalOutcome`), `coverage-`, `exploratory-`, `adversarial-`, `feature-` or
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
| `defects-found` | `defects-found` | 1 | only when a violated declared invariant overrode an `inconclusive` budget or vacuous-check stop (#423: a defect no longer replaces `succeeded`/`failed`/`exhausted`/`blocked` — see the table below) |
| `inconclusive` | `inconclusive` | 2 | the run could not do its work (page never rendered, a required model call stayed unavailable) — or every failing success check was **vacuous** (#202: satisfied before the run's first action), so the run proved nothing either way: `failure.kind: "vacuous-check"`, naming the check |
| `not-started` | `inconclusive` | 2 | #448: the run executed **zero actions** (no controls offered, the auth check failed, a preflight failed), so nothing was exercised — never `clean`, never `succeeded`, whatever else it saw; treated exactly like `inconclusive`. `goalReason` says why (`no-controls`, `auth-failed`, `preflight-failed`, `no-actions`). Defects found passively (console, server log) are still listed in `defects[]` but do not make the run "exercised". A zero-action hang, crash or environment ending (starved host, unreachable target, …) keeps its own outcome. `--allow-vacuous-checks` is the operator's explicit acceptance of a goal that already held before any action: its `succeeded` stays |
| `crashed` | `crashed` | 2 | the engine failed (browser/page crash, unexpected exception) |
| `hang` | `hang` | 3 | the app under test hung, and it reproduced on replay |
| `intermittent` | `intermittent` | 4 | a hang was observed but did not reproduce on every replay |

#### Goal outcome × defect outcome (#423)

A goal run carries two orthogonal verdicts: `goalOutcome` (did the agent reach the goal?) and
`defectOutcome` (did the app break? `{status: "none" | "defects", byKind}`, counting the gating
entries of `defects[]` per kind — an HTTP 5xx, a violated invariant, a `--log-defect` match; see
[results](./results.md)). A defect never replaces `goalOutcome`: a goal reached on an app that
answered 500 is `goalOutcome: "succeeded"`, `defectOutcome.status: "defects"`. `missionOutcome` —
and so the exit code — is derived from both by ONE table (`goalMissionOutcome`,
`packages/domain/src/mission-outcome.ts`; the result schema and MCP `get_mission_result` check it):

| `goalOutcome` | `defectOutcome: none` | `defectOutcome: defects` |
|---|---|---|
| `succeeded` | `clean` (0) | `defects-found` (1) |
| `failed` / `exhausted` / `blocked` | `defects-found` (1) | `defects-found` (1) |
| `defects-found` | `defects-found` (1) | `defects-found` (1) |
| `hang` | `hang` (3) | `hang` (3) |
| `intermittent` | `intermittent` (4) | `intermittent` (4) |
| `inconclusive` / `crashed` | that outcome (2) | that outcome (2) |
| `not-started` | `inconclusive` (2) | `inconclusive` (2) |

Every exit code is the same as in 0.7.0. In particular a goal that was not achieved with no defect
still exits 1 (the long-standing "the check failed" code): read `defectOutcome.status: "none"` and
`goalReason` to tell "untested because the agent could not do it" from "tested and found bugs". A
hang or a broken run dominates its defects, which are still listed and counted.

`goalReason` (on every goal result whose `goalOutcome` is not `succeeded`) says why the goal was not
achieved, decided by code from the run's state, never parsed from `reason`:

| `goalReason` | Meaning |
|---|---|
| `success-check-failed` | `failed`: the model said done, but an independent success check did not hold |
| `not-found` | a find-out goal's report found no answer on the pages it searched |
| `ungrounded` | the model's answer was rejected as not grounded on the observed pages until the run gave up |
| `blocked-by-policy` | the model gave up after the safety policy refused a control it chose |
| `gave-up` | the model reported the goal cannot be advanced from the page (no more specific cause known) |
| `no-progress` | the run stopped because its actions left the page unchanged |
| `budget` | `exhausted` (the action/decision budget), or a spend budget (`stop: "budget"`) |
| `hang` | `hang` / `intermittent` |
| `vacuous-check` | every failing check was satisfied before the first action |
| `broken-run` | the run itself broke or proved nothing: a crash, an unreachable or unresponsive app, a starved host, an unreadable `--log-defect` oracle, a kill |
| `defects` | `goalOutcome: "defects-found"` with no more specific cause |

The human summary prints both: `GOAL blocked (not-found, stop: blocked)` and `DEFECTS server-log 2`
(or `none`). `jevitate report` shows them per run, and `check`'s `--fake-ai` rule (a goal-only miss is
inconclusive under the fake judge) no longer hides a defect the run found.

**Goal / explore loop — `stop: StopReason`**, why the loop itself stopped acting (folds into
the `goalOutcome` above; not separately exit-coded):

| `stop` | Meaning |
|---|---|
| `done` | the loop ended on the model's `done`: code accepted the proposal (the transcript says "done accepted provisionally" when a check — a `reloadThen`, or one holding since before any action — is still left to the final verdict, which may still fail it: `goalOutcome: "failed"`), or code rejected it repeatedly until it stopped taking proposals (`goalOutcome: "failed"`) |
| `blocked` | the model decided it could not proceed |
| `exhausted` | the action or decision budget ran out |
| `no-progress` | the same state repeated with no forward movement (the no-progress detector), or the run went round a loop: for 4 round trips it alternated between at most two actions and two page states (a link and its Back link, a disclosure toggled open and shut, scrolls flipping between the same positions) with no write request sent and nothing new on the page — the reason names the loop. A no-progress reason's `last blocker` is the latest failed or rejected action |
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
| `scope-unreachable` | the start URL did not stay in scope (e.g. it redirected to a login page), or a declared [scope region](./exploration.md#scope-regions) never matched the start page (or the page after a reset): `inconclusive`, `failure.kind: "target-unreachable"`, never `clean` |
| `target-unresponsive` | the app stopped answering mid-run (e.g. its server froze): a navigation got no response — `inconclusive`, `failure.kind: "target-unresponsive"`, `failure.message` in plain words (`the app stopped responding to navigation to /app (timed out before any response)`), never `crashed` and never a stack trace |
| `identity-changed` | an action switched the signed-in identity (#300, listed in `identityChanges`) and the original identity could not be restored: no fresh session could be opened from the original storage state, or the fresh session was someone else. `inconclusive`, `failure.kind: "identity-changed"`. A defect found before still wins. A switch that was restored doesn't stop the run. |
| `stalled` | the page's renderer stopped answering (frozen, starved or wedged) and the liveness watchdog closed it so the run could end — `inconclusive`, `failure.kind: "stalled"`, no stack trace; never `crashed`, and never attributed to jevitate (the same ending closes a goal run as `stop: "inconclusive"` and a coverage/feature run as `stalled`) |
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

A freeze usually shows up first as a hang (a click's request or navigation that never answers) or a
no-progress stop, not as a failed navigation. Before any hang or no-progress stop becomes a finding
— and before it is blamed on a starved host — the run asks the app directly (#230), the same way in
goal, usability, adversarial, coverage/exploratory and feature runs:

- **The probe:** one fresh, cookie-less `GET` from outside the page, for the page the run is on (its
  origin and path; the query is dropped so a one-shot token isn't re-sent). That page already answered
  once. Any HTTP response counts as an answer, whatever its status. The probe waits up to 10 s.
- **The app stopped answering** when that probe gets no response at all within 10 s, or the
  connection is refused. The run ends `inconclusive` / `target-unresponsive` with a plain reason
  (`the app stopped responding on /app (a fresh request for it got no response within 10s)`).
  There's no hang finding, no `environment-degraded` entry and no `next: verify-fix` or `ledger add`
  hint. This rule wins over host starvation: a starved host makes a live server **slow**, but it
  doesn't make it withhold every response for 10 s.
- **The machine is too slow** when the app answers the probe, however late. The hang stands as a
  finding, or it's `environment-degraded` on a starved host (below). A single stuck endpoint on a
  server that still serves the page is a real `request-pending` hang, not `target-unresponsive`. So
  is a separately hosted API that freezes while the page's own server keeps answering.
- **Inconclusive probes don't count.** A probe that fails for any other reason (a TLS or DNS quirk
  of the probe itself) proves nothing, and the finding is judged as before.

### Bounded startup retries (`attempts[]`, #742)

A direct target can refuse the FIRST navigation before any response even while the origin answers a
plain HTTP probe with 200 — a slow dev server, a transient DNS or connect hiccup. Instead of
finalizing `target-unreachable` on the first try, the run retries the first navigation/browser launch
a short, bounded number of times, before any action or write; a retry never hides a policy refusal
and never widens the target's allowed origins. Every run that tries a startup records what each try
did in `attempts[]` — one entry per attempt, oldest first:

| Field | Meaning |
|---|---|
| `index` | the attempt's 0-based position in the sequence |
| `errorClass` | the browser error class: `dns`, `connectivity`, `navigation-timeout`, `browser-launch`, `origin-readiness`, or `unclassified` — or `null` for the attempt that reached the target |
| `message` | a plain-words, redacted reason (empty when the attempt succeeded) |
| `startedAt` / `endedAt` | epoch milliseconds (from `clock.now()`) the attempt began and ended |

`origin-readiness` is the distinct class for a healthy HTTP probe beside a failed browser
navigation; `dns` is a name that did not resolve, `connectivity` a host that did not accept the
connection, `navigation-timeout` a navigation that never answered, `browser-launch` a browser or
context that would not start, and `unclassified` anything else. `attempts[]` is additive: a result
written before #742 has no `attempts` and parses unchanged (`startupAttemptsOf` and
`StartupAttemptSchema`, `packages/domain/src/mission-outcome.ts`).

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
| driver event-loop lag | > 500 ms (longer than the settle rule's quiet window) **and** load ≥ 1 runnable task per core. The lag histogram also counts the driver's own synchronous work, so lag with idle cores (e.g. 506 ms at 0.70/core) is self-inflicted and never counts (#213) |
| CDP round-trip (#452) | a cheap CDP command (`Browser.getVersion`) to the run's browser takes > 1000 ms; a probe with no reply in 5 s reads as 5000 ms (the browser is unresponsive). Reported as `hostHealth.peakCdpLatencyMs` |
| render trend | the median of the last 3 renders ≥ 5x the run's baseline (median of its first 3) and ≥ 3 s, **and** a host sample in the last 15 s at load ≥ 1 runnable task per core (#368). A slow render is a symptom, not host evidence: on a healthy host (spare cores, free memory) slow renders are the app's own timing — reported in `slowestRenderMs` and the timing summary, and a hang or no-progress stop they cause is judged as an app finding — never "the host was starved" |

A render is the page's own time: a navigation's DOMContentLoaded, or an action's time to settle
**without** any explicit wait the run chose in between — a chat reply wait (`--reply-wait-ms` /
`--reply-ceiling-ms`), a job wait (`--job-wait-ms`), a `wait` decision (#368). That wait is reported
on its own as the step timing's `waitedMs`. A reply that never arrives is the run's own finding: the
goal reason starts `no reply within 30s to the last message sent ("…")`, never an environment verdict.
`--reply-ceiling-ms` bounds the total wait for one sent message's reply — the send's own wait plus
every `wait` decision after it, never one wait cycle at a time (#373): once it is spent, another
`wait` ends the run (`no-progress`) with that reason instead of listening on.

A starved sample explains the 15 s after it. Then:

- a hang, a click timeout or a no-progress stop met while the host was starved is listed in
  `environmentDegraded` (`finding`, `detail`, `cause`, `step`, `advisory: true`) — never a
  defect or hang finding. A goal run that ends on one is `inconclusive`
  (`failure.kind: "degraded-environment"`);
- a run most of whose steps (> 50%) ran starved is `inconclusive` with
  `failure.kind: "degraded-environment"` instead of `clean` (goal: instead of `exhausted`, `blocked`
  or `failed` — a success check missed after the model's `done` is a miss a starved host can cause
  too, so its `goalOutcome` and `missionOutcome` are both `inconclusive`, exit 2).
  A confirmed defect, a `succeeded` goal and a crash keep their outcome. So does a usability job whose
  completion code verified: its `--success` checks held, or its `done` was proven by save or sign-in
  signals. Only an ending the model alone judged (`verifiedBy: "grounded-judgment"`) is downgraded (#213).
- the degraded reason is one sentence with the peak readings, followed by what the run would have
  ended as without the starved host. A goal whose check didn't hold still names that check (#213):
  `3/4 steps ran on a starved host (peak load 3.50/core, min free memory 6144 MiB), so the run proves
  nothing about the app; otherwise it would have ended failed: success check … did not hold`.
- a start page that doesn't load in time (a bare timeout, not a network error) while the host is
  starved is `degraded-environment` with an `environmentDegraded` `page-load-timeout` entry, not
  `target-unreachable`. This holds when a fresh request for the page still answers. A page that
  doesn't answer at all stays `target-unreachable` (#230). In a persona matrix, a persona whose runs
  never observed the app is left out of the persona diff (`diff.notCompared`, printed as `DIFF
  <persona>: not compared — …`), so a starved load never reads as an access difference (#213).

A run that STALLED while those signals show starvation is `host-starved` (#452): the stall
(`failure.kind` `stalled` or `target-unresponsive`, or a bare page-load timeout) is classified
`inconclusive` with `failure.kind: "host-starved"`, and `failure.message` records the measurements
(peak CDP round-trip, peak driver event-loop lag, a page load against the run's own baseline, the
starved samples' causes). Here the lag counts without a corroborating load reading, because the run
did stall. It is never `crashed` and never a finding about the app. It differs from
`degraded-environment` (most STEPS ran starved, so a pass/fail proves nothing): host-starved is a
stall. Both are environment failures in `jevitate sweep`, and a sweep retries a `host-starved`
target once (see [sweeps](./sweeps.md)). With `JEVITATE_HOST_STARVATION=off` nothing is classified `host-starved`.

Every result carries `hostHealth`: `peakLoadPerCore`, `minFreeMemoryBytes`,
`peakEventLoopLagMs`, `peakCdpLatencyMs` (when the run took a CDP probe), `slowestRenderMs` (and the `baselineRenderMs` it is judged against),
`steps`/`degradedSteps`, `degraded`, the distinct `starvation` causes (one per kind of signal, not one per reading), and `attribution`.
`JEVITATE_HOST_STARVATION=off` keeps the sampling and the summary but never attributes a finding to
the host (`attribution: "off"`) — for a harness that guarantees a quiet host itself.

`hostHealth.resources` (#205) records what resource governance did during the run: the
machine-wide browser cap and slot, the most severe throttle level and every change, the memory
ceiling, and the peak browser memory. A run whose browsers went over the memory ceiling ends
`inconclusive` with `failure.kind: "resource-limit"`, and `failure.message` names the measured
value and the ceiling. It is never `crashed` and never a finding about the app; adversarial runs
report `stop: "resource-limit"`. A run refused on a starved host fails with `E_HOST_STARVED`
(exit 2) before any browser opens. See [operations](./operations.md#shared-machines-resource-governance).

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

For `coverage`/`exploratory`, a declared [scope region](./exploration.md#scope-regions) that never matches ends `scope-unreachable` (`inconclusive`, `failure.kind: "target-unreachable"`); the frontier enqueues only in-region controls.

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
