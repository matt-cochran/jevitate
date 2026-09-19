# Slice 1 — Journey Productization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the already-built RxD recording stack into a usable product: a parameterized **`Journey`** artifact that is invokable as **one high-level MCP action** (discover → run) and via CLI/API, replayed **deterministically**, **secret-safe via visible-handback**, and **fail-closed** — with zero model dependency.

**Architecture:** A new leaf **`@doit/journey`** package wraps a parameterized `Recording` with metadata + a param-schema + a registry. A **segmented `RunPolicy`** (in `@doit/domain`) is threaded through a new **`JourneyRunner`** (in `@doit/runtime`) that validates params, drives the existing `RecordingInterpreter`, and — on a `handback` (secret) step — surfaces the headed browser to the human and **resumes only after the step's `resume` postcondition passes**. A **two-level MCP facade** (`find_capabilities` → `run_journey` + named tools) sits behind the existing allowlist boundary; CLI/API are thin faces over the same `JourneyRunner`.

**Tech Stack:** TypeScript (ESM, strict, tsc project references), pnpm workspaces, Vitest, zod. Reuses `@doit/recording`, `@doit/interpreter`, `@doit/screenplay`, `@doit/playwright`, `@doit/runtime`, `@doit/mcp-facade`, `@doit/cli`, `apps/example-site`.

**Spec:** `docs/superpowers/specs/2026-09-19-unified-journey-automation-and-testing-design.md` (§5 RunPolicy, §7 surfaces, §9/§9a invariants, §11 Slice 1). The plan argues from that spec; executors read both.

**Prerequisite (Phase A — NOT re-detailed here):** Execute `docs/superpowers/plans/2026-09-19-rxd-phase-a3b-postdoc-splice.md` to a green gate first. It produces the **parameterized Journey authoring** (postdoc → `promoteToVariable`-based `Recording`), `spliceRecording`, and the **strict two-tier signature**. This plan consumes its output; do not start Phase B until A's exit gate is green.

## Global Constraints
- Node 20+, ESM, strict TS project references; **dependency direction inward** (`@doit/journey` depends only on `@doit/recording`; `@doit/runtime` may depend on `@doit/journey`/`@doit/interpreter`/`@doit/domain`; `@doit/mcp-facade` and `@doit/cli` may depend on `@doit/journey`/`@doit/runtime`; nothing depends on `@doit/mcp-facade`). No dependency cycles — verify with `pnpm -r build`.
- **Closed schema; fail-closed; secrets never captured.** Redaction-by-default holds. In Slice 1's `visible-handback` path **our process never holds a secret value** — the human types it into the headed browser; secret steps are `handback` steps and stay redacted.
- **Fail-fast invariants (spec §9a) that land in Slice 1 — each ships with a test asserting it *throws/refuses*, and no code path may default-allow:**
  - **#1 No policy → throw:** `JourneyRunner` requires a complete `RunPolicy`; an absent/partial policy raises `PolicyEnforcementError`. Never a permissive default.
  - **#5 Unknown/missing param → reject:** params are validated against the Journey's param-schema before any step runs; missing or unknown keys throw `ParamValidationError`. `run_journey` resolves a **published id only** — never inline steps.
  - **#6 Unpromoted → invisible + uninvocable:** `find_capabilities` and named MCP tools expose only promoted Journeys.
  - **#7 Resume only on postcondition:** after a handback, the runner verifies the step's `resume` Assertion before continuing; failure/timeout → `quarantined`, never assume-success.
  - (Invariants 2–4 are Slice **1b**; 8 is Slice 6; 9–10 are Slice 2.)
- New dep/package → stage `pnpm-lock.yaml` and the new `package.json`/`tsconfig.json`. **Explicit-path staging only — never `git add -A`** (the untracked `.gitignore`/`.ignore` graft artifacts must stay out).
- Commit message trailer: a blank line then EXACTLY `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Keep the suite green after every task: `pnpm -r build && pnpm test && pnpm lint`.

## File Structure (decomposition)
- `packages/domain/src/run-policy.ts` — `RunPolicy` (segmented sub-policies) + `safeRunPolicy()`. (Leaf types; error is thrown by the runner, not here, to keep domain leaf.)
- `packages/journey/` — NEW package `@doit/journey`:
  - `src/journey.ts` — `Journey`, `JourneyMetadata`, `SecretRef` (reference only), `JourneySchema`.
  - `src/param-schema.ts` — `deriveParamSchema`, `validateParams`, `ParamValidationError`.
  - `src/store.ts` — `FsJourneyStore` (mirrors `FsRecordingStore`).
  - `src/registry.ts` — `JourneyRegistry` (list/get/put/promote/find).
  - `src/index.ts` — barrel.
- `packages/interpreter/src/interpreter.ts` — add `resumeFrom(...)`; `src/assertion.ts` — export `checkAssertion(...)` if not already public.
- `packages/runtime/src/journey-runner.ts` — `JourneyRunner`, `JourneyRunRequest`, `JourneyRunResult`, `HandbackHandler`.
- `packages/mcp-facade/src/journey-tools.ts` — `find_capabilities`, `run_journey`, named-tool listing; `src/tools.ts` — add allowed names.
- `packages/cli/src/program.ts` — `journey list|find|run` subcommands; `packages/cli/src/journey-api.ts` — programmatic API.
- `packages/runtime/src/__tests__/journey-login-e2e.test.ts` — Slice 1 acceptance (real browser).
- `packages/*/src/**/invariants.test.ts` — §9a refusal tests (may live per-package).
- `scripts/check-no-permissive-fallback.mjs` — exit-gate grep.

---

### Task 1: Segmented `RunPolicy` types + safe default (`@doit/domain`)

**Files:**
- Create: `packages/domain/src/run-policy.ts`
- Modify: `packages/domain/src/index.ts` (export)
- Test: `packages/domain/src/run-policy.test.ts`

**Interfaces:**
- Produces: `type SelfHealMode = "fail-closed" | "hybrid" | "full"`; `type Direction = "deterministic" | "jev-directed" | "goal-based"`; `type SecretMode = "vault-autofill" | "visible-handback" | "fail-closed"`; `interface RunPolicy { selfHeal: { mode: SelfHealMode }; direction: { direction: Direction }; secret: { secretMode: SecretMode } }`; `function safeRunPolicy(): RunPolicy`.

- [ ] **Step 1: Write the failing test**
```ts
// packages/domain/src/run-policy.test.ts
import { describe, it, expect } from "vitest";
import { safeRunPolicy, type RunPolicy } from "./run-policy.js";

describe("safeRunPolicy", () => {
  it("defaults to the safe policy: fail-closed self-heal, deterministic direction, fail-closed secret", () => {
    const p: RunPolicy = safeRunPolicy();
    expect(p).toEqual({
      selfHeal: { mode: "fail-closed" },
      direction: { direction: "deterministic" },
      secret: { secretMode: "fail-closed" },
    });
  });
});
```
- [ ] **Step 2: Run it and confirm it fails**
Run: `pnpm --filter @doit/domain test run-policy`
Expected: FAIL — `./run-policy.js` has no export `safeRunPolicy`.

- [ ] **Step 3: Implement minimally**
```ts
// packages/domain/src/run-policy.ts
export type SelfHealMode = "fail-closed" | "hybrid" | "full";
export type Direction = "deterministic" | "jev-directed" | "goal-based";
export type SecretMode = "vault-autofill" | "visible-handback" | "fail-closed";

export interface RunPolicy {
  selfHeal: { mode: SelfHealMode };
  direction: { direction: Direction };
  secret: { secretMode: SecretMode };
}

/** The only blessed default. It is SAFE, never permissive. */
export function safeRunPolicy(): RunPolicy {
  return {
    selfHeal: { mode: "fail-closed" },
    direction: { direction: "deterministic" },
    secret: { secretMode: "fail-closed" },
  };
}
```
Add `export * from "./run-policy.js";` to `packages/domain/src/index.ts`.

- [ ] **Step 4: Run tests + build**
Run: `pnpm --filter @doit/domain test run-policy && pnpm --filter @doit/domain build`
Expected: PASS; build clean.

- [ ] **Step 5: Commit**
```bash
git add packages/domain/src/run-policy.ts packages/domain/src/run-policy.test.ts packages/domain/src/index.ts
git commit -m "feat(domain): segmented RunPolicy types + safeRunPolicy default

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `@doit/journey` package scaffold + `Journey` types/schema

**Files:**
- Create: `packages/journey/package.json`, `packages/journey/tsconfig.json`, `packages/journey/src/journey.ts`, `packages/journey/src/index.ts`
- Test: `packages/journey/src/journey.test.ts`
- Modify: root `tsconfig.json` references (add the package) if the repo lists project refs there; stage `pnpm-lock.yaml`.

**Interfaces:**
- Consumes: `Recording`, `RecordingSchema` from `@doit/recording`.
- Produces: `interface SecretRef { manager: string; key: string; origin: string; field: string }`; `interface JourneyMetadata { id: string; name: string; description?: string; promoted: boolean; params: string[]; secretRefs?: SecretRef[]; createdAtIso: string }`; `interface Journey { metadata: JourneyMetadata; recording: Recording }`; `const JourneySchema: ZodType<Journey>`.

- [ ] **Step 1: Write the failing test**
```ts
// packages/journey/src/journey.test.ts
import { describe, it, expect } from "vitest";
import { JourneySchema } from "./index.js";

const recording = { version: "1", site: "example", pages: [] };

describe("JourneySchema", () => {
  it("parses a well-formed Journey and rejects unknown metadata keys", () => {
    const j = {
      metadata: { id: "login", name: "Log in", promoted: false, params: [], createdAtIso: "2026-09-19T00:00:00Z" },
      recording,
    };
    expect(() => JourneySchema.parse(j)).not.toThrow();
    const bad = { ...j, metadata: { ...j.metadata, bogus: 1 } };
    expect(() => JourneySchema.parse(bad)).toThrow();
  });
});
```
- [ ] **Step 2: Run it and confirm it fails**
Run: `pnpm --filter @doit/journey test journey` → FAIL (package/module missing).

- [ ] **Step 3: Scaffold the package + implement**
`package.json` (mirror `packages/recording/package.json`: name `@doit/journey`, type module, `dependencies: { "@doit/recording": "workspace:*", "zod": "<same version as recording>" }`, build/test scripts identical). `tsconfig.json` mirrors recording's with a `references` entry to `../recording`.
```ts
// packages/journey/src/journey.ts
import { z, type ZodType } from "zod";
import { RecordingSchema, type Recording } from "@doit/recording";

export interface SecretRef { manager: string; key: string; origin: string; field: string }
export interface JourneyMetadata {
  id: string;
  name: string;
  description?: string;
  promoted: boolean;
  params: string[];
  secretRefs?: SecretRef[];
  createdAtIso: string;
}
export interface Journey { metadata: JourneyMetadata; recording: Recording }

const SecretRefSchema = z.object({
  manager: z.string(), key: z.string(), origin: z.string(), field: z.string(),
}).strict();

export const JourneySchema: ZodType<Journey> = z.object({
  metadata: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    promoted: z.boolean(),
    params: z.array(z.string()),
    secretRefs: z.array(SecretRefSchema).optional(),
    createdAtIso: z.string(),
  }).strict(),
  recording: RecordingSchema,
});
```
`src/index.ts`: `export * from "./journey.js";`

- [ ] **Step 4: Build + test**
Run: `pnpm install && pnpm --filter @doit/journey build && pnpm --filter @doit/journey test journey`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/journey/package.json packages/journey/tsconfig.json packages/journey/src/journey.ts packages/journey/src/index.ts packages/journey/src/journey.test.ts tsconfig.json pnpm-lock.yaml
git commit -m "feat(journey): new @doit/journey package with Journey type + schema

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Param-schema derivation + validation (invariant #5 core)

**Files:**
- Create: `packages/journey/src/param-schema.ts`
- Modify: `packages/journey/src/index.ts`
- Test: `packages/journey/src/param-schema.test.ts`

**Interfaces:**
- Consumes: `boundVariables(rec): string[]` from `@doit/recording`; `Recording`.
- Produces: `interface ParamSchema { required: string[] }`; `function deriveParamSchema(rec: Recording): ParamSchema`; `class ParamValidationError extends Error`; `function validateParams(schema: ParamSchema, params: Record<string,string>): void`.

- [ ] **Step 1: Write the failing test**
```ts
// packages/journey/src/param-schema.test.ts
import { describe, it, expect } from "vitest";
import { deriveParamSchema, validateParams, ParamValidationError } from "./index.js";

const recWithVar = {
  version: "1", site: "example",
  pages: [{ url: "/login", steps: [
    { step: { kind: "fill", target: { css: "#u" }, value: { var: "username" }, expect: { kind: "urlIncludes", text: "/login" } } },
  ] }],
};

describe("param-schema", () => {
  it("derives required params from bound variables", () => {
    expect(deriveParamSchema(recWithVar as any)).toEqual({ required: ["username"] });
  });
  it("throws ParamValidationError on a missing param", () => {
    expect(() => validateParams({ required: ["username"] }, {})).toThrow(ParamValidationError);
  });
  it("throws ParamValidationError on an unknown param (no silent ignore)", () => {
    expect(() => validateParams({ required: ["username"] }, { username: "a", bogus: "b" })).toThrow(ParamValidationError);
  });
  it("accepts an exact param set", () => {
    expect(() => validateParams({ required: ["username"] }, { username: "a" })).not.toThrow();
  });
});
```
- [ ] **Step 2: Run it and confirm it fails** — `pnpm --filter @doit/journey test param-schema` → FAIL.

- [ ] **Step 3: Implement**
```ts
// packages/journey/src/param-schema.ts
import { boundVariables, type Recording } from "@doit/recording";

export interface ParamSchema { required: string[] }
export class ParamValidationError extends Error {}

export function deriveParamSchema(rec: Recording): ParamSchema {
  return { required: boundVariables(rec) };
}

export function validateParams(schema: ParamSchema, params: Record<string, string>): void {
  const provided = Object.keys(params);
  const missing = schema.required.filter((v) => !(v in params));
  const unknown = provided.filter((p) => !schema.required.includes(p));
  if (missing.length > 0 || unknown.length > 0) {
    throw new ParamValidationError(
      `param mismatch — missing: [${missing.join(", ")}], unknown: [${unknown.join(", ")}]`,
    );
  }
}
```
Add `export * from "./param-schema.js";` to `index.ts`.

- [ ] **Step 4: Build + test** — `pnpm --filter @doit/journey build && pnpm --filter @doit/journey test param-schema` → PASS.
- [ ] **Step 5: Commit**
```bash
git add packages/journey/src/param-schema.ts packages/journey/src/param-schema.test.ts packages/journey/src/index.ts
git commit -m "feat(journey): param-schema derive + validate (reject missing/unknown params)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `FsJourneyStore` + `JourneyRegistry` (list/get/put/promote/find; invariant #6 core)

**Files:**
- Create: `packages/journey/src/store.ts`, `packages/journey/src/registry.ts`
- Modify: `packages/journey/src/index.ts`
- Test: `packages/journey/src/registry.test.ts`

**Interfaces:**
- Produces: `class FsJourneyStore { put(j: Journey): Promise<void>; get(id: string): Promise<Journey|null>; list(): Promise<JourneyMetadata[]> }` (mirror `FsRecordingStore`, JSON files keyed by `metadata.id`, `assertSafeId`); `class JourneyRegistry { constructor(store); get(id); put(j); promote(id): Promise<void>; find(query: string): Promise<JourneyMetadata[]> }`.
- **`find` returns only `promoted` Journeys** whose `name`/`description` contains `query` (case-insensitive); an empty query returns all promoted.

- [ ] **Step 1: Write the failing test**
```ts
// packages/journey/src/registry.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsJourneyStore, JourneyRegistry } from "./index.js";

const rec = { version: "1", site: "example", pages: [] };
const mk = (id: string, promoted: boolean) => ({
  metadata: { id, name: id, promoted, params: [], createdAtIso: "2026-09-19T00:00:00Z" }, recording: rec,
});

describe("JourneyRegistry.find", () => {
  it("returns only promoted journeys and hides unpromoted ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jr-"));
    const reg = new JourneyRegistry(new FsJourneyStore(dir));
    await reg.put(mk("login", false) as any);
    await reg.put(mk("checkout", true) as any);
    const all = await reg.find("");
    expect(all.map((m) => m.id)).toEqual(["checkout"]);
    expect(await reg.find("login")).toEqual([]); // unpromoted stays invisible
  });
  it("promote() flips the flag so a journey becomes discoverable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jr-"));
    const reg = new JourneyRegistry(new FsJourneyStore(dir));
    await reg.put(mk("login", false) as any);
    await reg.promote("login");
    expect((await reg.find("log")).map((m) => m.id)).toEqual(["login"]);
  });
});
```
- [ ] **Step 2: Run it and confirm it fails** — `pnpm --filter @doit/journey test registry` → FAIL.

- [ ] **Step 3: Implement** — model `FsJourneyStore` on `packages/recording/src/store.ts` (`assertSafeId`, JSON write/read, `list` reads metadata). Then:
```ts
// packages/journey/src/registry.ts
import type { Journey, JourneyMetadata } from "./journey.js";
import type { FsJourneyStore } from "./store.js";

export class JourneyRegistry {
  constructor(private readonly store: FsJourneyStore) {}
  get(id: string) { return this.store.get(id); }
  put(j: Journey) { return this.store.put(j); }
  async promote(id: string): Promise<void> {
    const j = await this.store.get(id);
    if (!j) throw new Error(`cannot promote unknown journey '${id}'`);
    await this.store.put({ ...j, metadata: { ...j.metadata, promoted: true } });
  }
  async find(query: string): Promise<JourneyMetadata[]> {
    const q = query.trim().toLowerCase();
    const all = await this.store.list();
    return all.filter((m) => m.promoted)
      .filter((m) => q === "" || m.name.toLowerCase().includes(q) || (m.description ?? "").toLowerCase().includes(q));
  }
}
```
Export both from `index.ts`.

- [ ] **Step 4: Build + test** — PASS.
- [ ] **Step 5: Commit**
```bash
git add packages/journey/src/store.ts packages/journey/src/registry.ts packages/journey/src/registry.test.ts packages/journey/src/index.ts
git commit -m "feat(journey): FsJourneyStore + JourneyRegistry (promoted-only find, promote gate)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Interpreter `resumeFrom` + public `checkAssertion`

**Files:**
- Modify: `packages/interpreter/src/interpreter.ts` (add `resumeFrom`), `packages/interpreter/src/index.ts` (export `checkAssertion` from `./assertion.js` if not already exported)
- Test: `packages/interpreter/src/resume-from.test.ts`

**Interfaces:**
- Consumes: existing `runFlat`, `flatten`, `RecordingInterpreter.run`, `InterpretResult`, `Assertion`.
- Produces: `RecordingInterpreter.resumeFrom(actor: Actor, rec: Recording, fromIndex: number, vars?: Record<string,string>, sink?: RecordingSink): Promise<InterpretResult>` — runs the flattened steps starting at `fromIndex` to the end (used to continue after a handback). `checkAssertion(actor: Actor, a: Assertion): Promise<boolean>` exported.

- [ ] **Step 1: Write the failing test**
```ts
// packages/interpreter/src/resume-from.test.ts — fake Actor; a 3-step recording, resumeFrom(2) runs only the last step.
// (Mirror the fake Actor pattern in interpreter.test.ts.) Assert resumeFrom skips steps 0..1 and executes step 2, returning {outcome:"ok"}.
```
Write it concretely against the existing `interpreter.test.ts` fake-Actor harness (import the same test helpers or replicate the minimal fake there). Assert: given a recording whose step 2 is a `navigate`/`assert`, `resumeFrom(actor, rec, 2)` invokes only step 2 and returns `{ outcome: "ok" }` (steps 0–1 not invoked — track calls on the fake).

- [ ] **Step 2: Run it and confirm it fails** — `pnpm --filter @doit/interpreter test resume-from` → FAIL (`resumeFrom` undefined).

- [ ] **Step 3: Implement** — add a `startIndex` to the internal `runFlat` (default 0) and a public method:
```ts
async resumeFrom(actor: Actor, rec: Recording, fromIndex: number, vars: Record<string, string> = {}, sink?: RecordingSink): Promise<InterpretResult> {
  const flat = flatten(rec);
  return runFlat(actor, flat, new Map(Object.entries(vars)), flat.length - 1, sink, /* startIndex */ fromIndex);
}
```
Update `runFlat` signature to accept `startIndex = 0` and begin its loop at `startIndex`. Ensure `checkAssertion` (assertion evaluator already used internally) is exported from the package barrel.

- [ ] **Step 4: Build + test (whole interpreter suite)** — `pnpm --filter @doit/interpreter build && pnpm --filter @doit/interpreter test` → all PASS (no regression to `run`/`runToCheckpoint`).
- [ ] **Step 5: Commit**
```bash
git add packages/interpreter/src/interpreter.ts packages/interpreter/src/index.ts packages/interpreter/src/resume-from.test.ts
git commit -m "feat(interpreter): resumeFrom(index) + export checkAssertion for post-handback resume

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `JourneyRunner` (invariants #1, #5, #7)

**Files:**
- Create: `packages/runtime/src/journey-runner.ts`
- Modify: `packages/runtime/src/index.ts`
- Test: `packages/runtime/src/journey-runner.test.ts`

**Interfaces:**
- Consumes: `RunPolicy` (`@doit/domain`), `PolicyEnforcementError` (`packages/runtime/src/runner.ts` — export it if not already), `Journey`/`deriveParamSchema`/`validateParams` (`@doit/journey`), `RecordingInterpreter` + `checkAssertion` (`@doit/interpreter`), `Actor` (`@doit/screenplay`).
- Produces: `type JourneyRunResult = { outcome:"ok"; output: unknown } | { outcome:"quarantined"; reason: string; at?: number }`; `interface HandbackHandler { present(prompt: string): Promise<void> }`; `interface JourneyRunRequest { journey: Journey; params: Record<string,string>; policy: RunPolicy }`; `class JourneyRunner { constructor(actor: Actor, interpreter: RecordingInterpreter, handback?: HandbackHandler); run(req: JourneyRunRequest): Promise<JourneyRunResult> }`.

- [ ] **Step 1: Write the failing tests**
```ts
// packages/runtime/src/journey-runner.test.ts
import { describe, it, expect, vi } from "vitest";
import { JourneyRunner, PolicyEnforcementError } from "./index.js";
import { safeRunPolicy } from "@doit/domain";

const journeyNoVars = { metadata: { id: "j", name: "j", promoted: true, params: [], createdAtIso: "x" }, recording: { version: "1", site: "s", pages: [] } };

function fakeInterpreter(result: any) {
  return { run: vi.fn().mockResolvedValue(result), resumeFrom: vi.fn().mockResolvedValue({ outcome: "ok" }) } as any;
}
const fakeActor = {} as any;

describe("JourneyRunner invariants", () => {
  it("#1: refuses to run with an absent policy (PolicyEnforcementError)", async () => {
    const r = new JourneyRunner(fakeActor, fakeInterpreter({ outcome: "ok" }));
    await expect(r.run({ journey: journeyNoVars, params: {}, policy: undefined as any }))
      .rejects.toBeInstanceOf(PolicyEnforcementError);
  });
  it("#1: refuses a partial policy (missing secret sub-policy)", async () => {
    const r = new JourneyRunner(fakeActor, fakeInterpreter({ outcome: "ok" }));
    await expect(r.run({ journey: journeyNoVars, params: {}, policy: { selfHeal:{mode:"fail-closed"}, direction:{direction:"deterministic"} } as any }))
      .rejects.toBeInstanceOf(PolicyEnforcementError);
  });
  it("#5: rejects unknown params before running any step", async () => {
    const interp = fakeInterpreter({ outcome: "ok" });
    const r = new JourneyRunner(fakeActor, interp);
    await expect(r.run({ journey: journeyNoVars, params: { bogus: "x" }, policy: safeRunPolicy() })).rejects.toThrow(/unknown/);
    expect(interp.run).not.toHaveBeenCalled(); // fail-fast BEFORE execution
  });
  it("secretMode fail-closed: an awaiting_human step quarantines (no handback handler)", async () => {
    const interp = fakeInterpreter({ outcome: "awaiting_human", at: 1, prompt: "pw", resume: { kind: "urlIncludes", text: "/home" } });
    const r = new JourneyRunner(fakeActor, interp);
    const res = await r.run({ journey: journeyNoVars, params: {}, policy: safeRunPolicy() });
    expect(res).toMatchObject({ outcome: "quarantined", at: 1 });
  });
});
```
- [ ] **Step 2: Run and confirm they fail** — `pnpm --filter @doit/runtime test journey-runner` → FAIL.

- [ ] **Step 3: Implement** — export `PolicyEnforcementError` from runtime's `index.ts`, then:
```ts
// packages/runtime/src/journey-runner.ts
import type { Actor } from "@doit/screenplay";
import type { RunPolicy } from "@doit/domain";
import { deriveParamSchema, validateParams, type Journey } from "@doit/journey";
import { RecordingInterpreter, checkAssertion } from "@doit/interpreter";
import { PolicyEnforcementError } from "./runner.js";

export type JourneyRunResult =
  | { outcome: "ok"; output: unknown }
  | { outcome: "quarantined"; reason: string; at?: number };

export interface HandbackHandler { present(prompt: string): Promise<void> }
export interface JourneyRunRequest { journey: Journey; params: Record<string, string>; policy: RunPolicy }

function assertCompletePolicy(p: RunPolicy | undefined): asserts p is RunPolicy {
  if (!p || !p.selfHeal?.mode || !p.direction?.direction || !p.secret?.secretMode) {
    throw new PolicyEnforcementError(
      "JourneyRunner requires a complete RunPolicy (selfHeal, direction, secret) — refusing to run with an absent/partial policy",
    );
  }
}

export class JourneyRunner {
  constructor(
    private readonly actor: Actor,
    private readonly interpreter: RecordingInterpreter,
    private readonly handback?: HandbackHandler,
  ) {}

  async run(req: JourneyRunRequest): Promise<JourneyRunResult> {
    assertCompletePolicy(req?.policy);                              // #1
    validateParams(deriveParamSchema(req.journey.recording), req.params); // #5 (throws before any step)
    // Slice 1: deterministic direction only.
    let result = await this.interpreter.run(this.actor, req.journey.recording, req.params);
    while (result.outcome === "awaiting_human") {
      if (req.policy.secret.secretMode !== "visible-handback" || !this.handback) {
        return { outcome: "quarantined", reason: "secret step reached under fail-closed/unattended secretMode", at: result.at };
      }
      await this.handback.present(result.prompt);                  // human enters the secret in the headed browser
      const ok = await checkAssertion(this.actor, result.resume);  // #7: verify BEFORE resuming; never assume-success
      if (!ok) return { outcome: "quarantined", reason: `handback resume postcondition not satisfied at step ${result.at}`, at: result.at };
      result = await this.interpreter.resumeFrom(this.actor, req.journey.recording, result.at + 1, req.params);
    }
    if (result.outcome === "ok") return { outcome: "ok", output: (result as { output?: unknown }).output };
    return { outcome: "quarantined", reason: `step ${(result as { at: number }).at} failed`, at: (result as { at: number }).at };
  }
}
```
Export from `index.ts`.

- [ ] **Step 4: Build + test** — `pnpm --filter @doit/runtime build && pnpm --filter @doit/runtime test journey-runner` → PASS.
- [ ] **Step 5: Commit**
```bash
git add packages/runtime/src/journey-runner.ts packages/runtime/src/index.ts packages/runtime/src/journey-runner.test.ts
git commit -m "feat(runtime): JourneyRunner — required RunPolicy, param validation, postcondition-gated handback resume

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Slice 1 acceptance — real login Journey end-to-end via visible-handback

**Files:**
- Create: `packages/runtime/src/journey-login-e2e.test.ts` (real browser)
- Read first: `apps/example-site/src/server.ts` for the login form markup + success signal; the browser/Actor setup in `site-integrations/example-network/src/e2e.test.ts` and `packages/interpreter/src/golden-replay.test.ts`.

**Interfaces:**
- Consumes: `JourneyRunner`, `HandbackHandler`, `safeRunPolicy` (override `secret.secretMode` to `"visible-handback"`), the real `PlaywrightBrowserPort`/`Actor`, `RecordingInterpreter`.

- [ ] **Step 1: Write the failing test**
```ts
// A login Journey whose password field is a `handback` step (as A.2 records secret fields).
// A test HandbackHandler stands in for the human: it fills the password field on the live page and resolves.
// The Journey's other fields (username) are ordinary fill steps (a param or a constant).
// Assert JourneyRunner returns { outcome: "ok" } AND the post-login assertion (e.g. urlIncludes "/inbox") holds.
// Use the real PlaywrightBrowserPort + example-site fixture, mirroring golden-replay.test.ts setup/teardown.
```
Build the Journey object inline from a hand-authored `Recording` matching the fixture's login page (username fill + password `handback` + submit click + `expect` urlIncludes the post-login route). The `HandbackHandler.present` fills the password field via the live actor's page and resolves (this is the human's job — the runner never holds the value).

- [ ] **Step 2: Run and confirm it fails** — `pnpm --filter @doit/runtime test journey-login-e2e` → FAIL.
- [ ] **Step 3: Make it pass** — wire the real port/actor + interpreter + `JourneyRunner` with the test handback handler; policy `{ ...safeRunPolicy(), secret: { secretMode: "visible-handback" } }`.
- [ ] **Step 4: Run** — PASS: the journey reaches the authenticated state; resume happened only after the `resume` postcondition passed.
- [ ] **Step 5: Commit**
```bash
git add packages/runtime/src/journey-login-e2e.test.ts
git commit -m "test(runtime): Slice 1 acceptance — real login journey end-to-end via visible-handback

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Two-level MCP facade — `find_capabilities` + `run_journey` (invariants #5, #6)

**Files:**
- Create: `packages/mcp-facade/src/journey-tools.ts`
- Modify: `packages/mcp-facade/src/tools.ts` (add `"find_capabilities"`, `"run_journey"` to `ALLOWED_TOOLS`), `packages/mcp-facade/src/index.ts`, `packages/mcp-facade/package.json` (add `@doit/journey`, `@doit/runtime` deps)
- Test: `packages/mcp-facade/src/journey-tools.test.ts`, update `packages/mcp-facade/src/boundary.test.ts`

**Interfaces:**
- Produces: `async function findCapabilities(reg: JourneyRegistry, query: string): Promise<{ id: string; name: string; description?: string; params: string[] }[]>` (promoted-only; includes each capability's param list); `async function runJourney(reg: JourneyRegistry, runner: JourneyRunner, id: string, params: Record<string,string>): Promise<JourneyRunResult>` — resolves a **published id from the registry only** (unknown id → throw), validates params via the Journey's schema (delegated to `JourneyRunner`), never accepts inline steps.

- [ ] **Step 1: Write the failing tests**
```ts
// packages/mcp-facade/src/journey-tools.test.ts
import { describe, it, expect } from "vitest";
import { findCapabilities, runJourney } from "./index.js";
// build an in-memory JourneyRegistry (FsJourneyStore in a tmp dir) with one promoted, one unpromoted journey.

describe("two-level MCP journey tools", () => {
  it("#6 find_capabilities returns only promoted capabilities with their params", async () => {
    // ... expect [{ id:"checkout", params:["qty"] }], and NOT the unpromoted "login"
  });
  it("#5 run_journey rejects an unknown/unpublished id (no inline steps)", async () => {
    await expect(runJourney(reg, runner, "does-not-exist", {})).rejects.toThrow(/unknown|not found/i);
  });
  it("#5 run_journey rejects unknown params", async () => {
    await expect(runJourney(reg, runner, "checkout", { bogus: "1" })).rejects.toThrow(/unknown/);
  });
});
```
Also add a boundary test asserting `listToolNames()` now includes `find_capabilities` and `run_journey` and still excludes every `FORBIDDEN_TOOLS` name.

- [ ] **Step 2: Run and confirm they fail** — FAIL.
- [ ] **Step 3: Implement**
```ts
// packages/mcp-facade/src/journey-tools.ts
import type { JourneyRegistry } from "@doit/journey";
import type { JourneyRunner, JourneyRunResult } from "@doit/runtime";

export async function findCapabilities(reg: JourneyRegistry, query: string) {
  const metas = await reg.find(query);                 // promoted-only (#6)
  return metas.map((m) => ({ id: m.id, name: m.name, description: m.description, params: m.params }));
}

export async function runJourney(reg: JourneyRegistry, runner: JourneyRunner, id: string, params: Record<string, string>): Promise<JourneyRunResult> {
  const journey = await reg.get(id);
  if (!journey || !journey.metadata.promoted) throw new Error(`unknown or unpublished journey '${id}'`); // #5/#6: id-only, no inline steps
  return runner.run({ journey, params, policy: /* provided by caller/session */ (globalThis as any).__runPolicy ?? undefined }); // see note
}
```
NOTE: the `RunPolicy` is threaded from the session, not global — the MCP server wiring passes the session policy into `runJourney` (add a `policy: RunPolicy` parameter and pass it explicitly; do NOT read a global). Correct the signature to `runJourney(reg, runner, id, params, policy)` and forward it. (This keeps invariant #1: no permissive default — the caller must supply the session policy.)
Add the two names to `ALLOWED_TOOLS`; export from `index.ts`.

- [ ] **Step 4: Build + test** — `pnpm --filter @doit/mcp-facade build && pnpm --filter @doit/mcp-facade test` → PASS; no dependency cycle (`pnpm -r build`).
- [ ] **Step 5: Commit**
```bash
git add packages/mcp-facade/src/journey-tools.ts packages/mcp-facade/src/tools.ts packages/mcp-facade/src/index.ts packages/mcp-facade/src/journey-tools.test.ts packages/mcp-facade/src/boundary.test.ts packages/mcp-facade/package.json pnpm-lock.yaml
git commit -m "feat(mcp-facade): two-level journey tools — find_capabilities (promoted-only) + run_journey (published-id-only)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Named typed MCP tools for promoted Journeys (dynamic listing; invariant #6)

**Files:**
- Modify: `packages/mcp-facade/src/journey-tools.ts`, `packages/mcp-facade/src/index.ts`
- Test: `packages/mcp-facade/src/named-tools.test.ts`

**Interfaces:**
- Produces: `async function listNamedJourneyTools(reg: JourneyRegistry): Promise<{ name: string; description?: string; inputSchema: { type: "object"; properties: Record<string, { type: "string" }>; required: string[] } }[]>` — one entry per **promoted** Journey, `name` = `journey.metadata.id`, `inputSchema` derived from `metadata.params`. Unpromoted Journeys produce no tool.

- [ ] **Step 1: Write the failing test**
```ts
// Assert: two journeys (one promoted "checkout" with params ["qty"], one unpromoted "login").
// listNamedJourneyTools(reg) => [{ name:"checkout", inputSchema:{ type:"object", properties:{ qty:{type:"string"} }, required:["qty"] } }]
// and NOTHING for "login" (#6).
```
- [ ] **Step 2: Run and confirm it fails** — FAIL.
- [ ] **Step 3: Implement** — map `reg.find("")` (promoted-only) to JSON-schema tool descriptors from `metadata.params`.
- [ ] **Step 4: Build + test** — PASS.
- [ ] **Step 5: Commit**
```bash
git add packages/mcp-facade/src/journey-tools.ts packages/mcp-facade/src/index.ts packages/mcp-facade/src/named-tools.test.ts
git commit -m "feat(mcp-facade): auto-list named typed tools for promoted journeys only

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: CLI `journey list|find|run` + programmatic API

**Files:**
- Create: `packages/cli/src/journey-api.ts` (programmatic surface)
- Modify: `packages/cli/src/program.ts` (add `journey` subcommands via the existing `buildProgram` + commander pattern), `packages/cli/package.json` (deps `@doit/journey`, `@doit/runtime`, `@doit/playwright`)
- Test: `packages/cli/src/journey-cli.test.ts`

**Interfaces:**
- Consumes: `JourneyRegistry`/`FsJourneyStore` (`@doit/journey`), `findCapabilities`, `JourneyRunner` (`@doit/runtime`), `safeRunPolicy`.
- Produces: CLI commands `brauto journey list`, `brauto journey find <query> [--json]`, `brauto journey run <id> --param k=v [--param ...]`; `journey-api.ts` exports `runJourneyProgrammatically({ dir, id, params, policy })` used by both the CLI and external callers.

- [ ] **Step 1: Write the failing test** (non-interactive, mirror `packages/cli/src/program.test.ts`):
```ts
// Seed a tmp journey dir with one promoted journey (no vars). Invoke buildProgram(...).parseAsync(["journey","find","","--json"])
// capturing emitJson output; assert the JSON envelope lists the promoted capability with its params.
// Then `journey run <id> --param k=v` with an unknown param exits non-zero with a ParamValidationError message (fail-fast, not a silent skip).
```
- [ ] **Step 2: Run and confirm it fails** — `pnpm --filter @doit/cli test journey-cli` → FAIL.
- [ ] **Step 3: Implement** — add a `journey` command group in `buildProgram`; parse repeated `--param k=v` into a `Record<string,string>`; `find` uses `findCapabilities`; `run` builds the real browser Actor (reuse the runtime/playwright wiring) + `JourneyRunner` with `safeRunPolicy()` (secret mode overridable by a `--secret-mode` flag later — Slice 1 default `fail-closed`, e2e uses `visible-handback`). Emit results via the existing `emitJson` envelope.
- [ ] **Step 4: Build + test + built-binary smoke** — PASS.
- [ ] **Step 5: Commit**
```bash
git add packages/cli/src/journey-api.ts packages/cli/src/program.ts packages/cli/src/journey-cli.test.ts packages/cli/package.json pnpm-lock.yaml
git commit -m "feat(cli): journey list/find/run commands + programmatic runJourney API

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: §9a invariant refusal sweep + permissive-fallback exit-gate script

**Files:**
- Create: `packages/runtime/src/slice1-invariants.test.ts` (aggregates the refusal assertions for #1/#5/#6/#7 as one readable contract file — re-using the units, no new logic)
- Create: `scripts/check-no-permissive-fallback.mjs`
- Modify: root `package.json` scripts (add `"check:no-fallback": "node scripts/check-no-permissive-fallback.mjs"`)
- Test: `scripts/check-no-permissive-fallback.test.mjs` (or a Vitest wrapper)

**Interfaces:**
- Produces: a script that fails (exit 1) if it finds a permissive fallback around a safety decision — heuristic grep over `packages/*/src/**/*.ts` for the forbidden shapes: a `catch` block that `return`s an `outcome: "ok"`; a `secretMode`/`policy` read followed by a `?? "ok"`/`|| { outcome: "ok" }` default; `run_journey` accepting a `steps`/`recording` inline argument. Prints file:line for each hit.

- [ ] **Step 1: Write the failing test** — the contract test file asserts each of the four invariants throws/refuses (import the unit behaviors: absent policy → `PolicyEnforcementError`; unknown param → `ParamValidationError`; unpromoted `find` → `[]`; failed resume postcondition → `quarantined`). Also a test that the fallback script exits non-zero on a fixture containing `catch { return { outcome: "ok" } }`.
- [ ] **Step 2: Run and confirm failure** — FAIL (script + aggregate file absent).
- [ ] **Step 3: Implement** the script (Node, `fast-glob` or `fs` walk + regex; no new runtime dep if using `node:fs`), and the aggregate contract test.
- [ ] **Step 4: Run** — `pnpm test slice1-invariants && node scripts/check-no-permissive-fallback.mjs` → PASS, script exits 0 on the real tree.
- [ ] **Step 5: Commit**
```bash
git add packages/runtime/src/slice1-invariants.test.ts scripts/check-no-permissive-fallback.mjs scripts/check-no-permissive-fallback.test.mjs package.json
git commit -m "test: Slice 1 §9a invariant refusal contract + permissive-fallback exit-gate script

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 12: Slice 1 exit gate

- [ ] **Step 1:** `pnpm -r build` — clean, **no dependency cycle** (`@doit/journey` leaf; `@doit/mcp-facade`/`@doit/cli` above `@doit/runtime`).
- [ ] **Step 2:** `pnpm test` — all green, **including the real-browser login acceptance** (Task 7).
- [ ] **Step 3:** `pnpm lint`.
- [ ] **Step 4:** `node scripts/check-no-permissive-fallback.mjs` — exits 0 (no permissive fallback around policy/secret/journey-resolution).
- [ ] **Step 5:** Confirm the Global-Constraints checklist: no secret value ever enters the runner in `visible-handback`; `run_journey` is published-id-only; `find`/named tools are promoted-only; `RunPolicy` has no permissive default. Commit only if config changed:
```bash
git add -- <explicit changed config paths>
git commit -m "chore(slice1): exit gate green

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (§11 Slice 1 in scope):** finish A.3b → **Phase A prereq**; `Journey` artifact+registry → **T2, T4**; segmented `RunPolicy` (fail-closed + deterministic) → **T1** (+ enforced in T6); secret via visible-handback → **T5 (resumeFrom) + T6 + T7**; 2-level MCP (deterministic search) → **T8, T9**; CLI/API → **T10**; fail-closed self-heal wiring → **T6** (postcondition failure → quarantined); invariant tests + exit-gate grep → **T11, T12**. Param-schema (#5) → **T3**. ✅ All Slice-1 spec items map to a task.

**Placeholder scan:** No "TBD"/"handle edge cases". The one NOTE (T8) explicitly *corrects* the sketch (pass `policy` explicitly, never a global) rather than leaving it vague — the corrected signature `runJourney(reg, runner, id, params, policy)` is stated. Fix applied inline.

**Type consistency:** `RunPolicy`/`safeRunPolicy` (T1) consumed unchanged in T6/T10; `deriveParamSchema`/`validateParams`/`ParamValidationError` (T3) used in T6/T8/T10; `JourneyRegistry.find` promoted-only (T4) reused by T8/T9; `JourneyRunResult`/`JourneyRunner` (T6) consumed by T7/T8/T10; `resumeFrom`/`checkAssertion` (T5) consumed by T6; `PolicyEnforcementError` exported from runtime (T6) consumed by T11. `find_capabilities`/`run_journey` names added to `ALLOWED_TOOLS` (T8) and asserted by the boundary test. No signature drift.

**Deferred (not gaps):** secret-value invariants #2–#4 → Slice 1b; Jev-ranked `find_capabilities` → Slice 4; hybrid/full self-heal (#8) → Slice 6; throughput invariants #9–#10 → Slice 2.

**Risks for the pre-flight scan:** (1) **invariant #1 is load-bearing** — `assertCompletePolicy` must run before ANY interpreter call and before param validation side effects; T6 tests assert `interp.run` is not called on rejection. (2) **No dependency cycle** — `@doit/mcp-facade` gaining `@doit/runtime`/`@doit/journey` deps must not be imported back by them; T8/T12 verify via `pnpm -r build`. (3) **resumeFrom must not regress `run`/`runToCheckpoint`** — T5 runs the whole interpreter suite. (4) **the permissive-fallback grep is a heuristic** — treat a hit as a hard gate failure to be resolved, not suppressed (the whole point of §9a #13).
