import { CommanderError, type Command } from "commander";
import { EXIT_CODES } from "./exit-codes.js";

/**
 * #255 — the CLI, in process, for the MCP tools that mirror a CLI command (mcp-cli-tools.ts).
 *
 * MCP is a convenience for an agent that could run `jevitate … --json` itself, so these tools do
 * exactly that: build a fresh commander program (the SAME `buildProgram` the binary runs, over the
 * SAME stores `jevitate mcp` serves), parse the argv the tool built from its typed arguments, and
 * hand back the JSON envelope the command printed plus its exit code. Nothing is reimplemented, so
 * the two surfaces cannot drift: validation, path handling, redaction and exit codes are the CLI's.
 *
 * Safety of running it inside the MCP server process:
 * - stdout is the MCP protocol channel: every command's output (and commander's own parse/help
 *   text) is captured through `configureOutput` on every command in the tree — nothing reaches
 *   the real stdout. (No command reachable from an MCP tool writes to `process.stdout` directly;
 *   the one that does, `ai setup`'s interactive prompt, is excluded — mcp-cli-tools.ts.)
 * - commander never calls `process.exit`: `exitOverride` on every command turns a parse error
 *   into a typed usage refusal (exit 64).
 * - `process.exitCode` (how every action reports its contract code) is saved, read and restored,
 *   and calls are serialised, so one call's code never leaks into another's or into the server's.
 */

export interface CliRunOutcome {
  /** Everything the command wrote to (captured) stdout — with `--json`, its envelope line. */
  readonly stdout: string;
  /** The command's contract exit code (exit-codes.ts). */
  readonly exitCode: number;
}

export type McpCliRunner = (argv: readonly string[]) => Promise<CliRunOutcome>;

function configureTree(cmd: Command, write: (s: string) => void, discard: (s: string) => void): void {
  cmd.exitOverride();
  cmd.configureOutput({ writeOut: write, writeErr: discard, outputError: discard });
  for (const sub of cmd.commands) configureTree(sub, write, discard);
}

/** A runner over `build()` — called once per invocation, so no program state is shared between calls. */
export function makeInProcessCliRunner(build: () => Command): McpCliRunner {
  let queue: Promise<unknown> = Promise.resolve();
  const runOne = async (argv: readonly string[]): Promise<CliRunOutcome> => {
    let stdout = "";
    const program = build();
    configureTree(
      program,
      (s) => {
        stdout += s;
      },
      () => undefined,
    );
    const saved = process.exitCode;
    process.exitCode = undefined;
    try {
      await program.parseAsync([...argv], { from: "user" });
      const code = process.exitCode as number | string | undefined;
      return { stdout, exitCode: code === undefined ? 0 : Number(code) };
    } catch (err) {
      if (err instanceof CommanderError) {
        const envelope = { v: 1, ok: false, error: { code: "E_CLI_USAGE", message: err.message.replace(/^error: /, "") } };
        return { stdout: `${stdout}${JSON.stringify(envelope)}\n`, exitCode: EXIT_CODES.usage };
      }
      // An unexpected error: the command could not finish, so it proves nothing (bin.ts does the same).
      const envelope = { v: 1, ok: false, error: { code: "E_CLI_INTERNAL", message: err instanceof Error ? err.message : String(err) } };
      return { stdout: `${stdout}${JSON.stringify(envelope)}\n`, exitCode: EXIT_CODES.inconclusive };
    } finally {
      process.exitCode = saved;
    }
  };
  return (argv) => {
    const next = queue.then(() => runOne(argv));
    queue = next.catch(() => undefined);
    return next;
  };
}
