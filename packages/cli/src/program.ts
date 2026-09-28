import { Command } from "commander";
import { envCredentialStore } from "@jevitate/ai-core";
import { loadLocalCredentials } from "./credentials-file.js";
import { ok, fail } from "./envelope.js";
import { initProjectDir, type ProjectInitReport } from "./project-dir.js";
import { registerLedgerCommands } from "./ledger-cli.js";
import { registerAiCommands, realSecureIO } from "./ai-cli.js";
import { registerCheckCommand } from "./check-cli.js";
import { registerReportCommands } from "./report-cli.js";
import { registerInvariantsCommands } from "./invariants-validate.js";
import { collectAllMissingKeys, type KeyCollectionReport } from "./init-keys.js";
import { currentEngineInfo } from "./engine.js";
import { EXIT_CODES } from "./exit-codes.js";
import { commandPath, trackActionCommand } from "./cli-refusal.js";
import { formatInitKeysHuman } from "./cli-output.js";
import { detectRuntimes, resolveInstallTargetPaths, installSkills, type RuntimeId } from "./init-skills.js";
import { registerMcp, resolveMcpTargetPaths } from "./init-mcp.js";
import { loadManifest } from "@jevitate/skills";
import { resolveDataDir } from "./data-dir.js";
import {
  type RecordCliDeps,
  type CliDeps,
  resolveDbPath,
  resolveJourneysDir,
  resolveMissionTargetsDir,
  type BrowserLaunchFlags,
  withBrowserLaunchFlags,
  browserLaunchFromFlags,
  emitJson,
  emitCommandResult,
  buildExploreGateways,
  fakeDoneJudge,
} from "./cli-shared.js";
import { registerLogsCommands } from "./logs-cli.js";
import { registerUxCommands } from "./ux-cli.js";
import { registerServeCommands } from "./serve-cli.js";
import { registerMissionCommands } from "./mission-cli.js";
import { registerRegressionCommands } from "./regression-cli.js";
import { registerRecordCommands } from "./record-cli.js";
import { registerAuthorJourneyCommands } from "./author-journey-cli.js";
import { registerVerifyFixCommands } from "./verify-fix-cli.js";
import { registerExploreCommands } from "./explore-cli.js";
import { registerLoadCommands } from "./load-cli.js";
import { registerSourceCommands } from "./source-cli.js";
import { registerJourneyCommands } from "./journey-cli.js";
import { registerRecordingCommands } from "./recording-cli.js";
import { registerSiteCommands } from "./site-cli.js";
import { registerProfileCommands } from "./profile-cli.js";

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

  program
    .command("init")
    .description("set up jevitate: collect API keys, install skills/MCP wiring, create the repo's .jevitate/")
    .option("--json", "emit a JSON envelope")
    .option("--skip-keys", "skip credential collection")
    .option("--skip-skills", "skip skill installation")
    .option("--skip-mcp", "skip registering the jevitate MCP server in detected harnesses")
    .option("--targets <ids>", "comma-separated runtime ids to force-install to, overriding detection")
    .option("--force", "overwrite a user-modified installed skill file/block or MCP config entry")
    .option("--dry-run", "report planned skill-install/mcp-register actions without writing")
    .option("--skip-project", "skip creating the repo's .jevitate/ (journeys, regressions, baselines, logs)")
    .action(async function (this: Command) {
      const { json, skipKeys, skipSkills, skipMcp, skipProject, targets, force, dryRun } = this.opts<{
        skipProject?: boolean;
        json?: boolean;
        skipKeys?: boolean;
        skipSkills?: boolean;
        skipMcp?: boolean;
        targets?: string;
        force?: boolean;
        dryRun?: boolean;
      }>();
      try {
        const data: Record<string, unknown> = { initialized: true };
        // The repo's own .jevitate/ (0.2.0 layout): Journeys, regressions and baselines live with the
        // app's code; logs stay local. Secrets and machine state stay in ~/.jevitate.
        if (!skipProject) data.project = initProjectDir(deps.init?.detection?.cwd?.() ?? process.cwd(), { ...(dryRun === true ? { dryRun: true } : {}) });
        if (!skipKeys) {
          // SECURITY: reuses the existing, already-guardrailed credential
          // collection. The report holds only key NAMES (required/collected/missing),
          // never a value — nothing here reads, echoes, logs, or returns a key.
          const store = envCredentialStore(deps.ai?.env ?? process.env, deps.ai?.localConfig ?? loadLocalCredentials());
          const io = deps.ai?.secureIO ?? realSecureIO();
          // #230: never prompt a non-interactive stdin (no TTY — how coding agents and CI run
          // `jevitate init`) — it would hang reading a 'line' event that never comes, or read EOF
          // silently. Report what's still missing instead; the rest of init still completes.
          const interactive = deps.init?.isInteractive?.() ?? process.stdin.isTTY === true;
          data.keys = await collectAllMissingKeys(store, io, { interactive });
        }
        // Explicit `--targets` overrides detection entirely (the user takes
        // full control); otherwise `detectRuntimes` decides, always including
        // the always-on generic fallback. Shared by the skill install and the
        // MCP registration so a single selection drives both.
        const runtimes = targets
          ? (targets.split(",").map((t) => t.trim()).filter((t) => t.length > 0) as RuntimeId[])
          : detectRuntimes(deps.init?.detection);

        if (!skipSkills) {
          const paths = resolveInstallTargetPaths(deps.init?.detection);
          const statePath = deps.init?.statePath ?? resolveDataDir(["skills-install-state.json"]);
          const skills = loadManifest();
          data.skills = await installSkills(runtimes, skills, paths, statePath, { force, dryRun });
        }
        if (!skipMcp) {
          // Register the `jevitate mcp` server for each detected/selected
          // harness, with the SAME never-clobber safety as skills: a user's
          // conflicting or unparseable config is never overwritten without
          // --force; each declined target reports a printable instruction
          // instead (honest, never corrupts a config). `generic` has no MCP
          // convention and is skipped inside `registerMcp`.
          const mcpPaths = resolveMcpTargetPaths(deps.init?.detection);
          data.mcp = await registerMcp(runtimes, mcpPaths, { force, dryRun });
        }
        // #230: exit 0 even when keys are still missing (the non-interactive path above) —
        // init's other work (project dir, skills, MCP registration) genuinely succeeded, and a
        // missing key is expected/normal for a fresh non-interactive install (CI, a coding
        // agent) that configures keys separately. The warning lives in `data.keys[*].missing`
        // (both here and in the --json envelope) rather than in the exit code, so a script that
        // only checks the exit code still sees init as having done its job; a caller that cares
        // about keys reads the summary/envelope, same as `jevitate ai status`.
        const envelope = ok(data);
        if (json) {
          emitJson(program, envelope);
        } else {
          const out = program.configureOutput().writeOut;
          // #213: --dry-run writes nothing — say "would" so the summary matches the disk.
          out?.(dryRun === true ? "jevitate: dry run — nothing was written\n" : "jevitate initialized\n");
          // #210/#230: per feature, "ready — n/n configured", or (no TTY on stdin) "not
          // configured — set X or run `jevitate ai setup <feature>`" — never a raw `collected:
          // []` that reads as "missing" when every key was already set.
          if (data.keys) out?.(`${formatInitKeysHuman(data.keys as KeyCollectionReport)}\n`);
          if (data.skills) out?.(`skills: ${(data.skills as unknown[]).length} target/skill pairs ${dryRun === true ? "would be processed" : "processed"}\n`);
          if (data.mcp) out?.(`mcp: ${(data.mcp as unknown[]).length} harness config(s) ${dryRun === true ? "would be processed" : "processed"}\n`);
          const project = data.project as ProjectInitReport | undefined;
          if (project !== undefined) {
            out?.(
              project.dir === null
                ? `project: ${project.reason ?? "none"}\n`
                : `project: ${project.dir} (${project.created.length} ${dryRun === true ? "would create" : "created"})\n`,
            );
          }
          out?.("next: jevitate explore --url <url> --goal \"<goal>\" --real (see jevitate explore --help)\n");
          process.exitCode = 0;
        }
      } catch (err) {
        emitCommandResult(program, fail("E_INIT", String(err instanceof Error ? err.message : err)), { json: json === true, command: "init" });
      }
    });

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

  registerRecordCommands(program, deps);

  registerRegressionCommands(program, deps);

  registerMissionCommands(program, deps);

  registerServeCommands(program, deps);

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
      ...(deps.explore?.browserPortFactory === undefined ? {} : { browserPortFactory: deps.explore.browserPortFactory }),
      browserLaunch: (flags) => browserLaunchFromFlags(flags as BrowserLaunchFlags),
    },
    withBrowserLaunchFlags,
  );
  registerReportCommands(program, { missionTargetsDir: resolveMissionTargetsDir(deps) });
  registerLogsCommands(program, deps);
  registerInvariantsCommands(program);
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
