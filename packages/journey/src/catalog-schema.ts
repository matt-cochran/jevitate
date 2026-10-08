import { z } from "zod";
import { AcceptedFindingsSchema } from "./journey.js";

/**
 * #433 — the human-vetted catalog: personas (`.jevitate/personas.json`, the #427 file, extended) and
 * jobs (`.jevitate/jobs.json`, job stories) that Journeys link to (`metadata.persona`, `metadata.job`).
 * Each persona and job is `draft` until a person approves it (`jevitate persona|job approve <id>`,
 * CLI only); the approval binds to the item's content hash, so an edit makes it `stale` (needs
 * re-review) — and every Journey linked to it with it.
 *
 * A job is a job story (https://learningloop.io/glossary/job-stories-jtbd):
 * "When [trigger], I want to [motivation], so I can [outcome]." — stored as its three parts.
 */

/** A catalog id: one safe path segment (the Journey id rule; a persona's is its #427 name). */
export const CATALOG_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CatalogIdSchema = z.string().regex(CATALOG_ID_RE, "an id: 1-64 of [A-Za-z0-9._-], starting alphanumeric");

/** #433: a persona's or a job's approval — the content hash approved, when, and any acknowledged findings. */
export const CatalogApprovalSchema = z
  .object({
    contentHash: z.string().regex(/^[0-9a-f]{64}$/, "approval.contentHash: a sha256 hex digest"),
    at: z.string().min(1),
    acceptedFindings: AcceptedFindingsSchema.optional(),
  })
  .strict();
export type CatalogApproval = z.infer<typeof CatalogApprovalSchema>;

/** `draft` (never approved), `approved` (approved as it is), `stale` (edited since its approval: needs re-review). */
export const CatalogStatusValueSchema = z.enum(["draft", "approved", "stale"]);
export type CatalogItemStatus = z.infer<typeof CatalogStatusValueSchema>;

const storyPart = (part: "trigger" | "motivation" | "outcome", words: string) =>
  z
    .string({
      error: (iss) =>
        iss.input === undefined
          ? `missing ${part} — a job story is "When [trigger], I want to [motivation], so I can [outcome]." (${words})`
          : `${part} must be text — ${words}`,
    })
    .max(500)
    .refine((s) => s.trim() !== "", { message: `empty ${part} — ${words}` });

export const JOB_PRIORITIES = ["high", "medium", "low"] as const;

/**
 * #433: one job in `.jevitate/jobs.json` — a job story `{id, trigger, motivation, outcome}`, the
 * personas it serves, an optional priority. A job missing any of the three story parts is refused.
 * The test-campaign planning fields (`goal`, `success`, `preconditions`, `mutates`, `order`,
 * `storageState`) and the legacy single `persona` (folded into `personas`) are still accepted.
 */
export const JobSchema = z
  .object({
    id: CatalogIdSchema,
    trigger: storyPart("trigger", "the situation: \"When [trigger]\""),
    motivation: storyPart("motivation", "what they want to do: \"I want to [motivation]\""),
    outcome: storyPart("outcome", "what it lets them do: \"so I can [outcome]\""),
    personas: z.array(CatalogIdSchema).max(50).optional(),
    priority: z.enum(JOB_PRIORITIES).optional(),
    approval: CatalogApprovalSchema.optional(),
    // test-campaign planning fields (jevitate-test-campaign "Job spec"), kept for compatibility.
    persona: CatalogIdSchema.optional(),
    storageState: z.string().max(1000).optional(),
    goal: z.string().max(2000).optional(),
    success: z.array(z.string().max(1000)).max(50).optional(),
    preconditions: z.array(z.string().max(1000)).max(50).optional(),
    mutates: z.boolean().optional(),
    order: z.number().int().optional(),
  })
  .strict()
  .refine((j) => new Set(j.personas ?? []).size === (j.personas ?? []).length, { message: "personas: duplicate id", path: ["personas"] });
export type Job = z.infer<typeof JobSchema>;

function clause(s: string, lead: RegExp): string {
  return s.trim().replace(lead, "").replace(/[.\s]+$/, "").trim();
}

/** #433: the job story in the template's words: "When …, I want to …, so I can …." */
export function renderJobStory(job: Pick<Job, "trigger" | "motivation" | "outcome">): string {
  const trigger = clause(job.trigger, /^when\s+/i);
  const motivation = clause(job.motivation, /^i\s+want\s+to\s+/i);
  const outcome = clause(job.outcome, /^so\s+(?:that\s+)?i\s+can\s+/i);
  return `When ${trigger}, I want to ${motivation}, so I can ${outcome}.`;
}

/**
 * #433: one pre-approval finding (`preApprovalFindings`, rendered in every review sheet before an
 * approval). `requiresAcknowledgment: true` refuses the approval (E_APPROVAL_FINDINGS, exit 1)
 * unless the approver gives `--accept-findings "<reason>"`; every other finding is informational.
 * `characteristic` (an INCOSE GtWR characteristic) and `probability` (a Jev answer's) are for the
 * readiness (#434) and catalog-analysis (#435) analyzers.
 */
export const FindingSchema = z
  .object({
    /** The analyzer that produced it (`catalog-links`, …). */
    analyzer: z.string().min(1),
    /** A stable code within the analyzer (`job.unknown-persona`, …). */
    code: z.string().min(1),
    severity: z.enum(["info", "warn", "fail"]),
    message: z.string(),
    fix: z.string().optional(),
    requiresAcknowledgment: z.boolean(),
    /** The other catalog items involved, as `persona:<id>` / `job:<id>` / `journey:<id>`. */
    items: z.array(z.string()).optional(),
    characteristic: z.string().optional(),
    probability: z.number().min(0).max(1).optional(),
  })
  .strict();
export type Finding = z.infer<typeof FindingSchema>;

/**
 * #434: what one call's model usage cost (the shape of ai-core's `UsageCounts`, so the CLI's
 * usage line and `jevitate report` read it like any run's usage).
 */
export const JudgmentUsageSchema = z
  .object({
    judgments: z.number().int().min(0),
    generations: z.number().int().min(0),
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    jevUsd: z.number().optional(),
    generationUsd: z.number().optional(),
    totalUsd: z.number().optional(),
    priced: z.enum(["full", "partial", "none"]),
    priceSource: z.array(z.string()).optional(),
    missing: z.array(z.string()).optional(),
    failedCalls: z.number().int().optional(),
  })
  .strict();

/**
 * #434: whether the advisory Jev layer ran for a sheet — `skipped` with the
 * reason (`pass --real`, `no judgment key`), or `ran` with how many questions went to the model
 * (`asked`) and how many answers came from the content-hash cache (`cached`), and what it cost.
 */
export const JevLayerSchema = z
  .object({
    status: z.enum(["ran", "skipped"]),
    reason: z.string().optional(),
    asked: z.number().int().min(0),
    cached: z.number().int().min(0),
    usage: JudgmentUsageSchema.optional(),
  })
  .strict();
export type JevLayer = z.infer<typeof JevLayerSchema>;

const JourneyRefSchema = z.object({ id: z.string(), name: z.string(), promoted: z.boolean(), needsReReview: z.boolean() }).strict();

/** #433: `jevitate persona review <id> --json` (MCP `review_persona`). */
export const PersonaReviewSchema = z
  .object({
    id: z.string(),
    description: z.string().optional(),
    role: z.string().optional(),
    status: CatalogStatusValueSchema,
    needsReReview: z.boolean(),
    /** Session settings, as presence only (never a path's content, never a credential). */
    session: z.object({ storageState: z.boolean(), login: z.boolean() }).strict(),
    jobs: z.array(z.object({ id: z.string(), story: z.string(), status: CatalogStatusValueSchema }).strict()),
    journeys: z.array(JourneyRefSchema),
    findings: z.array(FindingSchema),
    /** #434: the advisory Jev layer of the findings (the readiness questions). */
    jev: JevLayerSchema.optional(),
    approval: CatalogApprovalSchema.optional(),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type PersonaReview = z.infer<typeof PersonaReviewSchema>;

/** #433: `jevitate job review <id> --json` (MCP `review_job`). */
export const JobReviewSchema = z
  .object({
    id: z.string(),
    story: z.string(),
    trigger: z.string(),
    motivation: z.string(),
    outcome: z.string(),
    priority: z.enum(JOB_PRIORITIES).optional(),
    status: CatalogStatusValueSchema,
    needsReReview: z.boolean(),
    personas: z.array(
      z
        .object({
          id: z.string(),
          /** `unknown`: not declared in personas.json. */
          status: z.union([CatalogStatusValueSchema, z.literal("unknown")]),
          journeys: z.array(z.string()),
          promotedJourneys: z.array(z.string()),
        })
        .strict(),
    ),
    /** Personas this job serves that have no promoted Journey for it. */
    gaps: z.array(z.string()),
    journeys: z.array(JourneyRefSchema.extend({ persona: z.string().optional() }).strict()),
    findings: z.array(FindingSchema),
    /** #434: the advisory Jev layer of the findings (the readiness questions). */
    jev: JevLayerSchema.optional(),
    approval: CatalogApprovalSchema.optional(),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type JobReview = z.infer<typeof JobReviewSchema>;

/** #433: one Journey's catalog links, as its review sheet (`journey review`) shows them. */
export const JourneyCatalogLinksSchema = z
  .object({
    /** False when the Journey links no job and no catalog persona (it promotes as before). */
    linked: z.boolean(),
    job: z.object({ id: z.string(), status: z.union([CatalogStatusValueSchema, z.literal("unknown")]), story: z.string().optional() }).strict().optional(),
    persona: z.object({ id: z.string(), status: z.union([CatalogStatusValueSchema, z.literal("unknown")]) }).strict().optional(),
    /** Links that are not approved (`job:<id> (draft)`): `journey promote` needs `--accept-unvetted`. */
    unvetted: z.array(z.string()),
    /** Why the Journey needs re-review (it, or an item it links, changed since its approval). */
    needsReReview: z.array(z.string()),
  })
  .strict();
export type JourneyCatalogLinks = z.infer<typeof JourneyCatalogLinksSchema>;

const CellSchema = z
  .object({
    /** `n/a`: the job does not serve this persona. `promoted`: a promoted Journey covers it. `draft`: only unpromoted ones. `missing`: none. */
    state: z.enum(["n/a", "promoted", "draft", "missing"]),
    journeys: z.array(z.string()),
  })
  .strict();

/** #433: `jevitate catalog status --json` (MCP `catalog_status`). */
export const CatalogStatusSchema = z
  .object({
    personas: z.array(z.object({ id: z.string(), status: CatalogStatusValueSchema, role: z.string().optional() }).strict()),
    jobs: z.array(z.object({ id: z.string(), story: z.string(), status: CatalogStatusValueSchema, priority: z.enum(JOB_PRIORITIES).optional(), personas: z.array(z.string()) }).strict()),
    /** Jobs × personas: one row per job, one cell per catalog persona (and per unknown persona a job names). */
    matrix: z.array(z.object({ job: z.string(), cells: z.record(z.string(), CellSchema) }).strict()),
    /** Approved jobs with no promoted Journey at all. */
    approvedJobsWithoutPromotedJourney: z.array(z.string()),
    /** Job × persona pairs the job serves with no promoted Journey. */
    gaps: z.array(z.object({ job: z.string(), persona: z.string() }).strict()),
    /** Journeys linked to no job and no catalog persona. */
    unlinkedJourneys: z.array(z.string()),
    /** Journeys linking an id the catalog does not declare. */
    danglingLinks: z.array(z.object({ journey: z.string(), kind: z.enum(["job", "persona"]), id: z.string() }).strict()),
    /** Approvals that no longer hold: an edited persona or job, a changed Journey, a Journey linked to a stale item. */
    stale: z.array(z.object({ kind: z.enum(["persona", "job", "journey"]), id: z.string(), reason: z.string() }).strict()),
    files: z.object({ personas: z.string().nullable(), jobs: z.string().nullable() }).strict(),
  })
  .strict();
export type CatalogStatusReport = z.infer<typeof CatalogStatusSchema>;

