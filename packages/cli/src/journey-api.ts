import { FsJourneyStore, JourneyRegistry, deriveParamSchema, validateParams, type Journey } from "@jevitate/journey";
import { safeRunPolicy, type RunPolicy } from "@jevitate/domain";
import { PlaywrightBrowserPort, type BrowserLaunchOptions, type BrowserPort } from "@jevitate/playwright";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { JourneyRunner, type JourneyRunResult, type SelfHealer } from "@jevitate/runtime";
import { substituteSetupRefs, type FixtureRecord, type MissionFixtures } from "./mission-fixtures.js";

/**
 * Distinct from `@jevitate/journey`'s `ParamValidationError` so CLI/API callers
 * can tell "no such journey" apart from "params didn't match the journey's
 * schema" without string-matching error messages.
 */
export class UnknownJourneyError extends Error {}

/**
 * A Journey declares `metadata.requiresAuth: true` (#118) but the run was given no
 * `storageState` — refused BEFORE any browser launches, with a message that names the
 * actual problem instead of a confusing `replay-target-not-found` deep into the steps.
 */
export class JourneyRequiresAuthError extends Error {}

export interface RunJourneyProgrammaticallyOptions {
  /** Directory a `FsJourneyStore` reads Journey JSON files from. */
  dir: string;
  id: string;
  params: Record<string, string>;
  /** Defaults to `safeRunPolicy()` (Slice 1: fail-closed secret mode) when omitted. */
  policy?: RunPolicy;
  /**
   * Optional gated self-heal port (Ticket #7). Only relevant when
   * `policy.selfHeal.mode !== "fail-closed"`; wired as the `JourneyRunner`'s
   * 5th constructor arg. When omitted (the default), a divergence quarantines
   * exactly as before — identical to Slice 1's fail-closed behavior. The
   * caller (CLI) is responsible for its credential preflight; this surface
   * never builds AI gateways itself. Writes never auto-heal regardless of
   * this port (enforced by `JourneyRunner`'s write floor).
   */
  selfHealer?: SelfHealer;
  /**
   * Mission fixtures (#140/#144), built for the journey's own site once it is known: set up before
   * the browser opens (a failure throws `FixtureSetupError` — the journey never runs on unknown
   * state), `${setup.<name>}` in params bound to its outputs, and restored after the run.
   */
  fixtures?: (site: string) => MissionFixtures | undefined;
  /**
   * Playwright storageState JSON to seed the session from (CLI/MCP `--storage-state`, #118) —
   * the deterministic authenticated pre-step a Journey authored behind a login needs to
   * replay. Contains live session cookies: handed only to the browser, never logged, never
   * returned in the result, and never sent to a model.
   */
  storageState?: string;
  /** Testing seam — defaults to a real `PlaywrightBrowserPort`. */
  browserPortFactory?: () => BrowserPort;
  /** How Chromium is launched (executable/channel/extra args). Default: pinned Chromium. */
  browser?: BrowserLaunchOptions;
}

/**
 * Promotes a local Journey (#124, mirrors `promoteMissionTarget` in
 * `mission-api.ts`) so it becomes discoverable via `journey find`/MCP
 * `find_capabilities` and runnable via `run_journey` — a human-approval gate,
 * same as `mission target promote`. An unknown id is refused with
 * `UnknownJourneyError` (never silently created). Returns the persisted,
 * now-promoted Journey.
 */
export async function promoteJourney(dir: string, id: string): Promise<Journey> {
  const store = new FsJourneyStore(dir);
  const registry = new JourneyRegistry(store);

  const existing = await registry.get(id);
  if (!existing) {
    throw new UnknownJourneyError(`unknown journey '${id}'`);
  }
  await registry.promote(id);
  const promoted = await registry.get(id);
  return promoted ?? { ...existing, metadata: { ...existing.metadata, promoted: true } };
}

/**
 * The one programmatic surface for "run this published Journey by id" —
 * used by BOTH the CLI `journey run` action and external callers. Builds
 * the real `FsJourneyStore` + `JourneyRegistry`, resolves the journey
 * (unknown id -> `UnknownJourneyError`), validates params UP FRONT with
 * `deriveParamSchema`/`validateParams` (unknown/missing param ->
 * `ParamValidationError`, from `@jevitate/journey`) BEFORE any browser is
 * launched, then builds the real Actor + `JourneyRunner` and runs.
 */
export async function runJourneyProgrammatically(
  opts: RunJourneyProgrammaticallyOptions,
): Promise<JourneyRunResult & { fixtures?: FixtureRecord }> {
  const store = new FsJourneyStore(opts.dir);
  const registry = new JourneyRegistry(store);

  const journey = await registry.get(opts.id);
  if (!journey) {
    throw new UnknownJourneyError(`unknown journey '${opts.id}'`);
  }

  // #118: a Journey that declares it needs auth refuses BEFORE any browser launch when no
  // storageState was given — a clear, typed failure instead of a deep `replay-target-not-found`.
  if (journey.metadata.requiresAuth === true && opts.storageState === undefined) {
    throw new JourneyRequiresAuthError(
      `journey '${opts.id}' requires auth (metadata.requiresAuth) — run with --storage-state <file>`,
    );
  }

  // Fail fast: validate BEFORE any browser launch, so bad params never pay
  // the cost (or risk) of opening a browser.
  validateParams(deriveParamSchema(journey.recording), opts.params);

  const policy = opts.policy ?? safeRunPolicy();

  const fx = opts.fixtures?.(journey.recording.site);
  let params = opts.params;
  try {
    if (fx !== undefined) {
      await fx.setup();
      const b = fx.bindings();
      params = Object.fromEntries(Object.entries(opts.params).map(([k, v]) => [k, substituteSetupRefs(v, b, { where: `--param ${k}` })]));
    }
    // #140 order: fixture setup (above) → open the browser (#137 launch options, #118 storageState) → run → restore.
    const port = (opts.browserPortFactory ?? (() => new PlaywrightBrowserPort()))();
    const session = await port.open({
      headless: true,
      allowedOrigins: [journey.recording.site],
      baseUrl: journey.recording.site,
      ...opts.browser,
      ...(opts.storageState !== undefined ? { storageState: opts.storageState } : {}),
    });
    try {
      const actor = CastActor.named("cli-runner").whoCan(
        new BrowseTheWeb(session, [journey.recording.site]),
      );
      const runner = new JourneyRunner(actor, new RecordingInterpreter(), undefined, undefined, opts.selfHealer);
      const result = await runner.run({ journey, params, policy });
      if (fx === undefined) return result;
      await fx.restore();
      return { ...result, fixtures: fx.record() };
    } finally {
      await session.close();
    }
  } finally {
    await fx?.restore();
  }
}
