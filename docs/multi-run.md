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
not counted. The overall outcome is the one at least that many runs agreed on, otherwise
`intermittent`.

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

## Multi-actor missions: `--actor` (goal missions)

```bash
jevitate explore --url http://localhost:3000/items --goal "create an item titled Q3 plan" \
  --success 'visible:text=Q3 plan' --actor owner=owner.json --actor other=other-tenant.json \
  --invariants isolation.json --real
```

The first actor is the primary, the only session a model drives. Every other actor is an
observer in its own context that never clicks or types. It only runs the cross-actor checks
declared in the [invariants file](./invariants.md): a `capture` binds something the primary
created (an id or URL), and a check gated on `when.after: "capture.<name>"` then verifies from the
observer's own session, with a read-only `probe` (`as: "<actor>"`) or a `deniedAs` open, that it
cannot see or open it. A violation is a defect, like any other invariant. Session contents are
never copied between actors, and storageState files are never logged, only their paths. A probe's
`authFrom.localStorage` token for an observer is read straight from that observer's storageState
file, so an observer used only for probes never has to open a page; the token is never logged.
