/**
 * Helpers shared by the per-command-group CLI modules (`*-cli.ts`) that `program.ts` wires together
 * (#231): deps and path resolution, JSON/human output, browser/emulation flags, AI gateway selection.
 */
import { mkdir } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { userInfo } from "node:os";
import { Command, InvalidArgumentError } from "commander";
import type { ProfileManager } from "@jevitate/daemon";
import { type PlannedStep, clock } from "@jevitate/domain";
import { openDatabase, migrateToLatest, SqliteSitePolicyRepository } from "@jevitate/storage-sqlite";
import {
  envCredentialStore,
  requireKeys,
  FakeGenerationGateway,
  OpenRouterGenerationGateway,
  RetryingGenerationPort,
  RetryingJudgmentPort,
  JevJudgmentGateway,
  realJevClientCall,
  UsageTracker,
  FAKE_CALL_USAGE,
  formatUsageLine,
  usageCountsFrom,
  type JudgmentPort,
  type GenerationPort,
  type Answer,
  type JudgmentState,
  type Question,
  type CatalogModel,
  type ModelConstraints,
  type UsageSink,
  type JevProvider,
  JevProviderError,
  jevProviderOverride,
} from "@jevitate/ai-core";
import { loadLocalCredentials } from "./credentials-file.js";
import { PlaywrightBrowserPort, readUnpackedExtension, type UnpackedExtension } from "@jevitate/playwright";
import { realVerifyFetch } from "./key-report.js";
import { preflightRunKeys } from "./run-key-preflight.js";
import { CastActor, BrowseTheWeb, type Actor } from "@jevitate/screenplay";
import { UnsafeNameError, assertSafeName } from "@jevitate/domain";
import { fail, type JsonEnvelope } from "./envelope.js";
import { projectDataDir } from "./project-dir.js";
import { type QueuedMissionExecutor } from "./mission-queue-runner.js";
import { resolveUsagePricing } from "./usage-config.js";
import { realOpenRouterCall } from "./openrouter-call.js";
import { type StartUiServerDeps, type UiServerHandle } from "./ui-api.js";
import { type AiCliDeps } from "./ai-cli.js";
import { emitJsonOrRefusal } from "./cli-refusal.js";
import { emitEnvelope, type EmitOptions } from "./cli-output.js";
import { type DetectionDeps } from "./init-skills.js";
import { type ExploreCliDeps } from "./explore-api.js";
import { resolveDataDir } from "./data-dir.js";
import { type RecorderLike } from "./record-api.js";
import { type SourceApiDeps } from "./source-api.js";
import { type RunResolvedJourney } from "./source-run-api.js";
import { FsTrustStore, FsAckStore, DEFAULT_LOCK_PATH, type GitExec, type GhPort } from "@jevitate/sources";
import type { BrowserLaunchOptions, BrowserPort, BrowserSession } from "@jevitate/playwright";
import { parseGeolocation, parseViewport, resolveEmulation, type EmulationSpec } from "@jevitate/playwright";
import { nonNegativeIntArg, positiveIntArg } from "./cli-args.js";
import { resourceLimitsFromFlags, withResourcePreflight, type GovernanceFlags } from "./resource-preflight.js";
import { HEADED_DEFAULT_SLOW_MO_MS, assertHeadedDisplay, headedFromEnv, sessionLaunchOptions, type BrowserRunOptions } from "./browser-run-options.js";

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
  /**
   * Prune `.jevitate/logs` by the retention policy before each command that writes run output (the
   * real binary sets it; left unset, e.g. in tests, nothing is pruned implicitly). `logsRoot`
   * overrides where (default: the project's logs, else `~/.jevitate/logs`).
   */
  logs?: { readonly autoPrune: boolean; readonly logsRoot?: string; readonly configPath?: string };
  journeysDir?: string;
  /**
   * Optional, additive (#433): the catalog's directory — where `personas.json` and `jobs.json` live
   * (default: the project's `.jevitate/`, found from the working directory; none outside a project).
   */
  catalogDir?: string;
  /**
   * Optional, additive (#247): the environments file `--env` reads (default: the repo's
   * `.jevitate/environments.json`, found from the working directory).
   */
  environmentsFile?: string;
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
  /** Optional, additive: `mission run` wiring — tests inject the executor so no browser opens. */
  missions?: {
    execute?: QueuedMissionExecutor;
    /** Optional, additive (#255): the mission queue directory (default ~/.jevitate/missions/queue) — `mission run/queue/result` and `jevitate mcp`. */
    queueDir?: string;
  };
  /** Optional, additive: `jevitate record` wiring (see record-api.ts). */
  record?: RecordCliDeps;
  /** Optional, additive: `jevitate init` wiring (see init-skills.ts). Omitted
   *  in production means the real `existsSync`/`homedir`/`cwd` and the real
   *  `~/.jevitate/skills-install-state.json` state path.
   *  `isInteractive` (#230): whether key collection may prompt stdin;
   *  omitted in production means the real `process.stdin.isTTY` check. */
  init?: { detection?: DetectionDeps; statePath?: string; isInteractive?: () => boolean };
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
export const DEFAULT_DB_PATH = resolveDataDir(["db.sqlite"]);

export const DEFAULT_MISSION_TARGETS_DIR = resolveDataDir(["missions", "targets"]);
export const DEFAULT_INBOX_DIR = resolveDataDir(["inbox"]);

export function resolveDbPath(deps: CliDeps, flag?: string): string {
  return flag ?? deps.dbPath ?? DEFAULT_DB_PATH;
}

/** #247: where `--env` reads environments and per-origin sessions from (test seams; real defaults). */
export function environmentSeams(deps: CliDeps): { environmentsFile?: string; targetsFile?: string } {
  return {
    ...(deps.environmentsFile === undefined ? {} : { environmentsFile: deps.environmentsFile }),
    ...(deps.explore?.targetsConfigPath === undefined ? {} : { targetsFile: deps.explore.targetsConfigPath }),
  };
}

/**
 * Mirrors `resolveDbPath`'s flag > deps > home-dir-default convention: a
 * per-invocation `--dir` flag wins, then a `CliDeps.journeysDir` wired in by
 * the host, then `~/.jevitate/journeys`.
 */
export function resolveJourneysDir(deps: CliDeps, flag?: string): string {
  return flag ?? deps.journeysDir ?? projectDataDir(["journeys"]);
}

/** Same flag > home-dir-default convention as `resolveJourneysDir`, for the
 *  committed-regressions directory `regression capture` writes into. */
export function resolveRegressionsDir(flag?: string): string {
  return flag ?? projectDataDir(["regressions"]);
}

/** Same flag > deps > home-dir-default convention as `resolveJourneysDir`, for
 *  the mission-targets store `mission target ...` reads/writes. */
export function resolveMissionTargetsDir(deps: CliDeps, flag?: string): string {
  return flag ?? deps.missionTargetsDir ?? DEFAULT_MISSION_TARGETS_DIR;
}

/** Same flag > deps > home-dir-default convention as `resolveJourneysDir`, for
 *  the inbox store `jevitate mcp`'s inbox tools AND `jevitate ui` both read
 *  from — the SAME resolved directory, so the two commands agree on where
 *  approvals/handbacks/reviews live. */
export function resolveInboxDir(deps: CliDeps, flag?: string): string {
  return flag ?? deps.inboxDir ?? DEFAULT_INBOX_DIR;
}

/**
 * Assembles the injected `SourceApiDeps` for the distributed-sources commands
 * from `CliDeps.sources` (test-injected ports) or the real production
 * defaults: `~/.jevitate/sources` clones, `<cwd>/jevitate.lock`, and the
 * local, per-user `FsTrustStore`/`FsAckStore` under `~/.jevitate/trust`.
 * Trust/ack stores are LOCAL by design (§14.1) — never the team-shared lock.
 */
export function resolveSourceApiDeps(deps: CliDeps): SourceApiDeps {
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
export function resolveApprovedBy(deps: CliDeps): string {
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
export async function makeRealBrowserActor(
  site: string,
  storageState?: string,
  emulation?: EmulationSpec,
  browser?: BrowserRunOptions,
  portFactory: () => BrowserPort = () => new PlaywrightBrowserPort(),
  /** #247: an environment's allowed origins (default: just `site`). */
  allowedOrigins: readonly string[] = [site],
): Promise<{ actor: Actor; close: () => Promise<void> }> {
  const port = portFactory();
  const session = await port.open({
    ...sessionLaunchOptions(browser),
    allowedOrigins: [...allowedOrigins],
    baseUrl: site,
    ...emulation,
    ...(storageState !== undefined ? { storageState } : {}),
  });
  const actor = CastActor.named("regression-capture").whoCan(new BrowseTheWeb(session, [...allowedOrigins]));
  return {
    actor,
    close: () => session.close(),
  };
}

/** #429: `--jev-provider` help, shared by every command that builds the live Jev gateway. */
export const JEV_PROVIDER_FLAG_HELP =
  "with --real: which key judgment (Jev) uses — typesafe (TYPESAFE_API_KEY) or openrouter (OPENROUTER_API_KEY, Jev through OpenRouter). Default: JEVITATE_JEV_PROVIDER, else the TypeSafe key when both are set";

/** Parses `--jev-provider` (an unknown provider is a usage error, never ignored). */
export function jevProviderArg(value: string): JevProvider {
  try {
    const p = jevProviderOverride({}, value);
    if (p === undefined) throw new JevProviderError(value, "--jev-provider");
    return p;
  } catch (err) {
    throw new InvalidArgumentError(err instanceof Error ? err.message : String(err));
  }
}

/** Raw commander values of the shared `--browser-*` launch flags (and #205's resource-governance flags). */
export interface BrowserLaunchFlags extends GovernanceFlags {
  browserExecutable?: string;
  browserChannel?: string;
  browserArg: string[];
  /** #256: `--extension <dir>` (repeatable), each already read and checked by `extensionArg`. */
  extension?: readonly UnpackedExtension[];
}

/**
 * #256: the `--extension <dir>` argParser — reads and checks the unpacked extension NOW (a directory
 * with a valid manifest.json), so a bad directory is a usage error (exit 64) on every command before
 * anything runs. The same directory twice is kept once; two directories with one id are refused.
 */
export function extensionArg(value: string, prev: readonly UnpackedExtension[] | undefined): UnpackedExtension[] {
  const before = prev ?? [];
  let ext: UnpackedExtension;
  try {
    ext = readUnpackedExtension(value);
  } catch (err) {
    throw new InvalidArgumentError(err instanceof Error ? err.message : String(err));
  }
  const dup = before.find((e) => e.id === ext.id);
  if (dup === undefined) return [...before, ext];
  if (dup.dir === ext.dir) return [...before];
  throw new InvalidArgumentError(`two extension directories have the same extension id ${ext.id}: ${dup.dir} and ${ext.dir}`);
}

/**
 * Adds the shared Chromium launch flags to a browser-driving command. They map
 * 1:1 onto `@jevitate/playwright`'s `BrowserLaunchOptions`; `--browser-arg`
 * EXTENDS the Linux defaults (`--no-sandbox`, `--disable-dev-shm-usage`).
 */
export function withBrowserLaunchFlags(cmd: Command): Command {
  // #205: resource governance — the run's limits, and the pre-run checks (orphan sweep, starved-host refusal).
  return withResourcePreflight(cmd)
    .option("--max-browsers <n>", "machine-wide cap on jevitate runs with a browser open at once, shared by every jevitate on this machine (default: JEVITATE_MAX_BROWSERS, else cores/4 within 2..6; halved while the host is loaded)", positiveIntArg)
    .option("--max-browser-memory <MiB>", "memory ceiling of this run's browsers (browser + renderers); over it the run ends inconclusive with failure kind resource-limit (default: JEVITATE_MAX_BROWSER_MEMORY_MB, else 4096 or half the RAM)", positiveIntArg)
    .option("--ignore-host-load", "start even when the host is starved (load >= 4/core or < 512 MiB free) instead of refusing with E_HOST_STARVED; the run is throttled and its result records it")
    .option("--browser-executable <path>", "launch this Chromium binary instead of Playwright's pinned one")
    .option("--browser-channel <name>", "Playwright browser channel to launch, e.g. chrome | msedge")
    .option(
      "--browser-arg <arg>",
      "extra Chromium switch (repeatable); extends the Linux defaults --no-sandbox --disable-dev-shm-usage",
      (v, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      "--extension <dir>",
      "load this unpacked browser extension (repeatable; a directory with manifest.json). Its chrome-extension://<id> pages are allowed and navigable, e.g. --url chrome-extension://<id>/sidepanel.html; headless uses Chromium's new headless",
      extensionArg,
      [] as UnpackedExtension[],
    );
}

/** The `BrowserLaunchOptions` for the parsed flags, or `undefined` when none were given. */
export function browserLaunchFromFlags(o: BrowserLaunchFlags): BrowserLaunchOptions | undefined {
  const launch: BrowserLaunchOptions = {
    ...(o.browserExecutable !== undefined ? { executablePath: o.browserExecutable } : {}),
    ...(o.browserChannel !== undefined ? { channel: o.browserChannel } : {}),
    ...(o.browserArg.length > 0 ? { args: [...o.browserArg] } : {}),
    ...(o.extension !== undefined && o.extension.length > 0 ? { extensions: [...o.extension] } : {}),
  };
  const resources = resourceLimitsFromFlags(o);
  if (resources !== undefined) launch.resources = resources;
  return Object.keys(launch).length > 0 ? launch : undefined;
}

/** Raw commander values of the demo-mode flags (#245). `overlay` is `--no-overlay`'s attribute. */
export interface DemoFlags {
  headed?: boolean;
  slowMo?: number;
  recordVideo?: boolean | string;
  overlay?: boolean;
}

/** Which demo-mode flags a command takes: every one shows (`--headed`/`--slow-mo`); some record and overlay. */
export interface DemoFlagSet {
  /** `--record-video [dir]` — the command lists the videos in its result. */
  readonly recordVideo?: boolean;
  /** `--no-overlay` — the command runs an explore mission (the overlay lives in `@jevitate/explore`). */
  readonly overlay?: boolean;
}

/**
 * Adds the demo-mode flags (#245) to a browser-driving command. Headless stays the default; these
 * are all opt-in and resolved by `browserRunFromFlags` (which also reads `JEVITATE_HEADED`).
 */
export function withDemoFlags(cmd: Command, set: DemoFlagSet = {}): Command {
  cmd
    .option("--headed", `show the browser window (demo mode); also JEVITATE_HEADED=1. Default: headless. Needs a display${set.recordVideo === true ? " — else use --record-video" : ""}`)
    .option("--slow-mo <ms>", `slow every browser operation by this many ms (default ${HEADED_DEFAULT_SLOW_MO_MS} with --headed, else 0)`, nonNegativeIntArg);
  if (set.recordVideo === true) {
    cmd.option("--record-video [dir]", "record a video of each browser context (works headless too); default: next to the run's result; listed as videoPaths");
  }
  if (set.overlay === true) cmd.option("--no-overlay", "with --headed: hide the on-page overlay (step, intent, target highlight, outcome banner)");
  return cmd;
}

/** Raw commander value of `--screenshots [mode|dir]` (#251). */
export interface ScreenshotsFlags {
  screenshots?: boolean | string;
}

/**
 * #251: `--screenshots [mode|dir]` — masked screenshots of the run (one per distinct screen, or
 * `steps`: one per step) plus an `index.md` contact sheet; parsed by `parseScreenshotsArg`.
 */
export function withScreenshotsFlag(cmd: Command): Command {
  return cmd.option(
    "--screenshots [mode|dir]",
    "masked screenshots + index.md: one per distinct screen (default), `steps` one per step; `screens:<dir>`/`steps:<dir>`/`<dir>` set the folder (default: next to the run's result); listed as screenshotPaths",
  );
}

/**
 * The runner's `browser` option for the parsed `--browser-*` and demo flags, or `undefined` when none
 * were given. `--headed` (or `JEVITATE_HEADED=1`) without a display throws `HeadedWithoutDisplayError`
 * HERE — before any browser launches — which every command reports as its usage error (exit 64).
 */
export function browserRunFromFlags(
  o: BrowserLaunchFlags & DemoFlags,
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): BrowserRunOptions | undefined {
  const headed = o.headed === true || headedFromEnv(env);
  assertHeadedDisplay(headed, env, platform);
  const run: BrowserRunOptions = {
    ...browserLaunchFromFlags(o),
    ...(headed ? { headed: true } : {}),
    ...(o.slowMo === undefined ? {} : { slowMo: o.slowMo }),
    ...(o.recordVideo === undefined || o.recordVideo === false
      ? {}
      : { recordVideo: typeof o.recordVideo === "string" ? { dir: resolvePath(o.recordVideo) } : {} }),
    ...(o.overlay === false ? { overlay: false } : {}),
  };
  return Object.keys(run).length > 0 ? run : undefined;
}

/** `{ browser }` for the parsed `--browser-*` flags, or `{}` when none were given — spread into a runner's options. */
export function browserOption(o: BrowserLaunchFlags): { browser?: BrowserLaunchOptions } {
  const launch = browserLaunchFromFlags(o);
  return launch === undefined ? {} : { browser: launch };
}

/** Raw commander values of the shared `--viewport`/`--device` emulation flags (#149) and `--geolocation` (#329). */
export interface EmulationFlags {
  viewport?: string;
  device?: string;
  geolocation?: string;
}

/**
 * Adds the shared `--viewport <W>x<H>` / `--device "<name>"` flags (#149) to a browser-driving
 * command — mutually exclusive, on `explore`, `journey run`, `load run`, `source run`, `verify-fix`
 * and `regression capture`/`run`. Absent both: Playwright's default (desktop) viewport, documented
 * in each command's `--help`.
 */
export function withEmulationFlags(cmd: Command, opts: { readonly geolocation?: boolean } = {}): Command {
  const out = cmd
    .option("--viewport <WxH>", "emulate a viewport of this size, e.g. --viewport 375x812 (mutually exclusive with --device)")
    .option(
      "--device <name>",
      'emulate a Playwright registered device by name, e.g. --device "iPhone 13" (viewport + scale + mobile/touch + UA; mutually exclusive with --viewport)',
    );
  // #329: a fixed position for "near me" pages; the permission is granted to the allowed origins only.
  return opts.geolocation === false
    ? out
    : out.option(
        "--geolocation <lat,lng>",
        "place the browser at this position, e.g. --geolocation 41.6376,-70.9036 (optional third value: accuracy in metres); " +
          "the geolocation permission is granted to the run's allowed origins only",
      );
}

/**
 * The `EmulationSpec` for the parsed flags, or `undefined` when neither was given (Playwright's own
 * default viewport applies). Refused HERE, before any browser opens, when both are given —
 * `resolveEmulation` (an unknown `--device`, or both together) is also re-checked wherever the spec
 * is finally used, so every call path fails closed the same way.
 */
export function emulationFromFlags(o: EmulationFlags): EmulationSpec | undefined {
  const spec: EmulationSpec = {
    ...(o.viewport !== undefined ? { viewport: parseViewport(o.viewport) } : {}),
    ...(o.device !== undefined ? { device: o.device } : {}),
    // #329: refused here (InvalidGeolocationError) when malformed, before any browser opens.
    ...(o.geolocation !== undefined ? { geolocation: parseGeolocation(o.geolocation) } : {}),
  };
  if (Object.keys(spec).length === 0) return undefined;
  resolveEmulation(spec); // throws UnknownDeviceError / ConflictingEmulationError before any browser opens
  return spec;
}

/**
 * Parses repeated `--param key=value` flags into a `Record<string,string>`.
 * `previous` starts as the option's default (`{}`) and this is called once
 * per occurrence, commander's standard "collect" pattern.
 */
export function collectParam(value: string, previous: Record<string, string>): Record<string, string> {
  const idx = value.indexOf("=");
  const key = idx === -1 ? value : value.slice(0, idx);
  const val = idx === -1 ? "" : value.slice(idx + 1);
  return { ...previous, [key]: val };
}

export function makeClock() {
  return {
    nowIso: () => clock.nowIso(),
    monotonicMs: () => clock.now(),
  };
}

export async function withSitePolicyRepository<T>(
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

export function isPlannedStep(value: unknown): value is PlannedStep {
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

export function parsePlannedScript(raw: string): PlannedStep[] {
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
 * output routed to their writer. Also sets `process.exitCode` (0 for `ok`; for
 * `fail`, the error's class from exit-codes.ts — 64 usage, else 2) instead of
 * hard-exiting, so `exitOverride()` in tests works.
 */
export function emitJson(program: Command, envelope: JsonEnvelope<unknown>): void {
  // #218: a refusal without --json is a human `error <CODE>: …` line on stderr (cli-refusal.ts).
  emitJsonOrRefusal(program, envelope);
  if (envelope.ok) emitUsageLine(program, envelope.data);
}

/**
 * #210: the envelope with `--json`, else a human summary (a refusal: `error <CODE>: …` on stderr);
 * the cost line on stderr either way. Exit code: the verdict's, else the envelope's class (exit-codes.ts).
 */
export function emitCommandResult<T>(program: Command, envelope: JsonEnvelope<T>, opts: EmitOptions<T>): void {
  emitEnvelope(program, envelope, opts);
  if (envelope.ok) emitUsageLine(program, envelope.data);
}

/**
 * #221: a user-supplied name that becomes a path (a profile name, a regression id) must be one safe
 * segment (`assertSafeName`, @jevitate/domain). Refuses it (E_INVALID_NAME, exit 64) and returns true.
 */
export function refuseUnsafeName(program: Command, name: string, what: string): boolean {
  try {
    assertSafeName(name, what);
    return false;
  } catch (err) {
    if (!(err instanceof UnsafeNameError)) throw err;
    emitJson(program, fail(err.code, err.message));
    return true;
  }
}

/** A non-`--json` result: printed as bare JSON on stdout, with the cost summary line on stderr. */
export function writeRawResult(program: Command, result: unknown): void {
  program.configureOutput().writeOut?.(`${JSON.stringify(result)}\n`);
  emitUsageLine(program, result);
}

/** A non-`--json` result (#227): the human summary a `cli-output.ts` formatter renders, with the cost summary line on stderr. */
export function writeHumanResult(program: Command, result: unknown, human: (data: unknown) => string): void {
  const text = human(result);
  if (text !== "") program.configureOutput().writeOut?.(text);
  emitUsageLine(program, result);
}

/**
 * The human cost summary (#163) — on STDERR, so stdout stays exactly the JSON a caller parses:
 * `usage: cost $0.0312 (jev $0.0203 + generation $0.0109) · 398 judgments, …`, flagged
 * `(partial: …)` when some call could not be priced. Nothing when the result carries no usage.
 */
export function emitUsageLine(program: Command, data: unknown): void {
  if (data === null || typeof data !== "object") return;
  const usage = usageCountsFrom((data as { usage?: unknown }).usage);
  if (usage === undefined || usage.judgments + usage.generations === 0) return;
  program.configureOutput().writeErr?.(`usage: ${formatUsageLine(usage)}\n`);
}

/**
 * `explore --help` trailer documenting every `outcome`/`stop`/`missionOutcome` value and its
 * exit code (issue #83 item 2) — mirrors the README "Mission outcomes and exit codes" /
 * "Every outcome, stop and missionOutcome value" sections, derived from the same sources:
 * `MISSION_EXIT_CODES` (@jevitate/domain) and `goalExitCode`/`missionExitCode` (./mission-exit.ts).
 */
/** `--stall-timeout <seconds>` (#114) → milliseconds; `undefined` when omitted, `null` when not a positive number. */
export function stallTimeoutMs(raw: string | number | undefined): number | undefined | null {
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
}

/** #230: the only `--strategy` values `explore` accepts; anything else is refused, never silently run as goal. */
export const EXPLORE_STRATEGIES = ["goal", "coverage", "exploratory", "adversarial", "usability"] as const;

export const EXPLORE_OUTCOME_HELP = `
Outcomes, stop reasons and exit codes:
  Every result carries a canonical missionOutcome (and exitCode), whatever the strategy:
    clean 0 · defects-found 1 · inconclusive 2 · crashed 2 · hang 3 · intermittent 4
  --strategy goal also carries its own ending as "goalOutcome" (= its "outcome"), folded onto missionOutcome:
    succeeded → clean 0 · failed / exhausted / blocked → defects-found 1
    (defects-found, inconclusive, crashed, hang, intermittent are themselves)
    a defect never replaces goalOutcome: every result also carries defectOutcome {status none|defects, byKind},
    and a succeeded goal with defects is missionOutcome defects-found 1 (goalOutcome stays succeeded);
    a goal not achieved also carries goalReason (not-found, ungrounded, blocked-by-policy, gave-up,
    no-progress, budget, hang, vacuous-check, success-check-failed, broken-run)
  --strategy goal's "stop" (why the loop itself stopped; not separately exit-coded):
    done | blocked | exhausted | no-progress | hang | inconclusive | crashed | budget
    (a "done" code rejected ends stop done, goalOutcome failed — never blocked)
  --strategy adversarial's "stop" (why the hunt ended; its "outcome" is the canonical one above):
    step-budget | action-budget | time-budget | strategies-exhausted | not-rendered
    | scope-unreachable | targets-refused | target-unresponsive | identity-changed | stalled | hang
    | crashed
    (identity-changed: an action switched the signed-in identity and the original one could not be
    restored — inconclusive; every switch is listed in "identityChanges")
  --strategy coverage/exploratory's own "outcome" (folds into missionOutcome above):
    exhausted | insufficient-coverage | cap | scope-unreachable | stalled | crashed | hang
  A run that proved nothing is inconclusive with failure.kind insufficient-coverage (the same word as
  the frontier outcome), and failure.message says how to reach clean.
  A starved host (#203): every result carries "hostHealth" (peak load/core, min free memory, peak
  event-loop lag, slowest render). A hang, click timeout or no-progress met while the host was
  starved is listed in "environmentDegraded" (advisory, never a finding); a run most of whose steps
  ran starved is inconclusive (failure.kind degraded-environment), never clean.
  --feature's own "outcome" (folds into missionOutcome above):
    exhausted | insufficient-coverage | cap | path-cap | scope-unreachable | stalled | crashed | hang
  Argument/input errors (E_EXPLORE_ARGS, E_EXPLORE_ASSERTION, …) exit 64, never 1.
  Without --json: a human summary (verdict, defects by fingerprint, result file, next step);
  with --json: the {v, ok, data} envelope.
  Every command's exit codes: docs/outcomes.md "Exit codes".
`;

/** #291: the startup key check's env (opt-out) and verifier (injectable: tests never touch the network). */
function keyPreflightOpts(deps: CliDeps): Parameters<typeof preflightRunKeys>[2] {
  return { env: deps.explore?.env ?? process.env, fetchFn: deps.explore?.verifyFetch ?? deps.ai?.verifyFetch ?? realVerifyFetch };
}

/** Distinct from MissingCredentialError: "no --real/--fake-ai selected" vs "keys missing." */
export class GatewaySelectionError extends Error {}

export const DEFAULT_EXPLORE_CATALOG: CatalogModel[] = [
  { id: "openai/gpt-4o-mini", promptUsdPer1k: 0.15, completionUsdPer1k: 0.6, regions: [], latencyClass: "fast", capabilities: [] },
];
export const DEFAULT_EXPLORE_CONSTRAINTS: ModelConstraints = { requiredCapabilities: [] };

/**
 * Selects the exploration gateways. Injected gateways (tests) win; otherwise
 * `--real` builds the live Jev + OpenRouter adapters behind a fail-closed
 * credential preflight, and `--fake-ai` uses deterministic fakes (a pipeline
 * smoke — the fake judge always proposes `done`, so it will not drive to a
 * goal). No selection is a fail-closed refusal, never a silent fake.
 */
export async function buildExploreGateways(
  deps: CliDeps,
  opts: { real: boolean; fakeAi: boolean; jevProvider?: string },
): Promise<{ judge: JudgmentPort; gen: GenerationPort; usage: UsageTracker }> {
  // #100: ONE tracker per invocation, handed to whichever gateways are built below — real (counted
  // at the innermost seam, so a retry counts too) or fake (0 tokens, so a test can assert the shape
  // without a key). Injected gateways (tests) get an empty tracker: they have no real seam to count.
  // #136/#163: configured prices (env/config) override the built-in, versioned price tables.
  // #213: --real and --fake-ai are mutually exclusive — silently preferring one (real used to win)
  // hides that the caller's own flags contradict each other.
  if (opts.real && opts.fakeAi) {
    throw new GatewaySelectionError("--real and --fake-ai are mutually exclusive — pass one, not both");
  }
  const usage = deps.explore?.usage ?? new UsageTracker(resolveUsagePricing(deps.explore?.env ?? process.env));
  if (deps.explore?.judge && deps.explore?.gen) {
    return { judge: deps.explore.judge, gen: deps.explore.gen, usage };
  }
  const store = envCredentialStore(deps.explore?.env ?? process.env, deps.explore?.localConfig ?? loadLocalCredentials());
  if (opts.real) {
    // #429: judgment runs on the TypeSafe key or (Jev through OpenRouter) the OpenRouter key;
    // `--jev-provider` / JEVITATE_JEV_PROVIDER pins one. An unknown provider is refused, never ignored.
    let jevProvider: JevProvider | undefined;
    try {
      jevProvider = jevProviderOverride(deps.explore?.env ?? process.env, opts.jevProvider);
    } catch (err) {
      if (err instanceof JevProviderError) throw new GatewaySelectionError(err.message);
      throw err;
    }
    requireKeys("generation", store); // fail-closed
    requireKeys("judgment", store, jevProvider); // fail-closed
    // #291: a key the provider rejects fails the run at startup (typed setup refusal), once per process.
    await preflightRunKeys(["generation", "judgment"], store, { ...keyPreflightOpts(deps), ...(jevProvider === undefined ? {} : { jevProvider }) });
    const gen = new OpenRouterGenerationGateway({
      store,
      catalog: DEFAULT_EXPLORE_CATALOG,
      constraints: DEFAULT_EXPLORE_CONSTRAINTS,
      call: await realOpenRouterCall(usage),
    });
    const judge = new JevJudgmentGateway(store, await realJevClientCall(undefined, usage), jevProvider);
    // Transient model/network failures are retried with exponential backoff + jitter (≈16s), then
    // fail typed; validation/auth errors fail at once (owner ruling 4).
    return { judge: new RetryingJudgmentPort(judge), gen: new RetryingGenerationPort(gen), usage };
  }
  if (opts.fakeAi) {
    return { judge: fakeDoneJudge(usage), gen: new FakeGenerationGateway(undefined, usage), usage };
  }
  throw new GatewaySelectionError(
    "no gateway selected — pass --real for live Jev+OpenRouter (after `jevitate ai setup`), or --fake-ai for a deterministic pipeline smoke",
  );
}

/**
 * #246: the generation gateway ALONE (`journey annotate` drafts text and asks no judgment
 * question, so it needs no Jev key). Same selection rules as `buildExploreGateways`: injected (tests)
 * wins, `--real` is fail-closed on the OpenRouter key, `--fake-ai` is the deterministic fake, the two
 * are exclusive, and no selection is a refusal — never a silent fake.
 */
export async function buildGenerationGateway(
  deps: CliDeps,
  opts: { real: boolean; fakeAi: boolean },
): Promise<{ gen: GenerationPort; usage: UsageTracker }> {
  if (opts.real && opts.fakeAi) {
    throw new GatewaySelectionError("--real and --fake-ai are mutually exclusive — pass one, not both");
  }
  const usage = deps.explore?.usage ?? new UsageTracker(resolveUsagePricing(deps.explore?.env ?? process.env));
  if (deps.explore?.gen) return { gen: deps.explore.gen, usage };
  if (opts.real) {
    const store = envCredentialStore(deps.explore?.env ?? process.env, deps.explore?.localConfig ?? loadLocalCredentials());
    requireKeys("generation", store); // fail-closed
    await preflightRunKeys(["generation"], store, keyPreflightOpts(deps)); // #291
    const gen = new OpenRouterGenerationGateway({
      store,
      catalog: DEFAULT_EXPLORE_CATALOG,
      constraints: DEFAULT_EXPLORE_CONSTRAINTS,
      call: await realOpenRouterCall(usage),
    });
    return { gen: new RetryingGenerationPort(gen), usage };
  }
  if (opts.fakeAi) return { gen: new FakeGenerationGateway(undefined, usage), usage };
  throw new GatewaySelectionError(
    "no gateway selected — pass --real for live OpenRouter generation (after `jevitate ai setup generation`), or --fake-ai for a deterministic pipeline smoke",
  );
}

/**
 * A judge that always proposes `done` — used only by `--fake-ai` (smoke). It is TOTAL and
 * deterministic: it answers EVERY question it is asked, whatever the mission or rubric names it
 * (#213) — a choice offering `done` picks `done` (so the goal/coverage loop stops at once, and
 * will not drive to a goal); a choice that does NOT offer `done` (e.g. the UX quality grader's
 * label set, `grade::0`) deterministically picks its first listed option instead of throwing; a
 * noul answers "no"; a score answers 0. It never throws on a question SHAPE it does not
 * specifically know about — only on a malformed one (a choice with no options at all), which is a
 * bug upstream, not an unknown question. `usage` (#100) is optional: when supplied, every call
 * reports 1 judgment at 0 tokens.
 */
export function fakeDoneJudge(usage?: UsageSink): JudgmentPort {
  return {
    async systemOne(args: { state: JudgmentState; questions: Record<string, Question> }): Promise<Record<string, Answer>> {
      const out: Record<string, Answer> = {};
      for (const [name, q] of Object.entries(args.questions)) {
        switch (q.kind) {
          case "choice": {
            // #213: total over every choice family, not just the goal/coverage loop's `done`.
            const value = q.options.includes("done") ? "done" : q.options[0];
            if (value === undefined) throw new Error(`fake judge: question '${name}' offers no options`);
            out[name] = { kind: "choice", value, confidence: 1 };
            break;
          }
          case "noul":
            out[name] = { kind: "noul", value: false, probability: 0 };
            break;
          case "score":
            out[name] = { kind: "score", value: 0 };
            break;
          default: {
            const exhaustive: never = q;
            throw new Error(`fake judge: unsupported question ${JSON.stringify(exhaustive)}`);
          }
        }
      }
      usage?.recordJudgment(FAKE_CALL_USAGE);
      return out;
    },
  };
}
