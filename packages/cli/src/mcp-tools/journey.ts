import { SiteGateRefusedError } from "@jevitate/runtime";
import { findCapabilities } from "@jevitate/mcp-facade";
import { FsJourneyStore, JourneyRegistry } from "@jevitate/journey";
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
import { FixtureSetupError, FixtureSpecError, UnboundSetupRefError, type MissionFixtures } from "../mission-fixtures.js";
import { parseScreenshotsArg, type ScreenshotsSpec } from "../run-screenshots.js";
import { makeEvidenceSelfHealer } from "../self-heal-adapter.js";
import { JourneyHealArgsError, MCP_HEAL_NAMES, journeyHealBudget, readJourneyChangeScope, validateJourneyHeal, type JourneyHealRequest } from "../journey-heal.js";
import { ChangesArgsError, ChangesInputError } from "../change-context.js";
import { MAX_STEP_RESPONSE_TIMEOUT_MS } from "../journey-network-checks.js";
import { McpArgError, argErrorBody, optBool, optEnum, optInt, optNamedSessions, optPath, optExtensions, optRecordVideo, optScreenshots, optString, optStringArray, optStringMap, optViewport } from "../mcp-args.js";
import { resourcePreflight } from "../resource-preflight.js";
import type { McpToolCtx, McpToolGroup } from "./shared.js";
import { jsonResult, errorResult, governanceArgs, withJourneyExitCode, SetupRequired, redactCredentials, tagsArg } from "./shared.js";
import type { McpJourneyRunOptions } from "../mcp-api.js";

/** `find_capabilities` and `run_journey`: the promoted-Journey tools. */
export function journeyTools(ctx: McpToolCtx): McpToolGroup {
  const { deps, pathRoots, credentialStore, runJourney } = ctx;
  const findCaps =
    deps.findCapabilities ??
    ((query: string) => findCapabilities(new JourneyRegistry(new FsJourneyStore(deps.journeysDir)), query));

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

  return {
    find_capabilities: {
      description: "Find promoted Journeys (capabilities) whose metadata matches a query.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      handler: async (args) => jsonResult(await findCaps(typeof args.query === "string" ? args.query : "")),
    },
    run_journey: {
      description:
        "Run a PUBLISHED Journey by id with string params (fail-closed policy) — `jevitate journey run`. Never accepts inline steps. " +
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
          // A site-policy refusal (throttle, budget, quiet hours) is an answer the agent acts on — when to retry.
          if (err instanceof SiteGateRefusedError) {
            return errorResult({ error: "throttled", reason: err.reason, retryAfter: err.retryAfter, message: err.message });
          }
          if (err instanceof UnknownJourneyError) return errorResult({ error: "not_found", id: args.id, message: err.message });
          if (err instanceof JourneyRequiresAuthError) return errorResult({ error: "invalid_args", code: "E_JOURNEY_REQUIRES_AUTH", message: err.message });
          if (err instanceof ExtensionMismatchError) return errorResult({ error: "invalid_args", code: err.code, message: err.message });
          if (err instanceof ParamValidationError) return errorResult({ error: "invalid_args", code: "E_INVALID_PARAMS", message: err.message });
          if (isEnvironmentError(err) || err instanceof FixtureSpecError || err instanceof UnboundSetupRefError) {
            return errorResult({ error: "invalid_args", code: err.code, message: err.message });
          }
          // Never run on unknown state: inconclusive (exit 2) — proves nothing, so an error result.
          if (err instanceof FixtureSetupError) {
            return errorResult({ outcome: "inconclusive", reason: err.message, failure: { kind: "configuration", message: err.message }, attribution: "configuration", exitCode: 2 });
          }
          throw err;
        }
      },
    },
  };
}
