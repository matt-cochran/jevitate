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
  /**
   * Further origins the target's app legitimately talks to — typically its API on another origin
   * (an SPA on :5192 calling :18582), the MCP analogue of a second `--allow` (#117). Each is a bare
   * http(s) origin, validated exactly like `authorizedOrigin`; a mission's allowlist is
   * `[authorizedOrigin, ...apiOrigins]` and never anything a caller supplies at enqueue time.
   */
  apiOrigins?: string[];
  baseUrl: string;
  promoted: boolean;
  createdAtIso: string;
}

/** True when `value` is exactly an http(s) origin (`scheme://host[:port]`) — no path, query, credentials. */
export function isHttpOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.origin === value &&
    // A concrete host only: no wildcard or other character a URL parser tolerates in a hostname.
    /^[a-z0-9.\-[\]:]+$/i.test(url.hostname)
  );
}

const OriginSchema = z.string().refine(isHttpOrigin, "must be a bare http(s) origin, e.g. https://app.example.com");

export const MissionTargetSchema: z.ZodType<MissionTarget> = z
  .object({
    id: z.string().regex(SAFE_ID_RE, "invalid id"),
    name: z.string(),
    description: z.string().optional(),
    authorizedOrigin: OriginSchema,
    apiOrigins: z.array(OriginSchema).optional(),
    baseUrl: z.string(),
    promoted: z.boolean(),
    createdAtIso: z.string(),
  })
  .strict()
  .refine(
    (t) => {
      try {
        return new URL(t.baseUrl).origin === t.authorizedOrigin;
      } catch {
        return false;
      }
    },
    { message: "baseUrl must be on the target's authorizedOrigin", path: ["baseUrl"] },
  );

/** Every origin a mission against `target` may reach: its authorized origin plus its declared API origins. */
export function targetAllowlist(target: MissionTarget): string[] {
  return [target.authorizedOrigin, ...(target.apiOrigins ?? []).filter((o) => o !== target.authorizedOrigin)];
}

/**
 * The mission strategies a queued mission can express (#117). Each maps onto an existing CLI
 * runner: `goal-based` → `explore --strategy goal`, `coverage` → `explore --strategy coverage`,
 * `adversarial` → `explore --strategy adversarial`, `feature` → `explore --feature`. A usability
 * review needs an app class and a persona the request cannot carry, so it is not queueable.
 */
export const MISSION_STRATEGIES = ["goal-based", "coverage", "adversarial", "feature"] as const;
export type MissionStrategy = (typeof MISSION_STRATEGIES)[number];

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
  /** goal-based: the one objective; coverage/adversarial/feature: an in-scope route glob (e.g. `/thread/**`). */
  route?: string;
  /** Required for `goal-based` (its independent success check); refused for every other strategy. */
  successAssertion?: Assertion;
  /**
   * One of `MISSION_STRATEGIES` — only strategies an existing runner executes. Anything else
   * (`"usability"`, `"induction"`, …) is an out-of-schema zod refusal, not a soft "not implemented".
   */
  strategy: MissionStrategy;
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
  /**
   * Per-mission viewport/device emulation (#149), mutually exclusive with `device`. Validated here
   * (positive integer width/height); threaded into the runner's `EmulationSpec` at dispatch.
   */
  viewport?: { width: number; height: number };
  /**
   * A Playwright `devices` registry name (#149), mutually exclusive with `viewport`. Validated
   * against the registry at dispatch (an unknown name is refused before any browser opens) — this
   * schema only enforces the string shape and the mutual exclusivity.
   */
  device?: string;
}

/**
 * Which fields each strategy takes. `goal-based` is unchanged: exactly one of goal/feature/route plus
 * a success assertion. The others take no goal and no success assertion (their oracle is the
 * run's own hard signals); `feature` names its capability; `route` optionally widens the scope.
 */
function strategyShapeIssues(req: {
  strategy: MissionStrategy;
  goal?: string;
  feature?: string;
  route?: string;
  successAssertion?: Assertion;
  viewport?: { width: number; height: number };
  device?: string;
}): string[] {
  const issues: string[] = [];
  // #149: mutually exclusive, whatever the strategy.
  if (req.viewport !== undefined && req.device !== undefined) issues.push("viewport and device are mutually exclusive; pass exactly one");
  if (req.strategy === "goal-based") {
    if ([req.goal, req.feature, req.route].filter((v) => v !== undefined).length !== 1) {
      issues.push("exactly one of goal, feature, or route is required");
    }
    if (req.successAssertion === undefined) issues.push("successAssertion is required for strategy goal-based");
    return issues;
  }
  if (req.goal !== undefined) issues.push(`goal is not accepted for strategy ${req.strategy}`);
  if (req.successAssertion !== undefined) issues.push(`successAssertion is not accepted for strategy ${req.strategy}`);
  if (req.strategy === "feature" && req.feature === undefined) issues.push("feature is required for strategy feature");
  if (req.strategy !== "feature" && req.feature !== undefined) issues.push(`feature is not accepted for strategy ${req.strategy}`);
  if (req.route !== undefined && !req.route.startsWith("/")) issues.push("route must be a path glob starting with '/'");
  return issues;
}

function refineStrategyShape(req: Parameters<typeof strategyShapeIssues>[0], ctx: z.RefinementCtx): void {
  for (const message of strategyShapeIssues(req)) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
}

const MissionRequestFields = {
  target: z.string(),
  goal: z.string().optional(),
  feature: z.string().optional(),
  route: z.string().optional(),
  successAssertion: AssertionSchema.optional(),
  strategy: z.enum(MISSION_STRATEGIES),
  invariants: InvariantSpecSchema.optional(),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict().optional(),
  device: z.string().min(1).optional(),
};

export const MissionRequestSchema: z.ZodType<MissionRequest> = z
  .object({ ...MissionRequestFields, budget: PartialBudgetSchema.optional() })
  .strict()
  .superRefine(refineStrategyShape);

/**
 * A queued mission's lifecycle (#117): `queued` (enqueued, not yet picked up) → `running` (a
 * `jevitate mission run` drain claimed it) → `done` (its runner wrote a typed result, named by
 * `resultId` — whatever the mission's own outcome, clean or not) or `failed` (it could not run at all,
 * e.g. its target was unpromoted meanwhile; `error` says why).
 */
export const QUEUED_MISSION_STATUSES = ["queued", "running", "done", "failed"] as const;
export type QueuedMissionStatus = (typeof QUEUED_MISSION_STATUSES)[number];

export interface QueuedMission extends MissionRequest {
  budget: { maxActions: number; maxDecisions: number; maxCandidates: number };
  id: string;
  status: QueuedMissionStatus;
  enqueuedAtIso: string;
  startedAtIso?: string;
  finishedAtIso?: string;
  /** The typed result's artifact stem (`explore-<stamp>`, …) once `done`: what `get_mission_result` reads. */
  resultId?: string;
  /** The finished run's canonical outcome and exit code (`done` only). */
  missionOutcome?: string;
  exitCode?: number;
  /** Why the mission could not run (`failed` only). */
  error?: string;
}

export const QueuedMissionSchema: z.ZodType<QueuedMission> = z
  .object({
    ...MissionRequestFields,
    budget: z
      .object({
        maxActions: z.number().int().positive(),
        maxDecisions: z.number().int().positive(),
        maxCandidates: z.number().int().positive(),
      })
      .strict(),
    id: z.string().regex(SAFE_ID_RE, "invalid id"),
    status: z.enum(QUEUED_MISSION_STATUSES),
    enqueuedAtIso: z.string(),
    startedAtIso: z.string().optional(),
    finishedAtIso: z.string().optional(),
    resultId: z.string().regex(SAFE_ID_RE, "invalid result id").optional(),
    missionOutcome: z.string().optional(),
    exitCode: z.number().int().optional(),
    error: z.string().optional(),
  })
  .strict()
  .superRefine(refineStrategyShape);
