// check-api-phases.ts — `runCheck`'s phases (#d03a, #d03b, #231): input/suite resolution, target
// preparation and planning, the evidence-reuse decision, the pre-execution run state (gateways,
// budget meter, done-check scope, execution context), the execution loop, defect consolidation and
// report/envelope assembly. Extracted move-only from check-api.ts, which orchestrates these.
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type UsageCounts } from "@jevitate/ai-core";
import type { JobVerdict } from "@jevitate/adjudicator";
import { clock, journeyMissionOutcome, PhaseRecorder, withPhaseRecorder, type DoneCheckPolicy, type PhaseTimings, type JourneyRunOutcome, JOURNEY_RUN_OUTCOMES } from "@jevitate/domain";
import { consolidate, diffRuns, findingKey, type ConsolidatedDefect, type DiffEntry, type FindingIdentity, type FindingsDiff, type GateCase, type RunRecord } from "@jevitate/findings";
import type { SelfHealer } from "@jevitate/runtime";
import { approvalsReportVerified } from "./approval-provenance.js";
import { addOutcomeTargets, approvalsItemReport, buildCheckFindings, buildCheckResult, buildGateCases, buildItemReports, buildJobRows, buildLocatorHealth, buildSlowness, buildSuiteUsage, summarizeReport, writeCheckArtifacts } from "./check-api-report.js";
import { BudgetMeter } from "./check-budget.js";
import { evidenceKey, reuseDecision, type EvidenceDecision } from "./check-evidence.js";
import { type ExecContext, type Executed, execute } from "./check-execute.js";
import { errorMessage, plan, prepareSelfHeal, prepareTarget, type Planned, type PreparedTarget } from "./check-plan.js";
import { CheckAiSetupError, CheckArgsError, CheckPreflightError, type CheckFinding, type CheckGateways, type CheckItemReport, type CheckResult, type CheckRunners, type RunCheckOptions } from "./check-types.js";
import { exceedsBrittleSteps } from "./locator-health.js";
import { loadCatalog } from "./catalog-api.js";
import { currentEngineInfo, type EngineInfo } from "./engine.js";
import { runAdversarialCliMission, runCoverageMission, runExploration, runFeatureCliMission } from "./explore-api.js";
import { doneCheckPolicyOf } from "./journey-done-check-hook.js";
import { DONE_CHECK_FAILED_MESSAGE, doneCheckExitInput } from "./journey-done-check.js";
import { runJourneyProgrammatically } from "./journey-api.js";
import { brittleStepGate, testIdAttributesOf, testIdAttributesOrDefault } from "./locator-health-api.js";
import { findProjectDir } from "./project-dir.js";
import { loadRunFile, resolveBaseline, scanRuns } from "./report-api.js";
import { makeEvidenceSelfHealer } from "./self-heal-adapter.js";
import { runUsabilityMission } from "./ux-api.js";
import { runVerifyFix } from "./verify-fix-api.js";

const REAL_RUNNERS: CheckRunners = {
  journey: runJourneyProgrammatically,
  goal: runExploration,
  coverage: runCoverageMission,
  adversarial: runAdversarialCliMission,
  feature: runFeatureCliMission,
  usability: runUsabilityMission,
  verifyFix: runVerifyFix,
};

/** The engine identity, output directories and runners resolved for one check (#d03a). */
export interface CheckInputs {
  readonly startedAt: string;
  readonly engine: EngineInfo;
  readonly outDir: string;
  readonly resultsDir: string;
  readonly runners: CheckRunners;
}

/** Input/suite resolution: the clock, engine identity, output dirs and the real runners. */
export function resolveCheckInputs(opts: RunCheckOptions): CheckInputs {
  const nowIso = opts.nowIso ?? (() => clock.nowIso());
  const startedAt = nowIso();
  const engine = currentEngineInfo();
  const outDir = resolve(opts.outDir);
  const resultsDir = join(outDir, "results");
  const runners: CheckRunners = { ...REAL_RUNNERS, ...opts.runners };
  return { startedAt, engine, outDir, resultsDir, runners };
}

/** Target preparation and planning: every suite target is prepared, then its runnable items planned. */
export async function prepareCheckPlan(opts: RunCheckOptions): Promise<Planned[]> {
  // Preflight — everything validated before the first browser opens.
  const prepared: PreparedTarget[] = [];
  for (const t of opts.suite.targets) prepared.push(await prepareTarget(t, opts));
  const items = plan(prepared, opts.changedRoutes, opts);
  return items;
}

/** The evidence-reuse decision taken before any gateway is selected (#704). */
export interface CheckEvidence {
  readonly evidence: EvidenceDecision | undefined;
  readonly evidenceKeyValue: string | undefined;
  readonly reuse: boolean;
}

/** Decides from immutable, validated proof inputs whether this check reuses matching evidence. */
export function resolveCheckEvidence(opts: RunCheckOptions): CheckEvidence {
  // #704: decide from immutable, validated proof inputs before a gateway is selected or a browser
  // can open. A matching manifest turns every otherwise-runnable item into an explicit skip.
  const evidence = opts.evidence === undefined
    ? undefined
    : opts.evidence.refusalReasons !== undefined && opts.evidence.refusalReasons.length > 0
      ? { decision: "run" as const, reasons: opts.evidence.refusalReasons }
      : reuseDecision(opts.evidence.input, opts.evidence.manifest);
  const evidenceKeyValue = opts.evidence === undefined ? undefined : evidenceKey(opts.evidence.input);
  const reuse = evidence?.decision === "skip";
  return { evidence, evidenceKeyValue, reuse };
}

/**
 * #470: the project's test-id convention for a check's Journey items. With the opt-in gate a malformed
 * project config refuses the check (it would gate on a guessed convention); without it the defaults
 * apply, as a run's result.json does.
 */
function checkTestIdAttributes(opts: RunCheckOptions): readonly string[] {
  const projectDir = opts.projectDir === undefined ? findProjectDir() : opts.projectDir;
  if (opts.maxBrittleSteps === undefined) return testIdAttributesOrDefault(projectDir);
  try {
    return testIdAttributesOf(projectDir);
  } catch (e) {
    throw new CheckPreflightError(`--max-brittle-steps needs the project's testIdAttributes convention: ${errorMessage(e)}`);
  }
}

/** The pre-execution state `runCheck`'s execution loop consumes (#d03a). */
export interface CheckPreparation {
  readonly testIdAttributes: readonly string[] | undefined;
  readonly doneCheckPolicy: DoneCheckPolicy;
  readonly meter: BudgetMeter;
  readonly usage: () => Promise<UsageCounts | undefined>;
  readonly ctx: ExecContext;
  readonly now: () => number;
  readonly exceeded: string | undefined;
  readonly executed: Array<{ item: Planned; ex: Executed | undefined; durationMs: number; timings?: PhaseTimings }>;
}

/**
 * Validation and run-state preparation: the self-heal request, the locator gate and convention, the
 * model gateways, the budget meter and done-check scope, and the execution context the loop uses.
 */
export async function prepareCheckRun(opts: RunCheckOptions, inputs: CheckInputs, items: readonly Planned[], reuse: boolean): Promise<CheckPreparation> {
  const { resultsDir, engine, runners } = inputs;
  // #453: refuse a bad self-heal request and read the change scope ONCE, before the first browser opens.
  const heal = await prepareSelfHeal(opts);
  // #470: the opt-in locator gate and the convention it measures against, before anything runs.
  if (opts.maxBrittleSteps !== undefined) {
    try {
      brittleStepGate(opts.maxBrittleSteps);
    } catch (e) {
      throw new CheckArgsError(errorMessage(e));
    }
  }
  const testIdAttributes = items.some((i) => i.kind === "journey" && i.skipped === undefined) ? checkTestIdAttributes(opts) : undefined;
  let gw: Promise<CheckGateways> | undefined;
  const gateways = (): Promise<CheckGateways> => {
    if (opts.gateways === undefined) return Promise.reject(new CheckAiSetupError("this suite needs a model gateway: pass --real or --fake-ai (or set \"ai\" in the suite)"));
    gw ??= opts.gateways();
    return gw;
  };
  // A missing/unselectable gateway throws here (typed), before any browser opens.
  if (!reuse && items.some((i) => i.needsAi && i.skipped === undefined)) await gateways();
  await mkdir(resultsDir, { recursive: true });

  const meter = new BudgetMeter(opts.suite.budget, { ...(opts.now === undefined ? {} : { now: opts.now }), costKnownZero: opts.aiMode === "fake" });
  const usage = async (): Promise<UsageCounts | undefined> => (gw === undefined ? undefined : (await gw).usage.snapshot());
  let n = 0;
  let healer: Promise<SelfHealer> | undefined;
  // H5 (0.30.0): every Journey item reads its job's done check, folded with the project's doneCheckPolicy.
  const doneCheckDir = opts.projectDir === undefined ? findProjectDir() : opts.projectDir;
  const doneCheckPolicy = opts.doneCheck?.policy ?? doneCheckPolicyOf(doneCheckDir);
  const ctx: ExecContext = {
    opts,
    runners,
    resultsDir,
    gateways,
    engine,
    seq: () => String(++n),
    doneCheck: { catalogDir: doneCheckDir, skip: opts.doneCheck?.skip === true, policy: doneCheckPolicy },
    ...(testIdAttributes === undefined ? {} : { testIdAttributes }),
    ...(heal === undefined ? {} : { heal, healer: () => (healer ??= gateways().then((g) => makeEvidenceSelfHealer(g.gen, { usage: g.usage }))) }),
  };
  const now = opts.now ?? clock.now;
  let exceeded: string | undefined;
  const executed: Array<{ item: Planned; ex: Executed | undefined; durationMs: number; timings?: PhaseTimings }> = [];
  return { testIdAttributes, doneCheckPolicy, meter, usage, ctx, now, exceeded, executed };
}

/** #437: the `--require-approvals` violations as hard `approval` defects (one per item and problem). */
async function approvalDefects(opts: RunCheckOptions, req: NonNullable<RunCheckOptions["requireApprovals"]>): Promise<{ defects: ConsolidatedDefect[] }> {
  const dirs = [...new Set([opts.journeysDir, ...opts.suite.targets.flatMap((t) => (t.journeysDir === undefined ? [] : [t.journeysDir]))].map((d) => resolve(d)))];
  const catalogs = [];
  for (const d of dirs) catalogs.push(await loadCatalog(req.catalogDir, d));
  // #469: a recorded pr-review approval counts only when the forge re-confirms it.
  const report = await approvalsReportVerified(catalogs, req.allowedChannels, { catalogDir: req.catalogDir, ...(opts.approvalVerification ?? {}) });
  const defects = (report.requirement?.violations ?? []).map((v): ConsolidatedDefect => {
    const identity: FindingIdentity = { category: "approval", signal: `approval-${v.problem}`, control: `${v.kind} ${v.id}` };
    const key = findingKey(identity);
    return { key, keys: [key], identity, category: "approval", severity: "hard", title: v.message, fingerprints: [], modes: [], occurrences: 1, runCount: 0, evidence: [], intermittent: false };
  });
  return { defects };
}

/** #470: the gate's finding for one Journey item past `--max-brittle-steps` (hard: it fails the check). */
function brittleDefect(journeyId: string, health: { readonly brittle: number; readonly line?: string }, maxBrittleSteps: number): ConsolidatedDefect {
  const identity: FindingIdentity = { category: "locator-health", signal: "brittle-steps", control: `journey ${journeyId}` };
  const key = findingKey(identity);
  const title = `Journey '${journeyId}': ${health.brittle} brittle locator step(s), more than --max-brittle-steps ${maxBrittleSteps}${health.line === undefined ? "" : ` (${health.line})`}`;
  return { key, keys: [key], identity, category: "locator-health", severity: "hard", title, reproduce: `jevitate locator-health --journey ${journeyId}`, fingerprints: [], modes: [], occurrences: 1, runCount: 0, evidence: [], intermittent: false };
}

/**
 * H5 (0.30.0, owner decision 2): a Journey item whose steps passed while its job's done check read false is a
 * hard finding on that item, `done-check-failed` (exit 1), as `journey run` exits 1 for it.
 */
function doneCheckDefect(journeyId: string): ConsolidatedDefect {
  const identity: FindingIdentity = { category: "journey-assertion", signal: "done-check-failed", control: `journey ${journeyId}` };
  const key = findingKey(identity);
  const title = `Journey '${journeyId}': done-check-failed — ${DONE_CHECK_FAILED_MESSAGE}`;
  return { key, keys: [key], identity, category: "journey-assertion", severity: "hard", title, reproduce: `jevitate journey run ${journeyId}`, fingerprints: [], modes: [], occurrences: 1, runCount: 0, evidence: [], intermittent: false };
}

/** H5: how a Journey item's job folds into the suite: not achieved (a finding), unverified under require (exit 2), or neither. */
function jobFold(outcome: string | undefined, job: JobVerdict | undefined, policy: Parameters<typeof doneCheckExitInput>[1]): "not-achieved" | "unverified" | undefined {
  if (job === undefined || outcome === undefined || !(JOURNEY_RUN_OUTCOMES as readonly string[]).includes(outcome)) return undefined;
  const run = outcome as JourneyRunOutcome;
  const folded = journeyMissionOutcome(run, doneCheckExitInput(job, policy));
  // Never over a run already failing for another reason (journeyMissionOutcome keeps that run's own fold).
  if (job.attainment === "not-achieved" && (run === "ok" || run === "healed-pending-review")) return "not-achieved";
  return run === "ok" && folded === "inconclusive" ? "unverified" : undefined;
}

// ── execution ────────────────────────────────────────────────────────────────

/**
 * The execution loop `runCheck` delegates to (#d03b): every planned item runs under the budget
 * meter, a reuse turns it into an explicit skip, and a budget overrun is recorded on the item.
 */
export async function executeCheckItems(items: readonly Planned[], preparation: CheckPreparation, reuse: boolean): Promise<string | undefined> {
  const { meter, usage, ctx, now, executed } = preparation;
  let exceeded = preparation.exceeded;
  for (const item of items) {
    if (reuse) {
      executed.push({ item: { ...item, skipped: "reused matching evidence" }, ex: undefined, durationMs: 0 });
      continue;
    }
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
    // #852: each item's wall time by phase, reported as `timings` on its check.json item.
    const recorder = new PhaseRecorder();
    try {
      ex = await withPhaseRecorder(recorder, () => execute(item, ctx, meter.remainingActions()));
    } catch (e) {
      ex = { status: "error", actions: 0, error: { type: e instanceof Error ? e.name : "error", message: errorMessage(e) } };
    }
    recorder.end();
    const over = meter.charge(ex.actions, await usage());
    if (over !== undefined) exceeded ??= over;
    executed.push({ item, ex, durationMs: now() - t0, timings: recorder.snapshot() });
  }
  return exceeded;
}

// ── defect consolidation ──────────────────────────────────────────────────────

/** The runs, findings, gating and diff `runCheck` reports (#d03b). */
export interface CheckDefectState {
  readonly runs: RunRecord[];
  readonly runOf: Map<string, RunRecord>;
  readonly approvals: { defects: ConsolidatedDefect[] } | undefined;
  readonly brittleOf: Map<number, ConsolidatedDefect>;
  readonly doneCheckOf: Map<number, ConsolidatedDefect>;
  readonly unverifiedItems: Set<number>;
  readonly defects: ConsolidatedDefect[];
  readonly diff: FindingsDiff | undefined;
  readonly baselineRuns: RunRecord[] | undefined;
  readonly gating: ConsolidatedDefect[];
  readonly statusOf: (d: ConsolidatedDefect) => DiffEntry["status"] | undefined;
}

/** The defect consolidation `runCheck` delegates to (#d03b): runs, findings, gating and diff. */
export async function consolidateCheckDefects(opts: RunCheckOptions, inputs: CheckInputs, preparation: CheckPreparation): Promise<CheckDefectState> {
  const { resultsDir } = inputs;
  const { executed, doneCheckPolicy } = preparation;
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
  // #470 --max-brittle-steps: a Journey item past the threshold is a hard `locator-health` finding on that item.
  const brittleOf = new Map<number, ConsolidatedDefect>();
  if (opts.maxBrittleSteps !== undefined) {
    executed.forEach(({ item, ex }, idx) => {
      const health = ex?.locatorHealth;
      if (item.kind === "journey" && health !== undefined && exceedsBrittleSteps(health, opts.maxBrittleSteps)) {
        brittleOf.set(idx, brittleDefect(item.name, { brittle: health.brittle, ...(ex?.locatorDetail === undefined ? {} : { line: ex.locatorDetail.line }) }, opts.maxBrittleSteps!));
      }
    });
  }
  // H5: a Journey item whose job was not achieved is a hard `done-check-failed` finding on that item.
  const doneCheckOf = new Map<number, ConsolidatedDefect>();
  const unverifiedItems = new Set<number>();
  executed.forEach(({ item, ex }, idx) => {
    if (item.kind !== "journey" || ex?.status !== "ran") return;
    const fold = jobFold(ex.outcome, ex.job, doneCheckPolicy);
    if (fold === "not-achieved") doneCheckOf.set(idx, doneCheckDefect(item.name));
    else if (fold === "unverified") unverifiedItems.add(idx);
  });
  const defects = [...consolidate(runs), ...(approvals?.defects ?? []), ...brittleOf.values(), ...doneCheckOf.values()];
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
  return { runs, runOf, approvals, brittleOf, doneCheckOf, unverifiedItems, defects, diff, baselineRuns, gating, statusOf };
}

// ── report/envelope assembly ──────────────────────────────────────────────────

/** The report and envelope assembly `runCheck` delegates to (#d03b): item reports, artifacts and the CheckResult. */
export async function assembleCheckReport(
  opts: RunCheckOptions,
  inputs: CheckInputs,
  evidenceState: CheckEvidence,
  preparation: CheckPreparation,
  exceeded: string | undefined,
  state: CheckDefectState,
): Promise<CheckResult> {
  const { engine, outDir, startedAt } = inputs;
  const { testIdAttributes, doneCheckPolicy, meter, usage, executed } = preparation;
  const { evidence, evidenceKeyValue, reuse } = evidenceState;
  const { runs, runOf, approvals, brittleOf, doneCheckOf, unverifiedItems, defects, diff, baselineRuns, gating, statusOf } = state;

  const itemReports: CheckItemReport[] = buildItemReports(executed, { runOf, brittleOf, doneCheckOf, gating });
  // #643: each passed Journey item's job outcome targets against its machine baseline (advisory, never gating).
  await addOutcomeTargets(itemReports, executed, opts);
  // #470: locator health over the Journey items (advisory unless the gate is set), and its trend against --baseline.
  const { locatorHealth, combined } = buildLocatorHealth(executed, opts, baselineRuns, testIdAttributes, brittleOf.size);
  // #486: advisory slowness across the Journey items (a cold start = slow first replay only).
  const slowness = buildSlowness(executed);
  const approvalsItem = approvalsItemReport(approvals, gating);
  if (approvalsItem !== undefined) itemReports.push(approvalsItem);
  // Precedence 1 > 2 > 5 > 0 over the item verdicts, findings, budget and unverified jobs.
  const outcome = summarizeReport(itemReports, gating, exceeded, unverifiedItems);
  const junitPath = resolve(opts.junitPath ?? join(outDir, "junit.xml"));
  const sarifPath = resolve(opts.sarifPath ?? join(outDir, "jevitate.sarif"));
  const jsonPath = resolve(opts.jsonPath ?? join(outDir, "check.json"));
  const reportPath = join(outDir, "report.md");
  const paths = { junitPath, sarifPath, jsonPath, reportPath };

  const cases: GateCase[] = buildGateCases(itemReports, { opts, gating, executed, reuse, evidence, evidenceKeyValue }, exceeded);
  const findings: CheckFinding[] = buildCheckFindings(defects, gating, statusOf);
  const finalUsage = await usage();
  const suiteUsage = buildSuiteUsage(finalUsage, executed.filter((e) => e.ex !== undefined).length);
  const result = buildCheckResult({
    opts,
    engine,
    startedAt,
    exitCode: outcome.exitCode,
    evidence,
    evidenceKeyValue,
    budget: meter.report(finalUsage, exceeded),
    suiteUsage,
    itemReports,
    findings,
    summary: outcome,
    doneCheckPolicy,
    locatorHealth,
    slowness,
    proposals: outcome.proposals,
    runs,
    diff,
    baselineRuns,
    paths,
  });
  const jobRows = buildJobRows(itemReports);
  await writeCheckArtifacts({ opts, engine, startedAt, runs, defects, gating, statusOf, evidence, evidenceKeyValue, jobRows, proposals: outcome.proposals, suiteUsage, result, cases, combined, diff, doneCheckPolicy, paths });
  return result;
}
