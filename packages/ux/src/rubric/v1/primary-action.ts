// primary-action.ts — Primary-action clarity (Nielsen #1 + visual hierarchy).
import type { RubricEntry } from "../../types.js";

export const PRIMARY_ACTION: RubricEntry = {
  id: "primary-action",
  principle: "Primary-action clarity — the single next step toward the job is unambiguous",
  citation: {
    source: "Nielsen Norman Group — Visual Hierarchy & Primary Action (Heuristic #1)",
    ref: "nngroup.com/articles/visual-hierarchy-ux-definition",
  },
  tier: "semantic",
  requiredEvidence: ["controls", "visibleText", "job"],
  // primary-action ambiguity needs at least two candidate actions.
  applicability: { minControls: 2 },
  attentionProvenance: "predicted-from-visual-hierarchy",
  questions: [
    {
      id: "primary-action-unambiguous",
      instruction:
        "Is the single next step toward the job unambiguous from what is on screen — one clearly primary action that is visually dominant and unmistakable, not competing on equal footing with other buttons?",
      criteria:
        "There is exactly one visually dominant, correctly-labelled primary action for the job. Failing when two or more actions compete for 'primary', or the true next step is visually recessive.",
      kind: "noul",
      flag: { when: "noul-false" },
      severity: "major",
    },
  ],
};
