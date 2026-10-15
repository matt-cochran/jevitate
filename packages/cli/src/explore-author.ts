/** Journey authoring behind `jevitate explore-author-journey`: a model-driven run that authors a promotable Journey. */
import type { JudgmentPort, GenerationPort, UsageTracker } from "@jevitate/ai-core";
import { parseSuccessSpecUnderSetup } from "./http-probe.js";
import type { BrowserLaunchOptions, BrowserPort } from "@jevitate/playwright";
import { type Assertion } from "@jevitate/recording";
import type { SafetyConfig, SuccessCheck } from "@jevitate/explore";
import {
  authorJourney,
  assertAuthorizedExploreTarget,
  type AuthorTake,
  type AuthorTakeDiagnostics,
  type Bounds,
  type AuthorJourneyResult,
} from "@jevitate/explore";
import { FsJourneyStore } from "@jevitate/journey";
import { runExploration, type RunExplorationResult } from "./explore-goal.js";
import type { GoalRunShaping } from "./goal-run-flags.js";
import { screenshotsDirFor } from "./run-screenshots.js";
import { FixtureSetupError, UnboundSetupRefError, substituteSetupRefs, type MissionFixtures } from "./mission-fixtures.js";
import { fixtureSetupFailedResult, substituteUrlSetupRefs } from "./fixture-cli.js";
import { parseSuccessSpec } from "./explore-specs.js";
import { recordedFixturesFor } from "./journey-fixtures.js";
import type { LayoutDeps } from "./project-dir.js";

/**
 * Arguments handed to the authoring step of `runAuthorJourney`. Kept separate
 * from `RunAuthorJourneyOptions` so tests can inject `authorImpl` (a fake
 * authoring step) without opening a real browser.
 */
export interface AuthorViaBrowserArgs {
  readonly url: string;
  readonly origin: string;
  readonly goal: string;
  readonly successAssertion?: Assertion;
  /** #322: the success checks (`--success`, repeatable): page and network kinds. */
  readonly successChecks?: readonly SuccessCheck[];
  readonly allowlist: readonly string[];
  readonly judge?: JudgmentPort;
  readonly gen?: GenerationPort;
  readonly bounds?: Partial<Bounds>;
  readonly takes: number;
  readonly journeyId: string;
  readonly journeyName: string;
  readonly browserPortFactory?: () => BrowserPort;
  /** How Chromium is launched (executable/channel/extra args). Default: pinned Chromium. */
  readonly browser?: BrowserLaunchOptions;
  /**
   * Playwright storageState JSON to seed the session from (CLI `--storage-state`) —
   * the deterministic authenticated pre-step. Contains live session cookies: it is
   * handed only to the browser, never to a model or a Recording.
   */
  readonly storageState?: string;
  /** The exploration's safety policy (#249: the target's targets.json `safety`). Absent: the built-in one. */
  readonly safety?: SafetyConfig;
  /**
   * #369: the goal run's run-shaping options (`explore`'s own flags: secret fields, fixtures,
   * emulation, conversation tuning, safety/settle overlays, …) — every take is that goal run.
   */
  readonly goalRun?: GoalRunShaping;
  /** #369: where each take's result, transcript and Recording go. Default `.jevitate/logs/<date>`. */
  readonly outDir?: string;
  /** Usage accounting shared by every take (the gateways' tracker). */
  readonly usage?: UsageTracker;
  /**
   * #544: mission fixtures, set up before and restored after EVERY take (so each starts from the
   * same state) and handed to each goal run (hang replays re-run setup). `${setup.x}` in the
   * url/goal/success specs is bound per take.
   */
  readonly fixtures?: MissionFixtures;
  /** #544: the raw `--success` specs, re-parsed per take once `${setup.x}` is bound (needs `fixtures`). */
  readonly successSpecs?: readonly string[];
}

export interface RunAuthorJourneyOptions {
  readonly url: string;
  readonly goal: string;
  readonly successAssertion?: Assertion;
  /** #322: the success checks (`--success`, repeatable): page and network kinds. */
  readonly successChecks?: readonly SuccessCheck[];
  readonly allowlist: readonly string[];
  /** Where the authored Journey is persisted (via `FsJourneyStore`). */
  readonly journeysDir: string;
  readonly journeyId: string;
  readonly journeyName: string;
  /** Total takes incl. discovery. Default 1 (single-take MVP). */
  readonly takes?: number;
  readonly judge?: JudgmentPort;
  readonly gen?: GenerationPort;
  readonly bounds?: Partial<Bounds>;
  readonly browserPortFactory?: () => BrowserPort;
  /** How Chromium is launched (executable/channel/extra args). Default: pinned Chromium. */
  readonly browser?: BrowserLaunchOptions;
  /**
   * Playwright storageState JSON to seed the session from (CLI `--storage-state`) —
   * the deterministic authenticated pre-step. Contains live session cookies: it is
   * handed only to the browser, never to a model or a Recording.
   */
  readonly storageState?: string;
  /** The exploration's safety policy (#249: the target's targets.json `safety`). Absent: the built-in one. */
  readonly safety?: SafetyConfig;
  /** #369: the goal run's run-shaping options (see `AuthorViaBrowserArgs.goalRun`). */
  readonly goalRun?: GoalRunShaping;
  /** #369: where each take's artifacts go (see `AuthorViaBrowserArgs.outDir`). */
  readonly outDir?: string;
  readonly usage?: UsageTracker;
  /**
   * #544: mission fixtures, set up before and restored after EVERY take (so each starts from the
   * same state) and handed to each goal run (hang replays re-run setup). `${setup.x}` in the
   * url/goal/success specs is bound per take.
   */
  readonly fixtures?: MissionFixtures;
  /** #544: the raw `--success` specs, re-parsed per take once `${setup.x}` is bound (needs `fixtures`). */
  readonly successSpecs?: readonly string[];
  /** #544: the `--fixtures` file path, kept so a Journey can record the fixture it was authored under. */
  readonly fixturesFile?: string;
  /** Test seam: where the project root (the `.jevitate/` parent a recorded fixtures path is relative to) is found. */
  readonly layout?: LayoutDeps;
  /**
   * Test seam: override the authoring step. Defaults to `authorViaBrowser`,
   * which drives a real Playwright-backed actor through `authorJourney`.
   */
  readonly authorImpl?: (args: AuthorViaBrowserArgs) => Promise<AuthorJourneyResult>;
}

/**
 * The programmatic surface behind `jevitate explore author-journey` — drives
 * the goal-based exploration mission and feeds its take(s) through RxD's
 * diff/postdoc pipeline (`@jevitate/explore`'s `authorJourney`) to author a
 * parameterized, replayable, UNPROMOTED Journey, then persists it under the
 * journeys store. Additive: the record-by-demonstration authoring path is
 * untouched.
 *
 * The authorized-target guard runs FIRST (fail-closed), before any browser is
 * opened. The authoring step is injectable (`authorImpl`) so it is unit-testable
 * without a browser.
 */
export async function runAuthorJourney(opts: RunAuthorJourneyOptions): Promise<AuthorJourneyResult> {
  // Guardrail #1 — authorize BEFORE opening a browser. Throws on refusal.
  const origin = assertAuthorizedExploreTarget(opts.url, opts.allowlist);

  const impl = opts.authorImpl ?? authorViaBrowser;
  const result = await impl({
    url: opts.url,
    origin,
    goal: opts.goal,
    ...(opts.successAssertion === undefined ? {} : { successAssertion: opts.successAssertion }),
    ...(opts.successChecks === undefined ? {} : { successChecks: opts.successChecks }),
    allowlist: opts.allowlist,
    judge: opts.judge,
    gen: opts.gen,
    bounds: opts.bounds,
    takes: opts.takes ?? 1,
    journeyId: opts.journeyId,
    journeyName: opts.journeyName,
    browserPortFactory: opts.browserPortFactory,
    browser: opts.browser,
    ...(opts.storageState !== undefined ? { storageState: opts.storageState } : {}),
    ...(opts.safety === undefined ? {} : { safety: opts.safety }),
    ...(opts.goalRun === undefined ? {} : { goalRun: opts.goalRun }),
    ...(opts.outDir === undefined ? {} : { outDir: opts.outDir }),
    ...(opts.usage === undefined ? {} : { usage: opts.usage }),
    ...(opts.fixtures === undefined ? {} : { fixtures: opts.fixtures }),
    ...(opts.successSpecs === undefined ? {} : { successSpecs: opts.successSpecs }),
  });

  if (result.outcome === "authored") {
    // #170: a Journey authored behind a login (--storage-state) declares it, so a run without a
    // storage state fails fast as a configuration error instead of a gating step-1 assertion.
    const withAuth =
      opts.storageState !== undefined && result.journey.metadata.requiresAuth !== true
        ? { ...result.journey, metadata: { ...result.journey.metadata, requiresAuth: true } }
        : result.journey;
    // #544: a Journey authored under --fixtures records the file and spec hash, so a later run replays
    // under the same fixtures. Shell hooks (--before/--after) are never recorded.
    const journey =
      opts.fixturesFile !== undefined
        ? {
            ...withAuth,
            metadata: {
              ...withAuth.metadata,
              fixtures: recordedFixturesFor(opts.fixturesFile, { allowlist: opts.allowlist, baseUrl: origin }, opts.layout),
            },
          }
        : withAuth;
    await new FsJourneyStore(opts.journeysDir).put(journey);
    return journey === result.journey ? result : { ...result, journey };
  }
  return result;
}

/**
 * Default authoring step (#369): every take — the discovery and each corroborating one — is a full
 * goal run (`runExploration`, exactly what `jevitate explore --strategy goal` runs, with the same
 * run-shaping options), in its own browser, writing its own result, transcript and Recording; its
 * verdict (`goalOutcome`) decides whether the take reached the goal.
 */
async function authorViaBrowser(args: AuthorViaBrowserArgs): Promise<AuthorJourneyResult> {
  if (!args.judge || !args.gen) {
    throw new Error("runAuthorJourney: judge and gen gateways are required to drive the authoring mission");
  }
  const judge = args.judge;
  const gen = args.gen;
  const g = args.goalRun ?? {};
  // targets.json's safety (`goalRun.target`) wins; a caller's `safety` (#249) applies without one.
  const target = g.target ?? (args.safety === undefined ? undefined : { safety: args.safety });
  const fx = args.fixtures;
  try {
    return await authorJourney({
    goal: args.goal,
    ...(args.successAssertion === undefined ? {} : { successAssertion: args.successAssertion }),
    ...(args.successChecks === undefined ? {} : { successChecks: args.successChecks }),
    allowlist: args.allowlist,
    startUrl: args.url,
    bounds: args.bounds,
    takes: args.takes,
    journeyId: args.journeyId,
    journeyName: args.journeyName,
    runTake: async ({ goal: takeGoal, successChecks: takeChecks }) => {
      let url = args.url;
      let goal = takeGoal;
      let successChecks = takeChecks;
      if (fx !== undefined) {
        // Never run a take on unknown state: a failed setup ends authoring (after restoring whatever
        // the partial setup created).
        try {
          await fx.setup();
          const b = fx.bindings();
          url = substituteUrlSetupRefs(args.url, b);
          goal = substituteSetupRefs(takeGoal, b, { where: "--goal" });
          if (args.successSpecs !== undefined) successChecks = args.successSpecs.map((spec) => parseSuccessSpecUnderSetup(spec, b, "--success"));
        } catch (err) {
          await fx.restore();
          if (err instanceof FixtureSetupError || err instanceof UnboundSetupRefError) throw new AuthorFixtureSetupError(fixtureSetupFailedResult(err, fx));
          throw err;
        }
      }
      try {
      const r = await runExploration({
        ...g,
        ...(target === undefined ? {} : { target }),
        ...(fx === undefined ? {} : { fixtures: fx }),
        url,
        goal,
        successChecks,
        allowlist: args.allowlist,
        judge,
        gen,
        ...(args.usage === undefined ? {} : { usage: args.usage }),
        bounds: args.bounds,
        ...(args.outDir === undefined ? {} : { outDir: args.outDir }),
        ...(args.browserPortFactory === undefined ? {} : { browserPortFactory: args.browserPortFactory }),
        ...(args.browser === undefined ? {} : { browser: args.browser }),
        ...(args.storageState === undefined ? {} : { storageState: args.storageState }),
      });
      return goalRunTake(r, g);
      } finally {
        // Every take ends restored, so the next one starts from the same state.
        await fx?.restore();
      }
    },
  });
  } catch (err) {
    if (!(err instanceof AuthorFixtureSetupError)) throw err;
    return { outcome: "not-reached", reason: err.result.reason, failure: err.result.failure };
  }
}

/** #544: a take's fixture setup failed — authoring ends (no Journey), with explore's own failure shape. */
class AuthorFixtureSetupError extends Error {
  constructor(readonly result: ReturnType<typeof fixtureSetupFailedResult>) {
    super(result.reason);
  }
}

/** #369: one goal run as an authoring take — its Recording and where everything it wrote is. */
export function goalRunTake(r: RunExplorationResult, g: Pick<GoalRunShaping, "screenshots"> = {}): AuthorTake {
  const reason = r.reason ?? r.failure?.message;
  const recordingPath = r.recordingPaths[0];
  // #423: a goal reached on a run that hit a defect (a 5xx, a server-log error, a violated invariant)
  // is not a take to author from — as before the goal/defect split, it reads `defects-found` here.
  const outcome = r.goalOutcome === "succeeded" && r.defectOutcome.status === "defects" ? "defects-found" : r.goalOutcome;
  const diagnostics: AuthorTakeDiagnostics = {
    outcome,
    ...(reason === undefined ? {} : { reason }),
    stop: r.stop,
    runOutcome: r.runOutcome,
    ...(r.failure === undefined ? {} : { failure: { kind: r.failure.kind, message: r.failure.message } }),
    checks: r.checks,
    decisions: r.decisions,
    actions: r.actions,
    finalUrl: r.finalUrl,
    resultPath: r.resultPath,
    transcriptPath: r.transcriptPath,
    recordingPaths: r.recordingPaths,
    ...(g.screenshots === undefined || recordingPath === undefined ? {} : { screenshotsDir: screenshotsDirFor(g.screenshots, recordingPath) }),
  };
  return { outcome, recording: r.recording, diagnostics };
}
