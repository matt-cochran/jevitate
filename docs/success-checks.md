# Success checks, rich-text edits and find-out goals

How a goal mission decides whether it succeeded: independent checks evaluated by code, never the model's own "done".

## Success checks (goal mission)

A goal run succeeds only if its independent checks hold. The model's "done" never
decides it. `--success` can be repeated, and every check must hold:

| Check | Holds when |
|---|---|
| `urlIncludes:<text>` | the final URL contains the text |
| `visible:<d>` | the element is visible |
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
| `requestMade:<METHOD> <path-glob>` | the run sent a matching request (catches a save that sends nothing) |
| `responseStatus:<METHOD> <path-glob>=<2xx\|4xx\|code>` | there was at least one matching request, and every matching response had that status |

In these specs:

- `<d>` is `testId=…;role=…;name=…;label=…;text=…;css=…`, or a CSS selector
  (`[data-testid=x]` is read as the test id).
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
- Network checks look only at the requests the run itself made. The reload that
  `reloadThen` performs is not counted.
- The goal loop can also choose a `reload` step itself.

**When the checks must hold (`--success-when`).** By default (`final`) every check is read
on the final page. `--success-when held` also accepts the checks holding all together at any
settled step, for a state that does not last (a one-time secret, a toast). A held check
counts only once it went from not holding to holding: one that already held on the start
page and never changed fails as vacuous, with a warning in the result (`checkWarnings`).
Once every check has held, code ends the run as done before the next action, so it never
keeps acting or writing past a met goal. `reloadThen` checks are always read on the final
page.

The result lists each check with what the oracle saw, so a failing run names the
check that caught it:

```bash
jevitate explore --url https://app.example.test/profile --goal "set the last name to Litmus and save" \
  --success 'requestMade:PUT /api/profile' --success 'responseStatus:PUT /api/profile=2xx' \
  --success 'reloadThen:valueEquals:[data-testid=last-name]|Litmus'
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
read-only guard. Code refuses controls that start a write flow (checkout, upgrade, create,
save, confirm, submit, send, upload) and blocks the write requests a model-chosen action
fires; each refusal is recorded and told to the model. The app's own background writes
outside an action (token refresh, heartbeats, telemetry) pass and are listed in
`sideEffects` with `background: true`, and auth-refresh paths (`**/refresh*`, `**/token*`,
`**/oauth/**`, `**/auth/**/refresh*`) are never blocked. The guard only blocks writes to the
app itself: the `--allow` origins, plus other ports and sibling subdomains of their hosts (an
API at `api.example.com` next to `app.example.com`). A write to any other origin, such as
Stripe.js's fraud beacon to `https://m.stripe.com/6`, analytics or telemetry, is third-party.
It is never blocked. It is listed in `sideEffects` with its full URL and `thirdParty: true`.
Code decides this from the request URL. The model plays no part. A paid or checkout control is
still refused before it is clicked, whichever origin its request would go to. Side effects and
refusals always show a request outside the `--allow` origins as origin plus path.
`--allow-write <glob>` (repeatable)
exempts more request paths, and `--allow-writes` lifts the guard. In
`~/.jevitate/targets.json`, `safety.allowWrites` is `true` (lift it) or an array of path globs
(exempt them). The paid/destructive policy in
[Safety](./safety.md) still applies either way.

**Scrolling is progress.** A scroll that moved the page counts as progress, so a find-out
goal whose answer is further down the page is not stopped as "no progress". Before a
no-progress stop, the model gets one last turn; on a find-out goal, giving up on that turn
becomes a report attempt, still grounded by code.

```bash
jevitate explore --url https://app.example.test/contacts \
  --goal "find out how many contacts are overdue and report the count"
```
