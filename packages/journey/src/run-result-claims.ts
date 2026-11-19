import { z } from "zod";
import { MISSION_RESULT_SCHEMA_VERSION, RESULT_MISSION_OUTCOMES } from "@jevitate/domain";
import { CATALOG_ID_RE } from "./catalog-schema.js";

/**
 * #874: the claim-verdict part of a goal run's result — what `explore --job <id> --job-context`
 * adds to the `--json` envelope's `data` and to the saved `<recording>.result.json`'s `result` (the
 * same fields, from one builder), and the source of truth of the published run-result
 * contract v1 (`packages/cli/contracts/jevitate-run-result/v1/`).
 *
 *  - `jobContext` — the catalog job the run was told about (`job`, its id) and the content hash of
 *    the approved job it used (`contentHash`), so a verdict is placed on the exact job version.
 *  - `claims` — one verdict per `guidance.claims[]` entry of that job, in order; absent when the job
 *    has no claims. A verdict never changes the run's exit code.
 *
 * Every other field of the result passes through unchanged (`data` is open); a claim and the job
 * context are closed.
 */
export const CLAIM_VERDICTS = ["confirmed", "contradicted", "not_observed"] as const;
export type ClaimVerdict = (typeof CLAIM_VERDICTS)[number];

/**
 * What decided a verdict: `check` (the claim's own check, read by code), `model` (a model judgment
 * against what the run observed), `no-evidence` (nothing to judge from: `not_observed`, no model call),
 * `model-error` (the judgment call failed: `not_observed`, with its `reason`).
 */
export const CLAIM_BASES = ["check", "model", "no-evidence", "model-error"] as const;
export type ClaimBasis = (typeof CLAIM_BASES)[number];

const catalogId = z.string().regex(CATALOG_ID_RE, "an id: 1-64 of [A-Za-z0-9._-], starting alphanumeric");

/** One claim's verdict (the claim's `id` and `statement` as the job states them). */
export const ClaimResultSchema = z
  .object({
    id: catalogId,
    statement: z.string().min(1).max(300),
    verdict: z.enum(CLAIM_VERDICTS),
    basis: z.enum(CLAIM_BASES),
    /** With basis `model-error`: why the judgment call failed. */
    reason: z.string().optional(),
  })
  .strict();
export type ClaimResult = z.infer<typeof ClaimResultSchema>;

/** The job a `--job-context` run was told about: its id and the approved content hash it used. */
export const RunJobContextSchema = z
  .object({
    job: catalogId,
    contentHash: z.string().regex(/^[0-9a-f]{64}$/, "a sha256 hex digest"),
  })
  .strict();
export type RunJobContext = z.infer<typeof RunJobContextSchema>;

/** A goal result carrying claim verdicts (`--json` `data`); the result's other fields pass through. */
export const RunResultClaimVerdictsSchema = z.looseObject({
  schemaVersion: z.literal(MISSION_RESULT_SCHEMA_VERSION),
  strategy: z.literal("goal"),
  jobContext: RunJobContextSchema,
  claims: z.array(ClaimResultSchema).max(20).optional(),
});
export type RunResultClaimVerdicts = z.infer<typeof RunResultClaimVerdictsSchema>;

/** The `explore --json` envelope (`{v, ok, data}`) of a run that produced claim verdicts. */
export const RunResultClaimVerdictsEnvelopeSchema = z
  .object({
    v: z.literal(1),
    ok: z.literal(true),
    data: RunResultClaimVerdictsSchema,
  })
  .strict();

/**
 * The saved `<recording>.result.json` of a run that produced claim verdicts: the verdict beside the
 * result (`missionOutcome`, `exitCode`) and the result itself, which carries the same claim-verdict
 * fields as the envelope's `data`.
 */
export const SavedRunResultClaimVerdictsSchema = z
  .object({
    missionOutcome: z.enum(RESULT_MISSION_OUTCOMES),
    exitCode: z.number().int().nonnegative(),
    result: RunResultClaimVerdictsSchema,
  })
  .strict();
