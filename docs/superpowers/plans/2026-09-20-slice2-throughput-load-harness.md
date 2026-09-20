# Slice 2 — Throughput / Load Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a new `@doit/load` package that drives a pool of seeded, human-paced virtual actors against a Journey concurrently and emits a capacity report — measured from real runs when a real runner is available, or an honestly-labeled `modeled` estimate (via `@doit/domain`'s `simulateTiming()`) when it is not — while refusing outright to load-test any target not on an explicit authorized-origins allowlist.

**Architecture:** `@doit/load` is a small, decoupled pool-execution + aggregation library. Its core (`runLoadTest`, `modeledCapacityReport`) knows nothing about `Journey`, `Actor`, or Playwright — it only knows "call this factory to get N pool members, call `.run()` on each `iterationsPerActor` times, time it, aggregate." Callers hand it a `LoadActorRunnerFactory` closure. The one place that actually wires a real `Journey` to a real `JourneyRunner`/Playwright browser per pool member is a new, thin, additive CLI command in the existing `@doit/cli` package (which already depends on `@doit/journey`/`@doit/screenplay`/`@doit/playwright`/`@doit/runtime` — see `packages/cli/src/journey-api.ts`). This keeps `@doit/load` provably decoupled from `@doit/journey` (an explicitly off-limits package for this slice) while still delivering "a pool of actors driving a given Journey concurrently."

**Tech Stack:** TypeScript (strict, ES2022, NodeNext modules), Vitest, pnpm workspaces, `@doit/domain` (`simulateTiming`, `makeRng`, `InteractionPolicy`, `PlannedStep`), `@doit/runtime` (`JourneyRunResult`, type-only), `commander` (existing CLI, for the additive command).

**Spec:** `docs/superpowers/specs/2026-09-19-unified-journey-automation-and-testing-design.md` (§8 Throughput/Load harness, §9 hard floors #5, §9a invariants #9–#10, §10 slice roadmap row "2", §11 note "Invariants 9–10 → Slice 2").

## Global Constraints

- Node 20+, ESM (`"type": "module"`), TypeScript `strict: true`, project references (`tsc --build`) — mirror `tsconfig.base.json` exactly.
- Dependency direction is inward only: `@doit/load` depends on `@doit/domain` and `@doit/runtime` (type-only); **nothing** depends on `@doit/load` except the one additive `@doit/cli` command in Task 8.
- `@doit/load` MUST NOT import `@doit/journey`, `@doit/screenplay`, `@doit/playwright`, `@doit/ai-core`, `@doit/secrets`, or `@doit/sources`, and MUST NOT edit any file under `packages/runtime/src` or `packages/domain/src` (a sibling slice edits `journey-runner.ts` and `run-policy.ts` concurrently — consume only their current public `JourneyRunner`/`JourneyRunResult`/`RunPolicy`/`simulateTiming` surface).
- A `CapacityReport`'s `provenance` field is `"measured" | "modeled"` and is **never silently downgraded**: `runLoadTest` (the measured path) always returns `provenance: "measured"` or throws — it never internally falls back to a modeled estimate. `modeledCapacityReport` always returns `provenance: "modeled"`. No function produces one label from the other's logic.
- **Authorized-targets-only, fail-closed:** every report-producing entrypoint calls `assertAuthorizedTarget` before touching a runner factory or `simulateTiming`. An unauthorized/undeclared origin throws `UnauthorizedLoadTargetError` and nothing runs.
- Pacing (seeded per-actor timing derived from `@doit/domain`) exists for load-realism/politeness and reproducibility — **never** for bot-evasion.
- **Repo gotcha:** packages have NO `"test"` script. Run tests via `pnpm exec vitest run <path>` — never `pnpm --filter <pkg> test`.
- Git staging is explicit-path only (`git add <exact files>`), never `-A`/`.`.
- Commit trailer for every commit in this plan: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

```
packages/load/
  package.json
  tsconfig.json
  src/
    index.ts                    # barrel — grows one export per task
    percentiles.ts               # pure latency-percentile math
    percentiles.test.ts
    seeded-pool.ts                # deterministic per-actor seed derivation
    seeded-pool.test.ts
    authorized-targets.ts         # fail-closed allowlist guard (invariant #10)
    authorized-targets.test.ts
    types.ts                      # CapacityReport / Provenance / LatencyPercentiles
    measured-load-runner.ts       # runLoadTest — the "measured" path
    measured-load-runner.test.ts
    slice2-invariants.test.ts     # §9a invariant refusal contract (#9, #10)
    modeled-capacity.ts           # modeledCapacityReport — the offline "modeled" path
    modeled-capacity.test.ts

packages/cli/                     # ONE additive, flagged touch
  package.json                    # + "@doit/load": "workspace:*"
  tsconfig.json                   # + { "path": "../load" }
  src/
    load-api.ts                   # NEW — wires a real Journey to @doit/load
    load-api.test.ts              # NEW — no-browser tests (authorized-target guard)
    load-e2e.test.ts              # NEW — optional real-browser smoke test
    program.ts                    # + `load run <journeyId>` subcommand

vitest.config.ts                  # + "@doit/load" alias
tsconfig.json                     # + { "path": "packages/load" }
```

**Responsibility split:** `percentiles.ts`/`seeded-pool.ts`/`authorized-targets.ts` are small, single-purpose math/guard modules. `types.ts` holds the one shared report shape everything else produces. `measured-load-runner.ts` and `modeled-capacity.ts` are the two report producers — deliberately separate files so no import path lets one call into the other's core logic. `slice2-invariants.test.ts` is a dedicated readable contract file (mirrors `packages/runtime/src/slice1-invariants.test.ts`), re-using the fakes from `measured-load-runner.test.ts` rather than duplicating them.

---

### Task 1: Scaffold `@doit/load` + latency percentile math

**Files:**
- Create: `packages/load/package.json`
- Create: `packages/load/tsconfig.json`
- Create: `packages/load/src/index.ts`
- Create: `packages/load/src/percentiles.ts`
- Test: `packages/load/src/percentiles.test.ts`
- Modify: `tsconfig.json:1-19` (root) — add `{ "path": "packages/load" }` to `references`
- Modify: `vitest.config.ts` (root) — add `"@doit/load": pkg("load"),` alias

**Interfaces:**
- Produces: `percentile(sorted: number[], p: number): number`, `computeLatencyPercentiles(durationsMs: number[]): LatencyPercentiles` (the `LatencyPercentiles` shape is defined here so Task 4 can import it, then Task 4 also re-declares it in `types.ts` — see Task 4 note on where the canonical definition lives).

- [ ] **Step 1: Create the package manifest**

`packages/load/package.json`:
```json
{
  "name": "@doit/load",
  "version": "0.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js"
  },
  "dependencies": {
    "@doit/domain": "workspace:*",
    "@doit/runtime": "workspace:*"
  },
  "scripts": { "build": "tsc --build" }
}
```

- [ ] **Step 2: Create the tsconfig**

`packages/load/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "references": [{ "path": "../domain" }, { "path": "../runtime" }],
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 3: Register the package in the root tsconfig and vitest config**

In `tsconfig.json` (root), add `{ "path": "packages/load" }` to the `references` array (any position; alphabetical-ish placement near `"packages/journey"` is fine).

In `vitest.config.ts` (root), add one alias line inside `resolve.alias`, next to the `@doit/runtime` line:
```ts
      "@doit/load": pkg("load"),
```

- [ ] **Step 4: Write the failing test for percentile math**

`packages/load/src/percentiles.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { percentile, computeLatencyPercentiles } from "./percentiles.js";

describe("percentile", () => {
  it("returns the nearest-rank value for a sorted array", () => {
    const sorted = [10, 20, 30, 40, 50];
    expect(percentile(sorted, 50)).toBe(30);
    expect(percentile(sorted, 100)).toBe(50);
    expect(percentile(sorted, 1)).toBe(10);
  });

  it("returns 0 for an empty array", () => {
    expect(percentile([], 50)).toBe(0);
  });
});

describe("computeLatencyPercentiles", () => {
  it("computes p50/p95/p99/mean/min/max over unsorted input", () => {
    const durations = [50, 10, 30, 20, 40];
    const stats = computeLatencyPercentiles(durations);
    expect(stats.minMs).toBe(10);
    expect(stats.maxMs).toBe(50);
    expect(stats.meanMs).toBe(30);
    expect(stats.p50Ms).toBe(30);
  });

  it("returns all-zero stats for an empty array (never throws on no data)", () => {
    expect(computeLatencyPercentiles([])).toEqual({
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      meanMs: 0,
      minMs: 0,
      maxMs: 0,
    });
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm exec vitest run packages/load/src/percentiles.test.ts`
Expected: FAIL — `Cannot find module './percentiles.js'` (file does not exist yet).

- [ ] **Step 6: Implement `percentiles.ts`**

`packages/load/src/percentiles.ts`:
```ts
export interface LatencyPercentiles {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
}

/** Nearest-rank percentile over an already-sorted-ascending array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function computeLatencyPercentiles(durationsMs: number[]): LatencyPercentiles {
  if (durationsMs.length === 0) {
    return { p50Ms: 0, p95Ms: 0, p99Ms: 0, meanMs: 0, minMs: 0, maxMs: 0 };
  }
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    meanMs: sum / sorted.length,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
  };
}
```

- [ ] **Step 7: Create the barrel**

`packages/load/src/index.ts`:
```ts
export * from "./percentiles.js";
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm exec vitest run packages/load/src/percentiles.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 9: Commit**

```bash
git add packages/load/package.json packages/load/tsconfig.json packages/load/src/index.ts packages/load/src/percentiles.ts packages/load/src/percentiles.test.ts tsconfig.json vitest.config.ts
git commit -m "$(cat <<'EOF'
feat(load): scaffold @doit/load package + latency percentile math

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Seeded per-actor RNG derivation

**Files:**
- Create: `packages/load/src/seeded-pool.ts`
- Test: `packages/load/src/seeded-pool.test.ts`
- Modify: `packages/load/src/index.ts`

**Interfaces:**
- Consumes: `makeRng(seed: number): () => number` from `@doit/domain`.
- Produces: `deriveActorSeeds(masterSeed: number, count: number): number[]` — used by Task 4 (`measured-load-runner.ts`) and Task 6 (`modeled-capacity.ts`) to give each pool member its own reproducible sub-seed.

- [ ] **Step 1: Write the failing test**

`packages/load/src/seeded-pool.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { deriveActorSeeds } from "./seeded-pool.js";

describe("deriveActorSeeds", () => {
  it("returns `count` seeds", () => {
    expect(deriveActorSeeds(42, 5)).toHaveLength(5);
  });

  it("is deterministic: same masterSeed + count -> identical seeds every call", () => {
    expect(deriveActorSeeds(42, 5)).toEqual(deriveActorSeeds(42, 5));
  });

  it("different master seeds produce different seed lists", () => {
    expect(deriveActorSeeds(1, 3)).not.toEqual(deriveActorSeeds(2, 3));
  });

  it("produces distinct seeds within one pool (no accidental collisions for a small pool)", () => {
    const seeds = deriveActorSeeds(7, 10);
    expect(new Set(seeds).size).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/load/src/seeded-pool.test.ts`
Expected: FAIL with "Cannot find module './seeded-pool.js'".

- [ ] **Step 3: Implement `seeded-pool.ts`**

`packages/load/src/seeded-pool.ts`:
```ts
import { makeRng } from "@doit/domain";

/**
 * Derives `count` reproducible sub-seeds from one master seed, using
 * `@doit/domain`'s `makeRng` as the single deterministic RNG stream. Same
 * `masterSeed` + `count` always yields the same seed list — this is what
 * makes a load-test run replayable end to end (the master seed is the only
 * thing a caller needs to record).
 */
export function deriveActorSeeds(masterSeed: number, count: number): number[] {
  const rng = makeRng(masterSeed);
  const seeds: number[] = [];
  for (let i = 0; i < count; i++) {
    seeds.push(Math.floor(rng() * 0xffffffff) >>> 0);
  }
  return seeds;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/load/src/seeded-pool.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add to barrel**

`packages/load/src/index.ts` — add:
```ts
export * from "./seeded-pool.js";
```

- [ ] **Step 6: Commit**

```bash
git add packages/load/src/seeded-pool.ts packages/load/src/seeded-pool.test.ts packages/load/src/index.ts
git commit -m "$(cat <<'EOF'
feat(load): seeded per-actor RNG derivation for replayable pools

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Authorized-targets-only guard (invariant #10)

**Files:**
- Create: `packages/load/src/authorized-targets.ts`
- Test: `packages/load/src/authorized-targets.test.ts`
- Modify: `packages/load/src/index.ts`

**Interfaces:**
- Produces: `UnauthorizedLoadTargetError extends Error`, `assertAuthorizedTarget(targetOrigin: string, authorizedOrigins: readonly string[]): void` — consumed by Task 4's `runLoadTest` and Task 6's `modeledCapacityReport`, called BEFORE either touches a runner factory or `simulateTiming`.

- [ ] **Step 1: Write the failing test**

`packages/load/src/authorized-targets.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { assertAuthorizedTarget, UnauthorizedLoadTargetError } from "./authorized-targets.js";

describe("assertAuthorizedTarget", () => {
  it("does not throw when the target origin is in the allowlist", () => {
    expect(() => assertAuthorizedTarget("https://example.com", ["https://example.com"])).not.toThrow();
  });

  it("throws UnauthorizedLoadTargetError when the origin is absent from the allowlist", () => {
    expect(() => assertAuthorizedTarget("https://evil.example.com", ["https://example.com"])).toThrow(
      UnauthorizedLoadTargetError,
    );
  });

  it("throws (fail-closed) when the allowlist is empty — no implicit trust", () => {
    expect(() => assertAuthorizedTarget("https://example.com", [])).toThrow(UnauthorizedLoadTargetError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/load/src/authorized-targets.test.ts`
Expected: FAIL with "Cannot find module './authorized-targets.js'".

- [ ] **Step 3: Implement `authorized-targets.ts`**

`packages/load/src/authorized-targets.ts`:
```ts
/**
 * Invariant #10 (spec §9a): load only runs against an explicit
 * authorized-target allowlist. Fail-closed — an empty or missing allowlist
 * is a refusal, never an implicit "anything goes".
 */
export class UnauthorizedLoadTargetError extends Error {}

export function assertAuthorizedTarget(targetOrigin: string, authorizedOrigins: readonly string[]): void {
  if (!authorizedOrigins.includes(targetOrigin)) {
    throw new UnauthorizedLoadTargetError(
      `refusing to load-test '${targetOrigin}' — not in the authorized-origins allowlist ` +
        `[${authorizedOrigins.join(", ")}]`,
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/load/src/authorized-targets.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add to barrel**

`packages/load/src/index.ts` — add:
```ts
export * from "./authorized-targets.js";
```

- [ ] **Step 6: Commit**

```bash
git add packages/load/src/authorized-targets.ts packages/load/src/authorized-targets.test.ts packages/load/src/index.ts
git commit -m "$(cat <<'EOF'
feat(load): fail-closed authorized-targets-only guard (invariant #10)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `runLoadTest` — the measured pool driver

**Files:**
- Create: `packages/load/src/types.ts`
- Create: `packages/load/src/measured-load-runner.ts`
- Test: `packages/load/src/measured-load-runner.test.ts`
- Modify: `packages/load/src/index.ts`

**Interfaces:**
- Consumes: `type { JourneyRunResult } from "@doit/runtime"` (type-only — outcome is `"ok" | "quarantined"`); `deriveActorSeeds` (Task 2); `assertAuthorizedTarget` (Task 3); `computeLatencyPercentiles`, `type LatencyPercentiles` (Task 1).
- Produces (consumed by Tasks 5, 6, 8):
  - `type Provenance = "measured" | "modeled"`
  - `interface CapacityReport { provenance: Provenance; concurrency: number; seed: number; totalRuns: number; okRuns: number; quarantinedRuns: number; errorRuns: number; durationMs: number; throughputPerSecond: number; latency: LatencyPercentiles; startedAtIso?: string; endedAtIso?: string }`
  - `interface LoadActorRunner { run(): Promise<JourneyRunResult> }`
  - `type LoadActorRunnerFactory = (actorIndex: number, seed: number) => LoadActorRunner | Promise<LoadActorRunner>`
  - `interface RunLoadTestConfig { targetOrigin: string; authorizedOrigins: readonly string[]; concurrency: number; iterationsPerActor: number; seed: number; runnerFactory: LoadActorRunnerFactory }`
  - `class LoadHarnessSetupError extends Error`
  - `async function runLoadTest(config: RunLoadTestConfig): Promise<CapacityReport>`

- [ ] **Step 1: Write the types file**

`packages/load/src/types.ts`:
```ts
import type { JourneyRunResult } from "@doit/runtime";
import type { LatencyPercentiles } from "./percentiles.js";

/**
 * `"measured"` = derived from real `runLoadTest` executions.
 * `"modeled"` = derived from the offline `simulateTiming()` estimate.
 * NEVER produced by the other path's code — see `runLoadTest` and
 * `modeledCapacityReport`.
 */
export type Provenance = "measured" | "modeled";

export interface CapacityReport {
  provenance: Provenance;
  concurrency: number;
  seed: number;
  totalRuns: number;
  okRuns: number;
  quarantinedRuns: number;
  errorRuns: number;
  durationMs: number;
  throughputPerSecond: number;
  latency: LatencyPercentiles;
  /** Wall-clock bounds of the real run. Absent for `modeled` reports — there is no real clock to bound. */
  startedAtIso?: string;
  endedAtIso?: string;
}

/** One pool member's ability to run one Journey iteration. Callers (e.g. the CLI's load-api.ts) implement this over a real JourneyRunner + browser session. */
export interface LoadActorRunner {
  run(): Promise<JourneyRunResult>;
}

export type LoadActorRunnerFactory = (
  actorIndex: number,
  seed: number,
) => LoadActorRunner | Promise<LoadActorRunner>;
```

- [ ] **Step 2: Write the failing test**

`packages/load/src/measured-load-runner.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { runLoadTest, LoadHarnessSetupError } from "./measured-load-runner.js";
import type { LoadActorRunner, LoadActorRunnerFactory } from "./types.js";

function fakeRunnerFactory(outcomes: Array<"ok" | "quarantined" | "throw">): LoadActorRunnerFactory {
  let i = 0;
  return () => {
    const runner: LoadActorRunner = {
      run: vi.fn().mockImplementation(async () => {
        const outcome = outcomes[i % outcomes.length];
        i++;
        if (outcome === "throw") throw new Error("boom");
        return outcome === "ok" ? { outcome: "ok", output: {} } : { outcome: "quarantined", reason: "x" };
      }),
    };
    return runner;
  };
}

describe("runLoadTest", () => {
  it("aggregates ok/quarantined/error counts, returns provenance 'measured'", async () => {
    const factory = fakeRunnerFactory(["ok", "ok", "quarantined", "throw"]);
    const report = await runLoadTest({
      targetOrigin: "https://example.com",
      authorizedOrigins: ["https://example.com"],
      concurrency: 2,
      iterationsPerActor: 2,
      seed: 1,
      runnerFactory: factory,
    });
    expect(report.provenance).toBe("measured");
    expect(report.totalRuns).toBe(4);
    expect(report.okRuns).toBe(2);
    expect(report.quarantinedRuns).toBe(1);
    expect(report.errorRuns).toBe(1);
    expect(report.concurrency).toBe(2);
    expect(report.seed).toBe(1);
    expect(report.startedAtIso).toBeDefined();
    expect(report.endedAtIso).toBeDefined();
    expect(report.latency.minMs).toBeGreaterThanOrEqual(0);
  });

  it("calls the runner factory once per actor, run() iterationsPerActor times per actor", async () => {
    const factoryFn = vi.fn(fakeRunnerFactory(["ok"]));
    await runLoadTest({
      targetOrigin: "https://example.com",
      authorizedOrigins: ["https://example.com"],
      concurrency: 3,
      iterationsPerActor: 4,
      seed: 1,
      runnerFactory: factoryFn,
    });
    expect(factoryFn).toHaveBeenCalledTimes(3);
  });

  it("rejects the whole run (does not swallow) when a runner factory itself fails to set up", async () => {
    const factory: LoadActorRunnerFactory = () => {
      throw new Error("no browser available");
    };
    await expect(
      runLoadTest({
        targetOrigin: "https://example.com",
        authorizedOrigins: ["https://example.com"],
        concurrency: 1,
        iterationsPerActor: 1,
        seed: 1,
        runnerFactory: factory,
      }),
    ).rejects.toBeInstanceOf(LoadHarnessSetupError);
  });

  it("refuses an unauthorized target before calling the runner factory at all", async () => {
    const factoryFn = vi.fn(fakeRunnerFactory(["ok"]));
    await expect(
      runLoadTest({
        targetOrigin: "https://evil.example.com",
        authorizedOrigins: ["https://example.com"],
        concurrency: 1,
        iterationsPerActor: 1,
        seed: 1,
        runnerFactory: factoryFn,
      }),
    ).rejects.toThrow(/authorized-origins/);
    expect(factoryFn).not.toHaveBeenCalled();
  });

  it("rejects a non-positive concurrency or iterationsPerActor", async () => {
    const factoryFn = vi.fn(fakeRunnerFactory(["ok"]));
    await expect(
      runLoadTest({
        targetOrigin: "https://example.com",
        authorizedOrigins: ["https://example.com"],
        concurrency: 0,
        iterationsPerActor: 1,
        seed: 1,
        runnerFactory: factoryFn,
      }),
    ).rejects.toBeInstanceOf(LoadHarnessSetupError);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm exec vitest run packages/load/src/measured-load-runner.test.ts`
Expected: FAIL with "Cannot find module './measured-load-runner.js'".

- [ ] **Step 4: Implement `measured-load-runner.ts`**

`packages/load/src/measured-load-runner.ts`:
```ts
import { assertAuthorizedTarget } from "./authorized-targets.js";
import { deriveActorSeeds } from "./seeded-pool.js";
import { computeLatencyPercentiles } from "./percentiles.js";
import type { CapacityReport, RunLoadTestConfigShape } from "./types.js";
import type { LoadActorRunnerFactory } from "./types.js";

export interface RunLoadTestConfig {
  targetOrigin: string;
  authorizedOrigins: readonly string[];
  concurrency: number;
  iterationsPerActor: number;
  seed: number;
  runnerFactory: LoadActorRunnerFactory;
}

/** Thrown when the harness itself cannot even start a pool member (e.g. no real browser/target available). Distinct from a per-iteration failure (counted as `errorRuns`) — a setup failure aborts the WHOLE run rather than under-reporting it. This is the invariant #9 refusal: never silently substitute a modeled number for a run that could not actually happen. */
export class LoadHarnessSetupError extends Error {}

export async function runLoadTest(config: RunLoadTestConfig): Promise<CapacityReport> {
  assertAuthorizedTarget(config.targetOrigin, config.authorizedOrigins); // #10 — before ANYTHING else

  if (config.concurrency < 1 || config.iterationsPerActor < 1) {
    throw new LoadHarnessSetupError("concurrency and iterationsPerActor must each be >= 1");
  }

  const seeds = deriveActorSeeds(config.seed, config.concurrency);
  const startedAtIso = new Date().toISOString();
  const startedAtMs = Date.now();

  const durations: number[] = [];
  let okRuns = 0;
  let quarantinedRuns = 0;
  let errorRuns = 0;

  await Promise.all(
    seeds.map(async (actorSeed, actorIndex) => {
      let runner: Awaited<ReturnType<LoadActorRunnerFactory>>;
      try {
        runner = await config.runnerFactory(actorIndex, actorSeed);
      } catch (err) {
        // #9: a setup failure is fatal to the whole report — never caught
        // higher up and papered over with a modeled estimate.
        throw new LoadHarnessSetupError(
          `actor ${actorIndex} runner setup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      for (let i = 0; i < config.iterationsPerActor; i++) {
        const iterationStartMs = Date.now();
        try {
          const result = await runner.run();
          durations.push(Date.now() - iterationStartMs);
          if (result.outcome === "ok") okRuns++;
          else quarantinedRuns++;
        } catch {
          errorRuns++;
        }
      }
    }),
  );

  const endedAtIso = new Date().toISOString();
  const durationMs = Date.now() - startedAtMs;
  const totalRuns = okRuns + quarantinedRuns + errorRuns;

  return {
    provenance: "measured",
    concurrency: config.concurrency,
    seed: config.seed,
    totalRuns,
    okRuns,
    quarantinedRuns,
    errorRuns,
    durationMs,
    throughputPerSecond: durationMs > 0 ? (totalRuns * 1000) / durationMs : 0,
    latency: computeLatencyPercentiles(durations),
    startedAtIso,
    endedAtIso,
  };
}
```

Note: drop the unused `RunLoadTestConfigShape` import — `types.ts` (Step 1 above) does not export that name. Only import what Step 1 actually defines:
```ts
import type { CapacityReport, LoadActorRunnerFactory } from "./types.js";
```
(Replace the two-line type import at the top of the file with this single line before running the test.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run packages/load/src/measured-load-runner.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Add to barrel**

`packages/load/src/index.ts` — add:
```ts
export * from "./types.js";
export * from "./measured-load-runner.js";
```

- [ ] **Step 7: Commit**

```bash
git add packages/load/src/types.ts packages/load/src/measured-load-runner.ts packages/load/src/measured-load-runner.test.ts packages/load/src/index.ts
git commit -m "$(cat <<'EOF'
feat(load): runLoadTest — measured pool driver + capacity aggregation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Slice 2 §9a invariant refusal contract (#9, #10)

**Files:**
- Create: `packages/load/src/slice2-invariants.test.ts`

**Interfaces:**
- Consumes: `runLoadTest`, `LoadHarnessSetupError` (Task 4); `UnauthorizedLoadTargetError` (Task 3). No new production code — this file re-asserts, as one readable contract, behavior already implemented in Tasks 3–4 (mirrors `packages/runtime/src/slice1-invariants.test.ts`'s convention).

- [ ] **Step 1: Write the contract test file**

`packages/load/src/slice2-invariants.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { runLoadTest, LoadHarnessSetupError } from "./measured-load-runner.js";
import { UnauthorizedLoadTargetError } from "./authorized-targets.js";
import type { LoadActorRunnerFactory } from "./types.js";

/**
 * Slice 2 §9a — invariant refusal contract.
 *
 * Re-asserts invariants #9 and #10 (spec §9a) in one readable place. Adds NO
 * new production logic — `measured-load-runner.test.ts` and
 * `authorized-targets.test.ts` remain the exhaustive unit-test sources of
 * truth; this file exists so a reviewer can read one file and see both
 * invariants refuse.
 */
describe("Slice 2 §9a — invariant refusal contract", () => {
  it("#9 a real run that cannot even start ERRORS — never silently returns a 'modeled' report labeled measured", async () => {
    const unavailableRunnerFactory: LoadActorRunnerFactory = () => {
      throw new Error("no real browser/target available");
    };

    const outcome = await runLoadTest({
      targetOrigin: "https://example.com",
      authorizedOrigins: ["https://example.com"],
      concurrency: 1,
      iterationsPerActor: 1,
      seed: 1,
      runnerFactory: unavailableRunnerFactory,
    }).then(
      (report) => ({ settled: "resolved" as const, report }),
      (err) => ({ settled: "rejected" as const, err }),
    );

    expect(outcome.settled).toBe("rejected");
    if (outcome.settled === "rejected") {
      expect(outcome.err).toBeInstanceOf(LoadHarnessSetupError);
    }
    // The critical assertion: there is no world in which this call
    // *resolves* with `{ provenance: "modeled" }` — it either measures for
    // real or it throws. No third option.
  });

  it("#10 an unauthorized target is refused before any pool member is even created", async () => {
    const runnerFactory = vi.fn<LoadActorRunnerFactory>(() => {
      throw new Error("should never be reached");
    });

    await expect(
      runLoadTest({
        targetOrigin: "https://unauthorized.example.com",
        authorizedOrigins: ["https://example.com"],
        concurrency: 5,
        iterationsPerActor: 3,
        seed: 1,
        runnerFactory,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedLoadTargetError);
    expect(runnerFactory).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it passes (no new implementation — this proves Tasks 3–4 already satisfy it)**

Run: `pnpm exec vitest run packages/load/src/slice2-invariants.test.ts`
Expected: PASS (2 tests). If either fails, the bug is in Task 3 or Task 4's implementation — fix there, not by relaxing this file.

- [ ] **Step 3: Commit**

```bash
git add packages/load/src/slice2-invariants.test.ts
git commit -m "$(cat <<'EOF'
test(load): Slice 2 §9a invariant refusal contract (#9 provenance honesty, #10 authorized-only)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `modeledCapacityReport` — offline `simulateTiming()` estimate

**Files:**
- Create: `packages/load/src/modeled-capacity.ts`
- Test: `packages/load/src/modeled-capacity.test.ts`
- Modify: `packages/load/src/index.ts`

**Interfaces:**
- Consumes: `simulateTiming`, `type { InteractionPolicy, PlannedStep }` from `@doit/domain`; `deriveActorSeeds` (Task 2); `computeLatencyPercentiles` (Task 1); `assertAuthorizedTarget` (Task 3); `type CapacityReport` (Task 4).
- Produces: `interface RunModeledCapacityConfig { targetOrigin: string; authorizedOrigins: readonly string[]; concurrency: number; iterationsPerActor: number; seed: number; policy: InteractionPolicy; script: PlannedStep[] }`, `function modeledCapacityReport(config: RunModeledCapacityConfig): CapacityReport` (synchronous — `simulateTiming` is pure/sync).

- [ ] **Step 1: Write the failing test**

`packages/load/src/modeled-capacity.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { modeledCapacityReport } from "./modeled-capacity.js";
import { UnauthorizedLoadTargetError } from "./authorized-targets.js";
import type { InteractionPolicy, PlannedStep } from "@doit/domain";

const policy: InteractionPolicy = {
  typing: { charsPerSecond: 5, perKeyJitter: 0.1 },
  thinkBeforeActionMs: { mean: 200, sd: 50 },
  interInteractionMs: { mean: 100, sd: 20 },
};
const script: PlannedStep[] = [
  { kind: "navigate", label: "open" },
  { kind: "type", label: "email", text: "a@b.com" },
  { kind: "click", label: "submit" },
];

describe("modeledCapacityReport", () => {
  it("returns provenance 'modeled' and totalRuns = concurrency * iterationsPerActor", () => {
    const report = modeledCapacityReport({
      targetOrigin: "https://example.com",
      authorizedOrigins: ["https://example.com"],
      concurrency: 3,
      iterationsPerActor: 2,
      seed: 42,
      policy,
      script,
    });
    expect(report.provenance).toBe("modeled");
    expect(report.totalRuns).toBe(6);
    expect(report.okRuns).toBe(6);
    expect(report.quarantinedRuns).toBe(0);
    expect(report.errorRuns).toBe(0);
    expect(report.startedAtIso).toBeUndefined(); // no real clock to bound
    expect(report.latency.meanMs).toBeGreaterThan(0);
    expect(report.throughputPerSecond).toBeGreaterThan(0);
  });

  it("is fully deterministic given the same seed", () => {
    const config = {
      targetOrigin: "https://example.com",
      authorizedOrigins: ["https://example.com"],
      concurrency: 4,
      iterationsPerActor: 3,
      seed: 7,
      policy,
      script,
    };
    expect(modeledCapacityReport(config)).toEqual(modeledCapacityReport(config));
  });

  it("refuses an unauthorized target — the offline/modeled path is NOT an escape hatch around invariant #10", () => {
    expect(() =>
      modeledCapacityReport({
        targetOrigin: "https://unauthorized.example.com",
        authorizedOrigins: ["https://example.com"],
        concurrency: 1,
        iterationsPerActor: 1,
        seed: 1,
        policy,
        script,
      }),
    ).toThrow(UnauthorizedLoadTargetError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/load/src/modeled-capacity.test.ts`
Expected: FAIL with "Cannot find module './modeled-capacity.js'".

- [ ] **Step 3: Implement `modeled-capacity.ts`**

`packages/load/src/modeled-capacity.ts`:
```ts
import { simulateTiming, type InteractionPolicy, type PlannedStep } from "@doit/domain";
import { assertAuthorizedTarget } from "./authorized-targets.js";
import { deriveActorSeeds } from "./seeded-pool.js";
import { computeLatencyPercentiles } from "./percentiles.js";
import type { CapacityReport } from "./types.js";

export interface RunModeledCapacityConfig {
  targetOrigin: string;
  authorizedOrigins: readonly string[];
  concurrency: number;
  iterationsPerActor: number;
  seed: number;
  policy: InteractionPolicy;
  script: PlannedStep[];
}

/**
 * Offline estimate, reusing `@doit/domain`'s `simulateTiming()` — used when
 * a real browser/target is not available. ALWAYS returns
 * `provenance: "modeled"`; there is no code path here that returns
 * `"measured"`. See `runLoadTest` (measured-load-runner.ts) for the real
 * path — the two never call into each other.
 */
export function modeledCapacityReport(config: RunModeledCapacityConfig): CapacityReport {
  assertAuthorizedTarget(config.targetOrigin, config.authorizedOrigins); // #10 applies offline too

  if (config.concurrency < 1 || config.iterationsPerActor < 1) {
    throw new RangeError("concurrency and iterationsPerActor must each be >= 1");
  }

  const seeds = deriveActorSeeds(config.seed, config.concurrency);
  const durations: number[] = [];
  let maxActorTotalMs = 0;

  for (const actorSeed of seeds) {
    let actorTotalMs = 0;
    for (let i = 0; i < config.iterationsPerActor; i++) {
      // Distinct-but-deterministic seed per iteration: repeated iterations
      // by the same actor aren't identical samples, while the whole report
      // stays reproducible given `config.seed`.
      const iterationSeed = (actorSeed + i * 2654435761) >>> 0;
      const profile = simulateTiming(config.policy, iterationSeed, config.script);
      durations.push(profile.totalMs);
      actorTotalMs += profile.totalMs;
    }
    maxActorTotalMs = Math.max(maxActorTotalMs, actorTotalMs);
  }

  const totalRuns = config.concurrency * config.iterationsPerActor;

  return {
    provenance: "modeled",
    concurrency: config.concurrency,
    seed: config.seed,
    totalRuns,
    okRuns: totalRuns,
    quarantinedRuns: 0,
    errorRuns: 0,
    durationMs: maxActorTotalMs,
    throughputPerSecond: maxActorTotalMs > 0 ? (totalRuns * 1000) / maxActorTotalMs : 0,
    latency: computeLatencyPercentiles(durations),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/load/src/modeled-capacity.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add to barrel**

`packages/load/src/index.ts` — add:
```ts
export * from "./modeled-capacity.js";
```

- [ ] **Step 6: Commit**

```bash
git add packages/load/src/modeled-capacity.ts packages/load/src/modeled-capacity.test.ts packages/load/src/index.ts
git commit -m "$(cat <<'EOF'
feat(load): modeledCapacityReport — offline simulateTiming()-based estimate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Build check — `@doit/load` type-checks standalone

**Files:**
- Modify: none (verification-only task)

**Interfaces:** none new.

- [ ] **Step 1: Build the package graph**

Run: `pnpm --filter @doit/load build` (this is `tsc --build`, not the forbidden `test` script — building is fine per the repo gotcha, only `pnpm --filter <pkg> test` is forbidden)
Expected: succeeds, emits `packages/load/dist/*.js` + `.d.ts`.

- [ ] **Step 2: Run the full `@doit/load` test suite together**

Run: `pnpm exec vitest run packages/load`
Expected: all tests from Tasks 1–6 PASS together (catches any cross-file import mistakes the per-file runs above didn't).

- [ ] **Step 3: Commit (only if Step 1 required a fix; otherwise skip — nothing to commit)**

If `tsc --build` surfaced a type error, fix it, re-run Steps 1–2, then:
```bash
git add packages/load
git commit -m "$(cat <<'EOF'
fix(load): type-check fixes surfaced by tsc --build

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Additive CLI wiring — `load run <journeyId>` (the one allowed touch to an existing package)

> **FLAG: this task edits `packages/cli`, an existing package.** Per the orthogonality constraint this is the *only* allowed edit to an existing package's source in this slice — it is additive only (one new file, one new subcommand, one new dependency line) and does not change any existing `journey`/`recording`/`site` command's behavior.

**Files:**
- Create: `packages/cli/src/load-api.ts`
- Test: `packages/cli/src/load-api.test.ts`
- Modify: `packages/cli/package.json` — add `"@doit/load": "workspace:*"` to `dependencies`
- Modify: `packages/cli/tsconfig.json` — add `{ "path": "../load" }` to `references`
- Modify: `packages/cli/src/program.ts` — add a `load` command group with one `run <journeyId>` subcommand

**Interfaces:**
- Consumes: `runLoadTest`, `type { CapacityReport, LoadActorRunner }` from `@doit/load`; `FsJourneyStore`, `JourneyRegistry` from `@doit/journey`; `safeRunPolicy`, `type RunPolicy` from `@doit/domain`; `PlaywrightBrowserPort` from `@doit/playwright`; `CastActor`, `BrowseTheWeb` from `@doit/screenplay`; `RecordingInterpreter` from `@doit/interpreter`; `JourneyRunner` from `@doit/runtime`.
- Produces: `class UnknownLoadJourneyError extends Error`, `interface RunJourneyLoadTestOptions { dir: string; id: string; params: Record<string, string>; concurrency: number; iterationsPerActor: number; seed: number; authorizedOrigins: readonly string[]; policy?: RunPolicy }`, `async function runJourneyLoadTest(opts: RunJourneyLoadTestOptions): Promise<CapacityReport>`.

- [ ] **Step 1: Write the failing no-browser test (authorized-target enforcement, no Playwright needed)**

`packages/cli/src/load-api.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, JourneyRegistry } from "@doit/journey";
import { UnauthorizedLoadTargetError } from "@doit/load";
import { runJourneyLoadTest, UnknownLoadJourneyError } from "./load-api.js";

async function seedJourney(dir: string) {
  const store = new FsJourneyStore(dir);
  const registry = new JourneyRegistry(store);
  await registry.put({
    metadata: {
      id: "checkout",
      name: "checkout",
      promoted: true,
      params: [],
      createdAtIso: "2026-09-20T00:00:00Z",
    },
    recording: { version: "1", site: "https://example.com", pages: [] },
  } as any);
}

describe("runJourneyLoadTest", () => {
  it("throws UnauthorizedLoadTargetError before opening any browser when the journey's site is not authorized", async () => {
    const dir = await mkdtemp(join(tmpdir(), "load-api-"));
    await seedJourney(dir);

    await expect(
      runJourneyLoadTest({
        dir,
        id: "checkout",
        params: {},
        concurrency: 1,
        iterationsPerActor: 1,
        seed: 1,
        authorizedOrigins: ["https://some-other-origin.example.com"],
      }),
    ).rejects.toBeInstanceOf(UnauthorizedLoadTargetError);
  });

  it("throws UnknownLoadJourneyError for an unknown journey id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "load-api-"));

    await expect(
      runJourneyLoadTest({
        dir,
        id: "does-not-exist",
        params: {},
        concurrency: 1,
        iterationsPerActor: 1,
        seed: 1,
        authorizedOrigins: ["https://example.com"],
      }),
    ).rejects.toBeInstanceOf(UnknownLoadJourneyError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/cli/src/load-api.test.ts`
Expected: FAIL with "Cannot find module './load-api.js'".

- [ ] **Step 3: Add the `@doit/load` dependency**

`packages/cli/package.json` — add one line to `dependencies` (keep alphabetical, next to `"@doit/journey"`):
```json
    "@doit/load": "workspace:*",
```

`packages/cli/tsconfig.json` — add one line to `references` (next to `"../journey"`):
```json
    { "path": "../load" },
```

- [ ] **Step 4: Implement `load-api.ts`**

`packages/cli/src/load-api.ts`:
```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, JourneyRegistry, deriveParamSchema, validateParams } from "@doit/journey";
import { safeRunPolicy, type RunPolicy } from "@doit/domain";
import { PlaywrightBrowserPort } from "@doit/playwright";
import { CastActor, BrowseTheWeb } from "@doit/screenplay";
import { RecordingInterpreter } from "@doit/interpreter";
import { JourneyRunner } from "@doit/runtime";
import { runLoadTest, type CapacityReport, type LoadActorRunner } from "@doit/load";

/** Distinct from `@doit/journey`'s ParamValidationError-style "unknown id" cases elsewhere, so CLI callers can branch without string-matching. */
export class UnknownLoadJourneyError extends Error {}

export interface RunJourneyLoadTestOptions {
  dir: string;
  id: string;
  params: Record<string, string>;
  concurrency: number;
  iterationsPerActor: number;
  seed: number;
  authorizedOrigins: readonly string[];
  /** Defaults to `safeRunPolicy()`, same convention as `journey-api.ts`'s `runJourneyProgrammatically`. */
  policy?: RunPolicy;
}

/**
 * The programmatic surface behind `brauto load run` — resolves a published
 * Journey (unknown id -> `UnknownLoadJourneyError`), validates params UP
 * FRONT, then hands `@doit/load`'s `runLoadTest` a factory that opens ONE
 * real headless Playwright session + `JourneyRunner` per pool member. The
 * authorized-target check happens inside `runLoadTest` itself — this
 * function does not duplicate or bypass it.
 */
export async function runJourneyLoadTest(opts: RunJourneyLoadTestOptions): Promise<CapacityReport> {
  const store = new FsJourneyStore(opts.dir);
  const registry = new JourneyRegistry(store);

  const journey = await registry.get(opts.id);
  if (!journey) {
    throw new UnknownLoadJourneyError(`unknown journey '${opts.id}'`);
  }

  validateParams(deriveParamSchema(journey.recording), opts.params);

  const policy = opts.policy ?? safeRunPolicy();

  return runLoadTest({
    targetOrigin: journey.recording.site,
    authorizedOrigins: opts.authorizedOrigins,
    concurrency: opts.concurrency,
    iterationsPerActor: opts.iterationsPerActor,
    seed: opts.seed,
    runnerFactory: async (actorIndex): Promise<LoadActorRunner> => {
      const profileDir = await mkdtemp(join(tmpdir(), `doit-load-actor-${actorIndex}-`));
      const port = new PlaywrightBrowserPort();
      const session = await port.open({
        profileDir,
        headless: true,
        allowedOrigins: [journey.recording.site],
        baseUrl: journey.recording.site,
      });
      const actor = CastActor.named(`load-actor-${actorIndex}`).whoCan(
        new BrowseTheWeb(session, [journey.recording.site]),
      );
      const runner = new JourneyRunner(actor, new RecordingInterpreter());
      return {
        run: () => runner.run({ journey, params: opts.params, policy }),
      };
    },
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run packages/cli/src/load-api.test.ts`
Expected: PASS (2 tests) — neither test reaches `PlaywrightBrowserPort.open`, since both throw before the `runnerFactory` closure is ever invoked (`UnauthorizedLoadTargetError` before any actor; `UnknownLoadJourneyError` before `runLoadTest` is even called).

- [ ] **Step 6: Add the `load run` CLI subcommand**

In `packages/cli/src/program.ts`, add the import (next to the existing `journey-api.js` import):
```ts
import { runJourneyLoadTest, UnknownLoadJourneyError } from "./load-api.js";
```

Add a new `load` command group after the `journey` command block (before `return program;`):
```ts
  const load = program.command("load");

  load
    .command("run <journeyId>")
    .option("--dir <path>", "journeys directory (default: ~/.doit/journeys)")
    .option("--param <kv>", "param as key=value (repeatable)", collectParam, {} as Record<string, string>)
    .requiredOption("--authorized-origin <origin>", "allowed load-test target origin (repeatable)", (v, prev: string[]) => [...prev, v], [] as string[])
    .option("--concurrency <n>", "pool size", "1")
    .option("--iterations <n>", "iterations per actor", "1")
    .option("--seed <n>", "master RNG seed", "1")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, journeyId: string) {
      const { dir, param, authorizedOrigin, concurrency, iterations, seed, json } = this.opts<{
        dir?: string;
        param: Record<string, string>;
        authorizedOrigin: string[];
        concurrency: string;
        iterations: string;
        seed: string;
        json?: boolean;
      }>();
      try {
        const report = await runJourneyLoadTest({
          dir: resolveJourneysDir(deps, dir),
          id: journeyId,
          params: param,
          concurrency: Number(concurrency),
          iterationsPerActor: Number(iterations),
          seed: Number(seed),
          authorizedOrigins: authorizedOrigin,
        });
        const envelope = ok(report);
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.(`${JSON.stringify(report, null, 2)}\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        if (err instanceof UnknownLoadJourneyError) {
          emitJson(program, fail("E_UNKNOWN_JOURNEY", String(err.message)));
        } else {
          emitJson(program, fail("E_LOAD_RUN", String(err instanceof Error ? err.message : err)));
        }
      }
    });
```

- [ ] **Step 7: Run the full CLI test suite to confirm no regression**

Run: `pnpm exec vitest run packages/cli`
Expected: all existing `packages/cli` tests still PASS, plus the 2 new `load-api.test.ts` tests.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/package.json packages/cli/tsconfig.json packages/cli/src/load-api.ts packages/cli/src/load-api.test.ts packages/cli/src/program.ts
git commit -m "$(cat <<'EOF'
feat(cli): additive `load run` command — wires @doit/load to a real Journey + Playwright pool

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9 (optional): Real-browser load smoke test

**Files:**
- Create: `packages/cli/src/load-e2e.test.ts`

**Interfaces:** none new — exercises `runJourneyLoadTest` (Task 8) end to end against `@doit/example-site` (the same fixture app `packages/runtime/src/journey-login-e2e.test.ts` uses).

> This task is optional (spec: "an optional real-browser smoke test can be a separate task") and may be skipped without blocking the exit gate — but if included, it is the one place that proves the whole pipeline (`@doit/load` + `@doit/cli`'s wiring + a real headless Playwright session) actually produces a `measured` report from a real run.

- [ ] **Step 1: Write the smoke test**

`packages/cli/src/load-e2e.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "@doit/example-site";
import { runJourneyLoadTest } from "./load-api.js";

/**
 * Minimal real-browser smoke test: a login Journey against a real (local,
 * ephemeral) example-site instance, run through the FULL `load run` pipeline
 * with a small pool. Mirrors `packages/runtime/src/journey-login-e2e.test.ts`
 * in spirit — a real headless Playwright session, not a fake.
 */
describe("load run — real-browser smoke test", () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let baseUrl: string;
  let journeysDir: string;

  beforeAll(async () => {
    server = await startServer({ port: 0 });
    baseUrl = server.url;
    journeysDir = await mkdtemp(join(tmpdir(), "load-e2e-journeys-"));
    // A trivial no-login journey (single navigate step) is enough to prove
    // the pool/pipeline end to end without re-deriving a full RxD fixture —
    // the login-specific handback path is already covered by
    // journey-login-e2e.test.ts and is out of scope for the LOAD harness.
    await writeFile(
      join(journeysDir, "home.json"),
      JSON.stringify({
        metadata: { id: "home", name: "home", promoted: true, params: [], createdAtIso: "2026-09-20T00:00:00Z" },
        recording: {
          version: "1",
          site: baseUrl,
          pages: [{ url: baseUrl, steps: [{ step: { kind: "navigate", url: baseUrl } }] }],
        },
      }),
      "utf8",
    );
  });

  afterAll(async () => {
    await server.close();
  });

  it(
    "produces a measured CapacityReport for a 2-actor, 1-iteration pool",
    async () => {
      const report = await runJourneyLoadTest({
        dir: journeysDir,
        id: "home",
        params: {},
        concurrency: 2,
        iterationsPerActor: 1,
        seed: 1,
        authorizedOrigins: [baseUrl],
      });
      expect(report.provenance).toBe("measured");
      expect(report.totalRuns).toBe(2);
      expect(report.okRuns + report.quarantinedRuns + report.errorRuns).toBe(2);
    },
    30_000,
  );
});
```

- [ ] **Step 2: Run the smoke test**

Run: `pnpm exec vitest run packages/cli/src/load-e2e.test.ts`
Expected: PASS. If the fixture Recording shape doesn't line up with the real `Recording`/`RecordedStep` schema in `@doit/recording` (the exact `pages[].steps[].step` shape may differ slightly from this sketch), adjust the fixture to match `RecordingSchema` from `packages/recording/src/schema.ts` — the schema is the source of truth, not this test file.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/src/load-e2e.test.ts
git commit -m "$(cat <<'EOF'
test(cli): optional real-browser smoke test for load run pipeline

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Exit gate

**Files:** none (verification-only task).

- [ ] **Step 1: Run the full new-code test suite**

Run: `pnpm exec vitest run packages/load packages/cli`
Expected: all tests PASS, including both `slice2-invariants.test.ts` cases and (if Task 9 was done) the real-browser smoke test.

- [ ] **Step 2: Run the whole repo's test suite (confirm no regression to sibling packages)**

Run: `pnpm exec vitest run`
Expected: PASS repo-wide. (If a sibling slice's concurrent edits to `journey-runner.ts`/`run-policy.ts` are mid-flight and cause unrelated failures elsewhere, that is out of this slice's scope — confirm specifically that every `packages/load/**` and `packages/cli/**` test passes.)

- [ ] **Step 3: Run the permissive-fallback exit gate**

Run: `node scripts/check-no-permissive-fallback.mjs`
Expected: `check-no-permissive-fallback: OK (<N> file(s) scanned, 0 hits)` — this script already walks all of `packages/*/src/**/*.ts` recursively, so it picks up `packages/load` and the new `packages/cli` files with no script changes needed. A hit here means a `catch` block or `??`/`||` default is quietly turning a failure into a fake `"ok"`/success — go fix the offending file, never edit the gate script to suppress it.

- [ ] **Step 4: Build the whole workspace**

Run: `pnpm build`
Expected: succeeds (confirms `@doit/load`'s and `@doit/cli`'s TypeScript project references are wired correctly end to end).

- [ ] **Step 5: Manual invariant checklist (read, don't skip)**

Confirm each of the following has a passing, non-skipped test somewhere in `packages/load/src/` or `packages/cli/src/`:
- [ ] Invariant #9 (report provenance honest) — `packages/load/src/slice2-invariants.test.ts`, test `"#9 ..."`.
- [ ] Invariant #10 (load only when authorized) — `packages/load/src/slice2-invariants.test.ts`, test `"#10 ..."`, AND `packages/load/src/authorized-targets.test.ts`, AND `packages/cli/src/load-api.test.ts`'s first test (the CLI-level integration of the same guard).
- [ ] `modeledCapacityReport` never returns `provenance: "measured"` and `runLoadTest` never returns `provenance: "modeled"` — true by construction (each function has exactly one literal `provenance:` assignment in its own file); confirm by grepping: `grep -n 'provenance:' packages/load/src/measured-load-runner.ts packages/load/src/modeled-capacity.ts` should show exactly one `"measured"` line and one `"modeled"` line, in their respective files only.

- [ ] **Step 6: Commit (only if Steps 1–4 required fixes; otherwise this task produces no diff)**

```bash
git add packages/load packages/cli
git commit -m "$(cat <<'EOF'
fix(load): exit-gate fixes (repo-wide test/build/permissive-fallback pass)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**
- Seeded, human-paced actor pool driving a Journey concurrently → `LoadActorRunnerFactory`/`runLoadTest` (Task 4) + real wiring in `load-api.ts` (Task 8); "human-paced" is inherited from the real `JourneyRunner`/`RunPolicy` pacing already built in Slice 1/M2.5 (`@doit/load` doesn't reinvent pacing — it drives whatever pacing the injected runner already has).
- Capacity report measured from the run (throughput, latency percentiles, error/quarantine rate) → `CapacityReport` (Task 4: `throughputPerSecond`, `latency.{p50,p95,p99,mean,min,max}Ms`, `okRuns`/`quarantinedRuns`/`errorRuns`).
- Provenance `measured | modeled`, never silently downgraded → `Provenance` type (Task 4), enforced by construction (one literal per file) + asserted by Task 5's invariant #9 test.
- Offline `simulateTiming()` fallback, clearly labeled → `modeledCapacityReport` (Task 6).
- Authorized-targets-only, fail-closed → `assertAuthorizedTarget`/`UnauthorizedLoadTargetError` (Task 3), wired into both `runLoadTest` and `modeledCapacityReport` (Tasks 4, 6), asserted by Task 5's invariant #10 test and Task 8's CLI-level integration test.
- Seeded ⇒ reproducible → `deriveActorSeeds` (Task 2), consumed by both report producers.
- CLI/programmatic surface → `runJourneyLoadTest` (programmatic, Task 8) + `load run <journeyId>` (thin CLI command, Task 8), flagged as the one allowed additive touch to `packages/cli`.
- Orthogonality (own `@doit/load` only, consume-not-edit `@doit/runtime`/`@doit/domain`, don't touch `@doit/journey`/`@doit/ai-core`/`@doit/secrets`/`@doit/sources`) → `@doit/load`'s own `package.json` (Task 1) depends only on `@doit/domain` + `@doit/runtime`; all `@doit/journey`/`@doit/screenplay`/`@doit/playwright` usage lives in `packages/cli/src/load-api.ts` (Task 8), a package that already depended on all four before this slice.

**2. Placeholder scan:** No `TBD`/`TODO`/"implement later"/"add appropriate error handling" anywhere above. Every step that touches code includes the literal file contents or an literal diff line, not a description of what to write. The one intentionally-flagged spot (Task 4 Step 4's note about dropping an unused import) is a real, exact correction, not a vague placeholder.

**3. Type consistency:** `CapacityReport`, `Provenance`, `LoadActorRunner`, `LoadActorRunnerFactory` are defined once in `packages/load/src/types.ts` (Task 4) and imported by name (never redefined ad hoc) in `measured-load-runner.ts`, `modeled-capacity.ts` (Task 6), and `packages/cli/src/load-api.ts` (Task 8). `LatencyPercentiles` is defined once in `percentiles.ts` (Task 1) and imported (not redefined) by `types.ts`. `deriveActorSeeds(masterSeed: number, count: number): number[]` (Task 2) has the identical signature everywhere it's called (Tasks 4, 6). `assertAuthorizedTarget(targetOrigin: string, authorizedOrigins: readonly string[]): void` (Task 3) has the identical signature and argument order everywhere it's called (Tasks 4, 6).
