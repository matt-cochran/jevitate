// check-api-phases.ts — `runCheck`'s preparation phases (#d03a, #231): input/suite resolution,
// target preparation and planning, the evidence-reuse decision, and the pre-execution run state
// (gateways, budget meter, done-check scope, execution context). Extracted move-only from
// check-api.ts, which calls these before its execution loop.
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type UsageCounts } from "@jevitate/ai-core";
import { clock, type DoneCheckPolicy } from "@jevitate/domain";
import type { SelfHealer } from "@jevitate/runtime";
import { BudgetMeter } from "./check-budget.js";
import { evidenceKey, reuseDecision, type EvidenceDecision } from "./check-evidence.js";
import { type ExecContext, type Executed } from "./check-execute.js";
import { errorMessage, plan, prepareSelfHeal, prepareTarget, type Planned, type PreparedTarget } from "./check-plan.js";
import { CheckAiSetupError, CheckArgsError, CheckPreflightError, type CheckGateways, type CheckRunners, type RunCheckOptions } from "./check-types.js";
import { currentEngineInfo, type EngineInfo } from "./engine.js";
import { runAdversarialCliMission, runCoverageMission, runExploration, runFeatureCliMission } from "./explore-api.js";
import { doneCheckPolicyOf } from "./journey-done-check-hook.js";
import { runJourneyProgrammatically } from "./journey-api.js";
import { brittleStepGate, testIdAttributesOf, testIdAttributesOrDefault } from "./locator-health-api.js";
import { findProjectDir } from "./project-dir.js";
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
  readonly executed: Array<{ item: Planned; ex: Executed | undefined; durationMs: number }>;
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
  const executed: Array<{ item: Planned; ex: Executed | undefined; durationMs: number }> = [];
  return { testIdAttributes, doneCheckPolicy, meter, usage, ctx, now, exceeded, executed };
}
