// disclosure.ts — Progressive disclosure ranking (NN/g).
import type { RubricEntry } from "../../types.js";

export const DISCLOSURE: RubricEntry = {
  id: "progressive-disclosure",
  principle: "Progressive disclosure — essential actions prominent, advanced options deferred",
  citation: {
    source: "Nielsen Norman Group — Progressive Disclosure",
    ref: "nngroup.com/articles/progressive-disclosure",
  },
  tier: "semantic",
  requiredEvidence: ["controls", "job"],
  questions: [
    {
      id: "disclosure-quality",
      instruction:
        "Rate how well this screen practices progressive disclosure for a {persona} doing the job. 1.0 = only the controls essential to the job right now are prominent, and secondary/advanced/rarely-used options are tucked into a deeper level; 0.0 = advanced or rarely-needed options are exposed at the same prominence as the essential path.",
      criteria:
        "Classify each control as essential-now / secondary / advanced for the job, then judge the exposure. Low score = advanced options compete for attention with the primary path, inflating perceived complexity.",
      kind: "score",
      flag: { when: "score-below", threshold: 0.5 },
      severity: "minor",
    },
  ],
};
