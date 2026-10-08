import type { Command } from "commander";
import { RunTagError, parseRunTagSpecs } from "@jevitate/domain";
import { fail } from "./envelope.js";
import { emitEnvelope } from "./cli-output.js";
import { withRunMetadata } from "./run-metadata.js";

export const TAG_FLAG = "--tag <key=value>";
export const TAG_HELP = "run metadata tag stored in the result, its envelope and the run index (repeatable; key [A-Za-z0-9_.-]; never a secret)";
/** Commander collector for the repeatable `--tag`. */
export function collectTag(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** `--tag <key=value>` (repeatable) on a command that produces a run result. */
export function withTagFlag(cmd: Command): Command {
  return cmd.option(TAG_FLAG, TAG_HELP, collectTag, []);
}

/**
 * Wraps a command action (keeping its `this`): parses the command's `--tag`s — refused with
 * `E_TAG_ARGS` (exit 64) before anything runs — and runs the action inside their metadata scope.
 */
export function taggedAction<A extends unknown[]>(
  program: Command,
  command: string,
  action: (this: Command, ...args: A) => Promise<void> | void,
): (this: Command, ...args: A) => Promise<void> {
  return async function (this: Command, ...args: A): Promise<void> {
    const o = this.opts<{ tag?: string[]; json?: boolean }>();
    let tags: Record<string, string>;
    try {
      tags = parseRunTagSpecs(o.tag ?? []);
    } catch (err) {
      if (!(err instanceof RunTagError)) throw err;
      emitEnvelope(program, fail(err.code, err.message), { json: o.json === true, command });
      return;
    }
    await withRunMetadata({ tags }, () => action.apply(this, args));
  };
}
