/**
 * A transition that hung or left the scope (#89, #193, #203, #230): an in-scope hang is recorded and
 * reproduced, then the run resets to a known state; a departure is recorded and never expanded. Moved
 * out of `runInductionFrontier` unchanged (#232). "continue" is the loop's former `continue`; a result
 * is the run's former `return`.
 */

import { redactUrl } from "@jevitate/ai-core";
import { isAuthorizedExploreTarget } from "../../authorized-targets.js";
import type { FrontierItem } from "../../coverage/frontier.js";
import { recordCoverageHang } from "../../hang-repro.js";
import { outOfScopeHangNote } from "../../hang.js";
import { monitorFor } from "../../page-monitor.js";
import { summarizeTimings } from "../../timing.js";
import type { InductionRunResult } from "../induction.js";
import type { FrontierState } from "./context.js";
import { joinReasons, withSeed } from "./helpers.js";
import type { Acted, Settled } from "./transition.js";

export async function handleHangOrDeparture(ctx: FrontierState, item: FrontierItem, acted: Acted, settled: Settled): Promise<"continue" | "next" | InductionRunResult> {
  const { params, safety } = ctx;
  const { liveControl, decidedOn, decidedOnTiming } = acted;
  const { newFingerprint, branch } = settled;
  // A hang: record it (reproduced from the path that led here), reset to a known state and keep
  // exploring the rest of the frontier. The hung state is never expanded. Only IN-SCOPE pages
  // are hang-checked (#193): a page reached only by a departure is outside the target, so —
  // like every other out-of-scope page — it is never judged; its hang signal is noted on the
  // departure below as advisory, never a finding, and never part of the mission outcome.
  const hang = ctx.seenHang.last;
  if (hang !== null && ctx.inScope(ctx.snap.url)) {
    ctx.transcript.record({
      op: item.op,
      control: liveControl,
      confidence: null,
      chosenBy: "strategy",
      strategy: ctx.strategyLabel,
      actOk: true,
      reason: `hang (${hang.kind}): ${hang.detail}`,
      snapshot: decidedOn,
      ...(decidedOnTiming === undefined ? {} : { timing: decidedOnTiming }),
    });
    ctx.watchdog.suspend(); // the reproduction is bounded on its own (fresh contexts, bounded replays)
    const recorded = await recordCoverageHang({
      hang,
      // The path starts at the seed (the frontier's reach navigates there first): prepend it.
      recording: withSeed(branch, params.seedUrl),
      steps: ctx.transcript.entries(),
      found: ctx.hangs,
      ...(params.safety === undefined ? {} : { safety: params.safety }),
      ...(params.openFreshSession === undefined ? {} : { openSession: params.openFreshSession }),
      ...(params.hangReplays === undefined ? {} : { attempts: params.hangReplays }),
      ...(params.hostHealth === undefined ? {} : { hostHealth: params.hostHealth }),
      // #230: an app that stopped answering ends the run target-unresponsive, never a hang finding.
      liveness: { pageUrl: ctx.sessions.page.url(), authorized: (u) => isAuthorizedExploreTarget(u, params.allowlist) },
      // Re-detected with the SAME perception bounds the mission used.
      perceive: {
        ...(params.renderWaitMs === undefined ? {} : { renderWaitMs: params.renderWaitMs }),
        ...(params.settle === undefined ? {} : { settleConfig: params.settle }),
      },
    });
    ctx.watchdog.kick("resetting after a hang");
    if (!(await ctx.guard(ctx.sessions.reset(hang)))) {
      return {
        outcome: "hang",
        // #203: the page that could not be reset from was hung on a starved host — not an app hang.
        ...(recorded === "degraded"
          ? { failure: { kind: "degraded-environment", message: `the page stopped responding (${hang.kind}) while the host was starved, and no fresh session could replace it` } }
          : {}),
        coverage: ctx.report(false),
        recordings: [...ctx.statePaths.values()],
        transcript: ctx.transcript.entries(),
        timing: summarizeTimings(ctx.timings),
        hangs: [...ctx.hangs.values()],
      };
    }
    await ctx.guard(monitorFor(ctx.sessions.page).instrument());
    safety.attach(monitorFor(ctx.sessions.page));
    ctx.currentFingerprint = ""; // the next item is reached afresh from the seed
    return "continue";
  }

  // Scope containment (#89, reusing #64's scope model): a transition that landed outside the
  // target is recorded (a departure) but never expanded — its controls are never enqueued, and
  // it is never judged, so the frontier stays prioritized on the in-scope target instead of
  // wandering into the rest of the app. The next frontier pop (necessarily sourced from an
  // in-scope state, since only those are ever enqueued) resets and replays back into scope.
  if (!ctx.inScope(ctx.snap.url)) {
    ctx.outOfScopeTransitions += 1;
    const landed = redactUrl(ctx.snap.url);
    ctx.departures.push({ fromFingerprint: ctx.currentFingerprint, url: landed, action: liveControl.name || item.op });
    ctx.transcript.record({
      op: item.op,
      control: liveControl,
      confidence: null,
      chosenBy: "strategy",
      strategy: ctx.strategyLabel,
      actOk: true,
      reason: joinReasons([
        `left the target scope (landed on ${landed}); not expanded`,
        hang === null ? undefined : outOfScopeHangNote(hang),
      ]),
      snapshot: decidedOn,
      ...(decidedOnTiming === undefined ? {} : { timing: decidedOnTiming }),
    });
    ctx.currentFingerprint = newFingerprint;
    ctx.departed = true;
    if (hang !== null) {
      // The page still looked hung: leave it for a fresh one when the mission can open one (the
      // next item's reach re-navigates to the seed either way). Never a finding, never a stop.
      await ctx.guard(ctx.sessions.reset(hang));
      await ctx.guard(monitorFor(ctx.sessions.page).instrument());
      safety.attach(monitorFor(ctx.sessions.page));
      ctx.currentFingerprint = "";
    }
    return "continue";
  }
  return "next";
}
