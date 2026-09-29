---
name: jevitate-explore
description: Run a bounded jevitate exploration of an authorized web app. Strategies: goal (reach an end state, checked by `--success`), find-out (answer a question), coverage/exploratory (state coverage), adversarial (try to break it), feature (model-free), and usability. Runs via `jevitate explore` or MCP `run_exploration`/`queue_exploration`; saves a verified path as a Journey (`explore-author-journey`). Use when there's no saved Journey for what needs testing, or the user wants bugs found.
---

You scope an exploration mission. You never drive the browser yourself. Jev (the judgment
gateway) makes each click, type and select decision inside the engine, a generative model writes
only form text, and an independent check decides whether a goal succeeded: the `--success`
assertion or a hard signal, never the model's own "done". Your whole job is composing a good
mission and reading the result honestly.

## Before you start

- The target must be authorized. By default the allowlist is `--url`'s own origin. Any
  `--allow <origin>` REPLACES that default, so include the URL's own origin if the mission still
  needs it. An unauthorized target is refused (`E_UNAUTHORIZED_EXPLORE_TARGET`, 64). Exploration
  is authoring/test plane only, never production. If you don't know whether a target is
  authorized, ask.
- Model-driven strategies (goal, find-out, coverage, exploratory, usability) need a gateway:
  `--real` (live, after the human ran `jevitate ai setup`) or `--fake-ai` (a deterministic pipeline
  smoke that won't reach a real goal). Selecting neither fails closed (`E_AI_SETUP_REQUIRED`,
  64). `adversarial` and `--feature` produce real findings without keys: use `--fake-ai` for
  adversarial.
- Pick a strategy on purpose:
  - `--goal "<end state>" --success <check>` (default strategy `goal`): reach a stated end state.
  - `--goal "find out <question>; report the answer"` with no `--success`: a find-out run. It's
    read-only unless `--allow-writes` is passed, and the grounded answer is the verdict.
  - `--strategy coverage` / `--strategy exploratory`: state coverage with no goal. `coverage` is
    breadth-first, and `exploratory` follows newly revealed controls. `--scope app` widens it to the
    whole app, and `--stall-timeout <seconds>` (default 120) ends a stalled run.
  - `--strategy adversarial`: bounded misuse ("try to break it"). A hard-signal oracle decides.
  - `--feature <name> --route "<glob>"`: model-free testing of one capability.
  - `--strategy usability --goal "<job>" --app-class <class>`: see `jevitate-ux-review`.

## Writing a goal

- Describe the end state in plain language, not clicks ("place an order for one widget and reach
  the confirmation page", not "click .add-to-cart").
- Write `--success` so page or network state alone can check it, independent of what Jev
  reports: `urlIncludes:/confirmation`, `textIncludes:testId=status|Saved`,
  `requestMade:PUT /api/profile`, `responseStatus:POST /api/orders=2xx`. It's repeatable, and every
  check must hold. If you can't state a checkable assertion, the goal is too vague, so narrow it.
- A check that already held before the first action is vacuous. The run fails as `inconclusive`
  (`vacuous-check`) instead of passing.

## Running it

- Goal: `jevitate explore --url <authorized-url> --goal "<goal>" --success "urlIncludes:/done"
  [--allow <origin>] [--max-actions <n>] [--max-decisions <n>] --real --json`.
- Adversarial: `jevitate explore --strategy adversarial --url <authorized-url> --fake-ai --json`.
- Coverage: `jevitate explore --strategy coverage --url <authorized-url> --real --json`.
- Feature: `jevitate explore --feature checkout --route "/cart/**" --url <authorized-url> --json`.
- Behind a login: `--storage-state <file>` (a Playwright storageState path; `--save-storage-state
  <file>` writes the rotated one back). Pass real secrets with `--secret env:VAR` or
  `--secret-field 'label=Password=env:APP_PASSWORD'` so they stay out of every model call. Never
  put a secret value in the command line yourself.
- App rules: `--invariants <file>` checks declared invariants around every action (e.g. "when the
  page says Saved, the server has the value"). A violation is a code-decided defect.
- Evidence: `--evidence-video` (a captioned clip and before/at screenshots per defect),
  `--record-video`, and `--screenshots [screens|steps]`. See `jevitate-verify-fix`.
- Viewport: `--viewport 375x812` or `--device "iPhone 13"`.
- Keep the path as a Journey: `jevitate explore-author-journey --url <authorized-url> --goal
  "<goal>" --success <check> --id <journey-id> --name "<name>" [--storage-state <file>] --real
  --json` writes an UNPROMOTED Journey whose last step asserts `--success`. Promotion
  (`jevitate journey promote <id>`) is the human's decision.

## MCP

- `run_exploration({ url, strategy?, goal?, success?, ... })` runs `explore` directly, with every
  strategy including `usability`, and returns the typed result. Arguments are the flags in
  camelCase.
- For a PROMOTED mission target, queue instead: `queue_exploration({ target, strategy, goal?,
  successAssertion?, feature?, route?, recordVideo?, evidenceVideo?, screenshots?, persona? })`
  returns a `missionId` right away without running it. `run_queued_missions` (or
  `jevitate mission run --once --real --json`) drains the queue, and `get_mission_result({ id })`
  reports `queued`/`running` (`pending: true`, so poll again), the typed result, or `failed`.
  Queueable strategies are `goal-based`, `coverage`, `exploratory`, `adversarial` and `feature`.
  Registering and promoting targets is in `jevitate-mission-scope`.

## Reading the result

- Every result carries the canonical `missionOutcome` and its exit code: `clean` (0),
  `defects-found` (1), `inconclusive`/`crashed` (2, proved nothing), `hang` (3), `intermittent` (4).
  A goal run also carries `goalOutcome`: `succeeded`, `failed` (a check didn't hold), `exhausted`
  (budget), or `blocked`. Report these values, with `reason`/`failure.message`, not an optimistic
  gloss. A partial Recording from a `blocked` or `exhausted` run is a precise repro of how far Jev
  got, not a success.
- `inconclusive` with `failure.kind` `insufficient-coverage`, `vacuous-check`,
  `target-unresponsive` or `job-incomplete` means the run proved nothing. Say so and suggest a
  fix: a bigger budget, a session, or a better check.
- Each defect has a `fingerprint`. To reproduce it, prove a fix, or keep it as a regression, go to
  `jevitate-verify-fix`. Redacted issue drafts are written under `<run>.issues/`.
- Chat pages: messages are typed and sent, and each reply is awaited (`--reply-wait-ms`, default
  60000) and recorded.

## What you must never do

- Never widen `--allow` or the target beyond what the human authorized, and never add
  `--allow-destructive` or `--allow-writes` on your own.
- Never treat Jev's in-loop "done" as the verdict. Only the checks and hard signals decide.
- Never run exploration against production.
- Never fall back to a generic browser-automation tool if jevitate is unavailable or refuses.
  That bypasses every guardrail.

## Further reading (in the jevitate repo)

`docs/exploration.md` (strategies), `docs/fixtures.md` (`--fixtures`), `docs/invariants.md`,
`docs/multi-run.md` (`--repeat`, `--persona`, `--actor`), `docs/safety.md`,
`docs/backend-logs.md` (`--log-source`), `docs/outcomes.md` (every outcome value).
