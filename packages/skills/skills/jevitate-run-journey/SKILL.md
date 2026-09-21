---
name: jevitate-run-journey
description: Find and run a promoted Jevitate Journey by id, with typed params, via the jevitate CLI or the find_capabilities/run_journey MCP tools. Use when a user wants to execute a known, already-recorded browser automation (a login, a checkout, a form submission) rather than explore or record a new one.
---

You drive already-published, promoted Jevitate Journeys. You never write or invent
automation steps yourself — a Journey is a deterministic, pre-recorded, reviewed
artifact; your job is to find the right one and run it with the right params.

## Discover

- CLI: `jevitate journey find "<query>" --json` — searches promoted Journeys by
  name/description. Returns `{ id, name, description, params }[]`.
- MCP: `find_capabilities(query)` returns the same shape. Prefer this when you are
  already inside an MCP-connected session — it is scoped to the same
  promoted-only allowlist.
- `jevitate journey list --json` shows ALL Journeys including unpromoted ones —
  use this only for authoring/debugging with a human present, never to find
  something to run autonomously (an unpromoted Journey is unpromoted for a
  reason and `journey run`/`run_journey` will refuse it anyway).

## Run

- CLI: `jevitate journey run <id> --param key=value --param key2=value2 --json`.
  Every param the `find`/`find_capabilities` result listed under `params` is
  required; passing an unknown param key is a refusal (`E_INVALID_PARAMS`), not
  a silent ignore. An unknown id is `E_UNKNOWN_JOURNEY`.
- MCP: `run_journey(id, params)` — same param-schema validation, same refusal on
  an unknown id or params. It NEVER accepts inline steps or a raw recording —
  a published id only.
- Read the JSON envelope's `outcome` field. `"ok"` and `"healed"` (a run that
  recovered via self-heal) are both successes; `"quarantined"` (and any other
  value, including a secret-handback pause) means it did not complete — report
  that honestly, do not summarize a non-success outcome as success.

## Self-heal (optional, additive)

- `jevitate journey run <id> --self-heal <fail-closed|hybrid|full>` opts a run
  into scoped self-healing when a selector drifts. The default `fail-closed`
  preserves the plain, unhealed behavior. `hybrid`/`full` need an AI gateway
  (`--real` after `jevitate ai setup`, or `--fake-ai` for a pipeline smoke);
  requesting a heal mode without one fails closed rather than running unhealed.
- A write/irreversible step NEVER auto-heals in any mode — that floor is
  enforced by the runtime, not something you can override from a flag.

## What you must never do

- Never pass inline steps, a raw URL, or a selector anywhere in this flow — you
  only ever pass an `id` that came from `find`/`find_capabilities`.
- Never guess a param value that looks like a secret (a password, an API key) —
  if a Journey's params include something secret-shaped, tell the user it needs
  to be supplied by them or via the configured secret manager, never invent one.
- Never try to run an id you have not first seen in a `find`/`find_capabilities`
  result in this same session — a promoted id can be revoked; don't rely on a
  memorized id from an earlier conversation.

## Known gaps (as of 2026-09-20)

- There is currently no CLI/MCP command to *publish* or *promote* an existing
  Recording as a new Journey (ticket #19, `jevitate journey publish`, is still
  pending) — promotion happens via the `JourneyRegistry` TypeScript API today.
  The one autonomous path that DOES write a Journey is
  `jevitate explore-author-journey` (see `jevitate-explore`), and even that
  writes an UNPROMOTED Journey a human must still promote. If a user asks you to
  "save this as a Journey" or "promote this recording," tell them promotion
  isn't yet a command and point them at a human with repo access, rather than
  guessing at a command name.
