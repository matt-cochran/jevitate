// a11y.ts — the OBJECTIVE accessibility tier (spec constraint #6, honest).
//
// Deterministic checks computed from snapshot facts — never a model call. It
// emits explicit `checked[]` / `notChecked[]` and reports ONLY the subset it
// verified; it never claims the app is "accessible" or "WCAG-compliant". Where a
// fact is not computable (e.g. contrast), the check is `notChecked`, never
// assumed passing. Every finding is built through the shared finding gate, so it
// carries a resolved citation + resolved evidence refs like any other.
import { makeFinding } from "./finding.js";
import { routeOf } from "./route.js";
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
  const route = routeOf(evidence.url);
  const controlByRef = new Map<string, (typeof evidence.controls)[number]>(evidence.controls.map((c) => [`control:${c.index}`, c]));
  const labelOf = (refId: string): string | undefined => {
    const c = controlByRef.get(refId);
    if (!c) return undefined;
    return c.name.trim().length > 0 ? `${c.role || "control"} "${c.name}"` : `${c.role || "control"} (unnamed, ${refId})`;
  };
  const emit = (rubricItemId: string, refId: string, observation: string, userImpact: string, recommendation: string) => {
    const label = labelOf(refId);
    findings.push(
      makeFinding(
        {
          rubricItemId,
          evidenceRefs: [{ id: evidence.refs.has(refId) ? refId : "a11y" }],
          severity: severityOf(rubricItemId),
          confidence: 1, // objective, computed — not a probabilistic judgment
          observation,
          userImpact,
          recommendation: `${recommendation} See ${rubric.get(rubricItemId)?.citation.ref ?? ""}.`,
          tier: "objective-a11y",
          route,
          controls: label ? [label] : [],
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
        emit(
          "a11y-control-name",
          f.controlRef,
          `${labelOf(f.controlRef) ?? f.controlRef} exposes no accessible name to assistive technology.`,
          "Screen-reader and voice-control users cannot identify or target this control.",
          `Give ${f.controlRef} a visible label or aria-label that names its action.`,
        );
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
      emit(
        "a11y-focus-order",
        "a11y",
        "Focus order is not a clean increasing sequence (duplicate or negative positions).",
        "Keyboard users tab through controls in an unpredictable order.",
        "Remove positive/negative tabindex values so focus follows the visual order.",
      );
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
        emit(
          "a11y-target-size",
          f.controlRef,
          `${labelOf(f.controlRef) ?? f.controlRef} has a ${size.width}×${size.height}px target, smaller than ${MIN_TARGET_PX}px.`,
          "Touch and motor-impaired users mis-tap or cannot hit this control.",
          `Enlarge ${f.controlRef}'s hit area to at least ${MIN_TARGET_PX}×${MIN_TARGET_PX}px.`,
        );
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
        emit(
          "a11y-contrast",
          f.controlRef,
          `${labelOf(f.controlRef) ?? f.controlRef} has a contrast ratio of ${(f.contrastRatio as number).toFixed(2)}:1, below ${MIN_CONTRAST}:1.`,
          "Low-vision users cannot read this control's label.",
          `Raise ${f.controlRef}'s text/background contrast to at least ${MIN_CONTRAST}:1.`,
        );
      }
    }
  } else {
    notChecked.add("contrast");
  }

  return { checked: [...checked], notChecked: [...notChecked], findings };
}
