# Adversarial scope, hangs, settling and timing

How exploring missions stay in scope, what counts as coverage, how hangs are detected and confirmed, and what Jevitate measures about page timing.

## Starting from a Journey step

Every strategy except `--feature` can start from a promoted Journey instead of a bare URL:
`jevitate explore --from-journey <id> --at-step <anchor|n> --strategy <s>` replays the Journey's
prefix in the mission's own browser context (page, form contents and session kept), and the mission
starts on the live page — its scope is that page's route, as if it were `--url`. A prefix that no
longer replays ends the run `inconclusive` (`failure.kind: "journey-stale"`, exit 2). Results carry
`branch: { journeyId, step, anchor? }`. `--at-step all` (or `anchors`) sweeps every step, and a
reset inside an anchored mission re-replays the prefix (its steps count against `--max-actions`). See [Explore from a Journey step](./journeys.md#explore-from-a-journey-step-anchors-and-campaigns)
for anchors, campaigns and the known limits.

## Adversarial scope, form misuse and coverage

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
- a submit with boundary or invalid values (empty, an inert markup canary, edge, long, an
  attribute-break canary, unicode with RTL override and zero-width characters, invalid, oversize
  ~100 KB), one per round, chosen by the field's type (a number or date field never gets text);
- edit, then Cancel, then Save;
- a reload with unsaved edits;
- acting again while the save request is still pending.

It also acts once on every other control on the target. Password fields, file inputs,
log-out controls and visually hidden skip links are never targets, and a toggle pair
(Collapse/Expand, Show/Hide) is exercised once in each direction, not over and over.

**Markup canary (#301).** To ask "is my input rendered as markup?", the boundary values include
two inert canaries, each with a fresh random token per submission:

- an HTML-injection canary, `<i data-jev-canary="TOKEN">jevTOKEN</i>`;
- an attribute-break canary, `jevTOKEN" data-jev-canary="TOKEN`.

They contain no script, no event handler and no `javascript:` URL: nothing in them can execute.
Detection is DOM inspection only. After each settled step the run looks for an element carrying
`data-jev-canary="<this run's token>"` in the page and in frames on an `--allow` origin. Right
after a canary is submitted, it also loads the same in-scope URL again (a plain GET, never a re-sent
form) and looks again. Such an element exists only when the app parsed the input as markup. A
canary shown as escaped text is fine and is never reported. A hit is a `markup-injection` defect
with `markupInjection: {field, payload: "html" | "attribute", submittedOn, renderedOn,
afterSubmit, afterReload, stored}`. It is `stored` when it survived the reload or showed up later on
another page, and `reflected` otherwise.

Limits: the canary detects unescaped rendering, nothing more. It never tries to exploit it, and it
proves nothing about sanitizers that keep `<i>` and `data-*` but strip scripts. It doesn't see
markup that is rendered in a closed shadow root, in a cross-origin frame, or only on a page the run
never visits. `verify-fix` cannot re-check a `markup-injection` defect by replay, so it returns
`inconclusive`; re-run the adversarial mission instead. Canary values go only to the `--allow`
origins, through the same gated actions as every other value, so the paid/destructive guards and
budgets apply. The ones the app accepts stay in the app (see [safety](./safety.md)).

**Identity changes (#300).** The run takes a baseline of who it is signed in as right after the
start page loads, from the session's auth cookies and auth-named `localStorage`/`sessionStorage`
entries. It keeps hashes only and never stores a raw value. A JWT is compared by its subject claims
(`sub`, user id, email, tenant/org), so a refreshed token for the same user is not a change. After
each settled action it checks that baseline again. The identity changed when:

- an auth entry appeared or disappeared;
- a token's subject claims differ;
- an opaque auth value was re-issued by an auth-shaped request (login, sign-in, session, verify,
  token, `demo`).

An example is a "Continue as demo" shortcut on a login page. When the identity changes, that step's
invariants (`userInvariant` and the declared spec) are **not judged**: they were written for the
original identity. What the step observed (its `before` snapshot, queued `never.response` hits) is
dropped. The control is never picked again. The run then goes back to the start URL in a fresh
session from the original storage state and checks that it is the original identity again. With
no fresh session, only a signed-out original identity can be restored, by clearing the session's
cookies and auth-named storage in place. Each
switch is listed in the result as `identityChanges: [{step, action, url, route, reason,
restored}]`, with auth entries named, never their values. When the original identity can't be
restored, the run stops `inconclusive` with `stop: "identity-changed"` and
`failure.kind: "identity-changed"`. That happens when a signed-in original identity has no fresh
session to return to, or the fresh session is someone else. A defect found before the stop still wins. Hard signals (5xx, console
errors) from the switched step are still reported, since they are the app's errors whoever is
signed in. Limit: a same-named opaque session value swapped without any auth-shaped request is not
detected; `--deny '<the control>'` covers that case.

A submit counts as submitted only once a request (a write or a navigation) actually left
the page. A submit the browser's own validation blocked (`required`, `type=email`,
`minlength`) is recorded as "blocked by validation" with the browser's message, and a run
whose only submits were blocked is `inconclusive`, never `clean`.

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

## Hangs

A hung app is its own finding (`hang`), never folded into "no progress" or a
timeout. jevitate distinguishes four kinds: the page never settles within the
ceiling; the main thread does not answer a trivial probe; a request stays pending
past its bound on a page that cannot be used; or the UI makes no progress after an
action while the page is still alive (a busy indicator that never ends, or an
action that silently puts the page back in an earlier state). The evidence is
recorded: pending requests, the last page state, timings and the JS heap. The
steps that led to the hang are then replayed in fresh browser contexts
(`--hang-replays`, default 2; `0` skips the replays and reports the hang unconfirmed,
`inconclusive`). Each replayed step waits for its target for the same bounded render
wait the run itself uses, so a lazily rendered control is not mistaken for a missing one.
A replay never re-sends a paid or destructive write, or a write the run itself recorded
(`sideEffects`), unless you pass `--hang-replay-writes`
([safety](./safety.md)). If any replay hangs again, it is a confirmed
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

Legitimate long-running work is not a hang. A response that has started streaming
(gRPC-web, Connect streams, NDJSON, JSON-seq, multipart replace, SSE) is not pending
work. A page that acknowledges the work (the pressed control disabled as "Analyzing…",
or an in-progress status with Cancel/Stop or a determinate progress bar) is waited out
within the job-wait budget, and past it the hang stands; a main thread that does not
answer is never "working". A link click to a route visited earlier is navigation, not an
action that silently undid itself.

### When is a page "settled"?

No request in flight and no *structural* DOM change (nodes added or removed, or an
attribute that changes what can be acted on) for 500ms, within a 15s ceiling. The
quiet time counts from the action itself (or later activity), so an already-quiet page
does not settle instantly, and timers the action's input handler scheduled (up to 5s)
are awaited until they fire or are cleared. A deferred effect is attributed to the action
that caused it, not to the next one.
These do not count:

- long-lived connections: WebSocket, EventSource, and any response streamed as
  `text/event-stream`;
- requests the target marks as background (`settle.ignoreRequests`);
- auto-detected long-polls: a request pending longer than `settle.longPollMs`
  (default 5000) while the page is otherwise interactive (a control is rendered
  and no busy indicator shows);
  a write that one of the run's clicks sent is still tracked until it ends, though: a
  `wait` (or a `blocked`) observes it within the job-wait budget instead of reporting
  that nothing is pending;
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

### Known limits of the hang heuristics

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

## Page timing

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

## Viewport and device emulation

By default every mission opens its browser at Playwright's default viewport (1280×720, desktop,
no touch). Two mutually exclusive flags change that:

- `--viewport <W>x<H>`, e.g. `--viewport 375x812`.
- `--device "<name>"`, a device from Playwright's built-in registry, e.g. `--device "iPhone 13"`.
  This also sets the scale factor, mobile and touch flags and the device's user agent. An
  unknown name is refused before any browser opens.

They apply to `explore` (every strategy, including usability), `journey run`, `load run`,
`source run`, `verify-fix`, `regression capture` and `regression run`, and a queued mission can
carry them too (optional `viewport`/`device` on MCP `queue_exploration`). The emulation is recorded on the Recording, and `verify-fix` and regressions
replay at the same size by default, so a defect found at 375px never "verifies fixed" at desktop
width. A different size on `verify-fix` is refused unless you pass `--allow-emulation-override`.

**Geolocation (#329).** `--geolocation <lat>,<lng>` (an optional third value is the accuracy in
metres), e.g. `--geolocation 41.6376,-70.9036`, places the browser at that position for "near me"
pages. The `geolocation` permission is granted only to the run's allowed origins, so the page
reads the position without a prompt and no other site can. A malformed or out-of-range value is
refused before any browser opens. It is offered wherever `--viewport`/`--device` are, except a
queued mission (`mission queue`), and over MCP as `geolocation` on `run_journey`, `verify_fix` and
the CLI-mirroring tools. Fresh-context hang replays don't carry it.

A **horizontal-overflow** hard signal (`document.scrollingElement.scrollWidth > innerWidth`,
attributed to the widest offending element) runs by default when the emulated viewport is
narrower than 1024px. It is reported as a defect in coverage, exploratory and adversarial runs
and as a signal finding in the usability review. `--check-overflow` turns it on at any width, and
`--ignore-overflow <selector>` excludes intentional cases. It is pure DOM geometry, never a model
judgment.

A **vertical-clipping** hard signal (#302) runs alongside it, under the same gate, and is reported
the same way: a defect in coverage, exploratory and adversarial runs, and a signal finding in the
usability review. It flags text that no scroll position shows, in two cases:

- **`overflow-hidden`**: text falls outside its nearest `overflow: hidden`/`clip` box because the box
  is shorter than its content (`scrollHeight > clientHeight`), for example a fixed-height card. The
  finding names the box.
- **`above-page-top`**: text spilled out of a too-short container above the top of the page, for
  example a `flex-wrap` chip centred in a 56px header that wraps to four lines at 375px. The finding
  names the text's element.

Each finding has the element's descriptor, the clipped distance (`clippedPx`) and a fingerprint of
route and element. One element is one finding however many states show it, up to 10 per page
state.

What it does **not** report, by design:

- **Intentional truncation.** Text under `line-clamp`/`-webkit-line-clamp` or
  `text-overflow: ellipsis` is ignored, not reported as advisory. The app chose to truncate and
  shows that it did. A "read more" box that truncates with a plain fixed height and
  `overflow: hidden` is reported; exclude it with `--ignore-overflow <selector>`.
- Visually hidden text: an sr-only box (1px or less, `clip`/`clip-path`), a collapsed box (zero
  height), text that is `visibility: hidden`, `display: none` or `opacity: 0`, and a skip link (an
  absolutely or fixed-positioned box) that sits entirely above the page. In-flow text that spilled
  wholly above the page is still reported.
- Scrollable boxes (`overflow: auto`/`scroll`) and the page root. A scroll-locked `<body>` is not a
  clipped box.
- Text covered by a later sibling, such as a sticky nav overlapping a spilled line. That is
  occlusion, not clipping.
