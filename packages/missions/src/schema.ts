import { z } from "zod";
import { AssertionSchema, InvariantSpecSchema, type Assertion, type InvariantSpec } from "@jevitate/recording";

// `id` is used to build a filesystem path (both for `MissionTarget`s and for
// `QueuedMission`s), so it is constrained to a safe format at the schema
// level — copied verbatim from `packages/journey/src/journey.ts`'s
// `SAFE_ID_RE` (same path-safety rationale). Must start with an alphanumeric
// char, then any run of alphanumerics/`.`/`_`/`-` — this rejects `/`, `\`,
// `..`, and the empty string.
export const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface MissionTarget {
  id: string;
  name: string;
  description?: string;
  authorizedOrigin: string;
  baseUrl: string;
  promoted: boolean;
  createdAtIso: string;
}

export const MissionTargetSchema: z.ZodType<MissionTarget> = z
  .object({
    id: z.string().regex(SAFE_ID_RE, "invalid id"),
    name: z.string(),
    description: z.string().optional(),
    authorizedOrigin: z.string(),
    baseUrl: z.string(),
    promoted: z.boolean(),
    createdAtIso: z.string(),
  })
  .strict();

/**
 * A `budget` provided on a `MissionRequest` is optional and only bounds-
 * checked (against `MISSION_BOUNDS_CEILING`) at the `enqueueMission` level —
 * NOT here. A zod `.refine()` ceiling check would surface as an
 * indistinguishable-from-malformed-input `ZodError`; `enqueueMission` throws
 * a dedicated `BudgetExceedsCeilingError` instead, so a caller can tell "your
 * budget was too high" apart from "your request was malformed."
 */
const PartialBudgetSchema = z
  .object({
    maxActions: z.number().int().positive().optional(),
    maxDecisions: z.number().int().positive().optional(),
    maxCandidates: z.number().int().positive().optional(),
  })
  .strict();

export interface MissionRequest {
  target: string;
  goal?: string;
  feature?: string;
  route?: string;
  successAssertion: Assertion;
  /**
   * Deliberately narrow: `"goal-based"` is the only mission type that exists
   * per ticket #1/P1. `"adversarial"`/`"induction"` are not in the schema at
   * all yet — passing them is an out-of-schema zod refusal, not a soft
   * "not implemented" response.
   */
  strategy: "goal-based";
  budget?: {
    maxActions?: number;
    maxDecisions?: number;
    maxCandidates?: number;
  };
  /**
   * App-declared invariants (#86), INLINE only — never a path (a caller never makes the server read
   * a file). Closed schema (`@jevitate/recording`'s `InvariantSpecSchema`): unknown keys, a non-GET/
   * HEAD probe or an expression over an undeclared observable are refused here; probe origins are
   * authorized against the resolved target in `enqueueMission`.
   */
  invariants?: InvariantSpec;
}

const EXACTLY_ONE_OF_GOAL_FEATURE_ROUTE = {
  message: "exactly one of goal, feature, or route is required",
};

export const MissionRequestSchema: z.ZodType<MissionRequest> = z
  .object({
    target: z.string(),
    goal: z.string().optional(),
    feature: z.string().optional(),
    route: z.string().optional(),
    successAssertion: AssertionSchema,
    strategy: z.literal("goal-based"),
    budget: PartialBudgetSchema.optional(),
    invariants: InvariantSpecSchema.optional(),
  })
  .strict()
  .refine(
    (req) => [req.goal, req.feature, req.route].filter((v) => v !== undefined).length === 1,
    EXACTLY_ONE_OF_GOAL_FEATURE_ROUTE,
  );

export interface QueuedMission extends MissionRequest {
  budget: { maxActions: number; maxDecisions: number; maxCandidates: number };
  id: string;
  status: "queued";
  enqueuedAtIso: string;
}

export const QueuedMissionSchema: z.ZodType<QueuedMission> = z
  .object({
    target: z.string(),
    goal: z.string().optional(),
    feature: z.string().optional(),
    route: z.string().optional(),
    successAssertion: AssertionSchema,
    strategy: z.literal("goal-based"),
    budget: z
      .object({
        maxActions: z.number().int().positive(),
        maxDecisions: z.number().int().positive(),
        maxCandidates: z.number().int().positive(),
      })
      .strict(),
    invariants: InvariantSpecSchema.optional(),
    id: z.string().regex(SAFE_ID_RE, "invalid id"),
    status: z.literal("queued"),
    enqueuedAtIso: z.string(),
  })
  .strict()
  .refine(
    (req) => [req.goal, req.feature, req.route].filter((v) => v !== undefined).length === 1,
    EXACTLY_ONE_OF_GOAL_FEATURE_ROUTE,
  );
