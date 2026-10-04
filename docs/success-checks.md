# Success checks, rich-text edits and find-out goals

How a goal mission decides whether it succeeded: independent checks evaluated by code, never the model's own "done".

## Success checks (goal mission)

A goal run succeeds only if its independent checks hold. The model's "done" never
decides it. `--success` can be repeated, and every check must hold:

| Check | Holds when |
|---|---|
| `urlIncludes:<text>` | the final URL contains the text |
| `visible:<d>` | at least one matching element is visible (a list row matching several elements is fine) |
| `textIncludes:<d>\|<text>` | the element's text contains the text (case-insensitive) |
| `count:<d>\|min=<n>,max=<n>` | the number of matching elements is within the bounds |
| `valueEquals:<d>\|<value>` | a form control's **value** (input, textarea, select) equals the value exactly |
| `style:<d>\|<prop><op><value>` | the **computed** style of every match (at least one) compares true — e.g. `style:[data-heat]\|alpha(background-color)>0`, `style:#title\|color=rgb(255, 0, 0)` (`styleMatches:` is an alias) |
| `inViewport:<d>[\|min=<ratio>]` | the visible fraction (0..1) of every match's box inside the viewport is at least `min` (default 0.5) |
| `box:<d>\|minWidth=<n>,maxWidth=<n>,minHeight=<n>,maxHeight=<n>` | every match's rendered size (CSS px) is within the bounds |
| `overlaps:<d>\|<d2>` / `noOverlap:<d>\|<d2>` | the first matches' boxes do / do not overlap |
| `attr:<d>\|<name>=<value>` | the first match's attribute equals the value (`attr:<d>\|<name>`: present; `attr:<d>\|!<name>`: absent) |
| `flashed:<d>\|class=<cls>[\|withinMs=<n>]` | a match **gained** the class (or `attr=<name>`, or `animation`) after the last user input — a transient flash that is gone by the time the page settles |
| `reloadThen:<check>` | the page is reloaded first, then the check holds (proves the value persisted) |
| `requestMade:<METHOD> <path-glob>` | the run sent a matching request (catches a save that sends nothing). A request counts once it is sent, even when its response has not arrived (a long-running RPC the server holds open) |
| `responseStatus:<METHOD> <path-glob>=<2xx\|4xx\|code>` | there was at least one matching request, and every matching response had that status (requests still awaiting a response are not judged; the check fails if none has answered) |

In these specs:

- `<d>` is `testId=…;role=…;name=…;label=…;text=…;css=…` (key=value pairs joined by `;`). It is
  read in this order: (1) a descriptor starting with `[`, `#` or `.` is CSS verbatim
  (`[data-testid=x]` is read as the test id); (2) otherwise, any recognised `key=` pair (`testId`,
  `role`, `name`, `label`, `text`, `css`) wins; (3) with no recognised pair, the descriptor is read
  as CSS only when it is a **lowercase-only, syntactically valid CSS selector** — which may itself
  contain `=`, e.g. `input[name=email]` (`input` is not a key) — a tag name or a combination of them, classes, ids, attributes, pseudo-classes, e.g.
  `visible:h1`, `textIncludes:main h1|Welcome`, `visible:body`, `visible:div.card`,
  `visible:ul > li`. HTML tag/class/id names are conventionally lowercase, so requiring the WHOLE
  string to be lowercase is what tells a genuine selector apart from a plain accessible-name phrase
  (`Display name` has a capital `D`: never guessed at as CSS, and never guessed at as text either).
  A bare descriptor that is not a valid key=value spec and not a lowercase CSS selector is refused
  with a hint naming the key=value forms (`css=`, `label=`, `testId=`, `role=`, `text=`) and an
  example — never a silent guess.
  At least one of `testId`, `role`, `label`, `text` or `css` must be set (`name` alone only narrows
  a `role`). Because pairs split at `;`, a `css=` value cannot contain `;`.
- `text=` matches an element whose **whole** text is exactly that text. `textContains=` (#335)
  matches an element whose text contains it, case-insensitively, wherever it is on the page
  (including below the fold). `textIncludes:textContains=This demo has|This demo has` holds on
  `<h1>This demo has ended</h1>`, while `text=This demo has` finds no element there. When an exact
  `text=` check fails but some element contains the text, the failure says so and names the
  `textContains=` form to use.
- The last `|` separates the descriptor from the text or value (for `style` too). The other
  visual kinds split the descriptor off at the first `|`.
- Visual-state checks are read by fixed built-in page functions and decided by code, never a
  model, and never by evaluating a declared string. `<prop>` is one of an allowlist (`color`,
  `background-color`, `opacity`, `visibility`, `display`, `outline-color|style|width`,
  `border-{top,right,bottom,left}-color`, `transform`, `font-weight`, `font-style`,
  `text-decoration-line`, `fill`, `fill-opacity`, `stroke`), optionally one numeric channel of it:
  `alpha(…)`, `r(…)`, `g(…)`, `b(…)` of a color, `px(…)` of a length. `<op>` is
  `= != > >= < <=`; `=`/`!=` compare colors as colors (`red` = `rgb(255, 0, 0)`). A missing
  element or a value that cannot be read as asked never holds, and the result says what was
  observed (the ratio, the computed values, the flash timing).
- `flashed` needs its recorder installed before the action that triggers the flash; the goal
  mission installs it at the start of any run with a `flashed` check. Canvas pixels are not read:
  expose canvas state through DOM/ARIA/`data-*` and check that.
- Path globs match the request path: `*` within one segment, `**` across segments.
  A method of `*` matches any method. **The glob must start with `/`** (it matches the
  request's path, not a full URL) — `requestMade:POST */Foo` is rejected with
  `path glob must start with "/" (got "*/Foo")`, not the generic shape error.
- Network checks look only at the requests the run itself made: those sent **after the run's
  first action** (a click, a type, a select… or a `reload` the run chose). A request the page load, a poll or
  anything before that first action sent is not counted (there is no `since:<step>` qualifier;
  a poll that keeps firing after the first action still counts). The reload that `reloadThen`
  performs is not counted.
- The goal loop can also choose a `reload` step itself.

**When the checks must hold (`--success-when`).** By default (`final`) every check is read
on the final page. `--success-when held` also accepts the checks holding all together at any
settled step, for a state that does not last (a one-time secret, a toast). A held check
counts only once it went from not holding to holding: one that already held on the start
page and never changed fails as vacuous, with a warning in the result (`checkWarnings`).
Once every check has held, code ends the run as done before the next action, so it never
keeps acting or writing past a met goal. `reloadThen` checks are always read on the final
page.

`--success-when each` (#337) is for a goal whose checks live on different pages, for example
"connect payments (Connections shows Connected), then confirm Pricing shows Payments ready". No
single page holds both, so neither `final` nor `held` (all together) can pass. Under `each`,
every page check counts once it went from not holding to holding at some settled step, each at
its own step and in any order. A check that held on the start page and never changed is vacuous,
as under `held`. Once every check has held, code ends the run as done before the next action.

**Vacuous checks (`--allow-vacuous-checks`).** A check that was already satisfied before the
run did anything cannot verify the goal, so by default it **fails**, and the result names it
(`checkWarnings`), e.g. `check 'visible:testId=list' held at step 0, before any action — it
cannot verify the goal`. A run that proved nothing is never clean. This covers:

- a page or `reloadThen` check that already held on the seed page and was never seen not
  holding at a later settled step (a results container that renders empty at once: its
  content only arrives after the action, but `visible:` holds from the first look);
- a `requestMade` / `responseStatus` check matched only by requests sent before the run's
  first action (page load, polling).

Use a check the goal's own work must change instead: `count:<item d>|min=1` for a list that
should gain an entry, `textIncludes:<d>|<text>` for the content, `reloadThen:…` for
persistence. `--allow-vacuous-checks` (suite: `"allowVacuousChecks": true` on a goal item or
target) downgrades a vacuous check to a warning — it then counts as a pass, and network checks
count every captured request again. Under `--success-when held` this is the same rule as the
start-page rule above.

The result lists each check with what the oracle saw, so a failing run names the
check that caught it. A failing `textIncludes` or `valueEquals` (including `reloadThen:valueEquals`)
names what was actually read, bounded and redacted — e.g. `did not hold after a reload (read:
"Lovelace")` for a save that never persisted, instead of a bare "did not hold" that leaves you
guessing whether the value was wrong or just differently cased.

```bash
jevitate explore --url https://app.example.test/profile --goal "set the last name to Litmus and save" \
  --success 'requestMade:PUT /api/profile' --success 'responseStatus:PUT /api/profile=2xx' \
  --success 'reloadThen:valueEquals:[data-testid=last-name]|Litmus'
```

## Typing a file's exact text (`--type-fixture`)

A goal that quotes a passage to type has it typed as quoted, but a long text, or one whose line
breaks matter, is better kept in a file: `--type-fixture '<descriptor>=<file>'` (repeatable, goal
strategy; the descriptor is `label=`, `testId=`, `type=`, `id=` or `name=`, as for
`--secret-field`). When the run types into a matching field, code types the file's contents
verbatim: line breaks kept, never paraphrased, never cut by the generated-text cap. The model sees
only `«fixture:<file name>»` on the field. The file must exist and be UTF-8 text of at most 256 KiB.
The Recording keeps the typed text, so a Journey replays it exactly. If the text contains a
`--secret`, the fill is recorded `{ redacted: true }` instead. Over MCP the argument is
`typeFixture`, and its file path is confined like every other path argument.

```bash
jevitate explore --url http://localhost:8088/import --goal "Import this text and analyze it" \
  --type-fixture 'label=Paste your text=./fixtures/newsletter.txt' --success 'visible:text=Analysis ready'
```

## Rich-text editors

A `contenteditable` element (a document editor's prose block) is also offered the `edit_text`
op: an edit INSIDE its text instead of `type`, which replaces the whole element. The model
proposes one edit — `replace` a verbatim quote of the current text, `insertBefore`/`insertAfter`
it, or `format` it (bold/italic/underline via the keyboard shortcut) — and code checks it: the
quote must occur in the element's text exactly once, and neither the quote nor the typed text
may contain a registered secret. A quote that is not there is refused, never degraded to
replacing the whole element. The caret/selection is placed with a DOM Range and the text is
typed with keyboard events. The Recording stores the anchor as an `editText` step
(`anchor: { quote } | { start, end } | { at: "start" | "end" }`), and replay places the same
anchor in the element's current text — a quote that has gone fails the replay closed.

```bash
jevitate explore --url http://localhost:8088/editor --goal "in paragraph 2, change 'quick' to 'slow'" \
  --success 'reloadThen:textIncludes:#b2|slow brown fox'
```

## Find-out goals (no `--success`)

A goal that asks the run to find out / understand something (e.g. "find out how many
contacts are overdue and report the count") has no page state to assert on, so
`--success` can be omitted. The model ends such a run with a `report` op instead of
`done`: it proposes an answer, and code grounds it — every claim must trace back to
text the run actually observed on a page — before accepting it. An ungrounded report
is rejected and the model keeps looking; the run is `succeeded` only once a report is
accepted, and the accepted answer (with its grounding evidence) is returned as
`answer`. Never Jev's self-report: the same independent-grounding rule the page/network
checks get. A figure counts as a stated figure only when it stands free (`$25`, `25%`,
`1,234`, `5GB`, `24h`); digits inside a word (`2FA`, `v2`, `S3`) do not, figures the goal
itself states need no page, and a rejection quotes the offending token.

**Read-only by default.** A find-out goal that does not itself ask for a change runs under a
read-only guard. Code refuses controls whose name starts a write flow (checkout, upgrade,
create, save, confirm, submit, send, upload) and blocks the write requests a model-chosen action
fires; each refusal is recorded and told to the model. A form submit is judged by the requests it
sends, not its shape: a lookup form's "Load" or "Search" that only reads (GET/HEAD, a `Get*`/`List*`
RPC, or a `--read-rpc` match) is clicked, and a submit that writes is blocked at the network (a
native form POST is answered in the browser with `204 No Content`, so the page stays where it was). The app's own background writes
outside an action (token refresh, heartbeats, telemetry) pass and are listed in
`sideEffects` with `background: true`, and auth-refresh paths (`**/refresh*`, `**/token*`,
`**/oauth/**`, `**/auth/**/refresh*`) are never blocked. The guard only blocks the app's own writes: those to the
`--allow` origins or their sites, those that carry API credentials (an `Authorization` or
API-key header), and those to an origin the page already sent credentials to. Any other write,
such as Stripe.js's fraud beacon to `https://m.stripe.com/6`, is third-party. It is never
blocked and is listed in `sideEffects` with its full URL and `thirdParty: true`. The exact rule
and its limit are in [Safety](./safety.md). Side effects and refusals always show a request
outside the `--allow` origins as origin plus path.
`--allow-write <glob>` (repeatable)
exempts more request paths (a glob starting with `https://` matches origin and path, e.g.
`--allow-write "https://abc.supabase.co/rest/v1/**"`), and `--allow-writes` lifts the guard. In
`~/.jevitate/targets.json`, `safety.allowWrites` is `true` (lift it) or an array of path globs
(exempt them). The paid/destructive policy in
[Safety](./safety.md) still applies either way.

**Never destructive without the operator.** A goal with no `--success` that asks for a change
("Remove a product…", "Create a key…") is not read-only, but it still never destroys anything on
its own words: a destructive control (Delete, Remove, Revoke…) is refused before the click, and a
destructive write request an action fires (`DELETE`, a `Remove*`/`Delete*`/`Revoke*` RPC, a
`/remove`-like path segment) is blocked, whatever the control is called. Pass `--allow-writes` (or
`--allow-destructive`) to permit it.

**Scrolling is progress.** A scroll that moved the page counts as progress, so a find-out
goal whose answer is further down the page is not stopped as "no progress". Before a
no-progress stop, the model gets one last turn; on a find-out goal, giving up on that turn
becomes a report attempt, still grounded by code.

```bash
jevitate explore --url https://app.example.test/contacts \
  --goal "find out how many contacts are overdue and report the count"
```
