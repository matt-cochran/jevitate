import { recordRun } from "./run-index.js";
import type { EmulationSpec } from "@jevitate/playwright";
import { withSiteGate } from "./site-gate-cli.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { aggregateOf, formatUsageLine, type UsageCounts } from "@jevitate/ai-core";
import { resolveRouteScope } from "@jevitate/explore";
import { type SuiteExploreOptions } from "./suite-explore-options.js";
import { substituteSetupRefs } from "./mission-fixtures.js";
import { consolidate, diffRuns, renderJUnit, renderReportMarkdown, renderSarif, type ConsolidatedDefect, type DiffEntry, type FindingsDiff, type GateCase, type RunRecord } from "@jevitate/findings";
import { CLI_ADVERSARIAL_STRATEGIES, parseSuccessSpec, runAdversarialCliMission, runCoverageMission, runExploration, runFeatureCliMission } from "./explore-api.js";
import { runJourneyProgrammatically } from "./journey-api.js";
import { runUsabilityMission } from "./ux-api.js";
import { runVerifyFix } from "./verify-fix-api.js";
import { currentEngineInfo, type EngineInfo } from "./engine.js";
import { artifactStamp } from "./mission-journal.js";
import { loadRunFile, resolveBaseline, scanRuns, summarizeRun } from "./report-api.js";
import { GOAL_ONLY_OUTCOMES } from "@jevitate/domain";
import { CheckAiSetupError, type CheckFinding, type CheckGateways, type CheckItemReport, type CheckResult, type CheckRunners, type RunCheckOptions } from "./check-types.js";
import { BudgetMeter } from "./check-budget.js";
import { type Json, type Planned, type PreparedTarget, type Stamp, actionsOf, errorMessage, fixturesFor, isRecord, journeyStepUrl, plan, prepareTarget, recordingSteps, sessionOf, stampResultFile, targetFixtures } from "./check-plan.js";
export { affectedBy } from "./check-plan.js";
export { BudgetMeter } from "./check-budget.js";
export { type BudgetReport, CheckAiSetupError, type CheckFinding, type CheckGateways, type CheckItemReport, CheckPreflightError, type CheckResult, type CheckRunners, type ItemKind, type RunCheckOptions } from "./check-types.js";

const REAL_RUNNERS: CheckRunners = {
  journey: runJourneyProgrammatically,
  goal: runExploration,
  coverage: runCoverageMission,
  adversarial: runAdversarialCliMission,
  feature: runFeatureCliMission,
  usability: runUsabilityMission,
  verifyFix: runVerifyFix,
};

// ── execution ────────────────────────────────────────────────────────────────

interface Executed {
  readonly status: "ran" | "error";
  readonly resultPath?: string;
  readonly outcome?: string;
  readonly goalOutcome?: string;
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
  // Goal and mission items run with their own setup (#195): explore's options, target defaults
  // overridden per item; Journey and verify-fix items with the target's, and their own session.
  const setup = item.setup;
  const x: SuiteExploreOptions = setup?.x ?? {};
  const session = setup !== undefined ? setup.storageState : sessionOf(t, item.journey?.storageState ?? item.verify?.storageState);
  const common = {
    outDir: ctx.resultsDir,
    ...(opts.browserPortFactory === undefined ? {} : { browserPortFactory: opts.browserPortFactory }),
    ...(opts.browser === undefined ? {} : { browser: opts.browser }),
    ...(session === undefined ? {} : { storageState: session }),
    ...(x.saveStorageState === undefined ? {} : { saveStorageState: x.saveStorageState }),
  };
  const invariants = {
    ...(item.t.invariants === undefined ? {} : { invariants: item.t.invariants }),
    ...(item.t.invariantAuthTokens === undefined ? {} : { invariantAuthTokens: item.t.invariantAuthTokens }),
  };
  const serverLog = setup?.serverLog ?? (setup === undefined ? item.t.serverLog : undefined);
  const withServerLog = serverLog === undefined ? {} : { serverLog };
  const secretFields = setup?.secretFields ?? item.t.secretFields;
  const withSecretFields = secretFields.length === 0 ? {} : { secretFields };
  const withSecrets = setup?.secrets === undefined ? {} : { secrets: setup.secrets };
  const conversation = {
    ...(x.replyWaitMs === undefined ? {} : { replyWaitMs: x.replyWaitMs }),
    ...(x.replyCeilingMs === undefined ? {} : { replyCeilingMs: x.replyCeilingMs }),
    ...(x.replyMaxChars === undefined ? {} : { replyMaxChars: x.replyMaxChars }),
    ...(x.jobWaitMs === undefined ? {} : { jobWaitMs: x.jobWaitMs }),
  };
  const withConversation = Object.keys(conversation).length === 0 ? {} : { conversation };
  const withOverflow =
    x.checkOverflow === undefined && x.ignoreOverflow === undefined
      ? {}
      : { overflow: { checkOverflow: x.checkOverflow ?? false, ignoreSelectors: x.ignoreOverflow ?? [] } };
  const withStall = x.stallTimeout === undefined ? {} : { stallTimeoutMs: Math.round(x.stallTimeout * 1000) };
  const withHangReplays = x.hangReplays === undefined ? {} : { hangReplays: x.hangReplays };
  const withFixture = x.fixture === undefined ? {} : { fixture: x.fixture };
  // An item's own viewport/device, else its target's.
  const emulationFor = (own: EmulationSpec | undefined): { emulation?: EmulationSpec } => {
    const e = own ?? t.emulation;
    return e === undefined ? {} : { emulation: e };
  };
  const config = setup === undefined ? item.t.config : setup.config;
  const targetConfig = config === undefined ? {} : { target: config };
  // A feature mission takes the target's safety directly (it has no settle/hang config to apply).
  const targetSafety = config?.safety === undefined ? {} : { safety: config.safety };

  if (item.kind === "journey" && item.journey !== undefined) {
    const j = item.t.journeys.get(item.journey.id);
    if (j === undefined) return { status: "error", actions: 0, error: { type: "journey", message: `Journey ${item.journey.id} not loaded` } };
    const startedAt = (opts.nowIso ?? (() => new Date().toISOString()))();
    const sj = item.journey;
    const r = await withSiteGate(opts.sitePolicyDbPath, (siteGate) => runners.journey({
      ...(siteGate === undefined ? {} : { siteGate }),
      dir: t.journeysDir ?? opts.journeysDir,
      id: sj.id,
      params: { ...sj.params },
      ...emulationFor(sj.emulation),
      ...(opts.browserPortFactory === undefined ? {} : { browserPortFactory: opts.browserPortFactory }),
      ...(opts.browser === undefined ? {} : { browser: opts.browser }),
      // #170: the item's session (default: the target's), exactly as `journey run --storage-state` (#118), and its fixtures.
      ...(session === undefined ? {} : { storageState: session }),
      ...(item.t.fixturesFile === undefined ? {} : { fixtures: (site: string) => fixturesFor(targetFixtures(item.t, session), site) }),
    }));
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
    recordRun(path); // #213: a bare `report` in this project finds it
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
    const fx = setup?.fixtures === undefined ? undefined : fixturesFor(setup.fixtures, url);
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
        ...emulationFor(g.emulation),
        ...targetConfig,
        ...invariants,
        ...withServerLog,
        url,
        goal,
        successChecks,
        ...(g.successWhen === undefined ? {} : { successWhen: g.successWhen }),
        ...(x.allowVacuousChecks === true ? { allowVacuousChecks: true } : {}),
        allowlist: item.t.allowlist,
        judge,
        gen,
        usage,
        bounds: bounds(g.maxActions, g.maxDecisions, remaining),
        ...withSecretFields,
        ...withSecrets,
        ...withFixture,
        ...withHangReplays,
        ...withConversation,
        ...(setup?.actors === undefined ? {} : { actors: setup.actors }),
        ...(fx === undefined ? {} : { fixtures: fx }),
      });
      stampResultFile(r.resultPath, { ...stamp, ...(ctx.opts.aiMode === "fake" ? { aiMode: "fake" as const } : {}) });
      // #213: `--fake-ai`'s judge is a deterministic stand-in (it always proposes `done`) — it
      // cannot prove a goal was reached OR missed, so the goal's own judgment-driven ending
      // (`succeeded`/`failed`/`exhausted`/`blocked`: `GOAL_ONLY_OUTCOMES`) is honestly inconclusive
      // under it, never a gating FAILED. A genuine hard signal the run hit along the way (an
      // invariant violation, a 5xx, a hang, a crash — `goalOutcome` holding a shared
      // `MissionOutcome` directly, not a goal-only one) never depended on the judge and still
      // gates. `succeeded` needs no override: it is the clean case.
      if (ctx.opts.aiMode === "fake" && (GOAL_ONLY_OUTCOMES as readonly string[]).includes(r.goalOutcome) && r.goalOutcome !== "succeeded") {
        return {
          status: "error",
          resultPath: r.resultPath,
          outcome: "inconclusive",
          goalOutcome: r.goalOutcome,
          actions: r.actions,
          error: {
            type: "inconclusive",
            message: `goal not verified: --fake-ai has no real judgment (the goal ended '${r.goalOutcome}') — use --real to gate on this goal`,
          },
        };
      }
      // #217: the canonical verdict gates; the goal's own ending rides beside it.
      const executed = missionExecuted(r.resultPath, r.missionOutcome, r as unknown as Json);
      return { ...executed, goalOutcome: r.goalOutcome, actions: r.actions };
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
        ...emulationFor(m.emulation),
        ...targetSafety,
        ...invariants,
        ...withServerLog,
        seedUrl: url,
        allowlist: item.t.allowlist,
        capability: m.feature ?? m.name,
        routeGlobs: resolveRouteScope(url, m.routes).routeGlobs,
        bounds: b,
        ...withStall,
      });
      stampResultFile(r.resultPath, stamp);
      return missionExecuted(r.resultPath, r.missionOutcome, r as unknown as Json);
    }
    const { judge, gen, usage } = await ctx.gateways();
    if (m.strategy === "coverage" || m.strategy === "exploratory") {
      const r = await runners.coverage({
        ...common,
        ...emulationFor(m.emulation),
        ...(m.strategy === "exploratory" ? { strategy: "exploratory" as const } : {}),
        ...targetConfig,
        ...invariants,
        ...withServerLog,
        url,
        allowlist: item.t.allowlist,
        judge,
        gen,
        usage,
        bounds: b,
        ...withStall,
        ...withOverflow,
        ...(m.routes === undefined && x.scope === undefined ? {} : { routeGlobs: [...(m.routes ?? []), ...(x.scope === "app" ? ["/**"] : [])] }),
      });
      stampResultFile(r.resultPath, stamp);
      return missionExecuted(r.resultPath, r.missionOutcome, r as unknown as Json);
    }
    if (m.strategy === "adversarial") {
      const r = await runners.adversarial({
        ...common,
        ...emulationFor(m.emulation),
        ...targetConfig,
        ...invariants,
        ...withServerLog,
        seedUrl: url,
        allowlist: item.t.allowlist,
        strategies: CLI_ADVERSARIAL_STRATEGIES,
        judgment: judge,
        generation: gen,
        usage,
        ...(b === undefined ? {} : { bounds: b }),
        ...(m.routes === undefined ? {} : { routeGlobs: [...m.routes] }),
        ...withSecrets,
        ...withHangReplays,
        ...withOverflow,
        ...(setup?.coverageThresholds === undefined ? {} : { coverageThresholds: setup.coverageThresholds }),
      });
      stampResultFile(r.resultPath, stamp);
      return missionExecuted(r.resultPath, r.outcome, r as unknown as Json);
    }
    // usability: UX findings are advisory; the report file is the result the report reads.
    const r = await runners.usability({
      ...common,
      ...emulationFor(m.emulation),
      ...targetConfig,
      ...withServerLog,
      url,
      job: m.goal ?? "",
      appContext: { appClass: m.appClass ?? "", job: m.goal ?? "" },
      allowlist: item.t.allowlist,
      ...withSecretFields,
      ...withSecrets,
      ...withFixture,
      ...withConversation,
      ...withOverflow,
      ...(x.minConfidence === undefined ? {} : { minConfidence: x.minConfidence }),
      ...(x.show === undefined ? {} : { show: x.show }),
      ...(x.maxFindingsPerPage === undefined ? {} : { maxFindingsPerRoute: x.maxFindingsPerPage }),
      // #225: the job's completion checks — goal-item semantics, never ignored.
      ...(m.success === undefined ? {} : { successChecks: m.success.map(parseSuccessSpec) }),
      ...(m.successWhen === undefined ? {} : { successWhen: m.successWhen }),
      ...(x.allowVacuousChecks === true ? { allowVacuousChecks: true } : {}),
      judge,
      gen,
      usage,
      bounds: b,
    });
    const actions = actionsOf({ transcriptPath: r.transcriptPath });
    // #213: the item points at the PERSISTED result (which carries the UX report), never at the
    // report file alone — the same kind of path every other strategy's item has.
    stampResultFile(r.resultPath, stamp);
    if (r.reportPath === null) {
      return {
        status: "error",
        resultPath: r.resultPath,
        outcome: r.missionOutcome,
        actions,
        error: { type: "inconclusive", message: r.analysisUnavailable ?? "usability analysis unavailable" },
      };
    }
    stampResultFile(r.reportPath, stamp);
    if (BROKEN.has(r.missionOutcome)) {
      return { status: "error", resultPath: r.resultPath, outcome: r.missionOutcome, actions, error: { type: r.missionOutcome, message: `usability run ${r.missionOutcome}` } };
    }
    return { status: "ran", resultPath: r.resultPath, outcome: r.missionOutcome, actions };
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
      ...(session === undefined ? {} : { storageState: session }),
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
    recordRun(path); // #213: a bare `report` in this project finds it
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
  const items = plan(prepared, opts.changedRoutes, opts);
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
      ...(ex.goalOutcome === undefined ? {} : { goalOutcome: ex.goalOutcome }),
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
