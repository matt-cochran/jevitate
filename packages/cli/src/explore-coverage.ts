/** The coverage/exploratory strategy runner behind `jevitate explore --strategy coverage|exploratory`. */
import type { ActionDeltaStats } from "@jevitate/explore";
import { writeFile } from "node:fs/promises";
import { logsDirFor } from "./project-dir.js";
import { join, resolve as resolvePath } from "node:path";
import type { JudgmentPort, GenerationPort, UsageTracker, UsageCounts } from "@jevitate/ai-core";
import { PlaywrightBrowserPort, resolveEmulation, type BrowserPort, type EmulationSpec } from "@jevitate/playwright";
import { closeOnce, demoOverlayOf, extensionsStamp, finalizeVideos, runVideoDir, sessionLaunchOptions, type BrowserRunOptions } from "./browser-run-options.js";
import { runCaptureFor, type ScreenshotsSpec } from "./run-screenshots.js";
import { evidenceOf, withRunEvidence } from "./defect-evidence.js";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { type InvariantSpec, type Recording } from "@jevitate/recording";
import type { DefectRecord, HostHealthSampler, InvariantDefect, InvariantReport, SideEffect } from "@jevitate/explore";
import type { EnvironmentDegraded, HostHealthSummary } from "@jevitate/domain";
import {
  runInductionMission,
  assertAuthorizedExploreTarget,
  type Bounds,
  type CoverageReport,
  type MissionRouteScope,
  startRouteGlobs,
  type TranscriptEntry,
  type BudgetTrajectory,
  type Http5xxDefect,
  Http5xxOracle,
  hangOutcome,
  type HangFinding,
  type TimingSummary,
} from "@jevitate/explore";
import {
  combineOutcomes,
  gatingDefects,
  type MissionFailure,
  type MissionOutcome, clock,
} from "@jevitate/domain";
import { currentEngineInfo, type EngineInfo } from "./engine.js";
import type { TargetConfig } from "./target-config.js";
import { MissionJournal, artifactStamp, closeQuietly, resultPathFor, writeMissionResult } from "./mission-journal.js";
import { MISSION_RESULT_SCHEMA_VERSION, unifiedDefects } from "./result-schema.js";
import { missionExitCode } from "./mission-exit.js";
import { launchArmed } from "./launch-armed.js";
import { branchFields, startFromJourney, type JourneyPrefix } from "./journey-prefix.js";
import type { JourneyBranchPoint } from "@jevitate/journey";
import { finishHostHealth } from "./host-health-run.js";
import {
  applyServerLogOutcome,
  openServerLogRuntime,
  type ServerLogDefect,
  type ServerLogsSummary,
} from "./log-correlation.js";
import { triageOf,
  type ServerLogOptions,
  serverLogResult,
  type OverflowFlags,
  recordingEmulation,
  freshSessionOpener,
  currentUrlSafe,
  assertSaveStorageStateOutsideProject,
  persistStorageState,
  type MissionTarget,
  declaredResult,
  serverLogRuntimeOptions,
} from "./explore-shared.js";

/**
 * The programmatic surface behind `jevitate explore --strategy coverage`
 * (additive, alongside `runExploration`). Wires a real Playwright `Page` +
 * gateways to `@jevitate/explore`'s proof-by-induction (state-coverage) mission
 * and persists each emitted repro `Recording` under `.jevitate/logs/<date>`.
 *
 * Same fail-closed discipline as `runExploration`: the authorized-target guard
 * runs FIRST, before any browser is opened.
 */
export interface RunCoverageMissionOptions {
  /** Test seam (#203): the run's host-health sampler (a deterministic fake host). Default: this host's. */
  readonly hostHealth?: HostHealthSampler;
  readonly url: string;
  readonly allowlist: readonly string[];
  readonly judge: JudgmentPort;
  readonly gen: GenerationPort;
  /** Usage accounting (#100): see `RunExplorationOptions.usage`. */
  readonly usage?: UsageTracker;
  readonly bounds?: Partial<Bounds>;
  /** Where the repro Recordings are written. Default `.jevitate/logs/<date>` (project, else `~/.jevitate`). */
  readonly outDir?: string;
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
  /**
   * Writes the browser context's storageState (cookies + origin storage) here when the run ends
   * (CLI `--save-storage-state`) — so a rotating refresh token stays usable across runs instead of
   * invalidating `--storage-state`'s file on first use. The file holds live session credentials:
   * written with mode 0600, and its contents are never logged. See
   * `RunExplorationOptions.saveStorageState`'s own doc for the full behaviour (#159: written on
   * every exit path including a crash/kill signal, never over a lost/logged-out session).
   */
  readonly saveStorageState?: string;
  readonly nowIso?: () => string;
  /** The target's settle/hang configuration (`~/.jevitate/targets.json` + flags). */
  readonly target?: TargetConfig;
  /**
   * Extra in-scope route globs (CLI `--route`, #89 — reuses #64's adversarial/feature scope model).
   * The seed URL's own route is always in scope; these add to it. Pass `["/**"]` (CLI `--scope app`)
   * to widen containment to the whole app.
   */
  readonly routeGlobs?: readonly string[];
  /** App-declared invariants (`--invariants`, #86), already validated against the allowlist. */
  readonly invariants?: InvariantSpec;
  /** Backend log sources (`--log-source`/`--log-defect`, #142), already validated. */
  readonly serverLog?: ServerLogOptions;
  /** Resolved `authFrom.secret` refs (#135) a declared probe may use: `env:VAR` → its value. */
  readonly invariantAuthTokens?: ReadonlyMap<string, string>;
  /**
   * `coverage` (default): the exhaustive breadth sweep. `exploratory`: novelty-seeking — the control
   * the last action revealed is tried first (#115).
   */
  readonly strategy?: "coverage" | "exploratory";
  /** No-progress watchdog (CLI `--stall-timeout`, #114): ends the run `stalled` (inconclusive). Default 120s. */
  readonly stallTimeoutMs?: number;
  /** Per-mission viewport/device emulation (#149); see `RunExplorationOptions.emulation`. */
  readonly emulation?: EmulationSpec;
  /** Horizontal-overflow hard signal (#149, CLI `--check-overflow` / `--ignore-overflow`). */
  readonly overflow?: OverflowFlags;
  /**
   * #293 `--from-journey`/`--at-step`: replayed into the session before the frontier, which then
   * starts on the live page it left (never a fresh navigation). `url` is only the expected landing.
   */
  readonly journeyPrefix?: JourneyPrefix;
  /** #303 `--action-deltas` (opt-in): record what each action changed (code verdict) — evidence only. */
  readonly actionDeltas?: boolean;
}

/**
 * How the frontier ended. `insufficient-coverage` (#209: the ONE name — it was `insufficient-exploration`
 * in #203): drained by timed-out actions, or emptied having exercised too little (e.g. only global
 * navigation) to call it `clean`. `exhausted` means fully explored AND enough to be clean.
 */
/** #209: a coverage frontier's own defect as listed in the unified `defects` (its Recording stays in `coverage.defects`). */
export type CoverageFrontierDefect = Omit<DefectRecord, "recording" | "reason"> & { readonly title: string };

type CoverageRunOutcome = "exhausted" | "insufficient-coverage" | "cap" | "crashed" | "hang" | "scope-unreachable" | "stalled" | "budget";

export interface RunCoverageMissionResult {
  /** The host's health over the run (#203): peaks, the slowest render, starved steps. */
  readonly hostHealth: HostHealthSummary;
  /** Findings met while the host was starved (#203) — advisory, never a defect/hang, never failing the run. */
  readonly environmentDegraded: EnvironmentDegraded[];

  /** The result schema's version (#195): the common fields are filled the same way by every strategy. */
  readonly schemaVersion: typeof MISSION_RESULT_SCHEMA_VERSION;
  /** Which frontier ran: `coverage` (breadth) or `exploratory` (novelty-first) — the file prefix names it (`coverage-`/`exploratory-`, #213). */
  readonly strategy: "coverage" | "exploratory";
  /** #213: the route scope the frontier was contained to, and where it came from (the #224 field). */
  readonly scope: MissionRouteScope;
  readonly coverage: CoverageReport;
  readonly outcome: CoverageRunOutcome;
  /** Hangs met while exploring (deduped), each with its reproduction and its own path Recording. */
  readonly hangs: HangFinding[];
  /** Declared mission spend budgets (#150/#180): the observed trajectory, whatever the outcome. */
  readonly budget?: BudgetTrajectory[];
  /** A coverage run has no single Recording: each finding carries the path that reached it. */
  readonly recording: null;
  /** Where the run happened — what `verify-fix` needs to replay a finding. */
  readonly target: MissionTarget;
  /**
   * The typed verdict: `crashed` for a broken run, else `defects-found` / `clean`. An advisory
   * (`judgment-flagged-state`, #214) defect alone never makes it `defects-found`.
   */
  readonly missionOutcome: MissionOutcome;
  readonly exitCode: number;
  readonly failure?: MissionFailure;
  /** Slowest pages/transitions and endpoints (p50/max), keyed by normalized route/endpoint. */
  readonly timing: TimingSummary;
  /** The persisted typed result (`<strategy>-<stamp>.result.json`: `coverage-` or `exploratory-`). */
  readonly resultPath: string;
  readonly recordingPaths: string[];
  /** #245: `--record-video` files, finalized before this result was written (absent when not recording). */
  readonly videoPaths?: string[];
  /** The shared decision transcript (`<strategy>-<stamp>.transcript.json`). */
  readonly transcriptPath: string;
  /** The writes the frontier's actions fired (#116), marked when the control was paid / destructive. */
  readonly sideEffects: SideEffect[];
  readonly sideEffectsTruncated?: number;
  /** #303 (`--action-deltas`): verdict counts and the actions that changed nothing. */
  readonly actionDeltas?: ActionDeltaStats & { readonly noEffect?: readonly string[] };
  /** Which build produced this result (issue #83): `{version, commit, builtAt}`. */
  readonly engine: EngineInfo;
  /**
   * EVERY defect the run found (#195; #209): the frontier's own (`horizontal-overflow`, and a
   * `judgment-flagged-state` — also in `coverage.defects`, which keeps each one's repro Recording;
   * #214: marked `advisory: true`, it never sets `missionOutcome`/`exitCode` on its own),
   * declared-invariant defects (#86, each with its own path Recording) and `server-log` defects (#142).
   */
  readonly defects: Array<CoverageFrontierDefect | InvariantDefect | Http5xxDefect | ServerLogDefect>;
  readonly invariants?: InvariantReport[];
  readonly invariantSpec?: InvariantSpec;
  /** Judgment/generation call counts and tokens for this run (#100); present only when `opts.usage` was supplied. */
  readonly usage?: UsageCounts;
  /** Backend log correlation summary (#142) — present only when `--log-source` was given. */
  readonly serverLogs?: ServerLogsSummary;
  /** #293: the Journey step a journey-anchored run branched from (absent on a bare-URL run). */
  readonly branch?: JourneyBranchPoint;
}

export async function runCoverageMission(opts: RunCoverageMissionOptions): Promise<RunCoverageMissionResult> {
  // Guardrail #1 — authorize BEFORE opening a browser. Throws on refusal.
  const origin = assertAuthorizedExploreTarget(opts.url, opts.allowlist);
  assertSaveStorageStateOutsideProject(opts.saveStorageState);
  // #224: the shared default scope (the start URL's route) must be derivable — refused up front.
  startRouteGlobs(opts.url);

  // #149: refused BEFORE any browser opens.
  const resolvedEmulation = resolveEmulation(opts.emulation);
  // #250/#251: a recorded or screenshotted run's sessions carry the live pixel mask from their first
  // paint; `--screenshots` captures after each step (the Recording path names their folder).
  const capture = runCaptureFor({
    recordsVideo: opts.browser?.recordVideo !== undefined,
    screenshots: opts.screenshots,
    secrets: [],
    artifactPath: () => journal.recordingPath,
    title: `${opts.strategy ?? "coverage"} run of ${opts.url}`,
  });
  const portFactory = capture.wrap(opts.browserPortFactory ?? (() => new PlaywrightBrowserPort()));
  const port = portFactory();
  const outDir = opts.outDir ?? logsDirFor();
  const iso = (opts.nowIso ?? (() => clock.nowIso()))();
  const stamp = artifactStamp(iso);
  // `MissionJournal` creates `outDir` synchronously (mkdirSync).
  // #213: an exploratory run's files are named for it (`exploratory-*`), not `coverage-*`; every
  // reader finds a result by its content (#211), never by this prefix.
  const filePrefix = opts.strategy ?? "coverage";
  const journal = new MissionJournal(join(outDir, `${filePrefix}-${stamp}.json`));
  // #245: the mission session and every hang-replay session are shown/recorded alike.
  const videoDir = runVideoDir(opts.browser, journal.recordingPath);
  const launch = {
    ...sessionLaunchOptions(opts.browser, videoDir),
    allowedOrigins: [...opts.allowlist],
    baseUrl: origin,
    ...opts.emulation,
    ...(opts.storageState !== undefined ? { storageState: opts.storageState } : {}),
  };
  // #163: this run's own share of a (possibly shared) tracker: its usage and sidecar.
  const runUsage = opts.usage?.scope();
  // #226: the kill switch is armed BEFORE the host sampler and the browser launch (see launch-armed.ts).
  const { disarmKillSwitch, health, session, snapshotter } = await launchArmed({
    hostHealth: opts.hostHealth,
    saveStorageState: opts.saveStorageState !== undefined,
    open: () => port.open(launch),
    mission: (hooks) => ({
      // #220: the killed run's partial result carries the unified schema's common fields too.
      strategy: opts.strategy ?? "coverage",
      target: { seedUrl: opts.url, allowlist: [...opts.allowlist], ...(opts.storageState !== undefined ? { storageStatePath: resolvePath(opts.storageState) } : {}) },
      recordingPath: journal.recordingPath,
      hostHealth: hooks.hostHealth,
      ...(videoDir === undefined ? {} : { videoDir }),
      transcriptPath: journal.transcriptPath,
      transcript: () => journal.transcript,
      ...(runUsage === undefined ? {} : { usage: runUsage }),
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
    // #293: a journey-anchored run first replays its Journey's prefix into this very session.
    const start = await startFromJourney(opts.journeyPrefix, session, opts.url, opts.allowlist, opts.browser);
    const actor = CastActor.named("coverage-mission").whoCan(new BrowseTheWeb(session, [...opts.allowlist]));
    const result = await runInductionMission({
      ...(opts.target?.timing === undefined ? {} : { timingConfig: opts.target.timing }),
      // A hang is reproduced in fresh contexts, and the frontier keeps being explored after it.
      openFreshSession: freshSessionOpener(portFactory, launch, opts.allowlist),
      ...(opts.target?.settle === undefined ? {} : { settle: opts.target.settle }),
      page: session.page,
      actor,
      judgment: opts.judge,
      generation: opts.gen,
      seedUrl: start.url,
      ...(start.branch === undefined ? {} : { startInPlace: true }),
      // #293: a return to a queued state re-replays the Journey prefix (counted against --max-actions).
      ...(start.restart ?? {}),
      allowlist: opts.allowlist,
      bounds: opts.bounds,
      ...(opts.actionDeltas === true ? { actionDeltas: true } : {}),
      onTranscriptEntry,
      ...(opts.routeGlobs === undefined ? {} : { routeGlobs: opts.routeGlobs }),
      ...(opts.invariants === undefined ? {} : { invariants: opts.invariants }),
      ...(opts.invariantAuthTokens === undefined ? {} : { invariantAuthTokens: opts.invariantAuthTokens }),
      ...(opts.strategy === undefined ? {} : { strategy: opts.strategy }),
      ...(opts.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: opts.stallTimeoutMs }),
      ...(opts.target?.safety === undefined ? {} : { safety: opts.target.safety }),
      overflow: {
        ...(opts.overflow?.checkOverflow === undefined ? {} : { checkOverflow: opts.overflow.checkOverflow }),
        ...(opts.overflow?.toleranceCss === undefined ? {} : { toleranceCss: opts.overflow.toleranceCss }),
        ...(opts.overflow?.ignoreSelectors === undefined ? {} : { ignoreSelectors: opts.overflow.ignoreSelectors }),
        ...(opts.emulation?.device === undefined ? {} : { device: opts.emulation.device }),
      },
      hostHealth: health,
      demoOverlay: demoOverlayOf(opts.browser),
    });

    // #149: every repro Recording (per-state, and each defect's own) is stamped with the emulation
    // it was found under, so `verify-fix` replays it under the SAME device by default.
    const emu = recordingEmulation(resolvedEmulation);
    const withEmu = (r: Recording): Recording => ({ ...(emu === undefined ? r : { ...r, emulation: emu }), ...extensionsStamp(opts.browser) }); // + #256
    const stampedDefects = result.coverage.defects.map((d) => ({ ...d, recording: withEmu(d.recording) }));
    const stampedCoverage = { ...result.coverage, defects: stampedDefects };
    const serverLogRun = serverLog === undefined ? undefined : await serverLog.finish(result.transcript);
    const recordingPaths: string[] = [];
    for (let i = 0; i < result.recordings.length; i++) {
      const p = join(outDir, `${filePrefix}-${stamp}-state-${i}.json`);
      await writeFile(p, `${JSON.stringify(withEmu(result.recordings[i]!), null, 2)}\n`, "utf8");
      recordingPaths.push(p);
    }
    journal.writeTranscript(serverLogRun?.transcript ?? result.transcript);
    // A silent run that never proved anything (the seed redirected off-target, or the frontier
    // spent its budget on controls that failed rather than exercising the target) is `inconclusive`,
    // never `clean` — mirrors the adversarial mission's coverage-sufficiency check (#69, #75, #82).
    // A declared-invariant violation (#86) is a hard defect, whatever the coverage.
    // #208: the shared HTTP 5xx hard signal's defects count like the strategy's own.
    const httpDefects = http5xx.defects(result.transcript);
    // #214: a `judgment-flagged-state` is advisory (Jev's opinion alone, guardrail #4): listed in
    // `defects`/`coverage.defects` with its repro, but it never counts toward `defects-found` — only a
    // defect an independent code oracle decided (overflow, invariant, 5xx, server-log) gates the run.
    const hardFrontier = gatingDefects(stampedDefects).length;
    const found = hardFrontier + (result.invariantDefects?.length ?? 0) + httpDefects.length;
    // Could not return to the seed, or stalled (#114): the run stopped short of its target — inconclusive.
    // #150 — a crossed mission spend budget is a deliberate, clean stop (not the run breaking): it
    // maps to `inconclusive`, but a defect found before it still wins, reported with `stop: "budget"`.
    const bare =
      result.outcome === "crashed"
        ? "crashed"
        : result.outcome === "scope-unreachable" || result.outcome === "stalled"
          ? "inconclusive"
          : // #203: a frontier drained by timed-out actions, or ended on a page hung only on a starved
            // host (no hang finding left), explored too little to be clean — a found defect still wins.
            result.outcome === "budget" || result.outcome === "insufficient-coverage" || (result.outcome === "hang" && result.hangs.length === 0)
            ? found > 0
              ? "defects-found"
              : "inconclusive"
            : null;
    const thin = bare === null && found === 0 && !result.coverage.sufficiency.sufficient;
    const preLogOutcome: MissionOutcome = combineOutcomes([
      bare ?? (thin ? "inconclusive" : found > 0 ? "defects-found" : "clean"),
      ...result.hangs.map((h) => hangOutcome(h.reproduction.status)),
    ]);
    // #142 follow-up: a server-log defect counts as `defects-found`; an unreadable `--log-defect`
    // oracle turns an otherwise-`clean` run `inconclusive` — never a false clean.
    const host = await finishHostHealth(health, applyServerLogOutcome(preLogOutcome, serverLogRun));
    const missionOutcome: MissionOutcome = host.outcome;
    const coverageFailure: MissionFailure | undefined = thin
      ? { kind: "insufficient-coverage", message: `coverage below thresholds: ${result.coverage.sufficiency.shortfalls.join("; ")}` }
      : undefined;
    const failure = result.failure ?? host.failure ?? coverageFailure;

    const exitCode = missionExitCode(missionOutcome);
    // #245: every context closed (videos finalized) before the result naming them is written.
    const shotFields = await capture.finish();
    const videos = await finalizeVideos(videoDir, closeSession);
    const typed = {
      schemaVersion: MISSION_RESULT_SCHEMA_VERSION,
      hangs: result.hangs,
      recording: null,
      target: {
        seedUrl: start.url,
        allowlist: [...opts.allowlist],
        ...(opts.storageState !== undefined ? { storageStatePath: resolvePath(opts.storageState) } : {}),
      },
      ...branchFields(start),
      timing: result.timing,
      strategy: opts.strategy ?? "coverage",
      // #213: the SCOPE line (#224's field) — the start route plus any --route/--scope app globs.
      scope: {
        routeGlobs: [...stampedCoverage.scope.routeGlobs],
        source: (opts.routeGlobs ?? []).some((g) => g.trim() !== "") ? ("route" as const) : ("start-url" as const),
      },
      coverage: stampedCoverage,
      // #209: a frontier that emptied having exercised too little to be clean is not `exhausted`
      // (that reads as "fully covered") — it is `insufficient-coverage`, the same word as its
      // `failure.kind`, so one ending has one name.
      outcome: thin && result.outcome === "exhausted" ? ("insufficient-coverage" as const) : result.outcome,
      missionOutcome,
      exitCode,
      ...(failure === undefined ? {} : { failure }),
      recordingPaths,
      ...videos,
      ...shotFields,
      transcriptPath: journal.transcriptPath,
      sideEffects: result.sideEffects ?? [],
      ...(result.sideEffectsTruncated === undefined ? {} : { sideEffectsTruncated: result.sideEffectsTruncated }),
      ...(result.actionDeltas === undefined ? {} : { actionDeltas: result.actionDeltas }),
      ...(result.budget === undefined ? {} : { budget: result.budget }),
      engine: currentEngineInfo(),
      ...declaredResult(opts.invariants, result.invariantDefects, result.invariants),
      ...(runUsage === undefined ? {} : { usage: runUsage.snapshot() }),
      ...serverLogResult(serverLogRun),
      // #209: EVERY defect in `defects` (#195) — the frontier's own (a horizontal overflow, a flagged
      // state; also in `coverage.defects`), then declared-invariant, then HTTP 5xx (#208), then server-log ones.
      defects: unifiedDefects<CoverageFrontierDefect | InvariantDefect | Http5xxDefect>(
        [
          // Slim: the repro Recording stays in `coverage.defects` (not copied twice into the result).
          ...stampedDefects.map(({ recording: _repro, reason, ...d }) => ({ ...d, title: reason })),
          ...(opts.invariants === undefined ? [] : (result.invariantDefects ?? [])),
          ...httpDefects,
        ],
        serverLogRun?.defects,
      ),
      resultPath: resultPathFor(journal.recordingPath),
      ...host.fields,
    };
    return await withRunEvidence({ ...typed, resultPath: writeMissionResult(journal.recordingPath, missionOutcome, exitCode, typed, runUsage) }, evidenceOf(opts, []), triageOf(opts, serverLogRun, []));
  } finally {
    disarmKillSwitch();
    health.stop();
    await serverLog?.abort();
    await closeSession();
  }
}
