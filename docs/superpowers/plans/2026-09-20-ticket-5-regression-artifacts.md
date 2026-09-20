# Regression Artifacts — Reproduce, Minimize, Commit (Ticket #5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Proposed (plan — for review before execution)
**Date:** 2026-09-20
**Ticket:** [#5](https://github.com/matt-cochran/jevitate/issues/5) — "Reproducible failures become minimized, deterministic, replayable regression artifacts"

**Goal:** Build a new `@jevitate/regression` package that turns any discovered failing `Recording` (however it was produced — a human RxD capture that hit a bug, a `@jevitate/runtime` `JourneyRunner` run that quarantined, or a future exploration/adversarial mission's defect capture) into a **reproduced, minimized, committed regression artifact**: a schema-valid `Recording` + metadata sidecar that fails on the bug today and, replayed by a generic committed test suite, passes once the bug is fixed (proof-of-failure → proof-of-fix). Flaky failures are detected and never committed.

**Architecture:** three composable, mostly-pure stages around the existing `@jevitate/interpreter` replay machinery:
1. **Reproduce** (`reproduce.ts`) — replay the failing `Recording` N times (fresh actor per attempt); a **failure fingerprint** (`@jevitate/recording`'s `strictSignature` on the failing step) identifies "the same bug" across attempts regardless of exact error text; label `"reproducible"` only if every attempt reproduces identically, else `"flaky"`.
2. **Minimize** (`minimize.ts`) — Zeller's delta-debugging (ddmin) over the flattened step sequence: repeatedly try removing contiguous chunks, keep a removal only if the resulting schema-valid `Recording` still reproduces the identical fingerprint.
3. **Commit** (`commit.ts`) — write the minimized `Recording` + a `RegressionMeta` sidecar under a committed `regressions/` directory; refuses (fail-closed) to commit anything labeled `"flaky"`.
4. **Regression suite** (`regression-suite.ts` + a generic Vitest test) — loads every committed regression and replays it; this is the CI gate that is RED while the bug is live and GREEN once the target code is fixed, with zero per-bug test authoring.
5. An additive CLI command (`jevitate regression capture`) wires reproduce → minimize → commit end to end from one failing-recording file.

**Assumption / dependency on #1 (`@jevitate/explore`, being built):** this package intentionally does **not** import `@jevitate/explore`. Ticket #1's planned P2 (adversarial mission) is the most natural future *producer* of "a discovered failure," but it is not yet planned in detail, and coupling `@jevitate/regression` to a not-yet-built mission API would be premature. Instead this plan accepts any schema-valid `Recording` plus the flat index where it failed as generic input — the same shape `@jevitate/interpreter`'s `InterpretResult` (`{outcome:"failed", at, error}`) and `@jevitate/runtime`'s `JourneyRunResult` (`{outcome:"quarantined", at}`) already produce today. When #1's P2 lands, its adversarial mission becomes just another producer that feeds this same pipeline — no changes to `@jevitate/regression` anticipated.

**Tech Stack:** TypeScript strict ESM (Node 20+, NodeNext), Vitest, pnpm workspaces, zod (via `@jevitate/recording`'s `RecordingSchema`). Depends on `@jevitate/recording` (`Recording`/`RecordedStep`/`Step`/`RecordingSchema`/`strictSignature`), `@jevitate/interpreter` (`RecordingInterpreter`, `InterpretResult`), `@jevitate/screenplay` (`Actor`, `CastActor`, `BrowseTheWeb`), `@jevitate/playwright` (`BrowserSession`, CLI/e2e path only).

**Spec:** `docs/superpowers/specs/2026-09-19-autonomous-exploration-testing-design.md` §3.1/§4 ("Defect reports: Recording (repro) + failing state..."), positioned by `docs/superpowers/specs/2026-09-19-unified-journey-automation-and-testing-design.md` §8 ("Testing missions ... plus defects → committed deterministic regression tests that fail on the bug and pass after the fix"). Issue #5 explicitly notes: **"Direct Playwright export is an open product decision, not assumed"** — this plan does not build a `Recording → Playwright` emitter; the committed artifact is the `Recording` itself, replayed via the existing interpreter.

## Global Constraints

- Node 20+, ESM, `strict: true`, project references (`tsc --build`) — mirror `tsconfig.base.json`.
- Dependency direction inward only: `@jevitate/regression` depends on the packages above; nothing depends on it except one additive `@jevitate/cli` command.
- **Repo gotcha:** packages have NO `"test"` script — run `pnpm exec vitest run <path>`, never `pnpm --filter <pkg> test`.
- Git staging is explicit-path only (`git add <exact files>`), never `-A`/`.`.
- Commit trailer for every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- CI runs on deterministic fakes only (fake actors/interpreters in unit tests); any real-browser replay test is opt-in/e2e.
- Gitflow: branch off `dev` as `feature/regression-artifacts`, PR back to `dev` (never merge a feature branch directly to `main`).

## Guardrails (binding — each ships an "asserts-it-refuses" test where applicable)

1. **Flaky never promoted.** `commitRegression` throws `FlakyNotCommittableError` and writes nothing when the reproduction report's `label !== "reproducible"`.
2. **Minimization never loses the bug.** `minimizeRecording`'s own removal test is "does the candidate still reproduce the IDENTICAL fingerprint" — a removal is applied only if that holds; the returned Recording is verified (in a dedicated test) to still reproduce before it is ever passed to `commitRegression`.
3. **Committed artifact is schema-valid.** `commitRegression` runs `RecordingSchema.parse` before writing; a malformed candidate never reaches disk.
4. **No fabricated "already fixed" state.** `reproduceFailure` throws `NeverFailedError` if the input recording never actually fails across any attempt — refuses to let a non-bug become a "regression."

## File Structure

```
packages/regression/
  package.json
  tsconfig.json
  src/
    index.ts                       # barrel
    fingerprint.ts                 # FailureFingerprint via strictSignature
    fingerprint.test.ts
    reproduce.ts                   # retry harness + flaky labeling
    reproduce.test.ts
    minimize.ts                    # ddmin over flattened steps
    minimize.test.ts
    commit.ts                      # write Recording + RegressionMeta, fail-closed on flaky
    commit.test.ts
    regression-suite.ts            # loader + replay helper for the committed-regressions CI gate
    regression-suite.test.ts
    regression-invariants.test.ts  # guardrail #1-#4 refusal contract

packages/cli/                      # ONE additive, flagged touch (final task)
  package.json                     # + "@jevitate/regression": "workspace:*"
  tsconfig.json                    # + { "path": "../regression" }
  src/
    regression-api.ts              # NEW — wires a real Page + reproduce/minimize/commit
    regression-api.test.ts         # NEW — no-browser tests (flaky refusal, commit path with fakes)
    program.ts                     # + `regression capture` subcommand

vitest.config.ts                   # + "@jevitate/regression" alias
tsconfig.json                      # + { "path": "packages/regression" }
```

---

## Task 1: Scaffold `@jevitate/regression` + failure fingerprint

**Files:**
- Create: `packages/regression/package.json`, `packages/regression/tsconfig.json`, `packages/regression/src/index.ts`
- Create: `packages/regression/src/fingerprint.ts`
- Test: `packages/regression/src/fingerprint.test.ts`
- Modify: `vitest.config.ts` (add alias), `tsconfig.json` (add reference)

**Interfaces:**
- Produces: `FailureFingerprint { stepSignature: string }`, `fingerprintFailure(rec: Recording, atFlatIndex: number): FailureFingerprint`, `matchesFingerprint(rec: Recording, atFlatIndex: number, fp: FailureFingerprint): boolean`, `flattenWithUrls(rec: Recording): { step: RecordedStep; pageUrl: string }[]`.

- [ ] **Step 1: Scaffold the package**

`packages/regression/package.json`:
```json
{
  "name": "@jevitate/regression",
  "version": "0.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "scripts": { "build": "tsc --build" },
  "dependencies": {
    "@jevitate/recording": "workspace:*",
    "@jevitate/interpreter": "workspace:*",
    "@jevitate/screenplay": "workspace:*"
  },
  "devDependencies": {
    "@jevitate/playwright": "workspace:*",
    "zod": "^4.6.5"
  }
}
```

`packages/regression/tsconfig.json` (mirror `packages/recording/tsconfig.json`'s shape — extend the base config and reference the deps above; use the exact `extends`/`compilerOptions`/`references` block already used by `packages/recording/tsconfig.json` verbatim, swapping `references` to point at `../recording`, `../interpreter`, `../screenplay`, `../playwright`).

`packages/regression/src/index.ts`:
```ts
export * from "./fingerprint.js";
```

Add to root `vitest.config.ts`'s `resolve.alias`:
```ts
"@jevitate/regression": pkg("regression"),
```

Add to root `tsconfig.json`'s `references`:
```json
{ "path": "packages/regression" }
```

- [ ] **Step 2: Write the failing test for the fingerprint**

`packages/regression/src/fingerprint.test.ts`:
```ts
import { expect, test } from "vitest";
import type { Recording } from "@jevitate/recording";
import { fingerprintFailure, matchesFingerprint, flattenWithUrls } from "./fingerprint.js";

function rec(): Recording {
  return {
    version: "1.0",
    site: "https://example.test",
    pages: [
      {
        url: "/inbox",
        steps: [
          { step: { kind: "navigate", url: "/inbox", expect: { kind: "visible", target: { testId: "loaded" } } } },
          { step: { kind: "click", target: { role: "button", name: "Compose" }, expect: { kind: "visible", target: { testId: "editor" } } } },
        ],
      },
    ],
  };
}

test("fingerprintFailure captures the strict signature of the step at the given flat index", () => {
  const fp = fingerprintFailure(rec(), 1);
  expect(fp.stepSignature).toContain("click");
  expect(fp.stepSignature).toContain("Compose");
});

test("matchesFingerprint is true for the same structural step, false for a different one", () => {
  const fp = fingerprintFailure(rec(), 1);
  expect(matchesFingerprint(rec(), 1, fp)).toBe(true);
  expect(matchesFingerprint(rec(), 0, fp)).toBe(false);
});

test("fingerprintFailure throws for an out-of-range index", () => {
  expect(() => fingerprintFailure(rec(), 5)).toThrow(/out of range/);
});

test("flattenWithUrls preserves page-then-step order with each step's page url", () => {
  const flat = flattenWithUrls(rec());
  expect(flat).toHaveLength(2);
  expect(flat[0].pageUrl).toBe("/inbox");
  expect(flat[1].step.step.kind).toBe("click");
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/regression/src/fingerprint.test.ts`
Expected: FAIL — `./fingerprint.js` has no exports yet (module not found).

- [ ] **Step 4: Implement `fingerprint.ts`**

`packages/regression/src/fingerprint.ts`:
```ts
import type { Recording, RecordedStep } from "@jevitate/recording";
import { strictSignature } from "@jevitate/recording";

export interface FailureFingerprint {
  readonly stepSignature: string;
}

/**
 * Flattens a Recording's pages into (RecordedStep, pageUrl) pairs, in the
 * same page-then-step order `@jevitate/interpreter`'s internal flatten()
 * uses — `RecordingInterpreter.run`'s `at` indexes into this same order.
 */
export function flattenWithUrls(rec: Recording): { step: RecordedStep; pageUrl: string }[] {
  const out: { step: RecordedStep; pageUrl: string }[] = [];
  for (const page of rec.pages) {
    for (const step of page.steps) out.push({ step, pageUrl: page.url });
  }
  return out;
}

export function fingerprintFailure(rec: Recording, atFlatIndex: number): FailureFingerprint {
  const flat = flattenWithUrls(rec);
  const entry = flat[atFlatIndex];
  if (!entry) {
    throw new Error(`fingerprintFailure: index ${atFlatIndex} out of range for a ${flat.length}-step recording`);
  }
  return { stepSignature: strictSignature(entry.step.step, entry.pageUrl) };
}

export function matchesFingerprint(rec: Recording, atFlatIndex: number, fp: FailureFingerprint): boolean {
  const flat = flattenWithUrls(rec);
  const entry = flat[atFlatIndex];
  if (!entry) return false;
  return strictSignature(entry.step.step, entry.pageUrl) === fp.stepSignature;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/regression/src/fingerprint.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/regression/package.json packages/regression/tsconfig.json packages/regression/src/index.ts packages/regression/src/fingerprint.ts packages/regression/src/fingerprint.test.ts vitest.config.ts tsconfig.json
git commit -m "$(cat <<'EOF'
feat(regression): scaffold @jevitate/regression + failure fingerprint

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Reproduce — retry harness + flaky labeling

**Files:**
- Create: `packages/regression/src/reproduce.ts`
- Test: `packages/regression/src/reproduce.test.ts`

**Interfaces:**
- Consumes: `fingerprintFailure`/`matchesFingerprint` (Task 1); `RecordingInterpreter` from `@jevitate/interpreter`; `Actor` from `@jevitate/screenplay`.
- Produces: `ReproductionReport { attempts: number; reproducedCount: number; rate: number; label: "reproducible" | "flaky"; fingerprint: FailureFingerprint; firstFailureAt: number }`, `reproduceFailure(recording: Recording, makeActor: () => Promise<Actor>, attempts?: number): Promise<ReproductionReport>`, `NeverFailedError`.

- [ ] **Step 1: Write the failing tests**

`packages/regression/src/reproduce.test.ts`:
```ts
import { expect, test, vi } from "vitest";
import type { Recording } from "@jevitate/recording";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { reproduceFailure, NeverFailedError } from "./reproduce.js";

function fakeLocator(overrides: Partial<Record<string, any>> = {}) {
  return {
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    isVisible: vi.fn(async () => false), // the postcondition that never holds — always fails
    count: vi.fn(async () => 0),
    innerText: vi.fn(async () => ""),
    waitFor: vi.fn(async () => {}),
    ...overrides,
  };
}

function fakePage(locator: ReturnType<typeof fakeLocator>) {
  return {
    goto: vi.fn(async () => {}),
    url: vi.fn(() => "https://example.test/inbox"),
    getByTestId: vi.fn(() => locator),
    getByRole: vi.fn(() => locator),
    getByLabel: vi.fn(() => locator),
    getByText: vi.fn(() => locator),
    locator: vi.fn(() => locator),
  };
}

function makeFailingActorFactory() {
  return async () =>
    CastActor.named("repro").whoCan(
      new BrowseTheWeb(
        { page: fakePage(fakeLocator()), startTracing: vi.fn(), stopTracingToFile: vi.fn(), close: vi.fn() } as any,
        [],
      ),
    );
}

const rec: Recording = {
  version: "1.0",
  site: "https://example.test",
  pages: [
    {
      url: "/inbox",
      steps: [
        { step: { kind: "navigate", url: "/inbox", expect: { kind: "visible", target: { testId: "loaded" } } } },
        { step: { kind: "click", target: { role: "button", name: "Compose" }, expect: { kind: "visible", target: { testId: "editor" } } } },
      ],
    },
  ],
};

test("a consistently-failing recording is labeled reproducible with rate 1", async () => {
  const report = await reproduceFailure(rec, makeFailingActorFactory(), 3);
  expect(report.label).toBe("reproducible");
  expect(report.rate).toBe(1);
  expect(report.attempts).toBe(3);
  expect(report.reproducedCount).toBe(3);
  expect(report.fingerprint.stepSignature).toContain("navigate");
});

test("a recording that fails on the first attempt but passes later is labeled flaky", async () => {
  let call = 0;
  const makeActor = async () => {
    call++;
    const passingLocator = fakeLocator({ isVisible: vi.fn(async () => true) });
    const locator = call === 1 ? fakeLocator() : passingLocator;
    return CastActor.named("repro").whoCan(
      new BrowseTheWeb(
        { page: fakePage(locator), startTracing: vi.fn(), stopTracingToFile: vi.fn(), close: vi.fn() } as any,
        [],
      ),
    );
  };
  const report = await reproduceFailure(rec, makeActor, 3);
  expect(report.label).toBe("flaky");
  expect(report.rate).toBeLessThan(1);
});

test("throws NeverFailedError when the recording never fails", async () => {
  const passingActorFactory = async () =>
    CastActor.named("repro").whoCan(
      new BrowseTheWeb(
        { page: fakePage(fakeLocator({ isVisible: vi.fn(async () => true) })), startTracing: vi.fn(), stopTracingToFile: vi.fn(), close: vi.fn() } as any,
        [],
      ),
    );
  await expect(reproduceFailure(rec, passingActorFactory, 2)).rejects.toThrow(NeverFailedError);
});

test("rejects attempts < 1", async () => {
  await expect(reproduceFailure(rec, makeFailingActorFactory(), 0)).rejects.toThrow(/attempts must be/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/regression/src/reproduce.test.ts`
Expected: FAIL — `./reproduce.js` not found.

- [ ] **Step 3: Implement `reproduce.ts`**

`packages/regression/src/reproduce.ts`:
```ts
import type { Actor } from "@jevitate/screenplay";
import type { Recording } from "@jevitate/recording";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { fingerprintFailure, matchesFingerprint, type FailureFingerprint } from "./fingerprint.js";

export class NeverFailedError extends Error {}

export interface ReproductionReport {
  attempts: number;
  reproducedCount: number;
  rate: number;
  label: "reproducible" | "flaky";
  fingerprint: FailureFingerprint;
  firstFailureAt: number;
}

/**
 * Replays `recording` `attempts` times (a fresh `Actor` per attempt, via
 * `makeActor` — a Playwright-backed session cannot be reused after a run)
 * and counts how many attempts fail at the SAME structural step (per
 * `matchesFingerprint`). `label: "reproducible"` requires EVERY attempt to
 * reproduce identically (rate === 1); anything less is `"flaky"` and must
 * never be promoted to a committed regression.
 */
export async function reproduceFailure(
  recording: Recording,
  makeActor: () => Promise<Actor>,
  attempts = 3,
): Promise<ReproductionReport> {
  if (attempts < 1) throw new Error("reproduceFailure: attempts must be >= 1");

  const interpreter = new RecordingInterpreter();
  let firstFailureAt = -1;
  let reproducedCount = 0;
  let fingerprint: FailureFingerprint | undefined;

  for (let i = 0; i < attempts; i++) {
    const actor = await makeActor();
    const result = await interpreter.run(actor, recording);
    if (result.outcome !== "failed") continue;

    if (!fingerprint) {
      firstFailureAt = result.at;
      fingerprint = fingerprintFailure(recording, result.at);
      reproducedCount = 1;
      continue;
    }
    if (matchesFingerprint(recording, result.at, fingerprint)) reproducedCount++;
  }

  if (!fingerprint) {
    throw new NeverFailedError(
      "reproduceFailure: the recording did not fail on any of the attempts — nothing to reproduce",
    );
  }

  const rate = reproducedCount / attempts;
  return { attempts, reproducedCount, rate, label: rate === 1 ? "reproducible" : "flaky", fingerprint, firstFailureAt };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/regression/src/reproduce.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/regression/src/reproduce.ts packages/regression/src/reproduce.test.ts
git commit -m "$(cat <<'EOF'
feat(regression): reproduction retry harness with flaky labeling

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Minimize — delta-debugging over the flat step sequence

**Files:**
- Create: `packages/regression/src/minimize.ts`
- Test: `packages/regression/src/minimize.test.ts`

**Interfaces:**
- Consumes: `matchesFingerprint`, `FailureFingerprint` (Task 1); `RecordingSchema` from `@jevitate/recording`; `RecordingInterpreter` from `@jevitate/interpreter`.
- Produces: `Reproduces = (candidate: Recording) => Promise<boolean>`, `makeSingleShotReproduces(makeActor, fingerprint): Reproduces`, `minimizeRecording(recording: Recording, reproduces: Reproduces): Promise<Recording>`.

- [ ] **Step 1: Write the failing test**

`packages/regression/src/minimize.test.ts`:
```ts
import { expect, test } from "vitest";
import type { Recording, PageSegment } from "@jevitate/recording";
import { minimizeRecording, type Reproduces } from "./minimize.js";

function step(name: string) {
  return { step: { kind: "click" as const, target: { role: "button", name }, expect: { kind: "visible" as const, target: { testId: "ok" } } } };
}

function recWithSteps(names: string[]): Recording {
  const page: PageSegment = { url: "/x", steps: names.map(step) };
  return { version: "1.0", site: "https://example.test", pages: [page] };
}

test("removes irrelevant middle steps, keeping only the ones the reproduces predicate needs", async () => {
  // "essential-start" and "essential-bug" are required; "noise-1"/"noise-2"/"noise-3" are not.
  const rec = recWithSteps(["essential-start", "noise-1", "noise-2", "noise-3", "essential-bug"]);
  const reproduces: Reproduces = async (candidate) => {
    const names = candidate.pages.flatMap((p) => p.steps.map((s: any) => s.step.target.name));
    return names.includes("essential-start") && names.includes("essential-bug");
  };
  const minimized = await minimizeRecording(rec, reproduces);
  const names = minimized.pages.flatMap((p) => p.steps.map((s: any) => s.step.target.name));
  expect(names).toEqual(["essential-start", "essential-bug"]);
});

test("never returns a candidate that fails the reproduces predicate", async () => {
  const rec = recWithSteps(["a", "b", "c"]);
  const reproduces: Reproduces = async (candidate) => candidate.pages[0].steps.length >= 2;
  const minimized = await minimizeRecording(rec, reproduces);
  expect(await reproduces(minimized)).toBe(true);
  expect(minimized.pages[0].steps.length).toBe(2);
});

test("a recording that is already minimal is returned unchanged", async () => {
  const rec = recWithSteps(["only-one"]);
  const reproduces: Reproduces = async (candidate) => candidate.pages[0]?.steps.length === 1;
  const minimized = await minimizeRecording(rec, reproduces);
  expect(minimized.pages[0].steps).toHaveLength(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/regression/src/minimize.test.ts`
Expected: FAIL — `./minimize.js` not found.

- [ ] **Step 3: Implement `minimize.ts`**

`packages/regression/src/minimize.ts`:
```ts
import type { Recording, PageSegment, RecordedStep } from "@jevitate/recording";
import { RecordingSchema } from "@jevitate/recording";
import type { Actor } from "@jevitate/screenplay";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { matchesFingerprint, type FailureFingerprint } from "./fingerprint.js";

interface FlatEntry {
  pageIndex: number;
  pageUrl: string;
  pageTitle?: string;
  step: RecordedStep;
}

function flattenWithPageInfo(rec: Recording): FlatEntry[] {
  const out: FlatEntry[] = [];
  rec.pages.forEach((page, pageIndex) => {
    page.steps.forEach((step) => out.push({ pageIndex, pageUrl: page.url, pageTitle: page.title, step }));
  });
  return out;
}

/**
 * Rebuilds a schema-valid Recording from a SUBSET of a flattened step list
 * (by object identity), regrouping consecutive same-source-page entries back
 * into `PageSegment`s. Order-preserving; drops no page explicitly (an
 * emptied page simply contributes zero steps, which never happens here
 * since `entries` only ever shrinks by whole chunks, and a wholly-dropped
 * page contributes no entries at all).
 */
function reassemble(base: Recording, entries: FlatEntry[]): Recording {
  const pages: (PageSegment & { __srcPageIndex: number })[] = [];
  for (const entry of entries) {
    const last = pages[pages.length - 1];
    if (last && last.__srcPageIndex === entry.pageIndex) {
      last.steps.push(entry.step);
    } else {
      pages.push({ url: entry.pageUrl, title: entry.pageTitle, steps: [entry.step], __srcPageIndex: entry.pageIndex });
    }
  }
  return { ...base, pages: pages.map(({ __srcPageIndex, ...p }) => p) };
}

export type Reproduces = (candidate: Recording) => Promise<boolean>;

/**
 * Builds a `Reproduces` predicate for the (already `"reproducible"`-labeled)
 * failure `fingerprint`: replays `candidate` once via a fresh actor and
 * reports true only if it fails at the SAME structural step. Single
 * attempt — flakiness is handled up front by `reproduceFailure`.
 */
export function makeSingleShotReproduces(makeActor: () => Promise<Actor>, fingerprint: FailureFingerprint): Reproduces {
  return async (candidate) => {
    const actor = await makeActor();
    const result = await new RecordingInterpreter().run(actor, candidate);
    if (result.outcome !== "failed") return false;
    return matchesFingerprint(candidate, result.at, fingerprint);
  };
}

/**
 * Zeller's ddmin over the flattened step sequence: repeatedly tries removing
 * ever-smaller contiguous chunks, keeping a removal only when the resulting
 * (schema-valid, re-flowed) Recording still satisfies `reproduces`.
 * Terminates when granularity reaches individual steps and no further
 * single-step removal reproduces.
 */
export async function minimizeRecording(recording: Recording, reproduces: Reproduces): Promise<Recording> {
  let entries = flattenWithPageInfo(recording);
  let granularity = 2;

  while (entries.length >= 2) {
    const chunkSize = Math.ceil(entries.length / granularity);
    const chunks: FlatEntry[][] = [];
    for (let i = 0; i < entries.length; i += chunkSize) chunks.push(entries.slice(i, i + chunkSize));

    let reducedThisPass = false;
    for (const chunk of chunks) {
      const complement = entries.filter((e) => !chunk.includes(e));
      if (complement.length === 0) continue;

      const candidate = reassemble(recording, complement);
      if (!RecordingSchema.safeParse(candidate).success) continue;
      if (await reproduces(candidate)) {
        entries = complement;
        granularity = Math.max(granularity - 1, 2);
        reducedThisPass = true;
        break;
      }
    }

    if (!reducedThisPass) {
      if (granularity >= entries.length) break;
      granularity = Math.min(granularity * 2, entries.length);
    }
  }

  return reassemble(recording, entries);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/regression/src/minimize.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/regression/src/minimize.ts packages/regression/src/minimize.test.ts
git commit -m "$(cat <<'EOF'
feat(regression): ddmin step-sequence minimization

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Commit — write the regression artifact, fail-closed on flaky

**Files:**
- Create: `packages/regression/src/commit.ts`
- Test: `packages/regression/src/commit.test.ts`

**Interfaces:**
- Consumes: `ReproductionReport` (Task 2), `RecordingSchema` from `@jevitate/recording`.
- Produces: `RegressionMeta { id: string; capturedAtIso: string; fingerprint: { stepSignature: string }; reproduction: { attempts: number; reproducedCount: number; rate: number }; bugSummary?: string }`, `FlakyNotCommittableError`, `commitRegression(dir: string, id: string, minimized: Recording, report: ReproductionReport, bugSummary?: string): Promise<{ recordingPath: string; metaPath: string }>`.

- [ ] **Step 1: Write the failing tests**

`packages/regression/src/commit.test.ts`:
```ts
import { expect, test } from "vitest";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Recording } from "@jevitate/recording";
import type { ReproductionReport } from "./reproduce.js";
import { commitRegression, FlakyNotCommittableError } from "./commit.js";

const rec: Recording = {
  version: "1.0",
  site: "https://example.test",
  pages: [{ url: "/x", steps: [{ step: { kind: "assert", check: { kind: "urlIncludes", text: "/x" } } }] }],
};

const reproducibleReport: ReproductionReport = {
  attempts: 3,
  reproducedCount: 3,
  rate: 1,
  label: "reproducible",
  fingerprint: { stepSignature: "assert|/x|assert:urlIncludes:/x" },
  firstFailureAt: 0,
};

const flakyReport: ReproductionReport = { ...reproducibleReport, label: "flaky", rate: 0.5, reproducedCount: 1 };

test("commits a reproducible regression as a Recording + meta sidecar", async () => {
  const dir = await mkdtemp(join(tmpdir(), "regr-"));
  const { recordingPath, metaPath } = await commitRegression(dir, "bug-123", rec, reproducibleReport, "checkout total wrong after coupon");

  const savedRecording = JSON.parse(await readFile(recordingPath, "utf8"));
  expect(savedRecording.pages[0].steps[0].step.kind).toBe("assert");

  const meta = JSON.parse(await readFile(metaPath, "utf8"));
  expect(meta.id).toBe("bug-123");
  expect(meta.reproduction).toEqual({ attempts: 3, reproducedCount: 3, rate: 1 });
  expect(meta.bugSummary).toBe("checkout total wrong after coupon");

  const files = await readdir(dir);
  expect(files.sort()).toEqual(["bug-123.meta.json", "bug-123.recording.json"]);
});

test("refuses to commit a flaky report — writes nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "regr-"));
  await expect(commitRegression(dir, "bug-flaky", rec, flakyReport)).rejects.toThrow(FlakyNotCommittableError);
  expect(await readdir(dir)).toEqual([]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/regression/src/commit.test.ts`
Expected: FAIL — `./commit.js` not found.

- [ ] **Step 3: Implement `commit.ts`**

`packages/regression/src/commit.ts`:
```ts
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type { Recording } from "@jevitate/recording";
import { RecordingSchema } from "@jevitate/recording";
import type { ReproductionReport } from "./reproduce.js";

export class FlakyNotCommittableError extends Error {}

export interface RegressionMeta {
  id: string;
  capturedAtIso: string;
  fingerprint: { stepSignature: string };
  reproduction: { attempts: number; reproducedCount: number; rate: number };
  bugSummary?: string;
}

/**
 * Commits a minimized, reproducible Recording as a regression artifact:
 * `<dir>/<id>.recording.json` (schema-valid Recording) + `<dir>/<id>.meta.json`
 * (RegressionMeta). Refuses (fail-closed) to commit a `"flaky"`-labeled
 * report — flaky failures are labeled, never promoted.
 */
export async function commitRegression(
  dir: string,
  id: string,
  minimized: Recording,
  report: ReproductionReport,
  bugSummary?: string,
): Promise<{ recordingPath: string; metaPath: string }> {
  if (report.label === "flaky") {
    throw new FlakyNotCommittableError(
      `refusing to commit '${id}': reproduction rate ${report.rate} (${report.reproducedCount}/${report.attempts}) is flaky, not reproducible`,
    );
  }
  const validated = RecordingSchema.parse(minimized);

  await mkdir(dir, { recursive: true });
  const recordingPath = join(dir, `${id}.recording.json`);
  const metaPath = join(dir, `${id}.meta.json`);
  const meta: RegressionMeta = {
    id,
    capturedAtIso: new Date().toISOString(),
    fingerprint: report.fingerprint,
    reproduction: { attempts: report.attempts, reproducedCount: report.reproducedCount, rate: report.rate },
    bugSummary,
  };
  await writeFile(recordingPath, JSON.stringify(validated, null, 2) + "\n");
  await writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n");
  return { recordingPath, metaPath };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/regression/src/commit.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/regression/src/commit.ts packages/regression/src/commit.test.ts
git commit -m "$(cat <<'EOF'
feat(regression): commit gate — fail-closed on flaky reports

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Regression suite — the committed-regressions CI gate

**Files:**
- Create: `packages/regression/src/regression-suite.ts`
- Test: `packages/regression/src/regression-suite.test.ts`

**Interfaces:**
- Consumes: `RecordingSchema` from `@jevitate/recording`; `RecordingInterpreter` from `@jevitate/interpreter`; `Actor` from `@jevitate/screenplay`.
- Produces: `RegressionCase { id: string; recording: Recording }`, `loadRegressions(dir: string): Promise<RegressionCase[]>`, `replayRegression(actor: Actor, recording: Recording): Promise<"completed" | "failed">`.

- [ ] **Step 1: Write the failing tests**

`packages/regression/src/regression-suite.test.ts`:
```ts
import { expect, test, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { loadRegressions, replayRegression } from "./regression-suite.js";

test("loadRegressions returns [] for a missing/empty directory", async () => {
  expect(await loadRegressions(join(tmpdir(), "does-not-exist-" + Date.now()))).toEqual([]);
});

test("loadRegressions reads every committed *.recording.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "regr-suite-"));
  const recording = {
    version: "1.0",
    site: "https://example.test",
    pages: [{ url: "/x", steps: [{ step: { kind: "assert", check: { kind: "urlIncludes", text: "/x" } } }] }],
  };
  await writeFile(join(dir, "bug-1.recording.json"), JSON.stringify(recording));
  const cases = await loadRegressions(dir);
  expect(cases).toHaveLength(1);
  expect(cases[0].id).toBe("bug-1");
  expect(cases[0].recording.pages[0].steps[0].step.kind).toBe("assert");
});

test("replayRegression reports completed when the interpreter finishes, failed otherwise", async () => {
  const passingPage = { url: vi.fn(() => "https://example.test/x") };
  const actor = CastActor.named("suite").whoCan(
    new BrowseTheWeb({ page: passingPage, startTracing: vi.fn(), stopTracingToFile: vi.fn(), close: vi.fn() } as any, []),
  );
  const recording = {
    version: "1.0",
    site: "https://example.test",
    pages: [{ url: "/x", steps: [{ step: { kind: "assert", check: { kind: "urlIncludes", text: "/x" } } }] }],
  };
  expect(await replayRegression(actor, recording as any)).toBe("completed");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/regression/src/regression-suite.test.ts`
Expected: FAIL — `./regression-suite.js` not found.

- [ ] **Step 3: Implement `regression-suite.ts`**

`packages/regression/src/regression-suite.ts`:
```ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { RecordingSchema, type Recording } from "@jevitate/recording";
import type { Actor } from "@jevitate/screenplay";
import { RecordingInterpreter } from "@jevitate/interpreter";

export interface RegressionCase {
  id: string;
  recording: Recording;
}

/** Loads every committed `<id>.recording.json` from `dir`. Returns `[]` for
 * a missing directory rather than throwing — an empty/absent regressions
 * directory is a valid ("no regressions yet") state, not an error. */
export async function loadRegressions(dir: string): Promise<RegressionCase[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const ids = files.filter((f) => f.endsWith(".recording.json")).map((f) => f.replace(/\.recording\.json$/, ""));
  const cases: RegressionCase[] = [];
  for (const id of ids) {
    const raw = await readFile(join(dir, `${id}.recording.json`), "utf8");
    cases.push({ id, recording: RecordingSchema.parse(JSON.parse(raw)) });
  }
  return cases;
}

export async function replayRegression(actor: Actor, recording: Recording): Promise<"completed" | "failed"> {
  const result = await new RecordingInterpreter().run(actor, recording);
  return result.outcome === "completed" ? "completed" : "failed";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/regression/src/regression-suite.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/regression/src/regression-suite.ts packages/regression/src/regression-suite.test.ts
git commit -m "$(cat <<'EOF'
feat(regression): loader + replay helper for the committed-regressions CI gate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Invariant refusal contract

**Files:**
- Create: `packages/regression/src/regression-invariants.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5.

- [ ] **Step 1: Write the invariant tests**

`packages/regression/src/regression-invariants.test.ts`:
```ts
import { expect, test, vi } from "vitest";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Recording } from "@jevitate/recording";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { reproduceFailure, NeverFailedError } from "./reproduce.js";
import { minimizeRecording, makeSingleShotReproduces } from "./minimize.js";
import { commitRegression, FlakyNotCommittableError } from "./commit.js";

function fakeLocator(visible: boolean) {
  return { click: vi.fn(async () => {}), fill: vi.fn(async () => {}), isVisible: vi.fn(async () => visible), count: vi.fn(async () => 0), innerText: vi.fn(async () => ""), waitFor: vi.fn(async () => {}) };
}
function fakePage(locator: ReturnType<typeof fakeLocator>) {
  return { goto: vi.fn(async () => {}), url: vi.fn(() => "https://example.test/x"), getByTestId: vi.fn(() => locator), getByRole: vi.fn(() => locator), getByLabel: vi.fn(() => locator), getByText: vi.fn(() => locator), locator: vi.fn(() => locator) };
}
function makeActor(visible: boolean) {
  return async () => CastActor.named("a").whoCan(new BrowseTheWeb({ page: fakePage(fakeLocator(visible)), startTracing: vi.fn(), stopTracingToFile: vi.fn(), close: vi.fn() } as any, []));
}

const rec: Recording = {
  version: "1.0",
  site: "https://example.test",
  pages: [{ url: "/x", steps: [{ step: { kind: "click", target: { role: "button", name: "Go" }, expect: { kind: "visible", target: { testId: "next" } } } }] }],
};

test("#1 flaky never promoted: commitRegression refuses and writes nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "inv-"));
  const flaky = { attempts: 2, reproducedCount: 1, rate: 0.5, label: "flaky" as const, fingerprint: { stepSignature: "x" }, firstFailureAt: 0 };
  await expect(commitRegression(dir, "id", rec, flaky)).rejects.toThrow(FlakyNotCommittableError);
  expect(await readdir(dir)).toEqual([]);
});

test("#2 minimization never loses the bug: the final minimized Recording still reproduces", async () => {
  const report = await reproduceFailure(rec, makeActor(false), 3);
  expect(report.label).toBe("reproducible");
  const reproduces = makeSingleShotReproduces(makeActor(false), report.fingerprint);
  const minimized = await minimizeRecording(rec, reproduces);
  expect(await reproduces(minimized)).toBe(true);
});

test("#3 committed artifact is schema-valid: commitRegression rejects a malformed candidate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "inv-"));
  const report = await reproduceFailure(rec, makeActor(false), 1);
  const malformed = { ...rec, pages: [{ url: "/x", steps: [{ step: { kind: "not-a-real-kind" } }] }] } as any;
  await expect(commitRegression(dir, "id", malformed, report)).rejects.toThrow();
});

test("#4 no fabricated regression: reproduceFailure refuses an already-passing recording", async () => {
  await expect(reproduceFailure(rec, makeActor(true), 2)).rejects.toThrow(NeverFailedError);
});
```

- [ ] **Step 2: Run to verify all pass (this is a regression/contract suite, not RED→GREEN — every guardrail should already hold from Tasks 1–5)**

Run: `pnpm exec vitest run packages/regression/src/regression-invariants.test.ts`
Expected: PASS (4 tests). If any fails, the corresponding Task 1–5 implementation has a gap — fix there, not here.

- [ ] **Step 3: Commit**

```bash
git add packages/regression/src/regression-invariants.test.ts
git commit -m "$(cat <<'EOF'
test(regression): invariant refusal contract (flaky/minimize/schema/never-failed)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Additive CLI command

**Files:**
- Create: `packages/cli/src/regression-api.ts`
- Test: `packages/cli/src/regression-api.test.ts`
- Modify: `packages/cli/package.json` (+ `"@jevitate/regression": "workspace:*"`), `packages/cli/tsconfig.json` (+ `{ "path": "../regression" }`), `packages/cli/src/program.ts` (+ `regression capture` subcommand)

**Interfaces:**
- Consumes: `reproduceFailure`, `minimizeRecording`, `makeSingleShotReproduces`, `commitRegression` from `@jevitate/regression`; `RecordingSchema` from `@jevitate/recording`.
- Produces: `runRegressionCapture(opts: { failingRecordingPath: string; id: string; regressionsDir: string; attempts?: number; bugSummary?: string; makeActor: () => Promise<Actor> }): Promise<{ recordingPath: string; metaPath: string } | { skipped: "flaky"; rate: number }>`.

- [ ] **Step 1: Write the failing test**

`packages/cli/src/regression-api.test.ts`:
```ts
import { expect, test, vi } from "vitest";
import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { runRegressionCapture } from "./regression-api.js";

function fakeLocator(visible: boolean) {
  return { click: vi.fn(async () => {}), isVisible: vi.fn(async () => visible), count: vi.fn(async () => 0), innerText: vi.fn(async () => ""), fill: vi.fn(async () => {}), waitFor: vi.fn(async () => {}) };
}
function fakePage(locator: ReturnType<typeof fakeLocator>) {
  return { goto: vi.fn(async () => {}), url: vi.fn(() => "https://example.test/x"), getByTestId: vi.fn(() => locator), getByRole: vi.fn(() => locator), getByLabel: vi.fn(() => locator), getByText: vi.fn(() => locator), locator: vi.fn(() => locator) };
}
function makeFailingActor() {
  return async () => CastActor.named("cli").whoCan(new BrowseTheWeb({ page: fakePage(fakeLocator(false)), startTracing: vi.fn(), stopTracingToFile: vi.fn(), close: vi.fn() } as any, []));
}

test("capture end to end: reproduce -> minimize -> commit, from a failing-recording file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-regr-"));
  const failingRecordingPath = join(dir, "input.json");
  await writeFile(
    failingRecordingPath,
    JSON.stringify({
      version: "1.0",
      site: "https://example.test",
      pages: [{ url: "/x", steps: [{ step: { kind: "click", target: { role: "button", name: "Go" }, expect: { kind: "visible", target: { testId: "next" } } } }] }],
    }),
  );

  const regressionsDir = join(dir, "regressions");
  const result = await runRegressionCapture({
    failingRecordingPath,
    id: "bug-1",
    regressionsDir,
    attempts: 2,
    makeActor: makeFailingActor(),
  });

  expect(result).toMatchObject({ recordingPath: expect.stringContaining("bug-1.recording.json") });
  expect((await readdir(regressionsDir)).sort()).toEqual(["bug-1.meta.json", "bug-1.recording.json"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/cli/src/regression-api.test.ts`
Expected: FAIL — `./regression-api.js` not found.

- [ ] **Step 3: Implement `regression-api.ts` and wire `program.ts`**

`packages/cli/src/regression-api.ts`:
```ts
import { readFile } from "node:fs/promises";
import type { Actor } from "@jevitate/screenplay";
import { RecordingSchema } from "@jevitate/recording";
import { reproduceFailure } from "@jevitate/regression";
import { minimizeRecording, makeSingleShotReproduces } from "@jevitate/regression";
import { commitRegression } from "@jevitate/regression";

export interface RunRegressionCaptureOptions {
  failingRecordingPath: string;
  id: string;
  regressionsDir: string;
  attempts?: number;
  bugSummary?: string;
  makeActor: () => Promise<Actor>;
}

export type RunRegressionCaptureResult =
  | { recordingPath: string; metaPath: string }
  | { skipped: "flaky"; rate: number };

export async function runRegressionCapture(opts: RunRegressionCaptureOptions): Promise<RunRegressionCaptureResult> {
  const raw = JSON.parse(await readFile(opts.failingRecordingPath, "utf8"));
  const recording = RecordingSchema.parse(raw);

  const report = await reproduceFailure(recording, opts.makeActor, opts.attempts ?? 3);
  if (report.label === "flaky") return { skipped: "flaky", rate: report.rate };

  const reproduces = makeSingleShotReproduces(opts.makeActor, report.fingerprint);
  const minimized = await minimizeRecording(recording, reproduces);

  return commitRegression(opts.regressionsDir, opts.id, minimized, report, opts.bugSummary);
}
```

Add `"@jevitate/regression": "workspace:*"` to `packages/cli/package.json`'s `dependencies` and `{ "path": "../regression" }` to `packages/cli/tsconfig.json`'s `references`.

In `packages/cli/src/program.ts`, add a `regression` subcommand (mirroring the existing `journey`/`explore` subcommand style already in that file — a `program.command("regression").command("capture")` with `--from <file> --id <id> --dir <regressionsDir> [--attempts <n>] [--summary <text>]` options) that builds a real Playwright-backed `makeActor` from the CLI's browser-port wiring and calls `runRegressionCapture`, printing the result via the existing `emitJson` helper.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/cli/src/regression-api.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/regression-api.ts packages/cli/src/regression-api.test.ts packages/cli/package.json packages/cli/tsconfig.json packages/cli/src/program.ts
git commit -m "$(cat <<'EOF'
feat(cli): additive `regression capture` command

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

**Acceptance:** `jevitate regression capture --from <failing-recording.json> --id <id> --dir <regressions-dir>` reproduces, minimizes, and commits a regression artifact (or reports `flaky` and commits nothing); `pnpm exec vitest run packages/regression` and the CLI tests pass on fakes; the invariant contract holds.

## Open product decision (flagged, not resolved here)

Per issue #5: **direct `Recording → Playwright` export is not built by this plan.** The committed artifact is the `Recording` itself, replayed by `regression-suite.ts` via the existing interpreter — this is what "deterministic, replayable" means today. Adding a Playwright `.spec.ts` emitter (to match the site's current "generated Playwright test" copy) is a separate, later decision noted here for visibility, not scoped into this plan.

## Self-review

- **Spec coverage:** reproduction + retry (Task 2) ✅; minimization preserving repro at each step (Task 3, Task 6 #2) ✅; deterministic replayable artifact, fail-on-bug/pass-on-fix (Task 5 suite + committed Recording) ✅; flaky labeled/never promoted (Task 4, Task 6 #1) ✅; Playwright export explicitly left open (see above) ✅.
- **Placeholder scan:** no TODO/TBD; every step shows complete, runnable code.
- **Type consistency:** `ReproductionReport`, `FailureFingerprint`, `Reproduces`, `RegressionMeta` are defined once (Tasks 1/2/3/4) and reused verbatim in Tasks 5–7 with identical field names.
