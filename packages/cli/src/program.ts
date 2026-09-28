import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
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
} from "@jevitate/recording";
import { FsJourneyStore, JourneyRegistry, ParamValidationError } from "@jevitate/journey";
import { envCredentialStore, MissingCredentialError, UsageTracker, type JudgmentPort, type GenerationPort } from "@jevitate/ai-core";
import { loadLocalCredentials } from "./credentials-file.js";
import { safeRunPolicy, type SelfHealMode } from "@jevitate/domain";
import { makeExploreSelfHealer } from "./self-heal-adapter.js";
import { ok, fail } from "./envelope.js";
import { SiteGateRefusedError, type SelfHealer } from "@jevitate/runtime";
import { runJourneyProgrammatically, promoteJourney, UnknownJourneyError, JourneyRequiresAuthError } from "./journey-api.js";
import { initProjectDir, type ProjectInitReport } from "./project-dir.js";
import { sitePolicyKey, withSiteGate } from "./site-gate-cli.js";
import { registerLedgerCommands } from "./ledger-cli.js";
import { buildMissionFixtures, checkSetupRefs, withFixtureFlags, type FixtureFlags } from "./fixture-cli.js";
import { FixtureSetupError, FixtureSpecError, UnboundSetupRefError } from "./mission-fixtures.js";
import { registerAiCommands, realSecureIO } from "./ai-cli.js";
import { registerCheckCommand } from "./check-cli.js";
import { registerReportCommands } from "./report-cli.js";
import { registerInvariantsCommands } from "./invariants-validate.js";
import { collectAllMissingKeys, type KeyCollectionReport } from "./init-keys.js";
import { currentEngineInfo, withEngine } from "./engine.js";
import { EXIT_CODES } from "./exit-codes.js";
import { commandPath, trackActionCommand } from "./cli-refusal.js";
import { nonNegativeIntArg } from "./cli-args.js";
import { formatInitKeysHuman } from "./cli-output.js";
import { detectRuntimes, resolveInstallTargetPaths, installSkills, type RuntimeId } from "./init-skills.js";
import { registerMcp, resolveMcpTargetPaths } from "./init-mcp.js";
import { loadManifest } from "@jevitate/skills";
import { resolveDataDir } from "./data-dir.js";
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
  resolveMissionTargetsDir,
  resolveSourceApiDeps,
  resolveApprovedBy,
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
  GatewaySelectionError,
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
