// check-execute.ts — `jevitate check` item execution (#231).
import { recordRun } from "./run-index.js";
import type { EmulationSpec } from "@jevitate/playwright";
import { withSiteGate } from "./site-gate-cli.js";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseScreenshotsArg } from "./run-screenshots.js";
import { resolveRouteScope } from "@jevitate/explore";
import { type SuiteExploreOptions } from "./suite-explore-options.js";
import { type BrowserRunOptions } from "./browser-run-options.js";
import { substituteSetupRefs } from "./mission-fixtures.js";
import { type ConsolidatedDefect } from "@jevitate/findings";
import { CLI_ADVERSARIAL_STRATEGIES, parseSuccessSpec } from "./explore-api.js";
import { type EngineInfo } from "./engine.js";
import { artifactStamp } from "./mission-journal.js";
import { loadRunFile } from "./report-api.js";
import { GOAL_ONLY_OUTCOMES } from "@jevitate/domain";
import { type CheckGateways, type CheckRunners, type RunCheckOptions } from "./check-types.js";
import { type Json, type Planned, type Stamp, actionsOf, fixturesFor, isRecord, journeyStepUrl, recordingSteps, sessionOf, stampResultFile, targetFixtures } from "./check-plan.js";
import { applyJourneyEnvironment } from "./environments.js";

// ── execution ────────────────────────────────────────────────────────────────

export interface Executed {
  readonly status: "ran" | "error";
  readonly resultPath?: string;
  readonly outcome?: string;
  readonly goalOutcome?: string;
  readonly actions: number;
  readonly error?: { type: string; message: string };
}

const BROKEN = new Set(["crashed", "inconclusive"]);

export interface ExecContext {
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

/** A goal/mission item's `browser` (#245): the check's launch options plus the item's demo-mode options. */
function itemBrowser(base: BrowserRunOptions | undefined, x: SuiteExploreOptions): BrowserRunOptions | undefined {
  const demo: BrowserRunOptions = {
    ...(x.headed === true ? { headed: true } : {}),
    ...(x.slowMo === undefined ? {} : { slowMo: x.slowMo }),
    ...(x.recordVideo === undefined ? {} : { recordVideo: { dir: x.recordVideo } }),
    ...(x.overlay === false ? { overlay: false } : {}),
  };
  return Object.keys(demo).length === 0 ? base : { ...base, ...demo };
}

export async function execute(item: Planned, ctx: ExecContext, remaining: number | undefined): Promise<Executed> {
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
  // #245: an item's demo mode (headed/slowMo/recordVideo/overlay) on top of the check's launch flags.
  const browser = itemBrowser(opts.browser, x);
  // #251: an item's `screenshots` (validated at preflight); #250: `evidenceVideo`, on by default
  // when the item records video — each defect's captioned repro clip + key screenshots, attached to
  // the result (and so to JUnit, SARIF and report.md).
  const screenshots = parseScreenshotsArg(x.screenshots, "screenshots");
  const evidenceOn = x.evidenceVideo ?? browser?.recordVideo !== undefined;
  const common = {
    ...(screenshots === undefined ? {} : { screenshots }),
    ...(evidenceOn ? { evidenceVideo: true } : {}),
    outDir: ctx.resultsDir,
    ...(opts.browserPortFactory === undefined ? {} : { browserPortFactory: opts.browserPortFactory }),
    ...(browser === undefined ? {} : { browser }),
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
    const stored = item.t.journeys.get(item.journey.id);
    if (stored === undefined) return { status: "error", actions: 0, error: { type: "journey", message: `Journey ${item.journey.id} not loaded` } };
    const startedAt = (opts.nowIso ?? (() => new Date().toISOString()))();
    const sj = item.journey;
    // #247: the item's environment (resolved and checked at preflight); its session when the item and target name none.
    const environment = item.t.environments?.get(sj);
    const j = applyJourneyEnvironment(stored, environment);
    const journeySession = session ?? (sj.storageState === null ? undefined : environment?.storageState);
    const r = await withSiteGate(opts.sitePolicyDbPath, (siteGate) => runners.journey({
      ...(siteGate === undefined ? {} : { siteGate }),
      dir: t.journeysDir ?? opts.journeysDir,
      id: sj.id,
      params: { ...sj.params },
      ...emulationFor(sj.emulation),
      ...(opts.browserPortFactory === undefined ? {} : { browserPortFactory: opts.browserPortFactory }),
      ...(opts.browser === undefined ? {} : { browser: opts.browser }),
      // #170: the item's session (default: the target's), exactly as `journey run --storage-state` (#118), and its fixtures.
      ...(journeySession === undefined ? {} : { storageState: journeySession }),
      ...(item.t.fixturesFile === undefined ? {} : { fixtures: (site: string) => fixturesFor(targetFixtures(item.t, journeySession), site) }),
      ...(environment === undefined ? {} : { environment }),
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
        ...(x.actionDeltas === true ? { actionDeltas: true } : {}),
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
        ...(x.actionDeltas === true ? { actionDeltas: true } : {}),
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
        ...(x.actionDeltas === true ? { actionDeltas: true } : {}),
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
      ...(x.actionDeltas === true ? { actionDeltas: true } : {}),
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

export function caseDetail(defects: readonly ConsolidatedDefect[]): string {
  return defects.map((d) => `${d.key} ${d.title}${d.reproduce === undefined ? "" : `\n  reproduce: ${d.reproduce}`}`).join("\n");
}
