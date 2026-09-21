# UX-Review Mission (`@jevitate/ux`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build `@jevitate/ux` — ranked, cited, evidence-anchored usability findings from Journeys via Jev + a curated rubric — consumed offline (`jevitate ux`) and live (`explore --strategy usability`).

**Architecture:** One `UxAnalyzer` consumes a `UxEvidence` bundle and emits a typed `AnalysisOutcome`. Findings are unconstructable without a resolved rubric citation + a resolved evidence ref. Both model calls (Jev judgment, generative recommendation) consume only redacted evidence. Live mode reuses the explore driver + bounds; the "first-time-user" lens is an analyzer judgment, not a driver behavior.

**Tech Stack:** TS/pnpm, zod, `@jevitate/recording` + `@jevitate/ai-core` (inward deps only), bundled into `@jevitate/cli`.

**Spec:** `docs/superpowers/specs/2026-09-21-ux-review-mission-design.md` (read it — the plan argues from it).

## Global Constraints
- Advisory, never gating. Findings never conclude pass/fail or stop a mission.
- **`UxFinding` only via `makeFinding()`** which validates `citationId` resolves in the loaded rubric AND every `evidenceRef` resolves in the analyzed `UxEvidence`; throws otherwise. No public raw constructor.
- Analyzer returns `AnalysisOutcome = {kind:"analyzed",findings,coverage} | {kind:"failed",reason,screenId?,rubricItemId?}`. A model error is NEVER `analyzed` with `[]`.
- **Both** model calls consume only redacted evidence (`redactContext`/`assertNoSecretInPayload` from ai-core); fail-closed if redaction unavailable.
- `appContext` (appClass required) is mandatory on every request; refuse without it.
- Honest labeling: `predictedAttention` (never "eye-tracking"/"gaze"); a11y emits `checked[]`/`notChecked[]`, never "accessible"/"WCAG-compliant".
- Live mode reuses explore `BoundsTracker`/`StopReason`/`NoProgressDetector`/`assertAuthorizedExploreTarget` verbatim; hard per-run judgment budget, checked at screen granularity.
- `@jevitate/ux` is `private:true`, bundled into cli; deps inward only (recording, ai-core). Test cmd `pnpm exec vitest run <path>`; keep `check-no-permissive-fallback` clean. Trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure
- `packages/ux/package.json`, `tsconfig.json` — new private package.
- `packages/ux/src/types.ts` — `UxEvidence`, `AppContext`, `Control` (re-exported), `BehaviorSignals`, `A11yFacts`, `Tier`, `RubricEntry`, `UxFinding`, `EvidenceRef`, `Coverage`, `AnalysisOutcome`.
- `packages/ux/src/finding.ts` — `makeFinding()` factory + validation.
- `packages/ux/src/redact.ts` — `redactEvidence()` over ai-core guards.
- `packages/ux/src/rubric/schema.ts` — Zod `RubricEntrySchema` + `loadRubric()`.
- `packages/ux/src/rubric/v1/*.ts` — frozen v1 rubric data (nielsen, scent, disclosure, load, primary-action, dark-patterns, a11y).
- `packages/ux/src/judge.ts` — batched Jev adapter (parallel questions per screen).
- `packages/ux/src/analyzer.ts` — `UxAnalyzer`.
- `packages/ux/src/recommend.ts` — generative recommendation (redacted, cited).
- `packages/ux/src/a11y.ts` — objective tier.
- `packages/ux/src/report.ts` — `UxReport` assembly (coverage-first-class).
- `packages/ux/src/index.ts` — barrel.
- `packages/cli/src/ux-api.ts` + `program.ts` — offline `jevitate ux`.
- `packages/explore/...` + `packages/cli/src/explore-api.ts` — live `--strategy usability` hook.

---

### Task 1: Package scaffold + core types + finding gate

**Files:** Create `packages/ux/package.json` (private:true, deps @jevitate/recording+@jevitate/ai-core workspace:*, zod), `tsconfig.json`, `src/types.ts`, `src/finding.ts`, `src/finding.test.ts`.

**Interfaces (Produces):** the types in File Structure; `makeFinding(input, rubric, evidence): UxFinding`.

- [ ] **Step 1: failing test** — `finding.test.ts`:
```ts
import { expect, test } from "vitest";
import { makeFinding } from "./finding.js";
const rubric = new Map([["nielsen-1", { id:"nielsen-1", citation:{source:"NN/g",ref:"..."} }]]) as any;
const evidence = { screenId:"s1", refs:new Set(["control:0"]) } as any;
test("throws on unknown citationId", () => {
  expect(() => makeFinding({ rubricItemId:"nope", evidenceRefs:[{ id:"control:0" }], severity:"minor", confidence:0.8, recommendation:"x", tier:"semantic" }, rubric, evidence)).toThrow(/citation/i);
});
test("throws on dangling evidenceRef", () => {
  expect(() => makeFinding({ rubricItemId:"nielsen-1", evidenceRefs:[{ id:"control:99" }], severity:"minor", confidence:0.8, recommendation:"x", tier:"semantic" }, rubric, evidence)).toThrow(/evidence/i);
});
test("builds a finding when both resolve", () => {
  const f = makeFinding({ rubricItemId:"nielsen-1", evidenceRefs:[{ id:"control:0" }], severity:"minor", confidence:0.8, recommendation:"x", tier:"semantic" }, rubric, evidence);
  expect(f.citation.source).toBe("NN/g");
});
```
- [ ] **Step 2: run — FAIL** (`pnpm exec vitest run packages/ux/src/finding.test.ts`).
- [ ] **Step 3: implement** `types.ts` (the interfaces) + `finding.ts`: `makeFinding` looks up `rubricItemId` in the rubric map (throw `UxFindingError` if absent), copies its `citation`, and asserts every `evidenceRef.id ∈ evidence.refs` (throw if any dangling). Returns a frozen `UxFinding`. No exported raw constructor.
- [ ] **Step 4: run — PASS.**
- [ ] **Step 5: commit** (`feat(ux): core types + finding gate (evidence+citation required)`).

### Task 2: Evidence redaction (fail-closed, both model calls)

**Files:** `src/redact.ts`, `src/redact.test.ts`. **Consumes:** ai-core `assertNoSecretInPayload`/`redactContext`.

- [ ] **Step 1: failing test** — a declared secret value in `visibleText`/control names is absent from `redactEvidence(evidence, secrets)` output; and `redactEvidence` with a redactor that throws → `redactEvidence` throws (fail-closed), never returns raw.
- [ ] **Step 2: run — FAIL.**
- [ ] **Step 3: implement** `redactEvidence(evidence, secrets)` mapping visibleText + control names/summaries through the ai-core redactor; return a `RedactedEvidence` branded type so downstream model calls can only accept redacted input (compile-time gate). Throw `RedactionUnavailableError` if the guard can't run.
- [ ] **Step 4: run — PASS.**
- [ ] **Step 5: commit.**

### Task 3: Rubric schema + loader + requiredEvidence key validation

**Files:** `src/rubric/schema.ts`, `src/rubric/schema.test.ts`.

- [ ] **Step 1: failing test** — `loadRubric([entry])` throws on: missing `citation`; empty `questions`; a `requiredEvidence` key not in the known `UxEvidence` field set. Valid entry loads into a `Map<id, RubricEntry>`.
- [ ] **Step 2: run — FAIL.**
- [ ] **Step 3: implement** `RubricEntrySchema` (zod: id, principle, citation{source,ref}, tier enum, questions min(1), requiredEvidence array of `z.enum(UX_EVIDENCE_KEYS)`), `loadRubric()` throwing `RubricLoadError` naming the bad entry+field.
- [ ] **Step 4: run — PASS.** **Step 5: commit.**

### Task 4: Frozen v1 rubric data + manifest test

**Files:** `src/rubric/v1/*.ts`, `src/rubric/v1/index.ts` (exports `V1_RUBRIC`), `src/rubric/v1/manifest.test.ts`.

- [ ] **Step 1: failing test** (`manifest.test.ts`): `V1_RUBRIC` loads via `loadRubric` without throwing; contains the 10 Nielsen ids + the 5 Tier-1 ids (`scent`, `progressive-disclosure`, `cognitive-load`, `primary-action`, `dark-patterns`) + the a11y entries; every entry has a non-empty citation.ref and ≥1 question; no duplicate ids.
- [ ] **Step 2: run — FAIL.**
- [ ] **Step 3: implement** the entries (data). Each: id, principle, citation, tier, questions (JevQuestionSpec: id, instruction, criteria, kind: choice|noul|score), requiredEvidence. Nielsen → `nngroup.com/articles/ten-usability-heuristics`. Tier-1 per spec (scent=Info Foraging, disclosure=NN/g, load=Hick+Sweller, primary-action=Nielsen#1, dark-patterns=Brignull). A11y entries tier `objective-a11y`.
- [ ] **Step 4: run — PASS.** **Step 5: commit.**

### Task 5: Batched Jev adapter

**Files:** `src/judge.ts`, `src/judge.test.ts`. **Consumes:** `JudgmentPort.systemOne`.

- [ ] **Step 1: failing test** — `judgeScreen(port, redactedEvidence, entries)` sends ALL entries' questions for one screen-state in ONE `systemOne` call (spy asserts call count === 1 for N entries), returns per-question answers keyed by question id.
- [ ] **Step 2: run — FAIL.** **Step 3: implement** collecting every entry's questions into one `JudgmentState` (evidence as named state) + one request; map answers back. **Step 4: PASS. Step 5: commit.**

### Task 6: UxAnalyzer core (budget, coverage, fail-fast)

**Files:** `src/analyzer.ts`, `src/analyzer.test.ts`.

- [ ] **Step 1: failing tests:** (a) a rubric item whose `requiredEvidence` is absent from a screen → that item is `Skipped(reason)` in coverage, not a finding; (b) `judge` throws → `AnalysisOutcome.kind==="failed"` with screenId+rubricItemId, NOT `analyzed` with `[]`; (c) judgment budget exhausted before a screen → result stays `analyzed`, `coverage.budgetTruncated` lists the un-analyzed screens; (d) a positive judgment produces a `UxFinding` via `makeFinding` with the screen's evidence refs.
- [ ] **Step 2: run — FAIL.**
- [ ] **Step 3: implement** `UxAnalyzer.analyze(request)`: require `appContext` (throw if absent); redact each screen's evidence (Task 2); per screen — check budget at screen granularity, filter entries whose requiredEvidence is present (else Skipped), `judgeScreen` (Task 5), turn positive answers into findings via `makeFinding`, catch model errors → return `failed`. Assemble `coverage` (evaluated/skipped/budgetTruncated).
- [ ] **Step 4: run — PASS.** **Step 5: commit.**

### Task 7: Generative recommendation (redacted, cited)

**Files:** `src/recommend.ts`, `src/recommend.test.ts`. **Consumes:** `GenerationPort`.

- [ ] **Step 1: failing test** — `recommend(gen, finding, redactedEvidence)` produces a recommendation; the outbound generation payload contains NO declared secret (spy on gen input); the recommendation text includes the citation source. A gen error propagates (→ analyzer `failed`), never a silent empty recommendation.
- [ ] **Step 2: run — FAIL.** **Step 3: implement** building the gen prompt from the Jev judgment summary + citation + redacted evidence refs only. **Step 4: PASS. Step 5: commit.**

### Task 8: Objective a11y tier (honest)

**Files:** `src/a11y.ts`, `src/a11y.test.ts`.

- [ ] **Step 1: failing test** — `a11yChecks(evidence)` returns `{ checked:[...], notChecked:[...], findings:[...] }`; `checked` includes only computable checks (accessible-name, focus-order, target-size, contrast-if-available); output NEVER contains the strings "accessible" or "WCAG-compliant" as a verdict; a control missing an accessible name yields a finding.
- [ ] **Step 2: run — FAIL.** **Step 3: implement** deterministic checks from snapshot facts. **Step 4: PASS. Step 5: commit.**

### Task 9: UxReport assembly + coverage-first-class

**Files:** `src/report.ts`, `src/report.test.ts`, `src/index.ts` (barrel).

- [ ] **Step 1: failing test** — `buildReport(outcome)` ranks findings by severity×confidence; a report with coverage < full sets `report.coverageComplete===false` and includes a prominent `coverageWarning`; a "clean" verdict (`report.clean===true`) is only possible at full coverage with zero findings; predicted-attention findings carry the provenance label.
- [ ] **Step 2: run — FAIL.** **Step 3: implement.** **Step 4: PASS. Step 5: commit.**

### Task 10: Package barrel + build + bundle wiring

- [ ] **Step 1:** add `@jevitate/ux` to cli devDependencies + tsconfig ref + vitest alias + build.mjs (bundled; private). **Step 2:** `pnpm -r build` clean; `pnpm exec vitest run packages/ux` green. **Step 3: commit.**

### Task 11: Offline CLI `jevitate ux <recording>`

**Files:** `packages/cli/src/ux-api.ts`, `ux-api.test.ts`, `program.ts` command.

- [ ] **Step 1: failing test** — `runUxReview({ recordingPath, appClass, ... })` builds `UxEvidence` per screen from the Recording, runs `UxAnalyzer`, writes a `UxReport`; on `AnalysisOutcome.failed` the CLI emits `fail("E_UX_ANALYSIS", ...)` (non-zero), never a fake clean report; a Recording missing control snapshots reports Skipped per affected item.
- [ ] **Step 2: run — FAIL.** **Step 3: implement** ux-api seam (inject analyzer for tests) + `program.command("ux")` with `--app-class`(required)/`--persona`/`--out`/`--json`, emitJson idiom. **Step 4: PASS. Step 5: commit.**

### Task 12: Live `explore --strategy usability`

**Files:** `packages/explore/src/missions/usability.ts` (+test), `packages/cli/src/explore-api.ts`, `program.ts`.

- [ ] **Step 1: failing tests** — a usability mission drives via the EXISTING explore loop under standard bounds (terminates on `StopReason`, never unbounded); per observed screen it invokes the analyzer; `--app-class`/`--job` required; authorized-origin guard fires first; the mission NEVER gates a defect on a UX finding (advisory).
- [ ] **Step 2: run — FAIL.** **Step 3: implement** `runUsabilityMission` reusing `explore()` with `missionContext` = the light `intent:"usability"` job directive + a per-screen analysis hook that appends findings to a `UxReport`; CLI `explore --strategy usability` branch (additive, mirrors coverage/adversarial branches). **Step 4: PASS. Step 5: commit.**

### Task 13: Verify + private/publishable

- [ ] **Step 1:** full suite green; bundle smoke (`jevitate ux --help`, `jevitate explore --strategy usability --help`); fallback gate clean; publishable = only `@jevitate/cli` + `jevitate` (ux is private). **Step 2: commit.**

## Self-Review
- **Spec coverage:** M1→T1/T2, M2→T3/T4, M3→T5/T6/T7, M4→T11, M5→T12, M6→T8; report/coverage → T9; all Global Constraints map to a task's test.
- **Placeholder scan:** every task has a concrete failing test + impl direction; rubric entries enumerated in T4.
- **Type consistency:** `AnalysisOutcome`/`UxFinding`/`UxEvidence`/`RubricEntry` used identically across T1/T6/T9/T11/T12; `makeFinding` is the single construction path everywhere.
