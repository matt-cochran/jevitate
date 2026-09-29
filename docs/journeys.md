# Journeys: record, author, replay and load-test

A **Journey** is Jevitate's deterministic, replayable browser flow: a Recording of typed steps
(Screenplay-style actions over Playwright) plus parameters and metadata. Discovery can be
nondeterministic, but a Journey replays the same way every time, and a replay never clicks a
guess ([how replay finds elements](./verification.md#replay-finds-the-recorded-element-exactly)).

## Author a Journey from a goal (needs model keys)

```bash
jevitate explore-author-journey --url http://localhost:3000 \
  --goal "add a product to the cart and reach checkout" --success urlIncludes:/checkout \
  --id checkout --name "Checkout" --real
jevitate journey promote checkout        # a human approval gate: unpromoted Journeys never run
jevitate journey run checkout
```

The authored Journey carries its `--success` check as its final assertion, so a replay fails when
the flow stops reaching its goal. It is written unpromoted: promotion is always a deliberate human
act. `--takes <n>` corroborates the flow over several takes.

## Record a flow by demonstration

```bash
jevitate record --url http://localhost:3000 --intent "check out with a saved card"
```

`record` opens a headed browser and records what you do; Enter or Ctrl+C ends the take and saves
it. The take can then be post-processed:

- `jevitate recording diff takeA.json takeB.json` classifies which values vary between takes.
- `jevitate recording postdoc take.json --decisions decisions.json --out recording.json` marks
  values as constants, variables or human hand-backs.
- `jevitate recording promote take.json --page 0 --step 2 --var email` turns one value into a
  variable.
- `jevitate recording fit take.json` derives a timing policy from your pacing.

A recorded take is a Recording, one step short of a Journey: there is no single command yet that
turns a post-processed take into a promoted Journey (see the `jevitate-record` skill's "Known
gaps"). `explore-author-journey` is the direct path today.

## Run, heal, share and load-test

```bash
jevitate journey list
jevitate journey run checkout --param sku=A1 --storage-state auth.json
jevitate journey run checkout --self-heal hybrid --real     # repair a broken step under policy
jevitate journey annotate checkout --real                   # draft each step's objective (see below)
jevitate load run checkout --authorized-origin http://localhost:3000 --concurrency 5 --iterations 10 --seed 1
```

- `--self-heal fail-closed` (the default) stops and quarantines on a broken step. `hybrid` and
  `full` re-learn only the broken step and need `--real` (or `--fake-ai`). Write and irreversible
  steps are never auto-healed in any mode.
- A Journey that declares `metadata.requiresAuth: true` refuses to start without
  `--storage-state`, before any browser opens.
- `load run` replays a promoted Journey with a seeded pool of actors, human-paced when the site has
  a [site policy](#site-policies) with pacing, and refuses to start without `--authorized-origin`.
- Shared Journeys live in a git repository mounted under the app repo's `.jevitate/journeys/`,
  usually as a submodule: `git submodule add <gitUrl> .jevitate/journeys/commerce`. Its Journeys
  appear as `commerce/<id>` everywhere a local one does (`journey list`, `find`, `run`, `check`,
  MCP `find_capabilities` and `run_journey`), and are promoted the same way. The submodule pin is
  reviewed like any other code change, and each file keeps its own plain id, so the same Journeys
  work in every repo that mounts them.
- Distributed sources share Journeys from third parties through git: `jevitate source add <name> <gitUrl>`,
  `source trust <name> <journeyId>` (bound to the Journey's content hash), `source run`, and
  `jevitate journey publish <id> --to <source>`.

Over MCP, agents find and run promoted Journeys with `find_capabilities` and `run_journey`
([agents.md](./agents.md)).

## Journey format reference

A Journey is one JSON file, `.jevitate/journeys/<id>.json` (`<namespace>/<id>.json` for a shared
Journey): `{ "metadata": {…}, "recording": {…} }`. Both objects are closed: an unknown or misspelt
key is refused when the file is read.

| `metadata` field | Required | Meaning |
|---|---|---|
| `id` | yes | The Journey's id (letters, digits, `.`, `_`, `-`); also its file name |
| `name` | yes | A short human name |
| `description` | no | One line, shown by `journey find` |
| `promoted` | yes | `true` only after `journey promote` (the human approval gate) |
| `params` | yes | Names of the `--param` values it takes |
| `secretRefs` | no | Password-manager references for `vault-autofill` runs |
| `authoredBy` | no | `human-demonstration` or `jev-driven` |
| `createdAtIso` | yes | When it was written |
| `requiresAuth` | no | `true`: refuses to start without `--storage-state` |
| `goal` | no | What the Journey achieves, in one sentence |
| `persona` | no | Who does it |
| `role` | no | The account role it runs as (which environment session it needs) |
| `preconditions` | no | `[{ "description", "fixture"?, "hook"?, "login"? }]`: the seed data and login it needs, linked to the `--fixtures` file and `--before` hook that set it up |
| `successCriteria` | no | `[{ "description", "check"? }]`: the end state that shows it worked; `check` is any [assertion](./success-checks.md) that checks it in code |
| `parameters` | no | `[{ "name", "description"?, "secret"? }]`: its inputs. `secret: true` marks a value (a password, a token) that is redacted wherever it is shown. A declared parameter never carries a value |

`recording` holds `version`, `site` (the origin it runs on), optional `intent`, and `pages[]`, each
with `url` and `steps[]`. Every step is `{ "step": {…}, … }`: the action (`navigate`, `click`,
`fill`, `select`, `press`, `upload`, `editText`, `waitFor`, `extract`, `forEach`, `assert`,
`handback`) with its `expect` assertion, plus optional metadata:

| Step field | Meaning |
|---|---|
| `objective` | What the user is trying to do at this step, and how it serves the `goal` |
| `expectedResult` | What should change after the step, in words: a demo caption. The code check stays the step's own `expect` |
| `timing`, `marker`, `variableName`, `enumerationId`, `chunk` | Recording metadata (pacing, checkpoints, parameter binding, postdoc grouping) |

The intent fields (`goal`, `persona`, `role`, `preconditions`, `successCriteria`, `parameters`,
`objective`, `expectedResult`) are optional and additive. A Journey without them validates and runs
exactly as before, and none of them changes what a replay does. They can be written by hand, or
drafted with `journey annotate`.

A secret parameter's value is redacted in the `journey run` output, in `journey annotate`'s
evidence, drafts and output, and in anything sent to a model. A parameter whose name looks like a
credential (`password`, `token`, `apiKey`, `otp`, …) is treated as secret even when the Journey
does not declare it.

## Annotate a Journey: draft its intent, then approve it

`journey annotate` drafts a Journey's intent by replaying it:

```bash
jevitate journey annotate checkout --param sku=A1 --real      # or --fake-ai for a deterministic smoke
# review or edit .jevitate/journeys/.drafts/checkout.annotations.json
jevitate journey annotate checkout --approve                    # the human gate: shows the diff, then writes
```

1. It replays the Journey the way `journey run` does: the same `--param`, `--storage-state`,
   fixture, browser and emulation flags, the same site policy, and a fail-closed run policy. It
   never self-heals.
2. Before and after each step it reads the page: the URL, the main heading and the visible text,
   redacted of secret parameter values before anything else sees them.
3. The model sees each step's value-free description, the page before and after it, and the
   Journey's goal (or its name and intent when there is no goal yet). It drafts the step's
   `objective` and `expectedResult` where they are missing. It then drafts `goal` and
   `successCriteria` when those are missing. These are the versioned `journey.step` and
   `journey.goal` generation tasks.
4. The drafts go to a sidecar, `.jevitate/journeys/.drafts/<id>.annotations.json`, and never into
   the Journey. The command prints the diff that approving would apply.

The draft is plain JSON: edit any text, or delete an entry, before approving. `--approve` validates
the draft and shows the diff. It then writes only the four intent fields (`goal`,
`successCriteria`, and each step's `objective` and `expectedResult`) and removes the draft. It
never promotes the Journey or changes an action or an assertion. The draft is bound to the
Journey's content hash, so if the Journey changed after the draft was made, approval is refused
(`E_JOURNEY_ANNOTATIONS_STALE`) and nothing is written: draft it again.

| Exit | When |
|---|---|
| `0` | The draft was written after a full replay, or the approval was applied |
| `2` | The replay stopped early (a broken step, or a handback): the draft covers only the steps it reached |
| `64` | Bad arguments, an unknown Journey, a bad `--param`, no gateway (`E_AI_SETUP_REQUIRED`), no draft (`E_JOURNEY_ANNOTATIONS_NOT_FOUND`), an invalid draft (`E_INVALID_ANNOTATIONS_DRAFT`), or a stale draft (`E_JOURNEY_ANNOTATIONS_STALE`) |

`journey run` reports how many steps have no `objective`: a `note:` line on stderr, and `intent`
(`steps`, `withObjective`, `withoutObjective`, …) in the result. This is informational and never
fails a run.

## Site policies

A site policy keeps Journey runs on a site polite and bounded, whoever starts them (you, CI, or an
agent over MCP). Set one per site (the Journey's origin) and account (default `primary`):

```bash
jevitate site policy set https://app.example.com --file policy.json
jevitate site policy get https://app.example.com
```

```json
{
  "version": "2026-09-25",
  "interaction": { "thinkBeforeActionMs": { "mean": 600, "sd": 150 }, "typing": { "charsPerSecond": 7, "perKeyJitter": 0.3 } },
  "throttles": {
    "read":  { "minIntervalSeconds": 5, "hourlyLimit": 120 },
    "write": { "minIntervalSeconds": 60, "hourlyLimit": 10, "dailyLimit": 50 }
  },
  "quietHours": { "timezone": "America/Chicago", "windows": [{ "start": "22:00", "end": "07:00" }] }
}
```

- `interaction` paces every click and keystroke like a person: think time, typing speed, reading
  time.
- `throttles` apply per class. A Journey with any write step (a click, a fill) is `write`; a Journey
  that only reads is `read`. `minIntervalSeconds` spaces runs out (a shortfall of up to 5 seconds is
  waited out); `hourlyLimit` and `dailyLimit` cap how many runs start.
- `quietHours` are windows, in a timezone, when no run may start. Windows may wrap past midnight.

`journey run`, `source run`, `check` Journey items and MCP `run_journey` apply the whole policy. A
run that is inside quiet hours, too soon after the last one, or over its budget is refused before
any browser opens: the CLI fails with `E_SITE_THROTTLED`, and `run_journey` answers
`{ "error": "throttled", "reason": "quiet_hours" | "min_interval" | "budget", "retryAfter": "<ISO time>" }`.
`load run` applies only the pacing: a load test is a deliberate burst. `site simulate` estimates,
offline, how long a planned script takes under the pacing.
