# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to
[Semantic Versioning](https://semver.org/) (pre-1.0: a minor version bump may include
behaviour changes).

## [0.3.0] – 2026-10-02

0.3.0 lets a mission start from inside a promoted Journey (`--from-journey`/`--at-step`, Journey
anchors, `campaign run`), records what each action changed (`--action-deltas`), loads unpacked
browser extensions, and governs browser count and memory on shared machines. UX findings are now
claims verified by code, and API keys are verified live with their provider. Many goal-loop,
grounding, network, hang and guard fixes make runs end with a truthful outcome instead of a false
defect, a crash or a 15 s hang.

### Behaviour changes

- **Keys are verified live (#291).** `ai status` and `init` check each key with its provider by a
  non-billable auth call (`valid`, `invalid`, `unreachable`, `missing`); `ai status` exits 2 when a
  key is invalid or could not be checked. `ai setup` refuses to store a key that fails the check.
  Live-AI runs check once at startup and stop with `E_AI_SETUP_REQUIRED` (exit 64) on a rejected key.
- **Sign-up identities are unique per run (#271).** A model-invented email or username gets a
  per-run suffix, so a repeated sign-up goal never collides with an earlier run's account.
- **No-destructive mode (#270).** A goal that asks for a change but has no `--success` no longer
  performs a destructive write (e.g. "Remove" → `RemoveMember`) unless `--allow-writes` or
  `--allow-destructive` is passed.
- **Early `blocked` is refused (#237).** A model `blocked` before any action is refused; insisting
  ends `inconclusive` (insufficient coverage), not `defects-found`.
- **Frozen pages are stalls (#296).** A renderer that freezes mid-perception ends `inconclusive`
  with `failure.kind: "stalled"`, never a crash.
- **UX findings redesign (#198).** Far fewer findings: each one is a claim code verified.
  Destructive-action checks need the opt-in `--probe-guards`.
- **Resource governance on by default (#205).** Runs share a machine-wide browser cap and a
  per-run browser-memory ceiling; a starved host refuses new runs with `E_HOST_STARVED`.
- **Own-send tracking (#241).** A chat's reply wait follows the run's own in-flight request;
  background polling no longer keeps a wait alive or holds a landed reply's settle open.
- **Deprecated result fields removed.** As announced in 0.2.0, results, `--json` envelopes and MCP
  outputs no longer carry `serverLogDefects`, `recordingPath`, `usage.usd` or
  `usage.jevPriceSource`. `schemaVersion` stays `1`; a 0.2.0 result that still has them validates,
  and `report`, `ledger` and `verify-fix` still read them from older result files.

### Upgrade notes

- **Keys:** CI and offline use should pass `--no-verify` to `ai status`/`ai setup`/`init` and set
  `JEVITATE_NO_KEY_VERIFY=1` for runs; scripts that treated `ai status` exit 0 as "configured"
  will now see exit 2 for a bad or unverifiable key (#291).
- **Change goals:** add `--success` checks, or pass `--allow-writes`/`--allow-destructive`, for a
  change goal that must perform a destructive write (#270).
- **Outcomes:** expect `inconclusive` (insufficient-coverage) where an early `blocked` used to
  report defects (#237), and `inconclusive` / `failure.kind: "stalled"` where a frozen page used to
  crash (#296).
- **UX findings (#198):** expect fewer findings and different `rubricItemId`s. Tooling that read
  `heuristicAppendix` or `tier: "semantic"` findings should read `findings[].claim`. Destructive-
  action findings need a live run with `--probe-guards` (preferably against staging) or its
  evidence sidecar; otherwise such claims are listed as unverifiable coverage (`coverage.skipped`,
  `claim:destructive-unguarded`), so a page with destructive controls no longer reads as complete
  coverage. Add `.jevitate/product.json` (docs/ux-findings.md) to have prices and next steps checked.
- **Resources (#205):** defaults are `--max-browsers` = `JEVITATE_MAX_BROWSERS`, else cores/4 within
  2..6, and `--max-browser-memory` = `JEVITATE_MAX_BROWSER_MEMORY_MB`, else 4 GiB or half the RAM.
  A run over the ceiling ends `inconclusive` with `failure.kind: "resource-limit"`. A starved host
  refuses with `E_HOST_STARVED` unless `--ignore-host-load`; `JEVITATE_RESOURCE_GOVERNANCE=off`
  turns the automatic parts off. See docs/operations.md.
- **Reply waits (#241):** chat runs that relied on background polling to extend a wait now end
  sooner; a `send` that started no request is a failed send.
- **New log flags (#204, #282):** `--log-correlation-header`, `--log-id-pattern` and `--log-scope`
  are additive; set `--log-scope` when several runs share one backend log.
- **Action deltas are opt-in (#303):** nothing changes without `--action-deltas`.
- **Removed result fields:** read `defects` entries with `kind: "server-log"` instead of
  `serverLogDefects`, `recordingPaths[0]` instead of `recordingPath`, `usage.totalUsd` (check
  `usage.priced`) instead of `usage.usd`, and `usage.priceSource` instead of `usage.jevPriceSource`.
  See docs/results.md "Removed aliases".

### Added

- **Journey-anchored exploration (#293):** `explore --from-journey <id> --at-step <n|anchor>`
  replays a promoted Journey's prefix (fail-closed, never self-healed) and starts any mission on
  the live page; a stale prefix is `inconclusive` / `failure.kind: "journey-stale"` (exit 2).
  `--at-step all|anchors` sweeps every step or anchor in fresh `--fixtures`-restored sessions.
  Results and findings record `branch: {journeyId, step, anchor}`; `verify-fix` and
  `regression capture|run` replay through the prefix.
- **Journey anchors (#293):** optional `metadata.anchors` (`{name, step, description?, probes?}`);
  `journey anchors <id>` lists them.
- **Campaigns (#293):** `campaign run <spec.json>` runs discovery then anchored missions with
  fixture restores and one deduped report (`campaign.json`, `campaign.md`); an invalid spec exits
  64 listing every problem. MCP `journey_anchors` and `run_campaign`; `run_exploration` and suite
  mission items take `fromJourney`/`atStep`/`params`/`env`/`baseUrl`.
- **Action deltas (#303):** opt-in `--action-deltas` (MCP/suite `actionDeltas`) on goal, usability,
  adversarial and coverage runs and on `journey run|annotate|demo` and `verify-fix`. Code records
  each action's redacted page change and a verdict (`no-change`, `relevant-change`,
  `inconclusive`); deltas attach to transcript and Recording steps (`delta`) and the result
  (`actionDeltas`). Goal runs re-check a write after reload (`persisted: yes | no | inconclusive`).
  Cost: ~50–110 ms per action on a small page, 0.35–0.5 s on a 400-row page.
- **Browser extensions (#256):** `--extension <dir>` (repeatable; MCP `extension`) loads an
  unpacked extension; its `chrome-extension://<id>` pages are navigable. Recordings record each
  extension's `{id, name, version}`; `verify-fix` refuses a different build (exit 64). See
  docs/extensions.md.
- **Fixture identities (#243):** a fixture step's `auth` can name an `identity`, bound by
  `--fixture-identity <name>=<storageState>` (MCP `fixtureIdentity`) or a targets.json persona;
  unbound identities are refused. `--url` accepts a root-relative `${setup.*}` path. See
  docs/fixtures.md.
- **Type fixtures (#281):** `explore --type-fixture '<descriptor>=<file>'` (MCP `typeFixture`)
  types a file's exact text into a matching field.
- **Markup-injection probe (#301):** adversarial `boundary-submit` submits inert, per-submission
  canaries and reports a rendered one as a `markup-injection` defect (`stored` or `reflected`);
  boundary values add a ~100 KB value and RTL-override / zero-width characters.
- **Vertical clipping (#302):** viewport runs flag text cut off by a fixed-height
  `overflow: hidden` box or spilled above the page top (`vertical-clipping`); intentional
  truncation is not reported. See docs/exploration.md.
- **UX claims (#198):** usability findings come from a guard probe (opt-in `--probe-guards`;
  fail-safe, aborts every write), product facts or run friction; Jev only categorizes and answers
  two grade questions. See docs/ux-findings.md.
- **Product facts (#198):** `.jevitate/product.json` or `--product <file>` on `ux` and
  `explore --strategy usability` (MCP `ux_review`/`run_exploration`, suite items): wrong prices or
  trials are `fact-conflict`, a missing next step is `next-step-unclear`; an invalid file exits 64
  (`E_UX_PRODUCT_INPUT`).
- **UX screenshots and polish (#198):** live findings get a cropped, secret-masked screenshot with
  the cited control boxed (`finding.screenshot`); opt-in `--polish` rewrites recommendations.
- **Resource governance (#205):** `--max-browsers`, `--max-browser-memory <MiB>`,
  `--ignore-host-load`, `jevitate doctor --cleanup` (closes browsers left by a killed jevitate,
  found by an owner marker), MCP `maxBrowsers`/`maxBrowserMemory`, and `hostHealth.resources` in
  results.
- **Keys (#268):** `init` and `ai status` name each key, its provider and its source and report an
  overriding env var (`--json` adds `sources`); `ai setup <feature> --replace` and
  `init --replace-keys` replace a stored key.
- **Skill (#292):** built-in `jevitate-test-campaign` — plan and run a whole-release test campaign
  (now using anchors and campaigns, #293).

### Changed

- With `--action-deltas`, a `relevant-change` action is progress even with an unchanged control
  set, and an `inconclusive` one does not count toward the no-progress stop (#303).
- UX finding text is templated from verified fields; `heuristicAppendix` is empty; additive
  `finding.claim`, `finding.grade`, `finding.screenshot`, `report.claims`, suppression reasons
  `unverified`/`not-a-problem`, and sidecar `probes` (#198).
- The #298 credential shapes and secret markers moved to `@jevitate/ai-core` (shared by the pixel
  mask and action deltas); behaviour unchanged.

### Fixed

#### Goal loop

- Controls behind an open modal or unreachable by scroll are not offered; a twice-covered target
  is withheld, and five failed actions in a row end the run naming the overlay (#272, #294).
- `select` never re-chooses the selected option or a placeholder; dash spellings map (#273).
- Retyping a field that changed only its own value is no progress (#242).
- A `send` that started no request and changed nothing is a failed send (#241).
- A model `blocked` before any action is refused (#237).
- `<details>` summaries are controls; goal-named controls survive the candidate cap (#287).
- Refusals and app-answered scrolls never produce a `ui-no-progress` hang (#276).
- "Send invite" is goal-asked when the goal orders the thing itself; `reloadThen`-only checks no
  longer turn `blocked` into "goal already met" (#235).
- A goal's quoted passage is typed verbatim into a textarea, line breaks kept (#281).

#### Answers & success checks

- Numbered-list markers are not stated figures; inflected claim words are said by their quote (#236).
- List answers may quote entries one per line when each is on an observed page, in order (#234).
- "None exists" is a first-class answer once half the top-level navigation was seen, else
  `inconclusive` (#238).
- Reports never ground on the run's own unsaved input; a write goal needs a successful write (#239).
- A goal that asks for a report is not met by `--success` checks alone (#286).
- Declared invariants read request JSON payloads (`network.request`) and compare lists in order
  (`sameList`); credential-named keys are never read (#295).

#### Network & logs

- The repeated-side-effect guard ignores third-party writes and `--settle-ignore`d beacons (#274, #284).
- `requestMade` matches once sent, and a long in-flight write is pending work (#283).
- Third-party iframe console errors are advisories with their `frameUrl` (#297).
- Backend-log lines match the exact request by trace/correlation id and a `blocked` reason names
  it (#204); `--log-scope` attributes only matching lines to the run (#282).
- A chat's own in-flight turn is awaited; background polls are told apart over the last minute
  (#241, #283, #284, #288).

#### Capture & secrets

- Screenshots and videos mask secrets the app reveals mid-run (#298).
- Multi-runs forward a bare `--screenshots`/`--record-video` instead of writing `./true` (#290).
- `visible:<d>` holds when any of several matches is visible (#299).
- Typing into a textarea keeps newlines (#285).

#### CLI & keys

- Key entry is masked with `•` and its instructions stay on screen (#269).
- `explore --hang-replays <n>` no longer crashes (#275).

#### Adversarial

- An action that switches the signed-in identity is detected; invariants are not judged across it
  and the run returns to the original identity (`identityChanges`, else `stop: "identity-changed"`) (#300).

#### Hangs & waits

- Documented waits and live-progress busy indicators are waited out within `--job-wait-ms` (#258, #288).
- A save that writes and returns to an earlier route is progress (#289).
- Perception is bounded on pages with hundreds of controls (#278).

#### Guards

- A find-out goal's read-only guard judges a submit by its requests (#253).
- `--paid` controls are matched by action word, ignoring live estimates (#280).
- The budget guard reads an estimate range at its high end (#279).

#### Journeys / campaigns

- `--feature` treats its seed page as in scope and re-queues a re-rendered seed (#277).
- Resets inside an anchored mission re-replay the prefix; a stale branch replay is a typed
  `inconclusive` (#293).

#### UX

- Claims that fail code's check are dropped and counted in `report.claims`; reports add evidence
  caveats when product facts or guard probes are missing (#198).

#### Resources

- Browsers orphaned by a killed jevitate are closed before the next run; only jevitate-launched
  processes are signalled (#205).

#### Release

- Releases are published by hand with `scripts/release.sh` while npm OIDC publishing is blocked
  (npm/cli#9969); the Release workflow no longer fails on every push (#267).

### Internal

- #304: Node-side timing goes through one injectable clock (`clock` in `@jevitate/domain`, moved
  there by the `scripts/codemods/inject-clock.mjs` codemod), guarded by `scripts/check-clock.mjs`
  in `pnpm lint`. Tests use `FakeClock`, or `TimeSkippingClock` with `page.clock` in browser suites,
  so idle waits no longer cost real time. A small `[realtime]` set keeps the real clock.
- #232: the stateful exploration loops (`explore.ts`, `missions/adversarial.ts`,
  `missions/induction.ts`) are split into `goal-loop/`, `missions/adversarial-hunt/` and
  `missions/induction-frontier/` modules around explicit context objects; move-only.
- AGENTS.md documents path-scoped test runs from the repo root.
- Release workflow: actions pinned to commit SHAs on Node 24, manual publish runs only;
  `release.sh` waits for npm and tags locally; `scripts/sync-release-branches.sh` prepares the
  `main` → `dev` back-merge; RELEASING.md updated (#267).

### Internal

- The exploration loops are split into a run-state object plus one module per phase / action
  handler: the goal loop (`explore.ts` → `goal-loop/`), the adversarial hunt (`adversarial-hunt/`)
  and the coverage frontier (`induction-frontier/`). Move-only — no behaviour change (#232).

## [0.2.0] – 2026-09-29

A backlog sweep across every mission type, then three dogfood passes that turned it into one
contract. Every result now carries one versioned schema (`schemaVersion: 1`) whose
`missionOutcome` is always the canonical verdict (a goal's own ending moves to `goalOutcome`);
every command shares one exit-code table (`64` for usage and input errors) and prints a human
summary unless you pass `--json`; and a run that proved nothing (too little coverage, a vacuous
check, a starved host, an app that stopped answering) is `inconclusive`, never `clean`. Goal
runs give honest reasons, detect success mid-run and answer find-out questions only from what
the page shows; adversarial, coverage/exploratory and feature missions stop wandering and stop
under-reporting; an HTTP 5xx is a defect in every strategy, while a state flagged only by Jev's
judgment is advisory; declared invariants, backend-log correlation and route-template fixes cut
false positives and false negatives; usability findings are grounded and grouped (still a
preview); verify-fix, a finding ledger, regression capture and a `check`/`diff`/`report` trio
harden CI use; multi-run voting, persona matrices and multi-actor missions add reliability and
RBAC coverage; and build identity, usage/cost accounting, host-health sampling, mission fixtures,
bounded runs and the kill switch land end to end. A demo layer on top lets you watch, record and
narrate runs (headed mode, video, screenshots, `journey demo`, `demo "<aspect>"`), gives Journeys
intent and environments, attaches captioned evidence to defects, and brings the CLI and MCP to
full parity.

### Result contract and CLI

- An app that freezes during a run is recognised in every strategy: before a hang or no-progress stop becomes a finding or is blamed on the host, the run re-requests the page's own path once (no query, no cookies, authorized origins only, 10 s). No response or a refused connection ends the run `inconclusive` with `failure.kind: "target-unresponsive"`, which outranks host starvation — goal and usability runs included ([#230](https://github.com/matt-cochran/jevitate/issues/230)).
- An unreachable target fails fast: a TCP pre-flight before the first navigation (3 s on loopback, 10 s otherwise) ends the run `inconclusive` (`target-unreachable`) in seconds instead of waiting out navigation timeouts, and `verify-fix` shows the real cause (e.g. `ERR_CONNECTION_REFUSED`). A start page that only times out on a starved host, while a fresh request for it still answers, is `degraded-environment` with a `page-load-timeout` entry instead ([#213](https://github.com/matt-cochran/jevitate/issues/213), [#230](https://github.com/matt-cochran/jevitate/issues/230)).
- More refusals exit 64 instead of running or exiting 0: an unknown `--strategy` (before any other message), `--real` together with `--fake-ai`, an invalid URL, `profile status <unknown>` (`E_PROFILE_UNKNOWN`), `regression capture --id` over an existing regression without `--force` (`E_REGRESSION_EXISTS`), `regression capture` of a hard-signal finding (it points at the ledger instead), and an unknown `report --target` ([#213](https://github.com/matt-cochran/jevitate/issues/213), [#230](https://github.com/matt-cochran/jevitate/issues/230)).
- Human output polish: aligned columns, a truthful `check` headline with FAILED reasons, results labelled "result", a cost line for runs with 0 model calls, a UX summary line with counts that add up, a `SCOPE` line on coverage and exploratory runs, a feature run naming the controls it refused, "no action was taken" saying why and how, a failing `valueEquals` showing the value it read, `init --dry-run` saying "would", a `--help` description on every command, `next:` hints that keep the `--dir`/`--result` you passed, a `--repeat` headline that leads with a failed goal's verdict, and no EPIPE crash when output is piped into `head` ([#213](https://github.com/matt-cochran/jevitate/issues/213), [#230](https://github.com/matt-cochran/jevitate/issues/230)).
- `jevitate init` never prompts without a TTY: it completes, warns `keys: <feature> not configured — set … or run \`jevitate ai setup <feature>\``, and exits 0 ([#230](https://github.com/matt-cochran/jevitate/issues/230)).
- `--fake-ai` (suite `ai: "fake"`) answers every question kind. A fake-AI goal item in `check` never gates as FAILED on a goal-only ending (it is reported `inconclusive`, "use --real to gate on this goal"), while hard signals still gate ([#213](https://github.com/matt-cochran/jevitate/issues/213)).

- One versioned result schema across strategies: every goal, coverage, exploratory, adversarial, feature and usability result carries `schemaVersion: 1`, `strategy`, `missionOutcome`, `exitCode`, `defects`, `hangs`, `recordingPaths` (always an array), `transcriptPath`, `resultPath`, `target` and `engine`, filled the same way by every strategy and exported as `MissionResultSchema`/`PersistedMissionResultSchema`/`MissionResultCore` (see `docs/results.md`). `defects` holds every defect, `server-log` ones included. `serverLogDefects`, `recordingPath`, `usage.usd` and `usage.jevPriceSource` are deprecated aliases, still written in 0.2.0 and removed in the next minor ([#195](https://github.com/matt-cochran/jevitate/issues/195)).
- A goal run's `missionOutcome` is always the canonical verdict (`clean`, `defects-found`, `inconclusive`, `crashed`, `hang`, `intermittent`), folded in one place (`GOAL_OUTCOME_FOLD` in `@jevitate/domain`); the goal's own ending (`succeeded`, `failed`, `exhausted`, `blocked`, …) moves to a new `goalOutcome` field on every goal result (`outcome` still holds the same word). The persisted result, MCP `get_mission_result`, a `check` goal item, a queued mission's record, `report`, multi-run results and the human summary all follow it; a result written before this still reads, its goal word folded the same way ([#217](https://github.com/matt-cochran/jevitate/issues/217)).
- A new goal outcome, `failed` (exit 1, folds onto `defects-found`): the model said `done` but an independent success check then failed, with `failure.kind: "success-check-failed"` naming the check. `blocked` now only means the loop gave up, and a goal whose model kept proposing `done` until code stopped accepting it shows `stop: "done"` ([#209](https://github.com/matt-cochran/jevitate/issues/209), [#217](https://github.com/matt-cochran/jevitate/issues/217)).
- An HTTP 5xx from the app's own origins is an `http-5xx` defect in every strategy (goal, feature, coverage/exploratory, usability as well as adversarial), with the adversarial fingerprint (endpoint pattern + status) so `verify-fix` replays it the same way. A goal whose checks held but whose run hit a 5xx ends `defects-found` (exit 1), with `reason` naming the request (`PUT /demo/api/profile → 500`); an adversarial start page that answers 5xx is an `http-5xx` defect instead of an inconclusive "not rendered"; a third-party origin's 5xx is never the app's defect; in a usability run the defect is `advisory: true` ([#208](https://github.com/matt-cochran/jevitate/issues/208)).
- A state flagged only by Jev's judgment (`judgment-flagged-state`) carries `advisory: true`: it keeps its repro Recording for `verify-fix` but never sets `missionOutcome` or the exit code. A run is `defects-found` only when an independent code oracle confirms a defect (an HTTP 5xx, a horizontal overflow, a declared invariant, a server-log defect) ([#214](https://github.com/matt-cochran/jevitate/issues/214)).
- A coverage run's frontier defects (`horizontal-overflow`, `judgment-flagged-state`) are also in top-level `defects`, each with a `fingerprint` and `kind` ([#209](https://github.com/matt-cochran/jevitate/issues/209)).
- A starved host is told apart from app findings: every run samples the host (the browser pool's admission thresholds, load average per core, the driver's event-loop lag, the render trend against the run's own baseline) and every result carries `hostHealth` and `environmentDegraded`. A hang, click timeout or no-progress stop met while the host was starved is listed there as advisory, never as a defect or hang; a run most of whose steps ran starved is `inconclusive` with `failure.kind: "degraded-environment"`. `JEVITATE_HOST_STARVATION=off` keeps the sampling but disables the attribution ([#203](https://github.com/matt-cochran/jevitate/issues/203)).
- An app that stops answering navigation mid-run (its server froze or went away) ends `inconclusive` with `failure.kind: "target-unresponsive"` and a plain reason naming the path — no stack trace, never `crashed`, and no false main-thread hang ([#226](https://github.com/matt-cochran/jevitate/issues/226)).
- One exit-code table for every command, documented once in `docs/outcomes.md` "Exit codes": `0` ok · `1` defects (defects found, a gating finding, still reproduces) · `2` inconclusive (the run or command could not finish its work) · `3` hang · `4` intermittent · `64` usage/input error, where nothing ran · `130`/`143` killed. Usage errors (a bad flag or argument, an unknown option, an unreadable input file, an unknown id, a target outside the allowlist) exit `64` on every command; numeric flags are checked while the command line is parsed (`--max-actions abc`, `--replays 0`) ([#210](https://github.com/matt-cochran/jevitate/issues/210), [#218](https://github.com/matt-cochran/jevitate/issues/218)).
- Without `--json`, every command prints a human summary: `explore` (every strategy) shows the verdict, counts, each defect and hang with its fingerprint, the result file and a `next:` step, a goal leads with its own verdict (`GOAL <goalOutcome> (stop: …)`), and a find-out answer prints as `ANSWER <text> (from page text on <path> | from form field "<name>" on <path>)`. `verify-fix`, `ledger`, `check`, `regression capture|run` and `baseline tag|list|show` print human text too, `journey list`/`source list` say "no … yet", and `init` reports each feature as `ready — n/n configured`. With `--json`, stdout is exactly the `{v, ok, data | error}` envelope, unchanged ([#210](https://github.com/matt-cochran/jevitate/issues/210), [#216](https://github.com/matt-cochran/jevitate/issues/216), [#227](https://github.com/matt-cochran/jevitate/issues/227)).
- Every refusal is `error <CODE>: <message>` on stderr with nothing on stdout (commands such as `journey run`, `ux`, `regression`, `diff`, `baseline`, `report`, `site`, `mission` and `mcp` used to print the JSON envelope). With `--json`, a command line refused while parsing prints an envelope coded `E_<COMMAND>_ARGS`. A test walks every registered command's refusal paths so a new command cannot regress ([#218](https://github.com/matt-cochran/jevitate/issues/218), [#227](https://github.com/matt-cochran/jevitate/issues/227)).
- `--success`, `--success-when` and `--allow-vacuous-checks` are refused (exit 64, `E_EXPLORE_ARGS`) with `--strategy coverage|exploratory|adversarial` and `--feature`, instead of being silently ignored ([#225](https://github.com/matt-cochran/jevitate/issues/225)).
- Coverage and exploratory results name the strategy that ran (`strategy: "coverage" | "exploratory"`) ([#191](https://github.com/matt-cochran/jevitate/pull/191)).

### Goal missions and success checks

- A goal mission that fails now always states a concrete reason instead of a generic one, and a missing text target reports a clean "no" instead of crashing ([#70](https://github.com/matt-cochran/jevitate/pull/70)).
- Success checks gained `reloadThen` (reload first, so it proves the change persisted) and network-based `requestMade`/`responseStatus` checks ([#64](https://github.com/matt-cochran/jevitate/issues/64), [#65](https://github.com/matt-cochran/jevitate/issues/65), [#68](https://github.com/matt-cochran/jevitate/issues/68), [#69](https://github.com/matt-cochran/jevitate/pull/69)).
- Conversational pages are now handled directly — type-then-send, awaiting a reply before acting, a grounded "done", and options-aware `select` ([#67](https://github.com/matt-cochran/jevitate/pull/67)).
- The `explore --fixture <path>` upload op attaches a local file to a file input, including hidden `<input type=file>` controls, with deterministic replay ([#57](https://github.com/matt-cochran/jevitate/pull/57)).
- Every mission's action decisions, render-wait, occlusion handling and transcripts now share one engine path, improving reliability across all strategies ([#63](https://github.com/matt-cochran/jevitate/pull/63)).
- A goal mission blind to inline validation errors no longer wait-loops, mid-run transient success (a one-time secret modal or toast) now counts with `--success-when held`, and a generic "blocked/exhausted" reason now names what actually blocked it ([#79](https://github.com/matt-cochran/jevitate/issues/79), [#80](https://github.com/matt-cochran/jevitate/issues/80), [#84](https://github.com/matt-cochran/jevitate/issues/84), [#106](https://github.com/matt-cochran/jevitate/pull/106)).
- A done-recognition regression is fixed; find-out/understand-style goals now end with a grounded `report(answer)` op and no longer need a dummy `--success` to pass, and a failed run's "last blocker" reason now names the actual offending field, with a near-miss hint added for `requestMade` checks that almost matched ([#91](https://github.com/matt-cochran/jevitate/issues/91), [#101](https://github.com/matt-cochran/jevitate/issues/101), [#107](https://github.com/matt-cochran/jevitate/pull/107), [#130](https://github.com/matt-cochran/jevitate/issues/130)).
- `scroll_down`/`scroll_up` no longer misreport "page did not move" when it did, `--secret-field` values are now actually typed into a signup form instead of skipped, and `textIncludes` success checks are no longer thrown off by a page's own CSS `text-transform` ([#109](https://github.com/matt-cochran/jevitate/issues/109), [#111](https://github.com/matt-cochran/jevitate/issues/111), [#113](https://github.com/matt-cochran/jevitate/issues/113)).
- Conversational goals now detect being stuck instead of looping for 30 minutes on repetitive acknowledgements and will take a visibly offered goal CTA; "add another" flows no longer silently reuse the first item's values for the second, and retyping the same value now correctly counts as a real change for the repeat guard ([#122](https://github.com/matt-cochran/jevitate/issues/122), [#123](https://github.com/matt-cochran/jevitate/issues/123)).
- Find-out goals (no `--success`) are read-only by default: code refuses write-flow controls and blocks the write requests an action fires, while the app's background writes and auth refreshes still pass; `--allow-writes` lifts the guard and `--allow-write <glob>` exempts a path ([#158](https://github.com/matt-cochran/jevitate/issues/158)).
- `--success-when held` counts a check only once it changes from not holding to holding (a check already true on the start page is failed as vacuous, with a warning), and the run ends as soon as every check has held instead of acting on ([#174](https://github.com/matt-cochran/jevitate/issues/174)).
- A find-out answer's grounding counts only free-standing figures, so `2FA` or `v2` no longer read as stated numbers ([#157](https://github.com/matt-cochran/jevitate/issues/157)).
- A scroll that moved the page now counts as progress, and a run gets one last turn before a no-progress stop, so a find-out goal no longer stops `blocked` with the answer further down the page ([#172](https://github.com/matt-cochran/jevitate/issues/172)).
- `type` can now edit inside `contenteditable` regions (placing the caret, selecting a range) instead of always replacing the whole element's content, and new `--success`/invariant assertion kinds (`style`, `inViewport`, `box`, `overlaps`, `attr`, `flashed`) read computed style, viewport visibility and transient visual state for editors, heat maps and minimaps ([#148](https://github.com/matt-cochran/jevitate/issues/148)).
- "two-factor", "second factor" or "2-step" in a goal no longer switch on add-another mode (which rejected a retyped email and invented new ones); a reload undoes the last submit's used values ([#184](https://github.com/matt-cochran/jevitate/issues/184)).
- A field's own label or placeholder ("Edit block text") is never typed as its value, and a literal given with `exactly:` is typed verbatim ([#185](https://github.com/matt-cochran/jevitate/issues/185)).
- Same-named controls (a trigger and its confirm, "Analyze" / "Analyze") are offered with their named dialog and position, so a confirm dialog can be confirmed ([#182](https://github.com/matt-cochran/jevitate/issues/182)).
- In an add-another flow, returning to a state already gone through (the second item's one-time dialog) reminds the model which steps followed it ([#188](https://github.com/matt-cochran/jevitate/issues/188)).
- A success check that already held before the run's first action fails as vacuous, in both `final` and `held` modes: a page or `reloadThen` check that held on the seed page and never stopped holding, or a `requestMade`/`responseStatus` matched only by a page-load or polling request (network checks now count only requests sent after the first action). `checkWarnings` names it (`check '<spec>' held at step 0, before any action — it cannot verify the goal`); a run whose only failing checks are vacuous is `inconclusive` with `failure.kind: "vacuous-check"`; `--allow-vacuous-checks` (suite: `allowVacuousChecks`) downgrades it to a warning ([#202](https://github.com/matt-cochran/jevitate/issues/202), [#209](https://github.com/matt-cochran/jevitate/issues/209)).
- While a check is still pending (a `reloadThen`, or one holding since before any action), the transcript records the model's `done` as "accepted provisionally" ([#209](https://github.com/matt-cochran/jevitate/issues/209)).
- Find-out goals answer from ordinary page text and form values: a read-only find-out decision carries the page's visible text (redacted, bounded), a non-secret control value can ground an answer (never a password, one-time-code or bound secret field), and evidence records `source: "page-text"` or `"control-value"`. A model `blocked` on such a goal first gets one grounded report attempt on that page state; a run that found no answer ends "answer not found (pages seen: …)", and a literal "null" answer counts as no answer ([#207](https://github.com/matt-cochran/jevitate/issues/207)).
- A find-out answer must answer the question: a quote that is only an action or label name (a button, a field's label, a nav/header/footer or repeated link) or that sits on an error page (HTTP 4xx/5xx, or a not-found / 404 / error heading or title) is rejected, and the run ends "answer not found". An independent Jev check ("does this quote answer the goal's question?") can veto a grounded answer but never approve one. A `<textarea>` value or contenteditable text grounds an answer like an input's value ([#223](https://github.com/matt-cochran/jevitate/issues/223)).
- A goal asking for an item's title or name treats the page's main heading or document title as it; when the answer generator finds nothing and an `h1` or `<title>` exists, it gets one retry with that hint (grounding unchanged) ([#216](https://github.com/matt-cochran/jevitate/issues/216)).
- A goal that asks about a reply is grounded only on text that appeared after the first send (minus the run's own messages), waiting out `--reply-wait-ms` first; with no new message the report is rejected as "no reply observed" ([#200](https://github.com/matt-cochran/jevitate/issues/200)).
- Perception sees ARIA widgets (`option`, `menuitem*`, `tab`, `radio`, `switch`, `treeitem`), and a page with more than 255 candidate controls is bounded for the judgment (what the last action opened and what the goal names rank first; the model is told how many were omitted); a "too many choices" refusal is retried within its limit instead of ending the run ([#192](https://github.com/matt-cochran/jevitate/issues/192)).
- The read-only guard lets an off-site write through only when its origin is outside `--allow`, it carries no API credentials (`Authorization`, `apikey`, `x-api-key`, …) and the page never sent credentials to that origin during the run — so a payment provider's telemetry beacon passes while a Supabase, Firebase or API Gateway backend stays blocked. Third-party writes are listed with `thirdParty: true`, a refused request names its origin, and an `--allow-write` glob can be origin-qualified ([#194](https://github.com/matt-cochran/jevitate/issues/194)).
- Find-out answering holds up with real models: an answer Jev vetoed stays rejected for the rest of the run (re-reporting the same answer on the same quotes is refused by code, Jev is still veto-only); the heading/title hint is given only for a single-item goal ("the title of this item"), never for a list or ordinal goal ("the first item") and never when the heading names the list; a claim is accepted when the answer text itself is contained in its grounded quote, however the claim is worded; and table cell breaks are kept, so a cell is no longer merged into its neighbour ([#229](https://github.com/matt-cochran/jevitate/issues/229)).
- A bare, lowercase, syntactically valid CSS selector (`visible:body`, `textIncludes:main h1|Welcome`, `visible:ul > li`) is accepted as a descriptor; any other bare descriptor is refused with a hint naming `css=`, `label=`, `testId=`, `role=` and `text=`, never guessed at. A failing `valueEquals` shows the value it read ([#213](https://github.com/matt-cochran/jevitate/issues/213)).

### Authenticated apps and secrets

- `--secret-field '<descriptor>=env:VAR'` binds a login or signup field to an environment variable so code types the secret into it (the model only sees `«secret:VAR»`; `--secret` still only redacts), and `--totp` computes a 6-digit code locally from a base32 seed for MFA/TOTP signup and login goals — the seed never reaches a model or disk ([#72](https://github.com/matt-cochran/jevitate/issues/72), [#106](https://github.com/matt-cochran/jevitate/pull/106)).
- `explore --storage-state` starts a session already authenticated as a deterministic login pre-step ([#62](https://github.com/matt-cochran/jevitate/pull/62)).
- Registered secrets are now scrubbed from Recording labels, route URLs, paths, intent and goal text — with a per-run canary test proving the run stays clean across label, goal, sensitive URL params and revealed password fields ([#58](https://github.com/matt-cochran/jevitate/pull/58)).
- Declared read-only invariant probes can now authenticate from the run's own session (a bearer token from localStorage, or a `--secret-field` binding), and authored Journeys now bake their `--success` assertion in automatically at authoring time, with `journey run`, `load run` and MCP `run_journey` all gaining `--storage-state`/`metadata.requiresAuth` so an authenticated Journey can actually start ([#118](https://github.com/matt-cochran/jevitate/issues/118), [#135](https://github.com/matt-cochran/jevitate/issues/135)).
- A lost `--storage-state` session (silently redirected to `/login`) is now detected instead of exploring logged out and reporting `clean`, and `--save-storage-state <file>` writes the session back after a run, for apps that rotate refresh tokens ([#82](https://github.com/matt-cochran/jevitate/issues/82), [#106](https://github.com/matt-cochran/jevitate/pull/106)).
- `--save-storage-state` now writes the session even when a run crashes or is killed, falling back to the last state captured while still logged in and never overwriting a good file with a logged-out one ([#159](https://github.com/matt-cochran/jevitate/issues/159)).
- Queued missions can run authenticated: `~/.jevitate/targets.json` (or `mission target add|update --storage-state/--save-storage-state/--secret-field`) declares a storage state, a rotating write-back and env-sourced secret fields per origin, never an MCP argument ([#175](https://github.com/matt-cochran/jevitate/issues/175)).
- A fixture step can use `${secretField.VAR}` in its body or headers to log in to an app that keeps its token in memory; the value is refused in a URL and never recorded ([#166](https://github.com/matt-cochran/jevitate/issues/166)).
- `jevitate check` now runs Journey items from the target's storage state and fixtures, and a suite target can declare `secretFields` and `fixtures` for its goals ([#170](https://github.com/matt-cochran/jevitate/issues/170)).
- A probe-only observer actor reads its `authFrom.localStorage` token from its storageState file, so it no longer fails with "auth token unavailable" ([#173](https://github.com/matt-cochran/jevitate/issues/173)).
- Concurrent and sequential runs now get per-run isolation so they no longer share one tenant and open each other's created resources ([#99](https://github.com/matt-cochran/jevitate/issues/99), [#107](https://github.com/matt-cochran/jevitate/pull/107)).
- `--secret env:VAR` reads a redaction value from an environment variable, so it never appears in the process list or shell history; an unset variable is refused by name and no value is ever echoed. A literal `--secret` still works but prints a warning ([#195](https://github.com/matt-cochran/jevitate/issues/195)).

### Adversarial missions

- Adversarial missions now open forms behind a modal trigger and type into password fields, so signup and API-key forms actually get submitted, and a leaked browser-pool context on cleanup is fixed ([#64](https://github.com/matt-cochran/jevitate/issues/64), [#69](https://github.com/matt-cochran/jevitate/pull/69)).
- Adversarial missions no longer crash when a clicked control is replaced or detached mid-check, now pair each field with its own form/container instead of a sibling form's submit, stay type-safe on number inputs instead of repeatedly typing text into them, and cover chat composers as well as conventional forms ([#76](https://github.com/matt-cochran/jevitate/issues/76), [#77](https://github.com/matt-cochran/jevitate/issues/77), [#106](https://github.com/matt-cochran/jevitate/pull/106), [#121](https://github.com/matt-cochran/jevitate/issues/121)).
- Missions no longer click session-ending (Sign out), destructive (Delete, Revoke, Rotate) or paid (Buy, Run simulation, Generate, Send invite) controls by default — `--deny` adds a pattern and `--allow-destructive` opts back in ([#116](https://github.com/matt-cochran/jevitate/issues/116)).
- The paid-control classifier reads only short, verb-led button and link labels, so a chat question card or an option answer that merely mentions "pay" or "upgrade" is no longer refused, and a refused control is not offered again ([#168](https://github.com/matt-cochran/jevitate/issues/168)).
- A submit blocked by the browser's own form validation is recorded as "blocked by validation" instead of counted as submitted, so a run whose only submits were blocked is `inconclusive`, not `clean` ([#155](https://github.com/matt-cochran/jevitate/issues/155)).
- Adversarial strategies no longer target a visually hidden skip link ([#161](https://github.com/matt-cochran/jevitate/issues/161)).
- Adversarial runs record a submit that stays disabled once per disabled streak instead of once per episode, and never re-plan a form whose submit the run blacklisted ([#188](https://github.com/matt-cochran/jevitate/issues/188)).
- A disclosure that reveals a form (a modal trigger, a user menu) is followed in the same turn by the strategy's form episode, a submit that could not be attempted records why (`forms.blockedBy`: validation, disabled or denied), disclosures that showed no form are never reopened, content ranks before chrome, and with `exercise-controls` in the run a strategy with nothing to do exercises an unexercised control instead of reporting "no applicable action" ([#193](https://github.com/matt-cochran/jevitate/issues/193)).
- Hangs are checked only on in-scope pages (adversarial and coverage/exploratory); a hang on a departure page is an advisory note on the departure, never a finding ([#193](https://github.com/matt-cochran/jevitate/issues/193)).
- When every target control is refused by the safety policy, the run stops at once with the new stop `targets-refused` (`inconclusive`), reports `coverage.controls.refused`, and names the refused controls and the flags that permit them (`--allow-destructive`, removing a `--deny`, or `--paid`/`--deny` to reclassify) ([#209](https://github.com/matt-cochran/jevitate/issues/209)).

### Coverage, exploratory and feature missions

- Coverage and exploratory missions are now scoped to the start URL's route by default instead of roaming the whole app and burning budget on global chrome (nav bars, a hidden "Skip to content" link); `--scope app` or `--route` widens it back out ([#75](https://github.com/matt-cochran/jevitate/issues/75), [#89](https://github.com/matt-cochran/jevitate/issues/89), [#106](https://github.com/matt-cochran/jevitate/pull/106), [#107](https://github.com/matt-cochran/jevitate/pull/107)).
- `--feature` missions now require actually exercising the named capability to report `clean`; touching nothing but header chrome now reports `inconclusive` with an `insufficient-coverage` failure instead of a false `clean` ([#78](https://github.com/matt-cochran/jevitate/issues/78), [#106](https://github.com/matt-cochran/jevitate/pull/106)).
- Frontier/coverage missions no longer idle for 10+ minutes after an out-of-scope departure (e.g. clicking "Sign out" or "Home"), and "exploratory" and "coverage" strategies are no longer conflated with each other's budget ([#114](https://github.com/matt-cochran/jevitate/issues/114), [#115](https://github.com/matt-cochran/jevitate/issues/115)).
- Coverage and `--feature` missions exercise a toggle pair (Collapse/Expand, Show/Hide) once in each direction instead of oscillating on it ([#160](https://github.com/matt-cochran/jevitate/issues/160)).
- A control refused by the safety policy or `--deny` never enters the feature/coverage frontier: it is refused once at enqueue time, before any reset, and never costs an action ([#186](https://github.com/matt-cochran/jevitate/issues/186)).
- A reset whose seed loaded but whose path replay is slow or fails drops that one frontier item as stale instead of ending the run `scope-unreachable` ([#183](https://github.com/matt-cochran/jevitate/issues/183)).
- Feature missions report `usage` (zero calls, `priceSource: ["no model call"]`) instead of omitting it ([#188](https://github.com/matt-cochran/jevitate/issues/188)).
- `--feature` is scoped to the start URL's route by default (`<path>`, `<path>/`, `<path>/**`), the same default coverage/exploratory, adversarial and suite items use; `--route` globs replace it. The result and human output name the scope and its source (`route` or `start-url`), and a start URL no scope can be derived from is refused (exit 64) ([#224](https://github.com/matt-cochran/jevitate/issues/224)).
- Each frontier ending has one name: a frontier that emptied without proving anything (its actions timed out, or it exercised only global navigation or mostly failing controls) is `insufficient-coverage` as both `outcome` and `failure.kind` (`inconclusive`), and `exhausted` means the frontier was fully covered. Links in the page body count as coverage; only chrome links (`<nav>`/`<header>`/`<footer>`, or links repeated across pages) count as global navigation, and the shortfall message says how to reach `clean` ([#203](https://github.com/matt-cochran/jevitate/issues/203), [#209](https://github.com/matt-cochran/jevitate/issues/209)).
- A feature run whose every exercised control was unrelated to the feature (all `relevance=0`) is `inconclusive` (`insufficient-coverage`), and the result adds `coverage.relevantActionsExercised` and `coverage.featureWords` ([#209](https://github.com/matt-cochran/jevitate/issues/209)).
- Exploratory runs name their files `exploratory-*` (they were `coverage-*`); MCP result ids accept the new stem ([#213](https://github.com/matt-cochran/jevitate/issues/213)).
- A coverage click that timed out is retried once before it counts as a failed action, and the click timeout (default 5 s) can be raised with `JEVITATE_CLICK_TIMEOUT_MS` for a slow app or a loaded host ([#213](https://github.com/matt-cochran/jevitate/issues/213)).

### Invariants, oracles and signals

- App-declared invariants (DOM state, captured network, read-only probes run before/after each action) are now a first-class dispatch input and hard-signal defect source via `--invariants <file>` ([#86](https://github.com/matt-cochran/jevitate/issues/86), [#107](https://github.com/matt-cochran/jevitate/pull/107)).
- The hang oracle now dedupes by the offending DOM element rather than by route, so one global progressbar no longer files a separate "hang" per route visited ([#87](https://github.com/matt-cochran/jevitate/issues/87), [#107](https://github.com/matt-cochran/jevitate/pull/107)).
- The console-error oracle now correlates with the actual HTTP response status, so a 4xx-originated app log is no longer double-filed as its own defect ([#88](https://github.com/matt-cochran/jevitate/issues/88), [#107](https://github.com/matt-cochran/jevitate/pull/107)).
- Dynamic routes (`/decisions/<id>`, `/decisions/candidate-<uuid>`) are now templated so duplicate instances of the same route are no longer treated as distinct findings ([#95](https://github.com/matt-cochran/jevitate/issues/95), [#107](https://github.com/matt-cochran/jevitate/pull/107)).
- The repeat-guard and duplicate-write signal are now RPC-aware: gRPC-web/Connect read calls (`Get*`/`List*`) are no longer misclassified as duplicate writes, `--read-rpc <glob>` marks POST-based read RPCs, the guard is value-aware so only true repeats are flagged, and `--job-wait-ms` keeps waiting while the page shows a job in progress ([#92](https://github.com/matt-cochran/jevitate/issues/92), [#96](https://github.com/matt-cochran/jevitate/issues/96), [#107](https://github.com/matt-cochran/jevitate/pull/107), [#110](https://github.com/matt-cochran/jevitate/issues/110)).
- `number` reads in a `dom` observable handle a Unicode minus and ranges: `number: { "index": n }` picks one number and `number: "all"` reads them all as a list ([#156](https://github.com/matt-cochran/jevitate/issues/156)).
- `settle` re-polls only a violated `require`; an unknown result (an absent observable) is reported at once instead of stalling the action for the whole window ([#151](https://github.com/matt-cochran/jevitate/issues/151)).
- An invariant's `when.op` (and `capture.*.after.op`) with an unknown op name such as `navigate` is refused when the file loads, instead of silently never firing ([#176](https://github.com/matt-cochran/jevitate/issues/176)).
- A page settles only after a quiet window that starts at the action, and timers the action scheduled are awaited, so a deferred effect is attributed to the action that caused it ([#152](https://github.com/matt-cochran/jevitate/issues/152)).
- The hang oracle tells legitimate long-running work (a streaming response, a page showing acknowledged progress) from a hang, and hang replays wait for a lazily rendered target instead of calling it missing ([#153](https://github.com/matt-cochran/jevitate/issues/153), [#164](https://github.com/matt-cochran/jevitate/issues/164)).
- `--hang-replays 0` skips the replays and reports the hang unconfirmed instead of failing mid-run ([#154](https://github.com/matt-cochran/jevitate/issues/154)).
- `signal-inert-control` no longer flags a link whose href already resolves to the current URL (ignoring hash/trailing slash) or that carries `aria-current` ([#127](https://github.com/matt-cochran/jevitate/issues/127)).
- An unreachable start URL (`net::ERR_*`, refused connection, a timeout before any response) is now always attributed to configuration and ends the mission `inconclusive` — never `crashed`, never misattributed to Jevitate or the app under test, and no issue is auto-drafted from it ([#128](https://github.com/matt-cochran/jevitate/issues/128)).
- `never: { response: { url, status } }` (`status` an exact code or a class such as `"4xx"`) declares an app response the mission's own traffic must never produce, checked in every mission type with each matching request as evidence (method, redacted URL, status and the step it happened in) ([#195](https://github.com/matt-cochran/jevitate/issues/195), [#212](https://github.com/matt-cochran/jevitate/issues/212)).
- `jevitate invariants validate <files…>` checks invariant files with the real loader and no browser: errors give the exact path, an invalid file exits 1 and an unreadable one exits 64 ([#195](https://github.com/matt-cochran/jevitate/issues/195), [#218](https://github.com/matt-cochran/jevitate/issues/218)).
- Stopping a `cmd:` log source at the end of a run is no longer reported as the source failing; a source that exits on its own before the mission ends still is ([#199](https://github.com/matt-cochran/jevitate/issues/199)).
- Suite files and `invariants validate` report every problem at once, not only the first; an unknown HTTP method or a cross-origin `never.response` URL is refused, and a missing env ref names its `$.targets[…]` path ([#213](https://github.com/matt-cochran/jevitate/issues/213)).

### Usability review

- UX findings are now backed by an independent quality grader with a cross-app calibration harness, grounding findings in specifics rather than generic semantic-rubric heuristics ([#66](https://github.com/matt-cochran/jevitate/pull/66)).
- A false positive that flagged user-authored content as system jargon is fixed, and offline `jevitate ux` review no longer misses a dead end the live run caught ([#85](https://github.com/matt-cochran/jevitate/issues/85), [#106](https://github.com/matt-cochran/jevitate/pull/106)).
- Conversational reply-wait is now adaptive instead of a fixed 60-second default that missed slow replies, and usability mode always writes screenshots and a Recording ([#93](https://github.com/matt-cochran/jevitate/issues/93), [#98](https://github.com/matt-cochran/jevitate/issues/98), [#106](https://github.com/matt-cochran/jevitate/pull/106)).
- Usability findings now use transcript, network and error signals to surface real defects a run hit (a hung job, a duplicate paid launch, an exposed UUID, an inert control, a repeated error reply, a duplicate create, a 5xx submit, a URL mismatch) that a rubric-only grader used to miss ([#97](https://github.com/matt-cochran/jevitate/issues/97), [#107](https://github.com/matt-cochran/jevitate/pull/107)).
- Every quality grade is now shown by default instead of being silently suppressed, since the grader is still uncalibrated ([#133](https://github.com/matt-cochran/jevitate/issues/133)).
- The occlusion pre-check now catches controls behind an overlay, including sr-only inputs ([#90](https://github.com/matt-cochran/jevitate/issues/90)).
- Usability findings must now be grounded in observed journey friction, are ranked by impact with one finding per friction point, and offline `jevitate ux` review now reproduces exactly what the live run found via a saved evidence sidecar ([#131](https://github.com/matt-cochran/jevitate/issues/131), [#132](https://github.com/matt-cochran/jevitate/issues/132), [#134](https://github.com/matt-cochran/jevitate/issues/134)).
- A usability run stopped by a hang is now mapped through the hang/intermittent/inconclusive rule instead of always reporting `missionOutcome: clean` ([#126](https://github.com/matt-cochran/jevitate/issues/126)).
- UX quality findings are marked a **preview**. Findings on the same route and control are merged into one (the other rubric items kept as `contributing`, with their citations), and at most 5 are reported per page, highest-confidence first (`--max-findings-per-page`, `JEVITATE_UX_MAX_FINDINGS_PER_PAGE`, `ux.maxFindingsPerPage` in `config.json`, or a suite item's `maxFindingsPerPage`); the overflow is counted in `suppressed`, never dropped silently ([#198](https://github.com/matt-cochran/jevitate/issues/198)).
- A review whose job was never completed is `inconclusive` with `failure.kind: "job-incomplete"`; it used to be `clean` ([#209](https://github.com/matt-cochran/jevitate/issues/209)).
- Done-recognition is grounded in code: a sign-in-only goal is recognised as done when the run left the login page, no credential field or sign-in control remains and signed-in chrome shows (`sign-in-signals`) ([#188](https://github.com/matt-cochran/jevitate/issues/188)); a completed save is recognised when the submit's writes all finished 2xx, a success notice shows and the page still displays each saved value (`save-signals`; a 4xx/5xx save never counts, even when the page says "Saved"), and the judgment now sees non-secret form-field values ([#225](https://github.com/matt-cochran/jevitate/issues/225)).
- `--strategy usability` honours `--success` (and a usability suite mission's `success`/`successWhen`/`allowVacuousChecks`) as an independent completion check with a goal run's semantics: the vacuous rules apply, the verdict folds like a goal's (`goalOutcome`, `checks`, `checkWarnings`), a failed check is `defects-found` with `failure.kind: "success-check-failed"`, and the run stops as soon as the job is judged done but the check failed. It used to be silently ignored ([#225](https://github.com/matt-cochran/jevitate/issues/225)).
- Usability results also report `finalUrl`, `decisions` and `actions` ([#190](https://github.com/matt-cochran/jevitate/pull/190)).
- A usability job whose completion code verified (its `--success` checks held, or save or sign-in signals proved `done`) stays `clean` on a starved host; only an ending the model alone judged is downgraded to `degraded-environment` ([#213](https://github.com/matt-cochran/jevitate/issues/213)).

### Verification, regression, CI and reporting

- `verify-fix` now replays a defect 3 times by default (previously effectively once) and reports a new `intermittent` verdict when a signal fires on some but not all replays, instead of misreporting a flaky defect as `fixed` after one lucky replay ([#74](https://github.com/matt-cochran/jevitate/issues/74), [#106](https://github.com/matt-cochran/jevitate/pull/106)).
- `regression capture` no longer treats a passing step as a "reproduces" oracle, closing a vacuous-artifact gap ([#81](https://github.com/matt-cochran/jevitate/issues/81), [#106](https://github.com/matt-cochran/jevitate/pull/106)).
- `regression capture` now accepts invariant-defect and network/response-check (`responseStatus`, `reloadThen`) failures as valid oracles, and never uses the engine's own "repeated side effect refused" guard as the oracle, since that guard can never fail on replay; it also takes `--storage-state`, and the new `jevitate regression run <id>` replays a committed regression and reports `reproduces` or `fixed` ([#119](https://github.com/matt-cochran/jevitate/issues/119), [#129](https://github.com/matt-cochran/jevitate/issues/129)).
- `jevitate check --suite <file>` runs promoted Journeys, invariant sets, goals, missions and `verify-fix` re-checks under a total action/time/usd budget as a CI gate — fails closed on budget overrun, exits non-zero on any hard failure, and writes JUnit XML and SARIF (for GitHub Actions PR annotation) alongside the JSON envelope ([#137](https://github.com/matt-cochran/jevitate/issues/137)).
- `jevitate diff <runA> <runB>` (or `--baseline`) classifies findings as new, resolved, still-present or flaky between two runs on the same target, matched by stable keys (rubric/signal, route template, control); `jevitate baseline tag` names a baseline, and `check --changed-routes` runs only the Journeys and goals a change touches ([#138](https://github.com/matt-cochran/jevitate/issues/138)).
- `diff` and `report --baseline` compare a finding only across runs that could have observed it (same mode, target and mission settings, and the finding's route reached), so realistic run sets no longer come out mostly flaky; `report --dir` also reads subdirectories ([#171](https://github.com/matt-cochran/jevitate/issues/171)).
- `jevitate report --target <t> [--since <run>]` produces one consolidated, deduped defect list (markdown and JSON) across every mode (goal, adversarial, usability, invariants, verify-fix) for a target and build, each with occurrence counts, evidence references and its verify-fix reproduction command ([#139](https://github.com/matt-cochran/jevitate/issues/139)).
- `regression run` envelopes carry `engine`, and route templating folds dotted hex ids (`ws.1697a048…`) into `:id` ([#188](https://github.com/matt-cochran/jevitate/issues/188)).
- `check` suites accept `viewport`/`device` (per target, overridable per item) and the `exploratory` mission strategy.
- A finding ledger: `jevitate ledger add <result> <fp> [--ticket X]` stores what `verify-fix` needs to re-check a finding in the committed regressions store (`.jevitate/regressions/ledger/<fp>.json`), `jevitate ledger verify [fp...]` re-checks every entry (or the named ones) and `jevitate ledger list` shows them. `jevitate verify-fix <fp>` now works from a fingerprint alone, replaying the ledger entry when no `--result` is given. Entries hold only redacted repro material — never a storage state or its path — and `ledger add --secret` refuses an entry that would contain a named value ([#195](https://github.com/matt-cochran/jevitate/issues/195)).
- `ledger verify` that matched no entries says nothing was verified and exits 2, never a vacuous 0 ([#227](https://github.com/matt-cochran/jevitate/issues/227)).
- `check` suite items take every `explore` option (targets set the defaults, items override them; a test fails when a flag is left out), can set their own storage state, fan personas out per item, and reference secrets only as `env:` refs ([#195](https://github.com/matt-cochran/jevitate/issues/195)).
- `check` refuses up front (exit 64) a suite item whose start URL is off its target's allowlist, and a `verifyFix` item whose fingerprint is not in its result; both used to fail at runtime as an errored item (exit 2) ([#218](https://github.com/matt-cochran/jevitate/issues/218)).
- Findings extraction (`report`, `diff`, baselines, `check`) reads a result's strategy from its content (`strategy`, or content markers for older results), never from its filename, so a renamed baseline result gives the right verdict ([#211](https://github.com/matt-cochran/jevitate/issues/211)).
- A bare `jevitate report` or `diff` is scoped to the current project (the directory holding the repo's `.jevitate/`, else the git root, else the working directory): its own `.jevitate/logs/` plus every run recorded for it in a per-user run index, `~/.jevitate/run-index.jsonl` (one `{project, path}` line per persisted result, so runs written to an `--out` dir are included; `JEVITATE_RUN_INDEX=off` stops recording). An unknown `--target` is refused (exit 64) with the known targets listed ([#213](https://github.com/matt-cochran/jevitate/issues/213)).
- `check` gives `verify-fix` items unique JUnit names and refuses duplicates ([#213](https://github.com/matt-cochran/jevitate/issues/213)).

### Multi-run, personas and actors

- `--repeat N --min-agreement k` runs a mission N times sequentially, one after another in a fresh context, keeps only findings seen in at least k runs, reports each finding's stability rate, and labels under-threshold findings `flaky` ([#141](https://github.com/matt-cochran/jevitate/issues/141)).
- `--persona <name=storageState>` (repeatable, or a `--personas` file) runs the same mission once per persona/role and diffs outcomes, requests, response statuses and visible controls per persona to catch RBAC defects — a role able to do what it shouldn't, or blocked from what it should have ([#143](https://github.com/matt-cochran/jevitate/issues/143)).
- Missions can now run with two or more actors, each with its own browser context and `--storage-state`; a mission can declare cross-actor invariants so that after actor A creates or touches a resource, code checks from actor B's own session that it is not listed, not openable by URL, and returns NotFound to a read probe — a violation is a hard-signal defect ([#147](https://github.com/matt-cochran/jevitate/issues/147)).
- Multi-run results carry the canonical `missionOutcome`, `goalOutcome` and `engine`, votes are counted over canonical outcomes, and the summary shows a canonical headline, per-run reasons, the persona diff and the `ANSWER` line ([#226](https://github.com/matt-cochran/jevitate/issues/226)).
- A broken or unfinished run makes a multi-run result `inconclusive`, never `intermittent`, and SIGINT/SIGTERM still write the multi-run summary and exit 130/143 ([#220](https://github.com/matt-cochran/jevitate/issues/220)).
- A persona whose `--storage-state` session was not honoured is flagged (`sessionLost`, a `WARNING` line), and a persona whose runs never observed the app is left out of the persona diff (`diff.notCompared`) instead of reading as an access difference ([#213](https://github.com/matt-cochran/jevitate/issues/213), [#230](https://github.com/matt-cochran/jevitate/issues/230)).

### MCP and coding agents

- `queue_exploration`'s returned `missionId` can now actually be read back by `get_mission_result` (previously ids didn't round-trip and only `adversarial`/`coverage` id stems were accepted), and `jevitate mission run` now drains the queue end to end, with `--api-origin` on mission targets for an app's separate API origin ([#112](https://github.com/matt-cochran/jevitate/issues/112), [#117](https://github.com/matt-cochran/jevitate/issues/117)).
- The MCP tool surface gained `get_mission_result` (read back a queued mission's outcome: `status` is the result's canonical `missionOutcome`, and a goal run's own `succeeded`/`failed`/`exhausted`/`blocked` comes back beside it as `goalOutcome`) and `verify_fix` (replay a defect's repro over MCP) ([#217](https://github.com/matt-cochran/jevitate/issues/217)).

### Operations (build identity, usage/cost, kill switch, backend logs, fixtures, budgets, emulation)

- Every result, Recording, envelope and version-reporting surface now stamps the same `{version, commit, builtAt}` build identity, so evidence can be tied to an exact build — previously `--version` stayed `0.1.0` across rebuilds and the MCP/health surfaces hard-coded `0.0.0` ([#83](https://github.com/matt-cochran/jevitate/issues/83), [#112](https://github.com/matt-cochran/jevitate/issues/112)).
- A run killed by SIGTERM or an external timeout now always flushes a report instead of sometimes writing nothing, and the kill switch is scoped so it flushes every armed mission, not just one ([#94](https://github.com/matt-cochran/jevitate/issues/94)).
- A killed-run result now carries the real step count, correct `transcriptPath`, `engine` and usage-so-far instead of a wrong "after 0 steps", a dangling path, or an empty envelope ([#120](https://github.com/matt-cochran/jevitate/issues/120)).
- The run envelope now reports `usage` (Jev judgments, generation tokens and calls) on `--real` runs, previously reported as nothing even though both were billed ([#100](https://github.com/matt-cochran/jevitate/issues/100), [#107](https://github.com/matt-cochran/jevitate/pull/107)).
- `usage.usd` split into `{jevUsd, generationUsd, totalUsd}` with a labelled price source and a `priced` flag, since Jev-judgment cost (roughly 2.4 calls per usability step) was previously excluded from the reported total entirely ([#136](https://github.com/matt-cochran/jevitate/issues/136)).
- `usage` now reports the full run cost by default: Jev judgments are priced from a dated built-in price table (or your configured prices), `priced` is `partial` when any call could not be priced, a `<run>.usage.json` lists every call, and totals appear in multi-run, `check` and `report` results with a one-line cost summary on stderr ([#163](https://github.com/matt-cochran/jevitate/issues/163)).
- Jevitate can now tail operator-declared backend log sources (`docker:<container>`, `file:<path>`, `cmd:<streaming command>`) during a mission via `--log-source`, correlate lines to the step executing at the time, attach matched lines as evidence, and optionally promote matching lines to a hard-signal `server-log` defect via `--log-defect` ([#142](https://github.com/matt-cochran/jevitate/issues/142)).
- Backend log correlation reads .NET console, .NET JSON and Serilog lines and Rust `tracing` JSON messages, names the last step's server error in a `blocked`/`exhausted`/`inconclusive` reason, templates a server-log defect's route, and gains `--log-ignore` for known-noise lines and `--log-quiet-ok` for a source that is legitimately silent ([#165](https://github.com/matt-cochran/jevitate/issues/165), [#169](https://github.com/matt-cochran/jevitate/issues/169)).
- Declarative `fixtures.json` or operator-declared `--before`/`--after` hooks now seed and reset app state before a mission and before every verify-fix/hang replay, so exploratory runs stop polluting shared data that breaks later runs' reproducibility ([#140](https://github.com/matt-cochran/jevitate/issues/140), [#144](https://github.com/matt-cochran/jevitate/issues/144)).
- Live Jev judgment is now wired to the real `@typesafe-ai/sdk` v0.6 API for `--real` runs, `jevitate` now reads the credentials file `init`/`ai setup` actually write, `--browser-executable`/`--browser-channel`/`--browser-arg` let a run launch a different Chromium binary/channel or extra switches, and browser contexts now come from a shared, admission-controlled browser pool instead of one throwaway profile dir per run ([#57](https://github.com/matt-cochran/jevitate/pull/57), [#59](https://github.com/matt-cochran/jevitate/pull/59), [#60](https://github.com/matt-cochran/jevitate/pull/60), [#61](https://github.com/matt-cochran/jevitate/pull/61)).
- `--viewport <W>x<H>` and `--device "<name>"` (mutually exclusive) emulate a mobile or custom viewport on `explore` (every strategy, including usability), `journey run`, `load run`, `source run`, `verify-fix`, `regression capture`/`regression run` and MCP `queue_exploration`; the emulation used is recorded on the Recording so a defect found at 375px is replayed at the same size, not silently "verified fixed" at desktop width. A built-in horizontal-overflow hard signal (pure DOM geometry, never a model judgment), attributed to the offending element, runs by default whenever the emulated viewport is narrower than 1024px (or always via `--check-overflow`), as a defect in coverage/exploratory/adversarial runs and a signal finding in usability ([#149](https://github.com/matt-cochran/jevitate/issues/149)).
- A `budget` key in the same `--invariants` file can cap cumulative spend against an app-declared observable (e.g. a credits balance); crossing it stops the mission cleanly via `stop: "budget"` (folded into the `inconclusive` outcome, never `clean` and never `crashed`), with an optional pre-action guard that refuses an action whose estimated cost would cross what remains of the budget. Applies to every mission type, including adversarial and the usability review (which reads only the budget part of the file) ([#150](https://github.com/matt-cochran/jevitate/issues/150)).
- The goal and coverage `--json` envelopes and `result.json` carry the `budget` trajectory, a hang included ([#180](https://github.com/matt-cochran/jevitate/issues/180)).
- `--paid <pattern>` (and `safety.paid` in targets.json) declares an app's own paid controls: the budget guard sees them, hang replays never repeat them, and a goal that asks for one may still click it. A hang replay is also withheld when the run's own `sideEffects` show the step sending a write ([#181](https://github.com/matt-cochran/jevitate/issues/181)).
- `${setup.x}` binds into `--invariants` (probe paths, capture routes, `deniedAs.open`), origin-fixed; the `--url` origin refusal names the fix ([#187](https://github.com/matt-cochran/jevitate/issues/187)).
- A repo's own `.jevitate/` (created by `jevitate init` at the git root) holds Journeys, regressions, baselines and dated `logs/`; `~/.jevitate` keeps secrets and machine state. Its `.gitignore` keeps logs and any secret or machine-local file out of git, and `init` only ever adds missing lines.
- Run output is pruned: runs older than 14 days are deleted, but the newest 50 are always kept (`config.json` `logs.ttlDays`/`logs.keepLatest`; `jevitate logs prune`).
- Queued missions and `check` items now follow the operator's `targets.json` (safety, settle, hangs, log sources) exactly as CLI runs do; a queued invariants spec may not use `authFrom.secret`.
- A mission left `running` by a drain that died hard is recorded `failed` by the next drain, never re-run.
- The `--browser-*` launch flags are on every browser-opening command (`journey run`, `source run`, `load run`, `regression capture`/`run` added) and documented.
- Goal and usability results carry the crash report and intermittent-hang evidence, and a CI guard (`surface-wiring.test.ts`) fails when a surface drops a mission option or a result field without a stated reason.
- Site policies (`jevitate site policy set <origin>`) now govern Journey runs: human-like pacing, throttles, hourly/daily run budgets and quiet hours for `journey run`, `source run`, `check` and MCP `run_journey` (a refusal says when to retry); `load run` applies the pacing.
- Shared Journeys from a git submodule under `.jevitate/journeys/<shared>/` appear as `<shared>/<id>` on every Journey surface, including MCP.
- `site policy set` reports the origin the policy is stored under, not the page URL it was given ([#191](https://github.com/matt-cochran/jevitate/pull/191)).
- Runs are bounded: a page that stays alive but stops answering (frozen, starved or wedged renderer) is closed by a liveness watchdog after 60 s (`JEVITATE_PAGE_UNRESPONSIVE_MS`), so the run ends through its crash path with `failure.kind: "stalled"` and a reason instead of idling until killed; opening a browser context or page is bounded to 60 s (see [`docs/operations.md`](docs/operations.md#bounded-runs-the-page-watchdog)) ([#220](https://github.com/matt-cochran/jevitate/issues/220)).
- The kill switch is armed before the host sampler and browser launch in every runner, so a SIGTERM during a slow launch still writes a result; a killed run's partial result carries `strategy`, `target`, a canonical `inconclusive` and, for a goal run, `goalOutcome` ([#220](https://github.com/matt-cochran/jevitate/issues/220), [#226](https://github.com/matt-cochran/jevitate/issues/226)).
- The bare `jevitate` alias forwards SIGINT, SIGTERM and SIGHUP to the real CLI instead of orphaning it ([#220](https://github.com/matt-cochran/jevitate/issues/220)).
- Host-health attribution is stricter and clearer: driver event-loop lag counts as starvation only with corroborating load, the degraded reason is one sentence with the peak readings plus what the run would otherwise have ended as, and a degraded goal keeps its failed check's detail ([#213](https://github.com/matt-cochran/jevitate/issues/213)).

### Demo mode, Journey intent and evidence

- **Demo mode** ([#245](https://github.com/matt-cochran/jevitate/issues/245)). Runs stay headless by default, `check` and CI included. `--headed` (or `JEVITATE_HEADED=1`) opens a visible Chromium for every `explore` strategy, `journey run`, `verify-fix` and `regression capture|run`; `--slow-mo <ms>` slows each browser operation (250 ms with `--headed`); `--record-video [dir]` records each browser context, headless too, and lists the files as `videoPaths` (additive, `schemaVersion` 1) and as `VIDEO` lines in the summary. A headed explore run shows an on-page overlay that is invisible to jevitate's own perception (`--no-overlay` hides it). `--headed` without a display is refused (exit 64, suggesting `--record-video`). `check` suite items take `headed`, `slowMo`, `recordVideo` and `overlay`; queued missions stay headless.
- **Journeys carry intent** ([#246](https://github.com/matt-cochran/jevitate/issues/246)). Optional, additive fields: `metadata.goal`, `persona`, `role`, `preconditions`, `successCriteria`, `parameters` (`secret: true` redacts a value), and per-step `objective` and `expectedResult`. `jevitate journey annotate <id> --real|--fake-ai` replays the Journey, reads the redacted page before and after each step and drafts the missing intent into `.jevitate/journeys/.drafts/<id>.annotations.json`; `--approve` shows the diff and writes it, and refuses a draft made against a Journey that has since changed (`E_JOURNEY_ANNOTATIONS_STALE`, exit 64). `init` ignores unapproved drafts.
- **Environments** ([#247](https://github.com/matt-cochran/jevitate/issues/247)). Journeys are environment-free: name the places your app runs in a committed `.jevitate/environments.json` and pick one with `--env <name>` or `--base-url <origin>` on `journey run|annotate`, `regression run` and `load run` (or `env`/`baseUrl` on a `check` Journey item). The environment is the run's allowlist; a step on another origin or an unknown `--env` is refused with exit 64 before a browser opens. The file never holds secrets or sessions; those stay in `~/.jevitate/targets.json` (now also `personas`).
- **`journey demo`** ([#248](https://github.com/matt-cochran/jevitate/issues/248)). Replays a Journey with its goal as a title card and each step's objective as the caption, and writes a WebM video (`--video`), `.vtt` subtitles beside it and a Markdown guide (`--guide`) with one screenshot per step (overlay hidden). A Journey that no longer replays fails with a non-zero exit, so CI catches a stale demo.
- **`demo "<aspect>"`** ([#249](https://github.com/matt-cochran/jevitate/issues/249)). From a one-line request on a named non-production environment: explore, minimize the path (verified by replay), author a Journey, annotate it and render a DRAFT demo. `demo approve <id>` is the single human approval: it renders the final demo, applies the annotations and promotes the Journey. An environment flagged `production: true` is refused.
- **Defect evidence** ([#250](https://github.com/matt-cochran/jevitate/issues/250)). `--evidence-video` replays each defect's minimal repro with captions, marks the failing step with the actual signal, and records a clip plus before/at screenshots as `defects[].evidence`, linked from the summary, issue drafts, `report`, and `check` JUnit and SARIF. `verify-fix --record-video` writes a before/after clip pair. Registered secrets are masked in the pixels of every clip and screenshot by a display-only layer (the page is never mutated); a capture whose mask cannot be applied is skipped and the reason recorded.
- **Screenshot capture** ([#251](https://github.com/matt-cochran/jevitate/issues/251)). `--screenshots [screens|steps|<dir>]` on every `explore` strategy, `journey run|annotate|demo` and `verify-fix` writes one masked screenshot per distinct screen (or per step) plus an `index.md`, listed as `screenshotPaths`. Suite items take `screenshots`.

### CLI and MCP parity

- `jevitate inbox list|show|command|queue-retrieval|queue-action|health`, `jevitate mission queue` and `jevitate mission result` mirror the MCP inbox and mission tools ([#254](https://github.com/matt-cochran/jevitate/issues/254)). `inbox command` keeps `get_command`'s burn-after-read rule: unread human input needs `--reveal`, which consumes and prints it. `approve_action` and `cancel_command` stay human-only, in `jevitate ui`; `inbox approve|cancel` refuse the same way MCP does.
- Every CLI command is reachable over MCP, and every MCP tool from the CLI, or sits on a documented exclusion list (`mcp`, `ui`, `init`, `ai setup`, `record`, trusting a source), enforced by a parity test in both directions ([#255](https://github.com/matt-cochran/jevitate/issues/255)). New tools include `annotate_journey`, `demo_journey`, `create_demo` and `approve_demo`; `run_journey`, `verify_fix` and `queue_exploration` take the CLI's run options (`env`, `baseUrl`, `headed`, `recordVideo`, `screenshots`, `evidenceVideo`, `persona`, viewport/device, and more) with the same strict validation and confined paths. The allowlist/forbidden-tool boundary is unchanged: raw browser tools stay forbidden.

### Documentation and examples

- Fixed the `/docs/ux` 404 on jevitate.com, the "UX Review" vs "Usability" naming inconsistency, a mode-count mismatch, documented the default viewport, and documented the full flags-per-strategy table, including that `--app-class` is not the persona ([#102](https://github.com/matt-cochran/jevitate/issues/102), [#103](https://github.com/matt-cochran/jevitate/issues/103), [#107](https://github.com/matt-cochran/jevitate/pull/107)).
- Documented the report schema and confidence semantics (`noul-false`, `coverage`, `budgetTruncated`, `clean`, screen attribution), and added a dev-server/SPA (Vite + direct API origin) recipe plus a guide for running against a stateful app ([#104](https://github.com/matt-cochran/jevitate/issues/104), [#105](https://github.com/matt-cochran/jevitate/issues/105), [#107](https://github.com/matt-cochran/jevitate/pull/107)).
- Fixed general skill/README drift (mission-target flags, `get_site_health`, the source manifest, invariants `when.op`, `--allow` semantics, `profile`, `diff`/postdoc input error, `journey promote`, `record`, `usd`), and documented that `--headless` plus SIGINT still saves the take ([#124](https://github.com/matt-cochran/jevitate/issues/124)).
- `docs/cli.md` is generated from the command tree (`pnpm docs:cli`) and a test fails when it is stale; the README and docs link to it instead of duplicating flag lists ([#252](https://github.com/matt-cochran/jevitate/issues/252)).
- The README is rewritten around the discover → verify → regression loop, and the reference docs have moved from the README into `docs/`.
- Added a no-key demo (`pnpm --filter @jevitate/example-site demo`) that walks the whole loop against a planted-bug profile form in the example app, documented in `docs/demo.md`.
- Documented what was previously only in `--help`/source comments: the persona matrix's diff shape (`diff.controlsOnlyIn`/`requestsOnlyIn`/`rbacCandidates`) and `--repeat`'s on-disk layout (`multi-run.result.json`, `complete`, per-run dirs) in `docs/multi-run.md`; the multi-actor `capture`/`deniedAs` schema in `docs/invariants.md`; the default gRPC-web/Connect read-verb list with a Connect example in `docs/safety.md`; `jevPriceSource` in `docs/operations.md`; the fixtures shell-hook stdin/stdout contract and a worked SPA example (localStorage token, API behind the dev proxy) in `docs/fixtures.md`; and pointer lines to each in `jevitate-explore/SKILL.md` ([#177](https://github.com/matt-cochran/jevitate/issues/177)).
- The exit-code table and the `--json`/human output rule are documented once, in `docs/outcomes.md` "Exit codes"; `docs/results.md` documents the result schema and its deprecated aliases; `maxFindingsPerPage` naming, the report key derived from the fingerprint and keeping storage states under `~/.jevitate/` are documented, and the adversarial `step-budget` (`--max-decisions`) and `action-budget` (`--max-actions`) stops are no longer swapped ([#210](https://github.com/matt-cochran/jevitate/issues/210), [#212](https://github.com/matt-cochran/jevitate/issues/212), [#217](https://github.com/matt-cochran/jevitate/issues/217)).
- `docs/safety.md` explains the app state runs leave behind and how to reset it between runs, `docs/demo.md` shows the real human output of the demo (verified end to end), and `docs/success-checks.md` documents the descriptor rule ([#213](https://github.com/matt-cochran/jevitate/issues/213), [#230](https://github.com/matt-cochran/jevitate/issues/230)).

### Behaviour changes

- Coverage and exploratory missions default to the start URL's route instead of the whole app; widen scope with `--scope app` or `--route <glob>` ([#75](https://github.com/matt-cochran/jevitate/issues/75), [#89](https://github.com/matt-cochran/jevitate/issues/89), [#114](https://github.com/matt-cochran/jevitate/issues/114), [#115](https://github.com/matt-cochran/jevitate/issues/115)).
- Missions refuse session-ending, destructive and paid controls by default; `--deny <pattern>` adds a control to refuse and `--allow-destructive` opts back in ([#116](https://github.com/matt-cochran/jevitate/issues/116)).
- `textIncludes` (in `--success` and `reloadThen`) is now case-insensitive, comparing against rendered `innerText` rather than the raw DOM value, since a page can visually uppercase text via CSS `text-transform` ([#113](https://github.com/matt-cochran/jevitate/issues/113)).
- `jevitate ux` and `explore --strategy usability` now show every quality grade by default (the grader is still uncalibrated, #133); filter with `--show`.
- MCP `get_mission_result` returns a goal run's canonical `missionOutcome` as `status` (`succeeded` → `clean`; `failed`/`exhausted`/`blocked` → `defects-found`), keeping the goal's own word as `goalOutcome` ([#217](https://github.com/matt-cochran/jevitate/issues/217)).
- `~/.jevitate/targets.json` per-target configuration is new in this release (it did not exist in 0.1.0): every declared field (`settle`, `hangs`, `timing`, `safety`, `fixtures`, `logSources`, `logDefect`, `allowLogCmd`, `logQuietOk`, `logIgnore`, `storageState`, `saveStorageState`, `secretFields`) is type-checked, and a malformed value throws before any browser opens rather than being silently ignored.
- `defects-found` is now also reported for a declared-invariant violation or a server-log defect (when `--log-source`/`--log-defect` are declared), not only for the mission's own hard signals.
- New `outcome`/`stop` values: `stalled` (coverage/exploratory/`--feature`, no step completed within `--stall-timeout`), `budget` (a declared spend budget was crossed, folds into `inconclusive`), and `configuration` attribution (an unreachable start URL or a failed fixture setup ends the run `inconclusive`, never `crashed`, and never auto-drafts an issue).
- Exit codes: `verify-fix` gains `intermittent` (exit 4) for a defect that reproduced on some but not all replays, and `--replays` now defaults to 3 instead of 1.
- `usage.usd` (a single number) is replaced by `usage.{jevUsd, generationUsd, totalUsd, priced}`; `usd` is kept as a deprecated alias for `totalUsd` when at least one component is known.
- `--feature` missions only report `clean` when at least one in-scope action was exercised; otherwise `inconclusive` with an `insufficient-coverage` failure.
- Find-out goals (no `--success`) are read-only by default; pass `--allow-writes` (or `safety.allowWrites` in `targets.json`) for a find-out goal that must change the app ([#158](https://github.com/matt-cochran/jevitate/issues/158)).
- `--success-when held` requires a check to change from not holding to holding (one already true on the start page fails as vacuous), and the run stops as soon as every check has held ([#174](https://github.com/matt-cochran/jevitate/issues/174)).
- Hang replays (and `verify-fix` of a hang) no longer re-send a paid or destructive write; such a hang is `inconclusive` unless you pass `--hang-replay-writes` (or `safety.hangReplayWrites`) — `--allow-destructive` does not lift it ([#153](https://github.com/matt-cochran/jevitate/issues/153)).
- `usage` pricing has a default Jev price from a dated table and a `partial` status when any call is unpriced; a `check` `maxUsd` budget fails closed on a `partial` total ([#163](https://github.com/matt-cochran/jevitate/issues/163)).
- With `--log-defect`, a declared log source that opened but delivered no lines makes an otherwise-clean run `inconclusive` unless it is named in `--log-quiet-ok` ([#169](https://github.com/matt-cochran/jevitate/issues/169)).
- An unknown `when.op` (or `capture.*.after.op`) in an invariants file is refused instead of accepted and never fired ([#176](https://github.com/matt-cochran/jevitate/issues/176)).
- A form submit blocked by browser validation is no longer counted as submitted, so the form-submit coverage requirement can now fail where it passed before ([#155](https://github.com/matt-cochran/jevitate/issues/155)).
- The paid-control classifier now skips chat answers and option cards (radio, checkbox, option) unless the label names a charge, so a run may now click controls it used to refuse ([#168](https://github.com/matt-cochran/jevitate/issues/168)).
- Route templating now collapses a literal-prefix-plus-id-like-suffix segment (e.g. `demo-bet-1`) to a whole `:id` segment, changing the route-template grouping key used for dedup across coverage reports, findings and the hang oracle.
- A goal result's `missionOutcome` is the canonical verdict (`clean`/`defects-found`/…), no longer `succeeded`/`failed`/`exhausted`/`blocked`; the goal's own ending is in `goalOutcome` ([#217](https://github.com/matt-cochran/jevitate/issues/217)).
- A goal whose model said `done` but whose success check then failed is `failed` (it was `blocked`); a goal whose only failing checks are vacuous is `inconclusive` (exit 2), not `blocked` (exit 1) ([#209](https://github.com/matt-cochran/jevitate/issues/209)).
- A success check that already held before the first action fails as vacuous in every mode, not only `--success-when held`, and network checks ignore requests sent before the first action ([#202](https://github.com/matt-cochran/jevitate/issues/202)).
- A goal whose success checks held but whose run hit an app 5xx is `defects-found` (exit 1), and goal, feature, coverage/exploratory and usability runs now list `http-5xx` defects ([#208](https://github.com/matt-cochran/jevitate/issues/208)).
- A coverage or exploratory run whose only finding is a Jev-flagged state is `clean` (or `inconclusive`), not `defects-found` with exit 1 ([#214](https://github.com/matt-cochran/jevitate/issues/214)).
- A usability review whose job was never completed is `inconclusive`, not `clean`; a feature run whose exercised controls were all unrelated to the feature is `inconclusive`; an adversarial run whose every target control is refused stops at once as `targets-refused` ([#209](https://github.com/matt-cochran/jevitate/issues/209)).
- The coverage/exploratory ending `insufficient-exploration` (#203) is renamed `insufficient-coverage`, the same name as its `failure.kind`, and `exhausted` now only means the frontier was fully covered ([#209](https://github.com/matt-cochran/jevitate/issues/209)).
- A run most of whose steps ran on a starved host is `inconclusive` (`degraded-environment`) instead of `clean`, and a hang, click timeout or no-progress stop met while starved is advisory ([#203](https://github.com/matt-cochran/jevitate/issues/203)).
- Usage and input errors exit `64` on every command (they were `1` on `explore` and `2` on `check`/`ledger`/`verify-fix`, among others); other refusals that exited `1` now exit `2` ([#210](https://github.com/matt-cochran/jevitate/issues/210), [#218](https://github.com/matt-cochran/jevitate/issues/218)).
- Without `--json`, commands print a human summary and refusals print `error <CODE>: <message>` on stderr; a goal or coverage run used to print the bare result JSON, and adversarial, feature and usability runs the envelope ([#210](https://github.com/matt-cochran/jevitate/issues/210), [#218](https://github.com/matt-cochran/jevitate/issues/218), [#227](https://github.com/matt-cochran/jevitate/issues/227)).
- `--success`, `--success-when` and `--allow-vacuous-checks` are refused (64) with `--strategy coverage|exploratory|adversarial` and `--feature`, and are honoured (no longer ignored) by `--strategy usability` ([#225](https://github.com/matt-cochran/jevitate/issues/225)).
- `--feature` without `--route` is scoped to the start URL's route; before, it had no route in scope, so every control it clicked counted as out of scope and the run was always `inconclusive` ([#224](https://github.com/matt-cochran/jevitate/issues/224)).
- Multi-run voting counts canonical outcomes, and a broken or unfinished run makes the result `inconclusive`, never `intermittent` ([#220](https://github.com/matt-cochran/jevitate/issues/220), [#226](https://github.com/matt-cochran/jevitate/issues/226)).
- `ledger verify` with no matching entries exits 2 ([#227](https://github.com/matt-cochran/jevitate/issues/227)).
- UX findings on the same route and control are merged, and at most 5 are reported per page by default; the rest are counted in `suppressed` ([#198](https://github.com/matt-cochran/jevitate/issues/198)).
- Exploratory runs write `exploratory-<stamp>.*` files, no longer `coverage-<stamp>.*` ([#213](https://github.com/matt-cochran/jevitate/issues/213)).
- These now exit 64 instead of running or exiting 0: an unknown `--strategy`, `--real` together with `--fake-ai` (real used to win silently), an invalid URL, `profile status <unknown>` (was a "missing" exit 0), `regression capture --id` over an existing regression without `--force`, `regression capture` of a hard-signal finding, and an unknown `report --target` ([#213](https://github.com/matt-cochran/jevitate/issues/213), [#230](https://github.com/matt-cochran/jevitate/issues/230)).
- A `check` goal item run with fake AI no longer gates as FAILED on a goal-only ending; it is `inconclusive` ("use --real to gate on this goal"). Hard signals still gate ([#213](https://github.com/matt-cochran/jevitate/issues/213)).
- A bare `jevitate report` or `diff` (no `--dir`) reads only the current project's runs: its own `.jevitate/logs/` and the runs recorded for it in `~/.jevitate/run-index.jsonl` ([#213](https://github.com/matt-cochran/jevitate/issues/213)).
- An unreachable target fails in seconds (a TCP pre-flight) instead of after navigation timeouts, and a frozen app ends `inconclusive` / `target-unresponsive` instead of a hang or no-progress finding ([#213](https://github.com/matt-cochran/jevitate/issues/213), [#230](https://github.com/matt-cochran/jevitate/issues/230)).
- `jevitate init` never prompts without a TTY; it completes, warns which keys are missing, and exits 0 ([#230](https://github.com/matt-cochran/jevitate/issues/230)).
- Bare lowercase CSS selectors are accepted as `--success` descriptors; any other bare descriptor is refused with a hint ([#213](https://github.com/matt-cochran/jevitate/issues/213)).

### Upgrade notes

- No config file migration is required beyond the items below. Credentials, config, `targets.json` and the rest of `~/.jevitate` work unchanged.
- Run output now goes to `.jevitate/logs/<date>/` (in the repo, else `~/.jevitate/logs/`), and Journeys, regressions and baselines default to the repo's `.jevitate/` once `jevitate init` has created it (outside a repo they stay in `~/.jevitate`). Results under the 0.1.0 `~/.jevitate/recordings` and `~/.jevitate/ux-reports` are still found by `get_mission_result`, `verify_fix` and `report`. To use existing Journeys or regressions inside a repo, move them from `~/.jevitate/journeys` and `~/.jevitate/regressions` into its `.jevitate/`, or pass `--dir`.
- If a script parses `usage.usd` as a single number, switch it to `usage.totalUsd` (checking `usage.priced` before treating it as complete); `usage.usd` still exists as a deprecated alias but only when at least one component was priced.
- If CI treats any non-zero `verify-fix` exit code as "still reproduces", add explicit handling for exit code 4 (`intermittent`) — a flaky defect is neither `fixed` nor a confirmed `still-reproduces`.
- If a suite relies on a coverage or exploratory mission wandering the whole app, add `--scope app` (or `--route <glob>`) — the new default scopes to the start URL's route.
- If a mission relied on clicking a session-ending, destructive or paid control (Sign out, Delete, Revoke, Rotate, Buy, Send invite) to reach its goal, pass `--allow-destructive` (any `--deny` patterns you add still apply).
- If a `--feature` mission was passing while only touching global chrome, it will now report `inconclusive` with `insufficient-coverage` — point `--route`/the goal at the actual capability.
- If tooling keyed off `crashed` for an unreachable start URL, update it to check `attribution: "configuration"` under `inconclusive` instead.
- If tooling grouped findings or coverage by route template, expect `demo-bet-1`-style literal-prefix-plus-id routes to now group under a collapsed `:id` template key.
- **Parse `--json`, not the default output.** Human output is now the default for `explore` (every strategy), `verify-fix`, `ledger`, `check`, `regression` and `baseline`, and refusals go to stderr as `error <CODE>: <message>`. A script that parsed stdout without `--json` must add `--json` (the `{v, ok, data | error}` envelope is unchanged) or read the persisted `<stem>.result.json`.
- **Exit codes.** Treat `64` as "bad invocation, nothing ran" — it used to be `1` on `explore` (indistinguishable from defects found) and `2` on `check`/`ledger`/`verify-fix`. `1` still means defects, `2` still means inconclusive. See `docs/outcomes.md` "Exit codes".
- **Goal results.** `missionOutcome` is now canonical for goal runs too: compare it with `clean`/`defects-found`/…, or read `goalOutcome` for `succeeded`/`failed`/`exhausted`/`blocked`. Expect the new `failed` where a model's `done` did not pass its checks (it was `blocked`), and `inconclusive` (exit 2) where the only failing checks were vacuous. A goal suite that relied on a check already true on the start page must make it prove a change, or pass `--allow-vacuous-checks` / `allowVacuousChecks`.
- **Coverage naming.** Replace `insufficient-exploration` (and an `exhausted` that meant "ran out without proving anything") with `insufficient-coverage`, which is both the frontier `outcome` and `failure.kind`.
- **`--success` on non-goal strategies** is now refused with exit 64 on `--strategy coverage|exploratory|adversarial` and `--feature`; remove it. On `--strategy usability` it is now enforced, so a failing check makes the run `defects-found`.
- **`--feature` scope.** A feature mission without `--route` now runs on the start URL's route (it used to end `inconclusive` with nothing in scope), so its outcome can change to `clean` or `defects-found`; add `--route <glob>` if the feature lives on other pages.
- **Multi-run.** `--repeat` votes on canonical outcomes (`clean`/`defects-found`/…), so compare a multi-run result's `missionOutcome` with those, and read `goalOutcome` for a goal's own word.
- **`ledger verify`** with no matching entries exits 2 (nothing was verified); a CI step that ran it on an empty ledger and expected 0 must skip it or add an entry.
- **Deprecated fields.** Move off `serverLogDefects` (use `defects` with `kind: "server-log"`), `recordingPath` (use `recordingPaths[0]`), `usage.usd` (`usage.totalUsd`) and `usage.jevPriceSource` (`usage.priceSource`); they are removed in the next minor.
- **Save-storage-state paths.** A `--save-storage-state` (or `saveStorageState`) path inside the repo's `.jevitate/` is now refused; keep session files under `~/.jevitate/` or elsewhere outside the repo.
- **Names.** Profile names and regression ids must be one safe path segment (1–128 letters, digits, `.`, `_` or `-`, starting with a letter or digit); others are refused with `E_INVALID_NAME` (exit 64).
- **Exploratory file names.** Tooling that globbed `coverage-*` for exploratory results must also match `exploratory-*` (the result's `strategy` field says which ran).
- **More exit-64 refusals.** Scripts that passed both `--real` and `--fake-ai`, an unknown `--strategy`, or `profile status` for a profile that may not exist (it exited 0) now get exit 64. A `regression capture --id` that re-captures an existing regression needs `--force`, and a hard-signal finding (http-5xx, hang, server-log, …) is refused by `regression capture`: add it to the ledger (`jevitate ledger add`) and re-check it with `verify-fix`.
- **Fake-AI CI suites.** A `check` goal item under fake AI that ended `failed`/`exhausted`/`blocked` is now `inconclusive`, not a gating FAILED; gate goals with `--real`.
- **`report` / `diff` scope.** A bare `report`/`diff` now sees only the current project's `.jevitate/logs/` and the runs recorded for it in `~/.jevitate/run-index.jsonl`, so results written elsewhere before this release (for example to an `--out` dir) are not included; pass `--dir` (or `--target`) to read them. `JEVITATE_RUN_INDEX=off` stops recording runs in the index.
- **Slow apps and loaded hosts.** If coverage clicks time out on a slow app, raise `JEVITATE_CLICK_TIMEOUT_MS` (default 5000); see [`docs/operations.md`](docs/operations.md#bounded-runs-the-page-watchdog).
- **Non-interactive `init`.** `jevitate init` in CI or a pipe no longer waits for input; configure keys with `jevitate ai setup <feature>` or the environment.

### Security

- The MCP tool allowlist (`ALLOWED_TOOLS` in `packages/mcp-facade/src/tools.ts`) grew by two domain tools this release — `get_mission_result` and `verify_fix` — both read/replay-only over the same served surface; the forbidden raw-browser-tool boundary is unchanged.
- Secrets never reach the model: route URLs, Recording labels, paths, the goal text and intent are now scrubbed through a shared redaction seam, with a per-run canary proving the run stays clean, including URL-encoded and query/fragment-embedded secrets ([#58](https://github.com/matt-cochran/jevitate/pull/58)).
- Bound secrets (`--secret-field`) are typed into a matching field by code — the model sees only a `«secret:VAR»` placeholder — and TOTP seeds (`--totp`) are computed locally per RFC 6238 and never reach a model or disk.
- Server-log evidence attached to a step, defect or `blocked` reason is redacted before being stored or shown.
- Storage-state contents (cookies, origin storage) written by `--save-storage-state` are never logged; the file is written with mode `0600`.
- A profile name or regression id can no longer escape its directory: `profile create ../x` used to create a directory outside the profiles folder. Names (`profile create|status`, `regression capture --id`, `regression run <id>`) must be one safe path segment, checked by one shared helper that also verifies the resolved path stays inside its root ([#221](https://github.com/matt-cochran/jevitate/issues/221)).
- A registered secret that appears on the page (for example a sample value the adversarial run typed that equals the secret) is redacted from visible text, control names and values, scope, hrefs and headings before anything reaches a model, a typed secret is recorded as `{redacted, length}`, and a find-out answer that rests on the secret is withheld — instead of the run crashing on a rejected Recording ([#219](https://github.com/matt-cochran/jevitate/issues/219)).
- Read-only runs no longer let a write through to a third-party origin that received API credentials during the run, so an app's own backend on another origin (Supabase, Firebase, API Gateway) stays blocked ([#194](https://github.com/matt-cochran/jevitate/issues/194)).
- Every storage-state writer (CLI, suites, `targets.json`, the final write and the kill snapshot) refuses a path inside the repo's `.jevitate/`, which is partly committed; ledger entries never hold a storage state or its path ([#195](https://github.com/matt-cochran/jevitate/issues/195)).
- A queued mission's invariants may not use `authFrom.secret` (refused at enqueue), so an MCP request can never choose which of the operator's environment variables is sent to the target ([#190](https://github.com/matt-cochran/jevitate/pull/190)).
- The bare `jevitate` alias forwards SIGINT/SIGTERM/SIGHUP, so killing it no longer leaves an orphaned CLI process running against the target ([#220](https://github.com/matt-cochran/jevitate/issues/220)).

## [0.1.0] – 2026-09-22

Initial release of `@jevitate/cli`.

- Record a demonstrated browser flow into a deterministic Recording (`jevitate record`), and parameterize/promote it into a replayable, typed **Journey** — the Screenplay pattern over Playwright.
- Goal-directed exploration (`jevitate explore --strategy goal`): drive to a natural-language goal, judged by an independent, code-decided success check, never the model's own say-so.
- Feature, exploratory, coverage and adversarial exploration strategies for capability-scoped path discovery, state-coverage exploration and bounded misuse with a trusted hard-signal defect oracle.
- Usability/UX-review mode (`explore --strategy usability`, `jevitate ux`): ranked, cited usability findings against Nielsen and cognitive-science heuristics, advisory only.
- Regression capture: turn a reproducible failure into a minimized, deterministic, replayable regression artifact.
- Self-healing Journey repair under a `fail-closed | hybrid | full` policy — never auto-healing a write or an irreversible action.
- Load testing of a Journey against an authorized origin, with concurrency, iterations and a seeded RNG.
- An MCP stdio server (`jevitate mcp`) exposing only an allowlisted, safe tool surface, with a forbidden-tool boundary enforced in `@jevitate/mcp-facade`.
- Distributed Journey sources (`jevitate source add/pull/trust/run`) with an explicit trust/run gate — a source Journey only runs after being pinned to its content hash.
- Secrets handback: `--secret` redacts sensitive values out of every model call and artifact.
- `jevitate init` installs agent skills and registers the `jevitate mcp` server in detected coding-agent harnesses.
- A local HITL approval dashboard (`jevitate ui`) with inbox MCP tools for queued retrievals, actions and commands.
- Distributed via `@jevitate/cli` (with a bare `jevitate` alias), a single esbuild-bundled package with `playwright`/`better-sqlite3` kept as native external dependencies.
