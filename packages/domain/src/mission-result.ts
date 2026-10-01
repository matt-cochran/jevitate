import { z } from "zod";
import { GOAL_OUTCOMES, MISSION_OUTCOMES, foldGoalOutcome } from "./mission-outcome.js";

/**
 * The ONE result schema every explore strategy's result follows (#195 part 5) — what `jevitate
 * explore --json` prints as `data`, what `<stem>.result.json` holds under `result`, and what MCP
 * `get_mission_result` returns. Suite runners, ledgers and reports parse any strategy's result
 * through these common fields, filled the same way by every strategy:
 *
 *  - `schemaVersion` — bumped on any breaking change to the fields below.
 *  - `strategy` — which strategy produced it (`goal`, `coverage`, `exploratory`, `adversarial`,
 *    `feature`, `usability`).
 *  - `missionOutcome` / `exitCode` — the portable verdict, ALWAYS one of the canonical
 *    `MissionOutcome`s (clean, defects-found, hang, intermittent, inconclusive, crashed) on every
 *    strategy (#217).
 *  - `goalOutcome` — a goal run's own ending (`succeeded`/`failed`/`exhausted`/`blocked`, or a shared
 *    outcome it ended with directly), present on every goal result and on no other; it folds onto
 *    `missionOutcome` by the domain's single mapping (`GOAL_OUTCOME_FOLD`). Additive (schemaVersion 1).
 *  - `defects` — EVERY defect the run found, whatever oracle found it: hard-signal defects,
 *    declared-invariant defects and `server-log` defects alike, each with its `fingerprint` and
 *    `kind`. A defect a strategy reports but never gates on (a usability run's `server-log`
 *    defect; a coverage/exploratory `judgment-flagged-state`, which only Jev's opinion found — #214)
 *    is marked `advisory: true`: listed, replayable by `verify-fix`, never setting the outcome.
 *  - `hangs` — every hang finding (0 or more), each with its fingerprint and reproduction.
 *  - `recordingPaths` — every Recording the run wrote (one for a single-path run, one per path for a
 *    frontier run); never a single `recordingPath` for one strategy and a list for another.
 *  - `transcriptPath`, `resultPath` — the run's decision transcript and this persisted result.
 *  - `target` — the scope the run was authorized for (`seedUrl` + `allowlist`, a session PATH at
 *    most — never its contents): what `verify-fix` needs to replay a finding.
 *  - `engine` — the build that produced it; `usage` — model calls and tokens (present whenever the
 *    run tracked them, which the CLI always does).
 *  - `hostHealth` — the host's health over the run (#203): peak load per core, minimum free memory,
 *    peak driver event-loop lag, the slowest render, and how many steps ran on a starved host.
 *    `environmentDegraded` — findings (a hang, a click timeout, a no-progress stop) met while the host
 *    was starved: advisory, never a defect or hang finding, never failing the run. Both are additive
 *    (schemaVersion 1): every result written since #203 carries them; older results parse without.
 *  - `videoPaths` — #245, additive (schemaVersion 1): the Playwright videos a `--record-video` run
 *    wrote (every browser context it opened, oldest first), finalized before the result is written.
 *    Absent when the run did not record.
 *  - `screenshotPaths` / `screenshotIndex` / `screenshotsSkipped` — #251, additive (schemaVersion 1):
 *    a `--screenshots` run's masked images (one per distinct screen, or per step), its `index.md`
 *    contact sheet, and any capture refused because its secret mask could not be proven.
 *  - `defects[].evidence` — #250, additive (schemaVersion 1): an `--evidence-video` run's per-defect
 *    captioned repro clip (`videoPath`) and key screenshots (`screenshots`: before and at the failing
 *    step), or why it has none (`skipped`).
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

/** #217: the canonical outcomes only — a goal run's own ending is `goalOutcome`, never `missionOutcome`. */
export const RESULT_MISSION_OUTCOMES = MISSION_OUTCOMES;
export type ResultMissionOutcome = (typeof RESULT_MISSION_OUTCOMES)[number];

/** A goal run's own ending (#217), carried beside the canonical `missionOutcome`. */
export const RESULT_GOAL_OUTCOMES = GOAL_OUTCOMES;
export type ResultGoalOutcome = (typeof RESULT_GOAL_OUTCOMES)[number];

const fingerprint = z.string().regex(/^[0-9a-f]{16}$/, "a 16-hex fingerprint");

/** One defect, whatever found it. Its kind-specific evidence (`invariant`, `serverLog`, `signals`, …) passes through. */
export const ResultDefectSchema = z.looseObject({
  fingerprint,
  kind: z.string().min(1),
  title: z.string().optional(),
  related: z.array(z.string()).optional(),
  /** Reported, never gated on (a usability run's `server-log` defect, a `judgment-flagged-state` — #214). */
  advisory: z.literal(true).optional(),
  repro: z.looseObject({ recordingStepIndex: z.number().int() }).optional(),
  /** #250 — additive: the defect's captioned repro clip and key screenshots (`--evidence-video`). */
  evidence: z
    .looseObject({
      videoPath: z.string().min(1).optional(),
      screenshots: z.array(z.string().min(1)),
      skipped: z.string().optional(),
    })
    .optional(),
});
export type ResultDefect = z.infer<typeof ResultDefectSchema>;

/**
 * #214: the defects that may gate a run's outcome — every one NOT marked `advisory: true`. An advisory
 * defect (a Jev judgment alone, or a usability run's server-log defect) is reported, never gated on;
 * the outcome→exit mapping itself stays in `mission-outcome.ts`.
 */
export function gatingDefects<D extends { readonly advisory?: true }>(defects: readonly D[]): D[] {
  return defects.filter((d) => d.advisory !== true);
}

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

/**
 * The host's health over a run (#203) — so triage can tell a starved host from an app finding at a
 * glance. Every number is `null` when the platform could not measure it (e.g. no load average on
 * Windows); never a guess.
 */
/**
 * #205 — what resource governance did during a run (`hostHealth.resources`): the machine-wide browser
 * cap and slot, the most severe throttle level (and every change), the memory ceiling and the peak
 * browser memory measured, and the resource limit that ended the run, if one did.
 */
export const ResourceGovernanceSummarySchema = z.looseObject({
  governance: z.enum(["on", "off"]),
  maxBrowsers: z.number().int().positive().nullable(),
  machineSlot: z.looseObject({ index: z.number().int().nonnegative(), waitedMs: z.number().nonnegative() }).nullable(),
  throttle: z.looseObject({ level: z.enum(["normal", "throttled", "starved"]), reasons: z.array(z.string()), settleFactor: z.number().positive() }),
  throttleChanges: z.array(z.looseObject({ at: z.string(), level: z.enum(["normal", "throttled", "starved"]), reasons: z.array(z.string()) })),
  memoryCeilingBytes: z.number().nonnegative().nullable(),
  peakBrowserMemoryBytes: z.number().nonnegative().nullable(),
  memoryMeasurement: z.enum(["pss", "rss", "unavailable", "off"]),
  resourceLimit: z
    .looseObject({ kind: z.literal("memory"), measuredBytes: z.number().nonnegative(), ceilingBytes: z.number().nonnegative(), metric: z.enum(["pss", "rss"]), message: z.string() })
    .nullable(),
});
export type ResourceGovernanceSummaryRecord = z.infer<typeof ResourceGovernanceSummarySchema>;

export const HostHealthSummarySchema = z.looseObject({
  /** Host samples taken over the run. */
  samples: z.number().int().nonnegative(),
  /** Logical cores the load average is divided by. */
  cores: z.number().int().positive(),
  /** Peak 1-minute load average per core (1 = every core busy with one runnable task). */
  peakLoadPerCore: z.number().nonnegative().nullable(),
  /** Least memory available to a new browser context (bytes). */
  minFreeMemoryBytes: z.number().nonnegative().nullable(),
  /** Peak delay of the driver's (this process's) event loop (ms). */
  peakEventLoopLagMs: z.number().nonnegative().nullable(),
  /** Slowest page render seen (DOMContentLoaded for a navigation, settle time for an in-page transition; ms). */
  slowestRenderMs: z.number().nonnegative().nullable(),
  /** The run's own render baseline (median of its first renders; ms) the trend is judged against. */
  baselineRenderMs: z.number().nonnegative().nullable(),
  /** Steps recorded, and how many of them ran while the host was starved. */
  steps: z.number().int().nonnegative(),
  degradedSteps: z.number().int().nonnegative(),
  /** Most steps ran starved: the run proved nothing (its outcome is never `clean`). */
  degraded: z.boolean(),
  /** The distinct starvation causes seen (first few), e.g. `load 3.10/core > 2`. */
  starvation: z.array(z.string()),
  /** `off` when starvation attribution was disabled (`JEVITATE_HOST_STARVATION=off`): sampled, never judged. */
  attribution: z.enum(["on", "off"]),
  /** #205 — additive: what resource governance did during the run. */
  resources: ResourceGovernanceSummarySchema.optional(),
});
export type HostHealthSummary = z.infer<typeof HostHealthSummarySchema>;

/** Which finding the host's starvation explains. */
export const DEGRADED_FINDINGS = ["hang", "click-timeout", "no-progress", "page-load-timeout"] as const;
export type DegradedFindingKind = (typeof DEGRADED_FINDINGS)[number];

/** A finding met while the host was starved (#203): advisory, never a defect/hang, never failing the run. */
export const EnvironmentDegradedSchema = z.looseObject({
  kind: z.literal("environment-degraded"),
  finding: z.enum(DEGRADED_FINDINGS),
  /** What was seen (the hang's detail, the timed-out action's reason). */
  detail: z.string(),
  /** Why the host counted as starved around it. */
  cause: z.string(),
  /** The transcript step it was met at, when known. */
  step: z.number().int().nonnegative().optional(),
  advisory: z.literal(true),
});
export type EnvironmentDegraded = z.infer<typeof EnvironmentDegradedSchema>;

/** The common fields of every strategy's result (strategy-specific fields pass through). */
export const MissionResultSchema = z
  .looseObject({
    schemaVersion: z.literal(MISSION_RESULT_SCHEMA_VERSION),
    strategy: z.enum(RESULT_STRATEGIES),
    missionOutcome: z.enum(RESULT_MISSION_OUTCOMES),
    /** #217 — additive: a goal run's own ending (present on every goal result, on no other). */
    goalOutcome: z.enum(RESULT_GOAL_OUTCOMES).optional(),
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
    /** #203 — additive: optional so results written before it still parse. */
    hostHealth: HostHealthSummarySchema.optional(),
    environmentDegraded: z.array(EnvironmentDegradedSchema).optional(),
    /** #245 — additive: the run's `--record-video` files (absent when it did not record). */
    videoPaths: z.array(z.string().min(1)).optional(),
    /** #251 — additive: the run's `--screenshots` images, contact sheet and refused captures. */
    screenshotPaths: z.array(z.string().min(1)).optional(),
    screenshotIndex: z.string().min(1).optional(),
    screenshotsSkipped: z.array(z.looseObject({ step: z.number().int(), reason: z.string() })).optional(),
  })
  .refine((r) => (r.strategy === "goal") === (r.goalOutcome !== undefined), {
    message: "goalOutcome is present on every goal result and on no other",
    path: ["goalOutcome"],
  })
  .refine((r) => r.goalOutcome === undefined || foldGoalOutcome(r.goalOutcome) === r.missionOutcome, {
    message: "missionOutcome must be the canonical fold of goalOutcome (GOAL_OUTCOME_FOLD)",
    path: ["missionOutcome"],
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
  /** #217: a goal run's own ending (goal results only). */
  readonly goalOutcome?: ResultGoalOutcome;
  readonly exitCode: number;
  readonly defects: ReadonlyArray<{ readonly fingerprint: string; readonly kind: string; readonly advisory?: true }>;
  readonly hangs: ReadonlyArray<{ readonly fingerprint: string; readonly kind: "hang" }>;
  readonly recordingPaths: readonly string[];
  readonly transcriptPath: string;
  readonly resultPath: string;
  readonly target: { readonly seedUrl: string; readonly allowlist: readonly string[]; readonly storageStatePath?: string };
  readonly engine: { readonly version: string; readonly commit: string; readonly builtAt: string };
  /** #203: every result written now carries the host's health and its environment-degraded findings. */
  readonly hostHealth: HostHealthSummary;
  readonly environmentDegraded: readonly EnvironmentDegraded[];
  /** #245: the run's `--record-video` files (absent when it did not record). */
  readonly videoPaths?: readonly string[];
  /** #251: the run's `--screenshots` images and contact sheet (absent without the flag). */
  readonly screenshotPaths?: readonly string[];
  readonly screenshotIndex?: string;
}
