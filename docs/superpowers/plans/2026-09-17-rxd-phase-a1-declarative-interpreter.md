# RxD Phase A.1 — Declarative Recording Schema & Interpreter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Establish the **declarative-first** execution core for Record-by-Demonstration: a closed-schema `Recording` artifact and a hardened **interpreter** that replays it over M2's Screenplay primitives (with a selector priority ladder, mandatory per-step postconditions, extract/forEach, replay-to-checkpoint, and a handback placeholder) — proven by a **golden replay** of a hand-authored journey against the `apps/example-site` fixture.

**Why first:** this de-risks the architectural bet (declarative data + one trusted interpreter as the production path) *before* investing in the recorder. The interpreter is the trust boundary; everything later (recorder output, multi-take diff, patch/splice, self-healing reference-diff) replays through it.

**Architecture:** `@doit/recording` holds the artifact types + zod schema (no I/O). `@doit/interpreter` maps each closed step primitive onto Screenplay `Target`/interactions/questions and executes it through an `Actor` (BrowseTheWeb ability) — so it reuses M2 wholesale and never imports Playwright directly except for locator construction from a descriptor. Production/authoring both run the same interpreter over content-addressed, validated `Recording` data.

**Tech Stack:** builds on M1+M2+M2.5. New packages `@doit/recording`, `@doit/interpreter`. zod, Vitest, Playwright (via M2's BrowserPort/Screenplay).

**Spec:** `docs/superpowers/specs/2026-09-17-record-by-demonstration-design.md` (§4, §5b, §8 declarative projection, §8b) — authoritative. Guardrails there are binding.

## Global Constraints
- Node 20+, ESM, strict TS project refs; dependency direction inward.
- **Closed schema (Poka-Yoke):** the step vocabulary is a fixed discriminated union — no arbitrary code, no raw JS. Every *acting* step carries a required postcondition (`expect`). Validated by zod.
- **Selector priority ladder:** `testId > role+name > label > text > css`.
- **Fail-closed:** a step whose postcondition/assert fails throws (never proceeds); `handback` returns an `awaiting_human` outcome (never auto-satisfies).
- `@doit/recording` imports nothing internal (or only `@doit/domain` types). `@doit/interpreter` may use `playwright` locator builders and `@doit/screenplay` — it is infra, not a site/domain module (ESLint forbidden-import rule doesn't apply to it).
- New packages: add the vitest `pkg()` alias + root `tsconfig.json` reference; **stage `pnpm-lock.yaml`** on dep changes; explicit-path staging (never `git add -A`; graft artifacts stay out).
- Commit trailer: blank line then EXACTLY `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Keep the suite green: `pnpm -r build && pnpm test && pnpm lint`.

---

### Task 1: `@doit/recording` — artifact schema

**Files:** Create `packages/recording/package.json`, `tsconfig.json`, `src/schema.ts`, `src/schema.test.ts`, `src/index.ts`; modify root `tsconfig.json`, `vitest.config.ts`.

**Produces (closed vocabulary):**
```ts
export interface TargetDescriptor { testId?: string; role?: string; name?: string; label?: string; text?: string; css?: string; frameUrl?: string }
export type RedactedValue = { redacted: true; length: number } | { redacted: false; value: string };
export type ValueOrVar = RedactedValue | { var: string };
export type Assertion =
  | { kind: "visible"; target: TargetDescriptor }
  | { kind: "urlIncludes"; text: string }
  | { kind: "textIncludes"; target: TargetDescriptor; text: string }
  | { kind: "count"; target: TargetDescriptor; min?: number; max?: number };
export type Step =
  | { kind: "navigate"; label?: string; url: string; expect: Assertion }
  | { kind: "click"; label?: string; target: TargetDescriptor; expect: Assertion }
  | { kind: "fill"; label?: string; target: TargetDescriptor; value: ValueOrVar; expect: Assertion }
  | { kind: "waitFor"; label?: string; target: TargetDescriptor; state: "visible" | "hidden" | "attached" }
  | { kind: "extract"; label?: string; target: TargetDescriptor; as: string; attr?: string; expect: Assertion }
  | { kind: "forEach"; label?: string; items: TargetDescriptor; as: string; steps: Step[] }
  | { kind: "assert"; label?: string; check: Assertion }
  | { kind: "handback"; label?: string; prompt: string; resume: Assertion; timeoutMs?: number };
export interface StepTiming { atMs: number; durationMs: number; gapBeforeMs: number }
export interface RecordedStep { step: Step; timing?: StepTiming; marker?: "narration" | "checkpoint"; variableName?: string; enumerationId?: string }
export interface PageSegment { url: string; title?: string; steps: RecordedStep[] }
export interface Recording { version: string; site: string; startedAtIso?: string; intent?: string; retro?: string; pages: PageSegment[] }
export const RecordingSchema: import("zod").ZodType<Recording>;
```
- [ ] **Step 1: Failing test** — `schema.test.ts`: a valid one-page recording parses; an unknown `step.kind` is rejected; a `click` **without `expect`** is rejected (Poka-Yoke); a `fill` with `{var:"body"}` value parses.
- [ ] **Step 2: Verify fail** (`pnpm test packages/recording/src/schema.test.ts`).
- [ ] **Step 3: Implement** — package.json (`@doit/recording`, ESM, dep `zod`), tsconfig, `schema.ts` with the interfaces above and a `RecordingSchema` built from a zod discriminated union on `step.kind` (each acting variant `.strict()` with a required `expect`), `index.ts` re-export; add alias + root tsconfig ref.
- [ ] **Step 4: Verify pass** + `pnpm -r build`.
- [ ] **Step 5: Commit** `feat(recording): closed-schema recording artifact` (stage lockfile).

---

### Task 2: `@doit/interpreter` — descriptor → Target (selector ladder)

**Files:** Create `packages/interpreter/package.json`, `tsconfig.json`, `src/descriptor.ts`, `src/descriptor.test.ts`, `src/index.ts`; modify root tsconfig + vitest.

**Produces:** `descriptorToTarget(d: TargetDescriptor): Target` (from `@doit/screenplay`) that builds the locator by the ladder: `testId` → `getByTestId`; else `role`+`name` → `getByRole(role,{name})`; else `label` → `getByLabel`; else `text` → `getByText`; else `css` → `locator(css)`; throw if none. Description names the chosen strategy.
- [ ] **Step 1: Failing test** — with a fake page recording which builder was called: `{testId:"send"}` → `getByTestId("send")`; `{role:"button",name:"Send"}` → `getByRole`; `{label:"Username"}` → `getByLabel`; `{}` → throws.
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement** — package.json (`@doit/interpreter`, deps `@doit/recording`, `@doit/screenplay`, `playwright`), tsconfig refs (`../recording`, `../screenplay`, `../playwright`), `descriptor.ts` returning `Target.named(<desc>).locatedBy((p) => …)` per the ladder; alias + root ref.
- [ ] **Step 4: Verify pass** + build. **Step 5: Commit** `feat(interpreter): descriptor→Target selector ladder` (stage lockfile).

---

### Task 3: interpreter — per-step execution + postconditions

**Files:** Create `packages/interpreter/src/assertion.ts`, `src/run-step.ts`, `src/run-step.test.ts`; modify `index.ts`.

**Produces:**
- `checkAssertion(actor, a: Assertion): Promise<boolean>` (maps to Screenplay questions: visible→IsVisible; urlIncludes→page.url includes; textIncludes→TextOf includes; count→CountOf within min/max).
- `class PostconditionFailed extends Error`.
- `runStep(actor, rec: RecordedStep, vars: Map<string,string>): Promise<void>` for `navigate | click | fill | waitFor | assert`: perform the action via Screenplay interactions (`Navigate.to`, `Click.on(descriptorToTarget)`, `Enter.theText(resolveValue).into(...)`, `waitFor` via the resolved locator's `waitFor({state})`), then for acting steps evaluate `step.expect` and **throw `PostconditionFailed` if false** (fail-closed). `resolveValue` reads `{var}` from `vars` (throws if missing) or the plain/redacted value (redacted value with no plaintext in a non-var context → error: can't type a redacted constant).
- [ ] **Step 1: Failing test** (fake page/actor + fake sleep): a `click` whose `expect:visible` holds → resolves and the click fired; a `click` whose `expect` is false → rejects with `PostconditionFailed`; a `fill` with `{var:"body"}` types the resolved var.
- [ ] **Step 2: Verify fail.** **Step 3: Implement.** **Step 4: Verify pass** + build. **Step 5: Commit** `feat(interpreter): step execution with fail-closed postconditions`.

---

### Task 4: interpreter — extract + forEach (+ variables)

**Files:** modify `src/run-step.ts`, `src/run-step.test.ts`.

**Produces:** extend `runStep` for `extract` (read `innerText` or `attr` of the target into `vars[step.as]`, then check `expect`) and `forEach` (resolve `items` locator, `count()` it, and for each index `i` run `step.steps` with a scoped var `step.as` set to that row's handle/index context — implement by re-scoping the target resolution to the nth match; store `${as}.__index` and allow child steps' descriptors to use `nthOf` via the loop — for A.1, support child `extract`/`click` scoped to the i-th `items` match).
- [ ] **Step 1: Failing test** — `extract` pulls text into a var asserted by a later step; `forEach` over 2 fake rows runs its child step twice with per-row extraction.
- [ ] **Step 2–4** implement/verify. **Step 5: Commit** `feat(interpreter): extract and forEach with variable scope`.

---

### Task 5: interpreter — handback (awaiting_human) placeholder

**Files:** modify `src/run-step.ts`, add `src/outcome.ts`, tests.

**Produces:** `type StepOutcome = { kind: "done" } | { kind: "awaiting_human"; prompt: string; resume: Assertion; index: number }`. `runStep` returns `StepOutcome`; a `handback` step returns `awaiting_human` (does NOT auto-satisfy `resume`) — the caller/runner (HITL milestone) drives the human + re-checks `resume`. All other steps return `{kind:"done"}` (or throw).
- [ ] **Step 1: Failing test** — a `handback` step returns `awaiting_human` with its prompt/resume, and no action is attempted past it. **Steps 2–4.** **Step 5: Commit** `feat(interpreter): handback returns awaiting_human`.

---

### Task 6: `RecordingInterpreter` — run + runToCheckpoint

**Files:** Create `packages/interpreter/src/interpreter.ts`, `src/interpreter.test.ts`; modify `index.ts`.

**Produces:** `class RecordingInterpreter { constructor(); run(actor, rec: Recording, vars?): Promise<InterpretResult>; runToCheckpoint(actor, rec, stepIndex): Promise<InterpretResult> }` where `InterpretResult = { outcome: "completed"; vars: Record<string,string> } | { outcome: "awaiting_human"; at: number; prompt: string; resume: Assertion } | { outcome: "failed"; at: number; error: string }`. Iterates pages→steps in order, threading `vars`; stops at the first `awaiting_human` (returns it with the global step index) or the first `PostconditionFailed` (returns `failed` with index+message). `runToCheckpoint` stops after executing up to `stepIndex` (inclusive) — the basis for replay-to-point.
- [ ] **Step 1: Failing test** (fake actor): a 3-step recording completes with extracted vars; a recording with a failing postcondition returns `failed{at}`; a recording with a handback returns `awaiting_human{at}`; `runToCheckpoint(1)` executes only the first two steps.
- [ ] **Step 2–4** implement/verify. **Step 5: Commit** `feat(interpreter): RecordingInterpreter run + runToCheckpoint`.

---

### Task 7: Golden replay against the fixture (A.1 exit criterion)

**Files:** Create `packages/interpreter/src/golden-replay.test.ts`; add devDeps `@doit/playwright`, `@doit/example-site`.

**Produces:** the proof that a **hand-authored declarative `Recording`** reproduces a real journey. The test: start `apps/example-site`; hand-author a `Recording` (login → inbox → open thread `t-1`) using `TargetDescriptor`s that match the fixture markup (`{label:"Username"}`, `{role:"button",name:"Sign in"}`, `{role:"link",name:"Welcome"}`, etc.) with an `expect` on each step; build a `CastActor` with `BrowseTheWeb` over a real headless `PlaywrightBrowserPort`; `new RecordingInterpreter().run(actor, recording)`; assert `outcome:"completed"` and that an `extract` step captured the thread's message text ("Hello there"). Reuse a temp profile dir; close the session in `finally`. Generous timeout.
- [ ] **Step 1: Failing test.** **Step 2: Verify fail.** **Step 3: Implement** the hand-authored recording + wiring (validate it through `RecordingSchema` first, to prove the schema accepts a real journey). **Step 4: Verify pass** + full `pnpm test`. **Step 5: Commit** `test(interpreter): golden replay of a declarative journey on the fixture` (stage lockfile if devDeps change).

---

### Task 8: A.1 exit gate
- [ ] **Step 1:** `pnpm -r build` (no cycle). **Step 2:** `pnpm test` (all green incl. golden replay). **Step 3:** `pnpm lint`; confirm `@doit/recording` imports nothing internal beyond types and no `playwright`; `@doit/interpreter` has no direct site/domain-forbidden imports. **Step 4:** commit only if config changed: `chore(rxd-a1): exit gate green`.

---

## Self-Review
**Spec coverage (RxD design §4/§8/§8b, Phase A slice):** closed recording schema + Poka-Yoke required postconditions → T1; selector ladder → T2; step execution fail-closed → T3; extract/forEach → T4; handback placeholder → T5; interpreter + replay-to-checkpoint → T6; declarative journey reproduces on the fixture → T7. ✅
**Deliberately deferred to A.2/A.3 (not gaps):** the **recorder** (capturing a real demonstration → `Recording`), **always-on recording + retention**, **multi-take diff / variable inference**, **reference-diff localizer**, **patch/splice**, **humanization fit** (derive `InteractionPolicy` from recorded timing), runner integration of a Recording-backed action, and the **postdoc TUI**. Handback *execution* (drive the human, re-check `resume`) lands with the HITL milestone.
**Placeholders:** none — the schema, ladder, and interpreter are concrete; `handback` is a real typed outcome, not a stub-that-lies.
**Type consistency:** `TargetDescriptor`, `Assertion`, `Step`/`RecordedStep`, `Recording`, `descriptorToTarget`, `runStep`/`StepOutcome`, `RecordingInterpreter`/`InterpretResult` defined once and reused across tasks.
**Risks for the pre-flight scan:** (1) `@doit/interpreter` depends on `@doit/screenplay` + `@doit/recording` + `@doit/playwright` — confirm the DAG stays acyclic (all are leafwards). (2) `forEach` row-scoping (nth-match) is the trickiest bit — keep it to `nth()` re-resolution for A.1; richer scoping is A.3. (3) redacted-constant fill must error (can't type a redacted value that isn't a variable) — Poka-Yoke, assert it.

## Outline — the rest of RxD Phase A (next plans)
- **A.2 — Hybrid recorder + always-on recording + retention.** Inject an in-page event recorder over the BrowserPort (semantic `TargetDescriptor` via Playwright locator generation + timing + redacted values; exclude our UI + secret/`human-only` fields); emit a `Recording`; always-on for every run (human + LLM) with success-prune / failure-retain / TTL-GC; a Recording-backed action type in the runner.
- **A.3 — Multi-take diff, reference-diff, patch/splice, humanization fit, postdoc TUI.** Deterministic trace aligner (constant/variable/enumeration candidates + confidence); `diffRecordings(run, reference)` localizer for self-healing; replay-to-checkpoint + record-a-patch splice with re-alignment; fit an `InteractionPolicy` (M2.5) from recorded timing; a `@clack/prompts`/Ink TUI to walk/label/merge/confirm-variables/redact.
