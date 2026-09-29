// prompts.ts — the versioned, app-agnostic prompt + rubric-description assets.
//
// Every model-facing string the UX review tunes lives in `assets/ux-prompts.json`, not inline:
// the applicability question, the finding-specifics instructions, the quality grader's
// criteria and the rubric items' instruction/criteria text. The asset is Zod-validated at load
// and carries a `version`; `scripts/ux-quality` measures a version and records its content hash
// in `assets/ux-quality-baseline.json`, which the regression test pins.
import { z } from "zod";
import raw from "./assets/ux-prompts.json" with { type: "json" };
import type { RubricEntry } from "./types.js";

export const QUALITY_LABELS = ["actionable", "relevant-minor", "generic", "wrong"] as const;
export type QualityLabel = (typeof QUALITY_LABELS)[number];

const QuestionText = z.object({ instruction: z.string().min(1), criteria: z.string().min(1) }).strict();

export const UxPromptsSchema = z
  .object({
    version: z.string().regex(/^ux-prompts@\d+$/),
    notes: z.string(),
    applicability: z.string().includes("{principle}"),
    thresholds: z
      .object({
        /**
         * A Jev flag whose violation probability is below this margin is not sent for specifics:
         * judgments near 0.5 flip run to run, so they are counted (suppressed, not-confirmed) but
         * never shown — this is the main run-to-run consistency lever.
         */
        minViolation: z.number().min(0).max(1),
      })
      .strict(),
    specifics: z.array(z.string().min(1)).min(1),
    grader: z
      .object({
        instructions: z.string().includes("{finding}"),
        labels: z.object({
          actionable: z.string().min(1),
          "relevant-minor": z.string().min(1),
          generic: z.string().min(1),
          wrong: z.string().min(1),
        }).strict(),
      })
      .strict(),
    rubric: z.record(
      z.string(),
      z.object({ principle: z.string().min(1), questions: z.record(z.string(), QuestionText) }).strict(),
    ),
  })
  .strict();
export type UxPrompts = z.infer<typeof UxPromptsSchema>;

/** The shipped prompt assets (validated at module load — a malformed asset fails loudly). */
export const UX_PROMPTS: UxPrompts = UxPromptsSchema.parse(raw);

export class PromptAssetError extends Error {
  readonly code = "E_UX_PROMPT_ASSET" as const;
}

/**
 * Applies the asset's tuned principle/instruction/criteria text to rubric entries. Every
 * semantic question MUST have asset text — a missing description throws (never a silent
 * fallback to stale inline text).
 */
export function applyRubricDescriptions(entries: readonly RubricEntry[], prompts: UxPrompts = UX_PROMPTS): RubricEntry[] {
  return entries.map((e) => {
    if (e.tier === "objective-a11y") return e;
    const text = prompts.rubric[e.id];
    if (!text) throw new PromptAssetError(`prompt asset ${prompts.version} has no description for rubric item '${e.id}'`);
    return {
      ...e,
      principle: text.principle,
      questions: e.questions.map((q) => {
        const t = text.questions[q.id];
        if (!t) throw new PromptAssetError(`prompt asset ${prompts.version} has no text for '${e.id}::${q.id}'`);
        return { ...q, instruction: t.instruction, criteria: t.criteria };
      }),
    };
  });
}
