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
- `riskClass` is engine-derived, not author-declared: a Journey is
  `"read-only"` iff every step is a `navigate`/`waitFor`/`extract`/`assert`, or
  a `click` whose target has ARIA role `link` (following a link reads a page,
  it does not mutate anything), AND every absolute `navigate` stays within
  `declaredOrigins`. Anything else — a non-link `click` (e.g. a button),
  `fill`/`select`/`press`/`handback`, or a navigate that could leave
  `declaredOrigins` — is conservatively `"risky"` and needs `source trust`
  before it can run.

## The source manifest shape

A source repo (what `source add <name> <gitUrl>` clones) needs exactly this at
its root, or `source add`/`source update` refuse with `E_SOURCE_INVALID_MANIFEST`:

- `jevitate.json` — `{ "version": 1, "source": "<name>", "sites": [{ "origin":
  "<https://...>", "automationPolicy": "allowed", "touBasis": "<free text>" }, ...] }`.
  `sites` declares every origin this source's Journeys are authorized to touch
  and the Terms-of-Use basis for each; `source add --accept-tou` acknowledges
  ALL of them together.
- `journeys/*.journey.json` — one file per shared Journey: an ordinary
  `Journey` (`{ metadata, recording }`, same shape `jevitate journey list`
  reads) PLUS a top-level `declaredOrigins: string[]` (at least one absolute
  URL) — the origins THIS Journey is authorized to touch, which must all
  appear in the manifest's `sites`. `jevitate journey publish` writes this
  file for you (deriving `declaredOrigins` from the Journey's absolute
  `navigate` steps, or from `recording.site` when its navigates are relative —
  e.g. an `explore-author-journey`-authored Journey — or from an explicit
  `--declare-origin`); a hand-authored source repo must match this shape
  exactly, `.strict()` — unknown/missing keys fail the whole load, one bad
  file at a time (never a silent partial list).

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

- `jevitate source run <name> <journeyId> --param k=v ... [--storage-state
  <file>] --json` runs a remote-source Journey THROUGH `@jevitate/sources`'
  `resolveForRun` gate. `--storage-state` is the same authenticated pre-step
  as `jevitate journey run` (see `jevitate-run-journey`), for a source Journey
  that needs one. Every refusal is a typed error thrown BEFORE any browser
  launches, each with its own code so a caller knows WHY:
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
  secret-references-only, declared-origin coverage — derived from the
  Journey's absolute `navigate` steps, or from `recording.site` when they are
  relative), writes onto a new `publish/<id>` branch, and opens a PR when `gh`
  is present. The branch push is reported as `pushed: true` regardless of
  whether a PR could be opened: when `gh` is absent, OR `gh` is present but
  `gh pr create` fails (e.g. the remote isn't GitHub), the result still comes
  back `ok: true` with `pushed: true` and no `prUrl`, plus printed
  instructions to open the PR manually — the push already happened by that
  point, so a PR failure is never reported as a publish failure. It refuses an
  unpromoted Journey (`E_JOURNEY_PUBLISH_NOT_PROMOTED`) and an embedded secret
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
