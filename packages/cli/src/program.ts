import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { userInfo } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import * as clack from "@clack/prompts";
import type { ProfileManager } from "@jevitate/daemon";
import { SitePolicySchema, simulateTiming, type PlannedStep, type SitePolicy } from "@jevitate/domain";
import { openDatabase, migrateToLatest, SqliteSitePolicyRepository } from "@jevitate/storage-sqlite";
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
import {
  envCredentialStore,
  requireKeys,
  MissingCredentialError,
  FakeGenerationGateway,
  OpenRouterGenerationGateway,
  JevJudgmentGateway,
  type JudgmentPort,
  type GenerationPort,
  type Answer,
  type JudgmentState,
  type Question,
  type CatalogModel,
  type ModelConstraints,
  type OpenRouterCall,
  type JevClientCall,
} from "@jevitate/ai-core";
import { loadLocalCredentials } from "./credentials-file.js";
import { FixtureNotFoundError, UnauthorizedExploreTargetError } from "@jevitate/explore";
import { PlaywrightBrowserPort } from "@jevitate/playwright";
import { CastActor, BrowseTheWeb, type Actor } from "@jevitate/screenplay";
import { safeRunPolicy, type SelfHealMode } from "@jevitate/domain";
import { makeExploreSelfHealer } from "./self-heal-adapter.js";
import { ok, fail, type JsonEnvelope } from "./envelope.js";
import { runJourneyProgrammatically, UnknownJourneyError } from "./journey-api.js";
import { runJourneyLoadTest, UnknownLoadJourneyError } from "./load-api.js";
import { runRegressionCapture } from "./regression-api.js";
import {
  addMissionTarget,
  listMissionTargets,
  promoteMissionTarget,
  missionTargetContext,
  UnknownMissionTargetError,
} from "./mission-api.js";
import { startMcpServer } from "./mcp-api.js";
import { startUiServer, type StartUiServerDeps, type UiServerHandle } from "./ui-api.js";
import { registerAiCommands, realSecureIO, type AiCliDeps } from "./ai-cli.js";
import { collectAllMissingKeys } from "./init-keys.js";
import { readCliVersion } from "./version.js";
import {
  detectRuntimes,
  resolveInstallTargetPaths,
  installSkills,
  type RuntimeId,
  type DetectionDeps,
} from "./init-skills.js";
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
  runFeatureCliMission,
  parseAssertionSpec,
  resolveExploreAllowlist,
  type ExploreCliDeps,
} from "./explore-api.js";
import { runUsabilityMission, runUxReview, UxAnalysisFailedError } from "./ux-api.js";
import { resolveDataDir } from "./data-dir.js";
import {
  runRecording,
  resolveRecordAllowlist,
  type RecorderLike,
} from "./record-api.js";
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
  type SourceApiDeps,
} from "./source-api.js";
import {
  runSourceJourney,
  realResolvedJourneyRunner,
  type RunResolvedJourney,
  type SourceRunApiDeps,
} from "./source-run-api.js";
import {
  FsTrustStore,
  FsAckStore,
  UnknownSourceError,
  EmbeddedSecretError,
  UndeclaredOriginError,
  UndeclaredTouError,
  HashMismatchError,
  UntrustedRiskyJourneyError,
  SourceValidationError,
  DEFAULT_LOCK_PATH,
  type GitExec,
  type GhPort,
} from "@jevitate/sources";
import type { BrowserLaunchOptions, BrowserPort, BrowserSession } from "@jevitate/playwright";

/** Injectable wiring for the `record` command (all optional; real defaults). */
export interface RecordCliDeps {
  /** Testing seam — defaults to a real `PlaywrightBrowserPort`. */
  browserPortFactory?: () => BrowserPort;
  /** Testing seam — defaults to a real `@jevitate/recorder` `Recorder`. */
  recorderFactory?: (session: BrowserSession, site: string) => RecorderLike;
  /** Testing seam — the "user signalled done" wait. Defaults to Enter on stdin. */
  waitForStop?: () => Promise<void>;
}

export interface CliDeps {
  profiles: ProfileManager;
  dbPath?: string;
  journeysDir?: string;
  /** Optional, additive: overrides the mission-targets store directory
   *  (default: ~/.jevitate/missions/targets). Same dir `queue_exploration`
   *  resolves promoted targets from. */
  missionTargetsDir?: string;
  /** Optional, additive: overrides the inbox store directory (default:
   *  ~/.jevitate/inbox). Same dir BOTH `jevitate mcp`'s inbox tools AND
   *  `jevitate ui` resolve against by default — Task 8 threads one resolved
   *  dir into both so they serve/consume the same store. */
  inboxDir?: string;
  /** Optional, additive: `jevitate ui` wiring (see ui-api.ts). Omitted in
   *  production means the real `startUiServer`, which binds a real loopback
   *  HTTP port — tests inject a fake so no port is ever bound. */
  ui?: {
    startUiServer?: (deps: StartUiServerDeps) => Promise<UiServerHandle>;
  };
  /** Optional, additive: `@jevitate/ai-core` wiring (see ai-cli.ts). Omitted in
   *  production means real env + the deterministic fake generation gateway. */
  ai?: AiCliDeps;
  /** Optional, additive: `@jevitate/explore` wiring (see explore-api.ts). */
  explore?: ExploreCliDeps;
  /** Optional, additive: `jevitate record` wiring (see record-api.ts). */
  record?: RecordCliDeps;
  /** Optional, additive: `jevitate init` wiring (see init-skills.ts). Omitted
   *  in production means the real `existsSync`/`homedir`/`cwd` and the real
   *  `~/.jevitate/skills-install-state.json` state path. */
  init?: { detection?: DetectionDeps; statePath?: string };
  /**
   * Optional, additive: distributed-Journey-sources wiring (see source-api.ts).
   * Every field is injectable so tests never touch the network, the real home
   * dir, or the real `git`/`gh` binaries. Omitted in production means the real
   * `~/.jevitate/sources` clone dir, `<cwd>/jevitate.lock`, `~/.jevitate/trust`
   * stores, and the real `git`/`gh` ports.
   */
  sources?: {
    sourcesDir?: string;
    lockPath?: string;
    trustDir?: string;
    ackDir?: string;
    git?: GitExec;
    gh?: GhPort;
    now?: () => string;
    /** Identity recorded in a `TrustRecord`/`TouAck`; defaults to the OS user. */
    approvedBy?: string;
    /** Optional, additive: `jevitate source run` runner seam (see
     *  source-run-api.ts). Omitted in production means the real
     *  Playwright-backed `realResolvedJourneyRunner`; tests inject a fake so no
     *  browser launches. */
    runJourney?: RunResolvedJourney;
  };
}

// `~/.jevitate/*` is the product's runtime-data convention (product = Jevitate).
// See data-dir.ts.
const DEFAULT_DB_PATH = resolveDataDir(["db.sqlite"]);
const DEFAULT_JOURNEYS_DIR = resolveDataDir(["journeys"]);
const DEFAULT_REGRESSIONS_DIR = resolveDataDir(["regressions"]);
const DEFAULT_MISSION_TARGETS_DIR = resolveDataDir(["missions", "targets"]);
const DEFAULT_INBOX_DIR = resolveDataDir(["inbox"]);

function resolveDbPath(deps: CliDeps, flag?: string): string {
  return flag ?? deps.dbPath ?? DEFAULT_DB_PATH;
}

/**
 * Mirrors `resolveDbPath`'s flag > deps > home-dir-default convention: a
 * per-invocation `--dir` flag wins, then a `CliDeps.journeysDir` wired in by
 * the host, then `~/.jevitate/journeys`.
 */
function resolveJourneysDir(deps: CliDeps, flag?: string): string {
  return flag ?? deps.journeysDir ?? DEFAULT_JOURNEYS_DIR;
}

/** Same flag > home-dir-default convention as `resolveJourneysDir`, for the
 *  committed-regressions directory `regression capture` writes into. */
function resolveRegressionsDir(flag?: string): string {
  return flag ?? DEFAULT_REGRESSIONS_DIR;
}

/** Same flag > deps > home-dir-default convention as `resolveJourneysDir`, for
 *  the mission-targets store `mission target ...` reads/writes. */
function resolveMissionTargetsDir(deps: CliDeps, flag?: string): string {
  return flag ?? deps.missionTargetsDir ?? DEFAULT_MISSION_TARGETS_DIR;
}

/** Same flag > deps > home-dir-default convention as `resolveJourneysDir`, for
 *  the inbox store `jevitate mcp`'s inbox tools AND `jevitate ui` both read
 *  from — the SAME resolved directory, so the two commands agree on where
 *  approvals/handbacks/reviews live. */
function resolveInboxDir(deps: CliDeps, flag?: string): string {
  return flag ?? deps.inboxDir ?? DEFAULT_INBOX_DIR;
}

/**
 * Assembles the injected `SourceApiDeps` for the distributed-sources commands
 * from `CliDeps.sources` (test-injected ports) or the real production
 * defaults: `~/.jevitate/sources` clones, `<cwd>/jevitate.lock`, and the
 * local, per-user `FsTrustStore`/`FsAckStore` under `~/.jevitate/trust`.
 * Trust/ack stores are LOCAL by design (§14.1) — never the team-shared lock.
 */
function resolveSourceApiDeps(deps: CliDeps): SourceApiDeps {
  const s = deps.sources ?? {};
  return {
    sourcesDir: s.sourcesDir ?? resolveDataDir(["sources"]),
    lockPath: s.lockPath ?? DEFAULT_LOCK_PATH(),
    trust: new FsTrustStore(s.trustDir ?? resolveDataDir(["trust"])),
    ack: new FsAckStore(s.ackDir ?? resolveDataDir(["trust", "acks"])),
    git: s.git,
    now: s.now,
  };
}

/** The identity recorded in a `TrustRecord`/`TouAck` — an injected value, else
 *  the OS username, else `"local"`. Never a secret/credential. */
function resolveApprovedBy(deps: CliDeps): string {
  if (deps.sources?.approvedBy) return deps.sources.approvedBy;
  try {
    return userInfo().username || "local";
  } catch {
    return "local";
  }
}

/**
 * Builds a fresh, real Playwright-backed `Actor` (its own temp profile dir +
 * browser context, per `journey-api.ts`'s `runJourneyProgrammatically`
 * pattern) and returns it alongside a `close()` to tear the session down.
 * `@jevitate/regression`'s `makeActor: () => Promise<Actor>` contract calls
 * this once per reproduce/minimize attempt — a Playwright session cannot be
 * reused after a run — so callers must close each one it hands back.
 */
async function makeRealBrowserActor(site: string): Promise<{ actor: Actor; close: () => Promise<void> }> {
  const port = new PlaywrightBrowserPort();
  const session = await port.open({ headless: true, allowedOrigins: [site], baseUrl: site });
  const actor = CastActor.named("regression-capture").whoCan(new BrowseTheWeb(session, [site]));
  return {
    actor,
    close: () => session.close(),
  };
}

/** Raw commander values of the shared `--browser-*` launch flags. */
interface BrowserLaunchFlags {
  browserExecutable?: string;
  browserChannel?: string;
  browserArg: string[];
}

/**
 * Adds the shared Chromium launch flags to a browser-driving command. They map
 * 1:1 onto `@jevitate/playwright`'s `BrowserLaunchOptions`; `--browser-arg`
 * EXTENDS the Linux defaults (`--no-sandbox`, `--disable-dev-shm-usage`).
 */
function withBrowserLaunchFlags(cmd: Command): Command {
  return cmd
    .option("--browser-executable <path>", "launch this Chromium binary instead of Playwright's pinned one")
    .option("--browser-channel <name>", "Playwright browser channel to launch, e.g. chrome | msedge")
    .option(
      "--browser-arg <arg>",
      "extra Chromium switch (repeatable); extends the Linux defaults --no-sandbox --disable-dev-shm-usage",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    );
}

/** The `BrowserLaunchOptions` for the parsed flags, or `undefined` when none were given. */
function browserLaunchFromFlags(o: BrowserLaunchFlags): BrowserLaunchOptions | undefined {
  const launch: BrowserLaunchOptions = {
    ...(o.browserExecutable !== undefined ? { executablePath: o.browserExecutable } : {}),
    ...(o.browserChannel !== undefined ? { channel: o.browserChannel } : {}),
    ...(o.browserArg.length > 0 ? { args: [...o.browserArg] } : {}),
  };
  return Object.keys(launch).length > 0 ? launch : undefined;
}

/**
 * Parses repeated `--param key=value` flags into a `Record<string,string>`.
 * `previous` starts as the option's default (`{}`) and this is called once
 * per occurrence, commander's standard "collect" pattern.
 */
function collectParam(value: string, previous: Record<string, string>): Record<string, string> {
  const idx = value.indexOf("=");
  const key = idx === -1 ? value : value.slice(0, idx);
  const val = idx === -1 ? "" : value.slice(idx + 1);
  return { ...previous, [key]: val };
}

function makeClock() {
  return {
    nowIso: () => new Date().toISOString(),
    monotonicMs: () => Date.now(),
  };
}

async function withSitePolicyRepository<T>(
  dbPath: string,
  fn: (repository: SqliteSitePolicyRepository) => Promise<T>
): Promise<T> {
  await mkdir(dirname(dbPath), { recursive: true });
  const db = openDatabase(dbPath);
  try {
    await migrateToLatest(db);
    const repository = new SqliteSitePolicyRepository(db, makeClock());
    return await fn(repository);
  } finally {
    await db.destroy();
  }
}

function isPlannedStep(value: unknown): value is PlannedStep {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.label !== "string") return false;
  switch (record.kind) {
    case "type":
      return typeof record.text === "string";
    case "click":
    case "navigate":
      return true;
    case "read":
      return typeof record.chars === "number";
    default:
      return false;
  }
}

function parsePlannedScript(raw: string): PlannedStep[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isPlannedStep)) {
    throw new Error("script must be a JSON array of planned steps ({kind, label, ...})");
  }
  return parsed;
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
  program.name("jevitate").description("Local browser automation platform").version(readCliVersion());

  program
    .command("init")
    .option("--json", "emit a JSON envelope")
    .option("--skip-keys", "skip credential collection")
    .option("--skip-skills", "skip skill installation")
    .option("--skip-mcp", "skip registering the jevitate MCP server in detected harnesses")
    .option("--targets <ids>", "comma-separated runtime ids to force-install to, overriding detection")
    .option("--force", "overwrite a user-modified installed skill file/block or MCP config entry")
    .option("--dry-run", "report planned skill-install/mcp-register actions without writing")
    .action(async function (this: Command) {
      const { json, skipKeys, skipSkills, skipMcp, targets, force, dryRun } = this.opts<{
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
        if (!skipKeys) {
          // SECURITY: reuses the existing, already-guardrailed credential
          // collection. The report holds only key NAMES (required/collected),
          // never a value — nothing here reads, echoes, logs, or returns a key.
          const store = envCredentialStore(deps.ai?.env ?? process.env, deps.ai?.localConfig ?? loadLocalCredentials());
          const io = deps.ai?.secureIO ?? realSecureIO();
          data.keys = await collectAllMissingKeys(store, io);
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
        const envelope = ok(data);
        if (json) {
          emitJson(program, envelope);
        } else {
          const out = program.configureOutput().writeOut;
          out?.("jevitate initialized\n");
          if (data.keys) out?.(`keys: ${JSON.stringify(data.keys)}\n`);
          if (data.skills) out?.(`skills: ${(data.skills as unknown[]).length} target/skill pairs processed\n`);
          if (data.mcp) out?.(`mcp: ${(data.mcp as unknown[]).length} harness config(s) processed\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_INIT", String(err instanceof Error ? err.message : err)));
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

  const site = program.command("site");
  const sitePolicy = site.command("policy");

  sitePolicy
    .command("get <site>")
    .option("--account <account>", "account id", "primary")
    .option("--db <path>", "sqlite db path")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, siteId: string) {
      const { account, db, json } = this.opts<{ account: string; db?: string; json?: boolean }>();
      try {
        const dbPath = resolveDbPath(deps, db);
        const policy = await withSitePolicyRepository(dbPath, (repository) => repository.get(siteId, account));
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
        await withSitePolicyRepository(dbPath, (repository) => repository.set(siteId, account, policy));
        const envelope = ok({ site: siteId, account, version: policy.version });
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.(
            `policy for '${siteId}' (account '${account}') set to version ${policy.version}\n`
          );
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_SITE_POLICY_SET", String(err)));
      }
    });

  site
    .command("simulate <site>")
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
        const policy = await withSitePolicyRepository(dbPath, (repository) => repository.get(siteId, account));
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

  const recording = program.command("recording");

  recording
    .command("promote <file>")
    .requiredOption("--page <n>", "page index")
    .requiredOption("--step <n>", "step index within the page")
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
        const takes: AuthoringRecording[] = await Promise.all(
          files.map(async (f) => {
            const raw = await readFile(f, "utf8");
            const parsed = AuthoringTakeSchema.parse(JSON.parse(raw));
            return { recording: parsed.recording, values: new Map(Object.entries(parsed.values)) };
          })
        );
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
        const takes: AuthoringRecording[] = await Promise.all(
          files.map(async (f) => {
            const raw = await readFile(f, "utf8");
            const parsed = AuthoringTakeSchema.parse(JSON.parse(raw));
            return { recording: parsed.recording, values: new Map(Object.entries(parsed.values)) };
          })
        );
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

  const journey = program.command("journey");

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
          for (const m of metas) {
            out?.(`${m.id}\t${m.name}${m.promoted ? "" : " (unpromoted)"}\n`);
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

  journey
    .command("run <id>")
    .option("--dir <path>", "journeys directory (default: ~/.jevitate/journeys)")
    .option("--param <kv>", "param as key=value (repeatable)", collectParam, {} as Record<string, string>)
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
      const { dir, param, selfHeal, real, fakeAi, json } = this.opts<{
        dir?: string;
        param: Record<string, string>;
        selfHeal: string;
        real?: boolean;
        fakeAi?: boolean;
        json?: boolean;
      }>();

      if (selfHeal !== "fail-closed" && selfHeal !== "hybrid" && selfHeal !== "full") {
        emitJson(program, fail("E_SELF_HEAL_MODE", `--self-heal must be one of fail-closed | hybrid | full (got '${selfHeal}')`));
        return;
      }
      const selfHealMode = selfHeal as SelfHealMode;

      // When a heal mode is requested, build the SelfHealer HERE (this action
      // owns `deps` + the credential preflight); a missing/unselected gateway
      // fails CLOSED before any browser launch, rather than silently running
      // with no healer. fail-closed needs no gateway (identical to today).
      let selfHealer;
      let policy = safeRunPolicy();
      if (selfHealMode !== "fail-closed") {
        let judge: JudgmentPort;
        let gen: GenerationPort;
        try {
          ({ judge, gen } = await buildExploreGateways(deps, { real: real ?? false, fakeAi: fakeAi ?? false }));
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
        const result = await runJourneyProgrammatically({
          dir: resolveJourneysDir(deps, dir),
          id,
          params: param,
          policy,
          selfHealer,
        });
        const envelope = ok(result);
        if (json) {
          emitJson(program, envelope);
          // "ok" and "healed" (a recovered run) are both successes; only
          // "quarantined" is a non-zero exit.
          if (result.outcome === "quarantined") process.exitCode = 1;
        } else {
          program.configureOutput().writeOut?.(`${JSON.stringify(result)}\n`);
          process.exitCode = result.outcome === "quarantined" ? 1 : 0;
        }
      } catch (err) {
        if (err instanceof UnknownJourneyError) {
          emitJson(program, fail("E_UNKNOWN_JOURNEY", String(err.message)));
        } else if (err instanceof ParamValidationError) {
          emitJson(program, fail("E_INVALID_PARAMS", String(err.message)));
        } else {
          emitJson(program, fail("E_JOURNEY_RUN", String(err)));
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
  const source = program.command("source");

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
          for (const s of listing) {
            out?.(`${s.name}\t${s.gitUrl}\t${s.pinnedCommit}\ttrusted=[${s.trustedJourneys.join(", ")}]\n`);
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
  source
    .command("run <name> <journeyId>")
    .description("run a Journey from a trusted remote source through the run-gate")
    .option("--param <kv>", "param as key=value (repeatable)", collectParam, {} as Record<string, string>)
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, name: string, journeyId: string) {
      const { param, json } = this.opts<{ param: Record<string, string>; json?: boolean }>();
      try {
        const apiDeps: SourceRunApiDeps = {
          ...resolveSourceApiDeps(deps),
          runJourney: deps.sources?.runJourney ?? realResolvedJourneyRunner,
        };
        const result = await runSourceJourney(apiDeps, { sourceName: name, journeyId, params: param });
        const envelope = ok(result);
        if (json) {
          emitJson(program, envelope);
          if (result.outcome === "quarantined") process.exitCode = 1;
        } else {
          program.configureOutput().writeOut?.(`${JSON.stringify(result)}\n`);
          process.exitCode = result.outcome === "quarantined" ? 1 : 0;
        }
      } catch (err) {
        // Each run-gate refusal maps to a distinct E_SOURCE_RUN* code so a
        // caller can tell WHY the run was refused without string-matching.
        if (err instanceof UnknownSourceError) {
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
        } else {
          emitJson(program, fail("E_SOURCE_RUN", String(err instanceof Error ? err.message : err)));
        }
      }
    });

  const load = program.command("load");

  load
    .command("run <journeyId>")
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
    .option("--concurrency <n>", "pool size", "1")
    .option("--iterations <n>", "iterations per actor", "1")
    .option("--seed <n>", "master RNG seed", "1")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, journeyId: string) {
      const { dir, param, authorizedOrigin, concurrency, iterations, seed, json } = this.opts<{
        dir?: string;
        param: Record<string, string>;
        authorizedOrigin: string[];
        concurrency: string;
        iterations: string;
        seed: string;
        json?: boolean;
      }>();
      if (authorizedOrigin.length === 0) {
        emitJson(
          program,
          fail("E_LOAD_RUN", "at least one --authorized-origin is required (refusing to load-test with an empty allowlist)"),
        );
        return;
      }
      try {
        const report = await runJourneyLoadTest({
          dir: resolveJourneysDir(deps, dir),
          id: journeyId,
          params: param,
          concurrency: Number(concurrency),
          iterationsPerActor: Number(iterations),
          seed: Number(seed),
          authorizedOrigins: authorizedOrigin,
        });
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
        } else {
          emitJson(program, fail("E_LOAD_RUN", String(err instanceof Error ? err.message : err)));
        }
      }
    });

  withBrowserLaunchFlags(
    program
      .command("explore")
      .description("goal-directed exploration -> a deterministic Recording (authoring/test plane)"),
  )
    .option("--url <url>", "target URL (must be an authorized origin)")
    .option(
      "--strategy <name>",
      "exploration strategy: goal (default) | coverage | exploratory | adversarial | usability (UX review: ranked, cited findings)",
      "goal",
    )
    .option("--goal <text>", "natural-language goal / job (required for --strategy goal and usability)")
    .option("--app-class <class>", "app class for UX calibration (required for --strategy usability), e.g. consumer|admin|internal")
    .option("--success <spec>", "independent success assertion, e.g. urlIncludes:/inbox")
    .option("--feature <name>", "run the capability-scoped feature-testing mission (instead of --goal/--success)")
    .option(
      "--route <glob>",
      "in-scope route glob for --feature (repeatable), e.g. /thread/**",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--allow <origin>",
      "authorized origin (repeatable); defaults to the URL's own origin",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--secret <value>",
      "a secret/PII value to keep out of every model call (repeatable)",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--fixture <path>",
      "local file the upload op attaches to a file input (goal and usability strategies); must exist",
    )
    .option("--max-actions <n>", "hard cap on executed actions")
    .option("--max-decisions <n>", "hard cap on model decisions")
    .option("--real", "use live Jev + OpenRouter gateways (requires keys)", false)
    .option("--fake-ai", "use deterministic fake gateways (pipeline smoke only)", false)
    .option("--out <dir>", "directory to write the emitted Recording")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command) {
      const o = this.opts<{
        url?: string;
        strategy?: string;
        goal?: string;
        appClass?: string;
        success?: string;
        feature?: string;
        route: string[];
        allow: string[];
        secret: string[];
        fixture?: string;
        maxActions?: string;
        maxDecisions?: string;
        real?: boolean;
        fakeAi?: boolean;
        out?: string;
        json?: boolean;
      } & BrowserLaunchFlags>();

      const strategy = o.strategy ?? "goal";
      const browser = browserLaunchFromFlags(o);
      // `--fixture` feeds the upload op, which only the explore loop (goal and
      // usability strategies) can issue. Refuse it elsewhere rather than
      // silently ignoring a file the user expected to be uploaded.
      if (o.fixture !== undefined && (o.feature !== undefined || (strategy !== "goal" && strategy !== "usability"))) {
        emitJson(program, fail("E_EXPLORE_ARGS", "--fixture is supported only with --strategy goal or usability"));
        return;
      }

      // Additive coverage/exploratory strategy: proof-by-induction state coverage.
      // It takes no goal/success (the frontier itself is the objective), so it is
      // a distinct, goal-free path that leaves the goal strategy below unchanged.
      if (strategy === "coverage" || strategy === "exploratory") {
        if (!o.url) {
          emitJson(program, fail("E_EXPLORE_ARGS", "--url is required"));
          return;
        }
        const covAllowlist = resolveExploreAllowlist(o.url, o.allow);
        const covBounds: Record<string, number> = {};
        if (o.maxActions !== undefined) covBounds.maxActions = Number(o.maxActions);
        if (o.maxDecisions !== undefined) covBounds.maxDecisions = Number(o.maxDecisions);

        let covJudge: JudgmentPort;
        let covGen: GenerationPort;
        try {
          ({ judge: covJudge, gen: covGen } = await buildExploreGateways(deps, {
            real: o.real ?? false,
            fakeAi: o.fakeAi ?? false,
          }));
        } catch (err) {
          if (err instanceof MissingCredentialError || err instanceof GatewaySelectionError) {
            emitJson(program, fail("E_AI_SETUP_REQUIRED", err.message));
          } else {
            emitJson(program, fail("E_EXPLORE_SETUP", String(err instanceof Error ? err.message : err)));
          }
          return;
        }

        try {
          const result = await runCoverageMission({
            url: o.url,
            allowlist: covAllowlist,
            judge: covJudge,
            gen: covGen,
            bounds: Object.keys(covBounds).length > 0 ? covBounds : undefined,
            outDir: o.out,
            browserPortFactory: deps.explore?.browserPortFactory,
            browser,
          });
          const envelope = ok(result);
          if (o.json) {
            emitJson(program, envelope);
          } else {
            program.configureOutput().writeOut?.(`${JSON.stringify(result)}\n`);
          }
          if (result.coverage.defects.length > 0) process.exitCode = 1;
        } catch (err) {
          if (err instanceof UnauthorizedExploreTargetError) {
            emitJson(program, fail("E_UNAUTHORIZED_EXPLORE_TARGET", err.message));
          } else {
            emitJson(program, fail("E_EXPLORE_RUN", String(err instanceof Error ? err.message : err)));
          }
        }
        return;
      }

      // Additive adversarial strategy: a bounded "try to break it" run whose
      // stop decision comes from a trusted hard-signal oracle (never Jev's
      // Noul). Requires only --url; --goal/--success are goal-strategy inputs.
      if (strategy === "adversarial") {
        if (!o.url) {
          emitJson(program, fail("E_EXPLORE_ARGS", "--url is required for --strategy adversarial"));
          return;
        }
        const advAllowlist = resolveExploreAllowlist(o.url, o.allow);
        let advJudge: JudgmentPort;
        let advGen: GenerationPort;
        try {
          ({ judge: advJudge, gen: advGen } = await buildExploreGateways(deps, {
            real: o.real ?? false,
            fakeAi: o.fakeAi ?? false,
          }));
        } catch (err) {
          if (err instanceof MissingCredentialError || err instanceof GatewaySelectionError) {
            emitJson(program, fail("E_AI_SETUP_REQUIRED", err.message));
          } else {
            emitJson(program, fail("E_EXPLORE_SETUP", String(err instanceof Error ? err.message : err)));
          }
          return;
        }

        try {
          const result = await runAdversarialCliMission({
            seedUrl: o.url,
            allowlist: advAllowlist,
            strategies: [
              "ordering-violation",
              "repeat-rapid",
              "boundary-input",
              "contradictory-actions",
              "nav-during-pending",
            ],
            judgment: advJudge,
            generation: advGen,
            browserPortFactory: deps.explore?.browserPortFactory,
            browser,
          });
          emitJson(program, ok(result));
          // A discovered defect gates CI, mirroring how a failing test would.
          if (result.outcome === "defect") process.exitCode = 1;
        } catch (err) {
          if (err instanceof UnauthorizedExploreTargetError) {
            emitJson(program, fail("E_UNAUTHORIZED_EXPLORE_TARGET", err.message));
          } else {
            emitJson(program, fail("E_EXPLORE_RUN", String(err instanceof Error ? err.message : err)));
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
          emitJson(program, fail("E_EXPLORE_ARGS", "--url and --goal (the job) are required for --strategy usability"));
          return;
        }
        if (!o.appClass) {
          emitJson(program, fail("E_UX_ARGS", "--app-class is required for --strategy usability"));
          return;
        }
        const uxAllowlist = resolveExploreAllowlist(o.url, o.allow);
        const uxBounds: Record<string, number> = {};
        if (o.maxActions !== undefined) uxBounds.maxActions = Number(o.maxActions);
        if (o.maxDecisions !== undefined) uxBounds.maxDecisions = Number(o.maxDecisions);
        let uxJudge: JudgmentPort;
        let uxGen: GenerationPort;
        try {
          ({ judge: uxJudge, gen: uxGen } = await buildExploreGateways(deps, {
            real: o.real ?? false,
            fakeAi: o.fakeAi ?? false,
          }));
        } catch (err) {
          if (err instanceof MissingCredentialError || err instanceof GatewaySelectionError) {
            emitJson(program, fail("E_AI_SETUP_REQUIRED", err.message));
          } else {
            emitJson(program, fail("E_EXPLORE_SETUP", String(err instanceof Error ? err.message : err)));
          }
          return;
        }
        try {
          const result = await runUsabilityMission({
            url: o.url,
            job: o.goal,
            allowlist: uxAllowlist,
            appContext: { appClass: o.appClass, job: o.goal },
            judge: uxJudge,
            gen: uxGen,
            bounds: Object.keys(uxBounds).length > 0 ? uxBounds : undefined,
            secrets: o.secret.length > 0 ? o.secret : undefined,
            fixture: o.fixture,
            outDir: o.out,
            browserPortFactory: deps.explore?.browserPortFactory,
            browser,
          });
          emitJson(program, ok(result));
        } catch (err) {
          if (err instanceof UnauthorizedExploreTargetError) {
            emitJson(program, fail("E_UNAUTHORIZED_EXPLORE_TARGET", err.message));
          } else if (err instanceof FixtureNotFoundError) {
            emitJson(program, fail("E_EXPLORE_FIXTURE", err.message));
          } else if (err instanceof UxAnalysisFailedError) {
            emitJson(program, fail("E_UX_ANALYSIS", err.message));
          } else {
            emitJson(program, fail("E_EXPLORE_RUN", String(err instanceof Error ? err.message : err)));
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
          emitJson(program, fail("E_EXPLORE_ARGS", "--url is required with --feature"));
          return;
        }
        const featAllowlist = resolveExploreAllowlist(o.url, o.allow);
        try {
          const result = await runFeatureCliMission({
            seedUrl: o.url,
            allowlist: featAllowlist,
            capability: o.feature,
            routeGlobs: o.route ?? [],
            browser,
          });
          emitJson(program, ok(result));
        } catch (err) {
          if (err instanceof UnauthorizedExploreTargetError) {
            emitJson(program, fail("E_UNAUTHORIZED_EXPLORE_TARGET", err.message));
          } else {
            emitJson(program, fail("E_EXPLORE_RUN", String(err instanceof Error ? err.message : err)));
          }
        }
        return;
      }

      if (!o.url || !o.goal || !o.success) {
        emitJson(program, fail("E_EXPLORE_ARGS", "--url, --goal and --success are all required"));
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
      try {
        ({ judge, gen } = await buildExploreGateways(deps, { real: o.real ?? false, fakeAi: o.fakeAi ?? false }));
      } catch (err) {
        if (err instanceof MissingCredentialError || err instanceof GatewaySelectionError) {
          emitJson(program, fail("E_AI_SETUP_REQUIRED", err.message));
        } else {
          emitJson(program, fail("E_EXPLORE_SETUP", String(err instanceof Error ? err.message : err)));
        }
        return;
      }

      try {
        const result = await runExploration({
          url: o.url,
          goal: o.goal,
          successAssertion,
          allowlist,
          judge,
          gen,
          bounds: Object.keys(bounds).length > 0 ? bounds : undefined,
          secrets: o.secret.length > 0 ? o.secret : undefined,
          fixture: o.fixture,
          outDir: o.out,
          browserPortFactory: deps.explore?.browserPortFactory,
          browser,
        });
        const envelope = ok(result);
        if (o.json) {
          emitJson(program, envelope);
          if (result.outcome !== "succeeded") process.exitCode = 1;
        } else {
          program.configureOutput().writeOut?.(`${JSON.stringify(result)}\n`);
          process.exitCode = result.outcome === "succeeded" ? 0 : 1;
        }
      } catch (err) {
        if (err instanceof UnauthorizedExploreTargetError) {
          emitJson(program, fail("E_UNAUTHORIZED_EXPLORE_TARGET", err.message));
        } else if (err instanceof FixtureNotFoundError) {
          emitJson(program, fail("E_EXPLORE_FIXTURE", err.message));
        } else {
          emitJson(program, fail("E_EXPLORE_RUN", String(err instanceof Error ? err.message : err)));
        }
      }
    });

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
    .option("--takes <n>", "corroborating takes incl. discovery (default 1)", "1")
    .option("--journeys-dir <dir>", "journeys store directory (default: ~/.jevitate/journeys)")
    .option(
      "--allow <origin>",
      "authorized origin (repeatable); defaults to the URL's own origin",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option("--max-actions <n>", "hard cap on executed actions")
    .option("--max-decisions <n>", "hard cap on model decisions")
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
      } & BrowserLaunchFlags>();

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
      try {
        ({ judge, gen } = await buildExploreGateways(deps, { real: o.real ?? false, fakeAi: o.fakeAi ?? false }));
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
        });
        const envelope = ok(result);
        if (o.json) {
          emitJson(program, envelope);
          if (result.outcome !== "authored") process.exitCode = 1;
        } else {
          program.configureOutput().writeOut?.(`${JSON.stringify(result)}\n`);
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
      "authorized origin (repeatable); defaults to the URL's own origin",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option("--headless", "run headless (default: headed — a record session is a live demonstration)", false)
    .option("--out <dir>", "directory to write the emitted Recording (default: ~/.jevitate/recordings)")
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
  const regression = program.command("regression");

  regression
    .command("capture")
    .requiredOption("--from <file>", "path to the schema-valid failing Recording JSON to capture")
    .requiredOption("--id <id>", "regression id (used for the committed <id>.recording.json/<id>.meta.json filenames)")
    .option("--dir <path>", "regressions directory (default: ~/.jevitate/regressions)")
    .option("--attempts <n>", "reproduction attempts before labeling flaky", "3")
    .option("--summary <text>", "optional human-readable bug summary recorded in the meta sidecar")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command) {
      const { from, id, dir, attempts, summary, json } = this.opts<{
        from: string;
        id: string;
        dir?: string;
        attempts: string;
        summary?: string;
        json?: boolean;
      }>();
      const opened: Array<() => Promise<void>> = [];
      try {
        const raw = JSON.parse(await readFile(from, "utf8"));
        const recording = RecordingSchema.parse(raw);

        const result = await runRegressionCapture({
          failingRecordingPath: from,
          id,
          regressionsDir: resolveRegressionsDir(dir),
          attempts: Number(attempts),
          bugSummary: summary,
          makeActor: async () => {
            const { actor, close } = await makeRealBrowserActor(recording.site);
            opened.push(close);
            return actor;
          },
        });
        const envelope = ok(result);
        if (json) {
          emitJson(program, envelope);
        } else {
          program.configureOutput().writeOut?.(`${JSON.stringify(result)}\n`);
          process.exitCode = 0;
        }
      } catch (err) {
        emitJson(program, fail("E_REGRESSION_CAPTURE", String(err instanceof Error ? err.message : err)));
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
  const mission = program.command("mission");
  const missionTarget = mission.command("target");

  missionTarget
    .command("add <id>")
    .description("register an exploration mission target (UNPROMOTED — not usable by queue_exploration until promoted)")
    .option("--name <name>", "human-readable target name")
    .option("--authorized-origin <origin>", "the single authorized exploration origin for this target")
    .option("--base-url <url>", "the base URL a mission starts navigation from")
    .option("--description <text>", "optional human-readable description")
    .option("--dir <path>", "mission targets directory (default: ~/.jevitate/missions/targets)")
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, id: string) {
      const { name, authorizedOrigin, baseUrl, description, dir, json } = this.opts<{
        name?: string;
        authorizedOrigin?: string;
        baseUrl?: string;
        description?: string;
        dir?: string;
        json?: boolean;
      }>();
      // Validate in-action + fail envelope (not commander's hard-exiting
      // `.requiredOption`), matching this CLI's convention.
      if (!name || !authorizedOrigin || !baseUrl) {
        emitJson(program, fail("E_MISSION_TARGET_ARGS", "--name, --authorized-origin and --base-url are all required"));
        return;
      }
      try {
        const ctx = missionTargetContext(resolveMissionTargetsDir(deps, dir));
        const target = await addMissionTarget(ctx, { id, name, authorizedOrigin, baseUrl, description });
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
            out?.(`${t.id}\t${t.name}\t${t.authorizedOrigin}${t.promoted ? "" : " (unpromoted)"}\n`);
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
          missionTargetsDir: resolveMissionTargetsDir(deps),
          missionQueueDir: resolveDataDir(["missions", "queue"]),
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
    .option("--port <n>", "explicit port (fails on conflict; default 4180, retries on conflict)")
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
    .option("--persona <p>", "optional persona for calibration")
    .option("--job <text>", "the job the flow pursues (improves relevance)")
    .option("--out <dir>", "directory to write the UX report")
    .option("--real", "use live Jev gateways (requires keys)", false)
    .option("--fake-ai", "use deterministic fake gateways", false)
    .option("--json", "emit a JSON envelope")
    .action(async function (this: Command, recordingPath: string) {
      const o = this.opts<{
        appClass?: string;
        persona?: string;
        job?: string;
        out?: string;
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
        emitJson(program, fail("E_UX_RECORDING", String(err instanceof Error ? err.message : err)));
        return;
      }
      let uxJudge: JudgmentPort;
      try {
        ({ judge: uxJudge } = await buildExploreGateways(deps, { real: o.real ?? false, fakeAi: o.fakeAi ?? false }));
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
          outDir: o.out,
        });
        emitJson(program, ok(result));
      } catch (err) {
        if (err instanceof UxAnalysisFailedError) {
          emitJson(program, fail("E_UX_ANALYSIS", err.message));
        } else {
          emitJson(program, fail("E_UX_RUN", String(err instanceof Error ? err.message : err)));
        }
      }
    });

  registerAiCommands(program, deps);

  return program;
}

/** Distinct from MissingCredentialError: "no --real/--fake-ai selected" vs "keys missing." */
class GatewaySelectionError extends Error {}

const DEFAULT_EXPLORE_CATALOG: CatalogModel[] = [
  { id: "openai/gpt-4o-mini", promptUsdPer1k: 0.15, completionUsdPer1k: 0.6, regions: [], latencyClass: "fast", capabilities: [] },
];
const DEFAULT_EXPLORE_CONSTRAINTS: ModelConstraints = { requiredCapabilities: [] };

/**
 * Selects the exploration gateways. Injected gateways (tests) win; otherwise
 * `--real` builds the live Jev + OpenRouter adapters behind a fail-closed
 * credential preflight, and `--fake-ai` uses deterministic fakes (a pipeline
 * smoke — the fake judge always proposes `done`, so it will not drive to a
 * goal). No selection is a fail-closed refusal, never a silent fake.
 */
async function buildExploreGateways(
  deps: CliDeps,
  opts: { real: boolean; fakeAi: boolean },
): Promise<{ judge: JudgmentPort; gen: GenerationPort }> {
  if (deps.explore?.judge && deps.explore?.gen) {
    return { judge: deps.explore.judge, gen: deps.explore.gen };
  }
  const store = envCredentialStore(deps.explore?.env ?? process.env, deps.explore?.localConfig ?? loadLocalCredentials());
  if (opts.real) {
    requireKeys("generation", store); // fail-closed
    requireKeys("judgment", store); // fail-closed
    const gen = new OpenRouterGenerationGateway({
      store,
      catalog: DEFAULT_EXPLORE_CATALOG,
      constraints: DEFAULT_EXPLORE_CONSTRAINTS,
      call: await realOpenRouterCall(),
    });
    const judge = new JevJudgmentGateway(store, await realJevClientCall());
    return { judge, gen };
  }
  if (opts.fakeAi) {
    return { judge: fakeDoneJudge(), gen: new FakeGenerationGateway() };
  }
  throw new GatewaySelectionError(
    "no gateway selected — pass --real for live Jev+OpenRouter (after `jevitate ai setup`), or --fake-ai for a deterministic pipeline smoke",
  );
}

/** A judge that always proposes `done` — used only by `--fake-ai` (smoke). */
function fakeDoneJudge(): JudgmentPort {
  return {
    async systemOne(_args: { state: JudgmentState; questions: Record<string, Question> }): Promise<Record<string, Answer>> {
      return { op: { kind: "choice", value: "done", confidence: 1 } };
    },
  };
}

/** Real OpenRouter seam (lazy import; not unit-tested) — mirrors ai-cli.ts. */
async function realOpenRouterCall(): Promise<OpenRouterCall> {
  const { generateObject } = await import("ai");
  const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
  return async ({ model, schema, body, authHeader }) => {
    const openrouter = createOpenRouter({ headers: { Authorization: authHeader } });
    const start = Date.now();
    const { object } = await generateObject({ model: openrouter(model), schema, prompt: JSON.stringify(body) });
    return { object, latencyMs: Date.now() - start };
  };
}

/**
 * Real Jev seam (documented, lazy, not unit-tested). Uses a non-literal
 * specifier so this package builds and tests without `@typesafe-ai/sdk`
 * installed; the host installs + wires it for live judgment.
 */
async function realJevClientCall(): Promise<JevClientCall> {
  const specifier = "@typesafe-ai/sdk";
  const sdk = (await import(specifier).catch(() => {
    throw new Error("live judgment requires @typesafe-ai/sdk to be installed and wired (see jev.ts seam)");
  })) as { createClient(args: { authHeader: string }): { systemOne(a: unknown): Promise<Record<string, Answer>> } };
  return async ({ state, questions, authHeader }) => {
    const client = sdk.createClient({ authHeader });
    return client.systemOne({ state, questions });
  };
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
