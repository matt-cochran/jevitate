# Mission fixtures: known state before every run and replay

Exploration changes app state, and a replay that starts from different state proves little.
Fixtures put the app into a known state before a mission, restore it afterwards, and do the same
around **every replay**: hang confirmation, `verify-fix` and `regression capture`.

```bash
jevitate explore --strategy goal --url http://localhost:3000/projects/new \
  --goal "create a project named Demo" --success 'urlIncludes:/projects/' --fake-ai \
  --fixtures fixtures.json
```

```json
{
  "setup": [
    { "name": "project", "method": "POST", "url": "/api/projects", "json": { "name": "fixture" },
      "expectStatus": [201], "outputs": { "projectId": "$.id" } }
  ],
  "restore": [
    { "method": "DELETE", "url": "/api/projects/${setup.projectId}" }
  ]
}
```

- Steps are HTTP requests to an `--allow` origin only (`GET`, `HEAD`, `POST`, `PUT`, `PATCH`,
  `DELETE`), authenticated the way the page is: the `--storage-state` session or a
  `--secret-field` binding. A fixtures file can never carry literal credential headers or run a
  command.
- `outputs` bind values from a response (`$.json.path` or `header:<name>`) as `${setup.<name>}`,
  which you can use in `--url`, `--goal`, `--success`, a Journey's `--param`s and later steps,
  but never in the URL's origin.
  `secretOutputs` are redacted everywhere and never reach text a model sees.
- `${secretField.<VAR>}` puts a `--secret-field` value (read from `env:<VAR>`) into a step's
  `json`, `body` or `headers`, for example to log in to an app that keeps its token in memory.
  It is refused in a URL, never written to the step log, result or Recording, and redacted from
  every error. An unknown reference is refused before any browser or request. A credential
  header may hold only references, and a `${setup.x}` it uses must be a secret output.
  `verify-fix` re-binds the referenced variables.
- A setup that fails, times out or leaves a `${setup.x}` unresolved ends the run `inconclusive`
  as a configuration error. A mission never runs on unknown state.
- A target can declare its fixtures in `~/.jevitate/targets.json` instead of passing `--fixtures`.
- `--fixtures`/`--before`/`--after` are supported only with `--strategy goal` (the default): they
  refuse to start with any other strategy.

**Shell hooks.** `--before <cmd>` and `--after <cmd>` run your own commands around the mission and
every replay, only with `--allow-shell-hooks`, with a timeout (`--hook-timeout-ms`, default 60000)
that kills the process group. They come from your command line only, never from a file or a
model. `--before` runs **before** the fixture's HTTP `setup` steps (so it can do what an HTTP request
can't, e.g. seed a database directly or roll a container); `--after` runs **after** the HTTP
`restore` steps, so it can clean up whatever `--before` and the setup steps left behind.

- **`--before`'s stdout contract**: empty, or exactly one JSON object on stdout,
  `{"vars": {"<name>": <scalar>}, "secret": ["<name>", ...]}`. Each `vars` name becomes
  `${setup.<name>}`, exactly like an HTTP step's `outputs`; a name listed in `secret` is redacted
  everywhere the same way `secretOutputs` is. Anything else on stdout (not JSON, not that shape) fails
  the setup. Exit codes are always recorded; **stdout itself is never persisted** — only the bound
  var names and values (redacted for secrets) end up in the record.
- **`--after`** gets `{"vars": {...}}` — the run's current public (non-secret) outputs — as JSON on
  its **stdin**, so a teardown script knows what to clean up. Its own stdout is not read as a
  contract; only its exit code and (redacted) stderr are recorded.

## Worked example: an SPA with a localStorage token, API behind the dev proxy

A React/Vite dev server at `http://localhost:5173` proxies `/api/**` to the backend, so every
fixture request stays on the SPA's own origin — no extra `--allow` needed — and authenticates the
same way the page does: a bearer token the app keeps in `localStorage["authToken"]`, already
present in the `--storage-state` file a prior login wrote.

```json
{
  "setup": [
    { "name": "seed-item", "method": "POST", "url": "/api/items",
      "auth": { "from": "localStorage", "key": "authToken" },
      "json": { "title": "fixture item" },
      "expectStatus": [201], "outputs": { "itemId": "$.id" } }
  ],
  "restore": [
    { "name": "delete-item", "method": "DELETE", "url": "/api/items/${setup.itemId}",
      "auth": { "from": "localStorage", "key": "authToken" } }
  ]
}
```

```bash
jevitate explore --strategy goal --url http://localhost:5173/items \
  --goal "open the fixture item and archive it" --success 'visible:text=Archived' \
  --storage-state session.json --fixtures fixtures.spa.json --real
```

`auth: {from: "localStorage", key: "authToken"}` reads the token straight from `session.json`'s
`origins[].localStorage` for the request's own origin (`http://localhost:5173`) — never from a live
page — so it works whether or not the mission ever navigates the browser to a page that reads it
first.
