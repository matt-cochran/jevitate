// nielsen.ts — Nielsen's 10 usability heuristics (semantic tier).
// Each cites nngroup.com/articles/ten-usability-heuristics and carries ONE
// narrow, calibrated Noul judgment framed against the job + appContext. A
// finding fires when the good property is ABSENT (flag: noul-false).
import type { RubricEntry } from "../../types.js";

const NNG = { source: "Nielsen Norman Group — 10 Usability Heuristics", ref: "nngroup.com/articles/ten-usability-heuristics" } as const;

export const NIELSEN: readonly RubricEntry[] = [
  {
    id: "nielsen-1",
    principle: "Visibility of system status",
    citation: NNG,
    tier: "semantic",
    requiredEvidence: ["controls", "visibleText"],
    questions: [
      {
        id: "status-visible",
        instruction:
          "For a {persona} pursuing the job, does this {appClass} screen keep the user informed of current system state where they would need it — e.g. a visible loading/saving indicator, selection state, or 'step X of Y' progress?",
        criteria:
          "A timely, on-screen indicator communicates the state relevant to the next action. Absent when the user must act blind (no progress, no confirmation, no current-selection cue).",
        kind: "noul",
        flag: { when: "noul-false" },
        severity: "minor",
      },
    ],
  },
  {
    id: "nielsen-2",
    principle: "Match between system and the real world",
    citation: NNG,
    tier: "semantic",
    requiredEvidence: ["controls", "visibleText"],
    // #85: a "jargon" finding whose evidence turns out to be something the run itself typed (a
    // piece title, user-generated content echoed back) is a false positive on the user's own
    // words, not the app's copy — suppressed rather than reported.
    vocabularySensitive: true,
    questions: [
      {
        id: "real-world-language",
        instruction:
          "Does the visible language use words, phrases, and concepts a {persona} already knows for this job, rather than internal jargon, system codes, or developer terminology?",
        criteria:
          "Labels and copy map to the user's domain vocabulary and natural reading order. Failing when jargon/system terms (ids, enum names, internal states) appear in user-facing copy.",
        kind: "noul",
        flag: { when: "noul-false" },
        severity: "minor",
      },
    ],
  },
  {
    id: "nielsen-3",
    principle: "User control and freedom",
    citation: NNG,
    tier: "semantic",
    requiredEvidence: ["controls"],
    questions: [
      {
        id: "escape-hatch",
        instruction:
          "Does the screen give the user a clearly marked way out of the current action — undo, cancel, back, or clear — without forcing them to commit or complete an unwanted path?",
        criteria:
          "A visible control lets the user reverse or exit. Failing when the only visible controls advance/commit and there is no cancel/back/undo affordance.",
        kind: "noul",
        flag: { when: "noul-false" },
        severity: "minor",
      },
    ],
  },
  {
    id: "nielsen-4",
    principle: "Consistency and standards",
    citation: NNG,
    tier: "semantic",
    requiredEvidence: ["controls"],
    questions: [
      {
        id: "consistent-conventions",
        instruction:
          "Do the controls and terminology follow established platform/web conventions and stay internally consistent — the same word for the same thing, standard control patterns for standard tasks?",
        criteria:
          "Conventional affordances (a real submit button for submit, links that look like links) and one term per concept. Failing on nonstandard patterns or the same concept named two ways.",
        kind: "noul",
        flag: { when: "noul-false" },
        severity: "minor",
      },
    ],
  },
  {
    id: "nielsen-5",
    principle: "Error prevention",
    citation: NNG,
    tier: "semantic",
    requiredEvidence: ["controls", "visibleText"],
    questions: [
      {
        id: "prevents-errors",
        instruction:
          "Does the screen actively prevent the errors most likely for this job — sensible defaults, input constraints/formats surfaced up front, and a confirmation step before a destructive or irreversible action?",
        criteria:
          "Constraints, defaults, and guards reduce the chance of a slip or mistake. Failing when a destructive/irreversible action has no confirmation, or a constrained input gives no up-front format guidance.",
        kind: "noul",
        flag: { when: "noul-false" },
        severity: "major",
      },
    ],
  },
  {
    id: "nielsen-6",
    principle: "Recognition rather than recall",
    citation: NNG,
    tier: "semantic",
    requiredEvidence: ["controls", "history"],
    questions: [
      {
        id: "recognition-over-recall",
        instruction:
          "Can the user proceed toward the job using only what is visible/recognizable on this screen, without having to remember specific details (values, codes, choices) from an earlier screen?",
        criteria:
          "Needed options and previously-entered context are shown or retrievable in place. Failing when the user must recall a value/choice from a prior step that is not surfaced here.",
        kind: "noul",
        flag: { when: "noul-false" },
        severity: "minor",
      },
    ],
  },
  {
    id: "nielsen-7",
    principle: "Flexibility and efficiency of use",
    citation: NNG,
    tier: "semantic",
    requiredEvidence: ["controls"],
    questions: [
      {
        id: "efficiency-accelerators",
        instruction:
          "Does the screen offer an efficient path for a returning or expert user — shortcuts, sensible prefilled defaults, or bulk/batch actions — without making the first-time path harder?",
        criteria:
          "Accelerators exist for the frequent case and do not clutter the novice path. Failing when every user, expert or not, is forced through the same slow, step-by-step interaction.",
        kind: "noul",
        flag: { when: "noul-false" },
        severity: "info",
      },
    ],
  },
  {
    id: "nielsen-8",
    principle: "Aesthetic and minimalist design",
    citation: NNG,
    tier: "semantic",
    requiredEvidence: ["controls", "visibleText"],
    questions: [
      {
        id: "signal-over-noise",
        instruction:
          "Is the screen free of extraneous content and controls that compete with the information the user needs for this job right now?",
        criteria:
          "Every prominent element earns its place for the current job. Failing when secondary content, promos, or rarely-needed controls dilute the primary information and dominate attention.",
        kind: "noul",
        flag: { when: "noul-false" },
        severity: "info",
      },
    ],
  },
  {
    id: "nielsen-9",
    principle: "Help users recognize, diagnose, and recover from errors",
    citation: NNG,
    tier: "semantic",
    requiredEvidence: ["visibleText"],
    questions: [
      {
        id: "error-recovery",
        instruction:
          "Where an error state is present or likely on this screen, is it expressed in plain language that names the problem precisely and states the concrete recovery action — not a code or a generic 'something went wrong'?",
        criteria:
          "Error messaging identifies the cause and the fix in the user's terms. Failing on raw codes, generic failures, or an error with no stated path to recover.",
        kind: "noul",
        flag: { when: "noul-false" },
        severity: "major",
      },
    ],
  },
  {
    id: "nielsen-10",
    principle: "Help and documentation",
    citation: NNG,
    tier: "semantic",
    requiredEvidence: ["controls", "visibleText"],
    questions: [
      {
        id: "contextual-help",
        instruction:
          "Where the task on this screen is non-obvious, is contextual help or guidance available in place (tooltip, inline hint, help link) so the user can complete the job without leaving the flow?",
        criteria:
          "Help is discoverable at the point of need and scoped to the task. Failing when a genuinely non-obvious step has no in-context guidance at all.",
        kind: "noul",
        flag: { when: "noul-false" },
        severity: "info",
      },
    ],
  },
];
