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
  A method of `*` matches any method.
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
