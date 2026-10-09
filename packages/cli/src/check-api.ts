import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { aggregateOf, formatUsageLine, type UsageCounts } from "@jevitate/ai-core";
import { consolidate, diffRuns, findingKey, renderJUnit, renderReportMarkdown, renderSarif, type ConsolidatedDefect, type DiffEntry, type FindingIdentity, type FindingsDiff, type GateCase, type RunRecord } from "@jevitate/findings";
import { approvalsReport } from "./approval-provenance.js";
import { loadCatalog } from "./catalog-api.js";
import { runAdversarialCliMission, runCoverageMission, runExploration, runFeatureCliMission } from "./explore-api.js";
import { runJourneyProgrammatically } from "./journey-api.js";
import { runUsabilityMission } from "./ux-api.js";
import { runVerifyFix } from "./verify-fix-api.js";
import { currentEngineInfo } from "./engine.js";
import { loadRunFile, resolveBaseline, scanRuns, summarizeRun } from "./report-api.js";
import { CheckAiSetupError, type CheckFinding, type CheckGateways, type CheckItemReport, type CheckResult, type CheckRunners, type RunCheckOptions } from "./check-types.js";
import { BudgetMeter } from "./check-budget.js";
import { type Planned, type PreparedTarget, errorMessage, plan, prepareSelfHeal, prepareTarget } from "./check-plan.js";
import { makeEvidenceSelfHealer } from "./self-heal-adapter.js";
import type { SelfHealer } from "@jevitate/runtime";
import { type ExecContext, type Executed, caseDetail, execute } from "./check-execute.js";
import { clock } from "@jevitate/domain";
export { affectedBy } from "./check-plan.js";
export { BudgetMeter } from "./check-budget.js";
export { type BudgetReport, CheckAiSetupError, CheckArgsError, type CheckFinding, type CheckGateways, type CheckItemReport, CheckPreflightError, type CheckResult, type CheckRunners, type ItemKind, type RunCheckOptions } from "./check-types.js";

const REAL_RUNNERS: CheckRunners = {
  journey: runJourneyProgrammatically,
  goal: runExploration,
  coverage: runCoverageMission,
  adversarial: runAdversarialCliMission,
  feature: runFeatureCliMission,
  usability: runUsabilityMission,
  verifyFix: runVerifyFix,
};

/** #437: the `--require-approvals` violations as hard `approval` defects (one per item and problem). */
async function approvalDefects(opts: RunCheckOptions, req: NonNullable<RunCheckOptions["requireApprovals"]>): Promise<{ defects: ConsolidatedDefect[] }> {
  const dirs = [...new Set([opts.journeysDir, ...opts.suite.targets.flatMap((t) => (t.journeysDir === undefined ? [] : [t.journeysDir]))].map((d) => resolve(d)))];
  const catalogs = [];
  for (const d of dirs) catalogs.push(await loadCatalog(req.catalogDir, d));
  const report = approvalsReport(catalogs, req.allowedChannels);
  const defects = (report.requirement?.violations ?? []).map((v): ConsolidatedDefect => {
    const identity: FindingIdentity = { category: "approval", signal: `approval-${v.problem}`, control: `${v.kind} ${v.id}` };
    const key = findingKey(identity);
    return { key, keys: [key], identity, category: "approval", severity: "hard", title: v.message, fingerprints: [], modes: [], occurrences: 1, runCount: 0, evidence: [], intermittent: false };
  });
  return { defects };
}

export async function runCheck(opts: RunCheckOptions): Promise<CheckResult> {
  const nowIso = opts.nowIso ?? (() => clock.nowIso());
  const startedAt = nowIso();
  const engine = currentEngineInfo();
  const outDir = resolve(opts.outDir);
  const resultsDir = join(outDir, "results");
  const runners: CheckRunners = { ...REAL_RUNNERS, ...opts.runners };

  // Preflight — everything validated before the first browser opens.
  const prepared: PreparedTarget[] = [];
  for (const t of opts.suite.targets) prepared.push(await prepareTarget(t, opts));
  const items = plan(prepared, opts.changedRoutes, opts);
  // #453: refuse a bad self-heal request and read the change scope ONCE, before the first browser opens.
  const heal = await prepareSelfHeal(opts);
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
  let healer: Promise<SelfHealer> | undefined;
  const ctx: ExecContext = {
    opts,
    runners,
    resultsDir,
    gateways,
    engine,
    seq: () => String(++n),
    ...(heal === undefined ? {} : { heal, healer: () => (healer ??= gateways().then((g) => makeEvidenceSelfHealer(g.gen, { usage: g.usage }))) }),
  };
  const now = opts.now ?? clock.now;
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
  // #437 --require-approvals: each violation is a hard `approval` finding on the `approvals` item.
  const approvals = opts.requireApprovals === undefined ? undefined : await approvalDefects(opts, opts.requireApprovals);
  const defects = [...consolidate(runs), ...(approvals?.defects ?? [])];
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
    // #453: a proposed Journey revision (`pending`) is never a defect, whatever `gateAdvisory` says: it makes the check exit 5.
    if (d.severity === "pending") return false;
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
    // #453: a self-healed Journey that only proposed a revision is pending a person (never a pass).
    const pending = ex.status === "ran" && ex.outcome === "healed-pending-review" && own.length === 0;
    const verdict = ex.status === "error" ? "error" : own.length > 0 ? "failed" : pending ? "pending-review" : "passed";
    return {
      ...base,
      ...(pending ? { proposal: { journeyId: item.name, ...(ex.proposal ?? {}) } } : {}),
      ...(ex.healAttempts === undefined ? {} : { healAttempts: ex.healAttempts }),
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

  if (approvals !== undefined) {
    const own = gating.filter((d) => approvals.defects.includes(d)).map((d) => d.key);
    itemReports.push({ target: "approvals", kind: "approvals", name: "require-approvals", status: "ran", actions: 0, durationMs: 0, verdict: own.length > 0 ? "failed" : "passed", gating: own });
  }
  const errors = itemReports.filter((i) => i.verdict === "error").length;
  const pendingItems = itemReports.filter((i) => i.verdict === "pending-review");
  const proposals = pendingItems.flatMap((i) => (i.proposal === undefined ? [] : [i.proposal]));
  const gatingFindings = gating.length;
  // Precedence 1 > 2 > 5 > 0: a defect or exhausted heal, then an item error / budget overrun, then a proposal awaiting review.
  const exitCode: 0 | 1 | 2 | 5 = gatingFindings > 0 ? 1 : errors > 0 || exceeded !== undefined ? 2 : pendingItems.length > 0 ? 5 : 0;
  const junitPath = resolve(opts.junitPath ?? join(outDir, "junit.xml"));
  const sarifPath = resolve(opts.sarifPath ?? join(outDir, "jevitate.sarif"));
  const jsonPath = resolve(opts.jsonPath ?? join(outDir, "check.json"));
  const reportPath = join(outDir, "report.md");

  const cases: GateCase[] = itemReports.map((i) => {
    const own = gating.filter((d) => i.gating.includes(d.key));
    const first = own[0];
    // #250: each gating finding's repro clip and screenshots, attached to the case CI shows.
    const attachments = [
      ...new Set(own.flatMap((d) => d.evidence.flatMap((e) => [e.video, e.screenshot]).filter((f): f is string => f !== undefined && /\.(webm|png)$/i.test(f)))),
    ];
    return {
      suite: i.target,
      classname: `jevitate.${i.target}.${i.kind}${i.strategy === undefined ? "" : `.${i.strategy}`}`,
      name: i.name,
      timeSec: i.durationMs / 1000,
      status: i.verdict,
      ...(i.resultPath === undefined ? {} : { resultPath: i.resultPath }),
      ...(attachments.length === 0 ? {} : { attachments }),
      ...(i.verdict === "pending-review"
        ? {
            type: "healed-pending-review",
            message: `proposed revision${i.proposal?.proposalId === undefined ? "" : ` ${i.proposal.proposalId}`} awaiting review`,
            ...(i.proposal?.path === undefined ? {} : { detail: i.proposal.path }),
          }
        : {}),
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
    verdict: exitCode === 0 ? "pass" : exitCode === 5 ? "pending-review" : "fail",
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
      gatingFindings,
      pendingReview: pendingItems.length,
    },
    proposals,
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
      (proposals.length === 0
        ? ""
        : `\n## Proposed Journey revisions\n\nA self-heal re-ran these failed Journeys against the change and proposed a revision. Nothing passes until a person accepts it.\n\n${proposals
            .map((p) => `- \`${p.journeyId}\`${p.proposalId === undefined ? "" : ` — proposal \`${p.proposalId}\``}${p.path === undefined ? "" : ` (${p.path})`}: \`jevitate journey review ${p.journeyId}\``)
            .join("\n")}\n`) +
      (suiteUsage === undefined ? "" : `\n## Model cost\n\n${formatUsageLine(suiteUsage)}\n`),
    "utf8",
  );
  await writeFile(jsonPath, `${JSON.stringify({ v: 1, ok: true, data: result }, null, 2)}\n`, "utf8");
  return result;
}
