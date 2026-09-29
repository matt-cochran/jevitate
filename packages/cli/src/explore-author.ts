/** Journey authoring behind `jevitate explore-author-journey`: a model-driven run that authors a promotable Journey. */
import type { JudgmentPort, GenerationPort } from "@jevitate/ai-core";
import { PlaywrightBrowserPort, type BrowserLaunchOptions, type BrowserPort } from "@jevitate/playwright";
import { sessionLaunchOptions } from "./browser-run-options.js";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { type Assertion } from "@jevitate/recording";
import type { SafetyConfig } from "@jevitate/explore";
import {
  authorJourney,
  assertAuthorizedExploreTarget,
  type Bounds,
  type AuthorJourneyResult,
} from "@jevitate/explore";
import { FsJourneyStore } from "@jevitate/journey";

/**
 * Arguments handed to the authoring step of `runAuthorJourney`. Kept separate
 * from `RunAuthorJourneyOptions` so tests can inject `authorImpl` (a fake
 * authoring step) without opening a real browser.
 */
export interface AuthorViaBrowserArgs {
  readonly url: string;
  readonly origin: string;
  readonly goal: string;
  readonly successAssertion: Assertion;
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
}

export interface RunAuthorJourneyOptions {
  readonly url: string;
  readonly goal: string;
  readonly successAssertion: Assertion;
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
    successAssertion: opts.successAssertion,
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
  });

  if (result.outcome === "authored") {
    // #170: a Journey authored behind a login (--storage-state) declares it, so a run without a
    // storage state fails fast as a configuration error instead of a gating step-1 assertion.
    const journey =
      opts.storageState !== undefined && result.journey.metadata.requiresAuth !== true
        ? { ...result.journey, metadata: { ...result.journey.metadata, requiresAuth: true } }
        : result.journey;
    await new FsJourneyStore(opts.journeysDir).put(journey);
    return journey === result.journey ? result : { ...result, journey };
  }
  return result;
}

/** Default authoring step: opens a real browser, builds an actor, authors. */
async function authorViaBrowser(args: AuthorViaBrowserArgs): Promise<AuthorJourneyResult> {
  if (!args.judge || !args.gen) {
    throw new Error("runAuthorJourney: judge and gen gateways are required to drive the authoring mission");
  }
  const judge = args.judge;
  const gen = args.gen;

  const portFactory = args.browserPortFactory ?? (() => new PlaywrightBrowserPort());
  const port = portFactory();
  const session = await port.open({
    ...sessionLaunchOptions(args.browser),
    allowedOrigins: [...args.allowlist],
    baseUrl: args.origin,
    ...(args.storageState !== undefined ? { storageState: args.storageState } : {}),
  });

  try {
    const actor = CastActor.named("author").whoCan(new BrowseTheWeb(session, [...args.allowlist]));
    return await authorJourney({
      goal: args.goal,
      successAssertion: args.successAssertion,
      allowlist: args.allowlist,
      startUrl: args.url,
      bounds: args.bounds,
      actor,
      judgment: judge,
      generation: gen,
      takes: args.takes,
      journeyId: args.journeyId,
      journeyName: args.journeyName,
      ...(args.safety === undefined ? {} : { safety: args.safety }),
    });
  } finally {
    await session.close();
  }
}
