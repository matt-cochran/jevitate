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
  but never in the URL's origin. In `--url`, a reference can sit right after the origin
  (`--url 'http://localhost:3000${setup.link}'`) when its value is a root-relative path such as
  `/join/abc`. A bound value that would move the URL off its origin (`@evil.test`, `:8080`) is
  refused.
- A step can authenticate as a **named identity** (`"auth": {"from": "cookies", "identity": "owner"}`)
  instead of the mission's session. See [fixture identities](#fixture-identities-mint-as-one-user-run-as-another).
  `secretOutputs` are redacted everywhere and never reach text a model sees.
- `${secretField.<VAR>}` puts a `--secret-field` value (read from `env:<VAR>`) into a step's
  `json`, `body` or `headers`, for example to log in to an app that keeps its token in memory.
  It is refused in a URL, never written to the step log, result or Recording, and redacted from
  every error. An unknown reference is refused before any browser or request. A credential
  header may hold only references, and a `${setup.x}` it uses must be a secret output.
  `verify-fix` re-binds the referenced variables.
- A setup that fails, times out or leaves a `${setup.x}` unresolved ends the run `inconclusive`
  as a configuration error. A mission never runs on unknown state.
- A target can declare its fixtures in `~/.jevitate/targets.json` instead of passing `--fixtures`. A
  Journey run with `--env` can also take them (and `hooks`) from its environment in
  `.jevitate/environments.json` ([environments](./journeys.md#environments---env)).
- `--fixtures`/`--before`/`--after` are supported only with `--strategy goal` (the default): they
  refuse to start with any other strategy.

## Fixture identities: mint as one user, run as another

Token flows such as invites, intake links, open sign-up links and teammate invites have two
parties. The **owner** creates the link and a **recipient**, often with no session at all, opens
it. To test the recipient's experience, the fixture has to mint as the owner while the mission
browser runs as somebody else, or cold. Otherwise the run only shows the owner's "you're already
signed in" page.

A step's `auth` can name an `identity`. The engine authenticates that step from the identity's
own storageState file, using its `localStorage` key or its `cookies`, exactly the way it uses the
mission's session. The mission's own session is `--storage-state`, or nothing at all.

```json
{
  "setup": [
    { "name": "mint-invite", "method": "POST", "url": "/api/invites",
      "auth": { "from": "cookies", "identity": "owner" },
      "expectStatus": [201], "outputs": { "link": "$.url", "token": "$.token" } }
  ],
  "restore": [
    { "name": "revoke-invite", "method": "DELETE", "url": "/api/invites/${setup.token}",
      "auth": { "from": "cookies", "identity": "owner" } }
  ]
}
```

```bash
# The owner's session comes from a prior login (e.g. `jevitate profile`/a Playwright storageState).
# The mission has NO --storage-state: it opens the minted link as a cold recipient.
jevitate explore --strategy goal --url 'http://localhost:3000${setup.link}' \
  --goal "accept the invite" --success 'textIncludes:css=h1|Welcome' \
  --fixtures invite.fixtures.json --fixture-identity owner=owner.json --real
```

- **Binding an identity.** `--fixture-identity <name>=<storageState>` is repeatable and also
  available as `fixtureIdentity` over MCP and in a `check --suite` goal item. Without the flag, an
  identity binds to the `personas.<name>.storageState` that `~/.jevitate/targets.json` declares for
  the mission's origin. The flag wins over the persona.
- **Failing closed.** If a step names an identity that nothing binds, the run is refused
  (`E_FIXTURE_SPEC`) before any browser opens or any request is sent. It never falls back to the
  mission's session. A `--fixture-identity` that no step uses, or one whose file does not exist, is
  refused too.
- **Safety.** The fixtures file names only the identity, never a path or a credential. The
  operator binds the file. The engine reads the storageState for each request, puts the header on
  the wire only, and never writes it to a log, the result, the Recording or text a model sees. The
  result records only the identity's **path** (`fixtures.identities`), the same way `--actor`
  records its paths. The allowlist rules apply unchanged: a step still reaches only an `--allow`
  origin.
- **Replays.** Hang confirmation, `verify-fix` and `regression capture` re-mint as the same
  identities on every replay, using the paths the result recorded. Pass `--fixture-identity` to
  re-bind one, for example after the owner's session rotates.
- An identity applies to `localStorage` and `cookies` auth. A `secretField` binding is already
  independent of the mission's session.

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
