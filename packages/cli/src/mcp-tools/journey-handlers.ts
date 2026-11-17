import { SiteGateRefusedError, type ChangeScope, type SelfHealer } from "@jevitate/runtime";
import { findCapabilities, JourneyRunRefusedError } from "@jevitate/mcp-facade";
import { FsJourneyStore, JourneyRegistry, ParamValidationError, type Journey } from "@jevitate/journey";
import type { GenerationPort, UsageTracker } from "@jevitate/ai-core";
import type { EmulationSpec } from "@jevitate/playwright";
import { safeRunPolicy as defaultRunPolicy, type RunPolicy, type SelfHealMode } from "@jevitate/domain";
import { existsSync } from "node:fs";
import { capabilityParameters } from "../journey-find-api.js";
import { stampRunMetadata, withRunMetadata } from "../run-metadata.js";
import { JourneyRequiresAuthError, UnknownJourneyError } from "../journey-api.js";
import { ExtensionMismatchError, type BrowserRunOptions } from "../browser-run-options.js";
import { browserRunFromFlags, emulationFromFlags } from "../cli-shared.js";
import { environmentFromFlags, isEnvironmentError, type ResolvedJourneyEnvironment } from "../environments.js";
import { buildMissionFixtures, checkSetupRefs } from "../fixture-cli.js";
import { BoundSecretOutsideFieldError, SecretFieldAmbiguousError, secretParamRefusalBody, secretParamsCarried, withSecretParams } from "../secret-params.js";
import { mcpMayBindTargetSecrets, resolveRunTarget, RunModeRefusedError, runModeRefusalBody } from "../journey-run-mode-gate.js";
import { ParamTypeError, paramTypeRefusalBody } from "../journey-param-types.js";
import { heldOutcomeOf } from "../journey-hold.js";
import { FixtureSetupError, FixtureSpecError, UnboundSetupRefError, type MissionFixtures } from "../mission-fixtures.js";
import { parseScreenshotsArg, type ScreenshotsSpec } from "../run-screenshots.js";
import { makeEvidenceSelfHealer } from "../self-heal-adapter.js";
import { JourneyHealArgsError, MCP_HEAL_NAMES, journeyHealBudget, readJourneyChangeScope, validateJourneyHeal, type JourneyHealRequest } from "../journey-heal.js";
import { ChangesArgsError, ChangesInputError } from "../change-context.js";
import { MAX_STEP_RESPONSE_TIMEOUT_MS } from "../journey-network-checks.js";
import { McpArgError, argErrorBody, optBool, optEnum, optInt, optNamedSessions, optPath, optExtensions, optRecordVideo, optScreenshots, optString, optStringArray, optStringMap, optViewport } from "../mcp-args.js";
import { resourcePreflight } from "../resource-preflight.js";
import { runRecordErrorOf } from "../journey-run-record.js";
import { RunGuardRefusedError, runGuardRefusalBody } from "../mcp-run-guard.js";
import { loadCatalog, resolveCatalogDir } from "../catalog-api.js";
import { linkedJobDone } from "../catalog-refs.js";
import type { McpToolCtx } from "./shared.js";
import { jsonResult, errorResult, governanceArgs, withJourneyExitCode, SetupRequired, redactCredentials, tagsArg } from "./shared.js";
import type { McpJourneyRunOptions, McpToolResult } from "../mcp-api.js";

/** What a resolved `run_journey` request carries into the runner. */
interface ResolvedJourneyRun {
  params: Record<string, string>;
  storageState?: string;
  options: McpJourneyRunOptions;
  usage?: UsageTracker;
}

/** `find_capabilities`: promoted Journeys matching a query, with #796 typed parameters and #800 linked job done. */
export async function findCapabilitiesTool(ctx: McpToolCtx, args: Record<string, unknown>): Promise<McpToolResult> {
  const { deps } = ctx;
  const baseFindCaps =
    deps.findCapabilities ??
    ((query: string) => findCapabilities(new JourneyRegistry(new FsJourneyStore(deps.journeysDir)), query));
  return jsonResult(await findCaps(deps.journeysDir, baseFindCaps, typeof args.query === "string" ? args.query : ""));
}

/**
 * #800: each capability that links a catalog job carries `job: { id, status, done?: { at, check } }`,
 * the job's done check as stored (placeholders, never values). Best effort: no project or an
 * unreadable catalog leaves the capability as it was.
 */
async function findCaps(
  journeysDir: string,
  baseFindCaps: (query: string) => Promise<unknown>,
  query: string,
): Promise<unknown> {
  const caps = await baseFindCaps(query);
  if (!Array.isArray(caps) || caps.length === 0) return caps;
  const store = new FsJourneyStore(journeysDir);
  // #796: each capability lists its typed parameters (type, enum values); untyped ones add nothing.
  const withParameters = await Promise.all(
    caps.map(async (c: unknown) => {
      try {
        const id = c !== null && typeof c === "object" ? (c as { id?: unknown }).id : undefined;
        const parameters = capabilityParameters(typeof id === "string" ? await store.get(id) : null);
        return parameters === undefined ? c : { ...(c as object), parameters };
      } catch {
        return c;
      }
    }),
  );
  try {
    const catalog = await loadCatalog(resolveCatalogDir(undefined), journeysDir);
    return await Promise.all(
      withParameters.map(async (c: unknown) => {
        const id = c !== null && typeof c === "object" ? (c as { id?: unknown }).id : undefined;
        const journey = typeof id === "string" ? await store.get(id) : null;
        const job = journey === null ? undefined : linkedJobDone(catalog, journey);
        return job === undefined ? c : { ...(c as object), job };
      }),
    );
  } catch {
    return withParameters;
  }
}

/** `run_journey`: the CLI-parity run of a PUBLISHED Journey (the tool's handler body). */
export async function runJourneyTool(ctx: McpToolCtx, args: Record<string, unknown>): Promise<McpToolResult> {
  const { deps, runJourney } = ctx;
  if (typeof args.id !== "string" || args.id.length === 0) {
    return errorResult({ error: "invalid_args", message: "run_journey requires a non-empty string 'id'" });
  }
  const tagged = tagsArg(args);
  if ("error" in tagged) return errorResult(tagged.error);
  // Before the value reaches anything: a secret parameter's value never travels through a request.
  const carried = await secretParamsCarried(deps.journeysDir, [args.id], args.params);
  if (carried.length > 0) return errorResult(secretParamRefusalBody(carried));
  // A secret the request leaves out: refused below unless the operator's targets.json supplies it (§5.3).
  const needed = await secretParamsCarried(deps.journeysDir, [args.id], args.params, { needed: true });
  // Invariant #5: only id + params (+ a storageState PATH and the run options below) are
  // threaded through — any inline `steps`/`recording` in the arguments is deliberately ignored.
  const resolved = await resolveRunArgs(ctx, args);
  if ("response" in resolved) return resolved.response;
  let run = resolved.resolved;
  if (needed.length > 0) {
    const supplied = await secretsFromTargets(ctx, args.id, needed, run);
    if ("refusal" in supplied) return errorResult(supplied.refusal);
    run = { ...run, params: supplied.params, options: supplied.options };
  }
  // #205: the same pre-run checks as `jevitate journey run` (orphan sweep, starved-host refusal).
  const starved = await resourcePreflight({});
  if (starved !== null) return errorResult({ error: "refused", code: starved.error?.code, message: starved.error?.message });
  try {
    const id = args.id;
    const result = await withRunMetadata({ tags: tagged.tags }, () => runJourney(id, run.params, run.storageState, run.options));
    // #163: a self-healing run's model usage lands on its result, as on the CLI. #426: so do its tags.
    const withUsage = run.usage === undefined || result === null || typeof result !== "object" ? result : { ...result, usage: run.usage.snapshot() };
    // #453: the CLI's exit code for the outcome — 0 ok, 5 healed-pending-review (a proposed revision, never a pass), 1 otherwise.
    return jsonResult(stampRunMetadata(withJourneyExitCode(withUsage), { tags: tagged.tags }));
  } catch (err) {
    const mapped = runJourneyFailure(err, args.id);
    if (mapped !== undefined) return mapped;
    throw err;
  }
}

/** The refusal (or rethrow) for a failed `run_journey`: every typed error keeps its original body. */
function runJourneyFailure(err: unknown, id: string): McpToolResult | undefined {
  // #790: a record that could not be written is reported beside the answer, never instead of it.
  const recordProblem = runRecordErrorOf(err);
  const failed = (body: Record<string, unknown>) => errorResult(recordProblem === undefined ? body : { ...body, runRecordError: recordProblem });
  // A site-policy refusal (throttle, budget, quiet hours) is an answer the agent acts on — when to retry.
  if (err instanceof SiteGateRefusedError) {
    return failed({ error: "throttled", reason: err.reason, retryAfter: err.retryAfter, message: err.message });
  }
  if (err instanceof RunGuardRefusedError) return failed(runGuardRefusalBody(err));
  // 0.30.0 §5.4: the run is held for a person (`jevitate inbox approve <holdId>` at a terminal); it proves nothing yet.
  const held = heldOutcomeOf(err);
  if (held !== undefined) return failed({ ...held, retryable: false, exitCode: 2 });
  // 0.30.0 §5: the run mode refused it (an approval no person made on an automation target; a human step in test mode).
  if (err instanceof RunModeRefusedError) return failed(runModeRefusalBody(err));
  // #796: a parameter not of its declared type (names and expected types, never a value).
  if (err instanceof ParamTypeError) return failed(paramTypeRefusalBody(err));
  if (err instanceof JourneyRunRefusedError) return failed({ error: "refused", outcome: "refused", code: err.code, id, message: err.message, fix: err.fix, tryDraft: err.tryDraft, retryable: false });
  if (err instanceof UnknownJourneyError) return failed({ error: "not_found", id, message: err.message });
  if (err instanceof JourneyRequiresAuthError) return failed({ error: "invalid_args", code: "E_JOURNEY_REQUIRES_AUTH", message: err.message });
  if (err instanceof ExtensionMismatchError) return failed({ error: "invalid_args", code: err.code, message: err.message });
  if (err instanceof ParamValidationError) return failed({ error: "invalid_args", code: "E_INVALID_PARAMS", message: err.message });
  if (isEnvironmentError(err) || err instanceof FixtureSpecError || err instanceof UnboundSetupRefError) {
    return failed({ error: "invalid_args", code: err.code, message: err.message });
  }
  // Never run on unknown state: inconclusive (exit 2) — proves nothing, so an error result.
  if (err instanceof FixtureSetupError) {
    return failed({ outcome: "inconclusive", reason: err.message, failure: { kind: "configuration", message: err.message }, attribution: "configuration", exitCode: 2 });
  }
  return undefined;
}

/** `run_journey`'s option resolution, wrapped: a typed refusal becomes an error result, not a throw. */
async function resolveRunArgs(
  ctx: McpToolCtx,
  args: Record<string, unknown>,
): Promise<{ resolved: ResolvedJourneyRun } | { response: McpToolResult }> {
  try {
    return { resolved: await resolveJourneyRun(ctx, args) };
  } catch (err) {
    const body = argErrorBody(err) ?? (isEnvironmentError(err) ? { error: "invalid_args", code: err.code, message: err.message } : undefined);
    if (body !== undefined) return { response: errorResult(body) };
    if (err instanceof JourneyHealArgsError || err instanceof ChangesArgsError || err instanceof ChangesInputError) {
      return { response: errorResult({ error: "invalid_args", code: err.code, message: err.message }) };
    }
    if (err instanceof SetupRequired) return { response: errorResult({ error: "setup_required", message: err.message }) };
    throw err;
  }
}

/**
 * #255: `run_journey`'s CLI-parity options, resolved exactly as `journey run` resolves its flags
 * (the same helpers: environmentFromFlags, browserRunFromFlags, parseScreenshotsArg,
 * emulationFromFlags, buildMissionFixtures) — every refusal typed, before any browser opens.
 */
async function resolveJourneyRun(ctx: McpToolCtx, args: Record<string, unknown>): Promise<ResolvedJourneyRun> {
  const { params, environment, storageState } = parseRunParams(ctx, args);
  const { browser, screenshots, emulation } = parseBrowserOptions(ctx, args);
  const { fixtures } = parseFixtures(ctx, args, environment, storageState, params);
  const extras = parseRunExtras(args);
  const { selfHealer, policy, usage, healScope } = await resolveSelfHealer(ctx, extras);
  return {
    params,
    ...(storageState === undefined ? {} : { storageState }),
    options: {
      policy,
      fixtures,
      ...(selfHealer === undefined ? {} : { selfHealer }),
      ...(healScope === undefined ? {} : { heal: { scope: healScope } }),
      ...(environment === undefined ? {} : { environment }),
      ...(browser === undefined ? {} : { browser }),
      ...(emulation === undefined ? {} : { emulation }),
      ...(screenshots === undefined ? {} : { screenshots }),
      ...(optBool(args, "actionDeltas") === true ? { actionDeltas: true } : {}),
      ...(extras.stepResponseTimeoutMs === undefined ? {} : { stepResponseTimeoutMs: extras.stepResponseTimeoutMs }),
      ...(extras.noDoneCheck ? { noDoneCheck: true } : {}),
      ...(extras.requireDoneCheck ? { requireDoneCheck: true } : {}),
    },
    ...(usage === undefined ? {} : { usage }),
  };
}

/** Params, environment and storage-state resolution (the first phase of `journey run`'s flags). */
function parseRunParams(
  ctx: McpToolCtx,
  args: Record<string, unknown>,
): { params: Record<string, string>; environment: ResolvedJourneyEnvironment | undefined; storageState: string | undefined } {
  const { deps, pathRoots } = ctx;
  // Params keep their historical leniency for a non-object (treated as none); a non-string VALUE is refused.
  const params = args.params && typeof args.params === "object" && !Array.isArray(args.params) ? (optStringMap(args, "params") ?? {}) : {};
  const envName = optString(args, "env");
  const baseUrl = optString(args, "baseUrl");
  const environment = environmentFromFlags(
    { ...(envName === undefined ? {} : { env: envName }), ...(baseUrl === undefined ? {} : { baseUrl }) },
    { ...(deps.environmentsFile === undefined ? {} : { environmentsFile: deps.environmentsFile }), ...(deps.targetsConfigPath === undefined ? {} : { targetsFile: deps.targetsConfigPath }) },
  );
  // --storage-state wins; else the environment's own session (~/.jevitate/targets.json[<origin>]).
  const storageState = optPath(args, "storageState", pathRoots, { session: true }) ?? environment?.storageState;
  if (args.storageState !== undefined && storageState !== undefined && !existsSync(storageState)) throw new McpArgError(`storage state not found: ${storageState}`);
  return { params, environment, storageState };
}

/** Browser, screenshots and emulation resolution (the second phase of `journey run`'s flags). */
function parseBrowserOptions(
  ctx: McpToolCtx,
  args: Record<string, unknown>,
): { browser: BrowserRunOptions | undefined; screenshots: ScreenshotsSpec | undefined; emulation: EmulationSpec | undefined } {
  const { pathRoots } = ctx;
  const headed = optBool(args, "headed");
  const slowMo = optInt(args, "slowMo", 0);
  const recordVideo = optRecordVideo(args, pathRoots);
  const extension = optExtensions(args, pathRoots);
  const governance = governanceArgs(args);
  let browser: BrowserRunOptions | undefined;
  let screenshots: ScreenshotsSpec | undefined;
  let emulation: EmulationSpec | undefined;
  try {
    browser = browserRunFromFlags({ browserArg: [], ...governance, ...(extension === undefined ? {} : { extension }), ...(headed === undefined ? {} : { headed }), ...(slowMo === undefined ? {} : { slowMo }), ...(recordVideo === undefined ? {} : { recordVideo }) });
    screenshots = parseScreenshotsArg(optScreenshots(args, pathRoots));
    const viewport = optViewport(args);
    const device = optString(args, "device");
    const geolocation = optString(args, "geolocation");
    emulation = emulationFromFlags({ ...(viewport === undefined ? {} : { viewport }), ...(device === undefined ? {} : { device }), ...(geolocation === undefined ? {} : { geolocation }) });
  } catch (err) {
    if (err instanceof McpArgError || argErrorBody(err) !== undefined) throw err;
    throw new McpArgError(err instanceof Error ? err.message : String(err));
  }
  return { browser, screenshots, emulation };
}

/** Fixture flags resolution (the third phase; the returned closure runs at replay time). */
function parseFixtures(
  ctx: McpToolCtx,
  args: Record<string, unknown>,
  environment: ResolvedJourneyEnvironment | undefined,
  storageState: string | undefined,
  params: Record<string, string>,
): { fixtures: (site: string) => MissionFixtures | undefined } {
  const { pathRoots } = ctx;
  const fixturesFile = optPath(args, "fixtures", pathRoots);
  const fixtureIdentity = optNamedSessions(args, "fixtureIdentity", pathRoots);
  // The environment's hooks apply as on the CLI; they need --allow-shell-hooks, which MCP never sets.
  const fixtureFlags = {
    ...(fixturesFile === undefined ? {} : { fixtures: fixturesFile }),
    ...(fixtureIdentity === undefined ? {} : { fixtureIdentity }),
    ...(environment?.hooks?.before === undefined ? {} : { before: environment.hooks.before }),
    ...(environment?.hooks?.after === undefined ? {} : { after: environment.hooks.after }),
  };
  const fixtures = (site: string): MissionFixtures | undefined => {
    const fx = buildMissionFixtures(fixtureFlags, {
      allowlist: environment === undefined ? [site] : environment.allowedOrigins,
      baseUrl: site,
      ...(storageState !== undefined ? { storageState } : {}),
      ...(environment?.fixtures === undefined ? {} : { targetFixtures: environment.fixtures }),
    });
    checkSetupRefs({ "--param": Object.values(params) }, fx);
    return fx;
  };
  return { fixtures };
}

/** The self-heal / done-check arguments, validated as `journey run` validates them. */
interface RunExtras {
  selfHeal: SelfHealMode;
  healRequest: JourneyHealRequest;
  real: boolean;
  fakeAi: boolean;
  jevProvider: "typesafe" | "openrouter" | undefined;
  stepResponseTimeoutMs: number | undefined;
  noDoneCheck: boolean;
  requireDoneCheck: boolean;
}

/** Heal budgets, timeout bounds and done-check flags (the fourth phase of `journey run`'s flags). */
function parseRunExtras(args: Record<string, unknown>): RunExtras {
  const selfHeal = optEnum<SelfHealMode>(args, "selfHeal", ["fail-closed", "hybrid", "full"]) ?? "fail-closed";
  const real = optBool(args, "real") ?? false;
  const fakeAi = optBool(args, "fakeAi") ?? false;
  // #429: the Jev provider for self-heal judgments (typesafe | openrouter), as `--jev-provider`.
  const jevProvider = optEnum<"typesafe" | "openrouter">(args, "jevProvider", ["typesafe", "openrouter"]);
  // #453 Q1: the same refusals as `journey run` — a heal needs a change context, the change and
  // budget arguments need a heal — before any gateway, Journey lookup or browser.
  const changes = optString(args, "changes");
  const healMaxAttempts = optInt(args, "healMaxAttempts", 1);
  const healMaxModelCalls = optInt(args, "healMaxModelCalls", 1);
  const healMaxMs = optInt(args, "healMaxMs", 1);
  const healMaxRunAttempts = optInt(args, "healMaxRunAttempts", 1);
  const healMaxRunMs = optInt(args, "healMaxRunMs", 1);
  const stepResponseTimeoutMs = optInt(args, "stepResponseTimeoutMs", 1);
  if (stepResponseTimeoutMs !== undefined && stepResponseTimeoutMs > MAX_STEP_RESPONSE_TIMEOUT_MS) {
    throw new McpArgError(`'stepResponseTimeoutMs' must be an integer from 1 to ${MAX_STEP_RESPONSE_TIMEOUT_MS}`);
  }
  // #800: `journey run --no-done-check` / `--require-done-check`, refused together as the CLI refuses them.
  const noDoneCheck = optBool(args, "noDoneCheck") === true;
  const requireDoneCheck = optBool(args, "requireDoneCheck") === true;
  if (noDoneCheck && requireDoneCheck) throw new McpArgError("'noDoneCheck' and 'requireDoneCheck' cannot be used together");
  const healRequest: JourneyHealRequest = {
    selfHeal,
    ...(changes === undefined ? {} : { changes }),
    changeNotes: optStringArray(args, "changeNote") ?? [],
    ...(healMaxAttempts === undefined ? {} : { maxAttempts: healMaxAttempts }),
    ...(healMaxModelCalls === undefined ? {} : { maxModelCalls: healMaxModelCalls }),
    ...(healMaxMs === undefined ? {} : { maxMs: healMaxMs }),
    ...(healMaxRunAttempts === undefined ? {} : { maxRunAttempts: healMaxRunAttempts }),
    ...(healMaxRunMs === undefined ? {} : { maxRunMs: healMaxRunMs }),
  };
  validateJourneyHeal(healRequest, MCP_HEAL_NAMES);
  return { selfHeal, healRequest, real, fakeAi, jevProvider, stepResponseTimeoutMs, noDoneCheck, requireDoneCheck };
}

/** The self-heal gateway, change scope and policy (the fifth phase; async, before any browser). */
async function resolveSelfHealer(
  ctx: McpToolCtx,
  extras: RunExtras,
): Promise<{ selfHealer: SelfHealer | undefined; policy: RunPolicy; usage: UsageTracker | undefined; healScope: ChangeScope | undefined }> {
  const { deps, credentialStore } = ctx;
  const { selfHeal, healRequest, real, fakeAi, jevProvider } = extras;
  const healScope = selfHeal === "fail-closed" ? undefined : await readJourneyChangeScope(healRequest, deps.journeysDir);
  let selfHealer: SelfHealer | undefined;
  let policy: RunPolicy = defaultRunPolicy();
  let usage: UsageTracker | undefined;
  if (selfHeal !== "fail-closed") {
    if (deps.selfHealGateways === undefined) throw new SetupRequired("run_journey selfHeal needs the model gateways, which this server was not given");
    // #453: the healer is evidence-only — its model is an advisory ranker; judgment never decides a heal.
    let gen: GenerationPort;
    try {
      ({ gen, usage } = await deps.selfHealGateways({ real, fakeAi, ...(jevProvider === undefined ? {} : { jevProvider }) }));
    } catch (err) {
      throw new SetupRequired(redactCredentials(err instanceof Error ? err.message : String(err), credentialStore));
    }
    selfHealer = makeEvidenceSelfHealer(gen, usage === undefined ? {} : { usage });
    policy = { ...policy, selfHeal: { mode: selfHeal, budget: journeyHealBudget(healRequest) } };
  }
  return { selfHealer, policy, usage, healScope };
}

/**
 * 0.30.0 §5.3, owner decision 6: the secret parameters a run needs and the request leaves out, from
 * the operator's `targets.json` `secretFields` for the run's origin: in automation mode only when the
 * Journey carries a current approval a person made (decision 5); in test mode for any current approval
 * (the test target's own credentials). The values come from the server's environment and go to the
 * browser, bound to that origin; never to the result or the evidence. Anything else answers as 0.29.0
 * did: `E_SECRET_PARAM_OVER_MCP` by name.
 */
async function secretsFromTargets(
  ctx: McpToolCtx,
  id: string,
  needed: readonly string[],
  resolved: ResolvedJourneyRun,
): Promise<{ readonly refusal: Record<string, unknown> } | { readonly params: Record<string, string>; readonly options: McpJourneyRunOptions }> {
  const { deps } = ctx;
  const refuse = { refusal: secretParamRefusalBody(needed) };
  let stored: Journey | null;
  try {
    stored = await new FsJourneyStore(deps.journeysDir).get(id);
  } catch {
    return refuse;
  }
  if (stored === null) return refuse;
  const environment = resolved.options.environment;
  const target = resolveRunTarget({ origin: environment?.baseUrl ?? stored.recording.site, environment, environmentsFile: deps.environmentsFile, targetsFile: deps.targetsConfigPath });
  // Rules 5 and 6, the one rule every MCP surface applies (journey-run-mode-gate.ts): a current approval, a person's on an automation-mode target.
  if (!(await mcpMayBindTargetSecrets(stored, target.mode, { journeysDir: deps.journeysDir, catalogDir: resolveCatalogDir(undefined) }))) return refuse;
  const fields = target.targetConfig?.secretFields ?? [];
  // 0.30.0 §5.3: no binding on this origin: in automation mode the run goes on and holds at the secret step
  // for a person; in test mode it is refused E_HUMAN_STEP_IN_TEST_MODE before any browser (journey-secret-mode.ts).
  // A binding on another origin refuses E_SECRET_ORIGIN_REFUSED. Never a value here.
  if (fields.length === 0) return { params: resolved.params, options: resolved.options };
  let bound: Awaited<ReturnType<typeof withSecretParams>>;
  try {
    bound = await withSecretParams({ dir: deps.journeysDir, id, params: resolved.params, flags: [], targetFields: fields, targetOrigin: target.origin, env: deps.secretEnv ?? process.env });
  } catch (err) {
    if (err instanceof SecretFieldAmbiguousError || err instanceof BoundSecretOutsideFieldError) return { refusal: { error: "invalid_args", code: err.code, message: err.message } };
    throw err;
  }
  // What the binding leaves out holds at its step for a person, as above.
  return { params: bound.params, options: { ...resolved.options, ...(bound.bound === undefined ? {} : { boundSecretParams: bound.bound }) } };
}
