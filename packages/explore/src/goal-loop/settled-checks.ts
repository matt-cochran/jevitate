/**
 * The checks on every settled page before the next decision (#1, #150, #174): the mid-run origin
 * guard, the observation / spend-budget hooks, the already-met success condition and the render
 * guard. Moved out of `explore.ts` unchanged (#232).
 */

import { isAuthorizedExploreTarget } from "../authorized-targets.js";
import type { RunContext } from "./context.js";
import type { Flow, Perceived } from "./step.js";

export async function checkSettled(ctx: RunContext, step: Perceived): Promise<Flow> {
  const { cfg } = ctx;
  const { perception, snap } = step;
  // #1 — mid-run origin guard (fail-closed): never act off an authorized origin.
  if (!isAuthorizedExploreTarget(snap.url, cfg.allowlist)) {
    ctx.stop = "blocked";
    return "stop";
  }

  // Additive observation hook (usability analysis). Advisory: awaited but its
  // result never gates the loop, bounds, or stop decision.
  await cfg.onSnapshot?.(snap);

  // #150 — mission spend budget, post-settle: UNLIKE onSnapshot above, this hook's result DOES
  // gate the loop. A crossed budget stops the run cleanly, before its next decision.
  if (cfg.onSettled !== undefined) {
    const budget = await cfg.onSettled(snap);
    if (budget.stop) {
      ctx.transcript.record({
        op: null,
        control: null,
        confidence: null,
        chosenBy: "strategy",
        strategy: "budget",
        actOk: false,
        reason: budget.reason,
        snapshot: snap,
        timing: perception.timing,
      });
      ctx.incomplete = budget.reason;
      ctx.stop = "budget";
      return "stop";
    }
  }

  // #174 — the success condition is already met (independent code): stop now, never act past it.
  if (cfg.successMetNow !== undefined) {
    const met = await cfg.successMetNow().catch(() => null);
    if (met !== null) {
      ctx.transcript.record({
        op: "done",
        control: null,
        confidence: null,
        chosenBy: "strategy",
        strategy: "success-held",
        actOk: true,
        reason: `goal already met — stopped before the next action: ${met}`,
        snapshot: snap,
        timing: perception.timing,
      });
      ctx.outcome = { status: "completed", verifiedBy: "success-condition" };
      ctx.stop = "done";
      return "stop";
    }
  }

  if (!perception.rendered) {
    ctx.transcript.record({
      op: "wait",
      control: null,
      confidence: null,
      chosenBy: "strategy",
      actOk: false,
      reason: `${perception.reason} (fail-closed)`,
      snapshot: snap,
      timing: perception.timing,
    });
    ctx.stop = "blocked";
    return "stop";
  }
  return "next";
}
