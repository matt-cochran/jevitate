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
- MCP missions can only target a *promoted* mission target, and promoting one is a CLI act:
  `jevitate mission target promote`. The `mission_targets` MCP tool refuses it
  (`E_TARGET_PROMOTE_OVER_MCP`). Over MCP, `site_policy` can only write a policy at least as strict as the
  one in effect, on every axis (`E_POLICY_LOOSEN_OVER_MCP`). `promote_journey` still works over MCP, but
  its approval (`provenance.channel: "mcp"`) authorises test-mode runs only. See [run modes](./run-modes.md).
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

**Who decides what a run may do.** A run has one of two modes, `test` or `automation`, and the mode comes
from files a person wrote (`trust` in `.jevitate/environments.json` and `~/.jevitate/targets.json`). No flag
on any command and no MCP argument names it, and a target no file declares is `unknown`, which runs as
automation mode. [Run modes](./run-modes.md) has the details. This table is the one the code is tested
against (`packages/cli/src/run-mode.test.ts`):

| Actor | Set a target's `trust` | Promote for test-mode runs | Promote for automation-mode runs | Loosen site policy or promote a mission target | Approve a held action | Supply a secret value |
| --- | --- | --- | --- | --- | --- | --- |
| A person at a terminal (`tty`) | Yes, by editing the file | Yes | Yes | Yes | Yes (`jevitate inbox approve`, typed at a TTY) | Yes: `--secret-field`, `targets.json`, a visible handback |
| A verified PR review (`pr-review`) | Yes, through git | Yes | Yes | Not applicable | No | No |
| CI (`ci`) or a scripted escape hatch (`non-interactive`) | No | Yes | **No** | No | No | `secretFields` from the runner's environment, test targets only |
| An agent over MCP (`mcp`) | **No** (no tool writes either file) | Yes (`promote_journey`, recorded as `mcp`) | **No** | **Tighten only** | **No** (`approve_action` refuses) | **No** (`E_SECRET_PARAM_OVER_MCP`) |
| An agent with file access | Can forge any of the above | | | | | |

Over MCP, a test-mode run reads the test target's own `secretFields` for a secret parameter the request
leaves out: code types the value into the bound field on that origin, and it never reaches the model (see
[run modes](./run-modes.md#how-a-secret-comes-back-over-mcp)). The agent still supplies no value: one in
the arguments is refused with `E_SECRET_PARAM_OVER_MCP`. The last row is the
limit, stated plainly: an agent that can write to `.jevitate/` or `~/.jevitate/` can write what this table
trusts, including `trust: "test"` and `provenance.channel: "tty"`. The files that matter are signed
with a per-user key (holds) or hashed (approvals); an agent that can read the key can forge those too.
See [what forged provenance means](./run-modes.md#what-forged-provenance-still-means).

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

The table above is what applies when no run mode changes it. Test mode loosens two of its rows, inside
the declared environment only: a destructive control (the built-in `builtin:destructive` rule) is clicked,
and a write may reach an origin the test environment declares (its `baseUrl` and named `origins`, or the
origin a `targets.json` `trust: "test"` names). Each such action is noted in the run's evidence by rule or
origin and step, never a value or the control's name. Session-ending and paid controls, a target's own
`safety.deny`, a write to any other origin (an authored `allowedOrigins` entry included, since an agent can
author one) and a production origin are refused in test mode as in automation mode. The run mode adds two
refusals before any browser opens: a Journey approved over MCP, `ci` or `non-interactive` is refused on an automation-mode
target over MCP (`E_APPROVAL_CHANNEL_FOR_MODE`), and a Journey with a human step is refused on a test-mode
target (`E_HUMAN_STEP_IN_TEST_MODE`). A step only a person can do on an automation-mode target holds the
run instead (see [holds](./run-modes.md#holds-and-resume)), except in a proof: a proof never holds, and ends
`inconclusive` with `E_HUMAN_STEP_IN_PROOF`, so a resume can never pass off a plain run as a proof.

What does not guard a run today:

- A CLI run has none of the MCP refusals. The person at the terminal is the guard. A CLI run records its
  mode and target trust in the run's evidence, and warns on stderr when a draft Journey runs on an
  automation-mode target.
- `verify_fix` has only the production refusal of those above. Its replay stays on the origins the finding's mission
  was allowed: it can't be moved onto another one.
- `load run`, `explore`, a queued mission's run, `regression run`/`capture`, `verify-fix` and `source run`
  decide a run mode from the same files and record it, but do not go through the run hooks: they never
  hold. A load test applies the mode's Journey refusals before any browser; the others have no Journey
  approval to check (see [which runs have a mode](./run-modes.md#which-runs-have-a-mode)).
- The `targets.json` secret route covers `run_journey` and holds. It is not read by every tool that can run
  a Journey.
- An agent with write access to `.jevitate/` or `~/.jevitate/` can forge a target's `trust`, an approval's
  `provenance.channel` and a Journey's approval hash. A Journey's approval is a plain hash of its content,
  with no signature. A hold and its checkpoint carry a keyed MAC under `~/.jevitate/verify-checkpoint.key`,
  which shows they were written by a holder of that user's key and no more. The control is review: keep
  `.jevitate/` under branch protection and run `jevitate check --require-approvals`. Signing approvals with a
  key an agent cannot read is not in 0.30.0.
- A target declared nowhere (an agent's `baseUrl`, an IP or another scheme for a known site) is `unknown`, which
  runs as automation mode: it needs a person's approval. Its `production` flag, `safety.deny` and `mcpRun`
  still do not apply there, because nothing says they should. Origins are compared after normalising case,
  default port and a trailing dot, so an alias of a flagged host is still that host.
- A hold is only as strong as the person answering it. `inbox approve` shows what is held and asks for its
  id typed back, but it cannot tell a person from a script that types the id at a pseudo-terminal.
- Jev's write sentinel guards nothing in 0.30.0. It is off unless `JEVITATE_WRITE_SENTINEL=shadow` is
  set and a Jev key resolves; any other value, or no key, leaves it off and records nothing. In shadow mode
  it runs before each write step of a Journey run on an automation-mode target (`journey run`,
  `run_journey`, a drained queued call); a test-mode run is left alone. It asks Jev two questions: is this
  write destructive (`write.destructive`), and is it outside what the job intends
  (`write.outside-intent`). What Jev receives is structure only: the control's role and name from the
  stored step, the method (`UNKNOWN`, since the request is not yet sent), the page's path with every
  segment replaced by `:id` or `:param` (an API version such as `v1` stays, the query is dropped), and the
  job's id and title. No page text and no value is sent, and redaction stays on as a second layer. Each
  answer is recorded in the run's [evidence](./contracts/evidence.md) under `judgments`, as advisory, with
  the threshold `0.5`; a judgment at or above it is one an enforcing sentinel would have held. The write
  goes ahead either way, and no verdict reads a judgment. The Jev calls each write made, with their cost,
  are noted in the evidence's `notes`. Measured on 50 seeded writes, at 0.5 it caught 58 to 75% of the
  destructive ones with a precision of 0.93 to 1.00, and stopped none of 10 clean writes. That is not
  enough to gate on, and a confirm button in a delete dialog ("Confirm", "OK") cannot be told apart from
  structure alone.
- A secret-bound Journey still cannot self-heal or be annotated: nothing secret-bound goes to a model.
- A literal secret in a `run_check` params file, and a secret on the CLI argv (`regression`, `verify-fix`,
  `journey migrate --labels`), stay documented limits.
- A page's transformed copy of a secret (a masked or hashed form) is not recognised as the secret.
- A Journey's parameters are typed, and a value of the wrong type is refused before any browser
  (`E_JOURNEY_PARAM_TYPE`), but a type says nothing about whether a value is safe to send.
- There is no per-write receipt after a write whose outcome is unknown
  ([#795](https://github.com/matt-cochran/jevitate/issues/795)).

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
- A secret value passed as an MCP parameter is refused by name, before anything runs
  (`E_SECRET_PARAM_OVER_MCP`), in both run modes. A Journey that needs a secret the request leaves out
  runs over MCP only on an automation-mode target, with a Journey a person approved: the operator's
  `targets.json` `secretFields` type it on that origin, or the run holds for a person at a terminal. In
  test mode the same case is refused with `E_SECRET_PARAM_OVER_MCP`. See
  [run modes](./run-modes.md#how-a-secret-comes-back-over-mcp). On the CLI the value comes from an
  environment variable through `--secret-field` (on `journey run`, `verify`, `demo`, `chain`, `load run`,
  `source run` and the other replay commands) or `secretFields` in `targets.json`; `--param`
  still works and warns on stderr. Or the Journey uses a stored session and needs no secret
  ([Secret parameters on a replay](./journeys.md#secret-parameters-on-a-replay)).
- A credential-like name is refused however it is spelt, broadly on purpose. `secret: false` lifts that
  only when a person approved that Journey and the approval still matches it; per Journey. Provenance is
  detection, not proof: an agent that can edit the Journey file can also write the channel, and git
  review of `.jevitate/` is what catches that.
- The bindings a replay takes are `label|testId|id|name=<value>=env:<VAR>` for a field, and
  `param=<name>=env:<VAR>` for any secret parameter by its name. Use `param=` for a token in a `navigate` URL.
  The same specs work in `targets.json` `secretFields`, and a goal run never matches `param=` to a live field.
- A bound value goes only to its binding's origin. A `targets.json` binding is for the origin it is keyed by,
  and a `--secret-field` binding is for the run's allowlist. A field's binding is checked as the field is
  typed, and a navigate URL's as it is navigated, as resolved: a relative URL goes to the page's own origin.
  Anywhere else the run fails with `E_SECRET_ORIGIN_REFUSED`. A `navigate` URL whose literal origin is not the
  binding's is refused before anything runs, and so is an `http` check holding a bound parameter. Over MCP, a
  URL secret with no `param=` binding for the origin is refused with `E_SECRET_MODE_UNAVAILABLE`: it never
  holds, because a person can't type a URL in the browser. `editText` types real keys and checks before each one that the element's
  document is there, holds the focus and is on that origin. Limit: a page that navigates in the instant
  after that check can receive the key in flight, about one character, and nothing after it.
- Nothing secret-bound goes to a model. A Journey with a secret parameter, a fixture secret or a
  credential-named output, or a step that can extract a credential, doesn't self-heal. That is decided
  before it runs, so it holds at step 1, before the extract and when the extract itself is what broke:
  the step fails as it would without a heal, and says so. `journey annotate`, `annotate_journey` and
  `create_demo` refuse such a Journey (`E_MODEL_REFUSED_SECRET`). **The cost: a secret-bound Journey
  can't self-heal or be annotated.**
- That includes a working Journey whose only secret is a parameter's name, because the parameter name
  list is broad on purpose: a parameter `passengers` or `key` loses self-heal and annotate. Both
  refusals name the way out: declare the parameter `"secret": false` and have a person approve the
  Journey (a typed `journey promote` or a verified PR review). An approval over MCP lifts nothing.
- An `extract as` name is a credential's by a narrower rule, taken by its words (separators and
  camelCase split it): it holds an unambiguous term once separators are removed (`password`, `pwd`,
  `apikey`, `jwt`, `csrf`, `pincode`, …); or a word is, starts with or ends with `secret`, `token`,
  `session`, `cookie`, `otp`, `auth` (not `author`), `mfa`, `cvv`, `nonce` or `signature`; or a word is
  exactly `pass`, `pin`, `pw`, `sid`, `ssn`, `creds` or `key`. A last word that describes rather than
  holds a value (`count`, `type`, `length`, `name`, `label`, `channel`, `banner`, `expires`, …) lifts
  it. So `apiKey`, `authToken`, `session_id`, `user_pass` and `otp` still refuse, and `passengers`,
  `footprint`, `bypass_cache`, `token_count` and `cookie_banner` heal and annotate. The rule is by name:
  a credential extracted under a plain name (`note`) is not recognised. The same `"secret": false` way
  out applies to an extract name the rule still takes (`issueKey`, `secretary`).
- `explore --strategy coverage|exploratory` refuse `--secret`
  (`E_EXPLORE_SECRET_UNSUPPORTED`), since they can't keep it out. `--feature` makes no model call and
  masks it in its transcript, Recordings and result.
- Goal, adversarial and usability runs keep their `--secret` masking, applied before any cut, so a
  secret across a bound on a control's name, heading, option, announcement, page text or busy
  indicator leaves none of its characters. That covers a replay of a hang, on its fresh page, too. A secret the page transforms (lower-cased, say) is not recognised.
- The gateways (`OpenRouterGenerationGateway`, `JevJudgmentGateway`) hold a backstop for those three
  while they run: values of 8 characters or more, masked in every string and key, then checked, so a
  value still there stops the call, and gone when the run ends. Past 2000 live values a model call
  fails. A secret under 8 characters isn't masked there. A replay holding one makes no model call at
  all. Goal, adversarial and usability still make them, and a short secret is masked by their own set,
  not by the backstop. A secret of 6 characters or more is masked wherever it occurs. A shorter one:
  - 3 to 5 characters mixing letters and digits (`Pw12x`) is masked wherever it occurs, inside a
    longer token too (`abcPw12xdef` reads `abc«redacted»def`).
  - 3 to 5 characters of one kind (`1234`, `abc`, `a-b`) is masked where it doesn't continue a run of
    its own kind: `1234` in `pin1234x` but not in `12345`, `bag` not in `cabbage`. So a letters-only
    or digits-only short secret inside a longer word or number of the same kind still reaches the
    prompt.
  - 1 or 2 characters is masked as a whole token only, never inside a word or number.
- Redaction is for what a person or a model reads, never for what a page gets: a run that would type or
  navigate with masked text fails (`E_REDACTED_VALUE`), which includes a value that really does contain
  `«redacted»`. `journey chain` hands on what the producer extracted, except a value under a name the
  narrower rule refuses (`apiKey`, `token`), so that consumer fails instead.
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
