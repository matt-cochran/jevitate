import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { withSiteGate } from "./site-gate-cli.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ALLOWED_TOOLS, FORBIDDEN_TOOLS, findCapabilities, type AiGenerateTextArgs, type AiGenerateTextResult } from "@jevitate/mcp-facade";
import { MissionTargetRegistry, FsMissionQueueStore } from "@jevitate/missions";
import { FsInboxStore } from "@jevitate/inbox";
import { envCredentialStore, type CredentialStore, type GenerationPort, type SetupRequiredResult } from "@jevitate/ai-core";
import type { JudgmentPort, UsageTracker } from "@jevitate/ai-core";
import type { ChangeScope, SelfHealer } from "@jevitate/runtime";
import type { EmulationSpec } from "@jevitate/playwright";
import { safeRunPolicy as defaultRunPolicy, type RunPolicy } from "@jevitate/domain";
import { runJourneyProgrammatically } from "./journey-api.js";
import { runVerifyFix, type RunVerifyFixOptions, type VerifyFixReport } from "./verify-fix-api.js";
import { type BrowserRunOptions } from "./browser-run-options.js";
import { type ResolvedJourneyEnvironment } from "./environments.js";
import { type MissionFixtures } from "./mission-fixtures.js";
import { type ScreenshotsSpec } from "./run-screenshots.js";
import { defaultMcpPathRoots } from "./mcp-paths.js";
import type { McpCliRunner } from "./mcp-cli-runner.js";
import { currentEngineInfo, type EngineInfo } from "./engine.js";
import { loadTargetsFile } from "./target-config.js";
import type { McpToolCtx } from "./mcp-tools/shared.js";
import { errorResult } from "./mcp-tools/shared.js";
import { findingTools } from "./mcp-tools/findings.js";
import { journeyTools } from "./mcp-tools/journey.js";
import { exploreTools } from "./mcp-tools/explore.js";
import { inboxTools } from "./mcp-tools/inbox.js";
import { cliTools } from "./mcp-tools/cli.js";


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
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  handler: (args: Record<string, unknown>) => Promise<McpToolResult>;
}

/** #255: what an extended `run_journey` call adds — every field resolved and validated by the handler. */
export interface McpJourneyRunOptions {
  readonly policy?: RunPolicy;
  readonly selfHealer?: SelfHealer;
  /** #453: the change context a hybrid/full self-heal is explained by (`changes`/`changeNote`). */
  readonly heal?: { readonly scope: ChangeScope };
  readonly environment?: ResolvedJourneyEnvironment;
  readonly browser?: BrowserRunOptions;
  readonly emulation?: EmulationSpec;
  readonly screenshots?: ScreenshotsSpec;
  readonly fixtures?: (site: string) => MissionFixtures | undefined;
  /** #303: record and compare each replayed step's action delta (`--action-deltas`). */
  readonly actionDeltas?: boolean;
  /** #486: the in-flight response bound of a step's responseStatus check (`--step-response-timeout`). */
  readonly stepResponseTimeoutMs?: number;
}

/**
 * #255: what `verify_fix` hands the runner — the finding (resolved result path + fingerprint) and
 * the CLI-parity replay options. Operator-only settings (shell hooks, `cmd:` log sources, re-sending
 * paid/destructive hang writes, redaction literals) are never MCP arguments: targets.json decides.
 */
export type McpVerifyFixArgs = Pick<RunVerifyFixOptions, "resultPath" | "fingerprint"> &
  Partial<Pick<RunVerifyFixOptions, "storageState" | "browser" | "replays" | "invariantFiles" | "fixtureFlags" | "emulation" | "allowEmulationOverride" | "screenshots" | "actionDeltas" | "allow" | "env" | "environmentsFile">>;

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
  runJourney?: (id: string, params: Record<string, string>, storageState?: string, options?: McpJourneyRunOptions) => Promise<unknown>;
  /**
   * #255: the directories MCP path arguments (storage states, fixtures, invariants, output dirs)
   * must resolve inside — default: the project and `~/.jevitate` (mcp-paths.ts).
   */
  pathRoots?: readonly string[];
  /** #255 (`run_journey {env}`): the environments file (default: the repo's `.jevitate/environments.json`). */
  environmentsFile?: string;
  /** `~/.jevitate/targets.json` override (environment sessions, verify_fix target config). */
  targetsConfigPath?: string;
  /**
   * #255 (`run_journey {selfHeal: hybrid|full}`): builds the self-heal gateways exactly as the CLI's
   * `--real`/`--fake-ai` do (`buildExploreGateways`). Absent: a heal mode is refused (setup_required).
   */
  selfHealGateways?: (sel: { real: boolean; fakeAi: boolean; jevProvider?: string | undefined }) => Promise<{ judge: JudgmentPort; gen: GenerationPort; usage: UsageTracker }>;
  /**
   * #255: the CLI in-process (mcp-cli-runner.ts) — backs every MCP tool that mirrors a CLI command
   * (mcp-cli-tools.ts). Absent: those tools refuse with `not_configured`.
   */
  runCli?: McpCliRunner;
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
   * Directory holding mission artifacts (the logs root in production): the typed
   * `<id>.result.json` files `get_mission_result` reads. A missing dir is a config refusal.
   */
  recordingsDir?: string;
  /**
   * Where usability reviews write their artifacts (0.1.0: `~/.jevitate/ux-reports`): a
   * `usability-<stamp>` result is looked up here after `recordingsDir`.
   */
  uxReportsDir?: string;
  /**
   * The directories a result id's files may be in, most likely first (production: its dated
   * `.jevitate/logs/<date>` dir in the project, then `~/.jevitate`, then the 0.1.0 locations).
   * Replaces `recordingsDir`/`uxReportsDir` for the lookup when given.
   */
  resultDirsFor?: (resultId: string) => string[];
  /**
   * Test seam. Defaults to `runVerifyFix` over `<recordingsDir>/<id>.result.json`: replays the
   * finding's repro in a fresh browser (authorized against the mission's own allowlist).
   */
  verifyFix?: (args: McpVerifyFixArgs) => Promise<VerifyFixReport>;
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
  const runJourney =
    deps.runJourney ??
    ((id: string, params: Record<string, string>, storageState?: string, o?: McpJourneyRunOptions) =>
      withSiteGate(deps.sitePolicyDbPath, (siteGate) =>
        runJourneyProgrammatically({
          dir: deps.journeysDir,
          id,
          params,
          policy: o?.policy ?? defaultRunPolicy(),
          ...(storageState !== undefined ? { storageState } : {}),
          ...(siteGate === undefined ? {} : { siteGate }),
          ...(o?.selfHealer === undefined ? {} : { selfHealer: o.selfHealer }),
          ...(o?.heal === undefined ? {} : { heal: o.heal }),
          ...(o?.environment === undefined ? {} : { environment: o.environment }),
          ...(o?.browser === undefined ? {} : { browser: o.browser }),
          ...(o?.emulation === undefined ? {} : { emulation: o.emulation }),
          ...(o?.screenshots === undefined ? {} : { screenshots: o.screenshots }),
          ...(o?.fixtures === undefined ? {} : { fixtures: o.fixtures }),
          ...(o?.actionDeltas === true ? { actionDeltas: true } : {}),
          ...(o?.stepResponseTimeoutMs === undefined ? {} : { stepResponseTimeoutMs: o.stepResponseTimeoutMs }),
        }),
      ));
  const pathRoots = deps.pathRoots ?? defaultMcpPathRoots();
  const credentialStore = deps.credentialStore ?? envCredentialStore();

  // verify_fix: replays a persisted finding by (result id, fingerprint) — never a caller-supplied
  // recording or path (invariant #5 analogue). Passes only if the defect signal is absent; an
  // unreachable replay is `inconclusive` and returned as an error result, never as "fixed".
  // #142 follow-up: a `cmd:` server-log source may only be re-run when the OPERATOR opted in for
  // this origin in ~/.jevitate/targets.json (`allowLogCmd: true`) — never via an MCP argument.
  const verifyFixImpl =
    deps.verifyFix ??
    ((a: McpVerifyFixArgs) =>
      runVerifyFix({
        targets: loadTargetsFile(deps.targetsConfigPath),
        resultPath: a.resultPath,
        fingerprint: a.fingerprint,
        ...(a.storageState === undefined ? {} : { storageState: a.storageState }),
        ...(a.browser === undefined ? {} : { browser: a.browser }),
        ...(a.replays === undefined ? {} : { replays: a.replays }),
        ...(a.invariantFiles === undefined ? {} : { invariantFiles: a.invariantFiles }),
        ...(a.fixtureFlags === undefined ? {} : { fixtureFlags: a.fixtureFlags }),
        ...(a.emulation === undefined ? {} : { emulation: a.emulation }),
        ...(a.allowEmulationOverride === undefined ? {} : { allowEmulationOverride: a.allowEmulationOverride }),
        ...(a.screenshots === undefined ? {} : { screenshots: a.screenshots }),
        ...(a.actionDeltas === true ? { actionDeltas: true } : {}),
        ...(a.allow === undefined ? {} : { allow: a.allow }),
        ...(a.env === undefined ? {} : { env: a.env }),
        ...(a.environmentsFile === undefined ? {} : { environmentsFile: a.environmentsFile }),
      }));

  const ctx: McpToolCtx = { deps, pathRoots, credentialStore, runJourney, verifyFixImpl };

  const wired: Record<string, Omit<McpTool, "name">> = {
    ...findingTools(ctx),
    ...journeyTools(ctx),
    ...exploreTools(ctx),
    ...inboxTools(ctx),
  };

  cliTools(ctx, wired);


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
