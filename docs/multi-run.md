# Repeats, personas and multiple actors

Three ways to run more than one browser session for a single question. All of them run
sequentially, each session in its own fresh browser context, and every comparison is made by
code.

## Repeat and vote: `--repeat` / `--min-agreement`

```bash
jevitate explore --strategy adversarial --url http://localhost:3000/settings --fake-ai \
  --repeat 5 --min-agreement 3
```

Runs the same mission N times, one after another. A finding counts only when it recurs in at
least `--min-agreement` runs (default: a majority). The rest are reported as `flaky`: seen, but
not counted. The overall outcome is the one at least that many runs agreed on; it is
`intermittent` when no single outcome reached `--min-agreement` runs, or when the top two are
tied.

**On disk.** Every multi-run writes `<outDir>/multi-run.result.json`, rewritten after every run so
a killed multi-run still leaves the runs it finished. Each run gets its own directory,
`<outDir>/run-<i>/` (1-based), holding that run's own artifacts plus `run.envelope.json` (its raw
`explore --json` envelope, `{ok: true, data}` or `{ok: false, error}`). The aggregate result's
`complete` field is `false` until every planned run has finished, `true` once it has; `resultPath`
is the aggregate file's own path. It also carries `cells` (one `CellResult` per persona, or a
single persona-less cell without `--persona`), `findings`/`flaky` (agreed/under-threshold findings,
each with a `stability` string like `"2/3"`), and `usage` (the runs' model usage summed, `partial`
when any run's envelope carried none).

## Persona matrix: `--persona` / `--personas`

```bash
jevitate explore --feature billing --url http://localhost:3000/billing \
  --persona admin=admin.json --persona viewer=viewer.json
```

Runs the same mission once per persona, each from its own Playwright storageState, and diffs
them: requests (method and templated path, with status), visible controls and outcomes. A 401 or
403 for one persona where another got a 2xx on the same request is listed as an RBAC
**candidate**. The diff is advisory: whether a difference is a bug depends on your roles.
`--personas <file>` takes the same list as JSON.

With personas, the multi-run result's `cells` array has one entry per persona (its own `--repeat`
runs, sub-directory `<outDir>/<persona-name>/run-<i>/`, and its own agreed `outcome`/`findings`),
and a top-level `diff` (`PersonaDiff`, `advisory: true` always) carries:

- `requestsOnlyIn` / `controlsOnlyIn`: `{item, presentFor, absentFor}` for each request
  (`METHOD /templated/path`) or control seen by some personas but not all.
- `statusDiffs`: `{request, statuses: {persona: [status, ...]}}` for a shared request whose
  response statuses differed by persona.
- `rbacCandidates`: `{request, denied: {persona: [401|403, ...]}, allowed: [persona, ...], title}`
  — the same request 2xx'd for one persona and was denied for another.
- `outcomes` (`{persona: outcome}`) and `outcomeDiffers` (`true` when personas didn't all reach the
  same outcome).

The top-level `outcome` is that shared outcome when every persona agreed, else `"mixed"`.

## Multi-actor missions: `--actor` (goal missions)

```bash
jevitate explore --url http://localhost:3000/items --goal "create an item titled Q3 plan" \
  --success 'visible:text=Q3 plan' --actor owner=owner.json --actor other=other-tenant.json \
  --invariants isolation.json --real
```

The first actor is the primary, the only session a model drives. Every other actor is an
observer in its own context that never clicks or types. It only runs the cross-actor checks
declared in the [invariants file](./invariants.md#multi-actor-checks-capture-and-deniedas): a
`capture` binds something the primary created (an id or URL), and a check gated on
`when.after: "capture.<name>"` then verifies from the observer's own session, with a read-only
`probe` (`as: "<actor>"`) or a `deniedAs` open, that it cannot see or open it. A violation is a
defect, like any other invariant. Session contents are never copied between actors, and
storageState files are never logged, only their paths. A probe's `authFrom.localStorage` token for
an observer is read straight from that observer's storageState file, so an observer used only for
probes never has to open a page; the token is never logged.

### Worked example: cross-tenant isolation on an SPA behind a dev proxy

The same `http://localhost:5173` SPA as the [fixtures example](./fixtures.md#worked-example-an-spa-with-a-localstorage-token-api-behind-the-dev-proxy):
the primary actor creates an item, and `other` — a second tenant's session, its own
`--storage-state` file — must not be able to open it.

`isolation.json`:

```json
{
  "capture": {
    "itemId": { "network": { "url": "**/api/items", "method": "POST", "json": "$.id" } }
  },
  "invariants": [
    {
      "id": "cross-tenant-item-hidden",
      "when": { "after": "capture.itemId" },
      "deniedAs": {
        "actor": "other",
        "open": "/items/${capture.itemId}",
        "expect": {
          "documentStatus": [404],
          "appResponses": { "url": "/api/items/*", "status": [404] }
        }
      }
    }
  ]
}
```

```bash
jevitate explore --url http://localhost:5173/items \
  --goal "create an item titled Q3 plan" --success 'visible:text=Q3 plan' \
  --actor owner=owner.json --actor other=other-tenant.json \
  --invariants isolation.json --real
```

The `capture` binds `itemId` from the JSON body of the primary's own `POST **/api/items` (the app's
create call, proxied through the dev server like every other API request). Once that binds, the
`other` actor's own browser context navigates to `/items/${capture.itemId}` and the invariant holds
only if the observer's document response is 404 **or** its own `/api/items/*` call comes back 404
— a 200 page with neither is a violation; an observer bounced to a login page is "session lost,"
never counted as "denied."
