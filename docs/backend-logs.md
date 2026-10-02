# Backend log correlation

Tail your backend's logs during a run, attach them to the step that caused them, and optionally treat matching lines as defects.

## Backend log correlation

`--log-source <spec>` (repeatable; every strategy, including `--strategy usability`) tails a
backend log for the run and correlates its lines to the step they landed during — turning "blocked:
could not verify plan limit" into "blocked: the server denied `GetActiveRatePlanForOffer` for this
user". Sources are **operator-declared, read-only and never the model's choice** — CLI/local-config
only, never part of an MCP `MissionRequest`. A `server-log` defect is listed in the result's
`defects` on every strategy, like any other defect ([result schema](./results.md)). On a usability
run it is marked `advisory: true`, like every other UX finding — it never gates
`missionOutcome`/`exitCode`. (The 0.2.0 `serverLogDefects` alias of the server-log subset was
removed in 0.3.0; read `defects` with `kind: "server-log"`.)

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
then a bracketed/bare level with an optional leading ISO timestamp. .NET is read too: the default
console formatter's `fail: Category[id]` header with its indented continuation lines (grouped into
one entry per source), the JSON console formatter's `Timestamp`/`LogLevel`/`Category`/`Message`
keys, and Serilog's `[HH:mm:ss ERR] SourceContext message` console theme. A JSON message nested in
`fields.message`/`fields.msg` (Rust `tracing`) or `@message` is extracted instead of the raw object.
A line that matches none of these keeps its arrival order and an `unknown` level rather than being
dropped.

**Ignoring noise.** `--log-ignore <regex|substring>` (repeatable; `/regex/flags` or a plain
substring, over the raw line) drops known-noise lines, such as a background job's expected error,
from both correlation and the `--log-defect` oracle. They still count in the source's `linesRead`
(proof it was tailed) and are reported separately as `serverLogs.ignoredLines`.

**Scoping a shared log to one run.** When several runs tail the same log (concurrent missions
against one backend), `--log-scope <regex|substring>` (repeatable, the same grammar) attributes only
the lines that match it, such as the tenant or account the run signs in as. The rest count as
`serverLogs.ignoredLines` (`serverLogs.correlation.outOfScopeLines`) and never become evidence or
defects. A line that carries one of the run's own correlation ids (below) is always in scope.
`verify-fix` re-checks a `server-log` defect with the same scope.

**Correlation by request id.** Every request the run's page sends is recorded with the correlation
ids it carries, on the request or the response: the W3C `traceparent` (its trace id), `x-request-id`,
`x-correlation-id`, `request-id`, `x-amzn-trace-id` (its `Root`), `x-b3-traceid`,
`x-cloud-trace-context`, plus any header named by `--log-correlation-header <name>` (repeatable). A log
line that contains one of those ids (as a whole token, never a prefix) is attached to that exact
request and to the step that sent it, whenever the line landed. A slow background failure is not
blamed on whatever step was running when it was logged. The line's evidence carries `request:
{ method, url, status, id }`, and so does a defect's first occurrence. Once a line has matched one
of the run's ids, a line that carries a different id is someone else's work: another user, another
run, or a background job. Such a line is never attributed to the run
(`serverLogs.correlation.foreignLines`, counted in `ignoredLines`). An id is recognized in a line
when it is keyed as `trace_id`/`traceId`/`request_id`/`requestId`/`correlation_id` (`=` or `:`),
or written as a `traceparent`. For any other format, `--log-id-pattern </regex/>` (repeatable; the
first capture group is the id) says how ids are written. Lines with no id fall back to the time
window below. `serverLogs.correlation` reports `requestsWithIds`, `idMatchedLines`, `foreignLines`
and `outOfScopeLines`.

**Correlation.** Each step's window runs from the previous step's settle time to this step's own
settle time — the wall-clock epoch a mission's incremental transcript-flush listener already
observes, so this needs no change to the mission loop. The LAST step's window is additionally held
open for `--server-log-drain-ms` (default 3000, operator-settable up to minutes) so async backend
work that settles after the browser gave up is still caught: the run's own await for this only
happens AFTER the mission function has returned, so a log source never blocks a mission's own
budget or progress. Only `warn`/`error` lines (or any line a `--log-defect` matcher below hits,
whatever its level) are attached as evidence, redacted with the run's own `--secret` list, to the
step's transcript entry (`serverLogs`) and to any defect or `blocked` reason on it. A `blocked`,
`exhausted` or `inconclusive` reason also names the last step's correlated server error (or
warning), e.g. `field "Email" is invalid; server: error Api.Controllers.Signup "duplicate key…"`.
When that line was correlated to its exact request by id, the reason names the request:
`… the page shows alert "Publishing is not available"; caused by: error "publish refused: plan
quota exceeded" on POST /api/publish (409)`. Only the last step is consulted (and, when the run
ended on `blocked`, `done` or `report`, the action just before it), so a stale earlier error is
never blamed for the current blocker.

**Optional oracle.** `--log-defect <level|/regex/>` (repeatable) makes a matching line a defect kind
`server-log`: `error`/`warn`/`info`/`debug` matches as `level >= this`; `/pattern/flags` is compiled
once via `new RegExp` (never `eval`ed, bounded to 500 chars) and matched against the RAW line.
Its fingerprint is the normalized message (ids, numbers, uuids and timestamps stripped) and the
logger's category, plus the correlated step's templated route (ids in the URL are folded, so two
occurrences on `/orders/17` and `/orders/42` are one defect) (`"(run)"` for a line outside every step window). `verify-fix` re-checks a
`server-log` defect by replaying its recorded steps in a fresh session AND re-tailing the SAME log
source(s) for the same drain window — never by looking for it among DOM/console/network signals,
which a backend log line is none of. A `cmd:` source needs `--allow-log-cmd` on `verify-fix` too.

**Result and outcome.** `serverLogs` on the result carries counts by level, the top normalized
messages, each source's `opened`/`linesRead`/`truncated`/`error`, and `oracleOk` — false when
`--log-defect` was given and any declared source failed to open or delivered not one line (a
`docker:`/`cmd:` source that exits non-zero before its first line counts as failed, not quiet). A
source that is legitimately quiet is declared with `--log-quiet-ok <spec>` (repeatable, the exact
`--log-source` spec); its zero lines then do not make the oracle unhealthy. A found
`server-log` defect counts as `defects-found` (exit 1), same as a declared-invariant defect. An
unreadable oracle (`oracleOk: false`) turns an otherwise-`clean` run `inconclusive` (exit 2) rather
than a false clean — its absence of defects proves nothing when the source that would have caught
them was never demonstrably read. (A usability run keeps its own advisory rule instead: see above.)

**MCP / the mission queue.** A `MissionRequest`/`queue_exploration`/`verify_fix` argument may never
name a path or a command (`packages/missions/src/schema.ts`). An operator declares `logSources` /
`logDefect` / `allowLogCmd` / `logQuietOk` / `logIgnore` / `logScope` / `logCorrelationHeaders` /
`logIdPatterns` / `logTriage` per origin in `~/.jevitate/targets.json` instead:

```json
{ "https://app.example.test": {
    "logSources": ["docker:app-1"], "logDefect": ["error"], "allowLogCmd": false } }
```

`jevitate mission run` (the queue drain) resolves this by the queued mission's target origin and
applies it exactly like `--log-source`/`--log-defect` would — a queued mission itself carries no log
source of its own. `verify_fix` over MCP re-checks a `server-log` defect's sources the same way
CLI's own `verify-fix` does (they're persisted with the defect); `allowLogCmd` for a `cmd:` source
still needs this same targets.json opt-in, never a tool argument.

## Signal triage: only the lines that relate to a defect (#313)

`--log-triage` (with at least one `--log-source`, every strategy) records the run's whole signal
timeline and attaches to each defect only the lines that relate to it, so the evidence that goes
into an issue or a fix session is a handful of lines instead of the whole log.

1. **The timeline.** `<run>.signals.jsonl`, next to the result: every backend line at every level
   (not only `warn`/`error`), plus the browser's console messages (every type), uncaught page errors
   and failed requests. Each entry is `{epochMs, source, level, text, step?, recordingStepIndex?,
   request?}`, redacted (the run's `--secret`s, credential shapes, sensitive URL parameters) and
   bounded (20,000 backend lines, 5,000 browser signals, 2,000 characters per entry; `signals.truncated`
   says when a cap was hit). Out-of-scope (`--log-scope`) and foreign-id lines are never on it.
2. **Code prefilter, per defect.** The lines correlated by request id to the defect step's request
   are kept as they are (`keptBy: "request-id"`). The candidates are the other lines in the defect
   step's window and the step before it, deduped by normalized message, most severe and nearest
   first, at most 150. A defect without a step takes the run's error/warning lines.
3. **Jev relevance (with `--real`).** Each candidate is a yes/no question to Jev, batched 25 per call,
   at most 200 calls per run: is this line part of the defect's cause or a direct consequence of it?
   Jev judges it against the defect, the step's action and the lines already correlated to the
   defect's request. A Jev call costs a small fraction of what a generative model would spend
   reading the same lines, so the limits are generous on purpose: the expensive model downstream
   reads only what Jev kept.
   A line scored at or above 0.5 is kept (`keptBy: "jev"`, with its `score`). With `--fake-ai`, or
   once the per-run cap is reached, the candidates' error/warning lines are kept instead
   (`keptBy: "window"`).
4. **Where it goes.** `defects[].relatedLogs` on the result (and the persisted result file), a
   `## Related logs` section in each defect's issue draft, and a run-level `signals` summary
   (`path`, `entries`, `truncated`, `triage: {mode, defects, candidates, kept, jevCalls, capped}`).
   `jevitate report` (MCP `get_report`) carries each consolidated defect's `relatedLogs` (the most
   recent run's, at most 20) and lists them in `report.md`, so an agent reads the kept lines, not
   the log.

`jevitate logs triage --result <run>.result.json [--real|--fake-ai] [--threshold <p>] [--secret …]`
re-triages a finished run from its saved timeline (for a ticket, or with a different threshold).

**Runs without a command line.** A queued mission (MCP `queue_exploration`, drained by `mission run`)
or a suite run takes the opt-in from `~/.jevitate/targets.json`, next to the origin's `logSources`:
`"logTriage": true`. A `jevitate check` suite item (or target) takes `"logTriage": true` too. Jev scores
relevance when the drain or the check runs with `--real`, else by code. Every MCP
result and report then carries `relatedLogs`.

What it never does: Jev only chooses which lines travel with a defect. Whether a defect exists is
still decided by code (hard signals, invariants, `--log-defect`), and a defect with no related lines
is still reported. Sending log text to the judgment model is the operator's decision per target (the
flag, or `targets.json`): a request never turns it on, so `--log-triage` and `logs triage` are not
MCP arguments or tools, like `--log-source` itself. Their output reaches MCP callers in every result. Log text is data,
never instructions, for Jev and for anything downstream that reads `relatedLogs`.
