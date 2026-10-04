/**
 * The checks on every settled page before the next decision (#1, #150, #174): the mid-run origin
 * guard, the observation / spend-budget hooks, the already-met success condition and the render
 * guard. Moved out of `explore.ts` unchanged (#232).
 */

import { isAuthorizedExploreTarget } from "../authorized-targets.js";
import type { RunContext } from "./context.js";
import type { Flow, Perceived } from "./step.js";
import { busyOverlay } from "../status.js";
import { JOB_WAIT_SLICE_MS, waitOutJob } from "./helpers.js";
import { clock } from "@jevitate/domain";

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
    // #379: no visible control while a busy/progress overlay is up (a fullscreen spinner, a
    // `role=status` "Preparing…" over or instead of every control) is a job in progress, not an
    // empty page: waited out within the job-wait budget (--job-wait-ms), then perceived again.
    // Past the budget with the overlay still up it is the #328 stuck status, never a fail-closed
    // `blocked` at the first look.
    const overlay = perception.hang === null ? await busyOverlay(ctx.page) : null;
    if (overlay !== null && ctx.overlayWaitedMs < ctx.jobWaitMs) {
      const w = await waitOutJob(ctx.page, Math.min(ctx.jobWaitMs - ctx.overlayWaitedMs, JOB_WAIT_SLICE_MS), async (p) => (await busyOverlay(p)) !== null);
      // The perception's own wait on the overlay counts toward the budget too.
      ctx.overlayWaitedMs += clock.now() - step.perceiveStartedAt;
      const note = `no visible control while the page shows ${overlay} — the app is still working; waited ${(w.waitedMs / 1000).toFixed(1)}s (${
        w.cleared ? "the overlay cleared" : `still in progress; ${Math.round(ctx.overlayWaitedMs / 1000)}s of the ${Math.round(ctx.jobWaitMs / 1000)}s job-wait budget used`
      })`;
      ctx.history.push(note);
      ctx.transcript.record({
        op: "wait",
        control: null,
        confidence: null,
        chosenBy: "strategy",
        strategy: "job-wait",
        actOk: true,
        reason: note,
        snapshot: snap,
        timing: perception.timing,
      });
      return "continue";
    }
    if (overlay !== null) {
      const reason = `stuck: the page still shows ${overlay} (no visible control) after ${Math.round(ctx.overlayWaitedMs / 1000)}s of waiting — past the ${Math.round(
        ctx.jobWaitMs / 1000,
      )}s job-wait budget (a status that never completes); raise --job-wait-ms if this job legitimately takes longer`;
      ctx.transcript.record({
        op: "wait",
        control: null,
        confidence: null,
        chosenBy: "strategy",
        strategy: "job-wait",
        actOk: false,
        reason,
        snapshot: snap,
        timing: perception.timing,
      });
      ctx.history.push(reason);
      ctx.incomplete = reason;
      ctx.stop = "no-progress";
      return "stop";
    }
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
  ctx.overlayWaitedMs = 0;
  return "next";
}
