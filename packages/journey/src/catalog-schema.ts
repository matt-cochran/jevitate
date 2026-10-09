import { z } from "zod";
import { AcceptedFindingsSchema, ExtensionsSchema } from "./journey.js";
import { ApprovalProvenanceSchema, ApprovalsReportSchema } from "./approval-schema.js";

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
    /** #437: how the approval was made (channel, agent marker names, OS user). */
    provenance: ApprovalProvenanceSchema.optional(),
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

// ── #465: the jtbd shared-core job fields (journeeze catalog-bundle-v1 §5, jtbd-data-model §3) ──

/** #465: `core` (the job itself), `setup` (lifecycle support), `related` (an adjacent job). */
export const JOB_KINDS = ["core", "setup", "related"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** #465: where a job's content came from, weakest first. */
export const JOB_PROVENANCES = ["ai_draft", "team_hypothesis", "customer_evidenced", "behaviour_validated"] as const;
export type JobProvenance = (typeof JOB_PROVENANCES)[number];

/** #465: the universal job map's stages (a job step's optional `stage`). */
export const JOB_STAGES = ["define", "locate", "prepare", "confirm", "execute", "monitor", "modify", "resolve", "conclude"] as const;
export type JobStage = (typeof JOB_STAGES)[number];

export const OUTCOME_DIRECTIONS = ["minimize", "maximize"] as const;
export const OUTCOME_MEASURES = ["time", "likelihood", "effort", "count"] as const;
/** #465: which gulf an outcome is about — `execution` (users don't know what to do) or `evaluation` (can't tell what happened). */
export const OUTCOME_GULFS = ["execution", "evaluation"] as const;
export const METRIC_KINDS = ["duration", "completion", "abandon", "repeat", "error", "assisted", "answer"] as const;
export type MetricKind = (typeof METRIC_KINDS)[number];
export const DURATION_STATS = ["p50", "p75", "share_under"] as const;
export const ANSWER_QUESTIONS = ["got_it_done", "harder_than_expected", "understood"] as const;
export const ANSWER_VALUES = ["yes", "partly", "no"] as const;
export const TARGET_OPS = ["<", "<=", ">", ">="] as const;
export const TARGET_UNITS = ["s", "percent", "count"] as const;

/**
 * #465: where a metric measures — an anchor name, or the reserved `job_start` / `job_end`. Whether
 * the anchor exists on a Journey of the job is a catalog check (an unmeasurable metric is a gap).
 */
const AnchorRefSchema = CatalogIdSchema;

/** #465: catalog text — one non-blank line of at most `max` characters. */
const catalogText = (max: number) => z.string().min(1).max(max).refine((s) => s.trim() !== "" && !/[\r\n]/.test(s), { message: "one non-blank line" });

/** #465: a solution-free job step. */
export const JobStepSchema = z.object({ id: CatalogIdSchema, name: catalogText(200), stage: z.enum(JOB_STAGES).optional() }).strict();
export type JobStep = z.infer<typeof JobStepSchema>;

/**
 * #465: a desired outcome's metric — a closed union over `kind`, each with exactly its fields
 * (jtbd-data-model §3): `duration` (`from`, `to`, `stat`; `threshold` seconds iff `stat` is
 * `share_under`), `completion` (`from`, `to`), `abandon` / `repeat` / `error` / `assisted` (`at`),
 * `answer` (`question`, `value`; `partly` only for `got_it_done`).
 */
export const MetricSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("duration"),
        from: AnchorRefSchema,
        to: AnchorRefSchema,
        stat: z.enum(DURATION_STATS),
        threshold: z.number().int().min(1).max(86_400).optional(),
      })
      .strict(),
    z.object({ kind: z.literal("completion"), from: AnchorRefSchema, to: AnchorRefSchema }).strict(),
    z.object({ kind: z.enum(["abandon", "repeat", "error", "assisted"]), at: AnchorRefSchema }).strict(),
    z.object({ kind: z.literal("answer"), question: z.enum(ANSWER_QUESTIONS), value: z.enum(ANSWER_VALUES) }).strict(),
  ])
  .superRefine((m, ctx) => {
    if (m.kind === "duration" && (m.stat === "share_under") !== (m.threshold !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["threshold"], message: "metric: `threshold` (seconds) goes with `stat: share_under`, and only with it" });
    }
    if (m.kind === "answer" && m.value === "partly" && m.question !== "got_it_done") {
      ctx.addIssue({ code: "custom", path: ["value"], message: "metric: `partly` is an answer only to `got_it_done`" });
    }
  });
export type Metric = z.infer<typeof MetricSchema>;

/** #465: what good enough is — `op` `value` `unit` (a percent is at most 100). */
export const OutcomeTargetSchema = z
  .object({ op: z.enum(TARGET_OPS), value: z.number().min(0), unit: z.enum(TARGET_UNITS) })
  .strict()
  .refine((t) => t.unit !== "percent" || t.value <= 100, { message: "target: a percent is at most 100", path: ["value"] });
export type OutcomeTarget = z.infer<typeof OutcomeTargetSchema>;

/**
 * #465: a desired outcome — what to optimize. `step` (a job step id; absent = the whole job) and the
 * metric's anchors are cross-checked by the catalog rules, not here. `guardrail: true` = must never
 * get worse (a counter-outcome).
 */
export const DesiredOutcomeSchema = z
  .object({
    id: CatalogIdSchema,
    step: CatalogIdSchema.optional(),
    direction: z.enum(OUTCOME_DIRECTIONS),
    measure: z.enum(OUTCOME_MEASURES),
    object: catalogText(300),
    clarifier: catalogText(500).optional(),
    gulf: z.enum(OUTCOME_GULFS).optional(),
    metric: MetricSchema.optional(),
    target: OutcomeTargetSchema.optional(),
    guardrail: z.boolean().optional(),
    priority: z.enum(JOB_PRIORITIES).optional(),
  })
  .strict();
export type DesiredOutcome = z.infer<typeof DesiredOutcomeSchema>;

/**
 * #433: one job in `.jevitate/jobs.json` — a job story `{id, trigger, motivation, outcome}`, the
 * personas it serves, an optional priority, and (#465) the optional jtbd fields above. A job missing any of the three story parts is refused.
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
    // #465: the jtbd shared-core fields — all optional; every one counts toward the content hash
    // (`extensions` included). Cross-references (step ids, metric anchors, parent) are catalog checks.
    kind: z.enum(JOB_KINDS).optional(),
    parent: CatalogIdSchema.optional(),
    context: z.array(catalogText(300)).max(20).optional(),
    steps: z.array(JobStepSchema).max(30).optional(),
    desiredOutcomes: z.array(DesiredOutcomeSchema).max(50).optional(),
    constraints: z.array(catalogText(300)).max(20).optional(),
    provenance: z.enum(JOB_PROVENANCES).optional(),
    revision: z.number().int().min(0).max(4_294_967_295).optional(),
    lastValidated: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, "lastValidated: a calendar date, YYYY-MM-DD").optional(),
    extensions: ExtensionsSchema.optional(),
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
 * #434/#435: what one call's model usage cost (the shape of ai-core's `UsageCounts`, so the CLI's
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
 * #434/#435: whether the advisory Jev layer ran for a sheet or an analysis — `skipped` with the
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
    /** #434/#435: the advisory Jev layer of the findings (readiness questions, pair classifications). */
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
    /** #434/#435: the advisory Jev layer of the findings (readiness questions, pair classifications). */
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
    /** #437: every recorded approval and how it was made; with `--require-approvals`, the violations. */
    approvals: ApprovalsReportSchema.optional(),
  })
  .strict();
export type CatalogStatusReport = z.infer<typeof CatalogStatusSchema>;

// ── #435: catalog analysis ────────────────────────────────────────────────────────────────────

/**
 * #435: the INCOSE Guide to Writing Requirements' characteristics of a SET of requirements, which
 * the catalog analysis groups its findings by (the individual characteristics are #434's).
 */
export const GTWR_SET_CHARACTERISTICS = ["complete", "consistent", "feasible", "comprehensible", "able to be validated", "correct"] as const;
export type GtwrSetCharacteristic = (typeof GTWR_SET_CHARACTERISTICS)[number];

/** #435: how Jev classifies a candidate pair (a typed Choice; code, not the model, decides what it gates). */
export const PAIR_RELATIONS = ["compatible", "duplicate", "overlapping", "conflicting", "dependent"] as const;
export type PairRelation = (typeof PAIR_RELATIONS)[number];

/** #435: two catalog items paired deterministically (`job:<id>`, `persona:<id>`, `journey:<id>`), and why. */
export const CandidatePairSchema = z
  .object({
    a: z.string(),
    b: z.string(),
    kind: z.enum(["job", "persona", "journey"]),
    /** Why code paired them (shared persona, overlapping terms, opposing writes, …). */
    reasons: z.array(z.string()).min(1),
    /** Jev's classification, when the pair was judged. */
    classification: z
      .object({
        relation: z.enum(PAIR_RELATIONS),
        probability: z.number().min(0).max(1),
        /** One line grounded in the two items' own text (built by code, never model prose). */
        reason: z.string(),
        /** The answer came from the content-hash cache (nothing was asked). */
        cached: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type CandidatePair = z.infer<typeof CandidatePairSchema>;

/** #435: `jevitate catalog analyze --json` (MCP `analyze_catalog`), and the per-approval analysis. */
export const CatalogAnalysisSchema = z
  .object({
    /** `catalog`: the whole catalog; else the item being approved or reviewed (only its pairs). */
    scope: z.object({ kind: z.enum(["catalog", "persona", "job", "journey"]), id: z.string().optional() }).strict(),
    /** A hash over every item's content hash: the catalog this report is about. */
    catalogHash: z.string().regex(/^[0-9a-f]{64}$/),
    /** A `conflicting` / `duplicate` classification at or above it needs an acknowledgment to approve. */
    threshold: z.number().min(0).max(1),
    /** The most pairs judged in one analysis. */
    pairCap: z.number().int().min(1),
    pairs: z.array(CandidatePairSchema),
    /** Candidate pairs over the cap: listed, never silently dropped, not judged. */
    overflow: z.array(CandidatePairSchema),
    /** Findings grouped by GtWR set characteristic (only non-empty groups, in GTWR_SET_CHARACTERISTICS order). */
    groups: z.array(z.object({ characteristic: z.enum(GTWR_SET_CHARACTERISTICS), findings: z.array(FindingSchema) }).strict()),
    jev: JevLayerSchema,
  })
  .strict();
export type CatalogAnalysis = z.infer<typeof CatalogAnalysisSchema>;
