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

The authored Journey carries its `--success` checks as its end state, so a replay fails when the
flow stops reaching its goal. It is written unpromoted: promotion is always a deliberate human
act. `--takes <n>` corroborates the flow over several takes.

`--success` is repeatable (every check must hold) and takes every kind `explore --success` takes:
page checks (`textIncludes`, `valueEquals`, `count`, `attr`, `flashed`, …), `reloadThen:<check>`
(persistence), `requestMade` and `responseStatus`. Pass the job's outcome, not just the page it
ends on: a state-changing job checks its write and what persisted, for example
`--success 'responseStatus:POST /portal.v1.Sites/PublishSiteEdits=2xx'
--success 'reloadThen:textIncludes:testId=live|published'`.

### Outcome assertions in a Journey

- **End state** (`metadata.endState`): every `--success` check, in the order given, kept in the
  same shape the goal run judged it. `journey run` and `source run` judge them after the last step
  with the goal run's own evaluator: page checks on the final page, then one reload for the
  `reloadThen` checks, then network checks over the requests the replay itself sent. A replay
  whose steps all pass but whose outcome is absent fails, naming each check that did not hold
  (`success check not met after the last step: …`).
- **A step's request expectation** (`expectRequests` on the recorded step): a write the step sent
  during discovery (a non-read request answered 2xx/3xx) becomes
  `responseStatus:<METHOD> <path>=2xx`, with id segments as `*`. It is judged over the requests
  the replay sent from the moment that step began, so it pairs the check with the step that
  causes it (`step request check not met: step 3 (click …): …`).
- **A step's `expect`** comes from what the step changed: the navigation it caused
  (`urlIncludes`), the value a fill typed (`valueEquals`, for a constant value), or, with
  `--action-deltas`, the element or text a `relevant-change` step added. A step with nothing to
  claim gets the explicit "no claim" `count … min 0`. Authoring never writes `visible` of the
  step's own target: it holds before and after the click, so it proves nothing.

```json
{
  "metadata": {
    "id": "publish",
    "endState": [
      { "kind": "responseStatus", "method": "POST", "pathGlob": "/portal.v1.Sites/PublishSiteEdits", "status": { "class": 2 } },
      { "kind": "reloadThen", "assertion": { "kind": "textIncludes", "target": { "testId": "live" }, "text": "published" } }
    ]
  },
  "recording": { "pages": [{ "url": "/editor", "steps": [
    { "step": { "kind": "click", "target": { "testId": "publish" },
                "expect": { "kind": "visible", "target": { "text": "Your site is live", "textMatch": "contains" } } },
      "expectRequests": [
        { "kind": "responseStatus", "method": "POST", "pathGlob": "/portal.v1.Sites/PublishSiteEdits", "status": { "class": 2 } }
      ] }
  ] }] }
}
```

Both fields are optional. A Journey authored before them (a trailing `assert` step, and network
checks in `metadata.networkChecks`) loads and runs exactly as before: its `networkChecks` are
judged with the end state.

### Waiting for a long-running job (`waitFor`)

A step's `expect` is checked with a short bounded retry (about 5 s), which is too short for a job
that takes minutes (generating previews, preparing exports). Declare an outcome wait next to the
`expect` (or an `assert` step's `check`) instead of raising a global timeout:

```json
{ "step": { "kind": "click", "target": { "role": "button", "name": "Generate" },
            "expect": { "kind": "count", "target": { "testId": "variation-preview" }, "min": 3 },
            "waitFor": { "maxMs": 240000, "until": "held",
                         "progress": { "kind": "visible", "target": { "css": "[role=status]" } } } } }
```

| Field | Meaning |
|---|---|
| `maxMs` | required: the longest the expectation may take to hold (integer, at most 1 800 000 = 30 min) |
| `until` | `"held"` (the only mode, and the default): poll until the expectation holds |
| `progress` | optional: an assertion that shows the job is still working (a status line, a progress bar) |
| `stallMs` | optional: the hang threshold for `progress` (default 30 000, at least 1 000) |
| `reload` | optional: reload the page between polls, for a job that finishes server-side on a page that does not live-update (each poll after a reload waits up to 5 s for the page to render) |
| `pollMs` | optional: time between polls (default 250 ms; 2 s with `reload`; 100–60 000) |

Replay polls the expectation until it holds or `maxMs` passes. With `progress`, the progress
signal must hold, or its target's text change ("Step 2 of 9" → "Step 3 of 9"), at least once per
`stallMs`; when it has not for that long, the step fails early as a hang that names the signal,
not after the whole budget (the same rule as the explore runs' stuck-status and job-wait checks).
A job that never shows its progress signal at all fails at the hang threshold too. A status that
stays on screen forever is still "working": the step fails at `maxMs`. A target needs a usable
selector (`testId`, `role` with `name`, `label`, `text` or `css`): use `{ "css": "[role=status]" }`
for a bare role.

The run result reports each waited step under `waits`: `step` (1-based), `waitedMs` (the actual
wait), `maxMs`, `ending` (`held`, `timeout` or `hang`), `polls` and, with `reload`, `reloads`. A
job that gets slower shows up as a number, not as a flaky pass or fail. A failed wait is a
postcondition failure: `step 2 failed: click: postcondition failed: kind=count … — waited 240.0s
(waitFor maxMs 240000); it never held`, or `… — hang: the progress signal (kind=visible …) was
absent and unchanged for 30.0s …`. Without `waitFor`, a step is checked exactly as before. A
`waitFor` belongs on a top-level step: a `forEach` child step with one is refused before the replay
starts. The lint (`journey lint`) judges the `expect` itself; a waited `expect` that claims nothing
is flagged like any other.

Under `journey verify --mutate`, a waited claim on the mutated step (`skip:<n>`, `block-write:<n>`)
waits at most its hang threshold plus 5 s (`stallMs`, default 30 s) instead of `maxMs`: the job was never
started (or its writes were aborted), so the claim must fail, and the proof does not wait out the
budget to show it. Waits on other steps, and under `stale-value`, keep their `maxMs`.

### Assertion strength

A green replay only proves something when its assertions can fail for the wrong reason. `journey
lint` reports the assertions that cannot, and `journey promote` runs the same lint first: a Journey
with any error-level finding is refused unless the reviewer accepts it with `--accept-weak
"<reason>"`. Gate CI on the lint (exit 1 when any error) with:

```bash
jevitate journey lint checkout                  # one line per finding, then a summary
jevitate journey lint checkout --json           # { id, findings, errors, warnings }
jevitate journey lint checkout --sarif lint.sarif
```

| Rule | Level | Flags |
|---|---|---|
| `own-target-visible` | error | A step's `expect` only restates that the step's own target is visible — true before and after the step, so it proves nothing |
| `write-without-effect` | error | A state-changing step (a write) has no assertion on its effect |
| `visibility-only` | error | Every assertion is a bare `visible` (or the step's own target), so the Journey cannot fail for the wrong reason |
| `nothing-after-last-write` | error | No effect assertion follows the last state-changing step |
| `no-persistence-check` | warning | A write has no `reloadThen` end-state check, so persistence is unverified |
| `intent-uncovered` | warning | A step's documented `expectedResult` maps to no effect assertion |

Warnings never block promotion. `--accept-weak "<reason>"` records the reason and the waived error
rules in the Journey's `metadata.acceptedWeak`.

Each take (the discovery and every corroborating one) is a full `explore --strategy goal` run, so
the author command takes the same run-shaping flags: `--secret`, `--secret-field` (including
`cmd:` sources with `--allow-secret-cmd` and `--secret-cmd-attempts`), `--totp`, `--type-fixture`,
`--fixture`, `--success-when`, `--allow-vacuous-checks`, `--action-deltas`, `--dialogs`, `--deny`,
`--paid`, `--allow-destructive`, `--read-rpc`, the `--reply-*`/`--job-wait-ms` waits, the settle and
hang flags, `--save-storage-state`, `--viewport`/`--device`/`--geolocation` and `--screenshots`.
Reproduce whatever setup the goal run needed. A field that code typed (a `--secret-field` or
`--totp` binding) is never kept in the Journey: it becomes a secret parameter (`secret1`, …,
declared `secret: true`) that `journey run --param secret1=…` supplies.

Every take writes its own result, transcript and Recording (under `--out`, default
`.jevitate/logs/<date>`). When the discovery take does not reach the goal, the `not-reached` result
says why and where to look: `reason` (`discovery mission <outcome>: <the goal run's own reason>`),
`discovery` (its `stop`, `runOutcome`, each check's verdict, `resultPath`, `transcriptPath`,
`recordingPaths`, `screenshotsDir`), and `takes` (requested / run / succeeded). The human summary
prints the same.

### Proving assertions can fail

The lint reads a Journey; `journey verify --mutate` runs it. An assertion is evidence only if it
**fails** when the outcome is absent, so the proof replays the Journey once as recorded (it must
pass), then once per mutation, and checks that each mutation breaks the assertion paired with it:

```bash
jevitate journey verify checkout --mutate                 # one line per assertion, then a summary
jevitate journey verify checkout --mutate --json          # the full report
jevitate journey verify checkout --mutate --env staging --param sku=A1 --fixtures reset.json
```

| Mutation | What the replay does | Derived for |
|---|---|---|
| `skip:<n>` | leaves step n's action out; its own `expect` is still checked where it stood (a `waitFor` on it waits at most its hang threshold plus 5 s) | each write step (the lint's rule) |
| `block-write:<n>` | aborts the write requests step n sends, from its start until the network settled after it | each write step |
| `stale-value:<n>` | types `""` into fill step n | each fill whose value a `valueEquals`/`textIncludes` checks |

A mutation of step n is paired with step n's own `expect`/`check` and its `expectRequests`; the
**last** write step's mutations are also paired with every end-state check; a `stale-value` is also
paired with every assertion that checks the typed value. An explicit no-claim `expect` (`count … min
0`) claims nothing and is never paired. Each assertion gets one verdict:

| Verdict | Meaning |
|---|---|
| `sensitive` | a paired mutation made the replay fail AT this assertion, with nothing failing before the mutated step (`provedBy` names it) |
| `insensitive` | the replay still passed under a paired mutation: the assertion is vacuous |
| `cascade` | the replay failed somewhere else first; never counted as proof |
| `not-applied` | `block-write` blocked nothing the step recorded (its own write was not aborted) |
| `error` | the mutated replay could not run (or the base replay failed) |
| `unpaired` | no mutation is paired with it |

Exit codes: `0` every paired assertion is sensitive · `1` any is insensitive · `2` inconclusive (the
unmutated replay failed, every mutation errored, nothing was paired, or only cascades and
not-applied are left) · `64` usage (`journey verify` without `--mutate`, an unknown id, bad params).
The JSON report carries `journeyId`, `journeyHash` (the Journey's content hash: the proof is bound
to exactly that content), `base.outcome`, each mutation's `outcome`, `failedSites` and
`blockedWrites`, each assertion's `site`, `check`, `verdict` and `provedBy`, and `summary` counts.

Pin a pairing the derivation would not make with `metadata.mutationPairs` — the assertion `check`
(`step:<n>`, `step-request:<n>:<i>`, `end-state:<i>`) must fail when `mustFailWhen`
(`skip:<n|anchor>`, `block-write:<n|anchor>`, `stale-value:<n|anchor>`; [anchors](#explore-from-a-journey-step-anchors-and-campaigns) by name)
is applied. A pair naming a site, step or anchor the Journey does not have is refused when the
Journey loads.

```json
"mutationPairs": [{ "check": "end-state:0", "mustFailWhen": "skip:publish" }]
```

Safe by construction: a mutation only leaves a step's action out, types an empty value, or
**aborts** the app's own write requests (the same first-party rule as a read-only find-out run;
a write navigation is aborted too, never answered). It never sends, fabricates or answers a
request. Every replay starts fresh, with the same fixtures and hooks as `journey run`; when the
app keeps state between sessions, reset it with `--fixtures`/`--before`, or the replay after a
blocked save can still find the base replay's saved data.

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

- `journey lint checkout` (or `promote`'s own gate) reports assertions that cannot prove the
  outcome before a Journey is promoted; `journey verify checkout --mutate` proves each one can fail
  by replaying the Journey with each write skipped or blocked ([details](#proving-assertions-can-fail)).
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
| `anchors` | no | `[{ "name", "step", "description"?, "probes"? }]`: named states worth exploring from — the state after `step` top-level steps (1-based). `name` is letters, digits, `.`, `_`, `-` and never all digits; `probes` are suggested adversarial attacks there. See [Explore from a Journey step](#explore-from-a-journey-step-anchors-and-campaigns) |
| `mutationPairs` | no | `[{ "check", "mustFailWhen" }]`: declared negative-proof pairs for `journey verify --mutate` — the assertion at `check` (`step:<n>`, `step-request:<n>:<i>`, `end-state:<i>`) must fail under `mustFailWhen` (`skip:`/`block-write:`/`stale-value:` + a step number or anchor). An unknown site, step or anchor is refused at load. See [Proving assertions can fail](#proving-assertions-can-fail) |

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

### Parameters in a `navigate` URL

A `navigate` step's `url` may hold `${name}` placeholders, for single-use links whose secret lives
in the URL (an invitation, a magic-link sign-in, a password reset, an email verification):

```json
"metadata": { "params": [], "parameters": [{ "name": "inviteToken", "secret": true }], … },
"recording": { …, "pages": [{ "url": "/accept", "steps": [
  { "step": { "kind": "navigate", "url": "/accept?token=${inviteToken}",
              "expect": { "kind": "visible", "target": { "role": "heading", "name": "Welcome" } } } }
] }] }
```

```bash
jevitate journey run accept-invite --param inviteToken="$TOKEN"
```

MCP `run_journey` takes it the same way (`"params": { "inviteToken": "…" }`). A value can also come
from a fixture output (`--param inviteToken='${setup.inviteToken}'`, see [fixtures](./fixtures.md)).

- Each placeholder must name a declared parameter (`params` or `parameters`). Otherwise the Journey
  is refused when it is read. A placeholder is a required run parameter, and `journey find`, MCP
  `find_capabilities` and the named Journey tools list it even when only `parameters` declares it.
- A placeholder comes after the origin: the scheme, host, port and the path's leading `/` are
  literal (`https://${host}/…`, `${base}/…` and `//${host}` are refused). The value is
  percent-encoded as one URL component (everything except `A-Z a-z 0-9 - . _ ~`), so `/`, `\`,
  `@`, `?`, `#` and `%` in a value are never URL syntax. The resolved URL must keep the template's
  origin, and the run's origin allowlist still applies.
- A secret parameter's value is redacted in every form it can take in a URL (raw,
  `encodeURIComponent` and strictly encoded). This covers the run's JSON output and errors,
  Playwright's own navigation error (which echoes the URL), screenshots and their index, action
  deltas, `journey annotate`/`journey demo` evidence, a self-heal's model prompts, and `source run`.
  `describeStep`, step captions and failure messages show the template as
  `navigate to /accept?token=<param inviteToken>`.

## Explore from a Journey step: anchors and campaigns

The real defects sit deep in a flow: a verification step mid-booking, the close step of a sale, a
half-filled form. A mission started from the landing page rarely gets that deep on its budget. A
journey-anchored mission (#293) gets there first: it replays a **promoted** Journey up to a step in
the mission's OWN browser context, then hands the live page to the mission.

```bash
jevitate journey anchors checkout                         # the named states, the step each follows, suggested probes
jevitate explore --from-journey checkout --at-step payment --param email=a@example.test --env staging \
  --strategy adversarial --storage-state ~/.jevitate/sessions/buyer.json --max-actions 60 --real --json
```

- `--at-step` is an anchor name or a 1-based top-level step number. Only the prefix's own params
  are required (a `--param` the Journey does not take is refused).
- The replay is `journey run`'s: fail-closed, never self-healed, the site policy and `--env` /
  `--base-url` applied, `--storage-state` (else the environment's session) seeding the session.
  Page, form contents and session carry over; there is no fresh navigation.
- Strategies: `goal`, `coverage`, `exploratory`, `adversarial`, `usability`. `--feature`, `--url`,
  `--repeat`, `--persona`, `--personas` and `--actor` are refused with it (exit 64).
- A prefix that stops before the anchor ends the run `inconclusive` with `failure.kind:
  "journey-stale"` and `failedStep` (exit 2). The run never restarts from a URL instead.
- Every result and finding records its branch point: `branch: { journeyId, step, anchor?,
  stepLabel? }` (additive, `schemaVersion` 1), and `jevitate report` lists each deduped defect's
  branch points.
- A reset inside the mission (after a hang or an identity change, a coverage / exploratory return
  to a queued state, a goal run's retry) **re-replays the prefix** into the mission's session, so
  in-page state comes back too. Cost: each reset spends the prefix's step count from
  `--max-actions` (and its time from the reset's own bound); a reset whose prefix no longer replays
  ends the run `scope-unreachable` instead of guessing. Hang *confirmation* replays (fresh
  contexts) still start from the anchor URL.
- `verify-fix`, `regression capture` and `regression run` replay a branch-point finding THROUGH its
  prefix: the result's `branch.replay` records the Journey store, its non-secret params and the
  environment; every replay session goes through the prefix first, and the finding's leading
  navigate becomes an assertion that the prefix landed on the anchor (same step indices). A secret
  param is never persisted: give it again with `--param <name>=<value>` (refused, exit 64, when
  missing). A prefix that no longer replays makes the check `inconclusive` with
  `failure.kind: "journey-stale"` (exit 2), never `fixed`.

One anchored step with a state restore (`--fixtures`, `--before`/`--after` with
`--allow-shell-hooks`) on a non-goal strategy (#312) runs the same way as a one-stop sweep: the
setup before the prefix replay, the restore after the mission, and the sweep's result shape
(`sweep.mode: "step"`, `sweep.atStep`).

### Sweeping every step

`--at-step all` runs the strategy from EVERY top-level step (an anchor's name where one names the
step); `--at-step anchors` from every declared anchor:

```bash
jevitate explore --from-journey checkout --at-step all --strategy adversarial --fixtures restore.json \
  --max-actions 120 --real --json
```

Each stop point is its own `explore --from-journey` run in a fresh browser session, between the
`--fixtures` setup and restore (any strategy; hooks need `--allow-shell-hooks`). `--max-actions`
and `--max-decisions` are the sweep's TOTAL, split evenly per stop point (each gets at least 1;
without them, 40 actions per stop). The rest of the command line is forwarded to every stop. The
result is one deduped report, as a campaign's (`sweep.stops`, `sweep.budgetPerStop`, `missions`,
`report.defects[].branches` naming exactly the steps each defect is reachable from), in `--out`.

Declare anchors in the Journey's `metadata` (validated: names unique, each step one of the Journey's):

```json
"anchors": [
  { "name": "payment", "step": 6, "description": "card form, order total shown", "probes": ["double submit", "swap the cart id"] }
]
```

### Campaigns

`jevitate campaign run <spec.json>` runs many anchored missions and reads them as one report:

```json
{
  "version": 1,
  "name": "release-candidate",
  "env": "staging",
  "fixtures": "restore.json",
  "maxRuns": 40,
  "maxActions": 60,
  "jobs": [
    { "id": "checkout", "journey": "checkout", "params": { "email": "a@example.test" },
      "anchors": ["payment", 4], "strategies": ["adversarial", "exploratory"] },
    { "id": "invite", "journey": "invite-teammate", "storageState": "~/.jevitate/sessions/admin.json",
      "strategies": ["adversarial"], "maxActions": 40 }
  ]
}
```

1. **Discovery**: each job's whole Journey is replayed once. A stale one is reported and its
   missions are skipped (`journey-stale`), never run from a URL.
2. **Anchored missions**, in spec order (job → anchor → strategy), each `explore --from-journey`
   in its own fresh browser context. The spec's `fixtures` (and `before`/`after` hooks, with
   `--allow-shell-hooks`) set up before and restore after EVERY run, discovery included, so one
   mission's side effects never leak into the next.
3. **One report**: `campaign.json` and `campaign.md` in `--out` (default
   `.jevitate/logs/<date>/campaign-<stamp>`). The defects are consolidated exactly as `jevitate
   report` does, each with the Journey steps it branched from.

| Spec field | Meaning |
|---|---|
| `version` | `1` |
| `jobs[]` | `{ id, journey, strategies, anchors?, params?, storageState?, goal?, appClass?, success?, maxActions?, maxDecisions? }`. `anchors` default to every anchor the Journey declares; `"all"` / `"anchors"` sweep every step / every anchor, and then the job's `maxActions`/`maxDecisions` are its TOTAL, split evenly per mission; `goal` is required by goal and usability, `appClass` by usability |
| `env`, `baseUrl`, `storageState` | As `--env` / `--base-url` / `--storage-state` for every job (a job's own session wins) |
| `fixtures`, `before`, `after` | The state restore around every run (paths relative to the spec; `~/` is home) |
| `discovery` | `false` skips the discovery replay |
| `maxRuns` | The mission cap (default 50, at most 200); `maxActions` (default 40) and `maxDecisions` are per-mission defaults |

**Mission options (#311).** Every `campaign run` flag beyond its own (`--journeys-dir`, `--out`,
`--allow-shell-hooks`, `--hook-timeout-ms`, `--real`/`--fake-ai`, `--json`) is forwarded to every
anchored mission as given: `--allow-destructive`, `--allow-writes`, `--deny`, `--paid`,
`--invariants`, the backend-log flags (`--log-source`, `--log-defect`, `--log-scope`, …,
`--server-log-drain-ms`), `--evidence-video`, `--record-video` and `--screenshots`. They are operator
flags, never spec fields: a spec file alone never widens what a mission may click or read. Over MCP,
`run_campaign` takes the safety and media flags; log sources and hooks stay operator-only.
`--hook-timeout-ms` bounds the spec's `before`/`after` hooks (it also applies to an `--at-step all`
sweep's hooks).

Bounded: at most 50 jobs. The campaign's outcome is the worst of its missions' (a stale or broken
mission makes it `inconclusive`, exit 2; its findings are still reported). An invalid spec is
refused with every problem listed (`E_CAMPAIGN_SPEC`, exit 64) before any browser opens. A
campaign needs `--real` or `--fake-ai`. Over MCP: `journey_anchors`, `run_exploration` with
`fromJourney`/`atStep`, and `run_campaign`. In a `check` suite, a mission item takes `fromJourney`,
`atStep`, `params`, `env` and `baseUrl` (resolved at preflight); `atStep: "all"`/`"anchors"`
expands into one item per stop point (`<name>@<stop>`, its `maxActions` split evenly), each between
the target's fixture setup and restore.

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

`jevitate init` adds `journeys/.drafts/` to `.jevitate/.gitignore` (re-running `init` on an
existing project adds the line once), so an unapproved draft is never committed by accident: the
text reaches the repo only as part of the Journey, after `--approve`.

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

## Environments (`--env`)

A Journey is environment-free: recorded and authored Journeys keep app-relative paths (`/login`),
and the `site` they were recorded on is only their default environment. Name the places your app
runs in the committed `.jevitate/environments.json` (`jevitate init` writes an example once and
never overwrites it):

```json
{
  "local":   { "baseUrl": "http://localhost:3000" },
  "staging": {
    "baseUrl": "https://staging.example.com",
    "allow": ["https://auth.example.com"],
    "fixtures": "fixtures/staging.json",
    "hooks": { "before": "./scripts/seed-staging.sh" }
  }
}
```

```bash
jevitate journey run checkout --env staging
jevitate journey run checkout --base-url https://pr-123.preview.example.com   # an ad-hoc environment
jevitate journey annotate checkout --env staging --real
jevitate regression run cart-total --env local
jevitate load run checkout --env staging --authorized-origin https://staging.example.com
```

- `baseUrl` is an origin (no path, no credentials). The Journey's recorded same-origin URLs move
  onto it, with their path, query and fragment; app-relative paths resolve against it.
- The run's allowlist is the environment: `baseUrl` plus `allow`. A Journey step on any other
  origin is refused (exit 64) before any browser opens: add the origin to `allow` if it belongs.
- `fixtures` (relative to the file) and `hooks` (`before`/`after`) apply when `--fixtures`,
  `--before` and `--after` are not given. Hooks still need `--allow-shell-hooks`.
- `"production": true` marks a live environment: [`demo`](#demo-an-aspect-from-a-one-line-request)
  refuses it.
- `--base-url` alone is an ad-hoc environment; with `--env`, it replaces that environment's
  `baseUrl` and keeps the rest.
- An unknown `--env` is exit 64 and lists the known ones. Without `--env` or `--base-url`, a
  Journey runs on its recorded site, exactly as before.
- Check suites take the same choice per Journey item: `{ "id": "checkout", "env": "staging" }`
  ([ci](./ci.md)).

The file is committed with your code, so it **never** holds a secret or a session: a
`storageState`, `secret`, `password`, `token`, `cookie`, `credential` or `apiKey` key anywhere in it
is refused. Sessions and secrets for an environment stay in `~/.jevitate/targets.json`, keyed by
the environment's origin, the same per-origin file queued missions use:

```json
{
  "https://staging.example.com": {
    "storageState": "sessions/staging.json",
    "secretFields": ["label=Password=env:STAGING_PASSWORD"],
    "personas": { "admin": { "storageState": "sessions/staging-admin.json" } }
  }
}
```

`journey run`, `journey annotate`, `regression run` and `load run` start from the environment's
`storageState` when
`--storage-state` is not given (paths are relative to `targets.json`). `personas` holds one session
per persona for commands that run as a named persona. Secret fields are read from the environment
variable at run time and never written anywhere. A Journey's own vault `secretRefs` stay bound to
the origin they were recorded on: a secret for one environment is never typed into another.

## Demo a Journey: video, subtitles and a step-by-step guide

`journey demo` replays a Journey as a narrated demo, for sales, onboarding and user docs:

```bash
jevitate journey demo checkout --env staging --video demos/checkout.webm --guide docs/checkout.md
jevitate journey demo checkout --headed --pace 2500    # present it live
```

- The on-page overlay shows the Journey's `goal` (else its name) as a title card, then each step's
  `objective` as the caption (else its `label`, else a value-free description), with the step's
  target highlighted and a `--pace` pause (default 1500 ms), then an outcome card.
  [Annotate](#annotate-a-journey-draft-its-intent-then-approve-it) the Journey first so every step
  has an objective.
- `--video <file.webm>` writes the recording (Playwright records WebM; convert it with ffmpeg if
  you need MP4) and `<file>.vtt` beside it: one WebVTT cue per step, timed to its caption.
- `--guide <file.md>` writes a Markdown guide: the goal, the preconditions, and per step its
  number, objective, expected result and a screenshot (in `<file>.assets/`). The overlay is hidden
  in every screenshot.
- With neither flag, both go to a fresh `journey-demo-<id>-<stamp>/` folder in the logs dir.
- Headless by default (for CI); `--headed` shows the window (it needs a display), `--slow-mo` slows
  every browser operation.

The replay is a `journey run`: the same `--param`, `--storage-state`, `--env`/`--base-url`,
fixture, browser and emulation flags, site policy and fail-closed run policy, so paid or
destructive steps are refused as usual, and a demo never self-heals. Run it against local, dev or
staging with seeded data. Secret parameter values are redacted in the captions, subtitles, guide
and result, and the written text is checked for them before it is saved. They are also masked in
pixels, in the video and in every guide screenshot; a screenshot whose mask cannot be proven is not
written ([details](./operations.md#evidence-clips-and-screenshots)).

A demo whose Journey no longer replays is **stale**: nothing is written, the command says which
step stopped, and it exits `1`, so a CI job that regenerates demos catches it.

| Exit | When |
|---|---|
| `0` | The Journey replayed and every requested output was written |
| `1` | Stale: the Journey no longer replays (nothing written) |
| `2` | The replay completed but an output could not be produced (`E_JOURNEY_DEMO_OUTPUT`), or another runtime failure |
| `64` | Bad arguments (a `--video` that is not `.webm`, a `--guide` that is not `.md`, a bad `--pace`), an unknown Journey, a bad `--param`, `--headed` without a display |

## Demo an aspect from a one-line request

`demo` turns one sentence into a reviewed demo. It explores, keeps only the steps that matter,
annotates them and renders a **DRAFT**. One approval then makes it an ordinary Journey:

```bash
jevitate demo "Save your display name" --env staging --success "textIncludes:testId=status|Saved" --real
jevitate demo approve demo-save-your-display-name     # review first: the Journey, its annotations, the draft
```

1. **Explore and author.** A goal-directed exploration (the `explore-author-journey` path) writes
   a Journey for the aspect. `--success` is the independent check that proves the aspect was
   shown: Jev drives, code decides. `--start <path>` sets where exploration begins, `--persona`
   picks the session, and `--id` names the Journey (default `demo-<aspect slug>`).
2. **Clean path.** The explored path is minimized with the same ddmin as `regression capture`. A
   step (a detour, a dead end, a repeated attempt) is dropped only if the Journey still replays
   to its success check without it. The success check always stays as the last step. The explored
   path must replay before minimizing, and the minimized one is replayed once more; otherwise
   nothing is written (exit `1`).
3. **Annotate.** A replay drafts each step's objective and expected result (as `journey annotate`).
   The Journey's goal is the aspect, and its success criterion is the `--success` check.
4. **Draft demo.** A video, `.vtt` and guide (as `journey demo`), narrated with the drafted
   annotations and marked DRAFT: a watermark on the overlay, a note and a `[DRAFT]` prefix in the
   subtitles, and a DRAFT title and notice in the guide. They go to `--out <dir>`, or else a fresh
   folder in the logs dir.

The Journey (unpromoted), its annotation draft and a demo record (`<journeys>/.drafts/<id>.demo.json`)
are written only when every stage succeeds. `demo approve <id>` shows the Journey with its
annotations, renders the final demo (no DRAFT marks) on the environment the draft was made on,
then applies the annotations and promotes the Journey. If that replay fails, nothing is promoted
(exit `1`). After approval it is an ordinary Journey: re-render it with `journey demo --env
<any>`, or check it in CI with `journey run`.

Safety: `demo` runs only against a named environment (`--env`). One flagged `"production": true`
in `.jevitate/environments.json` is refused before anything runs (`E_DEMO_PRODUCTION_ENV`, exit
`64`), both when drafting and when approving. Writes are allowed. Paid, destructive and
session-ending controls are refused unless that origin's `safety` in `~/.jevitate/targets.json`
allows them. Every replay uses `journey run`'s fail-closed policy, and every output is redacted.
Nothing is promoted without `demo approve`.

| Exit | When |
|---|---|
| `0` | Drafted (`demo`), or approved and rendered (`demo approve`) |
| `1` | The success check was not reached, the path did not replay, or the demo's replay stopped (nothing written or promoted) |
| `64` | No `--env` / `--success`, a production environment, an existing id or pending draft (`E_DEMO_EXISTS`), no demo draft to approve (`E_DEMO_NOT_FOUND`) |

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
