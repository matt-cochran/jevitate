/**
 * A transition that went through (#86, #150, #160, #303): the new state perceived, the action's delta,
 * the transition noted on the frontier, the path that reaches it, the declared invariants judged on it,
 * and the post-settle budget. Moved out of `runInductionFrontier` unchanged (#232); the budget stop's
 * result is the run's former `return`.
 */

import { controlIdentity, stateFingerprint } from "../../coverage/fingerprint.js";
import type { FrontierItem } from "../../coverage/frontier.js";
import { isNavControl } from "../../coverage/nav.js";
import { recordingStepCount } from "../../declared-invariants.js";
import { summarizeTimings } from "../../timing.js";
import type { InductionRunResult } from "../induction.js";
import type { FrontierState } from "./context.js";
import { extendPath, pathOf, withSeed } from "./helpers.js";
import type { Acted, Settled } from "./transition.js";

export async function settleTransition(ctx: FrontierState, item: FrontierItem, acted: Acted): Promise<Settled | InductionRunResult> {
  const { params, declared, budget, deltaLog } = ctx;
  const { liveControl, actedOn, decidedOn } = acted;
  let armed = acted.armed;
  ctx.frontier.markExercised(controlIdentity(liveControl));
  if (!isNavControl(liveControl, decidedOn.url)) ctx.nonNavActionsExercised += 1;
  else ctx.crossPageLinks.push(liveControl);

  ctx.snap = await ctx.guard(ctx.takeSnapshot());
  ctx.observe(ctx.snap);
  // #303 (opt-in): what the action changed — on its transcript step (recorded next).
  if (armed !== null && deltaLog !== null) {
    armed.acted({ label: `${item.op} ${liveControl.name}`.trim(), recordIndex: 0, step: ctx.transcript.nextStep });
    const d = await armed.perceived(pathOf(ctx.sessions.page.url())).catch(() => null);
    if (d !== null) {
      deltaLog.push({ delta: d.delta, action: d.delta.action });
      ctx.transcript.attachDelta(ctx.transcript.nextStep, d.delta);
    }
    armed = null;
  }
  const newFingerprint = stateFingerprint(ctx.snap);
  // #160: a toggle exercised once in each direction is dropped for the rest of the run instead
  // of oscillating forever (the same fix as the feature mission's frontier, which shares this
  // class).
  ctx.frontier.noteTransition(item.fromFingerprint, liveControl, newFingerprint);
  const branch = extendPath(item.pathPrefix, item.op, liveControl.descriptor, null, ctx.snap.url);
  ctx.transitionsExercised += 1;
  if (declared !== null && ctx.seenHang.last === null) {
    // Declared invariants (#86): judged on the settled state the action produced; the finding
    // replays this path from the seed (the frontier's reach navigates there first).
    const path = withSeed(branch, params.seedUrl);
    const checked = await ctx.guard(declared.monitor.after(ctx.sessions.actor, { op: item.op, control: liveControl.name, url: actedOn }));
    declared.lastRepro = { recordingStepIndex: recordingStepCount(path) - 1, recording: path };
    for (const v of checked.violations) declared.log.add(v, declared.lastRepro);
  }

  // #150 — post-settle: a crossed budget stops the mission cleanly, before its next action.
  if (budget !== null && ctx.seenHang.last === null) {
    const b = await ctx.guard(budget.afterSettle(ctx.sessions.page, ctx.transitionsExercised));
    if (b.crossed) {
      ctx.transcript.record({
        op: item.op,
        control: liveControl,
        confidence: null,
        chosenBy: "strategy",
        strategy: "budget",
        actOk: true,
        reason: b.reason ?? "mission budget crossed",
        snapshot: ctx.snap,
      });
      return {
        outcome: "budget",
        coverage: ctx.report(false),
        recordings: [...ctx.statePaths.values()],
        transcript: ctx.transcript.entries(),
        timing: summarizeTimings(ctx.timings),
        hangs: [...ctx.hangs.values()],
      };
    }
  }
  return { newFingerprint, branch };
}
