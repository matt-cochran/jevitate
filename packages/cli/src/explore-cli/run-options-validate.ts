// run-options-validate.ts — the flag validation/normalisation stage of `jevitate explore`.
import { Command } from "commander";
import { type TargetDescriptor } from "@jevitate/recording";
import { ok, fail, type JsonEnvelope } from "../envelope.js";
import { SessionFileInProjectError, assertSessionFileOutsideProject } from "../project-dir.js";
import { parseScreenshotsArg, type ScreenshotsSpec } from "../run-screenshots.js";
import { secretFieldErrorOf, warnSecretParamsOnArgv, withCommandSecretParams } from "../secret-params.js";
import { LITERAL_SECRET_WARNING, SecretArgError, resolveSecretArgs } from "../secret-args.js";
import { withEngine } from "../engine.js";
import { EXIT_CODES } from "../exit-codes.js";
import { resolveExploreAllowlist } from "../explore-api.js";
import { wantsMultiRun, type Persona } from "../multi-run.js";
import { authExpiredResult, ensurePersonaSession, LoginArgsError, parseAuthCheck, type AuthCheck, type AuthExpiredResult } from "../persona-login.js";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { type CliDeps, browserRunFromFlags, commandSecretSeams, environmentSeams, resolveDbPath, resolveJourneysDir, resolveMissionTargetsDir, EXPLORE_STRATEGIES } from "../cli-shared.js";
import { allowWithExtensions, assertExtensionTargetLoaded, multiWindowWarning } from "../browser-run-options.js";
import { ParamValidationError } from "@jevitate/journey";
import { SiteGateRefusedError } from "@jevitate/runtime";
import { JourneyRequiresAuthError, UnknownJourneyError } from "../journey-api.js";
import { environmentFromFlags, isEnvironmentError } from "../environments.js";
import { resolve as resolvePath } from "node:path";
import { CAMPAIGN_LIMITS, isSweepMode } from "@jevitate/journey";
import { CampaignSpecError, runCampaign, validateCampaignSpec } from "../campaign-api.js";
import { formatCampaignHuman } from "../campaign-cli.js";
import { forwardedArgv } from "../multi-run-cli.js";
import { resolveScopeRegions } from "./scope-region.js";
import { ANCHORED_STRATEGIES, JourneyPrefixArgsError, JourneyPrefixStaleError, journeyStaleResult, resolveJourneyPrefix, type JourneyPrefix } from "../journey-prefix.js";
import { GoalRunFlagError, dialogsFromFlags } from "../goal-run-flags.js";
import { AUTH_PREFLIGHT_TIMEOUT_MS, SWEEP_OWNED, fixtureBoundUrlRoot, type ExploreOpts } from "./shared.js";
import type { DialogPolicy } from "@jevitate/explore";

/** The caller-bound output rule (the explore action's `--json`/human choice). */
export type ExploreEmit = (envelope: JsonEnvelope<unknown>, exitCode?: number, human?: (data: unknown) => string) => void;

/** Everything the validation/normalisation stage resolved, before the context is built. */
export interface ValidatedExploreRun {
  readonly strategy: string;
  readonly dialogs: DialogPolicy | undefined;
  readonly authCheck: AuthCheck;
  readonly journeyPrefix: JourneyPrefix | undefined;
  readonly prefixRequest: Parameters<typeof resolveJourneyPrefix>[0] | undefined;
  readonly prefixSecretSpecs: Set<string>;
  readonly withPrefix: { journeyPrefix?: JourneyPrefix };
  readonly withScopeRegion: { scopeRegions?: TargetDescriptor[]; scopeRegionSpec?: string };
  readonly emitJourneyFailure: (err: unknown) => boolean;
  readonly browser: ReturnType<typeof browserRunFromFlags>;
  readonly screenshotsOpt: { screenshots?: ScreenshotsSpec; evidenceVideo?: boolean };
  readonly sessionPreflight: (storageState: string, persona: Persona | undefined) => Promise<AuthExpiredResult | undefined>;
}

/** Runs every flag check, refusal and normalisation, in the order the action did. */
export async function validateExploreRun(
  program: Command,
  o: ExploreOpts,
  deps: CliDeps,
  buildProgram: (deps: CliDeps) => Command,
  command: Command,
  emitExplore: ExploreEmit,
): Promise<ValidatedExploreRun | undefined> {
  const basics = await checkExploreArgs(program, o, deps, emitExplore);
  if (basics === undefined) return;
  const anchor = await resolveExploreAnchor(o, program, deps, buildProgram, command, emitExplore, basics.strategy);
  if (anchor === undefined) return;
  const scope = await resolveExploreScopeRegion(o, emitExplore, basics.strategy, anchor.journeyPrefix);
  if (scope === undefined) return;
  const capture = await resolveExploreSecretsAndCapture(o, program, deps, emitExplore, basics.strategy, basics.authCheck, anchor.journeyPrefix);
  if (capture === undefined) return;
  return {
    strategy: basics.strategy,
    dialogs: basics.dialogs,
    authCheck: basics.authCheck,
    journeyPrefix: anchor.journeyPrefix,
    prefixRequest: anchor.prefixRequest,
    prefixSecretSpecs: anchor.prefixSecretSpecs,
    withPrefix: scope.withPrefix,
    withScopeRegion: scope.withScopeRegion,
    emitJourneyFailure: scope.emitJourneyFailure,
    browser: capture.browser,
    screenshotsOpt: capture.screenshotsOpt,
    sessionPreflight: capture.sessionPreflight,
  };
}

/** The first checks: unknown strategy, --dialogs, --auth-check, --save-storage-state, --render-wait-ms, --scope-region. */
async function checkExploreArgs(
  program: Command,
  o: ExploreOpts,
  deps: CliDeps,
  emitExplore: ExploreEmit,
): Promise<{ strategy: string; dialogs: DialogPolicy | undefined; authCheck: AuthCheck } | undefined> {
  // #230: an unknown --strategy must be refused before any other required-option message — it
  // would otherwise fall through to the default goal-strategy path and silently run a goal
  // mission. Checked first, ahead of every other validation below.
  if (o.strategy !== undefined && !EXPLORE_STRATEGIES.includes(o.strategy as (typeof EXPLORE_STRATEGIES)[number])) {
    emitExplore(fail("E_EXPLORE_ARGS", `unknown strategy ${JSON.stringify(o.strategy)} (one of ${EXPLORE_STRATEGIES.join(", ")})`));
    return;
  }
  // #334: a mistyped --dialogs never silently means "dismiss".
  let dialogs: DialogPolicy | undefined;
  try {
    dialogs = dialogsFromFlags(o);
  } catch (err) {
    if (!(err instanceof GoalRunFlagError)) throw err;
    emitExplore(fail(err.code, err.message));
    return;
  }

  // #427: an unusable --auth-check is a usage error, refused before anything runs.
  let authCheck: AuthCheck;
  try {
    authCheck = parseAuthCheck(o.authCheck);
  } catch (err) {
    if (!(err instanceof LoginArgsError)) throw err;
    emitExplore(fail("E_EXPLORE_ARGS", err.message));
    return;
  }

  // #195: a session file never lands in the repo's .jevitate/ (refused before any run, multi-runs included).
  if (o.saveStorageState !== undefined) {
    try {
      assertSessionFileOutsideProject(o.saveStorageState, "--save-storage-state");
    } catch (err) {
      if (!(err instanceof SessionFileInProjectError)) throw err;
      emitExplore(fail(err.code, err.message));
      return;
    }
  }
  const strategy = o.strategy ?? "goal";
  if (o.renderWaitMs !== undefined && (strategy !== "goal" || o.feature !== undefined)) {
    emitExplore(fail("E_EXPLORE_ARGS", "--render-wait-ms is supported only with --strategy goal (including find-out runs)"));
    return;
  }
  // #519: --scope-region on a strategy without a coverage gate, or one that does not parse, is refused up front
  // (also ahead of a --at-step sweep, whose per-stop runs would each refuse it).
  try {
    resolveScopeRegions({ scopeRegion: o.scopeRegion, strategy, ...(o.feature === undefined ? {} : { feature: o.feature }), ...(o.goal === undefined ? {} : { goal: o.goal }) });
  } catch (err) {
    emitExplore(fail("E_EXPLORE_ARGS", err instanceof Error ? err.message : String(err)));
    return;
  }
  return { strategy, dialogs, authCheck };
}

/** #293: the journey-anchored exploration branch (the sweep campaign or the single prefix). */
async function resolveExploreAnchor(
  o: ExploreOpts,
  program: Command,
  deps: CliDeps,
  buildProgram: (deps: CliDeps) => Command,
  command: Command,
  emitExplore: ExploreEmit,
  strategy: string,
): Promise<{ journeyPrefix: JourneyPrefix | undefined; prefixRequest: Parameters<typeof resolveJourneyPrefix>[0] | undefined; prefixSecretSpecs: Set<string> } | undefined> {
  // #293 journey-anchored exploration: the Journey, step, params and environment are resolved (and
  // refused, exit 64) before anything else — the start URL every later check uses is where the
  // Journey's prefix lands.
  let journeyPrefix: JourneyPrefix | undefined;
  /** #399: how the prefix was resolved — re-resolved once `${setup.x}` in a --param is bound (goal + --fixtures). */
  let prefixRequest: Parameters<typeof resolveJourneyPrefix>[0] | undefined;
  /** #827: the --secret-field specs the Journey prefix took: a goal loop keeps a field one, never a param= one. */
  let prefixSecretSpecs = new Set<string>();
  const anchoredFlags = [o.fromJourney, o.atStep, o.journeysDir, o.env, o.baseUrl].some((v) => v !== undefined);
  if (anchoredFlags || Object.keys(o.param).length > 0) {
    const refuse = (message: string): void => emitExplore(fail("E_EXPLORE_ARGS", message));
    if (o.fromJourney === undefined || o.atStep === undefined) {
      refuse("--from-journey and --at-step go together (and --param, --env, --base-url and --journeys-dir need them)");
      return;
    }
    await warnSecretParamsOnArgv(program.configureOutput().writeErr, resolveJourneysDir(deps, o.journeysDir), [o.fromJourney], o.param, "explore --from-journey");
    if (o.url !== undefined) {
      refuse("--url cannot be combined with --from-journey: the mission starts where the Journey's prefix leaves the page");
      return;
    }
    if (o.feature !== undefined || !(ANCHORED_STRATEGIES as readonly string[]).includes(strategy)) {
      refuse(`--from-journey supports --strategy ${ANCHORED_STRATEGIES.join(", ")} (not --feature)`);
      return;
    }
    if (wantsMultiRun(o) || o.actor.length > 0) {
      refuse("--from-journey runs one anchored mission: --repeat, --persona, --personas and --actor are not supported with it (a campaign runs several)");
      return;
    }
    // #293 sweep: `--at-step all|anchors` runs the strategy from EVERY step (or anchor), each in a
    // fresh session with --fixtures restored around it, --max-actions/--max-decisions split evenly
    // over the stop points, and reads them as one deduped report (a one-job campaign).
    // #312: one anchored step with a state restore (--fixtures/--before/--after) on a non-goal
    // strategy runs the same way — as a one-stop campaign, whose runner restores around the run.
    const restoredSingle =
      !isSweepMode(o.atStep) && strategy !== "goal" && (o.fixtures !== undefined || o.before !== undefined || o.after !== undefined);
    if ((isSweepMode(o.atStep) || restoredSingle) && Object.values(o.param).some((v) => v.includes("${setup."))) {
      refuse("a --param holding ${setup.x} is bound from --fixtures only by a single --strategy goal run; pass the value itself here");
      return;
    }
  if (isSweepMode(o.atStep) || restoredSingle) {
    await runExploreSweep(o, deps, buildProgram, command, emitExplore, strategy, restoredSingle);
    return;
  }
    try {
      const environment = environmentFromFlags(
        { ...(o.env === undefined ? {} : { env: o.env }), ...(o.baseUrl === undefined ? {} : { baseUrl: o.baseUrl }) },
        environmentSeams(deps),
      );
      // The environment's own session applies when --storage-state names none (as `journey run`).
      if (o.storageState === undefined && environment?.storageState !== undefined) o.storageState = environment.storageState;
      // #827: the prefix's secret parameters from the environment: a --secret-field that binds one (a recorded
      // field, or param=<name>), and with --env/--base-url the environment's targets.json secretFields.
      const prefixSecrets = await withCommandSecretParams({ dir: resolveJourneysDir(deps, o.journeysDir), ids: [o.fromJourney], params: o.param, flags: o.secretField, environment, env: deps.explore?.env ?? process.env, seams: commandSecretSeams(deps, resolveJourneysDir(deps, o.journeysDir)), strict: false });
      prefixSecretSpecs = new Set(prefixSecrets.used);
      prefixRequest = {
        dir: resolveJourneysDir(deps, o.journeysDir),
        id: o.fromJourney,
        atStep: o.atStep,
        params: prefixSecrets.params,
        ...(prefixSecrets.bound === undefined ? {} : { boundSecretParams: prefixSecrets.bound }),
        ...(environment === undefined ? {} : { environment }),
        ...(o.storageState === undefined ? {} : { storageState: o.storageState }),
        dbPath: resolveDbPath(deps),
        environmentFlags: { ...(o.env === undefined ? {} : { env: o.env }), ...(o.baseUrl === undefined ? {} : { baseUrl: o.baseUrl }) },
      };
      journeyPrefix = await resolveJourneyPrefix(prefixRequest);
    } catch (err) {
      const secretError = secretFieldErrorOf(err, "E_EXPLORE_ARGS");
      if (secretError !== undefined) emitExplore(fail(secretError.code, secretError.message));
      else if (isEnvironmentError(err) || err instanceof JourneyPrefixArgsError) emitExplore(fail(err.code, err.message));
      else if (err instanceof UnknownJourneyError) emitExplore(fail("E_UNKNOWN_JOURNEY", err.message));
      else if (err instanceof ParamValidationError) emitExplore(fail("E_INVALID_PARAMS", err.message));
      else if (err instanceof JourneyRequiresAuthError) emitExplore(fail("E_JOURNEY_REQUIRES_AUTH", err.message));
      else emitExplore(fail("E_EXPLORE_ARGS", err instanceof Error ? err.message : String(err)));
      return;
    }
    // The prefix types its secret params into the page the mission perceives: they are redacted like
    // --secret. Coverage/exploratory carry no redaction set, so a prefix with secrets refuses them.
    if (journeyPrefix.secrets.length > 0 && (strategy === "coverage" || strategy === "exploratory")) {
      refuse(`journey '${o.fromJourney}' types a secret param before step ${journeyPrefix.branch.step}: --strategy ${strategy} cannot redact it — use goal, adversarial or usability`);
      return;
    }
    o.url = journeyPrefix.startUrl;
    // Default allowlist: the origins the Journey's steps may be on (the environment's), not just the landing's.
    if (o.allow.length === 0) o.allow = [...journeyPrefix.allowedOrigins];
  }
  return { journeyPrefix, prefixRequest, prefixSecretSpecs };
}

/** #293/#312: the --at-step sweep (or the restored single anchored step) runs as a one-job campaign. */
async function runExploreSweep(
  o: ExploreOpts,
  deps: CliDeps,
  buildProgram: (deps: CliDeps) => Command,
  command: Command,
  emitExplore: ExploreEmit,
  strategy: string,
  restoredSingle: boolean,
): Promise<void> {
  // The caller has already refused a sweep without both; the guard keeps the types narrowed here.
  if (o.fromJourney === undefined || o.atStep === undefined) return;
      if (o.real !== true && o.fakeAi !== true) {
        emitExplore(fail("E_AI_SETUP_REQUIRED", "a sweep's missions are model-driven: pass --real or --fake-ai"));
        return;
      }
      const journeysDir = resolveJourneysDir(deps, o.journeysDir);
      const abs = (p: string): string => resolvePath(p);
      const spec = {
        version: 1,
        name: restoredSingle ? `${o.fromJourney} at step ${o.atStep.trim()} (${strategy}, restored)` : `sweep of ${o.fromJourney} (${o.atStep}, ${strategy})`,
        ...(o.env === undefined ? {} : { env: o.env }),
        ...(o.baseUrl === undefined ? {} : { baseUrl: o.baseUrl }),
        ...(o.storageState === undefined ? {} : { storageState: abs(o.storageState) }),
        ...(o.fixtures === undefined ? {} : { fixtures: abs(o.fixtures) }),
        ...(o.before === undefined ? {} : { before: o.before }),
        ...(o.after === undefined ? {} : { after: o.after }),
        discovery: false,
        maxRuns: CAMPAIGN_LIMITS.maxRuns,
        jobs: [
          {
            id: "sweep",
            journey: o.fromJourney,
            params: o.param,
            anchors: restoredSingle ? [o.atStep.trim()] : o.atStep.trim(),
            strategies: [strategy],
            ...(o.goal === undefined ? {} : { goal: o.goal }),
            ...(o.appClass === undefined ? {} : { appClass: o.appClass }),
            ...(o.success.length === 0 ? {} : { success: o.success }),
            ...(o.maxActions === undefined ? {} : { maxActions: Number(o.maxActions) }),
            ...(o.maxDecisions === undefined ? {} : { maxDecisions: Number(o.maxDecisions) }),
          },
        ],
      };
      try {
        const plan = await validateCampaignSpec(spec, resolvePath("explore-sweep.json"), {
          journeysDir,
          // #827: the sweep's params are this command line's (warned above), and its --secret-field bindings go to every stop.
          paramsFromArgv: true,
          secretFields: o.secretField,
          env: deps.explore?.env ?? process.env,
          allowShellHooks: o.allowShellHooks === true,
          ...(o.hookTimeoutMs === undefined ? {} : { hookTimeoutMs: Number(o.hookTimeoutMs) }),
          environmentSeams: environmentSeams(deps),
        });
        const result = await runCampaign(plan, {
          newProgram: () => buildProgram(deps),
          journeysDir,
          missionTargetsDir: resolveMissionTargetsDir(deps),
          ...(o.out === undefined ? {} : { outDir: o.out }),
          ...(o.real === true ? { real: true } : {}),
          ...(o.fakeAi === true ? { fakeAi: true } : {}),
          missionArgs: forwardedArgv(command, SWEEP_OWNED),
        });
        emitExplore(ok(withEngine({ sweep: { journeyId: o.fromJourney, mode: restoredSingle ? "step" : o.atStep.trim(), ...(restoredSingle ? { atStep: o.atStep.trim() } : {}), strategy, stops: plan.totalRuns, budgetPerStop: { maxActions: plan.jobs[0]?.maxActions, ...(plan.jobs[0]?.maxDecisions === undefined ? {} : { maxDecisions: plan.jobs[0].maxDecisions }) } }, ...result })), result.exitCode, formatCampaignHuman);
      } catch (err) {
        if (err instanceof CampaignSpecError) emitExplore(fail("E_EXPLORE_ARGS", err.message));
        else emitExplore(fail("E_EXPLORE_RUN", String(err instanceof Error ? err.message : err)));
      }
      return;
}

/** #519: the scope region (the anchor's or --scope-region's), plus the prefix-failure translator. */
async function resolveExploreScopeRegion(
  o: ExploreOpts,
  emitExplore: ExploreEmit,
  strategy: string,
  journeyPrefix: JourneyPrefix | undefined,
): Promise<{ withPrefix: { journeyPrefix?: JourneyPrefix }; withScopeRegion: { scopeRegions?: TargetDescriptor[]; scopeRegionSpec?: string }; emitJourneyFailure: (err: unknown) => boolean } | undefined> {
  const withPrefix = journeyPrefix === undefined ? {} : { journeyPrefix };
  // #519: the scope region — the anchor's (authoritative) or --scope-region's — resolved and refused before any browser opens.
  let withScopeRegion: { scopeRegions?: TargetDescriptor[]; scopeRegionSpec?: string };
  try {
    const region = resolveScopeRegions({ scopeRegion: o.scopeRegion, strategy, ...(o.feature === undefined ? {} : { feature: o.feature }), ...(o.goal === undefined ? {} : { goal: o.goal }) }, journeyPrefix);
    withScopeRegion = region === undefined ? {} : { scopeRegions: region.descriptors, scopeRegionSpec: region.spec };
  } catch (err) {
    emitExplore(fail("E_EXPLORE_ARGS", err instanceof Error ? err.message : String(err)));
    return;
  }
  /** #293: a prefix that no longer replays, or a site policy that refused it — typed, handled once for every strategy. */
  const emitJourneyFailure = (err: unknown): boolean => {
    if (err instanceof JourneyPrefixStaleError) {
      emitExplore(ok(withEngine(journeyStaleResult(err, strategy))), EXIT_CODES.inconclusive);
      return true;
    }
    if (err instanceof SiteGateRefusedError) {
      emitExplore(fail(err.code, err.message));
      return true;
    }
    return false;
  };
  return { withPrefix, withScopeRegion, emitJourneyFailure };
}

/** #195/#245/#251/#427: secrets, the browser launch, screenshots and the per-session auth preflight. */
async function resolveExploreSecretsAndCapture(
  o: ExploreOpts,
  program: Command,
  deps: CliDeps,
  emitExplore: ExploreEmit,
  strategy: string,
  authCheck: AuthCheck,
  journeyPrefix: JourneyPrefix | undefined,
): Promise<{ browser: ReturnType<typeof browserRunFromFlags>; screenshotsOpt: { screenshots?: ScreenshotsSpec; evidenceVideo?: boolean }; sessionPreflight: (storageState: string, persona: Persona | undefined) => Promise<AuthExpiredResult | undefined> } | undefined> {
  // #195: `--secret env:VAR` is resolved from the environment before anything runs (fail closed).
  try {
    const resolved = resolveSecretArgs(o.secret, process.env, "--secret");
    if (resolved.literals > 0) program.configureOutput().writeErr?.(LITERAL_SECRET_WARNING);
    o.secret = [...resolved.secrets, ...(journeyPrefix?.secrets ?? [])];
    // These two carry no redaction set: the value would reach the model and the transcript.
    if (o.secret.length > 0 && o.feature === undefined && (strategy === "coverage" || strategy === "exploratory")) {
      emitExplore(fail("E_EXPLORE_SECRET_UNSUPPORTED", `--strategy ${strategy} can't keep a --secret out of its model calls and transcript, so nothing ran. Use goal, adversarial or usability, which mask it, or leave the value off the page`));
      return;
    }
  } catch (err) {
    if (!(err instanceof SecretArgError)) throw err;
    emitExplore(fail("E_EXPLORE_ARGS", err.message));
    return;
  }
  // #245 demo mode: resolved (and a headed run without a display refused, exit 64) before any
  // browser opens — a multi-run's every run re-resolves the same flags.
  let browser: ReturnType<typeof browserRunFromFlags>;
  try {
    browser = browserRunFromFlags(o, deps.explore?.env ?? process.env);
    // #256: a chrome-extension:// --url must be a loaded extension's; loaded extensions' origins are allowed.
    assertExtensionTargetLoaded(o.url, browser);
    o.allow = allowWithExtensions(o.url, o.allow, browser);
  } catch (err) {
    emitExplore(fail("E_EXPLORE_ARGS", err instanceof Error ? err.message : String(err)));
    return;
  }
  // #251: an unusable --screenshots value is a usage error (64), refused before any browser opens.
  let screenshots: ScreenshotsSpec | undefined;
  try {
    screenshots = parseScreenshotsArg(o.screenshots);
  } catch (err) {
    emitExplore(fail("E_EXPLORE_ARGS", err instanceof Error ? err.message : String(err)));
    return;
  }
  // #251/#250: the capture options every strategy's runner takes.
  const screenshotsOpt = { ...(screenshots === undefined ? {} : { screenshots }), ...(o.evidenceVideo === true ? { evidenceVideo: true } : {}) };
  if (browser?.headed === true && (wantsMultiRun(o) || o.actor.length > 1)) {
    program.configureOutput().writeErr?.(multiWindowWarning(o.actor.length > 1 ? "several --actor sessions" : "--repeat/--persona"));
  }
  /**
   * #427: the pre-flight auth check of one session — undefined when it is alive (or refreshed, or
   * not checked: --auth-check off, no --url, a --from-journey run whose prefix replay is its own
   * check), or the `auth-expired` result when it is not. Throws `UnauthorizedExploreTargetError`.
   */
  const sessionPreflight = async (storageState: string, persona: Persona | undefined): Promise<AuthExpiredResult | undefined> => {
    if (authCheck.mode === "off" || o.url === undefined || journeyPrefix !== undefined) return undefined;
    const allowlist = resolveExploreAllowlist(o.url, o.allow);
    // A start URL bound from --fixtures (`${setup.x}`) does not exist before the setup runs: the
    // check opens the app's root instead (the mission itself starts after the setup, as before).
    const checkUrl = o.url.includes("${") ? fixtureBoundUrlRoot(o.url) : o.url;
    if (checkUrl === undefined) return undefined; // no origin before the placeholder: the mission's own URL check refuses it
    const r = await ensurePersonaSession({
      ...(persona === undefined ? {} : { persona: persona.name }),
      ...(persona?.login === undefined ? {} : { login: persona.login }),
      storageState,
      url: checkUrl,
      allowlist,
      check: authCheck,
      port: (deps.explore?.browserPortFactory ?? (() => new PlaywrightBrowserPort()))(),
      ...(browser === undefined ? {} : { browser }),
      env: deps.explore?.env ?? process.env,
      timeoutMs: AUTH_PREFLIGHT_TIMEOUT_MS,
      note: (line) => program.configureOutput().writeErr?.(line),
    });
    return r.ok ? undefined : authExpiredResult(strategy, o.url, r, persona?.name);
  };
  return { browser, screenshotsOpt, sessionPreflight };
}
