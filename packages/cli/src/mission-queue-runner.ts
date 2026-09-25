import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { GenerationPort, JudgmentPort, UsageTracker } from "@jevitate/ai-core";
import { validateInvariantSpec } from "@jevitate/recording";
import { resolveEmulation, type BrowserPort, type BrowserLaunchOptions, type EmulationSpec } from "@jevitate/playwright";
import {
  targetAllowlist,
  type DrainableMissionQueueStore,
  type MissionTarget,
  type MissionTargetRegistry,
  type QueuedMission,
} from "@jevitate/missions";
import {
  CLI_ADVERSARIAL_STRATEGIES,
  runAdversarialCliMission,
  runCoverageMission,
  runExploration,
  runFeatureCliMission,
  type ServerLogOptions,
} from "./explore-api.js";
import { parseSecretField, secretFieldSecrets, type SecretField } from "@jevitate/explore";
import { runWithMissionKillListener } from "./kill-signal.js";
import { resolveTargetConfig, type TargetConfig } from "./target-config.js";
import { parseLogSourceSpecs } from "./log-sources.js";
import { parseLogDefectSpecs, parseLogIgnoreSpecs } from "./log-correlation.js";
import { buildMissionFixtures, checkSetupRefs } from "./fixture-cli.js";
import { substituteSetupRefs, type MissionFixtures } from "./mission-fixtures.js";

/**
 * The queue drain behind `jevitate mission run` (#117). `queue_exploration` (MCP) only ENQUEUES —
 * a `QueuedMission` in `~/.jevitate/missions/queue/<missionId>.json`. This runs each queued mission
 * through the SAME runner its strategy uses on the CLI (`explore --strategy goal|coverage|adversarial`,
 * `explore --feature`), writes its typed result where `get_mission_result` reads it, and records the
 * lifecycle on the queue record: `queued` → `running` → `done` (with the result's id) | `failed`.
 *
 * Security: the target is re-resolved through the PROMOTED-only registry at run time (a target
 * unpromoted since the enqueue fails the mission, never runs it), and the run's allowlist is the
 * target's own `[authorizedOrigin, ...apiOrigins]` — nothing from the request widens it. A queued
 * mission never carries a credential; a model call gets only the run's redacted state.
 */

/** What a strategy runner hands back: enough to link the queue record to the persisted result. */
export interface QueuedMissionRun {
  readonly resultPath: string;
  readonly missionOutcome: string;
  readonly exitCode: number;
}

/** A queued mission plus its resolved (promoted) target and the allowlist the run may reach. */
export interface QueuedMissionSpec {
  readonly mission: QueuedMission;
  readonly target: MissionTarget;
  readonly allowlist: readonly string[];
}

export type QueuedMissionExecutor = (spec: QueuedMissionSpec) => Promise<QueuedMissionRun>;

export interface DrainedMission {
  readonly missionId: string;
  readonly strategy: string;
  readonly status: "done" | "failed";
  readonly resultId?: string;
  readonly missionOutcome?: string;
  readonly exitCode?: number;
  readonly error?: string;
}

export interface SkippedMission {
  readonly missionId: string;
  readonly reason: string;
}

export interface DrainReport {
  readonly ran: DrainedMission[];
  /** Left `queued` for a later drain (e.g. a model-driven mission when no gateway was selected). */
  readonly skipped: SkippedMission[];
}

export interface DrainMissionQueueOptions {
  readonly queue: DrainableMissionQueueStore;
  readonly targets: MissionTargetRegistry;
  readonly execute: QueuedMissionExecutor;
  /** Which queued missions this drain can run; the rest stay `queued` and are reported as skipped. */
  readonly accepts?: (mission: QueuedMission) => string | true;
  readonly nowIso?: () => string;
  /** Called once per mission as it finishes (a `--watch` drain streams these). */
  readonly onMission?: (m: DrainedMission) => void;
}

/** `<dir>/<stem>.result.json` → `<stem>`: the id `get_mission_result` takes. */
export function resultIdFromPath(resultPath: string): string {
  const name = basename(resultPath);
  return name.endsWith(".result.json") ? name.slice(0, -".result.json".length) : name;
}

/** Strategies that need the judgment/generation gateways (every one but the model-free feature mission). */
export function needsModel(mission: QueuedMission): boolean {
  return mission.strategy !== "feature" && !(mission.strategy === "goal-based" && mission.feature !== undefined);
}

/**
 * Drains every mission currently `queued`, oldest first, one at a time. A mission another drain
 * already claimed is left alone. Never throws for a single mission: its failure is recorded on its
 * queue record (`failed` + `error`) and the drain moves on.
 */
export async function drainMissionQueue(opts: DrainMissionQueueOptions): Promise<DrainReport> {
  const now = opts.nowIso ?? (() => new Date().toISOString());
  const queued = (await opts.queue.list())
    .filter((m) => m.status === "queued")
    .sort((a, b) => a.enqueuedAtIso.localeCompare(b.enqueuedAtIso));
  const ran: DrainedMission[] = [];
  const skipped: SkippedMission[] = [];
  for (const candidate of queued) {
    const accepted = opts.accepts?.(candidate) ?? true;
    if (accepted !== true) {
      skipped.push({ missionId: candidate.id, reason: accepted });
      continue;
    }
    if (!(await opts.queue.claim(candidate.id))) continue; // another drain owns it
    const mission = await opts.queue.get(candidate.id);
    if (mission === null || mission.status !== "queued") continue;
    const running: QueuedMission = { ...mission, status: "running", startedAtIso: now() };
    await opts.queue.update(running);
    let drained: DrainedMission;
    // Killed mid-mission (SIGTERM/SIGINT): the kill switch writes the run's partial `inconclusive`
    // result; record it on the queue record in the same synchronous turn, so the mission reads as
    // done-with-that-result rather than `running` forever.
    // Scoped to THIS item: with several missions in one process, a kill records each queue item
    // with its own mission's result, never another's.
    const onKilled = ({ resultPath, exitCode }: { resultPath: string; exitCode: number }): void => {
      opts.queue.updateSync({
        ...running,
        status: "done",
        finishedAtIso: now(),
        resultId: resultIdFromPath(resultPath),
        missionOutcome: "inconclusive",
        exitCode,
      });
    };
    try {
      const target = await opts.targets.resolve(mission.target); // promoted-only, re-checked at run time
      const run = await runWithMissionKillListener(onKilled, () =>
        opts.execute({ mission: running, target, allowlist: targetAllowlist(target) }),
      );
      const resultId = resultIdFromPath(run.resultPath);
      await opts.queue.update({
        ...running,
        status: "done",
        finishedAtIso: now(),
        resultId,
        missionOutcome: run.missionOutcome,
        exitCode: run.exitCode,
      });
      drained = {
        missionId: mission.id,
        strategy: mission.strategy,
        status: "done",
        resultId,
        missionOutcome: run.missionOutcome,
        exitCode: run.exitCode,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await opts.queue.update({ ...running, status: "failed", finishedAtIso: now(), error });
      drained = { missionId: mission.id, strategy: mission.strategy, status: "failed", error };
    }
    ran.push(drained);
    opts.onMission?.(drained);
  }
  return { ran, skipped };
}

export interface RealExecutorOptions {
  /** Where results are written — the dir `jevitate mcp`'s `get_mission_result` reads. */
  readonly outDir: string;
  /** Builds fresh gateways (and a fresh usage tracker) per model-driven mission. */
  readonly gateways: () => Promise<{ judge: JudgmentPort; gen: GenerationPort; usage: UsageTracker }>;
  readonly browserPortFactory?: () => BrowserPort;
  readonly browser?: BrowserLaunchOptions;
  /**
   * `~/.jevitate/targets.json`, by origin (#142 follow-up): a queued mission NEVER carries its own
   * `--log-source` (a `MissionRequest`/`QueuedMission` may not name a path or a command — see
   * `packages/missions/src/schema.ts`), so a source is only ever the OPERATOR's own file-declared
   * default for the target's origin. Omitted or empty ⇒ no log sources for any queued mission.
   */
  readonly targets?: Readonly<Record<string, TargetConfig>>;
  /** Where a target's `secretFields` read their values (default `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** The operator-declared auth for one queued mission's target (#175). */
interface QueuedAuth {
  readonly storageState?: string;
  /** Where the rotated session is written back after the mission (#82/#159 machinery). */
  readonly saveStorageState?: string;
  readonly secretFields: readonly SecretField[];
  readonly fixtures?: string;
}

/**
 * #175: a queued mission never carries a credential (a `QueuedMission` cannot name a path or a
 * secret), so its session is only ever the OPERATOR's: the mission target record (`mission target
 * add|update --storage-state/--save-storage-state/--secret-field`) first, then the
 * `~/.jevitate/targets.json` entry for the target's origin — field by field. `saveStorageState: true`
 * writes back to the effective `storageState`, so the next queued mission (they run one at a time)
 * starts from the rotated session. Throws — the caller records a `failed` mission — when the
 * declared file is missing or a variable is unset (naming the path or variable, never a value);
 * never silently runs logged out.
 */
function queuedAuth(
  target: MissionTarget,
  targets: Readonly<Record<string, TargetConfig>> | undefined,
  env: Readonly<Record<string, string | undefined>>,
): QueuedAuth {
  let config: TargetConfig = {};
  if (targets !== undefined) {
    try {
      config = resolveTargetConfig(targets, new URL(target.baseUrl).origin);
    } catch {
      config = {};
    }
  }
  const fromRecord = target.storageState !== undefined;
  const storageState = target.storageState ?? config.storageState;
  if (storageState !== undefined && !existsSync(storageState)) {
    throw new Error(`${fromRecord ? `mission target ${target.id}` : `targets.json entry for ${target.authorizedOrigin}`}: storageState not found: ${storageState}`);
  }
  const save = target.saveStorageState ?? config.saveStorageState;
  if (save === true && storageState === undefined) throw new Error(`mission target ${target.id}: saveStorageState needs a storageState to write back to`);
  const saveStorageState = save === true ? storageState : save;
  const secretFields = (target.secretFields ?? config.secretFields ?? []).map((s) => parseSecretField(s, "value", env));
  return {
    ...(storageState === undefined ? {} : { storageState }),
    ...(saveStorageState === undefined ? {} : { saveStorageState }),
    secretFields,
    ...(config.fixtures === undefined ? {} : { fixtures: config.fixtures }),
  };
}

/** The operator-declared `--log-source`/`--log-defect` for one origin, already parsed (#142 follow-up).
 *  Throws (via `parseLogSourceSpecs`/`parseLogDefectSpecs`) on a malformed targets.json entry — the
 *  caller's existing per-mission try/catch turns that into a `failed` queue record, never a crash. */
function serverLogFromTargetConfig(targets: Readonly<Record<string, TargetConfig>> | undefined, baseUrl: string): ServerLogOptions | undefined {
  if (targets === undefined) return undefined;
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return undefined;
  }
  const config = resolveTargetConfig(targets, origin);
  if ((config.logSources?.length ?? 0) === 0 && (config.logDefect?.length ?? 0) === 0) return undefined;
  const allowLogCmd = config.allowLogCmd === true;
  return {
    sources: parseLogSourceSpecs(config.logSources ?? [], allowLogCmd),
    logDefect: parseLogDefectSpecs(config.logDefect ?? []),
    allowLogCmd,
    quietOk: config.logQuietOk ?? [],
    logIgnore: parseLogIgnoreSpecs(config.logIgnore ?? []),
  };
}

/**
 * Maps a queued mission onto the runner its strategy uses on the CLI. The start URL is the
 * target's `baseUrl`; `route` is an in-scope glob for coverage/adversarial/feature.
 */
export function realQueuedMissionExecutor(opts: RealExecutorOptions): QueuedMissionExecutor {
  const common = {
    outDir: opts.outDir,
    ...(opts.browserPortFactory === undefined ? {} : { browserPortFactory: opts.browserPortFactory }),
    ...(opts.browser === undefined ? {} : { browser: opts.browser }),
  };
  return async ({ mission, target, allowlist }) => {
    const bounds = mission.budget;
    // Re-checked against the target as it is NOW (its origins may have changed since the enqueue):
    // a probe may only ever read one of the run's own authorized origins.
    if (mission.invariants !== undefined) {
      validateInvariantSpec(mission.invariants, { allowlist, baseUrl: target.baseUrl });
    }
    const invariants = mission.invariants === undefined ? {} : { invariants: mission.invariants };
    const routeGlobs = mission.route === undefined ? [] : [mission.route];
    const serverLog = serverLogFromTargetConfig(opts.targets, target.baseUrl);
    const withServerLog = serverLog === undefined ? {} : { serverLog };
    // #175: the operator's session for this target (never the request's): every strategy starts
    // from its storage state; a goal mission also types its secret fields and runs its fixtures.
    const auth = queuedAuth(target, opts.targets, opts.env ?? process.env);
    const withStorageState = {
      ...(auth.storageState === undefined ? {} : { storageState: auth.storageState }),
      ...(auth.saveStorageState === undefined ? {} : { saveStorageState: auth.saveStorageState }),
    };
    // #149: per-mission viewport/device emulation. `MissionRequestSchema` already refused an
    // unknown --device / viewport+device together at enqueue time; `resolveEmulation` here is a
    // second, defense-in-depth check — refused BEFORE any browser opens — since a device could in
    // principle have been dropped from Playwright's registry between enqueue and drain.
    const missionEmulation: EmulationSpec | undefined =
      mission.viewport === undefined && mission.device === undefined
        ? undefined
        : {
            ...(mission.viewport === undefined ? {} : { viewport: mission.viewport }),
            ...(mission.device === undefined ? {} : { device: mission.device }),
          };
    if (missionEmulation !== undefined) resolveEmulation(missionEmulation);
    const withEmulation = missionEmulation === undefined ? {} : { emulation: missionEmulation };
    if (mission.strategy === "feature" || (mission.strategy === "goal-based" && mission.feature !== undefined)) {
      const r = await runFeatureCliMission({
        ...common,
        seedUrl: target.baseUrl,
        allowlist,
        capability: mission.feature!,
        routeGlobs,
        bounds,
        ...invariants,
        ...withServerLog,
        ...withEmulation,
        ...withStorageState,
      });
      return { resultPath: r.resultPath, missionOutcome: r.missionOutcome, exitCode: r.exitCode };
    }
    if (mission.strategy === "goal-based" && mission.goal === undefined) {
      throw new Error("a goal-based mission with only a route has no runner: queue it as strategy coverage or adversarial with that route");
    }
    const { judge, gen, usage } = await opts.gateways();
    if (mission.strategy === "coverage") {
      const r = await runCoverageMission({
        ...common,
        url: target.baseUrl,
        allowlist,
        judge,
        gen,
        usage,
        bounds,
        ...(routeGlobs.length > 0 ? { routeGlobs } : {}),
        ...invariants,
        ...withServerLog,
        ...withEmulation,
        ...withStorageState,
      });
      return { resultPath: r.resultPath, missionOutcome: r.missionOutcome, exitCode: r.exitCode };
    }
    if (mission.strategy === "adversarial") {
      const r = await runAdversarialCliMission({
        ...common,
        seedUrl: target.baseUrl,
        allowlist,
        strategies: CLI_ADVERSARIAL_STRATEGIES,
        judgment: judge,
        generation: gen,
        usage,
        bounds,
        ...(routeGlobs.length > 0 ? { routeGlobs } : {}),
        ...invariants,
        ...withServerLog,
        ...withEmulation,
        ...withStorageState,
      });
      return { resultPath: r.resultPath, missionOutcome: r.outcome, exitCode: r.exitCode };
    }
    // A goal mission runs the target's fixtures around it (authenticated from the same session and
    // secret fields; validated before any browser) — as `explore --fixtures` does on the CLI.
    const fx: MissionFixtures | undefined = buildMissionFixtures(
      {},
      {
        allowlist,
        baseUrl: target.baseUrl,
        ...(auth.storageState === undefined ? {} : { storageState: auth.storageState }),
        secretFields: auth.secretFields,
        secrets: secretFieldSecrets(auth.secretFields),
        ...(auth.fixtures === undefined ? {} : { targetFixtures: auth.fixtures }),
      },
    );
    let goal = mission.goal!;
    checkSetupRefs({ goal }, fx);
    try {
      // A failed setup throws (`fixture setup failed: …`, redacted): the mission is recorded
      // `failed` and never runs on unknown state.
      if (fx !== undefined) {
        await fx.setup();
        goal = substituteSetupRefs(goal, fx.bindings(), { where: "goal" });
      }
      const r = await runExploration({
        ...common,
        url: target.baseUrl,
        goal,
        ...(mission.successAssertion === undefined ? {} : { successAssertion: mission.successAssertion }),
        allowlist,
        judge,
        gen,
        usage,
        bounds,
        ...invariants,
        ...withServerLog,
        ...withEmulation,
        ...withStorageState,
        ...(auth.secretFields.length === 0 ? {} : { secretFields: auth.secretFields }),
        ...(fx === undefined ? {} : { fixtures: fx }),
      });
      return { resultPath: r.resultPath, missionOutcome: r.outcome, exitCode: r.exitCode };
    } finally {
      await fx?.restore();
    }
  };
}
