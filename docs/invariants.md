# App-declared invariants

Hard rules your app declares in a JSON file, evaluated by Jevitate around every action.

## App-declared invariants

An app team can declare its own hard rules in a JSON file that lives in its repo.
Jevitate checks them around every action and treats a violation as a defect, like a
console error or an HTTP 5xx: the outcome is `defects-found` and the exit code is `1`.
Jevitate evaluates the rules itself. No model is asked whether an invariant held, and
nothing in the file is run as code.

```json
{
  "observe": {
    "balance":    { "dom": { "selector": "[data-testid=credit-balance]", "number": true } },
    "imports":    { "probe": { "get": "/v1/imports?limit=1", "json": "$.total" } },
    "confirmEst": { "dom": { "selector": "[data-testid=confirm-estimate]", "number": true, "optional": true } },
    "lastCharge": { "network": { "url": "**/v1/billing/credit-activity*", "json": "$.entries[0].credits", "optional": true } }
  },
  "invariants": [
    { "id": "charge-implies-delivery", "require": "delta(balance) < 0 -> delta(imports) >= 1",
      "settle": { "withinMs": 600000, "pollMs": 5000 } },
    { "id": "open-is-free", "when": { "control": { "name": "/Open as editable workspace/i" } },
      "require": "delta(balance) == 0" },
    { "id": "estimate-honest", "when": { "control": { "name": "/Confirm|Run|Analyze/i" } },
      "require": "confirmEst == null || delta(balance) >= -1.5 * before(confirmEst)" },
    { "id": "no-raw-rpc-errors", "never": { "pageText": "/\\[(deadline_exceeded|unavailable|internal|unknown)\\]/" } }
  ]
}
```

```bash
jevitate explore --url http://localhost:5173/imports --goal "import https://example.com" \
  --success 'visible:testId=import-result' --allow http://localhost:5173 --allow http://localhost:8088 \
  --invariants invariants.json
```

**Observables** are named and read-only:

- `dom`: the text of the first match of a `selector` (CSS) or a `target` descriptor.
  Add `read: "value"` for a form value, `read: "count"` for the number of matches, and
  `number: true` to parse the first number (`"≈ 1,240 credits"` becomes `1240`; a Unicode
  minus `−` (U+2212) or dash and thousands separators are handled, e.g. `"−40 credits"`
  is `-40`, not `40`). `number: { "index": <n> }` picks a different one (0-based;
  negative counts from the end), and `number: "all"` reads every number in the text as a
  LIST observable — e.g. a range `"≈ 30–90 credits"` (the en-dash stays a separator, never
  a sign) is unreadable as a single scalar with plain `number: true` (`30`, the low bound);
  `number: { "index": 1 }` (or `{ "index": -1 }`) reads `90`, its upper bound, and
  `number: "all"` reads `[30, 90]`. A list observable is never a valid scalar for
  `before`/`after`/`delta` or a budget, and a leaked list is never re-leaked item by
  item — only its size is shown in a finding.
  Visual state: `read: "inViewport"` (the first match's visible fraction, 0..1),
  `read: { "attr": "<name>" }`, or `read: { "style": "<prop>", "channel": "alpha", "reduce": "min" }`
  (a computed style from the allowlist above; with a `channel` it is a number, and `reduce`
  `first`/`min`/`max` picks across matches). For example, a heat map whose highlights must stay
  visible: `"heatAlpha": { "dom": { "selector": "[data-heat]", "read": { "style": "background-color",
  "channel": "alpha", "reduce": "min" } } }` with `"require": "heatSpans >= 1 -> heatAlpha > 0"`.
- `network`: a JSON path in the last response whose URL matches the glob. Only
  responses from an authorized origin are read.
- `probe`: a `get` (or `head`) of an existing endpoint. It must be on an `--allow`
  origin, and it runs with the mission browser's own cookies. Redirects are not
  followed, and nothing else is sent: no other method, headers or body (except
  `authFrom`'s `Authorization` header — see below). Without `json`, the value is the
  HTTP status.
  - `authFrom` (read-only probes, an authenticated API): `{ "localStorage": "<key>" }`
    reads a token from the run's own page (`page.evaluate`); `{ "cookie": "<name>" }`
    reads a named cookie from the browser context; `{ "secret": "env:VAR" }` resolves
    from the environment (the same `env:VAR` shape `--secret-field` uses) — never read
    from a file. All three become an `Authorization` header, prefixed by `scheme`
    (default `"Bearer"`; `""` sends the raw value). The token is never logged, never
    persisted, and is redacted from every value/evidence the same way a bound secret
    is. When the token cannot be read, the probe is refused (unknown) — never sent
    unauthenticated.

`optional: true` makes a missing value `null`. Without it, a value that cannot be read
makes the invariant **unknown**. An unknown invariant is not a violation and is not a
pass: it is counted in the result's `invariants` report.

**Invariants** are each one of:

- `require`: an expression checked after each action that matches `when` (every
  action when `when` is left out). `when` can match `control.name` (an exact string or
  a `/regex/flags` pattern), `route` (a path glob) and `op` — `op` is an ARRAY of one
  or more action-op names (e.g. `"op": ["click", "type"]`, not a bare string), matched
  if the action's op is any one of them. The op vocabulary: `click`, `type`, `send`
  (type-and-submit, e.g. a chat composer), `select`, `upload`, `scroll_up`,
  `scroll_down`, `wait`, `reload`. An op outside that list (a natural guess like
  `"navigate"` or `"scroll"`) is refused when the file loads, with the valid ops listed,
  instead of validating and never firing. The same holds for `capture.*.after.op`.
- `never`: `pageText` (a pattern), `assertion` (a success-check assertion) or `response`
  that must never hold. It is checked after every action.
- `never.response`: an app response on the mission's **own** traffic that must never be
  seen, e.g. a role's guaranteed billing 403:

  ```json
  { "id": "no-billing-403", "never": { "response": { "url": "/api/v1/tool/billing/**", "status": "403" } } }
  ```

  `status` is an exact code (`"403"` or `403`) or a class (`"4xx"`); `method` (`"GET"`,
  `"POST"`, …) optionally narrows it. `url` is a glob (`**` any run, `*` any run without `/`):
  when it starts with `/` it matches the response URL's **path** (with or without its query
  string); otherwise it must match the **whole URL** (`"https://api.example.test/v1/**"`).
  Only responses from the mission's authorized origins are ever matched — the start URL's
  own origin unless `--allow` names others — so a third-party 403 never fires it. Every
  matching response is evidence: method, full URL (redacted), status and the step it
  happened in (`GET https://app.example.test/api/v1/tool/billing/summary?ws=7 → 403 (step 0:
  page load)`); the violation's `responses` lists them as `{ method, url, status, step }`,
  step 0 being the page load before any action. A response to the last action that lands
  after its check (still in flight, e.g. slower than the long-poll threshold) is still caught when
  the run ends — every mission waits up to 5 s for such a request. Unlike `deniedAs.expect.appResponses`,
  no observer actor is needed.
- `always`: an assertion that must hold after every action.

The expression language is small: `before(x)`, `after(x)` (or just `x`), `delta(x)`,
`+ - * /`, `== != < <= > >=`, `&&`, `||`, `->` (implication), `null`, `true` and `false`.
`settle` re-checks a **violated** `require` until it holds or `withinMs` passes, and only
then counts the violation. An **unknown** result (an observable that could not be read —
e.g. legitimately absent, `optional: true`) is never re-polled: it is reported at once, so
an absent observable never stalls an action for the whole `withinMs` window.

**Refusals and results.** A file that does not validate is refused before any browser
opens, with the path of the problem, e.g. `inv.json: invariants[2].require: unknown observable "balanse"`.
So is a probe that is not a GET/HEAD or not on an authorized origin, and any unknown key.
`--invariants` can be repeated, and it works with the goal, coverage, exploratory,
adversarial and `--feature` missions. Each violation's defect carries:

- the invariant's `id` and expression,
- the before and after values (redacted),
- the action and route,
- the probe and network evidence (method, URL and status only, never a body).

**Linting files in CI (no browser).** `jevitate invariants validate <file…>` runs exactly
the check above — schema, observables, merge across files, probe origins — and nothing else:

```bash
jevitate invariants validate invariants/*.json --url https://app.example.test/ --json
```

It exits `0` when every file is valid and `1` otherwise, printing each file's path-precise
problems. With `--json` the envelope's `data` is `{ valid, files: [{ file, valid, invariants?,
problems }], merge, hint? }` (`merge` lists conflicts between otherwise-valid files). Probe and
`deniedAs` origins are authorized only against `--url` (and `--allow <origin>`, repeatable,
which replaces the URL's own origin as on `explore`); without `--url` a file with probes is
refused, never assumed safe. A `deniedAs.actor` or probe `as:` must be named with
`--observer <name>` (repeatable).

A defect's fingerprint is the invariant id plus the route. The result also stores the
spec, so `jevitate verify-fix --result … --fingerprint …` re-checks the same invariant
by replaying up to the step. `--invariants` on `verify-fix` overrides the saved spec.
Over MCP, `queue_exploration` takes the same spec inline as `invariants`. It never takes
a path, and its probes are checked against the target's origin.

## Multi-actor checks: `capture` and `deniedAs`

With [multiple `--actor`s](./multi-run.md#multi-actor-missions---actor-goal-missions) declared, the
same invariants file can add cross-actor checks: bind something the **primary** actor created, then
verify from an **observer**'s own browser context that it can (or cannot) see it.

```json
{
  "capture": {
    "itemId": { "network": { "url": "**/api/items", "method": "POST", "json": "$.id" } }
  },
  "invariants": [
    { "id": "cross-tenant-item-hidden", "when": { "after": "capture.itemId" },
      "deniedAs": { "actor": "other", "open": "/items/${capture.itemId}",
        "expect": { "documentStatus": [404], "appResponses": { "url": "/api/items/*", "status": [404] } } } }
  ]
}
```

**`capture`** binds a resource id or URL from the primary actor's own run, once, read-only, and
never from an observer. Exactly one of:

- `network`: a JSON path in a captured response, from a request whose URL matches a glob
  (`{ "network": { "url": "**/api/items", "method": "POST", "json": "$.id" } }`).
- `dom`: the first match's `text` (default), `value`, or `attr:<name>`, of a CSS `selector` on the
  primary's page, optionally gated on `after` (see below).
- `url`: the primary's own page URL once an action matching `after` settles, optionally narrowed
  further to a path glob with `route`.

A `dom`/`url` capture's own `after` (`CaptureWhen`: `control.name`, `route`, `op`) names which of
the primary's actions binds it — the same vocabulary as an invariant's `when`.

**`when.after: "capture.<name>"`** gates an invariant to run exactly once, right after that capture
first binds — a capture-gated invariant takes no other `when` key (no `control`/`route`/`op`), and
is either a `require` (over an observer's own `probe` observable, `as: "<actor>"`) or a `deniedAs`.

**`deniedAs`** navigates the named observer actor's own context to `open` (`${capture.<name>}`
substituted; passive — the app makes its own reads, nothing is clicked) and holds only when **any**
declared `expect` is observed:

- `documentStatus`: the observer's main-frame response status is one of these.
- `appResponses`: `{url, status?, connectCode?}` — an app request matching the `url` glob answers
  with one of `status` or one of `connectCode` (snake_case Connect/gRPC-web codes, e.g.
  `"not_found"`; at least one of `status`/`connectCode` is required).
- `orVisible`: page text matching this pattern is visible.

A 200 page with **none** of the declared expectations is a violation. An observer redirected to a
login page ("session lost") is undecided — never counted as "denied." A violation is a defect, like
any other invariant; the observer only ever probes and navigates, it never clicks or types.

See [multi-run.md](./multi-run.md#worked-example-cross-tenant-isolation-on-an-spa-behind-a-dev-proxy)
for the same example run end to end.

## Mission spend budgets

A `budget` key in the same invariants file caps cumulative spend on a declared observable, such
as a credits balance that pays for real provider calls:

```json
{
  "observe": {
    "credits":    { "probe": { "get": "/v1/billing/balance", "json": "$.credits" } },
    "confirmEst": { "dom": { "selector": "[data-testid=confirm-estimate]", "number": true, "optional": true } }
  },
  "invariants": [],
  "budget": [
    { "observe": "credits", "maxDelta": -150, "guard": { "estimate": "confirmEst", "factor": 2.0 },
      "settle": { "withinMs": 600000, "pollMs": 10000 }, "onUnreadable": "stop" }
  ]
}
```

- Code reads the observable at run start and after every settled step. Crossing `maxDelta`
  (negative caps spend, positive caps growth) stops the mission before its next action, with
  `stop: "budget"`. The mission outcome is `inconclusive`, or `defects-found` if a defect was
  already found. It is never `clean` and never `crashed`.
- `guard` (optional) refuses a paid action whose `estimate × factor` would cross the remaining
  budget. A missing estimate is refused, never treated as zero.
- `settle` keeps reading after the run ends, to catch a charge that lands late.
- An unreadable observable stops the run (`onUnreadable: "stop"`, the default) rather than being
  treated as unspent.
- The result carries a `budget` trajectory per declaration (baseline, final, delta, per-action
  readings).
- It applies to every mission type: goal, coverage, exploratory, `--feature`, adversarial and the
  usability review. Usability reads only the `budget` part of the file; a file that also declares
  invariants or captures is refused for usability before any browser opens.
