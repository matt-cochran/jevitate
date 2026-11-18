// check-api-report.ts — the report/envelope assembly helpers extracted from `assembleCheckReport`
// in check-api-phases.ts (#d03b): per-item outcomes, targets/done-checks, locator health, slowness,
// the exit-code summary, JUnit/SARIF cases, findings, the CheckResult and its written artifacts.
// The orchestrator (assembleCheckReport) owns the order; every helper here is single-purpose.
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { aggregateOf, formatUsageLine, type UsageCounts } from "@jevitate/ai-core";
import type { DoneCheckPolicy, PhaseTimings } from "@jevitate/domain";
import { renderJUnit, renderReportMarkdown, renderSarif, type ConsolidatedDefect, type DiffEntry, type FindingsDiff, type GateCase, type RunRecord } from "@jevitate/findings";
import { loadCatalog } from "./catalog-api.js";
import { findJob, type Catalog } from "./catalog.js";
import { caseDetail, type Executed } from "./check-execute.js";
import type { EvidenceDecision } from "./check-evidence.js";
import type { Planned } from "./check-plan.js";
import type { CheckFinding, CheckItemReport, CheckResult, LocatorHealthSummary, RunCheckOptions } from "./check-types.js";
import { reportSlowness, type SlownessReport } from "./cold-start-report.js";
import type { EngineInfo } from "./engine.js";
import { combineHealth, compareLocatorHealth, trendLine, type LocatorHealthDetail, type LocatorHealthTrend, type LocatorSuggestion } from "./locator-health.js";
import { evaluateOutcomeTargets } from "./outcome-targets.js";
import { findProjectDir } from "./project-dir.js";
import { summarizeRun } from "./report-api.js";

/** One executed item: the plan, its run (absent on a skip) and how long it took. */
export interface ExecutedItem {
  readonly item: Planned;
  readonly ex: Executed | undefined;
  readonly durationMs: number;
  /** #852: where the item's wall time went, by phase (absent for an item that did not run). */
  readonly timings?: PhaseTimings;
}

/** The consolidated defect maps and gating set an item report reads. */
export interface ItemReportContext {
  readonly runOf: ReadonlyMap<string, RunRecord>;
  readonly brittleOf: ReadonlyMap<number, ConsolidatedDefect>;
  readonly doneCheckOf: ReadonlyMap<number, ConsolidatedDefect>;
  readonly gating: readonly ConsolidatedDefect[];
}

/** The proposal a `pending-review` Journey item produced. */
export type ReportProposal = NonNullable<CheckItemReport["proposal"]>;

/**
 * #643: for each Journey item with a baseline (a clean replay) whose catalog job declares desired
 * outcomes, the outcome-target results (`evaluateOutcomeTargets`). Catalogs are read once per
 * Journeys dir; a catalog that cannot be read adds nothing (the targets are advisory).
 */
export async function addOutcomeTargets(items: CheckItemReport[], executed: ReadonlyArray<{ readonly item: Planned }>, opts: RunCheckOptions): Promise<void> {
  const catalogDir = opts.projectDir === undefined ? findProjectDir() : opts.projectDir;
  if (catalogDir === null) return;
  const catalogs = new Map<string, Promise<Catalog | null>>();
  const catalogFor = (journeysDir: string): Promise<Catalog | null> => {
    const dir = resolve(journeysDir);
    let c = catalogs.get(dir);
    if (c === undefined) {
      c = loadCatalog(catalogDir, dir).catch(() => null);
      catalogs.set(dir, c);
    }
    return c;
  };
  for (const [idx, { item }] of executed.entries()) {
    const report = items[idx];
    if (report === undefined || item.kind !== "journey" || report.baseline === undefined) continue;
    const catalog = await catalogFor(item.t.target.journeysDir ?? opts.journeysDir);
    const jobId = catalog?.journeys.find((j) => j.id === item.name)?.job;
    const outcomes = catalog === null || jobId === undefined ? undefined : findJob(catalog, jobId)?.job.desiredOutcomes;
    if (outcomes === undefined || outcomes.length === 0) continue;
    items[idx] = { ...report, outcomeTargets: evaluateOutcomeTargets(outcomes, report.baseline) };
  }
}

/** One executed item's report: its status, gating findings, verdict and every optional detail. */
export function buildItemReport(entry: ExecutedItem, idx: number, ctx: ItemReportContext): CheckItemReport {
  const { item, ex, durationMs, timings } = entry;
  const base = {
    target: item.t.target.name,
    kind: item.kind,
    name: item.name,
    ...(item.strategy === undefined ? {} : { strategy: item.strategy }),
    durationMs,
    ...(timings === undefined ? {} : { timings }),
  };
  if (ex === undefined) return { ...base, status: "skipped", actions: 0, verdict: "skipped", gating: [] };
  const run = ex.resultPath === undefined ? undefined : ctx.runOf.get(ex.resultPath);
  const brittle = ctx.brittleOf.get(idx);
  const doneCheck = ctx.doneCheckOf.get(idx);
  const own = [
    ...(doneCheck !== undefined && ctx.gating.includes(doneCheck) ? [doneCheck] : []),
    ...(run === undefined ? [] : ctx.gating.filter((d) => d.modes.some((m) => m.runs.some((r) => r.path === run.path)))),
    ...(brittle !== undefined && ctx.gating.includes(brittle) ? [brittle] : []),
  ];
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
    ...(ex.journeyHash === undefined ? {} : { journeyHash: ex.journeyHash }),
    // #469: a baseline only from a clean run — a completed replay with no gating finding.
    ...(ex.baseline === undefined || verdict !== "passed" ? {} : { baseline: ex.baseline }),
    ...(ex.locatorHealth === undefined ? {} : { locatorHealth: ex.locatorHealth }),
    ...(ex.job === undefined ? {} : { job: ex.job }),
  };
}

/** Every executed item's report, in execution order. */
export function buildItemReports(executed: readonly ExecutedItem[], ctx: ItemReportContext): CheckItemReport[] {
  return executed.map((entry, idx) => buildItemReport(entry, idx, ctx));
}

/** #470: the locator health a baseline run's result.json recorded, per Journey (the latest run of each wins). */
function baselineLocatorHealths(runs: readonly RunRecord[]): Map<string, Parameters<typeof compareLocatorHealth>[1]> {
  const out = new Map<string, Parameters<typeof compareLocatorHealth>[1]>();
  for (const run of runs) {
    if (run.mode !== "journey") continue;
    try {
      const json = JSON.parse(readFileSync(run.path, "utf8")) as { result?: { journeyId?: unknown; locatorHealth?: { brittle?: unknown; steps?: unknown } } };
      const h = json.result?.locatorHealth;
      if (typeof json.result?.journeyId === "string" && typeof h?.brittle === "number" && Array.isArray(h.steps)) out.set(json.result.journeyId, h as Parameters<typeof compareLocatorHealth>[1]);
    } catch {
      // An unreadable baseline run has no locator health to compare against.
    }
  }
  return out;
}

/** #470: one trend over several Journeys (the counts summed). */
function sumTrends(trends: readonly LocatorHealthTrend[]): LocatorHealthTrend {
  const sum = (f: (t: LocatorHealthTrend) => number): number => trends.reduce((n, t) => n + f(t), 0);
  return {
    improved: sum((t) => t.improved),
    regressed: sum((t) => t.regressed),
    unchanged: sum((t) => t.unchanged),
    added: sum((t) => t.added),
    removed: sum((t) => t.removed),
    brittleDelta: sum((t) => t.brittleDelta),
    changes: trends.flatMap((t) => t.changes),
  };
}

/**
 * #470: locator health over the Journey items (advisory unless the gate is set) and its trend against
 * `--baseline`. Returns the summary and the combined health (its suggestions feed the SARIF warnings).
 */
export function buildLocatorHealth(
  executed: readonly ExecutedItem[],
  opts: RunCheckOptions,
  baselineRuns: readonly RunRecord[] | undefined,
  testIdAttributes: readonly string[] | undefined,
  brittleCount: number,
): { locatorHealth: LocatorHealthSummary | undefined; combined: ReturnType<typeof combineHealth> } {
  const details: Array<{ name: string; detail: LocatorHealthDetail }> = executed.flatMap(({ item, ex }) =>
    item.kind === "journey" && ex?.locatorDetail !== undefined ? [{ name: item.name, detail: ex.locatorDetail }] : [],
  );
  const combined = combineHealth(details.map((d) => d.detail));
  let locatorTrend: LocatorHealthSummary["trend"];
  if (baselineRuns !== undefined && details.length > 0) {
    const before = baselineLocatorHealths(baselineRuns);
    const trends = executed.flatMap(({ item, ex }) => {
      const b = item.kind === "journey" && ex?.locatorHealth !== undefined ? before.get(item.name) : undefined;
      return b === undefined || ex?.locatorHealth === undefined ? [] : [compareLocatorHealth(ex.locatorHealth, b)];
    });
    if (trends.length > 0) {
      const t = sumTrends(trends);
      locatorTrend = { improved: t.improved, regressed: t.regressed, unchanged: t.unchanged, added: t.added, removed: t.removed, brittleDelta: t.brittleDelta, line: trendLine(t) };
    }
  }
  const locatorHealth: LocatorHealthSummary | undefined =
    details.length === 0 && opts.maxBrittleSteps === undefined
      ? undefined
      : {
          journeys: details.length,
          stable: combined.stable,
          brittle: combined.brittle,
          ...(testIdAttributes === undefined ? {} : { testIdAttributes }),
          ...(opts.maxBrittleSteps === undefined ? {} : { maxBrittleSteps: opts.maxBrittleSteps, exceeded: brittleCount > 0 }),
          ...(details.length === 0 ? {} : { line: combined.line }),
          ...(locatorTrend === undefined ? {} : { trend: locatorTrend }),
        };
  return { locatorHealth, combined };
}

/** #486: advisory slowness across the Journey items (a cold start = slow first replay only). */
export function buildSlowness(executed: readonly ExecutedItem[]): SlownessReport | undefined {
  const slowReport = reportSlowness(
    executed.flatMap(({ item, ex }) => (item.kind === "journey" && item.journey !== undefined && ex?.slowSteps !== undefined ? [{ journey: item.journey.id, slowSteps: ex.slowSteps }] : [])),
  );
  return slowReport.coldStarts.length + slowReport.slowSteps.length === 0 ? undefined : slowReport;
}

/** #437: the `approvals` item report, pushed only when `--require-approvals` produced defects. */
export function approvalsItemReport(approvals: { readonly defects: readonly ConsolidatedDefect[] } | undefined, gating: readonly ConsolidatedDefect[]): CheckItemReport | undefined {
  if (approvals === undefined) return undefined;
  const own = gating.filter((d) => approvals.defects.includes(d)).map((d) => d.key);
  return { target: "approvals", kind: "approvals", name: "require-approvals", status: "ran", actions: 0, durationMs: 0, verdict: own.length > 0 ? "failed" : "passed", gating: own };
}

/** The counts and exit code every item report folds into (precedence 1 > 2 > 5 > 0). */
export interface ReportOutcome {
  readonly errors: number;
  readonly pendingItems: CheckItemReport[];
  readonly proposals: ReportProposal[];
  readonly gatingFindings: number;
  readonly unverified: number;
  readonly exitCode: 0 | 1 | 2 | 5;
}

/**
 * The suite outcome: item error count, pending proposals, gating findings, the unverified-job count
 * and the exit code (a defect or exhausted heal, then an error/budget/unverified job, then a proposal).
 */
export function summarizeReport(itemReports: readonly CheckItemReport[], gating: readonly ConsolidatedDefect[], exceeded: string | undefined, unverifiedItems: ReadonlySet<number>): ReportOutcome {
  const errors = itemReports.filter((i) => i.verdict === "error").length;
  const pendingItems = itemReports.filter((i) => i.verdict === "pending-review");
  const proposals = pendingItems.flatMap((i) => (i.proposal === undefined ? [] : [i.proposal]));
  const gatingFindings = gating.length;
  // H5: Journey items that passed with an unverified job under `require` (a passing item, but the suite proved no job).
  const unverified = [...unverifiedItems].filter((idx) => itemReports[idx]?.verdict === "passed").length;
  // Precedence 1 > 2 > 5 > 0: a defect or exhausted heal (or a job not achieved), then an item error / budget overrun /
  // an unverified job under `require`, then a proposal awaiting review.
  const exitCode: 0 | 1 | 2 | 5 = gatingFindings > 0 ? 1 : errors > 0 || exceeded !== undefined || unverified > 0 ? 2 : pendingItems.length > 0 ? 5 : 0;
  return { errors, pendingItems, proposals, gatingFindings, unverified, exitCode };
}

/** The report, options, run and evidence inputs a JUnit/SARIF case reads. */
export interface GateCaseContext {
  readonly opts: RunCheckOptions;
  readonly gating: readonly ConsolidatedDefect[];
  readonly executed: readonly ExecutedItem[];
  readonly reuse: boolean;
  readonly evidence: EvidenceDecision | undefined;
  readonly evidenceKeyValue: string | undefined;
}

/** Without the gate, each Journey item's fixes are JUnit/SARIF warnings (never failures). */
export function locatorWarningsOf(i: CheckItemReport, idx: number, opts: RunCheckOptions, executed: readonly ExecutedItem[]): string[] {
  if (opts.maxBrittleSteps !== undefined || i.kind !== "journey") return [];
  const ex = executed[idx]?.ex;
  return (ex?.locatorDetail?.suggestions ?? []).map((s) => s.fix);
}

/** One JUnit case for an item report: its gating findings, attachments, type/message and properties. */
export function buildGateCase(i: CheckItemReport, idx: number, ctx: GateCaseContext): GateCase {
  const own = ctx.gating.filter((d) => i.gating.includes(d.key));
  const first = own[0];
  // #250: each gating finding's repro clip and screenshots, attached to the case CI shows.
  const attachments = [
    ...new Set(own.flatMap((d) => d.evidence.flatMap((e) => [e.video, e.screenshot]).filter((f): f is string => f !== undefined && /\.(webm|png)$/i.test(f)))),
  ];
  const warnings = locatorWarningsOf(i, idx, ctx.opts, ctx.executed);
  return {
    suite: i.target,
    classname: `jevitate.${i.target}.${i.kind}${i.strategy === undefined ? "" : `.${i.strategy}`}`,
    name: i.name,
    timeSec: i.durationMs / 1000,
    status: i.verdict,
    ...(i.resultPath === undefined ? {} : { resultPath: i.resultPath }),
    ...(attachments.length === 0 ? {} : { attachments }),
    ...(warnings.length === 0 ? {} : { warnings }),
    ...(i.verdict === "pending-review"
      ? {
          type: "healed-pending-review",
          message: `proposed revision${i.proposal?.proposalId === undefined ? "" : ` ${i.proposal.proposalId}`} awaiting review`,
          ...(i.proposal?.path === undefined ? {} : { detail: i.proposal.path }),
        }
      : {}),
    ...(i.verdict === "failed" && first !== undefined
      ? { type: first.identity.signal === "done-check-failed" ? "done-check-failed" : first.category, message: `${own.length} gating finding(s): ${first.title}`, detail: caseDetail(own) }
      : {}),
    ...(i.verdict === "error" && i.error !== undefined ? { type: i.error.type, message: i.error.message } : {}),
    ...(i.verdict === "skipped" ? { message: ctx.reuse ? "reused matching evidence" : "not affected by --changed-routes" } : {}),
    properties: {
      changedRoutes: JSON.stringify(ctx.opts.changedRoutes ?? []),
      // H5: a Journey item's job verdict, as `jevitate.job.attainment` / `jevitate.job.basis`.
      ...(i.job === undefined ? {} : { "jevitate.job.attainment": i.job.attainment, "jevitate.job.basis": i.job.basis }),
      ...(ctx.evidenceKeyValue === undefined ? {} : { evidenceKey: ctx.evidenceKeyValue, evidenceDecision: ctx.evidence?.decision ?? "run" }),
    },
  };
}

/** Every item's JUnit case, plus the budget-exceeded case when one was not already produced. */
export function buildGateCases(itemReports: readonly CheckItemReport[], ctx: GateCaseContext, exceeded: string | undefined): GateCase[] {
  const cases = itemReports.map((i, idx) => buildGateCase(i, idx, ctx));
  if (exceeded !== undefined && !cases.some((c) => c.type === "budget-exceeded")) {
    cases.push({ suite: "budget", classname: "jevitate.budget", name: "total budget", timeSec: 0, status: "error", type: "budget-exceeded", message: exceeded });
  }
  return cases;
}

/** Every consolidated defect as a `CheckFinding`, annotated with its diff status and gating flag. */
export function buildCheckFindings(defects: readonly ConsolidatedDefect[], gating: readonly ConsolidatedDefect[], statusOf: (d: ConsolidatedDefect) => DiffEntry["status"] | undefined): CheckFinding[] {
  return defects.map((d) => {
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
}

/** One Journey item's job verdict, for the SARIF `jobs` property and the report's job table. */
export interface JobRow {
  readonly target: string;
  readonly name: string;
  readonly attainment: string;
  readonly basis: string;
}

/** H5: every Journey item's job verdict and the policy it folded with. */
export function buildJobRows(itemReports: readonly CheckItemReport[]): JobRow[] {
  return itemReports.flatMap((i) => (i.job === undefined ? [] : [{ target: i.target, name: i.name, attainment: i.job.attainment, basis: i.job.basis }]));
}

/** The check's resolved output paths. */
export interface CheckReportPaths {
  readonly junitPath: string;
  readonly sarifPath: string;
  readonly jsonPath: string;
  readonly reportPath: string;
}

/** Every value `buildCheckResult` reads, passed explicitly (the orchestrator owns the derivations). */
export interface CheckResultInput {
  readonly opts: RunCheckOptions;
  readonly engine: EngineInfo;
  readonly startedAt: string;
  readonly exitCode: 0 | 1 | 2 | 5;
  readonly evidence: EvidenceDecision | undefined;
  readonly evidenceKeyValue: string | undefined;
  readonly budget: CheckResult["budget"];
  readonly suiteUsage: CheckResult["usage"];
  readonly itemReports: readonly CheckItemReport[];
  readonly findings: readonly CheckFinding[];
  readonly summary: ReportOutcome;
  readonly doneCheckPolicy: DoneCheckPolicy;
  readonly locatorHealth: LocatorHealthSummary | undefined;
  readonly slowness: SlownessReport | undefined;
  readonly proposals: readonly ReportProposal[];
  readonly runs: readonly RunRecord[];
  readonly diff: FindingsDiff | undefined;
  readonly baselineRuns: readonly RunRecord[] | undefined;
  readonly paths: CheckReportPaths;
}

/** The `CheckResult` envelope `runCheck` returns, in the original key order. */
export function buildCheckResult(input: CheckResultInput): CheckResult {
  const { opts, engine, startedAt, exitCode, evidence, evidenceKeyValue, budget, suiteUsage, itemReports, findings, summary, doneCheckPolicy, locatorHealth, slowness, proposals, runs, diff, baselineRuns, paths } = input;
  const errors = summary.errors;
  const gatingFindings = summary.gatingFindings;
  const unverified = summary.unverified;
  const pendingItems = summary.pendingItems;
  return {
    kind: "jevitate-check",
    suite: opts.suite.name,
    suitePath: opts.suite.path,
    verdict: exitCode === 0 ? "pass" : exitCode === 5 ? "pending-review" : "fail",
    exitCode,
    engine,
    ...(opts.targetBuild === undefined ? {} : { targetBuild: opts.targetBuild }),
    ...(opts.appVersion === undefined ? {} : { appVersion: opts.appVersion }),
    changedRoutes: opts.changedRoutes ?? [],
    ...(evidence === undefined || evidenceKeyValue === undefined ? {} : { evidence: { decision: evidence.decision, reasons: evidence.reasons, key: evidenceKeyValue } }),
    startedAt,
    budget,
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
      unverified,
    },
    doneCheckPolicy,
    ...(locatorHealth === undefined ? {} : { locatorHealth }),
    ...(slowness === undefined ? {} : { slowness }),
    proposals,
    ...(diff === undefined || baselineRuns === undefined ? {} : { diff: { baseline: baselineRuns.map(summarizeRun), summary: diff.summary } }),
    results: runs.map((r) => r.path),
    junitPath: paths.junitPath,
    sarifPath: paths.sarifPath,
    jsonPath: paths.jsonPath,
    reportPath: paths.reportPath,
  };
}

/** #479: stamps the app's release label into the SARIF run properties, next to `targetBuild`. */
function withAppVersion(sarif: ReturnType<typeof renderSarif>, appVersion: string | undefined): ReturnType<typeof renderSarif> {
  if (appVersion === undefined) return sarif;
  const [run, ...rest] = sarif.runs as ReadonlyArray<{ readonly properties?: Readonly<Record<string, unknown>> }>;
  if (run === undefined) return sarif;
  return { ...sarif, runs: [{ ...run, properties: { ...(run.properties ?? {}), appVersion } }, ...rest] };
}

const LOCATOR_WARNING_RULE = "jevitate/locator-health/brittle-locator";

/**
 * #470: advisory locator fixes as SARIF WARNINGS (never errors, never gating) — one result per element
 * to fix, located at the suite file with the route as its logical location.
 */
function withLocatorWarnings(sarif: ReturnType<typeof renderSarif>, suggestions: readonly LocatorSuggestion[], suiteUri: string): ReturnType<typeof renderSarif> {
  if (suggestions.length === 0) return sarif;
  const [run, ...rest] = sarif.runs as ReadonlyArray<{ tool: { driver: { rules: unknown[] } }; results: unknown[] }>;
  if (run === undefined) return sarif;
  const rule = { id: LOCATOR_WARNING_RULE, name: LOCATOR_WARNING_RULE.replace(/[^A-Za-z0-9]+/g, "_"), shortDescription: { text: "locator-health: a step's target misses the project's test-id convention" }, defaultConfiguration: { level: "warning" } };
  const results = suggestions.map((s) => {
    const journeys = [...new Set(s.occurrences.flatMap((o) => (o.journeyId === undefined ? [] : [o.journeyId])))];
    return {
      ruleId: LOCATOR_WARNING_RULE,
      level: "warning",
      message: { text: s.fix },
      locations: [
        {
          physicalLocation: { artifactLocation: { uri: suiteUri }, region: { startLine: 1 } },
          ...(s.route === undefined ? {} : { logicalLocations: [{ name: s.route, kind: "module" }] }),
        },
      ],
      partialFingerprints: { jevitateFindingKey: `locator-health:${s.key}` },
      properties: { category: "locator-health", severity: "advisory", gating: false, element: s.element, reasons: s.reasons, journeys, steps: s.occurrences.length },
    };
  });
  return { ...sarif, runs: [{ ...run, tool: { ...run.tool, driver: { ...run.tool.driver, rules: [...run.tool.driver.rules, rule] } }, results: [...run.results, ...results] }, ...rest] };
}

/** The optional report footer: proposed revisions, live job verdicts and the model-cost line. */
export function renderReportTail(proposals: readonly ReportProposal[], jobRows: readonly JobRow[], doneCheckPolicy: DoneCheckPolicy, suiteUsage: CheckResult["usage"]): string {
  return (
    (proposals.length === 0
      ? ""
      : `\n## Proposed Journey revisions\n\nA self-heal re-ran these failed Journeys against the change and proposed a revision. Nothing passes until a person accepts it.\n\n${proposals
          .map((p) => `- \`${p.journeyId}\`${p.proposalId === undefined ? "" : ` — proposal \`${p.proposalId}\``}${p.path === undefined ? "" : ` (${p.path})`}: \`jevitate journey review ${p.journeyId}\``)
          .join("\n")}\n`) +
    (jobRows.length === 0
      ? ""
      : `\n## Job verdicts\n\nEach Journey item's job, read by its done check (doneCheckPolicy \`${doneCheckPolicy}\`): not-achieved fails the item; unverified holds the check at exit 2 under \`require\` (a harness target excepted).\n\n| target | Journey | job | basis |\n| --- | --- | --- | --- |\n${jobRows
          .map((j) => `| ${j.target} | ${j.name} | ${j.attainment} | ${j.basis} |`)
          .join("\n")}\n`) +
    (suiteUsage === undefined ? "" : `\n## Model cost\n\n${formatUsageLine(suiteUsage)}\n`)
  );
}

/** Every value `writeCheckArtifacts` reads. */
export interface WriteArtifactsInput {
  readonly opts: RunCheckOptions;
  readonly engine: EngineInfo;
  readonly startedAt: string;
  readonly runs: readonly RunRecord[];
  readonly defects: readonly ConsolidatedDefect[];
  readonly gating: readonly ConsolidatedDefect[];
  readonly statusOf: (d: ConsolidatedDefect) => DiffEntry["status"] | undefined;
  readonly evidence: EvidenceDecision | undefined;
  readonly evidenceKeyValue: string | undefined;
  readonly jobRows: readonly JobRow[];
  readonly proposals: readonly ReportProposal[];
  readonly suiteUsage: CheckResult["usage"];
  readonly result: CheckResult;
  readonly cases: readonly GateCase[];
  readonly combined: ReturnType<typeof combineHealth>;
  readonly diff: FindingsDiff | undefined;
  readonly doneCheckPolicy: DoneCheckPolicy;
  readonly paths: CheckReportPaths;
}

/** Writes the JUnit, SARIF, Markdown and JSON artifacts, in that order. */
export async function writeCheckArtifacts(input: WriteArtifactsInput): Promise<void> {
  const { opts, engine, startedAt, runs, defects, gating, statusOf, evidence, evidenceKeyValue, jobRows, proposals, suiteUsage, result, cases, combined, diff, doneCheckPolicy, paths } = input;
  await writeFile(paths.junitPath, renderJUnit(`jevitate check: ${opts.suite.name}`, cases, startedAt), "utf8");
  const sarif = withAppVersion(withLocatorWarnings(renderSarif({
    toolVersion: engine.version,
    engineCommit: engine.commit,
    ...(opts.targetBuild === undefined ? {} : { targetBuild: opts.targetBuild }),
    suiteUri: opts.suiteUri ?? opts.suite.path,
    automationId: `jevitate-check/${opts.suite.name}/`,
    findings: defects.map((d) => ({ defect: d, gating: gating.includes(d), ...(statusOf(d) === undefined ? {} : { status: statusOf(d) }) })),
  }), opts.maxBrittleSteps === undefined ? combined.suggestions : [], opts.suiteUri ?? opts.suite.path), opts.appVersion);
  const sarifRun = sarif.runs[0] as { properties?: Record<string, unknown> } | undefined;
  if (sarifRun !== undefined) {
    sarifRun.properties = {
      ...sarifRun.properties,
      changedRoutes: opts.changedRoutes ?? [],
      ...(evidenceKeyValue === undefined ? {} : { evidenceKey: evidenceKeyValue, evidenceDecision: evidence?.decision ?? "run", evidenceReasons: evidence?.reasons ?? [] }),
      // H5: every Journey item's job verdict and the policy it folded with (a not-achieved job is also a result).
      doneCheckPolicy,
      jobs: jobRows,
    };
  }
  await writeFile(paths.sarifPath, `${JSON.stringify(sarif, null, 2)}\n`, "utf8");
  await writeFile(
    paths.reportPath,
    renderReportMarkdown({ title: `jevitate check: ${opts.suite.name} — ${result.verdict}`, runs, defects, ...(diff === undefined ? {} : { diff }) }) + renderReportTail(proposals, jobRows, doneCheckPolicy, suiteUsage),
    "utf8",
  );
  await writeFile(paths.jsonPath, `${JSON.stringify({ v: 1, ok: true, data: result }, null, 2)}\n`, "utf8");
}

/** The check's model usage summed over every item that ran. */
export function buildSuiteUsage(finalUsage: UsageCounts | undefined, ranCount: number): CheckResult["usage"] {
  return finalUsage === undefined ? undefined : aggregateOf(finalUsage, ranCount);
}
