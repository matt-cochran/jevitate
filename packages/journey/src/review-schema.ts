import { z } from "zod";
import { FindingSchema, JevLayerSchema, JourneyCatalogLinksSchema } from "./catalog-schema.js";
import { AcceptedFindingsSchema } from "./journey.js";

/**
 * #432 — the JSON shape of a Journey's review sheet (`jevitate journey review <id> --json`, MCP
 * `review_journey`): what a reviewer reads before `journey promote`. Built by the CLI's
 * `buildJourneyReview`; every field here is a name, a description or a check — never a value a
 * secret parameter takes (values only ever arrive as `--param` and are never part of a Journey).
 */

const ReviewTargetSchema = z.object({ role: z.string().optional(), name: z.string().optional() }).strict();

export const ReviewStepSchema = z
  .object({
    /** 1-based, counted the way `--at-step` counts. */
    number: z.number().int().min(1),
    kind: z.string(),
    /** The action in plain words (a fill shows `<param x>` or «redacted», never a secret). */
    action: z.string(),
    target: ReviewTargetSchema.optional(),
    objective: z.string().optional(),
    expectedResult: z.string().optional(),
    /** The step's own page postcondition, in the `--success` spec syntax. */
    assertion: z.string().optional(),
    /** Parameters (by name) the step uses. */
    params: z.array(z.string()),
  })
  .strict();

export const ReviewWriteRequestSchema = z
  .object({
    method: z.string(),
    endpoint: z.string(),
    /** `recorded` (the step's recorded delta), `expect-request` (its request check), `end-state` (a network end-state check). */
    source: z.enum(["recorded", "expect-request", "end-state"]),
    step: z.number().int().min(1).optional(),
  })
  .strict();

export const ReviewRiskyControlSchema = z
  .object({
    step: z.number().int().min(1),
    control: z.string(),
    role: z.string().optional(),
    risk: z.string(),
    /** The safety rule id (`builtin:destructive`, `paid:<pattern>`, `deny:<pattern>`, …). */
    ruleId: z.string(),
    /** The `--allow-control` regex (targets.json `safety.allowControl`) that exempts it, when one does. */
    waivedBy: z.string().optional(),
  })
  .strict();

export const ReviewLintFindingSchema = z
  .object({ rule: z.string(), level: z.enum(["error", "warning"]), step: z.number().int().optional(), message: z.string() })
  .strict();

export const ReviewVerifySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not-verified"), hint: z.string() }).strict(),
  z
    .object({
      status: z.literal("recorded"),
      verdict: z.string(),
      at: z.string(),
      /** True when the Journey changed after this proof ran (the verdict is for other content). */
      stale: z.boolean(),
      reason: z.string().optional(),
      summary: z.record(z.string(), z.number()),
    })
    .strict(),
]);

const DiffSchema = z.object({ added: z.array(z.string()), removed: z.array(z.string()) }).strict();

export const ReviewChangeSchema = z.discriminatedUnion("kind", [
  /** Never approved, and nothing to diff against. */
  z.object({ kind: z.literal("first-approval") }).strict(),
  /** Promoted before approvals were recorded (no approval, no snapshot). */
  z.object({ kind: z.literal("no-record") }).strict(),
  /** Approved, but its approved snapshot is gone: only the hash can be compared. */
  z.object({ kind: z.literal("snapshot-missing"), approvedHash: z.string(), approvedAt: z.string().optional(), changed: z.boolean() }).strict(),
  z
    .object({
      kind: z.literal("diff"),
      approvedHash: z.string(),
      approvedAt: z.string().optional(),
      changed: z.boolean(),
      steps: DiffSchema,
      assertions: DiffSchema,
      sideEffects: DiffSchema,
    })
    .strict(),
]);

export const JourneyReviewSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    promoted: z.boolean(),
    summary: z
      .object({
        description: z.string().optional(),
        goal: z.string().optional(),
        persona: z.string().optional(),
        role: z.string().optional(),
        requiresAuth: z.boolean(),
        preconditions: z.array(z.string()),
        successCriteria: z.array(z.object({ description: z.string(), check: z.string().optional() }).strict()),
        /** What intent is missing (no goal, no success criteria, steps without an objective), with how to draft it. */
        missingIntent: z.array(z.string()),
      })
      .strict(),
    steps: z.array(ReviewStepSchema),
    sideEffects: z
      .object({
        writeRequests: z.array(ReviewWriteRequestSchema),
        riskyControls: z.array(ReviewRiskyControlSchema),
        origins: z.array(z.string()),
      })
      .strict(),
    inputs: z
      .object({
        params: z.array(z.object({ name: z.string(), description: z.string().optional(), secret: z.boolean() }).strict()),
        /** Secret references, by field and manager only — never a value, never the manager's key. */
        secrets: z.array(z.object({ field: z.string(), manager: z.string(), origin: z.string() }).strict()),
      })
      .strict(),
    proof: z
      .object({
        endState: z.array(z.string()),
        stepAssertions: z.array(z.object({ step: z.number().int(), check: z.string(), weak: z.boolean() }).strict()),
        lint: z.object({ errors: z.number().int(), warnings: z.number().int(), findings: z.array(ReviewLintFindingSchema) }).strict(),
        acceptedWeak: z.object({ reason: z.string(), rules: z.array(z.string()) }).strict().optional(),
        verify: ReviewVerifySchema,
      })
      .strict(),
    changeSinceApproval: ReviewChangeSchema,
    approval: z
      .object({
        contentHash: z.string(),
        at: z.string(),
        acceptedWeak: z.object({ reason: z.string(), rules: z.array(z.string()) }).strict().optional(),
        waivers: z.array(z.object({ kind: z.literal("unvetted"), reason: z.string(), items: z.array(z.string()) }).strict()).optional(),
        acceptedFindings: AcceptedFindingsSchema.optional(),
      })
      .strict()
      .optional(),
    /** #433: the Journey's catalog links (job, persona) and their approval state — set when the catalog was loaded. */
    catalog: JourneyCatalogLinksSchema.optional(),
    /** #433: the pre-approval findings (`preApprovalFindings`) — set when the catalog was loaded. */
    findings: z.array(FindingSchema).optional(),
    /** #434: the advisory Jev layer of the findings (the readiness questions). */
    jev: JevLayerSchema.optional(),
    /** `journeyReviewHash`: what `journey promote --reviewed-hash` binds an approval to. */
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type JourneyReview = z.infer<typeof JourneyReviewSchema>;
export type JourneyReviewStep = z.infer<typeof ReviewStepSchema>;
export type JourneyReviewWriteRequest = z.infer<typeof ReviewWriteRequestSchema>;
export type JourneyReviewRiskyControl = z.infer<typeof ReviewRiskyControlSchema>;
export type JourneyReviewVerify = z.infer<typeof ReviewVerifySchema>;
export type JourneyReviewChange = z.infer<typeof ReviewChangeSchema>;
