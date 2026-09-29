import { Command } from "commander";
import { envCredentialStore, FEATURE_KEYS, type Feature } from "@jevitate/ai-core";
import { loadLocalCredentials } from "./credentials-file.js";
import { ok, fail } from "./envelope.js";
import { initProjectDir, type ProjectInitReport } from "./project-dir.js";
import { realSecureIO } from "./ai-cli.js";
import { collectAllMissingKeys, type KeyCollectionReport } from "./init-keys.js";
import { formatInitKeysHuman } from "./cli-output.js";
import { detectRuntimes, resolveInstallTargetPaths, installSkills, type RuntimeId } from "./init-skills.js";
import { registerMcp, resolveMcpTargetPaths, type McpInstallReport } from "./init-mcp.js";
import { initNextSteps, environmentHint } from "./init-next-steps.js";
import { loadManifest } from "@jevitate/skills";
import { resolveDataDir } from "./data-dir.js";
import { type CliDeps, emitJson, emitCommandResult } from "./cli-shared.js";

/** Registers `jevitate init` (API keys, skills/MCP wiring, the repo's .jevitate/). */
export function registerInitCommands(program: Command, deps: CliDeps): void {
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
        // The "try this next" block, tailored to what is set up now (keys, MCP, the repo's
        // environments). Additive in --json (`data.nextSteps`); keys are checked by NAME only.
        const keysReady =
          data.keys !== undefined
            ? Object.values(data.keys as KeyCollectionReport).every((r) => (r.missing ?? []).length === 0)
            : (() => {
                const store = envCredentialStore(deps.ai?.env ?? process.env, deps.ai?.localConfig ?? loadLocalCredentials());
                return (Object.keys(FEATURE_KEYS) as Feature[]).every((f) => FEATURE_KEYS[f].every((k) => store.detect(k)));
              })();
        const projectDir = (data.project as ProjectInitReport | undefined)?.dir ?? null;
        data.nextSteps = initNextSteps({
          keysReady,
          ...environmentHint(projectDir),
          ...(data.mcp !== undefined ? { mcp: data.mcp as McpInstallReport[] } : {}),
          skills: data.skills !== undefined,
          dryRun: dryRun === true,
        });
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
          out?.(`next steps${(data.project as ProjectInitReport | undefined)?.dir == null ? "" : " (app URLs: .jevitate/environments.json)"}:\n`);
          for (const line of data.nextSteps as string[]) out?.(`  ${line}\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        emitCommandResult(program, fail("E_INIT", String(err instanceof Error ? err.message : err)), { json: json === true, command: "init" });
      }
    });
}
