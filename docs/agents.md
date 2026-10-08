# Coding agents, skills and MCP

Jevitate gives a coding agent (Claude Code, Codex, Cursor, or any MCP client) a bounded way to
exercise a web app in a real browser and get back evidence, not opinions. There are two ways in,
and `jevitate init` sets up both.

## 1. The CLI plus agent skills

```bash
npm install -g @jevitate/cli
jevitate init            # collect missing keys, install the skills, register the MCP server
jevitate init --dry-run  # show what it would install or register, and write nothing
```

`init` installs a set of skills (instructions that teach the agent when and how to call the CLI)
into every agent runtime it detects:

| Runtime | Detected by | Skills go to |
| --- | --- | --- |
| Claude Code | `~/.claude` exists | `~/.claude/skills/` |
| Codex | `~/.codex` exists | a managed block in `~/.codex/AGENTS.md` |
| Cursor | `.cursor/` in the current directory | `.cursor/rules/` |
| any other agent | always | `.agent/skills/` plus a managed block in `./AGENTS.md` |

`--targets claude-code,codex,cursor` forces targets, `--skip-skills` / `--skip-keys` / `--skip-mcp`
skip a step, and a file you have edited is never overwritten without `--force`.

**Managed blocks.** In a file you own (`AGENTS.md`, and `CLAUDE.md` with `--claude-md`), jevitate's
instructions sit between two markers:

```
<!-- BEGIN JEVITATE SKILLS v1 jevitate@0.8.0 -->
…
<!-- END JEVITATE SKILLS v1 -->
```

Re-running `init` (for example after upgrading jevitate) replaces only the text between the markers,
whatever version wrote it, and leaves everything outside them byte-for-byte; the BEGIN line names
the jevitate version that wrote the block. An edit inside the block counts as yours: `init` skips
that file and says so until you pass `--force`. If the markers are broken (a BEGIN without its END,
two blocks), `init` refuses that file and prints how to fix it rather than appending a second block.

- `--claude-md` also keeps a block in the project's `CLAUDE.md` pointing at the installed Claude Code
  skills (opt-in; `CLAUDE.md` is never touched otherwise).
- `--uninstall` removes what `init` installed: the skill files and the marked blocks (a file left
  empty is deleted). Files and blocks you edited are skipped unless `--force`; `--dry-run` and
  `--targets` work as for install. Keys, MCP registration and `.jevitate/` are left alone.

The skills (each one's description tells the agent when to use it):

| Skill | For |
| --- | --- |
| `jevitate-getting-started` | the entry point: checks setup, gets a first result, picks the skill, MCP vs CLI, exit codes, human-only approvals |
| `jevitate-explore` | bounded exploration: goal, find-out, coverage, adversarial, feature; authoring a Journey from it |
| `jevitate-mission-scope` | a diff or PR → what to test, which Journeys to run, which gaps to explore |
| `jevitate-run-journey` | find and replay a promoted Journey (`--env`, video, screenshots, self-heal) |
| `jevitate-record` | a flow the person clicks through, and post-processing the takes |
| `jevitate-demo` | `demo "<aspect>"` / `demo approve`, `journey annotate`, `journey demo`, environments |
| `jevitate-verify-fix` | `verify-fix`, evidence clips and screenshots, the ledger, `regression capture`/`run` |
| `jevitate-ci-check` | `check --suite` (JUnit, SARIF, exit codes), baselines, `report`, `diff` |
| `jevitate-test-campaign` | a whole-release test campaign: job catalog, discovery runs, journey-anchored missions, evidence, verify-fix, the gate |
| `jevitate-ux-review`, `jevitate-load-test`, `jevitate-sources` | usability review, load tests, shared/third-party Journeys |

Their source is [`packages/skills/skills/`](../packages/skills/skills). Every `jevitate` command and
flag a skill shows is checked against the real CLI, and every tool it names against the MCP
allowlist (`packages/cli/src/skills-cli-drift.test.ts`). After setup, `init` prints a short
**next steps** list based on what it found (keys, MCP registration, `.jevitate/environments.json`).
With `--json`, the list is in `data.nextSteps`.

## 2. The MCP server

`jevitate mcp` starts a stdio MCP server. `init` registers it in the project's `.mcp.json`
(Claude Code), `.cursor/mcp.json` (Cursor) and `~/.codex/config.toml` (Codex). An existing entry
is never clobbered without `--force`: on a conflict, `init` prints the snippet instead. To print
a snippet yourself without writing anything:

```bash
jevitate mcp --print-config claude   # or: cursor | codex | json
```

The server exposes an allowlist of domain tools and nothing else. MCP is a convenience for agents
that could run the CLI themselves, so **every CLI command is reachable over MCP** (and every MCP
tool from the CLI), except the few listed below with the reason:

| Tool | What it does | Same thing from the CLI |
| --- | --- | --- |
| `find_capabilities`, `list_journeys` | search promoted Journeys; list every Journey in the store | `journey find`, `journey list` |
| `run_journey` | run a promoted Journey: `params`, `storageState`, `env`/`baseUrl`, `headed`/`slowMo`, `recordVideo` → `videoPaths`, `screenshots` → `screenshotPaths`, `viewport`/`device`, `fixtures`, `selfHeal` (+ `real`/`fakeAi`) | `journey run` |
| `annotate_journey` | draft each step's objective/expected result into a reviewable draft; `approve: true` applies the reviewed draft (refused if the Journey changed) | `journey annotate` (`--approve`) |
| `demo_journey` | replay a Journey as a narrated demo: `video` (.webm + .vtt) and/or `guide` (.md + screenshots) | `journey demo` |
| `promote_journey`, `publish_journey` | promote a local Journey (refused when its assertions can't prove its outcome; only the CLI's `--accept-weak` waives that); publish one to a registered source | `journey promote`, `journey publish` |
| `lint_journey` | the assertions that can't prove a Journey's outcome | `journey lint` |
| `review_journey` | read-only: the review sheet for promotion sign-off (summary, steps, side effects, inputs by name, proof, change since last approval, content hash); pass its `contentHash` as `promote_journey`'s `reviewedHash` | `journey review --json` (`promote --reviewed-hash`) |
| `verify_journey` | prove each assertion can fail: replay with a write step skipped, its write aborted, or a typed value emptied | `journey verify --mutate` |
| `create_demo`, `approve_demo` | demo one aspect on a named, non-production environment as a DRAFT; approve it (renders the final demo, promotes the Journey) | `demo "<aspect>"` / `demo create`, `demo approve` |
| `author_journey` | explore toward a goal and author an unpromoted Journey from the verified path | `explore-author-journey` |
| `queue_exploration`, `run_queued_missions`, `get_mission_result` | queue a bounded mission against a promoted target (`goal-based`/`coverage`/`exploratory`/`adversarial`/`feature`; `recordVideo`, `screenshots`, `evidenceVideo`, `persona`), drain the queue once, read its typed result | `mission queue`, `mission run`, `mission result` |
| `run_exploration` | run `explore` directly (every strategy, including `usability`), within its budget; `fromJourney` + `atStep` (+ `params`, `env`) start it from a promoted Journey's step (#293) | `explore` |
| `verify_fix` | re-check a finding: `replays`, `recordVideo` (before/after evidence), `screenshots`, `storageState`, `viewport`/`device` (+ `allowEmulationOverride`), `invariants`, `fixtures` | `verify-fix` |
| `run_check`, `get_report`, `diff_runs`, `baselines` | the CI gate; the deduped defect report; a run diff; named baselines (`list`/`show`/`tag`) | `check`, `report`, `diff`, `baseline …` |
| `ledger`, `regressions` | the repro ledger (`add`/`list`/`verify`); committed regressions (`capture`/`run`) | `ledger …`, `regression …` |
| `mission_targets` | the targets missions may run against (`add`/`list`/`update`/`promote`) | `mission target …` |
| `journey_anchors`, `run_campaign` | a Journey's named anchors (#293); a campaign of journey-anchored missions with one deduped report | `journey anchors`, `campaign run` |
| `run_sweep` | many explore missions from a targets file (targets × personas) with concurrency and resume; one result with defects deduped across targets (#425) | `sweep` |
| `run_load_test`, `ux_review`, `validate_invariants` | a load test of a Journey; an offline UX review of a Recording; validate invariant files | `load run`, `ux`, `invariants validate` |
| `recordings`, `sources`, `site_policy`, `profiles`, `prune_logs`, `get_ai_status` | Recording tools (`diff`/`fit`/`postdoc`/`promote`); Journey sources (`add`/`list`/`pull`/`update`/`remove`/`run`); site policies (`get`/`set`/`simulate`); profiles (`create`/`status`); log retention; which keys are configured, their source and a live validity check (never a value) | `recording …`, `source …`, `site policy …`/`site simulate`, `profile …`, `logs prune`, `ai status` |
| `queue_retrieval`, `queue_action`, `get_command`, `cancel_command`, `approve_action` | the command queue (`approve_action` and cancelling are human-only and refuse over MCP) | `inbox queue-retrieval`, `inbox queue-action`, `inbox command`; `inbox cancel` / `inbox approve` refuse the same way (approve or cancel in `jevitate ui`) |
| `list_incoming`, `get_thread` | site-integration reads | `inbox list`, `inbox show` |
| `get_site_health` | health, including the engine build identity | `inbox health` |
| `ai_generate_text` | model-assisted text, gated on configured keys | `ai generate` |

Not reachable over MCP, on purpose:

| CLI command | Why |
| --- | --- |
| `mcp` | the MCP server itself |
| `ui` | the local human dashboard — where a person approves or cancels inbox items |
| `init` | local machine setup: harness config, skills, interactive key entry |
| `ai setup` | interactive secret entry: a key never passes through a model |
| `record` | a person clicks through the app while it records (`author_journey` is the agent's way) |
| `source trust` (and `source add --accept-tou`) | trusting a third-party Journey, or accepting a source's Terms of Use, is a person's decision |

**How the CLI-mirroring tools work.** Each tool that mirrors a CLI command takes typed, closed
arguments named after the command's flags (`--storage-state` → `storageState`, a family's command
in `action`), runs that very command in process and returns `{exitCode, data}` — the command's own
JSON envelope data and exit code, so validation, redaction and exit codes are the CLI's. Exit 0/1/3/4
are answers (1 = defects / still reproduces); exit 2 (proved nothing) and every refusal are MCP
error results — never a pass — as `{error: "invalid_args" | "refused", code: "E_…", message,
exitCode}`. An unknown argument or a wrong type is `invalid_args` before anything runs.

**What MCP adds on top of the CLI's checks.** Every path argument must resolve (following symlinks)
inside the project the server runs in or `~/.jevitate/`, and a storage state never under a repo's
`.jevitate/`. A few flags are the operator's call and are never MCP arguments: shell hooks
(`--before`/`--after`/`--allow-shell-hooks`), the browser binary and switches (`--browser-*`),
which environment variable a secret is read from (`--secret`, `--secret-field`, `--totp`),
server-log sources (`--log-source`, `--allow-log-cmd`, …), re-sending paid/destructive hang writes
and store directories (`--dir`, …). Operators set those in `~/.jevitate/targets.json` or on the CLI.
`packages/cli/src/mcp-cli-parity.test.ts` checks all of this against the real command tree in both
directions: a new command or flag without an MCP decision fails the build.

**Long runs.** A run on one Journey, finding or suite (`run_journey`, `verify_fix`,
`annotate_journey`, `demo_journey`, `create_demo`, `run_check`, `regressions`, …) returns when it is
done, like the CLI. Open-ended exploration of a promoted target is queue + poll:
`queue_exploration` → `run_queued_missions` (or `jevitate mission run`) → `get_mission_result`.

Raw browser tools (`browser_click`, `browser_fill`, `page_evaluate`, `run_selector`,
`navigate_url`, `get_dom`, `get_cookies`) are forbidden: an agent can ask for a mission or a
Journey, never drive the page directly. The served tool list is checked against the allowlist in
[`packages/mcp-facade`](../packages/mcp-facade).

Every MCP tool has a CLI command (the table's last column), and a test fails when a new tool has
none. The `inbox` and `mission queue`/`mission result` commands call the same handlers the server does, over the same stores
(`~/.jevitate/inbox`, `~/.jevitate/missions/`), so what one queues the other sees, and the CLI never
prints more than MCP returns. `inbox command <id>` keeps `get_command`'s burn-after-read. If a human handed back
input that hasn't been read, it refuses (`E_INBOX_INPUT_PENDING`, exit 64) and consumes nothing;
`--reveal` consumes the input and prints it, exactly as `get_command` returns it. Each command takes
`--json` for the `{v, ok, data}` envelope. `mission result` exits with the result's own code
(0 clean · 1 defects · 2 broken run · 3 hang · 4 intermittent). A mission that is still queued or
running, or that could not run, exits 2, because it proves nothing yet.

## Queued missions (MCP)

`queue_exploration` only enqueues a mission (`~/.jevitate/missions/queue/<missionId>.json`).
`jevitate mission run` drains the queue: each mission runs through the runner its strategy uses on
the CLI, its result lands in `.jevitate/logs/<date>/`, and its queue record moves
`queued → running → done | failed`. `get_mission_result {id: missionId}` reports `queued`/`running`
(`pending: true`), the finished result, or `failed` (an error: it could not run, e.g. its target was
unpromoted meanwhile); `verify_fix` takes the missionId too once it is done. A finished result's
status carries the two orthogonal verdicts beside `status`/`exitCode` (#423): a goal run's
`goalOutcome` and `goalReason` (why it was not achieved: `not-found`, `ungrounded`, `budget`, …), and
every run's `defectOutcome` (`{status: "none" | "defects", byKind}`) — read these, never `reason`.

```bash
jevitate mission target add spa --name "App" --authorized-origin http://127.0.0.1:5193 \
  --api-origin http://127.0.0.1:18582 --base-url http://127.0.0.1:5193/settings --json
jevitate mission target promote spa --json          # a human act: only promoted targets are queueable
jevitate mission queue spa --strategy coverage --route '/settings/**' --json   # what queue_exploration does
jevitate mission run --once --real --json           # drain what is queued now (--watch keeps polling)
jevitate mission result <missionId>                 # what get_mission_result reports
```

A mission may reach only its target's `--authorized-origin` plus its `--api-origin`s (each a bare
http(s) origin — the queued-mission form of a second `explore --allow`); the target is re-resolved
(promoted-only) when the mission runs. Queueable strategies: `goal-based` (a goal and a
`successAssertion`), `coverage`, `exploratory` and `adversarial` (an optional in-scope `route`
glob), and `feature` (a `feature` name, optional `route`). A usability review needs an app class
the request cannot carry, so it is not queueable; run it directly (`explore --strategy usability`,
MCP `run_exploration`). A queued mission may ask for media next to its result — `recordVideo`,
`evidenceVideo`, `screenshots: screens | steps` (`--record-video`, `--evidence-video`,
`--screenshots [mode]`), never a path — and a `persona` name from `~/.jevitate/targets.json` for the
target's origin (`--persona`); an unknown persona fails the mission, never runs as the default
session. Without `--real`/`--fake-ai`, model-driven missions stay queued
(reported as `skipped`) and only feature missions run. The exit code is 2 only when a mission could
not run at all; each mission's own outcome is in its result
([exit codes](./outcomes.md#exit-codes)). A drain killed mid-mission records
that mission `done` with its partial `inconclusive` result, never leaves it `running`. A drain that
dies without that chance (SIGKILL, out of memory, a reboot) is caught by the next drain: a mission
whose drain process is gone (on the same host), or that has run for more than 12 hours (claimed on
another host), is recorded `failed` with the reason. It is never re-run automatically, since it may
already have sent writes: enqueue it again to retry.

Queued missions and Journey runs follow the operator's `~/.jevitate/targets.json` (safety, settle,
hang settings) and site policies ([journeys.md](./journeys.md#site-policies)) exactly as CLI runs
do; a queued request can never override them. A queued mission's declared invariants may not use
`authFrom.secret`: a request never chooses which of the operator's environment variables is sent.

**Authenticated queued missions.** An MCP request can never carry a session or a secret. The
operator declares them per origin in `~/.jevitate/targets.json`, next to `fixtures` and
`logSources`:

```json
{ "https://app.example.test": {
    "storageState": "auth/app.json", "saveStorageState": true,
    "secretFields": ["label=Password=env:APP_PASSWORD"] } }
```

Every queued strategy starts from `storageState`; a goal mission also types the `secretFields`
(values read from the environment at run time) and runs the target's fixtures around it, and
`verify_fix` uses the same storage state. `saveStorageState` (`true` writes back to
`storageState`, or a path) writes the rotated session back after each mission; missions drain one
at a time, so the next one starts from it. The same auth can live on the target record instead,
which wins field by field: `jevitate mission target add|update <id> --storage-state <file>
--save-storage-state [file] --secret-field <spec>`, and `update --clear-auth` drops it. A missing
file or unset variable fails the mission by name before any browser opens.
