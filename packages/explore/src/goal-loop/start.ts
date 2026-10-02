/**
 * The start of a goal-loop run (#128, #158, #213, #230, #293): instrument the page, load the start
 * URL (an unreachable seed ends the run `inconclusive` — the sentinel unwinds the loop), record the
 * first navigation and arm a read-only run's guard. Moved out of `explore.ts` unchanged (#232).
 */

import { Navigate } from "@jevitate/screenplay";
import {
  assertSeedReachable,
  describeUnreachable,
  isUnreachableTarget,
  targetStoppedAnswering,
} from "../mission-failure.js";
import { monitorFor } from "../page-monitor.js";
import { NO_DESTRUCTIVE_NOTE, READ_ONLY_NOTE } from "../read-only.js";
import type { RunContext } from "./context.js";
import { FirstNavigationFailedSentinel, firstLine } from "./helpers.js";

export async function openRun(ctx: RunContext): Promise<void> {
  const { cfg } = ctx;
  // The page monitor observes network + DOM from BEFORE the first navigation (the settle rule).
  await monitorFor(ctx.page).instrument();
  await ctx.deltas?.enable();
  ctx.effectLog.attach(monitorFor(ctx.page));
  // Initial navigation (authorized above).
  ctx.page.on("requestfailed", ctx.onFirstNavRequestFailed);
  try {
    // #293: an anchored run starts on the live page its Journey prefix left — never a fresh load.
    if (cfg.startInPlace !== true) {
      await assertSeedReachable(cfg.actor, cfg.startUrl);
      await Navigate.to(cfg.startUrl).performAs(cfg.actor);
    }
  } catch (e) {
    const message = firstLine(e);
    if (!isUnreachableTarget(message) && !isUnreachableTarget(ctx.firstNavNetError ?? "")) throw e;
    // The seed itself could not be loaded: never a defect in the app, never a bug in jevitate —
    // a configuration problem (a bad URL, the target not running). `inconclusive`, not `crashed`;
    // no crash report is built for it, so no issue is ever drafted from it.
    ctx.firstNavFailed = true;
    ctx.stop = "inconclusive";
    const cause = describeUnreachable(message, ctx.firstNavNetError);
    ctx.failure = { kind: "target-unreachable", message: `target unreachable (${cause})` };
    // #213: a bare load TIMEOUT (no network error) on a starved host is the host, not the target —
    // unless a fresh request for the page gets no response at all either (#230: the app is down).
    if (cause === "timed out before any response" && cfg.hostHealth !== undefined) {
      const judged = await cfg.hostHealth.judge();
      if (judged.starved !== null && (await targetStoppedAnswering({ pageUrl: cfg.startUrl }).catch(() => null)) === null) {
        const detail = `the start page did not load in time (${cause})`;
        cfg.hostHealth.markDegraded({ finding: "page-load-timeout", detail, step: 0 }, judged.starved);
        ctx.failure = {
          kind: "degraded-environment",
          message: `environment-degraded page load (${detail}) while the host was starved: ${judged.starved} — not an app or access finding`,
        };
      }
    }
  } finally {
    ctx.page.off("requestfailed", ctx.onFirstNavRequestFailed);
  }
  if (ctx.firstNavFailed) throw new FirstNavigationFailedSentinel();
  ctx.recorder.navigate(cfg.startUrl, ctx.now());
  // #158 — from here on, a read-only run's write requests never leave the browser.
  if (ctx.readOnly !== null) {
    await ctx.readOnly.arm(ctx.page);
    if (ctx.readOnly.mode === "read-only") {
      ctx.effectLog.markBackground();
      ctx.history.push(READ_ONLY_NOTE);
    } else ctx.history.push(NO_DESTRUCTIVE_NOTE);
  }
}
