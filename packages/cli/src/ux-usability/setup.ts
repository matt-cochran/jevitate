// ux-usability/setup.ts — phase 1 of `runUsabilityMission` (#500): input refusals, launch, listener chain.
import { resolveProjectMissionFixture } from "../journey-api.js";
import { logsDirFor } from "../project-dir.js";
import { join, resolve as resolvePath } from "node:path";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { closeOnce, runVideoDir, sessionLaunchOptions } from "../browser-run-options.js";
import { runCaptureFor } from "../run-screenshots.js";
import { assertAuthorizedExploreTarget, type SecretCommandRunner, type TranscriptEntry, secretFieldSecrets } from "@jevitate/explore";
import { resolveMinConfidence, resolveMaxFindingsPerRoute, resolveQualityPolicy, type ScreenRef, type UxEvidence, type UxFinding } from "@jevitate/ux";
import { loadProductFacts } from "../ux-product.js";
import { loadUxMaxFindingsPerPage, loadUxMinConfidence, loadUxMinConfidenceByAppClass, loadUxShow } from "../ux-config.js";
import { clock } from "@jevitate/domain";
import { MissionJournal, artifactStamp, closeQuietly } from "../mission-journal.js";
import { launchArmed } from "../launch-armed.js";
import { Http5xxOracle } from "@jevitate/explore";
import { openServerLogRuntime } from "../log-correlation.js";
import { serverLogRuntimeOptions } from "../explore-shared.js";
import { assertSaveStorageStateOutsideProject, currentUrlSafe, persistStorageState } from "../explore-api.js";
import { transcriptPathFor } from "../transcript-file.js";
import { UsabilityCapture } from "../usability-capture.js";
import type { RunUsabilityMissionOptions } from "../ux-usability.js";

/** Usability reads only a spec's `budget` (#150) — never its `invariants`/`capture` (#86/#147, not supported here). */
export class UsabilityInvariantsUnsupportedError extends Error {
  readonly code = "E_USABILITY_INVARIANTS" as const;
  constructor() {
    super(
      "usability does not check app-declared invariants or captures — only a `budget` is read; " +
        "give a spec with an empty invariants array (and no capture) to use --invariants with usability",
    );
    this.name = "UsabilityInvariantsUnsupportedError";
  }
}

/**
 * Phase 1 — set-up: every bad-input refusal BEFORE a browser opens, the run's artifact paths, the
 * armed launch (kill switch, host sampler, browser), the capture/journal/server-log listener chain
 * and the once-only session close. Returns the run's shared state, mutated in place by later phases.
 */
export async function setUpUsabilityMission(opts: RunUsabilityMissionOptions) {
  const origin = assertAuthorizedExploreTarget(opts.url, opts.allowlist);
  assertSaveStorageStateOutsideProject(opts.saveStorageState);
  // #150 — usability reads only a spec's `budget`: it does not check invariants or captures (#86/
  // #147) today. Refused BEFORE a browser opens, same as every other bad-input refusal here.
  if (opts.invariants !== undefined && (opts.invariants.invariants.length > 0 || opts.invariants.capture !== undefined)) {
    throw new UsabilityInvariantsUnsupportedError();
  }
  // Validate the cutoff before a browser opens — a bad value fails fast, never mid-run.
  const minConfidence = resolveMinConfidence(
    opts.minConfidence,
    opts.env ?? process.env,
    loadUxMinConfidence(opts.configPath),
    loadUxMinConfidenceByAppClass(opts.configPath, opts.appContext.appClass),
  );
  const quality = resolveQualityPolicy(opts.show, opts.env ?? process.env, loadUxShow(opts.configPath), opts.appContext.appClass);
  const maxFindingsPerRoute = resolveMaxFindingsPerRoute(opts.maxFindingsPerRoute, opts.env ?? process.env, loadUxMaxFindingsPerPage(opts.configPath));
  const fixture = opts.fixture === undefined ? undefined : await resolveProjectMissionFixture(opts.fixture);
  // #198: the product facts are validated before a browser opens (a bad file is a usage error).
  const product = await loadProductFacts(opts.product);
  // #250/#251: a recorded or screenshotted run's sessions carry the live pixel mask from their first
  // paint; `--screenshots` captures after each step (the Recording path names their folder).
  const runCapture = runCaptureFor({
    recordsVideo: opts.browser?.recordVideo !== undefined,
    screenshots: opts.screenshots,
    secrets: [...(opts.secrets ?? []), ...secretFieldSecrets(opts.secretFields)],
    artifactPath: () => journal.recordingPath,
    title: `usability: ${opts.job}`,
  });
  const portFactory = runCapture.wrap(opts.browserPortFactory ?? (() => new PlaywrightBrowserPort()));
  const port = portFactory();
  const collected: UxEvidence[] = [];
  const history: ScreenRef[] = [];
  // #149: one signal finding per distinct fingerprint (route + element) — a wide table seen across
  // many observed screens is still ONE finding, never a finding per occurrence.
  const overflowFindings: UxFinding[] = [];
  const seenOverflow = new Set<string>();
  const extract =
    opts.extractText ??
    (async (s: { page: { evaluate: (fn: () => string) => Promise<string> } }) =>
      s.page.evaluate(() => (typeof document !== "undefined" && document.body ? document.body.innerText : "")));
  const outDir = opts.outDir ?? logsDirFor();
  const iso = (opts.nowIso ?? (() => clock.nowIso()))();
  const stamp = artifactStamp(iso);
  const reportPath = join(outDir, `usability-${stamp}.json`);
  // #98 — the same artifact shape as goal/adversarial missions, next to the report: the decision
  // transcript (each step's redacted typed value and screenshot), the Recording and the per-step
  // screenshots. Crash-safe: the transcript and partial Recording are flushed after every step.
  const journal = new MissionJournal(join(outDir, `usability-${stamp}.recording.json`), transcriptPathFor(reportPath));
  const screenshotDir = join(outDir, `usability-${stamp}.screens`);
  // #245: shown/recorded like every other strategy's session (videos in `usability-<stamp>.videos/`).
  const videoDir = runVideoDir(opts.browser, reportPath);
  const launch = {
    ...sessionLaunchOptions(opts.browser, videoDir),
    allowedOrigins: [...opts.allowlist],
    ...(opts.blockOffAllowlistNavigation === true ? { blockOffAllowlistNavigation: true } : {}),
    baseUrl: origin,
    ...opts.emulation,
    ...(opts.storageState !== undefined ? { storageState: opts.storageState } : {}),
  };
  // A bound secret (or TOTP seed) is a run secret too: masked on screen, redacted everywhere.
  const secrets = [...(opts.secrets ?? []), ...secretFieldSecrets(opts.secretFields)];
  // #163: this run's own share of a (possibly shared) tracker: its usage and sidecar.
  const runUsage = opts.usage?.scope();
  // The screenshot capture needs the open page; until then a killed run has taken none.
  let armedCapture: UsabilityCapture | undefined;
  // Crash-safe on SIGTERM/SIGINT too (#94): a partial `inconclusive` result is written from
  // whatever the journal has already flushed, and the process exits with the conventional code.
  // #120: the transcript lives next to the REPORT (`usability-<stamp>.transcript.json`), not the
  // Recording — so the killed run's result names the real file, and reports the live step list,
  // the tokens spent so far and the screens already observed.
  // #226: the kill switch is armed BEFORE the host sampler and the browser launch (see launch-armed.ts).
  const { disarmKillSwitch, health, session, snapshotter } = await launchArmed({
    hostHealth: opts.hostHealth,
    saveStorageState: opts.saveStorageState !== undefined,
    open: () => port.open(launch),
    mission: (hooks) => ({
      // #220: the killed run's partial result carries the unified schema's common fields too.
      strategy: "usability",
      target: { seedUrl: opts.url, allowlist: [...opts.allowlist], ...(opts.storageState !== undefined ? { storageStatePath: resolvePath(opts.storageState) } : {}) },
      recordingPath: journal.recordingPath,
      hostHealth: hooks.hostHealth,
      ...(videoDir === undefined ? {} : { videoDir }),
      transcriptPath: journal.transcriptPath,
      transcript: () => journal.transcript,
      ...(runUsage === undefined ? {} : { usage: runUsage }),
      partialReport: () => ({ screensObserved: collected.length, screenshotDir, screenshots: armedCapture === undefined ? [] : armedCapture.screenshots() }),
      ...(opts.saveStorageState === undefined ? {} : { storageState: { path: opts.saveStorageState, snapshot: hooks.snapshot } }),
    }),
  });
  // #324: the engine runs a cmd: binding's command at type time. A value read mid-run joins this
  // run's secrets at once (screenshots' scan, result, evidence, report) and — #360 — the run's pixel
  // mask, before the value is typed. (It was once handed to UsabilityCapture, which has no such
  // option, so a usability run could not type a cmd: field at all.)
  const uxSecretCommand: SecretCommandRunner | undefined =
    opts.secretCommand === undefined
      ? undefined
      : async (command: string) => {
          const out = await opts.secretCommand!(command);
          const value = out.trim();
          if (value !== "" && !secrets.includes(value)) secrets.push(value);
          if (value !== "") await runCapture.mask.addSecret(value);
          return out;
        };
  // #208: the shared HTTP 5xx hard signal, listening from before the first navigation.
  const http5xx = new Http5xxOracle(session.page, { allowlist: opts.allowlist });
  const capture = new UsabilityCapture({
    page: session.page,
    screenshotDir,
    secrets,
    ...(opts.secretFields === undefined ? {} : { secretFields: opts.secretFields }),
  });
  armedCapture = capture;
  // The usability capture (screenshots) and the journal (crash-safe flush) are the EXISTING listener
  // chain; a server-log runtime (#142) is inserted in FRONT of it (never replacing it) so every step
  // still gets its screenshot/flush exactly as before, whether or not --log-source was given. #159:
  // every settled step also refreshes the in-memory storageState snapshot (a cheap no-op when
  // `--save-storage-state` was not given).
  const journalListener = (entry: TranscriptEntry, all: readonly TranscriptEntry[]): void => {
    runCapture.noteEntry(session.page, entry);
    health.noteStep(entry);
    http5xx.noteStep(entry);
    capture.noteEntry(entry, all);
    journal.onTranscriptEntry(entry, capture.withScreenshots(all));
    snapshotter.noteSettledStep(currentUrlSafe(session));
  };
  const serverLog = openServerLogRuntime({
    ...serverLogRuntimeOptions(opts.serverLog),
    secrets,
    onTranscriptEntry: journalListener,
  });
  // #204: every request's correlation ids, from before the first navigation.
  serverLog?.observe(session.page);
  // #159/#245: persisted and closed once — early (before the result is written) when recording video.
  const closeSession = closeOnce(async () => {
    await persistStorageState(session, opts.saveStorageState, snapshotter);
    await closeQuietly(session);
  });
  return {
    opts,
    origin,
    minConfidence,
    quality,
    maxFindingsPerRoute,
    fixture,
    product,
    runCapture,
    portFactory,
    port,
    collected,
    history,
    overflowFindings,
    seenOverflow,
    extract,
    outDir,
    stamp,
    reportPath,
    journal,
    screenshotDir,
    videoDir,
    launch,
    secrets,
    runUsage,
    disarmKillSwitch,
    health,
    session,
    snapshotter,
    uxSecretCommand,
    http5xx,
    capture,
    journalListener,
    serverLog,
    closeSession,
  };
}

/** The run's shared state: set up once, handed to every later phase (the same objects, never copies). */
export type UsabilitySetup = Awaited<ReturnType<typeof setUpUsabilityMission>>;
