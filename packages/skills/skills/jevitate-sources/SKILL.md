---
name: jevitate-sources
description: Manage Jevitate's distributed Journey sources — add/list/pull/update/remove git-backed sources, trust individual Journeys (content-hash-bound), run a trusted remote Journey through the run-gate, and publish a local promoted Journey up to a source — via `jevitate source ...` and `jevitate journey publish`. Use when sharing Journeys across repos or trusting/running a third-party Journey; use jevitate-run-journey for an already-local Journey.
---

You add, trust, run, and publish federated Journeys across git-backed sources.
`@jevitate/sources` (git-backed remote sources, a local source,
trust/acknowledgement tracking, a lockfile pinning each source at a commit, a
publish flow, and a risk-classifying run-gate) is fully wired to the
`jevitate source ...` and `jevitate journey publish` commands — this is a real,
invokable surface, not a programmatic-only capability.

## The model

- A `JourneySource` (local or remote/git) exposes a promoted-only
  `list()`/`find()` just like a local `JourneyRegistry`. Each result carries a
  `source`, an optional `pin` (a locked commit), a `riskClass` (`"read-only" |
  "risky"`), and `trusted` (whether this project has acknowledged that exact
  content). Trust is LOCAL and per-user; it is bound to a content hash, so any
  change to a Journey's content invalidates its trust until re-approved.

## Add and manage sources

- `jevitate source add <name> <gitUrl> [--accept-tou] --json` clones and pins a
  source at its current commit and prints its declared Terms of Use per origin.
  A source's Journeys cannot RUN until its ToU is acknowledged — pass
  `--accept-tou` (an explicit human act) to acknowledge at add time, or re-run
  later. `add` never trusts any Journey implicitly.
- `jevitate source list --json` — registered sources, their pinned commit, and
  the set of trusted Journey ids.
- `jevitate source pull <name> --json` fetches without moving the pin;
  `jevitate source update <name> --json` advances the pin to the fetched head.
- `jevitate source remove <name> --json` — deregister a source.

## Trust an individual Journey

- `jevitate source trust <name> <journeyId> --json` explicitly trusts ONE
  Journey in a source, bound to its current content hash. This is the gate a
  `risky`-classified Journey must pass before it can run. Trust never comes from
  `add`/`pull`/`update` — only from this explicit act, and it emits only the
  address + bound hash, never the Journey's content.

## Run a trusted remote Journey (through the run-gate)

- `jevitate source run <name> <journeyId> --param k=v ... --json` runs a
  remote-source Journey THROUGH `@jevitate/sources`' `resolveForRun` gate. Every
  refusal is a typed error thrown BEFORE any browser launches, each with its own
  code so a caller knows WHY:
  - `E_SOURCE_RUN_HASH_MISMATCH` — the pinned content no longer matches what was
    trusted.
  - `E_SOURCE_RUN_UNTRUSTED` — a `risky` Journey that was never trusted.
  - `E_SOURCE_RUN_ORIGIN` — a navigate target outside the Journey's declared
    origins.
  - `E_SOURCE_RUN_TOU` — the source's Terms of Use were never acknowledged.
  - `E_SOURCE_RUN_SECRET` — an embedded secret (Journeys carry secret
    references, never values).
- `source run` is the REMOTE trust boundary; `jevitate journey run` stays the
  LOCAL `FsJourneyStore` path. Keep them separate — a remote run never bypasses
  the gate.

## Publish a local Journey up to a source

- `jevitate journey publish <id> --to <source> [--declare-origin <origin> ...]
  [--as <newId>] --json` pushes a PROMOTED local Journey up to a registered
  source. It preserves every publish-side guard (promoted-only,
  secret-references-only, declared-origin coverage), writes onto a new
  `publish/<id>` branch, and opens a PR when `gh` is present (degrading to
  printed instructions when it is not). It refuses an unpromoted Journey
  (`E_JOURNEY_PUBLISH_NOT_PROMOTED`) and an embedded secret
  (`E_JOURNEY_PUBLISH_SECRET`).

## What you must never do

- Never acknowledge a source's ToU (`--accept-tou`) or trust a Journey
  (`source trust`) on the user's behalf without their explicit say-so — both are
  human-consent gates, not conveniences to auto-satisfy.
- Never treat an untrusted or `risky`-classified federated Journey as safe to
  run — the run-gate exists precisely to stop that, and a refusal is the correct
  outcome to surface, not an obstacle to work around.
- Never widen a Journey's declared origins on publish beyond what the human
  authorized just to make coverage pass.

## Known gaps

- There is no MCP-tool surface over federated sources yet — the
  `find_capabilities`/`run_journey` MCP tools operate over the LOCAL promoted
  store, not remote sources. Federated add/trust/run/publish are CLI-only today;
  drive the `jevitate source ...` commands directly.
