# Authenticated and stateful apps

Starting a run logged in, driving login and MFA forms without exposing secrets, and running stateful journeys safely.

## Authenticated missions

`--secret <value>` **only redacts**: the value is kept out of every model call,
transcript, Recording and issue draft, but it is never typed into a field.

A page that shows the value (a profile page showing your email, in its text or in a field) is
fine: page text and field values are redacted to `«redacted»` as the page is read, before any
model sees them, and the run carries on. A typed value that happens to equal it is recorded
`{ redacted: true }`. A find-out whose answer is the secret says it cannot disclose it.

Prefer `--secret env:VAR`: the value is read from the environment variable `VAR`, so it
never appears in the process list or your shell history (the same `env:` binding
`--secret-field` uses), and it is redacted exactly like a literal. An unset or empty
variable, or a malformed `env:` ref, refuses the run before any browser opens — it is never
treated as an empty secret or as the text `env:VAR`. A literal `--secret` still works but
prints a warning on stderr. `verify-fix --secret` takes the same two forms.

```bash
APP_API_TOKEN=… jevitate explore --url https://app.example.test/ --goal "…" --secret env:APP_API_TOKEN
```

- **Start logged in (preferred).** Save a Playwright storageState once, for example
  with `npx playwright codegen --save-storage=~/.jevitate/auth.json https://app.example.test/login`,
  and pass `--storage-state ~/.jevitate/auth.json`. The file holds live session cookies and
  localStorage. It goes only to the browser, and artifacts record its path, never
  its contents. `jevitate record` does not write a storageState. Save it under
  `~/.jevitate/` (or anywhere outside the repo), never at a repo-relative path: `jevitate init`
  only writes a `.gitignore` inside the repo's `.jevitate/` (protecting what jevitate itself
  writes there), and a bare `auth.json` (or `auth/*.json`) at the repo root is not covered by
  it or by anything else — nothing stops it from being committed. This is the same reasoning
  `--save-storage-state` enforces in code (#195): it refuses a path that resolves inside a
  repo's `.jevitate/`, since that directory is partly committed (Journeys, regressions,
  baselines) and never the right place for live cookies.
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
- **Sign-up identities are unique per run.** When the goal does not state an email or a
  username, the value the model invents for an email / username field gains the run's token
  (`jane.doe@example.com` → `jane.doe.jev3k9x2a@example.com`, `janedoe` → `janedoe_jev3k9x2a`).
  A sign-up goal can be repeated against the same stack without an "account already exists"
  collision, and a sign-up followed by a sign-in in the same run types the same identity. A value
  the goal states (`email: ada@example.com`) or a `--secret-field` binding is typed exactly as
  given. A Journey authored from such a run records the unique value: replaying a sign-up Journey
  against the same stack needs a fixture that resets that account.
- **MFA (TOTP).** `--totp '<descriptor>=env:VAR'` takes a base32 TOTP seed (what
  the app shows at enrolment). The 6-digit code is computed locally (RFC 6238,
  SHA-1, 30 s) when the field is typed. The seed never reaches a model or disk.
  For an app that forces enrolment on signup, a storageState saved after
  enrolment avoids the flow entirely.

The bound value and the seed are registered as run secrets, so the existing
redaction seams scrub them everywhere.

**Per-origin sessions.** `~/.jevitate/targets.json`, keyed by origin, can hold a target's
`storageState` and `secretFields` (paths relative to that file). Queued missions (`mission run`)
and `verify_fix` over MCP start from it, and so do Journey commands run with `--env`/`--base-url`
(`journey run`, `journey annotate`, `regression run`, `load run`) when `--storage-state` is not given
([environments](./journeys.md#environments---env)). It is operator-only and never committed; the
repo's `.jevitate/environments.json` refuses any session or secret key.

**Replaying an authenticated Journey.** A Journey `explore-author-journey` authors
with `--storage-state` needs the SAME authenticated pre-step to replay: pass
`--storage-state <file>` to `jevitate journey run`, `jevitate load run` and
`jevitate source run`. Over MCP, `run_journey`'s optional `storageState` argument is
the same thing — a file PATH on the machine running the MCP server; its contents are
read only by that server's own browser session, never returned or logged. A Journey
can also declare `metadata.requiresAuth: true` so a run given no `storageState` fails
fast, before any browser opens, with a clear message — instead of a confusing
`replay-target-not-found` partway into the steps.

## API keys for jevitate's own AI

Jevitate's AI features each need one key: **generation** uses `OPENROUTER_API_KEY` (OpenRouter),
**judgment** uses `TYPESAFE_API_KEY` (TypeSafe/Jev; `TYPESAFE_JEV_API_KEY` is accepted too). A key
comes from the environment or from `~/.jevitate/credentials.json` (mode 0600). The environment
wins when both are set.

- **Enter a key:** `jevitate init` or `jevitate ai setup <generation|judgment>`. Entry needs a
  terminal and is masked: each character shows as `•`, and the instructions stay on screen.
  Backspace erases, Ctrl-C cancels. A key is never echoed, logged or sent to a model, and key
  entry is never offered over MCP.
- **See what is configured:** `jevitate ai status` (and `init`) prints, per feature, the key's
  name, its provider and its source, for example
  `generation: ready — OPENROUTER_API_KEY (OpenRouter), from ~/.jevitate/credentials.json: valid`.
  With `--json`, `sources` and `verification` are added per feature (names, sources and
  verdicts only, never a value). An env var that overrides a stored key is reported.
- **Verification:** each key is checked with its provider by one authenticated, non-billable
  request (OpenRouter `GET /api/v1/key`, TypeSafe `GET /v1/models`). The verdict is `valid`,
  `invalid` (HTTP 401/403), `unreachable` (network error, timeout, 429, 5xx), `missing` or, with
  `--no-verify`, not checked. A key that looks like another provider's (an OpenRouter `sk-or-…`
  key in the TypeSafe slot) is flagged. `ai status` exits 2 when a key is invalid or could not
  be checked. `ai setup` checks a key **before** storing it: a rejected key, or one that could not
  be checked, is not stored. `ai setup` also fails when a key already present is invalid.
- **Replace or rotate a key:** `jevitate ai setup <feature> --replace` prompts for a new value
  even when one is stored and stores it the same way; `jevitate init --replace-keys` does it for
  every feature. If an env var is set for that key, you get a warning that the env value still wins.
- **Offline / CI:** pass `--no-verify` to `ai status`, `ai setup` or `init` to skip the live check
  (presence and source only). Set keys in CI through the environment; nothing prompts without a
  terminal.

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
