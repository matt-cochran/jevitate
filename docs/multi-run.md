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
not counted. The overall verdict (`missionOutcome`) is the canonical outcome at least that many
runs agreed on (a goal run's own ending is folded first: `succeeded` → `clean`,
`failed`/`exhausted`/`blocked` → `defects-found`); it is `intermittent` when no single outcome
reached `--min-agreement` runs, or when the top two are tied, and `inconclusive` when that is
because a run broke. The human summary leads with that verdict, then each run's own verdict and
reason, the persona status differences (e.g. `GET /api/invoices: 200 for admin; 404 for viewer`),
and a find-out's `ANSWER`. See [results](./results.md#multi-run-results---repeat---persona) for the fields.

**A write goal needs its state reset every run.** The runs share the app: what run 1 wrote is
still there for run 2. On a write goal ("change the display name to Ada", "create a project named
Demo"), every run after the first starts with the goal already done, so its success check passes
without proving anything, and the vote counts those vacuous passes. Give it `--fixtures` (HTTP
`setup`/`restore` steps) or `--before`/`--after` shell hooks — they run before and after **every**
repeat — so each run starts from the same state; see [fixtures](./fixtures.md). Adversarial runs
leave junk values behind the same way (see [safety](./safety.md)).

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
- `sessionLost` (`{persona: why}`, only when it happened): a persona whose session was not honoured —
  its run's first page was a sign-in page (a login-like URL, or a password field). The run did not
  start as that persona (a goal run's model may even sign in by itself), so its other differences are
  not that persona's. The persona's cell carries the same `sessionLost`, and the human summary prints a
  `WARNING <persona>: session lost` line. Re-save the persona's storage state and run it again.

The top-level `outcome` is that shared outcome when every persona agreed, else `"mixed"`; the
canonical `missionOutcome` is then the most severe persona's.

## Persona sessions: `jevitate login`, the pre-flight auth check and refresh

Each persona needs a Playwright storage state. `jevitate login` makes one from credentials held in
environment variables:

```bash
export ADMIN_USER=admin@example.com ADMIN_PASSWORD=...   # never on the command line
jevitate login --persona admin --url http://localhost:3000/login \
  --user-env ADMIN_USER --password-env ADMIN_PASSWORD \
  --success urlIncludes:/dashboard --save ~/.jevitate/states/admin.json
```

- Only the variable **names** are given; a value pasted in their place is refused. jevitate's own keys
  (`OPENROUTER_API_KEY`, `TYPESAFE_API_KEY`, `GITHUB_TOKEN`, `JEVITATE_*`) are never typed into a page.
- The fields are found by label, `autocomplete`, `type` and `name` (`--user-field`/`--password-field`
  take a label or a CSS selector; `--submit` a button name). A two-step form (username first, then a
  password page) works too. Success is `urlIncludes:<text>`, `selector:<css>` or `text:<text>`; by
  default, the page must leave the sign-in form (no login-like URL, no visible password field). A form
  that shows an error (`role="alert"`, `aria-invalid`) after submitting fails at once (`E_LOGIN_FAILED`,
  exit 2).
- Credentials are typed only into a page on an authorized origin: the sign-in page's own, or `--allow`
  (for example an SSO provider).
- The login session records nothing: no trace, video, HAR or screenshot, whatever else is configured.
  No result, error or log line carries a credential.
- The state is written atomically with mode `0600` (parent directory created). A path inside a repo's
  `.jevitate/` is refused. A path inside a git repository that git does not ignore gets a warning.

**Through an HTTP endpoint (`--api`, #449).** Many apps have a programmatic sign-in, such as a token
endpoint or a development-only sign-in route. `--api <url>` POSTs the credentials there as JSON
instead of driving a form, which is faster and does not wait for a client-rendered page:

```bash
jevitate login --persona admin --api http://localhost:3000/api/login \
  --user-env ADMIN_USER --password-env ADMIN_PASSWORD \
  --token-path token --verify-url http://localhost:3000/app --save ~/.jevitate/states/admin.json
```

| flag | meaning | default |
| --- | --- | --- |
| `--api <url>` | the endpoint the credentials are POSTed to, as `{"<user key>": …, "<password key>": …}` | |
| `--api-user-key <key>` / `--api-password-key <key>` | the JSON body keys (letters, digits, `_`, `-`) | `username` / `password` |
| `--token-path <path>` | a dotted path into the JSON response (`token`, `data.accessToken`, `items.0.jwt`) whose string or number value is the session token. Without it, the cookies the response set are the session | |
| `--storage-key <key>` | the localStorage key the token is written under, on the `--verify-url` origin | the path's last segment |
| `--storage local` | where the token goes. `local` is the only choice (see below) | `local` |
| `--verify-url <url>` | the app page the new session is proven on | the endpoint's origin root |
| `--auth-check <check>` | how that page proves it: `auto`, `urlExcludes:<text>`, `selector:<css>` or `off` (the table below) | `auto` |

- The endpoint and the verify URL must be on authorized origins: the endpoint's own, or `--allow`.
  Anything else is refused before any request. Redirects are never followed. A redirect to another
  origin fails, and a same-origin redirect counts only for its cookies.
- The response's `Set-Cookie` cookies are always kept. The token, when `--token-path` names one, is
  added to the verify URL origin's localStorage. A response with neither fails.
- A non-2xx status, a body that is not JSON, or a missing token path fails with `E_LOGIN_FAILED`
  (exit 2), naming the status or the path, never the body. A session that does not pass
  `--auth-check` on `--verify-url` fails the same way. In either case, nothing is saved.
- The token is redacted from every result, error and log line, like both credentials. It is written
  only into the storage state.
- **No sessionStorage.** A Playwright storage state holds cookies and localStorage only, so a
  sessionStorage token could not be saved, nor restored when a run starts from the state.
  `--storage session` is refused with that reason. For an app that keeps its token only in
  sessionStorage, use its cookie session, or drive its form (`--url`).
- The form-only flags (`--url`, `--user-field`, `--password-field`, `--submit`, `--success`) are
  refused beside `--api`, and the API flags are refused without it.

Before a run that starts from a session (`--storage-state`, `--persona`/`--personas`, the primary
`--actor`), `explore` checks that the session is still alive. It loads the state, opens `--url`, and
ends the run at once if it landed on a sign-in page. The run is `inconclusive` (exit 2) with
`failure: {kind: "auth-expired", message, persona}`, plus `persona`, `startUrl` and `landedUrl` on the
result. The login page is never explored. `--auth-check` sets the rule:

| `--auth-check` | the session counts as expired when |
| --- | --- |
| `auto` (default) | the start URL lands on a login-like path (`/login`, `/signin`, `/sign-in`, `/auth`, `/sso`, …) or shows a visible password field. Not checked when `--url` is itself such a route |
| `urlExcludes:<text>` | the landed URL contains `<text>` |
| `selector:<css>` | the signed-in marker `<css>` is not visible |
| `off` | never checked |

The check is one extra page load of the start URL, made in its own unrecorded context. When the
start URL is bound from `--fixtures` (`<origin>${setup.x}`), the check opens the app's root instead,
because that URL does not exist until the setup runs.

If the check finds the session alive but a value in the state changed while the page loaded (for
example a refresh cookie that rotates on every use), the live session is written back to the state
file (atomically, mode `0600`). The mission then starts from that session, not from the token the
check used up.

In a persona matrix, every run is checked before it starts. A persona whose session expired gets an
`auth-expired` run in its cell, and the other personas still run.

**Refresh.** A persona can carry its login parameters, using environment variable names only. When the
check finds the persona's session expired, or its state file does not exist yet, jevitate signs in
once, saves the state over the old one, and checks again. If either step fails, the run ends
`auth-expired` and the reason includes the sign-in failure.

```json
{
  "personas": [
    {
      "name": "admin",
      "storageState": "../.auth/admin.json",
      "login": {
        "url": "http://localhost:3000/login",
        "userEnv": "ADMIN_USER",
        "passwordEnv": "ADMIN_PASSWORD",
        "success": "urlIncludes:/dashboard"
      }
    }
  ]
}
```

The map form takes `{"admin": {"storageState": "…", "login": {…}}}`, and a plain path still works.
The `login` keys are `url`, `userEnv`, `passwordEnv`, `userField`, `passwordField`, `submit` and
`success`, or, for a sign-in through an HTTP endpoint (#449), `api` with `userEnv` and
`passwordEnv`. `api` is the endpoint URL, or an object `{url, userKey?, passwordKey?, tokenPath?,
storageKey?, storage?, verifyUrl?}` with the meanings of the `--api` flags above. A refresh then
POSTs to the endpoint instead of driving a form:

```json
{ "name": "admin", "storageState": "../.auth/admin.json",
  "login": { "api": { "url": "http://localhost:3000/api/login", "tokenPath": "token" }, "userEnv": "ADMIN_USER", "passwordEnv": "ADMIN_PASSWORD" } }
```

The form keys are refused beside `api`. Any other key is refused, including a literal password. Pass the file as `--personas`, or
commit it as the project's `.jevitate/personas.json`. With that file:

- `--persona admin` (a bare name) runs that persona.
- A single run's `--storage-state` that is a declared persona's state is checked and refreshed as
  that persona.
- `jevitate login --persona admin` re-mints it from the declared parameters.

The storage states themselves must live outside `.jevitate/`.

The same file is the [catalog](./catalog.md)'s persona list: an entry may also carry a
`description`, a `role` and its `approval` (`jevitate persona approve`). An entry with no session
yet (no `storageState`, no `login`) is a catalog-only persona, which runs skip.

**Where the check runs.** `explore` (single runs, `--repeat`, the persona matrix, `--actor`) and queued
missions (`mission run`, MCP `queue_exploration`) run it. A queued mission whose session expired gets
an `auth-expired` result from `get_mission_result`. `targets.json` personas have no login parameters,
so a queued mission is never refreshed. These do not run the check:

- `explore --from-journey`: the Journey prefix replay fails closed on its own (`journey-stale`).
- `journey run`: a deterministic replay. It does not add a page load. An expired session fails the
  replay's own steps and assertions.
- `jevitate check` suite items: a check runs its items' missions directly. Mint the suite's
  sessions with `jevitate login` before the check.
- `explore-author-journey`: an authoring run. A lost session still shows as `sessionLost`, as before.

**Over MCP**, `run_exploration` takes `authCheck`. A persona's refresh uses only the login
parameters an operator's personas file declares. `jevitate login` is CLI-only: it reads the operator
environment variables that its own flags name, and an MCP request never chooses which of those
variables is read.

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
