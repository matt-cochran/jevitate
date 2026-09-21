# UX-Review Mission (`@jevitate/ux`) — Design Spec

**GitHub issue:** #30
**Status:** design (FMECA-vetted; awaiting review before writing-plans)
**Date:** 2026-09-21

## Goal
Give a SaaS builder the equivalent of a senior UX researcher reviewing **every screen of every flow** — grounded in what the user actually did, citing the literature — as a new Jevitate capability. Not "does it work" (existing missions) but "did the user accomplish the job, and where does the experience make that harder than it should be."

## Architecture (one sentence)
A new internal package `@jevitate/ux` exposes a single `UxAnalyzer` that consumes a `UxEvidence` bundle and produces ranked, **cited, evidence-anchored** `UxFinding`s from a curated rubric of Jev judgments (+ a lightweight objective a11y tier); it is consumed two ways — offline over a saved `Recording` (`jevitate ux`), and live as an `explore --strategy usability` mission — with **the same analyzer** in both.

## Tech stack
TS/pnpm monorepo. `@jevitate/ux` (private, bundled into `@jevitate/cli`). Depends INWARD only on `@jevitate/recording` (Snapshot/Recording/Assertion types) and `@jevitate/ai-core` (JudgmentPort/GenerationPort + the existing credential/secret guards). `@jevitate/explore` and `@jevitate/cli` depend on `@jevitate/ux` (never the reverse). zod for schemas; no `yaml`.

## Global Constraints (binding on every task)
1. **Advisory, never gating.** A `UxFinding` is a suggestion. It NEVER concludes a test pass/fail and NEVER stops a mission. (Consistent with the model-advisory-only invariant: only hard signals / user invariants gate a defect.)
2. **Structural evidence+citation gate (poka-yoke).** A `UxFinding` is **unconstructable** without (a) a `citationId` that resolves against the loaded rubric AND (b) at least one `evidenceRef` that resolves to a real node in the analyzed `UxEvidence`. Construction validates both and **throws** on a dangling reference. There is no code path that emits a finding lacking either. The human-readable recommendation is generated *from* the resolved Jev judgment + citation — never free-form prose.
3. **Typed failure, no fallback masquerade (fail-fast).** The analyzer returns a discriminated union: `AnalysisOutcome = { kind:"analyzed"; findings; coverage } | { kind:"failed"; reason; screenId?; rubricItemId? }`. A Jev/generation error is NEVER coerced into `analyzed` with empty findings. The CLI surfaces `failed` as a non-zero `fail()` envelope with actionable diagnostics. "Analyzed, zero findings" and "analysis failed" are distinct and never conflated.
4. **Secrets/PII never to a model (fail-closed).** `UxEvidence` passes the existing `redactContext` / `assertNoSecretInPayload` (from `@jevitate/ai-core`) before ANY model call. Declared secrets and known-credential values are redacted. If redaction cannot be applied, the run **fails closed** — raw evidence is never sent. Reuse the existing guard; no divergent redaction path. **This covers BOTH model calls:** the Jev judgment AND the generative recommendation. The recommendation is generated from `judgment + citation + redacted evidenceRefs` only — the generation step never receives raw copy. The leak test asserts no declared secret appears in *either* outbound payload.
5. **Required calibration context.** Every analysis request MUST carry an `appContext` (app-class + optional persona/job). It is a required field; the analyzer refuses to run without it. It is fed to Jev as state so judgments are calibrated (an admin tool is not a consumer checkout).
6. **Honest capability labeling.** Attention inference is the field `predictedAttention` and its output carries a provenance label; output copy NEVER says "eye-tracking" or "gaze." The a11y tier emits explicit `checked[]` / `notChecked[]` and NEVER emits "accessible" / "WCAG-compliant" — it reports only the subset it verified.
7. **Bounded, authorized-only (live mode).** The live `usability` mission reuses `@jevitate/explore`'s `BoundsTracker`/`StopReason`/`NoProgressDetector` and `assertAuthorizedExploreTarget` **verbatim** — no divergent loop or bounds. A hard per-run **judgment budget** caps model calls and fails fast when exceeded.
8. **Test discipline.** TDD, atomic declarative behavior assertions. `pnpm exec vitest run <path>` (never `pnpm --filter … test`). Keep `node scripts/check-no-permissive-fallback.mjs` clean. Every guardrail above has an asserts-it-refuses test.
9. Commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; feature branch → PR → dev.

## Key design decision (from FMECA / TRIZ)
The live recon driver does **not** simulate a confused user (that would burn bounded budget and blur into the adversarial mission). By **separation of concerns**, the driver pursues the stated job under the standard exploration bounds, and the *first-time-user friction* is an **analyzer judgment** ("would a plausible first-timer find the next step from what's on screen?") computed from the semantic evidence. The recon focus lives in the **rubric questions**, not a special "act confused" driver prompt. The live mission needs only a light `intent:"usability"` context on the existing driver.

## Core types (illustrative — exact signatures fixed in the plan)

```ts
// The single input contract both modes build.
interface UxEvidence {
  screenId: string;                 // stable id within a flow
  url: string;
  controls: readonly Control[];     // from @jevitate/recording Snapshot
  visibleText: string;              // redacted before any model call
  appContext: AppContext;           // REQUIRED (constraint #5)
  job?: string;                     // the task the flow pursues (JTBD)
  history: readonly ScreenRef[];    // prior screens in this flow (cross-screen judgments)
  behavior: BehaviorSignals;        // noProgress, backtracks, formReentry, dwell, errors — from the engine
  a11yFacts: A11yFacts;             // computed-from-snapshot subset (labels, focus order, target size, contrast-if-available)
}

interface AppContext { appClass: string; persona?: string }

type Tier = "semantic" | "behavioral" | "objective-a11y";

interface RubricEntry {              // curated data; Zod-validated at load (constraint #2, #6 of design FMECA)
  id: string;
  principle: string;
  citation: { source: string; ref: string };  // REQUIRED — load throws if absent
  tier: Tier;
  questions: readonly JevQuestionSpec[];       // ≥1
  requiredEvidence: readonly (keyof UxEvidence)[];
}

// UxFinding is built ONLY via `makeFinding(...)` which validates citationId + evidenceRefs
// resolve; there is no public raw constructor (forecloses a bypass path — spec FMECA SF4).
interface UxFinding {                // built via the validating factory (constraint #2)
  rubricItemId: string;
  citation: { source: string; ref: string };
  severity: "info" | "minor" | "major";
  confidence: number;                // Jev distribution concentration
  evidenceRefs: readonly EvidenceRef[]; // ≥1, each resolves into the analyzed UxEvidence
  recommendation: string;            // generated FROM the judgment+citation, not free-form
  tier: Tier;
}

type AnalysisOutcome =
  | { kind: "analyzed"; findings: readonly UxFinding[]; coverage: Coverage }  // coverage: which items ran vs Skipped(reason)
  | { kind: "failed"; reason: string; screenId?: string; rubricItemId?: string };
```

## The v1 rubric (FROZEN for v1 — Nielsen backbone + 5 Tier-1 + a11y subset)

**Backbone — Nielsen's 10 heuristics** (each: cite `nngroup.com/articles/ten-usability-heuristics`, one Jev question, `semantic` tier): visibility of system status; match to the real world; user control & freedom; consistency & standards; error prevention; recognition over recall; flexibility & efficiency; aesthetic & minimalist design; help users recognize/diagnose/recover from errors; help & documentation.

**Tier-1 differentiators (deeply operationalized):**
1. **Information scent** — cite Information Foraging (Pirolli & Card). Jev: per actionable control, "does the label predict its destination relative to `job`?" Evidence: controls, job, history.
2. **Progressive-disclosure ranking** — cite NN/g progressive disclosure. Jev (Score/Choice): rank each control essential/secondary/advanced for `job`; recommend what to hide/reveal + depth. Evidence: controls, job, appContext.
3. **Cognitive load / choice overload** — cite Hick's Law + Cognitive Load Theory (Sweller). Jev (Score): decision burden of this screen vs the job; is the primary action diluted? Evidence: controls, job.
4. **Primary-action clarity** — cite Nielsen #1 + visual hierarchy. Jev (Noul): "is the single next step toward `job` unambiguous from what's on screen?" Evidence: controls, visibleText, job.
5. **Deceptive/dark-pattern detection** — cite Brignull deceptive-patterns taxonomy. Jev (Noul per pattern): confirmshaming / misdirection / forced-continuity present? Evidence: visibleText, controls, history.

**Objective a11y tier (lightweight, honest):** computed-from-snapshot checks — control has an accessible name/label; logical focus order; target size ≥ threshold; contrast where computable. Emits `checked[]`/`notChecked[]`; never claims compliance.

Each entry is versioned data (`rubric/*.ts` or a data module), Zod-validated at load, and **extensible** (teams append entries later; the same schema + citation requirement applies).

## Surfaces
- **Offline:** `jevitate ux <recording.json> [--app-class <c> --persona <p> --json --out <dir>]` → builds `UxEvidence` per screen from the Recording, runs the analyzer, writes a `UxReport` artifact (ranked findings + coverage). Refuses (fail-fast) if the Recording lacks the evidence a rubric item requires → that item is `Skipped(reason)` in coverage, never a hollow finding.
- **Live:** `jevitate explore --strategy usability --url <url> --job "<job>" --app-class <c> [...]` → the existing explore driver pursues `job` under standard bounds with `intent:"usability"`; the analyzer runs per observed screen (batched judgments); emits the Recording + `UxReport`.

## Cost control
Independent rubric judgments over one screen-state are sent to Jev as **parallel questions in a single request** (TypeSafe pattern), not one call per item. A hard per-run judgment budget caps total model calls. The budget is checked at **screen granularity** (before a screen's batch) — it never truncates a screen mid-way into partial findings; when the budget is exhausted the result stays `analyzed` and `coverage` records a `budgetTruncated` tail (the un-analyzed screens), never a silent drop.

## Coverage is first-class (anti-masquerade)
A report with few findings is meaningless if most rubric items were `Skipped` for missing evidence. `UxReport` therefore surfaces coverage prominently — `evaluated N of M items; skipped K (reasons)` — and a "clean" verdict is only asserted at **full coverage**. Low coverage is reported loudly, never presented as "good UX." The loader also validates every rubric entry's `requiredEvidence` keys against the known `UxEvidence` fields and **throws at load** naming any entry that references an unknown/unpopulated field (forecloses an extension entry that would silently always-skip).

## Out of scope (v1)
Real eye-tracking / rendered-pixel saliency; auto-authoring an improved variant or A/B redesign; full WCAG audit (only the honest subset).

## Milestones (CPM — each independently testable/shippable)
1. `UxEvidence` + `UxFinding` + `AnalysisOutcome` types + the structural finding gate (constraint #2/#3) + redaction wiring (#4).
2. Rubric loader + Zod schema + v1 rubric data (frozen set) + manifest test.
3. `UxAnalyzer` core (batched Jev judgments, budget cap, coverage/Skipped, calibration context).
4. Offline `jevitate ux` CLI + `UxReport` artifact.
5. Live `explore --strategy usability` (driver `intent`, per-screen analysis).
6. Objective a11y tier (checked/notChecked honesty).

## Self-review
- Placeholder scan: none — every constraint is concrete and testable.
- Consistency: types referenced across sections match; `AnalysisOutcome` is the single result shape everywhere.
- Scope: single package + two surfaces; v1 rubric frozen; extensibility mechanism specified but starter set fixed.
- Every FMECA mitigation maps to a numbered Global Constraint or a milestone deliverable.
