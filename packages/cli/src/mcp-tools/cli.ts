import { CLI_TOOL_SPECS, cliToolInputSchema, runCliTool } from "../mcp-cli-tools.js";
import type { McpToolCtx, McpToolGroup } from "./shared.js";
import { jsonResult, errorResult, redactCredentials } from "./shared.js";

/** #255: every CLI command without a hand-written tool, mirrored exactly and run in process. Adds to `wired`. */
export function cliTools(ctx: McpToolCtx, wired: McpToolGroup): void {
  const { deps, pathRoots, credentialStore } = ctx;
  // #255: every CLI command without a hand-written tool above — mirrored exactly, run in process.
  for (const spec of CLI_TOOL_SPECS) {
    if (wired[spec.name] !== undefined) throw new Error(`MCP tool '${spec.name}' is defined twice`);
    wired[spec.name] = {
      description: spec.description,
      inputSchema: cliToolInputSchema(spec),
      handler: async (args) => {
        const { isError, body } = await runCliTool(spec, args, { runCli: deps.runCli, roots: pathRoots, redact: (text) => redactCredentials(text, credentialStore) });
        return isError ? errorResult(body) : jsonResult(body);
      },
    };
  }
}
