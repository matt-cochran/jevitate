import { Command } from "commander";
import { registerDoctorCommand } from "./resource-preflight.js";
import { fail } from "./envelope.js";
import { registerLedgerCommands } from "./ledger-cli.js";
import { registerAiCommands } from "./ai-cli.js";
import { registerCheckCommand } from "./check-cli.js";
import { registerReportCommands } from "./report-cli.js";
import { registerInvariantsCommands } from "./invariants-validate.js";
import { currentEngineInfo } from "./engine.js";
import { EXIT_CODES } from "./exit-codes.js";
import { commandPath, trackActionCommand } from "./cli-refusal.js";
import {
  type RecordCliDeps,
  type CliDeps,
  resolveDbPath,
  resolveJourneysDir,
  resolveMissionTargetsDir,
  type BrowserLaunchFlags,
  withBrowserLaunchFlags,
  browserLaunchFromFlags,
  buildExploreGateways,
  fakeDoneJudge,
} from "./cli-shared.js";
import { registerInitCommands } from "./init-cli.js";
import { registerProfileCommands } from "./profile-cli.js";
import { registerSiteCommands } from "./site-cli.js";
import { registerRecordingCommands } from "./recording-cli.js";
import { registerJourneyCommands } from "./journey-cli.js";
import { registerSourceCommands } from "./source-cli.js";
import { registerLoadCommands } from "./load-cli.js";
import { registerExploreCommands } from "./explore-cli.js";
import { registerVerifyFixCommands } from "./verify-fix-cli.js";
import { registerAuthorJourneyCommands } from "./author-journey-cli.js";
import { registerDemoCommands } from "./demo-aspect-cli.js";
import { registerRecordCommands } from "./record-cli.js";
import { registerRegressionCommands } from "./regression-cli.js";
import { registerMissionCommands } from "./mission-cli.js";
import { registerServeCommands } from "./serve-cli.js";
import { registerUxCommands } from "./ux-cli.js";
import { registerLogsCommands } from "./logs-cli.js";
import { registerInboxCommands } from "./inbox-cli.js";

export type { CliDeps, RecordCliDeps } from "./cli-shared.js";
export { fakeDoneJudge } from "./cli-shared.js";

/**
 * `--version`'s display string: the published semver alone once that alone identifies the
 * build (a real npm install), plus commit/builtAt whenever the build could determine them (a
 * dev checkout / `npm link`ed working tree) — issue #83, "`jevitate --version` stays `0.1.0`
 * across 3 rebuilds in one hour ... nothing says which commit produced a result." `"unknown"`
 * (never shown here at all — omitted instead) rather than a fabricated commit/time.
 */
function versionString(): string {
  const engine = currentEngineInfo();
  if (engine.commit === "unknown" && engine.builtAt === "unknown") return engine.version;
  return `${engine.version} (commit ${engine.commit}, built ${engine.builtAt})`;
}

export function buildProgram(deps: CliDeps): Command {
  const program = new Command();
  program.name("jevitate").description("Autonomous browser testing that turns discovered bugs into deterministic regression tests").version(versionString());
  // #218: the shared refusal path (cli-refusal.ts) needs to know which command is running.
  trackActionCommand(program);

  registerInitCommands(program, deps);
  registerProfileCommands(program, deps);
  registerSiteCommands(program, deps);
  registerRecordingCommands(program, deps);
  registerJourneyCommands(program, deps);
  registerSourceCommands(program, deps);
  registerLoadCommands(program, deps);
  registerExploreCommands(program, deps, buildProgram);
  registerVerifyFixCommands(program, deps);

  // `ledger add|verify|list` (#195 part 6): the repro material verify-fix needs, kept by fingerprint.
  registerLedgerCommands(
    program,
    {
      ...(deps.explore?.targetsConfigPath === undefined ? {} : { targetsConfigPath: deps.explore.targetsConfigPath }),
      ...(deps.explore?.browserPortFactory === undefined ? {} : { browserPortFactory: deps.explore.browserPortFactory }),
      browserLaunch: (flags) => browserLaunchFromFlags(flags as BrowserLaunchFlags),
    },
    withBrowserLaunchFlags,
  );

  registerAuthorJourneyCommands(program, deps);
  registerDemoCommands(program, deps);
  registerRecordCommands(program, deps);
  registerRegressionCommands(program, deps);
  registerMissionCommands(program, deps);
  registerServeCommands(program, deps, buildProgram);
  registerInboxCommands(program, deps); // #254: MCP inbox tools from the CLI
  registerUxCommands(program, deps);
  registerAiCommands(program, deps);

  // #137 / #138 / #139 — CI gate, baseline diff and the consolidated defect report (own files).
  registerCheckCommand(
    program,
    {
      buildGateways: (sel) => buildExploreGateways(deps, sel),
      journeysDir: resolveJourneysDir(deps),
      sitePolicyDbPath: resolveDbPath(deps),
      ...(deps.explore?.targetsConfigPath === undefined ? {} : { targetsConfigPath: deps.explore.targetsConfigPath }),
      ...(deps.environmentsFile === undefined ? {} : { environmentsFile: deps.environmentsFile }),
      ...(deps.explore?.browserPortFactory === undefined ? {} : { browserPortFactory: deps.explore.browserPortFactory }),
      browserLaunch: (flags) => browserLaunchFromFlags(flags as BrowserLaunchFlags),
    },
    withBrowserLaunchFlags,
  );
  registerReportCommands(program, { missionTargetsDir: resolveMissionTargetsDir(deps) });
  registerLogsCommands(program, deps);
  registerInvariantsCommands(program);
  registerDoctorCommand(program); // #205: resource governance — host load, machine browser slots, orphans
  useUsageExitCode(program);

  return program;
}

/**
 * #210: a commander parse error (unknown option, missing argument or required option, bad choice)
 * is a usage error — exit 64 like every command's own argument errors, never 1 (defects found).
 * Wraps each command's `error()`, which every commander parse error goes through.
 */
function useUsageExitCode(cmd: Command): void {
  const original = cmd.error.bind(cmd);
  cmd.error = (message: string, errorOptions?: { code?: string; exitCode?: number }): never => {
    // An argParser's InvalidArgumentError (cli-args.ts) carries commander's generic exit code 1.
    const exitCode = errorOptions?.code === "commander.invalidArgument" ? EXIT_CODES.usage : (errorOptions?.exitCode ?? EXIT_CODES.usage);
    const bare = message.replace(/^error: /, "");
    // #218: a bad numeric value (cli-args.ts), unknown flag or missing argument under `--json` still
    // yields the one envelope line a machine caller parses; commander's human line goes to stderr.
    if (exitCode === EXIT_CODES.usage && rawArgsOf(rootOf(cmd)).includes("--json")) {
      const envelope = fail(usageParseErrorCode(cmd), bare);
      rootOf(cmd).configureOutput().writeOut?.(`${JSON.stringify(envelope)}\n`);
    }
    // #227: the human stderr line matches every other refusal's `error <CODE>: …` (+ a --help hint) —
    // never commander's own unlabeled `error: …` text, which used to be the only usage refusal
    // without a code (the code appeared only under --json).
    const path = commandPath(cmd);
    const human = exitCode === EXIT_CODES.usage ? `error ${usageParseErrorCode(cmd)}: ${bare}\nnext: jevitate ${path === "" ? "" : `${path} `}--help` : message;
    return original(human, { ...errorOptions, exitCode });
  };
  for (const sub of cmd.commands) useUsageExitCode(sub);
}

/**
 * The envelope code of a command line commander refused while parsing it (a usage error, 64): the
 * command's own `E_<COMMAND>_ARGS` (`explore` → E_EXPLORE_ARGS, `verify-fix` → E_VERIFY_FIX_ARGS),
 * the code its in-action argument checks already use; `E_CLI_ARGS` at the root (an unknown command).
 */
function usageParseErrorCode(cmd: Command): string {
  const path = commandPath(cmd);
  return `E_${path === "" ? "CLI" : path.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_ARGS`;
}

/** The command line as given (commander keeps it on the root; untyped). */
function rawArgsOf(root: Command): readonly string[] {
  const raw = (root as unknown as { rawArgs?: unknown }).rawArgs;
  return Array.isArray(raw) ? (raw as string[]) : [];
}

function rootOf(cmd: Command): Command {
  let c = cmd;
  while (c.parent !== null) c = c.parent;
  return c;
}
