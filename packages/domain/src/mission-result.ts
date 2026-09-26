import { z } from "zod";
import { MISSION_OUTCOMES } from "./mission-outcome.js";

/**
 * The ONE result schema every explore strategy's result follows (#195 part 5) — what `jevitate
 * explore --json` prints as `data`, what `<stem>.result.json` holds under `result`, and what MCP
 * `get_mission_result` returns. Suite runners, ledgers and reports parse any strategy's result
 * through these common fields, filled the same way by every strategy:
 *
 *  - `schemaVersion` — bumped on any breaking change to the fields below.
 *  - `strategy` — which strategy produced it (`goal`, `coverage`, `exploratory`, `adversarial`,
 *    `feature`, `usability`).
 *  - `missionOutcome` / `exitCode` — the verdict (a goal run keeps its own vocabulary:
 *    `succeeded`/`exhausted`/`blocked` besides the shared `MissionOutcome`s); `exitCode` is the
 *    portable one.
 *  - `defects` — EVERY defect the run found, whatever oracle found it: hard-signal defects,
 *    declared-invariant defects and `server-log` defects alike, each with its `fingerprint` and
 *    `kind`. A defect a strategy reports but never gates on (a usability run's `server-log`
 *    defect) is marked `advisory: true`.
 *  - `hangs` — every hang finding (0 or more), each with its fingerprint and reproduction.
 *  - `recordingPaths` — every Recording the run wrote (one for a single-path run, one per path for a
 *    frontier run); never a single `recordingPath` for one strategy and a list for another.
 *  - `transcriptPath`, `resultPath` — the run's decision transcript and this persisted result.
 *  - `target` — the scope the run was authorized for (`seedUrl` + `allowlist`, a session PATH at
 *    most — never its contents): what `verify-fix` needs to replay a finding.
 *  - `engine` — the build that produced it; `usage` — model calls and tokens (present whenever the
 *    run tracked them, which the CLI always does).
 *
 * Everything else on a result is strategy-specific (a goal run's `checks`/`answer`, a coverage run's
 * `coverage`, an adversarial run's `advisories`/`scope`, a usability run's `report`): the schema lets
 * it through unchanged and never gives it a cross-strategy meaning. In particular `outcome` is the
 * strategy's own ending (a goal run's outcome, a frontier's stop reason), NOT the portable verdict.
 *
 * Deprecated aliases, kept for 0.2.0 only and removed in the next minor: `serverLogDefects` (the
 * `server-log` subset of `defects`) and `recordingPath` (`recordingPaths[0]`).
 */
export const MISSION_RESULT_SCHEMA_VERSION = 1 as const;

export const RESULT_STRATEGIES = ["goal", "coverage", "exploratory", "adversarial", "feature", "usability"] as const;
export type ResultStrategy = (typeof RESULT_STRATEGIES)[number];

/** A goal run's own endings besides the shared `MissionOutcome`s. */
const GOAL_ONLY_OUTCOMES = ["succeeded", "exhausted", "blocked"] as const;
export const RESULT_MISSION_OUTCOMES = [...MISSION_OUTCOMES, ...GOAL_ONLY_OUTCOMES] as const;
export type ResultMissionOutcome = (typeof RESULT_MISSION_OUTCOMES)[number];

const fingerprint = z.string().regex(/^[0-9a-f]{16}$/, "a 16-hex fingerprint");

/** One defect, whatever found it. Its kind-specific evidence (`invariant`, `serverLog`, `signals`, …) passes through. */
export const ResultDefectSchema = z.looseObject({
  fingerprint,
  kind: z.string().min(1),
  title: z.string().optional(),
  related: z.array(z.string()).optional(),
  /** Reported, never gated on (e.g. a usability run's `server-log` defect). */
  advisory: z.literal(true).optional(),
  repro: z.looseObject({ recordingStepIndex: z.number().int() }).optional(),
});
export type ResultDefect = z.infer<typeof ResultDefectSchema>;

export const ResultHangSchema = z.looseObject({ fingerprint, kind: z.literal("hang") });

export const ResultTargetSchema = z.looseObject({
  seedUrl: z.string().min(1),
  allowlist: z.array(z.string()),
  storageStatePath: z.string().optional(),
});

export const ResultEngineSchema = z.object({ version: z.string(), commit: z.string(), builtAt: z.string() });

export const ResultUsageSchema = z.looseObject({
  judgments: z.number().int().nonnegative(),
  generations: z.number().int().nonnegative(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  priced: z.enum(["full", "partial", "none"]),
});

/** The common fields of every strategy's result (strategy-specific fields pass through). */
export const MissionResultSchema = z.looseObject({
  schemaVersion: z.literal(MISSION_RESULT_SCHEMA_VERSION),
  strategy: z.enum(RESULT_STRATEGIES),
  missionOutcome: z.enum(RESULT_MISSION_OUTCOMES),
  exitCode: z.number().int().nonnegative(),
  defects: z.array(ResultDefectSchema),
  hangs: z.array(ResultHangSchema),
  recordingPaths: z.array(z.string().min(1)),
  transcriptPath: z.string().min(1),
  resultPath: z.string().min(1),
  target: ResultTargetSchema,
  engine: ResultEngineSchema,
  usage: ResultUsageSchema.optional(),
  failure: z.looseObject({ kind: z.string(), message: z.string() }).optional(),
});
export type MissionResult = z.infer<typeof MissionResultSchema>;

/** A persisted `<stem>.result.json`: the verdict beside the result it summarizes. */
export const PersistedMissionResultSchema = z
  .object({
    missionOutcome: z.enum(RESULT_MISSION_OUTCOMES),
    exitCode: z.number().int().nonnegative(),
    result: MissionResultSchema,
  })
  .refine((f) => f.missionOutcome === f.result.missionOutcome && f.exitCode === f.result.exitCode, {
    message: "the file's missionOutcome/exitCode must equal its result's",
  });
export type PersistedMissionResult = z.infer<typeof PersistedMissionResultSchema>;

/**
 * The common fields a strategy's result type must carry — the TS side of `MissionResultSchema`,
 * so a runner that stops filling one fails to compile (see `result-schema.test.ts`).
 */
export interface MissionResultCore {
  readonly schemaVersion: typeof MISSION_RESULT_SCHEMA_VERSION;
  readonly strategy: ResultStrategy;
  readonly missionOutcome: ResultMissionOutcome;
  readonly exitCode: number;
  readonly defects: ReadonlyArray<{ readonly fingerprint: string; readonly kind: string; readonly advisory?: true }>;
  readonly hangs: ReadonlyArray<{ readonly fingerprint: string; readonly kind: "hang" }>;
  readonly recordingPaths: readonly string[];
  readonly transcriptPath: string;
  readonly resultPath: string;
  readonly target: { readonly seedUrl: string; readonly allowlist: readonly string[]; readonly storageStatePath?: string };
  readonly engine: { readonly version: string; readonly commit: string; readonly builtAt: string };
}
