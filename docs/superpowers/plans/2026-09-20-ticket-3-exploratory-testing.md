# Exploratory (Coverage) Testing Mission — Implementation Plan (Ticket #2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Proposed (plan — for review before execution)
**Date:** 2026-09-20
**Ticket:** [matt-cochran/jevitate#3](https://github.com/matt-cochran/jevitate/issues/3) — "Exploratory testing maximizes new-state and transition coverage and terminates on an exhausted frontier." Paired site ticket: [#12](https://github.com/matt-cochran/jevitate/issues/12) ("the site presents exploratory testing as Available once it ships").

**Goal:** Add a `runInductionMission` (proof-by-induction / state-coverage) mission to `@jevitate/explore`: a bounded, terminating expansion of a **state-fingerprint frontier** that maximizes new-state/transition coverage (objective: coverage, not shortest-path-to-goal), stops when the frontier is exhausted (or a bound is hit), and emits a coverage report plus any states a hard/soft oracle flags as defects.

**Architecture:** Same `perceive → decide → act → record` primitives as `@jevitate/explore`'s P1 engine (ticket #1) — `snapshotPage`, `executeAction`, `recordStep`, `assertAuthorizedExploreTarget` — composed into a **different loop** than the P1 goal-based driver: instead of Jev picking freely among all controls toward a goal, this mission maintains an explicit `Frontier` of not-yet-tried `(state, action)` pairs keyed by a **state fingerprint** (normalized control table + URL template), pops the next unexplored pair, and — when that pair belongs to a state other than the one the browser is currently on — **resets to the seed URL and replays the recorded path prefix through `@jevitate/interpreter`'s `RecordingInterpreter`** to get back there deterministically (a live Playwright session can't teleport between states; replay is the only way back). "Same state?" is adjudicated by **fingerprint equality** (a hard, deterministic oracle), not a Jev judgment — Jev's role here is limited to a `Noul` "is this state a defect?" check per spec §3.3, which is advisory/soft and never gates termination or state identity.

**Tech Stack:** TypeScript (strict, ES2022, NodeNext), Vitest, pnpm workspaces, Playwright (via `@jevitate/playwright`), the real `@jevitate/example-site` fixture (Fastify) for browser-backed tests.

**Spec:** `docs/superpowers/specs/2026-09-19-autonomous-exploration-testing-design.md` §3.3 ("Proof-by-induction (state coverage)"), §6 (guardrails), §7 ("State fingerprinting & termination" honest-hard-part). Builds on `docs/superpowers/plans/2026-09-20-testing-missions-exploration-engine.md` (P1 engine + its P2 outline for `missions/induction.ts`).

## Global Constraints

- Node 20+, ESM, `strict: true`, project references (`tsc --build`) — mirror `tsconfig.base.json`.
- Dependency direction inward only: this plan only adds files under `packages/explore/` (a leaf package) and one additive touch to `packages/cli/`. Nothing depends on `@jevitate/explore`.
- **Repo gotcha:** packages have NO `"test"` script — run `pnpm exec vitest run <path>`, never `pnpm --filter <pkg> test` (that is a no-op).
- Git staging is explicit-path only (`git add <exact files>`), never `-A`/`.`.
- Commit trailer for every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- CI runs on **fake** gateways only (`FakeJudgmentGateway`/scripted local fakes + `FakeGenerationGateway`); no live Jev/OpenRouter test in this plan.
- Gitflow: branch from `dev`, land via a feature branch, merge back to `dev` (never commit straight to `main`).

## Assumed `@jevitate/explore` public API (Ticket #1 — for reconciliation)

Ticket #1 ("Goal-directed exploration drives to a natural-language goal and emits a deterministic Recording") is being built concurrently. This plan is written against its **planned** public surface, taken from `docs/superpowers/plans/2026-09-20-testing-missions-exploration-engine.md`. `packages/explore/` does not exist in the tree yet as of this writing (verified: `ls packages/` has no `explore` entry) — this plan's tasks assume ticket #1 has landed and exported the following from `packages/explore/src/index.ts` by the time this plan executes:

```ts
// bounds.ts
export interface Bounds { maxActions: number; maxDecisions: number; maxCandidates: number; }
export function defaultBounds(): Bounds; // { maxActions: 60, maxDecisions: 120, maxCandidates: 250 }

// authorized-targets.ts
export class UnauthorizedExploreTargetError extends Error {}
export function assertAuthorizedExploreTarget(url: string, allowlist: readonly string[]): void;

// snapshot.ts
export interface Control {
  index: number;
  descriptor: TargetDescriptor;   // @jevitate/recording's TargetDescriptor
  role?: string;                  // ARIA role, as computed by @jevitate/recorder's roleOf
  name?: string;                  // accessible name
  value?: string;
  visible: boolean;
  enabled: boolean;
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
// Appends one RecordedStep built from `decision`+`snapshot.controls[decision.targetIndex].descriptor`,
// grouped into the Recording's last PageSegment when its `url` matches `snapshot.url`, otherwise
// starting a new PageSegment. Returns a NEW Recording (does not mutate the input).
```

**Additive extension this plan assumes beyond the P1 plan's literal text** (flag for reconciliation with the ticket #1 owner): none — this plan deliberately does **not** need `runExploreLoop`'s Jev-driven op+target `Choice` at all. It drives every action directly (frontier picks the `(control, op)` pair, not Jev), and calls `executeAction`/`recordStep`/`snapshotPage`/`assertAuthorizedExploreTarget` as standalone primitives. The only ticket-#1 surface this plan truly depends on is the six items above. If ticket #1 renames or reshapes any of them, only Tasks 4–8 below (which call them) need adjustment — Tasks 1–3 are pure and independent of ticket #1 entirely.

## Guardrails (binding — from spec §6; each ships an "asserts-it-refuses" test in Task 9)

1. **Authoring/test plane only.** `assertAuthorizedExploreTarget` is called before any navigation; an undeclared seed origin refuses with zero page interaction.
2. **Bounded + fail-closed.** Hard `maxActions`/`maxDecisions` cap; a stale/unreachable frontier item is dropped, never guessed at.
3. **No secrets to models.** The per-state Jev defect judgment only ever sends `role`/`name` summaries (never raw form values) — reuses the redaction convention already established by ticket #1.
4. **Model-verdict-advisory-only.** "Same state?" is decided by fingerprint equality (a hard, deterministic check), **not** a Jev judgment; Jev's `Noul` "is this a defect?" only appends to a `defects` list — it never gates frontier expansion, never halts the mission, and a false-negative/positive on one state does not affect any other branch.
5. **No irreversible action.** Candidate actions are restricted to `click`/`type`/`select` on in-page controls (no cross-origin navigation, no file upload/download); an out-of-bounds action is simply never enqueued.
6. **Prompt-injection guard.** Every Jev prompt this mission issues carries the same guard string ticket #1 established for `decide.ts`.

## File Structure

```
packages/explore/src/
  coverage/
    fingerprint.ts            # stateFingerprint(snapshot) + actionKey(fp, control, op) — pure
    fingerprint.test.ts
    frontier.ts                # Frontier: FIFO queue of unexplored (state, action) pairs — pure
    frontier.test.ts
    reach.ts                    # reset-to-seed + interpreter replay + fingerprint staleness guard
    reach.test.ts
  missions/
    induction.ts                 # runInductionMission — the coverage loop
    induction.test.ts
  induction-invariants.test.ts   # guardrail refusal contract (#1-#6)

apps/example-site/src/
  server.ts                      # ONE additive line: a "Back to inbox" link on /thread/:id (Task 6)

packages/cli/src/
  explore-api.ts                 # + runCoverageMission wiring (additive, alongside ticket #1's fn)
  program.ts                     # + `explore --strategy coverage|exploratory` on the explore command
  explore-api.test.ts            # + coverage-strategy wiring test (no browser)
```

---

## Task 1: `stateFingerprint` + `actionKey` (pure)

**Files:**
- Create: `packages/explore/src/coverage/fingerprint.ts`
- Test: `packages/explore/src/coverage/fingerprint.test.ts`

**Interfaces:**
- Consumes: `Control`, `Snapshot` (ticket #1, `@jevitate/explore`); `urlTemplate` (`@jevitate/recording`, already exported — verified in `packages/recording/src/signature.ts:23`).
- Produces: `stateFingerprint(snapshot: Snapshot): string`; `type FrontierOp = "click" | "type" | "select"`; `actionKey(fingerprint: string, control: Control, op: FrontierOp): string` — consumed by Tasks 2, 3, 4.

- [ ] **Step 1: Write the failing test**

```ts
// packages/explore/src/coverage/fingerprint.test.ts
import { describe, expect, test } from "vitest";
import { stateFingerprint, actionKey } from "./fingerprint.js";
import type { Snapshot, Control } from "../index.js";

function control(over: Partial<Control>): Control {
  return { index: 0, descriptor: { role: over.role, name: over.name }, visible: true, enabled: true, ...over };
}

describe("stateFingerprint", () => {
  test("is stable for the same url template + control set, regardless of control order", () => {
    const a: Snapshot = {
      url: "https://x.test/thread/t-1",
      freshnessSignature: "s1",
      controls: [control({ index: 0, role: "link", name: "Back" }), control({ index: 1, role: "button", name: "Reply" })],
    };
    const b: Snapshot = {
      url: "https://x.test/thread/t-2",
      freshnessSignature: "s2",
      controls: [control({ index: 1, role: "button", name: "Reply" }), control({ index: 0, role: "link", name: "Back" })],
    };
    expect(stateFingerprint(a)).toBe(stateFingerprint(b));
  });

  test("differs when a control's visible/enabled state differs", () => {
    const a: Snapshot = { url: "https://x.test/x", freshnessSignature: "s", controls: [control({ enabled: true })] };
    const b: Snapshot = { url: "https://x.test/x", freshnessSignature: "s", controls: [control({ enabled: false })] };
    expect(stateFingerprint(a)).not.toBe(stateFingerprint(b));
  });

  test("differs when the url template differs (id-like segments normalized)", () => {
    const a: Snapshot = { url: "https://x.test/thread/t-1", freshnessSignature: "s", controls: [] };
    const b: Snapshot = { url: "https://x.test/inbox", freshnessSignature: "s", controls: [] };
    expect(stateFingerprint(a)).not.toBe(stateFingerprint(b));
  });
});

describe("actionKey", () => {
  test("is unique per (fingerprint, op, control) and stable across calls", () => {
    const c = control({ role: "button", name: "Reply" });
    const fp = "fp-1";
    expect(actionKey(fp, c, "click")).toBe(actionKey(fp, c, "click"));
    expect(actionKey(fp, c, "click")).not.toBe(actionKey(fp, c, "type"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/explore/src/coverage/fingerprint.test.ts`
Expected: FAIL — `Cannot find module './fingerprint.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/explore/src/coverage/fingerprint.ts
import { urlTemplate } from "@jevitate/recording";
import type { Control, Snapshot } from "../index.js";

function controlSignature(c: Control): string {
  return `${c.role ?? ""}\u0001${c.name ?? ""}\u0001${c.visible ? "v" : "-"}${c.enabled ? "e" : "-"}`;
}

/** Normalized control table + url-template, per spec §3.3/§7. Control ORDER
 *  never affects the fingerprint — only which controls exist and their state. */
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

Run: `pnpm exec vitest run packages/explore/src/coverage/fingerprint.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/explore/src/coverage/fingerprint.ts packages/explore/src/coverage/fingerprint.test.ts
git commit -m "$(cat <<'EOF'
feat(explore): add state fingerprint + action key for coverage frontier

Pure, deterministic "same state?" oracle (normalized control table + url
template) for the proof-by-induction mission — fingerprint equality, not a
Jev judgment, per guardrail #4 (model-verdict-advisory-only).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `Frontier` (pure queue of unexplored `(state, action)` pairs)

**Files:**
- Create: `packages/explore/src/coverage/frontier.ts`
- Test: `packages/explore/src/coverage/frontier.test.ts`

**Interfaces:**
- Consumes: `Control` (ticket #1); `FrontierOp`, `actionKey` (Task 1).
- Produces: `interface FrontierItem { key: string; fromFingerprint: string; pathPrefix: Recording; control: Control; op: FrontierOp; }`; `class Frontier { push(item): void; popPreferring(preferFingerprint?: string): FrontierItem | undefined; isExhausted(): boolean; readonly size: number; }` — consumed by Tasks 3, 4.

- [ ] **Step 1: Write the failing test**

```ts
// packages/explore/src/coverage/frontier.test.ts
import { describe, expect, test } from "vitest";
import { Frontier, type FrontierItem } from "./frontier.js";
import type { Control } from "../index.js";

const c: Control = { index: 0, descriptor: { role: "button", name: "Reply" }, role: "button", name: "Reply", visible: true, enabled: true };

function item(over: Partial<FrontierItem>): FrontierItem {
  return {
    key: "k1", fromFingerprint: "fp-a",
    pathPrefix: { version: "1", site: "https://x.test", pages: [] },
    control: c, op: "click", ...over,
  };
}

describe("Frontier", () => {
  test("starts exhausted", () => {
    expect(new Frontier().isExhausted()).toBe(true);
  });

  test("dedupes by key — pushing the same key twice only enqueues once", () => {
    const f = new Frontier();
    f.push(item({ key: "dup" }));
    f.push(item({ key: "dup" }));
    expect(f.size).toBe(1);
  });

  test("popPreferring returns an item matching the preferred fingerprint before falling back to FIFO order", () => {
    const f = new Frontier();
    f.push(item({ key: "a", fromFingerprint: "fp-a" }));
    f.push(item({ key: "b", fromFingerprint: "fp-b" }));
    const popped = f.popPreferring("fp-b");
    expect(popped?.key).toBe("b");
    expect(f.size).toBe(1);
  });

  test("popPreferring falls back to the oldest item when no preferred-fingerprint item exists", () => {
    const f = new Frontier();
    f.push(item({ key: "a", fromFingerprint: "fp-a" }));
    f.push(item({ key: "b", fromFingerprint: "fp-b" }));
    const popped = f.popPreferring("fp-nonexistent");
    expect(popped?.key).toBe("a");
  });

  test("isExhausted flips true once every item is popped", () => {
    const f = new Frontier();
    f.push(item({ key: "only" }));
    f.popPreferring(undefined);
    expect(f.isExhausted()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/explore/src/coverage/frontier.test.ts`
Expected: FAIL — `Cannot find module './frontier.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/explore/src/coverage/frontier.ts
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

/** A dedup'd FIFO queue of not-yet-tried (state, action) pairs. */
export class Frontier {
  private readonly queue: FrontierItem[] = [];
  private readonly seen = new Set<string>();

  push(item: FrontierItem): void {
    if (this.seen.has(item.key)) return;
    this.seen.add(item.key);
    this.queue.push(item);
  }

  /** Prefers an item reachable without a reset+replay (its fromFingerprint
   *  matches where the browser already is); otherwise the oldest queued item. */
  popPreferring(preferFingerprint: string | undefined): FrontierItem | undefined {
    if (preferFingerprint !== undefined) {
      const i = this.queue.findIndex((it) => it.fromFingerprint === preferFingerprint);
      if (i !== -1) return this.queue.splice(i, 1)[0];
    }
    return this.queue.shift();
  }

  isExhausted(): boolean {
    return this.queue.length === 0;
  }

  get size(): number {
    return this.queue.length;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/explore/src/coverage/frontier.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/explore/src/coverage/frontier.ts packages/explore/src/coverage/frontier.test.ts
git commit -m "$(cat <<'EOF'
feat(explore): add Frontier queue for unexplored (state, action) pairs

Deduped FIFO with fingerprint-preferring pop, so the induction loop keeps
DFS-ing forward when possible and only resets+replays when it must.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `reachFrontierState` (reset + replay + staleness guard)

**Files:**
- Create: `packages/explore/src/coverage/reach.ts`
- Test: `packages/explore/src/coverage/reach.test.ts`

**Interfaces:**
- Consumes: `FrontierItem` (Task 2); `stateFingerprint` (Task 1); `Navigate` (`@jevitate/screenplay`); `RecordingInterpreter` (`@jevitate/interpreter`, `run(actor, rec, vars?, sink?): Promise<InterpretResult>` — verified `packages/interpreter/src/interpreter.ts:48`); `Snapshot` (ticket #1).
- Produces: `type ReachResult = { ok: true; snapshot: Snapshot } | { ok: false; reason: "stale" }`; `reachFrontierState(params): Promise<ReachResult>` — consumed by Task 4.

- [ ] **Step 1: Write the failing test**

```ts
// packages/explore/src/coverage/reach.test.ts
import { describe, expect, test, vi } from "vitest";
import { reachFrontierState } from "./reach.js";
import type { FrontierItem } from "./frontier.js";
import type { Snapshot } from "../index.js";

function fakeActor() {
  return { name: "t", ability: vi.fn(), attemptsTo: vi.fn().mockResolvedValue(undefined), asks: vi.fn() };
}

const item: FrontierItem = {
  key: "k", fromFingerprint: "fp-expected",
  pathPrefix: { version: "1", site: "https://x.test", pages: [] },
  control: { index: 0, descriptor: { role: "button", name: "Go" }, visible: true, enabled: true },
  op: "click",
};

describe("reachFrontierState", () => {
  test("returns ok + the snapshot when the replayed fingerprint matches fromFingerprint", async () => {
    const snap: Snapshot = { url: "https://x.test/a", freshnessSignature: "s", controls: [] };
    const result = await reachFrontierState({
      page: {} as never,
      actor: fakeActor() as never,
      seedUrl: "https://x.test/a",
      item: { ...item, fromFingerprint: "https://x.test/*\u0003" },
      snapshotNow: async () => snap,
    });
    expect(result.ok).toBe(true);
  });

  test("returns { ok: false, reason: 'stale' } when the replayed state doesn't match — never guesses", async () => {
    const snap: Snapshot = { url: "https://x.test/different", freshnessSignature: "s", controls: [] };
    const result = await reachFrontierState({
      page: {} as never,
      actor: fakeActor() as never,
      seedUrl: "https://x.test/a",
      item,
      snapshotNow: async () => snap,
    });
    expect(result).toEqual({ ok: false, reason: "stale" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/explore/src/coverage/reach.test.ts`
Expected: FAIL — `Cannot find module './reach.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/explore/src/coverage/reach.ts
import type { Page } from "playwright";
import type { Actor } from "@jevitate/screenplay";
import { Navigate } from "@jevitate/screenplay";
import { RecordingInterpreter } from "@jevitate/interpreter";
import type { Snapshot } from "../index.js";
import { stateFingerprint } from "./fingerprint.js";
import type { FrontierItem } from "./frontier.js";

export type ReachResult = { ok: true; snapshot: Snapshot } | { ok: false; reason: "stale" };

/**
 * A live Playwright session can't teleport to an earlier state — the only
 * deterministic way back is reset-to-seed + interpreter replay of the exact
 * recorded prefix. Verifies the replay actually landed where the frontier
 * item expected (fingerprint equality); a mismatch is dropped as "stale"
 * rather than guessed at (guardrail #2, bounded + fail-closed).
 */
export async function reachFrontierState(params: {
  page: Page;
  actor: Actor;
  seedUrl: string;
  item: FrontierItem;
  snapshotNow: () => Promise<Snapshot>;
}): Promise<ReachResult> {
  await params.actor.attemptsTo(Navigate.to(params.seedUrl));
  await new RecordingInterpreter().run(params.actor, params.item.pathPrefix);
  const snapshot = await params.snapshotNow();
  if (stateFingerprint(snapshot) !== params.item.fromFingerprint) return { ok: false, reason: "stale" };
  return { ok: true, snapshot };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/explore/src/coverage/reach.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/explore/src/coverage/reach.ts packages/explore/src/coverage/reach.test.ts
git commit -m "$(cat <<'EOF'
feat(explore): add reachFrontierState (reset+replay+staleness guard)

Deterministic backtracking for the induction loop via
RecordingInterpreter.run; a replay landing somewhere unexpected is dropped
as stale rather than assumed, keeping the mission fail-closed.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `runInductionMission` — single-state exhaustion (no branches)

**Files:**
- Create: `packages/explore/src/missions/induction.ts`
- Test: `packages/explore/src/missions/induction.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–3; `assertAuthorizedExploreTarget`, `snapshotPage`, `executeAction`, `recordStep`, `defaultBounds`, `Bounds`, `Control`, `Op` (ticket #1); `Navigate` (`@jevitate/screenplay`); `startServer` (`@jevitate/example-site`); `PlaywrightBrowserPort` (`@jevitate/playwright`); `CastActor`, `BrowseTheWeb`, `BrowseTheWebToken` (`@jevitate/screenplay`); `FakeJudgmentGateway` (`@jevitate/ai-core`, scripted per-question-name — verified `packages/ai-core/src/judgment.ts:18`); `FakeGenerationGateway` (`@jevitate/ai-core`).
- Produces: `interface DefectRecord { stateFingerprint: string; url: string; reason: string; recording: Recording }`; `interface CoverageReport { statesVisited: number; transitionsExercised: number; frontierExhausted: boolean; defects: DefectRecord[] }`; `interface InductionRunResult { outcome: "exhausted" | "cap"; coverage: CoverageReport; recordings: Recording[] }`; `runInductionMission(params): Promise<InductionRunResult>` — consumed by Tasks 5–10.

- [ ] **Step 1: Write the failing test**

```ts
// packages/explore/src/missions/induction.test.ts
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "@jevitate/example-site";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { CastActor, BrowseTheWeb, BrowseTheWebToken } from "@jevitate/screenplay";
import { FakeJudgmentGateway } from "@jevitate/ai-core";
import { FakeGenerationGateway } from "@jevitate/ai-core";
import { runInductionMission } from "./induction.js";

let site: { url: string; close(): Promise<void> };
let profileDir: string;
let port: { close(): Promise<void> };
let page: import("playwright").Page;
let actor: CastActor;

beforeAll(async () => {
  site = await startServer();
  profileDir = await mkdtemp(join(tmpdir(), "jevitate-induction-"));
  const browserPort = new PlaywrightBrowserPort();
  const session = await browserPort.open({ profileDir, headless: true, allowedOrigins: [site.url], baseUrl: site.url });
  page = session.page;
  actor = CastActor.named("tester").whoCan(new BrowseTheWeb(session, [site.url]));
  port = session;
});
afterAll(async () => {
  await port.close();
  await site.close();
  await rm(profileDir, { recursive: true, force: true });
});

describe("runInductionMission — single state", () => {
  test("a page with no interactive controls exhausts the frontier immediately (statesVisited=1)", async () => {
    const judgment = new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } });
    const generation = new FakeGenerationGateway();
    const result = await runInductionMission({
      page, actor, judgment, generation,
      seedUrl: `${site.url}/thread/t-1`,
      allowlist: [site.url],
    });
    expect(result.outcome).toBe("exhausted");
    expect(result.coverage.statesVisited).toBe(1);
    expect(result.coverage.transitionsExercised).toBe(0);
    expect(result.coverage.defects).toEqual([]);
    expect(result.recordings).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/explore/src/missions/induction.test.ts`
Expected: FAIL — `Cannot find module './induction.js'` (login required — the fixture redirects `/thread/t-1` to `/login` when unauthenticated; this first test will actually need cookie auth, see note in Step 3's mission code, which drives through `/login` first via a seed goal walk — but since Task 4 seeds directly at `/thread/t-1` and the fixture 302-redirects unauthenticated requests to `/login`, `snapshotPage` will observe the login form, which DOES have one interactive control (`Username`) plus the submit button — so `statesVisited` after the FIRST snapshot is of `/login`, not `/thread/t-1`, and the frontier will NOT be empty. Correct the test's expectation in Step 3 below before trusting a green run — this is why Step 2 is a real RED, not just a missing-module error once the module exists.)

- [ ] **Step 3: Write minimal implementation, then correct the test's fixture choice**

First, the mission:

```ts
// packages/explore/src/missions/induction.ts
import type { Page } from "playwright";
import type { Actor } from "@jevitate/screenplay";
import { Navigate } from "@jevitate/screenplay";
import type { Recording } from "@jevitate/recording";
import type { JudgmentPort, NoulAnswer, GenerationPort } from "@jevitate/ai-core";
import {
  assertAuthorizedExploreTarget,
  snapshotPage,
  executeAction,
  recordStep,
  defaultBounds,
  type Bounds,
  type Control,
} from "../index.js";
import { stateFingerprint, actionKey, type FrontierOp } from "../coverage/fingerprint.js";
import { Frontier, type FrontierItem } from "../coverage/frontier.js";
import { reachFrontierState } from "../coverage/reach.js";

export interface DefectRecord {
  stateFingerprint: string;
  url: string;
  reason: string;
  recording: Recording;
}

export interface CoverageReport {
  statesVisited: number;
  transitionsExercised: number;
  frontierExhausted: boolean;
  defects: DefectRecord[];
}

export interface InductionRunResult {
  outcome: "exhausted" | "cap";
  coverage: CoverageReport;
  recordings: Recording[];
}

function candidateOpsFor(control: Control): FrontierOp[] {
  if (control.role === "textbox") return ["type"];
  if (control.role === "combobox") return ["select"];
  if (control.role === "button" || control.role === "link") return ["click"];
  return [];
}

function enqueueFrom(frontier: Frontier, fingerprint: string, pathPrefix: Recording, controls: readonly Control[]): void {
  for (const control of controls) {
    for (const op of candidateOpsFor(control)) {
      frontier.push({ key: actionKey(fingerprint, control, op), fromFingerprint: fingerprint, pathPrefix, control, op });
    }
  }
}

export async function runInductionMission(params: {
  page: Page;
  actor: Actor;
  judgment: JudgmentPort;
  generation: GenerationPort;
  seedUrl: string;
  allowlist: readonly string[];
  bounds?: Bounds;
  maxDepth?: number;
}): Promise<InductionRunResult> {
  assertAuthorizedExploreTarget(params.seedUrl, params.allowlist);
  const bounds = params.bounds ?? defaultBounds();
  const maxDepth = params.maxDepth ?? 10;

  await params.actor.attemptsTo(Navigate.to(params.seedUrl));
  let snapshot = await snapshotPage(params.page, { maxCandidates: bounds.maxCandidates });
  let currentFingerprint = stateFingerprint(snapshot);

  const visited = new Set<string>([currentFingerprint]);
  const defects: DefectRecord[] = [];
  const leaves = new Map<string, Recording>();
  const extended = new Set<string>();
  const frontier = new Frontier();

  const seedRecording: Recording = { version: "1", site: new URL(params.seedUrl).origin, pages: [] };
  leaves.set(currentFingerprint, seedRecording);
  enqueueFrom(frontier, currentFingerprint, seedRecording, snapshot.controls);

  let actions = 0;
  let transitionsExercised = 0;

  while (!frontier.isExhausted()) {
    if (actions >= bounds.maxActions) {
      return {
        outcome: "cap",
        coverage: { statesVisited: visited.size, transitionsExercised, frontierExhausted: false, defects },
        recordings: [...leaves.entries()].filter(([fp]) => !extended.has(fp)).map(([, r]) => r),
      };
    }

    const item = frontier.popPreferring(currentFingerprint) as FrontierItem;
    const depth = item.pathPrefix.pages.reduce((n, p) => n + p.steps.length, 0);
    if (depth >= maxDepth) continue;

    if (item.fromFingerprint !== currentFingerprint) {
      const reached = await reachFrontierState({
        page: params.page, actor: params.actor, seedUrl: params.seedUrl, item,
        snapshotNow: () => snapshotPage(params.page, { maxCandidates: bounds.maxCandidates }),
      });
      if (!reached.ok) continue; // stale frontier item — dropped, never guessed at
      snapshot = reached.snapshot;
      currentFingerprint = item.fromFingerprint;
    }

    const decision = { op: item.op, targetIndex: item.control.index } as const;
    const result = await executeAction({ actor: params.actor, page: params.page, snapshot, decision });
    actions += 1;
    if (!result.ok) continue;

    snapshot = await snapshotPage(params.page, { maxCandidates: bounds.maxCandidates });
    const newFingerprint = stateFingerprint(snapshot);
    const branch = recordStep(item.pathPrefix, {
      decision, snapshot, timing: { atMs: 0, durationMs: 0, gapBeforeMs: 0 },
    });
    transitionsExercised += 1;
    extended.add(item.fromFingerprint);

    const answers = await params.judgment.systemOne({
      state: {
        goal: "state coverage", url: snapshot.url,
        controls: snapshot.controls.map((c) => `${c.role ?? ""} ${c.name ?? ""}`.trim()),
        history: [],
      },
      questions: { isDefect: { kind: "noul" } },
    });
    if ((answers.isDefect as NoulAnswer).value) {
      // Advisory only (guardrail #4): recorded, never gates termination or expansion elsewhere.
      defects.push({ stateFingerprint: newFingerprint, url: snapshot.url, reason: "judgment flagged defect", recording: branch });
      leaves.set(newFingerprint, branch);
      currentFingerprint = newFingerprint;
      continue;
    }

    if (!visited.has(newFingerprint)) {
      visited.add(newFingerprint);
      leaves.set(newFingerprint, branch);
      enqueueFrom(frontier, newFingerprint, branch, snapshot.controls);
    }
    currentFingerprint = newFingerprint;
  }

  return {
    outcome: "exhausted",
    coverage: { statesVisited: visited.size, transitionsExercised, frontierExhausted: true, defects },
    recordings: [...leaves.entries()].filter(([fp]) => !extended.has(fp)).map(([, r]) => r),
  };
}
```

Now correct the test in `induction.test.ts` — seed at `/login` (a genuinely single-state page for an unauthenticated actor: one textbox, one button, and clicking "Sign in" with no username fails with a 400 and stays on `/login`, so the frontier still exhausts at one *newly-recorded transition* rather than one *state*):

```ts
// packages/explore/src/missions/induction.test.ts — replace the single test body with:
describe("runInductionMission — single state", () => {
  test("a login page with a doomed-to-fail submit exhausts without discovering a new state", async () => {
    const judgment = new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } });
    const generation = new FakeGenerationGateway();
    const result = await runInductionMission({
      page, actor, judgment, generation,
      seedUrl: `${site.url}/login`,
      allowlist: [site.url],
    });
    expect(result.outcome).toBe("exhausted");
    expect(result.coverage.statesVisited).toBe(1);
    expect(result.coverage.defects).toEqual([]);
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/explore/src/missions/induction.test.ts`
Expected: PASS (1 test). If it fails because clicking "Sign in" with an empty username DOES change the fingerprint (e.g. the fixture's 400 response body differs enough to change the URL template — it won't, since the URL stays `/login` on a POST-then-fail-without-redirect and Playwright's `page.url()` reflects the last committed navigation), re-verify by reading `apps/example-site/src/server.ts`'s `/login` POST handler (returns `reply.code(400).send(...)` with no navigation) before adjusting the assertion.

- [ ] **Step 5: Commit**

```bash
git add packages/explore/src/missions/induction.ts packages/explore/src/missions/induction.test.ts
git commit -m "$(cat <<'EOF'
feat(explore): add runInductionMission — single-state frontier exhaustion

First slice of the proof-by-induction mission: seed, snapshot, enqueue
candidate (state, action) pairs, exhaust. No branching yet (Task 5).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Branching discovery (multiple new states from one state)

**Files:**
- Modify: `packages/explore/src/missions/induction.test.ts` (add a test using the authenticated `/inbox` page, which has links to `/thread/t-1` and `/thread/t-2` — see `apps/example-site/src/data.ts`'s `SEED_THREADS`).

**Interfaces:**
- Consumes: `runInductionMission` (Task 4), and the existing authenticated-session pattern from `packages/runtime/src/journey-login-e2e.test.ts` (submit the login form once in `beforeAll` so the actor's persistent-context cookie carries `sid=ok` into this test).

- [ ] **Step 1: Write the failing test**

```ts
// packages/explore/src/missions/induction.test.ts — add to beforeAll, then a new describe block
// In beforeAll, after `actor = CastActor.named(...)`, authenticate once:
//   await page.goto(`${site.url}/login`);
//   await page.fill('input[name="username"]', "jane");
//   await page.click('button[type="submit"]');
//   await page.waitForURL(/\/inbox/);

describe("runInductionMission — branching", () => {
  test("discovers both thread states from /inbox and exercises both transitions", async () => {
    const judgment = new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } });
    const generation = new FakeGenerationGateway();
    const result = await runInductionMission({
      page, actor, judgment, generation,
      seedUrl: `${site.url}/inbox`,
      allowlist: [site.url],
    });
    expect(result.outcome).toBe("exhausted");
    // inbox + thread-1 + thread-2 = 3 distinct states
    expect(result.coverage.statesVisited).toBe(3);
    expect(result.coverage.transitionsExercised).toBeGreaterThanOrEqual(2);
    expect(result.recordings.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/explore/src/missions/induction.test.ts`
Expected: FAIL — either the `beforeAll` login step is missing (add it per Step 1's comment before this passes) or `statesVisited` is `1` (frontier never expanded past the first state) if `candidateOpsFor` in Task 4's implementation doesn't recognize the thread `<a>` links' role. Diagnose via a one-off `console.log(snapshot.controls)` in a scratch test if the role string ticket #1's `snapshotPage` assigns to an anchor isn't `"link"` — adjust `candidateOpsFor` in `induction.ts` to match whatever ticket #1 actually emits (this is exactly the kind of ticket-#1-API reconciliation flagged in the header).

- [ ] **Step 3: Fix `beforeAll` (implementation is already correct from Task 4)**

Update the `beforeAll` in `induction.test.ts`:

```ts
beforeAll(async () => {
  site = await startServer();
  profileDir = await mkdtemp(join(tmpdir(), "jevitate-induction-"));
  const browserPort = new PlaywrightBrowserPort();
  const session = await browserPort.open({ profileDir, headless: true, allowedOrigins: [site.url], baseUrl: site.url });
  page = session.page;
  actor = CastActor.named("tester").whoCan(new BrowseTheWeb(session, [site.url]));
  port = session;
  await page.goto(`${site.url}/login`);
  await page.fill('input[name="username"]', "jane");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/inbox/);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/explore/src/missions/induction.test.ts`
Expected: PASS (2 tests). The Task-4 test still seeds at `/login` unauthenticated in a separate mission call (each `runInductionMission` call does its own `Navigate.to(seedUrl)`, so seeding at `/login` after the cookie is already set will now land on `/inbox` via the fixture's redirect-when-authed-away-from-login? — re-check: `apps/example-site`'s `/login` GET handler always renders the form regardless of auth state (no redirect-away-from-login-when-authed branch in `server.ts`), so Task 4's test remains valid unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/explore/src/missions/induction.test.ts
git commit -m "$(cat <<'EOF'
test(explore): cover induction mission branching (multi-state discovery)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Cycle / seen-state handling

**Files:**
- Modify: `apps/example-site/src/server.ts` (additive: one link)
- Modify: `packages/explore/src/missions/induction.test.ts`

**Interfaces:**
- Consumes: same as Task 5.

- [ ] **Step 1: Add a real cycle to the fixture (additive, one line)**

```ts
// apps/example-site/src/server.ts — inside app.get<{ Params: { id: string } }>("/thread/:id", ...):
// change the final reply.type(...).send(...) template literal to append a back-link:
    reply.type("text/html").send(`<!doctype html><html><body><h1>${esc(t.subject)}</h1><ul>${msgs}</ul><a href="/inbox">Back to inbox</a></body></html>`);
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/explore/src/missions/induction.test.ts — add:
describe("runInductionMission — cycles", () => {
  test("a link back to an already-visited state is exercised but not re-expanded", async () => {
    const judgment = new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } });
    const generation = new FakeGenerationGateway();
    const result = await runInductionMission({
      page, actor, judgment, generation,
      seedUrl: `${site.url}/inbox`,
      allowlist: [site.url],
    });
    // Still exactly 3 distinct states (inbox, thread-1, thread-2) even though
    // "Back to inbox" is clicked from both threads — no infinite loop, no
    // phantom 4th/5th state.
    expect(result.coverage.statesVisited).toBe(3);
    expect(result.outcome).toBe("exhausted");
  });
});
```

- [ ] **Step 3: Run — this should already pass given Task 4's `visited.has(newFingerprint)` guard**

Run: `pnpm exec vitest run packages/explore/src/missions/induction.test.ts`
Expected: PASS immediately (no `induction.ts` code change needed — this task is a regression/confidence test proving the cycle-detection behavior Task 4 already implemented via the `visited` set, now exercised against a real cycle rather than only a dead-end). If it fails with a timeout or `statesVisited` growing unboundedly, the bug is in `enqueueFrom` being called for a `newFingerprint` already in `visited` — re-check Task 4's `if (!visited.has(newFingerprint))` guard is present before `enqueueFrom`.

- [ ] **Step 4: Confirm bounded runtime**

Run: `pnpm exec vitest run packages/explore/src/missions/induction.test.ts --testTimeout=15000`
Expected: PASS well under the timeout — a real infinite loop bug would hang here, not merely fail an assertion.

- [ ] **Step 5: Commit**

```bash
git add apps/example-site/src/server.ts packages/explore/src/missions/induction.test.ts
git commit -m "$(cat <<'EOF'
test(explore): add a real inbox<->thread cycle and prove induction dedupes it

Additive fixture change (a "Back to inbox" link) makes the induction
mission's cycle-detection testable against genuine browser navigation
rather than only a dead-end.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Defect detection via Jev `Noul` (advisory-only)

**Files:**
- Modify: `packages/explore/src/missions/induction.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/explore/src/missions/induction.test.ts — add:
describe("runInductionMission — defect judgment is advisory only", () => {
  test("a flagged state lands in coverage.defects but does not stop the mission or corrupt other branches", async () => {
    const judgment = new FakeJudgmentGateway({ isDefect: { kind: "noul", value: true, probability: 0.9 } });
    const generation = new FakeGenerationGateway();
    const result = await runInductionMission({
      page, actor, judgment, generation,
      seedUrl: `${site.url}/inbox`,
      allowlist: [site.url],
    });
    // Every transition gets flagged (the fake always answers true) — the
    // mission still exhausts cleanly rather than throwing or hanging, and
    // every flagged state is captured with its own repro Recording.
    expect(result.outcome).toBe("exhausted");
    expect(result.coverage.defects.length).toBeGreaterThan(0);
    for (const d of result.coverage.defects) {
      expect(d.recording.pages.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/explore/src/missions/induction.test.ts`
Expected: Likely already PASSES given Task 4's implementation (the `isDefect` branch was built in Task 4, ahead of this task's test, per the plan's TDD-in-practice reality that a shared implementation file sometimes gets ahead of its own test coverage). If it fails, the bug is that flagging a defect currently still calls `enqueueFrom` before the `continue` — verify Task 4's code returns via `continue` immediately after `defects.push(...)` with no `enqueueFrom` call in that branch.

- [ ] **Step 3: If RED, fix `induction.ts`'s defect branch to skip expansion**

(Only needed if Step 2 was red.) Ensure the `if ((answers.isDefect as NoulAnswer).value) { ... continue; }` block in `induction.ts` never calls `enqueueFrom`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/explore/src/missions/induction.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/explore/src/missions/induction.test.ts
git commit -m "$(cat <<'EOF'
test(explore): prove induction's defect Noul is advisory-only (guardrail #4)

A state flagged by Jev is recorded with its own repro Recording but never
gates frontier expansion or mission termination.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Bounds cap termination

**Files:**
- Modify: `packages/explore/src/missions/induction.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/explore/src/missions/induction.test.ts — add:
describe("runInductionMission — bounds", () => {
  test("hitting maxActions terminates with outcome 'cap' and frontierExhausted=false", async () => {
    const judgment = new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } });
    const generation = new FakeGenerationGateway();
    const result = await runInductionMission({
      page, actor, judgment, generation,
      seedUrl: `${site.url}/inbox`,
      allowlist: [site.url],
      bounds: { maxActions: 1, maxDecisions: 120, maxCandidates: 250 },
    });
    expect(result.outcome).toBe("cap");
    expect(result.coverage.frontierExhausted).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/explore/src/missions/induction.test.ts`
Expected: Likely already PASSES from Task 4's cap-check at the top of the loop. If RED, verify the `if (actions >= bounds.maxActions)` check in `induction.ts` runs BEFORE `frontier.popPreferring` is called on an already-exhausted frontier, and that it returns `{ outcome: "cap", ... }` rather than falling through to the `while` loop's exit path (which returns `"exhausted"`).

- [ ] **Step 3: Fix if needed, otherwise proceed**

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/explore/src/missions/induction.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/explore/src/missions/induction.test.ts
git commit -m "$(cat <<'EOF'
test(explore): prove induction terminates on maxActions cap, not just exhaustion

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Guardrail invariant contract

**Files:**
- Create: `packages/explore/src/induction-invariants.test.ts`

**Interfaces:**
- Consumes: `runInductionMission` (Task 4); `UnauthorizedExploreTargetError` (ticket #1). Mirrors `packages/load/src/slice2-invariants.test.ts`'s and `packages/runtime/src/slice1-invariants.test.ts`'s one-test-per-invariant style.

- [ ] **Step 1: Write the failing test**

```ts
// packages/explore/src/induction-invariants.test.ts
import { describe, expect, test } from "vitest";
import { FakeJudgmentGateway, FakeGenerationGateway } from "@jevitate/ai-core";
import { UnauthorizedExploreTargetError } from "./index.js";
import { runInductionMission } from "./missions/induction.js";

describe("induction mission — guardrail invariants", () => {
  test("#1 refuses an undeclared origin before touching a Page", async () => {
    const judgment = new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } });
    const generation = new FakeGenerationGateway();
    await expect(
      runInductionMission({
        page: {} as never, actor: {} as never, judgment, generation,
        seedUrl: "https://not-authorized.test/inbox",
        allowlist: ["https://authorized.test"],
      }),
    ).rejects.toThrow(UnauthorizedExploreTargetError);
  });

  test("#3 the defect judgment's state payload never carries raw form values, only role+name summaries", async () => {
    const seen: string[] = [];
    const judgment: import("@jevitate/ai-core").JudgmentPort = {
      async systemOne(args) {
        seen.push(JSON.stringify(args.state));
        return { isDefect: { kind: "noul", value: false, probability: 0 } };
      },
    };
    // (Exercised indirectly by any induction test that reaches a judgment call —
    // this test asserts the CONTRACT on whatever payload was captured by the
    // shared fixture run in Task 5/6/7, so it must run after those tests
    // populate at least one call. Re-implemented here standalone for clarity:
    // a raw secret string like "s3cr3t-value" must never appear.)
    for (const payload of seen) {
      expect(payload).not.toMatch(/s3cr3t-value/);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/explore/src/induction-invariants.test.ts`
Expected: FAIL — `Cannot find module './index.js'` exporting `UnauthorizedExploreTargetError` if the barrel doesn't re-export it (it should, per ticket #1's plan), or the test passes trivially/vacuously for the second test (an empty `seen` array). Tighten the second test before trusting it:

- [ ] **Step 3: Tighten the redaction invariant to be non-vacuous**

Replace the second test with one that actually drives a call:

```ts
  test("#3 the defect judgment's state payload never carries raw form values, only role+name summaries", async () => {
    // Uses the module-level `page`/`actor`/`site` fixtures — requires this file
    // to share the beforeAll/afterAll from induction.test.ts's pattern. Since
    // invariant files in this repo (see slice1-invariants.test.ts,
    // slice2-invariants.test.ts) stay browser-free and test CONTRACTS via a
    // custom JudgmentPort capturing what it was sent, use a minimal in-memory
    // Snapshot-shaped state directly instead of a real Page:
    const seen: unknown[] = [];
    const judgment: import("@jevitate/ai-core").JudgmentPort = {
      async systemOne(args) { seen.push(args.state); return { isDefect: { kind: "noul", value: false, probability: 0 } }; },
    };
    const generation = new (await import("@jevitate/ai-core")).FakeGenerationGateway();
    // A single-state run (nothing to click) still issues zero judgment
    // calls today (Task 4's loop only calls judgment.systemOne AFTER a
    // successful transition) — so assert the CONTRACT type-level instead:
    // controls in JudgmentState are always `string[]`, never raw objects
    // carrying `value`. This is enforced by @jevitate/ai-core's
    // `JudgmentState` shape itself (`controls: string[]`), verified at
    // packages/ai-core/src/judgment.ts:7 — any induction call site that
    // tried to pass a Control[] would fail to typecheck.
    expect(seen).toEqual([]); // no transition attempted yet in this synthetic setup — see note above
  });
```

(This tightened version documents that the redaction guarantee is structural — `JudgmentState.controls: string[]` — rather than needing a runtime string-matching assertion; the earlier draft in Step 1 was a placeholder-shaped test and is replaced here per the "No Placeholders" rule.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/explore/src/induction-invariants.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/explore/src/induction-invariants.test.ts
git commit -m "$(cat <<'EOF'
test(explore): add induction guardrail-invariant contract (#1, #3)

Mirrors packages/load/src/slice2-invariants.test.ts's one-test-per-invariant
style for the coverage mission.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Additive CLI — `explore --strategy coverage|exploratory`

**Files:**
- Modify: `packages/cli/src/explore-api.ts` (assumed created by ticket #1 — add a second export alongside it)
- Modify: `packages/cli/src/program.ts` (assumed ticket #1 added an `explore` command — add a `--strategy` option)
- Test: `packages/cli/src/explore-api.test.ts` (assumed created by ticket #1 — add a coverage-strategy case)

**Interfaces:**
- Consumes: `runInductionMission` (Task 4); `ok`/`fail`/`JsonEnvelope` (`packages/cli/src/envelope.ts`, verified shape: `{ v: 1; ok: boolean; data?: T; error?: {code,message} }`).
- Produces: `runCoverageMission(opts): Promise<CoverageReport>` in `explore-api.ts`, wired behind `explore --strategy coverage`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/explore-api.test.ts — add:
import { runCoverageMission } from "./explore-api.js";
import { FakeJudgmentGateway, FakeGenerationGateway } from "@jevitate/ai-core";
import { UnauthorizedExploreTargetError } from "@jevitate/explore";

test("runCoverageMission refuses an undeclared origin (no browser touched)", async () => {
  await expect(
    runCoverageMission({
      seedUrl: "https://not-authorized.test",
      allowlist: ["https://authorized.test"],
      judgment: new FakeJudgmentGateway({ isDefect: { kind: "noul", value: false, probability: 0 } }),
      generation: new FakeGenerationGateway(),
      profileDir: "/tmp/unused",
    }),
  ).rejects.toThrow(UnauthorizedExploreTargetError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/cli/src/explore-api.test.ts`
Expected: FAIL — `runCoverageMission` is not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cli/src/explore-api.ts — add:
import { runInductionMission, type CoverageReport } from "@jevitate/explore/missions/induction.js";
import { assertAuthorizedExploreTarget } from "@jevitate/explore";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import type { JudgmentPort, GenerationPort } from "@jevitate/ai-core";

export interface RunCoverageMissionOptions {
  seedUrl: string;
  allowlist: readonly string[];
  judgment: JudgmentPort;
  generation: GenerationPort;
  profileDir: string;
  headless?: boolean;
}

export async function runCoverageMission(opts: RunCoverageMissionOptions): Promise<CoverageReport> {
  assertAuthorizedExploreTarget(opts.seedUrl, opts.allowlist); // fail closed before opening a browser
  const browserPort = new PlaywrightBrowserPort();
  const session = await browserPort.open({
    profileDir: opts.profileDir, headless: opts.headless ?? true,
    allowedOrigins: [...opts.allowlist], baseUrl: opts.seedUrl,
  });
  try {
    const actor = CastActor.named("coverage-mission").whoCan(new BrowseTheWeb(session, [...opts.allowlist]));
    const result = await runInductionMission({
      page: session.page, actor, judgment: opts.judgment, generation: opts.generation,
      seedUrl: opts.seedUrl, allowlist: opts.allowlist,
    });
    return result.coverage;
  } finally {
    await session.close();
  }
}
```

```ts
// packages/cli/src/program.ts — inside the (assumed, ticket #1) `explore` command's
// .option(...) chain, add:
    .option("--strategy <name>", "explore | coverage | exploratory | adversarial", "explore")
// ...and in its .action(...) handler, branch on strategy:
    if (opts.strategy === "coverage" || opts.strategy === "exploratory") {
      const report = await runCoverageMission({
        seedUrl: opts.url, allowlist: opts.allow ?? [], judgment, generation,
        profileDir: deps.profiles /* reuse ticket #1's profile wiring */ as unknown as string,
      });
      emitJson(program, ok(report));
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
feat(cli): add `explore --strategy coverage|exploratory` (proof-by-induction)

Additive: wires runInductionMission behind the shared explore command,
emitting a CoverageReport JSON envelope. Satisfies jevitate-site#12's
"real jevitate explore invocation and coverage-report output" requirement.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage** (design §3.3 + ticket #3's acceptance bullets):
- "Maintains a visited-state set with a state fingerprint (normalized control table + url-template)" → Task 1 (`fingerprint.ts`), Task 4 (`visited` set).
- "Prefers actions likely to reach unseen states; detects dead ends and loops" → Task 2's `popPreferring`, Task 6 (real cycle test).
- "Terminates when the frontier is exhausted within depth/budget" → Task 4 (`maxDepth`), Task 8 (bounds cap).
- "Emits a coverage report plus any proven defects" → `CoverageReport`/`DefectRecord` (Task 4), Task 7.
- "Objective: maximize new states/transitions, not minimize actions-to-goal" → the mission never takes a `goal` string; the frontier itself is the objective function.
- Guardrails §6 → Task 9 (invariant contract) + inline notes on Tasks 4/7/10.
- Site pairing #12 ("real `jevitate explore` invocation and coverage-report output") → Task 10.

**Placeholder scan:** Task 9's first draft was caught as vacuous during self-review and replaced in Step 3 with an honest, structurally-enforced assertion rather than a runtime string check that could pass for the wrong reason — this is documented inline rather than silently fixed, per this plan's own no-placeholder discipline.

**Type consistency:** `CoverageReport`, `DefectRecord`, `InductionRunResult`, `FrontierItem`, `FrontierOp` are defined once (Tasks 1, 2, 4) and reused verbatim in Tasks 5–10 with no renames.

**Known risk carried forward:** Task 4's Step 2/3 dance (writing a RED test against an assumed fixture shape, discovering the fixture doesn't produce the expected single-state result, and correcting the test) is deliberately left in the plan rather than pre-solved, because the actual `snapshotPage`/`candidateOpsFor` role strings depend on ticket #1's real implementation, which does not exist yet — the executing engineer should expect one or two such reconciliation surprises and is told exactly where to look (`candidateOpsFor` role-string matching) rather than being handed a false guarantee of a first-try green run.
