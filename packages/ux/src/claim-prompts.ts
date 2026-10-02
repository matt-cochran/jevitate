// claim-prompts.ts — the versioned wording of the claim pipeline (#198): what Jev is asked when
// it categorizes friction, picks a target control, checks a duplicate and grades a finding, and
// the TEMPLATES finding prose is built from. Zod-validated at load (`assets/ux-claims.json`); a
// template placeholder with no value throws (a finding never ships with a literal "{control}").
import { z } from "zod";
import raw from "./assets/ux-claims.json" with { type: "json" };

/** Every claim type a finding can carry. `fact-conflict` is found by code only (never offered to Jev). */
export const CLAIM_TYPES = ["destructive-unguarded", "fact-conflict", "next-step-unclear", "no-feedback", "blocked-action", "error-unrecoverable"] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** The closed list Jev chooses from to explain one observed friction point. */
export const FRICTION_CLAIM_CHOICES = ["no-feedback", "blocked-action", "error-unrecoverable", "next-step-unclear", "destructive-unguarded", "not-a-problem"] as const;
export type FrictionClaimChoice = (typeof FRICTION_CLAIM_CHOICES)[number];

export const TEMPLATE_KEYS = [
  "destructive-unguarded",
  "fact-conflict.price",
  "fact-conflict.trial",
  "next-step-unclear.absent",
  "next-step-unclear.disabled",
  "next-step-unclear.friction",
  "next-step-unclear.observed",
  "no-feedback",
  "blocked-action",
  "error-unrecoverable",
] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

const Template = z.object({ observation: z.string().min(1), userImpact: z.string().min(1), recommendation: z.string().min(1) }).strict();
const Probability = z.number().min(0).max(1);

export const ClaimPromptsSchema = z
  .object({
    version: z.string().regex(/^ux-claims@\d+$/),
    notes: z.string(),
    types: z.object(Object.fromEntries(FRICTION_CLAIM_CHOICES.map((t) => [t, z.string().min(1)])) as Record<FrictionClaimChoice, z.ZodString>).strict(),
    classify: z.object({ type: z.string().includes("{friction}"), target: z.string().includes("{friction}") }).strict(),
    duplicate: z.string().includes("{finding}"),
    grade: z.object({ need: z.string().includes("{finding}"), ship: z.string().includes("{finding}").includes("{feature}") }).strict(),
    /**
     * The two-question grade → label mapping (code): need ≥ `need` → ship ≥ `ship` ? actionable :
     * relevant-minor; else need ≤ `wrong` ? wrong : generic. Tuned on fixtures only (see notes).
     */
    cutoffs: z.object({ need: Probability, ship: Probability, wrong: Probability }).strict(),
    templates: z.object(Object.fromEntries(TEMPLATE_KEYS.map((k) => [k, Template])) as Record<TemplateKey, typeof Template>).strict(),
  })
  .strict()
  .refine((p) => p.cutoffs.wrong <= p.cutoffs.need, { message: "cutoffs.wrong must not exceed cutoffs.need" });
export type ClaimPrompts = z.infer<typeof ClaimPromptsSchema>;

/** The shipped claim wording (validated at module load — a malformed asset fails loudly). */
export const CLAIM_PROMPTS: ClaimPrompts = ClaimPromptsSchema.parse(raw);

export class ClaimTemplateError extends Error {
  readonly code = "E_UX_CLAIM_TEMPLATE" as const;
}

/** Fills `{name}` placeholders. A placeholder with no value throws — never a half-filled sentence. */
export function fillClaimTemplate(text: string, vars: Readonly<Record<string, string>>): string {
  return text.replace(/\{([A-Za-z]+)\}/g, (_, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new ClaimTemplateError(`claim template placeholder {${name}} has no value`);
    return v;
  });
}
