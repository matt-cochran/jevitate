import { Command } from "commander";
import { ok, fail } from "./envelope.js";
import { type CliDeps, emitJson, refuseUnsafeName } from "./cli-shared.js";

/** Registers `jevitate profile`: `create|status`. */
export function registerProfileCommands(program: Command, deps: CliDeps): void {
  const profile = program.command("profile").description("manage jevitate profiles (isolated credential/data sets)");

  profile
    .command("create <name>")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, name: string) {
      const { json } = this.opts<{ json?: boolean }>();
      if (refuseUnsafeName(program, name, "profile name")) return;
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
      if (refuseUnsafeName(program, name, "profile name")) return;
      try {
        const status = await deps.profiles.status(name);
        // #213: an unknown profile is a refusal (64), never a silent "missing" exit 0 — the caller
        // asked about a profile that was never created.
        if (!status.exists) {
          emitJson(program, fail("E_PROFILE_UNKNOWN", `unknown profile ${JSON.stringify(name)} (${status.dir})`));
          return;
        }
        const envelope = ok(status);
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.(`profile '${status.name}': exists (${status.dir})\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_PROFILE_STATUS", String(err)));
      }
    });
}
