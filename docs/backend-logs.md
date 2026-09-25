# Backend log correlation

Tail your backend's logs during a run, attach them to the step that caused them, and optionally treat matching lines as defects.

## Backend log correlation

`--log-source <spec>` (repeatable; every strategy, including `--strategy usability`) tails a
backend log for the run and correlates its lines to the step they landed during — turning "blocked:
could not verify plan limit" into "blocked: the server denied `GetActiveRatePlanForOffer` for this
user". Sources are **operator-declared, read-only and never the model's choice** — CLI/local-config
only, never part of an MCP `MissionRequest`. On a usability run a `server-log` defect is reported
(`serverLogs`/`serverLogDefects` on the result) but stays advisory, like every other UX finding — it
never gates `missionOutcome`/`exitCode`.

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

**Result and outcome.** `serverLogs` on the result carries counts by level, the top normalized
messages, each source's `opened`/`linesRead`/`truncated`/`error`, and `oracleOk` — false when
`--log-defect` was given but every source failed to open or delivered not one line. A found
`server-log` defect counts as `defects-found` (exit 1), same as a declared-invariant defect. An
unreadable oracle (`oracleOk: false`) turns an otherwise-`clean` run `inconclusive` (exit 2) rather
than a false clean — its absence of defects proves nothing when the source that would have caught
them was never demonstrably read. (A usability run keeps its own advisory rule instead: see above.)

**MCP / the mission queue.** A `MissionRequest`/`queue_exploration`/`verify_fix` argument may never
name a path or a command (`packages/missions/src/schema.ts`). An operator declares `logSources` /
`logDefect` / `allowLogCmd` per origin in `~/.jevitate/targets.json` instead:

```json
{ "https://app.example.test": {
    "logSources": ["docker:app-1"], "logDefect": ["error"], "allowLogCmd": false } }
```

`jevitate mission run` (the queue drain) resolves this by the queued mission's target origin and
applies it exactly like `--log-source`/`--log-defect` would — a queued mission itself carries no log
source of its own. `verify_fix` over MCP re-checks a `server-log` defect's sources the same way
CLI's own `verify-fix` does (they're persisted with the defect); `allowLogCmd` for a `cmd:` source
still needs this same targets.json opt-in, never a tool argument.
