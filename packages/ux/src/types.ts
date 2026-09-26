// types.ts — the single input/output contract for @jevitate/ux.
//
// Deps INWARD only: `@jevitate/recording` (TargetDescriptor) + `@jevitate/ai-core`.
// `Control` is defined locally: explore's live `Control` is unreachable (ux must
// not depend on explore), and recording exposes only `TargetDescriptor`. The
// shape mirrors explore's snapshot control so an offline builder can populate it
// from a Recording and a live hook can populate it from a Snapshot.
import type { TargetDescriptor } from "@jevitate/recording";
import type { SignalEvidence } from "./signals.js";

/** Calibration context — REQUIRED on every analysis (Global Constraint #5). */
export interface AppContext {
  readonly appClass: string;
  readonly persona?: string;
  readonly job?: string;
}

/** `signal`: a mechanical oracle over the run's own measurements (signals.ts) — never a model. */
export type Tier = "semantic" | "behavioral" | "objective-a11y" | "signal";

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
  /**
   * Values the RUN ITSELF typed or selected (from the Recording's own `fill`/
   * `select` steps — never a secret; those are always `{redacted:true}` and
   * never surface here). #85: lets the vocabulary/jargon tier (nielsen-2)
   * tell the app's own copy apart from user-authored content (e.g. a piece
   * title) that merely got echoed back onto the screen.
   */
  readonly typedValues?: readonly string[];
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
  /**
   * Honest attention provenance (constraint #6). When set, findings for this
   * entry carry a `predictedAttention` label with this provenance string — an
   * INFERENCE from semantic/visual hierarchy, never eye-tracking or gaze data.
   */
  readonly attentionProvenance?: string;
  /**
   * Deterministic applicability gate (independent code, before any model call). An entry whose
   * precondition does not hold on a screen is recorded as `notApplicable` — never judged, never a
   * finding (e.g. choice overload cannot apply to a two-button consent screen).
   */
  readonly applicability?: RubricApplicability;
  /**
   * Marks a "match between system and the real world" / vocabulary-jargon
   * style entry (#85): an accepted finding whose grounding quotes/controls
   * match something the run itself typed is a false positive on
   * user-authored content, not the app's own copy, and is suppressed
   * (counted as `user-authored-content`) rather than reported.
   */
  readonly vocabularySensitive?: boolean;
}

export interface RubricApplicability {
  /** The principle needs at least this many interactive controls on the screen to apply. */
  readonly minControls?: number;
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
 * The inputs of a finding's confidence (see `confidence.ts` for the formula). Every factor is in
 * [0,1]; `confidence = mean(violation × applicability × grounding) × agreement`.
 */
export interface ConfidenceBasis {
  /** Mean Jev probability that the principle is violated (correctly oriented per flag rule). */
  readonly violation: number;
  /** Mean Jev probability that the principle applies to this screen type / job. */
  readonly applicability: number;
  /** Mean grounded specificity from independent adjudication (1 = cited evidence named in the observation). */
  readonly grounding: number;
  /** occurrences ÷ screen-states on this route where the item was judged with the same evidence present. */
  readonly agreement: number;
}

/**
 * A finding is constructable ONLY via `makeFinding()`. There is no public raw
 * constructor: the type is exported but the sole factory validates the citation
 * + evidence refs + a non-empty grounded observation and freezes the result
 * (spec FMECA SF4).
 */
export interface UxFinding {
  readonly rubricItemId: string;
  readonly citation: { readonly source: string; readonly ref: string };
  readonly severity: "info" | "minor" | "major";
  readonly confidence: number;
  /** ONLY the evidence actually implicated (on the representative screen `screenId`). */
  readonly evidenceRefs: readonly EvidenceRef[];
  /** What is wrong — naming the control/label/text — relative to the job. */
  readonly observation: string;
  /** The consequence for the user pursuing the job. */
  readonly userImpact: string;
  /** A specific change to the implicated control/text. */
  readonly recommendation: string;
  readonly tier: Tier;
  /** Representative screen-state the evidenceRefs resolve in. */
  readonly screenId: string;
  /** Normalized route (URL pathname) the finding was observed on. */
  readonly route: string;
  /** Human-readable identities of the implicated controls, e.g. `button "Accept"`. */
  readonly controls: readonly string[];
  /** Verbatim on-screen text excerpts, each verified present on the screen. */
  readonly quotes: readonly string[];
  /** How many screen-states on this route exhibited this same issue (dedupe count). */
  readonly occurrences: number;
  /** Every screen-state id the issue was observed on. */
  readonly screenIds: readonly string[];
  readonly confidenceBasis?: ConfidenceBasis;
  /**
   * The independent quality grade (grade.ts) — advisory; the report's quality policy decides
   * whether the finding is shown. Absent for objective (computed) findings.
   */
  readonly quality?: { readonly label: "actionable" | "relevant-minor" | "generic" | "wrong"; readonly confidence: number };
  readonly predictedAttention?: PredictedAttention;
  /** A `signal`-tier finding's verifiable evidence: the step(s), request(s), text and screenshot. */
  readonly signal?: SignalEvidence;
  /**
   * #132: the observed journey friction this finding is grounded in (friction.ts) — the step range
   * where the run backtracked, retried, hit a dead end, waited, met an error, abandoned a step or
   * did not reach the goal. A rubric finding without it is heuristic-only.
   */
  readonly journeyEvidence?: JourneyEvidence;
  /** #132: the observed impact on the job — the report ranks by it (blocked > slowed > confused > cosmetic). */
  readonly impact?: JobImpact;
  /**
   * #132: no behavioral evidence — a screen-level heuristic judgment only. Capped at `info` and
   * reported in the appendix (`report.heuristicAppendix`), never among the ranked findings.
   */
  readonly heuristicOnly?: boolean;
  /** #132: other findings on the same friction point, collapsed into this one as its rationale. */
  readonly contributing?: readonly ContributingFinding[];
}

/** #132: how much an observed problem got in the way of the job. */
export type JobImpact = "blocked" | "slowed" | "confused" | "cosmetic";

/** #132: the behavioral evidence a finding is grounded in. */
export interface JourneyEvidence {
  /** The friction point's id (friction.ts), or `signal:<kind>` for a run-signal finding. */
  readonly id: string;
  readonly kind: string;
  /** The transcript step range the friction was observed over. */
  readonly steps: readonly number[];
  readonly detail: string;
}

/**
 * A finding collapsed into another, kept as rationale — either #132's same-journey-friction-point
 * collapse, or 0.2.0's same-route-same-control collapse (analyzer.ts's `groupFindingsByControl`,
 * interim fix for #198). `citation` and `occurrences` let a reader see EVERY rubric item that fired
 * on the lead finding's control, with its own citation and count, not just the lead's.
 */
export interface ContributingFinding {
  readonly rubricItemId: string;
  readonly observation: string;
  readonly confidence: number;
  readonly quality?: UxFinding["quality"];
  readonly citation?: { readonly source: string; readonly ref: string };
  readonly occurrences?: number;
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
  /**
   * Items deterministically ruled out by the entry's `applicability` gate. They count as
   * evaluated (the answer is "does not apply"), so they never make coverage incomplete.
   */
  readonly notApplicable?: readonly SkippedItem[];
}

/** Why a flagged judgment did not become a reported finding. */
export type SuppressionReason =
  /** The specifics step named no control and no on-screen text — not a finding. */
  | "ungrounded"
  /** The specifics cited a control or text that does not exist on the observed screen. */
  | "rejected-evidence"
  /** The specifics step, looking for concrete evidence, found the principle not violated. */
  | "not-confirmed"
  /** Grounded, but confidence fell below the report's `minConfidence` cutoff. */
  | "below-min-confidence"
  /** The quality grade (e.g. generic / wrong) is not in the report's quality policy. */
  | "quality-policy"
  /** A vocabulary-sensitive entry's quoted/cited evidence matches a value the run itself typed. */
  | "user-authored-content"
  /** 0.2.0 (#198 interim): the page (route) already has `maxFindingsPerRoute` findings shown. */
  | "per-page-cap";

/** A suppressed candidate — counted and summarized in the report, never silently dropped. */
export interface SuppressedItem {
  readonly rubricItemId: string;
  readonly route: string;
  readonly screenId: string;
  readonly reason: SuppressionReason;
  readonly detail: string;
  readonly confidence?: number;
  readonly occurrences?: number;
  readonly qualityLabel?: string;
}

export type AnalysisOutcome =
  | {
      readonly kind: "analyzed";
      readonly findings: readonly UxFinding[];
      readonly coverage: Coverage;
      /** Flagged judgments that did not survive adjudication (the report adds below-cutoff ones). */
      readonly suppressed?: readonly SuppressedItem[];
      /** Per-screen flagged occurrences before dedupe (for before/after accounting). */
      readonly rawOccurrences?: number;
    }
  | { readonly kind: "failed"; readonly reason: string; readonly screenId?: string; readonly rubricItemId?: string };
