# Authenticated and stateful apps

Starting a run logged in, driving login and MFA forms without exposing secrets, and running stateful journeys safely.

## Authenticated missions

`--secret <value>` **only redacts**: the value is kept out of every model call,
transcript, Recording and issue draft, but it is never typed into a field.

- **Start logged in (preferred).** Save a Playwright storageState once, for example
  with `npx playwright codegen --save-storage=auth.json https://app.example.test/login`,
  and pass `--storage-state auth.json`. The file holds live session cookies and
  localStorage. It goes only to the browser, and artifacts record its path, never
  its contents. `jevitate record` does not write a storageState.
- **Rotating refresh tokens.** When the app rotates its refresh token on every use,
  a saved state goes stale after the first run that refreshes it. Pass
  `--save-storage-state <file>` (it may be the `--storage-state` file itself) to write the
  rotated session back when the mission ends. The write survives a crash or a
  SIGTERM/SIGINT: it falls back to the last state captured while the session still looked
  logged in, never overwrites a good file with a logged-out one, and uses mode 0600. Do not
  share one file between parallel runs.
- **Driving a login or signup form.** Bind a field to an environment variable, and
  code types the value itself. The model only ever sees `«secret:VAR»`, and the
  Recording records the fill as `{ redacted: true }`:

  ```bash
  APP_PASSWORD=… jevitate explore --url https://app.example.test/login \
    --goal "log in as ada@example.com with the bound password" \
    --secret-field 'label=Password=env:APP_PASSWORD' --success 'visible:testId=dashboard'
  ```

  A descriptor is `label=<text>`, `testId=<id>`, `type=<input type>` (for example
  `type=password`), `id=<element id>` or `name=<name attribute>`.
- **MFA (TOTP).** `--totp '<descriptor>=env:VAR'` takes a base32 TOTP seed (what
  the app shows at enrolment). The 6-digit code is computed locally (RFC 6238,
  SHA-1, 30 s) when the field is typed. The seed never reaches a model or disk.
  For an app that forces enrolment on signup, a storageState saved after
  enrolment avoids the flow entirely.

The bound value and the seed are registered as run secrets, so the existing
redaction seams scrub them everywhere.

**Replaying an authenticated Journey.** A Journey `explore-author-journey` authors
with `--storage-state` needs the SAME authenticated pre-step to replay: pass
`--storage-state <file>` to `jevitate journey run`, `jevitate load run` and
`jevitate source run`. Over MCP, `run_journey`'s optional `storageState` argument is
the same thing — a file PATH on the machine running the MCP server; its contents are
read only by that server's own browser session, never returned or logged. A Journey
can also declare `metadata.requiresAuth: true` so a run given no `storageState` fails
fast, before any browser opens, with a clear message — instead of a confusing
`replay-target-not-found` partway into the steps.

## Persistent browser profiles (`jevitate profile`)

`jevitate profile create <name>` / `jevitate profile status <name>` provision and
check a directory under `~/.jevitate/profiles/<name>` — an on-disk Chromium
user-data directory (Playwright's `persistentProfile`, distinct from a
`--storage-state` JSON snapshot: a real profile directory instead of a serialized
cookie/localStorage file). **No `jevitate` command consumes one yet** — there is no
`--profile` flag on `explore`, `journey run`, `record` or `load run` today. Treat
`jevitate profile` as reserved surface: it prepares the directory a future
`--profile` flag would point a browser session at, not a currently wired
authentication path. Use `--storage-state` (above) for authenticated runs today.

## Stateful and conversational runs: sequential only, one tenant at a time

A conversational or otherwise stateful journey (the goal loop, or any run that
reads back its own writes — an inbox, a sidebar list, an inquiry thread) mutates
real state in the target app under the identity your `--storage-state` carries.
**Run these sequentially, never concurrently, against the same `--storage-state`
or the same tenant/session.** Two runs sharing one storage-state race on the
same underlying account, and the app's own UI (a sidebar, a list, a feed) is not
scoped per jevitate run — it shows whatever the tenant currently has. A second
run can walk straight into state the first run just created:

- **Cross-run contamination.** In a real-mode dogfood, two concurrent goal runs
  against one `--storage-state` both wrote into a single shared inquiry: the
  second run's UI listed the first run's freshly-created item, its title looked
  plausible for the second run's own goal, and the second run acted on it as if
  it were its own.
- **Fixture-vs-real carry-over.** Because the underlying tenant persists between
  invocations, a later fixture-backed run reused an item a prior real-mode run
  had created against that same tenant — the state was never reset in between.

To avoid this:

- Run conversational/stateful journeys **one at a time**, in sequence, whenever
  they share a `--storage-state` file or point at the same tenant/session. Do
  not fan them out in parallel.
- Treat one `--storage-state` as scoped to one run at a time, not as a pool to
  share across concurrent invocations.
- If you must run several stateful journeys back to back, expect state from
  each prior run to still be visible to the next one — plan goals accordingly
  or reset the tenant's data between runs.

**Not yet supported:** a `--storage-state`-per-run pattern that provisions a
fresh tenant/session from a caller-supplied seed hook, so that genuinely
parallel runs against a multi-tenant app would not cross-contaminate. Until
that lands, sequential execution against a shared identity is the only safe
pattern.

To reset the tenant's data between sequential runs (and before every replay), declare
[mission fixtures](./fixtures.md): HTTP setup/restore steps, or your own `--before`/`--after`
hooks.
