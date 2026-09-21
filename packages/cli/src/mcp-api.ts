import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ALLOWED_TOOLS, FORBIDDEN_TOOLS, findCapabilities } from "@jevitate/mcp-facade";
import { FsJourneyStore, JourneyRegistry } from "@jevitate/journey";
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

/**
 * Builds the served tool descriptors — EXACTLY one per `ALLOWED_TOOLS` entry.
 * The journey-store-backed, dependency-light tools (`find_capabilities`,
 * `run_journey`) are wired to their real `@jevitate/mcp-facade` / CLI
 * surfaces; the remaining allowlisted tools are registered (so the served set
 * equals `ALLOWED_TOOLS`) but respond with a typed `not_implemented` error
 * until their backing services are wired in a follow-up ticket. No handler
 * ever fabricates a success.
 */
export function buildMcpTools(deps: McpApiDeps): McpTool[] {
  const findCaps =
    deps.findCapabilities ??
    ((query: string) => findCapabilities(new JourneyRegistry(new FsJourneyStore(deps.journeysDir)), query));

  const runJourney =
    deps.runJourney ??
    ((id: string, params: Record<string, string>) =>
      runJourneyProgrammatically({ dir: deps.journeysDir, id, params, policy: safeRunPolicy() }));

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
