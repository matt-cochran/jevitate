# RxD Phase A.3a — Diff, Variable Binding & Humanization Fit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Complete the deterministic (LLM-free) heart of RxD: make a recorded `fill`/`select` **replayable** by binding it to a variable (escalation A), infer variables/constants/enumerations from **multi-take** recordings, provide a **reference-diff** localizer for self-healing, and **fit an `InteractionPolicy`** from a recording's captured timing. All pure/deterministic and testable to exact values.

**Why:** after A.2 a recording can't replay a `fill` (its value is redacted). A.3a closes that (record → promote/parameterize → replay-with-vars) and turns the multi-take design (§6, §6a) into working code — the point of the whole record-by-demonstration bet — with no LLM needed.

**Architecture:** pure functions over the A.1 `Recording` in `@doit/recording` (signature, alignment, classify, diff, promote, fit). The one non-pure piece is an **authoring value side-channel** in `@doit/recorder`: locally-retained non-secret captured values (never persisted, never LLM'd) that the diff/binding read, so the persisted artifact stays redacted. Replay reuses the A.1 interpreter's `{var}` resolution.

**Tech Stack:** builds on M1+M2+M2.5+RxD A.1+A.2. New pure modules in `@doit/recording`; a small addition to `@doit/recorder`. zod, Vitest.

**Spec:** RxD design (`2026-09-17-record-by-demonstration-design.md`) §5c, §6, §6a, §8/§8b, and the A.2 escalations (A: variable binding; B: secret→handback; C: computeDescriptor reference role). Guardrails binding.

## Global Constraints
- Node 20+, ESM, strict TS refs; inward deps. Closed schema; fail-closed; secrets never captured.
- **Authoring value side-channel is local-only:** captured non-secret values used for diff/binding are held in memory / a local authoring object; they are **never written into a persisted `Recording` and never sent to an LLM**. The persisted/parameterized artifact carries variable *names*, redacted values, never example values. Secret fields remain never-captured (`handback`).
- **Determinism:** diff/align/classify/fit are pure functions of their inputs (no clock/random); same inputs → identical output, asserted to exact values.
- `@doit/recording` stays runtime-leaf (zod only); the `fit` module may `import type { InteractionPolicy } from "@doit/domain"` (type-only, erased — no runtime dep, no cycle).
- New deps/packages → vitest alias + root tsconfig ref + **stage `pnpm-lock.yaml`**; explicit-path staging (never `git add -A`; graft `.gitignore`/`.ignore` artifacts stay out).
- Commit trailer: blank line then EXACTLY `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Keep the suite green: `pnpm -r build && pnpm test && pnpm lint`.

---

### Task 1: Authoring value side-channel (recorder)

**Files:** modify `packages/recorder/src/recorder.ts` (+test); add `packages/recorder/src/authoring.ts` if cleaner.

**Produces:** `Recorder.stop()` continues to return a redacted `Recording`; add `Recorder.stopAuthoring(): Promise<AuthoringRecording>` where `interface AuthoringRecording { recording: Recording; values: Map<string, string> }` — `values` maps a stable step key (page index + step index, or a step id) → the **actual non-secret captured value** (the pre-redaction `rawText`). Secret fields (handback steps) contribute NO entry. This object is for local authoring only (diff/binding); it is never persisted by the store and never passed to a model.
- [ ] Step 1: failing test — record (drive via Playwright) a fill of a normal field with value "jane" and a password field; assert `stopAuthoring().values` has the normal field's "jane" but NO entry for the password, while `.recording` is fully redacted (no "jane" in it). Step 2: verify fail. Step 3: implement (retain the pre-redaction value in a side map keyed by step; keep secrets out). Step 4: verify pass + build. Step 5: commit `feat(recorder): local authoring value side-channel (never persisted/LLM)`.

---

### Task 2: `promoteToVariable` — make a recorded fill replayable (escalation A)

**Files:** Create `packages/recording/src/promote.ts`, `promote.test.ts`; modify `packages/recording/src/index.ts`.

**Produces:** `promoteToVariable(rec: Recording, ref: StepRef, varName: string): Recording` (`StepRef = { page: number; step: number }`) returning a NEW Recording where that step's `value` becomes `{ var: varName }` and `RecordedStep.variableName = varName`. Validates the step is a `fill`/`select`; throws otherwise. `boundVariables(rec): string[]` lists declared vars. Pure.
- [ ] Step 1: failing test — promoting a `fill` step yields `value:{var:"username"}` + `variableName`; `boundVariables` returns `["username"]`; promoting a `click` throws. Step 2–4. Step 5: commit `feat(recording): promoteToVariable and boundVariables`.

---

### Task 3: Replayable round-trip (escalation A exit criterion)

**Files:** Create `packages/recorder/src/replayable.test.ts` (real browser); devDeps as needed (`@doit/interpreter`, `@doit/screenplay`, `@doit/example-site`).

**Produces:** the proof a *recorded* fill replays once bound. Record the fixture login (username field) with the recorder; `stopAuthoring()`; `promoteToVariable(recording, <the username fill step>, "username")`; then in a fresh session `new RecordingInterpreter().run(actor, promoted, new Map([["username","jane"]]))` and assert it logs in and reproduces (reaches the inbox/thread) — **no hand-editing**, the promotion + supplied var is the whole mechanism.
- [ ] Step 1: failing test. Step 2: verify fail. Step 3: implement (read fixture markup for the field). Step 4: verify pass + full `pnpm test`. Step 5: commit `test(recorder): recorded fill replays after promoteToVariable`.

---

### Task 4: Step signature (value-independent)

**Files:** Create `packages/recording/src/signature.ts`, `signature.test.ts`; modify `index.ts`.

**Produces:** `stepSignature(step: Step, pageUrl: string): string` — a structural key from `(kind, url-template, descriptor structural fields [testId/role/label + a container/ordinal hint])`, **excluding** concrete name/text/value. `urlTemplate(url)` normalizes id-like path segments to `:id`. Pure.
- [ ] Step 1: failing test — two `fill` steps on the same field with different values share a signature; a `click` on `/thread/1` vs `/thread/2` share a signature (`urlTemplate` → `/thread/:id`); a `click` on a button vs a link differ. Step 2–4. Step 5: commit `feat(recording): value-independent step signature`.

---

### Task 5: Trace alignment (Needleman–Wunsch / progressive MSA)

**Files:** Create `packages/recording/src/align.ts`, `align.test.ts`; modify `index.ts`.

**Produces:** `alignTraces(takes: Recording[]): AlignedColumn[]` where `AlignedColumn = { cells: (RecordedStep | null)[] }` (one cell per take, `null` = gap). 2 takes → Needleman–Wunsch over `stepSignature` sequences (match=+1, mismatch/gap penalties); 3+ → progressive (align 1+2 → a profile of signatures, then align each further take to it). Deterministic. Pure.
- [ ] Step 1: failing test — two identical-length takes with matching signatures align 1:1; a take with one extra step introduces a gap column in the other; three takes align into columns. Step 2–4. Step 5: commit `feat(recording): trace alignment (NW + progressive MSA)`.

---

### Task 6: Classification + confidence + noise

**Files:** Create `packages/recording/src/classify.ts`, `classify.test.ts`; modify `index.ts`.

**Produces:** `classifyColumns(cols: AlignedColumn[], values: Map<string,string>[]): DiffResult` where `DiffResult = { columns: ColumnClass[] }` and `ColumnClass = { kind:"constant"|"variable"|"enumeration"|"noise"|"ambiguous"; confidence:number; values:(string|null)[]; inferredType?:"email"|"number"|"string"; enumerationId?:string }`. Uses the per-take **authoring `values`** (Task 1) to compare actual values at aligned fill/select columns: identical → constant; distinct non-noise across ≥2 takes → variable (+inferred type); a repeated aligned sub-sequence over sibling `nth` targets → enumeration; uuid/timestamp/high-entropy → noise (low confidence). **Default constant unless corroborated.** Pure.
- [ ] Step 1: failing tests — identical values → constant; two distinct emails → variable(email, high conf); a value that is a uuid → noise; single differing value with only one take present → ambiguous/constant (not variable). Step 2–4. Step 5: commit `feat(recording): column classification with confidence and noise detection`.

---

### Task 7: `diffTakes` + `applyDiff` (auto-parameterize)

**Files:** Create `packages/recording/src/diff.ts`, `diff.test.ts`; modify `index.ts`.

**Produces:** `diffTakes(takes: AuthoringRecording[]): DiffResult` (composes signature→align→classify). `applyDiff(base: Recording, diff: DiffResult, names?: Record<number,string>): Recording` — auto-promote each **confident variable** column to a `{var}` slot (default var name from the inferred type/position; overridable via `names`) using `promoteToVariable`, leaving constants fixed. Returns a parameterized, replayable Recording. Pure.
- [ ] Step 1: failing test — two takes differing only in the username fill → `diffTakes` marks that column variable → `applyDiff` yields a Recording with `value:{var:…}` at that step and identical constants elsewhere; supplying the var replays (unit-level: interpret with a fake actor). Step 2–4. Step 5: commit `feat(recording): diffTakes and applyDiff auto-parameterization`.

---

### Task 8: Reference-diff localizer (self-healing enabler)

**Files:** Create `packages/recording/src/reference-diff.ts`, `reference-diff.test.ts`; modify `index.ts`.

**Produces:** `diffRecordings(run: Recording, reference: Recording): { divergedAt: number | null; kind?: "missing"|"extra"|"changed"; detail?: string }` — align run vs reference by signature; return the first divergent aligned column as a flat step index (or `null` if they match structurally). For self-healing: localize where an automated run departed from the reference (human demo / last-good). Pure.
- [ ] Step 1: failing test — identical structure → `divergedAt:null`; a run missing a step → `divergedAt` at that index, `kind:"missing"`; a run with a changed target signature → `kind:"changed"`. Step 2–4. Step 5: commit `feat(recording): reference-diff localizer for self-healing`.

---

### Task 9: Humanization fit — `fitInteractionPolicy`

**Files:** Create `packages/recording/src/fit.ts`, `fit.test.ts`; modify `index.ts`, `package.json` (type-only dep note for `@doit/domain`).

**Produces:** `fitInteractionPolicy(rec: Recording): InteractionPolicy` (type from `@doit/domain`, imported type-only) derived from captured timing: from `fill` steps' inter-keystroke intervals → `typing.charsPerSecond` (1000/mean) and `perKeyJitter` (SD/mean, clamped 0..1); boundary gaps → `wordPauseMs`/`sentencePauseMs`; pre-action `gapBeforeMs` on click/navigate → `thinkBeforeActionMs`; longer pre-navigation gaps and reading contexts → `readingMsPerChar` estimate; inter-step gaps → `interInteractionMs`. Omits a sub-model when there's no timing signal. Pure. (Feeds M2.5 so the derived policy paces later runs like the demonstrator.)
- [ ] Step 1: failing test — a recording whose fill has known inter-key intervals (e.g. mean 200ms) → `typing.charsPerSecond ≈ 5` within tolerance; a recording with no typing → `typing` omitted; think-gap before a click → `thinkBeforeActionMs.mean ≈` the gap. Step 2–4. Step 5: commit `feat(recording): fit an InteractionPolicy from recorded timing` (stage lockfile if a type dep is added).

---

### Task 10: CLI + exit gate

**Files:** modify `packages/cli/src/program.ts` (+test), `bin.ts`, `package.json` (dep `@doit/recording`, `@doit/recorder` as needed).

**Produces:** `brauto recording promote <file> --page N --step N --var <name>`; `brauto recording diff <takeA.json> <takeB.json> [<takeC.json>] [--json]` (prints `DiffResult`); `brauto recording fit <file> [--json]` (prints the derived `InteractionPolicy`, ready to `site policy set`). Deterministic, tested via envelopes. Then the exit gate.
- [ ] Steps: failing test (diff of two JSON takes prints a variable column; fit prints a policy) → implement → verify → then gate: `pnpm -r build` (no cycle), `pnpm test` (all green incl. the real-browser replayable round-trip), `pnpm lint`, confirm `@doit/recording` has no runtime playwright/domain import (type-only ok) and the authoring values never appear in a persisted Recording (the Task 1/3 tests prove it). Commit `feat(cli): recording promote/diff/fit` (+ `chore(rxd-a3a): exit gate green` if config changed).

---

## Self-Review
**Spec coverage (RxD §6/§6a/§8b + escalation A):** authoring value side-channel → T1; variable binding (replayable fills) → T2/T3; signature → T4; alignment → T5; classification+confidence+noise → T6; multi-take diff + auto-parameterize → T7; reference-diff → T8; humanization fit → T9; CLI → T10. ✅
**Deferred to A.3b (not gaps):** replay-to-checkpoint + **record-a-patch splice** with re-alignment; the **postdoc TUI** (clack/Ink) that walks/labels/merges/confirms interactively; escalation-C decision on `computeDescriptor`'s reference role; LLM-mediated confirmation of *ambiguous* columns (Phase B, needs M3 gateway).
**Placeholders:** none — every function has a concrete signature + behavior + exact-value test.
**Type consistency:** `AuthoringRecording`, `promoteToVariable`/`boundVariables`, `stepSignature`/`urlTemplate`, `alignTraces`/`AlignedColumn`, `classifyColumns`/`DiffResult`/`ColumnClass`, `diffTakes`/`applyDiff`, `diffRecordings`, `fitInteractionPolicy` defined once, reused across tasks.
**Risks for the pre-flight scan:** (1) **Authoring value side-channel must never leak into persistence/LLM** — T1/T3 assert the persisted Recording is value-free; the reviewer should treat any path that writes an authoring value into a `Recording`/store as Critical. (2) `@doit/recording` stays a runtime leaf — `@doit/domain` in `fit` must be **type-only**; confirm no runtime import / no cycle. (3) Alignment/classification are the subtle bits — require exact-value tests on hand-authored takes with inserts/deletes and noise. (4) `applyDiff` default var-naming shouldn't collide across columns (dedupe).

## Outline — A.3b (next plan)
- **Record-a-patch + splice:** interpreter `runToCheckpoint` (A.1) pauses at the live state; the recorder captures a delimited supplemental segment (start-from-state, A.2 §5c); `spliceRecording(base, at, segment)` inserts/replaces with re-alignment (idempotent over splices).
- **Postdoc TUI** (`@clack/prompts` or Ink): walk the merged trace — rename/label, **merge steps** into named chunks, confirm the `DiffResult`'s variable/enumeration proposals, mark `human-only`, redact, name variables — producing the parameterized action. Thin shell over A.3a's tested `diffTakes`/`applyDiff`/`promoteToVariable`.
- **Escalation C:** decide `computeDescriptor`'s reference-impl role (route the non-navigating capture path through it, or retire it).
