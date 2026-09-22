// dark-patterns.ts — Deceptive/dark-pattern detection (Brignull deceptive-patterns taxonomy).
// One entry, three narrow per-pattern Noul judgments. A finding fires on PRESENCE
// of the pattern (flag: noul-true).
import type { RubricEntry } from "../../types.js";

export const DARK_PATTERNS: RubricEntry = {
  id: "dark-patterns",
  principle: "Deceptive patterns — confirmshaming, misdirection, forced continuity",
  citation: {
    source: "Deceptive Patterns taxonomy — Harry Brignull",
    ref: "deceptive.design/types",
  },
  tier: "semantic",
  requiredEvidence: ["visibleText", "controls"],
  questions: [
    {
      id: "confirmshaming",
      instruction:
        "Does any decline / opt-out / dismiss option use guilt, shame, or loaded wording to pressure the user away from the choice they might reasonably want (confirmshaming)?",
      criteria:
        "Look at the wording of negative/decline options. Present when the opt-out is phrased to make the user feel bad ('No thanks, I don't want to save money'). Neutral decline wording is NOT a finding.",
      kind: "noul",
      flag: { when: "noul-true" },
      severity: "major",
    },
    {
      id: "misdirection",
      instruction:
        "Does the visual hierarchy or wording deliberately steer the user toward a choice that benefits the business over the user's stated job (misdirection) — e.g. a bright 'upgrade' button dwarfing the plain path the user actually wants?",
      criteria:
        "Compare emphasis given to the business-preferred option vs the user's job path. Present when attention is engineered toward the business's interest against the user's. Legitimate emphasis on the user's own goal is NOT a finding.",
      kind: "noul",
      flag: { when: "noul-true" },
      severity: "major",
    },
    {
      id: "forced-continuity",
      instruction:
        "Does the screen set up an automatic charge, renewal, or ongoing commitment without clear, prominent disclosure of the terms and an easy way to decline or exit (forced continuity)?",
      criteria:
        "Present when a recurring charge / auto-renewal / trial-to-paid is implied or set without conspicuous terms and an easy opt-out. Fully-disclosed, easily-cancellable subscriptions are NOT a finding.",
      kind: "noul",
      flag: { when: "noul-true" },
      severity: "major",
    },
  ],
};
