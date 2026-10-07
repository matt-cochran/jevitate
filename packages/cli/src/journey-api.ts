import { FsJourneyStore, JourneyRegistry, ParamValidationError, deriveParamSchema, describeStep, flatJourneySteps, journeyPrefix, secretParamValues, validateParams, type Journey } from "@jevitate/journey";
import { redactText } from "@jevitate/ai-core";
import { safeRunPolicy, type RunPolicy, clock } from "@jevitate/domain";
import { join } from "node:path";
import { PlaywrightBrowserPort, type BrowserPort, type BrowserSession, type EmulationSpec } from "@jevitate/playwright";
import { assertSameExtensionBuild, closeOnce, finalizeVideos, runVideoDir, sessionLaunchOptions, type BrowserRunOptions } from "./browser-run-options.js";
import { artifactStamp } from "./mission-journal.js";
import { logsDirFor } from "./project-dir.js";
import { CastActor, BrowseTheWeb } from "@jevitate/screenplay";
import { RecordingInterpreter, type StepObserver } from "@jevitate/interpreter";
import { ReplayDeltas, replayDeltaSummary, type ReplayDeltaSummary } from "@jevitate/explore";
import { BrowseTheWebToken } from "@jevitate/screenplay";
import { SecretPixelMask, maskingPort } from "./demo-capture.js";
import { RunScreenshots, composeObservers, screenshotObserver, screenshotsDirFor, type ScreenshotsResult, type ScreenshotsSpec } from "./run-screenshots.js";
import { JourneyRunner, type JourneyRunResult, type SelfHealer, type SiteGateDeps } from "@jevitate/runtime";
import { gateJourney } from "./site-gate-cli.js";
import { substituteSetupRefs, type FixtureRecord, type MissionFixtures } from "./mission-fixtures.js";
import { applyJourneyEnvironment, type ResolvedJourneyEnvironment } from "./environments.js";
import { withNetworkChecks } from "./journey-network-checks.js";

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
  /** How Chromium is launched (executable/channel/extra args) and shown (#245 demo mode). Default: pinned Chromium, headless. */
  browser?: BrowserRunOptions;
  /** Per-mission viewport/device emulation (#149, CLI `--viewport <W>x<H>` / `--device "<name>"`). */
  emulation?: EmulationSpec;
  /**
   * The site-policy gate's repositories (`jevitate site policy set`): pacing, throttles, budgets and
   * quiet hours for the Journey's origin. Absent (no policy database) means no site policy applies.
   */
  siteGate?: SiteGateDeps;
  /** The site-policy account (default `primary`, as `jevitate site policy` uses). */
  account?: string;
  /**
   * #246 seam: the interpreter the run replays with — `journey annotate` passes one carrying a
   * `StepObserver` (before/after page evidence). Default: a plain `RecordingInterpreter`.
   */
  interpreter?: RecordingInterpreter;
  /**
   * The environment to run against (#247, `--env`/`--base-url`, from `resolveJourneyEnvironment`):
   * the Journey's recorded same-origin URLs move onto its `baseUrl` and the run's allowlist is its
   * `allowedOrigins`; a step on any other origin is refused before any fixture or browser.
   * Absent: the Journey's recorded site, exactly as before.
   */
  environment?: ResolvedJourneyEnvironment;
  /**
   * #251 `--screenshots`: one masked screenshot per distinct screen (or per step) + `index.md`;
   * the paths come back as `screenshotPaths`. Absent: none.
   */
  screenshots?: ScreenshotsSpec;
  /** #251 seam: a per-step observer composed into the default interpreter (annotate, demo). Ignored with `interpreter`. */
  observer?: StepObserver;
  /**
   * #250/#251: the run's pixel mask (default: one over the Journey's secret parameters) — installed
   * on the session before its first navigation whenever it records video or screenshots.
   */
  mask?: SecretPixelMask;
  /**
   * #293 journey-anchored exploration: replay in THIS already-open session and leave it open (the
   * caller's mission continues in the same page, form contents and session). No browser is opened
   * or closed here; video/screenshots belong to the caller's session.
   */
  session?: BrowserSession;
  /**
   * #293: replay only the first N top-level steps — the prefix up to an anchor. A `--param` the
   * Journey does not take is still refused; one only a later step uses is not required (and unused).
   */
  stopAfterStep?: number;
  /**
   * #303 `--action-deltas` (opt-in): record what each replayed step changed (redacted, code verdict)
   * and compare it with the delta the Journey's Recording stored — returned as `actionDeltas`.
   * Observation only: it never changes the replay. Off: nothing is captured.
   */
  actionDeltas?: boolean;
}

/**
 * #246: a secret parameter's value (declared `secret: true`, or a credential-like name) never comes
 * back in a run's output — the interpreter's vars start as the params, so the value is masked there.
 */
export function redactSecretParams<T>(result: T, journey: Journey, params: Record<string, string>): T {
  const secrets = secretParamValues(journey, params);
  if (secrets.length === 0) return result;
  const scrub = (v: unknown): unknown =>
    typeof v === "string"
      ? redactText(v, secrets)
      : Array.isArray(v)
        ? v.map(scrub)
        : v !== null && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]))
          : v;
  return scrub(result) as T;
}

/**
 * #293: the params a Journey PREFIX runs with — a `--param` the whole Journey does not take is
 * refused (`ParamValidationError`), one only a later step uses is dropped; the prefix's own required
 * params are then checked by `validateParams` as usual.
 */
export function prefixParams(full: Journey, prefix: Journey, params: Record<string, string>): Record<string, string> {
  const known = deriveParamSchema(full.recording).required;
  const unknown = Object.keys(params).filter((k) => !known.includes(k));
  if (unknown.length > 0) throw new ParamValidationError(`param mismatch — missing: [], unknown: [${unknown.join(", ")}]`);
  const needed = deriveParamSchema(prefix.recording).required;
  return Object.fromEntries(Object.entries(params).filter(([k]) => needed.includes(k)));
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
): Promise<JourneyRunResult & { fixtures?: FixtureRecord; videoPaths?: string[]; actionDeltas?: ReplayDeltaSummary } & Partial<ScreenshotsResult>> {
  const store = new FsJourneyStore(opts.dir);
  const registry = new JourneyRegistry(store);

  const stored = await registry.get(opts.id);
  if (!stored) {
    throw new UnknownJourneyError(`unknown journey '${opts.id}'`);
  }
  // #247: onto the chosen environment (a step on an origin it does not allow is refused here).
  const full = applyJourneyEnvironment(stored, opts.environment);
  // #293: only the prefix up to the anchor runs (its params are the ones those steps take).
  const journey = opts.stopAfterStep === undefined ? full : journeyPrefix(full, opts.stopAfterStep);
  const allowedOrigins = opts.environment === undefined ? [journey.recording.site] : [...opts.environment.allowedOrigins];
  // #256: a Journey recorded with extensions replays only under that same build (ExtensionMismatchError, exit 64).
  if ((journey.recording.extensions ?? []).length > 0) assertSameExtensionBuild(journey.recording.extensions, opts.browser, `journey '${opts.id}'`);

  // #118: a Journey that declares it needs auth refuses BEFORE any browser launch when no
  // storageState was given — a clear, typed failure instead of a deep `replay-target-not-found`.
  if (journey.metadata.requiresAuth === true && opts.storageState === undefined) {
    throw new JourneyRequiresAuthError(
      `journey '${opts.id}' requires auth (metadata.requiresAuth) — run with --storage-state <file>`,
    );
  }

  // Fail fast: validate BEFORE any browser launch, so bad params never pay
  // the cost (or risk) of opening a browser.
  const inputParams = journey === full ? opts.params : prefixParams(full, journey, opts.params);
  validateParams(deriveParamSchema(journey.recording), inputParams);

  const policy = opts.policy ?? safeRunPolicy();

  // The site policy (`jevitate site policy set <origin>`): pacing, throttles, budgets, quiet hours —
  // decided before any fixture or browser; a refusal says why and when to retry.
  const gate = await gateJourney(opts.siteGate, journey.recording, { ...(opts.account === undefined ? {} : { account: opts.account }), enforceLimits: true });

  const fx = opts.fixtures?.(journey.recording.site);
  let params = inputParams;
  try {
    if (fx !== undefined) {
      await fx.setup();
      const b = fx.bindings();
      params = Object.fromEntries(Object.entries(inputParams).map(([k, v]) => [k, substituteSetupRefs(v, b, { where: `--param ${k}` })]));
    }
    // #140 order: fixture setup (above) → open the browser (#137 launch options, #118 storageState) → run → restore.
    // #250/#251: a recorded or screenshotted run carries the live pixel mask from its first paint.
    const secrets = secretParamValues(journey, params);
    const mask = opts.mask ?? new SecretPixelMask(secrets);
    const capturing = opts.session === undefined && (opts.browser?.recordVideo !== undefined || opts.screenshots !== undefined);
    const openPort = (): BrowserPort => {
      const rawPort = (opts.browserPortFactory ?? (() => new PlaywrightBrowserPort()))();
      return capturing ? maskingPort(rawPort, mask) : rawPort;
    };
    const artifactName = `journey-${opts.id.replace(/[^A-Za-z0-9._-]/g, "_")}-${artifactStamp(clock.nowIso())}.json`;
    // #245: `--record-video` → `journey-<id>-<stamp>.videos/` under the given dir, else the logs dir.
    const videoDir =
      opts.browser?.recordVideo === undefined || opts.session !== undefined
        ? undefined
        : runVideoDir(opts.browser, join(opts.browser.recordVideo.dir ?? logsDirFor(), artifactName));
    const flat = flatJourneySteps(journey);
    const shots =
      opts.screenshots === undefined || opts.session !== undefined
        ? undefined
        : new RunScreenshots({
            spec: opts.screenshots,
            dir: screenshotsDirFor(opts.screenshots, join(logsDirFor(), artifactName)),
            secrets,
            title: `journey ${journey.metadata.name}`,
            mask,
          });
    const whatOf = (i: number): string => {
      const s = flat[i];
      if (s === undefined) return `step ${i + 1}`;
      const pick = [s.recorded.objective, s.recorded.step.label].map((t) => (t ?? "").trim()).find((t) => t !== "");
      return pick ?? describeStep(s.recorded.step);
    };
    // #293: a given session is the caller's — replayed into, never opened or closed here.
    const session =
      opts.session ??
      (await openPort().open({
        ...sessionLaunchOptions(opts.browser, videoDir),
        allowedOrigins,
        baseUrl: journey.recording.site,
        ...opts.emulation,
        ...(opts.storageState !== undefined ? { storageState: opts.storageState } : {}),
      }));
    const closeSession = opts.session === undefined ? closeOnce(() => session.close()) : async (): Promise<void> => undefined;
    try {
      const actor = CastActor.named("cli-runner").whoCan(
        new BrowseTheWeb(session, allowedOrigins),
        ...gate.abilities,
      );
      const replayDeltas = opts.actionDeltas === true ? new ReplayDeltas({ secrets, recorded: flat.map((f) => f.recorded) }) : undefined;
      const observer = composeObservers(
        replayDeltas?.observer(),
        opts.observer,
        shots === undefined ? undefined : screenshotObserver(shots, (a) => a.ability(BrowseTheWebToken).session.page, whatOf),
      );
      const interpreter = opts.interpreter ?? (opts.observer === undefined && shots === undefined && replayDeltas === undefined ? new RecordingInterpreter() : new RecordingInterpreter({ observer }));
      const runner = new JourneyRunner(actor, interpreter, undefined, undefined, opts.selfHealer);
      let result: JourneyRunResult;
      try {
        // #322: a full replay (never an anchored prefix) must also satisfy the Journey's network checks.
        const networkChecks = journey === full ? journey.metadata.networkChecks : undefined;
        result = redactSecretParams(
          await withNetworkChecks(session.page, networkChecks, () => runner.run({ journey, params, policy })),
          journey,
          params,
        );
      } finally {
        await gate.done();
      }
      const shotFields = shots === undefined ? {} : await shots.finish();
      const deltaFields = replayDeltas === undefined ? {} : { actionDeltas: redactSecretParams(replayDeltaSummary(replayDeltas), journey, params) };
      // #245: the context closed (its video finalized) before the result naming it is returned.
      const videos = await finalizeVideos(videoDir, closeSession);
      if (fx === undefined) return { ...result, ...videos, ...shotFields, ...deltaFields };
      await fx.restore();
      // #399: a fixture output passed in as a secret param (`--param t='${setup.t}'`) is redacted here too.
      return { ...result, ...videos, ...shotFields, ...deltaFields, fixtures: redactSecretParams(fx.record(), journey, params) };
    } finally {
      await closeSession();
    }
  } catch (err) {
    // #399: an error escaping the run (a crash, a closed page) may echo a navigated URL that
    // carried a secret parameter — its message and stack are redacted, its class kept.
    throw redactErrorSecrets(err, secretParamValues(journey, { ...inputParams, ...params }));
  } finally {
    await fx?.restore();
  }
}

/** `err` with every secret (and its URL-encoded forms) masked in its message and stack — same object, same class. */
export function redactErrorSecrets(err: unknown, secrets: readonly string[]): unknown {
  if (!(err instanceof Error) || secrets.length === 0) return err;
  err.message = redactText(err.message, secrets);
  if (err.stack !== undefined) err.stack = redactText(err.stack, secrets);
  return err;
}
