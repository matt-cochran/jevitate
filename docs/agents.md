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

The skills: `jevitate-explore` (run a bounded exploration mission), `jevitate-mission-scope`
(read a diff and decide what to test), `jevitate-record`, `jevitate-run-journey`,
`jevitate-sources`, `jevitate-load-test` and `jevitate-ux-review`. Their source is
[`packages/skills/skills/`](../packages/skills/skills).

## 2. The MCP server

`jevitate mcp` starts a stdio MCP server. `init` registers it in the project's `.mcp.json`
(Claude Code), `.cursor/mcp.json` (Cursor) and `~/.codex/config.toml` (Codex). An existing entry
is never clobbered without `--force`: on a conflict, `init` prints the snippet instead. To print
a snippet yourself without writing anything:

```bash
jevitate mcp --print-config claude   # or: cursor | codex | json
```

The server exposes an allowlist of domain tools and nothing else:

| Tool | What it does |
| --- | --- |
| `find_capabilities`, `run_journey` | find and run promoted Journeys with typed parameters |
| `queue_exploration`, `get_mission_result`, `verify_fix` | queue a bounded mission against a promoted target, read its typed result, re-check a finding |
| `queue_retrieval`, `queue_action`, `get_command`, `cancel_command`, `approve_action` | the command queue (`approve_action` and cancelling are human-only and refuse over MCP) |
| `list_incoming`, `get_thread` | site-integration reads |
| `get_site_health` | health, including the engine build identity |
| `ai_generate_text` | model-assisted text, gated on configured keys |

Raw browser tools (`browser_click`, `browser_fill`, `page_evaluate`, `run_selector`,
`navigate_url`, `get_dom`, `get_cookies`) are forbidden: an agent can ask for a mission or a
Journey, never drive the page directly. The served tool list is checked against the allowlist in
[`packages/mcp-facade`](../packages/mcp-facade).

## Queued missions (MCP)

`queue_exploration` only enqueues a mission (`~/.jevitate/missions/queue/<missionId>.json`).
`jevitate mission run` drains the queue: each mission runs through the runner its strategy uses on
the CLI, its result lands in `~/.jevitate/recordings`, and its queue record moves
`queued → running → done | failed`. `get_mission_result {id: missionId}` reports `queued`/`running`
(`pending: true`), the finished result, or `failed` (an error: it could not run, e.g. its target was
unpromoted meanwhile); `verify_fix` takes the missionId too once it is done.

```bash
jevitate mission target add spa --name "App" --authorized-origin http://127.0.0.1:5193 \
  --api-origin http://127.0.0.1:18582 --base-url http://127.0.0.1:5193/settings --json
jevitate mission target promote spa --json          # a human act: only promoted targets are queueable
jevitate mission run --once --real --json           # drain what is queued now (--watch keeps polling)
```

A mission may reach only its target's `--authorized-origin` plus its `--api-origin`s (each a bare
http(s) origin — the queued-mission form of a second `explore --allow`); the target is re-resolved
(promoted-only) when the mission runs. Queueable strategies: `goal-based` (a goal and a
`successAssertion`), `coverage` and `adversarial` (an optional in-scope `route` glob), and
`feature` (a `feature` name, optional `route`). A usability review needs an app class the request
cannot carry, so it is CLI-only. Without `--real`/`--fake-ai`, model-driven missions stay queued
(reported as `skipped`) and only feature missions run. The exit code is 1 only when a mission could
not run at all; each mission's own outcome is in its result. A drain killed mid-mission records
that mission `done` with its partial `inconclusive` result, never leaves it `running`.
