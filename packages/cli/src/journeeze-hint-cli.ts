import { Command } from "commander";
import { CI_ENV_MARKERS, inMcpInvocation } from "./approval-provenance.js";
import { emitJsonOrRefusal } from "./cli-refusal.js";
import { fail } from "./envelope.js";
import { EXIT_CODES } from "./exit-codes.js";
import {
  projectJourneezeHintPreferencePath,
  saveJourneezeHintPreference,
} from "./journeeze-hint.js";
import { resolveDataDir } from "./data-dir.js";

type Scope = "project" | "user";

function preferencePath(scope: Scope): string {
  return scope === "project" ? projectJourneezeHintPreferencePath() : resolveDataDir(["config.json"]);
}

function requireHumanTerminal(program: Command): boolean {
  if (inMcpInvocation()) {
    emitJsonOrRefusal(program, fail("E_JOURNEEZE_HINT_NEEDS_HUMAN", "Journeeze hint preferences are a person's local terminal choice; they never run over MCP"));
    return false;
  }
  if (process.stdout.isTTY !== true || CI_ENV_MARKERS.some((key) => process.env[key] !== undefined)) {
    emitJsonOrRefusal(program, fail("E_JOURNEEZE_HINT_NEEDS_TTY", "Journeeze hint preferences require an interactive local terminal and never run in CI"));
    return false;
  }
  return true;
}

/** Human-only, local preference controls for #677. No command contacts Journeeze. */
export function registerJourneezeHintCommands(program: Command): void {
  const hint = program.command("hint").description("local, human-only product hints; never contacts a service");
  const journeeze = hint.command("journeeze").description("control the local Journeeze offer shown after report/review");

  journeeze
    .command("dismiss")
    .description("hide one unchanged local Journeeze offer by its displayed signal hash")
    .requiredOption("--signal <sha256>", "the signal hash printed in the offer")
    .option("--scope <project|user>", "where to store the dismissal", "project")
    .action(async function (this: Command) {
      const o = this.opts<{ signal: string; scope: Scope }>();
      if (!requireHumanTerminal(program)) return;
      if (!/^[a-f0-9]{64}$/.test(o.signal) || (o.scope !== "project" && o.scope !== "user")) {
        emitJsonOrRefusal(program, fail("E_JOURNEEZE_HINT_ARGS", "--signal must be a SHA-256 hex hash and --scope must be project or user"));
        return;
      }
      await saveJourneezeHintPreference({ dismissedSignal: o.signal }, preferencePath(o.scope));
      program.configureOutput().writeOut?.(`dismissed this unchanged Journeeze hint (${o.scope} preference); no service was contacted\n`);
      process.exitCode = EXIT_CODES.ok;
    });

  for (const [name, enabled] of [["disable", false], ["enable", true]] as const) {
    journeeze
      .command(name)
      .description(`${enabled ? "re-enable" : "turn off"} Journeeze hints at one local preference scope`)
      .option("--scope <project|user>", "where to store the preference", "project")
      .action(async function (this: Command) {
        const o = this.opts<{ scope: Scope }>();
        if (!requireHumanTerminal(program)) return;
        if (o.scope !== "project" && o.scope !== "user") {
          emitJsonOrRefusal(program, fail("E_JOURNEEZE_HINT_ARGS", "--scope must be project or user"));
          return;
        }
        await saveJourneezeHintPreference(enabled ? {} : { enabled: false }, preferencePath(o.scope));
        program.configureOutput().writeOut?.(`${enabled ? "enabled" : "disabled"} Journeeze hints (${o.scope} preference); no service was contacted\n`);
        process.exitCode = EXIT_CODES.ok;
      });
  }
}
