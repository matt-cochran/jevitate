/**
 * RunEvidence v1 (docs/design/0.30.0-evidence-and-trust.md §2.1, §3.1, §6.2): the one record every
 * Journey run, goal run and mutation proof writes, and the only input the adjudicator reads.
 *
 * Value-free by construction: fields are enums, counts, shapes, hashes and keyed digests. There is no
 * field for a parameter value, an extracted value, page text, a URL with a query or a request body;
 * `WriteShape` carries a write's shape only. Every object is strict (an extra key is refused, so a
 * gatherer cannot add a free field by accident) and every string is bounded. A quantity a gatherer
 * may fail to establish is `Known<T>`, so "unknown" is a different value from zero.
 */
import { z } from "zod";

/** Why a gatherer could not establish a fact. */
export const UnknownReasonSchema = z.enum([
  "page-not-watched", // the browser did not let the replay watch the page in time
  "page-replaced", // the page or context changed while the fact was being read
  "session-unavailable", // a fresh session could not be opened (auth, network)
  "check-unevaluable", // the check names a target that does not exist on this page
  "replay-stalled", // the replay never finished closing
  "not-gathered", // this producer version does not gather this fact
  "replay-errored", // the replay that would have established the fact errored
]);
export type UnknownReason = z.infer<typeof UnknownReasonSchema>;

/** A fact the gatherer either established or explicitly could not. Never undefined. */
export type Known<T> = { readonly known: true; readonly value: T } | { readonly known: false; readonly reason: UnknownReason };

const UnknownSchema = z.object({ known: z.literal(false), reason: UnknownReasonSchema }).strict();

/** The schema of `Known<T>` for a value schema. */
export function KnownSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion("known", [z.object({ known: z.literal(true), value }).strict(), UnknownSchema]);
}

/** A canonical origin (`scheme://host[:port]`): no path, query or fragment, so no value can ride in it. */
const ORIGIN = /^https?:\/\/[^/?#\s]+$/;
/** An error code such as `E_RUN_REFUSED_PRODUCTION` or `E_SECRET_ORIGIN_REFUSED`. */
const ERROR_CODE = /^E_[A-Z0-9_]+$/;
/** An identifier-like token (a step kind, a judgment task, a name): never free text. */
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
/** A parameter name (`swap-param:<name>` names one): an identifier, underscores included. Never a value. */
const IDENT = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;
/** ISO 8601 date-time, as `clock` produces it. */
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const count = z.number().int().nonnegative();
const stepIndex = z.number().int().positive();

/** §5.1 target trust. */
export const TargetTrustSchema = z.enum(["test", "harness", "production", "unknown"]);
/** Mirrors `APPROVAL_CHANNELS` in @jevitate/journey (approval-schema.ts), which fails to build if the two differ. */
export const EvidenceApprovalChannelSchema = z.enum(["tty", "non-interactive", "mcp", "ci", "pr-review"]);
/** `E_RUN_REFUSED_*`, `E_SECRET_ORIGIN_REFUSED`, …: the code only, never its message. */
export const RefusalCodeSchema = z.string().max(64).regex(ERROR_CODE);
/** Mirrors `MutationKind` in @jevitate/journey (mutation-proof.ts), which fails to build if the two differ. */
export const MutationKindSchema = z.enum(["skip", "block-write", "stale-value", "swap-param", "truncate-param", "guard-param"]);
/** Why a replay may have decided another, by class: mirrors `IsolationNote` in the cli (journey-verify-checkpoint.ts). */
export const IsolationNoteSchema = z.enum([
  "write-open",
  "independence-write-open",
  "control-write-open",
  "base-write-open",
  "state-crossed",
  "state-stuck",
  "independence-errored",
  "siblings-undecided",
]);
export type IsolationNote = z.infer<typeof IsolationNoteSchema>;
/** The methods journey-run-record.ts names; anything else is `OTHER`, never the page's own text. */
export const WriteMethodSchema = z.enum(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "CONNECT", "TRACE", "OTHER"]);

const hash = z.string().max(128);
const name = z.string().max(128).regex(IDENT);
const site = z.string().max(64).regex(TOKEN);
/** A mutation id: `<kind>:<step>` or `<kind>:<param>`, so it carries a parameter's name, never its value. */
const mutationId = z.string().max(160).regex(IDENT);
const reason = z.string().max(500);

export const EvidenceSubjectSchema = z
  .object({
    kind: z.enum(["journey-run", "goal-run", "mutation-proof"]),
    /** `journeyContentHash`. */
    journey: z.object({ id: z.string().max(200), hash }).strict().optional(),
    /** Catalog content hash. */
    job: z.object({ id: z.string().max(200), hash }).strict().optional(),
    /** Keyed digest of a goal sentence; never the text. */
    goalDigest: z.string().max(128).optional(),
  })
  .strict();
export type EvidenceSubject = z.infer<typeof EvidenceSubjectSchema>;

export const RunContextSchema = z
  .object({
    mode: z.enum(["test", "automation"]),
    channel: z.enum(["cli", "mcp", "queue"]),
    target: z
      .object({
        /** Canonical origin only, never a full URL. */
        origin: z.string().max(512).regex(ORIGIN),
        /** Name in environments.json. */
        environment: z.string().max(128).optional(),
        trust: TargetTrustSchema,
      })
      .strict(),
    /** Keyed HMAC over the non-secret parameters (sorted name=value). Secret parameters contribute names only. */
    paramsDigest: hash,
    secretParamNames: z.array(name),
    approval: z.object({ channel: EvidenceApprovalChannelSchema, contentHash: hash }).strict().optional(),
  })
  .strict();
export type RunContext = z.infer<typeof RunContextSchema>;

export const StepEvidenceSchema = z
  .object({
    /** 1-based, as `step:<n>` site keys. */
    index: stepIndex,
    /** The recorded step kind. */
    kind: z.string().max(64).regex(TOKEN),
    outcome: z.enum(["ok", "failed", "skipped", "not-reached", "refused"]),
    /** `Known<never>`: unknown, with a reason. */
    postcondition: z.union([z.enum(["held", "failed", "none"]), UnknownSchema]),
    /** Writes this step sent. */
    writes: KnownSchema(count),
    refusal: RefusalCodeSchema.optional(),
  })
  .strict();
export type StepEvidence = z.infer<typeof StepEvidenceSchema>;

/** One write shape, value-free, as journey-run-record.ts writes it. Shape only: there is no value field. */
export const WriteShapeSchema = z
  .object({
    step: stepIndex,
    method: WriteMethodSchema,
    /** Literal route text only; parameters masked. */
    path: z.string().max(2048),
    /** Only when off the Journey's own origin. */
    origin: z.string().max(512).regex(ORIGIN).optional(),
    count,
    status: KnownSchema(z.enum(["2xx", "3xx", "4xx", "5xx", "aborted", "unanswered"])),
    refused: z.literal(true).optional(),
  })
  .strict();
export type WriteShape = z.infer<typeof WriteShapeSchema>;

export const WritesEvidenceSchema = z
  .object({
    sent: KnownSchema(count),
    answered: KnownSchema(count),
    aborted: KnownSchema(count),
    /** Still open when the run or replay closed. `{known: true, value: 0}`: no write open; `{known: false}`: could not tell. */
    openAtClose: KnownSchema(count),
    shapes: z.array(WriteShapeSchema),
  })
  .strict();
export type WritesEvidence = z.infer<typeof WritesEvidenceSchema>;

/** Where a mutated replay failed, as `MutationFailedSite` in @jevitate/journey, plus `evaluated` from PR #811. */
const MutationFailedSiteSchema = z.discriminatedUnion("where", [
  z.object({ where: z.literal("step"), step: stepIndex, postcondition: z.boolean(), evaluated: z.literal(true).optional() }).strict(),
  z.object({ where: z.literal("step-request"), step: stepIndex, checkIndex: count, evaluated: z.literal(true).optional() }).strict(),
  z.object({ where: z.literal("end-state"), index: count, evaluated: z.literal(true).optional() }).strict(),
  z.object({ where: z.literal("unevaluable"), evaluated: z.literal(true).optional() }).strict(),
]);

export const ReplayEvidenceSchema = z
  .object({
    ordinal: count,
    role: z.enum(["base", "independence", "mutated", "relaxed", "targeted", "control", "at-base-time", "rerun", "closing"]),
    /** The mutation id, for every role but base/independence/closing. */
    mutation: mutationId.optional(),
    relaxedSites: z.array(site).optional(),
    /** The target assertion site of a `targeted` replay and of its `control`; absent on every other replay. */
    site: site.optional(),
    /** `not-applied`: the mutation had nothing to act on (`MutationRunResult.outcome` in @jevitate/journey). */
    outcome: z.enum(["passed", "failed", "not-applied", "error", "stalled"]),
    failedSites: z.array(MutationFailedSiteSchema),
    writes: WritesEvidenceSchema,
    waitsCut: z.array(site).optional(),
    /** From a #787 checkpoint. */
    reused: z.literal(true).optional(),
    retries: z.array(z.object({ reason }).strict()).optional(),
    /**
     * A `targeted` proof the gatherer refused, and why (a code template naming sites and mutations): it
     * reads as a cascade whatever its replay read. A refused attempt may have run no replay at all.
     */
    refused: reason.optional(),
  })
  .strict();
export type ReplayEvidence = z.infer<typeof ReplayEvidenceSchema>;

export const MutationEvidenceSchema = z
  .object({
    plan: z
      .object({
        mutations: z.array(z.object({ id: mutationId, kind: MutationKindSchema, step: stepIndex, param: name.optional() }).strict()),
        pairs: z.array(z.object({ site, mutation: mutationId, declared: z.literal(true).optional() }).strict()),
        sites: z.array(z.object({ site, check: z.string().max(500), required: z.literal(true).optional() }).strict()),
      })
      .strict(),
    replays: z.array(ReplayEvidenceSchema),
    restore: z.enum(["ok", "failed", "none"]),
    /** The independence replay's reading. */
    isolation: KnownSchema(z.enum(["isolated", "state-crossed"])),
    /**
     * The first finding, as the gatherer noted it, that one replay may have decided another (a replay
     * that closed with a write open, state crossing replays, sibling mutations a control and a re-run
     * could not settle), and the mutation it names. `carried`: an earlier, interrupted run of this
     * proof noted it on its checkpoint. Absent: nothing was noted.
     */
    taint: z
      .object({ note: IsolationNoteSchema, by: mutationId.optional(), carried: z.literal(true).optional() })
      .strict()
      .optional(),
  })
  .strict();
export type MutationEvidence = z.infer<typeof MutationEvidenceSchema>;

/** §3.1: `.jevitate/jobs.json` → jobs[].done, or a Journey's metadata.done when it has no job. Placeholders, never resolved values. */
export const DoneCheckSpecSchema = z
  .object({
    version: z.literal(1),
    /** A path on the target origin; `${param}` placeholders allowed (`${secret}` is refused at lint). */
    at: z.string().max(2048),
    /** The `--success` syntax of a state-naming check: `textIncludes`, `count`, `attr`, `valueEquals`, `http`. */
    check: z.string().max(1000),
    session: z.literal("fresh").optional(),
    distinguishedBy: z.array(name).optional(),
  })
  .strict();
export type DoneCheckSpec = z.infer<typeof DoneCheckSpecSchema>;

export const DoneReadingSchema = z
  .object({
    value: KnownSchema(z.boolean()),
    session: z.enum(["fresh", "run"]),
    /** `pre`/`post`, or the step index for an in-run reading. */
    at: z.union([z.enum(["pre", "post"]), stepIndex]),
    durationMs: count,
  })
  .strict();
export type DoneReading = z.infer<typeof DoneReadingSchema>;

export const DoneCheckEvidenceSchema = z
  .object({
    spec: DoneCheckSpecSchema,
    /** Fresh session, before step 1. */
    before: DoneReadingSchema,
    /** Fresh session, after the last step and the end state. */
    after: DoneReadingSchema,
    /** Optional extra reading on the run's own page; never the deciding one. */
    inRun: DoneReadingSchema.optional(),
  })
  .strict();
export type DoneCheckEvidence = z.infer<typeof DoneCheckEvidenceSchema>;

/** §6.2: the four boundaries the lab proved. */
export const BoundaryEvidenceSchema = z
  .object({
    kind: z.enum(["wall", "session", "off-allowlist", "new-tab"]),
    step: stepIndex,
    /** The origin an off-allowlist or new-tab stop names. */
    origin: z.string().max(512).regex(ORIGIN).optional(),
    signal: z.enum(["http-401", "http-403", "paid-control", "login-url", "write-refused", "tab-opened"]),
  })
  .strict();
export type BoundaryEvidence = z.infer<typeof BoundaryEvidenceSchema>;

/** Jev's judgment, recorded for people; never consumed for a verdict. */
export const AdvisoryJudgmentSchema = z
  .object({
    advisory: z.literal(true),
    /** e.g. `done.grounded`, `write.destructive`. */
    task: z.string().max(100).regex(TOKEN),
    step: stepIndex.optional(),
    probability: z.number().gte(0).lte(1),
    threshold: z.number().gte(0).lte(1).optional(),
  })
  .strict();
export type AdvisoryJudgment = z.infer<typeof AdvisoryJudgmentSchema>;

export const RunEvidenceSchema = z
  .object({
    schema: z.literal("jevitate.evidence"),
    version: z.literal(1),
    /** ISO 8601, from `clock`. */
    producedAt: z.string().max(40).regex(ISO_DATETIME),
    producer: z
      .object({
        jevitate: z.string().max(64),
        commit: z.string().max(64).optional(),
      })
      .strict(),
    subject: EvidenceSubjectSchema,
    run: RunContextSchema,
    steps: z.array(StepEvidenceSchema),
    /** The whole run's writes, every replay included. */
    writes: WritesEvidenceSchema,
    doneCheck: DoneCheckEvidenceSchema.optional(),
    /** Present only on `journey verify --mutate`. */
    mutation: MutationEvidenceSchema.optional(),
    boundary: BoundaryEvidenceSchema.optional(),
    judgments: z.array(AdvisoryJudgmentSchema),
    /** Code-templated reasons, for people. */
    notes: z.array(reason),
  })
  .strict();
export type RunEvidence = z.infer<typeof RunEvidenceSchema>;
