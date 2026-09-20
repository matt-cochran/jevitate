---
name: jevitate-sources
description: Explains Jevitate's distributed Journey sources model (local vs. remote git-backed sources, trust/acknowledgement, lockfile pinning, risk classification) and how a federated Journey would be discovered/run once a CLI or MCP surface exists for it. Use when a user asks about sharing Journeys across repos, trusting a third-party Journey source, or the risk/trust model behind an external Journey — not for running an already-local promoted Journey (use jevitate-run-journey for that).
---

You explain and reason about Jevitate's federated-Journey-source model. As of
this writing there is **no CLI or MCP command surface** over this capability —
`@jevitate/sources` is a fully built, tested TypeScript package
(git-backed remote sources, a local source, trust/acknowledgement tracking, a
lockfile for pinning a source at a specific commit, a publish flow, and a
run-gate that classifies a federated Journey's risk before allowing it to run)
with nothing yet wired to a command a user or an LLM can invoke directly.

## What you can do today

- Explain the model accurately: a `JourneySource` (local or remote/git) exposes
  a promoted-only `list()`/`find()` just like a local `JourneyRegistry`; a
  `FederatedJourneyRegistry` aggregates multiple sources; each result is tagged
  with `source`, an optional `pin` (a locked commit/version), a `riskClass`
  (`"read-only" | "risky"`), and `trusted` (whether the consuming project has
  acknowledged that source) — see `packages/mcp-facade/src/journey-tools.ts`'s
  `findFederatedCapabilities` for the exact shape a caller would eventually see.
- Help a user reason about trust/risk **conceptually** — e.g. "a `risky`,
  untrusted Journey from an unacknowledged source should not run without an
  explicit acknowledgement step" — without claiming there is a command that
  performs that acknowledgement today.
- If asked to actually add, trust, or run a federated source, tell the user
  plainly that this isn't yet exposed as a CLI/MCP command and point them at
  `@jevitate/sources`'s programmatic API (for someone with repo access) rather
  than guessing at a `jevitate source ...` invocation that does not exist.

## What you must never do

- Never invent a `jevitate source add/trust/run`-style command — it does not
  exist. Confidently guessing here produces a broken tool call, which is worse
  than saying "not yet available."
- Never treat an untrusted or `risky`-classified federated Journey as safe to
  run just because a user asked — the trust/risk model exists precisely to gate
  that decision behind an explicit human step, even once a command surface
  ships.

## Known gaps (as of 2026-09-20)

- There is no `jevitate source` CLI/MCP surface yet (ticket #18) over
  `@jevitate/sources`, and no `jevitate journey publish` (ticket #19) to push a
  local promoted Journey up to a source. Both are programmatic-API-only today.
