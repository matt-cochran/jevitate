/**
 * Returning to a queued item's state (#114, #293): reset to the seed and replay the item's recorded
 * prefix (`reachFrontierState`). A stale path drops the state; an unreachable seed ends the run. Moved
 * out of `runInductionFrontier` unchanged (#232). "continue" is the loop's former `continue`; a result
 * is the run's former `return`.
 */

import type { FrontierItem } from "../../coverage/frontier.js";
import { reachFrontierState } from "../../coverage/reach.js";
import type { InductionRunResult } from "../induction.js";
import type { FrontierState } from "./context.js";

export async function reachItem(ctx: FrontierState, item: FrontierItem): Promise<"continue" | "next" | InductionRunResult> {
  const { params } = ctx;
  ctx.watchdog.during(ctx.departed ? "returning to the seed after a departure" : "resetting to a queued state");
  const reached = await ctx.guard(
    reachFrontierState({
      actor: ctx.sessions.actor,
      seedUrl: params.seedUrl,
      ...(params.restartAtStart === undefined
        ? {}
        : {
            reachSeed: async (): Promise<boolean> => {
              ctx.restartSpend += params.restartCost ?? 0;
              return params.restartAtStart!(ctx.sessions.actor);
            },
          }),
      item,
      snapshotNow: ctx.takeSnapshot,
      homeUrl: params.seedUrl,
      currentUrl: () => ctx.sessions.page.url(),
      ...(params.reachTimeoutMs === undefined ? {} : { timeoutMs: params.reachTimeoutMs }),
    }),
  );
  if (!reached.ok) {
    if (reached.reason === "stale") {
      // Stale — dropped, never guessed at; so is every other item replaying the same path (#114).
      ctx.frontier.dropState(item.fromFingerprint);
      ctx.currentFingerprint = "";
      return "continue";
    }
    // The seed is gone (a lost session) or stopped answering: no queued item is reachable —
    // a typed stop, never an idle grind through every queued item's reset (#114).
    return ctx.ended("scope-unreachable", {
      kind: "target-unreachable",
      message: `could not return to the seed${ctx.departed ? " after a departure" : ""} (${reached.detail ?? reached.reason})`,
    });
  }
  ctx.snap = reached.snapshot;
  ctx.observe(ctx.snap);
  ctx.currentFingerprint = item.fromFingerprint;
  ctx.departed = false;
  return "next";
}
