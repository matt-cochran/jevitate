import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JudgmentPort, GenerationPort, CredentialKey } from "@jevitate/ai-core";
import { PlaywrightBrowserPort, type BrowserLaunchOptions, type BrowserPort } from "@jevitate/playwright";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import type { Assertion, TargetDescriptor } from "@jevitate/recording";
import {
  runGoalBasedMission,
  authorJourney,
  runInductionMission,
  runAdversarialMission,
  runFeatureMission,
  assertAuthorizedExploreTarget,
  normalizeAllowlist,
  resolveMissionFixture,
  type Bounds,
  type CoverageReport,
  type GoalBasedOutcome,
  type StopReason,
  type AuthorJourneyResult,
  type AdversarialOutcome,
  type MisuseStrategy,
  type CapabilityScope,
  type FeatureRunResult,
} from "@jevitate/explore";
import { FsJourneyStore } from "@jevitate/journey";
import { resolveDataDir } from "./data-dir.js";

/**
 * The programmatic surface behind `jevitate explore` — wires a real Playwright
 * `Page` + gateways to `@jevitate/explore`'s goal-based mission, then persists
 * the emitted `Recording` under `~/.jevitate/recordings`.
 *
 * The authorized-target guard runs FIRST (fail-closed), BEFORE any browser is
 * opened — an unauthorized origin never launches Chromium. Gateways are
 * injected (fakes in tests / live wiring in `program.ts`), so this file needs
 * no keys or network to be unit-tested.
 */

export interface RunExplorationOptions {
  readonly url: string;
  readonly goal: string;
  readonly successAssertion: Assertion;
  readonly allowlist: readonly string[];
  readonly judge: JudgmentPort;
  readonly gen: GenerationPort;
  readonly bounds?: Partial<Bounds>;
  readonly secrets?: readonly string[];
  /**
   * Local file the `upload` op attaches (CLI `--fixture`). Validated before any
   * browser opens: a missing file throws `FixtureNotFoundError`.
   */
  readonly fixture?: string;
  /** Where the Recording is written. Default `~/.jevitate/recordings`. */
  readonly outDir?: string;
  /** Testing seam — defaults to a real `PlaywrightBrowserPort`. */
  readonly browserPortFactory?: () => BrowserPort;
  /** How Chromium is launched (executable/channel/extra args). Default: pinned Chromium. */
  readonly browser?: BrowserLaunchOptions;
  /**
   * Playwright storageState JSON to seed the session from (CLI `--storage-state`) —
   * the deterministic authenticated pre-step. Contains live session cookies: it is
   * handed only to the browser, never to a model or a Recording.
   */
  readonly storageState?: string;
  /** ISO clock for the recording filename. Default `Date.now()`. */
  readonly nowIso?: () => string;
}

export interface RunExplorationResult {
  readonly outcome: GoalBasedOutcome;
  readonly assertionPassed: boolean;
  readonly stop: StopReason;
  readonly finalUrl: string;
  readonly decisions: number;
  readonly actions: number;
  readonly recordingPath: string;
}

export async function runExploration(opts: RunExplorationOptions): Promise<RunExplorationResult> {
  // Guardrail #1 — authorize BEFORE opening a browser. Throws on refusal.
  const origin = assertAuthorizedExploreTarget(opts.url, opts.allowlist);
  // Fail fast on a missing fixture BEFORE launching Chromium.
  const fixture = opts.fixture === undefined ? undefined : await resolveMissionFixture(opts.fixture);

  const portFactory = opts.browserPortFactory ?? (() => new PlaywrightBrowserPort());
  const port = portFactory();
  const session = await port.open({
    headless: true,
    allowedOrigins: [...opts.allowlist],
    baseUrl: origin,
    ...opts.browser,
    ...(opts.storageState !== undefined ? { storageState: opts.storageState } : {}),
  });

  try {
    const actor = CastActor.named("explorer").whoCan(new BrowseTheWeb(session, [...opts.allowlist]));
    const mission = await runGoalBasedMission({
      actor,
      judge: opts.judge,
      gen: opts.gen,
      goal: opts.goal,
      allowlist: opts.allowlist,
      startUrl: opts.url,
      successAssertion: opts.successAssertion,
      bounds: opts.bounds,
      secrets: opts.secrets,
      site: origin,
      fixture,
    });

    const outDir = opts.outDir ?? resolveDataDir(["recordings"]);
    await mkdir(outDir, { recursive: true });
    const iso = (opts.nowIso ?? (() => new Date().toISOString()))();
    const recordingPath = join(outDir, `explore-${iso.replace(/[:.]/g, "-")}.json`);
    await writeFile(recordingPath, `${JSON.stringify(mission.recording, null, 2)}\n`, "utf8");

    return {
      outcome: mission.outcome,
      assertionPassed: mission.assertionPassed,
      stop: mission.run.stop,
      finalUrl: mission.finalUrl,
      decisions: mission.run.decisions,
      actions: mission.run.actions,
      recordingPath,
    };
  } finally {
    await session.close();
  }
}

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
  });

  if (result.outcome === "authored") {
    await new FsJourneyStore(opts.journeysDir).put(result.journey);
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
    headless: true,
    allowedOrigins: [...args.allowlist],
    baseUrl: args.origin,
    ...args.browser,
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
    });
  } finally {
    await session.close();
  }
}

/**
 * The programmatic surface behind `jevitate explore --strategy coverage`
 * (additive, alongside `runExploration`). Wires a real Playwright `Page` +
 * gateways to `@jevitate/explore`'s proof-by-induction (state-coverage) mission
 * and persists each emitted repro `Recording` under `~/.jevitate/recordings`.
 *
 * Same fail-closed discipline as `runExploration`: the authorized-target guard
 * runs FIRST, before any browser is opened.
 */
export interface RunCoverageMissionOptions {
  readonly url: string;
  readonly allowlist: readonly string[];
  readonly judge: JudgmentPort;
  readonly gen: GenerationPort;
  readonly bounds?: Partial<Bounds>;
  /** Where the repro Recordings are written. Default `~/.jevitate/recordings`. */
  readonly outDir?: string;
  readonly browserPortFactory?: () => BrowserPort;
  /** How Chromium is launched (executable/channel/extra args). Default: pinned Chromium. */
  readonly browser?: BrowserLaunchOptions;
  /**
   * Playwright storageState JSON to seed the session from (CLI `--storage-state`) —
   * the deterministic authenticated pre-step. Contains live session cookies: it is
   * handed only to the browser, never to a model or a Recording.
   */
  readonly storageState?: string;
  readonly nowIso?: () => string;
}

export interface RunCoverageMissionResult {
  readonly coverage: CoverageReport;
  readonly outcome: "exhausted" | "cap";
  readonly recordingPaths: string[];
}

export async function runCoverageMission(opts: RunCoverageMissionOptions): Promise<RunCoverageMissionResult> {
  // Guardrail #1 — authorize BEFORE opening a browser. Throws on refusal.
  const origin = assertAuthorizedExploreTarget(opts.url, opts.allowlist);

  const portFactory = opts.browserPortFactory ?? (() => new PlaywrightBrowserPort());
  const port = portFactory();
  const session = await port.open({
    headless: true,
    allowedOrigins: [...opts.allowlist],
    baseUrl: origin,
    ...opts.browser,
    ...(opts.storageState !== undefined ? { storageState: opts.storageState } : {}),
  });

  try {
    const actor = CastActor.named("coverage-mission").whoCan(new BrowseTheWeb(session, [...opts.allowlist]));
    const result = await runInductionMission({
      page: session.page,
      actor,
      judgment: opts.judge,
      generation: opts.gen,
      seedUrl: opts.url,
      allowlist: opts.allowlist,
      bounds: opts.bounds,
    });

    const outDir = opts.outDir ?? resolveDataDir(["recordings"]);
    await mkdir(outDir, { recursive: true });
    const iso = (opts.nowIso ?? (() => new Date().toISOString()))();
    const stamp = iso.replace(/[:.]/g, "-");
    const recordingPaths: string[] = [];
    for (let i = 0; i < result.recordings.length; i++) {
      const p = join(outDir, `coverage-${stamp}-state-${i}.json`);
      await writeFile(p, `${JSON.stringify(result.recordings[i], null, 2)}\n`, "utf8");
      recordingPaths.push(p);
    }

    return { coverage: result.coverage, outcome: result.outcome, recordingPaths };
  } finally {
    await session.close();
  }
}

/**
 * Options for the additive adversarial CLI mission. Mirrors `runExploration`'s
 * fail-closed discipline: the authorized-target guard runs FIRST, before any
 * browser is opened, so an unauthorized origin never launches Chromium.
 */
export interface RunAdversarialCliMissionOptions {
  readonly seedUrl: string;
  readonly allowlist: readonly string[];
  readonly strategies: readonly MisuseStrategy[];
  readonly judgment: JudgmentPort;
  readonly generation: GenerationPort;
  readonly headless?: boolean;
  /** Testing seam — defaults to a real `PlaywrightBrowserPort`. */
  readonly browserPortFactory?: () => BrowserPort;
  /** How Chromium is launched (executable/channel/extra args). Default: pinned Chromium. */
  readonly browser?: BrowserLaunchOptions;
  /**
   * Playwright storageState JSON to seed the session from (CLI `--storage-state`) —
   * the deterministic authenticated pre-step. Contains live session cookies: it is
   * handed only to the browser, never to a model or a Recording.
   */
  readonly storageState?: string;
}

/**
 * Runs `@jevitate/explore`'s adversarial "try to break it" mission behind the
 * CLI. Guardrail #1 is enforced BEFORE opening a browser (fail-closed); the
 * session is always torn down. The stop-on-defect decision is the mission's
 * own trusted hard-signal oracle — never Jev's `Noul` (guardrail #4).
 */
export async function runAdversarialCliMission(
  opts: RunAdversarialCliMissionOptions,
): Promise<AdversarialOutcome> {
  // Guardrail #1 — authorize BEFORE opening a browser. Throws on refusal.
  const origin = assertAuthorizedExploreTarget(opts.seedUrl, opts.allowlist);
  const portFactory = opts.browserPortFactory ?? (() => new PlaywrightBrowserPort());
  const port = portFactory();
  const session = await port.open({
    headless: opts.headless ?? true,
    allowedOrigins: [...opts.allowlist],
    baseUrl: origin,
    ...opts.browser,
    ...(opts.storageState !== undefined ? { storageState: opts.storageState } : {}),
  });
  try {
    const actor = CastActor.named("adversarial-mission").whoCan(new BrowseTheWeb(session, [...opts.allowlist]));
    return await runAdversarialMission({
      page: session.page,
      actor,
      judgment: opts.judgment,
      generation: opts.generation,
      seedUrl: opts.seedUrl,
      allowlist: opts.allowlist,
      strategies: opts.strategies,
      site: origin,
    });
  } finally {
    await session.close();
  }
}

/**
 * The programmatic surface behind `jevitate explore --feature <name>` — the
 * capability-scoped feature-testing mission (ticket #2, paired site ticket
 * #11). Model-free by design, so unlike `runExploration` it needs no gateways.
 *
 * The authorized-target guard runs FIRST (fail-closed), BEFORE any browser is
 * opened — an unauthorized origin never launches Chromium.
 */
export interface RunFeatureCliMissionOptions {
  readonly seedUrl: string;
  readonly allowlist: readonly string[];
  readonly capability: string;
  readonly routeGlobs: readonly string[];
  readonly headless?: boolean;
  /** Testing seam — defaults to a real `PlaywrightBrowserPort`. */
  readonly browserPortFactory?: () => BrowserPort;
  /** How Chromium is launched (executable/channel/extra args). Default: pinned Chromium. */
  readonly browser?: BrowserLaunchOptions;
  /**
   * Playwright storageState JSON to seed the session from (CLI `--storage-state`) —
   * the deterministic authenticated pre-step. Contains live session cookies: it is
   * handed only to the browser, never to a model or a Recording.
   */
  readonly storageState?: string;
}

export async function runFeatureCliMission(opts: RunFeatureCliMissionOptions): Promise<FeatureRunResult> {
  // Guardrail #1 — authorize BEFORE opening a browser. Throws on refusal.
  const origin = assertAuthorizedExploreTarget(opts.seedUrl, opts.allowlist);
  const scope: CapabilityScope = { name: opts.capability, originAllowlist: opts.allowlist, routeGlobs: opts.routeGlobs };

  const portFactory = opts.browserPortFactory ?? (() => new PlaywrightBrowserPort());
  const session = await portFactory().open({
    headless: opts.headless ?? true,
    allowedOrigins: [...opts.allowlist],
    baseUrl: origin,
    ...opts.browser,
    ...(opts.storageState !== undefined ? { storageState: opts.storageState } : {}),
  });
  try {
    const actor = CastActor.named("feature-mission").whoCan(new BrowseTheWeb(session, [...opts.allowlist]));
    return await runFeatureMission({
      page: session.page,
      actor,
      seedUrl: opts.seedUrl,
      allowlist: opts.allowlist,
      scope,
    });
  } finally {
    await session.close();
  }
}

/** Injectable wiring for the `explore` CLI command (all optional). */
export interface ExploreCliDeps {
  /** Injected judgment gateway (tests). */
  judge?: JudgmentPort;
  /** Injected generation gateway (tests). */
  gen?: GenerationPort;
  browserPortFactory?: () => BrowserPort;
  env?: Record<string, string | undefined>;
  localConfig?: Partial<Record<CredentialKey, string>>;
}

/**
 * Compact `--success` assertion spec parser. Supported forms:
 *   urlIncludes:<text>
 *   visible:<descriptor>
 *   textIncludes:<descriptor>|<text>
 *   count:<descriptor>|min=<n>,max=<n>
 * where <descriptor> is `k=v` pairs joined by `;` over
 * testId/role/name/label/text/css.
 */
export function parseAssertionSpec(spec: string): Assertion {
  const ci = spec.indexOf(":");
  if (ci === -1) throw new Error(`invalid --success spec ${JSON.stringify(spec)}; expected "<kind>:<...>"`);
  const kind = spec.slice(0, ci);
  const rest = spec.slice(ci + 1);

  switch (kind) {
    case "urlIncludes": {
      if (rest === "") throw new Error("urlIncludes requires a text (urlIncludes:/path)");
      return { kind: "urlIncludes", text: rest };
    }
    case "visible":
      return { kind: "visible", target: parseDescriptorSpec(rest) };
    case "textIncludes": {
      const bar = rest.lastIndexOf("|");
      if (bar === -1) throw new Error('textIncludes requires "<descriptor>|<text>"');
      return { kind: "textIncludes", target: parseDescriptorSpec(rest.slice(0, bar)), text: rest.slice(bar + 1) };
    }
    case "count": {
      const bar = rest.indexOf("|");
      const descPart = bar === -1 ? rest : rest.slice(0, bar);
      const bounds = bar === -1 ? "" : rest.slice(bar + 1);
      const target = parseDescriptorSpec(descPart);
      const out: Assertion = { kind: "count", target };
      for (const pair of bounds.split(",")) {
        const [k, v] = pair.split("=");
        if (k === "min" && v) (out as { min?: number }).min = Number(v);
        if (k === "max" && v) (out as { max?: number }).max = Number(v);
      }
      return out;
    }
    default:
      throw new Error(`unsupported assertion kind ${JSON.stringify(kind)}`);
  }
}

function parseDescriptorSpec(s: string): TargetDescriptor {
  const d: TargetDescriptor = {};
  const keys = ["testId", "role", "name", "label", "text", "css"] as const;
  for (const pair of s.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const k = pair.slice(0, eq);
    const v = pair.slice(eq + 1);
    if ((keys as readonly string[]).includes(k) && v !== "") {
      (d as Record<string, string>)[k] = v;
    }
  }
  if (!(d.testId || d.role || d.label || d.text || d.css)) {
    throw new Error(`descriptor spec ${JSON.stringify(s)} has no usable selector`);
  }
  return d;
}

/**
 * The authorized-origins allowlist for a run: explicit `--allow` origins when
 * given, otherwise the target URL's own origin (you asked to explore it). An
 * unparseable URL yields an empty allowlist → the guard fails closed.
 */
export function resolveExploreAllowlist(url: string, allow: readonly string[]): string[] {
  if (allow.length > 0) return [...allow];
  return normalizeAllowlist([url]);
}
