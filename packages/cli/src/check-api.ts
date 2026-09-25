import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { aggregateOf, formatUsageLine, type GenerationPort, type JudgmentPort, type UsageAggregate, type UsageCounts, type UsageTracker } from "@jevitate/ai-core";
import type { BrowserLaunchOptions, BrowserPort } from "@jevitate/playwright";
import type { InvariantSpec } from "@jevitate/recording";
import { FsJourneyStore, JourneyRegistry, type Journey } from "@jevitate/journey";
import type { JourneyRunResult } from "@jevitate/runtime";
import {
  matchGlob,
  parseSecretField,
  scopeGlobs,
  secretFieldSecrets,
  SecretFieldSpecError,
  type MisuseStrategy,
  type SecretField,
  type SuccessCheck,
} from "@jevitate/explore";
import { buildMissionFixtures, checkSetupRefs } from "./fixture-cli.js";
import { FixtureSpecError, SETUP_REF, UnboundSetupRefError, substituteSetupRefs, type MissionFixtures } from "./mission-fixtures.js";
import {
  consolidate,
  diffRuns,
  renderJUnit,
  renderReportMarkdown,
  renderSarif,
  type ConsolidatedDefect,
  type DiffEntry,
  type FindingIdentity,
  type FindingsDiff,
  type GateCase,
  type RunRecord,
} from "@jevitate/findings";
import {
  parseSuccessSpec,
  resolveExploreAllowlist,
  runAdversarialCliMission,
  runCoverageMission,
  runExploration,
  runFeatureCliMission,
  type ServerLogOptions,
} from "./explore-api.js";
import { runJourneyProgrammatically, type RunJourneyProgrammaticallyOptions } from "./journey-api.js";
import { runUsabilityMission } from "./ux-api.js";
import { runVerifyFix } from "./verify-fix-api.js";
import { loadInvariantFiles, resolveInvariantAuthTokens } from "./invariants-file.js";
import { serverLogFromTargetConfig } from "./mission-queue-runner.js";
import { resolveTargetConfig, type TargetConfig } from "./target-config.js";
import { currentEngineInfo, type EngineInfo } from "./engine.js";
import { artifactStamp } from "./mission-journal.js";
import type { CheckSuite, SuiteBudget, SuiteGoal, SuiteJourney, SuiteMission, SuiteTarget, SuiteVerifyFix } from "./check-suite.js";
import { loadRunFile, resolveBaseline, scanRuns, summarizeRun, type RunSummary } from "./report-api.js";

/**
 * `jevitate check --suite <file>` (#137): jevitate as a CI regression gate. Runs every suite item
 * — promoted Journeys, goals, missions, verify-fix replays — SEQUENTIALLY through the existing
 * runners, inside one total action / wall-clock / USD budget, then decides pass/fail from the
 * shared finding identity (`@jevitate/findings`):
 *
 *  - HARD findings fail the gate: a Journey assertion failed, an invariant was violated, a goal
 *    success check failed, a verify-fix still reproduces (or is intermittent), a hard-signal
 *    defect or a hang. Advisory findings (UX, 4xx-correlated console errors, Jev flags) never do,
 *    unless the suite sets `gateAdvisory`.
 *  - With `--baseline`, only findings NOT seen in the baseline gate ("new", including a new flaky
 *    one); findings already in the baseline are tracked, not gated.
 *  - Fail closed: an item that could not prove anything (crashed, inconclusive, refused) and any
 *    budget overrun fail the gate; nothing that did not run is ever reported as passing.
 *
 * Everything is validated before the first browser opens (suite, invariant files and their probe
 * origins, success specs, Journeys and their origins, verify-fix inputs, the model gateway). Every
 * result is stamped with the engine identity and the caller's `--target-build`.
 */

export class CheckPreflightError extends Error {
  readonly code = "E_CHECK_SUITE" as const;
  constructor(message: string) {
    super(message);
    this.name = "CheckPreflightError";
  }
}

/** The suite needs a model gateway and none was selected (fail closed, before anything runs). */
export class CheckAiSetupError extends Error {
  readonly code = "E_AI_SETUP_REQUIRED" as const;
  constructor(message: string) {
    super(message);
    this.name = "CheckAiSetupError";
  }
}

export interface CheckGateways {
  readonly judge: JudgmentPort;
  readonly gen: GenerationPort;
  readonly usage: UsageTracker;
}

/** The runners (real by default; tests inject fakes). */
export interface CheckRunners {
  readonly journey: (o: RunJourneyProgrammaticallyOptions) => Promise<JourneyRunResult>;
  readonly goal: typeof runExploration;
  readonly coverage: typeof runCoverageMission;
  readonly adversarial: typeof runAdversarialCliMission;
  readonly feature: typeof runFeatureCliMission;
  readonly usability: typeof runUsabilityMission;
  readonly verifyFix: typeof runVerifyFix;
}

const REAL_RUNNERS: CheckRunners = {
  journey: runJourneyProgrammatically,
  goal: runExploration,
  coverage: runCoverageMission,
  adversarial: runAdversarialCliMission,
  feature: runFeatureCliMission,
  usability: runUsabilityMission,
  verifyFix: runVerifyFix,
};

/** The adversarial strategies `explore --strategy adversarial` runs, in the same order. */
const ADVERSARIAL_STRATEGIES: readonly MisuseStrategy[] = [
  "double-submit",
  "boundary-submit",
  "edit-cancel-save",
  "navigate-away-unsaved",
  "act-while-pending",
  "exercise-controls",
  "ordering-violation",
  "repeat-rapid",
  "boundary-input",
  "contradictory-actions",
  "nav-during-pending",
  "visit-route",
];

export interface RunCheckOptions {
  readonly suite: CheckSuite;
  /** Where results, JUnit, SARIF, the report and the check record go. */
  readonly outDir: string;
  /** The caller's target build/commit id, stamped on every result. */
  readonly targetBuild?: string;
  /** `--baseline <run|tag|last>`: only findings not in it gate. */
  readonly baseline?: string;
  /** Dirs searched for run ids and `last` (default: this check's results dir). */
  readonly baselineDirs?: readonly string[];
  readonly baselinesDir?: string;
  /** `--changed-routes`: only Journeys and goals touching these route globs run. */
  readonly changedRoutes?: readonly string[];
  readonly junitPath?: string;
  readonly sarifPath?: string;
  readonly jsonPath?: string;
  /** Default Journeys dir (`~/.jevitate/journeys`) for targets that name none. */
  readonly journeysDir: string;
  /**
   * Builds the model gateways — called only when an item needs one. Throws when no gateway is
   * selected (fail closed, before anything runs).
   */
  readonly gateways?: () => Promise<CheckGateways>;
  /** The selected gateway kind: `fake` gateways cost nothing (USD 0), so `maxUsd` is measurable. */
  readonly aiMode?: "real" | "fake";
  /** Per-origin settle/hang configuration (`~/.jevitate/targets.json`). */
  readonly targetsConfig?: Readonly<Record<string, TargetConfig>>;
  /** Where a target's `secretFields` read their values (default `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly browserPortFactory?: () => BrowserPort;
  readonly browser?: BrowserLaunchOptions;
  readonly runners?: Partial<CheckRunners>;
  /** Clock seams. */
  readonly now?: () => number;
  readonly nowIso?: () => string;
  /** The suite file as the caller named it (SARIF's physical location). Default: its absolute path. */
  readonly suiteUri?: string;
}

export type ItemKind = "journey" | "goal" | "mission" | "verify-fix";

export interface CheckItemReport {
  readonly target: string;
  readonly kind: ItemKind;
  readonly name: string;
  readonly strategy?: string;
  /** `ran`: a result exists; `error`: the item could not prove anything; `skipped`: not affected by `--changed-routes`. */
  readonly status: "ran" | "error" | "skipped";
  readonly error?: { readonly type: string; readonly message: string };
  readonly resultPath?: string;
  readonly runId?: string;
  readonly outcome?: string;
  readonly actions: number;
  readonly durationMs: number;
  /** JUnit verdict after gating. */
  readonly verdict: "passed" | "failed" | "error" | "skipped";
  /** Keys of the gating findings this item's run observed. */
  readonly gating: readonly string[];
}

export interface BudgetReport {
  readonly limits: SuiteBudget;
  readonly used: { readonly actions: number; readonly minutes: number; readonly usd?: number };
  /** Why the budget was exceeded (fail closed), or absent. */
  readonly exceeded?: string;
}

export interface CheckFinding {
  readonly key: string;
  readonly title: string;
  readonly category: string;
  readonly severity: string;
  readonly identity: FindingIdentity;
  readonly gating: boolean;
  readonly status?: DiffEntry["status"];
  readonly modes: ConsolidatedDefect["modes"];
  readonly reproduce?: string;
}

export interface CheckResult {
  readonly kind: "jevitate-check";
  readonly suite: string;
  readonly suitePath: string;
  readonly verdict: "pass" | "fail";
  /** 0 pass · 1 a gating finding · 2 no gating finding, but an item errored or the budget was exceeded. */
  readonly exitCode: 0 | 1 | 2;
  readonly engine: EngineInfo;
  readonly targetBuild?: string;
  readonly startedAt: string;
  readonly budget: BudgetReport;
  /**
   * Model usage summed over every item that ran (#163): calls, tokens, `jevUsd` + `generationUsd` =
   * `totalUsd`, and `priced` (a `partial` total fails a `maxUsd` budget closed). Absent when no item
   * needed a model gateway.
   */
  readonly usage?: UsageAggregate;
  readonly items: readonly CheckItemReport[];
  readonly findings: readonly CheckFinding[];
  readonly summary: {
    readonly items: number;
    readonly passed: number;
    readonly failed: number;
    readonly errors: number;
    readonly skipped: number;
    readonly gatingFindings: number;
  };
  readonly diff?: { readonly baseline: readonly RunSummary[]; readonly summary: FindingsDiff["summary"] };
  /** Every result file this check wrote (what `report`/`diff`/`baseline tag` read back). */
  readonly results: readonly string[];
  readonly junitPath: string;
  readonly sarifPath: string;
  readonly jsonPath: string;
  readonly reportPath: string;
}

// ── budget ───────────────────────────────────────────────────────────────────

/** Why a spend is not measurable: what could not be priced. */
function unmeasurable(usage: UsageCounts | undefined): string {
  const missing = usage?.missing ?? [];
  return `${usage?.priced === "none" ? "unpriced" : "only partially priced"}${missing.length === 0 ? "" : ` — missing: ${missing.join("; ")}`}`;
}

/** The suite's total budget. Exceeding any limit fails the check (fail closed). */
export class BudgetMeter {
  readonly #limits: SuiteBudget;
  readonly #now: () => number;
  readonly #start: number;
  readonly #costKnownZero: boolean;
  #actions = 0;
  #exceeded: string | undefined;

  constructor(limits: SuiteBudget, opts: { now?: () => number; costKnownZero?: boolean } = {}) {
    this.#limits = limits;
    this.#now = opts.now ?? Date.now;
    this.#start = this.#now();
    this.#costKnownZero = opts.costKnownZero === true;
  }

  get actions(): number {
    return this.#actions;
  }

  /** Actions left (undefined: no action limit). */
  remainingActions(): number | undefined {
    return this.#limits.maxActions === undefined ? undefined : this.#limits.maxActions - this.#actions;
  }

  minutes(): number {
    return (this.#now() - this.#start) / 60_000;
  }

  /**
   * The spend so far: 0 when no model call was made (or the gateways are fakes), the FULL total
   * (Jev + generation, #163) when every call was priced, else undefined — a partial total is not a
   * measurable spend, so a `maxUsd` budget fails closed on it rather than passing on an undercount.
   */
  usd(usage: UsageCounts | undefined): number | undefined {
    if (usage === undefined || usage.judgments + usage.generations === 0) return 0;
    if (this.#costKnownZero) return usage.totalUsd ?? 0;
    return usage.priced === "full" ? (usage.totalUsd ?? 0) : undefined;
  }

  /** Records an item's actions and re-checks every limit. Returns why the budget is now exceeded, if it is. */
  charge(actions: number, usage: UsageCounts | undefined): string | undefined {
    this.#actions += actions;
    const l = this.#limits;
    if (this.#exceeded === undefined && l.maxActions !== undefined && this.#actions > l.maxActions) {
      this.#exceeded = `action budget exceeded: ${this.#actions} > ${l.maxActions}`;
    }
    if (this.#exceeded === undefined && l.maxMinutes !== undefined && this.minutes() > l.maxMinutes) {
      this.#exceeded = `time budget exceeded: ${this.minutes().toFixed(2)} > ${l.maxMinutes} min`;
    }
    if (this.#exceeded === undefined && l.maxUsd !== undefined) {
      const usd = this.usd(usage);
      if (usd === undefined) this.#exceeded = `usd budget set but the model spend is ${unmeasurable(usage)} (spend not measurable)`;
      else if (usd > l.maxUsd) this.#exceeded = `usd budget exceeded: $${usd.toFixed(4)} > $${l.maxUsd}`;
    }
    return this.#exceeded;
  }

  /** Can another item start? Returns why not (the budget is exhausted or already exceeded). */
  blocked(usage: UsageCounts | undefined): string | undefined {
    if (this.#exceeded !== undefined) return this.#exceeded;
    const l = this.#limits;
    if (l.maxActions !== undefined && this.#actions >= l.maxActions) return `action budget exhausted: ${this.#actions}/${l.maxActions}`;
    if (l.maxMinutes !== undefined && this.minutes() >= l.maxMinutes) return `time budget exhausted: ${l.maxMinutes} min`;
    if (l.maxUsd !== undefined) {
      const usd = this.usd(usage);
      if (usd === undefined) return `usd budget set but the model spend is ${unmeasurable(usage)} (spend not measurable)`;
      if (usd >= l.maxUsd) return `usd budget exhausted: $${usd.toFixed(4)}/$${l.maxUsd}`;
    }
    return undefined;
  }

  report(usage: UsageCounts | undefined, exceeded: string | undefined): BudgetReport {
    const usd = this.usd(usage);
    return {
      limits: this.#limits,
      used: { actions: this.#actions, minutes: Number(this.minutes().toFixed(3)), ...(usd === undefined ? {} : { usd }) },
      ...(exceeded === undefined ? {} : { exceeded }),
    };
  }
}

// ── changed routes ───────────────────────────────────────────────────────────

/** Concrete paths standing for a route or route glob (`/cart/**` → `/cart`, `/cart/x`). */
function representatives(route: string): string[] {
  if (!route.includes("*")) return [route];
  const concrete = route.replace(/\*\*/g, "x").replace(/\*/g, "x");
  const base = route.split("/*")[0] ?? "";
  return [concrete, base === "" ? "/" : base];
}

/** Does an item covering `routes` touch any changed route glob? No known routes ⇒ it runs. */
export function affectedBy(routes: readonly string[] | undefined, changed: readonly string[]): boolean {
  if (routes === undefined || routes.length === 0) return true;
  return routes.some((r) =>
    changed.some((g) => representatives(r).some((p) => matchGlob(g, p)) || representatives(g).some((p) => matchGlob(r, p))),
  );
}

function pathOf(url: string, base?: string): string {
  try {
    return new URL(url, base).pathname;
  } catch {
    return url;
  }
}

/** The page routes a Journey visits (from its Recording). */
function journeyRoutes(j: Journey): string[] {
  return [...new Set(j.recording.pages.map((p) => pathOf(p.url, j.recording.site)))];
}

// ── helpers ──────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Executed actions in a persisted result: its `actions`, else its transcript's acted steps. */
function actionsOf(result: Json): number {
  if (typeof result.actions === "number") return result.actions;
  let transcript: unknown = result.transcript;
  if (!Array.isArray(transcript) && typeof result.transcriptPath === "string" && existsSync(result.transcriptPath)) {
    try {
      transcript = JSON.parse(readFileSync(result.transcriptPath, "utf8"));
    } catch {
      transcript = [];
    }
  }
  return Array.isArray(transcript) ? transcript.filter((e) => isRecord(e) && e.op !== null && e.op !== undefined).length : 0;
}

interface Stamp {
  readonly engine: EngineInfo;
  readonly targetBuild?: string;
  readonly suite: { readonly name: string; readonly target: string; readonly item: string };
}

/** Adds the check's stamp (engine, target build, suite item) to a result the runner already wrote. */
function stampResultFile(path: string, stamp: Stamp): void {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(raw)) return;
  if (isRecord(raw.result)) {
    raw.result = {
      ...raw.result,
      engine: raw.result.engine ?? stamp.engine,
      suite: stamp.suite,
      ...(stamp.targetBuild === undefined ? {} : { targetBuild: stamp.targetBuild }),
    };
  } else {
    raw.stamp = { engine: stamp.engine, target: stamp.suite.target, item: stamp.suite.item, ...(stamp.targetBuild === undefined ? {} : { targetBuild: stamp.targetBuild }) };
  }
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

/** The flat step index → the page URL that step ran on (for a failed Journey step's route). */
function journeyStepUrl(j: Journey, at: number | undefined): string | undefined {
  if (at === undefined) return undefined;
  let i = 0;
  for (const page of j.recording.pages) {
    if (at < i + page.steps.length) {
      try {
        return new URL(page.url, j.recording.site).toString();
      } catch {
        return undefined;
      }
    }
    i += page.steps.length;
  }
  return undefined;
}

function recordingSteps(j: Journey): number {
  return j.recording.pages.reduce((n, p) => n + p.steps.length, 0);
}

// ── planning ─────────────────────────────────────────────────────────────────

interface PreparedTarget {
  readonly target: SuiteTarget;
  readonly allowlist: string[];
  readonly invariants?: InvariantSpec;
  /** The invariants' `authFrom.secret` values, resolved from the environment at preflight (as `explore --invariants`). */
  readonly invariantAuthTokens?: ReadonlyMap<string, string>;
  /** targets.json `logSources`/`logDefect` for the target's origin (as `explore` and the queue apply them). */
  readonly serverLog?: ServerLogOptions;
  readonly config?: TargetConfig;
  readonly journeys: Map<string, Journey>;
  readonly goals: Map<string, SuccessCheck[]>;
  /** The target's `secretFields`, resolved from the environment at preflight (#170). */
  readonly secretFields: readonly SecretField[];
  /** The target's fixtures file (the suite's, else targets.json's), validated at preflight (#170). */
  readonly fixturesFile?: string;
}

/**
 * The target's fixture lifecycle for one item (#170), authenticated like the item's session: the
 * target's storage state and `secretFields`. `undefined` when the target declares no fixtures.
 */
function fixturesFor(p: Pick<PreparedTarget, "target" | "allowlist" | "secretFields" | "fixturesFile">, baseUrl: string): MissionFixtures | undefined {
  if (p.fixturesFile === undefined) return undefined;
  return buildMissionFixtures(
    { fixtures: p.fixturesFile },
    {
      allowlist: p.allowlist,
      baseUrl: baseUrl.replace(SETUP_REF, "0"),
      ...(p.target.storageState === undefined ? {} : { storageState: p.target.storageState }),
      secretFields: p.secretFields,
      secrets: secretFieldSecrets(p.secretFields),
    },
  );
}

interface Planned {
  readonly t: PreparedTarget;
  readonly kind: ItemKind;
  readonly name: string;
  readonly strategy?: string;
  readonly needsAi: boolean;
  readonly skipped?: string;
  readonly journey?: SuiteJourney;
  readonly goal?: SuiteGoal;
  readonly mission?: SuiteMission;
  readonly verify?: SuiteVerifyFix;
}

/** The implicit invariant sweep: a target with invariants but no goal or mission gets one. */
function invariantSweep(): SuiteMission {
  return { name: "invariants", strategy: "feature", feature: "invariants" };
}

async function prepareTarget(t: SuiteTarget, opts: RunCheckOptions): Promise<PreparedTarget> {
  const allowlist = resolveExploreAllowlist(t.url, t.allow);
  let invariants: InvariantSpec | undefined;
  try {
    invariants = loadInvariantFiles(t.invariants, { allowlist, baseUrl: t.url });
  } catch (e) {
    throw new CheckPreflightError(`target ${t.name}: ${errorMessage(e)}`);
  }
  if (t.storageState !== undefined && !existsSync(t.storageState)) {
    throw new CheckPreflightError(`target ${t.name}: storage state not found: ${t.storageState}`);
  }
  const goals = new Map<string, SuccessCheck[]>();
  for (const g of t.goals) {
    try {
      goals.set(g.name, g.success.map(parseSuccessSpec));
    } catch (e) {
      throw new CheckPreflightError(`target ${t.name}: goal ${g.name}: ${errorMessage(e)}`);
    }
    if (g.url !== undefined && !allowlist.includes(new URL(g.url).origin)) {
      throw new CheckPreflightError(`target ${t.name}: goal ${g.name}: ${g.url} is not on the target's allowlist`);
    }
  }
  for (const m of t.missions) {
    if (m.url !== undefined && !allowlist.includes(new URL(m.url).origin)) {
      throw new CheckPreflightError(`target ${t.name}: mission ${m.name}: ${m.url} is not on the target's allowlist`);
    }
  }
  for (const v of t.verifyFix) {
    if (!existsSync(v.result)) throw new CheckPreflightError(`target ${t.name}: verify-fix ${v.name}: result not found: ${v.result}`);
  }
  const journeys = new Map<string, Journey>();
  if (t.journeys.length > 0) {
    const registry = new JourneyRegistry(new FsJourneyStore(t.journeysDir ?? opts.journeysDir));
    for (const sj of t.journeys) {
      const j = await registry.get(sj.id);
      if (j === null || j === undefined) throw new CheckPreflightError(`target ${t.name}: unknown Journey ${JSON.stringify(sj.id)}`);
      if (!j.metadata.promoted) throw new CheckPreflightError(`target ${t.name}: Journey ${sj.id} is not promoted`);
      let origin: string;
      try {
        origin = new URL(j.recording.site).origin;
      } catch {
        throw new CheckPreflightError(`target ${t.name}: Journey ${sj.id} has no site origin (${JSON.stringify(j.recording.site)})`);
      }
      if (!allowlist.includes(origin)) {
        throw new CheckPreflightError(`target ${t.name}: Journey ${sj.id} runs on ${origin}, which is not on the target's allowlist`);
      }
      journeys.set(sj.id, j);
    }
  }
  let config: TargetConfig | undefined;
  try {
    config = resolveTargetConfig(opts.targetsConfig ?? {}, new URL(t.url).origin);
  } catch (e) {
    throw new CheckPreflightError(`target ${t.name}: ${errorMessage(e)}`);
  }
  // #170: secret fields are read from the environment now (an unset variable is a preflight
  // refusal naming it, never its value); the fixtures spec and every ${setup.x} a goal uses are
  // validated before anything runs.
  let secretFields: SecretField[];
  try {
    secretFields = (t.secretFields ?? []).map((s) => parseSecretField(s, "value", opts.env ?? process.env));
  } catch (e) {
    if (!(e instanceof SecretFieldSpecError)) throw e;
    throw new CheckPreflightError(`target ${t.name}: ${e.message}`);
  }
  let invariantAuthTokens: Map<string, string> | undefined;
  let serverLog: ServerLogOptions | undefined;
  try {
    invariantAuthTokens = invariants === undefined ? undefined : resolveInvariantAuthTokens(invariants, opts.env ?? process.env);
    serverLog = serverLogFromTargetConfig(opts.targetsConfig, t.url);
  } catch (e) {
    throw new CheckPreflightError(`target ${t.name}: ${errorMessage(e)}`);
  }
  const fixturesFile = t.fixtures ?? config?.fixtures;
  if (fixturesFile !== undefined || t.goals.some((g) => `${g.url ?? ""}${g.goal}${g.success.join("")}`.includes("${setup."))) {
    try {
      const fx = fixturesFor({ target: t, allowlist, secretFields, ...(fixturesFile === undefined ? {} : { fixturesFile }) }, t.url);
      for (const g of t.goals) checkSetupRefs({ [`goal ${g.name} url`]: g.url, [`goal ${g.name}`]: g.goal, [`goal ${g.name} success`]: g.success }, fx);
    } catch (e) {
      if (!(e instanceof FixtureSpecError || e instanceof UnboundSetupRefError)) throw e;
      throw new CheckPreflightError(`target ${t.name}: fixtures: ${e.message}`);
    }
  }
  return {
    target: t,
    allowlist,
    journeys,
    goals,
    ...(invariants === undefined ? {} : { invariants }),
    ...(invariantAuthTokens === undefined || invariantAuthTokens.size === 0 ? {} : { invariantAuthTokens }),
    ...(serverLog === undefined ? {} : { serverLog }),
    config,
    secretFields,
    ...(fixturesFile === undefined ? {} : { fixturesFile }),
  };
}

function plan(prepared: readonly PreparedTarget[], changed: readonly string[] | undefined): Planned[] {
  const out: Planned[] = [];
  const skip = (routes: readonly string[] | undefined): string | undefined =>
    changed === undefined || changed.length === 0 || affectedBy(routes, changed) ? undefined : `not affected by --changed-routes ${changed.join(",")}`;
  for (const p of prepared) {
    const t = p.target;
    for (const sj of t.journeys) {
      const j = p.journeys.get(sj.id);
      const routes = sj.routes ?? (j === undefined ? undefined : journeyRoutes(j));
      const s = skip(routes);
      out.push({ t: p, kind: "journey", name: sj.id, journey: sj, needsAi: false, ...(s === undefined ? {} : { skipped: s }) });
    }
    for (const g of t.goals) {
      const s = skip(g.routes ?? [pathOf(g.url ?? t.url)]);
      out.push({ t: p, kind: "goal", name: g.name, goal: g, needsAi: true, ...(s === undefined ? {} : { skipped: s }) });
    }
    const missions = t.missions.length === 0 && t.goals.length === 0 && p.invariants !== undefined ? [invariantSweep()] : t.missions;
    for (const m of missions) {
      out.push({ t: p, kind: "mission", name: m.name, strategy: m.strategy, mission: m, needsAi: m.strategy !== "feature" });
    }
    for (const v of t.verifyFix) out.push({ t: p, kind: "verify-fix", name: v.name, verify: v, needsAi: false });
  }
  return out;
}

// ── execution ────────────────────────────────────────────────────────────────

interface Executed {
  readonly status: "ran" | "error";
  readonly resultPath?: string;
  readonly outcome?: string;
  readonly actions: number;
  readonly error?: { type: string; message: string };
}

const BROKEN = new Set(["crashed", "inconclusive"]);

interface ExecContext {
  readonly opts: RunCheckOptions;
  readonly runners: CheckRunners;
  readonly resultsDir: string;
  readonly gateways: () => Promise<CheckGateways>;
  readonly engine: EngineInfo;
  readonly seq: () => string;
}

function missionExecuted(resultPath: string, missionOutcome: string, result: Json): Executed {
  const actions = actionsOf(result);
  if (BROKEN.has(missionOutcome)) {
    const failure = isRecord(result.failure) ? result.failure : undefined;
    const why = typeof failure?.message === "string" ? failure.message : typeof result.reason === "string" ? result.reason : missionOutcome;
    return { status: "error", resultPath, outcome: missionOutcome, actions, error: { type: missionOutcome, message: `run ${missionOutcome}: ${why}` } };
  }
  return { status: "ran", resultPath, outcome: missionOutcome, actions };
}

function bounds(maxActions: number | undefined, maxDecisions: number | undefined, remaining: number | undefined): Record<string, number> | undefined {
  const b: Record<string, number> = {};
  const cap = [maxActions, remaining].filter((n): n is number => n !== undefined);
  if (cap.length > 0) b.maxActions = Math.max(1, Math.min(...cap));
  if (maxDecisions !== undefined) b.maxDecisions = maxDecisions;
  return Object.keys(b).length > 0 ? b : undefined;
}

async function execute(item: Planned, ctx: ExecContext, remaining: number | undefined): Promise<Executed> {
  const { opts, runners } = ctx;
  const t = item.t.target;
  const stamp: Stamp = {
    engine: ctx.engine,
    ...(opts.targetBuild === undefined ? {} : { targetBuild: opts.targetBuild }),
    suite: { name: opts.suite.name, target: t.name, item: item.name },
  };
  const common = {
    outDir: ctx.resultsDir,
    ...(opts.browserPortFactory === undefined ? {} : { browserPortFactory: opts.browserPortFactory }),
    ...(opts.browser === undefined ? {} : { browser: opts.browser }),
    ...(t.storageState === undefined ? {} : { storageState: t.storageState }),
  };
  const invariants = {
    ...(item.t.invariants === undefined ? {} : { invariants: item.t.invariants }),
    ...(item.t.invariantAuthTokens === undefined ? {} : { invariantAuthTokens: item.t.invariantAuthTokens }),
  };
  const withServerLog = item.t.serverLog === undefined ? {} : { serverLog: item.t.serverLog };
  const targetConfig = item.t.config === undefined ? {} : { target: item.t.config };
  // A feature mission takes the target's safety directly (it has no settle/hang config to apply).
  const targetSafety = item.t.config?.safety === undefined ? {} : { safety: item.t.config.safety };

  if (item.kind === "journey" && item.journey !== undefined) {
    const j = item.t.journeys.get(item.journey.id);
    if (j === undefined) return { status: "error", actions: 0, error: { type: "journey", message: `Journey ${item.journey.id} not loaded` } };
    const startedAt = (opts.nowIso ?? (() => new Date().toISOString()))();
    const r = await runners.journey({
      dir: t.journeysDir ?? opts.journeysDir,
      id: item.journey.id,
      params: { ...item.journey.params },
      ...(opts.browserPortFactory === undefined ? {} : { browserPortFactory: opts.browserPortFactory }),
      ...(opts.browser === undefined ? {} : { browser: opts.browser }),
      // #170: the target's session, exactly as `journey run --storage-state` (#118) and its fixtures.
      ...(t.storageState === undefined ? {} : { storageState: t.storageState }),
      ...(item.t.fixturesFile === undefined ? {} : { fixtures: (site: string) => fixturesFor(item.t, site) }),
    });
    const at = r.outcome === "quarantined" ? r.at : undefined;
    const url = journeyStepUrl(j, at);
    const path = join(ctx.resultsDir, `journey-${artifactStamp(startedAt)}-${ctx.seq()}.result.json`);
    const failed = r.outcome === "quarantined";
    const record = {
      missionOutcome: failed ? "defects-found" : "clean",
      exitCode: failed ? 1 : 0,
      result: {
        mode: "journey",
        journeyId: item.journey.id,
        outcome: r.outcome,
        ...(r.outcome === "quarantined" ? { reason: r.reason, ...(r.at === undefined ? {} : { at: r.at }) } : {}),
        ...(url === undefined ? {} : { url }),
        startedAt,
        target: { seedUrl: j.recording.site, allowlist: [new URL(j.recording.site).origin] },
        engine: ctx.engine,
        suite: stamp.suite,
        ...(opts.targetBuild === undefined ? {} : { targetBuild: opts.targetBuild }),
      },
    };
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    const actions = failed && at !== undefined ? at + 1 : recordingSteps(j);
    return { status: "ran", resultPath: path, outcome: r.outcome, actions };
  }

  if (item.kind === "goal" && item.goal !== undefined) {
    const g = item.goal;
    const { judge, gen, usage } = await ctx.gateways();
    // #170: the target's fixtures run around the goal (a failed setup is an item error, never a
    // run on unknown state), and its secret fields are typed by code, as `explore --secret-field`.
    let url = g.url ?? t.url;
    let goal = g.goal;
    let successChecks = item.t.goals.get(g.name) ?? [];
    const fx = fixturesFor(item.t, url);
    try {
      if (fx !== undefined) {
        await fx.setup();
        const b = fx.bindings();
        url = substituteSetupRefs(url, b, { where: `goal ${g.name} url` });
        goal = substituteSetupRefs(goal, b, { where: `goal ${g.name}` });
        successChecks = g.success.map((s) => parseSuccessSpec(substituteSetupRefs(s, b, { where: `goal ${g.name} success` })));
      }
      const r = await runners.goal({
        ...common,
        ...targetConfig,
        ...invariants,
        ...withServerLog,
        url,
        goal,
        successChecks,
        ...(g.successWhen === undefined ? {} : { successWhen: g.successWhen }),
        allowlist: item.t.allowlist,
        judge,
        gen,
        usage,
        bounds: bounds(g.maxActions, g.maxDecisions, remaining),
        ...(item.t.secretFields.length === 0 ? {} : { secretFields: item.t.secretFields }),
        ...(fx === undefined ? {} : { fixtures: fx }),
      });
      stampResultFile(r.resultPath, stamp);
      const executed = missionExecuted(r.resultPath, r.outcome, r as unknown as Json);
      return { ...executed, actions: r.actions };
    } finally {
      await fx?.restore();
    }
  }

  if (item.kind === "mission" && item.mission !== undefined) {
    const m = item.mission;
    const url = m.url ?? t.url;
    const b = bounds(m.maxActions, m.maxDecisions, remaining);
    if (m.strategy === "feature") {
      const r = await runners.feature({
        ...common,
        ...targetSafety,
        ...invariants,
        ...withServerLog,
        seedUrl: url,
        allowlist: item.t.allowlist,
        capability: m.feature ?? m.name,
        routeGlobs: m.routes ?? scopeGlobs(url),
        bounds: b,
      });
      stampResultFile(r.resultPath, stamp);
      return missionExecuted(r.resultPath, r.missionOutcome, r as unknown as Json);
    }
    const { judge, gen, usage } = await ctx.gateways();
    if (m.strategy === "coverage") {
      const r = await runners.coverage({
        ...common,
        ...targetConfig,
        ...invariants,
        ...withServerLog,
        url,
        allowlist: item.t.allowlist,
        judge,
        gen,
        usage,
        bounds: b,
        ...(m.routes === undefined ? {} : { routeGlobs: [...m.routes] }),
      });
      stampResultFile(r.resultPath, stamp);
      return missionExecuted(r.resultPath, r.missionOutcome, r as unknown as Json);
    }
    if (m.strategy === "adversarial") {
      const r = await runners.adversarial({
        ...common,
        ...targetConfig,
        ...invariants,
        ...withServerLog,
        seedUrl: url,
        allowlist: item.t.allowlist,
        strategies: ADVERSARIAL_STRATEGIES,
        judgment: judge,
        generation: gen,
        usage,
        ...(b === undefined ? {} : { bounds: b }),
        ...(m.routes === undefined ? {} : { routeGlobs: [...m.routes] }),
      });
      stampResultFile(r.resultPath, stamp);
      return missionExecuted(r.resultPath, r.outcome, r as unknown as Json);
    }
    // usability: UX findings are advisory; the report file is the result the report reads.
    const r = await runners.usability({
      ...common,
      ...targetConfig,
      ...withServerLog,
      url,
      job: m.goal ?? "",
      appContext: { appClass: m.appClass ?? "", job: m.goal ?? "" },
      allowlist: item.t.allowlist,
      ...(item.t.secretFields.length === 0 ? {} : { secretFields: item.t.secretFields }),
      judge,
      gen,
      usage,
      bounds: b,
    });
    const actions = actionsOf({ transcriptPath: r.transcriptPath });
    if (r.reportPath === null) {
      return { status: "error", outcome: r.missionOutcome, actions, error: { type: "inconclusive", message: r.analysisUnavailable ?? "usability analysis unavailable" } };
    }
    stampResultFile(r.reportPath, stamp);
    if (BROKEN.has(r.missionOutcome)) {
      return { status: "error", resultPath: r.reportPath, outcome: r.missionOutcome, actions, error: { type: r.missionOutcome, message: `usability run ${r.missionOutcome}` } };
    }
    return { status: "ran", resultPath: r.reportPath, outcome: r.missionOutcome, actions };
  }

  if (item.kind === "verify-fix" && item.verify !== undefined) {
    const v = item.verify;
    const startedAt = (opts.nowIso ?? (() => new Date().toISOString()))();
    const source = loadRunFile(v.result);
    const original = source?.observations.find((o) => o.related.includes(v.fingerprint));
    const r = await runners.verifyFix({
      resultPath: v.result,
      fingerprint: v.fingerprint,
      ...(v.replays === undefined ? {} : { replays: v.replays }),
      ...(opts.targetsConfig === undefined ? {} : { targets: opts.targetsConfig }),
      ...(opts.browserPortFactory === undefined ? {} : { browserPortFactory: opts.browserPortFactory }),
      ...(opts.browser === undefined ? {} : { browser: opts.browser }),
      ...(t.storageState === undefined ? {} : { storageState: t.storageState }),
    });
    const missionOutcome =
      r.verdict === "fixed" ? "clean" : r.verdict === "still-reproduces" ? "defects-found" : r.verdict === "intermittent" ? "intermittent" : "inconclusive";
    const path = join(ctx.resultsDir, `verify-${artifactStamp(startedAt)}-${ctx.seq()}.result.json`);
    const record = {
      missionOutcome,
      exitCode: r.exitCode,
      result: {
        mode: "verify-fix",
        source: resolve(v.result),
        fingerprint: v.fingerprint,
        verdict: r.verdict,
        reason: r.reason,
        ...(r.title === undefined ? {} : { title: r.title }),
        ...(original === undefined ? {} : { identity: original.identity }),
        ...(source?.target === undefined ? {} : { target: { seedUrl: source.target } }),
        startedAt,
        engine: ctx.engine,
        suite: stamp.suite,
        ...(opts.targetBuild === undefined ? {} : { targetBuild: opts.targetBuild }),
      },
    };
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    if (r.verdict === "inconclusive") {
      return { status: "error", resultPath: path, outcome: r.verdict, actions: 0, error: { type: "inconclusive", message: `verify-fix inconclusive: ${r.reason}` } };
    }
    if (original === undefined && r.verdict !== "fixed") {
      // Still reproducing, but the source finding's identity could not be read: fail closed as an item error.
      return { status: "error", resultPath: path, outcome: r.verdict, actions: 0, error: { type: r.verdict, message: `verify-fix ${r.verdict}: ${r.reason}` } };
    }
    return { status: "ran", resultPath: path, outcome: r.verdict, actions: 0 };
  }
  return { status: "error", actions: 0, error: { type: "internal", message: `unplannable item ${item.kind} ${item.name}` } };
}

// ── gate ─────────────────────────────────────────────────────────────────────

function caseDetail(defects: readonly ConsolidatedDefect[]): string {
  return defects.map((d) => `${d.key} ${d.title}${d.reproduce === undefined ? "" : `\n  reproduce: ${d.reproduce}`}`).join("\n");
}

export async function runCheck(opts: RunCheckOptions): Promise<CheckResult> {
  const nowIso = opts.nowIso ?? (() => new Date().toISOString());
  const startedAt = nowIso();
  const engine = currentEngineInfo();
  const outDir = resolve(opts.outDir);
  const resultsDir = join(outDir, "results");
  const runners: CheckRunners = { ...REAL_RUNNERS, ...opts.runners };

  // Preflight — everything validated before the first browser opens.
  const prepared: PreparedTarget[] = [];
  for (const t of opts.suite.targets) prepared.push(await prepareTarget(t, opts));
  const items = plan(prepared, opts.changedRoutes);
  let gw: Promise<CheckGateways> | undefined;
  const gateways = (): Promise<CheckGateways> => {
    if (opts.gateways === undefined) return Promise.reject(new CheckAiSetupError("this suite needs a model gateway: pass --real or --fake-ai (or set \"ai\" in the suite)"));
    gw ??= opts.gateways();
    return gw;
  };
  // A missing/unselectable gateway throws here (typed), before any browser opens.
  if (items.some((i) => i.needsAi && i.skipped === undefined)) await gateways();
  await mkdir(resultsDir, { recursive: true });

  const meter = new BudgetMeter(opts.suite.budget, { ...(opts.now === undefined ? {} : { now: opts.now }), costKnownZero: opts.aiMode === "fake" });
  const usage = async (): Promise<UsageCounts | undefined> => (gw === undefined ? undefined : (await gw).usage.snapshot());
  let n = 0;
  const ctx: ExecContext = { opts, runners, resultsDir, gateways, engine, seq: () => String(++n) };
  const now = opts.now ?? Date.now;
  let exceeded: string | undefined;
  const executed: Array<{ item: Planned; ex: Executed | undefined; durationMs: number }> = [];
  for (const item of items) {
    if (item.skipped !== undefined) {
      executed.push({ item, ex: undefined, durationMs: 0 });
      continue;
    }
    const blocked = meter.blocked(await usage());
    if (blocked !== undefined) {
      exceeded ??= blocked;
      executed.push({ item, ex: { status: "error", actions: 0, error: { type: "budget-exceeded", message: `not run: ${blocked}` } }, durationMs: 0 });
      continue;
    }
    const t0 = now();
    let ex: Executed;
    try {
      ex = await execute(item, ctx, meter.remainingActions());
    } catch (e) {
      ex = { status: "error", actions: 0, error: { type: e instanceof Error ? e.name : "error", message: errorMessage(e) } };
    }
    const over = meter.charge(ex.actions, await usage());
    if (over !== undefined) exceeded ??= over;
    executed.push({ item, ex, durationMs: now() - t0 });
  }

  // Findings: the shared identity over every result this check wrote.
  const runs: RunRecord[] = [];
  const runOf = new Map<string, RunRecord>();
  for (const { ex } of executed) {
    if (ex?.resultPath === undefined) continue;
    const run = loadRunFile(ex.resultPath);
    if (run === null) continue;
    runs.push(run);
    runOf.set(ex.resultPath, run);
  }
  const defects = consolidate(runs);
  let diff: FindingsDiff | undefined;
  let baselineRuns: RunRecord[] | undefined;
  if (opts.baseline !== undefined) {
    const dirs = opts.baselineDirs ?? [resultsDir];
    baselineRuns = resolveBaseline(opts.baseline, runs, {
      dirs,
      ...(opts.baselinesDir === undefined ? {} : { baselinesDir: opts.baselinesDir }),
      pool: scanRuns(dirs),
    });
    diff = diffRuns(baselineRuns, runs);
  }
  const entryOf = new Map(diff?.entries.map((e) => [e.key, e]) ?? []);
  const isGating = (d: ConsolidatedDefect): boolean => {
    if (d.severity !== "hard" && !opts.suite.gateAdvisory) return false;
    if (diff === undefined) return true;
    // A finding is matched to its diff entry by any member key (merged cascades).
    const entry = d.keys.map((k) => entryOf.get(k)).find((e) => e !== undefined) ?? entryOf.get(d.key);
    return entry === undefined ? true : !entry.inBaseline;
  };
  const statusOf = (d: ConsolidatedDefect): DiffEntry["status"] | undefined => d.keys.map((k) => entryOf.get(k)?.status).find((s) => s !== undefined);
  const gating = defects.filter(isGating);

  const itemReports: CheckItemReport[] = executed.map(({ item, ex, durationMs }) => {
    const base = {
      target: item.t.target.name,
      kind: item.kind,
      name: item.name,
      ...(item.strategy === undefined ? {} : { strategy: item.strategy }),
      durationMs,
    };
    if (ex === undefined) return { ...base, status: "skipped", actions: 0, verdict: "skipped", gating: [] };
    const run = ex.resultPath === undefined ? undefined : runOf.get(ex.resultPath);
    const own = run === undefined ? [] : gating.filter((d) => d.modes.some((m) => m.runs.some((r) => r.path === run.path)));
    const verdict = ex.status === "error" ? "error" : own.length > 0 ? "failed" : "passed";
    return {
      ...base,
      status: ex.status,
      actions: ex.actions,
      verdict,
      gating: own.map((d) => d.key),
      ...(ex.error === undefined ? {} : { error: ex.error }),
      ...(ex.resultPath === undefined ? {} : { resultPath: ex.resultPath }),
      ...(run === undefined ? {} : { runId: run.runId }),
      ...(ex.outcome === undefined ? {} : { outcome: ex.outcome }),
    };
  });

  const errors = itemReports.filter((i) => i.verdict === "error").length;
  const exitCode: 0 | 1 | 2 = gating.length > 0 ? 1 : errors > 0 || exceeded !== undefined ? 2 : 0;
  const junitPath = resolve(opts.junitPath ?? join(outDir, "junit.xml"));
  const sarifPath = resolve(opts.sarifPath ?? join(outDir, "jevitate.sarif"));
  const jsonPath = resolve(opts.jsonPath ?? join(outDir, "check.json"));
  const reportPath = join(outDir, "report.md");

  const cases: GateCase[] = itemReports.map((i) => {
    const own = gating.filter((d) => i.gating.includes(d.key));
    const first = own[0];
    return {
      suite: i.target,
      classname: `jevitate.${i.target}.${i.kind}${i.strategy === undefined ? "" : `.${i.strategy}`}`,
      name: i.name,
      timeSec: i.durationMs / 1000,
      status: i.verdict,
      ...(i.resultPath === undefined ? {} : { resultPath: i.resultPath }),
      ...(i.verdict === "failed" && first !== undefined
        ? { type: first.category, message: `${own.length} gating finding(s): ${first.title}`, detail: caseDetail(own) }
        : {}),
      ...(i.verdict === "error" && i.error !== undefined ? { type: i.error.type, message: i.error.message } : {}),
      ...(i.verdict === "skipped" ? { message: "not affected by --changed-routes" } : {}),
    };
  });
  if (exceeded !== undefined && !cases.some((c) => c.type === "budget-exceeded")) {
    cases.push({ suite: "budget", classname: "jevitate.budget", name: "total budget", timeSec: 0, status: "error", type: "budget-exceeded", message: exceeded });
  }

  const findings: CheckFinding[] = defects.map((d) => {
    const status = statusOf(d);
    return {
      key: d.key,
      title: d.title,
      category: d.category,
      severity: d.severity,
      identity: d.identity,
      gating: gating.includes(d),
      modes: d.modes,
      ...(status === undefined ? {} : { status }),
      ...(d.reproduce === undefined ? {} : { reproduce: d.reproduce }),
    };
  });
  const finalUsage = await usage();
  const suiteUsage = finalUsage === undefined ? undefined : aggregateOf(finalUsage, executed.filter((e) => e.ex !== undefined).length);
  const result: CheckResult = {
    kind: "jevitate-check",
    suite: opts.suite.name,
    suitePath: opts.suite.path,
    verdict: exitCode === 0 ? "pass" : "fail",
    exitCode,
    engine,
    ...(opts.targetBuild === undefined ? {} : { targetBuild: opts.targetBuild }),
    startedAt,
    budget: meter.report(finalUsage, exceeded),
    ...(suiteUsage === undefined ? {} : { usage: suiteUsage }),
    items: itemReports,
    findings,
    summary: {
      items: itemReports.length,
      passed: itemReports.filter((i) => i.verdict === "passed").length,
      failed: itemReports.filter((i) => i.verdict === "failed").length,
      errors,
      skipped: itemReports.filter((i) => i.verdict === "skipped").length,
      gatingFindings: gating.length,
    },
    ...(diff === undefined || baselineRuns === undefined ? {} : { diff: { baseline: baselineRuns.map(summarizeRun), summary: diff.summary } }),
    results: runs.map((r) => r.path),
    junitPath,
    sarifPath,
    jsonPath,
    reportPath,
  };

  await writeFile(junitPath, renderJUnit(`jevitate check: ${opts.suite.name}`, cases, startedAt), "utf8");
  const sarif = renderSarif({
    toolVersion: engine.version,
    engineCommit: engine.commit,
    ...(opts.targetBuild === undefined ? {} : { targetBuild: opts.targetBuild }),
    suiteUri: opts.suiteUri ?? opts.suite.path,
    automationId: `jevitate-check/${opts.suite.name}/`,
    findings: defects.map((d) => ({ defect: d, gating: gating.includes(d), ...(statusOf(d) === undefined ? {} : { status: statusOf(d) }) })),
  });
  await writeFile(sarifPath, `${JSON.stringify(sarif, null, 2)}\n`, "utf8");
  await writeFile(
    reportPath,
    renderReportMarkdown({ title: `jevitate check: ${opts.suite.name} — ${result.verdict}`, runs, defects, ...(diff === undefined ? {} : { diff }) }) +
      (suiteUsage === undefined ? "" : `\n## Model cost\n\n${formatUsageLine(suiteUsage)}\n`),
    "utf8",
  );
  await writeFile(jsonPath, `${JSON.stringify({ v: 1, ok: true, data: result }, null, 2)}\n`, "utf8");
  return result;
}
