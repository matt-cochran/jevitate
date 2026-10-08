import { Command } from "commander";
import { envCredentialStore, FEATURE_KEYS, featureReady, jevProviderOverride, type Feature } from "@jevitate/ai-core";
import { loadLocalCredentials } from "./credentials-file.js";
import { ok, fail } from "./envelope.js";
import { initProjectDir, type ProjectInitReport } from "./project-dir.js";
import { KeyCheckError, credentialInputs, enteredKeyCheck, realSecureIO } from "./ai-cli.js";
import { keySources, realVerifyFetch, shadowWarnings, verifyFeatureKeys } from "./key-report.js";
import { collectAllMissingKeys, type KeyCollectionReport } from "./init-keys.js";
import { formatInitKeysHuman } from "./cli-output.js";
import { detectRuntimes, resolveInstallTargetPaths, installSkills, uninstallSkills, type InstallReport, type RuntimeId, type UninstallReport } from "./init-skills.js";
import { currentEngineInfo } from "./engine.js";
import { CodeownersArgsError, installCodeowners, parseOwners, type CodeownersReport } from "./init-codeowners.js";
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
    .option("--replace-keys", "prompt (masked) for a new value of every key, even one already stored, and store it")
    .option("--no-verify", "skip the live auth check of each key (offline / CI): report presence and source only")
    .option("--skip-skills", "skip skill installation")
    .option("--skip-mcp", "skip registering the jevitate MCP server in detected harnesses")
    .option("--targets <ids>", "comma-separated runtime ids to force-install to, overriding detection")
    .option("--force", "overwrite a user-modified installed skill file/block or MCP config entry")
    .option("--dry-run", "report planned skill-install/mcp-register actions without writing")
    .option("--skip-project", "skip creating the repo's .jevitate/ (journeys, regressions, baselines, logs)")
    .option("--claude-md", "#431: also keep a marked jevitate block in the project's CLAUDE.md pointing at the installed skills (Claude Code only)")
    .option(
      "--codeowners <owners>",
      "#437: write/merge a marked CODEOWNERS block (.github/CODEOWNERS, or the repo's existing one) making .jevitate/journeys/, personas.json and jobs.json need these owners' review (\"@org/team @user\"); enable code-owner review in branch protection",
    )
    .option(
      "--uninstall",
      "#431: remove the skill files and marked AGENTS.md/CLAUDE.md blocks jevitate installed (user-modified ones are skipped unless --force); keys, MCP registration and .jevitate/ are left alone",
    )
    .action(async function (this: Command) {
      const { json, skipKeys, skipSkills, skipMcp, skipProject, targets, force, dryRun, replaceKeys, verify, claudeMd, uninstall, codeowners } = this.opts<{
        codeowners?: string;
        claudeMd?: boolean;
        uninstall?: boolean;
        replaceKeys?: boolean;
        verify: boolean;
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
        // #431: --uninstall only removes what the skill installer wrote, with the same never-clobber
        // rules; it never touches keys, MCP configs or the repo's .jevitate/.
        if (uninstall === true) {
          const runtimes = targets
            ? (targets.split(",").map((t) => t.trim()).filter((t) => t.length > 0) as RuntimeId[])
            : detectRuntimes(deps.init?.detection);
          const paths = resolveInstallTargetPaths(deps.init?.detection);
          const statePath = deps.init?.statePath ?? resolveDataDir(["skills-install-state.json"]);
          const removed = await uninstallSkills(runtimes, loadManifest(), paths, statePath, {
            ...(force === true ? { force: true } : {}),
            ...(dryRun === true ? { dryRun: true } : {}),
            ...(claudeMd === true ? { claudeMd: true } : {}),
          });
          if (json) {
            emitJson(program, ok({ uninstalled: removed }));
          } else {
            const out = program.configureOutput().writeOut;
            out?.(dryRun === true ? "jevitate: dry run — nothing was removed\n" : "jevitate skills uninstalled\n");
            for (const line of skillReportLines(removed)) out?.(`${line}\n`);
            process.exitCode = 0;
          }
          return;
        }
        if (codeowners !== undefined) parseOwners(codeowners); // refused (exit 64) before anything is written
        const data: Record<string, unknown> = { initialized: true };
        // The repo's own .jevitate/ (0.2.0 layout): Journeys, regressions and baselines live with the
        // app's code; logs stay local. Secrets and machine state stay in ~/.jevitate.
        if (!skipProject) data.project = initProjectDir(deps.init?.detection?.cwd?.() ?? process.cwd(), { ...(dryRun === true ? { dryRun: true } : {}) });
        // #437: the enforcement layer for approvals — code-owner review of .jevitate/ (with branch protection on the forge).
        if (codeowners !== undefined) {
          data.codeowners = await installCodeowners(deps.init?.detection?.cwd?.() ?? process.cwd(), codeowners, { ...(dryRun === true ? { dryRun: true } : {}) });
        }
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
          if (replaceKeys === true && !interactive) {
            throw new Error("--replace-keys needs an interactive terminal (stdin is not a TTY) — run `jevitate init --replace-keys` in a terminal");
          }
          const fetchFn = deps.ai?.verifyFetch ?? realVerifyFetch;
          // #291: each entered key is checked with its provider BEFORE it is stored.
          const gate = enteredKeyCheck(fetchFn);
          // #429: JEVITATE_JEV_PROVIDER pins which key judgment needs (an unknown value fails init).
          const jevProvider = jevProviderOverride(deps.ai?.env ?? process.env);
          const keys = await collectAllMissingKeys(store, io, {
            interactive,
            ...(jevProvider === undefined ? {} : { jevProvider }),
            ...(replaceKeys === true ? { replace: true } : {}),
            ...(verify ? { check: gate.check } : {}),
          });
          // #268: name every key's source; #291: verify every key the features use (env wins).
          const { env, localConfig } = credentialInputs(deps.ai);
          const nowLocal = { ...localConfig, ...Object.fromEntries(gate.entered) };
          const nowStore = envCredentialStore(env, nowLocal);
          for (const feature of Object.keys(keys) as Feature[]) {
            const r = keys[feature];
            const sources = keySources(feature, env, verify ? nowLocal : { ...localConfig, ...Object.fromEntries(r.collected.map((k) => [k, "set"])) }, jevProvider);
            const warnings = shadowWarnings(r.collected, sources);
            r.sources = sources;
            if (verify) r.verification = await verifyFeatureKeys(feature, nowStore, fetchFn, gate.verdicts, jevProvider);
            if (warnings.length > 0) r.warnings = warnings;
          }
          data.keys = keys;
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
          data.skills = await installSkills(runtimes, skills, paths, statePath, {
            force,
            dryRun,
            jevitateVersion: currentEngineInfo().version,
            ...(claudeMd === true ? { claudeMd: true } : {}),
          });
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
            ? Object.values(data.keys as KeyCollectionReport).every(
                (r) => (r.missing ?? []).length === 0 && !(r.verification ?? []).some((v) => v.status === "invalid"),
              )
            : (() => {
                const store = envCredentialStore(deps.ai?.env ?? process.env, deps.ai?.localConfig ?? loadLocalCredentials());
                const jevProvider = jevProviderOverride(deps.ai?.env ?? process.env);
                return (Object.keys(FEATURE_KEYS) as Feature[]).every((f) => featureReady(f, store, jevProvider));
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
          if (data.skills) {
            out?.(`skills: ${(data.skills as unknown[]).length} target/skill pairs ${dryRun === true ? "would be processed" : "processed"}\n`);
            for (const line of skillReportLines(data.skills as InstallReport[])) out?.(`${line}\n`);
          }
          if (data.mcp) out?.(`mcp: ${(data.mcp as unknown[]).length} harness config(s) ${dryRun === true ? "would be processed" : "processed"}\n`);
          const project = data.project as ProjectInitReport | undefined;
          if (project !== undefined) {
            out?.(
              project.dir === null
                ? `project: ${project.reason ?? "none"}\n`
                : `project: ${project.dir} (${project.created.length} ${dryRun === true ? "would create" : "created"})\n`,
            );
          }
          const owners = data.codeowners as CodeownersReport | undefined;
          if (owners !== undefined) {
            out?.(`codeowners: ${owners.path} (${dryRun === true && owners.action !== "unchanged" ? `would ${owners.action}` : owners.action}) — ${owners.owners.join(" ")}\n`);
            out?.(`  note: ${owners.note}\n`);
          }
          out?.(`next steps${(data.project as ProjectInitReport | undefined)?.dir == null ? "" : " (app URLs: .jevitate/environments.json)"}:\n`);
          for (const line of data.nextSteps as string[]) out?.(`  ${line}\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        const code = err instanceof KeyCheckError || err instanceof CodeownersArgsError ? err.code : "E_INIT";
        emitCommandResult(program, fail(code, String(err instanceof Error ? err.message : err)), { json: json === true, command: "init" });
      }
    });
}

/**
 * #431: the skill-install/uninstall actions a person must see — a file left alone because they
 * edited it, or refused because its markers are broken (with the fix) — and, for uninstall, what
 * was removed. `create`/`update`/`unchanged` stay in the count line above (and in --json).
 */
export function skillReportLines(reports: readonly (InstallReport | UninstallReport)[]): string[] {
  const lines: string[] = [];
  for (const r of reports) {
    if (r.action === "skip-user-modified") lines.push(`  skipped ${r.path}: you edited it (re-run with --force to replace it)`);
    else if (r.action === "refuse-malformed") lines.push(`  refused ${r.path}: ${r.reason ?? "its JEVITATE SKILLS markers are malformed"}`);
    else if (r.action === "remove" || r.action === "force-remove") lines.push(`  removed ${r.path}`);
  }
  return lines;
}
