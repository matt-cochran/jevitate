# Self-Healing via Scoped Re-Learn + Splice (Ticket #7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Proposed (plan — for review before execution)
**Date:** 2026-09-20
**Ticket:** [#7](https://github.com/matt-cochran/jevitate/issues/7) — "A broken production step self-heals via scoped re-learn and splice under policy"

**Goal:** When a `Journey` run diverges at one step under a `hybrid`/`full` `SelfHealPolicy`, `@jevitate/runtime`'s `JourneyRunner` attempts a **scoped** repair — re-learn just the broken step (from the live state right after the last-good step, to that step's own postcondition) and **splice** the result into the Recording (reusing `@jevitate/recording`'s existing `spliceRecording`) — then resumes the SAME run. Write/irreversible steps **never** auto-heal, in either `hybrid` or `full` mode. The current default (`fail-closed`) is unchanged.

**Architecture:** `JourneyRunner.run()` already maps an interpreter `"failed"` result straight to `{outcome:"quarantined"}` (Slice 1's fail-closed wiring, already shipped). This plan inserts one gated attempt before that fallback: on `"failed"`, if `policy.selfHeal.mode !== "fail-closed"` and an optional `SelfHealer` port is wired, and the failing step is **read-only** (`isWriteStep` is `false` — the unconditional floor), call `SelfHealer.reLearnStep({ actor, brokenStep, expectedPostcondition })`. The actor is already sitting in the live browser state right after the last-good step (the broken step's own action never completed), so no re-drive-to-checkpoint is needed — this is simpler than the human record-a-patch flow (`@jevitate/recorder`'s `recordPatch`), which starts a fresh session. On success, `healRecording()` builds the healed `Recording` by composing `@jevitate/recording`'s existing `spliceRecording(..., "replace-from")` with a small tail-extraction helper (so exactly the one broken step is replaced and everything after it is preserved unchanged), then the run resumes via the existing `RecordingInterpreter.resumeFrom` at the same step index. The `SelfHealer` **port** lives in `@jevitate/runtime` with zero new dependency edges; the real adapter that drives `@jevitate/explore`'s goal-based mission lives in `@jevitate/cli` (which ticket #1's plan already wires to `@jevitate/explore`), so `@jevitate/runtime` never depends on `@jevitate/explore` — preserving that plan's "nothing depends on explore except cli" constraint.

**Assumption / dependency on #1 (`@jevitate/explore`, planned):** only the CLI adapter (Task 6) needs #1's planned `runGoalBasedMission` export. Tasks 1–5 (the runtime mechanism, gating, and invariants) depend on nothing from #1 and can be built, tested, and merged independently using a hand-rolled fake `SelfHealer` — the real `@jevitate/explore`-backed adapter is the only piece blocked on #1 shipping.

**Tech Stack:** TypeScript strict ESM, Vitest, pnpm workspaces. Depends on `@jevitate/recording` (`Recording`/`Step`/`Assertion`/`PageSegment`/`RecordedStep`/`spliceRecording`), `@jevitate/domain` (`RunPolicy`/`SelfHealMode`), `@jevitate/interpreter` (`RecordingInterpreter`), `@jevitate/screenplay` (`Actor`), `@jevitate/journey` (`Journey`). The CLI adapter additionally depends on `@jevitate/explore` (type-only until #1 ships) and `@jevitate/ai-core`.

**Spec:** `docs/superpowers/specs/2026-09-17-self-healing-operations-design.md` §3–4 (loop, repair paths, data model), `docs/superpowers/specs/2026-09-19-unified-journey-automation-and-testing-design.md` §5–6 (`SelfHealPolicy` modes, §6 "wraps runtime", §9a invariant #8 "writes never auto-heal"), `docs/superpowers/specs/2026-09-17-record-by-demonstration-design.md` §7.4 (replay-to-point + record-a-patch — the mechanism this plan's autonomous variant mirrors), and `docs/superpowers/plans/2026-09-20-testing-missions-exploration-engine.md` P3 ("scoped exploration to re-learn a broken step + splice ... no reinventing the whole journey").

## Global Constraints

- Node 20+, ESM, `strict: true`, project references (`tsc --build`).
- Dependency direction inward only: `@jevitate/runtime` gains NO new package dependency (the `SelfHealer` port + `isWriteStep`/`healRecording` helpers are self-contained, using only types already reachable via `@jevitate/recording`/`@jevitate/screenplay`, both already runtime dependencies). Only `@jevitate/cli`'s adapter (Task 6) adds the `@jevitate/explore` edge, mirroring ticket #1's own Task 12.
- **Repo gotcha:** packages have NO `"test"` script — run `pnpm exec vitest run <path>`, never `pnpm --filter <pkg> test`.
- Git staging is explicit-path only (`git add <exact files>`), never `-A`/`.`.
- Commit trailer for every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- CI runs on fakes only (a hand-rolled fake `SelfHealer` in `@jevitate/runtime`'s tests; fake Jev/generation gateways in the CLI adapter's tests).
- Gitflow: branch off `dev` as `feature/self-heal-splice`, PR back to `dev`.

## Guardrails (binding — each ships an "asserts-it-refuses" test, per §9a invariant #8)

1. **Fail-closed default unchanged.** `safeRunPolicy()` still returns `selfHeal.mode: "fail-closed"`; a `JourneyRunner` under that default never calls `SelfHealer.reLearnStep`, even when one is wired.
2. **Writes never auto-heal — in EITHER `hybrid` or `full`.** `isWriteStep(brokenStep) === true` short-circuits `tryHeal` before the `SelfHealer` is ever invoked, regardless of `selfHeal.mode`.
3. **No SelfHealer, no healing.** `policy.selfHeal.mode !== "fail-closed"` with no `SelfHealer` wired still quarantines (never throws, never silently no-ops into a false "ok").
4. **A repair that doesn't actually fix it still quarantines.** If the healed splice, once resumed, itself fails or the healer reports `"not-healed"`, the run quarantines exactly as it would have without an attempt — self-healing is a chance to recover, never a way to mask an unresolved failure.
5. **Healed runs are distinguishable from clean runs.** A run that only succeeded because of an in-flight repair returns `{outcome:"healed", ...}`, never silently collapsed into the ordinary `{outcome:"ok"}` — every executed step stays auditable.

## File Structure

```
packages/runtime/src/
  self-heal.ts                        # NEW — isWriteStep, postconditionOf, SelfHealer port, extractTail, healRecording
  self-heal.test.ts                   # NEW
  journey-runner.ts                   # MODIFY — SelfHealer param, tryHeal(), rewritten run() loop, "healed" outcome
  journey-runner.test.ts              # MODIFY — self-heal success/refusal cases
  self-heal-invariants.test.ts        # NEW — §9a invariant #8 refusal contract
  index.ts                            # MODIFY — export self-heal.ts

packages/cli/src/
  self-heal-adapter.ts                # NEW — ExploreSelfHealer (depends on @jevitate/explore, ticket #1)
  self-heal-adapter.test.ts           # NEW
  journey-api.ts                      # MODIFY — + --self-heal flag wiring
  program.ts                          # MODIFY — + `journey run --self-heal <mode>` option
```

---

## Task 1: `isWriteStep` + `postconditionOf` (pure classifiers)

**Files:**
- Create: `packages/runtime/src/self-heal.ts`
- Test: `packages/runtime/src/self-heal.test.ts`

**Interfaces:**
- Consumes: `Step`, `Assertion` from `@jevitate/recording`.
- Produces: `isWriteStep(step: Step): boolean`, `postconditionOf(step: Step): Assertion | undefined`.

- [ ] **Step 1: Write the failing tests**

`packages/runtime/src/self-heal.test.ts`:
```ts
import { expect, test } from "vitest";
import type { Step } from "@jevitate/recording";
import { isWriteStep, postconditionOf } from "./self-heal.js";

const visible: Step["kind"] extends never ? never : { kind: "visible"; target: { testId: string } } = { kind: "visible", target: { testId: "ok" } };

test("navigate/waitFor/extract/assert are read-only", () => {
  expect(isWriteStep({ kind: "navigate", url: "/x", expect: visible })).toBe(false);
  expect(isWriteStep({ kind: "waitFor", target: { testId: "x" }, state: "visible" })).toBe(false);
  expect(isWriteStep({ kind: "extract", target: { testId: "x" }, as: "v", expect: visible })).toBe(false);
  expect(isWriteStep({ kind: "assert", check: visible })).toBe(false);
});

test("click/fill/select/press/forEach/handback are writes", () => {
  expect(isWriteStep({ kind: "click", target: { testId: "x" }, expect: visible })).toBe(true);
  expect(isWriteStep({ kind: "fill", target: { testId: "x" }, value: { redacted: true, length: 1 }, expect: visible })).toBe(true);
  expect(isWriteStep({ kind: "select", target: { testId: "x" }, value: { redacted: true, length: 1 }, expect: visible })).toBe(true);
  expect(isWriteStep({ kind: "press", key: "Enter", expect: visible })).toBe(true);
  expect(isWriteStep({ kind: "forEach", items: { testId: "x" }, as: "row", steps: [] })).toBe(true);
  expect(isWriteStep({ kind: "handback", prompt: "p", resume: visible })).toBe(true);
});

test("postconditionOf returns the step's own Assertion for navigate/click/fill/select/press/extract/assert", () => {
  expect(postconditionOf({ kind: "navigate", url: "/x", expect: visible })).toBe(visible);
  expect(postconditionOf({ kind: "click", target: { testId: "x" }, expect: visible })).toBe(visible);
  expect(postconditionOf({ kind: "assert", check: visible })).toBe(visible);
});

test("postconditionOf returns undefined for waitFor/forEach (no Assertion to reach)", () => {
  expect(postconditionOf({ kind: "waitFor", target: { testId: "x" }, state: "visible" })).toBeUndefined();
  expect(postconditionOf({ kind: "forEach", items: { testId: "x" }, as: "row", steps: [] })).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/runtime/src/self-heal.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/runtime/src/self-heal.ts`:
```ts
import type { Step, Assertion } from "@jevitate/recording";

/**
 * Mirrors `@jevitate/sources`'s `classifyRisk`'s per-step-kind judgment
 * (`READ_ONLY_KINDS`), duplicated here rather than imported: `@jevitate/sources`
 * depends on `@jevitate/journey`/`@jevitate/recording`, and `@jevitate/runtime`
 * must stay upstream of `@jevitate/sources` in the dependency graph (runtime
 * executes what sources resolves), so importing from `@jevitate/sources`
 * here would invert that edge. Flagged as a deliberate, small duplication
 * (see this plan's Risks section) — a future refactor could lift both onto
 * one shared `@jevitate/recording` export.
 */
const READ_ONLY_STEP_KINDS = new Set<Step["kind"]>(["navigate", "waitFor", "extract", "assert"]);

/** §9a invariant #8's unconditional floor: true for every step kind that
 * is NOT in `READ_ONLY_STEP_KINDS` — never bypassed by any `SelfHealMode`. */
export function isWriteStep(step: Step): boolean {
  return !READ_ONLY_STEP_KINDS.has(step.kind);
}

/** The failing step's own postcondition, if it carries one — this is what a
 * scoped re-learn must reach. `waitFor` (a `state`, not an `Assertion`) and
 * `forEach` (a control-flow container) have none and can never be
 * self-healed via this mechanism. */
export function postconditionOf(step: Step): Assertion | undefined {
  switch (step.kind) {
    case "navigate":
    case "click":
    case "fill":
    case "select":
    case "press":
    case "extract":
      return step.expect;
    case "assert":
      return step.check;
    default:
      return undefined;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/runtime/src/self-heal.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/self-heal.ts packages/runtime/src/self-heal.test.ts
git commit -m "$(cat <<'EOF'
feat(runtime): isWriteStep/postconditionOf classifiers for self-healing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `extractTail` + `healRecording` (schema-preserving splice composition)

**Files:**
- Modify: `packages/runtime/src/self-heal.ts`
- Modify: `packages/runtime/src/self-heal.test.ts`

**Interfaces:**
- Consumes: `spliceRecording` from `@jevitate/recording`.
- Produces: `extractTail(base: Recording, fromFlatIndex: number): PageSegment[]`, `healRecording(base: Recording, brokenFlatIndex: number, healedSegment: Recording): Recording`, `flattenRecording(rec: Recording): { step: Step }[]`.

- [ ] **Step 1: Write the failing tests**

Add to `self-heal.test.ts`:
```ts
import { extractTail, healRecording, flattenRecording } from "./self-heal.js";
import type { Recording } from "@jevitate/recording";

function baseRecording(): Recording {
  return {
    version: "1.0",
    site: "https://example.test",
    pages: [
      {
        url: "/a",
        steps: [
          { step: { kind: "navigate", url: "/a", expect: { kind: "visible", target: { testId: "loaded" } } } }, // 0
          { step: { kind: "click", target: { testId: "old-button" }, expect: { kind: "visible", target: { testId: "next" } } } }, // 1 (broken)
        ],
      },
      {
        url: "/b",
        steps: [
          { step: { kind: "assert", check: { kind: "urlIncludes", text: "/b" } } }, // 2
        ],
      },
    ],
  };
}

test("flattenRecording preserves page-then-step order", () => {
  expect(flattenRecording(baseRecording()).map((e) => e.step.kind)).toEqual(["navigate", "click", "assert"]);
});

test("extractTail returns every step from the given flat index onward, re-flowed into pages", () => {
  const tail = extractTail(baseRecording(), 2);
  expect(tail).toEqual([{ url: "/b", steps: [{ step: { kind: "assert", check: { kind: "urlIncludes", text: "/b" } } }] }]);
});

test("healRecording replaces exactly the broken step and preserves the tail unchanged", () => {
  const base = baseRecording();
  const healedSegment: Recording = {
    version: "1.0",
    site: "https://example.test",
    pages: [{ url: "/a", steps: [{ step: { kind: "click", target: { testId: "new-button" }, expect: { kind: "visible", target: { testId: "next" } } } }] }],
  };
  const healed = healRecording(base, 1, healedSegment);
  const flat = flattenRecording(healed);
  expect(flat).toHaveLength(3);
  expect(flat[0].step.kind).toBe("navigate"); // unchanged before the break
  expect(flat[1].step).toEqual(healedSegment.pages[0].steps[0].step); // the re-learned replacement
  expect(flat[2].step.kind).toBe("assert"); // the original tail, preserved
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/runtime/src/self-heal.test.ts`
Expected: FAIL — `extractTail`/`healRecording`/`flattenRecording` not exported.

- [ ] **Step 3: Implement**

Append to `packages/runtime/src/self-heal.ts`:
```ts
import type { Recording, PageSegment, RecordedStep } from "@jevitate/recording";
import { spliceRecording } from "@jevitate/recording";

/** Flattens a Recording's pages into a page-then-step-ordered list of its
 * `Step`s — the same order `@jevitate/interpreter`'s `run`/`resumeFrom`
 * index into via their `at`/`fromIndex`. */
export function flattenRecording(rec: Recording): { step: Step }[] {
  return rec.pages.flatMap((p) => p.steps.map((s) => ({ step: s.step })));
}

/**
 * Extracts every step from `base` at or after `fromFlatIndex` (in flat
 * page-then-step order), re-flowed into `PageSegment[]` — the tail that
 * must survive a scoped repair unchanged. Mirrors `@jevitate/recorder`'s
 * `checkpointToSpliceAt` walk.
 */
export function extractTail(base: Recording, fromFlatIndex: number): PageSegment[] {
  const tail: PageSegment[] = [];
  let seen = 0;
  for (const page of base.pages) {
    const keep: RecordedStep[] = [];
    for (const step of page.steps) {
      if (seen >= fromFlatIndex) keep.push(step);
      seen++;
    }
    if (keep.length > 0) tail.push({ ...page, steps: keep });
  }
  return tail;
}

/** `{page, step}` position of the step AT `brokenFlatIndex` itself — the
 * splice point for `spliceRecording`'s `"replace-from"` mode, which drops
 * everything from that position onward. One less than
 * `@jevitate/recorder`'s `checkpointToSpliceAt` (which points just AFTER a
 * checkpoint step). */
function spliceAtBroken(base: Recording, brokenFlatIndex: number): { page: number; step: number } {
  let remaining = brokenFlatIndex;
  for (let page = 0; page < base.pages.length; page++) {
    const len = base.pages[page]!.steps.length;
    if (remaining < len) return { page, step: remaining };
    remaining -= len;
  }
  throw new Error(`spliceAtBroken: index ${brokenFlatIndex} out of range for a ${base.pages.reduce((n, p) => n + p.steps.length, 0)}-step recording`);
}

/**
 * Builds the healed `Recording`: `base` with the broken step (at
 * `brokenFlatIndex`) AND everything after it replaced by `healedSegment`'s
 * own pages followed by the ORIGINAL tail from `brokenFlatIndex + 1`
 * onward — so exactly one step is genuinely replaced and every step after
 * it is preserved unchanged. Composed entirely from `spliceRecording`'s
 * existing `"replace-from"` mode plus `extractTail`, rather than a new
 * splice mode.
 */
export function healRecording(base: Recording, brokenFlatIndex: number, healedSegment: Recording): Recording {
  const tail = extractTail(base, brokenFlatIndex + 1);
  const replacement: Recording = { ...healedSegment, pages: [...healedSegment.pages, ...tail] };
  const at = spliceAtBroken(base, brokenFlatIndex);
  return spliceRecording(base, at, replacement, "replace-from");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/runtime/src/self-heal.test.ts`
Expected: PASS (7 tests total in this file).

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/self-heal.ts packages/runtime/src/self-heal.test.ts
git commit -m "$(cat <<'EOF'
feat(runtime): healRecording — scoped single-step replace via existing spliceRecording

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `SelfHealer` port + `JourneyRunner` wiring

**Files:**
- Modify: `packages/runtime/src/self-heal.ts` (add the `SelfHealer` interface)
- Modify: `packages/runtime/src/journey-runner.ts`
- Modify: `packages/runtime/src/journey-runner.test.ts`

**Interfaces:**
- Produces: `SelfHealer { reLearnStep(args: { actor: Actor; brokenStep: Step; expectedPostcondition: Assertion; allowedOrigins?: readonly string[] }): Promise<{ outcome: "healed"; segment: Recording } | { outcome: "not-healed"; reason: string }> }`; `JourneyRunResult` gains `{ outcome: "healed"; output: unknown; healedRecording: Recording; healedAt: number }`; `JourneyRunner`'s constructor gains an optional 5th param `selfHealer?: SelfHealer`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/runtime/src/journey-runner.test.ts` (alongside its existing fakes — reuse its established `actorWithPage`/`fakeLocator`/`fakeInterpreter` helpers per that file's own pattern):
```ts
import { isWriteStep } from "./self-heal.js";
import type { SelfHealer } from "./self-heal.js";

function fakeHealer(response: Awaited<ReturnType<SelfHealer["reLearnStep"]>>): SelfHealer {
  return { reLearnStep: vi.fn(async () => response) };
}

const healedSegment: Recording = {
  version: "1.0",
  site: "https://example.test",
  pages: [{ url: "/a", steps: [{ step: { kind: "click", target: { testId: "new-button" }, expect: { kind: "visible", target: { testId: "next" } } } }] }],
};

test("hybrid + read-only broken step + a healer that succeeds -> outcome 'healed', run completes", async () => {
  // recording: navigate (0, ok) -> click on a testId the fake page can no
  // longer find (1, fails) -> assert (2, would pass once resumed).
  const recording = journeyWithBrokenReadOnlyStep(); // helper: builds a Recording matching this file's existing fixture conventions
  const healer = fakeHealer({ outcome: "healed", segment: healedSegment });
  const runner = new JourneyRunner(actor, fakeInterpreterThatFailsThenHeals(), undefined, undefined, healer);

  const result = await runner.run({
    journey: { metadata: baseMetadata, recording },
    params: {},
    policy: { selfHeal: { mode: "hybrid" }, direction: { direction: "deterministic" }, secret: { secretMode: "fail-closed" } },
  });

  expect(result.outcome).toBe("healed");
  expect(healer.reLearnStep).toHaveBeenCalledOnce();
});

test("hybrid + WRITE broken step (fill) -> healer is NEVER called, quarantines (invariant #8)", async () => {
  const recording = journeyWithBrokenWriteStep(); // a fill step fails instead
  const healer = fakeHealer({ outcome: "healed", segment: healedSegment });
  const runner = new JourneyRunner(actor, fakeInterpreterThatFails(), undefined, undefined, healer);

  const result = await runner.run({
    journey: { metadata: baseMetadata, recording },
    params: {},
    policy: { selfHeal: { mode: "hybrid" }, direction: { direction: "deterministic" }, secret: { secretMode: "fail-closed" } },
  });

  expect(healer.reLearnStep).not.toHaveBeenCalled();
  expect(result.outcome).toBe("quarantined");
});

test("full + WRITE broken step -> still refuses (the floor is not bypassed by 'full')", async () => {
  const recording = journeyWithBrokenWriteStep();
  const healer = fakeHealer({ outcome: "healed", segment: healedSegment });
  const runner = new JourneyRunner(actor, fakeInterpreterThatFails(), undefined, undefined, healer);

  const result = await runner.run({
    journey: { metadata: baseMetadata, recording },
    params: {},
    policy: { selfHeal: { mode: "full" }, direction: { direction: "deterministic" }, secret: { secretMode: "fail-closed" } },
  });

  expect(healer.reLearnStep).not.toHaveBeenCalled();
  expect(result.outcome).toBe("quarantined");
});

test("fail-closed (default) -> healer never called even when wired and read-only", async () => {
  const recording = journeyWithBrokenReadOnlyStep();
  const healer = fakeHealer({ outcome: "healed", segment: healedSegment });
  const runner = new JourneyRunner(actor, fakeInterpreterThatFails(), undefined, undefined, healer);

  const result = await runner.run({
    journey: { metadata: baseMetadata, recording },
    params: {},
    policy: safeRunPolicy(), // { selfHeal: { mode: "fail-closed" }, ... }
  });

  expect(healer.reLearnStep).not.toHaveBeenCalled();
  expect(result.outcome).toBe("quarantined");
});

test("hybrid + read-only step + healer reports not-healed -> quarantines (no false recovery)", async () => {
  const recording = journeyWithBrokenReadOnlyStep();
  const healer = fakeHealer({ outcome: "not-healed", reason: "could not reach the postcondition" });
  const runner = new JourneyRunner(actor, fakeInterpreterThatFails(), undefined, undefined, healer);

  const result = await runner.run({
    journey: { metadata: baseMetadata, recording },
    params: {},
    policy: { selfHeal: { mode: "hybrid" }, direction: { direction: "deterministic" }, secret: { secretMode: "fail-closed" } },
  });

  expect(result.outcome).toBe("quarantined");
});
```

(`journeyWithBrokenReadOnlyStep`/`journeyWithBrokenWriteStep`/`fakeInterpreterThatFails`/`fakeInterpreterThatFailsThenHeals`/`baseMetadata` are small local test helpers to add alongside this file's existing fixtures, following its established `fakeInterpreter`-returning-a-scripted-`InterpretResult` pattern already used elsewhere in `journey-runner.test.ts`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/runtime/src/journey-runner.test.ts`
Expected: FAIL — `JourneyRunner`'s constructor doesn't accept a 5th param, and `"healed"` is not a valid `JourneyRunResult` outcome.

- [ ] **Step 3: Implement**

In `packages/runtime/src/self-heal.ts`, add:
```ts
import type { Actor } from "@jevitate/screenplay";

export interface SelfHealer {
  /**
   * Scoped re-learn of exactly one broken step: `actor` is already sitting
   * in the LIVE state right after the last-good step (the failed step's own
   * action never completed) — the healer drives from there to
   * `expectedPostcondition` and returns the newly-learned segment as a
   * `Recording` (its own pages, starting fresh from the current page — no
   * leading `navigate`, matching the recorder's start-from-state capture
   * convention). Returns `"not-healed"` (never throws for an ordinary
   * failure to re-learn) when it could not reach the postcondition within
   * its own bounds.
   */
  reLearnStep(args: {
    actor: Actor;
    brokenStep: Step;
    expectedPostcondition: Assertion;
    allowedOrigins?: readonly string[];
  }): Promise<{ outcome: "healed"; segment: Recording } | { outcome: "not-healed"; reason: string }>;
}
```

In `packages/runtime/src/journey-runner.ts`, replace the `JourneyRunResult` type, the constructor, and the body of `run()`:
```ts
import { isWriteStep, postconditionOf, healRecording, flattenRecording, type SelfHealer } from "./self-heal.js";

export type JourneyRunResult =
  | { outcome: "ok"; output: unknown }
  | { outcome: "healed"; output: unknown; healedRecording: Recording; healedAt: number }
  | { outcome: "quarantined"; reason: string; at?: number };

export class JourneyRunner {
  constructor(
    private readonly actor: Actor,
    private readonly interpreter: RecordingInterpreter,
    private readonly handback?: HandbackHandler,
    private readonly secretManager?: SecretManagerPort,
    private readonly selfHealer?: SelfHealer,
  ) {}

  async run(req: JourneyRunRequest): Promise<JourneyRunResult> {
    assertCompletePolicy(req?.policy);
    validateParams(deriveParamSchema(req.journey.recording), req.params);

    if (req.policy.secret.secretMode === "vault-autofill") {
      await this.preflightSecretRefs(req.journey.metadata.secretRefs ?? []);
    }

    let recording = req.journey.recording;
    let result = await this.interpreter.run(this.actor, recording, req.params);
    let healedAt: number | undefined;

    for (;;) {
      if (result.outcome === "awaiting_human") {
        if (req.policy.secret.secretMode === "vault-autofill") {
          const refusal = await this.fillViaVaultAutofill(req, result);
          if (refusal) return refusal;
          result = await this.interpreter.resumeFrom(this.actor, recording, result.at + 1, req.params);
          continue;
        }
        if (req.policy.secret.secretMode !== "visible-handback" || !this.handback) {
          return { outcome: "quarantined", reason: "secret step reached under fail-closed/unattended secretMode", at: result.at };
        }
        await this.handback.present(result.prompt);
        const ok = await checkAssertion(this.actor, result.resume);
        if (!ok) {
          return { outcome: "quarantined", reason: `handback resume postcondition not satisfied at step ${result.at}`, at: result.at };
        }
        result = await this.interpreter.resumeFrom(this.actor, recording, result.at + 1, req.params);
        continue;
      }

      if (result.outcome === "failed") {
        const healed = await this.tryHeal(req.policy, recording, result.at);
        if (healed) {
          healedAt = result.at;
          recording = healed.healedRecording;
          result = await this.interpreter.resumeFrom(this.actor, recording, result.at, req.params);
          continue;
        }
        return { outcome: "quarantined", reason: `step ${result.at} failed: ${result.error}`, at: result.at };
      }

      // result.outcome === "completed"
      return healedAt === undefined
        ? { outcome: "ok", output: result.vars }
        : { outcome: "healed", output: result.vars, healedRecording: recording, healedAt };
    }
  }

  /**
   * §9a invariant #8 (write floor): a write/irreversible step NEVER
   * auto-heals, in EITHER `hybrid` or `full` mode — only a `RunPolicy` with
   * `selfHeal.mode !== "fail-closed"`, a wired `SelfHealer`, and a
   * READ-ONLY broken step reach the healer at all. Returns `undefined`
   * (never healed) for every other case, including when the healer itself
   * reports `"not-healed"`.
   */
  private async tryHeal(
    policy: RunPolicy,
    recording: Recording,
    brokenFlatIndex: number,
  ): Promise<{ healedRecording: Recording } | undefined> {
    if (policy.selfHeal.mode === "fail-closed" || !this.selfHealer) return undefined;

    const flat = flattenRecording(recording);
    const brokenEntry = flat[brokenFlatIndex];
    if (!brokenEntry) return undefined;
    if (isWriteStep(brokenEntry.step)) return undefined; // the floor — never bypassed by "full"

    const postcondition = postconditionOf(brokenEntry.step);
    if (!postcondition) return undefined;

    const healResult = await this.selfHealer.reLearnStep({
      actor: this.actor,
      brokenStep: brokenEntry.step,
      expectedPostcondition: postcondition,
    });
    if (healResult.outcome !== "healed") return undefined;

    return { healedRecording: healRecording(recording, brokenFlatIndex, healResult.segment) };
  }

  // ...preflightSecretRefs and fillViaVaultAutofill are unchanged...
}
```
(the `Recording` type import — already present in this file via `Journey`'s recording field — must additionally be imported directly: add `type { Recording }` to the existing `@jevitate/recording`-sourced import, or add a fresh `import type { Recording } from "@jevitate/recording";` line if that package isn't already imported by name in this file.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/runtime/src/journey-runner.test.ts`
Expected: PASS — all pre-existing tests in this file still pass (no `selfHealer` wired → `tryHeal` always short-circuits to `undefined`, identical behavior to before), plus the 5 new tests.

- [ ] **Step 5: Run the full runtime package suite to confirm no regression**

Run: `pnpm exec vitest run packages/runtime`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/runtime/src/self-heal.ts packages/runtime/src/journey-runner.ts packages/runtime/src/journey-runner.test.ts
git commit -m "$(cat <<'EOF'
feat(runtime): SelfHealer-gated scoped repair in JourneyRunner.run()

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Export from the package barrel

**Files:**
- Modify: `packages/runtime/src/index.ts`

**Interfaces:**
- Produces: `self-heal.ts`'s public surface (`isWriteStep`, `postconditionOf`, `extractTail`, `healRecording`, `flattenRecording`, `SelfHealer`) reachable from `@jevitate/runtime`.

- [ ] **Step 1: Modify the barrel**

`packages/runtime/src/index.ts`:
```ts
export * from "./runner.js";
export * from "./journey-runner.js";
export * from "./self-heal.js";
```

- [ ] **Step 2: Run the full runtime suite to confirm the export doesn't break anything**

Run: `pnpm exec vitest run packages/runtime`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/runtime/src/index.ts
git commit -m "$(cat <<'EOF'
chore(runtime): export self-heal.ts from the package barrel

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Invariant contract (§9a invariant #8, dedicated file)

**Files:**
- Create: `packages/runtime/src/self-heal-invariants.test.ts`

**Interfaces:**
- Consumes: `JourneyRunner`, `SelfHealer` (Task 3).

- [ ] **Step 1: Write the invariant tests**

`packages/runtime/src/self-heal-invariants.test.ts` (mirrors the repo's established pattern, e.g. `packages/runtime/src/slice1-invariants.test.ts`):
```ts
import { expect, test, vi } from "vitest";
import { safeRunPolicy } from "@jevitate/domain";
import { JourneyRunner } from "./journey-runner.js";
import type { SelfHealer } from "./self-heal.js";
// reuse this file's neighbors' established actor/interpreter fake helpers
// (see journey-runner.test.ts) for `actor`, `fakeInterpreterThatFails`,
// `journeyWithBrokenWriteStep`, `journeyWithBrokenReadOnlyStep`, `baseMetadata`.

test("#8a hybrid never calls the healer for a write step", async () => {
  const healer: SelfHealer = { reLearnStep: vi.fn(async () => ({ outcome: "healed", segment: healedSegmentFixture() })) };
  const runner = new JourneyRunner(actor, fakeInterpreterThatFails(), undefined, undefined, healer);
  const result = await runner.run({
    journey: { metadata: baseMetadata, recording: journeyWithBrokenWriteStep() },
    params: {},
    policy: { selfHeal: { mode: "hybrid" }, direction: { direction: "deterministic" }, secret: { secretMode: "fail-closed" } },
  });
  expect(healer.reLearnStep).not.toHaveBeenCalled();
  expect(result.outcome).toBe("quarantined");
});

test("#8b full never calls the healer for a write step", async () => {
  const healer: SelfHealer = { reLearnStep: vi.fn(async () => ({ outcome: "healed", segment: healedSegmentFixture() })) };
  const runner = new JourneyRunner(actor, fakeInterpreterThatFails(), undefined, undefined, healer);
  const result = await runner.run({
    journey: { metadata: baseMetadata, recording: journeyWithBrokenWriteStep() },
    params: {},
    policy: { selfHeal: { mode: "full" }, direction: { direction: "deterministic" }, secret: { secretMode: "fail-closed" } },
  });
  expect(healer.reLearnStep).not.toHaveBeenCalled();
  expect(result.outcome).toBe("quarantined");
});

test("current default remains fail-closed: safeRunPolicy() never triggers a heal attempt", async () => {
  const healer: SelfHealer = { reLearnStep: vi.fn(async () => ({ outcome: "healed", segment: healedSegmentFixture() })) };
  const runner = new JourneyRunner(actor, fakeInterpreterThatFails(), undefined, undefined, healer);
  const result = await runner.run({
    journey: { metadata: baseMetadata, recording: journeyWithBrokenReadOnlyStep() },
    params: {},
    policy: safeRunPolicy(),
  });
  expect(healer.reLearnStep).not.toHaveBeenCalled();
  expect(result.outcome).toBe("quarantined");
  expect(safeRunPolicy().selfHeal.mode).toBe("fail-closed");
});
```

- [ ] **Step 2: Run to verify all pass**

Run: `pnpm exec vitest run packages/runtime/src/self-heal-invariants.test.ts`
Expected: PASS (3 tests). If any fails, Task 3's gating logic has a gap — fix `tryHeal` there, not here.

- [ ] **Step 3: Commit**

```bash
git add packages/runtime/src/self-heal-invariants.test.ts
git commit -m "$(cat <<'EOF'
test(runtime): §9a invariant #8 — writes never auto-heal, in hybrid or full

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: CLI adapter — `ExploreSelfHealer` (blocked on #1)

**Files:**
- Create: `packages/cli/src/self-heal-adapter.ts`
- Test: `packages/cli/src/self-heal-adapter.test.ts`
- Modify: `packages/cli/package.json` (+ `"@jevitate/explore": "workspace:*"` — a no-op if ticket #1's own Task 12 already added it), `packages/cli/tsconfig.json` (+ `{ "path": "../explore" }`, same caveat)

**Interfaces:**
- Consumes: `SelfHealer` from `@jevitate/runtime`; `runGoalBasedMission` (ticket #1's planned Task 10 export — **assumption**, written against `{goal, successAssertion, allowlist, actor, judgment, generation}` → `{outcome, recording, transcript}`).
- Produces: `makeExploreSelfHealer(judgment: JudgmentPort, generation: GenerationPort): SelfHealer`.

- [ ] **Step 1: Write the failing test**

`packages/cli/src/self-heal-adapter.test.ts`:
```ts
import { expect, test, vi } from "vitest";
import type { Recording, Assertion } from "@jevitate/recording";
import type { JudgmentPort, GenerationPort } from "@jevitate/ai-core";
import { makeExploreSelfHealer } from "./self-heal-adapter.js";

const segment: Recording = { version: "1.0", site: "https://example.test", pages: [] };

vi.mock("@jevitate/explore", () => ({
  runGoalBasedMission: vi.fn(async () => ({ outcome: "succeeded", recording: segment, transcript: [] })),
}));

const judgment: JudgmentPort = { systemOne: vi.fn(async () => ({})) };
const generation: GenerationPort = { generate: vi.fn(async () => ({ output: { text: "" }, provenance: { model: "fake", tookMs: 0 } })) } as any;

test("maps a succeeded mission to {outcome: 'healed', segment}", async () => {
  const healer = makeExploreSelfHealer(judgment, generation);
  const expectedPostcondition: Assertion = { kind: "visible", target: { testId: "next" } };
  const result = await healer.reLearnStep({
    actor: {} as any,
    brokenStep: { kind: "click", target: { testId: "old-button" }, expect: expectedPostcondition },
    expectedPostcondition,
  });
  expect(result).toEqual({ outcome: "healed", segment });
});

test("maps a non-succeeded mission to {outcome: 'not-healed'}", async () => {
  const { runGoalBasedMission } = await import("@jevitate/explore");
  (runGoalBasedMission as any).mockResolvedValueOnce({ outcome: "blocked", recording: segment, transcript: [] });

  const healer = makeExploreSelfHealer(judgment, generation);
  const expectedPostcondition: Assertion = { kind: "visible", target: { testId: "next" } };
  const result = await healer.reLearnStep({
    actor: {} as any,
    brokenStep: { kind: "click", target: { testId: "old-button" }, expect: expectedPostcondition },
    expectedPostcondition,
  });
  expect(result.outcome).toBe("not-healed");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/cli/src/self-heal-adapter.test.ts`
Expected: FAIL — module not found (and, until #1 ships, the `@jevitate/explore` mock target doesn't exist as a real package export either — this task is explicitly blocked on #1; do not attempt Steps 3–5 until `@jevitate/explore`'s `missions/goal-based.ts` is real).

- [ ] **Step 3: Implement**

`packages/cli/src/self-heal-adapter.ts`:
```ts
import type { SelfHealer } from "@jevitate/runtime";
import { runGoalBasedMission } from "@jevitate/explore"; // ticket #1 planned export — see plan Assumptions
import type { JudgmentPort, GenerationPort } from "@jevitate/ai-core";

export function makeExploreSelfHealer(judgment: JudgmentPort, generation: GenerationPort): SelfHealer {
  return {
    async reLearnStep({ actor, brokenStep, expectedPostcondition, allowedOrigins }) {
      const result = await runGoalBasedMission({
        goal: describeBrokenStepGoal(brokenStep),
        successAssertion: expectedPostcondition,
        allowlist: allowedOrigins ?? [],
        actor,
        judgment,
        generation,
      });
      return result.outcome === "succeeded"
        ? { outcome: "healed", segment: result.recording }
        : { outcome: "not-healed", reason: `re-learn mission ${result.outcome}` };
    },
  };
}

function describeBrokenStepGoal(step: { kind: string }): string {
  return `Perform the equivalent of a "${step.kind}" step to satisfy the expected postcondition — the site appears to have changed since this step was recorded.`;
}
```

Add `"@jevitate/explore": "workspace:*"` to `packages/cli/package.json` and `{ "path": "../explore" }` to `packages/cli/tsconfig.json` if ticket #1's own Task 12 hasn't already added them.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/cli/src/self-heal-adapter.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/self-heal-adapter.ts packages/cli/src/self-heal-adapter.test.ts packages/cli/package.json packages/cli/tsconfig.json
git commit -m "$(cat <<'EOF'
feat(cli): ExploreSelfHealer adapter (JourneyRunner.SelfHealer over @jevitate/explore)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

**Note on sequencing:** the goal text produced by `describeBrokenStepGoal` is a minimal, mechanical placeholder ("perform the equivalent of a click..."), not natural-language-quality — improving it (e.g. via the generation gateway, or by carrying a human-authored label from the original step) is flagged as follow-up work, not silently deferred: see Risks below.

---

## Task 7: CLI wiring — `journey run --self-heal <mode>`

**Files:**
- Modify: `packages/cli/src/journey-api.ts`
- Modify: `packages/cli/src/program.ts`
- Modify: `packages/cli/src/journey-cli.test.ts`

**Interfaces:**
- Consumes: `makeExploreSelfHealer` (Task 6); `JourneyRunner` from `@jevitate/runtime`.

- [ ] **Step 1: Write the failing test**

Add to `packages/cli/src/journey-cli.test.ts` (reusing that file's existing `makeJourney`/`seedJourneysDir`/`newProgram` helpers):
```ts
test("journey run --self-heal hybrid wires a SelfHealer into the JourneyRunner", async () => {
  // Construction-only smoke test: asserts the CLI accepts the flag and
  // threads it into RunPolicy.selfHeal.mode without throwing a
  // PolicyEnforcementError or an "unknown option" error. A full self-heal
  // run through the CLI is exercised by packages/runtime's own tests
  // (Task 3) and self-heal-adapter.test.ts (Task 6) — this test is only
  // about the CLI's flag plumbing.
  const dir = await seedJourneysDir([makeJourney()]);
  const program = newProgram();
  await expect(
    program.parseAsync(["node", "jevitate", "journey", "run", "login", "--journeys-dir", dir, "--self-heal", "hybrid"]),
  ).resolves.not.toThrow();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/cli/src/journey-cli.test.ts`
Expected: FAIL — `--self-heal` is an unrecognized option.

- [ ] **Step 3: Implement**

In `packages/cli/src/program.ts`, on the existing `journey run` subcommand, add:
```ts
.option("--self-heal <mode>", "self-heal policy mode: fail-closed | hybrid | full", "fail-closed")
```
and thread `opts.selfHeal` into the `RunPolicy` construction (`selfHeal: { mode: opts.selfHeal }`) passed to `runJourneyProgrammatically` (in `journey-api.ts`).

In `packages/cli/src/journey-api.ts`, extend `runJourneyProgrammatically`'s options to accept `selfHealMode?: SelfHealMode` and, when it is not `"fail-closed"`, construct the `JourneyRunner` with a 5th argument `makeExploreSelfHealer(judgment, generation)` (reusing whatever live/fake gateway wiring the existing `journey run` path already builds for other AI-backed features — if `journey run` currently has no gateway wiring at all, gate this behind the same credential-preflight pattern ticket #1's Task 12 and this plan's Task 6 already establish, failing closed with a clear error if `--self-heal` is requested but no gateways are configured, rather than silently running with `selfHealer: undefined`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/cli/src/journey-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/journey-api.ts packages/cli/src/program.ts packages/cli/src/journey-cli.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): journey run --self-heal <fail-closed|hybrid|full>

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

**Acceptance:** `jevitate journey run <id> --self-heal hybrid` recovers from a read-only step's divergence via scoped re-learn + splice and completes with a `"healed"` outcome; the same command with a write step broken, or with `--self-heal fail-closed` (the default), quarantines exactly as today; `pnpm exec vitest run packages/runtime` and the CLI tests pass on fakes.

## Risks / open decisions (flagged, not silently resolved)

- **Duplicated read-only-step-kind classifier.** `isWriteStep` (Task 1) duplicates `@jevitate/sources`'s `classifyRisk`'s `READ_ONLY_KINDS` set rather than importing it, to avoid a new `@jevitate/runtime -> @jevitate/sources` dependency edge. A future refactor could lift both onto one shared `@jevitate/recording` export; not done here to keep this plan's dependency footprint at zero new edges for the runtime package.
- **`hybrid` vs `full` currently gate identically.** Per §9a invariant #8 ("in hybrid/full, write... steps fail closed"), this plan's write-step floor applies unconditionally in both modes — the umbrella spec's broader "full: repair through anything within budget+bounds" scope (beyond the write floor) is not further differentiated here; that distinction (if any, beyond the floor) is deferred to a future slice.
- **Goal-text synthesis for the re-learn mission is mechanical.** `describeBrokenStepGoal` (Task 6) produces a minimal, non-natural-language goal string. Richer goal synthesis (e.g. via the generation gateway, or a human-authored step label carried through) is flagged as follow-up, not built here.
- **Healed-Recording persistence/promotion is out of scope.** This plan's `{outcome:"healed", healedRecording, ...}` result surfaces the in-memory patched Recording for THIS run only; persisting it back to the `Journey` registry as a new candidate — and the human-approval/canary pipeline the self-healing-ops spec (§2, §4) requires before any repair becomes the new production artifact — is explicitly not built here. A caller (CLI or a future orchestrator) that wants durable healing must take `result.healedRecording` and run it through the existing publish/approval pipeline (`@jevitate/sources`'s `publishJourney` + human review) itself.

## Self-review

- **Guardrails preserved:** fail-closed default unchanged (Task 5) ✅; writes never auto-heal in hybrid OR full (Task 3, Task 5 #8a/#8b) ✅; a repair that doesn't actually fix it still quarantines (Task 3's `resumeFrom` re-check via the normal loop, Task 3 test 5) ✅; healed runs distinguishable from clean runs (`"healed"` outcome, never collapsed into `"ok"`) ✅.
- **Placeholder scan:** no TODO/TBD; the CLI adapter (Task 6) is explicitly marked blocked-on-#1 rather than stubbed with a fake pretending to be real.
- **Type consistency:** `SelfHealer`/`isWriteStep`/`postconditionOf`/`healRecording`/`flattenRecording` defined once in Task 1/2/3 and reused verbatim in Tasks 4–7; `JourneyRunResult`'s `"healed"` variant field names (`output`, `healedRecording`, `healedAt`) match across Task 3's implementation and its own tests.
