---
name: jevitate-explore
description: Scopes and runs a bounded exploration mission via `jevitate explore` (goal, coverage, exploratory, adversarial, or capability-scoped feature strategies) or the MCP `queue_exploration` tool — drives Jev (not you) on an authorized target and emits a replayable Recording. Use when there is no existing Journey for what needs testing and a human wants autonomous, bounded exploration.
---

You scope an exploration mission; you never drive the browser yourself. Jev
(the judgment gateway) makes every click/type/select decision inside the
exploration engine; a generative model writes only form text; an independent,
user-supplied assertion — not the model's own "done" signal — decides whether
a goal-based mission actually succeeded. Your entire job is composing a good
mission and reading the result honestly.

## Before you start

- The target must already be authorized. This tool refuses an unknown or
  unauthorized target by design (`E_UNAUTHORIZED_EXPLORE_TARGET` — authoring/test
  plane only, never production writes). The allowlist is the `--url`'s own
  origin ONLY WHEN `--allow` is omitted entirely — any `--allow <origin>`
  REPLACES that default rather than adding to it, so include the URL's own
  origin explicitly in your `--allow` list if the mission still needs to
  navigate there too. If you don't know whether a target is authorized, ask.
- Pick a strategy deliberately (default is `goal`):
  - `--strategy goal` (default): needs `--goal` and `--success`. Reaches a
    stated end state.
  - `--strategy coverage` / `--strategy exploratory`: state-coverage by
    induction; the frontier itself is the objective, so it takes no
    goal/success. `coverage` sweeps breadth-first; `exploratory` follows
    the controls each action just revealed (novelty-first). `--stall-timeout
    <seconds>` (default 120) ends a run that stops making progress.
  - `--strategy adversarial`: bounded misuse ("try to break it") whose stop
    decision comes from a trusted hard-signal defect oracle, never Jev's own
    signal. Needs only `--url`.
  - `--feature <name> --route <glob>`: capability-scoped feature testing
    (model-free; no goal/success, no gateway selection needed).

## Writing a goal-based mission

- Write a `--goal` in plain language describing the end state, not a sequence of
  clicks ("place an order for one widget and reach the confirmation page," not
  "click .add-to-cart then click #checkout").
- Write a `--success` assertion independent of what you expect Jev to report —
  checkable from page state alone, e.g. `urlIncludes:/confirmation`. Jev's own
  "goal met?" judgment is advisory; the assertion is what decides success. If
  you cannot state a concrete, checkable assertion, the goal is too vague —
  narrow it first.

## Running it

- Goal: `jevitate explore --url <authorized-url> --goal "<goal>" --success
  urlIncludes:/inbox [--allow <origin>] [--secret <value>] [--max-actions <n>]
  [--max-decisions <n>] --real --json`. Model-driving strategies (`goal`,
  `coverage`, `exploratory`, `adversarial`) need a gateway: `--real` (live
  Jev + OpenRouter, after `jevitate ai setup`) or `--fake-ai` (a deterministic
  pipeline smoke — it will NOT drive to a real goal). No selection fails closed.
- Adversarial: `jevitate explore --strategy adversarial --url <authorized-url>
  --real --json`.
- Coverage: `jevitate explore --strategy coverage --url <authorized-url> --real
  --json`.
- Feature: `jevitate explore --feature checkout --route "/cart/**" --url
  <authorized-url> --json` (model-free).
- Authoring a promotable Journey: `jevitate explore-author-journey --url
  <authorized-url> --goal "<goal>" --success <assertion> --id <journey-id>
  --name "<name>" [--storage-state <file>] --real --json` — drives the
  goal-based mission and writes an UNPROMOTED, parameterized Journey to the
  store. It is never auto-promoted (`jevitate journey promote <id>` promotes
  it once a human is ready). The `--success` assertion is baked in as the
  authored Journey's FINAL step (an `assert`), so a replay of it proves the
  outcome it was authored to reach — not just that navigation got there.
  `--storage-state` authors against an already-logged-in session for a target
  behind a login; replaying that Journey later needs the SAME flag on `journey
  run`/`load run`/`source run` (see `jevitate-run-journey`).
- MCP: the `queue_exploration` tool — `queue_exploration({ target, goal, ... })`
  — enqueues a bounded mission and returns a `missionId` immediately (it does
  not run inline). `target` must be a pre-registered mission target id, not a
  raw URL.

## Reading the result

- The output is a deterministic `Recording`. Report the actual `outcome`, not an
  optimistic gloss — a `blocked` or `exhausted` (budget) outcome with a partial
  Recording is a precise repro of how far Jev got, but it is not success. A
  goal-based run is success only when `outcome` is `succeeded`; adversarial CI
  gates on `outcome === "defect"`; a coverage run gates on discovered defects.
- `runOutcome` (goal) / `outcome` (usability) is the run's own account:
  `completed` only when the goal's success condition was observably met, else
  `incomplete` with the reason (budget, stuck detector, a rejected `done`, hang,
  crash). Quote the reason; never read an `incomplete` run as done.
- Chat pages: messages are typed AND sent (`send`), each reply is awaited
  (`--reply-wait-ms`, default 60000) and recorded in the transcript (`message`,
  `reply`); generated messages are capped by `--reply-max-chars` (default 300).
- A successful goal-based Recording is a candidate to hand to `jevitate-record`
  for postdoc review, or to author directly via `explore-author-journey` —
  say so when it succeeds.

## What you must never do

- Never widen `--allow`/the target beyond what the human explicitly authorized.
- Never treat Jev's in-loop "done" signal as the final word — only the
  `--success` assertion result is, for goal-based runs.
- Never ask the exploration engine to do anything on a production target — this
  is authoring/test-plane only, always.
- Never fall back to a generic browser-automation tool if `jevitate explore`
  is unavailable — that bypasses every guardrail this skill enforces.

## Running it through MCP (shipped)

- `jevitate mcp` starts the stdio MCP server; `queue_exploration` is one of its
  allowlisted, wired tools. Register it in your harness with `jevitate mcp
  --print-config <claude|cursor|codex|json>`, or let `jevitate init` register it
  for each detected runtime.
- `queue_exploration` needs a PROMOTED mission target, not a raw URL. Register
  and promote one first with `jevitate mission target add <id> ...` then
  `jevitate mission target promote <id>` (see `jevitate-mission-scope`). It
  enqueues and returns a `missionId` immediately — it never runs inline.
- Strategies: `goal-based` (`goal` + `successAssertion`), `coverage` and
  `adversarial` (optional in-scope `route` glob), `feature` (`feature` name).
  Usability reviews are CLI-only (`explore --strategy usability`).
- `jevitate mission run --once --real --json` (a human runs it, or `--watch`
  keeps it draining) runs every queued mission and writes its result.
  `get_mission_result({ id: missionId })` then reports `queued`/`running`
  (`pending: true` — poll again), the typed result, or `failed`. `verify_fix`
  accepts the missionId once it is done.

## Known gaps

- `queue_exploration` enqueues but does not itself run the mission; nothing
  runs until `jevitate mission run` drains the queue. Treat the returned
  `missionId` as "accepted," not "finished."
