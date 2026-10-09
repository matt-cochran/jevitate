/**
 * The gate every target op passes before it acts (#116, #150, #158, #245, #303): the refusals that
 * never touch the page (budget, read-only, safety policy) and the opening of the action's window.
 * Moved out of `explore.ts` unchanged (#232).
 */

import { descriptorToLocator } from "@jevitate/recorder";
import { hangRoute } from "../hang.js";
import { readFormText } from "../status.js";
import type { Control } from "../snapshot.js";
import type { RunContext } from "./context.js";
import { keyOf } from "./helpers.js";
import type { Flow, Step } from "./step.js";

export async function beginAction(ctx: RunContext, step: Step, control: Control): Promise<number | "stop"> {
  const { cfg } = ctx;
  const { snap, decision, record } = step;
  // #245: the demo overlay says what is about to happen and highlights the target (display only) —
  // before the action's attribution window opens, so its brief pause never counts as the action's.
  if (ctx.overlay !== null) {
    await ctx.overlay.announce(
      ctx.page,
      { step: ctx.transcript.nextStep, strategy: "goal", op: decision.op, target: control.name || control.summary, why: ctx.overlayWhy },
      control,
    );
  }

  // #303: the page right before the action (and, with the perception's capture, the route's
  // volatility baseline) — the action's delta is read at the next perception.
  if (ctx.deltas !== null) await ctx.deltas.beforeAction(hangRoute(snap.url), decision.op, control).catch(() => ctx.deltas!.discard());
  // #446: the target's form text right before the action — what newly shows there after it is the
  // form's message (an inline validation error the page shows without role=alert).
  {
    const lines = await readFormText(descriptorToLocator(ctx.page, control.descriptor).first());
    ctx.formBefore = lines === null ? null : { control, lines };
  }
  const at = ctx.now();
  const risk = ctx.safety.riskOf(control);
  ctx.effectLog.mark(ctx.transcript.nextStep, control.name || control.summary, risk);
  cfg.onAction?.({ step: ctx.transcript.nextStep, at });
  ctx.readOnly?.beginAction();

  // #150 — mission spend budget, pre-action: a paid control (#116) whose declared cost estimate
  // would cross what remains of the budget is refused BEFORE it fires — code decides, never the
  // model. The refusal is recorded and the run stops cleanly with `stop: "budget"`.
  if (cfg.onBeforeAction !== undefined) {
    const guard = await cfg.onBeforeAction({ op: decision.op, control: control.name || control.summary, paid: risk === "paid" });
    if (guard.refuse) {
      ctx.history.push(guard.reason);
      record(false, guard.reason, { origin: "engine" });
      ctx.incomplete = guard.reason;
      ctx.stop = "budget";
      return "stop";
    }
  }
  return at;
}

/** The refusals before any interaction: the action budget, the read-only guard (#158), the safety policy (#116). */
export async function refuseAction(ctx: RunContext, step: Step, control: Control): Promise<Flow> {
  const { decision, record } = step;
  if (!ctx.tracker.mayAct()) {
    record(false, "action budget exhausted", { origin: "engine" });
    ctx.stop = "exhausted";
    return "stop";
  }
  // #158 — a read-only (find-out) goal: code refuses a control that would start a write flow,
  // submit a form, send a message or upload. Refused before any interaction, recorded, told.
  if (ctx.readOnly !== null) {
    const refusal = ctx.readOnly.refusal(decision.op, control);
    if (refusal !== null) {
      ctx.history.push(refusal.reason);
      record(false, refusal.reason, { origin: "engine", safety: refusal.safety });
      ctx.lastActedOp = decision.op;
      return "continue";
    }
  }
  // The shared safety policy (#116): a session-ending, destructive, paid or --deny'd control is
  // never clicked unless the goal itself asks for it (or --allow-destructive). Refused, recorded.
  if (decision.op === "click") {
    const unsafe = ctx.safety.refuses(control);
    if (unsafe !== null) {
      ctx.refusedKeys.add(keyOf(control));
      ctx.lastRefusal = unsafe.reason;
      ctx.history.push(unsafe.reason);
      record(false, unsafe.reason, { origin: "engine", safety: unsafe.refusal });
      ctx.lastActedOp = decision.op;
      return "continue";
    }
  }
  return "next";
}
