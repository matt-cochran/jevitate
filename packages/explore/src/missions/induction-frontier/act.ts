/**
 * Acting on a popped frontier item (#75, #116, #203, #213, #245, #303): its control re-resolved on the
 * live page, the safety gate, the act (a single timeout retried once), and a failed act recorded (and
 * an unactionable control blacklisted). Moved out of `runInductionFrontier` unchanged (#232).
 * "continue" is the loop's former `continue`.
 */

import type { ActResult } from "../../act.js";
import { ActionDeltas } from "../../action-delta.js";
import { controlIdentity } from "../../coverage/fingerprint.js";
import type { FrontierItem } from "../../coverage/frontier.js";
import { act } from "../../index.js";
import type { FrontierState } from "./context.js";
import { isTimeoutFailure, isUnactionableFailure, pathOf, resolveControl } from "./helpers.js";
import type { Acted } from "./transition.js";

export async function actOnItem(ctx: FrontierState, item: FrontierItem): Promise<"continue" | Acted> {
  const { declared, safety, overlay } = ctx;
  const liveControl = resolveControl(ctx.snap, item.control);
  if (liveControl === null) return "continue"; // control vanished between snapshots — dropped

  // The shared safety policy (#116): never clicked, never retried (blacklisted), recorded once.
  const unsafe = safety.gate(item.op, liveControl);
  if (unsafe !== null) {
    ctx.frontier.blacklist(controlIdentity(liveControl));
    if (unsafe.first) {
      ctx.transcript.record({
        op: null,
        control: liveControl,
        confidence: null,
        chosenBy: "strategy",
        strategy: "safety-policy",
        origin: "engine",
        actOk: false,
        reason: unsafe.reason,
        snapshot: ctx.snap,
      });
    }
    return "continue";
  }
  // #245: the demo overlay says what is about to happen and highlights the target (display only).
  if (overlay !== null) {
    await overlay.announce(
      ctx.sessions.page,
      {
        step: ctx.transcript.nextStep,
        strategy: "coverage",
        op: item.op,
        target: liveControl.name || liveControl.summary,
        why: "map every reachable state of the app",
      },
      liveControl,
    );
  }
  const actedOn = ctx.snap.url;
  ctx.watchdog.during(`acting on "${liveControl.name || item.op}"`);
  if (declared !== null) await ctx.guard(declared.monitor.before(ctx.sessions.actor));
  safety.mark(ctx.transcript.nextStep, item.op, liveControl);
  const actOnce = (): Promise<ActResult> =>
    ctx.guard(
      act(ctx.sessions.actor, {
        op: item.op,
        control: liveControl,
        value: item.op === "click" ? null : "",
      }),
    );
  // #303 (opt-in): the page right before the action.
  let armed: ActionDeltas | null = null;
  if (ctx.pageDeltas !== null) {
    const dl = await ctx.pageDeltas.on(ctx.sessions.page);
    const route = pathOf(ctx.sessions.page.url());
    await dl.perceived(route).catch(() => null);
    try {
      await dl.beforeAction(route, item.op, liveControl);
      armed = dl;
    } catch {
      dl.discard();
    }
  }
  let result = await actOnce();
  // #213: a single timeout on a working control (a slow moment on a loaded host) is retried once
  // before it counts as a failed action — one blip must not make the run inconclusive.
  if (!result.ok && isTimeoutFailure(result.reason)) result = await actOnce();
  ctx.actions += 1;
  ctx.frontier.recordAttempt();
  const decidedOn = ctx.snap;
  // Each perception's timing is reported once (a failed act re-uses the same snapshot).
  const decidedOnTiming = ctx.lastTiming;
  ctx.lastTiming = undefined;
  if (!result.ok) {
    ctx.failedActions += 1;
    if (isTimeoutFailure(result.reason)) ctx.timedOutActions += 1;
    // A control that failed with a timeout (or was refused as not actionable — a clipped/
    // offscreen skip link, an occluded target) is never re-chosen for the rest of the run
    // (#75): every OTHER state that re-offers the same control identity drops it at `push`.
    if (isUnactionableFailure(result.reason)) ctx.frontier.blacklist(controlIdentity(liveControl));
    ctx.transcript.record({
      op: item.op,
      control: liveControl,
      confidence: null,
      chosenBy: "strategy",
      strategy: ctx.strategyLabel,
      actOk: false,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      snapshot: decidedOn,
      ...(decidedOnTiming === undefined ? {} : { timing: decidedOnTiming }),
    });
    return "continue";
  }
  return { liveControl, actedOn, armed, result, decidedOn, decidedOnTiming };
}
