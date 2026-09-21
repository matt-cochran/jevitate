// a11y.ts — the OBJECTIVE accessibility tier (spec constraint #6, honest).
//
// Deterministic checks computed from snapshot facts — never a model call. It
// emits explicit `checked[]` / `notChecked[]` and reports ONLY the subset it
// verified; it never claims the app is "accessible" or "WCAG-compliant". Where a
// fact is not computable (e.g. contrast), the check is `notChecked`, never
// assumed passing. Every finding is built through the shared finding gate, so it
// carries a resolved citation + resolved evidence refs like any other.
import { makeFinding } from "./finding.js";
import type { RedactedEvidence } from "./redact.js";
import type { RubricEntry, UxFinding } from "./types.js";

export interface A11yResult {
  readonly checked: readonly string[];
  readonly notChecked: readonly string[];
  readonly findings: readonly UxFinding[];
}

const MIN_TARGET_PX = 24;
const MIN_CONTRAST = 4.5;

/** Deterministic a11y verdicts for one redacted screen-state. */
export function a11yChecks(evidence: RedactedEvidence, rubric: ReadonlyMap<string, RubricEntry>): A11yResult {
  const facts = evidence.a11yFacts.controls;
  const checked = new Set<string>();
  const notChecked = new Set<string>();
  const findings: UxFinding[] = [];

  const severityOf = (id: string): UxFinding["severity"] => {
    const q = rubric.get(id)?.questions[0];
    return q?.severity ?? "minor";
  };
  const emit = (rubricItemId: string, refId: string, note: string) => {
    findings.push(
      makeFinding(
        {
          rubricItemId,
          evidenceRefs: [{ id: evidence.refs.has(refId) ? refId : "a11y" }],
          severity: severityOf(rubricItemId),
          confidence: 1, // objective, computed — not a probabilistic judgment
          recommendation: note,
          tier: "objective-a11y",
        },
        rubric,
        evidence,
      ),
    );
  };

  // 1. Programmatic name (always computable from facts).
  if (facts.length > 0) {
    checked.add("control-name");
    for (const f of facts) {
      if (!f.accessibleName || f.accessibleName.trim().length === 0) {
        emit("a11y-control-name", f.controlRef, `Control ${f.controlRef} exposes no name to assistive technology. See ${rubric.get("a11y-control-name")?.citation.ref ?? ""}.`);
      }
    }
  } else {
    notChecked.add("control-name");
  }

  // 2. Focus order — checked only where positions are declared.
  const orders = facts.map((f) => f.focusOrder).filter((n): n is number => n !== null);
  if (orders.length > 0) {
    checked.add("focus-order");
    const hasDuplicate = new Set(orders).size !== orders.length;
    const hasNegative = orders.some((n) => n < 0);
    if (hasDuplicate || hasNegative) {
      emit("a11y-focus-order", "a11y", `Focus order is not a clean increasing sequence (duplicate or negative positions). See ${rubric.get("a11y-focus-order")?.citation.ref ?? ""}.`);
    }
  } else {
    notChecked.add("focus-order");
  }

  // 3. Target size — checked only where a size is known.
  const sized = facts.filter((f) => f.targetSize !== null);
  if (sized.length > 0) {
    checked.add("target-size");
    for (const f of sized) {
      const size = f.targetSize!;
      if (Math.min(size.width, size.height) < MIN_TARGET_PX) {
        emit("a11y-target-size", f.controlRef, `Control ${f.controlRef} target is smaller than ${MIN_TARGET_PX}px. See ${rubric.get("a11y-target-size")?.citation.ref ?? ""}.`);
      }
    }
  } else {
    notChecked.add("target-size");
  }

  // 4. Contrast — checked only where computable; unknown is NEVER assumed passing.
  const contrastable = facts.filter((f) => f.contrastRatio !== null);
  if (contrastable.length > 0) {
    checked.add("contrast");
    for (const f of contrastable) {
      if ((f.contrastRatio as number) < MIN_CONTRAST) {
        emit("a11y-contrast", f.controlRef, `Control ${f.controlRef} contrast is below ${MIN_CONTRAST}:1. See ${rubric.get("a11y-contrast")?.citation.ref ?? ""}.`);
      }
    }
  } else {
    notChecked.add("contrast");
  }

  return { checked: [...checked], notChecked: [...notChecked], findings };
}
