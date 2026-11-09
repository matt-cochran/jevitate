import { triagedServerLog } from "./explore-shared.js";
import { existsSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import type { GenerationPort, JudgmentPort, UsageTracker } from "@jevitate/ai-core";
import { validateInvariantSpec } from "@jevitate/recording";
import { PlaywrightBrowserPort, resolveEmulation, type BrowserPort, type BrowserLaunchOptions, type EmulationSpec } from "@jevitate/playwright";
import { authExpiredResult, ensurePersonaSession, type AuthCheck } from "./persona-login.js";
import { artifactStamp, writeMissionResult } from "./mission-journal.js";
import {
  targetAllowlist,
  type DrainableMissionQueueStore,
  type MissionTarget,
  type MissionTargetRegistry,
  type QueuedJourneyCall,
  type QueuedMission,
} from "@jevitate/missions";
import { runGuardedJourney, type GuardedJourneyDecision } from "./journey-run-mode-gate.js";
import { environmentFromFlags } from "./environments.js";
import type { ResolvedJourneyEnvironment } from "./environments.js";
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
import { parseLogDefectSpecs, parseLogIgnoreSpecs, parseLogScopeSpecs } from "./log-correlation.js";
import { loadLogClassRules } from "./log-classes.js";
import { parseCorrelationHeaders, parseLogIdPatterns } from "./log-trace.js";
import { buildMissionFixtures, checkSetupRefs } from "./fixture-cli.js";
import { substituteSetupRefs, type MissionFixtures } from "./mission-fixtures.js";
import { clock, combineOutcomes, journeyExitCode, safeRunPolicy, JOURNEY_RUN_OUTCOMES, MISSION_EXIT_CODES, MISSION_OUTCOMES, type JourneyRunOutcome, type MissionOutcome } from "@jevitate/domain";
import type { ClaimOwner, JourneyCallQueueStore, QueuedJourneyRecord } from "@jevitate/missions";
import { runAsMcpInvocation } from "./approval-provenance.js";
import { exploreDoneCheckPolicy, prepareJobDoneCheck } from "./explore-job-done-check.js";
import { resolveCatalogDir } from "./catalog-api.js";
import { resolveLayout } from "./project-layout.js";
import { heldOutcomeOf } from "./journey-hold.js";
import { withJourneyRunRecord } from "./journey-run-record.js";
import { assertMcpRunnable } from "./journey-stale-api.js";
import { missingSecretParams, withSecretParamsFor } from "./secret-params.js";
import { withSiteGate } from "./site-gate-cli.js";
import { inMcpInvocation } from "./approval-provenance.js";
import { prepareMcpRunGuard } from "./mcp-run-guard.js";
import { withRunMetadata } from "./run-metadata.js";
import { guardedPortFactory, guardRequestWithMode, resolveSurfaceRunMode, runModeRecord } from "./run-surface-mode.js";

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
  /** The canonical outcome (#217). */
  readonly missionOutcome: string;
  /** #217: a goal run's own ending, beside the canonical `missionOutcome`. */
  readonly goalOutcome?: string;
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
  readonly goalOutcome?: string;
  readonly exitCode?: number;
  readonly error?: string;
}

export interface RecoveredMission {
  readonly missionId: string;
  readonly error: string;
}

export interface SkippedMission {
  readonly missionId: string;
  readonly reason: string;
}

export interface DrainReport {
  readonly ran: DrainedMission[];
  /**
   * Missions a previous drain left `running` when it died (SIGKILL, OOM, reboot), now recorded
   * `failed` — never re-run, since they may already have sent writes.
   */
  readonly recovered: RecoveredMission[];
  /** Left `queued` for a later drain (e.g. a model-driven mission when no gateway was selected). */
  readonly skipped: SkippedMission[];
  /** #797: the queued Journey calls this drain ran (present only when it ran one). */
  readonly journeys?: DrainedJourneyCall[];
  /** GAPS 20: queued Journey calls a dead drain left `running`, now recorded `failed`, never re-run (present only when there was one). */
  readonly journeysRecovered?: RecoveredJourneyCall[];
}

/** GAPS 20: a queued Journey call recovered from a dead drain, as `RecoveredMission`. */
export interface RecoveredJourneyCall {
  readonly callId: string;
  readonly error: string;
}

/** #797: one queued Journey call, drained. `done`: it reached an outcome; `failed`: it could not run (a refusal, `code`). */
export interface DrainedJourneyCall {
  readonly callId: string;
  readonly journey: string;
  readonly status: "done" | "failed";
  readonly outcome?: string;
  readonly exitCode?: number;
  readonly runId?: string;
  readonly code?: string;
  readonly error?: string;
  /** GAPS 21 (#800): the linked job's verdict from its done check, as `journey run` reports it. */
  readonly job?: { readonly attainment: string; readonly basis: string };
}

/** #797: what a drained Journey call ended as. A refusal before the run throws instead (the drain records it `failed`). */
export interface QueuedJourneyRun {
  readonly outcome: string;
  readonly exitCode: number;
  /** The run record's key (`journey-evidence-<runId>`), when run records are on. */
  readonly runId?: string;
  readonly code?: string;
  /** GAPS 21 (#800): the linked job's verdict from its done check. */
  readonly job?: { readonly attainment: string; readonly basis: string };
}

export type QueuedJourneyExecutor = (call: QueuedJourneyRecord["call"]) => Promise<QueuedJourneyRun>;

export interface DrainMissionQueueOptions {
  readonly queue: DrainableMissionQueueStore;
  readonly targets: MissionTargetRegistry;
  readonly execute: QueuedMissionExecutor;
  /** Which queued missions this drain can run; the rest stay `queued` and are reported as skipped. */
  readonly accepts?: (mission: QueuedMission) => string | true;
  readonly nowIso?: () => string;
  /** Called once per mission as it finishes (a `--watch` drain streams these). */
  readonly onMission?: (m: DrainedMission) => void;
  /** This drain's identity, recorded on each claim (default: this process and host). */
  readonly owner?: { readonly pid: number; readonly host: string };
  /** Is a process on this host alive? (default: `process.kill(pid, 0)`) */
  readonly isAlive?: (pid: number) => boolean;
  /** A `running` mission whose drain cannot be checked (another host, an old claim) is abandoned after this long (default 12h). */
  readonly orphanAfterMs?: number;
  /** #797: the queued Journey calls (`queue_journey` / `journey queue`), drained after the missions, oldest first. */
  readonly journeyCalls?: { readonly store: JourneyCallQueueStore; readonly execute: QueuedJourneyExecutor };
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
  const now = opts.nowIso ?? (() => clock.nowIso());
  const self = opts.owner ?? { pid: process.pid, host: hostname() };
  const recovered = await recoverOrphans(opts, self, now);
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
    if (!(await opts.queue.claim(candidate.id, { ...self, claimedAtIso: now() }))) continue; // another drain owns it
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
        ...(run.goalOutcome === undefined ? {} : { goalOutcome: run.goalOutcome }),
        exitCode: run.exitCode,
      });
      drained = {
        missionId: mission.id,
        strategy: mission.strategy,
        status: "done",
        resultId,
        missionOutcome: run.missionOutcome,
        ...(run.goalOutcome === undefined ? {} : { goalOutcome: run.goalOutcome }),
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
  const journeysRecovered = opts.journeyCalls === undefined ? [] : await recoverOrphanJourneyCalls(opts.journeyCalls.store, opts, self, now);
  const journeys = opts.journeyCalls === undefined ? [] : await drainJourneyCalls(opts.journeyCalls, self, now);
  return { ran, recovered, skipped, ...(journeys.length === 0 ? {} : { journeys }), ...(journeysRecovered.length === 0 ? {} : { journeysRecovered }) };
}

/**
 * Whether a `running` claim belongs to a drain that died (GAPS 20; the rule `recoverOrphans` applies to
 * missions): a claim of this process is its own; on this host, its process is gone; when that cannot be
 * checked (another host, a claim with no owner), it has been running longer than `orphanAfterMs`.
 * Returns the error to record, or undefined while it may still be running.
 */
function orphanError(
  owner: ClaimOwner | null,
  startedIso: string,
  opts: Pick<DrainMissionQueueOptions, "isAlive" | "orphanAfterMs">,
  self: { readonly pid: number; readonly host: string },
  now: () => string,
): string | undefined {
  const isAlive = opts.isAlive ?? processAlive;
  const orphanAfterMs = opts.orphanAfterMs ?? ORPHAN_AFTER_MS;
  if (owner !== null && owner.host === self.host && owner.pid === self.pid) return undefined;
  const checkable = owner !== null && owner.host === self.host;
  const dead = checkable ? !isAlive(owner.pid) : Date.parse(now()) - Date.parse(startedIso) > orphanAfterMs;
  if (!dead) return undefined;
  const who = owner === null ? "its drain" : `its drain (pid ${owner.pid} on ${owner.host})`;
  return checkable
    ? `${who} stopped without finishing it; it was not re-run, since it may already have sent writes — enqueue it again to retry`
    : `${who} has not finished it after ${Math.round(orphanAfterMs / 3_600_000)}h; recorded failed, not re-run, since it may already have sent writes — enqueue it again to retry`;
}

/** GAPS 20: a queued Journey call a dead drain left `running` is recorded `failed`, never re-run (it may have sent writes). */
async function recoverOrphanJourneyCalls(
  store: JourneyCallQueueStore,
  opts: Pick<DrainMissionQueueOptions, "isAlive" | "orphanAfterMs">,
  self: { readonly pid: number; readonly host: string },
  now: () => string,
): Promise<RecoveredJourneyCall[]> {
  const out: RecoveredJourneyCall[] = [];
  for (const r of await store.list()) {
    if (r.status !== "running") continue;
    const owner = await store.claimOwner(r.id);
    const error = orphanError(owner, r.startedAtIso ?? owner?.claimedAtIso ?? r.enqueuedAtIso, opts, self, now);
    if (error === undefined) continue;
    await store.update({ ...r, status: "failed", finishedAtIso: now(), error });
    out.push({ callId: r.id, error });
  }
  return out;
}

/**
 * #797: drains every queued Journey call, oldest first, one at a time, as `drainMissionQueue` drains
 * missions: an exclusive claim (never run twice), `running` → `done` | `failed`. A refusal (a Journey
 * changed since the call was queued, unpromoted, the run mode) is recorded `failed` with its code.
 */
async function drainJourneyCalls(
  calls: NonNullable<DrainMissionQueueOptions["journeyCalls"]>,
  self: { readonly pid: number; readonly host: string },
  now: () => string,
): Promise<DrainedJourneyCall[]> {
  const queued = (await calls.store.list()).filter((r) => r.status === "queued").sort((a, b) => a.enqueuedAtIso.localeCompare(b.enqueuedAtIso));
  const out: DrainedJourneyCall[] = [];
  for (const candidate of queued) {
    if (!(await calls.store.claim(candidate.id, { ...self, claimedAtIso: now() }))) continue;
    const record = await calls.store.get(candidate.id);
    if (record === null || record.status !== "queued") continue;
    const running: QueuedJourneyRecord = { ...record, status: "running", startedAtIso: now() };
    await calls.store.update(running);
    const journey = record.call.journey.id;
    try {
      const run = await calls.execute(record.call);
      const extra = { ...(run.runId === undefined ? {} : { runId: run.runId }), ...(run.code === undefined ? {} : { code: run.code }), ...(run.job === undefined ? {} : { job: { attainment: run.job.attainment, basis: run.job.basis } }) };
      await calls.store.update({ ...running, status: "done", finishedAtIso: now(), outcome: run.outcome, exitCode: run.exitCode, ...extra });
      out.push({ callId: record.id, journey, status: "done", outcome: run.outcome, exitCode: run.exitCode, ...extra });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const c = (err as { code?: unknown } | null)?.code;
      const code = typeof c === "string" && /^E_[A-Z0-9_]+$/.test(c) ? c : undefined;
      await calls.store.update({ ...running, status: "failed", finishedAtIso: now(), error, ...(code === undefined ? {} : { code }) });
      out.push({ callId: record.id, journey, status: "failed", error, ...(code === undefined ? {} : { code }) });
    }
  }
  return out;
}

/** #427: how long a queued mission's pre-flight auth check may take to load its start page. */
const QUEUED_AUTH_CHECK_TIMEOUT_MS = 30_000;

/** Default: 12h — well past any bounded mission (stall timeouts, action caps), short of a lost week. */
const ORPHAN_AFTER_MS = 12 * 60 * 60 * 1000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, owned by another user. Only ESRCH means it is gone.
    return !(typeof err === "object" && err !== null && "code" in err && err.code === "ESRCH");
  }
}

/**
 * A drain that dies hard (SIGKILL, OOM, reboot) leaves its mission `running` forever, and
 * `get_mission_result` would tell an agent to poll again indefinitely. Before claiming new work,
 * a drain records such missions `failed`: when the claiming process on this host is gone, or —
 * when that cannot be checked (another host, a claim from before owners were recorded) — once the
 * mission has been running longer than `orphanAfterMs`. Never re-run: it may already have sent
 * writes; the error says to enqueue it again.
 */
async function recoverOrphans(
  opts: DrainMissionQueueOptions,
  self: { readonly pid: number; readonly host: string },
  now: () => string,
): Promise<RecoveredMission[]> {
  const out: RecoveredMission[] = [];
  for (const m of await opts.queue.list()) {
    if (m.status !== "running") continue;
    const owner = await opts.queue.claimOwner(m.id);
    const error = orphanError(owner, m.startedAtIso ?? owner?.claimedAtIso ?? m.enqueuedAtIso, opts, self, now);
    if (error === undefined) continue; // this drain's own, or possibly still running
    await opts.queue.update({ ...m, status: "failed", finishedAtIso: now(), error });
    out.push({ missionId: m.id, error });
  }
  return out;
}

export interface RealExecutorOptions {
  /** Where results are written — the dir `jevitate mcp`'s `get_mission_result` reads. */
  readonly outDir: string;
  /** Builds fresh gateways (and a fresh usage tracker) per model-driven mission. */
  readonly gateways: () => Promise<{ judge: JudgmentPort; gen: GenerationPort; usage: UsageTracker }>;
  /** #313: the gateways are live (`--real`): a target's `logTriage` then scores relevance with Jev (else code only). */
  readonly liveJudgment?: boolean;
  readonly browserPortFactory?: () => BrowserPort;
  /**
   * Launch options only — typed `BrowserLaunchOptions`, never the demo-mode `BrowserRunOptions`
   * (#245): a queued mission (what MCP `queue_exploration` feeds) runs unattended, so it is always
   * headless and overlay-free; `mission run` takes no --headed flag. It records a video only when
   * the queued request itself asked (`recordVideo`, #255 — next to its result, never a path).
   */
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
  /**
   * #427: the pre-flight auth check before a mission that starts from a session (default `auto`).
   * Never a request's choice: a queued mission cannot turn it off.
   */
  readonly authCheck?: AuthCheck;
  /** 0.30.0 §5: `~/.jevitate/targets.json` (default), read for the target's trust and the #789 guard. */
  readonly targetsFile?: string;
  /** 0.30.0 §5: `.jevitate/environments.json` (default: the project's). */
  readonly environmentsFile?: string;
  /** #800: the catalog a queued goal mission's `job` is read from (default: the project's `.jevitate/`). */
  readonly catalogDir?: string | null;
  /** #800: the Journeys dir the catalog is resolved beside (default: the project's). */
  readonly journeysDir?: string;
}

/** The operator-declared auth for one queued mission's target (#175). */
interface QueuedAuth {
  readonly storageState?: string;
  /** Where the rotated session is written back after the mission (#82/#159 machinery). */
  readonly saveStorageState?: string;
  readonly secretFields: readonly SecretField[];
  readonly fixtures?: string;
  /** #243: the origin's personas — what a fixture step's `auth.identity` binds to. */
  readonly personas?: TargetConfig["personas"];
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
  persona?: string,
): QueuedAuth {
  let config: TargetConfig = {};
  if (targets !== undefined) {
    try {
      config = resolveTargetConfig(targets, new URL(target.baseUrl).origin);
    } catch {
      config = {};
    }
  }
  // #255: a queued persona NAME selects the operator's `personas.<name>` session for this origin
  // (targets.json) — it wins over the target's default session. Unknown: the mission fails, never
  // silently runs as the default user.
  if (persona !== undefined) {
    const p = config.personas?.[persona];
    if (p === undefined) {
      const known = Object.keys(config.personas ?? {});
      throw new Error(
        `persona '${persona}' is not declared for ${target.authorizedOrigin} in ~/.jevitate/targets.json (personas)` +
          (known.length === 0 ? "" : ` — known personas: ${known.join(", ")}`),
      );
    }
    if (p.storageState !== undefined && !existsSync(p.storageState)) {
      throw new Error(`targets.json persona '${persona}' for ${target.authorizedOrigin}: storageState not found: ${p.storageState}`);
    }
    const secretFields = (p.secretFields ?? []).map((s) => parseSecretField(s, "value", env));
    return {
      ...(p.storageState === undefined ? {} : { storageState: p.storageState }),
      secretFields,
      ...(config.fixtures === undefined ? {} : { fixtures: config.fixtures }),
      ...(config.personas === undefined ? {} : { personas: config.personas }),
    };
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
    ...(config.personas === undefined ? {} : { personas: config.personas }),
  };
}

/** The operator's targets.json config for `baseUrl`'s origin, or undefined when there is no targets file. */
function targetConfigFor(targets: Readonly<Record<string, TargetConfig>> | undefined, baseUrl: string): TargetConfig | undefined {
  if (targets === undefined) return undefined;
  try {
    return resolveTargetConfig(targets, new URL(baseUrl).origin);
  } catch {
    return undefined;
  }
}

/** The operator-declared `--log-source`/`--log-defect` for one origin, already parsed (#142 follow-up).
 *  Throws (via `parseLogSourceSpecs`/`parseLogDefectSpecs`) on a malformed targets.json entry — the
 *  caller's existing per-mission try/catch turns that into a `failed` queue record, never a crash. */
export function serverLogFromTargetConfig(targets: Readonly<Record<string, TargetConfig>> | undefined, baseUrl: string): ServerLogOptions | undefined {
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
    logScope: parseLogScopeSpecs(config.logScope ?? []),
    correlationHeaders: parseCorrelationHeaders(config.logCorrelationHeaders ?? []),
    idPatterns: parseLogIdPatterns(config.logIdPatterns ?? []),
    ...(config.logTriage === true ? { triage: {} } : {}),
    // #422: the project's .jevitate/log-classes.json (validated: throws LogClassesError) + defaults.
    logClasses: loadLogClassRules(),
  };
}

/**
 * Maps a queued mission onto the runner its strategy uses on the CLI. The start URL is the
 * target's `baseUrl`; `route` is an in-scope glob for coverage/adversarial/feature.
 */
export function realQueuedMissionExecutor(opts: RealExecutorOptions): QueuedMissionExecutor {
  const seams = { ...(opts.targetsFile === undefined ? {} : { targetsFile: opts.targetsFile }), ...(opts.environmentsFile === undefined ? {} : { environmentsFile: opts.environmentsFile }) };
  const run = runQueuedMission(opts);
  // 0.30.0 §5: the run a queued mission starts decides its mode NOW, from the person-written files for the
  // target's origin (never from the queued request, which names no trust): stamped on its result as `run`.
  // Under an MCP call (`run_queued_missions`) every session of it is armed with the #789 guard, given that
  // mode, as `run_exploration`'s are.
  return async (job) => {
    const decided = resolveSurfaceRunMode({ surface: "mission", origin: job.target.baseUrl, ...seams });
    const notes: string[] = [];
    let browserPortFactory = opts.browserPortFactory;
    if (inMcpInvocation()) {
      const guardFor = () => prepareMcpRunGuard(guardRequestWithMode({ site: job.target.baseUrl, allowedOrigins: job.allowlist, ...seams }, decided, notes));
      guardFor();
      browserPortFactory = guardedPortFactory(opts.browserPortFactory ?? (() => new PlaywrightBrowserPort()), guardFor);
    }
    return withRunMetadata({ runMode: () => runModeRecord(decided, notes) }, () => run(job, browserPortFactory));
  };
}

function runQueuedMission(opts: RealExecutorOptions): (job: Parameters<QueuedMissionExecutor>[0], browserPortFactory: (() => BrowserPort) | undefined) => ReturnType<QueuedMissionExecutor> {
  return async ({ mission, target, allowlist }, browserPortFactory) => {
    const common = {
      outDir: opts.outDir,
      ...(browserPortFactory === undefined ? {} : { browserPortFactory }),
      ...(opts.browser === undefined ? {} : { browser: opts.browser }),
    };
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
    // The operator's targets.json entry for this origin — safety (deny/paid/allowDestructive/
    // readRequests/hangReplayWrites), settle, hangs, timing — applies to a queued mission exactly as
    // to `explore` on the CLI. Never from the request.
    const config = targetConfigFor(opts.targets, target.baseUrl);
    const withTarget = config === undefined ? {} : { target: config };
    const withSafety = config?.safety === undefined ? {} : { safety: config.safety };
    // #175: the operator's session for this target (never the request's): every strategy starts
    // from its storage state; a goal mission also types its secret fields and runs its fixtures.
    const auth = queuedAuth(target, opts.targets, opts.env ?? process.env, mission.persona);
    const withStorageState = {
      ...(auth.storageState === undefined ? {} : { storageState: auth.storageState }),
      ...(auth.saveStorageState === undefined ? {} : { saveStorageState: auth.saveStorageState }),
    };
    // #427: the session is proven alive before the mission starts — an expired one ends it now
    // (`auth-expired`, the persona named), with a result `get_mission_result` reads; the login page is
    // never explored. targets.json personas carry no login parameters, so nothing is re-minted here.
    if (auth.storageState !== undefined) {
      const session = await ensurePersonaSession({
        ...(mission.persona === undefined ? {} : { persona: mission.persona }),
        storageState: auth.storageState,
        url: target.baseUrl,
        allowlist,
        check: opts.authCheck ?? { mode: "auto" },
        port: (opts.browserPortFactory ?? (() => new PlaywrightBrowserPort()))(),
        ...(opts.browser === undefined ? {} : { browser: opts.browser }),
        env: opts.env ?? process.env,
        timeoutMs: QUEUED_AUTH_CHECK_TIMEOUT_MS,
      });
      if (!session.ok) {
        const result = authExpiredResult(mission.strategy, target.baseUrl, session, mission.persona);
        mkdirSync(opts.outDir, { recursive: true });
        const resultPath = writeMissionResult(join(opts.outDir, `explore-${artifactStamp(clock.nowIso())}.json`), "inconclusive", result.exitCode, result);
        return { resultPath, missionOutcome: "inconclusive", exitCode: result.exitCode };
      }
    }
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
    // #255: the media a queued mission asked for — always next to its result (a request never names
    // a path), still headless and overlay-free.
    const withMedia = {
      ...(mission.recordVideo === true ? { browser: { ...opts.browser, recordVideo: {} } } : {}),
      ...(mission.screenshots === undefined ? {} : { screenshots: { mode: mission.screenshots } }),
      ...(mission.evidenceVideo === true ? { evidenceVideo: true } : {}),
    };
    if (mission.strategy === "feature" || (mission.strategy === "goal-based" && mission.feature !== undefined)) {
      const r = await runFeatureCliMission({
        ...common,
        seedUrl: target.baseUrl,
        allowlist,
        capability: mission.feature!,
        routeGlobs,
        bounds,
        ...invariants,
        ...withSafety,
        ...withServerLog,
        ...withEmulation,
        ...withStorageState,
        ...withMedia,
      });
      return { resultPath: r.resultPath, missionOutcome: r.missionOutcome, exitCode: r.exitCode };
    }
    if (mission.strategy === "goal-based" && mission.goal === undefined) {
      throw new Error("a goal-based mission with only a route has no runner: queue it as strategy coverage or adversarial with that route");
    }
    const { judge, gen, usage } = await opts.gateways();
    // #313: a target's `logTriage` scores relevance with Jev only on live gateways (else code only).
    const triaged = triagedServerLog(serverLog, judge, opts.liveJudgment === true);
    if (mission.strategy === "coverage" || mission.strategy === "exploratory") {
      const r = await runCoverageMission({
        ...common,
        strategy: mission.strategy,
        url: target.baseUrl,
        allowlist,
        judge,
        gen,
        usage,
        bounds,
        ...(routeGlobs.length > 0 ? { routeGlobs } : {}),
        ...invariants,
        ...withTarget,
        ...triaged,
        ...withEmulation,
        ...withStorageState,
        ...withMedia,
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
        ...withTarget,
        ...triaged,
        ...withEmulation,
        ...withStorageState,
        ...withMedia,
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
        // #243: a fixture step's `auth.identity` binds to the origin's targets.json persona of that name.
        ...(auth.personas === undefined ? {} : { personas: auth.personas }),
      },
    );
    let goal = mission.goal!;
    checkSetupRefs({ goal }, fx);
    // #800 (GAPS 12): the done-check policy, as `explore --goal` decides it (--require-done-check over
    // project.json over `require`); an unreadable project.json fails the mission before any browser.
    const catalogDir = opts.catalogDir === undefined ? resolveCatalogDir(undefined) : opts.catalogDir;
    const doneCheckPolicy = exploreDoneCheckPolicy(catalogDir, mission.requireDoneCheck);
    try {
      // A failed setup throws (`fixture setup failed: …`, redacted): the mission is recorded
      // `failed` and never runs on unknown state.
      if (fx !== undefined) {
        await fx.setup();
        goal = substituteSetupRefs(goal, fx.bindings(), { where: "goal" });
      }
      // #800 (GAPS 12): a queued `job` is resolved now, from the drain's catalog, exactly as `explore --job`:
      // its done check read in a fresh context before the run and after each proposed done. An unknown job
      // fails the mission (nothing explored).
      const jobCheck =
        mission.job === undefined
          ? undefined
          : await prepareJobDoneCheck({
              jobId: mission.job,
              catalogDir,
              journeysDir: opts.journeysDir ?? resolveLayout({}, { dirMeaning: "journeys" }).journeysDir,
              startUrl: target.baseUrl,
              ...(auth.storageState === undefined ? {} : { storageState: auth.storageState }),
              ...((browserPortFactory ?? opts.browserPortFactory) === undefined ? {} : { sessionPortFactory: browserPortFactory ?? opts.browserPortFactory }),
            });
      if (jobCheck !== undefined && !jobCheck.ok) throw Object.assign(new Error(`${jobCheck.code}: ${jobCheck.message}`), { code: jobCheck.code });
      const r = await runExploration({
        ...common,
        ...(jobCheck?.ok !== true ? {} : jobCheck.reader !== undefined ? { doneCheck: jobCheck.reader } : { doneCheckBasis: jobCheck.basis }),
        doneCheckPolicy,
        ...(mission.requireDoneCheck === true ? { requireDoneCheck: true } : {}),
        url: target.baseUrl,
        goal,
        ...(mission.successAssertion === undefined ? {} : { successAssertion: mission.successAssertion }),
        ...(mission.minEffort === undefined ? {} : { minEffort: mission.minEffort }),
        allowlist,
        judge,
        gen,
        usage,
        bounds,
        ...invariants,
        ...withTarget,
        ...triaged,
        ...withEmulation,
        ...withStorageState,
        ...withMedia,
        ...(auth.secretFields.length === 0 ? {} : { secretFields: auth.secretFields }),
        ...(fx === undefined ? {} : { fixtures: fx }),
      });
      return { resultPath: r.resultPath, missionOutcome: r.missionOutcome, goalOutcome: r.goalOutcome, exitCode: r.exitCode };
    } finally {
      await fx?.restore();
    }
  };
}

export interface QueuedJourneyRunDeps {
  readonly journeysDir: string;
  readonly environmentsFile?: string | undefined;
  readonly targetsFile?: string | undefined;
  /**
   * The replay itself, started only once the shared gate (`runGuardedJourney`: promotion check, run-mode
   * gate, #789 guard) passed. It gets the call's non-secret params; a secret the Journey needs is met by
   * the run's own secret mode (vault or hold), never by the call.
   */
  readonly run: (run: { readonly id: string; readonly params: Record<string, string>; readonly environment: ResolvedJourneyEnvironment | undefined; readonly decision: GuardedJourneyDecision | undefined }) => Promise<unknown>;
}

/**
 * #797: runs one queued Journey call through the same gate as `run_journey` (`runGuardedJourney`). A
 * Journey whose content changed since the call was queued is refused `E_JOURNEY_APPROVAL_STALE` before any
 * browser. Throws the gate's typed refusals; the caller records them on the call.
 */
export async function runQueuedJourneyCall(call: QueuedJourneyCall, deps: QueuedJourneyRunDeps): Promise<unknown> {
  const environment = environmentFromFlags(
    { ...(call.env === undefined ? {} : { env: call.env }), ...(call.baseUrl === undefined ? {} : { baseUrl: call.baseUrl }) },
    { ...(deps.environmentsFile === undefined ? {} : { environmentsFile: deps.environmentsFile }), ...(deps.targetsFile === undefined ? {} : { targetsFile: deps.targetsFile }) },
  );
  return runGuardedJourney({
    journeysDir: deps.journeysDir,
    id: call.journey.id,
    environment,
    targetsFile: deps.targetsFile,
    expectedHash: call.journey.hash,
    run: (decision) => deps.run({ id: call.journey.id, params: { ...(call.params ?? {}) }, environment, decision }),
  });
}

export interface RealJourneyExecutorOptions {
  readonly journeysDir: string;
  /** 0.30.0 §5: `~/.jevitate/targets.json` (default), for the target's trust, the #789 guard and its `secretFields`. */
  readonly targetsFile?: string | undefined;
  readonly environmentsFile?: string | undefined;
  /** The site-policy database (pacing, budget, quiet hours), as `run_journey` uses it. */
  readonly sitePolicyDbPath?: string | undefined;
  /** Where the run record and its `evidence.json` go (default: the project's logs). */
  readonly logsRoot?: string | undefined;
  /** The evidence digest's key (default `~/.jevitate/verify-checkpoint.key`). Testing seam. */
  readonly evidenceKeyFile?: string | undefined;
  readonly browserPortFactory?: (() => BrowserPort) | undefined;
  readonly browser?: BrowserLaunchOptions | undefined;
  /** Where a target's `secretFields` `env:` sources are read (default `process.env`). */
  readonly secretEnv?: Readonly<Record<string, string | undefined>> | undefined;
  /** GAPS 21: the catalog dir the job done check is read from (default: the project's `.jevitate/`). */
  readonly catalogDir?: string | undefined;
}

/**
 * #797: the real executor of a queued Journey call. It runs exactly as `run_journey` does — as an MCP
 * invocation (the call may have been queued by an agent, so the promotion check, the run-mode rules and
 * the #789 guard are run_journey's), through `runQueuedJourneyCall` (`runGuardedJourney`, plus the hash
 * the call was queued against) — and its run record and evidence say channel `queue`. A secret the
 * Journey needs is met by the run's secret mode: the target's `targets.json` `secretFields` on its own
 * origin, else a hold a person completes (`outcome: held`, exit 2). The call itself never carries one.
 */
export function realQueuedJourneyExecutor(opts: RealJourneyExecutorOptions): QueuedJourneyExecutor {
  return async (call) => {
    const { runJourneyProgrammatically } = await import("./journey-api.js");
    const { runWithDoneCheck } = await import("./journey-done-check-hook.js");
    const { resolveCatalogDir } = await import("./catalog-api.js");
    // The run's id: its record's key, which names its evidence directory (`journey-evidence-<runId>`).
    let runId: string | undefined;
    try {
      const result = await runAsMcpInvocation(() =>
        withJourneyRunRecord({ channel: "queue", id: call.journey.id, params: call.params ?? {}, logsRoot: opts.logsRoot, evidenceKeyFile: opts.evidenceKeyFile }, (runRecorder) => {
          const dir = runRecorder.evidenceDir();
          runId = dir === undefined ? undefined : basename(dir).replace(/^journey-evidence-/, "");
          return withSiteGate(opts.sitePolicyDbPath, (siteGate) =>
            runQueuedJourneyCall(call, {
              journeysDir: opts.journeysDir,
              environmentsFile: opts.environmentsFile,
              targetsFile: opts.targetsFile,
              run: async ({ id, params, environment, decision }) => {
                // §5.3: what the call leaves out, from the operator's secretFields for the run's origin only.
                const fields = decision?.target.targetConfig?.secretFields ?? [];
                const bound =
                  decision !== undefined && fields.length > 0 && missingSecretParams(decision.journey, params).length > 0
                    ? withSecretParamsFor(decision.journey, { id, params, flags: [], targetFields: fields, targetOrigin: decision.target.origin, env: opts.secretEnv ?? process.env })
                    : { params };
                // GAPS 21 (#800): the linked job's done check, read as `journey run` reads it.
                return runWithDoneCheck({
                  catalogDir: resolveCatalogDir(opts.catalogDir),
                  journeysDir: opts.journeysDir,
                  ...(environment?.baseUrl === undefined ? {} : { origin: environment.baseUrl }),
                  ...(environment?.storageState === undefined ? {} : { storageState: environment.storageState }),
                  ...(opts.browserPortFactory === undefined ? {} : { sessionPortFactory: opts.browserPortFactory }),
                }, () => runJourneyProgrammatically({
                  dir: opts.journeysDir,
                  id,
                  params: bound.params,
                  runRecorder,
                  assertRunnable: (stored) => assertMcpRunnable(stored, opts.journeysDir),
                  ...(opts.targetsFile === undefined ? {} : { runGuardTargetsFile: opts.targetsFile }),
                  policy: safeRunPolicy(),
                  ...(environment?.storageState === undefined ? {} : { storageState: environment.storageState }),
                  ...(siteGate === undefined ? {} : { siteGate }),
                  ...(environment === undefined ? {} : { environment }),
                  ...(opts.browser === undefined ? {} : { browser: opts.browser }),
                  ...("bound" in bound && bound.bound !== undefined ? { boundSecretParams: bound.bound } : {}),
                  ...(opts.secretEnv === undefined ? {} : { secretEnv: opts.secretEnv }),
                  ...(opts.browserPortFactory === undefined ? {} : { browserPortFactory: opts.browserPortFactory }),
                }));
              },
            }),
          );
        }),
      );
      const withRun = runId === undefined ? {} : { runId };
      const outcome = (result as { outcome?: unknown } | null)?.outcome;
      if (typeof outcome !== "string") return { outcome: "inconclusive", exitCode: 2, ...withRun };
      // GAPS 21: a run with a job verdict carries the exit code its done check gives (withJobVerdict).
      const job = (result as { job?: { attainment: string; basis: string } }).job;
      const given = (result as { exitCode?: unknown }).exitCode;
      const exitCode = job !== undefined && typeof given === "number" ? given : (JOURNEY_RUN_OUTCOMES as readonly string[]).includes(outcome) ? journeyExitCode(outcome as JourneyRunOutcome) : 2;
      return { outcome, exitCode, ...withRun, ...(job === undefined ? {} : { job: { attainment: job.attainment, basis: job.basis } }) };
    } catch (err) {
      // 0.30.0 §5.4: held for a person (`jevitate inbox approve <holdId>`, then `inbox resume`): it proves nothing yet.
      const held = heldOutcomeOf(err);
      if (held !== undefined) return { outcome: "held", exitCode: 2, ...(runId === undefined ? {} : { runId }), ...(typeof held.code === "string" ? { code: held.code } : {}) };
      throw err;
    }
  };
}

/**
 * GAPS 23: `mission run`'s exit code. A claimed mission that could not run at all, or a Journey call that
 * could not run, is `inconclusive` (2): it proves nothing, so never 1 (exit-codes.ts). A mission that ran
 * counts whatever its own outcome (unchanged). A drained Journey call that ran counts its own exit code
 * (0 ok · 1 defects/not-achieved · 2 unverified under `require`, held · 5 pending review), and the worst
 * wins by the missions' severity order (`combineOutcomes`, @jevitate/domain mission-outcome.ts).
 */
export function drainExitCode(report: Pick<DrainReport, "ran" | "journeys">): number {
  const byCode = new Map<number, MissionOutcome>();
  for (const o of MISSION_OUTCOMES) if (!byCode.has(MISSION_EXIT_CODES[o])) byCode.set(MISSION_EXIT_CODES[o], o);
  const outcomes: MissionOutcome[] = [];
  if (report.ran.some((m) => m.status === "failed")) outcomes.push("inconclusive");
  for (const j of report.journeys ?? []) {
    if (j.status === "failed") outcomes.push("inconclusive");
    else outcomes.push(j.exitCode === undefined ? "inconclusive" : (byCode.get(j.exitCode) ?? "inconclusive"));
  }
  return MISSION_EXIT_CODES[combineOutcomes(outcomes)];
}
