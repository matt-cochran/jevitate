// a11y.ts — Objective accessibility tier (honest subset).
//
// These entries exist so the DETERMINISTIC a11y checker (src/a11y.ts) can cite a
// rubric item for each computed check. They are `objective-a11y` tier and the
// analyzer never sends them to Jev — their `questions` document the check
// criterion (schema requires ≥1) but the verdict is computed from snapshot facts,
// never modelled. Output copy avoids the words "accessible"/"WCAG-compliant": we
// report only the subset we verified, never a compliance claim.
import type { RubricEntry } from "../../types.js";

// Cite the standard as provenance (this is a reference, NOT a compliance verdict).
const ACT = { source: "W3C ACT Rules / WAI-ARIA", ref: "w3.org/WAI/standards-guidelines/act/rules" } as const;

export const A11Y: readonly RubricEntry[] = [
  {
    id: "a11y-control-name",
    principle: "Every interactive control exposes a programmatic name to assistive technology",
    citation: ACT,
    tier: "objective-a11y",
    requiredEvidence: ["controls", "a11yFacts"],
    questions: [
      {
        id: "has-name",
        instruction: "Each interactive control has a non-empty programmatic name.",
        criteria: "Computed name (label / aria-label / text) is present and non-empty for the control.",
        kind: "noul",
        flag: { when: "noul-false" },
        severity: "major",
      },
    ],
  },
  {
    id: "a11y-focus-order",
    principle: "Focus order follows a logical interaction sequence",
    citation: ACT,
    tier: "objective-a11y",
    requiredEvidence: ["controls", "a11yFacts"],
    questions: [
      {
        id: "logical-focus-order",
        instruction: "The declared focus order is monotonic and free of duplicate/negative positions.",
        criteria: "Focus indices form a strictly increasing sequence with no collisions.",
        kind: "noul",
        flag: { when: "noul-false" },
        severity: "minor",
      },
    ],
  },
  {
    id: "a11y-target-size",
    principle: "Interactive targets meet the minimum target size",
    citation: { source: "W3C WCAG 2.2 SC 2.5.8 Target Size (Minimum)", ref: "w3.org/TR/WCAG22/#target-size-minimum" },
    tier: "objective-a11y",
    requiredEvidence: ["controls", "a11yFacts"],
    questions: [
      {
        id: "min-target-size",
        instruction: "Each interactive target is at least 24x24 CSS px (where size is known).",
        criteria: "min(width,height) >= 24 for controls with a known target size.",
        kind: "noul",
        flag: { when: "noul-false" },
        severity: "minor",
      },
    ],
  },
  {
    id: "a11y-contrast",
    principle: "Text meets the minimum contrast ratio where computable",
    citation: { source: "W3C WCAG 2.1 SC 1.4.3 Contrast (Minimum)", ref: "w3.org/TR/WCAG21/#contrast-minimum" },
    tier: "objective-a11y",
    requiredEvidence: ["controls", "a11yFacts"],
    questions: [
      {
        id: "min-contrast",
        instruction: "Each control with a known contrast ratio meets at least 4.5:1.",
        criteria: "contrastRatio >= 4.5 for controls where contrast is computable; unknown contrast is reported as not-checked, never assumed passing.",
        kind: "noul",
        flag: { when: "noul-false" },
        severity: "minor",
      },
    ],
  },
];
