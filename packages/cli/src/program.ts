import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import * as clack from "@clack/prompts";
import { SitePolicySchema, simulateTiming, type PlannedStep, type SitePolicy } from "@jevitate/domain";
import {
  RecordingSchema,
  AuthoringTakeSchema,
  PostdocDecisionsSchema,
  promoteToVariable,
  diffTakes,
  applyPostdoc,
  flattenBaseFillSteps,
  fitInteractionPolicy,
  type Recording,
  type AuthoringRecording,
  type ColumnClass,
  type PostdocDecision,
  type InvariantSpec,
} from "@jevitate/recording";
import { FsJourneyStore, JourneyRegistry, ParamValidationError } from "@jevitate/journey";
import {
  envCredentialStore,
  MissingCredentialError,
  OpenRouterGenerationGateway,
  UsageTracker,
  type JudgmentPort,
  type GenerationPort,
} from "@jevitate/ai-core";
import { loadLocalCredentials } from "./credentials-file.js";
import {
  FixtureNotFoundError,
  ScopeUnderivableError,
  UnauthorizedExploreTargetError,
  resolveCoverageThresholds,
  parseSecretField,
  SecretFieldSpecError,
  validateDenyPatterns,
  type CoverageThresholds,
  type SecretField,
  type SuccessCheck,
} from "@jevitate/explore";
import { BrowseTheWebToken } from "@jevitate/screenplay";
import { safeRunPolicy, type SelfHealMode } from "@jevitate/domain";
import { makeExploreSelfHealer } from "./self-heal-adapter.js";
import { ok, fail, type JsonEnvelope } from "./envelope.js";
import { SiteGateRefusedError, type SelfHealer } from "@jevitate/runtime";
import { runJourneyProgrammatically, promoteJourney, UnknownJourneyError, JourneyRequiresAuthError } from "./journey-api.js";
import { runJourneyLoadTest, UnknownLoadJourneyError } from "./load-api.js";
import {
  SessionFileInProjectError,
  assertSessionFileOutsideProject,
  initProjectDir,
  logsDirFor,
  logsRoot,
  resultDirsFor,
  type ProjectInitReport,
} from "./project-dir.js";
import { sitePolicyKey, withSiteGate } from "./site-gate-cli.js";
import { runRegressionCapture, runRegressionRun, RegressionNotFoundError, RegressionHardSignalOracleError, RegressionExistsError } from "./regression-api.js";
import {
  addMissionTarget,
  listMissionTargets,
  promoteMissionTarget,
  missionTargetContext,
  missionTargetAuth,
  updateMissionTargetAuth,
  withMissionTargetAuthFlags,
  UnknownMissionTargetError,
  type MissionTargetAuthFlags,
} from "./mission-api.js";
import { startMcpServer } from "./mcp-api.js";
import { FsMissionQueueStore } from "@jevitate/missions";
import { drainMissionQueue, needsModel, realQueuedMissionExecutor, type DrainReport } from "./mission-queue-runner.js";
import { runVerifyFix, VerifyFixInputError } from "./verify-fix-api.js";
import { registerLedgerCommands } from "./ledger-cli.js";
import { LedgerError, ledgerEntryFor } from "./ledger-api.js";
import { InvariantsFileError, loadInvariantFiles, resolveInvariantAuthTokens } from "./invariants-file.js";
import { realOpenRouterCall } from "./openrouter-call.js";
import { FilingConfigError, loadFilingFileConfig, resolveFilingConfig } from "./findings-filing.js";
import { GitHubIssueFiler } from "./github-issue-filer.js";
import { TargetConfigError, loadTargetsFile, resolveTargetConfig, type TargetConfig } from "./target-config.js";
import {
  buildMissionFixtures,
  checkSetupRefs,
  checkUrlRefOrigin,
  invariantSetupTexts,
  substituteSpecSetupRefs,
  fixtureSetupFailedResult,
  regressionFixtures,
  withFixtureFlags,
  type FixtureFlags,
} from "./fixture-cli.js";
import {
  FixtureSetupError,
  FixtureSpecError,
  SETUP_REF,
  UnboundSetupRefError,
  rebindReplayNavigation,
  substituteSetupRefs,
  type MissionFixtures,
} from "./mission-fixtures.js";
import type { FilingConfig, IssueFilerPort } from "@jevitate/domain";
import { startUiServer } from "./ui-api.js";
import { registerAiCommands, realSecureIO } from "./ai-cli.js";
import { registerCheckCommand } from "./check-cli.js";
import { registerReportCommands } from "./report-cli.js";
import { registerInvariantsCommands } from "./invariants-validate.js";
import { LITERAL_SECRET_WARNING, SecretArgError, resolveSecretArgs } from "./secret-args.js";
import { collectAllMissingKeys, type KeyCollectionReport } from "./init-keys.js";
import { currentEngineInfo, withEngine } from "./engine.js";
import { setKillSwitchOutput } from "./kill-signal.js";
import { EXIT_CODES } from "./exit-codes.js";
import { commandPath, trackActionCommand } from "./cli-refusal.js";
import { finiteNumberArg, intArg, positiveNumberArg, nonNegativeIntArg, positiveIntArg, ratioArg } from "./cli-args.js";
import {
  formatInitKeysHuman,
  formatMissionHuman,
  formatMultiRunHuman,
  formatRegressionCaptureHuman,
  formatRegressionRunHuman,
  formatVerifyFixHuman,
} from "./cli-output.js";
import { detectRuntimes, resolveInstallTargetPaths, installSkills, type RuntimeId } from "./init-skills.js";
import {
  registerMcp,
  resolveMcpTargetPaths,
  renderPrintConfig,
  type McpHarness,
} from "./init-mcp.js";
import { loadManifest } from "@jevitate/skills";
import {
  runExploration,
  runAuthorJourney,
  runCoverageMission,
  runAdversarialCliMission,
  CLI_ADVERSARIAL_STRATEGIES,
  runFeatureCliMission,
  parseAssertionSpec,
  parseSuccessSpec,
  resolveExploreAllowlist,
  type ServerLogOptions,
} from "./explore-api.js";
import { parseLogSourceSpecs, LogSourceSpecError } from "./log-sources.js";
import { parseLogDefectSpecs, parseLogIgnoreSpecs } from "./log-correlation.js";
import { LogSpecError } from "./log-lines.js";
import { MultiRunArgsError, resolveMultiRunPlan, wantsMultiRun } from "./multi-run.js";
import { MultiRunAbortedError, runExploreMultiRun } from "./multi-run-cli.js";
import { checkActorsAgainstSpec, resolveMissionActors, type MissionActors } from "./mission-actors.js";
import {
  discoverRecordingSidecars,
  loadRecordingSidecars,
  runUsabilityMission,
  runUxReview,
  UxAnalysisFailedError,
  UsabilityInvariantsUnsupportedError,
} from "./ux-api.js";
import { UxConfigError } from "./ux-config.js";
import { MinConfidenceError, QualityPolicyError, MaxFindingsPerRouteError } from "@jevitate/ux";
import { resolveDataDir } from "./data-dir.js";
import { runRecording, resolveRecordAllowlist } from "./record-api.js";
import {
  addSource,
  listSources,
  pullSource,
  updateSource,
  removeSource,
  trustJourney,
  publishJourneyToSource,
  realGhPort,
  NotPromotedError,
  NoDeclaredOriginsError,
} from "./source-api.js";
import { runSourceJourney, realResolvedJourneyRunner, type SourceRunApiDeps } from "./source-run-api.js";
import {
  UnknownSourceError,
  EmbeddedSecretError,
  UndeclaredOriginError,
  UndeclaredTouError,
  HashMismatchError,
  UntrustedRiskyJourneyError,
  SourceValidationError,
} from "@jevitate/sources";
import { type EmulationSpec } from "@jevitate/playwright";
import {
  type RecordCliDeps,
  type CliDeps,
  resolveDbPath,
  resolveJourneysDir,
  resolveRegressionsDir,
  resolveMissionTargetsDir,
  resolveInboxDir,
  resolveSourceApiDeps,
  resolveApprovedBy,
  makeRealBrowserActor,
  type BrowserLaunchFlags,
  withBrowserLaunchFlags,
  browserLaunchFromFlags,
  browserOption,
  type EmulationFlags,
  withEmulationFlags,
  emulationFromFlags,
  collectParam,
  withSitePolicyRepository,
  parsePlannedScript,
  emitJson,
  emitCommandResult,
  refuseUnsafeName,
  writeRawResult,
  writeHumanResult,
  stallTimeoutMs,
  EXPLORE_STRATEGIES,
  EXPLORE_OUTCOME_HELP,
  GatewaySelectionError,
  DEFAULT_EXPLORE_CATALOG,
  DEFAULT_EXPLORE_CONSTRAINTS,
  buildExploreGateways,
  fakeDoneJudge,
} from "./cli-shared.js";
import { registerLogsCommands } from "./logs-cli.js";

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

  const site = program
    .command("site")
    .description("per-site policies for Journey runs: human-like pacing, throttles, run budgets and quiet hours");
  const sitePolicy = site
    .command("policy")
    .description("read or set a site's policy (the site is the Journey's origin, e.g. https://app.example.com)");

  sitePolicy
    .command("get <site>")
    .description("print the policy for a site (an origin) and account")
    .option("--account <account>", "account id", "primary")
    .option("--db <path>", "sqlite db path")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, siteId: string) {
      const { account, db, json } = this.opts<{ account: string; db?: string; json?: boolean }>();
      try {
        const dbPath = resolveDbPath(deps, db);
        const policy = await withSitePolicyRepository(dbPath, (repository) => repository.get(sitePolicyKey(siteId), account));
        const envelope = ok(policy);
        if (json) {
          emitJson(program, envelope);
        } else {
          if (policy) {
            program.configureOutput().writeOut?.(
              `policy for '${siteId}' (version ${policy.version}): ${JSON.stringify(policy)}\n`
            );
          } else {
            program.configureOutput().writeOut?.(
              `no policy configured for '${siteId}' (account '${account}')\n`
            );
          }
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_SITE_POLICY_GET", String(err)));
      }
    });

  sitePolicy
    .command("set <site>")
    .description(
      "set the policy for a site (an origin): Journey runs there are paced, throttled, budgeted and kept out of quiet hours " +
        "(journey run, source run, check, MCP run_journey); load run applies the pacing only",
    )
    .requiredOption("--file <path>", "path to a policy JSON file")
    .option("--account <account>", "account id", "primary")
    .option("--db <path>", "sqlite db path")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, siteId: string) {
      const { account, db, file, json } = this.opts<{
        account: string;
        db?: string;
        file: string;
        json?: boolean;
      }>();
      let policy: SitePolicy;
      try {
        const raw = await readFile(file, "utf8");
        policy = SitePolicySchema.parse(JSON.parse(raw));
      } catch (err) {
        emitJson(program, fail("E_INVALID_POLICY", String(err)));
        return;
      }
      try {
        const dbPath = resolveDbPath(deps, db);
        // The policy is stored (and reported) under the site's origin: a page URL names its origin.
        const site = sitePolicyKey(siteId);
        await withSitePolicyRepository(dbPath, (repository) => repository.set(site, account, policy));
        const envelope = ok({ site, account, version: policy.version });
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.(
            `policy for '${site}' (account '${account}') set to version ${policy.version}\n`
          );
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_SITE_POLICY_SET", String(err)));
      }
    });

  site
    .command("simulate <site>")
    .description("estimate, offline, how long a planned step script takes under a site's pacing policy")
    .requiredOption("--script <path>", "path to a planned-step script JSON file")
    .option("--seed <n>", "deterministic RNG seed", "0")
    .option("--account <account>", "account id", "primary")
    .option("--db <path>", "sqlite db path")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, siteId: string) {
      const { account, db, script, seed, json } = this.opts<{
        account: string;
        db?: string;
        script: string;
        seed: string;
        json?: boolean;
      }>();
      let plannedScript: PlannedStep[];
      try {
        const raw = await readFile(script, "utf8");
        plannedScript = parsePlannedScript(raw);
      } catch (err) {
        emitJson(program, fail("E_INVALID_SCRIPT", String(err)));
        return;
      }
      const seedNum = Number(seed);
      if (!Number.isFinite(seedNum)) {
        emitJson(program, fail("E_INVALID_SEED", `--seed must be a finite number, got ${JSON.stringify(seed)}`));
        return;
      }
      try {
        const dbPath = resolveDbPath(deps, db);
        const policy = await withSitePolicyRepository(dbPath, (repository) => repository.get(sitePolicyKey(siteId), account));
        const interaction = policy?.interaction ?? {};
        const profile = simulateTiming(interaction, seedNum, plannedScript);
        const envelope = ok(profile);
        if (json) {
          emitJson(program, envelope);
        } else {
          const out = program.configureOutput().writeOut;
          for (const step of profile.steps) {
            out?.(`${step.kind} '${step.label}': ${step.delayMs}ms\n`);
          }
          out?.(`totalMs: ${profile.totalMs}\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_SITE_SIMULATE", String(err)));
      }
    });

  /**
   * Reads one "take file" for `recording diff`/`recording postdoc` (#124): a JSON object written
   * by `jevitate record` — `{ recording, values }` (`AuthoringTakeSchema`). A raw `Recording` — the
   * kind `explore`/`explore-author-journey`/a usability run emits directly, `{version, site, pages,
   * ...}` at the TOP level, no `recording`/`values` wrapper — is a common, easy mistake to hand
   * here; `AuthoringTakeSchema`'s `.strict()` rejects it with an opaque `Unrecognized keys: version,
   * site, intent, pages` zod dump. Detected BEFORE the schema parse so the caller gets a message
   * that names the actual problem and how to fix it, not a zod dump.
   */
  async function readAuthoringTake(file: string): Promise<AuthoringRecording> {
    const raw = await readFile(file, "utf8");
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw new Error(`'${file}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (json !== null && typeof json === "object" && !Array.isArray(json) && "pages" in json && !("recording" in json)) {
      throw new Error(
        `'${file}' looks like a Recording (it has a top-level "pages"), not a take file. ` +
          `'recording diff'/'recording postdoc' need a take file written by 'jevitate record' — shape ` +
          `{ recording, values } — not a raw Recording from 'explore', 'explore-author-journey', or a ` +
          `usability run. Wrap it as { "recording": <the Recording>, "values": {} } if you want to ` +
          `diff/postdoc it anyway.`,
      );
    }
    const parsed = AuthoringTakeSchema.parse(json);
    return { recording: parsed.recording, values: new Map(Object.entries(parsed.values)) };
  }

  const recording = program.command("recording").description("inspect and edit recorded takes (promote, edit steps, diff, postdoc)");

  recording
    .command("promote <file>")
    .requiredOption("--page <n>", "page index", nonNegativeIntArg)
    .requiredOption("--step <n>", "step index within the page", nonNegativeIntArg)
    .requiredOption("--var <name>", "variable name to bind")
    .action(async function (this: Command, file: string) {
      const { page, step, var: varName } = this.opts<{ page: string; step: string; var: string }>();
      try {
        const raw = await readFile(file, "utf8");
        const rec: Recording = RecordingSchema.parse(JSON.parse(raw));
        const result = promoteToVariable(rec, { page: Number(page), step: Number(step) }, varName);
        program.configureOutput().writeOut?.(`${JSON.stringify(result, null, 2)}\n`);
        process.exitCode = 0;
      } catch (err) {
        emitJson(program, fail("E_INVALID_RECORDING", String(err)));
      }
    });

  recording
    .command("diff <takeA> <takeB> [more...]")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, takeA: string, takeB: string, more: string[]) {
      const { json } = this.opts<{ json?: boolean }>();
      try {
        const files = [takeA, takeB, ...more];
        const takes: AuthoringRecording[] = await Promise.all(files.map(readAuthoringTake));
        const diffResult = diffTakes(takes);
        const envelope = ok(diffResult);
        if (json) {
          emitJson(program, envelope);
        } else {
          const out = program.configureOutput().writeOut;
          diffResult.columns.forEach((col: ColumnClass, i: number) => {
            const type = col.inferredType ? `, type=${col.inferredType}` : "";
            out?.(
              `column ${i}: ${col.kind} (confidence ${col.confidence.toFixed(2)}${type}) values=${JSON.stringify(col.values)}\n`
            );
          });
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_INVALID_TAKE", String(err)));
      }
    });

  recording
    .command("fit <file>")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, file: string) {
      const { json } = this.opts<{ json?: boolean }>();
      try {
        const raw = await readFile(file, "utf8");
        const rec: Recording = RecordingSchema.parse(JSON.parse(raw));
        const interaction = fitInteractionPolicy(rec);
        const policy: SitePolicy = { version: "1.0.0", interaction };
        if (json) {
          emitJson(program, ok(policy));
        } else {
          program.configureOutput().writeOut?.(`${JSON.stringify(policy, null, 2)}\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_INVALID_RECORDING", String(err)));
      }
    });

  recording
    .command("postdoc <take> [more...]")
    .option("--decisions <file>", "path to a PostdocDecision[] JSON file (non-interactive mode)")
    .option("--out <file>", "write the resulting Recording to this file instead of stdout")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, take: string, more: string[]) {
      const { decisions: decisionsFile, out, json } = this.opts<{
        decisions?: string;
        out?: string;
        json?: boolean;
      }>();
      try {
        const files = [take, ...more];
        const takes: AuthoringRecording[] = await Promise.all(files.map(readAuthoringTake));
        const diff = diffTakes(takes);

        let decisions: PostdocDecision[];
        if (decisionsFile !== undefined) {
          decisions = await loadDecisions(decisionsFile);
        } else {
          decisions = await promptForDecisions(takes[0]);
        }

        const result = applyPostdoc(takes[0], diff, decisions);

        if (out !== undefined) {
          await writeFile(out, `${JSON.stringify(result, null, 2)}\n`, "utf8");
        }
        if (json) {
          emitJson(program, ok(result));
        } else if (out === undefined) {
          program.configureOutput().writeOut?.(`${JSON.stringify(result, null, 2)}\n`);
          process.exitCode = 0;
        } else {
          process.exitCode = 0;
        }
      } catch (err) {
        if (err instanceof DecisionsParseError) {
          emitJson(program, fail("E_INVALID_DECISIONS", String(err.cause)));
        } else {
          emitJson(program, fail("E_INVALID_TAKE", String(err)));
        }
      }
    });

  const journey = program.command("journey").description("manage and run promoted Journeys (regression-test replays)");

  /**
   * `journey list` = ALL journeys' metadata via the store directly
   * (promoted AND unpromoted) — a local/dev-facing listing of everything on
   * disk. `journey find` (below) = promoted-only, via `JourneyRegistry.find`
   * — the same promoted-only projection external callers (e.g. the
   * mcp-facade) see. Keeping these distinct means `list` is useful for
   * authoring/debugging while `find` genuinely reflects what's discoverable.
   */
  journey
    .command("list")
    .option("--dir <path>", "journeys directory (default: ~/.jevitate/journeys)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command) {
      const { dir, json } = this.opts<{ dir?: string; json?: boolean }>();
      try {
        const store = new FsJourneyStore(resolveJourneysDir(deps, dir));
        const metas = await store.list();
        const envelope = ok(metas);
        if (json) {
          emitJson(program, envelope);
        } else {
          const out = program.configureOutput().writeOut;
          if (metas.length === 0) {
            out?.("no journeys yet — record one with `jevitate record` (see jevitate record --help)\n");
          } else {
            for (const m of metas) {
              out?.(`${m.id}\t${m.name}${m.promoted ? "" : " (unpromoted)"}\n`);
            }
          }
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_JOURNEY_LIST", String(err)));
      }
    });

  // RULING 5: uses `JourneyRegistry.find` (from `@jevitate/journey`) directly —
  // NEVER `@jevitate/mcp-facade`'s `findCapabilities` — Slice 1 forbids the CLI
  // depending on `@jevitate/mcp-facade`. `JourneyRegistry.find` is already
  // promoted-only, so this is the same promoted-only view without the
  // forbidden dependency.
  journey
    .command("find <query>")
    .option("--dir <path>", "journeys directory (default: ~/.jevitate/journeys)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, query: string) {
      const { dir, json } = this.opts<{ dir?: string; json?: boolean }>();
      try {
        const store = new FsJourneyStore(resolveJourneysDir(deps, dir));
        const registry = new JourneyRegistry(store);
        const metas = await registry.find(query);
        const capabilities = metas.map((m) => ({
          id: m.id,
          name: m.name,
          description: m.description,
          params: m.params,
        }));
        const envelope = ok(capabilities);
        if (json) {
          emitJson(program, envelope);
        } else {
          const out = program.configureOutput().writeOut;
          for (const c of capabilities) {
            out?.(`${c.id}\t${c.name}\tparams=[${c.params.join(", ")}]\n`);
          }
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_JOURNEY_FIND", String(err)));
      }
    });

  withBrowserLaunchFlags(withEmulationFlags(withFixtureFlags(journey.command("run <id>"))))
    .option("--dir <path>", "journeys directory (default: ~/.jevitate/journeys)")
    .option("--param <kv>", "param as key=value (repeatable)", collectParam, {} as Record<string, string>)
    .option(
      "--storage-state <file>",
      "Playwright storageState JSON to start the session authenticated (#118: required when the journey declares metadata.requiresAuth); must exist",
    )
    // Ticket #7 (additive): opt a run into scoped self-healing. Default
    // `fail-closed` preserves Slice 1 behavior exactly (no healer wired). A
    // write/irreversible step NEVER auto-heals in any mode (enforced by the
    // runtime's write floor). `hybrid`/`full` need an AI gateway, selected
    // with --real/--fake-ai (mirrors `explore`); requesting a heal mode
    // without one fails CLOSED, never a silent unhealed run.
    .option("--self-heal <mode>", "self-heal policy mode: fail-closed | hybrid | full", "fail-closed")
    .option("--real", "use live Jev + OpenRouter gateways for self-heal (requires keys)", false)
    .option("--fake-ai", "use deterministic fake gateways for self-heal (pipeline smoke only)", false)
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const fixtureFlags = this.opts<FixtureFlags>();
      const { dir, param, storageState, selfHeal, real, fakeAi, json, ...emulationFlags } = this.opts<{
        dir?: string;
        param: Record<string, string>;
        storageState?: string;
        selfHeal: string;
        real?: boolean;
        fakeAi?: boolean;
        json?: boolean;
      } & EmulationFlags>();

      if (storageState !== undefined && !existsSync(storageState)) {
        emitJson(program, fail("E_JOURNEY_RUN_ARGS", `storage state not found: ${storageState}`));
        return;
      }
      let journeyRunEmulation: EmulationSpec | undefined;
      try {
        journeyRunEmulation = emulationFromFlags(emulationFlags);
      } catch (err) {
        emitJson(program, fail("E_JOURNEY_RUN_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }

      if (selfHeal !== "fail-closed" && selfHeal !== "hybrid" && selfHeal !== "full") {
        emitJson(program, fail("E_SELF_HEAL_MODE", `--self-heal must be one of fail-closed | hybrid | full (got '${selfHeal}')`));
        return;
      }
      const selfHealMode = selfHeal as SelfHealMode;

      // When a heal mode is requested, build the SelfHealer HERE (this action
      // owns `deps` + the credential preflight); a missing/unselected gateway
      // fails CLOSED before any browser launch, rather than silently running
      // with no healer. fail-closed needs no gateway (identical to today).
      let selfHealer: SelfHealer | undefined;
      let policy = safeRunPolicy();
      // #163: a self-healing run makes model calls — their usage (and full cost) lands on its result.
      let healUsage: UsageTracker | undefined;
      if (selfHealMode !== "fail-closed") {
        let judge: JudgmentPort;
        let gen: GenerationPort;
        try {
          ({ judge, gen, usage: healUsage } = await buildExploreGateways(deps, { real: real ?? false, fakeAi: fakeAi ?? false }));
        } catch (err) {
          if (err instanceof MissingCredentialError || err instanceof GatewaySelectionError) {
            emitJson(program, fail("E_AI_SETUP_REQUIRED", err.message));
          } else {
            emitJson(program, fail("E_JOURNEY_RUN", String(err instanceof Error ? err.message : err)));
          }
          return;
        }
        selfHealer = makeExploreSelfHealer(judge, gen);
        policy = { ...policy, selfHeal: { mode: selfHealMode } };
      }

      try {
        // `runJourneyProgrammatically` validates params UP FRONT (before any
        // browser launch). The default policy stays `safeRunPolicy()`
        // (fail-closed secret mode) — only `selfHeal.mode` is threaded from
        // the flag; a `--secret-mode` override is a later slice's concern.
        const result = await withSiteGate(resolveDbPath(deps), (siteGate) => runJourneyProgrammatically({
          ...(siteGate === undefined ? {} : { siteGate }),
          dir: resolveJourneysDir(deps, dir),
          id,
          params: param,
          policy,
          selfHealer,
          browserPortFactory: deps.explore?.browserPortFactory,
          ...browserOption(this.opts<BrowserLaunchFlags>()),
          ...(journeyRunEmulation === undefined ? {} : { emulation: journeyRunEmulation }),
          ...(storageState !== undefined ? { storageState } : {}),
          // #140: fixture HTTP steps may only reach the journey's own site (authenticated from --storage-state).
          fixtures: (site) => {
            const fx = buildMissionFixtures(fixtureFlags, {
              allowlist: [site],
              baseUrl: site,
              ...(storageState !== undefined ? { storageState } : {}),
            });
            checkSetupRefs({ "--param": Object.values(param) }, fx);
            return fx;
          },
        })).then((r) => withEngine(healUsage === undefined ? r : { ...r, usage: healUsage.snapshot() }));
        const envelope = ok(result);
        if (json) {
          emitJson(program, envelope);
          // "ok" and "healed" (a recovered run) are both successes; only
          // "quarantined" is a non-zero exit.
          if (result.outcome === "quarantined") process.exitCode = 1;
        } else {
          writeRawResult(program, result);
          process.exitCode = result.outcome === "quarantined" ? 1 : 0;
        }
      } catch (err) {
        if (err instanceof SiteGateRefusedError) {
          emitJson(program, fail(err.code, err.message));
        } else if (err instanceof UnknownJourneyError) {
          emitJson(program, fail("E_UNKNOWN_JOURNEY", String(err.message)));
        } else if (err instanceof JourneyRequiresAuthError) {
          emitJson(program, fail("E_JOURNEY_REQUIRES_AUTH", String(err.message)));
        } else if (err instanceof FixtureSetupError) {
          // Never run on unknown state: inconclusive, a configuration error (exit 2).
          emitJson(
            program,
            ok(withEngine({ outcome: "inconclusive", reason: err.message, failure: { kind: "configuration", message: err.message }, attribution: "configuration" })),
          );
          process.exitCode = 2;
        } else if (err instanceof FixtureSpecError || err instanceof UnboundSetupRefError) {
          emitJson(program, fail(err.code, err.message));
        } else if (err instanceof ParamValidationError) {
          emitJson(program, fail("E_INVALID_PARAMS", String(err.message)));
        } else {
          emitJson(program, fail("E_JOURNEY_RUN", String(err)));
        }
      }
    });

  // #124 — promote a local Journey so it becomes discoverable/runnable (journey
  // find / MCP find_capabilities / run_journey), mirroring `mission target
  // promote`'s human-approval-gate semantics: promoting is a deliberate,
  // explicit act, never automatic (an authored Journey's `metadata.promoted`
  // always starts `false` — see `explore-author-journey`/`jevitate record`).
  journey
    .command("promote <id>")
    .description("promote a local Journey (human-approval gate) so it becomes discoverable/runnable")
    .option("--dir <path>", "journeys directory (default: ~/.jevitate/journeys)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const { dir, json } = this.opts<{ dir?: string; json?: boolean }>();
      try {
        const journeyResult = await promoteJourney(resolveJourneysDir(deps, dir), id);
        const envelope = ok(journeyResult.metadata);
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.(`promoted journey '${journeyResult.metadata.id}'\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        if (err instanceof UnknownJourneyError) {
          emitJson(program, fail("E_UNKNOWN_JOURNEY", String(err.message)));
        } else {
          emitJson(program, fail("E_JOURNEY_PROMOTE", String(err instanceof Error ? err.message : err)));
        }
      }
    });

  // #19 — publish a promoted local Journey to a registered distributed source.
  // Preserves every publish-side guard in `@jevitate/sources` (promoted-only,
  // secret-references-only, declared-origin coverage); writes onto a NEW
  // `publish/<id>` branch and degrades gracefully when `gh` is absent.
  journey
    .command("publish <id>")
    .requiredOption("--to <source>", "registered source name to publish into")
    .option("--dir <path>", "journeys directory (default: ~/.jevitate/journeys)")
    .option("--declare-origin <origin>", "origin this Journey is authorized for (repeatable; default: derived from navigate steps)", (v: string, prev: string[]) => [...prev, v], [] as string[])
    .option("--as <id>", "publish under a different id than the local one")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const { to, dir, declareOrigin, as: asId, json } = this.opts<{
        to: string;
        dir?: string;
        declareOrigin: string[];
        as?: string;
        json?: boolean;
      }>();
      try {
        const apiDeps = resolveSourceApiDeps(deps);
        const gh = deps.sources?.gh ?? realGhPort;
        const result = await publishJourneyToSource(
          { ...apiDeps, gh },
          {
            journeysDir: resolveJourneysDir(deps, dir),
            id,
            toSource: to,
            declareOrigins: declareOrigin,
            asId,
          },
        );
        const envelope = ok(result);
        if (json) {
          emitJson(program, envelope);
        } else {
          const out = program.configureOutput().writeOut;
          out?.(`published '${id}' to '${to}' on branch ${result.branch}\n`);
          if (result.prUrl) out?.(`PR: ${result.prUrl}\n`);
          else if (result.instructions) out?.(`${result.instructions}\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        if (err instanceof UnknownSourceError) {
          emitJson(program, fail("E_JOURNEY_PUBLISH_UNKNOWN_SOURCE", err.message));
        } else if (err instanceof UnknownJourneyError) {
          emitJson(program, fail("E_JOURNEY_PUBLISH_UNKNOWN_JOURNEY", err.message));
        } else if (err instanceof NotPromotedError) {
          emitJson(program, fail("E_JOURNEY_PUBLISH_NOT_PROMOTED", err.message));
        } else if (err instanceof NoDeclaredOriginsError) {
          emitJson(program, fail("E_JOURNEY_PUBLISH_NO_ORIGINS", err.message));
        } else if (err instanceof EmbeddedSecretError) {
          emitJson(program, fail("E_JOURNEY_PUBLISH_SECRET", err.message));
        } else if (err instanceof UndeclaredOriginError) {
          emitJson(program, fail("E_JOURNEY_PUBLISH_ORIGIN", err.message));
        } else {
          emitJson(program, fail("E_JOURNEY_PUBLISH", String(err instanceof Error ? err.message : err)));
        }
      }
    });

  // #18 — manage distributed Journey sources (add/list/pull/update/remove/
  // trust). Trust is an explicit user act, content-hash-bound; add/pull/update
  // never trust anything implicitly.
  const source = program.command("source").description("manage distributed Journey sources (git-backed collections of Journeys)");

  source
    .command("add <name> <gitUrl>")
    .option("--accept-tou", "acknowledge the source's declared Terms of Use (required before its Journeys can run)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, name: string, gitUrl: string) {
      const { acceptTou, json } = this.opts<{ acceptTou?: boolean; json?: boolean }>();
      try {
        const apiDeps = resolveSourceApiDeps(deps);
        const result = await addSource(apiDeps, {
          name,
          gitUrl,
          acceptTou: acceptTou ?? false,
          ackedBy: resolveApprovedBy(deps),
        });
        const envelope = ok(result);
        if (json) {
          emitJson(program, envelope);
        } else {
          const out = program.configureOutput().writeOut;
          out?.(`added '${name}' pinned at ${result.pinnedCommit}\n`);
          out?.(`Terms of Use for ${result.touSurface.gitUrl}:\n`);
          for (const site of result.touSurface.sites) out?.(`  ${site.origin}\t${site.touBasis}\n`);
          out?.(result.touAccepted ? "ToU acknowledged.\n" : "ToU NOT acknowledged — re-run with --accept-tou before running this source's Journeys.\n");
          process.exitCode = 0;
        }
      } catch (err) {
        if (err instanceof SourceValidationError) {
          emitJson(program, fail("E_SOURCE_INVALID_MANIFEST", err.message));
        } else {
          emitJson(program, fail("E_SOURCE_ADD", String(err instanceof Error ? err.message : err)));
        }
      }
    });

  source
    .command("list")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command) {
      const { json } = this.opts<{ json?: boolean }>();
      try {
        const listing = await listSources(resolveSourceApiDeps(deps));
        const envelope = ok(listing);
        if (json) {
          emitJson(program, envelope);
        } else {
          const out = program.configureOutput().writeOut;
          if (listing.length === 0) {
            out?.("no sources yet — add one with `jevitate source add <name> <gitUrl>`\n");
          } else {
            for (const s of listing) {
              out?.(`${s.name}\t${s.gitUrl}\t${s.pinnedCommit}\ttrusted=[${s.trustedJourneys.join(", ")}]\n`);
            }
          }
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_SOURCE_LIST", String(err instanceof Error ? err.message : err)));
      }
    });

  source
    .command("pull <name>")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, name: string) {
      const { json } = this.opts<{ json?: boolean }>();
      try {
        const result = await pullSource(resolveSourceApiDeps(deps), name);
        const envelope = ok(result);
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.(`pulled '${name}' (pin unchanged at ${result.pinnedCommit}; run 'source update' to advance)\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        if (err instanceof UnknownSourceError) {
          emitJson(program, fail("E_SOURCE_UNKNOWN", err.message));
        } else {
          emitJson(program, fail("E_SOURCE_PULL", String(err instanceof Error ? err.message : err)));
        }
      }
    });

  source
    .command("update <name>")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, name: string) {
      const { json } = this.opts<{ json?: boolean }>();
      try {
        const result = await updateSource(resolveSourceApiDeps(deps), name);
        const envelope = ok(result);
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.(`updated '${name}' -> pinned at ${result.pinnedCommit}\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        if (err instanceof UnknownSourceError) {
          emitJson(program, fail("E_SOURCE_UNKNOWN", err.message));
        } else {
          emitJson(program, fail("E_SOURCE_UPDATE", String(err instanceof Error ? err.message : err)));
        }
      }
    });

  source
    .command("remove <name>")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, name: string) {
      const { json } = this.opts<{ json?: boolean }>();
      try {
        const result = await removeSource(resolveSourceApiDeps(deps), name);
        const envelope = ok(result);
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.(`removed '${name}'\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        if (err instanceof UnknownSourceError) {
          emitJson(program, fail("E_SOURCE_UNKNOWN", err.message));
        } else {
          emitJson(program, fail("E_SOURCE_REMOVE", String(err instanceof Error ? err.message : err)));
        }
      }
    });

  source
    .command("trust <name> <journeyId>")
    .description("explicitly trust one Journey in a source, bound to its current content hash")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, name: string, journeyId: string) {
      const { json } = this.opts<{ json?: boolean }>();
      try {
        const result = await trustJourney(resolveSourceApiDeps(deps), {
          sourceName: name,
          journeyId,
          approvedBy: resolveApprovedBy(deps),
        });
        // Never emit the Journey's content — only the address + bound hash.
        const view = { sourceId: result.sourceId, journeyId: result.journeyId, contentHash: result.contentHash, approvedBy: result.approvedBy, approvedAtIso: result.approvedAtIso };
        const envelope = ok(view);
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.(`trusted '${name}/${journeyId}' at ${result.contentHash}\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        if (err instanceof UnknownSourceError) {
          emitJson(program, fail("E_SOURCE_UNKNOWN", err.message));
        } else if (err instanceof UnknownJourneyError) {
          emitJson(program, fail("E_SOURCE_UNKNOWN_JOURNEY", err.message));
        } else {
          emitJson(program, fail("E_SOURCE_TRUST", String(err instanceof Error ? err.message : err)));
        }
      }
    });

  // #26 — run a Journey that lives in a trusted remote source, THROUGH the
  // existing run-gate (`@jevitate/sources`' `resolveForRun`). RULING: this is a
  // `source run` subcommand (not `journey run --from-source`) because the whole
  // trust boundary is source-scoped — the `<source>/<id>` address, the
  // per-source manifest/ToU-ack/trust records all live under `source`. `journey
  // run` stays the LOCAL FsJourneyStore path; keeping remote runs here keeps the
  // two trust boundaries visibly separate. The run NEVER bypasses a gate: every
  // refusal below is a typed error thrown by `resolveForRun` BEFORE any browser.
  withBrowserLaunchFlags(withEmulationFlags(source.command("run <name> <journeyId>")))
    .description("run a Journey from a trusted remote source through the run-gate")
    .option("--param <kv>", "param as key=value (repeatable)", collectParam, {} as Record<string, string>)
    .option(
      "--storage-state <file>",
      "Playwright storageState JSON to start the session authenticated (#118: required when the journey declares metadata.requiresAuth); must exist",
    )
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, name: string, journeyId: string) {
      const { param, storageState, json, ...emulationFlags } = this.opts<{
        param: Record<string, string>;
        storageState?: string;
        json?: boolean;
      } & EmulationFlags>();
      if (storageState !== undefined && !existsSync(storageState)) {
        emitJson(program, fail("E_SOURCE_RUN_ARGS", `storage state not found: ${storageState}`));
        return;
      }
      let sourceRunEmulation: EmulationSpec | undefined;
      try {
        sourceRunEmulation = emulationFromFlags(emulationFlags);
      } catch (err) {
        emitJson(program, fail("E_SOURCE_RUN_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      try {
        const apiDeps: SourceRunApiDeps = {
          ...resolveSourceApiDeps(deps),
          runJourney: deps.sources?.runJourney ?? realResolvedJourneyRunner,
        };
        const result = withEngine(await withSiteGate(resolveDbPath(deps), (siteGate) => runSourceJourney(apiDeps, {
          ...(siteGate === undefined ? {} : { siteGate }),
          sourceName: name,
          journeyId,
          params: param,
          ...(sourceRunEmulation === undefined ? {} : { emulation: sourceRunEmulation }),
          ...(storageState !== undefined ? { storageState } : {}),
          ...browserOption(this.opts<BrowserLaunchFlags>()),
        })));
        const envelope = ok(result);
        if (json) {
          emitJson(program, envelope);
          if (result.outcome === "quarantined") process.exitCode = 1;
        } else {
          writeRawResult(program, result);
          process.exitCode = result.outcome === "quarantined" ? 1 : 0;
        }
      } catch (err) {
        // Each run-gate refusal maps to a distinct E_SOURCE_RUN* code so a
        // caller can tell WHY the run was refused without string-matching.
        if (err instanceof SiteGateRefusedError) {
          emitJson(program, fail(err.code, err.message));
        } else if (err instanceof UnknownSourceError) {
          emitJson(program, fail("E_SOURCE_RUN_UNKNOWN", err.message));
        } else if (err instanceof HashMismatchError) {
          emitJson(program, fail("E_SOURCE_RUN_HASH_MISMATCH", err.message));
        } else if (err instanceof UntrustedRiskyJourneyError) {
          emitJson(program, fail("E_SOURCE_RUN_UNTRUSTED", err.message));
        } else if (err instanceof UndeclaredOriginError) {
          emitJson(program, fail("E_SOURCE_RUN_ORIGIN", err.message));
        } else if (err instanceof UndeclaredTouError) {
          emitJson(program, fail("E_SOURCE_RUN_TOU", err.message));
        } else if (err instanceof EmbeddedSecretError) {
          emitJson(program, fail("E_SOURCE_RUN_SECRET", err.message));
        } else if (err instanceof SourceValidationError) {
          emitJson(program, fail("E_SOURCE_RUN_INVALID_MANIFEST", err.message));
        } else if (err instanceof ParamValidationError) {
          emitJson(program, fail("E_INVALID_PARAMS", err.message));
        } else if (err instanceof JourneyRequiresAuthError) {
          emitJson(program, fail("E_JOURNEY_REQUIRES_AUTH", err.message));
        } else {
          emitJson(program, fail("E_SOURCE_RUN", String(err instanceof Error ? err.message : err)));
        }
      }
    });

  const load = program.command("load").description("run a promoted Journey as a load test");

  withBrowserLaunchFlags(withEmulationFlags(load.command("run <journeyId>")))
    .option("--dir <path>", "journeys directory (default: ~/.jevitate/journeys)")
    .option("--param <kv>", "param as key=value (repeatable)", collectParam, {} as Record<string, string>)
    // `--authorized-origin` is mandatory, but enforced IN THE ACTION (below)
    // via a `fail` envelope rather than commander's `.requiredOption` — which
    // hard-exits via `process.exit`, inconsistent with this CLI's convention
    // of emitting a JSON envelope + setting `process.exitCode` (see emitJson).
    .option(
      "--authorized-origin <origin>",
      "allowed load-test target origin (repeatable) — required, fails closed if omitted",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option("--concurrency <n>", "pool size", positiveIntArg, 1)
    .option("--iterations <n>", "iterations per actor", positiveIntArg, 1)
    .option("--seed <n>", "master RNG seed", finiteNumberArg, 1)
    .option(
      "--storage-state <file>",
      "Playwright storageState JSON to start every actor's session authenticated (#118: required when the journey declares metadata.requiresAuth); must exist",
    )
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, journeyId: string) {
      const { dir, param, authorizedOrigin, concurrency, iterations, seed, storageState, json, ...emulationFlags } = this.opts<{
        dir?: string;
        param: Record<string, string>;
        authorizedOrigin: string[];
        concurrency: string;
        iterations: string;
        seed: string;
        storageState?: string;
        json?: boolean;
      } & EmulationFlags>();
      if (authorizedOrigin.length === 0) {
        emitJson(
          program,
          fail("E_LOAD_RUN", "at least one --authorized-origin is required (refusing to load-test with an empty allowlist)"),
        );
        return;
      }
      if (storageState !== undefined && !existsSync(storageState)) {
        emitJson(program, fail("E_LOAD_RUN_ARGS", `storage state not found: ${storageState}`));
        return;
      }
      let loadRunEmulation: EmulationSpec | undefined;
      try {
        loadRunEmulation = emulationFromFlags(emulationFlags);
      } catch (err) {
        emitJson(program, fail("E_LOAD_RUN_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      try {
        const report = await withSiteGate(resolveDbPath(deps), (siteGate) => runJourneyLoadTest({
          ...(siteGate === undefined ? {} : { siteGate }),
          dir: resolveJourneysDir(deps, dir),
          id: journeyId,
          params: param,
          concurrency: Number(concurrency),
          iterationsPerActor: Number(iterations),
          seed: Number(seed),
          authorizedOrigins: authorizedOrigin,
          browserPortFactory: deps.explore?.browserPortFactory,
          ...browserOption(this.opts<BrowserLaunchFlags>()),
          ...(loadRunEmulation === undefined ? {} : { emulation: loadRunEmulation }),
          ...(storageState !== undefined ? { storageState } : {}),
        })).then((r) => withEngine(r));
        const envelope = ok(report);
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.(`${JSON.stringify(report, null, 2)}\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        if (err instanceof UnknownLoadJourneyError) {
          emitJson(program, fail("E_UNKNOWN_JOURNEY", String(err.message)));
        } else if (err instanceof JourneyRequiresAuthError) {
          emitJson(program, fail("E_JOURNEY_REQUIRES_AUTH", String(err.message)));
        } else {
          emitJson(program, fail("E_LOAD_RUN", String(err instanceof Error ? err.message : err)));
        }
      }
    });

  withEmulationFlags(
    withFixtureFlags(
      withBrowserLaunchFlags(
        program
          .command("explore")
          .description("goal-directed exploration -> a deterministic Recording (authoring/test plane)"),
      ),
    ),
  )
    .option("--url <url>", "target URL (must be an authorized origin)")
    .option(
      "--strategy <name>",
      "exploration strategy: goal (default) | coverage | exploratory | adversarial | usability (UX review: ranked, cited findings)",
      "goal",
    )
    .option("--goal <text>", "natural-language goal / job (required for --strategy goal and usability)")
    .option("--app-class <class>", "app class for UX calibration (required for --strategy usability), e.g. consumer|admin|internal")
    .option(
      "--show <labels>",
      "opt-in filter on the quality grade (comma list of actionable,relevant-minor,generic,wrong); others are suppressed and counted; default JEVITATE_UX_SHOW, then ~/.jevitate/config.json ux.show, then ALL grades — the grader is uncalibrated (#133), so by default every finding is shown with its grade",
    )
    .option(
      "--min-confidence <n>",
      "(--strategy usability) findings below this FINDING confidence (0..1, a finding's own violation/applicability/grounding score — NOT its quality-grade confidence, a separate independent-grader number shown as finding.quality.confidence) are suppressed and counted in report.suppressed; default JEVITATE_UX_MIN_CONFIDENCE, then ~/.jevitate/config.json ux.minConfidence, then 0.3",
    )
    .option(
      "--max-findings-per-page <n>",
      "(--strategy usability) cap on UX findings per route/page, highest-confidence first; the rest are counted in report.suppressed as per-page-cap, never dropped silently; default JEVITATE_UX_MAX_FINDINGS_PER_PAGE, then ~/.jevitate/config.json ux.maxFindingsPerPage, then 5",
    )
    .option(
      "--success <spec>",
      [
        "independent success check (repeatable; every one must hold; --strategy goal and usability). Kinds:",
        "urlIncludes:<text> | visible:<d> | textIncludes:<d>|<text> (case-insensitive) | count:<d>|min=<n>,max=<n>",
        "| valueEquals:<d>|<value> (a form control's value) | reloadThen:<check> (reload first: proves it persisted)",
        "| visual state (#148, read and decided by code): style:<d>|<prop><op><value> (computed style of every match;",
        "<prop> an allowlisted CSS property or a channel of one, e.g. alpha(background-color)>0, color=rgb(255, 0, 0); op = != > >= < <=)",
        "| inViewport:<d>[|min=<ratio>] (visible fraction, default 0.5) | box:<d>|minWidth=<n>,maxWidth=<n>,minHeight=<n>,maxHeight=<n>",
        "| overlaps:<d>|<d2> | noOverlap:<d>|<d2> | attr:<d>|<name>=<value> (or <name> present, !<name> absent)",
        "| flashed:<d>|class=<cls> (or attr=<name>, animation)[|withinMs=<n>] (a transient state gained after the last user input)",
        "| requestMade:<METHOD> <path-glob> | responseStatus:<METHOD> <path-glob>=<2xx|4xx|code>.",
        "<d> is testId=..;role=..;name=..;label=..;text=..;css=.. or a CSS selector such as [data-testid=x].",
        "<path-glob> must start with \"/\" (it matches the request's path, e.g. /api/profile/* or /api/**); * as METHOD matches any method.",
        "e.g. --success 'requestMade:PUT /api/profile' --success 'reloadThen:valueEquals:[data-testid=last-name]|Litmus'.",
        "Omit it for a find-out goal (e.g. \"find out how many contacts... report the answer\"): the run must then end",
        "with the model's own `report` op, and the grounded answer (#101) is the verdict — no page/network check needed.",
      ].join(" "),
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--success-when <when>",
      "when the --success page checks must hold: final (default; on the final page) | held (on the final page, or all together at any settled step — a one-time secret, a toast). reloadThen is always final",
    )
    .option(
      "--allow-vacuous-checks",
      "downgrade a vacuous --success check to a warning. By default a check satisfied before the run's first action — a page check that held on the seed page and never changed " +
        "(an empty result container), a requestMade/responseStatus matched only by a page-load or polling request — FAILS: it cannot verify the goal",
    )
    .option("--feature <name>", "run the capability-scoped feature-testing mission (instead of --goal/--success)")
    .option(
      "--route <glob>",
      "in-scope route glob (repeatable), e.g. /thread/** — for --feature it replaces the default scope (the start URL's route and everything under it); it widens --strategy adversarial/coverage/exploratory beyond the start URL's route",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--scope <mode>",
      "--strategy coverage/exploratory: 'app' widens containment to the whole app (same as --route '/**'); default: the start URL's route plus --route globs",
    )
    .option(
      "--allow <origin>",
      "authorized origin (repeatable); REPLACES the default allowlist when given (the URL's own origin is used only when --allow is omitted entirely) -- include the URL's own origin explicitly if you still need it",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--secret <value|env:VAR>",
      "REDACTION ONLY: a secret/PII value kept out of every model call and artifact (repeatable); env:VAR reads it from the environment (preferred: a literal is visible in the process list and shell history). It is never typed into a field — to log in, bind it with --secret-field (or start from --storage-state)",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--secret-field <binding>",
      "goal/usability strategy: '<label|testId|type|id|name>=<value>=env:<VAR>' (repeatable), e.g. 'label=Password=env:APP_PASSWORD'. When the run types into a matching field, code types $VAR itself; the model sees only «secret:VAR» and the Recording {redacted:true}",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--totp <binding>",
      "goal/usability strategy: '<descriptor>=env:<VAR>' with $VAR a base32 TOTP seed (repeatable), e.g. 'label=Authentication code=env:APP_TOTP_SEED'. The 6-digit code is computed locally (RFC 6238) when the field is typed; the seed never reaches a model or disk",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--fixture <path>",
      "local file the upload op attaches to a file input (goal and usability strategies); must exist",
    )
    .option(
      "--storage-state <file>",
      "Playwright storageState JSON to start the session authenticated (deterministic login pre-step); must exist",
    )
    .option(
      "--actor <name=storageState>",
      "multi-actor mission (#147, goal only; repeatable): the FIRST actor is the primary (the only one the model drives, " +
        "from its own storageState); every other actor is an observer in its OWN fresh context that only runs the " +
        "--invariants' cross-actor checks (capture + probe as:/deniedAs) — never clicks or types. Replaces --storage-state",
      (v: string, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--save-storage-state <file>",
      "write the context's storageState (cookies + origin storage) here when the run ends; mode 0600, contents never logged. " +
        "Useful with a rotating refresh token: --storage-state's file goes stale after one authenticated run refreshes it, " +
        "so point --save-storage-state at the SAME file (or a new one) to keep it usable for the next run. " +
        "Written on every exit path -- a crash or a SIGTERM/SIGINT kill included (#159), not only a clean end -- but " +
        "never over a good file with a session that already looks lost/logged-out; the last known-good state is used " +
        "instead, or nothing is written if none was ever captured.",
    )
    .option("--max-actions <n>", "hard cap on executed actions", positiveIntArg)
    .option("--max-decisions <n>", "hard cap on model decisions", positiveIntArg)
    .option(
      "--stall-timeout <seconds>",
      "--strategy coverage/exploratory and --feature: end the run inconclusive (stalled) when no step completes within this many seconds (default 120)",
      positiveNumberArg,
    )
    .option(
      "--reply-wait-ms <ms>",
      "conversational pages: how long to keep waiting for a reply while the page shows no sign of working on one " +
        "(goal and usability; default 60000). While a request the message started is in flight, a busy indicator shows, " +
        "or the reply is still growing, the wait continues up to --reply-ceiling-ms",
      positiveIntArg,
    )
    .option(
      "--reply-ceiling-ms <ms>",
      "conversational pages: hard ceiling on one reply wait, however busy the page stays (default 180000; never below --reply-wait-ms)",
      positiveIntArg,
    )
    .option(
      "--reply-max-chars <n>",
      "conversational pages: cap on each generated chat message (goal and usability; default 300)",
      intArg({ min: 20, max: 2000 }),
    )
    .option(
      "--job-wait-ms <ms>",
      "goal and usability: while the page shows an in-progress status (\"Simulating…\", aria-busy, a job \"is running\"), " +
        "waits keep waiting with backoff — and a model 'blocked' is deferred — up to this budget (default: --reply-ceiling-ms, 180000)",
      positiveIntArg,
    )
    .option(
      "--deny <pattern>",
      "a control no mission may click (repeatable): an accessible-name regex (/Archive/i or Archive) or a descriptor role=button;name=Archive. " +
        "Session-ending (Sign out), destructive (Delete, Revoke, Rotate) and paid (Buy, Run simulation, Generate, Send invite) controls are refused by default",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--paid <pattern>",
      "an app control that costs money or credits (repeatable; same syntax as --deny), e.g. /^(Analyze|Draft|Improve)\\b/i: treated like the built-in paid " +
        "vocabulary — the budget guard sees it, hang replays never repeat it, and a goal that asks for it may still click it",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--allow-destructive",
      "let missions click session-ending, destructive and paid controls (a --deny pattern still holds). A goal run already may click one its goal asks for",
    )
    .option(
      "--allow-writes",
      "let a find-out goal (no --success check, ended by report) change the app. By default it is read-only: controls that start a write flow " +
        "(checkout, upgrade, create, save, submit…) are refused and the write requests an action fires are blocked, unless the goal itself asks for a change",
    )
    .option(
      "--allow-write <glob>",
      "a write-request path a read-only find-out goal never blocks (repeatable; ** spans segments; a glob starting with https:// matches " +
        "origin + path, e.g. https://abc.supabase.co/rest/v1/**), beyond the built-in auth-refresh ones " +
        "(**/refresh*, **/token*, **/oauth/**, **/auth/**/refresh*). The app's background writes outside an action always pass",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--read-rpc <glob>",
      "a POST request that only READS (repeatable): an RPC-method glob (Estimate*, pkg.Service/Preview*) or a path glob (/api/search*). " +
        "gRPC-web/Connect Get*/List*/Search*/Find*/Watch*/Stream*/Count*/Describe*/Read* methods are reads already. Reads are never guarded or reported as duplicate writes",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option("--real", "use live Jev + OpenRouter gateways (requires keys)", false)
    .option("--fake-ai", "use deterministic fake gateways (pipeline smoke only)", false)
    .option("--out <dir>", "directory to write the emitted Recording")
    .option(
      "--file-issues",
      "file findings as issues (needs a repo: --issue-repo or ~/.jevitate/filing.json); default: drafts only",
    )
    .option("--issue-repo <owner/name>", "the system-under-test repo findings for THIS target are filed to")
    .option("--hang-replays <n>", "fresh-context replays that confirm a hang (default 2; 0 = don't replay, the hang is reported unconfirmed)", nonNegativeIntArg)
    .option(
      "--hang-replay-writes",
      "let hang replays re-send a paid/destructive write the run sent (default: such a hang is reported inconclusive, never replayed)",
    )
    .option(
      "--settle-ignore <pattern>",
      "a request URL pattern the target marks as background (never pending work; repeatable, * wildcard)",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option("--long-poll-ms <n>", "a request pending this long on an interactive page is a long-poll (default 5000)", nonNegativeIntArg)
    .option(
      "--api-prefix <path>",
      "a path prefix whose requests are the app's API in the timing summary (repeatable), e.g. /api/",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--ignore-no-progress <pattern>",
      "a route / action label / busy indicator where ui-no-progress is expected (repeatable, * wildcard)",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option("--jevitate-repo <owner/name>", "where jevitate engine findings are filed (default matt-cochran/jevitate)")
    .option(
      "--min-control-coverage <ratio>",
      "adversarial: share of the target's controls (0..1) a run must exercise before 'found nothing' is clean (default 0.25); below it the run is inconclusive",
      ratioArg,
    )
    .option(
      "--no-require-form-submit",
      "adversarial: do not require a submitted form for a clean result (default: required when the target has a form)",
    )
    .option(
      "--invariants <file>",
      "app-declared invariants JSON (repeatable; goal, coverage, exploratory, adversarial, --feature): checked around every action, a violation is a defect (exit 1). Validated before any browser opens; probes are GET/HEAD on an --allow origin only",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--log-source <spec>",
      "backend log source (repeatable; every strategy, incl. usability): file:<path> (tailed from its current end) | docker:<container> (docker logs -f --since 0s) | cmd:<command> (needs --allow-log-cmd). Read-only, operator-declared, never the model's choice. Error/warning lines are correlated to the step they landed during and attached to its transcript evidence, redacted",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--allow-log-cmd",
      "opt-in: a --log-source cmd:<command> may run as a subprocess (operator-declared only; refused otherwise)",
      false,
    )
    .option(
      "--log-defect <level|/regex/>",
      "backend log lines matching this (repeatable) become a server-log defect: a level (error|warn|info|debug, matched as level>=this) or a /regex/flags/ over the raw line. Its fingerprint is the normalized message (ids/numbers/uuids/timestamps stripped) plus the correlated route; verify-fix re-checks it by re-tailing the same --log-source(s)",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--log-quiet-ok <spec>",
      "declares a --log-source spec (exact match, repeatable) as legitimately quiet: zero lines from it does not make the --log-defect oracle unhealthy (#169). Without it, a declared source that opened but delivered not one line makes an otherwise-clean run inconclusive, same as one that failed to open",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--log-ignore <regex|substring>",
      "excludes known-noise backend log lines (repeatable, /regex/flags/ over the raw line or a plain substring) from BOTH correlation and the --log-defect oracle (#169 item 3) — e.g. a periodic background job's own expected error. Counted separately as serverLogs.ignoredLines; never makes --log-quiet-ok unnecessary, since an ignored line still proves the source is being tailed",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--server-log-drain-ms <ms>",
      "how long to keep tailing --log-source after the run's last action, to catch async backend work that settles after the browser gave up (default 3000)",
      nonNegativeIntArg,
    )
    .option(
      "--repeat <n>",
      "run the mission N times, one after another, each in a fresh browser context, and vote (#141): findings seen in fewer than --min-agreement runs are reported as flaky, not counted",
    )
    .option("--min-agreement <k>", "with --repeat: runs a finding (and the outcome) must recur in to count (default: a majority of N)")
    .option(
      "--persona <name=storageState>",
      "run the same mission once per persona (repeatable), serially, each from its own storageState, and diff them (#143): requests, statuses (a 403 vs 200 is a candidate RBAC finding), controls, outcome",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option("--personas <file>", "personas JSON: {\"<name>\": \"<storageState>\"} or {\"personas\": [{\"name\", \"storageState\"}]}")
    .option(
      "--check-overflow",
      "check the horizontal-overflow hard signal (#149) even at a desktop (>=1024px) viewport — --strategy coverage/exploratory " +
        "(a defect), adversarial (a defect) or usability (a signal finding). " +
        "On by default whenever --viewport/--device emulates a viewport narrower than 1024px",
    )
    .option(
      "--ignore-overflow <selector>",
      "a CSS selector (repeatable) whose overflow is intentional — excluded from the horizontal-overflow signal, like --ignore-no-progress",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option("--json", "emit the JSON envelope (default: a human summary)")
    .addHelpText(
      "after",
      [
        "",
        "Authenticated missions:",
        "  --secret only REDACTS a value; it is never typed. Prefer starting logged in: save a Playwright",
        "  storageState once (e.g. `npx playwright codegen --save-storage=auth.json <url>`) and pass",
        "  --storage-state auth.json. To drive a login/signup form, bind fields to environment variables:",
        "  --secret-field 'label=Password=env:APP_PASSWORD' and, for MFA, --totp 'label=Code=env:APP_TOTP_SEED'.",
        "  See 'Authenticated missions' in the README.",
      ].join("\n"),
    )
    .addHelpText(
      "after",
      [
        "",
        "Viewport/device emulation (#149):",
        "  Default: Playwright's own default viewport (1280x720, desktop, no touch) — nothing narrower",
        "  unless --viewport or --device is given (mutually exclusive). --device validates against",
        "  Playwright's built-in devices registry (viewport + scale + mobile/touch + UA); an unknown",
        "  name is refused before any browser opens. The emulation is recorded on the Recording, so",
        "  verify-fix/regression replay reproduce under the SAME device by default.",
      ].join("\n"),
    )
    .addHelpText("after", EXPLORE_OUTCOME_HELP)
    .action(async function (this: Command) {
      const o = this.opts<{
        invariants: string[];
        logSource: string[];
        allowLogCmd?: boolean;
        logDefect: string[];
        logQuietOk: string[];
        logIgnore: string[];
        serverLogDrainMs?: string;
        actor: string[];
        repeat?: string;
        minAgreement?: string;
        persona: string[];
        personas?: string;
        minControlCoverage?: string;
        requireFormSubmit: boolean;
        fileIssues?: boolean;
        issueRepo?: string;
        hangReplays?: string;
        settleIgnore: string[];
        apiPrefix: string[];
        longPollMs?: string;
        ignoreNoProgress: string[];
        jevitateRepo?: string;
        url?: string;
        strategy?: string;
        goal?: string;
        appClass?: string;
        minConfidence?: string;
        maxFindingsPerPage?: string;
        show?: string;
        success: string[];
        successWhen?: string;
        allowVacuousChecks?: boolean;
        feature?: string;
        route: string[];
        scope?: string;
        allow: string[];
        secret: string[];
        secretField: string[];
        totp: string[];
        fixture?: string;
        storageState?: string;
        saveStorageState?: string;
        maxActions?: string;
        maxDecisions?: string;
        stallTimeout?: string | number;
        replyWaitMs?: string;
        replyCeilingMs?: string;
        replyMaxChars?: string;
        jobWaitMs?: string;
        deny: string[];
        paid: string[];
        allowDestructive?: boolean;
        allowWrites?: boolean;
        allowWrite: string[];
        hangReplayWrites?: boolean;
        readRpc: string[];
        real?: boolean;
        fakeAi?: boolean;
        out?: string;
        checkOverflow?: boolean;
        ignoreOverflow: string[];
        json?: boolean;
      } & BrowserLaunchFlags & FixtureFlags & EmulationFlags>();
      // #210: one output rule for every strategy — the envelope with --json, a human summary without.
      const emitExplore = (envelope: JsonEnvelope<unknown>, exitCode?: number, human: (data: unknown) => string = formatMissionHuman): void =>
        emitCommandResult(program, envelope, { json: o.json === true, command: "explore", human, ...(exitCode === undefined ? {} : { exitCode }) });

      // #230: an unknown --strategy must be refused before any other required-option message — it
      // would otherwise fall through to the default goal-strategy path and silently run a goal
      // mission. Checked first, ahead of every other validation below.
      if (o.strategy !== undefined && !EXPLORE_STRATEGIES.includes(o.strategy as (typeof EXPLORE_STRATEGIES)[number])) {
        emitExplore(fail("E_EXPLORE_ARGS", `unknown strategy ${JSON.stringify(o.strategy)} (one of ${EXPLORE_STRATEGIES.join(", ")})`));
        return;
      }

      // #195: a session file never lands in the repo's .jevitate/ (refused before any run, multi-runs included).
      if (o.saveStorageState !== undefined) {
        try {
          assertSessionFileOutsideProject(o.saveStorageState, "--save-storage-state");
        } catch (err) {
          if (!(err instanceof SessionFileInProjectError)) throw err;
          emitExplore(fail(err.code, err.message));
          return;
        }
      }
      const strategy = o.strategy ?? "goal";
      // #195: `--secret env:VAR` is resolved from the environment before anything runs (fail closed).
      try {
        const resolved = resolveSecretArgs(o.secret, process.env, "--secret");
        if (resolved.literals > 0) program.configureOutput().writeErr?.(LITERAL_SECRET_WARNING);
        o.secret = resolved.secrets;
      } catch (err) {
        if (!(err instanceof SecretArgError)) throw err;
        emitExplore(fail("E_EXPLORE_ARGS", err.message));
        return;
      }
      // Repeat-and-vote (#141) / persona matrix (#143): the same command, run sequentially and aggregated.
      if (wantsMultiRun(o)) {
        try {
          const plan = resolveMultiRunPlan(o);
          const result = await runExploreMultiRun({
            cmd: this,
            newProgram: () => buildProgram(deps),
            plan,
            strategy,
            ...(o.out === undefined ? {} : { out: o.out }),
            // #220: a killed multi-run prints ITS partial summary, by this command's own output rule.
            killOutput: (partial) => (o.json === true ? `${JSON.stringify(ok(withEngine(partial)))}\n` : formatMultiRunHuman(partial)),
          });
          emitExplore(ok(withEngine(result)), result.exitCode, formatMultiRunHuman);
        } catch (err) {
          if (err instanceof MultiRunArgsError) emitExplore(fail(err.code, err.message));
          else if (err instanceof MultiRunAbortedError) emitExplore(fail(err.envelope.error.code, err.envelope.error.message));
          else emitExplore(fail("E_EXPLORE_RUN", String(err instanceof Error ? err.message : err)));
        }
        return;
      }
      // #120: a killed run prints what this command would have printed — the envelope with --json,
      // else the human summary (#210) — before it exits.
      setKillSwitchOutput(o.json === true ? "envelope" : "human");
      const conversation = {
        ...(o.replyWaitMs === undefined ? {} : { replyWaitMs: Number(o.replyWaitMs) }),
        ...(o.replyCeilingMs === undefined ? {} : { replyCeilingMs: Number(o.replyCeilingMs) }),
        ...(o.replyMaxChars === undefined ? {} : { replyMaxChars: Number(o.replyMaxChars) }),
        ...(o.jobWaitMs === undefined ? {} : { jobWaitMs: Number(o.jobWaitMs) }),
      };
      if (
        (conversation.replyWaitMs !== undefined && !(Number.isInteger(conversation.replyWaitMs) && conversation.replyWaitMs > 0)) ||
        (conversation.replyCeilingMs !== undefined &&
          !(Number.isInteger(conversation.replyCeilingMs) && conversation.replyCeilingMs > 0)) ||
        (conversation.replyMaxChars !== undefined &&
          !(Number.isInteger(conversation.replyMaxChars) && conversation.replyMaxChars >= 20 && conversation.replyMaxChars <= 2000))
      ) {
        emitExplore(fail("E_EXPLORE_ARGS", "--reply-wait-ms and --reply-ceiling-ms must be positive integers; --reply-max-chars an integer in 20..2000"));
        return;
      }
      if (conversation.jobWaitMs !== undefined && !(Number.isInteger(conversation.jobWaitMs) && conversation.jobWaitMs > 0)) {
        emitExplore(fail("E_EXPLORE_ARGS", "--job-wait-ms must be a positive integer"));
        return;
      }
      // #154: refused BEFORE any browser opens. 0 is valid: "don't replay" — a hang is then
      // reported unconfirmed (inconclusive), never replayed and never a crash.
      if (o.hangReplays !== undefined && !/^\d+$/.test(o.hangReplays.trim())) {
        emitExplore(fail("E_EXPLORE_ARGS", `--hang-replays must be a non-negative integer (0 = don't replay; the hang is reported unconfirmed), got "${o.hangReplays}"`));
        return;
      }
      try {
        validateDenyPatterns(o.deny);
        validateDenyPatterns(o.paid, "--paid");
      } catch (err) {
        emitExplore(fail("E_EXPLORE_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      const browser = browserLaunchFromFlags(o);
      // #149: refused BEFORE any browser opens (an unknown --device, or --viewport + --device together).
      let emulation: EmulationSpec | undefined;
      try {
        emulation = emulationFromFlags(o);
      } catch (err) {
        emitExplore(fail("E_EXPLORE_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      const overflow = { checkOverflow: o.checkOverflow ?? false, ignoreSelectors: o.ignoreOverflow };
      // Issue filing: drafts are always written; filing needs --file-issues (or config) AND a repo.
      let filing: FilingConfig | undefined;
      if (o.url !== undefined) {
        try {
          filing = resolveFilingConfig(
            loadFilingFileConfig(deps.explore?.filingConfigPath),
            {
              ...(o.fileIssues === undefined ? {} : { fileIssues: o.fileIssues }),
              ...(o.issueRepo === undefined ? {} : { issueRepo: o.issueRepo }),
              ...(o.jevitateRepo === undefined ? {} : { jevitateRepo: o.jevitateRepo }),
            },
            new URL(o.url).origin,
          );
        } catch (err) {
          if (err instanceof FilingConfigError) {
            emitExplore(fail(err.code, err.message));
            return;
          }
          if (!(err instanceof TypeError)) throw err;
          // An unparseable --url is refused by the authorized-target guard below.
        }
      }
      // Per-target settle/hang configuration: ~/.jevitate/targets.json by origin, plus flags.
      let target: TargetConfig | undefined;
      if (o.url !== undefined) {
        try {
          target = resolveTargetConfig(loadTargetsFile(deps.explore?.targetsConfigPath), new URL(o.url).origin, {
            settleIgnore: o.settleIgnore,
            ignoreNoProgress: o.ignoreNoProgress,
            apiPrefixes: o.apiPrefix,
            deny: o.deny,
            paid: o.paid,
            readRpc: o.readRpc,
            ...(o.allowDestructive === true ? { allowDestructive: true } : {}),
            ...(o.allowWrites === true ? { allowWrites: true } : {}),
            allowWrite: o.allowWrite,
            ...(o.hangReplayWrites === true ? { hangReplayWrites: true } : {}),
            ...(o.longPollMs === undefined ? {} : { longPollMs: Number(o.longPollMs) }),
          });
        } catch (err) {
          if (err instanceof TargetConfigError) {
            emitExplore(fail(err.code, err.message));
            return;
          }
          if (!(err instanceof TypeError)) throw err;
        }
      }
      const issueFiler =
        deps.explore?.issueFiler ??
        ((): IssueFilerPort =>
          new GitHubIssueFiler({ store: envCredentialStore(process.env, loadLocalCredentials()) }));
      // `--fixture` feeds the upload op, which only the explore loop (goal and
      // usability strategies) can issue. Refuse it elsewhere rather than
      // silently ignoring a file the user expected to be uploaded.
      if (o.fixture !== undefined && (o.feature !== undefined || (strategy !== "goal" && strategy !== "usability"))) {
        emitExplore(fail("E_EXPLORE_ARGS", "--fixture is supported only with --strategy goal or usability"));
        return;
      }
      // #225: success checks judge a goal / a usability job — every other strategy (and --feature) would
      // silently ignore them, so they are refused up front, never dropped.
      if (
        (o.success.length > 0 || o.successWhen !== undefined || o.allowVacuousChecks === true) &&
        (o.feature !== undefined || (strategy !== "goal" && strategy !== "usability"))
      ) {
        emitExplore(
          fail(
            "E_EXPLORE_ARGS",
            `--success, --success-when and --allow-vacuous-checks are supported only with --strategy goal or usability (not ${o.feature !== undefined ? "--feature" : `--strategy ${strategy}`})`,
          ),
        );
        return;
      }
      if (o.storageState !== undefined && !existsSync(o.storageState)) {
        emitExplore(fail("E_EXPLORE_ARGS", `storage state not found: ${o.storageState}`));
        return;
      }
      // Multi-actor missions (#147): the first --actor is the primary, the rest are observers.
      let actors: MissionActors | null;
      try {
        actors = resolveMissionActors(o.actor);
      } catch (err) {
        if (!(err instanceof MultiRunArgsError)) throw err;
        emitExplore(fail(err.code, err.message));
        return;
      }
      if (actors !== null) {
        if (o.feature !== undefined || strategy !== "goal") {
          emitExplore(fail("E_EXPLORE_ARGS", "--actor is supported only with --strategy goal"));
          return;
        }
        if (o.storageState !== undefined) {
          emitExplore(fail("E_EXPLORE_ARGS", "--storage-state cannot be combined with --actor (the first --actor is the primary's session)"));
          return;
        }
      }
      // The primary's session: its --actor state, else --storage-state.
      const primaryStorageState = actors?.primary.storageState ?? o.storageState;
      // App-declared invariants (#86): validated (schema, observables, probe origins) BEFORE any browser.
      let invariants: InvariantSpec | undefined;
      // #135: authFrom.secret refs (env:VAR), resolved from the environment HERE — the one place this
      // package reads process.env for invariants — never inside @jevitate/explore or @jevitate/recording.
      let invariantAuthTokens: Map<string, string> | undefined;
      if (o.invariants.length > 0) {
        if (o.url !== undefined) {
          try {
            const loaded = loadInvariantFiles(o.invariants, {
              allowlist: resolveExploreAllowlist(o.url, o.allow),
              baseUrl: o.url,
              observers: actors?.observers.map((a) => a.name) ?? [],
            });
            invariants = loaded;
            invariantAuthTokens = loaded === undefined ? undefined : resolveInvariantAuthTokens(loaded, process.env);
            checkActorsAgainstSpec(actors, loaded);
          } catch (err) {
            if (err instanceof MultiRunArgsError) {
              emitExplore(fail(err.code, err.message));
              return;
            }
            if (!(err instanceof InvariantsFileError)) throw err;
            emitExplore(fail(err.code, err.message));
            return;
          }
        }
        // #147: captures and cross-actor checks run in the goal loop only — never silently skipped elsewhere.
        if (invariants?.capture !== undefined && (o.feature !== undefined || strategy !== "goal")) {
          emitExplore(fail("E_EXPLORE_ARGS", "invariants with capture (cross-actor checks) are supported only with --strategy goal"));
          return;
        }
      }
      const withInvariants = {
        ...(invariants === undefined ? {} : { invariants }),
        ...(invariantAuthTokens === undefined || invariantAuthTokens.size === 0 ? {} : { invariantAuthTokens }),
      };
      // Backend log sources (#142): validated (spec shape, --allow-log-cmd gate, matcher regexes)
      // BEFORE any browser opens — the same fail-closed discipline as --invariants above. Supported
      // on every strategy, INCLUDING usability (#142 follow-up): lines attach to usability steps the
      // same way, though a UX run's own outcome stays advisory (a server-log defect is still reported,
      // never gates the exit code — the same rule as every other UX finding).
      let serverLog: ServerLogOptions | undefined;
      if (o.logSource.length > 0 || o.logDefect.length > 0) {
        try {
          const sources = parseLogSourceSpecs(o.logSource, o.allowLogCmd ?? false);
          const logDefect = parseLogDefectSpecs(o.logDefect);
          const logIgnore = parseLogIgnoreSpecs(o.logIgnore);
          serverLog = {
            sources,
            logDefect,
            allowLogCmd: o.allowLogCmd ?? false,
            quietOk: o.logQuietOk,
            logIgnore,
            ...(o.serverLogDrainMs === undefined ? {} : { drainMs: Number(o.serverLogDrainMs) }),
          };
        } catch (err) {
          if (err instanceof LogSourceSpecError || err instanceof LogSpecError) {
            emitExplore(fail(err.code, err.message));
            return;
          }
          throw err;
        }
      }
      const withServerLog = serverLog === undefined ? {} : { serverLog };
      // Secret field bindings (#72): resolved from the environment here, typed by code in the goal loop.
      let secretFields: SecretField[] = [];
      if (o.secretField.length > 0 || o.totp.length > 0) {
        if (o.feature !== undefined || (strategy !== "goal" && strategy !== "usability")) {
          emitExplore(fail("E_EXPLORE_ARGS", "--secret-field and --totp are supported only with --strategy goal or usability"));
          return;
        }
        try {
          secretFields = [
            ...o.secretField.map((s) => parseSecretField(s, "value", process.env)),
            ...o.totp.map((s) => parseSecretField(s, "totp", process.env)),
          ];
        } catch (err) {
          if (!(err instanceof SecretFieldSpecError)) throw err;
          emitExplore(fail(err.code, err.message));
          return;
        }
      }

      // Mission fixtures (#140/#144) run around the goal loop and its replays only.
      const fixtureFlagsGiven = o.fixtures !== undefined || o.before !== undefined || o.after !== undefined;
      if (fixtureFlagsGiven && (o.feature !== undefined || strategy !== "goal")) {
        emitExplore(fail("E_EXPLORE_ARGS", "--fixtures, --before and --after are supported only with --strategy goal"));
        return;
      }

      // Additive coverage/exploratory strategy: proof-by-induction state coverage.
      // It takes no goal/success (the frontier itself is the objective), so it is
      // a distinct, goal-free path that leaves the goal strategy below unchanged.
      if (strategy === "coverage" || strategy === "exploratory") {
        if (!o.url) {
          emitExplore(fail("E_EXPLORE_ARGS", "--url is required"));
          return;
        }
        if (o.scope !== undefined && o.scope !== "app") {
          emitExplore(fail("E_EXPLORE_ARGS", `--scope must be "app" (got ${JSON.stringify(o.scope)})`));
          return;
        }
        const covAllowlist = resolveExploreAllowlist(o.url, o.allow);
        const covBounds: Record<string, number> = {};
        if (o.maxActions !== undefined) covBounds.maxActions = Number(o.maxActions);
        if (o.maxDecisions !== undefined) covBounds.maxDecisions = Number(o.maxDecisions);
        // Scope containment (#89, reusing #64's model): the start URL's route plus --route globs;
        // --scope app (or --route '/**') widens it to the whole app.
        const covRouteGlobs = [...o.route, ...(o.scope === "app" ? ["/**"] : [])];
        const covStall = stallTimeoutMs(o.stallTimeout);
        if (covStall === null) {
          emitExplore(fail("E_EXPLORE_ARGS", `--stall-timeout must be a positive number of seconds (got ${JSON.stringify(o.stallTimeout)})`));
          return;
        }

        let covJudge: JudgmentPort;
        let covGen: GenerationPort;
        let covUsage: UsageTracker;
        try {
          ({ judge: covJudge, gen: covGen, usage: covUsage } = await buildExploreGateways(deps, {
            real: o.real ?? false,
            fakeAi: o.fakeAi ?? false,
          }));
        } catch (err) {
          if (err instanceof MissingCredentialError || err instanceof GatewaySelectionError) {
            emitExplore(fail("E_AI_SETUP_REQUIRED", err.message));
          } else {
            emitExplore(fail("E_EXPLORE_SETUP", String(err instanceof Error ? err.message : err)));
          }
          return;
        }

        try {
          const result = await runCoverageMission({
            ...(target === undefined ? {} : { target }),
            url: o.url,
            allowlist: covAllowlist,
            judge: covJudge,
            gen: covGen,
            usage: covUsage,
            bounds: Object.keys(covBounds).length > 0 ? covBounds : undefined,
            ...(covRouteGlobs.length > 0 ? { routeGlobs: covRouteGlobs } : {}),
            strategy,
            ...(covStall === undefined ? {} : { stallTimeoutMs: covStall }),
            outDir: o.out,
            browserPortFactory: deps.explore?.browserPortFactory,
            browser,
            ...(emulation === undefined ? {} : { emulation }),
            overflow,
            ...(o.storageState !== undefined ? { storageState: o.storageState } : {}),
            ...(o.saveStorageState !== undefined ? { saveStorageState: o.saveStorageState } : {}),
            ...withInvariants,
            ...withServerLog,
          });
          // Typed verdict → exit code (0 clean · 1 defects · 2 crashed; see exit-codes.ts).
          emitExplore(ok(result), result.exitCode);
        } catch (err) {
          if (err instanceof UnauthorizedExploreTargetError) {
            emitExplore(fail("E_UNAUTHORIZED_EXPLORE_TARGET", err.message));
          } else if (err instanceof ScopeUnderivableError) {
            // #224: no default route scope from --url — a usage error (64), refused before any browser.
            emitExplore(fail("E_EXPLORE_ARGS", err.message));
          } else {
            emitExplore(fail("E_EXPLORE_RUN", String(err instanceof Error ? err.message : err)));
          }
        }
        return;
      }

      // Additive adversarial strategy: a bounded "try to break it" run whose
      // stop decision comes from a trusted hard-signal oracle (never Jev's
      // Noul). Requires only --url; --goal/--success are goal-strategy inputs.
      if (strategy === "adversarial") {
        if (!o.url) {
          emitExplore(fail("E_EXPLORE_ARGS", "--url is required for --strategy adversarial"));
          return;
        }
        const advAllowlist = resolveExploreAllowlist(o.url, o.allow);
        let advJudge: JudgmentPort;
        let advGen: GenerationPort;
        let advUsage: UsageTracker;
        try {
          ({ judge: advJudge, gen: advGen, usage: advUsage } = await buildExploreGateways(deps, {
            real: o.real ?? false,
            fakeAi: o.fakeAi ?? false,
          }));
        } catch (err) {
          if (err instanceof MissingCredentialError || err instanceof GatewaySelectionError) {
            emitExplore(fail("E_AI_SETUP_REQUIRED", err.message));
          } else {
            emitExplore(fail("E_EXPLORE_SETUP", String(err instanceof Error ? err.message : err)));
          }
          return;
        }

        let coverageThresholds: CoverageThresholds;
        try {
          coverageThresholds = resolveCoverageThresholds({
            ...(o.minControlCoverage === undefined ? {} : { minControlRatio: Number(o.minControlCoverage) }),
            requireFormSubmit: o.requireFormSubmit,
          });
        } catch (err) {
          emitExplore(fail("E_EXPLORE_ARGS", String(err instanceof Error ? err.message : err)));
          return;
        }
        const advBounds: Record<string, number> = {};
        if (o.maxActions !== undefined) advBounds.maxActions = Number(o.maxActions);
        if (o.maxDecisions !== undefined) advBounds.maxDecisions = Number(o.maxDecisions);
        try {
          const result = await runAdversarialCliMission({
            ...(target === undefined ? {} : { target }),
            seedUrl: o.url,
            allowlist: advAllowlist,
            usage: advUsage,
            ...(o.route.length > 0 ? { routeGlobs: o.route } : {}),
            coverageThresholds,
            bounds: Object.keys(advBounds).length > 0 ? advBounds : undefined,
            secrets: o.secret.length > 0 ? o.secret : undefined,
            ...(filing === undefined ? {} : { filing }),
            issueFiler,
            ...(o.hangReplays === undefined ? {} : { hangReplays: Number(o.hangReplays) }),
            strategies: CLI_ADVERSARIAL_STRATEGIES,
            judgment: advJudge,
            generation: advGen,
            browserPortFactory: deps.explore?.browserPortFactory,
            browser,
            ...(emulation === undefined ? {} : { emulation }),
            overflow,
            outDir: o.out,
            ...(o.storageState !== undefined ? { storageState: o.storageState } : {}),
            ...(o.saveStorageState !== undefined ? { saveStorageState: o.saveStorageState } : {}),
            ...withInvariants,
            ...withServerLog,
          });
          // The typed verdict gates CI: 0 clean · 1 defects found (a failing check) · 2 the run
          // itself broke (inconclusive/crashed) — see exit-codes.ts.
          emitExplore(ok(result), result.exitCode);
        } catch (err) {
          if (err instanceof UnauthorizedExploreTargetError) {
            emitExplore(fail("E_UNAUTHORIZED_EXPLORE_TARGET", err.message));
          } else if (err instanceof ScopeUnderivableError) {
            // #224: no default route scope from --url — a usage error (64), refused before any browser.
            emitExplore(fail("E_EXPLORE_ARGS", err.message));
          } else {
            emitExplore(fail("E_EXPLORE_RUN", String(err instanceof Error ? err.message : err)));
          }
        }
        return;
      }

      // Additive: `--strategy usability` (issue #30) — a UX review. Reuses the
      // explore loop (goal = the job) and analyzes each observed screen against
      // the cited @jevitate/ux rubric. Findings are ADVISORY: a UX finding never
      // gates the run (no non-zero exit).
      if (strategy === "usability") {
        if (!o.url || !o.goal) {
          emitExplore(fail("E_EXPLORE_ARGS", "--url and --goal (the job) are required for --strategy usability"));
          return;
        }
        if (!o.appClass) {
          emitExplore(fail("E_UX_ARGS", "--app-class is required for --strategy usability"));
          return;
        }
        // #225: --success is never ignored — an independent completion check on the job, parsed and
        // validated exactly as for --strategy goal (same kinds, same --success-when / vacuous rules).
        let uxSuccessChecks: SuccessCheck[];
        try {
          uxSuccessChecks = o.success.map(parseSuccessSpec);
        } catch (err) {
          emitExplore(fail("E_EXPLORE_ASSERTION", String(err instanceof Error ? err.message : err)));
          return;
        }
        if (o.successWhen !== undefined && o.successWhen !== "held" && o.successWhen !== "final") {
          emitExplore(fail("E_EXPLORE_ARGS", `--success-when must be "held" or "final", got ${JSON.stringify(o.successWhen)}`));
          return;
        }
        if (uxSuccessChecks.length === 0 && (o.successWhen !== undefined || o.allowVacuousChecks === true)) {
          emitExplore(fail("E_EXPLORE_ARGS", "--success-when and --allow-vacuous-checks need at least one --success check"));
          return;
        }
        const uxAllowlist = resolveExploreAllowlist(o.url, o.allow);
        const uxBounds: Record<string, number> = {};
        if (o.maxActions !== undefined) uxBounds.maxActions = Number(o.maxActions);
        if (o.maxDecisions !== undefined) uxBounds.maxDecisions = Number(o.maxDecisions);
        let uxJudge: JudgmentPort;
        let uxGen: GenerationPort;
        let uxUsage: UsageTracker;
        try {
          ({ judge: uxJudge, gen: uxGen, usage: uxUsage } = await buildExploreGateways(deps, {
            real: o.real ?? false,
            fakeAi: o.fakeAi ?? false,
          }));
        } catch (err) {
          if (err instanceof MissingCredentialError || err instanceof GatewaySelectionError) {
            emitExplore(fail("E_AI_SETUP_REQUIRED", err.message));
          } else {
            emitExplore(fail("E_EXPLORE_SETUP", String(err instanceof Error ? err.message : err)));
          }
          return;
        }
        try {
          const result = await runUsabilityMission({
            ...(target === undefined ? {} : { target }),
            url: o.url,
            job: o.goal,
            allowlist: uxAllowlist,
            appContext: { appClass: o.appClass, job: o.goal },
            judge: uxJudge,
            gen: uxGen,
            usage: uxUsage,
            ...(o.minConfidence !== undefined ? { minConfidence: o.minConfidence } : {}),
            ...(o.show !== undefined ? { show: o.show } : {}),
            ...(o.maxFindingsPerPage !== undefined ? { maxFindingsPerRoute: o.maxFindingsPerPage } : {}),
            bounds: Object.keys(uxBounds).length > 0 ? uxBounds : undefined,
            conversation,
            secrets: o.secret.length > 0 ? o.secret : undefined,
            ...(secretFields.length > 0 ? { secretFields } : {}),
            fixture: o.fixture,
            outDir: o.out,
            browserPortFactory: deps.explore?.browserPortFactory,
            browser,
            ...(emulation === undefined ? {} : { emulation }),
            overflow,
            ...(o.storageState !== undefined ? { storageState: o.storageState } : {}),
            ...(o.saveStorageState !== undefined ? { saveStorageState: o.saveStorageState } : {}),
            ...withServerLog,
            ...withInvariants,
            ...(uxSuccessChecks.length === 0 ? {} : { successChecks: uxSuccessChecks }),
            ...(o.successWhen === "held" || o.successWhen === "final" ? { successWhen: o.successWhen } : {}),
            ...(o.allowVacuousChecks === true ? { allowVacuousChecks: true } : {}),
          });
          // UX findings are advisory (0); a failed --success check (#225) is 1, as on a goal run; a
          // broken run or an unavailable analysis is 2.
          emitExplore(ok(result), result.exitCode);
        } catch (err) {
          if (err instanceof UnauthorizedExploreTargetError) {
            emitExplore(fail("E_UNAUTHORIZED_EXPLORE_TARGET", err.message));
          } else if (err instanceof ScopeUnderivableError) {
            // #224: no default route scope from --url — a usage error (64), refused before any browser.
            emitExplore(fail("E_EXPLORE_ARGS", err.message));
          } else if (err instanceof FixtureNotFoundError) {
            emitExplore(fail("E_EXPLORE_FIXTURE", err.message));
          } else if (err instanceof MinConfidenceError || err instanceof QualityPolicyError || err instanceof MaxFindingsPerRouteError || err instanceof UxConfigError) {
            emitExplore(fail("E_UX_ARGS", err.message));
          } else if (err instanceof UsabilityInvariantsUnsupportedError) {
            emitExplore(fail("E_EXPLORE_ARGS", err.message));
          } else {
            emitExplore(fail("E_EXPLORE_RUN", String(err instanceof Error ? err.message : err)));
          }
        }
        return;
      }

      // Additive: `--feature <name>` runs the capability-scoped feature-testing
      // mission (ticket #2 / site #11). It is model-free, so it needs neither
      // --goal/--success nor a gateway selection; the goal-based path below is
      // untouched when --feature is absent.
      if (o.feature) {
        if (!o.url) {
          emitExplore(fail("E_EXPLORE_ARGS", "--url is required with --feature"));
          return;
        }
        const featAllowlist = resolveExploreAllowlist(o.url, o.allow);
        const featBounds: Record<string, number> = {};
        if (o.maxActions !== undefined) featBounds.maxActions = Number(o.maxActions);
        if (o.maxDecisions !== undefined) featBounds.maxDecisions = Number(o.maxDecisions);
        const featStall = stallTimeoutMs(o.stallTimeout);
        if (featStall === null) {
          emitExplore(fail("E_EXPLORE_ARGS", `--stall-timeout must be a positive number of seconds (got ${JSON.stringify(o.stallTimeout)})`));
          return;
        }
        try {
          const result = await runFeatureCliMission({
            ...(featStall === undefined ? {} : { stallTimeoutMs: featStall }),
            seedUrl: o.url,
            allowlist: featAllowlist,
            capability: o.feature,
            routeGlobs: o.route ?? [],
            bounds: Object.keys(featBounds).length > 0 ? featBounds : undefined,
            outDir: o.out,
            browserPortFactory: deps.explore?.browserPortFactory,
            browser,
            ...(emulation === undefined ? {} : { emulation }),
            ...(o.storageState !== undefined ? { storageState: o.storageState } : {}),
            ...(o.saveStorageState !== undefined ? { saveStorageState: o.saveStorageState } : {}),
            ...withInvariants,
            ...withServerLog,
            ...(target?.safety === undefined ? {} : { safety: target.safety }),
          });
          emitExplore(ok(result), result.exitCode);
        } catch (err) {
          if (err instanceof UnauthorizedExploreTargetError) {
            emitExplore(fail("E_UNAUTHORIZED_EXPLORE_TARGET", err.message));
          } else if (err instanceof ScopeUnderivableError) {
            // #224: no default route scope from --url — a usage error (64), refused before any browser.
            emitExplore(fail("E_EXPLORE_ARGS", err.message));
          } else {
            emitExplore(fail("E_EXPLORE_RUN", String(err instanceof Error ? err.message : err)));
          }
        }
        return;
      }

      // --success may be omitted for a find-out goal (#130d): the run is then verified by a grounded
      // `report` answer (#101) instead of an independent page/network check.
      if (!o.url || !o.goal) {
        emitExplore(fail("E_EXPLORE_ARGS", "--url and --goal are required"));
        return;
      }
      let successChecks: SuccessCheck[];
      try {
        successChecks = o.success.map(parseSuccessSpec);
      } catch (err) {
        emitExplore(fail("E_EXPLORE_ASSERTION", String(err instanceof Error ? err.message : err)));
        return;
      }
      if (o.successWhen !== undefined && o.successWhen !== "held" && o.successWhen !== "final") {
        emitExplore(fail("E_EXPLORE_ARGS", `--success-when must be "held" or "final", got ${JSON.stringify(o.successWhen)}`));
        return;
      }
      const successWhen = o.successWhen === "held" || o.successWhen === "final" ? o.successWhen : undefined;
      const allowlist = resolveExploreAllowlist(o.url, o.allow);
      // Fixtures (#140/#144): the spec and every ${setup.x} reference are validated here, before any
      // browser or request; the setup itself runs just before the mission (below).
      let fx: MissionFixtures | undefined;
      try {
        checkUrlRefOrigin(o.url);
        fx = buildMissionFixtures(o, {
          allowlist,
          baseUrl: o.url.replace(SETUP_REF, "0"),
          ...(primaryStorageState === undefined ? {} : { storageState: primaryStorageState }),
          secretFields,
          secrets: o.secret,
          ...(target?.fixtures === undefined ? {} : { targetFixtures: target.fixtures }),
        });
        checkSetupRefs({ "--url": o.url, "--goal": o.goal, "--success": o.success, ...invariantSetupTexts(invariants) }, fx);
      } catch (err) {
        if (!(err instanceof FixtureSpecError || err instanceof UnboundSetupRefError)) throw err;
        emitExplore(fail(err.code, err.message));
        return;
      }
      const bounds: Record<string, number> = {};
      if (o.maxActions !== undefined) bounds.maxActions = Number(o.maxActions);
      if (o.maxDecisions !== undefined) bounds.maxDecisions = Number(o.maxDecisions);

      let judge: JudgmentPort;
      let gen: GenerationPort;
      let usage: UsageTracker;
      try {
        ({ judge, gen, usage } = await buildExploreGateways(deps, { real: o.real ?? false, fakeAi: o.fakeAi ?? false }));
      } catch (err) {
        if (err instanceof MissingCredentialError || err instanceof GatewaySelectionError) {
          emitExplore(fail("E_AI_SETUP_REQUIRED", err.message));
        } else {
          emitExplore(fail("E_EXPLORE_SETUP", String(err instanceof Error ? err.message : err)));
        }
        return;
      }

      let url = o.url;
      let goal = o.goal;
      let runInvariants = withInvariants;
      if (fx !== undefined) {
        // Never run the mission on unknown state: a failed setup ends the run inconclusive (a
        // configuration error), after restoring whatever the partial setup created.
        try {
          await fx.setup();
          const b = fx.bindings();
          url = substituteSetupRefs(o.url, b, { where: "--url" });
          goal = substituteSetupRefs(o.goal, b, { where: "--goal" });
          successChecks = o.success.map((spec) => parseSuccessSpec(substituteSetupRefs(spec, b, { where: "--success" })));
          // #187: ${setup.x} in the invariants (probe paths, deniedAs.open, capture routes), origin-fixed.
          if (invariants !== undefined) runInvariants = { ...withInvariants, invariants: substituteSpecSetupRefs(invariants, b, url) };
        } catch (err) {
          if (!(err instanceof FixtureSetupError || err instanceof UnboundSetupRefError)) {
            await fx.restore();
            throw err;
          }
          await fx.restore();
          emitExplore(ok(withEngine(fixtureSetupFailedResult(err, fx))), EXIT_CODES.inconclusive);
          return;
        }
      }
      try {
        const result = await runExploration({
            ...(target === undefined ? {} : { target }),
          url,
          goal,
          successChecks,
          ...(successWhen === undefined ? {} : { successWhen }),
          ...(o.allowVacuousChecks === true ? { allowVacuousChecks: true } : {}),
          allowlist,
          judge,
          gen,
          usage,
          bounds: Object.keys(bounds).length > 0 ? bounds : undefined,
          secrets: o.secret.length > 0 ? o.secret : undefined,
          ...(secretFields.length > 0 ? { secretFields } : {}),
          fixture: o.fixture,
          outDir: o.out,
          browserPortFactory: deps.explore?.browserPortFactory,
          browser,
          ...(emulation === undefined ? {} : { emulation }),
          ...(primaryStorageState !== undefined ? { storageState: primaryStorageState } : {}),
          ...(o.saveStorageState !== undefined ? { saveStorageState: o.saveStorageState } : {}),
          ...(actors === null ? {} : { actors }),
          ...(filing === undefined ? {} : { filing }),
          issueFiler,
          ...(o.hangReplays === undefined ? {} : { hangReplays: Number(o.hangReplays) }),
          conversation,
          ...runInvariants,
          ...withServerLog,
          ...(fx === undefined ? {} : { fixtures: fx }),
        });
        // 0 succeeded · 1 assertion not met · 2 the run broke (inconclusive/crashed).
        emitExplore(ok(result), result.exitCode);
      } catch (err) {
        if (err instanceof UnauthorizedExploreTargetError) {
          emitExplore(fail("E_UNAUTHORIZED_EXPLORE_TARGET", err.message));
        } else if (err instanceof FixtureNotFoundError) {
          emitExplore(fail("E_EXPLORE_FIXTURE", err.message));
        } else {
          emitExplore(fail("E_EXPLORE_RUN", String(err instanceof Error ? err.message : err)));
        }
      } finally {
        // Every exit path restores the fixture state (a no-op when the mission already did).
        await fx?.restore();
      }
    });

  // `verify-fix`: replays a finding's reproduction N times in FRESH browsers (#74) and reports
  // whether its fingerprint still fires. Exit 0 fixed · 1 still reproduces · 2 inconclusive ·
  // 4 intermittent (fired on some but not all replays — never reported as fixed) · 64 usage error.
  withEmulationFlags(
    withFixtureFlags(
      withBrowserLaunchFlags(
        program
          .command("verify-fix")
          .description("replay a defect's repro from a mission result (or the ledger); passes only if the defect signal is absent on every replay"),
      ),
    ),
  )
    .argument("[fingerprint]", "the defect/hang fingerprint to verify (same as --fingerprint)")
    .option("--result <path>", "the mission's <stem>.result.json (written next to its Recording); default: the fingerprint's ledger entry (#195)")
    .option("--fingerprint <fp>", "the defect/hang fingerprint to verify")
    .option("--regressions-dir <path>", "regressions directory whose ledger/ is searched when --result is omitted (default: .jevitate/regressions)")
    .option("--storage-state <file>", "override the storageState the mission ran with")
    .option("--replays <n>", "fresh-context replays that confirm a fix (default 3)", positiveIntArg)
    .option(
      "--allow-emulation-override",
      "replay at --viewport/--device even though it differs from the finding's recorded emulation (#149); default: refused (fails closed)",
    )
    .option(
      "--invariants <file>",
      "re-check a declared-invariant defect with these invariant files (repeatable) instead of the spec saved with the mission",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--allow-log-cmd",
      "re-checking a server-log defect whose --log-source includes cmd:<command> needs this too (operator-declared only)",
      false,
    )
    .option(
      "--hang-replay-writes",
      "let a hang's replay re-send a paid/destructive write the run sent (default: the verdict is inconclusive, never replayed)",
    )
    .option(
      "--secret <value|env:VAR>",
      "REDACTION ONLY: a value kept out of the fixture log (repeatable), e.g. one a --before hook prints; env:VAR reads it from the environment",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option("--json", "emit the JSON envelope (default: a human summary)")
    .action(async function (this: Command, positional?: string) {
      const o = this.opts<
        {
          result?: string;
          fingerprint?: string;
          regressionsDir?: string;
          storageState?: string;
          replays?: string;
          allowEmulationOverride?: boolean;
          invariants: string[];
          allowLogCmd?: boolean;
          hangReplayWrites?: boolean;
          secret: string[];
          json?: boolean;
        } & BrowserLaunchFlags &
          FixtureFlags &
          EmulationFlags
      >();
      // #230: the re-check hint carries the same --result the user passed (never the ledger
      // fallback's own path, which formatVerifyFixHuman never sees).
      const emitVerify = (envelope: JsonEnvelope<unknown>, exitCode?: number): void =>
        emitCommandResult(program, envelope, {
          json: o.json === true,
          command: "verify-fix",
          human: (data) => formatVerifyFixHuman(data, { result: o.result }),
          ...(exitCode === undefined ? {} : { exitCode }),
        });
      // #195: `--secret env:VAR`, as on explore.
      try {
        const resolved = resolveSecretArgs(o.secret, process.env, "--secret");
        if (resolved.literals > 0) program.configureOutput().writeErr?.(LITERAL_SECRET_WARNING);
        o.secret = resolved.secrets;
      } catch (err) {
        if (!(err instanceof SecretArgError)) throw err;
        emitVerify(fail("E_VERIFY_FIX_ARGS", err.message));
        return;
      }
      let verifyFixEmulation: EmulationSpec | undefined;
      const fingerprint = o.fingerprint ?? positional;
      try {
        verifyFixEmulation = emulationFromFlags(o);
        if (fingerprint === undefined) throw new Error("a fingerprint is required: verify-fix <fp> or --fingerprint <fp>");
        if (o.fingerprint !== undefined && positional !== undefined && o.fingerprint !== positional) {
          throw new Error(`two different fingerprints given (${positional} and --fingerprint ${o.fingerprint})`);
        }
      } catch (err) {
        emitVerify(fail("E_VERIFY_FIX_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      try {
        // #195: without --result, the fingerprint's ledger entry is the repro material (the run's output may be long gone).
        const resultPath = o.result ?? ledgerEntryFor(fingerprint, o.regressionsDir);
        const report = await runVerifyFix({
          targets: loadTargetsFile(deps.explore?.targetsConfigPath),
          resultPath,
          fingerprint,
          ...(o.storageState !== undefined ? { storageState: o.storageState } : {}),
          ...(o.replays !== undefined ? { replays: Number(o.replays) } : {}),
          ...(o.invariants.length > 0 ? { invariantFiles: o.invariants } : {}),
          ...(o.allowLogCmd === undefined ? {} : { allowLogCmd: o.allowLogCmd }),
          ...(o.hangReplayWrites === true ? { hangReplayWrites: true } : {}),
          fixtureFlags: o,
          secrets: o.secret,
          browserPortFactory: deps.explore?.browserPortFactory,
          browser: browserLaunchFromFlags(o),
          ...(verifyFixEmulation === undefined ? {} : { emulation: verifyFixEmulation }),
          ...(o.allowEmulationOverride === undefined ? {} : { allowEmulationOverride: o.allowEmulationOverride }),
        });
        emitVerify(ok(withEngine(report)), report.exitCode);
      } catch (err) {
        if (err instanceof VerifyFixInputError || err instanceof TargetConfigError || err instanceof LedgerError) {
          emitVerify(fail(err.code, err.message));
        } else if (err instanceof UnauthorizedExploreTargetError) {
          emitVerify(fail("E_UNAUTHORIZED_EXPLORE_TARGET", err.message));
        } else {
          emitVerify(fail("E_VERIFY_FIX", String(err instanceof Error ? err.message : err)));
        }
      }
    });

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

  // Additive: `explore author-journey` — Jev-driving authors a promotable
  // Journey (Ticket #6). Drives the goal-based mission, feeds its take(s)
  // through RxD's diff/postdoc pipeline, and writes an UNPROMOTED,
  // parameterized Journey to the journeys store. The record-by-demonstration
  // authoring path is untouched.
  withBrowserLaunchFlags(
    program
      .command("explore-author-journey")
      .description("Jev-driving authors a promotable Journey (authoring plane); never auto-promoted"),
  )
    .option("--url <url>", "target URL (must be an authorized origin)")
    .option("--goal <text>", "natural-language goal")
    .option("--success <spec>", "independent success assertion, e.g. urlIncludes:/confirmed")
    .option("--id <id>", "journey id (used for the <id>.json filename in the store)")
    .option("--name <name>", "human-readable journey name")
    .option("--takes <n>", "corroborating takes incl. discovery (default 1)", positiveIntArg, 1)
    .option(
      "--storage-state <file>",
      "Playwright storageState JSON to start the session authenticated (deterministic login pre-step); must exist",
    )
    .option("--journeys-dir <dir>", "journeys store directory (default: ~/.jevitate/journeys)")
    .option(
      "--allow <origin>",
      "authorized origin (repeatable); REPLACES the default allowlist when given (the URL's own origin is used only when --allow is omitted entirely) -- include the URL's own origin explicitly if you still need it",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option("--max-actions <n>", "hard cap on executed actions", positiveIntArg)
    .option("--max-decisions <n>", "hard cap on model decisions", positiveIntArg)
    .option("--real", "use live Jev + OpenRouter gateways (requires keys)", false)
    .option("--fake-ai", "use deterministic fake gateways (pipeline smoke only)", false)
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command) {
      const o = this.opts<{
        url?: string;
        goal?: string;
        success?: string;
        id?: string;
        name?: string;
        takes: string;
        journeysDir?: string;
        allow: string[];
        maxActions?: string;
        maxDecisions?: string;
        real?: boolean;
        fakeAi?: boolean;
        json?: boolean;
        storageState?: string;
      } & BrowserLaunchFlags>();
      if (o.storageState !== undefined && !existsSync(o.storageState)) {
        emitJson(program, fail("E_EXPLORE_ARGS", `storage state not found: ${o.storageState}`));
        return;
      }

      if (!o.url || !o.goal || !o.success || !o.id || !o.name) {
        emitJson(program, fail("E_AUTHOR_ARGS", "--url, --goal, --success, --id and --name are all required"));
        return;
      }
      let successAssertion;
      try {
        successAssertion = parseAssertionSpec(o.success);
      } catch (err) {
        emitJson(program, fail("E_EXPLORE_ASSERTION", String(err instanceof Error ? err.message : err)));
        return;
      }
      const allowlist = resolveExploreAllowlist(o.url, o.allow);
      const bounds: Record<string, number> = {};
      if (o.maxActions !== undefined) bounds.maxActions = Number(o.maxActions);
      if (o.maxDecisions !== undefined) bounds.maxDecisions = Number(o.maxDecisions);

      let judge: JudgmentPort;
      let gen: GenerationPort;
      let authorUsage: UsageTracker;
      try {
        ({ judge, gen, usage: authorUsage } = await buildExploreGateways(deps, { real: o.real ?? false, fakeAi: o.fakeAi ?? false }));
      } catch (err) {
        if (err instanceof MissingCredentialError || err instanceof GatewaySelectionError) {
          emitJson(program, fail("E_AI_SETUP_REQUIRED", err.message));
        } else {
          emitJson(program, fail("E_EXPLORE_SETUP", String(err instanceof Error ? err.message : err)));
        }
        return;
      }

      try {
        const result = await runAuthorJourney({
          url: o.url,
          goal: o.goal,
          successAssertion,
          allowlist,
          journeysDir: resolveJourneysDir(deps, o.journeysDir),
          journeyId: o.id,
          journeyName: o.name,
          takes: Number(o.takes),
          judge,
          gen,
          bounds: Object.keys(bounds).length > 0 ? bounds : undefined,
          browserPortFactory: deps.explore?.browserPortFactory,
          browser: browserLaunchFromFlags(o),
          ...(o.storageState !== undefined ? { storageState: o.storageState } : {}),
        }).then((r) => ({ ...r, usage: authorUsage.snapshot() }));
        const envelope = ok(result);
        if (o.json) {
          emitJson(program, envelope);
          if (result.outcome !== "authored") process.exitCode = 1;
        } else {
          writeRawResult(program, result);
          process.exitCode = result.outcome === "authored" ? 0 : 1;
        }
      } catch (err) {
        if (err instanceof UnauthorizedExploreTargetError) {
          emitJson(program, fail("E_UNAUTHORIZED_EXPLORE_TARGET", err.message));
        } else {
          emitJson(program, fail("E_AUTHOR_JOURNEY", String(err instanceof Error ? err.message : err)));
        }
      }
    });

  // Additive: `jevitate record` — record-by-demonstration (Ticket #22). Opens a
  // real browser on an authorized origin, lets the user demonstrate a flow, and
  // captures it into a schema-valid, replayable Recording written to disk. The
  // authorized-origin guard is enforced FIRST (fail-closed) inside runRecording,
  // before any browser is opened; the temp profile dir is always cleaned up.
  program
    .command("record")
    .description("record a demonstrated flow into a Recording (authoring plane)")
    .option("--url <url>", "start URL to demonstrate from (must be an authorized origin)")
    .option("--intent <text>", "your framing of the journey (carried to Recording.intent)")
    .option("--retro <text>", "optional retrospective note (carried to Recording.retro)")
    .option(
      "--allow <origin>",
      "authorized origin (repeatable); REPLACES the default allowlist when given (the URL's own origin is used only when --allow is omitted entirely) -- include the URL's own origin explicitly if you still need it",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option("--headless", "run headless (default: headed — a record session is a live demonstration)", false)
    .option("--out <dir>", "directory to write the emitted Recording (default: .jevitate/logs/<date> in the project, else ~/.jevitate/logs/<date>)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command) {
      const o = this.opts<{
        url?: string;
        intent?: string;
        retro?: string;
        allow: string[];
        headless?: boolean;
        out?: string;
        json?: boolean;
      }>();

      if (!o.url) {
        emitJson(program, fail("E_RECORD_ARGS", "--url is required"));
        return;
      }
      const allowlist = resolveRecordAllowlist(o.url, o.allow);

      try {
        const result = await runRecording({
          url: o.url,
          allowlist,
          intent: o.intent,
          retro: o.retro,
          outDir: o.out,
          headless: o.headless ?? false,
          browserPortFactory: deps.record?.browserPortFactory,
          recorderFactory: deps.record?.recorderFactory,
          waitForStop: deps.record?.waitForStop,
        });
        const summary = {
          recordingPath: result.recordingPath,
          steps: result.steps,
          pages: result.pages,
          finalUrl: result.finalUrl,
        };
        if (o.json) {
          emitJson(program, ok(summary));
        } else {
          program.configureOutput().writeOut?.(`${JSON.stringify(summary)}\n`);
        }
      } catch (err) {
        if (err instanceof UnauthorizedExploreTargetError) {
          emitJson(program, fail("E_UNAUTHORIZED_EXPLORE_TARGET", err.message));
        } else {
          emitJson(program, fail("E_RECORD_RUN", String(err instanceof Error ? err.message : err)));
        }
      }
    });

  // Additive: `@jevitate/regression` — reproduce -> minimize -> commit a
  // failing Recording into a committed regression artifact (Ticket #5).
  // Independent of the `journey`/`load` commands above; wires a real
  // Playwright-backed `makeActor` (one fresh browser session per
  // reproduce/minimize attempt, closed after each use) into
  // `runRegressionCapture`.
  const regression = program.command("regression").description("capture, run and manage regression tests from discovered failures");

  withBrowserLaunchFlags(withEmulationFlags(withFixtureFlags(regression.command("capture"))))
    .requiredOption("--from <file>", "path to the schema-valid failing Recording JSON to capture")
    .requiredOption("--id <id>", "regression id (used for the committed <id>.recording.json/<id>.meta.json filenames)")
    .option("--dir <path>", "regressions directory (default: ~/.jevitate/regressions)")
    .option("--attempts <n>", "reproduction attempts before labeling flaky", positiveIntArg, 3)
    .option("--summary <text>", "optional human-readable bug summary recorded in the meta sidecar")
    .option(
      "--result <file>",
      "mission result JSON (as written alongside --from by `jevitate explore`) — supplies a failure oracle when the Recording alone never fails on replay",
    )
    .option(
      "--fingerprint <fp>",
      "pin the required failure — a structural step signature (alone, restricts --from to failing at exactly that step), or (with --result, #119/#129) a defect/invariant fingerprint from the mission's own findings; with --result alone, cross-checks the derived oracle",
    )
    .option(
      "--storage-state <file>",
      "Playwright storageState JSON to open the reproduce/minimize browser sessions authenticated (#129); must exist",
    )
    .option("--force", "overwrite an existing regression id's committed files (default: refused, #213)", false)
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command) {
      const flags = this.opts<{
        from: string;
        id: string;
        dir?: string;
        attempts: string;
        summary?: string;
        result?: string;
        fingerprint?: string;
        storageState?: string;
        force?: boolean;
        json?: boolean;
      } & FixtureFlags & EmulationFlags>();
      const { from, id, dir, attempts, summary, result: resultPath, fingerprint, storageState, force, json } = flags;
      if (refuseUnsafeName(program, id, "regression id")) return;
      // #218: unusable input is refused up front (64), never a capture that broke at runtime (2).
      for (const [flag, path] of [["--from", from], ["--result", resultPath]] as const) {
        if (path !== undefined && !existsSync(path)) {
          emitJson(program, fail("E_REGRESSION_ARGS", `${flag} file not found: ${path}`));
          return;
        }
      }
      if (storageState !== undefined && !existsSync(storageState)) {
        emitJson(program, fail("E_REGRESSION_ARGS", `storage state not found: ${storageState}`));
        return;
      }
      let captureEmulationFlag: EmulationSpec | undefined;
      try {
        captureEmulationFlag = emulationFromFlags(flags);
      } catch (err) {
        emitJson(program, fail("E_REGRESSION_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      const opened: Array<() => Promise<void>> = [];
      let fx: MissionFixtures | undefined;
      try {
        const raw = JSON.parse(await readFile(from, "utf8"));
        const recording = RecordingSchema.parse(raw);
        // #149: --viewport/--device, else the Recording's OWN emulation (reproduces under the same device).
        const captureEmulation: EmulationSpec | undefined =
          captureEmulationFlag ??
          (recording.emulation === undefined
            ? undefined
            : recording.emulation.device !== undefined
              ? { device: recording.emulation.device }
              : { viewport: recording.emulation.viewport });
        // #144: every reproduce/minimize replay restores the fixture state the Recording started from.
        fx = regressionFixtures(
          flags,
          recording,
          resultPath === undefined ? undefined : JSON.parse(await readFile(resultPath, "utf8")),
          storageState,
        );
        const replayFixture = fx;

        const result = await runRegressionCapture({
          failingRecordingPath: from,
          id,
          regressionsDir: resolveRegressionsDir(dir),
          attempts: Number(attempts),
          bugSummary: summary,
          resultPath,
          fingerprint,
          force,
          makeActor: async () => {
            await replayFixture?.reset();
            const { actor, close } = await makeRealBrowserActor(recording.site, storageState, captureEmulation, browserLaunchFromFlags(this.opts<BrowserLaunchFlags>()), deps.explore?.browserPortFactory);
            opened.push(close);
            if (replayFixture !== undefined) {
              rebindReplayNavigation(actor.ability(BrowseTheWebToken).session.page, recording.fixture?.outputs ?? {}, replayFixture.publicOutputs());
            }
            return actor;
          },
        }).then((r) => withEngine(r));
        await fx?.restore();
        const envelope = ok(fx === undefined ? result : { ...result, fixtures: fx.record() });
        if (json) {
          emitJson(program, envelope);
        } else {
          // #227/#230: a human summary (captured/flaky, where the files went, what to run next,
          // carrying the same --dir the user passed) — never the raw result JSON, which used to
          // print unconditionally without --json.
          writeHumanResult(program, result, (r) => formatRegressionCaptureHuman(r, { dir }));
          process.exitCode = 0;
        }
      } catch (err) {
        // #213: these two are usage refusals (64) — an existing id needing --force, or a
        // hard-signal defect that needs `ledger add` instead — never a generic capture failure (2).
        if (err instanceof RegressionExistsError || err instanceof RegressionHardSignalOracleError) {
          emitJson(program, fail(err.code, err.message));
        } else {
          emitJson(program, fail("E_REGRESSION_CAPTURE", String(err instanceof Error ? err.message : err)));
        }
      } finally {
        for (const close of opened) await close();
        await fx?.restore();
      }
    });

  // Additive: `regression run <id>` (#129 item 4) — replays a committed regression (whatever
  // `regression capture` wrote — a step-oracle, network-check, or declared-invariant one) and
  // reports "reproduces" or "fixed". The one CLI/MCP surface `loadRegressions`/`replayRegression`
  // (`@jevitate/regression`) previously had none of.
  withBrowserLaunchFlags(withEmulationFlags(regression.command("run")))
    .argument("<id>", "the committed regression id (its <id>.recording.json/<id>.meta.json)")
    .option("--dir <path>", "regressions directory (default: ~/.jevitate/regressions)")
    .option("--attempts <n>", "fresh-context replays for a declared-invariant oracle (default 3)", positiveIntArg)
    .option("--storage-state <file>", "Playwright storageState JSON to open the replay session authenticated (#129); must exist")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const { dir, attempts, storageState, json, ...emulationFlags } = this.opts<
        { dir?: string; attempts?: string; storageState?: string; json?: boolean } & EmulationFlags
      >();
      if (storageState !== undefined && !existsSync(storageState)) {
        emitJson(program, fail("E_REGRESSION_ARGS", `storage state not found: ${storageState}`));
        return;
      }
      let runEmulationFlag: EmulationSpec | undefined;
      try {
        runEmulationFlag = emulationFromFlags(emulationFlags);
      } catch (err) {
        emitJson(program, fail("E_REGRESSION_ARGS", err instanceof Error ? err.message : String(err)));
        return;
      }
      if (refuseUnsafeName(program, id, "regression id")) return;
      const regressionsDir = resolveRegressionsDir(dir);
      // #218: an unknown id is a usage error (64), refused before anything opens.
      if (!existsSync(join(regressionsDir, `${id}.recording.json`))) {
        const notFound = new RegressionNotFoundError(id, regressionsDir);
        emitJson(program, fail(notFound.code, notFound.message));
        return;
      }
      const opened: Array<() => Promise<void>> = [];
      try {
        const recording = RecordingSchema.parse(JSON.parse(await readFile(join(regressionsDir, `${id}.recording.json`), "utf8")));
        // #149: --viewport/--device, else the committed Recording's OWN emulation.
        const runEmulation: EmulationSpec | undefined =
          runEmulationFlag ??
          (recording.emulation === undefined
            ? undefined
            : recording.emulation.device !== undefined
              ? { device: recording.emulation.device }
              : { viewport: recording.emulation.viewport });
        const report = await runRegressionRun({
          id,
          regressionsDir,
          ...(attempts !== undefined ? { attempts: Number(attempts) } : {}),
          makeActor: async () => {
            const { actor, close } = await makeRealBrowserActor(recording.site, storageState, runEmulation, browserLaunchFromFlags(this.opts<BrowserLaunchFlags>()), deps.explore?.browserPortFactory);
            opened.push(close);
            return actor;
          },
        });
        const envelope = ok(withEngine(report));
        if (json) {
          emitJson(program, envelope);
        } else {
          // #227/#230: the verdict/reason/next-step summary (carrying the same --dir the user
          // passed) — never the raw report JSON.
          program.configureOutput().writeOut?.(formatRegressionRunHuman(report, { dir }));
        }
        process.exitCode = report.verdict === "reproduces" ? 1 : report.verdict === "fixed" ? 0 : 2;
      } catch (err) {
        if (err instanceof RegressionNotFoundError) {
          emitJson(program, fail(err.code, err.message));
        } else {
          emitJson(program, fail("E_REGRESSION_RUN", String(err instanceof Error ? err.message : err)));
        }
      } finally {
        for (const close of opened) await close();
      }
    });

  // Additive: `mission target` — register/list/promote exploration mission
  // targets (Ticket #21). Wires the real fs-backed `@jevitate/missions`
  // store/registry (the SAME store `queue_exploration` resolves promoted
  // targets from). SECURITY: `add` registers UNPROMOTED — the promoted-only
  // gate stays intact, so a registered target is not resolvable by
  // `queue_exploration` until a separate `promote` flips it.
  const mission = program.command("mission").description("manage exploration mission targets and drain the mission queue");
  const missionTarget = mission.command("target");

  const missionTargetAdd = missionTarget
    .command("add <id>")
    .description("register an exploration mission target (UNPROMOTED — not usable by queue_exploration until promoted)")
    .option("--name <name>", "human-readable target name")
    .option("--authorized-origin <origin>", "the target's app origin (a bare http(s) origin); --base-url must be on it")
    .option(
      "--api-origin <origin>",
      "a further origin the app talks to, e.g. its API on another origin (repeatable) — the queued-mission analogue of a second `explore --allow`",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option("--base-url <url>", "the base URL a mission starts navigation from")
    .option("--description <text>", "optional human-readable description");
  withMissionTargetAuthFlags(missionTargetAdd)
    .option("--dir <path>", "mission targets directory (default: ~/.jevitate/missions/targets)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const { name, authorizedOrigin, apiOrigin, baseUrl, description, dir, json, ...authFlags } = this.opts<
        {
          name?: string;
          authorizedOrigin?: string;
          apiOrigin: string[];
          baseUrl?: string;
          description?: string;
          dir?: string;
          json?: boolean;
        } & MissionTargetAuthFlags
      >();
      // Validate in-action + fail envelope (not commander's hard-exiting
      // `.requiredOption`), matching this CLI's convention.
      if (!name || !authorizedOrigin || !baseUrl) {
        emitJson(program, fail("E_MISSION_TARGET_ARGS", "--name, --authorized-origin and --base-url are all required"));
        return;
      }
      try {
        const ctx = missionTargetContext(resolveMissionTargetsDir(deps, dir));
        const auth = missionTargetAuth(authFlags);
        const target = await addMissionTarget(ctx, {
          id,
          name,
          authorizedOrigin,
          apiOrigins: apiOrigin,
          baseUrl,
          ...(description === undefined ? {} : { description }),
          ...(auth === undefined ? {} : { auth }),
        });
        const envelope = ok(target);
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.(
            `registered mission target '${target.id}' (unpromoted — run 'jevitate mission target promote ${target.id}' to make it resolvable)\n`,
          );
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_MISSION_TARGET_ADD", String(err instanceof Error ? err.message : err)));
      }
    });

  withMissionTargetAuthFlags(
    missionTarget
      .command("update <id>")
      .description("set a registered target's operator-declared auth for queued missions (#175); keeps its promotion state")
      .option("--clear-auth", "drop the target's storage state, save-back and secret fields first"),
  )
    .option("--dir <path>", "mission targets directory (default: ~/.jevitate/missions/targets)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const { dir, json, clearAuth, ...authFlags } = this.opts<{ dir?: string; json?: boolean; clearAuth?: boolean } & MissionTargetAuthFlags>();
      const auth = missionTargetAuth(authFlags);
      if (auth === undefined && clearAuth !== true) {
        emitJson(program, fail("E_MISSION_TARGET_ARGS", "nothing to update: pass --storage-state, --save-storage-state, --secret-field or --clear-auth"));
        return;
      }
      try {
        const ctx = missionTargetContext(resolveMissionTargetsDir(deps, dir));
        const target = await updateMissionTargetAuth(ctx, id, { ...(auth ?? {}), ...(clearAuth === true ? { clear: true } : {}) });
        if (json) {
          emitJson(program, ok(target));
        } else {
          program.configureOutput().writeOut?.(`updated mission target '${target.id}'\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        if (err instanceof UnknownMissionTargetError) {
          emitJson(program, fail("E_UNKNOWN_MISSION_TARGET", err.message));
          return;
        }
        emitJson(program, fail("E_MISSION_TARGET_UPDATE", String(err instanceof Error ? err.message : err)));
      }
    });

  missionTarget
    .command("list")
    .description("list ALL mission targets (promoted and unpromoted) — a local/dev-facing listing")
    .option("--dir <path>", "mission targets directory (default: ~/.jevitate/missions/targets)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command) {
      const { dir, json } = this.opts<{ dir?: string; json?: boolean }>();
      try {
        const ctx = missionTargetContext(resolveMissionTargetsDir(deps, dir));
        const targets = await listMissionTargets(ctx);
        const envelope = ok(targets);
        if (json) {
          emitJson(program, envelope);
        } else {
          const out = program.configureOutput().writeOut;
          for (const t of targets) {
            const origins = [t.authorizedOrigin, ...(t.apiOrigins ?? [])].join(",");
            out?.(`${t.id}\t${t.name}\t${origins}${t.promoted ? "" : " (unpromoted)"}\n`);
          }
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_MISSION_TARGET_LIST", String(err instanceof Error ? err.message : err)));
      }
    });

  missionTarget
    .command("promote <id>")
    .description("promote a registered target so queue_exploration can resolve it")
    .option("--dir <path>", "mission targets directory (default: ~/.jevitate/missions/targets)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const { dir, json } = this.opts<{ dir?: string; json?: boolean }>();
      try {
        const ctx = missionTargetContext(resolveMissionTargetsDir(deps, dir));
        const target = await promoteMissionTarget(ctx, id);
        const envelope = ok(target);
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.(`promoted mission target '${target.id}'\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        if (err instanceof UnknownMissionTargetError) {
          emitJson(program, fail("E_UNKNOWN_MISSION_TARGET", err.message));
        } else {
          emitJson(program, fail("E_MISSION_TARGET_PROMOTE", String(err instanceof Error ? err.message : err)));
        }
      }
    });

  // `mission run` (#117) — drains the queue `queue_exploration` (MCP) fills: each queued mission runs
  // through its strategy's CLI runner, its typed result lands in the recordings dir `jevitate mcp`
  // reads, and its queue record moves queued → running → done (resultId) | failed, so
  // `get_mission_result {id: missionId}` resolves it. `--once` (default) drains what is queued now
  // and exits; `--watch` keeps polling.
  withBrowserLaunchFlags(
    mission
      .command("run")
      .description("run queued missions (queue_exploration) through their strategy's runner; get_mission_result {id: missionId} then reads the result"),
  )
    .option("--once", "drain the missions queued now, then exit (default)")
    .option("--watch", "keep draining: poll the queue every --interval ms until interrupted")
    .option("--interval <ms>", "--watch poll interval in ms (default 5000)", positiveIntArg, 5000)
    .option("--dir <path>", "mission queue directory (default: ~/.jevitate/missions/queue)")
    .option("--targets-dir <path>", "mission targets directory (default: ~/.jevitate/missions/targets)")
    .option("--out <dir>", "where results are written (default: .jevitate/logs/<date> in the project, else ~/.jevitate/logs/<date> — where `jevitate mcp` reads them)")
    .option("--real", "use live Jev + OpenRouter gateways for model-driven missions (requires keys)", false)
    .option("--fake-ai", "use deterministic fake gateways (pipeline smoke only)", false)
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command) {
      const o = this.opts<
        {
          once?: boolean;
          watch?: boolean;
          interval: string;
          dir?: string;
          targetsDir?: string;
          out?: string;
          real?: boolean;
          fakeAi?: boolean;
          json?: boolean;
        } & BrowserLaunchFlags
      >();
      if (o.once && o.watch) {
        emitJson(program, fail("E_MISSION_RUN_ARGS", "--once and --watch are mutually exclusive"));
        return;
      }
      const intervalMs = Number(o.interval);
      if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
        emitJson(program, fail("E_MISSION_RUN_ARGS", `--interval must be a positive integer (got ${JSON.stringify(o.interval)})`));
        return;
      }
      // Model-driven missions need a gateway selection; without one they stay queued (reported as
      // skipped), never run against a silently-substituted fake. Feature missions are model-free.
      let gatewayRefusal: string | undefined;
      try {
        await buildExploreGateways(deps, { real: o.real ?? false, fakeAi: o.fakeAi ?? false });
      } catch (err) {
        if (!(err instanceof MissingCredentialError || err instanceof GatewaySelectionError)) throw err;
        gatewayRefusal = err.message;
      }
      const queue = new FsMissionQueueStore(o.dir ?? resolveDataDir(["missions", "queue"]));
      const targets = missionTargetContext(resolveMissionTargetsDir(deps, o.targetsDir)).registry;
      // #142 follow-up: ~/.jevitate/targets.json's per-origin logSources/logDefect/allowLogCmd — a
      // queued mission never carries its own (never an MCP argument); this is the operator's only
      // way to declare one for a mission drained here.
      const targetConfigs = loadTargetsFile(deps.explore?.targetsConfigPath);
      const execute =
        deps.missions?.execute ??
        realQueuedMissionExecutor({
          outDir: o.out ?? logsDirFor(),
          gateways: () => buildExploreGateways(deps, { real: o.real ?? false, fakeAi: o.fakeAi ?? false }),
          ...(deps.explore?.browserPortFactory === undefined ? {} : { browserPortFactory: deps.explore.browserPortFactory }),
          ...(browserLaunchFromFlags(o) === undefined ? {} : { browser: browserLaunchFromFlags(o)! }),
          targets: targetConfigs,
        });
      const drainOnce = () =>
        drainMissionQueue({
          queue,
          targets,
          execute,
          accepts: (m) => (gatewayRefusal !== undefined && needsModel(m) ? `needs a model gateway: ${gatewayRefusal}` : true),
        });
      const emit = (report: DrainReport) => {
        const data = withEngine(report);
        if (o.json) {
          emitJson(program, ok(data));
        } else {
          program.configureOutput().writeOut?.(`${JSON.stringify(data)}\n`);
        }
        // Every claimed mission ran (whatever its own outcome); 2 only when one could not run at all —
        // it proves nothing, so never 1 (defects) — exit-codes.ts.
        process.exitCode = report.ran.some((m) => m.status === "failed") ? EXIT_CODES.inconclusive : EXIT_CODES.ok;
      };
      try {
        if (!o.watch) {
          emit(await drainOnce());
          return;
        }
        // --watch: one envelope per pass that ran something; interrupted by SIGINT/SIGTERM (the kill
        // switch still writes a killed mission's partial result).
        for (;;) {
          const report = await drainOnce();
          if (report.ran.length > 0) emit(report);
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
      } catch (err) {
        emitJson(program, fail("E_MISSION_RUN", String(err instanceof Error ? err.message : err)));
      }
    });

  // Additive: `jevitate mcp` (Ticket #20) — start an MCP stdio server that
  // exposes ONLY `@jevitate/mcp-facade`'s allowlisted tools (never the raw
  // browser primitives in FORBIDDEN_TOOLS). This is the subcommand form of the
  // MCP server (single-bundle deployment — no separate published package).
  // The server owns stdin/stdout as the MCP protocol channel, so on success it
  // blocks and writes NOTHING to stdout; only a setup failure (before the
  // transport connects) emits a JSON envelope.
  program
    .command("mcp")
    .description("start an MCP stdio server exposing only the allowlisted Jevitate tools")
    .option("--dir <path>", "journeys directory (default: ~/.jevitate/journeys)")
    .option(
      "--print-config <harness>",
      "print the config snippet to register `jevitate mcp` in a harness (claude | cursor | codex | json) and exit — prints only, writes nothing",
    )
    .action(async function (this: Command) {
      const { dir, printConfig } = this.opts<{ dir?: string; printConfig?: string }>();

      // `--print-config <harness>` is the universal escape hatch: render the
      // exact registration snippet and exit WITHOUT starting the server (safe:
      // no writes, no stdio takeover). An unknown harness is a fail envelope.
      if (printConfig !== undefined) {
        const harness = printConfig as McpHarness;
        if (harness !== "claude" && harness !== "cursor" && harness !== "codex" && harness !== "json") {
          emitJson(
            program,
            fail("E_MCP_PRINT_CONFIG", `--print-config must be one of claude | cursor | codex | json (got '${printConfig}')`),
          );
          return;
        }
        program.configureOutput().writeOut?.(`${renderPrintConfig(harness)}\n`);
        process.exitCode = 0;
        return;
      }

      try {
        // Credential store + generation gateway for the allowlisted
        // `ai_generate_text` tool. The gateway is the REAL OpenRouter adapter:
        // the key is read only inside it (Authorization header only), every
        // outbound payload passes the never-to-model guard, and the facade's
        // preflight returns a typed `setup_required` when the key is absent —
        // so no `--real/--fake` flag is needed for the non-interactive server.
        const aiStore = envCredentialStore(deps.ai?.env ?? process.env, deps.ai?.localConfig ?? loadLocalCredentials());
        const generationGateway =
          deps.ai?.gateway ??
          new OpenRouterGenerationGateway({
            store: aiStore,
            catalog: deps.ai?.catalog ?? DEFAULT_EXPLORE_CATALOG,
            constraints: deps.ai?.constraints ?? DEFAULT_EXPLORE_CONSTRAINTS,
            call: await realOpenRouterCall(),
          });
        await startMcpServer({
          journeysDir: resolveJourneysDir(deps, dir),
          sitePolicyDbPath: resolveDbPath(deps),
          missionTargetsDir: resolveMissionTargetsDir(deps),
          missionQueueDir: resolveDataDir(["missions", "queue"]),
          recordingsDir: logsRoot(),
          resultDirsFor: (resultId: string) => resultDirsFor(resultId),
          inboxDir: resolveInboxDir(deps),
          credentialStore: aiStore,
          generationGateway,
        });
      } catch (err) {
        emitJson(program, fail("E_MCP_SERVE", String(err instanceof Error ? err.message : err)));
      }
    });

  // Additive: `jevitate ui` (Task 8) — starts the local, loopback-only HTTP
  // HITL approval dashboard (ui-api.ts's `startUiServer`). Resolves the SAME
  // inbox dir `jevitate mcp`'s inbox tools serve (resolveInboxDir), so the
  // two commands agree on where approvals/handbacks/reviews live. On success
  // it prints the bound URL (carrying the capability token) and stays alive —
  // the open HTTP server keeps the process running, the same way `mcp`'s open
  // stdio transport does.
  program
    .command("ui")
    .description("start the local HITL approval dashboard (loopback-only HTTP server)")
    .option("--port <n>", "explicit port (fails on conflict; default 4180, retries on conflict)", intArg({ min: 0, max: 65535 }))
    .option("--no-open", "do not open the dashboard URL in the default browser")
    .option("--inbox-dir <path>", "inbox store directory (default: ~/.jevitate/inbox — same dir `jevitate mcp` serves)")
    .action(async function (this: Command) {
      const o = this.opts<{ port?: string; open?: boolean; inboxDir?: string }>();
      try {
        const start = deps.ui?.startUiServer ?? startUiServer;
        const handle = await start({
          inboxDir: resolveInboxDir(deps, o.inboxDir),
          open: o.open ?? true,
          ...(o.port !== undefined ? { port: Number(o.port) } : {}),
        });
        program.configureOutput().writeOut?.(`${handle.url}\n`);
      } catch (err) {
        emitJson(program, fail("E_UI_SERVE", String(err instanceof Error ? err.message : err)));
      }
    });

  // Additive: `jevitate ux <recording>` (issue #30) — offline UX review of a
  // saved Recording. Findings are advisory; a `failed` analysis is a non-zero
  // fail envelope (never a fabricated clean report).
  program
    .command("ux <recording>")
    .description("offline UX review of a saved Recording — ranked, cited usability findings")
    .option("--app-class <class>", "app class for calibration (required), e.g. consumer|admin|internal")
    .option(
      "--show <labels>",
      "opt-in filter on the quality grade (comma list of actionable,relevant-minor,generic,wrong); others are suppressed and counted; default JEVITATE_UX_SHOW, then ~/.jevitate/config.json ux.show, then ALL grades — the grader is uncalibrated (#133), so by default every finding is shown with its grade",
    )
    .option(
      "--min-confidence <n>",
      "findings below this FINDING confidence (0..1, a finding's own violation/applicability/grounding score — NOT its quality-grade confidence, a separate independent-grader number shown as finding.quality.confidence) are suppressed and counted in report.suppressed; default JEVITATE_UX_MIN_CONFIDENCE, then ~/.jevitate/config.json ux.minConfidence, then 0.3",
    )
    .option(
      "--max-findings-per-page <n>",
      "cap on UX findings per route/page, highest-confidence first; the rest are counted in report.suppressed as per-page-cap, never dropped silently; default JEVITATE_UX_MAX_FINDINGS_PER_PAGE, then ~/.jevitate/config.json ux.maxFindingsPerPage, then 5",
    )
    .option("--persona <p>", "optional persona for calibration")
    .option("--job <text>", "the job the flow pursues (improves relevance)")
    .option("--out <dir>", "directory to write the UX report")
    .option(
      "--result <file>",
      "mission result JSON (as written alongside the Recording by `jevitate explore`) — supplies blocked/disabled-target evidence the Recording alone cannot carry; default: <stem>.result.json, else <stem>.transcript.json, next to the Recording",
    )
    .option(
      "--evidence <file>",
      "a live usability run's evidence sidecar (screens as analyzed + run signals); default: <stem>.evidence.json next to the Recording — with it, offline review reproduces the live run's findings",
    )
    .option("--real", "use live Jev gateways (requires keys)", false)
    .option("--fake-ai", "use deterministic fake gateways", false)
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, recordingPath: string) {
      const o = this.opts<{
        appClass?: string;
        minConfidence?: string;
        maxFindingsPerPage?: string;
        show?: string;
        persona?: string;
        job?: string;
        out?: string;
        result?: string;
        evidence?: string;
        real?: boolean;
        fakeAi?: boolean;
        json?: boolean;
      }>();
      if (!o.appClass) {
        emitJson(program, fail("E_UX_ARGS", "--app-class is required"));
        return;
      }
      let recording: Recording;
      try {
        recording = RecordingSchema.parse(JSON.parse(await readFile(recordingPath, "utf8")));
      } catch (err) {
        // #218: an unreadable or invalid Recording is unusable input — a usage error (64).
        emitJson(program, fail("E_UX_INPUT", String(err instanceof Error ? err.message : err)));
        return;
      }
      // #85 item 2 / #134: the artifacts next to the Recording — the live usability run's evidence
      // sidecar, the mission result or transcript — are discovered automatically (explicit flags
      // win). Absent or unreadable, the report says so (`report.evidenceCaveats`) rather than
      // silently seeing less.
      const found = discoverRecordingSidecars(recordingPath);
      const sidecars = await loadRecordingSidecars({
        ...((o.evidence ?? found.evidencePath) === undefined ? {} : { evidencePath: o.evidence ?? found.evidencePath }),
        ...((o.result ?? found.resultPath) === undefined ? {} : { resultPath: o.result ?? found.resultPath }),
        ...(o.result === undefined && found.transcriptPath !== undefined ? { transcriptPath: found.transcriptPath } : {}),
      });
      let uxJudge: JudgmentPort;
      let uxGen: GenerationPort;
      let uxUsage: UsageTracker;
      try {
        ({ judge: uxJudge, gen: uxGen, usage: uxUsage } = await buildExploreGateways(deps, { real: o.real ?? false, fakeAi: o.fakeAi ?? false }));
      } catch (err) {
        if (err instanceof MissingCredentialError || err instanceof GatewaySelectionError) {
          emitJson(program, fail("E_AI_SETUP_REQUIRED", err.message));
        } else {
          emitJson(program, fail("E_UX_SETUP", String(err instanceof Error ? err.message : err)));
        }
        return;
      }
      try {
        const result = await runUxReview({
          recording,
          appContext: {
            appClass: o.appClass,
            ...(o.persona ? { persona: o.persona } : {}),
            ...(o.job ? { job: o.job } : {}),
          },
          judge: uxJudge,
          gen: uxGen,
          usage: uxUsage,
          ...(o.minConfidence !== undefined ? { minConfidence: o.minConfidence } : {}),
          ...(o.show !== undefined ? { show: o.show } : {}),
          ...(o.maxFindingsPerPage !== undefined ? { maxFindingsPerRoute: o.maxFindingsPerPage } : {}),
          outDir: o.out,
          ...sidecars,
        });
        emitJson(program, ok(withEngine({ ...result, sidecars: found })));
      } catch (err) {
        if (err instanceof UxAnalysisFailedError) {
          emitJson(program, fail("E_UX_ANALYSIS", err.message));
        } else if (err instanceof MinConfidenceError || err instanceof QualityPolicyError || err instanceof MaxFindingsPerRouteError || err instanceof UxConfigError) {
          emitJson(program, fail("E_UX_ARGS", err.message));
        } else {
          emitJson(program, fail("E_UX_RUN", String(err instanceof Error ? err.message : err)));
        }
      }
    });

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

/**
 * Distinguishes a malformed `--decisions <file>` (E_INVALID_DECISIONS) from
 * every other failure mode of the `postdoc` action (E_INVALID_TAKE) without
 * making `loadDecisions` itself responsible for emitting the CLI envelope —
 * matching this file's existing pattern of one try/catch per subcommand
 * mapping to one error code.
 */
class DecisionsParseError extends Error {
  constructor(public readonly cause: unknown) {
    super(String(cause));
  }
}

async function loadDecisions(file: string): Promise<PostdocDecision[]> {
  let raw: string;
  let parsed: unknown;
  try {
    raw = await readFile(file, "utf8");
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new DecisionsParseError(err);
  }
  const result = PostdocDecisionsSchema.safeParse(parsed);
  if (!result.success) {
    throw new DecisionsParseError(result.error);
  }
  return result.data;
}

/**
 * Thin `@clack/prompts` adapter: walks `authoring`'s fill/select steps in
 * order and asks the human how to classify each one. ALL logic (variance
 * guards, secret-materialization checks, the actual step rewrite) lives in
 * `applyPostdoc`/`diffTakes` — this function only collects a
 * `PostdocDecision[]` to hand them.
 */
async function promptForDecisions(authoring: AuthoringRecording): Promise<PostdocDecision[]> {
  clack.intro("recording postdoc — review captured fill/select steps");

  const decisions: PostdocDecision[] = [];
  const fillSteps = flattenBaseFillSteps(authoring.recording);

  for (const { ref } of fillSteps) {
    const classify = await clack.select({
      message: `Step ${ref.page}:${ref.step} — how should this value be classified?`,
      options: [
        { value: "constant" as const, label: "constant", hint: "fix this value in the artifact" },
        { value: "variable" as const, label: "variable", hint: "prompt for a value at replay time" },
        { value: "handback" as const, label: "handback", hint: "hand control to a human at replay time" },
      ],
    });
    if (clack.isCancel(classify)) {
      clack.cancel("postdoc review cancelled");
      process.exit(1);
    }

    const label = await promptOptionalText("Label for this step? (blank to skip)");
    const chunk = await promptOptionalText("Chunk name for this step? (blank to skip)");

    let decision: PostdocDecision;
    if (classify === "constant") {
      const acknowledgeVaried = await clack.confirm({
        message: "Acknowledge this value varied across takes anyway?",
        initialValue: false,
      });
      if (clack.isCancel(acknowledgeVaried)) {
        clack.cancel("postdoc review cancelled");
        process.exit(1);
      }
      decision = { step: ref, classify: "constant", ...(acknowledgeVaried ? { acknowledgeVaried: true as const } : {}) };
    } else if (classify === "variable") {
      const name = await clack.text({ message: "Variable name?" });
      if (clack.isCancel(name)) {
        clack.cancel("postdoc review cancelled");
        process.exit(1);
      }
      decision = { step: ref, classify: "variable", name };
    } else {
      const prompt = await clack.text({ message: "Handback prompt for the human operator?" });
      if (clack.isCancel(prompt)) {
        clack.cancel("postdoc review cancelled");
        process.exit(1);
      }
      decision = { step: ref, classify: "handback", prompt };
    }

    if (label !== undefined) decision = { ...decision, label };
    if (chunk !== undefined) decision = { ...decision, chunk };
    decisions.push(decision);
  }

  clack.outro("review complete");
  return decisions;
}

async function promptOptionalText(message: string): Promise<string | undefined> {
  const value = await clack.text({ message, defaultValue: "" });
  if (clack.isCancel(value)) {
    clack.cancel("postdoc review cancelled");
    process.exit(1);
  }
  return value === "" ? undefined : value;
}
