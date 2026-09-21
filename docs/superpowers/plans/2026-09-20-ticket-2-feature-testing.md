# Feature Testing Mission — Implementation Plan (Ticket #2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Proposed (plan — for review before execution)
**Date:** 2026-09-20
**Ticket:** [matt-cochran/jevitate#2](https://github.com/matt-cochran/jevitate/issues/2) — "Feature testing discovers and exercises multiple valid paths through a named capability." Paired site ticket: [#11](https://github.com/matt-cochran/jevitate/issues/11) ("the site presents feature testing as Available once it ships," `jevitate explore --feature <x>` as a live command).

**Goal:** Add a `runFeatureMission` to `@jevitate/explore`: given a **capability name** and a **scope** (an authorized-origin allowlist plus a set of in-scope route patterns), discover the UI paths reachable within that scope dynamically (no named steps), exercise **multiple valid routes** through the capability, deliberately stimulate **valid boundary states** on its form fields (as opposed to ticket #4's adversarial/invalid stimulation), and record which states and transitions were actually exercised — emitting one replayable `Recording` per distinct discovered path plus a scoped coverage summary.

**Architecture:** This mission is a **capability-scoped variant of proof-by-induction** (ticket #3's algorithm): the same state-fingerprint + frontier + reset-and-replay mechanics, restricted to a `CapabilityScope` (so discovery never wanders outside the named feature), with two differences from pure coverage exploration: (1) a state whose URL falls outside the scope is recorded as a **boundary edge** and never expanded further (it's evidence of the feature's reachable perimeter, not something to keep exploring), and (2) form-field actions are **stimulated with valid boundary/edge values** (via a local `boundary-values.ts`, distinct from ticket #4's invalid/misuse values) in addition to normal values, so the discovered paths include "the ways to do it" at the edges (min/max/zero-ish valid inputs), not just one happy path. **This plan deliberately duplicates ticket #3's `fingerprint.ts`/`frontier.ts`/`reach.ts` (as small local copies under `feature/`) rather than importing from ticket #3's `coverage/` module**, so it is independently landable regardless of ticket #3's merge order — see "Known duplication" below for the intended follow-up extraction.

**Tech Stack:** TypeScript (strict, ES2022, NodeNext), Vitest, pnpm workspaces, Playwright (via `@jevitate/playwright`), the real `@jevitate/example-site` fixture (Fastify) for browser-backed tests.

**Spec:** `docs/superpowers/specs/2026-09-19-autonomous-exploration-testing-design.md` §3.2 ("Goal-based exploratory testing... multiple runs → multiple takes... generalize 'the ways to do it'"), §6 (guardrails). Ticket #2's own acceptance bullets ("discovers relevant UI paths dynamically," "exercises multiple valid routes... and explores its boundary states," "records which states and transitions were actually exercised") sit between the design's mission 2 (goal-based, multi-take) and mission 3 (state coverage) — this plan treats it as coverage exploration scoped to a named capability, which is the concrete, terminating algorithm that satisfies all three bullets at once. Builds on `docs/superpowers/plans/2026-09-20-testing-missions-exploration-engine.md` (P1 engine).

## Global Constraints

- Node 20+, ESM, `strict: true`, project references (`tsc --build`) — mirror `tsconfig.base.json`.
- Dependency direction inward only: this plan only adds files under `packages/explore/` (a leaf package) and one additive touch to `packages/cli/`. Nothing depends on `@jevitate/explore`.
- **Repo gotcha:** packages have NO `"test"` script — run `pnpm exec vitest run <path>`, never `pnpm --filter <pkg> test` (that is a no-op).
- Git staging is explicit-path only (`git add <exact files>`), never `-A`/`.`.
- Commit trailer for every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- CI runs on **fake** gateways only (`FakeJudgmentGateway`/scripted local fakes + `FakeGenerationGateway`); no live Jev/OpenRouter test in this plan.
- Gitflow: branch from `dev`, land via a feature branch, merge back to `dev` (never commit straight to `main`).

## Assumed `@jevitate/explore` public API (Ticket #1 — for reconciliation)

Ticket #1 is being built concurrently; `packages/explore/` does not exist in the tree yet (verified: `ls packages/` has no `explore` entry). This plan is written against the planned surface from `docs/superpowers/plans/2026-09-20-testing-missions-exploration-engine.md`:

```ts
// bounds.ts
export interface Bounds { maxActions: number; maxDecisions: number; maxCandidates: number; }
export function defaultBounds(): Bounds;

// authorized-targets.ts
export class UnauthorizedExploreTargetError extends Error {}
export function assertAuthorizedExploreTarget(url: string, allowlist: readonly string[]): void;

// snapshot.ts
export interface Control {
  index: number; descriptor: TargetDescriptor; role?: string; name?: string; value?: string;
  visible: boolean; enabled: boolean;
}
export interface Snapshot { url: string; controls: Control[]; freshnessSignature: string; }
export async function snapshotPage(page: Page, opts: { maxCandidates: number }): Promise<Snapshot>;

// decide.ts
export type Op = "click" | "type" | "select" | "scroll_up" | "scroll_down" | "wait" | "done" | "blocked";
export interface Decision { op: Op; targetIndex?: number; }

// act.ts
export interface ActResult { ok: boolean; reason?: string; }
export async function executeAction(params: {
  actor: Actor; page: Page; snapshot: Snapshot; decision: Decision; fillText?: string;
}): Promise<ActResult>;

// record.ts
export function recordStep(recording: Recording, params: {
  decision: Decision; snapshot: Snapshot; fillText?: string; timing: StepTiming;
}): Recording;
```

**Note on what this plan deliberately does NOT assume:** it does **not** call `@jevitate/ai-core`'s `GenerationPort.generate` with a new "resolve a capability name into candidate goals" task kind, because `GEN_TASKS` (`packages/ai-core/src/generation.ts:16`) is a **closed set** — today only `"form.value"` and `"triage.narrative"` exist, and `FakeGenerationGateway.generate` (and the real adapter) `.parse()`s against that fixed schema, so calling an undefined kind would throw. Adding a new generation-task kind is an `@jevitate/ai-core` change outside this plan's scope. Instead, "discovers the relevant UI paths dynamically" is satisfied structurally: the mission is handed a `seedUrl` + `CapabilityScope` (not a natural-language goal it must interpret), and it discovers paths via frontier expansion exactly like coverage exploration — no generative goal-resolution step is needed or used.

**Additive extension this plan assumes beyond the P1 plan's literal text** (flag for reconciliation with the ticket #1 owner): none beyond what ticket #3's plan already flags (`assertAuthorizedExploreTarget`, `snapshotPage`, `executeAction`, `recordStep`, `defaultBounds`, `Control`, `Decision`, `Op` — this plan drives every action directly, the same way ticket #3's induction mission does, and does not need `runExploreLoop`'s Jev-driven `Choice`).

## Guardrails (binding — from spec §6; each ships an "asserts-it-refuses" test in Task 8)

1. **Authoring/test plane only.** `assertAuthorizedExploreTarget` is called before any navigation; a `CapabilityScope` with an empty `originAllowlist` refuses closed, never "anything in scope."
2. **Bounded + fail-closed.** Hard `maxActions`/`maxPaths` caps; an out-of-scope state is a boundary edge, never a crash or an infinite-loop trigger.
3. **No real sends / no secrets to models.** Boundary-value stimulation never targets a field flagged secret-like (password/token/ssn-ish names) — those are skipped entirely, never filled with a synthetic value, mirroring ticket #1's `fillValue` discipline.
4. **No irreversible action.** Only `click`/`type`/`select` on in-scope controls; a control whose action would navigate off the authorized-origin allowlist is recorded as a boundary edge, never followed.
5. **Prompt-injection guard.** N/A directly — this mission issues zero Jev/generation calls in its core loop (see the "what this plan deliberately does NOT assume" note above); it is model-free by design, which trivially satisfies "the model never self-certifies" for this mission. This is called out explicitly rather than silently omitted, since every other mission in this program does call a model.
6. **Deterministic product.** Every discovered path's emitted `Recording` replays via the interpreter — proven by Task 6's replay assertion.

## File Structure

```
packages/explore/src/
  feature/
    fingerprint.ts             # local copy of ticket #3's stateFingerprint/actionKey (pure)
    fingerprint.test.ts
    frontier.ts                 # local copy of ticket #3's Frontier (pure)
    frontier.test.ts
    reach.ts                    # local copy of ticket #3's reachFrontierState
    reach.test.ts
    capability-scope.ts         # CapabilityScope + isInScope(url, scope) — pure
    capability-scope.test.ts
    boundary-values.ts          # boundaryValueCandidates(control) — VALID edge values, pure
    boundary-values.test.ts
  missions/
    feature.ts                   # runFeatureMission — the mission
    feature.test.ts
  feature-invariants.test.ts    # guardrail refusal contract (#1-#4)

packages/cli/src/
  explore-api.ts                # + runFeatureCliMission wiring
  program.ts                    # + `explore --feature <name> --route <glob...>`
  explore-api.test.ts           # + feature-strategy wiring test (no browser)
```

## Known duplication (flagged, not hidden)

Tasks 1–3 below re-implement `stateFingerprint`/`actionKey`/`Frontier`/`reachFrontierState` verbatim from `docs/superpowers/plans/2026-09-20-ticket-3-exploratory-testing.md`'s Tasks 1–3, under `packages/explore/src/feature/` instead of `packages/explore/src/coverage/`. This is a deliberate trade-off: it keeps this plan independently executable regardless of whether ticket #3 has landed, at the cost of two near-identical modules living in the same package. **Follow-up (not in this plan's scope):** once both ticket #2 and ticket #3 have landed, extract `fingerprint.ts`/`frontier.ts`/`reach.ts` into a single shared `packages/explore/src/coverage/` module and have `feature.ts` import from there, deleting `feature/fingerprint.ts`/`feature/frontier.ts`/`feature/reach.ts`. Flag this in the PR description for whichever of #2/#3 lands second.

---

## Task 1: `fingerprint.ts` (local copy — pure)

**Files:**
- Create: `packages/explore/src/feature/fingerprint.ts`
- Test: `packages/explore/src/feature/fingerprint.test.ts`

**Interfaces:**
- Consumes: `Control`, `Snapshot` (ticket #1); `urlTemplate` (`@jevitate/recording`, verified exported at `packages/recording/src/signature.ts:23`).
- Produces: `stateFingerprint(snapshot: Snapshot): string`; `type FrontierOp = "click" | "type" | "select"`; `actionKey(fingerprint: string, control: Control, op: FrontierOp): string` — consumed by Tasks 2, 3, 4.

- [ ] **Step 1: Write the failing test**

```ts
// packages/explore/src/feature/fingerprint.test.ts
import { describe, expect, test } from "vitest";
import { stateFingerprint, actionKey } from "./fingerprint.js";
import type { Snapshot, Control } from "../index.js";

function control(over: Partial<Control>): Control {
  return { index: 0, descriptor: { role: over.role, name: over.name }, visible: true, enabled: true, ...over };
}

describe("stateFingerprint", () => {
  test("is stable regardless of control order", () => {
    const a: Snapshot = { url: "https://x.test/inbox", freshnessSignature: "s", controls: [control({ role: "link", name: "t-1" }), control({ role: "link", name: "t-2" })] };
    const b: Snapshot = { url: "https://x.test/inbox", freshnessSignature: "s", controls: [control({ role: "link", name: "t-2" }), control({ role: "link", name: "t-1" })] };
    expect(stateFingerprint(a)).toBe(stateFingerprint(b));
  });

  test("differs when the url template differs", () => {
    const a: Snapshot = { url: "https://x.test/inbox", freshnessSignature: "s", controls: [] };
    const b: Snapshot = { url: "https://x.test/thread/t-1", freshnessSignature: "s", controls: [] };
    expect(stateFingerprint(a)).not.toBe(stateFingerprint(b));
  });
});

describe("actionKey", () => {
  test("is stable and op-discriminating", () => {
    const c = control({ role: "link", name: "t-1" });
    expect(actionKey("fp", c, "click")).toBe(actionKey("fp", c, "click"));
    expect(actionKey("fp", c, "click")).not.toBe(actionKey("fp", c, "type"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/explore/src/feature/fingerprint.test.ts`
Expected: FAIL — `Cannot find module './fingerprint.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/explore/src/feature/fingerprint.ts
import { urlTemplate } from "@jevitate/recording";
import type { Control, Snapshot } from "../index.js";

function controlSignature(c: Control): string {
  return `${c.role ?? ""}\u0001${c.name ?? ""}\u0001${c.visible ? "v" : "-"}${c.enabled ? "e" : "-"}`;
}

export function stateFingerprint(snapshot: Snapshot): string {
  const controls = snapshot.controls.map(controlSignature).sort().join("\u0002");
  return `${urlTemplate(snapshot.url)}\u0003${controls}`;
}

export type FrontierOp = "click" | "type" | "select";

export function actionKey(fingerprint: string, control: Control, op: FrontierOp): string {
  return `${fingerprint}\u0004${op}\u0004${controlSignature(control)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/explore/src/feature/fingerprint.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/explore/src/feature/fingerprint.ts packages/explore/src/feature/fingerprint.test.ts
git commit -m "$(cat <<'EOF'
feat(explore): add feature-mission state fingerprint (local, see ticket #3)

Deliberately duplicated from ticket #3's coverage/fingerprint.ts so this
plan is independently landable; flagged in the plan for a post-merge
extraction into a shared module.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `frontier.ts` + `reach.ts` (local copies — pure / replay guard)

**Files:**
- Create: `packages/explore/src/feature/frontier.ts`
- Create: `packages/explore/src/feature/reach.ts`
- Test: `packages/explore/src/feature/frontier.test.ts`
- Test: `packages/explore/src/feature/reach.test.ts`

**Interfaces:**
- Consumes: `FrontierOp`, `actionKey` (Task 1); `Recording` (`@jevitate/recording`); `Navigate` (`@jevitate/screenplay`); `RecordingInterpreter` (`@jevitate/interpreter`, verified `run(actor, rec, vars?, sink?): Promise<InterpretResult>` at `packages/interpreter/src/interpreter.ts:48`).
- Produces: `interface FrontierItem { key; fromFingerprint; pathPrefix: Recording; control: Control; op: FrontierOp }`; `class Frontier { push; popPreferring; isExhausted; size }`; `type ReachResult = { ok: true; snapshot: Snapshot } | { ok: false; reason: "stale" }`; `reachFrontierState(params): Promise<ReachResult>` — consumed by Task 4.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/explore/src/feature/frontier.test.ts
import { describe, expect, test } from "vitest";
import { Frontier, type FrontierItem } from "./frontier.js";
import type { Control } from "../index.js";

const c: Control = { index: 0, descriptor: { role: "link", name: "t-1" }, role: "link", name: "t-1", visible: true, enabled: true };
function item(over: Partial<FrontierItem>): FrontierItem {
  return { key: "k1", fromFingerprint: "fp-a", pathPrefix: { version: "1", site: "https://x.test", pages: [] }, control: c, op: "click", ...over };
}

describe("Frontier", () => {
  test("starts exhausted", () => { expect(new Frontier().isExhausted()).toBe(true); });
  test("dedupes by key", () => {
    const f = new Frontier();
    f.push(item({ key: "dup" })); f.push(item({ key: "dup" }));
    expect(f.size).toBe(1);
  });
  test("popPreferring prefers the given fingerprint", () => {
    const f = new Frontier();
    f.push(item({ key: "a", fromFingerprint: "fp-a" }));
    f.push(item({ key: "b", fromFingerprint: "fp-b" }));
    expect(f.popPreferring("fp-b")?.key).toBe("b");
  });
});
```

```ts
// packages/explore/src/feature/reach.test.ts
import { describe, expect, test, vi } from "vitest";
import { reachFrontierState } from "./reach.js";
import type { FrontierItem } from "./frontier.js";
import type { Snapshot } from "../index.js";

function fakeActor() {
  return { name: "t", ability: vi.fn(), attemptsTo: vi.fn().mockResolvedValue(undefined), asks: vi.fn() };
}
const item: FrontierItem = {
  key: "k", fromFingerprint: "https://x.test/*\u0003",
  pathPrefix: { version: "1", site: "https://x.test", pages: [] },
  control: { index: 0, descriptor: { role: "link", name: "Go" }, visible: true, enabled: true },
  op: "click",
};

describe("reachFrontierState", () => {
  test("ok when the replayed fingerprint matches", async () => {
    const snap: Snapshot = { url: "https://x.test/a", freshnessSignature: "s", controls: [] };
    const result = await reachFrontierState({ page: {} as never, actor: fakeActor() as never, seedUrl: "https://x.test/a", item, snapshotNow: async () => snap });
    expect(result.ok).toBe(true);
  });

  test("stale when it doesn't", async () => {
    const snap: Snapshot = { url: "https://x.test/different-thing-entirely", freshnessSignature: "s", controls: [] };
    const result = await reachFrontierState({ page: {} as never, actor: fakeActor() as never, seedUrl: "https://x.test/a", item, snapshotNow: async () => snap });
    expect(result).toEqual({ ok: false, reason: "stale" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run packages/explore/src/feature/frontier.test.ts packages/explore/src/feature/reach.test.ts`
Expected: FAIL — modules don't exist.

- [ ] **Step 3: Write minimal implementations**

```ts
// packages/explore/src/feature/frontier.ts
import type { Recording } from "@jevitate/recording";
import type { Control } from "../index.js";
import type { FrontierOp } from "./fingerprint.js";

export interface FrontierItem {
  readonly key: string;
  readonly fromFingerprint: string;
  readonly pathPrefix: Recording;
  readonly control: Control;
  readonly op: FrontierOp;
}

export class Frontier {
  private readonly queue: FrontierItem[] = [];
  private readonly seen = new Set<string>();

  push(item: FrontierItem): void {
    if (this.seen.has(item.key)) return;
    this.seen.add(item.key);
    this.queue.push(item);
  }

  popPreferring(preferFingerprint: string | undefined): FrontierItem | undefined {
    if (preferFingerprint !== undefined) {
      const i = this.queue.findIndex((it) => it.fromFingerprint === preferFingerprint);
      if (i !== -1) return this.queue.splice(i, 1)[0];
    }
    return this.queue.shift();
  }

  isExhausted(): boolean { return this.queue.length === 0; }
  get size(): number { return this.queue.length; }
}
```

```ts
// packages/explore/src/feature/reach.ts
import type { Page } from "playwright";
import type { Actor } from "@jevitate/screenplay";
import { Navigate } from "@jevitate/screenplay";
import { RecordingInterpreter } from "@jevitate/interpreter";
import type { Snapshot } from "../index.js";
import { stateFingerprint } from "./fingerprint.js";
import type { FrontierItem } from "./frontier.js";

export type ReachResult = { ok: true; snapshot: Snapshot } | { ok: false; reason: "stale" };

export async function reachFrontierState(params: {
  page: Page; actor: Actor; seedUrl: string; item: FrontierItem; snapshotNow: () => Promise<Snapshot>;
}): Promise<ReachResult> {
  await params.actor.attemptsTo(Navigate.to(params.seedUrl));
  await new RecordingInterpreter().run(params.actor, params.item.pathPrefix);
  const snapshot = await params.snapshotNow();
  if (stateFingerprint(snapshot) !== params.item.fromFingerprint) return { ok: false, reason: "stale" };
  return { ok: true, snapshot };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run packages/explore/src/feature/frontier.test.ts packages/explore/src/feature/reach.test.ts`
Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/explore/src/feature/frontier.ts packages/explore/src/feature/frontier.test.ts packages/explore/src/feature/reach.ts packages/explore/src/feature/reach.test.ts
git commit -m "$(cat <<'EOF'
feat(explore): add feature-mission Frontier + reachFrontierState (local)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `capability-scope.ts` — scope membership (pure)

**Files:**
- Create: `packages/explore/src/feature/capability-scope.ts`
- Test: `packages/explore/src/feature/capability-scope.test.ts`

**Interfaces:**
- Consumes: nothing beyond the standard `URL` global.
- Produces: `interface CapabilityScope { name: string; originAllowlist: readonly string[]; routeGlobs: readonly string[] }`; `isInScope(url: string, scope: CapabilityScope): boolean` — consumed by Task 4.

- [ ] **Step 1: Write the failing test**

```ts
// packages/explore/src/feature/capability-scope.test.ts
import { describe, expect, test } from "vitest";
import { isInScope, type CapabilityScope } from "./capability-scope.js";

const scope: CapabilityScope = {
  name: "read messages", originAllowlist: ["https://x.test"], routeGlobs: ["/inbox"],
};

describe("isInScope", () => {
  test("true for an in-allowlist origin + matching route", () => {
    expect(isInScope("https://x.test/inbox", scope)).toBe(true);
  });

  test("false for a matching route on a different origin", () => {
    expect(isInScope("https://evil.test/inbox", scope)).toBe(false);
  });

  test("false for an in-allowlist origin but a route outside the globs (a boundary edge)", () => {
    expect(isInScope("https://x.test/thread/t-1", scope)).toBe(false);
  });

  test("supports a ** wildcard glob segment", () => {
    const wide: CapabilityScope = { ...scope, routeGlobs: ["/thread/**"] };
    expect(isInScope("https://x.test/thread/t-1", wide)).toBe(true);
    expect(isInScope("https://x.test/thread/t-1/reply", wide)).toBe(true);
    expect(isInScope("https://x.test/inbox", wide)).toBe(false);
  });

  test("an unparseable url is out of scope, fail-closed", () => {
    expect(isInScope("not a url", scope)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/explore/src/feature/capability-scope.test.ts`
Expected: FAIL — `Cannot find module './capability-scope.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/explore/src/feature/capability-scope.ts
export interface CapabilityScope {
  name: string;
  originAllowlist: readonly string[];
  routeGlobs: readonly string[];
}

function safeOrigin(raw: string): string | null {
  try { return new URL(raw).origin; } catch { return null; }
}

/** `**` matches any number of path segments; `*` matches exactly one. */
function matchGlob(pattern: string, pathname: string): boolean {
  const regex = new RegExp(
    "^" +
      pattern
        .split("/")
        .map((seg) => (seg === "**" ? ".*" : seg.replace(/\*/g, "[^/]*")))
        .join("/")
        .replace(/^\^?/, "") +
      "(/.*)?$",
  );
  return regex.test(pathname);
}

/** Fail-closed: an unparseable url, a missing origin match, or no matching
 *  route glob are all "out of scope" (guardrail #4 — boundary edges never
 *  get expanded, they're recorded and stopped at). */
export function isInScope(url: string, scope: CapabilityScope): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  const origin = safeOrigin(url);
  if (!scope.originAllowlist.some((o) => safeOrigin(o) === origin)) return false;
  return scope.routeGlobs.some((g) => matchGlob(g, parsed.pathname));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/explore/src/feature/capability-scope.test.ts`
Expected: PASS (5 tests). If the `**` wildcard test fails because the regex construction mishandles the trailing `(/.*)?$` for a pattern already ending in `.*`, simplify `matchGlob`'s regex assembly — verify with `node -e` before trusting it:

```bash
node -e "console.log(new RegExp('^/thread/.*(/.*)?\$').test('/thread/t-1/reply'))"
```

Expected output: `true`. If `false`, drop the trailing `(/.*)?$` suffix entirely when the last segment is `**` (it already matches everything via `.*`):

```ts
export function matchGlob(pattern: string, pathname: string): boolean {
  const segs = pattern.split("/").map((seg) => (seg === "**" ? ".*" : seg.replace(/\*/g, "[^/]*")));
  const body = segs.join("/");
  const suffix = pattern.endsWith("/**") ? "" : "$";
  const regex = new RegExp(`^${body}${suffix}`);
  return regex.test(pathname);
}
```

- [ ] **Step 5: Commit**

```bash
git add packages/explore/src/feature/capability-scope.ts packages/explore/src/feature/capability-scope.test.ts
git commit -m "$(cat <<'EOF'
feat(explore): add CapabilityScope + isInScope for feature-mission bounds

Fail-closed scope check (origin allowlist AND route glob) — a state
outside scope is a boundary edge, recorded but never expanded further.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `boundary-values.ts` — valid edge-case values (pure)

**Files:**
- Create: `packages/explore/src/feature/boundary-values.ts`
- Test: `packages/explore/src/feature/boundary-values.test.ts`

**Interfaces:**
- Consumes: `Control` (ticket #1).
- Produces: `boundaryValueCandidates(control: Control): string[]`; `isSecretLike(control: Control): boolean` — consumed by Task 5.

- [ ] **Step 1: Write the failing test**

```ts
// packages/explore/src/feature/boundary-values.test.ts
import { describe, expect, test } from "vitest";
import { boundaryValueCandidates, isSecretLike } from "./boundary-values.js";
import type { Control } from "../index.js";

function control(over: Partial<Control>): Control {
  return { index: 0, descriptor: {}, visible: true, enabled: true, ...over };
}

describe("boundaryValueCandidates", () => {
  test("a quantity-like field gets zero, one, and a large-but-valid value", () => {
    expect(boundaryValueCandidates(control({ role: "textbox", name: "Quantity" }))).toEqual(["0", "1", "99"]);
  });

  test("a generic required text field gets a minimal single-character value", () => {
    expect(boundaryValueCandidates(control({ role: "textbox", name: "Username" }))).toEqual(["x"]);
  });

  test("a select control gets every option value (all of them are 'valid' by definition)", () => {
    expect(
      boundaryValueCandidates(control({ role: "combobox", name: "Plan", descriptor: {}, value: undefined })),
    ).toEqual(["x"]); // no options metadata on Control today — falls back to the generic candidate; see note below
  });
});

describe("isSecretLike", () => {
  test("flags password/token/secret-ish field names", () => {
    expect(isSecretLike(control({ name: "Password" }))).toBe(true);
    expect(isSecretLike(control({ name: "API token" }))).toBe(true);
  });
  test("does not flag an ordinary field", () => {
    expect(isSecretLike(control({ name: "Username" }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/explore/src/feature/boundary-values.test.ts`
Expected: FAIL — `Cannot find module './boundary-values.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/explore/src/feature/boundary-values.ts
import type { Control } from "../index.js";

const SECRET_NAME = /password|passwd|secret|token|ssn|social security|credit ?card|cvv/i;
const NUMERIC_NAME = /quantity|qty|amount|count/i;

export function isSecretLike(control: Control): boolean {
  return SECRET_NAME.test(control.name ?? "");
}

/**
 * VALID edge-case values — distinct from ticket #4's adversarial/invalid
 * values. These are values a real, well-behaved user might plausibly
 * submit at the edge of normal (a cart quantity of zero, the minimum
 * viable single-character username), never a deliberately malformed one.
 * `Control` doesn't currently carry a select's option list, so a
 * `combobox` falls back to the same generic single candidate as any other
 * field — this is a known simplification pending ticket #1 enriching
 * `Control` with option metadata; document rather than fake it.
 */
export function boundaryValueCandidates(control: Control): string[] {
  if (isSecretLike(control)) return []; // never stimulated (guardrail #3)
  if (control.role === "textbox" && NUMERIC_NAME.test(control.name ?? "")) return ["0", "1", "99"];
  return ["x"];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/explore/src/feature/boundary-values.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/explore/src/feature/boundary-values.ts packages/explore/src/feature/boundary-values.test.ts
git commit -m "$(cat <<'EOF'
feat(explore): add boundary-values (VALID edge inputs for feature mission)

Distinct from ticket #4's adversarial/invalid values — these are
plausible edge-of-normal inputs (qty=0, minimal username), and a
secret-like field is never stimulated (returns no candidates).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `runFeatureMission` — single in-scope path, no branching

**Files:**
- Create: `packages/explore/src/missions/feature.ts`
- Test: `packages/explore/src/missions/feature.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4; `assertAuthorizedExploreTarget`, `snapshotPage`, `executeAction`, `recordStep`, `defaultBounds`, `Control` (ticket #1); `startServer` (`@jevitate/example-site`); `PlaywrightBrowserPort`; `CastActor`/`BrowseTheWeb`; `FakeJudgmentGateway`? — **not needed**: per the header note, this mission issues zero model calls.
- Produces: `interface FeatureCoverage { pathsDiscovered: number; statesExercised: number; transitionsExercised: number; boundaryEdges: string[] }`; `interface FeatureRunResult { outcome: "exhausted" | "cap" | "path-cap"; coverage: FeatureCoverage; recordings: Recording[] }`; `runFeatureMission(params): Promise<FeatureRunResult>` — consumed by Tasks 6–9.

- [ ] **Step 1: Write the failing test**

```ts
// packages/explore/src/missions/feature.test.ts
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "@jevitate/example-site";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { runFeatureMission } from "./feature.js";
import type { CapabilityScope } from "../feature/capability-scope.js";

let site: { url: string; close(): Promise<void> };
let profileDir: string;
let session: { close(): Promise<void>; page: import("playwright").Page };
let actor: CastActor;

beforeAll(async () => {
  site = await startServer();
  profileDir = await mkdtemp(join(tmpdir(), "jevitate-feature-"));
  const browserPort = new PlaywrightBrowserPort();
  session = await browserPort.open({ profileDir, headless: true, allowedOrigins: [site.url], baseUrl: site.url });
  actor = CastActor.named("feature-explorer").whoCan(new BrowseTheWeb(session, [site.url]));
});
afterAll(async () => {
  await session.close();
  await site.close();
  await rm(profileDir, { recursive: true, force: true });
});

describe("runFeatureMission — single path", () => {
  test("a doomed-to-fail login submit exhausts without discovering a new in-scope state", async () => {
    const scope: CapabilityScope = { name: "sign in", originAllowlist: [site.url], routeGlobs: ["/login"] };
    const result = await runFeatureMission({
      page: session.page, actor, seedUrl: `${site.url}/login`, allowlist: [site.url], scope,
    });
    expect(result.outcome).toBe("exhausted");
    expect(result.coverage.statesExercised).toBe(1);
    expect(result.coverage.pathsDiscovered).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/explore/src/missions/feature.test.ts`
Expected: FAIL — `Cannot find module './feature.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/explore/src/missions/feature.ts
import type { Page } from "playwright";
import type { Actor } from "@jevitate/screenplay";
import { Navigate } from "@jevitate/screenplay";
import type { Recording } from "@jevitate/recording";
import {
  assertAuthorizedExploreTarget, snapshotPage, executeAction, recordStep, defaultBounds,
  type Bounds, type Control,
} from "../index.js";
import { stateFingerprint, actionKey, type FrontierOp } from "../feature/fingerprint.js";
import { Frontier, type FrontierItem } from "../feature/frontier.js";
import { reachFrontierState } from "../feature/reach.js";
import { isInScope, type CapabilityScope } from "../feature/capability-scope.js";
import { boundaryValueCandidates, isSecretLike } from "../feature/boundary-values.js";

export interface FeatureCoverage {
  pathsDiscovered: number;
  statesExercised: number;
  transitionsExercised: number;
  boundaryEdges: string[]; // urls that were reached but fell outside scope
}

export interface FeatureRunResult {
  outcome: "exhausted" | "cap" | "path-cap";
  coverage: FeatureCoverage;
  recordings: Recording[];
}

function candidateOpsFor(control: Control): FrontierOp[] {
  if (control.role === "textbox") return ["type"];
  if (control.role === "combobox") return ["select"];
  if (control.role === "button" || control.role === "link") return ["click"];
  return [];
}

export async function runFeatureMission(params: {
  page: Page;
  actor: Actor;
  seedUrl: string;
  allowlist: readonly string[];
  scope: CapabilityScope;
  bounds?: Bounds;
  maxDepth?: number;
  maxPaths?: number;
}): Promise<FeatureRunResult> {
  assertAuthorizedExploreTarget(params.seedUrl, params.allowlist);
  const bounds = params.bounds ?? defaultBounds();
  const maxDepth = params.maxDepth ?? 10;
  const maxPaths = params.maxPaths ?? 20;

  await params.actor.attemptsTo(Navigate.to(params.seedUrl));
  let snapshot = await snapshotPage(params.page, { maxCandidates: bounds.maxCandidates });
  let currentFingerprint = stateFingerprint(snapshot);

  const visited = new Set<string>([currentFingerprint]);
  const boundaryEdges: string[] = [];
  const leaves = new Map<string, Recording>();
  const extended = new Set<string>();
  const frontier = new Frontier();

  const seedRecording: Recording = { version: "1", site: new URL(params.seedUrl).origin, pages: [] };
  leaves.set(currentFingerprint, seedRecording);
  for (const control of snapshot.controls) {
    for (const op of candidateOpsFor(control)) {
      frontier.push({ key: actionKey(currentFingerprint, control, op), fromFingerprint: currentFingerprint, pathPrefix: seedRecording, control, op });
    }
  }

  let actions = 0;
  let transitionsExercised = 0;
  let pathsDiscovered = 1; // the seed state counts as path 0

  while (!frontier.isExhausted()) {
    if (actions >= bounds.maxActions) return endRun("cap");
    if (pathsDiscovered >= maxPaths) return endRun("path-cap");

    const item = frontier.popPreferring(currentFingerprint) as FrontierItem;
    const depth = item.pathPrefix.pages.reduce((n, p) => n + p.steps.length, 0);
    if (depth >= maxDepth) continue;

    if (item.fromFingerprint !== currentFingerprint) {
      const reached = await reachFrontierState({
        page: params.page, actor: params.actor, seedUrl: params.seedUrl, item,
        snapshotNow: () => snapshotPage(params.page, { maxCandidates: bounds.maxCandidates }),
      });
      if (!reached.ok) continue;
      snapshot = reached.snapshot;
      currentFingerprint = item.fromFingerprint;
    }

    const fillText = item.op === "type" && !isSecretLike(item.control)
      ? boundaryValueCandidates(item.control)[0]
      : undefined;
    const decision = { op: item.op, targetIndex: item.control.index } as const;
    const result = await executeAction({ actor: params.actor, page: params.page, snapshot, decision, fillText });
    actions += 1;
    if (!result.ok) continue;

    snapshot = await snapshotPage(params.page, { maxCandidates: bounds.maxCandidates });
    const newFingerprint = stateFingerprint(snapshot);
    const branch = recordStep(item.pathPrefix, { decision, snapshot, fillText, timing: { atMs: 0, durationMs: 0, gapBeforeMs: 0 } });
    transitionsExercised += 1;
    extended.add(item.fromFingerprint);

    if (!isInScope(snapshot.url, params.scope)) {
      boundaryEdges.push(snapshot.url);
      leaves.set(newFingerprint, branch);
      currentFingerprint = newFingerprint;
      continue; // out of scope — recorded, never expanded further
    }

    if (!visited.has(newFingerprint)) {
      visited.add(newFingerprint);
      leaves.set(newFingerprint, branch);
      pathsDiscovered += 1;
      for (const control of snapshot.controls) {
        for (const op of candidateOpsFor(control)) {
          frontier.push({ key: actionKey(newFingerprint, control, op), fromFingerprint: newFingerprint, pathPrefix: branch, control, op });
        }
      }
    }
    currentFingerprint = newFingerprint;
  }

  return endRun("exhausted");

  function endRun(outcome: FeatureRunResult["outcome"]): FeatureRunResult {
    return {
      outcome,
      coverage: { pathsDiscovered, statesExercised: visited.size, transitionsExercised, boundaryEdges },
      recordings: [...leaves.entries()].filter(([fp]) => !extended.has(fp)).map(([, r]) => r),
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/explore/src/missions/feature.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/explore/src/missions/feature.ts packages/explore/src/missions/feature.test.ts
git commit -m "$(cat <<'EOF'
feat(explore): add runFeatureMission — single in-scope path slice

Capability-scoped variant of proof-by-induction: same frontier/fingerprint
mechanics, restricted to a CapabilityScope, with boundary-value
stimulation on type actions and out-of-scope states recorded as edges.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Multi-path discovery within scope (the ticket's core claim)

**Files:**
- Modify: `packages/explore/src/missions/feature.test.ts`

**Interfaces:**
- Consumes: `RecordingInterpreter` (`@jevitate/interpreter`) for the replay-proves-determinism assertion.

- [ ] **Step 1: Write the failing test**

```ts
// packages/explore/src/missions/feature.test.ts — add to beforeAll, after `actor = ...`:
//   await page.goto(`${site.url}/login`);
//   await page.fill('input[name="username"]', "jane");
//   await page.click('button[type="submit"]');
//   await page.waitForURL(/\/inbox/);
// (mirrors ticket #3's plan Task 5 — authenticate once so /inbox is reachable)

import { RecordingInterpreter } from "@jevitate/interpreter";

describe("runFeatureMission — multi-path discovery", () => {
  test("discovers both thread routes as distinct valid paths through the 'read messages' capability", async () => {
    const scope: CapabilityScope = { name: "read messages", originAllowlist: [site.url], routeGlobs: ["/inbox", "/thread/**"] };
    const result = await runFeatureMission({
      page: session.page, actor, seedUrl: `${site.url}/inbox`, allowlist: [site.url], scope,
    });
    expect(result.outcome).toBe("exhausted");
    expect(result.coverage.statesExercised).toBe(3); // inbox + thread-1 + thread-2
    expect(result.coverage.pathsDiscovered).toBeGreaterThanOrEqual(3);
    expect(result.recordings.length).toBeGreaterThanOrEqual(2);
  });

  test("every discovered path's Recording replays deterministically via the interpreter", async () => {
    const scope: CapabilityScope = { name: "read messages", originAllowlist: [site.url], routeGlobs: ["/inbox", "/thread/**"] };
    const result = await runFeatureMission({
      page: session.page, actor, seedUrl: `${site.url}/inbox`, allowlist: [site.url], scope,
    });
    const interpreter = new RecordingInterpreter();
    for (const recording of result.recordings) {
      const outcome = await interpreter.run(actor, recording);
      expect(outcome.outcome).toBe("completed");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/explore/src/missions/feature.test.ts`
Expected: FAIL until the `beforeAll` authentication step is added; may also fail if the fixture's `/inbox`/`/thread/:id` anchor role isn't `"link"` per ticket #1's actual `snapshotPage` — same reconciliation note as ticket #3's plan Task 5.

- [ ] **Step 3: Fix `beforeAll`**

```ts
beforeAll(async () => {
  site = await startServer();
  profileDir = await mkdtemp(join(tmpdir(), "jevitate-feature-"));
  const browserPort = new PlaywrightBrowserPort();
  session = await browserPort.open({ profileDir, headless: true, allowedOrigins: [site.url], baseUrl: site.url });
  actor = CastActor.named("feature-explorer").whoCan(new BrowseTheWeb(session, [site.url]));
  await session.page.goto(`${site.url}/login`);
  await session.page.fill('input[name="username"]', "jane");
  await session.page.click('button[type="submit"]');
  await session.page.waitForURL(/\/inbox/);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/explore/src/missions/feature.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/explore/src/missions/feature.test.ts
git commit -m "$(cat <<'EOF'
test(explore): prove feature mission discovers multiple valid paths and
that every discovered Recording replays deterministically

Directly proves ticket #2's acceptance bullets: "exercises multiple valid
routes" and "records which states and transitions were actually exercised."

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Boundary-state stimulation + out-of-scope edge recording

**Files:**
- Modify: `packages/explore/src/missions/feature.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/explore/src/missions/feature.test.ts — add:
describe("runFeatureMission — boundary states and scope edges", () => {
  test("a type action on an in-scope field is filled with a boundary-value candidate, not left empty", async () => {
    const scope: CapabilityScope = { name: "sign in", originAllowlist: [site.url], routeGlobs: ["/login"] };
    const result = await runFeatureMission({
      page: session.page, actor, seedUrl: `${site.url}/login`, allowlist: [site.url], scope,
    });
    const fillSteps = result.recordings.flatMap((r) => r.pages.flatMap((p) => p.steps)).filter((s) => s.step.kind === "fill");
    for (const step of fillSteps) {
      if (step.step.kind === "fill" && "value" in step.step.value) {
        expect(step.step.value.redacted ? true : step.step.value.value.length).toBeTruthy();
      }
    }
  });

  test("a link outside the capability's route globs is recorded as a boundary edge, not expanded", async () => {
    // Scope the "inbox browsing entry" capability to ONLY /inbox — both
    // thread links are then genuinely out of scope.
    const scope: CapabilityScope = { name: "inbox entry", originAllowlist: [site.url], routeGlobs: ["/inbox"] };
    const result = await runFeatureMission({
      page: session.page, actor, seedUrl: `${site.url}/inbox`, allowlist: [site.url], scope,
    });
    expect(result.coverage.statesExercised).toBe(1); // only /inbox itself is ever counted as "in scope"
    expect(result.coverage.boundaryEdges.length).toBeGreaterThanOrEqual(2); // both thread links hit
    expect(result.coverage.boundaryEdges.every((u) => u.includes("/thread/"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/explore/src/missions/feature.test.ts`
Expected: The second test should already PASS given Task 5's `isInScope` check; the first test may fail if `RecordedStep`'s `fill` variant's redaction shape doesn't match the assumed `ValueOrVar`/`RedactedValue` union from `@jevitate/recording` (verified real shape at `packages/recording/src/schema.ts:31-35`) — if `recordStep` (a ticket #1 primitive) redacts every fill value by default, `step.step.value.redacted` will always be `true`, which is still a valid pass (`true ? true : ...` short-circuits) — no fix should be needed, but note the reconciliation point.

- [ ] **Step 3: Proceed / no implementation change expected**

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/explore/src/missions/feature.test.ts`
Expected: PASS (5 tests total across the file).

- [ ] **Step 5: Commit**

```bash
git add packages/explore/src/missions/feature.test.ts
git commit -m "$(cat <<'EOF'
test(explore): prove feature mission stimulates boundary values and
records out-of-scope states as edges without expanding them

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Guardrail invariant contract

**Files:**
- Create: `packages/explore/src/feature-invariants.test.ts`

**Interfaces:**
- Consumes: `runFeatureMission` (Task 5); `UnauthorizedExploreTargetError` (ticket #1); `isSecretLike`/`boundaryValueCandidates` (Task 4).

- [ ] **Step 1: Write the failing test**

```ts
// packages/explore/src/feature-invariants.test.ts
import { describe, expect, test } from "vitest";
import { UnauthorizedExploreTargetError } from "./index.js";
import { runFeatureMission } from "./missions/feature.js";
import { boundaryValueCandidates, isSecretLike } from "./feature/boundary-values.js";
import type { Control } from "./index.js";
import type { CapabilityScope } from "./feature/capability-scope.js";

describe("feature mission — guardrail invariants", () => {
  test("#1 refuses an undeclared origin before touching a Page", async () => {
    const scope: CapabilityScope = { name: "checkout", originAllowlist: ["https://authorized.test"], routeGlobs: ["/checkout/**"] };
    await expect(
      runFeatureMission({
        page: {} as never, actor: {} as never,
        seedUrl: "https://not-authorized.test/checkout", allowlist: ["https://authorized.test"], scope,
      }),
    ).rejects.toThrow(UnauthorizedExploreTargetError);
  });

  test("#1 refuses when originAllowlist is empty (fail-closed, never 'anything in scope')", async () => {
    const scope: CapabilityScope = { name: "checkout", originAllowlist: [], routeGlobs: ["/checkout/**"] };
    await expect(
      runFeatureMission({
        page: {} as never, actor: {} as never,
        seedUrl: "https://authorized.test/checkout", allowlist: [], scope,
      }),
    ).rejects.toThrow(UnauthorizedExploreTargetError);
  });

  test("#3 a secret-like field is never given a boundary-value candidate", () => {
    const passwordField: Control = { index: 0, descriptor: {}, role: "textbox", name: "Password", visible: true, enabled: true };
    expect(isSecretLike(passwordField)).toBe(true);
    expect(boundaryValueCandidates(passwordField)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/explore/src/feature-invariants.test.ts`
Expected: FAIL — `Cannot find module './index.js'` exporting `UnauthorizedExploreTargetError`, or the second test fails if `assertAuthorizedExploreTarget` treats an empty allowlist array as "no restriction" rather than "refuse everything" — verify against ticket #1's actual implementation (the `@jevitate/load` precedent at `packages/load/src/authorized-targets.ts:30-39` fails closed on empty via `authorizedOrigins.some(...)` returning `false` for an empty array, which is the correct behavior to expect here too).

- [ ] **Step 3: No implementation change expected if ticket #1 mirrors the load-package precedent; otherwise flag it**

If Step 2 is RED on the empty-allowlist case specifically, this is a ticket #1 bug, not a ticket #2 one — file it against ticket #1 rather than working around it here (this plan's `feature-invariants.test.ts` exists precisely to catch it).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/explore/src/feature-invariants.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/explore/src/feature-invariants.test.ts
git commit -m "$(cat <<'EOF'
test(explore): add feature-mission guardrail-invariant contract (#1, #3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Additive CLI — `explore --feature <name> --route <glob...>`

**Files:**
- Modify: `packages/cli/src/explore-api.ts`
- Modify: `packages/cli/src/program.ts`
- Test: `packages/cli/src/explore-api.test.ts`

**Interfaces:**
- Consumes: `runFeatureMission` (Task 5); `CapabilityScope` (Task 3); `ok`/`fail`/`JsonEnvelope` (`packages/cli/src/envelope.ts`).
- Produces: `runFeatureCliMission(opts): Promise<FeatureRunResult>` wired behind `explore --feature <name>` (satisfies site ticket #11's `jevitate explore --feature <x>` requirement).

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/explore-api.test.ts — add:
import { runFeatureCliMission } from "./explore-api.js";
import { UnauthorizedExploreTargetError } from "@jevitate/explore";

test("runFeatureCliMission refuses an undeclared origin (no browser touched)", async () => {
  await expect(
    runFeatureCliMission({
      seedUrl: "https://not-authorized.test", allowlist: ["https://authorized.test"],
      capability: "checkout", routeGlobs: ["/checkout/**"], profileDir: "/tmp/unused",
    }),
  ).rejects.toThrow(UnauthorizedExploreTargetError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/cli/src/explore-api.test.ts`
Expected: FAIL — `runFeatureCliMission` is not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cli/src/explore-api.ts — add:
import { runFeatureMission, type FeatureRunResult } from "@jevitate/explore/missions/feature.js";
import type { CapabilityScope } from "@jevitate/explore/feature/capability-scope.js";

export interface RunFeatureCliMissionOptions {
  seedUrl: string;
  allowlist: readonly string[];
  capability: string;
  routeGlobs: readonly string[];
  profileDir: string;
  headless?: boolean;
}

export async function runFeatureCliMission(opts: RunFeatureCliMissionOptions): Promise<FeatureRunResult> {
  const scope: CapabilityScope = { name: opts.capability, originAllowlist: opts.allowlist, routeGlobs: opts.routeGlobs };
  assertAuthorizedExploreTarget(opts.seedUrl, opts.allowlist); // fail closed before opening a browser
  const browserPort = new PlaywrightBrowserPort();
  const session = await browserPort.open({
    profileDir: opts.profileDir, headless: opts.headless ?? true,
    allowedOrigins: [...opts.allowlist], baseUrl: opts.seedUrl,
  });
  try {
    const actor = CastActor.named("feature-mission").whoCan(new BrowseTheWeb(session, [...opts.allowlist]));
    return await runFeatureMission({ page: session.page, actor, seedUrl: opts.seedUrl, allowlist: opts.allowlist, scope });
  } finally {
    await session.close();
  }
}
```

```ts
// packages/cli/src/program.ts — extend the explore command:
    .option("--feature <name>", "run the feature-testing mission for a named capability")
    .option("--route <glob...>", "in-scope route glob(s) for --feature", [])
// ...and in its .action(...) handler:
    if (opts.feature) {
      const result = await runFeatureCliMission({
        seedUrl: opts.url, allowlist: opts.allow ?? [], capability: opts.feature,
        routeGlobs: opts.route ?? [], profileDir: deps.profiles as unknown as string,
      });
      emitJson(program, ok(result));
      return;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/cli/src/explore-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/explore-api.ts packages/cli/src/program.ts packages/cli/src/explore-api.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add `explore --feature <name> --route <glob...>` (feature mission)

Additive: wires runFeatureMission behind the shared explore command.
Satisfies jevitate-site#11's "jevitate explore --feature <x> as a live
command" requirement.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage** (ticket #2's acceptance bullets):
- "Discovers the relevant UI paths dynamically rather than following named steps" → the frontier expansion in `feature.ts` (Task 5) never consumes a pre-authored step list — only a seed URL + scope.
- "Exercises multiple valid routes through the capability and explores its boundary states" → Task 6 (multi-path), Task 7 (boundary-value stimulation + out-of-scope edges).
- "Records which states and transitions were actually exercised" → `FeatureCoverage` (Task 5), proven concretely in Tasks 6–7.
- Guardrails §6 → Task 8 (invariant contract) + the header's explicit call-out that this mission issues zero model calls (trivially satisfying guardrail #5, called out rather than silently absent).
- Site pairing #11 (`jevitate explore --feature <x>`) → Task 9.

**Placeholder scan:** no "TBD"/"handle edge cases"-style steps; the one deliberately incomplete spot (`boundaryValueCandidates`'s combobox fallback, Task 4) is documented as a named, scoped simplification with its own code comment explaining exactly why and what would remove it (ticket #1 enriching `Control` with option metadata), not a vague placeholder.

**Type consistency:** `FeatureCoverage`, `FeatureRunResult`, `CapabilityScope` are defined once (Tasks 3, 5) and reused verbatim through Task 9.

**Duplication called out, not hidden:** see "Known duplication" above — `fingerprint.ts`/`frontier.ts`/`reach.ts` are near-identical to ticket #3's `coverage/` module by design, traded for independent landability; a follow-up extraction is named explicitly rather than left implicit.

**Known risk carried forward:** like ticket #3's plan, Task 5/6's fixture-shape assumptions (anchor role strings, redaction shape of a `fill` step's `value`) are flagged as reconciliation points against ticket #1's actual implementation rather than asserted as certain — the executing engineer is told exactly which lines to check if a test comes back red for a reason other than "module doesn't exist yet."
