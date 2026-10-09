import { z } from "zod";
import { RecordingSchema, StepSchema } from "@jevitate/recording";
import { ApprovalProvenanceSchema } from "./approval-schema.js";

/**
 * #453 — a proposed Journey revision: what a change-aware self-heal (`journey run --self-heal`)
 * found, kept as a reviewable sidecar (`.proposals/<id>.json`, committed with the PR) until a person
 * accepts it (`journey promote <id> --proposal <pid>`) or rejects it. A run never writes the stored
 * Journey. The file is committed, so it holds no secret: step values arrive hidden (`sanitizeStep`),
 * evidence and notes pass `redactSecretParams`, the recording is the Journey's own (which never
 * carries one).
 */

export const HEAL_REJECTION_CODES = [
  "no-match",
  "ambiguous",
  "postcondition-failed",
  "assertion-still-fails",
  "end-state-failed",
  "write-step",
  "irreversible",
  "write-attempted",
  "proof-field-changed",
  "shape-changed",
  "not-explained-by-change",
  "budget-exhausted",
] as const;

const HashSchema = z.string().regex(/^[0-9a-f]{64}$/, "a sha256 hex digest");

export const ChangeEvidenceRefSchema = z
  .object({
    id: z.string().min(1).max(200),
    kind: z.enum(["test-id", "accessible-name", "label", "copy", "route", "redirect", "inserted-ui", "note"]),
    before: z.string().max(2000).optional(),
    after: z.string().max(2000).optional(),
    file: z.string().max(1000).optional(),
    line: z.number().int().min(0).optional(),
  })
  .strict();
export type ChangeEvidenceRefData = z.infer<typeof ChangeEvidenceRefSchema>;

export const HealAttemptSchema = z
  .object({
    n: z.number().int().min(1),
    stepIndex: z.number().int().min(0),
    source: z.enum(["change-evidence", "model"]),
    hypothesis: z.string().max(4000),
    evidence: z.array(ChangeEvidenceRefSchema).max(100),
    candidate: StepSchema.nullable(),
    observation: z.object({ screenshot: z.string().max(1000).optional(), snapshot: z.string().max(1000).optional() }).strict().optional(),
    anchorNotInChange: z.literal(true).optional(),
    result: z.enum(["accepted", "rejected"]),
    rejection: z.object({ code: z.enum(HEAL_REJECTION_CODES), detail: z.string().max(4000) }).strict().optional(),
    usage: z.object({ modelCalls: z.number().int().min(0), tokens: z.number().int().min(0).optional(), ms: z.number().min(0) }).strict(),
  })
  .strict();

export const ProposalStepSchema = z
  .object({
    /** The flat 0-based step index the revision changes. */
    index: z.number().int().min(0),
    before: StepSchema,
    after: StepSchema,
    justification: z
      .object({
        hypothesis: z.string().max(4000),
        evidence: z.array(ChangeEvidenceRefSchema).max(100),
        anchorNotInChange: z.literal(true).optional(),
        /** Advisory only (Jev): never decides acceptance. */
        jevNote: z.string().max(4000).optional(),
      })
      .strict(),
    evidence: z.object({ before: z.string().max(2000).optional(), after: z.string().max(2000).optional() }).strict(),
    /** Screenshot paths of the attempt that produced the candidate (relative to the project, as recorded). */
    screenshots: z.array(z.string().max(1000)).max(10).optional(),
  })
  .strict();
export type ProposalStep = z.infer<typeof ProposalStepSchema>;

export const JourneyProposalSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("journey-proposal"),
    /** sha256(baseHash + steps)[0..12]. */
    proposalId: z.string().regex(/^[0-9a-f]{12}$/, "proposalId: 12 hex characters"),
    journeyId: z.string().min(1).max(256),
    /** `journeyReviewHash` of the stored Journey the revision was made against. */
    baseHash: HashSchema,
    /** `journeyReviewHash` of the Journey as it would be stored on accept. */
    proposedHash: HashSchema,
    createdAt: z.string().min(1),
    /** The full proposed recording; metadata is taken from the stored Journey on accept. */
    recording: RecordingSchema,
    steps: z.array(ProposalStepSchema).min(1).max(100),
    changes: z
      .object({
        range: z.string().max(500).optional(),
        baseSha: z.string().max(100).optional(),
        headSha: z.string().max(100).optional(),
        notes: z.array(z.string().max(2000)).max(20),
      })
      .strict(),
    attempts: z.array(HealAttemptSchema).max(200),
    run: z.object({ resultPath: z.string().max(1000).optional() }).strict(),
  })
  .strict();
export type JourneyProposal = z.infer<typeof JourneyProposalSchema>;

/** `.proposals/<ns>/<id>.rejected/<pid>.json` — a proposal a person turned down, with who and why. */
export const RejectedProposalSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("journey-proposal-rejected"),
    rejectedAt: z.string().min(1),
    reason: z.string().min(1).max(2000),
    provenance: ApprovalProvenanceSchema,
    proposal: JourneyProposalSchema,
  })
  .strict();
export type RejectedProposal = z.infer<typeof RejectedProposalSchema>;

/** What an accepted proposal records on `metadata.approval.proposal`. */
export const ApprovalProposalSchema = z
  .object({ id: z.string().regex(/^[0-9a-f]{12}$/), baseHash: HashSchema, steps: z.array(z.number().int().min(0)).max(100) })
  .strict();
