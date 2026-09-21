# Ticket #8 — MCP `queue_exploration` Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Proposed (plan — for review before execution)
**Date:** 2026-09-20
**Ticket:** `gh issue view 8 --repo matt-cochran/jevitate` — "An MCP `queue_exploration` tool enqueues bounded testing missions behind the allowlist."
**Specs:** `docs/superpowers/specs/2026-09-19-autonomous-exploration-testing-design.md` §3.2/§6 (missions, guardrails), `docs/superpowers/specs/2026-09-19-unified-journey-automation-and-testing-design.md` §7/§9a (2-level MCP facade, fail-fast invariant contract).
**Sibling plans:** `docs/superpowers/plans/2026-09-20-testing-missions-exploration-engine.md` (P1 `@jevitate/explore` engine — the eventual *consumer* of the queue this plan produces; its "LLM-directed mission scoping" section names `queue_exploration` and defers it to "P2, once the P1 engine and mission types exist" — this plan makes that dependency explicit and shows how to build the MCP-facing half **now**, decoupled from the engine's existence). `docs/superpowers/plans/2026-09-20-skill-set-and-init.md` (the `jevitate-explore` skill drives this tool from an LLM).

**Goal:** Add an authoring-plane MCP tool, `queue_exploration`, to `@jevitate/mcp-facade`'s allowlist. It lets an LLM **scope** a bounded testing mission (goal/feature/route + success assertion + strategy + budget) without ever touching a browser. The tool validates the request, resolves the mission's `target` against a **promoted-only** target registry (mirroring the Journey promotion gate), enforces a hard budget ceiling, and **enqueues** a `QueuedMission` record to disk. It never runs the mission — running is `@jevitate/explore`'s job (a separate, later CLI/daemon consumer), kept out of scope here so this ticket does not block on P1's engine being built.

## Why this shape (state of the code, verified)

- `packages/mcp-facade/src/tools.ts` is a two-line allowlist (`ALLOWED_TOOLS`) plus `listToolNames()`. `journey-tools.ts` and `ai-tools.ts` show the established pattern for adding a tool: **a thin, pure projection function that delegates all validation/persistence to a leaf package**, never duplicating that logic in `mcp-facade` itself (see `runJourney`'s own doc comment: "this function never duplicates that logic"). `queue_exploration` follows the same shape.
- There is **no real `@modelcontextprotocol/sdk` `Server` wiring anywhere in the tree yet** (verified: no `new Server(`/`StdioServerTransport` hits under `packages/`). `find_capabilities`/`run_journey`/`ai_generate_text` are exported pure functions + an allowlist string, not yet bound to a live transport. `queue_exploration` is built to the same level of completeness as its siblings — a tested pure function + allowlist entry — not a new transport layer (that is a separate, not-yet-started slice affecting all four tools equally, out of scope here).
- `@jevitate/explore` (ticket #1, `docs/superpowers/plans/2026-09-20-testing-missions-exploration-engine.md`) **does not exist yet** as a package. `queue_exploration` therefore cannot import mission-execution types from it. This plan introduces a new leaf package, `@jevitate/missions`, that owns the **mission request shape and the queue**, independent of the engine. When `@jevitate/explore` ships, its `bounds.ts` should import the ceiling constants from `@jevitate/missions` (see Risks) rather than the reverse — `@jevitate/missions` has no reason to depend on the engine.
- `@jevitate/recording`'s `Assertion`/`AssertionSchema` already exist (`packages/recording/src/schema.ts`) and are exactly the "independent, user-supplied assertion" type the exploration-engine plan specifies for `successAssertion` — **but `AssertionSchema` is not currently exported** (it's a private `const` used only internally by `RecordingSchema`). This plan exports it (additive, non-breaking).
- The Journey package's conventions to mirror exactly: a `SAFE_ID_RE`-constrained `id` (path-traversal-safe, since ids become filenames), a `.strict()` zod schema validated **before** any disk write, a structural `*Store` interface + an `Fs*Store` implementation (`packages/journey/src/store.ts`), a thin `*Registry` wrapping the store with a promoted-only `find`/`get` gate (`packages/journey/src/registry.ts`), and a domain-level typed error thrown on refusal (`ParamValidationError` in `packages/journey/src/param-schema.ts`).
- `packages/runtime/src/slice1-invariants.test.ts` is the model for "asserts-it-refuses" test files: one readable file re-asserting each named invariant against the real (not re-mocked) production code.

## Architecture

```
@jevitate/missions                          (NEW leaf package — domain + persistence)
  schema.ts        MissionRequestSchema, MissionTargetSchema, QueuedMissionSchema, Budget
  target-store.ts  MissionTargetStore (interface) + FsMissionTargetStore
  target-registry.ts  MissionTargetRegistry (promoted-only .resolve(id))
  queue-store.ts   MissionQueueStore (interface) + FsMissionQueueStore
  enqueue.ts       enqueueMission() — the ONE function that validates + resolves + bounds-checks + writes
  bounds.ts        MISSION_BOUNDS_CEILING (maxActions=60, maxDecisions=120, maxCandidates=250)
  errors.ts        UnknownOrUnpromotedMissionTargetError, BudgetExceedsCeilingError
  index.ts         barrel

@jevitate/mcp-facade                        (existing — additive only)
  tools.ts         + "queue_exploration" in ALLOWED_TOOLS
  mission-tools.ts (NEW) queueExploration() — thin pass-through to enqueueMission()
  mission-invariants.test.ts (NEW) — one asserts-it-refuses test per guardrail
  boundary.test.ts (extended) — queue_exploration present, forbidden tools still absent
```

Dependency direction: `@jevitate/missions` depends only on `@jevitate/recording` (for `Assertion`/`AssertionSchema`) + `zod` + Node builtins — a leaf, exactly like `@jevitate/journey`. `@jevitate/mcp-facade` gains one new dependency, `@jevitate/missions`. Nothing depends on `@jevitate/mcp-facade` (unchanged). `@jevitate/explore` (future) does not appear anywhere in this plan's dependency graph.

## Design decisions (resolved here — the ticket text alone underspecifies these)

1. **What "unknown/unpromoted target" means.** The ticket says `queue_exploration({ goal|feature|route, successAssertion, strategy, budget })` but also "refuses unknown/unpromoted targets" — there is no bare `target` field in the ticket's own signature. Accepting an arbitrary URL/origin directly in an MCP tool call would mean the facade itself picks the browser's blast radius, which is exactly what invariant #5 forbids for Journeys ("published-id-only, never inline"). Resolution: `queue_exploration` takes a **`target: string`** naming a pre-declared `MissionTarget` (id → `{ authorizedOrigin, baseUrl }`, `promoted: boolean`), managed the same way a Journey is managed (an operator registers/promotes it out-of-band; the MCP surface only ever resolves an id). This is the direct MCP-facing analogue of `@jevitate/explore`'s planned `assertAuthorizedExploreTarget` allowlist (guardrail #1 in the exploration-engine plan) — when the engine ships, a `MissionTarget`'s `authorizedOrigin` is exactly what gets threaded into that guard. `goal`/`feature`/`route` remain free-text **content** describing what to test **against** that target; exactly one of the three is required.
2. **The queue is inert.** `queue_exploration` writes a `QueuedMission` (`status: "queued"`) to `@jevitate/missions`' `FsMissionQueueStore` and returns immediately. It does **not** invoke `@jevitate/explore`, spawn a browser, or block on mission completion — "enqueues", not "runs", per the ticket title. A consumer that drains the queue and runs missions through the P1/P2 engine is explicit **out of scope** (tracked by the exploration-engine plan, once that engine exists).
3. **`strategy` enum is deliberately narrow.** Only `"goal-based"` is accepted (the only mission type that exists per ticket #1/P1). `"adversarial"`/`"induction"` are **not** in the schema at all yet — passing them is an out-of-schema refusal (zod rejects), not a soft "not implemented" response. When P2 ships those mission types, extending the `z.enum`/discriminated union is an additive schema change in `@jevitate/missions` (tracked as a Risk below, not resolved here).
4. **Budget is a ceiling, never a request for more.** The spec's "hard bounds (defaults): ~60 actions / ~120 decisions / ≤250 candidates" are treated as **the ceiling itself**, not a default with headroom above it. `budget` is optional; when provided, any field exceeding `MISSION_BOUNDS_CEILING` is a **fail-closed refusal** (`BudgetExceedsCeilingError`) — never silently clamped down. Silent clamping would both violate "bounded + fail-closed" (the caller wouldn't know their request was downgraded) and would trip `scripts/check-no-permissive-fallback.mjs`'s spirit (an error condition quietly turned into a different, smaller success). Omitted budget fields default to the ceiling values.
5. **No MCP `Server` wiring.** Matching `find_capabilities`/`run_journey`/`ai_generate_text`'s current state, this plan stops at a tested pure function + allowlist entry. Binding it to a live `@modelcontextprotocol/sdk` transport is a separate, not-yet-scheduled slice that will wire all four tools at once — doing it here alone would be inconsistent with its siblings and is not blocking for this ticket's acceptance criteria (an allowlisted, validated, fail-closed domain-tool function).

## Guardrails (binding — each ships an "asserts-it-refuses" test)

1. **No raw browser tools ever cross.** `queue_exploration` never accepts inline steps, a raw URL to visit, or a selector — only `target` (a resolved id), free-text goal/feature/route, a structured `Assertion`, `strategy`, and `budget`.
2. **Unknown/unpromoted target → refuse.** `MissionTargetRegistry.resolve` throws `UnknownOrUnpromotedMissionTargetError` for a missing id or `promoted: false`; `enqueueMission` never falls back to treating the raw string as a URL.
3. **Out-of-schema params → refuse.** `MissionRequestSchema` is `.strict()`; an unknown top-level key, an unsupported `strategy` value, or zero/multiple of `goal`/`feature`/`route` all fail `.parse()`.
4. **Budget ceiling → refuse, never clamp.** A `budget` field above `MISSION_BOUNDS_CEILING` throws `BudgetExceedsCeilingError` before any write.
5. **Fail-closed, no partial writes.** `FsMissionQueueStore.enqueue` validates the fully-resolved `QueuedMission` against `QueuedMissionSchema` **before** any disk I/O (mirrors `FsJourneyStore.put`).
6. **Behind the allowlist.** `queue_exploration` is in `ALLOWED_TOOLS` and in no world does it, or its presence, expose any `FORBIDDEN_TOOLS` name.

## Tech Stack

TypeScript (strict, ES2022, NodeNext), Vitest, pnpm workspaces, zod (already a dependency of sibling packages — matches `@jevitate/sources`' `"zod": "^4.6.5"`). No new external dependency.

## Global Constraints

- Node 20+, ESM, `strict: true`, TS project references (`tsc --build`) — extend `tsconfig.base.json`.
- Run tests with `pnpm exec vitest run <path>` — **never** `pnpm --filter <pkg> test` (no package has a `"test"` script).
- Git staging is explicit-path only (`git add <exact files>`), never `-A`/`.`.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Dependency direction stays inward: `@jevitate/missions` depends on `@jevitate/recording` only; `@jevitate/mcp-facade` depends on `@jevitate/missions`; nothing depends on `@jevitate/mcp-facade`.
- Gitflow: branch from `develop`/`dev` (feature branch, e.g. `feature/ticket-8-queue-exploration`), PR back to `dev`, never directly to `main`.

## File Structure

```
packages/missions/
  package.json
  tsconfig.json
  src/
    index.ts                    # barrel
    schema.ts                   # MissionRequestSchema, MissionTargetSchema, QueuedMissionSchema, Budget
    schema.test.ts
    bounds.ts                   # MISSION_BOUNDS_CEILING (pure constant)
    errors.ts                   # UnknownOrUnpromotedMissionTargetError, BudgetExceedsCeilingError
    target-store.ts             # MissionTargetStore interface + FsMissionTargetStore
    target-store.test.ts
    target-registry.ts          # MissionTargetRegistry (promoted-only .resolve)
    target-registry.test.ts
    queue-store.ts               # MissionQueueStore interface + FsMissionQueueStore
    queue-store.test.ts
    enqueue.ts                   # enqueueMission() — the one domain entrypoint
    enqueue.test.ts

packages/mcp-facade/
  package.json                  # + "@jevitate/missions": "workspace:*"
  src/
    tools.ts                    # + "queue_exploration" in ALLOWED_TOOLS
    mission-tools.ts            # NEW — queueExploration()
    mission-tools.test.ts       # NEW
    mission-invariants.test.ts  # NEW — one asserts-it-refuses test per guardrail #1-#6
    boundary.test.ts            # extended
    index.ts                    # + export * from "./mission-tools.js"

packages/recording/
  src/schema.ts                 # AssertionSchema: add `export`
  src/schema.test.ts            # + AssertionSchema parse/reject test

tsconfig.json                   # + { "path": "packages/missions" }
vitest.config.ts                # + "@jevitate/missions": pkg("missions")
```

---

## Tasks

Each task: write the test first (TDD), then the implementation, then `pnpm exec vitest run <path>`; commit with the trailer.

### Task 1: Export `AssertionSchema` from `@jevitate/recording`
- [ ] `packages/recording/src/schema.test.ts`: add a test asserting `AssertionSchema.parse({ kind: "urlIncludes", text: "/checkout" })` succeeds and `AssertionSchema.parse({ kind: "bogus" })` throws.
- [ ] `packages/recording/src/schema.ts`: change `const AssertionSchema` → `export const AssertionSchema` (line ~153). No other change; `RecordingSchema`'s existing usage is unaffected since it already references the same binding.
- [ ] `pnpm exec vitest run packages/recording/src/schema.test.ts`.

### Task 2: Scaffold `@jevitate/missions`
- [ ] Create `packages/missions/package.json` (mirror `packages/sources/package.json`'s shape: `name: "@jevitate/missions"`, `dependencies: { "@jevitate/recording": "workspace:*", "zod": "^4.6.5" }`, `"scripts": { "build": "tsc --build" }`), `packages/missions/tsconfig.json` (extends `../../tsconfig.base.json`, references `../recording`), `packages/missions/src/index.ts` (empty barrel to start).
- [ ] Add `{ "path": "packages/missions" }` to root `tsconfig.json`'s `references`.
- [ ] Add `"@jevitate/missions": pkg("missions")` to `vitest.config.ts`'s `resolve.alias`.
- [ ] No test for scaffolding itself; verified by Task 3's test resolving the import.

### Task 3: Schema + bounds + errors (pure, no I/O)
- [ ] `packages/missions/src/bounds.test.ts`: `MISSION_BOUNDS_CEILING` equals `{ maxActions: 60, maxDecisions: 120, maxCandidates: 250 }`.
- [ ] `packages/missions/src/bounds.ts`: export the constant (`as const`), typed `Budget = { maxActions: number; maxDecisions: number; maxCandidates: number }`.
- [ ] `packages/missions/src/schema.test.ts`: 
  - `MissionTargetSchema` accepts a well-formed target and rejects an `id` containing `/`, `\`, or `..` (mirror `journey.test.ts`'s id test) and an unknown extra key.
  - `MissionRequestSchema` accepts a request with exactly one of `goal`/`feature`/`route`; rejects zero of the three; rejects two/three of the three; rejects an unknown top-level key; rejects `strategy: "adversarial"` (not yet in the schema); accepts an omitted `budget` (defaults applied downstream, not by the schema itself — schema only bounds-checks a *provided* budget against `MISSION_BOUNDS_CEILING`, see below); rejects a provided `budget.maxActions` above the ceiling **at the schema level is NOT required** — that check lives in `enqueue.ts` so the refusal can carry a clear `BudgetExceedsCeilingError` (a zod refine error is harder for a caller to distinguish from "malformed input"); this test file therefore only asserts the schema's own shape rules, not the ceiling (covered in Task 6).
  - `QueuedMissionSchema` accepts a fully-resolved `QueuedMission` (all budget fields present, `status: "queued"`) and rejects a missing `status`.
- [ ] `packages/missions/src/schema.ts`: 
  - `SAFE_ID_RE` (copy `packages/journey/src/journey.ts`'s regex verbatim — same path-safety rationale, ids are used as filenames).
  - `MissionTargetSchema`/`MissionTarget` (`.strict()`: `id` (SAFE_ID_RE), `name`, `description?`, `authorizedOrigin: string`, `baseUrl: string`, `promoted: boolean`, `createdAtIso: string`).
  - `MissionRequestSchema`/`MissionRequest` (`.strict()`: `target: string`, `goal?: string`, `feature?: string`, `route?: string`, `successAssertion: AssertionSchema`, `strategy: z.literal("goal-based")`, `budget: z.object({ maxActions: z.number().int().positive().optional(), maxDecisions: z.number().int().positive().optional(), maxCandidates: z.number().int().positive().optional() }).strict().optional()`) with `.refine()` enforcing exactly one of `goal`/`feature`/`route` is defined.
  - `QueuedMissionSchema`/`QueuedMission` (`.strict()`: everything from `MissionRequest` minus `budget` being optional — `budget` here is the fully-resolved `Budget`, required — plus `id: string`, `status: z.literal("queued")`, `enqueuedAtIso: string`).
- [ ] `packages/missions/src/errors.ts`: `export class UnknownOrUnpromotedMissionTargetError extends Error {}` and `export class BudgetExceedsCeilingError extends Error {}` (no test file needed — behavior is exercised in Task 6's tests via `instanceof`).
- [ ] `pnpm exec vitest run packages/missions/src/bounds.test.ts packages/missions/src/schema.test.ts`.

### Task 4: Target store + registry (promoted-only, mirrors `@jevitate/journey`)
- [ ] `packages/missions/src/target-store.test.ts`: mirror `packages/journey/src/store.test.ts`'s structure with a `mkdtempSync` dir — `put` then `get` round-trips; `get` on a missing id returns `null`; `put` rejects an invalid `MissionTargetSchema` before writing (assert the file was never created); `list` skips a hand-corrupted JSON file rather than throwing.
- [ ] `packages/missions/src/target-store.ts`: `MissionTargetStore` interface (`get`/`put`/`list`) + `FsMissionTargetStore` — copy `FsJourneyStore`'s implementation shape verbatim (same `assertSafeId`, same `isNodeError` ENOENT handling, same `mode: 0o600`/`0o700`), swapping `Journey`/`JourneySchema` for `MissionTarget`/`MissionTargetSchema`.
- [ ] `packages/missions/src/target-registry.test.ts`: `.resolve("known-promoted")` returns the target; `.resolve("known-unpromoted")` throws `UnknownOrUnpromotedMissionTargetError`; `.resolve("nonexistent")` throws the same error (the error message must not distinguish "exists but unpromoted" from "doesn't exist" — this is the same non-distinguishing refusal `runJourney` uses for unknown/unpublished journeys, so an untrusted caller can't enumerate which targets exist).
- [ ] `packages/missions/src/target-registry.ts`: `MissionTargetRegistry` wrapping `MissionTargetStore`, exposing `resolve(id): Promise<MissionTarget>` (throws per above), `put(t): Promise<void>`, `promote(id): Promise<void>` (mirrors `JourneyRegistry.promote`, for future CLI target management — not wired to a CLI command in this plan).
- [ ] `pnpm exec vitest run packages/missions/src/target-store.test.ts packages/missions/src/target-registry.test.ts`.

### Task 5: Queue store
- [ ] `packages/missions/src/queue-store.test.ts`: mirror Task 4's store tests — `enqueue` then `get` round-trips; `enqueue` validates `QueuedMissionSchema` before writing (an invalid record throws and writes nothing); `list` returns all queued missions; a mission id is also SAFE_ID_RE-constrained (generated ids must satisfy it — covered by Task 6 using a real id generator).
- [ ] `packages/missions/src/queue-store.ts`: `MissionQueueStore` interface (`enqueue`/`get`/`list`) + `FsMissionQueueStore`, same shape as `FsMissionTargetStore`.
- [ ] `pnpm exec vitest run packages/missions/src/queue-store.test.ts`.

### Task 6: `enqueueMission` — the one domain entrypoint
- [ ] `packages/missions/src/enqueue.test.ts`:
  - Happy path: a valid request against a promoted target with no `budget` produces a `QueuedMission` with `status: "queued"`, `budget` filled from `MISSION_BOUNDS_CEILING`, a generated `id` matching `SAFE_ID_RE`, and it is retrievable from the queue store afterward.
  - Refuses an unknown target id (`UnknownOrUnpromotedMissionTargetError`, queue store never called — assert via a spy).
  - Refuses an unpromoted target id (same error, same non-call assertion).
  - Refuses `budget.maxActions` (and independently `maxDecisions`, `maxCandidates`) above `MISSION_BOUNDS_CEILING` (`BudgetExceedsCeilingError`, thrown **before** target resolution or any write — assert via spies on both the registry and the queue store).
  - Refuses a schema-invalid request (e.g. two of `goal`/`feature`/`route`, or an unknown top-level key) — the underlying zod error propagates, target registry and queue store both never called.
  - Accepts a partial `budget` (e.g. only `maxActions` provided, below ceiling) — the omitted fields default to the ceiling, not to zero/undefined.
- [ ] `packages/missions/src/enqueue.ts`: 
  ```ts
  export async function enqueueMission(
    targets: MissionTargetRegistry,
    queue: MissionQueueStore,
    rawRequest: unknown,
    deps: { idGen?: () => string; clock?: () => string } = {},
  ): Promise<QueuedMission> {
    const request = MissionRequestSchema.parse(rawRequest); // schema refusal first — no I/O yet
    const budget = resolveBudget(request.budget); // throws BudgetExceedsCeilingError before any lookup
    const target = await targets.resolve(request.target); // throws UnknownOrUnpromotedMissionTargetError
    const mission: QueuedMission = {
      ...request,
      id: (deps.idGen ?? (() => crypto.randomUUID()))(),
      status: "queued",
      enqueuedAtIso: (deps.clock ?? (() => new Date().toISOString()))(),
      budget,
    };
    await queue.enqueue(mission); // FsMissionQueueStore re-validates via QueuedMissionSchema before writing
    return mission;
  }
  ```
  (`target` is resolved for its side-effect of refusing unknown/unpromoted ids and is intentionally not otherwise merged into `mission` — the queued record stays a request-shaped artifact; a future consumer re-resolves the target at run time so a target's promotion state is always checked fresh, matching the Journey pattern where `run_journey` re-checks `promoted` at run time rather than trusting a value cached at enqueue time.)
- [ ] `pnpm exec vitest run packages/missions/src/enqueue.test.ts`.

### Task 7: `@jevitate/missions` barrel + package wiring
- [ ] `packages/missions/src/index.ts`: `export * from "./schema.js"`, `"./bounds.js"`, `"./errors.js"`, `"./target-store.js"`, `"./target-registry.js"`, `"./queue-store.js"`, `"./enqueue.js"`.
- [ ] `pnpm exec vitest run packages/missions` (whole-package sanity pass).
- [ ] `git add packages/missions/package.json packages/missions/tsconfig.json packages/missions/src tsconfig.json vitest.config.ts` (explicit paths); commit: `feat(missions): add @jevitate/missions — mission request schema, target registry, queue store`.

### Task 8: `mcp-facade` — `queue_exploration` tool
- [ ] `packages/mcp-facade/package.json`: add `"@jevitate/missions": "workspace:*"` to `dependencies`.
- [ ] `packages/mcp-facade/src/mission-tools.test.ts`:
  - With fake in-memory `MissionTargetRegistry`/`MissionQueueStore` (or real `Fs*` backed by `mkdtempSync`, matching `named-tools.test.ts`'s style) seeded with one promoted target: `queueExploration(...)` with a valid goal-based request returns `{ ok: true, missionId, status: "queued" }` and the mission is present in the queue store afterward.
  - Propagates `UnknownOrUnpromotedMissionTargetError` for an unpromoted/unknown target (assert via `.rejects.toBeInstanceOf(...)`, matching `journey-tools.test.ts`'s existing style for `runJourney`'s unknown-journey case).
  - Propagates `BudgetExceedsCeilingError` for an over-ceiling budget.
- [ ] `packages/mcp-facade/src/mission-tools.ts`:
  ```ts
  import { enqueueMission, type MissionTargetRegistry, type MissionQueueStore } from "@jevitate/missions";

  export interface QueueExplorationResult { ok: true; missionId: string; status: "queued" }

  /**
   * Invariant #5/#6 analogue for missions: resolves a PROMOTED target by id
   * only, refuses out-of-schema params and over-ceiling budgets, and never
   * runs anything — it only enqueues. All validation is delegated to
   * `enqueueMission` (never duplicated here), matching `runJourney`'s shape.
   */
  export async function queueExploration(
    targets: MissionTargetRegistry,
    queue: MissionQueueStore,
    args: unknown,
  ): Promise<QueueExplorationResult> {
    const mission = await enqueueMission(targets, queue, args);
    return { ok: true, missionId: mission.id, status: "queued" };
  }
  ```
- [ ] `packages/mcp-facade/src/tools.ts`: add `"queue_exploration"` to `ALLOWED_TOOLS` (after `"ai_generate_text"`).
- [ ] `packages/mcp-facade/src/index.ts`: add `export * from "./mission-tools.js";`.
- [ ] `packages/mcp-facade/src/boundary.test.ts`: extend the existing "facade exposes the two-level journey tools" test (or add a sibling test) asserting `names.has("queue_exploration")` is `true` alongside the existing forbidden-tools-absent assertions.
- [ ] `pnpm exec vitest run packages/mcp-facade/src/mission-tools.test.ts packages/mcp-facade/src/boundary.test.ts`.

### Task 9: Invariant refusal contract
- [ ] `packages/mcp-facade/src/mission-invariants.test.ts` (mirrors `packages/runtime/src/slice1-invariants.test.ts`'s structure — one readable file, one test per guardrail, reusing Task 8's real (not re-mocked) `queueExploration`):
  1. Unknown target → refuses (`UnknownOrUnpromotedMissionTargetError`), queue store never written to.
  2. Unpromoted target → refuses, same error, same non-write assertion.
  3. Out-of-schema param (extra top-level key) → refuses (zod error), nothing written.
  4. Unsupported `strategy` value (`"adversarial"`) → refuses (zod error) — proves P2 mission types can't sneak through before their schema lands.
  5. `budget` above `MISSION_BOUNDS_CEILING` → refuses (`BudgetExceedsCeilingError`), nothing written.
  6. `queue_exploration` is present in `ALLOWED_TOOLS`; none of `FORBIDDEN_TOOLS` (`browser_click`, `browser_fill`, `page_evaluate`, `run_selector`, `navigate_url`, `get_dom`, `get_cookies`) are reachable from `mcp-facade`'s exports at all — assert `typeof (await import("./index.js"))[forbiddenName] === "undefined"` for each forbidden name, proving the facade doesn't merely omit them from the allowlist but exports no such function.
- [ ] `pnpm exec vitest run packages/mcp-facade/src/mission-invariants.test.ts`.
- [ ] `git add packages/mcp-facade/package.json packages/mcp-facade/src/mission-tools.ts packages/mcp-facade/src/mission-tools.test.ts packages/mcp-facade/src/mission-invariants.test.ts packages/mcp-facade/src/tools.ts packages/mcp-facade/src/index.ts packages/mcp-facade/src/boundary.test.ts` (explicit paths); commit: `feat(mcp-facade): add queue_exploration to the allowlist (ticket #8)`.

### Task 10: Full-suite regression + exit gate
- [ ] `pnpm exec vitest run` (whole repo) — confirms Task 1's `AssertionSchema` export change doesn't regress `@jevitate/recording`'s existing consumers.
- [ ] `node scripts/check-no-permissive-fallback.mjs` — confirms no permissive-fallback pattern was introduced (relevant here because `resolveBudget`'s ceiling defaulting must be a genuine default-when-omitted, never a silent-downgrade-when-over-ceiling — Task 6 already tests this behaviorally; this is the static-analysis backstop).
- [ ] `pnpm --filter '*' build` or `tsc --build` at the root — confirms the new project reference compiles.

**Acceptance:** `queueExploration` (a) is reachable only via `ALLOWED_TOOLS`, (b) resolves `target` against a promoted-only registry and refuses unknown/unpromoted ids, (c) refuses any out-of-schema param including unsupported `strategy` values, (d) refuses a budget above the hard ceiling, (e) on success writes exactly one `QueuedMission` (`status: "queued"`) and never touches a browser, and (f) every one of (b)-(d) has a passing "asserts-it-refuses" test in `mission-invariants.test.ts`.

## Out of scope (explicitly deferred)

- **Running a queued mission.** Draining `FsMissionQueueStore` and executing missions through `@jevitate/explore` is P1/P2 work in the exploration-engine plan, once that package exists. This plan's `queue_exploration` only writes the queue; nothing reads it yet.
- **`propose_missions({ diff|story })`.** The exploration-engine spec mentions this as an "optionally" — it's LLM-driven mission *proposal* from a diff/story, which is exactly the `jevitate-mission-scope` skill's job (see `docs/superpowers/plans/2026-09-20-skill-set-and-init.md`), not a new MCP tool. The skill calls `queue_exploration` (this tool) once it has decided what to test; it does not need its own tool.
- **Live `@modelcontextprotocol/sdk` transport wiring.** Matches the current state of `find_capabilities`/`run_journey`/`ai_generate_text` — a separate slice.
- **CLI commands to manage `MissionTarget`s** (`jevitate mission-target add/promote/list`). `MissionTargetRegistry.put`/`.promote` exist and are tested; wiring a CLI subcommand to them is a small additive follow-up, not needed for this ticket's acceptance criteria (targets can be seeded via `MissionTargetRegistry.put` directly in integration tests / by an operator script in the interim).

## Risks / open decisions

- **Budget-ceiling single source of truth.** `MISSION_BOUNDS_CEILING` in `@jevitate/missions` duplicates the numeric defaults the exploration-engine plan's `bounds.ts` (Task 1 of that plan) will also define. Until one imports from the other, a future change to one without the other silently diverges. Recommended resolution (not applied here, to avoid taking on a dependency on a package that doesn't exist yet): when `@jevitate/explore` ships, its `bounds.ts` should `import { MISSION_BOUNDS_CEILING } from "@jevitate/missions"` and derive its own `Bounds` from it, making `@jevitate/missions` the canonical source (it is the smaller, more foundational leaf).
- **`strategy` enum growth.** Extending `MissionRequestSchema`'s `strategy` literal to a union as P2 mission types (`adversarial`, `induction`) ship is a schema-only change, but every such change needs a corresponding new "unsupported strategy refused" test to be *removed and replaced* by a "supported strategy accepted" test — a reviewer should specifically check this plan's Task 9.4 test gets updated (not just added-to) when that happens, or it'll assert something false.
- **Target lifecycle has no CLI yet.** `MissionTargetRegistry` is fully built and tested but has no operator-facing way to create/promote a target except calling the TS API directly (see Out of scope). This is a real gap for anyone trying to use `queue_exploration` end-to-end today; flagging it rather than silently scoping it in, since adding a CLI subcommand was not part of ticket #8's stated surface.
- **Non-distinguishing refusal message.** Task 4 requires `resolve()` to give the same error/message for "target doesn't exist" and "target exists but unpromoted" (avoids id enumeration by an untrusted caller). Double-check this doesn't make legitimate debugging harder for the operator managing targets — if it does, a *separate*, higher-trust `MissionTargetRegistry.getRaw(id)` (bypassing the promoted gate, never exposed through `mcp-facade`) would be the right escape hatch, not weakening `resolve()`'s message.
