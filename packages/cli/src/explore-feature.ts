/** The feature strategy runner behind `jevitate explore --strategy feature`. */
import { writeFile } from "node:fs/promises";
import { logsDirFor } from "./project-dir.js";
import { join, resolve as resolvePath } from "node:path";
import type { UsageCounts } from "@jevitate/ai-core";
import { PlaywrightBrowserPort, resolveEmulation, type BrowserPort, type EmulationSpec } from "@jevitate/playwright";
import { closeOnce, demoOverlayOf, finalizeVideos, runVideoDir, sessionLaunchOptions, type BrowserRunOptions } from "./browser-run-options.js";
import { runCaptureFor, type ScreenshotsSpec } from "./run-screenshots.js";
import { evidenceOf, withRunEvidence } from "./defect-evidence.js";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { type InvariantSpec } from "@jevitate/recording";
import type { HostHealthSampler, InvariantDefect, SafetyConfig } from "@jevitate/explore";
import type { EnvironmentDegraded, HostHealthSummary } from "@jevitate/domain";
import {
  runFeatureMission,
  assertAuthorizedExploreTarget,
  type Bounds,
  type CapabilityScope,
  type FeatureRunResult,
  type MissionRouteScope,
  resolveRouteScope,
  refusalNote,
  safetyRefusalsFromTranscript,
  type TranscriptEntry,
  type Http5xxDefect,
  Http5xxOracle,
  hangOutcome,
} from "@jevitate/explore";
import { combineOutcomes, type MissionFailure, type MissionOutcome } from "@jevitate/domain";
import { currentEngineInfo, type EngineInfo } from "./engine.js";
import { MissionJournal, artifactStamp, closeQuietly, resultPathFor, writeMissionResult } from "./mission-journal.js";
import { MISSION_RESULT_SCHEMA_VERSION, unifiedDefects } from "./result-schema.js";
import { missionExitCode } from "./mission-exit.js";
import { launchArmed } from "./launch-armed.js";
import { finishHostHealth } from "./host-health-run.js";
import {
  applyServerLogOutcome,
  openServerLogRuntime,
  type ServerLogDefect,
  type ServerLogsSummary,
} from "./log-correlation.js";
import {
  type ServerLogOptions,
  serverLogResult,
  freshSessionOpener,
  currentUrlSafe,
  assertSaveStorageStateOutsideProject,
  persistStorageState,
  type MissionTarget,
  declaredResult,
  serverLogRuntimeOptions,
} from "./explore-shared.js";

/**
 * The programmatic surface behind `jevitate explore --feature <name>` — the
 * capability-scoped feature-testing mission (ticket #2, paired site ticket
 * #11). Model-free by design, so unlike `runExploration` it needs no gateways.
 *
 * The authorized-target guard runs FIRST (fail-closed), BEFORE any browser is
 * opened — an unauthorized origin never launches Chromium.
 */
export interface RunFeatureCliMissionOptions {
  /** Test seam (#203): the run's host-health sampler (a deterministic fake host). Default: this host's. */
  readonly hostHealth?: HostHealthSampler;
  readonly seedUrl: string;
  readonly allowlist: readonly string[];
  readonly capability: string;
  /**
   * The `--route` globs, used exactly as given. Empty/absent (#224): the start URL's route and
   * everything under it — the default every strategy shares (`resolveRouteScope`), stated in the
   * result's `scope`. A start URL no default can be derived from is refused up front
   * (`ScopeUnderivableError`, a usage error) before any browser opens.
   */
  readonly routeGlobs?: readonly string[];
  /** No-progress watchdog (CLI `--stall-timeout`, #114): ends the run `stalled` (inconclusive). Default 120s. */
  readonly stallTimeoutMs?: number;
  /** Step/action budget (CLI `--max-actions` / `--max-decisions`). */
  readonly bounds?: Partial<Bounds>;
  /** Testing seam — defaults to a real `PlaywrightBrowserPort`. */
  readonly browserPortFactory?: () => BrowserPort;
  /** How Chromium is launched (executable/channel/extra args) and shown (#245 demo mode). Default: pinned Chromium, headless. */
  readonly browser?: BrowserRunOptions;
  /** #251 `--screenshots`: masked screenshots (one per distinct screen, or per step) + `index.md`. */
  readonly screenshots?: ScreenshotsSpec;
  /**
   * #250 `--evidence-video`: after the result is written, each defect's minimal repro is replayed
   * with captions (the failing step marked) into a masked clip + before/at screenshots, attached as
   * `defects[].evidence` (and to its issue draft).
   */
  readonly evidenceVideo?: boolean;
  /**
   * Playwright storageState JSON to seed the session from (CLI `--storage-state`) —
   * the deterministic authenticated pre-step. Contains live session cookies: it is
   * handed only to the browser, never to a model or a Recording.
   */
  readonly storageState?: string;
  /** Where the recordings, transcript and typed result are written. Default `.jevitate/logs/<date>` (project, else `~/.jevitate`). */
  readonly outDir?: string;
  /** ISO clock for output filenames. Default `Date.now()`. */
  readonly nowIso?: () => string;
  /**
   * Writes the browser context's storageState (cookies + origin storage) here when the run ends
   * (CLI `--save-storage-state`) — so a rotating refresh token stays usable across runs instead of
   * invalidating `--storage-state`'s file on first use. The file holds live session credentials:
   * written with mode 0600, and its contents are never logged. See
   * `RunExplorationOptions.saveStorageState`'s own doc for the full behaviour (#159: written on
   * every exit path including a crash/kill signal, never over a lost/logged-out session).
   */
  readonly saveStorageState?: string;
  /** App-declared invariants (`--invariants`, #86), already validated against the allowlist. */
  readonly invariants?: InvariantSpec;
  /** Backend log sources (`--log-source`/`--log-defect`, #142), already validated. */
  readonly serverLog?: ServerLogOptions;
  /** Resolved `authFrom.secret` refs (#135) a declared probe may use: `env:VAR` → its value. */
  readonly invariantAuthTokens?: ReadonlyMap<string, string>;
  /** The shared safety policy (#116: `--deny`, `--allow-destructive`, `--read-rpc`). */
  readonly safety?: SafetyConfig;
  /** Per-mission viewport/device emulation (#149); see `RunExplorationOptions.emulation`. */
  readonly emulation?: EmulationSpec;
}

/** The feature mission's result plus its typed verdict, exit code, and where its artifacts landed. */
export type FeatureCliMissionResult = Omit<FeatureRunResult, "outcome"> & {
  /** The frontier's ending — `insufficient-coverage` (#209) when it emptied having proved nothing about the feature. */
  readonly outcome: FeatureRunResult["outcome"] | "insufficient-coverage";
  /** The result schema's version (#195): the common fields are filled the same way by every strategy. */
  readonly schemaVersion: typeof MISSION_RESULT_SCHEMA_VERSION;
  readonly strategy: "feature";
  /** The route scope the run used (#224): the `--route` globs, or the one derived from the start URL. */
  readonly scope: MissionRouteScope;
  /**
   * `clean` only when the run actually exercised an in-scope, non-chrome
   * control of the named capability (`coverage.inScopeActionsExercised > 0`).
   * A run that touched nothing but global chrome and/or left `--route` scope
   * on every attempt is `inconclusive` — never a fabricated `clean` (ticket
   * #78's guardrail: a run that proved nothing is never `clean`).
   */
  readonly missionOutcome: MissionOutcome;
  readonly exitCode: number;
  /** Which build produced this result (issue #83): `{version, commit, builtAt}`. */
  readonly engine: EngineInfo;
  /** One Recording per distinct discovered path (`feature-<stamp>-path-<n>.json`). */
  readonly recordingPaths: string[];
  /** #245: `--record-video` files, finalized before this result was written (absent when not recording). */
  readonly videoPaths?: string[];
  /** The shared decision transcript (`feature-<stamp>.transcript.json`). */
  readonly transcriptPath: string;
  /** The persisted typed result (`feature-<stamp>.result.json`), readable via MCP `get_mission_result`. */
  readonly resultPath: string;
  /** Where the run happened — what `verify-fix` needs to replay a declared-invariant defect. */
  readonly target: MissionTarget;
  /** EVERY defect the run found (#195): declared-invariant defects (#86, each with its own path Recording) and `server-log` defects (#142). */
  readonly defects: Array<InvariantDefect | Http5xxDefect | ServerLogDefect>;
  readonly invariantSpec?: InvariantSpec;
  /** Backend log correlation summary (#142) — present only when `--log-source` was given. */
  readonly serverLogs?: ServerLogsSummary;
  /** Always zero (#188): a feature mission makes no model call — stated, never absent ("not tracked"). */
  readonly usage: UsageCounts;
  /** The host's health over the run (#203): peaks, the slowest render, starved steps. */
  readonly hostHealth: HostHealthSummary;
  /** Findings met while the host was starved (#203) — advisory, never a defect/hang, never failing the run. */
  readonly environmentDegraded: EnvironmentDegraded[];
};

/** A model-free mission's usage (#188): nothing called, nothing to price — a known $0. */
export const NO_MODEL_USAGE: UsageCounts = {
  judgments: 0,
  generations: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalUsd: 0,
  priced: "full",
  priceSource: ["no model call"],
};

export async function runFeatureCliMission(opts: RunFeatureCliMissionOptions): Promise<FeatureCliMissionResult> {
  // Guardrail #1 — authorize BEFORE opening a browser. Throws on refusal.
  const origin = assertAuthorizedExploreTarget(opts.seedUrl, opts.allowlist);
  assertSaveStorageStateOutsideProject(opts.saveStorageState);
  // #224: no --route → the start URL's route (the shared default); refused up front when underivable.
  const routeScope = resolveRouteScope(opts.seedUrl, opts.routeGlobs);
  const scope: CapabilityScope = { name: opts.capability, originAllowlist: opts.allowlist, routeGlobs: routeScope.routeGlobs };

  // #149: refused BEFORE any browser opens.
  resolveEmulation(opts.emulation);
  // #250/#251: a recorded or screenshotted run's sessions carry the live pixel mask from their first
  // paint; `--screenshots` captures after each step (the Recording path names their folder).
  const capture = runCaptureFor({
    recordsVideo: opts.browser?.recordVideo !== undefined,
    screenshots: opts.screenshots,
    secrets: [],
    artifactPath: () => journal.recordingPath,
    title: `feature: ${opts.capability}`,
  });
  const portFactory = capture.wrap(opts.browserPortFactory ?? (() => new PlaywrightBrowserPort()));
  // Persist recordings + transcript + a typed result, like the goal and
  // coverage missions do (ticket #78 — previously nothing was written).
  const outDir = opts.outDir ?? logsDirFor();
  const iso = (opts.nowIso ?? (() => new Date().toISOString()))();
  const stamp = artifactStamp(iso);
  const journal = new MissionJournal(join(outDir, `feature-${stamp}.json`));
  // #245: the mission session and every hang-replay session are shown/recorded alike.
  const videoDir = runVideoDir(opts.browser, journal.recordingPath);
  const launch = {
    ...sessionLaunchOptions(opts.browser, videoDir),
    allowedOrigins: [...opts.allowlist],
    baseUrl: origin,
    ...opts.emulation,
    ...(opts.storageState !== undefined ? { storageState: opts.storageState } : {}),
  };
  // #226: the kill switch is armed BEFORE the host sampler and the browser launch (see launch-armed.ts).
  const { disarmKillSwitch, health, session, snapshotter } = await launchArmed({
    hostHealth: opts.hostHealth,
    saveStorageState: opts.saveStorageState !== undefined,
    open: () => portFactory().open(launch),
    mission: (hooks) => ({
      // #220: the killed run's partial result carries the unified schema's common fields too.
      strategy: "feature",
      target: { seedUrl: opts.seedUrl, allowlist: [...opts.allowlist], ...(opts.storageState !== undefined ? { storageStatePath: resolvePath(opts.storageState) } : {}) },
      recordingPath: journal.recordingPath,
      hostHealth: hooks.hostHealth,
      ...(videoDir === undefined ? {} : { videoDir }),
      transcriptPath: journal.transcriptPath,
      transcript: () => journal.transcript,
      ...(opts.saveStorageState === undefined ? {} : { storageState: { path: opts.saveStorageState, snapshot: hooks.snapshot } }),
    }),
  });
  // #208: the shared HTTP 5xx hard signal, listening from before the first navigation.
  const http5xx = new Http5xxOracle(session.page, { allowlist: opts.allowlist });
  const serverLog = openServerLogRuntime({
    ...serverLogRuntimeOptions(opts.serverLog),
    secrets: [],
    onTranscriptEntry: journal.onTranscriptEntry,
  });
  // #204: every request's correlation ids, from before the first navigation.
  serverLog?.observe(session.page);
  const onTranscriptEntry = (entry: TranscriptEntry, all: readonly TranscriptEntry[]): void => {
    capture.noteEntry(session.page, entry);
    health.noteStep(entry);
    http5xx.noteStep(entry);
    (serverLog?.onTranscriptEntry ?? journal.onTranscriptEntry)(entry, all);
    snapshotter.noteSettledStep(currentUrlSafe(session));
  };
  // #159/#245: persisted and closed once — early (before the result is written) when recording video.
  const closeSession = closeOnce(async () => {
    await persistStorageState(session, opts.saveStorageState, snapshotter);
    await closeQuietly(session);
  });
  try {
    const actor = CastActor.named("feature-mission").whoCan(new BrowseTheWeb(session, [...opts.allowlist]));
    const result = await runFeatureMission({
      openFreshSession: freshSessionOpener(portFactory, launch, opts.allowlist),
      page: session.page,
      actor,
      seedUrl: opts.seedUrl,
      allowlist: opts.allowlist,
      scope,
      bounds: opts.bounds,
      onTranscriptEntry,
      ...(opts.invariants === undefined ? {} : { invariants: opts.invariants }),
      ...(opts.invariantAuthTokens === undefined ? {} : { invariantAuthTokens: opts.invariantAuthTokens }),
      ...(opts.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: opts.stallTimeoutMs }),
      ...(opts.safety === undefined ? {} : { safety: opts.safety }),
      hostHealth: health,
      demoOverlay: demoOverlayOf(opts.browser),
    });

    const serverLogRun = serverLog === undefined ? undefined : await serverLog.finish(result.transcript);
    const recordingPaths: string[] = [];
    for (let i = 0; i < result.recordings.length; i++) {
      const p = join(outDir, `feature-${stamp}-path-${i}.json`);
      await writeFile(p, `${JSON.stringify(result.recordings[i], null, 2)}\n`, "utf8");
      recordingPaths.push(p);
    }
    journal.writeTranscript(serverLogRun?.transcript ?? result.transcript);

    // Honest outcome (ticket #78): a run that exercised nothing in-scope and
    // non-chrome proved nothing about the named capability — `inconclusive`,
    // never `clean`, whatever the loop's own stop reason was. Mirrors the
    // adversarial mission's `insufficient-coverage` idiom.
    const chromeOnly = result.outcome !== "crashed" && result.coverage.inScopeActionsExercised === 0;
    // #209: in-scope, non-chrome controls were exercised — but none of them had anything to do with
    // the named capability (every one at relevance=0 against its words). That proves no more about
    // it than the chrome-only case: `inconclusive`, never `clean`.
    const words = result.coverage.featureWords;
    const irrelevant = !chromeOnly && result.outcome !== "crashed" && words.length > 0 && result.coverage.relevantActionsExercised === 0;
    const thin = chromeOnly || irrelevant;
    const coverageFailure: MissionFailure | undefined = chromeOnly
      ? {
          kind: "insufficient-coverage",
          message: `no in-scope, non-chrome control of "${opts.capability}" was exercised within route(s) [${routeScope.routeGlobs.join(", ")}]${
            routeScope.source === "start-url" ? " (derived from the start URL)" : ""
          } — ${result.coverage.boundaryEdges.length} boundary edge(s) hit instead${refusalNote(safetyRefusalsFromTranscript(result.transcript))}`,
        }
      : irrelevant
        ? {
            kind: "insufficient-coverage",
            message: `no control relevant to "${opts.capability}" was exercised: all ${result.coverage.inScopeActionsExercised} in-scope action(s) were on controls at relevance=0 (none named with ${words.map((w) => `"${w}"`).join(", ")}) — name the feature with the words its controls use, or point --url/--route at the page that has them`,
          }
        : undefined;
    // A declared-invariant violation (#86) is a hard defect even on a thin run: it was observed.
    // #208: the shared HTTP 5xx hard signal's defects count like declared-invariant ones.
    const httpDefects = http5xx.defects(result.transcript);
    const hardDefects = (result.invariantDefects?.length ?? 0) + httpDefects.length;
    // #150 — a crossed mission spend budget is a deliberate, clean stop (not the run breaking): it
    // maps to `inconclusive`, but a defect found before it still wins, reported with `stop: "budget"`.
    const preLogOutcome: MissionOutcome = combineOutcomes([
      result.outcome === "crashed"
        ? "crashed"
        : result.outcome === "scope-unreachable" || result.outcome === "stalled"
          ? "inconclusive"
          : result.outcome === "budget"
            ? hardDefects > 0
              ? "defects-found"
              : "inconclusive"
            : hardDefects > 0
              ? "defects-found"
              : thin
                ? "inconclusive"
                : "clean",
      ...result.hangs.map((h) => hangOutcome(h.reproduction.status)),
    ]);
    // #142 follow-up: a server-log defect counts as `defects-found`; an unreadable `--log-defect`
    // oracle turns an otherwise-`clean` run `inconclusive` — never a false clean.
    const host = await finishHostHealth(health, applyServerLogOutcome(preLogOutcome, serverLogRun));
    const missionOutcome: MissionOutcome = host.outcome;
    const exitCode = missionExitCode(missionOutcome);
    // #245: every context closed (videos finalized) before the result naming them is written.
    const shotFields = await capture.finish();
    const videos = await finalizeVideos(videoDir, closeSession);
    const typed = {
      ...result,
      // #209: one name — a frontier that emptied having proved nothing about the feature is not
      // `exhausted` ("fully covered"): it is `insufficient-coverage`, the same word as its failure.kind.
      outcome: thin && result.outcome === "exhausted" ? ("insufficient-coverage" as const) : result.outcome,
      schemaVersion: MISSION_RESULT_SCHEMA_VERSION,
      strategy: "feature" as const,
      scope: routeScope,
      transcript: (serverLogRun?.transcript ?? result.transcript) as TranscriptEntry[],
      failure: result.failure ?? host.failure ?? coverageFailure,
      missionOutcome,
      exitCode,
      recordingPaths,
      ...videos,
      ...shotFields,
      transcriptPath: journal.transcriptPath,
      engine: currentEngineInfo(),
      target: {
        seedUrl: opts.seedUrl,
        allowlist: [...opts.allowlist],
        ...(opts.storageState !== undefined ? { storageStatePath: resolvePath(opts.storageState) } : {}),
      },
      ...declaredResult(opts.invariants, result.invariantDefects, result.invariants),
      ...serverLogResult(serverLogRun),
      defects: unifiedDefects<InvariantDefect | Http5xxDefect>(
        [...(opts.invariants === undefined ? [] : (result.invariantDefects ?? [])), ...httpDefects],
        serverLogRun?.defects,
      ),
      resultPath: resultPathFor(journal.recordingPath),
      usage: NO_MODEL_USAGE,
      ...host.fields,
    };
    return await withRunEvidence({ ...typed, resultPath: writeMissionResult(journal.recordingPath, missionOutcome, exitCode, typed) }, evidenceOf(opts, []));
  } finally {
    disarmKillSwitch();
    health.stop();
    await serverLog?.abort();
    await closeSession();
  }
}
