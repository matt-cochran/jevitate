# Journey Authoring by Jev-Driving (Ticket #6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Proposed (plan — for review before execution)
**Date:** 2026-09-20
**Ticket:** [#6](https://github.com/matt-cochran/jevitate/issues/6) — "Journeys can be authored by Jev-driving as well as by demonstration"

**Goal:** Let the exploration engine's goal-based mission (`@jevitate/explore`, ticket #1, planned) author a promotable `Journey` — the Jev-directed / goal-based end of the `DirectionPolicy` spectrum — by feeding its output through RxD's **existing** diff/postdoc pipeline (`@jevitate/recording`'s `diffTakes`/`applyPostdoc`/`promoteToVariable`), producing a deterministic, replayable, parameterized `Recording` wrapped as a `Journey`. Human-driving (record-by-demonstration) is untouched.

**Architecture:** Jev drives **once** to discover a working path to the goal (the discovery take). For variable inference, the SAME discovered path is then replayed `takes − 1` more times — deterministically, via the interpreter for the fixed structure, with only the *generated fill values* re-rolled each time — producing N structurally-aligned `AuthoringRecording`s (this is what makes "nondeterministic discovery" yield a diffable multi-take set, mirroring RxD's own "record the same journey 2–3 times with different values"). Those takes go through the exact same machinery RxD's human-driving path already uses: `diffTakes` → classify columns → decisions → `applyPostdoc` (which calls `promoteToVariable` for confident variables and materializes everything else). A new `autoDecidePostdoc` supplies the decisions non-interactively (no human in the loop for the automated pipeline): confident-variable → promote; corroborated-constant (or the trivial single-take case) → materialize as a literal, replayable constant; anything ambiguous/noisy → convert to a `handback` step rather than risk guessing a possibly-sensitive value. The resulting `Recording` is wrapped as a `Journey` with `metadata.authoredBy: "jev-driven"` and `metadata.promoted: false` — promotion stays a deliberate, separate human-approval step (`JourneyRegistry.promote`), exactly as it already is for human-driven Journeys.

**Assumptions / dependencies on #1 (`@jevitate/explore`, planned):**
1. This plan builds on ticket #1's plan (`docs/superpowers/plans/2026-09-20-testing-missions-exploration-engine.md`) Task 10's planned export, here named `runGoalBasedMission({ goal, successAssertion, allowlist, bounds, actor, judgment, generation }): Promise<{ outcome: "succeeded" | "blocked" | "exhausted"; recording: Recording; transcript: unknown }>`. **Blocked until #1 lands** — every task below that imports from `@jevitate/explore` is written against this planned signature and must be re-verified against the real export once #1 ships.
2. **New requirement on #1's API, not yet in its plan:** deterministic multi-take corroboration (Task 5 below) needs the mission to *replay a previously-discovered path* rather than re-explore from scratch, so N takes stay structurally aligned. This plan therefore assumes a `seedRecording?: Recording` field is added to the goal-based mission's request (drive the SAME steps, re-rolling only generated fill values). **This is flagged as a required, small addition to ticket #1's plan** (the umbrella spec's own §3 "Seeding: a human recording can seed LM exploration" already anticipates this shape). If that addition is not available when this plan executes, Task 5 is skipped and the pipeline falls back to `takes: 1` (Task 4's single-take path, fully self-contained) — this fallback is itself a complete, correct MVP (see Task 4).
3. `@jevitate/explore`'s `fill.ts` (ticket #1, Task 6) is assumed to call `GenerationPort.generate()` exactly once per `fill`/`select` step it executes, in the same left-to-right order those steps end up in the emitted `Recording` — this is what lets `ValueCapturingGenerationPort` (Task 2) correlate captured plaintext values back to specific steps by position.

**Tech Stack:** TypeScript strict ESM, Vitest, pnpm workspaces. Depends on `@jevitate/recording` (`diffTakes`/`applyPostdoc`/`promoteToVariable`/`flattenBaseFillSteps`/`CONFIDENT_VARIABLE_THRESHOLD`/`AuthoringRecording`/`DiffResult`/`ColumnClass`/`PostdocDecision`), `@jevitate/journey` (`Journey`/`JourneyMetadata`/`deriveParamSchema`/`FsJourneyStore`/`JourneyRegistry`), `@jevitate/ai-core` (`GenerationPort`/`JudgmentPort` types), `@jevitate/screenplay` (`Actor`), and — once available — `@jevitate/explore` (`runGoalBasedMission`, type-only until #1 ships).

**Spec:** `docs/superpowers/specs/2026-09-19-autonomous-exploration-testing-design.md` §3.2 ("Goal-based exploratory testing... Exploration *authors* RxD recordings") and §2a; `docs/superpowers/specs/2026-09-17-record-by-demonstration-design.md` §6/§6a/§7 (diff/classify/postdoc, reused verbatim); positioned by `docs/superpowers/specs/2026-09-19-unified-journey-automation-and-testing-design.md` §3 ("Seeding: a human recording can seed LM exploration") and §2 (the `Journey` abstraction both authoring modes converge on).

## Global Constraints

- Node 20+, ESM, `strict: true`, project references (`tsc --build`).
- Dependency direction inward only: this work adds files to `@jevitate/explore` (depends on `@jevitate/journey`/`@jevitate/recording`/`@jevitate/ai-core`/`@jevitate/screenplay` — all already upstream of it per ticket #1's plan) plus one modification to `@jevitate/journey` and one additive CLI touch. Nothing new depends on `@jevitate/explore`.
- **Repo gotcha:** packages have NO `"test"` script — run `pnpm exec vitest run <path>`, never `pnpm --filter <pkg> test`.
- Git staging is explicit-path only (`git add <exact files>`), never `-A`/`.`.
- Commit trailer for every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- CI runs on fake gateways only (`FakeJudgmentGateway`/`FakeGenerationGateway`); no live Jev/OpenRouter calls in these tests.
- Gitflow: branch off `dev` as `feature/jev-driving-authoring`, PR back to `dev`.

## Guardrails (binding — each ships an "asserts-it-refuses" or regression test)

1. **Never auto-promoted.** A journey authored this way always has `metadata.promoted === false` — promotion remains a separate, deliberate `JourneyRegistry.promote()` call.
2. **Independent oracle preserved.** Every take (discovery and corroborating) is adjudicated by the SAME user-supplied `successAssertion`, never by Jev's own "done" judgment — this plan does not weaken ticket #1's independent-oracle guardrail.
3. **No guessed secrets/PII.** Ambiguous or noisy columns are converted to `handback`, never silently materialized as a constant (`SecretMaterializationError`'s guard in `applyPostdoc` is never bypassed with `acknowledgeVaried: true` by the auto-decide policy).
4. **Human-driving unchanged.** No file under RxD's existing human-driving surfaces (`packages/recorder`, `packages/cli`'s existing postdoc prompt flow) is modified except the one additive CLI subcommand for this new authoring mode.

## File Structure

```
packages/journey/src/journey.ts                              # MODIFY: + authoredBy field
packages/journey/src/journey.test.ts                          # MODIFY/CREATE: schema round-trip

packages/explore/                                             # assumes ticket #1 has scaffolded this package
  package.json                                                # MODIFY: + "@jevitate/journey": "workspace:*"
  tsconfig.json                                                # MODIFY: + { "path": "../journey" }
  src/
    authoring/
      value-capturing-generation-port.ts                       # NEW
      value-capturing-generation-port.test.ts
      auto-decide.ts                                           # NEW
      auto-decide.test.ts
      author-journey.ts                                        # NEW
      author-journey.test.ts
      author-journey-invariants.test.ts                        # NEW

packages/cli/src/
  explore-api.ts                                               # MODIFY (ticket #1's Task 12 file): + author-journey wiring
  explore-api.test.ts                                          # MODIFY
  program.ts                                                   # MODIFY: + `explore author-journey` subcommand
```

---

## Task 1: `JourneyMetadata.authoredBy`

**Files:**
- Modify: `packages/journey/src/journey.ts`
- Test: `packages/journey/src/journey.test.ts`

**Interfaces:**
- Produces: `JourneyMetadata.authoredBy?: "human-demonstration" | "jev-driven"` (optional — absent means legacy/unspecified, so every existing `Journey` fixture in the repo stays valid unmodified).

- [ ] **Step 1: Write the failing test**

`packages/journey/src/journey.test.ts`:
```ts
import { expect, test } from "vitest";
import { JourneySchema } from "./journey.js";

const baseRecording = { version: "1.0", site: "https://example.test", pages: [] };

test("JourneySchema accepts metadata with no authoredBy (legacy/human default)", () => {
  const result = JourneySchema.safeParse({
    metadata: { id: "login", name: "Log in", promoted: true, params: [], createdAtIso: "2026-09-19T00:00:00Z" },
    recording: baseRecording,
  });
  expect(result.success).toBe(true);
});

test("JourneySchema accepts authoredBy: 'jev-driven'", () => {
  const result = JourneySchema.safeParse({
    metadata: {
      id: "explore-login", name: "Explore-driven login", promoted: false, params: [],
      authoredBy: "jev-driven", createdAtIso: "2026-09-20T00:00:00Z",
    },
    recording: baseRecording,
  });
  expect(result.success).toBe(true);
});

test("JourneySchema rejects an unknown authoredBy value", () => {
  const result = JourneySchema.safeParse({
    metadata: { id: "x", name: "x", promoted: false, params: [], authoredBy: "made-up", createdAtIso: "2026-09-20T00:00:00Z" },
    recording: baseRecording,
  });
  expect(result.success).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/journey/src/journey.test.ts`
Expected: FAIL — `authoredBy: "jev-driven"` is rejected by the current `.strict()` schema (unknown key), and the "rejects unknown value" test fails because there's no `authoredBy` field to validate against at all yet (both assertions land on the wrong branch).

- [ ] **Step 3: Implement the field**

In `packages/journey/src/journey.ts`, modify:
```ts
export interface JourneyMetadata {
  id: string;
  name: string;
  description?: string;
  promoted: boolean;
  params: string[];
  secretRefs?: SecretRef[];
  authoredBy?: "human-demonstration" | "jev-driven";
  createdAtIso: string;
}
```
and in `JourneySchema`'s `metadata` object:
```ts
  metadata: z.object({
    id: z.string().regex(SAFE_ID_RE, "invalid id"),
    name: z.string(),
    description: z.string().optional(),
    promoted: z.boolean(),
    params: z.array(z.string()),
    secretRefs: z.array(SecretRefSchema).optional(),
    authoredBy: z.enum(["human-demonstration", "jev-driven"]).optional(),
    createdAtIso: z.string(),
  }).strict(),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/journey/src/journey.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full journey package suite to confirm no regression**

Run: `pnpm exec vitest run packages/journey`
Expected: PASS — every existing `Journey` fixture omits `authoredBy` and remains valid (optional field).

- [ ] **Step 6: Commit**

```bash
git add packages/journey/src/journey.ts packages/journey/src/journey.test.ts
git commit -m "$(cat <<'EOF'
feat(journey): add optional authoredBy metadata (human-demonstration | jev-driven)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Value-capturing generation port

**Files:**
- Create: `packages/explore/src/authoring/value-capturing-generation-port.ts`
- Test: `packages/explore/src/authoring/value-capturing-generation-port.test.ts`

**Interfaces:**
- Consumes: `GenerationPort`/`GenInput`/`GenOutput`/`GenTaskKind`/`GenerationResult` from `@jevitate/ai-core`; `flattenBaseFillSteps` from `@jevitate/recording`.
- Produces: `class ValueCapturingGenerationPort implements GenerationPort { capturedValues(recording: Recording): Map<string, string> }`.

- [ ] **Step 1: Write the failing test**

`packages/explore/src/authoring/value-capturing-generation-port.test.ts`:
```ts
import { expect, test } from "vitest";
import type { GenerationPort, GenTaskKind, GenInput, GenerationResult } from "@jevitate/ai-core";
import type { Recording } from "@jevitate/recording";
import { ValueCapturingGenerationPort } from "./value-capturing-generation-port.js";

function fakeInner(values: string[]): GenerationPort {
  let i = 0;
  return {
    async generate<K extends GenTaskKind>(_kind: K, _input: GenInput<K>): Promise<GenerationResult<K>> {
      return { output: { text: values[i++] }, provenance: { model: "fake", tookMs: 0 } } as GenerationResult<K>;
    },
  };
}

const recording: Recording = {
  version: "1.0",
  site: "https://example.test",
  pages: [
    {
      url: "/search",
      steps: [
        { step: { kind: "navigate", url: "/search", expect: { kind: "visible", target: { testId: "box" } } } },
        { step: { kind: "fill", target: { testId: "q" }, value: { redacted: true, length: 5 }, expect: { kind: "visible", target: { testId: "results" } } } },
        { step: { kind: "select", target: { testId: "sort" }, value: { redacted: true, length: 4 }, expect: { kind: "visible", target: { testId: "results" } } } },
      ],
    },
  ],
};

test("captures each generate() call's text and correlates it to the recording's fill/select steps in order", async () => {
  const port = new ValueCapturingGenerationPort(fakeInner(["widgets", "newest"]));
  await port.generate("form-value" as any, {} as any);
  await port.generate("form-value" as any, {} as any);

  const values = port.capturedValues(recording);
  expect(values.get("0:1")).toBe("widgets");
  expect(values.get("0:2")).toBe("newest");
});

test("throws when the number of captured values doesn't match the recording's fill/select step count", async () => {
  const port = new ValueCapturingGenerationPort(fakeInner(["only-one"]));
  await port.generate("form-value" as any, {} as any);
  expect(() => port.capturedValues(recording)).toThrow(/cannot correlate/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/explore/src/authoring/value-capturing-generation-port.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/explore/src/authoring/value-capturing-generation-port.ts`:
```ts
import type { GenerationPort, GenTaskKind, GenInput, GenerationResult } from "@jevitate/ai-core";
import type { Recording } from "@jevitate/recording";
import { flattenBaseFillSteps } from "@jevitate/recording";

/**
 * Decorates a `GenerationPort`, recording each `generate()` call's textual
 * result in call order. Assumption (see plan header): `@jevitate/explore`'s
 * `fill.ts` calls `generate()` exactly once per `fill`/`select` step it
 * executes, in the same left-to-right order those steps end up in the
 * emitted `Recording` — so the Nth captured value corresponds to the Nth
 * fill/select step of `flattenBaseFillSteps(recording)`.
 */
export class ValueCapturingGenerationPort implements GenerationPort {
  private readonly captured: string[] = [];

  constructor(private readonly inner: GenerationPort) {}

  async generate<K extends GenTaskKind>(kind: K, input: GenInput<K>): Promise<GenerationResult<K>> {
    const result = await this.inner.generate(kind, input);
    const text = extractText(result.output);
    if (text !== undefined) this.captured.push(text);
    return result;
  }

  capturedValues(recording: Recording): Map<string, string> {
    const fillSteps = flattenBaseFillSteps(recording);
    if (fillSteps.length !== this.captured.length) {
      throw new Error(
        `ValueCapturingGenerationPort: recorded ${this.captured.length} generate() call(s) but the recording has ${fillSteps.length} fill/select step(s) — cannot correlate values 1:1`,
      );
    }
    const values = new Map<string, string>();
    fillSteps.forEach(({ ref }, i) => values.set(`${ref.page}:${ref.step}`, this.captured[i]));
    return values;
  }
}

function extractText(output: unknown): string | undefined {
  if (output && typeof output === "object" && "text" in output) {
    const text = (output as { text: unknown }).text;
    if (typeof text === "string") return text;
  }
  return undefined;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/explore/src/authoring/value-capturing-generation-port.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/explore/src/authoring/value-capturing-generation-port.ts packages/explore/src/authoring/value-capturing-generation-port.test.ts
git commit -m "$(cat <<'EOF'
feat(explore): value-capturing GenerationPort decorator for authoring

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Auto-decide — non-interactive postdoc decisions from a `DiffResult`

**Files:**
- Create: `packages/explore/src/authoring/auto-decide.ts`
- Test: `packages/explore/src/authoring/auto-decide.test.ts`

**Interfaces:**
- Consumes: `flattenBaseFillSteps`, `CONFIDENT_VARIABLE_THRESHOLD`, `DiffResult`, `ColumnClass`, `PostdocDecision`, `Recording` from `@jevitate/recording`.
- Produces: `autoDecidePostdoc(base: Recording, diff: DiffResult): PostdocDecision[]`.

- [ ] **Step 1: Write the failing tests**

`packages/explore/src/authoring/auto-decide.test.ts`:
```ts
import { expect, test } from "vitest";
import type { Recording, DiffResult } from "@jevitate/recording";
import { autoDecidePostdoc } from "./auto-decide.js";

function baseWithOneFill(): Recording {
  return {
    version: "1.0",
    site: "https://example.test",
    pages: [{ url: "/search", steps: [{ step: { kind: "fill", target: { testId: "q" }, value: { redacted: true, length: 5 }, expect: { kind: "visible", target: { testId: "results" } } } }] }],
  };
}

test("a confident-variable column becomes a 'variable' decision", () => {
  const diff: DiffResult = { columns: [{ kind: "variable", confidence: 0.9, values: ["widgets", "gadgets"], inferredType: "string" }] };
  const decisions = autoDecidePostdoc(baseWithOneFill(), diff);
  expect(decisions).toEqual([{ step: { page: 0, step: 0 }, classify: "variable", name: expect.any(String) }]);
});

test("a constant column becomes a 'constant' decision", () => {
  const diff: DiffResult = { columns: [{ kind: "constant", confidence: 1, values: ["widgets"] }] };
  const decisions = autoDecidePostdoc(baseWithOneFill(), diff);
  expect(decisions).toEqual([{ step: { page: 0, step: 0 }, classify: "constant" }]);
});

test("an ambiguous/noisy column becomes a 'handback' decision, never a guessed constant", () => {
  const diff: DiffResult = { columns: [{ kind: "noise", confidence: 0.2, values: ["a8f0-91-uuid-looking"] }] };
  const decisions = autoDecidePostdoc(baseWithOneFill(), diff);
  expect(decisions[0].classify).toBe("handback");
});

test("a low-confidence variable (below CONFIDENT_VARIABLE_THRESHOLD) is NOT auto-promoted", () => {
  const diff: DiffResult = { columns: [{ kind: "variable", confidence: 0.3, values: ["a", "b"] }] };
  const decisions = autoDecidePostdoc(baseWithOneFill(), diff);
  expect(decisions[0].classify).toBe("handback");
});

test("throws when the base/diff shapes don't correlate", () => {
  const diff: DiffResult = { columns: [] };
  expect(() => autoDecidePostdoc(baseWithOneFill(), diff)).toThrow(/must be take 0/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/explore/src/authoring/auto-decide.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/explore/src/authoring/auto-decide.ts`:
```ts
import type { Recording, DiffResult, ColumnClass, PostdocDecision } from "@jevitate/recording";
import { flattenBaseFillSteps, CONFIDENT_VARIABLE_THRESHOLD } from "@jevitate/recording";

/**
 * Produces `PostdocDecision[]` for `applyPostdoc` WITHOUT a human in the
 * loop, for the fully-automated Jev-driving authoring pipeline:
 *
 * - confident variable (kind "variable", confidence >= CONFIDENT_VARIABLE_THRESHOLD)
 *   -> promote to a named `{var}` slot.
 * - "constant" -> materialize take 0's local captured value as a literal
 *   (always replayable — this is what a single take, or a corroborated
 *   constant, safely resolves to).
 * - anything else ("noise", "ambiguous", or a variable BELOW the confidence
 *   threshold) -> `handback`: never guess at a possibly-sensitive varying
 *   value. This is the conservative default the design calls for ("default
 *   constant unless corroborated... ambiguous surfaced to the human/LLM") —
 *   here "surfaced" means a replay-time handback rather than blocking
 *   authoring on a synchronous human decision.
 *
 * `base` must be take 0 of the SAME `diffTakes(takes)` call that produced
 * `diff` (same precondition as `@jevitate/recording`'s `applyDiff`).
 */
export function autoDecidePostdoc(base: Recording, diff: DiffResult): PostdocDecision[] {
  const baseFillSteps = flattenBaseFillSteps(base);
  const valueBearingColumns = diff.columns
    .map((columnClass, originalIndex) => ({ columnClass, originalIndex }))
    .filter(({ columnClass }) => columnClass.values[0] !== null);

  if (baseFillSteps.length !== valueBearingColumns.length) {
    throw new Error(
      `autoDecidePostdoc: base has ${baseFillSteps.length} fill/select step(s) but diff has ` +
        `${valueBearingColumns.length} value-bearing column(s) — base must be take 0 of the ` +
        `diffTakes(...) call that produced this diff`,
    );
  }

  const usedNames = new Set<string>();
  return baseFillSteps.map(({ ref }, k) => {
    const { columnClass, originalIndex } = valueBearingColumns[k];

    if (columnClass.kind === "variable" && columnClass.confidence >= CONFIDENT_VARIABLE_THRESHOLD) {
      const name = pickAutoName(columnClass, originalIndex, usedNames);
      usedNames.add(name);
      return { step: ref, classify: "variable", name };
    }
    if (columnClass.kind === "constant") {
      return { step: ref, classify: "constant" };
    }
    return {
      step: ref,
      classify: "handback",
      prompt: `Jev-driven authoring could not confidently classify this field's value (${columnClass.kind}, confidence ${columnClass.confidence.toFixed(2)}) — please provide it at replay time.`,
    };
  });
}

function pickAutoName(columnClass: ColumnClass, originalIndex: number, used: Set<string>): string {
  const base = columnClass.inferredType ?? "value";
  let n = originalIndex;
  let name = `${base}${n}`;
  while (used.has(name)) {
    n++;
    name = `${base}${n}`;
  }
  return name;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/explore/src/authoring/auto-decide.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/explore/src/authoring/auto-decide.ts packages/explore/src/authoring/auto-decide.test.ts
git commit -m "$(cat <<'EOF'
feat(explore): non-interactive postdoc auto-decide (variable/constant/handback)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `authorJourney` — single-take path (MVP, no `@jevitate/explore` API addition required)

**Files:**
- Create: `packages/explore/src/authoring/author-journey.ts`
- Test: `packages/explore/src/authoring/author-journey.test.ts`
- Modify: `packages/explore/package.json` (+ `"@jevitate/journey": "workspace:*"`), `packages/explore/tsconfig.json` (+ `{ "path": "../journey" }`)

**Interfaces:**
- Consumes: `runGoalBasedMission` (ticket #1's planned Task 10 export — **assumption**, see plan header), `diffTakes`, `applyPostdoc` from `@jevitate/recording`, `autoDecidePostdoc` (Task 3), `ValueCapturingGenerationPort` (Task 2), `deriveParamSchema` from `@jevitate/journey`.
- Produces: `AuthorJourneyRequest { goal: string; successAssertion: Assertion; allowlist: readonly string[]; bounds?: Bounds; actor: Actor; judgment: JudgmentPort; generation: GenerationPort; takes?: number; journeyId: string; journeyName: string }`, `AuthorJourneyResult = { outcome: "authored"; journey: Journey } | { outcome: "not-reached"; reason: string }`, `authorJourney(req: AuthorJourneyRequest): Promise<AuthorJourneyResult>`.

- [ ] **Step 1: Write the failing test (single take: `takes: 1`)**

`packages/explore/src/authoring/author-journey.test.ts`:
```ts
import { expect, test, vi } from "vitest";
import type { Recording } from "@jevitate/recording";
import type { JudgmentPort, GenerationPort } from "@jevitate/ai-core";
import { authorJourney } from "./author-journey.js";

vi.mock("../missions/goal-based.js", () => ({
  runGoalBasedMission: vi.fn(async () => ({
    outcome: "succeeded",
    recording: discoveredRecording,
    transcript: [],
  })),
}));

const discoveredRecording: Recording = {
  version: "1.0",
  site: "https://example.test",
  pages: [
    {
      url: "/search",
      steps: [
        { step: { kind: "navigate", url: "/search", expect: { kind: "visible", target: { testId: "box" } } } },
        { step: { kind: "fill", target: { testId: "q" }, value: { redacted: true, length: 7 }, expect: { kind: "visible", target: { testId: "results" } } } },
      ],
    },
  ],
};

const fakeJudgment: JudgmentPort = { systemOne: vi.fn(async () => ({})) };
const fakeGeneration: GenerationPort = {
  generate: vi.fn(async () => ({ output: { text: "widgets" }, provenance: { model: "fake", tookMs: 0 } })) as any,
};

test("single-take authoring (takes: 1) produces a fully-materialized, replayable Journey", async () => {
  const result = await authorJourney({
    goal: "search for widgets",
    successAssertion: { kind: "visible", target: { testId: "results" } },
    allowlist: ["https://example.test"],
    actor: {} as any,
    judgment: fakeJudgment,
    generation: fakeGeneration,
    takes: 1,
    journeyId: "explore-search",
    journeyName: "Explore: search",
  });

  expect(result.outcome).toBe("authored");
  if (result.outcome !== "authored") throw new Error("unreachable");
  expect(result.journey.metadata.authoredBy).toBe("jev-driven");
  expect(result.journey.metadata.promoted).toBe(false);
  const fillStep = result.journey.recording.pages[0].steps[1].step;
  expect(fillStep.kind).toBe("fill");
  if (fillStep.kind === "fill") {
    // single take, no corroboration -> materialized constant, not redacted.
    expect(fillStep.value).toEqual({ redacted: false, value: "widgets" });
  }
});

test("returns not-reached when the discovery mission does not succeed", async () => {
  const { runGoalBasedMission } = await import("../missions/goal-based.js");
  (runGoalBasedMission as any).mockResolvedValueOnce({ outcome: "blocked", recording: discoveredRecording, transcript: [] });

  const result = await authorJourney({
    goal: "search for widgets",
    successAssertion: { kind: "visible", target: { testId: "results" } },
    allowlist: ["https://example.test"],
    actor: {} as any,
    judgment: fakeJudgment,
    generation: fakeGeneration,
    takes: 1,
    journeyId: "explore-search",
    journeyName: "Explore: search",
  });

  expect(result).toEqual({ outcome: "not-reached", reason: "discovery mission blocked" });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/explore/src/authoring/author-journey.test.ts`
Expected: FAIL — `./author-journey.js` and `../missions/goal-based.js` not found.

- [ ] **Step 3: Implement (single-take path only for this task; multi-take added in Task 5)**

Add `"@jevitate/journey": "workspace:*"` to `packages/explore/package.json`'s `dependencies` and `{ "path": "../journey" }` to `packages/explore/tsconfig.json`'s `references`.

`packages/explore/src/authoring/author-journey.ts`:
```ts
import type { Actor } from "@jevitate/screenplay";
import type { Assertion, AuthoringRecording } from "@jevitate/recording";
import { diffTakes, applyPostdoc } from "@jevitate/recording";
import type { GenerationPort, JudgmentPort } from "@jevitate/ai-core";
import { deriveParamSchema } from "@jevitate/journey";
import type { Journey, JourneyMetadata } from "@jevitate/journey";
import { runGoalBasedMission } from "../missions/goal-based.js"; // ticket #1 planned export — see plan Assumptions
import type { Bounds } from "../bounds.js";
import { ValueCapturingGenerationPort } from "./value-capturing-generation-port.js";
import { autoDecidePostdoc } from "./auto-decide.js";

export interface AuthorJourneyRequest {
  goal: string;
  successAssertion: Assertion;
  allowlist: readonly string[];
  bounds?: Bounds;
  actor: Actor;
  judgment: JudgmentPort;
  generation: GenerationPort;
  /** Total takes, including the discovery take. Default 1 (single-take,
   * fully-constant authoring — no `@jevitate/explore` API addition needed).
   * Values > 1 require the mission's planned `seedRecording` addition —
   * see Task 5. */
  takes?: number;
  journeyId: string;
  journeyName: string;
}

export type AuthorJourneyResult =
  | { outcome: "authored"; journey: Journey }
  | { outcome: "not-reached"; reason: string };

/**
 * Authors a Journey by Jev-driving. Runs the goal-based exploration mission
 * to discover a path (adjudicated by the caller-supplied `successAssertion`
 * — Jev's own "done" judgment is never trusted, matching ticket #1's
 * independent-oracle guardrail), then feeds the resulting take(s) through
 * RxD's existing diff/postdoc pipeline to produce a fully-materialized,
 * replayable, parameterized `Recording`. Never auto-promotes: the returned
 * Journey's `metadata.promoted` is always `false`.
 */
export async function authorJourney(req: AuthorJourneyRequest): Promise<AuthorJourneyResult> {
  const takes = req.takes ?? 1;
  if (takes < 1) throw new Error("authorJourney: takes must be >= 1");

  const discoveryGeneration = new ValueCapturingGenerationPort(req.generation);
  const discovery = await runGoalBasedMission({
    goal: req.goal,
    successAssertion: req.successAssertion,
    allowlist: req.allowlist,
    bounds: req.bounds,
    actor: req.actor,
    judgment: req.judgment,
    generation: discoveryGeneration,
  });
  if (discovery.outcome !== "succeeded") {
    return { outcome: "not-reached", reason: `discovery mission ${discovery.outcome}` };
  }

  const authoringTakes: AuthoringRecording[] = [
    { recording: discovery.recording, values: discoveryGeneration.capturedValues(discovery.recording) },
  ];

  const diff = diffTakes(authoringTakes);
  const decisions = autoDecidePostdoc(authoringTakes[0].recording, diff);
  const parameterizedRecording = applyPostdoc(authoringTakes[0], diff, decisions);

  const metadata: JourneyMetadata = {
    id: req.journeyId,
    name: req.journeyName,
    promoted: false,
    params: deriveParamSchema(parameterizedRecording).required,
    authoredBy: "jev-driven",
    createdAtIso: new Date().toISOString(),
  };

  return { outcome: "authored", journey: { metadata, recording: parameterizedRecording } };
}
```

Note: `../missions/goal-based.js` does not exist until ticket #1 ships. Until then, this task's test uses `vi.mock` to stand in for it (as shown above) — this lets Task 4 be implemented and merged independently of #1's completion, with the real integration verified once #1's `missions/goal-based.ts` lands (add a follow-up smoke test at that point importing the real module instead of the mock).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/explore/src/authoring/author-journey.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/explore/src/authoring/author-journey.ts packages/explore/src/authoring/author-journey.test.ts packages/explore/package.json packages/explore/tsconfig.json
git commit -m "$(cat <<'EOF'
feat(explore): authorJourney single-take path (Jev-driving -> parameterized Journey)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Multi-take corroboration (requires #1's `seedRecording` addition)

**Files:**
- Modify: `packages/explore/src/authoring/author-journey.ts`
- Modify: `packages/explore/src/authoring/author-journey.test.ts`

**Interfaces:**
- Consumes: the assumed extended mission request shape `{ ..., seedRecording?: Recording }` (see plan header, Assumption 2).

- [ ] **Step 1: Write the failing test (multi-take: `takes: 2`, values differ -> promoted to variable)**

Add to `author-journey.test.ts`:
```ts
test("multi-take authoring (takes: 2) promotes a value that differs across takes to a variable", async () => {
  const { runGoalBasedMission } = await import("../missions/goal-based.js");
  (runGoalBasedMission as any)
    .mockResolvedValueOnce({ outcome: "succeeded", recording: discoveredRecording, transcript: [] }) // discovery
    .mockResolvedValueOnce({ outcome: "succeeded", recording: discoveredRecording, transcript: [] }); // corroborating replay

  const generation: GenerationPort = {
    generate: vi
      .fn()
      .mockResolvedValueOnce({ output: { text: "widgets" }, provenance: { model: "fake", tookMs: 0 } })
      .mockResolvedValueOnce({ output: { text: "gadgets" }, provenance: { model: "fake", tookMs: 0 } }),
  } as any;

  const result = await authorJourney({
    goal: "search for something",
    successAssertion: { kind: "visible", target: { testId: "results" } },
    allowlist: ["https://example.test"],
    actor: {} as any,
    judgment: fakeJudgment,
    generation,
    takes: 2,
    journeyId: "explore-search",
    journeyName: "Explore: search",
  });

  expect(result.outcome).toBe("authored");
  if (result.outcome !== "authored") throw new Error("unreachable");
  expect(result.journey.metadata.params.length).toBe(1); // the fill step was promoted to a variable
  const fillStep = result.journey.recording.pages[0].steps[1].step;
  if (fillStep.kind === "fill") expect(fillStep.value).toEqual({ var: expect.any(String) });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/explore/src/authoring/author-journey.test.ts`
Expected: FAIL — with `takes: 2` the current implementation still only runs the discovery take (only 1 `AuthoringRecording` produced), so `runGoalBasedMission`'s second scripted resolution is never consumed and the fill step is materialized as a constant, not promoted.

- [ ] **Step 3: Implement the corroborating-takes loop**

Modify `authorJourney` in `author-journey.ts` — insert after the discovery block and before `const diff = ...`:
```ts
  for (let i = 1; i < takes; i++) {
    const replayGeneration = new ValueCapturingGenerationPort(req.generation);
    const replay = await runGoalBasedMission({
      goal: req.goal,
      successAssertion: req.successAssertion,
      allowlist: req.allowlist,
      bounds: req.bounds,
      actor: req.actor,
      judgment: req.judgment,
      generation: replayGeneration,
      seedRecording: discovery.recording, // ticket #1 planned addition — see plan Assumptions
    } as Parameters<typeof runGoalBasedMission>[0]);
    if (replay.outcome !== "succeeded") continue; // a failed corroborating take is dropped, not fatal
    authoringTakes.push({ recording: replay.recording, values: replayGeneration.capturedValues(replay.recording) });
  }
```
(this replaces the direct `const diff = diffTakes(authoringTakes);` line with the same line, now reached after the loop above has potentially appended more takes).

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/explore/src/authoring/author-journey.test.ts`
Expected: PASS (3 tests total in this file).

- [ ] **Step 5: Commit**

```bash
git add packages/explore/src/authoring/author-journey.ts packages/explore/src/authoring/author-journey.test.ts
git commit -m "$(cat <<'EOF'
feat(explore): multi-take corroboration for Jev-driven variable inference

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Invariant contract

**Files:**
- Create: `packages/explore/src/authoring/author-journey-invariants.test.ts`

**Interfaces:**
- Consumes: `authorJourney` (Tasks 4/5).

- [ ] **Step 1: Write the invariant tests**

`packages/explore/src/authoring/author-journey-invariants.test.ts`:
```ts
import { expect, test, vi } from "vitest";
import type { Recording } from "@jevitate/recording";
import type { JudgmentPort, GenerationPort } from "@jevitate/ai-core";
import { authorJourney } from "./author-journey.js";

vi.mock("../missions/goal-based.js", () => ({
  runGoalBasedMission: vi.fn(async () => ({ outcome: "succeeded", recording, transcript: [] })),
}));

const recording: Recording = {
  version: "1.0",
  site: "https://example.test",
  pages: [{ url: "/x", steps: [{ step: { kind: "navigate", url: "/x", expect: { kind: "visible", target: { testId: "ok" } } } }] }],
};

const judgment: JudgmentPort = { systemOne: vi.fn(async () => ({})) };
const generation: GenerationPort = { generate: vi.fn(async () => ({ output: { text: "" }, provenance: { model: "fake", tookMs: 0 } })) } as any;

test("#1 never auto-promoted: metadata.promoted is always false", async () => {
  const result = await authorJourney({
    goal: "g", successAssertion: { kind: "visible", target: { testId: "ok" } }, allowlist: [],
    actor: {} as any, judgment, generation, takes: 1, journeyId: "j", journeyName: "J",
  });
  expect(result.outcome).toBe("authored");
  if (result.outcome === "authored") expect(result.journey.metadata.promoted).toBe(false);
});

test("#2 independent oracle preserved: a discovery mission outcome other than 'succeeded' never authors a journey", async () => {
  const { runGoalBasedMission } = await import("../missions/goal-based.js");
  (runGoalBasedMission as any).mockResolvedValueOnce({ outcome: "exhausted", recording, transcript: [] });
  const result = await authorJourney({
    goal: "g", successAssertion: { kind: "visible", target: { testId: "ok" } }, allowlist: [],
    actor: {} as any, judgment, generation, takes: 1, journeyId: "j", journeyName: "J",
  });
  expect(result.outcome).toBe("not-reached");
});

test("#4 rejects an invalid takes count rather than silently defaulting", async () => {
  await expect(
    authorJourney({
      goal: "g", successAssertion: { kind: "visible", target: { testId: "ok" } }, allowlist: [],
      actor: {} as any, judgment, generation, takes: 0, journeyId: "j", journeyName: "J",
    }),
  ).rejects.toThrow(/takes must be/);
});
```

- [ ] **Step 2: Run to verify all pass**

Run: `pnpm exec vitest run packages/explore/src/authoring/author-journey-invariants.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 3: Commit**

```bash
git add packages/explore/src/authoring/author-journey-invariants.test.ts
git commit -m "$(cat <<'EOF'
test(explore): Jev-driven authoring invariant contract (never-promoted, independent-oracle)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Additive CLI command

**Files:**
- Modify: `packages/cli/src/explore-api.ts` (ticket #1's Task 12 file — assumed to exist)
- Modify: `packages/cli/src/explore-api.test.ts`
- Modify: `packages/cli/src/program.ts`

**Interfaces:**
- Consumes: `authorJourney` from `@jevitate/explore`; `FsJourneyStore` from `@jevitate/journey`.

- [ ] **Step 1: Write the failing test**

Add to `packages/cli/src/explore-api.test.ts` (no browser — fakes only):
```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAuthorJourney } from "./explore-api.js";

test("runAuthorJourney writes the authored Journey to the journeys store", async () => {
  const journeysDir = await mkdtemp(join(tmpdir(), "explore-author-"));
  const result = await runAuthorJourney({
    goal: "reach the confirmation page",
    successAssertionSpec: '{"kind":"visible","target":{"testId":"confirmed"}}',
    allowlist: ["https://fixture.test"],
    journeysDir,
    journeyId: "explore-checkout",
    journeyName: "Explore: checkout",
    takes: 1,
    /* fakeMission/fakeGateways injected exactly as explore-api.test.ts's
       existing no-browser tests already do for the goal-based mission —
       reuse that same fixture wiring here. */
  });
  expect(result.outcome).toBe("authored");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/cli/src/explore-api.test.ts`
Expected: FAIL — `runAuthorJourney` not exported yet.

- [ ] **Step 3: Implement**

In `packages/cli/src/explore-api.ts`, add (alongside the existing goal-based-mission wiring from ticket #1's Task 12):
```ts
import { authorJourney } from "@jevitate/explore";
import { FsJourneyStore } from "@jevitate/journey";
import type { Assertion } from "@jevitate/recording";

export interface RunAuthorJourneyOptions {
  goal: string;
  successAssertionSpec: string; // JSON-encoded Assertion, same convention as the existing --success flag
  allowlist: string[];
  journeysDir: string;
  journeyId: string;
  journeyName: string;
  takes?: number;
}

export async function runAuthorJourney(opts: RunAuthorJourneyOptions) {
  const successAssertion: Assertion = JSON.parse(opts.successAssertionSpec);
  const { actor, judgment, generation } = await buildExploreDeps(opts.allowlist); // reuse ticket #1's Task 12 gateway/actor wiring

  const result = await authorJourney({
    goal: opts.goal,
    successAssertion,
    allowlist: opts.allowlist,
    actor,
    judgment,
    generation,
    takes: opts.takes ?? 1,
    journeyId: opts.journeyId,
    journeyName: opts.journeyName,
  });

  if (result.outcome === "authored") {
    await new FsJourneyStore(opts.journeysDir).put(result.journey);
  }
  return result;
}
```
(`buildExploreDeps` is the actor/credential-preflight/gateway wiring ticket #1's Task 12 already establishes for the plain `explore` command — reuse it verbatim rather than duplicating.)

In `packages/cli/src/program.ts`, add an `explore author-journey --url <url> --goal <text> --success <assertion-json> --takes <n> --id <id> --name <name> --journeys-dir <dir> [--allow <origin...>]` subcommand that calls `runAuthorJourney` and prints the result via `emitJson`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/cli/src/explore-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/explore-api.ts packages/cli/src/explore-api.test.ts packages/cli/src/program.ts
git commit -m "$(cat <<'EOF'
feat(cli): additive `explore author-journey` command

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

**Acceptance:** `jevitate explore author-journey --url <fixture> --goal "<goal>" --success <assertion> --id <id> --name <name> --journeys-dir <dir>` drives the fixture to the goal, authors a parameterized, replayable, unpromoted Journey, and writes it to the journeys store; `pnpm exec vitest run packages/explore/src/authoring` and the CLI tests pass on fakes; human-driving RxD paths are unmodified.

## Self-review

- **Spec coverage:** goal-based exploration authors a Journey (Task 4/5) ✅; deterministic/replayable product despite nondeterministic discovery (materialize-or-promote-or-handback, never a dangling redacted constant) ✅; human-driving unchanged (no RxD recorder/postdoc file touched) ✅; independent oracle preserved through authoring (Task 6 #2) ✅.
- **Placeholder scan:** no TODO/TBD; the one deliberately-flagged gap (ticket #1's `seedRecording` addition) is called out explicitly as an assumption with a stated, working fallback (Task 4's single-take path), not silently assumed.
- **Type consistency:** `AuthorJourneyRequest`/`AuthorJourneyResult` defined once in Task 4 and reused unchanged in Tasks 5–7; `JourneyMetadata.authoredBy` (Task 1) is the same literal union used in Task 4/6's assertions.
