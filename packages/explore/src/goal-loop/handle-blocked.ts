/**
 * `blocked` (#92, #237, #283): the model gives up — deferred into a bounded job wait while the app is
 * still working, refused while nothing was tried yet, else the run stops. The goal loop's blocked
 * handler, moved out of `explore.ts` unchanged (#232).
 */
import { monitorFor } from "../page-monitor.js";
import { awaitWrites } from "../side-effects.js";
import { readInProgressStatus } from "../status.js";
import type { RunContext } from "./context.js";
import { JOB_WAIT_SLICE_MS, MAX_EARLY_BLOCKED_REFUSALS, quote, waitOutJob } from "./helpers.js";
import type { Flow, Step } from "./step.js";

export async function handleBlocked(ctx: RunContext, step: Step): Promise<Flow> {
  const { modelControls, record } = step;
  // The page says work is under way (#92): "blocked" is premature while a job the page reports
  // is still running. Code defers it into a bounded job wait; past the budget it stands.
  const job = await readInProgressStatus(ctx.page);
  // #283: likewise while a write an earlier click fired is still in flight (the request IS the job).
  if (job === null && ctx.jobWaitedMs < ctx.jobWaitMs && ctx.sideEffects.inflight().length > 0) {
    const what = ctx.inflightWrites();
    const w = await awaitWrites(monitorFor(ctx.page), ctx.sideEffects, Math.min(ctx.jobWaitMs - ctx.jobWaitedMs, JOB_WAIT_SLICE_MS));
    ctx.jobWaitedMs = w.resolved ? 0 : ctx.jobWaitedMs + w.waitedMs;
    const note = `blocked deferred: ${what} (sent by an earlier click) is still in flight — the app is still working; waited ${(w.waitedMs / 1000).toFixed(1)}s (${
      w.resolved ? "it resolved" : `still in flight; ${Math.round(ctx.jobWaitedMs / 1000)}s of the ${Math.round(ctx.jobWaitMs / 1000)}s job-wait budget used`
    })`;
    ctx.history.push(note);
    record(true, note, { op: "wait" });
    ctx.idleSteps = 0;
    ctx.idleSince = null;
    ctx.quietWaits = 0;
    ctx.lastActedOp = "wait";
    ctx.statusAfter = "waiting";
    return "continue";
  }
  if (job !== null && ctx.jobWaitedMs < ctx.jobWaitMs) {
    const w = await waitOutJob(ctx.page, Math.min(ctx.jobWaitMs - ctx.jobWaitedMs, JOB_WAIT_SLICE_MS));
    ctx.jobWaitedMs = w.cleared ? 0 : ctx.jobWaitedMs + w.waitedMs;
    const note = `blocked deferred: the page shows ${job} — the app is still working; waited ${(w.waitedMs / 1000).toFixed(1)}s (${
      w.cleared ? "the status cleared" : `still in progress; ${Math.round(ctx.jobWaitedMs / 1000)}s of the ${Math.round(ctx.jobWaitMs / 1000)}s job-wait budget used`
    })`;
    ctx.history.push(note);
    record(true, note, { op: "wait" });
    ctx.idleSteps = 0;
    ctx.idleSince = null;
    ctx.quietWaits = 0;
    ctx.lastActedOp = "wait";
    ctx.statusAfter = "waiting";
    return "continue";
  }
  // #237: giving up before trying anything proves nothing about the app. Refused (and the model
  // told to explore) while the page offers controls; a model that insists ends `inconclusive`.
  const untried = modelControls.filter((c) => c.enabled);
  // A find-out goal that already made a grounded report attempt here searched the page (#207).
  if (ctx.actionAttempts === 0 && untried.length > 0 && ctx.reportRejections === 0) {
    ctx.earlyBlocked += 1;
    if (ctx.earlyBlocked <= MAX_EARLY_BLOCKED_REFUSALS) {
      const nav = [...untried.filter((c) => (c.landmark ?? null) !== null), ...untried.filter((c) => (c.landmark ?? null) === null)];
      const names = nav.slice(0, 6).map((c) => quote(c.name || c.summary, 40)).join(", ");
      const reason = `blocked refused: nothing was tried yet — ${untried.length} control(s) on this page are untried (e.g. ${names}); explore them (the navigation, settings, menus) before giving up`;
      ctx.history.push(reason);
      record(false, reason, { origin: "engine" });
      return "continue";
    }
    record(false, "model blocked before trying any action", { origin: "engine" });
    ctx.failure = {
      kind: "insufficient-coverage",
      message: `the model gave up before trying any of the page's ${untried.length} controls — too little exploration to conclude the goal cannot be done`,
    };
    ctx.stop = "inconclusive";
    return "stop";
  }
  record(true, "model blocked");
  // #235: a control the goal needed may have been refused — the reason says so, actionably.
  ctx.incomplete = `the model reported the goal cannot be advanced from this page${ctx.lastRefusal === null ? "" : ` (${ctx.lastRefusal})`}`;
  ctx.stop = "blocked";
  return "stop";
}
