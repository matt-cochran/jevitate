import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { dirname as dirnameOf, join as joinPath } from "node:path";
import { validateInvariantSpec, type InvariantSpec, type Recording, type RecordingEmulation } from "@jevitate/recording";
import { loadInvariantFiles, resolveInvariantAuthTokens } from "./invariants-file.js";
import { buildMissionFixtures, type FixtureFlags } from "./fixture-cli.js";
import { observerSessions } from "./mission-actors.js";
import {
  FixtureSpecError,
  fixtureReplayOpener,
  hookHash,
  loadFixtureFile,
  parseFixtureSpec,
  secretFieldNames,
  type FixtureRecord,
  type FixtureSpec,
  type MissionFixtures,
} from "./mission-fixtures.js";
import { PlaywrightBrowserPort, resolveEmulation, type BrowserPort, type EmulationSpec } from "@jevitate/playwright";
import { assertSameExtensionBuild, listVideos, runVideoDir, sessionLaunchOptions, type BrowserRunOptions, type SessionLaunchOptions } from "./browser-run-options.js";
import { artifactStamp, writeMissionResult } from "./mission-journal.js";
import { BrowseTheWeb, CastActor } from "@jevitate/screenplay";
import { isEnvironmentError, resolveJourneyEnvironment } from "./environments.js";
import {
  assertAuthorizedExploreTarget,
  normalizeAllowlist,
  verifyFix,
  type PerceiveOptions,
  type VerifyFixResult,
  type VerifyFixVerdict,
  type VerifyInvariant,
  type VerifySession,
} from "@jevitate/explore";
import { verifyServerLogDefect } from "./server-log-verify.js";
import { defectSignalText, persistedDefect, replayWithEvidence, signalCheckable, type DefectEvidence } from "./defect-evidence.js";
import { RunScreenshots, screenshotsDirFor, type ScreenshotsResult, type ScreenshotsSpec } from "./run-screenshots.js";
import { clock, isRecord } from "@jevitate/domain";
import { prepareMcpRunGuard } from "./mcp-run-guard.js";
import { guardRequestWithMode, resolveSurfaceRunMode, runModeRecord, type RunModeRecord } from "./run-surface-mode.js";
import { redactSensitivePath, redactSensitiveValue, type RedactionFieldRule } from "./terminal-result.js";
import {
  BranchReplayInputError,
  anchoredRecording,
  prefixFromBranch,
  prefixedOpener,
  recordedBranchOf,
  type JourneyPrefix,
  type PrefixFromBranchOptions,
  type RecordedBranch,
} from "./journey-prefix.js";
import { resolveTargetConfig, type TargetConfig } from "./target-config.js";
import { journeyFixtureBaseDir } from "./journey-api.js";
import {
  parsePersistedMission,
  VerifyFixInputError,
  type PersistedActor,
  type PersistedFinding,
  type PersistedMission,
} from "./verify-fix-persisted.js";

/**
 * The replay half of `verify-fix`: reads a persisted mission result, finds the defect by
 * fingerprint, and replays its reproduction in fresh sessions. Split into phases — load the
 * result, resolve the finding and its fixtures, build the replay/emulation options, run the
 * replay, collect evidence, assemble the report — so no one function carries the whole decision
 * tree. `runVerifyFix` / `verifyFixArtifactPath` stay in `verify-fix-api.ts` and call `replayFinding`.
 */

export interface RunVerifyFixOptions {
  /** Path of the mission's `<stem>.result.json`. */
  readonly resultPath: string;
  /** `targets.json` as the MCP floor reads it (default: `~/.jevitate/targets.json`). */
  readonly runGuardTargetsFile?: string;
  /**
   * #293: a finding a journey-anchored run found (its result's `branch`) is replayed THROUGH the same
   * Journey prefix — every replay session replays it first, and the finding's Recording starts on
   * the live anchor page (its leading navigate becomes an assertion). These are the prefix's secret
   * `--param`s (never persisted) and the site-policy database / environment seams it runs under.
   */
  readonly journeyPrefix?: PrefixFromBranchOptions;
  /** The defect (or hang) fingerprint to verify. */
  readonly fingerprint: string;
  /** Overrides the storageState recorded with the mission (CLI `--storage-state`). */
  readonly storageState?: string;
  readonly browserPortFactory?: () => BrowserPort;
  /** How Chromium is launched and shown (#245: `--headed`/`--slow-mo`/`--record-video`). Default: headless. */
  readonly browser?: BrowserRunOptions;
  /** Settle ceiling after the replay (ms). */
  readonly settleCeilingMs?: number;
  /** Per-target settle/hang configuration, keyed by origin (`~/.jevitate/targets.json`). */
  readonly targets?: Readonly<Record<string, TargetConfig>>;
  /** Fresh-context replays for a non-hang defect signal (#74, CLI `--replays`). Default 3. */
  readonly replays?: number;
  /** #303 `--action-deltas`: compare the replayed defect step's delta with the recorded one (evidence). */
  readonly actionDeltas?: boolean;
  /**
   * Invariant files (CLI `--invariants`, #86) to re-check a declared-invariant defect with, instead of
   * the spec persisted with the mission. Validated against the MISSION's allowlist before any replay.
   */
  readonly invariantFiles?: readonly string[];
  /** Re-checking a `server-log` defect whose sources include a `cmd:` one needs this too (#142). */
  readonly allowLogCmd?: boolean;
  /** `--hang-replay-writes` (#153): a hang's replay may re-send a paid/destructive write. */
  readonly hangReplayWrites?: boolean;
  /**
   * Mission fixtures (#140/#144): every replay restores + re-runs the mission's own fixture (saved
   * with its result) so it starts from the same state. `fixtures` overrides the saved spec; the
   * mission's shell hooks are never replayed from the file — the operator re-supplies the SAME
   * `before`/`after` (checked by hash) with `allowShellHooks`.
   */
  readonly fixtureFlags?: FixtureFlags;
  /** Values redacted from everything the fixture logs (CLI `--secret`). */
  readonly secrets?: readonly string[];
  /**
   * Explicit `--viewport` / `--device` override (#149). Defaults to the finding's OWN recorded
   * emulation (`recording.emulation`) — a 375px defect replays at 375px, not the caller's desktop
   * default. An override that DIFFERS from the recorded emulation is refused (fails closed) unless
   * `allowEmulationOverride` is set: replaying at the wrong device could report a false "fixed".
   */
  readonly emulation?: EmulationSpec;
  /** Replay at `emulation` even though it differs from the finding's recorded emulation. */
  readonly allowEmulationOverride?: boolean;
  /**
   * #251 `--screenshots`: masked screenshots of the captioned "after" replay (one per distinct
   * screen, or per step) + `index.md`.
   */
  readonly screenshots?: ScreenshotsSpec;
  /** #250: caption time per step in the "after" clip (ms). Default `EVIDENCE_PACE_MS`. */
  readonly evidencePaceMs?: number;
  /**
   * #484 `--allow <origin...>`: replay with these origins instead of the allow list stored with the
   * result (e.g. to prove a `localhost` → `127.0.0.1` config fix). Explicit only — never widened implicitly.
   */
  readonly allow?: readonly string[];
  /** #484 `--env <name>`: replay with that environment's CURRENT allow list (its `baseUrl` + `allow`). */
  readonly env?: string;
  /** The environments file `env` is read from (default: the repo's `.jevitate/environments.json`). */
  readonly environmentsFile?: string;
  /**
   * #767: opt-in — write this run's `VerifyFixReport` as `verify-fix-<stamp>.result.json`, where
   * `verifyFixArtifactPath` says, and return its path on the report. Default off, so a ledger/check
   * caller writes nothing.
   */
  readonly resultArtifact?: boolean;
  /**
   * #767: the stamp both this writer and the CLI's terminal layer use (`verify-fix-<stamp>.json`), so
   * a signal or parent death overwrites the same path instead of leaving two artifacts. Default: now.
   */
  readonly resultStamp?: string;
  /**
   * #767: called just before each replay session opens, so the CLI's terminal layer can report one
   * `progress()` per replay (the inactivity bound restarts). Never called outside a replay.
   */
  readonly onReplay?: (replay: number) => void;
  /**
   * Called with each secret this run learns beyond `secrets` (an invariant's auth token, a fixture's
   * secret output), as soon as it is known, so the CLI's terminal layer masks it from a later signal.
   */
  readonly onSecrets?: (values: readonly string[]) => void;
}

/** #484: the replay ran with an allow list other than the one stored with the result — which, and where from. */
export interface AllowlistOverride {
  readonly source: "--allow" | `--env ${string}`;
  /** The origins the replay was authorized against. */
  readonly origins: readonly string[];
  /** The allow list stored with the original result. */
  readonly recorded: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

/**
 * #250 — `verify-fix --record-video`: a before/after pair for the PR. `before` is the run's own
 * evidence clip of the defect (`--evidence-video` on the original run), `after` a captioned replay
 * of the same steps now (still reproducing, or passing), its final card the verdict.
 */
export interface VerifyFixEvidence {
  readonly before?: { readonly videoPath?: string; readonly screenshots: string[] };
  /** Why there is no `before` (the run recorded no evidence clip for this defect). */
  readonly beforeMissing?: string;
  readonly after: DefectEvidence;
}

export interface VerifyFixReport extends VerifyFixResult {
  readonly exitCode: number;
  /** The result file could not be written; the verdict above still stands (#767). */
  readonly artifactError?: string;
  /** #293: the Journey step the finding branched from, when its replays went through that prefix. */
  readonly branch?: RecordedBranch;
  /** #293: why the replays proved nothing — `journey-stale` when the prefix no longer replays. */
  readonly failure?: { readonly kind: "journey-stale"; readonly message: string };
  readonly title?: string;
  /** The fixture every replay started from (#140/#144): the mission's identity and this run's setup/restore log. */
  readonly fixtures?: FixtureRecord & { readonly missionIdentity: string };
  /** #245: `--record-video` files of every replay session (each closed, so finalized). */
  readonly videoPaths?: string[];
  /** #250: with `--record-video` (or `--screenshots`), the before/after evidence pair. */
  readonly evidence?: VerifyFixEvidence;
  /** #251: `--screenshots` of the captioned after-replay. */
  readonly screenshotPaths?: string[];
  readonly screenshotIndex?: string;
  readonly screenshotsSkipped?: ScreenshotsResult["screenshotsSkipped"];
  /** #484: present only when `--allow`/`--env` replaced the stored allow list — the origins used, and what changed. */
  readonly allowlistOverride?: AllowlistOverride;
  /** #767: the `<vfArtifact stem>.result.json` this run wrote, when `resultArtifact` was requested. */
  readonly resultPath?: string;
  /** 0.30.0 §5: the run mode of the replay's target (`run.mode`, `run.target.trust`), from the person-written files. */
  readonly run?: RunModeRecord;
}

export const VERIFY_FIX_EXIT_CODES: Readonly<Record<VerifyFixVerdict, number>> = {
  fixed: 0,
  "still-reproduces": 1,
  inconclusive: 2,
  intermittent: 4,
};

/**
 * The one place a mission's findings (declared-invariant defects, hangs, adversarial defects) are
 * looked up by fingerprint — a fingerprint the CALLER supplied may equal the finding's own, or one
 * of its `related` fingerprints (the same underlying defect observed at a different point). Shared
 * by `verify-fix` and `regression capture` (#119/#129): the latter reuses this lookup rather than
 * re-implementing "is this fingerprint a defect this mission found" itself.
 */
export function findFinding(mission: PersistedMission, fingerprint: string): PersistedFinding | undefined {
  return mission.findings.find((f) => f.fingerprint === fingerprint || (f.related ?? []).includes(fingerprint));
}

/**
 * #484: the allow list a verify-fix replay runs under. The result's stored list, unless the operator
 * EXPLICITLY overrides it with `--allow` or `--env` (not both) — the override is returned for the report.
 */
export function replayAllowlist(
  recorded: readonly string[],
  opts: Pick<RunVerifyFixOptions, "allow" | "env" | "environmentsFile">,
): { readonly allowlist: readonly string[]; readonly override?: AllowlistOverride } {
  const allow = opts.allow ?? [];
  if (allow.length === 0 && opts.env === undefined) return { allowlist: recorded };
  if (allow.length > 0 && opts.env !== undefined) throw new VerifyFixInputError("pass --allow or --env to override the stored allow list, not both");
  let origins: string[];
  let source: AllowlistOverride["source"];
  if (opts.env !== undefined) {
    try {
      const env = resolveJourneyEnvironment({ env: opts.env, targets: {}, ...(opts.environmentsFile === undefined ? {} : { environmentsFile: opts.environmentsFile }) });
      origins = normalizeAllowlist(env?.allowedOrigins ?? []);
    } catch (e) {
      if (isEnvironmentError(e)) throw new VerifyFixInputError(e.message);
      throw e;
    }
    source = `--env ${opts.env}`;
  } else {
    origins = normalizeAllowlist(allow);
    source = "--allow";
  }
  if (origins.length === 0) throw new VerifyFixInputError(`${source} names no origin to replay against`);
  const before = normalizeAllowlist(recorded);
  return {
    allowlist: origins,
    override: { source, origins, recorded, added: origins.filter((o) => !before.includes(o)), removed: before.filter((o) => !origins.includes(o)) },
  };
}

/** Whether an explicit `--viewport`/`--device` matches a finding's recorded emulation (#149). */
function emulationMatchesRecorded(explicit: EmulationSpec, recorded: RecordingEmulation): boolean {
  if (explicit.device !== undefined || recorded.device !== undefined) return explicit.device === recorded.device;
  if (explicit.viewport === undefined) return true;
  return explicit.viewport.width === recorded.viewport.width && explicit.viewport.height === recorded.viewport.height;
}

/** The controls a persisted mission's side effects show firing a write (#181), for hang-replay withholding. */
function recordedWriters(raw: unknown): string[] {
  const r = raw as { readonly sideEffects?: unknown; readonly result?: { readonly sideEffects?: unknown } } | null;
  const list: unknown = r?.sideEffects ?? r?.result?.sideEffects;
  if (!Array.isArray(list)) return [];
  return list.flatMap((e: unknown) => {
    const control = (e as { readonly control?: unknown } | null)?.control;
    return typeof control === "string" ? [control] : [];
  });
}

function describeEmulation(e: RecordingEmulation): string {
  return e.device !== undefined ? `--device "${e.device}"` : `--viewport ${e.viewport.width}x${e.viewport.height}`;
}

/** Closed vocabularies, identifiers and digests: a short `--param` or a hex shape must not rewrite them. */
const REPORT_VERBATIM_FIELDS: ReadonlySet<string> = new Set([
  "verdict",
  "fingerprint",
  "observedFingerprints",
  "outcome",
  "kind",
  "rule",
  "identity",
  "specHash",
  "missionIdentity",
  "secretOutputs",
]);
const REPORT_PATH_FIELDS: ReadonlySet<string> = new Set(["videoPaths", "videoPath", "screenshots", "screenshotPaths", "screenshotIndex", "journeysDir"]);
const reportFieldRule: RedactionFieldRule = (key) => (REPORT_VERBATIM_FIELDS.has(key) ? "verbatim" : REPORT_PATH_FIELDS.has(key) ? "path" : undefined);

/** Everything `replayFinding` reads out of the persisted result before it opens anything. */
interface LoadedReplay {
  readonly raw: unknown;
  readonly persisted: PersistedMission;
  readonly replay: { readonly allowlist: readonly string[]; readonly override?: AllowlistOverride };
  readonly mission: PersistedMission;
  readonly finding: PersistedFinding;
  readonly origin: string;
  readonly replayEnvironment: ReturnType<typeof resolveJourneyEnvironment>;
  readonly runMode: RunModeRecord;
  readonly target: TargetConfig;
  readonly storageState: string | undefined;
}

/** The browser/session and emulation decisions, once the finding's Recording is known. */
interface ReplayPlan {
  readonly portFactory: () => BrowserPort;
  readonly vfArtifact: string;
  readonly videoDir: string | undefined;
  readonly shown: SessionLaunchOptions;
  readonly found: Recording;
  readonly recording: Recording;
  readonly branch: RecordedBranch | undefined;
  readonly prefix: JourneyPrefix | undefined;
  readonly effectiveEmulation: EmulationSpec | undefined;
}

/** The invariant, observers and fixture the replay must reproduce. */
interface InvariantPlan {
  readonly invariantSpec: InvariantSpec | undefined;
  readonly invariantAuthTokens: Map<string, string> | undefined;
  readonly observers: readonly PersistedActor[];
  readonly primaryActor: string | undefined;
  readonly fx: MissionFixtures | undefined;
  readonly declared: VerifyInvariant | undefined;
}

/** The verdict the replay produced, and the prefix staleness that overrode it. */
interface ReplayOutcome {
  readonly result: VerifyFixResult;
  readonly stale: { readonly message: string } | undefined;
}

interface EvidenceOutcome {
  readonly evidence: VerifyFixEvidence | undefined;
  readonly shotFields: Partial<ScreenshotsResult>;
}

/** Runs the replay and returns its report. */
export async function replayFinding(
  opts: RunVerifyFixOptions,
  known: ReadonlySet<string>,
  learn: (values: readonly string[]) => void,
  artifactPathFor: (stamp: string) => string,
): Promise<VerifyFixReport> {
  const loaded = await loadPersistedReplay(opts);
  const plan = await buildReplayPlan(opts, loaded, artifactPathFor, learn);
  const inv = resolveInvariantPlan(opts, loaded, plan, known, learn);
  const outcome = await executeReplay(opts, loaded, plan, inv, known, learn);
  const evidence = await captureEvidence(opts, loaded, plan, inv, outcome, known);
  return assembleReport(opts, loaded, plan, inv, outcome, evidence, known, learn);
}

/** Phase 1: read and validate the persisted result, resolve its finding, and arm the run guard. */
async function loadPersistedReplay(opts: RunVerifyFixOptions): Promise<LoadedReplay> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(opts.resultPath, "utf8"));
  } catch (e) {
    throw new VerifyFixInputError(`cannot read mission result ${opts.resultPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const persisted = parsePersistedMission(raw);
  // #484: the stored allow list, unless --allow/--env EXPLICITLY replaces it (recorded on the report).
  const replay = replayAllowlist(persisted.target.allowlist, opts);
  const mission: PersistedMission =
    replay.override === undefined ? persisted : { ...persisted, target: { ...persisted.target, allowlist: [...replay.allowlist] } };
  const finding = findFinding(mission, opts.fingerprint);
  if (finding === undefined) {
    throw new VerifyFixInputError(`no finding with fingerprint ${opts.fingerprint} in ${opts.resultPath}`);
  }
  // Guardrail #1: the replay may only ever touch the mission's own authorized origins.
  const origin = assertAuthorizedExploreTarget(mission.target.seedUrl, mission.target.allowlist);
  const replayEnvironment = opts.env === undefined ? undefined : resolveJourneyEnvironment({ env: opts.env, targets: {}, ...(opts.environmentsFile === undefined ? {} : { environmentsFile: opts.environmentsFile }) });
  // 0.30.0 §5: the run mode of the finding's origin, from the person-written files only. A finding's
  // reproduction is no Journey (no approval to check): the mode goes to the guard below and to the report.
  const decided = resolveSurfaceRunMode({ surface: "verify-fix", origin, environment: replayEnvironment, targetsFile: opts.runGuardTargetsFile, ...(opts.environmentsFile === undefined ? {} : { environmentsFile: opts.environmentsFile }) });
  const runMode: RunModeRecord = runModeRecord(decided);
  // #789: over MCP a finding is not replayed on a production origin, with one in its allowlist, or under a production environment's allow list, before anything opens. The CLI is the person's.
  // (No write guard is armed on its sessions, so test mode has nothing to relax here: production refuses in every mode.)
  prepareMcpRunGuard(
    guardRequestWithMode(
      {
        site: origin,
        allowedOrigins: mission.target.allowlist,
        refuseProductionInAllowlist: true,
        environment: replayEnvironment,
        targetsFile: opts.runGuardTargetsFile,
        environmentsFile: opts.environmentsFile,
      },
      decided,
      [],
    ),
  );
  const target = resolveTargetConfig(opts.targets ?? {}, origin);
  // #175: the operator's targets.json session is the last fallback (verify_fix over MCP of a
  // mission recorded without one); never an MCP argument.
  const storageState = opts.storageState ?? mission.target.storageStatePath ?? target.storageState;
  if (storageState !== undefined && !existsSync(storageState)) {
    throw new VerifyFixInputError(`storage state not found: ${storageState}`);
  }
  return { raw, persisted, replay, mission, finding, origin, replayEnvironment, runMode, target, storageState };
}

/** Phase 2: resolve the Recording, its Journey prefix, and the session/emulation to replay under. */
async function buildReplayPlan(
  opts: RunVerifyFixOptions,
  loaded: LoadedReplay,
  artifactPathFor: (stamp: string) => string,
  learn: (values: readonly string[]) => void,
): Promise<ReplayPlan> {
  const { mission, finding, storageState, raw } = loaded;
  const portFactory = opts.browserPortFactory ?? (() => new PlaywrightBrowserPort());
  // #245: every replay (and observer) session is shown/recorded alike — videos in
  // `verify-fix-<stamp>.videos/` beside the artifact (or under `--record-video <dir>`).
  // #767: the CLI supplies the stamp so its terminal-layer artifact and this report share one path.
  const vfArtifact = artifactPathFor(opts.resultStamp ?? artifactStamp(clock.nowIso()));
  const videoDir = runVideoDir(opts.browser, vfArtifact);
  // The dated logs folder may not exist yet, unlike the folder of a mission result.
  if (videoDir !== undefined || opts.screenshots !== undefined) mkdirSync(dirnameOf(vfArtifact), { recursive: true });
  const shown = sessionLaunchOptions(opts.browser, videoDir);
  const found = finding.recording ?? mission.recording;
  if (found === null) throw new VerifyFixInputError(`finding ${finding.fingerprint} has no Recording to replay`);
  // #293: a finding from a branch point replays through its Journey prefix (resolved now, refused if
  // its secret params are not given again), on the live anchor page — never from the anchor URL.
  const branch = recordedBranchOf((raw as { result?: unknown } | null)?.result);
  let prefix: JourneyPrefix | undefined;
  if (branch !== undefined) {
    try {
      prefix = await prefixFromBranch(branch, { ...(opts.journeyPrefix ?? {}), ...(storageState === undefined ? {} : { storageState }) });
    } catch (e) {
      if (e instanceof BranchReplayInputError) throw new VerifyFixInputError(e.message);
      throw e;
    }
    learn(prefix.secrets);
  }
  const recording = prefix === undefined ? found : anchoredRecording(found);
  // #256: replay only under the extension build the finding was recorded with (none ⇔ none).
  try {
    assertSameExtensionBuild(recording.extensions, opts.browser, `finding ${finding.fingerprint}`);
  } catch (e) {
    throw new VerifyFixInputError(e instanceof Error ? e.message : String(e));
  }
  // #149: replay under the finding's OWN recorded emulation by default — a 375px defect reproduces
  // at 375px, not the caller's desktop default. An explicit --viewport/--device that DIFFERS from
  // it fails closed (never silently "verifies fixed" at the wrong device) unless overridden.
  const effectiveEmulation = resolveEffectiveEmulation(opts, recording.emulation);
  resolveEmulation(effectiveEmulation); // refused BEFORE any browser opens (an unknown device, e.g.)
  return { portFactory, vfArtifact, videoDir, shown, found, recording, branch, prefix, effectiveEmulation };
}

/** #149: the emulation to replay under, refused when an explicit override differs from the recording's. */
function resolveEffectiveEmulation(opts: RunVerifyFixOptions, recordedEmulation: RecordingEmulation | undefined): EmulationSpec | undefined {
  if (opts.emulation !== undefined) {
    if (recordedEmulation !== undefined && !emulationMatchesRecorded(opts.emulation, recordedEmulation) && opts.allowEmulationOverride !== true) {
      throw new VerifyFixInputError(
        `--viewport/--device differs from the finding's recorded emulation (${describeEmulation(recordedEmulation)}); ` +
          "pass allowEmulationOverride (CLI --allow-emulation-override) to replay at a different emulation anyway",
      );
    }
    return opts.emulation;
  }
  if (recordedEmulation !== undefined) {
    return recordedEmulation.device !== undefined ? { device: recordedEmulation.device } : { viewport: recordedEmulation.viewport };
  }
  return undefined;
}

/** Phase 3: the invariant spec, its observer actors, and the mission fixture every replay restores. */
function resolveInvariantPlan(
  opts: RunVerifyFixOptions,
  loaded: LoadedReplay,
  plan: ReplayPlan,
  known: ReadonlySet<string>,
  learn: (values: readonly string[]) => void,
): InvariantPlan {
  const { mission, finding, target, storageState, origin } = loaded;
  const { portFactory, shown } = plan;
  // #147: a cross-actor defect is re-checked from the SAME observers, each in a fresh context per replay.
  const observers = (mission.target.actors ?? []).filter((a) => a.role === "observer");
  for (const o of observers) {
    if (!existsSync(o.storageStatePath)) throw new VerifyFixInputError(`actor ${o.name}: storage state not found: ${o.storageStatePath}`);
  }
  // A declared-invariant defect (#86) is re-checked with the same spec (or `--invariants`), its probes
  // authorized against the MISSION's own origins before any browser opens.
  let invariantSpec: InvariantSpec | undefined;
  // #135: authFrom.secret refs (env:VAR), resolved from the environment HERE — the one place this
  // package reads process.env for invariants — never inside @jevitate/explore or @jevitate/recording.
  let invariantAuthTokens: Map<string, string> | undefined;
  try {
    const bounds = { allowlist: mission.target.allowlist, baseUrl: mission.target.seedUrl, observers: observers.map((o) => o.name) };
    invariantSpec =
      opts.invariantFiles !== undefined && opts.invariantFiles.length > 0
        ? loadInvariantFiles(opts.invariantFiles, bounds)
        : mission.invariantSpec === undefined
          ? undefined
          : validateInvariantSpec(mission.invariantSpec, bounds);
    invariantAuthTokens = invariantSpec === undefined ? undefined : resolveInvariantAuthTokens(invariantSpec, process.env);
  } catch (e) {
    throw new VerifyFixInputError(e instanceof Error ? e.message : String(e));
  }
  learn([...(invariantAuthTokens?.values() ?? [])]);
  const primaryActor = mission.target.actors?.find((a) => a.role === "primary")?.name;
  const fx = missionFixtures(mission, opts.fixtureFlags ?? {}, storageState, [...known], target.personas, learn);
  const declared: VerifyInvariant | undefined =
    finding.kind === "invariant" && finding.invariantId !== undefined && invariantSpec !== undefined
      ? {
          spec: invariantSpec,
          id: finding.invariantId,
          allowlist: mission.target.allowlist,
          baseUrl: mission.target.seedUrl,
          ...(invariantAuthTokens === undefined || invariantAuthTokens.size === 0 ? {} : { authTokens: invariantAuthTokens }),
          ...(observers.length === 0
            ? {}
            : {
                openObservers: () =>
                  observerSessions(
                    portFactory,
                    { ...shown, allowedOrigins: [...mission.target.allowlist], baseUrl: origin },
                    observers.map((o) => ({ name: o.name, storageState: o.storageStatePath })),
                  ),
              }),
          ...(primaryActor === undefined ? {} : { primaryActor }),
        }
      : undefined;
  return { invariantSpec, invariantAuthTokens, observers, primaryActor, fx, declared };
}

/** Phase 4: open fresh sessions (through the prefix and fixture), run the replay, and restore. */
async function executeReplay(
  opts: RunVerifyFixOptions,
  loaded: LoadedReplay,
  plan: ReplayPlan,
  inv: InvariantPlan,
  known: ReadonlySet<string>,
  learn: (values: readonly string[]) => void,
): Promise<ReplayOutcome> {
  const { mission, origin, target, storageState } = loaded;
  const { portFactory, shown, recording, effectiveEmulation, prefix } = plan;
  const { fx } = inv;
  const perceiveOpts: PerceiveOptions = {
    // Read at each perception: a fixture or a prefix can add to what the run knows after this.
    get secrets(): readonly string[] {
      return [...known];
    },
    ...(opts.settleCeilingMs === undefined ? {} : { renderWaitMs: opts.settleCeilingMs }),
    ...(target.settle === undefined ? {} : { settleConfig: target.settle }),
    ...(target.hangs === undefined ? {} : { hangConfig: target.hangs }),
  };
  let replayOpened = 0;
  const openSession = async (): Promise<VerifySession> => {
    // #767: one progress report per replay, so the terminal layer's inactivity bound restarts.
    replayOpened += 1;
    opts.onReplay?.(replayOpened);
    // The fixture was set up afresh just before this: its secret outputs are this replay's to mask.
    if (fx !== undefined) learn(fx.secrets());
    const session = await portFactory().open({
      ...shown,
      allowedOrigins: [...mission.target.allowlist],
      baseUrl: origin,
      ...effectiveEmulation,
      ...(storageState !== undefined ? { storageState } : {}),
    });
    const actor = CastActor.named("verify-fix").whoCan(new BrowseTheWeb(session, [...mission.target.allowlist]));
    return { page: session.page, actor, close: () => session.close() };
  };
  // #293: every replay session first goes back through the finding's Journey prefix.
  const prefixed = prefix === undefined ? undefined : prefixedOpener(openSession, prefix, mission.target.allowlist, opts.browser);
  const branchOpen = prefixed?.open ?? openSession;
  // Each replay restores the mission's fixture state first; a failed setup makes that replay
  // "could not open a session" — no evidence, so never `fixed`.
  const replaySession =
    fx === undefined ? branchOpen : fixtureReplayOpener(branchOpen, fx, recording.fixture?.outputs ?? mission.fixtures?.outputs ?? {});
  let result: VerifyFixResult;
  try {
    result = await runReplay(opts, loaded, plan, inv, perceiveOpts, known, replaySession);
  } finally {
    await fx?.restore();
  }
  // #293: a prefix that no longer replays proved nothing: a typed inconclusive, never `fixed`.
  const stale = prefixed?.stale();
  if (stale !== undefined) {
    result = { ...result, verdict: "inconclusive", reason: `journey-stale: ${stale.message}` };
  }
  return { result, stale };
}

/** Re-check the finding: a `server-log` defect re-tails its sources, everything else replays via explore. */
async function runReplay(
  opts: RunVerifyFixOptions,
  loaded: LoadedReplay,
  plan: ReplayPlan,
  inv: InvariantPlan,
  perceive: PerceiveOptions,
  known: ReadonlySet<string>,
  replaySession: () => Promise<VerifySession>,
): Promise<VerifyFixResult> {
  const { raw, finding, target } = loaded;
  const { recording } = plan;
  const { declared } = inv;
  // A `server-log` defect (#142) is re-checked by REPLAYING and re-tailing the SAME log sources —
  // never by `@jevitate/explore`'s `verifyFix`, which only looks at DOM/console/network signals.
  if (finding.kind === "server-log") {
    if (finding.serverLog === undefined) {
      return {
        fingerprint: finding.fingerprint,
        verdict: "inconclusive",
        observedFingerprints: [],
        replay: { outcome: "failed", at: -1, error: "not replayed" },
        reason: "a server-log defect needs its log source(s) and matcher to be re-checked",
      };
    }
    return await verifyServerLogDefect({
      recording,
      recordingStepIndex: finding.repro.recordingStepIndex,
      fingerprint: finding.fingerprint,
      sources: finding.serverLog.sources,
      matcher: finding.serverLog.matcher,
      normalizedMessage: finding.serverLog.normalizedMessage,
      drainMs: finding.serverLog.drainMs,
      ...(finding.serverLog.scope === undefined ? {} : { scope: finding.serverLog.scope }),
      // #142 follow-up: an explicit --allow-log-cmd wins; otherwise the operator's own
      // ~/.jevitate/targets.json entry for this origin may opt in (never an MCP argument).
      allowLogCmd: opts.allowLogCmd === true || target.allowLogCmd === true,
      ...(opts.settleCeilingMs === undefined ? {} : { settleCeilingMs: opts.settleCeilingMs }),
      ...(opts.replays === undefined ? {} : { replays: opts.replays }),
      openSession: replaySession,
    });
  }
  return await verifyFix({
    fixtureBaseDir: journeyFixtureBaseDir(),
    perceive,
    recording,
    recordingStepIndex: finding.repro.recordingStepIndex,
    fingerprint: finding.fingerprint,
    defectKind: finding.kind,
    ...(declared === undefined ? {} : { invariant: declared }),
    ...(finding.hang === undefined ? {} : { hang: finding.hang }),
    // #153: never re-send a paid/destructive write unless the operator opted in.
    safety: { ...(target.safety ?? {}), ...(opts.hangReplayWrites === true ? { hangReplayWrites: true } : {}) },
    writtenBy: recordedWriters(raw),
    ...(finding.occurrences === undefined ? {} : { occurrences: finding.occurrences }),
    ...(opts.settleCeilingMs === undefined ? {} : { settleCeilingMs: opts.settleCeilingMs }),
    ...(opts.replays === undefined ? {} : { replays: opts.replays }),
    ...(opts.actionDeltas === true ? { actionDeltas: true, secrets: [...known] } : {}),
    openSession: replaySession,
  });
}

/** Phase 5: the captioned "after" replay (video and/or screenshots), paired with the run's own clip. */
async function captureEvidence(
  opts: RunVerifyFixOptions,
  loaded: LoadedReplay,
  plan: ReplayPlan,
  inv: InvariantPlan,
  outcome: ReplayOutcome,
  known: ReadonlySet<string>,
): Promise<EvidenceOutcome> {
  // #250/#251: the captioned "after" replay (video and/or screenshots), paired with the run's own clip.
  if (opts.browser?.recordVideo === undefined && opts.screenshots === undefined) {
    return { evidence: undefined, shotFields: {} };
  }
  const { raw, finding } = loaded;
  const { vfArtifact } = plan;
  const secrets = [...known];
  const stored = persistedDefect(raw, finding.fingerprint);
  const storedEvidence = stored !== undefined && isRecord(stored.evidence) ? stored.evidence : undefined;
  const beforeVideo = typeof storedEvidence?.videoPath === "string" ? storedEvidence.videoPath : undefined;
  const beforeShots = Array.isArray(storedEvidence?.screenshots) ? storedEvidence.screenshots.filter((x): x is string => typeof x === "string") : [];
  const shots =
    opts.screenshots === undefined
      ? undefined
      : new RunScreenshots({ spec: opts.screenshots, dir: screenshotsDirFor(opts.screenshots, vfArtifact), secrets, title: `verify-fix ${finding.fingerprint}` });
  const after = await buildAfterEvidence(opts, loaded, plan, inv, outcome.result, stored, shots, secrets);
  const evidence: VerifyFixEvidence = {
    ...(beforeVideo === undefined && beforeShots.length === 0 ? {} : { before: { ...(beforeVideo === undefined ? {} : { videoPath: beforeVideo }), screenshots: beforeShots } }),
    ...(beforeVideo === undefined ? { beforeMissing: "the run recorded no evidence clip for this defect (run it with --evidence-video)" } : {}),
    after,
  };
  const shotFields = shots === undefined ? {} : await shots.finish();
  return { evidence, shotFields };
}

/** The "after" clip/screenshots, or why that replay would prove nothing (a prefix, fixture or cross-actor). */
async function buildAfterEvidence(
  opts: RunVerifyFixOptions,
  loaded: LoadedReplay,
  plan: ReplayPlan,
  inv: InvariantPlan,
  result: VerifyFixResult,
  stored: ReturnType<typeof persistedDefect>,
  shots: RunScreenshots | undefined,
  secrets: readonly string[],
): Promise<DefectEvidence> {
  const { mission, finding, storageState } = loaded;
  const { portFactory, recording, effectiveEmulation, prefix, vfArtifact, videoDir } = plan;
  const { fx, observers } = inv;
  if (prefix !== undefined) {
    return { screenshots: [], skipped: "a finding from a Journey branch point: the after-clip replay does not replay the prefix" };
  }
  if (fx !== undefined || observers.length > 0) {
    return { screenshots: [], skipped: fx !== undefined ? "the run used mission fixtures: the after-clip replay does not restore them" : "a cross-actor defect: no after-clip replay" };
  }
  const verdictCard = (): { text: string; ok: boolean } =>
    result.verdict === "fixed"
      ? { text: "After the fix: the defect no longer reproduces", ok: true }
      : { text: `After: ${result.verdict === "still-reproduces" ? "still reproduces" : result.verdict}`, ok: false };
  return await replayWithEvidence({
    recording,
    stepIndex: finding.repro.recordingStepIndex,
    fingerprints: [finding.fingerprint, ...(finding.related ?? [])],
    signalCheckable: signalCheckable(finding.kind),
    signal: defectSignalText(stored ?? { kind: finding.kind, ...(finding.title === undefined ? {} : { title: finding.title }) }, secrets),
    seedUrl: mission.target.seedUrl,
    allowlist: mission.target.allowlist,
    ...(storageState === undefined ? {} : { storageState }),
    ...(effectiveEmulation === undefined ? {} : { emulation: effectiveEmulation }),
    outDir: joinPath(dirnameOf(videoDir ?? vfArtifact), `${vfArtifact.replace(/^.*[\\/]/, "").replace(/\.json$/, "")}.evidence`),
    video: opts.browser?.recordVideo !== undefined,
    ...(shots === undefined ? {} : { screenshots: shots }),
    secrets,
    ...(opts.browser === undefined ? {} : { browser: opts.browser }),
    browserPortFactory: portFactory,
    ...(opts.evidencePaceMs === undefined ? {} : { paceMs: opts.evidencePaceMs }),
    ...(opts.settleCeilingMs === undefined ? {} : { settleCeilingMs: opts.settleCeilingMs }),
    finalCard: verdictCard,
  });
}

/** Phase 6: assemble the (redacted) report and, when opted in, write the result artifact. */
async function assembleReport(
  opts: RunVerifyFixOptions,
  loaded: LoadedReplay,
  plan: ReplayPlan,
  inv: InvariantPlan,
  outcome: ReplayOutcome,
  evidenceOutcome: EvidenceOutcome,
  known: ReadonlySet<string>,
  learn: (values: readonly string[]) => void,
): Promise<VerifyFixReport> {
  const { mission, finding, replay, runMode } = loaded;
  const { vfArtifact, videoDir, branch } = plan;
  const { fx } = inv;
  const { result, stale } = outcome;
  const { evidence, shotFields } = evidenceOutcome;
  if (fx !== undefined) learn(fx.secrets());
  const report: VerifyFixReport = {
    ...result,
    exitCode: VERIFY_FIX_EXIT_CODES[result.verdict],
    run: runMode,
    ...(branch === undefined ? {} : { branch }),
    ...(stale === undefined ? {} : { failure: { kind: "journey-stale" as const, message: stale.message } }),
    ...(evidence === undefined ? {} : { evidence }),
    ...shotFields,
    ...(finding.title === undefined ? {} : { title: finding.title }),
    ...(replay.override === undefined ? {} : { allowlistOverride: replay.override }),
    ...(fx === undefined ? {} : { fixtures: { ...fx.record(), missionIdentity: mission.fixtures?.identity ?? "none" } }),
    // Every replay closed its own session (finalizing its video) before verifyFix returned.
    ...(videoDir === undefined ? {} : { videoPaths: listVideos(videoDir) }),
  };
  // A `reason` or `title` can quote a secret, or a URL with a token in it. Nothing past here sees the raw report.
  const secrets = [...known];
  const redacted = redactSensitiveValue(report, secrets, reportFieldRule) as VerifyFixReport;
  // #767: opt-in, through the mission result writer.
  if (opts.resultArtifact !== true) return redacted;
  // The verdict is what the replays paid for: a folder that can't take the file must not cost it.
  try {
    mkdirSync(dirnameOf(vfArtifact), { recursive: true });
    const written = writeMissionResult(vfArtifact, report.verdict, report.exitCode, redacted);
    return { ...redacted, resultPath: redactSensitivePath(written, secrets) };
  } catch (err) {
    return { ...redacted, artifactError: redactSensitiveValue(err instanceof Error ? err.message : String(err), secrets) as string };
  }
}

/**
 * The replay fixture: the mission's saved spec (re-validated against the MISSION's allowlist, never
 * trusted as-is) or `--fixtures`, plus the operator's re-supplied shell hooks, which must match the
 * mission's by hash. A mission that ran with a fixture never replays without one.
 */
function missionFixtures(
  mission: PersistedMission,
  flags: FixtureFlags,
  storageState: string | undefined,
  secrets: readonly string[],
  /** #243: the origin's targets.json personas — bind a fixture identity no flag or saved path names. */
  personas?: TargetConfig["personas"],
  learn?: (values: readonly string[]) => void,
): MissionFixtures | undefined {
  const saved = mission.fixtures;
  if (saved === undefined && flags.fixtures === undefined && flags.before === undefined && flags.after === undefined && (flags.fixtureIdentity ?? []).length === 0) {
    return undefined;
  }
  const bounds = { allowlist: mission.target.allowlist, baseUrl: mission.target.seedUrl };
  const hooks = saved?.hooks ?? {};
  const given = {
    ...(flags.before === undefined ? {} : { before: hookHash(flags.before) }),
    ...(flags.after === undefined ? {} : { after: hookHash(flags.after) }),
  };
  if (given.before !== hooks.before || given.after !== hooks.after) {
    throw new VerifyFixInputError(
      hooks.before === undefined && hooks.after === undefined
        ? "the mission ran without shell hooks; do not pass --before/--after"
        : "the mission ran with --before/--after shell hooks: re-supply the SAME commands with --allow-shell-hooks (they are never replayed from the result file)",
    );
  }
  try {
    const openRefs = { openRefs: hooks.before !== undefined };
    const spec: FixtureSpec | undefined =
      flags.fixtures !== undefined
        ? loadFixtureFile(flags.fixtures, bounds, openRefs)
        : saved?.spec !== undefined
          ? parseFixtureSpec(saved.spec, bounds, openRefs)
          : undefined;
    // `--secret-field` bindings a spec authenticates with come from the same environment variables.
    const names = secretFieldNames(spec); // `auth: {from: "secretField"}` and `${secretField.VAR}` (#166)
    const secretFields = names.flatMap((name) => {
      const secret = process.env[name];
      return secret === undefined ? [] : [{ descriptor: name, matcher: { key: "name" as const, value: name }, name, kind: "value" as const, secret }];
    });
    learn?.(secretFields.map((f) => f.secret));
    const { fixtures: _file, ...hookFlags } = flags;
    return buildMissionFixtures(hookFlags, {
      ...bounds,
      ...(storageState === undefined ? {} : { storageState }),
      secretFields,
      secrets,
      ...(spec === undefined ? {} : { spec }),
      // #243: re-mint as the SAME identities (the saved paths), unless re-bound by flag or persona.
      ...(saved?.identities === undefined ? {} : { identities: saved.identities }),
      ...(personas === undefined ? {} : { personas }),
    });
  } catch (e) {
    if (e instanceof FixtureSpecError) throw new VerifyFixInputError(`mission fixtures: ${e.message}`);
    throw e;
  }
}
