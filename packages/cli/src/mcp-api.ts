import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SiteGateRefusedError } from "@jevitate/runtime";
import { withSiteGate } from "./site-gate-cli.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ALLOWED_TOOLS,
  FORBIDDEN_TOOLS,
  findCapabilities,
  queueExploration as facadeQueueExploration,
  aiGenerateText as facadeAiGenerateText,
  facadeListIncoming,
  facadeGetCommand,
  facadeGetThread,
  facadeQueueAction,
  facadeQueueRetrieval,
  facadeApproveAction,
  facadeCancelCommand,
  facadeGetSiteHealth,
  isMissionResultId,
  isQueuedMissionId,
  missionResultFileName,
  missionStatus,
  parseResultOutcome,
  type AiGenerateTextArgs,
  type AiGenerateTextResult,
} from "@jevitate/mcp-facade";
import { FsJourneyStore, JourneyRegistry } from "@jevitate/journey";
import {
  FsMissionTargetStore,
  MissionTargetRegistry,
  FsMissionQueueStore,
} from "@jevitate/missions";
import { FsInboxStore } from "@jevitate/inbox";
import {
  ALL_CREDENTIAL_KEYS,
  envCredentialStore,
  type CredentialStore,
  type GenerationPort,
  type SetupRequiredResult,
} from "@jevitate/ai-core";
import { safeRunPolicy } from "@jevitate/domain";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runJourneyProgrammatically } from "./journey-api.js";
import { runVerifyFix, type VerifyFixReport } from "./verify-fix-api.js";
import { currentEngineInfo, type EngineInfo } from "./engine.js";
import { loadTargetsFile } from "./target-config.js";

/**
 * The MCP stdio server behind `jevitate mcp`. It exposes ONLY the tools in
 * `@jevitate/mcp-facade`'s `ALLOWED_TOOLS` and structurally CANNOT serve any
 * of `FORBIDDEN_TOOLS` (the raw browser primitives): the served surface is
 * derived from `ALLOWED_TOOLS`, every descriptor is re-checked against the
 * allow/forbid sets at build time (`assertAllowlisted`), and the call
 * dispatcher refuses any name that is forbidden or not in the served map.
 *
 * `buildMcpTools` is the unit-testable seam — a test can enumerate the served
 * tool names (and exercise each handler) WITHOUT opening a stdio transport.
 * `startMcpServer` is the only place a real `StdioServerTransport` is opened.
 */

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  handler: (args: Record<string, unknown>) => Promise<McpToolResult>;
}

export interface McpApiDeps {
  /** Journeys store directory (`~/.jevitate/journeys` in production). */
  journeysDir: string;
  /**
   * The site-policy database (`jevitate site policy set`): `run_journey` is paced, throttled,
   * budgeted and kept out of quiet hours per the Journey's origin. Absent file = no policy.
   */
  sitePolicyDbPath?: string;
  /**
   * Test seam. Defaults to the real promoted-only projection over the
   * journeys store (`@jevitate/mcp-facade`'s `findCapabilities`).
   */
  findCapabilities?: (query: string) => Promise<unknown>;
  /**
   * Test seam. Defaults to `runJourneyProgrammatically` with a fail-closed
   * `safeRunPolicy()` (invariant #5: PUBLISHED-id-only, never inline steps).
   * `storageState` (#118) is a PATH to a Playwright storageState JSON file — the file is
   * read only by the server's own browser launch; its contents never enter this handler,
   * an MCP result, or a log.
   */
  runJourney?: (id: string, params: Record<string, string>, storageState?: string) => Promise<unknown>;
  /**
   * Promoted mission-target store directory (`~/.jevitate/missions/targets` in
   * production — the SAME store `jevitate mission target` writes). Required for
   * the default `queue_exploration` wiring; the host resolves it.
   */
  missionTargetsDir?: string;
  /** Mission queue directory (`~/.jevitate/missions/queue` in production). */
  missionQueueDir?: string;
  /**
   * Inbox store directory (`~/.jevitate/inbox` in production) backing all 8
   * `list_incoming`/`get_command`/`get_thread`/`queue_action`/
   * `queue_retrieval`/`approve_action`/`cancel_command`/`get_site_health`
   * tools. The `FsInboxStore` is built lazily inside each handler's closure
   * (mirrors `queueExploration`'s lazy store) so constructing the tool set
   * never touches disk. A missing/unconfigured dir is a config error (a
   * refusal), never a silent success.
   */
  inboxDir?: string;
  /**
   * Test seam. Defaults to `@jevitate/mcp-facade`'s `queueExploration` over the
   * fs-backed promoted `MissionTargetRegistry` + `FsMissionQueueStore`. Never
   * runs a mission — only enqueues; refuses unknown/unpromoted targets and
   * over-ceiling budgets (all validation delegated to `enqueueMission`).
   */
  queueExploration?: (args: unknown) => Promise<unknown>;
  /**
   * Credential store for `ai_generate_text`'s preflight gate. Defaults to
   * `envCredentialStore()` (env + gitignored local config). `detect` never
   * returns a value; the key value is read ONLY at the provider call, inside
   * the gateway, and placed only in the Authorization header.
   */
  credentialStore?: CredentialStore;
  /**
   * Generation gateway for `ai_generate_text`. Provided by the host (the real
   * `OpenRouterGenerationGateway`, which routes every outbound payload through
   * the never-to-model credential guard). When ABSENT and no `aiGenerateText`
   * seam is injected, `ai_generate_text` stays a typed `not_implemented`
   * rather than fabricating an answer.
   */
  generationGateway?: GenerationPort;
  /**
   * Test seam. Defaults to `@jevitate/mcp-facade`'s `aiGenerateText`
   * (`credentialStore` + `generationGateway`), preflight-gated so a missing key
   * returns a typed `setup_required` result instead of calling the model.
   */
  aiGenerateText?: (args: AiGenerateTextArgs) => Promise<AiGenerateTextResult | SetupRequiredResult>;
  /**
   * Directory holding mission artifacts (`~/.jevitate/recordings` in production): the typed
   * `<id>.result.json` files `get_mission_result` reads. A missing dir is a config refusal.
   */
  recordingsDir?: string;
  /**
   * Where usability reviews write their artifacts (`~/.jevitate/ux-reports` in production): a
   * `usability-<stamp>` result is looked up here after `recordingsDir`.
   */
  uxReportsDir?: string;
  /**
   * Test seam. Defaults to `runVerifyFix` over `<recordingsDir>/<id>.result.json`: replays the
   * finding's repro in a fresh browser (authorized against the mission's own allowlist).
   */
  verifyFix?: (args: { resultPath: string; fingerprint: string }) => Promise<VerifyFixReport>;
  /**
   * The serving build's identity (#112) — reported by `initialize` (`serverInfo.version`) and by
   * `get_site_health`. Defaults to this build's `currentEngineInfo()`.
   */
  engine?: EngineInfo;
}

const ALLOWED = new Set<string>(ALLOWED_TOOLS);
const FORBIDDEN = new Set<string>(FORBIDDEN_TOOLS);

/**
 * Defense-in-depth guard: a tool descriptor may be built ONLY for a name that
 * is in `ALLOWED_TOOLS` and NOT in `FORBIDDEN_TOOLS`. A violation is a build
 * error, never a silently-served or silently-dropped tool.
 */
function assertAllowlisted(name: string): void {
  if (FORBIDDEN.has(name)) {
    throw new Error(`refusing to serve forbidden tool '${name}'`);
  }
  if (!ALLOWED.has(name)) {
    throw new Error(`refusing to serve non-allowlisted tool '${name}'`);
  }
}

function jsonResult(value: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function errorResult(value: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], isError: true };
}

/** Strips any known credential VALUE from a diagnostic string so a provider
 *  SDK error (which can echo request internals verbatim) never surfaces a key
 *  through the MCP result. The message returned to the caller is generic and
 *  key-free; this is belt-and-braces on top of the gateway's outbound guard. */
function redactCredentials(message: string, store: CredentialStore): string {
  let out = message;
  for (const key of ALL_CREDENTIAL_KEYS) {
    const value = store.read(key);
    if (value) out = out.split(value).join("***REDACTED***");
  }
  return out;
}

/**
 * Builds the served tool descriptors — EXACTLY one per `ALLOWED_TOOLS` entry.
 * Wired to their real backing services: `find_capabilities` + `run_journey`
 * (journey store), `queue_exploration` (`@jevitate/missions` enqueue over the
 * promoted `MissionTargetRegistry`), and `ai_generate_text` (`@jevitate/ai-core`
 * generation gateway behind a fail-closed credential preflight). The remaining
 * allowlisted tools — the inbox/command-queue surface — are registered (so the
 * served set equals `ALLOWED_TOOLS`) but respond with a typed `not_implemented`
 * error, since no facade-level backing service exists for them in this slice.
 * No handler ever fabricates a success.
 */
export function buildMcpTools(deps: McpApiDeps): McpTool[] {
  const findCaps =
    deps.findCapabilities ??
    ((query: string) => findCapabilities(new JourneyRegistry(new FsJourneyStore(deps.journeysDir)), query));

  const runJourney =
    deps.runJourney ??
    ((id: string, params: Record<string, string>, storageState?: string) =>
      withSiteGate(deps.sitePolicyDbPath, (siteGate) =>
        runJourneyProgrammatically({
          dir: deps.journeysDir,
          id,
          params,
          policy: safeRunPolicy(),
          ...(storageState !== undefined ? { storageState } : {}),
          ...(siteGate === undefined ? {} : { siteGate }),
        }),
      ));

  // queue_exploration: enqueue over the SAME promoted fs store `jevitate
  // mission target` writes. The store is built lazily inside the closure so
  // constructing the tool set never touches disk; a missing dir is a config
  // error (a refusal), never a silent success.
  const queueExploration =
    deps.queueExploration ??
    (async (args: unknown) => {
      if (!deps.missionTargetsDir || !deps.missionQueueDir) {
        throw new Error("queue_exploration requires missionTargetsDir and missionQueueDir to be configured");
      }
      const targets = new MissionTargetRegistry(new FsMissionTargetStore(deps.missionTargetsDir));
      const queue = new FsMissionQueueStore(deps.missionQueueDir);
      return facadeQueueExploration(targets, queue, args);
    });

  // ai_generate_text: preflight-gated generation. Wired only when a gateway (or
  // an explicit seam) is available — otherwise it stays not_implemented rather
  // than fabricate an answer. The credential store is read ONLY inside the
  // gateway/preflight; never here.
  const credentialStore = deps.credentialStore ?? envCredentialStore();
  const aiGenerateText =
    deps.aiGenerateText ??
    (deps.generationGateway
      ? (args: AiGenerateTextArgs) => facadeAiGenerateText(credentialStore, deps.generationGateway!, args)
      : undefined);

  // The 8 inbox tools: the store is built lazily inside this closure (mirrors
  // `queueExploration` above) so constructing the tool set never touches
  // disk. A missing `inboxDir` is a config error (a refusal), never a silent
  // success — `inboxHandler` below catches it (and any store-layer throw,
  // e.g. `getForAgent`/`get`'s fail-closed throw on corrupt/tampered data)
  // and converts it to a typed `internal` error, never lets it fabricate a
  // success or leak an unhandled rejection out of the handler.
  const inboxStore = () => {
    if (!deps.inboxDir) {
      throw new Error("inbox tools require inboxDir to be configured");
    }
    return new FsInboxStore(deps.inboxDir, deps.engine ?? currentEngineInfo());
  };

  function inboxHandler(fn: (store: ReturnType<typeof inboxStore>, args: Record<string, unknown>) => Promise<unknown> | unknown): McpTool["handler"] {
    return async (args) => {
      try {
        return jsonResult(await fn(inboxStore(), args));
      } catch (err) {
        return errorResult({ error: "internal", message: err instanceof Error ? err.message : String(err) });
      }
    };
  }

  const idInputSchema = {
    type: "object" as const,
    properties: { id: { type: "string" } },
    required: ["id"],
  };

  const queueCommonProperties = {
    run: { type: "string" },
    journey: { type: "string" },
    step: { type: "string" },
    reason: { type: "string" },
    agent: { type: "string" },
    targetUrl: { type: "string" },
    hasScreenshot: { type: "boolean" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          severity: { type: "string", enum: ["low", "med", "high"] },
          evidence: { type: "string" },
        },
        required: ["id", "title", "severity"],
      },
    },
  };
  const queueCommonRequired = ["run", "journey", "step", "reason", "agent"];

  // get_mission_result: reads a persisted typed mission result by ID only (the artifact stem the
  // CLI wrote) — never a caller-supplied path. The status carries the CLI exit code, and a run that
  // itself broke (inconclusive/crashed) is an MCP error result, so it can never read as a pass.
  //
  // The id is either a result stem (`explore-<stamp>`, `usability-<stamp>.recording`, …) or a
  // `queue_exploration` missionId (#117): the latter resolves through the mission's queue record —
  // `queued`/`running` is reported as such (not an error, not a result), `failed` as an error, and
  // `done` reads the result its drain wrote. Both shapes are closed regexes; nothing caller-shaped
  // ever reaches a path.
  const resolveResultId = async (
    id: unknown,
    tool: string,
  ): Promise<{ resultId: string; missionId?: string } | { response: McpToolResult; pending?: Record<string, unknown> }> => {
    if (isMissionResultId(id)) return { resultId: id };
    if (!isQueuedMissionId(id)) {
      return {
        response: errorResult({
          error: "invalid_args",
          message: `${tool} requires a mission result 'id' (explore-|coverage-|adversarial-|feature-|usability-<stamp>) or a queue_exploration missionId`,
        }),
      };
    }
    if (!deps.missionQueueDir) {
      return { response: errorResult({ error: "not_configured", message: `${tool} requires missionQueueDir to resolve a missionId` }) };
    }
    let mission;
    try {
      mission = await new FsMissionQueueStore(deps.missionQueueDir).get(id);
    } catch {
      return { response: errorResult({ error: "corrupt_mission", id }) };
    }
    if (mission === null) return { response: errorResult({ error: "not_found", id }) };
    if (mission.status === "queued" || mission.status === "running") {
      // Not finished: neither a pass nor a failure — the agent polls again later.
      const pending = {
        id,
        missionId: id,
        status: mission.status,
        pending: true,
        enqueuedAtIso: mission.enqueuedAtIso,
        ...(mission.startedAtIso === undefined ? {} : { startedAtIso: mission.startedAtIso }),
      };
      return { response: jsonResult(pending), pending };
    }
    if (mission.status === "failed") {
      return { response: errorResult({ id, missionId: id, status: "failed", isError: true, error: mission.error ?? "mission failed" }) };
    }
    if (!isMissionResultId(mission.resultId)) return { response: errorResult({ error: "corrupt_mission", id }) };
    return { resultId: mission.resultId, missionId: id };
  };

  /** The dirs a result may live in: recordings, and (usability reviews) the UX reports dir. */
  const resultPathsFor = (resultId: string): string[] => {
    const file = missionResultFileName(resultId);
    const dirs = [deps.recordingsDir, ...(resultId.startsWith("usability-") ? [deps.uxReportsDir] : [])];
    return dirs.filter((d): d is string => d !== undefined).map((d) => join(d, file));
  };

  const getMissionResult = async (args: Record<string, unknown>): Promise<McpToolResult> => {
    if (!deps.recordingsDir) {
      return errorResult({ error: "not_configured", message: "get_mission_result requires recordingsDir" });
    }
    const ref = await resolveResultId(args.id, "get_mission_result");
    if ("response" in ref) return ref.response;
    const ids = { id: args.id, ...(ref.missionId === undefined ? {} : { missionId: ref.missionId, resultId: ref.resultId }) };
    let raw: string | undefined;
    for (const path of resultPathsFor(ref.resultId)) {
      try {
        raw = await readFile(path, "utf8");
        break;
      } catch {
        // Try the next candidate dir.
      }
    }
    if (raw === undefined) {
      return errorResult({ error: "not_found", ...ids });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return errorResult({ error: "corrupt_result", ...ids });
    }
    // A goal run's own outcome (succeeded/exhausted/blocked) folds onto the canonical one (#117).
    const parsedOutcome =
      parsed !== null && typeof parsed === "object" && "missionOutcome" in parsed
        ? parseResultOutcome((parsed as { missionOutcome: unknown }).missionOutcome)
        : null;
    if (parsedOutcome === null) {
      return errorResult({ error: "corrupt_result", ...ids });
    }
    const status = {
      ...missionStatus(parsedOutcome.outcome),
      ...(parsedOutcome.goalOutcome === undefined ? {} : { goalOutcome: parsedOutcome.goalOutcome }),
    };
    const result = (parsed as { result?: unknown }).result ?? null;
    // An adversarial run's coverage is surfaced next to the status: an `inconclusive` run says what
    // it did and did not exercise, so an agent can tell "found nothing" from "tried nothing".
    const coverage =
      result !== null && typeof result === "object" && "coverage" in result ? (result as { coverage: unknown }).coverage : undefined;
    const body = { ...ids, ...status, ...(coverage === undefined ? {} : { coverage }), result };
    return status.isError ? errorResult(body) : jsonResult(body);
  };

  // verify_fix: replays a persisted finding by (result id, fingerprint) — never a caller-supplied
  // recording or path (invariant #5 analogue). Passes only if the defect signal is absent; an
  // unreachable replay is `inconclusive` and returned as an error result, never as "fixed".
  // #142 follow-up: a `cmd:` server-log source may only be re-run when the OPERATOR opted in for
  // this origin in ~/.jevitate/targets.json (`allowLogCmd: true`) — never via an MCP argument.
  const verifyFixImpl =
    deps.verifyFix ?? ((a: { resultPath: string; fingerprint: string }) => runVerifyFix({ ...a, targets: loadTargetsFile() }));
  const verifyFixTool = async (args: Record<string, unknown>): Promise<McpToolResult> => {
    if (!deps.recordingsDir) {
      return errorResult({ error: "not_configured", message: "verify_fix requires recordingsDir" });
    }
    if (
      !(isMissionResultId(args.id) || isQueuedMissionId(args.id)) ||
      typeof args.fingerprint !== "string" ||
      !/^[0-9a-f]{16}$/.test(args.fingerprint)
    ) {
      return errorResult({ error: "invalid_args", message: "verify_fix requires a mission result 'id' (or missionId) and a 16-hex 'fingerprint'" });
    }
    const ref = await resolveResultId(args.id, "verify_fix");
    if ("response" in ref) {
      // A mission still queued/running has nothing to verify yet: never a pass.
      return ref.pending === undefined ? ref.response : errorResult({ error: "not_ready", ...ref.pending });
    }
    // The first candidate that exists (usability results may sit in the UX reports dir).
    const candidates = resultPathsFor(ref.resultId);
    let resultPath = candidates[0]!;
    for (const path of candidates) {
      try {
        await access(path);
        resultPath = path;
        break;
      } catch {
        // Try the next candidate dir.
      }
    }
    try {
      const report = await verifyFixImpl({ resultPath, fingerprint: args.fingerprint });
      const body = {
        id: args.id,
        ...(ref.missionId === undefined ? {} : { missionId: ref.missionId, resultId: ref.resultId }),
        status: report.verdict,
        ...report,
      };
      // Neither is a pass: `inconclusive` proved nothing either way, `intermittent` (#74) means the
      // signal fired on SOME but not all fresh-context replays — never trustworthy as "fixed".
      return report.verdict === "inconclusive" || report.verdict === "intermittent" ? errorResult(body) : jsonResult(body);
    } catch (err) {
      return errorResult({ error: "verify_fix_refused", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const wired: Record<string, Omit<McpTool, "name">> = {
    verify_fix: {
      description:
        "Replay a finding's reproduction (by mission result id — or a finished queue_exploration missionId — + fingerprint) N times in fresh browsers (default 3). status: fixed (signal absent on every replay) | still-reproduces | intermittent (fired on some but not all replays — never a pass) | inconclusive (replay could not reach the step — never a pass).",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, fingerprint: { type: "string" } },
        required: ["id", "fingerprint"],
      },
      handler: verifyFixTool,
    },
    get_mission_result: {
      description:
        "Read a mission's TYPED result by id: a result stem (explore-|coverage-|adversarial-|feature-|usability-<stamp>, e.g. adversarial-2026-09-23T00-00-00-000Z) or a queue_exploration missionId. A queued mission reports status queued | running (pending: true — poll again; `jevitate mission run` drains the queue) or failed (an error: it could not run). A finished one: status is clean | defects-found | hang | intermittent | inconclusive | crashed, with the matching CLI exit code. A broken run (inconclusive/crashed) is returned as an error result — never a pass. An adversarial result carries `coverage` (target controls exercised/total, forms submitted, strategies applied vs found nothing, out-of-scope steps): a run below its coverage thresholds is inconclusive, never clean.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      handler: getMissionResult,
    },
    find_capabilities: {
      description: "Find promoted Journeys (capabilities) whose metadata matches a query.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      handler: async (args) => jsonResult(await findCaps(typeof args.query === "string" ? args.query : "")),
    },
    run_journey: {
      description:
        "Run a PUBLISHED Journey by id with string params (fail-closed policy). Never accepts inline steps. " +
        "Optional 'storageState': a PATH (on the machine running this MCP server) to a Playwright storageState " +
        "JSON file, for a Journey authored behind a login (#118) — the file's contents are read only by the " +
        "server's own browser, never returned or logged. A Journey that declares metadata.requiresAuth refuses " +
        "with a clear error when no storageState is given.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          params: { type: "object", additionalProperties: { type: "string" } },
          storageState: { type: "string" },
        },
        required: ["id"],
      },
      handler: async (args) => {
        if (typeof args.id !== "string" || args.id.length === 0) {
          return errorResult({ error: "invalid_args", message: "run_journey requires a non-empty string 'id'" });
        }
        // Invariant #5: only id + params (+ storageState PATH) are threaded through — any inline
        // `steps`/`recording` in the arguments is deliberately ignored.
        const params =
          args.params && typeof args.params === "object" && !Array.isArray(args.params)
            ? (args.params as Record<string, string>)
            : {};
        const storageState = typeof args.storageState === "string" ? args.storageState : undefined;
        try {
          return jsonResult(await runJourney(args.id, params, storageState));
        } catch (err) {
          // A site-policy refusal (throttle, budget, quiet hours) is an answer the agent acts on — when to retry.
          if (err instanceof SiteGateRefusedError) {
            return errorResult({ error: "throttled", reason: err.reason, retryAfter: err.retryAfter, message: err.message });
          }
          throw err;
        }
      },
    },
    queue_exploration: {
      description:
        "Enqueue an exploration mission against a PROMOTED target. Never runs anything — only queues; `jevitate mission run` drains the queue, and get_mission_result {id: missionId} reports its status/result. strategy: goal-based (goal|feature|route + successAssertion) | coverage | adversarial (optional in-scope route glob) | feature (feature name, optional route glob). The target's authorized origin plus its declared apiOrigins are the only reachable origins. Refuses unknown/unpromoted targets, over-ceiling budgets and invalid declared `invariants` (an optional closed spec checked around every action; probes GET/HEAD on the target origin only). Optional 'viewport' ({width,height}) or 'device' (a Playwright devices registry name, e.g. \"iPhone 13\") — mutually exclusive (#149); default: Playwright's own default viewport. An unknown device is refused before any browser opens.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string" },
          goal: { type: "string" },
          feature: { type: "string" },
          route: { type: "string" },
          successAssertion: { type: "object" },
          strategy: { type: "string" },
          budget: {
            type: "object",
            properties: {
              maxActions: { type: "number" },
              maxDecisions: { type: "number" },
              maxCandidates: { type: "number" },
            },
          },
          // App-declared invariants (#86), inline only: a closed schema (observe: dom|network|probe,
          // invariants: require|never|always). Probes are GET/HEAD on the target's own origin; a spec
          // that does not validate refuses the enqueue.
          invariants: { type: "object" },
          // Per-mission viewport/device emulation (#149) — mutually exclusive.
          viewport: {
            type: "object",
            properties: { width: { type: "number" }, height: { type: "number" } },
            required: ["width", "height"],
          },
          device: { type: "string" },
        },
        required: ["target"],
      },
      handler: async (args) => {
        try {
          // All shape/budget/promoted-target validation is delegated to
          // `enqueueMission` (fail-closed). A refusal surfaces as a structured
          // error — NEVER a fabricated "queued" success.
          return jsonResult(await queueExploration(args));
        } catch (err) {
          return errorResult({
            error: "queue_exploration_refused",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    },
    ...(aiGenerateText
      ? {
          ai_generate_text: {
            description:
              "Generate a single text value for a form field via the model gateway. Credential-gated: a missing key returns a typed setup_required result; the key is NEVER sent to the model or returned.",
            inputSchema: {
              type: "object",
              properties: {
                fieldLabel: { type: "string" },
                goal: { type: "string" },
                visibleContext: { type: "string" },
                history: { type: "array", items: { type: "string" } },
              },
              required: ["fieldLabel", "goal", "visibleContext"],
            },
            handler: async (args) => {
              if (
                typeof args.fieldLabel !== "string" ||
                typeof args.goal !== "string" ||
                typeof args.visibleContext !== "string"
              ) {
                return errorResult({
                  error: "invalid_args",
                  message: "ai_generate_text requires string 'fieldLabel', 'goal' and 'visibleContext'",
                });
              }
              const history =
                Array.isArray(args.history) && args.history.every((h) => typeof h === "string")
                  ? (args.history as string[])
                  : undefined;
              try {
                // The facade applies `withPreflight` — a missing credential
                // returns a typed `setup_required` precondition (the model is
                // never called), which is a legitimate result surface, not an
                // error, so the host can collect the key and retry.
                return jsonResult(
                  await aiGenerateText({
                    fieldLabel: args.fieldLabel,
                    goal: args.goal,
                    visibleContext: args.visibleContext,
                    ...(history !== undefined ? { history } : {}),
                  }),
                );
              } catch (err) {
                // A provider/SDK error can echo request internals verbatim —
                // redact any credential value and return a generic, key-free
                // message. Never surface raw provider error text.
                const raw = err instanceof Error ? err.message : String(err);
                return errorResult({
                  error: "ai_generate_failed",
                  message: redactCredentials(raw, credentialStore),
                });
              }
            },
          },
        }
      : {}),
    list_incoming: {
      description: "List pending inbox items (HITL commands awaiting a human) as InboxSummary projections.",
      inputSchema: { type: "object", properties: {} },
      handler: inboxHandler((store) => facadeListIncoming(store)),
    },
    get_command: {
      description:
        "Agent poll for one inbox item by id (burn-after-read: consumes any human-provided secret input exactly once). Returns not_found for an unknown id.",
      inputSchema: idInputSchema,
      handler: inboxHandler((store, args) => facadeGetCommand(store, args)),
    },
    get_thread: {
      description: "Get the conversation thread (agent/human messages) for one inbox item by id. Never returns secret input.",
      inputSchema: idInputSchema,
      handler: inboxHandler((store, args) => facadeGetThread(store, args)),
    },
    queue_action: {
      description:
        "Enqueue a HITL inbox item requiring a human decision — kind defaults to 'approval' ('handback'/'review' also accepted). Never resolves anything; only queues.",
      inputSchema: {
        type: "object",
        properties: { ...queueCommonProperties, kind: { type: "string", enum: ["approval", "handback", "review"] } },
        required: queueCommonRequired,
      },
      handler: inboxHandler((store, args) => facadeQueueAction(store, args)),
    },
    queue_retrieval: {
      description:
        "Enqueue a HITL 'handback' inbox item requesting the human retrieve/provide something back to the agent. Never resolves anything; only queues.",
      inputSchema: { type: "object", properties: queueCommonProperties, required: queueCommonRequired },
      handler: inboxHandler((store, args) => facadeQueueRetrieval(store, args)),
    },
    approve_action: {
      description:
        "SM1: an agent can NEVER approve an inbox item over MCP — always refuses with human_approval_required. Approval is only permitted from the local jevitate UI.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      handler: async () => errorResult(facadeApproveAction()),
    },
    cancel_command: {
      description:
        "SM1: an agent can NEVER cancel an inbox item over MCP — always refuses with human_approval_required. Cancellation is only permitted from the local jevitate UI.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      handler: async () => errorResult(facadeCancelCommand()),
    },
    get_site_health: {
      description: "Report inbox store health: ok, pending count, age of the oldest pending item, and store version.",
      inputSchema: { type: "object", properties: {} },
      handler: inboxHandler((store) => facadeGetSiteHealth(store)),
    },
  };

  const notImplemented =
    (name: string): McpTool["handler"] =>
    async () =>
      errorResult({
        error: "not_implemented",
        tool: name,
        message: `tool '${name}' is allowlisted but not yet wired in this build`,
      });

  return ALLOWED_TOOLS.map((name) => {
    assertAllowlisted(name);
    const w = wired[name];
    if (w) return { name, ...w };
    return {
      name,
      description: `Allowlisted Jevitate tool '${name}' (not yet wired).`,
      inputSchema: { type: "object", properties: {} },
      handler: notImplemented(name),
    };
  });
}

/**
 * Constructs the MCP `Server` and registers its `tools/list` and `tools/call`
 * handlers off `buildMcpTools`. Does NOT open a transport — that is
 * `startMcpServer`'s job — so this is safe to construct in a unit test.
 */
export function createMcpServer(deps: McpApiDeps): Server {
  const tools = buildMcpTools(deps);
  const byName = new Map(tools.map((t) => [t.name, t]));

  // The real build identity (#112), never a placeholder: `version` is the published semver, and the
  // description names the commit/build time so an MCP client can tie a session to a build.
  const engine = deps.engine ?? currentEngineInfo();
  const server = new Server(
    {
      name: "jevitate",
      version: engine.version,
      description: `jevitate ${engine.version} (commit ${engine.commit}, built ${engine.builtAt})`,
    },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    // `McpToolResult` is a strict subset of the SDK's `CallToolResult` (which
    // carries an open index signature); the cast at this boundary keeps the
    // handler-authoring type strict while satisfying the SDK's result shape.
    // Defense in depth: a forbidden or unknown tool is NEVER dispatched.
    if (FORBIDDEN.has(name) || !byName.has(name)) {
      return errorResult({ error: "unknown_tool", tool: name }) as CallToolResult;
    }
    const tool = byName.get(name)!;
    try {
      return (await tool.handler((args ?? {}) as Record<string, unknown>)) as CallToolResult;
    } catch (err) {
      return errorResult({
        error: "tool_failed",
        tool: name,
        message: err instanceof Error ? err.message : String(err),
      }) as CallToolResult;
    }
  });

  return server;
}

/**
 * Starts the real MCP stdio server. Blocks (the transport owns stdin/stdout)
 * until the client disconnects — callers must NOT write to stdout while it
 * runs, since stdout is the MCP protocol channel.
 */
export async function startMcpServer(deps: McpApiDeps): Promise<void> {
  const server = createMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
