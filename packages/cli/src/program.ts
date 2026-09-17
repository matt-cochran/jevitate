import { Command } from "commander";
import type { ProfileManager } from "@doit/daemon";
import { ok, fail, type JsonEnvelope } from "./envelope.js";

export interface CliDeps {
  profiles: ProfileManager;
}

/**
 * Writes a JSON envelope using the program's CURRENTLY-CONFIGURED output
 * writer (read at call time via `configureOutput()`), so tests that call
 * `program.configureOutput({ writeOut })` after `buildProgram()` still see
 * output routed to their writer. Also sets `process.exitCode` (0 for `ok`,
 * 1 for `fail`) instead of hard-exiting, so `exitOverride()` in tests works.
 */
function emitJson(program: Command, envelope: JsonEnvelope<unknown>): void {
  const writeOut = program.configureOutput().writeOut;
  writeOut?.(`${JSON.stringify(envelope)}\n`);
  process.exitCode = envelope.ok ? 0 : 1;
}

export function buildProgram(deps: CliDeps): Command {
  const program = new Command();
  program.name("brauto").description("Local browser automation platform").version("0.0.0");

  program
    .command("init")
    .option("--json", "emit a JSON envelope")
    .action(function (this: Command) {
      const { json } = this.opts<{ json?: boolean }>();
      try {
        const envelope = ok({ initialized: true });
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.("brauto initialized\n");
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_INIT", String(err)));
      }
    });

  const profile = program.command("profile");

  profile
    .command("create <name>")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, name: string) {
      const { json } = this.opts<{ json?: boolean }>();
      try {
        const status = await deps.profiles.create(name);
        const envelope = ok(status);
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.(`profile '${status.name}' created at ${status.dir}\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_PROFILE_CREATE", String(err)));
      }
    });

  profile
    .command("status <name>")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, name: string) {
      const { json } = this.opts<{ json?: boolean }>();
      try {
        const status = await deps.profiles.status(name);
        const envelope = ok(status);
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.(
            `profile '${status.name}': ${status.exists ? "exists" : "missing"} (${status.dir})\n`
          );
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_PROFILE_STATUS", String(err)));
      }
    });

  return program;
}
