import { assertJourneyRunnable } from "@jevitate/mcp-facade";
import { inMcpInvocation } from "./approval-provenance.js";
import { assertMcpRunnable } from "./journey-stale-api.js";
import { prepareMcpRunGuard, RunGuardRefusedError, type McpRunGuard } from "./mcp-run-guard.js";
import { FsJourneyStore, JourneyRegistry, journeyParamSchema, secretParamNames, secretParamValues, validateParams } from "@jevitate/journey";
import { createHttpProbe, httpCheckRefs } from "./http-probe.js";
import type { SiteGateDeps } from "@jevitate/runtime";
import { gateJourney } from "./site-gate-cli.js";
import { safeRunPolicy, type RunPolicy } from "@jevitate/domain";
import { PlaywrightBrowserPort, type BrowserLaunchOptions, type BrowserPort, type EmulationSpec } from "@jevitate/playwright";
import { sessionLaunchOptions } from "./browser-run-options.js";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { RecordingInterpreter } from "@jevitate/interpreter";
import { JourneyRunner } from "@jevitate/runtime";
import { runLoadTest, type CapacityReport, type LoadActorRunner } from "@jevitate/load";
import { JourneyRequiresAuthError, journeyFixtureBaseDir } from "./journey-api.js";
import { JourneyOutcomeChecks } from "./journey-network-checks.js";
import { applyJourneyEnvironment, type ResolvedJourneyEnvironment } from "./environments.js";
import { guardRequestWithMode, resolveSurfaceRunMode, runModeRecord, type RunModeRecord } from "./run-surface-mode.js";

/** Distinct from `@jevitate/journey`'s ParamValidationError-style "unknown id" cases elsewhere, so CLI callers can branch without string-matching. */
export class UnknownLoadJourneyError extends Error {}

export interface RunJourneyLoadTestOptions {
  dir: string;
  id: string;
  params: Record<string, string>;
  concurrency: number;
  iterationsPerActor: number;
  /**
   * Governs deterministic actor fan-out/scheduling, and seeds each actor's human-like pacing when a
   * site policy declares one (`jevitate site policy set <origin>`): actor N's pacing is reproducible
   * from `seed` and N.
   */
  seed: number;
  authorizedOrigins: readonly string[];
  /** Defaults to `safeRunPolicy()`, same convention as `journey-api.ts`'s `runJourneyProgrammatically`. */
  policy?: RunPolicy;
  /**
   * Testing seam: overrides the real `PlaywrightBrowserPort` used per pool
   * member with a fake, so the per-actor browser-session lifecycle (see
   * `runnerFactory` below) can be unit-tested with no real browser. Defaults
   * to `() => new PlaywrightBrowserPort()`.
   */
  browserPortFactory?: () => BrowserPort;
  /**
   * Playwright storageState JSON to seed EVERY pool member's session from (CLI `--storage-state`,
   * #118) — the deterministic authenticated pre-step a Journey authored behind a login needs.
   * Contains live session cookies: handed only to the browser, never logged, never returned in
   * the report.
   */
  storageState?: string;
  /** How Chromium is launched (executable/channel/extra args). Default: pinned Chromium. */
  browser?: BrowserLaunchOptions;
  /** Per-mission viewport/device emulation (#149, CLI `--viewport <W>x<H>` / `--device "<name>"`) — applied to EVERY pool member's session. */
  emulation?: EmulationSpec;
  /** The site-policy gate (`jevitate site policy set`): only its pacing applies to a load run. */
  siteGate?: SiteGateDeps;
  /**
   * #247 (`--env`/`--base-url`): load-test this environment — the Journey's recorded URLs move onto
   * its baseUrl (which must still be an `--authorized-origin`); a step on an origin it does not
   * allow is refused before any browser opens. Absent: the recorded site, as before.
   */
  environment?: ResolvedJourneyEnvironment;
  /** 0.30.0 §5: `~/.jevitate/targets.json` (default), read for the target's trust and the #789 guard. */
  targetsFile?: string;
  /** 0.30.0 §5: `.jevitate/environments.json` (default: the named environment's file, else the project's). */
  environmentsFile?: string;
}

/** A load test's report, with the run mode it ran in (0.30.0 §5): `run.mode`, `run.target.trust`. */
export type LoadRunReport = CapacityReport & { readonly run: RunModeRecord };

/**
 * The programmatic surface behind `jevitate load run` — resolves a published
 * Journey (unknown id -> `UnknownLoadJourneyError`), validates params UP
 * FRONT, then hands `@jevitate/load`'s `runLoadTest` a factory that opens ONE
 * real headless Playwright session + `JourneyRunner` per pool member. The
 * authorized-target check happens inside `runLoadTest` itself — this
 * function does not duplicate or bypass it.
 *
 * NOTE on "seeded ⇒ reproducible / human-paced" (corrected post-review):
 * `opts.seed` makes the ACTOR POOL's composition reproducible (via
 * `deriveActorSeeds` inside `runLoadTest`), and — with a site policy that declares pacing — each
 * actor's clicks and keystrokes are human-paced, seeded from `seed` and the actor's index. A load
 * run is the operator's deliberate burst: the policy's throttles, budgets and quiet hours do not
 * refuse it; only its pacing applies.
 */
export async function runJourneyLoadTest(opts: RunJourneyLoadTestOptions): Promise<LoadRunReport> {
  const store = new FsJourneyStore(opts.dir);
  const registry = new JourneyRegistry(store);

  const stored = await registry.get(opts.id);
  if (!stored) {
    throw new UnknownLoadJourneyError(`unknown journey '${opts.id}'`);
  }
  // #788: `load run` replays a promoted Journey, as its help says — on both surfaces. A burst of writes
  // is nobody's way to try a draft (`journey run` is). Over MCP a stale approval refuses too.
  if (inMcpInvocation()) await assertMcpRunnable(stored, opts.dir);
  else if (stored.metadata.promoted !== true) assertJourneyRunnable(opts.id, { promoted: false, approval: "unrecorded" });
  const journey = applyJourneyEnvironment(stored, opts.environment);
  const allowedOrigins = opts.environment === undefined ? [journey.recording.site] : [...opts.environment.allowedOrigins];

  // #118: a Journey that declares it needs auth refuses BEFORE any browser launch when no
  // storageState was given — a clear, typed failure instead of a deep `replay-target-not-found`.
  if (journey.metadata.requiresAuth === true && opts.storageState === undefined) {
    throw new JourneyRequiresAuthError(
      `journey '${opts.id}' requires auth (metadata.requiresAuth) — run with --storage-state <file>`,
    );
  }

  validateParams(journeyParamSchema(journey), opts.params);

  // 0.30.0 §5: the mode, from the person-written files only, before any browser. A load test runs the
  // Journey, so the mode's Journey refusals apply as on `journey run`: over MCP an automation-mode target
  // needs a Journey a person approved; a test-mode target never runs one with a human step.
  const seams = { ...(opts.targetsFile === undefined ? {} : { targetsFile: opts.targetsFile }), ...(opts.environmentsFile === undefined ? {} : { environmentsFile: opts.environmentsFile }) };
  const decided = resolveSurfaceRunMode({ surface: "load", journey: stored, origin: opts.environment?.baseUrl ?? stored.recording.site, environment: opts.environment, ...seams });
  const notes: string[] = [];

  // #789: under an MCP invocation, each actor's session is guarded; a refusal ends the whole test, below.
  // The mode decides whether the Journey's own `allowedOrigins` stay on the write allowlist (automation drops
  // them) and gives test mode its relaxation inside the declared environment (each noted on the report).
  const guardFor = (): McpRunGuard | undefined =>
    prepareMcpRunGuard(guardRequestWithMode({ site: journey.recording.site, allowedOrigins, environment: opts.environment, authoredOrigins: stored.metadata.allowedOrigins ?? [], ...seams }, decided, notes));
  guardFor();
  let refusal: unknown;
  const policy = opts.policy ?? safeRunPolicy();
  const browserPortFactory = opts.browserPortFactory ?? (() => new PlaywrightBrowserPort());
  // #488: a relative `upload` fixture resolves against the project root, never the process cwd.
  const fixtureBaseDir = journeyFixtureBaseDir();

  const report = await runLoadTest({
    targetOrigin: journey.recording.site,
    authorizedOrigins: opts.authorizedOrigins,
    concurrency: opts.concurrency,
    iterationsPerActor: opts.iterationsPerActor,
    seed: opts.seed,
    runnerFactory: async (actorIndex): Promise<LoadActorRunner> => {
      const port = browserPortFactory();
      const session = await port.open({
        ...sessionLaunchOptions(opts.browser),
        allowedOrigins,
        baseUrl: journey.recording.site,
        ...opts.emulation,
        ...(opts.storageState !== undefined ? { storageState: opts.storageState } : {}),
      });
      const gate = await gateJourney(opts.siteGate, journey.recording, { enforceLimits: false, runId: `load-${opts.seed}-${actorIndex}` });
      const actor = CastActor.named(`load-actor-${actorIndex}`).whoCan(
        new BrowseTheWeb(session, allowedOrigins),
        ...gate.abilities,
      );
      // #400: a load iteration means the same as a `journey run` — the Journey's end state and
      // each step's `expectRequests` are judged, so a replay whose checks fail is not an ok run.
      const runGuard = guardFor();
      await runGuard?.arm(session, opts.params);
      const refs = httpCheckRefs({ params: opts.params, secretParams: secretParamNames(journey, opts.params) });
      const outcomeChecks = new JourneyOutcomeChecks(session.page, journey, {
        secrets: secretParamValues(journey, opts.params),
        // #543: http end-state checks request only origins in this run's allowlist.
        httpProbe: createHttpProbe({ allowlist: allowedOrigins }),
        resolveRef: refs,
      });
      const observer = outcomeChecks.observer();
      // #565: a step expectation's references resolve from the same names (a secret one refused).
      const guardOption = runGuard === undefined ? {} : { actionGuard: runGuard };
      const interpreter = observer === undefined ? new RecordingInterpreter({ fixtureBaseDir, refLookup: refs, ...guardOption }) : new RecordingInterpreter({ observer, fixtureBaseDir, refLookup: refs, ...guardOption });
      const runner = new JourneyRunner(actor, interpreter);

      // `runLoadTest` calls `run()` exactly `iterationsPerActor` times for
      // this actor — success or failure, never more, never fewer (see
      // measured-load-runner.ts's per-actor loop). Closing the real browser
      // session on EVERY `run()` would defeat pooling (a fresh browser
      // launch per iteration); never closing it leaks a Chromium process +
      // tmp profile dir per actor per invocation, worse as `--concurrency`
      // scales — the whole point of a load harness. So: reuse one session
      // across this actor's iterations, and close it in a `finally` once
      // the LAST iteration finishes OR throws — mirroring `journey-api.ts`'s
      // `try { ... } finally { await session.close(); }`.
      let remainingIterations = opts.iterationsPerActor;
      return {
        run: async () => {
          try {
            // #789: once refused, no iteration repeats the Journey's earlier writes on the way to the same refusal.
            if (refusal !== undefined) throw refusal;
            return await outcomeChecks.run(actor, () => runner.run({ journey, params: opts.params, policy }));
          } catch (err) {
            if (err instanceof RunGuardRefusedError) refusal = err;
            throw err;
          } finally {
            remainingIterations--;
            if (remainingIterations <= 0) {
              await session.close();
            }
          }
        },
      };
    },
  });
  // A refused run is not a data point: the report would read as ordinary failed iterations.
  if (refusal !== undefined) throw refusal;
  return { ...report, run: runModeRecord(decided, notes) };
}
