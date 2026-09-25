# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to
[Semantic Versioning](https://semver.org/) (pre-1.0: a minor version bump may include
behaviour changes).

## [0.2.0] – unreleased

A backlog sweep across every mission type: goal runs give honest reasons and detect success
mid-run; adversarial, coverage/exploratory and feature missions stop wandering and stop
under-reporting; declared invariants, backend-log correlation and route-template fixes cut
false positives and false negatives; usability findings are grounded in what a run actually
hit; verify-fix, regression capture and a new `check`/`diff`/`report` trio harden CI use;
multi-run voting, persona matrices and multi-actor missions add reliability and RBAC coverage;
and build identity, usage/cost accounting, mission fixtures and the kill switch land end to end.

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
- `type` can now edit inside `contenteditable` regions (placing the caret, selecting a range) instead of always replacing the whole element's content, and new `--success`/invariant assertion kinds (`style`, `inViewport`, `box`, `overlaps`, `attr`, `flashed`) read computed style, viewport visibility and transient visual state for editors, heat maps and minimaps ([#148](https://github.com/matt-cochran/jevitate/issues/148)).

### Authenticated apps and secrets

- `--secret-field '<descriptor>=env:VAR'` binds a login or signup field to an environment variable so code types the secret into it (the model only sees `«secret:VAR»`; `--secret` still only redacts), and `--totp` computes a 6-digit code locally from a base32 seed for MFA/TOTP signup and login goals — the seed never reaches a model or disk ([#72](https://github.com/matt-cochran/jevitate/issues/72), [#106](https://github.com/matt-cochran/jevitate/pull/106)).
- `explore --storage-state` starts a session already authenticated as a deterministic login pre-step ([#62](https://github.com/matt-cochran/jevitate/pull/62)).
- Registered secrets are now scrubbed from Recording labels, route URLs, paths, intent and goal text — with a per-run canary test proving the run stays clean across label, goal, sensitive URL params and revealed password fields ([#58](https://github.com/matt-cochran/jevitate/pull/58)).
- Declared read-only invariant probes can now authenticate from the run's own session (a bearer token from localStorage, or a `--secret-field` binding), and authored Journeys now bake their `--success` assertion in automatically at authoring time, with `journey run`, `load run` and MCP `run_journey` all gaining `--storage-state`/`metadata.requiresAuth` so an authenticated Journey can actually start ([#118](https://github.com/matt-cochran/jevitate/issues/118), [#135](https://github.com/matt-cochran/jevitate/issues/135)).
- A lost `--storage-state` session (silently redirected to `/login`) is now detected instead of exploring logged out and reporting `clean`, and `--save-storage-state <file>` writes the session back after a run, for apps that rotate refresh tokens ([#82](https://github.com/matt-cochran/jevitate/issues/82), [#106](https://github.com/matt-cochran/jevitate/pull/106)).
- Concurrent and sequential runs now get per-run isolation so they no longer share one tenant and open each other's created resources ([#99](https://github.com/matt-cochran/jevitate/issues/99), [#107](https://github.com/matt-cochran/jevitate/pull/107)).

### Adversarial missions

- Adversarial missions now open forms behind a modal trigger and type into password fields, so signup and API-key forms actually get submitted, and a leaked browser-pool context on cleanup is fixed ([#64](https://github.com/matt-cochran/jevitate/issues/64), [#69](https://github.com/matt-cochran/jevitate/pull/69)).
- Adversarial missions no longer crash when a clicked control is replaced or detached mid-check, now pair each field with its own form/container instead of a sibling form's submit, stay type-safe on number inputs instead of repeatedly typing text into them, and cover chat composers as well as conventional forms ([#76](https://github.com/matt-cochran/jevitate/issues/76), [#77](https://github.com/matt-cochran/jevitate/issues/77), [#106](https://github.com/matt-cochran/jevitate/pull/106), [#121](https://github.com/matt-cochran/jevitate/issues/121)).
- Missions no longer click session-ending (Sign out), destructive (Delete, Revoke, Rotate) or paid (Buy, Run simulation, Generate, Send invite) controls by default — `--deny` adds a pattern and `--allow-destructive` opts back in ([#116](https://github.com/matt-cochran/jevitate/issues/116)).

### Coverage, exploratory and feature missions

- Coverage and exploratory missions are now scoped to the start URL's route by default instead of roaming the whole app and burning budget on global chrome (nav bars, a hidden "Skip to content" link); `--scope app` or `--route` widens it back out ([#75](https://github.com/matt-cochran/jevitate/issues/75), [#89](https://github.com/matt-cochran/jevitate/issues/89), [#106](https://github.com/matt-cochran/jevitate/pull/106), [#107](https://github.com/matt-cochran/jevitate/pull/107)).
- `--feature` missions now require actually exercising the named capability to report `clean`; touching nothing but header chrome now reports `inconclusive` with an `insufficient-coverage` failure instead of a false `clean` ([#78](https://github.com/matt-cochran/jevitate/issues/78), [#106](https://github.com/matt-cochran/jevitate/pull/106)).
- Frontier/coverage missions no longer idle for 10+ minutes after an out-of-scope departure (e.g. clicking "Sign out" or "Home"), and "exploratory" and "coverage" strategies are no longer conflated with each other's budget ([#114](https://github.com/matt-cochran/jevitate/issues/114), [#115](https://github.com/matt-cochran/jevitate/issues/115)).

### Invariants, oracles and signals

- App-declared invariants (DOM state, captured network, read-only probes run before/after each action) are now a first-class dispatch input and hard-signal defect source via `--invariants <file>` ([#86](https://github.com/matt-cochran/jevitate/issues/86), [#107](https://github.com/matt-cochran/jevitate/pull/107)).
- The hang oracle now dedupes by the offending DOM element rather than by route, so one global progressbar no longer files a separate "hang" per route visited ([#87](https://github.com/matt-cochran/jevitate/issues/87), [#107](https://github.com/matt-cochran/jevitate/pull/107)).
- The console-error oracle now correlates with the actual HTTP response status, so a 4xx-originated app log is no longer double-filed as its own defect ([#88](https://github.com/matt-cochran/jevitate/issues/88), [#107](https://github.com/matt-cochran/jevitate/pull/107)).
- Dynamic routes (`/decisions/<id>`, `/decisions/candidate-<uuid>`) are now templated so duplicate instances of the same route are no longer treated as distinct findings ([#95](https://github.com/matt-cochran/jevitate/issues/95), [#107](https://github.com/matt-cochran/jevitate/pull/107)).
- The repeat-guard and duplicate-write signal are now RPC-aware: gRPC-web/Connect read calls (`Get*`/`List*`) are no longer misclassified as duplicate writes, `--read-rpc <glob>` marks POST-based read RPCs, the guard is value-aware so only true repeats are flagged, and `--job-wait-ms` keeps waiting while the page shows a job in progress ([#92](https://github.com/matt-cochran/jevitate/issues/92), [#96](https://github.com/matt-cochran/jevitate/issues/96), [#107](https://github.com/matt-cochran/jevitate/pull/107), [#110](https://github.com/matt-cochran/jevitate/issues/110)).
- `signal-inert-control` no longer flags a link whose href already resolves to the current URL (ignoring hash/trailing slash) or that carries `aria-current` ([#127](https://github.com/matt-cochran/jevitate/issues/127)).
- An unreachable start URL (`net::ERR_*`, refused connection, a timeout before any response) is now always attributed to configuration and ends the mission `inconclusive` — never `crashed`, never misattributed to Jevitate or the app under test, and no issue is auto-drafted from it ([#128](https://github.com/matt-cochran/jevitate/issues/128)).

### Usability review

- UX findings are now backed by an independent quality grader with a cross-app calibration harness, grounding findings in specifics rather than generic semantic-rubric heuristics ([#66](https://github.com/matt-cochran/jevitate/pull/66)).
- A false positive that flagged user-authored content as system jargon is fixed, and offline `jevitate ux` review no longer misses a dead end the live run caught ([#85](https://github.com/matt-cochran/jevitate/issues/85), [#106](https://github.com/matt-cochran/jevitate/pull/106)).
- Conversational reply-wait is now adaptive instead of a fixed 60-second default that missed slow replies, and usability mode always writes screenshots and a Recording ([#93](https://github.com/matt-cochran/jevitate/issues/93), [#98](https://github.com/matt-cochran/jevitate/issues/98), [#106](https://github.com/matt-cochran/jevitate/pull/106)).
- Usability findings now use transcript, network and error signals to surface real defects a run hit (a hung job, a duplicate paid launch, an exposed UUID, an inert control, a repeated error reply, a duplicate create, a 5xx submit, a URL mismatch) that a rubric-only grader used to miss ([#97](https://github.com/matt-cochran/jevitate/issues/97), [#107](https://github.com/matt-cochran/jevitate/pull/107)).
- Every quality grade is now shown by default instead of being silently suppressed, since the grader is still uncalibrated ([#133](https://github.com/matt-cochran/jevitate/issues/133)).
- The occlusion pre-check now catches controls behind an overlay, including sr-only inputs ([#90](https://github.com/matt-cochran/jevitate/issues/90)).
- Usability findings must now be grounded in observed journey friction, are ranked by impact with one finding per friction point, and offline `jevitate ux` review now reproduces exactly what the live run found via a saved evidence sidecar ([#131](https://github.com/matt-cochran/jevitate/issues/131), [#132](https://github.com/matt-cochran/jevitate/issues/132), [#134](https://github.com/matt-cochran/jevitate/issues/134)).
- A usability run stopped by a hang is now mapped through the hang/intermittent/inconclusive rule instead of always reporting `missionOutcome: clean` ([#126](https://github.com/matt-cochran/jevitate/issues/126)).

### Verification, regression, CI and reporting

- `verify-fix` now replays a defect 3 times by default (previously effectively once) and reports a new `intermittent` verdict when a signal fires on some but not all replays, instead of misreporting a flaky defect as `fixed` after one lucky replay ([#74](https://github.com/matt-cochran/jevitate/issues/74), [#106](https://github.com/matt-cochran/jevitate/pull/106)).
- `regression capture` no longer treats a passing step as a "reproduces" oracle, closing a vacuous-artifact gap ([#81](https://github.com/matt-cochran/jevitate/issues/81), [#106](https://github.com/matt-cochran/jevitate/pull/106)).
- `regression capture` now accepts invariant-defect and network/response-check (`responseStatus`, `reloadThen`) failures as valid oracles, and never uses the engine's own "repeated side effect refused" guard as the oracle, since that guard can never fail on replay; it also takes `--storage-state`, and the new `jevitate regression run <id>` replays a committed regression and reports `reproduces` or `fixed` ([#119](https://github.com/matt-cochran/jevitate/issues/119), [#129](https://github.com/matt-cochran/jevitate/issues/129)).
- `jevitate check --suite <file>` runs promoted Journeys, invariant sets, goals, missions and `verify-fix` re-checks under a total action/time/usd budget as a CI gate — fails closed on budget overrun, exits non-zero on any hard failure, and writes JUnit XML and SARIF (for GitHub Actions PR annotation) alongside the JSON envelope ([#137](https://github.com/matt-cochran/jevitate/issues/137)).
- `jevitate diff <runA> <runB>` (or `--baseline`) classifies findings as new, resolved, still-present or flaky between two runs on the same target, matched by stable keys (rubric/signal, route template, control); `jevitate baseline tag` names a baseline, and `check --changed-routes` runs only the Journeys and goals a change touches ([#138](https://github.com/matt-cochran/jevitate/issues/138)).
- `jevitate report --target <t> [--since <run>]` produces one consolidated, deduped defect list (markdown and JSON) across every mode (goal, adversarial, usability, invariants, verify-fix) for a target and build, each with occurrence counts, evidence references and its verify-fix reproduction command ([#139](https://github.com/matt-cochran/jevitate/issues/139)).

### Multi-run, personas and actors

- `--repeat N --min-agreement k` runs a mission N times sequentially, one after another in a fresh context, keeps only findings seen in at least k runs, reports each finding's stability rate, and labels under-threshold findings `flaky` ([#141](https://github.com/matt-cochran/jevitate/issues/141)).
- `--persona <name=storageState>` (repeatable, or a `--personas` file) runs the same mission once per persona/role and diffs outcomes, requests, response statuses and visible controls per persona to catch RBAC defects — a role able to do what it shouldn't, or blocked from what it should have ([#143](https://github.com/matt-cochran/jevitate/issues/143)).
- Missions can now run with two or more actors, each with its own browser context and `--storage-state`; a mission can declare cross-actor invariants so that after actor A creates or touches a resource, code checks from actor B's own session that it is not listed, not openable by URL, and returns NotFound to a read probe — a violation is a hard-signal defect ([#147](https://github.com/matt-cochran/jevitate/issues/147)).

### MCP and coding agents

- `queue_exploration`'s returned `missionId` can now actually be read back by `get_mission_result` (previously ids didn't round-trip and only `adversarial`/`coverage` id stems were accepted), and `jevitate mission run` now drains the queue end to end, with `--api-origin` on mission targets for an app's separate API origin ([#112](https://github.com/matt-cochran/jevitate/issues/112), [#117](https://github.com/matt-cochran/jevitate/issues/117)).
- The MCP tool surface gained `get_mission_result` (read back a queued mission's outcome, folding a goal run's own `succeeded`/`exhausted`/`blocked` word into `clean`/`defects-found` as `goalOutcome`) and `verify_fix` (replay a defect's repro over MCP).

### Operations (build identity, usage/cost, kill switch, backend logs, fixtures, budgets, emulation)

- Every result, Recording, envelope and version-reporting surface now stamps the same `{version, commit, builtAt}` build identity, so evidence can be tied to an exact build — previously `--version` stayed `0.1.0` across rebuilds and the MCP/health surfaces hard-coded `0.0.0` ([#83](https://github.com/matt-cochran/jevitate/issues/83), [#112](https://github.com/matt-cochran/jevitate/issues/112)).
- A run killed by SIGTERM or an external timeout now always flushes a report instead of sometimes writing nothing, and the kill switch is scoped so it flushes every armed mission, not just one ([#94](https://github.com/matt-cochran/jevitate/issues/94)).
- A killed-run result now carries the real step count, correct `transcriptPath`, `engine` and usage-so-far instead of a wrong "after 0 steps", a dangling path, or an empty envelope ([#120](https://github.com/matt-cochran/jevitate/issues/120)).
- The run envelope now reports `usage` (Jev judgments, generation tokens and calls) on `--real` runs, previously reported as nothing even though both were billed ([#100](https://github.com/matt-cochran/jevitate/issues/100), [#107](https://github.com/matt-cochran/jevitate/pull/107)).
- `usage.usd` split into `{jevUsd, generationUsd, totalUsd}` with a labelled price source and a `priced` flag, since Jev-judgment cost (roughly 2.4 calls per usability step) was previously excluded from the reported total entirely ([#136](https://github.com/matt-cochran/jevitate/issues/136)).
- Jevitate can now tail operator-declared backend log sources (`docker:<container>`, `file:<path>`, `cmd:<streaming command>`) during a mission via `--log-source`, correlate lines to the step executing at the time, attach matched lines as evidence, and optionally promote matching lines to a hard-signal `server-log` defect via `--log-defect` ([#142](https://github.com/matt-cochran/jevitate/issues/142)).
- Declarative `fixtures.json` or operator-declared `--before`/`--after` hooks now seed and reset app state before a mission and before every verify-fix/hang replay, so exploratory runs stop polluting shared data that breaks later runs' reproducibility ([#140](https://github.com/matt-cochran/jevitate/issues/140), [#144](https://github.com/matt-cochran/jevitate/issues/144)).
- Live Jev judgment is now wired to the real `@typesafe-ai/sdk` v0.6 API for `--real` runs, `jevitate` now reads the credentials file `init`/`ai setup` actually write, `--browser-executable`/`--browser-channel`/`--browser-arg` let a run launch a different Chromium binary/channel or extra switches, and browser contexts now come from a shared, admission-controlled browser pool instead of one throwaway profile dir per run ([#57](https://github.com/matt-cochran/jevitate/pull/57), [#59](https://github.com/matt-cochran/jevitate/pull/59), [#60](https://github.com/matt-cochran/jevitate/pull/60), [#61](https://github.com/matt-cochran/jevitate/pull/61)).
- `--viewport <W>x<H>` and `--device "<name>"` (mutually exclusive) emulate a mobile or custom viewport on `explore` (every strategy, including usability), `journey run`, `load run`, `source run`, `verify-fix`, `regression capture`/`regression run` and MCP `queue_exploration`; the emulation used is recorded on the Recording so a defect found at 375px is replayed at the same size, not silently "verified fixed" at desktop width. A built-in horizontal-overflow hard signal (pure DOM geometry, never a model judgment), attributed to the offending element, runs by default whenever the emulated viewport is narrower than 1024px (or always via `--check-overflow`), as a defect in coverage/exploratory/adversarial runs and a signal finding in usability ([#149](https://github.com/matt-cochran/jevitate/issues/149)).
- A `budget` key in the same `--invariants` file can cap cumulative spend against an app-declared observable (e.g. a credits balance); crossing it stops the mission cleanly via `stop: "budget"` (folded into the `inconclusive` outcome, never `clean` and never `crashed`), with an optional pre-action guard that refuses an action whose estimated cost would cross what remains of the budget. Applies to every mission type, including adversarial and the usability review (which reads only the budget part of the file) ([#150](https://github.com/matt-cochran/jevitate/issues/150)).

### Documentation and examples

- Fixed the `/docs/ux` 404 on jevitate.com, the "UX Review" vs "Usability" naming inconsistency, a mode-count mismatch, documented the default viewport, and documented the full flags-per-strategy table, including that `--success` is silently ignored by `--strategy usability` and that `--app-class` is not the persona ([#102](https://github.com/matt-cochran/jevitate/issues/102), [#103](https://github.com/matt-cochran/jevitate/issues/103), [#107](https://github.com/matt-cochran/jevitate/pull/107)).
- Documented the report schema and confidence semantics (`noul-false`, `coverage`, `budgetTruncated`, `clean`, screen attribution), and added a dev-server/SPA (Vite + direct API origin) recipe plus a guide for running against a stateful app ([#104](https://github.com/matt-cochran/jevitate/issues/104), [#105](https://github.com/matt-cochran/jevitate/issues/105), [#107](https://github.com/matt-cochran/jevitate/pull/107)).
- Fixed general skill/README drift (mission-target flags, `get_site_health`, the source manifest, invariants `when.op`, `--allow` semantics, `profile`, `diff`/postdoc input error, `journey promote`, `record`, `usd`), and documented that `--headless` plus SIGINT still saves the take ([#124](https://github.com/matt-cochran/jevitate/issues/124)).
- The README is rewritten around the discover → verify → regression loop, and the reference docs have moved from the README into `docs/`.
- Added a no-key demo (`pnpm --filter @jevitate/example-site demo`) that walks the whole loop against a planted-bug profile form in the example app, documented in `docs/demo.md`.

### Behaviour changes

- Coverage and exploratory missions default to the start URL's route instead of the whole app; widen scope with `--scope app` or `--route <glob>` ([#75](https://github.com/matt-cochran/jevitate/issues/75), [#89](https://github.com/matt-cochran/jevitate/issues/89), [#114](https://github.com/matt-cochran/jevitate/issues/114), [#115](https://github.com/matt-cochran/jevitate/issues/115)).
- Missions refuse session-ending, destructive and paid controls by default; `--deny <pattern>` adds a control to refuse and `--allow-destructive` opts back in ([#116](https://github.com/matt-cochran/jevitate/issues/116)).
- `textIncludes` (in `--success` and `reloadThen`) is now case-insensitive, comparing against rendered `innerText` rather than the raw DOM value, since a page can visually uppercase text via CSS `text-transform` ([#113](https://github.com/matt-cochran/jevitate/issues/113)).
- `jevitate ux` and `explore --strategy usability` now show every quality grade by default (the grader is still uncalibrated, #133); filter with `--show`.
- MCP `get_mission_result` now folds a goal mission's own outcome word into the canonical `outcome` (`succeeded` → `clean`; `exhausted`/`blocked` → `defects-found`), keeping the goal's own word as `goalOutcome`.
- `~/.jevitate/targets.json` per-target configuration is new in this release (it did not exist in 0.1.0): every declared field (`settle`, `hangs`, `timing`, `safety`, `fixtures`, `logSources`, `logDefect`, `allowLogCmd`) is type-checked, and a malformed value throws before any browser opens rather than being silently ignored.
- `defects-found` is now also reported for a declared-invariant violation or a server-log defect (when `--log-source`/`--log-defect` are declared), not only for the mission's own hard signals.
- New `outcome`/`stop` values: `stalled` (coverage/exploratory/`--feature`, no step completed within `--stall-timeout`), `budget` (a declared spend budget was crossed, folds into `inconclusive`), and `configuration` attribution (an unreachable start URL or a failed fixture setup ends the run `inconclusive`, never `crashed`, and never auto-drafts an issue).
- Exit codes: `verify-fix` gains `intermittent` (exit 4) for a defect that reproduced on some but not all replays, and `--replays` now defaults to 3 instead of 1.
- `usage.usd` (a single number) is replaced by `usage.{jevUsd, generationUsd, totalUsd, priced}`; `usd` is kept as a deprecated alias for `totalUsd` when at least one component is known.
- `--feature` missions only report `clean` when at least one in-scope action was exercised; otherwise `inconclusive` with an `insufficient-coverage` failure.
- Route templating now collapses a literal-prefix-plus-id-like-suffix segment (e.g. `demo-bet-1`) to a whole `:id` segment, changing the route-template grouping key used for dedup across coverage reports, findings and the hang oracle.

### Upgrade notes

- No config file migration is required beyond the items below — a 0.1.0 `~/.jevitate` directory (recordings, journeys, regressions) works unchanged.
- If a script parses `usage.usd` as a single number, switch it to `usage.totalUsd` (checking `usage.priced` before treating it as complete); `usage.usd` still exists as a deprecated alias but only when at least one component was priced.
- If CI treats any non-zero `verify-fix` exit code as "still reproduces", add explicit handling for exit code 4 (`intermittent`) — a flaky defect is neither `fixed` nor a confirmed `still-reproduces`.
- If a suite relies on a coverage or exploratory mission wandering the whole app, add `--scope app` (or `--route <glob>`) — the new default scopes to the start URL's route.
- If a mission relied on clicking a session-ending, destructive or paid control (Sign out, Delete, Revoke, Rotate, Buy, Send invite) to reach its goal, pass `--allow-destructive` (any `--deny` patterns you add still apply).
- If a `--feature` mission was passing while only touching global chrome, it will now report `inconclusive` with `insufficient-coverage` — point `--route`/the goal at the actual capability.
- If tooling keyed off `crashed` for an unreachable start URL, update it to check `attribution: "configuration"` under `inconclusive` instead.
- If tooling grouped findings or coverage by route template, expect `demo-bet-1`-style literal-prefix-plus-id routes to now group under a collapsed `:id` template key.

### Security

- The MCP tool allowlist (`ALLOWED_TOOLS` in `packages/mcp-facade/src/tools.ts`) grew by two domain tools this release — `get_mission_result` and `verify_fix` — both read/replay-only over the same served surface; the forbidden raw-browser-tool boundary is unchanged.
- Secrets never reach the model: route URLs, Recording labels, paths, the goal text and intent are now scrubbed through a shared redaction seam, with a per-run canary proving the run stays clean, including URL-encoded and query/fragment-embedded secrets ([#58](https://github.com/matt-cochran/jevitate/pull/58)).
- Bound secrets (`--secret-field`) are typed into a matching field by code — the model sees only a `«secret:VAR»` placeholder — and TOTP seeds (`--totp`) are computed locally per RFC 6238 and never reach a model or disk.
- Server-log evidence attached to a step, defect or `blocked` reason is redacted before being stored or shown.
- Storage-state contents (cookies, origin storage) written by `--save-storage-state` are never logged; the file is written with mode `0600`.

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
