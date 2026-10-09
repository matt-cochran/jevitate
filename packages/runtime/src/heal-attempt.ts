import type { Recording, Step, ValueOrVar } from "@jevitate/recording";
import type { ChangeEvidence, ChangeEvidenceKind, ChangeScope } from "./change-scope.js";
import type { HealBudget, HealBudgetDimension, HealBudgetUsage } from "./heal-budget.js";

/**
 * #453: the attempt log of a change-aware self-heal — what was hypothesised, from which evidence,
 * which candidate was tried, and why it was rejected. Pure data: written into the run's result, the
 * proposed revision and the report. Never carries a raw diff hunk or a literal fill value.
 */

/** A cited piece of change evidence (no hunk header). */
export interface ChangeEvidenceRef {
  readonly id: string;
  readonly kind: ChangeEvidenceKind;
  readonly before?: string;
  readonly after?: string;
  readonly file?: string;
  readonly line?: number;
}

/** Why a candidate was not accepted. */
export type HealRejection =
  | "no-match"
  | "ambiguous"
  | "postcondition-failed"
  | "assertion-still-fails"
  | "end-state-failed"
  | "write-step"
  | "irreversible"
  | "write-attempted"
  | "proof-field-changed"
  | "shape-changed"
  | "not-explained-by-change"
  | "budget-exhausted";

export interface HealAttempt {
  /** 1-based, across the whole run. */
  readonly n: number;
  /** The broken step's 0-based flat index. */
  readonly stepIndex: number;
  readonly source: "change-evidence" | "model";
  /** e.g. `label 'Create New' → 'Create' (src/ui/Toolbar.tsx:42)`. */
  readonly hypothesis: string;
  readonly evidence: readonly ChangeEvidenceRef[];
  /** The candidate step, with any literal value hidden. */
  readonly candidate: Step | null;
  readonly observation?: { readonly screenshot?: string; readonly snapshot?: string };
  /** Set on a `full`-mode model candidate whose new anchor no change evidence names. */
  readonly anchorNotInChange?: true;
  readonly result: "accepted" | "rejected";
  readonly rejection?: { readonly code: HealRejection; readonly detail: string };
  readonly usage: { readonly modelCalls: number; readonly tokens?: number; readonly ms: number };
}

/** A `ChangeScope` without its evidence bodies: what a result or report may print. */
export interface ChangeScopeSummary {
  readonly range?: string;
  readonly baseSha?: string;
  readonly headSha?: string;
  readonly evidence: number;
  readonly files: number;
  readonly hunks: number;
  readonly skipped: number;
}

export type HealVerdict = "not-needed" | "unexplained" | "refused-proof" | "refused-write" | "exhausted" | "proposed";

/** What a self-heal did on a run (present whenever the policy allowed one and a step broke). */
export interface HealReport {
  readonly mode: "hybrid" | "full";
  readonly verdict: HealVerdict;
  readonly reason?: string;
  readonly changeScope: ChangeScopeSummary;
  readonly budget: { readonly limits: HealBudget; readonly used: HealBudgetUsage; readonly exhaustedBy?: HealBudgetDimension };
  readonly attempts: readonly HealAttempt[];
}

/** One step a proposed revision changes. */
export interface ProposedStepChange {
  readonly index: number;
  readonly before: Step;
  readonly after: Step;
  /** The accepted attempt's `n`. */
  readonly attempt: number;
  readonly hypothesis: string;
  readonly evidence: readonly ChangeEvidenceRef[];
  readonly anchorNotInChange?: true;
}

/**
 * The revision a `healed-pending-review` run proposes: the Journey's recording with each accepted
 * retarget applied one-for-one. The stored Journey is never written by a run; a person accepts this.
 */
export interface ProposedRevisionDraft {
  readonly recording: Recording;
  readonly steps: readonly ProposedStepChange[];
}

export function evidenceRef(e: ChangeEvidence): ChangeEvidenceRef {
  return {
    id: e.id,
    kind: e.kind,
    ...(e.before === undefined ? {} : { before: e.before }),
    ...(e.after === undefined ? {} : { after: e.after }),
    ...(e.file === undefined ? {} : { file: e.file }),
    ...(e.line === undefined ? {} : { line: e.line }),
  };
}

export function summarizeChangeScope(scope: ChangeScope): ChangeScopeSummary {
  return {
    ...(scope.range === undefined ? {} : { range: scope.range }),
    ...(scope.baseSha === undefined ? {} : { baseSha: scope.baseSha }),
    ...(scope.headSha === undefined ? {} : { headSha: scope.headSha }),
    evidence: scope.evidence.length,
    files: scope.scanned.files,
    hunks: scope.scanned.hunks,
    skipped: scope.scanned.skipped.length,
  };
}

function hidden(v: ValueOrVar): ValueOrVar {
  return "var" in v || v.redacted ? v : { redacted: true, length: v.value.length };
}

/** The step with every literal value (fill/select/editText value, upload path) hidden — for the attempt log. */
export function sanitizeStep(step: Step): Step {
  switch (step.kind) {
    case "fill":
    case "select":
      return { ...step, value: hidden(step.value) };
    case "upload":
      return { ...step, file: hidden(step.file) };
    case "editText":
      return step.value === undefined ? step : { ...step, value: hidden(step.value) };
    case "forEach":
      return { ...step, steps: step.steps.map(sanitizeStep) };
    default:
      return step;
  }
}
