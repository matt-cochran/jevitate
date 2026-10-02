---
name: jevitate-getting-started
description: Start here for any jevitate task, or when unsure which jevitate skill applies — checks setup (keys, .jevitate/, MCP), gets a first useful result against the user's app URL, routes to the right skill (explore, run-journey, record, demo, verify-fix, ci-check, ux-review, load-test, sources, mission-scope, test-campaign), and says when to use the jevitate MCP tools vs the CLI, what the exit codes mean, and which approvals only a human may give.
---

Jevitate tests a web app in a real browser and returns evidence: typed outcomes, exit codes,
Recordings, replayable Journeys, videos and screenshots. You never drive the browser yourself.
You pick the command, pass it the user's intent, and report what came back honestly.

## 1. Check the setup (once per session)

- `jevitate ai status --json` shows which AI features have their keys, by name only, never a value.
  Goal runs, authoring, demos and UX reviews need `generation` and `judgment` (`--real`). Without
  them, use a key-free command (see step 2), or ask the human to run `jevitate ai setup generation`
  and `jevitate ai setup judgment` themselves. Setup is interactive. Never ask for a key in chat.
- The repo has a `.jevitate/` directory (Journeys, regressions, baselines, logs and
  `environments.json`). If it's missing, the human runs `jevitate init` (it also installs these
  skills and registers the MCP server). `jevitate init --dry-run` changes nothing.
- The app must be running and the human must have authorized its URL. Jevitate only acts on an
  authorized origin (`--url`'s own origin, or an explicit `--allow` list). It refuses a production
  target for authoring runs and demos. Never widen the allowlist on your own.

## 2. A first useful result

| The user has | Run |
| --- | --- |
| keys, and a task a user does | `jevitate explore --url <app-url> --goal "<task>" --success "urlIncludes:/<done-path>" --real --json` |
| keys, and a question about the app | `jevitate explore --url <app-url> --goal "find out <question>; report the answer" --real --json` (read-only by default) |
| no keys | `jevitate explore --strategy adversarial --url <app-url> --fake-ai --json`: misuse is planned in code, and the findings (HTTP 5xx, uncaught errors, hangs, invariant violations) come from hard signals, not a model |
| no keys, one feature | `jevitate explore --feature <name> --route "/<area>/**" --url <app-url> --json` (model-free) |

Then pick the matching skill:

| The user wants to | Skill |
| --- | --- |
| explore, find bugs, or check that a goal is reachable | `jevitate-explore` |
| know what to test after a diff or PR | `jevitate-mission-scope` |
| replay a known flow (a saved Journey) | `jevitate-run-journey` |
| record a flow they click through | `jevitate-record` |
| get a narrated demo video or a step-by-step guide | `jevitate-demo` |
| reproduce a finding, prove a fix, attach evidence to a PR, or lock a bug in as a regression | `jevitate-verify-fix` |
| gate CI (JUnit, SARIF, baselines, a defect report) | `jevitate-ci-check` |
| get a usability critique | `jevitate-ux-review` |
| run a load test | `jevitate-load-test` |
| share or run third-party Journeys | `jevitate-sources` |
| test a whole release end to end (many user jobs, a QA sweep) | `jevitate-test-campaign` |

## 3. MCP tools or the CLI

- If the jevitate MCP tools are in your tool list (`init` registers `jevitate mcp` for Claude
  Code, Cursor and Codex), use them. They take typed arguments named after the CLI flags
  (`--storage-state` becomes `storageState`), run the same command in process, and return
  `{exitCode, data}`. Exit 2 (proved nothing) and every refusal come back as MCP errors
  (`invalid_args` or `refused`, with the `E_…` code), never as a pass.
- Otherwise use the CLI with `--json`: one line on stdout, `{v, ok, data}` or
  `{v, ok: false, error: {code, message}}`. Read the exit code as well.
- Common pairs: `run_exploration` = `explore`, `queue_exploration` + `run_queued_missions` +
  `get_mission_result` = `mission queue` + `mission run` + `mission result`,
  `find_capabilities`/`run_journey` = `journey find`/`journey run`, `author_journey` =
  `explore-author-journey`, `create_demo`/`demo_journey` = `demo`/`journey demo`, `verify_fix` =
  `verify-fix`, `regressions` = `regression capture|run`, `ledger` = `ledger …`, `run_check` =
  `check`, `get_report` = `report`, `ux_review` = `ux`. The full table is in the jevitate repo's
  `docs/agents.md`.
- These are never available over MCP: `record` (a person clicks), `init`, `ai setup` (secret entry),
  `ui`, `source trust` and `source add --accept-tou`. Operator settings are never tool arguments
  either: shell hooks, browser binaries, which environment variable a secret comes from, and
  log-command sources. Tell the human the CLI command instead.
- Raw browser tools (click, fill, evaluate, get DOM or cookies) don't exist on purpose. Never
  swap in another browser-automation tool to get around a refusal.

## 4. Decisions that belong to the human

Only do these when the human has asked for that specific action in this conversation. Before
you do, show them what they are approving:

- promoting a Journey: `jevitate journey promote <id>` / `promote_journey`
- applying drafted annotations: `jevitate journey annotate <id> --approve` / `annotate_journey` with `approve: true`
- approving a demo, which promotes its Journey: `jevitate demo approve <id>` / `approve_demo`
- promoting a mission target: `jevitate mission target promote <id>`
- trusting a third-party Journey or accepting a source's Terms of Use (CLI only)
- approving or cancelling an inbox item: only in `jevitate ui`. The MCP tools `approve_action` and `cancel_command` always refuse.

## 5. Exit codes (every command)

`0` clean / passed / fixed · `1` defects found, a gating finding, or still reproduces · `2`
inconclusive: the run proved nothing, so never report it as a pass · `3` the app hung (reproduced) ·
`4` intermittent · `64` usage error, nothing ran (bad flag, unknown id, missing keys
`E_AI_SETUP_REQUIRED`, target not allowed) · `130`/`143` interrupted, but the partial result was
written. Report the outcome the tool gave you. Never round it up.
