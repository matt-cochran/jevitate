import { type CheckResult, type RunCheckOptions } from "./check-types.js";
import { assembleCheckReport, consolidateCheckDefects, executeCheckItems, prepareCheckPlan, prepareCheckRun, resolveCheckEvidence, resolveCheckInputs } from "./check-api-phases.js";
export { affectedBy } from "./check-plan.js";
export { BudgetMeter } from "./check-budget.js";
export { type BudgetReport, CheckAiSetupError, CheckArgsError, type CheckFinding, type CheckGateways, type CheckItemReport, CheckPreflightError, type CheckResult, type CheckRunners, type ItemKind, type RunCheckOptions } from "./check-types.js";

/** `jevitate check` (the CI gate): resolve the suite, run every item, consolidate defects, report. */
export async function runCheck(opts: RunCheckOptions): Promise<CheckResult> {
  const inputs = resolveCheckInputs(opts);
  const items = await prepareCheckPlan(opts);
  const evidence = resolveCheckEvidence(opts);
  const preparation = await prepareCheckRun(opts, inputs, items, evidence.reuse);
  const exceeded = await executeCheckItems(items, preparation, evidence.reuse);
  const state = await consolidateCheckDefects(opts, inputs, preparation);
  return assembleCheckReport(opts, inputs, evidence, preparation, exceeded, state);
}
