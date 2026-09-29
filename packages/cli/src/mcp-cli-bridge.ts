import type { Command } from "commander";
import { buildMcpTools, type McpApiDeps } from "./mcp-api.js";
import { logsRoot, resultDirsFor } from "./project-dir.js";
import { resolveDataDir } from "./data-dir.js";
import { commandPath } from "./cli-refusal.js";
import { fail, type JsonEnvelope } from "./envelope.js";
import { type CliDeps, resolveDbPath, resolveInboxDir, resolveJourneysDir, resolveMissionTargetsDir } from "./cli-shared.js";

/**
 * #254 — CLI parity with MCP. The CLI commands that mirror an MCP tool (`inbox …`, `mission queue`,
 * `mission result`) never reimplement its semantics: they call the SAME handler `jevitate mcp` serves
 * (`buildMcpTools`), built from the SAME default stores (`mcpToolDeps` — also what `jevitate mcp`
 * itself starts from), and print what it returned. So the CLI can never show more than MCP does.
 */

/** The dirs `jevitate mcp` serves by default (inbox, mission targets/queue, results); `over` narrows any of them. */
export function mcpToolDeps(deps: CliDeps, over: Partial<McpApiDeps> = {}): McpApiDeps {
  return {
    journeysDir: resolveJourneysDir(deps),
    sitePolicyDbPath: resolveDbPath(deps),
    missionTargetsDir: resolveMissionTargetsDir(deps),
    missionQueueDir: resolveDataDir(["missions", "queue"]),
    recordingsDir: logsRoot(),
    resultDirsFor: (resultId: string) => resultDirsFor(resultId),
    inboxDir: resolveInboxDir(deps),
    ...over,
  };
}

/** One MCP tool call's outcome: the handler's JSON body and whether MCP marked it an error result. */
export interface McpCallOutcome {
  readonly isError: boolean;
  readonly body: unknown;
}

/** Calls the served MCP tool `name` with `args` — exactly what an MCP client's `tools/call` reaches. */
export async function callMcpTool(apiDeps: McpApiDeps, name: string, args: Record<string, unknown>): Promise<McpCallOutcome> {
  const tool = buildMcpTools(apiDeps).find((t) => t.name === name);
  if (tool === undefined) throw new Error(`MCP tool '${name}' is not served by this build`);
  const result = await tool.handler(args);
  const text = result.content[0]?.text ?? "null";
  return { isError: result.isError === true, body: JSON.parse(text) as unknown };
}

/** The typed error an MCP handler returned (`{error: "not_found"}`, `{error: "invalid_args", message}`, …), if any. */
export function mcpErrorOf(body: unknown): { readonly error: string; readonly message?: string } | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const { error, message } = body as { error?: unknown; message?: unknown };
  if (typeof error !== "string") return undefined;
  return typeof message === "string" ? { error, message } : { error };
}

/**
 * The CLI refusal for an MCP typed error, with a code derived from the MCP one so the two surfaces
 * name the same failure: `invalid_args` → the command's own `E_<COMMAND>_ARGS` (64, like its parse
 * errors); `human_approval_required` → `E_HUMAN_APPROVAL_REQUIRED` (64); anything else →
 * `E_<PREFIX>_<ERROR>` (e.g. `E_INBOX_NOT_FOUND`, 64; `E_INBOX_INTERNAL`, 2 — exit-codes.ts).
 */
export function refusalFor(cmd: Command, prefix: string, err: { readonly error: string; readonly message?: string }, fallbackMessage: string): JsonEnvelope<never> {
  const message = err.message ?? fallbackMessage;
  if (err.error === "invalid_args") return fail(`E_${commandPath(cmd).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_ARGS`, message);
  if (err.error === "human_approval_required") return fail("E_HUMAN_APPROVAL_REQUIRED", message);
  return fail(`E_${prefix}_${err.error.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`, message);
}
