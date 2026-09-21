// types.ts — the single input/output contract for @jevitate/ux.
//
// Deps INWARD only: `@jevitate/recording` (TargetDescriptor) + `@jevitate/ai-core`.
// `Control` is defined locally: explore's live `Control` is unreachable (ux must
// not depend on explore), and recording exposes only `TargetDescriptor`. The
// shape mirrors explore's snapshot control so an offline builder can populate it
// from a Recording and a live hook can populate it from a Snapshot.
import type { TargetDescriptor } from "@jevitate/recording";

/** Calibration context — REQUIRED on every analysis (Global Constraint #5). */
export interface AppContext {
  readonly appClass: string;
  readonly persona?: string;
  readonly job?: string;
}

export type Tier = "semantic" | "behavioral" | "objective-a11y";

/** A model-facing interactive control (role/name/state summary — never a raw value). */
export interface Control {
  /** Stable index WITHIN one screen-state (mirrors explore's freshness discipline). */
  readonly index: number;
  readonly role: string;
  readonly name: string;
  readonly tag: string;
  readonly inputType: string | null;
  readonly enabled: boolean;
  /** Model-facing one-liner (role/name/state). Redacted before any model call. */
  readonly summary: string;
  /** Optional durable descriptor (present when built from a live Snapshot). */
  readonly descriptor?: TargetDescriptor;
}

/** Objective, computed-from-snapshot accessibility facts (honest subset only). */
export interface A11yControlFact {
  /** Ref token into the screen's evidence, e.g. "control:0". */
  readonly controlRef: string;
  readonly accessibleName: string | null;
  readonly focusOrder: number | null;
  readonly targetSize: { readonly width: number; readonly height: number } | null;
  /** null when contrast is not computable from the snapshot. */
  readonly contrastRatio: number | null;
}

export interface A11yFacts {
  readonly controls: readonly A11yControlFact[];
}

/** Engine-derived behavior signals for one screen-state. */
export interface BehaviorSignals {
  readonly noProgress: boolean;
  readonly backtracks: number;
  readonly formReentry: number;
  readonly dwellMs: number;
  readonly errors: number;
}

export interface ScreenRef {
  readonly screenId: string;
  readonly url: string;
}

/** The single input contract both offline and live modes build, per screen-state. */
export interface UxEvidence {
  readonly screenId: string;
  readonly url: string;
  readonly controls: readonly Control[];
  readonly visibleText: string;
  readonly appContext: AppContext;
  readonly job?: string;
  readonly history: readonly ScreenRef[];
  readonly behavior: BehaviorSignals;
  readonly a11yFacts: A11yFacts;
}

/**
 * The set of `keyof UxEvidence` a rubric entry may declare in `requiredEvidence`.
 * The loader validates entries against this exact set (spec: anti-masquerade —
 * an entry that references an unknown field would silently always-Skip).
 */
export const UX_EVIDENCE_KEYS = [
  "screenId",
  "url",
  "controls",
  "visibleText",
  "appContext",
  "job",
  "history",
  "behavior",
  "a11yFacts",
] as const satisfies readonly (keyof UxEvidence)[];
export type UxEvidenceKey = (typeof UX_EVIDENCE_KEYS)[number];

/** How a single Jev answer becomes (or does not become) a finding — data-driven polarity. */
export type FlagRule =
  | { readonly when: "noul-true" }
  | { readonly when: "noul-false" }
  | { readonly when: "score-below"; readonly threshold: number }
  | { readonly when: "score-above"; readonly threshold: number }
  | { readonly when: "choice-in"; readonly options: readonly string[] };

/** One narrow, calibrated Jev judgment (Choice / Noul / Score per @typesafe-ai/sdk). */
export interface JevQuestionSpec {
  readonly id: string;
  /** The narrow judgment instruction (carries the job/appContext in its framing). */
  readonly instruction: string;
  /** Concrete, calibrated criteria — never vague. */
  readonly criteria: string;
  readonly kind: "choice" | "noul" | "score";
  /** Required when kind === "choice". */
  readonly choices?: readonly string[];
  /** When an answer to this question constitutes a finding. */
  readonly flag: FlagRule;
  readonly severity: "info" | "minor" | "major";
}

/** Curated rubric data — Zod-validated at load (constraint #2/#6). */
export interface RubricEntry {
  readonly id: string;
  readonly principle: string;
  /** REQUIRED — loader throws if absent (structural citation gate). */
  readonly citation: { readonly source: string; readonly ref: string };
  readonly tier: Tier;
  readonly questions: readonly JevQuestionSpec[];
  readonly requiredEvidence: readonly UxEvidenceKey[];
}

/** A resolved reference into the analyzed evidence, e.g. { id: "control:0" }. */
export interface EvidenceRef {
  readonly id: string;
}

/** Honest attention provenance label — never "eye-tracking"/"gaze" (constraint #6). */
export interface PredictedAttention {
  /** e.g. "predicted-from-semantic-hierarchy". */
  readonly label: string;
  readonly note: string;
}

/**
 * A finding is constructable ONLY via `makeFinding()`. There is no public raw
 * constructor: the type is exported but the sole factory validates the citation
 * + evidence refs and freezes the result (spec FMECA SF4).
 */
export interface UxFinding {
  readonly rubricItemId: string;
  readonly citation: { readonly source: string; readonly ref: string };
  readonly severity: "info" | "minor" | "major";
  readonly confidence: number;
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly recommendation: string;
  readonly tier: Tier;
  readonly predictedAttention?: PredictedAttention;
}

/** What `makeFinding` needs to resolve refs — anything carrying a ref set. */
export interface AnalyzedEvidence {
  readonly screenId: string;
  readonly refs: ReadonlySet<string>;
}

/** A rubric item that did not run, and why (coverage — never a hollow finding). */
export interface SkippedItem {
  readonly rubricItemId: string;
  readonly screenId: string;
  readonly reason: string;
}

/** First-class coverage (anti-masquerade). */
export interface Coverage {
  /** Total (entry × screen) items considered. */
  readonly totalItems: number;
  /** Items actually judged. */
  readonly evaluated: number;
  readonly skipped: readonly SkippedItem[];
  /** Screen ids left un-analyzed because the judgment budget was exhausted. */
  readonly budgetTruncated: readonly string[];
}

export type AnalysisOutcome =
  | { readonly kind: "analyzed"; readonly findings: readonly UxFinding[]; readonly coverage: Coverage }
  | { readonly kind: "failed"; readonly reason: string; readonly screenId?: string; readonly rubricItemId?: string };
