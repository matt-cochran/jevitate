/**
 * `reload` (#92, #184): a navigation to the same page, recorded as such and counted as an action
 * — deferred while a write the run fired is still in flight. The goal loop's reload handler, moved
 * out of `explore.ts` unchanged (#232).
 */
import { act } from "../act.js";
import { monitorFor } from "../page-monitor.js";
import { awaitWrites } from "../side-effects.js";
import type { RunContext } from "./context.js";
import type { Flow, Step } from "./step.js";

export async function handleReload(ctx: RunContext, step: Step): Promise<Flow> {
  const { cfg } = ctx;
  const { snap, decision, record } = step;
  // A reload is a navigation to the same page: recorded as such (replay re-loads the page),
  // and it counts as an action. Returning to the state the page had is its point, never a stall.
  if (!ctx.tracker.mayAct()) {
    record(false, "action budget exhausted", { origin: "engine" });
    ctx.stop = "exhausted";
    return "stop";
  }
  // A write this run fired is still in flight (a job it started): reloading now abandons it and
  // invites a duplicate. Observe until it resolves instead (#92).
  if (ctx.sideEffects.inflight().length > 0) {
    const what = ctx.sideEffects
      .inflight()
      .map((w) => `${w.method} ${w.path}`)
      .join(", ");
    const w = await awaitWrites(monitorFor(ctx.page), ctx.sideEffects, ctx.replyCeilingMs);
    const note = `reload deferred: ${what} (sent by an earlier click) is still in flight — waited ${(w.waitedMs / 1000).toFixed(1)}s, ${
      w.resolved ? "it resolved" : "it is still in flight"
    }`;
    ctx.history.push(note);
    record(false, note, { origin: "engine" });
    ctx.lastActedOp = decision.op;
    return "continue";
  }
  const at = ctx.now();
  ctx.effectLog.mark(ctx.transcript.nextStep, "reload");
  cfg.onAction?.({ step: ctx.transcript.nextStep, at });
  ctx.readOnly?.beginAction();
  const r = await act(cfg.actor, { op: "reload", control: null });
  if (r.ok) {
    ctx.recorder.navigate(ctx.page.url(), at);
    ctx.track.lastMutation = { at, before: snap.signature, seenBefore: new Set(ctx.seen), label: "reload", recordIndex: ctx.recorder.stepCount - 1, sawNewState: false };
    ctx.refusedSinceMutation = 0;
    ctx.scrollsSinceMutation = 0;
    ctx.track.lastRecordedTarget = null;
    ctx.tracker.countAction();
    ctx.failedActs.succeeded();
    // A reload retries the last submit: retyping what it sent is a retry, not a repeat (#184).
    ctx.valueLog.reloaded();
    ctx.save.reset();
    ctx.history.push(r.note === undefined ? "reloaded the page" : `reloaded the page (${r.note})`);
  } else {
    ctx.history.push(`reload failed: ${r.reason ?? "?"}`);
  }
  record(r.ok, r.reason ?? r.note);
  ctx.lastActedOp = decision.op;
  return "continue";
}
