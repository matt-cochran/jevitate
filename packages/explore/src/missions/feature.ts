import { assertAuthorizedExploreTarget } from "../authorized-targets.js";
import { MissionSafety } from "../mission-safety.js";
import {
  InvariantDefectLog,
  finishDeclaredRun,
  InvariantMonitor,
} from "../declared-invariants.js";
import { BudgetMonitor } from "../budget.js";
import { demoOverlayFor, type DemoOverlay } from "../demo-overlay.js";
import {
  createFrontierRun,
  setupFrontierRun,
  runFrontierIteration,
  finishFrontierRun,
  handleFrontierError,
  type Declared,
  type FeatureMissionParams,
  type FeatureRunResult,
} from "./feature-frontier.js";

export type { FeatureCoverage, FeatureMissionParams, FeatureRunResult } from "./feature-frontier.js";

/**
 * runFeatureMission — a capability-scoped variant of proof-by-induction
 * (ticket #3's coverage algorithm), restricted to a `CapabilityScope`:
 *
 *  - it discovers UI paths dynamically (frontier expansion from a seed url +
 *    scope, never a pre-authored step list),
 *  - it exercises multiple valid routes through the named capability, using
 *    reset-and-replay to revisit branch points deterministically,
 *  - it stimulates in-scope form fields with VALID boundary values
 *    (`boundary-values.ts`), never adversarial ones and never a secret field,
 *  - a state whose url falls outside scope is recorded as a *boundary edge*
 *    and never expanded (guardrail #4), and
 *  - it emits one replayable `Recording` per distinct discovered path plus a
 *    scoped coverage summary.
 *
 * This mission is MODEL-FREE by design: it issues zero Jev/generation calls in
 * its loop (it is handed a seed url + scope, not a natural-language goal to
 * interpret), which trivially satisfies guardrail #5 ("the model never
 * self-certifies") — called out explicitly since every other mission does call
 * a model.
 *
 * DEVIATIONS from the plan (documented rulings — the plan was written against
 * an assumed ticket #1 surface that differs from the shipped one):
 *  - consumes the real `snapshot`/`act`/`resolveBounds`/`Control`/`Snapshot`
 *    (not the assumed `snapshotPage`/`executeAction`/`defaultBounds`);
 *  - builds Recordings with a local pure `extendRecording` (the shipped
 *    recorder is the stateful `RunRecorder` builder; there is no functional
 *    `recordStep(recording, ...)`), each leaf self-contained and replayable;
 *  - the real `Control` has no `value` field, so a typed form field does not
 *    change the state fingerprint — see the "known limitation" note below.
 */

export async function runFeatureMission(params: FeatureMissionParams): Promise<FeatureRunResult> {
  // Guardrail #1 — authorize BEFORE touching the page (fail-closed).
  assertAuthorizedExploreTarget(params.seedUrl, params.allowlist);
  const declared: Declared | null =
    params.invariants === undefined
      ? null
      : {
          monitor: new InvariantMonitor(params.invariants, {
            allowlist: params.allowlist,
            baseUrl: params.seedUrl,
            ...(params.secrets === undefined ? {} : { secrets: params.secrets }),
            ...(params.invariantAuthTokens === undefined ? {} : { authTokens: params.invariantAuthTokens }),
          }),
          log: new InvariantDefectLog(),
          lastRepro: null,
        };
  // The named capability is the mission's goal: a risky control whose verb it names ("buy a pack"
  // → "Buy pack 1") is what the operator asked to test; any other stays refused (#116).
  const safety = new MissionSafety(params.safety, { goal: params.scope.name });
  // #150 — the SAME invariants monitor reads a budget's declared observables (one probe schedule).
  const budgetDecls = params.invariants?.budget ?? [];
  const budget = declared === null || budgetDecls.length === 0 ? null : new BudgetMonitor(budgetDecls, declared.monitor);
  const overlay = demoOverlayFor(params.demoOverlay, params.secrets ?? []);
  const result = { ...(await runFeatureFrontier(params, declared, safety, budget, overlay)), ...safety.result() };
  await overlay?.finish(`jevitate · feature — ${result.outcome}`, result.outcome === "exhausted" || result.outcome === "cap" || result.outcome === "path-cap" || result.outcome === "budget");
  // #195: the shared end-of-run path — a never.response hit to the LAST action is never lost.
  if (declared !== null) await finishDeclaredRun(declared);
  return {
    ...result,
    ...(declared === null ? {} : { invariantDefects: declared.log.defects(), invariants: declared.monitor.report() }),
    ...(budget === null ? {} : { budget: budget.trajectory() }),
  };
}

async function runFeatureFrontier(
  params: FeatureMissionParams,
  declared: Declared | null,
  safety: MissionSafety,
  budget: BudgetMonitor | null,
  overlay: DemoOverlay | null = null,
): Promise<FeatureRunResult> {
  const run = createFrontierRun(params, declared, safety, budget, overlay);
  try {
    const setup = await setupFrontierRun(run);
    if (setup.kind === "return") return setup.result;
    let snap = setup.snap;
    while (!run.frontier.isExhausted()) {
      const step = await runFrontierIteration(run, snap);
      if (step.kind === "return") return step.result;
      snap = step.snap;
      if (step.kind === "break") break;
    }
    return finishFrontierRun(run, "exhausted");
  } catch (e) {
    return handleFrontierError(run, e);
  } finally {
    run.watchdog.stop();
    await run.sessions.closeOwned();
  }
}
