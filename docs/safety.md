# Safety model

Jevitate drives a real browser against a real app, sometimes under a model's direction. It is an
automation platform that also works as a testing tool: a Journey is a parameterized flow that does
real work, and its purpose is to prove that users can meet their objectives. Both uses send real
requests, so both need guardrails. These are the guardrails that hold whatever a model proposes. Each is enforced in code, to the extent each
bullet states (and no further), and covered by tests that assert the refusal. [SECURITY.md](../SECURITY.md) lists the invariants whose regression is a
security bug, and how to report one.

**Only what you authorize.**

- Every run acts on an allowlist of origins: the `--url`'s own origin, or exactly the `--allow`
  origins you pass. What that guarantees, exactly:
  - **The acting origin.** The start URL is checked before a browser opens, and the page the run
    is on is checked again after each action settles (an adversarial run returns to its start
    page). An action that navigates off the allowlist is stopped there, but that page has already
    loaded and run by then: the check is after the fact, not a network block.
  - **Opt-in: off-allowlist navigations (#521).** `explore --block-off-allowlist-navigation` (MCP
    `run_exploration.blockOffAllowlistNavigation`, suite option `blockOffAllowlistNavigation`) arms a
    navigation guard on the mission's own browser session (goal, usability, adversarial, coverage,
    exploratory and `--feature` runs, and their fresh and hang-replay sessions). A page navigation to an
    origin outside the allowlist that the page starts itself — a link click, `location.href = …`, a
    form GET, a popup — is answered `204 No Content` in the browser, so the other page never loads or
    runs and the page stays where it was. The mission treats it exactly as a departure seen after the
    settle: a goal run stops `blocked` (the transcript names the blocked URL), adversarial records it in
    `scope.departures` and resets, coverage/exploratory/feature record it and do not expand it, and a
    blocked seed redirect to a login page keeps the "session is not authenticated" reason. What it does
    not change: a server redirect (`302`) is invisible to the guard and still loads, so the after-settle
    check stays the guard; subresources and fetch/XHR still load; an embedded off-allowlist iframe is
    not loaded but is not a departure; the session runs with the HTTP cache off. It is never armed on
    `login`/persona sign-in, `journey run`, `source run`, `load`, `record` or `demo` sessions, which may
    legitimately cross to an IdP or checkout. Off by default.
  - **`http:` end-state checks (#543).** A success or end-state check that reads an outbox or
    another endpoint makes its own GET from jevitate (not the browser). Its origin must be in the
    run's allowlist — checked before anything opens (`E_HTTP_CHECK_OFF_ALLOWLIST`), by `journey lint`
    (`http-check-off-allowlist`), and again on every request after `${…}` substitution. It sends no
    cookies or auth headers, never follows a redirect, reads at most 1 MiB, and never saves the body;
    a secret param or setup output in its URL is refused.
  - **First-party writes in find-out goals.** A find-out goal's write requests are blocked at the
    network (below).
  - **Adversarial misuse writes (#403).** During an adversarial run, a write request (anything but
    a read — `POST`, `PUT`, `PATCH`, `DELETE`, a native form post) that a misuse step fires to an
    origin outside `--allow` is aborted in the browser before it is sent, whoever that origin is.
    It is listed in the result's `blockedWrites` with its origin and path and how to allow it (add
    the origin to `--allow` if it is the app's, or pass `--allow-write "<origin>/<path glob>"`),
    and it is never reported as a defect of the app. A step whose write was blocked does not have
    its declared invariants judged (inconclusive).

  What `--allow` does **not** block: subresource requests to other origins (scripts, styles,
  images, fonts, frames, fetch/XHR reads, WebSockets, workers) — third-party CDNs and APIs are
  normal and load as usual — and, outside the two cases above, third-party writes (listed in
  `sideEffects`, below).
- MCP missions can only target a *promoted* mission target. `jevitate mission target promote`
  promotes one on the CLI, and the `mission_targets` MCP tool can promote one too, so an agent can
  promote its own target. The same is true of `site_policy` (an agent can set a looser policy) and
  `promote_journey` (recorded as an agent's approval, `provenance.channel: "mcp"`). Tracked in
  [#799](https://github.com/matt-cochran/jevitate/issues/799).
- `load run` refuses to start without `--authorized-origin`.
- `jevitate demo` explores and writes, so it needs a named environment (`--env`) and refuses one
  flagged `production: true` in `.jevitate/environments.json`, before anything runs. `demo approve`
  re-checks it.
- Demo media leaves for Journeeze only from an environment declaring `synthetic: true`, rendered
  under `jz-mask-v1` (fields, editables, embeds and marked regions painted over, proven per
  screenshot and per video frame; anything unproven is left out). See
  [Publishing to Journeeze](catalog.md#publishing-to-journeeze).

**Bounded.**

- Every autonomous loop has hard ceilings: `--max-actions`, `--max-decisions`, time budgets, and a
  no-progress detector. Coverage runs also stop on `--stall-timeout`.
- `jevitate check` enforces a total action, time and spend budget over a whole suite, and fails
  closed when spend cannot be measured.

**No dangerous clicks by default.**

- Session-ending (Sign out), destructive (Delete, Revoke, Rotate, and resetting or switching off a
  credential: Reset authenticator, Disable two-factor, Reset password) and paid (Buy, Generate, Send
  invite) controls are refused by default. `--deny <pattern>` adds your own, and
  `--allow-destructive` lifts the default. A goal run may still click the one its goal asks for
  ("Delete the draft" → Delete; "Invite a teammate" → Send invite).
  The paid classifier reads only short, verb-led button and link labels: a chat question card or
  a radio/checkbox answer that merely contains "pay", "trial" or "upgrade" is not refused unless
  its label names a charge. A refused control is not offered to the model again in that run.
- **No-progress recovery (#747).** When the no-progress detector fires and the page still offers a
  *unique safe forward control* — one visible, enabled, uniquely named control that the goal and the
  page's own instruction both name, and that is not destructive, financial or approval — the run's one
  last-chance turn becomes a targeted recovery turn: the model is offered **only** that control, code
  never clicks it, and the turn is still bounded to exactly one. Hidden, disabled, ambiguous,
  destructive, financial and approval controls are never offered as the recovery candidate. Without a
  unique safe forward control the generic last-chance turn is unchanged.
- Native dialogs (`window.confirm`, `prompt`) raised by an action are dismissed by default, as
  Playwright does, but each one is now logged in the transcript (`dialogs`) and told to the model.
  `--dialogs accept` (or `"dialogs": "accept"` in a target's `safety`) confirms them, except a
  dialog whose message names a session-ending, destructive or paid action the run may not take
  (no `--allow-destructive`, and the goal doesn't ask for it), or matches a `--deny` pattern: that
  one is still dismissed. An `alert` is always accepted; a `beforeunload` prompt is always
  dismissed.
- The built-in vocabulary cannot know your app's own paid controls ("Analyze", "Draft the page").
  `--paid <pattern>` (repeatable, same syntax as `--deny`; `safety.paid` in
  `~/.jevitate/targets.json`) puts them in the paid category: a declared `budget` guard sees them,
  hang replays never repeat them, and a goal that asks for one may still click it — unlike
  `--deny`, which no mission may click. A goal asks for a `--paid` control by its action word:
  a trailing live estimate ("Confirm analysis (≈ 4–10 credits)") and confirmation words
  ("Confirm", "and") are ignored, so "analyze this text" asks for "Confirm analysis".
- **Every refusal names its rule.** A refused step's reason ends with the rule it matched, e.g.
  `refused by the safety policy: "Generate Your First Key" may cost money or contact real people
  (paid) [rule builtin:may-cost-money, matched "Generate"]`, and the transcript entry carries it
  structured: `safety: { ruleId, pattern, control, risk, waivable }`. So you can tell a built-in
  heuristic from your own `--paid`/`--deny` pattern and decide whether to widen a guard, exempt one
  control, or report a false positive. `jevitate site policy rules` (`--json`) lists every rule.
- **`--allow-control <regex>`** (repeatable; `safety.allowControl` in a target's
  `~/.jevitate/targets.json` entry; `allowControl` on a suite item; MCP `allowControl`) exempts a
  control whose accessible name matches from the **soft built-in "may cost money" heuristic only**,
  for that run: `--allow-control "^Generate Your First Key$"`. The regex is case-sensitive over the
  whitespace-collapsed name (write `/…/i` for case-insensitive). An invalid regex, an empty one, or
  one that matches every name (`.*`) is refused before any browser opens. Every click it permits is
  recorded in the result's `safetyOverrides: [{ regex, control, ruleId, pattern, step }]`. It is
  never written to a site policy and never applies to native dialogs. It never lifts a hard rule:

  | Rule id | Matches | `--allow-control` | Lifted by |
  | --- | --- | --- | --- |
  | `builtin:may-cost-money` | short labels that may cost money or reach real people (Buy, Upgrade, Generate, Simulate, Send invite…) | **waives it** | `--allow-destructive`; a goal that asks for it |
  | `builtin:destructive` | irreversible actions (Delete, Revoke, Rotate, Regenerate, Reset authenticator…) | never | `--allow-destructive`; a goal that asks for it |
  | `builtin:session-end` | Sign out, Log out | never | `--allow-destructive`; a goal that asks for it |
  | `builtin:nameless-control` | a nameless control when any `--deny`/`--paid` is set | never | nothing |
  | `deny:<pattern>` | your `--deny` pattern | never | remove the pattern |
  | `paid:<pattern>` | your `--paid` pattern (also when the heuristic matched the same control) | never | `--allow-destructive`; a goal naming its action word; narrow the pattern |
  | `read-only:<kind>` | a find-out goal's write (`may-cost-money`, `destructive`, `session-end`, `write-flow`, `send`, `upload`) | never | `--allow-writes`; a goal that asks for a change |
  | `boundary:off-origin` | a page or action outside the authorized origins | never | authorize the origin (`--allow`) |
  | `boundary:forbidden-tool` | an MCP tool outside the served allowlist | never | nothing |
  | `boundary:credentials` | credentials and secrets reaching the model or disk | never | nothing |

- The usability review's guard probe (`--probe-guards`, #198) is the one place jevitate clicks a
  destructive control without a goal asking for it, and it is **opt-in**. When enabled, it clicks
  each destructive control once on a fresh page. It aborts every non-GET request and every request
  whose URL, query, RPC name or body names a destructive verb (`GET /delete?id=1` included). It
  won't probe a page with an open WebSocket or EventSource or a controlling service worker. It
  cancels any confirm and never clicks inside a dialog. Without the flag, nothing is clicked and
  those claims are reported unverifiable ([UX findings](./ux-findings.md#guard-probes)).
- A find-out goal (no `--success`) is read-only unless the goal asks for a change: write-flow
  controls are refused and the write requests an action fires are blocked. A form submit is judged
  by the requests it sends, so a lookup form that only reads still works. A goal with no
  `--success` that asks for a change still never performs a destructive write (a destructive
  control, or a `DELETE` / `Remove*`-style request) unless the operator passes `--allow-writes` or
  `--allow-destructive`. `--allow-writes` lifts the guard and `--allow-write <glob>` exempts a
  request path ([find-out goals](./success-checks.md#find-out-goals-no---success)).
- **Third-party writes.** The read-only guard blocks only the app's own writes. Code decides from
  each request, never the model. A write is the app's (first-party) when any of these holds:
  - its origin is an `--allow` origin, or shares an allowed origin's host (any port) or site
    (the last two host labels, e.g. `api.example.com` next to `app.example.com`);
  - it carries API credentials: an `Authorization` header or a common API-key or auth header
    (`apikey`, `x-api-key`, `x-auth-token`, `x-access-token`, `x-csrf-token`, `x-amz-security-token`,
    `x-firebase-*`, `x-goog-*`, `x-hasura-*`, `x-supabase-*`, the Parse keys);
  - the page already sent a credentialed request to that origin during this run. So a backend on
    another site (Supabase, Firestore, API Gateway, Hasura) stays first-party even for its
    unauthenticated writes, such as a sign-up or password-reset POST.

  Every other write is third-party, such as Stripe.js's fraud beacon `POST https://m.stripe.com/6`,
  analytics or telemetry. It is never blocked, and it is listed in `sideEffects` with its full URL
  and `thirdParty: true`. A blocked write to an origin outside `--allow` names that origin and says
  how to change the outcome. Add the origin to `--allow` if it is the app's backend. Pass an
  origin-qualified `--allow-write "https://<origin>/<path glob>"` to let it through on purpose.
  A glob that starts with `http://` or `https://` matches origin and path; any other glob matches
  the path on every origin.

  **Limit:** a credential-free write to an origin the page never sent credentials to still passes.
  An example is a backend on another site that the app calls with cookies only. To block its
  writes, add its origin to `--allow`. Pay, checkout and other flow controls are still refused
  before the click, whichever origin their request would go to.
- A hang's fresh-context replays never re-send a paid or destructive write. A replay path that
  clicks such a control (or matches `--deny` or `--paid`), or a control the run's own `sideEffects`
  show sending a write, is not replayed, and the hang (or `verify-fix`) is `inconclusive`. `--allow-destructive` does not lift this; `--hang-replay-writes` (or
  `safety.hangReplayWrites` in `~/.jevitate/targets.json`) does.
- Every write request a run fires is listed in the result (`sideEffects`). A request outside
  the `--allow` origins is listed by its full origin and path. A repeat guard refuses
  re-firing the same write, and `--read-rpc` marks POST-based read RPCs so they are not mistaken
  for writes. A write that answered 4xx may be retried; one that answered 5xx or got no response is
  treated as possibly committed and is not repeated unless the page offers a retry or shows an error.
  The repeat guard counts only the app's own writes: a third-party write (a vendor's
  telemetry or `csp-report` beacon, Stripe.js's `m.stripe.com` beacon) and a request matched by
  `--settle-ignore` are listed but never make a control unclickable a second time.
  The guard identifies an action by the route, the element, and its context (its form or
  dialog, and the screen heading above it), never by the label alone. Two same-labelled
  controls on different screens are two actions, so a "Continue" that sent `POST /api/a` does
  not block a different "Continue" that sends `POST /api/b`. A refusal names the request the
  earlier click sent (method + templated path, such as `POST /api/items/:id`). While that
  control's write is still in flight, the run waits for it, even if the screen around it changed.
  Bookkeeping requests never count as a click's side effect: a first-party analytics or telemetry
  event (an RPC such as `RecordShowcaseEvent` or `TrackPageView`, a POST to a path with an
  `analytics`, `telemetry`, `beacon`, `metrics` or `rum` segment, a `navigator.sendBeacon` ping), a
  heartbeat, and an idempotent read marker (an RPC such as `MarkConversationRead`, a POST to `…/read`
  or `…/mark-as-seen`). Opening a chat or a conversation row again is therefore allowed. Paths such
  as `/payments/collect` or `/orders/1/track` are still writes. Declare an app-specific bookkeeping
  request with `--read-rpc` (for example `--read-rpc 'Log*'` or `--read-rpc '/api/stats/*'`). A
  real write fired by the same click is still guarded.
  The run cannot know which request a click will send before it fires, and one button may send
  another request in another state ("I've changed my nameservers" sends `RefreshShareDomain`, and
  later `RetryShareDomain`). So a control whose write got a response may be clicked again once its
  own part of the page has moved on. That part is the control's nearest dialog, form, section,
  card, list item or table row (else `main`, never the whole page). Its visible text (digits
  ignored) or the controls it offers must differ from both how it looked when the control was
  clicked and how it looked after the click. A menu or a toast elsewhere on the page is no change, so
  "Add to cart", then opening a menu, then "Add to cart" again is still refused. This never applies
  to a paid or destructive control, or to a write whose outcome is unknown.
  The same holds once another control in that part of the page has been used since the click
  ("Review instructions" beside "I've changed my nameservers"), even when that part looks the same:
  one more click is allowed, and is then judged by the request it actually sends. A control used
  elsewhere on the page (a menu) does not count.
- Adversarial runs never target password fields, file inputs or log-out controls, and never use
  real PII or real recipients.
- **Inert markup canaries (#301).** The adversarial boundary values include an HTML-injection canary
  (`<i data-jev-canary="TOKEN">jevTOKEN</i>`) and an attribute-break canary
  (`jevTOKEN" data-jev-canary="TOKEN`). The token is random per submission. Neither contains a
  script, an event handler, a `javascript:` URL or anything else that executes, in the app or in
  its users' browsers. The run only inspects the DOM for an element carrying the canary attribute,
  after submit and after loading the page again with a plain GET (a form is never re-sent). A hit
  means the input was rendered unescaped (`markup-injection`, stored or reflected). The canary
  never attempts exploitation. A write that would carry it (or any misuse value) to an origin
  outside `--allow` is blocked before it is sent (#403, above); it goes through the same gated
  actions, paid/destructive guards and budgets as every other value. Canaries the app accepts stay
  in its data like any other boundary value, so reset state between runs (below). See
  [exploration](./exploration.md#adversarial-scope-form-misuse-and-coverage).
- **Identity changes (#300).** An adversarial action that switches the signed-in identity (a "Sign
  in as demo" shortcut) is detected from hashed auth state, never raw cookie or token values. That
  step's invariants are not judged against the new identity, the control is never clicked again,
  and the run returns to the original identity in a fresh session (or stops `inconclusive`,
  `identity-changed`).

**What guards a Journey run.** A Journey is a flow that does real work in your app, so a run can send
real writes. Which guards apply depends on who starts it. These are the ones in code today:

| Guard | MCP (`run_journey`, `chain_journeys`, `demo_journey`, `annotate_journey`, `verify_journey`, `journey_readiness`, `run_check`, `load run`, `source run`, `regressions run`, `regressions capture`) | CLI (`journey run`, `regression run`, `regression capture`) |
| --- | --- | --- |
| Only a promoted Journey with a current approval runs | On `run_journey`, `chain_journeys`, `run_check` and `load run`. `verify_journey`, `journey_readiness`, `annotate_journey` and `demo_journey` work on Journeys not yet promoted, and a regression is no Journey. Refused before any browser opens with `E_JOURNEY_NOT_PROMOTED`, `E_JOURNEY_APPROVAL_STALE` or `E_JOURNEY_APPROVAL_UNKNOWN`. Promote it, or re-approve it, to lift it | No. It runs anyway and prints a `warning:` line on stderr with the same code. (`load run` on the CLI refuses an unpromoted Journey; `journey chain` runs promoted Journeys unless you pass `--allow-draft`) |
| No click on a session-ending, destructive or paid control (a `forEach` row's included), and no Enter in a field whose form's default button is one | Yes: `E_RUN_REFUSED_DESTRUCTIVE`. Lifted by `mcpRun.allowDestructive`; a target's own `safety.deny` is never lifted | No |
| No write to an origin outside the run's allowlist | Yes, at the browser context (popups, form posts and WebSocket frames included, on a self-heal run too): `E_RUN_REFUSED_OFF_ALLOWLIST_WRITE`. Lifted by `mcpRun.allowOffAllowlistWrites` | No. The write is sent and listed in `offAllowlistWrites` in the result |
| No replay on an environment flagged `production: true` | Yes: `E_RUN_REFUSED_PRODUCTION`, before anything is sent. `verify_fix` refuses it too. Lifted by `mcpRun.allowProduction` | No, and not on `verify-fix` |
| No write to an origin flagged `production: true`, whatever the allowlist says | Yes: `E_RUN_REFUSED_PRODUCTION`, at the browser context. `verify_fix` has no such guard at the context, so it refuses a mission whose allowlist holds one, before anything opens. Lifted only by that origin's own `mcpRun.allowProduction` | No |
| Site policy (pacing, minimum interval, budgets, quiet hours) | Yes on a Journey's run, `{error: throttled}` | Yes. With no policy set, nothing is limited |
| A value-free record of the run in `logs/<date>/journey-run-*.json` | Yes on `run_journey` | Yes on `journey run` |

A control in a closed shadow root is judged only by its host's name. A closed root is opaque, so the click guard
reads the role and name of the element the step resolved, which is the host (and the step's recorded label, if it
has one): a Delete button inside a closed root, on a host with an innocent name, is not refused. A target's
`safety.deny` reads the same name.

The run's record is value-free as far as the run can know: a parameter or extracted value is masked, a non-standard
method reads `OTHER`, and a path keeps only what the Journey recorded as literal route text, so it is coarse by design.
A token in an off-site origin that the run never knew as a value can't be masked, and is stored as that origin.

The `mcpRun` settings live in a target's entry in `~/.jevitate/targets.json`:
`"mcpRun": { "allowDestructive": true, "allowOffAllowlistWrites": ["https://api.example.com"], "allowProduction": true }`.
No MCP tool takes these as arguments, and MCP path arguments cannot name that file or
`~/.jevitate/verify-checkpoint.key`, in any case or through a link. A refusal ends
the run with `outcome: refused` and exit code 2. It is not a failed step, is never healed or
retried, and names the setting that lifts it. If `targets.json` or `environments.json` cannot be read,
an MCP run refuses with `E_RUN_GUARD_CONFIG` rather than run unguarded. A redirect from an allowed
origin to a disallowed one cannot be stopped in the browser; the write may have been sent, and the run ends.
The destructive check reads a control's name, so it cannot judge what has none: Enter in a form with no
submit button, or a key the page's own script turns into a write. A press is judged however its key is spelt,
including `"\n"`, `"\r"`, `NumpadEnter`, `" "` and a chord that holds one, and on what holds focus inside a frame.

What does not guard a run today:

- A CLI run has none of the refusals above. The person at the terminal is the guard.
- `verify_fix` has only the production refusal of those above. Its replay stays on the origins the finding's mission
  was allowed: it can't be moved onto another one.
- Nothing asks for approval before a write. `queue_action` writes an inbox item and no run waits for
  its answer ([#793](https://github.com/matt-cochran/jevitate/issues/793)).
- A Journey's parameters are names with string values; nothing checks their type
  ([#796](https://github.com/matt-cochran/jevitate/issues/796)).
- There is no reconcile or per-write receipt after a write whose outcome is unknown
  ([#795](https://github.com/matt-cochran/jevitate/issues/795)).
- An agent can loosen the limits that are not in `targets.json`: it can set the site policy, promote a
  target and promote a Journey over MCP ([#799](https://github.com/matt-cochran/jevitate/issues/799)).
- A `baseUrl` an agent passes can name an origin the configuration doesn't know, and that origin joins the
  run's write allowlist. Its `production` flag, `safety.deny` and `mcpRun` don't apply there, because nothing
  says they should. Origins are compared after normalising case, default port and a trailing dot, so an alias
  of a flagged host is still that host, but an IP or another scheme for the same site can't be known as it
  ([#799](https://github.com/matt-cochran/jevitate/issues/799)).
- An authored `allowedOrigins` widens the allowlist after promotion. `author_journey` with `allow` records
  `metadata.allowedOrigins`, and once `promote_journey` has run, the run's guard allows writes to those origins.
  `mcpRun.allowOffAllowlistWrites` isn't the only thing that lifts that refusal
  ([#799](https://github.com/matt-cochran/jevitate/issues/799)).
- A Journey's approval is a plain hash of its content, with no signature. Forging one needs write access to the
  Journey's file, which no MCP tool gives, and anyone with that access can forge it.
- The MCP and CLI rules above are separate; one trust model for both is
  [#792](https://github.com/matt-cochran/jevitate/issues/792).

**Runs change the app's state — reset it between runs.** The guardrails above keep a run from
clicking what it must not; they do not undo what it legitimately did. An adversarial run submits
boundary and malformed values on purpose, and the ones the app accepts **stay in the app**: a
display name saved as `\u0000invalid\u0000`, an over-long bio, a duplicated item. The next run —
any strategy — starts from that state, so its findings (and a `verify-fix` or regression replay)
can be about the junk an earlier run left, not about the app.

- Point adversarial runs at a disposable account or seeded test data, never at data you keep.
- Reset state before the runs that must start clean. A goal run does it itself with mission
  fixtures (`--fixtures`: HTTP `setup`/`restore` steps) or shell hooks (`--before`/`--after` with
  `--allow-shell-hooks`), which also run around every replay — see [fixtures](./fixtures.md).
  Fixtures and hooks are goal-only, so after an adversarial run, run the same reset yourself (the
  script you would pass as `--before`: reseed the database, restore a snapshot, roll the container).
- `--repeat` on a write goal ("change the display name to Ada") proves the write only in run 1:
  from run 2 on the value is already there, so a success check on it passes without the run doing
  anything. Give such a goal `--fixtures` or `--before` so every repeat starts from the same state
  (see [repeats](./multi-run.md#repeat-and-vote---repeat----min-agreement)).

**gRPC-web/Connect reads.** gRPC-web, Connect and Twirp send every RPC as a POST, including pure
reads, so the method alone can't tell a read from a write. Code classifies a request as a write
unless: it isn't `POST`/`PUT`/`PATCH`/`DELETE` (GET/HEAD/OPTIONS are always reads); or it's an
RPC-shaped POST (`/<pkg>.<Service>/<Method>`, sent as gRPC-web/Connect/Twirp/protobuf/JSON, or with
no content type) whose method name starts with a built-in read verb — `Get`, `List`, `Search`,
`Find`, `Watch`, `Stream`, `Count`, `Describe`, `Read`, `Query`, `Fetch`, `Lookup`, `BatchGet` or
`BatchRead` (`GetItem`, `ListItems`, `BatchGetItems`, … ; `CreateItem`/`UpdateItem` are still
writes); or it matches an operator-supplied pattern — `--read-rpc <pattern>` (repeatable) or
`safety.readRequests` in `~/.jevitate/targets.json`: a pattern starting with `/` is a path glob
(`/api/search*`), any other pattern a glob over the RPC method (`Estimate*`, `pkg.Service/Estimate*`).
`journey lint`, `journey review`, `journey readiness` and `journey verify` read the same target setting, so a
proof neither skips nor blocks a request it marks a read.
An unknown request is always a write — a misclassified read only costs a guard/finding; a
misclassified write could let a run repeat a real side effect.

```json
{ "http://localhost:5173": {
    "safety": { "readRequests": ["pkg.BillingService/Estimate*", "/api/search*"] } } }
```

```bash
jevitate explore --strategy goal --url http://localhost:5173/billing \
  --goal "check the plan estimate" --success 'visible:text=Estimated' \
  --read-rpc "pkg.BillingService/Estimate*" --real
```

`pkg.BillingService/EstimateCost`, sent as `application/connect+json` to
`/pkg.BillingService/EstimateCost`, does **not** start with a built-in read verb, so without the
pattern above it is treated as a write and refused/repeat-guarded like any other. `--read-rpc
"pkg.BillingService/Estimate*"` (or the equivalent `safety.readRequests` entry) marks it a read
explicitly — the same fix applies to any Connect/gRPC-web method whose name doesn't start with a
built-in verb (`Preview*`, `Recalculate*`, …).

**Secrets stay out of models and artifacts.**

- Outbound model payloads pass a redaction guard that fails closed. `--secret` values, bound
  `--secret-field` values, TOTP seeds, fixture secret outputs and probe tokens are scrubbed from
  transcripts, Recordings, issue drafts and log evidence. Page text and field values are
  redacted as the page is read, so a page that displays a secret never reaches a model and never
  ends the run.
- Code, not the model, types a bound secret into a field. The model sees `«secret:VAR»`.
- An MCP request never carries a secret parameter's value: it is refused by name with
  `E_SECRET_PARAM_OVER_MCP` before anything runs. On a replay the value comes from an environment
  variable through `journey run --secret-field` or `secretFields` in `targets.json`; `--param` on the
  CLI still works and warns on stderr
  ([Secret parameters on a replay](./journeys.md#secret-parameters-on-a-replay)).
- A credential-like name is refused however it is spelt, broadly on purpose. `secret: false` lifts that
  only when a person approved that Journey; an approval over MCP does not, per Journey. Provenance is
  detection, not proof: an agent that can edit the Journey file can also write the channel, and git
  review of `.jevitate/` is what catches that.
- A value from a binding is typed only on the binding's origin, read with the field in hand, or the
  step fails with `E_SECRET_ORIGIN_REFUSED`. Limit: a page that navigates in the instant between that
  read and the value going in can't be excluded, though an element handle dies with its document.
- Everything a self-heal sends a model is redacted with the run's whole set: secret parameters,
  fixture secrets and credential-named outputs, and credentials extracted so far. Its evidence
  screenshots use the same set. A secret the page transforms (lower-cased, say) is not recognised.
- `--storage-state` files go only to the browser. Artifacts record their path, never their
  contents.
- `jevitate login` (#427, #449) reads credentials only from the environment variables its flags
  name, and sends them only to an authorized origin: typed into a sign-in page (`--url`), or
  POSTed as JSON to an endpoint (`--api`, redirects never followed). The session token an `--api`
  response returns joins the redaction set with both credentials: no result, error or log line
  carries any of them. The only thing written is the storage state (mode `0600`, outside
  `.jevitate/`), and only after the session is proven; a failed sign-in writes nothing.
- Demo video, defect evidence clips and step screenshots (`demo`, `journey demo`,
  `--evidence-video`, `--record-video`, `--screenshots`) mask every registered secret in pixels,
  from the video's first frame, and re-prove the mask at every step. This fails closed: a clip or
  image whose mask cannot be proven is not written, and the reason is recorded. The demo overlay
  is hidden in screenshots.
- The mask follows the page's paints with the browser's own `requestAnimationFrame` (#547), and
  reads geometry and DOM changes with the browser's own `getBoundingClientRect`,
  `Range.getClientRects` and `MutationObserver`. It captures them before any page script runs, so
  a page that later replaces or wraps them (a polyfill, an animation library, an app's test hooks)
  does not affect the mask. If a script that ran **earlier** (another init script, Playwright's
  `page.clock`) already replaced one, so that it is no longer the browser's own built-in, the mask
  fails closed in that document: it paints the whole viewport in the mask colour (the video shows a
  solid frame, never a lagging mask), every screenshot is refused with `E_PIXEL_MASK` and reason
  `untrusted-primitive`, a defect clip or `jz-mask-v1` video is marked unproven, and a session
  whose open page is affected is not opened for capture. The mask does not use `setTimeout`,
  `performance.now` or `ResizeObserver`. **Limit:** the built-in check reads each function's
  source through `Function.prototype.toString` (a shim prints its own source; a bound function or a
  `Proxy` prints no name). A script that runs before the mask and also forges
  `Function.prototype.toString` defeats the check. jevitate adds no such script.
- **Secrets the app reveals during the run** (#298) — a freshly minted API key, a one-time reveal
  panel, an invite or reset link — are not known in advance, so they cannot be registered. The
  pixel mask also covers, with no registration:
  - elements the app marks as secret: `data-jevitate-mask` (add it to your app's reveal panels to
    opt in), `data-secret`, `autocomplete="one-time-code"`, a `data-testid` containing `secret`,
    `api-key`, `apikey` or `token`, an `aria-label` containing `secret`, `api key` or `token`;
  - credential-shaped values in text and fields: JWTs, `sk_live_…`/`sk-…`, GitHub/GitLab/Slack
    tokens, AWS access key ids, Google API keys, `<hex>.<hex>` id/secret pairs, 32+ hex chars, and
    32+ char tokens mixing upper case, lower case and digits.

  A value found either way is learned for the rest of the run: it is masked where it appears again
  (another screen, unmarked) and scrubbed from the screenshot `index.md`. Learned values stay in
  memory and are never written. **Limits:** a revealed secret with no marker and no credential
  shape (a 6-digit code, a short word, a passphrase) is not masked — register it with `--secret`,
  or mark it in the app. A marker on a large container masks the whole container. Over-masking is
  possible (a commit SHA is 40 hex chars). A reveal inside a modal `<dialog>` fails closed (the
  image is skipped, as for registered secrets). Pixel masking covers images and video only: a
  revealed value the run *reports* (a find-out answer, the transcript) is not redacted unless it
  is registered.

- **Action deltas** (#303, opt-in with `--action-deltas`) — what each action changed on the page (an accessibility snapshot
  before and after, the announcements in between, the action's requests, URL and title) — are
  redacted **first**: each snapshot line is scrubbed inside the capture, before it is parsed, kept
  or compared, so no raw value outlives the capture call. Scrubbed: registered secrets, bound
  secret-field values, the value of any field named like a credential (password, passcode, secret,
  token, API key, one-time code, OTP, PIN, CVC), the values shown in `type=password` fields and in
  the secret-marked elements above (learned in memory only, like the pixel mask), and every
  credential-shaped value. Announcements and request paths get the same scrub. Every delta is then
  checked by the fail-closed guard before it is stored (transcript, Recording) or sent (the model's
  step history, Jev's relevance question). The same limit as the pixel mask applies: a secret with
  no marker, no credential name and no credential shape is not recognised — register it. Why the scrub is
  not done inside the page: the snapshot is Playwright's `ariaSnapshot`, which reads field values
  from Playwright's own isolated script world, where nothing the page (or jevitate's page scripts)
  defines can hide them, and changing the live page's values to hide them would change the app
  under test. So the raw snapshot reaches the jevitate process for the length of one call and is
  scrubbed there, line by line, before anything else reads it.

**Page text is data, not instructions.** Model prompts carry a prompt-injection guard, and page
content is passed as untrusted data.

**A model never decides a verdict.** Defects come from hard signals, your success checks, your
invariants and your log matchers, all evaluated by code. An action's delta verdict (`no-change`,
`relevant-change`, `inconclusive`) is code's too: Jev may label a change relevant or irrelevant and
propose an ignore rule, but a rule is accepted only for a node code saw change with no action, and
Jev can never turn a non-empty diff into `no-change`. A model's "this looks broken" is recorded
as advisory and never gates an outcome, heals a step or files a defect. Write and irreversible
steps are never auto-healed.

**Operator-only escape hatches.** Things that run code on your machine (`--before`/`--after`
shell hooks, `cmd:` log sources) need an explicit opt-in flag (`--allow-shell-hooks`,
`--allow-log-cmd`), come only from the CLI or local config, and can never be named by a model or
an MCP request.

Jevitate assumes you are testing systems you are authorized to test.
