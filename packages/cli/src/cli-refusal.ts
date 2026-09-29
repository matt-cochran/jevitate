import type { Command } from "commander";
import type { JsonEnvelope } from "./envelope.js";
import { emitEnvelope } from "./cli-output.js";
import { exitCodeForEnvelope } from "./exit-codes.js";

/**
 * THE refusal path for every command (#218). A command that refuses (`fail(code, message)`) prints
 * the `{v, ok:false, error}` envelope on stdout only when it was asked for JSON (`--json`); without
 * it, one human `error <CODE>: <message>` line (+ a `--help` hint for a usage error) on stderr, and
 * nothing on stdout. The exit code comes from exit-codes.ts either way (64 usage · 2 otherwise).
 *
 * The emitters that print envelopes (`emitJson` in program.ts, report/invariants/ai commands) all
 * route here, so which command is running — and whether IT was given `--json` — is looked up from
 * the command commander dispatched to (recorded by `trackActionCommand`), not threaded by hand.
 * A successful envelope is printed exactly as before: this module changes refusals only.
 */

const actionCommands = new WeakMap<Command, Command>();

/** Records, on every dispatch, the leaf command commander is about to run (a `preAction` hook on the root). */
export function trackActionCommand(program: Command): void {
  program.hook("preAction", (root, action) => {
    actionCommands.set(root, action);
  });
}

/** `ledger add`, `mission target update`, … — the command's path under the root program. */
export function commandPath(cmd: Command): string {
  const names: string[] = [];
  for (let c: Command | null = cmd; c !== null && c.parent !== null; c = c.parent) names.unshift(c.name());
  return names.join(" ");
}

/** Whether the running command asked for the JSON envelope. A command without a `--json` flag never did. */
function wantsJson(program: Command): { readonly json: boolean; readonly command?: string } {
  const action = actionCommands.get(program);
  if (action === undefined) return { json: true }; // not dispatched through the program (a direct call): unchanged
  const hasJsonFlag = action.options.some((o) => o.long === "--json");
  return { json: hasJsonFlag && action.opts<{ json?: boolean }>().json === true, command: commandPath(action) };
}

/**
 * Prints an envelope a command produced: a success as the envelope line (as it always was); a
 * refusal as the envelope with `--json`, else `error <CODE>: …` on stderr. Sets `process.exitCode`
 * (`exitCode` when the caller has a verdict code, else the envelope's class).
 */
export function emitJsonOrRefusal(program: Command, envelope: JsonEnvelope<unknown>, exitCode?: number): void {
  if (!envelope.ok) {
    const { json, command } = wantsJson(program);
    if (!json) {
      emitEnvelope(program, envelope, { json: false, ...(command === undefined ? {} : { command }), ...(exitCode === undefined ? {} : { exitCode }) });
      return;
    }
  }
  program.configureOutput().writeOut?.(`${JSON.stringify(envelope)}\n`);
  process.exitCode = exitCode ?? exitCodeForEnvelope(envelope);
}
