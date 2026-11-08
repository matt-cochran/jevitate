import { SiteGateRefusedError } from "@jevitate/runtime";
import { findCapabilities, JourneyRunRefusedError } from "@jevitate/mcp-facade";
import { FsJourneyStore, JourneyRegistry, type Journey } from "@jevitate/journey";
import { type GenerationPort } from "@jevitate/ai-core";
import { existsSync } from "node:fs";
import { ParamValidationError } from "@jevitate/journey";
import type { UsageTracker } from "@jevitate/ai-core";
import type { SelfHealer } from "@jevitate/runtime";
import type { EmulationSpec } from "@jevitate/playwright";
import { safeRunPolicy as defaultRunPolicy, type RunPolicy, type SelfHealMode } from "@jevitate/domain";
import { stampRunMetadata, withRunMetadata } from "../run-metadata.js";
import { JourneyRequiresAuthError, UnknownJourneyError } from "../journey-api.js";
import { ExtensionMismatchError, type BrowserRunOptions } from "../browser-run-options.js";
import { browserRunFromFlags, emulationFromFlags } from "../cli-shared.js";
import { environmentFromFlags, isEnvironmentError } from "../environments.js";
import { buildMissionFixtures, checkSetupRefs } from "../fixture-cli.js";
import { BoundSecretOutsideFieldError, SecretFieldAmbiguousError, secretParamRefusalBody, secretParamsCarried, withSecretParams } from "../secret-params.js";
import { approvalAuthorisesAutomation, resolveRunTarget, RunModeRefusedError, runModeRefusalBody } from "../journey-run-mode-gate.js";
import { ParamTypeError, paramTypeRefusalBody } from "../journey-param-types.js";
import { journeyApprovalState } from "../journey-stale-api.js";
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
import type { McpToolCtx, McpToolGroup } from "./shared.js";
import { jsonResult, errorResult, governanceArgs, withJourneyExitCode, SetupRequired, redactCredentials, tagsArg } from "./shared.js";
import type { McpJourneyRunOptions } from "../mcp-api.js";

/** `find_capabilities` and `run_journey`: the promoted-Journey tools. */
export function journeyTools(ctx: McpToolCtx): McpToolGroup {
  const { deps, pathRoots, credentialStore, runJourney } = ctx;
  const baseFindCaps =
    deps.findCapabilities ??
    ((query: string) => findCapabilities(new JourneyRegistry(new FsJourneyStore(deps.journeysDir)), query));
  /**
   * #800: each capability that links a catalog job carries `job: { id, status, done?: { at, check } }`,
   * the job's done check as stored (placeholders, never values). Best effort: no project or an
   * unreadable catalog leaves the capability as it was.
   */
  const findCaps = async (query: string): Promise<unknown> => {
    const caps = await baseFindCaps(query);
    if (!Array.isArray(caps) || caps.length === 0) return caps;
    try {
      const store = new FsJourneyStore(deps.journeysDir);
      const catalog = await loadCatalog(resolveCatalogDir(undefined), deps.journeysDir);
      return await Promise.all(
        caps.map(async (c: unknown) => {
          const id = c !== null && typeof c === "object" ? (c as { id?: unknown }).id : undefined;
          const journey = typeof id === "string" ? await store.get(id) : null;
          const job = journey === null ? undefined : linkedJobDone(catalog, journey);
          return job === undefined ? c : { ...(c as object), job };
        }),
      );
    } catch {
      return caps;
    }
  };

  /**
   * #255: `run_journey`'s CLI-parity options, resolved exactly as `journey run` resolves its flags
   * (the same helpers: environmentFromFlags, browserRunFromFlags, parseScreenshotsArg,
   * emulationFromFlags, buildMissionFixtures) — every refusal typed, before any browser opens.
   */
  const resolveJourneyRun = async (
    args: Record<string, unknown>,
  ): Promise<{ params: Record<string, string>; storageState?: string; options: McpJourneyRunOptions; usage?: UsageTracker }> => {
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
        ...(stepResponseTimeoutMs === undefined ? {} : { stepResponseTimeoutMs }),
      },
      ...(usage === undefined ? {} : { usage }),
    };
  };

  /**
   * 0.30.0 §5.3, owner decision 6: the secret parameters a run needs and the request leaves out, from
   * the operator's `targets.json` `secretFields` for the run's origin, only when the run is in automation
   * mode and its Journey carries a current approval a person made (decision 5). The values come from the
   * server's environment and go to the browser, bound to that origin; never to the result or the evidence.
   * Anything else answers as 0.29.0 did: `E_SECRET_PARAM_OVER_MCP` by name.
   */
  const secretsFromTargets = async (
    id: string,
    needed: readonly string[],
    resolved: { params: Record<string, string>; options: McpJourneyRunOptions },
  ): Promise<{ readonly refusal: Record<string, unknown> } | { readonly params: Record<string, string>; readonly options: McpJourneyRunOptions }> => {
    const refuse = { refusal: secretParamRefusalBody(needed) };
    let stored: Journey | null;
    try {
      stored = await new FsJourneyStore(deps.journeysDir).get(id);
    } catch {
      return refuse;
    }
    if (stored === null || !approvalAuthorisesAutomation(stored)) return refuse;
    // Rule 5 holds only for an approval that still binds this content.
    const state = await journeyApprovalState(stored, { journeysDir: deps.journeysDir, catalogDir: resolveCatalogDir(undefined) });
    if (!state.promoted || state.approval !== "current") return refuse;
    const environment = resolved.options.environment;
    const target = resolveRunTarget({ origin: environment?.baseUrl ?? stored.recording.site, environment, environmentsFile: deps.environmentsFile, targetsFile: deps.targetsConfigPath });
    const fields = target.targetConfig?.secretFields ?? [];
    if (target.mode !== "automation" || fields.length === 0) return refuse;
    let bound: Awaited<ReturnType<typeof withSecretParams>>;
    try {
      bound = await withSecretParams({ dir: deps.journeysDir, id, params: resolved.params, flags: [], targetFields: fields, targetOrigin: target.origin, env: deps.secretEnv ?? process.env });
    } catch (err) {
      if (err instanceof SecretFieldAmbiguousError || err instanceof BoundSecretOutsideFieldError) return { refusal: { error: "invalid_args", code: err.code, message: err.message } };
      throw err;
    }
    const missing = needed.filter((n) => !(n in bound.params));
    if (missing.length > 0 || bound.bound === undefined) return { refusal: secretParamRefusalBody(missing.length > 0 ? missing : needed) };
    return { params: bound.params, options: { ...resolved.options, boundSecretParams: bound.bound } };
  };

  return {
    find_capabilities: {
      description: "Find promoted Journeys (capabilities) whose metadata matches a query.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      handler: async (args) => jsonResult(await findCaps(typeof args.query === "string" ? args.query : "")),
    },
    run_journey: {
      description:
        "Run a PUBLISHED Journey by id with string params (fail-closed policy) — `jevitate journey run`. Never accepts inline steps. " +
        "A secret parameter's value in 'params' is always refused ({error: invalid_args, code: E_SECRET_PARAM_OVER_MCP, params}): never send a value. A Journey that needs one runs only when the target's operator file (~/.jevitate/targets.json secretFields) supplies it, on an automation-mode target, for a Journey a person approved (tty or pr-review); the value goes to the browser, never to the result. Otherwise the same refusal: a person runs it on the CLI (`journey run --secret-field`), or the Journey uses a stored session ('storageState'). " +
        "0.30.0 run modes: the mode comes from the target's declared trust (environments.json / targets.json), never an argument; an undeclared origin is automation mode, which runs only a Journey a person approved ({error: refused, code: E_APPROVAL_CHANNEL_FOR_MODE}: an approval over MCP authorises test-mode runs only), and a test-mode target never waits for a person (a handback step: E_HUMAN_STEP_IN_TEST_MODE). " +
        "#788: an unpromoted Journey, or one changed since its approval, is refused before any browser ({error: refused, code: E_JOURNEY_NOT_PROMOTED | E_JOURNEY_APPROVAL_STALE | E_JOURNEY_APPROVAL_UNKNOWN, fix}): promote it with promote_journey, or try a draft on the CLI (`jevitate journey run`). " +
        "#789: a click on a session-ending, destructive or paid control, a write to an origin outside the run's allowlist and a production environment are refused before anything is sent ({error: refused, outcome: refused, code: E_RUN_REFUSED_DESTRUCTIVE | E_RUN_REFUSED_OFF_ALLOWLIST_WRITE | E_RUN_REFUSED_PRODUCTION, setting, retryable: false}): do not retry; only a person lifts it, in the target's mcpRun section of ~/.jevitate/targets.json. " +
        "Optional 'storageState': a PATH (on the machine running this MCP server; inside the project or ~/.jevitate, never a repo's .jevitate/) to a Playwright storageState " +
        "JSON file, for a Journey authored behind a login (#118) — the file's contents are read only by the " +
        "server's own browser, never returned or logged. A Journey that declares metadata.requiresAuth refuses " +
        "with a clear error when no storageState is given. #255 (same as the CLI flags): 'env' (a named environment in .jevitate/environments.json; its session from ~/.jevitate/targets.json) and/or 'baseUrl'; " +
        "'headed' (needs a display) and 'slowMo'; 'recordVideo' (true, or a directory) → videoPaths; 'screenshots' (true | screens | steps | mode:<dir> | <dir>) → screenshotPaths; " +
        "'viewport' {width,height} or 'device' (mutually exclusive); 'geolocation' '<lat>,<lng>[,<accuracy m>]' (#329); 'fixtures' (a fixtures JSON path: setup before, restore after; 'fixtureIdentity' (#243) 'name=<storageState path>' entries name who a step with auth.identity authenticates as; an environment's shell hooks are never run over MCP — they refuse as the CLI does without --allow-shell-hooks); " +
        "'extension' (#256: unpacked extension directories inside the project or ~/.jevitate; a Journey recorded with extensions needs the same build); 'selfHeal' fail-closed (default) | hybrid | full with 'real' or 'fakeAi' (a write step never self-heals; 'jevProvider' typesafe | openrouter picks the Jev key with real, #429) — #453: a heal mode needs a change context, 'changes' (a git range such as HEAD~1..HEAD, read-only) and/or 'changeNote' (strings), else it is refused; only a break that change explains is retargeted, one-for-one, and the run ends healed-pending-review (exitCode 5: a proposed revision a person accepts, never a pass); budgets 'healMaxAttempts'/'healMaxModelCalls'/'healMaxMs' (per broken step) and 'healMaxRunAttempts'/'healMaxRunMs' (per run), each >= 1; the result's 'exitCode' is the CLI's (0 ok, 5 pending review, 1 failed); 'actionDeltas' (#303, opt-in: each replayed step's action delta, compared with the recorded one → actionDeltas); 'stepResponseTimeoutMs' (#486, 1..300000, default 15000: how long a step's responseStatus check waits for a request sent but not yet answered, e.g. a cold start — a late 2xx is an advisory slowSteps finding; a step's own responseTimeoutMs overrides it); 'maxBrowsers'/'maxBrowserMemory' (#205: machine-wide browser cap, browser memory ceiling in MiB); 'tags' (#426: {key: value} run metadata, returned on the result — never a secret). A site-policy refusal is {error: throttled, retryAfter}.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          params: { type: "object", additionalProperties: { type: "string" } },
          storageState: { type: "string" },
          env: { type: "string" },
          baseUrl: { type: "string" },
          headed: { type: "boolean" },
          slowMo: { type: "integer", minimum: 0 },
          recordVideo: { type: ["boolean", "string"] },
          screenshots: { type: ["boolean", "string"] },
          viewport: { type: "object", properties: { width: { type: "integer" }, height: { type: "integer" } }, required: ["width", "height"] },
          device: { type: "string" },
          geolocation: { type: "string" },
          fixtures: { type: "string" },
          fixtureIdentity: { type: "array", items: { type: "string" } },
          selfHeal: { type: "string", enum: ["fail-closed", "hybrid", "full"] },
          changes: { type: "string" },
          changeNote: { type: "array", items: { type: "string" } },
          healMaxAttempts: { type: "integer", minimum: 1 },
          healMaxModelCalls: { type: "integer", minimum: 1 },
          healMaxMs: { type: "integer", minimum: 1 },
          healMaxRunAttempts: { type: "integer", minimum: 1 },
          healMaxRunMs: { type: "integer", minimum: 1 },
          real: { type: "boolean" },
          fakeAi: { type: "boolean" },
          jevProvider: { type: "string", enum: ["typesafe", "openrouter"] },
          extension: { type: "array", items: { type: "string" } },
          maxBrowsers: { type: "integer", minimum: 1 },
          maxBrowserMemory: { type: "integer", minimum: 1 },
          actionDeltas: { type: "boolean" },
          stepResponseTimeoutMs: { type: "integer", minimum: 1, maximum: MAX_STEP_RESPONSE_TIMEOUT_MS },
          tags: { type: "object", additionalProperties: { type: "string" } },
        },
        required: ["id"],
      },
      handler: async (args) => {
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
        let resolved: { params: Record<string, string>; storageState?: string; options: McpJourneyRunOptions; usage?: UsageTracker };
        try {
          resolved = await resolveJourneyRun(args);
        } catch (err) {
          const body = argErrorBody(err) ?? (isEnvironmentError(err) ? { error: "invalid_args", code: err.code, message: err.message } : undefined);
          if (body !== undefined) return errorResult(body);
          if (err instanceof JourneyHealArgsError || err instanceof ChangesArgsError || err instanceof ChangesInputError) {
            return errorResult({ error: "invalid_args", code: err.code, message: err.message });
          }
          if (err instanceof SetupRequired) return errorResult({ error: "setup_required", message: err.message });
          throw err;
        }
        if (needed.length > 0) {
          const supplied = await secretsFromTargets(args.id, needed, resolved);
          if ("refusal" in supplied) return errorResult(supplied.refusal);
          resolved = { ...resolved, params: supplied.params, options: supplied.options };
        }
        // #205: the same pre-run checks as `jevitate journey run` (orphan sweep, starved-host refusal).
        const starved = await resourcePreflight({});
        if (starved !== null) return errorResult({ error: "refused", code: starved.error?.code, message: starved.error?.message });
        try {
          const id = args.id;
          const result = await withRunMetadata({ tags: tagged.tags }, () => runJourney(id, resolved.params, resolved.storageState, resolved.options));
          // #163: a self-healing run's model usage lands on its result, as on the CLI. #426: so do its tags.
          const withUsage = resolved.usage === undefined || result === null || typeof result !== "object" ? result : { ...result, usage: resolved.usage.snapshot() };
          // #453: the CLI's exit code for the outcome — 0 ok, 5 healed-pending-review (a proposed revision, never a pass), 1 otherwise.
          return jsonResult(stampRunMetadata(withJourneyExitCode(withUsage), { tags: tagged.tags }));
        } catch (err) {
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
          if (err instanceof JourneyRunRefusedError) return failed({ error: "refused", outcome: "refused", code: err.code, id: args.id, message: err.message, fix: err.fix, tryDraft: err.tryDraft, retryable: false });
          if (err instanceof UnknownJourneyError) return failed({ error: "not_found", id: args.id, message: err.message });
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
          throw err;
        }
      },
    },
  };
}
