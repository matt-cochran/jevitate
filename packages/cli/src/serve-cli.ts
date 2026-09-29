import { Command } from "commander";
import { envCredentialStore, OpenRouterGenerationGateway } from "@jevitate/ai-core";
import { loadLocalCredentials } from "./credentials-file.js";
import { fail } from "./envelope.js";
import { logsRoot, resultDirsFor } from "./project-dir.js";
import { startMcpServer } from "./mcp-api.js";
import { realOpenRouterCall } from "./openrouter-call.js";
import { startUiServer } from "./ui-api.js";
import { intArg } from "./cli-args.js";
import { renderPrintConfig, type McpHarness } from "./init-mcp.js";
import { resolveDataDir } from "./data-dir.js";
import {
  type CliDeps,
  resolveDbPath,
  resolveJourneysDir,
  resolveMissionTargetsDir,
  resolveInboxDir,
  emitJson,
  DEFAULT_EXPLORE_CATALOG,
  DEFAULT_EXPLORE_CONSTRAINTS,
} from "./cli-shared.js";

/** Registers the long-running servers: `jevitate mcp` and `jevitate ui`. */
export function registerServeCommands(program: Command, deps: CliDeps): void {
  // Additive: `jevitate mcp` (Ticket #20) — start an MCP stdio server that
  // exposes ONLY `@jevitate/mcp-facade`'s allowlisted tools (never the raw
  // browser primitives in FORBIDDEN_TOOLS). This is the subcommand form of the
  // MCP server (single-bundle deployment — no separate published package).
  // The server owns stdin/stdout as the MCP protocol channel, so on success it
  // blocks and writes NOTHING to stdout; only a setup failure (before the
  // transport connects) emits a JSON envelope.
  program
    .command("mcp")
    .description("start an MCP stdio server exposing only the allowlisted Jevitate tools")
    .option("--dir <path>", "journeys directory (default: ~/.jevitate/journeys)")
    .option(
      "--print-config <harness>",
      "print the config snippet to register `jevitate mcp` in a harness (claude | cursor | codex | json) and exit — prints only, writes nothing",
    )
    .action(async function (this: Command) {
      const { dir, printConfig } = this.opts<{ dir?: string; printConfig?: string }>();

      // `--print-config <harness>` is the universal escape hatch: render the
      // exact registration snippet and exit WITHOUT starting the server (safe:
      // no writes, no stdio takeover). An unknown harness is a fail envelope.
      if (printConfig !== undefined) {
        const harness = printConfig as McpHarness;
        if (harness !== "claude" && harness !== "cursor" && harness !== "codex" && harness !== "json") {
          emitJson(
            program,
            fail("E_MCP_PRINT_CONFIG", `--print-config must be one of claude | cursor | codex | json (got '${printConfig}')`),
          );
          return;
        }
        program.configureOutput().writeOut?.(`${renderPrintConfig(harness)}\n`);
        process.exitCode = 0;
        return;
      }

      try {
        // Credential store + generation gateway for the allowlisted
        // `ai_generate_text` tool. The gateway is the REAL OpenRouter adapter:
        // the key is read only inside it (Authorization header only), every
        // outbound payload passes the never-to-model guard, and the facade's
        // preflight returns a typed `setup_required` when the key is absent —
        // so no `--real/--fake` flag is needed for the non-interactive server.
        const aiStore = envCredentialStore(deps.ai?.env ?? process.env, deps.ai?.localConfig ?? loadLocalCredentials());
        const generationGateway =
          deps.ai?.gateway ??
          new OpenRouterGenerationGateway({
            store: aiStore,
            catalog: deps.ai?.catalog ?? DEFAULT_EXPLORE_CATALOG,
            constraints: deps.ai?.constraints ?? DEFAULT_EXPLORE_CONSTRAINTS,
            call: await realOpenRouterCall(),
          });
        await startMcpServer({
          journeysDir: resolveJourneysDir(deps, dir),
          sitePolicyDbPath: resolveDbPath(deps),
          missionTargetsDir: resolveMissionTargetsDir(deps),
          missionQueueDir: resolveDataDir(["missions", "queue"]),
          recordingsDir: logsRoot(),
          resultDirsFor: (resultId: string) => resultDirsFor(resultId),
          inboxDir: resolveInboxDir(deps),
          credentialStore: aiStore,
          generationGateway,
        });
      } catch (err) {
        emitJson(program, fail("E_MCP_SERVE", String(err instanceof Error ? err.message : err)));
      }
    });

  // Additive: `jevitate ui` (Task 8) — starts the local, loopback-only HTTP
  // HITL approval dashboard (ui-api.ts's `startUiServer`). Resolves the SAME
  // inbox dir `jevitate mcp`'s inbox tools serve (resolveInboxDir), so the
  // two commands agree on where approvals/handbacks/reviews live. On success
  // it prints the bound URL (carrying the capability token) and stays alive —
  // the open HTTP server keeps the process running, the same way `mcp`'s open
  // stdio transport does.
  program
    .command("ui")
    .description("start the local HITL approval dashboard (loopback-only HTTP server)")
    .option("--port <n>", "explicit port (fails on conflict; default 4180, retries on conflict)", intArg({ min: 0, max: 65535 }))
    .option("--no-open", "do not open the dashboard URL in the default browser")
    .option("--inbox-dir <path>", "inbox store directory (default: ~/.jevitate/inbox — same dir `jevitate mcp` serves)")
    .action(async function (this: Command) {
      const o = this.opts<{ port?: string; open?: boolean; inboxDir?: string }>();
      try {
        const start = deps.ui?.startUiServer ?? startUiServer;
        const handle = await start({
          inboxDir: resolveInboxDir(deps, o.inboxDir),
          open: o.open ?? true,
          ...(o.port !== undefined ? { port: Number(o.port) } : {}),
        });
        program.configureOutput().writeOut?.(`${handle.url}\n`);
      } catch (err) {
        emitJson(program, fail("E_UI_SERVE", String(err instanceof Error ? err.message : err)));
      }
    });
}
