import { MAX_STEP_RESPONSE_TIMEOUT_MS } from "../journey-network-checks.js";
import type { McpToolCtx, McpToolGroup } from "./shared.js";
import { findCapabilitiesTool, runJourneyTool } from "./journey-handlers.js";

/** `find_capabilities` and `run_journey`: the promoted-Journey tools. */
export function journeyTools(ctx: McpToolCtx): McpToolGroup {
  return {
    find_capabilities: {
      description: "Find promoted Journeys (capabilities) whose metadata matches a query.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      handler: (args) => findCapabilitiesTool(ctx, args),
    },
    run_journey: {
      description:
        "Run a PUBLISHED Journey by id with string params (fail-closed policy) — `jevitate journey run`. Never accepts inline steps. " +
        "A secret parameter's value in 'params' is always refused ({error: invalid_args, code: E_SECRET_PARAM_OVER_MCP, params}): never send a value. A Journey that needs one, or has a handback step, runs on an automation-mode target for a Journey a person approved (tty or pr-review): the target's operator file (~/.jevitate/targets.json secretFields) supplies it to the browser on that origin only (vault-autofill), a binding on another origin refuses ({code: E_SECRET_ORIGIN_REFUSED}), and otherwise the run holds at that step ({outcome: held, holdId, exitCode: 2}) until a person runs `jevitate inbox resume <holdId>` at a terminal and completes it in the browser; the value never reaches the result. On a test-mode target the target's own targets.json secretFields supply it the same way (any current approval, an MCP promotion included); with no binding it is refused before any browser ({code: E_HUMAN_STEP_IN_TEST_MODE}), never held. A Journey promoted over MCP, on an automation-mode target, is refused as before. " +
        "0.30.0 run modes: the mode comes from the target's declared trust (environments.json / targets.json), never an argument; an undeclared origin is automation mode, which runs only a Journey a person approved ({error: refused, code: E_APPROVAL_CHANNEL_FOR_MODE}: an approval over MCP authorises test-mode runs only), and a test-mode target never waits for a person (a handback step: E_HUMAN_STEP_IN_TEST_MODE). " +
        "#788: an unpromoted Journey, or one changed since its approval, is refused before any browser ({error: refused, code: E_JOURNEY_NOT_PROMOTED | E_JOURNEY_APPROVAL_STALE | E_JOURNEY_APPROVAL_UNKNOWN, fix}): promote it with promote_journey, or try a draft on the CLI (`jevitate journey run`). " +
        "#789: a click on a session-ending, destructive or paid control, a write to an origin outside the run's allowlist and a production environment are refused before anything is sent ({error: refused, outcome: refused, code: E_RUN_REFUSED_DESTRUCTIVE | E_RUN_REFUSED_OFF_ALLOWLIST_WRITE | E_RUN_REFUSED_PRODUCTION, setting, retryable: false}): do not retry; only a person lifts it, in the target's mcpRun section of ~/.jevitate/targets.json. " +
        "Optional 'storageState': a PATH (on the machine running this MCP server; inside the project or ~/.jevitate, never a repo's .jevitate/) to a Playwright storageState " +
        "JSON file, for a Journey authored behind a login (#118) — the file's contents are read only by the " +
        "server's own browser, never returned or logged. A Journey that declares metadata.requiresAuth refuses " +
        "with a clear error when no storageState is given. #255 (same as the CLI flags): 'env' (a named environment in .jevitate/environments.json; its session from ~/.jevitate/targets.json) and/or 'baseUrl'; " +
        "'headed' (needs a display) and 'slowMo'; 'recordVideo' (true, or a directory) → videoPaths; 'screenshots' (true | screens | steps | mode:<dir> | <dir>) → screenshotPaths; " +
        "'viewport' {width,height} or 'device' (mutually exclusive); 'geolocation' '<lat>,<lng>[,<accuracy m>]' (#329); 'fixtures' (a fixtures JSON path: setup before, restore after; 'fixtureIdentity' (#243) 'name=<storageState path>' entries name who a step with auth.identity authenticates as; an environment's shell hooks are never run over MCP — they refuse as the CLI does without --allow-shell-hooks); " +
        "'extension' (#256: unpacked extension directories inside the project or ~/.jevitate; a Journey recorded with extensions needs the same build); 'selfHeal' fail-closed (default) | hybrid | full with 'real' or 'fakeAi' (a write step never self-heals; 'jevProvider' typesafe | openrouter picks the Jev key with real, #429) — #453: a heal mode needs a change context, 'changes' (a git range such as HEAD~1..HEAD, read-only) and/or 'changeNote' (strings), else it is refused; only a break that change explains is retargeted, one-for-one, and the run ends healed-pending-review (exitCode 5: a proposed revision a person accepts, never a pass); budgets 'healMaxAttempts'/'healMaxModelCalls'/'healMaxMs' (per broken step) and 'healMaxRunAttempts'/'healMaxRunMs' (per run), each >= 1; the result's 'exitCode' is the CLI's (0 ok, 5 pending review, 1 failed); 'actionDeltas' (#303, opt-in: each replayed step's action delta, compared with the recorded one → actionDeltas); 'stepResponseTimeoutMs' (#486, 1..300000, default 15000: how long a step's responseStatus check waits for a request sent but not yet answered, e.g. a cold start — a late 2xx is an advisory slowSteps finding; a step's own responseTimeoutMs overrides it); 'maxBrowsers'/'maxBrowserMemory' (#205: machine-wide browser cap, browser memory ceiling in MiB); 'tags' (#426: {key: value} run metadata, returned on the result — never a secret); 'noDoneCheck' (#800, `--no-done-check`: skip the linked job's done check; the job reads unverified, basis no-check, which exits 2 unless project.json doneCheckPolicy is advisory) and 'requireDoneCheck' (`--require-done-check`: an unverified job exits 2 even under the advisory policy), not both. A site-policy refusal is {error: throttled, retryAfter}.",
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
          noDoneCheck: { type: "boolean" },
          requireDoneCheck: { type: "boolean" },
          tags: { type: "object", additionalProperties: { type: "string" } },
        },
        required: ["id"],
      },
      handler: (args) => runJourneyTool(ctx, args),
    },
  };
}
