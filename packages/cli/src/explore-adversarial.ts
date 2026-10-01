/** The adversarial strategy runner behind `jevitate explore --strategy adversarial`. */
import { logsDirFor } from "./project-dir.js";
import { join, resolve as resolvePath } from "node:path";
import type { JudgmentPort, GenerationPort, UsageTracker, UsageCounts } from "@jevitate/ai-core";
import { PlaywrightBrowserPort, resolveEmulation, type BrowserPort, type EmulationSpec } from "@jevitate/playwright";
import { closeOnce, demoOverlayOf, extensionsStamp, finalizeVideos, runVideoDir, sessionLaunchOptions, type BrowserRunOptions } from "./browser-run-options.js";
import { runCaptureFor, type ScreenshotsSpec } from "./run-screenshots.js";
import { evidenceOf, withRunEvidence } from "./defect-evidence.js";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { type InvariantSpec } from "@jevitate/recording";
import type { HostHealthSampler } from "@jevitate/explore";
import type { EnvironmentDegraded, HostHealthSummary } from "@jevitate/domain";
import {
  runAdversarialMission,
  assertAuthorizedExploreTarget,
  type Bounds,
  type AdversarialOutcome,
  type AdversarialDefect,
  type MisuseStrategy,
  startRouteGlobs,
  type TranscriptEntry,
  type CoverageThresholds,
  draftForCrash,
  draftForDefect,
  draftForHang,
} from "@jevitate/explore";
import {
  type FilingConfig,
  type IssueDraft,
  type IssueFilerPort,
  type MissionOutcome,
} from "@jevitate/domain";
import { processIssueDrafts, type FindingsIssues } from "./findings-filing.js";
import { currentEngineInfo, type EngineInfo } from "./engine.js";
import type { TargetConfig } from "./target-config.js";
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
  type OverflowFlags,
  recordingEmulation,
  DRAFTS_ONLY,
  NO_FILER,
  draftContext,
  freshSessionOpener,
  currentUrlSafe,
  assertSaveStorageStateOutsideProject,
  persistStorageState,
  browserVersionOf,
  type MissionTarget,
  serverLogRuntimeOptions,
} from "./explore-shared.js";

/**
 * The misuse strategies `explore --strategy adversarial` runs, in order — shared with the queue drain
 * (`jevitate mission run`, #117) so a queued adversarial mission hunts exactly like the CLI's.
 */
export const CLI_ADVERSARIAL_STRATEGIES: readonly MisuseStrategy[] = [
  // Form-aware misuse around submitting (#64): most app pages are forms.
  "double-submit",
  "boundary-submit",
  "edit-cancel-save",
  "navigate-away-unsaved",
  "act-while-pending",
  // Coverage: act on every target control once.
  "exercise-controls",
  "ordering-violation",
  "repeat-rapid",
  "boundary-input",
  "contradictory-actions",
  "nav-during-pending",
  // Keep hunting on other routes (within the target's scope) after and between defects.
  "visit-route",
];

/**
 * Options for the additive adversarial CLI mission. Mirrors `runExploration`'s
 * fail-closed discipline: the authorized-target guard runs FIRST, before any
 * browser is opened, so an unauthorized origin never launches Chromium.
 */
export interface RunAdversarialCliMissionOptions {
  /** Test seam (#203): the run's host-health sampler (a deterministic fake host). Default: this host's. */
  readonly hostHealth?: HostHealthSampler;
  readonly seedUrl: string;
  readonly allowlist: readonly string[];
  readonly strategies: readonly MisuseStrategy[];
  readonly judgment: JudgmentPort;
  readonly generation: GenerationPort;
  /** Usage accounting (#100): see `RunExplorationOptions.usage`. */
  readonly usage?: UsageTracker;
  /** Step/action budget (CLI `--max-decisions` / `--max-actions`). */
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
  /**
   * Writes the browser context's storageState (cookies + origin storage) here when the run ends
   * (CLI `--save-storage-state`) — so a rotating refresh token stays usable across runs instead of
   * invalidating `--storage-state`'s file on first use. The file holds live session credentials:
   * written with mode 0600, and its contents are never logged. See
   * `RunExplorationOptions.saveStorageState`'s own doc for the full behaviour (#159: written on
   * every exit path including a crash/kill signal, never over a lost/logged-out session).
   */
  readonly saveStorageState?: string;
  /** Registered secret values (`--secret`): kept out of the transcript, Recording and issue drafts. */
  readonly secrets?: readonly string[];
  /** #303 `--action-deltas` (opt-in): record what each action changed (code verdict) — evidence only. */
  readonly actionDeltas?: boolean;
  /** Issue filing (off unless enabled + a repo is configured). Default: drafts only. */
  readonly filing?: FilingConfig;
  /** Creates the filer — called only when filing is enabled. */
  readonly issueFiler?: () => IssueFilerPort;
  /** Fresh-context replays that confirm a hang (default 2). */
  readonly hangReplays?: number;
  /** Where the Recording and decision transcript are written. Default `.jevitate/logs/<date>` (project, else `~/.jevitate`). */
  readonly outDir?: string;
  /** ISO clock for the transcript filename. Default `Date.now()`. */
  readonly nowIso?: () => string;
  /** The target's settle/hang configuration (`~/.jevitate/targets.json` + flags). */
  readonly target?: TargetConfig;
  /** Extra in-scope route globs (`--route`); the start URL's route is always in scope. */
  readonly routeGlobs?: readonly string[];
  /** Coverage a silent run needs to be `clean` (`--min-control-coverage`, `--no-require-form-submit`). */
  readonly coverageThresholds?: Partial<CoverageThresholds>;
  /** App-declared invariants (`--invariants`, #86), already validated against the allowlist. */
  readonly invariants?: InvariantSpec;
  /** Backend log sources (`--log-source`/`--log-defect`, #142), already validated. */
  readonly serverLog?: ServerLogOptions;
  /** Resolved `authFrom.secret` refs (#135) a declared probe may use: `env:VAR` → its value. */
  readonly invariantAuthTokens?: ReadonlyMap<string, string>;
  /** Per-mission viewport/device emulation (#149); see `RunExplorationOptions.emulation`. */
  readonly emulation?: EmulationSpec;
  /** Horizontal-overflow hard signal (#149, CLI `--check-overflow` / `--ignore-overflow`). */
  readonly overflow?: OverflowFlags;
}

export type AdversarialCliMissionResult = Omit<AdversarialOutcome, "defects"> & {
  /** The result schema's version (#195): the common fields are filled the same way by every strategy. */
  readonly schemaVersion: typeof MISSION_RESULT_SCHEMA_VERSION;
  readonly strategy: "adversarial";
  /** The portable verdict (equal to `outcome`, which an adversarial run already states as a `MissionOutcome`). */
  readonly missionOutcome: MissionOutcome;
  /** EVERY defect the run found (#195): hard-signal and declared-invariant defects, then `server-log` defects (#142). */
  readonly defects: Array<AdversarialDefect | ServerLogDefect>;
  /** Every Recording the run wrote (#195: one list on every strategy) — an adversarial run writes one. */
  readonly recordingPaths: string[];
  /** #245: `--record-video` files, finalized before this result was written (absent when not recording). */
  readonly videoPaths?: string[];
  readonly target: MissionTarget;
  /** One ready-to-file draft per defect (and per crash), written next to the Recording. */
  readonly issues: FindingsIssues;
  /** @deprecated since 0.2.0 (#195) — use `recordingPaths[0]`; removed in the next minor. */
  readonly recordingPath: string;
  /** The persisted typed result (`<recording>.result.json`), readable via MCP `get_mission_result`. */
  readonly resultPath: string;
  readonly transcriptPath: string;
  /** Process exit code for `outcome` (see `missionExitCode`). */
  readonly exitCode: number;
  /** Which build produced this result (issue #83): `{version, commit, builtAt}`. */
  readonly engine: EngineInfo;
  /** The declared spec the run evaluated (#86) — persisted so `verify-fix` re-checks the same one. */
  readonly invariantSpec?: InvariantSpec;
  /** Judgment/generation call counts and tokens for this run (#100); present only when `opts.usage` was supplied. */
  readonly usage?: UsageCounts;
  /** Backend log correlation summary (#142) — present only when `--log-source` was given. */
  readonly serverLogs?: ServerLogsSummary;
  /** @deprecated since 0.2.0 (#195) — the `server-log` subset of `defects`; removed in the next minor. */
  readonly serverLogDefects?: ServerLogDefect[];
  /** The host's health over the run (#203): peaks, the slowest render, starved steps. */
  readonly hostHealth: HostHealthSummary;
  /** Findings met while the host was starved (#203) — advisory, never a defect/hang, never failing the run. */
  readonly environmentDegraded: EnvironmentDegraded[];
};

/**
 * Runs `@jevitate/explore`'s adversarial "try to break it" mission behind the
 * CLI. Guardrail #1 is enforced BEFORE opening a browser (fail-closed); the
 * session is always torn down. The stop-on-defect decision is the mission's
 * own trusted hard-signal oracle — never Jev's `Noul` (guardrail #4).
 */
export async function runAdversarialCliMission(
  opts: RunAdversarialCliMissionOptions,
): Promise<AdversarialCliMissionResult> {
  // Guardrail #1 — authorize BEFORE opening a browser. Throws on refusal.
  const origin = assertAuthorizedExploreTarget(opts.seedUrl, opts.allowlist);
  assertSaveStorageStateOutsideProject(opts.saveStorageState);
  // #224: the shared default scope (the start URL's route) must be derivable — refused up front.
  startRouteGlobs(opts.seedUrl);
  // #149: refused BEFORE any browser opens.
  const resolvedEmulation = resolveEmulation(opts.emulation);
  // #250/#251: a recorded or screenshotted run's sessions carry the live pixel mask from their first
  // paint; `--screenshots` captures after each step (the Recording path names their folder).
  const capture = runCaptureFor({
    recordsVideo: opts.browser?.recordVideo !== undefined,
    screenshots: opts.screenshots,
    secrets: opts.secrets ?? [],
    artifactPath: () => journal.recordingPath,
    title: `adversarial run of ${opts.seedUrl}`,
  });
  const portFactory = capture.wrap(opts.browserPortFactory ?? (() => new PlaywrightBrowserPort()));
  const port = portFactory();
  const outDir = opts.outDir ?? logsDirFor();
  const iso = (opts.nowIso ?? (() => new Date().toISOString()))();
  // Crash-safe: the transcript and partial Recording are flushed after every step.
  const journal = new MissionJournal(join(outDir, `adversarial-${artifactStamp(iso)}.json`));
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
      strategy: "adversarial",
      target: { seedUrl: opts.seedUrl, allowlist: [...opts.allowlist], ...(opts.storageState !== undefined ? { storageStatePath: resolvePath(opts.storageState) } : {}) },
      recordingPath: journal.recordingPath,
      hostHealth: hooks.hostHealth,
      ...(videoDir === undefined ? {} : { videoDir }),
      transcriptPath: journal.transcriptPath,
      transcript: () => journal.transcript,
      ...(runUsage === undefined ? {} : { usage: runUsage }),
      ...(opts.saveStorageState === undefined ? {} : { storageState: { path: opts.saveStorageState, snapshot: hooks.snapshot } }),
    }),
  });
  const serverLog = openServerLogRuntime({
    ...serverLogRuntimeOptions(opts.serverLog),
    secrets: opts.secrets ?? [],
    onTranscriptEntry: journal.onTranscriptEntry,
  });
  // #204: every request's correlation ids, from before the first navigation.
  serverLog?.observe(session.page);
  const onTranscriptEntry = (entry: TranscriptEntry, all: readonly TranscriptEntry[]): void => {
    capture.noteEntry(session.page, entry);
    health.noteStep(entry);
    (serverLog?.onTranscriptEntry ?? journal.onTranscriptEntry)(entry, all);
    snapshotter.noteSettledStep(currentUrlSafe(session));
  };
  // #159/#245: persisted and closed once — early (before the result is written) when recording video.
  const closeSession = closeOnce(async () => {
    await persistStorageState(session, opts.saveStorageState, snapshotter);
    await closeQuietly(session);
  });
  try {
    const actor = CastActor.named("adversarial-mission").whoCan(new BrowseTheWeb(session, [...opts.allowlist]));
    const outcome = await runAdversarialMission({
      hostHealth: health,
      demoOverlay: demoOverlayOf(opts.browser),
      ...(opts.target?.timing === undefined ? {} : { timingConfig: opts.target.timing }),
      ...(opts.target?.settle === undefined ? {} : { settle: opts.target.settle }),
      ...(opts.target?.hangs === undefined ? {} : { hangs: opts.target.hangs }),
      ...(opts.target?.safety === undefined ? {} : { safety: opts.target.safety }),
      page: session.page,
      actor,
      judgment: opts.judgment,
      generation: opts.generation,
      seedUrl: opts.seedUrl,
      allowlist: opts.allowlist,
      strategies: opts.strategies,
      ...(opts.routeGlobs === undefined ? {} : { routeGlobs: opts.routeGlobs }),
      ...(opts.coverageThresholds === undefined ? {} : { coverageThresholds: opts.coverageThresholds }),
      site: origin,
      ...(opts.bounds === undefined ? {} : { bounds: opts.bounds }),
      ...(opts.secrets === undefined ? {} : { secrets: opts.secrets }),
      ...(opts.actionDeltas === true ? { actionDeltas: true } : {}),
      // A hang is reproduced by replaying its steps in fresh contexts (same auth).
      openFreshSession: freshSessionOpener(portFactory, launch, opts.allowlist),
      ...(opts.hangReplays === undefined ? {} : { hangReplays: opts.hangReplays }),
      onTranscriptEntry,
      onRecording: journal.onRecording,
      ...(opts.invariants === undefined ? {} : { invariants: opts.invariants }),
      ...(opts.invariantAuthTokens === undefined ? {} : { invariantAuthTokens: opts.invariantAuthTokens }),
      overflow: {
        ...(opts.overflow?.checkOverflow === undefined ? {} : { checkOverflow: opts.overflow.checkOverflow }),
        ...(opts.overflow?.toleranceCss === undefined ? {} : { toleranceCss: opts.overflow.toleranceCss }),
        ...(opts.overflow?.ignoreSelectors === undefined ? {} : { ignoreSelectors: opts.overflow.ignoreSelectors }),
        ...(opts.emulation?.device === undefined ? {} : { device: opts.emulation.device }),
      },
    });
    const serverLogRun = serverLog === undefined ? undefined : await serverLog.finish(outcome.transcript);
    // `AdversarialOutcome.transcript` is a mutable `TranscriptEntry[]`; the correlated array only
    // ADDS an optional `serverLogs` field per entry (`TranscriptEntryWithLogs extends TranscriptEntry`).
    const transcript = (serverLogRun?.transcript ?? outcome.transcript) as TranscriptEntry[];
    journal.writeRecording(outcome.recording);
    journal.writeTranscript(transcript);
    // #142 follow-up: a server-log defect counts as `defects-found`; an unreadable `--log-defect`
    // oracle turns an otherwise-`clean` run `inconclusive` — never a false clean.
    const host = await finishHostHealth(health, applyServerLogOutcome(outcome.outcome, serverLogRun));
    const missionOutcome: MissionOutcome = host.outcome;
    const exitCode = missionExitCode(missionOutcome);
    const resultPath = resultPathFor(journal.recordingPath);
    const engine = currentEngineInfo();
    const ctx = draftContext(origin, journal, opts.secrets ?? [], browserVersionOf(session.page), engine);
    const drafts: IssueDraft[] = outcome.defects.map((d) =>
      draftForDefect(d, { ...ctx, verifyCommand: `jevitate verify-fix --result ${resultPath} --fingerprint ${d.fingerprint}` }),
    );
    for (const h of outcome.hangs) {
      drafts.push(draftForHang(h, { ...ctx, verifyCommand: `jevitate verify-fix --result ${resultPath} --fingerprint ${h.fingerprint}` }));
    }
    if (outcome.crash !== undefined) drafts.push(draftForCrash(outcome.crash, transcript, ctx));
    const issues = await processIssueDrafts(
      journal.recordingPath,
      drafts,
      opts.filing ?? DRAFTS_ONLY,
      opts.issueFiler ?? NO_FILER,
      iso,
    );
    // #245: every context closed (videos finalized) before the result naming them is written.
    const shotFields = await capture.finish();
    const videos = await finalizeVideos(videoDir, closeSession);
    const result = {
      ...outcome,
      schemaVersion: MISSION_RESULT_SCHEMA_VERSION,
      strategy: "adversarial" as const,
      missionOutcome,
      recordingPaths: [journal.recordingPath],
      ...videos,
      ...shotFields,
      // #149: stamped with the emulation the mission ran under, so verify-fix replays under it by default.
      recording: {
        ...(resolvedEmulation === undefined ? outcome.recording : { ...outcome.recording, emulation: recordingEmulation(resolvedEmulation) }),
        ...extensionsStamp(opts.browser), // #256
      },
      outcome: missionOutcome,
      transcript,
      recordingPath: journal.recordingPath,
      transcriptPath: journal.transcriptPath,
      exitCode,
      issues,
      // What `verify-fix` needs to replay a defect later: where, which origins, which session file
      // (the storageState PATH only — its cookies never enter an artifact).
      target: {
        seedUrl: opts.seedUrl,
        allowlist: [...opts.allowlist],
        ...(opts.storageState !== undefined ? { storageStatePath: resolvePath(opts.storageState) } : {}),
      },
      engine,
      ...(opts.invariants === undefined ? {} : { invariantSpec: opts.invariants }),
      ...(runUsage === undefined ? {} : { usage: runUsage.snapshot() }),
      ...serverLogResult(serverLogRun),
      defects: unifiedDefects(outcome.defects, serverLogRun?.defects),
      resultPath,
      ...(host.failure === undefined || outcome.failure !== undefined ? {} : { failure: host.failure }),
      ...host.fields,
    };
    return await withRunEvidence({ ...result, resultPath: writeMissionResult(journal.recordingPath, missionOutcome, exitCode, result, runUsage) }, evidenceOf(opts, opts.secrets ?? []));
  } finally {
    disarmKillSwitch();
    health.stop();
    await serverLog?.abort();
    await closeSession();
  }
}
