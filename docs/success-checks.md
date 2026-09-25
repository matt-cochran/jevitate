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
checks get.

```bash
jevitate explore --url https://app.example.test/contacts \
  --goal "find out how many contacts are overdue and report the count"
```
