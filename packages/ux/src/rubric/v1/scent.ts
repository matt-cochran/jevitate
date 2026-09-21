// scent.ts — Information scent (Information Foraging Theory; Pirolli & Card).
import type { RubricEntry } from "../../types.js";

export const SCENT: RubricEntry = {
  id: "scent",
  principle: "Information scent — labels predict their destination relative to the job",
  citation: {
    source: "Information Foraging Theory — Pirolli & Card",
    ref: "nngroup.com/articles/information-scent",
  },
  tier: "semantic",
  requiredEvidence: ["controls", "job"],
  questions: [
    {
      id: "scent-strength",
      instruction:
        "Rate how well the actionable controls' labels and affordances let the user predict, before clicking, which one advances the job — i.e. the strength of the information scent toward the goal. 1.0 = each next step's label unambiguously signals its destination; 0.0 = the user must guess or click to find out.",
      criteria:
        "Judge the whole screen's set of actionable controls against the job. Weak scent = vague/generic labels ('Continue', 'More', 'Options'), competing look-alike actions, or the job-advancing control indistinguishable from the rest.",
      kind: "score",
      flag: { when: "score-below", threshold: 0.6 },
      severity: "minor",
    },
  ],
};
