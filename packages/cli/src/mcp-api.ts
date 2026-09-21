import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ALLOWED_TOOLS,
  FORBIDDEN_TOOLS,
  findCapabilities,
  queueExploration as facadeQueueExploration,
  aiGenerateText as facadeAiGenerateText,
  type AiGenerateTextArgs,
  type AiGenerateTextResult,
} from "@jevitate/mcp-facade";
import { FsJourneyStore, JourneyRegistry } from "@jevitate/journey";
import {
  FsMissionTargetStore,
  MissionTargetRegistry,
  FsMissionQueueStore,
} from "@jevitate/missions";
import {
  envCredentialStore,
  type CredentialStore,
  type GenerationPort,
  type SetupRequiredResult,
} from "@jevitate/ai-core";
import { safeRunPolicy } from "@jevitate/domain";
import { runJourneyProgrammatically } from "./journey-api.js";

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
   * Test seam. Defaults to the real promoted-only projection over the
   * journeys store (`@jevitate/mcp-facade`'s `findCapabilities`).
   */
  findCapabilities?: (query: string) => Promise<unknown>;
  /**
   * Test seam. Defaults to `runJourneyProgrammatically` with a fail-closed
   * `safeRunPolicy()` (invariant #5: PUBLISHED-id-only, never inline steps).
   */
  runJourney?: (id: string, params: Record<string, string>) => Promise<unknown>;
  /**
   * Promoted mission-target store directory (`~/.jevitate/missions/targets` in
   * production — the SAME store `jevitate mission target` writes). Required for
   * the default `queue_exploration` wiring; the host resolves it.
   */
  missionTargetsDir?: string;
  /** Mission queue directory (`~/.jevitate/missions/queue` in production). */
  missionQueueDir?: string;
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
  for (const key of ["OPENROUTER_API_KEY", "TYPESAFE_API_KEY"] as const) {
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
    ((id: string, params: Record<string, string>) =>
      runJourneyProgrammatically({ dir: deps.journeysDir, id, params, policy: safeRunPolicy() }));

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

  const wired: Record<string, Omit<McpTool, "name">> = {
    find_capabilities: {
      description: "Find promoted Journeys (capabilities) whose metadata matches a query.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      handler: async (args) => jsonResult(await findCaps(typeof args.query === "string" ? args.query : "")),
    },
    run_journey: {
      description:
        "Run a PUBLISHED Journey by id with string params (fail-closed policy). Never accepts inline steps.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          params: { type: "object", additionalProperties: { type: "string" } },
        },
        required: ["id"],
      },
      handler: async (args) => {
        if (typeof args.id !== "string" || args.id.length === 0) {
          return errorResult({ error: "invalid_args", message: "run_journey requires a non-empty string 'id'" });
        }
        // Invariant #5: only id + params are threaded through — any inline
        // `steps`/`recording` in the arguments is deliberately ignored.
        const params =
          args.params && typeof args.params === "object" && !Array.isArray(args.params)
            ? (args.params as Record<string, string>)
            : {};
        return jsonResult(await runJourney(args.id, params));
      },
    },
    queue_exploration: {
      description:
        "Enqueue an exploration mission against a PROMOTED target. Never runs anything — only queues. Refuses unknown/unpromoted targets and over-ceiling budgets.",
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

  const server = new Server(
    { name: "jevitate", version: "0.0.0" },
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
