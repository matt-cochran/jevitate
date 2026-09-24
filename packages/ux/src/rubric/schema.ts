// schema.ts — Zod validation + loader for rubric entries.
//
// The loader enforces the structural gates the spec requires at LOAD time:
//   - a citation is mandatory (a finding cannot cite a rubric item that has none);
//   - every entry has ≥1 question;
//   - every `requiredEvidence` key is a KNOWN `UxEvidence` field (anti-masquerade:
//     an entry that references an unknown/unpopulated field would silently
//     always-Skip — we refuse it at load, naming the entry and field).
import { z } from "zod";
import { UX_EVIDENCE_KEYS } from "../types.js";
import type { RubricEntry } from "../types.js";

export class RubricLoadError extends Error {
  readonly code = "E_UX_RUBRIC_INVALID" as const;
  constructor(message: string) {
    super(message);
    this.name = "RubricLoadError";
  }
}

const FlagRuleSchema = z.discriminatedUnion("when", [
  z.object({ when: z.literal("noul-true") }).strict(),
  z.object({ when: z.literal("noul-false") }).strict(),
  z.object({ when: z.literal("score-below"), threshold: z.number().min(0).max(1) }).strict(),
  z.object({ when: z.literal("score-above"), threshold: z.number().min(0).max(1) }).strict(),
  z.object({ when: z.literal("choice-in"), options: z.array(z.string()).min(1) }).strict(),
]);

export const JevQuestionSpecSchema = z
  .object({
    id: z.string().min(1),
    instruction: z.string().min(1),
    criteria: z.string().min(1),
    kind: z.enum(["choice", "noul", "score"]),
    choices: z.array(z.string()).min(2).optional(),
    flag: FlagRuleSchema,
    severity: z.enum(["info", "minor", "major"]),
  })
  .strict()
  .superRefine((q, ctx) => {
    if (q.kind === "choice" && (!q.choices || q.choices.length < 2)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a 'choice' question requires ≥2 choices", path: ["choices"] });
    }
    if (q.kind === "choice" && q.flag.when !== "choice-in") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a 'choice' question must flag via 'choice-in'", path: ["flag"] });
    }
    if (q.kind === "noul" && q.flag.when !== "noul-true" && q.flag.when !== "noul-false") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a 'noul' question must flag via 'noul-true'/'noul-false'", path: ["flag"] });
    }
    if (q.kind === "score" && q.flag.when !== "score-below" && q.flag.when !== "score-above") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a 'score' question must flag via 'score-below'/'score-above'", path: ["flag"] });
    }
  });

export const RubricEntrySchema = z
  .object({
    id: z.string().min(1),
    principle: z.string().min(1),
    citation: z
      .object({ source: z.string().min(1), ref: z.string().min(1) })
      .strict(),
    tier: z.enum(["semantic", "behavioral", "objective-a11y"]),
    questions: z.array(JevQuestionSpecSchema).min(1, "a rubric entry needs ≥1 question"),
    requiredEvidence: z.array(z.enum(UX_EVIDENCE_KEYS)).min(1),
    attentionProvenance: z.string().min(1).optional(),
    applicability: z.object({ minControls: z.number().int().min(1).optional() }).strict().optional(),
  })
  .strict();

/**
 * Validates and indexes rubric entries into a `Map<id, RubricEntry>`. Throws a
 * `RubricLoadError` naming the offending entry (and field) on any invalid entry
 * or duplicate id — never silently drops.
 */
export function loadRubric(entries: readonly unknown[]): Map<string, RubricEntry> {
  const map = new Map<string, RubricEntry>();
  entries.forEach((raw, i) => {
    const parsed = RubricEntrySchema.safeParse(raw);
    if (!parsed.success) {
      const id = (raw as { id?: unknown } | null)?.id;
      const label = typeof id === "string" && id.length > 0 ? `'${id}'` : `at index ${i}`;
      const issues = parsed.error.issues
        .map((iss) => `${iss.path.join(".") || "(root)"}: ${iss.message}`)
        .join("; ");
      throw new RubricLoadError(`rubric entry ${label} is invalid — ${issues}`);
    }
    if (map.has(parsed.data.id)) {
      throw new RubricLoadError(`duplicate rubric entry id '${parsed.data.id}'`);
    }
    map.set(parsed.data.id, parsed.data as RubricEntry);
  });
  return map;
}
