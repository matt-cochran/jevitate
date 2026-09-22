// load.ts — Cognitive load / choice overload (Hick's Law + Cognitive Load Theory, Sweller).
import type { RubricEntry } from "../../types.js";

export const COGNITIVE_LOAD: RubricEntry = {
  id: "cognitive-load",
  principle: "Cognitive load / choice overload — decision burden vs the job (Hick's Law, CLT)",
  citation: {
    source: "Hick's Law + Cognitive Load Theory (Sweller)",
    ref: "lawsofux.com/hicks-law",
  },
  tier: "semantic",
  requiredEvidence: ["controls", "job"],
  questions: [
    {
      id: "decision-burden",
      instruction:
        "Rate the decision burden this screen imposes relative to the job. 1.0 = a focused, minimal set of choices leads cleanly to the goal; 0.0 = so many simultaneous options/inputs compete that the primary action is diluted and choosing is costly (Hick's Law), or extraneous load is high (Cognitive Load Theory).",
      criteria:
        "Weigh the count and simultaneity of choices/inputs against what the job actually requires here. Low score = choice overload or high extraneous load, not merely a rich screen that the job needs.",
      kind: "score",
      flag: { when: "score-below", threshold: 0.5 },
      severity: "minor",
    },
  ],
};
